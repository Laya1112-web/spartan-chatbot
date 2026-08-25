/**
 * spartan-chatbot — AWS Lambda handler for the Spartan Capital Group website
 * chat widget. Invoked through a Lambda Function URL (buffered, payload
 * format 2.0); there is no API Gateway in front of it.
 *
 *   POST /  { messages: [{role, content}, ...], sessionId? }
 *        -> { reply, handoff, handoffFields, sessionId }
 *
 * Runtime: nodejs20.x   Region: us-east-1
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { shouldHandoff, extractHandoffFields } from "./intent.js";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 1024;

// Origins allowed to call the Function URL from a browser.
const ALLOWED_ORIGINS = new Set([
  "https://www.spartancapital.us",
  "https://spartancapital.us",
  "http://localhost:3000", // local testing only
]);

// Request limits. The widget sends the whole transcript every turn, so cap it
// rather than forwarding an unbounded payload to the API.
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 4000;

const GENERIC_ERROR = "Sorry — something went wrong on our end. Please try again in a moment.";
const EMPTY_REPLY_FALLBACK =
  "Sorry, I wasn't able to answer that. Would you like me to have a funding specialist reach out?";

/** Thrown for anything the caller can fix; surfaces as a 400. */
class BadRequestError extends Error {}

let anthropic;

function getClient() {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Configuration failure, not a caller failure — 500, logged below.
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    anthropic = new Anthropic({
      apiKey,
      timeout: 25_000, // keep under the Lambda timeout (30s)
      maxRetries: 1,
    });
  }
  return anthropic;
}

export const handler = async (event) => {
  const origin = getHeader(event, "origin");
  const headers = corsHeaders(origin);
  const method = event?.requestContext?.http?.method ?? "POST";

  // CORS preflight.
  if (method === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (method !== "POST") {
    return json(405, headers, { error: "Method not allowed. Use POST." });
  }

  let sessionId;

  try {
    const body = parseBody(event);
    sessionId = normalizeSessionId(body.sessionId);
    const messages = normalizeMessages(body.messages);

    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Thinking tokens would eat into the 1024-token budget and add latency
      // to a live chat widget; a website Q&A turn doesn't need it.
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages, // full conversation history, every turn (the API is stateless)
    });

    if (response.stop_reason === "refusal") {
      console.warn("spartan-chatbot: model declined the request", {
        sessionId,
        stopDetails: response.stop_details,
      });
    }

    // The model tags each reply OK/DECLINE (see systemPrompt.js). Strip the
    // tag before it can reach a visitor, and use it to gate the handoff.
    const { text, declined } = parseStatusTag(extractText(response));
    const reply = text || EMPTY_REPLY_FALLBACK;

    const handoff = shouldHandoff({ messages, reply, modelDeclined: declined });
    const handoffFields = handoff ? extractHandoffFields(messages) : {};

    // NOTE: handoff is only flagged here. Delivering it (Salesforce/CRM) is
    // intentionally not part of this function.
    if (handoff) {
      console.log("spartan-chatbot: handoff requested", {
        sessionId,
        fields: Object.keys(handoffFields),
      });
    } else if (declined) {
      console.log("spartan-chatbot: reply declined the business, handoff suppressed", {
        sessionId,
      });
    }

    return json(200, headers, { reply, handoff, handoffFields, sessionId });
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json(400, headers, { error: error.message, sessionId });
    }

    // Full error to CloudWatch; only a safe message to the browser.
    console.error("spartan-chatbot: unhandled error", {
      sessionId,
      name: error?.name,
      status: error?.status,
      message: error?.message,
      requestId: error?.request_id,
      stack: error?.stack,
    });

    return json(500, headers, { error: GENERIC_ERROR, sessionId });
  }
};

function corsHeaders(origin) {
  const headers = {
    "Content-Type": "application/json",
    // Response varies per Origin — keep caches from serving one site's
    // CORS headers to another.
    Vary: "Origin",
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
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

  const text = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw;

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

function normalizeSessionId(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim().slice(0, 128);
  }
  return randomUUID();
}

/**
 * Validate and clean the transcript into the exact shape the Messages API
 * wants: alternating-or-not user/assistant turns, first turn from the user,
 * last turn from the user (a trailing assistant turn would be a prefill,
 * which current models reject).
 */
function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError("`messages` must be a non-empty array.");
  }

  const cleaned = value.map((message, index) => {
    if (!message || typeof message !== "object") {
      throw new BadRequestError(`messages[${index}] must be an object.`);
    }
    const { role, content } = message;
    if (role !== "user" && role !== "assistant") {
      throw new BadRequestError(
        `messages[${index}].role must be "user" or "assistant".`,
      );
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new BadRequestError(
        `messages[${index}].content must be a non-empty string.`,
      );
    }
    return { role, content: content.trim().slice(0, MAX_CONTENT_CHARS) };
  });

  // Keep the most recent turns if the transcript is long.
  let trimmed = cleaned.slice(-MAX_MESSAGES);

  // Drop any leading assistant turns — the first message must be from the user.
  const firstUser = trimmed.findIndex((m) => m.role === "user");
  if (firstUser === -1) {
    throw new BadRequestError("`messages` must contain at least one user message.");
  }
  trimmed = trimmed.slice(firstUser);

  if (trimmed[trimmed.length - 1].role !== "user") {
    throw new BadRequestError("The last message in `messages` must be from the user.");
  }

  return trimmed;
}

function extractText(response) {
  return (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Pull the model's status tag off the reply. Tolerant of malformed variants
 * (missing brackets, stray spacing, lower case) because the tag must never
 * survive into text a visitor reads, even when the model formats it badly.
 */
const STATUS_TAG_RE = /\[{0,2}\s*SCG[_\s-]?STATUS\s*:?\s*([A-Za-z]*)\s*\]{0,2}/gi;

function parseStatusTag(text) {
  let declined = false;
  const stripped = text
    .replace(STATUS_TAG_RE, (_match, verdict) => {
      if (/^decl/i.test(verdict)) declined = true;
      return "";
    })
    .trim();
  return { text: stripped, declined };
}

function json(statusCode, headers, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}
