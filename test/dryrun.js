/**
 * Dry-run inspection for salesforce.js. Makes NO network calls and never reads
 * the real SF_PRIVATE_KEY.
 *
 *   node test/dryrun.js
 *
 * What it proves:
 *   1. The JWT header + claim shape match what Salesforce's JWT bearer flow wants.
 *   2. The signature is produced by Node's crypto (no openssl, no jwt library) --
 *      verified against an ephemeral throwaway keypair generated in-process.
 *   3. The exact Lead payload that would be POSTed, for several input shapes.
 *   4. Phone normalization and the DUPLICATES_DETECTED parser behave as ported.
 */

import crypto from "node:crypto";
import assert from "node:assert";

// Hard guard: fail loudly if anything in this file tries to reach the network.
globalThis.fetch = () => {
  throw new Error('DRY RUN: network access attempted. No live call is allowed here.');
};

import * as sf from "../salesforce.js";

const line = (t) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

// ---------------------------------------------------------------------------
line('1. JWT -- ephemeral throwaway key, NOT the production SF_PRIVATE_KEY');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// Fixed clock so the printed claims are reproducible.
const FIXED_NOW = 1767225600; // 2026-01-01T00:00:00Z

const { jwt, header, claims } = sf.createJwt({
  clientId: '3MVG9EXAMPLE_CONSUMER_KEY_NOT_REAL',
  username: 'laya+leadapi@spartancapitalgroup.com.prod',
  privateKeyPem: privateKey,
  now: FIXED_NOW,
});

console.log('header:', JSON.stringify(header));
console.log('claims:', JSON.stringify(claims, null, 2));
console.log(`exp - iat = ${claims.exp - FIXED_NOW}s`);

const [h64, c64, s64] = jwt.split('.');
assert.deepStrictEqual(JSON.parse(Buffer.from(h64, 'base64url')), { alg: 'RS256', typ: 'JWT' });
assert.strictEqual(claims.aud, 'https://login.salesforce.com');
assert.strictEqual(jwt.split('.').length, 3, 'JWT must have 3 segments');
assert.ok(!/=/.test(jwt), 'base64url segments must be unpadded');

const verifier = crypto.createVerify('RSA-SHA256');
verifier.update(`${h64}.${c64}`);
verifier.end();
assert.ok(verifier.verify(publicKey, Buffer.from(s64, 'base64url')), 'RS256 signature must verify');
console.log('\nsignature: RS256 verified against the throwaway public key  [OK]');
console.log(`segments: header=${h64.length}b claims=${c64.length}b sig=${s64.length}b`);
console.log('token endpoint:', sf.SF_TOKEN_URL);
console.log('grant_type:    urn:ietf:params:oauth:grant-type:jwt-bearer');

// ---------------------------------------------------------------------------
line('2. Lead payload -- exactly what would be POSTed');

console.log(`POST {instance_url}/services/data/${sf.SF_API_VERSION}/sobjects/Lead/`);
console.log('Headers: Authorization: Bearer <token>');
console.log('         Content-Type: application/json');
console.log('         Sforce-Duplicate-Rule-Header: allowSave=true\n');

const cases = [
  {
    name: 'A. Full conversation -- every field collected',
    fields: {
      firstName: 'Maria',
      lastName: 'Delgado',
      email: 'maria@delgadohvac.com',
      phone: '(305) 555-0142',
      businessName: 'Delgado HVAC LLC',
      monthlyRevenue: '$40,000 - $60,000',
      timeInBusiness: '3 years',
    },
  },
  {
    name: 'B. Sparse -- visitor gave only a first name and phone',
    fields: { firstName: 'Dave', phone: '3055550142' },
  },
  {
    name: 'C. Empty strings and whitespace -- treated as absent',
    fields: { firstName: '  ', lastName: '', email: '   ', phone: '', businessName: '  ' },
  },
  {
    name: 'D. Already E.164 / 11-digit / short -- passthrough behavior',
    fields: { lastName: 'Okafor', businessName: 'Okafor Freight', phone: '+13055550142' },
  },
  {
    name: 'E. THE COLLISION CASE -- revenue and funding amount are separate fields',
    fields: {
      firstName: 'Dana',
      lastName: 'Whitfield',
      email: 'dana@ridgelinehvac.com',
      phone: '(216) 555-0142',
      businessName: 'Ridgeline HVAC',
      monthlyRevenue: '$50,000/month',   // what the business takes in
      timeInBusiness: '4 years',
      fundingAmount: '$75,000',          // what they asked for
      loanPurpose: 'working capital',
    },
  },
];

for (const c of cases) {
  console.log(`--- ${c.name}`);
  console.log('    input:  ', JSON.stringify(c.fields));
  console.log('    payload:', JSON.stringify(sf.buildLeadPayload(c.fields), null, 2).replace(/\n/g, '\n     '));
  console.log('');
}

// Invariants that must hold for every payload.
for (const c of cases) {
  const p = sf.buildLeadPayload(c.fields);
  assert.strictEqual(p.LeadSource, 'Chatbot');
  assert.strictEqual(p.cvr_id__c, 'chatbot_scg');
  assert.ok(p.LastName && p.LastName.trim(), 'LastName must always be populated');
  assert.ok(p.Company && p.Company.trim(), 'Company must always be populated');
  for (const [k, v] of Object.entries(p)) {
    assert.ok(v !== '' && v !== null && v !== undefined, `${k} must not be empty`);
  }
}
assert.strictEqual(sf.buildLeadPayload(cases[2].fields).LastName, 'Chatbot Lead');
assert.strictEqual(sf.buildLeadPayload(cases[2].fields).Company, 'Unknown (Chatbot Lead)');
assert.ok(!('FirstName' in sf.buildLeadPayload(cases[2].fields)), 'blank FirstName must be omitted');
assert.ok(!('Email' in sf.buildLeadPayload(cases[1].fields)), 'absent Email must be omitted');
console.log('payload invariants: LeadSource/cvr_id__c always set, no empty keys, fallbacks applied  [OK]');

// The collision that model-reported fields exist to prevent: revenue and the
// requested amount must land in different Salesforce fields, never merged.
{
  const p = sf.buildLeadPayload(cases[4].fields);
  assert.strictEqual(p.Average_Monthly_Revenue_Text2__c, '$50,000/month');
  assert.strictEqual(p.Funding_Amount__c, '$75,000');
  assert.strictEqual(p.How_long_have_you_been_in_business__c, '4 years');
  assert.strictEqual(p.Use_of_Funds__c, 'Working Capital / Cash Flow');
  assert.notStrictEqual(p.Average_Monthly_Revenue_Text2__c, p.Funding_Amount__c);
  console.log('collision case: revenue -> Average_Monthly_Revenue_Text2__c, ' +
    'amount -> Funding_Amount__c, never merged  [OK]');
}

// loanPurpose as an array (the shape the old regex extractor produced): the
// first meaningful element is normalized -- an array can't be joined, because
// the picklist is single-select.
assert.strictEqual(
  sf.buildLeadPayload({ loanPurpose: ['equipment', 'inventory'] }).Use_of_Funds__c,
  'Equipment Purchase',
);
assert.ok(!('Use_of_Funds__c' in sf.buildLeadPayload({ loanPurpose: [] })),
  'empty loanPurpose array must be omitted');
assert.ok(!('Funding_Amount__c' in sf.buildLeadPayload({ fundingAmount: '  ' })),
  'blank fundingAmount must be omitted');
console.log('loanPurpose array -> first element normalized to "Equipment Purchase"  [OK]');

// ---------------------------------------------------------------------------
line('5. Use_of_Funds__c -- restricted picklist normalization');

console.log('The field accepts ONLY these 15 values:');
console.log('  ' + sf.USE_OF_FUNDS_VALUES.join(' | ') + '\n');

const purposeCases = [
  // [input, expected canonical]
  ['working capital', 'Working Capital / Cash Flow'],
  ['cash flow', 'Working Capital / Cash Flow'],
  ['cashflow gap over the winter', 'Working Capital / Cash Flow'],
  ['buy some equipment', 'Equipment Purchase'],
  ['new machinery for the shop', 'Equipment Purchase'],
  ['refinance my existing loans', 'Refinance Debts'],
  ['consolidate debt', 'Refinance Debts'],
  ['payroll', 'Payroll'],
  ['cover payroll this month', 'Payroll'],
  ['marketing', 'Marketing'],
  ['advertising and ads', 'Marketing'],
  ['marketing and sales', 'Marketing / Sales'],
  ['sales / marketing push', 'Marketing / Sales'],
  ['inventory', 'Inventory'],
  ['restock the store', 'Inventory'],
  ['hiring', 'Hiring'],
  ['hire two more employees', 'Hiring'],
  ['expansion', 'Expansion'],
  ['open a second location', 'Expansion'],
  ['emergency repair', 'Emergency'],
  ['urgent unexpected bill', 'Emergency'],
  ['buy a delivery truck', 'Purchase Vehicles'],
  ['fleet vehicles', 'Purchase Vehicles'],
  ['remodel the building', 'Remodel Building'],
  ['renovation / build out', 'Remodel Building'],
  ['accounts receivable', 'Finance Accounts Receivable'],
  ['financing unpaid invoices', 'Finance Accounts Receivable'],
  ['not sure yet', 'Not Sure'],
  // Exact canonical values in, unchanged out (any casing).
  ['Payroll', 'Payroll'],
  ['Working Capital / Cash Flow', 'Working Capital / Cash Flow'],
  ['equipment purchase', 'Equipment Purchase'],
  ['NOT SURE', 'Not Sure'],
  // Fallback -- never the raw text.
  ['something weird the bot captured', 'Other'],
  ['', 'Other'],
];

for (const [input, expected] of purposeCases) {
  const got = sf.normalizeUseOfFunds(input);
  assert.strictEqual(got, expected, `normalizeUseOfFunds(${JSON.stringify(input)})`);
  console.log(`  ${JSON.stringify(input).padEnd(38)} -> "${got}"`);
}

// Every output must be inside the allowed set, for any input at all.
const fuzz = [
  'asdfghjkl', '12345', '!!!', 'the quick brown fox', 'captured', 'cars and stars',
  null, undefined, 42, {}, [], 'Marketing / Sales', 'x'.repeat(500),
];
for (const input of [...purposeCases.map(([i]) => i), ...fuzz]) {
  const got = sf.normalizeUseOfFunds(input);
  assert.ok(sf.USE_OF_FUNDS_VALUES.includes(got),
    `normalizeUseOfFunds(${JSON.stringify(input)}) returned "${got}", outside the allowed set`);
  const payload = sf.buildLeadPayload({ loanPurpose: input });
  if ('Use_of_Funds__c' in payload) {
    assert.ok(sf.USE_OF_FUNDS_VALUES.includes(payload.Use_of_Funds__c),
      `buildLeadPayload emitted "${payload.Use_of_Funds__c}", outside the allowed set`);
  }
}
console.log('\nevery output (incl. fuzz + nullish + non-strings) is inside the 15-value set  [OK]');

// Absent purpose -> field omitted entirely, NOT defaulted to "Other".
for (const fields of [{}, { loanPurpose: undefined }, { loanPurpose: null },
                      { loanPurpose: '' }, { loanPurpose: '   ' }, { loanPurpose: [] }]) {
  assert.ok(!('Use_of_Funds__c' in sf.buildLeadPayload(fields)),
    `absent purpose must omit the field, got ${JSON.stringify(sf.buildLeadPayload(fields))}`);
}
console.log('absent/blank purpose -> Use_of_Funds__c omitted entirely, never "Other"  [OK]');

// ---------------------------------------------------------------------------
line('3. Phone normalization (ported from the Python)');

const phones = [
  ['(305) 555-0142', '+13055550142'],
  ['3055550142', '+13055550142'],
  ['305.555.0142', '+13055550142'],
  ['+1 305 555 0142', '+13055550142'],
  ['+13055550142', '+13055550142'],
  ['555-0142', '555-0142'],            // 7 digits -> unchanged, not mangled
  ['+44 20 7946 0958', '+44 20 7946 0958'], // non-US -> unchanged
  ['', undefined],
  [null, undefined],
];
for (const [input, expected] of phones) {
  const got = sf.normalizePhone(input);
  assert.strictEqual(got, expected, `normalizePhone(${JSON.stringify(input)})`);
  console.log(`  ${JSON.stringify(input).padEnd(20)} -> ${JSON.stringify(got)}`);
}

// ---------------------------------------------------------------------------
line('4. DUPLICATES_DETECTED fallback');

const dupBody = [{
  errorCode: 'DUPLICATES_DETECTED',
  message: 'You are creating a duplicate record.',
  duplicateResult: {
    matchResults: [{ matchRecords: [{ record: { Id: '00QVr00000EXAMPLE1' } }] }],
  },
}];
assert.strictEqual(sf.extractDuplicateId(dupBody), '00QVr00000EXAMPLE1');
console.log('  duplicate body           -> 00QVr00000EXAMPLE1  (returned as { duplicate: true })');

assert.strictEqual(sf.extractDuplicateId([{ errorCode: 'REQUIRED_FIELD_MISSING' }]), null);
console.log('  unrelated error          -> null  (falls through to a thrown hard failure)');
assert.strictEqual(sf.extractDuplicateId([{ errorCode: 'DUPLICATES_DETECTED', duplicateResult: {} }]), null);
console.log('  malformed duplicate body -> null  (falls through to a thrown hard failure)');
assert.strictEqual(sf.extractDuplicateId(null), null);
console.log('  non-array body           -> null');

// ---------------------------------------------------------------------------
line('DRY RUN COMPLETE -- all assertions passed, zero network calls');
console.log('The production SF_PRIVATE_KEY was never read.');
