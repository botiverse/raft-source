/**
 * Agent typing line ingress: `agent:send_intent` through the orchestrator's
 * machine message switch. Real DB rows and the real
 * read-only target resolution; only the socket emit is captured.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { AGENT_TYPING_SOCKET_EVENT, AGENT_TYPING_TTL_MS, type MachineToServerMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, messages, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { handleReplicaMessage, REPLICA_ID, setAgentTypingPostedHandler } from "../replicaRouter";
import { addAgent, createChannel, getOrCreateThreadForChannel } from "./channelService";

afterEach(async () => {
  await closeTestDatabase();
});

class CapturingOrchestrator extends AgentOrchestrator {
  readonly emits: Array<{ room: string; event: string; payload: any }> = [];

  protected override emitAgentTyping(room: string, event: string, payload: unknown): void {
    this.emits.push({ room, event, payload });
  }
}

async function seed(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: `${slug}-owner`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Typing", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine, otherMachine] = await db.insert(machines).values([
    { serverId: server!.id, userId: owner!.id, name: "typing-mac", apiKeyHash: `hash-${slug}` },
    { serverId: server!.id, userId: owner!.id, name: "other-mac", apiKeyHash: `hash-${slug}-other` },
  ]).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "Niko",
    status: "active",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  const general = await createChannel(server!.id, "general");
  await addAgent(general.id, agent!.id);
  await createChannel(server!.id, "secret", undefined, "private");
  return { server: server!, machine: machine!, otherMachine: otherMachine!, agent: agent!, general };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string): void {
  (orchestrator as any).machineConnections.set(machineId, {
    ws: {},
    machineId,
    serverId,
    principalKind: "computer",
    connectionEpochId: `epoch-${machineId}`,
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.40",
    capabilities: new Set<string>(),
    runtimes: ["claude"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.40",
  });
}

function intent(agentId: string, fields: Record<string, unknown>): MachineToServerMessage {
  return { type: "agent:send_intent", agentId, callId: "call-1", phase: "start", target: "#general", ...fields } as MachineToServerMessage;
}

async function withOrchestrator(slug: string, run: (ctx: Awaited<ReturnType<typeof seed>> & { orchestrator: CapturingOrchestrator }) => Promise<void>) {
  const ctx = await seed(slug);
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, ctx.machine.id, ctx.server.id);
    bindMachine(orchestrator, ctx.otherMachine.id, ctx.server.id);
    await run({ ...ctx, orchestrator });
  } finally {
    await orchestrator.shutdown();
  }
}

test("agent typing: start, refresh and end emit to the channel room only, with no agent_typing flag row", async ({ db: _db }) => {
  await withOrchestrator("typing-on", async ({ orchestrator, machine, agent, server, general }) => {
    const before = Date.now();
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { early: true }));
    assert.equal(orchestrator.emits.length, 1);
    const [first] = orchestrator.emits;
    assert.equal(first!.room, `channel:${general.id}`);
    assert.equal(first!.event, AGENT_TYPING_SOCKET_EVENT);
    assert.deepEqual({ ...first!.payload, expiresAt: undefined }, {
      agentId: agent.id,
      serverId: server.id,
      channelId: general.id,
      parentMessageId: null,
      callId: "call-1",
      state: "start",
      expiresAt: undefined,
    });
    assert.ok(first!.payload.expiresAt >= before + AGENT_TYPING_TTL_MS);

    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, {}));
    assert.equal(orchestrator.emits.length, 2);
    assert.equal(orchestrator.emits[1]!.payload.state, "start");

    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { phase: "end", target: undefined }));
    assert.equal(orchestrator.emits.length, 3);
    assert.equal(orchestrator.emits[2]!.payload.state, "end");
    assert.equal(orchestrator.emits[2]!.room, `channel:${general.id}`);

    for (const emit of orchestrator.emits) assert.ok(!emit.room.startsWith("server:"));
  });
});

test("agent typing: invalid frames, foreign machines and unpostable targets are dropped", async ({ db: _db }) => {
  await withOrchestrator("typing-drop", async ({ orchestrator, machine, otherMachine, agent }) => {
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { phase: "typing" }));
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { callId: "" }));
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { target: "x".repeat(1_000) }));
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { target: undefined }));
    // The agent belongs to `machine`, not `otherMachine`.
    await orchestrator.handleMachineMessage(otherMachine.id, intent(agent.id, {}));
    // Not a member of #secret; no DM with nobody exists (and none is created).
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { callId: "c2", target: "#secret" }));
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { callId: "c3", target: "dm:@nobody" }));
    assert.deepEqual(orchestrator.emits, []);
  });
});

test("agent typing: the machine disconnecting ends the agent's line", async ({ db: _db }) => {
  await withOrchestrator("typing-disc", async ({ orchestrator, machine, agent, general }) => {
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, {}));
    assert.equal(orchestrator.emits.length, 1);
    await orchestrator.handleMachineDisconnect(machine.id);
    const last = orchestrator.emits.at(-1)!;
    assert.equal(last.room, `channel:${general.id}`);
    assert.equal(last.payload.state, "end");
  });
});

test("agent typing: the agent's message landing ends its line and the refreshes that follow are ignored", async ({ db: _db }) => {
  await withOrchestrator("typing-posted", async ({ orchestrator, machine, agent, server, general }) => {
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, {}));
    assert.equal(orchestrator.emits.length, 1);

    // The send route, after the message committed (`send … && raft task update …` still running).
    await orchestrator.endAgentTypingForPostedMessage({ agentId: agent.id, serverId: server.id, channelId: general.id, channelType: "channel", target: "#general" });
    assert.equal(orchestrator.emits.length, 2);
    assert.equal(orchestrator.emits[1]!.room, `channel:${general.id}`);
    assert.equal(orchestrator.emits[1]!.payload.state, "end");
    assert.equal(orchestrator.emits[1]!.payload.callId, "call-1");

    // The daemon's next refresh for the same call reopens nothing.
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, {}));
    assert.equal(orchestrator.emits.length, 2);
  });
});

test("agent typing: a thread reply ends the line matched by the thread's root message", async ({ db: _db }) => {
  await withOrchestrator("typing-posted-thread", async ({ orchestrator, machine, agent, server, general }) => {
    const [root] = await getDb().insert(messages).values({ channelId: general.id, senderType: "agent", senderId: agent.id, content: "root" }).returning();
    const target = `#general:${root!.id.slice(0, 8)}`;
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { callId: "thread-call", target }));
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { callId: "channel-call" }));
    assert.equal(orchestrator.emits.length, 2);
    assert.equal(orchestrator.emits[0]!.payload.parentMessageId, root!.id);

    const thread = await getOrCreateThreadForChannel(general.id, root!.id, agent.id, "agent");
    await orchestrator.endAgentTypingForPostedMessage({ agentId: agent.id, serverId: server.id, channelId: thread.id, channelType: "thread", target });
    assert.equal(orchestrator.emits.length, 3);
    assert.equal(orchestrator.emits[2]!.payload.callId, "thread-call");
    assert.equal(orchestrator.emits[2]!.payload.state, "end");

    // The channel-level line is another conversation: it stays, and refreshes.
    await orchestrator.handleMachineMessage(machine.id, intent(agent.id, { callId: "channel-call" }));
    assert.equal(orchestrator.emits.length, 4);
    assert.equal(orchestrator.emits[3]!.payload.callId, "channel-call");
    assert.equal(orchestrator.emits[3]!.payload.state, "start");
  });
});

test("agent typing: a send served by another replica ends the line on the socket-owning replica", async ({ db: _db }) => {
  await withOrchestrator("typing-posted-remote", async ({ orchestrator, machine, agent, general }) => {
    setAgentTypingPostedHandler((signal) => orchestrator.handleRoutedAgentTypingPosted(signal));
    try {
      await orchestrator.handleMachineMessage(machine.id, intent(agent.id, {}));
      assert.equal(orchestrator.emits.length, 1);
      const signal = { agentId: agent.id, channelId: general.id, parentMessageId: null, target: "#general" };
      // Self-published: the sending replica already ended its own lines.
      handleReplicaMessage("slock:replica:agent-typing-posted", JSON.stringify({ ...signal, from: REPLICA_ID }));
      handleReplicaMessage("slock:replica:agent-typing-posted", "not json");
      handleReplicaMessage("slock:replica:agent-typing-posted", JSON.stringify({ agentId: agent.id, from: "other-replica" }));
      assert.equal(orchestrator.emits.length, 1);
      handleReplicaMessage("slock:replica:agent-typing-posted", JSON.stringify({ ...signal, from: "other-replica" }));
      assert.equal(orchestrator.emits.length, 2);
      assert.equal(orchestrator.emits[1]!.payload.state, "end");
      await orchestrator.handleMachineMessage(machine.id, intent(agent.id, {}));
      assert.equal(orchestrator.emits.length, 2);
    } finally {
      setAgentTypingPostedHandler(null);
    }
  });
});
