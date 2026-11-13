import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { test } from "vitest";

import {
  claimSlackMentionReconcile,
  redisSlackMentionReconcileClaimStore,
  releaseSlackMentionReconcileClaim,
  type SlackMentionReconcileClaimStore,
  type SlackMentionReconcileClaimTimers,
} from "./slackMentionReconcileClaim";

const TTL_MS = 30_000;
const RENEW_MS = 10_000;
const KEY = "slock:slack-bridge:mention-reconcile:server:install";

/** Manual clock: timers fire only from `advance`, so a "process pause" is a clock jump without firing. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; every: number | null; callback: () => void }>();
  const timers: SlackMentionReconcileClaimTimers = {
    now: () => now,
    setInterval: (callback, ms) => {
      const id = nextId++;
      scheduled.set(id, { at: now + ms, every: ms, callback });
      return id;
    },
    clearInterval: (handle) => scheduled.delete(handle as number),
    setTimeout: (callback, ms) => {
      const id = nextId++;
      scheduled.set(id, { at: now + ms, every: null, callback });
      return id;
    },
    clearTimeout: (handle) => scheduled.delete(handle as number),
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    timers,
    /** Runs every timer due within `ms`, letting promise callbacks settle between them. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, left], [, right]) => left.at - right.at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === null) scheduled.delete(id);
        else timer.at += timer.every;
        timer.callback();
        await flush();
      }
      now = until;
      await flush();
    },
    /** Moves the clock without firing anything: the process was paused. */
    pause(ms: number) {
      now += ms;
      for (const timer of scheduled.values()) {
        while (timer.at <= now) timer.at += timer.every ?? Number.POSITIVE_INFINITY;
      }
    },
  };
}

/** Redis-like store with key expiry on the same clock; renew is compare-and-renew. */
function memoryStore(now: () => number) {
  const keys = new Map<string, { token: string; expiresAt: number }>();
  let renewHangs = false;
  const live = (key: string) => {
    const entry = keys.get(key);
    if (entry && entry.expiresAt <= now()) keys.delete(key);
    return keys.get(key) ?? null;
  };
  const store: SlackMentionReconcileClaimStore = {
    acquire: async (key, token, ttlMs) => {
      if (live(key)) return false;
      keys.set(key, { token, expiresAt: now() + ttlMs });
      return true;
    },
    renew: (key, token, ttlMs) => {
      if (renewHangs) return new Promise<boolean>(() => {});
      const entry = live(key);
      if (entry?.token !== token) return Promise.resolve(false);
      entry.expiresAt = now() + ttlMs;
      return Promise.resolve(true);
    },
    owner: async (key) => live(key)?.token ?? null,
  };
  return {
    store,
    hangRenewals: () => { renewHangs = true; },
    overwrite: (key: string, token: string) => keys.set(key, { token, expiresAt: now() + TTL_MS }),
  };
}

test("the holder renews through a long reconcile and keeps other replicas out", async () => {
  const clock = manualTimers();
  const { store } = memoryStore(clock.timers.now);
  const claim = await claimSlackMentionReconcile({
    store, key: KEY, token: "replica-a", ttlMs: TTL_MS, renewEveryMs: RENEW_MS, timers: clock.timers,
  });
  assert.ok(claim);
  await clock.advance(75_000);
  assert.equal(await claim.held(), true, "renewals carry the claim past its first TTL");
  assert.equal(await store.acquire(KEY, "replica-b", TTL_MS), false);
  claim.end();
  assert.equal(await claim.held(), false);
  await clock.advance(TTL_MS);
  assert.equal(await store.acquire(KEY, "replica-b", TTL_MS), true, "an ended claim lapses by TTL, never by delete");
});

test("a slow call that outlives the window while renewals hang is refused, and a new holder can take over", async () => {
  const clock = manualTimers();
  const memory = memoryStore(clock.timers.now);
  const claim = await claimSlackMentionReconcile({
    store: memory.store, key: KEY, token: "replica-a", ttlMs: TTL_MS, renewEveryMs: RENEW_MS, timers: clock.timers,
  });
  assert.ok(claim);
  memory.hangRenewals();
  await clock.advance(TTL_MS - 1);
  assert.equal(await claim.held(), true);
  await clock.advance(1);
  assert.equal(await claim.held(), false, "no confirmed renewal: the window ends at TTL");
  assert.equal(await memory.store.acquire(KEY, "replica-b", TTL_MS), true);
  assert.equal(await claim.held(), false);
});

test("a holder resumed from a pause past its TTL is refused even though nothing told it the claim was lost", async () => {
  const clock = manualTimers();
  const memory = memoryStore(clock.timers.now);
  const claim = await claimSlackMentionReconcile({
    store: memory.store, key: KEY, token: "replica-a", ttlMs: TTL_MS, renewEveryMs: RENEW_MS, timers: clock.timers,
  });
  assert.ok(claim);
  clock.pause(40_000);
  assert.equal(await memory.store.acquire(KEY, "replica-b", TTL_MS), true);
  assert.equal(await claim.held(), false);
  // Its next renewal is compare-and-renew: it must not extend replica-b's claim.
  await clock.advance(RENEW_MS);
  assert.equal(await memory.store.owner(KEY), "replica-b");
  assert.equal(await claim.held(), false);
});

test("an owner change inside the local window is caught by the per-write owner check", async () => {
  const clock = manualTimers();
  const memory = memoryStore(clock.timers.now);
  const claim = await claimSlackMentionReconcile({
    store: memory.store, key: KEY, token: "replica-a", ttlMs: TTL_MS, renewEveryMs: RENEW_MS, timers: clock.timers,
  });
  assert.ok(claim);
  memory.overwrite(KEY, "replica-b");
  assert.equal(await claim.held(), false);
  await clock.advance(RENEW_MS);
  assert.equal(await claim.held(), false, "a lost claim stays lost");
});

test("a claim already held elsewhere is not acquired", async () => {
  const clock = manualTimers();
  const memory = memoryStore(clock.timers.now);
  assert.equal(await memory.store.acquire(KEY, "replica-b", TTL_MS), true);
  assert.equal(await claimSlackMentionReconcile({
    store: memory.store, key: KEY, token: "replica-a", ttlMs: TTL_MS, renewEveryMs: RENEW_MS, timers: clock.timers,
  }), null);
});


const redisTestUrl = process.env.SLACK_MENTION_REDIS_TEST_URL;
(redisTestUrl ? test : test.skip)("real Redis workspace release admits the next server and cannot delete a new owner", async () => {
  const redis = new Redis(redisTestUrl!, { maxRetriesPerRequest: 0 });
  const key = `peng:slack-mention-claim:${randomUUID()}`;
  try {
    const store = redisSlackMentionReconcileClaimStore(redis);
    const first = await claimSlackMentionReconcile({ store, key, token: "server-a", ttlMs: TTL_MS, renewEveryMs: RENEW_MS });
    assert.ok(first);
    try {
      assert.equal(await first.held(), true);
      assert.equal(await releaseSlackMentionReconcileClaim(redis, key, "wrong-owner"), false);
      assert.equal(await redis.get(key), "server-a");
    } finally { first.end(); }
    assert.equal(await releaseSlackMentionReconcileClaim(redis, key, "server-a"), true);
    const second = await claimSlackMentionReconcile({ store, key, token: "server-b", ttlMs: TTL_MS, renewEveryMs: RENEW_MS });
    assert.ok(second, "a completed pass does not starve the next server until TTL");
    try {
      assert.equal(await releaseSlackMentionReconcileClaim(redis, key, "server-a"), false);
      assert.equal(await second.held(), true);
    } finally { second.end(); }
    assert.equal(await releaseSlackMentionReconcileClaim(redis, key, "server-b"), true);
  } finally {
    await redis.del(key);
    await redis.quit();
  }
});
