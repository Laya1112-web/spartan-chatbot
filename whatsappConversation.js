/**
 * whatsappConversation.js — Conversation__c and Message__c for the WhatsApp
 * transport.
 *
 * The web path keys a conversation on Session_Id__c, a per-visit id the browser
 * mints. WhatsApp has no sessions: there is one thread per phone number, for
 * ever. So this module keys on Whatsapp_Wa_Id__c instead, and everything that
 * follows from that difference lives here:
 *
 *   - Channel__c is set to 'WhatsApp' EXPLICITLY on create. The field defaults
 *     to 'Web', and a WhatsApp thread that inherits the default shows up in the
 *     web rep panel as though somebody were sitting on the website waiting.
 *     That is the one field in this file that must never be dropped.
 *   - A Closed conversation REOPENS on the next inbound rather than staying
 *     terminal. On the web, Closed means the visitor pressed End Chat and the
 *     tab is gone; on WhatsApp the same person messaging again next week is the
 *     same thread, and refusing to answer would look like a broken number.
 *   - Last_Inbound_At__c is stamped on every inbound. It is what the 24-hour
 *     free-form window is measured from, so the rep panel needs it to know
 *     whether a rep can still reply (see the README's limitations).
 *
 * Everything else is reused rather than reimplemented: writeMessage, the auth
 * session, the 401-retry, the status vocabulary and the Message__c shape all
 * come from conversation.js. This module adds a second way in, not a second
 * implementation.
 *
 * THE INVARIANT IS THE SAME ONE: nothing in here may cost a visitor their
 * reply. Every exported orchestrator swallows its failures and logs them.
 */

import {
  sfRequest,
  authSession,
  writeMessage,
  isClaimed,
  isClosed,
  isSalesforceConfigured,
  STATUS_NEW,
  DIRECTION_INBOUND,
  DIRECTION_OUTBOUND,
} from "./conversation.js";
import { MAX_MESSAGES, MAX_CONTENT_CHARS } from "./botBrain.js";

const CONVERSATION_OBJECT = "Conversation__c";
const MESSAGE_OBJECT = "Message__c";

/** The external id that makes one WhatsApp number one conversation, for ever. */
const WA_EXTERNAL_ID = "Whatsapp_Wa_Id__c";

const CHANNEL_WHATSAPP = "WhatsApp";

/**
 * Fields this module writes that are NOT load-bearing.
 *
 * Split out because an org whose field is spelled differently — or missing
 * entirely — returns HTTP 400 INVALID_FIELD and takes the whole write down
 * with it. The required set below is the set the feature cannot work without;
 * everything here is nice-to-have, so a write that fails is retried once with
 * only the required fields and the org problem is logged rather than costing
 * the visitor their reply.
 *
 * NOTHING HERE IS A NAME. Conversation__c has no visitor-name field: the
 * visitor's name belongs to the Lead, which is where the bot collects it and
 * where leadHandoff.js writes it. The WhatsApp profile name that arrives on
 * every inbound is deliberately not mirrored onto the conversation.
 */
const OPTIONAL_FIELDS = new Set(["Whatsapp_Phone__c", "Last_Inbound_At__c"]);

/** Salesforce record id, 15- or 18-character form. */
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/**
 * Transcript turns fetched from Salesforce to rebuild the thread for Claude.
 *
 * The web widget posts the whole transcript on every turn; WhatsApp posts one
 * message, so the history has to be re-read. MAX_MESSAGES is the same cap the
 * web path applies to what the widget sends, so both transports hand the model
 * a comparably sized thread.
 */
const TRANSCRIPT_LIMIT = MAX_MESSAGES;

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * Fetch a Conversation__c by the visitor's wa_id.
 *
 * Lead__c comes back because it is the DURABLE once-per-thread lead guard —
 * better than anything the web path has, which depends on the browser echoing
 * a context back. If this conversation already points at a Lead, no second one
 * is created however many later turns look like a handoff.
 *
 * @returns {Promise<{id, status, assignedTo, leadId, name, channel}|null>}
 */
async function findWhatsAppConversation(waId, auth) {
  const path =
    `/sobjects/${CONVERSATION_OBJECT}/${WA_EXTERNAL_ID}/${encodeURIComponent(waId)}` +
    `?fields=Id,Status__c,Assigned_To__c,Lead__c,Channel__c`;

  const { status, body } = await sfRequest(auth, path);
  if (status === 404 || !body || !body.Id) return null;

  return {
    id: body.Id,
    status: body.Status__c ?? null,
    assignedTo: body.Assigned_To__c ?? null,
    leadId: body.Lead__c ?? null,
    channel: body.Channel__c ?? null,
  };
}

/**
 * The thread so far, oldest first, in the shape the Messages API wants.
 *
 * Inbound becomes a user turn, Outbound an assistant turn — which means a rep's
 * replies, written Outbound by the rep in Salesforce, come back as assistant
 * turns too. That is correct and deliberate: when a rep hands the thread back,
 * the bot resumes knowing what the rep already said instead of asking the
 * visitor to repeat it.
 *
 * Newest-first with a LIMIT and then reversed, so a very long thread hands the
 * model its most recent window rather than its oldest.
 *
 * Never throws: a failed read degrades to "no history", and the bot answers the
 * current message alone. Worse than a full transcript, far better than silence.
 *
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
async function fetchTranscript({ conversationId, auth, limit = TRANSCRIPT_LIMIT, logger = console }) {
  // Shape-checked because it is interpolated into SOQL below. Every id this is
  // called with comes from Salesforce itself, so a failure here is a bug rather
  // than bad input — hence the log: silently answering with no history would
  // look like a first-time visitor and be very hard to spot.
  if (!SF_ID_RE.test(String(conversationId ?? ""))) {
    logger.error(`[whatsapp] refusing to read a transcript for a malformed id: ${conversationId}`);
    return [];
  }

  try {
    const soql =
      `SELECT Id, Body__c, Direction__c, Sent_At__c, CreatedDate FROM ${MESSAGE_OBJECT} ` +
      `WHERE Conversation__c = '${conversationId}' ` +
      `ORDER BY Sent_At__c DESC NULLS LAST LIMIT ${Number(limit) || TRANSCRIPT_LIMIT}`;

    const { body } = await sfRequest(auth, `/query/?q=${encodeURIComponent(soql)}`);
    const records = Array.isArray(body?.records) ? body.records.slice().reverse() : [];

    const turns = [];
    for (const record of records) {
      const content = typeof record?.Body__c === "string" ? record.Body__c.trim() : "";
      if (!content) continue;
      const role = record.Direction__c === DIRECTION_OUTBOUND ? "assistant" : "user";
      turns.push({ role, content: content.slice(0, MAX_CONTENT_CHARS) });
    }

    // The Messages API requires the first turn to be from the user, so drop any
    // leading assistant turns — which is what a thread whose window opens just
    // after a bot reply looks like.
    const firstUser = turns.findIndex((t) => t.role === "user");
    return firstUser === -1 ? [] : turns.slice(firstUser);
  } catch (error) {
    logger.error(
      `[whatsapp] transcript read failed conversation=${conversationId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * PATCH a conversation, dropping the org-dependent fields if Salesforce
 * rejects them.
 *
 * One retry, required fields only. An org missing Whatsapp_Phone__c must cost
 * us that column, never the conversation.
 */
async function writeConversation(path, fields, auth, logger) {
  const required = {};
  const optional = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    (OPTIONAL_FIELDS.has(key) ? optional : required)[key] = value;
  }

  try {
    return await sfRequest(auth, path, { method: "PATCH", body: { ...required, ...optional } });
  } catch (error) {
    if (!Object.keys(optional).length) throw error;
    logger.error(
      `[whatsapp] conversation write rejected with optional fields ` +
      `(${Object.keys(optional).join(", ")}); retrying without them. ` +
      `Check those field names in the org: ${error && error.message ? error.message : error}`,
    );
    return await sfRequest(auth, path, { method: "PATCH", body: required });
  }
}

/**
 * The conversation for this wa_id: found, reopened, or created.
 *
 * A GET-then-write, for the same reason ensureConversation does it on the web
 * path: a blind upsert carrying Status__c would overwrite a rep's 'Claimed'
 * with 'New' on every inbound and silently break the takeover switch. Reading
 * first is what keeps Status__c owned by the rep.
 *
 * The create goes through the external-id PATCH, so the unique
 * Whatsapp_Wa_Id__c — not application timing — is what guarantees one
 * conversation per number: two concurrent creates resolve to a create plus an
 * update, never to a duplicate.
 *
 * Session_Id__c is set to `wa:<wa_id>` on create. Nothing in this transport
 * needs it, but it is a unique external id on the object and giving the record
 * one keeps it addressable by the machinery the web path already has.
 *
 * @returns {Promise<{id, status, created, reopened, leadId}>}
 */
async function ensureWhatsAppConversation({
  waId, leadId = null, auth, logger = console,
}) {
  const existing = await findWhatsAppConversation(waId, auth);

  if (existing) {
    let status = existing.status;
    let reopened = false;

    // WhatsApp is one continuous thread per number, so a new inbound revives a
    // finished one. Only Closed is reopened: 'Claimed' belongs to a rep and
    // 'New' is already the bot's.
    if (isClosed(status)) {
      await sfRequest(auth, `/sobjects/${CONVERSATION_OBJECT}/${existing.id}`, {
        method: "PATCH",
        body: { Status__c: STATUS_NEW },
      });
      status = STATUS_NEW;
      reopened = true;
      logger.log(
        `[whatsapp] reopened closed conversation wa=${waId} conversation=${existing.id}`,
      );
    }

    return { ...existing, status, created: false, reopened };
  }

  const path =
    `/sobjects/${CONVERSATION_OBJECT}/${WA_EXTERNAL_ID}/${encodeURIComponent(waId)}`;

  const { body } = await writeConversation(
    path,
    {
      // Whatsapp_Wa_Id__c is omitted: the URL already carries it, and sending
      // both invites a mismatch error for no benefit.
      Channel__c: CHANNEL_WHATSAPP,
      Status__c: STATUS_NEW,
      Session_Id__c: `wa:${waId}`,
      ...(leadId && { Lead__c: leadId }),
      Whatsapp_Phone__c: `+${String(waId).replace(/\D/g, "")}`,
    },
    auth,
    logger,
  );

  if (body && body.id) {
    logger.log(
      `[whatsapp] created conversation wa=${waId} conversation=${body.id} ` +
      `channel=${CHANNEL_WHATSAPP}`,
    );
    return {
      id: body.id,
      status: STATUS_NEW,
      created: body.created !== false,
      reopened: false,
      leadId: leadId ?? null,
    };
  }

  // HTTP 204: the PATCH updated a record that appeared between our read and our
  // write. Re-read for its id and whatever status it actually holds.
  const found = await findWhatsAppConversation(waId, auth);
  if (!found) throw new Error("WhatsApp conversation upsert returned no id and no record was found");
  return { ...found, created: false, reopened: false };
}

/**
 * Stamp Last_Inbound_At__c — the 24-hour free-form window's clock.
 *
 * Best-effort and separate from the message write: the visitor's message being
 * saved matters more than the parent's timestamps, so a failure here is logged
 * and dropped rather than propagated. Same trade writeMessage already makes for
 * Last_Message_At__c.
 */
async function stampInbound({ conversationId, at, auth, logger = console }) {
  try {
    await writeConversation(
      `/sobjects/${CONVERSATION_OBJECT}/${conversationId}`,
      { Last_Inbound_At__c: at },
      auth,
      logger,
    );
    return true;
  } catch (error) {
    logger.error(
      `[whatsapp] Last_Inbound_At__c stamp failed conversation=${conversationId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    return false;
  }
}

/**
 * Point the conversation at the Lead that was just created.
 *
 * This is what makes the once-per-thread lead guard durable: the next inbound
 * reads Lead__c back off the conversation and knows not to create another,
 * whether or not this container is still warm.
 */
async function attachLead({ conversationId, leadId, auth, logger = console }) {
  try {
    await sfRequest(auth, `/sobjects/${CONVERSATION_OBJECT}/${conversationId}`, {
      method: "PATCH",
      body: { Lead__c: leadId },
    });
    logger.log(`[whatsapp] linked conversation=${conversationId} lead=${leadId}`);
    return true;
  } catch (error) {
    logger.error(
      `[whatsapp] lead link failed conversation=${conversationId} lead=${leadId}: ` +
      `${error && error.message ? error.message : error}`,
    );
    return false;
  }
}

/**
 * Write one message against a WhatsApp conversation.
 *
 * A thin pass-through to conversation.js's writeMessage so both transports
 * produce identically shaped Message__c rows — the rep panel, the poll and the
 * transcript read all depend on that being true.
 */
async function recordWhatsAppMessage({
  conversationId, body, direction, auth, logger = console, deps = {},
}) {
  try {
    return await (deps.writeMessage || writeMessage)(
      conversationId, body, direction, auth, deps,
    );
  } catch (error) {
    logger.error(
      `[whatsapp] message write failed conversation=${conversationId} ` +
      `direction=${direction}: ${error && error.message ? error.message : error}`,
    );
    return null;
  }
}

export {
  findWhatsAppConversation,
  ensureWhatsAppConversation,
  fetchTranscript,
  stampInbound,
  attachLead,
  recordWhatsAppMessage,
  authSession,
  isClaimed,
  isClosed,
  isSalesforceConfigured,
  DIRECTION_INBOUND,
  DIRECTION_OUTBOUND,
  CHANNEL_WHATSAPP,
  WA_EXTERNAL_ID,
  TRANSCRIPT_LIMIT,
  OPTIONAL_FIELDS,
};
