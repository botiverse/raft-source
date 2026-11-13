import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { productFeedbackReporterId } from "./productFeedbackService";
import {
  ensureProductFeedbackRouteBinding,
  forgetProductFeedbackRouteBinding,
  ProductFeedbackRouteBindingError,
  resetProductFeedbackRouteBindingCacheForTest,
  setSharedRouteBindingStoreForTest,
  type SharedRouteBindingStore,
} from "./productFeedbackRouteBindingService";


const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_ID = "22222222-2222-4222-8222-222222222223";
const ROOT = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex").toString("base64url");
const REPORTER_SECRET = "reporter-id-secret-for-test";
const ENV = {
  HANDS_FEEDBACK_BASE_URL: "https://hands.example",
  HANDS_FEEDBACK_APP_ID: APP_ID,
  HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "conversation-token",
  HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "revision-1",
  HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: INTEGRATION_ID,
  HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
  HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: ROOT,
  HANDS_FEEDBACK_REPORTER_ID_SECRET: REPORTER_SECRET,
} as NodeJS.ProcessEnv;

afterEach(async () => {
  resetProductFeedbackRouteBindingCacheForTest();
  setSharedRouteBindingStoreForTest(null);
  await closeTestDatabase();
});

/** Redis as every task sees it: key → expiry. */
function memorySharedStore(nowMs: () => number = Date.now) {
  const entries = new Map<string, number>();
  const store: SharedRouteBindingStore = {
    async remainingMs(key) {
      const at = entries.get(key);
      return at !== undefined && at > nowMs() ? at - nowMs() : null;
    },
    async remember(key, ttlMs) { entries.set(key, nowMs() + ttlMs); },
    async forget(key) { entries.delete(key); },
  };
  return { store, entries };
}

async function seed(): Promise<void> {
  await openTestDatabase("pglite://");
  await getDb().insert(users).values({
    id: USER_ID,
    email: "route-user@example.com",
    name: "route_user",
    passwordHash: "test",
    emailVerified: true,
  });
}

test("route binding pins the root, binds before upstream work, and caches only exact success", async () => {
  await seed();
  let calls = 0;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.match(String(sent.route_subject), /^rfr_v1_/);
    assert.equal(new Headers(init?.headers).get("X-Hands-Reporter-Id"), productFeedbackReporterId(USER_ID, REPORTER_SECRET));
    return Response.json({ changed: true, subject_version: "v1" }, { status: 201 });
  };
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  assert.equal(calls, 1);

  resetProductFeedbackRouteBindingCacheForTest();
  const swapped = { ...ENV, HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 9).toString("base64url") };
  await assert.rejects(
    ensureProductFeedbackRouteBinding({ userId: USER_ID, env: swapped, fetchImpl }),
    ProductFeedbackRouteBindingError,
  );
  assert.equal(calls, 1, "root swap must fail before Hands traffic");
});

test("route binding failures carry a fixed reason code for the operator log", async () => {
  await seed();
  const reasonOf = async (env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): Promise<string> => {
    resetProductFeedbackRouteBindingCacheForTest();
    try {
      await ensureProductFeedbackRouteBinding({ userId: USER_ID, env, fetchImpl });
    } catch (error) {
      assert.ok(error instanceof ProductFeedbackRouteBindingError);
      return error.reason;
    }
    throw new Error("expected a route binding failure");
  };
  const ok = (async () => Response.json({ changed: true, subject_version: "v1" }, { status: 201 })) as typeof fetch;
  assert.equal(await reasonOf({ ...ENV, HANDS_FEEDBACK_APP_ID: "not-a-uuid" }, ok), "config_invalid");
  assert.equal(await reasonOf({ ...ENV, HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: "a".repeat(64) }, ok), "root_invalid");
  const rejected = (async () => new Response("no", { status: 403 })) as typeof fetch;
  assert.equal(await reasonOf(ENV, rejected), "hands_status_403");
  const odd = (async () => Response.json({ changed: true }, { status: 201 })) as typeof fetch;
  assert.equal(await reasonOf(ENV, odd), "hands_unexpected_body");
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl: ok });
  const swapped = { ...ENV, HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 9).toString("base64url") };
  assert.equal(await reasonOf(swapped, ok), "root_commitment_mismatch");
});

// A fresh task (empty cache) right after a deploy: every active reporter binds at
// once, and Hands may be slow to connect (Eric, 2026-10-15: 5xx bursts per deploy).
test("concurrent first requests for one reporter share a single Hands call", async () => {
  await seed();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async () => {
    calls += 1;
    await gate;
    return Response.json({ changed: true, subject_version: "v1" }, { status: 201 });
  }) as typeof fetch;
  const binds = Array.from({ length: 5 }, () => ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await Promise.all(binds);
  assert.equal(calls, 1);
});

test("only a fast network failure is retried once; a timeout, a 5xx or a definite answer is not", async () => {
  await seed();
  const connectTimeout = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
  const outcomes: Array<() => Response> = [];
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    const next = outcomes.shift();
    if (!next) throw connectTimeout;
    return next();
  }) as typeof fetch;
  const bind = () => ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl, retryDelayMs: 0 });
  const reasonOf = async (): Promise<string> => {
    try {
      await bind();
    } catch (error) {
      assert.ok(error instanceof ProductFeedbackRouteBindingError);
      return error.reason;
    }
    return "ok";
  };

  // A connection reset then success: one retry, bound.
  const connectionReset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  outcomes.push(() => { throw connectionReset; }, () => Response.json({ changed: true, subject_version: "v1" }, { status: 201 }));
  assert.equal(await reasonOf(), "ok");
  assert.equal(calls, 2);

  // Reset twice: the low-level code reaches the operator log, not "request_failed".
  resetProductFeedbackRouteBindingCacheForTest();
  calls = 0;
  outcomes.push(() => { throw connectionReset; }, () => { throw connectionReset; });
  assert.equal(await reasonOf(), "network_ECONNRESET");
  assert.equal(calls, 2);

  // A connect timeout already waited: reported with its code, not retried.
  resetProductFeedbackRouteBindingCacheForTest();
  calls = 0;
  assert.equal(await reasonOf(), "network_UND_ERR_CONNECT_TIMEOUT");
  assert.equal(calls, 1);

  // A 5xx means Hands is failing: not retried, so a struggling Hands is not hit twice.
  resetProductFeedbackRouteBindingCacheForTest();
  calls = 0;
  outcomes.push(() => new Response("busy", { status: 503 }));
  assert.equal(await reasonOf(), "hands_status_503");
  assert.equal(calls, 1);

  // Hands' classified error code rides on the failure; free text does not.
  resetProductFeedbackRouteBindingCacheForTest();
  calls = 0;
  outcomes.push(() => Response.json(
    { code: "REPORTER_BACKEND_UNAVAILABLE", message: "D1 DB is unavailable" },
    { status: 503, headers: { "Retry-After": "1" } },
  ));
  let classified: unknown;
  try {
    await bind();
  } catch (error) {
    classified = error;
  }
  assert.ok(classified instanceof ProductFeedbackRouteBindingError);
  assert.equal(classified.reason, "hands_status_503");
  assert.equal(classified.upstreamCode, "REPORTER_BACKEND_UNAVAILABLE");
  assert.equal(calls, 1);

  // A 4xx is Hands' answer: no retry.
  resetProductFeedbackRouteBindingCacheForTest();
  calls = 0;
  outcomes.push(() => new Response("no", { status: 403 }));
  assert.equal(await reasonOf(), "hands_status_403");
  assert.equal(calls, 1);

  // A timeout (AbortSignal) is reported as such, and not retried: Hands is slow.
  resetProductFeedbackRouteBindingCacheForTest();
  calls = 0;
  const timeout = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
  outcomes.push(timeout);
  assert.equal(await reasonOf(), "timeout");
  assert.equal(calls, 1);
});

test("three transient failures open the breaker: bindings fail fast for 30s, then one trial decides", async () => {
  await seed();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-23T04:00:00Z"));
    const timeout = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    const outcomes: Array<() => Response> = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const next = outcomes.shift();
      if (!next) throw new Error("unexpected Hands call");
      return next();
    }) as typeof fetch;
    // A different reporter each time, so the success cache and in-flight sharing never answer for Hands.
    let reporter = 0;
    const reasonOf = async (): Promise<string> => {
      reporter += 1;
      try {
        await ensureProductFeedbackRouteBinding({
          userId: USER_ID, reporterId: `reporter-${reporter}`, env: ENV, fetchImpl, retryDelayMs: 0,
        });
      } catch (error) {
        assert.ok(error instanceof ProductFeedbackRouteBindingError);
        return error.reason;
      }
      return "ok";
    };

    outcomes.push(timeout, timeout, timeout);
    assert.deepEqual([await reasonOf(), await reasonOf(), await reasonOf()], ["timeout", "timeout", "timeout"]);
    assert.equal(calls, 3);

    // Open: no Hands call at all.
    assert.equal(await reasonOf(), "circuit_open");
    vi.setSystemTime(new Date("2026-10-23T04:00:29Z"));
    assert.equal(await reasonOf(), "circuit_open");
    assert.equal(calls, 3);

    // After 30s one trial goes through; its failure re-opens the breaker at once.
    vi.setSystemTime(new Date("2026-10-23T04:00:31Z"));
    outcomes.push(timeout);
    assert.equal(await reasonOf(), "timeout");
    assert.equal(calls, 4);
    assert.equal(await reasonOf(), "circuit_open");
    assert.equal(calls, 4);

    // The next trial succeeds and closes it.
    vi.setSystemTime(new Date("2026-10-23T04:01:02Z"));
    outcomes.push(() => Response.json({ changed: true, subject_version: "v1" }, { status: 201 }));
    assert.equal(await reasonOf(), "ok");
    outcomes.push(() => Response.json({ changed: false, subject_version: "v1" }, { status: 200 }));
    assert.equal(await reasonOf(), "ok");
    assert.equal(calls, 6);

    // A 4xx is Hands answering: it never opens the breaker.
    outcomes.push(...Array.from({ length: 4 }, () => () => new Response("no", { status: 403 })));
    for (let i = 0; i < 4; i += 1) assert.equal(await reasonOf(), "hands_status_403");
    assert.equal(calls, 10);
  } finally {
    vi.useRealTimers();
  }
});

test("a fresh task's burst, where most bindings succeed, keeps the breaker closed", async () => {
  await seed();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-24T07:59:00Z"));
    const timeout = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    const ok = () => Response.json({ changed: true, subject_version: "v1" }, { status: 201 });
    const outcomes: Array<() => Response> = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const next = outcomes.shift();
      if (!next) throw new Error("unexpected Hands call");
      return next();
    }) as typeof fetch;
    let reporter = 0;
    const reasonOf = async (): Promise<string> => {
      reporter += 1;
      try {
        await ensureProductFeedbackRouteBinding({
          userId: USER_ID, reporterId: `burst-${reporter}`, env: ENV, fetchImpl, retryDelayMs: 0,
        });
      } catch (error) {
        assert.ok(error instanceof ProductFeedbackRouteBindingError);
        return error.reason;
      }
      return "ok";
    };

    // The v1.21.32 shape: many first bindings succeed, and a few time out behind them.
    for (let i = 0; i < 20; i += 1) outcomes.push(ok);
    outcomes.push(timeout, timeout, timeout, timeout, timeout);
    for (let i = 0; i < 20; i += 1) assert.equal(await reasonOf(), "ok");
    for (let i = 0; i < 5; i += 1) assert.equal(await reasonOf(), "timeout");
    outcomes.push(ok);
    assert.equal(await reasonOf(), "ok", "five timeouts against twenty successes must not open the breaker");
    assert.equal(calls, 26);

    // Once the successes leave the window, failures outnumbering them still open it.
    vi.setSystemTime(new Date("2026-10-24T08:00:02Z"));
    outcomes.push(timeout, timeout, timeout);
    for (let i = 0; i < 3; i += 1) assert.equal(await reasonOf(), "timeout");
    assert.equal(await reasonOf(), "circuit_open");
    assert.equal(calls, 29);
  } finally {
    vi.useRealTimers();
  }
});

test("the root commitment is checked once per process, and a database failure has its own reason", async () => {
  await seed();
  const ok = (async () => Response.json({ changed: true, subject_version: "v1" }, { status: 201 })) as typeof fetch;
  let dbCalls = 0;
  const realDb = getDb();
  const countingExecutor = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "insert" || prop === "select") dbCalls += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl: ok, executor: countingExecutor });
  const afterFirst = dbCalls;
  assert.ok(afterFirst > 0);
  await ensureProductFeedbackRouteBinding({
    userId: USER_ID, reporterId: "another-reporter", env: ENV, fetchImpl: ok, executor: countingExecutor,
  });
  assert.equal(dbCalls, afterFirst, "a verified commitment is not re-read on later requests");

  resetProductFeedbackRouteBindingCacheForTest();
  const failingExecutor = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "insert") return () => { throw new Error("connection terminated"); };
      return Reflect.get(target, prop, receiver);
    },
  });
  await assert.rejects(
    ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl: ok, executor: failingExecutor }),
    (error: unknown) => error instanceof ProductFeedbackRouteBindingError && error.reason === "commitment_failed",
  );
});

test("a binding is reused for 30 minutes and bound again after", async () => {
  await seed();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ changed: false, subject_version: "v1" }, { status: 200 });
  }) as typeof fetch;
  const bindAt = (nowMs: number) => ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl, nowMs });
  const start = 1_800_000_000_000;
  await bindAt(start);
  assert.equal(calls, 1);
  // The web unread poll lists every minute; none of these re-bind within 30 minutes.
  for (const minutes of [1, 6, 15, 29]) await bindAt(start + minutes * 60_000);
  assert.equal(calls, 1, "a cached binding is reused within 30 minutes");
  await bindAt(start + 30 * 60_000);
  assert.equal(calls, 2, "an expired binding is bound again");
  await bindAt(start + 31 * 60_000);
  assert.equal(calls, 2, "the new binding is cached again");
});

test("a changed credential revision or reporter id misses the cached binding", async () => {
  await seed();
  const reporters: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    reporters.push(new Headers(init?.headers).get("X-Hands-Reporter-Id") ?? "");
    return Response.json({ changed: false, subject_version: "v1" }, { status: 200 });
  }) as typeof fetch;
  const nowMs = 1_800_000_000_000;
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl, nowMs });
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl, nowMs });
  assert.equal(reporters.length, 1);

  const rotated = { ...ENV, HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "revision-2" };
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: rotated, fetchImpl, nowMs });
  assert.equal(reporters.length, 2, "a rotated credential revision binds again");

  const reseeded = { ...ENV, HANDS_FEEDBACK_REPORTER_ID_SECRET: "rotated-reporter-id-secret" };
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: reseeded, fetchImpl, nowMs });
  assert.equal(reporters.length, 3, "a new reporter-id secret (so a new reporter id) binds again");
  assert.equal(reporters[2], productFeedbackReporterId(USER_ID, "rotated-reporter-id-secret"));

  await ensureProductFeedbackRouteBinding({ userId: USER_ID, reporterId: "explicit-reporter", env: ENV, fetchImpl, nowMs });
  assert.equal(reporters.length, 4, "another reporter id binds again");
  assert.equal(reporters[3], "explicit-reporter");

  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl, nowMs });
  assert.equal(reporters.length, 4, "the original binding is still cached");
});

test("forgetting a binding makes the next request bind again", async () => {
  await seed();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ changed: false, subject_version: "v1" }, { status: 200 });
  }) as typeof fetch;
  const nowMs = 1_800_000_000_000;
  const bind = () => ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl, nowMs });
  await bind();
  forgetProductFeedbackRouteBinding({ userId: USER_ID, env: { ...ENV, HANDS_FEEDBACK_APP_ID: "not-a-uuid" } });
  forgetProductFeedbackRouteBinding({ reporterId: "another-reporter", env: ENV });
  await bind();
  assert.equal(calls, 1, "another reporter's or an invalid configuration's forget leaves it cached");

  forgetProductFeedbackRouteBinding({ userId: USER_ID, env: ENV });
  await bind();
  assert.equal(calls, 2, "forget by user id drops it");

  forgetProductFeedbackRouteBinding({ reporterId: productFeedbackReporterId(USER_ID, REPORTER_SECRET), env: ENV });
  await bind();
  assert.equal(calls, 3, "forget by reporter id drops it");
});


test("a new task reuses a binding another task made (shared store): no Hands call", async () => {
  await seed();
  const shared = memorySharedStore();
  setSharedRouteBindingStoreForTest(shared.store);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ changed: true, subject_version: "v1" }, { status: 201 });
  }) as typeof fetch;
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(shared.entries.size, 1, "the binding is shared");
  assert.equal([...shared.entries.keys()][0]!.includes(productFeedbackReporterId(USER_ID, REPORTER_SECRET)), false, "no reporter id in the shared key");

  // Another task: empty in-process cache, same Redis.
  resetProductFeedbackRouteBindingCacheForTest();
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  assert.equal(calls, 1, "the second task did not ask Hands");
});

test("each binding names where it came from on the request span: hands, then shared on a new task, then memory", async () => {
  await seed();
  const shared = memorySharedStore();
  setSharedRouteBindingStoreForTest(shared.store);
  const { BasicTracer, MemoryTraceSink } = await import("@botiverse/raft-shared");
  const { runWithTraceSpan } = await import("../tracing/semanticTrace");
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const fetchImpl = (async () => Response.json({ changed: true, subject_version: "v1" }, { status: 201 })) as typeof fetch;
  const sources: unknown[] = [];
  for (const newTask of [false, true, false]) {
    if (newTask) resetProductFeedbackRouteBindingCacheForTest();
    const request = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
    await runWithTraceSpan(request, () => ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl }), tracer);
    request.end("ok");
    const span = sink.getAllSpans().find((candidate) => candidate.context.spanId === request.context.spanId);
    const event = span?.events.find((candidate) => candidate.name === "server.product_feedback.route_binding.source");
    sources.push(event?.attrs?.source);
    assert.deepEqual(Object.keys(event?.attrs ?? {}), ["source"], "no reporter id or other detail");
  }
  assert.deepEqual(sources, ["hands", "shared", "memory"]);
});

test("a 401/403 on one task drops the shared binding: another task asks Hands again", async () => {
  await seed();
  const shared = memorySharedStore();
  setSharedRouteBindingStoreForTest(shared.store);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ changed: true, subject_version: "v1" }, { status: 201 });
  }) as typeof fetch;
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  forgetProductFeedbackRouteBinding({ userId: USER_ID, env: ENV });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shared.entries.size, 0);

  resetProductFeedbackRouteBindingCacheForTest();
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  assert.equal(calls, 2, "the refused binding is not reused by another task");
});

test("an unreachable shared store falls back to asking Hands", async () => {
  await seed();
  const failing: SharedRouteBindingStore = {
    remainingMs: async () => { throw new Error("redis down"); },
    remember: async () => { throw new Error("redis down"); },
    forget: async () => { throw new Error("redis down"); },
  };
  setSharedRouteBindingStoreForTest(failing);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ changed: true, subject_version: "v1" }, { status: 201 });
  }) as typeof fetch;
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  await ensureProductFeedbackRouteBinding({ userId: USER_ID, env: ENV, fetchImpl });
  assert.equal(calls, 1, "the in-process cache still works");
});
