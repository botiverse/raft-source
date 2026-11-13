import type { AttachmentUploadLimits } from "./attachmentUploadLimit";

export const MAX_MESSAGE_ATTACHMENTS = 10;

export interface AttachmentLimitInput {
  size: number;
}

export interface MessageAttachmentLimitResult<T extends AttachmentLimitInput> {
  accepted: T[];
  rejectedForCount: T[];
  rejectedForEmpty: T[];
  rejectedForSize: T[];
  rejectedForQuota: T[];
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
  /** What is left of the monthly upload quota, or null where none applies. */
  monthlyRemainingBytes: number | null = null,
): MessageAttachmentLimitResult<T> {
  const accepted: T[] = [];
  const rejectedForCount: T[] = [];
  const rejectedForEmpty: T[] = [];
  const rejectedForSize: T[] = [];
  const rejectedForQuota: T[] = [];
  let remainingSlots = Math.max(MAX_MESSAGE_ATTACHMENTS - existingCount, 0);
  let remainingQuota = monthlyRemainingBytes ?? Number.POSITIVE_INFINITY;

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
    // A file the month has no room for doesn't use the room a later, smaller one fits in.
    if (candidate.size > remainingQuota) {
      rejectedForQuota.push(candidate);
      continue;
    }
    accepted.push(candidate);
    remainingSlots -= 1;
    remainingQuota -= candidate.size;
  }

  return { accepted, rejectedForCount, rejectedForEmpty, rejectedForSize, rejectedForQuota };
}

/** Why a picked file wasn't attached. */
export type AttachmentRejectionReason =
  /** Over the server's single-file ceiling. */
  | "size"
  /** Over the per-message attachment count. */
  | "count"
  | "empty"
  /** More than the monthly upload quota has left. */
  | "quota"
  /** The ceiling could not be checked, so nothing was attached. */
  | "unchecked";

export interface RejectedAttachment<T extends AttachmentLimitInput> {
  file: T;
  reason: AttachmentRejectionReason;
}

/** The files a selection didn't attach, and what they were checked against. */
export interface AttachmentRejection<T extends AttachmentLimitInput> {
  rejected: RejectedAttachment<T>[];
  /** The ceiling the files were checked against; null when it was unknown. */
  limits: AttachmentUploadLimits | null;
}

export interface MessageAttachmentSelectionDecision<T extends AttachmentLimitInput> {
  accepted: T[];
  /** Null when every file was attached. */
  rejection: AttachmentRejection<T> | null;
}

/**
 * The composer's whole accept/reject decision for a batch of picked files.
 *
 * `limits` is the server's effective ceiling and monthly quota, or `null` when
 * they could not be established. `null` refuses the batch: the composer has no
 * local ceiling to fall back to, by design (see `attachmentUploadLimit.ts`).
 * Keeping this decision here rather than inline in the component is what lets
 * the refuse-on-unknown branch be pinned by a test instead of only exercised
 * through the UI.
 */
export function decideMessageAttachmentSelection<T extends AttachmentLimitInput>(
  existingCount: number,
  candidates: T[],
  limits: AttachmentUploadLimits | null,
): MessageAttachmentSelectionDecision<T> {
  if (limits === null) {
    return {
      accepted: [],
      rejection: { rejected: candidates.map((file) => ({ file, reason: "unchecked" })), limits: null },
    };
  }
  const result = applyMessageAttachmentLimits(
    existingCount,
    candidates,
    limits.maxBytes,
    limits.monthlyUpload?.remainingBytes ?? null,
  );
  const reasonOf = new Map<T, AttachmentRejectionReason>([
    ...result.rejectedForSize.map((file) => [file, "size"] as const),
    ...result.rejectedForEmpty.map((file) => [file, "empty"] as const),
    ...result.rejectedForCount.map((file) => [file, "count"] as const),
    ...result.rejectedForQuota.map((file) => [file, "quota"] as const),
  ]);
  // In the order they were picked, so the notice names them in that order.
  const rejected = candidates.flatMap((file) => {
    const reason = reasonOf.get(file);
    return reason ? [{ file, reason }] : [];
  });
  return {
    accepted: result.accepted,
    rejection: rejected.length > 0 ? { rejected, limits } : null,
  };
}
