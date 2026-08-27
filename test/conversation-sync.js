/**
 * Proves the Conversation__c / Message__c sync and the live-rep takeover.
 *
 *   node test/conversation-sync.js
 *
 * No network anywhere: every Salesforce call is a stubbed fetch whose URL and
 * method are recorded, so assertions are about the actual REST traffic the
 * module would emit — endpoint, verb, and body — not just its return values.
 *
 * The four claims under test:
 *   1. One conversation per session, ever (idempotent by external id), and a
 *      turn never overwrites a rep's Status__c.
 *   2. Visitor messages are written Inbound, with the transcript backfilled on
 *      the turn the conversation is created.
 *   3. Status__c === 'Claimed' means Claude is NOT called and live:true comes
 *      back — the whole point of the feature.
 *   4. Any Salesforce failure degrades to "bot answered, nothing recorded",
 *      never to a broken response.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

// conversation.js deliberately no-ops unless Salesforce is configured, so give
// this process a throwaway keypair. Never the real SF_PRIVATE_KEY, and no
// network call is ever made with it.
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

const conv = await import("../conversation.js");
const { handler } = await import("../index.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

const AUTH = { access_token: "TOKEN", instance_url: "https://example.my.salesforce.com" };
const NOW = "2026-08-26T18:00:00.000Z";
const now = () => NOW;

/**
 * Salesforce stub. `routes` maps "METHOD /path-fragment" to a responder.
 * Every call is recorded so the traffic itself can be asserted on.
 */
function sfStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = String(url);
    calls.push({ method, url: u, body: safeParse(init.body) });
    for (const [key, responder] of Object.entries(routes)) {
      const [m, frag] = key.split(" ");
      if (m === method && u.includes(frag)) return responder(calls);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
/** The OAuth token POST is form-encoded, so never assume a JSON body. */
function safeParse(body) {
  if (!body) return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const noBody = (status) => new Response(null, { status });

const quiet = { log() {}, error() {} };

async function main() {
  line("1. ensureConversation  -> idempotent by external id, never clobbers Status");

  {
    // No conversation yet: GET 404, then the external-id PATCH creates it.
    const stub = sfStub({
      "GET /Session_Id__c/": () => noBody(404),
      "PATCH /Session_Id__c/": () => json({ id: "a01CONV0000001", success: true, created: true }, 201),
    });
    globalThis.fetch = stub;
    const out = await conv.ensureConversation("sess-1", "00QLEAD0000001", AUTH);
    check("no existing conversation -> created with the returned id",
      out.id === "a01CONV0000001" && out.created === true && out.status === "New");

    const patch = stub.calls.find((c) => c.method === "PATCH");
    check("create uses the external-id upsert endpoint (PATCH .../Session_Id__c/sess-1)",
      patch.url.includes("/sobjects/Conversation__c/Session_Id__c/sess-1"));
    check("create sets Lead__c and Status__c='New'",
      patch.body.Lead__c === "00QLEAD0000001" && patch.body.Status__c === "New");
    check("create omits Session_Id__c from the body (the URL carries it)",
      patch.body.Session_Id__c === undefined);
  }

  {
    // Second turn, same session: the GET finds it, so nothing is written.
    const stub = sfStub({
      "GET /Session_Id__c/": () => json({ Id: "a01CONV0000001", Status__c: "New" }),
    });
    globalThis.fetch = stub;
    const out = await conv.ensureConversation("sess-1", "00QLEAD0000001", AUTH);
    check("same sessionId again -> the SAME conversation, created:false",
      out.id === "a01CONV0000001" && out.created === false);
    check("same sessionId again -> ZERO writes, so no second conversation",
      stub.calls.filter((c) => c.method !== "GET").length === 0);
  }

  {
    // THE CLOBBER TEST: a claimed conversation must survive the turn untouched.
    const stub = sfStub({
      "GET /Session_Id__c/": () => json({ Id: "a01CONV0000009", Status__c: "Claimed" }),
    });
    globalThis.fetch = stub;
    const out = await conv.ensureConversation("sess-claimed", "00QLEAD0000009", AUTH);
    check("existing Claimed conversation -> status preserved, not reset to New",
      out.status === "Claimed" && out.created === false);
    check("existing Claimed conversation -> no PATCH was issued at all",
      stub.calls.every((c) => c.method === "GET"));
  }

  {
    // 204: something created it between our read and our write.
    let gets = 0;
    const stub = sfStub({
      "GET /Session_Id__c/": () => (++gets === 1
        ? noBody(404)
        : json({ Id: "a01CONVRACE001", Status__c: "New" })),
      "PATCH /Session_Id__c/": () => noBody(204),
    });
    globalThis.fetch = stub;
    const out = await conv.ensureConversation("sess-race", "00QLEAD1", AUTH);
    check("upsert race (HTTP 204) -> re-reads and returns the single record",
      out.id === "a01CONVRACE001" && out.created === false);
  }

  line("2. writeMessage  -> Inbound Message__c + parent Last_Message_At__c");

  {
    const stub = sfStub({
      "POST /sobjects/Message__c/": () => json({ id: "a02MSG0000001", success: true }, 201),
      "PATCH /sobjects/Conversation__c/a01": () => noBody(204),
    });
    globalThis.fetch = stub;
    const out = await conv.writeMessage("a01CONV0000001", "I need $60k", "Inbound", AUTH, { now });
    check("writeMessage -> returns the new message id and stamps the parent",
      out.id === "a02MSG0000001" && out.stamped === true);

    const post = stub.calls.find((c) => c.method === "POST");
    check("Message__c body carries all five fields, Read__c false",
      post.body.Conversation__c === "a01CONV0000001" &&
      post.body.Body__c === "I need $60k" &&
      post.body.Direction__c === "Inbound" &&
      post.body.Read__c === false &&
      post.body.Sent_At__c === NOW);

    const patch = stub.calls.find((c) => c.method === "PATCH");
    check("parent Last_Message_At__c stamped with the same timestamp",
      patch.url.includes("/sobjects/Conversation__c/a01CONV0000001") &&
      patch.body.Last_Message_At__c === NOW &&
      Object.keys(patch.body).length === 1);
  }

  {
    // The stamp is best-effort: a saved message beats a sorted parent.
    const stub = sfStub({
      "POST /sobjects/Message__c/": () => json({ id: "a02MSG0000002" }, 201),
      "PATCH /sobjects/Conversation__c/": () => json({ error: "boom" }, 500),
    });
    globalThis.fetch = stub;
    const out = await conv.writeMessage("a01CONV0000001", "hi", "Inbound", AUTH, { now });
    check("parent stamp failure -> message still saved, stamped:false",
      out.id === "a02MSG0000002" && out.stamped === false);
  }

  line("3. recordVisitorTurn  -> backfills on create, appends afterwards");

  const transcript = [
    { role: "user", content: "I run an HVAC company and need funding." },
    { role: "assistant", content: "Happy to help — what's your first name?" },
    { role: "user", content: "Dana" },
    { role: "assistant", content: "Thanks! Best phone number?" },
    { role: "user", content: "216-555-0142" },
  ];

  {
    const written = [];
    const out = await conv.recordVisitorTurn({
      sessionId: "sess-2", leadId: "00QLEAD2", messages: transcript, logger: quiet,
      botReply: "A specialist will reach out shortly.",
      deps: {
        auth: AUTH,
        ensureConversation: async () => ({ id: "a01CONV2", status: "New", created: true }),
        writeMessage: async (id, body, dir) => { written.push({ id, body, dir }); return { id: "m" }; },
      },
    });
    check("conversation just created -> the WHOLE transcript is backfilled, both sides",
      out.written === 6 && written.length === 6);
    check("backfill preserves transcript order",
      written.map((w) => w.body).join("|") ===
      [...transcript.map((m) => m.content), "A specialist will reach out shortly."].join("|"));
    check("backfill directions follow the roles: visitor Inbound, bot Outbound",
      written.map((w) => w.dir).join(",") ===
      "Inbound,Outbound,Inbound,Outbound,Inbound,Outbound");
    check("returns the conversation id for the response", out.conversationId === "a01CONV2");
  }

  {
    const written = [];
    const out = await conv.recordVisitorTurn({
      sessionId: "sess-2", leadId: "00QLEAD2", messages: transcript, logger: quiet,
      conversation: { id: "a01CONV2", status: "New" },
      deps: { auth: AUTH,
        writeMessage: async (id, body, dir) => { written.push({ body, dir }); return { id: "m" }; } },
    });
    check("existing conversation -> ONLY the newest visitor message is written",
      out.written === 1 && written.length === 1 && written[0].body === "216-555-0142");
  }

  {
    // The normal post-handoff turn: one exchange, two messages, both directions.
    const written = [];
    const out = await conv.recordVisitorTurn({
      sessionId: "sess-2b", leadId: "00QLEAD2", messages: transcript, logger: quiet,
      botReply: "Got it — anything else?",
      conversation: { id: "a01CONV2", status: "New" },
      deps: { auth: AUTH,
        writeMessage: async (id, body, dir) => { written.push({ body, dir }); return { id: "m" }; } },
    });
    check("existing conversation + bot reply -> visitor Inbound then bot Outbound",
      out.written === 2 &&
      written[0].body === "216-555-0142" && written[0].dir === "Inbound" &&
      written[1].body === "Got it — anything else?" && written[1].dir === "Outbound");
  }

  {
    // A live turn has no bot reply to write.
    const written = [];
    for (const botReply of [null, undefined, "", "   "]) {
      written.length = 0;
      await conv.recordVisitorTurn({
        sessionId: "sess-2c", leadId: "00QLEAD2", messages: transcript, logger: quiet,
        botReply,
        conversation: { id: "a01CONV2", status: "New" },
        deps: { auth: AUTH,
          writeMessage: async (id, body, dir) => { written.push({ body, dir }); return { id: "m" }; } },
      });
      check(`botReply ${JSON.stringify(botReply)} -> no Outbound message written`,
        written.length === 1 && written[0].dir === "Inbound");
    }
  }

  {
    // Pre-handoff: no lead, no conversation -> nothing to attach to.
    const written = [];
    const out = await conv.recordVisitorTurn({
      sessionId: "sess-3", leadId: undefined, messages: transcript, logger: quiet,
      deps: { auth: AUTH, writeMessage: async () => { written.push(1); return { id: "m" }; } },
    });
    check("no lead and no conversation -> nothing written, no error",
      out.written === 0 && written.length === 0);
  }

  {
    // One failing message must not abandon the rest of the backfill.
    let n = 0;
    const out = await conv.recordVisitorTurn({
      sessionId: "sess-4", leadId: "00QLEAD4", messages: transcript, logger: quiet,
      deps: { auth: AUTH,
        ensureConversation: async () => ({ id: "a01CONV4", status: "New", created: true }),
        writeMessage: async () => { if (++n === 2) throw new Error("row lock"); return { id: "m" }; } },
    });
    // Five transcript entries; the second one throws, so four still land.
    check("one message write failing -> every other message still lands",
      out.written === 4 && out.conversationId === "a01CONV4");
  }

  line("4. LIVE MODE  -> Claimed means Claude is never called");

  // Claude stub that records whether it was called at all.
  let claudeCalls = 0;
  const claudeResponse = () => {
    claudeCalls++;
    return json({
      id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "Bot reply.\n[[SCG_STATUS: OK]]" }],
      stop_reason: "end_turn", stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };

  async function invokeHandler({ status, sessionId = "sess-live" }) {
    claudeCalls = 0;
    const sfCalls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = init.method || "GET";
      if (u.includes("anthropic.com")) return claudeResponse();
      sfCalls.push({ method, url: u, body: safeParse(init.body) });
      if (u.includes("oauth2/token")) return json({ access_token: "T", instance_url: "https://example.my.salesforce.com" });
      if (u.includes("/Session_Id__c/") && method === "GET") {
        return status === null ? noBody(404) : json({ Id: "a01CONVLIVE", Status__c: status });
      }
      if (u.includes("/sobjects/Message__c/")) return json({ id: "a02MSGLIVE" }, 201);
      return noBody(204);
    };
    const realLog = console.log, realWarn = console.warn, realErr = console.error;
    console.log = console.warn = console.error = () => {};
    try {
      const res = await handler({
        requestContext: { http: { method: "POST" } },
        headers: { origin: "https://www.spartancapital.us" },
        body: JSON.stringify({ messages: [{ role: "user", content: "any update?" }], sessionId }),
      });
      return { statusCode: res.statusCode, data: JSON.parse(res.body), sfCalls };
    } finally {
      console.log = realLog; console.warn = realWarn; console.error = realErr;
    }
  }

  {
    {
      const { statusCode, data, sfCalls } = await invokeHandler({ status: "Claimed" });
      check("Claimed -> Claude was NOT called", claudeCalls === 0);
      check("Claimed -> 200 with live:true and a null reply",
        statusCode === 200 && data.live === true && data.reply === null);
      check("Claimed -> the conversation id comes back for the widget",
        data.conversationId === "a01CONVLIVE");
      check("Claimed -> handoff false, no lead attempted",
        data.handoff === false && data.leadId === undefined);
      check("Claimed -> the visitor's message was still recorded Inbound",
        sfCalls.some((c) => c.url.includes("/sobjects/Message__c/") &&
          c.body?.Direction__c === "Inbound" && c.body?.Body__c === "any update?"));
      check("Claimed -> NO Outbound message written: the rep is speaking, not the bot",
        !sfCalls.some((c) => c.url.includes("/sobjects/Message__c/") &&
          c.body?.Direction__c === "Outbound"));
    }

    {
      const { data } = await invokeHandler({ status: "New" });
      check("Status 'New' -> the bot replies as normal",
        claudeCalls === 1 && data.live === undefined && data.reply === "Bot reply.");
    }

    // Closed used to land here as "not claimed, so the bot handles it". It no
    // longer does: the chat is over. Full coverage of the transition, including
    // the no-write guarantee, lives in test/live-mode-transitions.js.
    {
      const { data } = await invokeHandler({ status: "Closed" });
      check("Status 'Closed' -> Claude was NOT called and no reply comes back",
        claudeCalls === 0 && data.closed === true && data.reply === null);
    }

    {
      const { data } = await invokeHandler({ status: null });
      check("no conversation yet -> bot replies, nothing to sync",
        claudeCalls === 1 && data.live === undefined && data.reply === "Bot reply.");
    }

    line("5. SALESFORCE FAILURE  -> the visitor still gets their reply");

    {
      // Every Salesforce call fails; Claude still answers.
      claudeCalls = 0;
      globalThis.fetch = async (url) => {
        if (String(url).includes("anthropic.com")) return claudeResponse();
        throw new Error("ECONNRESET");
      };
      const realLog = console.log, realWarn = console.warn, realErr = console.error;
      const logged = [];
      console.log = console.warn = () => {};
      console.error = (...a) => logged.push(a.join(" "));
      let res;
      try {
        res = await handler({
          requestContext: { http: { method: "POST" } },
          headers: { origin: "https://www.spartancapital.us" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], sessionId: "sess-broken" }),
        });
      } finally {
        console.log = realLog; console.warn = realWarn; console.error = realErr;
      }
      const data = JSON.parse(res.body);
      check("total Salesforce failure -> still 200 with the bot's reply",
        res.statusCode === 200 && data.reply === "Bot reply." && data.error === undefined);
      check("total Salesforce failure -> Claude was still called", claudeCalls === 1);
      check("total Salesforce failure -> not treated as live mode",
        data.live === undefined && data.conversationId === undefined);
      check("total Salesforce failure -> logged for CloudWatch",
        logged.some((l) => /\[conversation\] live-mode check failed/.test(l)));
    }

    {
      // A timeout specifically, shaped like AbortSignal.timeout's rejection.
      claudeCalls = 0;
      globalThis.fetch = async (url) => {
        if (String(url).includes("anthropic.com")) return claudeResponse();
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      };
      const realLog = console.log, realWarn = console.warn, realErr = console.error;
      console.log = console.warn = console.error = () => {};
      let res;
      try {
        res = await handler({
          requestContext: { http: { method: "POST" } },
          headers: { origin: "https://www.spartancapital.us" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], sessionId: "sess-timeout" }),
        });
      } finally {
        console.log = realLog; console.warn = realWarn; console.error = realErr;
      }
      check("Salesforce timeout -> 200 and the reply survives",
        res.statusCode === 200 && JSON.parse(res.body).reply === "Bot reply.");
    }
  }

  line("6. TOKEN CACHE  -> one auth per warm container, refreshed near expiry");

  const sfMod = await import("../salesforce.js");

  function tokenStub() {
    let auths = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("oauth2/token")) {
        auths++;
        return json({ access_token: `T${auths}`, instance_url: "https://example.my.salesforce.com" });
      }
      return json({}, 200);
    };
    return () => auths;
  }

  {
    sfMod.invalidateSfToken();
    const auths = tokenStub();
    let clock = 1_000_000;
    const now = () => clock;

    const a = await sfMod.getSfToken({ now });
    check("cold cache -> one auth round-trip", auths() === 1 && a.access_token === "T1");

    const b = await sfMod.getSfToken({ now });
    const c = await sfMod.getSfToken({ now });
    check("within TTL -> reused, still ONE auth for three calls",
      auths() === 1 && b.access_token === "T1" && c.access_token === "T1");

    // Just inside the refresh margin.
    clock += sfMod.JWT_TTL_SECONDS * 1000 - sfMod.TOKEN_REFRESH_MARGIN_MS - 1;
    await sfMod.getSfToken({ now });
    check("one ms before the refresh point -> still cached", auths() === 1);

    // Past it.
    clock += 2;
    const d = await sfMod.getSfToken({ now });
    check("past the refresh point -> re-authed with a fresh token",
      auths() === 2 && d.access_token === "T2");

    const e = await sfMod.getSfToken({ now, force: true });
    check("force:true -> bypasses a valid cache",
      auths() === 3 && e.access_token === "T3");

    sfMod.invalidateSfToken();
    await sfMod.getSfToken({ now });
    check("invalidateSfToken() -> next call re-auths", auths() === 4);
  }

  {
    check("refresh margin is 60s inside the 300s JWT TTL",
      sfMod.TOKEN_REFRESH_MARGIN_MS === 60_000 && sfMod.JWT_TTL_SECONDS === 300);
  }

  line("7. 401 HANDLING  -> invalidate, re-auth, retry once");

  {
    sfMod.invalidateSfToken();
    let auths = 0;
    let gets = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = init.method || "GET";
      if (u.includes("oauth2/token")) {
        auths++;
        return json({ access_token: `T${auths}`, instance_url: "https://example.my.salesforce.com" });
      }
      if (u.includes("/Session_Id__c/") && method === "GET") {
        gets++;
        // A stale cached token: first attempt 401s, the retry succeeds.
        if (gets === 1) return json({ message: "Session expired", errorCode: "INVALID_SESSION_ID" }, 401);
        return json({ Id: "a01CONVRETRY", Status__c: "New" });
      }
      return json({}, 200);
    };

    const out = await conv.findConversation("sess-401", conv.authSession());
    check("401 -> retried once and the call succeeds",
      out !== null && out.id === "a01CONVRETRY");
    check("401 -> exactly two attempts, no loop", gets === 2);
    check("401 -> a fresh token was fetched for the retry", auths === 2);
  }

  {
    sfMod.invalidateSfToken();
    let gets = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("oauth2/token")) return json({ access_token: "T", instance_url: "https://example.my.salesforce.com" });
      if (u.includes("/Session_Id__c/")) { gets++; return json({ message: "nope" }, 401); }
      return json({}, 200);
    };
    let threw = null;
    try {
      await conv.findConversation("sess-401-hard", conv.authSession());
    } catch (err) {
      threw = err;
    }
    check("persistent 401 -> gives up after the single retry, no infinite loop",
      gets === 2 && threw !== null && threw.sfStatus === 401);
  }

  line("8. SECONDARY LEAD GUARD  -> an existing conversation also blocks a create");

  {
    // A conversation only comes into being on a handoff turn, so its existence
    // implies a lead already exists. This covers a client that drops
    // handoffContext, and the window before the context round-trips.
    let leadWrites = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url), method = init.method || "GET";
      if (u.includes("anthropic.com")) {
        return json({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5",
          content: [{ type: "text", text: "All set.\n[[SCG_STATUS: OK]]\n" +
            '[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield","phone":"(216) 555-0142"}]]' }],
          stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } });
      }
      if (u.includes("oauth2/token")) return json({ access_token: "T", instance_url: "https://example.my.salesforce.com" });
      if (u.includes("/sobjects/Lead")) { leadWrites++; return json({ id: "00QNEWLEAD00000000" }, 201); }
      if (u.includes("/Session_Id__c/") && method === "GET") return json({ Id: "a01CONVEXISTS", Status__c: "New" });
      if (u.includes("/sobjects/Message__c/")) return json({ id: "a02MSG" }, 201);
      return noBody(204);
    };
    const rl = console.log, rw = console.warn, re = console.error;
    const captured = [];
    console.log = console.warn = console.error = (...a) =>
      captured.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
    let data;
    try {
      const res = await handler({
        requestContext: { http: { method: "POST" } },
        headers: { origin: "https://www.spartancapital.us" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "I want to talk to a funding specialist" }],
          sessionId: "sess-existing-conv",
        }),
      });
      data = JSON.parse(res.body);
    } finally {
      console.log = rl; console.warn = rw; console.error = re;
    }
    check("existing conversation, no context leadId -> NO Lead insert", leadWrites === 0);
    check("existing conversation -> the skip is logged, attributed to that guard",
      captured.some((l) => /not creating another/.test(l) && /conversation/.test(l)));
    check("existing conversation -> messages still sync (per-message, not per-lead)",
      data.conversationId === "a01CONVEXISTS");
  }

  line("9. isClaimed / isClosed  -> two different silences, never the same one");

  check("isClaimed('Claimed') is true", conv.isClaimed("Claimed") === true);
  check("isClaimed('New'/'Closed'/null/undefined) are all false",
    [conv.isClaimed("New"), conv.isClaimed("Closed"), conv.isClaimed(null),
     conv.isClaimed(undefined), conv.isClaimed("claimed")].every((v) => v === false));

  check("isClosed('Closed') is true", conv.isClosed("Closed") === true);
  check("isClosed('New'/'Claimed'/null/undefined) are all false",
    [conv.isClosed("New"), conv.isClosed("Claimed"), conv.isClosed(null),
     conv.isClosed(undefined), conv.isClosed("closed")].every((v) => v === false));
  check("no status is both claimed and closed",
    !["New", "Claimed", "Closed", null].some((st) => conv.isClaimed(st) && conv.isClosed(st)));

  console.log(`\n${"=".repeat(72)}`);
  console.log(`CONVERSATION SYNC + LIVE MODE: ${passed} assertions passed, no network`);
  console.log("=".repeat(72));
}

await main();
