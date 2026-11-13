import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  messages,
  serverAgentMembers,
  serverMembers,
  servers,
  threadFollows,
  users,
} from "../db/schema";
import { addChannelMemberForAgent } from "../routes/agentChannelMembers";
import { broadcastAndDeliver, broadcastSystemMessage } from "./messageService";
import { runWithTraceSpan } from "../tracing/semanticTrace";
import type { ActiveSpan } from "@botiverse/raft-shared";
import {
  SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION,
  type ProductionSystemMessageProducer,
  type RequiresCausalActorProducer,
} from "./systemMessageBornReadRegistry";
import { withChannelDelivery } from "../test/orchestratorStub";


afterEach(async () => {
  await closeTestDatabase();
});

function createIoStub() {
  const roomChain = {
    in() {
      return roomChain;
    },
    socketsJoin() {},
  };
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return roomChain;
    },
  } as any;
}

const agentOrchestratorStub = withChannelDelivery({ deliverMessage: async () => undefined }) as any;

/**
 * Seed a public channel with two human members (owner + member) and one agent
 * member. Every born-read assertion checks a fact row per receiver.
 */
async function seedSurface() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "born-read-owner@slock.test",
    name: "born-read-owner",
    displayName: "Born Read Owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [member] = await db.insert(users).values({
    email: "born-read-member@slock.test",
    name: "born-read-member",
    displayName: "Born Read Member",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Born Read Server",
    slug: "born-read-server",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "born-read-agent",
    displayName: "Born Read Agent",
    runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "born-read-channel",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: member.id },
  ]);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  return { owner, member, server, agent, channel };
}

async function factFor(messageId: string, receiverType: "user" | "agent", receiverId: string) {
  const rows = await getDb()
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, messageId));
  const fact = rows.find((row) => row.receiverType === receiverType && row.receiverId === receiverId);
  assert.ok(fact, `expected an inbox fact for ${receiverType}:${receiverId} on message ${messageId}`);
  return fact;
}

// ---------------------------------------------------------------------------
// Paired born-read: actor's own row born-read, other receivers still unread.
// Represents task-create / channel-membership / rename / archive (user actor).
// ---------------------------------------------------------------------------
test("system message born-reads the human actor's own row while other members stay unread", async ({ db }) => {

  const { owner, member, agent, channel } = await seedSurface();
  const io = createIoStub();

  const system = await broadcastSystemMessage(io, agentOrchestratorStub, channel.id, "📋 1 new task created", {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.task.created_summary",
      reason: "test born-read for a user-caused system message",
      causalActor: { type: "user", id: owner.id },
    },
  });

  const ownerFact = await factFor(system.id, "user", owner.id);
  const memberFact = await factFor(system.id, "user", member.id);
  const agentFact = await factFor(system.id, "agent", agent.id);

  assert.equal(ownerFact.unreadEligible, false, "the acting human's own row must be born-read");
  assert.equal(memberFact.unreadEligible, true, "a non-actor human member must still be unread");
  assert.equal(agentFact.unreadEligible, true, "a non-actor agent member must still be unread");
});

// ---------------------------------------------------------------------------
// Paired born-read for an AGENT actor (self-join / agent-task-create).
// ---------------------------------------------------------------------------
test("system message born-reads the agent actor's own row while humans stay unread", async ({ db }) => {

  const { owner, member, agent, channel } = await seedSurface();
  const io = createIoStub();

  const system = await broadcastSystemMessage(io, agentOrchestratorStub, channel.id, "@born-read-agent joined this channel.", {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.agent.join_channel",
      reason: "test born-read for an agent-caused system message",
      causalActor: { type: "agent", id: agent.id },
    },
  });

  const agentFact = await factFor(system.id, "agent", agent.id);
  const ownerFact = await factFor(system.id, "user", owner.id);
  const memberFact = await factFor(system.id, "user", member.id);

  assert.equal(agentFact.unreadEligible, false, "the acting agent's own row must be born-read");
  assert.equal(ownerFact.unreadEligible, true, "a non-actor human must still be unread");
  assert.equal(memberFact.unreadEligible, true, "a non-actor human must still be unread");
});

// ---------------------------------------------------------------------------
// Non-collision: causalActor is matched on {type, id}, never on bare id.
// A causalActor of type "user" must NOT born-read an agent receiver, even when
// the ids were to coincide.
// ---------------------------------------------------------------------------
test("born-read matches on {type,id}: a user causalActor never born-reads an agent row", async ({ db }) => {

  const { agent, channel } = await seedSurface();
  const io = createIoStub();

  // Deliberately pass the AGENT's id but with the wrong actor type ("user").
  const system = await broadcastSystemMessage(io, agentOrchestratorStub, channel.id, "cross-type probe", {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.channel.agent_membership",
      reason: "test that {type,id} discrimination prevents user/agent id collisions",
      causalActor: { type: "user", id: agent.id },
    },
  });

  const agentFact = await factFor(system.id, "agent", agent.id);
  assert.equal(agentFact.unreadEligible, true, "an agent receiver must not be born-read by a user causalActor sharing its id");
});

// ---------------------------------------------------------------------------
// Negative control (D): NO causalActor => actor's own row stays UNREAD.
// This is the onboarding parity check — the joiner is the intended reader and
// MUST still get the notice unread.
// ---------------------------------------------------------------------------
test("negative control: without causalActor the would-be actor's own row stays unread (onboarding parity)", async ({ db }) => {

  const { owner, channel } = await seedSurface();
  const io = createIoStub();

  const system = await broadcastSystemMessage(io, agentOrchestratorStub, channel.id, "onboarding-style notice", {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.onboarding.member_instruction",
      reason: "test that opt-in born-read leaves onboarding notices unread",
    },
    // Intentionally NO causalActor.
  });

  const ownerFact = await factFor(system.id, "user", owner.id);
  assert.equal(ownerFact.unreadEligible, true, "without causalActor the actor's own row must remain unread");
});

// ---------------------------------------------------------------------------
// Negative control: a normal user chat message is unaffected by the new gate.
// The sender's own row is born-read via the existing receiver===sender shortcut;
// other members stay unread. Prior true-unread is not touched.
// ---------------------------------------------------------------------------
test("negative control: normal user message keeps existing born-read/unread split", async ({ db }) => {

  const { owner, member, channel } = await seedSurface();
  const io = createIoStub();

  const regular = await broadcastAndDeliver(io, agentOrchestratorStub, {
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.displayName ?? owner.name,
    content: "a normal message",
  });

  const senderFact = await factFor(regular.id, "user", owner.id);
  const memberFact = await factFor(regular.id, "user", member.id);
  assert.equal(senderFact.unreadEligible, false, "sender's own normal message row stays born-read (existing shortcut)");
  assert.equal(memberFact.unreadEligible, true, "a different member's normal message row stays unread");
});

// ---------------------------------------------------------------------------
// Real call-site wiring (B): the agent membership route threads the REAL acting
// agent (not message.sender, which is "system") down to the born-read gate.
// ---------------------------------------------------------------------------
test("addChannelMemberForAgent born-reads the acting agent's own membership notice", async ({ db: database }) => {

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "member-add-owner@slock.test",
    name: "member-add-owner",
    displayName: "Member Add Owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Member Add Server",
    slug: "member-add-server",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });

  // The acting agent (admin so it can manage channel members) + a bystander
  // agent already in the channel + the target agent to be added.
  const [actorAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "actor-admin-agent",
    displayName: "Actor Admin Agent",
    runtime: "codex",
  }).returning();
  const [bystanderAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "bystander-agent",
    displayName: "Bystander Agent",
    runtime: "codex",
  }).returning();
  const [targetAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "target-agent",
    displayName: "Target Agent",
    runtime: "codex",
  }).returning();
  await db.insert(serverAgentMembers).values({ serverId: server.id, agentId: actorAgent.id, role: "admin" });

  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "member-add-channel",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  await db.insert(channelAgents).values([
    { channelId: channel.id, agentId: actorAgent.id },
    { channelId: channel.id, agentId: bystanderAgent.id },
  ]);

  const io = createIoStub();
  const result = await addChannelMemberForAgent({
    actor: { id: actorAgent.id, name: actorAgent.name, serverId: server.id },
    serverId: server.id,
    channelId: channel.id,
    body: { agentId: targetAgent.id },
    io,
    agentOrchestrator: agentOrchestratorStub,
  });
  assert.equal(result.status, 200, `member add should succeed, got ${result.status}: ${JSON.stringify(result.body)}`);

  // Find the membership system message row's facts.
  const facts = await getDb()
    .select()
    .from(inboxNotificationFacts);
  const actorFact = facts.find((f) => f.receiverType === "agent" && f.receiverId === actorAgent.id);
  const bystanderFact = facts.find((f) => f.receiverType === "agent" && f.receiverId === bystanderAgent.id);

  assert.ok(actorFact, "the acting agent must have an inbox fact for the membership notice");
  assert.ok(bystanderFact, "the bystander agent must have an inbox fact for the membership notice");
  assert.equal(actorFact!.unreadEligible, false, "the acting agent's own membership notice must be born-read");
  assert.equal(bystanderFact!.unreadEligible, true, "a bystander agent must still be unread for the membership notice");
});

// ---------------------------------------------------------------------------
// Per-producer paired coverage for EVERY channel-scoped born-read producer.
// This closes the gap where only 3 of the born-read producers were pair-tested:
// it adds channel.rename, channel.archive, channel.unarchive, task.converted_summary
// (and re-covers the already-tested ones) under one data-driven loop.
// ---------------------------------------------------------------------------
const CHANNEL_BORN_READ_PRODUCERS: readonly RequiresCausalActorProducer[] = [
  "agent.join_channel",
  "agent.server_role_changed",
  "agent.runtime_action_required",
  "channel.agent_membership",
  "channel.human_membership",
  "channel.rename",
  "channel.announcement",
  "channel.archive",
  "channel.joint_disconnect",
  "channel.joint_connect",
  "channel.unarchive",
  "task.created_summary",
  "task.assignment_receipt",
  "task.converted_summary",
  // A hosted Cindy's Day-2 recap wake: born-read for the owner (causal actor), unread for the rest.
  "onboarding.hosted_recap_wake",
];

for (const producer of CHANNEL_BORN_READ_PRODUCERS) {
  test(`born-read producer "${producer}" suppresses the acting user's own row while a co-member stays unread`, async ({ db }) => {

    const { owner, member, channel } = await seedSurface();
    const io = createIoStub();

    const system = await broadcastSystemMessage(io, agentOrchestratorStub, channel.id, `system notice for ${producer}`, {
      inboxFactPolicy: {
        mode: "record",
        producer,
        reason: `paired born-read coverage for ${producer}`,
        causalActor: { type: "user", id: owner.id },
      },
    });

    const ownerFact = await factFor(system.id, "user", owner.id);
    const memberFact = await factFor(system.id, "user", member.id);
    assert.equal(ownerFact.unreadEligible, false, `the actor's own row must be born-read for ${producer}`);
    assert.equal(memberFact.unreadEligible, true, `a co-member's row must stay unread for ${producer}`);
  });
}

// ---------------------------------------------------------------------------
// #9 task-status → born-read, on the real thread surface. The user who moves the
// task is born-read on the task's thread; another thread follower stays unread.
// ---------------------------------------------------------------------------
test("task status change born-reads the acting user's own thread row while another follower stays unread (#9)", async ({ db: database }) => {

  const { owner, member, channel } = await seedSurface();
  const db = getDb();

  // The task body message is the thread's parent.
  const [parentMsg] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "task body",
    seq: 1,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: channel.serverId,
    name: "task-thread",
    type: "thread",
    parentMessageId: parentMsg.id,
  }).returning();
  // Both the actor (owner, moving the task) and another member follow the thread.
  await db.insert(threadFollows).values([
    { threadChannelId: thread.id, followerType: "user", followerId: owner.id, parentMessageId: parentMsg.id, reason: "manual" },
    { threadChannelId: thread.id, followerType: "user", followerId: member.id, parentMessageId: parentMsg.id, reason: "manual" },
  ]);

  const io = createIoStub();
  const system = await broadcastSystemMessage(io, agentOrchestratorStub, thread.id, "📝 owner moved #1 to In Review", {
    inboxFactPolicy: {
      mode: "record",
      producer: "task.lifecycle_thread",
      reason: "task status transition is a collaboration signal",
      causalActor: { type: "user", id: owner.id },
    },
  });

  const ownerFact = await factFor(system.id, "user", owner.id);
  const memberFact = await factFor(system.id, "user", member.id);
  assert.equal(ownerFact.unreadEligible, false, "the user who moved the task must be born-read on the thread");
  assert.equal(memberFact.unreadEligible, true, "another thread follower must still be unread");

  // 2026-09-21 teardown: the serving-rows projection is retired. The born-read
  // verdict survives as the recorded fact above (unreadEligible); read-side
  // suppression returns when the canonical derivation gains causal_actor
  // columns (Stage 2 requirement) — until then the deriving surfaces count the
  // self-caused system row like any other message.
});

// ---------------------------------------------------------------------------
// assistant.delegated_receipt (RFC 077) → born-read only for its causal actor,
// the assistant that sent as the owner; the owner it is written for stays
// unread (and the assistant is never a delivery target of its own receipt).
// ---------------------------------------------------------------------------
test("a delegated-send receipt is born-read only for the assistant that caused it; the owner stays unread", async ({ db: _database }) => {
  const { owner, member, agent, channel } = await seedSurface();
  const system = await broadcastSystemMessage(createIoStub(), agentOrchestratorStub, channel.id, "Sent for you in #born-read-channel: \"hi\"", {
    inboxFactPolicy: {
      mode: "record",
      producer: "assistant.delegated_receipt",
      reason: "paired born-read coverage for assistant.delegated_receipt",
      causalActor: { type: "agent", id: agent.id },
    },
    targetAgentIds: [],
  });
  assert.equal((await factFor(system.id, "user", owner.id)).unreadEligible, true, "the owner must see the receipt unread");
  assert.equal((await factFor(system.id, "user", member.id)).unreadEligible, true, "another human stays unread");
});

// ---------------------------------------------------------------------------
// assistant.stopped_by_admin → born-read only for the admin who stopped the
// assistant; its owner, the reader the notice is for, stays unread.
// ---------------------------------------------------------------------------
test("an admin-stopped-assistant notice is born-read only for the admin; the owner stays unread", async ({ db: _database }) => {
  const { owner, member, channel } = await seedSurface();
  const system = await broadcastSystemMessage(createIoStub(), agentOrchestratorStub, channel.id, "An admin is stopping your assistant.", {
    inboxFactPolicy: {
      mode: "record",
      producer: "assistant.stopped_by_admin",
      reason: "paired born-read coverage for assistant.stopped_by_admin",
      causalActor: { type: "user", id: member.id },
    },
    targetAgentIds: [],
  });
  assert.equal((await factFor(system.id, "user", member.id)).unreadEligible, false, "the admin who stopped it is born-read");
  assert.equal((await factFor(system.id, "user", owner.id)).unreadEligible, true, "the owner must see the notice unread");
});

// ---------------------------------------------------------------------------
// action_card.result_reply → born-read for the confirming human; the @mentioned
// preparing agent (the card author, following the card thread) stays unread.
// ---------------------------------------------------------------------------
test("action-card result reply born-reads the confirming human while the mentioned preparer stays unread", async ({ db: _database }) => {
  const { owner, agent, channel } = await seedSurface();
  const db = getDb();
  const [carrier] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "agent",
    senderId: agent.id,
    content: "Create channel #x",
    seq: 1,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: channel.serverId,
    name: "card-thread",
    type: "thread",
    parentMessageId: carrier.id,
  }).returning();
  await db.insert(threadFollows).values([
    { threadChannelId: thread.id, followerType: "user", followerId: owner.id, parentMessageId: carrier.id, reason: "manual" },
    { threadChannelId: thread.id, followerType: "agent", followerId: agent.id, parentMessageId: carrier.id, reason: "mentioned" },
  ]);

  const system = await broadcastSystemMessage(createIoStub(), agentOrchestratorStub, thread.id, `@${agent.name} your action card was executed`, {
    inboxFactPolicy: {
      mode: "record",
      producer: "action_card.result_reply",
      reason: "paired born-read coverage for action_card.result_reply",
      causalActor: { type: "user", id: owner.id },
    },
    personalAttentionTargets: [{ type: "agent", id: agent.id, name: agent.name }],
  });

  const ownerFact = await factFor(system.id, "user", owner.id);
  const agentFact = await factFor(system.id, "agent", agent.id);
  assert.equal(ownerFact.unreadEligible, false, "the confirming human's own row must be born-read");
  assert.equal(agentFact.unreadEligible, true, "the preparing agent must see the result unread");
  assert.equal(agentFact.personalMention, true, "the result is a personal mention for the preparer");
});

// ---------------------------------------------------------------------------
// Compile-time structural-coupling guard: a "born-read" producer REQUIRES
// `causalActor`, and a "notify-exclude" / "skip" producer REJECTS one.
//
// This is now enforced by the `SystemMessageInboxFactPolicy` discriminated union
// at TYPE level (no runtime throw). The two-way `@ts-expect-error` assertion
// lives in systemMessageBornReadRegistry.typeproof.ts. A forgotten
// `causalActor` is a compile error, not a runtime one.
// ---------------------------------------------------------------------------

// Completeness gate: every registry "born-read" producer must have a paired
// suppression test in this file. A new born-read producer without coverage
// fails here (belt to the registry's compile-time forced-declaration).
// ---------------------------------------------------------------------------
const COVERED_BORN_READ_PRODUCERS = new Set<ProductionSystemMessageProducer>([
  ...CHANNEL_BORN_READ_PRODUCERS,
  "task.lifecycle_thread",
  "action_card.result_reply",
  "assistant.delegated_receipt",
  "assistant.stopped_by_admin",
]);

test("every registry born-read producer has paired suppression coverage in this file", () => {
  const bornRead = (Object.entries(SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION) as [ProductionSystemMessageProducer, string][])
    .filter(([, classification]) => classification === "born-read")
    .map(([producer]) => producer);
  assert.ok(bornRead.length > 0, "expected at least one born-read producer in the registry");
  for (const producer of bornRead) {
    assert.ok(
      COVERED_BORN_READ_PRODUCERS.has(producer),
      `born-read producer "${producer}" has no paired suppression test — add coverage in bornReadSelfCaused.test.ts`,
    );
  }
});

// ---------------------------------------------------------------------------
// Observability (stdrc 7/11): the born-read suppression must be confirmable
// post-release. The system_inbox_notification_facts.recorded trace carries a
// born_read_receiver_count (+ producer) so prod can verify the gate fires
// (>=1 for a self-caused producer) rather than silently regressing to
// full-unread. Captured via a stub ActiveSpan through runWithTraceSpan.
// ---------------------------------------------------------------------------
function captureTraceEvents() {
  const events: { name: string; attrs?: Record<string, unknown> }[] = [];
  const span = {
    context: { traceId: "born-read-trace", spanId: "born-read-span" },
    addEvent(name: string, attrs?: Record<string, unknown>) {
      events.push({ name, attrs });
    },
    end() {},
  } as unknown as ActiveSpan;
  return { events, span };
}

test("recorded trace carries born_read_receiver_count + producer for a self-caused system message", async ({ db }) => {

  const { owner, channel } = await seedSurface();
  const io = createIoStub();
  const { events, span } = captureTraceEvents();

  await runWithTraceSpan(span, () =>
    broadcastSystemMessage(io, agentOrchestratorStub, channel.id, "📋 1 new task created", {
      inboxFactPolicy: {
        mode: "record",
        producer: "test.task.created_summary",
        reason: "trace-assert born-read observability",
        causalActor: { type: "user", id: owner.id },
      },
    }),
  );

  const recorded = events.find((e) => e.name === "message_pipeline.system_inbox_notification_facts.recorded");
  assert.ok(recorded, "the system_inbox_notification_facts.recorded trace event must be emitted");
  assert.equal(recorded.attrs?.born_read_receiver_count, 1, "exactly the acting user's own row is born-read → count must be 1");
  assert.equal(recorded.attrs?.producer, "test.task.created_summary", "trace must carry the producer for per-producer confirmation");
});

test("recorded trace reports born_read_receiver_count=0 when there is no causalActor (regression signal)", async ({ db }) => {

  const { channel } = await seedSurface();
  const io = createIoStub();
  const { events, span } = captureTraceEvents();

  await runWithTraceSpan(span, () =>
    broadcastSystemMessage(io, agentOrchestratorStub, channel.id, "onboarding-style notice", {
      inboxFactPolicy: {
        mode: "record",
        producer: "test.onboarding.member_instruction",
        reason: "trace-assert negative control",
      },
      // Intentionally NO causalActor.
    }),
  );

  const recorded = events.find((e) => e.name === "message_pipeline.system_inbox_notification_facts.recorded");
  assert.ok(recorded, "the recorded trace event must be emitted");
  assert.equal(recorded.attrs?.born_read_receiver_count, 0, "without causalActor no row is born-read → count 0");
});
