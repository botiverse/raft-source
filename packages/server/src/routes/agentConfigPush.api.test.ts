/**
 * Reconciler step 11b, per route: a config change on a running agent is
 * pushed to a daemon that advertises `agent:config-push-v1` (it restarts the
 * agent once idle); on an older daemon every path keeps today's behaviour.
 * The routes run against a real orchestrator with a stubbed machine socket;
 * only its reset is captured.
 */
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { DAEMON_CAPABILITY_AGENT_CONFIG_INTERRUPT, DAEMON_CAPABILITY_AGENT_CONFIG_PUSH, DAEMON_CAPABILITY_CONSTRUCTED_INIT_V1, RUNTIME_CONFIG_VERSION, type AgentConfig } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, machines, managedMcpServers, users } from "../db/schema";
import { AgentOrchestrator, type ResetAgentOptions } from "../services/agentOrchestrator";
import { createServer } from "../services/serverService";
import { createManagedMcpServer, executeManagedMcpCall } from "../services/managedMcpService";

const test = createApiTest();

type ConfigFrame = { type: "agent:config"; agentId: string; config: AgentConfig; revision: number; interrupt?: boolean };

class RouteOrchestrator extends AgentOrchestrator {
  readonly resets: Array<{ agentId: string; mode: string; options: ResetAgentOptions }> = [];
  readonly frames: ConfigFrame[] = [];

  override async resetAgent(agentId: string, mode: "restart" | "session" | "full", options: ResetAgentOptions = {}) {
    this.resets.push({ agentId, mode, options });
  }

  bind(machineId: string, serverId: string, capabilities: string[]): void {
    (this as any).machineConnections.set(machineId, {
      ws: { readyState: 1, send: (raw: string) => this.frames.push(JSON.parse(raw)) },
      machineId,
      serverId,
      principalKind: "computer",
      connectionEpochId: `epoch-${machineId}`,
      replicaGeneration: 1,
      heartbeatTimer: null,
      runtimeAccountUsageTimer: null,
      lastPong: Date.now(),
      lastIngressAt: Date.now(),
      daemonVersion: "1.0.99",
      capabilities: new Set<string>(capabilities),
      runtimes: ["claude"],
      migrationTransport: null,
      shutdownIntent: null,
      computerVersion: "1.0.99",
    });
  }
}

async function seed(app: { app: { set: (key: string, value: unknown) => void } }, options: { capable: boolean; interruptCapable?: boolean; agents?: number }) {
  const slug = `push-${randomUUID().slice(0, 8)}`;
  const [owner] = await getDb().insert(users).values({
    email: `${slug}@slock.test`,
    name: slug,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Config Push", slug, owner!.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner!.id,
    name: "push-mac",
    apiKeyHash: `hash-${slug}`,
  }).returning();
  const rows = [];
  for (let index = 0; index < (options.agents ?? 1); index += 1) {
    const [agent] = await getDb().insert(agents).values({
      serverId: server.id,
      name: `push-agent-${index}`,
      status: "active",
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner!.id,
    }).returning();
    rows.push(agent!);
  }
  const orchestrator = new RouteOrchestrator();
  orchestrator.bind(
    machine!.id,
    server.id,
    options.capable
      ? [
          DAEMON_CAPABILITY_AGENT_CONFIG_PUSH,
          DAEMON_CAPABILITY_CONSTRUCTED_INIT_V1,
          ...(options.interruptCapable ? [DAEMON_CAPABILITY_AGENT_CONFIG_INTERRUPT] : []),
        ]
      : [],
  );
  app.app.set("agentOrchestrator", orchestrator);
  const token = await tokenForHuman(owner!.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  return { owner: owner!, server, agent: rows[0]!, agents: rows, orchestrator, headers };
}

async function revisionOf(agentId: string): Promise<number> {
  return (await getDb().select({ revision: agents.configRevision }).from(agents).where(eq(agents.id, agentId)))[0]!.revision;
}

test("PATCH without restartMode, interrupt-capable daemon: idle -> applied, busy -> pushed + immediate restart; description pushes without reset", async ({ app }) => {
  const { agent, orchestrator, headers } = await seed(app, { capable: true, interruptCapable: true });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ model: "opus" }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json() as { configApply: string }).configApply, "applied");
    assert.equal(await revisionOf(agent.id), 1);
    assert.equal(orchestrator.frames.length, 1);
    assert.equal(orchestrator.frames[0]!.revision, 1);
    assert.equal(orchestrator.frames[0]!.config.model, "opus");
    assert.equal(orchestrator.frames[0]!.interrupt, undefined, "idle push does not set interrupt");
    assert.deepEqual(orchestrator.resets, []);

    // #proj-runtime:#80: while running a foreground turn on a Computer with
    // `agent:config-interrupt-v1`, server pushes agent:config with interrupt: true
    // (so the daemon captures the interrupted-turn handoff note) and immediately restarts.
    (orchestrator as any).broadcastActivity(agent.id, "working", "Running tool", "tool_use");
    const haikuConfig = { version: RUNTIME_CONFIG_VERSION, runtime: "claude", model: { kind: "preset", id: "haiku" }, mode: { kind: "default" } };
    const whileBusy = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ model: "haiku", runtimeConfig: haikuConfig }) });
    assert.equal(whileBusy.status, 200, await whileBusy.clone().text());
    assert.equal((await whileBusy.json() as { configApply: string }).configApply, "restarted");
    assert.equal(await revisionOf(agent.id), 2);
    assert.equal(orchestrator.frames.length, 2);
    assert.equal(orchestrator.frames[1]!.config.model, "haiku");
    assert.equal(orchestrator.frames[1]!.interrupt, true, "busy push sets interrupt: true");
    assert.deepEqual(orchestrator.resets, [{
      agentId: agent.id,
      mode: "session",
      options: { restartIfStopped: false, restartEvenIfInactive: true, terminalControl: "runtime_config_changed" },
    }]);

    // #proj-runtime:#80: a BYOC description edit bumps configRevision and pushes agent:config for standing-prompt refresh without interrupting even while busy.
    const described = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ description: "notes" }) });
    assert.equal((await described.json() as { configApply: string }).configApply, "applied");
    assert.equal(await revisionOf(agent.id), 3);
    assert.equal(orchestrator.frames.length, 3);
    assert.equal(orchestrator.frames[2]!.config.description, "notes");
    assert.equal(orchestrator.frames[2]!.interrupt, undefined, "description edit never interrupts");
    assert.equal(orchestrator.resets.length, 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("PATCH without restartMode, push-capable daemon WITHOUT agent:config-interrupt-v1: busy does not resetAgent and returns when_idle (#proj-runtime:#80)", async ({ app }) => {
  const { agent, orchestrator, headers } = await seed(app, { capable: true, interruptCapable: false });
  try {
    (orchestrator as any).broadcastActivity(agent.id, "working", "Running tool", "tool_use");
    const haikuConfig = { version: RUNTIME_CONFIG_VERSION, runtime: "claude", model: { kind: "preset", id: "haiku" }, mode: { kind: "default" } };
    const whileBusy = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ model: "haiku", runtimeConfig: haikuConfig }) });
    assert.equal(whileBusy.status, 200, await whileBusy.clone().text());
    assert.equal((await whileBusy.json() as { configApply: string }).configApply, "when_idle");
    assert.equal(orchestrator.frames.length, 1);
    assert.equal(orchestrator.frames[0]!.interrupt, undefined, "no interrupt flag without capability");
    assert.deepEqual(orchestrator.resets, [], "older Computer without agent:config-interrupt-v1 is not reset mid-turn");
  } finally {
    await orchestrator.shutdown();
  }
});

test("PATCH without restartMode, old daemon without push: idle restarts immediately; busy waits until observed idle (#proj-runtime:#80)", async ({ app }) => {
  const { agent, orchestrator, headers } = await seed(app, { capable: false });
  try {
    // Idle agent: server triggers fallback restart right away.
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ model: "opus" }) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { configApply: string; configApplyNewSession?: boolean };
    assert.equal(body.configApply, "restarted");
    assert.equal(body.configApplyNewSession, false, "old daemon without constructed-init:v1 keeps session on non-Codex model switch");
    assert.equal(await revisionOf(agent.id), 1, "the revision moves with the change whatever the daemon");
    assert.deepEqual(orchestrator.frames, []);
    assert.deepEqual(orchestrator.resets, [{
      agentId: agent.id,
      mode: "restart",
      options: { restartIfStopped: false, restartEvenIfInactive: false, terminalControl: "runtime_config_changed" },
    }]);

    // Busy agent (foreground turn running): does NOT kill mid-turn on older Computer; returns when_idle and restarts once online arrives.
    (orchestrator as any).broadcastActivity(agent.id, "working", "Thinking", "other");
    const haikuConfig = { version: RUNTIME_CONFIG_VERSION, runtime: "claude", model: { kind: "preset", id: "haiku" }, mode: { kind: "default" } };
    const busyRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ model: "haiku", runtimeConfig: haikuConfig }) });
    assert.equal(busyRes.status, 200, await busyRes.clone().text());
    const busyBody = await busyRes.json() as { configApply: string; configApplyNewSession?: boolean };
    assert.equal(busyBody.configApply, "when_idle");
    assert.equal(busyBody.configApplyNewSession, false);
    assert.equal(orchestrator.resets.length, 1, "did not interrupt the running foreground turn");

    // Foreground turn ends -> online activity triggers the queued fallback restart once.
    (orchestrator as any).broadcastActivity(agent.id, "online", "", "none");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(orchestrator.resets.length, 2, "queued fallback fired when agent went idle");
    assert.deepEqual(orchestrator.resets[1], {
      agentId: agent.id,
      mode: "restart",
      options: { restartIfStopped: false, restartEvenIfInactive: false, terminalControl: "runtime_config_changed" },
    });
  } finally {
    await orchestrator.shutdown();
  }
});

test("PATCH with restartMode resets as before, also on a capable daemon", async ({ app }) => {
  const { agent, orchestrator, headers } = await seed(app, { capable: true });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ model: "opus", restartMode: "restart" }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json() as { configApply: string }).configApply, "restarted");
    assert.deepEqual(orchestrator.frames, []);
    assert.deepEqual(orchestrator.resets, [{
      agentId: agent.id,
      mode: "session",
      options: { restartIfStopped: false, terminalControl: "runtime_config_changed" },
    }]);
  } finally {
    await orchestrator.shutdown();
  }
});

async function mcpApp(serverId: string, userId: string) {
  const created = await createManagedMcpServer({ serverId, userId, name: `Docs ${randomUUID().slice(0, 6)}`, endpointUrl: "https://example.com/mcp" });
  await getDb().update(managedMcpServers).set({ toolCatalog: [
    { name: "read", inputSchema: { type: "object" } },
    { name: "write", inputSchema: { type: "object" } },
  ] }).where(eq(managedMcpServers.id, created.id));
  return created;
}

for (const capable of [true, false]) {
  test(`managed MCP, ${capable ? "capable" : "old"} daemon: both bulk and single ${capable ? "push" : "use idle-safe fallback restart"}`, async ({ app }) => {
    const originalKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
    process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
    const { owner, server, agent, orchestrator, headers } = await seed(app, { capable });
    try {
      const created = await mcpApp(server.id, owner.id);
      const bulk = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ assignments: [{ mcpServerId: created.id, enabled: true, allowedTools: null }] }),
      });
      assert.equal(bulk.status, 200, await bulk.clone().text());
      assert.equal(await revisionOf(agent.id), 1);
      assert.deepEqual(orchestrator.frames.map((frame) => frame.revision), capable ? [1] : []);
      assert.deepEqual(orchestrator.resets, capable ? [] : [{ agentId: agent.id, mode: "restart", options: { restartIfStopped: false, restartEvenIfInactive: false } }]);

      const single = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ allowedTools: ["read"] }),
      });
      assert.equal(single.status, 200, await single.clone().text());
      assert.equal(await revisionOf(agent.id), 2);
      assert.deepEqual(orchestrator.frames.map((frame) => frame.revision), capable ? [1, 2] : []);
      if (capable) assert.notEqual(orchestrator.frames[1]!.config.managedMcpFingerprint, orchestrator.frames[0]!.config.managedMcpFingerprint);
      assert.equal(orchestrator.resets.length, capable ? 0 : 2, "both bulk and single fallback-restart idle agents on old daemons");
    } finally {
      await orchestrator.shutdown();
      if (originalKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
      else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalKey;
    }
  });
}

test("managed MCP narrowing waits for idle safely: the running agent's next call is refused (enabled=false, allowedTools)", async ({ app }) => {
  const originalKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  const { owner, server, agent, orchestrator, headers } = await seed(app, { capable: true });
  try {
    const created = await mcpApp(server.id, owner.id);
    const put = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments/${created.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal((await put({ enabled: true, allowedTools: null })).status, 200);
    // The versions the running agent's launch saw; it is not restarted below.
    const call = (toolName: string) => executeManagedMcpCall(server.id, agent.id, {
      mcpServerId: created.id, toolName, arguments: {}, expectedConfigVersion: created.configVersion, expectedAssignmentVersion: 1,
    }, async () => ({ content: [], isError: false }));
    await call("write");

    assert.equal((await put({ allowedTools: ["read"] })).status, 200);
    await assert.rejects(call("write"), { code: "managed_mcp_tool_not_allowed" });
    await call("read");

    assert.equal((await put({ enabled: false })).status, 200);
    await assert.rejects(call("read"), { code: "managed_mcp_app_off" });
    assert.deepEqual(orchestrator.resets, [], "narrowing never interrupted the agent");
  } finally {
    await orchestrator.shutdown();
    if (originalKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
    else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalKey;
  }
});
