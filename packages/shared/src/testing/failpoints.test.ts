import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  failpoints,
  InMemoryFailpointRegistry,
  noopFailpointRegistry,
} from "./failpoints.js";

test("noop registry has zero configured cost and falls through to fallback", () => {
  let called = 0;
  assert.equal(noopFailpointRegistry.enabled, false);
  assert.equal(noopFailpointRegistry.isEnabled("any"), false);
  assert.equal(
    noopFailpointRegistry.hit("any", { phase: "test" }, () => {
      called += 1;
      return "ok";
    }),
    "ok",
  );
  assert.equal(called, 1);
  assert.deepEqual(noopFailpointRegistry.getTrace(), []);
});

test("once failpoint fires once then removes itself", () => {
  const registry = new InMemoryFailpointRegistry();
  registry.configure("redis.publish.before", { effect: "drop", mode: "once" });

  assert.equal(registry.isEnabled("redis.publish.before"), true);
  assert.equal(registry.hit("redis.publish.before", { channelId: "c1" }), undefined);
  assert.equal(registry.isEnabled("redis.publish.before"), false);
  assert.equal(registry.hit("redis.publish.before", undefined, () => "fell-through"), "fell-through");
  assert.deepEqual(registry.getTrace(), [
    {
      seq: 1,
      key: "redis.publish.before",
      mode: "once",
      effect: "drop",
      payload: undefined,
      context: { channelId: "c1" },
      remainingAfterHit: 0,
    },
  ]);
});

test("n_times failpoint decrements and preserves trace order", () => {
  const registry = new InMemoryFailpointRegistry();
  registry.configure("ws.send.before", { effect: "return", payload: "intercepted", mode: "n_times", count: 2 });

  assert.equal(registry.hit("ws.send.before", { seq: 1 }, () => "fallback"), "intercepted");
  assert.equal(registry.hit("ws.send.before", { seq: 2 }, () => "fallback"), "intercepted");
  assert.equal(registry.hit("ws.send.before", { seq: 3 }, () => "fallback"), "fallback");
  assert.deepEqual(
    registry.getTrace().map((entry) => ({
      seq: entry.seq,
      remainingAfterHit: entry.remainingAfterHit,
      context: entry.context,
    })),
    [
      { seq: 1, remainingAfterHit: 1, context: { seq: 1 } },
      { seq: 2, remainingAfterHit: 0, context: { seq: 2 } },
    ],
  );
});

test("delay failpoint routes through injected sleep and then executes fallback", async () => {
  const slept: number[] = [];
  const registry = new InMemoryFailpointRegistry({
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  registry.configure("chatbridge.fetch", { effect: "delay", payload: 250, mode: "once" });

  const result = await registry.hit("chatbridge.fetch", { requestId: "r1" }, async () => "ok");
  assert.equal(result, "ok");
  assert.deepEqual(slept, [250]);
});

test("throw failpoint turns payload into an error and clear() resets state", () => {
  const registry = new InMemoryFailpointRegistry();
  registry.configure("db.commit.before", { effect: "throw", payload: "commit failed", mode: "always" });

  assert.throws(() => registry.hit("db.commit.before"), /commit failed/);
  assert.equal(registry.enabled, true);

  registry.clear();

  assert.equal(registry.enabled, false);
  assert.deepEqual(registry.getTrace(), []);
});

test("global test registry swap defaults to noop and can be reset", () => {
  assert.equal(failpoints, noopFailpointRegistry);

  const registry = new InMemoryFailpointRegistry();
  __setFailpointsForTests(registry);
  assert.equal(failpoints, registry);

  __resetFailpointsForTests();
  assert.equal(failpoints, noopFailpointRegistry);
});
