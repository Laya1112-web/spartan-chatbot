/**
 * whatsappWebhook.js — WhatsApp as a second front door onto the same bot.
 *
 *   GET  /whatsapp   Meta's one-time verification handshake (whatsapp.js)
 *   POST /whatsapp   signed message events -> the same AI turn the web chat runs
 *
 * WhatsApp is a TRANSPORT, not a second bot. The system prompt, the handoff
 * rules, the excluded-industry decline, the lead minimum, the after-hours gate
 * and the Salesforce objects are all the web path's, imported rather than
 * reimplemented. What differs is only how a turn arrives and how the reply
 * leaves, and that is what this file is.
 *
 * THREE THINGS THE WEB PATH GETS FOR FREE AND THIS ONE HAS TO SOLVE
 *
 * 1. The transcript. The widget posts the whole thread every turn; Meta posts
 *    one message. So the thread is re-read out of Message__c
 *    (fetchTranscript) and the new message appended, which is why a WhatsApp
 *    turn costs a SOQL the web turn does not.
 *
 * 2. The lead-field accumulation. The widget round-trips handoffContext; Meta
 *    round-trips nothing. Three sources stand in, in ascending precedence: a
 *    warm-container store keyed by wa_id, a scan of the transcript, and this
 *    turn's SCG_LEAD block. The primary is really the model itself — it is
 *    handed the whole thread and re-reports the block when it wraps up. The
 *    once-per-thread lead guard, by contrast, is DURABLE here and not
 *    best-effort: Conversation__c.Lead__c is read back on every inbound.
 *
 * 3. Returning 200 fast. Meta retries anything that is not a prompt 200 and
 *    eventually disables a webhook that keeps failing, and one turn here is a
 *    Claude call plus several Salesforce round-trips — seconds, not
 *    milliseconds. So the POST handler does only the fast, local work
 *    (signature, parse, dedupe), hands the messages to a second asynchronous
 *    invocation of this same Lambda, and returns 200 immediately. If that
 *    dispatch cannot happen — no IAM permission to self-invoke, SDK missing,
 *    WHATSAPP_ASYNC=false — it falls back to doing the work inline and STILL
 *    returns 200, because a slow 200 is recoverable and a 500 is not.
 *
 * THE 24-HOUR WINDOW — a known limitation, not solved here.
 *
 * Meta only allows free-form (non-template) messages within 24 hours of the
 * visitor's last inbound. The AI path is always inside it by construction: the
 * bot only ever speaks because the visitor just messaged. A REP replying later
 * from the Salesforce console is the case that can fall outside, and that is
 * the rep-panel step's problem to solve — with an approved template to reopen
 * the window. Last_Inbound_At__c is stamped on every inbound here precisely so
 * that panel can tell whether the window is still open.
 */

import { randomUUID } from "node:crypto";

import {
  MODEL,
  MAX_TOKENS,
  MAX_MESSAGES,
  MAX_CONTENT_CHARS,
  EMPTY_REPLY_FALLBACK,
  clock,
  getClient,
  extractText,
  parseStatusTag,
  parseLeadBlock,
  mergeLeadFields,
  accumulateLeadFields,
  leadMemoryKeys,
  recallLead,
  rememberLead,
  meetsLeadMinimum,
  missingForLeadMinimum,
} from "./botBrain.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { shouldHandoff, detectHandoff, recoverContactFields } from "./intent.js";
import { maybeCreateLead } from "./leadHandoff.js";
import { resolveBusinessHours, enforceAfterHoursReply } from "./businessHours.js";
import {
  verifyWebhook,
  rawBody,
  signatureAllows,
  parseInboundMessages,
  markMessageSeen,
  sendWhatsAppText,
  UNSUPPORTED_REPLY,
} from "./whatsapp.js";
import {
  ensureWhatsAppConversation,
  fetchTranscript,
  stampInbound,
  attachLead,
  recordWhatsAppMessage,
  authSession,
  isClaimed,
  isSalesforceConfigured,
  DIRECTION_INBOUND,
  DIRECTION_OUTBOUND,
} from "./whatsappConversation.js";

/** The envelope key that marks a self-invocation rather than an HTTP request. */
const JOB_KEY = "whatsappJob";

/** Messages carried in one async job. A bound, not an expected batch size. */
const MAX_JOB_MESSAGES = 20;

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

/**
 * Is this event the WhatsApp webhook rather than a chat-widget request?
 *
 * Matched on the path so both live behind the one Function URL. Meta is
 * configured with `<function-url>/whatsapp`, and index.js routes here BEFORE
 * the CORS headers and the widget-token gate: Meta is not a browser, sends no
 * Origin, and will never send x-widget-token. The signature IS the auth on this
 * path.
 */
function isWhatsAppRequest(event) {
  const path = event?.requestContext?.http?.path ?? event?.rawPath ?? "";
  return typeof path === "string" && /\/whatsapp\/?$/i.test(path);
}

/** Is this the asynchronous second invocation carrying work to do? */
function isWhatsAppJob(event) {
  return Boolean(event && typeof event === "object" && event[JOB_KEY]);
}

/**
 * The webhook endpoint.
 *
 * Returns a Function URL response for every path, including every failure: the
 * only 4xx this ever produces are the deliberate 403 on a bad signature or a
 * failed handshake, and a 405 for a verb Meta does not use.
 */
async function handleWhatsAppRequest(event, { logger = console } = {}) {
  const method = event?.requestContext?.http?.method ?? "POST";

  // Meta's activation handshake. No signature: there is no body to sign, and
  // the shared verify token is what authenticates it.
  if (method === "GET") {
    return verifyWebhook(event?.queryStringParameters ?? {}, logger);
  }

  if (method !== "POST") {
    return { statusCode: 405, headers: plain(), body: "Method not allowed" };
  }

  // STEP 1 — the signature, before anything else. The raw bytes as Meta sent
  // them, never a re-serialised parse (see rawBody).
  const raw = rawBody(event);
  const allowed = signatureAllows(event, raw, logger);
  if (!allowed.ok) {
    logger.warn(`whatsapp: rejected webhook POST (${allowed.reason})`);
    return { statusCode: 403, headers: plain(), body: "Forbidden" };
  }

  // STEP 2 — parse. A body we cannot read will not become readable on a retry,
  // so this is a 200: asking Meta to redeliver it forever helps nobody.
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch (error) {
    logger.error(`whatsapp: webhook body was not valid JSON: ${error?.message}`);
    return ok({ ignored: "unparseable" });
  }

  const parsed = parseInboundMessages(payload, logger);

  // STEP 3 — statuses. Delivery receipts are most of the traffic and are not
  // visitor turns. Acknowledged and dropped, so Meta never retries them.
  if (!parsed.messages.length) {
    if (parsed.statuses) {
      logger.log(`whatsapp: ignored ${parsed.statuses} status event(s)`);
    }
    return ok({ statuses: parsed.statuses, messages: 0 });
  }

  // STEP 4 — dedupe. A Meta retry carries the same wamid as the original, and
  // the claim is taken HERE, before the slow work is dispatched, because that
  // window is exactly when the retry arrives.
  const fresh = [];
  for (const message of parsed.messages) {
    if (markMessageSeen(message.wamid)) {
      fresh.push(message);
    } else {
      logger.log(`whatsapp: duplicate wamid=${message.wamid} already processed, skipping`);
    }
  }

  if (!fresh.length) return ok({ duplicates: parsed.messages.length });

  const batch = fresh.slice(0, MAX_JOB_MESSAGES);
  if (batch.length < fresh.length) {
    logger.error(
      `whatsapp: webhook carried ${fresh.length} messages; processing the first ` +
      `${batch.length} and DROPPING ${fresh.length - batch.length}`,
    );
  }

  // STEP 5 — hand the slow half off and answer Meta now.
  const dispatch = await dispatchAsync(batch, logger);

  if (dispatch.dispatched) {
    return ok({ accepted: batch.length, mode: "async" });
  }

  logger.warn(
    `whatsapp: async dispatch unavailable (${dispatch.reason}) — processing inline. ` +
    "Meta's 200 will be delayed by the Claude and Salesforce round-trips.",
  );

  const results = await processWhatsAppMessages(batch, { logger });
  return ok({ accepted: batch.length, mode: "inline", results });
}

function plain() {
  return { "Content-Type": "text/plain; charset=utf-8" };
}

/** Meta ignores the body; a JSON one keeps the CloudWatch access log readable. */
function ok(payload = {}) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, ...payload }),
  };
}

/* ------------------------------------------------------------------ *
 * Returning 200 fast: the self-invocation
 * ------------------------------------------------------------------ */

/**
 * The Lambda SDK, loaded during INIT rather than on the first webhook POST.
 *
 * This is deliberately started at module scope and NOT awaited here. Module
 * evaluation is Lambda's INIT phase, so the import — and the client
 * construction chained onto it — happen while the container is being built
 * instead of inside a request that Meta is timing. Measured before this change,
 * the first dispatch in a container cost ~2.8s, and it cost that on a WARM
 * container too: `lambdaClient` is per-container, so a container warmed by
 * anything that is not a dispatch (a verification GET, a widget chat turn) still
 * paid the full import on its first WhatsApp message.
 *
 * It stays an import() expression rather than a static `import ... from`
 * because @aws-sdk/client-lambda is supplied by the nodejs20.x runtime and is
 * NOT a dependency of this package: a static import would be evaluated in the
 * test suite too, where the package does not exist, and would fail at load with
 * ERR_MODULE_NOT_FOUND before a single test ran.
 *
 * Both outcomes are settled into a plain object, so this promise can never
 * reject and can never raise an unhandled rejection at INIT. A context without
 * the package resolves to `{ error }`, which dispatchAsync reports as an
 * unavailable dispatch — the same graceful degradation as before, just decided
 * earlier.
 *
 * Note what this does NOT fix: on a genuine cold start Meta waits for INIT plus
 * the handler either way, so the import's cost moves rather than disappears.
 * What it removes is the warm-but-never-dispatched case above.
 */
const lambdaSdk = import("@aws-sdk/client-lambda").then(
  (mod) => ({ client: new mod.LambdaClient({}), InvokeCommand: mod.InvokeCommand }),
  (error) => ({ error }),
);

/** Per-container cache, populated from the INIT-time promise on first use. */
let lambdaClient;

/**
 * Invoke this same Lambda again, asynchronously, with the messages to process.
 *
 * `InvocationType: 'Event'` returns as soon as the event is queued, so the
 * webhook's 200 costs one local API call rather than a Claude turn. The second
 * invocation lands on `runWhatsAppJob` below.
 *
 * A Function URL response is buffered, so work started and not awaited before
 * returning is frozen the moment the handler resolves — `void doWork()` would
 * silently lose the reply. A second invocation is the only way to actually be
 * asynchronous here.
 *
 * REQUIRES `lambda:InvokeFunction` on the function's own execution role. Until
 * that is attached this reports `dispatched: false` and the caller processes
 * inline, which is correct behaviour rather than an outage — the reply still
 * goes out, it just takes the 200 with it.
 *
 * @returns {Promise<{dispatched: boolean, reason?: string}>}
 */
async function dispatchAsync(messages, logger = console) {
  if (process.env.WHATSAPP_ASYNC === "false") {
    return { dispatched: false, reason: "disabled by WHATSAPP_ASYNC=false" };
  }

  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!functionName) {
    // Not running in Lambda (a test, a local script): nothing to self-invoke.
    return { dispatched: false, reason: "AWS_LAMBDA_FUNCTION_NAME is not set" };
  }

  try {
    if (!lambdaClient) {
      // Already resolved in every realistic case: the load was started at INIT
      // (see lambdaSdk above), so this await is a microtask, not a 2.8s import.
      const settled = await lambdaSdk;
      if (settled.error) {
        return {
          dispatched: false,
          reason: `@aws-sdk/client-lambda unavailable: ` +
            `${settled.error.message ?? settled.error}`,
        };
      }
      lambdaClient = settled;
    }

    const { client, InvokeCommand } = lambdaClient;
    const jobId = randomUUID();

    await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event", // fire-and-forget
      Payload: Buffer.from(JSON.stringify({ [JOB_KEY]: { jobId, messages } })),
    }));

    logger.log(
      `whatsapp: dispatched job=${jobId} messages=${messages.length} to ${functionName}`,
    );
    return { dispatched: true };
  } catch (error) {
    return {
      dispatched: false,
      reason: error && error.message ? error.message : String(error),
    };
  }
}

/**
 * The asynchronous half: the entry point for the self-invocation.
 *
 * Nobody reads this return value — an Event invocation discards it — so its
 * only job is to not throw, which would show up as a Lambda error metric and a
 * retry of the whole job by the async invocation's own retry policy.
 */
async function runWhatsAppJob(event, { logger = console } = {}) {
  const job = event?.[JOB_KEY] ?? {};
  const messages = Array.isArray(job.messages) ? job.messages : [];

  logger.log(`whatsapp: job=${job.jobId ?? "(none)"} processing ${messages.length} message(s)`);

  const results = await processWhatsAppMessages(messages, { logger });
  return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
}

/** Sequential on purpose: two messages from one visitor are one conversation. */
async function processWhatsAppMessages(messages, { logger = console } = {}) {
  const results = [];
  for (const message of messages) {
    try {
      results.push(await processWhatsAppMessage(message, { logger }));
    } catch (error) {
      // processWhatsAppMessage is written not to throw; this is the backstop
      // that keeps one bad message from abandoning the rest of the batch.
      logger.error(
        `whatsapp: message processing threw wa=${message?.waId} wamid=${message?.wamid}: ` +
        `${error && error.stack ? error.stack : error}`,
      );
      results.push({ waId: message?.waId, error: true });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * Lead-field accumulation across a WhatsApp thread
 * ------------------------------------------------------------------ */

/**
 * What the conversation has reported so far, keyed by wa_id.
 *
 * The web path round-trips this through the browser in handoffContext. Meta
 * round-trips nothing, so this warm-container store stands in — and, like
 * index.js's leadMemory, it is honestly best-effort: a cold start forgets and
 * concurrent containers do not share it.
 *
 * What makes that survivable is that this is not the primary mechanism. The
 * model is handed the whole thread from Salesforce on every turn and re-reports
 * its SCG_LEAD block when it wraps up, so a forgotten store costs nothing on
 * the turn that matters. And the guard against a DUPLICATE lead does not depend
 * on memory at all: Conversation__c.Lead__c is read back from Salesforce.
 */
const WA_CONTEXT_MAX = 500;
const waContext = new Map();

function recallContext(waId) {
  return waContext.get(waId) ?? {};
}

function rememberContext(waId, fields) {
  waContext.delete(waId);
  waContext.set(waId, { ...fields });
  while (waContext.size > WA_CONTEXT_MAX) {
    waContext.delete(waContext.keys().next().value);
  }
}

/** Exported so tests can simulate a cold container. */
function clearWhatsAppMemory() {
  waContext.clear();
}

/* ------------------------------------------------------------------ *
 * One inbound WhatsApp message, start to finish
 * ------------------------------------------------------------------ */

/**
 * Process a single inbound message.
 *
 * NEVER THROWS for anything recoverable, and the order of operations is chosen
 * so that each failure costs as little as possible:
 *
 *   - Salesforce unreachable  -> the bot still answers, with no history and
 *                                nothing recorded. Silence is the worse failure.
 *   - Claimed conversation    -> the message is recorded and the model is NOT
 *                                called. Identical to the web path's live mode.
 *   - Claude fails            -> nothing is sent; the inbound is already saved,
 *                                so a rep can pick the thread up.
 *   - Send fails              -> logged with Meta's error body; the transcript
 *                                keeps the reply either way.
 *
 * @returns {Promise<object>} a summary for the log; nothing consumes it.
 */
async function processWhatsAppMessage(message, { logger = console, deps = {} } = {}) {
  const { waId, wamid, text, profileName, timestamp, type } = message ?? {};
  if (!waId) return { skipped: "no-wa-id" };

  const at = timestamp || new Date().toISOString();
  const summary = { waId, wamid, type };

  // The WhatsApp profile name, logged and nothing else. It is deliberately NOT
  // written to Conversation__c — that object has no visitor-name field, the
  // name belongs to the Lead, and the bot collects it there in the visitor's
  // own words. A WhatsApp display name is whatever someone set it to ("Mom",
  // an emoji, a business slogan) and is not a lead's legal name; promoting it
  // into the lead fields would let it satisfy the name half of the lead
  // minimum, which is exactly the placeholder record that gate exists to stop.
  if (profileName) {
    logger.log(`whatsapp: inbound from wa=${waId} profileName=${profileName}`);
  }

  const session = isSalesforceConfigured() ? authSession(deps) : null;
  if (!session) {
    logger.error(
      "whatsapp: Salesforce is not configured — answering without a transcript " +
      "and without recording anything",
    );
  }

  /* --- The conversation ------------------------------------------- */

  let conversation = null;
  if (session) {
    try {
      conversation = await ensureWhatsAppConversation({ waId, auth: session, logger });
      summary.conversationId = conversation.id;
      if (conversation.reopened) summary.reopened = true;
    } catch (error) {
      // Degrade to "answer anyway". The alternative is a visitor messaging a
      // number that has gone quiet.
      logger.error(
        `[whatsapp] conversation resolve failed wa=${waId}: ` +
        `${error && error.message ? error.message : error}`,
      );
    }
  }

  /* --- A message the bot cannot read ------------------------------ */

  // An image, a voice note, a location pin. Recorded so the rep sees that
  // something arrived, answered with a nudge, and never sent to the model.
  if (!text) {
    logger.log(`whatsapp: unsupported message type=${type} wa=${waId}`);
    if (conversation) {
      await recordWhatsAppMessage({
        conversationId: conversation.id,
        body: `[${type ?? "unsupported"} message received — not readable by the assistant]`,
        direction: DIRECTION_INBOUND,
        auth: session, logger, deps,
      });
      await stampInbound({ conversationId: conversation.id, at, auth: session, logger });
    }

    // A claimed thread gets no automatic nudge: a rep is answering, and
    // interjecting over them is exactly what live mode exists to prevent.
    if (conversation && isClaimed(conversation.status)) {
      return { ...summary, live: true, unsupported: true };
    }

    const sent = await sendWhatsAppText({ to: waId, body: UNSUPPORTED_REPLY, logger, deps });
    if (conversation) {
      await recordWhatsAppMessage({
        conversationId: conversation.id, body: UNSUPPORTED_REPLY,
        direction: DIRECTION_OUTBOUND, auth: session, logger, deps,
      });
    }
    return { ...summary, unsupported: true, sent: sent.ok };
  }

  /* --- Live mode: a rep owns this thread -------------------------- */

  if (conversation && isClaimed(conversation.status)) {
    // Recorded and nothing else. No model call, no reply — the rep answers in
    // Salesforce, exactly as on the web path.
    await recordWhatsAppMessage({
      conversationId: conversation.id, body: text,
      direction: DIRECTION_INBOUND, auth: session, logger, deps,
    });
    await stampInbound({ conversationId: conversation.id, at, auth: session, logger });
    logger.log(
      `whatsapp: conversation is claimed by a rep, bot staying silent wa=${waId} ` +
      `conversation=${conversation.id}`,
    );
    return { ...summary, live: true };
  }

  /* --- The thread so far ------------------------------------------ */

  // Read BEFORE the inbound is written, so this turn's message is appended
  // exactly once and cannot race its own Sent_At__c ordering.
  const history = conversation
    ? await fetchTranscript({ conversationId: conversation.id, auth: session, logger })
    : [];

  if (conversation) {
    await recordWhatsAppMessage({
      conversationId: conversation.id, body: text,
      direction: DIRECTION_INBOUND, auth: session, logger, deps,
    });
    await stampInbound({ conversationId: conversation.id, at, auth: session, logger });
  }

  const messages = [
    ...history,
    { role: "user", content: String(text).slice(0, MAX_CONTENT_CHARS) },
  ].slice(-MAX_MESSAGES);

  /* --- The AI turn ------------------------------------------------ */

  const businessHours = resolveBusinessHours(clock.now());

  let response;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      // Same prompt, framed for a texting medium: one-or-two-sentence replies,
      // no markdown, and no claim to be a website. Every compliance rule —
      // excluded industries, the numbers boundary, SCG_STATUS/SCG_LEAD — is
      // identical to the web path's. See systemPrompt.js WHATSAPP_EDITS.
      system: buildSystemPrompt({ ...businessHours, channel: "whatsapp" }),
      messages,
    });
  } catch (error) {
    // The inbound is saved and Meta has its 200. Nothing is sent: a generic
    // apology in a WhatsApp thread is worse than a rep picking it up.
    logger.error(
      `whatsapp: Claude call failed wa=${waId}: ${error && error.message ? error.message : error}`,
    );
    return { ...summary, error: "model" };
  }

  if (response.stop_reason === "refusal") {
    logger.warn("whatsapp: model declined the request", {
      waId,
      stopDetails: response.stop_details,
    });
  }

  const status = parseStatusTag(extractText(response));
  const lead = parseLeadBlock(status.text);
  let reply = lead.text || EMPTY_REPLY_FALLBACK;

  /* --- Lead fields ------------------------------------------------ */

  const accumulated = accumulateLeadFields(messages, lead.fields, recallContext(waId));

  // The visitor's phone number is a fact WhatsApp hands us for free — it IS the
  // wa_id — so it never has to be collected. Merged UNDER anything the
  // conversation reported: a visitor who gives a different callback number
  // outranks the number they happen to be messaging from.
  if (!accumulated.phone) {
    mergeLeadFields(accumulated, { phone: `+${String(waId).replace(/\D/g, "")}` });
  }

  // Narrow gap-fill, same rule as the web path: contact details only, only
  // where nothing else reported one, and never on a declined turn.
  if (!status.declined && !accumulated.email) {
    const recovered = recoverContactFields(messages);
    if (recovered.email) {
      mergeLeadFields(accumulated, { email: recovered.email });
      logger.log(`whatsapp: recovered email missing from SCG_LEAD wa=${waId}`);
    }
  }

  rememberContext(waId, accumulated);

  const modelSignaledHandoff =
    Object.keys(lead.fields).length > 0 && meetsLeadMinimum(accumulated);

  const wantsHandoff = shouldHandoff({
    messages,
    reply,
    modelDeclined: status.declined,
    modelSignaledHandoff,
  });

  if (modelSignaledHandoff && !detectHandoff(messages)) {
    logger.log("whatsapp: handoff signalled by the model, not the visitor", {
      waId,
      fields: Object.keys(accumulated),
    });
  }

  const handoffFields = wantsHandoff ? { ...accumulated } : {};

  // The minimum gate. Below a real name plus a way to reach them, Salesforce
  // would store a placeholder nobody can action, so the write is suppressed and
  // the bot keeps collecting. Note that the wa_id already satisfies the contact
  // half, so in practice this gate is waiting on a name.
  let handoff = wantsHandoff;
  if (wantsHandoff && !meetsLeadMinimum(accumulated)) {
    handoff = false;
    summary.handoffDeferred = true;
    logger.warn("whatsapp: lead creation suppressed, minimum not met", {
      waId,
      have: Object.keys(accumulated),
      missing: missingForLeadMinimum(accumulated),
    });
  }

  /* --- The after-hours gate --------------------------------------- */

  // Structural, and for the same reason as on the web: "a specialist is
  // connecting now" at 11pm is a promise nothing can keep. Applied before the
  // send AND before the Outbound write, so the visitor and the rep's morning
  // transcript read the same text.
  if (!businessHours.open) {
    const gated = enforceAfterHoursReply(reply, { handoff, declined: status.declined });
    if (gated.stripped.length > 0) {
      logger.warn("whatsapp: after-hours live-specialist promise stripped", {
        waId,
        etHour: businessHours.hour,
        etWeekday: businessHours.weekday,
        stripped: gated.stripped,
      });
    }
    reply = gated.reply;
  }

  /* --- The lead --------------------------------------------------- */

  // ONE lead per thread. The primary guard is Conversation__c.Lead__c, which is
  // durable — unlike the web path's, which needs the browser to echo a context
  // back. Note the web path's secondary guard ("a conversation exists, so a
  // lead must too") is NOT available here and must not be borrowed: on WhatsApp
  // the conversation is created on the FIRST inbound, long before any handoff.
  let leadId = conversation?.leadId ?? null;
  let guardedBy = leadId ? "conversation" : null;

  const memoryKeys = leadMemoryKeys(`wa:${waId}`, accumulated);
  if (!guardedBy) {
    const remembered = recallLead(memoryKeys);
    if (remembered) {
      leadId = remembered.leadId;
      guardedBy = `warm-memory(${remembered.key.slice(0, 2)})`;
    }
  }

  if (guardedBy) {
    if (wantsHandoff) {
      logger.log("whatsapp: lead already created for this thread, not creating another", {
        waId,
        guard: guardedBy,
        leadId,
      });
    }
  } else {
    ({ leadId } = await maybeCreateLead({ handoff, handoffFields, sessionId: `wa:${waId}` }));
    if (leadId) {
      rememberLead(memoryKeys, leadId);
      // Written back so the guard above holds on the next inbound whether or
      // not this container is still warm.
      if (conversation) {
        await attachLead({ conversationId: conversation.id, leadId, auth: session, logger });
      }
    }
  }

  if (leadId) summary.leadId = leadId;
  summary.handoff = handoff;
  summary.businessHoursOpen = businessHours.open;

  /* --- The reply -------------------------------------------------- */

  // Sent first, recorded second: the visitor is waiting, and both calls are
  // best-effort. A send failure is logged with Meta's own error body, and the
  // Outbound row is written regardless so the transcript stays complete.
  const sent = await sendWhatsAppText({ to: waId, body: reply, logger, deps });
  summary.sent = sent.ok;
  if (!sent.ok) {
    logger.error(
      `whatsapp: REPLY NOT DELIVERED wa=${waId} reason=${sent.error} — ` +
      `the reply is recorded in Salesforce but the visitor did not receive it`,
    );
  }

  if (conversation) {
    await recordWhatsAppMessage({
      conversationId: conversation.id, body: reply,
      direction: DIRECTION_OUTBOUND, auth: session, logger, deps,
    });
  }

  return summary;
}

export {
  isWhatsAppRequest,
  isWhatsAppJob,
  handleWhatsAppRequest,
  runWhatsAppJob,
  processWhatsAppMessage,
  processWhatsAppMessages,
  dispatchAsync,
  clearWhatsAppMemory,
  JOB_KEY,
  MAX_JOB_MESSAGES,
};
