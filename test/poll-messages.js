/**
 * Proves the poll endpoint — the return path that carries a rep's replies from
 * Salesforce back to the website widget.
 *
 *   node test/poll-messages.js
 *
 * No network anywhere: every Salesforce call is a stubbed fetch whose URL and
 * method are recorded, so the assertions are about the SOQL actually emitted,
 * not just the values handed back.
 *
 * The claims under test:
 *   1. No conversation for the session -> empty, and not one wasted query.
 *   2. Only REP messages come back: Outbound, minus the bot's own Outbound,
 *      minus anything at or before the widget's cursor.
 *   3. `live` reports whether a rep holds the conversation (Status__c=Claimed).
 *   4. The widget token gate covers a poll exactly as it covers a chat turn.
 *   5. A Salesforce failure degrades to empty + error:true on a 200 — never a
 *      throw, never a 500, because a page is calling this every few seconds.
 *   6. A poll never reaches Claude.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;
delete process.env.SF_INTEGRATION_USER_ID;

// conversation.js no-ops unless Salesforce is configured, so give this process
// a throwaway keypair. Never the real SF_PRIVATE_KEY; no network call is ever
// made with it.
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

const BOT_USER = "005TEST00000001";
const REP_USER = "005REP000000001";
const CONV_ID = "a01CONV00000001";

/** An auth object shaped like a real JWT token response, identity URL and all. */
const AUTH = {
  access_token: "TOKEN",
  instance_url: "https://example.my.salesforce.com",
  id: `https://login.salesforce.com/id/00D000000000001EAA/${BOT_USER}`,
};
/** The same token from an org that returns no identity URL. */
const AUTH_NO_ID = { access_token: "TOKEN", instance_url: AUTH.instance_url };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const noBody = (status) => new Response(null, { status });

const quiet = { log() {}, error() {} };

/** Salesforce stub. `routes` maps "METHOD /path-fragment" to a responder. */
function sfStub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = String(url);
    calls.push({ method, url: u });
    for (const [key, responder] of Object.entries(routes)) {
      const [m, frag] = key.split(" ");
      if (m === method && u.includes(frag)) return responder(calls);
    }
    return json({});
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** The decoded SOQL of the one query a poll is allowed to make. */
function soqlOf(stub) {
  const call = stub.calls.find((c) => c.url.includes("/query/?q="));
  return call ? decodeURIComponent(call.url.split("/query/?q=")[1]) : null;
}

const message = (id, body, sentAt, extra = {}) => ({
  attributes: { type: "Message__c" },
  Id: id, Body__c: body, Sent_At__c: sentAt, CreatedDate: sentAt, ...extra,
});

const conversationRecord = (status, assignedTo = null) =>
  json({ Id: CONV_ID, Status__c: status, Assigned_To__c: assignedTo });

async function main() {
  line("1. NO CONVERSATION  -> empty, and not one wasted query");

  {
    const stub = sfStub({ "GET /Session_Id__c/": () => noBody(404) });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-none", logger: quiet, deps: { auth: AUTH },
    });

    check("no conversation -> { messages: [], live: false, status: null }",
      Array.isArray(out.messages) && out.messages.length === 0 &&
      out.live === false && out.status === null);
    check("no conversation -> no error flag (this is the normal case, not a failure)",
      out.error === undefined);
    check("no conversation -> the Message__c query is never issued",
      soqlOf(stub) === null);
  }

  line("2. THE SOQL  -> outbound, not-the-bot, this conversation, one query");

  {
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed"),
      "GET /query/": () => json({ totalSize: 0, done: true, records: [] }),
    });
    globalThis.fetch = stub;

    await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH },
    });
    const soql = soqlOf(stub);

    check("scoped to this conversation", soql.includes(`Conversation__c = '${CONV_ID}'`));
    check("Direction__c = 'Outbound' — inbound is the visitor's own text",
      soql.includes("Direction__c = 'Outbound'"));
    check("REP vs BOT: excludes messages authored by the integration user",
      soql.includes(`CreatedById != '${BOT_USER}'`));
    check("ordered by Sent_At__c, and bounded by a LIMIT",
      /ORDER BY Sent_At__c DESC/.test(soql) && /LIMIT \d+/.test(soql));
    check("exactly ONE SOQL query per poll",
      stub.calls.filter((c) => c.url.includes("/query/")).length === 1);
    check("no re-auth: the cached token is reused",
      stub.calls.every((c) => !c.url.includes("oauth2/token")));
  }

  line("3. ONLY REP MESSAGES AFTER THE CURSOR come back");

  {
    // The stub returns newest-first, as the DESC query asks for.
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed"),
      "GET /query/": () => json({
        totalSize: 3, done: true,
        records: [
          message("a02MSG000000003", "Sending it over now.", "2026-08-26T18:00:30.000Z"),
          message("a02MSG000000002", "Hi, this is Dana from Spartan.", "2026-08-26T18:00:20.000Z"),
          // Exactly on the cursor: already shown, must not come back.
          message("a02MSG000000001", "older rep line", "2026-08-26T18:00:10.000Z"),
        ],
      }),
    });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", after: "2026-08-26T18:00:10.000Z",
      logger: quiet, deps: { auth: AUTH },
    });

    check("the cursor is pushed into the query as a Sent_At__c floor",
      /Sent_At__c >= 2026-08-26T18:00:10Z/.test(soqlOf(stub)));
    check("a message exactly ON the cursor is not re-delivered",
      out.messages.every((m) => m.id !== "a02MSG000000001"));
    check("only the two newer rep messages come back", out.messages.length === 2);
    check("returned oldest-first, the order the widget renders in",
      out.messages[0].id === "a02MSG000000002" && out.messages[1].id === "a02MSG000000003");
    check("shape is { id, body, sentAt }",
      out.messages[0].body === "Hi, this is Dana from Spartan." &&
      out.messages[0].sentAt === "2026-08-26T18:00:20.000Z" &&
      Object.keys(out.messages[0]).sort().join(",") === "body,id,sentAt");
  }

  line("4. LIVE FLAG  -> reflects Status__c === 'Claimed'");

  for (const [status, expected] of [["Claimed", true], ["New", false], ["Closed", false]]) {
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord(status),
      "GET /query/": () => json({ totalSize: 0, done: true, records: [] }),
    });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH },
    });
    check(`Status__c='${status}' -> live:${expected}, status echoed verbatim`,
      out.live === expected && out.status === status);
  }

  {
    // A rep's last word must survive the rep closing the conversation.
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Closed"),
      "GET /query/": () => json({
        totalSize: 1, done: true,
        records: [message("a02MSGCLOSED001", "All set — talk soon.", "2026-08-26T18:05:00.000Z")],
      }),
    });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH },
    });
    check("a Closed conversation still delivers the rep's final message",
      out.live === false && out.messages.length === 1);
  }

  line("5. AUTHOR FILTER FALLBACK  -> never replay the bot's own replies");

  {
    // No identity URL on the token: fall back to the rep who holds the chat.
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed", REP_USER),
      "GET /query/": () => json({ totalSize: 0, done: true, records: [] }),
    });
    globalThis.fetch = stub;

    await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH_NO_ID },
    });
    check("no integration user id -> match the assigned rep instead",
      soqlOf(stub).includes(`CreatedById = '${REP_USER}'`));
  }

  {
    // Neither discriminator available: returning unfiltered Outbound would
    // replay every bot reply into the widget. Return nothing instead.
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed", null),
      "GET /query/": () => json({
        totalSize: 1, done: true,
        records: [message("a02MSGBOT000001", "bot reply, already delivered", "2026-08-26T18:00:00.000Z")],
      }),
    });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH_NO_ID },
    });
    check("no way to tell rep from bot -> NO messages returned at all",
      out.messages.length === 0);
    check("no way to tell rep from bot -> the query is never even run",
      soqlOf(stub) === null);
    check("...but live/status still report truthfully",
      out.live === true && out.status === "Claimed");
  }

  {
    process.env.SF_INTEGRATION_USER_ID = "005OVERRIDE0001";
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed"),
      "GET /query/": () => json({ totalSize: 0, done: true, records: [] }),
    });
    globalThis.fetch = stub;

    await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH_NO_ID },
    });
    check("SF_INTEGRATION_USER_ID overrides the identity URL",
      soqlOf(stub).includes("CreatedById != '005OVERRIDE0001'"));
    delete process.env.SF_INTEGRATION_USER_ID;
  }

  line("6. CURSORS  -> timestamp, message id, and garbage");

  {
    check("an ISO timestamp parses to a millisecond floor",
      conv.parsePollCursor("2026-08-26T18:00:10.000Z").afterMs ===
      Date.parse("2026-08-26T18:00:10.000Z"));
    check("a Salesforce id parses as an id cursor",
      conv.parsePollCursor("a02MSG000000001").afterId === "a02MSG000000001");
    check("garbage degrades to no cursor rather than to an error",
      Object.keys(conv.parsePollCursor("not-a-cursor")).length === 0 &&
      Object.keys(conv.parsePollCursor("")).length === 0 &&
      Object.keys(conv.parsePollCursor(null)).length === 0);
  }

  {
    const records = [
      message("a02MSG000000003", "third", "2026-08-26T18:00:30.000Z"),
      message("a02MSG000000002", "second", "2026-08-26T18:00:20.000Z"),
      message("a02MSG000000001", "first", "2026-08-26T18:00:10.000Z"),
    ];
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed"),
      "GET /query/": () => json({ totalSize: 3, done: true, records }),
    });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", after: "a02MSG000000002", logger: quiet, deps: { auth: AUTH },
    });
    check("an id cursor slices the window after that message",
      out.messages.length === 1 && out.messages[0].id === "a02MSG000000003");
    check("an id cursor adds no Sent_At__c floor to the query",
      !soqlOf(stub).includes("Sent_At__c >="));
  }

  {
    // A rep message the org never stamped: it must not vanish.
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed"),
      "GET /query/": () => json({
        totalSize: 1, done: true,
        records: [{
          attributes: { type: "Message__c" }, Id: "a02MSGNOSTAMP01",
          Body__c: "unstamped rep reply", Sent_At__c: null,
          CreatedDate: "2026-08-26T18:00:40.000Z",
        }],
      }),
    });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", after: "2026-08-26T18:00:10.000Z", logger: quiet, deps: { auth: AUTH },
    });
    check("a null Sent_At__c is kept in the query window",
      soqlOf(stub).includes("Sent_At__c = null"));
    check("a null Sent_At__c falls back to CreatedDate rather than being dropped",
      out.messages.length === 1 && out.messages[0].sentAt === "2026-08-26T18:00:40.000Z");
  }

  line("7. SALESFORCE FAILURE  -> empty + error, never a throw");

  {
    const stub = sfStub({ "GET /Session_Id__c/": () => json({ error: "boom" }, 500) });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH },
    });
    check("conversation lookup fails -> { messages: [], live: false, error: true }",
      out.messages.length === 0 && out.live === false && out.error === true);
  }

  {
    const stub = sfStub({
      "GET /Session_Id__c/": () => conversationRecord("Claimed"),
      "GET /query/": () => json({ error: "boom" }, 500),
    });
    globalThis.fetch = stub;

    const out = await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH },
    });
    check("the message query fails -> empty + error, not a rejected promise",
      out.messages.length === 0 && out.error === true);
  }

  {
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    const out = await conv.pollRepMessages({
      sessionId: "sess-1", logger: quiet, deps: { auth: AUTH },
    });
    check("Salesforce unreachable entirely -> empty + error", out.error === true);
  }

  line("8. THE HANDLER  -> routing, the token gate, and never Claude");

  /** Full-stack stub: OAuth, the conversation read, and the message query. */
  function handlerStub({ conversationStatus = "Claimed", records = [] } = {}) {
    const calls = [];
    const impl = async (url, init = {}) => {
      const u = String(url);
      calls.push({ method: init.method || "GET", url: u });
      if (u.includes("anthropic.com")) return json({ error: "Claude must not be called" }, 500);
      if (u.includes("oauth2/token")) return json({ ...AUTH });
      if (u.includes("/Session_Id__c/")) return conversationRecord(conversationStatus);
      if (u.includes("/query/")) return json({ totalSize: records.length, done: true, records });
      return noBody(204);
    };
    impl.calls = calls;
    return impl;
  }

  const POLL = (body, headers = {}) => ({
    requestContext: { http: { method: "POST" } },
    headers: { origin: "https://www.spartancapital.us", ...headers },
    body: JSON.stringify({ action: "poll", ...body }),
  });

  /** Swallow the handler's own logging so the PASS lines stay readable. */
  async function silently(fn) {
    const [l, w, e] = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    try { return await fn(); } finally { console.log = l; console.warn = w; console.error = e; }
  }

  {
    const stub = handlerStub({
      records: [message("a02MSGREP000001", "Dana here — got your details.", "2026-08-26T18:02:00.000Z")],
    });
    globalThis.fetch = stub;

    const res = await silently(() => handler(POLL({ sessionId: "sess-poll" })));
    const data = JSON.parse(res.body);

    check("a poll returns 200", res.statusCode === 200);
    check("a poll NEVER calls Claude",
      stub.calls.every((c) => !c.url.includes("anthropic.com")));
    check("a poll returns the rep's message, live, status and the sessionId",
      data.messages.length === 1 && data.messages[0].body === "Dana here — got your details." &&
      data.live === true && data.status === "Claimed" && data.sessionId === "sess-poll");
    check("a poll carries no chat-turn fields (no reply, no handoff)",
      data.reply === undefined && data.handoff === undefined);
  }

  {
    globalThis.fetch = handlerStub();
    const res = await silently(() => handler(POLL({})));
    check("a poll without a sessionId is a 400, not a silently empty inbox",
      res.statusCode === 400 && /sessionId/.test(JSON.parse(res.body).error));
  }

  {
    process.env.WIDGET_TOKEN = "s3cret-widget-token";
    const stub = handlerStub();
    globalThis.fetch = stub;

    const res = await silently(() => handler(POLL({ sessionId: "sess-poll" })));
    check("TOKEN GATE: a poll with no x-widget-token is 401",
      res.statusCode === 401);
    check("TOKEN GATE: the rejected poll touched nothing at all",
      stub.calls.length === 0);

    const wrong = await silently(() =>
      handler(POLL({ sessionId: "sess-poll" }, { "x-widget-token": "wrong" })));
    check("TOKEN GATE: a poll with the wrong token is 401", wrong.statusCode === 401);

    const ok = await silently(() =>
      handler(POLL({ sessionId: "sess-poll" }, { "x-widget-token": "s3cret-widget-token" })));
    check("TOKEN GATE: a poll with the right token goes through",
      ok.statusCode === 200 && JSON.parse(ok.body).live === true);
    delete process.env.WIDGET_TOKEN;
  }

  {
    // The whole point of the graceful path: a page polling every few seconds
    // must never be handed a 500.
    globalThis.fetch = async (url) => {
      if (String(url).includes("oauth2/token")) return json({ ...AUTH });
      throw new Error("Salesforce is down");
    };
    const res = await silently(() => handler(POLL({ sessionId: "sess-poll" })));
    const data = JSON.parse(res.body);
    check("Salesforce down -> the poll is still a 200", res.statusCode === 200);
    check("Salesforce down -> { messages: [], live: false, error: true }",
      data.messages.length === 0 && data.live === false && data.error === true);
  }

  {
    // A chat turn must still be a chat turn.
    let claudeCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes("anthropic.com")) {
        claudeCalls++;
        return json({
          id: "m", type: "message", role: "assistant", model: "claude-sonnet-5",
          content: [{ type: "text", text: "Happy to help.\n[[SCG_STATUS: OK]]" }],
          stop_reason: "end_turn", stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      if (u.includes("oauth2/token")) return json({ ...AUTH });
      if (u.includes("/Session_Id__c/")) return noBody(404);
      return noBody(204);
    };
    const res = await silently(() => handler({
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.spartancapital.us" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Do you fund bakeries?" }],
        sessionId: "sess-chat",
      }),
    }));
    const data = JSON.parse(res.body);
    check("a normal chat turn is unaffected: Claude is called and a reply comes back",
      claudeCalls === 1 && res.statusCode === 200 && data.reply === "Happy to help.");
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`POLL / REP MESSAGE RETURN PATH: ${passed} assertions passed, no network`);
  console.log("=".repeat(72));
}

await main();
