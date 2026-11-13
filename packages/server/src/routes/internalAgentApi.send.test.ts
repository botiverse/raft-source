import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import { desc, eq, sql } from "drizzle-orm";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  BasicTracer,
  channelCardRev,
  InMemoryFailpointRegistry,
  MemoryTraceSink,
  hasAgentMessageIdentity,
  type AgentMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents as agentsTable, attachments, attestedSendEvents, channelAgents, channels, jointChannels, jointChannelServers, machines as machinesTable, messageMentions, messages, serverAgentMembers, serverMembers, servers as serversTable, threadFollows, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { autoAssignMachine, createAgent } from "../services/agentService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { createChannel, addAgent, addHuman, markAgentLegacyRead, getAgentLegacyReadCursor, getAgentUnreadCounts, getOrCreateThread, findOrCreateDM, isChannelAgent, removeAgent, listThreadChannelIdsForParentChannel, setInboxTargetActivityMuteState } from "../services/channelService";
import { broadcastAndDeliver, createMessage, __resetMessageServiceDepsForTests, __setExternalAgentInboxChainSelectorForTests, __setMessageServiceDepsForTests } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";
import * as attestedSendService from "../services/attestedSendService";
import * as taskService from "../services/taskService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { withChannelDelivery } from "../test/orchestratorStub";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Fixture = {
  serverId: string;
  channelId: string;
  channelName: string;
  agentId: string;
  agentName: string;
  ownerId: string;
  ownerName: string;
  agentApiKey: string;
};

const originalAttestedSendMode = process.env.SLOCK_ATTESTED_SEND_MODE;

beforeEach(() => {
  process.env.SLOCK_ATTESTED_SEND_MODE = "force";
});

afterEach(() => {
  attestedSendService.__resetAttestedSendStateForTest();
  __resetFailpointsForTests();
  __resetMessageServiceDepsForTests();
  if (originalAttestedSendMode === undefined) {
    delete process.env.SLOCK_ATTESTED_SEND_MODE;
  } else {
    process.env.SLOCK_ATTESTED_SEND_MODE = originalAttestedSendMode;
  }
});

function agentHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function seedFixture(): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-api-send-${suffix}@slock.test`,
    name: `agent-api-send-${suffix}`,
    displayName: "Agent API Send Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer("Agent API Send Test", `agent-api-send-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "AgentApiSendBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "agent-api-send-room");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "agent-api-send-test",
    issuedVia: "computer",
    createdByUserId: null,
  });

  return {
    serverId: server.id,
    channelId: channel.id,
    channelName: channel.name,
    agentId: agent.id,
    agentName: agent.name,
    ownerId: owner.id,
    ownerName: owner.name,
    agentApiKey: minted.apiKey,
  };
}

async function sendHumanMessage(fixture: Fixture, content: string) {
  const message = await createMessage(fixture.channelId, "user", fixture.ownerId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: fixture.agentId,
    serverId: fixture.serverId,
    kind: "channel",
    sourceChannelId: fixture.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
  return message;
}

async function sendAgentMessage(fixture: Fixture, content: string) {
  const message = await createMessage(fixture.channelId, "agent", fixture.agentId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: fixture.agentId,
    serverId: fixture.serverId,
    kind: "channel",
    sourceChannelId: fixture.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: false,
  }]);
  return message;
}

async function sendHumanMentionMessage(fixture: Fixture, content: string) {
  const message = await createMessage(fixture.channelId, "user", fixture.ownerId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: fixture.agentId,
    serverId: fixture.serverId,
    kind: "channel",
    sourceChannelId: fixture.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: true,
    unreadEligible: true,
  }]);
  await getDb().insert(messageMentions).values({
    messageId: message.id,
    messageSeq: message.seq,
    serverId: fixture.serverId,
    channelId: fixture.channelId,
    targetType: "agent",
    targetId: fixture.agentId,
    handleAtSendTime: fixture.agentName,
    notifiableAtSend: true,
  });
  return message;
}

async function sendViaAgentApi(baseUrl: string, fixture: Fixture, body: Record<string, unknown>, apiKey = fixture.agentApiKey) {
  const res = await fetch(`${baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: agentHeaders(apiKey),
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json() as any,
  };
}

async function sendViaAgentApiV2(baseUrl: string, fixture: Fixture, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/v2/send`, {
    method: "POST",
    headers: agentHeaders(fixture.agentApiKey),
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json() as any,
  };
}

type EmittedEvent = { room: string; event: string; payload: any };

function installFakeIo(app: { app: { set(key: string, value: unknown): void } }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  app.app.set("io", {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
  });
  return events;
}

async function getMessageChannel(messageId: string) {
  const [row] = await getDb()
    .select({
      messageId: messages.id,
      seq: messages.seq,
      channelId: messages.channelId,
      channelType: channels.type,
      content: messages.content,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, messageId))
    .limit(1);
  return row;
}

async function latestChannelMessages(channelId: string, limit = 10) {
  return getDb()
    .select({ id: messages.id, seq: messages.seq, content: messages.content })
    .from(messages)
    .where(eq(messages.channelId, channelId))
    .orderBy(desc(messages.seq))
    .limit(limit);
}

test("agent-api v2 binds typed mentions while v1 keeps its existing raw-handle behavior", async ({ app }) => {
    const fixture = await seedFixture();
    const db = getDb();
    const suffix = randomUUID();
    const [sameHandleHuman] = await db.insert(users).values({
      email: `same-handle-${suffix}@slock.test`,
      name: "same_handle",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    }).returning();
    await db.insert(serverMembers).values({
      serverId: fixture.serverId,
      userId: sameHandleHuman.id,
      role: "member",
    });
    const sameHandleAgent = await createAgent(fixture.serverId, "same_handle", {
      runtime: "claude",
      model: "sonnet",
    });

    const v1 = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "v1 @same_handle",
      mentions: [{ type: "agent", id: sameHandleAgent.id, name: "same_handle" }],
    });
    assert.equal(v1.status, 200);
    assert.equal(v1.body.state, "sent");
    assert.equal(Object.hasOwn(v1.body, "unresolvedMentionHandles"), false);
    assert.deepEqual(
      (await db.select().from(messageMentions).where(eq(messageMentions.messageId, v1.body.messageId)))
        .map(({ targetType, targetId }) => ({ targetType, targetId }))
        .sort((left, right) => left.targetType.localeCompare(right.targetType)),
      [
        { targetType: "agent", targetId: sameHandleAgent.id },
        { targetType: "user", targetId: sameHandleHuman.id },
      ],
      "v1 must keep ignoring unknown request fields and resolve every exact raw-handle match",
    );

    const ambiguous = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "hello @same_handle",
      idempotencyKey: "raw-same-handle",
    });
    assert.equal(ambiguous.status, 200);
    assert.equal(ambiguous.body.state, "sent");
    assert.deepEqual(ambiguous.body.unresolvedMentionHandles, ["@same_handle"]);
    assert.equal(
      (await db.select().from(messageMentions).where(eq(messageMentions.messageId, ambiguous.body.messageId))).length,
      0,
    );

    const humanSelected = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "human @same_handle",
      mentions: [{ type: "user", id: sameHandleHuman.id, name: "same_handle" }],
      idempotencyKey: "typed-same-handle-human",
    });
    const agentSelected = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent @same_handle",
      mentions: [{ type: "agent", id: sameHandleAgent.id, name: "same_handle" }],
      idempotencyKey: "typed-same-handle-agent",
    });
    assert.equal(humanSelected.status, 200);
    assert.equal(agentSelected.status, 200);

    const mentionRows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, fixture.channelId));
    assert.deepEqual(
      mentionRows
        .filter((row) => row.messageId !== v1.body.messageId)
        .map(({ targetType, targetId }) => ({ targetType, targetId }))
        .sort((left, right) => left.targetType.localeCompare(right.targetType)),
      [
        { targetType: "agent", targetId: sameHandleAgent.id },
        { targetType: "user", targetId: sameHandleHuman.id },
      ],
    );

    const conflict = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "conflict @same_handle",
      mentions: [
        { type: "user", id: sameHandleHuman.id, name: "same_handle" },
        { type: "agent", id: sameHandleAgent.id, name: "same_handle" },
      ],
      idempotencyKey: "typed-same-handle-conflict",
    });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.code, "mention_binding_conflict");
    assert.equal((await latestChannelMessages(fixture.channelId)).length, 4);
});

test("agent-api v2 idempotent replay reads the original durable mention facts after rename", async ({ app }) => {
    const emitted = installFakeIo(app);
    const fixture = await seedFixture();
    const db = getDb();
    const request = {
      target: `#${fixture.channelName}`,
      content: `self mention @${fixture.agentName}`,
      mentions: [{ type: "agent", id: fixture.agentId, name: fixture.agentName }],
      idempotencyKey: "v2-durable-mention-replay",
    };

    const first = await sendViaAgentApiV2(app.baseUrl, fixture, request);
    assert.equal(first.status, 200);
    assert.equal(first.body.state, "sent");
    const originalFacts = await db
      .select({ targetType: messageMentions.targetType, targetId: messageMentions.targetId })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, first.body.messageId));
    assert.deepEqual(originalFacts, [{ targetType: "agent", targetId: fixture.agentId }]);

    await db.update(agentsTable).set({ name: "renamed_after_send" }).where(eq(agentsTable.id, fixture.agentId));
    emitted.length = 0;
    const replay = await sendViaAgentApiV2(app.baseUrl, fixture, request);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.messageId, first.body.messageId);
    assert.equal(Object.hasOwn(replay.body, "unresolvedMentionHandles"), false);
    assert.equal((await latestChannelMessages(fixture.channelId)).length, 1);
    const replayPayload = emitted.find((event) => (
      event.event === "message:new"
      && event.room === `channel:${fixture.channelId}`
      && event.payload?.id === first.body.messageId
    ))?.payload;
    assert.ok(replayPayload, "idempotent replay must emit the persisted message projection");
    assert.deepEqual(
      replayPayload.mentions.map((mention: { type: string; id: string }) => ({
        type: mention.type,
        id: mention.id,
      })),
      [{ type: "agent", id: fixture.agentId }],
      "replay consumers must receive the original durable mention after the actor is renamed",
    );
    assert.deepEqual(
      await db
        .select({ targetType: messageMentions.targetType, targetId: messageMentions.targetId })
        .from(messageMentions)
        .where(eq(messageMentions.messageId, first.body.messageId)),
      originalFacts,
    );
});

test("agent-api v2 authoritatively reconciles an idempotency key without writing", async ({ app }) => {
    const fixture = await seedFixture();
    const target = `#${fixture.channelName}`;
    const idempotencyKey = `reconcile-${randomUUID()}`;

    const before = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target,
      idempotencyKey,
      reconcileOnly: true,
    });
    assert.deepEqual(before, {
      status: 200,
      body: { ok: true, state: "not_found", reconciliation: true },
    });
    assert.equal((await latestChannelMessages(fixture.channelId)).length, 0);

    const sent = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target,
      content: "commit once @missing_handle",
      idempotencyKey,
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.deepEqual(sent.body.unresolvedMentionHandles, ["@missing_handle"]);

    const after = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target,
      idempotencyKey,
      reconcileOnly: true,
    });
    assert.equal(after.status, 200);
    assert.equal(after.body.state, "committed");
    assert.equal(after.body.messageId, sent.body.messageId);
    assert.equal(after.body.messageSeq, sent.body.messageSeq);
    assert.equal(after.body.reconciliation, true);
    assert.equal(after.body.receiptComplete, false);
    assert.equal(Object.hasOwn(after.body, "unresolvedMentionHandles"), false);
    assert.equal((await latestChannelMessages(fixture.channelId)).length, 1);
});

test("agent-api idempotent replay returns the original only when target, content and attachments match", async ({ app }) => {
    const fixture = await seedFixture();
    const otherChannel = await createChannel(fixture.serverId, "agent-api-send-other-room");
    await addAgent(otherChannel.id, fixture.agentId);
    const request = {
      target: `#${fixture.channelName}`,
      content: "exactly once",
      idempotencyKey: `replay-${randomUUID()}`,
    };

    for (const send of [sendViaAgentApi, sendViaAgentApiV2]) {
      const key = `${request.idempotencyKey}-${send.name}`;
      const first = await send(app.baseUrl, fixture, { ...request, idempotencyKey: key });
      assert.equal(first.status, 200);
      assert.equal(first.body.state, "sent");

      const identical = await send(app.baseUrl, fixture, { ...request, idempotencyKey: key });
      assert.equal(identical.status, 200, "an identical replay stays a success");
      assert.equal(identical.body.state, "sent");
      assert.equal(identical.body.messageId, first.body.messageId);
      assert.equal(identical.body.messageSeq, first.body.messageSeq);

      const otherContent = await send(app.baseUrl, fixture, { ...request, idempotencyKey: key, content: "something else" });
      assert.equal(otherContent.status, 409);
      assert.equal(otherContent.body.code, "idempotency_key_reused");
      assert.equal(otherContent.body.mismatch, "content");
      assert.match(otherContent.body.suggestedNextAction, /new idempotencyKey/);
      assert.equal(Object.hasOwn(otherContent.body, "messageId"), false, "must not report the original as this send");

      const otherTarget = await send(app.baseUrl, fixture, { ...request, idempotencyKey: key, target: `#${otherChannel.name}` });
      assert.equal(otherTarget.status, 409);
      assert.equal(otherTarget.body.code, "idempotency_key_reused");
      assert.equal(otherTarget.body.mismatch, "target");
    }

    // A different ordered attachment set is the same conflict.
    const holder = await sendHumanMessage(fixture, "holds an attachment");
    const [attachment] = await insertAttachmentsWithObjects(getDb(), {
      messageId: holder.id,
      channelId: fixture.channelId,
      uploaderId: fixture.agentId,
      uploaderType: "agent",
      filename: "replay.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      storageKey: `${fixture.serverId}/replay.txt`,
    });
    const otherAttachments = await sendViaAgentApi(app.baseUrl, fixture, {
      ...request,
      idempotencyKey: `${request.idempotencyKey}-sendViaAgentApi`,
      attachmentIds: [attachment.id],
      seenUpToSeq: holder.seq,
    });
    assert.equal(otherAttachments.status, 409, JSON.stringify(otherAttachments.body));
    assert.equal(otherAttachments.body.code, "idempotency_key_reused");
    assert.equal(otherAttachments.body.mismatch, "attachments");

    const persisted = [
      ...await latestChannelMessages(fixture.channelId),
      ...await latestChannelMessages(otherChannel.id),
    ];
    assert.equal(persisted.filter((message) => message.content === "exactly once").length, 2, "one message per key");
    assert.equal(persisted.some((message) => message.content === "something else"), false);
});

test("agent-api send rejects malformed attachment ids with a 400 instead of a database 500", async ({ app }) => {
  // Agents wrote `--attachment-id "id1 id2"`; the joined value reached a uuid
  // column and the send failed as 500 (Postgres 22P02, task #20).
  const fixture = await seedFixture();
  const parent = await sendHumanMessage(fixture, "parent before malformed attachments");
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const cases = [
    { send: sendViaAgentApi, ids: [`${first} ${second}`], key: undefined, entry: 1 },
    { send: sendViaAgentApi, ids: [`${first},${second}`], key: "malformed-attachment-replay", entry: 1 },
    { send: sendViaAgentApiV2, ids: [first, "not-an-id"], key: undefined, entry: 2 },
  ];
  for (const [index, { send, ids, key, entry }] of cases.entries()) {
    const res = await send(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: `malformed attachment ${index}`,
      attachmentIds: ids,
      seenUpToSeq: parent.seq,
      ...(key ? { idempotencyKey: key } : {}),
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "attachment_id_invalid");
    assert.ok(res.body.error.startsWith(`Not sent: attachmentIds entry ${entry} is not a single attachment ID.`), res.body.error);
    assert.match(res.body.error, /one ID per --attachment-id/);
    assert.equal(JSON.stringify(res.body).includes(first), false, "the rejected value is not echoed");
  }
  const persisted = await latestChannelMessages(fixture.channelId);
  assert.equal(persisted.some((message) => message.content.startsWith("malformed attachment")), false);
});

test("agent-api first reply to a fresh channel thread creates the thread and sends", async ({ app }) => {
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "fresh thread parent");
    const threadTarget = `#${fixture.channelName}:${parent.id.slice(0, 8)}`;

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: threadTarget,
      content: "agent-api first thread reply",
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.ok(sent.body.messageId);

    const sentMessage = await getMessageChannel(sent.body.messageId);
    assert.ok(sentMessage, "expected sent message to be persisted");
    assert.equal(sent.body.messageSeq, sentMessage.seq);
    assert.equal(sentMessage.content, "agent-api first thread reply");
    assert.equal(sentMessage.channelType, "thread");
    assert.notEqual(sentMessage.channelId, fixture.channelId);
});

test("agent-api reply accepts a threadId suffix and lands on that thread's parent", async ({ app }) => {
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "threadId-target parent");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    // The `threadId=` header field is the first 8 chars of the thread channel's
    // UUID — NOT the parent message's short id. Using it as the send suffix must
    // land on the thread it names (and must not create a second thread).
    const threadTarget = `#${fixture.channelName}:${thread.id.slice(0, 8)}`;

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: threadTarget,
      content: "agent-api reply via threadId target",
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.ok(sent.body.messageId);

    const sentMessage = await getMessageChannel(sent.body.messageId);
    assert.ok(sentMessage, "expected sent message to be persisted");
    assert.equal(sentMessage.channelId, thread.id, "the reply must land on the thread the threadId names");
    assert.equal(sentMessage.content, "agent-api reply via threadId target");
});

test("agent-api reply to a system-message thread does not treat the system identity as a user UUID", async ({ app }) => {
    const fixture = await seedFixture();
    const parent = await createMessage(
      fixture.channelId,
      "user",
      "system",
      "system thread parent",
      "system",
    );
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    await getDb().insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: fixture.ownerId,
      parentMessageId: parent.id,
      reason: "manual",
    });
    const threadTarget = `#${fixture.channelName}:${parent.id.slice(0, 8)}`;

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: threadTarget,
      content: "agent-api reply to system thread",
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.ok(sent.body.messageId);

    const sentMessage = await getMessageChannel(sent.body.messageId);
    assert.equal(sentMessage?.channelType, "thread");
    assert.equal(sentMessage?.content, "agent-api reply to system thread");
    const follows = await getDb()
      .select({ followerType: threadFollows.followerType, followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(eq(threadFollows.threadChannelId, sentMessage!.channelId));
    assert.deepEqual(
      follows.sort((a, b) => a.followerType.localeCompare(b.followerType)),
      [
        { followerType: "agent", followerId: fixture.agentId },
        { followerType: "user", followerId: fixture.ownerId },
      ],
      "the pseudo user:system identity is excluded without dropping real thread followers",
    );
});

test("agent-api send checks the channel card only for a client that names the version it saw", async ({ app }) => {
    const fixture = await seedFixture();
    const target = `#${fixture.channelName}`;
    const card = { id: fixture.channelId, name: fixture.channelName, type: "channel", description: null, archived: false };

    // No `seenCards`: today's behavior.
    const plain = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "no card field" });
    assert.equal(plain.body.state, "sent");
    assert.equal(plain.body.channelCard, undefined);

    // Never seen in this context, and nothing unread: sent, with the card in the
    // reply (#wg-ax:#25). The card alone no longer holds the send.
    const before = await latestChannelMessages(fixture.channelId);
    const unseen = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target,
      content: "first post this context",
      seenUpToSeq: plain.body.messageSeq,
      seenCards: { channel: null },
    });
    assert.equal(unseen.status, 200);
    assert.equal(unseen.body.state, "sent");
    assert.equal(unseen.body.holdReasons, undefined);
    assert.deepEqual(unseen.body.channelCard, card);
    assert.equal(unseen.body.channelCardChanged, undefined);
    assert.equal((await latestChannelMessages(fixture.channelId)).length, before.length + 1);

    // The current version: sent, no card.
    const seen = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target,
      content: "card seen",
      seenUpToSeq: plain.body.messageSeq,
      seenCards: { channel: channelCardRev(card) },
    });
    assert.equal(seen.body.state, "sent");
    assert.equal(seen.body.channelCard, undefined);

    // An older version: sent, with the new card in the reply.
    await getDb().update(channels).set({ description: "Release coordination only." }).where(eq(channels.id, fixture.channelId));
    const changed = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target,
      content: "card changed since",
      seenUpToSeq: seen.body.messageSeq,
      seenCards: { channel: channelCardRev(card) },
    });
    assert.equal(changed.body.state, "sent");
    assert.deepEqual(changed.body.channelCard, { ...card, description: "Release coordination only." });
    assert.equal(changed.body.channelCardChanged, true);

    // A DM has no channel card.
    await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
    const dm = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `dm:@${fixture.ownerName}`,
      content: "dm",
      seenCards: { channel: null },
    });
    assert.equal(dm.body.state, "sent");
    assert.equal(dm.body.channelCard, undefined);
});

test("agent-api send accepts the card version a history read returned, for the channel and its threads", async ({ app }) => {
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "thread root");
    await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const read = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${fixture.channelName}`)}&consume=false`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    const readBody = await read.json() as { channel_card: Parameters<typeof channelCardRev>[0] };
    const rev = channelCardRev(readBody.channel_card);

    const threadTarget = `#${fixture.channelName}:${parent.id.slice(0, 8)}`;
    const unseen = await sendViaAgentApiV2(app.baseUrl, fixture, { target: threadTarget, content: "in thread", seenUpToSeq: parent.seq, seenCards: { channel: null } });
    assert.equal(unseen.body.state, "sent", "the card alone no longer holds the send");
    assert.equal(unseen.body.channelCard?.id, fixture.channelId, "a thread carries its parent channel's card");

    const seen = await sendViaAgentApiV2(app.baseUrl, fixture, { target: threadTarget, content: "in thread", seenUpToSeq: parent.seq, seenCards: { channel: rev } });
    assert.equal(seen.body.state, "sent");
    assert.equal(seen.body.channelCard, undefined);
});

test("agent-api send: --anyway, an idempotent retry and reviewer isolation are not held for the card", async ({ app }) => {
    const fixture = await seedFixture();
    const target = `#${fixture.channelName}`;

    const anyway = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target, content: "anyway", sendDraft: true, continueAnyway: true, seenCards: { channel: null },
    });
    assert.equal(anyway.body.state, "sent");
    assert.equal(anyway.body.channelCard?.id, fixture.channelId, "the unseen card still comes back with the reply");
    assert.equal(anyway.body.channelCardChanged, undefined);

    const key = randomUUID();
    const original = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "once", idempotencyKey: key, seenUpToSeq: anyway.body.messageSeq });
    assert.equal(original.body.state, "sent");
    const retry = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target, content: "once", idempotencyKey: key, seenUpToSeq: anyway.body.messageSeq, seenCards: { channel: null },
    });
    assert.equal(retry.body.state, "sent", "a retry of a committed send replays its receipt instead of holding");
    assert.equal(retry.body.messageId, original.body.messageId);

    const isolated = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target, content: "isolated", freshnessContextMode: "withheld", seenUpToSeq: original.body.messageSeq, seenCards: { channel: null },
    });
    assert.equal(isolated.body.state, "sent");
    assert.equal(isolated.body.channelCard, undefined);
});

test("agent-api DM reads carry the peer's card, and a DM send names the version it saw", async ({ app }) => {
    const fixture = await seedFixture();
    const dm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
    assert.ok(dm);
    const target = `dm:@${fixture.ownerName}`;

    // Nothing to show (no description, no zone): no card, and no hold for it.
    const empty = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "hi", seenCards: { peer: null } });
    assert.equal(empty.body.state, "sent");
    assert.equal(empty.body.peerCard, undefined);

    await getDb().update(users).set({ description: "Founder. Prefers short updates." }).where(eq(users.id, fixture.ownerId));
    const root = await createMessage(dm.id, "user", fixture.ownerId, "from Shanghai", "chat", undefined, { senderTimezone: "Asia/Shanghai" });
    const card = { kind: "human", name: fixture.ownerName, description: "Founder. Prefers short updates.", timezone: "Asia/Shanghai" };

    const read = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}&consume=false`, { headers: agentHeaders(fixture.agentApiKey) });
    const readBody = await read.json() as { peer_card?: unknown; channel_card?: unknown };
    assert.deepEqual(readBody.peer_card, card);
    assert.equal(readBody.channel_card, undefined, "a DM has no channel card");

    const unseen = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "reply", seenUpToSeq: root.seq, seenCards: { peer: null } });
    assert.equal(unseen.body.state, "held");
    assert.deepEqual(unseen.body.holdReasons, ["peer_card"]);
    assert.deepEqual(unseen.body.peerCard, card);

    const seen = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "reply", seenUpToSeq: root.seq, seenCards: { peer: "v-any" } });
    assert.equal(seen.body.state, "sent");
    assert.equal(seen.body.peerCard, undefined);

    // The peer travels: any version this context has counts as seen (their
    // next message shows the new zone); no hold, nothing attached.
    const moved = await createMessage(dm.id, "user", fixture.ownerId, "now in Berlin", "chat", undefined, { senderTimezone: "Europe/Berlin" });
    const travelled = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "ok", seenUpToSeq: moved.seq, seenCards: { peer: "v-from-shanghai" } });
    assert.equal(travelled.body.state, "sent");
    assert.equal(travelled.body.peerCard, undefined);

    // A thread in the DM carries the DM's peer, on read and on send.
    await getOrCreateThread(moved.id, fixture.ownerId, "user");
    const threadTarget = `${target}:${moved.id.slice(0, 8)}`;
    const threadRead = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(threadTarget)}&consume=false`, { headers: agentHeaders(fixture.agentApiKey) });
    assert.deepEqual(((await threadRead.json()) as { peer_card?: unknown }).peer_card, { ...card, timezone: "Europe/Berlin" });
    const threadSend = await sendViaAgentApiV2(app.baseUrl, fixture, { target: threadTarget, content: "in thread", seenUpToSeq: moved.seq, seenCards: { peer: null } });
    assert.equal(threadSend.body.state, "held");
    assert.deepEqual(threadSend.body.holdReasons, ["peer_card"]);
});

test("agent-api send holds unread messages and an unseen channel card in one hold", async ({ app }) => {
    const fixture = await seedFixture();
    const target = `#${fixture.channelName}`;
    const first = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "before" });
    await sendHumanMessage(fixture, "news the agent has not seen");

    const held = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target,
      content: "reply",
      seenUpToSeq: first.body.messageSeq,
      seenCards: { channel: null },
    });
    assert.equal(held.body.state, "held");
    assert.deepEqual(held.body.holdReasons, ["unread_messages", "channel_card"]);
    assert.equal(held.body.newMessageCount, 1);
    assert.equal(held.body.channelCard?.id, fixture.channelId);
    assert.equal(held.body.heldMessages?.[0]?.content, "news the agent has not seen");
});

test("freshness looks for the latest message only after the seen boundary; the hold, its context and the pass are unchanged", async ({ app }) => {
    const fixture = await seedFixture();
    const target = `#${fixture.channelName}`;
    const human = await sendHumanMessage(fixture, "the one message someone else wrote");
    // The agent writes most of the channel (#proj-o11y:#24).
    let mine = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "own 1", seenUpToSeq: human.seq });
    for (const n of [2, 3, 4]) mine = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: `own ${n}`, seenUpToSeq: mine.body.messageSeq });
    assert.equal(mine.body.state, "sent");

    // Only its own messages after the boundary: sent, as before.
    const ownOnly = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "own only after", seenUpToSeq: human.seq });
    assert.equal(ownOnly.body.state, "sent");

    // A boundary past every message (a client overstating it): sent, as before (min(boundary, latest) passed).
    const overstated = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "overstated", seenUpToSeq: ownOnly.body.messageSeq + 1_000 });
    assert.equal(overstated.body.state, "sent");
    // Far beyond bigint (1e21 serializes as "1e+21"): still a pass, not a database error.
    const absurd = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "absurd boundary", seenUpToSeq: 1e21 });
    assert.equal(absurd.status, 200);
    assert.equal(absurd.body.state, "sent");

    // Someone else wrote after the boundary: held with that message, as before.
    await sendHumanMessage(fixture, "news after the boundary");
    const held = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "reply", seenUpToSeq: absurd.body.messageSeq });
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 1);
    assert.equal(held.body.heldMessages?.[0]?.content, "news after the boundary");

    // No boundary in the request: the unbounded search, held on the first message someone else wrote.
    const noBoundary = await sendViaAgentApiV2(app.baseUrl, fixture, { target, content: "no boundary" });
    assert.equal(noBoundary.body.state, "held");
    assert.equal(noBoundary.body.newMessageCount, 2);
});

/** The agent leaves the fixture channel and joins it again itself (`raft channel join`). */
async function selfJoinFixtureChannel(baseUrl: string, fixture: Fixture) {
  await removeAgent(fixture.channelId, fixture.agentId);
  const { apiKey } = await mintAgentCredential({
    agentId: fixture.agentId,
    scopes: ["send", "read", "channels"],
    name: "agent-api-send-join",
    issuedVia: "computer", createdByUserId: null,
  });
  const join = await fetch(`${baseUrl}/internal/agent-api/channels/${fixture.channelId}/join`, {
    method: "POST",
    headers: agentHeaders(apiKey),
  });
  assert.equal(join.status, 200, await join.clone().text());
}

test("agent-api channel first post returns recent-join drive-by attention once", async ({ app }) => {
    const fixture = await seedFixture();
    await selfJoinFixtureChannel(app.baseUrl, fixture);

    const first = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api first channel post",
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.state, "sent");
    assert.deepEqual(first.body.attention?.driveByJoinedToPost, {
      reason: "first_agent_message_with_recent_channel_join",
      muteCommand: `raft channel mute "#${fixture.channelName}"`,
      stillArrives: [
        "@mentions still reach you, and threads you started stay followed and keep delivering until you unfollow them.",
      ],
    });

    const second = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api second channel post",
      seenUpToSeq: first.body.messageSeq,
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.state, "sent");
    assert.equal(second.body.attention, undefined);
});

test("agent-api channel first post: no join tip for an agent someone else added (it never joined to post)", async ({ app }) => {
    // seedFixture adds the agent to the channel (as creating a channel with
    // it does): a recent membership, no self-join.
    const fixture = await seedFixture();

    const first = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "first post of a member added by its owner",
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.state, "sent");
    assert.equal(first.body.attention, undefined);
});

test("agent-api send returns sender-only pending mention actions on sent response", async ({ app }) => {
    const fixture = await seedFixture();
    const outsider = await createAgent(fixture.serverId, "AgentApiMentionOutsider", {
      runtime: "claude",
      model: "sonnet",
      avatarUrl: "pixel:random:AgentApiMentionOutsider",
    });

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: `please coordinate with @${outsider.name}`,
      seenUpToSeq: 0,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.ok(sent.body.messageId);
    assert.ok(Array.isArray(sent.body.pendingMentionActions));
    assert.equal(sent.body.pendingMentionActions.length, 1);
    assert.deepEqual(sent.body.pendingMentionActions[0], {
      resolutionId: sent.body.pendingMentionActions[0].resolutionId,
      messageId: sent.body.messageId,
      targetType: "agent",
      targetHandle: outsider.name,
      targetAvatarUrl: outsider.avatarUrl,
      reason: "not_member",
      availableActions: ["notify"],
      expiresAt: sent.body.pendingMentionActions[0].expiresAt,
    });
    assert.match(sent.body.pendingMentionActions[0].resolutionId, /^[0-9a-f-]{36}$/i);
    assert.match(sent.body.pendingMentionActions[0].expiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("agent-api send names the agents it was delivered to: muted members only when @mentioned, never the sender", async ({ app }) => {
    const fixture = await seedFixture();
    const listener = await createAgent(fixture.serverId, "AgentApiDeliveredListener", { runtime: "external", model: "external" });
    const muted = await createAgent(fixture.serverId, "AgentApiDeliveredMuted", { runtime: "external", model: "external" });
    await addAgent(fixture.channelId, listener.id);
    await addAgent(fixture.channelId, muted.id);
    await setInboxTargetActivityMuteState({
      receiverType: "agent",
      receiverId: muted.id,
      serverId: fixture.serverId,
      sourceChannelId: fixture.channelId,
      activityMuted: true,
    });

    const ordinary = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "an ordinary post",
      seenUpToSeq: 0,
    });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body.state, "sent");
    assert.deepEqual(ordinary.body.deliveredToAgents, [listener.name]);

    const mention = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: `@${muted.name} please take a look`,
      seenUpToSeq: ordinary.body.messageSeq,
    });
    assert.equal(mention.status, 200);
    assert.deepEqual(mention.body.deliveredToAgents, [listener.name, muted.name].sort((a, b) => a.localeCompare(b)));
});

test("agent-api send returns an empty deliveredToAgents when the message reaches no other agent", async ({ app }) => {
    const fixture = await seedFixture();

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "only the owner is here",
      seenUpToSeq: 0,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.deepEqual(sent.body.deliveredToAgents, []);
});

test("agent-api send cannot enumerate a hidden human directory through mention resolution", async ({ app }) => {
    const fixture = await seedFixture();
    const db = getDb();
    const suffix = randomUUID();
    const [hiddenHuman] = await db.insert(users).values({
      email: `agent-api-hidden-mention-${suffix}@slock.test`,
      name: `agent_api_hidden_mention_${suffix}`,
      displayName: "Agent API Hidden Mention",
      avatarUrl: "pixel:random:AgentApiHiddenMention",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    }).returning();
    await db.insert(serverMembers).values({
      serverId: fixture.serverId,
      userId: hiddenHuman.id,
      role: "member",
    });
    await db.update(serversTable)
      .set({ hideHumansFromMembers: true })
      .where(eq(serversTable.id, fixture.serverId));

    const hidden = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: `hidden human @${hiddenHuman.name}`,
      mentions: [{ type: "user", id: hiddenHuman.id, name: hiddenHuman.name }],
      seenUpToSeq: 0,
    });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.pendingMentionActions, undefined);
    assert.equal(hidden.body.unresolvedMentionHandles, undefined, "typed hidden ids must not disclose resolution state");
    assert.deepEqual(
      await db.select().from(messageMentions).where(eq(messageMentions.messageId, hidden.body.messageId)),
      [],
      "agent sends must not persist hidden-human mention facts",
    );

    const raw = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: `hidden human raw @${hiddenHuman.name}`,
      seenUpToSeq: hidden.body.messageSeq,
    });
    assert.equal(raw.status, 200);
    assert.equal(raw.body.pendingMentionActions, undefined);
    assert.deepEqual(raw.body.unresolvedMentionHandles, [`@${hiddenHuman.name}`]);

    // Credential auth binds an active agent, not its server membership row.
    // Keep the credential and channel membership live while removing only the
    // server membership: mention resolution must still fail closed under this
    // reachable integrity-drift shape.
    await db.delete(serverAgentMembers).where(eq(serverAgentMembers.agentId, fixture.agentId));
    const orphaned = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: `orphaned agent raw @${hiddenHuman.name}`,
      seenUpToSeq: raw.body.messageSeq,
    });
    assert.equal(orphaned.status, 200, "an active credential with channel membership still reaches send");
    assert.equal(orphaned.body.pendingMentionActions, undefined);
    assert.deepEqual(orphaned.body.unresolvedMentionHandles, [`@${hiddenHuman.name}`]);
    assert.deepEqual(
      await db.select().from(messageMentions).where(eq(messageMentions.messageId, orphaned.body.messageId)),
      [],
      "missing agent server membership must not reopen hidden-human mention resolution",
    );

    await db.update(agentsTable).set({ deletedAt: new Date() }).where(eq(agentsTable.id, fixture.agentId));
    const deleted = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: `deleted agent raw @${hiddenHuman.name}`,
      seenUpToSeq: orphaned.body.messageSeq,
    });
    assert.equal(deleted.status, 401, "soft-deleted agents must be rejected before send");
    assert.equal(deleted.body.error, "Invalid agent credential");
});

test("agent-api send returns authored mention handles that resolved to no visible target", async ({ app }) => {
    const fixture = await seedFixture();
    const sent = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "please coordinate with @DefinitelyMissingAgent",
      seenUpToSeq: 0,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.ok(sent.body.messageId);
    assert.equal(sent.body.pendingMentionActions, undefined);
    assert.deepEqual(sent.body.unresolvedMentionHandles, ["@DefinitelyMissingAgent"]);
});

test("agent-api send does not warn for literal @handles inside markdown code", async ({ app }) => {
    const fixture = await seedFixture();
    const sent = await sendViaAgentApiV2(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      // A fence opens only at the start of a line (as the web renders it).
      content: "external `@DefinitelyMissingAgent` and\n```txt\n@AnotherMissingAgent\n```",
      seenUpToSeq: 0,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.ok(sent.body.messageId);
    assert.equal(sent.body.pendingMentionActions, undefined);
    assert.equal(sent.body.unresolvedMentionHandles, undefined);
});

test("agent-api send records route breakdown trace events", async ({ app }) => {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "trace thread parent");
    const threadTarget = `#${fixture.channelName}:${parent.id.slice(0, 8)}`;

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: threadTarget,
      content: "agent-api trace reply",
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/internal/agent-api/send"
    );
    assert.ok(span, "expected POST /internal/agent-api/send root span");

    const eventNames = span.events
      .map((event) => event.name)
      .filter((name) => name !== "http.response.finished");
    for (const expected of [
      "agent_credential_auth.credential_lookup.finished",
      "agent_credential_auth.argon2_verify.finished",
      "agent_credential_auth.agent_lookup.finished",
      "agent_credential_auth.server_liveness.checked",
      "agent_credential_auth.agent_liveness.checked",
      "agent_api_send.request.started",
      "agent_api_send.agent.loaded",
      "agent_api_send.target.resolved",
      "agent_api_send.archive.checked",
      "agent_api_send.freshness.evaluated",
      "message_pipeline.channel.resolved",
      "message_pipeline.message.persisted",
      "message_pipeline.frontend_emitted",
      "message_pipeline.sender_read_scheduled",
      "message_pipeline.agent_delivery.scheduled",
      "agent_api_send.commit.finished",
      "response.ready",
    ]) {
      assert.ok(eventNames.includes(expected), `expected trace event ${expected}`);
    }

    const started = span.events.find((event) => event.name === "agent_api_send.request.started");
    assert.ok(started);
    assert.equal(started.attrs?.target_kind, "channel_thread");
    assert.equal(started.attrs?.attachment_count, 0);
    assert.equal(started.attrs?.client_kind, "absent", "no X-Raft-Client header in this test");
    assert.equal(started.attrs?.freshness_requested, true);
    assert.equal("target" in (started.attrs ?? {}), false);
    assert.equal("content" in (started.attrs ?? {}), false);

    const resolved = span.events.find((event) => event.name === "agent_api_send.target.resolved");
    assert.ok(resolved);
    assert.equal(resolved.attrs?.outcome, "resolved");
    assert.equal(resolved.attrs?.target_type, "thread");

    const freshness = span.events.find((event) => event.name === "agent_api_send.freshness.evaluated");
    assert.ok(freshness);
    assert.equal(freshness.attrs?.outcome, "passed");
    assert.equal(freshness.attrs?.boundary_source, "client_seen");
    assert.equal(freshness.attrs?.new_message_count, 0);

    const commit = span.events.find((event) => event.name === "agent_api_send.commit.finished");
    assert.ok(commit);
    assert.equal(commit.attrs?.target_type, "thread");
    assert.equal(commit.attrs?.message_seq_present, true);

    const persisted = span.events.find((event) => event.name === "message_pipeline.message.persisted");
    assert.ok(persisted);
    assert.equal(persisted.attrs?.target_type, "thread");
    assert.equal(persisted.attrs?.replayed, false);

    const insertSpan = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.db.query"
      && candidate.context.parentSpanId === span.context.spanId
      && candidate.attrs?.query_name === "messages.insert"
    );
    assert.ok(insertSpan, "expected request-linked messages.insert child span");
    assert.equal(insertSpan.attrs?.phase, "message_persist");
    assert.equal(insertSpan.attrs?.sender_type, "agent");
    assert.equal(insertSpan.attrs?.outcome, "success");
    assert.equal(JSON.stringify(insertSpan.attrs).includes("agent-api trace reply"), false);
    // 2026-09-21 teardown: serving-row projections are retired; the send
    // transaction's inbox work surfaces as the facts fan-out span event.
    assert.ok(insertSpan.events.some((event) => event.name === "send.facts_fanout.finished"));
    assert.equal(insertSpan.events.some((event) => event.name === "inbox.serving_row.increment"), false);
    assert.equal(insertSpan.events.some((event) => event.name === "inbox.serving_row.rebuild"), false);

    const dbPhase = insertSpan.events.find((event) =>
      event.name === "message_pipeline.db_phase.finished"
      && event.attrs?.query_name === "messages.direct_send_transaction"
    );
    assert.ok(dbPhase);
    assert.equal(dbPhase.attrs?.phase, "message_pipeline.persist");
    assert.equal(dbPhase.attrs?.query_name, "messages.direct_send_transaction");
    assert.equal(dbPhase.attrs?.db_operation, "transaction");
    assert.equal(dbPhase.attrs?.peer_service, "postgresql");

    const delivery = span.events.find((event) => event.name === "message_pipeline.agent_delivery.scheduled");
    assert.ok(delivery);
    assert.equal(delivery.attrs?.target_type, "thread");
    assert.equal(typeof delivery.attrs?.delivery_count, "number");
});

test("agent-api thread send records follower fallback inside its atomic persistence", async ({ app }) => {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "post-persist follower failure parent");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const content = "post-persist follower failure reply";
    const followerReadError = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    __setMessageServiceDepsForTests({
      getThreadFollowerCandidates: async () => { throw followerReadError; },
    });

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
      content,
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    const persisted = (await latestChannelMessages(thread.id)).filter((message) => message.content === content);
    assert.equal(persisted.length, 1, "a post-persist projection failure must not invite a duplicate-producing retry");
    assert.equal(persisted[0]?.id, sent.body.messageId);

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/internal/agent-api/send"
      && candidate.attrs?.status_code === 200
    );
    assert.ok(span);
    const persistedEvent = span.events.find((event) => event.name === "message_pipeline.message.persisted");
    const transactionEvents = sink.getAllSpans().filter(candidate => candidate.context.traceId === span.context.traceId).flatMap(candidate => candidate.events);
    const degraded = transactionEvents.filter((event) => event.name === "message_pipeline.post_persist_side_effect.degraded");
    assert.ok(persistedEvent);
    assert.equal(degraded.length, 1);
    for (const event of degraded) {
      assert.equal(event.attrs?.durable_message_present, false);
      assert.equal(event.attrs?.persistence_state, "transaction_pending");
      assert.equal(event.attrs?.failure_policy, "rollback_savepoint_and_continue");
      assert.equal(event.attrs?.query_name, "thread_follows.eligible_followers");
      assert.equal(event.attrs?.sqlstate, "57014");
    }
});

test("agent-api thread send records same-send unfollow fallback inside its atomic persistence", async ({ app }) => {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "post-persist unfollow lookup failure parent");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const content = "post-persist unfollow lookup failure reply";
    const followerReadError = Object.assign(
      new Error("failed query: select follower_type, follower_id from thread_follows where unfollowed_at is not null"),
      { code: "XX000" },
    );
    __setMessageServiceDepsForTests({
      listExplicitThreadUnfollows: async () => { throw followerReadError; },
    });

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
      content,
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    const persisted = (await latestChannelMessages(thread.id)).filter((message) => message.content === content);
    assert.equal(persisted.length, 1, "a failed post-persist unfollow lookup must not invite a duplicate-producing retry");
    assert.equal(persisted[0]?.id, sent.body.messageId);

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/internal/agent-api/send"
      && candidate.attrs?.status_code === 200
    );
    assert.ok(span);
    const persistedEvent = span.events.find((event) => event.name === "message_pipeline.message.persisted");
    const transactionEvents = sink.getAllSpans().filter(candidate => candidate.context.traceId === span.context.traceId).flatMap(candidate => candidate.events);
    const degraded = transactionEvents.filter((event) =>
      event.name === "message_pipeline.post_persist_side_effect.degraded"
      && event.attrs?.query_name === "thread_follows.same_send_candidates"
    );
    assert.ok(persistedEvent);
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0]?.attrs?.durable_message_present, false);
    assert.equal(degraded[0]?.attrs?.persistence_state, "transaction_pending");
    assert.equal(degraded[0]?.attrs?.failure_policy, "rollback_savepoint_and_continue");
    assert.equal(degraded[0]?.attrs?.sqlstate, "XX000");
    assert.equal(JSON.stringify(degraded[0]?.attrs).includes("follower_type"), false);
});

test("agent-api thread send survives a real Postgres error in a post-persist read: the read is rolled back to its savepoint", async ({ app }) => {
    // A plain JS throw does not abort the transaction; a real statement error
    // does. Before the savepoint, continuing after it failed the send with 25P02.
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "real db error parent");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const content = "real db error reply";
    __setMessageServiceDepsForTests({
      getThreadFollowerCandidates: async (_threadChannelId, executor) => {
        await (executor ?? getDb()).execute(sql`select 1 / 0`);
        return { humanFollowerIds: [], agentFollowers: [] };
      },
    });

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
      content,
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const persisted = (await latestChannelMessages(thread.id)).filter((message) => message.content === content);
    assert.equal(persisted.length, 1);
    const degraded = sink.getAllSpans().flatMap((span) => span.events)
      .filter((event) => event.name === "message_pipeline.post_persist_side_effect.degraded");
    assert.ok(degraded.length >= 1);
    for (const event of degraded) {
      assert.equal(event.attrs?.failure_policy, "rollback_savepoint_and_continue");
      assert.equal(event.attrs?.sqlstate, "22012");
    }
});

async function deadlockOnceScenario(
    app: { baseUrl: string; app: { set(name: string, value: unknown): void } },
    label: string,
    idempotencyKey?: string,
) {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, `${label} parent`);
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const content = `${label} reply`;
    let calls = 0;
    __setMessageServiceDepsForTests({
      getThreadFollowerCandidates: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        return { humanFollowerIds: [], agentFollowers: [] };
      },
    });
    const body = {
      target: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
      content,
      seenUpToSeq: parent.seq,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const send = () => sendViaAgentApi(app.baseUrl, fixture, body);
    const persistedCount = async () => (await latestChannelMessages(thread.id)).filter((message) => message.content === content).length;
    const degraded = () => sink.getAllSpans().flatMap((span) => span.events)
      .filter((event) => event.name === "message_pipeline.post_persist_side_effect.degraded");
    return { send, persistedCount, degraded, calls: () => calls };
}

// 10-15 02:57Z: a 40P01 in this read was swallowed, the aborted transaction then
// failed with 25P02, and the send returned 500. Rethrown, the 40P01 reaches
// whoever owns the transaction's retry.
test("agent-api thread send: a deadlock in a post-persist read retries the idempotent send server-side and sends once", async ({ app }) => {
    const scenario = await deadlockOnceScenario(app, "deadlock idempotent", "deadlock-retry-key-0001");
    const sent = await scenario.send();
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(scenario.calls(), 2, "the send transaction ran again");
    assert.equal(await scenario.persistedCount(), 1);
    assert.equal(scenario.degraded()[0]?.attrs?.failure_policy, "rethrow_for_transaction_retry");
    assert.equal(scenario.degraded()[0]?.attrs?.sqlstate, "40P01");
});

test("agent-api thread send: without a send-owned transaction, the deadlock is a typed retryable conflict, not a 500", async ({ app }) => {
    const scenario = await deadlockOnceScenario(app, "deadlock nested");
    const first = await scenario.send();
    assert.notEqual(first.status, 500, JSON.stringify(first.body));
    assert.equal(first.body.code, "send_transient_conflict");
    assert.equal(first.body.retryable, true);
    assert.equal(await scenario.persistedCount(), 0, "nothing was written");
    const retried = await scenario.send();
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(await scenario.persistedCount(), 1);
});

test("agent-api send rejects attachment IDs already linked to another message", async ({ app }) => {
    const fixture = await seedFixture();
    const existingMessage = await sendHumanMessage(fixture, "message with original attachment");
    const [attachment] = await insertAttachmentsWithObjects(getDb(), {
      messageId: existingMessage.id,
      channelId: fixture.channelId,
      uploaderId: fixture.agentId,
      uploaderType: "agent",
      filename: "already-linked.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      storageKey: `${fixture.serverId}/already-linked.txt`,
    });

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "should not be persisted",
      attachmentIds: [attachment.id],
      idempotencyKey: "reuse-bound-attachment",
      seenUpToSeq: existingMessage.seq,
    });

    assert.equal(sent.status, 400);
    assert.equal(sent.body.code, "attachment_already_linked");
    assert.match(sent.body.error, /already attached to another message/i);
    assert.match(sent.body.error, /Re-upload the file/i);

    const recent = await latestChannelMessages(fixture.channelId);
    assert.equal(recent.some((message) => message.content === "should not be persisted"), false);
});

test("agent-api send structured 4xx early-returns emit closed-set error_subkind (task #79)", async ({ app }) => {
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    const fixture = await seedFixture();

    const findFailureSubkind = (status: number) => {
      const span = sink.getAllSpans().find((candidate) =>
        candidate.name === "server.http.request"
        && candidate.attrs?.route_pattern === "/internal/agent-api/send"
        && candidate.attrs?.status_code === status
      );
      assert.ok(span, `expected send span with status ${status}`);
      const failed = span.events.find((event) => event.name === "agent_api_send.request.failed");
      assert.ok(failed, `expected agent_api_send.request.failed event for status ${status}`);
      return { subkind: failed.attrs?.error_subkind, httpStatus: failed.attrs?.http_status };
    };

    // bad_request: missing content (400)
    const missingContent = await sendViaAgentApi(app.baseUrl, fixture, { target: `#${fixture.channelName}` });
    assert.equal(missingContent.status, 400);
    assert.deepEqual(findFailureSubkind(400), { subkind: "bad_request", httpStatus: 400 });

    // target_not_found: unknown peer DM (404)
    const unknownTarget = await sendViaAgentApi(app.baseUrl, fixture, {
      target: "dm:@does-not-exist-xyz",
      content: "hello",
    });
    assert.equal(unknownTarget.status, 404);
    assert.deepEqual(findFailureSubkind(404), { subkind: "target_not_found", httpStatus: 404 });
});

test("agent-api first reply reuses an existing empty thread channel", async ({ app }) => {
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "opened thread parent");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const threadTarget = `#${fixture.channelName}:${parent.id.slice(0, 8)}`;

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: threadTarget,
      content: "agent-api reply in opened empty thread",
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");

    const sentMessage = await getMessageChannel(sent.body.messageId);
    assert.equal(sentMessage?.channelId, thread.id);
    const [latest] = await latestChannelMessages(thread.id, 1);
    assert.equal(latest?.id, sent.body.messageId);
});

test("agent-api first reply to a channel thread requires parent channel membership", async ({ app }) => {
    const fixture = await seedFixture();
    const outsider = await createAgent(fixture.serverId, "AgentApiSendOutsider", { runtime: "claude", model: "sonnet" });
    const minted = await mintAgentCredential({
      agentId: outsider.id,
      scopes: ["send", "read"],
      name: "agent-api-send-outsider-test",
      issuedVia: "computer",
      createdByUserId: null,
    });
    const parent = await sendHumanMessage(fixture, "members only thread parent");
    const threadTarget = `#${fixture.channelName}:${parent.id.slice(0, 8)}`;

    const denied = await sendViaAgentApi(app.baseUrl, fixture, {
      target: threadTarget,
      content: "should not send",
      seenUpToSeq: parent.seq,
    }, minted.apiKey);

    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /aren't a member of its channel/);
});

test("agent-api thread target cloaks hidden private parent existence from non-member agents", async ({ app }) => {
    const fixture = await seedFixture();
    const privateChannel = await createChannel(fixture.serverId, "agent-api-hidden-thread-parent", "hidden parent", "private");
    await addHuman(privateChannel.id, fixture.ownerId);
    const parent = await createMessage(privateChannel.id, "user", fixture.ownerId, "hidden private parent");

    const denied = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${privateChannel.name}:${parent.id.slice(0, 8)}`,
      content: "should cloak hidden private parent",
      seenUpToSeq: parent.seq,
    });

    assert.equal(denied.status, 404);
    assert.equal(denied.body.code, "target_not_found");
    assert.match(denied.body.error, /^No thread you can reply in matches /);
});

test("agent-api first reply to a fresh DM thread creates the thread and sends", async ({ app }) => {
    const fixture = await seedFixture();
    const db = getDb();
    const dm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
    assert.ok(dm, "expected owner-agent DM to exist");
    const parent = await createMessage(dm.id, "user", fixture.ownerId, "fresh DM thread parent");
    const threadTarget = `dm:@${fixture.ownerName}:${parent.id.slice(0, 8)}`;

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: threadTarget,
      content: "agent-api first DM thread reply",
      seenUpToSeq: parent.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");

    const sentMessage = await getMessageChannel(sent.body.messageId);
    assert.equal(sentMessage?.channelType, "thread");
    assert.notEqual(sentMessage?.channelId, dm.id);

    const rows = await db
      .select()
      .from(threadFollows)
      .where(eq(threadFollows.threadChannelId, sentMessage!.channelId));
    const agentFollow = rows.find((row) => row.followerType === "agent" && row.followerId === fixture.agentId);
    assert.equal(agentFollow?.reason, "replied", "agent sender should follow the DM thread after first reply");
    const ownerFollow = rows.find((row) => row.followerType === "user" && row.followerId === fixture.ownerId);
    assert.equal(ownerFollow?.reason, "authored", "parent human author should follow the DM thread after first agent reply");
});

test("agent-api thread-target 404 explains unresolved reply target", async ({ app }) => {
    const fixture = await seedFixture();
    const missing = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}:deadbeef`,
      content: "missing parent",
      seenUpToSeq: 0,
    });

    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "target_not_found");
    assert.match(missing.body.error, /^No thread you can reply in matches /);
    assert.match(missing.body.error, /that message must belong to the conversation named before it/);
});

test("agent-api send holds stale draft and returns inline held context", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const freshUnread = await sendHumanMessage(fixture, "fresh unread before agent-api send");

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft",
      seenUpToSeq: baseline.seq,
    });

    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.outcome, "held");
    assert.equal(held.body.subtype, "freshness");
    assert.equal(held.body.reason, "newer_messages_available");
    assert.match(held.body.producerFactId, /^freshness_decision_fact:[0-9a-f]{64}$/);
    assert.deepEqual(held.body.available_actions, ["check_messages", "send_draft", "send_anyway"]);
    assert.equal(held.body.newMessageCount, 1);
    assert.equal(held.body.shownMessageCount, 1);
    assert.equal(held.body.omittedMessageCount, 0);
    assert.equal(held.body.heldMessages[0].id, freshUnread.id);
    assert.equal(held.body.seenUpToSeq, freshUnread.seq);
    assert.equal(held.body.pendingMentionActions, undefined);
    assert.equal(await getAgentLegacyReadCursor(fixture.agentId, fixture.channelId), freshUnread.seq);

    const events = await getDb().select().from(attestedSendEvents);
    assert.equal(events.filter((event) => event.eventType === "gate_triggered").length, 1);
    const gate = events.find((event) => event.eventType === "gate_triggered");
    const metadata = gate?.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.copy_variant, "no_send_v1");
    assert.deepEqual(metadata?.available_actions, ["check_messages", "send_draft", "send_anyway"]);
});

test("reviewer-isolation send hold exposes only held state plus count and advances no read or delivery cursor", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const poisonBody = "peer reviewer verdict: REQUEST CHANGES at 2042-08-09T10:11:12.000Z";
    await sendHumanMessage(fixture, poisonBody);

    const orchestrator = app.app.get("agentOrchestrator") as any;
    let ackCalls = 0;
    const recordedActions: Array<Record<string, unknown>> = [];
    const originalRecordAgentSlockAction = orchestrator.recordAgentRaftAction.bind(orchestrator);
    orchestrator.recordAgentRaftAction = async (
      agentId: string,
      event: Record<string, unknown>,
    ) => {
      recordedActions.push(event);
      return originalRecordAgentSlockAction(agentId, event);
    };
    orchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq = () => {
      ackCalls += 1;
      return { removedCount: 0 };
    };
    orchestrator.acknowledgeDeliveredMessagesForChannel = () => {
      ackCalls += 1;
      return { removedCount: 0 };
    };

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "my independent verdict",
      seenUpToSeq: baseline.seq,
      freshnessContextMode: "withheld",
      draftReholdCount: 99,
    });

    assert.equal(held.status, 200);
    assert.deepEqual(held.body, {
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(held.body), /peer reviewer|REQUEST CHANGES|2042-08-09/);
    assert.equal(
      await getAgentLegacyReadCursor(fixture.agentId, fixture.channelId),
      baseline.seq,
      "withheld context must not advance the durable read-ish cursor",
    );
    assert.equal(ackCalls, 0, "withheld context must not acknowledge daemon delivery");
    assert.deepEqual(recordedActions, [{
      title: "Reviewer-isolation freshness hold",
      text: "1 newer message withheld",
    }]);
    const rows = await latestChannelMessages(fixture.channelId);
    assert.equal(
      rows.some((row) => row.content === "my independent verdict"),
      false,
      "held send must not persist the draft",
    );

    const continued = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "my independent verdict",
      sendDraft: true,
      continueAnyway: true,
      seenUpToSeq: baseline.seq,
      freshnessContextMode: "withheld",
    });
    assert.equal(continued.status, 200);
    assert.equal(continued.body.state, "sent");
    assert.ok(continued.body.messageId);
    assert.doesNotMatch(JSON.stringify(continued.body), /peer reviewer|REQUEST CHANGES|2042-08-09/);
    assert.equal("seenUpToSeq" in continued.body, false);
    assert.equal(ackCalls, 0);
    assert.deepEqual(recordedActions[1], {
      title: "Reviewer-isolation draft sent",
      text: "1 newer message withheld",
    });
});

test("agent-api send does not hold when only newer messages are from the sender", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const selfMessage = await sendAgentMessage(fixture, "previous agent progress");

    const sent = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "follow-up after own progress",
      seenUpToSeq: baseline.seq,
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.ok(sent.body.messageId);
    assert.ok(sent.body.messageSeq > selfMessage.seq);
    const [latest] = await latestChannelMessages(fixture.channelId, 1);
    assert.equal(latest?.id, sent.body.messageId);

    const events = await getDb().select().from(attestedSendEvents);
    assert.equal(events.filter((event) => event.eventType === "gate_triggered").length, 0);
});

test("agent-api held context excludes newer messages from the sender", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const freshUnread = await sendHumanMessage(fixture, "peer update");
    await sendAgentMessage(fixture, "own later progress");

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "stale follow-up",
      seenUpToSeq: baseline.seq,
    });

    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 1);
    assert.equal(held.body.heldMessages.length, 1);
    assert.equal(held.body.heldMessages[0].id, freshUnread.id);
    assert.equal(held.body.seenUpToSeq, freshUnread.seq);
});

test("agent-api freshness boundary suppresses held mention rows and mention count together", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const readCoveredMention = await sendHumanMentionMessage(fixture, `read-covered @${fixture.agentName}`);
    const unreadMention = await sendHumanMentionMessage(fixture, `still-unread @${fixture.agentName}`);

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft after reading the first mention",
      seenUpToSeq: readCoveredMention.seq,
    });

    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 1);
    assert.deepEqual(
      held.body.heldMessages.map((message: { id: string }) => message.id),
      [unreadMention.id],
      "read-covered mention must not remain in held newer rows",
    );
    assert.equal(
      held.body.mentionAnnotation?.formalMentionCount,
      1,
      "formal mention count must use the same seenUpToSeq boundary as held rows",
    );
});

test("agent-api send ignores read cursor as freshness proof", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const freshUnread = await sendHumanMessage(fixture, "fresh unread before read cursor advance");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, freshUnread.seq);

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft with stale model state",
      seenUpToSeq: baseline.seq,
    });

    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 1);
    assert.equal(held.body.heldMessages[0].id, freshUnread.id);
    assert.equal(held.body.seenUpToSeq, freshUnread.seq);
});

test("agent-api held response returns latest bounded context with omitted count", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const unread: Awaited<ReturnType<typeof sendHumanMessage>>[] = [];
    for (let i = 0; i < 5; i += 1) {
      unread.push(await sendHumanMessage(fixture, `fresh unread ${i + 1}`));
    }
    const latestUnread = unread[unread.length - 1]!;

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft with many unread messages",
      seenUpToSeq: baseline.seq,
    });

    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 5);
    assert.equal(held.body.shownMessageCount, 3);
    assert.equal(held.body.omittedMessageCount, 2);
    assert.equal(held.body.heldMessages.length, 3);
    assert.equal(held.body.seenUpToSeq, latestUnread.seq);
    // Two messages were omitted, never handed to the agent: the hold must not
    // read through them (they would never be delivered otherwise).
    assert.equal(await getAgentLegacyReadCursor(fixture.agentId, fixture.channelId), baseline.seq);
});

test("agent-api held response that shows every held message reads through to the latest", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const fresh = await sendHumanMessage(fixture, "one fresh unread");

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft with one unread message",
      seenUpToSeq: baseline.seq,
    });

    assert.equal(held.body.state, "held");
    assert.equal(held.body.omittedMessageCount, 0);
    assert.equal(await getAgentLegacyReadCursor(fixture.agentId, fixture.channelId), fresh.seq);
});

test("agent-api direct send without freshness boundary returns bounded first-touch context", async ({ app }) => {
    const fixture = await seedFixture();
    const history: Awaited<ReturnType<typeof sendHumanMessage>>[] = [];
    for (let i = 0; i < 5; i += 1) {
      history.push(await sendHumanMessage(fixture, `history message ${i + 1}`));
    }

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft without boundary",
    });

    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 3);
    assert.equal(held.body.shownMessageCount, 3);
    assert.equal(held.body.omittedMessageCount, 0);
    assert.deepEqual(
      held.body.heldMessages.map((message: { content: string }) => message.content),
      ["history message 3", "history message 4", "history message 5"],
    );
    assert.equal(held.body.seenUpToSeq, history[history.length - 1]!.seq);

    const events = await getDb().select().from(attestedSendEvents);
    const gate = events.find((event) => event.eventType === "gate_triggered");
    assert.equal(gate?.newMessageCount, 3);
    assert.equal((gate?.metadata as Record<string, unknown> | undefined)?.boundary_source, "none");
});

// One rule for agent-api sends and task writes (renderAgentFreshnessHold;
// the legacy `/agent/:id/send` route keeps its own): a boundary of 0 with
// nothing seen exactly proves nothing, so it holds like no boundary at all
// (the bounded first-touch slice), not "5 unread" with 2 "skipped".
test("agent-api send attesting seenUpToSeq 0 returns the same bounded first-touch context", async ({ app }) => {
    const fixture = await seedFixture();
    const history: Awaited<ReturnType<typeof sendHumanMessage>>[] = [];
    for (let i = 0; i < 5; i += 1) {
      history.push(await sendHumanMessage(fixture, `history message ${i + 1}`));
    }

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft attesting 0",
      seenUpToSeq: 0,
    });

    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 3);
    assert.equal(held.body.shownMessageCount, 3);
    assert.equal(held.body.omittedMessageCount, 0);
    assert.equal(held.body.seenUpToSeq, history[history.length - 1]!.seq);
    const events = await getDb().select().from(attestedSendEvents);
    const gate = events.find((event) => event.eventType === "gate_triggered");
    assert.equal((gate?.metadata as Record<string, unknown> | undefined)?.boundary_source, "client_seen", "what was attested is recorded as before");
});

test("agent-api send-draft commits once seenUpToSeq reaches latest state", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const freshUnread = await sendHumanMessage(fixture, "fresh unread");

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api draft",
      seenUpToSeq: baseline.seq,
    });
    assert.equal(held.body.state, "held");

    const committed = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      sendDraft: true,
      content: "agent-api draft",
      seenUpToSeq: freshUnread.seq,
    });

    assert.equal(committed.status, 200);
    assert.equal(committed.body.state, "sent");
    const [latest] = await latestChannelMessages(fixture.channelId, 1);
    assert.equal(latest?.id, committed.body.messageId);
    assert.equal(latest?.content, "agent-api draft");

    const events = await getDb().select().from(attestedSendEvents);
    const continueEvent = events.find((event) => event.eventType === "continue");
    assert.ok(continueEvent, "expected continue event for send-draft commit");
    assert.equal(continueEvent?.messageId, committed.body.messageId);
});

test("agent-api events consumes exactly the returned inbox batch", async ({ app }) => {
    const fixture = await seedFixture();
    const inbox = [
      {
        id: randomUUID(),
        seq: 101,
        channelId: fixture.channelId,
        channelName: fixture.channelName,
        channelType: "channel",
        senderType: "user",
        senderId: fixture.ownerId,
        senderName: "Owner",
        messageType: "message",
        content: "queued event",
        createdAt: new Date().toISOString(),
      },
    ];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    orchestrator.receiveMessages = async () => [...inbox];
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      const seqSet = new Set(seqs);
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (seqSet.has(inbox[index]!.seq)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };

    const first = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { events?: Array<{ seq: number }> };
    assert.deepEqual(firstBody.events?.map((event) => event.seq), [101]);

    const second = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { events?: Array<{ seq: number }> };
    assert.deepEqual(secondBody.events, []);
});

test("agent-api events refreshes amended task text at drain and never acks an unverified batch", async ({ app }) => {
    const fixture = await seedFixture();
    const { tasks: [created], hostMessages: [hostMessage] } = await taskService.createTasks(
      fixture.channelId,
      "user",
      fixture.ownerId,
      [{ title: "queued title A", description: "queued description A" }],
    );
    const inbox: AgentMessage[] = [{
      channel_id: fixture.channelId,
      channel_name: fixture.channelName,
      channel_type: "channel",
      sender_id: fixture.ownerId,
      sender_name: fixture.ownerName,
      sender_type: "human",
      content: hostMessage.content,
      timestamp: hostMessage.createdAt.toISOString(),
      seq: hostMessage.seq,
      message_id: hostMessage.id,
      task_status: created.status,
      task_number: created.taskNumber,
      task_assignee_type: null,
      task_assignee_id: null,
      task_assignee_name: null,
      task_current_projection: {
        title: created.title,
        description: created.description,
        revision: created.revision,
        superseded: false,
        amended_at: null,
        amended_by_type: null,
        amended_by_name: null,
        source: "tasks_current_projection",
      },
    }];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    let ackCalls = 0;
    orchestrator.receiveMessages = async () => [...inbox];
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      ackCalls += 1;
      const seqSet = new Set(seqs);
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: seqs.length };
    };

    const amendment = await taskService.amendTask(created.id, {
      title: "current title B",
      description: "current description B",
    }, "user", fixture.ownerId);
    assert.notEqual(typeof amendment, "string", String(amendment));
    if (typeof amendment === "string") return;

    const registry = new InMemoryFailpointRegistry();
    registry.configure("server.message.taskProjection.canonicalTaskFactsQuery", {
      effect: "throw",
      payload: "injected drain refresh failure",
    });
    __setFailpointsForTests(registry);
    const failed = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(failed.status, 500);
    assert.equal(ackCalls, 0, "refresh failure must happen before every delivery ack");
    assert.equal(inbox.length, 1, "the unverified queued batch must remain retryable");

    __resetFailpointsForTests();
    const retried = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(retried.status, 200);
    const body = await retried.json() as { events?: AgentMessage[] };
    assert.equal(body.events?.length, 1);
    assert.equal(body.events?.[0]?.content, "queued title A", "immutable host bytes must survive refresh");
    assert.deepEqual(body.events?.[0]?.task_current_projection, {
      title: "current title B",
      description: "current description B",
      revision: amendment.row.revision,
      superseded: true,
      amended_at: amendment.event.createdAt.toISOString(),
      amended_by_type: "user",
      amended_by_name: fixture.ownerName,
      source: "tasks_current_projection",
    });
    assert.equal(ackCalls, 1, "the verified retry is acknowledged exactly once");
    assert.equal(inbox.length, 0);
});

test("agent-api events projects a task created after its plain host was enqueued", async ({ app }) => {
    const fixture = await seedFixture();
    const hostMessage = await createMessage(
      fixture.channelId,
      "user",
      fixture.ownerId,
      "plain when queued",
    );
    const inbox: AgentMessage[] = [{
      channel_id: fixture.channelId,
      channel_name: fixture.channelName,
      channel_type: "channel",
      sender_id: fixture.ownerId,
      sender_name: fixture.ownerName,
      sender_type: "human",
      content: hostMessage.content,
      timestamp: hostMessage.createdAt.toISOString(),
      seq: hostMessage.seq,
      message_id: hostMessage.id,
    }];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    orchestrator.receiveMessages = async () => [...inbox];
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      const seqSet = new Set(seqs);
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: seqs.length };
    };

    const created = await taskService.ensureTaskForMessage(hostMessage.id, "user", fixture.ownerId);
    assert.ok(created);
    const amendment = await taskService.amendTask(created.id, {
      title: "converted current title",
    }, "user", fixture.ownerId);
    assert.notEqual(typeof amendment, "string", String(amendment));
    if (typeof amendment === "string") return;

    const response = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { events?: AgentMessage[] };
    assert.equal(body.events?.[0]?.content, "plain when queued");
    assert.equal(body.events?.[0]?.task_status, "todo");
    assert.equal(body.events?.[0]?.task_number, created.taskNumber);
    assert.equal(body.events?.[0]?.task_current_projection?.title, "converted current title");
    assert.equal(body.events?.[0]?.task_current_projection?.superseded, true);
    assert.equal(inbox.length, 0);
});

test("agent-api wake-hints are content-free and do not consume the server inbox", async ({ app }) => {
    const fixture = await seedFixture();
    const inbox: AgentMessage[] = [
      {
        channel_id: fixture.channelId,
        channel_name: fixture.channelName,
        channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "queued wake body must not leak",
        timestamp: new Date().toISOString(),
        seq: 201,
        message_id: "wake-message-1",
      },
    ];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    let receiveCalls = 0;
    let ackCalls = 0;
    orchestrator.peekPendingMessages = () => [...inbox];
    orchestrator.receiveMessages = async () => {
      receiveCalls += 1;
      return [...inbox];
    };
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      ackCalls += 1;
      const seqSet = new Set(seqs);
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };

    const first = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(first.status, 200);
    const firstBodyText = await first.text();
    assert.doesNotMatch(firstBodyText, /queued wake body must not leak/);
    const firstBody = JSON.parse(firstBodyText) as {
      wake_hints?: Array<{
        event_id: string;
        seq: number | null;
        message_id: string | null;
        target: string | null;
        wake_reason: string;
        content?: string;
      }>;
    };
    assert.deepEqual(firstBody.wake_hints?.map((hint) => hint.seq), [201]);
    assert.equal(firstBody.wake_hints?.[0]?.event_id, "wake-hint:wake-message-1");
    assert.equal(firstBody.wake_hints?.[0]?.message_id, "wake-message-1");
    assert.equal(firstBody.wake_hints?.[0]?.target, `#${fixture.channelName}`);
    assert.equal(firstBody.wake_hints?.[0]?.wake_reason, "message_pending");
    assert.equal("content" in (firstBody.wake_hints?.[0] ?? {}), false);
    assert.equal(receiveCalls, 0);
    assert.equal(ackCalls, 0);

    const second = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { wake_hints?: Array<{ seq: number | null }> };
    assert.deepEqual(secondBody.wake_hints?.map((hint) => hint.seq), [201], "peek must be repeatable");
    assert.equal(receiveCalls, 0);
    assert.equal(ackCalls, 0);

    const delivered = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(delivered.status, 200);
    const deliveredBody = await delivered.json() as { events?: Array<{ seq: number; content: string }> };
    assert.deepEqual(deliveredBody.events?.map((event) => event.seq), [201]);
    assert.deepEqual(deliveredBody.events?.map((event) => event.content), ["queued wake body must not leak"]);
    assert.equal(receiveCalls, 1);
    assert.equal(ackCalls, 1);
});

test("agent-api wake-hints supports seq filtering and limit without delivery ack", async ({ app }) => {
    const fixture = await seedFixture();
    const inbox: AgentMessage[] = [301, 302, 303].map((seq) => ({
      channel_id: fixture.channelId,
      channel_name: fixture.channelName,
      channel_type: "channel",
      sender_id: fixture.ownerId,
      sender_name: fixture.ownerName,
      sender_type: "human",
      content: `queued body ${seq}`,
      timestamp: new Date().toISOString(),
      seq,
      message_id: `wake-message-${seq}`,
    }));
    const orchestrator = app.app.get("agentOrchestrator") as any;
    let ackCalls = 0;
    orchestrator.peekPendingMessages = () => [...inbox];
    orchestrator.acknowledgeDeliveredMessages = () => {
      ackCalls += 1;
      return { removedCount: 0 };
    };

    const filtered = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints?since=301&limit=1`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(filtered.status, 200);
    const bodyText = await filtered.text();
    assert.doesNotMatch(bodyText, /queued body/);
    const body = JSON.parse(bodyText) as {
      wake_hints?: Array<{ seq: number | null }>;
      last_hint_seq?: number | null;
      has_more?: boolean;
    };
    assert.deepEqual(body.wake_hints?.map((hint) => hint.seq), [302]);
    assert.equal(body.last_hint_seq, 302);
    assert.equal(body.has_more, true);
    assert.equal(ackCalls, 0);
});

test("agent channel mute suppresses ordinary delivery but preserves personal mention pierce", async ({ app }) => {
    const fixture = await seedFixture();
    const unmutedAgent = await createAgent(fixture.serverId, "AgentApiMuteControl", { runtime: "external", model: "external" });
    await addAgent(fixture.channelId, unmutedAgent.id);
    const [mutedAgent] = await getDb()
      .select({ name: agentsTable.name })
      .from(agentsTable)
      .where(eq(agentsTable.id, fixture.agentId))
      .limit(1);
    assert.ok(mutedAgent);

    const state = await setInboxTargetActivityMuteState({
      receiverType: "agent",
      receiverId: fixture.agentId,
      serverId: fixture.serverId,
      sourceChannelId: fixture.channelId,
      activityMuted: true,
    });
    assert.equal(state.activityMuted, true);

    const delivered = new Map<string, AgentMessage[]>();
    const orchestrator = withChannelDelivery({
      deliverMessage: async (agentId: string, message: AgentMessage) => {
        delivered.set(agentId, [...(delivered.get(agentId) ?? []), message]);
        return { status: "queued", reason: "replayable_inbox" } as const;
      },
    }) as AgentOrchestrator;

    await broadcastAndDeliver(app.io, orchestrator, {
      channelId: fixture.channelId,
      senderType: "user",
      senderId: fixture.ownerId,
      senderName: fixture.ownerName,
      content: "ordinary after agent mute",
    });

    assert.equal(delivered.get(fixture.agentId)?.length ?? 0, 0, "muted ordinary channel message must not reach the agent delivery inbox");
    assert.deepEqual(delivered.get(unmutedAgent.id)?.map((message) => message.content), ["ordinary after agent mute"]);

    delivered.clear();
    await broadcastAndDeliver(app.io, orchestrator, {
      channelId: fixture.channelId,
      senderType: "user",
      senderId: fixture.ownerId,
      senderName: fixture.ownerName,
      content: `@${mutedAgent.name} personal mention after mute`,
    });

    const pierced = delivered.get(fixture.agentId) ?? [];
    assert.equal(pierced.length, 1, "personal @mention must pierce channel mute");
    assert.equal(pierced[0]!.mentioned, true);
    assert.equal(pierced[0]!.content, `@${mutedAgent.name} personal mention after mute`);
});

test("agent-api freshness ignores muted ordinary messages but holds on pierce context", async ({ app }) => {
    const fixture = await seedFixture();
    const [mutedAgent] = await getDb()
      .select({ name: agentsTable.name })
      .from(agentsTable)
      .where(eq(agentsTable.id, fixture.agentId))
      .limit(1);
    assert.ok(mutedAgent);

    const baseline = await sendHumanMessage(fixture, "baseline before mute");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    await setInboxTargetActivityMuteState({
      receiverType: "agent",
      receiverId: fixture.agentId,
      serverId: fixture.serverId,
      sourceChannelId: fixture.channelId,
      activityMuted: true,
    });

    const muteDeliveryOrchestrator = withChannelDelivery({
      deliverMessage: async () => {},
    }) as unknown as AgentOrchestrator;
    const mutedOrdinary = await broadcastAndDeliver(app.io, muteDeliveryOrchestrator, {
      channelId: fixture.channelId,
      senderType: "user",
      senderId: fixture.ownerId,
      senderName: fixture.ownerName,
      content: "muted ordinary before agent-api send",
    });

    const sentThroughMutedTail = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api send after muted ordinary",
      seenUpToSeq: baseline.seq,
    });
    assert.equal(sentThroughMutedTail.status, 200);
    assert.equal(sentThroughMutedTail.body.state, "sent");

    const piercedMention = await broadcastAndDeliver(app.io, muteDeliveryOrchestrator, {
      channelId: fixture.channelId,
      senderType: "user",
      senderId: fixture.ownerId,
      senderName: fixture.ownerName,
      content: `@${mutedAgent.name} pierce after muted ordinary`,
    });

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "agent-api send after pierce",
      seenUpToSeq: baseline.seq,
    });
    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 1);
    assert.deepEqual(
      held.body.heldMessages.map((message: { id: string; content: string }) => ({ id: message.id, content: message.content })),
      [{ id: piercedMention.id, content: `@${mutedAgent.name} pierce after muted ordinary` }],
    );
    assert.equal(
      held.body.heldMessages.some((message: { id: string }) => message.id === mutedOrdinary.id),
      false,
      "muted ordinary message must not be forced into held context",
    );
    assert.equal(held.body.seenUpToSeq, piercedMention.seq);
});

test("agent-api events delivery ack advances compatibility checkpoint before model-seen capability", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline before compatibility delivery");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const fresh = await sendHumanMessage(fixture, "fresh delivery should become compat-read");
    const inbox: AgentMessage[] = [
      {
        channel_id: fixture.channelId,
        channel_name: fixture.channelName,
        channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: fresh.content,
        timestamp: fresh.createdAt.toISOString(),
        seq: fresh.seq,
        message_id: fresh.id,
      },
    ];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    orchestrator.receiveMessages = async () => [...inbox];
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      const seqSet = new Set(seqs);
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };

    const delivered = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });

    assert.equal(delivered.status, 200);
    const deliveredBody = await delivered.json() as { events?: Array<{ seq: number; content: string }> };
    assert.deepEqual(deliveredBody.events?.map((event) => event.seq), [fresh.seq]);
    assert.equal(await getAgentLegacyReadCursor(fixture.agentId, fixture.channelId), fresh.seq);
    const unreadCounts = await getAgentUnreadCounts(fixture.agentId, await referenceAgentInboxChain(fixture.agentId));
    assert.equal(unreadCounts[`#${fixture.channelName}`], undefined);

    const replay = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json() as { events?: unknown[] };
    assert.deepEqual(replayBody.events, []);
});

test("agent-api events delivery ack is volatile once daemon advertises model-seen capability", async ({ app }) => {
    const fixture = await seedFixture();
    const baseline = await sendHumanMessage(fixture, "baseline before model-seen-capable delivery");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, baseline.seq);
    const fresh = await sendHumanMessage(fixture, "fresh delivery should remain volatile");
    const inbox: AgentMessage[] = [
      {
        channel_id: fixture.channelId,
        channel_name: fixture.channelName,
        channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: fresh.content,
        timestamp: fresh.createdAt.toISOString(),
        seq: fresh.seq,
        message_id: fresh.id,
      },
    ];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    const originalHasMachineCapability = orchestrator.hasMachineCapability;
    orchestrator.hasMachineCapability = () => true;
    try {
      orchestrator.receiveMessages = async () => [...inbox];
      orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
        const seqSet = new Set(seqs);
        const before = inbox.length;
        for (let index = inbox.length - 1; index >= 0; index -= 1) {
          if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
        }
        return { removedCount: before - inbox.length };
      };

      const delivered = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
        headers: agentHeaders(fixture.agentApiKey),
      });

      assert.equal(delivered.status, 200);
      const deliveredBody = await delivered.json() as { events?: Array<{ seq: number; content: string }> };
      assert.deepEqual(deliveredBody.events?.map((event) => event.seq), [fresh.seq]);
      assert.equal(await getAgentLegacyReadCursor(fixture.agentId, fixture.channelId), baseline.seq);
      const unreadCounts = await getAgentUnreadCounts(fixture.agentId, await referenceAgentInboxChain(fixture.agentId));
      assert.equal(unreadCounts[`#${fixture.channelName}`], 1);
    } finally {
      orchestrator.hasMachineCapability = originalHasMachineCapability;
    }
});

test("agent-api events drops queued private-channel messages after membership removal", async ({ app }) => {
    const fixture = await seedFixture();
    const privateChannel = await createChannel(fixture.serverId, "agent-api-events-private", "private surface", "private");
    await addAgent(privateChannel.id, fixture.agentId);
    await removeAgent(privateChannel.id, fixture.agentId);
    const foreignServer = await createServer("Agent API Foreign Server", `agent-api-foreign-${randomUUID()}`, fixture.ownerId);
    const foreignChannel = await createChannel(foreignServer.id, "agent-api-foreign-public", "cross-server public");
    const inbox: AgentMessage[] = [
      {
        channel_id: privateChannel.id,
        channel_name: privateChannel.name,
        channel_type: "private",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "queued private event",
        timestamp: new Date().toISOString(),
        seq: 102,
        message_id: "private-event",
      },
      {
        channel_id: foreignChannel.id,
        channel_name: foreignChannel.name,
        channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "queued foreign public event",
        timestamp: new Date().toISOString(),
        seq: 104,
        message_id: "foreign-public-event",
      },
      {
        channel_id: fixture.channelId,
        channel_name: fixture.channelName,
        channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "queued public event",
        timestamp: new Date().toISOString(),
        seq: 103,
        message_id: "public-event",
      },
    ];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    orchestrator.receiveMessages = async () => [...inbox];
    orchestrator.discardUndeliverableMessages = (_agentId: string, messages: AgentMessage[]) => {
      const seqs = new Set(messages.map((message) => message.seq).filter((seq): seq is number => Number.isInteger(seq)));
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqs.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      const seqSet = new Set(seqs);
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };

    const first = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { events?: Array<{ seq: number; content: string }> };
    assert.deepEqual(firstBody.events?.map((event) => event.content), ["queued public event"]);
    assert.deepEqual(firstBody.events?.map((event) => event.seq), [103]);

    const second = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { events?: unknown[] };
    assert.deepEqual(secondBody.events, []);
});

test("agent-api events drops ordinary tombstoned thread messages but preserves personal mention pierce", async ({ app }) => {
    const fixture = await seedFixture();
    const parent = await createMessage(fixture.channelId, "user", fixture.ownerId, "agent-api tombstoned thread parent");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const threadName = `thread-${parent.id.slice(0, 8)}`;
    await getDb().insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: fixture.agentId,
      parentMessageId: parent.id,
      reason: "manual",
      unfollowedAt: new Date("2026-07-06T00:00:00.000Z"),
    }).onConflictDoNothing();
    await getDb().insert(channelAgents).values({
      channelId: thread.id,
      agentId: fixture.agentId,
    }).onConflictDoNothing();

    const inbox: AgentMessage[] = [
      {
        channel_id: thread.id,
        channel_name: threadName,
        channel_type: "thread",
        parent_channel_id: fixture.channelId,
        parent_channel_name: fixture.channelName,
        parent_channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "ordinary tombstoned thread event",
        timestamp: new Date().toISOString(),
        seq: 201,
        message_id: "ordinary-tombstoned-thread-event",
      },
      {
        channel_id: thread.id,
        channel_name: threadName,
        channel_type: "thread",
        parent_channel_id: fixture.channelId,
        parent_channel_name: fixture.channelName,
        parent_channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "personal mention tombstoned thread event",
        timestamp: new Date().toISOString(),
        seq: 202,
        message_id: "mentioned-tombstoned-thread-event",
        mentioned: true,
      },
      {
        channel_id: fixture.channelId,
        channel_name: fixture.channelName,
        channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "queued public event after tombstone",
        timestamp: new Date().toISOString(),
        seq: 203,
        message_id: "public-event-after-tombstone",
      },
    ];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    orchestrator.receiveMessages = async () => [...inbox];
    orchestrator.discardUndeliverableMessages = (_agentId: string, messages: AgentMessage[]) => {
      const seqs = new Set(messages.map((message) => message.seq).filter((seq): seq is number => Number.isInteger(seq)));
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqs.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      const seqSet = new Set(seqs);
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };

    const first = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { events?: Array<{ seq: number; content: string; mentioned?: boolean }> };
    assert.deepEqual(firstBody.events?.map((event) => event.content), [
      "personal mention tombstoned thread event",
      "queued public event after tombstone",
    ]);
    assert.deepEqual(firstBody.events?.map((event) => event.seq), [202, 203]);
    assert.equal(firstBody.events?.[0]?.mentioned, true);

    const second = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { events?: unknown[] };
    assert.deepEqual(secondBody.events, []);
});

test("agent-api events and wake-hints require active follow plus current private parent access", async ({ app }) => {
    const fixture = await seedFixture();
    const privateChannel = await createChannel(fixture.serverId, "agent-api-stale-private-parent", "private parent", "private");
    await addHuman(privateChannel.id, fixture.ownerId);
    await addAgent(privateChannel.id, fixture.agentId);
    const parent = await createMessage(privateChannel.id, "user", fixture.ownerId, "agent-api stale private parent");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const threadName = `thread-${parent.id.slice(0, 8)}`;
    await getDb().insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: fixture.agentId,
      parentMessageId: parent.id,
      reason: "manual",
    }).onConflictDoNothing();
    await getDb().insert(channelAgents).values({
      channelId: thread.id,
      agentId: fixture.agentId,
    }).onConflictDoNothing();
    await removeAgent(privateChannel.id, fixture.agentId);

    const inbox: AgentMessage[] = [
      {
        channel_id: thread.id,
        channel_name: threadName,
        channel_type: "thread",
        parent_channel_id: privateChannel.id,
        parent_channel_name: privateChannel.name,
        parent_channel_type: "private",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "ordinary stale private thread event",
        timestamp: new Date().toISOString(),
        seq: 301,
        message_id: "ordinary-stale-private-thread-event",
      },
      {
        channel_id: thread.id,
        channel_name: threadName,
        channel_type: "thread",
        parent_channel_id: privateChannel.id,
        parent_channel_name: privateChannel.name,
        parent_channel_type: "private",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "mentioned stale private thread event",
        timestamp: new Date().toISOString(),
        seq: 302,
        message_id: "mentioned-stale-private-thread-event",
        mentioned: true,
      },
      {
        channel_id: fixture.channelId,
        channel_name: fixture.channelName,
        channel_type: "channel",
        sender_id: fixture.ownerId,
        sender_name: fixture.ownerName,
        sender_type: "human",
        content: "queued public event after private parent removal",
        timestamp: new Date().toISOString(),
        seq: 303,
        message_id: "public-event-after-private-parent-removal",
      },
    ];
    const orchestrator = app.app.get("agentOrchestrator") as any;
    orchestrator.peekPendingMessages = () => [...inbox];
    orchestrator.receiveMessages = async () => [...inbox];
    orchestrator.discardUndeliverableMessages = (_agentId: string, messages: AgentMessage[]) => {
      const seqs = new Set(messages.map((message) => message.seq).filter((seq): seq is number => Number.isInteger(seq)));
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqs.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };
    orchestrator.acknowledgeDeliveredMessages = (_agentId: string, seqs: number[]) => {
      const seqSet = new Set(seqs);
      const before = inbox.length;
      for (let index = inbox.length - 1; index >= 0; index -= 1) {
        if (inbox[index]!.seq && seqSet.has(inbox[index]!.seq!)) inbox.splice(index, 1);
      }
      return { removedCount: before - inbox.length };
    };

    const hints = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(hints.status, 200);
    const hintsText = await hints.text();
    assert.doesNotMatch(hintsText, /stale private thread event/);
    const hintsBody = JSON.parse(hintsText) as { wake_hints?: Array<{ seq: number | null }> };
    assert.deepEqual(hintsBody.wake_hints?.map((hint) => hint.seq), [303]);

    const events = await fetch(`${app.baseUrl}/internal/agent-api/events?since=latest`, {
      headers: agentHeaders(fixture.agentApiKey),
    });
    assert.equal(events.status, 200);
    const eventsBody = await events.json() as { events?: Array<{ seq: number; content: string }> };
    assert.deepEqual(eventsBody.events?.map((event) => event.seq), [303]);
    assert.deepEqual(eventsBody.events?.map((event) => event.content), ["queued public event after private parent removal"]);
});

test("agent-api self-leave of a private channel as its last member: refused without deleteIfLast; with it, leaves and purges inbox residue for parent and thread channels", async ({ app }) => {
    const fixture = await seedFixture();
    const privateChannel = await createChannel(fixture.serverId, "agent-api-self-leave-private", "private surface", "private");
    await addAgent(privateChannel.id, fixture.agentId);
    const parentMessage = await createMessage(privateChannel.id, "agent", fixture.agentId, "agent-api private self-leave parent");
    const thread = await getOrCreateThread(parentMessage.id, fixture.agentId, "agent");
    const channelsCredential = await mintAgentCredential({
      agentId: fixture.agentId,
      scopes: ["channels"],
      name: "agent-api-channel-leave-test",
      issuedVia: "computer",
      createdByUserId: null,
    });
    const purges: Array<{ agentId: string; channelIds: string[]; reason?: string }> = [];
    const deliveryAckCalls: Array<{ agentId: string; channelId: string; seq: number }> = [];
    const orchestrator = app.app.get("agentOrchestrator") as {
      purgeAgentInboxForChannelTree: (agentId: string, parentChannelId: string, reason?: string) => Promise<unknown>;
      acknowledgeDeliveredMessagesForChannelUpToSeq?: (agentId: string, channelId: string, seq: number) => unknown;
    };
    orchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq = (agentId, channelId, seq) => {
      deliveryAckCalls.push({ agentId, channelId, seq });
      return { removedCount: 0 };
    };
    orchestrator.purgeAgentInboxForChannelTree = async (agentId, parentChannelId, reason) => {
      const threadChannelIds = await listThreadChannelIdsForParentChannel(parentChannelId);
      purges.push({ agentId, channelIds: [parentChannelId, ...threadChannelIds], reason });
    };

    // The agent is the channel's last member: leaving would delete it, so without deleteIfLast nothing changes.
    const refused = await fetch(`${app.baseUrl}/internal/agent-api/channels/${privateChannel.id}/leave`, {
      method: "POST",
      headers: agentHeaders(channelsCredential.apiKey),
    });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code?: string }).code, "last_member_deletes_channel");
    assert.equal(await isChannelAgent(privateChannel.id, fixture.agentId), true, "the refused leave changed nothing");
    assert.deepEqual(purges, [], "nothing purged on a refused leave");

    const res = await fetch(`${app.baseUrl}/internal/agent-api/channels/${privateChannel.id}/leave`, {
      method: "POST",
      headers: agentHeaders(channelsCredential.apiKey),
      body: JSON.stringify({ deleteIfLast: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok?: boolean; channelDeleted?: boolean; attention?: { stillArrives?: string[]; threadBoundary?: string; manageCommand?: string } };
    assert.equal(body.ok, true);
    assert.equal(body.channelDeleted, true);
    assert.ok(
      body.attention?.stillArrives?.some((line) => /followed threads still notify until you unfollow them/.test(line)),
      "self-leave should warn that public followed threads can still notify",
    );
    assert.match(body.attention?.threadBoundary ?? "", /does not unfollow existing thread follows/);
    assert.match(body.attention?.threadBoundary ?? "", /Private channel\/thread content still requires current parent access/);
    assert.match(body.attention?.manageCommand ?? "", /raft thread unfollow/);
    assert.deepEqual(purges, [{
      agentId: fixture.agentId,
      channelIds: [privateChannel.id, thread.id],
      reason: "channel_membership_removed",
    }]);
    assert.deepEqual(deliveryAckCalls, []);
});

// --- task #wg-external-agent:64-followup — external agent delivery must
// surface /wake-hints through the REAL deliverMessage path. The earlier
// wake-hints test above stubs peekPendingMessages, which is exactly why two
// server-side gaps went unseen in the field: (1) messages to external agents
// were routed into the managed attempt-wake/startAgent path (dropped — the
// daemon cannot spawn runtime "external"), and (2) the machine-online
// auto-assign sweep bound external agents to a machine, violating
// SHA-V0-006C and cementing the managed-path misroute. ---

test("external agent delivery feeds /wake-hints via real deliverMessage and never starts a runtime", async ({ app }) => {
    const db = getDb();
    const suffix = randomUUID();
    const [owner] = await db.insert(users).values({
      email: `ext-wake-${suffix}@slock.test`,
      name: `ext-wake-${suffix}`,
      displayName: "External Wake Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    }).returning();
    const server = await createServer("External Wake Test", `ext-wake-${suffix}`, owner.id);
    const external = await createAgent(server.id, "ExtWakeBot", { runtime: "external", model: "external" });
    const channel = await createChannel(server.id, "ext-wake-room");
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, external.id);
    const minted = await mintAgentCredential({
      agentId: external.id,
      scopes: ["send", "read"],
      name: "ext-wake-test",
      issuedVia: "computer",
      createdByUserId: null,
    });

    // The shared test-app harness stubs the orchestrator (deliverMessage is
    // a no-op there), so swap in a REAL AgentOrchestrator — the point of this
    // regression is exercising the real delivery decision path that the
    // field bug lived in.
    const orchestrator = new AgentOrchestrator() as any;
    app.app.set("agentOrchestrator", orchestrator);
    let startAgentCalls = 0;
    orchestrator.startAgent = async () => {
      startAgentCalls += 1;
      throw new Error("external agent delivery must never start a runtime");
    };

    // External agents receive persisted messages from their durable inbox pull
    // (#8341), so the message must be a real row; CI has no RisingWave, so the
    // chain read is served by the test-only reference derivation of the view.
    const message = await createMessage(channel.id, "user", owner.id, "wake the external agent via real delivery");
    let chainReads = 0;
    __setExternalAgentInboxChainSelectorForTests(async (agentId: string) => {
      chainReads += 1;
      return { source: "chain" as const, rows: await referenceAgentInboxChain(agentId) };
    });
    let res: Response;
    try {
      await orchestrator.deliverMessage(external.id, {
        channel_id: channel.id,
        channel_name: channel.name,
        channel_type: "channel",
        sender_id: owner.id,
        sender_name: owner.name,
        sender_type: "human",
        content: message.content,
        timestamp: message.createdAt.toISOString(),
        seq: message.seq,
        message_id: message.id,
      });

      res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints?since=latest`, {
        headers: { Authorization: `Bearer ${minted.apiKey}` },
      });
    } finally {
      __setExternalAgentInboxChainSelectorForTests(null);
    }
    assert.equal(res.status, 200);
    const body = await res.json() as { wake_hints?: Array<{ message_id?: string; seq?: number | null }> };
    assert.ok(
      body.wake_hints?.some((hint) => hint.message_id === message.id && hint.seq === message.seq),
      `expected a wake hint for the persisted delivery, got ${JSON.stringify(body)}`,
    );
    assert.ok(chainReads >= 1, "wake hints must read the durable inbox chain");

    assert.equal(startAgentCalls, 0, "external agent delivery must never reach startAgent");

    const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, external.id));
    assert.equal(row!.machineId, null, "external agent must remain machine-unassigned after delivery");
});

test("machine auto-assign sweep skips external agents (SHA-V0-006C)", async ({ app }) => {
    const db = getDb();
    const suffix = randomUUID();
    const [owner] = await db.insert(users).values({
      email: `ext-assign-${suffix}@slock.test`,
      name: `ext-assign-${suffix}`,
      displayName: "External Assign Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    }).returning();
    const server = await createServer("External Assign Test", `ext-assign-${suffix}`, owner.id);
    const managed = await createAgent(server.id, "ManagedBot", { runtime: "claude", model: "sonnet" });
    const external = await createAgent(server.id, "ExtAssignBot", { runtime: "external", model: "external" });

    const [machineRow] = await db.insert(machinesTable).values({
      serverId: server.id,
      userId: owner.id,
      name: `ext-assign-machine-${suffix}`,
      apiKeyHash: await argon2.hash(`sk_machine_${suffix}`),
    }).returning();
    await autoAssignMachine(server.id, machineRow!.id);

    const rows = await db.select().from(agentsTable).where(eq(agentsTable.serverId, server.id));
    const managedRow = rows.find((r) => r.id === managed.id);
    const externalRow = rows.find((r) => r.id === external.id);
    assert.ok(managedRow!.machineId, "managed BYOC agent should be auto-assigned");
    assert.equal(externalRow!.machineId, null, "external agent must NOT be auto-assigned a machine");
});

// --- Task #41 (post-review shape): the hold reports, in the moment, the true
// count of skipped messages and the anchor to browse older — no persistent
// read-debt bookkeeping (tygg: silent read-through is correct chat semantics;
// the honest sentence is enough). Seq-sparse fixture so a span-as-count
// regression cannot pass as the true count. ---

test("held response carries true skipped count and the --before anchor, no debt bookkeeping", async ({ app }) => {
    const fixture = await seedFixture();
    // Sparse seqs: spacers in a second channel keep span >> count.
    const otherChannel = await createChannel(fixture.serverId, `skip-noise-${Date.now()}`);
    const baseline = await sendHumanMessage(fixture, "skip baseline");
    const planted: Array<{ id: string; seq: number }> = [];
    for (let i = 1; i <= 5; i++) {
      for (let j = 0; j < 3; j++) {
        await createMessage(otherChannel.id, "user", fixture.ownerId, `seq spacer ${i}-${j}`);
      }
      planted.push(await sendHumanMessage(fixture, `skip fact ${i}`));
    }

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "stale reply",
      seenUpToSeq: baseline.seq,
    });
    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.newMessageCount, 5);
    assert.equal(held.body.shownMessageCount, 3);
    // True count of skipped messages (attention semantics), never the seq span.
    assert.equal(held.body.omittedMessageCount, 2);
    const span = planted[1]!.seq - planted[0]!.seq + 1;
    assert.ok(span > 2, "fixture must be seq-sparse so span != count");
    // Anchor for browsing older: lowest displayed seq.
    assert.equal(held.body.firstShownSeq, planted[2]!.seq);
    // Deliberate absence pins (final-review contract): the deleted debt
    // bookkeeping must not quietly return to the wire.
    assert.equal(held.body.neverShownRange, undefined);
    assert.equal(held.body.neverShownCount, undefined);
});


/**
 * The held response on a THREAD target fetches the thread-top anchor
 * (#7262 digest). getThreadParentMessage carried a latent runtime
 * `operator does not exist: uuid = text` — a 500 on every thread hold —
 * that no test executed. Field signature: thread-clustered send UNKNOWNs
 * while DMs pass. This case is the executable pin: a thread hold must
 * render (200), and the anchor's sender name must resolve via the cast
 * join. Mutation-verified: reverting the cast turns it red.
 */
test("agent-api thread hold renders with a resolved thread-top sender (uuid=text regression)", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "please track delivery test coverage in this thread");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, parent.seq);
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const firstReply = await createMessage(thread.id, "user", fixture.ownerId, "first thread reply the agent has not seen");

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
      content: "stale thread reply",
      seenUpToSeq: parent.seq,
    });

    assert.equal(held.status, 200, "a thread hold must render, not 500");
    assert.equal(held.body.state, "held");
    assert.equal(held.body.heldMessages[0].id, firstReply.id);
    const anchor = held.body.threadParentMessage as Record<string, unknown> | undefined;
    assert.ok(anchor, "thread hold must carry threadParentMessage");
    assert.equal(anchor.messageId, parent.id);
    assert.equal(anchor.seq, parent.seq);
    assert.equal(anchor.senderName, fixture.ownerName);
  } finally {
    await app.close();
  }
});

/**
 * DM-thread twin of the channel-thread hold pin (#7349 follow-up).
 * getThreadParentMessage keys on channels.type='thread' regardless of the
 * parent surface, so the uuid=text join broke DM threads identically —
 * field-confirmed (Gogo, 2026-09-04 15:05: dm thread CHECK_FAILED while
 * DM top-level passed in the same minute). One executable pin per thread
 * kind: a stale reply into a DM thread must render a hold (200), with
 * the thread-top sender resolved through the cast join.
 */
test("agent-api DM-thread hold renders with a resolved thread-top sender (uuid=text regression)", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fixture = await seedFixture();
    const dm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
    assert.ok(dm, "expected owner-agent DM to exist");
    const parent = await createMessage(dm.id, "user", fixture.ownerId, "DM thread parent: please follow up here");
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    const firstReply = await createMessage(thread.id, "user", fixture.ownerId, "first DM-thread reply the agent has not seen");

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `dm:@${fixture.ownerName}:${parent.id.slice(0, 8)}`,
      content: "stale DM-thread reply",
      seenUpToSeq: parent.seq,
    });

    assert.equal(held.status, 200, "a DM-thread hold must render, not 500");
    assert.equal(held.body.state, "held");
    assert.equal(held.body.heldMessages[0].id, firstReply.id);
    const anchor = held.body.threadParentMessage as Record<string, unknown> | undefined;
    assert.ok(anchor, "DM-thread hold must carry threadParentMessage");
    assert.equal(anchor.messageId, parent.id);
    assert.equal(anchor.seq, parent.seq);
    assert.equal(anchor.senderName, fixture.ownerName);
  } finally {
    await app.close();
  }
});

function deadlockDetected(): Error {
  // What node-postgres surfaces when PostgreSQL picks this transaction as the deadlock victim.
  return Object.assign(new Error("deadlock detected"), { code: "40P01" });
}

test("agent-api send re-runs a deadlock-aborted send transaction once and commits exactly one message", async ({ app }) => {
  const fixture = await seedFixture();
  const registry = new InMemoryFailpointRegistry();
  // Fires after the message, mentions and inbox facts are written, so the retry
  // proves the rolled-back attempt leaves nothing behind.
  registry.configure("server.message.newChatTransaction.afterFacts", {
    mode: "once",
    effect: "throw",
    payload: deadlockDetected(),
  });
  __setFailpointsForTests(registry);
  const idempotencyKey = randomUUID();

  const sent = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "survives one deadlock",
    idempotencyKey,
    seenUpToSeq: 0,
  });

  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.state, "sent");
  const persisted = await getDb().select().from(messages).where(eq(messages.agentSendKey, idempotencyKey));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.id, sent.body.messageId);
});

test("agent-api send answers 503 with retry guidance (never 500) when every attempt deadlocks", async ({ app }) => {
  const fixture = await seedFixture();
  const registry = new InMemoryFailpointRegistry();
  registry.configure("server.message.newChatTransaction.afterFacts", {
    mode: "always",
    effect: "throw",
    payload: deadlockDetected(),
  });
  __setFailpointsForTests(registry);
  const idempotencyKey = randomUUID();

  for (const send of [sendViaAgentApi, sendViaAgentApiV2]) {
    const sent = await send(app.baseUrl, fixture, {
      target: `#${fixture.channelName}`,
      content: "never commits",
      idempotencyKey,
      seenUpToSeq: 0,
    });
    assert.equal(sent.status, 503);
    assert.equal(sent.body.code, "send_transient_conflict");
    assert.equal(sent.body.retryable, true);
    assert.match(sent.body.suggestedNextAction, /idempotencyKey/);
  }
  assert.equal((await getDb().select().from(messages).where(eq(messages.agentSendKey, idempotencyKey))).length, 0);

  // The client retry with the same key then commits normally.
  __resetFailpointsForTests();
  const retried = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "never commits",
    idempotencyKey,
    seenUpToSeq: 0,
  });
  assert.equal(retried.status, 200);
});

/**
 * Held send context must name its conversation. The held envelopes are built
 * from bare message rows; without `channel_type`/`channel_name` (and
 * `parent_channel_name` for threads) client SDKs filter them out through
 * hasAgentMessageIdentity, so the agent was told "N new messages" and shown 0.
 */
function assertHeldIdentity(
  heldMessages: Array<Record<string, unknown>>,
  expected: Record<string, unknown>,
) {
  assert.ok(heldMessages.length > 0, "expected held context");
  for (const message of heldMessages) {
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(message[key], value, `held envelope ${key}`);
    }
    assert.equal(hasAgentMessageIdentity(message), true, "held envelope must carry a conversation identity");
  }
}

test("agent-api held context on a channel target carries the channel identity", async ({ app }) => {
  const fixture = await seedFixture();
  const baseline = await sendHumanMessage(fixture, "baseline");
  await sendHumanMessage(fixture, "fresh one");
  await sendHumanMessage(fixture, "fresh two");

  const held = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "stale channel draft",
    seenUpToSeq: baseline.seq,
  });

  assert.equal(held.status, 200);
  assert.equal(held.body.state, "held");
  assert.equal(held.body.heldMessages.length, 2);
  assertHeldIdentity(held.body.heldMessages, {
    channel_type: "channel",
    channel_name: fixture.channelName,
  });
});

test("agent-api held context on a DM target carries the agent-facing peer name", async ({ app }) => {
  const fixture = await seedFixture();
  const dm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
  assert.ok(dm, "expected owner-agent DM to exist");
  const baseline = await createMessage(dm.id, "user", fixture.ownerId, "dm baseline");
  const fresh = await createMessage(dm.id, "user", fixture.ownerId, "dm fresh the agent has not seen");
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: fixture.agentId,
    serverId: fixture.serverId,
    kind: "dm",
    sourceChannelId: dm.id,
    messageId: fresh.id,
    messageSeq: fresh.seq,
    activityAt: fresh.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);

  const held = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `dm:@${fixture.ownerName}`,
    content: "stale dm draft",
    seenUpToSeq: baseline.seq,
  });

  assert.equal(held.status, 200);
  assert.equal(held.body.state, "held");
  assert.deepEqual(held.body.heldMessages.map((message: { id: string }) => message.id), [fresh.id]);
  assertHeldIdentity(held.body.heldMessages, {
    channel_type: "dm",
    channel_name: fixture.ownerName,
  });
});

test("agent-api held context on channel and DM thread targets carries the parent identity", async ({ app }) => {
  const fixture = await seedFixture();
  const parent = await sendHumanMessage(fixture, "channel thread parent");
  const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
  await createMessage(thread.id, "user", fixture.ownerId, "channel thread reply");

  const heldChannelThread = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
    content: "stale channel thread reply",
    seenUpToSeq: parent.seq,
  });
  assert.equal(heldChannelThread.status, 200);
  assert.equal(heldChannelThread.body.state, "held");
  assertHeldIdentity(heldChannelThread.body.heldMessages, {
    channel_type: "thread",
    parent_channel_type: "channel",
    parent_channel_name: fixture.channelName,
  });

  const dm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
  assert.ok(dm, "expected owner-agent DM to exist");
  const dmParent = await createMessage(dm.id, "user", fixture.ownerId, "dm thread parent");
  const dmThread = await getOrCreateThread(dmParent.id, fixture.ownerId, "user");
  await createMessage(dmThread.id, "user", fixture.ownerId, "dm thread reply");

  const heldDmThread = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `dm:@${fixture.ownerName}:${dmParent.id.slice(0, 8)}`,
    content: "stale dm thread reply",
    seenUpToSeq: dmParent.seq,
  });
  assert.equal(heldDmThread.status, 200);
  assert.equal(heldDmThread.body.state, "held");
  assertHeldIdentity(heldDmThread.body.heldMessages, {
    channel_type: "thread",
    parent_channel_type: "dm",
    parent_channel_name: fixture.ownerName,
  });
});

test("agent-api held context on a joint channel uses the local projection name", async ({ app }) => {
  const fixture = await seedFixture();
  const db = getDb();
  const host = await createServer("Held Joint Host", `held-joint-host-${randomUUID()}`, fixture.ownerId);
  const [canonical, hostLocal, local] = await db.insert(channels).values([
    { serverId: host.id, name: "held-joint-canonical", type: "joint" },
    { serverId: host.id, name: "held-joint-host", type: "joint" },
    { serverId: fixture.serverId, name: "held-joint-local", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical!.id,
    createdByServerId: host.id,
    createdByUserId: fixture.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: fixture.ownerId },
    { jointChannelId: joint!.id, serverId: fixture.serverId, localChannelId: local!.id, role: "participant", status: "active", joinedByUserId: fixture.ownerId },
  ]);
  await db.insert(channelAgents).values({ channelId: local!.id, agentId: fixture.agentId });

  const baseline = await createMessage(canonical!.id, "user", fixture.ownerId, "joint baseline");
  const fresh = await createMessage(canonical!.id, "user", fixture.ownerId, "joint fresh");
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: fixture.agentId,
    serverId: fixture.serverId,
    kind: "channel",
    sourceChannelId: local!.id,
    messageId: fresh.id,
    messageSeq: fresh.seq,
    activityAt: fresh.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);

  const held = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${local!.name}`,
    content: "stale joint draft",
    seenUpToSeq: baseline.seq,
  });

  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.state, "held");
  assert.deepEqual(held.body.heldMessages.map((message: { id: string }) => message.id), [fresh.id]);
  assertHeldIdentity(held.body.heldMessages, {
    channel_type: "channel",
    channel_name: local!.name,
  });
});

// A Free server's 30-day history window (services/historyWindow.ts): what it
// hides can never be shown to the agent, so it is never unseen.
test("agent-api send into a Free channel whose messages are all behind the history window is not held for them", async ({ app }) => {
  const fixture = await seedFixture();
  const old = await sendHumanMessage(fixture, "a decision from two months ago");
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);

  const sent = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "first word here in a while",
    seenUpToSeq: 0,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.state, "sent");

  // A message inside the window is unseen as before.
  await sendHumanMessage(fixture, "a new question");
  const held = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "answer without reading",
    seenUpToSeq: 0,
  });
  assert.equal(held.body.state, "held");
  assert.deepEqual(held.body.heldMessages.map((message: { content?: string }) => message.content), ["a new question"]);
});

// Where seq does not follow created_at (an external projection keeps its
// source's time, a replayed send its own), the window still goes by time.
test("agent-api send is held for a recent message even when a message behind the window has a higher seq", async ({ app }) => {
  const fixture = await seedFixture();
  await sendHumanMessage(fixture, "a question from this morning");
  const imported = await sendHumanMessage(fixture, "an imported message from two months ago");
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${imported.id}::uuid`);

  const held = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "answer without reading",
    seenUpToSeq: 0,
  });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.state, "held");
  assert.deepEqual(held.body.heldMessages.map((message: { content?: string }) => message.content), ["a question from this morning"]);
});

test("agent-api send is not held by messages behind the window, whatever their seq order", async ({ app }) => {
  const fixture = await seedFixture();
  const older = await sendHumanMessage(fixture, "imported, from 40 days ago");
  const oldest = await sendHumanMessage(fixture, "imported, from 50 days ago");
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${older.id}::uuid`);
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '50 days' WHERE id = ${oldest.id}::uuid`);

  const sent = await sendViaAgentApi(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "first word here in a while",
    seenUpToSeq: 0,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.state, "sent");
});

test("agent-api thread hold leaves out a thread start behind the Free history window", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fixture = await seedFixture();
    const parent = await sendHumanMessage(fixture, "the plan from two months ago");
    await markAgentLegacyRead(fixture.agentId, fixture.channelId, parent.seq);
    const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
    await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${parent.id}::uuid`);
    const reply = await createMessage(thread.id, "user", fixture.ownerId, "picking this back up today");

    const held = await sendViaAgentApi(app.baseUrl, fixture, {
      target: `#${fixture.channelName}:${parent.id.slice(0, 8)}`,
      content: "stale thread reply",
      seenUpToSeq: parent.seq,
    });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.equal(held.body.state, "held");
    assert.equal(held.body.heldMessages[0].id, reply.id);
    assert.equal(held.body.threadParentMessage, undefined, "the thread start is behind the window");
  } finally {
    await app.close();
  }
});
