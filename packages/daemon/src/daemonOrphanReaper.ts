// Daemon shutdown process-tree orphan safeguard.
//
// This is session-independent BY DESIGN: it runs after the per-agent
// RuntimeSessions have been torn down (stopAll), as a last line of defense to
// guarantee no orphan child process survives daemon exit. It legitimately owns
// raw process-tree signals (signal-0 liveness probe + SIGKILL of survivors),
// which is a DISTINCT boundary from per-session RuntimeSession control IO
// (RS-011). Per-session liveness/control goes through RuntimeSession; this
// whole-tree shutdown reaper does not have (and should not have) a session to
// route through, because the sessions are already gone by the time it runs.

export type OrphanReaperLogger = {
  warn(msg: string): void;
};

export type OrphanReaperTrace = (
  name: string,
  attrs?: Record<string, unknown>,
  status?: "ok" | "error" | "cancelled",
) => void;

/**
 * Probe the snapshotted agent-subprocess pids for survivors; SIGKILL any that
 * survived stopAll, then wait (bounded) for the SIGKILL to take effect so the
 * runner never exits with live orphan children.
 *
 * Behavior is a byte-for-byte lift of the former inline stopAll reaper: the
 * survivor filter via `process.kill(pid, 0)`, the SIGKILL of survivors, and the
 * 2s re-probe wait loop. The no-survivor ("all dead") completion trace stays
 * with the caller, which owns the agent_count context; this returns whether any
 * survivor was reaped so the caller can emit that trace.
 */
export async function reapOrphanProcesses(
  pids: number[],
  logger: OrphanReaperLogger,
  recordTrace: OrphanReaperTrace,
): Promise<boolean> {
  // Verify every agent subprocess is dead; SIGKILL survivors so the runner
  // never exits with live orphan children.
  const survivors = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (survivors.length === 0) return false;

  for (const pid of survivors) {
    logger.warn(`[Daemon] Agent subprocess ${pid} survived stopAll; sending SIGKILL`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead between probe and kill */
    }
  }
  recordTrace("daemon.agent.stop_all.survivor_reaped", {
    survivor_count: survivors.length,
    survivor_pids: survivors.join(","),
    reason: "shutdown_survivor",
    signal: "SIGKILL",
  });
  // Wait for SIGKILL to take effect before the runner exits.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const alive = survivors.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const stillAlive = survivors.filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  const outcome = stillAlive.length > 0 ? "survivors_still_alive" : "survivors_killed";
  recordTrace("daemon.agent.stop_all.completed", {
    survivor_count: survivors.length,
    reaped_count: survivors.length - stillAlive.length,
    still_alive_count: stillAlive.length,
    outcome,
  }, stillAlive.length > 0 ? "error" : "ok");
  return true;
}
