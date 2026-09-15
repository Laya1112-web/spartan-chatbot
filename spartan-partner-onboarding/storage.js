/**
 * The S3 write: the system of record for a partner onboarding submission.
 *
 * This is the one operation in this function that is allowed to fail the
 * request. Everything else -- the notification email, the SharePoint relay --
 * is a delivery convenience layered on top of an object that is already
 * durable. If this write does not succeed, the caller MUST see a 500, because a
 * 200 the submitter believes means "we have your packet" while nothing was
 * stored is precisely the silent-loss bug this function was written to end.
 *
 * So: no try/catch here. Errors propagate to index.js, which turns them into a
 * 500 and logs them. Swallowing anything in this module would defeat its
 * purpose.
 *
 * Region is us-east-2, where the submissions bucket lives -- deliberately not
 * the us-east-1 the SES client uses. Both are pinned explicitly rather than
 * inherited from AWS_REGION so that moving the function between regions cannot
 * silently point the write at a bucket that does not exist.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/** The bucket's region. Not the function's, and not SES's. */
export const S3_REGION = "us-east-2";

/**
 * Client at module scope so a warm container reuses the connection pool rather
 * than rebuilding TLS on every submission -- the same INIT-time-construction
 * reasoning as the Lambda SDK client in spartan-chatbot's whatsappWebhook.js.
 */
const s3 = new S3Client({ region: S3_REGION });

/**
 * Build the object key: onboarding/<YYYY>/<MM>/<id>.json, partitioned by the
 * submission's own UTC date so a year's packets stay browsable in the console.
 */
export function buildKey(id, receivedAt) {
  const at = new Date(receivedAt);
  const year = String(at.getUTCFullYear());
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `onboarding/${year}/${month}/${id}.json`;
}

/**
 * Write the submission. Resolves with the bucket and key on success; throws on
 * any failure, by design (see the header).
 *
 * The stored body is the full lead exactly as submitted, plus the envelope the
 * handler adds: id, received_at, source_ip. The lead is spread first so that a
 * form field named `id` cannot overwrite the submission's own identifier.
 */
export async function storeSubmission({ bucket, lead, id, receivedAt, sourceIp }) {
  const key = buildKey(id, receivedAt);

  const body = {
    ...lead,
    id,
    received_at: receivedAt,
    source_ip: sourceIp ?? null,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json",
      // SSE-S3. The bucket may well enforce this by default; setting it
      // explicitly means the object is encrypted even if that default is
      // ever relaxed.
      ServerSideEncryption: "AES256",
    }),
  );

  return { bucket, key };
}
