/**
 * Conversation + message sync for the spartan-chatbot Lambda, and the live-rep
 * takeover switch that rides on it.
 *
 * Two Salesforce objects, already defined in the org:
 *
 *   Conversation__c  Lead__c, Status__c (New/Claimed/Closed), Assigned_To__c,
 *                    Last_Message_At__c, Unread_Count__c (rollup),
 *                    Session_Id__c (external id, unique)
 *   Message__c       Conversation__c (master-detail), Body__c, Direction__c
 *                    (Inbound/Outbound), Read__c, Sent_At__c
 *
 * This module is a second consumer of the SAME Connected App and integration
 * user as the Lead write, reusing salesforce.js's getSfToken. It adds no new
 * pre-authorization requirement.
 *
 * THE ONE INVARIANT: nothing in here may cost a visitor their reply. Every
 * exported orchestrator swallows its failures and logs them, exactly as
 * maybeCreateLead does for the Lead write. A Salesforce outage degrades this
 * feature to "the bot answers and nothing is recorded", never to a 500.
 */

import {
  getSfToken,
  invalidateSfToken,
  SF_API_VERSION,
  SF_FETCH_TIMEOUT_MS,
} from "./salesforce.js";

const CONVERSATION_OBJECT = "Conversation__c";
const MESSAGE_OBJECT = "Message__c";
const SESSION_EXTERNAL_ID = "Session_Id__c";

const STATUS_NEW = "New";
const STATUS_CLAIMED = "Claimed";
const STATUS_CLOSED = "Closed";

const DIRECTION_INBOUND = "Inbound";
const DIRECTION_OUTBOUND = "Outbound";

/** Body__c is a long text area, but cap defensively rather than trusting it. */
const MAX_BODY_CHARS = 30000;

/**
 * A rep has taken the conversation, so the bot must stay silent for this turn.
 * Closed deliberately reads as "not claimed": a closed conversation falls back
 * to bot handling rather than leaving the visitor talking to nobody.
 */
function isClaimed(status) {
  return status === STATUS_CLAIMED;
}

/** Salesforce is only wired up when both the key and the client id are present. */
function isSalesforceConfigured() {
  return Boolean(process.env.SF_PRIVATE_KEY && process.env.SF_CLIENT_ID);
}

function apiUrl(instanceUrl, path) {
  return `${instanceUrl}/services/data/${SF_API_VERSION}${path}`;
}

/**
 * A token holder that can replace itself once.
 *
 * The cached token in salesforce.js is reused across invocations, which means a
 * token that has been revoked or has genuinely expired can be handed out. That
 * surfaces as a single 401, so every call below gets exactly one chance to drop
 * the cache, re-auth, and try again — enough to self-heal a stale token,
 * bounded so a persistent 401 cannot loop.
 */
function authSession(deps = {}) {
  const getToken = deps.getToken || getSfToken;
  const invalidate = deps.invalidateToken || invalidateSfToken;
  let current = deps.auth || null;

  return {
    async get() {
      if (!current) current = await getToken();
      return current;
    },
    async refresh() {
      invalidate();
      current = await getToken({ force: true });
      return current;
    },
  };
}

/** Accept a session, a plain auth object, or nothing at all. */
function toSession(authOrSession, deps = {}) {
  if (authOrSession && typeof authOrSession.get === "function") return authOrSession;
  if (authOrSession) return authSession({ ...deps, auth: authOrSession });
  return authSession(deps);
}

async function sendRequest(auth, path, method, body) {
  const res = await fetch(apiUrl(auth.instance_url, path), {
    method,
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(SF_FETCH_TIMEOUT_MS),
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      // Non-JSON body; the status alone carries the meaning.
    }
  }
  return { status: res.status, ok: res.ok, body: parsed, text };
}

/**
 * One Salesforce REST call, with the same deadline as every other outbound
 * Salesforce call in this project, retried once on a 401 with a fresh token.
 *
 * The retry is per call rather than per operation on purpose: retrying a whole
 * operation could re-send writes that already succeeded.
 *
 * @returns {Promise<{status: number, body: object|null}>} 404 is returned
 *   rather than thrown, because "no conversation yet" is the normal case.
 */
async function sfRequest(authOrSession, path, { method = "GET", body } = {}) {
  const session = toSession(authOrSession);

  let res = await sendRequest(await session.get(), path, method, body);

  if (res.status === 401) {
    // Stale cached token: drop it, re-auth, and give this call one more go.
    res = await sendRequest(await session.refresh(), path, method, body);
  }

  if (res.status === 404) return { status: 404, body: res.body };

  if (!res.ok) {
    const error = new Error(`${method} ${path} failed (HTTP ${res.status}): ${res.text}`);
    error.sfStatus = res.status;
    throw error;
  }

  return { status: res.status, body: res.body };
}

/**
 * Fetch a Conversation__c by its session external id.
 * @returns {Promise<{id: string, status: string}|null>} null when none exists.
 */
async function findConversation(sessionId, auth) {
  const path =
    `/sobjects/${CONVERSATION_OBJECT}/${SESSION_EXTERNAL_ID}/` +
    `${encodeURIComponent(sessionId)}?fields=Id,Status__c`;

  const { status, body } = await sfRequest(auth, path);
  if (status === 404 || !body || !body.Id) return null;

  return { id: body.Id, status: body.Status__c ?? null };
}

/**
 * Get the conversation for this session, creating it if there isn't one.
 *
 * Deliberately a GET-then-create rather than a blind upsert. A PATCH to the
 * external-id endpoint carrying Status__c would reset an existing
 * conversation's status on every turn — overwriting a rep's 'Claimed' with
 * 'New' and silently breaking the takeover switch this module exists to
 * support. Reading first is what keeps Status__c owned by the rep.
 *
 * The create itself still goes through the external-id PATCH, so the unique
 * external id — not application timing — is what guarantees one conversation
 * per session: two concurrent creates resolve to a create plus an update, never
 * to a duplicate.
 *
 * @returns {Promise<{id: string, status: string, created: boolean}>}
 */
async function ensureConversation(sessionId, leadId, auth) {
  const existing = await findConversation(sessionId, auth);
  if (existing) return { ...existing, created: false };

  const path =
    `/sobjects/${CONVERSATION_OBJECT}/${SESSION_EXTERNAL_ID}/` +
    `${encodeURIComponent(sessionId)}`;

  // Session_Id__c is omitted from the body on purpose: the URL already carries
  // it, and sending both invites a mismatch error for no benefit.
  const { body } = await sfRequest(auth, path, {
    method: "PATCH",
    body: {
      ...(leadId && { Lead__c: leadId }),
      Status__c: STATUS_NEW,
    },
  });

  if (body && body.id) {
    return { id: body.id, status: STATUS_NEW, created: body.created !== false };
  }

  // HTTP 204: the PATCH updated a record that appeared between our read and
  // our write. Re-read to get its id and whatever status it actually holds.
  const found = await findConversation(sessionId, auth);
  if (!found) throw new Error("Conversation upsert returned no id and no record was found");
  return { ...found, created: false };
}

/**
 * Create a Message__c and stamp the parent's Last_Message_At__c.
 *
 * The stamp is a second call and a best-effort one: if it fails the message is
 * already saved, which matters more than the parent's sort field, so the
 * failure is reported to the caller rather than losing the message.
 *
 * @returns {Promise<{id: string, stamped: boolean}>}
 */
async function writeMessage(conversationId, messageBody, direction, auth, deps = {}) {
  const now = deps.now ? deps.now() : new Date().toISOString();

  const { body } = await sfRequest(auth, `/sobjects/${MESSAGE_OBJECT}/`, {
    method: "POST",
    body: {
      Conversation__c: conversationId,
      Body__c: String(messageBody ?? "").slice(0, MAX_BODY_CHARS),
      Direction__c: direction,
      Read__c: false,
      Sent_At__c: now,
    },
  });

  if (!body || !body.id) throw new Error("Message create returned no id");

  let stamped = false;
  try {
    await sfRequest(auth, `/sobjects/${CONVERSATION_OBJECT}/${conversationId}`, {
      method: "PATCH",
      body: { Last_Message_At__c: now },
    });
    stamped = true;
  } catch (_) {
    // Message is saved; the parent stamp is not worth failing over.
  }

  return { id: body.id, stamped };
}

/** The visitor's turns, oldest first. */
function visitorMessages(messages) {
  return (messages ?? []).filter(
    (m) => m?.role === "user" && typeof m.content === "string" && m.content.trim(),
  );
}

/**
 * The whole transcript as ordered message writes: visitor turns Inbound, bot
 * turns Outbound. Used for the backfill on the turn a conversation is created.
 */
function transcriptEntries(messages) {
  return (messages ?? [])
    .filter((m) => typeof m?.content === "string" && m.content.trim())
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      body: m.content,
      direction: m.role === "user" ? DIRECTION_INBOUND : DIRECTION_OUTBOUND,
    }));
}

function lastVisitorMessage(messages) {
  const turns = visitorMessages(messages);
  return turns.length ? turns[turns.length - 1].content : null;
}

/**
 * Called BEFORE Claude, on every turn: is a rep handling this conversation?
 *
 * When the answer is yes the visitor's message is recorded here, because the
 * caller returns immediately afterwards without reaching the normal sync path.
 *
 * Never throws. A failure here means the bot answers as usual — the safe
 * direction, since the alternative is a silent widget with nobody replying.
 *
 * @returns {Promise<{live: boolean, conversation: object|null, auth: object|null}>}
 */
async function resolveLiveMode({ sessionId, messages, logger = console, deps = {} }) {
  const result = { live: false, conversation: null, auth: null };
  if (!sessionId || !isSalesforceConfigured()) return result;

  try {
    const session = toSession(deps.auth || null, deps);
    const auth = await session.get();
    result.auth = auth;

    const conversation = await (deps.findConversation || findConversation)(sessionId, session);
    if (!conversation) return result;

    result.conversation = conversation;
    if (!isClaimed(conversation.status)) return result;

    result.live = true;
    const body = lastVisitorMessage(messages);
    if (body) {
      await (deps.writeMessage || writeMessage)(
        conversation.id, body, DIRECTION_INBOUND, session, deps,
      );
    }
    logger.log("spartan-chatbot: conversation is claimed by a rep, bot staying silent", {
      sessionId,
      conversationId: conversation.id,
    });
    return result;
  } catch (error) {
    logger.error(
      `[conversation] live-mode check failed session=${sessionId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    return { live: false, conversation: null, auth: result.auth };
  }
}

/**
 * Called AFTER Claude: record this turn of the conversation.
 *
 * Both directions are written, so a rep opening a claimed conversation reads
 * the whole back-and-forth rather than the visitor talking into a void: the
 * visitor's message Inbound, the bot's reply Outbound.
 *
 * The conversation is created at the handoff moment, when a leadId first
 * exists. That turn backfills the entire transcript in order — visitor turns
 * Inbound, prior bot turns Outbound — so the record is complete from its first
 * moment. Later turns write just the newest exchange.
 *
 * Nothing is written for a live turn: `botReply` is null there and the rep, not
 * the bot, is speaking.
 *
 * Never throws.
 *
 * @returns {Promise<{conversationId?: string, written: number}>}
 */
async function recordVisitorTurn({
  sessionId, leadId, messages, botReply = null,
  conversation = null, logger = console, deps = {},
}) {
  if (!sessionId || !isSalesforceConfigured()) return { written: 0 };
  // Nothing to attach to and nothing to attach it with.
  if (!conversation && !leadId) return { written: 0 };

  try {
    const session = toSession(deps.auth || null, deps);

    let conv = conversation;
    let created = false;
    if (!conv) {
      const ensured = await (deps.ensureConversation || ensureConversation)(
        sessionId, leadId, session,
      );
      conv = { id: ensured.id, status: ensured.status };
      created = ensured.created;
      logger.log(
        `[conversation] session=${sessionId} conversation=${conv.id}` +
        `${created ? " (created)" : " (existing)"}`,
      );
    }

    // A freshly created conversation gets the whole transcript, in order and in
    // both directions; an existing one already has everything before this turn.
    const pending = created
      ? transcriptEntries(messages)
      : [lastVisitorMessage(messages)]
        .filter(Boolean)
        .map((body) => ({ body, direction: DIRECTION_INBOUND }));

    // This turn's bot reply closes the exchange. Absent on a live turn.
    if (typeof botReply === "string" && botReply.trim()) {
      pending.push({ body: botReply, direction: DIRECTION_OUTBOUND });
    }

    let written = 0;
    for (const entry of pending) {
      try {
        await (deps.writeMessage || writeMessage)(
          conv.id, entry.body, entry.direction, session, deps,
        );
        written++;
      } catch (error) {
        // One bad message must not abandon the rest of the backfill.
        logger.error(
          `[conversation] message write failed session=${sessionId} ` +
          `conversation=${conv.id}: ${error && error.message ? error.message : error}`,
        );
      }
    }

    return { conversationId: conv.id, written };
  } catch (error) {
    logger.error(
      `[conversation] sync failed session=${sessionId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    return { written: 0 };
  }
}

export {
  ensureConversation,
  authSession,
  transcriptEntries,
  findConversation,
  writeMessage,
  resolveLiveMode,
  recordVisitorTurn,
  isClaimed,
  isSalesforceConfigured,
  visitorMessages,
  lastVisitorMessage,
  STATUS_NEW,
  STATUS_CLAIMED,
  STATUS_CLOSED,
  DIRECTION_INBOUND,
  DIRECTION_OUTBOUND,
  MAX_BODY_CHARS,
};
