import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";

import { closeDatabase, getDb, initDatabase } from "../db/index";
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
} from "../db/schema";
import type { ExternalAttachmentCompletionRequest, ExternalOutboundAttachmentProviderAdapter } from "./externalAttachmentProviderAdapter";
import { createOutboundExternalAttachmentTransferWithExecutor } from "./externalAttachmentTransferService";
import type { SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import {
  dispatchExternalOutboundAttachments,
  finalizeAcceptedOutboundAttachmentFacts,
  prepareOutboundAttachmentSourceDigests,
  reconcileExternalOutboundAttachments,
} from "./externalOutboundAttachmentCoordinator";
import type { StorageBackend } from "./storageService";

const NOW = new Date("2026-09-05T02:00:00.000Z");

beforeEach(async () => { await initDatabase("pglite://"); });
afterEach(async () => { await closeDatabase(); });

async function fixture(hashless = false) {
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
      contentHash: hashless ? null : contentHash,
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
    }).returning();
    sourceAttachments.push({ attachment, object, body });
  }
  const bindingId = randomUUID();
  const [partition] = await db.insert(externalDeliveryPartitions).values({ bindingId, bindingEpoch: 1 }).returning();
  const snapshot: SlackBridgeRenderSnapshot = {
    schema: "slack-bridge-render-snapshot.v4",
    sourceMessageId: message.id,
    sourceMessageSeq: message.seq,
    canonicalConversationId: channel.id,
    level: "top_level",
    canonicalRootMessageId: null,
    sourcePermalink: `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=${message.id}`,
    senderType: "user",
    senderId: owner.id,
    authorName: owner.name,
    authorPresentation: {
      displayName: owner.name,
      fallbackKind: "human",
      avatar: null,
    },
    sanitizedText: message.content,
    externalMentions: [],
    raftMentionSubstitutions: [],
    attachments: sourceAttachments.map(({ attachment, object }, messagePosition) => ({
      sourceAttachmentId: attachment.id,
      objectId: object.id,
      originServerId: server.id,
      storageKey: object.storageKey,
      filename: attachment.filename,
      mimeType: object.mimeType,
      sizeBytes: object.sizeBytes,
      contentDigest: object.contentHash,
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
      reconciliationMarker: createHash("sha256").update(randomUUID()).digest("base64url"),
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

test("hashless direct uploads are hashed before any provider ticket and then delivered", async () => {
  const state = await fixture(true);
  const provider = adapter();
  assert.deepEqual(await prepareOutboundAttachmentSourceDigests({
    db: state.db, deliveryId: state.delivery.id, snapshot: state.snapshot,
    storage: state.storage, leaseOwner: "hashless-prepare", now: () => NOW,
  }), { ready: true });
  const result = await dispatchExternalOutboundAttachments({
    db: state.db, deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker, snapshot: state.snapshot,
    adapter: provider.value, storage: state.storage, providerRootThreadId: null,
    leaseOwner: "hashless-worker", now: () => NOW,
  });
  assert.deepEqual(result, { kind: "accepted", providerMessageId: "provider-message-1" });
  assert.deepEqual(provider.counts(), { ticketCalls: 2, uploadCalls: 2, completeCalls: 1, correlationCalls: 1 });
  const jobs = await state.db.select().from(externalAttachmentTransferJobs);
  for (const source of state.sourceAttachments) {
    const job = jobs.find((candidate) => candidate.sourceAttachmentId === source.attachment.id);
    assert.equal(job?.frozenContentDigest, createHash("sha256").update(source.body).digest("hex"));
  }
});

test("hashless source read failure makes no provider call and remains retryable", async () => {
  const state = await fixture(true);
  const provider = adapter();
  const storage = { ...state.storage, async get() { throw new Error("unavailable"); } };
  const result = await prepareOutboundAttachmentSourceDigests({
    db: state.db, deliveryId: state.delivery.id, snapshot: state.snapshot, storage,
    leaseOwner: "hashless-prepare", now: () => NOW,
  });
  assert.deepEqual(result, { ready: false, reason: "attachment_source_read_failed" });
  assert.deepEqual(provider.counts(), { ticketCalls: 0, uploadCalls: 0, completeCalls: 0, correlationCalls: 0 });
  const [job] = await state.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.sourceAttachmentId, state.sourceAttachments[0]!.attachment.id));
  assert.equal(job.state, "retry_wait");
  assert.equal(job.frozenContentDigest, null);
});

test("aborting a stalled source stream releases the claim for retry", async () => {
  const state = await fixture(true);
  const controller = new AbortController();
  let opened!: () => void;
  const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
  const storage = { ...state.storage, async get() { opened(); return new Readable({ read() {} }); } };
  const preparation = prepareOutboundAttachmentSourceDigests({
    db: state.db, deliveryId: state.delivery.id, snapshot: state.snapshot, storage,
    leaseOwner: "hashless-prepare", now: () => NOW, signal: controller.signal,
  });
  await openedPromise;
  controller.abort();
  assert.deepEqual(await preparation, { ready: false, reason: "attachment_source_read_failed" });
  const [job] = await state.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.sourceAttachmentId, state.sourceAttachments[0]!.attachment.id));
  assert.equal(job.state, "retry_wait");
  assert.equal(job.leaseOwner, null);
});

test("hashless wrong-size source is retained for retry with an explicit reason", async () => {
  const state = await fixture(true);
  const storage = { ...state.storage, async get() { return Readable.from(Buffer.from("x")); } };
  const result = await prepareOutboundAttachmentSourceDigests({
    db: state.db, deliveryId: state.delivery.id, snapshot: state.snapshot, storage,
    leaseOwner: "hashless-prepare", now: () => NOW,
  });
  assert.deepEqual(result, { ready: false, reason: "attachment_source_size_mismatch" });
  const [job] = await state.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.sourceAttachmentId, state.sourceAttachments[0]!.attachment.id));
  assert.equal(job.state, "retry_wait");
  assert.equal(job.lastErrorClass, "attachment_source_size_mismatch");
  assert.deepEqual(await prepareOutboundAttachmentSourceDigests({
    db: state.db, deliveryId: state.delivery.id, snapshot: state.snapshot, storage: state.storage,
    leaseOwner: "hashless-recovery", now: () => new Date(NOW.getTime() + 31_000),
  }), { ready: true });
});

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
  assert.equal(await reconcileExternalOutboundAttachments({ db: state.db, deliveryId: state.delivery.id,
    snapshot: state.snapshot, adapter: provider.value, providerRootThreadId: null,
    reconciliationMarker: state.delivery.reconciliationMarker }), null,
    "a private-upload uncertainty has not crossed the visible completion fence");
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

for (const avatar of [null, { publicUrl: "https://cdn.example.test/author.webp", contentDigest: "a".repeat(32) }]) {
  test(`file completion preserves frozen author presentation with ${avatar ? "an avatar" : "no avatar"}`, async () => {
    const state = await fixture();
    const snapshot = { ...state.snapshot, authorPresentation: { ...state.snapshot.authorPresentation, avatar } };
    const provider = adapter();
    const complete = provider.value.completeOutboundMessage;
    let observedAuthor: ExternalAttachmentCompletionRequest["author"] | undefined;
    provider.value.completeOutboundMessage = async (input) => {
      observedAuthor = input.completion.author;
      return complete(input);
    };
    const result = await dispatchExternalOutboundAttachments({
      db: state.db, deliveryId: state.delivery.id, reconciliationMarker: state.delivery.reconciliationMarker,
      snapshot, adapter: provider.value, storage: state.storage, providerRootThreadId: null,
      leaseOwner: "author-presentation-worker", now: () => NOW,
    });
    assert.equal(result.kind, "accepted");
    assert.deepEqual(observedAuthor, {
      displayName: snapshot.authorPresentation.displayName, avatarPublicUrl: avatar?.publicUrl ?? null,
      fallbackKind: snapshot.authorPresentation.fallbackKind,
    });
  });
}

test("a positively missing attachment preserves body and sends the remaining file", async () => {
  const { digestSlackBridgeRenderSnapshot } = await import("./externalDeliveryOutboxService");
  const { prepareSlackAttachmentFallbackPlan, readSlackAttachmentFallbackForClaim } = await import("./slackAttachmentFallbackPlan");
  const state = await fixture();
  const snapshot: SlackBridgeRenderSnapshot = { ...state.snapshot,
    bindingAuthority: { ...state.snapshot.bindingAuthority, provider: "slack" } };
  const digest = digestSlackBridgeRenderSnapshot(snapshot);
  await state.db.update(externalOutboundDeliveries).set({ renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digest }).where(eq(externalOutboundDeliveries.id, state.delivery.id));
  const missing = state.sourceAttachments[0]!;
  const storage: StorageBackend = { ...state.storage,
    async probeObjectPresence(key) { return key === missing.object.storageKey ? "missing" : "present"; },
    async get(key, signal) { if (key === missing.object.storageKey) throw new Error("source missing"); return state.storage.get(key, signal); },
  };
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan({ db: state.db, deliveryId: state.delivery.id,
    bindingId: state.delivery.bindingId, bindingEpoch: state.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true }), { kind: "planned", revision: 1 });
  await state.db.transaction(async tx => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "parent-worker",
      leaseGeneration: 2, leaseExpiresAt: new Date(NOW.getTime() + 60_000), leaseOriginState: "queued" })
      .where(eq(externalOutboundDeliveries.id, state.delivery.id));
  });
  const claim = { db: state.db, deliveryId: state.delivery.id, bindingId: state.delivery.bindingId,
    bindingEpoch: state.delivery.bindingEpoch, leaseOwner: "parent-worker", leaseGeneration: 2, snapshot, now: () => NOW };
  const plan = await readSlackAttachmentFallbackForClaim(claim);
  assert.deepEqual(plan, { kind: "planned", revision: 1, transport: "files",
    includedAttachmentIds: [state.sourceAttachments[1]!.attachment.id], omittedAttachmentIds: [missing.attachment.id] });
  assert.deepEqual(await readSlackAttachmentFallbackForClaim({ ...claim, leaseGeneration: 1 }), { kind: "unavailable" });
  assert.equal(plan.kind, "planned");
  const provider = adapter();
  const completions: ExternalAttachmentCompletionRequest[] = [];
  const originalComplete = provider.value.completeOutboundMessage;
  provider.value.completeOutboundMessage = async (input) => { completions.push(input.completion); return originalComplete(input); };
  const result = await dispatchExternalOutboundAttachments({ db: state.db, deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker, snapshot, adapter: provider.value,
    storage, providerRootThreadId: null, leaseOwner: "fallback-worker", now: () => NOW,
    selection: plan.kind === "planned" ? plan : undefined,
    renderedText: `${state.message.content}\n\n[One or more attachments unavailable]`,
    admitWrite: async tx => { await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`); },
  });
  assert.deepEqual(result, { kind: "accepted", providerMessageId: "provider-message-1" });
  assert.deepEqual(provider.uploadFileIds(), [state.sourceAttachments[1]!.attachment.id]);
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0]!.providerFileIds, [`provider-${state.sourceAttachments[1]!.attachment.id}`]);
  assert.equal(completions[0]!.renderedText, `${state.message.content}\n\n[One or more attachments unavailable]`);
});

test("a claimed fallback plan rejects expired, stale and substituted snapshots", async () => {
  const { digestSlackBridgeRenderSnapshot } = await import("./externalDeliveryOutboxService");
  const { prepareSlackAttachmentFallbackPlan, readSlackAttachmentFallbackForClaim } = await import("./slackAttachmentFallbackPlan");
  const state = await fixture();
  const snapshot: SlackBridgeRenderSnapshot = { ...state.snapshot,
    bindingAuthority: { ...state.snapshot.bindingAuthority, provider: "slack" } };
  const digest = digestSlackBridgeRenderSnapshot(snapshot);
  await state.db.update(externalOutboundDeliveries).set({ renderSnapshot: snapshot as unknown as Record<string, unknown>,
    renderSnapshotDigest: digest }).where(eq(externalOutboundDeliveries.id, state.delivery.id));
  const missing = state.sourceAttachments[0]!;
  const storage: StorageBackend = { ...state.storage,
    async probeObjectPresence(key) { return key === missing.object.storageKey ? "missing" : "present"; },
    async get(key, signal) { if (key === missing.object.storageKey) throw new Error("source missing"); return state.storage.get(key, signal); },
  };
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan({ db: state.db, deliveryId: state.delivery.id,
    bindingId: state.delivery.bindingId, bindingEpoch: state.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true }), { kind: "planned", revision: 1 });
  await state.db.transaction(async tx => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "parent-worker",
      leaseGeneration: 2, leaseExpiresAt: new Date(NOW.getTime() + 60_000), leaseOriginState: "queued" })
      .where(eq(externalOutboundDeliveries.id, state.delivery.id));
  });
  const claim = { db: state.db, deliveryId: state.delivery.id, bindingId: state.delivery.bindingId,
    bindingEpoch: state.delivery.bindingEpoch, leaseOwner: "parent-worker", leaseGeneration: 2, snapshot, now: () => NOW };
  assert.deepEqual(await readSlackAttachmentFallbackForClaim(claim), { kind: "planned", revision: 1, transport: "files",
    includedAttachmentIds: [state.sourceAttachments[1]!.attachment.id], omittedAttachmentIds: [missing.attachment.id] });
  assert.deepEqual(await readSlackAttachmentFallbackForClaim({ ...claim, leaseGeneration: 1 }), { kind: "unavailable" });
  assert.deepEqual(await readSlackAttachmentFallbackForClaim({ ...claim, now: () => new Date(NOW.getTime() + 60_000) }), { kind: "unavailable" });
  assert.deepEqual(await readSlackAttachmentFallbackForClaim({ ...claim, leaseOwner: "another-worker" }), { kind: "unavailable" });
  assert.deepEqual(await readSlackAttachmentFallbackForClaim({ ...claim, snapshot: { ...snapshot, sanitizedText: "changed" } }), { kind: "unavailable" });
  let reads = 0;
  assert.deepEqual(await readSlackAttachmentFallbackForClaim({ ...claim, now: () =>
    new Date(NOW.getTime() + (reads++ === 0 ? 0 : 60_000)) }), { kind: "unavailable" }, "the lease may expire while locking plan jobs");
});


test("private upload authority failure closes its source and retains a retryable file job", async () => {
  const state = await fixture();
  const provider = adapter();
  const source = Readable.from(state.sourceAttachments[0]!.body);
  provider.value.uploadOutboundAsset = async () => { throw new Error("synthetic authority unavailable"); };
  provider.value.classifyFailure = () => ({ class: "authority_revoked", reason: "synthetic_authority_unavailable",
    retryAfterMs: null, scope: "occurrence_local" });
  const result = await dispatchExternalOutboundAttachments({ db: state.db, deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker, snapshot: state.snapshot, adapter: provider.value,
    storage: { ...state.storage, async get() { return source; } }, providerRootThreadId: null,
    leaseOwner: "private-upload-recovery", now: () => NOW, prepareOnly: true });
  assert.deepEqual(result, { kind: "transient_failure", reasonCode: "synthetic_authority_unavailable", baseDelayMs: 30_000 });
  assert.equal(source.destroyed, true, "a failed permission check must not retain an unread storage connection");
  const jobs = await state.db.select().from(externalAttachmentTransferJobs);
  assert.ok(jobs.some(job => job.state === "retry_wait" && job.assetId === null));
  assert.ok(jobs.every(job => job.terminalAt === null));
  assert.equal(provider.counts().completeCalls, 0);
});

test("a stale parent cannot publish privately prepared files; its successor reuses them", async () => {
  const state = await fixture();
  const provider = adapter();
  const input = { db: state.db, deliveryId: state.delivery.id,
    reconciliationMarker: state.delivery.reconciliationMarker, snapshot: state.snapshot, adapter: provider.value,
    storage: state.storage, providerRootThreadId: null, leaseOwner: "stale-parent", now: () => NOW };
  await assert.rejects(dispatchExternalOutboundAttachments({ ...input,
    admitCompletion: async () => { throw new Error("attachment_parent_lease_lost"); },
  }), /attachment_parent_lease_lost/);
  assert.equal(provider.counts().completeCalls, 0, "the only publication boundary validates the parent claim");
  const jobs = await state.db.select().from(externalAttachmentTransferJobs);
  assert.ok(jobs.every(job => job.phase === "complete" && job.state === "queued"));
  assert.equal((await dispatchExternalOutboundAttachments({ ...input, leaseOwner: "successor" })).kind, "accepted");
  assert.deepEqual(provider.counts(), { ticketCalls: 2, uploadCalls: 2, completeCalls: 1, correlationCalls: 1 });
});

test("new omission plans are globally bounded while unchanged retries cost no additional budget", async () => {
  const { digestSlackBridgeRenderSnapshot } = await import("./externalDeliveryOutboxService");
  const { prepareSlackAttachmentFallbackPlan } = await import("./slackAttachmentFallbackPlan");
  const requests: Array<Parameters<typeof prepareSlackAttachmentFallbackPlan>[0]> = [];
  for (let index = 0; index < 5; index++) {
    const state = await fixture();
    const snapshot: SlackBridgeRenderSnapshot = { ...state.snapshot,
      bindingAuthority: { ...state.snapshot.bindingAuthority, provider: "slack" } };
    await state.db.update(externalOutboundDeliveries).set({ renderSnapshot: snapshot as unknown as Record<string, unknown>,
      renderSnapshotDigest: digestSlackBridgeRenderSnapshot(snapshot) }).where(eq(externalOutboundDeliveries.id, state.delivery.id));
    requests.push({ db: state.db, deliveryId: state.delivery.id, bindingId: state.delivery.bindingId,
      bindingEpoch: state.delivery.bindingEpoch, snapshot, storage: { ...state.storage, async probeObjectPresence() { return "missing"; } },
      now: () => NOW, assertWriterFleetFenced: async () => true });
  }
  for (const input of requests.slice(0, 4)) assert.deepEqual(await prepareSlackAttachmentFallbackPlan(input), { kind: "planned", revision: 1 });
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(requests[0]!), { kind: "planned", revision: 1 });
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(requests[4]!), { kind: "source_unavailable" });
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan({ ...requests[4]!, now: () => new Date(NOW.getTime() + 60_001) }),
    { kind: "planned", revision: 1 });
});
