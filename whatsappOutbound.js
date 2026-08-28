/**
 * whatsappOutbound.js — the rep's side of the WhatsApp thread.
 *
 *   POST /whatsapp/send   { conversationId, text, waId? }
 *
 * A rep types a reply in Salesforce; Apex calls this; this sends it to the
 * customer's WhatsApp through Meta. It is the outbound mirror of the inbound
 * webhook, and the two share everything below the transport: the same Graph
 * credentials, the same send function, the same Conversation__c.
 *
 * THREE DECISIONS WORTH READING BEFORE CHANGING ANYTHING HERE.
 *
 * 1. THIS ENDPOINT DOES NOT WRITE Message__c. Salesforce does, after a success
 *    response. That is not a stylistic preference — it is forced by how rep
 *    messages are told apart from bot ones. conversation.js's poll separates
 *    them with `CreatedById != <integration user>`, so anything this Lambda
 *    writes is authored by the integration user and is, by definition, a BOT
 *    message. A rep reply written from here would be attributed to the bot and
 *    then filtered out of the very poll that exists to deliver rep replies. It
 *    also keeps Salesforce the sole writer of its own objects, avoids a
 *    double-write, and lets the rep's real User id own the record. The wamid is
 *    returned so Apex can store it and stay idempotent.
 *
 * 2. THE RECIPIENT IS DERIVED FROM THE CONVERSATION, NEVER FROM THE CALLER.
 *    `conversationId` is required and the wa_id comes off that record. A `waId`
 *    in the body is treated as an assertion to VERIFY, not an instruction to
 *    obey: a mismatch is refused. If the shared secret ever leaks, the worst an
 *    attacker can do is send text into conversations that already exist —
 *    rather than use Spartan's WhatsApp number as an open relay to any number
 *    on earth.
 *
 * 3. THE 24-HOUR WINDOW IS CHECKED BEFORE META IS CALLED. Meta only allows
 *    free-form text within 24 hours of the customer's last inbound; outside it,
 *    only an approved template. Rather than let the rep discover that through a
 *    cryptic Graph error, the window is checked against Last_Inbound_At__c and
 *    refused locally with a stable error code the panel can render. Template
 *    sending is v2 and deliberately absent.
 */

import {
  sendWhatsAppText,
  getHeader,
  secretEquals,
  isWhatsAppConfigured,
} from "./whatsapp.js";
import {
  getConversationById,
  authSession,
  isSalesforceConfigured,
} from "./whatsappConversation.js";
import { clock } from "./botBrain.js";

/** Matches /whatsapp/send — NOT /whatsapp, which is Meta's webhook. */
const SEND_PATH_RE = /\/whatsapp\/send\/?$/i;

/**
 * The shared secret Salesforce sends. Same pattern as the widget token, with
 * one deliberate difference: this one FAILS CLOSED.
 *
 * WIDGET_TOKEN fails open because an unset value would lock real visitors out
 * of the public website. Nobody is locked out here — the only caller is Apex,
 * and an unconfigured secret on an endpoint that spends money and messages
 * customers must mean "nobody", never "anybody".
 */
const SF_SECRET_HEADER = "x-sf-secret";

/** Meta's free-form messaging window: 24 hours from the last customer inbound. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** A rep message is a text message; bound it well under Meta's 4096 cap. */
const MAX_TEXT_CHARS = 4000;

/** Is this the rep-send endpoint? Checked before the webhook route. */
function isWhatsAppSendRequest(event) {
  const path = event?.requestContext?.http?.path ?? event?.rawPath ?? "";
  return typeof path === "string" && SEND_PATH_RE.test(path);
}

function json(statusCode, payload) {
  return {
    statusCode,
    // No CORS headers: the only caller is Apex, server to server. A browser has
    // no business reaching this endpoint, so it is not invited to.
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

/**
 * True when the caller presented the shared secret.
 *
 * Constant-time, and fails closed on an unset env var — see SF_SECRET_HEADER.
 */
function salesforceSecretAllows(event, logger = console) {
  const expected = process.env.SF_TO_LAMBDA_SECRET;

  if (!expected) {
    logger.error(
      "whatsapp-send: SF_TO_LAMBDA_SECRET is not set — rejecting every rep send. " +
      "Set it on the Lambda and in the Salesforce named credential / custom setting.",
    );
    return { ok: false, reason: "unconfigured" };
  }

  const presented = getHeader(event, SF_SECRET_HEADER);
  if (typeof presented !== "string" || !presented) {
    return { ok: false, reason: "missing-secret" };
  }
  if (!secretEquals(presented, expected)) {
    return { ok: false, reason: "bad-secret" };
  }
  return { ok: true };
}

function parseBody(event) {
  const raw = event?.body;
  if (!raw) return null;
  const text = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How long is left in the messaging window, from a Last_Inbound_At__c value.
 *
 * A null or unparseable stamp yields `known: false`. That is reported, not
 * treated as expiry: refusing to send because a legacy conversation has no
 * stamp would block legitimate replies, whereas attempting the send costs at
 * worst one Graph error that is surfaced to the rep verbatim.
 */
function windowState(lastInboundAt, now) {
  if (!lastInboundAt) return { known: false };

  const ms = Date.parse(lastInboundAt);
  if (Number.isNaN(ms)) return { known: false };

  const age = now - ms;
  return {
    known: true,
    open: age < WINDOW_MS,
    lastInboundAt,
    ageHours: Math.round((age / 3_600_000) * 10) / 10,
    expiresAt: new Date(ms + WINDOW_MS).toISOString(),
  };
}

/**
 * Handle POST /whatsapp/send.
 *
 * Every failure carries a stable machine-readable `error` code alongside an
 * HTTP status, so Apex can branch on either. Nothing is swallowed: a Meta
 * rejection comes back with Meta's own message and status so the rep sees why.
 *
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
async function handleWhatsAppSend(event, { logger = console, deps = {} } = {}) {
  const method = event?.requestContext?.http?.method ?? "POST";
  if (method !== "POST") {
    return json(405, { error: "method_not_allowed", message: "Use POST." });
  }

  // AUTH FIRST — before the body is parsed and before anything is read from
  // Salesforce, so an unauthenticated caller costs one string compare.
  const auth = salesforceSecretAllows(event, logger);
  if (!auth.ok) {
    logger.warn(`whatsapp-send: rejected (${auth.reason})`);
    return json(401, { error: "unauthorized" });
  }

  const body = parseBody(event);
  if (!body) {
    return json(400, { error: "bad_request", message: "Body must be a JSON object." });
  }

  const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  if (!conversationId) {
    return json(400, {
      error: "bad_request",
      message: "`conversationId` is required — the recipient is derived from it.",
    });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return json(400, { error: "bad_request", message: "`text` is required and must be non-empty." });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return json(400, {
      error: "text_too_long",
      message: `\`text\` must be ${MAX_TEXT_CHARS} characters or fewer.`,
      length: text.length,
      limit: MAX_TEXT_CHARS,
    });
  }

  if (!isSalesforceConfigured()) {
    logger.error("whatsapp-send: Salesforce is not configured; cannot resolve the conversation");
    return json(503, { error: "salesforce_unavailable" });
  }
  if (!isWhatsAppConfigured()) {
    logger.error("whatsapp-send: WhatsApp credentials are not configured");
    return json(503, { error: "whatsapp_unavailable" });
  }

  // ---- Resolve the conversation, and with it the recipient.
  let conversation;
  try {
    const session = authSession(deps);
    conversation = await (deps.getConversationById || getConversationById)(
      conversationId, session, logger,
    );
  } catch (error) {
    logger.error(
      `whatsapp-send: conversation lookup failed conversation=${conversationId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    return json(502, { error: "salesforce_error", message: "Could not read the conversation." });
  }

  if (!conversation) {
    return json(404, { error: "conversation_not_found", conversationId });
  }

  if (!conversation.waId) {
    // A web conversation, or a WhatsApp one predating the external id.
    return json(409, {
      error: "not_a_whatsapp_conversation",
      conversationId,
      channel: conversation.channel,
    });
  }

  // A waId in the body is an assertion to check, never the address to use.
  if (typeof body.waId === "string" && body.waId.trim()) {
    const asserted = body.waId.trim().replace(/^\+/, "");
    if (asserted !== String(conversation.waId).replace(/^\+/, "")) {
      logger.warn(
        `whatsapp-send: waId mismatch for conversation=${conversationId} — refusing. ` +
        "The recipient is always taken from the conversation record.",
      );
      return json(400, {
        error: "wa_id_mismatch",
        message: "`waId` does not match the conversation's Whatsapp_Wa_Id__c.",
        conversationId,
      });
    }
  }

  // ---- The 24-hour window, checked BEFORE Meta is called.
  const win = windowState(conversation.lastInboundAt, clock.now().getTime());

  if (win.known && !win.open) {
    logger.warn(
      `whatsapp-send: refused, outside the 24h window conversation=${conversationId} ` +
      `lastInbound=${win.lastInboundAt} age=${win.ageHours}h`,
    );
    return json(422, {
      error: "outside_24h_window",
      message:
        "WhatsApp only allows free-form replies within 24 hours of the customer's " +
        "last message. This thread is outside that window, so a reply needs an " +
        "approved template (not yet supported).",
      conversationId,
      lastInboundAt: win.lastInboundAt,
      hoursSinceLastInbound: win.ageHours,
      windowExpiredAt: win.expiresAt,
    });
  }

  // ---- Send.
  const sent = await sendWhatsAppText({ to: conversation.waId, body: text, logger, deps });

  if (!sent.ok) {
    // Surfaced, never swallowed: the rep is waiting and needs to know why.
    logger.error(
      `whatsapp-send: Meta rejected the send conversation=${conversationId}: ` +
      `${sent.error} (HTTP ${sent.status ?? "-"})`,
    );
    return json(502, {
      error: "meta_send_failed",
      message: sent.error,
      metaStatus: sent.status ?? null,
      conversationId,
    });
  }

  logger.log(
    `whatsapp-send: delivered conversation=${conversationId} wamid=${sent.ids[0] ?? "(none)"}`,
  );

  return json(200, {
    ok: true,
    conversationId,
    waId: conversation.waId,
    // Salesforce writes the Message__c; this is the id to record against it so
    // a retried call can be recognised as a duplicate. See the header note.
    wamid: sent.ids[0] ?? null,
    wamids: sent.ids,
    sent: sent.sent,
    // Reported so the panel can warn a rep that the thread is about to close.
    ...(win.known
      ? { windowOpen: true, windowExpiresAt: win.expiresAt, hoursSinceLastInbound: win.ageHours }
      : { windowOpen: null, windowUnknown: true }),
  });
}

export {
  isWhatsAppSendRequest,
  handleWhatsAppSend,
  windowState,
  salesforceSecretAllows,
  SF_SECRET_HEADER,
  WINDOW_MS,
  MAX_TEXT_CHARS,
};
