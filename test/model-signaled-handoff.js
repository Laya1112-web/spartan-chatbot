/**
 * Proves the model-signalled handoff path.
 *
 *   node test/model-signaled-handoff.js
 *
 * The bug this closes: the model would collect every detail, announce the
 * handoff and report a complete SCG_LEAD block, and if the visitor's closing
 * words were "thank you" or "no" the visitor-phrase regex never matched, so a
 * fully qualified lead was silently dropped — not written, not even logged as
 * lost.
 *
 * A handoff now fires when EITHER the visitor's words ask for it OR the model
 * reported a block and the accumulated fields clear the minimum. Two invariants
 * this file pins down:
 *
 *   1. DECLINE beats everything. An excluded industry creates no lead however
 *      complete the block, and whichever path would otherwise have fired.
 *   2. The minimum gate applies to BOTH paths, so the new path cannot be used
 *      by an over-eager model to manufacture a placeholder lead.
 *
 * No network: fetch is stubbed and createLead is a spy.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

const { handler } = await import("../index.js");
const { maybeCreateLead } = await import("../leadHandoff.js");
const { buildLeadPayload } = await import("../salesforce.js");
const { detectHandoff, shouldHandoff } = await import("../intent.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

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

const logs = [];
async function invoke(text, messages, handoffContext) {
  modelText = text;
  logs.length = 0;
  const realLog = console.log;
  const realWarn = console.warn;
  const cap = (...a) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.log = cap;
  console.warn = cap;
  try {
    const res = await handler({
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.spartancapital.us" },
      body: JSON.stringify({
        messages, sessionId: "model-signal-test",
        ...(handoffContext !== undefined && { handoffContext }),
      }),
    });
    return { statusCode: res.statusCode, data: JSON.parse(res.body) };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

function spy() {
  const calls = [];
  const fn = async (f) => { calls.push(f); return { id: "00QSPY000000009" }; };
  fn.calls = calls;
  return fn;
}
const quiet = { log() {}, error() {} };
async function writeLead(data) {
  const createLead = spy();
  const out = await maybeCreateLead(
    { handoff: data.handoff, handoffFields: data.handoffFields, sessionId: "model-signal-test" },
    { createLead, logger: quiet });
  return { createLead, out };
}

// The real conversation tail from the dropped lead.
const WRAP_UP =
  "Great, thanks! I've got what I need — Testo Testote from Testo LLC, email " +
  "test@ridgelinetest.example, phone 45648798465, looking for funding to support " +
  "hiring. I'll connect you with a funding specialist who can go over the details.";
const FULL_BLOCK =
  '[[SCG_LEAD: {"firstName":"Testo","lastName":"Testote",' +
  '"email":"test@ridgelinetest.example","phone":"45648798465",' +
  '"businessName":"Testo LLC","monthlyRevenue":"$30,000","timeInBusiness":"2 years",' +
  '"loanPurpose":"Hiring"}]]';

const tail = (lastWord) => [
  { role: "user", content: "I need funding to support hiring more staff." },
  { role: "assistant", content: WRAP_UP },
  { role: "user", content: lastWord },
];

async function main() {
  line('THE BUG  -> complete block + "thank you" -> handoff fires, lead created');

  {
    const messages = tail("thank you");
    check("precondition: the visitor's words do NOT match the regex",
      detectHandoff(messages) === false);

    const { statusCode, data } = await invoke(
      `You're welcome, Testo!\n[[SCG_STATUS: OK]]\n${FULL_BLOCK}`, messages);
    check('"thank you" -> handoff fires anyway, not deferred',
      statusCode === 200 && data.handoff === true && data.handoffDeferred === undefined);
    check('"thank you" -> all eight reported fields survive',
      data.handoffFields.firstName === "Testo" &&
      data.handoffFields.lastName === "Testote" &&
      data.handoffFields.email === "test@ridgelinetest.example" &&
      data.handoffFields.phone === "45648798465" &&
      data.handoffFields.businessName === "Testo LLC" &&
      data.handoffFields.loanPurpose === "Hiring");
    check('"thank you" -> the model-signalled path is logged for CloudWatch',
      logs.some((l) => /handoff signalled by the model, not the visitor/.test(l)));
    const { createLead } = await writeLead(data);
    const payload = buildLeadPayload(createLead.calls[0]);
    check('"thank you" -> exactly one lead, real values, no placeholders',
      createLead.calls.length === 1 &&
      payload.FirstName === "Testo" && payload.LastName === "Testote" &&
      payload.Company === "Testo LLC" &&
      payload.Email === "test@ridgelinetest.example" &&
      payload.Use_of_Funds__c === "Hiring" &&
      payload.LastName !== "Chatbot Lead" && payload.Company !== "Unknown (Chatbot Lead)");
  }

  line('"no"  -> still fires: the block is complete and OK, the word is irrelevant');

  {
    const messages = tail("no");
    check('precondition: "no" is a NEGATIVE, so the regex path is firmly shut',
      detectHandoff(messages) === false);
    const { data } = await invoke(
      `Sounds good — take care!\n[[SCG_STATUS: OK]]\n${FULL_BLOCK}`, messages);
    check('"no" -> handoff still fires on the model signal',
      data.handoff === true && data.handoffDeferred === undefined);
    const { createLead } = await writeLead(data);
    check('"no" -> the lead is created with the full field set',
      createLead.calls.length === 1 &&
      createLead.calls[0].firstName === "Testo" &&
      createLead.calls[0].phone === "45648798465");
  }

  line("DECLINE + populated block  -> NO handoff, NO lead, absolutely");

  {
    const messages = [
      { role: "user", content: "I run a cannabis dispensary and need funding." },
      { role: "assistant", content: "Spartan isn't able to fund cannabis businesses." },
      { role: "user", content: "thanks anyway" },
    ];
    const { data } = await invoke(
      "Spartan isn't able to fund dispensaries.\n[[SCG_STATUS: DECLINE]]\n" +
      '[[SCG_LEAD: {"firstName":"Casey","lastName":"Nguyen","email":"casey@dispensary.example",' +
      '"phone":"(216) 555-0142","businessName":"Green Leaf"}]]', messages);
    check("DECLINE + full block -> handoff false, no fields returned",
      data.handoff === false && Object.keys(data.handoffFields).length === 0);
    check("DECLINE + full block -> not merely 'deferred': the block is refused outright",
      data.handoffDeferred === undefined);
    const { createLead, out } = await writeLead(data);
    check("DECLINE + full block -> createLead called ZERO times",
      createLead.calls.length === 0 && out.leadId === undefined);
  }

  {
    // Belt and braces at the unit level: a complete model signal must not beat
    // a decline from any of the three sources.
    const msgs = [{ role: "user", content: "hello" }];
    check("shouldHandoff: model signal cannot beat a DECLINE status tag",
      shouldHandoff({ messages: msgs, reply: "ok", modelDeclined: true,
        modelSignaledHandoff: true }) === false);
    check("shouldHandoff: model signal cannot beat a decline-shaped reply",
      shouldHandoff({ messages: msgs, reply: "Spartan isn't able to fund that.",
        modelSignaledHandoff: true }) === false);
    check("shouldHandoff: model signal cannot beat an EARLIER declined turn",
      shouldHandoff({
        messages: [
          { role: "user", content: "dispensary" },
          { role: "assistant", content: "We can't fund cannabis businesses." },
          { role: "user", content: "ok" },
        ],
        reply: "Sure.", modelSignaledHandoff: true }) === false);
    check("shouldHandoff: model signal alone is enough when nothing declined",
      shouldHandoff({ messages: msgs, reply: "ok", modelSignaledHandoff: true }) === true);
    check("shouldHandoff: no signal and no visitor phrase -> false",
      shouldHandoff({ messages: msgs, reply: "ok" }) === false);
  }

  line("BELOW MINIMUM  -> a thin block cannot manufacture a handoff");

  {
    // Name only, no contact anywhere, and the visitor never asked.
    const { data } = await invoke(
      'Thanks!\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Testo","lastName":"Testote"}]]',
      [{ role: "user", content: "I need funding for hiring." },
       { role: "assistant", content: "Happy to help with that." },
       { role: "user", content: "thank you" }]);
    check("thin block, no regex -> no handoff at all",
      data.handoff === false);
    const { createLead } = await writeLead(data);
    check("thin block, no regex -> createLead called ZERO times",
      createLead.calls.length === 0);
  }

  {
    // Contact but no real name: also below the minimum.
    const { data } = await invoke(
      'Noted.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"email":"someone@x.example","phone":"(216) 555-0142"}]]',
      [{ role: "user", content: "here are my details" },
       { role: "assistant", content: "Thanks." },
       { role: "user", content: "thank you" }]);
    check("contact but no name -> no handoff, no lead", data.handoff === false);
    const { createLead } = await writeLead(data);
    check("contact but no name -> createLead called ZERO times", createLead.calls.length === 0);
  }

  {
    // The placeholder must not sneak through as a "name".
    const { data } = await invoke(
      'Noted.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"lastName":"Chatbot Lead","phone":"(216) 555-0142"}]]',
      [{ role: "user", content: "details" },
       { role: "assistant", content: "Thanks." },
       { role: "user", content: "thank you" }]);
    check("'Chatbot Lead' as the only name -> no handoff", data.handoff === false);
  }

  line("EXISTING REGEX PATH  -> unchanged");

  {
    const messages = [{ role: "user", content: "I want to talk to a funding specialist" }];
    check("precondition: the visitor phrase still matches", detectHandoff(messages) === true);
    const { data } = await invoke(
      'Of course.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield",' +
      '"phone":"(216) 555-0142","businessName":"Ridgeline HVAC"}]]', messages);
    check("regex path -> handoff fires as before", data.handoff === true);
    const { createLead } = await writeLead(data);
    check("regex path -> one lead with the block's fields",
      createLead.calls.length === 1 && createLead.calls[0].businessName === "Ridgeline HVAC");
    check("regex path -> not attributed to the model signal in the log",
      !logs.some((l) => /signalled by the model/.test(l)));
  }

  {
    // Regex fires, block is thin: still deferred, exactly as before this change.
    const { data } = await invoke(
      'Sure.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Dana"}]]',
      [{ role: "user", content: "I want to talk to a funding specialist" }]);
    check("regex path + thin block -> deferred, no lead",
      data.handoff === false && data.handoffDeferred === true);
    const { createLead } = await writeLead(data);
    check("regex path + thin block -> createLead called ZERO times",
      createLead.calls.length === 0);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`MODEL-SIGNALLED HANDOFF: ${passed} assertions passed, no network`);
  console.log("=".repeat(72));
  console.log("Confirmed: a complete block hands off regardless of the visitor's");
  console.log("closing words; DECLINE and the minimum gate both still veto it.");
}

await main();
