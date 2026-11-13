/**
 * task #1357 item 1, end to end on the server: `agent:model_limits` frames
 * through `handleMachineMessage` into per-instance rows, and the derived
 * `modelLimits: { defaultsReported }` on the agent detail, the directory and
 * the PATCH answer. Real DB rows and routes (PGlite: one connection, so
 * interleavings are handlers paused at their awaits; another replica's late
 * commit is a direct write); only the machine socket is stubbed.
 */
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import {
  DAEMON_CAPABILITY_AGENT_CONFIG_PUSH,
  DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  RUNTIME_CONFIG_VERSION,
  type AgentModelLimitsFrame,
  type MachineToServerMessage,
  type ModelLimits,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentModelLimitsReports, agentProviderConnections, agents, featureFlagRules, machines, managedMcpServers, providerConnections, users } from "../db/schema";
import { createManagedMcpServer } from "../services/managedMcpService";
import { recordAgentModelLimitsReport } from "../services/agentModelLimitsService";
import { AgentOrchestrator, type ResetAgentOptions } from "../services/agentOrchestrator";
import { bumpAgentConfigRevision } from "../services/agentConfigRevision";
import { createServer } from "../services/serverService";
import { createProviderConnection } from "../services/providerConnectionService";

const test = createApiTest();

const DEFAULTS: ModelLimits = { contextWindow: { value: 200_000, source: "raft_default" }, maxTokens: { value: 8192, source: "raft_default" } };
const CATALOG: ModelLimits = { contextWindow: { value: 1_000_000, source: "catalog" }, maxTokens: { value: 131_072, source: "catalog" } };
const MIXED: ModelLimits = { contextWindow: { value: 1_000_000, source: "catalog" }, maxTokens: { value: 8192, source: "raft_default" } };

const GATEWAY_CONFIG = {
  version: RUNTIME_CONFIG_VERSION,
  runtime: "builtin",
  provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", apiKey: "gateway-secret-key" },
  hostUserState: "forbidden",
  model: { kind: "custom", name: "acme/custom" },
  mode: { kind: "default" },
  reasoningEffort: null,
  envVars: null,
} as const;

class RouteOrchestrator extends AgentOrchestrator {
  readonly updates: string[] = [];
  startingResolves = 0;

  protected override maybeResolveStartingActivity(agentId: string, span?: Parameters<AgentOrchestrator["maybeResolveStartingActivity"]>[1]) {
    this.startingResolves += 1;
    return super.maybeResolveStartingActivity(agentId, span);
  }

  override async resetAgent(_agentId: string, _mode: "restart" | "session" | "full", _options: ResetAgentOptions = {}) {}

  /** A connected Computer whose ready named daemon instance `instance`; `ready: false` is a socket whose ready was not handled yet. Returns the socket. */
  bind(machineId: string, serverId: string, capabilities: string[], options: { ready?: boolean; instance?: string } = {}): object {
    const ws = { readyState: 1, send: () => undefined };
    const instance = options.ready === false ? null : options.instance ?? "inst-1";
    (this as any).machineConnections.set(machineId, {
      ws,
      daemonInstanceId: instance,
      machineId,
      serverId,
      principalKind: "computer",
      connectionEpochId: `epoch-${machineId}`,
      replicaGeneration: "1",
      heartbeatTimer: null,
      runtimeAccountUsageTimer: null,
      lastPong: Date.now(),
      lastIngressAt: Date.now(),
      daemonVersion: "1.0.99",
      capabilities: new Set<string>(capabilities),
      readyCapabilitiesKnown: options.ready ?? true,
      runtimes: ["builtin"],
      migrationTransport: null,
      shutdownIntent: null,
      computerVersion: "1.0.99",
    });
    (this as any).io = { to: () => ({ emit: (event: string, payload: { agentId: string }) => { if (event === "agent:updated") this.updates.push(payload.agentId); } }) };
    return ws;
  }

  unbind(machineId: string): void {
    (this as any).machineConnections.delete(machineId);
  }
}

async function seed(app: { app: { set: (key: string, value: unknown) => void } }, options: { capabilities?: string[]; runtimeConfig?: unknown; runtime?: string } = {}) {
  const slug = `limits-${randomUUID().slice(0, 8)}`;
  const [owner] = await getDb().insert(users).values({
    email: `${slug}@slock.test`,
    name: slug,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Model Limits", slug, owner!.id);
  const [machine, otherMachine] = await getDb().insert(machines).values([
    { serverId: server.id, userId: owner!.id, name: "limits-mac", apiKeyHash: `hash-${slug}` },
    { serverId: server.id, userId: owner!.id, name: "limits-mac-2", apiKeyHash: `hash2-${slug}` },
  ]).returning();
  const [agent] = await getDb().insert(agents).values({
    serverId: server.id,
    name: "limits-agent",
    status: "active",
    runtime: options.runtime ?? "builtin",
    model: "acme/custom",
    runtimeConfig: (options.runtimeConfig === undefined ? GATEWAY_CONFIG : options.runtimeConfig) as any,
    executionMode: "byoc",
    machineId: machine!.id,
    sessionId: "session-1",
    creatorType: "user",
    creatorId: owner!.id,
  }).returning();
  const orchestrator = new RouteOrchestrator();
  orchestrator.bind(machine!.id, server.id, options.capabilities ?? [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH, DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1]);
  app.app.set("agentOrchestrator", orchestrator);
  const token = await tokenForHuman(owner!.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  return { owner: owner!, server, machine: machine!, otherMachine: otherMachine!, agent: agent!, orchestrator, headers };
}

function frame(agentId: string, overrides: Partial<AgentModelLimitsFrame> = {}): AgentModelLimitsFrame {
  return {
    type: "agent:model_limits",
    v: 1,
    agentId,
    launchId: "launch-1",
    sessionId: "session-1",
    configRevision: 0,
    daemonInstanceId: "inst-1",
    seq: 1,
    observedAtMs: 1_794_000_000_000,
    runtime: "builtin",
    modelLimits: DEFAULTS,
    ...overrides,
  };
}

type Warning = { defaultsReported: boolean };

async function limitsOf(app: { baseUrl: string }, headers: Record<string, string>, agentId: string): Promise<Warning | undefined> {
  const res = await fetch(`${app.baseUrl}/api/agents/${agentId}`, { headers });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json() as { modelLimits?: Warning }).modelLimits;
}

/** The agent's stored report of one daemon instance (default inst-1). */
async function storedRow(agentId: string, instance = "inst-1") {
  return (await getDb().select().from(agentModelLimitsReports).where(and(
    eq(agentModelLimitsReports.agentId, agentId),
    eq(agentModelLimitsReports.daemonInstanceId, instance),
  )))[0] ?? null;
}

const SHOWN = { defaultsReported: true };
const NOT_SHOWN = { defaultsReported: false };

test("a Raft default reported by the current session on the current Computer for the current revision raises the signal; detail, directory and agent:updated agree", async ({ app }) => {
  const { machine, agent, orchestrator, headers } = await seed(app);
  try {
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: MIXED }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), SHOWN, "one raft_default field is enough");
    assert.deepEqual(orchestrator.updates, [agent.id], "agent:updated after storing");
    const list = await fetch(`${app.baseUrl}/api/agents`, { headers });
    const listed = await list.json() as { agents?: Array<{ id: string; modelLimits?: Warning }> } | Array<{ id: string; modelLimits?: Warning }>;
    const rows = Array.isArray(listed) ? listed : listed.agents ?? [];
    assert.deepEqual(rows.find((row) => row.id === agent.id)?.modelLimits, SHOWN);
    const body = JSON.stringify(await (await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { headers })).json());
    assert.equal(body.includes("200000") || body.includes("1000000") || body.includes("raft_default"), false, "no numbers and no per-field source reach the web");
  } finally {
    await orchestrator.shutdown();
  }
});

test("nothing to show: a catalog-only report, no report at all; not a gateway custom model: no modelLimits", async ({ app }) => {
  const { machine, agent, orchestrator, headers } = await seed(app);
  try {
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN, "no report");
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: CATALOG }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN, "a catalog report never reads as confirmed: just nothing to show");
  } finally {
    await orchestrator.shutdown();
  }
  const preset = await seed(app, { runtime: "claude", runtimeConfig: null });
  try {
    assert.equal(await limitsOf(app, preset.headers, preset.agent.id), undefined);
  } finally {
    await preset.orchestrator.shutdown();
  }
});

test("mixed instances (one catalog, one default) for the same session and revision: shown, whatever the arrival order", async ({ app }) => {
  const { server, machine, agent, orchestrator, headers } = await seed(app);
  try {
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
    orchestrator.bind(machine.id, server.id, [DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1], { instance: "inst-2" });
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { daemonInstanceId: "inst-2", modelLimits: CATALOG }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), SHOWN);
  } finally {
    await orchestrator.shutdown();
  }
});

test("another session: a default row of an earlier session does not raise the signal", async ({ app }) => {
  const { machine, agent, orchestrator, headers } = await seed(app);
  try {
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
    await getDb().update(agents).set({ sessionId: "session-2" }).where(eq(agents.id, agent.id));
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN);
    await getDb().update(agents).set({ sessionId: null }).where(eq(agents.id, agent.id));
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN, "no session known: nothing");
  } finally {
    await orchestrator.shutdown();
  }
});

test("another revision (PATCH to another model): the old session's default row no longer counts; the PATCH answer already says so; a report for the new revision does", async ({ app }) => {
  const { machine, agent, orchestrator, headers } = await seed(app);
  try {
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), SHOWN);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ runtimeConfig: { ...GATEWAY_CONFIG, provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1" }, model: { kind: "custom", name: "acme/other" } } }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await res.json() as { modelLimits?: Warning | null }).modelLimits, NOT_SHOWN, "the PATCH answer replaces the client's copy");
    assert.equal((await getDb().select({ revision: agents.configRevision }).from(agents).where(eq(agents.id, agent.id)))[0]!.revision, 1);
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN);
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN, "the old session's re-send stays old");
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { configRevision: 1, seq: 2, modelLimits: DEFAULTS }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), SHOWN);
  } finally {
    await orchestrator.shutdown();
  }
});

test("a shared connection's endpoint edit moves the revision: no longer shown; a connection without an endpoint gets no modelLimits", async ({ app }) => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
  const { owner, server, machine, agent, orchestrator, headers } = await seed(app);
  try {
    await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, stage: "server", priority: -100, decision: "allow", values: [server.id] });
    const connection = await createProviderConnection({ serverId: server.id, userId: owner.id, name: "Gateway", providerId: "openai-compatible", endpointUrl: "https://gateway.example.test/v1", apiKey: "k" });
    await getDb().update(agents).set({ runtimeConfig: { ...GATEWAY_CONFIG, provider: { kind: "connection", connectionId: connection.id } } as any }).where(eq(agents.id, agent.id));
    await getDb().insert(agentProviderConnections).values({ serverId: server.id, agentId: agent.id, connectionId: connection.id, expectedConfigVersion: 1, expectedCredentialVersion: 1 });
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), SHOWN, "a gateway connection counts");
    orchestrator.updates.length = 0;
    const res = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}`, { method: "PATCH", headers, body: JSON.stringify({ endpointUrl: "https://other-gateway.example.test/v1" }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN);
    assert.ok(orchestrator.updates.includes(agent.id), "agent:updated for the revision bump");
    await getDb().update(providerConnections).set({ endpointUrl: null }).where(eq(providerConnections.id, connection.id));
    assert.equal(await limitsOf(app, headers, agent.id), undefined);
  } finally {
    await orchestrator.shutdown();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

test("another Computer (after migration): the old Computer's default rows never count; its later frames are refused; the new Computer's report does count", async ({ app }) => {
  const { server, machine, otherMachine, agent, orchestrator, headers } = await seed(app);
  try {
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
    await getDb().update(agents).set({ machineId: otherMachine.id }).where(eq(agents.id, agent.id));
    orchestrator.evictCache(agent.id);
    orchestrator.bind(otherMachine.id, server.id, [DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1], { instance: "inst-b" });
    assert.deepEqual(await limitsOf(app, headers, agent.id), NOT_SHOWN);
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { seq: 2, modelLimits: DEFAULTS }));
    assert.equal((await storedRow(agent.id))?.seq, 1, "the old Computer's later frame is dropped");
    await orchestrator.handleMachineMessage(otherMachine.id, frame(agent.id, { daemonInstanceId: "inst-b", modelLimits: DEFAULTS }));
    assert.deepEqual(await limitsOf(app, headers, agent.id), SHOWN);
  } finally {
    await orchestrator.shutdown();
  }
});

test("per instance: ordering by (revision, seq) within an instance; re-send idempotent; a future revision refused; an armed launch guard drops a stale launch without side effects", async ({ app }) => {
  const { machine, agent, orchestrator } = await seed(app);
  try {
    await bumpAgentConfigRevision(getDb(), [agent.id]);
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { launchId: "launch-2", configRevision: 1, seq: 5, modelLimits: CATALOG }));
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { launchId: "launch-1", configRevision: 0, seq: 6 }));
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { launchId: "launch-1", configRevision: 1, seq: 4 }));
    let row = await storedRow(agent.id);
    assert.equal(row?.launchId, "launch-2");
    assert.equal(row?.seq, 5);
    const updatesBefore = orchestrator.updates.length;
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { launchId: "launch-2", configRevision: 1, seq: 5, modelLimits: CATALOG }));
    assert.equal(orchestrator.updates.length, updatesBefore, "an exact re-send writes nothing");
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { launchId: "launch-2", configRevision: 7, seq: 6 }));
    assert.equal((await storedRow(agent.id))?.configRevision, 1, "a revision ahead of agents.config_revision is refused");

    (orchestrator as any).setLaunchGuard(agent.id, "launch-3");
    const starting = { activity: "working", detail: "Starting…", detailKind: "starting", updatedAt: Date.now() };
    (orchestrator as any).agentActivity.set(agent.id, starting);
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { launchId: "launch-2", configRevision: 1, seq: 8 }));
    row = await storedRow(agent.id);
    assert.equal(row?.seq, 5);
    assert.equal(orchestrator.startingResolves, 0, "no starting-activity resolve for a dropped display report");
    assert.equal((orchestrator as any).agentActivity.get(agent.id), starting, "activity unchanged");
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { launchId: "launch-3", configRevision: 1, seq: 9, observedAtMs: 1_000 }));
    assert.equal((await storedRow(agent.id))?.launchId, "launch-3", "a later session of the same instance and revision wins by seq; no clock compared");
  } finally {
    await orchestrator.shutdown();
  }
});

test("per instance: a frame paused in the handler while a new process connects and reports writes only its own row on resume", async ({ app }) => {
  const { server, machine, agent, orchestrator } = await seed(app);
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => { markPaused = resolve; });
    const validate = (orchestrator as any).validateMachineAgentMessage.bind(orchestrator);
    let first = true;
    (orchestrator as any).validateMachineAgentMessage = async (...args: unknown[]) => {
      if (first) {
        first = false;
        markPaused();
        await gate;
      }
      return validate(...args);
    };
    const inFlight = orchestrator.handleMachineMessage(machine.id, frame(agent.id, { seq: 9, modelLimits: CATALOG }));
    await paused;
    orchestrator.bind(machine.id, server.id, [DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1], { instance: "inst-2" });
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { daemonInstanceId: "inst-2", seq: 1, modelLimits: DEFAULTS }));
    release();
    await inFlight;
    assert.deepEqual((await storedRow(agent.id, "inst-2"))?.modelLimits, DEFAULTS, "inst-2's row is untouched");
    assert.deepEqual((await storedRow(agent.id, "inst-1"))?.modelLimits, CATALOG, "the resumed frame wrote only its own row");
  } finally {
    await orchestrator.shutdown();
  }
});

test("per instance: another replica's late commit of the old instance lands in its own row only", async ({ app }) => {
  const { server, machine, agent, orchestrator } = await seed(app);
  try {
    orchestrator.bind(machine.id, server.id, [DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1], { instance: "inst-2" });
    await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { daemonInstanceId: "inst-2", seq: 1, modelLimits: DEFAULTS }));
    assert.equal(await recordAgentModelLimitsReport({ serverId: server.id, machineId: machine.id, frame: frame(agent.id, { seq: 50, modelLimits: CATALOG }) }), "stored");
    assert.deepEqual((await storedRow(agent.id, "inst-2"))?.modelLimits, DEFAULTS);
  } finally {
    await orchestrator.shutdown();
  }
});

test("server restart: a new orchestrator derives the same signal from the database; the re-send is idempotent; an old instance's frame on a stale socket is dropped", async ({ app }) => {
  const { server, machine, agent, orchestrator, headers } = await seed(app);
  await orchestrator.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
  await orchestrator.shutdown();
  const restarted = new RouteOrchestrator();
  restarted.bind(machine.id, server.id, [DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1]);
  app.app.set("agentOrchestrator", restarted);
  try {
    assert.deepEqual(await limitsOf(app, headers, agent.id), SHOWN);
    await restarted.handleMachineMessage(machine.id, frame(agent.id, { modelLimits: DEFAULTS }));
    assert.deepEqual(restarted.updates, [], "the same frame again writes nothing");
    const oldSocket = (restarted as any).machineConnections.get(machine.id).ws;
    restarted.bind(machine.id, server.id, [DAEMON_CAPABILITY_MODEL_LIMITS_REPORT_V1], { instance: "inst-2" });
    await restarted.handleMachineMessage(machine.id, frame(agent.id, { seq: 7, modelLimits: CATALOG }), oldSocket as never);
    await restarted.handleMachineMessage(machine.id, frame(agent.id, { seq: 8, modelLimits: CATALOG }));
    assert.deepEqual((await storedRow(agent.id))?.modelLimits, DEFAULTS, "old instance frames never reach the write");
  } finally {
    await restarted.shutdown();
  }
});

test("frames the server does not know, and malformed limits frames, are dropped without throwing", async ({ app }) => {
  const { machine, agent, orchestrator } = await seed(app);
  try {
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:some_future_report", agentId: agent.id } as unknown as MachineToServerMessage);
    await orchestrator.handleMachineMessage(machine.id, { ...frame(agent.id), modelLimits: { contextWindow: { value: 1, source: "guess" } } } as unknown as MachineToServerMessage);
    assert.equal(await storedRow(agent.id), null);
  } finally {
    await orchestrator.shutdown();
  }
});

// agent:updated where the signal can change: a stored report (above), a new
// session (a move to another Computer starts one), a revision bump (managed
// MCP, provider connection: above). Only agents with the signal are told.
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), label);
}

test("agent:updated: a new session from the daemon tells the agent's clients; the same session again does not; an agent without the signal is never told", async ({ app }) => {
  const { server, machine, agent, orchestrator } = await seed(app);
  const [other] = await getDb().insert(agents).values({
    serverId: server.id, name: "claude-agent", status: "active", runtime: "claude", model: "sonnet", executionMode: "byoc", machineId: machine.id, sessionId: "s-1",
  }).returning();
  try {
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:session", agentId: agent.id, sessionId: "session-2" });
    await until(() => orchestrator.updates.includes(agent.id), "pushed for the new session");
    const count = orchestrator.updates.length;
    orchestrator.evictCache(agent.id);
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:session", agentId: agent.id, sessionId: "session-2" });
    await orchestrator.handleMachineMessage(machine.id, { type: "agent:session", agentId: other!.id, sessionId: "s-2" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(orchestrator.updates.length, count, "an unchanged session, or an agent without the signal, pushes nothing");
  } finally {
    await orchestrator.shutdown();
  }
});

test("agent:updated: a managed MCP change tells the agent", async ({ app }) => {
  const originalMcpKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const { owner, server, agent, orchestrator, headers } = await seed(app);
  try {
    const mcp = await createManagedMcpServer({ serverId: server.id, userId: owner.id, name: `Docs ${randomUUID().slice(0, 6)}`, endpointUrl: "https://example.com/mcp" });
    await getDb().update(managedMcpServers).set({ toolCatalog: [{ name: "read", inputSchema: { type: "object" } }] }).where(eq(managedMcpServers.id, mcp.id));
    orchestrator.updates.length = 0;
    const bulk = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments`, { method: "PUT", headers, body: JSON.stringify({ assignments: [{ mcpServerId: mcp.id, enabled: true, allowedTools: null }] }) });
    assert.equal(bulk.status, 200, await bulk.clone().text());
    await until(() => orchestrator.updates.includes(agent.id), "pushed for the bulk MCP change");
    orchestrator.updates.length = 0;
    const single = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments/${mcp.id}`, { method: "PUT", headers, body: JSON.stringify({ allowedTools: ["read"] }) });
    assert.equal(single.status, 200, await single.clone().text());
    await until(() => orchestrator.updates.includes(agent.id), "pushed for the single MCP change");
  } finally {
    await orchestrator.shutdown();
    if (originalMcpKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalMcpKey;
  }
});

test("#proj-runtime:#50: limits set through v2 survive a v1 full save of the same model; a v2 blank or another model clears them", async ({ app }) => {
  const { agent, orchestrator, headers } = await seed(app);
  const patch = (body: unknown) => fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  const storedModel = async () => (await getDb().select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(eq(agents.id, agent.id)))[0]!.runtimeConfig as { model: Record<string, unknown> };
  const v2Values = { providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", model: "acme/custom" };
  try {
    let res = await patch({ formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: { ...v2Values, contextWindow: "128000", maxOutputTokens: "32000" } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await storedModel()).model, { kind: "custom", name: "acme/custom", contextWindow: 128_000, maxOutputTokens: 32_000 });

    // An older client saves the whole runtimeConfig as it knows it: no limits.
    res = await patch({ runtimeConfig: { ...GATEWAY_CONFIG, provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1" }, envVars: { A: "1" } } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await storedModel()).model, { kind: "custom", name: "acme/custom", contextWindow: 128_000, maxOutputTokens: 32_000 }, "kept by a v1 save of the same model");

    res = await patch({ formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: { ...v2Values, contextWindow: "", maxOutputTokens: "" } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await storedModel()).model, { kind: "custom", name: "acme/custom" }, "a v2 blank clears them");

    await patch({ formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: { ...v2Values, contextWindow: "64000" } });
    res = await patch({ runtimeConfig: { ...GATEWAY_CONFIG, provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1" }, model: { kind: "custom", name: "acme/other" } } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await storedModel()).model, { kind: "custom", name: "acme/other" }, "another model starts without the old model's limits");
  } finally {
    await orchestrator.shutdown();
  }
});
