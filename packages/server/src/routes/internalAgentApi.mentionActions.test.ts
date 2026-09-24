import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { channelAgents, inboxNotificationFacts, messageMentions, messages, serverMembers, users } from "../db/schema.js";
import { createAgent } from "../services/agentService.js";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "../services/channelService.js";
import { mintAgentCredential, type AgentCapability } from "../services/agentCredentialService.js";
import { createMessage } from "../services/messageService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type MentionActionsFixture = {
  serverId: string;
  ownerId: string;
  actingAgentId: string;
  actingAgentKey: string;
  targetAgentId: string;
  targetAgentKey: string;
  targetUserId: string;
  otherAgentId: string;
  channelId: string;
  channelName: string;
  privateChannelId: string;
};

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function mintAgentKey(agentId: string, scopes: readonly AgentCapability[]): Promise<string> {
  const minted = await mintAgentCredential({
    agentId,
    scopes,
    name: `mention-actions-${agentId}-${scopes.join("-")}`,
    createdByUserId: null,
  });
  return minted.apiKey;
}

async function seedFixture(): Promise<MentionActionsFixture> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `mention-actions-${suffix}@slock.test`,
    name: `mention-actions-${suffix}`,
    displayName: "Mention Actions Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const [targetUser] = await db.insert(users).values({
    email: `mention-actions-target-${suffix}@slock.test`,
    name: `mention-actions-target-${suffix}`,
    displayName: "Mention Actions Human Target",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Mention Actions Test", `mention-actions-${suffix}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: targetUser.id, role: "member" });
  const acting = await createAgent(server.id, `MentionSender${suffix.slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const target = await createAgent(server.id, `MentionTarget${suffix.slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, `MentionOther${suffix.slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `mention-actions-${suffix.slice(0, 8)}`);
  const privateChannel = await createChannel(server.id, `mention-actions-private-${suffix.slice(0, 8)}`, undefined, "private");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, acting.id);
  await addAgent(channel.id, other.id);
  await addHuman(privateChannel.id, owner.id);
  await addAgent(privateChannel.id, acting.id);
  return {
    serverId: server.id,
    ownerId: owner.id,
    actingAgentId: acting.id,
    actingAgentKey: await mintAgentKey(acting.id, ["mentions"]),
    targetAgentId: target.id,
    targetAgentKey: await mintAgentKey(target.id, ["mentions"]),
    targetUserId: targetUser.id,
    otherAgentId: other.id,
    channelId: channel.id,
    channelName: channel.name,
    privateChannelId: privateChannel.id,
  };
}

async function insertPendingMention(
  fixture: MentionActionsFixture,
  overrides: {
    senderId?: string;
    channelId?: string;
    id?: string;
    createdAt?: Date;
    notifiedAt?: Date;
    notifiedByType?: "user" | "agent";
    notifiedById?: string;
    notifiedAction?: "notify_only" | "add";
    targetType?: "agent" | "user";
    targetId?: string;
  } = {},
) {
  const db = getDb();
  const channelId = overrides.channelId ?? fixture.channelId;
  const senderId = overrides.senderId ?? fixture.actingAgentId;
  const message = await createMessage(channelId, "agent", senderId, `hello @target ${randomUUID()}`);
  const values: typeof messageMentions.$inferInsert = {
    id: overrides.id,
    messageId: message.id,
    messageSeq: message.seq,
    serverId: fixture.serverId,
    channelId,
    targetType: overrides.targetType ?? "agent",
    targetId: overrides.targetId ?? fixture.targetAgentId,
    handleAtSendTime: "MentionTarget",
    source: "send_path",
    notifiableAtSend: false,
    createdAt: overrides.createdAt,
    notifiedAt: overrides.notifiedAt,
    notifiedByType: overrides.notifiedByType,
    notifiedById: overrides.notifiedById,
    notifiedAction: overrides.notifiedAction,
  };
  const [mention] = await db.insert(messageMentions).values(values).returning();
  return { mention, message };
}

test("agent-api mention-actions pending lists only unresolved sender-owned rows", async ({ app }) => {
  const fixture = await seedFixture();
  const pending = await insertPendingMention(fixture);
  await insertPendingMention(fixture, { notifiedAt: new Date(), notifiedByType: "agent", notifiedById: fixture.actingAgentId, notifiedAction: "add" });
  await insertPendingMention(fixture, { senderId: fixture.otherAgentId });
  await insertPendingMention(fixture, { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });

  const res = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/pending`, {
    headers: jsonHeaders(fixture.actingAgentKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    pendingMentionActions: Array<{ resolutionId: string; messageId: string; channelId: string; channelName: string; availableActions: string[] }>;
  };
  assert.deepEqual(body.pendingMentionActions.map((action) => action.resolutionId), [pending.mention.id]);
  assert.equal(body.pendingMentionActions[0]?.messageId, pending.message.id);
  assert.equal(body.pendingMentionActions[0]?.channelId, fixture.channelId);
  assert.equal(body.pendingMentionActions[0]?.channelName, fixture.channelName);
  assert.deepEqual(body.pendingMentionActions[0]?.availableActions, ["notify"]);
});

test("agent-api mention-actions pending uses a limit-plus-one probe for has_more", async ({ app }) => {
  const fixture = await seedFixture();
  const baseCreatedAt = Date.now() - 3 * 60 * 1000;
  const first = await insertPendingMention(fixture, { createdAt: new Date(baseCreatedAt) });
  const second = await insertPendingMention(fixture, { createdAt: new Date(baseCreatedAt + 60 * 1000) });

  const exact = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/pending?limit=2`, {
    headers: jsonHeaders(fixture.actingAgentKey),
  });
  assert.equal(exact.status, 200);
  const exactBody = await exact.json() as {
    pendingMentionActions: Array<{ resolutionId: string }>;
    has_more: boolean;
  };
  assert.deepEqual(
    exactBody.pendingMentionActions.map((action) => action.resolutionId),
    [second.mention.id, first.mention.id],
  );
  assert.equal(exactBody.has_more, false, "exactly limit pending actions must not imply another page");

  const third = await insertPendingMention(fixture, { createdAt: new Date(baseCreatedAt + 2 * 60 * 1000) });
  const over = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/pending?limit=2`, {
    headers: jsonHeaders(fixture.actingAgentKey),
  });
  assert.equal(over.status, 200);
  const overBody = await over.json() as {
    pendingMentionActions: Array<{ resolutionId: string }>;
    has_more: boolean;
  };
  assert.deepEqual(
    overBody.pendingMentionActions.map((action) => action.resolutionId),
    [third.mention.id, second.mention.id],
  );
  assert.equal(overBody.has_more, true);
});

test("agent-api mention-actions notify writes notified fields without adding membership", async ({ app }) => {
  const fixture = await seedFixture();
  const pending = await insertPendingMention(fixture);
  const deliveries: Array<{
    agentId: string;
    message: { message_id?: string; non_member_mention?: boolean };
    options?: { requireQueueReceipt?: boolean };
  }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (
      agentId: string,
      message: { message_id?: string; non_member_mention?: boolean },
      options?: { requireQueueReceipt?: boolean },
    ) => Promise<{
      status: "queued";
      reason: "replayable_inbox";
    }>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message, options) => {
    deliveries.push({ agentId, message, options });
    return { status: "queued", reason: "replayable_inbox" };
  };

  const res = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "notify", resolutionIds: [pending.mention.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<{ status: string; dedupedResolutionIds: string[] }> };
  assert.equal(body.results[0]?.status, "queued");
  assert.deepEqual(body.results[0]?.dedupedResolutionIds, [pending.mention.id]);

  const [row] = await getDb()
    .select()
    .from(messageMentions)
    .where(eq(messageMentions.id, pending.mention.id));
  assert.ok(row?.notifiedAt);
  const queuedAt = row.notifiedAt;
  assert.equal(row.notifiedByType, "agent");
  assert.equal(row.notifiedById, fixture.actingAgentId);
  assert.equal(row.notifiedAction, "notify_only");
  const queuedFacts = await getDb()
    .select({ messageId: inboxNotificationFacts.messageId })
    .from(inboxNotificationFacts)
    .where(and(
      eq(inboxNotificationFacts.receiverType, "agent"),
      eq(inboxNotificationFacts.receiverId, fixture.targetAgentId),
      eq(inboxNotificationFacts.messageId, pending.message.id),
    ));
  assert.deepEqual(queuedFacts, [{ messageId: pending.message.id }]);
  const membership = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, fixture.channelId), eq(channelAgents.agentId, fixture.targetAgentId)));
  assert.equal(membership.length, 0, "notify-only must not add channel membership");

  const targetMentions = await fetch(`${app.baseUrl}/internal/agent-api/mentions`, {
    headers: jsonHeaders(fixture.targetAgentKey),
  });
  assert.equal(targetMentions.status, 200);
  const targetBody = await targetMentions.json() as { mentions: Array<{ messageId: string }> };
  assert.deepEqual(targetBody.mentions.map((mention) => mention.messageId), [pending.message.id]);
  assert.ok(
    deliveries.some((delivery) => (
      delivery.agentId === fixture.targetAgentId
      && delivery.message.message_id === pending.message.id
      && delivery.message.non_member_mention === true
      && delivery.options?.requireQueueReceipt === true
    )),
    "notify must deliver the original message with an honest non-member reply notice",
  );
  const deliveriesAfterFirstNotify = deliveries.length;
  const replay = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "notify", resolutionIds: [pending.mention.id] }),
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { results: Array<{ status: string; reason?: string }> };
  assert.equal(replayBody.results[0]?.status, "queued");
  assert.equal(replayBody.results[0]?.reason, "already_queued");
  assert.equal(
    deliveries.length,
    deliveriesAfterFirstNotify,
    "idempotent notify replay must not live-deliver the original message again",
  );
  const [rowAfterReplay] = await getDb()
    .select()
    .from(messageMentions)
    .where(eq(messageMentions.id, pending.mention.id));
  assert.equal(rowAfterReplay?.notifiedAt?.getTime(), queuedAt.getTime());
  assert.equal(rowAfterReplay?.notifiedAction, "notify_only");

  const pendingAfterNotify = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/pending`, {
    headers: jsonHeaders(fixture.actingAgentKey),
  });
  assert.equal(pendingAfterNotify.status, 200);
  const pendingAfterNotifyBody = await pendingAfterNotify.json() as {
    pendingMentionActions: Array<{ resolutionId: string; availableActions: string[] }>;
  };
  assert.deepEqual(pendingAfterNotifyBody.pendingMentionActions, []);
});

test("agent-api mention-actions notify cloaks private-thread content from non-members", async ({ app }) => {
  const fixture = await seedFixture();
  const privateParent = await createMessage(fixture.privateChannelId, "agent", fixture.actingAgentId, "private parent");
  const privateThread = await getOrCreateThread(privateParent.id, fixture.actingAgentId, "agent");
  const privateThreadPending = await insertPendingMention(fixture, { channelId: privateThread.id });
  let deliveryCalls = 0;
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: () => Promise<{ status: "queued"; reason: "replayable_inbox" }>;
  };
  agentOrchestrator.deliverMessage = async () => {
    deliveryCalls += 1;
    return { status: "queued", reason: "replayable_inbox" };
  };

  const res = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "notify", resolutionIds: [privateThreadPending.mention.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<{ status: string; reason?: string }> };
  assert.equal(body.results[0]?.status, "no_permission");
  assert.equal(body.results[0]?.reason, "target_lacks_read_access");
  assert.equal(deliveryCalls, 0, "private-thread notify must not hand message content to a non-member agent");
});

test("agent-api mention notify keeps typed drops and handoff failures pending", async ({ app }) => {
  const fixture = await seedFixture();
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (
      agentId: string,
      message: { message_id?: string },
    ) => Promise<{ status: "queued" | "dropped"; reason: string }>;
  };
  const cases = [
    { internalReason: "agent_unavailable", publicReason: "target_not_queued" },
    { internalReason: "passive_scope_revoked", publicReason: "target_not_queued" },
    { internalReason: "target_access_changed", publicReason: "target_not_queued" },
    { internalReason: "cross_replica_receipt_unavailable", publicReason: "delivery_unavailable" },
    { internalReason: "throw", publicReason: "delivery_unavailable" },
  ] as const;

  for (const testCase of cases) {
    const pending = await insertPendingMention(fixture);
    let deliveryCalls = 0;
    agentOrchestrator.deliverMessage = async () => {
      deliveryCalls += 1;
      if (testCase.internalReason === "throw") {
        throw new Error("injected mention delivery failure");
      }
      return { status: "dropped", reason: testCase.internalReason };
    };

    const res = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
      method: "POST",
      headers: jsonHeaders(fixture.actingAgentKey),
      body: JSON.stringify({ action: "notify", resolutionIds: [pending.mention.id] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { results: Array<{ status: string; reason?: string }> };
    assert.equal(body.results[0]?.status, "dropped");
    assert.equal(
      body.results[0]?.reason,
      testCase.publicReason,
      `internal ${testCase.internalReason} must collapse to the privacy-safe public reason`,
    );
    assert.equal(deliveryCalls, 1);

    const [row] = await getDb()
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.id, pending.mention.id));
    assert.equal(row?.notifiedAt, null);
    assert.equal(row?.notifiedAction, null);
    assert.equal(row?.notifiedByType, null);
    assert.equal(row?.notifiedById, null);
    const droppedFacts = await getDb()
      .select({ messageId: inboxNotificationFacts.messageId })
      .from(inboxNotificationFacts)
      .where(and(
        eq(inboxNotificationFacts.receiverType, "agent"),
        eq(inboxNotificationFacts.receiverId, fixture.targetAgentId),
        eq(inboxNotificationFacts.messageId, pending.message.id),
      ));
    assert.deepEqual(droppedFacts, []);

    const pendingRes = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/pending`, {
      headers: jsonHeaders(fixture.actingAgentKey),
    });
    assert.equal(pendingRes.status, 200);
    const pendingBody = await pendingRes.json() as {
      pendingMentionActions: Array<{ resolutionId: string }>;
    };
    assert.equal(
      pendingBody.pendingMentionActions.some((action) => action.resolutionId === pending.mention.id),
      true,
      `failed ${testCase.internalReason} notify must remain retryable`,
    );
  }
});

test("agent-api mention-actions add requires human member authority for agent senders", async ({ app }) => {
  const fixture = await seedFixture();
  const first = await insertPendingMention(fixture);
  const second = await insertPendingMention(fixture);

  const res = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "add", resolutionIds: [first.mention.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<{ status: string; reason?: string; dedupedResolutionIds?: string[] }> };
  assert.equal(body.results[0]?.status, "no_permission");
  assert.equal(body.results[0]?.reason, "add_requires_human_member_authority");
  assert.equal(body.results[0]?.dedupedResolutionIds, undefined);

  const membership = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, fixture.channelId), eq(channelAgents.agentId, fixture.targetAgentId)));
  assert.equal(membership.length, 0);
  const rows = await getDb()
    .select({ id: messageMentions.id, notifiedAt: messageMentions.notifiedAt, notifiedAction: messageMentions.notifiedAction })
    .from(messageMentions)
    .where(eq(messageMentions.targetId, fixture.targetAgentId));
  assert.deepEqual(rows.map((row) => [row.id, row.notifiedAt, row.notifiedAction]).sort(), [
    [first.mention.id, null, null],
    [second.mention.id, null, null],
  ].sort());
});

test("agent-api mention-actions add after notify-only keeps notify-only rows unchanged", async ({ app }) => {
  const fixture = await seedFixture();
  const first = await insertPendingMention(fixture);
  const second = await insertPendingMention(fixture);
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: () => Promise<{ status: "queued"; reason: "replayable_inbox" }>;
  };
  agentOrchestrator.deliverMessage = async () => ({ status: "queued", reason: "replayable_inbox" });

  const notify = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "notify", resolutionIds: [first.mention.id] }),
  });
  assert.equal(notify.status, 200);
  const notifyBody = await notify.json() as { results: Array<{ status: string; dedupedResolutionIds: string[] }> };
  assert.equal(notifyBody.results[0]?.status, "queued");
  assert.deepEqual(notifyBody.results[0]?.dedupedResolutionIds.sort(), [first.mention.id, second.mention.id].sort());

  const add = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "add", resolutionIds: [first.mention.id] }),
  });
  assert.equal(add.status, 200);
  const addBody = await add.json() as { results: Array<{ status: string; reason?: string; dedupedResolutionIds?: string[] }> };
  assert.equal(addBody.results[0]?.status, "no_permission");
  assert.equal(addBody.results[0]?.reason, "add_requires_human_member_authority");
  assert.equal(addBody.results[0]?.dedupedResolutionIds, undefined);

  const membership = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, fixture.channelId), eq(channelAgents.agentId, fixture.targetAgentId)));
  assert.equal(membership.length, 0);
  const rows = await getDb()
    .select({ id: messageMentions.id, notifiedAction: messageMentions.notifiedAction })
    .from(messageMentions)
    .where(eq(messageMentions.targetId, fixture.targetAgentId));
  assert.deepEqual(rows.map((row) => [row.id, row.notifiedAction]).sort(), [
    [first.mention.id, "notify_only"],
    [second.mention.id, "notify_only"],
  ].sort());
});

test("agent-api mention-actions execute revalidates sender channel access", async ({ app }) => {
  const fixture = await seedFixture();
  const pending = await insertPendingMention(fixture);
  await getDb()
    .delete(channelAgents)
    .where(and(eq(channelAgents.channelId, fixture.channelId), eq(channelAgents.agentId, fixture.actingAgentId)));

  const res = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "add", resolutionIds: [pending.mention.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<{ status: string; reason?: string }> };
  assert.equal(body.results[0]?.status, "no_permission");
  assert.equal(body.results[0]?.reason, "sender_lacks_channel_access");

  const [row] = await getDb()
    .select()
    .from(messageMentions)
    .where(eq(messageMentions.id, pending.mention.id));
  assert.equal(row?.notifiedAt, null);
  const targetMembership = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, fixture.channelId), eq(channelAgents.agentId, fixture.targetAgentId)));
  assert.equal(targetMembership.length, 0);
});

test("agent-api mention-actions delete cascades pending resolutions before execute", async ({ app }) => {
  const fixture = await seedFixture();
  const pending = await insertPendingMention(fixture);

  await getDb().delete(messages).where(eq(messages.id, pending.message.id));

  const pendingAfterDelete = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/pending`, {
    headers: jsonHeaders(fixture.actingAgentKey),
  });
  assert.equal(pendingAfterDelete.status, 200);
  const pendingAfterDeleteBody = await pendingAfterDelete.json() as {
    pendingMentionActions: Array<{ resolutionId: string }>;
  };
  assert.equal(
    pendingAfterDeleteBody.pendingMentionActions.some((action) => action.resolutionId === pending.mention.id),
    false,
    "deleted messages must cascade their pending mention resolution rows out of sender actions",
  );

  const executeDeleted = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "add", resolutionIds: [pending.mention.id] }),
  });
  assert.equal(executeDeleted.status, 200);
  const executeDeletedBody = await executeDeleted.json() as { results: Array<{ status: string }> };
  assert.equal(executeDeletedBody.results[0]?.status, "not_found");

  const membership = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, fixture.channelId), eq(channelAgents.agentId, fixture.targetAgentId)));
  assert.equal(membership.length, 0, "executing a cascaded resolution must not add membership");
});

test("agent-api mention-actions execute returns typed fail-closed per-id statuses", async ({ app }) => {
  const fixture = await seedFixture();
  const stale = await insertPendingMention(fixture);
  await addAgent(fixture.channelId, fixture.targetAgentId);
  const expired = await insertPendingMention(fixture, { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
  const privatePending = await insertPendingMention(fixture, { channelId: fixture.privateChannelId });
  const ambiguousA = await insertPendingMention(fixture, { id: "aaaaaaaa-0000-4000-8000-000000000001" });
  await insertPendingMention(fixture, { id: "aaaaaaaa-0000-4000-8000-000000000002" });
  const humanPending = await insertPendingMention(fixture, { targetType: "user", targetId: fixture.targetUserId });

  const notifyRes = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({
      action: "notify",
      resolutionIds: [
        stale.mention.id,
        expired.mention.id,
        privatePending.mention.id,
        randomUUID(),
        ambiguousA.mention.id.slice(0, 8),
      ],
    }),
  });
  assert.equal(notifyRes.status, 200);
  const body = await notifyRes.json() as { results: Array<{ resolutionId: string; status: string; reason?: string }> };
  assert.deepEqual(body.results.map((result) => result.status), [
    "stale",
    "expired",
    "no_permission",
    "not_found",
    "ambiguous",
  ]);
  assert.equal(body.results[0]?.reason, "target_already_member");
  assert.equal(body.results[2]?.reason, "target_lacks_read_access");

  const addHuman = await fetch(`${app.baseUrl}/internal/agent-api/mention-actions/execute`, {
    method: "POST",
    headers: jsonHeaders(fixture.actingAgentKey),
    body: JSON.stringify({ action: "add", resolutionIds: [humanPending.mention.id] }),
  });
  assert.equal(addHuman.status, 200);
  const addHumanBody = await addHuman.json() as { results: Array<{ status: string; reason?: string }> };
  assert.equal(addHumanBody.results[0]?.status, "no_permission");
  assert.equal(addHumanBody.results[0]?.reason, "add_requires_human_member_authority");
});
