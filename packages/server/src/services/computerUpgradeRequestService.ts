import { and, desc, eq, gt, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { computerUpgradeRequests } from "../db/schema";
import { compareComputerVersions, computerUpgradeInstallerReportOfReceipt, isComputerSemver, parseComputerUpgradeInstallerReport, type ComputerLastUpgradeReceipt, type ComputerUpgradeDrainingMessage, type ComputerUpgradeFailureHint, type ComputerUpgradeInstallerReport } from "@botiverse/raft-shared";

/**
 * Remote upgrade v2 (task #873). One request row per web-triggered upgrade.
 * The installer guarantees success-or-rollback, so the Server keeps exactly
 * three facts: what was asked, what version the machine reported when it came
 * back, and whether it came back in time. Nothing in between is modelled.
 */

export const UPGRADE_REQUEST_DEADLINE_MS = 30 * 60 * 1000;

export type ComputerUpgradeRequestRow = typeof computerUpgradeRequests.$inferSelect;
export type ComputerUpgradeRequestOutcome = NonNullable<ComputerUpgradeRequestRow["outcome"]>;

export interface ComputerUpgradeRequestProjection {
  id: string;
  targetVersion: string;
  requestedAt: string;
  state: "pending" | ComputerUpgradeRequestOutcome;
  observedVersion: string | null;
  reason: string | null;
  resolvedAt: string | null;
  failureHint: ComputerUpgradeFailureHint | null;
  /**
   * When the Server settles the request as no_response if the Computer has
   * not come back (ISO). Includes the drain wait (reconciler step 13), so the
   * web follows it instead of assuming UPGRADE_REQUEST_DEADLINE_MS.
   */
  deadlineAt: string;
  /**
   * Reconciler step 13, only on a pending request whose Computer drains
   * (`computer:upgrade:draining`): `draining` while its agents finish their
   * work, `installing` once the drain is over. Absent: the generic copy.
   */
  phase?: "draining" | "installing";
  /** The agents still finishing their work (bounded), while `draining`. */
  drainingAgentIds?: string[];
  /** When the drain stops waiting (ISO). */
  drainDeadlineAt?: string;
  /**
   * On a request that failed at a download step (UPGRADE_AUTO_RETRY_FAILURE_CODES):
   * `scheduled` until the Server sends the same request once more by itself
   * (`dueAt`), then `retried` or `skipped` (`skipReason`). Absent: no
   * automatic retry applies.
   */
  autoRetry?: ComputerUpgradeAutoRetryProjection;
  /** Set on a request the Server sent by itself: the failed request it retries. */
  autoRetryOfRequestId?: string;
}

export type ComputerUpgradeAutoRetryProjection =
  | { state: "scheduled"; dueAt: string }
  | { state: "retried" }
  | { state: "skipped"; skipReason: string };

/** The Computer's latest drain report for a request (kept on its connection). */
export type ComputerUpgradeDrainProgress = Omit<ComputerUpgradeDrainingMessage, "type">;

export function projectComputerUpgradeRequest(row: ComputerUpgradeRequestRow, drain?: ComputerUpgradeDrainProgress | null, now: Date = new Date()): ComputerUpgradeRequestProjection {
  const drainApplies = Boolean(drain) && drain!.requestId === row.id && row.outcome === null;
  return {
    id: row.id,
    targetVersion: row.targetVersion,
    requestedAt: row.requestedAt.toISOString(),
    state: row.outcome ?? "pending",
    observedVersion: row.observedVersion,
    // The drain-finished marker is internal state, not a failure reason.
    reason: row.reason === UPGRADE_REQUEST_DRAIN_FINISHED_MARKER ? null : row.reason,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    failureHint: row.outcome === "failed" ? upgradeFailureHintFromReason(row.reason) : null,
    deadlineAt: row.deadlineAt.toISOString(),
    ...(drainApplies
      ? {
          phase: drain!.finished ? "installing" as const : "draining" as const,
          drainingAgentIds: drain!.finished ? [] : drain!.notQuietAgentIds,
          drainDeadlineAt: drain!.deadlineAt,
        }
      : {}),
    ...autoRetryProjection(row, now),
    ...(row.autoRetryOfRequestId ? { autoRetryOfRequestId: row.autoRetryOfRequestId } : {}),
  };
}

function autoRetryProjection(row: ComputerUpgradeRequestRow, now: Date): { autoRetry?: ComputerUpgradeAutoRetryProjection } {
  if (!row.autoRetryFailureCode || !row.autoRetryDueAt) return {};
  if (row.autoRetryResult === UPGRADE_AUTO_RETRY_RETRIED) return { autoRetry: { state: "retried" } };
  if (row.autoRetryResult) return { autoRetry: { state: "skipped", skipReason: row.autoRetryResult } };
  // Claimed and not recorded within the grace: the claiming replica died or
  // failed (the sweep records `abandoned`); never "will try once more" forever.
  if (row.autoRetryClaimedAt && now.getTime() - row.autoRetryClaimedAt.getTime() >= UPGRADE_AUTO_RETRY_ABANDON_MS) {
    return { autoRetry: { state: "skipped", skipReason: "abandoned" } };
  }
  // Claimed and not yet recorded: still on its way (the claiming replica is sending it).
  return { autoRetry: { state: "scheduled", dueAt: row.autoRetryDueAt.toISOString() } };
}

/**
 * Reconciler step 13: the deadline of a request whose Computer drains first.
 * The drain runs before the installer, so the request waits for it on top of
 * the usual UPGRADE_REQUEST_DEADLINE_MS.
 */
export function computerUpgradeRequestDeadlineMs(drainMs: number | null): number {
  return UPGRADE_REQUEST_DEADLINE_MS + Math.max(0, drainMs ?? 0);
}

// One shell-safe token the web puts into `systemctl stop <unit>`: no leading
// "-" (an option) and no "\\" (escaped names lose it when pasted unquoted);
// such names get the generic text.
const SYSTEMD_UNIT_NAME = String.raw`[A-Za-z0-9_][A-Za-z0-9:_.@-]*\.(?:service|scope)`;
// computer externalSupervisor.ts describeKillModeRequirement (the same text
// since Computer 1.0.48): "The Computer service runs under systemd unit
// <unit> with KillMode=<mode>. …", refused before the installer starts.
const UNSAFE_KILL_MODE_REASON = new RegExp(String.raw`runs under systemd unit (${SYSTEMD_UNIT_NAME}) with KillMode=([a-z-]+)\.`, "u");
// Installer (0.3.21+) systemd.rs confinement_reason, an `installation_held`
// receipt: "The Computer service runs in systemd unit <unit>, which would stop
// the upgrade together with the service, and the upgrade could not move out of
// it. Upgrade from the host: `systemctl [--user] stop <unit>`, …".
const CONFINED_IN_UNIT_REASON = new RegExp(String.raw`runs in systemd unit (${SYSTEMD_UNIT_NAME}), which would stop the upgrade together with the service`, "u");

/**
 * Installer receipt codes (raft-computer-installer#82, rust/report.rs
 * FailureCode) the Server keeps as the class of a failed request's stored
 * reason, `<code>: <reason>` (as UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX),
 * read from the receipt's own `code` (`installerCode` on
 * `computer:upgrade:done`, `code` on `ready.lastUpgradeReceipt`):
 *   earlier_recovery_pending — the installer refused because an EARLIER
 *     installation is unresolved; this request changed nothing and no later
 *     worker continues it (outcome failed, exit 1). Settled failed at once,
 *     with the repair hint (failureHint `earlier_recovery_pending`).
 *   candidate_check_timed_out / candidate_check_failed — the downloaded
 *     version did not answer, or failed, its first `--version` check;
 *     nothing was stopped or replaced.
 *   download_stalled — the download of the Computer artifact stopped
 *     receiving data (raft-computer-installer#85; before it, `install_failed`
 *     with the engine's `DOWNLOAD_FAILED: idle timeout`); nothing changed.
 *     Retried once like DOWNLOAD_FAILED (INSTALLER_RECEIPT_RETRY_CODES).
 */
export const INSTALLER_REASON_CLASS_CODES = ["earlier_recovery_pending", "candidate_check_timed_out", "candidate_check_failed", "download_stalled"] as const;
export type InstallerReasonClassCode = (typeof INSTALLER_REASON_CLASS_CODES)[number];

// FALLBACK ONLY, for Computers before the fixed fields (1.25.3 and older send
// no `installerCode`) running an installer from raft-computer-installer#82 on:
// the installer's fixed reason texts for the same codes (rust/report.rs
// EARLIER_RECOVERY_PENDING_REASON, rust/operation.rs candidate_check_copy,
// DOWNLOAD_STALLED_REASON).
// A code, when sent, always decides first. Remove once the minimum
// web-upgradable Computer (COMPUTER_REMOTE_UPGRADE_MIN_VERSION) is 1.25.4,
// the first to send `installerCode`, and requests settled before then no
// longer matter (they then read as `other` / no hint).
const INSTALLER_REASON_CLASS_TEXTS: ReadonlyArray<[InstallerReasonClassCode, RegExp]> = [
  ["earlier_recovery_pending", /\bAn earlier installation on this computer is unfinished and needs a repair\b/u],
  ["candidate_check_timed_out", /\bdid not answer its first check in time\b/u],
  ["candidate_check_failed", /\bfailed its first check\b/u],
  ["download_stalled", /\bThe Raft Computer download stopped receiving data\b/u],
];

/** The class of a stored reason: its `<code>: ` prefix, else (older Computers) the installer's fixed text, else null. */
function installerReasonClass(reason: string): InstallerReasonClassCode | null {
  const prefixed = INSTALLER_REASON_CLASS_CODES.find((code) => reason.startsWith(`${code}: `));
  if (prefixed) return prefixed;
  return INSTALLER_REASON_CLASS_TEXTS.find(([, text]) => text.test(reason))?.[0] ?? null;
}

/** The reason to store for a failed request: prefixed with the installer's code when it is one the Server classes. */
function installerClassedReason(reason: string, installer: ComputerUpgradeInstallerReport | null): string {
  const code = installer?.installerCode;
  return code && (INSTALLER_REASON_CLASS_CODES as readonly string[]).includes(code) ? `${code}: ${reason}` : reason;
}

/**
 * The failure hint a failed request's reason carries, or null. Read from the
 * stored reason: the installer code's prefix (installerClassedReason) where
 * the Computer sent one, else its text, so requests settled before this
 * existed, and older Computers, get it too.
 */
export function upgradeFailureHintFromReason(reason: string | null): ComputerUpgradeFailureHint | null {
  if (!reason) return null;
  if (reason.startsWith("earlier_recovery_pending: ")) return { reason: "earlier_recovery_pending" };
  const killMode = UNSAFE_KILL_MODE_REASON.exec(reason);
  if (killMode) return { reason: "unsafe_kill_mode", unit: killMode[1]!, killMode: killMode[2]! };
  const confined = CONFINED_IN_UNIT_REASON.exec(reason);
  if (confined) {
    const scope = reason.includes("`systemctl --user stop ") ? "user" : reason.includes("`systemctl stop ") ? "system" : null;
    return { reason: "installation_held", unit: confined[1]!, ...(scope ? { scope } : {}) };
  }
  if (installerReasonClass(reason) === "earlier_recovery_pending") return { reason: "earlier_recovery_pending" };
  return null;
}

/**
 * A reason as written to traces: the Computer's text can quote local paths
 * (installer errors name `/Users/<name>/…`), so mask the account segment of
 * home paths and keep only a short prefix. The row keeps the full reason.
 */
export function traceSafeUpgradeReason(reason: string | null | undefined): string {
  return (reason ?? "")
    .replace(/(\/Users\/|\/home\/)[^/\s]+/giu, "$1~")
    // Windows account names may contain spaces; mask up to the next separator.
    .replace(/([A-Za-z]:\\Users\\)[^\\]+/giu, "$1~")
    .slice(0, 120);
}

/**
 * `reason_code` on upgrade request traces: a fixed, countable class of the
 * stored reason (the `reason` attribute is user-facing text). Read from the
 * reason the Server stored: its own fixed reasons and prefixes (including the
 * installer codes it keeps, INSTALLER_REASON_CLASS_CODES), the
 * `installer_<outcome>` fallback for a receipt with no text (including
 * `installer_promoted`: a promoted receipt on a version other than the
 * target), and the
 * installer texts the Server already recognizes. Anything else is `other`;
 * a request with no reason (done) is "". The same on every upgrade request
 * event; a Computer's own `computer:upgrade:done` code stays in `code`.
 */
export const UPGRADE_REQUEST_REASON_CODES = [
  "reverted_after_upgrade",
  "recovery_unresolved",
  "installer_left_no_result",
  "late_after_deadline",
  "no_reconnect_before_deadline",
  "command_not_delivered",
  "installer_promoted",
  "installer_failed",
  "installer_rolled_back",
  "installer_held",
  "installer_unresolved",
  "installation_held",
  "unsafe_kill_mode",
  "candidate_start_failed",
  "earlier_recovery_pending",
  "candidate_check_timed_out",
  "candidate_check_failed",
  "download_stalled",
  "other",
] as const;
export type UpgradeRequestReasonCode = (typeof UPGRADE_REQUEST_REASON_CODES)[number];

// Installer text of a `candidate_start_failed` rollback: "Raft Computer <v> didn't start correctly."
const CANDIDATE_START_FAILED_REASON = /\bdidn['’]t start\s+correctly\b/u;

export function upgradeRequestReasonCode(reason: string | null | undefined): UpgradeRequestReasonCode | "" {
  if (!reason) return "";
  for (const prefix of [UPGRADE_REQUEST_REVERTED_REASON_PREFIX, UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX, UPGRADE_REQUEST_NO_RESULT_REASON_PREFIX] as const) {
    if (reason === prefix || reason.startsWith(`${prefix}:`)) return prefix;
  }
  switch (reason) {
    case UPGRADE_REQUEST_LATE_REASON:
    case "no_reconnect_before_deadline":
    case "command_not_delivered":
    case "installer_promoted":
    case "installer_failed":
    case "installer_rolled_back":
    case "installer_held":
    case "installer_unresolved":
      return reason;
  }
  const hint = upgradeFailureHintFromReason(reason);
  if (hint) return hint.reason;
  const installerClass = installerReasonClass(reason);
  if (installerClass) return installerClass;
  if (CANDIDATE_START_FAILED_REASON.test(reason)) return "candidate_start_failed";
  return "other";
}

/**
 * Trace attributes for a resolved request, shared by every settle path
 * (done/failed on reconnect, refusal, undelivered, deadline) so one query can
 * group outcomes by reason and read the click-to-result duration.
 */
export function computerUpgradeRequestTraceAttrs(row: ComputerUpgradeRequestRow): Record<string, string | number> {
  return {
    request_id: row.id,
    server_id: row.serverId,
    machine_id: row.machineId,
    target_version: row.targetVersion,
    observed_version: row.observedVersion ?? "",
    outcome: row.outcome ?? "",
    reason: traceSafeUpgradeReason(row.reason),
    reason_code: upgradeRequestReasonCode(row.reason),
    ...(row.resolvedAt ? { duration_ms: Math.max(0, row.resolvedAt.getTime() - row.requestedAt.getTime()) } : {}),
    // The Server sent this request by itself (automatic = 1), retrying the linked failed one.
    ...(row.autoRetryOfRequestId ? { automatic: 1, auto_retry_of_request_id: row.autoRetryOfRequestId } : {}),
    ...(row.autoRetryFailureCode ? { auto_retry_failure_code: row.autoRetryFailureCode } : {}),
    ...(row.resolvedAt && (row.outcome === "succeeded_late" || row.reason === UPGRADE_REQUEST_LATE_REASON)
      ? { late_ms: Math.max(0, row.resolvedAt.getTime() - row.deadlineAt.getTime()) }
      : {}),
  };
}

export async function getOpenComputerUpgradeRequest(
  machineId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow | null> {
  const [row] = await executor
    .select()
    .from(computerUpgradeRequests)
    .where(and(eq(computerUpgradeRequests.machineId, machineId), isNull(computerUpgradeRequests.outcome)))
    .orderBy(desc(computerUpgradeRequests.requestedAt))
    .limit(1);
  return row ?? null;
}

/** Creates the request unless one is already open for the machine, which is returned instead. */
export async function createComputerUpgradeRequest(input: {
  serverId: string;
  machineId: string;
  targetVersion: string;
  requestedByUserId: string;
  now?: Date;
  deadlineMs?: number;
  /** The failed request this one retries: the Server sends it by itself (UPGRADE_AUTO_RETRY_DELAY_MS). */
  autoRetryOfRequestId?: string;
}, executor: DatabaseExecutor = getDb()): Promise<{ row: ComputerUpgradeRequestRow; created: boolean }> {
  const existing = await getOpenComputerUpgradeRequest(input.machineId, executor);
  if (existing) return { row: existing, created: false };
  const now = input.now ?? new Date();
  const [row] = await executor.insert(computerUpgradeRequests).values({
    serverId: input.serverId,
    machineId: input.machineId,
    targetVersion: input.targetVersion,
    requestedByUserId: input.requestedByUserId,
    requestedAt: now,
    deadlineAt: new Date(now.getTime() + (input.deadlineMs ?? UPGRADE_REQUEST_DEADLINE_MS)),
    ...(input.autoRetryOfRequestId ? { autoRetryOfRequestId: input.autoRetryOfRequestId } : {}),
  }).returning();
  return { row: row!, created: true };
}

/**
 * Stored reason prefix of an installer `unresolved` receipt (exit 3,
 * `recovery_unresolved`). A later installer worker for the same request can
 * still repair and finish the upgrade (#proj-raft-computer:#51), so before
 * the deadline the receipt is only recorded on the open request
 * (`outcome` stays null, the web keeps showing it in progress); the expiry
 * sweep settles it `failed` with this reason if no success came, and a late
 * success can still turn that into `succeeded_late`.
 */
export const UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX = "recovery_unresolved";

function unresolvedUpgradeReason(reason: string): string {
  return `${UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX}: ${reason}`;
}

/** Whether the request's reason is a recorded `unresolved` receipt. */
export function isUnresolvedUpgradeReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith(`${UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX}: `));
}

// FALLBACK ONLY (Tenny, #proj-raft-computer:#51): matching on text is
// fragile. Computers from the fixed-fields change on send the receipt's own
// code and outcome on computer:upgrade:done (`installerCode`,
// `installerOutcome`), and when they are there they alone decide: the text is
// never read, so no classification depends on a text lacking a phrase. This
// list stays for older Computers, which send only text; it is the
// `unresolved` text of installers before raft-computer-installer#82 (from #82
// on, a refusal behind an earlier installation is `earlier_recovery_pending`,
// outcome failed, whose text does not contain it). Remove once the minimum
// web-upgradable Computer (COMPUTER_REMOTE_UPGRADE_MIN_VERSION) is 1.25.4
// (fixed fields always sent) and the minimum installer is #82 or later.
// The installer's own fixed text on an `unresolved` receipt (see
// packages/computer externalInstaller.test.ts); `computer:upgrade:done`
// carries only that text, under code `upgrade_installer_failed` (daemon
// core.ts), or `installer_unresolved` when the receipt had no reason. Code
// `recovery_unresolved` is accepted too, should a Computer send it.
const UNRESOLVED_RECEIPT_TEXTS = ["An earlier installation could not be recovered", "installer_unresolved"];

/**
 * Whether a `computer:upgrade:done ok:false` reports an `unresolved` installer
 * receipt. The installer's code first (`earlier_recovery_pending`: never held
 * open, whatever else it says), then its outcome; the text only without them.
 */
export function isUnresolvedUpgradeRefusal(input: { code?: string | null; reason?: string | null; installer?: ComputerUpgradeInstallerReport | null }): boolean {
  if (input.installer?.installerCode === "earlier_recovery_pending") return false;
  if (input.code === "recovery_unresolved") return true;
  if (input.installer) return input.installer.installerCode === "recovery_unresolved" || input.installer.installerOutcome === "unresolved";
  const reason = input.reason ?? "";
  return UNRESOLVED_RECEIPT_TEXTS.some((text) => reason.includes(text));
}

/**
 * Records an `unresolved` receipt on the open request without settling it
 * (UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX). Returns the still-open row, or
 * null when the request is no longer open.
 */
async function recordUnresolvedComputerUpgradeReceipt(input: {
  requestId: string;
  machineId: string;
  reason: string;
  observedVersion: string | null;
}, executor: DatabaseExecutor): Promise<ComputerUpgradeRequestRow | null> {
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({ reason: unresolvedUpgradeReason(input.reason), observedVersion: input.observedVersion })
    .where(and(
      eq(computerUpgradeRequests.id, input.requestId),
      eq(computerUpgradeRequests.machineId, input.machineId),
      isNull(computerUpgradeRequests.outcome),
    ))
    .returning();
  return row ?? null;
}

/**
 * Marker in `reason` of an open request whose Computer's drain finished
 * (`computer:upgrade:draining` with `finished` `quiet` or `deadline`; `ended`
 * means the upgrade did not go on): the Computer service spawns the installer
 * next. The drain report itself is kept only on that connection
 * (ComputerUpgradeDrainProgress), and the `ready` after the installer comes on
 * a new one, possibly on another replica, so the fact is kept on the row.
 * Never left on a settled request: every settle path writes its own reason,
 * and the projection (projectComputerUpgradeRequest) never shows it.
 *
 * `reason` now carries two state markers (this one and
 * UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX). A third must not be added here:
 * it means adding a real `state` column to computer_upgrade_requests instead.
 */
export const UPGRADE_REQUEST_DRAIN_FINISHED_MARKER = "drain_finished";

/**
 * Stored reason prefix of a request whose Computer came back on a version
 * other than the target, with no receipt for it, after its drain finished:
 * the installer ran and no result from it reached the Server (c85f4355,
 * #proj-raft-computer:#94; a slow installer looks the same until the deadline).
 * Only recorded on the open request: a healthy installer keeps the old
 * service up for minutes, so a connection blip then reconnects on the old
 * version too. The expiry sweep settles it `failed` with this reason instead
 * of `no_response`; a late success can still turn it into `succeeded_late`.
 */
export const UPGRADE_REQUEST_NO_RESULT_REASON_PREFIX = "installer_left_no_result";

/** Whether the request's reason is a recorded "no result from the installer". */
export function isNoResultUpgradeReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith(`${UPGRADE_REQUEST_NO_RESULT_REASON_PREFIX}: `));
}

/**
 * Marks the open request: its Computer's drain finished
 * (UPGRADE_REQUEST_DRAIN_FINISHED_MARKER). Only on the request the drain was
 * for, still open and with no reason yet. Returns the marked row, or null.
 */
export async function recordComputerUpgradeDrainFinished(input: {
  requestId: string;
  machineId: string;
}, executor: DatabaseExecutor = getDb()): Promise<ComputerUpgradeRequestRow | null> {
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({ reason: UPGRADE_REQUEST_DRAIN_FINISHED_MARKER })
    .where(and(
      eq(computerUpgradeRequests.id, input.requestId),
      eq(computerUpgradeRequests.machineId, input.machineId),
      isNull(computerUpgradeRequests.outcome),
      isNull(computerUpgradeRequests.reason),
    ))
    .returning();
  return row ?? null;
}

/**
 * Records "no result from the installer" on the open request whose drain
 * finished (UPGRADE_REQUEST_NO_RESULT_REASON_PREFIX), without settling it.
 * Once: only over the drain marker. Returns the still-open row, or null.
 * The reported version enters the user-facing text only when it is a
 * Computer semver of at most 64 characters; anything else reads "its old
 * version".
 */
async function recordNoResultComputerUpgrade(
  open: ComputerUpgradeRequestRow,
  version: string,
  executor: DatabaseExecutor,
): Promise<ComputerUpgradeRequestRow | null> {
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({
      reason: `${UPGRADE_REQUEST_NO_RESULT_REASON_PREFIX}: Raft Computer came back on ${version.length <= 64 && isComputerSemver(version) ? version : "its old version"} without a result from the installer.`,
      observedVersion: version,
    })
    .where(and(
      eq(computerUpgradeRequests.id, open.id),
      isNull(computerUpgradeRequests.outcome),
      eq(computerUpgradeRequests.reason, UPGRADE_REQUEST_DRAIN_FINISHED_MARKER),
    ))
    .returning();
  return row ?? null;
}

/**
 * The only observation: the version a machine reports when it (re)connects.
 * Equal to the target → done. Different → failed, with the installer's
 * one-line reason when the successor carried a receipt; an `unresolved`
 * receipt, or no receipt after the drain finished, is only recorded and the
 * row returned still open (outcome null).
 * No open request → a revert or a late success, else nothing to do.
 */
export async function observeComputerVersionForUpgradeRequests(input: {
  machineId: string;
  reportedVersion: string | null | undefined;
  receipt?: ComputerLastUpgradeReceipt | null;
  now?: Date;
}, executor: DatabaseExecutor = getDb()): Promise<ComputerUpgradeRequestRow | LateSettledComputerUpgradeRequestRow | null> {
  const version = input.reportedVersion?.trim();
  if (!version) return null;
  const now = input.now ?? new Date();
  const open = await getOpenComputerUpgradeRequest(input.machineId, executor);
  if (!open) {
    return await revertRecentlyDoneComputerUpgradeRequest(input.machineId, version, now, executor)
      ?? settleLateComputerUpgradeRequest(input.machineId, version, now, executor);
  }
  const done = version === open.targetVersion;
  const receipt = input.receipt && input.receipt.targetVersion === open.targetVersion ? input.receipt : null;
  // A `ready` still on the old version is not, by itself, an outcome: the
  // Computer stays online while it downloads, so a connection blip during the
  // download reconnects on the old version. Only the target version or the
  // Computer's own upgrade receipt for this target settles the request; with
  // neither, it stays pending until the deadline (expireComputerUpgradeRequests).
  // Every web-upgradable Computer (COMPUTER_REMOTE_UPGRADE_MIN_VERSION; every release since 1.0.37)
  // sends `lastUpgradeReceipt` on ready. After the drain finished, though,
  // the installer ran: coming back with no receipt is recorded, for the
  // deadline to settle (UPGRADE_REQUEST_NO_RESULT_REASON_PREFIX).
  if (!done && !receipt) {
    return open.reason === UPGRADE_REQUEST_DRAIN_FINISHED_MARKER ? recordNoResultComputerUpgrade(open, version, executor) : null;
  }
  const receiptText = done ? null : receipt?.reason ?? `installer_${receipt!.outcome}`;
  if (!done && receipt?.outcome === "unresolved") {
    return recordUnresolvedComputerUpgradeReceipt({ requestId: open.id, machineId: input.machineId, reason: receiptText!, observedVersion: version }, executor);
  }
  const installer = done ? null : computerUpgradeInstallerReportOfReceipt(receipt);
  const reason = receiptText === null ? null : installerClassedReason(receiptText, installer);
  const retryCode = done ? null : upgradeAutoRetryFailureCode({
    via: "receipt",
    outcome: receipt!.outcome,
    reason: receipt!.reason ?? null,
    installer,
  });
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({
      outcome: done ? "done" : "failed",
      observedVersion: version,
      reason,
      resolvedAt: now,
      ...autoRetrySchedule(open, retryCode, now),
    })
    .where(and(eq(computerUpgradeRequests.id, open.id), isNull(computerUpgradeRequests.outcome)))
    .returning();
  return row ?? null;
}

/** After a `done` or `succeeded_late`, how long an older version reconnecting still means the upgrade did not hold. */
export const UPGRADE_REQUEST_REVERT_WINDOW_MS = 30 * 60 * 1000;
export const UPGRADE_REQUEST_REVERTED_REASON_PREFIX = "reverted_after_upgrade";

/**
 * A request is `done` as soon as the target version connects (`succeeded_late`
 * after the deadline: a late success can be rolled back just the same). If the same
 * machine reconnects below the target within UPGRADE_REQUEST_REVERT_WINDOW_MS,
 * the upgrade did not hold: the old version came back (rolled back by a late
 * recovery step, or a second Computer service on the same key never upgraded),
 * so the request becomes `failed` with `reverted_after_upgrade: <version>` and
 * the user can retry. Once only: a `failed` row is never flipped back, and the
 * window is checked in the same statement.
 */
async function revertRecentlyDoneComputerUpgradeRequest(
  machineId: string,
  version: string,
  now: Date,
  executor: DatabaseExecutor,
): Promise<ComputerUpgradeRequestRow | null> {
  if (!isComputerSemver(version)) return null;
  const [latest] = await executor
    .select()
    .from(computerUpgradeRequests)
    .where(eq(computerUpgradeRequests.machineId, machineId))
    .orderBy(desc(computerUpgradeRequests.requestedAt))
    .limit(1);
  if (!latest || (latest.outcome !== "done" && latest.outcome !== "succeeded_late") || !latest.resolvedAt) return null;
  if (!isComputerSemver(latest.targetVersion) || compareComputerVersions(version, latest.targetVersion) >= 0) return null;
  const windowStart = new Date(now.getTime() - UPGRADE_REQUEST_REVERT_WINDOW_MS);
  if (latest.resolvedAt.getTime() < windowStart.getTime()) return null;
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({ outcome: "failed", observedVersion: version, reason: `${UPGRADE_REQUEST_REVERTED_REASON_PREFIX}: ${version}`, resolvedAt: now })
    .where(and(
      eq(computerUpgradeRequests.id, latest.id),
      eq(computerUpgradeRequests.outcome, latest.outcome),
      gte(computerUpgradeRequests.resolvedAt, windowStart),
    ))
    .returning();
  return row ?? null;
}

/** How long after its deadline a `no_response` request can still be settled as a late success. */
export const UPGRADE_REQUEST_LATE_SETTLE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The same for a request the deadline settled `failed` from a recorded
 * `unresolved` receipt (a recorded "no result from the installer" keeps the
 * no_response window, the outcome it replaces): shorter, as the late success must come from that
 * request's own installer workers (Tenny, #proj-raft-computer:#51).
 */
export const UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS = 2 * 60 * 60 * 1000;
export const UPGRADE_REQUEST_LATE_REASON = "late_after_deadline";

/** A late success, with the outcome the deadline had given the request (for traces: it replaces that one). */
export type LateSettledComputerUpgradeRequestRow = ComputerUpgradeRequestRow & { replacedOutcome: "no_response" | "failed" };

/**
 * The machine came back on the target only after the deadline (a slow
 * installer, a later installer worker that repaired an `unresolved` one, or
 * the user upgraded by hand): the latest request, when it expired as
 * `no_response`, or `failed` from a recorded `unresolved` receipt or a
 * recorded "no result from the installer" for that target, becomes
 * `succeeded_late` (reason UPGRADE_REQUEST_LATE_REASON), so the failure rate
 * counts only upgrades that never happened. Only within
 * UPGRADE_REQUEST_LATE_SETTLE_MS (no_response, no result) or
 * UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS (unresolved) of the deadline, and once (the outcome is
 * checked in the same statement). `deadlineAt` stays, so lateness is
 * `resolvedAt - deadlineAt`.
 */
async function settleLateComputerUpgradeRequest(
  machineId: string,
  version: string,
  now: Date,
  executor: DatabaseExecutor,
): Promise<LateSettledComputerUpgradeRequestRow | null> {
  const [latest] = await executor
    .select()
    .from(computerUpgradeRequests)
    .where(eq(computerUpgradeRequests.machineId, machineId))
    .orderBy(desc(computerUpgradeRequests.requestedAt))
    .limit(1);
  if (!latest || latest.targetVersion !== version) return null;
  const unresolved = latest.outcome === "failed" && isUnresolvedUpgradeReason(latest.reason);
  const replacedOutcome = latest.outcome === "no_response"
    ? "no_response" as const
    : unresolved || (latest.outcome === "failed" && isNoResultUpgradeReason(latest.reason)) ? "failed" as const : null;
  if (!replacedOutcome) return null;
  const window = unresolved ? UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS : UPGRADE_REQUEST_LATE_SETTLE_MS;
  if (now.getTime() - latest.deadlineAt.getTime() > window) return null;
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({ outcome: "succeeded_late", observedVersion: version, reason: UPGRADE_REQUEST_LATE_REASON, resolvedAt: now })
    .where(and(
      eq(computerUpgradeRequests.id, latest.id),
      eq(computerUpgradeRequests.outcome, replacedOutcome),
      // The reason read above, so a re-settle in between is not overwritten.
      latest.reason === null ? isNull(computerUpgradeRequests.reason) : eq(computerUpgradeRequests.reason, latest.reason),
    ))
    .returning();
  return row ? { ...row, replacedOutcome } : null;
}

/**
 * The upgrade command never reached the machine (it went offline between the
 * route's check and the send, or this replica had no route to it). Settle the
 * request now: nothing is running on the machine, and an open row would hold
 * every retry (`created: false`, nothing sent) until the deadline.
 */
export async function failUndeliveredComputerUpgradeRequest(
  requestId: string,
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow | null> {
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({ outcome: "failed", reason: "command_not_delivered", resolvedAt: now })
    .where(and(eq(computerUpgradeRequests.id, requestId), isNull(computerUpgradeRequests.outcome)))
    .returning();
  return row ?? null;
}

/**
 * The Computer refused this request before any installer ran
 * (`computer:upgrade:done` with `ok: false`). Settled by request id, and only for the machine
 * that sent it: with the same key online twice (#374) the other daemon cannot
 * settle a request that is not its own. `observedVersion`: the version the
 * reporting connection runs, so a later version tells the failure is stale.
 * An `unresolved` installer receipt (isUnresolvedUpgradeRefusal) is only
 * recorded: the row comes back still open (outcome null).
 */
export async function settleRefusedComputerUpgradeRequest(input: {
  machineId: string;
  requestId: string;
  reason: string;
  code?: string | null;
  /**
   * The message's `installerOutcome` / `installerCode` /
   * `installerDiagnosticCode` as received; validated here
   * (parseComputerUpgradeInstallerReport), anything else is ignored.
   */
  installer?: { installerOutcome?: unknown; installerCode?: unknown; installerDiagnosticCode?: unknown } | null;
  observedVersion?: string | null;
  now?: Date;
}, executor: DatabaseExecutor = getDb()): Promise<ComputerUpgradeRequestRow | null> {
  const reason = input.reason.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 512) || "computer_refused";
  const installer = parseComputerUpgradeInstallerReport(input.installer);
  if (isUnresolvedUpgradeRefusal({ code: input.code, reason, installer })) {
    return recordUnresolvedComputerUpgradeReceipt({
      requestId: input.requestId,
      machineId: input.machineId,
      reason,
      observedVersion: input.observedVersion?.trim() || null,
    }, executor);
  }
  const now = input.now ?? new Date();
  const retryCode = upgradeAutoRetryFailureCode({ via: "upgrade_done", code: input.code ?? null, reason, installer });
  // Whether this request may be retried at all (not itself a retry) is read
  // in the same statement: only a request the person asked for is scheduled.
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({
      outcome: "failed",
      reason: installerClassedReason(reason, installer),
      observedVersion: input.observedVersion?.trim() || null,
      resolvedAt: now,
      ...(retryCode
        ? {
            autoRetryFailureCode: sql`CASE WHEN ${computerUpgradeRequests.autoRetryOfRequestId} IS NULL THEN ${retryCode} ELSE NULL END`,
            autoRetryDueAt: sql`CASE WHEN ${computerUpgradeRequests.autoRetryOfRequestId} IS NULL THEN ${new Date(now.getTime() + UPGRADE_AUTO_RETRY_DELAY_MS).toISOString()}::timestamptz ELSE NULL END`,
          }
        : {}),
    })
    .where(and(
      eq(computerUpgradeRequests.id, input.requestId),
      eq(computerUpgradeRequests.machineId, input.machineId),
      isNull(computerUpgradeRequests.outcome),
    ))
    .returning();
  return row ?? null;
}

/**
 * Requests with no success before the deadline: `failed` with the recorded
 * reason when an `unresolved` receipt came or no result came from the installer,
 * otherwise `no_response` (a drain marker alone included: the Computer never
 * came back).
 */
export async function expireComputerUpgradeRequests(
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow[]> {
  const expiredOpen = and(isNull(computerUpgradeRequests.outcome), lte(computerUpgradeRequests.deadlineAt, now));
  // `_` is a LIKE wildcard; escape it (backslash is Postgres' default escape).
  const recordedPattern = (prefix: string) => like(computerUpgradeRequests.reason, `${prefix.replace(/_/gu, "\\_")}: %`);
  const failed = await executor
    .update(computerUpgradeRequests)
    .set({ outcome: "failed", resolvedAt: now })
    .where(and(expiredOpen, or(recordedPattern(UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX), recordedPattern(UPGRADE_REQUEST_NO_RESULT_REASON_PREFIX))))
    .returning();
  // Every other open row past its deadline (the ones above are no longer open).
  const noResponse = await executor
    .update(computerUpgradeRequests)
    .set({ outcome: "no_response", reason: "no_reconnect_before_deadline", resolvedAt: now })
    .where(expiredOpen)
    .returning();
  return [...failed, ...noResponse];
}

/** Latest request per machine (open first, otherwise the most recent resolved one). */
export async function listLatestComputerUpgradeRequests(
  machineIds: string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, ComputerUpgradeRequestRow>> {
  const result = new Map<string, ComputerUpgradeRequestRow>();
  if (machineIds.length === 0) return result;
  const rows = await executor
    .select()
    .from(computerUpgradeRequests)
    .where(inArray(computerUpgradeRequests.machineId, machineIds))
    .orderBy(desc(computerUpgradeRequests.requestedAt));
  for (const row of rows) {
    const current = result.get(row.machineId);
    if (!current) { result.set(row.machineId, row); continue; }
    if (current.outcome !== null && row.outcome === null) result.set(row.machineId, row);
  }
  return result;
}

// ---------------------------------------------------------------------------
// One automatic retry after a download-step failure.
//
// Production (AndyLok, 11-14): 6 of 7 Computers whose web upgrade failed on a
// download timeout were never upgraded again. The Server sends the same
// request (same target) once more by itself, UPGRADE_AUTO_RETRY_DELAY_MS after
// the failure, when the Computer's report says the failure was in the version
// lookup or a download, before anything on the machine changed.
//
// What the Server receives (it never sees the Computer's step trace, which
// goes to telemetry only):
//   - `computer:upgrade:done ok:false`: the daemon's closed `code`
//     (packages/daemon core.ts: control_busy, self_relaunch_unavailable,
//     upgrade_start_rejected, upgrade_installer_failed, computer_control_failed;
//     upgrade_rolled_back from the late-receipt watch) and the error text,
//     which starts with the Computer's or the installer's fixed code; for an
//     installer receipt, from Computers with this change on, also the
//     receipt's outcome and fixed codes (`installerOutcome`, `installerCode`,
//     `installerDiagnosticCode`: ComputerUpgradeInstallerReport);
//   - `ready.lastUpgradeReceipt`: the installer receipt's outcome
//     (promoted | rolled_back | failed | held | unresolved) and its reason;
//     from the same Computers also its `code` and `diagnosticCode`.
// When the installer's fixed fields are there they alone decide
// (installerReportRetryCode). Otherwise (older Computers) the leading fixed
// code of the text decides: the same token the Computer itself records as the
// failed step's `errorCode` (remoteUpgradeTrace.ts upgradeErrorCode); only an
// exact, anchored match of a listed code counts, never a phrase inside the text.
// ---------------------------------------------------------------------------

/** How long after the failure the Server sends the request once more. */
export const UPGRADE_AUTO_RETRY_DELAY_MS = 10 * 60 * 1000;
/**
 * A due retry is sent by the replica its Computer is connected to. One not
 * claimed this long after it was due (the Computer stayed offline) is skipped
 * as `computer_offline` by any replica.
 */
export const UPGRADE_AUTO_RETRY_OFFLINE_GRACE_MS = 30 * 60 * 1000;
/**
 * A claimed retry with no result this long after the claim: the claiming
 * replica died or failed between the claim and recording the result. The
 * sweep records `abandoned`; the projection shows it skipped before that.
 */
export const UPGRADE_AUTO_RETRY_ABANDON_MS = 5 * 60 * 1000;

/**
 * The closed allow-list (the value recorded in `auto_retry_failure_code`).
 * Each is a failure before anything on the machine changed:
 *   release_resolution_failed — the installer could not resolve the requested
 *     release (its own version lookup at hands.build): receipt outcome
 *     `failed`, code `release_resolution_failed` (raft-computer-installer
 *     rust/operation.rs, the manifest lookup before any download). Only from
 *     the fixed fields (installerReportRetryCode).
 *   installer_release_unavailable — the Computer could not look up the
 *     installer release at hands.build (packages/computer externalInstaller.ts
 *     installerCommand → withNetworkRetry; network error, timeout, HTTP
 *     status), traced as step `download` failed (service.ts launch(), before
 *     `download.resolved`). Arrives as done code `computer_control_failed`.
 *   installer_download_failed — the Computer could not download the installer
 *     or its checksums (externalInstaller.ts download/downloadOnce; e.g.
 *     `installer_download_failed: TimeoutError`), same step and same code.
 *   DOWNLOAD_FAILED — the installer's download of the Computer artifact timed
 *     out or got a bad response: the update engine (k-carrier artifact.rs)
 *     emits `DOWNLOAD_FAILED: …` only for timeouts, an HTTP status,
 *     Content-Range, gzip and data-URL errors. A connect failure or a reset
 *     mid-stream carries the HTTP client's text with no such token and is not
 *     retried. The engine fails an operation only before the handover, so
 *     nothing changed. The
 *     installer's receipt says so as outcome `failed`, code `install_failed`
 *     and the engine's error in `detail.diagnostic` (rust/operation.rs), sent
 *     as installerDiagnosticCode `DOWNLOAD_FAILED`. From older Computers,
 *     only a text that starts with it: done code `upgrade_installer_failed`
 *     (service.ts relays the receipt as `UPGRADE_INSTALLER_FAILED: <reason>`)
 *     or a `failed` ready receipt.
 *   download_stalled — the same artifact download, ended because it stopped
 *     receiving data: from raft-computer-installer#85 the receipt's own code
 *     (outcome `failed`), whatever the diagnostic code (DOWNLOAD_FAILED or
 *     none: the code alone says what happened). Before it, the
 *     same stall was `install_failed` + DOWNLOAD_FAILED. Only from the fixed
 *     fields: an older Computer relays only the installer's text, which was
 *     never retried.
 * Not listed, on purpose: the other download-step codes (installer_download_too_large,
 * installer_checksum_mismatch, invalid_installer_checksum,
 * invalid_immutable_installer_release, unsupported_installer_target,
 * invalid_installer_download_base: the same bytes or config fail again),
 * anything after the spawn, a rollback, a held or unresolved receipt, a
 * missing code, `install_failed` without a DOWNLOAD_FAILED diagnostic (a
 * verify or prepare failure: SHA256_MISMATCH, SIZE_MISMATCH, ...), and from an
 * older Computer the installer's own version-lookup failure, which reaches the
 * Server only as free text without a fixed code.
 */
export const UPGRADE_AUTO_RETRY_FAILURE_CODES = [
  "release_resolution_failed",
  "installer_release_unavailable",
  "installer_download_failed",
  "DOWNLOAD_FAILED",
  "download_stalled",
] as const;
export type UpgradeAutoRetryFailureCode = (typeof UPGRADE_AUTO_RETRY_FAILURE_CODES)[number];

/** Why a scheduled retry was not sent (or did not reach the Computer), recorded in `auto_retry_result`. */
export const UPGRADE_AUTO_RETRY_SKIP_REASONS = [
  "already_on_target",
  "superseded",
  "target_withdrawn",
  // The broadcast policy could not be read at retry time (Hands unavailable).
  "policy_unavailable",
  "not_permitted",
  "not_a_computer",
  "computer_offline",
  "original_changed",
  // The retry request was made but the command did not reach the Computer (settled `command_not_delivered`).
  "not_delivered",
  // The re-checks or the send threw; the error is in the server log.
  "failed_internal",
  // Claimed, then nothing recorded within UPGRADE_AUTO_RETRY_ABANDON_MS.
  "abandoned",
] as const;
export type UpgradeAutoRetrySkipReason = (typeof UPGRADE_AUTO_RETRY_SKIP_REASONS)[number];
export const UPGRADE_AUTO_RETRY_RETRIED = "retried";

const COMPUTER_DOWNLOAD_CODES: ReadonlySet<string> = new Set(["installer_release_unavailable", "installer_download_failed"]);
const INSTALLER_RELAY_PREFIX = "UPGRADE_INSTALLER_FAILED: ";

/** The fixed code a report's text starts with (`<code>: …` or the bare code), else null. */
function leadingFailureCode(text: string | null | undefined): string | null {
  return /^([A-Za-z][A-Za-z0-9_]*)(?::|$)/u.exec(text ?? "")?.[1] ?? null;
}

/**
 * The installer receipt's fixed fields that qualify a retry: outcome `failed`
 * (never rolled_back, held or unresolved) and one of these (installer code,
 * engine diagnostic code) pairs, confirmed in raft-computer-installer
 * rust/operation.rs; `null` = any diagnostic.
 */
const INSTALLER_RECEIPT_RETRY_CODES: ReadonlyArray<{ code: string; diagnosticCode: string | null; retry: UpgradeAutoRetryFailureCode }> = [
  { code: "release_resolution_failed", diagnosticCode: null, retry: "release_resolution_failed" },
  { code: "install_failed", diagnosticCode: "DOWNLOAD_FAILED", retry: "DOWNLOAD_FAILED" },
  { code: "download_stalled", diagnosticCode: null, retry: "download_stalled" },
];

/** The allow-listed code for an installer receipt reported as fixed fields, or null. */
export function installerReportRetryCode(report: ComputerUpgradeInstallerReport): UpgradeAutoRetryFailureCode | null {
  if (report.installerOutcome !== "failed") return null;
  return INSTALLER_RECEIPT_RETRY_CODES.find((entry) =>
    entry.code === report.installerCode
    && (entry.diagnosticCode === null || entry.diagnosticCode === report.installerDiagnosticCode))?.retry ?? null;
}

/**
 * The allow-listed code that makes a failed request retried once, or null.
 * With the installer's fixed fields (`installer`, already validated), they
 * alone decide (installerReportRetryCode). Without (older Computers):
 * `upgrade_done`: the daemon's code decides which text is read and how;
 * `receipt`: only a plain `failed` installer outcome.
 */
export function upgradeAutoRetryFailureCode(input:
  | { via: "upgrade_done"; code: string | null; reason: string | null; installer?: ComputerUpgradeInstallerReport | null }
  | { via: "receipt"; outcome: ComputerLastUpgradeReceipt["outcome"]; reason: string | null; installer?: ComputerUpgradeInstallerReport | null },
): UpgradeAutoRetryFailureCode | null {
  if (input.installer) return installerReportRetryCode(input.installer);
  if (input.via === "receipt") {
    if (input.outcome !== "failed") return null;
    return leadingFailureCode(input.reason) === "DOWNLOAD_FAILED" ? "DOWNLOAD_FAILED" : null;
  }
  const reason = input.reason ?? "";
  switch (input.code) {
    case "computer_control_failed": {
      // The Computer's own launch error, unwrapped (IPC keeps the message).
      const code = leadingFailureCode(reason);
      return code && COMPUTER_DOWNLOAD_CODES.has(code) ? code as UpgradeAutoRetryFailureCode : null;
    }
    case "upgrade_installer_failed": {
      // The installer's receipt relayed by the launching runner.
      if (!reason.startsWith(INSTALLER_RELAY_PREFIX)) return null;
      return leadingFailureCode(reason.slice(INSTALLER_RELAY_PREFIX.length)) === "DOWNLOAD_FAILED" ? "DOWNLOAD_FAILED" : null;
    }
    default:
      return null;
  }
}

/** The columns that schedule the retry on a failing request; none for a request that is itself a retry. */
function autoRetrySchedule(
  row: ComputerUpgradeRequestRow,
  code: UpgradeAutoRetryFailureCode | null,
  now: Date,
): Partial<Pick<ComputerUpgradeRequestRow, "autoRetryFailureCode" | "autoRetryDueAt">> {
  if (!code || row.autoRetryOfRequestId) return {};
  return { autoRetryFailureCode: code, autoRetryDueAt: new Date(now.getTime() + UPGRADE_AUTO_RETRY_DELAY_MS) };
}

/**
 * Claims the due retries of the given machines (those connected to this
 * replica), each exactly once across replicas and restarts: one UPDATE that
 * sets `auto_retry_claimed_at` only where it is still null. A claimed row is
 * never claimed again; a replica that dies between the claim and the send
 * leaves it claimed with no result (no second retry).
 */
export async function claimDueComputerUpgradeAutoRetries(
  machineIds: string[],
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow[]> {
  if (machineIds.length === 0) return [];
  return executor
    .update(computerUpgradeRequests)
    .set({ autoRetryClaimedAt: now })
    .where(and(
      inArray(computerUpgradeRequests.machineId, machineIds),
      isNull(computerUpgradeRequests.autoRetryClaimedAt),
      lte(computerUpgradeRequests.autoRetryDueAt, now),
    ))
    .returning();
}

/**
 * Due retries no replica claimed within UPGRADE_AUTO_RETRY_OFFLINE_GRACE_MS:
 * the Computer stayed offline. Claimed and skipped in the same statement.
 */
export async function skipOfflineComputerUpgradeAutoRetries(
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow[]> {
  return executor
    .update(computerUpgradeRequests)
    .set({ autoRetryClaimedAt: now, autoRetryResult: "computer_offline" satisfies UpgradeAutoRetrySkipReason, ...touchChangeLog() })
    .where(and(
      isNull(computerUpgradeRequests.autoRetryClaimedAt),
      lte(computerUpgradeRequests.autoRetryDueAt, new Date(now.getTime() - UPGRADE_AUTO_RETRY_OFFLINE_GRACE_MS)),
    ))
    .returning();
}

/**
 * Claimed retries with no result UPGRADE_AUTO_RETRY_ABANDON_MS after the
 * claim (the claiming replica died or failed in between): recorded
 * `abandoned`, by any replica. Never sent again.
 */
export async function settleAbandonedComputerUpgradeAutoRetries(
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow[]> {
  return executor
    .update(computerUpgradeRequests)
    .set({ autoRetryResult: "abandoned" satisfies UpgradeAutoRetrySkipReason, ...touchChangeLog() })
    .where(and(
      isNull(computerUpgradeRequests.autoRetryResult),
      lte(computerUpgradeRequests.autoRetryClaimedAt, new Date(now.getTime() - UPGRADE_AUTO_RETRY_ABANDON_MS)),
    ))
    .returning();
}

/**
 * `observed_version = observed_version` in every write of a result: the
 * change-log trigger (change_log_computer_upgrade_requests) fires only on
 * outcome, resolved_at and observed_version; assigning observed_version
 * makes a retry result reach delta-synced clients. When this table next gets
 * a migration, add auto_retry_result to the trigger's column list and remove
 * this touch.
 */
const touchChangeLog = () => ({ observedVersion: sql<string | null>`${computerUpgradeRequests.observedVersion}` });

/** Records what came of a claimed retry on the failed request; once. */
export async function recordComputerUpgradeAutoRetryResult(
  requestId: string,
  result: UpgradeAutoRetrySkipReason | typeof UPGRADE_AUTO_RETRY_RETRIED,
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow | null> {
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({ autoRetryResult: result, ...touchChangeLog() })
    .where(and(eq(computerUpgradeRequests.id, requestId), isNull(computerUpgradeRequests.autoRetryResult)))
    .returning();
  return row ?? null;
}

/**
 * The re-checks that need only the request rows: the original is still the
 * failed request it was, and no other upgrade request for the machine was
 * made after it (by a person, or open now). The rest (version, target,
 * permission) need the live Computer and policy; the caller checks those.
 */
export async function computerUpgradeAutoRetryRowSkip(
  original: ComputerUpgradeRequestRow,
  executor: DatabaseExecutor = getDb(),
): Promise<UpgradeAutoRetrySkipReason | null> {
  if (original.outcome !== "failed" || original.autoRetryOfRequestId) return "original_changed";
  const [later] = await executor
    .select({ id: computerUpgradeRequests.id })
    .from(computerUpgradeRequests)
    .where(and(
      eq(computerUpgradeRequests.machineId, original.machineId),
      ne(computerUpgradeRequests.id, original.id),
      gt(computerUpgradeRequests.requestedAt, original.requestedAt),
    ))
    .limit(1);
  if (later) return "superseded";
  const open = await getOpenComputerUpgradeRequest(original.machineId, executor);
  return open ? "superseded" : null;
}

/** Whether the Computer already runs the target (or newer). */
export function computerReachedUpgradeTarget(reportedVersion: string | null | undefined, targetVersion: string): boolean {
  const version = reportedVersion?.trim();
  if (!version) return false;
  if (version === targetVersion) return true;
  if (!isComputerSemver(version) || !isComputerSemver(targetVersion)) return false;
  return compareComputerVersions(version, targetVersion) >= 0;
}

/** What the retry needs from the live Computer and the policy; the orchestrator supplies them. */
export interface ComputerUpgradeAutoRetryDeps {
  /** The version the connected Computer reports now. */
  readComputerVersion(machineId: string): Promise<string | null>;
  /**
   * Whether `targetVersion` is still the upgrade offered to this Computer:
   * the same broadcast policy the request endpoint evaluates, asked for that
   * exact target. `offered`: eligible with that target. `policy_unavailable`:
   * the policy could not be read now (Hands unavailable). Otherwise
   * `target_withdrawn` (withdrawn, held, a newer release, not eligible).
   */
  checkTarget(original: ComputerUpgradeRequestRow): Promise<"offered" | "target_withdrawn" | "policy_unavailable">;
  /**
   * The request endpoint's checks for the person who asked
   * (computerControlAuthorization computerControlRefusal): null when allowed.
   */
  controlRefusal(original: ComputerUpgradeRequestRow, userId: string): Promise<"not_permitted" | "not_a_computer" | null>;
  /** The drain wait the endpoint would give a new request (computerUpgradeDrainMs). */
  drainMs(machineId: string): Promise<number | null>;
  /** Sends the command over the Computer's connection (sendComputerUpgrade). */
  send(machineId: string, targetVersion: string, requestId: string, drainMs: number | null): Promise<boolean>;
}

export interface ComputerUpgradeAutoRetryOutcome {
  /** The failed request, with `auto_retry_result` recorded (null if another writer recorded it first). */
  original: ComputerUpgradeRequestRow | null;
  result: UpgradeAutoRetrySkipReason | typeof UPGRADE_AUTO_RETRY_RETRIED;
  /** The request the Server sent by itself, when `retried` (or made but `not_delivered`). */
  retry: ComputerUpgradeRequestRow | null;
  /** The retry could not be delivered after it was made: settled `command_not_delivered`. */
  undelivered?: boolean;
}

/**
 * Runs one claimed retry (claimDueComputerUpgradeAutoRetries): the re-checks
 * at send time, then the same request again (same target, same person),
 * marked automatic and linked to the failed one. A retry is never scheduled
 * for a retry, so one failed request gets at most one automatic retry.
 */
export async function runClaimedComputerUpgradeAutoRetry(
  claimed: ComputerUpgradeRequestRow,
  deps: ComputerUpgradeAutoRetryDeps,
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeAutoRetryOutcome> {
  const skip = async (result: UpgradeAutoRetrySkipReason): Promise<ComputerUpgradeAutoRetryOutcome> => ({
    original: await recordComputerUpgradeAutoRetryResult(claimed.id, result, executor),
    result,
    retry: null,
  });
  const rowSkip = await computerUpgradeAutoRetryRowSkip(claimed, executor);
  if (rowSkip) return skip(rowSkip);
  if (computerReachedUpgradeTarget(await deps.readComputerVersion(claimed.machineId), claimed.targetVersion)) {
    return skip("already_on_target");
  }
  if (!claimed.requestedByUserId) return skip("not_permitted");
  const refusal = await deps.controlRefusal(claimed, claimed.requestedByUserId);
  if (refusal) return skip(refusal);
  const target = await deps.checkTarget(claimed);
  if (target !== "offered") return skip(target);
  const drainMs = await deps.drainMs(claimed.machineId);
  const created = await createComputerUpgradeRequest({
      serverId: claimed.serverId,
      machineId: claimed.machineId,
      targetVersion: claimed.targetVersion,
      requestedByUserId: claimed.requestedByUserId,
      now,
      deadlineMs: computerUpgradeRequestDeadlineMs(drainMs),
      autoRetryOfRequestId: claimed.id,
    }, executor);
  // A person's request opened in between: theirs stands.
  if (!created.created) return skip("superseded");
  if (!await deps.send(claimed.machineId, created.row.targetVersion, created.row.id, drainMs)) {
    // The retry request exists (linked, automatic) but never reached the
    // Computer: settled like any undelivered request, and recorded as such.
    const failed = await failUndeliveredComputerUpgradeRequest(created.row.id, now, executor);
    const original = await recordComputerUpgradeAutoRetryResult(claimed.id, "not_delivered", executor);
    return { original, result: "not_delivered", retry: failed ?? created.row, undelivered: true };
  }
  const original = await recordComputerUpgradeAutoRetryResult(claimed.id, UPGRADE_AUTO_RETRY_RETRIED, executor);
  return { original, result: UPGRADE_AUTO_RETRY_RETRIED, retry: created.row };
}

