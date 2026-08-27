/**
 * Rep availability: the one place that knows whether a human is actually
 * behind the chat right now, and what the bot may promise when nobody is.
 *
 * Spartan's funding specialists work Monday–Friday, 9:00am–6:00pm Eastern.
 * Outside that window no rep will pick up a claimed conversation, so a bot
 * reply that says "connecting you to a specialist now" is a promise nothing
 * can keep — the visitor sits watching a chat nobody joins until morning.
 *
 * What this module does NOT change: after hours the bot still qualifies the
 * visitor, still collects every lead field, and index.js still writes the Lead
 * and the Conversation__c. An after-hours visitor is a lead like any other;
 * the only thing that changes is the language at the handoff moment.
 *
 * Two halves, and the second exists because the first is only advice:
 *
 *   1. resolveBusinessHours — the clock. Real timezone conversion, so EST and
 *      EDT are both correct without this file knowing which is in force.
 *   2. enforceAfterHoursReply — the enforcement. systemPrompt.js tells the
 *      model reps are offline, but a prompt is guidance, not a guarantee. This
 *      strips a live-connection promise out of the reply if the model makes one
 *      anyway, and appends the availability notice the visitor actually needs.
 */

export const BUSINESS_TIMEZONE = "America/New_York";

/** Open at 9:00am ET, shut at 6:00pm ET. Half-open: 9 <= hour < 18. */
export const OPEN_HOUR = 9;
export const CLOSE_HOUR = 18;

/** Mon–Fri, as Intl's `weekday: "short"` spells them in en-US. */
const BUSINESS_WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

/** Works around the clock, which is what makes it the after-hours path. */
export const FULL_APPLICATION_URL = "https://apply.spartancapitalgroup.com/step-2/";

export const BUSINESS_HOURS_LABEL = "Monday–Friday, 9am–6pm Eastern";

/**
 * The structural fallback wording, used only when the model's own reply didn't
 * carry the message. The natural phrasing lives in systemPrompt.js — this is
 * the net underneath it, so it is allowed to read a little more plainly.
 */
export const AFTER_HOURS_HOURS_SENTENCE =
  `Our funding specialists are available ${BUSINESS_HOURS_LABEL}. ` +
  "I've saved your details and a specialist will reach out during business hours.";

export const AFTER_HOURS_APPLICATION_SENTENCE =
  "In the meantime, you can start your application anytime at " +
  `${FULL_APPLICATION_URL} — is there anything else I can help you with?`;

export const AFTER_HOURS_NOTICE =
  `${AFTER_HOURS_HOURS_SENTENCE} ${AFTER_HOURS_APPLICATION_SENTENCE}`;

/**
 * Eastern weekday + hour for an instant.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: the latter has historically
 * resolved to h24 in en-US on some ICU builds, which reports midnight as hour
 * 24 instead of 0. Either spelling is fine for the 9–18 window, but a 24 would
 * be a silent trap for anything later that compares against 0.
 */
const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIMEZONE,
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * Are funding specialists available at `now`?
 *
 * The conversion is a real timezone lookup on purpose. A fixed UTC offset is
 * wrong for half the year in either direction: assume UTC-5 and every summer
 * afternoon reads an hour early (a 9:30am EDT visitor looks like 8:30am and
 * gets the after-hours message while reps are at their desks); assume UTC-4 and
 * every winter evening reads an hour late (a 5:30pm EST visitor looks like
 * 6:30pm and is turned away 30 minutes early). Intl carries the DST rules, so
 * neither this module nor a deploy has to track when the clocks change.
 *
 * @param {Date} [now] injectable clock; tests pin it, production passes nothing.
 * @returns {{open: boolean, timezone: string, weekday: string|null,
 *   hour: number|null, hours: string}}
 */
export function resolveBusinessHours(now = new Date(), logger = console) {
  const result = {
    open: false,
    timezone: BUSINESS_TIMEZONE,
    weekday: null,
    hour: null,
    hours: BUSINESS_HOURS_LABEL,
  };

  let weekday;
  let hour;
  try {
    for (const part of ET_FORMAT.formatToParts(now)) {
      if (part.type === "weekday") weekday = part.value;
      if (part.type === "hour") hour = Number(part.value);
    }
  } catch (error) {
    // Fails CLOSED, deliberately. Node 20 on Lambda ships full ICU so this is
    // near-unreachable, but the two failure directions are not symmetric: a
    // false "open" promises a live specialist who does not exist, while a false
    // "closed" only tells a daytime visitor that someone will call them back —
    // and the Lead and the Conversation__c are still written either way.
    logger.error(
      "[businessHours] Eastern time conversion failed, treating as after hours: " +
      `${error && error.message ? error.message : error}`,
    );
    return result;
  }

  if (!weekday || !Number.isFinite(hour)) return result;

  result.weekday = weekday;
  result.hour = hour;
  result.open = BUSINESS_WEEKDAYS.has(weekday) && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
  return result;
}

/**
 * Words for a person a visitor could be connected to. A live-connection promise
 * has to be about one of these to count.
 */
const HUMAN_RE =
  /\b(?:specialists?|advisors?|advisers?|representatives?|reps?|agents?|humans?|someone|somebody|team\s+member|colleague|underwriter|officer)\b/i;

/**
 * Verbs and phrases that assert a human is being brought into THIS chat.
 *
 * Note what is deliberately absent: "reach out", "be in touch", "follow up",
 * "get back to you". Those are exactly what the bot SHOULD say after hours, so
 * matching them would strip the correct message along with the wrong one.
 */
const LIVE_CONNECTION_PATTERNS = [
  /\bconnect(?:ing|ed|s)?\b/i,
  /\btransferr?(?:ing|ed|s)?\b/i,
  /\bhand(?:ing|ed|s)?\s+(?:you\s+)?(?:off|over)\b/i,
  /\bput(?:ting)?\s+you\s+through\b/i,
  /\bjoin(?:ing|ed|s)?\b/i,
  /\b(?:jump|hop|pop|step)(?:ping|s|ed)?\s+(?:in|on|into)\b/i,
  /\bbring(?:ing)?\s+(?:in|on)\b/i,
  /\bloop(?:ing)?\s+in\b/i,
  /\bon\s+the\s+line\b/i,
  /\blive\s+(?:chat|specialist|agent|rep)/i,
  /\bpick(?:ing)?\s+(?:this|it|the\s+chat)\s+up\b/i,
  /\btak(?:e|ing)\s+over\s+(?:this|the)\s+chat\b/i,
];

/**
 * Immediacy: "a specialist will be with you shortly" makes the same false
 * promise as "connecting you now" without using a connecting verb, so an
 * immediacy phrase in a sentence about a human counts too.
 */
const IMMEDIACY_PATTERNS = [
  /\bright\s+now\b/i,
  /\bright\s+away\b/i,
  /\bmomentarily\b/i,
  /\bin\s+(?:just\s+)?a\s+(?:moment|minute|sec\w*|few\s+(?:moments|minutes|seconds))\b/i,
  /\b(?:one|just\s+a)\s+(?:moment|minute|second|sec)\b/i,
  /\bshortly\b/i,
  /\bany\s+(?:moment|minute|second)\b/i,
  /\bhold\s+(?:on|tight)\b/i,
  /\bstand(?:ing)?\s+by\b/i,
  /\bas\s+we\s+speak\b/i,
  /\bin\s+this\s+chat\b/i,
];

/**
 * Does this one sentence promise a live human, now?
 *
 * Both halves are required — a person AND an assertion of immediacy or
 * connection — which is what keeps "a specialist will reach out during business
 * hours" (person, no assertion) and "let me know if there's anything else right
 * now" (assertion, no person) out of the net.
 */
export function promisesLiveHuman(sentence) {
  if (typeof sentence !== "string" || !sentence.trim()) return false;
  if (!HUMAN_RE.test(sentence)) return false;
  return (
    LIVE_CONNECTION_PATTERNS.some((re) => re.test(sentence)) ||
    IMMEDIACY_PATTERNS.some((re) => re.test(sentence))
  );
}

/**
 * Sentence boundaries, or a line break. Only used when something needs
 * stripping, so a reply that passes clean keeps the model's own formatting
 * byte for byte.
 */
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;

function splitSentences(text) {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Did the model already state the hours itself? Day range AND clock range. */
const DAY_RANGE_RE = /\bmon(?:day)?\b[^.!?\n]{0,40}\bfri(?:day)?\b/i;
const CLOCK_RANGE_RE = /\b9\s*(?::00)?\s*(?:a\.?m\.?)?[^.!?\n]{0,15}\b6\s*(?::00)?\s*p\.?m\.?/i;

function mentionsBusinessHours(text) {
  return DAY_RANGE_RE.test(text) && CLOCK_RANGE_RE.test(text);
}

/** Host-and-path check, so a trailing-slash or tracking-param variant counts. */
function mentionsApplication(text) {
  return text.includes("apply.spartancapitalgroup.com");
}

/**
 * The structural after-hours gate. Called by index.js on every bot turn taken
 * outside business hours, after the reply's tags are stripped and before it is
 * either returned to the widget or mirrored into Salesforce — so the visitor
 * and the rep's morning transcript see the same text.
 *
 * Two operations, in order:
 *
 *   1. Strip any sentence promising a live human now. Over-stripping is the
 *      safe direction here: a slightly terse reply costs the visitor nothing,
 *      while a surviving "a specialist is joining you" costs them an evening
 *      staring at an empty chat.
 *   2. Append the availability notice — the hours, the details being saved, and
 *      the full application as the thing that does work right now — unless the
 *      model already said it.
 *
 * `declined` is the one case that appends nothing. A business Spartan cannot
 * fund gets no specialist and no application link at any hour, so the
 * after-hours notice must not become a back door to the link the decline path
 * deliberately withholds. Stripping still runs.
 *
 * @param {string} reply the tag-stripped reply
 * @param {object} [options]
 * @param {boolean} [options.handoff] is this the turn that would hand off?
 * @param {boolean} [options.declined] did this reply turn the business away?
 * @returns {{reply: string, stripped: string[], appended: boolean, changed: boolean}}
 */
export function enforceAfterHoursReply(reply, { handoff = false, declined = false } = {}) {
  const original = typeof reply === "string" ? reply : "";
  const stripped = [];

  let text = original;
  if (original.trim()) {
    const sentences = splitSentences(original);
    const kept = sentences.filter((sentence) => {
      if (!promisesLiveHuman(sentence)) return true;
      stripped.push(sentence);
      return false;
    });
    // Re-joined only when something was actually removed; otherwise the reply
    // passes through untouched, line breaks and all.
    if (stripped.length) text = kept.join(" ").trim();
  }

  // Append at the handoff moment — or whenever a promise had to be removed,
  // because the visitor is then owed the true version of what was just taken
  // out from under them.
  let appended = false;
  if (!declined && (handoff || stripped.length)) {
    const parts = [];
    if (!mentionsBusinessHours(text)) parts.push(AFTER_HOURS_HOURS_SENTENCE);
    if (!mentionsApplication(text)) parts.push(AFTER_HOURS_APPLICATION_SENTENCE);
    if (parts.length) {
      text = [text, ...parts].filter((part) => part && part.trim()).join(" ").trim();
      appended = true;
    }
  }

  // Stripping emptied the reply and nothing replaced it — only reachable on a
  // declined turn, where appending is forbidden. Hand back what the model
  // wrote: a decline delivered as written beats a decline delivered as silence.
  if (!text.trim()) text = original;

  return {
    reply: text,
    stripped,
    appended,
    changed: text !== original,
  };
}
