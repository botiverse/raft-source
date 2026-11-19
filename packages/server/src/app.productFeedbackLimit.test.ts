import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, test } from "vitest";
import { createProductFeedbackLimiter } from "./app";
import { installFakeRedis } from "./test/fakeRedis";

// The per-person Hands feedback limit (app.ts createProductFeedbackLimiter,
// 10 an hour) is one budget however many server tasks answer: every replica
// counts in the one Redis key per person. Without Redis, or when it errors,
// each replica counts in its own memory (never admitting everything).

const LIMIT = 10;
const LIMITED_BODY = { error: "Too many feedback submissions. Please try again later.", code: "feedback_rate_limited", errorCode: "feedback_rate_limited" };

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** One server task: its own app and limiter, as createApp builds them; `x-user` stands in for requireAuth. */
async function replica() {
  const app = express();
  app.use((req, _res, next) => {
    req.userId = req.headers["x-user"] as string;
    next();
  });
  app.use("/api/product-feedback", createProductFeedbackLimiter({ validate: false, skip: () => false }), (_req, res) => {
    res.status(201).json({ ok: true });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/product-feedback/tickets`;
  return (user = "alice") => fetch(url, { method: "POST", headers: { "x-user": user } });
}

test("two server tasks share one person's 10 an hour: the 11th on either is refused with the unchanged 429", async () => {
  const fake = installFakeRedis();
  cleanups.push(fake.restore);
  const [a, b] = [await replica(), await replica()];

  for (let i = 0; i < LIMIT; i += 1) {
    const res = await (i % 2 ? b : a)();
    assert.equal(res.status, 201, `send ${i + 1} on task ${i % 2 ? "b" : "a"}`);
  }
  for (const [name, send] of [["a", a], ["b", b]] as const) {
    const refused = await send();
    assert.equal(refused.status, 429, `the 11th on task ${name}`);
    assert.deepEqual(await refused.json(), LIMITED_BODY);
    const retryAfter = Number(refused.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 60 * 60, `Retry-After: ${refused.headers.get("retry-after")}`);
    assert.equal(refused.headers.get("ratelimit-limit"), String(LIMIT));
  }
  assert.deepEqual([...fake.counters.keys()], ["rl:product-feedback:alice"], "one Redis counter, per person");

  // Another person has their own budget.
  assert.equal((await b("bob")).status, 201);
});

test("when Redis errors each task still limits on its own count", async () => {
  const fake = installFakeRedis({ failing: true });
  cleanups.push(fake.restore);
  const [a, b] = [await replica(), await replica()];
  for (const send of [a, b]) {
    for (let i = 0; i < LIMIT; i += 1) assert.equal((await send()).status, 201);
    const refused = await send();
    assert.equal(refused.status, 429, "never admits everything");
    assert.deepEqual(await refused.json(), LIMITED_BODY);
  }
});
