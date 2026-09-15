# spartan-partner-onboarding

Standalone AWS Lambda that receives the Spartan Capital Group partner (ISO)
onboarding form, stores the submission in S3, emails the reviewers, and
optionally relays the packet to SharePoint.

It shares no code, no Function URL, and no execution role with
`spartan-chatbot` or the Python `spartan-lead-handler`. It only follows their
conventions: Node 20 ESM, one concern per module, structured logs prefixed with
the function name, full detail to CloudWatch and a safe message to the browser.

## The contract

`success: true` means the submission is durably in S3, and nothing else.

| Outcome | Status | Body |
| --- | --- | --- |
| Stored | 200 | `{ "success": true, "id": "po_…" }` |
| No `lead`, or no `lead.owner_email` | 400 | `{ "success": false, "error": "…" }` |
| S3 write failed (or `SUBMISSIONS_BUCKET` unset) | 500 | `{ "success": false, "error": "…" }` |
| Non-POST | 405 | `{ "success": false, "error": "…" }` |
| OPTIONS preflight | 204 | empty, with CORS headers |

The email and the SharePoint relay are best-effort deliveries layered on top of
an object that is already durable. **Neither can change the status code.** A
partner who completes a 67-field packet and is told it was received, when
nothing was stored, is the failure this function exists to eliminate — so an S3
failure must always be a 500, and an SES or SharePoint failure must never be.

A failed notification is logged as
`spartan-partner-onboarding: notification failed, submission IS saved`. That log
line is the only signal that a packet is saved but unreviewed; it is worth a
CloudWatch metric filter and an alarm.

## Request

```
POST /
Content-Type: application/json

{ "action": "partner_onboarding", "lead": { … 63 flat key/value fields … } }
```

`lead.owner_email` is the only required field. Everything else is optional and
is stored exactly as submitted, however sparse — a 60%-complete packet is worth
storing and reviewing. A mislabelled `action` is logged, not rejected.

## Modules

| File | Responsibility |
| --- | --- |
| `index.js` | Function URL entry: CORS, method routing, validation, orchestration, response |
| `storage.js` | The S3 write. Throws on failure by design — the only thing that can fail the request |
| `notify.js` | SES notification. Logs and swallows its own errors |
| `sharepoint.js` | Optional Power Automate relay. Skipped silently when unconfigured; never fails the request |
| `fields.js` | Pure: the six-section field map, the subject, and the plain-text body renderer |

### The field map

`fields.js` holds the real map from the revised form: 63 fields across six
sections — Your Information (30), Your Business (6), Volume (7), Lead Sources
(8), Strategy (7), Online Presence (5).

Two things about the revision, stated here so neither is undone by accident:

- **Six sections, not seven.** The earlier seven-section reconstruction is gone.
- **The Background section was removed entirely.** Bankruptcies, liens,
  judgements, criminal history and RBF notes are no longer collected. No key,
  label, or header for any of them exists in the map, and none can appear in the
  email.

Two renderer behaviours the form depends on:

- **Empty values are skipped.** The reveal fields (`owner2_*`, `loc2_*`,
  `loc_additional`, `scrub_other`, `outside_pct`) are submitted as empty strings
  when the partner answered No. The email shows `Second Owner?: No` and moves
  on, rather than printing blank labels.
- **`website` and `web_site` both print.** They are distinct keys holding the
  same value, in Section 1 and Section 6 respectively. They are deliberately not
  deduped — collapsing them would be this module deciding the form is redundant,
  which is not its call.

The `Additional Fields` fallback is retained: any submitted key the map does not
recognise is still printed, with a humanized label, under a trailing section.
The map is accurate today, but the form has already been revised once — when the
next field is added and this file has not caught up, the reader still sees the
value instead of the submission silently losing it.

## Storage layout

```
s3://spartan-capital-partner-submissions/onboarding/<YYYY>/<MM>/<id>.json
```

`<id>` is `po_<ISO-8601 basic timestamp>_<8 hex chars>`, e.g.
`po_20260915T142231Z_9f3a1c74`. The basic format (no colons) is deliberate: the
id becomes an object key and is pasted into console URLs and emails, where a
colon percent-encodes and breaks naive link building.

The stored object is the full lead plus `id`, `received_at`, and `source_ip`.
Server-side encryption (`AES256`) is set explicitly on every put.

Regions are pinned in code, not inherited from `AWS_REGION`: **S3 is us-east-2**
(`storage.js`), **SES is us-east-1** (`notify.js`). They differ, and moving the
function must not silently repoint either.

## Environment variables

`SUBMISSIONS_BUCKET`, `SES_FROM`, `NOTIFY_TO`, `SHAREPOINT_FLOW_URL` (optional),
`ALLOWED_ORIGIN`. See `.env.example` for the intended values and the behaviour
when each is unset. Nothing is hardcoded.

## Deploy

```bash
npm ci
npm run build     # produces function.zip
```

Runtime `nodejs20.x`, handler `index.handler`. The AWS SDK v3 clients are
bundled rather than relied on from the runtime image.

---

## Provisioning

Everything below still needs to be created — this repo is code and docs only.

### IAM: execution role policy

Attach `AWSLambdaBasicExecutionRole` (CloudWatch Logs) plus this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteSubmissions",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::spartan-capital-partner-submissions/onboarding/*"
    },
    {
      "Sid": "SendReviewerNotification",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:us-east-1:<ACCOUNT_ID>:identity/spartancapitalgroup.com",
      "Condition": {
        "StringEquals": {
          "ses:FromAddress": "notifications@spartancapitalgroup.com"
        }
      }
    }
  ]
}
```

Notes for whoever provisions it:

- Replace `<ACCOUNT_ID>`.
- `s3:PutObject` is scoped to the `onboarding/` prefix — the function writes
  nowhere else. No `GetObject`, no `ListBucket`, no `DeleteObject`: the function
  only ever appends.
- If the bucket uses SSE-KMS rather than SSE-S3, add `kms:GenerateDataKey` on
  the key ARN. The code requests `AES256`, so with a KMS-default bucket either
  relax the code to omit `ServerSideEncryption` or switch this to `aws:kms`.
- The SES resource is the **domain identity in us-east-1**; if only the
  individual address is verified, use
  `identity/notifications@spartancapitalgroup.com`. The `ses:FromAddress`
  condition is optional hardening.
- The SES account must be out of the sandbox, or both recipients individually
  verified, or the notification silently fails (and only the CloudWatch line
  above will say so).
- No `lambda:InvokeFunction`, no VPC, no Salesforce, no Secrets Manager access
  is needed.

### Function URL

| Setting | Value |
| --- | --- |
| Auth type | `NONE` |
| Invoke mode | `BUFFERED` (default) |
| Allow origin | `https://apply.spartancapitalgroup.com` |
| Allow methods | `POST`, `OPTIONS` |
| Allow headers | `content-type` |
| Max age | `86400` |
| Allow credentials | off |

Set `ALLOWED_ORIGIN` to the same origin — the handler emits its own CORS headers
and does its own origin check, so the two must agree.

**Confirm the origin before launch.** The onboarding page is a standalone HTML
file served from S3/CloudFront, not part of the Next.js marketing site, so this
is deliberately not `spartancapital.us`. `apply.spartancapitalgroup.com` is the
intended host — whoever provisions this must replace it with wherever the page
is actually served from. If the two disagree, **every submission fails CORS**:
the browser blocks the request before it reaches the handler, so there is no
CloudWatch line, no stored packet, and nothing to recover. It is the one
misconfiguration here that loses submissions invisibly.

`AuthType: NONE` is required because a public web form cannot sign SigV4. That
leaves the URL open to anyone who finds it, on an endpoint that accepts PII.
Two things worth deciding before launch:

1. Put CloudFront + WAF rate limiting in front of it, the same follow-up
   `spartan-chatbot` has pending for its own Function URL.
2. Consider a shared-token header, as the chat widget uses. It is not strong
   security — the token ships in page source — but it stops drive-by bots
   POSTing at a bare Function URL. Deliberately not implemented here, since the
   spec did not call for it.

Also worth setting: a bucket lifecycle policy, and versioning on the bucket so a
misconfigured redeploy cannot overwrite a stored packet.
