import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  InMemoryFailpointRegistry,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import { getOrCreateThread } from "./channelService.js";
import {
  agents,
  attachmentObjects,
  attachments,
  channelAgents,
  channelHumans,
  channels,
  externalAuthorPolicies,
  externalDeliveryPartitions,
  externalAttachmentTransferJobs,
  externalOutboundDeliveries,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import {
  __resetMessageServiceDepsForTests, broadcastAndDeliver,
  drainSenderReadReceiptsForTests
} from "./messageService.js";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setSlackBridgeReconciliationMarkerMinterForTests,
  enqueueSlackBridgeOutboundDelivery,
  lockOrdinaryMessageExternalDeliveryAdmission,
  maybeEnqueueOrdinaryMessageExternalDelivery,
  mintSlackBridgeReconciliationMarker,
  projectSlackBridgeOutboundAdmissionFailure,
  projectSlackBridgeOutboundPipelineFailure,
  SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA,
  SlackBridgeOutboundAdmissionError,
  SlackBridgeOutboundPipelineError,
  type SlackBridgeOutboundAdmissionStage,
  type SlackBridgeOutboundPipelineStage,
  type ProviderNeutralOutboundRuntimeFact,
  type SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService.js";


const ELIGIBLE_ORDINARY_DECISION = {
  eligible: true,
  reason: "ordinary_chat",
} as const;

const noopOrchestrator = { deliverMessage: async () => undefined } as any;

function createIo() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
    },
  } as any;
}

beforeEach(async () => {
  await openTestDatabase("pglite://");
  __setSlackBridgeReconciliationMarkerMinterForTests(({ deliveryId }) =>
    mintSlackBridgeReconciliationMarker("test-only-separate-reconciliation-key", deliveryId)
  );
});

afterEach(async () => {
  __resetFailpointsForTests();
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
  __resetMessageServiceDepsForTests();
  await drainSenderReadReceiptsForTests();
  await closeTestDatabase();
});

async function seedOutboundFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `slack-outbox-${randomUUID()}@raft.test`,
    name: `slack-outbox-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Outbox Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [target] = await db.insert(users).values({
    email: `slack-outbox-target-${randomUUID()}@raft.test`,
    name: `slack-outbox-target-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Outbox Target",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Slack Outbox Test",
    slug: `slack-outbox-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: target.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `slack-outbox-channel-${randomUUID()}`,
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: target.id },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `slack-outbox-agent-${randomUUID().slice(0, 8)}`,
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  await db.insert(externalAuthorPolicies).values([
    {
      serverId: server.id,
      provider: "slack",
      appRegistrationId: "registration-outbox-1",
      installId: "install-outbox-1",
      bindingId: `binding-${channel.id}`,
      bindingEpoch: 7,
      authorType: "user",
      authorId: owner.id,
      displayName: owner.displayName ?? owner.name,
      fallbackKind: "human",
      consentRevision: 5,
      state: "granted",
    },
    {
      serverId: server.id,
      provider: "slack",
      appRegistrationId: "registration-outbox-1",
      installId: "install-outbox-1",
      bindingId: `binding-${channel.id}`,
      bindingEpoch: 7,
      authorType: "agent",
      authorId: agent.id,
      displayName: agent.name,
      fallbackKind: "agent",
      consentRevision: 5,
      state: "granted",
    },
  ]);
  return { owner, target, server, channel, agent };
}

function activeRuntime(
  fixture: Awaited<ReturnType<typeof seedOutboundFixture>>,
  runtimePredicateRevision = "runtime-revision-1",
): ProviderNeutralOutboundRuntimeFact {
  return {
    level: "top_level",
    authorityConversationId: fixture.channel.id,
    runtimePredicateRevision,
    bindingAuthority: {
      provider: "slack",
      environment: "test",
      appRegistrationId: "registration-outbox-1",
      installId: "install-outbox-1",
      workspaceId: "workspace-outbox-1",
      connectionEpoch: 2,
      bindingId: `binding-${fixture.channel.id}`,
      bindingEpoch: 7,
      memberRevision: 3,
      contextRevision: 4,
      consentRevision: 5,
      privacyClass: "public",
      raftChannelId: fixture.channel.id,
      providerAuthorityId: "workspace-outbox-1",
      providerConversationId: "provider-conversation-outbox-1",
    },
  };
}

async function insertSourceMessage(
  executor: DatabaseExecutor,
  fixture: Awaited<ReturnType<typeof seedOutboundFixture>>,
  content: string,
) {
  const [message] = await executor.insert(messages).values({
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    content,
    messageType: "chat",
  }).returning();
  return message;
}

function enqueueInput(
  executor: DatabaseExecutor,
  fixture: Awaited<ReturnType<typeof seedOutboundFixture>>,
  message: typeof messages.$inferSelect,
  runtimePredicateRevision = "runtime-revision-1",
) {
  return {
    executor,
    message,
    activeRuntime: activeRuntime(fixture, runtimePredicateRevision),
    canonicalConversationId: fixture.channel.id,
    senderType: "user" as const,
    senderId: fixture.owner.id,
    authorName: fixture.owner.displayName ?? fixture.owner.name,
    sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }: { deliveryId: string }) =>
      mintSlackBridgeReconciliationMarker("test-only-separate-reconciliation-key", deliveryId),
  };
}

async function seedJointOutboundFixture() {
  const fixture = await seedOutboundFixture();
  const db = getDb();
  const [storageServer] = await db.insert(servers).values({
    name: "Slack Outbox Joint Storage",
    slug: `slack-outbox-joint-storage-${randomUUID()}`,
    ownerId: fixture.owner.id,
  }).returning();
  const [canonicalChannel] = await db.insert(channels).values({
    serverId: storageServer.id,
    name: `slack-outbox-joint-canonical-${randomUUID()}`,
    type: "channel",
  }).returning();
  await db.update(channels).set({ type: "joint" }).where(eq(channels.id, fixture.channel.id));
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalChannel.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.server.id,
    localChannelId: fixture.channel.id,
    role: "host",
    status: "active",
    joinedByUserId: fixture.owner.id,
  });
  return { ...fixture, storageServer, canonicalChannel, joint };
}

function installAuthorizationResolver(fixture: Awaited<ReturnType<typeof seedOutboundFixture>>) {
  __setOrdinaryMessageOutboundAuthorizationResolverForTests(async ({ requestedChannelId, sourceText }) =>
    requestedChannelId === fixture.channel.id
      ? {
        activeRuntime: activeRuntime(fixture),
        canonicalConversationId: fixture.channel.id,
        sanitizedText: sourceText,
      }
      : null
  );
}

test("reconciliation marker has a purpose-bound known vector and closed format", () => {
  const deliveryId = "00000000-0000-4000-8000-000000000001";
  const marker = mintSlackBridgeReconciliationMarker("separate-test-key", deliveryId);
  assert.equal(marker, "FBwoI6zUeyDcYnsiVpejbO1aN2LrQnewtvB8S7ii45A");
  assert.match(marker, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(
    marker,
    mintSlackBridgeReconciliationMarker("separate-test-key", "00000000-0000-4000-8000-000000000002"),
  );
  assert.notEqual(
    marker,
    mintSlackBridgeReconciliationMarker("another-purpose-key", deliveryId),
  );
});

test("source message, FIFO position, and frozen outbox row roll back together", async () => {
  const fixture = await seedOutboundFixture();

  await assert.rejects(
    getDb().transaction(async (executor) => {
      const message = await insertSourceMessage(executor, fixture, "rollback me");
      const result = await enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message));
      assert.equal(result.delivery.partitionPosition, 1);
      throw new Error("fail after enqueue before source commit");
    }),
    /fail after enqueue before source commit/,
  );

  assert.equal((await getDb().select().from(messages)).length, 0);
  assert.equal((await getDb().select().from(externalDeliveryPartitions)).length, 0);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);

  const committed = await getDb().transaction(async (executor) => {
    const message = await insertSourceMessage(executor, fixture, "commit me once");
    await executor.insert(attachments).values({
      messageId: message.id,
      messagePosition: 0,
      channelId: fixture.channel.id,
      uploaderId: fixture.owner.id,
      uploaderType: "user",
      filename: "private-name.png",
      mimeType: "image/png",
      sizeBytes: 123,
      storageKey: "private/storage/key.png",
    });
    const result = await enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message));
    return { message, result };
  });
  assert.equal(committed.result.replayed, false);
  assert.equal(committed.result.delivery.partitionPosition, 1);
  assert.equal(committed.result.delivery.renderSnapshotSchema, SLACK_BRIDGE_RENDER_SNAPSHOT_SCHEMA);
  assert.equal(committed.result.delivery.renderSnapshotDigest.length, 64);
  const snapshot = committed.result.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  assert.equal(
    snapshot.sourcePermalink,
    `https://app.slock.ai/s/${fixture.server.slug}/channel/${fixture.channel.id}?msg=${committed.message.id}`,
  );
  assert.equal(snapshot.authorPolicy.serverId, fixture.server.id);
  assert.equal(snapshot.authorPolicy.displayName, fixture.owner.displayName);
  assert.equal(snapshot.authorPolicy.consentRevision, 5);
  assert.equal(snapshot.sanitizedText, "commit me once\n\n[Attachment not synced]");
  assert.equal(JSON.stringify(snapshot).includes("private-name.png"), false);
  assert.equal(JSON.stringify(snapshot).includes("private/storage/key.png"), false);
  assert.deepEqual(snapshot.externalMentions, []);
});

test("attachment child fuse freezes immutable objects and creates one transfer job per file", async () => {
  const fixture = await seedOutboundFixture();
  const committed = await getDb().transaction(async (executor) => {
    const message = await insertSourceMessage(executor, fixture, "send the file");
    const [object] = await executor.insert(attachmentObjects).values({
      originServerId: fixture.server.id,
      uploaderId: fixture.owner.id,
      uploaderType: "user",
      storageKey: `${fixture.server.id}/frozen.pdf`,
      contentHash: "a".repeat(64),
      mimeType: "application/pdf",
      sizeBytes: 4096,
    }).returning();
    const [attachment] = await executor.insert(attachments).values({
      objectId: object.id,
      messageId: message.id,
      messagePosition: 0,
      channelId: fixture.channel.id,
      uploaderId: fixture.owner.id,
      uploaderType: "user",
      filename: "frozen.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      storageKey: object.storageKey,
      contentHash: object.contentHash,
    }).returning();
    const baseInput = enqueueInput(executor, fixture, message);
    const result = await enqueueSlackBridgeOutboundDelivery({
      ...baseInput,
      activeRuntime: { ...baseInput.activeRuntime, attachmentTransferEnabled: true },
    });
    return { message, object, attachment, result };
  });
  const snapshot = committed.result.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  assert.equal(snapshot.schema, "slack-bridge-render-snapshot.v2");
  assert.equal(snapshot.sanitizedText, "send the file");
  assert.deepEqual(snapshot.attachments, [{
    sourceAttachmentId: committed.attachment.id,
    objectId: committed.object.id,
    originServerId: fixture.server.id,
    storageKey: committed.object.storageKey,
    filename: "frozen.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4096,
    contentDigest: "a".repeat(64),
    messagePosition: 0,
  }]);
  const [job] = await getDb().select().from(externalAttachmentTransferJobs);
  assert.equal(job.outboundDeliveryId, committed.result.delivery.id);
  assert.equal(job.sourceAttachmentId, committed.attachment.id);
  assert.equal(job.frozenObjectId, committed.object.id);
  assert.equal(job.frozenContentDigest, "a".repeat(64));
});

test("Joint host top-level render authority links the local projection while freezing canonical storage", async () => {
  const fixture = await seedJointOutboundFixture();
  assert.notEqual(fixture.canonicalChannel.serverId, fixture.server.id);
  const [message] = await getDb().insert(messages).values({
    channelId: fixture.canonicalChannel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    content: "joint host top-level outbound",
    messageType: "chat",
  }).returning();
  const result = await getDb().transaction((executor) => enqueueSlackBridgeOutboundDelivery({
    ...enqueueInput(executor, fixture, message),
    activeRuntime: {
      ...activeRuntime(fixture),
      authorityConversationId: fixture.channel.id,
    },
    canonicalConversationId: fixture.canonicalChannel.id,
  }));
  const snapshot = result.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  assert.equal(snapshot.canonicalConversationId, fixture.canonicalChannel.id);
  assert.equal(snapshot.authorPolicy.serverId, fixture.server.id);
  assert.equal(
    snapshot.sourcePermalink,
    `https://app.slock.ai/s/${fixture.server.slug}/channel/${fixture.channel.id}?msg=${message.id}`,
  );
});

test("Joint host thread render authority links the local parent while freezing canonical root storage", async () => {
  const fixture = await seedJointOutboundFixture();
  const [root] = await getDb().insert(messages).values({
    channelId: fixture.canonicalChannel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    content: "joint host root",
    messageType: "chat",
  }).returning();
  const [canonicalThread, localThread] = await getDb().insert(channels).values([{
    serverId: fixture.storageServer.id,
    name: `slack-outbox-joint-thread-canonical-${randomUUID()}`,
    type: "thread",
    parentMessageId: root.id,
  }, {
    serverId: fixture.server.id,
    name: `slack-outbox-joint-thread-local-${randomUUID()}`,
    type: "thread",
  }]).returning();
  await getDb().update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, root.id));
  const [threadJoint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: threadJoint.id,
    serverId: fixture.server.id,
    localChannelId: localThread.id,
    role: "host",
    status: "active",
    joinedByUserId: fixture.owner.id,
  });
  const [message] = await getDb().insert(messages).values({
    channelId: canonicalThread.id,
    senderType: "user",
    senderId: fixture.owner.id,
    content: "joint host thread outbound",
    messageType: "chat",
  }).returning();
  const result = await getDb().transaction((executor) => enqueueSlackBridgeOutboundDelivery({
    ...enqueueInput(executor, fixture, message),
    activeRuntime: {
      ...activeRuntime(fixture),
      level: "thread",
      authorityConversationId: localThread.id,
    },
    canonicalConversationId: canonicalThread.id,
    canonicalRootMessageId: root.id,
  }));
  const snapshot = result.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  assert.equal(snapshot.canonicalConversationId, canonicalThread.id);
  assert.equal(snapshot.canonicalRootMessageId, root.id);
  const params = new URLSearchParams({
    thread: `${fixture.channel.id}:${root.id}`,
    msg: message.id,
  });
  assert.equal(
    snapshot.sourcePermalink,
    `https://app.slock.ai/s/${fixture.server.slug}/channel/${fixture.channel.id}?${params.toString()}`,
  );
});

test("attachment marker overflow fails closed without truncating the source body", async () => {
  const fixture = await seedOutboundFixture();
  await assert.rejects(getDb().transaction(async (executor) => {
    const message = await insertSourceMessage(executor, fixture, "x".repeat(39_976));
    await executor.insert(attachments).values({
      messageId: message.id,
      messagePosition: 0,
      channelId: fixture.channel.id,
      uploaderId: fixture.owner.id,
      uploaderType: "user",
      filename: "overflow.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey: "private/overflow.png",
    });
    await enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message));
  }), /attachment marker exceeds the provider text limit/);
  assert.equal((await getDb().select().from(messages)).length, 0);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
});

test("direct replay reuses one logical delivery, marker, and FIFO position", async () => {
  const fixture = await seedOutboundFixture();
  let markerMints = 0;
  const message = await insertSourceMessage(getDb(), fixture, "direct replay");
  const countedInput = (executor: DatabaseExecutor) => ({
    ...enqueueInput(executor, fixture, message),
    mintReconciliationMarker: ({ deliveryId }: { deliveryId: string }) => {
      markerMints += 1;
      return mintSlackBridgeReconciliationMarker("test-only-separate-reconciliation-key", deliveryId);
    },
  });

  const first = await getDb().transaction((executor) =>
    enqueueSlackBridgeOutboundDelivery(countedInput(executor))
  );
  const replay = await getDb().transaction((executor) =>
    enqueueSlackBridgeOutboundDelivery(countedInput(executor))
  );

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.delivery.id, first.delivery.id);
  assert.equal(replay.delivery.reconciliationMarker, first.delivery.reconciliationMarker);
  assert.equal(markerMints, 1);
  assert.deepEqual(
    await getDb().select({
      last: externalDeliveryPartitions.lastEnqueuedPosition,
      cursor: externalDeliveryPartitions.cursorPosition,
    }).from(externalDeliveryPartitions),
    [{ last: 1, cursor: 0 }],
  );

  await assert.rejects(
    getDb().transaction((executor) =>
      enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message, "runtime-drift"))
    ),
    /conflicts with frozen enqueue authority/,
  );
});

test("concurrent logical replay allocates exactly one FIFO row", async () => {
  const fixture = await seedOutboundFixture();
  const message = await insertSourceMessage(getDb(), fixture, "concurrent replay");
  const results = await Promise.all([
    getDb().transaction((executor) =>
      enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message))
    ),
    getDb().transaction((executor) =>
      enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message))
    ),
  ]);

  assert.deepEqual(results.map(({ replayed }) => replayed).sort(), [false, true]);
  assert.equal(results[0]?.delivery.id, results[1]?.delivery.id);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 1);
});

test("paused source N holds admission so N+1 cannot overtake its FIFO position", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  let releaseFirst!: () => void;
  const firstMayEnqueue = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let signalFirstInserted!: () => void;
  const firstInserted = new Promise<void>((resolve) => { signalFirstInserted = resolve; });
  let secondAdmitted = false;

  const first = getDb().transaction(async (executor) => {
    await lockOrdinaryMessageExternalDeliveryAdmission({
      executor,
      authorityChannelId: fixture.channel.id,
      requestedChannelId: fixture.channel.id,
      canonicalConversationId: fixture.channel.id,
      decision: ELIGIBLE_ORDINARY_DECISION,
    });
    const message = await insertSourceMessage(executor, fixture, "source N");
    signalFirstInserted();
    await firstMayEnqueue;
    const result = await enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message));
    return { message, result };
  });

  await firstInserted;
  const second = getDb().transaction(async (executor) => {
    await lockOrdinaryMessageExternalDeliveryAdmission({
      executor,
      authorityChannelId: fixture.channel.id,
      requestedChannelId: fixture.channel.id,
      canonicalConversationId: fixture.channel.id,
      decision: ELIGIBLE_ORDINARY_DECISION,
    });
    secondAdmitted = true;
    const message = await insertSourceMessage(executor, fixture, "source N+1");
    const result = await enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message));
    return { message, result };
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondAdmitted, false);
  releaseFirst();
  const [firstCommitted, secondCommitted] = await Promise.all([first, second]);
  assert.ok(firstCommitted.message.seq < secondCommitted.message.seq);
  assert.deepEqual([
    firstCommitted.result.delivery.partitionPosition,
    secondCommitted.result.delivery.partitionPosition,
  ], [1, 2]);
});

test("outbound admission revalidates archived state after acquiring the conversation lock", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  await getDb().update(channels).set({ archivedAt: new Date() })
    .where(eq(channels.id, fixture.channel.id));

  await assert.rejects(
    getDb().transaction((executor) => lockOrdinaryMessageExternalDeliveryAdmission({
      executor,
      authorityChannelId: fixture.channel.id,
      requestedChannelId: fixture.channel.id,
      canonicalConversationId: fixture.channel.id,
      decision: ELIGIBLE_ORDINARY_DECISION,
    })),
    /conversation is unavailable/,
  );
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
});

test("outbound admission rejects an archived inherited authority before distinct request and storage rows", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  const [requestedThread, canonicalThread] = await getDb().insert(channels).values([
    {
      serverId: fixture.server.id,
      name: `requested-thread-${randomUUID()}`,
      type: "thread",
    },
    {
      serverId: fixture.server.id,
      name: `canonical-thread-${randomUUID()}`,
      type: "thread",
    },
  ]).returning();
  await getDb().update(channels).set({ archivedAt: new Date() })
    .where(eq(channels.id, fixture.channel.id));

  await assert.rejects(
    getDb().transaction((executor) => lockOrdinaryMessageExternalDeliveryAdmission({
      executor,
      authorityChannelId: fixture.channel.id,
      requestedChannelId: requestedThread.id,
      canonicalConversationId: canonicalThread.id,
      decision: ELIGIBLE_ORDINARY_DECISION,
    })),
    /conversation is unavailable/,
  );
});

test("message transaction rolls source, mention, inbox, partition, and outbox back together", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  const registry = new InMemoryFailpointRegistry();
  registry.configure("server.message.newChatTransaction.afterFacts", {
    mode: "once",
    effect: "throw",
    payload: "fail after source-derived facts and enqueue",
  });
  __setFailpointsForTests(registry);
  const content = `atomic bridge send @${fixture.target.name}`;

  await assert.rejects(
    broadcastAndDeliver(createIo(), noopOrchestrator, {
      channelId: fixture.channel.id,
      senderType: "user",
      senderId: fixture.owner.id,
      senderName: fixture.owner.displayName ?? fixture.owner.name,
      content,
    }),
    /fail after source-derived facts and enqueue/,
  );
  assert.deepEqual({
    messages: (await getDb().select().from(messages)).length,
    mentions: (await getDb().select().from(messageMentions)).length,
    inboxFacts: (await getDb().select().from(inboxNotificationFacts)).length,
    partitions: (await getDb().select().from(externalDeliveryPartitions)).length,
    deliveries: (await getDb().select().from(externalOutboundDeliveries)).length,
  }, { messages: 0, mentions: 0, inboxFacts: 0, partitions: 0, deliveries: 0 });

  const committed = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    senderName: fixture.owner.displayName ?? fixture.owner.name,
    content,
  });
  const [delivery] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(delivery?.sourceMessageId, committed.id);
  assert.equal(
    (delivery?.renderSnapshot as { sourceMessageSeq?: number } | undefined)?.sourceMessageSeq,
    committed.seq,
  );
  assert.deepEqual({
    messages: (await getDb().select().from(messages)).length,
    mentions: (await getDb().select().from(messageMentions)).length,
    inboxFacts: (await getDb().select().from(inboxNotificationFacts)).length,
    partitions: (await getDb().select().from(externalDeliveryPartitions)).length,
    deliveries: (await getDb().select().from(externalOutboundDeliveries)).length,
  }, { messages: 1, mentions: 1, inboxFacts: 3, partitions: 1, deliveries: 1 });
});

test("outbound admission exposes only a privacy-safe non-production stage", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  await getDb().update(externalAuthorPolicies).set({ state: "revoked" })
    .where(eq(externalAuthorPolicies.authorId, fixture.owner.id));

  let failure: unknown;
  try {
    await broadcastAndDeliver(createIo(), noopOrchestrator, {
      channelId: fixture.channel.id,
      senderType: "user",
      senderId: fixture.owner.id,
      senderName: fixture.owner.displayName ?? fixture.owner.name,
      content: "diagnostic stage only",
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof SlackBridgeOutboundAdmissionError);
  assert.equal(failure.stage, "render_authority");
  assert.ok(failure.cause instanceof Error);
  assert.equal(
    failure.cause.message,
    "Slack Bridge author consent or frozen display name is unavailable",
  );
  assert.deepEqual(projectSlackBridgeOutboundAdmissionFailure(failure, "test"), {
    code: "slack_bridge_outbound_admission_failed",
    phase: "render_authority",
  });
  assert.equal(projectSlackBridgeOutboundAdmissionFailure(failure, "production"), null);
  assert.equal((await getDb().select().from(messages)).length, 0);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);

  const stages: SlackBridgeOutboundAdmissionStage[] = [
    "conversation_lock",
    "source_insert",
    "source_replay_lookup",
    "inbox_state_reset",
    "attachment_link",
    "inbox_facts",
    "authorization_resolver",
    "render_authority",
    "partition_prepare",
    "replay_lookup",
    "marker_mint",
    "partition_advance",
    "delivery_insert",
  ];
  for (const stage of stages) {
    const projected = projectSlackBridgeOutboundAdmissionFailure(
      new SlackBridgeOutboundAdmissionError(stage, { cause: new Error("must remain private") }),
      "development",
    );
    assert.equal(projected?.phase, stage);
    assert.equal(JSON.stringify(projected).includes("must remain private"), false);
  }
});

test("outbound pipeline exposes only privacy-safe non-production phases", () => {
  const stages: SlackBridgeOutboundPipelineStage[] = [
    "channel_resolution",
    "archive_gate",
    "replay_facts_read",
    "frontend_channel_read",
    "frontend_projection_read",
    "frontend_max_seq",
    "frontend_payload_projection",
    "frontend_socket_emit",
    "frontend_emit",
  ];
  for (const stage of stages) {
    const error = new SlackBridgeOutboundPipelineError(stage, {
      cause: new Error("must remain private"),
    });
    assert.deepEqual(projectSlackBridgeOutboundPipelineFailure(error, "test"), {
      code: "slack_bridge_outbound_pipeline_failed",
      phase: stage,
    });
    assert.equal(projectSlackBridgeOutboundPipelineFailure(error, "production"), null);
    assert.equal(JSON.stringify(projectSlackBridgeOutboundPipelineFailure(error, "development")).includes("must remain private"), false);
  }
  assert.deepEqual(projectSlackBridgeOutboundPipelineFailure(
    new SlackBridgeOutboundPipelineError("frontend_socket_emit", {
      cause: new Error("must remain private"),
      topology: "ordinary_channel",
    }),
    "test",
  ), {
    code: "slack_bridge_outbound_pipeline_failed",
    phase: "frontend_socket_emit",
    topology: "ordinary_channel",
  });
});

test("real joint topology returns one durable fact when its joint Socket projection degrades", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  const db = getDb();
  const [peerServer] = await db.insert(servers).values({
    name: "Slack Outbox Joint Peer",
    slug: `slack-outbox-joint-${randomUUID()}`,
    ownerId: fixture.target.id,
  }).returning();
  await db.insert(serverMembers).values({
    serverId: peerServer.id,
    userId: fixture.target.id,
    role: "owner",
  });
  const [canonicalChannel, localChannel, peerLocalChannel] = await db.insert(channels).values([{
    serverId: fixture.server.id,
    name: `slack-outbox-joint-canonical-${randomUUID()}`,
    type: "joint",
  }, {
    serverId: fixture.server.id,
    name: `slack-outbox-joint-local-${randomUUID()}`,
    type: "joint",
  }, {
    serverId: peerServer.id,
    name: `slack-outbox-joint-peer-${randomUUID()}`,
    type: "joint",
  }]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalChannel.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([{
    jointChannelId: joint.id,
    serverId: fixture.server.id,
    localChannelId: localChannel.id,
    role: "host",
    status: "active",
    joinedByUserId: fixture.owner.id,
  }, {
    jointChannelId: joint.id,
    serverId: peerServer.id,
    localChannelId: peerLocalChannel.id,
    role: "participant",
    status: "active",
    joinedByUserId: fixture.target.id,
  }]);
  await db.insert(channelHumans).values({ channelId: localChannel.id, userId: fixture.owner.id });
  const request = {
    channelId: localChannel.id,
    senderType: "user" as const,
    senderId: fixture.owner.id,
    senderName: fixture.owner.displayName ?? fixture.owner.name,
    content: "joint frontend response diagnostic",
    randomId: "joint-frontend-response-diagnostic-001",
  };
  const failingIo = {
    ...createIo(),
    to() {
      return { emit() { throw new Error("private socket failure"); } };
    },
  } as any;

  const first = await broadcastAndDeliver(failingIo, noopOrchestrator, request);
  const replay = await broadcastAndDeliver(failingIo, noopOrchestrator, request);
  assert.deepEqual(replay, first);

  assert.equal((await db.select().from(messages).where(eq(messages.channelId, canonicalChannel.id))).length, 1);
  assert.equal((await db.select().from(externalDeliveryPartitions)).length, 0);
  assert.equal((await db.select().from(externalOutboundDeliveries)).length, 0);
});

test("ordinary Socket failure and same-randomId replay return one durable fact without duplicating outbound delivery", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  const request = {
    channelId: fixture.channel.id,
    senderType: "user" as const,
    senderId: fixture.owner.id,
    senderName: fixture.owner.displayName ?? fixture.owner.name,
    content: "ordinary frontend response diagnostic",
    randomId: "ordinary-frontend-response-diagnostic-001",
  };
  const failingIo = {
    ...createIo(),
    to() {
      return { emit() { throw new Error("private ordinary socket failure"); } };
    },
  } as any;

  const first = await broadcastAndDeliver(failingIo, noopOrchestrator, request);
  const replay = await broadcastAndDeliver(failingIo, noopOrchestrator, request);
  assert.deepEqual(replay, first);
  assert.equal(first.channelId, fixture.channel.id);

  assert.equal((await getDb().select().from(messages)).length, 1);
  assert.equal((await getDb().select().from(externalDeliveryPartitions)).length, 1);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 1);
});

test("ordinary payload failure and same-randomId replay keep one delivery with the production topology fingerprint", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  const registry = new InMemoryFailpointRegistry();
  registry.configure("server.message.frontend.payloadProjection", {
    mode: "always",
    effect: "throw",
    payload: "private payload projection failure",
  });
  __setFailpointsForTests(registry);
  const request = {
    channelId: fixture.channel.id,
    senderType: "user" as const,
    senderId: fixture.owner.id,
    senderName: fixture.owner.displayName ?? fixture.owner.name,
    content: "ordinary payload response diagnostic",
    randomId: "ordinary-payload-response-diagnostic-001",
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let failure: unknown;
    try {
      await broadcastAndDeliver(createIo(), noopOrchestrator, request);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof SlackBridgeOutboundPipelineError);
    assert.equal(failure.stage, "frontend_payload_projection");
    assert.equal(failure.topology, "ordinary_channel");
  }

  assert.deepEqual(registry.getTrace().map((entry) => entry.context), [{
    channelId: fixture.channel.id,
    messageId: (await getDb().select().from(messages))[0]!.id,
    topology: "ordinary_channel",
  }, {
    channelId: fixture.channel.id,
    messageId: (await getDb().select().from(messages))[0]!.id,
    topology: "ordinary_channel",
  }]);
  assert.equal((await getDb().select().from(messages)).length, 1);
  assert.equal((await getDb().select().from(externalDeliveryPartitions)).length, 1);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 1);
});

test("real ordinary thread topology returns one durable fact when its thread Socket projection degrades", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  const parent = await insertSourceMessage(getDb(), fixture, "ordinary thread parent");
  const thread = await getOrCreateThread(parent.id, fixture.owner.id, "user");
  const request = {
    channelId: thread.id,
    senderType: "user" as const,
    senderId: fixture.owner.id,
    senderName: fixture.owner.displayName ?? fixture.owner.name,
    content: "ordinary thread response diagnostic",
    randomId: "ordinary-thread-response-diagnostic-001",
  };
  const failingIo = {
    ...createIo(),
    to() {
      return { emit() { throw new Error("private ordinary thread socket failure"); } };
    },
  } as any;

  const first = await broadcastAndDeliver(failingIo, noopOrchestrator, request);
  const replay = await broadcastAndDeliver(failingIo, noopOrchestrator, request);
  assert.deepEqual(replay, first);
  assert.equal(first.channelId, thread.id);

  assert.equal((await getDb().select().from(messages).where(eq(messages.channelId, thread.id))).length, 1);
  assert.equal((await getDb().select().from(externalDeliveryPartitions)).length, 0);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
});

test("human randomId and agentSendKey replays preserve one delivery per winning source", async () => {
  const fixture = await seedOutboundFixture();
  installAuthorizationResolver(fixture);
  let markerMints = 0;
  __setSlackBridgeReconciliationMarkerMinterForTests(({ deliveryId }) => {
    markerMints += 1;
    return mintSlackBridgeReconciliationMarker("test-only-separate-reconciliation-key", deliveryId);
  });

  const humanRequest = {
    channelId: fixture.channel.id,
    senderType: "user" as const,
    senderId: fixture.owner.id,
    senderName: fixture.owner.displayName ?? fixture.owner.name,
    content: "idempotent human outbound",
    randomId: "bridge-human-random-id",
  };
  const firstHuman = await broadcastAndDeliver(createIo(), noopOrchestrator, humanRequest);
  const replayHuman = await broadcastAndDeliver(createIo(), noopOrchestrator, humanRequest);
  assert.equal(replayHuman.id, firstHuman.id);

  const agentRequest = {
    channelId: fixture.channel.id,
    senderType: "agent" as const,
    senderId: fixture.agent.id,
    senderName: fixture.agent.name,
    content: "idempotent agent outbound",
    agentSendKey: "bridge-agent-send-key",
  };
  const firstAgent = await broadcastAndDeliver(createIo(), noopOrchestrator, agentRequest);
  const replayAgent = await broadcastAndDeliver(createIo(), noopOrchestrator, agentRequest);
  assert.equal(replayAgent.id, firstAgent.id);

  const deliveries = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(deliveries.length, 2);
  assert.equal(markerMints, 2, "only winning source inserts mint markers");
  assert.deepEqual(
    deliveries
      .map(({ renderSnapshot, partitionPosition }) => [
        (renderSnapshot as { sourceMessageSeq: number }).sourceMessageSeq,
        partitionPosition,
      ])
      .sort(([left], [right]) => left - right),
    [
      [firstHuman.seq, 1],
      [firstAgent.seq, 2],
    ],
  );
});

test("missing production authority or marker dependency creates zero outbox rows", async () => {
  const fixture = await seedOutboundFixture();
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests();

  const withoutAuthority = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    senderName: fixture.owner.name,
    content: "ordinary source without authority",
  });
  assert.ok(withoutAuthority.id);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
  assert.equal((await getDb().select().from(externalDeliveryPartitions)).length, 0);

  installAuthorizationResolver(fixture);
  // Reset clears both seams; reinstall only the resolver to model missing key.
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
  __setOrdinaryMessageOutboundAuthorizationResolverForTests(async ({ sourceText }) => ({
    activeRuntime: activeRuntime(fixture),
    canonicalConversationId: fixture.channel.id,
    sanitizedText: sourceText,
  }));
  const withoutMarker = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    senderName: fixture.owner.name,
    content: "ordinary source without marker minter",
  });
  assert.ok(withoutMarker.id);
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
  assert.equal((await getDb().select().from(externalDeliveryPartitions)).length, 0);
});

test("excluded ordinary-projection decisions never consult authority", async () => {
  let calls = 0;
  __setOrdinaryMessageOutboundAuthorizationResolverForTests(async () => {
    calls += 1;
    throw new Error("excluded decision must not resolve authority");
  });
  const inertInput = {
    executor: {} as DatabaseExecutor,
    message: {} as typeof messages.$inferSelect,
    requestedChannelId: "channel-inert",
    senderType: "user" as const,
    senderId: "sender-inert",
    authorName: "Sender Inert",
    sourceText: "inert",
  };
  for (const decision of [
    { eligible: false as const, reason: "task" as const },
    { eligible: false as const, reason: "action_metadata" as const },
    { eligible: false as const, reason: "non_chat" as const },
    { eligible: false as const, reason: "unsupported_sender" as const },
  ]) {
    assert.equal(await maybeEnqueueOrdinaryMessageExternalDelivery({ ...inertInput, decision }), null);
  }
  assert.equal(calls, 0);
});

test("all atomic ordinary producers take admission before source insertion", () => {
  const messageService = fs.readFileSync(new URL("./messageService.ts", import.meta.url), "utf8");
  const agentReplayService = fs.readFileSync(new URL("./agentSendReplayService.ts", import.meta.url), "utf8");

  const userTransaction = messageService.indexOf("async function createOrReplayUserRandomSend");
  const userAdmission = messageService.indexOf("lockOrdinaryMessageExternalDeliveryAdmission", userTransaction);
  const userInsert = messageService.indexOf("const insertAttempt", userTransaction);
  assert.ok(userAdmission > userTransaction && userAdmission < userInsert);

  const agentCall = messageService.indexOf("createOrReplayAgentSend({");
  const agentAdmission = messageService.indexOf("beforeInsert:", agentCall);
  const agentFinalize = messageService.indexOf("onInserted:", agentCall);
  assert.ok(agentAdmission > agentCall && agentAdmission < agentFinalize);
  const helperTransaction = agentReplayService.indexOf("return db.transaction");
  const helperAdmission = agentReplayService.indexOf("if (opts.beforeInsert) await opts.beforeInsert(tx)", helperTransaction);
  const helperInsert = agentReplayService.indexOf(".insert(messages)", helperTransaction);
  assert.ok(helperAdmission > helperTransaction && helperAdmission < helperInsert);

  const directTransaction = messageService.indexOf('queryName: "messages.direct_send_transaction"');
  const directAdmission = messageService.indexOf("lockOrdinaryMessageExternalDeliveryAdmission", directTransaction);
  const directPersist = messageService.indexOf("return persistDirectSend(tx)", directAdmission);
  assert.ok(directAdmission > directTransaction && directAdmission < directPersist);
});

test("partition row lock precedes logical replay lookup", () => {
  const source = fs.readFileSync(new URL("./externalDeliveryOutboxService.ts", import.meta.url), "utf8");
  const partitionSelect = source.indexOf("const partition = await runSlackBridgeOutboundAdmissionStage");
  const rowLock = source.indexOf('.for("update")', partitionSelect);
  const replayLookup = source.indexOf("const existing = await runSlackBridgeOutboundAdmissionStage", partitionSelect);
  assert.ok(partitionSelect >= 0);
  assert.ok(rowLock > partitionSelect && rowLock < replayLookup);
});

test("schema constraints reject impossible evidence and lease shapes", async () => {
  const fixture = await seedOutboundFixture();
  const message = await insertSourceMessage(getDb(), fixture, "constraint source");
  const queued = await getDb().transaction((executor) =>
    enqueueSlackBridgeOutboundDelivery(enqueueInput(executor, fixture, message))
  );

  await assert.rejects(
    getDb().update(externalOutboundDeliveries).set({
      state: "accepted",
      providerMessageId: "1700000000.000100",
      acceptedAt: new Date(),
    }).where(eq(externalOutboundDeliveries.id, queued.delivery.id)),
  );
  await assert.rejects(
    getDb().update(externalOutboundDeliveries).set({ state: "dispatching" })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id)),
  );
  const [stillQueued] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(stillQueued?.state, "queued");
  assert.equal(stillQueued?.providerAttempts, 0);
});
