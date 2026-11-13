import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { SLACK_BRIDGE_MAX_DELIVERY_AGE_MS } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agents,
  attachmentObjects,
  attachments,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalMentionFacts,
  externalOutboundDeliveries,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { createOutboundExternalAttachmentTransferWithExecutor } from "./externalAttachmentTransferService";
import type {
  ProviderNeutralOutboundBindingAuthority,
  SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService";
import { digestSlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import {
  __setExternalDeliveryAcceptedTransactionHookForTests,
  __setExternalDeliveryAttemptRowLockHookForTests,
  consumeExternalDeliverySkipDecision,
  EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS,
  EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_MAX_MS,
  EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS,
  processExternalDeliveryPartitionHead,
  recordExternalDeliveryRetryDecision,
  type ActiveExternalDeliveryRuntime,
  type ExternalDeliveryProviderResult,
  type ExternalDeliveryWorkerDependencies,
} from "./externalDeliveryWorkerService";


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
    appRegistrationId: "00000000-0000-4000-8000-000000000001",
    installId: "install-1",
    workspaceId: "workspace-1",
    connectionEpoch: 4,
    bindingId,
    bindingEpoch,
    memberRevision: 5,
    contextRevision: 6,
    privacyClass: "public",
    raftChannelId,
    providerAuthorityId: "authority-1",
    providerConversationId: "conversation-1",
  };
}

async function seedFixture(positionCount = 1, senderType: "user" | "agent" = "user") {
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
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: owner.id,
    role: "owner",
  });
  const sender = senderType === "user"
    ? owner
    : (await db.insert(agents).values({
      serverId: server.id,
      name: `worker-agent-${randomUUID()}`,
      displayName: "Worker Agent",
      runtime: "codex",
    }).returning())[0]!;
  if (senderType === "agent") {
    await db.insert(channelAgents).values({ channelId: channel.id, agentId: sender.id });
  }
  const senderName = senderType === "user" ? "Worker Owner" : "Worker Agent";
  const sourceMessages = await db.insert(messages).values(
    Array.from({ length: positionCount }, (_, index) => ({
      channelId: channel.id,
      senderType,
      senderId: sender.id,
      content: `source ${index + 1}`,
      messageType: "chat" as const,
    })),
  ).returning();
  const bindingId = `binding-${randomUUID()}`;
  const bindingEpoch = 3;
  const frozenAuthority = authority(bindingId, bindingEpoch, channel.id);
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
        schema: "slack-bridge-render-snapshot.v4",
        sourceMessageId: message.id,
        sourceMessageSeq: message.seq,
        canonicalConversationId: channel.id,
        level: "top_level",
        canonicalRootMessageId: null,
        sourcePermalink: `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=${message.id}`,
        senderType,
        senderId: sender.id,
        authorName: senderName,
        authorPresentation: {
          displayName: senderName,
          fallbackKind: senderType === "user" ? "human" : "agent",
          avatar: null,
        },
        sanitizedText: message.content,
        externalMentions: [],
        raftMentionSubstitutions: [],
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
  return {
    db,
    owner,
    sender,
    server,
    channel,
    sourceMessages,
    bindingId,
    bindingEpoch,
    frozenAuthority,
    partition,
    deliveries,
  };
}

function dependencies(input: {
  runtime?: ActiveExternalDeliveryRuntime | null;
  credential?: boolean;
  providerResult?: ExternalDeliveryProviderResult;
  providerRequestBodies?: unknown[];
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
    async dispatchProvider(providerInput) {
      calls.provider += 1;
      input.providerRequestBodies?.push(providerInput);
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

test("active binding with no delivery partition is zero-work idle", async () => {
  const db = getDb();
  const bindingId = `binding-${randomUUID()}`;
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead({
    db,
    bindingId,
    bindingEpoch: 1,
    leaseOwner: "zero-work-worker",
    dependencies: dependencies({ runtime: null, calls }),
  });
  assert.deepEqual(result, { kind: "empty" });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });

  assert.deepEqual(await consumeExternalDeliverySkipDecision({
    db,
    bindingId,
    bindingEpoch: 1,
    decisionId: randomUUID(),
    now: NOW,
  }), { kind: "blocked", reason: "partition_head_missing" });
  assert.equal((await db.select().from(externalDeliveryOperatorDecisions)).length, 0);
  assert.equal((await db.select().from(externalOutboundDeliveries)).length, 0);
});

type SqlCaptureClient = {
  query: (...args: unknown[]) => Promise<unknown>;
  transaction: <T>(fn: (tx: SqlCaptureClient) => Promise<T>, ...rest: unknown[]) => Promise<T>;
};

async function captureSql(work: () => Promise<unknown>): Promise<string[]> {
  const client = (getDb() as unknown as { $client: SqlCaptureClient }).$client;
  const originalQuery = client.query.bind(client);
  const originalTransaction = client.transaction.bind(client);
  const statements: string[] = [];
  const record = (args: unknown[]) => {
    if (typeof args[0] === "string") statements.push(args[0].toLowerCase());
  };
  client.query = ((...args: unknown[]) => {
    record(args);
    return originalQuery(...args);
  }) as SqlCaptureClient["query"];
  client.transaction = (async <T,>(fn: (tx: SqlCaptureClient) => Promise<T>, ...rest: unknown[]) =>
    originalTransaction(async (tx: SqlCaptureClient) => {
      const originalTxQuery = tx.query.bind(tx);
      tx.query = ((...args: unknown[]) => {
        record(args);
        return originalTxQuery(...args);
      }) as SqlCaptureClient["query"];
      return fn(tx);
    }, ...rest)) as SqlCaptureClient["transaction"];
  try {
    await work();
  } finally {
    client.query = originalQuery;
    client.transaction = originalTransaction;
  }
  return statements;
}

function partitionLocks(statements: string[]): string[] {
  return statements.filter((text) =>
    text.includes("from \"external_delivery_partitions\"") && text.includes("for update"));
}

test("recording a provider outcome locks the partition before the delivery, like the claim", async () => {
  // Prod 2026-10-21 (four 40P01, 15:39-17:07Z): the outcome transaction locked the
  // delivery first and the partition only when the cursor advanced, while another
  // replica's tick held the partition (lockPartitionAndHead) and waited for that
  // head. Both paths must take partition -> delivery.
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const statements = await captureSql(() => processExternalDeliveryPartitionHead(
    workerInput(fixture, dependencies({ runtime: activeRuntime(fixture), calls })),
  ));
  assert.equal(calls.provider, 1, "the provider must be called so the outcome transaction runs");
  const isPartitionLock = (text: string) =>
    text.includes("from \"external_delivery_partitions\"") && text.includes("for update");
  // The outcome's delivery lock is the last delivery FOR UPDATE filtered on the
  // exact lease (the column list names lease_owner on every delivery read, so
  // match the WHERE clause).
  const isLeaseDeliveryLock = (text: string) =>
    text.includes("from \"external_outbound_deliveries\"")
    && text.includes("\"external_outbound_deliveries\".\"lease_owner\" = $")
    && text.includes("for update");
  let outcomeDeliveryLock = -1;
  statements.forEach((text, index) => {
    if (isLeaseDeliveryLock(text)) outcomeDeliveryLock = index;
  });
  assert.ok(outcomeDeliveryLock > 0, "the outcome transaction must lock its delivery under the exact lease");
  assert.ok(
    isPartitionLock(statements[outcomeDeliveryLock - 1]!),
    `the statement before the outcome's delivery lock must be the partition lock, got: ${statements[outcomeDeliveryLock - 1]}`,
  );
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "accepted");
});

test("the worker skips a partition another worker holds; the operator skip path still waits for it", async () => {
  // Prod 2026-09-26 (bac9696a rollout): every replica's worker loop hit the same
  // partition row at once and 13+ sessions queued on its lock, each parking a
  // pooled connection. The worker claim must not wait; the operator path must,
  // because under SKIP LOCKED a held partition would read as missing.
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };

  const workerStatements = await captureSql(() => processExternalDeliveryPartitionHead(
    workerInput(fixture, dependencies({ runtime: null, calls })),
  ));
  const workerLocks = partitionLocks(workerStatements);
  assert.ok(workerLocks.length > 0, "the worker must lock its partition row; zero captured statements means the capture seam is broken");
  assert.ok(
    workerLocks[0]!.includes("skip locked"),
    `the initial worker claim must use SKIP LOCKED; got: ${workerLocks[0]}`,
  );
  assert.ok(
    workerLocks.slice(1).every((text) => !text.includes("skip locked")),
    `an owned claim must wait briefly rather than abandoning its lease; got: ${workerLocks.slice(1).join(" | ")}`,
  );

  const operatorStatements = await captureSql(() => consumeExternalDeliverySkipDecision({
    db: fixture.db,
    bindingId: fixture.bindingId,
    bindingEpoch: fixture.bindingEpoch,
    decisionId: randomUUID(),
    now: NOW,
  }));
  const operatorLocks = partitionLocks(operatorStatements);
  assert.ok(operatorLocks.length > 0, "the operator skip path must lock the partition row");
  assert.ok(
    operatorLocks.every((text) => !text.includes("skip locked")),
    `operator partition lock must wait, not skip; got: ${operatorLocks.join(" | ")}`,
  );
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
    runtime: activeRuntime(fixture),
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
  mismatch.bindingAuthority = { ...mismatch.bindingAuthority, providerConversationId: "another-conversation" };
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
    `authority_retry:runtime_authority_inactive_or_mismatched|since=${NOW.getTime()}`,
  );
});

test("mutable runtime and audience revisions refresh without blocking ordinary delivery", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const refreshed = activeRuntime(fixture);
  refreshed.runtimeRevision = "runtime-r2";
  refreshed.bindingAuthority = {
    ...refreshed.bindingAuthority,
    memberRevision: 19766,
    contextRevision: 19766,
  };

  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: refreshed,
    calls,
  })));

  assert.equal(result.kind, "attempted");
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 1 });
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "accepted");
  const [attempt] = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempt?.runtimeRevision, "runtime-r2");
});

test("removed Human sender blocks before credential lease or provider I/O", async () => {
  const fixture = await seedFixture();
  await fixture.db.delete(serverMembers).where(and(
    eq(serverMembers.serverId, fixture.server.id),
    eq(serverMembers.userId, fixture.owner.id),
  ));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  assert.deepEqual(await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  }))), {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "frozen_render_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: "2026-08-03T12:00:05.000Z",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("Human removed from a private binding channel blocks before provider I/O", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(channels).set({ type: "private" }).where(eq(channels.id, fixture.channel.id));
  await fixture.db.insert(channelHumans).values({
    channelId: fixture.channel.id,
    userId: fixture.owner.id,
  });
  await fixture.db.delete(channelHumans).where(and(
    eq(channelHumans.channelId, fixture.channel.id),
    eq(channelHumans.userId, fixture.owner.id),
  ));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.equal(result.kind, "authority_blocked");
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("deleted Agent sender blocks before credential lease or provider I/O", async () => {
  const fixture = await seedFixture(1, "agent");
  await fixture.db.update(agents).set({ deletedAt: NOW }).where(eq(agents.id, fixture.sender.id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  assert.deepEqual(await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  }))), {
    kind: "authority_blocked",
    severity: "retrying",
    reason: "frozen_render_authority_inactive_or_mismatched",
    deliveryId: fixture.deliveries[0].id,
    nextRetryAt: "2026-08-03T12:00:05.000Z",
  });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});

test("Agent removed from the parent binding channel blocks before provider I/O", async () => {
  const fixture = await seedFixture(1, "agent");
  await fixture.db.delete(channelAgents).where(and(
    eq(channelAgents.channelId, fixture.channel.id),
    eq(channelAgents.agentId, fixture.sender.id),
  ));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  assert.equal(result.kind, "authority_blocked");
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
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
  await fixture.db.update(externalOutboundDeliveries).set({ createdAt, updatedAt: createdAt,
    stateReason: `authority_retry:runtime_authority_inactive_or_mismatched|since=${createdAt.getTime()}` })
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
    `authority_overdue:runtime_authority_inactive_or_mismatched|since=${createdAt.getTime()}`,
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
  await fixture.db.update(externalOutboundDeliveries).set({ createdAt, updatedAt: createdAt,
    stateReason: `authority_retry:runtime_authority_inactive_or_mismatched|since=${createdAt.getTime()}` })
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
  assert.equal(head.stateReason, `authority_terminal:runtime_authority_inactive_or_mismatched|since=${createdAt.getTime()}`);

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

test("worker preserves rolling compatibility with queued v3 snapshots", async () => {
  const fixture = await seedFixture();
  const current = fixture.deliveries[0].renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  const legacy = {
    ...current,
    schema: "slack-bridge-render-snapshot.v3",
    authorPresentation: {
      displayName: current.authorPresentation.displayName,
      fallbackKind: current.authorPresentation.fallbackKind,
    },
  };
  await fixture.db.update(externalOutboundDeliveries).set({
    renderSnapshotSchema: legacy.schema,
    renderSnapshot: legacy,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(legacy as unknown as SlackBridgeRenderSnapshot),
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
  })));
  assert.equal(result.kind, "attempted");
  if (result.kind === "attempted") assert.equal(result.outcome, "accepted");
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

test("frozen render snapshot accepts lh3.googleusercontent.com avatar and passes icon_url to Slack", async () => {
  const fixture = await seedFixture();
  const snapshot = fixture.deliveries[0].renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  const googleUrl = "https://lh3.googleusercontent.com/a/ACg8ocLW_-Y_0CjmhrgN-Lj2tdT1-sR3Oh8AKTZ_vc-3gH935ZgjNQ=s96-c";
  snapshot.authorPresentation.avatar = {
    publicUrl: googleUrl,
    contentDigest: createHash("sha256").update(googleUrl).digest("hex").slice(0, 32),
  };
  await fixture.db.update(externalOutboundDeliveries).set({
    renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot),
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const providerRequestBodies: unknown[] = [];
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
    providerRequestBodies,
  })));
  assert.equal(result.kind, "attempted");
  if (result.kind === "attempted") assert.equal(result.outcome, "accepted");
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 1 });
  const lastRequest = providerRequestBodies[providerRequestBodies.length - 1] as {
    frozenSnapshot: SlackBridgeRenderSnapshot;
  };
  assert.equal(
    lastRequest.frozenSnapshot.authorPresentation.avatar?.publicUrl,
    googleUrl,
  );
});

test("frozen render snapshot rejects non-allowlisted external avatar hosts", async () => {
  const fixture = await seedFixture();
  const snapshot = fixture.deliveries[0].renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  snapshot.authorPresentation.avatar = {
    publicUrl: "https://evil.example.com/avatar.png",
    contentDigest: "e".repeat(32),
  };
  await fixture.db.update(externalOutboundDeliveries).set({
    renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot),
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
});

test("frozen render snapshot rejects non-HTTPS or non-content-addressed avatars", async () => {
  const fixture = await seedFixture();
  const snapshot = fixture.deliveries[0].renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  snapshot.authorPresentation.avatar = {
    publicUrl: "http://provider.example.test/avatar.png",
    contentDigest: "e".repeat(32),
  };
  await fixture.db.update(externalOutboundDeliveries).set({
    renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot),
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

test("source preparation blocks before a workspace credential or provider attempt", async () => {
  const fixture = await seedFixture();
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, {
    ...dependencies({ runtime: activeRuntime(fixture), calls }),
    async prepareBeforeCredential() { return { ready: false as const, reason: "attachment_source_preparing" }; },
  }));
  assert.deepEqual(result, { kind: "blocked", reason: "attachment_source_preparing", deliveryId: fixture.deliveries[0]!.id });
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
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
  assert.equal(result.severity, "retrying");
  assert.equal(result.alert, undefined, "message age is not elapsed authority-block duration");
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

test("three non-429 calls stop writes while allowing read-only preparation", async () => {
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
    reason: "automatic_dispatch_not_authorized",
    deliveryId: fixture.deliveries[0].id,
  });
  assert.deepEqual(calls, { runtime: 1, credential: 1, provider: 0 });
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

for (const blockedReason of ["runtime_authority_inactive_or_mismatched", "slack_not_in_channel", "binding_paused_bot_removed"] as const) {
test(`audited skip preserves only bot-recovery waits (${blockedReason})`, async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW,
    authorityBlockedReason: blockedReason, authorityRetryAt: new Date(NOW.getTime() + 60_000),
    authorityOverdueAlertedAt: NOW }).where(eq(externalDeliveryPartitions.bindingId, fixture.bindingId));
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
  assert.deepEqual([partition.authorityBlockedAt, partition.authorityBlockedReason, partition.authorityRetryAt,
    partition.authorityOverdueAlertedAt], blockedReason === "runtime_authority_inactive_or_mismatched"
    ? [null, null, null, null] : [NOW, blockedReason, new Date(NOW.getTime() + 60_000), NOW]);
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
}

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

test("one audited retry beyond the automatic age limit can deliver the original message", async () => {
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
      providerResult: { kind: "accepted", providerMessageId: "provider-old-accepted", providerThreadId: null },
    }),
    decision.id,
  ));
  assert.equal(result.kind, "attempted");
  assert.equal(calls.provider, 1);
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "accepted");
  assert.equal(delivery.providerAttempts, 2);
  assert.equal(delivery.firstDispatchedAt?.getTime(), NOW.getTime() - 24 * 60 * 60 * 1000);
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

for (const blockedReason of ["runtime_authority_inactive_or_mismatched", "slack_not_in_channel", "binding_paused_bot_removed"] as const) {
test(`accepted cursor recovery preserves only bot-recovery waits (${blockedReason})`, async () => {
  const fixture = await seedFixture(2);
  await fixture.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW,
    authorityBlockedReason: blockedReason, authorityRetryAt: new Date(NOW.getTime() + 60_000) })
    .where(eq(externalDeliveryPartitions.bindingId, fixture.bindingId));
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
  assert.deepEqual([partition.authorityBlockedAt, partition.authorityBlockedReason, partition.authorityRetryAt],
    blockedReason === "runtime_authority_inactive_or_mismatched" ? [null, null, null]
      : [NOW, blockedReason, new Date(NOW.getTime() + 60_000)]);
  const second = (await fixture.db.select().from(externalOutboundDeliveries)
    .where(and(
      eq(externalOutboundDeliveries.bindingId, fixture.bindingId),
      eq(externalOutboundDeliveries.partitionPosition, 2),
    )))[0];
  assert.equal(second.state, "queued");
});
}

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

for (const privacy of ["public", "private"] as const) {
for (const mode of ["same", "refresh", "removed"] as const) {
test(`review11004 queued external mention ${mode} (${privacy})`, async () => {
  const fixture = await seedFixture();
  fixture.frozenAuthority.memberRevision = 1;
  fixture.frozenAuthority.contextRevision = 1;
  fixture.frozenAuthority.privacyClass = privacy;
  if (privacy === "private") {
    await fixture.db.update(channels).set({ type: "private" }).where(eq(channels.id, fixture.channel.id));
    await fixture.db.insert(channelHumans).values({ channelId: fixture.channel.id, userId: fixture.owner.id });
  }
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
  snapshot.bindingAuthority = { ...fixture.frozenAuthority };
  snapshot.sanitizedText = "Hello @mentioned";
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
  if (mode === "refresh") {
    // Same provider identity and active membership; the producer advances only directory revisions.
    await fixture.db.update(externalAddressabilityProjections).set({ memberRevision: 2, contextRevision: 2,
      state: "active", observedAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * 60_000) })
      .where(eq(externalAddressabilityProjections.id, addressability.id));
  } else if (mode === "removed") {
    await fixture.db.update(externalAddressabilityProjections).set({ state: "removed" })
      .where(eq(externalAddressabilityProjections.id, addressability.id));
  }

  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    calls,
  })));
  console.log("mention refresh probe", privacy, mode, result.kind, calls);
  if (mode === "removed") {
    assert.equal(result.kind, "authority_blocked");
    assert.equal(calls.provider, 0);
  } else {
    assert.equal(result.kind, "attempted", "an unchanged active mention target must not block the message after directory refresh");
    assert.equal(calls.provider, 1);
  }
});

}}


test("manager recovery retries the failed head in place and unblocks following messages after access returns", async () => {
  const fixture = await seedFixture(2);
  const failed = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    providerResult: { kind: "deterministic_failure", reasonCode: "provider_channel_not_found" },
  })));
  assert.equal(failed.kind, "attempted");
  assert.equal((await fixture.db.select().from(externalDeliveryPartitions))[0].cursorPosition, 0);
  const requestRetry = (deliveryId = fixture.deliveries[0].id, bindingEpoch = fixture.bindingEpoch) =>
    fixture.db.transaction((executor) => recordExternalDeliveryRetryDecision({
      executor, bindingId: fixture.bindingId, bindingEpoch, deliveryId, expectedProviderAttempts: 1,
      actorId: fixture.owner.id, now: NOW,
    }));
  assert.equal(await requestRetry(fixture.deliveries[1].id), false, "later messages cannot bypass the head");
  assert.equal(await requestRetry(fixture.deliveries[0].id, fixture.bindingEpoch + 1), false);
  assert.equal(await requestRetry(), true);
  assert.equal(await requestRetry(), true, "a repeated request does not authorize another attempt");
  assert.equal((await fixture.db.select().from(externalDeliveryOperatorDecisions)).length, 1);
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const denied = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({ calls })));
  assert.equal(denied.kind, "authority_blocked");
  assert.equal(calls.provider, 0, "recovery cannot bypass current authority");
  const [pending] = await fixture.db.select().from(externalDeliveryOperatorDecisions);
  assert.equal(pending.consumedAt, null);
  const later = new Date(NOW.getTime() + 10 * 60_000);
  const recovered = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture), now: later,
  })));
  assert.equal(recovered.kind, "attempted");
  const [original] = await fixture.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  assert.equal(original.state, "accepted");
  assert.equal(original.providerAttempts, 2);
  const [receipt] = await fixture.db.select().from(externalDeliveryOperatorDecisions);
  assert.ok(receipt.consumedAt);
  assert.equal(await requestRetry(), true, "a replay of the accepted operation is a no-op");
  const attempts = await fixture.db.select().from(externalDeliveryAttempts);
  assert.equal(attempts[1].operatorDecisionId, receipt.id);
  assert.equal(attempts[1].dispatchAuthorization, "audited_retry_in_place");
  const next = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture), now: later,
    providerResult: { kind: "accepted", providerMessageId: "provider-message-2", providerThreadId: null },
  })));
  assert.equal(next.kind, "attempted");
  assert.equal((await fixture.db.select().from(externalDeliveryPartitions))[0].cursorPosition, 2);
});


test("a manager retry beyond the automatic failure ceiling can fail without stranding the lease", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dead", providerAttempts: 24, ambiguityBudgetProviderAttempts: 24,
    dispatchedFailureAttempts: 24, firstDispatchedAt: NOW, stateReason: "failure_budget_exhausted",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  await fixture.db.transaction((executor) => recordExternalDeliveryRetryDecision({
    executor, bindingId: fixture.bindingId, bindingEpoch: fixture.bindingEpoch,
    deliveryId: fixture.deliveries[0].id, expectedProviderAttempts: 24, actorId: fixture.owner.id, now: NOW,
  }));
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture),
    providerResult: { kind: "transient_failure", reasonCode: "provider_unavailable", baseDelayMs: 1000 },
  })));
  assert.equal(result.kind, "attempted");
  const [delivery] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(delivery.state, "dead");
  assert.equal(delivery.providerAttempts, 25);
  assert.equal(delivery.dispatchedFailureAttempts, 24);
  assert.equal(delivery.leaseOwner, null);
});


for (const { failure, initialAttempts } of [
  { failure: { kind: "transient_failure" as const, reasonCode: "provider_unavailable", baseDelayMs: 1000 }, initialAttempts: 3 },
  { failure: { kind: "rate_limited" as const, retryAfterMs: 1000 }, initialAttempts: 24 },
]) {
  test(`an audited ${failure.kind} remains recoverable from retry_wait after automatic budget exhaustion`, async () => {
    const fixture = await seedFixture(2);
    const firstId = fixture.deliveries[0].id;
    await fixture.db.update(externalOutboundDeliveries).set({
      state: "dead", providerAttempts: initialAttempts, ambiguityBudgetProviderAttempts: initialAttempts,
      dispatchedFailureAttempts: initialAttempts, firstDispatchedAt: NOW, stateReason: "deterministic_failure",
    }).where(eq(externalOutboundDeliveries.id, firstId));
    const retry = (expectedProviderAttempts = initialAttempts) => fixture.db.transaction((executor) => recordExternalDeliveryRetryDecision({
      executor, bindingId: fixture.bindingId, bindingEpoch: fixture.bindingEpoch,
      deliveryId: firstId, expectedProviderAttempts, actorId: fixture.owner.id, now: NOW,
    }));
    assert.equal(await retry(), true);
    const attempted = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
      runtime: activeRuntime(fixture), providerResult: failure,
    })));
    assert.equal(attempted.kind, "attempted");
    const [waiting] = await fixture.db.select().from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.id, firstId));
    assert.equal(waiting.state, "retry_wait");
    assert.ok(waiting.nextAttemptAt && waiting.nextAttemptAt > NOW);
    const afterDelay = new Date(waiting.nextAttemptAt!.getTime() + 1);
    const automaticallyBlocked = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
      runtime: activeRuntime(fixture), now: afterDelay,
    })));
    assert.equal(automaticallyBlocked.kind, "blocked");
    assert.equal(await retry(), true, "a replay of the consumed operation is a no-op");
    const replayStillBlocked = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
      runtime: activeRuntime(fixture), now: afterDelay,
    })));
    assert.equal(replayStillBlocked.kind, "blocked", "replaying a consumed request cannot authorize new provider I/O");
    assert.equal((await fixture.db.select().from(externalDeliveryOperatorDecisions)).length, 1);
    assert.equal(await retry(initialAttempts + 1), true, "a fresh observation of the waiting head authorizes a new attempt");
    const calls = { runtime: 0, credential: 0, provider: 0 };
    const tooEarly = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
      runtime: activeRuntime(fixture), calls,
    })));
    assert.equal(tooEarly.kind, "blocked");
    assert.equal(calls.provider, 0, "a manual request cannot bypass the provider delay");
    const recovered = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
      runtime: activeRuntime(fixture), now: afterDelay,
    })));
    assert.equal(recovered.kind, "attempted");
    const [original] = await fixture.db.select().from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.id, firstId));
    assert.equal(original.state, "accepted");
    assert.equal(original.providerAttempts, initialAttempts + 2);
    const next = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
      runtime: activeRuntime(fixture), now: afterDelay,
      providerResult: { kind: "accepted", providerMessageId: "later-message", providerThreadId: null },
    })));
    assert.equal(next.kind, "attempted");
    assert.equal((await fixture.db.select().from(externalDeliveryPartitions))[0].cursorPosition, 2);
  });
}


test("replaying a consumed retry after another definite rejection cannot mint a second attempt", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dead", providerAttempts: 1, ambiguityBudgetProviderAttempts: 1,
    dispatchedFailureAttempts: 1, firstDispatchedAt: NOW, stateReason: "deterministic_failure",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const request = () => fixture.db.transaction((executor) => recordExternalDeliveryRetryDecision({
    executor, bindingId: fixture.bindingId, bindingEpoch: fixture.bindingEpoch,
    deliveryId: fixture.deliveries[0].id, expectedProviderAttempts: 1, actorId: fixture.owner.id, now: NOW,
  }));
  assert.equal(await request(), true);
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const deps = dependencies({ runtime: activeRuntime(fixture), calls,
    providerResult: { kind: "deterministic_failure", reasonCode: "provider_channel_not_found" } });
  assert.equal((await processExternalDeliveryPartitionHead(workerInput(fixture, deps))).kind, "attempted");
  assert.equal(await request(), true);
  await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.equal(calls.provider, 1);
  assert.equal((await fixture.db.select().from(externalDeliveryOperatorDecisions)).length, 1);
});


test("review11055 a manual retry after the age ceiling still honors Slack Retry-After", async () => {
  const fixture = await slackQueueFixture(1);
  await fixture.db.update(externalOutboundDeliveries).set({
    state: "dead", providerAttempts: 1, ambiguityBudgetProviderAttempts: 1,
    dispatchedFailureAttempts: 1, firstDispatchedAt: new Date(NOW.getTime() - 2 * SLACK_BRIDGE_MAX_DELIVERY_AGE_MS),
    stateReason: "age_budget_exhausted",
  }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const request = (expectedProviderAttempts: number) => fixture.db.transaction((executor) => recordExternalDeliveryRetryDecision({
    executor, bindingId: fixture.bindingId, bindingEpoch: fixture.bindingEpoch,
    deliveryId: fixture.deliveries[0].id, expectedProviderAttempts, actorId: fixture.owner.id, now: NOW,
  }));
  assert.equal(await request(1), true);
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const deps = dependencies({ runtime: activeRuntime(fixture), calls,
    providerResult: { kind: "rate_limited", retryAfterMs: 60_000 } });
  assert.equal((await processExternalDeliveryPartitionHead(workerInput(fixture, deps))).kind, "attempted");
  // A fresh deliberate retry also must respect the provider's explicit delay.
  assert.equal(await request(2), false, "age alone no longer requires a second manual authorization");
  const [waiting] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(waiting.state, "retry_wait");
  assert.equal(waiting.nextAttemptAt?.getTime(), NOW.getTime() + 60_000);
  const early = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.equal(calls.provider, 1, "manual age-budget override must not erase Retry-After");
  assert.equal(early.kind, "blocked");
  const recovered = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({
    runtime: activeRuntime(fixture), calls, now: new Date(NOW.getTime() + 60_000),
  })));
  assert.equal(recovered.kind, "attempted");
  assert.equal(calls.provider, 2);
  assert.equal((await fixture.db.select().from(externalOutboundDeliveries))[0].state, "accepted");
});


test("prepared replacement credential is disposed when attempt admission expires", async () => {
  const fixture = await seedFixture();
  let now = NOW;
  let disposed = 0;
  let writes = 0;
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, {
    ...dependencies({ runtime: activeRuntime(fixture) }), now: () => now,
    async prepareProvider() {
      now = new Date(NOW.getTime() + 60_001);
      return { ready: true, async dispose() { disposed += 1; },
        async dispatch() { writes += 1; return { kind: "accepted", providerMessageId: "never" }; } };
    },
  }));
  assert.equal("reason" in result ? result.reason : null, "lease_expired_before_attempt_start");
  assert.equal(disposed, 1);
  assert.equal(writes, 0);
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});


test("an old untouched message starts a fresh authority wait instead of immediate quarantine", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({ createdAt: new Date(NOW.getTime() - 2 * SLACK_BRIDGE_MAX_DELIVERY_AGE_MS) })
    .where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({ runtime: null })));
  assert.equal(result.kind === "authority_blocked" ? result.severity : null, "retrying");
  const [row] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(row.state, "queued");
});

test("exhausted unknown head backs off read-only confirmation then recovers without a new write", async () => {
  const fixture = await seedFixture();
  await fixture.db.update(externalOutboundDeliveries).set({ state: "outcome_unknown", providerAttempts: 4,
    ambiguityBudgetProviderAttempts: 3, dispatchedFailureAttempts: 2, firstDispatchedAt: NOW })
    .where(eq(externalOutboundDeliveries.id, fixture.deliveries[0].id));
  let clock = NOW;
  let reads = 0;
  const deps: ExternalDeliveryWorkerDependencies = {
    ...dependencies({ runtime: activeRuntime(fixture) }), now: () => clock,
    async prepareProvider() {
      reads += 1;
      if (reads === 1) return { ready: false, reason: "reconciliation_rate_limited", retryAfterMs: 60_000 };
      const receipt = { kind: "accepted" as const, providerMessageId: "confirmed-original", reconciled: true };
      return { ready: true, receipt, async dispatch() { throw new Error("read-only confirmation must not dispatch"); } };
    },
  };
  assert.equal((await processExternalDeliveryPartitionHead(workerInput(fixture, deps))).kind, "blocked");
  clock = new Date(NOW.getTime() + 30_001);
  const waiting = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.equal("reason" in waiting ? waiting.reason : null, "reconciliation_backoff_not_due");
  assert.equal(reads, 1, "Retry-After must survive release without illegal nextAttemptAt");
  clock = new Date(NOW.getTime() + 60_001);
  assert.equal((await processExternalDeliveryPartitionHead(workerInput(fixture, deps))).kind, "cursor_recovered");
  assert.equal(reads, 2);
  const [row] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(row.providerAttempts, 4);
  assert.equal(row.state, "accepted");
  assert.equal((await fixture.db.select().from(externalDeliveryAttempts)).length, 0);
});


test("a removed sender in historical work is immediately isolated without provider I/O", async () => {
  const fixture = await seedFixture();
  await fixture.db.delete(serverMembers).where(eq(serverMembers.userId, fixture.owner.id));
  const current = activeRuntime(fixture);
  current.bindingAuthority = { ...current.bindingAuthority, bindingEpoch: current.bindingAuthority.bindingEpoch + 1 };
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({ runtime: current, calls })));
  assert.equal("reason" in result ? result.reason : null, "historical_sender_authority_removed");
  const [row] = await fixture.db.select().from(externalOutboundDeliveries);
  assert.equal(row.state, "quarantined");
  assert.equal(row.providerAttempts, 0);
  assert.deepEqual(calls, { runtime: 1, credential: 0, provider: 0 });
});

async function slackQueueFixture(count = 2, senderType: "user" | "agent" = "user") {
  const fixture = await seedFixture(count, senderType);
  fixture.frozenAuthority.provider = "slack";
  for (const row of fixture.deliveries) {
    const snapshot = row.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
    snapshot.bindingAuthority.provider = "slack";
    await fixture.db.update(externalOutboundDeliveries).set({ renderSnapshot: snapshot as unknown as Record<string, unknown> })
      .where(eq(externalOutboundDeliveries.id, row.id));
  }
  return fixture;
}

for (const departure of ["server", "private_channel", "agent_deleted", "agent_removed", "archive"] as const) {
  test(`Slack pair sends an established message after ${departure}`, async () => {
    const fixture = await slackQueueFixture(2, departure.startsWith("agent") ? "agent" : "user");
    if (departure === "server") await fixture.db.delete(serverMembers).where(eq(serverMembers.userId, fixture.sender.id));
    if (departure === "private_channel") await fixture.db.update(channels).set({ type: "private" }).where(eq(channels.id, fixture.channel.id));
    if (departure === "agent_deleted") await fixture.db.update(agents).set({ deletedAt: NOW }).where(eq(agents.id, fixture.sender.id));
    if (departure === "agent_removed") await fixture.db.delete(channelAgents).where(eq(channelAgents.agentId, fixture.sender.id));
    if (departure === "archive") await fixture.db.update(channels).set({ archivedAt: NOW }).where(eq(channels.id, fixture.channel.id));
    const deps = dependencies({ runtime: activeRuntime(fixture) });
    deps.dispatchProvider = async ({ deliveryId }) => ({ kind: "accepted", providerMessageId: deliveryId });
    for (const expected of fixture.deliveries) {
      const result = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
      assert.equal(result.kind, "attempted");
      if (result.kind !== "attempted") assert.fail("message must reach provider");
      assert.equal(result.deliveryId, expected.id);
      assert.equal(result.deliveryState, "accepted");
    }
    const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.cursorPosition, 2);
  });
}

test("Slack pair keeps its first block time across reasons and resumes after more than 24h", async () => {
  const fixture = await slackQueueFixture();
  const deps = dependencies({ runtime: null });
  const first = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.equal(first.kind, "authority_blocked");
  const late = new Date(NOW.getTime() + 3 * SLACK_BRIDGE_MAX_DELIVERY_AGE_MS);
  const second = await processExternalDeliveryPartitionHead(workerInput(fixture, {
    ...deps, now: () => late, resolveCurrentRuntime: async () => ({ blockedReason: "install_inactive" }),
  }));
  assert.equal(second.kind, "authority_blocked");
  const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.authorityBlockedAt?.toISOString(), NOW.toISOString());
  assert.equal(partition.authorityBlockedReason, "runtime_authority_inactive_or_mismatched:install_inactive");
  const rows = await fixture.db.select().from(externalOutboundDeliveries);
  assert.ok(rows.every((row) => row.state === "queued" && row.providerAttempts === 0));
  const repairedAt = new Date(late.getTime() + 10 * 60_000);
  for (const expected of fixture.deliveries) {
    const sent = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({ runtime: activeRuntime(fixture), now: repairedAt,
        providerResult: { kind: "accepted", providerMessageId: expected.id } })));
    assert.equal(sent.kind, "attempted");
    if (sent.kind === "attempted") assert.equal(sent.deliveryId, expected.id);
  }
  const [cleared] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(cleared.authorityBlockedAt, null);
  assert.equal(cleared.authorityBlockedReason, null);
  assert.equal(cleared.cursorPosition, 2);
});

for (const attempted of [false, true]) {
  test(`Slack pair recovers old quarantine with ${attempted ? "prior attempt through read-only confirmation" : "no attempt in FIFO"}`, async () => {
    const fixture = await slackQueueFixture();
    if (attempted) {
      await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({ runtime: activeRuntime(fixture),
        providerResult: { kind: "outcome_unknown", reasonCode: "lost_response" } })));
    }
    await fixture.db.update(externalOutboundDeliveries).set({ state: "quarantined", nextAttemptAt: null,
      stateReason: "historical_sender_authority_removed" }).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0]!.id));
    let reads = 0;
    let writes = 0;
    const deps = dependencies({ runtime: activeRuntime(fixture) });
    deps.prepareProvider = async ({ reconcileUnknownOutcome }) => {
      if (reconcileUnknownOutcome) {
        reads += 1;
        return { ready: true, receipt: { kind: "accepted", providerMessageId: "original-receipt" },
          dispatch: async () => { throw new Error("already sent must never resend"); } };
      }
      return { ready: true, dispatch: async () => { writes += 1; return { kind: "accepted", providerMessageId: `new-${writes}` }; } };
    };
    const first = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
    assert.equal(first.kind, attempted ? "cursor_recovered" : "attempted");
    assert.equal(reads, attempted ? 1 : 0);
    assert.equal(writes, attempted ? 0 : 1);
    await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
    const [head] = await fixture.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0]!.id));
    assert.equal(head.providerAttempts, 1);
    assert.equal(head.state, "accepted");
    const [partition] = await fixture.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.cursorPosition, 2);
  });
}

test("Slack pair permission rejection waits without exhausting write budget and confirms before resending", async () => {
  const fixture = await slackQueueFixture();
  await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({ runtime: activeRuntime(fixture),
    providerResult: { kind: "deterministic_failure", reasonCode: "provider_deterministic_failure", pairBlockedReason: "slack_permission_missing" } })));
  const [waiting] = await fixture.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, fixture.deliveries[0]!.id));
  assert.equal(waiting.state, "outcome_unknown");
  assert.equal(waiting.dispatchedFailureAttempts, 0);
  const [pair] = await fixture.db.select().from(externalDeliveryPartitions);
  assert.equal(pair.authorityBlockedReason, "slack_permission_missing");
  let reads = 0;
  const deps = dependencies({ runtime: activeRuntime(fixture), now: new Date(NOW.getTime() + 3 * SLACK_BRIDGE_MAX_DELIVERY_AGE_MS) });
  deps.prepareProvider = async ({ reconcileUnknownOutcome }) => {
    assert.equal(reconcileUnknownOutcome, true);
    reads += 1;
    return { ready: true, dispatch: async () => ({ kind: "accepted", providerMessageId: "repaired" }) };
  };
  const restored = await processExternalDeliveryPartitionHead(workerInput(fixture, deps));
  assert.equal(reads, 1);
  assert.equal(restored.kind === "attempted" ? restored.deliveryState : null, "accepted");
});


test("an empty body without a frozen attachment is rejected before authority access", async () => {
  const fixture = await seedFixture();
  const original = fixture.deliveries[0];
  const snapshot = { ...(original.renderSnapshot as unknown as SlackBridgeRenderSnapshot), sanitizedText: "", attachments: [] };
  await fixture.db.update(externalOutboundDeliveries).set({ renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot) }).where(eq(externalOutboundDeliveries.id, original.id));
  const calls = { runtime: 0, credential: 0, provider: 0 };
  const result = await processExternalDeliveryPartitionHead(workerInput(fixture, dependencies({ runtime: activeRuntime(fixture), calls })));
  assert.deepEqual(result, { kind: "blocked", reason: "invalid_frozen_snapshot", deliveryId: original.id });
  assert.deepEqual(calls, { runtime: 0, credential: 0, provider: 0 });
});
