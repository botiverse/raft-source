import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BasicTracer, KIMI_SDK_FORM_DEFINITION_REF, MemoryTraceSink, type RuntimeModelSourceOutcome } from "@botiverse/raft-shared";
import { afterAll, vi } from "vitest";

import { getDb } from "../db/index";
import { machines, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import {
  ComputerProbeCacheService,
  createLocalComputerProbeCacheBackend,
  type AgentSkillsList,
} from "../services/computerProbeCacheService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

/**
 * Runtime models, runtime-form option sources and agent skills behind a slow
 * Computer (computerProbeCacheService): the owner answers within its wait
 * budget, a late answer is cached, and a front replica whose replay to the
 * owner failed answers from the same cache. Never a 504 for these reads.
 *
 * The replica owner lookup is Redis-backed; it is replaced here so the front
 * replica sees an owner at an endpoint the test controls.
 */
const replay = vi.hoisted(() => {
  const saved = {
    timeout: process.env.SLOCK_REPLICA_REPLAY_TIMEOUT_MS,
    handoff: process.env.SLOCK_MACHINE_OWNER_HANDOFF_WAIT_MS,
  };
  process.env.SLOCK_REPLICA_REPLAY_TIMEOUT_MS = "300";
  process.env.SLOCK_MACHINE_OWNER_HANDOFF_WAIT_MS = "1";
  return { endpoint: null as string | null, saved };
});

vi.mock("../replicaRouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../replicaRouter")>();
  return {
    ...actual,
    getMachineReplicaReplayTarget: async () => replay.endpoint
      ? {
          replicaId: "replica-owner",
          endpoint: replay.endpoint,
          generation: "generation-1",
          // A fresh lease: a failed replay never clears it.
          version: String(Date.now()),
          currentReplica: false,
        }
      : null,
  };
});

afterAll(() => {
  for (const [name, value] of [
    ["SLOCK_REPLICA_REPLAY_TIMEOUT_MS", replay.saved.timeout],
    ["SLOCK_MACHINE_OWNER_HANDOFF_WAIT_MS", replay.saved.handoff],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const test = createApiTest();

const LIVE: RuntimeModelSourceOutcome = {
  kind: "live",
  value: { models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4" },
};
const NEWER: RuntimeModelSourceOutcome = {
  kind: "live",
  value: { models: [{ id: "gpt-5.5", label: "GPT 5.5" }], default: "gpt-5.5" },
};
const SKILLS: AgentSkillsList = {
  global: [{ name: "review", displayName: "Review", description: "Review a diff", userInvocable: true, sourcePath: "~/.claude/skills" }],
  workspace: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const never = <T>() => new Promise<T>(() => {});

async function seedFixture(slug: string, daemonVersion: string | null = "1.2.3") {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@slock.test`,
    name: slug,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`${slug} server`, `${slug}-server`, owner!.id);
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner!.id,
    name: `${slug}-machine`,
    apiKeyHash: `${slug}-machine-hash`,
    runtimes: ["codex", "grok", "kimi-sdk"],
    daemonVersion,
  }).returning();
  const agent = await createAgent(server.id, `${slug}-agent`, {
    runtime: "codex",
    machineId: machine!.id,
    creatorType: "user",
    creatorId: owner!.id,
  });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner!.email)}`, "X-Server-Id": server.id };
  return { owner: owner!, server, machine: machine!, agent, headers };
}

function useTracer(app: { app: { set(name: string, value: unknown): void } }) {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const requestSpan = (route: string) => sink.getAllSpans().find((span) =>
    span.name === "server.http.request" && span.attrs?.route_pattern === route);
  return { sink, requestSpan };
}

/** A short wait budget and a cache of its own; the 6s/10s timing is pinned in computerProbeCacheService.test.ts. */
function useProbeCache(app: { app: { set(name: string, value: unknown): void } }) {
  const probes = new ComputerProbeCacheService(createLocalComputerProbeCacheBackend(Date.now, new Map()), { waitMs: 50 });
  app.app.set("computerProbeCache", probes);
  return probes;
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition never held");
}

const MODELS_ROUTE = "/api/servers/:id/machines/:machineId/runtime-models/:runtime";
const V2_SOURCE_ROUTE = "/api/servers/:id/machines/:machineId/runtime-forms/v2/:runtimeId/option-sources/:sourceId";

test("owner: a Computer slower than the wait answers unavailable, its late list is cached, the next open gets it stale, and a fresh answer wins", async ({ app }) => {
  const { requestSpan, sink } = useTracer(app);
  const probes = useProbeCache(app);
  const { server, machine, headers } = await seedFixture("probe-owner-models");
  let detect: () => Promise<RuntimeModelSourceOutcome> = never;
  app.app.set("agentOrchestrator", {
    hasMachineLocally: () => true,
    isMachineAccessRevoked: async () => false,
    detectMachineRuntimeModels: () => detect(),
  });
  const base = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`;
  const models = async () => {
    sink.clear();
    const res = await fetch(`${base}/runtime-models/codex`, { headers });
    assert.equal(res.status, 200);
    return await res.json() as Record<string, unknown>;
  };
  const codexSource = async () => {
    const res = await fetch(`${base}/runtime-forms/v2/codex/option-sources/model`, { headers });
    assert.equal(res.status, 200);
    return await res.json() as Record<string, unknown> & { options: Array<{ value: string }> };
  };

  // First open: the Computer answers later than the wait.
  const late = deferred<RuntimeModelSourceOutcome>();
  detect = () => late.promise;
  assert.deepEqual(await models(), { kind: "error", retryable: true, code: "detect_timeout", state: "unavailable" });
  assert.equal(requestSpan(MODELS_ROUTE)?.attrs?.computer_probe_state, "unavailable");
  assert.equal(requestSpan(MODELS_ROUTE)?.attrs?.target_daemon_version, "1.2.3");
  const unavailableSource = await codexSource();
  assert.deepEqual(
    [unavailableSource.status, unavailableSource.reason, unavailableSource.retryable, unavailableSource.state],
    ["fallback", "probe_timeout", true, "unavailable"],
    "no earlier list: the bundled one, marked as a timed-out probe",
  );

  // The request was not cancelled: its answer lands in the cache.
  late.resolve(LIVE);
  await eventually(async () => (await probes.cachedModels(machine.id, "codex")).state === "stale");

  // Next open while the Computer is still slow: that list, marked stale.
  detect = never;
  const stale = await models();
  assert.equal(stale.state, "stale");
  assert.equal(typeof stale.fetchedAt, "string");
  assert.deepEqual(
    { kind: stale.kind, value: stale.value, models: stale.models, default: stale.default },
    { kind: "live", value: LIVE.kind === "live" ? LIVE.value : null, models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4" },
  );
  assert.equal(requestSpan(MODELS_ROUTE)?.attrs?.computer_probe_state, "stale");
  const staleSource = await codexSource();
  assert.deepEqual(
    [staleSource.status, staleSource.reason, staleSource.retryable, staleSource.state, staleSource.fetchedAt],
    ["fallback", "probe_timeout", true, "stale", stale.fetchedAt],
  );
  assert.deepEqual(staleSource.options.map((option) => option.value), ["gpt-5.4"], "the option source is derived from the cached list");

  // A fresh answer is served as ok and rewrites the cache.
  detect = async () => NEWER;
  const fresh = await models();
  assert.deepEqual([fresh.state, fresh.default, "fetchedAt" in fresh], ["ok", "gpt-5.5", false]);
  assert.equal(requestSpan(MODELS_ROUTE)?.attrs?.computer_probe_state, "ok", "an answered probe is traced as ok");
  const tagged = await fetch(`${base}/runtime-models/codex`, { headers });
  assert.equal(tagged.headers.get("x-raft-computer-probe-state"), "ok", "the owner tags its answer for a relaying front replica");
  await tagged.body?.cancel();
  sink.clear();
  const liveSource = await codexSource();
  assert.equal(requestSpan(V2_SOURCE_ROUTE)?.attrs?.computer_probe_state, "ok", "the v2 source too");
  assert.deepEqual([liveSource.status, "state" in liveSource], ["live", false], "an answered probe keeps the body unchanged");
  detect = never;
  assert.equal((await models()).default, "gpt-5.5", "the stale fallback is now the fresh list");
});

test("front replica: a failed replay answers these reads from the shared cache, never 504; other routes keep their replay failure", async ({ app }) => {
  const { requestSpan, sink } = useTracer(app);
  const probes = useProbeCache(app);
  const { owner, server, machine, agent, headers } = await seedFixture("probe-front-replica");
  const uncached = await createAgent(server.id, "probe-front-replica-other", {
    runtime: "codex",
    machineId: machine.id,
    creatorType: "user",
    creatorId: owner.id,
  });
  let probed = 0;
  app.app.set("agentOrchestrator", {
    hasMachineLocally: () => false,
    isMachineAccessRevoked: async () => false,
    detectMachineRuntimeModels: async () => { probed += 1; return LIVE; },
    getAgentSkills: async () => { probed += 1; return SKILLS; },
  });
  // What the owner replica cached before it went quiet.
  await probes.probeModels(machine.id, "codex", async () => LIVE);
  await probes.probeSkills({ machineId: machine.id, runtime: "codex", agentId: agent.id }, async () => SKILLS);

  // An owner replica that accepts the connection and never answers.
  const blackhole: HttpServer = createHttpServer(() => {});
  await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
  const ownerPort = (blackhole.address() as AddressInfo).port;
  replay.endpoint = `http://127.0.0.1:${ownerPort}`;
  const base = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`;
  try {
    sink.clear();
    const modelsRes = await fetch(`${base}/runtime-models/codex`, { headers });
    assert.equal(modelsRes.status, 200);
    const models = await modelsRes.json() as Record<string, unknown>;
    assert.deepEqual([models.kind, models.state, models.default], ["live", "stale", "gpt-5.4"]);
    const span = requestSpan(MODELS_ROUTE);
    assert.equal(span?.attrs?.error_code, "machine_affinity_replay_timeout", "the replay timeout stays visible in traces");
    assert.equal(span?.attrs?.computer_probe_state, "stale");
    assert.equal(span?.attrs?.status_code, 200);

    const grokRes = await fetch(`${base}/runtime-models/grok`, { headers });
    assert.equal(grokRes.status, 200);
    assert.deepEqual(await grokRes.json(), { kind: "error", retryable: true, code: "detect_timeout", state: "unavailable" });

    const v2Res = await fetch(`${base}/runtime-forms/v2/codex/option-sources/model`, { headers });
    assert.equal(v2Res.status, 200);
    const v2 = await v2Res.json() as Record<string, unknown> & { options: Array<{ value: string }> };
    assert.deepEqual([v2.status, v2.reason, v2.state], ["fallback", "probe_timeout", "stale"]);
    assert.deepEqual(v2.options.map((option) => option.value), ["gpt-5.4"]);

    // v1 clients get a usable list: here nothing is cached, so Kimi's managed default.
    const v1Res = await fetch(
      `${base}/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=${KIMI_SDK_FORM_DEFINITION_REF.schemaVersion}`,
      { headers },
    );
    assert.equal(v1Res.status, 200);
    const v1 = await v1Res.json() as Record<string, unknown>;
    assert.equal("status" in v1 || "state" in v1, false, "v1 bodies keep their shape");

    const skillsRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/skills`, { headers });
    assert.equal(skillsRes.status, 200);
    const skills = await skillsRes.json() as Record<string, unknown>;
    assert.deepEqual([skills.global, skills.workspace, skills.state], [SKILLS.global, [], "stale"]);
    assert.equal(typeof skills.fetchedAt, "string");
    const uncachedSkills = await fetch(`${app.baseUrl}/api/agents/${uncached.id}/skills`, { headers });
    assert.equal(uncachedSkills.status, 200);
    assert.deepEqual(await uncachedSkills.json(), { global: [], workspace: [], state: "unavailable" });

    // A route that did not opt in keeps its 504.
    const workspace = await fetch(`${app.baseUrl}/api/agents/${agent.id}/workspace-files`, { headers });
    assert.equal(workspace.status, 504);
    assert.equal((await workspace.json() as { code?: string }).code, "machine_affinity_replay_timeout");
  } finally {
    blackhole.closeAllConnections();
    await new Promise((resolve) => blackhole.close(resolve));
  }

  // The owner replica is gone (connection refused): the same fallback, reported as a failed replay.
  replay.endpoint = `http://127.0.0.1:${ownerPort}`;
  try {
    sink.clear();
    const goneRes = await fetch(`${base}/runtime-models/codex`, { headers });
    assert.equal(goneRes.status, 200);
    assert.equal((await goneRes.json() as { state?: string }).state, "stale");
    assert.equal(requestSpan(MODELS_ROUTE)?.attrs?.error_code, "machine_affinity_replay_failed");
  } finally {
    replay.endpoint = null;
  }

  // The owner replica answers that it holds no socket for this Computer: it is
  // offline, answered as offline (not a cached 200).
  const notOwner: HttpServer = createHttpServer((_req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "machine_owner_not_local" }));
  });
  await new Promise<void>((resolve) => notOwner.listen(0, "127.0.0.1", resolve));
  replay.endpoint = `http://127.0.0.1:${(notOwner.address() as AddressInfo).port}`;
  try {
    const offlineModels = await fetch(`${base}/runtime-models/codex`, { headers });
    assert.equal(offlineModels.status, 200);
    assert.deepEqual(await offlineModels.json(), { kind: "error", retryable: true, code: "computer_offline", state: "ok" });
    const offlineSkills = await fetch(`${app.baseUrl}/api/agents/${agent.id}/skills`, { headers });
    assert.equal(offlineSkills.status, 409);
    assert.equal((await offlineSkills.json() as { code?: string }).code, "machine_offline");
    const offlineSource = await (await fetch(`${base}/runtime-forms/v2/codex/option-sources/model`, { headers })).json() as Record<string, unknown>;
    assert.deepEqual([offlineSource.reason, "state" in offlineSource], ["machine_offline", false]);
  } finally {
    replay.endpoint = null;
    notOwner.closeAllConnections();
    await new Promise((resolve) => notOwner.close(resolve));
  }
  assert.equal(probed, 0, "the front replica never asks the Computer itself");
});

test("skills: the request span names the Computer, an owner timeout is 200, and the late list is served next", async ({ app }) => {
  const { requestSpan, sink } = useTracer(app);
  const probes = useProbeCache(app);
  const { agent, machine, headers } = await seedFixture("probe-owner-skills", "0.99.1");
  let list: () => Promise<AgentSkillsList> = never;
  app.app.set("agentOrchestrator", {
    hasMachineLocally: () => true,
    isMachineAccessRevoked: async () => false,
    getAgentSkills: () => list(),
  });
  const route = "/api/agents/:id/skills";
  const skills = async () => {
    sink.clear();
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/skills`, { headers });
    assert.equal(res.status, 200);
    return await res.json() as Record<string, unknown>;
  };

  const late = deferred<AgentSkillsList>();
  list = () => late.promise;
  assert.deepEqual(await skills(), { global: [], workspace: [], state: "unavailable" });
  const span = requestSpan(route);
  assert.equal(span?.attrs?.target_daemon_version, "0.99.1");
  assert.equal(span?.attrs?.target_runtime, "codex");
  assert.equal(span?.attrs?.computer_probe_state, "unavailable");
  assert.equal(Object.values(span?.attrs ?? {}).includes(machine.id), false, "the Computer id is hashed");

  late.resolve(SKILLS);
  await eventually(async () =>
    (await probes.cachedSkills({ machineId: machine.id, runtime: "codex", agentId: agent.id })).state === "stale");
  list = never;
  const stale = await skills();
  assert.deepEqual([stale.global, stale.state], [SKILLS.global, "stale"]);
  assert.equal(requestSpan(route)?.attrs?.computer_probe_state, "stale");

  list = async () => ({ global: [], workspace: SKILLS.global });
  assert.deepEqual(await skills(), { global: [], workspace: SKILLS.global, state: "ok" });
  list = never;
  assert.deepEqual((await skills()).workspace, SKILLS.global, "a fresh list rewrites the cache");
});

// AndyLok (staging check of #10566): a front replica that relayed the owner's
// in-time answer recorded no computer_probe_state, so ok could not be counted.
test("front replica: a relayed owner answer keeps the owner's probe state on the front request span", async ({ app }) => {
  const { requestSpan, sink } = useTracer(app);
  useProbeCache(app);
  const { server, machine, headers } = await seedFixture("probe-front-relayed");
  app.app.set("agentOrchestrator", {
    hasMachineLocally: () => false,
    isMachineAccessRevoked: async () => false,
    detectMachineRuntimeModels: async () => LIVE,
  });
  // The owner replica answers in time and tags the answer like the owner route does.
  const ownerReplica: HttpServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-raft-computer-probe-state": "ok" });
    res.end(JSON.stringify({ ...LIVE, models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4", state: "ok" }));
  });
  await new Promise<void>((resolve) => ownerReplica.listen(0, "127.0.0.1", resolve));
  replay.endpoint = `http://127.0.0.1:${(ownerReplica.address() as AddressInfo).port}`;
  try {
    sink.clear();
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/codex`, { headers });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { state?: string }).state, "ok");
    const span = requestSpan(MODELS_ROUTE);
    assert.equal(span?.attrs?.computer_probe_state, "ok");
    assert.equal(span?.attrs?.error_code, undefined, "a relayed answer is not a replay failure");
  } finally {
    replay.endpoint = null;
    ownerReplica.closeAllConnections();
    await new Promise((resolve) => ownerReplica.close(resolve));
  }
});
