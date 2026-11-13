import { test } from "vitest";
import assert from "node:assert/strict";
import { RisingWaveOverloadedError, RisingWaveReadError } from "../db/risingwave";
import type { NextFunction, Request, Response } from "express";
import {
  __resetStaleReadOverloadForTests,
  __setStaleReadStoreForTests,
  noteInboxWrite,
  noteInboxWriteBeforeReply,
  OVERLOAD_MAX_AGE_MS,
  readWithStaleOnOverload,
  SOFT_MAX_AGE_MS,
} from "./rwStaleRead";

function memoryStore() {
  const entries = new Map<string, string>();
  return {
    entries,
    store: {
      get: async (key: string) => entries.get(key) ?? null,
      set: async (key: string, value: string) => { entries.set(key, value); },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (result: { value: unknown; stale: boolean }) => ({ value: result.value, stale: result.stale });

function deferredLoad() {
  let loads = 0;
  const releases: Array<(value: { n: number }) => void> = [];
  const load = () => {
    loads += 1;
    return new Promise<{ n: number }>((resolve) => { releases.push(resolve); });
  };
  return { load, releases, loads: () => loads };
}

test("outside an overload, identical reads do not share a load", async () => {
  __setStaleReadStoreForTests(null);
  __resetStaleReadOverloadForTests();
  try {
    // A read issued after a mark-read must not join one started before it.
    const reads = deferredLoad();
    const before = readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s1", load: reads.load });
    const after = readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s1", load: reads.load });
    assert.equal(reads.loads(), 2);
    reads.releases[0]!({ n: 1 });
    reads.releases[1]!({ n: 2 });
    assert.deepEqual(pick(await before), { value: { n: 1 }, stale: false });
    assert.deepEqual(pick(await after), { value: { n: 2 }, stale: false });
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("right after an rw_overloaded, identical reads in flight share one load", async () => {
  __setStaleReadStoreForTests(null);
  __resetStaleReadOverloadForTests();
  try {
    await assert.rejects(readWithStaleOnOverload({
      surface: "channels_unread", userId: "u0", scope: "s0",
      load: async () => { throw new RisingWaveOverloadedError(new Error("pool timeout")); },
    }));
    let loads = 0;
    let release!: (value: { n: number }) => void;
    const load = () => {
      loads += 1;
      return new Promise<{ n: number }>((resolve) => { release = resolve; });
    };
    const a = readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s1", load });
    const b = readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s1", load });
    const otherUser = readWithStaleOnOverload({ surface: "channels_unread", userId: "u2", scope: "s1", load: async () => ({ n: 2 }) });
    release({ n: 1 });
    assert.deepEqual(pick(await a), { value: { n: 1 }, stale: false });
    assert.deepEqual(pick(await b), { value: { n: 1 }, stale: false });
    assert.deepEqual(pick(await otherUser), { value: { n: 2 }, stale: false });
    assert.equal(loads, 1);

    // Once settled, the next read loads again.
    const c = readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s1", load: async () => ({ n: 3 }) });
    assert.deepEqual(pick(await c), { value: { n: 3 }, stale: false });
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("only rw_overloaded falls back, and only to the same user and scope", async () => {
  const memory = memoryStore();
  __setStaleReadStoreForTests(memory.store);
  try {
    await readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s1:all", load: async () => ({ items: [1] }) });
    await flush();

    const overloaded = async () => { throw new RisingWaveOverloadedError(new Error("pool timeout")); };
    assert.deepEqual(
      pick(await readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s1:all", load: overloaded })),
      { value: { items: [1] }, stale: true },
    );
    // Wrapped (cause chain) overload counts too.
    await assert.doesNotReject(readWithStaleOnOverload({
      surface: "inbox_first_page", userId: "u1", scope: "s1:all",
      load: async () => { throw new Error("outer", { cause: new RisingWaveOverloadedError(new Error("pool timeout")) }); },
    }));
    await assert.rejects(
      readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s1:unread", load: overloaded }),
      RisingWaveOverloadedError,
    );
    await assert.rejects(
      readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u2", scope: "s1:all", load: overloaded }),
      RisingWaveOverloadedError,
    );
    await assert.rejects(
      readWithStaleOnOverload({
        surface: "inbox_first_page", userId: "u1", scope: "s1:all",
        load: async () => { throw new RisingWaveReadError(new Error("ECONNREFUSED")); },
      }),
      RisingWaveReadError,
    );
    await assert.rejects(
      readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s1:all", load: async () => { throw new TypeError("bug"); } }),
      TypeError,
    );
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("a store failure never turns into a request failure", async () => {
  __setStaleReadStoreForTests({
    get: async () => { throw new Error("redis down"); },
    set: async () => { throw new Error("redis down"); },
  });
  try {
    assert.deepEqual(
      pick(await readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s1", load: async () => ({ ok: true }) })),
      { value: { ok: true }, stale: false },
    );
    await flush();
    await assert.rejects(
      readWithStaleOnOverload({
        surface: "channels_unread", userId: "u1", scope: "s1",
        load: async () => { throw new RisingWaveOverloadedError(new Error("pool timeout")); },
      }),
      RisingWaveOverloadedError,
    );
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

// A store pre-loaded with one remembered body of a given age, as v2 stores it.
function storeWith(key: string, value: unknown, ageMs: number) {
  const memory = memoryStore();
  memory.entries.set(key, JSON.stringify({ writtenAtMs: Date.now() - ageMs, value }));
  return memory;
}

test("a slow read past the soft timeout answers with a fresh remembered body, then refreshes it", async () => {
  __resetStaleReadOverloadForTests();
  const memory = storeWith("rw-stale:v2:servers_unread_summary:u1:all", [{ old: true }], 10_000);
  __setStaleReadStoreForTests(memory.store);
  try {
    let finished = false;
    const result = await readWithStaleOnOverload({
      surface: "servers_unread_summary", userId: "u1", scope: "all", softTimeoutMs: 30,
      load: async () => { await sleep(150); finished = true; return [{ fresh: true }]; },
    });
    assert.deepEqual(pick(result), { value: [{ old: true }], stale: true });
    assert.equal(result.staleReason, "rw_slow");
    assert.equal(finished, false, "answered before the slow read finished");
    // The slow read was not cancelled: it finishes and refreshes the body.
    await sleep(250);
    assert.equal(finished, true);
    const stored = JSON.parse(memory.entries.get("rw-stale:v2:servers_unread_summary:u1:all")!);
    assert.deepEqual(stored.value, [{ fresh: true }]);
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("past the soft timeout with only a too old (or no) body, the request waits for the read", async () => {
  __resetStaleReadOverloadForTests();
  for (const memory of [storeWith("rw-stale:v2:inbox_first_page:u1:s", { old: true }, SOFT_MAX_AGE_MS + 5_000), memoryStore()]) {
    __setStaleReadStoreForTests(memory.store);
    try {
      const result = await readWithStaleOnOverload({
        surface: "inbox_first_page", userId: "u1", scope: "s", softTimeoutMs: 20,
        load: async () => { await sleep(80); return { fresh: true }; },
      });
      assert.deepEqual(pick(result), { value: { fresh: true }, stale: false });
    } finally {
      __setStaleReadStoreForTests(undefined);
    }
  }
});

test("without softTimeoutMs a slow read is simply waited for", async () => {
  __resetStaleReadOverloadForTests();
  __setStaleReadStoreForTests(storeWith("rw-stale:v2:channels_unread:u1:s", { old: true }, 1_000).store);
  try {
    const result = await readWithStaleOnOverload({
      surface: "channels_unread", userId: "u1", scope: "s",
      load: async () => { await sleep(60); return { fresh: true }; },
    });
    assert.deepEqual(pick(result), { value: { fresh: true }, stale: false });
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("an overload falls back only to a body under OVERLOAD_MAX_AGE_MS; an older one is a too_old miss", async () => {
  __resetStaleReadOverloadForTests();
  const overloaded = async () => { throw new RisingWaveOverloadedError(new Error("pool timeout")); };
  __setStaleReadStoreForTests(storeWith("rw-stale:v2:channels_unread:u1:s", { recent: true }, OVERLOAD_MAX_AGE_MS - 10_000).store);
  try {
    const served = await readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s", load: overloaded });
    assert.deepEqual(pick(served), { value: { recent: true }, stale: true });
    assert.equal(served.staleReason, "rw_overloaded");
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
  __setStaleReadStoreForTests(storeWith("rw-stale:v2:channels_unread:u1:s", { old: true }, OVERLOAD_MAX_AGE_MS + 10_000).store);
  try {
    await assert.rejects(
      readWithStaleOnOverload({ surface: "channels_unread", userId: "u1", scope: "s", load: overloaded }),
      RisingWaveOverloadedError,
    );
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("a successful read reports the remembered size and a keyed hash of the cache key, never the key", async () => {
  __resetStaleReadOverloadForTests();
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "stale-cache-test-secret";
  const memory = memoryStore();
  __setStaleReadStoreForTests(memory.store);
  try {
    const result = await readWithStaleOnOverload({ surface: "channels_unread", userId: "user-42", scope: "s", load: async () => ({ a: 1 }) });
    const written = memory.entries.get("rw-stale:v2:channels_unread:user-42:s")!;
    assert.equal(result.traceAttrs.stale_cache_bytes, Buffer.byteLength(written, "utf8"));
    assert.match(String(result.traceAttrs.stale_cache_key_hash), /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(result.traceAttrs).includes("user-42"));
  } finally {
    __setStaleReadStoreForTests(undefined);
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test("while a backgrounded slow read runs, the same key never starts a second RW read", async () => {
  __resetStaleReadOverloadForTests();
  const memory = storeWith("rw-stale:v2:servers_unread_summary:u1:all", [{ old: true }], 5_000);
  __setStaleReadStoreForTests(memory.store);
  try {
    let loads = 0;
    let release!: (value: unknown) => void;
    const slowLoad = () => {
      loads += 1;
      return new Promise((resolve) => { release = resolve; });
    };
    const first = await readWithStaleOnOverload({ surface: "servers_unread_summary", userId: "u1", scope: "all", softTimeoutMs: 20, load: slowLoad });
    assert.equal(first.staleReason, "rw_slow");
    // The first read is still running in the background: a retry and another tab
    // answer from the fresh body at once and start nothing.
    for (let i = 0; i < 3; i += 1) {
      const again = await readWithStaleOnOverload({ surface: "servers_unread_summary", userId: "u1", scope: "all", softTimeoutMs: 20, load: slowLoad });
      assert.equal(again.staleReason, "rw_slow");
    }
    assert.equal(loads, 1);

    // Once the background read lands, the next request reads again.
    release([{ fresh: true }]);
    await sleep(20);
    const next = await readWithStaleOnOverload({ surface: "servers_unread_summary", userId: "u1", scope: "all", softTimeoutMs: 20, load: async () => [{ newest: true }] });
    assert.deepEqual(pick(next), { value: [{ newest: true }], stale: false });
    assert.equal(loads, 1);
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("with a background read running and no fresh body, a request waits on that read instead of starting one", async () => {
  __resetStaleReadOverloadForTests();
  const memory = storeWith("rw-stale:v2:inbox_first_page:u1:s", { old: true }, 5_000);
  __setStaleReadStoreForTests(memory.store);
  try {
    let loads = 0;
    let release!: (value: unknown) => void;
    const slowLoad = () => {
      loads += 1;
      return new Promise((resolve) => { release = resolve; });
    };
    await readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s", softTimeoutMs: 20, load: slowLoad });
    // The body ages out while the background read still runs.
    memory.entries.set("rw-stale:v2:inbox_first_page:u1:s", JSON.stringify({ writtenAtMs: Date.now() - SOFT_MAX_AGE_MS - 1_000, value: { old: true } }));
    const waiting = readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s", softTimeoutMs: 20, load: slowLoad });
    await sleep(40);
    release({ landed: true });
    assert.deepEqual(pick(await waiting), { value: { landed: true }, stale: false });
    assert.equal(loads, 1);
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("a body over RW_STALE_MAX_VALUE_BYTES is not remembered (and reports no cached size)", async () => {
  __resetStaleReadOverloadForTests();
  const previous = process.env.RW_STALE_MAX_VALUE_BYTES;
  process.env.RW_STALE_MAX_VALUE_BYTES = "1024";
  const memory = memoryStore();
  __setStaleReadStoreForTests(memory.store);
  try {
    const big = await readWithStaleOnOverload({ surface: "followed_threads", userId: "u1", scope: "s", load: async () => ({ blob: "x".repeat(4096) }) });
    assert.equal(big.traceAttrs.stale_cache_bytes, undefined);
    const small = await readWithStaleOnOverload({ surface: "followed_threads", userId: "u2", scope: "s", load: async () => ({ blob: "x" }) });
    assert.equal(typeof small.traceAttrs.stale_cache_bytes, "number");
    await flush();
    assert.equal(memory.entries.has("rw-stale:v2:followed_threads:u1:s"), false);
    assert.equal(memory.entries.has("rw-stale:v2:followed_threads:u2:s"), true);
  } finally {
    __setStaleReadStoreForTests(undefined);
    if (previous === undefined) delete process.env.RW_STALE_MAX_VALUE_BYTES;
    else process.env.RW_STALE_MAX_VALUE_BYTES = previous;
  }
});

test("RisingWave briefly unreachable (restart) serves the remembered body like any overload", async () => {
  const memory = memoryStore();
  __setStaleReadStoreForTests(memory.store);
  __resetStaleReadOverloadForTests();
  try {
    const first = await readWithStaleOnOverload({ surface: "channels_unread_summary", userId: "u1", scope: "s1", load: async () => ({ n: 1 }) });
    assert.deepEqual(pick(first), { value: { n: 1 }, stale: false });
    await flush();
    // Prod 2026-10-17 19:00Z: the RW node restarted for ~75 s.
    const unreachable = new RisingWaveOverloadedError(new Error("could not reach instance [E_UPSTREAM_UNREACHABLE]. request id: x"), "rw_unreachable");
    const during = await readWithStaleOnOverload({
      surface: "channels_unread_summary", userId: "u1", scope: "s1",
      load: async () => { throw unreachable; },
    });
    assert.deepEqual(pick(during), { value: { n: 1 }, stale: true });
    assert.equal(during.staleReason, "rw_overloaded");
    // With nothing remembered, the overload itself propagates (503 + Retry-After at the route).
    await assert.rejects(readWithStaleOnOverload({
      surface: "channels_unread_summary", userId: "u9", scope: "s1",
      load: async () => { throw unreachable; },
    }), (err: unknown) => err === unreachable);
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("a body read before the user's own latest inbox write is never served; other users still fall back", async () => {
  __resetStaleReadOverloadForTests();
  const overloaded = async () => { throw new RisingWaveOverloadedError(new Error("pool timeout")); };
  const memory = storeWith("rw-stale:v2:inbox_first_page:u1:s", { beforeDone: true }, 10_000);
  memory.entries.set("rw-stale:v2:inbox_first_page:u2:s", JSON.stringify({ writtenAtMs: Date.now() - 10_000, value: { other: true } }));
  __setStaleReadStoreForTests(memory.store);
  try {
    // u1 marked something done 5 s ago, after their body was read.
    await noteInboxWrite("u1", Date.now() - 5_000);
    await assert.rejects(
      readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s", load: overloaded }),
      RisingWaveOverloadedError,
    );
    // rw_slow does not serve it either: the request waits for the read.
    const slow = await readWithStaleOnOverload({
      surface: "inbox_first_page", userId: "u1", scope: "s", softTimeoutMs: 20,
      load: async () => { await sleep(80); return { fresh: true }; },
    });
    assert.deepEqual(pick(slow), { value: { fresh: true }, stale: false });
    // Another user's fallback is untouched.
    const other = await readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u2", scope: "s", load: overloaded });
    assert.deepEqual(pick(other), { value: { other: true }, stale: true });
    // A body read after the write is served again.
    await flush();
    const after = await readWithStaleOnOverload({ surface: "inbox_first_page", userId: "u1", scope: "s", load: overloaded });
    assert.deepEqual(pick(after), { value: { fresh: true }, stale: true });
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("a remembered body is stamped with when its read started, not when it finished", async () => {
  __resetStaleReadOverloadForTests();
  const memory = memoryStore();
  __setStaleReadStoreForTests(memory.store);
  try {
    const before = Date.now();
    await readWithStaleOnOverload({
      surface: "channels_unread", userId: "u1", scope: "s",
      load: async () => { await sleep(60); return { n: 1 }; },
    });
    await flush();
    const stored = JSON.parse(memory.entries.get("rw-stale:v2:channels_unread:u1:s")!);
    assert.ok(stored.writtenAtMs >= before && stored.writtenAtMs < before + 50, `stamped at ${stored.writtenAtMs - before} ms`);
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});

test("an inbox write route notes the write before its successful reply, and not on an error reply", async () => {
  const memory = memoryStore();
  __setStaleReadStoreForTests(memory.store);
  try {
    const reply = (statusCode: number, userId: string) => {
      let sent: unknown;
      const res = { statusCode, json: (body: unknown) => { sent = body; return res; } };
      noteInboxWriteBeforeReply({ userId } as unknown as Request, res as unknown as Response, (() => {}) as NextFunction);
      (res as unknown as Response).json({ ok: true });
      return () => sent;
    };
    const ok = reply(200, "u1");
    await flush();
    assert.deepEqual(ok(), { ok: true });
    assert.ok(Number(memory.entries.get("rw-stale:inbox-write-at:u1")) > 0);

    const failed = reply(404, "u2");
    assert.deepEqual(failed(), { ok: true }, "an error reply is sent at once");
    await flush();
    assert.equal(memory.entries.has("rw-stale:inbox-write-at:u2"), false);
  } finally {
    __setStaleReadStoreForTests(undefined);
  }
});
