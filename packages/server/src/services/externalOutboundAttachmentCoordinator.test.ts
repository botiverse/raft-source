import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import {
  attachmentObjects,
  attachments,
  channels,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalDeliveryPartitions,
  externalMessageLinks,
  externalOutboundDeliveries,
  messages,
  servers,
  users,
} from "../db/schema.js";
import type { ExternalOutboundAttachmentProviderAdapter } from "./externalAttachmentProviderAdapter.js";
import { createOutboundExternalAttachmentTransferWithExecutor } from "./externalAttachmentTransferService.js";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService.js";
import {
  dispatchExternalOutboundAttachments,
  finalizeAcceptedOutboundAttachmentFacts,
} from "./externalOutboundAttachmentCoordinator.js";
import type { StorageBackend } from "./storageService.js";

const NOW = new Date("2026-09-05T02:00:00.000Z");

beforeEach(async () => { await initDatabase("pglite://"); });
afterEach(async () => { await closeDatabase(); });

async function fixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `outbound-asset-${randomUUID()}@raft.test`,
    name: `outbound-asset-${randomUUID().slice(0, 8)}`,
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Outbound asset",
    slug: `outbound-asset-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `outbound-asset-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "two files",
    messageType: "chat",
  }).returning();
  const bodies = [Buffer.from("first-file"), Buffer.from("second-file")];
  const sourceAttachments: Array<{
    attachment: typeof attachments.$inferSelect;
    object: typeof attachmentObjects.$inferSelect;
    body: Buffer;
  }> = [];
  for (const [messagePosition, body] of bodies.entries()) {
    const contentHash = createHash("sha256").update(body).digest("hex");
    const [object] = await db.insert(attachmentObjects).values({
      originServerId: server.id,
      uploaderId: owner.id,
      uploaderType: "user",
      storageKey: `${server.id}/file-${messagePosition}.txt`,
      contentHash,
      mimeType: "text/plain",
      sizeBytes: body.length,
    }).returning();
    const [attachment] = await db.insert(attachments).values({
      objectId: object.id,
      messageId: message.id,
      messagePosition,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: `file-${messagePosition}.txt`,
      mimeType: "text/plain",
      sizeBytes: body.length,
      storageKey: object.storageKey,
      contentHash,
    }).returning();
    sourceAttachments.push({ attachment, object, body });
  }
  const bindingId = randomUUID();
  const [partition] = await db.insert(externalDeliveryPartitions).values({ bindingId, bindingEpoch: 1 }).returning();
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
    authorName: owner.name,
    authorAvatarDigest: null,
    authorPolicy: {
      policyId: randomUUID(),
      serverId: server.id,
      consentRevision: 1,
      displayName: owner.name,
      fallbackKind: "human",
      avatar: null,
    },
    sanitizedText: message.content,
    externalMentions: [],
    attachments: sourceAttachments.map(({ attachment, object }, messagePosition) => ({
      sourceAttachmentId: attachment.id,
      objectId: object.id,
      originServerId: server.id,
      storageKey: object.storageKey,
      filename: attachment.filename,
      mimeType: object.mimeType,
      sizeBytes: object.sizeBytes,
      contentDigest: object.contentHash!,
      messagePosition,
    })),
    bindingAuthority: {
      provider: "fixture-im",
      environment: "test",
      appRegistrationId: "registration-1",
      installId: "install-1",
      workspaceId: "workspace-1",
      connectionEpoch: 1,
      bindingId,
      bindingEpoch: 1,
      memberRevision: 1,
      contextRevision: 1,
      consentRevision: 1,
      privacyClass: "public",
      raftChannelId: channel.id,
      providerAuthorityId: "workspace-1",
      providerConversationId: "conversation-1",
    },
    enqueueRuntimeRevision: "runtime-1",
  };
  const [delivery] = await db.transaction(async (tx) => {
    await tx.update(externalDeliveryPartitions).set({ lastEnqueuedPosition: 1 })
      .where(eq(externalDeliveryPartitions.id, partition.id));
    return tx.insert(externalOutboundDeliveries).values({
      sourceMessageId: message.id,
      bindingId,
      bindingEpoch: 1,
      partitionPosition: 1,
      enqueueRuntimeRevision: "runtime-1",
      renderSnapshotSchema: snapshot.schema,
      renderSnapshot: snapshot as unknown as Record<string, unknown>,
      renderSnapshotDigest: "a".repeat(64),
      reconciliationMarker: "m".repeat(43),
    }).returning();
  });
  for (const { attachment } of sourceAttachments) {
    await createOutboundExternalAttachmentTransferWithExecutor(db, {
      outboundDeliveryId: delivery.id,
      sourceAttachmentId: attachment.id,
    }, NOW);
  }
  const storage: StorageBackend = {
    async put() {},
    async get(key) {
      const source = sourceAttachments.find((value) => value.object.storageKey === key);
      if (!source) throw new Error("missing source");
      return Readable.from(source.body);
    },
    async delete() {},
  };
  return { db, owner, message, delivery, snapshot, sourceAttachments, storage };
}

function adapter(input: { completionUnknown?: boolean; uploadUnknownOnce?: boolean } = {}) {
  let ticketCalls = 0;
  let uploadCalls = 0;
  const uploadFileIds: string[] = [];
  let completeCalls = 0;
  let correlationCalls = 0;
  const value: ExternalOutboundAttachmentProviderAdapter<{ fileId: string }> = {
    provider: "fixture-im",
    capabilities: {
      inboundDownload: false,
      outboundUpload: true,
      batchCompletion: true,
      authenticatedCorrelation: true,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024,
    },
    async createOutboundUpload({ asset }) {
      ticketCalls += 1;
      return { providerFileId: `provider-${asset.sourceAttachmentId}`, uploadHandle: { fileId: asset.sourceAttachmentId } };
    },
    async uploadOutboundAsset({ handle, bytes, expectedByteSize, expectedContentDigest }) {
      uploadCalls += 1;
      uploadFileIds.push(handle.fileId);
      const chunks: Buffer[] = [];
      for await (const chunk of bytes) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      assert.equal(body.length, expectedByteSize);
      assert.equal(createHash("sha256").update(body).digest("hex"), expectedContentDigest);
      if (input.uploadUnknownOnce && uploadCalls === 1) throw new Error("upload receipt unavailable");
      return { uploadedByteSize: body.length, uploadedContentDigest: expectedContentDigest };
    },
    async completeOutboundMessage() {
      completeCalls += 1;
      return input.completionUnknown
        ? { kind: "outcome_unknown", reason: "completion_timeout" }
        : { kind: "accepted_pending_correlation" };
    },
    async correlateOutboundMessage() {
      correlationCalls += 1;
      return { kind: "matched", providerMessageId: "provider-message-1" };
    },
    classifyFailure() {
      return {
        class: "outcome_unknown",
        reason: "fixture_unknown",
        retryAfterMs: null,
        scope: "occurrence_local",
      };
    },
  };
  return {
    value,
    counts: () => ({ ticketCalls, uploadCalls, completeCalls, correlationCalls }),
    uploadFileIds: () => [...uploadFileIds],
  };
}

test("multi-file upload uses one completion and acceptance links every durable file fact", async () => {
  const state = await fixture();
  const provider = adapter();
  const result = await dispatchExternalOutboundAttachments({
    db: state.db,
    deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker,
    snapshot: state.snapshot,
    adapter: provider.value,
    storage: state.storage,
    providerRootThreadId: null,
    leaseOwner: "outbound-asset-worker",
    now: () => NOW,
  });
  assert.deepEqual(result, { kind: "accepted", providerMessageId: "provider-message-1" });
  assert.deepEqual(provider.counts(), { ticketCalls: 2, uploadCalls: 2, completeCalls: 1, correlationCalls: 1 });
  const [link] = await state.db.insert(externalMessageLinks).values({
    deliveryId: state.delivery.id,
    provider: "fixture-im",
    installId: "install-1",
    providerAuthorityId: "workspace-1",
    providerConversationId: "conversation-1",
    providerMessageId: "provider-message-1",
    bindingId: state.delivery.bindingId,
    bindingEpoch: state.delivery.bindingEpoch,
    connectionEpoch: 1,
    raftMessageId: state.message.id,
    firstDirection: "raft_outbound",
    payloadFingerprint: state.delivery.renderSnapshotDigest,
    outcomeState: "accepted",
    authorityState: "active",
  }).returning();
  await state.db.transaction((tx) => finalizeAcceptedOutboundAttachmentFacts(tx, state.delivery.id, state.snapshot, NOW));
  const jobs = await state.db.select().from(externalAttachmentTransferJobs);
  const assets = await state.db.select().from(externalAttachmentAssets);
  const facts = await state.db.select().from(externalAttachmentMessageFacts);
  assert.ok(jobs.every((job) => job.state === "completed" && job.phase === "link"));
  assert.ok(assets.every((asset) => asset.state === "linked"));
  assert.deepEqual(facts.sort((a, b) => a.orderedPosition - b.orderedPosition).map((fact) => ({
    link: fact.messageLinkId,
    state: fact.state,
    position: fact.orderedPosition,
  })), [
    { link: link.id, state: "linked", position: 0 },
    { link: link.id, state: "linked", position: 1 },
  ]);
});

test("an uncertain one-shot completion is never issued twice and later correlation closes it", async () => {
  const state = await fixture();
  const provider = adapter({ completionUnknown: true });
  const first = await dispatchExternalOutboundAttachments({
    db: state.db,
    deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker,
    snapshot: state.snapshot,
    adapter: provider.value,
    storage: state.storage,
    providerRootThreadId: null,
    leaseOwner: "outbound-asset-worker",
    now: () => NOW,
  });
  assert.equal(first.kind, "outcome_unknown");
  const second = await dispatchExternalOutboundAttachments({
    db: state.db,
    deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker,
    snapshot: state.snapshot,
    adapter: provider.value,
    storage: state.storage,
    providerRootThreadId: null,
    leaseOwner: "outbound-asset-worker",
    now: () => new Date(NOW.getTime() + 30_000),
  });
  assert.deepEqual(second, { kind: "accepted", providerMessageId: "provider-message-1" });
  assert.deepEqual(provider.counts(), { ticketCalls: 2, uploadCalls: 2, completeCalls: 1, correlationCalls: 1 });
});

test("an unknown raw upload is not uploaded again and proceeds through the one-shot completion fence", async () => {
  const state = await fixture();
  const provider = adapter({ uploadUnknownOnce: true });
  const first = await dispatchExternalOutboundAttachments({
    db: state.db,
    deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker,
    snapshot: state.snapshot,
    adapter: provider.value,
    storage: state.storage,
    providerRootThreadId: null,
    leaseOwner: "outbound-asset-worker",
    now: () => NOW,
  });
  assert.deepEqual(first, { kind: "outcome_unknown", reasonCode: "fixture_unknown" });
  const afterUnknown = provider.counts();
  assert.deepEqual(afterUnknown, { ticketCalls: 1, uploadCalls: 1, completeCalls: 0, correlationCalls: 0 });

  const second = await dispatchExternalOutboundAttachments({
    db: state.db,
    deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker,
    snapshot: state.snapshot,
    adapter: provider.value,
    storage: state.storage,
    providerRootThreadId: null,
    leaseOwner: "outbound-asset-worker",
    now: () => new Date(NOW.getTime() + 30_000),
  });
  assert.deepEqual(second, { kind: "accepted", providerMessageId: "provider-message-1" });
  assert.deepEqual(provider.counts(), { ticketCalls: 2, uploadCalls: 2, completeCalls: 1, correlationCalls: 1 });
  assert.deepEqual(provider.uploadFileIds(), state.sourceAttachments.map(({ attachment }) => attachment.id));
});

test("provider file and aggregate capability bounds reject before any upload side effect", async () => {
  const state = await fixture();
  const provider = adapter();
  const oversized = {
    ...state.snapshot,
    attachments: state.snapshot.attachments.map((attachment, index) => (
      index === 0 ? { ...attachment, sizeBytes: provider.value.capabilities.maximumBytesPerFile + 1 } : attachment
    )),
  };
  assert.deepEqual(await dispatchExternalOutboundAttachments({
    db: state.db,
    deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker,
    snapshot: oversized,
    adapter: provider.value,
    storage: state.storage,
    providerRootThreadId: null,
    leaseOwner: "outbound-asset-worker",
    now: () => NOW,
  }), { kind: "deterministic_failure", reasonCode: "attachment_provider_capability_exceeded" });
  assert.deepEqual(provider.counts(), { ticketCalls: 0, uploadCalls: 0, completeCalls: 0, correlationCalls: 0 });
});
