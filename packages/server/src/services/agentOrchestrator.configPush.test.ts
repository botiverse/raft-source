/**
 * Reconciler step 11b: the server pushes an agent's config to the daemon that
 * runs it (`agent:config`), with the database revision. Real DB rows; only the
 * machine socket and, for owner routing, the replica transport are stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES, DAEMON_CAPABILITY_AGENT_CONFIG_PUSH, MAX_AGENT_MIGRATION_TRANSPORT_BYTES, type AgentConfig, type ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agentRuntimeProfiles, agents, machines, managedMcpAssignments, managedMcpServers, serverMembers, servers, users } from "../db/schema";
import { startIntentReply, type StartIntentRequest, type StartIntentResult } from "../replicaRouter";
import { AgentOrchestrator } from "./agentOrchestrator";
import { agentManagedMcpFingerprint, bumpAgentConfigRevision } from "./agentConfigRevision";

afterEach(async () => {
  await closeTestDatabase();
});

type ConfigFrame = Extract<ServerToMachineMessage, { type: "agent:config" }>;
type StartFrame = Extract<ServerToMachineMessage, { type: "agent:start" }>;

class CapturingOrchestrator extends AgentOrchestrator {
  readonly starts: StartFrame[] = [];
  readonly frames: ConfigFrame[] = [];

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }

  build(agent: NonNullable<Awaited<ReturnType<AgentOrchestrator["loadAgentForStart"]>>>): Promise<AgentConfig> {
    return this.buildAgentConfig(agent);
  }

  load(agentId: string) {
    return this.loadAgentForStart(agentId);
  }
}

async function seed(options: { status?: "active" | "inactive" | "stopped" } = {}) {
  const db = getDb();
  const slug = `cfg-${randomUUID().slice(0, 8)}`;
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: `Config ${slug}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Config", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "cfg-mac",
    apiKeyHash: `hash-${slug}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "cfg-agent",
    description: "pushes",
    status: options.status ?? "active",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    envVars: { SECRET_TOKEN: "env-secret-value" },
    sessionId: "session-1",
    machineId: machine!.id,
  }).returning();
  return { owner: owner!, server: server!, machine: machine!, agent: agent! };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string, capabilities: string[]): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  (orchestrator as any).machineConnections.set(machineId, {
    ws: { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) },
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
  return sent;
}

test("buildAgentConfig: the start sends the config it builds, unchanged from before the extraction, with the revision", async ({ db: _db }) => {
  const { server, machine, agent } = await seed({ status: "inactive" });
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    const start = orchestrator.starts[0]!;
    assert.equal(start.configRevision, 2, "the start carries the database revision");
    const row = (await orchestrator.load(agent.id))!;
    assert.deepEqual(start.config, await orchestrator.build(row), "the start sends buildAgentConfig's config");
    // The config the start sent before the extraction, plus the two step 11 fields.
    assert.deepEqual(start.config, {
      name: "cfg-agent",
      displayName: null,
      description: "pushes",
      model: "sonnet",
      runtime: "claude",
      runtimeConfig: start.config.runtimeConfig,
      reasoningEffort: null,
      executionMode: "byoc",
      envVars: { SECRET_TOKEN: "env-secret-value" },
      sessionId: "session-1",
      serverUrl: process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3001}`,
      authToken: "",
      constructedWakeContext: true,
      runtimeContext: {
        agentId: agent.id,
        serverId: server.id,
        machineId: machine.id,
        machineName: "cfg-mac",
        machineDescription: null,
        machineHostname: null,
        machineOs: null,
        daemonVersion: "1.0.99",
        workspacePath: null,
      },
      enabledApps: [],
      // No migration yet: only the limits.
      migrationReadiness: {
        limits: { maxBytes: MAX_AGENT_MIGRATION_TRANSPORT_BYTES, maxEntries: AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES },
      },
      managedMcpFingerprint: await agentManagedMcpFingerprint(server.id, agent.id),
    });
    assert.equal((start.config.runtimeConfig as { runtime?: string }).runtime, "claude");
  } finally {
    await orchestrator.shutdown();
  }
});

test("managed MCP fingerprint moves with an enabled assignment's tools and on/off", async ({ db: _db }) => {
  const { owner, server, agent } = await seed();
  const [app] = await getDb().insert(managedMcpServers).values({
    serverId: server.id,
    name: "Docs",
    endpointUrl: "https://example.com/mcp",
    createdByUserId: owner.id,
  }).returning();
  const empty = await agentManagedMcpFingerprint(server.id, agent.id);
  await getDb().insert(managedMcpAssignments).values({ serverId: server.id, agentId: agent.id, mcpServerId: app!.id, allowedTools: ["read", "write"] });
  const granted = await agentManagedMcpFingerprint(server.id, agent.id);
  assert.notEqual(granted, empty);
  await getDb().update(managedMcpAssignments).set({ allowedTools: ["read"] }).where(eq(managedMcpAssignments.agentId, agent.id));
  const narrowed = await agentManagedMcpFingerprint(server.id, agent.id);
  assert.notEqual(narrowed, granted);
  await getDb().update(managedMcpAssignments).set({ enabled: false }).where(eq(managedMcpAssignments.agentId, agent.id));
  assert.equal(await agentManagedMcpFingerprint(server.id, agent.id), empty, "a switched-off App is no longer configured");
});

test("applyAgentConfig: a capable daemon running the agent gets agent:config with the database revision", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  const orchestrator = new CapturingOrchestrator();
  try {
    const sent = bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    assert.equal(await orchestrator.applyAgentConfig(agent.id), "pushed");
    assert.equal(sent.length, 1);
    const frame = sent[0] as unknown as ConfigFrame;
    assert.equal(frame.type, "agent:config");
    assert.equal(frame.agentId, agent.id);
    assert.equal(frame.revision, 1);
    assert.deepEqual(frame.config, await orchestrator.build((await orchestrator.load(agent.id))!));
    assert.equal(orchestrator.starts.length, 0, "a push never starts the agent");
  } finally {
    await orchestrator.shutdown();
  }
});

test("applyAgentConfig: an old daemon, an agent that does not run, or a machine on no socket here gets nothing", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  try {
    // Not connected to this replica.
    assert.equal(await orchestrator.applyAgentConfig(agent.id), "not_pushed");
    // Connected, but the daemon predates the capability.
    const sent = bindMachine(orchestrator, machine.id, server.id, []);
    assert.equal(await orchestrator.applyAgentConfig(agent.id), "not_pushed");
    assert.equal(sent.length, 0);
    // Capable, but the agent does not run there.
    const capable = bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    await getDb().update(agents).set({ status: "inactive" }).where(eq(agents.id, agent.id));
    assert.equal(await orchestrator.applyAgentConfig(agent.id), "not_pushed");
    assert.equal(capable.length, 0);
  } finally {
    await orchestrator.shutdown();
  }
});

test("config revision: increments in the caller's transaction, rolls back with it, and strictly increases under concurrency", async ({ db: _db }) => {
  const { agent } = await seed();
  await assert.rejects(getDb().transaction(async (tx) => {
    await bumpAgentConfigRevision(tx, [agent.id]);
    throw new Error("rollback");
  }), /rollback/);
  const read = async () => (await getDb().select({ revision: agents.configRevision }).from(agents).where(eq(agents.id, agent.id)))[0]!.revision;
  assert.equal(await read(), 0, "a rolled-back change leaves the revision");
  const revisions = await Promise.all(Array.from({ length: 5 }, () => getDb().transaction(async (tx) => (
    (await bumpAgentConfigRevision(tx, [agent.id])).get(agent.id)!
  ))));
  assert.deepEqual([...revisions].sort((a, b) => a - b), [1, 2, 3, 4, 5], "every change got its own revision");
  assert.equal(await read(), 5);
});

/** A replica that does not hold the machine's socket; the owner is reached through `routeIntentToOwner`. */
class RequesterOrchestrator extends CapturingOrchestrator {
  readonly routed: string[] = [];
  constructor(private readonly owner: (request: StartIntentRequest) => Promise<StartIntentResult | undefined>) {
    super();
    (this as any).replicaStateStore = new Proxy({}, {
      get: (_target, key) => {
        if (key === "isAvailable") return () => true;
        if (key === "getMachineReplicaOwner") return async () => "replica-owner";
        return async () => null;
      },
    });
  }
  protected override async ownerAcceptsIntents(): Promise<boolean> {
    return true;
  }
  protected override async routeIntentToOwner(_ownerReplicaId: string, request: StartIntentRequest): Promise<StartIntentResult> {
    // What crosses Redis: the request as JSON, and the owner's reply as JSON.
    const wire = JSON.stringify(request);
    this.routed.push(wire);
    const reply = JSON.parse(JSON.stringify({ result: await this.owner(JSON.parse(wire)) })) as { result?: StartIntentResult };
    const settled = startIntentReply(reply.result, undefined);
    if (settled instanceof Error) throw settled;
    return settled;
  }
}

test("owner routing: the owning replica builds and sends the config; only the intent's kind crosses replicas", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  const owner = new CapturingOrchestrator();
  const requester = new RequesterOrchestrator((request) => owner.handleStartIntent(request));
  try {
    const sent = bindMachine(owner, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    assert.equal(await requester.applyAgentConfig(agent.id), "pushed");
    assert.equal(requester.routed.length, 1);
    const request = JSON.parse(requester.routed[0]!) as StartIntentRequest;
    assert.deepEqual(request.intent, { kind: "config" });
    assert.deepEqual(Object.keys(request).sort(), ["agentId", "intent", "machineId", "requestId"]);
    assert.equal(requester.routed[0]!.includes("env-secret-value"), false, "no config in the cross-replica payload");
    assert.equal(sent.length, 1, "the owner sent the frame on its own socket");
    assert.equal((sent[0] as unknown as ConfigFrame).revision, 1);
    assert.equal((sent[0] as unknown as ConfigFrame).config.envVars?.SECRET_TOKEN, "env-secret-value");
  } finally {
    await owner.shutdown();
    await requester.shutdown();
  }
});

test("owner routing: an owner on an older build answers nothing for the config kind, so nothing is pushed", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const owner = new CapturingOrchestrator();
  // An older owner: its switch has no `config` case and falls through.
  const requester = new RequesterOrchestrator(async (request) => (
    request.intent.kind === "config" ? undefined : owner.handleStartIntent(request)
  ));
  try {
    const sent = bindMachine(owner, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    assert.equal(await requester.applyAgentConfig(agent.id), "not_pushed");
    assert.equal(sent.length, 0);
  } finally {
    await owner.shutdown();
    await requester.shutdown();
  }
});

test("runtime-profile report: a new running model is broadcast as agent:updated and not throttled", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  const orchestrator = new CapturingOrchestrator();
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO({ to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }) } as never);
  const report = (model: string) => orchestrator.handleMachineMessage(machine.id, {
    type: "agent:runtime_profile",
    agentId: agent.id,
    facts: { runtime: "claude", model, executionMode: "byoc" },
  } as never);
  const updates = () => emitted.filter((entry) => entry.event === "agent:updated");
  try {
    bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    await report("sonnet");
    assert.deepEqual(updates(), [], "the first report records a baseline, nothing changed");
    // Within the 5 s write throttle: the same model is skipped, a new one is written and broadcast.
    await report("sonnet");
    assert.deepEqual(updates(), []);
    await report("opus");
    assert.deepEqual(updates().map((entry) => entry.payload), [{ agentId: agent.id }]);
    const [profile] = await getDb().select({ model: agentRuntimeProfiles.model }).from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, agent.id));
    assert.equal(profile!.model, "opus", "the change was written despite the throttle");
  } finally {
    await orchestrator.shutdown();
  }
});

// Reconciler step 11d: a `ready` reports each running agent's applied config
// revision; the server re-sends the config when its own is newer (the push
// was lost), once per revision per connection.
// RED proof: drop the `resendLostAgentConfigs` call from the ready handler and
// the lost push is never re-sent; drop the per-connection claim and the
// second ready re-sends it again; skip only an equal revision and a daemon
// ahead of the database is pushed an older config.
const readyFrame = (agentId: string, revisions: Record<string, number> | undefined, runningAgents = [agentId]) => ({
  type: "ready",
  capabilities: [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH],
  runtimes: ["claude"],
  runningAgents,
  daemonVersion: "1.0.99",
  ...(revisions ? { runningAgentConfigRevisions: revisions } : {}),
}) as never;
const configFrames = (sent: Array<Record<string, unknown>>) => sent.filter((frame) => frame.type === "agent:config") as unknown as ConfigFrame[];

test("ready: a push the daemon never applied is re-sent on the next connection, once per revision per connection", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  const orchestrator = new CapturingOrchestrator();
  try {
    // Revision 2's push was lost with the previous socket; the daemon reconnects at 1.
    const sent = bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 1 }));
    assert.deepEqual(configFrames(sent).map((frame) => [frame.agentId, frame.revision]), [[agent.id, 2]], "re-sent with the database revision");
    assert.deepEqual(configFrames(sent)[0]!.config, await orchestrator.build((await orchestrator.load(agent.id))!));

    // The same connection reports 1 again (a second ready; the daemon did not apply it): no loop.
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 1 }));
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 1 }));
    assert.equal(configFrames(sent).length, 1, "one re-send per revision per connection");

    // A newer revision on the same connection is re-sent once more.
    await bumpAgentConfigRevision(getDb(), [agent.id]);
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 1 }));
    assert.deepEqual(configFrames(sent).map((frame) => frame.revision), [2, 3]);

    // A new connection may re-send once more.
    const next = bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 2 }));
    assert.deepEqual(configFrames(next).map((frame) => frame.revision), [3]);
    assert.equal(orchestrator.starts.length, 0, "a re-send never starts the agent");
  } finally {
    await orchestrator.shutdown();
  }
});

test("ready: nothing is re-sent to a daemon already current or ahead, one that reports no revision, or for an agent it does not run", async ({ db: _db }) => {
  const { server, machine, agent } = await seed();
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  await bumpAgentConfigRevision(getDb(), [agent.id]);
  const orchestrator = new CapturingOrchestrator();
  try {
    const sent = bindMachine(orchestrator, machine.id, server.id, [DAEMON_CAPABILITY_AGENT_CONFIG_PUSH]);
    // Current.
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 2 }));
    // Ahead (e.g. a value the database has not caught up with): never pushed an older config.
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 3 }));
    // An older daemon (no field), or a malformed entry.
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, undefined));
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: "1" as unknown as number }));
    // Reported, but not in `runningAgents`.
    await orchestrator.handleMachineMessage(machine.id, readyFrame(agent.id, { [agent.id]: 1 }, []));
    assert.deepEqual(configFrames(sent), []);
  } finally {
    await orchestrator.shutdown();
  }
});
