// Warm browsers (task #proj-workspace:#232): a check reuses a Browser Rendering session another
// check of the account left running, instead of launching one, and leaves its own running for the
// next while checks are coming. There is no shared memory between the checks' invocations (each
// is its own, runner.ts): the pool is Browser Rendering's own list of the account's sessions
// (`sessions()`), and each check decides alone, here.
//
// - Acquire: the sessions with no connection (none of them in use), younger than POOL_MAX_AGE_MS,
//   in a random order (two checks starting together seldom pick the same one); at most
//   POOL_CONNECT_TRIES of them connected to (`connect(sessionId)`), each within
//   POOL_CONNECT_TIMEOUT_MS. One is taken only with no context open in it but the browser's
//   default one: none left by an earlier check, none of a check that connected a moment before.
//   None to be had (none free, or every try failed, or the list itself failed): a launch, as
//   before, with keep_alive POOL_KEEP_ALIVE_MS. Launches stay at most one a dispatch, and the
//   run's dispatches are LAUNCH_SPACING_MS apart (Browser Rendering's 3 new browsers a second).
// - Release, once the check's own context is closed: the session is kept (disconnected, left
//   running for keep_alive) only when the check went well, no context of the check's is left
//   open, the session is younger than POOL_MAX_AGE_MS, another session is busy now (checks are
//   coming: a lone check keeps nothing warm), and fewer than POOL_IDLE_MAX sessions already wait.
//   Otherwise it is closed, so nothing idles after the last check of a burst but what the cap
//   allows. An idle session bills browser time until its keep_alive ends; that is the price of a
//   warm one, bounded by POOL_IDLE_MAX × POOL_KEEP_ALIVE_MS after a burst.
//
// - Off (CHECK_BROWSER_POOL "off", or absent: config.ts): a launch per check, closed after; the
//   account's sessions are never listed or connected to. Staging runs off while it shares an
//   account with production (README "Warm browsers").
// - A close is only ever of a session no other check is using: right before it, the session's
//   contexts are read again (Target.getBrowserContexts), and with one open that this check didn't
//   make (another check connected to the same free session at the same moment), or with the
//   read failing, the session is only disconnected ("left": neither kept nor closed; its
//   keep_alive ends it once that check is done).
//
// Isolation (isolation condition 2) is the context's, as before: each check makes a fresh incognito
// context (no cookies, storage, cache or service workers of any other context) and closes it; a
// session goes back only with none of the check's contexts open, and is taken only with no context
// open at all; the default context is never used (checkPage.ts offers no way to it). Pages of two
// Artifacts never share a context, so never a cookie, a store or a cache.
import type { CheckBrowser, CheckContext } from "./checkPage";
import type { LogFields } from "./log";

/** How long a session idles before Browser Rendering ends it (its default; up to 20 minutes are allowed). */
export const POOL_KEEP_ALIVE_MS = 60_000;
/** At most this many sessions are left waiting for a check; past it a check closes its own. */
export const POOL_IDLE_MAX = 3;
/**
 * A session older than this is neither taken nor kept: closed after its check, a fresh one
 * launched. At most 10 minutes: the bound process reuse rests on (README "Warm browsers").
 */
export const POOL_MAX_AGE_MS = 10 * 60_000;
/** At most this many free sessions are tried before a check launches its own. */
export const POOL_CONNECT_TRIES = 3;
/** The most one connection to a free session takes. */
export const POOL_CONNECT_TIMEOUT_MS = 5_000;

export interface PoolOptions {
  keepAliveMs: number;
  idleMax: number;
  maxAgeMs: number;
  connectTries: number;
  connectTimeoutMs: number;
}

export const POOL_OPTIONS: PoolOptions = {
  keepAliveMs: POOL_KEEP_ALIVE_MS,
  idleMax: POOL_IDLE_MAX,
  maxAgeMs: POOL_MAX_AGE_MS,
  connectTries: POOL_CONNECT_TRIES,
  connectTimeoutMs: POOL_CONNECT_TIMEOUT_MS,
};

/** A session as Browser Rendering lists it (`sessions()`): a `connectionId` while some client is connected. */
export interface PoolSession {
  sessionId: string;
  /** When it started, in ms since the epoch (seconds are taken too). */
  startTime: number;
  connectionId?: string;
}

/** A connected session, as the pool needs it. */
export interface SessionHandle {
  sessionId: string;
  /** Contexts open in it other than the browser's default one, as it had them when connected. */
  openContexts: number;
  /**
   * Contexts open in it now that this check didn't make (read fresh, not as connected): another
   * check's, connected to the same session. Throws when it can't be read.
   */
  othersOpen(): Promise<number>;
  /** Ends this connection and leaves the session running (for its keep_alive). */
  disconnect(): Promise<void>;
  /** Ends the session. */
  close(): Promise<void>;
}

/** Browser Rendering, as the pool reaches it (browser.ts over @cloudflare/puppeteer; the tests fake it). */
export interface PoolBackend<H extends SessionHandle> {
  sessions(): Promise<PoolSession[]>;
  connect(sessionId: string): Promise<H>;
  /** A new session with keep_alive `keepAliveMs`. Throws when none can be had (a limit, an outage). */
  launch(keepAliveMs: number): Promise<H>;
}

export interface Acquired<H extends SessionHandle> {
  handle: H;
  origin: "reused" | "launched";
  /** When the session started (ms since the epoch). */
  startedAt: number;
}

/** Kept for a later check; closed; or left (disconnected only: another check is using it, or that couldn't be ruled out). */
export type Released = "kept" | "closed" | "left";

const msOf = (time: number) => (time > 0 && time < 1e12 ? time * 1000 : time);

/** The sessions a check may take, in the order it tries them: free (no connection), young enough, at random; at most `connectTries`. */
export function reuseCandidates(sessions: readonly PoolSession[], now: number, options: PoolOptions, random: () => number = Math.random): PoolSession[] {
  const free = sessions.filter(
    (session) => typeof session.sessionId === "string" && session.sessionId !== "" && !session.connectionId && Number.isFinite(session.startTime) && now - msOf(session.startTime) < options.maxAgeMs,
  );
  // Fisher-Yates, so two checks listing the same sessions seldom try the same one first.
  for (let at = free.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [free[at], free[other]] = [free[other]!, free[at]!];
  }
  return free.slice(0, Math.max(0, options.connectTries));
}

export interface KeepInput {
  /** The check ran (its page opened, or its opening failed): its browser answered throughout. */
  healthy: boolean;
  /** The check's own contexts still open (a close that failed). */
  ownContextsOpen: number;
  sessionId: string;
  startedAt: number;
  now: number;
  /** The account's sessions now; null when they couldn't be listed. */
  sessions: readonly PoolSession[] | null;
}

/** Whether a session goes back to the pool after its check (see the top of this file). */
export function keepAfterCheck(input: KeepInput, options: PoolOptions): boolean {
  if (!input.healthy || input.ownContextsOpen > 0 || input.sessions === null) return false;
  if (input.now - input.startedAt >= options.maxAgeMs) return false;
  const others = input.sessions.filter((session) => session.sessionId !== input.sessionId);
  const busy = others.filter((session) => Boolean(session.connectionId)).length;
  const idle = others.length - busy;
  return busy > 0 && idle < options.idleMax;
}

class ConnectTimeout extends Error {
  override name = "TimeoutError";
}

/** `connect` (or any read), within `ms`; a connection that comes after is ended, so it holds nothing. */
async function connectWithin<T>(connect: () => Promise<T>, ms: number): Promise<T> {
  let late = false;
  const connecting = connect();
  connecting.then(
    (value) => {
      const handle = value as Partial<SessionHandle> | null;
      if (late && handle !== null && typeof handle === "object" && typeof handle.disconnect === "function") void handle.disconnect().catch(() => {});
    },
    () => {},
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connecting,
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(() => {
            late = true;
            reject(new ConnectTimeout());
          }, ms)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface PoolDeps {
  /** The pool on (CHECK_BROWSER_POOL "on"); off, a launch per check, closed after, and no other session ever listed or connected to. */
  enabled: boolean;
  now: () => number;
  /** For the pool's own lines (ids and codes only, log.ts). */
  note?: (event: string, fields: LogFields) => void;
  random?: () => number;
  options?: PoolOptions;
}

export interface SessionPool<H extends SessionHandle> {
  /** A free session of the account's, else a new one. Throws only when a launch fails. */
  acquire(): Promise<Acquired<H>>;
  /** Keeps the session for a later check or closes it (keepAfterCheck). Never throws. */
  release(acquired: Acquired<H>, outcome: { healthy: boolean; ownContextsOpen: number }): Promise<Released>;
}

export function createSessionPool<H extends SessionHandle>(backend: PoolBackend<H>, deps: PoolDeps): SessionPool<H> {
  const options = deps.options ?? POOL_OPTIONS;
  const note = deps.note ?? (() => {});
  return {
    async acquire() {
      if (!deps.enabled) return { handle: await backend.launch(options.keepAliveMs), origin: "launched", startedAt: deps.now() };
      let sessions: PoolSession[] = [];
      try {
        sessions = await backend.sessions();
      } catch {
        // No list: launch, as before the pool.
        note("pool.list_failed", {});
      }
      for (const candidate of reuseCandidates(Array.isArray(sessions) ? sessions : [], deps.now(), options, deps.random)) {
        let handle: H;
        try {
          handle = await connectWithin(() => backend.connect(candidate.sessionId), options.connectTimeoutMs);
        } catch {
          // Taken a moment ago, ended, or slow: the next.
          note("pool.connect_failed", {});
          continue;
        }
        if (handle.openContexts > 0) {
          // In use (another check connected first) or left with a context open: not this one.
          await handle.disconnect().catch(() => {});
          note("pool.session_busy", { count: handle.openContexts });
          continue;
        }
        return { handle, origin: "reused", startedAt: msOf(candidate.startTime) };
      }
      const startedAt = deps.now();
      return { handle: await backend.launch(options.keepAliveMs), origin: "launched", startedAt };
    },

    async release(acquired, outcome) {
      const close = async (): Promise<Released> => {
        try {
          await acquired.handle.close();
        } catch {
          // Its keep_alive ends it.
          note("pool.close_failed", {});
        }
        return "closed";
      };
      // Off: closed, as before the pool (no other check can have connected to it).
      if (!deps.enabled) return close();
      let sessions: PoolSession[] | null = null;
      if (outcome.healthy && outcome.ownContextsOpen === 0) {
        try {
          const listed = await backend.sessions();
          sessions = Array.isArray(listed) ? listed : null;
        } catch {
          sessions = null;
        }
      }
      const keep = keepAfterCheck({ ...outcome, sessionId: acquired.handle.sessionId, startedAt: acquired.startedAt, now: deps.now(), sessions }, options);
      if (keep) {
        try {
          await acquired.handle.disconnect();
          return "kept";
        } catch {
          // Fall through: closed, unless another check uses it.
        }
      }
      // Never closed under another check (two connected to one free session at once): its
      // contexts read again now, and only this check's (or none) let it close.
      let others: number | null = null;
      try {
        others = await connectWithin(() => acquired.handle.othersOpen(), options.connectTimeoutMs);
      } catch {
        others = null;
      }
      if (others === 0) return close();
      note("pool.session_shared", others === null ? {} : { count: others });
      await acquired.handle.disconnect().catch(() => {});
      return "left";
    },
  };
}

/**
 * The check's browser over an acquired session: each context it makes is counted until it is
 * closed, so `release` knows whether the check left one open (then the session is closed, never
 * kept). Released once; a second release answers as the first did.
 */
export function pooledCheckBrowser<H extends SessionHandle>(pool: SessionPool<H>, acquired: Acquired<H>, newContext: (handle: H) => Promise<CheckContext>): CheckBrowser {
  let open = 0;
  let released: Promise<Released> | null = null;
  return {
    origin: acquired.origin,
    async newContext() {
      // Counted before it exists: a context whose making failed half-way may still be there, so
      // it stays counted (the session is then closed, not kept).
      open += 1;
      const context = await newContext(acquired.handle);
      let closed = false;
      return {
        newPage: () => context.newPage(),
        async close() {
          await context.close();
          if (!closed) {
            closed = true;
            open -= 1;
          }
        },
      };
    },
    release(healthy) {
      released ??= pool.release(acquired, { healthy, ownContextsOpen: open });
      return released;
    },
  };
}
