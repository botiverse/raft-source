// Platform entry point: the server's monthly file upload quota (Free: 100 MB a
// month; Pro and the internal plans unlimited), the one attachments count
// against, so bytes an app stores count against the same per-server, per-month
// total, and a refusal reads as the attachments' (403
// FILE_UPLOAD_QUOTA_EXCEEDED, the billing URL, the next step; for an agent on
// Free, the upgrade card it can offer, agentQuotaUpgradeHint). The usage
// ledger, plans and billing are core's.
//
// Reserve before storing, commit once the bytes are stored, release when they
// aren't: a reservation counts toward the total until it is committed or
// released, so concurrent uploads can't overrun it. Like an attachment upload
// session, the app records a reservation on a row of its own, in the
// transaction that reserves it, and settles it in the transaction that
// changes that row, so a process that dies in between leaves a record its
// cleanup releases rather than bytes held until the month ends.
import { currentDate, type PaywallHitVia, type ServerId } from "@botiverse/raft-shared";
import type { DatabaseTransaction } from "../db/index";
import type { AppPaywallHit } from "./apps";
import { agentUploadUpgradeHint } from "../services/agentUploadUpgradeHint";
import type { UpgradeCardUploadSubject } from "../services/agentUpgradeCardService";
import {
  assertFileUploadQuotaAvailable,
  buildFileUploadQuotaExceededResponse,
  FileUploadQuotaExceededError,
  finalizeFileUploadQuotaReservationInTransaction,
  releaseFileUploadQuotaReservationInTransaction,
  reserveFileUploadQuotaForSession,
  withFileUploadQuotaReservationLock,
  type FileUploadQuotaExceededResponse,
  type FileUploadQuotaRefusalReader,
  type FileUploadQuotaReservation,
} from "../services/fileUploadQuotaService";

export { FileUploadQuotaExceededError };
export type { DatabaseTransaction, FileUploadQuotaExceededResponse, FileUploadQuotaRefusalReader, FileUploadQuotaReservation as FileUploadReservation, UpgradeCardUploadSubject };

/**
 * Hold `bytes` of this month's quota and, in the same transaction (holding
 * the server's quota lock for the month), run `work` to record the
 * reservation. Throws FileUploadQuotaExceededError when they don't fit
 * (nothing reserved, `work` not run). `reservation.limited` false: the plan
 * isn't limited, nothing is held and there is nothing to record.
 */
export function reserveFileUpload<T>(
  serverId: ServerId,
  bytes: number,
  work: (tx: DatabaseTransaction, reservation: FileUploadQuotaReservation) => Promise<T>,
): Promise<T> {
  return reserveFileUploadQuotaForSession(serverId, bytes, work, currentDate());
}

/** Run `work` in a transaction holding the server's quota lock for `month`, where a recorded reservation of that month is committed or released. */
export function withFileUploadQuotaLock<T>(serverId: ServerId, month: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
  return withFileUploadQuotaReservationLock({ serverId, month, bytes: 0, limited: true }, work);
}

/** The reserved bytes were stored: they now count as used in the reservation's month. Inside withFileUploadQuotaLock. */
export function commitFileUploadInTransaction(tx: DatabaseTransaction, reservation: FileUploadQuotaReservation): Promise<void> {
  return finalizeFileUploadQuotaReservationInTransaction(tx, reservation);
}

/** The reserved bytes were not stored (failed, already there, abandoned): give them back to the reservation's month. Inside withFileUploadQuotaLock or the reserving transaction. */
export function releaseFileUploadInTransaction(tx: DatabaseTransaction, reservation: FileUploadQuotaReservation): Promise<void> {
  return releaseFileUploadQuotaReservationInTransaction(tx, reservation);
}

/** Refuse up front (throws FileUploadQuotaExceededError) when `bytes` would not fit; reserves nothing. */
export function checkFileUploadQuota(serverId: ServerId, bytes: number): Promise<void> {
  return assertFileUploadQuotaAvailable(serverId, bytes, currentDate());
}

/**
 * The attachments' 403 body for a refusal: message, errorCode, quota, billing
 * URL and next step, worded for `reader` (an agent: say why the file wasn't
 * uploaded, a server owner can look at Settings > Billing; a person: ask a
 * server owner to upgrade).
 */
export function fileUploadQuotaExceededResponse(serverId: ServerId, error: FileUploadQuotaExceededError, reader: FileUploadQuotaRefusalReader): Promise<FileUploadQuotaExceededResponse> {
  return buildFileUploadQuotaExceededResponse(serverId, error, reader);
}

/**
 * The upgrade-card offer for an agent's write this refusal refused, in
 * conversation `channelId` of the agent's server, as an agent's attachment
 * upload over the quota gets it (agentUploadUpgradeHint), its lead naming
 * `subject` (what was refused: `files` "The files were not stored", …): the
 * next action to give instead of the billing line, or null where there is none
 * (not Free; a shared, task or unseen conversation; the conversation's
 * cooldown; an agent whose Computer runs a CLI older than the card, as an app
 * gets no request capabilities). Never throws: a failed
 * lookup is logged and is no card, so the refusal keeps its own next action.
 */
export function agentQuotaUpgradeHint(input: {
  serverId: ServerId;
  agentId: string;
  channelId: string;
  subject: UpgradeCardUploadSubject;
  error: FileUploadQuotaExceededError;
}): Promise<string | null> {
  if (input.error.summary.plan !== "free") return Promise.resolve(null);
  return agentUploadUpgradeHint({
    serverId: input.serverId,
    agentId: input.agentId,
    channelId: input.channelId,
    capabilities: undefined,
    gate: "upload_monthly_quota",
    uploadSubject: input.subject,
  });
}

/**
 * The refusal as a paywall hit (AppError.paywallHit), for core to record
 * with the answer: `via` names the write refused; the numbers are the
 * refusal's own (the bytes asked for, the month's used bytes), so nothing
 * more is read. Core decides whether it is a paywall (Free only).
 */
export function fileUploadQuotaPaywallHit(serverId: ServerId, error: FileUploadQuotaExceededError, via: PaywallHitVia): AppPaywallHit {
  return {
    gate: "upload_monthly_quota",
    via,
    serverId,
    plan: error.summary.plan,
    requestedBytes: error.requestedBytes,
    monthUsedBytes: error.summary.usedBytes,
  };
}
