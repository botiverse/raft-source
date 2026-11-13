import { currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import type { RunnerRecord } from "./runnerStateMachine";

/**
 * How long a stopping service waits for each runner before SIGKILL. A runner
 * on SIGTERM stops its agents with the daemon's tree stop: up to 10 s grace,
 * then SIGKILL and 5 s to confirm (AGENT_STOP_KILL_GRACE_MS +
 * AGENT_STOP_KILL_CONFIRM_MS in packages/daemon/src/drivers/processStop.ts),
 * agents in parallel. At 10 s the service cut that stop off halfway, so an
 * agent's tree could outlive its runner. 18 s covers 15 s with margin and
 * stays under launchd's default 20 s ExitTimeOut (Raft Desktop's launchd
 * agent) and inside the installer's 45 s `raft-computer stop` budget.
 */
export const SHUTDOWN_CHILD_WAIT_TIMEOUT_MS = 18_000;

export function evaluateShutdownBarrier(
  runners: Map<string, RunnerRecord>,
): { ok: true } | { ok: false; reason: string } {
  for (const rec of runners.values()) {
    if (rec.child !== undefined) {
      return { ok: false, reason: "managed child still alive" };
    }
  }
  return { ok: true };
}

export interface ShutdownServiceDeps {
  runners: Map<string, RunnerRecord>;
  /** Runs just before a child gets SIGTERM, so the child can tell who stopped it. */
  beforeSignal?: (rec: RunnerRecord, pid: number) => void;
  closeIpc: () => void | Promise<void> | undefined;
  isProcessAlive: (pid: number) => boolean;
  clearServicePidfile: () => Promise<void>;
  restartRequested: boolean;
  /**
   * Exit code once the children are gone. Default 0. A service handing
   * itself to an external supervisor exits with
   * SUPERVISED_RELAUNCH_EXIT_CODE so the supervisor's restart policy
   * relaunches it (task #917).
   */
  exitCode?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  writeWarning?: (message: string) => void;
  exit?: (code: number) => void;
}

export async function shutdownService({
  runners,
  beforeSignal,
  closeIpc,
  isProcessAlive,
  clearServicePidfile,
  restartRequested,
  exitCode = 0,
  now = currentTimeMs,
  sleep = (ms) => new Promise<void>((resolve) => setClockTimeout(resolve, ms)),
  writeWarning = (message) => process.stderr.write(message),
  exit = (code) => process.exit(code),
}: ShutdownServiceDeps): Promise<void> {
  for (const rec of runners.values()) {
    if (!rec.child) continue;
    rec.stopping = true;
    if (rec.child.pid !== undefined) beforeSignal?.(rec, rec.child.pid);
    try {
      rec.child.kill("SIGTERM");
    } catch {
      /* best-effort signal; the barrier keeps ownership visible */
    }
  }
  void closeIpc();

  const deadline = now() + SHUTDOWN_CHILD_WAIT_TIMEOUT_MS;
  let escalated = false;
  let barrier = evaluateShutdownBarrier(runners);
  while (!barrier.ok) {
    if (!escalated && now() >= deadline) {
      escalated = true;
      for (const rec of runners.values()) {
        if (!rec.child) continue;
        try {
          rec.child.kill("SIGKILL");
        } catch {
          /* keep waiting; the pidfile still represents an owned live child */
        }
      }
    }
    await sleep(escalated ? 1_000 : 100);
    barrier = evaluateShutdownBarrier(runners);
  }

  for (const rec of runners.values()) {
    if (rec.externalPid !== undefined && isProcessAlive(rec.externalPid)) {
      writeWarning(
        `Service: warning — external machine-lock owner pid ${rec.externalPid} still live at shutdown ` +
          "(unproven; not killing). Clearing service pid anyway.\n",
      );
    }
  }
  // A proven replacement has already published its own canonical pidfile.
  // The incumbent must not unlink that successor identity during its tail
  // shutdown. Operator stop has no successor and still clears normally.
  if (!restartRequested) await clearServicePidfile();
  exit(exitCode);
}
