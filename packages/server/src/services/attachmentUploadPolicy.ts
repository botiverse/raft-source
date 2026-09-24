import { getSingleFileUploadLimitBytes, type ServerPlan } from "@botiverse/raft-shared";

const DEFAULT_DIRECT_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024;
const LEGACY_ATTACHMENT_SAFE_LIMIT_BYTES = 90 * 1024 * 1024;

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

export function getAttachmentFileSizeLimitBytes(plan: ServerPlan, now = new Date()): number {
  return getSingleFileUploadLimitBytes(plan, now);
}

export function getAttachmentDirectUploadThresholdBytes(): number {
  return integerEnv(
    "ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES",
    DEFAULT_DIRECT_UPLOAD_THRESHOLD_BYTES,
    1,
    200 * 1024 * 1024,
  );
}

/**
 * The browser multipart request must stay below the Cloudflare request-body
 * boundary. The direct-upload threshold only selects the direct transport; it
 * must not lower the legacy transport limit. The plan limit may be lower than
 * the fixed 90 MiB safety margin.
 */
export function getLegacyAttachmentFileSizeLimitBytes(plan: ServerPlan, now?: Date): number {
  return Math.min(
    getAttachmentFileSizeLimitBytes(plan, now),
    LEGACY_ATTACHMENT_SAFE_LIMIT_BYTES,
  );
}

/**
 * The client falls back to the legacy multipart transport below this value.
 * Never advertise a threshold above that transport's ceiling, or the interval
 * between the two values becomes impossible to upload despite fitting the
 * plan's single-file limit.
 */
export function getEffectiveAttachmentDirectUploadThresholdBytes(plan: ServerPlan, now?: Date): number {
  return Math.min(
    getAttachmentDirectUploadThresholdBytes(),
    getLegacyAttachmentFileSizeLimitBytes(plan, now),
  );
}
