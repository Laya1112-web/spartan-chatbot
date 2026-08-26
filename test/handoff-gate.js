/**
 * Proves the handoff gate. No network, no Salesforce -- createLead is injected.
 *
 *   node test/handoff-gate.js
 *
 * The central claim under test: no Lead is created unless handoff === true,
 * which is what keeps the upstream excluded-industry suppression effective.
 */

import assert from "node:assert";
import crypto from "node:crypto";

globalThis.fetch = () => {
  throw new Error('GATE TEST: network access attempted.');
};

import { maybeCreateLead, mapHandoffFields } from "../leadHandoff.js";
import { buildLeadPayload, SF_FETCH_TIMEOUT_MS } from "../salesforce.js";
import { parseStatusTag, parseLeadBlock } from "../index.js";
import { recoverContactFields } from "../intent.js";

const quiet = { log() {}, error() {} };

/** Records every call so we can assert on invocation count, not just output. */
function spy(impl) {
  const calls = [];
  const fn = async (fields) => {
    calls.push(fields);
    return impl(fields);
  };
  fn.calls = calls;
  return fn;
}

const ok = (id, duplicate = false) =>
  spy(async () => ({ id, ...(duplicate && { duplicate: true }) }));
const boom = (msg) => spy(async () => { throw new Error(msg); });

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}

async function main() {
  console.log('\nHANDOFF = FALSE / ABSENT  -> must create NOTHING\n');

  const noLeadCases = [
    ['handoff: false (excluded industry -- dispensary, pawn shop, etc.)',
      { handoff: false, handoffFields: { businessName: 'Green Leaf Dispensary' }, sessionId: 's1' }],
    ['handoff: undefined', { handoff: undefined, handoffFields: { firstName: 'A' }, sessionId: 's2' }],
    ['handoff key absent entirely', { handoffFields: { firstName: 'B' }, sessionId: 's3' }],
    ['handoff: null', { handoff: null, sessionId: 's4' }],
    ['handoff: "true" (string, not boolean)',
      { handoff: 'true', handoffFields: { firstName: 'C' }, sessionId: 's5' }],
    ['handoff: 1 (truthy number, not boolean)',
      { handoff: 1, handoffFields: { firstName: 'D' }, sessionId: 's6' }],
    ['turn is an empty object', {}],
    ['turn is undefined', undefined],
  ];

  for (const [label, turn] of noLeadCases) {
    const createLead = ok('00QSHOULD_NOT_EXIST');
    const out = await maybeCreateLead(turn, { createLead, logger: quiet });
    check(`${label} -> createLead called 0 times, no leadId`,
      createLead.calls.length === 0 &&
      out.leadId === undefined &&
      Object.keys(out).length === 0);
  }

  console.log('\nHANDOFF = TRUE  -> creates exactly one lead\n');

  {
    const fields = { firstName: 'Maria', lastName: 'Delgado', businessName: 'Delgado HVAC LLC' };
    const createLead = ok('00QVr00000NEWLEAD1');
    const out = await maybeCreateLead(
      { handoff: true, handoffFields: fields, sessionId: 's7' }, { createLead, logger: quiet });
    check('handoff: true -> createLead called exactly once', createLead.calls.length === 1);
    check('handoff: true -> receives handoffFields verbatim',
      JSON.stringify(createLead.calls[0]) === JSON.stringify(fields));
    check('handoff: true -> returns leadId', out.leadId === '00QVr00000NEWLEAD1');
    check('handoff: true -> no duplicate flag on a fresh create', out.duplicate === undefined);
  }

  {
    const createLead = ok('00QVr00000EXISTING', true);
    const out = await maybeCreateLead(
      { handoff: true, handoffFields: { email: 'dup@x.com' }, sessionId: 's8' },
      { createLead, logger: quiet });
    check('duplicate match -> returns the existing id with duplicate: true',
      out.leadId === '00QVr00000EXISTING' && out.duplicate === true);
    check('duplicate match -> still only one create attempt', createLead.calls.length === 1);
  }

  {
    const createLead = ok('00QVr00000NOFIELDS');
    const out = await maybeCreateLead(
      { handoff: true, sessionId: 's9' }, { createLead, logger: quiet });
    check('handoff: true with no handoffFields -> defaults to {} and still creates',
      createLead.calls.length === 1 &&
      JSON.stringify(createLead.calls[0]) === '{}' &&
      out.leadId === '00QVr00000NOFIELDS');
  }

  console.log('\nSALESFORCE FAILURE  -> swallowed, visitor unaffected\n');

  for (const msg of [
    "Salesforce auth failed: invalid_grant: user hasn't approved this consumer",
    'Lead create failed (HTTP 400): [{"errorCode":"REQUIRED_FIELD_MISSING"}]',
    'fetch failed',
  ]) {
    const createLead = boom(msg);
    let threw = false;
    let out;
    try {
      out = await maybeCreateLead(
        { handoff: true, handoffFields: { firstName: 'E' }, sessionId: 's10' },
        { createLead, logger: quiet });
    } catch (_) {
      threw = true;
    }
    check(`throw "${msg.slice(0, 42)}..." -> does NOT propagate, returns {}`,
      !threw && out && out.leadId === undefined && Object.keys(out).length === 0);
  }

  {
    // The failure must actually be logged, not silently dropped.
    const logged = [];
    const createLead = boom('boom');
    const out = await maybeCreateLead(
      { handoff: true, handoffFields: { firstName: 'F' }, sessionId: 's11' },
      { createLead, logger: { log() {}, error: (m) => logged.push(m) } });
    check('failure is logged to stderr (CloudWatch) with the session id',
      logged.length === 2 && logged[0].includes('SALESFORCE WRITE FAILED') && logged[0].includes('s11'));
    check('failure log includes the unsaved fields for manual replay',
      logged[1].includes('"firstName":"F"'));
    check('failure still returns {}', Object.keys(out).length === 0);
  }

  console.log('\nFIELD ADAPTER  -> intent.js shape mapped onto salesforce.js shape\n');

  {
    const mapped = mapHandoffFields({ name: 'Maria Delgado' });
    check('"Maria Delgado" -> firstName Maria, lastName Delgado',
      mapped.firstName === 'Maria' && mapped.lastName === 'Delgado');
  }

  {
    const mapped = mapHandoffFields({ name: 'Dave' });
    check('single-token "Dave" -> firstName Dave, lastName unset',
      mapped.firstName === 'Dave' && mapped.lastName === undefined);
    check('single-token "Dave" -> salesforce.js LastName fallback fills in',
      buildLeadPayload(mapped).LastName === 'Chatbot Lead' &&
      buildLeadPayload(mapped).FirstName === 'Dave');
  }

  {
    const mapped = mapHandoffFields({ name: 'Ana Maria Ruiz Diaz' });
    check('three+ tokens -> remainder joined into lastName',
      mapped.firstName === 'Ana' && mapped.lastName === 'Maria Ruiz Diaz');
  }

  {
    const mapped = mapHandoffFields({ name: '   Dana    Whitfield   ' });
    check('extra whitespace in name is normalized',
      mapped.firstName === 'Dana' && mapped.lastName === 'Whitfield');
  }

  for (const [label, name] of [['whitespace-only', '   '], ['empty', ''], ['absent', undefined]]) {
    const mapped = mapHandoffFields({ name });
    check(`${label} name -> neither firstName nor lastName set`,
      mapped.firstName === undefined && mapped.lastName === undefined);
  }

  {
    // The exact shape intent.js produces today.
    const intentFields = {
      name: 'Dana Whitfield',
      email: 'dana@ridgelinehvac.com',
      phone: '(216) 555-0142',
      businessName: 'Ridgeline HVAC',
      loanAmount: '$75,000',
      loanPurpose: ['working capital'],
    };
    const mapped = mapHandoffFields(intentFields);
    check('pass-through fields survive: email, phone, businessName',
      mapped.email === 'dana@ridgelinehvac.com' &&
      mapped.phone === '(216) 555-0142' &&
      mapped.businessName === 'Ridgeline HVAC');
    // `loanAmount` was the old regex key that conflated revenue with the
    // amount requested; it stays unmapped. loanPurpose now maps through.
    check('legacy loanAmount stays unmapped; loanPurpose now maps through',
      !('loanAmount' in mapped) &&
      JSON.stringify(mapped.loanPurpose) === JSON.stringify(['working capital']) &&
      Object.keys(mapped).sort().join(',') ===
        'businessName,email,firstName,lastName,loanPurpose,phone');

    // End-to-end: the real intent.js shape produces a valid Lead payload.
    const payload = buildLeadPayload(mapped);
    check('full intent.js shape -> valid Lead payload',
      payload.FirstName === 'Dana' &&
      payload.LastName === 'Whitfield' &&
      payload.Email === 'dana@ridgelinehvac.com' &&
      payload.Phone === '+12165550142' &&
      payload.Company === 'Ridgeline HVAC' &&
      payload.LeadSource === 'Chatbot');
  }

  {
    const mapped = mapHandoffFields({ firstName: 'Pre', lastName: 'Split' });
    check('already-split firstName/lastName pass through untouched',
      mapped.firstName === 'Pre' && mapped.lastName === 'Split');
  }

  {
    const mapped = mapHandoffFields({ monthlyRevenue: '$45,000', timeInBusiness: '4 years' });
    check('monthlyRevenue / timeInBusiness map through when present',
      mapped.monthlyRevenue === '$45,000' && mapped.timeInBusiness === '4 years');
  }

  {
    check('empty and nullish input -> empty mapping, no invented keys',
      Object.keys(mapHandoffFields({})).length === 0 &&
      Object.keys(mapHandoffFields(undefined)).length === 0 &&
      Object.keys(mapHandoffFields(null)).length === 0);
  }

  {
    // The gate must hand the ADAPTED shape to Salesforce, not the raw one.
    const createLead = ok('00QVr00000ADAPTED1');
    await maybeCreateLead(
      {
        handoff: true,
        sessionId: 's12',
        handoffFields: { name: 'Maria Delgado', email: 'm@x.com', loanAmount: '$50,000' },
      },
      { createLead, logger: quiet });
    check('maybeCreateLead calls createLead with the adapted shape',
      createLead.calls.length === 1 &&
      createLead.calls[0].firstName === 'Maria' &&
      createLead.calls[0].lastName === 'Delgado' &&
      createLead.calls[0].name === undefined &&
      createLead.calls[0].loanAmount === undefined);
  }

  {
    // On failure the RAW fields are logged, so unmapped data is still replayable.
    const logged = [];
    const createLead = boom('boom');
    await maybeCreateLead(
      {
        handoff: true,
        sessionId: 's13',
        handoffFields: { name: 'Maria Delgado', loanAmount: '$50,000' },
      },
      { createLead, logger: { log() {}, error: (m) => logged.push(m) } });
    check('failure log keeps unmapped loanAmount for replay',
      logged[1].includes('"loanAmount":"$50,000"') && logged[1].includes('"name":"Maria Delgado"'));
  }

  console.log('\nSCG_LEAD BLOCK  -> model-reported fields, parsed and stripped\n');

  {
    const reply =
      "Great, thanks Dana — I'll pass this to a funding specialist who'll reach out shortly.\n\n" +
      '[[SCG_STATUS: OK]]\n' +
      '[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield","email":"dana@ridgelinehvac.com",' +
      '"phone":"(216) 555-0142","businessName":"Ridgeline HVAC","monthlyRevenue":"$50,000/month",' +
      '"timeInBusiness":"4 years","fundingAmount":"$75,000","loanPurpose":"working capital"}]]';

    const status = parseStatusTag(reply);
    const lead = parseLeadBlock(status.text);

    check('SCG_LEAD: both tags stripped from the visitor-facing reply',
      !/SCG_STATUS|SCG_LEAD/i.test(lead.text) &&
      lead.text === "Great, thanks Dana — I'll pass this to a funding specialist who'll reach out shortly.");
    check('SCG_LEAD: all nine reported fields parsed',
      Object.keys(lead.fields).length === 9 &&
      lead.fields.firstName === 'Dana' &&
      lead.fields.fundingAmount === '$75,000' &&
      lead.fields.monthlyRevenue === '$50,000/month');

    // THE COLLISION CASE, end to end: revenue and amount to separate fields.
    const payload = buildLeadPayload(mapHandoffFields(lead.fields));
    check('collision case: revenue -> Average_Monthly_Revenue_Text2__c',
      payload.Average_Monthly_Revenue_Text2__c === '$50,000/month');
    check('collision case: fundingAmount -> Funding_Amount__c',
      payload.Funding_Amount__c === '$75,000');
    check('collision case: the two never share a field',
      payload.Average_Monthly_Revenue_Text2__c !== payload.Funding_Amount__c);
    check('SCG_LEAD -> loanPurpose normalized into the Use_of_Funds__c picklist',
      payload.Use_of_Funds__c === 'Working Capital / Cash Flow');
    check('SCG_LEAD -> timeInBusiness lands in How_long_have_you_been_in_business__c',
      payload.How_long_have_you_been_in_business__c === '4 years');
  }

  {
    const lead = parseLeadBlock('Sure.\n[[SCG_LEAD: {"firstName":"Solo"}]]');
    check('partial block: only the reported key appears, nothing invented',
      Object.keys(lead.fields).length === 1 && lead.fields.firstName === 'Solo');
    check('partial block: LastName falls back to the Salesforce default',
      buildLeadPayload(mapHandoffFields(lead.fields)).LastName === 'Chatbot Lead');
  }

  {
    check('numeric value coerced to string',
      parseLeadBlock('x\n[[SCG_LEAD: {"fundingAmount":75000}]]').fields.fundingAmount === '75000');
    check('blank and unknown keys dropped',
      JSON.stringify(parseLeadBlock('x\n[[SCG_LEAD: {"firstName":"  ","evil":"drop me"}]]').fields) === '{}');
  }

  console.log('\nMALFORMED / ABSENT SCG_LEAD  -> no crash, no fields, clean reply\n');

  for (const [label, raw] of [
    ['invalid JSON', 'Here you go.\n[[SCG_LEAD: {"firstName":"Dana", oops}]]'],
    ['truncated JSON', 'Here you go.\n[[SCG_LEAD: {"firstName":"Dana"'],
    ['no JSON at all', 'Here you go.\n[[SCG_LEAD: ]]'],
    ['bare tag', 'Here you go.\nSCG_LEAD'],
    ['JSON array instead of object', 'Here you go.\n[[SCG_LEAD: ["nope"]]]'],
  ]) {
    const lead = parseLeadBlock(raw);
    check(`${label} -> {} fields, tag stripped, reply intact`,
      Object.keys(lead.fields).length === 0 &&
      !/SCG_LEAD/i.test(lead.text) &&
      lead.text.startsWith('Here you go.'));
  }

  {
    const lead = parseLeadBlock('Just a normal answer, no block here.');
    check('absent block -> {} fields, reply untouched',
      Object.keys(lead.fields).length === 0 &&
      lead.text === 'Just a normal answer, no block here.');
  }

  console.log('\nDECLINE + SCG_LEAD  -> the gate wins, no lead is created\n');

  {
    // A DECLINE turn that (against instructions) also emits a lead block.
    const raw =
      "Spartan isn't able to fund dispensaries.\n" +
      '[[SCG_STATUS: DECLINE]]\n' +
      '[[SCG_LEAD: {"firstName":"Casey","businessName":"Green Leaf Dispensary","fundingAmount":"$60,000"}]]';

    const status = parseStatusTag(raw);
    const lead = parseLeadBlock(status.text);

    check('DECLINE turn: status parsed as declined', status.declined === true);
    check('DECLINE turn: block still stripped from the reply',
      !/SCG_LEAD|SCG_STATUS/i.test(lead.text));

    // index.js only forwards fields when handoff is true; a DECLINE suppresses
    // the handoff, so the gate receives none regardless of what was emitted.
    const createLead = ok('00QSHOULD_NOT_EXIST');
    const out = await maybeCreateLead(
      { handoff: false, handoffFields: lead.fields, sessionId: 's14' },
      { createLead, logger: quiet });
    check('DECLINE turn: createLead never called even though fields were emitted',
      createLead.calls.length === 0 && Object.keys(out).length === 0);
  }

  console.log('\nFULL HANDLER  -> stubbed API, no network; covers the wiring itself\n');

  {
    // Parser-level tests cannot catch a broken reference in the handler body,
    // so drive the real handler with a canned model response.
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-dummy';
    const { handler } = await import("../index.js");

    const realFetch = globalThis.fetch;
    let modelText = '';
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
          content: [{ type: 'text', text: modelText }],
          stop_reason: 'end_turn', stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const invoke = async (text, messages) => {
      modelText = text;
      const res = await handler({
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://www.spartancapital.us' },
        body: JSON.stringify({ messages, sessionId: 'handler-test' }),
      });
      return { statusCode: res.statusCode, data: JSON.parse(res.body) };
    };

    const wantsSpecialist = [{ role: 'user', content: 'I want to talk to a funding specialist' }];
    const dispensary = [
      { role: 'user', content: 'I own a cannabis dispensary' },
      { role: 'assistant', content: "Spartan isn't able to fund cannabis businesses." },
      { role: 'user', content: 'I want to talk to someone anyway' },
    ];

    try {
      {
        // Name but no email or phone: the minimum gate now defers the write
        // rather than creating a contactless placeholder lead. The parsed
        // fields still come back so the next turn can build on them.
        const { statusCode, data } = await invoke(
          'Great — a specialist will reach out.\n[[SCG_STATUS: OK]]\n' +
          '[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield","monthlyRevenue":"$50,000/month","fundingAmount":"$75,000"}]]',
          wantsSpecialist);
        check('handler: name but no contact -> fields parsed, tags stripped',
          statusCode === 200 &&
          data.handoffFields.fundingAmount === '$75,000' &&
          data.handoffFields.monthlyRevenue === '$50,000/month' &&
          !/SCG_/i.test(data.reply));
        check('handler: name but no contact -> handoff deferred, no lead written',
          data.handoff === false && data.handoffDeferred === true &&
          !('leadId' in data));
      }

      {
        // Same turn plus a phone number clears the minimum and hands off.
        const { statusCode, data } = await invoke(
          'Great — a specialist will reach out.\n[[SCG_STATUS: OK]]\n' +
          '[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield","phone":"(216) 555-0142","fundingAmount":"$75,000"}]]',
          wantsSpecialist);
        check('handler: name + phone -> handoff turn, fields from the block, tags stripped',
          statusCode === 200 && data.handoff === true &&
          data.handoffDeferred === undefined &&
          data.handoffFields.fundingAmount === '$75,000' &&
          data.handoffFields.phone === '(216) 555-0142' &&
          !/SCG_/i.test(data.reply));
      }

      {
        const { statusCode, data } = await invoke(
          "Unfortunately Spartan isn't able to fund dispensaries.\n[[SCG_STATUS: DECLINE]]\n" +
          '[[SCG_LEAD: {"firstName":"Casey","fundingAmount":"$60,000"}]]',
          dispensary);
        check('handler: DECLINE turn -> 200 (not 500), handoff false, fields dropped',
          statusCode === 200 && data.handoff === false &&
          Object.keys(data.handoffFields).length === 0 &&
          !/SCG_/i.test(data.reply) && data.error === undefined);
      }

      {
        const { statusCode, data } = await invoke(
          'Happy to help.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Dana", oops}]]',
          wantsSpecialist);
        check('handler: malformed block -> 200, no fields, clean reply, no crash',
          statusCode === 200 &&
          Object.keys(data.handoffFields).length === 0 &&
          data.reply === 'Happy to help.' && data.error === undefined);
        check('handler: malformed block -> nothing collected, so no lead is written',
          data.handoff === false && data.handoffDeferred === true &&
          !('leadId' in data));
      }
      console.log('\nNARROW EMAIL+PHONE FALLBACK  -> fills gaps, never amounts\n');

      const NO_BLOCK = 'Sure, I can set that up.\n[[SCG_STATUS: OK]]';

      {
        // Block present but missing phone; phone is in the transcript.
        const { data } = await invoke(
          'Got it.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield",' +
          '"email":"dana@ridgelinehvac.com","businessName":"Ridgeline HVAC","fundingAmount":"$75,000"}]]',
          [{ role: 'user', content: 'I want to talk to a specialist. Call me at 216-555-0142.' }]);
        check('block missing phone -> phone recovered from transcript',
          data.handoff === true && data.handoffFields.phone === '(216) 555-0142');
        check('block missing phone -> every other block field untouched',
          data.handoffFields.firstName === 'Dana' &&
          data.handoffFields.lastName === 'Whitfield' &&
          data.handoffFields.email === 'dana@ridgelinehvac.com' &&
          data.handoffFields.businessName === 'Ridgeline HVAC' &&
          data.handoffFields.fundingAmount === '$75,000');
      }

      {
        // No block at all; the transcript holds contact details AND a name,
        // a business name, revenue and an amount. Only contact may be taken.
        const { data } = await invoke(NO_BLOCK, [{
          role: 'user',
          content: "I want to talk to someone. My name is Dana Whitfield, I run Ridgeline HVAC, " +
            'dana@ridgelinehvac.com, 216-555-0142. We do $50k/month revenue and need $75k.',
        }]);
        check('no block -> email and phone both recovered',
          data.handoffFields.email === 'dana@ridgelinehvac.com' &&
          data.handoffFields.phone === '(216) 555-0142');
        check('no block -> ONLY email and phone recovered, nothing else',
          Object.keys(data.handoffFields).sort().join(',') === 'email,phone');
        check('no block -> no name or businessName recovered even though both are in the text',
          data.handoffFields.firstName === undefined &&
          data.handoffFields.lastName === undefined &&
          data.handoffFields.businessName === undefined);
      }

      {
        // THE COLLISION MUST NOT RETURN through the fallback.
        const { data } = await invoke(NO_BLOCK, [{
          role: 'user',
          content: 'Please have someone call me. We do $50k/month revenue and need $75k for equipment. ' +
            'Reach me at 216-555-0142.',
        }]);
        check('collision proof: neither amount recovered by the fallback',
          data.handoffFields.monthlyRevenue === undefined &&
          data.handoffFields.fundingAmount === undefined &&
          data.handoffFields.loanAmount === undefined &&
          data.handoffFields.loanPurpose === undefined);
        check('collision proof: the phone still came through cleanly',
          data.handoffFields.phone === '(216) 555-0142' &&
          Object.keys(data.handoffFields).join(',') === 'phone');
      }

      {
        // Complete block: the fallback must not fire, and must not overwrite.
        const { data } = await invoke(
          'All set.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"email":"block@wins.com","phone":"(555) 555-0100"}]]',
          [{ role: 'user',
             content: 'Talk to a specialist please. Other details: other@transcript.com, 216-555-0142.' }]);
        check('complete block -> fallback does not fire, model values win',
          data.handoffFields.email === 'block@wins.com' &&
          data.handoffFields.phone === '(555) 555-0100' &&
          Object.keys(data.handoffFields).sort().join(',') === 'email,phone');
      }

      {
        // DECLINE: no fields, no recovery, and the gate still refuses a lead.
        const { statusCode, data } = await invoke(
          "Spartan isn't able to fund dispensaries.\n[[SCG_STATUS: DECLINE]]",
          [
            { role: 'user', content: 'I own a cannabis dispensary, dana@dispensary.com, 216-555-0142' },
            { role: 'assistant', content: "Spartan isn't able to fund cannabis businesses." },
            { role: 'user', content: 'I want to talk to someone anyway' },
          ]);
        check('DECLINE -> fallback never runs, no contact recovered',
          statusCode === 200 && data.handoff === false &&
          Object.keys(data.handoffFields).length === 0);

        const createLead = ok('00QSHOULD_NOT_EXIST');
        const out = await maybeCreateLead(
          { handoff: data.handoff, handoffFields: data.handoffFields, sessionId: 's15' },
          { createLead, logger: quiet });
        check('DECLINE -> still no lead created',
          createLead.calls.length === 0 && Object.keys(out).length === 0);
      }
      console.log('\nSALESFORCE TIMEOUT  -> lead logged, visitor still gets the reply\n');

      {
        // Reach the Salesforce fetch for real: getSfToken signs a JWT before it
        // calls out, so it needs a usable key or it throws before the network.
        const { privateKey } = crypto.generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        const savedEnv = {
          SF_CLIENT_ID: process.env.SF_CLIENT_ID,
          SF_USERNAME: process.env.SF_USERNAME,
          SF_PRIVATE_KEY: process.env.SF_PRIVATE_KEY,
        };
        process.env.SF_CLIENT_ID = '3MVG9TEST_NOT_REAL';
        process.env.SF_USERNAME = 'test@example.invalid';
        process.env.SF_PRIVATE_KEY = privateKey;

        // Route by host: Claude answers normally, Salesforce times out.
        const cannedFetch = globalThis.fetch;
        const sfAttempts = [];
        const logged = [];
        globalThis.fetch = async (url, init) => {
          if (String(url).includes('salesforce.com')) {
            sfAttempts.push(String(url));
            // Shape of a real AbortSignal.timeout rejection.
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
          }
          return cannedFetch(url, init);
        };
        const realError = console.error;
        console.error = (...args) => { logged.push(args.join(' ')); };

        try {
          modelText =
            'Great — a specialist will be in touch.\n[[SCG_STATUS: OK]]\n' +
            '[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield","email":"dana@x.com",' +
            '"phone":"(216) 555-0142","fundingAmount":"$75,000"}]]';
          const res = await handler({
            requestContext: { http: { method: 'POST' } },
            headers: { origin: 'https://www.spartancapital.us' },
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'I want to talk to a funding specialist' }],
              sessionId: 'sf-timeout',
            }),
          });
          const data = JSON.parse(res.body);

          // More than one attempt now: conversation.js also talks to Salesforce
          // (the pre-Claude live-mode check, and the post-lead transcript
          // sync), each starting with its own token call. What matters here is
          // that the LEAD path reached the network and that every attempt was
          // aimed at Salesforce.
          check('SF timeout: the Salesforce call was actually attempted',
            sfAttempts.length >= 1 &&
            sfAttempts.some((u) => u.includes('login.salesforce.com')) &&
            sfAttempts.every((u) => u.includes('salesforce.com')));
          check('SF timeout: handler still returns 200 with the visitor\'s reply',
            res.statusCode === 200 &&
            data.reply === 'Great — a specialist will be in touch.' &&
            data.error === undefined);
          check('SF timeout: handoff stays true and the fields are intact',
            data.handoff === true &&
            data.handoffFields.fundingAmount === '$75,000' &&
            data.handoffFields.email === 'dana@x.com');
          check('SF timeout: no leadId in the response (nothing was written)',
            !('leadId' in data));
          check('SF timeout: abort surfaced as a normal thrown error and was caught',
            logged.some((line) => line.includes('SALESFORCE WRITE FAILED') && /timeout/i.test(line)));
          check('SF timeout: unsaved fields logged for manual replay',
            logged.some((line) => line.includes('unsaved fields') &&
              line.includes('"fundingAmount":"$75,000"')));
        } finally {
          console.error = realError;
          globalThis.fetch = cannedFetch;
          for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    check(`SF_FETCH_TIMEOUT_MS is a bounded named constant (${SF_FETCH_TIMEOUT_MS}ms)`,
      SF_FETCH_TIMEOUT_MS === 8000);
  }

  {
    // Direct unit check on the recovery surface itself.
    const messages = [{
      role: 'user',
      content: 'I am Dana Whitfield of Ridgeline HVAC, dana@x.com, 216-555-0142, ' +
        'we make $50k/month and want $75,000 for equipment.',
    }];
    const recovered = recoverContactFields(messages);
    check('recoverContactFields returns email and phone and nothing else',
      Object.keys(recovered).sort().join(',') === 'email,phone' &&
      recovered.email === 'dana@x.com' &&
      recovered.phone === '(216) 555-0142');
    check('recoverContactFields ignores the assistant\'s turns',
      Object.keys(recoverContactFields([
        { role: 'assistant', content: 'reach us at sales@spartan.us or 800-555-0111' },
      ])).length === 0);
    check('recoverContactFields on an empty transcript -> {}',
      Object.keys(recoverContactFields([])).length === 0 &&
      Object.keys(recoverContactFields(undefined)).length === 0);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`HANDOFF GATE: ${passed} assertions passed, zero network calls`);
  console.log('='.repeat(72));
  console.log('Confirmed: handoff !== true creates no Lead. Excluded-industry');
  console.log('suppression upstream is preserved -- this module has no override path.\n');
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
