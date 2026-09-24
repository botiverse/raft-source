import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  channels,
  externalActorProjections,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalDeliveryPartitions,
  externalInboundEvents,
  externalOutboundDeliveries,
  messages,
  servers,
  users,
} from "../db/schema.js";
import {
  advanceExternalAttachmentTransferClaim,
  claimExternalAttachmentTransferJob,
  createInboundExternalAttachmentTransferWithExecutor,
  createOutboundExternalAttachmentTransferWithExecutor,
  ExternalAttachmentTransferError,
  markExternalAttachmentTransferOutcomeUnknown,
  recordInboundExternalAttachmentMetadata,
  recordOutboundExternalAttachmentTicket,
  releaseExternalAttachmentTransferClaimForRetry,
  terminalizeExternalAttachmentTransferClaim,
} from "./externalAttachmentTransferService.js";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService.js";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService.js";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService.js";
import { listChannelFiles } from "./channelService.js";
import {
  type ExternalAttachmentProviderAdapter,
  validateExternalAttachmentCapabilityManifest,
} from "./externalAttachmentProviderAdapter.js";

const NOW = new Date("2026-09-05T00:00:00.000Z");
const DIGEST = "a".repeat(64);
const RENDER_DIGEST = "b".repeat(64);
const PAYLOAD_DIGEST = "c".repeat(64);
const MARKER = "m".repeat(43);

beforeEach(async () => {
  await initDatabase("pglite://");
});

afterEach(async () => {
  await closeDatabase();
});

async function seedBase() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `external-attachment-${randomUUID()}@raft.test`,
    name: `external-attachment-${randomUUID().slice(0, 8)}`,
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "External attachment transfer",
    slug: `external-attachment-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `external-attachment-${randomUUID()}`,
    type: "channel",
  }).returning();
  const registrationId = randomUUID();
  const installId = randomUUID();
  const workspaceId = `workspace-${randomUUID()}`;
  const providerAuthorityId = workspaceId;
  const bindingId = randomUUID();
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: registrationId,
    installId,
    workspaceId,
    externalActorId: `actor-${randomUUID()}`,
    displayName: "External attachment author",
    handles: [],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  return {
    db,
    owner,
    server,
    channel,
    actor,
    registrationId,
    installId,
    workspaceId,
    providerAuthorityId,
    bindingId,
  };
}

async function seedInbound() {
  const base = await seedBase();
  const [message] = await base.db.insert(messages).values({
    channelId: base.channel.id,
    senderType: "external_projection",
    senderId: base.actor.id,
    content: "provider file",
    messageType: "chat",
    createdAt: NOW,
  }).returning();
  const [inboundEvent] = await base.db.insert(externalInboundEvents).values({
    provider: "slack",
    environment: "test",
    appRegistrationId: base.registrationId,
    installId: base.installId,
    workspaceId: base.workspaceId,
    providerAuthorityId: base.providerAuthorityId,
    providerConversationId: `conversation-${randomUUID()}`,
    providerEventId: `event-${randomUUID()}`,
    bindingId: base.bindingId,
    bindingEpoch: 1,
    connectionEpoch: 1,
    runtimeRevision: "runtime-v1",
    raftChannelId: base.channel.id,
    privacyClass: "public",
    status: "queued",
    normalizedPayloadDigest: PAYLOAD_DIGEST,
    encryptedPayload: "sealed-fixture",
    envelopeKeyId: "fixture-key",
    payloadExpiresAt: new Date(NOW.getTime() + 60_000),
    receivedAt: NOW,
    updatedAt: NOW,
  }).returning();
  return { ...base, message, inboundEvent };
}

function inboundInput(fixture: Awaited<ReturnType<typeof seedInbound>>) {
  return {
    provider: "slack",
    appRegistrationId: fixture.registrationId,
    installId: fixture.installId,
    workspaceId: fixture.workspaceId,
    providerAuthorityId: fixture.providerAuthorityId,
    providerFileId: "F-provider-1",
    inboundEventId: fixture.inboundEvent.id,
    connectionEpoch: 1,
    bindingId: fixture.bindingId,
    bindingEpoch: 1,
    orderedPosition: 0,
    sourceActorProjectionId: fixture.actor.id,
  };
}

test("provider file replay converges on one asset, message fact, and transfer job", async () => {
  const fixture = await seedInbound();
  const first = await fixture.db.transaction((tx) =>
    createInboundExternalAttachmentTransferWithExecutor(tx, inboundInput(fixture), NOW)
  );
  const replay = await fixture.db.transaction((tx) =>
    createInboundExternalAttachmentTransferWithExecutor(tx, inboundInput(fixture), NOW)
  );

  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  assert.equal(replay.asset.id, first.asset.id);
  assert.equal(replay.messageFact.id, first.messageFact.id);
  assert.equal(replay.job.id, first.job.id);
  assert.equal((await fixture.db.select().from(externalAttachmentAssets)).length, 1);
  assert.equal((await fixture.db.select().from(externalAttachmentMessageFacts)).length, 1);
  assert.equal((await fixture.db.select().from(externalAttachmentTransferJobs)).length, 1);
});

test("one provider file can be re-shared by distinct actors while each occurrence freezes its own author", async () => {
  const fixture = await seedInbound();
  const first = await fixture.db.transaction((tx) =>
    createInboundExternalAttachmentTransferWithExecutor(tx, inboundInput(fixture), NOW)
  );
  const [secondActor] = await fixture.db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: fixture.registrationId,
    installId: fixture.installId,
    workspaceId: fixture.workspaceId,
    externalActorId: `actor-${randomUUID()}`,
    displayName: "Second external author",
    handles: [],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  const [secondEvent] = await fixture.db.insert(externalInboundEvents).values({
    provider: "slack",
    environment: "test",
    appRegistrationId: fixture.registrationId,
    installId: fixture.installId,
    workspaceId: fixture.workspaceId,
    providerAuthorityId: fixture.providerAuthorityId,
    providerConversationId: `conversation-${randomUUID()}`,
    providerEventId: `event-${randomUUID()}`,
    bindingId: fixture.bindingId,
    bindingEpoch: 1,
    connectionEpoch: 1,
    runtimeRevision: "runtime-v1",
    raftChannelId: fixture.channel.id,
    privacyClass: "public",
    status: "queued",
    normalizedPayloadDigest: PAYLOAD_DIGEST,
    encryptedPayload: "sealed-fixture-2",
    envelopeKeyId: "fixture-key",
    payloadExpiresAt: new Date(NOW.getTime() + 60_000),
    receivedAt: NOW,
    updatedAt: NOW,
  }).returning();
  const second = await fixture.db.transaction((tx) =>
    createInboundExternalAttachmentTransferWithExecutor(tx, {
      ...inboundInput(fixture),
      inboundEventId: secondEvent.id,
      sourceActorProjectionId: secondActor.id,
    }, NOW)
  );
  assert.equal(second.asset.id, first.asset.id);
  assert.notEqual(second.messageFact.id, first.messageFact.id);
  assert.equal(first.messageFact.sourceActorProjectionId, fixture.actor.id);
  assert.equal(second.messageFact.sourceActorProjectionId, secondActor.id);
  assert.equal((await fixture.db.select().from(externalAttachmentAssets)).length, 1);
  assert.equal((await fixture.db.select().from(externalAttachmentMessageFacts)).length, 2);

  await assert.rejects(
    fixture.db.transaction((tx) => createInboundExternalAttachmentTransferWithExecutor(tx, {
      ...inboundInput(fixture),
      sourceActorProjectionId: secondActor.id,
    }, NOW)),
    (error: unknown) => error instanceof ExternalAttachmentTransferError
      && error.code === "replay_conflict",
  );
});

test("external attachment attribution rejects a Raft user substituted for the provider actor", async () => {
  const fixture = await seedInbound();
  await assert.rejects(
    fixture.db.transaction((tx) => createInboundExternalAttachmentTransferWithExecutor(tx, {
      ...inboundInput(fixture),
      sourceActorProjectionId: fixture.owner.id,
    }, NOW)),
    (error: unknown) => error instanceof ExternalAttachmentTransferError
      && error.code === "authority_mismatch",
  );
  assert.equal((await fixture.db.select().from(externalAttachmentAssets)).length, 0);
});

test("canonical attachment storage preserves external projection attribution end to end", async () => {
  const fixture = await seedInbound();
  const projectionId = randomUUID();
  const objectId = randomUUID();
  const transferIntentId = randomUUID();
  const storageKey = `${fixture.server.id}/${projectionId}.pdf`;
  await createAttachmentTransferIntent({
    id: transferIntentId,
    reservationId: projectionId,
    objectId,
    serverId: fixture.server.id,
    channelId: fixture.channel.id,
    uploaderId: fixture.actor.id,
    uploaderType: "external_projection",
    filename: "external-plan.pdf",
    mimeType: "application/pdf",
    declaredSizeBytes: 4096,
    expiresAt: new Date(NOW.getTime() + 60_000),
    artifacts: buildAttachmentTransferArtifactPlan({ storageKey, mimeType: "application/pdf" }),
  }, fixture.db, NOW);
  const projection = await fixture.db.transaction(async (tx) => {
    const pending = await createPendingAttachmentProjectionWithExecutor(tx, {
      id: projectionId,
      objectId,
      transferIntentId,
      serverId: fixture.server.id,
      channelId: fixture.channel.id,
      uploaderId: fixture.actor.id,
      uploaderType: "external_projection",
      filename: "external-plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      storageKey,
      contentHash: DIGEST,
    }, NOW);
    const [linked] = await linkAttachmentsToMessageWithExecutor(
      tx,
      [pending.id],
      fixture.message.id,
      fixture.actor.id,
      "new",
      NOW,
    );
    return linked;
  });
  assert.equal(projection.uploaderType, "external_projection");
  assert.equal(projection.uploaderId, fixture.actor.id);
  assert.equal(projection.createdByType, "external_projection");
  const [listed] = await listChannelFiles(fixture.channel.id);
  assert.equal(listed.uploaderType, "external_projection");
  assert.equal(listed.uploaderDisplayName, fixture.actor.displayName);
});

test("metadata is frozen under lease and stale generations cannot complete successor work", async () => {
  const fixture = await seedInbound();
  await fixture.db.transaction((tx) =>
    createInboundExternalAttachmentTransferWithExecutor(tx, inboundInput(fixture), NOW)
  );
  const firstClaim = await fixture.db.transaction((tx) =>
    claimExternalAttachmentTransferJob(tx, { leaseOwner: "worker-a", now: NOW })
  );
  assert.ok(firstClaim);
  const metadata = await fixture.db.transaction((tx) => recordInboundExternalAttachmentMetadata(
    tx,
    firstClaim,
    {
      sourceActorProjectionId: fixture.actor.id,
      filename: "quarterly-plan.pdf",
      declaredSizeBytes: 4096,
      mimeType: "application/pdf",
      providerCreatedAt: NOW,
      now: NOW,
    },
  ));
  assert.equal(metadata.asset.state, "metadata_ready");
  assert.equal(metadata.asset.materializationOwnerJobId, firstClaim.job.id);
  assert.equal(metadata.claim.job.phase, "download");

  const retryAt = new Date(NOW.getTime() + 5_000);
  await fixture.db.transaction((tx) => releaseExternalAttachmentTransferClaimForRetry(
    tx,
    metadata.claim,
    { errorClass: "provider_rate_limited", retryAt, retryPhase: "metadata", now: NOW },
  ));
  assert.equal(await fixture.db.transaction((tx) => claimExternalAttachmentTransferJob(
    tx,
    { leaseOwner: "worker-b", now: new Date(NOW.getTime() + 4_999) },
  )), null);
  const successor = await fixture.db.transaction((tx) => claimExternalAttachmentTransferJob(
    tx,
    { leaseOwner: "worker-b", now: retryAt },
  ));
  assert.ok(successor);
  assert.equal(successor.leaseGeneration, firstClaim.leaseGeneration + 1);
  assert.equal(successor.job.phase, "metadata");
  await assert.rejects(
    fixture.db.transaction((tx) => terminalizeExternalAttachmentTransferClaim(
      tx,
      metadata.claim,
      { state: "failed", errorClass: "stale_worker", now: retryAt },
    )),
    (error: unknown) => error instanceof ExternalAttachmentTransferError
      && error.code === "lease_lost",
  );
  const downloading = await fixture.db.transaction((tx) => advanceExternalAttachmentTransferClaim(
    tx,
    successor,
    { nextPhase: "download", now: retryAt },
  ));
  const advanced = await fixture.db.transaction((tx) => advanceExternalAttachmentTransferClaim(
    tx,
    downloading,
    { nextPhase: "store", now: retryAt },
  ));
  const linking = await fixture.db.transaction((tx) => advanceExternalAttachmentTransferClaim(
    tx,
    advanced,
    { nextPhase: "link", now: retryAt },
  ));
  const done = await fixture.db.transaction((tx) => terminalizeExternalAttachmentTransferClaim(
    tx,
    linking,
    { state: "completed", now: retryAt },
  ));
  assert.equal(done.state, "completed");
  assert.equal(done.lastErrorClass, null);
});

test("database teeth reject a completed transfer before the canonical link phase", async () => {
  const fixture = await seedInbound();
  const created = await fixture.db.transaction((tx) =>
    createInboundExternalAttachmentTransferWithExecutor(tx, inboundInput(fixture), NOW)
  );
  await assert.rejects(
    fixture.db.update(externalAttachmentTransferJobs).set({
      state: "completed",
      terminalAt: NOW,
    }).where(eq(externalAttachmentTransferJobs.id, created.job.id)),
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23514",
  );
  const [unchanged] = await fixture.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.id, created.job.id));
  assert.equal(unchanged.state, "queued");
  assert.equal(unchanged.phase, "metadata");
});

async function seedOutbound() {
  const base = await seedBase();
  const [message] = await base.db.insert(messages).values({
    channelId: base.channel.id,
    senderType: "user",
    senderId: base.owner.id,
    content: "Raft file",
    messageType: "chat",
    createdAt: NOW,
  }).returning();
  const [partition] = await base.db.insert(externalDeliveryPartitions).values({
    bindingId: base.bindingId,
    bindingEpoch: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  const [delivery] = await base.db.transaction(async (tx) => {
    await tx.update(externalDeliveryPartitions).set({
      lastEnqueuedPosition: 1,
      updatedAt: NOW,
    }).where(eq(externalDeliveryPartitions.id, partition.id));
    return tx.insert(externalOutboundDeliveries).values({
      sourceMessageId: message.id,
      bindingId: base.bindingId,
      bindingEpoch: 1,
      partitionPosition: 1,
      enqueueRuntimeRevision: "runtime-v1",
      state: "queued",
      renderSnapshot: {},
      renderSnapshotDigest: RENDER_DIGEST,
      reconciliationMarker: MARKER,
      createdAt: NOW,
      updatedAt: NOW,
    }).returning();
  });
  const [object] = await base.db.insert(attachmentObjects).values({
    originServerId: base.server.id,
    uploaderId: base.owner.id,
    uploaderType: "user",
    storageKey: `${base.server.id}/roadmap.pdf`,
    contentHash: DIGEST,
    mimeType: "application/pdf",
    sizeBytes: 8192,
    createdAt: NOW,
  }).returning();
  const [attachment] = await base.db.insert(attachments).values({
    objectId: object.id,
    messageId: message.id,
    pendingChannelId: null,
    createdById: base.owner.id,
    createdByType: "user",
    messagePosition: 0,
    channelId: base.channel.id,
    uploaderId: base.owner.id,
    uploaderType: "user",
    filename: "roadmap.pdf",
    mimeType: "application/pdf",
    sizeBytes: 8192,
    storageKey: object.storageKey,
    contentHash: DIGEST,
    createdAt: NOW,
  }).returning();
  return { ...base, message, delivery, object, attachment };
}

test("outbound transfer freezes the immutable object and reconciles an uncertain upload", async () => {
  const fixture = await seedOutbound();
  const first = await fixture.db.transaction((tx) =>
    createOutboundExternalAttachmentTransferWithExecutor(tx, {
      outboundDeliveryId: fixture.delivery.id,
      sourceAttachmentId: fixture.attachment.id,
    }, NOW)
  );
  const replay = await fixture.db.transaction((tx) =>
    createOutboundExternalAttachmentTransferWithExecutor(tx, {
      outboundDeliveryId: fixture.delivery.id,
      sourceAttachmentId: fixture.attachment.id,
    }, NOW)
  );
  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  assert.equal(replay.job.frozenObjectId, fixture.object.id);
  assert.equal(replay.job.frozenOriginServerId, fixture.server.id);
  assert.equal(replay.job.frozenStorageKey, fixture.object.storageKey);
  assert.equal(replay.job.frozenContentDigest, DIGEST);

  const claim = await fixture.db.transaction((tx) =>
    claimExternalAttachmentTransferJob(tx, { leaseOwner: "outbound-worker", now: NOW })
  );
  assert.ok(claim);
  const ticket = await fixture.db.transaction((tx) => recordOutboundExternalAttachmentTicket(
    tx,
    claim,
    {
      provider: "slack",
      appRegistrationId: fixture.registrationId,
      installId: fixture.installId,
      workspaceId: fixture.workspaceId,
      providerAuthorityId: fixture.providerAuthorityId,
      providerFileId: "F-upload-1",
      now: NOW,
    },
  ));
  assert.equal(ticket.asset.raftObjectId, fixture.object.id);
  assert.equal(ticket.claim.job.phase, "upload");
  const reconcileAt = new Date(NOW.getTime() + 10_000);
  const unknown = await fixture.db.transaction((tx) => markExternalAttachmentTransferOutcomeUnknown(
    tx,
    ticket.claim,
    { errorClass: "provider_upload_ambiguous", reconcileAt, now: NOW },
  ));
  assert.equal(unknown.state, "outcome_unknown");
  assert.equal(unknown.phase, "upload");
  const reconcileClaim = await fixture.db.transaction((tx) => claimExternalAttachmentTransferJob(
    tx,
    { leaseOwner: "reconcile-worker", now: reconcileAt },
  ));
  assert.ok(reconcileClaim);
  assert.equal(reconcileClaim.job.phase, "upload");
  assert.equal(reconcileClaim.job.attempts, 2);
  assert.equal(reconcileClaim.job.assetId, ticket.asset.id);
});

test("outbound replay rejects mutable source drift after the first freeze", async () => {
  const fixture = await seedOutbound();
  await fixture.db.transaction((tx) => createOutboundExternalAttachmentTransferWithExecutor(tx, {
    outboundDeliveryId: fixture.delivery.id,
    sourceAttachmentId: fixture.attachment.id,
  }, NOW));
  await fixture.db.update(attachmentObjects).set({ contentHash: "d".repeat(64) })
    .where(eq(attachmentObjects.id, fixture.object.id));
  await assert.rejects(
    fixture.db.transaction((tx) => createOutboundExternalAttachmentTransferWithExecutor(tx, {
      outboundDeliveryId: fixture.delivery.id,
      sourceAttachmentId: fixture.attachment.id,
    }, NOW)),
    (error: unknown) => error instanceof ExternalAttachmentTransferError
      && error.code === "replay_conflict",
  );
});

test("a fake non-production provider satisfies the generic streaming and correlation contract", async () => {
  type DownloadHandle = Readonly<{ opaqueDownload: string }>;
  type UploadHandle = Readonly<{ opaqueUpload: string }>;
  const bytes = Buffer.from("provider-neutral-file", "utf8");
  const contentDigest = createHash("sha256").update(bytes).digest("hex");
  let completedFileIds: readonly string[] = [];
  const adapter: ExternalAttachmentProviderAdapter<DownloadHandle, UploadHandle> = {
    provider: "fixture-im",
    capabilities: validateExternalAttachmentCapabilityManifest({
      inboundDownload: true,
      outboundUpload: true,
      batchCompletion: true,
      authenticatedCorrelation: true,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024 * 1024,
    }),
    async inspectInboundAsset({ providerFileId }) {
      return {
        metadata: {
          providerFileId,
          sourceExternalActorId: "fixture-actor",
          filename: "fixture.txt",
          declaredSizeBytes: bytes.length,
          mimeType: "text/plain",
          providerCreatedAt: NOW,
        },
        downloadHandle: { opaqueDownload: "memory-download" },
      };
    },
    async *downloadInboundAsset() {
      yield bytes;
    },
    async createOutboundUpload() {
      return {
        providerFileId: "fixture-file-1",
        uploadHandle: { opaqueUpload: "memory-upload" },
      };
    },
    async uploadOutboundAsset({ bytes: source, expectedByteSize, expectedContentDigest }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) chunks.push(chunk);
      const uploaded = Buffer.concat(chunks);
      assert.equal(uploaded.length, expectedByteSize);
      assert.equal(createHash("sha256").update(uploaded).digest("hex"), expectedContentDigest);
      return {
        uploadedByteSize: uploaded.length,
        uploadedContentDigest: createHash("sha256").update(uploaded).digest("hex"),
      };
    },
    async completeOutboundMessage({ completion }) {
      completedFileIds = completion.providerFileIds;
      return { kind: "accepted_pending_correlation" };
    },
    async correlateOutboundMessage({ correlation }) {
      return completedFileIds.join(",") === correlation.providerFileIds.join(",")
        ? { kind: "matched", providerMessageId: "fixture-message-1" }
        : { kind: "conflict", reason: "provider_file_set_mismatch" };
    },
    classifyFailure() {
      return {
        class: "transient",
        reason: "fixture_failure",
        retryAfterMs: null,
        scope: "asset_global",
      };
    },
  };
  const authority = {
    provider: adapter.provider,
    appRegistrationId: "fixture-registration",
    installId: "fixture-install",
    workspaceId: "fixture-workspace",
    providerAuthorityId: "fixture-authority",
    providerConversationId: "fixture-conversation",
    connectionEpoch: 1,
    bindingId: "fixture-binding",
    bindingEpoch: 1,
  };
  const controller = new AbortController();
  const inspected = await adapter.inspectInboundAsset({
    authority,
    providerFileId: "fixture-file-1",
    signal: controller.signal,
  });
  const downloaded: Uint8Array[] = [];
  for await (const chunk of adapter.downloadInboundAsset({
    authority,
    handle: inspected.downloadHandle,
    maximumBytes: bytes.length,
    signal: controller.signal,
  })) downloaded.push(chunk);
  assert.equal(Buffer.concat(downloaded).toString("utf8"), bytes.toString("utf8"));
  const ticket = await adapter.createOutboundUpload({
    authority,
    asset: {
      sourceAttachmentId: randomUUID(),
      filename: "fixture.txt",
      byteSize: bytes.length,
      mimeType: "text/plain",
      contentDigest,
    },
    signal: controller.signal,
  });
  async function* uploadBytes() {
    yield bytes;
  }
  const uploaded = await adapter.uploadOutboundAsset({
    authority,
    handle: ticket.uploadHandle,
    bytes: uploadBytes(),
    expectedByteSize: bytes.length,
    expectedContentDigest: contentDigest,
    signal: controller.signal,
  });
  assert.equal(uploaded.uploadedByteSize, bytes.length);
  const completion = {
    providerConversationId: "fixture-conversation",
    providerRootThreadId: null,
    providerFileIds: [ticket.providerFileId],
    renderedText: "fixture",
    reconciliationMarker: MARKER,
    author: {
      displayName: "Fixture author",
      avatarPublicUrl: null,
      fallbackKind: "human" as const,
    },
  };
  assert.deepEqual(await adapter.completeOutboundMessage({
    authority,
    completion,
    signal: controller.signal,
  }), { kind: "accepted_pending_correlation" });
  assert.deepEqual(await adapter.correlateOutboundMessage({
    authority,
    correlation: completion,
    signal: controller.signal,
  }), { kind: "matched", providerMessageId: "fixture-message-1" });
});

test("the generic attachment kernel and adapter contract contain no first-provider dependency", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  for (const filename of [
    "externalAttachmentTransferService.ts",
    "externalAttachmentProviderAdapter.ts",
    "externalInboundAttachmentStorageService.ts",
    "externalInboundAttachmentWorkerService.ts",
  ]) {
    const source = readFileSync(`${directory}/${filename}`, "utf8");
    assert.doesNotMatch(source, /slack/i, `${filename} must remain provider-neutral`);
  }
});
