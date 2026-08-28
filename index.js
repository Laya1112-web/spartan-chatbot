/**
 * spartan-chatbot — AWS Lambda handler for the Spartan Capital Group website
 * chat widget. Invoked through a Lambda Function URL (buffered, payload
 * format 2.0); there is no API Gateway in front of it.
 *
 *   POST /  { messages: [{role, content}, ...], sessionId?, handoffContext? }
 *        -> { reply, handoff, handoffFields, handoffContext, sessionId,
 *             liveHandoff, businessHours }
 *        -> { reply: null, live: true, ... }    a rep has claimed the chat
 *        -> { reply: null, closed: true, ... }  the chat is over
 *
 *   POST /  { action: "poll", sessionId, after? }
 *        -> { messages: [{id, body, sentAt}], live, closed, status, sessionId }
 *
 *   POST /  { action: "close", sessionId }
 *        -> { closed, reply: null, live: false, status, sessionId }
 *
 *   GET  /whatsapp   Meta's webhook verification handshake
 *   POST /whatsapp   WhatsApp Cloud API message events
 *        -> the same bot, reached over WhatsApp instead of the widget. Routed
 *           out to whatsappWebhook.js before any of the widget machinery below.
 *
 * The poll is the return path: a claimed conversation gets no bot reply, so the
 * rep's answers reach the widget only by being fetched. It shares this
 * function, this Function URL, and the token gate below; it never reaches
 * Claude. `close` is the End Chat button, and is terminal — a closed
 * conversation gets no further bot replies and no further writes.
 *
 * The three live-mode states the widget has to render are Claimed (a rep is
 * answering), New (the bot is answering — including a conversation a rep handed
 * back), and Closed (nobody is; the thread is finished).
 *
 * Reps work Mon-Fri 9:00am-6:00pm Eastern. Outside that window the bot still
 * qualifies the visitor and still writes the Lead and the Conversation__c, but
 * it must not promise a live specialist: `liveHandoff` goes false and the reply
 * passes through the after-hours gate (see businessHours.js). A conversation a
 * rep has already claimed is exempt — it returns above, before the gate exists.
 *
 * handoffContext round-trips the lead fields accumulated so far: this handler
 * strips SCG_LEAD from the reply it returns, so the blocks do not survive in
 * the transcript the widget echoes back. The widget sends the handoffContext it
 * last received, and gets an updated one every turn.
 *
 * Runtime: nodejs20.x   Region: us-east-1
 */

import { randomUUID } from "node:crypto";

import {
  MODEL,
  MAX_TOKENS,
  MAX_MESSAGES,
  MAX_CONTENT_CHARS,
  EMPTY_REPLY_FALLBACK,
  clock,
  setClock,
  getClient,
  extractText,
  parseStatusTag,
  parseLeadBlock,
  parseHandoffContext,
  parseContextLeadId,
  mergeLeadFields,
  accumulateLeadFields,
  leadMemoryKeys,
  recallLead,
  rememberLead,
  clearLeadMemory,
  LEAD_MEMORY_MAX,
  meetsLeadMinimum,
  missingForLeadMinimum,
} from "./botBrain.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { shouldHandoff, detectHandoff, recoverContactFields } from "./intent.js";
import { maybeCreateLead } from "./leadHandoff.js";
import { resolveBusinessHours, enforceAfterHoursReply } from "./businessHours.js";
import {
  isWhatsAppRequest,
  isWhatsAppJob,
  handleWhatsAppRequest,
  runWhatsAppJob,
} from "./whatsappWebhook.js";
import {
  resolveLiveMode,
  recordVisitorTurn,
  pollRepMessages,
  closeConversation,
  STATUS_CLOSED,
} from "./conversation.js";

// Origins allowed to call the Function URL from a browser.
const ALLOWED_ORIGINS = new Set([
  "https://www.spartancapital.us",
  "https://spartancapital.us",
  "http://localhost:3000", // local testing only
]);

const GENERIC_ERROR = "Sorry — something went wrong on our end. Please try again in a moment.";

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

export const handler = async (event) => {
  // WHATSAPP, ROUTED FIRST.
  //
  // Deliberately ahead of the CORS headers, the method check and the widget
  // token gate below, all three of which are about a browser talking to the
  // chat widget. Meta is not a browser: it sends no Origin, it will never send
  // x-widget-token, and it needs GET to be answered (the verification
  // handshake). On that path the X-Hub-Signature-256 HMAC is the auth.
  //
  // See whatsappWebhook.js. Nothing below this block runs for a WhatsApp
  // request, and nothing in that module runs for a widget request.
  if (isWhatsAppJob(event)) {
    // The asynchronous second invocation: this is the slow half of a webhook
    // POST, doing the Claude and Salesforce work Meta was not made to wait for.
    return await runWhatsAppJob(event);
  }

  if (isWhatsAppRequest(event)) {
    try {
      return await handleWhatsAppRequest(event);
    } catch (error) {
      // A 200 even here, and on purpose. Meta retries anything else and
      // eventually DISABLES a webhook that keeps failing, which would take the
      // channel down until somebody noticed in the app dashboard. An
      // unexpected crash is a CloudWatch problem, not a reason to lose the
      // number.
      console.error("spartan-chatbot: unhandled error on the WhatsApp webhook", {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
      });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false }),
      };
    }
  }

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

    // Same for the End Chat button: a status write and nothing else. It carries
    // no transcript either, so it also has to precede normalizeMessages.
    if (body.action === CLOSE_ACTION) {
      return await handleClose(body, headers);
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

    // The visitor ended this chat. Terminal: no reply, and nothing recorded
    // against a finished transcript. Checked before `live` because a closed
    // conversation is over regardless of who held it last.
    if (liveCheck.closed) {
      return json(200, headers, {
        reply: null,
        closed: true,
        live: false,
        handoff: false,
        handoffFields: {},
        // Still echoed back: the widget may keep the closed thread on screen,
        // and the lead guard must survive if the visitor starts a new session
        // with this context in hand.
        handoffContext: {
          ...incomingContext,
          ...(existingLeadId && { leadId: existingLeadId }),
        },
        sessionId,
        ...(liveCheck.conversation && { conversationId: liveCheck.conversation.id }),
      });
    }

    if (liveCheck.live) {
      // The visitor's message was recorded by resolveLiveMode; the rep replies
      // in Salesforce. `reply: null` plus `live: true` tells the widget to
      // render nothing from the bot and keep the thread open.
      //
      // Deliberately AHEAD of the business-hours gate below, and deliberately
      // untouched by it. A chat that went live at 5:50pm is still live at 6:05
      // — the rep is sitting in it — and the gate has no business interrupting
      // a conversation a human already owns. The gate only ever affects a turn
      // the BOT is answering, which is to say a NEW handoff offer.
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

    // Is a rep actually available to take a handoff right now? Reps work
    // Mon–Fri 9:00am–6:00pm Eastern, so outside that window the bot must still
    // qualify and capture the lead but must not promise a live specialist.
    // Resolved before the Claude call because it changes the system prompt, and
    // AFTER the live-mode check above so a conversation a rep already holds is
    // never touched by it.
    const businessHours = resolveBusinessHours(clock.now());

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Thinking tokens would eat into the 1024-token budget and add latency
      // to a live chat widget; a website Q&A turn doesn't need it.
      thinking: { type: "disabled" },
      // The standing prompt plus this turn's availability note: the model's
      // handoff language has to differ at 11pm from what it says at 11am.
      system: buildSystemPrompt(businessHours),
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
    // `let`: the after-hours gate below may rewrite it.
    let reply = lead.text || EMPTY_REPLY_FALLBACK;

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

    // Whether a live specialist is actually being brought in on this turn. The
    // handoff itself is unconditional — the Lead and the Conversation__c are
    // written at 2am exactly as at 2pm — but the "a specialist is joining you"
    // half of it only holds while somebody is there to join. The widget uses
    // this to decide whether to show its live-chat affordances.
    //
    // Built from `handoff`, not `wantsHandoff`, so liveHandoff implies handoff:
    // a rep can only claim a Conversation__c that exists, and that record is
    // only created once a lead does. A turn where the visitor asked but the
    // minimum is not met yet is still the bot collecting, not a rep arriving.
    const liveHandoff = businessHours.open && handoff;

    // THE STRUCTURAL AFTER-HOURS GATE.
    //
    // systemPrompt.js already tells the model that reps are offline and what to
    // say instead, and that handles the ordinary case. This is what makes it a
    // guarantee rather than a hope: a prompt can be ignored, and "a specialist
    // is connecting now" at 11pm is a promise nothing can keep — the visitor
    // waits at an empty chat until morning. So any sentence claiming a live
    // human is removed here, and the true version (the hours, the details
    // saved, the application that does work right now) is appended in its
    // place.
    //
    // Placed before both the Salesforce write below and the response, so the
    // visitor and the rep's morning transcript read the same text. A declined
    // business is exempt from the append: no specialist and no application link
    // at any hour.
    if (!businessHours.open) {
      const gated = enforceAfterHoursReply(reply, {
        // `handoff`, again, and for a second reason: appending the application
        // link keys off the same moment. A visitor two questions into the
        // collection sequence should not have the link pushed at them, which is
        // the ordering the standing prompt already keeps.
        handoff,
        declined: status.declined,
      });
      if (gated.stripped.length > 0) {
        // Worth seeing in CloudWatch: the prompt did not hold, and the gate is
        // the only reason the visitor was not promised a specialist. Recurring
        // entries here are a prompt-tuning signal.
        console.warn("spartan-chatbot: after-hours live-specialist promise stripped", {
          sessionId,
          etHour: businessHours.hour,
          etWeekday: businessHours.weekday,
          stripped: gated.stripped,
        });
      }
      if (gated.changed) {
        console.log("spartan-chatbot: after-hours reply gate applied", {
          sessionId,
          etHour: businessHours.hour,
          etWeekday: businessHours.weekday,
          strippedSentences: gated.stripped.length,
          appendedNotice: gated.appended,
        });
      }
      reply = gated.reply;
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
      // True only when a rep can actually pick this up. `handoff` says a lead
      // was captured; `liveHandoff` says a human is joining.
      liveHandoff,
      businessHours: {
        open: businessHours.open,
        hours: businessHours.hours,
        timezone: businessHours.timezone,
      },
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

/**
 * The widget's End Chat button: mark the conversation Closed and stop.
 *
 * Mirrors handlePoll's contract deliberately. The sessionId is required rather
 * than minted, because closing a session nobody named is meaningless. And
 * closeConversation never throws, so a Salesforce outage comes back as a 200
 * carrying `closed: false, error: true` rather than a 500 — the visitor is on
 * their way out of the chat and must not be shown an error to leave.
 *
 * `reply: null` and `live: false` are included so the shape matches the chat
 * turn's closed response and the widget can take one branch for both.
 */
const CLOSE_ACTION = "close";

async function handleClose(body, headers) {
  if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
    throw new BadRequestError('`sessionId` is required for { action: "close" }.');
  }
  const sessionId = body.sessionId.trim().slice(0, 128);

  const result = await closeConversation({ sessionId });

  return json(200, headers, {
    closed: result.closed,
    reply: null,
    live: false,
    status: result.closed ? STATUS_CLOSED : null,
    sessionId,
    ...(result.conversationId && { conversationId: result.conversationId }),
    // Nothing existed to close: the conversation is only created at handoff, so
    // a visitor who never asked for a human hits this. Not an error.
    ...(result.notFound && { notFound: true }),
    ...(result.alreadyClosed && { alreadyClosed: true }),
    ...(result.error && { error: true }),
  });
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
  setClock,
};
