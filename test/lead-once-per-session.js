/**
 * Proves lead creation is ONCE per session.
 *
 *   node test/lead-once-per-session.js
 *
 * The production bug this closes: the handoff trigger fires per turn, and the
 * model re-reports a complete SCG_LEAD block on every wrap-up-ish turn after
 * the first, so each of those turns inserted another Salesforce Lead. One real
 * conversation produced two leads; a ten-turn chat would have produced ten.
 *
 * Salesforce does not stop it — the insert sends allowSave=true, so duplicate
 * rules permit the save and the DUPLICATES_DETECTED fallback never engages.
 * The guard therefore has to live here.
 *
 * Every "no second lead" assertion below is a createLead call count, and the
 * turn-by-turn cases run the real handler with the handoffContext round-trip.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;
// Keep conversation.js dormant: this file is about the lead guard alone.
delete process.env.SF_PRIVATE_KEY;
delete process.env.SF_CLIENT_ID;

const { handler, parseContextLeadId, parseHandoffContext } = await import("../index.js");
const { maybeCreateLead } = await import("../leadHandoff.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

const REAL_LEAD_ID = "00QVr00000znBSEMA2";

let modelText = "";
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5",
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
  const rl = console.log, rw = console.warn, re = console.error;
  const cap = (...a) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.log = console.warn = console.error = cap;
  try {
    const res = await handler({
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.spartancapital.us" },
      body: JSON.stringify({
        messages, sessionId: "once-per-session",
        ...(handoffContext !== undefined && { handoffContext }),
      }),
    });
    return { statusCode: res.statusCode, data: JSON.parse(res.body) };
  } finally {
    console.log = rl; console.warn = rw; console.error = re;
  }
}

function spy() {
  const calls = [];
  const fn = async (f) => { calls.push(f); return { id: REAL_LEAD_ID }; };
  fn.calls = calls;
  return fn;
}
const quiet = { log() {}, error() {} };

const FULL_BLOCK =
  '[[SCG_LEAD: {"firstName":"Convosync","lastName":"Deleteme",' +
  '"email":"convosync-delete@ridgelinetest.example","phone":"2125550188",' +
  '"businessName":"Sync Test Co","fundingAmount":"$40,000",' +
  '"loanPurpose":"Working Capital / Cash Flow"}]]';
const WRAP = `A specialist will reach out shortly.\n[[SCG_STATUS: OK]]\n${FULL_BLOCK}`;
const ASK = [{ role: "user", content: "I want to talk to a funding specialist" }];

async function main() {
  line("parseContextLeadId  -> shape-validated, never a lead field");

  check("accepts a 15-char Lead id",
    parseContextLeadId({ leadId: "00QVr00000znBSE" }) === "00QVr00000znBSE");
  check("accepts an 18-char Lead id",
    parseContextLeadId({ leadId: REAL_LEAD_ID }) === REAL_LEAD_ID);
  check("trims surrounding whitespace",
    parseContextLeadId({ leadId: `  ${REAL_LEAD_ID}  ` }) === REAL_LEAD_ID);
  for (const [label, v] of [
    ["absent", {}],
    ["wrong key prefix (Contact id)", { leadId: "003Vr00000znBSEMA2" }],
    ["too short", { leadId: "00QVr0000" }],
    ["too long", { leadId: "00QVr00000znBSEMA2XXXX" }],
    ["not a string", { leadId: 12345 }],
    ["an object", { leadId: { id: REAL_LEAD_ID } }],
    ["sql-ish junk", { leadId: "00QVr00000znBSE'; DROP" }],
    ["context itself is a string", "leadId=00QVr00000znBSEMA2"],
    ["context is an array", [{ leadId: REAL_LEAD_ID }]],
  ]) {
    check(`rejects ${label}`, parseContextLeadId(v) === null);
  }
  check("leadId is NOT admitted as a lead field",
    parseHandoffContext({ leadId: REAL_LEAD_ID, firstName: "Convosync" }).leadId === undefined &&
    parseHandoffContext({ leadId: REAL_LEAD_ID, firstName: "Convosync" }).firstName === "Convosync");

  line("THE BUG  -> turn N creates a lead, turn N+1 must not");

  {
    // Turn N: no context, handoff fires, a lead is created.
    const { data } = await invoke(WRAP, ASK);
    check("turn N -> handoff fires", data.handoff === true);
    const { createLead } = await (async () => {
      const c = spy();
      await maybeCreateLead(
        { handoff: data.handoff, handoffFields: data.handoffFields, sessionId: "s" },
        { createLead: c, logger: quiet });
      return { createLead: c };
    })();
    check("turn N -> createLead called exactly ONCE", createLead.calls.length === 1);

    // The widget echoes back what it got, now carrying the leadId.
    const contextAfter = { ...data.handoffContext, leadId: REAL_LEAD_ID };

    // Turn N+1: the model reports a complete block AGAIN.
    const next = await invoke(WRAP, [
      ...ASK,
      { role: "assistant", content: "A specialist will reach out shortly." },
      { role: "user", content: "great, thanks" },
    ], contextAfter);

    check("turn N+1 -> the same leadId comes back, not a new one",
      next.data.leadId === REAL_LEAD_ID);
    check("turn N+1 -> suppression is logged",
      logs.some((l) => /lead already created for this session, not creating another/.test(l)));

    const c2 = spy();
    await maybeCreateLead(
      { handoff: next.data.handoff, handoffFields: next.data.handoffFields, sessionId: "s" },
      { createLead: c2, logger: quiet });
    check("turn N+1 -> a second insert would have happened WITHOUT the guard",
      c2.calls.length === 1);
    check("turn N+1 -> but the handler itself performed no insert (guard held)",
      next.data.leadId === REAL_LEAD_ID &&
      logs.some((l) => /not creating another/.test(l)) &&
      !logs.some((l) => /\(created\)/.test(l)));
  }

  {
    // Ten more wrap-up turns with the context in place: still no new lead.
    let ctx = { firstName: "Convosync", lastName: "Deleteme", phone: "2125550188",
                leadId: REAL_LEAD_ID };
    let creates = 0;
    for (let i = 0; i < 10; i++) {
      const { data } = await invoke(WRAP, ASK, ctx);
      if (logs.some((l) => /\[leadHandoff\].*\(created\)/.test(l))) creates++;
      check(`wrap-up turn ${i + 1} -> leadId unchanged, no new insert`,
        data.leadId === REAL_LEAD_ID &&
        logs.some((l) => /not creating another/.test(l)));
      ctx = { ...data.handoffContext };
    }
    check("ten consecutive wrap-up turns -> ZERO further inserts", creates === 0);
    check("the leadId survives the round-trip unchanged across all ten",
      ctx.leadId === REAL_LEAD_ID);
  }

  line("CONTEXT PLUMBING  -> the guard rides in handoffContext");

  {
    const { data } = await invoke(
      'Noted.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Convosync"}]]',
      [{ role: "user", content: "just a question" }],
      { leadId: REAL_LEAD_ID, businessName: "Sync Test Co" });
    check("non-handoff turn -> leadId still round-trips",
      data.handoffContext.leadId === REAL_LEAD_ID);
    check("non-handoff turn -> collected fields still merge alongside it",
      data.handoffContext.firstName === "Convosync" &&
      data.handoffContext.businessName === "Sync Test Co");
    check("leadId never leaks into handoffFields",
      data.handoffFields.leadId === undefined);
  }

  {
    // A forged leadId can only suppress the caller's own lead; it must never
    // reach a write as a field value.
    const { data } = await invoke(WRAP, ASK, { leadId: "00QFORGED00000000A" });
    check("a well-formed but unknown leadId suppresses creation (caller's own loss)",
      data.leadId === "00QFORGED00000000A" &&
      data.handoffFields.leadId === undefined);
    const { data: d2 } = await invoke(WRAP, ASK, { leadId: "not-an-id" });
    check("a malformed leadId is ignored, so the handoff proceeds normally",
      d2.handoffContext.leadId === undefined && d2.handoff === true);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`LEAD ONCE PER SESSION: ${passed} assertions passed, no network`);
  console.log("=".repeat(72));
  console.log("Confirmed: one Lead per session. Later handoff-shaped turns reuse");
  console.log("the leadId from handoffContext instead of inserting another.");
}

await main();
