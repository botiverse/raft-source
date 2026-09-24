import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { SLACK_BRIDGE_MAX_DELIVERY_AGE_MS } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalAuthorPolicies,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalMentionFacts,
  externalOutboundDeliveries,
  messages,
  servers,
  users,
} from "../db/schema.js";
import { createOutboundExternalAttachmentTransferWithExecutor } from "./externalAttachmentTransferService.js";
import type {
  ProviderNeutralOutboundBindingAuthority,
  SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService.js";
import { digestSlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService.js";
import {
  __setExternalDeliveryAcceptedTransactionHookForTests,
  __setExternalDeliveryAttemptRowLockHookForTests,
  consumeExternalDeliverySkipDecision,
  EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS,
  EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_MAX_MS,
  EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS,
  processExternalDeliveryPartitionHead,
  type ActiveExternalDeliveryRuntime,
  type ExternalDeliveryProviderResult,
  type ExternalDeliveryWorkerDependencies,
} from "./externalDeliveryWorkerService.js";


const NOW = new Date("2026-08-03T12:00:00.000Z");

beforeEach(async () => {
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  __setExternalDeliveryAcceptedTransactionHookForTests(null);
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  await closeTestDatabase();
});

function authority(bindingId: string, bindingEpoch: number, raftChannelId: string): ProviderNeutralOutboundBindingAuthority {
  return {
    provider: "provider-test",
    environment: "test",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    connectionEpoch: 4,
    bindingId,
    bindingEpoch,
    memberRevision: 5,
    contextRevision: 6,
    consentRevision: 7,
    privacyClass: "public",
    raftChannelId,
    providerAuthorityId: "authority-1",
    providerConversationId: "conversation-1",
  };
}

async function seedFixture(positionCount = 1) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `worker-${randomUUID()}@test.invalid`,
    name: `worker-${randomUUID()}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "External Worker",
    slug: `external-worker-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `external-worker-${randomUUID()}`,
    type: "channel",
  }).returning();
  const sourceMessages = await db.insert(messages).values(
    Array.from({ length: positionCount }, (_, index) => ({
      channelId: channel.id,
      senderType: "user" as const,
      senderId: owner.id,
      content: `source ${index + 1}`,
      messageType: "chat" as const,
    })),
  ).returning();
  const bindingId = `binding-${randomUUID()}`;
  const bindingEpoch = 3;
  const frozenAuthority = authority(bindingId, bindingEpoch, channel.id);
  const [authorPolicy] = await db.insert(externalAuthorPolicies).values({
    serverId: server.id,
    provider: frozenAuthority.provider,
    appRegistrationId: frozenAuthority.appRegistrationId,
    installId: frozenAuthority.installId,
    bindingId,
    bindingEpoch,
    authorType: "user",
    authorId: owner.id,
    displayName: "Worker Owner",
    fallbackKind: "human",
    consentRevision: frozenAuthority.consentRevision,
    state: "granted",
  }).returning();
  const [partition] = await db.insert(externalDeliveryPartitions).values({
    bindingId,
    bindingEpoch,
  }).returning();
  const deliveries = await db.transaction(async (executor) => {
    await executor.update(externalDeliveryPartitions).set({
      lastEnqueuedPosition: positionCount,
    }).where(eq(externalDeliveryPartitions.id, partition.id));
    return executor.insert(externalOutboundDeliveries).values(sourceMessages.map((message, index) => {
      const snapshot: SlackBridgeRenderSnapshot = {
        schema: "slack-bridge-render-snapshot.v2",
        sourceMessageId: message.id,
        sourceMessageSeq: message.seq,
        canonicalConversationId: channel.id,
        level: "top_level",
        canonicalRootMessageId: null,
        sourcePermalink: `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=${message.id}`,
        senderType: "user",
        senderId: owner.id,
        authorName: "Worker Owner",
        authorAvatarDigest: null,
        authorPolicy: {
          policyId: authorPolicy.id,
          serverId: server.id,
          consentRevision: frozenAuthority.consentRevision,
          displayName: "Worker Owner",
          fallbackKind: "human",
          avatar: null,
        },
        sanitizedText: message.content,
        externalMentions: [],
        attachments: [],
        bindingAuthority: frozenAuthority,
        enqueueRuntimeRevision: "runtime-r1",
      };
      return {
        sourceMessageId: message.id,
        bindingId,
        bindingEpoch,
        partitionPosition: index + 1,
        enqueueRuntimeRevision: "runtime-r1",
        renderSnapshotSchema: snapshot.schema,
        renderSnapshot: snapshot as unknown as Record<string, unknown>,
        renderSnapshotDigest: String(index + 1).repeat(64),
        reconciliationMarker: String.fromCharCode(65 + index).repeat(43),
      };
    })).returning();
  });
  return { db, owner, server, channel, sourceMessages, bindingId, bindingEpoch, frozenAuthority, partition, deliveries };
}

function dependencies(input: {
  runtime?: ActiveExternalDeliveryRuntime | null;
  credential?: boolean;
  providerResult?: ExternalDeliveryProviderResult;
  throwProvider?: boolean;
  calls?: { runtime: number; credential: number; provider: number };
  now?: Date;
}): ExternalDeliveryWorkerDependencies {
  const calls = input.calls ?? { runtime: 0, credential: 0, provider: 0 };
  const runtime = input.runtime;
  return {
    now: () => input.now ?? NOW,
    jitterUnit: () => 0.5,
    async resolveCurrentRuntime() {
      calls.runtime += 1;
      return runtime ?? null;
    },
    async leaseCredential({ runtime: current }) {
      calls.credential += 1;
      if (input.credential === false) return null;
      const auth = current.bindingAuthority;
      return {
        handle: { opaque: true },
        credentialRevision: 9,
        runtimeRevision: current.runtimeRevision,
        provider: auth.provider,
        installId: auth.installId,
        providerAuthorityId: auth.providerAuthorityId,
        providerConversationId: auth.providerConversationId,
        connectionEpoch: auth.connectionEpoch,
        bindingId: auth.bindingId,
        bindingEpoch: auth.bindingEpoch,
      };
    },
    async dispatchProvider() {
      calls.provider += 1;
      if (input.throwProvider) throw new Error("secret-shaped raw provider failure");
      return input.providerResult ?? {
        kind: "accepted",
        providerMessageId: "provider-message-1",
      };
    },
  };
}

function activeRuntime(fixture: Awaited<ReturnType<typeof seedFixture>>): ActiveExternalDeliveryRuntime {
  return {
    runtimeRevision: "runtime-r1",
    bindingAuthority: fixture.frozenAuthority,
  };
}

function workerInput(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  deps: ExternalDeliveryWorkerDependencies | null,
  retryDecisionId?: string,
) {
  return {
    db: fixture.db,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    leaseOwner: "worker-1",
    dependencies: deps,
    retryDecisionId,
  };
}

test("production-disabled worker performs zero authority, credential, and provider calls", async () => {
  const fixture = await seedFixture();
  assert.deepEqual(await processExternalDeliveryPartitionHead(workerInput(fixture, null)), {
    kind: "disabled",
  });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.leaseGeneration, 0);
});

test("accepted outcome atomically closes attempt, link, delivery, and exact cursor", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
    providerResult: {
      kind: "accepted",
      providerMessageId: "1710000000.000001",
      providerThreadId: "1710000000.000000",
    },
  })));
  assert.deepEqual(result, {
    kind: "attempted",
    deliveryId: fixture.deliveries[0].id,
    attemptNumber: 1,
    outcome: "accepted",
    deliveryState: "accepted",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 1 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.providerAttempts, 1);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 1);
  assert.equal(delivery.providerMessageId, "1710000000.000001");
  assert.equal(delivery.leaseOwner, null);
  const [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.outcome, "accepted");
  assert.equal(attempt.dispatchAuthorization, "automatic");
  const [link] = await fixture.db.select().from(externalMessageLinks);
  assert.equal(link.outcomeState, "accepted");
  assert.equal(link.payloadFingerprint, fixture.deliveries[0].renderSnapshotDigest);
  assert.equal(link.providerAuthorityId, fixture.frozenAuthority.providerAuthorityId);
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 1);
});

test("accepted attachment outcome atomically links its asset facts before advancing the cursor", async () => {
  const fixture = await seedFixture();
  const body = Buffer.from("worker attachment", "utf8");
  const digest = createHash("sha256").update(body).digest("hex");
  const [object] = await fixture.db.insert(attachmentObjects).values({
    originServerId: fixture.server.id,
    uploaderId: fixture.owner.id,
    uploaderType: "user",
    storageKey: `${fixture.server.id}/worker-attachment.txt`,
    contentHash: digest,
    mimeType: "text/plain",
    sizeBytes: body.length,
  }).returning();
  const [attachment] = await fixture.db.insert(attachments).values({
    objectId: object.id,
    messageId: fixture.sourceMessages[0]!.id,
    messagePosition: 0,
    channelId: fixture.channel.id,
    uploaderId: fixture.owner.id,
    uploaderType: "user",
    filename: "worker-attachment.txt",
    mimeType: object.mimeType,
    sizeBytes: object.sizeBytes,
    storageKey: object.storageKey,
    contentHash: digest,
  }).returning();
  const original = fixture.deliveries[0]!.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  const snapshot: SlackBridgeRenderSnapshot = {
    ...original,
    attachments: [{
      sourceAttachmentId: attachment.id,
      objectId: object.id,
      originServerId: fixture.server.id,
      storageKey: object.storageKey,
      filename: attachment.filename,
      mimeType: object.mimeType,
      sizeBytes: object.sizeBytes,
      contentDigest: digest,
      messagePosition: 0,
    }],
  };
  await fixture.db.update(externalOutboundDeliveries).set({
    renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot),
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0]!.id));
  const { job } = await createOutboundExternalAttachmentTransferWithExecutor(fixture.db, {
    outboundDeliveryId: fixture.deliveries[0]!.id,
    sourceAttachmentId: attachment.id,
  }, NOW);
  const [asset] = await fixture.db.insert(externalAttachmentAssets).values({
    originDirection: "raft_outbound",
    provider: fixture.frozenAuthority.provider,
    appRegistrationId: fixture.frozenAuthority.appRegistrationId,
    installId: fixture.frozenAuthority.installId,
    workspaceId: fixture.frozenAuthority.workspaceId,
    providerAuthorityId: fixture.frozenAuthority.providerAuthorityId,
    providerFileId: "provider-file-worker",
    filename: attachment.filename,
    declaredSizeBytes: object.sizeBytes,
    mimeType: object.mimeType,
    sourceContentDigest: digest,
    raftObjectId: object.id,
    state: "metadata_ready",
  }).returning();
  await fixture.db.update(externalAttachmentTransferJobs).set({
    assetId: asset.id,
    phase: "correlate",
    state: "outcome_unknown",
    nextAttemptAt: NOW,
    lastErrorClass: "attachment_completion_started",
  }).where(eq(externalAttachmentTransferJobs.id, job.id));

  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: { ...activeRuntime(fixture), attachmentTransferEnabled: true },
    providerResult: { kind: "accepted", providerMessageId: "1710000000.000099" },
  })));
  assert.equal(result.kind, "attempted");
  const [fact] = await fixture.db.select().from(externalAttachmentMessageFacts);
  const [closedJob] = await fixture.db.select().from(externalAttachmentTransferJobs);
  const [closedAsset] = await fixture.db.select().from(externalAttachmentAssets);
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(fact?.state, "linked");
  assert.equal(fact?.attachmentProjectionId, attachment.id);
  assert.equal(closedJob?.state, "completed");
  assert.equal(closedJob?.phase, "link");
  assert.equal(closedAsset?.state, "linked");
  assert.equal(partition?.cursorPosition, 1);
});

test("runtime mismatch releases the exact origin before credential access", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const mismatch = activeRuntime(fixture);
  mismatch.bindingAuthority = { ...mismatch.bindingAuthority, connectionEpoch: 999 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: mismatch,
    calls,
  })));
  assert.deepEqual(result, {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "runtime_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: "2026-08-03T12:00:05.000Z",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.providerAttempts, 0);
  assert.equal(delivery.leaseOwner, null);
  assert.equal(
    delivery.stateReason,
    "authority_retry:runtime_authority_inactive_or_mismatched",
  );
});

test("authority block uses durable exponential backoff without repeated dependency churn", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    createdAt: NOW,
    updatedAt: NOW,
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };

  const first = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
    now: NOW,
  })));
  assert.deepEqual(first, {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "runtime_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS).toISOString(),
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });

  const beforeDue = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
    now: NOW,
  })));
  assert.deepEqual(beforeDue, {
    kind: "blocked",
    reason: "authority_backoff_not_due",
    deliveryId: fixture.deliveries[0].id,
  });
  let [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.leaseGeneration, 1);
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });

  const dueAt = new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS);
  const second = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
    now: dueAt,
  })));
  assert.deepEqual(second, {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "runtime_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: new Date(dueAt.getTime() + (2 * EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS)).toISOString(),
  });
  [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.leaseGeneration, 2);
  assert.deepEqual(calls, { runtime: 2, credential: 0, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("authority block retry delay is capped at the bounded maximum", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    createdAt: NOW,
    updatedAt: NOW,
    leaseGeneration: 100,
    stateReason: "authority_retry:runtime_authority_inactive_or_mismatched",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };

  const beforeCap = new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_MAX_MS - 1);
  assert.deepEqual(await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
    now: beforeCap,
  }))), {
    kind: "blocked",
    reason: "authority_backoff_not_due",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });

  const dueAt = new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_MAX_MS);
  const due = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
    now: dueAt,
  })));
  assert.equal(due.kind, "authority_blocked");
  if (due.kind !== "authority_blocked") return;
  assert.equal(due.severity, "retrying");
  assert.equal(
    due.nextRetryAt,
    new Date(dueAt.getTime() + EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_MAX_MS).toISOString(),
  );
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
});

test("authority restored at the overdue threshold dispatches instead of emitting a stale overdue alert", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    createdAt: NOW,
    updatedAt: NOW,
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));

  const staleCalls = { runtime: 0, credential: 0, provider: 0 };
  const first = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls: staleCalls,
    now: NOW,
  })));
  assert.equal(first.kind, "authority_blocked");
  if (first.kind !== "authority_blocked") return;
  assert.equal(first.severity, "retrying");
  assert.deepEqual(staleCalls, { runtime: 1, credential: 0, provider: 0 });

  const restoredCalls = { runtime: 0, credential: 0, provider: 0 };
  const recovered = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls: restoredCalls,
    now: new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS),
  })));
  assert.deepEqual(recovered, {
    kind: "attempted",
    deliveryId: fixture.deliveries[0].id,
    attemptNumber: 1,
    outcome: "accepted",
    deliveryState: "accepted",
  });
  assert.deepEqual(restoredCalls, { runtime: 1, credential: 1, provider: 1 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "accepted");
  assert.equal(delivery.stateReason, "provider_accepted");
});

test("authority restored at the terminal threshold dispatches instead of quarantining the valid head", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    createdAt: NOW,
    updatedAt: NOW,
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));

  const staleCalls = { runtime: 0, credential: 0, provider: 0 };
  const first = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls: staleCalls,
    now: NOW,
  })));
  assert.equal(first.kind, "authority_blocked");
  if (first.kind !== "authority_blocked") return;
  assert.equal(first.severity, "retrying");
  assert.deepEqual(staleCalls, { runtime: 1, credential: 0, provider: 0 });

  const restoredCalls = { runtime: 0, credential: 0, provider: 0 };
  const recovered = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls: restoredCalls,
    now: new Date(NOW.getTime() + SLACK_BRIDGE_MAX_DELIVERY_AGE_MS),
  })));
  assert.deepEqual(recovered, {
    kind: "attempted",
    deliveryId: fixture.deliveries[0].id,
    attemptNumber: 1,
    outcome: "accepted",
    deliveryState: "accepted",
  });
  assert.deepEqual(restoredCalls, { runtime: 1, credential: 1, provider: 1 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "accepted");
  assert.equal(delivery.stateReason, "provider_accepted");
});

test("overdue stale authority emits one typed visible alert and still performs zero provider I/O", async () => {
  const fixture = await seedFixture();
  const createdAt = new Date(NOW.getTime() - EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS);
  await fixture.db.update(externalOutboundDeliveries).set({ createdAt, updatedAt: createdAt })
    .where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };

  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
  })));
  assert.deepEqual(result, {
    kind: "authority_blocked",
    severity: "overdue",
    reason: "runtime_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: "2026-08-03T12:00:05.000Z",
    alert: {
      schema: "external-delivery-authority-alert.v1",
      severity: "overdue",
      deliveryId: fixture.deliveries[0].id,
      bindingId: fixture.bindingId,
      bindingEpoch: fixture.bindingEpoch,
      partitionPosition: 1,
      blockReason: "runtime_authority_inactive_or_mismatched",
      observedAt: NOW.toISOString(),
      deliveryAgeMs: EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS,
      requiredAction: "restore_authority_or_audited_skip",
    },
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(
    delivery.stateReason,
    "authority_overdue:runtime_authority_inactive_or_mismatched",
  );

  const beforeDue = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
  })));
  assert.deepEqual(beforeDue, {
    kind: "blocked",
    reason: "authority_backoff_not_due",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });

  const dueAt = new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS);
  const repeated = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
    now: dueAt,
  })));
  assert.equal(repeated.kind, "authority_blocked");
  if (repeated.kind !== "authority_blocked") return;
  assert.equal(repeated.severity, "overdue");
  assert.equal(repeated.alert, undefined, "an unchanged overdue condition alerts only on transition");
  assert.deepEqual(calls, { runtime: 2, credential: 0, provider: 0 });
});

test("terminal stale-authority head needs an owned audited skip before a later valid delivery advances", async () => {
  const fixture = await seedFixture(2);
  const createdAt = new Date(NOW.getTime() - SLACK_BRIDGE_MAX_DELIVERY_AGE_MS);
  await fixture.db.update(externalOutboundDeliveries).set({ createdAt, updatedAt: createdAt })
    .where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const staleCalls = { runtime: 0, credential: 0, provider: 0 };

  const blocked = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls: staleCalls,
  })));
  assert.equal(blocked.kind, "authority_blocked");
  if (blocked.kind !== "authority_blocked") return;
  assert.equal(blocked.severity, "terminal");
  assert.equal(blocked.nextRetryAt, null);
  assert.equal(blocked.alert?.severity, "terminal");
  assert.equal(blocked.alert?.deliveryAgeMs, SLACK_BRIDGE_MAX_DELIVERY_AGE_MS);
  assert.equal(blocked.alert?.requiredAction, "audited_skip_required");
  assert.deepEqual(staleCalls, { runtime: 1, credential: 0, provider: 0 });
  let [head] = await fixture.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  assert.equal(head.state, "quarantined");
  assert.equal(head.stateReason, "authority_terminal:runtime_authority_inactive_or_mismatched");

  const [decision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "skip",
    actorType: "user",
    actorId: fixture.owner.id,
    reason: "owner accepts exact stale-authority head loss",
    dataLossAcknowledged: true,
    decisionRevision: 1,
  }).returning();
  assert.deepEqual(await consumeExternalDeliverySkipDecision({
    db: fixture.db,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    decisionId: decision.id,
    now: NOW,
  }), { kind: "skipped", deliveryId: fixture.deliveries[0].id });
  const [consumed] = await fixture.db.select().from(externalDeliveryOperatorDecisions)
    .where(eq(externalDeliveryOperatorDecisions.id, decision.id));
  assert.equal(consumed.actorType, "user");
  assert.equal(consumed.actorId, fixture.owner.id);
  assert.equal(consumed.reason, "owner accepts exact stale-authority head loss");
  assert.equal(consumed.consumedLeaseGeneration, 2);

  const validCalls = { runtime: 0, credential: 0, provider: 0 };
  const advanced = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls: validCalls,
  })));
  assert.equal(advanced.kind, "attempted");
  if (advanced.kind !== "attempted") return;
  assert.equal(advanced.deliveryId, fixture.deliveries[1].id);
  assert.equal(advanced.outcome, "accepted");
  assert.deepEqual(validCalls, { runtime: 1, credential: 1, provider: 1 });
  [head] = await fixture.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  assert.equal(head.state, "skipped");
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 2);
});

test("frozen render snapshot parser rejects unknown provider fields before authority access", async () => {
  const fixture = await seedFixture();
  const snapshot = {
    ...(fixture.deliveries[0].renderSnapshot as unknown as SlackBridgeRenderSnapshot),
    providerRawPayload: "must-not-cross",
  };
  await fixture.db.update(externalOutboundDeliveries).set({
    renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot as SlackBridgeRenderSnapshot),
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "invalid_frozen_snapshot",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("revoked frozen author consent blocks before credential or provider access", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalAuthorPolicies).set({ state: "revoked" })
    .where(eq(externalAuthorPolicies.authorId, fixture.owner.id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.deepEqual(result, {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "frozen_render_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: "2026-08-03T12:00:05.000Z",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.leaseOwner, null);
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("stale frozen mention addressability blocks before credential or provider access", async () => {
  const fixture = await seedFixture();
  const [actor] = await fixture.db.insert(externalActorProjections).values({
    provider: fixture.frozenAuthority.provider,
    appRegistrationId: fixture.frozenAuthority.appRegistrationId,
    installId: fixture.frozenAuthority.installId,
    workspaceId: fixture.frozenAuthority.workspaceId,
    externalActorId: "external-mentioned-actor",
    displayName: "Mentioned Actor",
    handles: ["mentioned"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 2,
    observedAt: new Date(NOW.getTime() - 1_000),
  }).returning();
  const [addressability] = await fixture.db.insert(externalAddressabilityProjections).values({
    projectionId: actor.id,
    provider: fixture.frozenAuthority.provider,
    appRegistrationId: fixture.frozenAuthority.appRegistrationId,
    installId: fixture.frozenAuthority.installId,
    workspaceId: fixture.frozenAuthority.workspaceId,
    connectionEpoch: fixture.frozenAuthority.connectionEpoch,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    conversationId: fixture.frozenAuthority.providerConversationId,
    memberRevision: fixture.frozenAuthority.memberRevision,
    contextRevision: fixture.frozenAuthority.contextRevision,
    state: "active",
    observedAt: new Date(NOW.getTime() - 1_000),
    expiresAt: new Date(NOW.getTime() + 60_000),
  }).returning();
  const [mentionFact] = await fixture.db.insert(externalMentionFacts).values({
    messageId: fixture.sourceMessages[0].id,
    projectionId: actor.id,
    provider: fixture.frozenAuthority.provider,
    appRegistrationId: fixture.frozenAuthority.appRegistrationId,
    installId: fixture.frozenAuthority.installId,
    workspaceId: fixture.frozenAuthority.workspaceId,
    externalActorId: actor.externalActorId,
    connectionEpoch: fixture.frozenAuthority.connectionEpoch,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    conversationId: fixture.frozenAuthority.providerConversationId,
    memberRevision: fixture.frozenAuthority.memberRevision,
    contextRevision: fixture.frozenAuthority.contextRevision,
    freshnessObservedAt: addressability.observedAt,
    freshnessExpiresAt: addressability.expiresAt,
    handleAtSendTime: "mentioned",
    resolutionReason: "explicit_projection",
  }).returning();
  const snapshot = fixture.deliveries[0].renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  snapshot.externalMentions = [{
    projectionId: mentionFact.projectionId,
    provider: mentionFact.provider,
    appRegistrationId: mentionFact.appRegistrationId,
    installId: mentionFact.installId,
    workspaceId: mentionFact.workspaceId,
    externalActorId: mentionFact.externalActorId,
    connectionEpoch: mentionFact.connectionEpoch,
    bindingId: mentionFact.bindingId,
    bindingEpoch: mentionFact.bindingEpoch,
    conversationId: mentionFact.conversationId,
    memberRevision: mentionFact.memberRevision,
    contextRevision: mentionFact.contextRevision,
    freshnessObservedAt: mentionFact.freshnessObservedAt.toISOString(),
    freshnessExpiresAt: mentionFact.freshnessExpiresAt.toISOString(),
    handleSnapshot: mentionFact.handleAtSendTime,
    resolutionReason: mentionFact.resolutionReason,
  }];
  await fixture.db.update(externalOutboundDeliveries).set({
    renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot),
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  await fixture.db.update(externalAddressabilityProjections).set({ state: "stale" })
    .where(eq(externalAddressabilityProjections.id, addressability.id));

  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.deepEqual(result, {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "frozen_render_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: "2026-08-03T12:00:05.000Z",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("missing credential creates no attempt and calls no provider", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    credential: false,
    calls,
  })));
  assert.deepEqual(result, {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "credential_unavailable_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: "2026-08-03T12:00:05.000Z",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.providerAttempts, 0);
});

test("provider preflight rejection releases credential and creates no provider attempt", async () => {
  const fixture = await seedFixture();
  const runtime = activeRuntime(fixture);
  let prepared = 0;
  let dispatched = 0;
  let released = 0;
  const base = dependencies({ runtime });
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, {
    ...base,
    dispatchProvider: undefined,
    async prepareProvider() {
      prepared += 1;
      return { ready: false as const, reason: "provider_thread_receipt_missing" };
    },
    async releaseCredential() {
      released += 1;
    },
  }));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "provider_thread_receipt_missing",
    deliveryId: fixture.deliveries[0]!.id,
  });
  assert.equal(prepared, 1);
  assert.equal(dispatched, 0);
  assert.equal(released, 1);
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.stateReason, "provider_thread_receipt_missing");
});

test("preexisting conflicting link payload fails closed before provider I/O", async () => {
  const fixture = await seedFixture();
  await fixture.db.insert(externalMessageLinks).values({
    deliveryId: fixture.deliveries[0].id,
    provider: fixture.frozenAuthority.provider,
    installId: fixture.frozenAuthority.installId,
    providerAuthorityId: fixture.frozenAuthority.providerAuthorityId,
    providerConversationId: fixture.frozenAuthority.providerConversationId,
    providerMessageId: null,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    connectionEpoch: fixture.frozenAuthority.connectionEpoch,
    raftMessageId: fixture.sourceMessages[0].id,
    raftCanonicalRootMessageId: null,
    firstDirection: "raft_outbound",
    payloadFingerprint: "f".repeat(64),
    outcomeState: "unknown",
    authorityState: "active",
    stateReason: "poisoned_fixture",
  });
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "link_identity_or_payload_conflict",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.equal(calls.provider, 0);
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
});

test("attempt-start rechecks lease expiry after slow authority dependencies", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  let clockCalls = 0;
  const base = dependencies({ runtime: activeRuntime(fixture), calls });
  const deps: ExternalDeliveryWorkerDependencies = {
    ...base,
    now: () => {
      clockCalls += 1;
      return clockCalls === 1 ? NOW : new Date(NOW.getTime() + 60_001);
    },
  };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "lease_expired_before_attempt_start",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.providerAttempts, 0);
});

test("attempt admission at exact lease expiry blocks before durable attempt or provider I/O", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  let authoritativeNow = NOW;
  const deps: ExternalDeliveryWorkerDependencies = {
    ...dependencies({ runtime: activeRuntime(fixture), calls }),
    now: () => authoritativeNow,
  };
  __setExternalDeliveryAttemptRowLockHookForTests(() => {
    authoritativeNow = new Date(NOW.getTime() + 60_000);
  });
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "lease_expired_before_attempt_start",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "queued");
  assert.equal(delivery.providerAttempts, 0);
});

test("attempt admission one millisecond before lease expiry remains authorized", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  let authoritativeNow = NOW;
  const deps: ExternalDeliveryWorkerDependencies = {
    ...dependencies({ runtime: activeRuntime(fixture), calls }),
    now: () => authoritativeNow,
  };
  __setExternalDeliveryAttemptRowLockHookForTests(() => {
    authoritativeNow = new Date(NOW.getTime() + 59_999);
  });
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.deepEqual(result, {
    kind: "attempted",
    deliveryId: fixture.deliveries[0].id,
    attemptNumber: 1,
    outcome: "accepted",
    deliveryState: "accepted",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 1 });
  const [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.providerIoStartedAt.toISOString(), authoritativeNow.toISOString());
});

test("two workers racing one partition produce exactly one adapter call", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const deps = dependencies({ runtime: activeRuntime(fixture), calls });
  const [left, right] = await Promise.all([
    processExternalDeliveryPartitionHead(workerInput(fixture, deps)),
    processExternalDeliveryPartitionHead({ ...workerInput(fixture, deps), leaseOwner: "worker-2" }),
  ]);
  assert.equal(calls.provider, 1);
  assert.ok([left.kind, right.kind].includes("attempted"));
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 1);
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 1);
});

test("expired pre-I/O claim restores an outcome_unknown head without consuming budget", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dispatching",
    providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    leaseOwner: "crashed-worker",
    leaseExpiresAt: new Date("2026-08-03T11:59:00.000Z"),
    leaseGeneration: 4,
    leaseOriginState: "outcome_unknown",
    stateReason: null,
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: null,
    calls,
  })));
  assert.equal(result.kind, "authority_blocked");
  if (result.kind !== "authority_blocked") return;
  assert.equal(result.severity, "overdue");
  assert.equal(result.alert?.severity, "overdue");
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "outcome_unknown");
  assert.equal(delivery.providerAttempts, 1);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 1);
  assert.equal(delivery.leaseOwner, null);
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
  assert.equal(calls.provider, 0);
});

test("expired post-I/O claim terminalizes the started attempt unknown and does not advance", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dispatching",
    providerAttempts: 1,
    firstDispatchedAt: new Date("2026-08-03T11:59:00.000Z"),
    leaseOwner: "crashed-worker",
    leaseExpiresAt: new Date("2026-08-03T11:59:59.000Z"),
    leaseGeneration: 2,
    leaseOriginState: "queued",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  await fixture.db.insert(externalDeliveryAttempts).values({
    deliveryId: fixture.deliveries[0].id,
    attemptNumber: 1,
    leaseGeneration: 2,
    runtimeRevision: "runtime-r1",
    credentialRevision: 9,
    dispatchAuthorization: "automatic",
    providerIoStartedAt: new Date("2026-08-03T11:59:00.000Z"),
  });
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.deepEqual(result, {
    kind: "lease_reclaimed",
    deliveryId: fixture.deliveries[0].id,
    phase: "post_io",
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "outcome_unknown");
  assert.equal(delivery.providerAttempts, 1);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 1);
  const [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.outcome, "outcome_unknown");
  assert.equal(attempt.outcomeReason, "lease_expired_after_provider_io");
  const [link] = await fixture.db.select().from(externalMessageLinks);
  assert.equal(link.outcomeState, "unknown");
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 0);
});

test("terminal attempt paired with a dispatching delivery fails closed without rewriting history", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dispatching",
    providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1,
    firstDispatchedAt: new Date("2026-08-03T11:59:00.000Z"),
    leaseOwner: "inconsistent-worker",
    leaseExpiresAt: new Date("2026-08-03T11:59:59.000Z"),
    leaseGeneration: 2,
    leaseOriginState: "queued",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const [attempt] = await fixture.db.insert(externalDeliveryAttempts).values({
    deliveryId: fixture.deliveries[0].id,
    attemptNumber: 1,
    leaseGeneration: 2,
    runtimeRevision: "runtime-r1",
    credentialRevision: 9,
    dispatchAuthorization: "automatic",
    providerIoStartedAt: new Date("2026-08-03T11:59:00.000Z"),
    outcome: "outcome_unknown",
    outcomeReason: "already_terminal",
    terminalAt: new Date("2026-08-03T11:59:30.000Z"),
  }).returning();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  assert.deepEqual(await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  }))), {
    kind: "blocked",
    reason: "terminal_attempt_with_dispatching_delivery",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "dispatching");
  assert.equal(delivery.providerAttempts, 1);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 1);
  const [persistedAttempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(persistedAttempt.id, attempt.id);
  assert.equal(persistedAttempt.outcome, "outcome_unknown");
  assert.equal(persistedAttempt.outcomeReason, "already_terminal");
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 0);
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 0);
});

test("429 consumes total attempts but not ambiguity or failure budget", async () => {
  const fixture = await seedFixture();
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    providerResult: { kind: "rate_limited", retryAfterMs: 30_000 },
  })));
  assert.equal(result.kind, "attempted");
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "retry_wait");
  assert.equal(delivery.providerAttempts, 1);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 0);
  assert.equal(delivery.dispatchedFailureAttempts, 0);
  assert.equal(delivery.nextAttemptAt?.toISOString(), "2026-08-03T12:00:30.000Z");
});

test("retry_wait before its exact due time invokes no authority dependency", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "retry_wait",
    providerAttempts: 1,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    nextAttemptAt: new Date("2026-08-03T12:00:00.001Z"),
    stateReason: "provider_rate_limited",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  assert.deepEqual(await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  }))), {
    kind: "blocked",
    reason: "retry_not_due",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
});

test("three non-429 calls exhaust automatic authority without credential or provider I/O", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "outcome_unknown",
    providerAttempts: 4,
    ambiguityBudgetProviderAttempts: 3,
    dispatchedFailureAttempts: 2,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    stateReason: "provider_outcome_ambiguous",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  assert.deepEqual(await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  }))), {
    kind: "blocked",
    reason: "audited_retry_required",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
});

test("dead head blocks the later FIFO row and invokes no dependency", async () => {
  const fixture = await seedFixture(2);
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dead",
    providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1,
    dispatchedFailureAttempts: 1,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    stateReason: "deterministic_failure",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "terminal_partition_head",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
  const second = (await fixture.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.partitionPosition, 2)))[0];
  assert.equal(second.state, "queued");
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("audited skip is exact, one-shot, cursor-atomic, and zero provider I/O", async () => {
  const fixture = await seedFixture();
  const [decision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "skip",
    actorType: "user",
    actorId: fixture.owner.id,
    reason: "accept exact bounded data loss",
    dataLossAcknowledged: true,
    decisionRevision: 1,
  }).returning();
  assert.deepEqual(await consumeExternalDeliverySkipDecision({
    db: fixture.db,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    decisionId: decision.id,
    now: NOW,
  }), { kind: "skipped", deliveryId: fixture.deliveries[0].id });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "skipped");
  assert.equal(delivery.providerAttempts, 0);
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 1);
  const [consumed] = await fixture.db.select().from(externalDeliveryOperatorDecisions);
  assert.equal(consumed.consumedLeaseGeneration, 1);
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
  assert.deepEqual(await consumeExternalDeliverySkipDecision({
    db: fixture.db,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    decisionId: decision.id,
    now: NOW,
  }), { kind: "blocked", reason: "partition_head_missing" });
});

test("audited retry consumes one exact decision at attempt start", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dead",
    providerAttempts: 3,
    ambiguityBudgetProviderAttempts: 3,
    dispatchedFailureAttempts: 1,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    stateReason: "automatic_budget_exhausted",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const [decision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "agent",
    actorId: "operator-agent-1",
    reason: "duplicate risk explicitly accepted",
    duplicateRiskAcknowledged: true,
    decisionRevision: 1,
  }).returning();
  const result = await processExternalDeliveryPartitionHead(workerInput(
    fixture,
    dependencies({ runtime: activeRuntime(fixture) }),
    decision.id,
  ));
  assert.equal(result.kind, "attempted");
  const [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.attemptNumber, 4);
  assert.equal(attempt.dispatchAuthorization, "audited_retry_in_place");
  assert.equal(attempt.operatorDecisionId, decision.id);
  const [consumed] = await fixture.db.select().from(externalDeliveryOperatorDecisions);
  assert.equal(consumed.consumedLeaseGeneration, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
});

test("wrong or consumed retry authority invokes no provider and restores the dead head", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dead",
    providerAttempts: 3,
    ambiguityBudgetProviderAttempts: 3,
    dispatchedFailureAttempts: 1,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    stateReason: "automatic_budget_exhausted",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(
    fixture,
    dependencies({ runtime: activeRuntime(fixture), calls }),
    randomUUID(),
  ));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "audited_retry_decision_invalid_or_consumed",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.equal(calls.provider, 0);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "dead");
  assert.equal(delivery.providerAttempts, 3);
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("one audited retry decision cannot authorize a second provider call", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "outcome_unknown",
    providerAttempts: 3,
    ambiguityBudgetProviderAttempts: 3,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    stateReason: "provider_outcome_ambiguous",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const [decision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "user",
    actorId: fixture.owner.id,
    reason: "one exact duplicate-risk decision",
    duplicateRiskAcknowledged: true,
    decisionRevision: 3,
  }).returning();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const deps = dependencies({
    runtime: activeRuntime(fixture),
    calls,
    providerResult: { kind: "outcome_unknown", reasonCode: "provider_response_lost" },
  });
  const first = await processExternalDeliveryPartitionHead(workerInput(fixture, deps, decision.id));
  assert.equal(first.kind, "attempted");
  assert.equal(calls.provider, 1);
  const second = await processExternalDeliveryPartitionHead(workerInput(fixture, deps, decision.id));
  assert.deepEqual(second, {
    kind: "blocked",
    reason: "audited_retry_decision_invalid_or_consumed",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.equal(calls.provider, 1);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "outcome_unknown");
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 1);

  const [secondDecision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "user",
    actorId: fixture.owner.id,
    reason: "new exact decision for the same unknown link",
    duplicateRiskAcknowledged: true,
    decisionRevision: 4,
  }).returning();
  const accepted = await processExternalDeliveryPartitionHead(workerInput(
    fixture,
    dependencies({ runtime: activeRuntime(fixture) }),
    secondDecision.id,
  ));
  assert.equal(accepted.kind, "attempted");
  const links = await fixture.db.select().from(externalMessageLinks);
  assert.equal(links.length, 1);
  assert.equal(links[0].outcomeState, "accepted");
  assert.equal(links[0].providerMessageId, "provider-message-1");
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 1);
});

test("a due retry_wait head exhausted at three non-429 calls can use one audited retry", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "retry_wait",
    providerAttempts: 3,
    ambiguityBudgetProviderAttempts: 3,
    dispatchedFailureAttempts: 3,
    firstDispatchedAt: new Date("2026-08-03T11:00:00.000Z"),
    nextAttemptAt: NOW,
    stateReason: "provider_transient_failure",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const [decision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "user",
    actorId: fixture.owner.id,
    reason: "explicit retry after automatic ceiling",
    duplicateRiskAcknowledged: true,
    decisionRevision: 4,
  }).returning();
  const result = await processExternalDeliveryPartitionHead(workerInput(
    fixture,
    dependencies({ runtime: activeRuntime(fixture) }),
    decision.id,
  ));
  assert.equal(result.kind, "attempted");
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "accepted");
  assert.equal(delivery.providerAttempts, 4);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 4);
  const [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.dispatchAuthorization, "audited_retry_in_place");
});

test("audited 24th transient failure closes the failure budget exactly", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dead",
    providerAttempts: 23,
    ambiguityBudgetProviderAttempts: 23,
    dispatchedFailureAttempts: 23,
    firstDispatchedAt: new Date("2026-08-03T11:30:00.000Z"),
    stateReason: "operator_review_required",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const [decision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "user",
    actorId: fixture.owner.id,
    reason: "last bounded retry authorized",
    duplicateRiskAcknowledged: true,
    decisionRevision: 24,
  }).returning();
  const result = await processExternalDeliveryPartitionHead(workerInput(
    fixture,
    dependencies({
      runtime: activeRuntime(fixture),
      providerResult: { kind: "transient_failure", reasonCode: "provider_temporarily_unavailable", baseDelayMs: 1_000 },
    }),
    decision.id,
  ));
  assert.equal(result.kind, "attempted");
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "dead");
  assert.equal(delivery.providerAttempts, 24);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 24);
  assert.equal(delivery.dispatchedFailureAttempts, 24);
});

test("audited retry beyond 24 hours performs zero provider I/O", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "outcome_unknown",
    providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1,
    firstDispatchedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
    stateReason: "provider_outcome_ambiguous",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const [decision] = await fixture.db.insert(externalDeliveryOperatorDecisions).values({
    deliveryId: fixture.deliveries[0].id,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    partitionPosition: 1,
    action: "retry_in_place",
    actorType: "agent",
    actorId: "operator-agent-2",
    reason: "explicit old-delivery retry",
    duplicateRiskAcknowledged: true,
    decisionRevision: 2,
  }).returning();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(
    fixture,
    dependencies({
      runtime: activeRuntime(fixture),
      calls,
      providerResult: { kind: "rate_limited", retryAfterMs: 1_000 },
    }),
    decision.id,
  ));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "delivery_budget_exhausted",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.equal(calls.provider, 0);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "outcome_unknown");
  assert.equal(delivery.stateReason, "delivery_budget_exhausted");
  assert.equal(delivery.providerAttempts, 1);
  assert.equal(delivery.ambiguityBudgetProviderAttempts, 1);
});

test("accepted transaction rollback leaves a reclaimable started attempt and no false cursor/link", async () => {
  const fixture = await seedFixture();
  __setExternalDeliveryAcceptedTransactionHookForTests(() => {
    throw new Error("test rollback after link before cursor");
  });
  await assert.rejects(processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
  }))));
  let [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "dispatching");
  assert.equal(delivery.providerAttempts, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 0);
  let [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 0);
  let [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.outcome, "provider_io_started");

  __setExternalDeliveryAcceptedTransactionHookForTests(null);
  await fixture.db.update(externalOutboundDeliveries).set({
    leaseExpiresAt: new Date("2026-08-03T11:59:59.000Z"),
  }).where(eq(externalOutboundDeliveries.id, delivery.id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const reclaimed = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.equal(reclaimed.kind, "lease_reclaimed");
  assert.equal(calls.provider, 0);
  [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "outcome_unknown");
  [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.outcome, "outcome_unknown");
  [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 0);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
});

test("raw adapter exception becomes a closed unknown reason without raw text", async () => {
  const fixture = await seedFixture();
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    throwProvider: true,
  })));
  assert.equal(result.kind, "attempted");
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "outcome_unknown");
  assert.equal(delivery.stateReason, "provider_outcome_ambiguous");
  const [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt.outcomeReason, "provider_io_exception");
  const [link] = await fixture.db.select().from(externalMessageLinks);
  assert.equal(link.stateReason, "provider_io_exception");
  assert.ok(!JSON.stringify({ delivery, attempt, link }).includes("secret-shaped"));
});

test("worker source keeps the opaque credential handle adapter-only and has no raw error logger", () => {
  const source = readFileSync(new URL("./externalDeliveryWorkerService.ts", import.meta.url), "utf8");
  assert.equal(source.match(/credential\.handle/g)?.length, 4);
  assert.match(source, /dependencies\.prepareProvider/);
  assert.match(source, /dependencies\.releaseCredential/);
  assert.doesNotMatch(source, /\b(?:accessToken|refreshToken|apiKey|authorizationHeader|rawError)\b/);
  assert.doesNotMatch(source, /\b(?:console|logger)\./);
  assert.match(source, /\} catch \{\s*providerResult = \{ kind: "outcome_unknown"/);
});

test("accepted cursor recovery is exact and performs zero provider I/O", async () => {
  const fixture = await seedFixture(2);
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "accepted",
    providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1,
    firstDispatchedAt: NOW,
    providerMessageId: "accepted-before-cursor",
    acceptedAt: NOW,
    stateReason: "provider_accepted",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  await fixture.db.insert(externalMessageLinks).values({
    deliveryId: fixture.deliveries[0].id,
    provider: fixture.frozenAuthority.provider,
    installId: fixture.frozenAuthority.installId,
    providerAuthorityId: fixture.frozenAuthority.providerAuthorityId,
    providerConversationId: fixture.frozenAuthority.providerConversationId,
    providerMessageId: "accepted-before-cursor",
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    connectionEpoch: fixture.frozenAuthority.connectionEpoch,
    raftMessageId: fixture.sourceMessages[0].id,
    raftCanonicalRootMessageId: null,
    firstDirection: "raft_outbound",
    payloadFingerprint: fixture.deliveries[0].renderSnapshotDigest,
    outcomeState: "accepted",
    authorityState: "active",
    stateReason: "provider_accepted",
  });
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.deepEqual(result, {
    kind: "cursor_recovered",
    deliveryId: fixture.deliveries[0].id,
    state: "accepted",
  });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 1);
  const second = (await fixture.db.select().from(externalOutboundDeliveries)
    .where(and(
      eq(externalOutboundDeliveries.bindingId, fixture.bindingId),
      eq(externalOutboundDeliveries.partitionPosition, 2),
    )))[0];
  assert.equal(second.state, "queued");
});

test("accepted head without its exact active link cannot recover the cursor", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "accepted",
    providerAttempts: 1,
    ambiguityBudgetProviderAttempts: 1,
    firstDispatchedAt: NOW,
    providerMessageId: "accepted-without-link",
    acceptedAt: NOW,
    stateReason: "provider_accepted",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const result = await processExternalDeliveryPartitionHead(workerInput(
    fixture,
    dependencies({ runtime: activeRuntime(fixture) }),
  ));
  assert.deepEqual(result, {
    kind: "blocked",
    reason: "accepted_link_missing_or_conflicting",
    deliveryId: fixture.deliveries[0].id,
  });
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.cursorPosition, 0);
});
