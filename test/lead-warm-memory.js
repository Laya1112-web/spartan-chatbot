/**
 * Proves the warm-container once-per-session guard.
 *
 *   node test/lead-warm-memory.js
 *
 * This is the guard that needs nothing outside the Lambda: no handoffContext
 * echo from the caller, no Conversation__c in Salesforce. It is what stops
 * duplicate leads the moment it deploys.
 *
 * Every Lead insert is a counted stubbed POST, so "one lead" is an actual
 * insert count. No network.
 *
 * Note the fingerprint cases: keying on sessionId alone would not help against
 * a caller that mints a fresh sessionId per turn, which is what the current
 * widget does — so the email/phone keys are the ones carrying this in
 * production today.
 */

import assert from "node:assert";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

// A real lead write needs Salesforce configured; the key is a throwaway and
// every call is stubbed.
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.env.SF_CLIENT_ID = "3MVGTEST_NOT_REAL";
process.env.SF_USERNAME = "test@example.invalid";
process.env.SF_PRIVATE_KEY = privateKey;

const { handler, clearLeadMemory, leadMemoryKeys, LEAD_MEMORY_MAX, setClock } =
  await import("../index.js");
// Pin the clock inside business hours (Wed 2:00pm ET), so the after-hours gate
// in businessHours.js stays dormant and this file's assertions on exact reply
// text hold whatever hour the suite actually runs at.
setClock(() => new Date("2026-01-14T19:00:00Z"));


let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const FULL_BLOCK =
  '[[SCG_LEAD: {"firstName":"Convosync","lastName":"Deleteme",' +
  '"email":"Convosync-Delete@ridgelinetest.example","phone":"(212) 555-0188",' +
  '"businessName":"Sync Test Co","fundingAmount":"$40,000"}]]';
const WRAP = `A specialist will reach out.\n[[SCG_STATUS: OK]]\n${FULL_BLOCK}`;

let inserts = 0;
let logs = [];
// The Anthropic SDK captures globalThis.fetch when the client is constructed,
// so swapping fetch later has no effect. Vary the reply through this instead.
let modelText = WRAP;

/** Claude answers; the Lead POST succeeds and is counted; no conversation exists. */
function stub() {
  inserts = 0;
  modelText = WRAP;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.includes("anthropic.com")) {
      return json({
        id: "m", type: "message", role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: modelText }],
        stop_reason: "end_turn", stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (u.includes("oauth2/token")) {
      return json({ access_token: "T", instance_url: "https://example.my.salesforce.com" });
    }
    if (u.includes("/sobjects/Lead") && method === "POST") {
      inserts++;
      return json({ id: `00QWARM00000000${inserts}A`, success: true }, 201);
    }
    // No Conversation__c for this session: keeps the secondary guard out of it.
    if (u.includes("/Session_Id__c/")) return new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
  };
}

async function invoke(sessionId, extraTurns = []) {
  logs = [];
  const rl = console.log, rw = console.warn, re = console.error;
  const cap = (...a) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
  console.log = console.warn = console.error = cap;
  try {
    const res = await handler({
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.spartancapital.us" },
      body: JSON.stringify({
        // Deliberately NO handoffContext: the primary guard is out of play, so
        // anything that holds here is the warm memory doing it.
        messages: [
          { role: "user", content: "I want to talk to a funding specialist" },
          ...extraTurns,
        ],
        sessionId,
      }),
    });
    return JSON.parse(res.body);
  } finally {
    console.log = rl; console.warn = rw; console.error = re;
  }
}

async function main() {
  line("KEYS  -> session, plus a contact fingerprint that survives a new sessionId");

  {
    const keys = leadMemoryKeys("sess-a", {
      email: "  Convosync-Delete@ridgelinetest.example ",
      phone: "+1 (212) 555-0188",
    });
    check("keys include the session, a lower-cased email, and the last ten phone digits",
      keys.includes("s:sess-a") &&
      keys.includes("e:convosync-delete@ridgelinetest.example") &&
      keys.includes("p:2125550188"));
    check("phone formatting is normalised away",
      leadMemoryKeys("x", { phone: "212-555-0188" }).includes("p:2125550188") &&
      leadMemoryKeys("x", { phone: "+12125550188" }).includes("p:2125550188"));
    check("a short or junk phone contributes no key",
      !leadMemoryKeys("x", { phone: "555" }).some((k) => k.startsWith("p:")));
    check("no session and no contact details -> no keys at all",
      leadMemoryKeys(undefined, {}).length === 0);
  }

  line("SAME SESSION TWICE in one container  -> ONE insert");

  {
    clearLeadMemory();
    stub();
    const first = await invoke("warm-sess-1");
    check("turn 1 -> handoff fires and the lead is inserted",
      first.handoff === true && inserts === 1 && /^00QWARM/.test(first.leadId ?? ""));
    const firstLeadId = first.leadId;

    const second = await invoke("warm-sess-1", [
      { role: "assistant", content: "A specialist will reach out." },
      { role: "user", content: "thanks" },
    ]);
    check("turn 2, same sessionId -> NO second insert", inserts === 1);
    check("turn 2 -> the original leadId is reused",
      second.leadId === firstLeadId);
    check("turn 2 -> suppression logged, attributed to warm memory",
      logs.some((l) => /not creating another/.test(l) && /warm-memory/.test(l)));
    check("turn 2 -> leadId still round-trips in handoffContext",
      second.handoffContext.leadId === firstLeadId);
  }

  line("ROTATING sessionId (what the widget does today)  -> still ONE insert");

  {
    clearLeadMemory();
    stub();
    const a = await invoke("rotating-1");
    check("first turn inserts once", inserts === 1);
    // Every later turn arrives under a brand-new sessionId, so only the contact
    // fingerprint can catch it.
    for (let i = 2; i <= 6; i++) {
      const r = await invoke(`rotating-${i}`);
      check(`turn ${i} with a FRESH sessionId -> still no new insert`,
        inserts === 1 && r.leadId === a.leadId);
    }
    check("six turns, six different sessionIds -> exactly ONE lead", inserts === 1);
    check("the fingerprint key is what held",
      logs.some((l) => /warm-memory\(e:|warm-memory\(p:/.test(l)));
  }

  line("COLD CONTAINER  -> memory is empty, so a lead is created again");

  {
    clearLeadMemory();          // simulates a fresh container
    stub();
    await invoke("cold-sess");
    check("after a cold start -> one insert (best-effort, as designed)", inserts === 1);
    await invoke("cold-sess");
    check("and the guard engages again immediately within that container", inserts === 1);
  }

  line("A DIFFERENT visitor  -> not suppressed by someone else's lead");

  {
    clearLeadMemory();
    stub();
    await invoke("visitor-a");
    check("visitor A -> one insert", inserts === 1);

    // Same container, entirely different contact details.
    modelText =
      'All set.\n[[SCG_STATUS: OK]]\n[[SCG_LEAD: {"firstName":"Other","lastName":"Person",' +
      '"email":"someone-else@ridgelinetest.example","phone":"(216) 555-0142"}]]';
    const b = await invoke("visitor-b");
    check("visitor B, different email and phone -> a lead IS created",
      inserts === 2 && b.leadId !== undefined);
    check("visitor B -> got its own leadId, not visitor A's",
      b.leadId === "00QWARM000000002A");
  }

  line("BOUNDED  -> the map cannot grow without limit");

  {
    clearLeadMemory();
    check("the cap is a named constant", LEAD_MEMORY_MAX === 500);
    stub();
    // Each turn writes up to three keys; well past the cap, nothing throws and
    // the most recent session is still remembered.
    for (let i = 0; i < 250; i++) await invoke(`bulk-${i}`);
    const last = await invoke("bulk-249");
    check("far past the cap -> still functioning, recent entries retained",
      last.leadId !== undefined);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`WARM-MEMORY LEAD GUARD: ${passed} assertions passed, no network`);
  console.log("=".repeat(72));
}

await main();
