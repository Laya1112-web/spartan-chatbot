/**
 * spartan-partner-onboarding — AWS Lambda handler for the Spartan Capital Group
 * partner (ISO) onboarding form. Invoked through its own Lambda Function URL
 * (buffered, payload format 2.0); there is no API Gateway in front of it.
 *
 *   OPTIONS /  CORS preflight -> 204
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
 * in S3. The email and the SharePoint relay are best-effort deliveries layered
 * on top of that object and CANNOT influence the status code -- see notify.js
 * and sharepoint.js. A partner who completes a 67-field packet and is told it
 * was received, when it was not stored anywhere, is the failure this whole
 * function exists to eliminate. Any future change that lets a non-S3 failure
 * produce a 500, or an S3 failure produce a 200, breaks the one promise this
 * code makes.
 *
 * Everything the form sends is optional except owner_email. The validation
 * below is deliberately thin for the same reason: a packet that is 60% complete
 * is worth storing and reviewing, and rejecting it would send the partner away
 * with nothing.
 *
 * Runtime: nodejs20.x   Region: us-east-1 (bucket is us-east-2 -- see storage.js)
 */

import { randomBytes } from "node:crypto";

import { storeSubmission } from "./storage.js";
import { sendNotification } from "./notify.js";
import { relayToSharePoint } from "./sharepoint.js";

/** The action this endpoint exists to serve. */
const ONBOARDING_ACTION = "partner_onboarding";

/** Shown to the browser when the S3 write fails. No internals leak. */
const GENERIC_ERROR = "Sorry — we could not save your submission. Please try again in a moment.";

export const handler = async (event) => {
  const origin = getHeader(event, "origin");
  const headers = corsHeaders(origin);
  const method = event?.requestContext?.http?.method ?? "POST";

  // CORS preflight.
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

    const lead = body.lead;

    if (!lead || typeof lead !== "object" || Array.isArray(lead)) {
      return json(400, headers, { success: false, error: "`lead` is required." });
    }

    // The single required field. Everything else on the form is optional and is
    // stored as submitted, however sparse.
    if (!present(lead.owner_email)) {
      return json(400, headers, { success: false, error: "`lead.owner_email` is required." });
    }

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

    // Step 2 and 3 are best-effort. Both swallow their own errors; neither can
    // change what this handler returns. They run in parallel because they are
    // independent and the submitter is waiting.
    const [notified, relayed] = await Promise.all([
      sendNotification({
        lead,
        id,
        receivedAt,
        sourceIp,
        bucket,
        key,
        from: process.env.SES_FROM,
        to: process.env.NOTIFY_TO,
      }),
      relayToSharePoint({ url: process.env.SHAREPOINT_FLOW_URL, lead, id }),
    ]);

    console.log("spartan-partner-onboarding: submission complete", { id, key, notified, relayed });

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

/**
 * CORS. The allowed origin comes from ALLOWED_ORIGIN (comma-separated for more
 * than one) -- nothing is hardcoded here, unlike spartan-chatbot, whose origin
 * set is baked in.
 *
 * When ALLOWED_ORIGIN is unset no Access-Control-Allow-Origin is emitted and
 * browsers will block the form. That is the safe default for an endpoint that
 * accepts PII, but it is also a silent-looking failure, so it is logged.
 */
function corsHeaders(origin) {
  const headers = {
    "Content-Type": "application/json",
    // Response varies per Origin — keep caches from serving one site's CORS
    // headers to another.
    Vary: "Origin",
  };

  const allowed = process.env.ALLOWED_ORIGIN;

  if (!allowed) {
    console.warn("spartan-partner-onboarding: ALLOWED_ORIGIN is unset, browser requests will be blocked");
    return headers;
  }

  const permitted = new Set(
    String(allowed)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (origin && (permitted.has(origin) || permitted.has("*"))) {
    headers["Access-Control-Allow-Origin"] = permitted.has("*") ? "*" : origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }

  return headers;
}

function getHeader(event, name) {
  const headers = event?.headers ?? {};
  // Function URLs lower-case header keys, but don't depend on it.
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
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
export { generateId, corsHeaders, parseBody };
