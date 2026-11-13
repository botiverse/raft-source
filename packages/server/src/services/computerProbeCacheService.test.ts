import assert from "node:assert/strict";
import type { RuntimeModelSourceOutcome } from "@botiverse/raft-shared";

import { RouteFailureError } from "../tracing/routeFailure";
import {
  COMPUTER_PROBE_CACHE_TTL_SECONDS,
  COMPUTER_PROBE_WAIT_MS,
  ComputerProbeCacheService,
  createComputerProbeRoutingBackend,
  createLocalComputerProbeCacheBackend,
  createRedisComputerProbeCacheBackend,
  type ComputerProbeCacheBackend,
  type ComputerProbeClock,
  type ComputerProbeRedisClient,
} from "./computerProbeCacheService";

/** A clock whose timers fire only when the test advances it. */
function manualClock(startMs = Date.parse("2026-10-21T08:00:00.000Z")) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ComputerProbeClock & { advance(ms: number): Promise<void> } = {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const until = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        nowMs = due[1].at;
        due[1].fn();
        await flush();
      }
      nowMs = until;
      await flush();
    },
  };
  return clock;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function memoryBackend(): ComputerProbeCacheBackend & { values: Map<string, { value: string; ttlSeconds: number }> } {
  const values = new Map<string, { value: string; ttlSeconds: number }>();
  return {
    values,
    async get(key) { return values.get(key)?.value ?? null; },
    async set(key, value, ttlSeconds) { values.set(key, { value, ttlSeconds }); },
  };
}

const LIVE: RuntimeModelSourceOutcome = {
  kind: "live",
  value: { models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4" },
};
const NEWER: RuntimeModelSourceOutcome = {
  kind: "live",
  value: { models: [{ id: "gpt-5.5", label: "GPT 5.5" }], default: "gpt-5.5" },
};
const MODELS_KEY = "slock:computer-probe-cache:v1:models:machine-1:codex";

test("the wait budget stays below the replay timeout and the cache keeps ten minutes", () => {
  assert.equal(COMPUTER_PROBE_WAIT_MS, 6_000);
  assert.ok(COMPUTER_PROBE_WAIT_MS < 8_000, "the owner must answer before the front replica's 8s replay timeout");
  assert.equal(COMPUTER_PROBE_CACHE_TTL_SECONDS, 600);
});

test("a Computer that answers after 10s: unavailable at 6s, the late answer is cached, the next request gets it", async () => {
  const clock = manualClock();
  const backend = memoryBackend();
  const service = new ComputerProbeCacheService(backend, { clock });
  const daemon = deferred<RuntimeModelSourceOutcome>();
  let settled: unknown = null;
  const first = service.probeModels("machine-1", "codex", () => daemon.promise).then((answer) => { settled = answer; });

  await clock.advance(5_999);
  assert.equal(settled, null, "still waiting before the budget");
  await clock.advance(1);
  await first;
  assert.deepEqual(settled, { state: "unavailable" }, "answered at 6s without the Computer's list");
  assert.equal(backend.values.size, 0);

  // The Computer's request was not cancelled: it answers at 10s and lands in the cache.
  await clock.advance(4_000);
  daemon.resolve(LIVE);
  await flush();
  const record = JSON.parse(backend.values.get(MODELS_KEY)!.value);
  assert.deepEqual(record, { fetchedAt: "2026-10-21T08:00:10.000Z", value: LIVE });
  assert.equal(backend.values.get(MODELS_KEY)!.ttlSeconds, 600);

  // The next open, while the Computer is still slow, gets that list marked stale.
  const slowAgain = deferred<RuntimeModelSourceOutcome>();
  const second = service.probeModels("machine-1", "codex", () => slowAgain.promise);
  await clock.advance(6_000);
  assert.deepEqual(await second, { state: "stale", value: LIVE, fetchedAt: "2026-10-21T08:00:10.000Z" });

  // And when the Computer answers in time, the fresh answer is served.
  assert.deepEqual(
    await service.probeModels("machine-1", "codex", async () => LIVE),
    { state: "ok", value: LIVE },
  );
});

test("a fresh answer always wins: it is served and rewrites the cache", async () => {
  const clock = manualClock();
  const backend = memoryBackend();
  const service = new ComputerProbeCacheService(backend, { clock });
  await service.probeModels("machine-1", "codex", async () => LIVE);
  await clock.advance(60_000);
  assert.deepEqual(await service.probeModels("machine-1", "codex", async () => NEWER), { state: "ok", value: NEWER });
  assert.deepEqual(await service.cachedModels("machine-1", "codex"), {
    state: "stale",
    value: NEWER,
    fetchedAt: "2026-10-21T08:01:00.000Z",
  });
});

test("a cached list keeps the runtime's unavailable models", async () => {
  const backend = memoryBackend();
  const service = new ComputerProbeCacheService(backend, { clock: manualClock() });
  const listed: RuntimeModelSourceOutcome = {
    kind: "live",
    value: {
      models: [{ id: "opus", label: "Claude Opus" }],
      unavailable: [{ id: "claude-opus-9", label: "Claude Opus 9", reason: "Upgrade Claude Code" }],
    },
  };
  await service.probeModels("machine-1", "claude", async () => listed);
  const cached = await service.cachedModels("machine-1", "claude");
  assert.equal(cached.state, "stale");
  assert.deepEqual(cached.state === "stale" && cached.value, listed);
});

test("failures are never cached, and an orchestrator timeout answers from the cache", async () => {
  const backend = memoryBackend();
  const service = new ComputerProbeCacheService(backend, { clock: manualClock() });
  for (const outcome of [
    { kind: "error", retryable: true, code: "detect_failed" },
    { kind: "missing_config" },
    { kind: "no_models" },
    { kind: "unsupported" },
    { kind: "live", value: { models: [] } },
  ] as RuntimeModelSourceOutcome[]) {
    assert.deepEqual(await service.probeModels("machine-1", "codex", async () => outcome), { state: "ok", value: outcome });
  }
  assert.equal(backend.values.size, 0);

  await service.probeModels("machine-1", "codex", async () => LIVE);
  assert.equal(
    (await service.probeModels("machine-1", "codex", async () => {
      throw new RouteFailureError("daemon_timeout", "timed out");
    })).state,
    "stale",
  );
  // Any other failure is the caller's to answer (offline, server errors).
  await assert.rejects(
    service.probeModels("machine-1", "codex", async () => {
      throw new RouteFailureError("daemon_offline", "offline");
    }),
    (error: unknown) => error instanceof RouteFailureError && error.subkind === "daemon_offline",
  );
});

test("skills: same budget and cache, per agent on one Computer and runtime", async () => {
  const clock = manualClock();
  const backend = memoryBackend();
  const service = new ComputerProbeCacheService(backend, { clock });
  const skills = {
    global: [{ name: "review", displayName: "Review", description: "Review a diff", userInvocable: true, sourcePath: "~/.claude/skills" }],
    workspace: [],
  };
  const here = { machineId: "machine-1", runtime: "claude", agentId: "agent-1" };
  assert.deepEqual(await service.cachedSkills(here), { state: "unavailable" });
  assert.deepEqual(await service.probeSkills(here, async () => skills), { state: "ok", value: skills });
  assert.deepEqual([...backend.values.keys()], ["slock:computer-probe-cache:v1:skills:machine-1:claude:agent-1"]);

  const slow = service.probeSkills(here, () => new Promise(() => {}));
  await clock.advance(6_000);
  assert.deepEqual(await slow, { state: "stale", value: skills, fetchedAt: "2026-10-21T08:00:00.000Z" });
  assert.deepEqual(await service.cachedSkills({ ...here, agentId: "agent-2" }), { state: "unavailable" });
  // The agent moved to another Computer, or changed runtime: the old list is not its list.
  assert.deepEqual(await service.cachedSkills({ ...here, machineId: "machine-2" }), { state: "unavailable" });
  assert.deepEqual(await service.cachedSkills({ ...here, runtime: "codex" }), { state: "unavailable" });

  // No Computer: nothing is read or written.
  const unassigned = { ...here, machineId: null };
  assert.deepEqual(await service.probeSkills(unassigned, async () => skills), { state: "ok", value: skills });
  assert.equal(backend.values.size, 1);
  const slowUnassigned = service.probeSkills(unassigned, () => new Promise(() => {}));
  await clock.advance(6_000);
  assert.deepEqual(await slowUnassigned, { state: "unavailable" });
});

test("malformed or unreadable cache records are treated as missing", async () => {
  const backend = memoryBackend();
  const service = new ComputerProbeCacheService(backend, { clock: manualClock() });
  const put = (value: string) => backend.values.set(MODELS_KEY, { value, ttlSeconds: 600 });
  for (const raw of [
    "not-json",
    JSON.stringify({ value: LIVE }),
    JSON.stringify({ fetchedAt: "yesterday", value: LIVE }),
    JSON.stringify({ fetchedAt: "2026-10-21T08:00:00.000Z", value: { kind: "error", retryable: true } }),
    JSON.stringify({ fetchedAt: "2026-10-21T08:00:00.000Z", value: { kind: "live", value: { models: [] } } }),
    JSON.stringify({ fetchedAt: "2026-10-21T08:00:00.000Z", value: { kind: "live", value: { models: [{ id: 7 }] } } }),
  ]) {
    put(raw);
    assert.deepEqual(await service.cachedModels("machine-1", "codex"), { state: "unavailable" }, raw);
  }
  backend.values.set("slock:computer-probe-cache:v1:skills:machine-1:claude:agent-1", {
    value: JSON.stringify({ fetchedAt: "2026-10-21T08:00:00.000Z", value: { global: "all", workspace: [] } }),
    ttlSeconds: 600,
  });
  assert.deepEqual(await service.cachedSkills({ machineId: "machine-1", runtime: "claude", agentId: "agent-1" }), { state: "unavailable" });

  const broken = new ComputerProbeCacheService({
    async get() { throw new Error("redis down"); },
    async set() { throw new Error("redis down"); },
  }, { clock: manualClock() });
  assert.deepEqual(await broken.cachedModels("machine-1", "codex"), { state: "unavailable" });
  assert.deepEqual(await broken.probeModels("machine-1", "codex", async () => LIVE), { state: "ok", value: LIVE });
});

test("the local backend expires entries after the TTL", async () => {
  let nowMs = 1_000_000;
  const backend = createLocalComputerProbeCacheBackend(() => nowMs, new Map());
  await backend.set("key", "value", 600);
  nowMs += 599_999;
  assert.equal(await backend.get("key"), "value");
  nowMs += 1;
  assert.equal(await backend.get("key"), null);
});

test("the Redis backend sets the TTL with EX, and routing picks Redis when it is available", async () => {
  const calls: unknown[][] = [];
  const store = new Map<string, string>();
  const client: ComputerProbeRedisClient = {
    async get(key) { return store.get(key) ?? null; },
    async set(key, value, mode, ttlSeconds) {
      calls.push([key, mode, ttlSeconds]);
      store.set(key, value);
      return "OK";
    },
  };
  const redis = createRedisComputerProbeCacheBackend(() => client);
  const local = createLocalComputerProbeCacheBackend(() => 0, new Map());
  let redisAvailable = true;
  const routing = createComputerProbeRoutingBackend({ isSharedAvailable: () => redisAvailable, shared: redis, local });

  // Two replicas sharing Redis see each other's answers.
  const replicaA = new ComputerProbeCacheService(routing, { clock: manualClock() });
  const replicaB = new ComputerProbeCacheService(routing, { clock: manualClock() });
  await replicaA.probeModels("machine-1", "codex", async () => LIVE);
  assert.deepEqual(calls, [[MODELS_KEY, "EX", 600]]);
  assert.equal((await replicaB.cachedModels("machine-1", "codex")).state, "stale");

  redisAvailable = false;
  assert.equal((await replicaB.cachedModels("machine-1", "codex")).state, "unavailable", "the local fallback starts empty");
  await replicaB.probeModels("machine-1", "codex", async () => NEWER);
  assert.deepEqual(calls.length, 1, "Redis is not written while unavailable");
  assert.deepEqual(await replicaB.cachedModels("machine-1", "codex"), {
    state: "stale",
    value: NEWER,
    fetchedAt: "2026-10-21T08:00:00.000Z",
  });
});
