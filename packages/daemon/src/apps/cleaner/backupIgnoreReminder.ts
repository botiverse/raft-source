/**
 * The Cleaner's `.raftbackupignore` reminder: the trigger rules, the signal
 * state they compare, the agent-facing text, and the bounded workspace scan
 * and size estimate behind the folders it names.
 * SystemCleanerRuntime (runtime.ts) decides when to evaluate and presents it.
 *
 * Rules (#wg-agent-migration:7746de27, tygg, Artea and Miles):
 * - Baseline: at a Working → Idle transition, when the last reminder was at
 *   least CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS ago (or there was none).
 * - Early: a signal that is new since the last reminder brings it forward to
 *   the next Working → Idle, at least CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS
 *   after the last one. The same signal state never repeats a reminder.
 * - Urgent: a size failure of a move, critically low disk, or a provider
 *   quota nearly used up. Presented at once, also into a running turn, once
 *   per signal state, with the same spacing, except that a size failure of a
 *   migration not reminded of yet always goes through. Critically low disk
 *   is over only once the disk is no longer low (hysteresis).
 * - A baseline with no new signal is skipped when the agent updated
 *   `.raftbackupignore` since the last reminder; the update counts as one.
 * - The state survives daemon restarts (createFileReminderStateStore).
 * - Names: only when size is the reason (reminderNamesSource), and then the
 *   largest paths a failed move reported or the few largest top-level folders
 *   a move would still take. Names are for the agent to check, never a list
 *   to add. A folder it marked `# keep: <folder>` is no longer named as one
 *   to check; the largest paths of a move that failed for its size are named
 *   whether or not they are marked kept, as they say why it failed.
 * - Withdrawal: the reminder's item is taken back at a Working → Idle
 *   transition once what it asked for is measurably done or its reasons are
 *   measurably gone (reminderSignalsCleared, namedFoldersStillMove, the
 *   ignore-file stamp; SystemCleanerRuntime.withdrawClearedReminder). Nothing
 *   is re-sent because of it: the rules above decide the next reminder. What
 *   the reminder was about is kept in memory only.
 */

import { readFileSync, rmSync, statSync, type Dir, type Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

import {
  AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS,
  AGENT_MIGRATION_WORKSPACE_SIZE_ERROR_CODES,
  isMachineDiskLow,
  type AgentMigrationReadiness,
  type AgentMigrationWorkspaceSizeErrorCode,
} from "@botiverse/raft-shared";
import {
  AGENT_MIGRATION_BACKUP_IGNORE_FILE,
  AGENT_MIGRATION_IGNORE_FILE,
  AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES,
  isNotesPath,
  readAgentMigrationTopLevelSkip,
  readAgentMigrationWalkSkip,
  readFileHead,
} from "../../agentMigrationExport";
import { agentStateDir, agentStateFile, writeAgentStateText } from "../../agentStateFiles";
import { daemonOffersAgentMigrationRetry } from "../../migrationTransportCapabilities";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** Baseline rhythm: a light reminder in a half day the agent works, this long after the last one (tygg). */
export const CLEANER_BACKUP_IGNORE_BASELINE_INTERVAL_MS = 12 * HOUR_MS;
/** Early reminders (a new signal) are at least this far apart. */
export const CLEANER_BACKUP_IGNORE_EARLY_MIN_SPACING_MS = 2 * HOUR_MS;
/** Urgent ones too, except a size failure of a migration not reminded of yet. */
export const CLEANER_BACKUP_IGNORE_URGENT_MIN_SPACING_MS = 2 * HOUR_MS;
/** Size failures (by migrationId) already reminded of, kept across restarts. */
export const CLEANER_SIZE_FAILURE_REMEMBERED_IDS = 8;
/** migrationReadiness bands: max(bytes/maxBytes, files/maxEntries) at or over these. */
export const CLEANER_READINESS_HALF_BAND = 0.5;
export const CLEANER_READINESS_CLOSE_BAND = 0.8;
/** Low disk is new again when free space dropped to this fraction of its value at the last reminder. */
export const CLEANER_DISK_LOW_STEP_RATIO = 0.5;
/** Critically low: low even with this fraction of the free space (half the low-disk threshold). */
export const CLEANER_DISK_CRITICAL_FRACTION = 0.5;
/** A provider usage limit counts when it was hit this recently. */
export const CLEANER_PROVIDER_LIMIT_RECENT_MS = DAY_MS;
export const CLEANER_WORKSPACE_SCAN_MAX_ENTRIES = 2_000;
export const CLEANER_WORKSPACE_SCAN_TIMEOUT_MS = 200;
/** The size estimate behind the named folders stops at this much time and this many entries, whichever is first. */
export const CLEANER_WORKSPACE_MEASURE_BUDGET_MS = 1_500;
export const CLEANER_WORKSPACE_MEASURE_MAX_ENTRIES = 200_000;
/** Folders (or Server paths) a reminder names at most. */
export const CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED = 3;
export const CLEANER_SIZE_FAILURE_MAX_PATHS = 3;
const PREVIEW_MAX_CHARS = 120;

// Titles and the generic summary are previews: at most
// AGENT_INBOX_PREVIEW_MAX_CHARS (120) each, or the Inbox refuses the item.
export const CLEANER_BACKUP_IGNORE_REMINDER_TITLE =
  `Review ${AGENT_MIGRATION_BACKUP_IGNORE_FILE}: list only what can be regenerated or re-downloaded, never keys, notes, drafts or unpushed work`;
/** One item when the workspace cleanup tip and the reminder are due at the same transition. */
export const CLEANER_WORKSPACE_TIDY_TITLE =
  `Tidy up: delete what you're sure is unneeded, list in ${AGENT_MIGRATION_BACKUP_IGNORE_FILE} only what can be regenerated, keep the rest`;
/** Before the Server's largest paths of a failed move. */
export const CLEANER_REMINDER_TOP_PATHS_PREFIX = "Largest: ";
/** Before the largest top-level folders measured here: a list to check, not one to add. */
export const CLEANER_REMINDER_LARGEST_PREFIX = "Largest folders that still move: ";
/**
 * Ends a size-failure reminder while the agent may still retry that move
 * itself (`raft migration retry`, once, within
 * AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS of the failure), on a daemon that
 * advertises AGENT_MIGRATION_AGENT_RETRY_CAPABILITY.
 */
// Short, as it shares the 120-character preview with the reasons and the
// largest paths: "Then" follows the title, which says to update the ignore file.
export const CLEANER_SIZE_FAILURE_RETRY_HINT = "Then run raft migration retry to retry the move once.";

/** The retry hint for this reminder, or null (no new size failure, its window passed, or no retry here). */
export function sizeFailureRetryHint(
  signals: readonly CleanerReminderSignal[],
  snapshot: CleanerSignalSnapshot,
  nowMs: number,
  offersRetry: boolean = daemonOffersAgentMigrationRetry(),
): string | null {
  if (!offersRetry || !hasNewSizeFailure(signals)) return null;
  const failedAtMs = Date.parse(snapshot.readiness?.lastSizeFailure?.at ?? "");
  if (Number.isFinite(failedAtMs) && nowMs - failedAtMs >= AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS) return null;
  return CLEANER_SIZE_FAILURE_RETRY_HINT;
}

export const CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY =
  "Dependencies, build output, caches and downloaded data need not move.";

/** Daemon-owned: never suggested for the ignore file (notes/ always moves too). */
const NEVER_NAMED = new Set([".raft"]);
const PREVIEW_UNSAFE_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;

/** `directoryNames`: the top-level folders a reminder may name (defaultScanWorkspaceRoot). */
export type CleanerWorkspaceScan =
  | { kind: "established"; directoryNames: string[] }
  | { kind: "not_established"; reason: "entry_limit" | "timeout" | "read_failed" };

/**
 * One top-level folder's size estimate: the bytes of the files and the number
 * of entries (files, folders and symlinks, as a move counts them) under it
 * that a move would take. `complete` is false when the walk stopped at a
 * budget first: both are then lower bounds.
 */
export interface CleanerDirectorySize {
  name: string;
  bytes: number;
  entries: number;
  complete: boolean;
}

/** What "largest" means for a reminder: the move size limit and the disk are about bytes, the file-count limit about entries. */
export type CleanerSizeDimension = "bytes" | "entries";

/** mtime+size of .raftbackupignore, or null when it does not exist. */
export type CleanerIgnoreFileStamp = { mtimeMs: number; size: number } | null;

export type CleanerProviderQuotaState = "ok" | "warning" | "near_exhausted" | "exhausted";
/** `utilization`: the used fraction, 0..1. */
export interface CleanerProviderQuota {
  state: CleanerProviderQuotaState;
  utilization?: number;
}

export type CleanerReminderTier = "baseline" | "early" | "urgent";
export type CleanerReminderTrigger =
  | "first"
  | "rhythm"
  | "disk_low"
  | "provider_limit"
  | "provider_quota"
  | "readiness_band"
  | "size_failure";

export interface CleanerReminderSignal {
  trigger: Exclude<CleanerReminderTrigger, "first" | "rhythm">;
  urgent: boolean;
  /** Agent-facing, leads the summary. */
  reason: string;
}

/** What the signals looked like at the last reminder. */
export interface CleanerSignalMemory {
  /** Free bytes at the last reminder while the disk was low; null: not low since. */
  diskLowFreeBytes: number | null;
  diskCritical: boolean;
  readinessBand: 0 | 1 | 2;
  /** lastSizeFailure.migrationIds already reminded of, newest last (at most CLEANER_SIZE_FAILURE_REMEMBERED_IDS). */
  sizeFailureMigrationIds: string[];
  quotaState: CleanerProviderQuotaState;
  providerLimitAtMs: number | null;
}

/** What the signals look like now. */
export interface CleanerSignalSnapshot {
  disk: { availableBytes: number; totalBytes: number } | null;
  readiness: AgentMigrationReadiness | null;
  quota: CleanerProviderQuota | undefined;
  providerLimitAtMs: number | null;
}

export function initialSignalMemory(): CleanerSignalMemory {
  return {
    diskLowFreeBytes: null,
    diskCritical: false,
    readinessBand: 0,
    sizeFailureMigrationIds: [],
    quotaState: "ok",
    providerLimitAtMs: null,
  };
}

export function isCleanerDiskCritical(disk: { availableBytes: number; totalBytes: number }): boolean {
  return isMachineDiskLow({
    availableBytes: disk.availableBytes / CLEANER_DISK_CRITICAL_FRACTION,
    totalBytes: disk.totalBytes,
  });
}

/** Untrusted Server field, normalized; null when absent or malformed. */
export function normalizeMigrationReadiness(raw: unknown): AgentMigrationReadiness | null {
  if (!isRecord(raw) || !isRecord(raw.limits)) return null;
  const { maxBytes, maxEntries } = raw.limits;
  if (!isPositive(maxBytes) || !isPositive(maxEntries)) return null;
  const readiness: AgentMigrationReadiness = { limits: { maxBytes, maxEntries } };
  const measured = raw.lastMeasured;
  if (isRecord(measured)
    && isNonNegative(measured.files) && isNonNegative(measured.bytes)
    && typeof measured.at === "string"
    && (measured.source === "packed" || measured.source === "failed")) {
    readiness.lastMeasured = { files: measured.files, bytes: measured.bytes, at: measured.at, source: measured.source };
  }
  const failure = raw.lastSizeFailure;
  if (isRecord(failure)
    && typeof failure.migrationId === "string" && failure.migrationId.length > 0
    && typeof failure.at === "string"
    && isSizeErrorCode(failure.code)) {
    // Only the paths are ever shown (never their counts or bytes), stripped of control characters.
    const topPaths = Array.isArray(failure.topPaths)
      ? failure.topPaths
        .filter((entry): entry is { path: string; value: number } =>
          isRecord(entry) && typeof entry.path === "string" && typeof entry.value === "number")
        .map((entry) => ({ path: entry.path.replace(PREVIEW_UNSAFE_CHARS, "").trim(), value: entry.value }))
        .filter((entry) => entry.path.length > 0)
        .slice(0, CLEANER_SIZE_FAILURE_MAX_PATHS)
      : [];
    readiness.lastSizeFailure = { migrationId: failure.migrationId, at: failure.at, code: failure.code, topPaths };
  }
  return readiness;
}

function isSizeErrorCode(value: unknown): value is AgentMigrationWorkspaceSizeErrorCode {
  return (AGENT_MIGRATION_WORKSPACE_SIZE_ERROR_CODES as readonly unknown[]).includes(value);
}

export function readinessRatio(readiness: AgentMigrationReadiness | null): { ratio: number; dimension: "size" | "file-count" } | null {
  const measured = readiness?.lastMeasured;
  if (!readiness || !measured) return null;
  const bytes = measured.bytes / readiness.limits.maxBytes;
  const files = measured.files / readiness.limits.maxEntries;
  return bytes >= files ? { ratio: bytes, dimension: "size" } : { ratio: files, dimension: "file-count" };
}

export function readinessBand(ratio: number | undefined): 0 | 1 | 2 {
  if (ratio === undefined) return 0;
  if (ratio >= CLEANER_READINESS_CLOSE_BAND) return 2;
  return ratio >= CLEANER_READINESS_HALF_BAND ? 1 : 0;
}

/** Signals that cleared since the last reminder are forgotten, so their return is new. */
export function forgetClearedSignals(memory: CleanerSignalMemory, snapshot: CleanerSignalSnapshot): void {
  if (snapshot.disk) {
    // Hysteresis: critical is over only once the disk is no longer low at
    // all, so a reading flapping around the critical line interrupts once.
    if (!isMachineDiskLow(snapshot.disk)) {
      memory.diskLowFreeBytes = null;
      memory.diskCritical = false;
    }
  }
  if (snapshot.quota?.state === "ok") memory.quotaState = "ok";
}

/** Signals new since the last reminder, most urgent first. */
export function newReminderSignals(
  memory: CleanerSignalMemory,
  snapshot: CleanerSignalSnapshot,
  nowMs: number,
): CleanerReminderSignal[] {
  const signals: CleanerReminderSignal[] = [];
  const failure = snapshot.readiness?.lastSizeFailure;
  // One failure keeps its migrationId on every later start: new only when the id is.
  if (failure && !memory.sizeFailureMigrationIds.includes(failure.migrationId)) {
    signals.push({
      trigger: "size_failure",
      urgent: true,
      reason: failure.code === "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED"
        ? "The last move failed: too many files."
        : "The last move failed: too large.",
    });
  }
  const disk = snapshot.disk;
  const low = disk !== null && isMachineDiskLow(disk);
  const critical = disk !== null && isCleanerDiskCritical(disk);
  if (critical && !memory.diskCritical) {
    signals.push({ trigger: "disk_low", urgent: true, reason: diskReason(disk.availableBytes) });
  }
  const quota = snapshot.quota;
  if (quota?.state === "near_exhausted" && memory.quotaState !== "near_exhausted") {
    signals.push({ trigger: "provider_quota", urgent: true, reason: quotaReason(quota) });
  }
  const ratio = readinessRatio(snapshot.readiness);
  const band = readinessBand(ratio?.ratio);
  if (ratio && band > memory.readinessBand) {
    const pct = Math.floor(ratio.ratio * 100);
    signals.push({
      trigger: "readiness_band",
      urgent: false,
      reason: band === 2
        ? `Close to the move ${ratio.dimension} limit (${pct}%).`
        : `Over half the move ${ratio.dimension} limit (${pct}%).`,
    });
  }
  if (low && !signals.some((signal) => signal.trigger === "disk_low")
    && (memory.diskLowFreeBytes === null || disk.availableBytes <= memory.diskLowFreeBytes * CLEANER_DISK_LOW_STEP_RATIO)) {
    signals.push({ trigger: "disk_low", urgent: false, reason: diskReason(disk.availableBytes) });
  }
  if ((quota?.state === "warning" || quota?.state === "exhausted") && memory.quotaState !== quota.state) {
    signals.push({ trigger: "provider_quota", urgent: false, reason: quotaReason(quota) });
  }
  const limitAtMs = snapshot.providerLimitAtMs;
  if (limitAtMs !== null && nowMs - limitAtMs < CLEANER_PROVIDER_LIMIT_RECENT_MS && limitAtMs !== memory.providerLimitAtMs) {
    signals.push({ trigger: "provider_limit", urgent: false, reason: "A provider usage limit was hit recently." });
  }
  return signals;
}

/** The memory a reminder leaves: every signal as it is now (unknown ones as they were). */
export function signalMemoryAfterReminder(previous: CleanerSignalMemory, snapshot: CleanerSignalSnapshot): CleanerSignalMemory {
  const disk = snapshot.disk;
  return {
    diskLowFreeBytes: disk ? (isMachineDiskLow(disk) ? disk.availableBytes : null) : previous.diskLowFreeBytes,
    // A reminder while the disk is low but not critical keeps an earlier
    // critical episode (hysteresis), so the next dip below critical is not new.
    diskCritical: disk
      ? isCleanerDiskCritical(disk) || (previous.diskCritical && isMachineDiskLow(disk))
      : previous.diskCritical,
    readinessBand: readinessBand(readinessRatio(snapshot.readiness)?.ratio),
    sizeFailureMigrationIds: rememberMigrationId(previous.sizeFailureMigrationIds, snapshot.readiness?.lastSizeFailure?.migrationId),
    quotaState: snapshot.quota?.state ?? previous.quotaState,
    providerLimitAtMs: snapshot.providerLimitAtMs ?? previous.providerLimitAtMs,
  };
}

function rememberMigrationId(ids: readonly string[], id: string | undefined): string[] {
  if (id === undefined || ids.includes(id)) return [...ids];
  return [...ids, id].slice(-CLEANER_SIZE_FAILURE_REMEMBERED_IDS);
}

/** Whether `signals` hold a size failure of a migration not reminded of yet (it skips the urgent spacing). */
export function hasNewSizeFailure(signals: readonly CleanerReminderSignal[]): boolean {
  return signals.some((signal) => signal.trigger === "size_failure");
}

/** What a reminder names: the Server's largest paths, the largest folders measured here (by `by`), or nothing. */
export type CleanerReminderNamesSource =
  | { kind: "top_paths"; paths: string[] }
  | { kind: "largest"; by: CleanerSizeDimension }
  | { kind: "none" };

/**
 * A reminder names something only when size is its reason: a new size
 * failure, a workspace at or over half a move limit, or low disk in its text
 * (`diskLowInText`: the low-disk workspace tip merged into it; a disk signal
 * counts by itself). Then the largest paths the failed move reported when that
 * failure is new or the workspace is newly close to a limit, and otherwise
 * the largest folders measured here. Far from every limit the agent cannot
 * tell from a name whether a folder is regenerable, so none is given.
 *
 * Largest by entries when the file count is the reason: a new failure for
 * too many files, or, with no new failure, a workspace at or over half a
 * limit that is nearer its file-count limit than its size limit. Otherwise
 * by bytes (a failure for its size, the size limit, low disk alone).
 */
export function reminderNamesSource(
  signals: readonly CleanerReminderSignal[],
  snapshot: CleanerSignalSnapshot,
  diskLowInText: boolean,
): CleanerReminderNamesSource {
  const ratio = readinessRatio(snapshot.readiness);
  const band = readinessBand(ratio?.ratio);
  const sizeFailure = hasNewSizeFailure(signals);
  const topPaths = (snapshot.readiness?.lastSizeFailure?.topPaths ?? []).map((entry) => entry.path);
  if (topPaths.length > 0
    && (sizeFailure || (band === 2 && signals.some((signal) => signal.trigger === "readiness_band")))) {
    return { kind: "top_paths", paths: topPaths };
  }
  const diskLow = diskLowInText || signals.some((signal) => signal.trigger === "disk_low");
  if (!(band >= 1 || sizeFailure || diskLow)) return { kind: "none" };
  const fileCount = sizeFailure
    ? snapshot.readiness?.lastSizeFailure?.code === "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED"
    : band >= 1 && ratio?.dimension === "file-count";
  return { kind: "largest", by: fileCount ? "entries" : "bytes" };
}

/** A signal a reminder can be sent for (CleanerReminderSignal.trigger). */
export type CleanerReminderSignalTrigger = CleanerReminderSignal["trigger"];

/**
 * What the reminder whose item is in the Inbox was about, remembered so that
 * the item can be withdrawn once that is measurably over. In memory only: the
 * item is transient, so a restart leaves nothing to withdraw.
 */
export interface CleanerPresentedReminder {
  atMs: number;
  /** What its names were (reminderNamesSource). */
  namesSource: CleanerReminderNamesSource["kind"];
  /**
   * The names its summary showed, in order, at most
   * CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED: for `largest` the top-level
   * folder names (without the `/` shown after them), for `top_paths` the
   * Server's paths. Empty: it named nothing.
   */
  names: string[];
  /** The signals it was sent for; empty for a plain baseline. */
  triggers: CleanerReminderSignalTrigger[];
  /** The workspace tip merged into the item, by what made the tip due; null: the reminder alone. */
  tip: "disk_low" | "memory_hint" | null;
  /** .raftbackupignore when it was presented. */
  stamp: CleanerIgnoreFileStamp | "unknown";
}

/**
 * Whether every signal a reminder was sent for is gone from the snapshot. A
 * signal that cannot be read now (no disk measurement, no readiness or
 * measurement from the Server, no quota reading) is not gone: only what was
 * measured withdraws a reminder. False for a reminder sent for no signal (a
 * plain baseline).
 */
export function reminderSignalsCleared(
  triggers: readonly CleanerReminderSignalTrigger[],
  snapshot: CleanerSignalSnapshot,
  nowMs: number,
): boolean {
  if (triggers.length === 0) return false;
  return triggers.every((trigger) => {
    switch (trigger) {
      case "size_failure":
        // The Server drops the failure once a later move packed.
        return snapshot.readiness !== null && snapshot.readiness.lastSizeFailure === undefined;
      case "readiness_band": {
        const ratio = readinessRatio(snapshot.readiness);
        return ratio !== null && readinessBand(ratio.ratio) === 0;
      }
      case "disk_low":
        return snapshot.disk !== null && !isMachineDiskLow(snapshot.disk);
      case "provider_quota":
        return snapshot.quota?.state === "ok";
      case "provider_limit":
        return snapshot.providerLimitAtMs === null || nowMs - snapshot.providerLimitAtMs >= CLEANER_PROVIDER_LIMIT_RECENT_MS;
    }
  });
}

/**
 * Whether one of these top-level folders, named by a reminder as one that
 * still moves, still does: it exists, no ignore file skips it
 * (readAgentMigrationTopLevelSkip) and it is not marked `# keep:`
 * (readBackupIgnoreKept). Reads the ignore files and stats each folder;
 * nothing is walked or sized. A folder that cannot be stat'ed for another
 * reason than its absence counts as still moving.
 */
export async function namedFoldersStillMove(workspacePath: string, names: readonly string[]): Promise<boolean> {
  const skip = await readAgentMigrationTopLevelSkip(workspacePath);
  const kept = await readBackupIgnoreKept(workspacePath);
  for (const name of names) {
    if (skip(name) || kept.has(name)) continue;
    try {
      if ((await lstat(path.join(workspacePath, name))).isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return true;
    }
  }
  return false;
}

/**
 * The per-agent reminder state kept across daemon restarts, as written to
 * `<agents dir>/.agent-state/<agentId>/cleaner-backup-ignore.json`.
 */
export interface CleanerPersistedReminderState {
  version: 1;
  lastReminderAtMs?: number;
  /** .raftbackupignore at the last reminder; "unknown" when it could not be read. */
  stamp?: CleanerIgnoreFileStamp | "unknown";
  signals: CleanerSignalMemory;
  /**
   * Always null, and never read. The version before this one kept the
   * top-level directory names of the last reminder here, and its parser
   * rejects a state without the field (null or an array): written so that a
   * daemon rolled back to it still reads this file, with its times and
   * migrationIds, instead of starting over.
   */
  names: null;
}

/** Where the reminder state lives; `load` returns the parsed JSON (or null), `save` may throw. */
export interface CleanerReminderStateStore {
  load(ownerAgentId: string): unknown;
  save(ownerAgentId: string, state: CleanerPersistedReminderState): void;
  /** The agent's workspace was deleted: forget its state. */
  remove(ownerAgentId: string): void;
}

export const CLEANER_REMINDER_STATE_FILE = "cleaner-backup-ignore.json";
export const CLEANER_REMINDER_STATE_MAX_BYTES = 256 * 1024;

/**
 * The daemon's per-agent records directory (agentStateFiles.ts):
 * `<agents dir>/.agent-state/<agentId>/cleaner-backup-ignore.json`, outside
 * every workspace, written through the same atomic helper. A cache: lost or
 * corrupt, the Cleaner behaves as before it had one.
 */
export function createFileReminderStateStore(agentsDir: string): CleanerReminderStateStore {
  return {
    load(ownerAgentId) {
      const file = path.join(agentStateDir(agentsDir, ownerAgentId), CLEANER_REMINDER_STATE_FILE);
      let text: string;
      try {
        if (statSync(file).size > CLEANER_REMINDER_STATE_MAX_BYTES) return null;
        text = readFileSync(file, "utf8");
      } catch {
        return null;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    save(ownerAgentId, state) {
      writeAgentStateText(agentStateFile(agentsDir, ownerAgentId, CLEANER_REMINDER_STATE_FILE), `${JSON.stringify(state)}\n`);
    },
    remove(ownerAgentId) {
      rmSync(path.join(agentStateDir(agentsDir, ownerAgentId), CLEANER_REMINDER_STATE_FILE), { force: true });
    },
  };
}

/**
 * A persisted state, validated; null (behave as without one) when missing or
 * corrupt. What an earlier version wrote in `names` (the top-level directory
 * names at the last reminder) is not read.
 */
export function parsePersistedReminderState(raw: unknown): CleanerPersistedReminderState | null {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.signals)) return null;
  const signals = raw.signals;
  const band = signals.readinessBand;
  const quota = signals.quotaState;
  if (
    !(signals.diskLowFreeBytes === null || isNonNegative(signals.diskLowFreeBytes))
    || typeof signals.diskCritical !== "boolean"
    || (band !== 0 && band !== 1 && band !== 2)
    || !Array.isArray(signals.sizeFailureMigrationIds)
    || !signals.sizeFailureMigrationIds.every((id) => typeof id === "string")
    || (quota !== "ok" && quota !== "warning" && quota !== "near_exhausted" && quota !== "exhausted")
    || !(signals.providerLimitAtMs === null || isNonNegative(signals.providerLimitAtMs))
  ) return null;
  if (raw.lastReminderAtMs !== undefined && !isNonNegative(raw.lastReminderAtMs)) return null;
  const stamp = raw.stamp;
  if (!(stamp === undefined || stamp === null || stamp === "unknown"
    || (isRecord(stamp) && isNonNegative(stamp.mtimeMs) && isNonNegative(stamp.size)))) return null;
  return {
    version: 1,
    ...(raw.lastReminderAtMs === undefined ? {} : { lastReminderAtMs: raw.lastReminderAtMs }),
    ...(stamp === undefined ? {} : {
      stamp: stamp === null || stamp === "unknown" ? stamp : { mtimeMs: stamp.mtimeMs as number, size: stamp.size as number },
    }),
    signals: {
      diskLowFreeBytes: signals.diskLowFreeBytes as number | null,
      diskCritical: signals.diskCritical,
      readinessBand: band,
      sizeFailureMigrationIds: (signals.sizeFailureMigrationIds as string[]).slice(-CLEANER_SIZE_FAILURE_REMEMBERED_IDS),
      quotaState: quota,
      providerLimitAtMs: signals.providerLimitAtMs as number | null,
    },
    names: null,
  };
}

export function diskReason(availableBytes: number): string {
  return `Disk is low (${formatBytes(availableBytes)} free).`;
}

function quotaReason(quota: CleanerProviderQuota): string {
  const pct = quota.utilization !== undefined && Number.isFinite(quota.utilization)
    ? ` (${Math.round(Math.min(1, Math.max(0, quota.utilization)) * 100)}%)`
    : "";
  if (quota.state === "near_exhausted") return `Provider quota nearly used up${pct}.`;
  if (quota.state === "exhausted") return "Provider quota is used up.";
  return `Provider quota is running low${pct}.`;
}

/**
 * The summary: the reasons first (as many as fit the preview cap), then
 * `names.items` in their order after `names.prefix`, at most
 * CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED and only while they fit (never a
 * count of the rest), then `trailer` (its room is kept: it always fits after
 * the first reason). The names shown are always the first of the list, which
 * is ranked: one that does not fit, or holds a control character, ends them,
 * so a smaller folder is never shown in place of a larger one. Nothing to
 * say: the generic line.
 */
export function backupIgnoreReminderSummary(
  reasons: readonly string[],
  names: { prefix: string; items: readonly string[] } | null,
  trailer: string | null = null,
): { summary: string; namedCount: number } {
  const maxChars = trailer ? PREVIEW_MAX_CHARS - trailer.length - 1 : PREVIEW_MAX_CHARS;
  const withTrailer = (text: string) => (trailer ? (text ? `${text} ${trailer}` : trailer) : text);
  let head = "";
  for (const reason of reasons) {
    const next = head ? `${head} ${reason}` : reason;
    if (next.length > maxChars) break;
    head = next;
  }
  const headOnly = () => ({
    summary: (head || trailer) ? withTrailer(head) : CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY,
    namedCount: 0,
  });
  if (!names || names.items.length === 0) return headOnly();
  const lead = head ? `${head} ${names.prefix}` : names.prefix;
  const render = (named: readonly string[]) => `${lead}${named.join(", ")}.`;
  let named: string[] = [];
  for (const item of names.items.slice(0, CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED)) {
    if (item.replace(PREVIEW_UNSAFE_CHARS, "") !== item) break;
    const candidate = [...named, item];
    if (render(candidate).length > maxChars) break;
    named = candidate;
  }
  if (named.length === 0) return headOnly();
  return { summary: withTrailer(render(named)), namedCount: named.length };
}

/**
 * One read of the workspace root's entries (opendir, so the cap stops the read
 * itself), directory names only. Symlinks are not followed and nothing is
 * stat'ed. Names a migration already leaves out (built-in regenerable names,
 * top-level lines of the ignore files), notes/ and .raft are dropped, and so
 * are the folders the agent marked kept (readBackupIgnoreKept): what is left
 * are the folders worth checking.
 */
export async function defaultScanWorkspaceRoot(input: {
  absolutePath: string;
  maxEntries: number;
  shouldStop: () => boolean;
}): Promise<CleanerWorkspaceScan> {
  const names: string[] = [];
  let entries = 0;
  try {
    const dir = await opendir(input.absolutePath);
    // Leaving the loop early closes the directory handle.
    for await (const entry of dir) {
      if (input.shouldStop()) return { kind: "not_established", reason: "timeout" };
      entries += 1;
      if (entries > input.maxEntries) return { kind: "not_established", reason: "entry_limit" };
      if (entry.isDirectory()) names.push(entry.name);
    }
    const skip = await readAgentMigrationTopLevelSkip(input.absolutePath);
    const kept = await readBackupIgnoreKept(input.absolutePath);
    if (input.shouldStop()) return { kind: "not_established", reason: "timeout" };
    return {
      kind: "established",
      directoryNames: names.filter((name) => !skip(name) && !kept.has(name) && !isNotesPath(name) && !NEVER_NAMED.has(name)),
    };
  } catch {
    return { kind: "not_established", reason: "read_failed" };
  }
}

const KEEP_LINE = /^#\s*keep\s*:(.*)$/i;
/** The ignore files the agent writes: `# keep:` lines count in both, as it may use either (the Manual names the older one for a Computer of unknown version). */
const KEEP_LINE_FILES = [AGENT_MIGRATION_BACKUP_IGNORE_FILE, AGENT_MIGRATION_IGNORE_FILE];

/**
 * A `# keep: <folder>` line of an ignore file: a top-level folder the agent
 * checked and wants to move, which a reminder then no longer names as one to
 * check. To every migration the line is a comment, so it changes nothing
 * about the move. The rest of the line is the name (no trailing comment),
 * optionally in single or double quotes; `./` before it and `/` after it are
 * dropped, as in an ignore line. Null: not such a line, or not a top-level
 * name.
 */
export function parseBackupIgnoreKeepLine(rawLine: string): string | null {
  const match = KEEP_LINE.exec(rawLine.trim());
  if (!match) return null;
  const rest = match[1]!.trim();
  const quoted = /^(["'])(.*)\1$/.exec(rest);
  const name = (quoted ? quoted[2]! : rest).replace(/^\.\//, "").replace(/\/+$/, "");
  return name === "" || name === "." || name === ".." || /[\\/]/.test(name) ? null : name;
}

/**
 * The folders marked kept in `.raftbackupignore` and `.raftmigrateignore`
 * (the first AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES of each); a file that
 * cannot be read marks none.
 */
export async function readBackupIgnoreKept(workspacePath: string): Promise<ReadonlySet<string>> {
  const kept = new Set<string>();
  for (const fileName of KEEP_LINE_FILES) {
    try {
      const file = path.join(workspacePath, fileName);
      if (!(await lstat(file)).isFile()) continue;
      for (const line of (await readFileHead(file, AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES)).split(/\r?\n/)) {
        const name = parseBackupIgnoreKeepLine(line);
        if (name !== null) kept.add(name);
      }
    } catch {
      // No such file, or unreadable: it marks nothing.
    }
  }
  return kept;
}

/** Entries one folder's walk takes before the next folder has its turn. */
const MEASURE_SLICE_ENTRIES = 256;
/** Files sized at once. */
const MEASURE_STAT_BATCH = 8;
/** A walk in the middle of a large directory keeps it open between turns, while at most this many are open. */
const MEASURE_MAX_OPEN_DIRECTORIES = 32;

interface DirectoryWalk {
  name: string;
  bytes: number;
  entries: number;
  /** Directories not read yet, workspace-relative with `/`. */
  pending: string[];
  /** The directory being read. */
  open: { relativeDir: string; dir: Dir } | null;
}

/**
 * A bounded estimate of what each of `directoryNames` (top-level folders of
 * the workspace) would add to a move: the bytes of the files under it and the
 * number of entries, without what a migration leaves out at any depth
 * (readAgentMigrationWalkSkip). Symlinks are never followed. The folders take turns, a slice of entries
 * each, so a small one is done early and no single one uses up the budget:
 * the walk ends when `shouldStop` turns true (the time budget) or `maxEntries`
 * entries were read, and a folder not finished by then reports what was
 * counted with `complete: false`. Never throws for an unreadable folder: what
 * cannot be read counts nothing.
 */
export async function defaultMeasureWorkspaceDirectories(input: {
  absolutePath: string;
  directoryNames: readonly string[];
  maxEntries: number;
  shouldStop: () => boolean;
}): Promise<CleanerDirectorySize[]> {
  const skip = await readAgentMigrationWalkSkip(input.absolutePath);
  const walks: DirectoryWalk[] = input.directoryNames.map((name) => ({ name, bytes: 0, entries: 0, pending: [name], open: null }));
  let entries = 0;
  let openDirectories = 0;
  const stopped = () => entries >= input.maxEntries || input.shouldStop();
  const close = async (walk: DirectoryWalk) => {
    const open = walk.open;
    if (!open) return;
    walk.open = null;
    openDirectories -= 1;
    await open.dir.close().catch(() => {});
  };
  const slice = async (walk: DirectoryWalk) => {
    let files: string[] = [];
    const sizeFiles = async () => {
      const batch = files;
      files = [];
      const sizes = await Promise.all(batch.map(async (file) => {
        try {
          const info = await lstat(path.join(input.absolutePath, file));
          return info.isFile() ? info.size : 0;
        } catch {
          // Vanished while walking: nothing to move or count.
          return 0;
        }
      }));
      for (const size of sizes) walk.bytes += size;
    };
    let work = 0;
    // Past the slice a directory is still read to its end when too many are open to keep this one so.
    while (!stopped() && (work < MEASURE_SLICE_ENTRIES || (walk.open !== null && openDirectories > MEASURE_MAX_OPEN_DIRECTORIES))) {
      if (!walk.open) {
        const relativeDir = walk.pending.pop();
        if (relativeDir === undefined) break;
        work += 1;
        try {
          walk.open = { relativeDir, dir: await opendir(path.join(input.absolutePath, relativeDir)) };
          openDirectories += 1;
        } catch {
          // Unreadable or gone: nothing of it is counted.
        }
        continue;
      }
      let entry: Dirent | null;
      try {
        entry = await walk.open.dir.read();
      } catch {
        entry = null;
      }
      if (entry === null) {
        await close(walk);
        continue;
      }
      entries += 1;
      work += 1;
      const relativePath = `${walk.open.relativeDir}/${entry.name}`;
      const isDirectory = entry.isDirectory();
      if (skip(relativePath, isDirectory)) continue;
      // A move counts every entry it takes: files, folders and symlinks.
      walk.entries += 1;
      if (isDirectory) {
        walk.pending.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
        if (files.length >= MEASURE_STAT_BATCH) await sizeFiles();
      }
    }
    await sizeFiles();
  };
  const unfinished = (walk: DirectoryWalk) => walk.open !== null || walk.pending.length > 0;
  try {
    let active = walks;
    while (active.length > 0 && !stopped()) {
      for (const walk of active) {
        if (stopped()) break;
        await slice(walk);
      }
      active = active.filter(unfinished);
    }
    return walks.map((walk) => ({ name: walk.name, bytes: walk.bytes, entries: walk.entries, complete: !unfinished(walk) }));
  } finally {
    for (const walk of walks) await close(walk);
  }
}

/**
 * The folders to name, largest first, at most
 * CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED: by what was counted for each in
 * the dimension `by`. For a folder whose walk did not finish that is a lower
 * bound, and it ranks as that: an unfinished walk says nothing about how much
 * is left, so it does not outrank a finished folder known to be larger. Equal
 * counts: the unfinished one first (it is at least that large), then by name.
 * A folder with nothing counted is never named, finished or not: a budget
 * used up before a folder's first read names nothing rather than a folder
 * nothing is known about.
 */
export function largestDirectoryNames(
  sizes: readonly CleanerDirectorySize[],
  by: CleanerSizeDimension = "bytes",
): string[] {
  return sizes
    .filter((size) => size[by] > 0)
    .sort((left, right) => right[by] - left[by]
      || Number(left.complete) - Number(right.complete)
      || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED)
    .map((size) => size.name);
}

export async function defaultStatIgnoreFile(absolutePath: string): Promise<CleanerIgnoreFileStamp> {
  try {
    const info = await lstat(absolutePath);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export function sameIgnoreFileStamp(left: CleanerIgnoreFileStamp, right: CleanerIgnoreFileStamp): boolean {
  if (left === null || right === null) return left === right;
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
