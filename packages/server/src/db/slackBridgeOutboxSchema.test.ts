import { dbTest as test } from "../test/integration/dbTest.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./index.js";
import { closeTestDatabase } from "../test/integration/database.js";
import {
  channels,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  messages,
  servers,
  users,
} from "./schema.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("Slack Bridge outbox schema closes FIFO, lease, attempt, decision, and link shapes", async ({ db: database }) => {

  const db = getDb();

  const [owner] = await db.insert(users).values({
    email: "slack-outbox-schema@test.invalid",
    name: "slackOutboxSchemaOwner",
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Slack Outbox Schema",
    slug: "slack-outbox-schema",
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "slack-outbox-schema",
    type: "channel",
  }).returning();
  const [sourceMessage] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "frozen outbound source",
    messageType: "chat",
  }).returning();

  const bindingId = "provider-neutral-binding-1";
  const bindingEpoch = 1;
  const marker = "A".repeat(43);
  const payloadFingerprint = "b".repeat(64);
  const renderSnapshotDigest = "c".repeat(64);

  const [partition] = await db.insert(externalDeliveryPartitions).values({
    bindingId,
    bindingEpoch,
  }).returning();
  assert.equal(partition.cursorPosition, 0);
  await assert.rejects(
    db.insert(externalDeliveryPartitions).values({
      bindingId: "invalid-cursor-binding",
      bindingEpoch,
      lastEnqueuedPosition: 0,
      cursorPosition: 1,
    }),
  );

  const deliveryValues = {
    sourceMessageId: sourceMessage.id,
    bindingId,
    bindingEpoch,
    partitionPosition: 1,
    enqueueRuntimeRevision: "runtime-revision-1",
    renderSnapshot: { text: "frozen outbound source" },
    renderSnapshotDigest,
    reconciliationMarker: marker,
  } as const;
  const [delivery] = await db.transaction(async (executor) => {
    await executor.update(externalDeliveryPartitions)
      .set({ lastEnqueuedPosition: 1 })
      .where(eq(externalDeliveryPartitions.id, partition.id));
    return executor.insert(externalOutboundDeliveries).values(deliveryValues).returning();
  });
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.providerAttempts, 0);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 0);

  const [tailMismatchSourceMessage] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "valid source must not occupy an unadvanced partition position",
    messageType: "chat",
  }).returning();
  await assert.rejects(
    db.insert(externalOutboundDeliveries).values({
      ...deliveryValues,
      sourceMessageId: tailMismatchSourceMessage.id,
      partitionPosition: 2,
      reconciliationMarker: "G".repeat(43),
    }),
  );
  await assert.rejects(
    db.update(externalDeliveryPartitions)
      .set({ lastEnqueuedPosition: 2 })
      .where(eq(externalDeliveryPartitions.id, partition.id)),
  );
  await assert.rejects(
    db.transaction(async (executor) => {
      await executor.update(externalDeliveryPartitions)
        .set({ lastEnqueuedPosition: 3 })
        .where(eq(externalDeliveryPartitions.id, partition.id));
      await executor.insert(externalOutboundDeliveries).values({
        ...deliveryValues,
        sourceMessageId: tailMismatchSourceMessage.id,
        partitionPosition: 3,
        reconciliationMarker: "H".repeat(43),
      });
    }),
  );
  assert.deepEqual(
    await db.select({ lastEnqueuedPosition: externalDeliveryPartitions.lastEnqueuedPosition })
      .from(externalDeliveryPartitions)
      .where(eq(externalDeliveryPartitions.id, partition.id)),
    [{ lastEnqueuedPosition: 1 }],
  );

  await assert.rejects(
    db.insert(externalOutboundDeliveries).values({
      ...deliveryValues,
      partitionPosition: 2,
      sourceMessageId: "00000000-0000-4000-8000-000000000099",
      reconciliationMarker: "D".repeat(43),
    }),
  );
  await assert.rejects(
    db.insert(externalOutboundDeliveries).values({
      ...deliveryValues,
      bindingId: "missing-partition-binding",
      partitionPosition: 2,
      reconciliationMarker: "E".repeat(43),
    }),
  );

  await assert.rejects(
    db.insert(externalOutboundDeliveries).values({
      ...deliveryValues,
      sourceMessageId: sourceMessage.id,
      bindingId: "invalid-marker-binding",
      partitionPosition: 2,
      reconciliationMarker: "public-uuid-is-not-a-marker",
    }),
  );
  await assert.rejects(
    db.update(externalOutboundDeliveries)
      .set({ state: "dispatching", leaseGeneration: 1 })
      .where(eq(externalOutboundDeliveries.id, delivery.id)),
  );

  const [decision] = await db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: delivery.id,
    bindingId,
    bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "user",
    actorId: owner.id,
    reason: "bounded duplicate risk accepted",
    duplicateRiskAcknowledged: true,
    dataLossAcknowledged: false,
    decisionRevision: 1,
  }).returning();
  await assert.rejects(
    db.insert(externalDeliveryOperatorDecisions).values({
      deliveryId: delivery.id,
      bindingId: "different-binding",
      bindingEpoch: 99,
      partitionPosition: 99,
      action: "retry_in_place",
      actorType: "user",
      actorId: owner.id,
      reason: "cross-row coordinate mismatch",
      duplicateRiskAcknowledged: true,
      dataLossAcknowledged: false,
      decisionRevision: 2,
    }),
  );
  await assert.rejects(
    db.insert(externalDeliveryOperatorDecisions).values({
      deliveryId: delivery.id,
      bindingId,
      bindingEpoch,
      partitionPosition: 1,
      action: "skip",
      actorType: "user",
      actorId: owner.id,
      reason: "missing data-loss acknowledgement",
      duplicateRiskAcknowledged: false,
      dataLossAcknowledged: false,
      decisionRevision: 2,
    }),
  );

  const [skipDecision] = await db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: delivery.id,
    bindingId,
    bindingEpoch,
    partitionPosition: 1,
    action: "skip",
    actorType: "user",
    actorId: owner.id,
    reason: "bounded data loss accepted",
    duplicateRiskAcknowledged: false,
    dataLossAcknowledged: true,
    decisionRevision: 3,
  }).returning();

  const [secondSourceMessage] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "second frozen outbound source",
    messageType: "chat",
  }).returning();
  const secondBindingId = "provider-neutral-binding-2";
  const [secondPartition] = await db.insert(externalDeliveryPartitions).values({
    bindingId: secondBindingId,
    bindingEpoch,
  }).returning();
  const [secondDelivery] = await db.transaction(async (executor) => {
    await executor.update(externalDeliveryPartitions)
      .set({ lastEnqueuedPosition: 1 })
      .where(eq(externalDeliveryPartitions.id, secondPartition.id));
    return executor.insert(externalOutboundDeliveries).values({
      ...deliveryValues,
      sourceMessageId: secondSourceMessage.id,
      bindingId: secondBindingId,
      reconciliationMarker: "F".repeat(43),
    }).returning();
  });
  const [secondDecision] = await db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: secondDelivery.id,
    bindingId: secondBindingId,
    bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "user",
    actorId: owner.id,
    reason: "second bounded duplicate risk accepted",
    duplicateRiskAcknowledged: true,
    dataLossAcknowledged: false,
    decisionRevision: 1,
  }).returning();

  const startedAt = new Date("2026-08-03T08:00:00.000Z");
  const [attempt] = await db.insert(externalDeliveryAttempts).values({
    deliveryId: delivery.id,
    attemptNumber: 1,
    leaseGeneration: 1,
    runtimeRevision: "runtime-revision-1",
    credentialRevision: 1,
    dispatchAuthorization: "audited_retry_in_place",
    operatorDecisionId: decision.id,
    operatorDecisionAction: "retry_in_place",
    providerIoStartedAt: startedAt,
    outcome: "provider_io_started",
  }).returning();
  assert.equal(attempt.terminalAt, null);
  await assert.rejects(
    db.insert(externalDeliveryAttempts).values({
      deliveryId: delivery.id,
      attemptNumber: 2,
      leaseGeneration: 2,
      runtimeRevision: "runtime-revision-1",
      credentialRevision: 1,
      dispatchAuthorization: "audited_retry_in_place",
      operatorDecisionId: secondDecision.id,
      operatorDecisionAction: "retry_in_place",
      providerIoStartedAt: startedAt,
    }),
  );
  await assert.rejects(
    db.insert(externalDeliveryAttempts).values({
      deliveryId: delivery.id,
      attemptNumber: 2,
      leaseGeneration: 2,
      runtimeRevision: "runtime-revision-1",
      credentialRevision: 1,
      dispatchAuthorization: "audited_retry_in_place",
      operatorDecisionId: skipDecision.id,
      operatorDecisionAction: "retry_in_place",
      providerIoStartedAt: startedAt,
    }),
  );
  await assert.rejects(
    db.insert(externalDeliveryAttempts).values({
      deliveryId: delivery.id,
      attemptNumber: 2,
      leaseGeneration: 2,
      runtimeRevision: "runtime-revision-1",
      credentialRevision: 1,
      dispatchAuthorization: "automatic",
      providerIoStartedAt: startedAt,
      outcome: "rate_limited",
      outcomeReason: "rate_limited",
      terminalAt: startedAt,
      retryAfterMs: null,
    }),
  );

  const [link] = await db.insert(externalMessageLinks).values({
    deliveryId: delivery.id,
    provider: "slack",
    installId: "install-1",
    providerAuthorityId: "workspace-1",
    providerConversationId: "channel-1",
    providerMessageId: null,
    bindingId,
    bindingEpoch,
    connectionEpoch: 1,
    raftMessageId: sourceMessage.id,
    firstDirection: "raft_outbound",
    payloadFingerprint,
    outcomeState: "unknown",
    authorityState: "active",
  }).returning();
  assert.equal(link.providerMessageId, null);
  await assert.rejects(
    db.insert(externalMessageLinks).values({
      deliveryId: secondDelivery.id,
      provider: "slack",
      installId: "install-2",
      providerAuthorityId: "workspace-2",
      providerConversationId: "channel-2",
      providerMessageId: null,
      bindingId: secondBindingId,
      bindingEpoch,
      connectionEpoch: 1,
      raftMessageId: sourceMessage.id,
      firstDirection: "raft_outbound",
      payloadFingerprint,
      outcomeState: "unknown",
      authorityState: "active",
    }),
  );
  await assert.rejects(
    db.insert(externalMessageLinks).values({
      provider: "slack",
      installId: "install-2",
      providerAuthorityId: "workspace-1",
      providerConversationId: "channel-1",
      providerMessageId: "1710000000.000001",
      bindingId: "different-binding",
      bindingEpoch,
      connectionEpoch: 1,
      raftMessageId: sourceMessage.id,
      firstDirection: "raft_outbound",
      payloadFingerprint,
      outcomeState: "unknown",
      authorityState: "active",
    }),
  );
});
