import { createApiTest } from "../test/integration/apiTest.js";

import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { users, channels, channelAgents, channelHumans } from "../db/schema.js";
import { createServer } from "./serverService.js";
import { addMember } from "./serverService.js";
import { createAgent } from "./agentService.js";
import {
  createChannel,
  addAgent,
  addHuman,
  getChannel,
  getChannelAgents,
  getChannelHumans,
  getChannelMembers,
  isEnabledAllChannel,
} from "./channelService.js";
import { broadcastAndDeliver, broadcastSystemMessage } from "./messageService.js";
import { withTraceRoot } from "../tracing/semanticTrace.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

let userSeq = 0;
async function seedUser(label: string) {
  userSeq += 1;
  const [user] = await getDb()
    .insert(users)
    .values({
      email: `${label}-${userSeq}@slock.test`,
      name: `${label}-${userSeq}`,
      displayName: label,
      passwordHash: "test-hash",
      emailVerified: true,
    })
    .returning();
  return user;
}

async function findAllChannel(serverId: string) {
  const [allChannel] = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.name, "all")));
  assert.ok(allChannel, "expected #all channel to exist");
  return allChannel.id;
}

function createNoopIo() {
  const chain = {
    in() {
      return chain;
    },
    to() {
      return chain;
    },
    socketsJoin() {},
    emit() {},
  };
  return chain as any;
}

// Regression: an enabled virtual `#all` channel exposes every ordinary server
// human and agent, while Guests remain a separate optional read-only projection
// and never enter its roster or delivery audience.
test("getChannelAgents/getChannelHumans virtualize the non-Guest audience for enabled #all", async ({ app }) => {
  const owner = await seedUser("all-owner");
  const memberB = await seedUser("all-member");
  const guest = await seedUser("all-guest");

  const server = await createServer("All Parity Server", "all-parity", owner.id);
  await addMember(server.id, memberB.id);
  await addMember(server.id, guest.id, "guest");
  const agentA = await createAgent(server.id, "agent-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "agent-b", { runtime: "codex" });

  const allChannelId = await findAllChannel(server.id);
  const allChannel = await getChannel(allChannelId);
  assert.ok(allChannel && isEnabledAllChannel(allChannel), "#all must be an enabled virtual channel");

  // Prove virtualization: the agents/members were never explicitly added to
  // #all, so the raw join tables hold no rows for them here.
  const rawAllAgents = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, allChannelId));
  assert.ok(
    !rawAllAgents.some((r) => r.agentId === agentB.id),
    "agentB must not have an explicit channel_agents row in #all (membership is virtual)",
  );
  const rawAllHumans = await getDb()
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, allChannelId));
  assert.ok(
    !rawAllHumans.some((r) => r.userId === memberB.id),
    "memberB must not have an explicit channel_humans row in #all (membership is virtual)",
  );

  // Positive: full server audience is returned for #all.
  const allAgents = await getChannelAgents(allChannelId);
  const allAgentIds = new Set(allAgents.map((a) => a.id));
  assert.ok(allAgentIds.has(agentA.id), "#all agents must include agentA");
  assert.ok(allAgentIds.has(agentB.id), "#all agents must include agentB (virtual audience)");

  const allHumans = await getChannelHumans(allChannelId);
  const allHumanIds = new Set(allHumans.map((h) => h.id));
  assert.ok(allHumanIds.has(owner.id), "#all humans must include owner");
  assert.ok(allHumanIds.has(memberB.id), "#all humans must include memberB (virtual audience)");
  assert.equal(allHumanIds.has(guest.id), false, "#all humans must exclude Guests from roster and delivery membership");

  // Parity: getChannelMembers must agree with the read functions for #all.
  const members = await getChannelMembers(allChannelId);
  assert.deepEqual(
    new Set(members.agents.map((a) => a.id)),
    allAgentIds,
    "getChannelMembers agents must match getChannelAgents for #all",
  );
  assert.deepEqual(
    new Set(members.humans.map((h) => h.id)),
    allHumanIds,
    "getChannelMembers humans must match getChannelHumans for #all",
  );
});

test("#all message delivery traces include virtual audience counts without private IDs", async ({ app }) => {
  const owner = await seedUser("all-trace-owner");
  const memberB = await seedUser("all-trace-member");

  const server = await createServer("All Trace Server", "all-trace", owner.id);
  await addMember(server.id, memberB.id);
  const agentA = await createAgent(server.id, "trace-agent-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "trace-agent-b", { runtime: "codex" });

  const allChannelId = await findAllChannel(server.id);
  const allChannel = await getChannel(allChannelId);
  assert.ok(allChannel && isEnabledAllChannel(allChannel), "#all must be an enabled virtual channel");

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "a".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const io = createNoopIo();
  const agentOrchestrator = {
    deliverMessage: async () => {},
  } as any;

  await withTraceRoot(tracer, "test.all.message", { surface: "server", kind: "server" }, async () => {
    await broadcastAndDeliver(io, agentOrchestrator, {
      channelId: allChannelId,
      senderType: "user",
      senderId: owner.id,
      senderName: owner.name,
      content: "hello #all",
    });
  });

  const ordinarySpan = sink.getAllSpans().find((span) => span.name === "test.all.message");
  assert.ok(ordinarySpan, "expected ordinary message trace span");
  const agentDelivery = ordinarySpan.events.find((event) => event.name === "message_pipeline.agent_delivery.scheduled");
  assert.ok(agentDelivery, "expected agent delivery trace");
  assert.equal(agentDelivery.attrs?.is_all_channel, true);
  assert.equal(agentDelivery.attrs?.agent_audience_count, 2);
  assert.equal(agentDelivery.attrs?.agent_delivery_count, 2);
  assert.equal(Object.values(agentDelivery.attrs ?? {}).includes(agentA.id), false);
  assert.equal(Object.values(agentDelivery.attrs ?? {}).includes(agentB.id), false);

  const pushTargets = ordinarySpan.events.find((event) => event.name === "message_pipeline.push_targets.built");
  assert.ok(pushTargets, "expected push target trace");
  assert.equal(pushTargets.attrs?.is_all_channel, true);
  assert.equal(pushTargets.attrs?.human_audience_count, 2);
  assert.equal(pushTargets.attrs?.human_delivery_count, 1);
  assert.equal(Object.values(pushTargets.attrs ?? {}).includes(owner.id), false);
  assert.equal(Object.values(pushTargets.attrs ?? {}).includes(memberB.id), false);

  sink.clear();
  await withTraceRoot(tracer, "test.all.system_message", { surface: "server", kind: "server" }, async () => {
    await broadcastSystemMessage(io, agentOrchestrator, allChannelId, "system notice", {
      inboxFactPolicy: {
        mode: "record",
        producer: "test.all.system_message",
        reason: "test system notice is shared channel activity",
      },
      targetAgentIds: [agentA.id],
    });
  });

  const systemSpan = sink.getAllSpans().find((span) => span.name === "test.all.system_message");
  assert.ok(systemSpan, "expected system message trace span");
  const systemDelivery = systemSpan.events.find((event) => event.name === "message_pipeline.system_agent_delivery.scheduled");
  assert.ok(systemDelivery, "expected system agent delivery trace");
  assert.equal(systemDelivery.attrs?.is_all_channel, true);
  assert.equal(systemDelivery.attrs?.agent_audience_count, 2);
  assert.equal(systemDelivery.attrs?.agent_delivery_count, 1);
  assert.equal(systemDelivery.attrs?.target_filter_present, true);
  assert.equal(Object.values(systemDelivery.attrs ?? {}).includes(agentA.id), false);
  assert.equal(Object.values(systemDelivery.attrs ?? {}).includes(agentB.id), false);
});

// Negative: non-#all channels keep explicit-membership semantics; the
// virtualization must not leak the whole server audience into private/regular
// channels.
test("non-#all channels keep explicit membership (no audience leak)", async ({ app }) => {
  const owner = await seedUser("explicit-owner");
  const memberB = await seedUser("explicit-member");

  const server = await createServer("Explicit Membership Server", "explicit-membership", owner.id);
  await addMember(server.id, memberB.id);
  const agentA = await createAgent(server.id, "agent-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "agent-b", { runtime: "codex" });

  const channel = await createChannel(server.id, "secret-room");
  await addAgent(channel.id, agentA.id);
  await addHuman(channel.id, owner.id);

  const agentsOut = await getChannelAgents(channel.id);
  assert.deepEqual(
    agentsOut.map((a) => a.id),
    [agentA.id],
    "regular channel agents must be exactly the explicitly added agents",
  );
  assert.ok(!agentsOut.some((a) => a.id === agentB.id), "agentB must not leak into a non-#all channel");

  const humansOut = await getChannelHumans(channel.id);
  assert.deepEqual(
    humansOut.map((h) => h.id),
    [owner.id],
    "regular channel humans must be exactly the explicitly added humans",
  );
  assert.ok(!humansOut.some((h) => h.id === memberB.id), "memberB must not leak into a non-#all channel");
});

// Cross-server isolation: a server's #all audience must never include another
// server's agents/members.
test("#all virtual audience is isolated per server", async ({ app }) => {
  const ownerA = await seedUser("iso-owner-a");
  const serverA = await createServer("Iso Server A", "iso-server-a", ownerA.id);
  const agentA = await createAgent(serverA.id, "iso-agent-a", { runtime: "codex" });

  const ownerB = await seedUser("iso-owner-b");
  const serverB = await createServer("Iso Server B", "iso-server-b", ownerB.id);
  const agentB = await createAgent(serverB.id, "iso-agent-b", { runtime: "codex" });

  const allA = await findAllChannel(serverA.id);
  const agentsA = await getChannelAgents(allA);
  const humansA = await getChannelHumans(allA);
  assert.ok(agentsA.some((a) => a.id === agentA.id), "server A #all must include its own agent");
  assert.ok(!agentsA.some((a) => a.id === agentB.id), "server A #all must not include server B's agent");
  assert.ok(humansA.some((h) => h.id === ownerA.id), "server A #all must include its own owner");
  assert.ok(!humansA.some((h) => h.id === ownerB.id), "server A #all must not include server B's owner");
});
