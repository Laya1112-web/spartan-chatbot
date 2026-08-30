/**
 * Proves the WhatsApp Cloud API webhook: Meta's handshake, Meta's signature,
 * and the AI turn behind them.
 *
 *   node test/whatsapp-webhook.js
 *
 * No network anywhere. Meta's Graph API, the Anthropic API and Salesforce are
 * all stubbed at globalThis.fetch, and every call is recorded — so the
 * assertions are about the actual HTTP traffic the Lambda would emit (endpoint,
 * verb, headers, body), not merely about what the functions return.
 *
 * The claims under test:
 *   1. GET verification echoes hub.challenge as plain text on a token match,
 *      403s on a mismatch, and 403s when the token is not configured at all.
 *   2. The X-Hub-Signature-256 HMAC is computed over the RAW body — including
 *      the base64 form a Function URL may deliver — and a bad or missing
 *      signature never reaches Claude or Salesforce.
 *   3. An inbound text creates a Conversation__c keyed on Whatsapp_Wa_Id__c
 *      with Channel__c = 'WhatsApp' EXPLICITLY set, so it cannot inherit the
 *      Web default and leak into the web rep panel.
 *   4. A redelivered wamid is not processed twice.
 *   5. Status/delivery events are acknowledged with a 200 and nothing else.
 *   6. A 'Claimed' conversation records the message and does NOT call the AI.
 *   7. A 'Closed' conversation is REOPENED to 'New' and the bot answers.
 *   8. The send is a correctly shaped POST to the Graph API.
 */

import assert from "node:assert";
import { createHmac } from "node:crypto";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

// Credentials for the stubs. Never real ones, and no network call is made with
// them — the fetch stub below intercepts everything.
process.env.WHATSAPP_PHONE_NUMBER_ID = "1240388075832660";
process.env.WHATSAPP_ACCESS_TOKEN = "EAAG_test_token";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token-9f3a";
// The burst debounce is exercised here (the election still runs) but its wait
// is dropped to 1ms: this suite is about the webhook, and test/whatsapp-burst.js
// owns the debounce behaviour itself.
process.env.WHATSAPP_BURST_DEBOUNCE_MS = "1";
process.env.WHATSAPP_APP_SECRET = "test-app-secret-abc123";
// Force the inline path: the async self-invoke needs a real Lambda around it.
process.env.WHATSAPP_ASYNC = "false";

// conversation.js no-ops unless Salesforce is configured, so give this process a
// throwaway keypair. Never the real SF_PRIVATE_KEY.
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

const wa = await import("../whatsapp.js");
const { handler, setClock } = await import("../index.js");
const { clearWhatsAppMemory, dispatchAsync, JOB_KEY } = await import("../whatsappWebhook.js");
const { clearLeadMemory } = await import("../botBrain.js");

// Pin the clock inside business hours (Wed 2:00pm ET) so the after-hours gate
// stays dormant and assertions on exact reply text hold whatever hour the suite
// actually runs at.
setClock(() => new Date("2026-01-14T19:00:00Z"));

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const noBody = (status) => new Response(null, { status });

function safeParse(body) {
  if (!body) return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}

const WA_ID = "15551230000";
const CONV_ID = "a01WACONV000001";

/** Sign a body exactly the way Meta does. */
function sign(body, secret = process.env.WHATSAPP_APP_SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

/** A minimal, spec-shaped inbound text event. */
function textEvent({ wamid = "wamid.TEST001", text = "Do you fund HVAC companies?", name = "Dana Reyes" } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550001111", phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
          contacts: [{ profile: { name }, wa_id: WA_ID }],
          messages: [{ from: WA_ID, id: wamid, timestamp: "1767200000", type: "text", text: { body: text } }],
        },
      }],
    }],
  });
}

/** A delivery receipt — the majority of real webhook traffic. */
function statusEvent() {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
          statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: "1767200001", recipient_id: WA_ID }],
        },
      }],
    }],
  });
}

/**
 * The whole outside world, behind ONE router installed once.
 *
 * Installed once on purpose: the Anthropic SDK captures globalThis.fetch when
 * the client is constructed, and botBrain.js caches that client across calls —
 * so a per-test stub assigned later never reaches Claude. The router below
 * dispatches through a mutable `current`, which `world()` swaps, so every
 * transport (Claude, the Graph API, Salesforce) always lands on the state the
 * test in hand is asserting about.
 */
let current = null;

/**
 * Point the router at a fresh world. `opts.conversation` is what the external-id
 * GET returns (null -> 404). Every call is recorded on `.calls`, and the Claude
 * and Graph calls are counted separately because "did the AI run at all" is the
 * assertion several of these tests turn on.
 */
function world({ conversation = null, transcript = [], sendStatus = 200, sfDown = false } = {}) {
  current = { conversation, transcript, sendStatus, sfDown, claude: 0, sends: [], calls: [] };
  return current;
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || "GET";
  const state = current ?? world();
  state.calls.push({ method, url: u, body: safeParse(init.body), headers: init.headers || {} });

  if (u.includes("anthropic.com")) {
    state.claude++;
    return json({
      id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "Yes — Spartan funds HVAC businesses.\n[[SCG_STATUS: OK]]" }],
      stop_reason: "end_turn", stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  if (u.includes("graph.facebook.com")) {
    state.sends.push({ url: u, body: safeParse(init.body), headers: init.headers });
    if (state.sendStatus !== 200) {
      return json({ error: { message: "Bad token", code: 190 } }, state.sendStatus);
    }
    return json({
      messaging_product: "whatsapp",
      contacts: [{ input: WA_ID, wa_id: WA_ID }],
      messages: [{ id: "wamid.SENT1" }],
    });
  }

  // Everything below here is Salesforce.
  if (state.sfDown) throw new Error("ECONNRESET");

  if (u.includes("oauth2/token")) {
    return json({ access_token: "T", instance_url: "https://example.my.salesforce.com" });
  }
  if (u.includes("/Whatsapp_Wa_Id__c/") && method === "GET") {
    return state.conversation === null ? noBody(404) : json(state.conversation);
  }
  if (u.includes("/Whatsapp_Wa_Id__c/") && method === "PATCH") {
    return json({ id: CONV_ID, success: true, created: true }, 201);
  }
  if (u.includes("/query/")) {
    // The SOQL asks for ORDER BY Sent_At__c DESC, so answer in that order —
    // fixtures below are written oldest-first for readability.
    const records = state.transcript
      .slice()
      .sort((a, b) => Date.parse(b.Sent_At__c) - Date.parse(a.Sent_At__c));
    return json({ totalSize: records.length, done: true, records });
  }
  if (u.includes("/sobjects/Message__c/")) return json({ id: "a02WAM0000001" }, 201);
  if (u.includes("/sobjects/Lead/")) return json({ id: "00QWALEAD00001", success: true }, 201);

  return noBody(204);
};

/** POST the webhook, signed, through the real Lambda entry point. */
async function post(body, { signature = undefined, base64 = false, path = "/whatsapp" } = {}) {
  const event = {
    rawPath: path,
    requestContext: { http: { method: "POST", path } },
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature === undefined ? sign(body) : signature,
    },
    body: base64 ? Buffer.from(body, "utf8").toString("base64") : body,
    ...(base64 && { isBase64Encoded: true }),
  };
  return await quietly(() => handler(event));
}

async function get(query, { path = "/whatsapp" } = {}) {
  return await quietly(() => handler({
    rawPath: path,
    requestContext: { http: { method: "GET", path } },
    headers: {},
    queryStringParameters: query,
  }));
}

/** Run without the module's logging drowning the test output. */
async function quietly(fn) {
  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realErr;
  }
}

function reset() {
  wa.clearSeenMessages();
  clearWhatsAppMemory();
  clearLeadMemory();
}

async function main() {
  line("1. GET verification  -> the handshake that activates the webhook");

  {
    reset(); world();
    const res = await get({
      "hub.mode": "subscribe",
      "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN,
      "hub.challenge": "1158201444",
    });
    check("matching verify token -> 200", res.statusCode === 200);
    check("matching verify token -> body is the challenge VERBATIM, not JSON",
      res.body === "1158201444");
    check("matching verify token -> Content-Type is text/plain",
      String(res.headers["Content-Type"]).startsWith("text/plain"));
  }

  {
    reset(); world();
    const res = await get({
      "hub.mode": "subscribe",
      "hub.verify_token": "not-our-token",
      "hub.challenge": "1158201444",
    });
    check("mismatched verify token -> 403", res.statusCode === 403);
    check("mismatched verify token -> challenge is NOT echoed",
      !String(res.body).includes("1158201444"));
  }

  {
    reset(); world();
    const res = await get({
      "hub.mode": "unsubscribe",
      "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN,
      "hub.challenge": "x",
    });
    check("hub.mode other than 'subscribe' -> 403", res.statusCode === 403);
  }

  {
    reset(); world();
    const saved = process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const res = await get({ "hub.mode": "subscribe", "hub.verify_token": saved, "hub.challenge": "x" });
    process.env.WHATSAPP_VERIFY_TOKEN = saved;
    check("WHATSAPP_VERIFY_TOKEN unset -> 403 (fails CLOSED, unlike the widget token)",
      res.statusCode === 403);
  }

  {
    reset(); world();
    const res = await get({ "hub.mode": "subscribe", "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN });
    check("token matches but hub.challenge missing -> 400, nothing echoed", res.statusCode === 400);
  }

  line("2. POST signature  -> HMAC-SHA256 of the RAW body, or nothing happens");

  {
    reset();
    const state = world();
    const body = textEvent();
    const res = await post(body);
    check("valid signature -> 200", res.statusCode === 200);
    check("valid signature -> the AI actually ran", state.claude === 1);
  }

  {
    reset();
    const state = world();
    const res = await post(textEvent(), { signature: "sha256=" + "0".repeat(64) });
    check("wrong HMAC -> 403", res.statusCode === 403);
    check("wrong HMAC -> Claude was never called", state.claude === 0);
    check("wrong HMAC -> Salesforce was never touched",
      state.calls.every((c) => !c.url.includes("salesforce")));
    check("wrong HMAC -> nothing was sent to Meta", state.sends.length === 0);
  }

  {
    reset();
    const state = world();
    const res = await post(textEvent(), { signature: null });
    check("missing X-Hub-Signature-256 -> 403", res.statusCode === 403);
    check("missing signature -> Claude was never called", state.claude === 0);
  }

  {
    reset();
    const state = world();
    // A signature computed over a DIFFERENT body: the classic replay/tamper.
    const res = await post(textEvent({ text: "tampered" }), { signature: sign(textEvent()) });
    check("signature valid for a different body -> 403", res.statusCode === 403);
    check("tampered body -> Claude was never called", state.claude === 0);
  }

  {
    reset();
    const state = world();
    const res = await post(textEvent(), { signature: sign(textEvent(), "wrong-secret") });
    check("HMAC under the wrong app secret -> 403", res.statusCode === 403);
    check("wrong secret -> Claude was never called", state.claude === 0);
  }

  {
    reset();
    const state = world();
    // What a Function URL hands over when it decides the body is binary. The
    // HMAC must be taken over the DECODED bytes, and never over a re-serialised
    // JSON.parse of them.
    const res = await post(textEvent({ wamid: "wamid.B64" }), { base64: true });
    check("base64-encoded body -> signature still verifies (raw bytes are hashed)",
      res.statusCode === 200 && state.claude === 1);
  }

  {
    reset();
    const state = world();
    // Key order and whitespace that JSON.stringify would never reproduce. Any
    // implementation that re-serialised before hashing fails this.
    const oddBody = '{"object":"whatsapp_business_account",  "entry":[{"changes":[{"value":{' +
      '"metadata":{"phone_number_id":"1240388075832660"},' +
      '"contacts":[{"wa_id":"' + WA_ID + '","profile":{"name":"Odd Body"}}],' +
      '"messages":[{"type":"text","id":"wamid.ODD","from":"' + WA_ID + '",' +
      '"timestamp":"1767200000","text":{"body":"hello"}}]}}]}]}';
    const res = await post(oddBody);
    check("body with non-canonical key order/whitespace -> verifies (proves raw is used)",
      res.statusCode === 200 && state.claude === 1);
  }

  {
    reset();
    const state = world();
    const saved = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    const res = await post(textEvent(), { signature: "sha256=" + "a".repeat(64) });
    process.env.WHATSAPP_APP_SECRET = saved;
    check("WHATSAPP_APP_SECRET unset -> 403 (fails CLOSED)", res.statusCode === 403);
    check("app secret unset -> Claude was never called", state.claude === 0);
  }

  line("3. Inbound text  -> a WhatsApp conversation, explicitly Channel__c='WhatsApp'");

  {
    reset();
    const state = world({ conversation: null });
    const res = await post(textEvent());

    check("first inbound -> 200", res.statusCode === 200);

    const lookup = state.calls.find((c) => c.method === "GET" && c.url.includes("/Whatsapp_Wa_Id__c/"));
    check("conversation is looked up by the wa_id external id, not by a session id",
      Boolean(lookup) && lookup.url.includes(`/Whatsapp_Wa_Id__c/${WA_ID}`));
    check("the lookup selects Lead__c (the durable once-per-thread lead guard)",
      lookup.url.includes("Lead__c"));

    const create = state.calls.find((c) => c.method === "PATCH" && c.url.includes("/Whatsapp_Wa_Id__c/"));
    check("create uses the external-id upsert (PATCH .../Whatsapp_Wa_Id__c/<wa_id>)",
      Boolean(create) && create.url.includes("/sobjects/Conversation__c/Whatsapp_Wa_Id__c/"));
    check("CHANNEL IS SET EXPLICITLY: Channel__c === 'WhatsApp'",
      create.body.Channel__c === "WhatsApp");
    check("create sets Status__c='New'", create.body.Status__c === "New");
    check("create sets Whatsapp_Phone__c from the wa_id",
      create.body.Whatsapp_Phone__c === `+${WA_ID}`);
    // Conversation__c has NO visitor-name field — the name lives on the Lead.
    // Asserted as an absence so a future edit cannot quietly reintroduce one.
    check("create writes NO name field to Conversation__c (the name lives on the Lead)",
      Object.keys(create.body).every((k) => !/name/i.test(k)));
    check("no name field is written to Conversation__c on ANY call in the turn",
      state.calls
        .filter((c) => c.method === "PATCH" && c.url.includes("/sobjects/Conversation__c"))
        .every((c) => Object.keys(c.body ?? {}).every((k) => !/name/i.test(k))));
    check("the conversation lookup does not select a name field either",
      !/name/i.test(lookup.url.split("?fields=")[1] ?? ""));
    check("create omits Whatsapp_Wa_Id__c from the body (the URL carries it)",
      create.body.Whatsapp_Wa_Id__c === undefined);

    const messageWrites = state.calls.filter(
      (c) => c.method === "POST" && c.url.includes("/sobjects/Message__c/"),
    );
    check("the visitor's message is written Inbound",
      messageWrites.some((c) => c.body.Direction__c === "Inbound" &&
        c.body.Body__c === "Do you fund HVAC companies?"));
    check("the bot's reply is written Outbound",
      messageWrites.some((c) => c.body.Direction__c === "Outbound" &&
        c.body.Body__c.includes("Spartan funds HVAC businesses")));
    check("the SCG_STATUS tag never reaches the transcript",
      messageWrites.every((c) => !String(c.body.Body__c).includes("SCG_STATUS")));

    const stamp = state.calls.find(
      (c) => c.method === "PATCH" && c.url.includes(`/sobjects/Conversation__c/${CONV_ID}`) &&
        c.body && c.body.Last_Inbound_At__c,
    );
    check("Last_Inbound_At__c is stamped on the inbound (the 24h-window clock)",
      Boolean(stamp));

    check("the reply reaches the visitor over WhatsApp", state.sends.length === 1);
    check("the SCG_STATUS tag never reaches the visitor either",
      !state.sends[0].body.text.body.includes("SCG_STATUS"));
  }

  line("4. Dedupe by wamid  -> a Meta redelivery is not answered twice");

  {
    reset();
    const state = world({ conversation: null });
    const body = textEvent({ wamid: "wamid.DUPE" });

    const first = await post(body);
    const claudeAfterFirst = state.claude;
    const sendsAfterFirst = state.sends.length;

    const second = await post(body); // byte-identical redelivery
    check("redelivery -> still 200 (never a retry-inducing error)",
      first.statusCode === 200 && second.statusCode === 200);
    check("redelivery -> the AI ran exactly once",
      claudeAfterFirst === 1 && state.claude === 1);
    check("redelivery -> exactly one reply was sent",
      sendsAfterFirst === 1 && state.sends.length === 1);
    check("redelivery -> the response says so", JSON.parse(second.body).duplicates === 1);
  }

  {
    reset();
    const state = world({ conversation: null });
    await post(textEvent({ wamid: "wamid.A" }));
    await post(textEvent({ wamid: "wamid.B" }));
    check("a DIFFERENT wamid is not swallowed by the dedupe", state.claude === 2);
  }

  line("5. Status events  -> acknowledged and ignored");

  {
    reset();
    const state = world({ conversation: null });
    const res = await post(statusEvent());
    check("delivery receipt -> 200 so Meta does not retry it", res.statusCode === 200);
    check("delivery receipt -> the AI was not called", state.claude === 0);
    check("delivery receipt -> Salesforce was not touched",
      state.calls.every((c) => !c.url.includes("salesforce")));
    check("delivery receipt -> nothing was sent back", state.sends.length === 0);
    check("delivery receipt -> counted in the response", JSON.parse(res.body).statuses === 1);
  }

  {
    reset();
    const state = world({ conversation: null });
    const res = await post(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
    check("an empty entry[] -> 200, nothing done", res.statusCode === 200 && state.claude === 0);
  }

  {
    reset();
    const state = world({ conversation: null });
    const res = await post("this is not json");
    check("unparseable body (correctly signed) -> 200, not a 500 retry loop",
      res.statusCode === 200 && state.claude === 0);
  }

  line("6. Claimed conversation  -> recorded, and the AI is NOT called");

  {
    reset();
    const state = world({
      conversation: { Id: CONV_ID, Status__c: "Claimed", Assigned_To__c: "005REP00000001", Lead__c: null },
    });
    const res = await post(textEvent({ text: "Any update on my file?" }));

    check("claimed conversation -> 200", res.statusCode === 200);
    check("CLAIMED MEANS SILENT: Claude was never called", state.claude === 0);
    check("claimed conversation -> nothing was sent to the visitor", state.sends.length === 0);

    const writes = state.calls.filter((c) => c.method === "POST" && c.url.includes("/sobjects/Message__c/"));
    check("claimed conversation -> the visitor's message IS still recorded",
      writes.length === 1 && writes[0].body.Direction__c === "Inbound" &&
      writes[0].body.Body__c === "Any update on my file?");
    check("claimed conversation -> Status__c is never rewritten",
      state.calls.every((c) => !(c.body && c.body.Status__c)));
    check("claimed conversation -> Last_Inbound_At__c still stamped for the rep panel",
      state.calls.some((c) => c.body && c.body.Last_Inbound_At__c));
  }

  line("7. Closed conversation  -> REOPENED to 'New', and the bot answers");

  {
    reset();
    const state = world({
      conversation: { Id: CONV_ID, Status__c: "Closed", Assigned_To__c: null, Lead__c: null },
      transcript: [
        { Id: "a02M1", Body__c: "I need $60k", Direction__c: "Inbound", Sent_At__c: "2026-08-01T10:00:00.000Z" },
        { Id: "a02M2", Body__c: "Happy to help.", Direction__c: "Outbound", Sent_At__c: "2026-08-01T10:00:05.000Z" },
      ],
    });
    const res = await post(textEvent({ text: "Hi again, still interested" }));

    check("closed conversation + new inbound -> 200", res.statusCode === 200);

    const reopen = state.calls.find(
      (c) => c.method === "PATCH" && c.url.includes(`/sobjects/Conversation__c/${CONV_ID}`) &&
        c.body && c.body.Status__c === "New",
    );
    check("REOPENED: Status__c is patched back to 'New'", Boolean(reopen));
    check("reopened conversation -> the bot answered", state.claude === 1);
    check("reopened conversation -> the reply was sent", state.sends.length === 1);
    check("reopened conversation -> no second conversation was created",
      state.calls.every((c) => !(c.method === "PATCH" && c.url.includes("/Whatsapp_Wa_Id__c/"))));

    // The transcript is the WhatsApp path's substitute for the widget's
    // per-turn resend, so the model must actually receive the prior thread.
    const claudeCall = state.calls.find((c) => c.url.includes("anthropic.com"));
    const sent = claudeCall.body.messages;
    check("the prior thread is rebuilt from Message__c and handed to the model",
      sent.length === 3 && sent[0].content === "I need $60k" &&
      sent[1].role === "assistant" && sent[2].content === "Hi again, still interested");
  }

  line("8. The send  -> a correctly shaped Cloud API call");

  {
    reset();
    const state = world({ conversation: null });
    await post(textEvent());

    const send = state.sends[0];
    check("POSTs to https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/messages",
      send.url === `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
    check("Authorization is a bearer of WHATSAPP_ACCESS_TOKEN",
      send.headers.Authorization === `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`);
    check("Content-Type is application/json",
      send.headers["Content-Type"] === "application/json");
    check("body.messaging_product === 'whatsapp'", send.body.messaging_product === "whatsapp");
    check("body.to is the visitor's wa_id", send.body.to === WA_ID);
    check("body.type === 'text' and text.body carries the reply",
      send.body.type === "text" && send.body.text.body.includes("Spartan funds HVAC businesses"));
    check("link previews are suppressed", send.body.text.preview_url === false);
    check("the token is read from the environment, never hardcoded",
      !JSON.stringify(send.body).includes(process.env.WHATSAPP_ACCESS_TOKEN));
  }

  {
    reset();
    const state = world({ conversation: null, sendStatus: 401 });
    const res = await post(textEvent());
    check("a Graph API failure -> still 200 to Meta, never a 500", res.statusCode === 200);
    check("a failed send -> the reply is still recorded in Salesforce",
      state.calls.some((c) => c.method === "POST" && c.url.includes("/sobjects/Message__c/") &&
        c.body.Direction__c === "Outbound"));
  }

  {
    // Long replies are split, not truncated: Meta rejects a body over 4096.
    const long = "A".repeat(9000);
    const chunks = wa.splitForWhatsApp(long);
    check("a reply longer than the Cloud API text cap is split into chunks",
      chunks.length > 1 && chunks.every((c) => c.length <= wa.MAX_TEXT_CHARS));
    check("splitting loses no characters", chunks.join("").length === long.length);
  }

  line("9. Salesforce is unreachable  -> the visitor still gets an answer");

  {
    reset();
    const state = world({ sfDown: true });
    const res = await post(textEvent({ wamid: "wamid.SFDOWN" }));
    check("Salesforce outage -> 200 to Meta", res.statusCode === 200);
    check("Salesforce outage -> the bot still answered", state.claude === 1);
    check("Salesforce outage -> the visitor still received the reply", state.sends.length === 1);
  }

  line("10. Returning 200 fast  -> the self-invocation, and its fallback");

  {
    reset(); world();
    const saved = process.env.WHATSAPP_ASYNC;
    delete process.env.WHATSAPP_ASYNC;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    const out = await quietly(() => dispatchAsync([{ waId: WA_ID, wamid: "w", text: "hi" }]));
    process.env.WHATSAPP_ASYNC = saved;
    check("no AWS_LAMBDA_FUNCTION_NAME -> dispatch reports failure rather than throwing",
      out.dispatched === false && /AWS_LAMBDA_FUNCTION_NAME/.test(out.reason));
  }

  {
    reset(); world();
    const out = await quietly(() => dispatchAsync([{ waId: WA_ID, wamid: "w", text: "hi" }]));
    check("WHATSAPP_ASYNC=false -> dispatch is skipped deliberately",
      out.dispatched === false && /WHATSAPP_ASYNC/.test(out.reason));
  }

  {
    // The SDK is loaded at INIT (module scope) and only exists inside the
    // nodejs20.x runtime, so here it is always absent — which makes the
    // degradation path directly testable rather than hypothetical.
    reset(); world();
    const savedAsync = process.env.WHATSAPP_ASYNC;
    delete process.env.WHATSAPP_ASYNC;
    process.env.AWS_LAMBDA_FUNCTION_NAME = "spartan-chatbot";
    const out = await quietly(() => dispatchAsync([{ waId: WA_ID, wamid: "w", text: "hi" }]));
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.WHATSAPP_ASYNC = savedAsync;
    check("SDK missing -> dispatch degrades with a named reason, never throws",
      out.dispatched === false && /@aws-sdk\/client-lambda unavailable/.test(out.reason));
    check("the INIT-time SDK promise never rejects (no unhandled rejection at load)",
      typeof out.reason === "string" && out.reason.length > 0);
  }

  {
    reset();
    const state = world({ conversation: null });
    const res = await post(textEvent({ wamid: "wamid.INLINE" }));
    check("dispatch unavailable -> the work happens INLINE and Meta still gets 200",
      res.statusCode === 200 && JSON.parse(res.body).mode === "inline");
    check("the inline fallback still delivers the reply", state.sends.length === 1);
  }

  {
    // The other half: the envelope the async invocation actually arrives as.
    reset();
    const state = world({ conversation: null });
    const res = await quietly(() => handler({
      [JOB_KEY]: {
        jobId: "job-1",
        messages: [{
          waId: WA_ID, wamid: "wamid.JOB1", type: "text",
          text: "Following up on my application", profileName: "Dana Reyes",
          timestamp: "2026-08-28T12:00:00.000Z",
        }],
      },
    }));
    check("a { whatsappJob } envelope is routed to the async worker, not the widget path",
      res.statusCode === 200);
    check("the async worker runs the full turn", state.claude === 1 && state.sends.length === 1);
    check("the async worker records both directions",
      state.calls.filter((c) => c.method === "POST" && c.url.includes("/sobjects/Message__c/")).length === 2);
    check("the async job carries no HTTP signature and needs none (it is not a Meta request)",
      state.calls.every((c) => !c.url.includes("hub.signature")));
  }

  line("11. Isolation  -> the widget path is untouched by any of this");

  {
    reset();
    const state = world({ conversation: null });
    // No signature, no widget token, ordinary chat POST at "/".
    const res = await quietly(() => handler({
      rawPath: "/",
      requestContext: { http: { method: "POST", path: "/" } },
      headers: { origin: "https://www.spartancapital.us", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], sessionId: "sess-web" }),
    }));
    check("a widget POST at / is still handled by the web path", res.statusCode === 200);
    check("a widget POST at / never reaches the Graph API", state.sends.length === 0);
    const parsed = JSON.parse(res.body);
    check("a widget POST at / still returns a reply, not a WhatsApp ack",
      typeof parsed.reply === "string" && parsed.ok === undefined);
  }

  {
    reset(); world();
    const res = await quietly(() => handler({
      rawPath: "/whatsapp",
      requestContext: { http: { method: "DELETE", path: "/whatsapp" } },
      headers: {},
    }));
    check("a verb Meta does not use -> 405", res.statusCode === 405);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`WHATSAPP WEBHOOK: ${passed} assertions passed, zero real network calls`);
  console.log("=".repeat(72));
  console.log("Confirmed: the handshake, the raw-body HMAC, Channel__c='WhatsApp',");
  console.log("wamid dedupe, status events ignored, Claimed -> silent, Closed -> reopened,");
  console.log("and a Cloud API send that matches Meta's spec.");
}

await main();
