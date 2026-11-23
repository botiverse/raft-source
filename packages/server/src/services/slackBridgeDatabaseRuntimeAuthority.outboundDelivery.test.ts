import { parseSlackReconciliationScan } from "./slackReconciliationScan";
import { reserveSlackUsergroupIdentity } from "./slackUsergroupIdentityStore";
import { listSlackPairHeads } from "./slackBridgePairQueue";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  attachmentObjects,
  attachments,
  channels,
  channelAgents,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAttachmentTransferJobs,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  slackAttachmentFallbackPlans,
  externalMessageLinks,
  externalMentionFacts,
  jointChannels,
  jointChannelServers,
  messages,
  messageMentions,
  slackUsergroupIdentities,
  serverMembers,
  users,
} from "../db/schema";
import { createSlackBridgeDatabaseOutboundRuntime } from "./slackBridgeDatabaseOutboundRuntime";
import { processExternalDeliveryPartitionHead, __setExternalDeliveryAttemptRowLockHookForTests } from "./externalDeliveryWorkerService";
import {
  enqueueSlackBridgeOutboundDelivery,
  digestSlackBridgeRenderSnapshot,
  mintSlackBridgeReconciliationMarker,
  type SlackBridgeRenderSnapshot,
} from "./externalDeliveryOutboxService";
import { createSlackBridgeProviderRuntime, type SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createSlackBridgeEnvCredentialCipher } from "./slackBridgeEnvSecrets";
import { createServer } from "./serverService";
import { broadcastAndDeliver } from "./messageService";
import { withChannelDelivery } from "../test/orchestratorStub";
import { createSlackDatabaseInboundWorkerRuntimeResolver, slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import { __setStorageForTests, resetStorageForTests, type StorageBackend } from "./storageService";
import { prepareSlackAttachmentFallbackPlan, validateSlackAttachmentFallbackPlan } from "./slackAttachmentFallbackPlan";
import { NOW, EXPIRES, fixture, reauthorizeSamePair, storeWorkerCustody, resolveCurrentOutboundAuthorityOrNull } from "./slackBridgeDatabaseRuntimeAuthority.testkit";

afterEach(async () => {
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  resetStorageForTests();
  await closeTestDatabase();
});

test("ordinary message send enqueues a hashless attachment when retired child flag is off", async () => {
  const surface = await fixture("public");
  const [object] = await surface.db.insert(attachmentObjects).values({
    originServerId: surface.server.id, uploaderId: surface.owner.id, uploaderType: "user",
    storageKey: `${surface.server.id}/direct-upload.png`, contentHash: null,
    mimeType: "image/png", sizeBytes: 4,
  }).returning();
  const [file] = await surface.db.insert(attachments).values({
    objectId: object.id, messageId: null, pendingChannelId: surface.channel.id,
    channelId: surface.channel.id, uploaderId: surface.owner.id, uploaderType: "user", filename: "direct.png",
  }).returning();
  const provider = {
    transport: {}, credentialResolver: {}, quarantineSink: {}, async releaseCredential() {},
  } as unknown as SlackBridgeProviderRuntime;
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db, provider, reconciliationKey: "ordinary-hashless-test",
    registrationId: surface.registration.id, workerIntervalMs: 60_000, now: () => NOW,
    async runWorkerOnce() { return { kind: "empty" }; },
  });
  const io = { to() { return { emit() {} }; }, in() { return { in() { return { socketsJoin() {} }; }, socketsJoin() {} }; } } as never;
  const orchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as never;
  runtime.start();
  try {
    const sent = await broadcastAndDeliver(io, orchestrator, {
      channelId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      senderName: surface.owner.name, content: "direct-upload caption", attachmentIds: [file.id],
    });
    const [delivery] = await surface.db.select().from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.sourceMessageId, sent.id));
    assert.ok(delivery, "the real message send must create durable external work");
    const snapshot = delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
    assert.equal(snapshot.sanitizedText, "direct-upload caption");
    assert.equal(snapshot.attachments[0]?.sourceAttachmentId, file.id);
    assert.equal(snapshot.attachments[0]?.contentDigest, null);
  } finally { await runtime.stop(); }
});

test("attachment fallback plan records exact immutable revisions only before a fenced first send", async () => {
  const surface = await fixture("public");
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "two files", messageType: "chat", createdAt: NOW }).returning();
  for (const position of [0, 1]) {
    const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
      uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/plan-${position}`,
      contentHash: "a".repeat(64), mimeType: "text/plain", sizeBytes: 4 }).returning();
    await surface.db.insert(attachments).values({ objectId: object.id, messageId: message.id,
      messagePosition: position, channelId: surface.channel.id, uploaderId: surface.owner.id,
      uploaderType: "user", filename: `plan-${position}.txt` });
  }
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const queued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("plan-test", deliveryId) }));
  const snapshot = queued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  let missing = new Set([snapshot.attachments[0]!.storageKey]);
  let unavailable = false;
  const storage: StorageBackend = { async put() {}, async delete() {}, async get() { throw new Error("not used"); },
    async probeObjectPresence(key) { if (unavailable) throw new Error("storage offline"); return missing.has(key) ? "missing" : "present"; } };
  const request = { db: surface.db, deliveryId: queued.delivery.id, bindingId: queued.delivery.bindingId,
    bindingEpoch: queued.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true };
  assert.equal((await prepareSlackAttachmentFallbackPlan({ ...request, assertWriterFleetFenced: async () => false })).kind,
    "lease_or_fence_unavailable");
  unavailable = true;
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "source_unavailable");
  unavailable = false;
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "old-worker", leaseGeneration: 1,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000), leaseOriginState: "queued" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "lease_or_fence_unavailable",
    "never create a plan while an old worker holds a live lease");
  await surface.db.update(externalOutboundDeliveries).set({ leaseExpiresAt: new Date(NOW.getTime() - 1) })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "lease_or_fence_unavailable",
    "an expired lease still needs the normal reclaim transition before planning");
  await surface.db.update(externalOutboundDeliveries).set({ state: "queued", leaseOwner: null,
    leaseExpiresAt: null, leaseOriginState: null }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 1 });
  const [fencedDelivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(fencedDelivery.leaseGeneration, 2, "plan publication fences the prior lease generation");
  const rejectedByFence = (error: unknown) => error instanceof Error && error.cause instanceof Error
    && error.cause.message.includes("Slack attachment plan requires a compatible writer");
  // Model the actual old binary's SQL, which does not set the new writer marker.
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ state: "dispatching",
    leaseOwner: "legacy-worker", leaseGeneration: 3, leaseExpiresAt: new Date(NOW.getTime() + 60_000), leaseOriginState: "queued" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence);
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "new-worker",
      leaseExpiresAt: new Date(NOW.getTime() - 1), leaseOriginState: "queued" })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ leaseOwner: "legacy-worker", leaseGeneration: 4,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000) }).where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence,
    "an old binary cannot reclaim a planned head after a crash");
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: "queued", leaseOwner: null, leaseExpiresAt: null, leaseOriginState: null })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-write" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence);
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ stateReason: "new-writer" })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-after-commit" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence,
  "transaction-local marker must not leak into the next operation");
  await assert.rejects(surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ stateReason: "rolled-back" })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
    throw new Error("intentional rollback");
  }), /intentional rollback/);
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-after-rollback" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), rejectedByFence);
  const staleUpdate = await surface.db.update(externalOutboundDeliveries).set({ stateReason: "stale" })
    .where(sql`${externalOutboundDeliveries.id} = ${queued.delivery.id} AND ${externalOutboundDeliveries.state} = 'dispatching'
      AND ${externalOutboundDeliveries.leaseGeneration} = 1`).returning();
  assert.equal(staleUpdate.length, 0, "a stale generation cannot update the planned head");
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 1 },
    "retrying an unchanged decision must not create unbounded duplicate revisions");
  let plans = await surface.db.select().from(slackAttachmentFallbackPlans);
  assert.equal(plans[0]?.transport, "files");
  assert.deepEqual(plans[0]?.items.map((item) => [item.sourceAttachmentId, item.decision, item.evidence]), [
    [snapshot.attachments[0]!.sourceAttachmentId, "omit", "storage_object_missing"],
    [snapshot.attachments[1]!.sourceAttachmentId, "include", null],
  ]);
  const jobs = await surface.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.outboundDeliveryId, queued.delivery.id));
  const read = { deliveryId: queued.delivery.id, revision: 1,
    renderSnapshotDigest: queued.delivery.renderSnapshotDigest!, snapshot, plan: plans[0], jobs };
  assert.deepEqual(validateSlackAttachmentFallbackPlan(read), { transport: "files", items: plans[0]!.items });
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: undefined }), null, "missing pointer target fails closed");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, revision: 2 }), null, "a different revision cannot be substituted");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, snapshot: { ...snapshot, sanitizedText: "altered" } }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, transport: "text" } }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, unavailableMarker: "changed marker" } }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, jobs: jobs.slice(0, 1) }), null);
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, items: [
    { ...plans[0]!.items[0]!, evidence: null }, plans[0]!.items[1]!,
  ] } }), null, "omission without positive evidence cannot be used");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, plan: { ...plans[0]!, items: [
    plans[0]!.items[0]!, { ...plans[0]!.items[1]!, transferJobId: plans[0]!.items[0]!.transferJobId },
  ] } }), null, "duplicated job cannot substitute another file");
  assert.equal(validateSlackAttachmentFallbackPlan({ ...read, jobs: jobs.map((job) => ({ ...job, outboundDeliveryId: randomUUID() })) }), null);
  missing = new Set();
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "no_fallback" });
  const [restoredDelivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(restoredDelivery.attachmentFallbackPlanRevision, null, "a restored source is not omitted before any send");
  missing = new Set(snapshot.attachments.map((attachment) => attachment.storageKey));
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 2 });
  plans = await surface.db.select().from(slackAttachmentFallbackPlans).orderBy(slackAttachmentFallbackPlans.revision);
  assert.equal(plans[0]?.transport, "files"); assert.equal(plans[1]?.transport, "text");
  const [plannedDelivery] = await surface.db.select().from(externalOutboundDeliveries)
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(plannedDelivery.attachmentFallbackPlanRevision, 2);
  assert.equal(plannedDelivery.renderSnapshotDigest, digestSlackBridgeRenderSnapshot(snapshot));
  assert.ok(!JSON.stringify(plans).includes(snapshot.attachments[0]!.storageKey), "plans do not retain storage keys");
  missing = new Set();
  await surface.db.update(attachmentObjects).set({ lifecycleState: "deleted", gcToken: randomUUID(), gcStartedAt: NOW })
    .where(eq(attachmentObjects.id, snapshot.attachments[0]!.objectId));
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan(request), { kind: "planned", revision: 3 });
  const [deletedPlan] = await surface.db.select().from(slackAttachmentFallbackPlans)
    .where(eq(slackAttachmentFallbackPlans.revision, 3));
  assert.equal(deletedPlan.items[0]?.evidence, "object_deleted");
  await surface.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ providerAttempts: 1, firstDispatchedAt: NOW })
      .where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  });
  assert.equal((await prepareSlackAttachmentFallbackPlan(request)).kind, "lease_or_fence_unavailable",
    "a prior possible send may only use its original plan and reconciliation");
  assert.deepEqual(validateSlackAttachmentFallbackPlan({ ...read, revision: 3, plan: deletedPlan }),
    { transport: "files", items: deletedPlan.items },
    "a prior attempt uses the frozen plan without depending on current source availability");
  assert.equal((await surface.db.select().from(slackAttachmentFallbackPlans)).length, 3);
});

test.each([
  { hashless: false, slowHash: false, stallHash: false, rebind: true },
  { hashless: false, slowHash: false, stallHash: false, rebind: false },
  { hashless: true, slowHash: false, stallHash: false },
  { hashless: true, slowHash: true, stallHash: false },
  { hashless: true, slowHash: false, stallHash: true },
])("a file-share with retired child flag off recovers FIFO ($hashless, slow=$slowHash, stall=$stallHash, rebind=$rebind)", async ({ hashless, slowHash, stallHash, rebind }) => {
  const surface = await fixture("public");
  let observedNow = new Date();
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 29) });
  const sealed = await cipher.sealer.seal({
    serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
    providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!,
    botUserId: surface.install.botUserId!, now: observedNow,
  });
  await surface.db.update(externalAppCredentials).set({
    encryptedMaterial: sealed.encryptedMaterial, envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion,
  }).where(eq(externalAppCredentials.installId, surface.install.id));
  const [other] = await surface.db.insert(users).values({
    email: `file-following-${randomUUID()}@test.invalid`, name: `file-following-${randomUUID()}`, passwordHash: "test-only",
  }).returning();
  await surface.db.insert(serverMembers).values({ serverId: surface.server.id, userId: other.id, role: "member" });
  const [imageMessage, nextMessage, otherMessage] = await surface.db.insert(messages).values([
    { channelId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      content: "caption <!channel> & <unsafe> @wake with image", messageType: "chat", createdAt: observedNow },
    { channelId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      content: "after image", messageType: "chat", createdAt: observedNow },
    { channelId: surface.channel.id, senderType: "user", senderId: other.id,
      content: "other sender after image", messageType: "chat", createdAt: observedNow },
  ]).returning();
  const body = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#2a6fdb" } }).png().toBuffer();
  const [object] = await surface.db.insert(attachmentObjects).values({
    originServerId: surface.server.id, uploaderId: surface.owner.id, uploaderType: "user",
    storageKey: `${surface.server.id}/file-correlation.png`,
    contentHash: hashless ? null : createHash("sha256").update(body).digest("hex"), mimeType: "image/png", sizeBytes: body.length,
  }).returning();
  const [fileAttachment] = await surface.db.insert(attachments).values({
    objectId: object.id, messageId: imageMessage!.id, messagePosition: 0, channelId: surface.channel.id,
    uploaderId: surface.owner.id, uploaderType: "user", filename: "file-correlation.png",
  }).returning();
  const attachmentsForTestId = fileAttachment!.id;
  let sourceReads = 0;
  let releaseRead: (() => void) | undefined;
  let readStarted!: () => void;
  const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
  __setStorageForTests({
    async put() {}, async delete() {},
    async get(key, signal) {
      assert.equal(key, object.storageKey);
      sourceReads += 1;
      if (slowHash && sourceReads === 1) {
        return Readable.from((async function* () {
          const start = observedNow.getTime();
          observedNow = new Date(start + 4 * 60_000);
          yield body.subarray(0, Math.floor(body.length / 2));
          const deadline = Date.now() + 3_000;
          let renewed = false;
          while (Date.now() < deadline) {
            const [job] = await surface.db.select().from(externalAttachmentTransferJobs)
              .where(eq(externalAttachmentTransferJobs.sourceAttachmentId, attachmentsForTestId));
            if (job?.leaseExpiresAt && job.leaseExpiresAt.getTime() > start + 5 * 60_000) { renewed = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!renewed) throw new Error("source lease was not renewed during progress");
          observedNow = new Date(start + 6 * 60_000);
          yield body.subarray(Math.floor(body.length / 2));
        })());
      }
      if (stallHash && sourceReads === 1) {
        readStarted();
        await new Promise<void>((resolve, reject) => {
          releaseRead = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return Readable.from(body);
    },
  });
  const active = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db, bindingId: surface.binding.id, expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch, senderType: "user", senderId: surface.owner.id,
    now: observedNow, registrationId: surface.registration.id,
  });
  assert.ok(active);
  const queued: Awaited<ReturnType<typeof enqueueSlackBridgeOutboundDelivery>>[] = [];
  for (const message of [imageMessage!, nextMessage!, otherMessage!]) {
    queued.push(await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({
      executor, message, activeRuntime: {
        level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral,
      }, canonicalConversationId: surface.channel.id,
      senderType: "user", senderId: message.senderId,
      authorName: message.senderId === surface.owner.id ? surface.owner.name : other.name, sanitizedText: message.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("file-correlation-regression", deliveryId),
    })));
  }
  // Exercise the real file completion path with a frozen, authorized Raft mention.
  const fileSnapshot = queued[0]!.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  await surface.db.insert(messageMentions).values({ messageId: imageMessage!.id, messageSeq: imageMessage!.seq,
    serverId: surface.server.id, channelId: surface.channel.id, targetType: "user", targetId: surface.owner.id,
    handleAtSendTime: "wake" });
  fileSnapshot.raftMentionSubstitutions = [{
    kind: "user", handle: "wake", token: "<@U_RUNTIME_HUMAN>",
    installId: surface.install.id, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch,
  }];
  await surface.db.update(externalOutboundDeliveries).set({
    renderSnapshot: fileSnapshot as unknown as Record<string, unknown>, renderSnapshotDigest: digestSlackBridgeRenderSnapshot(fileSnapshot),
  }).where(eq(externalOutboundDeliveries.id, queued[0]!.delivery.id));
  observedNow = new Date();
  const counts = { ticket: 0, upload: 0, complete: 0, correlate: 0, post: 0 };
  const provider = createSlackBridgeProviderRuntime({
    db: surface.db, credentialCipher: cipher, now: () => observedNow,
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "files.slack.com") {
        counts.upload += 1;
        assert.deepEqual(Buffer.from(await new Response(init?.body).arrayBuffer()), body);
        return new Response("OK", { status: 200 });
      }
      const method = url.pathname.split("/").at(-1);
      let response;
      if (method === "files.getUploadURLExternal") {
        counts.ticket += 1;
        response = { ok: true, file_id: "F_CORRELATE", upload_url: "https://files.slack.com/upload/F_CORRELATE" };
      } else if (method === "files.completeUploadExternal") {
        counts.complete += 1;
        const completion = JSON.parse(String(init?.body)) as { initial_comment: string };
        assert.equal(completion.initial_comment, "caption &lt;!channel&gt; &amp; &lt;unsafe&gt; <@U_RUNTIME_HUMAN> with image");
        response = { ok: true, files: [{ id: "F_CORRELATE" }] };
      } else if (method === "conversations.history") {
        counts.correlate += 1;
        assert.equal(url.searchParams.has("include_all_metadata"), false,
          "file shares must use file-ID correlation, not text-metadata reconciliation");
        response = { ok: true, messages: counts.correlate === 1 ? [] : [{
          ts: "1788541200.000300", subtype: "file_share", files: [{ id: "F_CORRELATE" }],
        }] };
      } else if (method === "chat.postMessage") {
        counts.post += 1;
        const post = JSON.parse(String(init?.body)) as { text: string };
        const expected = counts.post === 1 ? "after image" : counts.post === 2 ? "other sender after image" : counts.post === 3 ? "quarantined historical text" : "new binding follows old FIFO";
        assert.equal(post.text.includes(expected), true);
        response = { ok: true, channel: "C_RUNTIME_TEST", ts: `1788541200.000${counts.post + 3}00` };
      } else {
        throw new Error(`unexpected provider method: ${method}`);
      }
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db, provider, reconciliationKey: "file-correlation-regression", registrationId: surface.registration.id,
    now: () => observedNow, workerIntervalMs: 60_000,
    async runWorkerOnce(input) {
      try {
        if (hashless) {
          const preparing = await processExternalDeliveryPartitionHead(input);
          assert.equal(preparing.kind === "blocked" ? preparing.reason : null, "attachment_source_preparing");
          assert.deepEqual(counts, { ticket: 0, upload: 0, complete: 0, correlate: 0, post: 0 },
            "hashing must finish before sending");
          const [credential] = await surface.db.select().from(externalAppCredentials)
            .where(eq(externalAppCredentials.installId, surface.install.id));
          assert.equal(credential?.leaseOwner, null, "hash preparation must not acquire the workspace credential");
          if (stallHash) {
            await readStartedPromise;
            const workerDeps = input.dependencies;
            assert.ok(workerDeps);
            const current = await workerDeps.resolveCurrentRuntime({
              deliveryId: queued[0]!.delivery.id, frozenSnapshot: fileSnapshot,
            });
            assert.ok(current && !("blockedReason" in current));
            const lease = await workerDeps.leaseCredential({ deliveryId: queued[0]!.delivery.id, runtime: current });
            assert.ok(lease, "another operation can acquire the workspace credential while storage is stalled");
            await workerDeps.releaseCredential?.({
              deliveryId: queued[0]!.delivery.id, runtime: current, credentialHandle: lease.handle, reason: "test",
            });
            releaseRead?.();
          }
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const [job] = await surface.db.select().from(externalAttachmentTransferJobs)
              .where(eq(externalAttachmentTransferJobs.outboundDeliveryId, queued[0]!.delivery.id));
            if (job?.frozenContentDigest) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        const first = await processExternalDeliveryPartitionHead(input);
        assert.equal(first.kind, "attempted");
        if (first.kind !== "attempted") throw new Error("first file attempt did not run");
        assert.equal(first.deliveryState, "outcome_unknown");
        assert.equal(counts.complete, 1);
        let replacement: Awaited<ReturnType<typeof reauthorizeSamePair>> | null = null;
        let newDeliveryId: string | null = null;
        if (rebind) {
          replacement = await reauthorizeSamePair(surface);
          observedNow = new Date(observedNow.getTime() + 25 * 60 * 60_000);
          const activeNow = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db,
            bindingId: replacement.id, expectedBindingEpoch: 1, expectedConnectionEpoch: 3,
            registrationId: surface.registration.id, senderType: "user", senderId: surface.owner.id, now: observedNow });
          assert.ok(activeNow);
          const [newMessage] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
            senderType: "user", senderId: surface.owner.id, content: "new binding follows old FIFO" }).returning();
          const admitted = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: newMessage!,
            activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
              runtimePredicateRevision: activeNow.runtimeRevision, bindingAuthority: activeNow.neutral },
            canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
            authorName: surface.owner.name, sanitizedText: newMessage!.content,
            mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("file-correlation-regression", deliveryId) }));
          newDeliveryId = admitted.delivery.id;
          const heads = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(heads[0]?.deliveryId, queued[0]!.delivery.id, "the current pair must select its old unknown head ahead of new work");
        }
        observedNow = new Date(observedNow.getTime() + 30_000);
        const recovered = await processExternalDeliveryPartitionHead(input);
        assert.equal(recovered.kind, "cursor_recovered", `file recovery must reach durable file-ID correlation using its existing credential lease: ${"reason" in recovered ? recovered.reason : recovered.kind}`);
        if (recovered.kind !== "cursor_recovered") throw new Error("file recovery did not run");
        assert.equal(recovered.state, "accepted");
        let following: Awaited<ReturnType<typeof processExternalDeliveryPartitionHead>> = recovered;
        for (const expected of queued.slice(1)) {
          const result = await processExternalDeliveryPartitionHead(input);
          assert.equal(result.kind, "attempted");
          if (result.kind !== "attempted") throw new Error("following text did not run");
          assert.equal(result.deliveryState, "accepted");
          assert.equal(result.deliveryId, expected.delivery.id, "both senders must keep their original queue order");
          following = result;
        }
        const rows = await surface.db.select().from(externalOutboundDeliveries)
          .where(eq(externalOutboundDeliveries.bindingId, surface.binding.id));
        assert.equal(rows.length, 3);
        assert.ok(rows.every((row) => row.state === "accepted"));
        assert.equal(rows.find((row) => row.id === queued[0]!.delivery.id)?.providerMessageId, "1788541200.000300");
        const [partition] = await surface.db.select().from(externalDeliveryPartitions)
          .where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
        assert.equal(partition.cursorPosition, 3);
        assert.equal(rows[0]?.providerAttempts, 1, "read-only receipt acceptance must not consume another attempt");
        if (replacement) {
          // A legacy quarantined head is recovered before the new generation.
          const [quarantinedMessage] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
            senderType: "user", senderId: surface.owner.id, content: "quarantined historical text" }).returning();
          const quarantinedSnapshot = { ...fileSnapshot, sourceMessageId: quarantinedMessage!.id,
            sourceMessageSeq: quarantinedMessage!.seq, sanitizedText: quarantinedMessage!.content, attachments: [],
            enqueueRuntimeRevision: "historical-quarantine", externalMentions: [], raftMentionSubstitutions: [],
            bindingAuthority: { ...fileSnapshot.bindingAuthority, bindingEpoch: 99 } };
          let quarantinedId = "";
          await surface.db.transaction(async (tx) => {
            await tx.insert(externalDeliveryPartitions).values({ bindingId: surface.binding.id, bindingEpoch: 99, lastEnqueuedPosition: 1 });
            const [row] = await tx.insert(externalOutboundDeliveries).values({ sourceMessageId: quarantinedMessage!.id,
              bindingId: surface.binding.id, bindingEpoch: 99, partitionPosition: 1, enqueueRuntimeRevision: "historical-quarantine",
              state: "quarantined", stateReason: "authority_terminal:sender_no_longer_authorized",
              renderSnapshotSchema: quarantinedSnapshot.schema,
              renderSnapshot: quarantinedSnapshot as unknown as Record<string, unknown>,
              renderSnapshotDigest: digestSlackBridgeRenderSnapshot(quarantinedSnapshot), reconciliationMarker: "Q".repeat(43),
              createdAt: new Date(observedNow.getTime() - 2 * 24 * 60 * 60_000),
            }).returning();
            quarantinedId = row!.id;
          });
          const [visible] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(visible?.deliveryId, quarantinedId, "the health read must retain the quarantined historical head");
          const [oldHead] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(oldHead?.deliveryId, quarantinedId, "quarantine cannot make later work bypass its original place");
          const restored = await processExternalDeliveryPartitionHead({ ...input, bindingId: oldHead!.bindingId, bindingEpoch: oldHead!.bindingEpoch });
          assert.equal(restored.kind === "attempted" ? restored.deliveryState : null, "accepted", JSON.stringify(restored));
          const [head] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(head?.deliveryId, newDeliveryId, "the new partition becomes eligible only after old work drains");
          const result = await processExternalDeliveryPartitionHead({ ...input, bindingId: head!.bindingId, bindingEpoch: head!.bindingEpoch });
          assert.equal(result.kind === "attempted" ? result.deliveryState : null, "accepted");
        }
        assert.deepEqual(counts, { ticket: 1, upload: 1, complete: 1, correlate: 2, post: rebind ? 4 : 2 });
        assert.equal(sourceReads, hashless ? 2 : 1, "hashless files are read once for hashing and once for upload, never again for recovery");
        resolveDone();
        return following;
      } catch (error) { rejectDone(error); throw error; }
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  runtime.start();
  try {
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("file recovery worker did not finish")), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    await runtime.stop();
    await provider.stop();
  }
});

for (const history of ["found", "absent", "unknown_root", "unknown_child"] as const) {
test(`historical root recovery and following FIFO delivery (${history})`, async () => {
  const surface = await fixture("public");
  let observedNow = new Date();
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 31) });
  const sealed = await cipher.sealer.seal({
    serverId: surface.server.id, accessToken: "synthetic-history-token", tokenType: "bot",
    providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!,
    botUserId: surface.install.botUserId!, now: observedNow,
  });
  await surface.db.update(externalAppCredentials).set({
    encryptedMaterial: sealed.encryptedMaterial, envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion,
  }).where(eq(externalAppCredentials.installId, surface.install.id));
  const [root] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "historical root", messageType: "chat" }).returning();
  const [thread] = await surface.db.insert(channels).values({ serverId: surface.server.id,
    name: "historical-thread", type: "thread", parentChannelId: surface.channel.id, parentMessageId: root.id }).returning();
  await surface.db.update(messages).set({ threadId: thread.id }).where(eq(messages.id, root.id));
  const link = history === "found" ? (await surface.db.insert(externalMessageLinks).values({
    provider: "slack", installId: "historical-install", providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerMessageId: "1788541200.000100",
    bindingId: "historical-binding", bindingEpoch: surface.binding.bindingEpoch - 1,
    connectionEpoch: 1, raftMessageId: root.id, firstDirection: "raft_outbound",
    payloadFingerprint: "a".repeat(64), outcomeState: "accepted", authorityState: "stale",
  }).returning())[0]! : null;
  const active = await resolveCurrentOutboundAuthorityOrNull({
    executor: surface.db, bindingId: surface.binding.id, expectedConnectionEpoch: surface.binding.connectionEpoch,
    expectedBindingEpoch: surface.binding.bindingEpoch, senderType: "user", senderId: surface.owner.id,
    now: observedNow, registrationId: surface.registration.id,
  });
  assert.ok(active);
  const queued: Awaited<ReturnType<typeof enqueueSlackBridgeOutboundDelivery>>[] = [];
  for (const [index, channelId] of [thread.id, surface.channel.id].entries()) {
    const [message] = await surface.db.insert(messages).values({ channelId,
      senderType: "user", senderId: surface.owner.id, content: `current message ${index}`, messageType: "chat" }).returning();
    queued.push(await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({
      executor, message, activeRuntime: { level: index === 0 ? "thread" : "top_level",
        authorityConversationId: channelId, runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
      canonicalConversationId: channelId, canonicalRootMessageId: index === 0 ? root.id : null,
      senderType: "user", senderId: surface.owner.id, authorName: surface.owner.name, sanitizedText: message.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("history-regression", deliveryId),
    })));
  }
  if (history === "unknown_child") {
    await surface.db.update(externalOutboundDeliveries).set({ state: "outcome_unknown", providerAttempts: 1,
      firstDispatchedAt: observedNow }).where(eq(externalOutboundDeliveries.id, queued[0].delivery.id));
  }
  if (history === "unknown_root") {
    const frozen = queued[0].delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
    await surface.db.transaction(async (tx) => {
    await tx.insert(externalDeliveryPartitions).values({ bindingId: surface.binding.id,
      bindingEpoch: surface.binding.bindingEpoch - 1, lastEnqueuedPosition: 1 });
    await tx.insert(externalOutboundDeliveries).values({ sourceMessageId: root.id,
      bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch - 1, partitionPosition: 1,
      enqueueRuntimeRevision: "old-runtime", state: "outcome_unknown", providerAttempts: 1,
      firstDispatchedAt: observedNow, renderSnapshotSchema: frozen.schema,
      renderSnapshot: { ...frozen, level: "top_level", canonicalRootMessageId: null,
        sourceMessageId: root.id, bindingAuthority: { ...frozen.bindingAuthority, bindingEpoch: surface.binding.bindingEpoch - 1 } },
      renderSnapshotDigest: "b".repeat(64), reconciliationMarker: "B".repeat(43),
    });
    });
  }
  const posts: Array<{ thread_ts?: string }> = [];
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => observedNow,
    fetch: (async (input, init) => {
      assert.equal(new URL(String(input)).pathname.split("/").at(-1), "chat.postMessage");
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, ts: `1788541200.000${200 + posts.length}`, channel: surface.binding.providerConversationId }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db: surface.db, provider, reconciliationKey: "history-regression", registrationId: surface.registration.id,
    now: () => observedNow, workerIntervalMs: 60_000,
    async runWorkerOnce(input) {
      try {
        if (link) {
          const [conflict] = await surface.db.insert(externalMessageLinks).values({
          ...link!, id: randomUUID(), bindingEpoch: surface.binding.bindingEpoch,
          providerMessageId: "1788541200.000999",
        }).returning();
        const blocked = await processExternalDeliveryPartitionHead(input);
        assert.equal(blocked.kind, "blocked");
        assert.equal("reason" in blocked ? blocked.reason : null, "provider_thread_receipt_conflict");
        assert.equal(posts.length, 0, "conflicting historical receipts must not choose an arbitrary Slack thread");
        await surface.db.delete(externalMessageLinks).where(eq(externalMessageLinks.id, conflict.id));
        }
        if (history === "unknown_root" || history === "unknown_child") {
          const result = await processExternalDeliveryPartitionHead(input);
          assert.equal(result.kind, "blocked");
          assert.equal(posts.length, 0, "unknown provider results cannot be treated as confirmed absence");
          const [head] = await surface.db.select().from(externalOutboundDeliveries)
            .where(eq(externalOutboundDeliveries.id, queued[0].delivery.id));
          assert.equal(head.state, history === "unknown_child" ? "outcome_unknown" : "queued");
          assert.equal(head.providerAttempts, history === "unknown_child" ? 1 : 0);
          resolveDone();
          return result;
        }
        for (const [index, expected] of queued.entries()) {
          if (history === "absent" && index === 0) {
            await surface.db.update(externalDeliveryPartitions).set({
              authorityBlockedAt: new Date(observedNow.getTime() - 60_000),
              authorityBlockedReason: "historical_root_wait", authorityRetryAt: observedNow,
              authorityOverdueAlertedAt: observedNow,
            }).where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
          }
          const result = await processExternalDeliveryPartitionHead(input);
          if (history === "absent" && index === 0) {
            assert.equal(result.kind, "skipped", JSON.stringify(result));
            const [discarded] = await surface.db.select().from(externalOutboundDeliveries)
              .where(eq(externalOutboundDeliveries.id, expected.delivery.id));
            assert.equal(discarded.stateReason, "confirmed_thread_root_missing");
            assert.equal(discarded.providerAttempts, 0);
            assert.equal(posts.length, 0, "orphan discard must not call Slack");
            const [afterDiscard] = await surface.db.select().from(externalDeliveryPartitions)
              .where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
            assert.deepEqual([afterDiscard.authorityBlockedAt, afterDiscard.authorityBlockedReason,
              afterDiscard.authorityRetryAt, afterDiscard.authorityOverdueAlertedAt], [null, null, null, null],
            "advancing a confirmed orphan clears its stale pair wait");
            continue;
          }
          assert.equal(result.kind, "attempted", JSON.stringify(result));
          if (result.kind !== "attempted") throw new Error("historical thread did not dispatch");
          assert.equal(result.deliveryState, "accepted");
          assert.equal(result.deliveryId, expected.delivery.id);
          observedNow = new Date(observedNow.getTime() + 1_000);
        }
        const [partition] = await surface.db.select().from(externalDeliveryPartitions)
          .where(eq(externalDeliveryPartitions.bindingId, surface.binding.id));
        assert.equal(partition.cursorPosition, 2);
        assert.deepEqual(posts.map((post) => post.thread_ts ?? null), history === "absent" ? [null] : ["1788541200.000100", null]);
        if (link) {
        const [historical] = await surface.db.select().from(externalMessageLinks).where(eq(externalMessageLinks.id, link.id));
        assert.equal(historical.bindingEpoch, surface.binding.bindingEpoch - 1);
        }
        resolveDone();
        return { kind: "empty" };
      } catch (error) { rejectDone(error); throw error; }
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  runtime.start();
  try {
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("historical thread worker did not finish")), 10_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    await runtime.stop();
    await provider.stop();
  }
});

}

test("admitted inbound custody survives new binding identity and reauthorization but still requires the current target", async () => {
  const surface = await fixture("public");
  const a = surface.authority;
  const frozen = { runtimeRevision: slackBridgeDatabaseRuntimeRevision(a), provider: "slack", environment: "test" as const,
    appRegistrationId: a.registrationId, installId: a.installId, workspaceId: a.providerAuthorityId,
    providerAuthorityId: a.providerAuthorityId, providerConversationId: a.providerConversationId,
    bindingId: a.bindingId, bindingEpoch: a.bindingEpoch, connectionEpoch: a.connectionEpoch,
    raftChannelId: a.channelId, privacyClass: a.privacyClass };
  const eventId = await storeWorkerCustody(surface, frozen);
  const binding = await reauthorizeSamePair(surface);
  const resolve = createSlackDatabaseInboundWorkerRuntimeResolver(surface.db, () => NOW);
  const continued = await resolve({ eventId, frozenAuthority: frozen });
  assert.equal(continued?.bindingId, frozen.bindingId, "sealed custody stays original");
  assert.equal(continued?.operationAuthority?.bindingId, binding.id, "current authorization uses the replacement pair");
  assert.equal(await resolve({ eventId: randomUUID(), frozenAuthority: frozen }), null, "unrecorded custody cannot authorize replay");
  await surface.db.update(externalChannelBindings).set({ providerConversationId: "C_OTHER_TARGET" }).where(eq(externalChannelBindings.id, binding.id));
  assert.equal(await resolve({ eventId, frozenAuthority: frozen }), null, "a real destination change cannot consume old work");
});

for (const recovery of ["found", "expired_before_write", "paged", "lease_replaced", "lease_replaced_before_evidence", "delayed_response", "unconfirmable", "sender_unverified", "sender_copied", "workspace_restricted_read"] as const) {
  test(`text unknown result uses current reauthorized credentials without nested lease (${recovery})`, async () => {
    const surface = await fixture("public");
    let clock = new Date();
    const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 32) });
    const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
      providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: clock });
    await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
      envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
    const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
      expectedBindingEpoch: 3, expectedConnectionEpoch: 2, senderType: "user", senderId: surface.owner.id,
      now: clock, registrationId: surface.registration.id });
    assert.ok(active);
    const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
      senderType: "user", senderId: surface.owner.id, content: "unknown initial text" }).returning();
    const admitted = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: message!,
      activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
      canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
      authorName: surface.owner.name, sanitizedText: message!.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("text-rebind", deliveryId) }));
    let posts = 0;
    let reads = 0;
    let acceptedMetadata: Record<string, unknown> | undefined;
    let acceptedTimestamp = "";
    const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => clock,
      fetch: (async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1);
        if (method === "chat.postMessage") {
          posts += 1;
          acceptedMetadata = JSON.parse(String(init?.body)).metadata;
          acceptedTimestamp = (clock.getTime() / 1000).toFixed(6);
          if (recovery === "delayed_response") clock = new Date(clock.getTime() + 90_000);
          throw new Error("synthetic accepted write with lost response");
        }
        assert.equal(method, "conversations.history");
        reads += 1;
        if (recovery === "workspace_restricted_read") return new Response(JSON.stringify({ ok: false, error: "app_access_restricted" }),
          { status: 200, headers: { "content-type": "application/json" } });
        if (recovery === "expired_before_write") clock = new Date(clock.getTime() + 61_000);
        if (recovery === "lease_replaced") {
          const foreignScan = parseSlackReconciliationScan({ schema: "slack-reconciliation-scan.v3", providerAttempt: 1,
            scopeKey: "f".repeat(64), oldest: "1.000000", latest: "2.000000", cursor: "replacement-cursor",
            match: null, metadataMissing: false, markerUnconfirmed: false, historyLimited: false });
          assert.ok(foreignScan);
          await surface.db.update(externalOutboundDeliveries).set({ leaseOwner: "replacement-worker",
            leaseGeneration: sql`${externalOutboundDeliveries.leaseGeneration} + 1`, reconciliationScan: foreignScan,
          }).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
          return new Response(JSON.stringify({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "old-page" } }),
            { status: 200, headers: { "content-type": "application/json" } });
        }
        if (recovery === "paged" && reads <= 2) return new Response(JSON.stringify({ ok: true, messages: [], has_more: true,
          response_metadata: { next_cursor: `page-${reads}` } }), { status: 200, headers: { "content-type": "application/json" } });
        if (recovery === "paged") assert.equal(new URL(String(input)).searchParams.get("cursor"), "page-2");
        return new Response(JSON.stringify({ ok: true, messages: recovery === "unconfirmable" ? [{ ts: acceptedTimestamp, app_id: surface.install.providerAppId }]
          : (recovery === "sender_unverified" || recovery === "sender_copied")
            ? [{ ts: acceptedTimestamp, metadata: acceptedMetadata, ...(recovery === "sender_copied" ? { app_id: "A_OTHER" } : {}) }]
          : (recovery === "found" || recovery === "paged" || recovery === "delayed_response")
            && Number(acceptedTimestamp) >= Number(new URL(String(input)).searchParams.get("oldest"))
            && Number(acceptedTimestamp) <= Number(new URL(String(input)).searchParams.get("latest"))
          ? [{ ts: acceptedTimestamp, app_id: surface.install.providerAppId, metadata: acceptedMetadata }] : [], has_more: false }),
          { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    let done!: () => void;
    let fail!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
    const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider,
      reconciliationKey: "text-rebind", registrationId: surface.registration.id, now: () => clock, workerIntervalMs: 60_000,
      async runWorkerOnce(input) {
        try {
          const sent = await processExternalDeliveryPartitionHead(input);
          assert.equal(sent.kind === "attempted" ? sent.deliveryState : null, "outcome_unknown");
          const replacement = await reauthorizeSamePair(surface);
          if (recovery === "found") clock = new Date(clock.getTime() + 25 * 60 * 60_000);
          const [head] = await listSlackPairHeads(surface.db, [{ bindingId: replacement.id, bindingEpoch: 1 }]);
          assert.equal(head?.deliveryId, admitted.delivery.id);
          const workerDependencies = input.dependencies;
          assert.ok(workerDependencies?.prepareProvider);
          const originalPrepareProvider = workerDependencies.prepareProvider;
          const request = { ...input, dependencies: workerDependencies, bindingId: head!.bindingId, bindingEpoch: head!.bindingEpoch,
            ...(recovery === "lease_replaced_before_evidence" ? { dependencies: { ...workerDependencies,
              async prepareProvider(claim: Parameters<typeof originalPrepareProvider>[0]) {
                await surface.db.update(externalOutboundDeliveries).set({ leaseOwner: "replacement-worker",
                  leaseGeneration: sql`${externalOutboundDeliveries.leaseGeneration} + 1`, reconciliationScan: {
                    schema: "slack-reconciliation-scan.v3", providerAttempt: 1, scopeKey: "f".repeat(64), oldest: "1.000000", latest: "2.000000",
                    cursor: null, match: null, metadataMissing: false, markerUnconfirmed: false, historyLimited: false,
                  },
                }).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
                return originalPrepareProvider(claim);
              },
            } } : {}),
          };
          let recovered = await processExternalDeliveryPartitionHead(request);
          if (recovery === "paged") {
            assert.equal("reason" in recovered ? recovered.reason : null, "reconciliation_scan_pending");
            const [checkpoint] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
            assert.equal(checkpoint.reconciliationScan?.cursor, "page-2", "progress must be durable, not process-local");
            assert.equal(checkpoint.providerAttempts, 1);
            clock = new Date(clock.getTime() + 31_000);
            recovered = await processExternalDeliveryPartitionHead(request);
          }
          const accepted = recovery === "found" || recovery === "paged" || recovery === "delayed_response";
          assert.equal(recovered.kind, accepted ? "cursor_recovered" : (recovery === "unconfirmable" || recovery === "sender_unverified" || recovery === "sender_copied" || recovery === "workspace_restricted_read") ? "authority_blocked" : "blocked", JSON.stringify(recovered));
          if (!accepted) assert.equal("reason" in recovered ? recovered.reason : null,
            (recovery === "lease_replaced" || recovery === "expired_before_write") ? "provider_preflight_exception" : recovery === "lease_replaced_before_evidence" ? "reconciliation_attempt_evidence_missing"
              : recovery === "unconfirmable" ? "reconciliation_bridge_metadata_missing" : (recovery === "sender_unverified" || recovery === "sender_copied") ? "reconciliation_marker_unconfirmed" : recovery === "workspace_restricted_read" ? "slack_workspace_admin_required" : "lease_expired_before_attempt_start");
          const [credential] = await surface.db.select().from(externalAppCredentials).where(eq(externalAppCredentials.installId, surface.install.id));
          assert.equal(credential.leaseOwner, null, "preparation must release the actual replacement credential even without dispatch");
          const [delivery] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
          assert.equal(delivery.providerAttempts, 1);
          assert.equal(posts, 1, "reconciliation must not duplicate the original write");
          assert.equal(reads, recovery === "paged" ? 3 : recovery === "lease_replaced_before_evidence" ? 0 : 1, "the outer credential cannot prevent read-only reconciliation");
          if (recovery === "paged") assert.equal(delivery.reconciliationScan, null);
          if (recovery === "lease_replaced" || recovery === "lease_replaced_before_evidence") {
            assert.equal(delivery.leaseOwner, "replacement-worker");
            assert.equal(delivery.reconciliationScan?.scopeKey, "f".repeat(64), "a stale callback cannot overwrite another lease's progress");
          }
          if (recovery === "workspace_restricted_read") {
            const [partition] = await surface.db.select().from(externalDeliveryPartitions)
              .where(eq(externalDeliveryPartitions.bindingId, admitted.delivery.bindingId));
            assert.equal(partition.authorityBlockedReason, "slack_workspace_admin_required");
          }
          if (recovery === "unconfirmable" || recovery === "sender_unverified" || recovery === "sender_copied") {
            const expectedReason = recovery === "sender_unverified" || recovery === "sender_copied" ? "reconciliation_marker_unconfirmed" : "reconciliation_bridge_metadata_missing";
            const [partition] = await surface.db.select().from(externalDeliveryPartitions)
              .where(eq(externalDeliveryPartitions.bindingId, admitted.delivery.bindingId));
            assert.equal(partition.authorityBlockedReason, expectedReason);
            assert.equal(partition.authorityRetryAt?.getTime(), clock.getTime() + 900_000);
            assert.equal(delivery.reconciliationScan?.conclusion?.reason, expectedReason);
            clock = new Date(clock.getTime() + 31_000);
            assert.equal((await processExternalDeliveryPartitionHead(request)).kind, "blocked");
            assert.equal(reads, 1, "unconfirmable work is visible without rescanning or sending");
          }
          done();
          return recovered;
        } catch (error) { fail(error); throw error; }
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    runtime.start();
    try { await Promise.race([finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("text rebind worker timed out")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); await runtime.stop(); await provider.stop(); }
  });
}

for (const mode of ["external_bot", "external_present", "external_removed", "external_removed_before_dispatch", "external_fact_changed",
  "group_current", "group_replaced", "group_retired", "group_replaced_before_dispatch", "group_target_removed",
  "group_wrong_principal", "group_missing_original_fact", "group_mapping_read_failed", "ambiguous_handle",
  "group_joint_current", "group_joint_projection_removed", "group_agent_current", "group_agent_removed"] as const) {
  test(`queued Slack mentions validate current identity at publication (${mode})`, async () => {
    const groupMode = mode.startsWith("group_") || mode === "ambiguous_handle";
    const present = mode !== "external_removed";
    const removeBeforeDispatch = mode === "external_removed_before_dispatch";
    const surface = await fixture("public");
    if (mode === "external_bot") {
      await surface.db.update(externalActorProjections).set({ externalActorId: "BOTHERBOT", actorKind: "bot" }).where(eq(externalActorProjections.id, surface.projection.id));
      surface.projection.externalActorId = "BOTHERBOT";
    }
    const clock = new Date();
    const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 33) });
    const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
      providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: clock });
    await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
      envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
    let sourceChannelId = surface.channel.id;
    let mentionChannelId = surface.channel.id;
    let mentionServerId = surface.server.id;
    let participantProjectionId: string | null = null;
    if (mode.startsWith("group_joint")) {
      const participant = await createServer("Mention participant", `mention-part-${randomUUID()}`, surface.owner.id);
      const [canonical, face] = await surface.db.insert(channels).values([
        { serverId: surface.server.id, name: "canonical mention parent", type: "channel" },
        { serverId: participant.id, name: "participant mention face", type: "joint" },
      ]).returning();
      const [joint] = await surface.db.insert(jointChannels).values({ canonicalChannelId: canonical!.id,
        createdByServerId: surface.server.id, createdByUserId: surface.owner.id }).returning();
      await surface.db.update(channels).set({ type: "joint" }).where(eq(channels.id, surface.channel.id));
      const projections = await surface.db.insert(jointChannelServers).values([
        { jointChannelId: joint!.id, serverId: surface.server.id, localChannelId: surface.channel.id,
          role: "host", joinedByUserId: surface.owner.id },
        { jointChannelId: joint!.id, serverId: participant.id, localChannelId: face!.id,
          role: "participant", joinedByUserId: surface.owner.id },
      ]).returning();
      participantProjectionId = projections[1]!.localChannelId;
      sourceChannelId = canonical!.id; mentionChannelId = face!.id; mentionServerId = participant.id;
    }
    const [message] = await surface.db.insert(messages).values({ channelId: sourceChannelId,
      senderType: "user", senderId: surface.owner.id, content: "hello @runtime-human body continues" }).returning();
    if (!groupMode || mode === "ambiguous_handle") await surface.db.insert(externalMentionFacts).values({ messageId: message!.id, projectionId: surface.projection.id,
      provider: "slack", appRegistrationId: surface.registration.id, installId: surface.install.id,
      workspaceId: surface.install.providerAuthorityId, externalActorId: surface.projection.externalActorId,
      connectionEpoch: 2, bindingId: surface.binding.id, bindingEpoch: 3, conversationId: "C_RUNTIME_TEST",
      memberRevision: 1, contextRevision: 1, freshnessObservedAt: NOW, freshnessExpiresAt: EXPIRES,
      handleAtSendTime: "runtime-human", resolutionReason: "explicit_projection" });
    const [target] = await surface.db.insert(users).values({ email: `${randomUUID()}@mention.test`,
      name: `target-${randomUUID()}`, passwordHash: "synthetic" }).returning();
    let identity: Awaited<ReturnType<typeof reserveSlackUsergroupIdentity>> | null = null;
    if (groupMode) {
      await surface.db.insert(serverMembers).values({ serverId: mentionServerId, userId: target!.id, role: "member" });
      if (mode.startsWith("group_agent")) {
        await surface.db.insert(agents).values({ id: target!.id, serverId: mentionServerId, name: target!.name, status: "active" });
        await surface.db.insert(channelAgents).values({ channelId: mentionChannelId, agentId: target!.id });
      }
      identity = await reserveSlackUsergroupIdentity(surface.db, { installId: surface.install.id, serverId: mentionServerId,
        principalKind: mode.startsWith("group_agent") ? "agent" : "user", principalId: target!.id });
      await surface.db.update(slackUsergroupIdentities).set({ providerUsergroupId: "S_RUNTIME_GROUP", humanCanonical: !mode.startsWith("group_agent") })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      await surface.db.insert(messageMentions).values({ messageId: message!.id, messageSeq: message!.seq,
        serverId: mentionServerId, channelId: mentionChannelId,
        targetType: mode.startsWith("group_agent") ? "agent" : "user", targetId: target!.id,
        handleAtSendTime: "runtime-human" });
    }
    const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
      expectedBindingEpoch: 3, expectedConnectionEpoch: 2, senderType: "user", senderId: surface.owner.id,
      registrationId: surface.registration.id, now: clock });
    assert.ok(active);
    const admitted = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message: message!,
      activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
        runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
      canonicalConversationId: sourceChannelId, senderType: "user", senderId: surface.owner.id,
      authorName: surface.owner.name, sanitizedText: message!.content,
      mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("mention-rebind", deliveryId) }));
    if (participantProjectionId) {
      // Reproduce an older frozen snapshot admitted from the participant face;
      // the original principal fact is still scoped to that active projection.
      const frozen = admitted.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
      frozen.raftMentionSubstitutions = [{ kind: "usergroup", handle: "runtime-human", token: "<!subteam^S_RUNTIME_GROUP>",
        installId: surface.install.id, bindingId: surface.binding.id, bindingEpoch: surface.binding.bindingEpoch }];
      await surface.db.update(externalOutboundDeliveries).set({
        renderSnapshot: frozen as unknown as Record<string, unknown>, renderSnapshotDigest: digestSlackBridgeRenderSnapshot(frozen),
      }).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
      if (mode === "group_joint_projection_removed") await surface.db.update(jointChannelServers).set({ status: "disconnected" })
        .where(eq(jointChannelServers.localChannelId, participantProjectionId));
    }
    if (mode === "group_agent_removed") await surface.db.delete(channelAgents).where(eq(channelAgents.agentId, target!.id));
    const binding = await reauthorizeSamePair(surface);
    if (!present) await surface.db.update(externalAddressabilityProjections).set({ state: "stale" })
      .where(eq(externalAddressabilityProjections.bindingId, binding.id));
    if (identity) {
      if (mode === "group_replaced") await surface.db.update(slackUsergroupIdentities).set({ providerUsergroupId: "S_REPLACEMENT" })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      if (mode === "group_retired") await surface.db.update(slackUsergroupIdentities).set({ humanCanonical: false })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      if (mode === "group_wrong_principal") await surface.db.update(slackUsergroupIdentities).set({ principalId: surface.owner.id })
        .where(eq(slackUsergroupIdentities.id, identity.id));
      if (mode === "group_target_removed") await surface.db.delete(serverMembers).where(eq(serverMembers.userId, target!.id));
      if (mode === "group_missing_original_fact") await surface.db.delete(messageMentions).where(eq(messageMentions.messageId, message!.id));
      if (mode === "group_mapping_read_failed") await surface.db.execute(sql`DROP TABLE slack_usergroup_identities`);
      if (mode === "group_replaced_before_dispatch") __setExternalDeliveryAttemptRowLockHookForTests(async () => {
        await surface.db.update(slackUsergroupIdentities).set({ providerUsergroupId: "S_REPLACEMENT" })
          .where(eq(slackUsergroupIdentities.id, identity!.id));
      });
    }
    if (mode === "external_fact_changed") await surface.db.update(externalMentionFacts).set({ handleAtSendTime: "changed-intent" })
      .where(eq(externalMentionFacts.messageId, message!.id));
    // The stale old observation must neither authorize a removed member nor block a current member.
    if (present) await surface.db.update(externalAddressabilityProjections).set({ state: "stale" })
      .where(eq(externalAddressabilityProjections.bindingId, surface.binding.id));
    if (removeBeforeDispatch) __setExternalDeliveryAttemptRowLockHookForTests(async () => {
      await surface.db.update(externalAddressabilityProjections).set({ state: "stale" })
        .where(eq(externalAddressabilityProjections.bindingId, binding.id));
    });
    let posted = "";
    const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => clock,
      fetch: (async (input, init) => {
        assert.equal(new URL(String(input)).pathname.split("/").at(-1), "chat.postMessage");
        posted = JSON.parse(String(init?.body)).text;
        return new Response(JSON.stringify({ ok: true, channel: "C_RUNTIME_TEST", ts: "1788541200.000800" }),
          { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch });
    let done!: () => void; let fail!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
    const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
      reconciliationKey: "mention-rebind", now: () => clock, workerIntervalMs: 60_000,
      async runWorkerOnce(input) { try {
        const result = await processExternalDeliveryPartitionHead(input);
        assert.equal(result.kind === "attempted" ? result.deliveryState : null, "accepted", JSON.stringify(result));
        assert.equal(posted, ["group_current", "group_joint_current", "group_agent_current"].includes(mode) ? "hello <!subteam^S_RUNTIME_GROUP> body continues"
          : ["group_replaced", "group_replaced_before_dispatch"].includes(mode) ? "hello <!subteam^S_REPLACEMENT> body continues"
          : mode === "external_present" ? "hello <@U_RUNTIME_HUMAN> body continues" : "hello @runtime-human body continues");
        const [delivery] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, admitted.delivery.id));
        assert.deepEqual(delivery.renderSnapshot, admitted.delivery.renderSnapshot, "render degradation cannot rewrite original intent");
        done(); return result;
      } catch (error) { fail(error); throw error; } },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    runtime.start();
    try { await Promise.race([finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("mention rebind timed out")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); await runtime.stop(); await provider.stop(); }
  });
}
