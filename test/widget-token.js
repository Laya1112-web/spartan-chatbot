/**
 * Proves the shared widget-token gate in index.js.
 *
 *   node test/widget-token.js
 *
 * The central claim under test: with WIDGET_TOKEN set, a request without the
 * matching x-widget-token header gets a 401 and never reaches Claude (or, by
 * extension, Salesforce) -- every outbound fetch is stubbed and counted, so a
 * blocked request can be shown to have made none.
 *
 * The gate is deliberately fail-open when WIDGET_TOKEN is unset, so that case
 * is asserted too: it must allow the request and warn.
 */

import assert from "node:assert";

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-test-dummy";
delete process.env.WIDGET_TOKEN;

const { handler, setClock } = await import("../index.js");
// Pin the clock inside business hours (Wed 2:00pm ET), so the after-hours gate
// in businessHours.js stays dormant and this file's assertions on exact reply
// text hold whatever hour the suite actually runs at.
setClock(() => new Date("2026-01-14T19:00:00Z"));


// Every outbound call is stubbed. `fetches` is the proof that a 401 request
// touched nothing -- the Anthropic SDK and salesforce.js both go through fetch.
let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  return new Response(
    JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5",
      content: [{ type: "text", text: "Hi there.\n[[SCG_STATUS: OK]]" }],
      stop_reason: "end_turn", stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

/** Swallow the handler's own console output so the PASS lines stay readable. */
function captureWarnings(fn) {
  const realWarn = console.warn;
  const realLog = console.log;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  console.log = () => {};
  return (async () => {
    try {
      const value = await fn();
      return { value, warnings };
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
  })();
}

const POST = (headers = {}) => ({
  requestContext: { http: { method: "POST" } },
  headers: { origin: "https://www.spartancapital.us", ...headers },
  body: JSON.stringify({
    messages: [{ role: "user", content: "What do you offer?" }],
    sessionId: "widget-token-test",
  }),
});

let passed = 0;
function check(label, cond) {
  assert.ok(cond, `FAILED: ${label}`);
  console.log(`  [PASS] ${label}`);
  passed++;
}

const line = (t) => console.log(`\n${t}\n`);

async function main() {
  line("WIDGET_TOKEN UNSET  -> fail open, but warn (don't lock ourselves out)");

  {
    delete process.env.WIDGET_TOKEN;
    fetches = 0;
    const { value: res, warnings } = await captureWarnings(() => handler(POST()));
    const data = JSON.parse(res.body);
    check("no WIDGET_TOKEN, no header -> 200 and the reply is served",
      res.statusCode === 200 && data.reply === "Hi there." && data.error === undefined);
    check("no WIDGET_TOKEN -> Claude was actually called", fetches === 1);
    check("no WIDGET_TOKEN -> warns that the gate is disabled",
      warnings.some((w) => /WIDGET_TOKEN is not set/.test(w) && /DISABLED/.test(w)));
  }

  {
    // A stray header with no expected token configured is simply ignored.
    delete process.env.WIDGET_TOKEN;
    fetches = 0;
    const { value: res } = await captureWarnings(() =>
      handler(POST({ "x-widget-token": "whatever" })));
    check("no WIDGET_TOKEN, header present anyway -> still 200",
      res.statusCode === 200 && fetches === 1);
  }

  line("WIDGET_TOKEN SET + MATCHING HEADER  -> allowed");

  {
    process.env.WIDGET_TOKEN = "scg-widget-secret-123";
    fetches = 0;
    const { value: res, warnings } = await captureWarnings(() =>
      handler(POST({ "x-widget-token": "scg-widget-secret-123" })));
    const data = JSON.parse(res.body);
    check("matching token -> 200 and the reply is served",
      res.statusCode === 200 && data.reply === "Hi there." && data.error === undefined);
    check("matching token -> Claude was called", fetches === 1);
    check("matching token -> no gate warning emitted",
      !warnings.some((w) => /WIDGET_TOKEN/.test(w) || /widget token/.test(w)));
  }

  {
    // Function URLs lower-case header keys, but the lookup must not depend on it.
    process.env.WIDGET_TOKEN = "scg-widget-secret-123";
    fetches = 0;
    const { value: res } = await captureWarnings(() =>
      handler(POST({ "X-Widget-Token": "scg-widget-secret-123" })));
    check("matching token in mixed-case header name -> 200",
      res.statusCode === 200 && fetches === 1);
  }

  line("WIDGET_TOKEN SET + BAD/MISSING HEADER  -> 401, Claude never called");

  const rejected = [
    ["header absent entirely", {}],
    ["wrong token", { "x-widget-token": "not-the-token" }],
    ["empty token", { "x-widget-token": "" }],
    ["token with trailing whitespace (no fuzzy matching)",
      { "x-widget-token": "scg-widget-secret-123 " }],
    ["case-shifted token value", { "x-widget-token": "SCG-WIDGET-SECRET-123" }],
    ["prefix of the real token", { "x-widget-token": "scg-widget" }],
  ];

  for (const [label, extraHeaders] of rejected) {
    process.env.WIDGET_TOKEN = "scg-widget-secret-123";
    fetches = 0;
    const { value: res } = await captureWarnings(() => handler(POST(extraHeaders)));
    const data = JSON.parse(res.body);
    check(`${label} -> 401 with a JSON error`,
      res.statusCode === 401 && typeof data.error === "string" && data.error.length > 0);
    check(`${label} -> zero outbound calls (no Claude, no Salesforce)`, fetches === 0);
    check(`${label} -> normal CORS headers still present`,
      res.headers["Access-Control-Allow-Origin"] === "https://www.spartancapital.us" &&
      res.headers["Content-Type"] === "application/json" &&
      res.headers.Vary === "Origin");
  }

  {
    process.env.WIDGET_TOKEN = "scg-widget-secret-123";
    const { value: res } = await captureWarnings(() => handler(POST()));
    check("401 body leaks no token or transcript detail",
      !/scg-widget-secret-123/.test(res.body) && !/What do you offer/.test(res.body));
  }

  line("OPTIONS PREFLIGHT  -> succeeds regardless of the token");

  for (const [label, headers] of [
    ["token set, no header (what a browser actually sends)", {}],
    ["token set, wrong header", { "x-widget-token": "nope" }],
  ]) {
    process.env.WIDGET_TOKEN = "scg-widget-secret-123";
    fetches = 0;
    const { value: res } = await captureWarnings(() =>
      handler({
        requestContext: { http: { method: "OPTIONS" } },
        headers: { origin: "https://www.spartancapital.us", ...headers },
      }));
    check(`preflight (${label}) -> success, not 401`,
      res.statusCode === 204 && fetches === 0);
    check(`preflight (${label}) -> advertises x-widget-token as allowed`,
      /x-widget-token/.test(res.headers["Access-Control-Allow-Headers"]) &&
      /Content-Type/.test(res.headers["Access-Control-Allow-Headers"]));
  }

  {
    delete process.env.WIDGET_TOKEN;
    const { value: res } = await captureWarnings(() =>
      handler({
        requestContext: { http: { method: "OPTIONS" } },
        headers: { origin: "https://www.spartancapital.us" },
      }));
    check("preflight with no WIDGET_TOKEN configured -> success too",
      res.statusCode === 204);
  }

  line("GATE ORDERING  -> the token is checked before the body is parsed");

  {
    process.env.WIDGET_TOKEN = "scg-widget-secret-123";
    fetches = 0;
    const { value: res } = await captureWarnings(() =>
      handler({
        requestContext: { http: { method: "POST" } },
        headers: { origin: "https://www.spartancapital.us" },
        body: "{ not json at all",
      }));
    check("garbage body without a token -> 401 (not 400): gate runs first",
      res.statusCode === 401 && fetches === 0);
  }

  {
    // A non-POST method is still rejected as 405, ahead of the gate.
    process.env.WIDGET_TOKEN = "scg-widget-secret-123";
    const { value: res } = await captureWarnings(() =>
      handler({
        requestContext: { http: { method: "GET" } },
        headers: { origin: "https://www.spartancapital.us" },
      }));
    check("GET without a token -> 405 (method check precedes the gate)",
      res.statusCode === 405);
  }

  delete process.env.WIDGET_TOKEN;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`WIDGET TOKEN GATE: ${passed} assertions passed, zero real network calls`);
  console.log("=".repeat(72));
  console.log("Confirmed: WIDGET_TOKEN set + bad/missing header -> 401 before");
  console.log("Claude or Salesforce is touched. Unset -> fail open with a warning.");
}

await main();
