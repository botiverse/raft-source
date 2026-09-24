// Per-server daemon health tracking (RFC v0.8 contract v6 §3.3 / PR-H).
//
// Repeated-crash detection: the service appends to a per-server
// `health.json` crash log on every daemon child exit; status reader
// derives the `health` enum (`ok | degraded | offline`) from recent
// crash count + daemon liveness.
//
// Crash threshold: >=3 crashes within a 60-second window → `degraded`.
// In `degraded` state, the service's restart loop skips restart
// (per v6 §3.3 "stop trying to restart") to avoid crash-restart-spin;
// after fixing the underlying issue, the user runs `raft-computer start`
// or `raft-computer restart` to clear the recovery state and try again.
//
// File format (per `health.json`):
//   {
//     "crashes": [{ "at": "2026-05-21T10:00:00Z", "exitCode": 1, "signal": null }, ...],
//     "terminalUnlinked": {
//       "at": "...",
//       "reason": "computer_machine_unlinked",
//       "serverMachineId": "cmp_...",
//       "statusCode": 401
//     }
//   }
//
// Entries older than the crash-window are pruned on each append; the
// file grows bounded.

import { readFile, writeFile, unlink, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serverHealthPath, serviceLogPath, CURRENT_SCHEMA_VERSION } from "./paths.js";
import { isValidServerId } from "./paths.js";
import type { RunnerState } from "./lib/state.js";

export const CRASH_WINDOW_MS = 60_000;
export const DEGRADED_THRESHOLD = 3;

export interface CrashEntry {
  at: string; // ISO timestamp
  exitCode: number | null;
  signal: string | null;
}

export interface FatalConfigMarker {
  at: string;
  exitCode: number | null;
  signal: string | null;
  reason: "ex_config";
}

// Closed set of 401 handshake reasons that are PERMANENT for the credential
// this runner holds: `computer_machine_unlinked` (row deleted/unlinked
// server-side) and `computer_revoked` (key matches a `computers` row whose
// `revokedAt` is set — set-once, never cleared; re-setup mints a NEW
// credential row, so this key can never authenticate again). Both must stop
// the runner instead of retrying forever.
export type TerminalHandshakeRejectionReason =
  | "computer_machine_unlinked"
  | "computer_revoked";

/**
 * Classify a WS handshake rejection as terminal-for-this-credential or not.
 * Both terminal reasons exit the runner with
 * COMPUTER_MACHINE_UNLINKED_EXIT_CODE (service.ts) so `classifyRunnerExit`
 * and the supervisor's no-respawn handling stay byte-identical; the health
 * marker records which reason actually fired. Any other reason (invalid key,
 * transient auth trouble) keeps the existing reconnect behavior — a
 * transiently wrong key must not kill a healthy runner.
 */
export function classifyTerminalHandshakeRejection(
  statusCode: number,
  reason: string | null,
): TerminalHandshakeRejectionReason | null {
  if (statusCode !== 401) return null;
  if (reason === "computer_machine_unlinked" || reason === "computer_revoked") return reason;
  return null;
}

export interface TerminalUnlinkedMarker {
  at: string;
  reason: TerminalHandshakeRejectionReason;
  /**
   * The server-issued Computer id (`runner.state.json#serverMachineId`)
   * that produced the terminal 401. Older health.json files may not carry
   * this field; readers treat those as still scoped to the current server id
   * because there is no safe identity to compare.
   */
  serverMachineId?: string;
  statusCode: number | null;
}

interface HealthFile {
  /**
   * On-disk schema version. Writers stamp CURRENT_SCHEMA_VERSION; readers
   * tolerate a missing value (existing deployed files have none) → treated as
   * version 1 / current. Optional so old files still type-check.
   */
  schemaVersion?: number;
  crashes: CrashEntry[];
  fatalConfig?: FatalConfigMarker;
  terminalUnlinked?: TerminalUnlinkedMarker;
}

async function readHealthFile(slockHome: string, serverId: string): Promise<HealthFile> {
  if (!isValidServerId(serverId)) return { crashes: [] };
  try {
    const raw = await readFile(serverHealthPath(slockHome, serverId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as HealthFile).crashes)) {
      // migrate-on-read: tolerate a missing `schemaVersion` (existing files
      // have none → treat as version 1 / current, do NOT reject). When
      // CURRENT_SCHEMA_VERSION is bumped (>1): when parsed.schemaVersion <
      // CURRENT_SCHEMA_VERSION, migrate the shape here before returning.
      const file = parsed as HealthFile;
      if (typeof file.schemaVersion !== "number") file.schemaVersion = CURRENT_SCHEMA_VERSION;
      return file;
    }
  } catch {
    /* missing / corrupt → empty */
  }
  return { crashes: [] };
}

async function writeHealthFile(
  slockHome: string,
  serverId: string,
  file: HealthFile,
): Promise<void> {
  const path = serverHealthPath(slockHome, serverId);
  await mkdir(dirname(path), { recursive: true });
  // Stamp the current on-disk schema version on every write.
  const stamped: HealthFile = { ...file, schemaVersion: CURRENT_SCHEMA_VERSION };
  await writeFile(path, JSON.stringify(stamped), { mode: 0o600 });
}

/**
 * Append a crash entry. Prunes entries older than the crash-window so
 * the file grows bounded. Caller passes the exit info from the child
 * exit handler.
 */
export async function recordCrash(
  slockHome: string,
  serverId: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!isValidServerId(serverId)) return;
  const file = await readHealthFile(slockHome, serverId);
  // Prune old entries first
  const cutoffMs = nowMs - CRASH_WINDOW_MS;
  file.crashes = file.crashes.filter((c) => {
    const t = new Date(c.at).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
  file.crashes.push({
    at: new Date(nowMs).toISOString(),
    exitCode,
    signal,
  });
  await writeHealthFile(slockHome, serverId, file);
}

/**
 * Read the recent crash history (within the crash-window). Returns []
 * if file missing/corrupt.
 */
export async function readCrashHistory(
  slockHome: string,
  serverId: string,
  nowMs: number = Date.now(),
): Promise<CrashEntry[]> {
  const file = await readHealthFile(slockHome, serverId);
  const cutoffMs = nowMs - CRASH_WINDOW_MS;
  return file.crashes.filter((c) => {
    const t = new Date(c.at).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
}

/**
 * `true` iff the server has crossed the repeated-crash threshold
 * (>=3 crashes within 60s) OR the daemon child has fatally exited with
 * an EX_CONFIG error that the service decided not to keep retrying.
 *
 * When true, the service must skip restart per v6 §3.3, and `status`
 * must report `degraded`. Cleared by `resetHealth`.
 */
export async function isDegraded(
  slockHome: string,
  serverId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const file = await readHealthFile(slockHome, serverId);
  if (file.fatalConfig) return true;
  const cutoffMs = nowMs - CRASH_WINDOW_MS;
  const recent = file.crashes.filter((c) => {
    const t = new Date(c.at).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
  return recent.length >= DEGRADED_THRESHOLD;
}

/**
 * Mark the server as degraded due to a fatal config error (e.g. the
 * per-server daemon child exited with EX_CONFIG_EXIT_CODE because its
 * dep tree is broken). Unlike `recordCrash`, this does NOT contribute
 * to the crash budget — config errors are not crashes — but it sets a
 * separate `fatalConfig` marker that forces `isDegraded` to return true
 * regardless of crash count. Cleared by `resetHealth`.
 */
export async function markFatalConfig(
  slockHome: string,
  serverId: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!isValidServerId(serverId)) return;
  const file = await readHealthFile(slockHome, serverId);
  file.fatalConfig = {
    at: new Date(nowMs).toISOString(),
    exitCode,
    signal,
    reason: "ex_config",
  };
  await writeHealthFile(slockHome, serverId, file);
}

/**
 * Read the fatal-config marker, if any. Used by doctor/status to
 * surface the actionable cause when the server is `degraded` for a
 * config reason rather than a crash reason.
 */
export async function readFatalConfig(
  slockHome: string,
  serverId: string,
): Promise<FatalConfigMarker | null> {
  const file = await readHealthFile(slockHome, serverId);
  return file.fatalConfig ?? null;
}

/**
 * Persist the server-side terminal unlink/deletion state. This is not
 * crash-budget `degraded`: an explicit `start`/`restart` must not clear it,
 * because retrying the old runner.state.json will only produce another 401.
 * Recovery requires moving the stale state aside and re-running setup.
 */
export async function markTerminalUnlinked(
  slockHome: string,
  serverId: string,
  serverMachineId: string,
  statusCode: number | null = null,
  reason: TerminalHandshakeRejectionReason = "computer_machine_unlinked",
  nowMs: number = Date.now(),
): Promise<void> {
  if (!isValidServerId(serverId)) return;
  const file = await readHealthFile(slockHome, serverId);
  file.terminalUnlinked = {
    at: new Date(nowMs).toISOString(),
    reason,
    serverMachineId,
    statusCode,
  };
  await writeHealthFile(slockHome, serverId, file);
}

async function clearTerminalUnlinked(slockHome: string, serverId: string, file: HealthFile): Promise<void> {
  delete file.terminalUnlinked;
  if (file.crashes.length === 0 && !file.fatalConfig) {
    try {
      await unlink(serverHealthPath(slockHome, serverId));
    } catch {
      /* missing = already cleared */
    }
    return;
  }
  await writeHealthFile(slockHome, serverId, file);
}

/**
 * Read the terminal unlink marker, if any. Used by service boot, status,
 * doctor, and start to park the stale runner instead of retrying forever.
 */
export async function readTerminalUnlinked(
  slockHome: string,
  serverId: string,
  currentServerMachineId?: string | null,
): Promise<TerminalUnlinkedMarker | null> {
  const file = await readHealthFile(slockHome, serverId);
  const marker = file.terminalUnlinked ?? null;
  if (
    marker?.serverMachineId &&
    currentServerMachineId &&
    marker.serverMachineId !== currentServerMachineId
  ) {
    await clearTerminalUnlinked(slockHome, serverId, file);
    return null;
  }
  return marker;
}

/**
 * Clear the crash history — user action via
 * `raft-computer start` / `raft-computer restart` after inspecting +
 * fixing the underlying issue. Idempotent: missing file is a no-op.
 *
 * Terminal unlinked state is preserved: the stale runner.state.json must
 * be moved aside before retrying.
 */
export async function resetHealth(slockHome: string, serverId: string): Promise<void> {
  if (!isValidServerId(serverId)) return;
  const existing = await readHealthFile(slockHome, serverId);
  if (existing.terminalUnlinked) {
    await writeHealthFile(slockHome, serverId, {
      crashes: [],
      terminalUnlinked: existing.terminalUnlinked,
    });
    return;
  }
  try {
    await unlink(serverHealthPath(slockHome, serverId));
  } catch {
    /* missing = already reset */
  }
}

export interface ResetRunnerHealthOutcome {
  status: "ok" | "not-found";
  previousState?: RunnerState;
  clearedCrashCount?: number;
}

/**
 * Per-runner reset — RFC v9.8 §2.4. Clears the runner's `crashHistory`
 * entries and transitions runner state `degraded → running` (logical
 * transition; per-runner state today is derived from health.json
 * conditions, so clearing them is the transition).
 *
 * Invariants (§2.4 reset semantics):
 *   - MUST NOT respawn or kill the runner process.
 *   - MUST NOT touch the runner's `state.json` outside `crashHistory`
 *     (the service's restart loop will resume on the next observed
 *     crash naturally).
 *
 * Returns `{status: "not-found"}` when the serverId is invalid (CLI
 * resolves slug → serverId before calling; an invalid id reaching here
 * means a programmer bug or hand-edited input — surface it rather than
 * silently succeeding). Missing health.json is treated as a successful
 * idempotent reset (previousState reported as `"running"`,
 * clearedCrashCount `0`).
 */
export async function resetRunnerHealth(
  slockHome: string,
  serverId: string,
  nowMs: number = Date.now(),
): Promise<ResetRunnerHealthOutcome> {
  if (!isValidServerId(serverId)) {
    return { status: "not-found" };
  }
  const wasDegraded = await isDegraded(slockHome, serverId, nowMs);
  const recent = await readCrashHistory(slockHome, serverId, nowMs);
  const previousState: RunnerState = wasDegraded ? "degraded" : "running";

  await resetHealth(slockHome, serverId);
  await emitRunnerStateTransition(
    slockHome,
    serverId,
    previousState,
    "running",
    "reset-runner",
  );

  return {
    status: "ok",
    previousState,
    clearedCrashCount: recent.length,
  };
}

/**
 * Emit a `{fromState, toState, trigger}` runner-state-changed trace to the
 * service log (RFC v9.8 §7.5 state-machine modeling discipline). Best-effort.
 * Originally called only from `resetRunnerHealth`; the supervisor loop
 * (service.ts) now drives it on every runner transition (spawn / ready /
 * exit / degrade) so the whole §3.2 transition surface is observable.
 */
export async function emitRunnerStateTransition(
  slockHome: string,
  serverId: string,
  fromState: RunnerState,
  toState: RunnerState,
  trigger: string,
): Promise<void> {
  const entry = {
    at: new Date().toISOString(),
    kind: "runner-state-changed",
    serverId,
    fromState,
    toState,
    trigger,
  };
  try {
    const path = serviceLogPath(slockHome);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
  } catch {
    /* best-effort — see serviceState.ts emitServiceStateTransition */
  }
}
