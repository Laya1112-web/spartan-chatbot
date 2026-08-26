# spartan-chatbot

AWS Lambda function powering the chat widget on the Spartan Capital Group website. It takes a
conversation transcript, calls the Anthropic Messages API, and returns the assistant's reply plus a
flag for whether the visitor wants to be handed to a human funding specialist.

- **Runtime:** `nodejs20.x` (ESM)
- **Region:** `us-east-1`
- **Invocation:** Lambda Function URL (buffered, payload format 2.0) — no API Gateway
- **Model:** `claude-sonnet-5`, `max_tokens` 1024

There is **no CRM/Salesforce integration in this function** by design. A handoff is flagged and the
fields gathered so far are returned; delivering that lead is a separate piece of work.

## Files

| File              | Purpose |
| ----------------- | ------- |
| `index.js`        | Lambda handler: CORS, request validation, Anthropic call, response shaping |
| `systemPrompt.js` | Exported `SYSTEM_PROMPT` — products, states, qualifying guidelines, served/excluded industries, and the safety guardrails. Edits here are a compliance change |
| `intent.js`       | Handoff detection + best-effort extraction of name/email/phone/loan info |
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
  "sessionId": "3cb524a3-553f-4650-9d70-961dac8ab851"
}
```

- `handoffFields` contains **only the keys that were actually found** — it is `{}` when nothing was
  gathered, and `{}` whenever `handoff` is `false`.
- `sessionId` is echoed back when supplied, otherwise generated (`crypto.randomUUID()`), so the
  client can keep using the same value for the rest of the conversation.

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
- `live` is `true` only while `Status__c === 'Claimed'`. A `Closed` conversation still returns the
  rep's final messages.
- No conversation for that session yet → `{ "messages": [], "live": false, "status": null }`.
- **Salesforce unreachable → still `200`,** with `{ "messages": [], "live": false, "error": true }`,
  so the widget just retries on its next tick. A page polling every few seconds never gets a `500`.
- One SOQL per poll, plus the external-id read that resolves the session; both reuse the cached
  access token, so a warm container polls without re-authenticating.
- `sessionId` is **required** here (a poll for no session is meaningless) — omitting it is a `400`.

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

## Environment variables

| Name                | Required | Notes |
| ------------------- | -------- | ----- |
| `ANTHROPIC_API_KEY` | **Yes**  | Anthropic API key. Never commit it; set it as a Lambda env var (see below). Missing key ⇒ logged `500`. |

The key is read from the environment at first use and the client is cached across warm invocations.

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
