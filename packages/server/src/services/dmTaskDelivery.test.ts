import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest";
import {
  users,
  servers,
  serverMembers,
  agents,
  channelAgents,
  threadFollows,
} from "../db/schema";
import {
  findOrCreateAgentDM,
  findOrCreateDM,
  getOrCreateThread,
  resolveAgentFacingChannelRef,
  resolveChannelByName,
} from "./channelService";
import { createTasksWithAssignmentReceipt } from "./taskService";
import {
  createMessage,
  deliverMessagesToAgents,
  broadcastSystemMessage,
  listMessages,
} from "./messageService";
import { AgentVisibleDeliveryLedger } from "../../../daemon/src/agentVisibleDeliveryLedger";
import { normalizeInboxVisibleMessages } from "../../../daemon/src/agentInboxStateMachine";
import { projectAgentInboxSnapshot } from "../../../daemon/src/agentInboxProjection";
import { withChannelDelivery } from "../test/orchestratorStub";

test("DM task and started receipt expose a readable recipient target and are consumed by history", async ({
  db,
}) => {
  const [owner] = await db
    .insert(users)
    .values({
      email: "task1195@test.invalid",
      name: "ProbeOwner1195",
      passwordHash: "x",
      emailVerified: true,
    })
    .returning();
  const [server] = await db
    .insert(servers)
    .values({ name: "Probe1195", slug: "probe1195", ownerId: owner.id })
    .returning();
  await db
    .insert(serverMembers)
    .values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [a, b] = await db
    .insert(agents)
    .values([
      { serverId: server.id, name: "ProbeAuthor1195", status: "active" },
      { serverId: server.id, name: "ProbeRecipient1195", status: "active" },
    ])
    .returning();
  const dm = await findOrCreateAgentDM(server.id, a.id, b.id);
  assert.ok(dm);
  const created = await createTasksWithAssignmentReceipt(
    dm.id,
    "agent",
    a.id,
    [{ title: "synthetic task1195" }],
    { type: "agent", id: a.id },
    { assigneeName: a.name },
  );
  assert.equal(created.assignmentReceipt!.state, "started");
  const deliveries: { agentId: string; message: any }[] = [];
  const orchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, message: any) => {
      deliveries.push({ agentId, message });
      return { status: "queued" };
    },
  }) as any;
  const io = {
    to: () => ({ emit() {} }),
    in: () => ({ socketsJoin() {}, in: () => ({ socketsJoin() {} }) }),
  } as any;
  await deliverMessagesToAgents(orchestrator, created.hostMessages, a.name);
  await broadcastSystemMessage(
    io,
    orchestrator,
    dm.id,
    created.assignmentReceipt!.content,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.assignment_receipt",
        reason: "synthetic regression",
        causalActor: { type: "agent", id: a.id },
      },
      persistedMessage: created.assignmentReceipt!.message,
      personalAttentionTargets: [{ type: "agent", id: a.id, name: a.name }],
      awaitAgentDelivery: true,
    },
  );
  const pending = deliveries
    .filter((x) => x.agentId === b.id)
    .map((x) => x.message);
  assert.equal(
    pending.length,
    2,
    "both task body and system receipt actually delivered",
  );
  const ids = [
    created.hostMessages[0].id,
    created.assignmentReceipt!.message.id,
  ];
  assert.deepEqual(
    pending.map((x) => x.message_id),
    ids,
  );
  const correctTarget = await resolveAgentFacingChannelRef(
    server.id,
    b.id,
    dm.id,
  );
  assert.equal(correctTarget, "dm:@ProbeAuthor1195");
  assert.equal(projectAgentInboxSnapshot(pending)[0].target, correctTarget);
  const resolved = await resolveChannelByName(server.id, b.id, correctTarget!);
  assert.equal(resolved?.channelId, dm.id);
  const history = await listMessages(resolved!.channelId);
  const ledger = new AgentVisibleDeliveryLedger();
  const consumed = ledger.recordConsumed(b.id, {
    target: correctTarget!,
    source: "agent_api_history",
    messages: normalizeInboxVisibleMessages(
      history.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
      correctTarget!,
    ),
  });
  assert.ok(consumed);
  assert.equal(pending.filter((x) => !consumed.shouldSuppress(x)).length, 0);
  // The same stored DM name must project differently for the other recipient.
  const aNotice = deliveries.find((x) => x.agentId === a.id)!;
  assert.equal(
    projectAgentInboxSnapshot([aNotice.message])[0].target,
    `dm:@${b.name}`,
  );
  const reverse = await createMessage(
    dm.id,
    "agent",
    b.id,
    "reverse task-like body",
  );
  deliveries.length = 0;
  await deliverMessagesToAgents(orchestrator, [reverse], b.name);
  assert.equal(deliveries[0].message.channel_name, b.name);

  const humanDm = await findOrCreateDM(server.id, owner.id, b.id);
  assert.ok(humanDm);
  deliveries.length = 0;
  await broadcastSystemMessage(
    io,
    orchestrator,
    humanDm.id,
    "human DM notice",
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "test.dm",
        reason: "synthetic",
      },
      awaitAgentDelivery: true,
    },
  );
  assert.equal(deliveries[0].message.channel_name, owner.name);

  const thread = await getOrCreateThread(
    created.hostMessages[0].id,
    a.id,
    "agent",
  );
  await db
    .insert(channelAgents)
    .values({ channelId: thread.id, agentId: b.id })
    .onConflictDoNothing();
  await db
    .insert(threadFollows)
    .values({
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: b.id,
      parentMessageId: created.hostMessages[0].id,
      reason: "manual",
    })
    .onConflictDoNothing();
  const reply = await createMessage(
    thread.id,
    "agent",
    a.id,
    "thread task-like body",
  );
  deliveries.length = 0;
  await deliverMessagesToAgents(orchestrator, [reply], a.name);
  await broadcastSystemMessage(
    io,
    orchestrator,
    thread.id,
    "thread system notice",
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "test.dm",
        reason: "synthetic",
      },
      awaitAgentDelivery: true,
    },
  );
  const threadPending = deliveries
    .filter((x) => x.agentId === b.id)
    .map((x) => x.message);
  assert.equal(threadPending.length, 2);
  for (const message of threadPending) {
    assert.equal(message.parent_channel_name, a.name);
    assert.equal(message.parent_channel_id, dm.id);
    const target = projectAgentInboxSnapshot([message])[0].target;
    assert.equal(
      (await resolveChannelByName(server.id, b.id, target))?.channelId,
      thread.id,
    );
  }
});
