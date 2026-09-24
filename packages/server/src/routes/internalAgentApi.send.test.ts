import { openTestApp } from "../test/integration/app.js";
import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach } from "vitest";

import argon2 from "argon2";
import { desc, eq } from "drizzle-orm";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  BasicTracer,
  InMemoryFailpointRegistry,
  MemoryTraceSink,
  type AgentMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import { agents as agentsTable, attachments, attestedSendEvents, channelAgents, channels, machines as machinesTable, messageMentions, messages, serverAgentMembers, serverMembers, servers as serversTable, threadFollows, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { autoAssignMachine, createAgent } from "../services/agentService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { createChannel, addAgent, addHuman, markAgentLegacyRead, getAgentLegacyReadCursor, getAgentUnreadCounts, getOrCreateThread, findOrCreateDM, removeAgent, listThreadChannelIdsForParentChannel, setInboxTargetActivityMuteState } from "../services/channelService.js";
import { broadcastAndDeliver, createMessage, __resetMessageServiceDepsForTests, __setMessageServiceDepsForTests } from "../services/messageService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService.js";
import * as attestedSendService from "../services/attestedSendService.js";
import * as taskService from "../services/taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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

test("agent-api channel first post returns recent-join drive-by attention once", async ({ app }) => {
    const fixture = await seedFixture();

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
      content: "external `@DefinitelyMissingAgent` and ```txt\n@AnotherMissingAgent\n```",
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
      "message_pipeline.push_targets.built",
      "agent_api_send.commit.finished",
      "response.ready",
    ]) {
      assert.ok(eventNames.includes(expected), `expected trace event ${expected}`);
    }

    const started = span.events.find((event) => event.name === "agent_api_send.request.started");
    assert.ok(started);
    assert.equal(started.attrs?.target_kind, "channel_thread");
    assert.equal(started.attrs?.attachment_count, 0);
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

test("agent-api thread send stays successful when follower projection fails after persistence", async ({ app }) => {
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
    const persistedIndex = span.events.findIndex((event) => event.name === "message_pipeline.message.persisted");
    const degraded = span.events.filter((event) => event.name === "message_pipeline.post_persist_side_effect.degraded");
    assert.ok(persistedIndex >= 0);
    assert.equal(degraded.length, 1);
    for (const event of degraded) {
      assert.ok(span.events.indexOf(event) > persistedIndex);
      assert.equal(event.attrs?.durable_message_present, true);
      assert.equal(event.attrs?.failure_policy, "continue_after_persist");
      assert.equal(event.attrs?.query_name, "thread_follows.eligible_followers");
      assert.equal(event.attrs?.sqlstate, "57014");
    }
});

test("agent-api thread send stays successful when same-send unfollow lookup fails after persistence", async ({ app }) => {
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
    const persistedIndex = span.events.findIndex((event) => event.name === "message_pipeline.message.persisted");
    const degraded = span.events.filter((event) =>
      event.name === "message_pipeline.post_persist_side_effect.degraded"
      && event.attrs?.query_name === "thread_follows.same_send_candidates"
    );
    assert.ok(persistedIndex >= 0);
    assert.equal(degraded.length, 1);
    assert.ok(span.events.indexOf(degraded[0]!) > persistedIndex);
    assert.equal(degraded[0]?.attrs?.durable_message_present, true);
    assert.equal(degraded[0]?.attrs?.persistence_state, "committed");
    assert.equal(degraded[0]?.attrs?.failure_policy, "continue_after_persist");
    assert.equal(degraded[0]?.attrs?.sqlstate, "XX000");
    assert.equal(JSON.stringify(degraded[0]?.attrs).includes("follower_type"), false);
});

test("agent-api send rejects attachment IDs already linked to another message", async ({ app }) => {
    const fixture = await seedFixture();
    const existingMessage = await sendHumanMessage(fixture, "message with original attachment");
    const [attachment] = await getDb().insert(attachments).values({
      messageId: existingMessage.id,
      channelId: fixture.channelId,
      uploaderId: fixture.agentId,
      uploaderType: "agent",
      filename: "already-linked.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      storageKey: `${fixture.serverId}/already-linked.txt`,
    }).returning();

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
    assert.match(denied.body.error, /not a member of the parent channel/);
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
    assert.match(denied.body.error, /Thread target not found or not replyable/);
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
    assert.match(missing.body.error, /Thread target not found or not replyable/);
    assert.match(missing.body.error, /parent message must exist/);
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
        target: string;
        wake_reason: string;
        content?: string;
      }>;
    };
    assert.deepEqual(firstBody.wake_hints?.map((hint) => hint.seq), [201]);
    assert.equal(firstBody.wake_hints?.[0]?.event_id, "wake-hint:wake-message-1");
    assert.equal(firstBody.wake_hints?.[0]?.message_id, "wake-message-1");
    assert.equal(firstBody.wake_hints?.[0]?.target, `channelId:${fixture.channelId}`);
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
    const orchestrator = {
      deliverMessage: async (agentId: string, message: AgentMessage) => {
        delivered.set(agentId, [...(delivered.get(agentId) ?? []), message]);
        return { status: "queued", reason: "replayable_inbox" } as const;
      },
    } as AgentOrchestrator;

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

    const muteDeliveryOrchestrator = {
      deliverMessage: async () => {},
    } as unknown as AgentOrchestrator;
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
    const unreadCounts = await getAgentUnreadCounts(fixture.agentId);
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
      const unreadCounts = await getAgentUnreadCounts(fixture.agentId);
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

test("agent-api self-leave purges private channel inbox residue for parent and thread channels", async ({ app }) => {
    const fixture = await seedFixture();
    const privateChannel = await createChannel(fixture.serverId, "agent-api-self-leave-private", "private surface", "private");
    await addAgent(privateChannel.id, fixture.agentId);
    const parentMessage = await createMessage(privateChannel.id, "agent", fixture.agentId, "agent-api private self-leave parent");
    const thread = await getOrCreateThread(parentMessage.id, fixture.agentId, "agent");
    const channelsCredential = await mintAgentCredential({
      agentId: fixture.agentId,
      scopes: ["channels"],
      name: "agent-api-channel-leave-test",
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

    const res = await fetch(`${app.baseUrl}/internal/agent-api/channels/${privateChannel.id}/leave`, {
      method: "POST",
      headers: agentHeaders(channelsCredential.apiKey),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok?: boolean; attention?: { stillArrives?: string[]; threadBoundary?: string; manageCommand?: string } };
    assert.equal(body.ok, true);
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

    await orchestrator.deliverMessage(external.id, {
      channel_id: channel.id,
      channel_name: channel.name,
      channel_type: "channel",
      sender_id: owner.id,
      sender_name: owner.name,
      sender_type: "human",
      content: "wake the external agent via real delivery",
      timestamp: new Date().toISOString(),
      seq: 301,
      message_id: `ext-wake-msg-${suffix}`,
    });

    const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints?since=latest`, {
      headers: { Authorization: `Bearer ${minted.apiKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { wake_hints?: Array<{ message_id?: string; seq?: number | null }> };
    assert.ok((body.wake_hints?.length ?? 0) >= 1, `expected at least one wake hint, got ${JSON.stringify(body)}`);

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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
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
