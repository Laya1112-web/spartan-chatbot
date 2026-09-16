/**
 * The optional Google Sheets append: one row per submission, posted to an Apps
 * Script web app.
 *
 * This mirrors how the Python spartan-lead-handler files leads -- a plain JSON
 * POST to a deployed Apps Script URL, no auth, no service account, no
 * googleapis client. The Apps Script itself holds the spreadsheet id and the
 * permission to write to it; this module only has to hand it a row.
 *
 * It follows the same two rules as sharepoint.js, for the same reasons:
 *
 *   1. If SHEETS_WEBHOOK_URL is unset or empty the append is SKIPPED SILENTLY.
 *      Not a warning, not an error -- the sheet is a convenience copy, and an
 *      environment that has not configured it is not misconfigured.
 *
 *   2. A failure here NEVER fails the request. The submission is already in S3
 *      by the time this runs. S3 is the durable record; the sheet is a
 *      convenience copy for whoever works the packets. Logged and swallowed.
 *
 * Uses the global fetch of the Node 20 runtime, as sharepoint.js and
 * spartan-chatbot's whatsapp.js do -- no HTTP dependency.
 *
 * THE COLUMNS COME FROM fields.js AND NOWHERE ELSE.
 *
 * There is deliberately no second list of column names in this file. The header
 * row and the value row are both generated from SECTIONS, in map order, so the
 * sheet cannot drift from the notification email: a field added to the map gets
 * a column in both, and a field removed from the map loses its column in both.
 * Hardcoding the columns here would recreate exactly the drift this arrangement
 * exists to prevent.
 */

import { SECTIONS } from "./fields.js";

/**
 * How long to wait on the Apps Script before giving up.
 *
 * Longer than the SharePoint relay's 5s because Apps Script web apps are slower
 * to answer -- a cold script plus the 302 hop below regularly costs a few
 * seconds -- but still bounded, so a hanging script cannot push this function
 * toward its own Lambda timeout and turn a stored submission into a client
 * error.
 */
const SHEETS_TIMEOUT_MS = 10000;

/**
 * The two envelope columns, ahead of every form field.
 *
 * These are the submission's identity, not its content, which is why they are
 * named here rather than derived: they are the join key back to the S3 object
 * (`onboarding/<YYYY>/<MM>/<id>.json`) and to the CloudWatch lines, so whoever
 * is reading the sheet can always get from a row to the raw packet.
 */
const ENVELOPE_HEADERS = ["Submission ID", "Received At"];

/**
 * Build the field columns from SECTIONS: every key of every section, in the
 * order the map lists them, labelled as the email labels it.
 *
 * One mechanical adjustment: when the same label appears in two sections the
 * section title is appended to both, so the header row has no duplicate names.
 * That matters only for `website` (Your Information) and `web_site` (Online
 * Presence), which fields.js deliberately keeps as two distinct keys carrying
 * the same value. Both still get their own column -- collapsing them would be
 * this module deciding the form is redundant, which fields.js explicitly says
 * is not its call -- but a spreadsheet treats the header row as a lookup key,
 * and two columns both called "Website" makes any formula or pivot over them
 * silently pick the first. The rule is derived from the map, so it cannot drift
 * either.
 *
 * Computed once at module scope; SECTIONS is static.
 */
function buildFieldColumns() {
  const labelCounts = new Map();

  for (const section of SECTIONS) {
    for (const label of Object.values(section.fields)) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }

  const columns = [];

  for (const section of SECTIONS) {
    for (const [key, label] of Object.entries(section.fields)) {
      const header = labelCounts.get(label) > 1 ? `${label} (${section.title})` : label;
      columns.push({ key, header });
    }
  }

  return columns;
}

const FIELD_COLUMNS = buildFieldColumns();

/** The full header row: the envelope columns, then the field map in order. */
const HEADERS = [...ENVELOPE_HEADERS, ...FIELD_COLUMNS.map((column) => column.header)];

/**
 * Render one value as a sheet cell.
 *
 * The contract is that this ALWAYS returns a string. A missing, null, or
 * whitespace-only field becomes "", never undefined, never null, and never the
 * string "undefined" -- a literal "undefined" in a spreadsheet column reads as
 * data and is worse than a blank, because nobody can tell it from an answer the
 * partner actually typed.
 *
 * This duplicates the shape of fields.js's private formatValue rather than
 * importing it, because that helper is not exported and fields.js is not being
 * modified. The two agree on what a value looks like; only the treatment of
 * absent values differs, and it has to -- the email skips an empty field, while
 * a fixed-column sheet has to hold its place.
 */
function cell(value) {
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== null && entry !== undefined)
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : "";
  }

  return String(value).trim();
}

/**
 * Build the value row for one submission: the same length as HEADERS, in the
 * same order, with "" wherever the partner left a field blank.
 *
 * Fields the map does not know about are NOT included. That is the one place
 * this module deliberately differs from the email, which prints unmapped keys
 * under "Additional Fields": a sheet has fixed columns, and a row whose width
 * changed per submission would corrupt every column after the first new field.
 * The packet in S3 and the email both still carry those values.
 */
function buildRow({ lead, id, receivedAt }) {
  const source = lead && typeof lead === "object" ? lead : {};

  return [
    cell(id),
    cell(receivedAt),
    ...FIELD_COLUMNS.map((column) => cell(source[column.key])),
  ];
}

/**
 * Append the submission to the sheet. Resolves true when the Apps Script
 * accepted the row, false when it was skipped or failed; never throws.
 *
 * The body is exactly { headers: [...], values: [...] } -- two equal-length
 * arrays. Sending the headers on every request, rather than trusting the sheet
 * to already have them, lets the Apps Script write the header row on a fresh
 * sheet and lets it detect a column-set change instead of appending a row that
 * silently no longer lines up.
 */
export async function appendToSheet({ url, lead, id, receivedAt }) {
  // Rule 1: unset means "not configured", which is a valid state, not a fault.
  if (!url || String(url).trim() === "") return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEETS_TIMEOUT_MS);

  try {
    const response = await fetch(String(url).trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers: HEADERS, values: buildRow({ lead, id, receivedAt }) }),
      // A published Apps Script web app answers /exec with a 302 to a
      // script.googleusercontent.com URL that carries the real response; a
      // client that does not follow it sees the redirect and concludes nothing.
      // Node 20's global fetch (undici) already defaults to "follow", so this is
      // stating the requirement rather than changing behaviour -- it is set
      // explicitly so that the dependency is visible at the call site and
      // survives anyone swapping the fetch implementation later.
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("spartan-partner-onboarding: sheets append failed, submission IS saved", {
        id,
        status: response.status,
        detail: detail.slice(0, 500),
      });
      return false;
    }

    return true;
  } catch (error) {
    // Rule 2: logged, swallowed, request unaffected. The id is in the line so a
    // gap in the sheet can be traced back to the stored packet in CloudWatch.
    console.error("spartan-partner-onboarding: sheets append failed, submission IS saved", {
      id,
      name: error?.name,
      message: error?.message,
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
