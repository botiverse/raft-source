import { writePidfileAt } from "./internal/process-primitives.js";
import {
  adoptExternalRunnerPid,
  RUNNER_TRIGGER,
  type RunnerRecord,
} from "./lib/runnerStateMachine.js";
import type { RunnerState } from "./lib/state.js";
import { serverRunnerLogPath, serverRunnerPidPath } from "./paths.js";

export interface HandleRunnerLockConflictOptions {
  slockHome: string;
  serverId: string;
  rec: RunnerRecord;
  ownerPid: number | null;
  isOwnerProcessAlive: (pid: number) => boolean;
  emitTransition: (
    serverId: string,
    from: RunnerState,
    to: RunnerState,
    trigger: string,
  ) => void;
  scheduleReconcile: (delayMs: number) => void;
  writeStderr: (text: string) => void;
  nowMs: () => number;
  retryDelayMs: number;
}

/** Resolve a daemon machine-lock loser without charging the crash budget. */
export async function handleRunnerLockConflict({
  slockHome,
  serverId,
  rec,
  ownerPid,
  isOwnerProcessAlive,
  emitTransition,
  scheduleReconcile,
  writeStderr,
  nowMs,
  retryDelayMs,
}: HandleRunnerLockConflictOptions): Promise<void> {
  const prev = rec.lifecycle;
  if (ownerPid !== null && isOwnerProcessAlive(ownerPid)) {
    adoptExternalRunnerPid(rec, ownerPid);
    await writePidfileAt(serverRunnerPidPath(slockHome, serverId), ownerPid);
    emitTransition(serverId, prev, "running", RUNNER_TRIGGER.exitAlreadyRunning);
    writeStderr(
      `Service: server ${serverId} found live daemon already holding the machine lock ` +
        `(pid ${ownerPid}); adopting/deferring to it instead of retrying.\n`,
    );
    return;
  }
  if (ownerPid !== null) {
    // Never delete daemon.lock from the Computer supervisor. Ownership can
    // change after this liveness read, so only the daemon's canonical lock
    // acquisition path may prove/reclaim the lock during the retry.
    rec.lifecycle = "stopped";
    rec.backoffUntil = nowMs() + retryDelayMs;
    emitTransition(serverId, prev, "stopped", RUNNER_TRIGGER.exitLockOwnerGone);
    scheduleReconcile(retryDelayMs);
    writeStderr(
      `Service: server ${serverId} lost the daemon machine-lock race to pid ${ownerPid}, ` +
        "but that owner exited during handoff; retrying once through the normal reconciler.\n",
    );
    return;
  }
  rec.lifecycle = "degraded";
  rec.backoffUntil = undefined;
  emitTransition(serverId, prev, "degraded", RUNNER_TRIGGER.exitAlreadyRunning);
  writeStderr(
    `Service: server ${serverId} hit daemon machine-lock conflict but could not verify a live owner; ` +
      `marked degraded and NOT auto-restarting. See ${serverRunnerLogPath(slockHome, serverId)}.\n`,
  );
}
