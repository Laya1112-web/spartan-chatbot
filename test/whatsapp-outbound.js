/**
 * The rep-send endpoint: POST /whatsapp/send.
 *
 *   node test/whatsapp-outbound.js
 *
 * No network. Meta's Graph API and Salesforce are stubbed at globalThis.fetch,
 * and every call is recorded — so "Meta was never called" is asserted against
 * the actual traffic, which is the whole point of the 24-hour-window guard.
 *
 * The claims under test:
 *   1. Only Salesforce gets in: a missing, wrong, or unconfigured shared secret
 *      is a 401 that reaches neither Salesforce nor Meta.
 *   2. Inside the 24h window, a rep's text is sent as a correctly shaped Cloud
 *      API call and the wamid comes back for Salesforce to record.
 *   3. Outside the window, a stable `outside_24h_window` error is returned and
 *      META IS NEVER CALLED.
 *   4. A Meta rejection is surfaced verbatim, never swallowed.
 *   5. The recipient is derived from the conversation, so the endpoint cannot
 *      be used as an open relay even by a caller holding the secret.
 *   6. This endpoint writes NO Message__c — Salesforce owns that write.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;
process.env.WHATSAPP_PHONE_NUMBER_ID = "1240388075832660";
process.env.WHATSAPP_ACCESS_TOKEN = "EAAG_test_token";
process.env.SF_TO_LAMBDA_SECRET = "test-sf-secret-abc123";
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

const { handler, setClock } = await import("../index.js");
const { windowState, WINDOW_MS, SF_SECRET_HEADER } = await import("../whatsappOutbound.js");

/** Fixed "now". Every lastInbound below is expressed relative to it. */
const NOW = new Date("2026-08-28T18:00:00.000Z");
setClock(() => NOW);
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

const CONV = "a3IVr000002No9RMAS";
const WA = "17323975063";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const noBody = (s) => new Response(null, { status: s });
const parse = (b) => { try { return JSON.parse(b); } catch { return null; } };

let current = null;
function world({ conversation, sendStatus = 200, sfError = false } = {}) {
  current = { conversation, sendStatus, sfError, calls: [], sends: [] };
  return current;
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url), m = init.method || "GET";
  const st = current;
  st.calls.push({ method: m, url: u, body: parse(init.body), headers: init.headers || {} });

  if (u.includes("graph.facebook.com")) {
    st.sends.push({ url: u, body: parse(init.body), headers: init.headers });
    if (st.sendStatus !== 200) {
      return json({ error: { message: "(#131047) Re-engagement message", code: 131047 } }, st.sendStatus);
    }
    return json({ messaging_product: "whatsapp", messages: [{ id: "wamid.REP1" }] });
  }
  if (u.includes("oauth2/token")) {
    return json({ access_token: "T", instance_url: "https://x.my.salesforce.com" });
  }
  if (u.includes(`/sobjects/Conversation__c/${CONV}`)) {
    if (st.sfError) return json({ error: "boom" }, 500);
    return st.conversation === null ? noBody(404) : json(st.conversation);
  }
  return noBody(204);
};

const conv = (over = {}) => ({
  Id: CONV, Status__c: "Claimed", Whatsapp_Wa_Id__c: WA,
  Channel__c: "WhatsApp", Lead__c: null,
  Last_Inbound_At__c: hoursAgo(2), ...over,
});

async function send(body, { secret = process.env.SF_TO_LAMBDA_SECRET, method = "POST", path = "/whatsapp/send" } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== null) headers[SF_SECRET_HEADER] = secret;
  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    const res = await handler({
      rawPath: path, requestContext: { http: { method, path } },
      headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realErr;
  }
}

async function main() {
  line("1. AUTH  -> only Salesforce gets in");

  {
    const st = world({ conversation: conv() });
    const r = await send({ conversationId: CONV, text: "Hi, this is Dana from Spartan." });
    check("valid shared secret -> 200", r.status === 200 && r.body.ok === true);
    check("valid secret -> the message actually went to Meta", st.sends.length === 1);
  }

  {
    const st = world({ conversation: conv() });
    const r = await send({ conversationId: CONV, text: "hello" }, { secret: "wrong-secret" });
    check("wrong secret -> 401", r.status === 401 && r.body.error === "unauthorized");
    check("wrong secret -> Meta never called", st.sends.length === 0);
    check("wrong secret -> Salesforce never called", st.calls.length === 0);
  }

  {
    const st = world({ conversation: conv() });
    const r = await send({ conversationId: CONV, text: "hello" }, { secret: null });
    check("missing secret header -> 401", r.status === 401);
    check("missing secret -> nothing downstream was touched", st.calls.length === 0);
  }

  {
    const st = world({ conversation: conv() });
    const saved = process.env.SF_TO_LAMBDA_SECRET;
    delete process.env.SF_TO_LAMBDA_SECRET;
    const r = await send({ conversationId: CONV, text: "hello" }, { secret: saved });
    process.env.SF_TO_LAMBDA_SECRET = saved;
    check("SF_TO_LAMBDA_SECRET unset -> 401, FAILS CLOSED", r.status === 401);
    check("unset secret -> Meta never called", st.sends.length === 0);
  }

  {
    world({ conversation: conv() });
    const r = await send({ conversationId: CONV, text: "hi" }, { method: "GET" });
    check("GET -> 405", r.status === 405 && r.body.error === "method_not_allowed");
  }

  line("2. INSIDE the window  -> sends, and hands back the wamid");

  {
    const st = world({ conversation: conv({ Last_Inbound_At__c: hoursAgo(2) }) });
    const r = await send({ conversationId: CONV, text: "Your application is approved." });

    check("2h since last inbound -> 200", r.status === 200);
    check("returns the wamid for Salesforce to record", r.body.wamid === "wamid.REP1");
    check("reports the window as open, with an expiry", r.body.windowOpen === true &&
      r.body.windowExpiresAt === new Date(Date.parse(hoursAgo(2)) + WINDOW_MS).toISOString());
    check("echoes the conversation and resolved recipient",
      r.body.conversationId === CONV && r.body.waId === WA);

    const s = st.sends[0];
    check("POSTs to the v23.0 messages endpoint for our number",
      s.url === `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
    check("bearer is the env access token",
      s.headers.Authorization === `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`);
    check("body is a whatsapp text to the customer",
      s.body.messaging_product === "whatsapp" && s.body.type === "text" &&
      s.body.to === WA && s.body.text.body === "Your application is approved.");
  }

  {
    const st = world({ conversation: conv({ Last_Inbound_At__c: hoursAgo(23.9) }) });
    const r = await send({ conversationId: CONV, text: "just inside" });
    check("23.9h -> still inside the window, sends", r.status === 200 && st.sends.length === 1);
  }

  line("3. OUTSIDE the window  -> refused, and META IS NEVER CALLED");

  {
    const st = world({ conversation: conv({ Last_Inbound_At__c: hoursAgo(25) }) });
    const r = await send({ conversationId: CONV, text: "too late" });

    check("25h since last inbound -> 422", r.status === 422);
    check("stable error code the panel can branch on",
      r.body.error === "outside_24h_window");
    check("META WAS NEVER CALLED", st.sends.length === 0);
    check("tells the rep how stale the thread is",
      r.body.hoursSinceLastInbound === 25 && r.body.lastInboundAt === hoursAgo(25));
    check("explains that a template would be needed",
      /approved template/.test(r.body.message));
  }

  {
    const st = world({ conversation: conv({ Last_Inbound_At__c: hoursAgo(24.1) }) });
    const r = await send({ conversationId: CONV, text: "just outside" });
    check("24.1h -> just outside, refused without calling Meta",
      r.status === 422 && st.sends.length === 0);
  }

  {
    // A conversation with no stamp cannot be judged. Refusing would block
    // legitimate replies on legacy threads, so it attempts and lets Meta rule.
    const st = world({ conversation: conv({ Last_Inbound_At__c: null }) });
    const r = await send({ conversationId: CONV, text: "unknown window" });
    check("no Last_Inbound_At__c -> attempts the send rather than refusing",
      r.status === 200 && st.sends.length === 1);
    check("and says the window is unknown, not open",
      r.body.windowUnknown === true && r.body.windowOpen === null);
  }

  line("4. META FAILURE  -> surfaced, never swallowed");

  {
    const st = world({ conversation: conv(), sendStatus: 400 });
    const r = await send({ conversationId: CONV, text: "will fail" });
    check("Meta rejects -> 502", r.status === 502);
    check("error code is machine-readable", r.body.error === "meta_send_failed");
    check("Meta's own message is passed through to the rep",
      /131047|Re-engagement/.test(r.body.message));
    check("Meta's HTTP status is reported", r.body.metaStatus === 400);
  }

  line("5. THE RECIPIENT COMES FROM THE CONVERSATION  -> not an open relay");

  {
    const st = world({ conversation: conv() });
    const r = await send({ conversationId: CONV, waId: "19995550123", text: "relay attempt" });
    check("a waId that contradicts the conversation -> 400, refused",
      r.status === 400 && r.body.error === "wa_id_mismatch");
    check("relay attempt -> Meta never called", st.sends.length === 0);
  }

  {
    const st = world({ conversation: conv() });
    const r = await send({ conversationId: CONV, waId: `+${WA}`, text: "matching assertion" });
    check("a matching waId (even +-prefixed) is accepted", r.status === 200);
    check("and the address used is the conversation's", st.sends[0].body.to === WA);
  }

  {
    const st = world({ conversation: null });
    const r = await send({ conversationId: CONV, text: "no such thread" });
    check("unknown conversation -> 404", r.status === 404 && r.body.error === "conversation_not_found");
    check("unknown conversation -> Meta never called", st.sends.length === 0);
  }

  {
    const st = world({ conversation: conv({ Whatsapp_Wa_Id__c: null, Channel__c: "Web" }) });
    const r = await send({ conversationId: CONV, text: "web thread" });
    check("a web conversation -> 409 not_a_whatsapp_conversation",
      r.status === 409 && r.body.error === "not_a_whatsapp_conversation");
    check("web conversation -> Meta never called", st.sends.length === 0);
  }

  line("6. VALIDATION + THE MESSAGE__C DECISION");

  {
    world({ conversation: conv() });
    check("missing conversationId -> 400",
      (await send({ text: "x" })).body.error === "bad_request");
    check("missing text -> 400",
      (await send({ conversationId: CONV })).body.error === "bad_request");
    check("blank text -> 400",
      (await send({ conversationId: CONV, text: "   " })).body.error === "bad_request");
    check("over-long text -> 400 text_too_long",
      (await send({ conversationId: CONV, text: "x".repeat(4001) })).body.error === "text_too_long");
    check("non-JSON body -> 400", (await send(undefined)).body.error === "bad_request");
  }

  {
    // THE DECISION: Salesforce writes the Message__c, not the Lambda. If this
    // Lambda wrote it, CreatedById would be the integration user — the BOT —
    // and conversation.js's poll filter would classify a rep's reply as a bot
    // message and drop it. Asserted as an absence so it cannot regress.
    const st = world({ conversation: conv() });
    await send({ conversationId: CONV, text: "rep reply" });
    const writes = st.calls.filter((c) => c.url.includes("/sobjects/Message__c"));
    check("NO Message__c is written by the Lambda (Salesforce owns that write)",
      writes.length === 0);
    check("the only Salesforce traffic is the conversation read",
      st.calls.filter((c) => c.method !== "GET" && !c.url.includes("oauth2/token") &&
        !c.url.includes("graph.facebook.com")).length === 0);
  }

  line("7. windowState  -> the pure boundary logic");

  {
    const now = NOW.getTime();
    check("2h ago -> open", windowState(hoursAgo(2), now).open === true);
    check("exactly 24h -> closed (boundary is exclusive)",
      windowState(hoursAgo(24), now).open === false);
    check("null -> unknown, not expired", windowState(null, now).known === false);
    check("garbage -> unknown, not expired", windowState("not-a-date", now).known === false);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`WHATSAPP REP SEND: ${passed} assertions passed, zero real network calls`);
  console.log("=".repeat(72));
}

await main();
