import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import { afterEach } from "vitest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink, MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER } from "@botiverse/raft-shared";
import { buildNotificationPushProjectionTargets, buildNotificationPushSocketTargets, buildPushTargetsFromContext, broadcastAndDeliver, broadcastSystemMessage, createMessage, deliverMessageToAgent, deliverMessageToAgents, emitExternalProjectionMessageToFrontend, emitExternalReactionMessageUpdateToFrontend, getAgentResumeCatchupMessages, getSenderPendingMentionActions, getSenderReadReceiptInFlightCountForTests, planDirectMentionThreadFollow, registerSenderReadReceiptForTests, selectCanonicalWebPushProjectionTargets, __resetMessageServiceDepsForTests, __setMessageServiceDepsForTests } from "./messageService.js";
import { __resetAgentSendReplayDbForTests, __setAgentSendReplayDbForTests } from "./agentSendReplayService.js";
import { CompatibilityReadMutationPendingError } from "./readMutationSequencer.js";
import { recordInboxNotificationFacts } from "./inboxNotificationService.js";
import { ensureMentionDeliveryOccurrences, listRecoverableMentionDeliveriesForAgent } from "./mentionDeliveryOccurrenceService.js";
import { socketClientKindRoom } from "../socket/platformScope.js";
import { getActiveJointChannelProjectionsByLocalChannel, getActiveJointThreadProjectionsByCanonicalThread, getAgentUnreadCounts, getJointThreadProjectionForMember, getOrCreateThread } from "./channelService.js";
import * as taskService from "./taskService.js";
import { closeDatabase, getDb } from "../db/index.js";
import { agents, agentChannelReadCursors, attachments, channelAgents, channelHumans, channels, externalActorProjections, externalMessageLinks, externalProjectionAvatarArtifacts, externalReactionStates, inboxNotificationFacts, inboxServingRows, inboxTargetMuteStates, jointChannels, jointChannelServers, mentionDeliveryOccurrences, messageMentions, messages, serverMembers, servers, threadFollows, users } from "../db/schema.js";
import { insertCanonicalExternalMessage } from "./externalProjectionService.js";
import { withTraceRoot } from "../tracing/semanticTrace.js";
import { summarizePushBody } from "./pushDisplay.js";


afterEach(() => {
  __resetMessageServiceDepsForTests();
  __resetAgentSendReplayDbForTests();
});

test("direct mention follow transition distinguishes absent, active, done, and explicit-unfollow states", () => {
  assert.deepEqual(planDirectMentionThreadFollow(undefined), {
    shouldActivate: true,
    reactivatedExplicitUnfollow: false,
  });
  assert.deepEqual(planDirectMentionThreadFollow({ doneAt: null, unfollowedAt: null }), {
    shouldActivate: false,
    reactivatedExplicitUnfollow: false,
  });
  assert.deepEqual(planDirectMentionThreadFollow({ doneAt: new Date(1), unfollowedAt: null }), {
    shouldActivate: true,
    reactivatedExplicitUnfollow: false,
  });
  assert.deepEqual(planDirectMentionThreadFollow({ doneAt: new Date(1), unfollowedAt: new Date(2) }), {
    shouldActivate: true,
    reactivatedExplicitUnfollow: true,
  });
});

function createAgentSendReplayDb() {
  let seq = 100;
  let insertAttempts = 0;
  let insertedRows = 0;
  const byKey = new Map<string, any>();

  const tx = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  insertAttempts += 1;
                  if (table !== messages) return Promise.resolve([]);
                  const senderId = String(values.senderId);
                  const agentSendKey = String(values.agentSendKey);
                  const key = `${senderId}:${agentSendKey}`;
                  const existing = byKey.get(key);
                  if (existing) return Promise.resolve([]);

                  const createdAt = new Date(`2026-04-17T00:00:${String(seq - 99).padStart(2, "0")}.000Z`);
                  const row = {
                    id: `msg-${seq}`,
                    seq,
                    channelId: values.channelId,
                    senderType: "agent",
                    senderId,
                    agentSendKey,
                    messageType: "chat",
                    content: values.content,
                    searchText: values.searchText ?? values.content,
                    searchVector: null,
                    threadId: null,
                    taskStatus: null,
                    taskNumber: null,
                    taskAssigneeType: null,
                    taskAssigneeId: null,
                    taskClaimedAt: null,
                    taskCompletedAt: null,
                    createdAt,
                    updatedAt: createdAt,
                  };
                  byKey.set(key, row);
                  seq += 1;
                  insertedRows += 1;
                  return Promise.resolve([row]);
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  if (table === attachments) return Promise.resolve([]);
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from(table: unknown) {
          const makeAfterWhere = (rows: unknown[]) => ({
            limit() {
              return Promise.resolve(rows);
            },
            orderBy() {
              return Promise.resolve(rows);
            },
            then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
              return Promise.resolve(rows).then(resolve, reject);
            },
          });
          return {
            leftJoin() {
              return {
                where() {
                  return makeAfterWhere([]);
                },
              };
            },
            where() {
              const rows = table === messages ? [...byKey.values()] : [];
              return makeAfterWhere(rows);
            },
          };
        },
      };
    },
  };

  return {
    db: {
      transaction: async (fn: (tx: any) => Promise<unknown>) => fn(tx),
    },
    stats() {
      return { insertAttempts, insertedRows };
    },
  };
}

function createIoRecorder() {
  const events: { room: string; event: string; payload: any }[] = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: any) {
          events.push({ room, event, payload });
        },
      };
    },
    in() {
      return {
        in() {
          return {
            socketsJoin() {},
          };
        },
        socketsJoin() {},
      };
    },
  };
  return { io: io as any, events };
}

async function seedSlackReactionForMessage(input: {
  messageId: string;
  projectionId: string;
  key: string;
}) {
  const db = getDb();
  const [link] = await db.insert(externalMessageLinks).values({
    provider: "slack",
    installId: "install-1",
    providerAuthorityId: "workspace-1",
    providerConversationId: `conversation-${input.key}`,
    providerMessageId: `message-${input.key}`,
    bindingId: "binding-1",
    bindingEpoch: 1,
    connectionEpoch: 1,
    raftMessageId: input.messageId,
    firstDirection: "raft_outbound",
    payloadFingerprint: "d".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
  }).returning();
  await db.insert(externalReactionStates).values({
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    connectionEpoch: 1,
    bindingId: "binding-1",
    bindingEpoch: 1,
    messageLinkId: link.id,
    raftMessageId: input.messageId,
    projectionId: input.projectionId,
    providerReactionKey: "eyes",
    canonicalEmoji: "👀",
    mappingRevision: 1,
    present: true,
    lastProviderEventId: `event-${input.key}`,
    lastEventAt: new Date("2026-09-05T14:02:00.000Z"),
    lastEventSequence: 1,
  });
}

async function waitForTestSignal(signal: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
  });
  try {
    await Promise.race([signal, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertThreadRepliesSyncWindow(
  payload: any,
  expected: {
    serverId: string;
    parentMessageId: string;
    parentScopeKind: string;
    parentScopeId: string;
  },
) {
  const envelope = payload.syncCoreReplyWindow;
  assert.ok(envelope, "thread:updated must carry the replies sync-core producer envelope");
  assert.equal(envelope.producer, MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER);
  assert.deepEqual(envelope.discussion?.root, {
    kind: "message",
    serverId: expected.serverId,
    id: expected.parentMessageId,
  });
  assert.deepEqual(envelope.discussion?.relation, { kind: "replies" });
  assert.equal(envelope.discussion?.backing, "sync-scope");
  assert.deepEqual(envelope.discussion?.parentScopeKey, {
    serverId: expected.serverId,
    scopeKind: expected.parentScopeKind,
    scopeId: expected.parentScopeId,
  });
  assert.deepEqual(envelope.window, {
    kind: "sync-scope-window",
    scopeCursor: null,
    epoch: null,
  });
}

function makePersistedMessage(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date("2026-07-07T13:40:00.000Z");
  return {
    id: "msg-1",
    seq: 1,
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    content: "hello",
    searchText: "hello",
    searchVector: null,
    messageType: "chat",
    threadId: null,
    taskStatus: null,
    taskNumber: null,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

test("broadcastAndDeliver traces the failing persistence phase with safe PostgreSQL attribution", async () => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const pgError = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  const insertError = new Error("Failed query: insert into messages params: private-message-body", { cause: pgError });

  __setMessageServiceDepsForTests({
    createMessage: async () => { throw insertError; },
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    assertChannelNotArchived: async () => undefined,
  });

  const { io } = createIoRecorder();
  await assert.rejects(
    () => withTraceRoot(tracer, "server.http.request", { surface: "server", kind: "server" }, () =>
      broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
        channelId: "channel-1",
        senderType: "user",
        senderId: "user-1",
        senderName: "Ray",
        content: "private-message-body",
      })),
    insertError,
  );

  const [span] = sink.getAllSpans();
  const failed = span?.events.find((event) => event.name === "message_pipeline.db_phase.failed");
  assert.ok(failed);
  assert.equal(failed.attrs?.phase, "message_pipeline.persist");
  assert.equal(failed.attrs?.query_name, "messages.direct_send_insert");
  assert.equal(failed.attrs?.db_operation, "insert");
  assert.equal(failed.attrs?.peer_service, "postgresql");
  assert.equal(failed.attrs?.sqlstate, "57014");
  assert.equal(failed.attrs?.timeout_subkind, "query_canceled");
  assert.equal(failed.attrs?.error_message, "canceling statement due to statement timeout");
  assert.equal(JSON.stringify(failed.attrs).includes("private-message-body"), false);
});

test("closeDatabase waits for broadcastAndDeliver sender read receipt before pglite close", async ({ db }) => {

  let releaseReadReceipt: () => void = () => {};
  let closePromise: Promise<void> | null = null;
  try {
    const pendingReadReceipt = new Promise<{ maxReadSeq: number; changed: boolean }>((resolve) => {
      releaseReadReceipt = () => resolve({ maxReadSeq: 101, changed: true });
    });

    __setMessageServiceDepsForTests({
      createMessage: async (channelId, senderType, senderId, content, messageType = "chat") => makePersistedMessage({
        id: "pending-sender-read-message",
        seq: 101,
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any,
      getChannel: async (channelId: string) => ({
        id: channelId,
        serverId: "server-1",
        type: "channel",
        name: "engineering",
        parentMessageId: null,
      } as any),
      getChannelHumans: async () => [],
      getChannelAgents: async () => [],
      getChannelMembers: async () => ({ agents: [], humans: [] }),
      markRead: async () => pendingReadReceipt,
      assertChannelNotArchived: async () => undefined,
      renderAgentReadablePermalinks: async (content: string) => content,
      getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
        uniqueName: fallbackName,
        description: null,
      }),
      buildPushTargets: async () => new Map(),
      sendPushNotifications: async () => undefined,
    });

    const { io } = createIoRecorder();
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "pending sender read receipt",
    });
    assert.equal(getSenderReadReceiptInFlightCountForTests(), 1);

    let closeResolved = false;
    closePromise = closeTestDatabase().then(() => {
      closeResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(closeResolved, false, "closeDatabase must wait for the broadcastAndDeliver sender read receipt before pglite close");

    releaseReadReceipt();
    await closePromise;
    assert.equal(closeResolved, true);
    assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);
  } finally {
    releaseReadReceipt();
    if (closePromise) await closePromise.catch(() => {});
    else await closeTestDatabase().catch(() => {});
  }
});

test("closeDatabase surfaces test-registered sender read receipt failures", async ({ db }) => {

  const readReceiptFailure = new Error("synthetic test sender read failure");
  try {
    registerSenderReadReceiptForTests(Promise.reject(readReceiptFailure));
    assert.equal(getSenderReadReceiptInFlightCountForTests(), 1);

    await assert.rejects(
      closeDatabase(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "sender read receipt lifecycle rejected while draining");
        assert.ok(error.errors.includes(readReceiptFailure));
        return true;
      },
    );
    assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);
  } finally {
    await closeDatabase().catch(() => {});
  }
});

test("broadcastAndDeliver sender read receipt failures do not retain production errors for test drain", async ({ db }) => {

  const readReceiptFailure = new Error("synthetic broadcast sender read failure");
  try {
    __setMessageServiceDepsForTests({
      createMessage: async (channelId, senderType, senderId, content, messageType = "chat") => makePersistedMessage({
        id: "failed-sender-read-message",
        seq: 102,
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any,
      getChannel: async (channelId: string) => ({
        id: channelId,
        serverId: "server-1",
        type: "channel",
        name: "engineering",
        parentMessageId: null,
      } as any),
      getChannelHumans: async () => [],
      getChannelAgents: async () => [],
      getChannelMembers: async () => ({ agents: [], humans: [] }),
      markRead: async () => Promise.reject(readReceiptFailure),
      assertChannelNotArchived: async () => undefined,
      renderAgentReadablePermalinks: async (content: string) => content,
      getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
        uniqueName: fallbackName,
        description: null,
      }),
      buildPushTargets: async () => new Map(),
      sendPushNotifications: async () => undefined,
    });

    const { io } = createIoRecorder();
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "failed sender read receipt",
    });

    await closeTestDatabase();
    assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);
  } finally {
    await closeTestDatabase().catch(() => {});
  }
});

test("broadcastAndDeliver swallows typed pending sender read receipts on the production path", async ({ db }) => {

  const pending = new CompatibilityReadMutationPendingError(
    "server-1",
    "user-1",
    "00000000-0000-4000-8000-000000000123",
    103,
  );
  const originalWarn = console.warn;
  const senderWarnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    if (args[0] === "[MessageService] sender read receipt remains pending") {
      senderWarnings.push(args);
      return;
    }
    originalWarn(...args);
  };
  try {
    __setMessageServiceDepsForTests({
      createMessage: async (channelId, senderType, senderId, content, messageType = "chat") => makePersistedMessage({
        id: "pending-compat-sender-read-message",
        seq: 103,
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any,
      getChannel: async (channelId: string) => ({
        id: channelId,
        serverId: "server-1",
        type: "channel",
        name: "engineering",
        parentMessageId: null,
      } as any),
      getChannelHumans: async () => [],
      getChannelAgents: async () => [],
      getChannelMembers: async () => ({ agents: [], humans: [] }),
      markRead: async () => Promise.reject(pending),
      assertChannelNotArchived: async () => undefined,
      renderAgentReadablePermalinks: async (content: string) => content,
      getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
        uniqueName: fallbackName,
        description: null,
      }),
      buildPushTargets: async () => new Map(),
      sendPushNotifications: async () => undefined,
    });

    const { io } = createIoRecorder();
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "pending compat sender read receipt",
    });

    await closeTestDatabase();
    assert.equal(getSenderReadReceiptInFlightCountForTests(), 0);
    assert.equal(senderWarnings.length, 1);
  } finally {
    console.warn = originalWarn;
    await closeTestDatabase().catch(() => {});
  }
});

test("broadcastAndDeliver continues after post-persist thread follower read fails", async ({ db }) => {
  const threadChannelId = "00000000-0000-4000-8000-000000000001";
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  let persistedCount = 0;
  let followerReadAttempts = 0;
  let followerReadError: Error = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });

  __setMessageServiceDepsForTests({
    createMessage: async (channelId, senderType, senderId, content, messageType = "chat") => {
      persistedCount += 1;
      return makePersistedMessage({
        id: "thread-message-1",
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any;
    },
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "thread",
      name: "thread",
      parentMessageId: null,
    } as any),
    getChannelHumans: async () => [],
    getChannelAgents: async () => [],
    getChannelMembers: async () => ({ agents: [], humans: [] }),
    getThreadFollowerCandidates: async () => {
      followerReadAttempts += 1;
      throw followerReadError;
    },
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    getMentionFactsForMessages: async () => new Map(),
  });

  const { io } = createIoRecorder();
  const result = await withTraceRoot(
    tracer,
    "server.http.request",
    { surface: "server", kind: "server" },
    () => broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: threadChannelId,
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "durable thread reply",
    }),
  );

  assert.equal(result.id, "thread-message-1");
  assert.equal(persistedCount, 1, "the durable message must be written exactly once");
  assert.equal(followerReadAttempts, 1, "the shared thread-follower selection degrades once after persistence");

  const span = sink.getAllSpans().find((candidate) => candidate.name === "server.http.request");
  assert.ok(span, "expected root request span");
  const eventNames = span?.events.map((event) => event.name) ?? [];
  const persistedIndex = eventNames.indexOf("message_pipeline.message.persisted");
  const degradedEvents = span?.events.filter((event) => event.name === "message_pipeline.post_persist_side_effect.degraded") ?? [];
  assert.ok(persistedIndex >= 0);
  assert.equal(degradedEvents.length, 1);
  assert.deepEqual(
    degradedEvents.map((event) => event.attrs?.phase),
    [
      "message_pipeline.post_persist.inbox_notification_facts",
    ],
  );
  for (const event of degradedEvents) {
    assert.equal(event.attrs?.durable_message_present, true);
    assert.equal(event.attrs?.failure_policy, "continue_after_persist");
    assert.equal(event.attrs?.query_name, "thread_follows.eligible_followers");
    assert.equal(event.attrs?.sqlstate, "57014");
    assert.ok((span?.events.indexOf(event) ?? -1) > persistedIndex);
  }

  followerReadError = new TypeError("programmer bug");
  await assert.rejects(
    () => withTraceRoot(
      tracer,
      "server.http.request",
      { surface: "server", kind: "server" },
      () => broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
        channelId: threadChannelId,
        senderType: "user",
        senderId: "user-1",
        senderName: "Ray",
        content: "programmer errors must remain visible",
      }),
    ),
    TypeError,
    "only structured database failures may degrade after persistence",
  );
});

test("broadcastAndDeliver reuses inbox-selected thread agents for wake delivery", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-agent-delivery-owner@test.com",
    name: "ThreadDeliveryOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [replier] = await db.insert(users).values({
    email: "thread-agent-delivery-replier@test.com",
    name: "ThreadDeliveryReplier",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Agent Delivery",
    slug: "thread-agent-delivery",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: replier.id, role: "member" },
  ]);
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "delivery-parent",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: owner.id },
    { channelId: parentChannel.id, userId: replier.id },
  ]);
  const [agentA, agentB] = await db.insert(agents).values([
    { serverId: server.id, name: "delivery-agent-a", runtime: "codex" },
    { serverId: server.id, name: "delivery-agent-b", runtime: "codex" },
  ]).returning();
  const [parentMessage] = await db.insert(messages).values({
    channelId: parentChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "parent",
    seq: 1,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: server.id,
    name: "delivery-thread",
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: agentA.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: agentB.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    },
  ]);

  let followerReadAttempts = 0;
  __setMessageServiceDepsForTests({
    getThreadFollowerCandidates: async () => {
      followerReadAttempts += 1;
      if (followerReadAttempts > 1) {
        throw Object.assign(new Error("second thread_follows read should not gate wake delivery"), { code: "57014" });
      }
      return {
        humanFollowerIds: [],
        agentFollowers: [
          { id: agentA.id, name: agentA.name, displayName: agentA.displayName, status: agentA.status, avatarUrl: agentA.avatarUrl },
          { id: agentB.id, name: agentB.name, displayName: agentB.displayName, status: agentB.status, avatarUrl: agentB.avatarUrl },
        ],
      } as any;
    },
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const delivered: { agentId: string; messageId: string; seq: number }[] = [];
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const { io } = createIoRecorder();
  await withTraceRoot(tracer, "server.http.request", { surface: "server", kind: "server" }, async () => {
    const sent = await broadcastAndDeliver(io, {
      deliverMessage: async (agentId: string, payload: any) => {
        delivered.push({ agentId, messageId: payload.message_id, seq: payload.seq });
      },
    } as any, {
      channelId: thread.id,
      senderType: "user",
      senderId: replier.id,
      senderName: replier.name,
      content: "wake followers from fact-selected audience",
    });
    assert.equal(delivered.every((delivery) => delivery.messageId === sent.id), true);
  });

  assert.equal(followerReadAttempts, 1, "agent delivery must not re-read thread_follows after inbox facts selected the same audience");
  assert.deepEqual(new Set(delivered.map((delivery) => delivery.agentId)), new Set([agentA.id, agentB.id]));
  const deliveryEvent = sink.getAllSpans()
    .flatMap((span) => span.events)
    .find((event) => event.name === "message_pipeline.agent_delivery.scheduled");
  assert.equal(deliveryEvent?.attrs?.thread_agent_audience_source, "inbox_facts_precomputed");
  assert.equal(deliveryEvent?.attrs?.agent_delivery_count, 2);
});

test("broadcastAndDeliver repairs same-send mentioned agent follow when inbox facts already selected delivery", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-mention-owner@test.com",
    name: "ThreadMentionOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [replier] = await db.insert(users).values({
    email: "thread-mention-replier@test.com",
    name: "ThreadMentionReplier",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Mention Delivery",
    slug: "thread-mention-delivery",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: replier.id, role: "member" },
  ]);
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "mention-parent",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: owner.id },
    { channelId: parentChannel.id, userId: replier.id },
  ]);
  const [mentionedAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "mentioned-agent",
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({
    channelId: parentChannel.id,
    agentId: mentionedAgent.id,
  });
  const [parentMessage] = await db.insert(messages).values({
    channelId: parentChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "parent",
    seq: 1,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: server.id,
    name: "mention-thread",
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();

  let followerReadAttempts = 0;
  __setMessageServiceDepsForTests({
    getThreadFollowerCandidates: async () => {
      followerReadAttempts += 1;
      if (followerReadAttempts > 1) {
        throw Object.assign(new Error("same-send mention delivery should not re-read thread_follows"), { code: "57014" });
      }
      return { humanFollowerIds: [], agentFollowers: [] } as any;
    },
    getChannelMembers: async () => ({
      humans: [
        { id: owner.id, name: owner.name },
        { id: replier.id, name: replier.name },
      ],
      agents: [{ id: mentionedAgent.id, name: mentionedAgent.name }],
    }) as any,
    getServerMembers: async () => [
      { userId: owner.id, name: owner.name },
      { userId: replier.id, name: replier.name },
    ] as any,
    listAgents: async () => [mentionedAgent] as any,
    insertMentionRows: async (rows: any[]) => rows.map((row) => ({
      id: `mention-${row.targetId}`,
      targetType: row.targetType,
      targetId: row.targetId,
      notifiableAtSend: row.notifiableAtSend,
    })),
    getMentionFactsForMessages: async (messageIds: string[]) => new Map(messageIds.map((messageId) => [
      messageId,
      [{ type: "agent", id: mentionedAgent.id, name: mentionedAgent.name }],
    ])),
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    recordInboxNotificationFacts,
    getJointThreadProjectionForMember,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const delivered: { agentId: string; payload: any }[] = [];
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const { io } = createIoRecorder();
  await withTraceRoot(tracer, "server.http.request", { surface: "server", kind: "server" }, async () => {
    await broadcastAndDeliver(io, {
      deliverMessage: async (agentId: string, payload: any) => {
        delivered.push({ agentId, payload });
      },
    } as any, {
      channelId: thread.id,
      senderType: "user",
      senderId: replier.id,
      senderName: replier.name,
      content: `reply @${mentionedAgent.name}`,
      mentions: [{ type: "agent", id: mentionedAgent.id, name: mentionedAgent.name }] as any,
    });
  });

  assert.equal(followerReadAttempts, 1, "same-send mention facts select the audience without a second thread_follows read");
  assert.deepEqual(delivered.map((delivery) => delivery.agentId), [mentionedAgent.id]);
  assert.equal(delivered[0]?.payload.mentioned, true);
  assert.ok(delivered[0]?.payload.thread_join_context, "same-send mentioned agent still receives join context");

  const [follow] = await db
    .select({ reason: threadFollows.reason, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, thread.id),
      eq(threadFollows.followerType, "agent"),
      eq(threadFollows.followerId, mentionedAgent.id),
    ))
    .limit(1);
  assert.equal(follow?.reason, "mentioned", "delivery audience membership must not suppress durable follow repair");
  assert.equal(follow?.unfollowedAt, null);

  const deliveryEvent = sink.getAllSpans()
    .flatMap((span) => span.events)
    .find((event) => event.name === "message_pipeline.agent_delivery.scheduled");
  assert.equal(deliveryEvent?.attrs?.thread_agent_audience_source, "inbox_facts_precomputed");
  assert.equal(deliveryEvent?.attrs?.agent_delivery_count, 1);
  assert.equal(deliveryEvent?.attrs?.newly_joined_thread_agent_count, 1);
});

test("broadcastAndDeliver message:new does not emit storage-only message columns", async ({ db }) => {
  const persisted = makePersistedMessage({
    id: "message-new-sanitized",
    channelId: "channel-1",
    agentSendKey: "must-not-leak",
    searchText: "must-not-leak",
    searchVector: "must-not-leak",
    content: "socket safe body",
  });
  __setMessageServiceDepsForTests({
    createMessage: async () => persisted as any,
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelHumans: async () => [],
    getChannelAgents: async () => [],
    getChannelMembers: async () => ({ agents: [], humans: [] }),
    getActiveJointChannelProjectionsByLocalChannel: async () => [],
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    getMentionFactsForMessages: async () => new Map(),
    insertMentionRows: async () => [],
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Agent One",
    content: "socket safe body",
  });

  const emitted = events.find((event) => event.room === "channel:channel-1" && event.event === "message:new")?.payload;
  assert.ok(emitted, "expected realtime message:new payload");
  assert.equal("agentSendKey" in emitted, false);
  assert.equal("searchText" in emitted, false);
  assert.equal("searchVector" in emitted, false);
  assert.equal(emitted.id, "message-new-sanitized");
  assert.equal(emitted.content, "socket safe body");
  assert.equal(emitted.senderName, "Agent One");
  assert.equal(emitted.conversationContext.channelType, "channel");
});

test("a committed external projection emits one enriched message:new with its frozen avatar", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "external-realtime-owner@test.com",
    name: "external-realtime-owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "External Realtime",
    slug: "external-realtime",
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "external-realtime",
    type: "channel",
  }).returning();
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: "U123",
    displayName: "External August",
    handles: ["august"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date("2026-09-05T14:00:00.000Z"),
  }).returning();
  const [avatar] = await db.insert(externalProjectionAvatarArtifacts).values({
    ownerType: "external_projection",
    ownerId: actor.id,
    sourceDigest: "a".repeat(64),
    sourceLocatorDigest: "b".repeat(64),
    storageKey: `external-avatars/external_projection/${actor.id}/avatar.webp`,
    publicUrl: "https://api.raft.test/api/external-avatars/00000000-0000-4000-8000-000000000001.webp",
    mimeType: "image/webp",
    byteSize: 128,
    width: 64,
    height: 64,
    artifactRevision: 1,
    state: "active",
  }).returning();
  await db.update(externalActorProjections).set({ avatarArtifactId: avatar.id })
    .where(eq(externalActorProjections.id, actor.id));
  const created = await db.transaction((executor) => insertCanonicalExternalMessage({
    executor,
    channelId: channel.id,
    content: "provider message arrives live",
    createdAt: new Date("2026-09-05T14:01:00.000Z"),
    projectionId: actor.id,
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: "U123",
    externalConversationId: "C123",
    externalMessageId: "provider-message-1",
    actorProjectionRevision: 1,
  }));

  const { io, events } = createIoRecorder();
  await emitExternalProjectionMessageToFrontend(io, created.message.id);

  const emitted = events.find((event) => (
    event.room === `channel:${channel.id}` && event.event === "message:new"
  ))?.payload;
  assert.ok(emitted, "external provider commit must emit message:new without a history refresh");
  assert.equal(emitted.id, created.message.id);
  assert.equal(emitted.senderType, "external_projection");
  assert.equal(emitted.senderName, "External August");
  assert.equal(emitted.externalAuthor.avatarUrl, avatar.publicUrl);
  assert.equal(emitted.externalAuthor.avatarDigest, avatar.sourceDigest);
  assert.equal(emitted.conversationContext.channelType, "channel");
  assert.equal("searchText" in emitted, false);
  assert.equal("searchVector" in emitted, false);

  const [localMessage] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "Raft-authored message reacted to in Slack",
    messageType: "chat",
  }).returning();
  const [link] = await db.insert(externalMessageLinks).values({
    provider: "slack",
    installId: "install-1",
    providerAuthorityId: "workspace-1",
    providerConversationId: "C123",
    providerMessageId: "provider-message-2",
    bindingId: "binding-1",
    bindingEpoch: 1,
    connectionEpoch: 1,
    raftMessageId: localMessage.id,
    firstDirection: "raft_outbound",
    payloadFingerprint: "c".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
  }).returning();
  await db.insert(externalReactionStates).values({
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    connectionEpoch: 1,
    bindingId: "binding-1",
    bindingEpoch: 1,
    messageLinkId: link.id,
    raftMessageId: localMessage.id,
    projectionId: actor.id,
    providerReactionKey: "eyes",
    canonicalEmoji: "👀",
    mappingRevision: 1,
    present: true,
    lastProviderEventId: "EvReaction",
    lastEventAt: new Date("2026-09-05T14:02:00.000Z"),
    lastEventSequence: 1,
  });

  await emitExternalReactionMessageUpdateToFrontend(io, localMessage.id);
  const updated = events.find((event) => (
    event.room === `channel:${channel.id}` && event.event === "message:updated"
  ))?.payload;
  assert.ok(updated, "external reaction commit must emit message:updated without a history refresh");
  assert.equal(updated.id, localMessage.id);
  assert.equal(updated.senderType, "user");
  assert.deepEqual(updated.reactions, [{
    emoji: "👀",
    count: 1,
    reactorIds: [actor.id],
    reactorNames: ["External August"],
  }]);
  assert.equal("searchText" in updated, false);
  assert.equal("searchVector" in updated, false);
});

test("external reaction updates fan out once to every local Joint channel projection", async ({ db }) => {
  const [ownerA] = await db.insert(users).values({
    email: "reaction-joint-owner-a@test.com",
    name: "ReactionJointOwnerA",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [ownerB] = await db.insert(users).values({
    email: "reaction-joint-owner-b@test.com",
    name: "ReactionJointOwnerB",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [serverA] = await db.insert(servers).values({ name: "Reaction Joint A", slug: "reaction-joint-a", ownerId: ownerA.id }).returning();
  const [serverB] = await db.insert(servers).values({ name: "Reaction Joint B", slug: "reaction-joint-b", ownerId: ownerB.id }).returning();
  const [sender] = await db.insert(agents).values({ serverId: serverA.id, name: "ReactionJointAgent", status: "active" }).returning();
  const [reactor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: "U-JOINT-REACTOR",
    displayName: "Joint Reactor",
    handles: ["joint-reactor"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date("2026-09-05T15:00:00.000Z"),
  }).returning();
  const [canonical] = await db.insert(channels).values({ serverId: serverA.id, name: "reaction-joint-canonical", type: "joint" }).returning();
  const [localA] = await db.insert(channels).values({ serverId: serverA.id, name: "reaction-joint-local-a", type: "joint" }).returning();
  const [localB] = await db.insert(channels).values({ serverId: serverB.id, name: "reaction-joint-local-b", type: "joint" }).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: serverA.id, localChannelId: localA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: joint.id, serverId: serverB.id, localChannelId: localB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  const [message] = await db.insert(messages).values({
    channelId: canonical.id,
    senderType: "agent",
    senderId: sender.id,
    content: "Joint message reacted to in Slack",
    messageType: "chat",
  }).returning();
  await seedSlackReactionForMessage({ messageId: message.id, projectionId: reactor.id, key: "joint-channel" });

  const beforeInboxFacts = await db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts);
  const beforeServingRows = await db.select({ receiverId: inboxServingRows.receiverId }).from(inboxServingRows);
  const { io, events } = createIoRecorder();
  await emitExternalReactionMessageUpdateToFrontend(io, message.id);

  assert.deepEqual(events.map(({ room, event }) => ({ room, event })).sort((a, b) => a.room.localeCompare(b.room)), [
    { room: `channel:${localA.id}`, event: "message:updated" },
    { room: `channel:${localB.id}`, event: "message:updated" },
  ].sort((a, b) => a.room.localeCompare(b.room)));
  for (const event of events) {
    assert.equal(event.payload.channelId, event.room.slice("channel:".length));
    assert.equal(event.payload.senderType, "agent");
    assert.equal(event.payload.senderId, sender.id);
    assert.equal(event.payload.senderName, sender.name);
    assert.deepEqual(event.payload.conversationContext, { channelType: "joint" });
    assert.deepEqual(event.payload.reactions, [{
      emoji: "👀",
      count: 1,
      reactorIds: [reactor.id],
      reactorNames: [reactor.displayName],
    }]);
  }
  assert.deepEqual(await db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts), beforeInboxFacts);
  assert.deepEqual(await db.select({ receiverId: inboxServingRows.receiverId }).from(inboxServingRows), beforeServingRows);
});

test("external reaction updates use only ordinary and Joint thread rooms with sender identity intact", async ({ db }) => {
  const [ownerA] = await db.insert(users).values({
    email: "reaction-thread-owner-a@test.com",
    name: "ReactionThreadOwnerA",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [ownerB] = await db.insert(users).values({
    email: "reaction-thread-owner-b@test.com",
    name: "ReactionThreadOwnerB",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [serverA] = await db.insert(servers).values({ name: "Reaction Thread A", slug: "reaction-thread-a", ownerId: ownerA.id }).returning();
  const [serverB] = await db.insert(servers).values({ name: "Reaction Thread B", slug: "reaction-thread-b", ownerId: ownerB.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: serverA.id, name: "ReactionThreadAgent", status: "active" }).returning();
  const [reactor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: "U-THREAD-REACTOR",
    displayName: "Thread Reactor",
    handles: ["thread-reactor"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date("2026-09-05T16:00:00.000Z"),
  }).returning();

  const [ordinaryParent] = await db.insert(channels).values({ serverId: serverA.id, name: "reaction-ordinary-parent", type: "channel" }).returning();
  const [ordinaryParentMessage] = await db.insert(messages).values({
    channelId: ordinaryParent.id,
    senderType: "user",
    senderId: ownerA.id,
    content: "Ordinary parent",
  }).returning();
  const ordinaryThread = await getOrCreateThread(ordinaryParentMessage.id, ownerA.id, "user");
  const [ordinaryReply] = await db.insert(messages).values({
    channelId: ordinaryThread.id,
    senderType: "agent",
    senderId: agent.id,
    content: "Ordinary thread reply reacted to in Slack",
  }).returning();
  await seedSlackReactionForMessage({ messageId: ordinaryReply.id, projectionId: reactor.id, key: "ordinary-thread" });

  const [canonicalParent] = await db.insert(channels).values({ serverId: serverA.id, name: "reaction-joint-parent-canonical", type: "joint" }).returning();
  const [localParentA] = await db.insert(channels).values({ serverId: serverA.id, name: "reaction-joint-parent-a", type: "joint" }).returning();
  const [localParentB] = await db.insert(channels).values({ serverId: serverB.id, name: "reaction-joint-parent-b", type: "joint" }).returning();
  const [parentJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalParent.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: parentJoint.id, serverId: serverA.id, localChannelId: localParentA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: parentJoint.id, serverId: serverB.id, localChannelId: localParentB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  const [canonicalParentMessage] = await db.insert(messages).values({
    channelId: canonicalParent.id,
    senderType: "user",
    senderId: ownerA.id,
    content: "Joint parent",
  }).returning();
  const [canonicalThread] = await db.insert(channels).values({
    serverId: serverA.id,
    name: "reaction-joint-thread-canonical",
    type: "thread",
    parentMessageId: canonicalParentMessage.id,
  }).returning();
  const [localThreadA] = await db.insert(channels).values({ serverId: serverA.id, name: "reaction-joint-thread-a", type: "thread" }).returning();
  const [localThreadB] = await db.insert(channels).values({ serverId: serverB.id, name: "reaction-joint-thread-b", type: "thread" }).returning();
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: threadJoint.id, serverId: serverA.id, localChannelId: localThreadA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: threadJoint.id, serverId: serverB.id, localChannelId: localThreadB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  const externalReply = await db.transaction((executor) => insertCanonicalExternalMessage({
    executor,
    channelId: canonicalThread.id,
    content: "External Joint thread reply reacted to in Slack",
    createdAt: new Date("2026-09-05T16:01:00.000Z"),
    projectionId: reactor.id,
    provider: "slack",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: reactor.externalActorId,
    externalConversationId: "C-JOINT-THREAD",
    externalMessageId: "M-JOINT-THREAD",
    actorProjectionRevision: 1,
  }));
  await seedSlackReactionForMessage({ messageId: externalReply.message.id, projectionId: reactor.id, key: "joint-thread" });

  const beforeInboxFacts = await db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts);
  const beforeServingRows = await db.select({ receiverId: inboxServingRows.receiverId }).from(inboxServingRows);
  const { io, events } = createIoRecorder();
  await emitExternalReactionMessageUpdateToFrontend(io, ordinaryReply.id);
  await emitExternalReactionMessageUpdateToFrontend(io, externalReply.message.id);

  assert.equal(events.every(({ event }) => event === "message:updated"), true);
  assert.equal(events.some(({ room }) => room === `channel:${ordinaryParent.id}`), false);
  assert.equal(events.some(({ room }) => room === `channel:${canonicalParent.id}`), false);
  assert.equal(events.some(({ room }) => room === `channel:${canonicalThread.id}`), false);
  const ordinaryEvent = events.find(({ room }) => room === `channel:${ordinaryThread.id}`);
  assert.ok(ordinaryEvent);
  assert.equal(ordinaryEvent.payload.senderType, "agent");
  assert.equal(ordinaryEvent.payload.senderId, agent.id);
  assert.equal(ordinaryEvent.payload.senderName, agent.name);
  assert.deepEqual(ordinaryEvent.payload.conversationContext, {
    channelType: "thread",
    parentMessageId: ordinaryParentMessage.id,
    parentChannelId: ordinaryParent.id,
    parentChannelType: "channel",
  });

  for (const [localThread, localParent] of [[localThreadA, localParentA], [localThreadB, localParentB]] as const) {
    const event = events.find(({ room }) => room === `channel:${localThread.id}`);
    assert.ok(event);
    assert.equal(event.payload.channelId, localThread.id);
    assert.equal(event.payload.senderType, "external_projection");
    assert.equal(event.payload.senderId, reactor.id);
    assert.equal(event.payload.senderName, reactor.displayName);
    assert.equal(event.payload.externalAuthor.displayName, reactor.displayName);
    assert.deepEqual(event.payload.conversationContext, {
      channelType: "thread",
      parentMessageId: canonicalParentMessage.id,
      parentChannelId: localParent.id,
      parentChannelType: "joint",
    });
    assert.deepEqual(event.payload.reactions, [{
      emoji: "👀",
      count: 1,
      reactorIds: [reactor.id],
      reactorNames: [reactor.displayName],
    }]);
  }
  assert.equal(events.length, 3, "each local thread projection receives exactly one merge-only update");
  assert.deepEqual(await db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts), beforeInboxFacts);
  assert.deepEqual(await db.select({ receiverId: inboxServingRows.receiverId }).from(inboxServingRows), beforeServingRows);
});

test("broadcastSystemMessage records inbox facts for persistent system messages and honors mute", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "system-facts-owner@test.com",
    name: "SystemFactsOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [muted] = await db.insert(users).values({
    email: "system-facts-muted@test.com",
    name: "SystemFactsMuted",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "System Facts",
    slug: "system-facts",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: muted.id, role: "member" },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "system-facts-agent",
    status: "active",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "system-facts-channel",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: muted.id },
  ]);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "user",
    receiverId: muted.id,
    serverId: server.id,
    sourceChannelId: channel.id,
    muteFromSeq: 1,
  });

  const { io } = createIoRecorder();
  const deliveries: { agentId: string; payload: any }[] = [];
  const message = await broadcastSystemMessage(
    io,
    {
      deliverMessage: async (agentId: string, payload: any) => {
        deliveries.push({ agentId, payload });
      },
    } as any,
    channel.id,
    "ApplePI unarchived this channel",
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "test.channel.unarchive",
        reason: "test unarchive notice is shared channel activity",
      },
    },
  );

  const factRows = await db
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, message.id));
  assert.equal(factRows.length, 2);
  assert.equal(factRows.some((fact) => fact.receiverType === "user" && fact.receiverId === owner.id), true);
  assert.equal(factRows.some((fact) => fact.receiverType === "agent" && fact.receiverId === agent.id), true);
  assert.equal(factRows.some((fact) => fact.receiverId === muted.id), false);
  assert.equal(factRows.every((fact) => fact.unreadEligible === true), true);
  assert.equal(factRows.every((fact) => fact.personalMention === false), true);

  const servingRows = await db.select().from(inboxServingRows);
  const ownerRow = servingRows.find((row) => row.receiverType === "user" && row.receiverId === owner.id);
  assert.equal(ownerRow?.latestNotifiedMessageId, message.id);
  assert.equal(ownerRow?.firstUnreadMessageId, message.id);
  assert.equal(ownerRow?.unreadCount, 1);
  const agentRow = servingRows.find((row) => row.receiverType === "agent" && row.receiverId === agent.id);
  assert.equal(agentRow?.latestNotifiedMessageId, message.id);
  assert.equal(agentRow?.firstUnreadMessageId, message.id);
  assert.equal(agentRow?.unreadCount, 1);
  assert.equal(servingRows.some((row) => row.receiverId === muted.id), false);

  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [agent.id]);

  const taskSummary = await broadcastSystemMessage(
    io,
    { deliverMessage: async () => {} } as any,
    channel.id,
    `📋 1 new task created: #1 "Close fact coverage"`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
      },
      causalActor: { type: "user", id: owner.id },
    },
  );
  const taskSummaryFacts = await db
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, taskSummary.id));
  assert.equal(taskSummaryFacts.length, 2);

  // #9: task status transitions now record + born-read the acting user.
  const lifecycleNotice = await broadcastSystemMessage(
    io,
    { deliverMessage: async () => {} } as any,
    channel.id,
    `🔄 Someone moved #1 "Close fact coverage" to In Review`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.lifecycle_thread",
        reason: "task status transitions are a collaboration signal for the thread audience",
      },
      causalActor: { type: "user", id: owner.id },
    },
  );
  const lifecycleFacts = await db
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, lifecycleNotice.id));
  assert.equal(lifecycleFacts.length, 2);
  const ownerLifecycleFact = lifecycleFacts.find((fact) => fact.receiverType === "user" && fact.receiverId === owner.id);
  assert.equal(ownerLifecycleFact?.unreadEligible, false, "the user who moved the task is born-read (#9)");
});

test("task-created direct agent delivery honors channel mute for body and summary messages", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "task-create-mute-owner@test.com",
    name: "TaskCreateMuteOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Task Create Mute",
    slug: "task-create-mute",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [mutedAgent, unmutedAgent] = await db.insert(agents).values([
    { serverId: server.id, name: "task-create-muted-agent", status: "active" },
    { serverId: server.id, name: "task-create-unmuted-agent", status: "active" },
  ]).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "task-create-muted-channel",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  await db.insert(channelAgents).values([
    { channelId: channel.id, agentId: mutedAgent.id },
    { channelId: channel.id, agentId: unmutedAgent.id },
  ]);
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "agent",
    receiverId: mutedAgent.id,
    serverId: server.id,
    sourceChannelId: channel.id,
    muteFromSeq: 1,
  });

  const { tasks: [task], hostMessages: [taskHostMessage] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "muted task body" }]);
  const amendment = await taskService.amendTask(task.id, {
    title: "current amended task body",
    description: "current amended details",
  }, "user", owner.id);
  assert.notEqual(typeof amendment, "string", String(amendment));
  if (typeof amendment === "string") return;
  const taskFacts = await db
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, taskHostMessage.id));
  assert.equal(taskFacts.some((fact) => fact.receiverType === "agent" && fact.receiverId === mutedAgent.id), false);
  assert.equal(taskFacts.some((fact) => fact.receiverType === "agent" && fact.receiverId === unmutedAgent.id), true);

  const deliveries: { agentId: string; payload: any }[] = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  await deliverMessageToAgents(orchestrator, taskHostMessage, owner.name);
  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [unmutedAgent.id]);
  assert.equal(deliveries[0]?.payload.content, "muted task body");
  assert.deepEqual(deliveries[0]?.payload.task_current_projection, {
    title: "current amended task body",
    description: "current amended details",
    revision: amendment.row.revision,
    superseded: true,
    amended_at: amendment.event.createdAt.toISOString(),
    amended_by_type: "user",
    amended_by_name: owner.name,
    source: "tasks_current_projection",
  });

  const { io } = createIoRecorder();
  await broadcastSystemMessage(
    io,
    orchestrator,
    channel.id,
    `📋 1 new task created: #${task.taskNumber} "muted task body"`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
      },
      causalActor: { type: "user", id: owner.id },
    },
  );
  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [unmutedAgent.id, unmutedAgent.id]);
  assert.match(deliveries[1]?.payload.content ?? "", /new task created/);
});

test("task-created direct agent delivery includes parent channel metadata for thread targets", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-task-owner@test.com",
    name: "threadTaskOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Task Server",
    slug: "thread-task-server",
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "thread-task-agent",
    status: "active",
  }).returning();
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-task-parent",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id });
  const [parentMessage] = await db.insert(messages).values({
    id: "99999999-9999-4999-8999-999999999999",
    channelId: parentChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "thread parent",
  }).returning();
  const [threadChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-99999999-9999-4999-8999-999999999999",
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();
  await db.insert(channelAgents).values({ channelId: threadChannel.id, agentId: agent.id });
  await db.insert(threadFollows).values({
    threadChannelId: threadChannel.id,
    followerType: "agent",
    followerId: agent.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
  });

  const { tasks: [task], hostMessages: [taskHostMessage] } = await taskService.createTasks(threadChannel.id, "user", owner.id, [{ title: "thread task body" }]);
  const deliveries: { agentId: string; payload: any }[] = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  await deliverMessageToAgents(orchestrator, taskHostMessage, owner.name);

  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [agent.id]);
  assert.equal(deliveries[0]?.payload.channel_type, "thread");
  assert.equal(deliveries[0]?.payload.channel_name, threadChannel.name);
  assert.equal(deliveries[0]?.payload.parent_channel_name, parentChannel.name);
  assert.equal(deliveries[0]?.payload.parent_channel_id, parentChannel.id);
  assert.equal(deliveries[0]?.payload.parent_channel_type, "channel");

  const { io } = createIoRecorder();
  await broadcastSystemMessage(
    io,
    orchestrator,
    threadChannel.id,
    `📋 1 new task created: #${task.taskNumber} "thread task body"`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
      },
      causalActor: { type: "user", id: owner.id },
    },
  );

  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [agent.id, agent.id]);
  assert.equal(deliveries[1]?.payload.channel_type, "thread");
  assert.equal(deliveries[1]?.payload.channel_name, threadChannel.name);
  assert.equal(deliveries[1]?.payload.parent_channel_name, parentChannel.name);
  assert.equal(deliveries[1]?.payload.parent_channel_id, parentChannel.id);
  assert.equal(deliveries[1]?.payload.parent_channel_type, "channel");
});

test("task-created direct agent delivery keeps followed threads independent from parent mute", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-task-mute-owner@test.com",
    name: "threadTaskMuteOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Task Mute",
    slug: "thread-task-mute",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [mutedAgent, unmutedAgent] = await db.insert(agents).values([
    { serverId: server.id, name: "thread-task-muted-agent", status: "active" },
    { serverId: server.id, name: "thread-task-unmuted-agent", status: "active" },
  ]).returning();
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-task-muted-parent",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id });
  const parent = await createMessage(parentChannel.id, "user", owner.id, "parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await db.insert(channelAgents).values([
    { channelId: thread.id, agentId: mutedAgent.id },
    { channelId: thread.id, agentId: unmutedAgent.id },
  ]);
  await db.insert(threadFollows).values([
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: mutedAgent.id,
      parentMessageId: parent.id,
      reason: "manual",
    },
    {
      threadChannelId: thread.id,
      followerType: "agent",
      followerId: unmutedAgent.id,
      parentMessageId: parent.id,
      reason: "manual",
    },
  ]);
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "agent",
    receiverId: mutedAgent.id,
    serverId: server.id,
    sourceChannelId: parentChannel.id,
    muteFromSeq: parent.seq + 1,
  });
  const { hostMessages: [taskHostMessage] } = await taskService.createTasks(thread.id, "user", owner.id, [{ title: "muted thread task body" }]);

  const deliveries: { agentId: string; payload: any }[] = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  await deliverMessageToAgents(orchestrator, taskHostMessage, owner.name);

  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [mutedAgent.id, unmutedAgent.id]);
  assert.equal(deliveries[0]?.payload.parent_channel_id, parentChannel.id);
  assert.equal(deliveries[1]?.payload.parent_channel_id, parentChannel.id);
});

test("task-created followed-thread delivery projects task assignee metadata with muted parent", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-task-mute-pierce-owner@test.com",
    name: "threadTaskMutePierceOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Task Mute Pierce",
    slug: "thread-task-mute-pierce",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "thread-task-muted-assignee",
    status: "active",
  }).returning();
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-task-muted-assignee-parent",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id });
  const parent = await createMessage(parentChannel.id, "user", owner.id, "parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await db.insert(channelAgents).values({ channelId: thread.id, agentId: agent.id });
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: agent.id,
    parentMessageId: parent.id,
    reason: "manual",
  });
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "agent",
    receiverId: agent.id,
    serverId: server.id,
    sourceChannelId: parentChannel.id,
    muteFromSeq: parent.seq + 1,
  });
  const { tasks: [task], hostMessages: [assignedTask] } = await taskService.createTasks(thread.id, "user", owner.id, [{ title: "muted assigned thread task" }]);
  // v1.4: assignment lives on the canonical task row, not messages.task_*.
  // The host message below carries no task columns at all — delivery must
  // still ship task_assignee_id, which is only
  // true if the canonical facts are projected onto it on the way out.
  assert.notEqual(await taskService.claimTask(task.id, "agent", agent.id), "task not found");
  assert.equal(assignedTask.taskAssigneeId, null, "host message must not carry task assignment");

  const deliveries: { agentId: string; payload: any }[] = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  await deliverMessageToAgents(orchestrator, assignedTask, owner.name);

  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [agent.id]);
  assert.equal(deliveries[0]?.payload.task_assignee_id, agent.id);
});

test("getAgentResumeCatchupMessages returns bounded post-join unread agent messages without advancing cursor", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "resume-catchup-owner@test.com",
    name: "resumeCatchupOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Resume Catchup",
    slug: "resume-catchup",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "resume-catchup-agent",
    status: "active",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "resume-catchup-room",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });

  const preJoinRows = [];
  for (let i = 0; i < 5; i += 1) {
    preJoinRows.push(await createMessage(channel.id, "user", owner.id, `pre-join should stay out ${i}`));
  }
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  await db.insert(agentChannelReadCursors).values({
    channelId: channel.id,
    agentId: agent.id,
    lastReadSeq: preJoinRows.at(-1)!.seq,
  });
  for (let i = 0; i < 5; i += 1) {
    await createMessage(channel.id, "agent", agent.id, `own post-cursor send should stay out ${i}`);
  }
  const visible = await createMessage(channel.id, "user", owner.id, "post-join durable request");
  await createMessage(channel.id, "agent", agent.id, "own send should stay out");

  const base = new Date("2026-07-01T00:00:00.000Z");
  for (const preJoin of preJoinRows) {
    await db.update(messages).set({ createdAt: new Date(base.getTime()) }).where(eq(messages.id, preJoin.id));
  }
  await db.update(channelAgents).set({ addedAt: new Date(base.getTime() + 1_000) }).where(
    and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, agent.id)),
  );
  await db.update(messages).set({ createdAt: new Date(base.getTime() + 2_000) }).where(eq(messages.id, visible.id));

  const result = await getAgentResumeCatchupMessages(agent.id);

  assert.equal(result.candidateChannelCount, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].message_id, visible.id);
  assert.equal(result.messages[0].content, "post-join durable request");
  assert.equal(result.messages[0].sender_name, owner.name);
  assert.equal(result.messages[0].channel_id, channel.id);
  assert.equal(result.messages[0].channel_type, "channel");
  assert.equal(result.maxSeq, visible.seq);

  const cursorRows = await db
    .select()
    .from(agentChannelReadCursors)
    .where(and(
      eq(agentChannelReadCursors.channelId, channel.id),
      eq(agentChannelReadCursors.agentId, agent.id),
    ));
  assert.equal(cursorRows.length, 1);
  assert.equal(cursorRows[0].lastReadSeq, preJoinRows.at(-1)!.seq);
});

test("getAgentResumeCatchupMessages suppresses muted ordinary messages but preserves pierce facts", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "resume-catchup-mute-owner@test.com",
    name: "resumeCatchupMuteOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Resume Catchup Mute",
    slug: "resume-catchup-mute",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "resume-catchup-mute-agent",
    status: "active",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "resume-catchup-muted-room",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  await db.insert(agentChannelReadCursors).values({
    channelId: channel.id,
    agentId: agent.id,
    lastReadSeq: 0,
  });
  await db.insert(inboxTargetMuteStates).values({
    receiverType: "agent",
    receiverId: agent.id,
    serverId: server.id,
    sourceChannelId: channel.id,
    muteFromSeq: 1,
  });

  await createMessage(channel.id, "user", owner.id, "muted ordinary resume");
  const pierced = await createMessage(channel.id, "user", owner.id, `@${agent.name} pierce resume`);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: agent.id,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: channel.id,
    messageId: pierced.id,
    messageSeq: pierced.seq,
    activityAt: pierced.createdAt,
    personalMention: true,
    unreadEligible: true,
  }]);

  const result = await getAgentResumeCatchupMessages(agent.id);

  assert.equal(result.candidateChannelCount, 1);
  assert.deepEqual(result.messages.map((message) => message.message_id), [pierced.id]);
  assert.equal(result.messages[0]?.content, `@${agent.name} pierce resume`);
  assert.equal(result.maxSeq, pierced.seq);
});

test("getAgentResumeCatchupMessages prioritizes fresh personal wake rows over old unread debt", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "resume-catchup-salience-owner@test.com",
    name: "resumeCatchupSalienceOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Resume Catchup Salience",
    slug: "resume-catchup-salience",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "resume-catchup-salience-agent",
    status: "active",
  }).returning();

  // Live 2026-07-16 specimen shape: the bounded startup body contained 14
  // stale rows while a fresh personal wake sat outside the concrete batch.
  // Eight two-row debt channels force the old ordering to spend all eight
  // candidate slots before it can reach the ninth, fresh channel.
  for (let i = 0; i < 8; i += 1) {
    const [oldChannel] = await db.insert(channels).values({
      serverId: server.id,
      name: `old-debt-${i}`,
      type: "channel",
    }).returning();
    await db.insert(channelHumans).values({ channelId: oldChannel.id, userId: owner.id });
    await db.insert(channelAgents).values({ channelId: oldChannel.id, agentId: agent.id });
    await createMessage(oldChannel.id, "user", owner.id, `old unread debt ${i}.0`);
    await createMessage(oldChannel.id, "user", owner.id, `old unread debt ${i}.1`);
  }

  const [freshChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "fresh-pierce",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: freshChannel.id, userId: owner.id });
  await db.insert(channelAgents).values({ channelId: freshChannel.id, agentId: agent.id });
  const freshMention = await createMessage(freshChannel.id, "user", owner.id, `@${agent.name} fresh wake request`);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: agent.id,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: freshChannel.id,
    messageId: freshMention.id,
    messageSeq: freshMention.seq,
    activityAt: freshMention.createdAt,
    personalMention: true,
    unreadEligible: true,
  }]);

  const result = await getAgentResumeCatchupMessages(agent.id);

  assert.equal(result.candidateChannelCount, 8);
  assert.equal(result.messages.at(0)?.message_id, freshMention.id);
  assert.equal(result.messages.at(0)?.content, `@${agent.name} fresh wake request`);
  // The fixed ordering selects the fresh channel plus seven debt channels:
  // one fresh wake followed by the same 14-row stale body shape.
  assert.equal(result.messages.length, 15);
  assert.equal(result.messages.filter((message) => message.content.startsWith("old unread debt")).length, 14);
  assert.ok(result.messages.every((message) => message.message_id !== undefined));
});

test("agent thread resume and unread use active follows instead of stale thread membership", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-resume-owner@test.com",
    name: "threadResumeOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Resume",
    slug: "thread-resume",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "thread-resume-agent",
    status: "active",
  }).returning();
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-resume-room",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id });

  const parent = await createMessage(parentChannel.id, "user", owner.id, "thread resume parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const threadTarget = `#${parentChannel.name}:${parent.id.slice(0, 8)}`;
  const legacyThreadTarget = `#thread-${parent.id.slice(0, 8)}`;
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: agent.id,
    parentMessageId: parent.id,
    reason: "manual",
  });
  const followedReply = await createMessage(thread.id, "user", owner.id, "active follow reply");

  const activeResume = await getAgentResumeCatchupMessages(agent.id);
  assert.deepEqual(activeResume.messages.map((message) => message.message_id), [followedReply.id]);
  const activeUnreadCounts = await getAgentUnreadCounts(agent.id);
  assert.equal(activeUnreadCounts[threadTarget], 1);
  assert.equal(activeUnreadCounts[legacyThreadTarget], undefined);

  await db.insert(channelAgents).values({ channelId: thread.id, agentId: agent.id });
  await db.update(threadFollows).set({
    unfollowedAt: new Date("2026-07-06T00:00:00.000Z"),
  }).where(and(
    eq(threadFollows.threadChannelId, thread.id),
    eq(threadFollows.followerType, "agent"),
    eq(threadFollows.followerId, agent.id),
  ));
  await createMessage(thread.id, "user", owner.id, "stale membership reply");

  const tombstonedResume = await getAgentResumeCatchupMessages(agent.id);
  assert.deepEqual(tombstonedResume.messages, [], "stale thread channelAgents membership must not revive resume delivery");
  assert.equal((await getAgentUnreadCounts(agent.id))[threadTarget], undefined);
});

test("agent thread resume and unread require current private parent membership", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-private-parent-owner@test.com",
    name: "threadPrivateParentOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Private Parent",
    slug: "thread-private-parent",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "thread-private-parent-agent",
    status: "active",
  }).returning();
  const [privateParentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread-private-parent-room",
    type: "private",
  }).returning();
  await db.insert(channelHumans).values({ channelId: privateParentChannel.id, userId: owner.id });
  await db.insert(channelAgents).values({ channelId: privateParentChannel.id, agentId: agent.id });

  const parent = await createMessage(privateParentChannel.id, "user", owner.id, "thread private parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const threadName = `thread-${parent.id.slice(0, 8)}`;
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: agent.id,
    parentMessageId: parent.id,
    reason: "manual",
  });
  await db.insert(channelAgents).values({ channelId: thread.id, agentId: agent.id });
  await db.delete(channelAgents).where(and(
    eq(channelAgents.channelId, privateParentChannel.id),
    eq(channelAgents.agentId, agent.id),
  ));
  await createMessage(thread.id, "user", owner.id, "stale private parent follow reply");

  const resume = await getAgentResumeCatchupMessages(agent.id);
  assert.deepEqual(resume.messages, [], "active follow must not revive resume after private parent access is removed");
  assert.equal((await getAgentUnreadCounts(agent.id))[`#${threadName}`], undefined);
});

function legacyPushEntries(targets: ReturnType<typeof buildPushTargetsFromContext>) {
  return [...targets.entries()].map(([userId, payload]) => [userId, {
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    url: payload.url,
  }]);
}

test("buildPushTargetsFromContext builds DM pushes and excludes the sender", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "dm-1", type: "dm", name: "ray", parentMessageId: null },
    messageId: "msg-1",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hello",
    dmHumans: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
    ],
  });

  assert.deepEqual(legacyPushEntries(targets), [[
    "user-2",
    {
      title: "DM · Acme Workspace",
      body: "Ray: hello",
      tag: "message:msg-1",
      url: "/s/acme/dm/dm-1?msg=msg-1",
    },
  ]]);
});

test("buildPushTargetsFromContext pushes channel messages to all joined humans and uses mention-specific titles", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "channel-1", type: "channel", name: "engineering", parentMessageId: null },
    messageId: "msg-2",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hi @tygg",
    mentionNames: new Set(["tygg"]),
    humanScopeMembers: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
      { id: "user-3", name: "applepi" },
    ],
  });

  assert.deepEqual(legacyPushEntries(targets), [
    [
      "user-2",
      {
        title: "#engineering · Acme Workspace",
        body: "Ray mentioned you: hi @tygg",
        tag: "message:msg-2",
        url: "/s/acme/channel/channel-1?msg=msg-2",
      },
    ],
    [
      "user-3",
      {
        title: "#engineering · Acme Workspace",
        body: "Ray: hi @tygg",
        tag: "message:msg-2",
        url: "/s/acme/channel/channel-1?msg=msg-2",
      },
    ],
  ]);
});

test("buildPushTargetsFromContext excludes users who muted the server", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "channel-1", type: "channel", name: "engineering", parentMessageId: null },
    messageId: "msg-muted",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hi @tygg",
    mentionNames: new Set(["tygg"]),
    mutedUserIds: new Set(["user-2"]),
    humanScopeMembers: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
      { id: "user-3", name: "applepi" },
    ],
  });

  assert.deepEqual(legacyPushEntries(targets), [[
    "user-3",
    {
      title: "#engineering · Acme Workspace",
      body: "Ray: hi @tygg",
      tag: "message:msg-muted",
      url: "/s/acme/channel/channel-1?msg=msg-muted",
    },
  ]]);
});

test("buildPushTargetsFromContext also notifies visible non-joined humans when they are mentioned in a public channel", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "channel-1", type: "channel", name: "engineering", parentMessageId: null },
    messageId: "msg-2b",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hi @tygg and @applepi",
    mentionNames: new Set(["tygg", "applepi"]),
    mentionedUserIds: new Set(["user-3"]),
    humanScopeMembers: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
    ],
    humanMentionOnlyMembers: [{ id: "user-3", name: "applepi" }],
  });

  assert.deepEqual(legacyPushEntries(targets), [
    [
      "user-2",
      {
        title: "#engineering · Acme Workspace",
        body: "Ray mentioned you: hi @tygg and @applepi",
        tag: "message:msg-2b",
        url: "/s/acme/channel/channel-1?msg=msg-2b",
      },
    ],
    [
      "user-3",
      {
        title: "#engineering · Acme Workspace",
        body: "Ray mentioned you: hi @tygg and @applepi",
        tag: "message:msg-2b",
        url: "/s/acme/channel/channel-1?msg=msg-2b",
      },
    ],
  ]);
});

test("buildPushTargetsFromContext does not notify visible non-joined humans from a name-only mention fallback", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "channel-1", type: "channel", name: "engineering", parentMessageId: null },
    messageId: "msg-2c",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hi @applepi",
    mentionNames: new Set(["applepi"]),
    humanScopeMembers: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
    ],
    humanMentionOnlyMembers: [{ id: "user-3", name: "applepi" }],
  });

  assert.deepEqual(legacyPushEntries(targets), [[
    "user-2",
    {
      title: "#engineering · Acme Workspace",
      body: "Ray: hi @applepi",
      tag: "message:msg-2c",
      url: "/s/acme/channel/channel-1?msg=msg-2c",
    },
  ]]);
});

test("buildPushTargetsFromContext does not notify non-members mentioned in a private channel", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "private-1", type: "private", name: "secret", parentMessageId: null },
    messageId: "msg-private",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hi @tygg and @applepi",
    mentionNames: new Set(["tygg", "applepi"]),
    humanScopeMembers: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
    ],
    humanMentionOnlyMembers: [{ id: "user-3", name: "applepi" }],
  });

  assert.deepEqual(legacyPushEntries(targets), [[
    "user-2",
    {
      title: "#secret · Acme Workspace",
      body: "Ray mentioned you: hi @tygg and @applepi",
      tag: "message:msg-private",
      url: "/s/acme/channel/private-1?msg=msg-private",
    },
  ]]);
});

test("buildPushTargetsFromContext pushes joint projection messages to local members only", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "peer-lab",
    serverName: "Peer Lab",
    channel: { id: "joint-projection-1", type: "joint", name: "partner-design-room", parentMessageId: null },
    messageId: "msg-joint",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hi @tygg",
    mentionNames: new Set(["tygg"]),
    humanScopeMembers: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
    ],
    humanMentionOnlyMembers: [{ id: "user-3", name: "applepi" }],
  });

  assert.deepEqual(legacyPushEntries(targets), [[
    "user-2",
    {
      title: "#partner-design-room · Peer Lab",
      body: "Ray mentioned you: hi @tygg",
      tag: "message:msg-joint",
      url: "/s/peer-lab/channel/joint-projection-1?msg=msg-joint",
    },
  ]]);
});

test("buildPushTargetsFromContext pushes thread replies only to followed humans", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "thread-1", type: "thread", name: "thread-1", parentMessageId: "parent-1" },
    messageId: "msg-3",
    senderId: "agent-1",
    senderType: "agent",
    senderName: "Ray",
    body: "please take a look",
    parentChannel: { id: "channel-1", type: "channel", name: "engineering" },
    followedUserIds: ["user-1"],
    mentionNames: new Set(["tygg"]),
    humanScopeMembers: [{ id: "user-1", name: "tygg" }],
  });

  assert.deepEqual(legacyPushEntries(targets), [[
    "user-1",
    {
      title: "Thread in #engineering · Acme Workspace",
      body: "Ray: please take a look",
      tag: "message:msg-3",
      url: "/s/acme/channel/channel-1?thread=channel-1%3Aparent-1&msg=msg-3",
    },
  ]]);
});

test("buildPushTargetsFromContext excludes muted users from followed thread reply pushes", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "thread-1", type: "thread", name: "thread-1", parentMessageId: "parent-1" },
    messageId: "msg-thread-muted",
    senderId: "agent-1",
    senderType: "agent",
    senderName: "Ray",
    body: "please take a look",
    parentChannel: { id: "channel-1", type: "channel", name: "engineering" },
    followedUserIds: ["user-1", "user-2"],
    mutedUserIds: new Set(["user-1"]),
  });

  assert.deepEqual(legacyPushEntries(targets), [[
    "user-2",
    {
      title: "Thread in #engineering · Acme Workspace",
      body: "Ray: please take a look",
      tag: "message:msg-thread-muted",
      url: "/s/acme/channel/channel-1?thread=channel-1%3Aparent-1&msg=msg-thread-muted",
    },
  ]]);
});

test("buildPushTargetsFromContext does not push thread replies to non-followed mentions", () => {
  const targets = buildPushTargetsFromContext({
    serverSlug: "acme",
    channel: { id: "thread-2", type: "thread", name: "thread-2", parentMessageId: "parent-2" },
    messageId: "msg-4",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "ping",
    parentChannel: { id: "dm-2", type: "dm", name: "ray" },
    mentionNames: new Set(["tygg"]),
    humanScopeMembers: [{ id: "user-2", name: "tygg" }],
  });

  assert.deepEqual(legacyPushEntries(targets), []);
});

const LEGACY_NOTIFICATION_PUSH_SOCKET_PAYLOAD_KEYS = [
  "body",
  "channelId",
  "kind",
  "messageId",
  "parentChannelId",
  "parentMessageId",
  "serverId",
  "tag",
  "threadId",
  "title",
  "url",
].sort();

const STRUCTURED_NOTIFICATION_PUSH_SOCKET_PAYLOAD_KEYS = [
  ...LEGACY_NOTIFICATION_PUSH_SOCKET_PAYLOAD_KEYS,
  "channelName",
  "messagePreview",
  "mentioned",
  "parentChannelKind",
  "senderId",
  "senderName",
  "senderType",
  "serverName",
].sort();

function pushMapToTargets(targets: Map<string, { title: string; body: string; tag: string; url: string }>) {
  return [...targets.entries()].map(([userId, payload]) => ({ userId, payload }));
}

test("buildNotificationPushSocketTargets mirrors DM push targets with a closed typed identity payload", () => {
  const pushTargets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "dm-1", type: "dm", name: "ray", parentMessageId: null },
    messageId: "msg-dm-socket",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hello",
    dmHumans: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
    ],
  });

  const socketTargets = buildNotificationPushSocketTargets(pushMapToTargets(pushTargets), {
    serverId: "server-1",
    kind: "dm",
    channelId: "dm-1",
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
    messageId: "msg-dm-socket",
  });

  assert.deepEqual(socketTargets.map((target) => target.userId), [...pushTargets.keys()]);
  assert.deepEqual(Object.keys(socketTargets[0]!.payload).sort(), STRUCTURED_NOTIFICATION_PUSH_SOCKET_PAYLOAD_KEYS);
  assert.deepEqual(socketTargets[0]!.payload, {
    title: "DM · Acme Workspace",
    body: "Ray: hello",
    tag: "message:msg-dm-socket",
    url: "/s/acme/dm/dm-1?msg=msg-dm-socket",
    serverName: "Acme Workspace",
    channelName: null,
    parentChannelKind: null,
    senderId: "user-1",
    senderName: "Ray",
    senderType: "user",
    messagePreview: "hello",
    mentioned: false,
    serverId: "server-1",
    kind: "dm",
    channelId: "dm-1",
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
    messageId: "msg-dm-socket",
  });
});

test("Web Push and mobile socket transports share the same plain-text Markdown preview", () => {
  const messagePreview = summarizePushBody(
    "## **Release ready** — read the [runbook](https://example.com/runbook).",
    0,
  );
  const pushTargets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "dm-1", type: "dm", name: "ray", parentMessageId: null },
    messageId: "msg-markdown-preview",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: messagePreview,
    dmHumans: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
    ],
  });
  const socketTargets = buildNotificationPushSocketTargets(pushMapToTargets(pushTargets), {
    serverId: "server-1",
    kind: "dm",
    channelId: "dm-1",
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
    messageId: "msg-markdown-preview",
  });

  assert.equal(messagePreview, "Release ready — read the runbook.");
  assert.equal(pushTargets.get("user-2")?.body, "Ray: Release ready — read the runbook.");
  assert.equal(socketTargets[0]?.payload.body, pushTargets.get("user-2")?.body);
  assert.equal(socketTargets[0]?.payload.messagePreview, messagePreview);
});

test("buildNotificationPushSocketTargets preserves muted channel target exclusions", () => {
  const pushTargets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "channel-1", type: "channel", name: "engineering", parentMessageId: null },
    messageId: "msg-muted-socket",
    senderId: "user-1",
    senderType: "user",
    senderName: "Ray",
    body: "hi @tygg",
    mentionNames: new Set(["tygg"]),
    mutedUserIds: new Set(["user-2"]),
    humanScopeMembers: [
      { id: "user-1", name: "ray" },
      { id: "user-2", name: "tygg" },
      { id: "user-3", name: "applepi" },
    ],
  });

  const socketTargets = buildNotificationPushSocketTargets(pushMapToTargets(pushTargets), {
    serverId: "server-1",
    kind: "channel",
    channelId: "channel-1",
    threadId: null,
    parentChannelId: null,
    parentMessageId: null,
    messageId: "msg-muted-socket",
  });

  assert.deepEqual(socketTargets.map((target) => target.userId), ["user-3"]);
});

test("buildNotificationPushSocketTargets preserves followed-thread target scope", () => {
  const pushTargets = buildPushTargetsFromContext({
    serverSlug: "acme",
    serverName: "Acme Workspace",
    channel: { id: "thread-1", type: "thread", name: "thread-1", parentMessageId: "parent-1" },
    messageId: "msg-thread-socket",
    senderId: "agent-1",
    senderType: "agent",
    senderName: "Ray",
    body: "please take a look",
    parentChannel: { id: "channel-1", type: "channel", name: "engineering" },
    followedUserIds: ["user-1"],
  });

  const socketTargets = buildNotificationPushSocketTargets(pushMapToTargets(pushTargets), {
    serverId: "server-1",
    kind: "thread",
    channelId: "thread-1",
    threadId: "thread-1",
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    messageId: "msg-thread-socket",
  });

  assert.deepEqual(socketTargets.map((target) => target.userId), [...pushTargets.keys()]);
  assert.deepEqual(socketTargets[0]!.payload, {
    title: "Thread in #engineering · Acme Workspace",
    body: "Ray: please take a look",
    tag: "message:msg-thread-socket",
    url: "/s/acme/channel/channel-1?thread=channel-1%3Aparent-1&msg=msg-thread-socket",
    serverName: "Acme Workspace",
    channelName: "engineering",
    parentChannelKind: "channel",
    senderId: "agent-1",
    senderName: "Ray",
    senderType: "agent",
    messagePreview: "please take a look",
    mentioned: false,
    serverId: "server-1",
    kind: "thread",
    channelId: "thread-1",
    threadId: "thread-1",
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    messageId: "msg-thread-socket",
  });
});

test("buildNotificationPushProjectionTargets preserves receiver-local identities for one user on both joint servers", () => {
  const targets = buildNotificationPushProjectionTargets([
    {
      targets: new Map([["user-shared", {
        title: "Thread in #partners · Alpha Workspace",
        body: "Ray: hello from the joint thread",
        tag: "message:msg-joint-thread",
        url: "/s/alpha/channel/parent-alpha?thread=parent-alpha%3Aparent-message&msg=msg-joint-thread",
      }]]),
      identity: {
        serverId: "server-alpha",
        kind: "thread",
        channelId: "thread-alpha",
        threadId: "thread-alpha",
        parentChannelId: "parent-alpha",
        parentMessageId: "parent-message",
        messageId: "msg-joint-thread",
      },
    },
    {
      targets: new Map([["user-shared", {
        title: "Thread in #partners · Beta Workspace",
        body: "Ray: hello from the joint thread",
        tag: "message:msg-joint-thread",
        url: "/s/beta/channel/parent-beta?thread=parent-beta%3Aparent-message&msg=msg-joint-thread",
      }]]),
      identity: {
        serverId: "server-beta",
        kind: "thread",
        channelId: "thread-beta",
        threadId: "thread-beta",
        parentChannelId: "parent-beta",
        parentMessageId: "parent-message",
        messageId: "msg-joint-thread",
      },
    },
    {
      targets: new Map(),
      identity: {
        serverId: "server-without-local-recipient",
        kind: "thread",
        channelId: "thread-empty",
        threadId: "thread-empty",
        parentChannelId: "parent-empty",
        parentMessageId: "parent-message",
        messageId: "msg-joint-thread",
      },
    },
  ]).sort((left, right) => left.identity.serverId.localeCompare(right.identity.serverId));

  assert.equal(targets.length, 2);
  assert.deepEqual(targets, [
    {
      userId: "user-shared",
      payload: {
        title: "Thread in #partners · Alpha Workspace",
        body: "Ray: hello from the joint thread",
        tag: "message:msg-joint-thread",
        url: "/s/alpha/channel/parent-alpha?thread=parent-alpha%3Aparent-message&msg=msg-joint-thread",
      },
      identity: {
        serverId: "server-alpha",
        kind: "thread",
        channelId: "thread-alpha",
        threadId: "thread-alpha",
        parentChannelId: "parent-alpha",
        parentMessageId: "parent-message",
        messageId: "msg-joint-thread",
      },
    },
    {
      userId: "user-shared",
      payload: {
        title: "Thread in #partners · Beta Workspace",
        body: "Ray: hello from the joint thread",
        tag: "message:msg-joint-thread",
        url: "/s/beta/channel/parent-beta?thread=parent-beta%3Aparent-message&msg=msg-joint-thread",
      },
      identity: {
        serverId: "server-beta",
        kind: "thread",
        channelId: "thread-beta",
        threadId: "thread-beta",
        parentChannelId: "parent-beta",
        parentMessageId: "parent-message",
        messageId: "msg-joint-thread",
      },
    },
  ]);

  const socketPayloads = targets.map((target) => (
    buildNotificationPushSocketTargets([target], target.identity)[0]!.payload
  ));
  assert.deepEqual(socketPayloads.map(({ serverId, threadId, parentChannelId, title, url }) => ({
    serverId,
    threadId,
    parentChannelId,
    title,
    url,
  })), [
    {
      serverId: "server-alpha",
      threadId: "thread-alpha",
      parentChannelId: "parent-alpha",
      title: "Thread in #partners · Alpha Workspace",
      url: "/s/alpha/channel/parent-alpha?thread=parent-alpha%3Aparent-message&msg=msg-joint-thread",
    },
    {
      serverId: "server-beta",
      threadId: "thread-beta",
      parentChannelId: "parent-beta",
      title: "Thread in #partners · Beta Workspace",
      url: "/s/beta/channel/parent-beta?thread=parent-beta%3Aparent-message&msg=msg-joint-thread",
    },
  ]);

  assert.deepEqual(
    selectCanonicalWebPushProjectionTargets(targets, {
      serverId: "server-beta",
      messageId: "msg-joint-thread",
    }),
    [targets[1]],
    "web push should keep exactly the complete source-server projection",
  );
  assert.deepEqual(
    selectCanonicalWebPushProjectionTargets([targets[1]!], {
      serverId: "server-alpha",
      messageId: "msg-joint-thread",
    }),
    [targets[1]],
    "a user with only one eligible projection should retain that complete target",
  );
  assert.deepEqual(
    selectCanonicalWebPushProjectionTargets(targets, {
      serverId: "server-missing",
      messageId: "msg-joint-thread",
    }),
    [],
    "ambiguous projections without one source-server match must fail closed",
  );
  assert.deepEqual(
    selectCanonicalWebPushProjectionTargets(targets, {
      serverId: "server-beta",
      messageId: "different-message",
    }),
    [],
    "projection targets from another message must never be selected",
  );
});

test("broadcastAndDeliver shares the authoritative recipient set and persists native intent without APP_URL", async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSocketFlag = process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  process.env.APP_URL = "https://app.example.test";
  delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  const sentTargets: Array<{ userId: string; payload: { title: string; body: string; tag: string; url: string } }> = [];
  const nativeRecipientBatches: string[][] = [];

  __setMessageServiceDepsForTests({
    createMessage: async (channelId: string, senderType: "user" | "agent", senderId: string, content: string, messageType: "chat" | "system" = "chat") =>
      makePersistedMessage({
        id: "msg-push-socket",
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any,
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelHumans: async () => [],
    getChannelAgents: async () => [],
    getChannelMembers: async () => ({ agents: [], humans: [] }),
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    markAgentLegacyRead: async () => {},
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map([
      ["user-2", {
        title: "#engineering · Acme Workspace",
        body: "Ray: hello socket mirror",
        tag: "message:msg-push-socket",
        url: "/s/acme/channel/channel-1?msg=msg-push-socket",
      }],
      ["user-3", {
        title: "#engineering · Acme Workspace",
        body: "Ray: hello socket mirror",
        tag: "message:msg-push-socket",
        url: "/s/acme/channel/channel-1?msg=msg-push-socket",
      }],
    ]),
    sendPushNotifications: async (targets) => {
      sentTargets.push(...targets);
    },
    persistNativeNotificationIntents: async (intents) => {
      nativeRecipientBatches.push(intents.map((intent) => intent.recipientUserId));
      return intents.length;
    },
    getMentionFactsForMessages: async () => new Map(),
  });

  try {
    const { io, events } = createIoRecorder();
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "hello socket mirror",
    });

    const notificationEvents = events.filter((event) => event.event === "notification:push");
    assert.deepEqual(sentTargets.map((target) => target.userId), ["user-2", "user-3"]);
    assert.deepEqual(nativeRecipientBatches, [["user-2", "user-3"]], "native must consume the exact authoritative web recipient set");
    assert.deepEqual(
      notificationEvents.map((event) => event.room),
      sentTargets.map((target) => socketClientKindRoom(target.userId, "mobile")),
    );
    assert.deepEqual(
      events.filter((event) => event.event === "notification:push" && event.room.startsWith("user:") && !event.room.includes(":clientKind:")),
      [],
      "notification:push must not use unfiltered user rooms because web sockets also join them",
    );
    for (const event of notificationEvents) {
      assert.deepEqual(Object.keys(event.payload).sort(), LEGACY_NOTIFICATION_PUSH_SOCKET_PAYLOAD_KEYS);
    }
    assert.deepEqual(notificationEvents[0]!.payload, {
      title: "#engineering · Acme Workspace",
      body: "Ray: hello socket mirror",
      tag: "message:msg-push-socket",
      url: "https://app.example.test/s/acme/channel/channel-1?msg=msg-push-socket",
      serverId: "server-1",
      kind: "channel",
      channelId: "channel-1",
      threadId: null,
      parentChannelId: null,
      parentMessageId: null,
      messageId: "msg-push-socket",
    });

    delete process.env.APP_URL;
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "native survives missing web origin",
    });
    assert.deepEqual(nativeRecipientBatches, [
      ["user-2", "user-3"],
      ["user-2", "user-3"],
    ], "native persistence must stay independent of the optional web origin");
    assert.equal(sentTargets.length, 2, "missing APP_URL must suppress only the web dispatch");
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSocketFlag === undefined) delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
    else process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED = previousSocketFlag;
  }
});

test("notification payload projection stays fail-closed while Socket diagnostics are best-effort", async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSocketFlag = process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  process.env.APP_URL = "https://app.example.test";
  delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  await openTestDatabase("pglite://");
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "notification-socket-trace-owner@test.com",
      name: "NotificationSocketTraceOwner",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Notification Socket Trace",
      slug: "notification-socket-trace",
      ownerId: owner.id,
    }).returning();
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
    const [channel] = await db.insert(channels).values({
      serverId: server.id,
      name: "notification-socket-trace",
      type: "channel",
    }).returning();
    await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });

    const notificationDeps = {
      markRead: async () => undefined,
      renderAgentReadablePermalinks: async (content: string) => content,
      getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
        uniqueName: fallbackName,
        description: null,
      }),
      buildPushTargets: async () => new Map([["notification-recipient", {
        title: "#notification-socket-trace · Notification Socket Trace",
        body: "durable before realtime",
        tag: "message:notification-socket-trace",
        url: `/s/${server.slug}/channel/${channel.id}`,
      }]]),
      sendPushNotifications: async () => undefined,
      persistNativeNotificationIntents: async (intents) => intents.length,
    } satisfies Parameters<typeof __setMessageServiceDepsForTests>[0];
    __setMessageServiceDepsForTests(notificationDeps);

    const recorded = createIoRecorder();
    const io = {
      ...recorded.io,
      to(room: string) {
        const target = recorded.io.to(room);
        return {
          emit(event: string, payload: unknown) {
            if (event === "notification:push") {
              throw new Error("review notification socket failure");
            }
            target.emit(event, payload);
          },
        };
      },
    } as any;
    const tracer = new BasicTracer({
      sink: {
        record() {},
        recordEvent(record) {
          if (record.event.name === "message_pipeline.frontend_socket_emit.degraded") {
            throw new Error("review trace callback failure");
          }
        },
      },
    });

    const sent = await withTraceRoot(
      tracer,
      "server.http.request",
      { surface: "server", kind: "server" },
      () => broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
        channelId: channel.id,
        senderType: "user",
        senderId: owner.id,
        senderName: owner.name,
        content: "durable before realtime",
      }),
    );

    assert.equal(sent.content, "durable before realtime");
    const durableRows = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, sent.id));
    assert.equal(durableRows.length, 1, "the first-send fact must remain durable despite both realtime failures");

    __setMessageServiceDepsForTests({
      ...notificationDeps,
      buildNotificationPushSocketTargets: () => {
        throw new Error("review notification payload projection failure");
      },
    });
    await assert.rejects(
      () => broadcastAndDeliver(recorded.io as any, { deliverMessage: async () => undefined } as any, {
        channelId: channel.id,
        senderType: "user",
        senderId: owner.id,
        senderName: owner.name,
        content: "projection remains fail-closed",
      }),
      /review notification payload projection failure/,
    );
    const projectionFailureRows = await db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.channelId, channel.id),
      eq(messages.content, "projection remains fail-closed"),
    ));
    assert.equal(projectionFailureRows.length, 1, "the projection error occurs after the source fact is durable");
  } finally {
    await closeTestDatabase();
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSocketFlag === undefined) delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
    else process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED = previousSocketFlag;
  }
});

test("notification push socket kill-switch suppresses user-room emits without changing web push dispatch", async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSocketFlag = process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  process.env.APP_URL = "https://app.example.test";
  process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED = "false";
  let sentCount = 0;

  __setMessageServiceDepsForTests({
    createMessage: async (channelId: string, senderType: "user" | "agent", senderId: string, content: string, messageType: "chat" | "system" = "chat") =>
      makePersistedMessage({
        id: "msg-push-kill",
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any,
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelHumans: async () => [],
    getChannelAgents: async () => [],
    getChannelMembers: async () => ({ agents: [], humans: [] }),
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    markAgentLegacyRead: async () => {},
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map([
      ["user-2", {
        title: "#engineering · Acme Workspace",
        body: "Ray: hello kill switch",
        tag: "message:msg-push-kill",
        url: "/s/acme/channel/channel-1?msg=msg-push-kill",
      }],
    ]),
    sendPushNotifications: async () => {
      sentCount += 1;
    },
    getMentionFactsForMessages: async () => new Map(),
  });

  try {
    const { io, events } = createIoRecorder();
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "hello kill switch",
    });

    assert.equal(sentCount, 1, "web push dispatch must remain scheduled");
    assert.deepEqual(events.filter((event) => event.event === "notification:push"), []);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSocketFlag === undefined) delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
    else process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED = previousSocketFlag;
  }
});

test("broadcastAndDeliver replays the original persisted agent send and re-broadcasts the same message on retry", async () => {
  const replayDb = createAgentSendReplayDb();
  __setAgentSendReplayDbForTests(() => replayDb.db as any);

  const markAgentLegacyReadCalls: { senderId: string; channelId: string; seq: number }[] = [];
  __setMessageServiceDepsForTests({
    // Persistence/replay is supplied by the in-memory replay adapter below.
    recordInboxNotificationFacts: async () => 0,
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [],
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markAgentLegacyRead: async (senderId: string, channelId: string, seq: number) => {
      markAgentLegacyReadCalls.push({ senderId, channelId, seq });
    },
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
  });

  const { io, events } = createIoRecorder();
  const agentOrchestrator = { deliverMessage: async () => undefined } as any;
  const sendOpts = {
    channelId: "channel-1",
    senderType: "agent" as const,
    senderId: "agent-1",
    senderName: "Agent One",
    content: "hello from retry-safe send",
    agentSendKey: "send-key-1",
  };

  const first = await broadcastAndDeliver(io, agentOrchestrator, sendOpts);
  const second = await broadcastAndDeliver(io, agentOrchestrator, sendOpts);

  assert.equal(first.id, second.id);
  assert.equal(first.seq, second.seq);
  assert.equal(replayDb.stats().insertedRows, 1);
  assert.equal(replayDb.stats().insertAttempts, 2);
  assert.equal(markAgentLegacyReadCalls.length, 1);

  const newMessageEvents = events.filter((entry) => entry.event === "message:new");
  assert.equal(newMessageEvents.length, 2);
  assert.deepEqual(
    newMessageEvents.map((entry) => ({
      room: entry.room,
      messageId: entry.payload.id,
      seq: entry.payload.seq,
      senderName: entry.payload.senderName,
      conversationContext: entry.payload.conversationContext,
    })),
    [
      {
        room: "channel:channel-1",
        messageId: first.id,
        seq: first.seq,
        senderName: "Agent One",
        conversationContext: { channelType: "channel" },
      },
      {
        room: "channel:channel-1",
        messageId: first.id,
        seq: first.seq,
        senderName: "Agent One",
        conversationContext: { channelType: "channel" },
      },
    ],
  );
});

test("broadcastAndDeliver emits dm:new to human user room for first-touch DM sidebar hydration", async () => {
  __setMessageServiceDepsForTests({
    createMessage: async (channelId: string, senderType: "user" | "agent", senderId: string, content: string, messageType: "chat" | "system" = "chat") =>
      makePersistedMessage({
        id: "msg-dm-agent",
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any,
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "dm",
      name: "Morgan",
      parentMessageId: null,
    } as any),
    getChannelHumans: async () => [{ id: "owner-1" }] as any,
    getChannelAgents: async () => [],
    getChannelMembers: async () => ({ agents: [], humans: [] }),
    assertChannelNotArchived: async () => undefined,
    markAgentLegacyRead: async () => {},
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => {},
    getMentionFactsForMessages: async () => new Map(),
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
    channelId: "dm-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Morgan",
    content: "I'm online as Morgan.",
  });

  assert.ok(
    events.some((entry) => entry.room === "channel:dm-1" && entry.event === "dm:new"),
    "existing channel-room dm:new remains for sockets already in the DM",
  );
  assert.ok(
    events.some((entry) => entry.room === "user:owner-1" && entry.event === "dm:new"),
    "first-touch DM must notify the human user room so the sidebar can hydrate",
  );
});

test("broadcastSystemMessage emits dm:new to human user room for system DM sidebar hydration", async () => {
  __setMessageServiceDepsForTests({
    createMessage: async (channelId: string, senderType: "user" | "agent", senderId: string, content: string, messageType: "chat" | "system" = "chat") =>
      makePersistedMessage({
        id: "msg-dm-system",
        channelId,
        senderType,
        senderId,
        content,
        searchText: content,
        messageType,
      }) as any,
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "dm",
      name: "Morgan",
      parentMessageId: null,
    } as any),
    getChannelHumans: async () => [{ id: "owner-1" }] as any,
    getChannelAgents: async () => [],
    getChannelMembers: async () => ({ agents: [], humans: [] }),
    renderAgentReadablePermalinks: async (content: string) => content,
    getActivityMutedAgentIdsForMessage: async () => new Set<string>(),
  });

  const { io, events } = createIoRecorder();
  await broadcastSystemMessage(io, { deliverMessage: async () => undefined } as any, "dm-1", "System DM", {
    inboxFactPolicy: {
      mode: "skip",
      producer: "test.dm_hydration",
      reason: "unit test does not need inbox fact persistence",
    },
  });

  assert.ok(
    events.some((entry) => entry.room === "channel:dm-1" && entry.event === "dm:new"),
    "existing channel-room dm:new remains for sockets already in the DM",
  );
  assert.ok(
    events.some((entry) => entry.room === "user:owner-1" && entry.event === "dm:new"),
    "system-created first-touch DM must notify the human user room so the sidebar can hydrate",
  );
});

test("broadcastAndDeliver keeps keyless agent sends on the legacy non-idempotent path", async () => {
  const replayDb = createAgentSendReplayDb();
  __setAgentSendReplayDbForTests(() => replayDb.db as any);

  let nextSeq = 200;
  __setMessageServiceDepsForTests({
    createMessage: async (channelId, senderType, senderId, content, messageType = "chat") => {
      const createdAt = new Date(`2026-04-17T00:01:${String(nextSeq - 199).padStart(2, "0")}.000Z`);
      return {
        id: `legacy-msg-${nextSeq}`,
        seq: nextSeq++,
        channelId,
        senderType,
        senderId,
        agentSendKey: null,
        messageType,
        content,
        searchText: content,
        searchVector: null,
        threadId: null,
        taskStatus: null,
        taskNumber: null,
        taskAssigneeType: null,
        taskAssigneeId: null,
        taskClaimedAt: null,
        taskCompletedAt: null,
        createdAt,
        updatedAt: createdAt,
      } as any;
    },
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [],
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
  });
  const { io, events } = createIoRecorder();
  const agentOrchestrator = { deliverMessage: async () => undefined } as any;
  const sendOpts = {
    channelId: "channel-1",
    senderType: "agent" as const,
    senderId: "agent-1",
    senderName: "Agent One",
    content: "legacy send path",
  };

  const first = await broadcastAndDeliver(io, agentOrchestrator, sendOpts);
  const second = await broadcastAndDeliver(io, agentOrchestrator, sendOpts);

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.seq, second.seq);
  assert.equal(replayDb.stats().insertAttempts, 0);

  const newMessageEvents = events.filter((entry) => entry.event === "message:new");
  assert.equal(newMessageEvents.length, 2);
  assert.deepEqual(
    newMessageEvents.map((entry) => ({ id: entry.payload.id, seq: entry.payload.seq })),
    [
      { id: first.id, seq: first.seq },
      { id: second.id, seq: second.seq },
    ],
  );
});

test("broadcastAndDeliver emits dm conversationContext without changing the top-level channel id", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "dm-context-owner@test.com",
    name: "DmContextOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [peer] = await db.insert(users).values({
    email: "dm-context-peer@test.com",
    name: "DmContextPeer",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "DM Context",
    slug: "dm-context",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: peer.id, role: "member" },
  ]);
  const [dmChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "dm-context-room",
    type: "dm",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: dmChannel.id, userId: owner.id },
    { channelId: dmChannel.id, userId: peer.id },
  ]);

  __setMessageServiceDepsForTests({
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
    channelId: dmChannel.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    content: "dm frame",
    randomId: "dm-random-id-1",
  });

  const emittedMessage = events.find((event) => event.event === "message:new" && event.room === `channel:${dmChannel.id}`)?.payload;
  assert.ok(emittedMessage, "expected realtime message:new payload");
  assert.equal(emittedMessage.channelId, dmChannel.id);
  assert.equal(emittedMessage.randomId, "dm-random-id-1");
  assert.deepEqual(emittedMessage.conversationContext, { channelType: "dm" });
});

test("broadcastAndDeliver only emits private-thread parent context to parent-visible followers", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "private-thread-context-owner@test.com",
    name: "PrivateThreadContextOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [outsider] = await db.insert(users).values({
    email: "private-thread-context-outsider@test.com",
    name: "PrivateThreadContextOutsider",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Private Thread Context",
    slug: "private-thread-context",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: outsider.id, role: "member" },
  ]);
  const [privateParent] = await db.insert(channels).values({
    serverId: server.id,
    name: "private-thread-context-parent",
    type: "private",
  }).returning();
  await db.insert(channelHumans).values({ channelId: privateParent.id, userId: owner.id });
  const parent = await createMessage(privateParent.id, "user", owner.id, "private parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: outsider.id,
    parentMessageId: parent.id,
    reason: "manual",
  });

  __setMessageServiceDepsForTests({
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
    channelId: thread.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    content: "private thread reply",
  });

  const emittedMessages = events.filter((event) => event.event === "message:new");
  assert.equal(emittedMessages.some((event) => event.room === `user:${outsider.id}`), false);
  const ownerMessage = emittedMessages.find((event) => event.room === `user:${owner.id}`)?.payload;
  assert.ok(ownerMessage, "expected parent-visible owner to receive the private thread frame");
  assert.deepEqual(ownerMessage.conversationContext, {
    channelType: "thread",
    parentMessageId: parent.id,
    parentChannelId: privateParent.id,
    parentChannelType: "private",
  });
});

test("broadcastAndDeliver emits replies sync window producer envelope for normal parent scopes", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-window-owner@test.com",
    name: "ThreadWindowOwner",
    displayName: "Thread Window Owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [peer] = await db.insert(users).values({
    email: "thread-window-peer@test.com",
    name: "ThreadWindowPeer",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Window",
    slug: "thread-window",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: peer.id, role: "member" },
  ]);

  __setMessageServiceDepsForTests({
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  for (const parentType of ["channel", "private", "dm"] as const) {
    const [parentChannel] = await db.insert(channels).values({
      serverId: server.id,
      name: `thread-window-${parentType}`,
      type: parentType,
    }).returning();
    await db.insert(channelHumans).values(
      parentType === "dm"
        ? [
            { channelId: parentChannel.id, userId: owner.id },
            { channelId: parentChannel.id, userId: peer.id },
          ]
        : [{ channelId: parentChannel.id, userId: owner.id }],
    );
    const parent = await createMessage(parentChannel.id, "user", owner.id, `${parentType} parent`);
    const thread = await getOrCreateThread(parent.id, owner.id, "user");

    const { io, events } = createIoRecorder();
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: thread.id,
      senderType: "user",
      senderId: owner.id,
      senderName: owner.displayName!,
      content: `${parentType} thread reply`,
    });

    const event = parentType === "channel"
      ? events.find((entry) => entry.event === "thread:updated" && entry.room === `channel:${parentChannel.id}`)
      : events.find((entry) => entry.event === "thread:updated" && entry.room === `user:${owner.id}`);
    assert.ok(event, `expected ${parentType} thread:updated payload`);
    assert.equal(event.payload.threadChannelId, thread.id);
    assert.equal(event.payload.latestReply.senderDisplayName, owner.displayName);
    assertThreadRepliesSyncWindow(event.payload, {
      serverId: server.id,
      parentMessageId: parent.id,
      parentScopeKind: parentType,
      parentScopeId: parentChannel.id,
    });
  }
});

test("broadcastAndDeliver sends one source projection to web and both receiver-local projections to mobile for joint channels", async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSocketFlag = process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  process.env.APP_URL = "https://app.example.test";
  delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  const createdAt = new Date("2026-04-17T00:02:00.000Z");
  await openTestDatabase("pglite://");
  try {
    const db = getDb();
    const [ownerA] = await db.insert(users).values({
      email: "joint-context-owner-a@test.com",
      name: "JointContextOwnerA",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [ownerB] = await db.insert(users).values({
      email: "joint-context-owner-b@test.com",
      name: "JointContextOwnerB",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [sharedRecipient] = await db.insert(users).values({
      email: "joint-context-shared-recipient@test.com",
      name: "JointContextSharedRecipient",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [serverA] = await db.insert(servers).values({
      name: "Joint Context A",
      slug: "joint-context-a",
      ownerId: ownerA.id,
    }).returning();
    const [serverB] = await db.insert(servers).values({
      name: "Joint Context B",
      slug: "joint-context-b",
      ownerId: ownerB.id,
    }).returning();
    await db.insert(serverMembers).values([
      { serverId: serverA.id, userId: ownerA.id, role: "owner" },
      { serverId: serverB.id, userId: ownerB.id, role: "owner" },
      { serverId: serverA.id, userId: sharedRecipient.id, role: "member" },
      { serverId: serverB.id, userId: sharedRecipient.id, role: "member" },
    ]);
    const [canonicalChannel] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-context-canonical",
      type: "joint",
    }).returning();
    const [localChannelA] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-context-local-a",
      type: "joint",
    }).returning();
    const [localChannelB] = await db.insert(channels).values({
      serverId: serverB.id,
      name: "joint-context-local-b",
      type: "joint",
    }).returning();
    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonicalChannel.id,
      createdByServerId: serverA.id,
      createdByUserId: ownerA.id,
    }).returning();
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: joint.id,
        serverId: serverA.id,
        localChannelId: localChannelA.id,
        role: "host",
        status: "active",
        joinedByUserId: ownerA.id,
      },
      {
        jointChannelId: joint.id,
        serverId: serverB.id,
        localChannelId: localChannelB.id,
        role: "participant",
        status: "active",
        joinedByUserId: ownerB.id,
      },
    ]);
    await db.insert(channelHumans).values([
      { channelId: localChannelA.id, userId: sharedRecipient.id },
      { channelId: localChannelB.id, userId: sharedRecipient.id },
    ]);
    const sentTargetBatches: any[][] = [];
    const nativeIntentBatches: any[][] = [];
    let signalFirstPush: (() => void) | undefined;
    const firstPush = new Promise<void>((resolve) => {
      signalFirstPush = resolve;
    });
    __setMessageServiceDepsForTests({
      createMessage: async (channelId, senderType, senderId, content, messageType = "chat") => ({
        id: "joint-msg-1",
        seq: 1,
        channelId,
        senderType,
        senderId,
        agentSendKey: null,
        messageType,
        content,
        searchText: content,
        searchVector: null,
        threadId: null,
        taskStatus: null,
        taskNumber: null,
        taskAssigneeType: null,
        taskAssigneeId: null,
        taskClaimedAt: null,
        taskCompletedAt: null,
        createdAt,
        updatedAt: createdAt,
      } as any),
      getActiveJointChannelProjectionsByLocalChannel,
      getChannelAgents: async () => [],
      assertChannelNotArchived: async () => undefined,
      markRead: async () => undefined,
      renderAgentReadablePermalinks: async (content: string) => content,
      buildPushTargets: async () => new Map(),
      sendPushNotifications: async (targets) => {
        sentTargetBatches.push(targets as any[]);
        signalFirstPush?.();
      },
      persistNativeNotificationIntents: async (intents) => {
        nativeIntentBatches.push([...intents]);
        return intents.length;
      },
      getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
        uniqueName: fallbackName,
        description: null,
      }),
    });

    const { io, events } = createIoRecorder();
    await broadcastAndDeliver(io, { deliverMessage: async () => undefined } as any, {
      channelId: localChannelB.id,
      senderType: "user",
      senderId: ownerB.id,
      senderName: ownerB.name,
      content: "joint frame",
    });
    await waitForTestSignal(firstPush, "joint channel notification dispatch");

    const localBFrame = events.find((event) => event.event === "message:new" && event.room === `channel:${localChannelB.id}`)?.payload;
    assert.ok(localBFrame, "expected realtime message:new payload for local joint projection");
    assert.equal(localBFrame.channelId, localChannelB.id);
    assert.deepEqual(localBFrame.conversationContext, { channelType: "joint" });

    assert.equal(sentTargetBatches.length, 1);
    assert.equal(nativeIntentBatches.length, 1);
    assert.deepEqual(nativeIntentBatches[0]!.map((intent) => ({
      userId: intent.recipientUserId,
      serverId: intent.serverId,
      channelId: intent.channelId,
    })), [{
      userId: sharedRecipient.id,
      serverId: serverB.id,
      channelId: localChannelB.id,
    }], "joint native projection must use the same single canonical source target as web push");
    const pushed = sentTargetBatches[0]!
      .map((target) => ({
        userId: target.userId,
        serverId: target.identity.serverId,
        channelId: target.identity.channelId,
        title: target.payload.title,
        url: target.payload.url,
      }))
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
    assert.deepEqual(pushed, [
      {
        userId: sharedRecipient.id,
        serverId: serverB.id,
        channelId: localChannelB.id,
        title: `#${localChannelB.name} · ${serverB.name}`,
        url: `https://app.example.test/s/${serverB.slug}/channel/${localChannelB.id}?msg=joint-msg-1`,
      },
    ].sort((left, right) => left.serverId.localeCompare(right.serverId)));

    const socketPushes = events
      .filter((event) => event.event === "notification:push")
      .map((event) => ({
        room: event.room,
        serverId: event.payload.serverId,
        channelId: event.payload.channelId,
        title: event.payload.title,
        url: event.payload.url,
      }))
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
    assert.deepEqual(socketPushes, [
      {
        room: socketClientKindRoom(sharedRecipient.id, "mobile"),
        serverId: serverA.id,
        channelId: localChannelA.id,
        title: `#${localChannelA.name} · ${serverA.name}`,
        url: `https://app.example.test/s/${serverA.slug}/channel/${localChannelA.id}?msg=joint-msg-1`,
      },
      {
        room: socketClientKindRoom(sharedRecipient.id, "mobile"),
        serverId: serverB.id,
        channelId: localChannelB.id,
        title: `#${localChannelB.name} · ${serverB.name}`,
        url: `https://app.example.test/s/${serverB.slug}/channel/${localChannelB.id}?msg=joint-msg-1`,
      },
    ].sort((left, right) => left.serverId.localeCompare(right.serverId)));
  } finally {
    await closeTestDatabase();
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSocketFlag === undefined) delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
    else process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED = previousSocketFlag;
  }
});

test("broadcastAndDeliver lets tests stub the archive gate without initializing the real DB", async () => {
  let archiveChecks = 0;
  let createCalls = 0;
  __setMessageServiceDepsForTests({
    assertChannelNotArchived: async () => {
      archiveChecks += 1;
    },
    createMessage: async (channelId, senderType, senderId, content, messageType = "chat") => {
      createCalls += 1;
      const createdAt = new Date("2026-04-21T00:00:01.000Z");
      return {
        id: "stub-msg-1",
        seq: 1,
        channelId,
        senderType,
        senderId,
        agentSendKey: null,
        messageType,
        content,
        searchText: content,
        searchVector: null,
        threadId: null,
        taskStatus: null,
        taskNumber: null,
        taskAssigneeType: null,
        taskAssigneeId: null,
        taskClaimedAt: null,
        taskCompletedAt: null,
        createdAt,
        updatedAt: createdAt,
      } as any;
    },
    getChannel: async (channelId: string) => ({
      id: channelId,
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [],
    getChannelHumans: async () => [],
    markRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = { deliverMessage: async () => undefined } as any;

  const message = await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ray",
    content: "archive seam stays mockable",
  });

  assert.equal(archiveChecks, 1);
  assert.equal(createCalls, 1);
  assert.equal(message.id, "stub-msg-1");
});

test("broadcastAndDeliver strips forwarded-bundle source pointers from realtime broadcast", async ({ db }) => {
const deliveries: { agentId: string; payload: any }[] = [];
const forwardedMetadata = {
  kind: "forwarded-bundle",
  forwardedBy: { type: "user", id: "user-1", name: "Ray" },
  forwardedAt: "2026-04-19T12:01:00.000Z",
  destinationTargetId: "channel-1",
  forwardedItems: [{
    sourceServerId: "server-source",
    sourceTargetId: "source-channel",
    sourceMessageId: "source-message",
    sourceTargetSnapshot: {
      id: "source-channel",
      type: "channel",
      label: "#source-public",
      labelVisibility: "public",
    },
    sourceAuthorSnapshot: { type: "user", id: "source-author", name: "Source Author", uniqueName: "sourceauthor" },
    contentSnapshot: "forwarded body stays visible",
    attachmentSnapshots: [{ filename: "proof.pdf", mimeType: "application/pdf" }],
    attachmentPolicy: "excluded",
    provenanceState: "available",
  }],
};

__setMessageServiceDepsForTests({
  createMessage: async (_channelId, _senderType, _senderId, content, _messageType, _taskFields, extraFields) => ({
    id: "msg-forwarded",
    seq: 47,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    content,
    searchText: content,
    messageType: "chat",
    threadId: null,
    taskStatus: null,
    taskNumber: null,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt: new Date("2026-04-19T12:04:00.000Z"),
    updatedAt: new Date("2026-04-19T12:04:00.000Z"),
    actionMetadata: extraFields?.actionMetadata ?? null,
  } as any),
  getChannel: async () => ({
    id: "channel-1",
    serverId: "server-1",
    type: "channel",
    name: "engineering",
    parentMessageId: null,
  } as any),
  getChannelAgents: async () => [{
    id: "agent-1",
    serverId: "server-1",
    serverName: "Test Server",
    serverSlug: "test",
    name: "agentone",
    displayName: "Agent One",
    status: "active",
    avatarUrl: null,
  }],
  listAgents: async () => [],
  getChannelHumans: async () => [],
  assertChannelNotArchived: async () => undefined,
  markRead: async () => undefined,
  renderAgentReadablePermalinks: async (content: string) => {
    assert.doesNotMatch(content, /forwarded body stays visible/);
    return content;
  },
  getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
    uniqueName: fallbackName,
    description: null,
  }),
  getActorServerRoleInServer: async () => "member",
  canViewerReadForwardedSource: async () => true,
  buildPushTargets: async () => new Map(),
  insertMentionRows: async () => [],
});

const { io, events } = createIoRecorder();
const agentOrchestrator = {
  deliverMessage: async (agentId: string, payload: any) => {
    deliveries.push({ agentId, payload });
  },
} as any;

const responseMessage = await broadcastAndDeliver(io, agentOrchestrator, {
  channelId: "channel-1",
  senderType: "user",
  senderId: "user-1",
  senderName: "Ray",
  content: "forwarding context",
  actionMetadata: forwardedMetadata,
});

const responseItem = (responseMessage as any).actionMetadata.forwardedItems[0];
assert.equal(responseItem.sourceTargetId, "source-channel");
assert.equal(responseItem.sourceMessageId, "source-message");
assert.equal(responseItem.sourceServerId, "server-source");
assert.equal(responseItem.provenanceState, "available");

const emittedMessage = events.find((event) => event.event === "message:new" && event.room === "channel:channel-1")?.payload;
assert.ok(emittedMessage, "expected realtime message:new payload");
const emittedItem = emittedMessage.actionMetadata.forwardedItems[0];
assert.equal(emittedItem.contentSnapshot, "forwarded body stays visible");
assert.deepEqual(emittedItem.attachmentSnapshots, [{ filename: "proof.pdf", mimeType: "application/pdf" }]);
assert.equal(emittedItem.sourceTargetId, null);
assert.equal(emittedItem.sourceMessageId, null);
assert.equal(emittedItem.sourceServerId, null);
assert.equal(emittedItem.sourceTargetSnapshot.id, null);
assert.equal(emittedItem.sourceTargetSnapshot.label, "");
assert.equal(emittedItem.sourceTargetSnapshot.labelVisibility, "restricted");
assert.equal(emittedItem.provenanceState, "original_unavailable");

await Promise.resolve();
assert.equal(deliveries.length, 1);
const agentContent = deliveries[0]?.payload.content;
assert.match(agentContent, /forwarded body stays visible/);
assert.match(agentContent, /@sourceauthor/);
assert.match(agentContent, /#source-public/);
assert.match(agentContent, /proof\.pdf/);
assert.doesNotMatch(agentContent, /Private source/);
assert.doesNotMatch(agentContent, /#source-private/);
assert.doesNotMatch(agentContent, /source-message/);
assert.doesNotMatch(agentContent, /source-channel/);
assert.doesNotMatch(agentContent, /server-source/);
});

test("broadcastAndDeliver bounds agent-facing forwarded bundle snapshots outside permalink rendering", async ({ db }) => {
const deliveries: { agentId: string; payload: any }[] = [];
let permalinkRenderInput = "";
const longForwardedBody = "https://example.test/".repeat(300);
const forwardedMetadata = {
  kind: "forwarded-bundle",
  forwardedItems: Array.from({ length: 8 }, (_, index) => ({
    sourceServerId: "server-source",
    sourceTargetId: "source-channel",
    sourceMessageId: `source-message-${index}`,
    sourceTargetSnapshot: {
      id: "source-channel",
      type: "channel",
      label: "#public-source",
      labelVisibility: "public",
    },
    sourceAuthorSnapshot: { type: "user", id: "source-author", uniqueName: "sourceauthor" },
    contentSnapshot: longForwardedBody,
    attachmentSnapshots: [],
    provenanceState: "available",
  })),
};

__setMessageServiceDepsForTests({
  createMessage: async (_channelId, _senderType, _senderId, content, _messageType, _taskFields, extraFields) => ({
    id: "msg-forwarded-large",
    seq: 48,
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    content,
    searchText: content,
    messageType: "chat",
    threadId: null,
    taskStatus: null,
    taskNumber: null,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt: new Date("2026-04-19T12:05:00.000Z"),
    updatedAt: new Date("2026-04-19T12:05:00.000Z"),
    actionMetadata: extraFields?.actionMetadata ?? null,
  } as any),
  getChannel: async () => ({
    id: "channel-1",
    serverId: "server-1",
    type: "channel",
    name: "engineering",
    parentMessageId: null,
  } as any),
  getChannelAgents: async () => [{
    id: "agent-1",
    serverId: "server-1",
    serverName: "Test Server",
    serverSlug: "test",
    name: "agentone",
    displayName: "Agent One",
    status: "active",
    avatarUrl: null,
  }],
  listAgents: async () => [],
  getChannelHumans: async () => [],
  assertChannelNotArchived: async () => undefined,
  markRead: async () => undefined,
  renderAgentReadablePermalinks: async (content: string) => {
    permalinkRenderInput = content;
    return `rendered:${content}`;
  },
  getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
    uniqueName: fallbackName,
    description: null,
  }),
  getActorServerRoleInServer: async () => "member",
  canViewerReadForwardedSource: async () => true,
  buildPushTargets: async () => new Map(),
  insertMentionRows: async () => [],
});

const { io } = createIoRecorder();
const agentOrchestrator = {
  deliverMessage: async (agentId: string, payload: any) => {
    deliveries.push({ agentId, payload });
  },
} as any;

await broadcastAndDeliver(io, agentOrchestrator, {
  channelId: "channel-1",
  senderType: "user",
  senderId: "user-1",
  senderName: "Ray",
  content: "forwarding context",
  actionMetadata: forwardedMetadata,
});

await Promise.resolve();
assert.equal(permalinkRenderInput, "forwarding context");
assert.equal(deliveries.length, 1);
const agentContent = deliveries[0]?.payload.content as string;
assert.match(agentContent, /^rendered:forwarding context\n\nForwarded content snapshot:/);
assert.match(agentContent, /\[forwarded content truncated:/);
assert.match(agentContent, /\[forwarded snapshot truncated:/);
assert.ok(agentContent.length < 13_000, `expected bounded agent payload, got ${agentContent.length}`);
assert.doesNotMatch(agentContent, /source-message-0/);
assert.doesNotMatch(agentContent, /source-channel/);
assert.doesNotMatch(agentContent, /server-source/);
});

test("④ durability precedes delivery: a mention is recoverable at the instant delivery is handed off", async ({ db }) => {
  // Self-contained, and green when run alone (the acceptance @Noel/@Hipp set in #proj-daemon:877bc75b).
  //
  // The ordering property leaves no trace in the existing 57 tests, and it cannot be caught by
  // asserting call order — so this tooth asserts the CONSEQUENCE at the only moment where the order
  // is observable: the instant the orchestrator is handed the message. If the process died exactly
  // there, could recovery still find this mention? Under persist-then-deliver, yes. Under
  // deliver-then-persist, the occurrence has no payload yet, both recovery queries filter it out,
  // and the mention is gone for good — which is why the ordering is the fail-safe side, not a style
  // preference.

  const [owner] = await db.insert(users).values({
    email: "ordering-owner@test.com",
    name: "OrderingOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Durability Precedes Delivery",
    slug: "durability-precedes-delivery",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "ordering",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
  ]);
  const [mentionedAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "ordering-agent",
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({
    channelId: channel.id,
    agentId: mentionedAgent.id,
  });

  // The flag flips only once the payload write has actually COMMITTED, so reading it is an
  // observation of durable state, not of invocation order.
  let payloadDurable = false;
  __setMessageServiceDepsForTests({
    persistMentionDeliveryOccurrences: async (rows) => {
      const result = await ensureMentionDeliveryOccurrences(rows);
      payloadDurable = true;
      return result;
    },
    getChannelMembers: async () => ({
      humans: [{ id: owner.id, name: owner.name }],
      agents: [{ id: mentionedAgent.id, name: mentionedAgent.name }],
    }) as any,
    getServerMembers: async () => [{ userId: owner.id, name: owner.name }] as any,
    listAgents: async () => [mentionedAgent] as any,
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    recordInboxNotificationFacts,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  // Sampled INSIDE deliverMessage: this is the "interrupted between persist and deliver" instant.
  // The flag read is the FIRST statement, before any await, so it cannot race the pipeline; the
  // recovery query is deliberately kept as a promise and joined after the send returns, because
  // delivery is initiated without being awaited.
  let durableAtHandoff: boolean | null = null;
  let recoveryProbe: ReturnType<typeof listRecoverableMentionDeliveriesForAgent> | null = null;
  const { io } = createIoRecorder();
  await broadcastAndDeliver(io, {
    deliverMessage: async () => {
      durableAtHandoff = payloadDurable;
      recoveryProbe = listRecoverableMentionDeliveriesForAgent(
        "00000000-0000-4000-8000-00000000feed",
        mentionedAgent.id,
      );
      await recoveryProbe;
    },
  } as any, {
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    content: `hello @${mentionedAgent.name}`,
    mentions: [{ type: "agent", id: mentionedAgent.id, name: mentionedAgent.name }] as any,
  });

  assert.notEqual(durableAtHandoff, null, "delivery must actually have been handed off");
  assert.equal(
    durableAtHandoff,
    true,
    "the occurrence payload must already be committed when delivery is handed off — a crash at this instant must not lose the mention",
  );

  const recoverableAtHandoff = await recoveryProbe!;
  assert.equal(recoverableAtHandoff.length, 1, "recovery must be able to retrieve the interrupted mention");
  assert.equal(recoverableAtHandoff[0]?.agentId, mentionedAgent.id);
  assert.ok(
    recoverableAtHandoff[0]?.deliveryPayload,
    "recovery filters on a non-null deliveryPayload, so that payload is what has to be durable first",
  );
  assert.equal(recoverableAtHandoff[0]?.ackedAt, null);
});

test("⑤ declared degradation: a failed occurrence payload write is traced, still delivers, and is honestly reported as unrecoverable", async ({ db }) => {
  // Self-contained on purpose. Per @Noel/@Hipp in #proj-daemon:877bc75b, self-sufficiency must be
  // PROVEN by a single-test run, not assumed from a full-suite green.
  //
  // WHAT IS ACTUALLY BEING DEGRADED. This PR persists occurrences at two points:
  //   1. insertMentionRowsWithOccurrenceRecords — writes the occurrence row atomically with the
  //      mention facts, inside the DB phase. Not degradable: if it fails, the send fails.
  //   2. the batched pre-delivery pass — attaches deliveryPayload before any delivery is initiated.
  // Only (2) is the declared degradation. So the consequence is NOT "no occurrence row"; it is a
  // PAYLOAD-LESS row, which both recovery queries exclude via isNotNull(deliveryPayload). This tooth
  // asserts that consequence against the real recovery query rather than trusting the adjective in
  // the trace attribute.

  const [owner] = await db.insert(users).values({
    email: "degraded-occurrence-owner@test.com",
    name: "DegradedOccurrenceOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Degraded Occurrence Persist",
    slug: "degraded-occurrence-persist",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "degraded-occurrence",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
  ]);
  const [mentionedAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "degraded-agent",
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({
    channelId: channel.id,
    agentId: mentionedAgent.id,
  });

  // A statement timeout on the payload write — the same fault shape the existing thread-follow
  // test in this file uses (code 57014). Everything else on the path stays real: the mention rows,
  // the occurrence row from (1), the delivery, and the recovery query.
  let payloadWriteAttempts = 0;
  __setMessageServiceDepsForTests({
    persistMentionDeliveryOccurrences: async () => {
      payloadWriteAttempts += 1;
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    },
    getChannelMembers: async () => ({
      humans: [{ id: owner.id, name: owner.name }],
      agents: [{ id: mentionedAgent.id, name: mentionedAgent.name }],
    }) as any,
    getServerMembers: async () => [{ userId: owner.id, name: owner.name }] as any,
    listAgents: async () => [mentionedAgent] as any,
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    recordInboxNotificationFacts,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const delivered: { agentId: string; payload: any }[] = [];
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const { io } = createIoRecorder();
  await withTraceRoot(tracer, "server.http.request", { surface: "server", kind: "server" }, async () => {
    await broadcastAndDeliver(io, {
      deliverMessage: async (agentId: string, payload: any) => {
        delivered.push({ agentId, payload });
      },
    } as any, {
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      senderName: owner.name,
      content: `hello @${mentionedAgent.name}`,
      mentions: [{ type: "agent", id: mentionedAgent.id, name: mentionedAgent.name }] as any,
    });
  });

  assert.equal(payloadWriteAttempts, 1, "the batched payload write must be attempted exactly once");

  // 1 — the send SURVIVED the record-keeping failure. A write that only records must never
  //     suppress the thing it records.
  assert.deepEqual(
    delivered.map((delivery) => delivery.agentId),
    [mentionedAgent.id],
    "a failed occurrence payload write must not suppress the delivery",
  );
  assert.equal(delivered[0]?.payload.mentioned, true);

  // 2 — the accepted cost is DECLARED, with the count that says how much was given up.
  const degraded = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "message_pipeline.mention_occurrence.persist_degraded");
  assert.equal(degraded.length, 1, "a failed occurrence persist must emit exactly one typed degradation event");
  assert.equal(degraded[0]?.attrs?.delivered_without_occurrence, true);
  assert.equal(degraded[0]?.attrs?.intended_occurrence_count, 1);
  assert.equal(degraded[0]?.attrs?.recoverable, false);

  // 3 — and recoverable:false is TRUE, not merely claimed: the row exists but has no payload, and
  //     the real recovery query therefore cannot see it.
  const rows = await db.select().from(mentionDeliveryOccurrences);
  assert.equal(rows.length, 1, "the atomic mention-facts write still recorded the occurrence row");
  assert.equal(rows[0]?.deliveryPayload, null, "the degraded write is exactly the missing payload");
  const recoverable = await listRecoverableMentionDeliveriesForAgent("00000000-0000-4000-8000-00000000feed", mentionedAgent.id);
  assert.deepEqual(recoverable, [], "a payload-less occurrence is excluded from recovery — that is the declared cost");

  // POSITIVE CONTROL for the assertion above (@Hipp's sieve, #proj-daemon:ede7bc5e). "The query
  // returns []" is only a real reading if the same query WOULD have returned this row once the
  // payload exists; on a near-empty database an empty result can otherwise be green for reasons
  // that have nothing to do with the payload predicate — a wrong agent id, machine id or state
  // would look identical. So write just the payload and re-ask.
  await ensureMentionDeliveryOccurrences([{
    occurrenceId: rows[0]!.occurrenceId,
    messageId: rows[0]!.messageId,
    serverId: rows[0]!.serverId,
    agentId: rows[0]!.agentId,
    deliveryPayload: delivered[0]!.payload,
  }]);
  const recoverableOnceWritten = await listRecoverableMentionDeliveriesForAgent("00000000-0000-4000-8000-00000000feed", mentionedAgent.id);
  assert.equal(
    recoverableOnceWritten.length,
    1,
    "control: the very same query DOES retrieve this occurrence once the payload is present, so the [] above reads the payload — not an empty database",
  );
});

test("broadcastAndDeliver delivers a public-channel mention to a non-joined agent when the mention fact is target-visible", async () => {
  const deliveries: { agentId: string; payload: any }[] = [];
  __setMessageServiceDepsForTests({
    createMessage: async () => ({
      id: "msg-mention",
      seq: 42,
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      content: "hello @applepi",
      searchText: "hello @applepi",
      messageType: "chat",
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt: new Date("2026-04-19T12:00:00.000Z"),
      updatedAt: new Date("2026-04-19T12:00:00.000Z"),
      actionMetadata: null,
    } as any),
    getChannel: async () => ({
      id: "channel-1",
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    getChannelMembers: async () => ({
      humans: [],
      agents: [{ id: "agent-joined", name: "joined-agent" }],
    }) as any,
    listAgents: async () => [
      { id: "agent-joined", name: "joined-agent" },
      { id: "agent-mentioned", name: "applepi" },
    ] as any,
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    getServerMembers: async () => [],
    insertMentionRows: async () => [],
    // Simulates a fact made target-visible by a later notify action (replay
    // path): the gated read returns it, so delivery is allowed.
    getMentionFactsForMessages: async () => new Map([[
      "msg-mention",
      [{ type: "agent", id: "agent-mentioned", name: "applepi" }],
    ]]),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ray",
    content: "hello @applepi",
  });

  assert.deepEqual(deliveries.map((entry) => entry.agentId), ["agent-joined", "agent-mentioned"]);
  assert.equal(deliveries[0]?.payload.mentioned, undefined);
  assert.equal(deliveries[1]?.payload.mentioned, true);
  assert.equal(deliveries[1]?.payload.channel_type, "channel");
  assert.equal(deliveries[1]?.payload.channel_name, "engineering");
  assert.equal(deliveries[1]?.payload.content, "hello @applepi");
});

test("broadcastAndDeliver does not deliver an outsider mention at send time and records the row as not notifiable", async () => {
  const deliveries: { agentId: string; payload: any }[] = [];
  const insertedRows: any[] = [];
  __setMessageServiceDepsForTests({
    createMessage: async () => ({
      id: "msg-outsider",
      seq: 43,
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      content: "hello @applepi",
      searchText: "hello @applepi",
      messageType: "chat",
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt: new Date("2026-04-19T12:00:00.000Z"),
      updatedAt: new Date("2026-04-19T12:00:00.000Z"),
      actionMetadata: null,
    } as any),
    getChannel: async () => ({
      id: "channel-1",
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelMembershipAuthorityChannelId: async () => {
      throw new Error("synthetic authority lookup unavailable");
    },
    getChannelAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    getChannelMembers: async () => ({
      humans: [],
      agents: [{ id: "agent-joined", name: "joined-agent" }],
    }) as any,
    listAgents: async () => [
      { id: "agent-joined", name: "joined-agent" },
      { id: "agent-mentioned", name: "applepi" },
    ] as any,
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    getServerMembers: async () => [],
    insertMentionRows: async (rows: any[]) => {
      insertedRows.push(...rows);
      return rows.map((row, index) => ({
        id: `mention-row-${index}`,
        targetType: row.targetType,
        targetId: row.targetId,
        notifiableAtSend: row.notifiableAtSend,
      }));
    },
    // Honest gated read: the outsider row is not notifiable and not notified,
    // so the target-visible set excludes it.
    getMentionFactsForMessages: async () => new Map([["msg-outsider", []]]),
  });

  const { io, events } = createIoRecorder();
  const agentOrchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  const enriched = await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ray",
    content: "hello @applepi",
  });

  // The lexical fact is written, flagged as not notifiable at send (M-3).
  const outsiderRow = insertedRows.find((row) => row.targetId === "agent-mentioned");
  assert.ok(outsiderRow, "expected a mention intent/fact row for the outsider");
  assert.equal(outsiderRow.notifiableAtSend, false);
  const joinedRow = insertedRows.find((row) => row.targetId === "agent-joined");
  assert.equal(joinedRow, undefined, "joined agent was not mentioned; no row expected");

  // No send-time delivery to the outsider (N-4): only the joined agent gets the message.
  assert.deepEqual(deliveries.map((entry) => entry.agentId), ["agent-joined"]);

  // Pending mention actions are sender-only: accessible to the immediate
  // send response path, but absent from the enumerable message/socket payload.
  const pendingActions = getSenderPendingMentionActions(enriched);
  assert.equal(pendingActions.length, 1);
  assert.equal(pendingActions[0]?.resolutionId, "mention-row-0");
  assert.deepEqual(pendingActions[0]?.availableActions, ["notify"]);
  assert.equal("pendingMentionActions" in enriched, false);
  assert.equal((enriched as any).pendingMentionActions, undefined);
  const emittedMessage = events.find((event) => event.event === "message:new")?.payload;
  assert.ok(emittedMessage, "expected frontend message:new payload");
  assert.equal("pendingMentionActions" in emittedMessage, false);
  assert.equal(emittedMessage.pendingMentionActions, undefined);
});

test("broadcastAndDeliver does not deliver ordinary public-channel traffic to non-joined agents", async () => {
  const deliveries: { agentId: string; payload: any }[] = [];
  __setMessageServiceDepsForTests({
    createMessage: async () => ({
      id: "msg-ordinary",
      seq: 43,
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      content: "hello everyone",
      searchText: "hello everyone",
      messageType: "chat",
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt: new Date("2026-04-19T12:01:00.000Z"),
      updatedAt: new Date("2026-04-19T12:01:00.000Z"),
      actionMetadata: null,
    } as any),
    getChannel: async () => ({
      id: "channel-1",
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    listAgents: async () => [
      { id: "agent-joined", name: "joined-agent" },
      { id: "agent-unjoined", name: "applepi" },
    ] as any,
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ray",
    content: "hello everyone",
  });

  assert.deepEqual(deliveries.map((entry) => entry.agentId), ["agent-joined"]);
});

test("broadcastAndDeliver records same-send thread facts and reactivates a directly mentioned human follow", async ({ db }) => {
  const [parentAuthor] = await db.insert(users).values({
    email: "thread-parent@test.com",
    name: "ParentAuthor",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [replier] = await db.insert(users).values({
    email: "thread-replier@test.com",
    name: "Replier",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [mentioned] = await db.insert(users).values({
    email: "thread-mentioned@test.com",
    name: "Mentioned",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Facts",
    slug: "thread-facts",
    ownerId: parentAuthor.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: parentAuthor.id, role: "owner" },
    { serverId: server.id, userId: replier.id, role: "member" },
    { serverId: server.id, userId: mentioned.id, role: "member" },
  ]);
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "engineering",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: parentAuthor.id },
    { channelId: parentChannel.id, userId: replier.id },
    { channelId: parentChannel.id, userId: mentioned.id },
  ]);
  const [parentMessage] = await db.insert(messages).values({
    channelId: parentChannel.id,
    senderType: "user",
    senderId: parentAuthor.id,
    content: "parent",
    seq: 1,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread",
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: mentioned.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
    unfollowedAt: new Date("2026-06-26T00:00:00.000Z"),
  });

  __setMessageServiceDepsForTests({
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    getChannelMembers: async () => ({
      humans: [
        { id: parentAuthor.id, name: parentAuthor.name },
        { id: replier.id, name: replier.name },
        { id: mentioned.id, name: mentioned.name },
      ],
      agents: [],
    }) as any,
    getServerMembers: async () => [
      { userId: parentAuthor.id, name: parentAuthor.name },
      { userId: replier.id, name: replier.name },
      { userId: mentioned.id, name: mentioned.name },
    ] as any,
    listAgents: async () => [],
    insertMentionRows: async (rows: any[]) => rows.map((row) => ({
      id: `mention-${row.targetId}`,
      targetType: row.targetType,
      targetId: row.targetId,
      notifiableAtSend: row.notifiableAtSend,
    })),
    getMentionFactsForMessages: async (messageIds: string[]) => new Map(messageIds.map((messageId) => [
      messageId,
      [{ type: "user", id: mentioned.id, name: mentioned.name }],
    ])),
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    recordInboxNotificationFacts,
    getJointThreadProjectionForMember,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = { deliverMessage: async () => undefined } as any;
  const reply = await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: thread.id,
    senderType: "user",
    senderId: replier.id,
    senderName: replier.name,
    content: "reply @Mentioned",
    mentions: [{ type: "user", id: mentioned.id, name: mentioned.name }],
  });

  const facts = (await db.select().from(inboxNotificationFacts)).filter((fact) => fact.messageId === reply.id);
  assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === replier.id && fact.sourceChannelId === thread.id && fact.unreadEligible === false));
  assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === parentAuthor.id && fact.sourceChannelId === thread.id));
  assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === mentioned.id && fact.sourceChannelId === thread.id && fact.personalMention));
  const [mentionedFollow] = await db
    .select({ reason: threadFollows.reason, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, thread.id),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, mentioned.id),
    ))
    .limit(1);
  assert.equal(
    mentionedFollow?.unfollowedAt,
    null,
    "direct mention must reactivate an explicitly unfollowed thread",
  );
  assert.equal(mentionedFollow?.reason, "manual", "mention reactivation must preserve stronger follow provenance");
});

test("broadcastAndDeliver suppresses ordinary facts until a direct mention reactivates an explicit unfollow", async ({ db }) => {
  const [parentAuthor] = await db.insert(users).values({
    email: "thread-unfollowed-parent@test.com",
    name: "UnfollowedParent",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [replier] = await db.insert(users).values({
    email: "thread-unfollowed-replier@test.com",
    name: "UnfollowedReplier",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Thread Unfollow Facts",
    slug: "thread-unfollow-facts",
    ownerId: parentAuthor.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: parentAuthor.id, role: "owner" },
    { serverId: server.id, userId: replier.id, role: "member" },
  ]);
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "engineering",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: parentAuthor.id },
    { channelId: parentChannel.id, userId: replier.id },
  ]);
  const [parentMessage] = await db.insert(messages).values({
    channelId: parentChannel.id,
    senderType: "user",
    senderId: parentAuthor.id,
    content: "parent",
    seq: 1,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread",
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: parentAuthor.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
    unfollowedAt: new Date("2026-06-27T00:00:00.000Z"),
  });

  __setMessageServiceDepsForTests({
    markRead: async () => undefined,
    markAgentLegacyRead: async () => undefined,
    getChannelMembers: async () => ({
      humans: [
        { id: parentAuthor.id, name: parentAuthor.name },
        { id: replier.id, name: replier.name },
      ],
      agents: [],
    }) as any,
    getServerMembers: async () => [
      { userId: parentAuthor.id, name: parentAuthor.name },
      { userId: replier.id, name: replier.name },
    ] as any,
    listAgents: async () => [],
    insertMentionRows: async (rows: any[]) => rows.map((row) => ({
      id: `mention-${row.targetId}`,
      targetType: row.targetType,
      targetId: row.targetId,
      notifiableAtSend: row.notifiableAtSend,
    })),
    getMentionFactsForMessages: async (messageIds: string[]) => new Map(messageIds.map((messageId) => [
      messageId,
      [{ type: "user", id: parentAuthor.id, name: parentAuthor.name }],
    ])),
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    recordInboxNotificationFacts,
    getJointThreadProjectionForMember,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = { deliverMessage: async () => undefined } as any;
  const ordinary = await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: thread.id,
    senderType: "user",
    senderId: replier.id,
    senderName: replier.name,
    content: "ordinary reply",
  });
  const directMention = await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: thread.id,
    senderType: "user",
    senderId: replier.id,
    senderName: replier.name,
    content: "direct @UnfollowedParent",
    mentions: [{ type: "user", id: parentAuthor.id, name: parentAuthor.name }],
  });
  const [followAfterMention] = await db
    .select({ reason: threadFollows.reason, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, thread.id),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, parentAuthor.id),
    ))
    .limit(1);
  assert.equal(followAfterMention?.unfollowedAt, null, "direct mention must reactivate the explicitly unfollowed parent author");
  assert.equal(followAfterMention?.reason, "manual", "the direct-mention transition must not erase existing follow provenance");

  const laterOrdinary = await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: thread.id,
    senderType: "user",
    senderId: replier.id,
    senderName: replier.name,
    content: "later ordinary reply",
  });

  const facts = await db.select().from(inboxNotificationFacts);
  const parentFactsFor = (messageId: string) => facts.filter((fact) =>
    fact.messageId === messageId
    && fact.receiverType === "user"
    && fact.receiverId === parentAuthor.id
    && fact.sourceChannelId === thread.id
  );

  assert.deepEqual(parentFactsFor(ordinary.id), [], "ordinary suppressed reply must not create a parent-author notification fact");
  assert.deepEqual(
    parentFactsFor(laterOrdinary.id).map((fact) => ({
      personalMention: fact.personalMention,
      unreadEligible: fact.unreadEligible,
    })),
    [{ personalMention: false, unreadEligible: true }],
    "ordinary replies after the direct-mention transition must resume normal followed-thread facts",
  );
  assert.deepEqual(
    parentFactsFor(directMention.id).map((fact) => ({
      personalMention: fact.personalMention,
      unreadEligible: fact.unreadEligible,
    })),
    [{ personalMention: true, unreadEligible: true }],
    "direct personal mention must pierce while committing the follow transition",
  );
});

test("broadcastAndDeliver keeps followed joint-thread agent and push projections independent from parent mute", async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSocketFlag = process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  process.env.APP_URL = "https://app.example.test";
  delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
  await openTestDatabase("pglite://");
  try {
    const db = getDb();
    const [ownerA] = await db.insert(users).values({
      email: "joint-owner-a@test.com",
      name: "JointOwnerA",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [ownerB] = await db.insert(users).values({
      email: "joint-owner-b@test.com",
      name: "JointOwnerB",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [senderB] = await db.insert(users).values({
      email: "joint-sender-b@test.com",
      name: "JointSenderB",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [sharedRecipient] = await db.insert(users).values({
      email: "joint-thread-shared-recipient@test.com",
      name: "JointThreadSharedRecipient",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [serverA] = await db.insert(servers).values({
      name: "Joint Thread Facts A",
      slug: "joint-thread-facts-a",
      ownerId: ownerA.id,
    }).returning();
    const [serverB] = await db.insert(servers).values({
      name: "Joint Thread Facts B",
      slug: "joint-thread-facts-b",
      ownerId: ownerB.id,
    }).returning();
    await db.insert(serverMembers).values([
      { serverId: serverA.id, userId: ownerA.id, role: "owner" },
      { serverId: serverB.id, userId: ownerB.id, role: "owner" },
      { serverId: serverB.id, userId: senderB.id, role: "member" },
      { serverId: serverA.id, userId: sharedRecipient.id, role: "member" },
      { serverId: serverB.id, userId: sharedRecipient.id, role: "member" },
    ]);
    const [agentA] = await db.insert(agents).values({
      serverId: serverA.id,
      name: "JointAgentA",
      status: "active",
    }).returning();
    const [canonicalParent] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-canonical-parent",
      type: "joint",
    }).returning();
    const [localParentA] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-local-parent-a",
      type: "joint",
    }).returning();
    const [localParentB] = await db.insert(channels).values({
      serverId: serverB.id,
      name: "joint-local-parent-b",
      type: "joint",
    }).returning();
    const [parentJoint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonicalParent.id,
      createdByServerId: serverA.id,
      createdByUserId: ownerA.id,
    }).returning();
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: parentJoint.id,
        serverId: serverA.id,
        localChannelId: localParentA.id,
        role: "host",
        status: "active",
        joinedByUserId: ownerA.id,
      },
      {
        jointChannelId: parentJoint.id,
        serverId: serverB.id,
        localChannelId: localParentB.id,
        role: "participant",
        status: "active",
        joinedByUserId: ownerB.id,
      },
    ]);
    await db.insert(channelHumans).values([
      { channelId: localParentA.id, userId: ownerA.id },
      { channelId: localParentA.id, userId: sharedRecipient.id },
      { channelId: localParentB.id, userId: ownerB.id },
      { channelId: localParentB.id, userId: senderB.id },
      { channelId: localParentB.id, userId: sharedRecipient.id },
    ]);
    await db.insert(channelAgents).values({
      channelId: localParentA.id,
      agentId: agentA.id,
    });
    const [canonicalParentMessage] = await db.insert(messages).values({
      channelId: canonicalParent.id,
      senderType: "user",
      senderId: ownerA.id,
      content: "joint parent",
      seq: 1,
    }).returning();
    const [canonicalThread] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-canonical-thread",
      type: "thread",
      parentMessageId: canonicalParentMessage.id,
    }).returning();
    const [localThreadA] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-local-thread-a",
      type: "thread",
      parentMessageId: null,
    }).returning();
    const [localThreadB] = await db.insert(channels).values({
      serverId: serverB.id,
      name: "joint-local-thread-b",
      type: "thread",
      parentMessageId: null,
    }).returning();
    const [threadJoint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonicalThread.id,
      createdByServerId: serverA.id,
      createdByUserId: ownerA.id,
    }).returning();
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: threadJoint.id,
        serverId: serverA.id,
        localChannelId: localThreadA.id,
        role: "host",
        status: "active",
        joinedByUserId: ownerA.id,
      },
      {
        jointChannelId: threadJoint.id,
        serverId: serverB.id,
        localChannelId: localThreadB.id,
        role: "participant",
        status: "active",
        joinedByUserId: ownerB.id,
      },
    ]);
    await db.insert(threadFollows).values([
      {
        threadChannelId: localThreadA.id,
        followerType: "agent",
        followerId: agentA.id,
        parentMessageId: canonicalParentMessage.id,
        reason: "manual",
      },
      {
        threadChannelId: localThreadB.id,
        followerType: "user",
        followerId: senderB.id,
        parentMessageId: canonicalParentMessage.id,
        reason: "manual",
      },
      {
        threadChannelId: localThreadA.id,
        followerType: "user",
        followerId: sharedRecipient.id,
        parentMessageId: canonicalParentMessage.id,
        reason: "manual",
      },
      {
        threadChannelId: localThreadB.id,
        followerType: "user",
        followerId: sharedRecipient.id,
        parentMessageId: canonicalParentMessage.id,
        reason: "manual",
      },
    ]);
    await db.insert(inboxTargetMuteStates).values([
      {
        receiverType: "agent",
        receiverId: agentA.id,
        serverId: serverA.id,
        sourceChannelId: localParentA.id,
        muteFromSeq: 1,
      },
      {
        receiverType: "user",
        receiverId: sharedRecipient.id,
        serverId: serverA.id,
        sourceChannelId: localParentA.id,
        muteFromSeq: 1,
      },
      {
        receiverType: "user",
        receiverId: sharedRecipient.id,
        serverId: serverB.id,
        sourceChannelId: localParentB.id,
        muteFromSeq: 1,
      },
    ]);

    const [ownerAProjection, senderBProjection] = await Promise.all([
      getJointThreadProjectionForMember(canonicalThread.id, "user", ownerA.id),
      getJointThreadProjectionForMember(canonicalThread.id, "user", senderB.id),
    ]);
    assert.equal(ownerAProjection?.localThreadChannelId, localThreadA.id);
    assert.equal(senderBProjection?.localThreadChannelId, localThreadB.id);

    const sentTargetBatches: any[][] = [];
    const nativeIntentBatches: any[][] = [];
    __setMessageServiceDepsForTests({
      markRead: async () => undefined,
      markAgentLegacyRead: async () => undefined,
      buildPushTargets: async () => new Map(),
      sendPushNotifications: async (targets) => {
        sentTargetBatches.push(targets as any[]);
      },
      persistNativeNotificationIntents: async (intents) => {
        nativeIntentBatches.push([...intents]);
        return intents.length;
      },
      renderAgentReadablePermalinks: async (content: string) => content,
      recordInboxNotificationFacts,
      getActiveJointThreadProjectionsByCanonicalThread,
      getJointThreadProjectionForMember,
      getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
        uniqueName: fallbackName,
        description: null,
      }),
    });

    const { io, events } = createIoRecorder();
    const agentDeliveries: Array<{ agentId: string; payload: any }> = [];
    const agentOrchestrator = {
      deliverMessage: async (agentId: string, payload: any) => {
        agentDeliveries.push({ agentId, payload });
      },
    } as any;
    const reply = await broadcastAndDeliver(io, agentOrchestrator, {
      channelId: localThreadB.id,
      senderType: "user",
      senderId: senderB.id,
      senderName: senderB.name,
      content: "joint thread reply",
    });

    const ordinaryAgentDelivery = agentDeliveries.find(
      (delivery) => delivery.agentId === agentA.id && delivery.payload.content === "joint thread reply",
    );
    assert.ok(
      ordinaryAgentDelivery,
      "an actively-following agent must receive an ordinary joint-thread reply despite muting its local parent projection",
    );
    assert.equal(ordinaryAgentDelivery.payload.channel_id, localThreadA.id);
    assert.equal(ordinaryAgentDelivery.payload.parent_channel_id, localParentA.id);

    assert.deepEqual(
      nativeIntentBatches.map((batch) =>
        batch.map((intent) => ({
          recipientUserId: intent.recipientUserId,
          serverId: intent.serverId,
          channelId: intent.channelId,
          threadId: intent.threadId,
          parentChannelId: intent.parentChannelId,
        })),
      ),
      [
        [
          {
            recipientUserId: sharedRecipient.id,
            serverId: serverB.id,
            channelId: localThreadB.id,
            threadId: localThreadB.id,
            parentChannelId: localParentB.id,
          },
        ],
      ],
      "joint-thread native outbox projection must survive parent activity mute for an active follower",
    );
    assert.equal(
      sentTargetBatches.length,
      1,
      "joint-thread web push projection must survive parent activity mute for an active follower",
    );
    const pushed = sentTargetBatches[0]!
      .map((target) => ({
        userId: target.userId,
        serverId: target.identity.serverId,
        threadId: target.identity.threadId,
        parentChannelId: target.identity.parentChannelId,
        title: target.payload.title,
        url: target.payload.url,
      }))
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
    assert.deepEqual(pushed, [
      {
        userId: sharedRecipient.id,
        serverId: serverB.id,
        threadId: localThreadB.id,
        parentChannelId: localParentB.id,
        title: `Thread in #${localParentB.name} · ${serverB.name}`,
        url: `https://app.example.test/s/${serverB.slug}/channel/${localParentB.id}?thread=${encodeURIComponent(`${localParentB.id}:${canonicalParentMessage.id}`)}&msg=${reply.id}`,
      },
    ].sort((left, right) => left.serverId.localeCompare(right.serverId)));

    const socketPushes = events
      .filter((event) => event.event === "notification:push")
      .map((event) => ({
        room: event.room,
        serverId: event.payload.serverId,
        threadId: event.payload.threadId,
        parentChannelId: event.payload.parentChannelId,
        title: event.payload.title,
        url: event.payload.url,
      }))
      .sort((left, right) => left.serverId.localeCompare(right.serverId));
    assert.deepEqual(socketPushes, [
      {
        room: socketClientKindRoom(sharedRecipient.id, "mobile"),
        serverId: serverA.id,
        threadId: localThreadA.id,
        parentChannelId: localParentA.id,
        title: `Thread in #${localParentA.name} · ${serverA.name}`,
        url: `https://app.example.test/s/${serverA.slug}/channel/${localParentA.id}?thread=${encodeURIComponent(`${localParentA.id}:${canonicalParentMessage.id}`)}&msg=${reply.id}`,
      },
      {
        room: socketClientKindRoom(sharedRecipient.id, "mobile"),
        serverId: serverB.id,
        threadId: localThreadB.id,
        parentChannelId: localParentB.id,
        title: `Thread in #${localParentB.name} · ${serverB.name}`,
        url: `https://app.example.test/s/${serverB.slug}/channel/${localParentB.id}?thread=${encodeURIComponent(`${localParentB.id}:${canonicalParentMessage.id}`)}&msg=${reply.id}`,
      },
    ].sort((left, right) => left.serverId.localeCompare(right.serverId)));

    const facts = (await db.select().from(inboxNotificationFacts)).filter((fact) => fact.messageId === reply.id);
    assert.ok(facts.some((fact) => fact.receiverType === "agent" && fact.receiverId === agentA.id && fact.sourceChannelId === localThreadA.id));
    assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === ownerA.id && fact.sourceChannelId === localThreadA.id));
    assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === senderB.id && fact.sourceChannelId === localThreadB.id && fact.unreadEligible === false));
    assert.equal(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === ownerA.id && fact.sourceChannelId === localThreadB.id), false);
    assert.equal(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === senderB.id && fact.sourceChannelId === localThreadA.id), false);

    const { io: producerIo, events: producerEvents } = createIoRecorder();
    await broadcastAndDeliver(producerIo, agentOrchestrator, {
      channelId: localThreadA.id,
      senderType: "user",
      senderId: ownerA.id,
      senderName: ownerA.name,
      content: `@${agentA.name} joint canonical producer reply`,
      mentions: [{ type: "agent", id: agentA.id, name: agentA.name }] as any,
    });

    const mentionedAgentDelivery = agentDeliveries.find(
      (delivery) => delivery.agentId === agentA.id
        && delivery.payload.content.includes("joint canonical producer reply"),
    );
    assert.ok(mentionedAgentDelivery, "expected the already-following mentioned agent delivery");
    assert.ok(
      mentionedAgentDelivery.payload.thread_join_context,
      "joint-thread delivery must carry bounded context independently of follow state",
    );
    assert.equal(
      mentionedAgentDelivery.payload.thread_join_context.parent_message.content,
      canonicalParentMessage.content,
    );
    assert.equal(
      mentionedAgentDelivery.payload.thread_join_context.suggested_read_history_target,
      mentionedAgentDelivery.payload.thread_join_context.thread_target,
    );

    const hostThreadUpdate = producerEvents.find((event) =>
      event.event === "thread:updated"
      && event.room === `channel:${localParentA.id}`
    )?.payload;
    const peerThreadUpdate = producerEvents.find((event) =>
      event.event === "thread:updated"
      && event.room === `channel:${localParentB.id}`
    )?.payload;
    assert.ok(hostThreadUpdate, "expected host local parent thread:updated payload");
    assert.ok(peerThreadUpdate, "expected peer local parent thread:updated payload");
    assert.equal(hostThreadUpdate.threadChannelId, localThreadA.id);
    assert.equal(peerThreadUpdate.threadChannelId, localThreadB.id);
    assertThreadRepliesSyncWindow(hostThreadUpdate, {
      serverId: serverA.id,
      parentMessageId: canonicalParentMessage.id,
      parentScopeKind: "joint",
      parentScopeId: localParentA.id,
    });
    assertThreadRepliesSyncWindow(peerThreadUpdate, {
      serverId: serverB.id,
      parentMessageId: canonicalParentMessage.id,
      parentScopeKind: "joint",
      parentScopeId: localParentB.id,
    });
    assert.notEqual(hostThreadUpdate.syncCoreReplyWindow.discussion.parentScopeKey.scopeId, canonicalParent.id);
    assert.notEqual(peerThreadUpdate.syncCoreReplyWindow.discussion.parentScopeKey.scopeId, canonicalParent.id);
    assert.notEqual(peerThreadUpdate.syncCoreReplyWindow.discussion.root.serverId, serverA.id);
  } finally {
    await closeTestDatabase();
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSocketFlag === undefined) delete process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED;
    else process.env.SLOCK_NOTIFICATION_PUSH_SOCKET_ENABLED = previousSocketFlag;
  }
});

test("broadcastAndDeliver marks owner/admin sender delivery as admin authority", async () => {
  const deliveries: { agentId: string; payload: any; options: any }[] = [];
  __setMessageServiceDepsForTests({
    createMessage: async () => ({
      id: "msg-owner",
      seq: 45,
      channelId: "channel-1",
      senderType: "user",
      senderId: "owner-1",
      content: "please wake",
      searchText: "please wake",
      messageType: "chat",
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt: new Date("2026-04-19T12:02:00.000Z"),
      updatedAt: new Date("2026-04-19T12:02:00.000Z"),
      actionMetadata: null,
    } as any),
    getChannel: async () => ({
      id: "channel-1",
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    listAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    getActorServerRoleInServer: async () => "owner",
    buildPushTargets: async () => new Map(),
    insertMentionRows: async () => [],
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = {
    deliverMessage: async (agentId: string, payload: any, options: any) => {
      deliveries.push({ agentId, payload, options });
    },
  } as any;

  await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: "channel-1",
    senderType: "user",
    senderId: "owner-1",
    senderName: "Owner",
    content: "please wake",
  });

  assert.deepEqual(deliveries.map((entry) => entry.agentId), ["agent-joined"]);
  assert.deepEqual(deliveries[0]?.options, { adminAuthority: true });
});

test("broadcastAndDeliver leaves member sender delivery subject to inbox receive scope", async () => {
  const deliveries: { agentId: string; payload: any; options: any }[] = [];
  __setMessageServiceDepsForTests({
    createMessage: async () => ({
      id: "msg-member",
      seq: 46,
      channelId: "channel-1",
      senderType: "user",
      senderId: "member-1",
      content: "please wake",
      searchText: "please wake",
      messageType: "chat",
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt: new Date("2026-04-19T12:03:00.000Z"),
      updatedAt: new Date("2026-04-19T12:03:00.000Z"),
      actionMetadata: null,
    } as any),
    getChannel: async () => ({
      id: "channel-1",
      serverId: "server-1",
      type: "channel",
      name: "engineering",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    listAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    getActorServerRoleInServer: async () => "member",
    buildPushTargets: async () => new Map(),
    insertMentionRows: async () => [],
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = {
    deliverMessage: async (agentId: string, payload: any, options: any) => {
      deliveries.push({ agentId, payload, options });
    },
  } as any;

  await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: "channel-1",
    senderType: "user",
    senderId: "member-1",
    senderName: "Member",
    content: "please wake",
  });

  assert.deepEqual(deliveries.map((entry) => entry.agentId), ["agent-joined"]);
  assert.deepEqual(deliveries[0]?.options, {});
});

test("broadcastAndDeliver does not deliver private-channel mentions to non-member agents", async () => {
  const deliveries: { agentId: string; payload: any }[] = [];
  __setMessageServiceDepsForTests({
    createMessage: async () => ({
      id: "msg-private-mention",
      seq: 44,
      channelId: "private-1",
      senderType: "user",
      senderId: "user-1",
      content: "hello @applepi",
      searchText: "hello @applepi",
      messageType: "chat",
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt: new Date("2026-04-19T12:02:00.000Z"),
      updatedAt: new Date("2026-04-19T12:02:00.000Z"),
      actionMetadata: null,
    } as any),
    getChannel: async () => ({
      id: "private-1",
      serverId: "server-1",
      type: "private",
      name: "secret",
      parentMessageId: null,
    } as any),
    getChannelAgents: async () => [{ id: "agent-joined", name: "joined-agent" }] as any,
    getChannelMembers: async () => ({
      humans: [],
      agents: [{ id: "agent-joined", name: "joined-agent" }],
    }) as any,
    listAgents: async () => [
      { id: "agent-joined", name: "joined-agent" },
      { id: "agent-mentioned", name: "applepi" },
    ] as any,
    getChannelHumans: async () => [],
    assertChannelNotArchived: async () => undefined,
    markRead: async () => undefined,
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    insertMentionRows: async () => [],
    getMentionFactsForMessages: async () => new Map([["msg-private-mention", []]]),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  } as any;

  await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: "private-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Ray",
    content: "hello @applepi",
  });

  assert.deepEqual(deliveries.map((entry) => entry.agentId), ["agent-joined"]);
});

test("declared degradation on the SINGLE-delivery path: a failed occurrence write must not suppress the delivery", async ({ db }) => {
  // WHY THIS EXISTS. @Hipp found during narrow review of #6700 that deliverMessageToAgent had NO
  // try/catch around its occurrence write, while the batched send path a few thousand lines below
  // states the policy explicitly in its own catch: "a record-keeping write must never suppress the
  // thing it records, so we still deliver." One path obeyed the policy, its sibling inverted it —
  // a DB blip silently ate a delivery on a path with four live callers.
  //
  // The likely cause is worth recording: the batched path went through the injectable dep
  // (resolveMessageServiceDeps().persistMentionDeliveryOccurrences) and was therefore reachable by
  // this harness, so someone wrote its fault test and the catch followed. The single path called
  // the service module directly, so no test could make it fail. A TESTABILITY asymmetry became a
  // BEHAVIOUR asymmetry. Routing it through the same dep is what makes this arm possible at all.

  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "single-degraded-owner@test.com",
      name: "SingleDegradedOwner",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Single Degraded", slug: "single-degraded", ownerId: owner.id,
    }).returning();
    await db.insert(serverMembers).values([{ serverId: server.id, userId: owner.id, role: "owner" }]);
    const [channel] = await db.insert(channels).values({
      serverId: server.id, name: "single-degraded", type: "channel",
    }).returning();
    await db.insert(channelHumans).values([{ channelId: channel.id, userId: owner.id }]);
    const [agent] = await db.insert(agents).values({
      serverId: server.id, name: "single-degraded-agent", runtime: "codex",
    }).returning();
    await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
    const [message] = await db.insert(messages).values({
      channelId: channel.id, senderType: "user", senderId: owner.id,
      content: `hello @${agent.name}`, seq: 1,
    }).returning();
    await db.insert(messageMentions).values({
      messageId: message.id, messageSeq: 1, serverId: server.id, channelId: channel.id,
      targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name,
      notifiableAtSend: true,
    });

    // Same fault shape the batched degradation test uses: a statement timeout on the payload write.
    let attempts = 0;
    __setMessageServiceDepsForTests({
      persistMentionDeliveryOccurrences: async () => {
        attempts += 1;
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      },
    });

    const delivered: string[] = [];
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    await withTraceRoot(tracer, "server.http.request", { surface: "server", kind: "server" }, async () => {
      await deliverMessageToAgent({
        deliverMessage: async (agentId: string) => { delivered.push(agentId); return { status: "queued" }; },
      } as any, message.id, agent.id);
    });

    assert.equal(attempts, 1, "the occurrence write must be attempted exactly once");
    // THE LOAD-BEARING ASSERTION: the delivery survived the record-keeping failure.
    assert.deepEqual(delivered, [agent.id], "a failed occurrence write must not suppress the delivery");

    // and the accepted cost is DECLARED, not silent — same typed event as the batched path.
    const degraded = sink.getAllSpans().flatMap((span) => span.events)
      .filter((event) => event.name === "message_pipeline.mention_occurrence.persist_degraded");
    assert.equal(degraded.length, 1, "the degradation must be traced exactly once");
    assert.equal(degraded[0]?.attrs?.delivered_without_occurrence, true);
    assert.equal(degraded[0]?.attrs?.recoverable, false);
  } finally {
    __resetMessageServiceDepsForTests();
    await closeTestDatabase();
  }
});

test("task-message path: a failed occurrence write must not suppress the delivery", async ({ db }) => {
  // THE THIRD MIRROR of the policy this file states twice in its own catches. @Kabi found it.
  // The PR had put the bookkeeping write INSIDE the delivery try and ahead of deliverMessage, so
  // a throw jumped to the catch and the message was never delivered — silently (the catch
  // swallows) and misattributed (its text blames delivery). Verified against base 0e9fb400 where
  // that try held only deliverMessage.
  // Worse than the sibling @Hipp found: that one propagated to the caller, this one vanished.

  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "task-degraded@test.com", name: "TaskDegradedOwner", passwordHash: "x", emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Task Degraded", slug: "task-degraded", ownerId: owner.id,
    }).returning();
    await db.insert(serverMembers).values([{ serverId: server.id, userId: owner.id, role: "owner" }]);
    const [channel] = await db.insert(channels).values({
      serverId: server.id, name: "task-degraded", type: "channel",
    }).returning();
    const [agent] = await db.insert(agents).values({
      serverId: server.id, name: "task-degraded-agent", runtime: "codex",
    }).returning();
    await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
    const [message] = await db.insert(messages).values({
      channelId: channel.id, senderType: "user", senderId: owner.id,
      content: `task for @${agent.name}`, seq: 1, taskStatus: "todo", taskNumber: 1,
    }).returning();
    await db.insert(messageMentions).values({
      messageId: message.id, messageSeq: 1, serverId: server.id, channelId: channel.id,
      targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name, notifiableAtSend: true,
    });

    let attempts = 0;
    __setMessageServiceDepsForTests({
      persistMentionDeliveryOccurrences: async () => {
        attempts += 1;
        throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
      },
    });

    const delivered: string[] = [];
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    await withTraceRoot(tracer, "server.http.request", { surface: "server", kind: "server" }, async () => {
      await deliverMessageToAgents({
        deliverMessage: async (agentId: string) => { delivered.push(agentId); return { status: "queued" }; },
      } as any, message, owner.name);
    });

    assert.ok(attempts >= 1, "the occurrence write must have been attempted");
    // THE LOAD-BEARING ASSERTION: bookkeeping failed, the task message still went out.
    assert.deepEqual(delivered, [agent.id], "a failed occurrence write must not suppress a task-message delivery");
    // and the accepted degradation is observable, as at the other two sites
    const degraded = sink.getAllSpans().flatMap((span) => span.events)
      .filter((event) => event.name === "message_pipeline.mention_occurrence.persist_degraded");
    assert.ok(degraded.length >= 1, "the degradation must emit the same typed trace as its siblings");
  } finally {
    __resetMessageServiceDepsForTests();
    await closeTestDatabase();
  }
});
