/**
 * Proves index.js emits NO CORS headers, on every response path.
 *
 *   node test/no-cors-headers.js      (or: npm test)
 *
 * The Function URL's own CORS config owns those headers. When this handler set
 * them too, every response carried Access-Control-Allow-Origin and Vary twice,
 * and a browser rejects a response with more than one Access-Control-Allow-Origin
 * value -- so submissions failed in the browser while curl saw a clean 200.
 *
 * That bug is invisible to anything but a real browser, which is why it is
 * pinned here: the assertion is that the ONLY header this handler sets is
 * Content-Type, whatever the Origin and whatever the outcome.
 */

import assert from "node:assert";

import { S3Client } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";

const BANNED = ["access-control-allow-origin", "access-control-allow-methods",
                "access-control-allow-headers", "access-control-max-age",
                "access-control-allow-credentials", "vary"];

process.env.SUBMISSIONS_BUCKET = "test-bucket";
// Deliberately set: it must now be ignored, not honoured.
process.env.ALLOWED_ORIGIN = "https://apply.spartancapitalgroup.com";
delete process.env.SES_FROM;
delete process.env.NOTIFY_TO;
delete process.env.SHEETS_WEBHOOK_URL;
delete process.env.SHAREPOINT_FLOW_URL;

let s3Fails = false;
S3Client.prototype.send = async function () {
  if (s3Fails) throw new Error("simulated S3 outage");
  return {};
};
SESClient.prototype.send = async function () { return {}; };
globalThis.fetch = async () => new Response("{}", { status: 200 });

const { handler } = await import("../index.js");

function quiet(fn) {
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return (async () => { try { return await fn(); } finally { Object.assign(console, real); } })();
}

const call = (method, origin, body) =>
  quiet(() => handler({
    requestContext: { http: { method, sourceIp: "203.0.113.9" } },
    headers: origin ? { origin } : {},
    body: body === undefined ? JSON.stringify({ lead: { owner_email: "a@b.example" } }) : body,
  }));

function assertClean(res, label) {
  const keys = Object.keys(res.headers).map((k) => k.toLowerCase());
  for (const banned of BANNED) {
    assert.ok(!keys.includes(banned), `${label}: must not set "${banned}"`);
  }
  assert.deepStrictEqual(keys, ["content-type"], `${label}: Content-Type is the ONLY header`);
  assert.strictEqual(res.headers["Content-Type"], "application/json", `${label}: content type`);
}

const pass = (m) => console.log(`PASS  ${m}`);

// Every response path, with and without an Origin that ALLOWED_ORIGIN permits.
for (const origin of ["https://apply.spartancapitalgroup.com", "https://evil.example", undefined]) {
  const tag = origin ?? "(no Origin)";

  assertClean(await call("OPTIONS", origin), `OPTIONS ${tag}`);
  assertClean(await call("GET", origin), `GET ${tag}`);
  assertClean(await call("POST", origin, JSON.stringify({ lead: {} })), `POST 400 ${tag}`);
  assertClean(await call("POST", origin), `POST 200 ${tag}`);

  s3Fails = true;
  assertClean(await call("POST", origin), `POST 500 ${tag}`);
  s3Fails = false;
}
pass("no CORS headers on any path (OPTIONS/405/400/200/500), any Origin");

// Status codes are unchanged by the CORS removal.
assert.strictEqual((await call("OPTIONS", undefined)).statusCode, 204, "OPTIONS still 204");
assert.strictEqual((await call("GET", undefined)).statusCode, 405, "non-POST still 405");
assert.strictEqual((await call("POST", undefined, JSON.stringify({ lead: {} }))).statusCode, 400, "no owner_email still 400");
assert.strictEqual((await call("POST", undefined)).statusCode, 200, "valid POST still 200");
s3Fails = true;
assert.strictEqual((await call("POST", undefined)).statusCode, 500, "S3 failure still 500");
s3Fails = false;
pass("status codes unchanged: 204 / 405 / 400 / 200 / 500");

// corsHeaders is gone from the module surface.
const mod = await import("../index.js");
assert.ok(!("corsHeaders" in mod), "corsHeaders is no longer exported");
assert.deepStrictEqual(Object.keys(mod).sort(), ["generateId", "handler", "parseBody"], "exports");
pass("corsHeaders is gone from the module surface");

console.log("\nAll no-cors-headers assertions passed.");
