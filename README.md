# spartan-chatbot

AWS Lambda function powering the chat widget on the Spartan Capital Group website. It takes a
conversation transcript, calls the Anthropic Messages API, and returns the assistant's reply plus a
flag for whether the visitor wants to be handed to a human funding specialist.

- **Runtime:** `nodejs20.x` (ESM)
- **Region:** `us-east-1`
- **Invocation:** Lambda Function URL (buffered, payload format 2.0) — no API Gateway
- **Model:** `claude-sonnet-5`, `max_tokens` 1024

The bot is also reachable over **WhatsApp** (Cloud API) at `/whatsapp` on the same Function URL —
same system prompt, same handoff rules, same Salesforce objects, different transport. See
[WhatsApp (Cloud API)](#whatsapp-cloud-api).

On a handoff the function writes a `Lead` and mirrors the conversation into `Conversation__c` /
`Message__c`, which is also what makes the live-rep takeover possible.

## Files

| File              | Purpose |
| ----------------- | ------- |
| `index.js`        | Lambda handler: CORS, request validation, Anthropic call, response shaping |
| `systemPrompt.js` | `SYSTEM_PROMPT` — products, states, qualifying guidelines, served/excluded industries, and the safety guardrails — plus `buildSystemPrompt()`, which appends the turn's rep-availability note. Edits here are a compliance change |
| `businessHours.js` | Whether a rep is available right now (real `America/New_York` conversion) and the structural after-hours reply gate |
| `intent.js`       | Handoff detection + best-effort extraction of name/email/phone/loan info |
| `botBrain.js`     | The transport-independent half of the bot: Anthropic client, model settings, the pinned clock, the `SCG_STATUS`/`SCG_LEAD` parsers, lead-field accumulation and the lead minimum. Shared by the web and WhatsApp paths |
| `whatsapp.js`     | The Meta WhatsApp Cloud API transport: the GET verification handshake, the `X-Hub-Signature-256` HMAC, payload parsing, wamid dedupe, and the outbound send |
| `whatsappConversation.js` | `Conversation__c`/`Message__c` keyed on `Whatsapp_Wa_Id__c` — explicit `Channel__c`, the Closed→New reopen, `Last_Inbound_At__c`, and the transcript read |
| `whatsappWebhook.js` | The WhatsApp turn: routing, return-200-fast dispatch, and the AI/lead/Salesforce flow reusing every module above |
| `intent.test.js`  | Tests for the heuristics (`npm test`); not bundled into the deployment zip |

## API

### `POST /`

```json
{
  "messages": [
    { "role": "user", "content": "Do you fund restaurants?" },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "Can someone call me?" }
  ],
  "sessionId": "optional-client-generated-id"
}
```

Response — `200`:

```json
{
  "reply": "Happy to set that up. What's the best name and number to reach you at?",
  "handoff": true,
  "handoffFields": {
    "name": "Dana Whitfield",
    "email": "dana@whitfieldbakery.com",
    "phone": "(216) 555-0142",
    "businessName": "Whitfield Bakery",
    "loanAmount": "$75,000",
    "loanPurpose": ["equipment", "inventory"]
  },
  "liveHandoff": true,
  "businessHours": { "open": true, "hours": "Monday–Friday, 9am–6pm Eastern", "timezone": "America/New_York" },
  "sessionId": "3cb524a3-553f-4650-9d70-961dac8ab851"
}
```

- `handoffFields` contains **only the keys that were actually found** — it is `{}` when nothing was
  gathered, and `{}` whenever `handoff` is `false`.
- `sessionId` is echoed back when supplied, otherwise generated (`crypto.randomUUID()`), so the
  client can keep using the same value for the rest of the conversation.
- `liveHandoff` is `handoff` **and** a rep being on shift. `handoff: true, liveHandoff: false` is the
  after-hours case: the lead was captured, but nobody is joining the chat. See **Business hours** below.
- A chat turn on a conversation a rep has taken comes back as `{ "reply": null, "live": true }`, and
  one on a chat the visitor has ended as `{ "reply": null, "closed": true, "live": false }`. Both
  echo `handoffContext` untouched. See **Live mode** below.

**Request rules** (violations return `400` with a specific message):

- `messages` must be a non-empty array of `{ role: "user" | "assistant", content: <non-empty string> }`
- the last message must be from the `user` (a trailing assistant turn is a prefill, which the model rejects)
- leading assistant turns are dropped; the transcript is trimmed to the last **40** messages and each
  `content` to **4000** characters

**Other statuses:** `204` (CORS preflight), `405` (non-POST), `500` (safe generic message; the full
error, including stack and Anthropic `request_id`, goes to CloudWatch).

### `POST /` — `{ "action": "poll" }`

The return path. A conversation claimed by a rep gets no bot reply, so the rep's answers reach the
widget only by being fetched. Same function, same Function URL, same `x-widget-token` gate; it never
reaches Claude.

```json
{ "action": "poll", "sessionId": "3cb524a3-...", "after": "2026-08-26T18:00:20.000Z" }
```

Response — `200`:

```json
{
  "messages": [
    { "id": "a02Ab000001XyZ", "body": "Dana here — got your details.", "sentAt": "2026-08-26T18:02:00.000Z" }
  ],
  "live": true,
  "closed": false,
  "status": "Claimed",
  "conversationId": "a01Ab000001AbC",
  "sessionId": "3cb524a3-..."
}
```

- **Only rep messages.** Inbound is the visitor's own text, and the bot's replies already reached
  them in the chat response that produced them. Both bot and rep replies are `Direction__c =
  'Outbound'` in Salesforce, so `Direction__c` alone cannot make that second cut — **authorship**
  does: every `Message__c` this Lambda writes is created by the integration user, so the query
  excludes `CreatedById = <integration user>`. The id comes free with the JWT auth (the token
  response's identity URL); `SF_INTEGRATION_USER_ID` overrides it. With neither available the poll
  falls back to matching the conversation's `Assigned_To__c`, and if that is empty too it returns no
  messages rather than replaying the bot's own words back into the widget.
- `after` is optional and accepts either an ISO timestamp (the `sentAt` of the last message shown —
  preferred) or a `Message__c` id. Messages at or before it are not re-sent.
- `live` is `true` only while `Status__c === 'Claimed'`; `closed` is `true` only while it is
  `'Closed'`. Never both. A `Closed` conversation still returns the rep's final messages — a last
  word sent just before the visitor ended the chat must not be swallowed by the close.
- No conversation for that session yet → `{ "messages": [], "live": false, "closed": false, "status": null }`.
- **Salesforce unreachable → still `200`,** with `{ "messages": [], "live": false, "closed": false, "error": true }`,
  so the widget just retries on its next tick. A page polling every few seconds never gets a `500`.
- One SOQL per poll, plus the external-id read that resolves the session; both reuse the cached
  access token, so a warm container polls without re-authenticating.
- `sessionId` is **required** here (a poll for no session is meaningless) — omitting it is a `400`.

### `POST /` — `{ "action": "close" }`

The widget's **End Chat** button. Sets the conversation's `Status__c` to `'Closed'` and nothing else.
Same function, same Function URL, same `x-widget-token` gate; it never reaches Claude.

```json
{ "action": "close", "sessionId": "3cb524a3-..." }
```

Response — `200`:

```json
{
  "closed": true,
  "reply": null,
  "live": false,
  "status": "Closed",
  "conversationId": "a01Ab000001AbC",
  "sessionId": "3cb524a3-..."
}
```

- **Idempotent.** An already-closed conversation reports `closed: true` with `alreadyClosed: true`
  and issues no second write.
- A **`Claimed`** conversation closes too: a visitor ending the chat outranks a rep holding it, and
  the rep sees the status change in Salesforce.
- **No conversation for that session** → `200` with `{ "closed": false, "notFound": true }`. The
  `Conversation__c` is only created at handoff, so a visitor who never asked for a human has nothing
  to close; the widget ends the chat on its own side either way. Nothing is created just to close it.
- **Salesforce unreachable → still `200`,** with `{ "closed": false, "error": true }`. A visitor on
  their way out of the chat must not be shown an error to leave; the cost is a conversation left open
  in Salesforce for a rep to tidy up.
- `sessionId` is **required** — omitting it (or sending a blank one) is a `400`.

### Live mode: the three states the widget renders

`Status__c` on `Conversation__c` is the single source of truth, and the chat turn reports it:

| `Status__c` | Chat-turn response | Who answers |
| ----------- | ------------------ | ----------- |
| `New` (or no conversation) | `reply: "..."` | The **bot**. Claude is called normally. |
| `Claimed`   | `reply: null, live: true`   | A **rep**, in Salesforce. The visitor's message is still recorded `Inbound`; the rep's answers reach the widget via the poll. |
| `Closed`    | `reply: null, closed: true` | **Nobody.** The chat is over. |

Two transitions matter beyond the initial takeover:

- **Rep hands back** (`Claimed` → `New`, set by the rep in Salesforce). The bot resumes on the very
  next turn, with no special handling: it answers from the full transcript the widget sends — the
  rep's own turns included, since the widget rendered them as assistant turns — and because the
  conversation already exists the turn *appends* the new exchange rather than backfilling a second
  copy of the thread. The once-per-session lead guard still holds, so handing back cannot produce a
  second `Lead`.
- **Visitor ends the chat** (→ `Closed`, via `action: "close"`). **Terminal.** No bot reply, no bot
  resume, and not one write against the finished record: `recordVisitorTurn` re-checks the status and
  refuses to append, which is what stops a Salesforce outage — during which the live-mode check fails
  open and the bot answers — from writing to a closed conversation anyway. Nothing in this Lambda
  reopens a conversation; a rep changing the status back in Salesforce is the only way.

### Handoff detection

`handoff: true` fires when either:

1. the visitor's latest message explicitly asks for a human — "talk to a real person", "funding
   specialist", "call me", "how do I apply", etc.; **or**
2. the assistant offered a handoff on its previous turn **and** the visitor's latest message is a
   short acceptance ("yes please", "sure", "that works"). An explicit decline never fires, and an
   acceptance carrying a follow-up question (>12 words) doesn't either.

**and** the business is one Spartan can actually fund. `handoff: true` means "a fundable visitor
wants to proceed" — not "the visitor typed the words talk to someone". A visitor in an excluded
industry returns `false` no matter how they phrase the request, so a business that was just turned
away can never become a lead.

That second half can't be decided by regex — only the model holds the industry rules — so it comes
from the model itself. Every reply ends with a status tag (`[[SCG_STATUS: OK]]` or
`[[SCG_STATUS: DECLINE]]`, see `systemPrompt.js`); `index.js` parses it, **strips it from `reply`
before returning**, and suppresses the handoff on `DECLINE`. Underneath that sit two deterministic
backstops in `intent.js`: a narrow set of decline phrasings ("isn't able to fund", "doesn't fund"),
and stickiness — once any assistant turn in the transcript declined, later turns stay suppressed.

The failure modes are deliberately asymmetric. A missing or malformed tag counts as *not* declined,
because defaulting the other way would silently drop real leads; the phrase backstop still catches
the bad-lead case. The phrase list stays narrow on purpose: "I can't quote you a rate" and "you may
not meet the guidelines yet" are **not** declines, and both still hand off.

Visitor intent is still deterministic regex, and it's still one API call per chat turn. Field
extraction reads the **visitor's** messages only, so a figure the bot mentions can't be captured as
if the visitor had said it.

### Business hours: when a live handoff is actually possible

Funding specialists work **Monday–Friday, 9:00am–6:00pm Eastern**. Outside that window nobody claims
a conversation, so "connecting you to a specialist now" is a promise nothing can keep — the visitor
watches an empty chat until morning.

Availability is resolved per turn in `businessHours.js`, from a real `Intl.DateTimeFormat` conversion
with `timeZone: "America/New_York"`. **Not** a fixed UTC offset: that is wrong for half the year in
either direction — assume `-05:00` and a 9:30am EDT visitor reads as 8:30am and gets turned away
while reps are at their desks; assume `-04:00` and a 5:30pm EST visitor reads as 6:30pm and loses the
last half hour of the day. Open is `Mon–Fri && 9 <= etHour < 18`; everything else is after hours. An
unusable clock fails **closed**, because a false "open" promises a rep who does not exist while a
false "closed" only promises a callback.

What does **not** change after hours — this is the point:

- The bot qualifies and collects exactly as it does at midday, one question per turn.
- The `Lead` is written to Salesforce.
- The `Conversation__c` is created, transcript and all, so a rep picks it up from the morning queue.

What changes is only the language at the handoff moment, and it is enforced in two layers:

1. **The prompt.** `buildSystemPrompt({ open })` appends an availability note telling the model that
   reps are offline, that it must not say anyone is joining, and what to say instead: the hours, that
   the details are saved, that a specialist will reach out during business hours — and the full
   application as the thing that does work right now, since it is available 24/7.
2. **The gate**, `enforceAfterHoursReply` in `businessHours.js`. A prompt is guidance, so the reply
   is checked structurally: any sentence asserting a live human *now* — a connecting/transferring/
   joining verb, or an immediacy phrase like "shortly" or "right away", in a sentence about a
   specialist — is removed, and the availability notice is appended in its place. Stripping too much
   is the safe direction here: a terse reply costs nothing, a surviving "a specialist is joining you"
   costs the visitor their evening. Sentences that promise a *callback* ("a specialist will reach out
   during business hours") are deliberately not matched, because that is the correct message.

The gate runs before both the response and the Salesforce write, so the visitor and the rep's morning
transcript read the same text. A **declined** business is exempt from the append: an excluded industry
gets no specialist and no application link at any hour, and the after-hours notice must not become a
back door to the link the decline path withholds.

`liveHandoff` in the response is the flag a widget should branch on for its live-chat affordances:
`handoff` says a lead was captured, `liveHandoff` says a human is joining.

**A chat already live with a rep is never touched.** A conversation `Claimed` at 5:50pm is still
claimed at 6:05pm — the rep is sitting in it — and that turn returns `{ reply: null, live: true }`
from the live-mode check *before* business hours are even resolved. The gate only ever affects a turn
the bot is answering, which is to say a **new** handoff offer. A rep who hands back (`Claimed` →
`New`) after hours leaves the bot answering under the gate, which is correct.

## WhatsApp (Cloud API)

The same bot, reached over WhatsApp instead of the website widget. Two endpoints on the existing
Function URL, routed **before** the CORS headers and the `x-widget-token` gate — Meta is not a
browser, sends no `Origin`, will never send that header, and needs `GET` answered. On this path the
HMAC signature is the auth.

| Endpoint | Purpose |
| -------- | ------- |
| `GET /whatsapp`  | Meta's one-time verification handshake |
| `POST /whatsapp` | Signed message and status events |

### `GET /whatsapp` — verification

Meta sends `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`. On a token match the response
is **`200` with the challenge as plain text and nothing else** — Meta compares the body byte for
byte, so a JSON-wrapped or quoted challenge fails the handshake even when the token was right.
A mismatch, a different `hub.mode`, or an unset `WHATSAPP_VERIFY_TOKEN` all give `403`.

### `POST /whatsapp` — messages

Payload shape (Cloud API v23.0):

```
entry[].changes[].value.messages[]  { from (wa_id), id (wamid), timestamp, type, text.body }
entry[].changes[].value.contacts[]  { wa_id, profile.name }
entry[].changes[].value.metadata    { phone_number_id }
entry[].changes[].value.statuses[]  delivery receipts — counted and dropped
```

Order of operations, and why:

1. **Signature first.** HMAC-SHA256 of the **raw** body under `WHATSAPP_APP_SECRET`, compared
   constant-time against `X-Hub-Signature-256: sha256=<hex>`. The raw bytes are the only thing that
   can be hashed: `JSON.parse` → `JSON.stringify` changes key order, whitespace and unicode
   escaping, and every check would fail. A Lambda Function URL may deliver the body base64-encoded,
   so the decode happens in `rawBody()` and the resulting `Buffer` feeds both the HMAC and the parse.
   A bad or missing signature is a `403` that reaches neither Claude nor Salesforce.
2. **Statuses ignored.** Delivery receipts are most of the real traffic and are not visitor turns.
   Counted for the log, acknowledged with `200` so Meta never retries them.
3. **Dedupe by wamid.** A Meta retry carries the same message id as the original. The claim is taken
   at receipt, before the slow work starts, because that window is exactly when a retry arrives.
4. **Return `200` fast** (below), then the AI turn.

### Returning 200 fast

Meta retries anything that is not a prompt `200` and eventually **disables** a webhook that keeps
failing. One turn here is a Claude call plus several Salesforce round-trips — seconds, not
milliseconds. A Function URL response is buffered, so work started and not awaited is frozen the
moment the handler returns; `void doWork()` would silently lose the reply.

So the POST handler does only the fast local work (signature, parse, dedupe), **invokes this same
Lambda a second time** with `InvocationType: 'Event'`, and returns `200` immediately. The second
invocation arrives as `{ whatsappJob: { … } }`, is routed at the top of `index.js`, and does the
Claude/Salesforce/send work with nobody waiting on it.

This needs **`lambda:InvokeFunction` on the function's own execution role**:

```bash
aws iam put-role-policy --profile spartan \
  --role-name spartan-chatbot-role \
  --policy-name spartan-chatbot-self-invoke \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:us-east-1:826917684352:function:spartan-chatbot"
    }]
  }'
```

Until that policy is attached the dispatch fails and the handler **falls back to processing inline**,
still returning `200` — the visitor gets their reply, it just takes the `200` with it. Watch for
`async dispatch unavailable` in CloudWatch; that line means the fallback is in use.

`@aws-sdk/client-lambda` is supplied by the `nodejs20.x` runtime and is deliberately **not** a
dependency of this package, so it is loaded with `import()` rather than a static import — a static
one would be evaluated by the test suite, where the package does not exist, and would fail at load.
That `import()` runs at **module scope**, so it resolves during Lambda's INIT phase rather than
inside a request Meta is timing; both outcomes settle into a plain object, so it can neither reject
nor raise an unhandled rejection, and a context without the package degrades to the inline fallback.

Measured before that change: the first dispatch in a container cost ~2.8s — and it cost that on a
*warm* container too, because the client cache is per-container and a container warmed by anything
that is not a dispatch (a verification GET, a widget chat turn) still paid the whole import on its
first WhatsApp message. Loading at INIT removes that case. It does not make a genuine cold start
faster: Meta waits for INIT plus the handler either way, so there the cost moves rather than
disappears.

### The conversation

Keyed on `Whatsapp_Wa_Id__c` (external id, unique), not `Session_Id__c`: WhatsApp has no sessions,
just one thread per phone number for ever.

- **`Channel__c` is set to `'WhatsApp'` explicitly on create.** The field defaults to `Web`, and a
  WhatsApp thread that inherits the default shows up in the web rep panel as though somebody were
  sitting on the website waiting. This is the one field that must never be dropped.
- **A `Closed` conversation reopens** (`Status__c` back to `New`) on the next inbound. On the web,
  Closed is terminal — the visitor pressed End Chat and the tab is gone. On WhatsApp the same person
  messaging next week is the same thread, and refusing to answer would look like a broken number.
- **`Status__c === 'Claimed'` means the model is not called at all.** The message is recorded Inbound
  and the rep answers in Salesforce, exactly as on the web path. No automatic nudge is sent either,
  including for an unreadable message type — interjecting over a rep is what live mode prevents.
- **`Last_Inbound_At__c` is stamped on every inbound.** It is the 24-hour-window clock (below).
- `Session_Id__c` is set to `wa:<wa_id>` on create, so the record is addressable by the machinery the
  web path already has. Nothing in this transport needs it.
- **No name is written.** The fields the create sets are `Channel__c`, `Status__c`, `Session_Id__c`,
  `Whatsapp_Phone__c` and (once one exists) `Lead__c`. The visitor's name is the Lead's, not the
  conversation's.

### What differs from the web path, and what does not

Everything about *the bot* is reused, not reimplemented: `systemPrompt.js`, the excluded-industry
decline, `intent.js`, `leadHandoff.js`, the lead minimum, the after-hours gate, and the
`Conversation__c`/`Message__c` shape. WhatsApp is a transport.

Two things the widget provides for free that this path has to solve:

| | Web | WhatsApp |
| --- | --- | --- |
| The transcript | the widget posts the whole thread every turn | re-read from `Message__c` and the new message appended (one extra SOQL per turn) |
| Lead-field accumulation | round-trips through `handoffContext` | a warm-container store keyed by `wa_id`, plus a transcript scan, plus this turn's `SCG_LEAD` block |

The lead-field store is best-effort in the same honest way `leadMemory` is — a cold start forgets.
What makes that survivable is that it is not the primary mechanism: the model is handed the whole
thread from Salesforce every turn and re-reports its block when it wraps up. The guard against a
**duplicate** lead is *not* best-effort here — `Conversation__c.Lead__c` is read back on every
inbound, which is stronger than anything the web path has. Note the web path's secondary guard
("a conversation exists, so a lead must too") does not hold on WhatsApp and must not be borrowed:
here the conversation is created on the first inbound, long before any handoff.

The visitor's phone number needs no collecting — the `wa_id` *is* their number. It is merged in
underneath anything the conversation reported, so a different callback number wins.

### Message types

`text` is the ordinary case; `button` and `interactive` replies are read the same way (still text the
visitor chose). Anything else — image, voice note, document, location — is recorded Inbound as
`[<type> message received …]` and answered with a short nudge to type instead. The model is never
called for one.

Long replies are **split** into consecutive messages rather than truncated: Meta rejects a text body
over 4096 characters.

### Known limitations

- **The 24-hour window.** Meta only allows free-form (non-template) messages within 24 hours of the
  visitor's last inbound. **The AI path is always inside it by construction** — the bot only ever
  speaks because the visitor just messaged. The case that can fall outside is a **rep** replying
  later from the Salesforce console, and that is the rep-panel step's problem to solve, with an
  approved template to reopen the window. `Last_Inbound_At__c` is stamped here precisely so that
  panel can tell whether the window is still open.
- **Dedupe is warm-container memory.** It covers the realistic case (a retry arriving seconds after
  the original, at a Lambda that is certainly still warm); a cold start or a second concurrent
  container can let a redelivery through. The residual risk is a duplicate reply, never a lost
  message. The durable version is a `Wamid__c` external id on `Message__c`.
- **The visitor's name is not on the conversation.** `Conversation__c` has no visitor-name field —
  the name belongs to the Lead, where the bot collects it in the visitor's own words. The WhatsApp
  profile name that arrives on every inbound is logged and nothing else; it is deliberately not
  promoted into the lead fields, because a display name ("Mom", an emoji, a business slogan) would
  satisfy the name half of the lead minimum and produce exactly the placeholder record that gate
  exists to stop. Routing it in as a labelled fallback is a possible follow-up, not current
  behaviour.
- **One number.** `WHATSAPP_PHONE_NUMBER_ID` is a single value; the `value.metadata.phone_number_id`
  on inbound events is parsed but not yet used to route between numbers.

### Setting it up in the Meta app dashboard

1. Set all four env vars on the Lambda. `WHATSAPP_VERIFY_TOKEN` is a string **we** choose — generate
   a fresh one and keep it out of version control:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

   Referred to below as `<WHATSAPP_VERIFY_TOKEN>`.
2. WhatsApp → Configuration → Edit the callback URL:
   - **Callback URL:** `<function-url>whatsapp`
   - **Verify token:** the same `WHATSAPP_VERIFY_TOKEN` value
3. Verify and save. A `200` with the echoed challenge means the handshake passed; check CloudWatch
   for `webhook verification succeeded`.
4. Subscribe to the **`messages`** webhook field.
5. Add your own number to the test recipients list and message the test number.

## Environment variables

| Name                | Required | Notes |
| ------------------- | -------- | ----- |
| `ANTHROPIC_API_KEY` | **Yes**  | Anthropic API key. Never commit it; set it as a Lambda env var (see below). Missing key ⇒ logged `500`. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp | The Cloud API phone number id — the path segment on every send. Test number: `1240388075832660`. |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp | Graph API bearer token. The dashboard's temporary token expires in 24h; a System User token is the permanent replacement. |
| `WHATSAPP_VERIFY_TOKEN` | WhatsApp | A random string **we** choose, entered identically in the Meta app dashboard. Only used by the GET handshake. |
| `WHATSAPP_APP_SECRET` | WhatsApp | Meta app secret (App Settings → Basic → App Secret). Used to verify the `X-Hub-Signature-256` HMAC on every POST. |
| `WHATSAPP_ASYNC` | No | Set to `false` to force the webhook to do its work inline instead of self-invoking. Diagnostics only — see *Returning 200 fast* below. |

The key is read from the environment at first use and the client is cached across warm invocations.

**Both WhatsApp secrets fail CLOSED.** With `WHATSAPP_VERIFY_TOKEN` unset the handshake 403s; with
`WHATSAPP_APP_SECRET` unset every webhook POST 403s. That is the opposite of `WIDGET_TOKEN`, which
fails open — an unset widget token would lock real visitors out of the website, whereas an unset
WhatsApp secret only means the webhook cannot be activated yet, and this endpoint spends money and
writes to Salesforce on nothing but an unauthenticated POST.

## Deploy

Prerequisites: AWS CLI v2 configured for `us-east-1`, Node 20+, `zip`.

### 1. Build the zip

```bash
npm install     # first time only
npm run build   # -> function.zip (handler files + production node_modules)
```

`npm run build` installs with `--omit=dev` into a clean staging directory, so tests never ship.

### 2. Create the execution role (one time)

```bash
aws iam create-role \
  --role-name spartan-chatbot-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name spartan-chatbot-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

### 3. Create the function (one time)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws lambda create-function \
  --function-name spartan-chatbot \
  --region us-east-1 \
  --runtime nodejs20.x \
  --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/spartan-chatbot-role" \
  --timeout 30 \
  --memory-size 512 \
  --zip-file fileb://function.zip \
  --environment "Variables={ANTHROPIC_API_KEY=sk-ant-...}"
```

The 30s timeout matches the 25s Anthropic client timeout in `index.js` (with 1 retry, keep the
Lambda timeout at or above 30s).

> Prefer not to put the key on the command line? Create the function without `--environment`, then
> set it from a file: `aws lambda update-function-configuration --function-name spartan-chatbot
> --environment file://env.json` (and don't commit `env.json` — `.env*` is already gitignored).
> For production, store the key in Secrets Manager / SSM Parameter Store and inject it at deploy
> time, or read it in the handler via the Parameters and Secrets Lambda extension.

### 4. Create the Function URL (one time)

```bash
aws lambda create-function-url-config \
  --function-name spartan-chatbot \
  --region us-east-1 \
  --auth-type NONE \
  --invoke-mode BUFFERED

aws lambda add-permission \
  --function-name spartan-chatbot \
  --region us-east-1 \
  --statement-id AllowPublicFunctionUrl \
  --action lambda:InvokeFunctionUrl \
  --principal '*' \
  --function-url-auth-type NONE
```

Both commands are required — without `add-permission` the URL returns `403`. Grab the URL with:

```bash
aws lambda get-function-url-config --function-name spartan-chatbot \
  --region us-east-1 --query FunctionUrl --output text
```

**Do not configure Function-URL-level CORS (`--cors`).** CORS is handled in `index.js` (allowlist +
`Vary: Origin`); configuring it on the Function URL too produces duplicate/conflicting
`Access-Control-Allow-Origin` headers, which browsers reject.

### 5. Subsequent deploys

```bash
npm run build
aws lambda update-function-code \
  --function-name spartan-chatbot \
  --region us-east-1 \
  --zip-file fileb://function.zip
```

To rotate the key or change config:

```bash
aws lambda update-function-configuration \
  --function-name spartan-chatbot \
  --region us-east-1 \
  --environment "Variables={ANTHROPIC_API_KEY=sk-ant-...}"
```

`update-function-configuration` **replaces** the whole environment map — always pass every variable
you want to keep.

## CORS

Allowed origins (exact match, in `ALLOWED_ORIGINS` in `index.js`):

- `https://www.spartancapital.us`
- `https://spartancapital.us`
- `http://localhost:3000` (testing — remove before launch if you'd rather not ship it)

Allowed method `POST` (plus the `OPTIONS` preflight, answered with `204`) and request header
`Content-Type`. Requests from any other origin still execute but receive **no**
`Access-Control-Allow-*` headers, so a browser blocks the response.

## Testing

Heuristics (no API key or AWS needed):

```bash
npm test
```

Every handler test pins the clock via the `setClock` seam exported from `index.js`, so the suite is
time-independent — it passes at 2pm on a Tuesday and at 2am on a Sunday alike.
`test/business-hours.js` owns the availability behaviour: the EST/EDT conversion (including two cases
that fail under either hardcoded offset), the reply gate, and the four end-to-end cases — during
hours, weekday evening, weekend, and a conversation already live with a rep.

`test/whatsapp-webhook.js` owns the WhatsApp transport: the handshake (match, mismatch, unset token),
the signature (valid, wrong HMAC, missing header, body tampered under a valid signature, wrong app
secret, base64-encoded body, non-canonical key order — the last two are what prove the *raw* bytes
are hashed and not a re-serialised parse), `Channel__c = 'WhatsApp'` on create, wamid dedupe, status
events ignored, `Claimed` → no model call, `Closed` → reopened, the shape of the Graph API send, and
that a widget POST at `/` is untouched by any of it. Meta and Salesforce are both stubbed at
`globalThis.fetch`; there are no real network calls.

Against the deployed URL:

```bash
URL=$(aws lambda get-function-url-config --function-name spartan-chatbot \
  --region us-east-1 --query FunctionUrl --output text)

# Preflight
curl -i -X OPTIONS "$URL" \
  -H 'Origin: https://www.spartancapital.us' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type'

# Chat turn
curl -s -X POST "$URL" \
  -H 'Origin: https://www.spartancapital.us' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Do you fund HVAC businesses? I need about $60k for equipment."}]}'

# Handoff turn
curl -s -X POST "$URL" \
  -H 'Origin: https://www.spartancapital.us' \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-1","messages":[
        {"role":"user","content":"I need working capital for my bakery"},
        {"role":"assistant","content":"Would you like me to have a funding specialist reach out to go over your options?"},
        {"role":"user","content":"yes please"}]}'
```

Logs: `aws logs tail /aws/lambda/spartan-chatbot --region us-east-1 --follow`

## Before launch

- [ ] Have compliance review `systemPrompt.js` — the no-figures, no-approval-promises, and
      no-underwriting-mechanics rules are the guardrails that keep chat replies safe.
- [ ] Decide whether any required disclosure/disclaimer language has to appear in chat; nothing of
      that kind is in the prompt today.
- [ ] Decide whether `http://localhost:3000` stays in the CORS allowlist.
- [ ] The Function URL is `--auth-type NONE`, i.e. publicly callable. Consider putting CloudFront +
      WAF rate limiting in front of it, or a lightweight shared token from the widget, before it
      takes real traffic.
- [ ] Move `ANTHROPIC_API_KEY` to Secrets Manager / SSM if plain Lambda env vars don't meet your
      security bar.
- [ ] Wire up lead delivery (Salesforce) as a separate step — this function only reports
      `handoff` + `handoffFields`.
