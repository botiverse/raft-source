import { currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import type { RunnerRecord } from "./runnerStateMachine.js";

const SHUTDOWN_CHILD_WAIT_TIMEOUT_MS = 10_000;

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
  closeIpc: () => void | Promise<void> | undefined;
  isProcessAlive: (pid: number) => boolean;
  clearServicePidfile: () => Promise<void>;
  restartRequested: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  writeWarning?: (message: string) => void;
  exit?: (code: number) => void;
}

export async function shutdownService({
  runners,
  closeIpc,
  isProcessAlive,
  clearServicePidfile,
  restartRequested,
  now = currentTimeMs,
  sleep = (ms) => new Promise<void>((resolve) => setClockTimeout(resolve, ms)),
  writeWarning = (message) => process.stderr.write(message),
  exit = (code) => process.exit(code),
}: ShutdownServiceDeps): Promise<void> {
  for (const rec of runners.values()) {
    if (!rec.child) continue;
    rec.stopping = true;
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
  exit(0);
}
