import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index";
import { agentMigrations, agents, channelAgents } from "../db/schema";
import { eq } from "drizzle-orm";
import { createAgent, deleteAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, filterAgentsWithChannelAccess, getOrCreateThreadForChannel, recordThreadFollow } from "../services/channelService";
import { broadcastSystemMessage, createMessage, deliverMessagesToAgents } from "../services/messageService";
import { updateAgentScopes } from "../services/agentScopesService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import type { AgentMessage } from "@botiverse/raft-shared";
import { tokenForHuman } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";
import { createServer as createServerFixture, headers, seedUser } from "../routes/channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

async function countQueries<T>(run: () => Promise<T>, match: RegExp): Promise<{ result: T; total: number; matched: number }> {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  let total = 0;
  let matched = 0;
  pg.query = ((...args: unknown[]) => {
    total += 1;
    if (typeof args[0] === "string" && match.test(args[0])) matched += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    return { result: await run(), total, matched };
  } finally {
    pg.query = originalQuery;
  }
}

function payload(channel: { id: string; name: string; type: AgentMessage["channel_type"] }, seq: number): AgentMessage {
  return {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: channel.type,
    sender_id: randomUUID(),
    sender_name: "parity-sender",
    sender_type: "human",
    content: "parity",
    timestamp: new Date().toISOString(),
    seq,
    message_id: randomUUID(),
  };
}

test("deliverMessagesOnChannel decides every recipient exactly as deliverMessage does one by one", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const otherOwner = await seed.human();
  const otherServer = await seed.server({ owner: otherOwner });

  const privateRoom = await createChannel(server.id, `parity-private-${randomUUID().slice(0, 8)}`, undefined, "private");
  const publicRoom = await createChannel(server.id, `parity-public-${randomUUID().slice(0, 8)}`);
  await addHuman(privateRoom.id, owner.id);
  const root = await createMessage(privateRoom.id, "user", owner.id, "thread root");
  const thread = await getOrCreateThreadForChannel(privateRoom.id, root.id, owner.id, "user");

  const newAgent = async (label: string, serverId = server.id) =>
    createAgent(serverId, `parity-${label}-${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
  // One agent per decision the gates can reach.
  const member = await newAgent("member");
  await addAgent(privateRoom.id, member.id);
  const nonMember = await newAgent("nonmember");
  const deleted = await newAgent("deleted");
  await addAgent(privateRoom.id, deleted.id);
  await deleteAgent(deleted.id);
  const scopeRevoked = await newAgent("revoked");
  await addAgent(privateRoom.id, scopeRevoked.id);
  await updateAgentScopes({ agentId: scopeRevoked.id, scopes: ["read"], updatedByUserId: owner.id });
  const foreign = await newAgent("foreign", otherServer.id);
  // A stale membership row for another server's agent (addAgent refuses it).
  await getDb().insert(channelAgents).values({ channelId: privateRoom.id, agentId: foreign.id });
  const missingId = randomUUID();
  // One agent mid-migration (gated) and one whose migration deadline has
  // passed (no longer gated).
  const migrate = async (label: string, deadline: Date) => {
    const agent = await newAgent(label);
    await addAgent(privateRoom.id, agent.id);
    await getDb().insert(agentMigrations).values({
      contractVersion: 2,
      serverId: server.id,
      agentId: agent.id,
      sourceMachineId: randomUUID(),
      targetMachineId: randomUUID(),
      sourceMachineNameSnapshot: "source",
      targetMachineNameSnapshot: "target",
      state: "prep",
      grantKey: `parity-migration:${randomUUID()}`,
      prepDeadlineAt: deadline,
      transferDeadlineAt: deadline,
      arrivalDeadlineAt: deadline,
    });
    return agent;
  };
  const migrating = await migrate("migrating", new Date(Date.now() + 10 * 60_000));
  const migrationExpired = await migrate("expired", new Date(Date.now() - 60_000));
  const recipients = [member.id, nonMember.id, deleted.id, scopeRevoked.id, foreign.id, missingId, migrating.id, migrationExpired.id];

  const targets = [
    { id: privateRoom.id, name: privateRoom.name, type: "private" as const },
    { id: publicRoom.id, name: publicRoom.name, type: "channel" as const },
    { id: thread.id, name: thread.id, type: "thread" as const },
  ];
  for (const [index, target] of targets.entries()) {
    const message = payload(target, 100 + index);
    const decide = async (orchestrator: AgentOrchestrator, batch: boolean) => {
      const results = batch
        ? orchestrator.deliverMessagesOnChannel(target.id, recipients.map((agentId) => ({ agentId, message })))
        : recipients.map((agentId) => orchestrator.deliverMessage(agentId, message));
      return Promise.all(results.map(async (pending, index) => {
        const result = await pending;
        return { agentId: recipients[index]!, status: result.status, reason: "reason" in result ? result.reason : undefined };
      }));
    };
    const before = await decide(new AgentOrchestrator(), false);
    const after = await decide(new AgentOrchestrator(), true);
    assert.deepEqual(after, before, `${target.type}: the batch must decide each agent as the single path does`);

    const byId = new Map(before.map((decision) => [decision.agentId, decision]));
    // The fixture really reaches each gate, so parity is not vacuous.
    assert.equal(byId.get(deleted.id)?.reason, "agent_unavailable", target.type);
    assert.equal(byId.get(missingId)?.reason, "agent_unavailable", target.type);
    assert.equal(byId.get(scopeRevoked.id)?.reason, "passive_scope_revoked", target.type);
    assert.equal(byId.get(foreign.id)?.reason, "target_access_changed", target.type);
    assert.equal(byId.get(migrating.id)?.reason, "control_gate_inbox", target.type);
    assert.notEqual(byId.get(migrationExpired.id)?.reason, "control_gate_inbox", target.type);
    const gateReasons = new Set(["agent_unavailable", "passive_scope_revoked", "target_access_changed"]);
    assert.ok(!gateReasons.has(byId.get(member.id)?.reason ?? ""), `${target.type}: ${JSON.stringify(byId.get(member.id))}`);
    if (target.type === "channel") assert.ok(!gateReasons.has(byId.get(nonMember.id)?.reason ?? ""), target.type);
    else assert.equal(byId.get(nonMember.id)?.reason, "target_access_changed", target.type);
  }
});

test("deliverMessagesOnChannel reads agent rows, channel access, scopes and migration gates in a fixed number of queries", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const room = await createChannel(server.id, `batch-${randomUUID().slice(0, 8)}`, undefined, "private");
  const target = { id: room.id, name: room.name, type: "private" as const };
  const agentIds: string[] = [];
  const addAgents = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const agent = await createAgent(server.id, `batch-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
      await addAgent(room.id, agent.id);
      // Active: delivery stops at the inbox instead of trying to wake the agent,
      // so the queries left are the gates' plus a fixed per-agent remainder.
      await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
      agentIds.push(agent.id);
    }
  };
  // Agent row reads, channel-access reads (channel row, channel_agents), the
  // passive-delivery scope and the migration gate.
  const gateReads = /from "agents"|from "channel_agents"|from "channels"|from "agent_scopes"|from "agent_migrations"/;
  const run = async (batch: boolean) => {
    const orchestrator = new AgentOrchestrator();
    const message = payload(target, 1);
    return countQueries(() => Promise.all(batch
      ? orchestrator.deliverMessagesOnChannel(room.id, agentIds.map((agentId) => ({ agentId, message })))
      : agentIds.map((agentId) => orchestrator.deliverMessage(agentId, message))), gateReads);
  };

  await addAgents(2);
  await run(true);
  const few = await run(true);
  await addAgents(8);
  await run(true);
  const many = await run(true);
  const perAgent = await run(false);

  assert.ok(few.matched > 0, "the counter must observe gate reads");
  // One read per agent stays by design, outside the batched gates: the
  // still-active re-read right before the inbox enqueue. Everything else the
  // gates read (agent row, channel, membership, scope, migration) is a fixed
  // number of queries.
  const added = 8;
  assert.equal(many.matched - few.matched, added, `gate-table reads: ${few.matched} -> ${many.matched} for +${added} agents`);
  // One by one, every agent also reads its row, the channel twice, its
  // membership, its scope (plus the agent-exists fallback: no scope row) and
  // its migration.
  assert.ok(perAgent.matched - many.matched >= 7 * agentIds.length - 7, `one by one ${perAgent.matched} vs batch ${many.matched}`);
});

test("a thread message's delivery gates, with the server pin, stay a fixed number of queries in the recipient count", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const room = await createChannel(server.id, `batch-thread-${randomUUID().slice(0, 8)}`, undefined, "private");
  const root = await createMessage(room.id, "user", owner.id, "thread root");
  const thread = await getOrCreateThreadForChannel(room.id, root.id, owner.id, "user");
  const target = { id: thread.id, name: `thread-${root.id.slice(0, 8)}`, type: "thread" as AgentMessage["channel_type"] };
  const agentIds: string[] = [];
  const addAgents = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const agent = await createAgent(server.id, `batch-thread-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
      await addAgent(room.id, agent.id);
      await getDb().update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
      agentIds.push(agent.id);
    }
  };
  const gateReads = /from "agents"|from "channel_agents"|from "channels"|from "agent_scopes"|from "agent_migrations"|from "messages"/;
  const run = async () => {
    const orchestrator = new AgentOrchestrator();
    const message = payload(target as never, 1);
    return countQueries(() => Promise.all(orchestrator.deliverMessagesOnChannel(thread.id, agentIds.map((agentId) => ({ agentId, message })))), gateReads);
  };
  // The batched access check itself (thread -> parent recursion, server pin on agents): constant.
  const access = () => countQueries(() => filterAgentsWithChannelAccess(thread.id, agentIds), /./);

  await addAgents(2);
  await run();
  const few = await run();
  const fewAccess = await access();
  await addAgents(8);
  await run();
  const many = await run();
  const manyAccess = await access();

  assert.equal(fewAccess.result.size, 2);
  assert.equal(manyAccess.result.size, 10);
  assert.equal(manyAccess.total, fewAccess.total, `filterAgentsWithChannelAccess: ${fewAccess.total} -> ${manyAccess.total} queries`);
  assert.ok(few.matched > 0, "the counter must observe gate reads");
  // As for channels: only the still-active re-read before the inbox enqueue is per agent.
  assert.equal(many.matched - few.matched, 8, `gate-table reads: ${few.matched} -> ${many.matched} for +8 agents`);
});

test("a channel send reads its agents' gates in one deliverMessagesOnChannel batch and delivers each through deliverMessage", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const room = await seed.channel({ server, members: [owner] });
  const recipients: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const agent = await createAgent(server.id, `wired-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
    await addAgent(room.id, agent.id);
    recipients.push(agent.id);
  }
  const batches: Array<{ channelId: string; agentIds: string[] }> = [];
  const deliveries: Array<{ agentId: string; batchGates: boolean }> = [];
  class RecordingOrchestrator extends AgentOrchestrator {
    override deliverMessagesOnChannel(...args: Parameters<AgentOrchestrator["deliverMessagesOnChannel"]>) {
      batches.push({ channelId: args[0], agentIds: args[1].map((delivery) => delivery.agentId) });
      return super.deliverMessagesOnChannel(...args);
    }
    override async deliverMessage(...args: Parameters<AgentOrchestrator["deliverMessage"]>) {
      deliveries.push({ agentId: args[0], batchGates: Boolean(args[3]) });
      return super.deliverMessage(...args);
    }
  }
  app.app.set("agentOrchestrator", new RecordingOrchestrator());

  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ channelId: room.id, content: "wired" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(batches.map((batch) => ({ channelId: batch.channelId, agentIds: [...batch.agentIds].sort() })), [
    { channelId: room.id, agentIds: [...recipients].sort() },
  ]);
  // Every delivery still goes through deliverMessage (observers that wrap it
  // see all of them), each carrying the batch-read gates.
  assert.deepEqual(deliveries.map((delivery) => delivery.agentId).sort(), [...recipients].sort());
  assert.ok(deliveries.every((delivery) => delivery.batchGates), "each delivery uses the batch-read gates");
});

class GateRecordingOrchestrator extends AgentOrchestrator {
  readonly deliveries: Array<{ agentId: string; messageId?: string; channelId: string; batchGates: boolean }> = [];
  gateLoads = 0;
  override async loadDeliveryGates(...args: Parameters<AgentOrchestrator["loadDeliveryGates"]>) {
    this.gateLoads += 1;
    return super.loadDeliveryGates(...args);
  }
  override async deliverMessage(...args: Parameters<AgentOrchestrator["deliverMessage"]>) {
    this.deliveries.push({ agentId: args[0], messageId: args[1].message_id, channelId: args[1].channel_id, batchGates: Boolean(args[3]) });
    return super.deliverMessage(...args);
  }
}

const ioStub = {
  to: () => ({ emit: () => true }),
  in: () => ({ socketsJoin: () => undefined }),
} as any;

async function seedRoomWithAgents(seed: ReturnType<typeof createSeed>, size: number) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const room = await seed.channel({ server, members: [owner] });
  const agentIds: string[] = [];
  for (let i = 0; i < size; i += 1) {
    const agent = await createAgent(server.id, `paths-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
    await addAgent(room.id, agent.id);
    agentIds.push(agent.id);
  }
  return { owner, server, room, agentIds };
}

test("a system message reads its agents' gates in one batch and delivers each through deliverMessage", async ({ seed }) => {
  const { owner, room, agentIds } = await seedRoomWithAgents(seed, 4);
  const orchestrator = new GateRecordingOrchestrator();
  const sent = await broadcastSystemMessage(ioStub, orchestrator, room.id, "a system notice", {
    inboxFactPolicy: { mode: "record", producer: "channel.agent_membership", reason: "test system notice", causalActor: { type: "user", id: owner.id } },
    awaitAgentDelivery: true,
  }).catch((err: Error) => {
    // Agents without a machine are queued or dropped by the wake path; only the gate reads matter here.
    if (!/SYSTEM_MESSAGE_AGENT_DELIVERY_DROPPED/.test(err.message)) throw err;
    return null;
  });
  void sent;
  assert.equal(orchestrator.gateLoads, 1, "one gate read for the whole system message");
  assert.deepEqual(orchestrator.deliveries.map((delivery) => delivery.agentId).sort(), [...agentIds].sort());
  assert.ok(orchestrator.deliveries.every((delivery) => delivery.batchGates));
});

test("a persisted-message batch loads gates once and delivers every message to every agent with them, in order per agent", async ({ seed }) => {
  const { owner, room, agentIds } = await seedRoomWithAgents(seed, 3);
  const first = await createMessage(room.id, "user", owner.id, "batch one");
  const second = await createMessage(room.id, "user", owner.id, "batch two");
  const orchestrator = new GateRecordingOrchestrator();
  await deliverMessagesToAgents(orchestrator, [first, second], owner.name);
  assert.equal(orchestrator.gateLoads, 1, "one gate read for the whole batch");
  assert.ok(orchestrator.deliveries.every((delivery) => delivery.batchGates));
  for (const agentId of agentIds) {
    assert.deepEqual(
      orchestrator.deliveries.filter((delivery) => delivery.agentId === agentId).map((delivery) => delivery.messageId),
      [first.id, second.id],
      `${agentId}: every message, in order`,
    );
  }
});

test("a joint channel send delivers each peer projection's agents in one channel batch", async ({ app }) => {
  const tag = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`paths-joint-host-${tag}@slock.test`, `paths-joint-host-${tag}`);
  const peerOwner = await seedUser(`paths-joint-peer-${tag}@slock.test`, `paths-joint-peer-${tag}`);
  const hostServer = await createServerFixture("Paths Joint Host", `paths-joint-host-${tag}`, hostOwner.id);
  const peerServer = await createServerFixture("Paths Joint Peer", `paths-joint-peer-${tag}`, peerOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const peerToken = await tokenForHuman(peerOwner.email);
  const created = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ name: `paths-joint-${tag}`, visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [`@${peerOwner.name}`] }),
  });
  assert.equal(created.status, 200);
  const hostProjection = await created.json() as { id: string; jointInvite: { id: string } };
  const accepted = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(peerToken, peerServer.id),
  });
  assert.equal(accepted.status, 200);
  const peerProjection = await accepted.json() as { id: string };
  const peerAgentIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const agent = await createAgent(peerServer.id, `paths-peer-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
    await addAgent(peerProjection.id, agent.id);
    peerAgentIds.push(agent.id);
  }
  const orchestrator = new GateRecordingOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);

  const sent = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "joint paths" }),
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const sentBody = await sent.json() as { id: string };
  const deadline = Date.now() + 10_000;
  const peerDeliveries = () => orchestrator.deliveries.filter((delivery) => delivery.channelId === peerProjection.id && delivery.messageId === sentBody.id);
  while (peerDeliveries().length < peerAgentIds.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(peerDeliveries().map((delivery) => delivery.agentId).sort(), [...peerAgentIds].sort());
  assert.ok(peerDeliveries().every((delivery) => delivery.batchGates), "the peer projection's agents share one batch gate read");
});

test("a joint thread reply delivers each peer projection's following agents in one channel batch", async ({ app }) => {
  const tag = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`paths-jt-host-${tag}@slock.test`, `paths-jt-host-${tag}`);
  const peerOwner = await seedUser(`paths-jt-peer-${tag}@slock.test`, `paths-jt-peer-${tag}`);
  const hostServer = await createServerFixture("Paths JT Host", `paths-jt-host-${tag}`, hostOwner.id);
  const peerServer = await createServerFixture("Paths JT Peer", `paths-jt-peer-${tag}`, peerOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const peerToken = await tokenForHuman(peerOwner.email);
  const created = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ name: `paths-jt-${tag}`, visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [`@${peerOwner.name}`] }),
  });
  assert.equal(created.status, 200);
  const hostProjection = await created.json() as { id: string; jointInvite: { id: string } };
  const accepted = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(peerToken, peerServer.id),
  });
  assert.equal(accepted.status, 200);
  const peerProjection = await accepted.json() as { id: string };
  const parentRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "joint thread parent" }),
  });
  assert.equal(parentRes.status, 200);
  const parent = await parentRes.json() as { id: string };
  const threadRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ parentMessageId: parent.id, content: "first reply" }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(threadRes.status, 200);
  const hostThread = await threadRes.json() as { threadChannelId: string };
  const summaries = await (await fetch(`${app.baseUrl}/api/channels/${peerProjection.id}/threads?parentMessageIds=${parent.id}`, {
    headers: headers(peerToken, peerServer.id),
  })).json() as Record<string, { threadChannelId: string }>;
  const peerThreadId = summaries[parent.id]!.threadChannelId;

  const peerAgentIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const agent = await createAgent(peerServer.id, `paths-jt-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
    await addAgent(peerProjection.id, agent.id);
    await recordThreadFollow("agent", agent.id, peerThreadId, parent.id, "manual");
    peerAgentIds.push(agent.id);
  }
  const orchestrator = new GateRecordingOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);

  const replyRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostThread.threadChannelId, content: "second reply" }),
  });
  assert.equal(replyRes.status, 200, await replyRes.clone().text());
  const reply = await replyRes.json() as { id: string };
  const deadline = Date.now() + 10_000;
  const peerDeliveries = () => orchestrator.deliveries.filter((delivery) => delivery.channelId === peerThreadId && delivery.messageId === reply.id);
  while (peerDeliveries().length < peerAgentIds.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(peerDeliveries().map((delivery) => delivery.agentId).sort(), [...peerAgentIds].sort());
  assert.ok(peerDeliveries().every((delivery) => delivery.batchGates), "the peer thread's agents share one batch gate read");
});
