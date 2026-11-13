import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import * as redis from "../redis";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";
import { __resetMessageCardUpdateLimitsForTests, admitMessageCardUpdate } from "./messageCardService";

// The fixed-window budgets that hold across replicas (fixedWindowRateLimit.ts):
// with Redis every replica counts in the same key (one INCR + TTL Lua call);
// without it, or when it errors, a replica counts in its own memory, never
// admitting everything.

/** A Redis double for the counting script: INCR and a TTL on one key, on a clock the test moves. */
function fakeRedis(options: { failing?: boolean } = {}) {
  const keys = new Map<string, { count: number; expiresAtMs: number }>();
  const clock = { now: 0 };
  const client = {
    async eval(script: string, numKeys: number, key: string, windowSeconds: string, units = "1") {
      if (options.failing) throw new Error("redis down");
      assert.match(script, /INCR/);
      assert.equal(numKeys, 1);
      let entry = keys.get(key);
      if (entry && entry.expiresAtMs <= clock.now) entry = undefined;
      const next = { count: (entry?.count ?? 0) + Number(units), expiresAtMs: entry?.expiresAtMs ?? clock.now + Number(windowSeconds) * 1000 };
      keys.set(key, next);
      return [next.count, Math.ceil((next.expiresAtMs - clock.now) / 1000)];
    },
  };
  const spies = [
    vi.spyOn(redis, "isRedisAvailable").mockReturnValue(true),
    vi.spyOn(redis, "getRedis").mockReturnValue(client as unknown as ReturnType<typeof redis.getRedis>),
  ];
  return { keys, clock, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  __resetMessageCardUpdateLimitsForTests();
});

test("two replicas counting in one Redis stop at the limit together; the window's TTL is the wait", async () => {
  const fake = fakeRedis();
  restore = fake.restore;
  // Each replica has its own process memory; Redis is what they share.
  const [replicaA, replicaB] = [createFixedWindowCounter(), createFixedWindowCounter()];
  fake.clock.now = 1_000_000;
  for (let i = 0; i < 10; i += 1) {
    const replica = i % 2 === 0 ? replicaA : replicaB;
    assert.deepEqual(await replica.admit("budget:m1", 10, 60, fake.clock.now), { admitted: true }, `unit ${i}`);
  }
  fake.clock.now += 15_000;
  assert.deepEqual(await replicaA.admit("budget:m1", 10, 60, fake.clock.now), { admitted: false, retryAfterSeconds: 45 });
  assert.deepEqual(await replicaB.admit("budget:m1", 10, 60, fake.clock.now), { admitted: false, retryAfterSeconds: 45 });
  assert.deepEqual(await replicaB.admit("budget:m2", 10, 60, fake.clock.now), { admitted: true }, "another key, another budget");
  // The hour window: its own TTL.
  for (let i = 0; i < 3; i += 1) assert.equal((await (i % 2 ? replicaA : replicaB).admit("budget:s1", 3, 3600, fake.clock.now)).admitted, true);
  assert.deepEqual(await replicaA.admit("budget:s1", 3, 3600, fake.clock.now), { admitted: false, retryAfterSeconds: 3600 });
  fake.clock.now += 60_000;
  assert.deepEqual(await replicaA.admit("budget:m1", 10, 60, fake.clock.now), { admitted: true }, "a new minute");
});

test("a request may spend several units at once (one per task of a batch), in Redis and in memory", async () => {
  const fake = fakeRedis();
  restore = fake.restore;
  fake.clock.now = 4_000_000;
  const replica = createFixedWindowCounter();
  assert.deepEqual(await replica.admit("budget:u1", 10, 60, fake.clock.now, 7), { admitted: true });
  assert.equal(fake.keys.get("budget:u1")?.count, 7);
  assert.deepEqual(await replica.admit("budget:u1", 10, 60, fake.clock.now, 4), { admitted: false, retryAfterSeconds: 60 });
  fake.restore();
  restore = null;
  const memory = createFixedWindowCounter();
  assert.equal((await memory.admit("budget:u2", 10, 60, 5_000_000, 10)).admitted, true);
  assert.equal((await memory.admit("budget:u2", 10, 60, 5_000_000)).admitted, false);
});

test("a Redis error counts in this replica's memory instead of admitting everything", async () => {
  const fake = fakeRedis({ failing: true });
  restore = fake.restore;
  const replica = createFixedWindowCounter();
  for (let i = 0; i < 10; i += 1) assert.equal((await replica.admit("budget:m1", 10, 60, 2_000_000 + i)).admitted, true);
  assert.deepEqual(await replica.admit("budget:m1", 10, 60, 2_030_000), { admitted: false, retryAfterSeconds: 30 });
});

test("card updates: 10 a minute per message and 300 an hour per sender, counted with the other replicas' updates", async () => {
  const fake = fakeRedis();
  restore = fake.restore;
  fake.clock.now = 3_000_000;
  // Another replica already spent 9 of message m1's minute.
  fake.keys.set("slock:message-card-update:message:m1", { count: 9, expiresAtMs: fake.clock.now + 50_000 });
  assert.deepEqual(await admitMessageCardUpdate({ messageId: "m1", senderAgentId: "a1" }, fake.clock.now), { admitted: true });
  assert.deepEqual(await admitMessageCardUpdate({ messageId: "m1", senderAgentId: "a1" }, fake.clock.now), {
    admitted: false, scope: "message", limit: 10, windowSeconds: 60, retryAfterSeconds: 50,
  });
  // And 299 of the sender's hour.
  fake.keys.set("slock:message-card-update:sender:a2", { count: 299, expiresAtMs: fake.clock.now + 1_800_000 });
  assert.deepEqual(await admitMessageCardUpdate({ messageId: "m2", senderAgentId: "a2" }, fake.clock.now), { admitted: true });
  assert.deepEqual(await admitMessageCardUpdate({ messageId: "m3", senderAgentId: "a2" }, fake.clock.now), {
    admitted: false, scope: "sender", limit: 300, windowSeconds: 3600, retryAfterSeconds: 1800,
  });
});
