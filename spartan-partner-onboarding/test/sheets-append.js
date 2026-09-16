/**
 * Proves the Google Sheets append in sheets.js and its wiring in index.js.
 *
 *   node test/sheets-append.js      (or: npm test)
 *
 * The claims under test, in the order they matter:
 *
 *   1. `headers` and `values` are the same length, and both follow the field
 *      map in fields.js in map order, with Submission ID and Received At first.
 *      The expected order is derived from SECTIONS *here*, independently of
 *      sheets.js, so a hardcoded column list in either file would fail this.
 *   2. Missing and empty fields become "" -- never undefined, never null, never
 *      the string "undefined".
 *   3. A webhook failure still returns 200, with the warn logged.
 *   4. An S3 failure returns 500 and never attempts the append.
 *   5. An unset SHEETS_WEBHOOK_URL skips silently -- no fetch, no log.
 *
 * Every outbound call is stubbed: `sheetsCalls` is the proof that a skipped or
 * S3-failed submission made no request at all.
 */

import assert from "node:assert";

import { S3Client } from "@aws-sdk/client-s3";
import { SESClient } from "@aws-sdk/client-ses";

import { SECTIONS } from "../fields.js";

const WEBHOOK = "https://script.google.com/macros/s/TEST_DEPLOYMENT/exec";

process.env.SUBMISSIONS_BUCKET = "test-bucket";
process.env.ALLOWED_ORIGIN = "https://apply.spartancapitalgroup.com";
delete process.env.SES_FROM;
delete process.env.NOTIFY_TO;
delete process.env.SHAREPOINT_FLOW_URL;
delete process.env.SHEETS_WEBHOOK_URL;

/**
 * Stub the S3 and SES clients at the prototype, before index.js is imported and
 * storage.js/notify.js construct theirs -- the instances delegate `send` here,
 * so nothing in this file needs AWS credentials or a network. `s3Fails` flips
 * the write to the failure path that must produce a 500.
 */
let s3Fails = false;
let s3Writes = 0;

S3Client.prototype.send = async function send() {
  s3Writes++;
  if (s3Fails) throw new Error("simulated S3 outage");
  return {};
};

SESClient.prototype.send = async function send() {
  return {};
};

/** Every fetch this function makes, captured with its parsed body. */
let sheetsCalls = [];

globalThis.fetch = async (url, init) => {
  const call = { url: String(url), init, body: JSON.parse(init.body) };
  sheetsCalls.push(call);

  if (globalThis.__sheetsShouldFail === "throw") throw new Error("simulated network failure");
  if (globalThis.__sheetsShouldFail === "status") {
    return new Response("Script function not found", { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const { handler } = await import("../index.js");

/** Capture console output so the PASS lines stay readable, and assert on it. */
async function capture(fn) {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const record = (...args) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    Object.assign(console, real);
  }
}

function invoke(lead) {
  sheetsCalls = [];
  return capture(() =>
    handler({
      requestContext: { http: { method: "POST", sourceIp: "203.0.113.9" } },
      headers: { origin: "https://apply.spartancapitalgroup.com" },
      body: JSON.stringify({ action: "partner_onboarding", lead }),
    }),
  );
}

/** A realistically sparse packet: the reveal fields are submitted blank. */
const LEAD = {
  iso_legal: "  Redline Capital Partners LLC  ",
  dba: "Redline Capital",
  ein: "88-1234567",
  owner_name: "Dana Reyes",
  owner_email: "dana@redlinecapital.example",
  biz_city: "Newark",
  biz_state: "NJ",
  website: "https://redlinecapital.example",
  has_owner2: "No",
  owner2_name: "",
  owner2_phone: "   ",
  loc_additional: null,
  outside_pct: undefined,
  top_funders: ["Spartan", " Forward Line ", ""],
  reps_in_office: 12,
  src_packages: 40,
  web_site: "https://redlinecapital.example",
  web_linkedin: "https://linkedin.example/company/redline",
  // Not in the map: must NOT widen the row.
  some_future_field: "ignored by the sheet, kept in S3 and the email",
};

/**
 * The expected header row, derived from SECTIONS right here. sheets.js builds
 * its own from the same source; if either ever grew a hardcoded list, these two
 * would disagree.
 */
function expectedColumns() {
  const counts = new Map();
  for (const section of SECTIONS) {
    for (const label of Object.values(section.fields)) counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const columns = [];
  for (const section of SECTIONS) {
    for (const [key, label] of Object.entries(section.fields)) {
      columns.push({ key, header: counts.get(label) > 1 ? `${label} (${section.title})` : label });
    }
  }
  return columns;
}

const COLUMNS = expectedColumns();
const pass = (message) => console.log(`PASS  ${message}`);

// ---------------------------------------------------------------------------
// 1. Shape and order.
// ---------------------------------------------------------------------------
{
  process.env.SHEETS_WEBHOOK_URL = WEBHOOK;
  const { value, lines } = await invoke(LEAD);

  assert.strictEqual(value.statusCode, 200, "a stored submission returns 200");
  assert.strictEqual(sheetsCalls.length, 1, "exactly one webhook call");

  const [call] = sheetsCalls;
  assert.strictEqual(call.url, WEBHOOK);
  assert.strictEqual(call.init.method, "POST");
  assert.strictEqual(call.init.headers["Content-Type"], "application/json");

  const { headers, values } = call.body;
  assert.deepStrictEqual(Object.keys(call.body).sort(), ["headers", "values"], "body is exactly { headers, values }");
  assert.ok(Array.isArray(headers) && Array.isArray(values), "both are arrays");
  assert.strictEqual(headers.length, values.length, "headers and values are equal length");

  assert.deepStrictEqual(
    headers,
    ["Submission ID", "Received At", ...COLUMNS.map((c) => c.header)],
    "headers are the envelope columns then the field map, in map order",
  );
  assert.strictEqual(headers.length, 2 + COLUMNS.length, `${2 + COLUMNS.length} columns`);

  // Unique headers: a spreadsheet uses the header row as a lookup key.
  assert.strictEqual(new Set(headers).size, headers.length, "no duplicate header names");
  assert.ok(headers.includes("Website (Your Information)") && headers.includes("Website (Online Presence)"),
    "the two Website columns are both present, qualified by section");

  // The envelope columns really are the submission's identity.
  assert.match(values[0], /^po_\d{8}T\d{6}Z_[0-9a-f]{8}$/, "column 1 is the submission id");
  assert.match(values[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, "column 2 is the ISO received-at");
  assert.strictEqual(values[0], JSON.parse(value.body).id, "the id in the row is the id returned to the browser");

  // Spot-check that values line up with their headers by position.
  const at = (key) => values[2 + COLUMNS.findIndex((c) => c.key === key)];
  assert.strictEqual(at("iso_legal"), "Redline Capital Partners LLC", "values are trimmed");
  assert.strictEqual(at("owner_email"), "dana@redlinecapital.example");
  assert.strictEqual(at("reps_in_office"), "12", "numbers are stringified");
  assert.strictEqual(at("top_funders"), "Spartan, Forward Line", "arrays join, blanks dropped");
  assert.strictEqual(at("web_site"), "https://redlinecapital.example", "the Section 6 duplicate carries its own value");

  // An unmapped key must not widen the row.
  assert.ok(!values.includes("ignored by the sheet, kept in S3 and the email"), "unmapped keys are not appended");

  assert.ok(lines.some((l) => l.includes("submission complete")), "the completion line is logged");
  pass("headers and values are equal length and follow the field map order");
}

// ---------------------------------------------------------------------------
// 2. Empty fields are empty strings.
// ---------------------------------------------------------------------------
{
  process.env.SHEETS_WEBHOOK_URL = WEBHOOK;
  await invoke(LEAD);
  const { values } = sheetsCalls[0].body;
  const at = (key) => values[2 + COLUMNS.findIndex((c) => c.key === key)];

  for (const value of values) {
    assert.strictEqual(typeof value, "string", "every cell is a string");
    assert.notStrictEqual(value, "undefined", 'no cell is the string "undefined"');
    assert.notStrictEqual(value, "null", 'no cell is the string "null"');
  }

  assert.strictEqual(at("owner2_name"), "", "a submitted empty string is ''");
  assert.strictEqual(at("owner2_phone"), "", "a whitespace-only value is ''");
  assert.strictEqual(at("loc_additional"), "", "null is ''");
  assert.strictEqual(at("outside_pct"), "", "undefined is ''");
  assert.strictEqual(at("ein"), "88-1234567");
  assert.strictEqual(at("mpoc_name"), "", "a key the form never sent is ''");
  assert.strictEqual(at("scrub_other"), "", "an absent reveal field is ''");

  pass("missing and empty fields are empty strings, never undefined/null");
}

// ---------------------------------------------------------------------------
// 3. A webhook failure still returns 200, with the warn logged.
// ---------------------------------------------------------------------------
for (const mode of ["throw", "status"]) {
  process.env.SHEETS_WEBHOOK_URL = WEBHOOK;
  globalThis.__sheetsShouldFail = mode;

  const { value, lines } = await invoke(LEAD);

  assert.strictEqual(value.statusCode, 200, `a sheets ${mode} failure still returns 200`);
  assert.strictEqual(JSON.parse(value.body).success, true, "success is still true");
  assert.strictEqual(sheetsCalls.length, 1, "the append was attempted");

  const warn = lines.find((l) => l.includes("sheets append failed, submission IS saved"));
  assert.ok(warn, "the exact failure line is logged");
  assert.ok(warn.includes(JSON.parse(value.body).id), "the log line carries the submission id");
  assert.ok(lines.some((l) => l.includes("submission stored")), "the packet is still stored");

  delete globalThis.__sheetsShouldFail;
  pass(`a webhook failure (${mode}) returns 200 with the warn logged`);
}

// ---------------------------------------------------------------------------
// 4. An S3 failure returns 500 and never attempts the append.
// ---------------------------------------------------------------------------
{
  process.env.SHEETS_WEBHOOK_URL = WEBHOOK;
  s3Fails = true;

  const { value, lines } = await invoke(LEAD);

  assert.strictEqual(value.statusCode, 500, "an S3 failure is a 500");
  assert.strictEqual(JSON.parse(value.body).success, false);
  assert.strictEqual(sheetsCalls.length, 0, "the append was NEVER attempted");
  assert.ok(lines.some((l) => l.includes("submission NOT stored")), "the S3 failure is logged");
  assert.ok(!lines.some((l) => l.includes("sheets append")), "no sheets line at all");

  s3Fails = false;
  pass("an S3 failure returns 500 without attempting the append");
}

// ---------------------------------------------------------------------------
// 5. An unset SHEETS_WEBHOOK_URL skips silently.
// ---------------------------------------------------------------------------
for (const [label, setUrl] of [["An unset", () => delete process.env.SHEETS_WEBHOOK_URL],
                               ["An empty", () => (process.env.SHEETS_WEBHOOK_URL = "")],
                               ["A whitespace-only", () => (process.env.SHEETS_WEBHOOK_URL = "   ")]]) {
  setUrl();
  const writesBefore = s3Writes;
  const { value, lines } = await invoke(LEAD);

  assert.strictEqual(value.statusCode, 200, `${label} URL still returns 200`);
  assert.strictEqual(s3Writes, writesBefore + 1, "the packet is still stored");
  assert.strictEqual(sheetsCalls.length, 0, `${label} URL makes no request`);
  assert.ok(!lines.some((l) => l.toLowerCase().includes("sheets")), `${label} URL logs nothing about sheets`);

  pass(`${label} SHEETS_WEBHOOK_URL skips silently`);
}

console.log("\nAll sheets-append assertions passed.");
