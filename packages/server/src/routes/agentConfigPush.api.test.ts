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
import { DAEMON_CAPABILITY_AGENT_CONFIG_PUSH, PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, type AgentConfig } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentProviderConnections, agents, featureFlagRules, machines, managedMcpServers, users } from "../db/schema";
import { AgentOrchestrator, type ResetAgentOptions } from "../services/agentOrchestrator";
import { createServer } from "../services/serverService";
import { createManagedMcpServer, executeManagedMcpCall } from "../services/managedMcpService";
import { createProviderConnection } from "../services/providerConnectionService";

const test = createApiTest();

type ConfigFrame = { type: "agent:config"; agentId: string; config: AgentConfig; revision: number };

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

async function seed(app: { app: { set: (key: string, value: unknown) => void } }, options: { capable: boolean; agents?: number }) {
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
  orchestrator.bind(machine!.id, server.id, options.capable ? [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH] : []);
  app.app.set("agentOrchestrator", orchestrator);
  const token = await tokenForHuman(owner!.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  return { owner: owner!, server, agent: rows[0]!, agents: rows, orchestrator, headers };
}

async function revisionOf(agentId: string): Promise<number> {
  return (await getDb().select({ revision: agents.configRevision }).from(agents).where(eq(agents.id, agentId)))[0]!.revision;
}

test("PATCH without restartMode, capable daemon: agent:config with revision n+1, no reset, configApply when_idle", async ({ app }) => {
  const { agent, orchestrator, headers } = await seed(app, { capable: true });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ model: "opus" }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json() as { configApply: string }).configApply, "when_idle");
    assert.equal(await revisionOf(agent.id), 1);
    assert.equal(orchestrator.frames.length, 1);
    assert.equal(orchestrator.frames[0]!.revision, 1);
    assert.equal(orchestrator.frames[0]!.config.model, "opus");
    assert.deepEqual(orchestrator.resets, []);

    // A description edit changes no runtime value: no revision, no push.
    const described = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ description: "notes" }) });
    assert.equal((await described.json() as { configApply: string }).configApply, "saved");
    assert.equal(await revisionOf(agent.id), 1);
    assert.equal(orchestrator.frames.length, 1);
  } finally {
    await orchestrator.shutdown();
  }
});

test("PATCH without restartMode, old daemon: no frame, no reset, configApply saved", async ({ app }) => {
  const { agent, orchestrator, headers } = await seed(app, { capable: false });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify({ model: "opus" }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json() as { configApply: string }).configApply, "saved");
    assert.equal(await revisionOf(agent.id), 1, "the revision moves with the change whatever the daemon");
    assert.deepEqual(orchestrator.frames, []);
    assert.deepEqual(orchestrator.resets, []);
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
      mode: "restart",
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
  test(`managed MCP, ${capable ? "capable" : "old"} daemon: bulk ${capable ? "pushes" : "resets"}, single ${capable ? "pushes" : "sends nothing"}`, async ({ app }) => {
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
      assert.deepEqual(orchestrator.resets, capable ? [] : [{ agentId: agent.id, mode: "restart", options: { restartIfStopped: false } }]);

      const single = await fetch(`${app.baseUrl}/api/mcp/agents/${agent.id}/assignments/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ allowedTools: ["read"] }),
      });
      assert.equal(single.status, 200, await single.clone().text());
      assert.equal(await revisionOf(agent.id), 2);
      assert.deepEqual(orchestrator.frames.map((frame) => frame.revision), capable ? [1, 2] : []);
      if (capable) assert.notEqual(orchestrator.frames[1]!.config.managedMcpFingerprint, orchestrator.frames[0]!.config.managedMcpFingerprint);
      assert.equal(orchestrator.resets.length, capable ? 0 : 1, "the single route never resets");
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

for (const capable of [true, false]) {
  test(`provider connection key edit, ${capable ? "capable" : "old"} daemon: ${capable ? "pushes to each assigned running agent" : "pushes nothing"}`, async ({ app }) => {
    const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
    const { owner, server, agents: rows, orchestrator, headers } = await seed(app, { capable, agents: 3 });
    try {
      await getDb().insert(featureFlagRules).values({
        id: randomUUID(),
        flagKey: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
        stage: "server",
        priority: -100,
        decision: "allow",
        values: [server.id],
      });
      const connection = await createProviderConnection({ serverId: server.id, userId: owner.id, name: "Team", providerId: "deepseek", apiKey: "old-key" });
      // Two agents launch through the connection; the third does not, and one of the two is not running.
      for (const agent of rows.slice(0, 2)) {
        await getDb().insert(agentProviderConnections).values({
          serverId: server.id,
          agentId: agent.id,
          connectionId: connection.id,
          expectedConfigVersion: 1,
          expectedCredentialVersion: 1,
        });
      }
      await getDb().update(agents).set({ status: "inactive" }).where(eq(agents.id, rows[1]!.id));

      const res = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ apiKey: "new-key" }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(await Promise.all(rows.map((agent) => revisionOf(agent.id))), [1, 1, 0]);
      assert.deepEqual(orchestrator.frames.map((frame) => [frame.agentId, frame.revision]), capable ? [[rows[0]!.id, 1]] : []);
      if (capable) {
        assert.match(String(orchestrator.frames[0]!.config.providerConnectionRevision), new RegExp(`^${connection.id}:\\d+:2$`));
        assert.equal(JSON.stringify(orchestrator.frames[0]).includes("new-key"), false, "the key never rides the config");
      }
      assert.deepEqual(orchestrator.resets, []);
    } finally {
      await orchestrator.shutdown();
      if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
      else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
    }
  });
}
