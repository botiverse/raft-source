import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import type { TerminalHandshakeRejectionReason } from "./health";

/**
 * Reconciler step 15 (B15): how long a runner whose Computer key the server
 * refused (the terminal 401 `computer_revoked` / `computer_machine_unlinked`)
 * waits for its agents to stop before it exits 77 anyway.
 *
 * One agent stop is the daemon's SIGTERM, AGENT_STOP_KILL_GRACE_MS (10 s),
 * the tree SIGKILL and AGENT_STOP_KILL_CONFIRM_MS (5 s); stopAll runs the
 * agents in parallel, then the orphan reaper. 20 s covers that 15 s with
 * margin. Nothing stops this runner from outside while it waits: the service
 * only signals a runner it no longer manages or when it shuts down itself,
 * and a runner exits on its own here (no OS supervisor stop timeout applies).
 */
export const MACHINE_KEY_REVOKED_STOP_DEADLINE_MS = 20_000;

export type MachineKeyRevokedStopOutcome = "stopped" | "deadline" | "error";

export interface MachineKeyRevokedStopResult {
  reason: TerminalHandshakeRejectionReason;
  outcome: MachineKeyRevokedStopOutcome;
  /** Agents running when the stop began. */
  agentCount: number;
  /** Agents still running when the runner gave up waiting (0 after a full stop). */
  remainingAgentCount: number;
  durationMs: number;
  deadlineMs: number;
}

/** The part of the runner's DaemonCore this stop uses. */
export interface RevokedStopCore {
  stop: (options: { source: "machine_key_revoked" }) => void | Promise<void>;
  getRunningAgentIds?: () => string[];
  recordMachineKeyRevokedStop?: (result: MachineKeyRevokedStopResult) => void;
}

export interface StopAfterMachineKeyRevokedDeps {
  core: RevokedStopCore;
  reason: TerminalHandshakeRejectionReason;
  /** Persists the terminal marker the service reads after exit 77. */
  markTerminal: () => Promise<void>;
  exit: (code: number) => void;
  exitCode: number;
  deadlineMs?: number;
  now?: () => number;
  writeLog?: (line: string) => void;
}

/**
 * Stop every agent of this runner (the daemon's own `core.stop`: stopAll with
 * the step 5 SIGTERM→SIGKILL tree stop, then the orphan reaper), bounded by
 * the deadline, then exit. Agent runtimes lead their own process groups, so
 * an exit without this stop leaves them running until this runner starts
 * again, which a terminal runner does not do until it is re-attached.
 */
export async function stopAfterMachineKeyRevoked(deps: StopAfterMachineKeyRevokedDeps): Promise<void> {
  const deadlineMs = deps.deadlineMs ?? MACHINE_KEY_REVOKED_STOP_DEADLINE_MS;
  const now = deps.now ?? currentTimeMs;
  const runningCount = () => {
    try {
      return deps.core.getRunningAgentIds?.().length ?? 0;
    } catch {
      return 0;
    }
  };
  const startedAt = now();
  const agentCount = runningCount();
  let timer: unknown = null;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setClockTimeout(() => resolve("deadline"), deadlineMs);
  });
  const work = (async (): Promise<MachineKeyRevokedStopOutcome> => {
    const [, stopped] = await Promise.allSettled([
      deps.markTerminal(),
      (async () => deps.core.stop({ source: "machine_key_revoked" }))(),
    ]);
    return stopped.status === "fulfilled" ? "stopped" : "error";
  })();
  let outcome: MachineKeyRevokedStopOutcome;
  try {
    outcome = await Promise.race([work, deadline]);
  } finally {
    if (timer !== null) clearClockTimeout(timer);
  }
  const result: MachineKeyRevokedStopResult = {
    reason: deps.reason,
    outcome,
    agentCount,
    remainingAgentCount: outcome === "stopped" ? 0 : runningCount(),
    durationMs: Math.max(0, now() - startedAt),
    deadlineMs,
  };
  try {
    deps.core.recordMachineKeyRevokedStop?.(result);
  } catch {
    /* the exit must not depend on the trace */
  }
  (deps.writeLog ?? ((line) => process.stderr.write(line)))(
    `raft-computer: machine key ${result.reason}: agent stop ${result.outcome} ` +
      `(${result.agentCount} agent(s), ${result.remainingAgentCount} still running, ${result.durationMs} ms); exiting.\n`,
  );
  deps.exit(deps.exitCode);
}
