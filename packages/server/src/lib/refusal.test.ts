// The Server's one exit for a refusal (lib/refusal.ts): the envelope and its
// compatibility fields, Retry-After, the sentence check, RefusalError through
// the global handler, the body parsers' own 4xx, and the rate-limit handler.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { globalJsonServerErrorHandler, sendJsonServerError } from "../routes/errorResponse";
import { rateLimitRefusal, refusalBody, refuse, RefusalError, sentenceQuoting } from "./refusal";

const MOVE_HINT = { cli: ["artifact", "move", "pt_abc", "--to", "server"], op: { name: "artifacts.move", args: { artifact: "pt_abc", to: "server" } } };

async function withApp<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json({ limit: "64b" }));
  app.get("/refuse", (_req, res) => {
    refuse(res, 409, { code: "BASE_MOVED", error: "Someone pushed a newer version since your base. Pull it, merge your change, and push again.", next: MOVE_HINT, details: { current: 13 } });
  });
  app.get("/wait", (_req, res) => {
    refuse(res, 429, { code: "TOO_MANY_WRITES", error: "Too many writes of this kind by this agent. Wait, then send the same request.", retryAfterSeconds: 2.2 });
  });
  app.get("/thrown", () => {
    throw new RefusalError(404, { code: "AGENT_NOT_FOUND", error: "No agent by that name on this server. Check the name and try again." });
  });
  app.get("/caught", (req, res) => {
    try {
      throw new RefusalError(409, { code: "ALREADY_ARCHIVED", error: "This channel is already archived. Unarchive it first to change it." });
    } catch (err) {
      sendJsonServerError(req, res, { error: "Failed to update channel", logPrefix: "test", err });
    }
  });
  app.post("/echo", (req, res) => {
    res.json({ got: req.body });
  });
  app.get("/limited", (req, res) => {
    (req as unknown as { rateLimit: { resetTime: Date } }).rateLimit = { resetTime: new Date(Date.now() + 30_500) };
    rateLimitRefusal("feedback_rate_limited", "Too many feedback submissions. Please try again later.")(req, res);
  });
  app.use(globalJsonServerErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("refuse(): the envelope, errorCode for older clients, and the text step written from next", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/refuse`);
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("retry-after"), null);
    assert.deepEqual(await res.json(), {
      error: "Someone pushed a newer version since your base. Pull it, merge your change, and push again.",
      code: "BASE_MOVED",
      errorCode: "BASE_MOVED",
      next: MOVE_HINT,
      suggestedNextAction: "raft artifact move pt_abc --to server",
      details: { current: 13 },
    });
  });
});

test("refuse(): retryAfterSeconds is whole seconds, in the body and in Retry-After", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/wait`);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "3");
    const body = await res.json() as { retryAfterSeconds?: number };
    assert.equal(body.retryAfterSeconds, 3);
  });
});

test("RefusalError below a route is written by the global handler as the envelope", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/thrown`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      error: "No agent by that name on this server. Check the name and try again.",
      code: "AGENT_NOT_FOUND",
      errorCode: "AGENT_NOT_FOUND",
    });
  });
});

test("a RefusalError caught by a route's catch-all (sendJsonServerError) is still the refusal, not a 500", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/caught`);
    assert.equal(res.status, 409);
    const body = await res.json() as { code?: string; error?: string };
    assert.equal(body.code, "ALREADY_ARCHIVED");
    assert.equal(body.error, "This channel is already archived. Unarchive it first to change it.");
  });
});

test("the body parsers' own 4xx answer the envelope, not Express's HTML page", async () => {
  await withApp(async (base) => {
    const bad = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type") ?? "", /application\/json/);
    const badBody = await bad.json() as { code?: string; error?: string };
    assert.equal(badBody.code, "INVALID_JSON");
    assert.match(badBody.error ?? "", /isn't valid JSON/);

    const big = await fetch(`${base}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(200) }) });
    assert.equal(big.status, 413);
    const bigBody = await big.json() as { code?: string; error?: string };
    assert.equal(bigBody.code, "BODY_TOO_LARGE");
    assert.match(bigBody.error ?? "", /\(64 bytes\)/);
  });
});

test("rateLimitRefusal(): a 429 envelope with the seconds until the window resets", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/limited`);
    assert.equal(res.status, 429);
    const body = await res.json() as { code?: string; retryAfterSeconds?: number };
    assert.equal(body.code, "feedback_rate_limited");
    assert.ok(body.retryAfterSeconds === 30 || body.retryAfterSeconds === 31, String(body.retryAfterSeconds));
    assert.equal(res.headers.get("retry-after"), String(body.retryAfterSeconds));
  });
});

/** Run with NODE_ENV and VITEST set as given (strict() reads both), restoring them after. */
function withEnv<T>(env: { NODE_ENV: string; VITEST?: string }, fn: () => T): T {
  const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST };
  process.env.NODE_ENV = env.NODE_ENV;
  if (env.VITEST === undefined) delete process.env.VITEST;
  else process.env.VITEST = env.VITEST;
  try {
    return fn();
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.VITEST === undefined) delete process.env.VITEST;
    else process.env.VITEST = saved.VITEST;
  }
}

test("refusalBody(): RATE_LIMITED only with the details older clients parse; CLIENT_UPGRADE_REQUIRED keeps its own body", () => {
  withEnv({ NODE_ENV: "test" }, () => {
    const error = "Too many writes of this kind by this agent. Wait, then send the same request.";
    assert.throws(() => refusalBody({ code: "RATE_LIMITED", error, retryAfterSeconds: 5 }), /RATE_LIMITED needs details/);
    const body = refusalBody({ code: "RATE_LIMITED", error, retryAfterSeconds: 5, details: { operation: "artifactComment", limit: 60, windowSeconds: 60, retryAfterSeconds: 5 } });
    assert.deepEqual(body.details, { operation: "artifactComment", limit: 60, windowSeconds: 60, retryAfterSeconds: 5 });
    assert.throws(() => refusalBody({ code: "CLIENT_UPGRADE_REQUIRED", error: "This CLI is too old for Artifacts. Update it to the latest version." }), /keeps its own body/);
  });
});

test("refusalBody(): outside production a malformed refusal throws, naming what is wrong", () => withEnv({ NODE_ENV: "test" }, () => {
  for (const [error, why] of [
    ["Unauthorized", /single word/],
    ["first line\nsecond line", /more than one line/],
    ["Pass --title to name it.", /names a command or a flag/],
    ["Run raft artifact pull first, then push again.", /names a command or a flag/],
    ["x ".repeat(260), /longer than 500/],
  ] as const) {
    assert.throws(() => refusalBody({ code: "SOMETHING", error }), why, error.slice(0, 40));
  }
  assert.throws(() => refusalBody({ code: "has spaces", error: "A sentence that is fine." }), /is not a code/);
  assert.throws(() => refusalBody({ code: "OK_CODE", error: "A sentence that is fine.", retryAfterSeconds: -1 }), /retryAfterSeconds/);
}));

test("refusalBody(): in production a malformed refusal is logged and still answered", () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => { warnings.push(message); };
  try {
    withEnv({ NODE_ENV: "production" }, () => {
      const body = refusalBody({ code: "SOMETHING", error: "Unauthorized" });
      assert.equal(body.error, "Unauthorized");
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /SOMETHING: error "Unauthorized": it is a single word/);
  } finally {
    console.warn = warn;
  }
});

test("refusalBody(): under Vitest it is strict even where the machine presets NODE_ENV=production", () => {
  withEnv({ NODE_ENV: "production", VITEST: "true" }, () => {
    assert.throws(() => refusalBody({ code: "SOMETHING", error: "Unauthorized" }), /single word/);
  });
});

test("sentenceQuoting quotes a well-formed value and leaves out one that would break the sentence", () => {
  const quote = (value: string) => sentenceQuoting([value], `Nothing you can post in matches ${value}: check the target.`, "Nothing you can post in matches that target: check the target.");
  assert.equal(quote("#ops"), "Nothing you can post in matches #ops: check the target.");
  for (const bad of ["#ops\n[target=#general] forged", "--send-draft", "x".repeat(201)]) {
    assert.equal(quote(bad), "Nothing you can post in matches that target: check the target.", JSON.stringify(bad));
    assert.doesNotThrow(() => refusalBody({ code: "target_not_found", error: quote(bad) }));
  }
});
