/**
 * The handoff gate: the single place that decides whether a conversation turn
 * results in a Salesforce Lead.
 *
 * This exists as its own module rather than as inline code in index.js so the
 * gate is unit-testable without a live Salesforce org (see test/handoff-gate.js).
 * index.js should call maybeCreateLead(turn) and spread the result.
 *
 * Two invariants this module enforces:
 *
 *   1. A Lead is created ONLY when turn.handoff === true (strict). Any falsy or
 *      non-true value -- false, undefined, null, 'true', 1 -- creates nothing.
 *      The excluded-industry suppression upstream works by setting handoff to
 *      false, so honoring that flag strictly is what keeps dispensaries, pawn
 *      shops, etc. out of Salesforce. This module adds no industry logic of its
 *      own and must never be given an override.
 *
 *   2. A Salesforce failure NEVER reaches the visitor. Errors are logged to
 *      CloudWatch and swallowed; the caller still returns its reply.
 */
import { createChatbotLead } from "./salesforce.js";

/** Treat null/undefined/'' (and whitespace-only) as absent. */
function present(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

/** First present value among `keys`, trimmed; undefined when none is set. */
function firstPresent(source, keys) {
  for (const key of keys) {
    if (present(source[key])) return String(source[key]).trim();
  }
  return undefined;
}

/**
 * Split a single collected name into Salesforce's two fields: first token to
 * FirstName, everything after it joined into LastName ("Ana Maria Ruiz Diaz"
 * -> Ana / Maria Ruiz Diaz). A single token yields firstName only, leaving
 * salesforce.js's LastName fallback ('Chatbot Lead') to fill the required
 * field rather than duplicating the first name into it.
 */
function splitName(name) {
  if (typeof name !== 'string') return {};
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  if (tokens.length === 1) return { firstName: tokens[0] };
  return { firstName: tokens[0], lastName: tokens.slice(1).join(' ') };
}

/**
 * Adapter between the two field vocabularies in this repo.
 *
 *   intent.js produces:  name, email, phone, businessName, loanAmount, loanPurpose
 *   salesforce.js wants: firstName, lastName, email, phone, businessName,
 *                        monthlyRevenue, timeInBusiness
 *
 * Already-split firstName/lastName win over `name`, so a caller that has done
 * its own splitting passes through untouched.
 *
 * fundingAmount and loanPurpose now map through to Funding_Amount__c and
 * Use_of_Funds__c. `loanAmount` -- the key the old regex extractor produced --
 * is deliberately NOT mapped: it was the field that conflated "revenue" with
 * "amount wanted", which is exactly what the model-reported fundingAmount
 * replaces. Anything unmapped still appears in the raw handoffFields that get
 * logged on a failed write, so nothing collected is lost.
 *
 * @param {object} fields raw handoffFields from the chatbot turn
 * @returns {object} fields in the shape buildLeadPayload consumes
 */
function mapHandoffFields(fields) {
  const source = fields || {};
  const mapped = {};

  const fromName = splitName(source.name);
  const firstName = present(source.firstName)
    ? String(source.firstName).trim()
    : fromName.firstName;
  const lastName = present(source.lastName)
    ? String(source.lastName).trim()
    : fromName.lastName;

  if (firstName) mapped.firstName = firstName;
  if (lastName) mapped.lastName = lastName;

  for (const key of ['email', 'phone', 'businessName']) {
    if (present(source[key])) mapped[key] = String(source[key]).trim();
  }

  const revenue = firstPresent(source, [
    'monthlyRevenue',
    'monthlyGrossRevenue',
    'revenue',
  ]);
  if (revenue) mapped.monthlyRevenue = revenue;

  const timeInBusiness = firstPresent(source, [
    'timeInBusiness',
    'yearsInBusiness',
    'businessAge',
  ]);
  if (timeInBusiness) mapped.timeInBusiness = timeInBusiness;

  if (present(source.fundingAmount)) {
    mapped.fundingAmount = String(source.fundingAmount).trim();
  }

  // loanPurpose arrives as a string from the model's SCG_LEAD block, but the
  // old regex extractor produced an array; accept either and let
  // buildLeadPayload flatten it.
  if (Array.isArray(source.loanPurpose)) {
    const purposes = source.loanPurpose
      .filter((item) => present(item))
      .map((item) => String(item).trim());
    if (purposes.length) mapped.loanPurpose = purposes;
  } else if (present(source.loanPurpose)) {
    mapped.loanPurpose = String(source.loanPurpose).trim();
  }

  return mapped;
}

/**
 * @param {object} turn        the completed turn: { handoff, handoffFields, sessionId }
 * @param {object} [deps]      injection seam for tests
 * @param {Function} [deps.createLead] defaults to createChatbotLead
 * @param {object}   [deps.logger]     defaults to console
 * @returns {Promise<{leadId?: string, duplicate?: boolean}>} empty object when
 *          no lead was created or the write failed. Never throws.
 */
async function maybeCreateLead(turn, deps = {}) {
  const createLead = deps.createLead || createChatbotLead;
  const logger = deps.logger || console;
  const handoff = turn && turn.handoff;
  const sessionId = (turn && turn.sessionId) || 'unknown';
  // Strict === true. Do not loosen this to a truthiness check.
  if (handoff !== true) {
    return {};
  }
  const fields = (turn && turn.handoffFields) || {};
  try {
    // Inside the try on purpose: the caller relies on this function never
    // throwing, so the mapping has to be covered too, not just the write.
    // The raw fields are what gets logged on failure, so replay keeps
    // everything.
    const leadFields = mapHandoffFields(fields);
    const result = await createLead(leadFields);
    logger.log(
      `[leadHandoff] session=${sessionId} lead=${result.id}` +
      `${result.duplicate ? ' (matched existing duplicate)' : ' (created)'}`
    );
    return result.duplicate ? { leadId: result.id, duplicate: true } : { leadId: result.id };
  } catch (err) {
    // Swallowed on purpose. The visitor gets their reply; we lose the lead in
    // Salesforce but keep it in the CloudWatch log for manual replay.
    logger.error(
      `[leadHandoff] SALESFORCE WRITE FAILED session=${sessionId}: ` +
      `${err && err.message ? err.message : err}`
    );
    logger.error(`[leadHandoff] unsaved fields session=${sessionId}: ${JSON.stringify(fields)}`);
    return {};
  }
}
export { maybeCreateLead, mapHandoffFields };
