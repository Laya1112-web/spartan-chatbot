/**
 * Proves the business-hours gate on the live handoff.
 *
 *   node test/business-hours.js
 *
 * Funding specialists work Monday–Friday, 9:00am–6:00pm Eastern. Outside that
 * window nobody claims a conversation, so a bot reply saying "connecting you to
 * a specialist now" leaves the visitor watching an empty chat until morning.
 *
 * What must be true, and is asserted below:
 *
 *   1. The clock is a real Eastern conversion, so EST and EDT are both right.
 *      A fixed UTC offset is wrong for half the year in EITHER direction, and
 *      two cases here fail against either fixed guess.
 *   2. During hours: nothing changes. Live handoff offered, reply untouched.
 *   3. After hours: the Lead is still written and the Conversation__c is still
 *      created — the whole point is that the lead is NOT lost — but the reply
 *      carries no live-specialist promise, and does carry the hours and the
 *      full-application URL, which works around the clock.
 *   4. The gate is structural, not just prompt guidance: a model reply that
 *      announces a specialist anyway gets that sentence removed.
 *   5. A conversation a rep has ALREADY claimed is untouched. A chat that went
 *      live at 5:50pm is still live at 6:05pm; the gate only affects NEW
 *      handoff offers.
 *
 * No network: every Anthropic and Salesforce call is a stubbed fetch whose URL,
 * method and body are recorded, and the clock is injected.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

// conversation.js and salesforce.js no-op unless Salesforce is configured, so
// give this process a throwaway keypair. Never the real SF_PRIVATE_KEY; no
// network call is made with it.
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

const { handler, setClock, clearLeadMemory } = await import("../index.js");
const {
  resolveBusinessHours,
  enforceAfterHoursReply,
  promisesLiveHuman,
  FULL_APPLICATION_URL,
  OPEN_HOUR,
  CLOSE_HOUR,
} = await import("../businessHours.js");
const { buildSystemPrompt } = await import("../systemPrompt.js");

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}
const line = (t) => console.log(`\n${t}\n`);

const INSTANCE = "https://example.my.salesforce.com";
const AUTH = { access_token: "TOKEN", instance_url: INSTANCE };
const LEAD_ID = "00QBIZHOURS001";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const noBody = (status) => new Response(null, { status });

function safeParse(body) {
  if (!body) return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}

/**
 * ONE fetch stub for the whole file, installed once.
 *
 * Deliberately not re-installed per case: the Anthropic client is built on the
 * first call and cached across invocations (as it is on a warm Lambda), and it
 * holds on to whatever `globalThis.fetch` was at construction. A fresh stub per
 * case would therefore be ignored from the second case onward — the calls would
 * silently land in the first case's stub, with the first case's canned reply.
 * So the stub is fixed and the mutable state lives in `world`, which each
 * invoke() resets.
 */
const world = {
  modelText: "",
  convStatus: null,
  convId: "a01CONVBH",
  sfCalls: [],
  claudeCalls: 0,
  claudeBody: null,
};

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || "GET";

  if (u.includes("anthropic.com")) {
    world.claudeCalls++;
    world.claudeBody = safeParse(init.body);
    return json({
      id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: world.modelText }],
      stop_reason: "end_turn", stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  world.sfCalls.push({ method, url: u, body: safeParse(init.body) });

  if (u.includes("oauth2/token")) return json(AUTH);
  if (u.includes("/Session_Id__c/") && method === "GET") {
    return world.convStatus === null
      ? noBody(404)
      : json({ Id: world.convId, Status__c: world.convStatus });
  }
  if (u.includes("/Session_Id__c/") && method === "PATCH") {
    return json({ id: world.convId, created: true, success: true }, 201);
  }
  if (u.includes("/sobjects/Lead/")) return json({ id: LEAD_ID, success: true }, 201);
  if (u.includes("/sobjects/Message__c/")) return json({ id: "a02MSG" }, 201);
  if (u.includes("/query")) return json({ records: [] });
  return noBody(204);
};

/**
 * Drive the real handler at a pinned instant.
 *
 * `at` is a UTC ISO string; `status` is what the external-id GET reports for
 * the conversation, null meaning none exists yet.
 */
async function invoke(body, { at, status = null, modelText, convId = "a01CONVBH" } = {}) {
  clearLeadMemory();
  setClock(() => new Date(at));
  world.modelText = modelText;
  world.convStatus = status;
  world.convId = convId;
  world.sfCalls = [];
  world.claudeCalls = 0;
  world.claudeBody = null;

  const realLog = console.log, realWarn = console.warn, realErr = console.error;
  console.log = console.warn = console.error = () => {};
  let res;
  try {
    res = await handler({
      requestContext: { http: { method: "POST" } },
      headers: { origin: "https://www.spartancapital.us" },
      body: JSON.stringify(body),
    });
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realErr;
    setClock();
  }

  const sfCalls = world.sfCalls;
  const messageWrites = sfCalls.filter((c) => c.url.includes("/sobjects/Message__c/"));
  return {
    statusCode: res.statusCode,
    data: JSON.parse(res.body),
    sfCalls,
    claudeCalls: world.claudeCalls,
    claudeBody: world.claudeBody,
    systemPrompt: world.claudeBody && world.claudeBody.system ? String(world.claudeBody.system) : "",
    messageWrites,
    outbound: messageWrites.filter((c) => c.body && c.body.Direction__c === "Outbound"),
    inbound: messageWrites.filter((c) => c.body && c.body.Direction__c === "Inbound"),
    leadPosts: sfCalls.filter((c) => c.method === "POST" && c.url.includes("/sobjects/Lead/")),
    convUpserts: sfCalls.filter(
      (c) => c.method === "PATCH" && c.url.includes("/Session_Id__c/"),
    ),
    statusPatches: sfCalls.filter(
      (c) => c.method === "PATCH" && c.body && c.body.Status__c !== undefined,
    ),
  };
}

// A visitor who has given everything a specialist needs, closing with a word no
// phrase list matches — the model-signalled handoff path.
const READY = [
  { role: "user", content: "I run a bakery and need working capital." },
  {
    role: "assistant",
    content:
      "Thanks Dana! I have what I need — Dana Whitfield at Whitfield Bakery, " +
      "dana@whitfieldbakery.example, (216) 555-0142, looking for working capital.",
  },
  { role: "user", content: "thank you" },
];

const LEAD_BLOCK =
  '[[SCG_LEAD: {"firstName":"Dana","lastName":"Whitfield",' +
  '"email":"dana@whitfieldbakery.example","phone":"(216) 555-0142",' +
  '"businessName":"Whitfield Bakery","loanPurpose":"Working Capital / Cash Flow"}]]';

/** What the model says on a handoff turn when it thinks a rep is available. */
const LIVE_HANDOFF_TEXT =
  "Perfect, Dana — I've got everything I need. I'm connecting you with a funding " +
  "specialist right now who can walk you through the options.\n" +
  `[[SCG_STATUS: OK]]\n${LEAD_BLOCK}`;

/** What it should say after hours, if the prompt lands. */
const AFTER_HOURS_TEXT =
  "Perfect, Dana — I've got everything I need. Our funding specialists are " +
  "available Monday–Friday, 9am–6pm Eastern, and I've saved your details so one " +
  "of them can reach out during business hours. In the meantime you can start " +
  `your application anytime at ${FULL_APPLICATION_URL} — anything else I can help with?\n` +
  `[[SCG_STATUS: OK]]\n${LEAD_BLOCK}`;

async function main() {
  line("1. THE CLOCK  ->  real Eastern conversion, EST and EDT both correct");

  {
    const et = (at) => resolveBusinessHours(new Date(at));

    check("window constants are 9am–6pm", OPEN_HOUR === 9 && CLOSE_HOUR === 18);

    // Winter, EST (UTC-5).
    check("Wed 19:00Z in January -> 14:00 EST -> open",
      et("2026-01-14T19:00:00Z").open === true && et("2026-01-14T19:00:00Z").hour === 14);
    check("Wed 14:00Z in January -> 09:00 EST -> open (lower boundary is inclusive)",
      et("2026-01-14T14:00:00Z").open === true && et("2026-01-14T14:00:00Z").hour === 9);
    check("Wed 13:59Z in January -> 08:59 EST -> closed",
      et("2026-01-14T13:59:00Z").open === false);
    check("Wed 23:00Z in January -> 18:00 EST -> closed (upper boundary is exclusive)",
      et("2026-01-14T23:00:00Z").open === false && et("2026-01-14T23:00:00Z").hour === 18);
    check("Wed 22:59Z in January -> 17:59 EST -> still open",
      et("2026-01-14T22:59:00Z").open === true);

    // Summer, EDT (UTC-4).
    check("Wed 13:00Z in July -> 09:00 EDT -> open",
      et("2026-07-15T13:00:00Z").open === true && et("2026-07-15T13:00:00Z").hour === 9);
    check("Wed 12:59Z in July -> 08:59 EDT -> closed",
      et("2026-07-15T12:59:00Z").open === false);
    check("Wed 22:00Z in July -> 18:00 EDT -> closed",
      et("2026-07-15T22:00:00Z").open === false);

    // THE FIXED-OFFSET TRAP. Each of these fails under one of the two guesses a
    // hardcoded offset could make, which is the whole reason Intl is used.
    check("summer 13:30Z is 9:30am EDT -> open (a hardcoded UTC-5 would say 8:30am, closed)",
      et("2026-07-15T13:30:00Z").open === true && et("2026-07-15T13:30:00Z").hour === 9);
    check("winter 22:30Z is 5:30pm EST -> open (a hardcoded UTC-4 would say 6:30pm, closed)",
      et("2026-01-14T22:30:00Z").open === true && et("2026-01-14T22:30:00Z").hour === 17);

    // Weekends and the small hours.
    check("Saturday midday ET -> closed", et("2026-01-17T17:00:00Z").open === false &&
      et("2026-01-17T17:00:00Z").weekday === "Sat");
    check("Sunday midday ET -> closed", et("2026-01-18T17:00:00Z").open === false &&
      et("2026-01-18T17:00:00Z").weekday === "Sun");
    check("Saturday 5pm ET (a weekday-open hour) -> still closed",
      et("2026-01-17T22:00:00Z").open === false);
    check("Thursday midnight ET reports hour 0, not 24, and is closed",
      et("2026-01-15T05:00:00Z").hour === 0 && et("2026-01-15T05:00:00Z").open === false);
    check("Monday 9am ET -> open (the week opens)",
      et("2026-01-12T14:00:00Z").open === true && et("2026-01-12T14:00:00Z").weekday === "Mon");
    check("Friday 5:59pm ET -> open (the week closes)",
      et("2026-01-16T22:59:00Z").open === true && et("2026-01-16T22:59:00Z").weekday === "Fri");

    // The fail-closed choice: an unusable clock must never promise a live rep.
    const broken = resolveBusinessHours(new Date("not a date"), { log() {}, error() {} });
    check("an invalid instant fails CLOSED, never open", broken.open === false);
  }

  line("2. THE REPLY GATE  ->  strips a live promise, keeps a callback promise");

  {
    const gate = (text, opts) => enforceAfterHoursReply(text, opts);

    const promise = gate(
      "Perfect, Dana! I'm connecting you with a funding specialist now.",
      { handoff: true },
    );
    check("\"connecting you with a specialist now\" is stripped",
      promise.stripped.length === 1 && !/connecting/i.test(promise.reply));
    check("the sentence before it survives", /Perfect, Dana!/.test(promise.reply));
    check("the notice replaces what was removed",
      /Monday–Friday/.test(promise.reply) && promise.reply.includes(FULL_APPLICATION_URL));

    for (const [label, text] of [
      ["a specialist is joining the chat", "A funding specialist is joining the chat now."],
      ["with you shortly", "One of our specialists will be with you shortly."],
      ["transferring you", "Transferring you to a funding specialist."],
      ["someone will jump in", "Someone will jump in momentarily."],
      ["getting a rep on the line", "Let me get a rep on the line for you."],
      ["taking over this chat", "A specialist is taking over this chat now."],
    ]) {
      check(`live promise detected: ${label}`, promisesLiveHuman(text) === true);
      check(`live promise stripped: ${label}`,
        gate(text, { handoff: true }).stripped.length === 1);
    }

    for (const [label, text] of [
      ["a specialist will reach out", "A funding specialist will reach out during business hours."],
      ["someone will be in touch", "Someone will be in touch on Monday."],
      ["a specialist will follow up", "A specialist will follow up by email."],
      ["hours statement", "Our funding specialists are available Monday–Friday, 9am–6pm Eastern."],
      ["immediacy with no human", "You can start your application right now."],
      ["plain answer", "Yes, Spartan funds bakeries in all 50 states."],
    ]) {
      check(`legitimate line NOT flagged: ${label}`, promisesLiveHuman(text) === false);
    }

    const alreadyRight = gate(
      "Thanks Dana! Our funding specialists are available Monday–Friday, 9am–6pm " +
      "Eastern, and a specialist will reach out during business hours. You can " +
      `start your application anytime at ${FULL_APPLICATION_URL}.`,
      { handoff: true },
    );
    check("a reply that already says it is left completely alone",
      alreadyRight.changed === false && alreadyRight.appended === false &&
      alreadyRight.stripped.length === 0);

    const noHandoff = gate("Yes, Spartan funds bakeries in all 50 states.", { handoff: false });
    check("an ordinary after-hours answer is untouched — no notice bolted on",
      noHandoff.changed === false);

    const declined = gate(
      "Spartan isn't able to fund cannabis dispensaries, so I can't help with funding here.",
      { handoff: false, declined: true },
    );
    check("a DECLINED turn gets no notice and no application link",
      declined.changed === false && !declined.reply.includes("apply.spartancapitalgroup.com"));

    const partial = gate(
      "I've saved your details — our specialists are around Monday–Friday, 9am–6pm Eastern.",
      { handoff: true },
    );
    check("hours already stated -> only the application sentence is added",
      partial.appended === true &&
      partial.reply.includes(FULL_APPLICATION_URL) &&
      partial.reply.match(/Monday–Friday/g).length === 1);
  }

  line("3. THE PROMPT  ->  the model is told which world it is in");

  {
    const open = buildSystemPrompt({ open: true });
    const closed = buildSystemPrompt({ open: false });
    check("open prompt says it is inside business hours",
      /inside Spartan's business hours/.test(open) &&
      !/OUTSIDE Spartan's business hours/.test(open));
    check("closed prompt says it is OUTSIDE business hours",
      /OUTSIDE Spartan's business hours/.test(closed));
    check("closed prompt forbids announcing a specialist is joining",
      /Never say a specialist is joining/.test(closed));
    check("closed prompt still demands the SCG_LEAD block",
      /SCG_LEAD/.test(closed));
    check("closed prompt still offers the full application",
      closed.includes("https://apply.spartancapitalgroup.com/step-2/"));
    check("both keep the standing prompt (excluded industries, status tag)",
      /pawn shops/.test(open) && /pawn shops/.test(closed) &&
      /SCG_STATUS/.test(open) && /SCG_STATUS/.test(closed));
    check("defaults to the after-hours note when nothing is passed",
      /OUTSIDE Spartan's business hours/.test(buildSystemPrompt()));
  }

  line("4. DURING HOURS  ->  unchanged: the live handoff is offered");

  {
    const r = await invoke(
      { messages: READY, sessionId: "bh-during" },
      { at: "2026-01-14T19:00:00Z", modelText: LIVE_HANDOFF_TEXT }, // Wed 2:00pm EST
    );

    check("200, and Claude was called", r.statusCode === 200 && r.claudeCalls === 1);
    check("the prompt carried the in-hours note",
      /inside Spartan's business hours/.test(r.systemPrompt));
    check("businessHours.open is true", r.data.businessHours.open === true);
    check("liveHandoff is true — a rep can pick this up", r.data.liveHandoff === true);
    check("handoff fired and a Lead was written",
      r.data.handoff === true && r.leadPosts.length === 1);
    check("the Conversation__c was created", r.convUpserts.length === 1);
    check("the reply is EXACTLY what the model said, tags stripped and nothing else",
      r.data.reply ===
      "Perfect, Dana — I've got everything I need. I'm connecting you with a funding " +
      "specialist right now who can walk you through the options.");
    check("the live-specialist promise survived untouched",
      /connecting you with a funding specialist/.test(r.data.reply));
    check("no after-hours notice was bolted on",
      !/available Monday–Friday/.test(r.data.reply));

    // liveHandoff implies handoff: a rep can only claim a Conversation__c that
    // exists, and that only exists once a lead does. During hours, a visitor
    // who asks on turn one — before there is a name or a contact — is still the
    // bot collecting, not a rep arriving.
    const early = await invoke(
      {
        messages: [{ role: "user", content: "Can someone call me?" }],
        sessionId: "bh-during-early",
      },
      {
        at: "2026-01-14T19:00:00Z",
        modelText: "Of course — what's your first name?\n[[SCG_STATUS: OK]]",
      },
    );
    check("during hours, a deferred handoff is not a live handoff",
      early.data.businessHours.open === true &&
      early.data.handoff === false &&
      early.data.handoffDeferred === true &&
      early.data.liveHandoff === false &&
      early.leadPosts.length === 0);
  }

  line("5. AFTER HOURS, WEEKDAY EVENING  ->  lead kept, promise dropped");

  {
    // Wednesday 8:00pm EST. Reps went home two hours ago.
    const r = await invoke(
      { messages: READY, sessionId: "bh-evening" },
      { at: "2026-01-15T01:00:00Z", modelText: AFTER_HOURS_TEXT },
    );

    check("200, and Claude was still called", r.statusCode === 200 && r.claudeCalls === 1);
    check("the prompt carried the after-hours note",
      /OUTSIDE Spartan's business hours/.test(r.systemPrompt));
    check("businessHours.open is false", r.data.businessHours.open === false);
    check("businessHours reports the window and the zone",
      r.data.businessHours.hours === "Monday–Friday, 9am–6pm Eastern" &&
      r.data.businessHours.timezone === "America/New_York");

    // The whole point: the lead is NOT lost.
    check("LEAD STILL CREATED after hours",
      r.data.handoff === true && r.leadPosts.length === 1 && r.data.leadId === LEAD_ID);
    check("the Lead carries the collected fields, not a placeholder",
      r.leadPosts[0].body.FirstName === "Dana" &&
      r.leadPosts[0].body.LastName === "Whitfield" &&
      r.leadPosts[0].body.Email === "dana@whitfieldbakery.example");
    check("CONVERSATION STILL CREATED, so a rep sees it in the morning queue",
      r.convUpserts.length === 1 && r.data.conversationId === "a01CONVBH");
    check("the transcript was backfilled into it", r.messageWrites.length >= 3);

    // ...but nothing was promised.
    check("liveHandoff is FALSE — no rep is joining", r.data.liveHandoff === false);
    check("the reply promises no live specialist", promisesLiveHuman(r.data.reply) === false);
    check("the reply names the business hours",
      /Monday–Friday/.test(r.data.reply) && /9am–6pm Eastern/.test(r.data.reply));
    check("the reply says the details are saved and someone will reach out",
      /saved your details/.test(r.data.reply) && /reach out/.test(r.data.reply));
    check("the reply offers the full application, which works 24/7",
      r.data.reply.includes(FULL_APPLICATION_URL));
    check("no 'connecting you now' language anywhere in it",
      !/connect/i.test(r.data.reply) && !/joining/i.test(r.data.reply) &&
      !/shortly/i.test(r.data.reply));
    // The backfill writes the earlier assistant turn too, so it is the LAST
    // Outbound that is this turn's reply.
    check("the rep's morning transcript shows the SAME text the visitor saw",
      r.outbound.length === 2 &&
      r.outbound[r.outbound.length - 1].body.Body__c === r.data.reply);
  }

  line("6. AFTER HOURS + A MODEL THAT IGNORES THE PROMPT  ->  gated structurally");

  {
    // Same evening, but the model announces a specialist anyway. This is the
    // case the prompt cannot guarantee, and the reason the gate exists.
    const r = await invoke(
      { messages: READY, sessionId: "bh-defiant" },
      { at: "2026-01-15T01:00:00Z", modelText: LIVE_HANDOFF_TEXT },
    );

    check("the promise did NOT reach the visitor",
      !/connecting you/i.test(r.data.reply) && promisesLiveHuman(r.data.reply) === false);
    check("the useful half of the reply survived",
      /I've got everything I need/.test(r.data.reply));
    check("the true message replaced it",
      /Monday–Friday/.test(r.data.reply) && r.data.reply.includes(FULL_APPLICATION_URL));
    check("liveHandoff is still false", r.data.liveHandoff === false);
    check("and the lead was still created", r.leadPosts.length === 1);
  }

  line("7. WEEKEND  ->  identical to an after-hours weekday");

  {
    // Saturday 11:00am ET — inside the 9–18 window, wrong day.
    const r = await invoke(
      { messages: READY, sessionId: "bh-saturday" },
      { at: "2026-01-17T16:00:00Z", modelText: LIVE_HANDOFF_TEXT },
    );

    check("Saturday inside the 9–18 window is still after hours",
      r.data.businessHours.open === false && r.data.liveHandoff === false);
    check("the prompt carried the after-hours note",
      /OUTSIDE Spartan's business hours/.test(r.systemPrompt));
    check("weekend: LEAD STILL CREATED", r.data.handoff === true && r.leadPosts.length === 1);
    check("weekend: CONVERSATION STILL CREATED", r.convUpserts.length === 1);
    check("weekend: no live-specialist promise", promisesLiveHuman(r.data.reply) === false);
    check("weekend: business-hours message and application URL shown",
      /Monday–Friday/.test(r.data.reply) && r.data.reply.includes(FULL_APPLICATION_URL));

    // Sunday, for completeness.
    const sun = await invoke(
      { messages: READY, sessionId: "bh-sunday" },
      { at: "2026-01-18T16:00:00Z", modelText: LIVE_HANDOFF_TEXT },
    );
    check("Sunday behaves the same",
      sun.data.businessHours.open === false && sun.data.liveHandoff === false &&
      sun.leadPosts.length === 1 && promisesLiveHuman(sun.data.reply) === false);
  }

  line("8. AFTER HOURS + EXCLUDED INDUSTRY  ->  still no specialist, still no link");

  {
    const declineText =
      "Spartan isn't able to fund cannabis dispensaries, so I'm not the right fit " +
      "for this one.\n[[SCG_STATUS: DECLINE]]";
    const r = await invoke(
      {
        messages: [{ role: "user", content: "I run a dispensary and want to apply for funding." }],
        sessionId: "bh-declined",
      },
      { at: "2026-01-15T01:00:00Z", modelText: declineText },
    );

    check("declined after hours: no handoff, no Lead",
      r.data.handoff === false && r.leadPosts.length === 0);
    check("declined after hours: no Conversation__c either", r.convUpserts.length === 0);
    check("declined after hours: the after-hours notice is NOT a back door to the link",
      !r.data.reply.includes("apply.spartancapitalgroup.com"));
    check("declined after hours: no business-hours pitch",
      !/available Monday–Friday/.test(r.data.reply));
    check("declined after hours: the decline itself reached the visitor",
      /isn't able to fund cannabis dispensaries/.test(r.data.reply));
    check("liveHandoff is false", r.data.liveHandoff === false);
  }

  line("9. ALREADY LIVE  ->  6pm does not interrupt a rep mid-chat");

  {
    const midChat = [
      { role: "user", content: "I need working capital for my bakery" },
      { role: "assistant", content: "A funding specialist is with you now." },
      { role: "user", content: "great, what documents do you need?" },
    ];

    // 5:50pm EST: the rep claimed it while on shift.
    const before = await invoke(
      { messages: midChat, sessionId: "bh-live" },
      { at: "2026-01-14T22:50:00Z", status: "Claimed", modelText: LIVE_HANDOFF_TEXT },
    );
    // 6:05pm EST: fifteen minutes later, same claimed conversation.
    const after = await invoke(
      { messages: midChat, sessionId: "bh-live" },
      { at: "2026-01-14T23:05:00Z", status: "Claimed", modelText: LIVE_HANDOFF_TEXT },
    );

    check("before 6pm: live, no bot reply, Claude not called",
      before.data.live === true && before.data.reply === null && before.claudeCalls === 0);
    check("AFTER 6pm: still live, still no bot reply, Claude still not called",
      after.data.live === true && after.data.reply === null && after.claudeCalls === 0);
    check("the two responses are byte-identical — the gate never sees this path",
      JSON.stringify(after.data) === JSON.stringify(before.data));
    check("no business-hours fields are grafted onto a live turn",
      after.data.businessHours === undefined && after.data.liveHandoff === undefined);
    check("after 6pm the visitor's message is STILL recorded Inbound for the rep",
      after.inbound.length === 1 &&
      after.inbound[0].body.Body__c === "great, what documents do you need?");
    check("nothing rewrote the conversation's status", after.statusPatches.length === 0);
    check("no second Lead, no second Conversation__c",
      after.leadPosts.length === 0 && after.convUpserts.length === 0);

    // And the hand-back path still works after hours: Claimed -> New at 8pm
    // means the BOT answers, and now it answers under the gate.
    const handedBack = await invoke(
      { messages: midChat, sessionId: "bh-handback" },
      { at: "2026-01-15T01:00:00Z", status: "New", modelText: LIVE_HANDOFF_TEXT },
    );
    check("a rep who hands back after hours leaves the bot answering, gated",
      handedBack.data.live === undefined && handedBack.claudeCalls === 1 &&
      handedBack.data.businessHours.open === false &&
      promisesLiveHuman(handedBack.data.reply) === false);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`BUSINESS HOURS: ${passed} assertions passed, zero real network calls`);
  console.log("=".repeat(72));
  console.log("Confirmed: Mon–Fri 9am–6pm ET offers a live specialist; every other");
  console.log("hour still captures the lead and the conversation, promises nobody,");
  console.log("and offers the 24/7 application instead. A chat a rep already holds");
  console.log("is untouched by the gate.\n");
}

await main();
