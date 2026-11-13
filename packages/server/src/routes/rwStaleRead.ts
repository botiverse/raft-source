import type { NextFunction, Request, Response } from "express";
import { getBoundedRedis } from "../redis";
import { risingWaveStaleCacheSkippedTotal, risingWaveStaleCacheWriteBytes, risingWaveStaleResponsesTotal } from "../metrics";
import { traceIdentityHash } from "../tracing/traceIdentity";
import { addTraceEvent } from "../tracing/semanticTrace";
import { findRisingWaveOverload } from "./errorResponse";

// Degraded mode for the sidebar / Activity reads while RisingWave is
// overloaded (old-chain compaction regrouping, 2026-10). A client that already
// has the page open keeps its last counts across a 503; one that just opened
// the page, switched server or signed in got a 503 and an empty view. So every
// successful read stores its response body per (surface, user, scope), and:
// - an rw_overloaded read answers with a remembered body up to
//   OVERLOAD_MAX_AGE_MS old (header X-Raft-Stale: rw_overloaded). Only
//   rw_overloaded: any other failure keeps its own error, so a real bug is
//   never hidden behind old data;
// - with `softTimeoutMs` (the unread summary and Inbox only), a read still
//   running after it answers with a remembered body up to SOFT_MAX_AGE_MS old
//   (X-Raft-Stale: rw_slow). The read is not cancelled or retried: it runs to
//   the end and refreshes the remembered body, so a slow RW gets no extra
//   query. Older or no remembered body: the request waits as before.
// Entries live STALE_TTL_SECONDS, longer than either age limit, so a miss can
// say whether there was never a body or only a too old one.
//
// A remembered body is never served to a user if it was read before that
// user's own latest inbox write (done, read, unread, follow, mute, ...):
// otherwise the item they just marked reappears for up to OVERLOAD_MAX_AGE_MS
// (Tenny, #proj-data task #7). Each such write records its time per user
// (noteInboxWriteBeforeReply) before it answers, and a body's writtenAtMs is
// when its read started. A body read after the write can still miss it by RW's
// own lag; that is the same as a live read, and the client's overlay covers it.
//
// While RisingWave is overloaded (an rw_overloaded seen in this process in the
// last COALESCE_WINDOW_MS), identical reads already in flight share one RW read:
// a client retry plus a few tabs otherwise queue the same read several times in
// the RW pool during a wave. Outside a wave every request reads for itself, so
// a read issued right after a mark-read never joins one started before it.

export type StaleReadSurface =
  | "channels_unread"
  | "channels_unread_summary"
  | "servers_unread_summary"
  | "inbox_first_page"
  | "followed_threads";

// 10 minutes: past both age limits, so `too_old` is observable, without the
// memory of an hour-long TTL (Tenny, 10-15).
export const STALE_TTL_SECONDS = 600;
export const OVERLOAD_MAX_AGE_MS = 300_000;
export const SOFT_MAX_AGE_MS = 60_000;
const REDIS_DEADLINE_MS = 200;
// v2 stores { writtenAtMs, value }; v1 entries are simply never read again.
const KEY_PREFIX = "rw-stale:v2";
// Per user: when they last changed their own inbox state. Kept STALE_TTL_SECONDS,
// past OVERLOAD_MAX_AGE_MS, so it outlives every body it could reject.
const INBOX_WRITE_KEY_PREFIX = "rw-stale:inbox-write-at";

/** `RW_STALE_MAX_VALUE_BYTES` (default 256 KiB): larger bodies are not remembered. */
export function resolveMaxValueBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RW_STALE_MAX_VALUE_BYTES?.trim();
  if (!raw) return 262_144;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 262_144;
}

/** `RW_STALE_SOFT_TIMEOUT_MS` (default 1500, ~p99 of the two routes; 0 disables). */
export function resolveSoftTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RW_STALE_SOFT_TIMEOUT_MS?.trim();
  if (!raw) return 1_500;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1_500;
}
export const STALE_RESPONSE_HEADER = "X-Raft-Stale";

export type StaleReadStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

let storeOverride: StaleReadStore | null | undefined;

/** TEST-ONLY: replace the Redis store (null = no store; undefined restores Redis). */
export function __setStaleReadStoreForTests(store: StaleReadStore | null | undefined): void {
  storeOverride = store;
}

function staleStore(): StaleReadStore | null {
  if (storeOverride !== undefined) return storeOverride;
  const redis = getBoundedRedis(REDIS_DEADLINE_MS);
  if (!redis) return null;
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, "EX", ttlSeconds);
    },
  };
}

const COALESCE_WINDOW_MS = 30_000;
let lastOverloadAtMs = Number.NEGATIVE_INFINITY;

/** TEST-ONLY: forget the last overload (coalescing off until the next one). */
export function __resetStaleReadOverloadForTests(): void {
  lastOverloadAtMs = Number.NEGATIVE_INFINITY;
}

function inOverloadWindow(): boolean {
  return Date.now() - lastOverloadAtMs < COALESCE_WINDOW_MS;
}

/**
 * This process saw an rw_overloaded in the last COALESCE_WINDOW_MS: the "RW is
 * overloaded right now" signal for callers that would otherwise add optional
 * reads (`/events?wait_for=` skips its wait while it holds).
 */
export function isRisingWaveOverloadRecent(): boolean {
  return inOverloadWindow();
}

/**
 * This process saw an rw_overloaded within the last `ms` (the closed-server
 * purge stops its run on one in the last 5 minutes). Process-local, like the
 * window above: another replica's overloads are not seen here.
 */
export function isRisingWaveOverloadSeenWithin(ms: number, nowMs: number = Date.now()): boolean {
  return nowMs - lastOverloadAtMs < ms;
}

/** Record an rw_overloaded seen outside readWithStaleOnOverload (opens the same window). */
export function noteRisingWaveOverloadSeen(atMs: number = Date.now()): void {
  lastOverloadAtMs = Math.max(lastOverloadAtMs, atMs);
}

const inFlight = new Map<string, Promise<unknown>>();

// Slow reads a soft timeout stopped waiting for, still running, by key. At most
// one per key: while it runs, a new request for the key does not start another
// RW read (it answers from a fresh enough body, or waits on this read), so
// background reads cannot pile up on the RW pool when RisingWave is slow.
const backgroundReads = new Map<string, Promise<unknown>>();

export type StaleReason = "rw_overloaded" | "rw_slow";

export type StaleReadResult<T> = {
  value: T;
  stale: boolean;
  staleReason?: StaleReason;
  /** Trace attrs for the route's response.ready: what this request wrote to (or served from) the cache. */
  traceAttrs: Record<string, string | number>;
};

/** `writtenAtMs`: when the read that produced `value` started. */
type Remembered = { writtenAtMs: number; value: unknown };

/**
 * Runs `load` (or joins an identical read in flight), remembers the result,
 * and answers with a remembered result when RisingWave is overloaded or (with
 * `softTimeoutMs`) slow. The key is per user: `scope` must hold everything
 * else the body depends on.
 */
export async function readWithStaleOnOverload<T>(input: {
  surface: StaleReadSurface;
  userId: string;
  scope: string;
  load: () => Promise<T>;
  softTimeoutMs?: number;
}): Promise<StaleReadResult<T>> {
  const key = `${KEY_PREFIX}:${input.surface}:${input.userId}:${input.scope}`;
  const keyHash = traceIdentityHash("stale_cache_key_hash", key);
  const keyAttrs: Record<string, string> = keyHash ? { stale_cache_key_hash: keyHash } : {};
  const background = backgroundReads.get(key) as Promise<T> | undefined;
  if (background && (input.softTimeoutMs ?? 0) > 0) {
    const { remembered } = await recallServable(key, input.userId, SOFT_MAX_AGE_MS);
    if (remembered) {
      risingWaveStaleResponsesTotal.labels(input.surface).inc();
      addTraceEvent("rw_slow.stale_served", {
        surface: input.surface,
        stale_age_ms: Date.now() - remembered.writtenAtMs,
        background_read_running: true,
      });
      return { value: remembered.value as T, stale: true, staleReason: "rw_slow", traceAttrs: keyAttrs };
    }
  }
  const coalescing = inOverloadWindow();
  let pending = background ?? (coalescing ? inFlight.get(key) as Promise<T> | undefined : undefined);
  const joined = pending !== undefined;
  const readStartedAtMs = Date.now();
  if (pending === undefined) {
    const started = input.load();
    pending = started;
    if (coalescing) {
      inFlight.set(key, started);
      const clear = () => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      };
      started.then(clear, clear);
    }
  } else {
    addTraceEvent("rw_read.coalesced", { surface: input.surface });
  }
  // The read always runs to the end and refreshes the cache, whether or not
  // this request still waits for it.
  const settled = pending.then(
    (value) => {
      const bytes = joined ? undefined : remember(input.surface, key, value, readStartedAtMs);
      return { ok: true as const, value, bytes };
    },
    (error: unknown) => ({ ok: false as const, error }),
  );

  const softTimeoutMs = input.softTimeoutMs ?? 0;
  if (softTimeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), softTimeoutMs); }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      const { remembered, missReason } = await recallServable(key, input.userId, SOFT_MAX_AGE_MS);
      if (remembered) {
        if (!joined) {
          const running = pending;
          backgroundReads.set(key, running);
          const clear = () => {
            if (backgroundReads.get(key) === running) backgroundReads.delete(key);
          };
          running.then(clear, clear);
        }
        risingWaveStaleResponsesTotal.labels(input.surface).inc();
        addTraceEvent("rw_slow.stale_served", { surface: input.surface, stale_age_ms: Date.now() - remembered.writtenAtMs });
        return { value: remembered.value as T, stale: true, staleReason: "rw_slow", traceAttrs: keyAttrs };
      }
      addTraceEvent("rw_slow.stale_missed", { surface: input.surface, reason: missReason! });
    }
  }

  const outcome = await settled;
  if (outcome.ok) {
    return {
      value: outcome.value,
      stale: false,
      traceAttrs: { ...keyAttrs, ...(outcome.bytes === undefined ? {} : { stale_cache_bytes: outcome.bytes }) },
    };
  }
  const error = outcome.error;
  const overload = findRisingWaveOverload(error);
  if (!overload) throw error;
  lastOverloadAtMs = Date.now();
  const { remembered, missReason } = await recallServable(key, input.userId, OVERLOAD_MAX_AGE_MS);
  // Which overload (pool_acquire_timeout / rw_internal_resets / rw_unreachable), so a restart window is countable.
  const overloadReason = overload.reason;
  if (!remembered) {
    addTraceEvent("rw_overload.stale_missed", { surface: input.surface, reason: missReason!, overload_reason: overloadReason });
    throw error;
  }
  risingWaveStaleResponsesTotal.labels(input.surface).inc();
  addTraceEvent("rw_overload.stale_served", { surface: input.surface, stale_age_ms: Date.now() - remembered.writtenAtMs, overload_reason: overloadReason });
  return { value: remembered.value as T, stale: true, staleReason: "rw_overloaded", traceAttrs: keyAttrs };
}

/** Stores the body in the background; returns its size in bytes (or undefined with no store). */
function remember(surface: StaleReadSurface, key: string, value: unknown, readStartedAtMs: number): number | undefined {
  const store = staleStore();
  if (!store) return undefined;
  let body: string;
  try {
    body = JSON.stringify({ writtenAtMs: readStartedAtMs, value } satisfies Remembered);
  } catch {
    return undefined;
  }
  const bytes = Buffer.byteLength(body, "utf8");
  risingWaveStaleCacheWriteBytes.labels(surface).observe(bytes);
  // A very large body (followed threads of a user following thousands of
  // threads, up to 4.7 MB on 10-16) is not remembered: it would dominate the
  // cache's Redis memory for one user's fallback.
  if (bytes > resolveMaxValueBytes()) {
    risingWaveStaleCacheSkippedTotal.labels(surface).inc();
    return undefined;
  }
  store.set(key, body, STALE_TTL_SECONDS).catch(() => {
    // Best effort: a missed write only means no fallback for this key.
  });
  return bytes;
}

async function recall(key: string): Promise<Remembered | undefined> {
  const store = staleStore();
  if (!store) return undefined;
  try {
    const raw = await store.get(key);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<Remembered>;
    return typeof parsed.writtenAtMs === "number" && "value" in parsed
      ? { writtenAtMs: parsed.writtenAtMs, value: parsed.value }
      : undefined;
  } catch {
    return undefined;
  }
}

type StaleMissReason = "never" | "too_old" | "before_own_write";

/** The remembered body if it may be served: young enough and read after the user's latest inbox write. */
async function recallServable(
  key: string,
  userId: string,
  maxAgeMs: number,
): Promise<{ remembered?: Remembered; missReason?: StaleMissReason }> {
  const [remembered, lastWriteAtMs] = await Promise.all([recall(key), recallInboxWriteAt(userId)]);
  if (!remembered) return { missReason: "never" };
  if (Date.now() - remembered.writtenAtMs > maxAgeMs) return { missReason: "too_old" };
  if (lastWriteAtMs !== undefined && remembered.writtenAtMs <= lastWriteAtMs) return { missReason: "before_own_write" };
  return { remembered };
}

async function recallInboxWriteAt(userId: string): Promise<number | undefined> {
  const store = staleStore();
  if (!store) return undefined;
  try {
    const raw = await store.get(`${INBOX_WRITE_KEY_PREFIX}:${userId}`);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Records that `userId` changed their own inbox state now. Best effort, bounded by the Redis deadline. */
export async function noteInboxWrite(userId: string, atMs: number = Date.now()): Promise<void> {
  const store = staleStore();
  if (!store) return;
  try {
    await store.set(`${INBOX_WRITE_KEY_PREFIX}:${userId}`, String(atMs), STALE_TTL_SECONDS);
  } catch {
    // Without the mark a fallback may serve a pre-write body, as before.
  }
}

/**
 * Middleware for routes that change the caller's own inbox state: a successful
 * reply is sent only after the write is noted, so the client's next read cannot
 * be answered from a body read before it. It hooks `res.json` only: a route that
 * replies another way (`res.status(204).end()`, `res.send`) silently stops
 * noting its writes, so keep these routes on `res.json` or note explicitly.
 */
export function noteInboxWriteBeforeReply<P>(req: Request<P>, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body?: unknown) => {
    const userId = req.userId;
    if (!userId || res.statusCode >= 400) return json(body);
    void noteInboxWrite(userId).finally(() => json(body));
    return res;
  }) as Response["json"];
  next();
}
