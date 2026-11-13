import { isAppSumoTier } from "@botiverse/raft-shared";
import { AttachmentUploadClientError } from "./directAttachmentUpload";

/**
 * What is left of a limited server's monthly file upload quota, as the server
 * reports it: in the web capabilities (`monthlyUpload`), in a direct upload's
 * refusal (`monthlyUpload`) and in a legacy upload's refusal (`quota`, the
 * same three fields among others). `month` is the UTC month it counts.
 */
export interface MonthlyUploadQuota {
  source?: "appsumo";
  month: string;
  limitBytes: number;
  remainingBytes: number;
}

/** The quota from a server body, or null when it isn't one (an older server, ordinary Pro). */
export function readMonthlyUploadQuota(value: unknown): MonthlyUploadQuota | null {
  if (typeof value !== "object" || value === null) return null;
  const { month, limitBytes, remainingBytes } = value as Record<string, unknown>;
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month)) return null;
  if (typeof limitBytes !== "number" || !Number.isFinite(limitBytes) || limitBytes <= 0) return null;
  if (typeof remainingBytes !== "number" || !Number.isFinite(remainingBytes) || remainingBytes < 0) return null;
  const record = value as Record<string, unknown>;
  const grant = record.appsumo;
  const appsumo = record.source === "appsumo" || (typeof grant === "object" && grant !== null && "tier" in grant && isAppSumoTier(grant.tier));
  return { month, limitBytes, remainingBytes, ...(appsumo ? { source: "appsumo" as const } : {}) };
}

/** When the quota starts over: the first moment of the next UTC month. */
export function monthlyUploadResetsAt(quota: MonthlyUploadQuota): Date {
  const [year, month] = quota.month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1));
}

const QUOTA_REFUSAL_CODE = "FILE_UPLOAD_QUOTA_EXCEEDED";

/**
 * The quota a failed upload was refused for, or null when it failed for any
 * other reason. Both upload paths answer it: direct upload with the code and
 * `monthlyUpload`, legacy upload with `errorCode` and `quota`.
 */
export function uploadQuotaRefusal(error: unknown): MonthlyUploadQuota | null {
  if (error instanceof AttachmentUploadClientError) {
    return error.code === QUOTA_REFUSAL_CODE ? readMonthlyUploadQuota(error.monthlyUpload) : null;
  }
  const data = (error as { response?: { data?: { errorCode?: unknown; quota?: unknown } } } | null)?.response?.data;
  return data?.errorCode === QUOTA_REFUSAL_CODE ? readMonthlyUploadQuota(data.quota) : null;
}
