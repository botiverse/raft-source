import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import rateLimit from "express-rate-limit";
import { afterEach, test, vi } from "vitest";
import * as redis from "../redis";
import { SharedRateLimitStore } from "./sharedRateLimitStore";

// The app.ts limiters count in one Redis key per client and window, so every
// replica spends the same budget; without Redis, or when it errors, each
// replica counts in its own memory (never admitting everything).

/** A Redis double for the store's scripts: INCR/PEXPIRE/PTTL and DECR on one key. */
function fakeRedis(options: { failing?: boolean } = {}) {
  const keys = new Map<string, { count: number; expiresAtMs: number }>();
  const now = () => Date.now();
  const client = {
    async eval(script: string, numKeys: number, key: string, windowMs?: string) {
      if (options.failing) throw new Error("redis down");
      assert.equal(numKeys, 1);
      let entry = keys.get(key);
      if (entry && entry.expiresAtMs <= now()) entry = undefined;
      if (/INCR/.test(script)) {
        const next = { count: (entry?.count ?? 0) + 1, expiresAtMs: entry?.expiresAtMs ?? now() + Number(windowMs) };
        keys.set(key, next);
        return [next.count, next.expiresAtMs - now()];
      }
      if (entry && entry.count > 0) entry.count -= 1;
      return 0;
    },
    async del(key: string) {
      if (options.failing) throw new Error("redis down");
      keys.delete(key);
      return 1;
    },
  };
  const spies = [
    vi.spyOn(redis, "isRedisAvailable").mockReturnValue(true),
    vi.spyOn(redis, "getRedis").mockReturnValue(client as unknown as ReturnType<typeof redis.getRedis>),
  ];
  return { keys, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** One "replica": an app with its own limiter and store instance, as createApp builds them. */
async function replica(name: string, max: number, extra: Partial<Parameters<typeof rateLimit>[0]> = {}) {
  const app = express();
  const store = new SharedRateLimitStore(name);
  app.use(rateLimit({ windowMs: 60_000, max, store, standardHeaders: true, legacyHeaders: false, keyGenerator: () => "client-1", ...extra }));
  app.get("/ok", (_req, res) => res.status(200).end());
  app.get("/fail", (_req, res) => res.status(401).end());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  cleanups.push(() => store.shutdown());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path = "/ok") => fetch(`${url}${path}`).then((res) => res.status);
}

test("two replicas spend one budget in Redis", async () => {
  const fake = fakeRedis();
  cleanups.push(fake.restore);
  const [a, b] = [await replica("t", 4), await replica("t", 4)];
  assert.deepEqual([await a(), await b(), await a(), await b()], [200, 200, 200, 200]);
  assert.equal(await a(), 429, "the fifth request across both replicas is refused");
  assert.equal(await b(), 429);
  assert.ok([...fake.keys.keys()].every((key) => key.startsWith("rl:t:")), "keys carry the limiter's name");
});

test("limiters with different names keep separate budgets", async () => {
  const fake = fakeRedis();
  cleanups.push(fake.restore);
  const [one, other] = [await replica("one", 1), await replica("other", 1)];
  assert.equal(await one(), 200);
  assert.equal(await other(), 200);
  assert.equal(await one(), 429);
});

test("a request the limiter doesn't count is taken back in Redis", async () => {
  const fake = fakeRedis();
  cleanups.push(fake.restore);
  const [a, b] = [await replica("auth", 2, { skipSuccessfulRequests: true }), await replica("auth", 2, { skipSuccessfulRequests: true })];
  for (let i = 0; i < 5; i += 1) assert.equal(await (i % 2 ? a : b)("/ok"), 200, "successes are not counted");
  assert.equal(await a("/fail"), 401);
  assert.equal(await b("/fail"), 401);
  assert.equal(await a("/fail"), 429, "failures are, across replicas");
});

test("when Redis errors each replica still limits on its own count", async () => {
  const fake = fakeRedis({ failing: true });
  cleanups.push(fake.restore);
  const [a, b] = [await replica("down", 2), await replica("down", 2)];
  assert.deepEqual([await a(), await a(), await a()], [200, 200, 429], "never admits everything");
  assert.deepEqual([await b(), await b(), await b()], [200, 200, 429], "a per-replica budget, not a refusal of everyone");
});

test("a refusal keeps the limiter's body and status and names the limiter on the request", async () => {
  const fake = fakeRedis();
  cleanups.push(fake.restore);
  const { sharedRateLimit } = await import("./sharedRateLimitStore");
  const seen: Array<unknown> = [];
  const app = express();
  app.use((_req, res, next) => {
    res.on("finish", () => seen.push(res.locals.traceRateLimiter));
    next();
  });
  app.use(rateLimit({ windowMs: 60_000, max: 1, ...sharedRateLimit("named"), message: { error: "Too many" }, keyGenerator: () => "k" }));
  app.get("/ok", (_req, res) => res.status(200).end());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ok`;
  assert.equal((await fetch(url)).status, 200);
  const refused = await fetch(url);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: "Too many" });
  assert.deepEqual(seen, [undefined, "named"]);
});
