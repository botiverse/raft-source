import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { BasicTracer, CANONICAL_MESSAGE_FIELD_DESCRIPTORS, MemoryTraceSink, MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER } from "@botiverse/raft-shared";
import { enrichedMessagePayloadKeys } from "./messageRealtimeProducerRegistry";
import { broadcastAndDeliver, broadcastSystemMessage, createMessage, recordInboxFactsForPersistedMessages, deliverExternalInboundCommittedMessageToAgents, deliverMessageToAgent, deliverMessageToAgents, emitExternalProjectionMessageToFrontend, runExternalInboundCommitSideEffects, emitExternalLinkedMessageUpdateToFrontend, getAgentResumeCatchupMessages, type AgentResumeCatchupResult, getSenderPendingMentionActions, getSenderReadReceiptInFlightCountForTests, planDirectMentionThreadFollow, registerSenderReadReceiptForTests, __resetMessageServiceDepsForTests, __setMessageServiceDepsForTests } from "./messageService";
import { __resetAgentSendReplayDbForTests, __setAgentSendReplayDbForTests } from "./agentSendReplayService";
import { CompatibilityReadMutationPendingError } from "./readMutationSequencer";
import { recordInboxNotificationFacts } from "./inboxNotificationService";
import { ensureMentionDeliveryOccurrences, listRecoverableMentionDeliveriesForAgent } from "./mentionDeliveryOccurrenceService";
import { getActiveJointThreadProjectionsByCanonicalThread, getAgentLegacyReadCursor, getAgentUnreadCounts, markAgentLegacyAckCheckpoint, type AgentInboxChainRow, getJointThreadProjectionForMember, getOrCreateThread } from "./channelService";
import * as taskService from "./taskService";
import { closeDatabase, getDb } from "../db/index";
import { agents, agentChannelReadCursors, attachments, channelAgents, channelHumans, channels, externalActorProjections, externalAddressabilityProjections, externalAppInstalls, externalAppRegistrations, externalAppServerGrants, externalBindingAudienceSnapshots, externalChannelBindings, externalMentionFacts, externalMessageLinks, externalProjectionAvatarArtifacts, externalReactionStates, inboxNotificationFacts, inboxTargetMuteStates, jointChannels, jointChannelServers, mentionDeliveryOccurrences, messageMentions, messages, oauthClients, serverMembers, servers, tasks, threadFollows, users } from "../db/schema";
import { insertCanonicalExternalMessage } from "./externalProjectionService";
import { withTraceRoot } from "../tracing/semanticTrace";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { withChannelDelivery } from "../test/orchestratorStub";


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
          // Joined reads (attachment linking's inner join, others' left joins) find nothing here.
          const joined = () => ({
            where() {
              return makeAfterWhere([]);
            },
          });
          return {
            leftJoin: joined,
            innerJoin: joined,
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
      broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
    });

    const { io } = createIoRecorder();
    await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
      channelId: "channel-1",
      senderType: "user",
      senderId: "user-1",
      senderName: "Ray",
      content: "pending sender read receipt",
    });
    // The (empty) agent delivery aggregate settles within a tick; only the
    // read receipt stays in flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    });

    const { io } = createIoRecorder();
    await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
    });

    const { io } = createIoRecorder();
    await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
    getMentionFactsForMessages: async () => new Map(),
  });

  const { io } = createIoRecorder();
  const result = await withTraceRoot(
    tracer,
    "server.http.request",
    { surface: "server", kind: "server" },
    () => broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
      () => broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
    const sent = await broadcastAndDeliver(io, withChannelDelivery({
      deliverMessage: async (agentId: string, payload: any) => {
        delivered.push({ agentId, messageId: payload.message_id, seq: payload.seq });
      },
    }) as any, {
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
    await broadcastAndDeliver(io, withChannelDelivery({
      deliverMessage: async (agentId: string, payload: any) => {
        delivered.push({ agentId, payload });
      },
    }) as any, {
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
    getMentionFactsForMessages: async () => new Map(),
    insertMentionRows: async () => [],
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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

// Canonical manifest: every key declared present on `message:new`. Mobile
// accepts a realtime frame as a full canonical fact only when all are present
// (values may be null / []); a dropped key silently demotes every live message.
const MESSAGE_NEW_MANIFEST_KEYS = CANONICAL_MESSAGE_FIELD_DESCRIPTORS
  .filter((descriptor) => descriptor.presence.messageNew === "present")
  .map((descriptor) => descriptor.name);
const MESSAGE_NEW_REGISTRY_KEYS = new Set<string>(enrichedMessagePayloadKeys);

function assertManifestCompleteMessageNew(payload: Record<string, unknown>, label: string) {
  const missing = MESSAGE_NEW_MANIFEST_KEYS.filter((key) => !(key in payload));
  assert.deepEqual(missing, [], `${label}: message:new must carry every manifest messageNew key`);
  const unregistered = Object.keys(payload).filter((key) => !MESSAGE_NEW_REGISTRY_KEYS.has(key));
  assert.deepEqual(unregistered, [], `${label}: message:new keys must be declared in the producer registry`);
}

test("broadcastAndDeliver message:new and send response carry every manifest messageNew key with REST values", async ({ db }) => {
  assert.ok(MESSAGE_NEW_MANIFEST_KEYS.includes("senderDescription") && MESSAGE_NEW_MANIFEST_KEYS.includes("reactions"));
  const persisted = makePersistedMessage({
    id: "message-new-manifest",
    // Real persisted rows always carry these columns (null when unset).
    randomId: null,
    actionMetadata: null,
    channelId: "channel-1",
    content: "manifest complete body",
  });
  const senderIdentityCalls: string[] = [];
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
    getSenderIdentity: async (_senderType, senderId, fallbackName) => {
      senderIdentityCalls.push(senderId);
      return { uniqueName: fallbackName, description: "Reviews pull requests" };
    },
    getMentionFactsForMessages: async () => new Map(),
    insertMentionRows: async () => [],
  });

  const { io, events } = createIoRecorder();
  const response = await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Agent One",
    content: "manifest complete body",
  }) as Record<string, unknown>;

  const emitted = events.find((event) => event.room === "channel:channel-1" && event.event === "message:new")?.payload;
  assert.ok(emitted, "expected realtime message:new payload");
  assertManifestCompleteMessageNew(emitted, "persisted.channel");
  // REST parity (enrichWithSenderNames): description || null; a brand-new
  // row has no reactions; user/agent senders have no external author.
  assert.equal(emitted.senderDescription, "Reviews pull requests");
  assert.deepEqual(emitted.reactions, []);
  assert.equal(emitted.externalAuthor, null);
  assert.equal(emitted.commentRef, null);
  // Manifest v7 (RFC 077): a brand-new message is not retracted.
  assert.equal(emitted.deletedAt, null);
  // The HTTP send response is the same body minus the frame-only context.
  const responseMissing = MESSAGE_NEW_MANIFEST_KEYS
    .filter((key) => key !== "conversationContext")
    .filter((key) => !(key in response));
  assert.deepEqual(responseMissing, [], "send response must carry the manifest-complete body");
  assert.equal(response.senderDescription, "Reviews pull requests");
  assert.deepEqual(response.reactions, []);
  // One sender lookup per send, shared by the frontend payload and agent delivery.
  assert.deepEqual(senderIdentityCalls, ["agent-1"]);
});

test("broadcastSystemMessage message:new carries every manifest messageNew key with REST system values", async () => {
  const persisted = makePersistedMessage({
    id: "system-message-new-manifest",
    // Real persisted rows always carry these columns (null when unset).
    randomId: null,
    actionMetadata: null,
    channelId: "channel-1",
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content: "Someone joined",
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
    getActiveJointChannelProjectionsByLocalChannel: async () => [],
  });

  const { io, events } = createIoRecorder();
  await broadcastSystemMessage(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, "channel-1", "Someone joined", {
    inboxFactPolicy: { mode: "skip", producer: "test.system.manifest", reason: "frame shape test" },
  });

  const emitted = events.find((event) => event.room === "channel:channel-1" && event.event === "message:new")?.payload;
  assert.ok(emitted, "expected realtime system message:new payload");
  assertManifestCompleteMessageNew(emitted, "system.channel");
  assert.equal(emitted.senderDescription, null);
  assert.equal(emitted.senderMembershipStatus, null);
  assert.deepEqual(emitted.reactions, []);
  assert.deepEqual(emitted.attachments, []);
  assert.deepEqual(emitted.mentions, []);
  assert.equal(emitted.deletedAt, null);
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

  await emitExternalLinkedMessageUpdateToFrontend(io, localMessage.id);
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

test("a Slack root Agent mention is delivered into the exact linked Raft thread", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "external-root-mention-owner@test.com",
    name: "external-root-mention-owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "External Root Mention",
    slug: "external-root-mention",
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "external-root-mention",
    type: "channel",
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "external-root-agent",
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-root-mention",
    installId: "install-root-mention",
    workspaceId: "workspace-root-mention",
    externalActorId: "UROOTMENTION",
    displayName: "Slack Root Author",
    handles: ["root-author"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date("2026-09-25T05:00:00.000Z"),
  }).returning();
  const created = await db.transaction((executor) => insertCanonicalExternalMessage({
    executor,
    channelId: channel.id,
    content: `hello @${agent.name}`,
    createdAt: new Date("2026-09-25T05:01:00.000Z"),
    projectionId: actor.id,
    provider: "slack",
    appRegistrationId: actor.appRegistrationId,
    installId: actor.installId,
    workspaceId: actor.workspaceId,
    externalActorId: actor.externalActorId,
    externalConversationId: "CROOTMENTION",
    externalMessageId: "provider-root-mention",
    actorProjectionRevision: actor.projectionRevision,
  }));
  await db.insert(messageMentions).values({
    messageId: created.message.id,
    messageSeq: created.message.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: agent.name,
    source: "send_path",
    confidence: "exact",
    notifiableAtSend: true,
  });
  await db.insert(inboxNotificationFacts).values({
    receiverType: "agent",
    receiverId: agent.id,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: channel.id,
    messageId: created.message.id,
    messageSeq: created.message.seq,
    activityAt: created.message.createdAt,
    personalMention: true,
    unreadEligible: true,
  });

  const deliveries: Array<{ agentId: string; payload: any }> = [];
  await deliverExternalInboundCommittedMessageToAgents({
    async deliverMessage(agentId: string, payload: any) {
      deliveries.push({ agentId, payload });
      return { status: "queued" };
    },
  } as any, created.message.id);

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.agentId, agent.id);
  assert.equal(deliveries[0]?.payload.mentioned, true);
  assert.equal(deliveries[0]?.payload.channel_type, "thread");
  assert.equal(deliveries[0]?.payload.parent_channel_id, channel.id);
  assert.notEqual(deliveries[0]?.payload.channel_id, channel.id);
  const [thread] = await db.select().from(channels)
    .where(eq(channels.id, deliveries[0]!.payload.channel_id));
  assert.equal(thread?.type, "thread");
  assert.equal(thread?.parentMessageId, created.message.id);
});

test("a Joint canonical commit keeps face-channel delivery and never takes the thread path", async ({ db }) => {
  // Joint canonical channels also have type "channel", so `channel.type`
  // alone must not gate the thread route — the gate is "exactly one inbox
  // face, which is the canonical channel itself". Here the face lives on a
  // different channel, so both the in-channel batch and the outside-mention
  // loop keep plain delivery.
  const [owner] = await db.insert(users).values({
    email: "joint-thread-gate-owner@test.com",
    name: "joint-thread-gate-owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Joint Thread Gate",
    slug: "joint-thread-gate",
    ownerId: owner.id,
  }).returning();
  const [canonical] = await db.insert(channels).values({
    serverId: server.id,
    name: "joint-thread-gate-canonical",
    type: "channel",
  }).returning();
  const [face] = await db.insert(channels).values({
    serverId: server.id,
    name: "joint-thread-gate-face",
    type: "channel",
  }).returning();
  const [faceAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "joint-face-agent",
    runtime: "codex",
  }).returning();
  const [outsideAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "joint-outside-agent",
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({ channelId: face.id, agentId: faceAgent.id });
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: "registration-joint-gate",
    installId: "install-joint-gate",
    workspaceId: "workspace-joint-gate",
    externalActorId: "UJOINTGATE",
    displayName: "Slack Joint Author",
    handles: ["joint-author"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date("2026-09-25T05:00:00.000Z"),
  }).returning();
  const created = await db.transaction((executor) => insertCanonicalExternalMessage({
    executor,
    channelId: canonical.id,
    content: `hello @${outsideAgent.name}`,
    createdAt: new Date("2026-09-25T05:01:00.000Z"),
    projectionId: actor.id,
    provider: "slack",
    appRegistrationId: actor.appRegistrationId,
    installId: actor.installId,
    workspaceId: actor.workspaceId,
    externalActorId: actor.externalActorId,
    externalConversationId: "CJOINTGATE",
    externalMessageId: "provider-joint-gate",
    actorProjectionRevision: actor.projectionRevision,
  }));
  await db.insert(messageMentions).values({
    messageId: created.message.id,
    messageSeq: created.message.seq,
    serverId: server.id,
    channelId: canonical.id,
    targetType: "agent",
    targetId: outsideAgent.id,
    handleAtSendTime: outsideAgent.name,
    source: "send_path",
    confidence: "exact",
    notifiableAtSend: true,
  });
  // The inbox face is a different channel (joint face), not the canonical id.
  await db.insert(inboxNotificationFacts).values({
    receiverType: "agent",
    receiverId: faceAgent.id,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: face.id,
    messageId: created.message.id,
    messageSeq: created.message.seq,
    activityAt: created.message.createdAt,
    personalMention: false,
    unreadEligible: true,
  });

  const deliveries: Array<{ agentId: string; payload: any }> = [];
  await deliverExternalInboundCommittedMessageToAgents({
    async deliverMessage(agentId: string, payload: any) {
      deliveries.push({ agentId, payload });
      return { status: "queued" };
    },
  } as any, created.message.id);

  // Face agent: delivered on the face channel, not a thread.
  const faceDelivery = deliveries.find((delivery) => delivery.agentId === faceAgent.id);
  assert.ok(faceDelivery);
  assert.equal(faceDelivery.payload.channel_id, face.id);
  assert.equal(faceDelivery.payload.channel_type, "channel");
  // Outside-mentioned agent: delivered on the canonical channel — a thread
  // wake is only valid when the single face IS the canonical channel.
  const outsideDelivery = deliveries.find((delivery) => delivery.agentId === outsideAgent.id);
  assert.ok(outsideDelivery);
  assert.equal(outsideDelivery.payload.channel_id, canonical.id);
  assert.equal(outsideDelivery.payload.channel_type, "channel");
  assert.equal(outsideDelivery.payload.mentioned, true);
  // No thread channel was created for either delivery.
  const threads = await db.select().from(channels)
    .where(eq(channels.parentMessageId, created.message.id));
  assert.equal(threads.length, 0, "joint commits must not create canonical threads");
});

test("external linked body and reaction updates fan out once to every local Joint channel projection", async ({ db }) => {
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
  await fillJointMembersFromChannelHumans();
  const [message] = await db.insert(messages).values({
    channelId: canonical.id,
    senderType: "agent",
    senderId: sender.id,
    content: "Joint message reacted to in Slack",
    messageType: "chat",
  }).returning();
  await seedSlackReactionForMessage({ messageId: message.id, projectionId: reactor.id, key: "joint-channel" });

  const beforeInboxFacts = await db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts);
  await db.update(messages).set({ content: "updated provider body", searchText: "updated provider body" }).where(eq(messages.id, message.id));
  const { io, events } = createIoRecorder();
  await emitExternalLinkedMessageUpdateToFrontend(io, message.id);

  assert.deepEqual(events.map(({ room, event }) => ({ room, event })).sort((a, b) => a.room.localeCompare(b.room)), [
    { room: `channel:${localA.id}`, event: "message:updated" },
    { room: `channel:${localB.id}`, event: "message:updated" },
  ].sort((a, b) => a.room.localeCompare(b.room)));
  for (const event of events) {
    assert.equal(event.payload.channelId, event.room.slice("channel:".length));
    assert.equal(event.payload.content, "updated provider body");
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
});

for (const updateThreadPreview of [false, true]) for (const parentType of ["channel", "private"] as const) {
test(`external linked updates preserve ordinary and Joint thread projections (preview=${updateThreadPreview}, parent=${parentType})`, async ({ db }) => {
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

  const [ordinaryParent] = await db.insert(channels).values({ serverId: serverA.id, name: "reaction-ordinary-parent", type: parentType }).returning();
  await db.insert(channelHumans).values({ channelId: ordinaryParent.id, userId: ownerA.id });
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
  await fillJointMembersFromChannelHumans();
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
  await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, canonicalParentMessage.id));
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
  await fillJointMembersFromChannelHumans();
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
  const { io, events } = createIoRecorder();
  await emitExternalLinkedMessageUpdateToFrontend(io, ordinaryReply.id, { updateThreadPreview });
  await emitExternalLinkedMessageUpdateToFrontend(io, externalReply.message.id, { updateThreadPreview });

  assert.equal(events.filter(({ event }) => event === "message:updated").length, 3);
  assert.equal(events.some(({ room }) => room === `channel:${ordinaryParent.id}`), updateThreadPreview);
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
    parentChannelType: parentType,
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
  assert.equal(events.length, updateThreadPreview ? 6 : 3, "each intended room receives one merge-only update");
  if (updateThreadPreview) {
    const ordinaryParentEvent = events.find(({ room }) => room === `channel:${ordinaryParent.id}`)!;
    assert.equal(ordinaryParentEvent.event, "thread:reply_updated");
    assert.equal(ordinaryParentEvent.payload.channelId, ordinaryThread.id);
    assert.equal(ordinaryParentEvent.payload.id, ordinaryReply.id);
    assert.equal(new Date(ordinaryParentEvent.payload.updatedAt).getTime(), ordinaryReply.updatedAt.getTime());
    for (const [localThread, localParent] of [[localThreadA, localParentA], [localThreadB, localParentB]] as const) {
      const parentEvent = events.find(({ room }) => room === `channel:${localParent.id}`)!;
      assert.equal(parentEvent.event, "thread:reply_updated");
      assert.equal(parentEvent.payload.channelId, localThread.id);
      assert.equal(parentEvent.payload.id, externalReply.message.id);
      assert.equal(parentEvent.payload.conversationContext.parentChannelId, localParent.id);
    }
  }
  assert.deepEqual(await db.select({ id: inboxNotificationFacts.id }).from(inboxNotificationFacts), beforeInboxFacts);
});
}

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
    withChannelDelivery({
      deliverMessage: async (agentId: string, payload: any) => {
        deliveries.push({ agentId, payload });
      },
    }) as any,
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

  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [agent.id]);

  const taskSummary = await broadcastSystemMessage(
    io,
    withChannelDelivery({ deliverMessage: async () => {} }) as any,
    channel.id,
    `📋 1 new task created: #1 "Close fact coverage"`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.created_summary",
        reason: "new shared tasks are channel activity",
        causalActor: { type: "user", id: owner.id },
      },
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
    withChannelDelivery({ deliverMessage: async () => {} }) as any,
    channel.id,
    `🔄 Someone moved #1 "Close fact coverage" to In Review`,
    {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.lifecycle_thread",
        reason: "task status transitions are a collaboration signal for the thread audience",
        causalActor: { type: "user", id: owner.id },
      },
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

/**
 * Task v2: createTasks writes no message with task v2 conversations on (the
 * task gets its own conversation). The delivery tests below pin the VISIBLE
 * task-linked message path
 * (converted and pre-v2 tasks), so they seed that shape directly: a chat row,
 * its task.body inbox facts, and a canonical task linked to it.
 */
async function seedVisibleHostTask(channelId: string, ownerId: string, title: string) {
  const db = getDb();
  const hostMessage = await createMessage(channelId, "user", ownerId, title);
  await recordInboxFactsForPersistedMessages([hostMessage], {
    inboxFactPolicy: {
      mode: "record",
      producer: "task.body",
      reason: "visible task host messages are durable shared work items",
    },
    dedupeLogicalReceiverAcrossJointProjections: true,
  });
  const [{ maxNumber }] = await db
    .select({ maxNumber: sql<number>`COALESCE(MAX(${tasks.taskNumber}), 0)::int` })
    .from(tasks)
    .where(eq(tasks.channelId, channelId));
  const [task] = await db.insert(tasks).values({
    channelId,
    taskNumber: Number(maxNumber) + 1,
    title,
    status: "todo",
    createdByType: "user",
    createdById: ownerId,
    messageId: hostMessage.id,
    sourceMessageId: hostMessage.id,
  }).returning();
  return { tasks: [task!], hostMessages: [hostMessage] };
}

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

  const { tasks: [task], hostMessages: [taskHostMessage] } = await seedVisibleHostTask(channel.id, owner.id, "muted task body");
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
  const orchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

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
        causalActor: { type: "user", id: owner.id },
      },
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

  const { tasks: [task], hostMessages: [taskHostMessage] } = await seedVisibleHostTask(threadChannel.id, owner.id, "thread task body");
  const deliveries: { agentId: string; payload: any }[] = [];
  const orchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

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
        causalActor: { type: "user", id: owner.id },
      },
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
  const { hostMessages: [taskHostMessage] } = await seedVisibleHostTask(thread.id, owner.id, "muted thread task body");

  const deliveries: { agentId: string; payload: any }[] = [];
  const orchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

  await deliverMessageToAgents(orchestrator, taskHostMessage, owner.name);

  assert.deepEqual(
    deliveries.map((delivery) => delivery.agentId).sort(),
    [mutedAgent.id, unmutedAgent.id].sort(),
  );
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
  const { tasks: [task], hostMessages: [assignedTask] } = await seedVisibleHostTask(thread.id, owner.id, "muted assigned thread task");
  // v1.4: assignment lives on the canonical task row, not messages.task_*.
  // The host message below carries no task columns at all — delivery must
  // still ship task_assignee_id, which is only
  // true if the canonical facts are projected onto it on the way out.
  assert.notEqual(await taskService.claimTask(task.id, "agent", agent.id), "task not found");
  assert.equal(assignedTask.taskAssigneeId, null, "host message must not carry task assignment");

  const deliveries: { agentId: string; payload: any }[] = [];
  const orchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

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
  const visible = await createMessage(channel.id, "user", owner.id, "post-join durable request", "chat", undefined, {
    senderTimezone: "Asia/Shanghai",
  });
  await createMessage(channel.id, "agent", agent.id, "own send should stay out");

  const base = new Date("2026-07-01T00:00:00.000Z");
  for (const preJoin of preJoinRows) {
    await db.update(messages).set({ createdAt: new Date(base.getTime()) }).where(eq(messages.id, preJoin.id));
  }
  await db.update(channelAgents).set({ addedAt: new Date(base.getTime() + 1_000) }).where(
    and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, agent.id)),
  );
  await db.update(messages).set({ createdAt: new Date(base.getTime() + 2_000) }).where(eq(messages.id, visible.id));

  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: await referenceAgentInboxChain(agent.id) });

  assert.equal(result.candidateChannelCount, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].message_id, visible.id);
  assert.equal(result.messages[0].content, "post-join durable request");
  assert.equal(result.messages[0].sender_name, owner.name);
  assert.equal(result.messages[0].channel_id, channel.id);
  assert.equal(result.messages[0].channel_type, "channel");
  assert.equal(result.messages[0].sender_timezone, "Asia/Shanghai", "catch-up carries the human sender's zone like live delivery");
  assert.equal(result.maxSeq, visible.seq);
  // The resume summary must count exactly the rows the catch-up would hand over.
  assert.deepEqual(await getAgentUnreadCounts(agent.id, await referenceAgentInboxChain(agent.id)), { "#resume-catchup-room": 1 });

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

test("agent resume offers exactly the chain's rows", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "resume-chain-owner@test.com",
    name: "resumeChainOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Resume Chain", slug: "resume-chain", ownerId: owner.id }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "resume-chain-agent", status: "active" }).returning();
  const [listed, unlisted, notMember] = await db.insert(channels).values([
    { serverId: server.id, name: "chain-listed", type: "channel" },
    { serverId: server.id, name: "chain-unlisted", type: "channel" },
    { serverId: server.id, name: "chain-not-member", type: "channel" },
  ]).returning();
  const [membership] = await db.insert(channelAgents).values([
    { channelId: listed.id, agentId: agent.id },
    { channelId: unlisted.id, agentId: agent.id },
  ]).returning();
  const wanted = await createMessage(listed.id, "user", owner.id, "offered by the chain");
  await createMessage(unlisted.id, "user", owner.id, "unread in Postgres, absent from the chain");
  await createMessage(notMember.id, "user", owner.id, "mentioned but never joined");

  // The chain decides WHICH channels are offered: a Postgres-unread channel it omits is not
  // offered. It holds only offered rows, so a channel the agent never joined (only
  // mentioned in) has no row at all.
  const chain: AgentInboxChainRow[] = [{
    targetId: listed.id,
    storageChannelId: listed.id,
    kind: "channel",
    serverId: server.id,
    channelName: listed.name,
    channelType: "channel",
    parentMessageId: null,
    parentChannelId: null,
    parentChannelName: null,
    parentChannelType: null,
    lastReadSeq: 0,
    unreadCount: 1,
    firstUnreadSeq: wanted.seq,
    latestSeq: wanted.seq,
    mentionUnread: 0,
    maxMentionSeq: null,
    subscribed: true,
    offeredUnread: 1,
    activitySeq: wanted.seq,
    joinedAt: membership.addedAt,
  }];

  assert.deepEqual(await getAgentUnreadCounts(agent.id, chain), { "#chain-listed": 1 });
  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain });
  assert.deepEqual(result.messages.map((m) => m.message_id), [wanted.id]);
  assert.equal(result.candidateChannelCount, 1);
});

test("agent resume recovers joint channels and threads from storage, labelled as live delivery labels them", async ({ db }) => {
  const [ownerA, ownerB] = await db.insert(users).values([
    { email: "resume-joint-a@test.com", name: "resumeJointA", passwordHash: "x", emailVerified: true },
    { email: "resume-joint-b@test.com", name: "resumeJointB", passwordHash: "x", emailVerified: true },
  ]).returning();
  const [serverA] = await db.insert(servers).values({ name: "Resume Joint A", slug: "resume-joint-a", ownerId: ownerA.id }).returning();
  const [serverB] = await db.insert(servers).values({ name: "Resume Joint B", slug: "resume-joint-b", ownerId: ownerB.id }).returning();
  const [agent] = await db.insert(agents).values({ serverId: serverB.id, name: "resume-joint-agent", status: "active" }).returning();

  const [canonical, localA, localB] = await db.insert(channels).values([
    { serverId: serverA.id, name: "resume-joint-canonical", type: "joint" },
    { serverId: serverA.id, name: "resume-joint-a", type: "joint" },
    { serverId: serverB.id, name: "resume-joint-b", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: serverA.id, localChannelId: localA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: joint.id, serverId: serverB.id, localChannelId: localB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  await fillJointMembersFromChannelHumans();
  const [membership] = await db.insert(channelAgents).values({ channelId: localB.id, agentId: agent.id }).returning();

  const parent = await createMessage(canonical.id, "user", ownerA.id, "joint parent");
  // The agent has read up to the parent in its local projection.
  await db.insert(agentChannelReadCursors).values({ agentId: agent.id, channelId: localB.id, lastReadSeq: parent.seq });
  const [canonicalThread] = await db.insert(channels).values({
    serverId: serverA.id,
    name: `thread-${parent.id.slice(0, 8)}`,
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, parent.id));
  const [threadA, threadB] = await db.insert(channels).values([
    { serverId: serverA.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" },
    { serverId: serverB.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" },
  ]).returning();
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: threadJoint.id, serverId: serverA.id, localChannelId: threadA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: threadJoint.id, serverId: serverB.id, localChannelId: threadB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  await fillJointMembersFromChannelHumans();
  const [follow] = await db.insert(threadFollows).values({
    followerType: "agent",
    followerId: agent.id,
    threadChannelId: threadB.id,
    parentMessageId: parent.id,
    reason: "mentioned",
  }).returning();

  const channelMessage = await createMessage(canonical.id, "user", ownerA.id, "joint channel, after the parent");
  const reply = await createMessage(canonicalThread.id, "user", ownerA.id, "joint thread reply");

  const base = {
    serverId: serverB.id,
    parentChannelId: null,
    parentChannelName: null,
    parentChannelType: null,
    mentionUnread: 0,
    maxMentionSeq: null,
    subscribed: true,
  };
  const chain: AgentInboxChainRow[] = [
    {
      ...base,
      targetId: localB.id,
      storageChannelId: canonical.id,
      kind: "channel",
      channelName: localB.name,
      channelType: "joint",
      parentMessageId: null,
      lastReadSeq: parent.seq,
      unreadCount: 1,
      firstUnreadSeq: channelMessage.seq,
      latestSeq: channelMessage.seq,
      offeredUnread: 1,
      activitySeq: channelMessage.seq,
      joinedAt: membership.addedAt,
    },
    {
      // As the agent inbox view reports a joint thread: parent_message_id is the
      // canonical parent; its parent channel is the local parent projection.
      ...base,
      targetId: threadB.id,
      storageChannelId: canonicalThread.id,
      kind: "thread",
      channelName: threadB.name,
      channelType: "thread",
      parentMessageId: parent.id,
      parentChannelId: localB.id,
      parentChannelName: localB.name,
      parentChannelType: "joint",
      lastReadSeq: 0,
      unreadCount: 1,
      firstUnreadSeq: reply.seq,
      latestSeq: reply.seq,
      offeredUnread: 1,
      activitySeq: reply.seq,
      joinedAt: follow.createdAt,
    },
  ];

  // The CI reference for the agent inbox view derives exactly these rows.
  const byTarget = (a: AgentInboxChainRow, b: AgentInboxChainRow) => a.targetId.localeCompare(b.targetId);
  assert.deepEqual([...await referenceAgentInboxChain(agent.id)].sort(byTarget), [...chain].sort(byTarget));

  assert.deepEqual(await getAgentUnreadCounts(agent.id, chain), {
    "#resume-joint-b": 1,
    [`#resume-joint-b:${parent.id.slice(0, 8)}`]: 1,
  });

  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain });
  const byId = new Map(result.messages.map((message) => [message.message_id, message]));
  assert.deepEqual([...byId.keys()].sort(), [channelMessage.id, reply.id].sort());
  assert.equal(result.candidateChannelCount, 2);
  assert.deepEqual(
    pickAgentLabels(byId.get(channelMessage.id)!),
    { channel_id: localB.id, channel_name: localB.name, channel_type: "channel", parent_channel_id: undefined, parent_channel_name: undefined, parent_channel_type: undefined },
  );
  assert.deepEqual(
    pickAgentLabels(byId.get(reply.id)!),
    { channel_id: threadB.id, channel_name: threadB.name, channel_type: "thread", parent_channel_id: localB.id, parent_channel_name: localB.name, parent_channel_type: "channel" },
  );

  // Acking the delivered seqs advances the read position of the conversations the
  // agent was handed (the local projections), not the canonical storage.
  await markAgentLegacyAckCheckpoint(agent.id, [channelMessage.seq, reply.seq]);
  assert.equal(await getAgentLegacyReadCursor(agent.id, localB.id), channelMessage.seq);
  assert.equal(await getAgentLegacyReadCursor(agent.id, threadB.id), reply.seq);
  assert.equal(await getAgentLegacyReadCursor(agent.id, canonical.id), 0);
  assert.equal(await getAgentLegacyReadCursor(agent.id, canonicalThread.id), 0);
});

function pickAgentLabels(message: AgentResumeCatchupResult["messages"][number]) {
  return {
    channel_id: message.channel_id,
    channel_name: message.channel_name,
    channel_type: message.channel_type,
    parent_channel_id: message.parent_channel_id,
    parent_channel_name: message.parent_channel_name,
    parent_channel_type: message.parent_channel_type,
  };
}

/** A two-server joint channel: the sender on server A, the agent a member of server B's local projection. */
async function seedJointMentionOccurrenceFixture(db: ReturnType<typeof getDb>, slug: string) {
  const [ownerA, ownerB] = await db.insert(users).values([
    { email: `${slug}-a@test.com`, name: `${slug}A`, passwordHash: "x", emailVerified: true },
    { email: `${slug}-b@test.com`, name: `${slug}B`, passwordHash: "x", emailVerified: true },
  ]).returning();
  const [serverA] = await db.insert(servers).values({ name: `${slug} A`, slug: `${slug}-a`, ownerId: ownerA.id }).returning();
  const [serverB] = await db.insert(servers).values({ name: `${slug} B`, slug: `${slug}-b`, ownerId: ownerB.id }).returning();
  await db.insert(serverMembers).values([
    { serverId: serverA.id, userId: ownerA.id, role: "owner" },
    { serverId: serverB.id, userId: ownerB.id, role: "owner" },
  ]);
  const [agent] = await db.insert(agents).values({ serverId: serverB.id, name: `${slug}-agent`, status: "active", runtime: "codex" }).returning();
  const [canonical, localA, localB] = await db.insert(channels).values([
    { serverId: serverA.id, name: `${slug}-canonical`, type: "joint" },
    { serverId: serverA.id, name: `${slug}-a`, type: "joint" },
    { serverId: serverB.id, name: `${slug}-b`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: serverA.id, localChannelId: localA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: joint.id, serverId: serverB.id, localChannelId: localB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  await db.insert(channelHumans).values([
    { channelId: localA.id, userId: ownerA.id },
    { channelId: localB.id, userId: ownerB.id },
  ]);
  await db.insert(channelAgents).values({ channelId: localB.id, agentId: agent.id });
  await fillJointMembersFromChannelHumans();
  const delivered: { agentId: string; payload: any; options?: any }[] = [];
  let signalAgentDelivered!: () => void;
  // Joint channel deliveries are scheduled after broadcastAndDeliver returns.
  const agentDelivered = new Promise<void>((resolve) => { signalAgentDelivered = resolve; });
  const orchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any, options?: any) => {
      delivered.push({ agentId, payload, options });
      if (agentId === agent.id) signalAgentDelivered();
    },
  }) as any;
  return { ownerA, ownerB, serverA, serverB, agent, canonical, localA, localB, delivered, agentDelivered, orchestrator };
}

/** The mentioned agent's occurrence carries the payload it was delivered, and that delivery names the occurrence. */
async function assertJointMentionOccurrenceDelivered(
  db: ReturnType<typeof getDb>,
  input: { messageId: string; agentId: string; delivered: { agentId: string; payload: any; options?: any }[]; agentDelivered: Promise<void> },
) {
  await waitForTestSignal(input.agentDelivered, "joint mention delivery");
  const rows = await db.select().from(mentionDeliveryOccurrences).where(eq(mentionDeliveryOccurrences.messageId, input.messageId));
  assert.equal(rows.length, 1, "the send records one occurrence for the mentioned agent");
  const occurrence = rows[0]!;
  assert.equal(occurrence.agentId, input.agentId);
  const delivery = input.delivered.find((candidate) => candidate.agentId === input.agentId && candidate.payload.message_id === input.messageId);
  assert.ok(delivery, "the mentioned agent is delivered the joint message");
  assert.equal(delivery.payload.mentioned, true);
  assert.notEqual(occurrence.deliveryPayload, null, "the joint path persists the occurrence's delivery payload");
  assert.equal((occurrence.deliveryPayload as any).message_id, input.messageId);
  assert.equal((occurrence.deliveryPayload as any).channel_id, delivery.payload.channel_id, "the payload is the receiver-local delivery");
  assert.equal(delivery.options?.mentionDeliveryOccurrenceId, occurrence.occurrenceId, "the delivery carries its occurrence id");
}

test("a joint channel mention persists the agent's occurrence payload and passes its occurrence id to delivery", async ({ db }) => {
  const f = await seedJointMentionOccurrenceFixture(db, "joint-occ-channel");
  const { io } = createIoRecorder();

  const message = await broadcastAndDeliver(io, f.orchestrator, {
    channelId: f.localA.id,
    senderType: "user",
    senderId: f.ownerA.id,
    senderName: f.ownerA.name,
    content: `hello @${f.agent.name}`,
    mentions: [{ type: "agent", id: f.agent.id, name: f.agent.name }] as any,
  });

  await assertJointMentionOccurrenceDelivered(db, { messageId: message.id, agentId: f.agent.id, delivered: f.delivered, agentDelivered: f.agentDelivered });
  assert.equal(f.delivered.find((delivery) => delivery.agentId === f.agent.id)?.payload.channel_id, f.localB.id);
});

test("a joint thread mention persists the agent's occurrence payload and passes its occurrence id to delivery", async ({ db }) => {
  const f = await seedJointMentionOccurrenceFixture(db, "joint-occ-thread");
  const parent = await createMessage(f.canonical.id, "user", f.ownerA.id, "joint parent");
  const [canonicalThread] = await db.insert(channels).values({
    serverId: f.serverA.id,
    name: `thread-${parent.id.slice(0, 8)}`,
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, parent.id));
  const [threadA, threadB] = await db.insert(channels).values([
    { serverId: f.serverA.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" },
    { serverId: f.serverB.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" },
  ]).returning();
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: f.serverA.id,
    createdByUserId: f.ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: threadJoint.id, serverId: f.serverA.id, localChannelId: threadA.id, role: "host", status: "active", joinedByUserId: f.ownerA.id },
    { jointChannelId: threadJoint.id, serverId: f.serverB.id, localChannelId: threadB.id, role: "participant", status: "active", joinedByUserId: f.ownerB.id },
  ]);
  await fillJointMembersFromChannelHumans();
  const { io } = createIoRecorder();

  const reply = await broadcastAndDeliver(io, f.orchestrator, {
    channelId: threadA.id,
    senderType: "user",
    senderId: f.ownerA.id,
    senderName: f.ownerA.name,
    content: `thread ping @${f.agent.name}`,
    mentions: [{ type: "agent", id: f.agent.id, name: f.agent.name }] as any,
  });

  await assertJointMentionOccurrenceDelivered(db, { messageId: reply.id, agentId: f.agent.id, delivered: f.delivered, agentDelivered: f.agentDelivered });
  assert.equal(f.delivered.find((delivery) => delivery.agentId === f.agent.id)?.payload.channel_id, threadB.id);
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
  // The send path's mention row: the chain's mention arm is what offers a muted channel.
  await db.insert(messageMentions).values({
    messageId: pierced.id, messageSeq: pierced.seq, serverId: server.id, channelId: channel.id,
    targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name,
  });

  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: await referenceAgentInboxChain(agent.id) });

  assert.equal(result.candidateChannelCount, 1);
  assert.deepEqual(result.messages.map((message) => message.message_id), [pierced.id]);
  assert.equal(result.messages[0]?.content, `@${agent.name} pierce resume`);
  // A recovered mention reads like the live one: flagged as mentioning the agent.
  assert.equal(result.messages[0]?.mentioned, true);
  assert.equal(result.maxSeq, pierced.seq);
});

// A mention pierces a mute (rw_agent_inbox_v6, 076-cursor-decouple-consumers.sql): the same rule
// as humans. The fixture is a channel the agent is a member of, with a read pre-mute
// prefix, then `mutedOrdinary` non-mention messages after the mute point, then one
// @mention of the agent.
async function seedMutedChannelWithPiercingMention(
  db: ReturnType<typeof getDb>,
  slug: string,
  opts: { mutedOrdinary: number; muted?: boolean },
) {
  const [owner] = await db.insert(users).values({
    email: `${slug}-owner@test.com`, name: `${slug}Owner`, passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: slug, slug, ownerId: owner.id }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `${slug}-agent`, status: "active" }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: `${slug}-room`, type: "channel" }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  await createMessage(channel.id, "user", owner.id, "pre-mute one");
  const prefixEnd = await createMessage(channel.id, "user", owner.id, "pre-mute two");
  await db.insert(agentChannelReadCursors).values({ channelId: channel.id, agentId: agent.id, lastReadSeq: prefixEnd.seq });
  if (opts.muted !== false) {
    await db.insert(inboxTargetMuteStates).values({
      receiverType: "agent", receiverId: agent.id, serverId: server.id, sourceChannelId: channel.id,
      muteFromSeq: prefixEnd.seq + 1,
    });
  }
  const ordinary = [];
  for (let i = 0; i < opts.mutedOrdinary; i += 1) {
    ordinary.push(await createMessage(channel.id, "user", owner.id, `after the mute ${i}`));
  }
  const mention = await createMessage(channel.id, "user", owner.id, `@${agent.name} after the mute`);
  const [existing] = await db.select({ id: messageMentions.messageId }).from(messageMentions).where(and(
    eq(messageMentions.messageId, mention.id), eq(messageMentions.targetType, "agent"), eq(messageMentions.targetId, agent.id),
  ));
  if (!existing) {
    await db.insert(messageMentions).values({
      messageId: mention.id, messageSeq: mention.seq, serverId: server.id, channelId: channel.id,
      targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name,
    });
  }
  return { owner, server, agent, channel, prefixEnd, ordinary, mention };
}

test("agent inbox: a mention after the mute pierces it once the pre-mute prefix is read", async ({ db }) => {
  const { agent, channel, mention } = await seedMutedChannelWithPiercingMention(db, "pierce-read-prefix", { mutedOrdinary: 1 });

  const chain = await referenceAgentInboxChain(agent.id);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].targetId, channel.id);
  // Subscribed through the muted prefix, which is fully read; the mention lies beyond it.
  assert.equal(chain[0].subscribed, true);
  assert.equal(chain[0].unreadCount, 0);
  assert.equal(chain[0].mentionUnread, 1);
  assert.equal(chain[0].maxMentionSeq, mention.seq);
  assert.equal(chain[0].offeredUnread, 1);
  assert.equal(chain[0].activitySeq, mention.seq);

  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain });
  assert.deepEqual(result.messages.map((message) => message.message_id), [mention.id]);
  assert.equal(result.messages[0]?.mentioned, true);
  assert.equal(result.maxSeq, mention.seq);

  await markAgentLegacyAckCheckpoint(agent.id, [result.maxSeq!]);
  assert.deepEqual(await referenceAgentInboxChain(agent.id), []);
});

test("agent resume catch-up reaches a piercing mention behind more muted rows than the per-conversation limit", async ({ db }) => {
  const { agent, channel, ordinary, mention } = await seedMutedChannelWithPiercingMention(db, "pierce-starvation", { mutedOrdinary: 10 });

  const chain = await referenceAgentInboxChain(agent.id);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].offeredUnread, 1);

  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain });
  assert.deepEqual(result.messages.map((message) => message.message_id), [mention.id]);
  assert.equal(result.messages[0]?.mentioned, true);
  assert.deepEqual(result.conversations, [{ channelId: channel.id, truncated: false }]);

  // Acking the delivered mention skips the muted ordinary rows (not of interest),
  // and the conversation is no longer offered.
  await markAgentLegacyAckCheckpoint(agent.id, [result.maxSeq!]);
  assert.equal(await getAgentLegacyReadCursor(agent.id, channel.id), mention.seq);
  assert.ok(ordinary.every((row) => row.seq < mention.seq));
  assert.deepEqual(await referenceAgentInboxChain(agent.id), []);
  const again = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: [] });
  assert.deepEqual(again.messages, []);
});

test("agent resume catch-up of an unmuted channel is unchanged: oldest rows first, bounded", async ({ db }) => {
  const { agent, channel, ordinary, mention } = await seedMutedChannelWithPiercingMention(db, "pierce-unmuted", { mutedOrdinary: 10, muted: false });

  const chain = await referenceAgentInboxChain(agent.id);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].subscribed, true);
  assert.equal(chain[0].unreadCount, 11);
  // The mention is inside the admitted stream: no pierce bonus.
  assert.equal(chain[0].offeredUnread, 11);

  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain });
  assert.deepEqual(result.messages.map((message) => message.message_id), ordinary.slice(0, 5).map((row) => row.id));
  assert.deepEqual(result.conversations, [{ channelId: channel.id, truncated: true }]);
  assert.ok(result.messages.every((message) => message.mentioned !== true));
  assert.ok(result.messages.every((message) => message.message_id !== mention.id));
});

test("agent resume catch-up keeps a followed thread independent of its muted parent", async ({ db }) => {
  const { owner, agent, channel, prefixEnd } = await seedMutedChannelWithPiercingMention(db, "pierce-thread", { mutedOrdinary: 0 });
  await markAgentLegacyAckCheckpoint(agent.id, [(await referenceAgentInboxChain(agent.id))[0]!.maxMentionSeq!]);
  assert.deepEqual(await referenceAgentInboxChain(agent.id), []);

  const [thread] = await db.insert(channels).values({
    serverId: channel.serverId, name: `thread-${prefixEnd.id.slice(0, 8)}`, type: "thread", parentMessageId: prefixEnd.id,
  }).returning();
  await db.update(messages).set({ threadId: thread.id }).where(eq(messages.id, prefixEnd.id));
  await db.insert(threadFollows).values({
    followerType: "agent", followerId: agent.id, threadChannelId: thread.id, parentMessageId: prefixEnd.id, reason: "mentioned",
  });
  const replies = [];
  for (let i = 0; i < 6; i += 1) {
    replies.push(await createMessage(thread.id, "user", owner.id, `thread reply ${i}`));
  }

  const chain = await referenceAgentInboxChain(agent.id);
  assert.deepEqual(chain.map((row) => [row.targetId, row.kind, row.subscribed, row.unreadCount, row.offeredUnread]), [
    [thread.id, "thread", true, 6, 6],
  ]);
  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain });
  // Ordinary replies are delivered despite the parent's mute, oldest first, bounded.
  assert.deepEqual(result.messages.map((message) => message.message_id), replies.slice(0, 5).map((row) => row.id));
  assert.deepEqual(result.conversations, [{ channelId: thread.id, truncated: true }]);
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

  const result = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: await referenceAgentInboxChain(agent.id) });

  assert.equal(result.candidateChannelCount, 8);
  assert.equal(result.messages.at(0)?.message_id, freshMention.id);
  assert.equal(result.messages.at(0)?.content, `@${agent.name} fresh wake request`);
  // The fixed ordering selects the fresh channel plus seven debt channels:
  // one fresh wake followed by the same 14-row stale body shape.
  assert.equal(result.messages.length, 15);
  assert.equal(result.messages.filter((message) => message.content.startsWith("old unread debt")).length, 14);
  // Rows that don't mention the agent carry no mention flag.
  assert.ok(result.messages.filter((message) => message.content.startsWith("old unread debt")).every((message) => message.mentioned === undefined));
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

  const activeResume = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: await referenceAgentInboxChain(agent.id) });
  assert.deepEqual(activeResume.messages.map((message) => message.message_id), [followedReply.id]);
  const activeUnreadCounts = await getAgentUnreadCounts(agent.id, await referenceAgentInboxChain(agent.id));
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

  const tombstonedResume = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: await referenceAgentInboxChain(agent.id) });
  assert.deepEqual(tombstonedResume.messages, [], "stale thread channelAgents membership must not revive resume delivery");
  assert.equal((await getAgentUnreadCounts(agent.id, await referenceAgentInboxChain(agent.id)))[threadTarget], undefined);
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

  const resume = await getAgentResumeCatchupMessages(agent.id, undefined, { chain: await referenceAgentInboxChain(agent.id) });
  assert.deepEqual(resume.messages, [], "active follow must not revive resume after private parent access is removed");
  assert.equal((await getAgentUnreadCounts(agent.id, await referenceAgentInboxChain(agent.id)))[`#${threadName}`], undefined);
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
    // An agent's own send goes through markAgentOwnSendRead.
    markAgentOwnSendRead: async (senderId: string, channelId: string, seq: number) => {
      markAgentLegacyReadCalls.push({ senderId, channelId, seq });
    },
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io, events } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;
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
    getMentionFactsForMessages: async () => new Map(),
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
  await broadcastSystemMessage(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, "dm-1", "System DM", {
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
  });
  const { io, events } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;
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
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io, events } = createIoRecorder();
  await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
    await broadcastAndDeliver(io, withChannelDelivery({ deliverMessage: async () => undefined }) as any, {
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
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;

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
  insertMentionRows: async () => [],
});

const { io, events } = createIoRecorder();
const agentOrchestrator = withChannelDelivery({
  deliverMessage: async (agentId: string, payload: any) => {
    deliveries.push({ agentId, payload });
  },
}) as any;

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
assert.equal(Object.hasOwn(emittedItem ?? {}, "sourceTargetId"), false, "sourceTargetId is removed, not null");
assert.equal(Object.hasOwn(emittedItem ?? {}, "sourceMessageId"), false, "sourceMessageId is removed, not null");
assert.equal(Object.hasOwn(emittedItem ?? {}, "sourceServerId"), false, "sourceServerId is removed, not null");
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
  insertMentionRows: async () => [],
});

const { io } = createIoRecorder();
const agentOrchestrator = withChannelDelivery({
  deliverMessage: async (agentId: string, payload: any) => {
    deliveries.push({ agentId, payload });
  },
}) as any;

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
  await broadcastAndDeliver(io, withChannelDelivery({
    deliverMessage: async () => {
      durableAtHandoff = payloadDurable;
      recoveryProbe = listRecoverableMentionDeliveriesForAgent(
        "00000000-0000-4000-8000-00000000feed",
        mentionedAgent.id,
      );
      await recoveryProbe;
    },
  }) as any, {
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
    await broadcastAndDeliver(io, withChannelDelivery({
      deliverMessage: async (agentId: string, payload: any) => {
        delivered.push({ agentId, payload });
      },
    }) as any, {
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
  const agentOrchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

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
  const agentOrchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

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
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

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
    renderAgentReadablePermalinks: async (content: string) => content,
    recordInboxNotificationFacts,
    getJointThreadProjectionForMember,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;
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
    renderAgentReadablePermalinks: async (content: string) => content,
    recordInboxNotificationFacts,
    getJointThreadProjectionForMember,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;
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

test("broadcastAndDeliver keeps followed joint-thread agent delivery independent from parent mute", async () => {
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
    await fillJointMembersFromChannelHumans();
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
    await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, canonicalParentMessage.id));
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
    await fillJointMembersFromChannelHumans();
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

    __setMessageServiceDepsForTests({
      markRead: async () => undefined,
      markAgentLegacyRead: async () => undefined,
      renderAgentReadablePermalinks: async (content: string) => content,
      recordInboxNotificationFacts,
      getActiveJointThreadProjectionsByCanonicalThread,
      getJointThreadProjectionForMember,
      getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
        uniqueName: fallbackName,
        description: null,
      }),
    });

    const { io } = createIoRecorder();
    const agentDeliveries: Array<{ agentId: string; payload: any }> = [];
    const agentOrchestrator = withChannelDelivery({
      deliverMessage: async (agentId: string, payload: any) => {
        agentDeliveries.push({ agentId, payload });
      },
    }) as any;
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

    const facts = (await db.select().from(inboxNotificationFacts)).filter((fact) => fact.messageId === reply.id);
    assert.ok(facts.some((fact) => fact.receiverType === "agent" && fact.receiverId === agentA.id && fact.sourceChannelId === localThreadA.id));
    assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === ownerA.id && fact.sourceChannelId === localThreadA.id));
    assert.ok(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === senderB.id && fact.sourceChannelId === localThreadB.id && fact.unreadEligible === false));
    assert.equal(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === ownerA.id && fact.sourceChannelId === localThreadB.id), false);
    assert.equal(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === senderB.id && fact.sourceChannelId === localThreadA.id), false);

    await db.update(messages).set({
      senderId: "system",
      messageType: "system",
    }).where(eq(messages.id, canonicalParentMessage.id));
    const systemParentReply = await broadcastAndDeliver(io, agentOrchestrator, {
      channelId: localThreadB.id,
      senderType: "user",
      senderId: senderB.id,
      senderName: senderB.name,
      content: "joint system-parent thread reply",
    });
    assert.ok(
      agentDeliveries.some((delivery) =>
        delivery.agentId === agentA.id
        && delivery.payload.content === systemParentReply.content
      ),
      "excluding the pseudo user:system parent must preserve delivery to real joint-thread followers",
    );

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
    insertMentionRows: async () => [],
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any, options: any) => {
      deliveries.push({ agentId, payload, options });
    },
  }) as any;

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
    insertMentionRows: async () => [],
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any, options: any) => {
      deliveries.push({ agentId, payload, options });
    },
  }) as any;

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
    insertMentionRows: async () => [],
    getMentionFactsForMessages: async () => new Map([["msg-private-mention", []]]),
  });

  const { io } = createIoRecorder();
  const agentOrchestrator = withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, payload });
    },
  }) as any;

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
      await deliverMessageToAgent(withChannelDelivery({
        deliverMessage: async (agentId: string) => { delivered.push(agentId); return { status: "queued" }; },
      }) as any, message.id, agent.id);
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
      await deliverMessageToAgents(withChannelDelivery({
        deliverMessage: async (agentId: string) => { delivered.push(agentId); return { status: "queued" }; },
      }) as any, message, owner.name);
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

test("runExternalInboundCommitSideEffects runs the agent leg even when the frontend leg throws", async () => {
  const order: string[] = [];
  await assert.rejects(
    runExternalInboundCommitSideEffects(
      async () => {
        order.push("emit");
        throw new Error("socket down");
      },
      async () => {
        order.push("deliver");
      },
    ),
    /socket down/,
  );
  assert.deepEqual(order.sort(), ["deliver", "emit"]);
});

test("runExternalInboundCommitSideEffects runs the frontend leg even when agent delivery throws", async () => {
  const order: string[] = [];
  await assert.rejects(
    runExternalInboundCommitSideEffects(
      async () => {
        order.push("emit");
      },
      async () => {
        order.push("deliver");
        throw new Error("orchestrator down");
      },
    ),
    /orchestrator down/,
  );
  assert.deepEqual(order.sort(), ["deliver", "emit"]);
});

test("runExternalInboundCommitSideEffects aggregates when both legs fail", async () => {
  await assert.rejects(
    runExternalInboundCommitSideEffects(
      async () => {
        throw new Error("emit boom");
      },
      async () => {
        throw new Error("deliver boom");
      },
    ),
    (error) => error instanceof AggregateError && (error as AggregateError).errors.length === 2,
  );
});

test("runExternalInboundCommitSideEffects resolves cleanly when both legs succeed", async () => {
  await runExternalInboundCommitSideEffects(
    async () => {},
    async () => {},
  );
});

test("structured external mention writes an external_mention_facts row, never a message_mentions row", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: `ext-mention-${randomUUID()}@test.invalid`,
    name: `ext-mention-${randomUUID()}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "External Mention Server",
    slug: `ext-mention-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `ext-mention-${randomUUID()}`,
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });

  const [oauthClient] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-ext-${randomUUID().slice(0, 8)}`,
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: owner.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: oauthClient.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_EXT",
    providerOAuthClientId: "oauth-ext",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest-ext",
    requiredCapabilities: ["external_projection"],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-ext",
    grantedCapabilities: ["external_projection"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 1,
    scopeRevision: 1,
    credentialRevision: 1,
    installedScopes: ["chat:write"],
    providerAppId: "A_EXT",
    providerTeamId: "T_EXT",
    authorityType: "team",
    providerAuthorityId: "T_EXT",
  }).returning();
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "C_EXT",
    providerConversationKind: "public_channel",
    privacyClass: "public",
    grantEpoch: 1,
    connectionEpoch: 1,
    bindingEpoch: 1,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: new Date(),
  }).returning();
  await db.insert(externalBindingAudienceSnapshots).values({
    bindingId: binding.id,
    bindingEpoch: 1,
    audienceRevision: 7,
    externalMemberCount: 1,
    externalAudienceDigest: "ext-digest",
    raftMemberCount: 1,
    raftAudienceDigest: "raft-digest",
    status: "matched",
    observedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: install.providerAuthorityId,
    externalActorId: "U_EXT",
    displayName: "Ada Lovelace",
    handles: ["ada.lovelace"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date(Date.now() - 60_000),
  }).returning();
  await db.insert(externalAddressabilityProjections).values({
    projectionId: actor.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: install.providerAuthorityId,
    connectionEpoch: install.connectionEpoch,
    bindingId: binding.id,
    bindingEpoch: binding.bindingEpoch,
    conversationId: binding.providerConversationId,
    memberRevision: 7,
    contextRevision: 7,
    state: "active",
    observedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60_000),
  });

  const io = { to() { return { emit() {} }; }, in() { return { in() { return { socketsJoin() {} }; }, socketsJoin() {} }; } } as any;
  const orchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;
  const sent = await broadcastAndDeliver(io, orchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.name,
    // The composer sanitizes a Slack handle with `.` into the Raft-legal
    // `ada-lovelace` before inserting the token; the structured mention
    // carries the sanitized token and the fact records it, so the outbound
    // renderer swaps `@ada-lovelace` for `<@U_EXT>`.
    content: "hi @ada-lovelace can you check",
    mentions: [{ type: "external", id: actor.id, name: "ada-lovelace" }],
  });
  assert.ok(sent.id);

  const facts = await db.select().from(externalMentionFacts)
    .where(eq(externalMentionFacts.messageId, sent.id));
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.projectionId, actor.id);
  assert.equal(facts[0]!.externalActorId, "U_EXT");
  assert.equal(facts[0]!.handleAtSendTime, "ada-lovelace");
  assert.equal(facts[0]!.bindingId, binding.id);
  assert.equal(facts[0]!.memberRevision, 7);

  const mentionsRows = await db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, sent.id));
  assert.equal(mentionsRows.length, 0, "external mentions must not land in message_mentions");

  // But it MUST surface in the payload's `mentions` array so the Raft client
  // renders it as styled text (not plain `@ada-lovelace`).
  const payloadMentions = (sent.mentions as { type: string; id: string; name: string }[] | undefined) ?? [];
  const ext = payloadMentions.find((m) => m.type === "external");
  assert.ok(ext, "payload must carry the external mention so the UI can highlight it");
  assert.equal(ext.id, actor.id);
  assert.equal(ext.name, "ada-lovelace");

  // Hydrated (list/history) path must return the same external mention via
  // the `external_mention_facts` lookup — not just the send-time payload.
  const hydratedFacts = await db.select().from(externalMentionFacts)
    .where(eq(externalMentionFacts.messageId, sent.id)).then((r) => r.map((row) => ({
      type: "external" as const,
      id: row.projectionId,
      name: row.handleAtSendTime,
    })));
  assert.equal(hydratedFacts.length, 1, "hydrated read must surface the same fact");
});
