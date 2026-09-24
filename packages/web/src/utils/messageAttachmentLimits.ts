import type { IntlShape } from "react-intl";

export const MAX_MESSAGE_ATTACHMENTS = 10;

export interface AttachmentLimitInput {
  size: number;
}

export interface MessageAttachmentLimitResult<T extends AttachmentLimitInput> {
  accepted: T[];
  rejectedForCount: T[];
  rejectedForEmpty: T[];
  rejectedForSize: T[];
}

/**
 * `maxSizeBytes` is required on purpose. It used to default to the Free-plan
 * constant, which meant a caller that forgot to pass the server's ceiling got a
 * plausible-looking local number instead of a type error. Requiring it makes
 * "where did this limit come from?" answerable at every call site, and makes
 * reintroducing a client-computed ceiling a visible edit rather than an
 * omission.
 */
export function applyMessageAttachmentLimits<T extends AttachmentLimitInput>(
  existingCount: number,
  candidates: T[],
  maxSizeBytes: number,
): MessageAttachmentLimitResult<T> {
  const accepted: T[] = [];
  const rejectedForCount: T[] = [];
  const rejectedForEmpty: T[] = [];
  const rejectedForSize: T[] = [];
  let remainingSlots = Math.max(MAX_MESSAGE_ATTACHMENTS - existingCount, 0);

  for (const candidate of candidates) {
    if (candidate.size === 0) {
      rejectedForEmpty.push(candidate);
      continue;
    }
    if (candidate.size > maxSizeBytes) {
      rejectedForSize.push(candidate);
      continue;
    }
    if (remainingSlots <= 0) {
      rejectedForCount.push(candidate);
      continue;
    }
    accepted.push(candidate);
    remainingSlots -= 1;
  }

  return { accepted, rejectedForCount, rejectedForEmpty, rejectedForSize };
}

export function formatMessageAttachmentLimitError(
  result: Pick<MessageAttachmentLimitResult<AttachmentLimitInput>, "rejectedForCount" | "rejectedForEmpty" | "rejectedForSize">,
  formatMessage: IntlShape["formatMessage"],
  maxSizeBytes: number,
): string {
  const parts: string[] = [];
  if (result.rejectedForCount.length > 0) {
    parts.push(formatMessage(
      { id: "message.composer.attachmentCountLimit" },
      { max: MAX_MESSAGE_ATTACHMENTS, extra: result.rejectedForCount.length },
    ));
  }
  if (result.rejectedForEmpty.length > 0) {
    parts.push(formatMessage(
      { id: "message.composer.attachmentEmptySkipped" },
      { count: result.rejectedForEmpty.length },
    ));
  }
  if (result.rejectedForSize.length > 0) {
    const largestRejected = Math.max(...result.rejectedForSize.map((file) => file.size));
    parts.push(formatMessage(
      { id: "message.composer.attachmentSizeLimit" },
      { maxSize: formatLimitBytes(maxSizeBytes), largest: formatBytes(largestRejected) },
    ));
  }
  return parts.join(" ");
}

function formatLimitBytes(bytes: number): string {
  const mib = 1024 * 1024;
  if (Number.isFinite(bytes) && bytes > 0 && bytes % mib === 0) {
    return `${bytes / mib}MB`;
  }
  return formatBytes(bytes);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
}

export interface MessageAttachmentSelectionDecision<T extends AttachmentLimitInput> {
  accepted: T[];
  error: string;
}

/**
 * The composer's whole accept/reject decision for a batch of picked files.
 *
 * `servedLimitBytes` is the server's effective ceiling, or `null` when it could
 * not be established. `null` refuses the batch: the composer has no local
 * ceiling to fall back to, by design (see `attachmentUploadLimit.ts`). Keeping
 * this decision here rather than inline in the component is what lets the
 * refuse-on-unknown branch be pinned by a test instead of only exercised
 * through the UI.
 */
export function decideMessageAttachmentSelection<T extends AttachmentLimitInput>(
  existingCount: number,
  candidates: T[],
  servedLimitBytes: number | null,
  formatMessage: IntlShape["formatMessage"],
): MessageAttachmentSelectionDecision<T> {
  if (servedLimitBytes === null) {
    return {
      accepted: [],
      error: formatMessage({ id: "message.composer.attachmentLimitUnavailable" }),
    };
  }
  const result = applyMessageAttachmentLimits(existingCount, candidates, servedLimitBytes);
  return {
    accepted: result.accepted,
    error: formatMessageAttachmentLimitError(result, formatMessage, servedLimitBytes),
  };
}
