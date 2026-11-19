import { inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";

// user id -> users.trace_user_id, for the trace export sink (traceUserIdTraceSink.ts),
// which runs synchronously and can't query. Filled for free where a request
// already reads the users row (auth), and in the background on a miss.

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 50_000;

type Entry = { value: string; expiresAt: number };
const cache = new Map<string, Entry>();
// userId -> the user's generation when the load was asked for (see `generations`).
const pending = new Map<string, number>();
let flushScheduled = false;

// Bumped by forgetTraceUserId. A background load that was asked for before a
// forget must not write its (old) value back afterwards: it would tie the
// rotated account to its old trace id again for a whole TTL.
const MAX_GENERATIONS = 50_000;
const generations = new Map<string, number>();
function generationOf(userId: string): number {
  return generations.get(userId) ?? 0;
}

export type TraceUserIdLoader = (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;

async function loadFromDb(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const rows = await getDb().select({ id: users.id, traceUserId: users.traceUserId })
    .from(users).where(inArray(users.id, [...userIds]));
  const found = new Map<string, string>();
  for (const row of rows) if (row.traceUserId) found.set(row.id, row.traceUserId);
  return found;
}

let loader: TraceUserIdLoader = loadFromDb;
let now: () => number = Date.now;

/**
 * The cached trace_user_id for a user, or undefined (then a background load is queued).
 * Past half its TTL a hit still returns the value and queues a reload, so a user who keeps
 * producing spans (a long-lived socket, no further auth read) never reaches expiry and never
 * has a span exported without the key. A value rotated on another task is still replaced
 * within the TTL, as before.
 */
export function cachedTraceUserId(userId: string): string | undefined {
  const entry = cache.get(userId);
  const t = now();
  if (entry && entry.expiresAt > t) {
    if (entry.expiresAt - t < TTL_MS / 2) requestTraceUserId(userId);
    return entry.value;
  }
  if (entry) cache.delete(userId);
  requestTraceUserId(userId);
  return undefined;
}

export function rememberTraceUserId(userId: string, traceUserId: string | null | undefined): void {
  if (!traceUserId) return;
  if (cache.size >= MAX_ENTRIES && !cache.has(userId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(userId);
  cache.set(userId, { value: traceUserId, expiresAt: now() + TTL_MS });
}

/**
 * Drop a user's entry after rotating trace_user_id (retirement). Call it after
 * the rotation has committed: a load started later then reads the new value,
 * and one already in flight is discarded (its generation is stale).
 */
export function forgetTraceUserId(userId: string): void {
  cache.delete(userId);
  pending.delete(userId);
  if (generations.size >= MAX_GENERATIONS && !generations.has(userId)) {
    const oldest = generations.keys().next().value;
    if (oldest !== undefined) generations.delete(oldest);
  }
  generations.set(userId, generationOf(userId) + 1);
}

function requestTraceUserId(userId: string): void {
  if (!pending.has(userId)) pending.set(userId, generationOf(userId));
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => { void flushPending(); }, 0).unref?.();
}

async function flushPending(): Promise<void> {
  flushScheduled = false;
  const batch = [...pending].slice(0, 500);
  for (const [id] of batch) pending.delete(id);
  if (pending.size > 0) scheduleFlush();
  if (batch.length === 0) return;
  const askedAt = new Map(batch);
  try {
    const found = await loader(batch.map(([id]) => id));
    for (const [id, value] of found) {
      // Forgotten while the load ran: the value read may be the one just rotated away.
      if (askedAt.get(id) !== generationOf(id)) continue;
      rememberTraceUserId(id, value);
    }
  } catch {
    // Tracing must never fail a request; the next span for these users retries.
  }
}

export const __traceUserIdForTests = {
  setLoader(next: TraceUserIdLoader | null) { loader = next ?? loadFromDb; },
  setNow(next: (() => number) | null) { now = next ?? Date.now; },
  flush: flushPending,
  reset() { cache.clear(); pending.clear(); generations.clear(); flushScheduled = false; },
};
