/**
 * Salesforce lead creation for the spartan-chatbot Lambda.
 *
 * Auth and the duplicate-handling fallback are ported from the existing Python
 * lead-handler (lambda_function.py: create_jwt / get_sf_token / create_lead).
 * That Lambda is NOT modified by this module -- this is a separate consumer of
 * the SAME Connected App (Lead_Ingest_API) and the same integration user, so no
 * new user pre-authorization is required.
 *
 * Deliberate differences from the Python original:
 *   - Signs with Node's built-in crypto instead of shelling out to `openssl`.
 *   - No JWT library dependency.
 *   - Pins REST API v61.0 (the Python is on a stale v59.0).
 *   - Sets LeadSource explicitly to 'Chatbot' rather than defaulting to 'Web'.
 *
 * ESM, matching the rest of this project ("type": "module" in package.json).
 */

import crypto from "node:crypto";

const SF_LOGIN_HOST = 'https://login.salesforce.com';
const SF_TOKEN_URL = `${SF_LOGIN_HOST}/services/oauth2/token`;
const SF_API_VERSION = 'v61.0';

// JWT lifetime. Salesforce rejects an exp more than a few minutes out; 300s
// matches the Python implementation.
const JWT_TTL_SECONDS = 300;

/**
 * Warm-container access-token cache.
 *
 * Every Salesforce operation used to begin with a fresh JWT auth. That was
 * tolerable when the only operation was a lead write on a handoff turn, but the
 * conversation sync checks for a claimed conversation BEFORE Claude on every
 * single turn, so the auth round-trip landed in the latency path of every
 * message. Caching it in module scope means a warm container auths once and
 * reuses the token; a cold container behaves exactly as before.
 *
 * Held for the JWT's own lifetime minus a margin, which is deliberately
 * conservative — the Salesforce session outlives the assertion that opened it,
 * so this refreshes well before anything can actually expire. Lambda gives no
 * cross-container guarantees, so this is a latency optimisation only: every
 * path still works with an empty cache.
 */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
let tokenCache = null;

/** Drop the cached token. Called on a 401, when the token is no longer good. */
function invalidateSfToken() {
  tokenCache = null;
}

// Deadline for each outbound Salesforce call, so a slow or unresponsive
// Salesforce can never hang a Lambda invocation and cost the visitor a reply
// they had already earned.
//
// Budget arithmetic, since it does not fully close: a lead write is two calls
// (token + create), so the worst case here is ~8s on top of Claude, which is
// itself capped at 25s with one retry against Lambda's 30s ceiling. If Claude
// runs long AND both calls burn their full timeout, the invocation can still
// approach that ceiling. What this constant guarantees is that each call bails
// at a known deadline instead of hanging indefinitely -- the unbounded hang is
// the actual risk being closed. Tune here.
// Two Salesforce calls per lead (JWT auth, then insert) at 8s each is 16s
// worst case, which still fits the 30s Lambda budget alongside the Claude
// call. 4s was too tight: a cold JWT auth plus insert overran it and the
// write was lost even though every field had been collected.
const SF_FETCH_TIMEOUT_MS = 8000;

// Required-field fallbacks. Salesforce rejects a Lead insert without LastName,
// and Company is required for a non-person-account Lead.
const LAST_NAME_FALLBACK = 'Chatbot Lead';
const COMPANY_FALLBACK = 'Unknown (Chatbot Lead)';

// Attribution constants for this channel.
const LEAD_SOURCE = 'Chatbot';
const CVR_ID = 'chatbot_scg';

/** base64url with no padding, per RFC 7515. */
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Read the RSA private key from the environment, converting the \n-escaped
 * single-line form (how it is stored in Lambda config) into real newlines.
 * Mirrors the Python: os.environ['SF_PRIVATE_KEY'].replace('\\n', '\n')
 */
function readPrivateKey() {
  const raw = process.env.SF_PRIVATE_KEY;
  if (!raw) {
    throw new Error('SF_PRIVATE_KEY is not set.');
  }
  return raw.replace(/\\n/g, '\n');
}

/**
 * Build and sign the RS256 assertion.
 * Exported for the dry-run test so the claim shape can be inspected without
 * touching the real key.
 */
function createJwt({ clientId, username, privateKeyPem, now = Math.floor(Date.now() / 1000) }) {
  if (!clientId) throw new Error('SF_CLIENT_ID is not set.');
  if (!username) throw new Error('SF_USERNAME is not set.');

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientId,
    sub: username,
    aud: SF_LOGIN_HOST,
    exp: now + JWT_TTL_SECONDS,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString('base64url');

  return { jwt: `${signingInput}.${signature}`, header, claims };
}

/**
 * Exchange the assertion for an access token.
 * @returns {Promise<{access_token: string, instance_url: string}>}
 */
async function getSfToken({ now = Date.now, force = false } = {}) {
  const requestedAt = now();

  if (!force && tokenCache && requestedAt < tokenCache.expiresAt) {
    return {
      access_token: tokenCache.access_token,
      instance_url: tokenCache.instance_url,
      // Carried through the cache because the poll path identifies the bot's
      // own messages by their author (see integrationUserId): a cache hit that
      // dropped this would leave the poll unable to tell rep from bot.
      id: tokenCache.id,
    };
  }

  const { jwt } = createJwt({
    clientId: process.env.SF_CLIENT_ID,
    username: process.env.SF_USERNAME,
    privateKeyPem: readPrivateKey(),
  });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const res = await fetch(SF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // On timeout this rejects; the error propagates to maybeCreateLead, which
    // swallows it and logs the unsaved fields for manual replay.
    signal: AbortSignal.timeout(SF_FETCH_TIMEOUT_MS),
  });

  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    let description = '';
    try {
      const parsed = JSON.parse(text);
      description = parsed.error_description || '';
      detail = `${parsed.error || res.status}: ${description}`;
    } catch (_) {
      // Non-JSON error body -- keep the raw text.
    }

    // This specific failure means the integration user has never approved the
    // Connected App. It should not happen here because we reuse Lead_Ingest_API
    // with the same user as the Python Lambda, so call it out explicitly rather
    // than letting it read as a generic auth failure.
    if (/hasn't approved this consumer|has not approved this consumer/i.test(description)) {
      throw new Error(
        `Salesforce auth failed: the integration user (${process.env.SF_USERNAME}) has not ` +
        'pre-authorized this Connected App. Verify SF_CLIENT_ID points at Lead_Ingest_API ' +
        'and that the app policy is "Admin approved users are pre-authorized" with the ' +
        `user's profile/permission set assigned. Raw: ${detail}`
      );
    }
    throw new Error(`Salesforce auth failed: ${detail}`);
  }

  const auth = JSON.parse(text);
  if (!auth.access_token || !auth.instance_url) {
    throw new Error('Salesforce auth response missing access_token or instance_url.');
  }

  tokenCache = {
    access_token: auth.access_token,
    instance_url: auth.instance_url,
    // Identity URL, .../id/<orgId>/<userId>. Absent from some mocked token
    // responses, which integrationUserId handles as "unknown".
    id: auth.id,
    expiresAt: requestedAt + JWT_TTL_SECONDS * 1000 - TOKEN_REFRESH_MARGIN_MS,
  };

  return auth;
}

/**
 * The Salesforce user id this Lambda authenticates as.
 *
 * Every Message__c this project writes -- the visitor's turns and the bot's
 * replies alike -- is authored by the integration user, so CreatedById is what
 * separates "the bot said this" from "a rep said this" without adding a field
 * to Message__c. The poll path in conversation.js is the consumer.
 *
 * The id arrives free with the JWT auth: the token response carries an identity
 * URL of the form https://login.salesforce.com/id/<orgId>/<userId>, whose last
 * segment is the user. SF_INTEGRATION_USER_ID overrides it for an org where
 * that URL is unavailable or the messages are written by a different user.
 *
 * @returns {string|null} null when it cannot be determined, which callers must
 *   treat as "cannot tell rep from bot" rather than as "no bot".
 */
const SF_USER_ID_RE = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

function integrationUserId(auth) {
  const override = process.env.SF_INTEGRATION_USER_ID;
  if (typeof override === 'string' && SF_USER_ID_RE.test(override.trim())) {
    return override.trim();
  }

  const identity = auth && typeof auth.id === 'string' ? auth.id : '';
  const userId = identity.split('/').filter(Boolean).pop() || '';
  return SF_USER_ID_RE.test(userId) ? userId : null;
}

/**
 * Normalize to +1XXXXXXXXXX when there are exactly 10 digits.
 * Mirrors the Python: strip '+1' and spaces, keep digits, prefix +1 only on a
 * 10-digit result -- anything else is passed through unchanged rather than
 * mangled into a partial number.
 */
function normalizePhone(value) {
  if (value === null || value === undefined) return undefined;
  const original = String(value).trim();
  if (!original) return undefined;
  const digits = original.replace(/^\+1/, '').replace(/\s/g, '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : original;
}

/** Treat null/undefined/'' (and whitespace-only) as absent. */
function present(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

/**
 * Use_of_Funds__c is a RESTRICTED single-select picklist. Salesforce rejects
 * the whole insert on any value outside this set, so these 15 strings are the
 * only things that may ever be written to it -- exact capitalization, exact
 * ` / ` punctuation.
 */
const USE_OF_FUNDS_VALUES = [
  'Marketing',
  'Inventory',
  'Hiring',
  'Expansion',
  'Emergency',
  'Other',
  'Not Sure',
  'Equipment Purchase',
  'Finance Accounts Receivable',
  'Marketing / Sales',
  'Payroll',
  'Purchase Vehicles',
  'Remodel Building',
  'Refinance Debts',
  'Working Capital / Cash Flow',
];

/**
 * Ordered phrase rules. First match wins, so the specific cases come before the
 * general ones -- "marketing and sales" must reach 'Marketing / Sales' before
 * the bare "marketing" rule claims it.
 *
 * Word-boundary regexes rather than substring checks: short tokens like "ar",
 * "ads", and "car" would otherwise match inside "marketing" and "captured".
 */
const USE_OF_FUNDS_RULES = [
  [/\bmarketing\s*(?:\/|&|\+|and|or)\s*sales\b|\bsales\s*(?:\/|&|\+|and|or)\s*marketing\b/, 'Marketing / Sales'],
  [/\bworking\s*capital\b|\bcash\s*flow\b|\bcashflow\b/, 'Working Capital / Cash Flow'],
  [/\baccounts?\s+receivable\b|\breceivables?\b|\binvoices?\b|\binvoicing\b|\bfactoring\b|\bar\b/, 'Finance Accounts Receivable'],
  [/\bequipment\b|\bmachiner(?:y|ies)\b|\bmachines?\b/, 'Equipment Purchase'],
  [/\bpayroll\b/, 'Payroll'],
  [/\bvehicles?\b|\btrucks?\b|\bfleet\b|\bcars?\b|\bvans?\b/, 'Purchase Vehicles'],
  [/\bremodel(?:ing|ling)?\b|\brenovat(?:e|es|ion|ions|ing)\b|\bbuild[-\s]?out\b|\bbuildout\b|\brefurbish\w*\b/, 'Remodel Building'],
  [/\brefinanc\w*\b|\brefi\b|\bpay(?:ing|\s+off)?\s+off?\s+\w*debt\w*\b|\bconsolidat\w*\b|\bdebts?\b|\bloans?\b/, 'Refinance Debts'],
  [/\binventor(?:y|ies)\b|\brestock\w*\b|\bstock\b/, 'Inventory'],
  [/\bhir(?:e|es|ing)\b|\bstaff\w*\b|\bemployees?\b|\brecruit\w*\b/, 'Hiring'],
  [/\bexpansions?\b|\bexpand\w*\b|\bgrow(?:th|ing)?\b|\b(?:new|second|another)\s+(?:location|store|shop|branch)\b/, 'Expansion'],
  [/\bemergenc(?:y|ies)\b|\burgent\w*\b|\bunexpected\b/, 'Emergency'],
  [/\bmarketing\b|\badvertis\w*\b|\bads?\b|\bpromotions?\b/, 'Marketing'],
  [/\bnot\s+sure\b|\bunsure\b|\bdo(?:n'?t|\s+not)\s+know\b/, 'Not Sure'],
  [/\bother\b|\bmiscellaneous\b/, 'Other'],
];

/**
 * Normalize the bot's free-text purpose onto one of the 15 allowed picklist
 * values. Anything that cannot be matched confidently becomes 'Other' -- a raw
 * unmapped string must NEVER reach Salesforce, because it fails the whole Lead
 * insert rather than just the one field.
 *
 * @param {string} raw whatever the model reported as loanPurpose
 * @returns {string} one of USE_OF_FUNDS_VALUES, always
 */
function normalizeUseOfFunds(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'Other';

  // Already a canonical value (any casing) -- return the canonical spelling.
  const exact = USE_OF_FUNDS_VALUES.find(
    (value) => value.toLowerCase() === text.toLowerCase(),
  );
  if (exact) return exact;

  const haystack = text.toLowerCase();
  for (const [pattern, canonical] of USE_OF_FUNDS_RULES) {
    if (pattern.test(haystack)) return canonical;
  }

  // Info-level, so CloudWatch shows which phrasings turn up and the rules
  // above can be extended.
  console.log(
    `[salesforce] loanPurpose "${text}" matched no Use_of_Funds__c value; using "Other"`,
  );
  return 'Other';
}

/**
 * Map the chatbot's collected fields onto Lead field API names.
 * Only fields with a value are included, except the two required fallbacks.
 * Exported for the dry-run test.
 */
function buildLeadPayload(fields = {}) {
  const lead = {};

  if (present(fields.firstName)) lead.FirstName = String(fields.firstName).trim();

  // Required by Salesforce.
  lead.LastName = present(fields.lastName) ? String(fields.lastName).trim() : LAST_NAME_FALLBACK;

  if (present(fields.email)) lead.Email = String(fields.email).trim();

  const phone = normalizePhone(fields.phone);
  if (phone) lead.Phone = phone;

  // Required by Salesforce for a business Lead.
  lead.Company = present(fields.businessName)
    ? String(fields.businessName).trim()
    : COMPANY_FALLBACK;

  // Channel attribution -- always set. LeadSource is create-only by convention
  // in this org (see the Python handler's comment): never PATCH it later.
  lead.LeadSource = LEAD_SOURCE;
  lead.cvr_id__c = CVR_ID;

  // Free-text fields in this org -- no picklist translation needed.
  if (present(fields.monthlyRevenue)) {
    lead.Average_Monthly_Revenue_Text2__c = String(fields.monthlyRevenue).trim();
  }
  if (present(fields.timeInBusiness)) {
    lead.How_long_have_you_been_in_business__c = String(fields.timeInBusiness).trim();
  }

  // How much they asked for -- distinct from monthly revenue above, which is
  // what the business takes in. These must never end up in the same field.
  if (present(fields.fundingAmount)) {
    lead.Funding_Amount__c = String(fields.fundingAmount).trim();
  }

  // Restricted picklist: free text is normalized, never passed through. An
  // absent purpose omits the field entirely -- we do not default a missing
  // purpose to "Other", only an unrecognized one.
  const rawPurpose = Array.isArray(fields.loanPurpose)
    ? fields.loanPurpose.find((item) => present(item))
    : fields.loanPurpose;
  if (present(rawPurpose)) {
    lead.Use_of_Funds__c = normalizeUseOfFunds(rawPurpose);
  }

  return lead;
}

/**
 * Pull the surviving record id out of a DUPLICATES_DETECTED error body.
 * Ported from the Python create_lead fallback. Returns null when the shape
 * does not match, so the caller can fall through to a hard failure.
 */
function extractDuplicateId(errorBody) {
  if (!Array.isArray(errorBody)) return null;
  for (const err of errorBody) {
    if (!err || err.errorCode !== 'DUPLICATES_DETECTED') continue;
    const matchRecords =
      err.duplicateResult &&
      Array.isArray(err.duplicateResult.matchResults) &&
      err.duplicateResult.matchResults[0] &&
      err.duplicateResult.matchResults[0].matchRecords;
    if (Array.isArray(matchRecords) && matchRecords[0] && matchRecords[0].record) {
      const id = matchRecords[0].record.Id;
      if (id) return id;
    }
  }
  return null;
}

/**
 * POST the Lead.
 * @returns {Promise<{id: string, duplicate?: boolean}>}
 */
async function createLead(instanceUrl, accessToken, leadPayload) {
  const res = await fetch(`${instanceUrl}/services/data/${SF_API_VERSION}/sobjects/Lead/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      // Salesforce duplicate rules otherwise surface as an HTTP 500 to the
      // caller. allowSave lets the insert through; the DUPLICATES_DETECTED
      // fallback below is the belt-and-braces path.
      'Sforce-Duplicate-Rule-Header': 'allowSave=true',
    },
    body: JSON.stringify(leadPayload),
    // Same deadline as the token call above.
    signal: AbortSignal.timeout(SF_FETCH_TIMEOUT_MS),
  });

  const text = await res.text();

  if (res.ok) {
    const result = JSON.parse(text);
    if (!result.id) throw new Error(`Lead create returned no id: ${text}`);
    return { id: result.id };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // Fall through to the hard failure below.
  }

  const duplicateId = extractDuplicateId(parsed);
  if (duplicateId) {
    return { id: duplicateId, duplicate: true };
  }

  throw new Error(`Lead create failed (HTTP ${res.status}): ${text}`);
}

/**
 * Auth + create + dedupe. Throws on hard failure so the caller can log it.
 *
 * The caller is responsible for only invoking this on handoff === true; this
 * module deliberately contains no industry or eligibility logic of its own.
 *
 * @param {object} fields firstName, lastName, email, phone, businessName,
 *                        monthlyRevenue, timeInBusiness
 * @returns {Promise<{id: string, duplicate?: boolean}>}
 */
async function createChatbotLead(fields) {
  const leadPayload = buildLeadPayload(fields);
  const auth = await getSfToken();
  return createLead(auth.instance_url, auth.access_token, leadPayload);
}

export {
  createChatbotLead,
  // Auth seam for conversation.js, which is a second consumer of the same
  // Connected App and integration user.
  getSfToken,
  invalidateSfToken,
  integrationUserId,
  TOKEN_REFRESH_MARGIN_MS,
  JWT_TTL_SECONDS,
  // Exported for tests / inspection only.
  buildLeadPayload,
  createJwt,
  normalizePhone,
  extractDuplicateId,
  normalizeUseOfFunds,
  USE_OF_FUNDS_VALUES,
  SF_API_VERSION,
  SF_TOKEN_URL,
  SF_FETCH_TIMEOUT_MS,
};
