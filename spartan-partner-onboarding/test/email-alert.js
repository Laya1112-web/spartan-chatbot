/**
 * Proves the notification email is a short alert and not a field dump.
 *
 *   node test/email-alert.js      (or: npm test)
 *
 * The claims under test:
 *
 *   1. The body carries the four identity fields and the S3 key.
 *   2. It carries NONE of the other 59 mapped fields -- not a label, not a
 *      value -- and none of the old renderer's furniture (section headings,
 *      "Additional Fields", the submission-record footer).
 *   3. A missing identity value prints the label with an em dash, so the shape
 *      is constant across alerts.
 *   4. It stays under 15 lines.
 *   5. The subject is unchanged.
 *   6. SECTIONS is untouched, so the sheet's column order cannot have moved.
 *
 * The 59 are derived from SECTIONS here, not listed, so a field added to the
 * map is automatically covered by claim 2.
 */

import assert from "node:assert";

import { SECTIONS, buildEmailBody, buildSubject } from "../fields.js";

const IDENTITY_KEYS = ["iso_legal", "owner_name", "owner_email", "owner_phone"];

/** Every mapped key with a sentinel value, so a leak is unmistakable. */
const ALL_FIELDS = {};
for (const section of SECTIONS) {
  for (const key of Object.keys(section.fields)) ALL_FIELDS[key] = `SENTINEL-${key}-VALUE`;
}
// Plus an unmapped key: the old renderer printed these under "Additional Fields".
ALL_FIELDS.some_future_field = "SENTINEL-overflow-VALUE";

const ENVELOPE = {
  id: "po_20260916T134512Z_9f3a1c74",
  receivedAt: "2026-09-16T13:45:12.884Z",
  sourceIp: "203.0.113.9",
  bucket: "spartan-capital-partner-submissions",
  key: "onboarding/2026/09/po_20260916T134512Z_9f3a1c74.json",
};

const pass = (message) => console.log(`PASS  ${message}`);

// ---------------------------------------------------------------------------
// 1. The four identity fields and the S3 key are present.
// ---------------------------------------------------------------------------
{
  const body = buildEmailBody({ lead: ALL_FIELDS, ...ENVELOPE });

  for (const [label, key] of [["ISO Legal Name", "iso_legal"], ["Owner Name", "owner_name"],
                              ["Owner Email", "owner_email"], ["Owner Phone", "owner_phone"]]) {
    assert.ok(body.includes(`${label}: SENTINEL-${key}-VALUE`), `${label} is printed with its value`);
  }

  assert.ok(body.includes(`S3 Key: ${ENVELOPE.key}`), "the S3 key is printed");
  assert.ok(body.includes(`Received: ${ENVELOPE.receivedAt}`), "the received timestamp is printed");
  assert.ok(
    body.includes("Full submission is in the Partner Onboarding tab of the Partner Form Submissions sheet."),
    "the pointer to the sheet is printed verbatim",
  );

  pass("the alert carries the four identity fields, the timestamp, the S3 key and the pointer");
}

// ---------------------------------------------------------------------------
// 2. None of the other 59 fields -- label or value -- and no old furniture.
// ---------------------------------------------------------------------------
{
  const body = buildEmailBody({ lead: ALL_FIELDS, ...ENVELOPE });

  const others = [];
  for (const section of SECTIONS) {
    for (const [key, label] of Object.entries(section.fields)) {
      if (!IDENTITY_KEYS.includes(key)) others.push({ key, label });
    }
  }

  assert.strictEqual(others.length, 59, "59 non-identity mapped fields");

  for (const { key, label } of others) {
    assert.ok(!body.includes(`SENTINEL-${key}-VALUE`), `value of ${key} does NOT appear`);
    assert.ok(!body.includes(label), `label "${label}" does NOT appear`);
  }

  assert.ok(!body.includes("SENTINEL-overflow-VALUE"), "an unmapped key does NOT appear");

  // The old renderer's furniture is gone.
  for (const relic of ["SUBMISSION RECORD", "Additional Fields", "Submission ID:", "Source IP", "S3 Bucket",
                       ...SECTIONS.map((s) => s.title.toUpperCase())]) {
    assert.ok(!body.includes(relic), `"${relic}" is gone`);
  }

  // Nothing is leaking that was passed but not meant to print.
  assert.ok(!body.includes(ENVELOPE.sourceIp), "source IP is not printed");
  assert.ok(!body.includes(ENVELOPE.bucket), "bucket name is not printed");

  pass("the alert contains none of the other 59 labels or values, and no section furniture");
}

// ---------------------------------------------------------------------------
// 3. Missing identity values print an em dash; the shape stays constant.
// ---------------------------------------------------------------------------
{
  const full = buildEmailBody({ lead: ALL_FIELDS, ...ENVELOPE });
  const empty = buildEmailBody({ lead: {}, ...ENVELOPE });
  const blankish = buildEmailBody({
    lead: { iso_legal: "   ", owner_name: null, owner_email: undefined, owner_phone: "" },
    ...ENVELOPE,
  });

  for (const label of ["ISO Legal Name", "Owner Name", "Owner Email", "Owner Phone"]) {
    assert.ok(empty.includes(`${label}: —`), `${label} prints an em dash when absent`);
    assert.ok(blankish.includes(`${label}: —`), `${label} prints an em dash when blank/whitespace`);
  }

  assert.strictEqual(empty.split("\n").length, full.split("\n").length, "line count is identical when fields are missing");
  assert.strictEqual(blankish.split("\n").length, full.split("\n").length, "line count is identical when fields are blank");
  assert.ok(!empty.includes("undefined") && !empty.includes("null"), "no undefined/null leaks into the body");

  // A missing key is still a pointer to the data.
  assert.ok(empty.includes(`S3 Key: ${ENVELOPE.key}`), "the pointer survives a fully empty lead");

  pass("missing identity values print an em dash and the shape is constant");
}

// ---------------------------------------------------------------------------
// 4. Under 15 lines.
// ---------------------------------------------------------------------------
{
  const lines = buildEmailBody({ lead: ALL_FIELDS, ...ENVELOPE }).split("\n");
  assert.ok(lines.length < 15, `body is ${lines.length} lines, under 15`);
  pass(`the alert is ${lines.length} lines`);
}

// ---------------------------------------------------------------------------
// 5. The subject is unchanged.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(
    buildSubject({ iso_legal: "Redline Capital Partners LLC" }),
    "Partner Onboarding Completed — Redline Capital Partners LLC",
  );
  assert.strictEqual(
    buildSubject({ owner_name: "Dana Reyes" }),
    "Partner Onboarding Completed — Dana Reyes",
    "falls back to owner name",
  );
  assert.strictEqual(
    buildSubject({ owner_email: "dana@redlinecapital.example" }),
    "Partner Onboarding Completed — dana@redlinecapital.example",
    "falls back to owner email",
  );
  assert.strictEqual(buildSubject({}), "Partner Onboarding Completed — Unknown Partner");
  pass("the subject is unchanged");
}

// ---------------------------------------------------------------------------
// 6. SECTIONS is untouched -- the sheet's columns cannot have moved.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(SECTIONS.length, 6, "six sections");
  assert.deepStrictEqual(
    SECTIONS.map((s) => [s.title, Object.keys(s.fields).length]),
    [["Your Information", 30], ["Your Business", 6], ["Volume", 7],
     ["Lead Sources", 8], ["Strategy", 7], ["Online Presence", 5]],
    "section titles, order and field counts are unchanged",
  );
  assert.strictEqual(Object.keys(SECTIONS[0].fields)[0], "iso_legal", "first column key is unchanged");
  assert.strictEqual(Object.values(SECTIONS[5].fields).at(-1), "Other", "last column label is unchanged");
  pass("the SECTIONS map is unchanged");
}

console.log("\n--- the rendered alert ---");
// owner_phone is deliberately absent, to show the em-dash line in place.
console.log(buildEmailBody({
  lead: {
    iso_legal: "Redline Capital Partners LLC",
    owner_name: "Dana Reyes",
    owner_email: "dana@redlinecapital.example",
  },
  ...ENVELOPE,
}));
console.log("---\n");
console.log("All email-alert assertions passed.");
