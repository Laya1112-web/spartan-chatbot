/**
 * spartan-partner-onboarding — AWS Lambda handler for the Spartan Capital Group
 * partner (ISO) onboarding form. Invoked through its own Lambda Function URL
 * (buffered, payload format 2.0); there is no API Gateway in front of it.
 *
 *   OPTIONS /  -> 204 (the Function URL answers real preflights itself)
 *
 *   POST /  { action: "partner_onboarding", lead: { ...~67 flat fields } }
 *        -> 200 { success: true, id }   the packet is in S3
 *        -> 400 { success: false, error } no lead, or no lead.owner_email
 *        -> 500 { success: false, error } the S3 write did not succeed
 *
 *   Anything else -> 405
 *
 * This function is standalone. It shares no code, no Function URL, and no
 * execution role with spartan-chatbot or the Python spartan-lead-handler; it
 * only borrows their conventions (ESM, flat one-concern-per-module layout,
 * prefixed structured logging, full detail to CloudWatch and a safe message to
 * the browser).
 *
 * THE CONTRACT THAT MATTERS
 *
 * `success: true` means, and may only ever mean, that the submission is durably
 * in S3. The sheet row, the email, and the SharePoint relay are best-effort
 * deliveries layered on top of that object and CANNOT influence the status code
 * -- see sheets.js, notify.js and sharepoint.js. The sheet in particular is a
 * convenience copy for whoever works the packets; S3 is the record.
 *
 * A partner who completes a 67-field packet and is told it was received, when
 * it was not stored anywhere, is the failure this whole function exists to
 * eliminate. Any future change that lets a non-S3 failure
 * produce a 500, or an S3 failure produce a 200, breaks the one promise this
 * code makes.
 *
 * Everything the form sends is optional except owner_email. The validation
 * below is deliberately thin for the same reason: a packet that is 60% complete
 * is worth storing and reviewing, and rejecting it would send the partner away
 * with nothing.
 *
 * The one thing that IS filtered is REMOVED_FIELDS: the retired Background
 * questions are dropped at ingest, before the write, so they are never stored
 * even if a stale page still sends them. See the constant for why that gate
 * lives here rather than being left to the form.
 *
 * Runtime: nodejs20.x   Region: us-east-1 (bucket is us-east-2 -- see storage.js)
 */

import { randomBytes } from "node:crypto";

import { storeSubmission } from "./storage.js";
import { appendToSheet } from "./sheets.js";
import { sendNotification } from "./notify.js";
import { relayToSharePoint } from "./sharepoint.js";

/** The action this endpoint exists to serve. */
const ONBOARDING_ACTION = "partner_onboarding";

/**
 * Fields the business stopped collecting.
 *
 * The Background section -- bankruptcies, liens, judgements, criminal history,
 * and the RBF notes -- was removed from the partner onboarding form on
 * 2026-09-15 at the business's request. These keys are stripped from every
 * submission at ingest, before anything is stored or emailed.
 *
 * The strip is a deliberate GATE, not a tidy-up. fields.js already has no label
 * for these keys, but it prints unrecognized keys under "Additional Fields" by
 * design -- so without this list, a stale cached copy of the old page, or
 * someone re-adding the questions to the form, would quietly resume storing
 * answers the business decided to stop holding. Removing them from the form is
 * not sufficient; they also have to be removed HERE. That is the point of
 * keeping the list in code rather than trusting the form to stop sending them.
 *
 * Deleting an entry from this list re-enables storage of that field. Do that
 * only on the same authority that removed it.
 */
const REMOVED_FIELDS = [
  "bg_bankruptcy",
  "bg_bankruptcy_detail",
  "bg_liens",
  "bg_liens_detail",
  "bg_judgements",
  "bg_judgements_detail",
  "bg_criminal",
  "bg_criminal_detail",
  "rbf_notes",
];

/** Shown to the browser when the S3 write fails. No internals leak. */
const GENERIC_ERROR = "Sorry — we could not save your submission. Please try again in a moment.";

/**
 * The only headers this handler sets.
 *
 * THIS FUNCTION DOES NOT EMIT CORS HEADERS. The Function URL's own CORS
 * configuration owns them -- it sets Access-Control-Allow-Origin, -Methods,
 * -Headers, -Max-Age and Vary on every response, and answers preflight without
 * invoking this code at all.
 *
 * This handler used to set them too, from an ALLOWED_ORIGIN env var. Because
 * both layers were emitting, responses carried Access-Control-Allow-Origin and
 * Vary TWICE, and a browser rejects a response with more than one
 * Access-Control-Allow-Origin value -- so every submission failed in the
 * browser while curl saw a clean 200. One owner, not two: re-adding CORS here
 * re-creates that bug, and it is invisible to anything but a real browser.
 *
 * ALLOWED_ORIGIN is consequently unread by this code. The allowed origin now
 * lives only in the Function URL config.
 */
const RESPONSE_HEADERS = { "Content-Type": "application/json" };

export const handler = async (event) => {
  const headers = RESPONSE_HEADERS;
  const method = event?.requestContext?.http?.method ?? "POST";

  // Kept for a non-browser caller that sends OPTIONS, and so a direct
  // invocation of this handler still behaves. UNREACHABLE from a browser: the
  // Function URL answers preflight itself and never invokes the function.
  if (method === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (method !== "POST") {
    return json(405, headers, { success: false, error: "Method not allowed. Use POST." });
  }

  const id = generateId();

  try {
    const body = parseBody(event);

    // The action is logged but NOT enforced. This URL serves exactly one thing,
    // and refusing a packet over a mislabelled envelope would throw away a
    // completed form to make a point about a string.
    if (body.action && body.action !== ONBOARDING_ACTION) {
      console.warn("spartan-partner-onboarding: unexpected action, processing anyway", {
        id,
        action: String(body.action).slice(0, 64),
      });
    }

    const submitted = body.lead;

    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
      return json(400, headers, { success: false, error: "`lead` is required." });
    }

    // The single required field. Everything else on the form is optional and is
    // stored as submitted, however sparse.
    if (!present(submitted.owner_email)) {
      return json(400, headers, { success: false, error: "`lead.owner_email` is required." });
    }

    // Validated, so now drop the retired Background fields -- before the S3
    // write, so they are never stored, and before the notification, which reads
    // the same object. A stale page sending them is logged, not rejected: the
    // rest of the packet is still worth keeping.
    const lead = stripRemovedFields(submitted, id);

    const receivedAt = new Date().toISOString();
    const sourceIp = event?.requestContext?.http?.sourceIp ?? null;
    const bucket = process.env.SUBMISSIONS_BUCKET;

    if (!bucket) {
      // Misconfiguration, not a client error. Nothing can be stored, so this
      // must not return success.
      console.error("spartan-partner-onboarding: SUBMISSIONS_BUCKET is unset, cannot store submission", { id });
      return json(500, headers, { success: false, error: GENERIC_ERROR });
    }

    // Step 1, and the only step that can fail the request. Throws on failure;
    // caught below and turned into a 500.
    const { key } = await storeSubmission({ bucket, lead, id, receivedAt, sourceIp });

    console.log("spartan-partner-onboarding: submission stored", {
      id,
      bucket,
      key,
      fieldCount: Object.keys(lead).length,
    });

    // Steps 2, 3 and 4 are best-effort. Each swallows its own errors; none can
    // change what this handler returns, and each is reached only because the S3
    // write above already succeeded.
    //
    // They run in sequence, sheet -> email -> SharePoint, rather than in
    // parallel. The order is the one the business asked for, and it is the
    // useful one: the sheet is what the team actually works from, so it is
    // populated before the email that tells a reviewer to go look at it.
    // Each module is individually time-bounded (sheets.js 10s, sharepoint.js
    // 5s), so the worst case here is bounded too -- keep the Lambda timeout
    // comfortably above their sum.
    const appended = await appendToSheet({
      url: process.env.SHEETS_WEBHOOK_URL,
      lead,
      id,
      receivedAt,
    });

    const notified = await sendNotification({
      lead,
      id,
      receivedAt,
      sourceIp,
      bucket,
      key,
      from: process.env.SES_FROM,
      to: process.env.NOTIFY_TO,
    });

    const relayed = await relayToSharePoint({ url: process.env.SHAREPOINT_FLOW_URL, lead, id });

    console.log("spartan-partner-onboarding: submission complete", {
      id,
      key,
      appended,
      notified,
      relayed,
    });

    return json(200, headers, { success: true, id });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json(400, headers, { success: false, error: error.message });
    }

    // Reached when the S3 write threw. Full error to CloudWatch; only a safe
    // message to the browser. The 500 is the point: the submitter must know the
    // packet did not land so they can send it again.
    console.error("spartan-partner-onboarding: submission NOT stored", {
      id,
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    });

    return json(500, headers, { success: false, error: GENERIC_ERROR });
  }
};

/**
 * po_<ISO timestamp>_<8 hex chars>, e.g. po_20260915T142231Z_9f3a1c74.
 *
 * The timestamp is ISO 8601 BASIC format -- the extended form's colons and
 * dot are stripped. That is a deliberate, visible deviation: this id becomes an
 * S3 object key and gets pasted into console URLs and emails, and while a colon
 * is legal in a key it percent-encodes and breaks naive link building. Basic
 * format keeps the id sortable, unambiguous, and safe everywhere it travels.
 *
 * 4 random bytes is 4.3 billion values per second-bucket -- collisions are not
 * a practical concern at a handful of onboarding packets a day, and the
 * timestamp prefix keeps keys naturally ordered.
 */
function generateId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `po_${stamp}_${randomBytes(4).toString("hex")}`;
}

function parseBody(event) {
  const raw = event?.body;
  if (!raw) throw new BadRequestError("Request body is required.");

  const text = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequestError("Request body must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequestError("Request body must be a JSON object.");
  }

  return parsed;
}

/**
 * Return a copy of the submission with every REMOVED_FIELDS key dropped.
 *
 * Copies rather than mutating: the parsed body stays intact for anything that
 * inspects it later, and the object handed to storage and notify is provably
 * the filtered one. A key present but empty still counts as stripped -- the
 * form sent it, which is the signal worth logging.
 *
 * Warns once per submission, listing the keys, so a stale page still live
 * somewhere is visible in CloudWatch instead of silently re-submitting retired
 * questions. Never throws and never fails the request.
 */
function stripRemovedFields(lead, id) {
  const stripped = REMOVED_FIELDS.filter((key) => Object.hasOwn(lead, key));

  if (stripped.length === 0) return lead;

  const kept = {};
  for (const [key, value] of Object.entries(lead)) {
    if (!stripped.includes(key)) kept[key] = value;
  }

  console.warn("spartan-partner-onboarding: stripped removed fields", { id, fields: stripped });

  return kept;
}

/** Treat null/undefined/'' (and whitespace-only) as absent. */
function present(value) {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== "";
}

class BadRequestError extends Error {}

function json(statusCode, headers, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

// Exported for tests only; the Lambda entry point is `handler`.
export { generateId, parseBody };
