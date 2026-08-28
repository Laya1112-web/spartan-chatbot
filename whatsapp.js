/**
 * whatsapp.js — the Meta WhatsApp Cloud API transport.
 *
 * Everything that talks to Meta, and nothing that talks to Salesforce or to
 * Claude. Split out for the same reason businessHours.js is: these are the
 * rules of somebody else's protocol, and they are worth testing without a
 * conversation, an org, or a model anywhere near them.
 *
 * Meta's half of the contract (Cloud API v23.0):
 *
 *   GET  /whatsapp   hub.mode=subscribe & hub.verify_token=<ours> &
 *                    hub.challenge=<nonce>. Echo the challenge back as PLAIN
 *                    TEXT with a 200 if the token matches, 403 if it does not.
 *                    This is the one-time handshake that activates the webhook.
 *
 *   POST /whatsapp   message and status events, signed with
 *                    X-Hub-Signature-256: sha256=<hex hmac of the RAW body>.
 *                    Meta wants a 200 quickly; it retries on anything else and
 *                    eventually disables a webhook that keeps failing. Since a
 *                    retry is indistinguishable from a new event, the wamid
 *                    dedupe below is what stops a redelivery being answered
 *                    twice.
 *
 * All four credentials come from the environment. Nothing here is hardcoded:
 *
 *   WHATSAPP_PHONE_NUMBER_ID  our number's id, the path segment on sends
 *   WHATSAPP_ACCESS_TOKEN     bearer token for the Graph API
 *   WHATSAPP_VERIFY_TOKEN     our own shared secret for the GET handshake
 *   WHATSAPP_APP_SECRET       Meta app secret, for the POST signature
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_VERSION = "v23.0";
const GRAPH_HOST = "https://graph.facebook.com";

/** Meta signs POSTs with this header; the value is `sha256=<hex>`. */
const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

/** Same deadline shape as every other outbound call in this project. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Meta's hard cap on a text message body is 4096 characters. The model is
 * capped at 1024 tokens, which is comfortably under that in practice, but a
 * reply that did exceed it would be rejected outright — so long replies are
 * split rather than truncated, and the visitor gets all of the answer.
 */
const MAX_TEXT_CHARS = 4096;
const CHUNK_CHARS = 3900;

/** Sends per reply. A bound on the pathological case, not an expected path. */
const MAX_CHUNKS = 4;

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/** Sending is only wired up when both the number id and the token are present. */
function isWhatsAppConfigured() {
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}

/* ------------------------------------------------------------------ *
 * 1. The GET handshake
 * ------------------------------------------------------------------ */

/**
 * Meta's webhook verification.
 *
 * Answered with `text/plain` and the challenge verbatim: Meta compares the
 * response body byte for byte, so a JSON-wrapped or quoted challenge fails the
 * handshake even though the token matched.
 *
 * Fails CLOSED when WHATSAPP_VERIFY_TOKEN is unset — the opposite of the widget
 * token gate in index.js, and deliberately so. An unset widget token would lock
 * legitimate visitors out of the site; an unset verify token only means the
 * webhook cannot be activated yet, and confirming an endpoint to anyone who
 * guesses the URL is worse than a failed handshake.
 *
 * @returns {{statusCode: number, headers: object, body: string}}
 */
function verifyWebhook(query = {}, logger = console) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  const expected = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!expected) {
    logger.error(
      "whatsapp: WHATSAPP_VERIFY_TOKEN is not set — refusing the webhook " +
      "handshake. Set it on the Lambda and re-verify in the Meta app dashboard.",
    );
    return plainText(403, "Forbidden");
  }

  if (mode !== "subscribe") {
    logger.warn(`whatsapp: verification with unexpected hub.mode=${mode}`);
    return plainText(403, "Forbidden");
  }

  // Constant-time, and length-safe: a plain === would leak the token's length
  // through timing, and this endpoint is public.
  if (typeof token !== "string" || !secretEquals(token, expected)) {
    logger.warn("whatsapp: webhook verification failed — hub.verify_token mismatch");
    return plainText(403, "Forbidden");
  }

  if (typeof challenge !== "string" || !challenge) {
    logger.warn("whatsapp: verification token matched but hub.challenge was missing");
    return plainText(400, "Missing hub.challenge");
  }

  logger.log("whatsapp: webhook verification succeeded");
  return plainText(200, challenge);
}

function plainText(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body,
  };
}

/* ------------------------------------------------------------------ *
 * 2. The POST signature
 * ------------------------------------------------------------------ */

/**
 * The request body as Meta sent it.
 *
 * THE RAW BODY IS THE ONLY THING THAT CAN BE HASHED. Meta computes the HMAC
 * over the exact bytes it transmitted, so anything that re-serialises the
 * payload — JSON.parse then JSON.stringify — changes key order, whitespace and
 * unicode escaping, and every signature check fails. A Lambda Function URL may
 * hand the body over base64-encoded (it does for anything it considers binary),
 * so the decode happens here and the resulting Buffer is what both the HMAC and
 * the JSON.parse consume.
 *
 * @returns {Buffer}
 */
function rawBody(event) {
  const body = event?.body;
  if (!body) return Buffer.alloc(0);
  return event.isBase64Encoded
    ? Buffer.from(body, "base64")
    : Buffer.from(body, "utf8");
}

/**
 * Does `signature` match an HMAC-SHA256 of `raw` under `secret`?
 *
 * Pure, so the test suite can drive it with known-good and known-bad HMACs.
 * Returns false rather than throwing for every malformed input: a caller must
 * never be able to turn a bad header into a 500.
 */
function verifySignature(raw, signature, secret) {
  if (!secret || typeof signature !== "string") return false;

  const header = signature.trim();
  if (!header.toLowerCase().startsWith(SIGNATURE_PREFIX)) return false;

  const provided = header.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  // Hex of a SHA-256 digest, and nothing else. Checked before the compare so a
  // junk header cannot reach Buffer.from with a surprising encoding.
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const expected = createHmac("sha256", secret)
    .update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8"))
    .digest("hex");

  return secretEquals(provided, expected);
}

/**
 * The gate the POST handler calls: is this request really from Meta?
 *
 * Fails CLOSED when WHATSAPP_APP_SECRET is unset. This endpoint spends money
 * (a Claude call) and writes to Salesforce on nothing but an unauthenticated
 * POST, so an unconfigured secret must mean "nobody gets in", never "everybody
 * does". The log line says exactly what to set.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function signatureAllows(event, raw, logger = console) {
  const secret = process.env.WHATSAPP_APP_SECRET;

  if (!secret) {
    logger.error(
      "whatsapp: WHATSAPP_APP_SECRET is not set — rejecting the webhook POST. " +
      "Set it from Meta App Dashboard > App Settings > Basic > App Secret.",
    );
    return { ok: false, reason: "unconfigured" };
  }

  const signature = getHeader(event, SIGNATURE_HEADER);
  if (!signature) return { ok: false, reason: "missing-signature" };

  if (!verifySignature(raw, signature, secret)) {
    return { ok: false, reason: "bad-signature" };
  }

  return { ok: true };
}

/** Case-insensitive header lookup; Function URLs lower-case keys, but don't rely on it. */
function getHeader(event, name) {
  const headers = event?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** Constant-time string compare that does not leak length. */
function secretEquals(a, b) {
  const left = createHmac("sha256", "cmp").update(String(a)).digest();
  const right = createHmac("sha256", "cmp").update(String(b)).digest();
  return timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ *
 * 3. Reading the payload
 * ------------------------------------------------------------------ */

/**
 * The message types this bot can actually read. Anything else is recorded and
 * answered with a nudge rather than silence — see UNSUPPORTED_REPLY.
 */
const TEXT_TYPES = new Set(["text", "button", "interactive"]);

const UNSUPPORTED_REPLY =
  "Thanks for that — I can only read text messages here. Could you type your " +
  "question, or reply with your name and the funding amount you're looking for?";

/**
 * Pull the inbound messages out of a webhook payload.
 *
 * The shape, per Meta's spec:
 *
 *   entry[].changes[].value.messages[]  { from, id, timestamp, type, text.body }
 *   entry[].changes[].value.contacts[]  { wa_id, profile.name }
 *   entry[].changes[].value.metadata    { phone_number_id, display_phone_number }
 *   entry[].changes[].value.statuses[]  delivery receipts — counted, never acted on
 *
 * Statuses are the overwhelming majority of the traffic (sent/delivered/read
 * for every message we send), and they are exactly what must not be treated as
 * a visitor turn. They are counted so CloudWatch shows the split, and dropped.
 *
 * Never throws: every level is defensive, because a payload shape we did not
 * expect must come back as "nothing to do" and a 200, not as a 500 that makes
 * Meta retry and eventually disable the webhook.
 *
 * @returns {{messages: Array<object>, statuses: number, other: number}}
 */
function parseInboundMessages(payload, logger = console) {
  const out = { messages: [], statuses: 0, other: 0 };

  if (!payload || typeof payload !== "object") return out;
  if (payload.object && payload.object !== "whatsapp_business_account") {
    logger.warn(`whatsapp: ignoring webhook for object=${payload.object}`);
    return out;
  }

  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change?.value;
      if (!value || typeof value !== "object") continue;

      if (Array.isArray(value.statuses) && value.statuses.length) {
        out.statuses += value.statuses.length;
      }

      if (Array.isArray(value.errors) && value.errors.length) {
        // Meta reports send failures and account-level problems here.
        logger.error(`whatsapp: webhook carried errors: ${JSON.stringify(value.errors)}`);
      }

      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (!messages.length) continue;

      const phoneNumberId = value.metadata?.phone_number_id ?? null;
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];

      for (const message of messages) {
        if (!message || typeof message !== "object") continue;

        const waId = typeof message.from === "string" ? message.from.trim() : "";
        const wamid = typeof message.id === "string" ? message.id.trim() : "";
        if (!waId || !wamid) {
          out.other++;
          logger.warn("whatsapp: skipping message with no `from` or no `id`");
          continue;
        }

        // The contact entry for this sender carries the WhatsApp profile name.
        // Matched on wa_id rather than taken positionally: Meta may batch
        // messages from more than one sender into a single change.
        const contact =
          contacts.find((c) => c?.wa_id === waId) ?? (contacts.length === 1 ? contacts[0] : null);

        out.messages.push({
          waId,
          wamid,
          type: typeof message.type === "string" ? message.type : "unknown",
          text: extractMessageText(message),
          timestamp: normalizeTimestamp(message.timestamp),
          profileName: cleanName(contact?.profile?.name),
          phoneNumberId,
        });
      }
    }
  }

  return out;
}

/**
 * The visitor's words, whatever wrapper Meta put them in.
 *
 * `text` is the ordinary case. `button` and `interactive` are what a template
 * reply or a list selection arrives as — still text the visitor chose, so they
 * are read the same way. Everything else (image, audio, document, location,
 * sticker, contacts) yields null, which the caller answers with
 * UNSUPPORTED_REPLY rather than with a model turn.
 */
function extractMessageText(message) {
  if (!TEXT_TYPES.has(message.type)) return null;

  const candidates = [
    message.text?.body,
    message.button?.text,
    message.interactive?.button_reply?.title,
    message.interactive?.list_reply?.title,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** Meta sends unix seconds as a string. Falls back to now for anything else. */
function normalizeTimestamp(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  return null;
}

/** A WhatsApp profile name is visitor-controlled free text. Bound it. */
function cleanName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

/* ------------------------------------------------------------------ *
 * 4. Dedupe by wamid
 * ------------------------------------------------------------------ */

/**
 * Messages already accepted, so a Meta redelivery is not answered twice.
 *
 * Meta retries whenever it does not get a prompt 200, and a retry carries the
 * SAME message id (wamid) as the original. Without this, one slow turn becomes
 * two Claude calls, two Message__c rows and two WhatsApp replies.
 *
 * Best-effort, and honestly so: this is warm-container memory, exactly like
 * index.js's leadMemory. A cold start forgets, and two concurrent containers do
 * not share it. It covers the realistic case — a retry arriving seconds after
 * the original, at a Lambda that is certainly still warm — and the residual
 * risk is a duplicate reply, never a lost message. The durable version would
 * key on a Wamid__c field on Message__c; see the README's limitations.
 *
 * Bounded FIFO, so a long-lived container cannot grow it forever.
 */
const SEEN_MAX = 2000;
const seen = new Map();

/**
 * Claim a wamid. True the first time, false for a redelivery.
 *
 * Claimed at receipt, BEFORE the work is dispatched, because the whole point is
 * to be holding the claim while the slow part runs — that is when the retry
 * arrives.
 */
function markMessageSeen(wamid) {
  if (!wamid) return true;
  if (seen.has(wamid)) return false;

  seen.set(wamid, true);
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  return true;
}

/** Exported so tests can simulate a cold container. */
function clearSeenMessages() {
  seen.clear();
}

/* ------------------------------------------------------------------ *
 * 5. Sending
 * ------------------------------------------------------------------ */

/**
 * Split a reply into WhatsApp-sized pieces, on paragraph then sentence then
 * word boundaries, so a long answer reads as consecutive messages rather than
 * being cut mid-word.
 */
function splitForWhatsApp(text, limit = CHUNK_CHARS) {
  const body = String(text ?? "").trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const chunks = [];
  let rest = body;

  while (rest.length > limit && chunks.length < MAX_CHUNKS - 1) {
    const window = rest.slice(0, limit);
    // Prefer a paragraph break, then a sentence end, then a space.
    const cut =
      lastIndexAfter(window, "\n\n", limit * 0.5) ??
      lastIndexAfter(window, ". ", limit * 0.5) ??
      lastIndexAfter(window, " ", limit * 0.5) ??
      limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest.slice(0, MAX_TEXT_CHARS));
  return chunks.filter(Boolean);
}

/** Last index of `needle` in `haystack`, but only past `floor`. */
function lastIndexAfter(haystack, needle, floor) {
  const at = haystack.lastIndexOf(needle);
  return at > floor ? at + needle.length : null;
}

/**
 * Send a text message to a visitor.
 *
 *   POST {graph}/v23.0/{PHONE_NUMBER_ID}/messages
 *   Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
 *   { messaging_product: 'whatsapp', to, type: 'text', text: { body } }
 *
 * NEVER THROWS. A Meta outage, an expired token or a rate limit must not cost
 * us the Salesforce record of the conversation, and there is nobody to return a
 * 500 to — Meta already has its 200. Every failure comes back as
 * `{ ok: false }` with the Graph error logged in full for CloudWatch.
 *
 * `preview_url: false` is explicit: Spartan's replies contain the application
 * link, and an unsolicited link preview card in the thread is not wanted.
 *
 * @returns {Promise<{ok: boolean, sent: number, ids: string[], error?: string,
 *   status?: number}>}
 */
async function sendWhatsAppText({ to, body, logger = console, deps = {} }) {
  const fetchImpl = deps.fetch || globalThis.fetch;

  if (!isWhatsAppConfigured()) {
    logger.error(
      "whatsapp: cannot send — WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN is not set",
    );
    return { ok: false, sent: 0, ids: [], error: "unconfigured" };
  }

  const recipient = typeof to === "string" ? to.trim() : "";
  if (!recipient) return { ok: false, sent: 0, ids: [], error: "no-recipient" };

  const chunks = splitForWhatsApp(body);
  if (!chunks.length) return { ok: false, sent: 0, ids: [], error: "empty-body" };

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const url = `${GRAPH_HOST}/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;

  const ids = [];

  for (const [index, chunk] of chunks.entries()) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "text",
          text: { preview_url: false, body: chunk },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {
        // Non-JSON body; the status carries the meaning.
      }

      if (!res.ok) {
        // The Graph error body is the only thing that says WHY — an expired
        // token, a number not in the test allow-list, a 24-hour-window
        // rejection — so it is logged whole.
        logger.error(
          `whatsapp: send failed (HTTP ${res.status}) to=${recipient} ` +
          `chunk=${index + 1}/${chunks.length}: ${text}`,
        );
        return {
          ok: false,
          sent: ids.length,
          ids,
          status: res.status,
          error: parsed?.error?.message || `HTTP ${res.status}`,
        };
      }

      const id = parsed?.messages?.[0]?.id ?? null;
      if (id) ids.push(id);
      logger.log(
        `whatsapp: sent to=${recipient} chunk=${index + 1}/${chunks.length} wamid=${id ?? "(none)"}`,
      );
    } catch (error) {
      logger.error(
        `whatsapp: send threw to=${recipient} chunk=${index + 1}/${chunks.length}: ` +
        `${error && error.message ? error.message : error}`,
      );
      return {
        ok: false,
        sent: ids.length,
        ids,
        error: error && error.message ? error.message : String(error),
      };
    }
  }

  return { ok: true, sent: ids.length || chunks.length, ids };
}

export {
  verifyWebhook,
  rawBody,
  verifySignature,
  signatureAllows,
  parseInboundMessages,
  markMessageSeen,
  clearSeenMessages,
  sendWhatsAppText,
  splitForWhatsApp,
  isWhatsAppConfigured,
  getHeader,
  UNSUPPORTED_REPLY,
  SIGNATURE_HEADER,
  GRAPH_VERSION,
  GRAPH_HOST,
  MAX_TEXT_CHARS,
  CHUNK_CHARS,
  SEEN_MAX,
};
