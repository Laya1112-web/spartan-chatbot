/**
 * Proves the two fixes behind the stiff, incoherent 848 replies of 2026-08-30.
 *
 *   node test/whatsapp-burst.js
 *
 * No network: Salesforce, Claude and the Graph API are stubbed at
 * globalThis.fetch. The Salesforce stub is a small REAL store rather than a
 * fixture — Message__c rows are written, kept and queried back in SOQL order —
 * because both fixes turn on what a SECOND concurrent job sees after the first
 * one has written, and a static fixture cannot express that.
 *
 * The claims under test:
 *   1. A rep's Outbound is replayed as ATTRIBUTED CONTEXT in a user turn, never
 *      as an assistant turn, so the model stops imitating a rep's register.
 *   2. The bot's own Outbound is still an assistant turn.
 *   3. When the integration user cannot be resolved, history DEGRADES to the old
 *      all-Outbound-is-assistant behaviour and logs — it does not suppress.
 *   4. Two rapid inbounds produce exactly ONE reply: the loser yields silently,
 *      the winner answers the whole burst.
 *   5. A single inbound still gets its reply.
 *   6. The election yields only on positive evidence of being superseded.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1223591704179782";
process.env.WHATSAPP_ACCESS_TOKEN = "EAAG_test_token";
process.env.WHATSAPP_APP_SECRET = "test-app-secret-abc123";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
process.env.WHATSAPP_ASYNC = "false";
delete process.env.WIDGET_TOKEN;

{
  const crypto = await import("node:crypto");
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env.SF_CLIENT_ID = "3MVGTEST_NOT_REAL";
  process.env.SF_USERNAME = "test@example.invalid";
  process.env.SF_PRIVATE_KEY = privateKey;
}

const BOT_USER = "005Vr00000VA88vIAD";   // the integration user (chatbot@...prod)
const REP_USER = "005Vr00000REP01AAA";   // a human rep in Salesforce
const CONV_ID = "a3IVr000002No9RMAS";
const WA_ID = "17323975063";

let passed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}`); }
}
function line(t) { console.log(`\n${t}\n${"-".repeat(t.length)}`); }
const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { "Content-Type": "application/json" },
});

/* ---------------------------------------------------------------- *
 * A small in-memory Salesforce
 * ---------------------------------------------------------------- */

let store = null;

function world({ identityUrl = `https://login.salesforce.com/id/00D000000000000EAA/${BOT_USER}`,
                 messages = [], status = "New" } = {}) {
  // salesforce.js caches the access token across calls, and the identity URL
  // rides on it — so a world that changes the identity must drop that cache or
  // it silently inherits the previous world's integration user.
  invalidateSfToken();

  store = {
    identityUrl,
    status,
    seq: messages.length,
    messages: messages.slice(),   // {Id, Body__c, Direction__c, Sent_At__c, CreatedById}
    claude: 0,
    sends: [],
    claudeThreads: [],
  };
  return store;
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || "GET";
  // The OAuth token call posts form-encoded data, not JSON — parsing must not
  // throw here or every Salesforce-backed assertion fails for the wrong reason.
  let body = null;
  if (init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }
  const s = store;

  if (u.includes("anthropic.com")) {
    s.claude++;
    s.claudeThreads.push(body.messages);
    return json({
      id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "Happy to help with that.\n[[SCG_STATUS: OK]]" }],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  if (u.includes("graph.facebook.com")) {
    s.sends.push(body);
    return json({ messages: [{ id: `wamid.SENT${s.sends.length}` }] });
  }

  if (u.includes("oauth2/token")) {
    const auth = { access_token: "T", instance_url: "https://example.my.salesforce.com" };
    if (s.identityUrl) auth.id = s.identityUrl;
    return json(auth);
  }

  if (u.includes("/Whatsapp_Wa_Id__c/") && method === "GET") {
    return json({ Id: CONV_ID, Status__c: s.status, Assigned_To__c: null, Lead__c: null,
                  Channel__c: "WhatsApp" });
  }

  if (u.includes("/sobjects/Message__c/") && method === "POST") {
    const id = `a02M${String(++s.seq).padStart(4, "0")}`;
    s.messages.push({
      Id: id,
      Body__c: body.Body__c,
      Direction__c: body.Direction__c,
      Sent_At__c: body.Sent_At__c,
      CreatedById: BOT_USER,           // Salesforce stamps the caller; here, the Lambda
    });
    return json({ id, success: true }, 201);
  }

  if (u.includes("/query/")) {
    const soql = decodeURIComponent(u.split("?q=")[1] || "");
    let rows = s.messages.slice();
    if (soql.includes("Direction__c = 'Inbound'")) {
      rows = rows.filter((m) => m.Direction__c === "Inbound");
    }
    rows.sort((a, b) => {
      const t = Date.parse(b.Sent_At__c) - Date.parse(a.Sent_At__c);
      return t !== 0 ? t : (a.Id < b.Id ? 1 : a.Id > b.Id ? -1 : 0);
    });
    return json({ totalSize: rows.length, done: true, records: rows });
  }

  return new Response(null, { status: 204 });
};

const quiet = { log() {}, warn() {}, error() {} };

const {
  fetchTranscript, recentInboundIds, REP_TURN_LABEL,
} = await import("../whatsappConversation.js");
const {
  processWhatsAppMessage, yieldToNewerInbound, BURST_DEBOUNCE_MS,
} = await import("../whatsappWebhook.js");
const { authSession } = await import("../conversation.js");
const { invalidateSfToken } = await import("../salesforce.js");

const inbound = (text, wamid, at) => ({
  waId: WA_ID, wamid, text, type: "text", timestamp: at,
});

async function main() {

  line("1. History: who SAID it decides the role");

  {
    world({ messages: [
      { Id: "a02M0001", Body__c: "I need funding", Direction__c: "Inbound",
        Sent_At__c: "2026-08-28T10:00:00.000Z", CreatedById: BOT_USER },
      { Id: "a02M0002", Body__c: "Happy to help! What is your first name?",
        Direction__c: "Outbound", Sent_At__c: "2026-08-28T10:00:05.000Z", CreatedById: BOT_USER },
      { Id: "a02M0003", Body__c: "Hello! Are you interested in Business Funding?",
        Direction__c: "Outbound", Sent_At__c: "2026-08-28T10:01:00.000Z", CreatedById: REP_USER },
    ] });

    const turns = await fetchTranscript({
      conversationId: CONV_ID, auth: authSession(), logger: quiet,
    });

    const repTurn = turns.find((t) => t.content.includes("Are you interested in Business Funding?"));
    check("a rep's Outbound is NOT an assistant turn", repTurn && repTurn.role !== "assistant");
    check("a rep's Outbound comes back as a USER turn", repTurn && repTurn.role === "user");
    check("a rep's Outbound is attributed, not quoted as the model's own voice",
      repTurn && repTurn.content.includes(REP_TURN_LABEL));
    check("the rep's actual words are preserved inside the attribution",
      repTurn && repTurn.content.includes("Hello! Are you interested in Business Funding?"));

    const botTurn = turns.find((t) => t.content.includes("What is your first name?"));
    check("the BOT's own Outbound is still an assistant turn",
      botTurn && botTurn.role === "assistant");
    check("the visitor's Inbound is still a user turn",
      turns.some((t) => t.role === "user" && t.content.includes("I need funding")));
    check("no turn carries a rep's words as role=assistant",
      !turns.some((t) => t.role === "assistant" &&
        t.content.includes("Are you interested in Business Funding?")));
  }

  line("2. Null integration user  -> DEGRADE, never suppress");

  {
    // No identity URL on the token and no override: integrationUserId -> null.
    delete process.env.SF_INTEGRATION_USER_ID;
    world({ identityUrl: null, messages: [
      { Id: "a02M0001", Body__c: "I need funding", Direction__c: "Inbound",
        Sent_At__c: "2026-08-28T10:00:00.000Z", CreatedById: BOT_USER },
      { Id: "a02M0002", Body__c: "Hello! Are you interested in Business Funding?",
        Direction__c: "Outbound", Sent_At__c: "2026-08-28T10:01:00.000Z", CreatedById: REP_USER },
    ] });

    const logged = [];
    const turns = await fetchTranscript({
      conversationId: CONV_ID, auth: authSession(),
      logger: { log() {}, warn() {}, error: (m) => logged.push(String(m)) },
    });

    check("history is NOT suppressed when the bot user is unknown", turns.length > 0);
    check("the visitor's own words survive", turns.some((t) => t.content.includes("I need funding")));
    check("it degrades to the OLD behaviour: rep Outbound replayed as assistant",
      turns.some((t) => t.role === "assistant" &&
        t.content.includes("Are you interested in Business Funding?")));
    check("and it says so loudly", logged.some((m) => m.includes("cannot identify the integration user")));
    check("the log explains this degrades tone, not correctness",
      logged.some((m) => m.includes("degrades tone")));
  }

  line("3. The election  -> yields only on positive evidence");

  {
    const base = { conversationId: CONV_ID, myInboundId: "a02M0002", auth: null, logger: quiet };
    const noSleep = { sleep: async () => {} };

    check("newest (index 0) -> answers",
      (await yieldToNewerInbound({ ...base, deps: {
        ...noSleep, recentInboundIds: async () => ["a02M0002", "a02M0001"] } })) === false);

    check("superseded (index > 0) -> yields",
      (await yieldToNewerInbound({ ...base, deps: {
        ...noSleep, recentInboundIds: async () => ["a02M0003", "a02M0002"] } })) === true);

    check("own row not visible yet -> ANSWERS (never silence)",
      (await yieldToNewerInbound({ ...base, deps: {
        ...noSleep, recentInboundIds: async () => ["a02M0001"] } })) === false);

    check("query failed / empty list -> answers",
      (await yieldToNewerInbound({ ...base, deps: {
        ...noSleep, recentInboundIds: async () => [] } })) === false);

    check("no row id (the inbound write failed) -> answers, and never waits",
      (await yieldToNewerInbound({ ...base, myInboundId: null, deps: {
        sleep: async () => { throw new Error("must not sleep"); },
        recentInboundIds: async () => { throw new Error("must not query"); } } })) === false);

    const saved = process.env.WHATSAPP_BURST_DEBOUNCE_MS;
    process.env.WHATSAPP_BURST_DEBOUNCE_MS = "0";
    check("debounce disabled with 0 -> answers immediately, no wait, no query",
      (await yieldToNewerInbound({ ...base, deps: {
        sleep: async () => { throw new Error("must not sleep"); },
        recentInboundIds: async () => { throw new Error("must not query"); } } })) === false);
    if (saved === undefined) delete process.env.WHATSAPP_BURST_DEBOUNCE_MS;
    else process.env.WHATSAPP_BURST_DEBOUNCE_MS = saved;

    check("the default window is a tunable named constant", BURST_DEBOUNCE_MS === 1500);
  }

  line("4. Election ordering  -> Sent_At__c DESC, then Id DESC, Inbound only");

  {
    world({ messages: [
      { Id: "a02M0001", Body__c: "first", Direction__c: "Inbound",
        Sent_At__c: "2026-08-30T00:44:59.000Z", CreatedById: BOT_USER },
      { Id: "a02M0009", Body__c: "a bot reply", Direction__c: "Outbound",
        Sent_At__c: "2026-08-30T00:45:30.000Z", CreatedById: BOT_USER },
      { Id: "a02M0002", Body__c: "second", Direction__c: "Inbound",
        Sent_At__c: "2026-08-30T00:45:00.000Z", CreatedById: BOT_USER },
      { Id: "a02M0003", Body__c: "tie with second", Direction__c: "Inbound",
        Sent_At__c: "2026-08-30T00:45:00.000Z", CreatedById: BOT_USER },
    ] });

    const ids = await recentInboundIds({ conversationId: CONV_ID, auth: authSession(), logger: quiet });
    check("Outbound rows are excluded from the election", !ids.includes("a02M0009"));
    check("newest Sent_At__c first", ids[0] === "a02M0003" || ids[0] === "a02M0002");
    check("an equal Sent_At__c is broken deterministically by Id DESC",
      ids.indexOf("a02M0003") < ids.indexOf("a02M0002"));
    check("the oldest inbound sorts last", ids[ids.length - 1] === "a02M0001");
  }

  line("5. A burst of two rapid texts  -> exactly ONE reply");

  {
    world();

    // A barrier for a sleep: each job writes its inbound, then parks here. Both
    // are released only once BOTH have written, which is precisely the race the
    // debounce exists to survive — expressed without depending on wall-clock.
    let release;
    const bothWritten = new Promise((r) => { release = r; });
    let parked = 0;
    const barrier = async () => { if (++parked === 2) release(); await bothWritten; };

    let clock = Date.parse("2026-08-30T00:44:59.000Z");
    const tick = () => new Date(clock += 1000).toISOString();

    const results = await Promise.all([
      processWhatsAppMessage(inbound("Hi", "wamid.A", "2026-08-30T00:44:59.000Z"),
        { logger: quiet, deps: { sleep: barrier, now: tick } }),
      processWhatsAppMessage(inbound("I need funding", "wamid.B", "2026-08-30T00:45:00.000Z"),
        { logger: quiet, deps: { sleep: barrier, now: tick } }),
    ]);

    check("the model was called exactly ONCE for the burst", store.claude === 1);
    check("exactly ONE reply was sent to the visitor", store.sends.length === 1);
    check("exactly one job yielded", results.filter((r) => r.yielded).length === 1);
    check("the other job answered", results.filter((r) => r.sent).length === 1);

    const thread = store.claudeThreads[0];
    const flat = thread.map((m) => `${m.role}:${m.content}`).join(" | ");
    check("BOTH of the visitor's texts reached the model", flat.includes("Hi") && flat.includes("I need funding"));
    check("the thread handed to the model ends on the visitor",
      thread[thread.length - 1].role === "user");
    check("both inbounds were still recorded in Salesforce",
      store.messages.filter((m) => m.Direction__c === "Inbound").length === 2);
    check("the loser sent nothing of its own", store.sends.length === 1);
  }

  line("6. A single text  -> still answered");

  {
    world();
    const res = await processWhatsAppMessage(
      inbound("Do you fund HVAC?", "wamid.SOLO", "2026-08-30T01:00:00.000Z"),
      { logger: quiet, deps: { sleep: async () => {} } },
    );
    check("a lone inbound is not mistaken for a loser", !res.yielded);
    check("the model ran", store.claude === 1);
    check("the visitor got their reply", store.sends.length === 1);
    check("its own message is in the thread the model saw",
      JSON.stringify(store.claudeThreads[0]).includes("Do you fund HVAC?"));
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`WHATSAPP BURST + HISTORY AUTHORSHIP: ${passed} assertions passed`);
  console.log("=".repeat(72));
  if (failures.length) {
    console.log(`\n${failures.length} FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  assert.strictEqual(failures.length, 0, `${failures.length} assertion(s) failed`);
}

await main();
