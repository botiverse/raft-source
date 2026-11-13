/**
 * Reconciler step 5 (#proj-raft-computer:#48, invariant 3): every stop of a
 * runtime process is SIGTERM (or the runtime's native shutdown), then, after
 * one grace for every runtime and every path, a SIGKILL of the whole process
 * tree; the stop ends only once the exit is observed. There is no path
 * without the escalation.
 *
 * "Stop the current turn" is a different action (task #25 step 2,
 * `killTurnProcesses` / `turnTreeKill`): it selects what one turn started and
 * never comes through here as a tree kill.
 */

/** Grace between a stop's SIGTERM and the SIGKILL of the runtime's process tree (Q8: no runtime needs longer). */
export const AGENT_STOP_KILL_GRACE_MS = 10_000;

/**
 * After the SIGKILL, how long the exit is awaited before it is given up as
 * unconfirmed (a process in uninterruptible sleep, an exit event that never
 * arrives): the stop then ends anyway so a later start can proceed.
 */
export const AGENT_STOP_KILL_CONFIRM_MS = 5_000;

/** The process being stopped, as the stop sees it. */
export interface StoppableProcess {
  readonly pid: number | undefined;
  /** Its exit has been observed. */
  exited(): boolean;
  /** Called once, when its exit is observed. */
  onExit(listener: () => void): void;
  /** Signal the process itself (SIGTERM; SIGKILL as the last part of an escalation). */
  signal(signal: NodeJS.Signals): void;
}

export interface StopEscalation {
  pid: number | undefined;
  graceMs: number;
  /** How many processes the escalation signalled (the root included). */
  treeKilledCount: number;
}

export interface StopProcessOptions {
  /** `SIGKILL` escalates at once (a stop that has already waited elsewhere). */
  signal?: NodeJS.Signals;
  graceMs?: number;
  confirmMs?: number;
  /** Kill the whole tree; returns how many processes it signalled. */
  killTree(): number;
  onEscalated?(escalation: StopEscalation): void;
  onKillUnconfirmed?(info: { pid: number | undefined; graceMs: number; confirmMs: number }): void;
}

export type StopProcessOutcome =
  | { kind: "exited"; escalated: boolean; treeKilledCount: number }
  | { kind: "kill_unconfirmed"; treeKilledCount: number };

export interface StopProcessHandle {
  /** Settles once the exit is observed, or once it is given up as unconfirmed. Never rejects. */
  readonly done: Promise<StopProcessOutcome>;
  /** Skip what is left of the grace (a later stop of the same process asked for SIGKILL). */
  escalateNow(): void;
}

/**
 * The one way a runtime process is stopped. The timers are not unref'd: a
 * daemon that is shutting down must still reach the SIGKILL (bounded by
 * grace + confirm).
 */
export function stopProcess(proc: StoppableProcess, options: StopProcessOptions): StopProcessHandle {
  const graceMs = Math.max(0, options.graceMs ?? AGENT_STOP_KILL_GRACE_MS);
  const confirmMs = Math.max(0, options.confirmMs ?? AGENT_STOP_KILL_CONFIRM_MS);
  let settle!: (outcome: StopProcessOutcome) => void;
  const done = new Promise<StopProcessOutcome>((resolve) => { settle = resolve; });
  let settled = false;
  let escalated = false;
  let treeKilledCount = 0;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = (outcome: StopProcessOutcome) => {
    if (settled) return;
    settled = true;
    if (graceTimer) clearTimeout(graceTimer);
    if (confirmTimer) clearTimeout(confirmTimer);
    settle(outcome);
  };
  const escalate = () => {
    if (settled || escalated) return;
    escalated = true;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
    try {
      treeKilledCount = options.killTree();
    } catch {
      treeKilledCount = 0;
    }
    // The root's own SIGKILL follows (it counts as one when the tree kill
    // could not reach it); reported first, so whatever its exit reports
    // already knows the stop escalated.
    treeKilledCount = Math.max(treeKilledCount, 1);
    options.onEscalated?.({ pid: proc.pid, graceMs, treeKilledCount });
    try {
      proc.signal("SIGKILL");
    } catch {
      // Already gone.
    }
    if (settled) return;
    confirmTimer = setTimeout(() => {
      if (settled) return;
      options.onKillUnconfirmed?.({ pid: proc.pid, graceMs, confirmMs });
      finish({ kind: "kill_unconfirmed", treeKilledCount });
    }, confirmMs);
  };

  proc.onExit(() => finish({ kind: "exited", escalated, treeKilledCount }));
  if (proc.exited()) {
    finish({ kind: "exited", escalated: false, treeKilledCount: 0 });
    return { done, escalateNow: () => {} };
  }
  if (options.signal === "SIGKILL") {
    escalate();
  } else {
    try {
      proc.signal(options.signal ?? "SIGTERM");
    } catch {
      // Already gone; the grace still ends in the escalation if no exit is seen.
    }
    if (!settled) graceTimer = setTimeout(escalate, graceMs);
  }
  return { done, escalateNow: escalate };
}
