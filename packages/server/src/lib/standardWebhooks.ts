// Standard Webhooks (https://www.standardwebhooks.com): HMAC-SHA256 over
// `${id}.${timestamp}.${body}` with a `whsec_` base64 secret, sent as
// space-separated `v1,<base64>` entries in `webhook-signature`.
import { createHmac, timingSafeEqual } from "node:crypto";

export const STANDARD_WEBHOOK_MAX_SKEW_SECONDS = 5 * 60;

export type StandardWebhookHeaders = { id?: unknown; timestamp?: unknown; signature?: unknown };

function single(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v ? v : null;
}

function secretKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
}

/** The webhook's id when the signature is good and the timestamp within 5 minutes; null otherwise. */
export function verifyStandardWebhook(payload: Buffer, headers: StandardWebhookHeaders, secret: string, nowMs = Date.now()): string | null {
  const id = single(headers.id);
  const timestamp = single(headers.timestamp);
  const signature = single(headers.signature);
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return null;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > STANDARD_WEBHOOK_MAX_SKEW_SECONDS) return null;
  const expected = createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.`).update(payload).digest();
  const valid = signature.split(" ").some((part) => {
    const [version, encoded] = part.split(",", 2);
    if (version !== "v1" || !encoded) return false;
    const given = Buffer.from(encoded, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return valid ? id : null;
}

/** Sign as a Standard Webhooks sender would (tests, and any Raft sender). */
export function signStandardWebhook(payload: string, id: string, timestampSeconds: number, secret: string): string {
  return `v1,${createHmac("sha256", secretKey(secret)).update(`${id}.${timestampSeconds}.${payload}`).digest("base64")}`;
}
