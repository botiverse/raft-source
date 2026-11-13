import { and, desc, eq, gte, inArray, isNull, like, lte } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { computerUpgradeRequests } from "../db/schema";
import { compareComputerVersions, isComputerSemver, type ComputerLastUpgradeReceipt, type ComputerUpgradeDrainingMessage, type ComputerUpgradeFailureHint } from "@botiverse/raft-shared";

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
}

/** The Computer's latest drain report for a request (kept on its connection). */
export type ComputerUpgradeDrainProgress = Omit<ComputerUpgradeDrainingMessage, "type">;

export function projectComputerUpgradeRequest(row: ComputerUpgradeRequestRow, drain?: ComputerUpgradeDrainProgress | null): ComputerUpgradeRequestProjection {
  const drainApplies = Boolean(drain) && drain!.requestId === row.id && row.outcome === null;
  return {
    id: row.id,
    targetVersion: row.targetVersion,
    requestedAt: row.requestedAt.toISOString(),
    state: row.outcome ?? "pending",
    observedVersion: row.observedVersion,
    reason: row.reason,
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
  };
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
 * The failure hint a failed request's reason carries, or null. Read from the
 * stored reason text (Computers send no code for these), so requests settled
 * before this existed get it too.
 */
export function upgradeFailureHintFromReason(reason: string | null): ComputerUpgradeFailureHint | null {
  if (!reason) return null;
  const killMode = UNSAFE_KILL_MODE_REASON.exec(reason);
  if (killMode) return { reason: "unsafe_kill_mode", unit: killMode[1]!, killMode: killMode[2]! };
  const confined = CONFINED_IN_UNIT_REASON.exec(reason);
  if (confined) {
    const scope = reason.includes("`systemctl --user stop ") ? "user" : reason.includes("`systemctl stop ") ? "system" : null;
    return { reason: "installation_held", unit: confined[1]!, ...(scope ? { scope } : {}) };
  }
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
    ...(row.resolvedAt ? { duration_ms: Math.max(0, row.resolvedAt.getTime() - row.requestedAt.getTime()) } : {}),
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

// TEMPORARY (Tenny, #proj-raft-computer:#51): matching on text is fragile.
// The follow-up is the daemon forwarding the receipt's own exit-3 outcome on
// computer:upgrade:done; then this list goes.
// The installer's own fixed text on an `unresolved` receipt (see
// packages/computer externalInstaller.test.ts); `computer:upgrade:done`
// carries only that text, under code `upgrade_installer_failed` (daemon
// core.ts), or `installer_unresolved` when the receipt had no reason. Code
// `recovery_unresolved` is accepted too, should a Computer send it.
const UNRESOLVED_RECEIPT_TEXTS = ["An earlier installation could not be recovered", "installer_unresolved"];

/** Whether a `computer:upgrade:done ok:false` reports an `unresolved` installer receipt. */
export function isUnresolvedUpgradeRefusal(input: { code?: string | null; reason?: string | null }): boolean {
  if (input.code === "recovery_unresolved") return true;
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
 * The only observation: the version a machine reports when it (re)connects.
 * Equal to the target → done. Different → failed, with the installer's
 * one-line reason when the successor carried a receipt; an `unresolved`
 * receipt is only recorded and the row returned still open (outcome null).
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
  // sends `lastUpgradeReceipt` on ready.
  if (!done && !receipt) return null;
  const reason = done
    ? null
    : receipt?.reason ?? `installer_${receipt!.outcome}`;
  if (!done && receipt?.outcome === "unresolved") {
    return recordUnresolvedComputerUpgradeReceipt({ requestId: open.id, machineId: input.machineId, reason: reason!, observedVersion: version }, executor);
  }
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({
      outcome: done ? "done" : "failed",
      observedVersion: version,
      reason,
      resolvedAt: now,
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
 * `unresolved` receipt: shorter, as the late success must come from that
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
 * `no_response` or `failed` from a recorded `unresolved` receipt for that
 * target, becomes `succeeded_late` (reason UPGRADE_REQUEST_LATE_REASON), so
 * the failure rate counts only upgrades that never happened. Only within
 * UPGRADE_REQUEST_LATE_SETTLE_MS (no_response) or
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
  const replacedOutcome = latest.outcome === "no_response"
    ? "no_response" as const
    : latest.outcome === "failed" && isUnresolvedUpgradeReason(latest.reason) ? "failed" as const : null;
  if (!replacedOutcome) return null;
  const window = replacedOutcome === "no_response" ? UPGRADE_REQUEST_LATE_SETTLE_MS : UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS;
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
  observedVersion?: string | null;
  now?: Date;
}, executor: DatabaseExecutor = getDb()): Promise<ComputerUpgradeRequestRow | null> {
  const reason = input.reason.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 512) || "computer_refused";
  if (isUnresolvedUpgradeRefusal({ code: input.code, reason })) {
    return recordUnresolvedComputerUpgradeReceipt({
      requestId: input.requestId,
      machineId: input.machineId,
      reason,
      observedVersion: input.observedVersion?.trim() || null,
    }, executor);
  }
  const [row] = await executor
    .update(computerUpgradeRequests)
    .set({ outcome: "failed", reason, observedVersion: input.observedVersion?.trim() || null, resolvedAt: input.now ?? new Date() })
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
 * `unresolved` receipt's reason when one came, otherwise `no_response`.
 */
export async function expireComputerUpgradeRequests(
  now: Date = new Date(),
  executor: DatabaseExecutor = getDb(),
): Promise<ComputerUpgradeRequestRow[]> {
  const expiredOpen = and(isNull(computerUpgradeRequests.outcome), lte(computerUpgradeRequests.deadlineAt, now));
  // `_` is a LIKE wildcard; escape it (backslash is Postgres' default escape).
  const unresolvedPattern = `${UPGRADE_REQUEST_UNRESOLVED_REASON_PREFIX.replace(/_/gu, "\\_")}: %`;
  const failed = await executor
    .update(computerUpgradeRequests)
    .set({ outcome: "failed", resolvedAt: now })
    .where(and(expiredOpen, like(computerUpgradeRequests.reason, unresolvedPattern)))
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
