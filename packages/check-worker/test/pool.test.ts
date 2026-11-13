import assert from "node:assert/strict";
import test from "node:test";

import type { CheckContext } from "../src/checkPage";
import {
  createSessionPool,
  keepAfterCheck,
  pooledCheckBrowser,
  POOL_IDLE_MAX,
  POOL_KEEP_ALIVE_MS,
  POOL_MAX_AGE_MS,
  POOL_OPTIONS,
  reuseCandidates,
  type PoolBackend,
  type PoolSession,
  type SessionHandle,
} from "../src/pool";
import { fakeClock } from "./fakes";

/**
 * Warm browsers (src/pool.ts): which of the account's sessions a check may take, when it keeps its
 * own for the next check, and the acquire and release around a fake Browser Rendering: a free
 * session taken, a busy or broken one passed over, a launch when none is free; a session closed
 * after a lone check, an unhealthy one, one with a context still open, an old one, or one past the
 * idle cap.
 */

const NOW = Date.parse("2026-11-08T10:00:00.000Z");

const session = (sessionId: string, overrides: Partial<PoolSession> = {}): PoolSession => ({ sessionId, startTime: NOW - 60_000, ...overrides });

test("reuse candidates: free sessions only (no connection), younger than the max age, at most connectTries, in a random order", () => {
  const sessions = [
    session("a"),
    session("busy", { connectionId: "c1" }),
    session("b"),
    session("old", { startTime: NOW - POOL_MAX_AGE_MS }),
    session("c"),
    session("d"),
    session("", {}),
  ];
  const ids = (random: () => number) => reuseCandidates(sessions, NOW, POOL_OPTIONS, random).map((each) => each.sessionId);
  assert.equal(ids(() => 0.999).length, POOL_OPTIONS.connectTries);
  for (const random of [() => 0, () => 0.5, () => 0.999, Math.random]) {
    for (const id of ids(random)) assert.ok(["a", "b", "c", "d"].includes(id), id);
  }
  // Two orders for two draws: the shuffle depends on the draw.
  assert.notDeepEqual(ids(() => 0), ids(() => 0.999));
  // A start time in seconds is read as one.
  assert.deepEqual(
    reuseCandidates([session("s", { startTime: Math.floor((NOW - 1_000) / 1000) })], NOW, POOL_OPTIONS).map((each) => each.sessionId),
    ["s"],
  );
  assert.deepEqual(reuseCandidates([], NOW, POOL_OPTIONS), []);
});

test("keep after a check: only a healthy one with no context of its own open, a young session, others busy, fewer than the idle cap waiting", () => {
  const base = { healthy: true, ownContextsOpen: 0, sessionId: "me", startedAt: NOW - 60_000, now: NOW };
  const busyOther = [session("me", { connectionId: "mine" }), session("other", { connectionId: "c" })];
  assert.equal(keepAfterCheck({ ...base, sessions: busyOther }, POOL_OPTIONS), true);
  // A lone check keeps nothing warm: no other session busy.
  assert.equal(keepAfterCheck({ ...base, sessions: [session("me", { connectionId: "mine" }), session("idle")] }, POOL_OPTIONS), false);
  // Unhealthy, a context left open, no list, too old: closed.
  assert.equal(keepAfterCheck({ ...base, healthy: false, sessions: busyOther }, POOL_OPTIONS), false);
  assert.equal(keepAfterCheck({ ...base, ownContextsOpen: 1, sessions: busyOther }, POOL_OPTIONS), false);
  assert.equal(keepAfterCheck({ ...base, sessions: null }, POOL_OPTIONS), false);
  assert.equal(keepAfterCheck({ ...base, startedAt: NOW - POOL_MAX_AGE_MS, sessions: busyOther }, POOL_OPTIONS), false);
  // The idle cap: POOL_IDLE_MAX already waiting, so this one closes.
  const idle = Array.from({ length: POOL_IDLE_MAX }, (_, at) => session(`idle${at}`));
  assert.equal(keepAfterCheck({ ...base, sessions: [...busyOther, ...idle.slice(1)] }, POOL_OPTIONS), true);
  assert.equal(keepAfterCheck({ ...base, sessions: [...busyOther, ...idle] }, POOL_OPTIONS), false);
});

interface FakeHandle extends SessionHandle {
  disconnected: boolean;
  closed: boolean;
}

/** Browser Rendering's session API, faked: `sessions` listed, `connect` per id (an Error, a hang, or the contexts open), launches counted. */
function fakeBackend(options: {
  sessions: PoolSession[] | Error | Array<PoolSession[] | Error>;
  connect?: Record<string, Error | number | "hang">;
  /** What each session's fresh read of other checks' contexts answers (default 0). */
  others?: Record<string, Error | number | "hang">;
  launchFails?: Error;
}) {
  const handles: FakeHandle[] = [];
  const connects: string[] = [];
  const launches: number[] = [];
  const listed: number[] = [];
  const othersRead: string[] = [];
  const lists = Array.isArray(options.sessions) && options.sessions.some((each) => Array.isArray(each) || each instanceof Error) ? [...(options.sessions as Array<PoolSession[] | Error>)] : null;
  const handleOf = (sessionId: string, openContexts: number): FakeHandle => {
    const handle: FakeHandle = {
      sessionId,
      openContexts,
      disconnected: false,
      closed: false,
      othersOpen: async () => {
        othersRead.push(sessionId);
        const given = options.others?.[sessionId] ?? 0;
        if (given instanceof Error) throw given;
        if (given === "hang") return new Promise<number>(() => {});
        return given;
      },
      disconnect: async () => void (handle.disconnected = true),
      close: async () => void (handle.closed = true),
    };
    handles.push(handle);
    return handle;
  };
  const backend: PoolBackend<FakeHandle> = {
    async sessions() {
      listed.push(1);
      const next = lists !== null ? (lists.shift() ?? []) : (options.sessions as PoolSession[] | Error);
      if (next instanceof Error) throw next;
      return next;
    },
    async connect(sessionId) {
      connects.push(sessionId);
      const given = options.connect?.[sessionId] ?? 0;
      if (given instanceof Error) throw given;
      if (given === "hang") return new Promise<FakeHandle>(() => {});
      return handleOf(sessionId, given);
    },
    async launch(keepAliveMs) {
      launches.push(keepAliveMs);
      if (options.launchFails) throw options.launchFails;
      return handleOf(`new${launches.length}`, 0);
    },
  };
  return { backend, handles, connects, launches, listed, othersRead };
}

const poolDeps = (notes: string[] = []) => ({ enabled: true, now: fakeClock(NOW).now, note: (event: string) => void notes.push(event), random: () => 0 });

test("acquire: a free session is connected to and taken; a launch only when none is free", async () => {
  const fake = fakeBackend({ sessions: [session("busy", { connectionId: "c" }), session("free")] });
  const pool = createSessionPool(fake.backend, poolDeps());
  const acquired = await pool.acquire();
  assert.deepEqual([acquired.origin, acquired.handle.sessionId, acquired.startedAt], ["reused", "free", NOW - 60_000]);
  assert.deepEqual(fake.connects, ["free"]);
  assert.deepEqual(fake.launches, []);

  const none = fakeBackend({ sessions: [session("busy", { connectionId: "c" })] });
  const launched = await createSessionPool(none.backend, poolDeps()).acquire();
  assert.deepEqual([launched.origin, launched.handle.sessionId, launched.startedAt], ["launched", "new1", NOW]);
  assert.deepEqual(none.launches, [POOL_KEEP_ALIVE_MS], "launched with the pool's keep_alive");
});

test("acquire: a session with a context open is left (disconnected), a connect that fails or hangs is passed over, then a launch", async () => {
  const notes: string[] = [];
  const fake = fakeBackend({
    sessions: [session("inUse"), session("gone"), session("slow")],
    connect: { inUse: 1, gone: new Error("Unable to connect to existing session gone"), slow: "hang" },
  });
  const pool = createSessionPool(fake.backend, { ...poolDeps(notes), options: { ...POOL_OPTIONS, connectTimeoutMs: 5 } });
  const acquired = await pool.acquire();
  assert.equal(acquired.origin, "launched");
  assert.deepEqual([...fake.connects].sort(), ["gone", "inUse", "slow"]);
  const inUse = fake.handles.find((each) => each.sessionId === "inUse")!;
  assert.deepEqual([inUse.disconnected, inUse.closed], [true, false], "another check's session is left running, never closed");
  assert.deepEqual(notes.sort(), ["pool.connect_failed", "pool.connect_failed", "pool.session_busy"]);
});

test("acquire: no list (an error) launches; a launch that fails throws (the check is browser_unavailable)", async () => {
  const listFails = fakeBackend({ sessions: new Error("Unable to fetch new sessions: code: 500") });
  assert.equal((await createSessionPool(listFails.backend, poolDeps()).acquire()).origin, "launched");
  const launchFails = fakeBackend({ sessions: [], launchFails: new Error("Unable to create new browser: code: 429") });
  await assert.rejects(createSessionPool(launchFails.backend, poolDeps()).acquire(), /429/);
});

test("release: kept (disconnected) while other checks run; closed after a lone check, an unhealthy one, or one with a context still open", async () => {
  const run = async (listed: PoolSession[] | Error, outcome: { healthy: boolean; ownContextsOpen: number }) => {
    const fake = fakeBackend({ sessions: [[session("free")], listed] });
    const pool = createSessionPool(fake.backend, poolDeps());
    const acquired = await pool.acquire();
    const released = await pool.release(acquired, outcome);
    return { released, handle: acquired.handle as FakeHandle };
  };
  const busy = [session("free", { connectionId: "mine" }), session("other", { connectionId: "c" })];
  const kept = await run(busy, { healthy: true, ownContextsOpen: 0 });
  assert.deepEqual([kept.released, kept.handle.disconnected, kept.handle.closed], ["kept", true, false]);
  for (const [listed, outcome] of [
    [[session("free", { connectionId: "mine" })], { healthy: true, ownContextsOpen: 0 }],
    [busy, { healthy: false, ownContextsOpen: 0 }],
    [busy, { healthy: true, ownContextsOpen: 1 }],
    [new Error("list failed"), { healthy: true, ownContextsOpen: 0 }],
  ] as const) {
    const closed = await run(listed as PoolSession[] | Error, outcome);
    assert.deepEqual([closed.released, closed.handle.disconnected, closed.handle.closed], ["closed", false, true]);
  }
});

test("release never throws: a disconnect that fails closes; a close that fails is left to keep_alive", async () => {
  const handle: SessionHandle = {
    sessionId: "s",
    openContexts: 0,
    othersOpen: async () => 0,
    disconnect: async () => {
      throw new Error("socket gone");
    },
    close: async () => {
      throw new Error("socket gone");
    },
  };
  const backend: PoolBackend<SessionHandle> = {
    sessions: async () => [session("s", { connectionId: "mine" }), session("other", { connectionId: "c" })],
    connect: async () => handle,
    launch: async () => handle,
  };
  const notes: string[] = [];
  const pool = createSessionPool(backend, poolDeps(notes));
  assert.equal(await pool.release({ handle, origin: "reused", startedAt: NOW }, { healthy: true, ownContextsOpen: 0 }), "closed");
  assert.deepEqual(notes, ["pool.close_failed"]);
});

test("the check's browser counts its contexts: one left open (or half made) closes the session; released once", async () => {
  const releases: Array<{ healthy: boolean; ownContextsOpen: number }> = [];
  const pool = {
    acquire: async () => ({ handle: {} as SessionHandle, origin: "reused" as const, startedAt: NOW }),
    release: async (_acquired: unknown, outcome: { healthy: boolean; ownContextsOpen: number }) => (releases.push(outcome), "kept" as const),
  };
  const acquired = await pool.acquire();
  let made = 0;
  const context = (): CheckContext => ({ newPage: async () => ({}) as never, close: async () => {} });
  const browser = pooledCheckBrowser(pool, acquired, async () => {
    made += 1;
    if (made === 3) throw new Error("target closed");
    return context();
  });
  assert.equal(browser.origin, "reused");
  const first = await browser.newContext();
  await first.close();
  await first.close();
  assert.equal(await browser.release(true), "kept");
  assert.equal(await browser.release(false), "kept", "a second release answers as the first");
  assert.deepEqual(releases, [{ healthy: true, ownContextsOpen: 0 }]);

  releases.length = 0;
  const again = pooledCheckBrowser(pool, acquired, async () => {
    made += 1;
    if (made === 3) throw new Error("target closed");
    return context();
  });
  await again.newContext(); // left open
  await assert.rejects(again.newContext(), /target closed/); // half made
  await again.release(true);
  assert.deepEqual(releases, [{ healthy: true, ownContextsOpen: 2 }]);
});

test("the bound process reuse rests on: a session lives in the pool at most 10 minutes", () => {
  assert.ok(POOL_MAX_AGE_MS <= 10 * 60_000, `POOL_MAX_AGE_MS is ${POOL_MAX_AGE_MS}`);
  assert.ok(POOL_OPTIONS.maxAgeMs <= 10 * 60_000);
});

test("a close is never under another check: a context it didn't make open now (two checks on one free session), or a read that fails or hangs, only disconnects", async () => {
  for (const others of [1, new Error("Target.getBrowserContexts failed"), "hang"] as const) {
    const notes: string[] = [];
    // Both connected while it was free: at connect time neither saw the other's context.
    const fake = fakeBackend({ sessions: [[session("free")], [session("free", { connectionId: "c" })]], others: { free: others } });
    const pool = createSessionPool(fake.backend, { ...poolDeps(notes), options: { ...POOL_OPTIONS, connectTimeoutMs: 5 } });
    const acquired = await pool.acquire();
    assert.equal(acquired.handle.openContexts, 0);
    // A lone check by the list (no other session busy): it would close the session.
    const released = await pool.release(acquired, { healthy: true, ownContextsOpen: 0 });
    const handle = acquired.handle as FakeHandle;
    assert.deepEqual([released, handle.disconnected, handle.closed], ["left", true, false], String(others));
    assert.deepEqual(fake.othersRead, ["free"], "read again right before the close");
    assert.ok(notes.includes("pool.session_shared"));
  }
  // Read again and only this check's (none open now): closed.
  const alone = fakeBackend({ sessions: [[session("free")], [session("free", { connectionId: "c" })]] });
  const pool = createSessionPool(alone.backend, poolDeps());
  const acquired = await pool.acquire();
  assert.equal(await pool.release(acquired, { healthy: false, ownContextsOpen: 0 }), "closed");
  assert.deepEqual(alone.othersRead, ["free"]);
});

test("the pool off (CHECK_BROWSER_POOL not \"on\"): a launch per check, closed after; no session listed, connected to or read", async () => {
  const fake = fakeBackend({ sessions: [session("free"), session("other", { connectionId: "c" })] });
  const pool = createSessionPool(fake.backend, { ...poolDeps(), enabled: false });
  const acquired = await pool.acquire();
  assert.deepEqual([acquired.origin, acquired.handle.sessionId], ["launched", "new1"]);
  assert.equal(await pool.release(acquired, { healthy: true, ownContextsOpen: 0 }), "closed");
  assert.deepEqual([fake.listed.length, fake.connects.length, fake.othersRead.length], [0, 0, 0]);
  assert.deepEqual(fake.launches, [POOL_KEEP_ALIVE_MS]);
  assert.equal((acquired.handle as FakeHandle).closed, true);
});
