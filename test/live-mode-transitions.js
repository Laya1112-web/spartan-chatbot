/**
 * Proves the two live-mode transitions that follow a rep takeover:
 *
 *   node test/live-mode-transitions.js
 *
 *   1. HAND BACK  Claimed -> New. The rep is done; the bot answers the very
 *      next turn, with the whole transcript (the rep's own turns included) in
 *      its context, appending to the existing conversation rather than
 *      backfilling a second copy of it.
 *   2. END CHAT   -> Closed. Terminal. No bot reply, no bot resume, and — the
 *      part worth testing hardest — not one write against the finished record.
 *   3. action:"close" sets Status__c, idempotently, and fails soft.
 *
 * No network anywhere: every Salesforce and Anthropic call is a stubbed fetch
 * whose URL, method and body are recorded, so the assertions are about the
 * traffic the handler would actually emit.
 *
 * Companion to test/conversation-sync.js, which owns the Claimed case.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

// conversation.js no-ops unless Salesforce is configured, so give this process
// a throwaway keypair. Never the real SF_PRIVATE_KEY; no network call is made
// with it.
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

const INSTANCE = "https://example.my.salesforce.com";
const AUTH = { access_token: "TOKEN", instance_url: INSTANCE };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const noBody = (status) => new Response(null, { status });

function safeParse(body) {
  if (!body) return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}

const quiet = { log() {}, error() {} };

/**
 * Drive the real handler against a stubbed world.
 *
 * `status` is what the external-id GET reports for the conversation; null means
 * no conversation exists yet. Every call is recorded, split into Salesforce
 * traffic and the Anthropic request, so a test can assert on either.
 */
async function invoke(body, { status = null, sfFails = false, convId = "a01CONVX" } = {}) {
  const sfCalls = [];
  let claudeCalls = 0;
  let claudeBody = null;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";

    if (u.includes("anthropic.com")) {
      claudeCalls++;
      claudeBody = safeParse(init.body);
      return json({
        id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5",
        content: [{ type: "text", text: "Bot reply.\n[[SCG_STATUS: OK]]" }],
        stop_reason: "end_turn", stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }

    sfCalls.push({ method, url: u, body: safeParse(init.body) });

    if (u.includes("oauth2/token")) return json(AUTH);
    if (sfFails) return json({ message: "boom" }, 500);

    if (u.includes("/Session_Id__c/") && method === "GET") {
      return status === null ? noBody(404) : json({ Id: convId, Status__c: status });
    }
    if (u.includes("/sobjects/Message__c/")) return json({ id: "a02MSG" }, 201);
    if (u.includes("/query")) return json({ records: [] });
    return noBody(204);
  };

  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    const res = await handler({
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.spartancapital.us" },
      body: JSON.stringify(body),
    });
    return {
      statusCode: res.statusCode,
      data: JSON.parse(res.body),
      sfCalls,
      claudeCalls,
      claudeBody,
      messageWrites: sfCalls.filter((c) => c.url.includes("/sobjects/Message__c/")),
      convPatches: sfCalls.filter(
        (c) => c.method === "PATCH" && c.url.includes("/sobjects/Conversation__c/"),
      ),
      leadPosts: sfCalls.filter(
        (c) => c.method === "POST" && c.url.includes("/sobjects/Lead"),
      ),
    };
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realErr;
  }
}

async function main() {
  line("1. HAND BACK  Claimed -> New  ->  the bot resumes, with the context");

  // The transcript a widget sends after a rep has been and gone: the rep's
  // turns are in it as assistant turns, because that is how the widget
  // rendered them.
  const handedBack = [
    { role: "user", content: "I need working capital for my bakery" },
    { role: "assistant", content: "Happy to help — let me get a specialist on this." },
    { role: "user", content: "thanks" },
    { role: "assistant", content: "This is Dave from funding. What's your monthly revenue?" },
    { role: "user", content: "about 40k a month" },
  ];

  {
    const r = await invoke(
      { messages: handedBack, sessionId: "sess-handback" },
      { status: "New", convId: "a01CONVBACK" },
    );

    check("Claimed->New -> the bot replies again (Claude called exactly once)",
      r.claudeCalls === 1 && r.data.reply === "Bot reply.");
    check("Claimed->New -> not live, not closed",
      r.data.live === undefined && r.data.closed === undefined);

    // The whole point of "picks up the context": Claude sees the entire
    // transcript, the rep's turns included, not just the newest message.
    const sent = r.claudeBody?.messages ?? [];
    check("Claimed->New -> Claude receives the full transcript, all 5 turns",
      sent.length === 5);
    check("Claimed->New -> the rep's own turn is in the context Claude sees",
      sent.some((m) => /This is Dave from funding/.test(m.content)));
    check("Claimed->New -> the newest visitor turn is last (what Claude answers)",
      sent[sent.length - 1].role === "user" &&
      sent[sent.length - 1].content === "about 40k a month");

    // The conversation already exists, so this turn appends the newest exchange
    // and nothing else. Re-backfilling would duplicate the whole thread in
    // Salesforce every time a rep handed one back.
    check("Claimed->New -> exactly 2 messages written: the new turn, both sides",
      r.messageWrites.length === 2);
    check("Claimed->New -> the visitor's newest turn is written Inbound",
      r.messageWrites.some((c) =>
        c.body.Direction__c === "Inbound" && c.body.Body__c === "about 40k a month"));
    check("Claimed->New -> the bot's reply is written Outbound",
      r.messageWrites.some((c) =>
        c.body.Direction__c === "Outbound" && c.body.Body__c === "Bot reply."));
    check("Claimed->New -> no transcript re-backfill (the rep's turn is not re-written)",
      !r.messageWrites.some((c) => /This is Dave from funding/.test(c.body.Body__c ?? "")));
    check("Claimed->New -> Status__c is never written back (the rep owns it)",
      !r.convPatches.some((c) => c.body && "Status__c" in c.body));
    check("Claimed->New -> no second lead is inserted for the session",
      r.leadPosts.length === 0);
    check("Claimed->New -> the conversation id still comes back for the widget",
      r.data.conversationId === "a01CONVBACK");
  }

  line("2. END CHAT  Status 'Closed'  ->  terminal: no reply, no resume, no writes");

  {
    const r = await invoke(
      { messages: [{ role: "user", content: "actually never mind, bye" }], sessionId: "sess-closed" },
      { status: "Closed", convId: "a01CONVDONE" },
    );

    check("Closed -> 200 with closed:true, live:false and a null reply",
      r.statusCode === 200 && r.data.closed === true &&
      r.data.live === false && r.data.reply === null);
    check("Closed -> Claude was NOT called: the bot does not resume",
      r.claudeCalls === 0);
    check("Closed -> NOT ONE message is written to the finished conversation",
      r.messageWrites.length === 0);
    check("Closed -> the conversation record is not touched at all",
      r.convPatches.length === 0);
    check("Closed -> no handoff, no lead",
      r.data.handoff === false && r.leadPosts.length === 0);
    check("Closed -> the conversation id comes back so the widget can match it",
      r.data.conversationId === "a01CONVDONE");
    check("Closed -> handoffContext still round-trips",
      typeof r.data.handoffContext === "object" && r.data.handoffContext !== null);
  }

  {
    // The lead guard has to survive a close: the context comes back so a
    // visitor cannot produce a second lead by ending and reopening the chat.
    const r = await invoke(
      {
        messages: [{ role: "user", content: "bye" }],
        sessionId: "sess-closed-lead",
        handoffContext: { leadId: "00QLEAD00000001", firstName: "Dana" },
      },
      { status: "Closed" },
    );
    check("Closed -> an existing leadId is echoed back in handoffContext",
      r.data.handoffContext.leadId === "00QLEAD00000001");
    check("Closed -> accumulated fields are echoed back too",
      r.data.handoffContext.firstName === "Dana");
  }

  line("3. THE OUTAGE HOLE  ->  a closed conversation still cannot be written to");

  {
    // resolveLiveMode fails open on a Salesforce error, so the bot answers and
    // recordVisitorTurn runs with no conversation in hand. Its own re-read is
    // what has to catch the Closed status. Called directly: this is the state
    // the handler cannot reach on its own.
    let messageWrites = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = init.method || "GET";
      if (u.includes("oauth2/token")) return json(AUTH);
      if (u.includes("/Session_Id__c/") && method === "GET") {
        return json({ Id: "a01CONVDONE", Status__c: "Closed" });
      }
      if (u.includes("/sobjects/Message__c/")) { messageWrites++; return json({ id: "a02MSG" }, 201); }
      return noBody(204);
    };

    const out = await conv.recordVisitorTurn({
      sessionId: "sess-outage",
      leadId: "00QLEAD00000001",
      messages: [{ role: "user", content: "hello?" }],
      botReply: "Bot reply.",
      logger: quiet,
    });

    check("recordVisitorTurn on a Closed conversation -> writes nothing",
      messageWrites === 0 && out.written === 0);
    check("recordVisitorTurn on a Closed conversation -> reports closed:true",
      out.closed === true && out.conversationId === "a01CONVDONE");
  }

  {
    // Same guard, but with the conversation handed in rather than re-read.
    let messageWrites = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/sobjects/Message__c/")) { messageWrites++; return json({ id: "x" }, 201); }
      return noBody(204);
    };
    const out = await conv.recordVisitorTurn({
      sessionId: "sess-passed-closed",
      messages: [{ role: "user", content: "hi" }],
      botReply: "Bot reply.",
      conversation: { id: "a01CONVDONE", status: "Closed" },
      logger: quiet,
    });
    check("a Closed conversation passed in is refused just the same",
      messageWrites === 0 && out.written === 0 && out.closed === true);
  }

  line('4. action:"close"  ->  sets Status__c = Closed');

  {
    const r = await invoke(
      { action: "close", sessionId: "sess-end" },
      { status: "Claimed", convId: "a01CONVEND" },
    );

    check('close -> 200 with closed:true, reply:null, live:false',
      r.statusCode === 200 && r.data.closed === true &&
      r.data.reply === null && r.data.live === false);
    check("close -> exactly one PATCH, to the conversation record",
      r.convPatches.length === 1 && r.convPatches[0].url.includes("/sobjects/Conversation__c/a01CONVEND"));
    check("close -> the PATCH sets Status__c = 'Closed' and nothing else",
      r.convPatches[0].body.Status__c === "Closed" &&
      Object.keys(r.convPatches[0].body).length === 1);
    check("close -> reports the new status and the conversation id",
      r.data.status === "Closed" && r.data.conversationId === "a01CONVEND");
    check("close -> Claude is never called", r.claudeCalls === 0);
    check("close -> no messages are written", r.messageWrites.length === 0);
    check("close -> a visitor ending the chat outranks a rep holding it (was Claimed)",
      r.data.closed === true);
  }

  {
    const r = await invoke(
      { action: "close", sessionId: "sess-already" },
      { status: "Closed", convId: "a01CONVDONE" },
    );
    check("close on an already-closed conversation -> still closed:true",
      r.data.closed === true && r.data.alreadyClosed === true);
    check("close on an already-closed conversation -> NO redundant PATCH",
      r.convPatches.length === 0);
  }

  {
    const r = await invoke({ action: "close", sessionId: "sess-none" }, { status: null });
    check("close with no conversation (never handed off) -> 200, notFound, not an error",
      r.statusCode === 200 && r.data.notFound === true && r.data.closed === false);
    check("close with no conversation -> nothing is created just to close it",
      r.convPatches.length === 0 && r.messageWrites.length === 0);
  }

  {
    const r = await invoke({ action: "close", sessionId: "sess-broken" }, { sfFails: true });
    check("close during a Salesforce outage -> 200, never a 500 in the visitor's face",
      r.statusCode === 200);
    check("close during a Salesforce outage -> closed:false with error:true",
      r.data.closed === false && r.data.error === true);
  }

  {
    const r = await invoke({ action: "close" }, {});
    check("close without a sessionId -> 400 (closing an unnamed session is meaningless)",
      r.statusCode === 400 && /sessionId/.test(r.data.error));
  }

  {
    const r = await invoke({ action: "close", sessionId: "   " }, {});
    check("close with a blank sessionId -> 400 as well", r.statusCode === 400);
  }

  line("5. POLL  ->  reports the close, without swallowing the last rep message");

  {
    // A rep's final message, sent just before the visitor closed the chat.
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = init.method || "GET";
      if (u.includes("/Session_Id__c/") && method === "GET") {
        return json({ Id: "a01CONVDONE", Status__c: "Closed" });
      }
      if (u.includes("/query")) {
        return json({
          records: [{
            Id: "a02REPLAST", Body__c: "Thanks, all set!",
            Sent_At__c: "2026-08-27T12:00:00.000+0000", CreatedDate: "2026-08-27T12:00:00.000+0000",
          }],
        });
      }
      return noBody(204);
    };

    // Auth injected rather than fetched: the poll's rep-vs-bot filter needs the
    // token's identity URL, and salesforce.js's cache is warm from the handler
    // invocations above with one that has none.
    const out = await conv.pollRepMessages({
      sessionId: "sess-closed",
      logger: quiet,
      deps: { auth: { ...AUTH, id: "https://login.salesforce.com/id/00D/005BOTUSER00000" } },
    });
    check("poll on a Closed conversation -> closed:true, live:false",
      out.closed === true && out.live === false && out.status === "Closed");
    check("poll on a Closed conversation -> the rep's last message is STILL delivered",
      out.messages.length === 1 && out.messages[0].body === "Thanks, all set!");
  }

  {
    // The shape has to be stable, so the widget can read `closed` on every
    // poll response rather than only on the ones that found a conversation.
    globalThis.fetch = async () => noBody(404);
    const out = await conv.pollRepMessages({
      sessionId: "sess-nothing",
      logger: quiet,
      deps: { auth: { ...AUTH, id: "https://login.salesforce.com/id/00D/005BOTUSER00000" } },
    });
    check("poll with no conversation -> closed:false, not undefined",
      out.closed === false && out.live === false);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`LIVE-MODE TRANSITIONS: ${passed} assertions passed, zero real network calls`);
  console.log("=".repeat(72));
  console.log("Confirmed: a rep handing back to 'New' resumes the bot with the full");
  console.log("transcript and appends to the existing conversation; 'Closed' is");
  console.log("terminal — no reply, no resume, no writes — and action:\"close\" sets it.");
}

await main();
