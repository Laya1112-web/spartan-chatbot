/**
 * Handoff intent detection and contact-field extraction.
 *
 * Two questions, two different sources of truth:
 *
 *   1. Does the visitor want to proceed?  -> `detectHandoff`, deterministic
 *      regex over the visitor's own words. Cheap, auditable, no extra API
 *      call, and the same transcript always produces the same answer.
 *   2. Is this business fundable at all?  -> the model, which is the only
 *      party that holds the excluded-industry list. It reports that per reply
 *      via a status tag (see `systemPrompt.js`), which `index.js` parses.
 *
 * `shouldHandoff` combines them: a handoff means "a fundable visitor is ready
 * to proceed". Two things can signal that readiness, and either is enough:
 *
 *   - the visitor's own words (`detectHandoff`), or
 *   - the model finishing collection and reporting a full SCG_LEAD block,
 *     passed in as `modelSignaledHandoff` by index.js.
 *
 * The second path exists because the first one silently dropped qualified
 * leads: the model would gather every detail, announce the handoff and report a
 * complete block, and if the visitor's closing words happened to be "thank you"
 * or "no" the regex never matched and the lead was thrown away. The model's own
 * completion is now evidence in its own right.
 *
 * What keeps that safe is the minimum gate in index.js, which both paths pass
 * through: an over-eager model reporting a thin block still writes nothing.
 *
 * Decline suppression stays absolute and ahead of both paths. A business
 * Spartan just turned away must never produce a lead — however the visitor
 * phrases the request, and however complete a block the model emits.
 *
 * This module only decides *whether* a handoff was requested and *what* was
 * gathered. Delivering the handoff (CRM, email, Salesforce) is out of scope.
 */

/** Visitor asked for a human, in their own words. */
const EXPLICIT_HANDOFF_PATTERNS = [
  // "funding specialist", "loan officer", "lending advisor", ...
  /\b(funding|loan|lending|business)\s+(specialist|advisor|adviser|officer|rep|representative|agent|consultant|manager)\b/i,
  // "talk to someone", "speak with a human", "connect me with a rep"
  /\b(speak|talk|chat|connect|meet)\s+(?:to|with)\s+(?:a|an|the|some)?\s*(human|person|someone|somebody|real person|live person|rep|representative|agent|specialist|advisor|adviser|broker|underwriter)\b/i,
  // "connect me", "get me in touch", "put me through"
  /\b(connect|transfer)\s+me\b/i,
  /\b(get|put)\s+me\s+(in\s+touch|through|on\s+the\s+phone)\b/i,
  // "call me", "have someone call me", "can someone reach out"
  /\b(call|phone|text|contact|email)\s+me\b/i,
  /\b(have|has|can|could|would)\s+(someone|somebody|a\s+specialist|an?\s+agent|a\s+rep\w*)\s+(call|contact|reach|email|phone|get)\b/i,
  /\breach\s+out\s+to\s+me\b/i,
  // "I want to apply", "start an application", "how do I get started"
  /\b(?:i(?:'d| would)?\s+(?:like|want|wanna)\s+to\s+)?(apply|start\s+(?:an?\s+)?application|submit\s+(?:an?\s+)?application|get\s+(?:the\s+)?process\s+started)\b/i,
  // "human please", "real human"
  /\b(?:a\s+)?(?:real\s+)?human\s+(?:being\s+)?(?:please|now)\b/i,
];

/** The assistant offered a handoff on its previous turn. */
const ASSISTANT_OFFER_PATTERNS = [
  /\b(funding|loan|lending)\s+(specialist|advisor|adviser|officer)\b/i,
  /\b(connect|put)\s+you\s+(?:with|in\s+touch|through)\b/i,
  /\bhave\s+(?:a|an|one\s+of)\b[^.?!]{0,60}\b(reach\s+out|call\s+you|contact\s+you|follow\s+up)\b/i,
  /\bwould\s+you\s+like\s+(?:me\s+to|to\s+speak|to\s+talk)\b/i,
  /\b(?:should|shall|can|may)\s+i\s+have\s+someone\b/i,
  /\bspeak\s+(?:with|to)\s+(?:a|an|one\s+of\s+our)\b/i,
];

/** Visitor accepted an offer. Matched against short, mostly-affirmative turns. */
const AFFIRMATIVE_PATTERN =
  /^(?:yes|yeah|yea|yep|yup|ya|sure|ok|okay|k|alright|absolutely|definitely|certainly|please|please do|yes please|sounds good|that works|works for me|let'?s do it|go ahead|do it|i'?d like that|i would like that|that would be great|great|perfect|fine|why not|of course|makes sense)\b/i;

/** An explicit "no thanks" always wins over an affirmative-looking fragment. */
const NEGATIVE_PATTERN =
  /^(?:no|nope|nah|not\s+(?:yet|now|right\s+now|interested)|don'?t|do\s+not|never\s+mind|nevermind|maybe\s+later|later|i'?m\s+(?:good|ok|okay|just\s+(?:looking|browsing)))\b/i;

/**
 * Should this turn be handed off to a funding specialist?
 *
 * Fires when either:
 *   1. the visitor's latest message explicitly asks for a human, or
 *   2. the assistant offered a handoff on its previous turn and the
 *      visitor's latest message accepts it.
 *
 * @param {Array<{role: string, content: string}>} messages Full conversation,
 *   ending with the visitor's latest message.
 * @returns {boolean}
 */
export function detectHandoff(messages) {
  const lastUser = lastByRole(messages, "user");
  if (!lastUser) return false;

  const text = lastUser.content.trim();
  if (!text) return false;

  if (EXPLICIT_HANDOFF_PATTERNS.some((re) => re.test(text))) return true;

  // Acceptance of a prior offer. Only consider short turns as bare
  // acceptances, so "ok, but what are your rates first?" doesn't hand off.
  if (NEGATIVE_PATTERN.test(text)) return false;
  if (!AFFIRMATIVE_PATTERN.test(text)) return false;
  if (countWords(text) > 12) return false;

  const previousAssistant = lastByRole(messages.slice(0, -1), "assistant");
  if (!previousAssistant) return false;

  return ASSISTANT_OFFER_PATTERNS.some((re) => re.test(previousAssistant.content));
}

/**
 * Phrases that mean "Spartan cannot fund this business" — deliberately narrow.
 * They all pivot on funding the *business*, so they don't catch "I can't quote
 * you a factor rate" or "you may not meet the guidelines yet", neither of
 * which should suppress a handoff.
 */
const DECLINE_PATTERNS = [
  /\b(?:is|isn'?t|are|aren'?t|not|never)\s+able\s+to\s+fund\b/i,
  /\b(?:can'?t|cannot|unable\s+to|won'?t\s+be\s+able\s+to)\s+fund\b/i,
  /\b(?:do(?:es)?\s+not|don'?t|doesn'?t)\s+fund\b/i,
  /\b(?:we|spartan)\s+(?:do(?:es)?\s+not|don'?t|doesn'?t|can'?t|cannot)\s+work\s+with\b/i,
  /\b(?:isn'?t|is\s+not|not)\s+(?:an?\s+)?industry\s+(?:that\s+)?(?:we|spartan)\b/i,
  /\b(?:outside|not\s+(?:within|among))\s+(?:what|the\s+industries)\s+(?:we|spartan)\s+(?:fund|work)\b/i,
  /\bfalls?\s+(?:in)?to\s+(?:a\s+)?categor(?:y|ies)\s+(?:that\s+)?spartan\s+(?:isn'?t|is\s+not|can'?t|cannot)\b/i,
];

/**
 * Does this assistant reply turn the business away? Used as the deterministic
 * backstop for the model's own status tag, so a dropped tag can't manufacture
 * a lead out of a business we just refused.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isDeclineReply(text) {
  if (typeof text !== "string" || !text) return false;
  return DECLINE_PATTERNS.some((re) => re.test(text));
}

/**
 * The flag `index.js` actually returns: a fundable visitor is ready to proceed.
 *
 * Fires when the visitor's words ask for it OR when the model signalled that it
 * finished collecting (`modelSignaledHandoff`). Either is sufficient; neither
 * is required of the other.
 *
 * Suppressed — before either path is considered — when the model tagged this
 * reply a decline, when this reply reads as a decline, or when any earlier
 * assistant turn declined. Once a business has been turned away, neither a
 * later "but I want to talk to someone" nor a model-emitted block may
 * resurrect it as a lead.
 *
 * A missing status tag means "not declined": the deterministic checks still
 * guard the bad-lead case, and defaulting the other way would silently drop
 * real leads every time the model omitted a tag.
 *
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages Conversation,
 *   ending with the visitor's latest message.
 * @param {string} [args.reply] The assistant's reply for this turn, tag stripped.
 * @param {boolean} [args.modelDeclined] Whether the model tagged this reply a decline.
 * @param {boolean} [args.modelSignaledHandoff] Whether the model reported a
 *   complete-enough SCG_LEAD block on this turn. index.js decides that, because
 *   it is the side that parses the block and holds the minimum gate.
 * @returns {boolean}
 */
export function shouldHandoff({
  messages,
  reply = "",
  modelDeclined = false,
  modelSignaledHandoff = false,
}) {
  // Decline wins over everything, including a fully populated block.
  if (modelDeclined) return false;
  if (isDeclineReply(reply)) return false;
  if (messages.some((m) => m.role === "assistant" && isDeclineReply(m.content))) {
    return false;
  }
  return detectHandoff(messages) || modelSignaledHandoff;
}

const EMAIL_RE = /\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const NAME_RE =
  /\b(?:my name(?:'s| is)|name\s*[:-]|i am|i'?m|this is|it'?s)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2})/gu;
const BUSINESS_PATTERNS = [
  /\b(?:my|our)\s+(?:business|company|shop|store|firm|restaurant|practice)\s+(?:is\s+)?(?:called|named)\s+([^.,!?\n]{2,60})/i,
  /\b(?:business|company)\s+name\s*[:-]\s*([^.,!?\n]{2,60})/i,
  // "I run Whitfield Bakery" — the capital letter is what separates a real
  // name from a generic "I run a bakery". Only capitalised words (plus small
  // connectors) are taken, so trailing prose like "in Cleveland" is left out.
  // Case-sensitive on purpose: the lead-in allows either case, the captured
  // name must be capitalised.
  /\b(?:[Ii]|[Ww]e)\s+(?:run|own|operate)s?\s+(?:a|an|the|my|our)?\s*([A-Z][\w&'’.-]*(?:\s+(?:(?:of|and|the|&)\s+)?[A-Z][\w&'’.-]*)*)/,
];
// "$50k", "$250,000", "250k", "50 thousand", "1.5 million"
const AMOUNT_RE =
  /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k\b|m\b|mm\b|thousand\b|million\b)?|\b\d[\d,]*(?:\.\d+)?\s*(?:k\b|mm?\b|thousand\b|million\b)|\b\d{1,3}(?:,\d{3})+\b/gi;

const PURPOSE_KEYWORDS = [
  "working capital",
  "cash flow",
  "payroll",
  "equipment",
  "inventory",
  "expansion",
  "new location",
  "renovation",
  "build-out",
  "marketing",
  "advertising",
  "hiring",
  "staffing",
  "real estate",
  "vehicle",
  "truck",
  "refinance",
  "debt consolidation",
  "consolidate debt",
  "taxes",
  "seasonal",
  "startup costs",
  "purchase order",
  "invoice",
];

/** The visitor's own turns, joined. Never the assistant's. */
function userTranscript(messages) {
  return (messages || [])
    .filter((m) => m && m.role === "user" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n");
}

function findEmail(transcript) {
  return lastMatch(transcript, EMAIL_RE);
}

function findPhone(transcript) {
  // Strip currency amounts before scanning for phone numbers so "$250,000"
  // and "1,500,000 in revenue" can't be read as a phone number.
  const phoneSource = transcript.replace(/\$\s?[\d,.]+/g, " ");
  return lastMatch(phoneSource, PHONE_RE, (raw) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return formatPhone(digits);
    if (digits.length === 11 && digits.startsWith("1")) {
      return formatPhone(digits.slice(1));
    }
    return null;
  });
}

/**
 * NARROW fallback for when the model omits its SCG_LEAD block on a genuine
 * handoff turn. Recovers contact details ONLY — email and phone.
 *
 * Nothing else may be recovered here, and that restriction is the whole point:
 * an email address and a phone number cannot be confused with a money figure,
 * so filling them in from the transcript carries no conflation risk. Revenue,
 * funding amount, and purpose must come from the model's block and nowhere
 * else — regex could not tell "$50k/month in revenue" from "$75k needed",
 * which is the collision this design exists to eliminate. Do not widen this
 * function to name, businessName, or any amount.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{email?: string, phone?: string}}
 */
export function recoverContactFields(messages) {
  const transcript = userTranscript(messages);
  const fields = {};

  const email = findEmail(transcript);
  if (email) fields.email = email;

  const phone = findPhone(transcript);
  if (phone) fields.phone = phone;

  return fields;
}

/**
 * NO LONGER THE SOURCE OF HANDOFF FIELDS. `index.js` now takes field values
 * from the model's SCG_LEAD block instead (see systemPrompt.js), because regex
 * extraction cannot tell "$50k/month in revenue" from "$75,000 of funding" —
 * both matched AMOUNT_RE and collided in `loanAmount`.
 *
 * Kept for reference and still covered by tests; safe to delete along with its
 * tests once nothing depends on it.
 *
 * Best-effort extraction of anything a funding specialist would need in order
 * to follow up. Only keys that were actually found are returned.
 *
 * Reads the visitor's own messages only — never the assistant's, so the bot
 * echoing a figure back can't be mistaken for the visitor stating one.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{name?: string, email?: string, phone?: string,
 *            businessName?: string, loanAmount?: string,
 *            loanPurpose?: string[]}}
 */
export function extractHandoffFields(messages) {
  const transcript = userTranscript(messages);

  const fields = {};

  const email = findEmail(transcript);
  if (email) fields.email = email;

  const phone = findPhone(transcript);
  if (phone) fields.phone = phone;

  const name = lastMatch(transcript, NAME_RE, (_raw, groups) => {
    const candidate = (groups[0] ?? "").trim();
    // Reject sentence-openers that happen to be capitalised: "I'm Looking".
    if (!candidate || /^(?:looking|interested|trying|ready|just|not|the)\b/i.test(candidate)) {
      return null;
    }
    return candidate;
  });
  if (name) fields.name = name;

  for (const re of BUSINESS_PATTERNS) {
    const match = re.exec(transcript);
    const value = match?.[1]?.trim();
    if (value) {
      fields.businessName = value;
      break;
    }
  }

  const amount = lastMatch(transcript, AMOUNT_RE, (raw) => {
    const normalized = raw.trim().replace(/\s+/g, "");
    // A bare comma-grouped number needs a money-ish cue nearby to count.
    if (!/[$km]|thousand|million/i.test(normalized)) {
      return /\b(?:need|want|looking\s+for|about|around|up\s+to|amount|loan|funding|borrow|revenue|sales)\b/i.test(
        transcript,
      )
        ? normalized
        : null;
    }
    return normalized;
  });
  if (amount) fields.loanAmount = amount;

  const lowered = transcript.toLowerCase();
  const purposes = PURPOSE_KEYWORDS.filter((kw) => lowered.includes(kw));
  if (purposes.length) fields.loanPurpose = purposes;

  return fields;
}

function lastByRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role) return messages[i];
  }
  return null;
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Last match of a global regex, optionally transformed/validated. Returning
 * null from `transform` rejects a candidate and falls back to earlier ones.
 */
function lastMatch(text, globalRe, transform) {
  const re = new RegExp(globalRe.source, globalRe.flags);
  let result = null;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    const value = transform
      ? transform(match[0], match.slice(1))
      : match[0].trim();
    if (value) result = value;
  }
  return result;
}

function formatPhone(digits) {
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
