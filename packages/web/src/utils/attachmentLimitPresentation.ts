import type { IntlShape } from "react-intl";
import { PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES } from "@botiverse/raft-shared";
import { formatFileSizeBytes } from "./fileSizePresentation";
import { MAX_MESSAGE_ATTACHMENTS } from "./messageAttachmentLimits";
import type { AttachmentLimitInput, AttachmentRejection, AttachmentRejectionReason, RejectedAttachment } from "./messageAttachmentLimits";
import type { UploadLimitContext } from "../store/upgradeDialogStore";
import type { UploadLimit } from "../analytics/paywall";

const MIB = 1024 * 1024;

export type AttachmentUpgradeGate = "upload_file_size" | "upload_monthly_quota";

/** Why a file stays in the row unattached: what no plan changes. */
export type NotAttachedReason = Exclude<AttachmentRejectionReason, "quota">;

/**
 * What the composer does about the files a selection didn't attach (cindyz,
 * 2026-10-28). When Pro would take them, the upgrade dialog opens at once, for
 * every role (the dialog decides who pays and who asks an owner), and they
 * don't stay. What no plan changes (over every plan's ceiling, too many at
 * once, an empty file, a ceiling that couldn't be checked) stays in the
 * attachment row as a failed file that says why, until it is removed: the
 * reason sits by its file and doesn't go away by itself.
 */
export interface AttachmentRejectionPlan<T extends AttachmentLimitInput> {
  upgradeGate: AttachmentUpgradeGate | null;
  /** What the dialog's line says: the files Pro would take, or the month's quota. */
  upgradeContext: UploadLimitContext | null;
  /** The files that stay in the row, failed. */
  keep: Array<RejectedAttachment<T> & { reason: NotAttachedReason }>;
  /** What to record (upload_limit_hit): one per limit met, with the refused files' sizes. */
  hits: Array<{ limit: UploadLimit; response: "upgrade_dialog" | "kept_unattached"; sizes: number[] }>;
}

const KEPT_LIMIT = {
  size: "file_size_beyond_pro",
  count: "attachment_count",
  empty: "empty_file",
  unchecked: "limit_unknown",
} as const satisfies Record<NotAttachedReason, UploadLimit>;

export function attachmentRejectionPlan<T extends AttachmentLimitInput & { name: string }>(
  rejection: AttachmentRejection<T>,
  freePlan: boolean,
): AttachmentRejectionPlan<T> {
  const { rejected, limits } = rejection;
  // Pro takes a file over Free's ceiling but within its own, and has no monthly quota.
  const proTakes = ({ file, reason }: RejectedAttachment<T>) => freePlan && (
    reason === "quota" || (reason === "size" && file.size <= PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES)
  );
  const recoverable = rejected.filter((entry) => proTakes(entry) || (entry.reason === "quota" && limits?.monthlyUpload?.source === "appsumo"));
  const overQuota = recoverable.filter(({ reason }) => reason === "quota");
  const quota = limits?.monthlyUpload ?? null;
  const named = (list: typeof recoverable) => list.map(({ file }) => ({ name: file.name, size: file.size }));
  const [upgradeGate, upgradeContext]: [AttachmentUpgradeGate | null, UploadLimitContext | null] = overQuota.length > 0 && quota
    ? ["upload_monthly_quota", { kind: "monthly_quota", quota, files: named(overQuota) }]
    : recoverable.length > 0
      ? ["upload_file_size", { kind: "file_size", files: named(recoverable.filter(({ reason }) => reason === "size")) }]
      : [null, null];
  const keep = rejected.filter((entry): entry is RejectedAttachment<T> & { reason: NotAttachedReason } => (
    !proTakes(entry) && entry.reason !== "quota"
  ));
  const hits: AttachmentRejectionPlan<T>["hits"] = [];
  const hit = (limit: UploadLimit, response: "upgrade_dialog" | "kept_unattached", list: Array<RejectedAttachment<T>>) => {
    if (list.length > 0) hits.push({ limit, response, sizes: list.map(({ file }) => file.size) });
  };
  hit("monthly_quota", "upgrade_dialog", overQuota);
  hit("file_size", "upgrade_dialog", recoverable.filter(({ reason }) => reason === "size"));
  for (const reason of ["size", "count", "empty", "unchecked"] as const) {
    hit(KEPT_LIMIT[reason], "kept_unattached", keep.filter((entry) => entry.reason === reason));
  }
  return { upgradeGate, upgradeContext, keep, hits };
}

const LABEL_ID = {
  size: "message.composer.notAttached.tooLarge",
  count: "message.composer.notAttached.tooMany",
  empty: "message.composer.notAttached.empty",
  unchecked: "message.composer.notAttached.unchecked",
} as const satisfies Record<NotAttachedReason, string>;

/**
 * A file the row keeps unattached: the short line on its failed cover and the
 * whole reason (its tooltip and accessible description).
 */
export function notAttachedCopy(
  { reason, size, maxBytes, freePlan }: { reason: NotAttachedReason; size: number; maxBytes: number | null; freePlan: boolean },
  formatMessage: IntlShape["formatMessage"],
): { label: string; detail: string } {
  const label = formatMessage({ id: LABEL_ID[reason] });
  if (reason === "count") return { label, detail: formatMessage({ id: "message.composer.notAttached.count" }, { max: MAX_MESSAGE_ATTACHMENTS }) };
  if (reason === "empty") return { label, detail: formatMessage({ id: "message.composer.notAttached.emptyDetail" }) };
  if (reason === "unchecked" || maxBytes === null) return { label, detail: formatMessage({ id: "message.composer.attachmentLimitUnavailable" }) };
  const values = { size: formatUploadSize(size, formatMessage), limit: formatUploadSize(maxBytes, formatMessage) };
  // Over Pro's ceiling too, on Free: say both, so upgrading isn't mistaken for the way out.
  const detail = freePlan
    ? formatMessage({ id: "message.composer.notAttached.sizeDetailFree" }, { ...values, proLimit: formatUploadSize(PRO_SINGLE_FILE_UPLOAD_LIMIT_BYTES, formatMessage) })
    : formatMessage({ id: "message.composer.notAttached.sizeDetail" }, values);
  return { label, detail };
}

/** "63 MB", "2.4 MB": whole megabytes without a trailing ".0", as limits are written. */
export function formatUploadSize(bytes: number, formatMessage: IntlShape["formatMessage"]): string {
  if (bytes < MIB) return formatFileSizeBytes(bytes, formatMessage);
  return formatMessage({ id: "common.fileSize.mb" }, { value: Number((bytes / MIB).toFixed(1)) });
}
