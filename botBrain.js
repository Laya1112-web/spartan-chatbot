/**
 * botBrain.js — the parts of the bot that are not a transport.
 *
 * Everything in here was lifted verbatim out of index.js when WhatsApp became a
 * second front door onto the same bot. It is the shared half: the Anthropic
 * client, the model settings, the clock, and every rule for turning a model
 * reply into (a) text a visitor may read and (b) the lead fields Salesforce
 * gets. index.js keeps the web-specific half (CORS, the widget token, request
 * validation, the poll and close actions) and re-exports what tests import.
 *
 * The transports differ in how a turn arrives and how the reply leaves:
 *
 *   web       the widget POSTs the whole transcript and reads the reply out of
 *             the HTTP response; lead fields round-trip through handoffContext.
 *   WhatsApp  Meta POSTs one message; the transcript is re-read from
 *             Message__c and the reply is pushed back through the Graph API.
 *
 * Nothing below knows which one it is serving. Anything that does belongs in
 * index.js or whatsappWebhook.js, not here.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

// Transcript limits. The web widget sends the whole thread every turn and the
// WhatsApp path rebuilds one of comparable size out of Salesforce, so both cap
// it here rather than forwarding an unbounded payload to the API.
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 4000;

/**
 * The clock, behind one indirection.
 *
 * Business-hours behaviour is the one thing in this bot that depends on when it
 * runs, which would otherwise make it testable only by waiting until Tuesday
 * evening. Tests pin this to a fixed instant via setClock(); production never
 * calls it, and `new Date()` is the only thing it ever returns there.
 *
 * Shared by both transports on purpose: one pinned clock covers the web turn
 * and the WhatsApp turn, so a test that fixes the hour fixes it for both.
 */
const clock = { now: () => new Date() };

/** Exported so tests can pin the clock. Pass nothing to restore real time. */
function setClock(fn) {
  clock.now = typeof fn === "function" ? fn : () => new Date();
}

const EMPTY_REPLY_FALLBACK =
  "Sorry, I wasn't able to answer that. Would you like me to have a funding specialist reach out?";

let anthropic;

function getClient() {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Configuration failure, not a caller failure — 500, logged by the caller.
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
export {
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
  sanitizeLeadFields,
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
  LEAD_NAME_FALLBACK,
  LEAD_FIELD_KEYS,
  meetsLeadMinimum,
  missingForLeadMinimum,
};
