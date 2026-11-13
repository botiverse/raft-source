/**
 * Going-away for machine (daemon) WebSocket connections (task #261).
 *
 * Extracted from the orchestrator so the batching and close semantics are
 * unit-testable without a database: the orchestrator only owns the
 * connection registry, this module owns the drain behaviour.
 */

/** Minimal socket surface the drain needs (satisfied by `ws`'s WebSocket). */
export interface DrainClosableSocket {
  readonly readyState: number;
  readonly OPEN: number;
  close(code?: number, reason?: string): void;
}

export interface MachineDrainConnection {
  machineId: string;
  ws: DrainClosableSocket;
}

// RFC 6455 §7.4.1 going-away: the task is draining, the daemon should
// reconnect immediately (its normal close handling reconnects with jitter).
// Sent when ECS begins draining this task, minutes before the ALB severs the
// connection, so the daemon migrates to a healthy task instead of being hard
// cut (task #261).
export const MACHINE_DRAIN_CLOSE_CODE = 1001;
export const MACHINE_DRAIN_CLOSE_REASON = "server_draining";

/** Default total window for the drain going-away spread. The drain-window
 * invariant (machineDrain.test.ts + drain-window.tftest.hcl) pins the target
 * groups' deregistration_delay against this value + margin: change it here
 * without changing the infra side and CI goes red, in both directions. */
export const DEFAULT_DRAIN_CLOSE_SPREAD_MS = 120_000;
/** Margin the drain window must keep beyond the spread: last-1001 -> daemon
 * reconnect (0-5s) + registration + slow-machine slack. Measured on the
 * 2026-11-05 prod rollout (120s spread): last-1001 -> registered p50 4.6s,
 * p99 20.1s, 0.6% over 30s, none lost (zhiqiang chose 30s + 30s). */
export const DRAIN_SPREAD_MARGIN_MS = 30_000;

export interface DrainCloseResult {
  /** Sockets a close frame was sent to. */
  closed: number;
  /** Measured time from the first close sent to the last, in ms. This is the
   * number acceptance compares against the configured budget: the mechanism
   * must report what it did, not what it was configured to do. */
  spanMs: number;
}

/**
 * Close every open machine connection with 1001 `server_draining`, paced one
 * connection at a time: close number `i` (of n) goes out at
 * `spreadMs * i / n`, so the closes are spread evenly across `[0, spreadMs)`
 * at ANY connection count.
 *
 * The pacing is per-connection, not per-batch, because the batch variant
 * fails silently at real cardinality: with 25-per-batch and the ~29
 * connections a production task actually holds, "batch" 1 sends 25 closes at
 * t=0 and only the remaining 4 wait — the spread the fleet was promised
 * never happens (caught by Manjusaka on #8638).
 *
 * The budget is set by the caller: the ECS-drain trigger can afford the
 * configured 120s (it fires minutes before the force-close), while the
 * SIGTERM fallback must finish inside the shutdown deadline.
 *
 * Sockets that are already closing/closed are skipped; their normal ws
 * `close` handlers keep owning the bookkeeping either way.
 */
export async function closeConnectionsForDrain(
  connections: Iterable<MachineDrainConnection>,
  options?: DrainSpreadOptions,
): Promise<DrainCloseResult> {
  const warn = options?.warn ?? ((message: string, reason: unknown) => console.warn(`[Slock] ${message}:`, reason));
  return spreadClosesForDrain(connections, (conn) => {
    if (conn.ws.readyState !== conn.ws.OPEN) return false;
    try {
      conn.ws.close(MACHINE_DRAIN_CLOSE_CODE, MACHINE_DRAIN_CLOSE_REASON);
      return true;
    } catch (err) {
      warn(`Failed to send drain close to machine ${conn.machineId}`, err);
      return false;
    }
  }, options);
}

export interface DrainSpreadOptions {
  /** Total window to spread the closes across. Default DEFAULT_DRAIN_CLOSE_SPREAD_MS. */
  spreadMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for tests (ms). */
  now?: () => number;
  warn?: (message: string, reason: unknown) => void;
}

/**
 * The pacing behind closeConnectionsForDrain, for any kind of long-lived
 * connection (browser Socket.IO transports and SSE streams use it too).
 * `close` returns whether it actually closed something; skipped items still
 * take their slot, so the spread stays even. A `close` that throws is warned
 * and counted as skipped: one bad connection must not stop the rest (they
 * would then all be cut together at SIGTERM) or reject the promise of a
 * drain that callers start detached.
 *
 * Browser and SSE connections used to be closed all at once at drain start.
 * With ECS draining every old task together, that put every open tab's
 * reconnect and page reload on Neon in the same second: about half of
 * requests over 1 s in the cutover minute at v1.21.27 and v1.21.28
 * (#proj-o11y:7c3aaf2e).
 */
export async function spreadClosesForDrain<T>(
  items: Iterable<T>,
  close: (item: T) => boolean,
  options?: DrainSpreadOptions,
): Promise<DrainCloseResult> {
  const spreadMs = options?.spreadMs ?? DEFAULT_DRAIN_CLOSE_SPREAD_MS;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options?.now ?? (() => Date.now());
  const warn = options?.warn ?? ((message: string, reason: unknown) => console.warn(`[Slock] ${message}:`, reason));

  const snapshot = [...items];
  const n = snapshot.length;
  let closed = 0;
  let firstCloseAt: number | null = null;
  let lastCloseAt: number | null = null;
  // Schedule against absolute time: with n≈200 the event loop is busy with
  // the reconnects the closes cause, so 199 relative sleeps would accumulate
  // seconds of drift. Close `i` is due at start + spreadMs*i/n; each sleep is
  // "until the next due time", so drift does not compound and spanMs stays a
  // faithful acceptance reading.
  const start = now();
  for (let index = 0; index < n; index += 1) {
    let didClose = false;
    try {
      didClose = close(snapshot[index]);
    } catch (err) {
      warn("Failed to close a connection during drain", err);
    }
    if (didClose) {
      closed += 1;
      const at = now();
      if (firstCloseAt === null) firstCloseAt = at;
      lastCloseAt = at;
    }
    // Pace the NEXT close: close i+1 is due at start + spreadMs*(i+1)/n. The
    // last close needs no trailing sleep.
    if (index + 1 < n) {
      const dueAt = start + (spreadMs * (index + 1)) / n;
      await sleep(Math.max(0, dueAt - now()));
    }
  }
  return {
    closed,
    spanMs: firstCloseAt === null ? 0 : (lastCloseAt as number) - firstCloseAt,
  };
}
