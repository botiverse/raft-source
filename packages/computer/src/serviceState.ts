// Service-level state file — RFC v9.8 §1.3 state machine.
//
// File: `<slockHome>/computer/service.state.json`
// Shape:
//   {
//     "state": ServiceState,           // §3.2 closed-set
//     "crashHistory": CrashEntry[],    // cascade record per §2.4
//   }
//
// The service state machine lives here; per-runner state lives under
// `<slockHome>/computer/servers/<serverId>/health.json` (see health.ts).
//
// This module ships the BACKWARD transition (`degraded → running` via the
// internal `reset-service` mutation) plus trace emission. The forward transitions
// (`running → degraded` cascade from runner-degraded ≥2; SIGTERM
// `running → shutting-down`) are implemented alongside the service
// state-machine cutover (§1.3 forward path) in a follow-up commit.
//
// State-machine modeling discipline ([[feedback-state-machine-modeling]]):
// every transition emits `{at, fromState, toState, trigger}` to the
// service log so operators can reconstruct lifecycle from logs alone.

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import { serviceStatePath, serviceLogPath, CURRENT_SCHEMA_VERSION } from "./paths.js";
import type { CrashEntry } from "./health.js";
import type { ServiceState } from "./lib/state.js";
import { isServiceState } from "./lib/state.js";

export interface ServiceStateFile {
  /**
   * On-disk schema version. Writers stamp CURRENT_SCHEMA_VERSION; readers
   * tolerate a missing value (existing deployed files have none) → treated as
   * version 1 / current. Optional so old files still type-check.
   */
  schemaVersion?: number;
  state: ServiceState;
  crashHistory: CrashEntry[];
}

const DEFAULT_STATE: ServiceStateFile = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  state: "running",
  crashHistory: [],
};

/**
 * Read the service state file. Missing/corrupt → defaults to
 * `{state: "running", crashHistory: []}` (the implicit baseline before
 * any cascade has been recorded). Coerces unknown state strings back to
 * `"running"` rather than throwing — the reset path must be robust
 * against a damaged file.
 */
export async function readServiceState(slockHome: string): Promise<ServiceStateFile> {
  try {
    const raw = await readFile(serviceStatePath(slockHome), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_STATE };
    const obj = parsed as Record<string, unknown>;
    // migrate-on-read: tolerate a missing `schemaVersion` (existing files have
    // none → treat as version 1 / current, do NOT reject). When
    // CURRENT_SCHEMA_VERSION is bumped (>1): when parsed.schemaVersion <
    // CURRENT_SCHEMA_VERSION, migrate here before returning.
    const schemaVersion =
      typeof obj.schemaVersion === "number" ? obj.schemaVersion : CURRENT_SCHEMA_VERSION;
    const state = isServiceState(obj.state) ? obj.state : "running";
    const crashHistory = Array.isArray(obj.crashHistory)
      ? (obj.crashHistory as unknown[]).filter(isCrashEntry)
      : [];
    return { schemaVersion, state, crashHistory };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function writeServiceState(
  slockHome: string,
  file: ServiceStateFile,
): Promise<void> {
  const path = serviceStatePath(slockHome);
  await mkdir(dirname(path), { recursive: true });
  // Stamp the current on-disk schema version on every write.
  const stamped: ServiceStateFile = { ...file, schemaVersion: CURRENT_SCHEMA_VERSION };
  await writeFile(path, JSON.stringify(stamped), { mode: 0o600 });
}

function isCrashEntry(value: unknown): value is CrashEntry {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.at === "string";
}

/**
 * Emit a `{at, fromState, toState, trigger}` trace line to the
 * service log. State-machine modeling discipline — every transition
 * is observable from logs alone.
 *
 * Best-effort: log write failure must NOT abort the state transition
 * itself (operators reset to recover; refusing to reset because logging
 * failed would invert the failure mode).
 */
async function emitServiceStateTransition(
  slockHome: string,
  fromState: ServiceState,
  toState: ServiceState,
  trigger: string,
): Promise<void> {
  const entry = {
    at: new Date().toISOString(),
    kind: "service-state-changed",
    fromState,
    toState,
    trigger,
  };
  try {
    const path = serviceLogPath(slockHome);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n");
  } catch {
    /* best-effort — see comment above */
  }
}

export interface ClearServiceCrashHistoryResult {
  previousState: ServiceState;
  clearedCrashCount: number;
}

/**
 * Clear the service-level `crashHistory` and transition state to
 * `running` (§1.3 reset semantics). Idempotent — invocations from a
 * non-degraded `running` state still clear any partial cascade record
 * and emit a no-op transition trace for observability.
 *
 * Lib-pure: no env reads, no `info()`/`fail()`/`process.exit`. The CLI
 * wrapper / IPC handler translates the result + exit code at the
 * boundary.
 *
 * Invariant per §1.3: this function MUST NOT kill any runners, MUST
 * NOT touch any runner's `health.json`, MUST NOT spawn new processes.
 * The service's per-runner restart loop will naturally resume once
 * the next runner crash is observed, because the runner-level degraded
 * flag (in per-server health.json) is independent of the service state.
 */
export async function clearServiceCrashHistory(
  slockHome: string,
): Promise<ClearServiceCrashHistoryResult> {
  const current = await readServiceState(slockHome);
  const previousState = current.state;
  const clearedCrashCount = current.crashHistory.length;

  const next: ServiceStateFile = { state: "running", crashHistory: [] };
  await writeServiceState(slockHome, next);
  await emitServiceStateTransition(
    slockHome,
    previousState,
    "running",
    "reset-service",
  );

  return { previousState, clearedCrashCount };
}
