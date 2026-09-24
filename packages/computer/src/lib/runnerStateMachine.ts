// Runner supervision state machine (RFC v9.8 §3.2 transition surface).
//
// `lib/state.ts` pins the closed-set RunnerState vocabulary
// (starting|running|degraded|crashed|stopped) and notes: "The state
// values pin the vocabulary; impl PRs add the transition surface." This
// module IS that transition surface for the per-server daemon supervision
// inside the `__service` loop.
//
// Why this exists (the structural fix): before this module, the service
// tracked runners as a `Map<serverId, ChildHandle>` plus a side
// `Set<serverId>` of in-flight respawns ("restarting"). The side set
// existed ONLY because spawn-eligibility was not derived from an explicit
// lifecycle state — on a graceful/crash restart the child handle was
// deleted immediately but the respawn was deferred behind a backoff,
// leaving a window where the periodic reconcile would spawn a SECOND
// daemon and the two would race the machine lock. Modeling the runner as
// an explicit state + a `backoffUntil` deadline makes spawn-eligibility a
// pure function (`canSpawn`), so the race window cannot exist: a runner
// mid-backoff is `crashed`/`stopped` with `backoffUntil` in the future,
// which `canSpawn` rejects, and once spawned the live `child` rejects it
// again. No side set, single source of truth.
//
// This module is deliberately pure (no process spawning, no fs, no
// timers) so the whole transition table is unit-testable without
// spawning real daemons. The service loop owns the effects (spawn / kill
// / schedule reconcile) and consults these functions for decisions.

import type { ChildProcess } from "node:child_process";
import type { RunnerState } from "./state.js";

/** Classification of a per-server daemon child exit — the state machine's
 *  input alphabet for exit events. Lives here (not service.ts) so the pure
 *  layer never imports the supervisor (decycle R0). */
export type ChildExitClass = "graceful" | "config-error" | "already-running" | "unlinked-terminal" | "crash";

/**
 * In-memory supervision record for one per-server daemon runner. Replaces
 * the old `children: Map<ChildHandle>` + `restarting: Set` pair — the
 * lifecycle state plus `backoffUntil` subsumes the in-flight-respawn set.
 *
 *   - `child` present  ⇔ a live daemon process is currently registered.
 *   - `externalPid` present ⇔ a live daemon is holding the machine lock but is
 *                         not a child of this supervisor (service restart /
 *                         orphan adoption). It is spawn-blocking and can be
 *                         signaled by pid, but has no ChildProcess handle.
 *   - `lifecycle`       the §3.2 state; canonical for "may we spawn?".
 *   - `backoffUntil`    epoch-ms; while `now < backoffUntil` a
 *                       crashed/stopped runner is NOT yet eligible to
 *                       respawn (replaces the `restarting` guard window).
 *   - `stopping`        operator/shutdown asked this child to exit; its
 *                       exit must NOT trigger a restart.
 */
export interface RunnerRecord {
  serverId: string;
  child?: ChildProcess;
  externalPid?: number;
  lifecycle: RunnerState;
  backoffUntil?: number;
  stopping: boolean;
}

/**
 * Transition triggers — kebab-case wire/trace literals (§5.5) fed to the
 * `{fromState, toState, trigger}` emission so every edge is observable
 * (the §7.5 state-machine modeling discipline). Closed-set: adding a
 * value is additive; renaming/removing requires an RFC bump.
 */
export const RUNNER_TRIGGER = {
  spawn: "spawn",
  spawnFailed: "spawn-failed",
  ready: "ready",
  exitGraceful: "exit-graceful",
  exitCrash: "exit-crash",
  exitCrashDegraded: "exit-crash-degraded",
  exitConfigError: "exit-config-error",
  exitAlreadyRunning: "exit-already-running",
  exitLockOwnerGone: "exit-lock-owner-gone",
  exitUnlinked: "exit-unlinked",
  operatorStop: "operator-stop",
  shutdownStop: "shutdown-stop",
  reset: "reset",
} as const;

export type RunnerTrigger = (typeof RUNNER_TRIGGER)[keyof typeof RUNNER_TRIGGER];

/**
 * The lifecycle a runner enters when its daemon child exits, given the
 * exit classification and whether the crash budget is already breached.
 *
 *   - config-error → `degraded` (fatalConfig; a broken dep tree won't fix
 *     itself by retrying, so we stop restarting and surface the cause).
 *   - already-running → `running` (another live daemon owns the machine lock;
 *     the supervisor adopts/defers to that incumbent pid instead of spawning).
 *   - unlinked-terminal → `degraded` (server-side unlink/delete is terminal
 *     for this runner.state.json; recovery requires setup)
 *   - crash, budget breached (≥DEGRADED_THRESHOLD in window) → `degraded`
 *     (stop the crash-restart spin per v6 §3.3).
 *   - crash, under budget → `crashed` (eligible to respawn after backoff).
 *   - graceful (code 0 / SIGTERM / SIGINT, not an operator stop) →
 *     `stopped` (the reconciler respawns it iff the server is still
 *     wanted; the canonical "stop for good" path clears managed.flag,
 *     which makes the server unwanted and the respawn a no-op).
 *
 * Pure — no fs, no budget computation. Caller passes `budgetBreached`
 * (read from health.json) so this stays trivially testable.
 */
export function nextRunnerStateOnExit(
  exitClass: ChildExitClass,
  budgetBreached: boolean,
): RunnerState {
  if (exitClass === "config-error") return "degraded";
  if (exitClass === "already-running") return "running";
  if (exitClass === "unlinked-terminal") return "degraded";
  if (exitClass === "crash") return budgetBreached ? "degraded" : "crashed";
  return "stopped";
}

/**
 * The trigger label for an exit transition — keeps the trace vocabulary
 * aligned with `nextRunnerStateOnExit` so emission and state agree.
 */
export function exitTrigger(exitClass: ChildExitClass, budgetBreached: boolean): RunnerTrigger {
  if (exitClass === "config-error") return RUNNER_TRIGGER.exitConfigError;
  if (exitClass === "already-running") return RUNNER_TRIGGER.exitAlreadyRunning;
  if (exitClass === "unlinked-terminal") return RUNNER_TRIGGER.exitUnlinked;
  if (exitClass === "crash") {
    return budgetBreached ? RUNNER_TRIGGER.exitCrashDegraded : RUNNER_TRIGGER.exitCrash;
  }
  return RUNNER_TRIGGER.exitGraceful;
}

/**
 * Single source of truth for "may the supervisor spawn a `__run` daemon
 * for this serverId right now?". Pure function of (record, wanted, now).
 *
 * Eligible iff ALL hold:
 *   - the server is `wanted` (attached + managed.flag) — never spawn an
 *     unwanted runner;
 *   - no live `child` is currently registered (idempotency: one daemon
 *     per machine key);
 *   - no live adopted/orphan `externalPid` is currently registered;
 *   - the lifecycle is a respawnable resting state — `crashed` or
 *     `stopped`, or there is no record yet (fresh first spawn). NOT
 *     `starting` (a spawn is already in flight), NOT `running` (already
 *     up), NOT `degraded` (deliberately parked; cleared only by
 *     `reset`);
 *   - any restart backoff has elapsed (`now >= backoffUntil`).
 *
 * Because a runner mid-backoff is `crashed`/`stopped` with a future
 * `backoffUntil`, this returns false during the backoff window WITHOUT a
 * separate in-flight set — that is the structural elimination of the
 * old double-spawn race.
 */
export function canSpawn(
  rec: RunnerRecord | undefined,
  wanted: boolean,
  now: number,
): boolean {
  if (!wanted) return false;
  if (!rec) return true; // never spawned, server wanted → fresh spawn
  if (rec.child) return false; // a live daemon is already registered
  if (rec.externalPid) return false; // a live orphan/incumbent daemon owns the lock
  if (rec.lifecycle !== "crashed" && rec.lifecycle !== "stopped") return false;
  return now >= (rec.backoffUntil ?? 0);
}

export function adoptExternalRunnerPid(rec: RunnerRecord, pid: number): void {
  rec.child = undefined;
  rec.externalPid = pid;
  rec.lifecycle = "running";
  rec.backoffUntil = undefined;
  rec.stopping = false;
}

export function clearExternalRunnerPidIfDead(
  rec: RunnerRecord,
  isAlive: (pid: number) => boolean,
): boolean {
  if (rec.externalPid === undefined) return false;
  if (isAlive(rec.externalPid)) return false;
  rec.externalPid = undefined;
  if (rec.lifecycle === "running") {
    rec.lifecycle = "stopped";
  }
  return true;
}

/**
 * Build the initial supervision record for a server at service boot,
 * given its durable health (read from health.json). A server that was
 * `degraded` before the service stopped/upgraded MUST stay `degraded`
 * across the restart (otherwise the boot reconcile would respawn it and
 * resume the crash-spin the degrade was meant to stop). This is the
 * in-memory side of "degraded survives a service restart/upgrade", which
 * the daemon-upgrade-compat constraint depends on — disk (health.json)
 * stays canonical, this record is the rehydrated cache.
 *
 * A non-degraded server gets `stopped` (no live child yet, eligible to
 * spawn on the first reconcile).
 */
export function rehydrateRunnerRecord(serverId: string, degraded: boolean): RunnerRecord {
  return {
    serverId,
    lifecycle: degraded ? "degraded" : "stopped",
    stopping: false,
  };
}

/**
 * Apply an operator reset to the in-memory record (the single-writer side
 * of `reset-runner`). A `degraded` runner is the only case that needs
 * in-memory action: clearing health.json on disk is not enough post-②
 * because spawn-eligibility is derived from the cached lifecycle, so a
 * `degraded` cache would keep `canSpawn` false and the runner would never
 * respawn until a service restart. Transition `degraded → stopped` and
 * clear any backoff so the next reconcile respawns it.
 *
 * Returns true iff a transition was applied (caller emits the trace +
 * schedules a reconcile only then). A running/starting/crashed/stopped
 * runner is left untouched — reset only un-parks a degraded one; it must
 * never kill or respawn a healthy runner (§2.4).
 */
export function applyRunnerReset(rec: RunnerRecord): boolean {
  if (rec.lifecycle !== "degraded") return false;
  rec.lifecycle = "stopped";
  rec.backoffUntil = undefined;
  return true;
}
