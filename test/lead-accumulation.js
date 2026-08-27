/**
 * Proves the two halves of the empty-lead fix:
 *
 *   1. ACCUMULATION — handoff fields are re-derived from the WHOLE transcript,
 *      so a lead built on the turn the handoff fires carries what earlier turns
 *      reported, not just what this turn's block happens to hold.
 *   2. THE MINIMUM GATE — no lead is written without a real name plus at least
 *      one of email/phone, so the placeholder record ("Chatbot Lead" /
 *      "Unknown (Chatbot Lead)") can never be created again.
 *
 *   node test/lead-accumulation.js
 *
 * No network: fetch is stubbed for Claude and createLead is a spy, so every
 * assertion about "was a lead written" is about an actual call count.
 *
 *   3. THE handoffContext ROUND-TRIP — since index.js strips SCG_LEAD from the
 *      reply it returns, blocks do not survive in the transcript the widget
 *      echoes back. The accumulated fields therefore travel in their own
 *      handoffContext field, returned every turn and sent back on the next, so
 *      accumulation works by contract rather than by luck.
 *
 * The multi-turn cases in the middle section put blocks in the assistant turns
 * of the transcript, exercising the history scan directly; the CONTEXT section
 * at the end exercises the round-trip that carries them in production.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

const {
  handler,
  accumulateLeadFields,
  mergeLeadFields,
  meetsLeadMinimum,
  missingForLeadMinimum,
  setClock,
} = await import("../index.js");
// Pin the clock inside business hours (Wed 2:00pm ET), so the after-hours gate
// in businessHours.js stays dormant and this file's assertions on exact reply
// text hold whatever hour the suite actually runs at.
setClock(() => new Date("2026-01-14T19:00:00Z"));

const { maybeCreateLead } = await import("../leadHandoff.js");
const { buildLeadPayload } = await import("../salesforce.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

// ---------------------------------------------------------------- Claude stub
let modelText = "";
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: modelText }],
      stop_reason: "end_turn", stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const warnings = [];
const realWarn = console.warn;
const realLog = console.log;

async function invoke(text, messages, handoffContext) {
  modelText = text;
  warnings.length = 0;
  console.warn = (...args) => warnings.push(args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a)).join(" "));
  const quietLog = console.log;
  console.log = () => {};
  try {
    const res = await handler({
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.spartancapital.us" },
      body: JSON.stringify({
        messages,
        sessionId: "accum-test",
        ...(handoffContext !== undefined && { handoffContext }),
      }),
    });
    return { statusCode: res.statusCode, data: JSON.parse(res.body) };
  } finally {
    console.warn = realWarn;
    console.log = quietLog;
  }
}

/** Records calls so "no lead written" is a call count, not an absence of output. */
function spy() {
  const calls = [];
  const fn = async (fields) => { calls.push(fields); return { id: "00QSPY000000001" }; };
  fn.calls = calls;
  return fn;
}
const quiet = { log() {}, error() {} };

/** Feed the handler's decision into the real gate, as index.js does. */
async function writeLead(data) {
  const createLead = spy();
  const out = await maybeCreateLead(
    { handoff: data.handoff, handoffFields: data.handoffFields, sessionId: "accum-test" },
    { createLead, logger: quiet },
  );
  return { createLead, out };
}

const OFFER = "Happy to connect you with a funding specialist.";

async function main() {
  line("MERGE SEMANTICS  -> later non-empty wins, blank never clobbers");

  {
    const target = { firstName: "Dana", phone: "(216) 555-0142", businessName: "Ridgeline HVAC" };
    mergeLeadFields(target, { firstName: "", phone: "   ", businessName: undefined, email: "d@x.com" });
    check("blank/absent incoming values never overwrite a known value",
      target.firstName === "Dana" && target.phone === "(216) 555-0142" &&
      target.businessName === "Ridgeline HVAC" && target.email === "d@x.com");
  }

  {
    const target = { fundingAmount: "$50,000" };
    mergeLeadFields(target, { fundingAmount: "$75,000" });
    check("a later non-empty value updates an earlier one", target.fundingAmount === "$75,000");
  }

  {
    check("meetsLeadMinimum: name + phone passes",
      meetsLeadMinimum({ firstName: "Dana", phone: "(216) 555-0142" }) === true);
    check("meetsLeadMinimum: name + email passes",
      meetsLeadMinimum({ lastName: "Whitfield", email: "d@x.com" }) === true);
    check("meetsLeadMinimum: name alone fails",
      meetsLeadMinimum({ firstName: "Dana" }) === false);
    check("meetsLeadMinimum: contact alone fails",
      meetsLeadMinimum({ email: "d@x.com", phone: "(216) 555-0142" }) === false);
    check("meetsLeadMinimum: the 'Chatbot Lead' placeholder is not a name",
      meetsLeadMinimum({ lastName: "Chatbot Lead", phone: "(216) 555-0142" }) === false);
    check("missingForLeadMinimum names what is absent",
      missingForLeadMinimum({}).join(",") === "name,email-or-phone" &&
      missingForLeadMinimum({ firstName: "Dana" }).join(",") === "email-or-phone");
  }

  line("CASE 1  handoff fires, only a name known -> NO lead, suppression logged");

  {
    const { statusCode, data } = await invoke(
      'Sure — someone will reach out.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield"}]]',
      [{ role: "user", content: "I want to talk to a funding specialist" }]);
    check("name only -> 200 and the visitor still gets their reply",
      statusCode === 200 && data.reply === "Sure — someone will reach out." &&
      data.error === undefined);
    check("name only -> handoff false and deferred flag set",
      data.handoff === false && data.handoffDeferred === true);
    check("name only -> the collected name is still returned for the next turn",
      data.handoffFields.firstName === "Dana" && data.handoffFields.lastName === "Whitfield");
    check("name only -> suppression logged with what is missing",
      warnings.some((w) => /lead creation suppressed/i.test(w) && /email-or-phone/.test(w)));
    const { createLead, out } = await writeLead(data);
    check("name only -> createLead called ZERO times, no leadId",
      createLead.calls.length === 0 && out.leadId === undefined);
  }

  line("CASE 2  handoff fires with name + phone -> lead created, fields attached");

  {
    const { data } = await invoke(
      'All set.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield",' +
      '"phone":"(216) 555-0142","businessName":"Ridgeline HVAC","fundingAmount":"$75,000",' +
      '"loanPurpose":"Purchase Vehicles"}]]',
      [{ role: "user", content: "I want to talk to a funding specialist" }]);
    check("name + phone -> handoff true, not deferred",
      data.handoff === true && data.handoffDeferred === undefined);
    const { createLead } = await writeLead(data);
    check("name + phone -> createLead called exactly once", createLead.calls.length === 1);
    const payload = buildLeadPayload(createLead.calls[0]);
    check("name + phone -> payload carries the real values, no placeholders",
      payload.FirstName === "Dana" && payload.LastName === "Whitfield" &&
      payload.Phone === "+12165550142" && payload.Company === "Ridgeline HVAC" &&
      payload.Funding_Amount__c === "$75,000" &&
      payload.Use_of_Funds__c === "Purchase Vehicles");
    check("name + phone -> neither required-field fallback appears",
      payload.LastName !== "Chatbot Lead" && payload.Company !== "Unknown (Chatbot Lead)");
  }

  line("CASE 3  fields spread across turns -> all merged into one complete lead");

  {
    // Name reported turn 3, phone turn 6, the rest turn 7. No single block is
    // complete; only the accumulation across all of them is.
    const messages = [
      { role: "user", content: "I run an HVAC company and need funding for a van." },
      { role: "assistant", content: `${OFFER} What's your first name?` },
      { role: "user", content: "Dana Whitfield" },
      { role: "assistant", content:
        'Thanks, Dana! What is your business called?\n[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield"}]]' },
      { role: "user", content: "Ridgeline HVAC" },
      { role: "assistant", content:
        'Got it. Best phone number?\n[[SCG_LEAD: {"businessName":"Ridgeline HVAC"}]]' },
      { role: "user", content: "216-555-0142" },
      { role: "assistant", content:
        'Perfect. How much are you looking for?\n[[SCG_LEAD: {"phone":"(216) 555-0142"}]]' },
      { role: "user", content: "Please have a specialist call me — $75,000 for another van." },
    ];
    const { data } = await invoke(
      'You are all set.\n[[SCG_STATUS: OK]]\n' +
      '[[SCG_LEAD: {"fundingAmount":"$75,000","loanPurpose":"Purchase Vehicles"}]]',
      messages);
    check("spread across turns -> handoff true, not deferred",
      data.handoff === true && data.handoffDeferred === undefined);
    check("spread across turns -> every earlier field is present at the handoff",
      data.handoffFields.firstName === "Dana" &&
      data.handoffFields.lastName === "Whitfield" &&
      data.handoffFields.businessName === "Ridgeline HVAC" &&
      data.handoffFields.phone === "(216) 555-0142" &&
      data.handoffFields.fundingAmount === "$75,000" &&
      data.handoffFields.loanPurpose === "Purchase Vehicles");
    const { createLead } = await writeLead(data);
    const payload = buildLeadPayload(createLead.calls[0]);
    check("spread across turns -> one complete lead, no placeholders",
      createLead.calls.length === 1 &&
      payload.FirstName === "Dana" && payload.Company === "Ridgeline HVAC" &&
      payload.Phone === "+12165550142" && payload.Funding_Amount__c === "$75,000" &&
      payload.LastName !== "Chatbot Lead" && payload.Company !== "Unknown (Chatbot Lead)");
  }

  line("CASE 4  the off-by-one bug: populated block turn N, bare 'yes' turn N+1");

  {
    // Exactly the shape that produced the empty lead: the model wrapped up and
    // reported everything on the previous turn, the visitor then confirms with
    // a bare affirmative, and THIS turn's reply carries no block at all.
    const messages = [
      { role: "user", content: "I run Ridgeline HVAC and need $75,000 for a van." },
      { role: "assistant", content:
        "Perfect — I'll pass this to a funding specialist who will reach out.\n" +
        '[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield","email":"dana@ridgelinehvac.com",' +
        '"phone":"(216) 555-0142","businessName":"Ridgeline HVAC","fundingAmount":"$75,000",' +
        '"loanPurpose":"Purchase Vehicles"}]]' },
      { role: "user", content: "yes" },
    ];
    const { data } = await invoke(
      "You're all set — they'll be in touch shortly.\n[[SCG_STATUS: OK]]",
      messages);
    check("off-by-one -> handoff fired on the bare confirmation", data.handoff === true);
    check("off-by-one -> this turn emitted NO block, yet fields survive",
      !/SCG_LEAD/i.test(modelText) &&
      data.handoffFields.firstName === "Dana" &&
      data.handoffFields.email === "dana@ridgelinehvac.com" &&
      data.handoffFields.phone === "(216) 555-0142" &&
      data.handoffFields.businessName === "Ridgeline HVAC" &&
      data.handoffFields.fundingAmount === "$75,000");
    const { createLead } = await writeLead(data);
    const payload = buildLeadPayload(createLead.calls[0]);
    check("off-by-one -> a COMPLETE lead is written, not the placeholder",
      createLead.calls.length === 1 &&
      payload.FirstName === "Dana" && payload.LastName === "Whitfield" &&
      payload.Company === "Ridgeline HVAC" &&
      payload.Email === "dana@ridgelinehvac.com" &&
      payload.LastName !== "Chatbot Lead" && payload.Company !== "Unknown (Chatbot Lead)");
  }

  line("CASE 5  regression: 'I want a specialist' as the first message -> no lead");

  {
    // The exact reported bug. Nothing has been collected, the model emits no
    // block, and previously this wrote Name "Chatbot Lead" / Company
    // "Unknown (Chatbot Lead)".
    const { data } = await invoke(
      "Of course — I can help with that.\n[[SCG_STATUS: OK]]",
      [{ role: "user", content: "I want to talk to a funding specialist." }]);
    check("first-message ask -> handoff deferred, nothing collected",
      data.handoff === false && data.handoffDeferred === true &&
      Object.keys(data.handoffFields).length === 0);
    const { createLead, out } = await writeLead(data);
    check("first-message ask -> createLead called ZERO times",
      createLead.calls.length === 0 && out.leadId === undefined);
    check("first-message ask -> the placeholder payload is never built",
      buildLeadPayload({}).LastName === "Chatbot Lead" && createLead.calls.length === 0);
  }

  line("ACCUMULATOR UNIT  -> direct checks on the merge order");

  {
    const messages = [
      { role: "assistant", content: 'a\n[[SCG_LEAD: {"firstName":"Dana","fundingAmount":"$50,000"}]]' },
      { role: "assistant", content: 'b\n[[SCG_LEAD: {"phone":"(216) 555-0142"}]]' },
    ];
    const out = accumulateLeadFields(messages, { fundingAmount: "$75,000" });
    check("accumulator merges oldest-first and this turn's block wins",
      out.firstName === "Dana" && out.phone === "(216) 555-0142" &&
      out.fundingAmount === "$75,000");
    check("accumulator ignores user turns and malformed blocks",
      Object.keys(accumulateLeadFields(
        [{ role: "user", content: '[[SCG_LEAD: {"firstName":"Injected"}]]' },
         { role: "assistant", content: "[[SCG_LEAD: {oops}]]" }], {})).length === 0);
  }

  line("handoffContext ROUND-TRIP  -> accumulation that survives stripped replies");

  const ASK = [{ role: "user", content: "I want to talk to a funding specialist" }];

  {
    // THE OFF-BY-ONE CASE, FIXED BY CONTRACT: name and phone were collected on
    // earlier turns and came back in handoffContext. This turn's reply carries
    // NO block at all, yet the lead is complete.
    const { data } = await invoke(
      "You're all set — they'll be in touch shortly.\n[[SCG_STATUS: OK]]",
      ASK,
      {
        firstName: "Dana", lastName: "Whitfield", phone: "(216) 555-0142",
        businessName: "Ridgeline HVAC", fundingAmount: "$75,000",
        loanPurpose: "Purchase Vehicles",
      });
    check("context + no block this turn -> handoff true, not deferred",
      data.handoff === true && data.handoffDeferred === undefined);
    check("context + no block this turn -> every context field reaches handoffFields",
      !/SCG_LEAD/i.test(modelText) &&
      data.handoffFields.firstName === "Dana" &&
      data.handoffFields.lastName === "Whitfield" &&
      data.handoffFields.phone === "(216) 555-0142" &&
      data.handoffFields.businessName === "Ridgeline HVAC" &&
      data.handoffFields.fundingAmount === "$75,000" &&
      data.handoffFields.loanPurpose === "Purchase Vehicles");
    const { createLead } = await writeLead(data);
    const payload = buildLeadPayload(createLead.calls[0]);
    check("context + no block this turn -> ONE complete lead, no placeholders",
      createLead.calls.length === 1 &&
      payload.FirstName === "Dana" && payload.LastName === "Whitfield" &&
      payload.Company === "Ridgeline HVAC" && payload.Phone === "+12165550142" &&
      payload.LastName !== "Chatbot Lead" && payload.Company !== "Unknown (Chatbot Lead)");
  }

  {
    // Context has a name but no contact anywhere — not in context, not in the
    // block, not in the transcript. The gate must still hold.
    const { data } = await invoke(
      "Of course.\n[[SCG_STATUS: OK]]",
      ASK,
      { firstName: "Dana", lastName: "Whitfield", businessName: "Ridgeline HVAC" });
    check("context name only, no contact -> deferred, no lead",
      data.handoff === false && data.handoffDeferred === true);
    check("context name only -> suppression names the missing contact",
      warnings.some((w) => /lead creation suppressed/i.test(w) && /email-or-phone/.test(w)));
    const { createLead } = await writeLead(data);
    check("context name only -> createLead called ZERO times", createLead.calls.length === 0);
    check("context name only -> context still round-trips for the next turn",
      data.handoffContext.firstName === "Dana" &&
      data.handoffContext.businessName === "Ridgeline HVAC");
  }

  {
    // This turn's block updates one field, adds another, and sends a blank for
    // a third. Block wins on conflict; the blank must not clobber.
    const { data } = await invoke(
      'Updated.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"fundingAmount":"$120,000",' +
      '"email":"dana@ridgelinehvac.com","businessName":"   ","phone":""}]]',
      ASK,
      {
        firstName: "Dana", lastName: "Whitfield", phone: "(216) 555-0142",
        businessName: "Ridgeline HVAC", fundingAmount: "$75,000",
      });
    check("block wins on conflict over context",
      data.handoffFields.fundingAmount === "$120,000");
    check("block adds a field the context lacked",
      data.handoffFields.email === "dana@ridgelinehvac.com");
    check("blank block values never clobber known context values",
      data.handoffFields.businessName === "Ridgeline HVAC" &&
      data.handoffFields.phone === "(216) 555-0142");
    check("untouched context fields survive",
      data.handoffFields.firstName === "Dana" && data.handoffFields.lastName === "Whitfield");
  }

  {
    // Every malformed shape a client might send must degrade to no context.
    const junk = [
      ["absent", undefined],
      ["null", null],
      ["a string", "firstName=Dana"],
      ["an array", [{ firstName: "Dana" }]],
      ["a number", 42],
      ["nested junk", { firstName: { nope: true }, phone: ["x"] }],
      ["unknown keys only", { evil: "DROP TABLE", Company: "Injected Inc" }],
    ];
    let allSafe = true;
    for (const [label, ctx] of junk) {
      const { statusCode, data } = await invoke("Hello.\n[[SCG_STATUS: OK]]", ASK, ctx);
      const clean = statusCode === 200 && data.error === undefined &&
        typeof data.handoffContext === "object" &&
        data.handoffContext.evil === undefined &&
        data.handoffContext.Company === undefined;
      if (!clean) allSafe = false;
      check(`malformed handoffContext (${label}) -> 200, treated as {}, no crash`, clean);
    }
    check("no malformed context leaked an unknown key into the accumulation", allSafe);
  }

  {
    // The response must always carry the accumulation, handoff or not.
    const { data } = await invoke(
      'Noted.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Dana"}]]',
      [{ role: "user", content: "What products do you offer?" }],
      { businessName: "Ridgeline HVAC" });
    check("non-handoff turn -> handoffContext returned with the merged fields",
      data.handoff === false &&
      data.handoffContext.firstName === "Dana" &&
      data.handoffContext.businessName === "Ridgeline HVAC");
    check("non-handoff turn -> handoffFields stays empty (only context accumulates)",
      Object.keys(data.handoffFields).length === 0);
  }

  {
    const { data } = await invoke("Hi there.\n[[SCG_STATUS: OK]]",
      [{ role: "user", content: "hello" }]);
    check("no context in, nothing collected -> handoffContext present and empty",
      data.handoffContext !== undefined && Object.keys(data.handoffContext).length === 0);
  }

  {
    // A declined business must not have its contact details harvested, even
    // though the transcript holds them.
    const { data } = await invoke(
      "Spartan isn't able to fund dispensaries.\n[[SCG_STATUS: DECLINE]]",
      [{ role: "user", content: "I own a dispensary, dana@x.com, 216-555-0142. Call me." }]);
    check("DECLINE -> no contact harvested into the context",
      data.handoff === false &&
      data.handoffContext.email === undefined &&
      data.handoffContext.phone === undefined &&
      Object.keys(data.handoffFields).length === 0);
  }

  console.log = realLog;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`LEAD ACCUMULATION + MINIMUM GATE: ${passed} assertions passed, no network`);
  console.log("=".repeat(72));
  console.log("Confirmed: no lead without name + (email or phone); fields from the");
  console.log("whole conversation reach the lead, including the off-by-one turn.");
}

await main();
