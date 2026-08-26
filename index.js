/**
 * spartan-chatbot — AWS Lambda handler for the Spartan Capital Group website
 * chat widget. Invoked through a Lambda Function URL (buffered, payload
 * format 2.0); there is no API Gateway in front of it.
 *
 *   POST /  { messages: [{role, content}, ...], sessionId?, handoffContext? }
 *        -> { reply, handoff, handoffFields, handoffContext, sessionId }
 *        -> { reply: null, live: true, ... }  when a rep has claimed the chat
 *
 *   POST /  { action: "poll", sessionId, after? }
 *        -> { messages: [{id, body, sentAt}], live, status, sessionId }
 *
 * The poll is the return path: a claimed conversation gets no bot reply, so the
 * rep's answers reach the widget only by being fetched. It shares this
 * function, this Function URL, and the token gate below; it never reaches
 * Claude.
 *
 * handoffContext round-trips the lead fields accumulated so far: this handler
 * strips SCG_LEAD from the reply it returns, so the blocks do not survive in
 * the transcript the widget echoes back. The widget sends the handoffContext it
 * last received, and gets an updated one every turn.
 *
 * Runtime: nodejs20.x   Region: us-east-1
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { shouldHandoff, detectHandoff, recoverContactFields } from "./intent.js";
import { maybeCreateLead } from "./leadHandoff.js";
import { resolveLiveMode, recordVisitorTurn, pollRepMessages } from "./conversation.js";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

// Origins allowed to call the Function URL from a browser.
const ALLOWED_ORIGINS = new Set([
  "https://www.spartancapital.us",
  "https://spartancapital.us",
  "http://localhost:3000", // local testing only
]);

// Request limits. The widget sends the whole transcript every turn, so cap it
// rather than forwarding an unbounded payload to the API.
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 4000;

const GENERIC_ERROR = "Sorry — something went wrong on our end. Please try again in a moment.";
const EMPTY_REPLY_FALLBACK =
  "Sorry, I wasn't able to answer that. Would you like me to have a funding specialist reach out?";

/**
 * Shared-token gate for the public Function URL.
 *
 * This is NOT strong security. The token ships to the browser inside the chat
 * widget's JavaScript, so it is visible to any determined user who opens
 * devtools or reads the page source, and it can be replayed from anywhere.
 * What it does buy: it stops casual/drive-by abuse and the bots that scrape a
 * bare Function URL out of page source and POST straight at it.
 *
 * The real protection is CloudFront in front of the Function URL with WAF
 * rate limiting; that is the follow-up when the S3/CloudFront migration
 * lands. This gate is the interim measure that makes reopening the URL
 * tolerable until then.
 */
const WIDGET_TOKEN_HEADER = "x-widget-token";

/**
 * True when the request may proceed.
 *
 * Fails OPEN when WIDGET_TOKEN is unset on the environment, so a missing env
 * var can't lock the widget out before the token has been configured. That
 * case is logged loudly rather than silently allowed.
 */
function widgetTokenAllows(event) {
  const expected = process.env.WIDGET_TOKEN;

  if (!expected) {
    console.warn(
      "spartan-chatbot: WIDGET_TOKEN is not set — widget token gate is DISABLED",
    );
    return true;
  }

  return getHeader(event, WIDGET_TOKEN_HEADER) === expected;
}

/** Thrown for anything the caller can fix; surfaces as a 400. */
class BadRequestError extends Error {}

let anthropic;

function getClient() {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Configuration failure, not a caller failure — 500, logged below.
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    anthropic = new Anthropic({
      apiKey,
      timeout: 25_000, // keep under the Lambda timeout (30s)
      maxRetries: 1,
    });
  }
  return anthropic;
}

export const handler = async (event) => {
  const origin = getHeader(event, "origin");
  const headers = corsHeaders(origin);
  const method = event?.requestContext?.http?.method ?? "POST";

  // CORS preflight.
  if (method === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (method !== "POST") {
    return json(405, headers, { error: "Method not allowed. Use POST." });
  }

  // Token gate. Deliberately after the OPTIONS branch above: browsers don't
  // send custom headers on a preflight, so requiring the token there would
  // break CORS for every legitimate request. Runs before anything expensive —
  // a rejected caller reaches neither Claude nor Salesforce.
  if (!widgetTokenAllows(event)) {
    console.warn("spartan-chatbot: rejected request with missing/invalid widget token");
    return json(401, headers, { error: "Unauthorized." });
  }

  let sessionId;

  try {
    const body = parseBody(event);

    // The poll is answered here and returns: no transcript, no Claude, no lead
    // logic. Checked before normalizeMessages, which a poll body would fail.
    if (body.action === POLL_ACTION) {
      return await handlePoll(body, headers);
    }

    sessionId = normalizeSessionId(body.sessionId);
    const messages = normalizeMessages(body.messages);
    const incomingContext = parseHandoffContext(body.handoffContext);
    // A lead this session already produced. Its presence means "do not insert
    // another one", however many later turns look like a handoff.
    const existingLeadId = parseContextLeadId(body.handoffContext);

    // Has a rep taken this conversation? Checked before Claude, because a
    // claimed conversation must not get a bot reply at all. Never throws: if
    // Salesforce is unreachable the bot answers as usual, which is the safe
    // direction — the alternative is a silent widget with nobody replying.
    const liveCheck = await resolveLiveMode({ sessionId, messages });

    if (liveCheck.live) {
      // The visitor's message was recorded by resolveLiveMode; the rep replies
      // in Salesforce. `reply: null` plus `live: true` tells the widget to
      // render nothing from the bot and keep the thread open.
      return json(200, headers, {
        reply: null,
        live: true,
        handoff: false,
        handoffFields: {},
        // Echoed back untouched so a later bot turn resumes with what was
        // already collected, the once-per-session lead guard included.
        handoffContext: {
          ...incomingContext,
          ...(existingLeadId && { leadId: existingLeadId }),
        },
        sessionId,
        ...(liveCheck.conversation && { conversationId: liveCheck.conversation.id }),
      });
    }

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Thinking tokens would eat into the 1024-token budget and add latency
      // to a live chat widget; a website Q&A turn doesn't need it.
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages, // full conversation history, every turn (the API is stateless)
    });

    if (response.stop_reason === "refusal") {
      console.warn("spartan-chatbot: model declined the request", {
        sessionId,
        stopDetails: response.stop_details,
      });
    }

    // The model tags each reply OK/DECLINE and, on a handoff turn, appends the
    // fields it gathered (see systemPrompt.js). Strip both before either can
    // reach a visitor; the status drives the gate, the block supplies values.
    const status = parseStatusTag(extractText(response));
    const lead = parseLeadBlock(status.text);
    const reply = lead.text || EMPTY_REPLY_FALLBACK;

    // Everything the conversation has reported, accumulated every turn — not
    // only on the turn a handoff fires — so the running set is always current
    // and always goes back to the caller. Built before the handoff decision
    // because the model-signalled path below is judged against it.
    const accumulated = accumulateLeadFields(messages, lead.fields, incomingContext);

    // Narrow gap-fill: contact details only, and only ones nothing else has
    // reported, so it merges UNDER both the context and this turn's block.
    // Amounts are never recovered this way (see recoverContactFields). Skipped
    // on a declined turn: a business Spartan can't fund is not one whose
    // contact details we harvest.
    if (!status.declined && (!accumulated.email || !accumulated.phone)) {
      const recovered = recoverContactFields(messages);
      const filled = {};
      for (const key of ["email", "phone"]) {
        // Anything already known always wins; this only fills a gap.
        if (!accumulated[key] && recovered[key]) filled[key] = recovered[key];
      }
      if (Object.keys(filled).length > 0) {
        mergeLeadFields(accumulated, filled);
        console.log("spartan-chatbot: recovered contact fields missing from SCG_LEAD", {
          sessionId,
          recovered: Object.keys(filled),
        });
      }
    }

    // The model's own signal that it finished collecting: it reported a block
    // on THIS turn and what we hold clears the minimum. This is the path that
    // rescues the qualified lead whose visitor closed with "thank you" or "no"
    // — words no phrase list will ever match. shouldHandoff applies decline
    // suppression ahead of it, so a declined business cannot come back this
    // way, and the minimum keeps a thin block from becoming a junk lead.
    const modelSignaledHandoff =
      Object.keys(lead.fields).length > 0 && meetsLeadMinimum(accumulated);

    // Does a fundable visitor want to proceed? Either the visitor asked, or the
    // model finished. Separate from whether we have enough to write a lead,
    // which the minimum gate below decides for both paths alike.
    const wantsHandoff = shouldHandoff({
      messages,
      reply,
      modelDeclined: status.declined,
      modelSignaledHandoff,
    });

    if (wantsHandoff && Object.keys(lead.fields).length === 0) {
      // Handed off without the model reporting anything this turn — a
      // prompt-tuning signal, logged even when the context or the fallback
      // rescues the fields.
      console.warn("spartan-chatbot: handoff with no SCG_LEAD fields", { sessionId });
    }

    if (modelSignaledHandoff && !detectHandoff(messages)) {
      // Worth seeing in CloudWatch: this is a lead the old visitor-phrase-only
      // rule would have dropped on the floor.
      console.log("spartan-chatbot: handoff signalled by the model, not the visitor", {
        sessionId,
        fields: Object.keys(accumulated),
      });
    }

    // A declined business yields no lead fields, however much the transcript
    // holds; the accumulation still round-trips so nothing is silently lost.
    const handoffFields = wantsHandoff ? { ...accumulated } : {};

    // The minimum gate. A handoff can fire on a turn where the conversation
    // hasn't yielded a name and a way to reach them yet — an early "talk to a
    // specialist", or a bare confirmation after the model already wrapped up.
    // Writing a lead then produces a placeholder record, so suppress the write
    // and let the bot keep collecting instead.
    let handoff = wantsHandoff;
    let handoffDeferred = false;
    if (wantsHandoff && !meetsLeadMinimum(accumulated)) {
      handoff = false;
      handoffDeferred = true;
      console.warn("spartan-chatbot: lead creation suppressed, minimum not met", {
        sessionId,
        have: Object.keys(accumulated),
        missing: missingForLeadMinimum(accumulated),
      });
    }

    if (handoff) {
      console.log("spartan-chatbot: handoff requested", {
        sessionId,
        fields: Object.keys(handoffFields),
      });
    } else if (status.declined) {
      console.log("spartan-chatbot: reply declined the business, handoff suppressed", {
        sessionId,
      });
    }

    // Deliver the lead. Runs only now that `reply` has both tags stripped and
    // the contact fallback has filled any gaps, so Salesforce sees the final
    // field set. maybeCreateLead is gated on handoff === true and swallows
    // every Salesforce failure, so this can neither create a lead for a
    // declined business nor cost the visitor their reply.
    // ONE lead per session.
    //
    // The handoff trigger fires per turn, and the model happily re-reports a
    // complete block on every wrap-up-ish turn after the first, so an unguarded
    // create inserts a fresh Lead on each of them. Salesforce will not stop it:
    // the insert sends allowSave=true, so duplicate rules permit the save and
    // the DUPLICATES_DETECTED fallback never runs.
    //
    // Primary guard is the leadId echoed back in handoffContext. The secondary
    // is an existing Conversation__c for this session, which only comes into
    // being on a handoff turn and so implies a lead already exists — that one
    // covers a client that drops the context, and the window where two turns
    // arrive before the context round-trips.
    // Three guards, in descending order of authority. Each is independently
    // sufficient; together they cover the ways the others can be unavailable.
    const memoryKeys = leadMemoryKeys(sessionId, accumulated);
    let leadId = existingLeadId;
    let guardedBy = existingLeadId ? "handoffContext" : null;

    if (!guardedBy && liveCheck.conversation) {
      guardedBy = "conversation";
    }

    if (!guardedBy) {
      const remembered = recallLead(memoryKeys);
      if (remembered) {
        leadId = remembered.leadId;
        guardedBy = `warm-memory(${remembered.key.slice(0, 2)})`;
      }
    }

    if (guardedBy) {
      if (wantsHandoff) {
        console.log("spartan-chatbot: lead already created for this session, not creating another", {
          sessionId,
          guard: guardedBy,
          leadId: leadId ?? "(unknown, conversation-guarded)",
        });
      }
    } else {
      ({ leadId } = await maybeCreateLead({ handoff, handoffFields, sessionId }));
      if (leadId) rememberLead(memoryKeys, leadId);
    }

    // Mirror the visitor's turn into Salesforce. The conversation is created on
    // the handoff turn, when a leadId first exists, and that turn backfills the
    // transcript so a rep sees the whole thread. Reuses the token the live-mode
    // check already obtained, so a synced turn costs one auth, not two. Never
    // throws — a failure here loses the transcript, never the reply.
    const { conversationId } = await recordVisitorTurn({
      sessionId,
      leadId,
      messages,
      // Written Outbound so a rep sees the bot's side of the exchange too.
      botReply: reply,
      conversation: liveCheck.conversation,
      deps: { ...(liveCheck.auth && { auth: liveCheck.auth }) },
    });

    return json(200, headers, {
      reply,
      handoff,
      handoffFields,
      // Always echoed back, handoff or not, so the next turn starts from
      // everything collected so far — and, once a lead exists, from the guard
      // that stops a second one being inserted.
      handoffContext: {
        ...accumulated,
        ...(leadId && { leadId }),
      },
      sessionId,
      ...(handoffDeferred && { handoffDeferred: true }),
      ...(leadId && { leadId }),
      ...(conversationId && { conversationId }),
    });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json(400, headers, { error: error.message, sessionId });
    }

    // Full error to CloudWatch; only a safe message to the browser.
    console.error("spartan-chatbot: unhandled error", {
      sessionId,
      name: error?.name,
      status: error?.status,
      message: error?.message,
      requestId: error?.request_id,
      stack: error?.stack,
    });

    return json(500, headers, { error: GENERIC_ERROR, sessionId });
  }
};

/**
 * The widget asking "has a rep said anything since <cursor>?".
 *
 * Unlike a chat turn, the sessionId is required rather than generated: a poll
 * for a session that does not exist is meaningless, and minting one would hand
 * the widget an eternally empty inbox instead of a diagnosable 400.
 *
 * pollRepMessages never throws, so the only failure that can reach the caller
 * from here is that 400. A Salesforce outage comes back as
 * `{ messages: [], live: false, error: true }` — a 200 the widget can simply
 * poll past, which matters when the page behind it is calling every few
 * seconds.
 */
const POLL_ACTION = "poll";

async function handlePoll(body, headers) {
  if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
    throw new BadRequestError('`sessionId` is required for { action: "poll" }.');
  }
  const sessionId = body.sessionId.trim().slice(0, 128);

  const after = typeof body.after === "string" ? body.after.slice(0, 64) : null;

  const result = await pollRepMessages({ sessionId, after });

  return json(200, headers, { ...result, sessionId });
}

function corsHeaders(origin) {
  const headers = {
    "Content-Type": "application/json",
    // Response varies per Origin — keep caches from serving one site's
    // CORS headers to another.
    Vary: "Origin",
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, x-widget-token";
    headers["Access-Control-Max-Age"] = "86400";
  }

  return headers;
}

function getHeader(event, name) {
  const headers = event?.headers ?? {};
  // Function URLs lower-case header keys, but don't depend on it.
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function parseBody(event) {
  const raw = event?.body;
  if (!raw) throw new BadRequestError("Request body is required.");

  const text = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequestError("Request body must be a JSON object.");
  }

  return parsed;
}

function normalizeSessionId(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim().slice(0, 128);
  }
  return randomUUID();
}

/**
 * Validate and clean the transcript into the exact shape the Messages API
 * wants: alternating-or-not user/assistant turns, first turn from the user,
 * last turn from the user (a trailing assistant turn would be a prefill,
 * which current models reject).
 */
function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError("`messages` must be a non-empty array.");
  }

  const cleaned = value.map((message, index) => {
    if (!message || typeof message !== "object") {
      throw new BadRequestError(`messages[${index}] must be an object.`);
    }
    const { role, content } = message;
    if (role !== "user" && role !== "assistant") {
      throw new BadRequestError(
        `messages[${index}].role must be "user" or "assistant".`,
      );
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new BadRequestError(
        `messages[${index}].content must be a non-empty string.`,
      );
    }
    return { role, content: content.trim().slice(0, MAX_CONTENT_CHARS) };
  });

  // Keep the most recent turns if the transcript is long.
  let trimmed = cleaned.slice(-MAX_MESSAGES);

  // Drop any leading assistant turns — the first message must be from the user.
  const firstUser = trimmed.findIndex((m) => m.role === "user");
  if (firstUser === -1) {
    throw new BadRequestError("`messages` must contain at least one user message.");
  }
  trimmed = trimmed.slice(firstUser);

  if (trimmed[trimmed.length - 1].role !== "user") {
    throw new BadRequestError("The last message in `messages` must be from the user.");
  }

  return trimmed;
}

function extractText(response) {
  return (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Pull the model's status tag off the reply. Tolerant of malformed variants
 * (missing brackets, stray spacing, lower case) because the tag must never
 * survive into text a visitor reads, even when the model formats it badly.
 */
const STATUS_TAG_RE = /\[{0,2}\s*SCG[_\s-]?STATUS\s*:?\s*([A-Za-z]*)\s*\]{0,2}/gi;

function parseStatusTag(text) {
  let declined = false;
  const stripped = text
    .replace(STATUS_TAG_RE, (_match, verdict) => {
      if (/^decl/i.test(verdict)) declined = true;
      return "";
    })
    .trim();
  return { text: stripped, declined };
}

/**
 * The keys the model is allowed to report in an SCG_LEAD block. Anything else
 * it emits is dropped rather than forwarded to Salesforce.
 */
const LEAD_FIELD_KEYS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "businessName",
  "monthlyRevenue",
  "timeInBusiness",
  "fundingAmount",
  "loanPurpose",
];

const MAX_LEAD_FIELD_CHARS = 255;

// Two passes: the first captures the JSON object, the second sweeps up any
// remnant (a bracket-less or JSON-less tag) so nothing tag-shaped survives
// into text a visitor reads.
const LEAD_BLOCK_RE = /\[{0,2}\s*SCG[_\s-]?LEAD\s*:?\s*(\{[^\n]*\})\s*\]{0,2}/i;
const LEAD_REMNANT_RE = /\[{0,2}\s*SCG[_\s-]?LEAD\b[^\n]*/gi;

/** Whitelist, coerce to trimmed strings, drop blanks. */
function sanitizeLeadFields(parsed) {
  const fields = {};

  for (const key of LEAD_FIELD_KEYS) {
    const value = parsed[key];

    if (Array.isArray(value)) {
      const items = value
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim().slice(0, MAX_LEAD_FIELD_CHARS));
      if (items.length) fields[key] = items;
      continue;
    }

    // The model occasionally reports a figure as a number rather than a string.
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string") continue;

    const trimmed = text.trim();
    if (trimmed) fields[key] = trimmed.slice(0, MAX_LEAD_FIELD_CHARS);
  }

  return fields;
}

/**
 * Pull the model-reported handoff fields off the reply. A missing or malformed
 * block yields no fields rather than an error — a broken block must never cost
 * the visitor their answer.
 */
function parseLeadBlock(text) {
  let fields = {};

  const match = LEAD_BLOCK_RE.exec(text);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fields = sanitizeLeadFields(parsed);
      }
    } catch {
      // Malformed JSON — strip it below and carry on with no fields.
    }
  }

  const stripped = text
    .replace(LEAD_BLOCK_RE, "")
    .replace(LEAD_REMNANT_RE, "")
    .trim();

  return { text: stripped, fields };
}

/**
 * Must mirror salesforce.js's LAST_NAME_FALLBACK. A lead whose only "name" is
 * that placeholder is exactly the empty record this gate exists to prevent, so
 * it must never satisfy the name requirement below.
 */
const LEAD_NAME_FALLBACK = "Chatbot Lead";

/**
 * Merge `incoming` into `target` in place. Later non-empty values fill gaps and
 * update; an absent or blank value never clobbers something already known, so
 * a later turn that reports less than an earlier one cannot erase it.
 */
function mergeLeadFields(target, incoming) {
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (Array.isArray(value)) {
      if (value.length) target[key] = value;
      continue;
    }
    if (typeof value === "string" && value.trim()) target[key] = value.trim();
  }
  return target;
}

/**
 * Re-derive everything the conversation has reported, not just this turn.
 *
 * The handoff decision and the SCG_LEAD data come from two different parties on
 * two different turns: intent.js decides from the visitor's words, the model
 * emits the block when *it* considers the handoff done. When those turns don't
 * line up, building the lead from the firing turn alone yields a partial or
 * empty record. So walk the whole transcript oldest-first, merging every block
 * found, and let this turn's block win last.
 *
 * The Lambda is stateless per request, which is why this re-derives from the
 * incoming history rather than keeping state: the widget sends the full
 * transcript every turn.
 *
 * Three sources, in ascending precedence: the handoffContext the caller echoed
 * back from prior turns, any SCG_LEAD blocks still present in the transcript's
 * assistant turns, and this turn's block. The history scan finds nothing when
 * the caller echoes the stripped replies this handler returns — which is why
 * handoffContext exists — but it costs nothing and is correct for any client
 * that does preserve raw assistant text.
 */
function accumulateLeadFields(messages, currentFields, contextFields) {
  // Fields carried in from prior turns are the base; anything reported since
  // merges on top of them.
  const accumulated = mergeLeadFields({}, contextFields);

  for (const message of messages ?? []) {
    if (message?.role !== "assistant" || typeof message.content !== "string") continue;
    mergeLeadFields(accumulated, parseLeadBlock(message.content).fields);
  }

  // This turn's block is the freshest report, so it merges last and wins.
  return mergeLeadFields(accumulated, currentFields);
}

/**
 * Warm-container record of leads already created, the third and last
 * once-per-session guard.
 *
 * The other two both depend on something outside this Lambda: the primary needs
 * the caller to echo handoffContext back, the secondary needs Conversation__c to
 * exist in Salesforce. This one needs nothing, so it works the moment it
 * deploys — at the cost of being best-effort, since a cold container starts
 * empty and concurrent containers do not share it.
 *
 * Keyed by session AND by contact details on purpose. A session key alone is
 * useless against a caller that mints a fresh sessionId per turn, which is
 * exactly what the current widget does, so the email/phone fingerprint is what
 * actually stops the duplicates today. Two different people sharing an email or
 * phone inside one warm container would collapse to one lead, which is the
 * right answer anyway.
 *
 * Bounded, because a long-lived container would otherwise grow this forever.
 * Insertion-ordered Map, so eviction is FIFO.
 */
const LEAD_MEMORY_MAX = 500;
const leadMemory = new Map();

/** Every key this turn's identity could be remembered under. */
function leadMemoryKeys(sessionId, fields = {}) {
  const keys = [];
  if (sessionId) keys.push(`s:${sessionId}`);

  const email = typeof fields.email === "string" ? fields.email.trim().toLowerCase() : "";
  if (email) keys.push(`e:${email}`);

  const digits = typeof fields.phone === "string" ? fields.phone.replace(/\D/g, "") : "";
  // Last ten digits, so "+1 (212) 555-0188" and "2125550188" agree.
  if (digits.length >= 10) keys.push(`p:${digits.slice(-10)}`);

  return keys;
}

function recallLead(keys) {
  for (const key of keys) {
    const leadId = leadMemory.get(key);
    if (leadId) return { leadId, key };
  }
  return null;
}

function rememberLead(keys, leadId) {
  for (const key of keys) {
    // Re-insert so recently used keys sit at the young end of the FIFO.
    leadMemory.delete(key);
    leadMemory.set(key, leadId);
  }
  while (leadMemory.size > LEAD_MEMORY_MAX) {
    leadMemory.delete(leadMemory.keys().next().value);
  }
}

/** Exported so tests can simulate a cold container. */
function clearLeadMemory() {
  leadMemory.clear();
}

/**
 * Salesforce Lead ids: the Lead key prefix plus 12 more characters, or the
 * 18-character case-safe form.
 */
const LEAD_ID_RE = /^00Q[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/**
 * The id of the Lead already created for this session, if the caller echoed one
 * back. This is the primary once-per-session guard.
 *
 * Deliberately kept OUT of the lead field set: it is a control flag, never a
 * value to write to Salesforce. Shape-validated because it arrives from the
 * browser — a caller can at worst suppress its own lead (it could equally just
 * not send the message), but it must never reach a write as a field value.
 */
function parseContextLeadId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value.leadId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return LEAD_ID_RE.test(trimmed) ? trimmed : null;
}

/**
 * The caller's echoed-back accumulation. This crosses the trust boundary — it
 * arrives in the request body — so it goes through the same whitelist as a
 * model-emitted block: known keys only, coerced to trimmed strings, length
 * capped. A caller can therefore restate its own details (which it could
 * already do by typing them) but cannot introduce fields Salesforce never
 * agreed to receive. Anything absent or malformed is simply no context.
 */
function parseHandoffContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return sanitizeLeadFields(value);
}

const LEAD_MINIMUM_CONTACT_KEYS = ["email", "phone"];

function hasRealName(fields) {
  return ["firstName", "lastName"].some((key) => {
    const value = fields[key];
    return typeof value === "string" && value.trim() && value.trim() !== LEAD_NAME_FALLBACK;
  });
}

function hasContact(fields) {
  return LEAD_MINIMUM_CONTACT_KEYS.some(
    (key) => typeof fields[key] === "string" && fields[key].trim(),
  );
}

/**
 * The floor for writing a lead: a real name plus at least one way to reach
 * them. Below this, Salesforce would store a placeholder record ("Chatbot
 * Lead" / "Unknown (Chatbot Lead)") that nobody can action — worse than no
 * record, because it looks like a lead.
 */
function meetsLeadMinimum(fields) {
  return hasRealName(fields) && hasContact(fields);
}

/** What the minimum is missing, for the suppression log. */
function missingForLeadMinimum(fields) {
  const missing = [];
  if (!hasRealName(fields)) missing.push("name");
  if (!hasContact(fields)) missing.push("email-or-phone");
  return missing;
}

function json(statusCode, headers, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

// Exported for tests only; the Lambda entry point is `handler`.
export {
  parseStatusTag,
  parseLeadBlock,
  parseHandoffContext,
  parseContextLeadId,
  leadMemoryKeys,
  clearLeadMemory,
  LEAD_MEMORY_MAX,
  mergeLeadFields,
  accumulateLeadFields,
  meetsLeadMinimum,
  missingForLeadMinimum,
};
