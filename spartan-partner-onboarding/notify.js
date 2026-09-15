/**
 * The SES notification to the partner-onboarding reviewers.
 *
 * Runs AFTER the S3 write and never changes the caller's status code. By the
 * time this is reached the submission is already durable, so a bounced or
 * throttled email is an operational problem to chase in CloudWatch -- not a
 * reason to tell the submitter their packet failed and have them send it twice.
 * That asymmetry is deliberate and is the mirror image of storage.js.
 *
 * Errors are therefore logged and swallowed here, the same contract
 * spartan-chatbot's leadHandoff.js has with Salesforce: a downstream failure
 * never reaches the person on the other end of the request.
 *
 * Region is us-east-1 -- where the domain identity is verified -- and NOT the
 * us-east-2 the submissions bucket lives in.
 */

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

import { buildSubject, buildEmailBody } from "./fields.js";

/** The region the sending identity is verified in. Not the bucket's. */
export const SES_REGION = "us-east-1";

/** Warm-container reuse, as in storage.js. */
const ses = new SESClient({ region: SES_REGION });

/**
 * Parse NOTIFY_TO, which carries one or more comma-separated addresses.
 * Whitespace and empty entries are tolerated so that a trailing comma in the
 * Lambda console cannot produce an invalid destination.
 */
export function parseRecipients(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

/**
 * Send the notification. Resolves true when SES accepted the message, false on
 * any failure or misconfiguration; never throws.
 */
export async function sendNotification({ lead, id, receivedAt, sourceIp, bucket, key, from, to }) {
  const recipients = parseRecipients(to);

  if (!from || recipients.length === 0) {
    console.error("spartan-partner-onboarding: notification skipped, SES_FROM or NOTIFY_TO is unset", {
      id,
      key,
      hasFrom: Boolean(from),
      recipientCount: recipients.length,
    });
    return false;
  }

  try {
    await ses.send(
      new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: recipients },
        Message: {
          Subject: { Data: buildSubject(lead), Charset: "UTF-8" },
          Body: {
            // Plain text only, no attachment: the packet itself lives in S3 and
            // the key is printed in the footer.
            Text: {
              Data: buildEmailBody({ lead, id, receivedAt, sourceIp, bucket, key }),
              Charset: "UTF-8",
            },
          },
        },
      }),
    );

    return true;
  } catch (error) {
    // Loud, because the submission is saved but nobody has been told about it.
    // This log line is the only signal that a reviewer is unaware of a packet.
    console.error("spartan-partner-onboarding: notification failed, submission IS saved", {
      id,
      key,
      recipientCount: recipients.length,
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    });
    return false;
  }
}
