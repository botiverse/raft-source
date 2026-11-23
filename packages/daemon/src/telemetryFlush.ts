import { clearClockTimeout, setClockTimeout, type MachineToServerMessage } from "@botiverse/raft-shared";

/**
 * When the daemon flushes its telemetry outside the uploader's own schedule
 * (`DaemonTraceBundleUploader.flushNow`): a failed agent start, and shutdown.
 * A Computer online for only a few minutes otherwise uploads nothing, because
 * the sink's file is still open (or younger than the upload's minimum age)
 * when the session ends.
 */

/**
 * A start failure as the server sees it: the `agent:activity` frame carrying
 * `spawnFailure`. Both hosts send it (the legacy manager's
 * `reportStartFailure`, and the OAR host's own) through the core's one
 * agent-frame route, so that route is the single point that covers both.
 */
export function isStartFailureFrame(msg: MachineToServerMessage): boolean {
  return msg.type === "agent:activity" && msg.spawnFailure !== undefined;
}

type FlushTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

const defaultTimers: FlushTimers = { setTimeout: setClockTimeout, clearTimeout: clearClockTimeout };

/** Lets the failure's own trace records (and its start span) reach the sink first. */
export const START_FAILURE_FLUSH_DELAY_MS = 1000;

/**
 * Requests a flush shortly after a start failure. The delay puts the flush
 * after whatever the failing start still records once its frame is sent (its
 * start span ends right after, for one), so those records are in the file the
 * flush closes. Requests while one is pending coalesce.
 */
export class StartFailureFlushScheduler {
  private timer: unknown = null;
  /** Set by cancel(), which runs only when the daemon stops: no later request arms a flush. */
  private closed = false;
  private readonly flush: () => Promise<unknown>;
  private readonly delayMs: number;
  private readonly timers: FlushTimers;

  constructor(options: { flush: () => Promise<unknown>; delayMs?: number; timers?: FlushTimers }) {
    this.flush = options.flush;
    this.delayMs = options.delayMs ?? START_FAILURE_FLUSH_DELAY_MS;
    this.timers = options.timers ?? defaultTimers;
  }

  request(): void {
    // A start that fails while the agents stop must not arm a flush that the
    // shutdown flush would then join (rotating before the stop records exist).
    if (this.closed || this.timer !== null) return;
    const timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => undefined);
    }, this.delayMs);
    (timer as { unref?: () => void } | null)?.unref?.();
    this.timer = timer;
  }

  /** Cancels a pending flush and refuses every later request (daemon stop). */
  cancel(): void {
    this.closed = true;
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Shutdown waits at most this long for its flush. */
export const STOP_FLUSH_TIMEOUT_MS = 3000;

/**
 * The flush runs after the agents stopped, so it gets what is left of this
 * budget, counted from the start of `stop()`, and never more than
 * STOP_FLUSH_TIMEOUT_MS. The Computer waits 18 s for a runner before SIGKILL
 * (SHUTDOWN_CHILD_WAIT_TIMEOUT_MS: a 15 s agent tree stop plus margin), so a
 * stop whose agents took the full 15 s still releases its lock in time.
 */
export const STOP_FLUSH_DEADLINE_MS = 16_000;

/** How long the shutdown flush may take, given how long the stop has run; 0 means skip it. */
export function stopFlushBudgetMs(elapsedMs: number): number {
  return Math.max(0, Math.min(STOP_FLUSH_TIMEOUT_MS, STOP_FLUSH_DEADLINE_MS - elapsedMs));
}

/**
 * Run `flush`, waiting at most `timeoutMs`. Shutdown must not be held up by a
 * slow or hung upload, and a failure is only reported, never thrown.
 */
export async function flushWithinBound(
  flush: () => Promise<unknown>,
  timeoutMs: number = STOP_FLUSH_TIMEOUT_MS,
  timers: FlushTimers = defaultTimers,
): Promise<"done" | "timed_out" | "failed"> {
  let timer: unknown = null;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timer = timers.setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(flush).then(() => "done" as const, () => "failed" as const),
      timedOut,
    ]);
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
  }
}
