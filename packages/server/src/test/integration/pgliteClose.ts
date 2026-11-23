import { setTimeout, clearTimeout } from "node:timers";
import type { PGlite } from "@electric-sql/pglite";

// PGlite (0.4.4) spins forever, synchronously, when a statement runs on an instance that is
// closing or closed but got in before close() began: a query in flight when close() is called,
// one already queued behind another, or the next statement of a transaction that close() caught
// between statements. Nothing can end that spin, not even a timer: in CI a file just stopped
// until the shard watchdog killed it (#triage:#516). A statement that only starts after close()
// began is refused ("PGlite is closing"), and closing an instance nothing is using is safe, even
// with a transaction parked forever, as long as it never runs another statement.
//
// A test database can close while work the case never awaited still uses it (AgentOrchestrator's
// setIO starts sweeps that nothing drains). So each test PGlite is tracked from creation: its
// query / exec / transaction calls are counted while they run. Once a close is wanted, new calls
// are refused before they reach PGlite, and close() waits until none are running. If they don't
// finish in time, the instance is left open (abandoned) rather than closed under them.

interface Activity {
  running: number;
  closing: boolean;
  closed: boolean;
  idle: Array<() => void>;
}

const tracked = new WeakMap<PGlite, Activity>();
const COUNTED = ["query", "exec", "transaction"] as const;

/** Count the client's query / exec / transaction calls while they run, for closePgliteWhenIdle. Returns the client. */
export function trackPgliteActivity(client: PGlite): PGlite {
  if (tracked.has(client)) return client;
  const activity: Activity = { running: 0, closing: false, closed: false, idle: [] };
  tracked.set(client, activity);
  for (const name of COUNTED) {
    const original = (client[name] as (...args: unknown[]) => Promise<unknown>).bind(client);
    Object.defineProperty(client, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): Promise<unknown> => {
        // PGlite's own words for a statement that arrives during close().
        if (activity.closing) return Promise.reject(new Error(activity.closed ? "PGlite is closed" : "PGlite is closing"));
        activity.running += 1;
        return original(...args).finally(() => {
          activity.running -= 1;
          if (activity.running === 0) for (const wake of activity.idle.splice(0)) wake();
        });
      },
    });
  }
  return client;
}

/** How many query / exec / transaction calls on a tracked client are running now (0 when untracked). */
export function runningPgliteCalls(client: PGlite): number {
  return tracked.get(client)?.running ?? 0;
}

export type PgliteCloseOutcome = "closed" | "abandoned";

/**
 * Close a test PGlite once nothing uses it. From now on, new calls are refused. If calls are still
 * running after timeoutMs, it is left open ("abandoned"), never closed under them. An untracked
 * client is closed as it is.
 */
export async function closePgliteWhenIdle(client: PGlite, timeoutMs: number): Promise<PgliteCloseOutcome> {
  const activity = tracked.get(client);
  if (!activity) {
    await client.close();
    return "closed";
  }
  if (activity.closed) return "closed";
  activity.closing = true;
  if (activity.running > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = await Promise.race([
      new Promise<true>((resolve) => { activity.idle.push(() => resolve(true)); }),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!idle) return "abandoned";
  }
  // A concurrent call may have closed it while this one waited.
  if (activity.closed) return "closed";
  activity.closed = true;
  await client.close();
  return "closed";
}
