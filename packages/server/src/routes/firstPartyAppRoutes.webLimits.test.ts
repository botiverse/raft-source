import assert from "node:assert/strict";
import type { Request, RequestHandler, Response } from "express";
import { afterEach, test } from "vitest";
import { installFakeRedis } from "../test/fakeRedis";
import { appWebLimitAcrossReplicas } from "./firstPartyAppRoutes";

// A first-party app's web limit counted across replicas
// (appWebLimitAcrossReplicas: Artifacts' `write` and `commentImages`): each
// replica builds its own limiter (app.ts, once per instance), and they count a
// person in the one Redis, so requests spread over replicas share one budget;
// past it 429 RATE_LIMITED with the app's sentence and Retry-After.

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const MESSAGE = "Too many artifact changes in a minute: wait a minute, then try the same change again.";

type Answer = { passed: boolean; status: number; headers: Record<string, string>; body: any };

/** One request of `userId` through `limiter`. */
async function through(limiter: RequestHandler, userId: string): Promise<Answer> {
  const answer: Answer = { passed: false, status: 200, headers: {}, body: undefined };
  const req = { userId, readableEnded: true, headers: {} };
  await new Promise<void>((resolve, reject) => {
    const res = {
      locals: {},
      setHeader(name: string, value: string) { answer.headers[name.toLowerCase()] = value; },
      status(code: number) { answer.status = code; return res; },
      json(body: unknown) { answer.body = body; resolve(); return res; },
    };
    limiter(req as unknown as Request, res as unknown as Response, (err?: unknown) => {
      if (err) reject(err);
      answer.passed = true;
      resolve();
    });
  });
  return answer;
}

const limiterOn = (limit: number, skip = () => false) => appWebLimitAcrossReplicas("artifacts.write", limit, MESSAGE, (req) => req.userId!, skip);

test("a person's writes spread over two replicas share one budget; past it 429 RATE_LIMITED with the sentence and Retry-After; another person keeps theirs", async () => {
  const fake = installFakeRedis();
  restore = fake.restore;
  const [replicaA, replicaB] = [limiterOn(3), limiterOn(3)];
  fake.clock.now = 1_000_000;
  assert.equal((await through(replicaA, "u1")).passed, true);
  assert.equal((await through(replicaB, "u1")).passed, true);
  fake.clock.now += 20_000;
  assert.equal((await through(replicaA, "u1")).passed, true);
  const refused = await through(replicaB, "u1");
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers["retry-after"], "40");
  assert.deepEqual(
    { error: refused.body.error, code: refused.body.code, retryAfterSeconds: refused.body.retryAfterSeconds, details: refused.body.details },
    { error: MESSAGE, code: "RATE_LIMITED", retryAfterSeconds: 40, details: { operation: "artifacts.write", limit: 3, windowSeconds: 60, retryAfterSeconds: 40 } },
  );
  assert.equal(fake.counters.get("slock:app-web:artifacts.write:u1")?.count, 4, "one count for both replicas");
  assert.equal((await through(replicaA, "u2")).passed, true, "another person");
  fake.clock.now += 40_000;
  assert.equal((await through(replicaB, "u1")).passed, true, "a new minute");
});

test("skipped (the pglite harness without a test's limit), nothing is counted", async () => {
  const fake = installFakeRedis();
  restore = fake.restore;
  const limiter = limiterOn(1, () => true);
  for (let i = 0; i < 3; i += 1) assert.equal((await through(limiter, "u1")).passed, true);
  assert.equal(fake.counters.size, 0);
});
