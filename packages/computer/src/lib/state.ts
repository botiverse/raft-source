// RFC v9.8 §3.2 state-machine value tuples — closed-set seed exported
// from `@botiverse/raft-computer/lib`.
//
// These are the canonical state vocabularies for `RunnerState` and
// `ServiceState`. Consumers pattern-match against `*_VALUES` tuples
// directly for exhaustiveness checks; the derived union types are for
// type annotations.
//
// Closed-set discipline (§7 / §3 versioning):
//   - Adding a value = additive minor library bump.
//   - Removing / renaming a value = major library bump.
//   - Per [[feedback-state-machine-modeling]]: every operation that
//     transitions between these states is a state machine that MUST
//     ship with `{fromState, toState, trigger, errorCode?}` trace
//     emission + snapshot tests (§7.5). The state values pin the
//     vocabulary; impl PRs add the transition surface.

/**
 * Per-runner lifecycle states (§3.2). One state at a time per runner.
 *
 *   starting  — spawned, not yet reporting ready
 *   running   — healthy, reporting heartbeats
 *   degraded  — alive but not satisfying health invariants (e.g. crash
 *               budget near breach, see §1/§2)
 *   crashed   — observed exit / fatal signal
 *   stopped   — intentional stop (operator-driven via `runners stop` or
 *               service shutdown)
 */
export const RUNNER_STATE_VALUES = [
  "starting",
  "running",
  "degraded",
  "crashed",
  "stopped",
] as const;

export type RunnerState = (typeof RUNNER_STATE_VALUES)[number];

export function isRunnerState(value: unknown): value is RunnerState {
  return (
    typeof value === "string" && (RUNNER_STATE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Service (service) lifecycle states (§3.2). Mirrors runner shape but
 * narrower — the service is a singleton per install root.
 *
 *   starting  — pidfile written, socket not yet listening
 *   running   — socket listening, heartbeat active
 *   degraded  — service alive but one or more invariants violated
 *               (e.g. SERVICE_DEGRADED §7.3 crash-budget breach)
 *   stopping  — graceful shutdown in flight (SERVICE_SHUTTING_DOWN
 *               §7.3 emitted to clients)
 *   stopped   — pidfile cleared, socket closed
 */
export const SERVICE_STATE_VALUES = [
  "starting",
  "running",
  "degraded",
  "stopping",
  "stopped",
] as const;

export type ServiceState = (typeof SERVICE_STATE_VALUES)[number];

export function isServiceState(value: unknown): value is ServiceState {
  return (
    typeof value === "string" && (SERVICE_STATE_VALUES as readonly string[]).includes(value)
  );
}
