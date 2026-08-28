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
  integrationUserId,
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
 *
 * Only 'Claimed' means live. 'Closed' is NOT claimed and never has been — it is
 * handled separately by isClosed, because the two silences are different: a
 * claimed conversation is waiting on a rep, a closed one is over.
 */
function isClaimed(status) {
  return status === STATUS_CLAIMED;
}

/**
 * The conversation is over — the visitor pressed End Chat (or a rep closed it).
 *
 * Terminal, and deliberately so. The bot does not reply, does not resume, and
 * nothing further is written to the record: see resolveLiveMode, which
 * short-circuits on it, and recordVisitorTurn, which refuses to append. The
 * only way back is a rep reopening it in Salesforce.
 *
 * Treating Closed as "not claimed, therefore bot handles it" — which is what
 * this module used to do — meant a visitor who ended the chat got a bot reply
 * to their goodbye and a reopened thread nobody was watching.
 */
function isClosed(status) {
  return status === STATUS_CLOSED;
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
 *
 * Assigned_To__c comes back for the poll path's fallback author filter; it is
 * unused by the sync path and costs nothing to select.
 *
 * @returns {Promise<{id: string, status: string, assignedTo: string|null}|null>}
 *   null when none exists.
 */
async function findConversation(sessionId, auth) {
  const path =
    `/sobjects/${CONVERSATION_OBJECT}/${SESSION_EXTERNAL_ID}/` +
    `${encodeURIComponent(sessionId)}?fields=Id,Status__c,Assigned_To__c`;

  const { status, body } = await sfRequest(auth, path);
  if (status === 404 || !body || !body.Id) return null;

  return {
    id: body.Id,
    status: body.Status__c ?? null,
    assignedTo: body.Assigned_To__c ?? null,
  };
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
 * Called BEFORE Claude, on every turn: who — if anyone — is handling this
 * conversation, and is it still open at all?
 *
 * Three outcomes, and the caller behaves differently for each:
 *
 *   live: true    'Claimed'. A rep owns the thread, so the bot stays silent.
 *                 The visitor's message IS recorded here, because the caller
 *                 returns immediately without reaching the normal sync path.
 *   closed: true  'Closed'. The chat is over. The bot stays silent AND nothing
 *                 is written — see isClosed for why this is terminal. The
 *                 visitor's message is deliberately dropped rather than
 *                 appended to a finished transcript.
 *   neither       'New', or no conversation yet. The bot answers normally.
 *
 * That third case is also the rep-hands-back path: a conversation a rep set
 * from 'Claimed' to 'New' lands here with no special handling, so the bot
 * resumes on the very next turn. It picks the thread up from the transcript the
 * widget sends, and because the conversation already exists the caller appends
 * to it rather than backfilling a second copy.
 *
 * Never throws. A failure here means the bot answers as usual — the safe
 * direction, since the alternative is a silent widget with nobody replying. The
 * one cost of that choice is that a Salesforce outage cannot detect a Closed
 * conversation either; recordVisitorTurn re-checks before it writes, so an
 * outage still cannot append to a closed record.
 *
 * @returns {Promise<{live: boolean, closed: boolean, conversation: object|null,
 *   auth: object|null}>}
 */
async function resolveLiveMode({ sessionId, messages, logger = console, deps = {} }) {
  const result = { live: false, closed: false, conversation: null, auth: null };
  if (!sessionId || !isSalesforceConfigured()) return result;

  try {
    const session = toSession(deps.auth || null, deps);
    const auth = await session.get();
    result.auth = auth;

    const conversation = await (deps.findConversation || findConversation)(sessionId, session);
    if (!conversation) return result;

    result.conversation = conversation;

    // Checked before Claimed: a closed conversation is over regardless of who
    // held it last, and unlike the Claimed branch it takes no write at all.
    if (isClosed(conversation.status)) {
      result.closed = true;
      logger.log("spartan-chatbot: conversation is closed, bot staying silent", {
        sessionId,
        conversationId: conversation.id,
      });
      return result;
    }

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
    return { live: false, closed: false, conversation: null, auth: result.auth };
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
 * the bot, is speaking. Nothing is written for a closed one either, whatever
 * the caller passes — see the isClosed guard below.
 *
 * Never throws.
 *
 * @returns {Promise<{conversationId?: string, written: number, closed?: true}>}
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

    // Never append to a finished conversation. The handler already returns
    // early on a closed conversation, so reaching this with one means the
    // live-mode check could not see Salesforce (an outage, a timeout) and the
    // bot answered on the safe default. This is the second line of defence:
    // ensureConversation re-read the record, so the status here is fresh.
    if (isClosed(conv.status)) {
      logger.log(
        `[conversation] session=${sessionId} conversation=${conv.id} is closed; ` +
        "not writing messages",
      );
      return { conversationId: conv.id, written: 0, closed: true };
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

/**
 * Mark this session's conversation Closed — the widget's End Chat button.
 *
 * Idempotent: a conversation that is already Closed reports success without a
 * write, so a double-tapped button costs one read and nothing else. A 'Claimed'
 * conversation closes too — a visitor ending the chat outranks a rep holding
 * it, and the rep sees the status change in Salesforce.
 *
 * A session with no conversation is NOT an error. The conversation is only
 * created at handoff, so a visitor who never asked for a human has nothing to
 * close; the widget ends the chat on its own side either way.
 *
 * Never throws, like every other orchestrator here. The worst case of a failed
 * close is a conversation left open in Salesforce for a rep to tidy up, which
 * is a great deal better than an error in the visitor's face on their way out.
 *
 * @returns {Promise<{closed: boolean, conversationId?: string,
 *   alreadyClosed?: true, notFound?: true, error?: true}>}
 */
async function closeConversation({ sessionId, logger = console, deps = {} }) {
  if (!sessionId || !isSalesforceConfigured()) return { closed: false };

  try {
    const session = toSession(deps.auth || null, deps);
    const conversation = await (deps.findConversation || findConversation)(sessionId, session);

    if (!conversation) {
      logger.log(`[conversation] close: nothing to close for session=${sessionId}`);
      return { closed: false, notFound: true };
    }

    if (isClosed(conversation.status)) {
      return { closed: true, conversationId: conversation.id, alreadyClosed: true };
    }

    await sfRequest(session, `/sobjects/${CONVERSATION_OBJECT}/${conversation.id}`, {
      method: "PATCH",
      body: { Status__c: STATUS_CLOSED },
    });

    logger.log(
      `[conversation] closed session=${sessionId} conversation=${conversation.id} ` +
      `(was ${conversation.status ?? "unset"})`,
    );
    return { closed: true, conversationId: conversation.id };
  } catch (error) {
    logger.error(
      `[conversation] close failed session=${sessionId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    return { closed: false, error: true };
  }
}

/* ------------------------------------------------------------------ *
 * Poll: the return path, Salesforce -> widget.
 * ------------------------------------------------------------------ */

/**
 * Most recent rep messages returned in one poll.
 *
 * A live conversation is polled every few seconds, so the realistic delta is
 * zero or one message; this cap only bounds the pathological case (a widget
 * reconnecting after a long gap, or a rep pasting a burst). Saturation is
 * logged rather than silently truncated.
 */
const POLL_PAGE_SIZE = 50;

/** Salesforce record id, 15- or 18-character form. */
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/**
 * Interpret the widget's `after` cursor, which crosses the trust boundary and
 * therefore may never reach a SOQL string unvalidated.
 *
 * Both forms the widget may send are accepted:
 *   - an ISO timestamp (what `sentAt` in a poll response carries) -> compared
 *     against Sent_At__c;
 *   - a Message__c id -> everything up to and including it is dropped from the
 *     fetched window, since SOQL cannot order by "after this record" without a
 *     second query for its timestamp, and one query per poll is the budget.
 *
 * Anything unparseable degrades to "no cursor" rather than to an error: a
 * malformed cursor should cost the visitor a duplicate at worst, never the
 * rep's reply.
 */
function parsePollCursor(after) {
  if (typeof after !== "string" || !after.trim()) return {};

  const raw = after.trim();

  const ms = Date.parse(raw);
  if (!Number.isNaN(ms)) return { afterMs: ms };

  if (SF_ID_RE.test(raw)) return { afterId: raw };

  return {};
}

/**
 * SOQL datetime literal. Salesforce wants YYYY-MM-DDThh:mm:ssZ, and older API
 * versions reject the millisecond form, so the literal is floored to the
 * second. Flooring widens the window rather than narrowing it — the exact
 * millisecond comparison is redone in JS below, so the widened SOQL filter
 * costs a row or two of payload and can never skip a message.
 */
function soqlDateTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * When Sent_At__c is missing, fall back to CreatedDate.
 *
 * Rep messages are created by Salesforce, not by this Lambda, so nothing here
 * guarantees their Sent_At__c is stamped. Ordering and cursoring on a null
 * would drop those replies on the floor forever, which is the one outcome this
 * feature cannot have.
 */
function sentAtOf(record) {
  return record?.Sent_At__c || record?.CreatedDate || null;
}

/**
 * Build the WHERE clause that separates rep messages from the bot's own.
 *
 * Both branches filter on authorship — see integrationUserId in salesforce.js
 * for why CreatedById is the discriminator. Every literal interpolated here is
 * either a Salesforce-supplied id or one this module validated, never raw
 * caller input.
 *
 * @returns {{clause: string, basis: string}|null} null when authorship cannot
 *   be established at all, which must suppress the whole poll: returning
 *   unfiltered Outbound would replay the bot's own replies into the widget as
 *   though a rep had just sent them.
 */
function repAuthorFilter(conversation, auth, logger) {
  const botUserId = integrationUserId(auth);
  if (botUserId) {
    return { clause: `CreatedById != '${botUserId}'`, basis: "not-bot" };
  }

  // No identity URL on the token and no override configured. The rep who took
  // the conversation is the next-best author to match on.
  const assignedTo = conversation.assignedTo;
  if (typeof assignedTo === "string" && SF_ID_RE.test(assignedTo)) {
    return { clause: `CreatedById = '${assignedTo}'`, basis: "assigned-rep" };
  }

  logger.error(
    "[conversation] poll cannot identify the integration user and the " +
    "conversation has no Assigned_To__c; suppressing rep messages rather " +
    "than replaying the bot's own replies. Set SF_INTEGRATION_USER_ID.",
  );
  return null;
}

/**
 * Rep replies for a session, for the widget's poll.
 *
 * ONE SOQL per poll, on top of the external-id retrieve that resolves the
 * session to a conversation. Both reuse the cached access token, so a warm
 * container polls without re-authenticating.
 *
 * Only Outbound is returned, and only the Outbound the bot did not write:
 * Inbound is the visitor's own text, and the bot's Outbound already reached the
 * visitor in the chat response that produced it. Direction__c alone cannot make
 * that second cut — bot replies are Outbound too — so authorship makes it.
 *
 * Never throws. A Salesforce failure returns `error: true` with no messages, so
 * the widget simply polls again.
 *
 * @returns {Promise<{messages: Array<{id: string, body: string, sentAt: string|null}>,
 *   live: boolean, closed: boolean, status: string|null, conversationId?: string,
 *   error?: true}>}
 */
async function pollRepMessages({
  sessionId, after = null, limit = POLL_PAGE_SIZE, logger = console, deps = {},
}) {
  const empty = { messages: [], live: false, closed: false, status: null };
  if (!sessionId || !isSalesforceConfigured()) return empty;

  try {
    const session = toSession(deps.auth || null, deps);
    const auth = await session.get();

    const conversation = await (deps.findConversation || findConversation)(sessionId, session);
    // Nothing to poll yet: the conversation is only created at handoff.
    if (!conversation) return empty;

    const base = {
      messages: [],
      live: isClaimed(conversation.status),
      // The widget's other channel onto the same fact: a chat closed in this
      // tab, in another tab, or by a rep shows up on the next tick either way.
      // Messages are still returned for a closed conversation — a rep's last
      // word, sent just before the close, must not be swallowed by it.
      closed: isClosed(conversation.status),
      status: conversation.status ?? null,
      conversationId: conversation.id,
    };

    const author = repAuthorFilter(conversation, auth, logger);
    if (!author) return base;

    const cursor = parsePollCursor(after);

    const where = [
      `Conversation__c = '${conversation.id}'`,
      `Direction__c = '${DIRECTION_OUTBOUND}'`,
      author.clause,
      // `OR Sent_At__c = null` keeps an unstamped rep message in the window;
      // sentAtOf gives it a comparable timestamp and the JS filter below
      // decides it on CreatedDate.
      ...(cursor.afterMs
        ? [`(Sent_At__c >= ${soqlDateTime(cursor.afterMs)} OR Sent_At__c = null)`]
        : []),
    ].join(" AND ");

    // Newest-first with a LIMIT, then reversed below: a widget returning after
    // a long gap gets the most recent window rather than being pinned to the
    // oldest messages of a long conversation. Ascending order is restored for
    // the caller, which is the order the widget renders in.
    const soql =
      `SELECT Id, Body__c, Sent_At__c, CreatedDate FROM ${MESSAGE_OBJECT} ` +
      `WHERE ${where} ORDER BY Sent_At__c DESC NULLS LAST LIMIT ${Number(limit) || POLL_PAGE_SIZE}`;

    const { body } = await sfRequest(
      session, `/query/?q=${encodeURIComponent(soql)}`,
    );

    const records = Array.isArray(body?.records) ? body.records.slice().reverse() : [];

    if (records.length >= (Number(limit) || POLL_PAGE_SIZE)) {
      logger.log("[conversation] poll window saturated; older rep messages may be skipped", {
        sessionId,
        conversationId: conversation.id,
        returned: records.length,
      });
    }

    let messages = records.map((record) => ({
      id: record.Id,
      body: record.Body__c ?? "",
      sentAt: sentAtOf(record),
    }));

    // Exact cursor, at full millisecond precision, applied to the widened
    // window the SOQL returned.
    if (cursor.afterMs) {
      messages = messages.filter((m) => {
        const ms = m.sentAt ? Date.parse(m.sentAt) : NaN;
        // An untimestamped message cannot be ruled out by the cursor, so it is
        // delivered: a duplicate beats a lost rep reply.
        return Number.isNaN(ms) || ms > cursor.afterMs;
      });
    } else if (cursor.afterId) {
      const seen = messages.findIndex((m) => m.id === cursor.afterId);
      // Not in the window: the widget is further behind than the page covers,
      // so hand back what there is rather than nothing.
      if (seen !== -1) messages = messages.slice(seen + 1);
    }

    // Sent_At__c ordering per the contract, with the CreatedDate fallback
    // standing in for a null so an unstamped message still lands in sequence.
    messages.sort((a, b) => {
      const at = a.sentAt ? Date.parse(a.sentAt) : 0;
      const bt = b.sentAt ? Date.parse(b.sentAt) : 0;
      return at - bt;
    });

    if (messages.length) {
      logger.log("[conversation] poll returning rep messages", {
        sessionId,
        conversationId: conversation.id,
        count: messages.length,
        basis: author.basis,
      });
    }

    return { ...base, messages };
  } catch (error) {
    logger.error(
      `[conversation] poll failed session=${sessionId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    // The widget retries on its next tick; an outage must never surface as a
    // 500 to a page that is polling every few seconds.
    return { messages: [], live: false, closed: false, status: null, error: true };
  }
}

export {
  ensureConversation,
  // Low-level seam for whatsappConversation.js, which is a third consumer of
  // the same Connected App, the same objects and the same 401-retry policy.
  sfRequest,
  closeConversation,
  pollRepMessages,
  parsePollCursor,
  POLL_PAGE_SIZE,
  authSession,
  transcriptEntries,
  findConversation,
  writeMessage,
  resolveLiveMode,
  recordVisitorTurn,
  isClaimed,
  isClosed,
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
