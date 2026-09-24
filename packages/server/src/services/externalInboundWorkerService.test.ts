import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  agents,
  attachmentObjectCharges,
  attachmentObjects,
  attachmentUploadReservations,
  attachments,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalInboundEvents,
  externalMessageAuthorFacts,
  externalMessageLinks,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import {
  __setExternalInboundCanonicalCommitHookForTests,
  __setExternalInboundEventRowLockHookForTests,
  createExternalInboundWorkerRuntime,
  enqueueExternalInboundEvent,
  processExternalInboundEventOnce,
  type ExternalInboundNormalizedMessage,
  type ExternalInboundRuntimeAuthority,
  type ExternalInboundWorkerDependencies,
} from "./externalInboundWorkerService.js";
import { processExternalInboundAttachmentOnce } from "./externalInboundAttachmentWorkerService.js";
import { externalInboundAttachmentIntentState } from "./externalInboundAttachmentStorageService.js";
import type { ExternalInboundAttachmentProviderAdapter } from "./externalAttachmentProviderAdapter.js";
import type { StorageBackend } from "./storageService.js";
import { slackActorProjectionRevisionAfterRefresh } from "./slackBridgeProvisioningControlPlane.js";


const NOW = new Date("2026-08-03T12:00:00.000Z");

beforeEach(async () => {
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  __setExternalInboundCanonicalCommitHookForTests(null);
  __setExternalInboundEventRowLockHookForTests(null);
  await closeTestDatabase();
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedFixture(privacyClass: "public" | "private" = "public") {
  const db = getDb();
  const [owner, member] = await db.insert(users).values([
    {
      email: `inbound-owner-${randomUUID()}@raft.test`,
      name: `inbound-owner-${randomUUID().slice(0, 8)}`,
      displayName: "Inbound Owner",
      passwordHash: "test",
      emailVerified: true,
    },
    {
      email: `inbound-member-${randomUUID()}@raft.test`,
      name: `inbound-member-${randomUUID().slice(0, 8)}`,
      displayName: "Inbound Member",
      passwordHash: "test",
      emailVerified: true,
    },
  ]).returning();
  const [server] = await db.insert(servers).values({
    name: "External Inbound Worker",
    slug: `external-inbound-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `external-inbound-${randomUUID()}`,
    type: privacyClass === "public" ? "channel" : "private",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: member.id },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `inbound-agent-${randomUUID().slice(0, 8)}`,
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "provider-test",
    appRegistrationId: "registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: "external-actor-1",
    displayName: "External Alice",
    handles: ["alice"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 4,
    observedAt: NOW,
  }).returning();
  const authority: ExternalInboundRuntimeAuthority = {
    runtimeRevision: "runtime-r1",
    provider: actor.provider,
    environment: "test",
    appRegistrationId: actor.appRegistrationId,
    installId: actor.installId,
    workspaceId: actor.workspaceId,
    providerAuthorityId: "authority-1",
    providerConversationId: "conversation-1",
    bindingId: "binding-1",
    bindingEpoch: 2,
    connectionEpoch: 3,
    raftChannelId: channel.id,
    privacyClass,
  };
  return { db, owner, member, server, channel, agent, actor, authority };
}

async function seedSecondExternalActor(fixture: Awaited<ReturnType<typeof seedFixture>>) {
  const [actor] = await fixture.db.insert(externalActorProjections).values({
    provider: fixture.actor.provider,
    appRegistrationId: fixture.actor.appRegistrationId,
    installId: fixture.actor.installId,
    workspaceId: fixture.actor.workspaceId,
    externalActorId: `external-actor-${randomUUID()}`,
    displayName: "External Bob",
    handles: ["bob"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 2,
    observedAt: NOW,
  }).returning();
  return actor;
}

async function seedSecondServerOccurrence(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  actor: typeof externalActorProjections.$inferSelect,
) {
  const [server] = await fixture.db.insert(servers).values({
    name: "External inbound second recipient",
    slug: `external-inbound-second-${randomUUID()}`,
    ownerId: fixture.owner.id,
  }).returning();
  await fixture.db.insert(serverMembers).values([
    { serverId: server.id, userId: fixture.owner.id, role: "owner" },
    { serverId: server.id, userId: fixture.member.id, role: "member" },
  ]);
  const [channel] = await fixture.db.insert(channels).values({
    serverId: server.id,
    name: `external-inbound-second-${randomUUID()}`,
    type: "channel",
  }).returning();
  await fixture.db.insert(channelHumans).values([
    { channelId: channel.id, userId: fixture.owner.id },
    { channelId: channel.id, userId: fixture.member.id },
  ]);
  return {
    ...fixture,
    server,
    channel,
    actor,
    authority: {
      ...fixture.authority,
      providerConversationId: `conversation-${randomUUID()}`,
      bindingId: randomUUID(),
      raftChannelId: channel.id,
    },
  };
}

async function convertFixtureToJointWithParticipant(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) {
  const [storageServer, participantServer] = await fixture.db.insert(servers).values([
    {
      name: "External inbound Joint storage",
      slug: `external-inbound-storage-${randomUUID()}`,
      ownerId: fixture.owner.id,
    },
    {
      name: "External inbound Joint participant",
      slug: `external-inbound-participant-${randomUUID()}`,
      ownerId: fixture.owner.id,
    },
  ]).returning();
  await fixture.db.insert(serverMembers).values([
    { serverId: participantServer.id, userId: fixture.owner.id, role: "owner" },
    { serverId: participantServer.id, userId: fixture.member.id, role: "member" },
  ]);
  const [canonical, participant] = await fixture.db.insert(channels).values([
    {
      serverId: storageServer.id,
      name: `external-inbound-canonical-${randomUUID()}`,
      type: "channel",
    },
    {
      serverId: participantServer.id,
      name: `external-inbound-participant-${randomUUID()}`,
      type: "joint",
    },
  ]).returning();
  await fixture.db.insert(channelHumans).values([
    { channelId: participant.id, userId: fixture.owner.id },
    { channelId: participant.id, userId: fixture.member.id },
  ]);
  await fixture.db.update(channels).set({ type: "joint" })
    .where(eq(channels.id, fixture.channel.id));
  const [joint] = await fixture.db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await fixture.db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: fixture.server.id,
      localChannelId: fixture.channel.id,
      role: "host",
      joinedByUserId: fixture.owner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: participantServer.id,
      localChannelId: participant.id,
      role: "participant",
      joinedByUserId: fixture.owner.id,
    },
  ]);
  return { canonical, joint, participant, participantServer };
}

function payload(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  providerMessageId: string,
  providerThreadId: string | null = null,
): ExternalInboundNormalizedMessage {
  return {
    schema: "external-inbound-normalized-event.v1",
    projectionId: fixture.actor.id,
    actorProjectionRevision: fixture.actor.projectionRevision,
    externalActorId: fixture.actor.externalActorId,
    providerMessageId,
    providerThreadId,
    content: `provider content ${providerMessageId}`,
    createdAt: "2026-08-03T11:59:00.000Z",
  };
}

async function enqueue(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  providerEventId: string,
  body: ExternalInboundNormalizedMessage,
  receivedAt = NOW,
) {
  const plaintext = JSON.stringify(body);
  const admitted = await enqueueExternalInboundEvent({
    db: fixture.db,
    authority: fixture.authority,
    providerEventId,
    normalizedPayloadDigest: digest(plaintext),
    encryptedPayload: plaintext,
    envelopeKeyId: "opaque-envelope-key-1",
    payloadSchemaVersion: body.schema === "external-inbound-normalized-event.v2" ? 2 : 1,
    payloadExpiresAt: new Date(receivedAt.getTime() + 5 * 60_000),
    receivedAt,
  });
  return { ...admitted, plaintext };
}

function dependencies(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  input: {
    now?: () => Date;
    runtime?: ExternalInboundRuntimeAuthority | null;
    decrypt?: ExternalInboundWorkerDependencies["decryptNormalizedPayload"];
    onMessageCommitted?: ExternalInboundWorkerDependencies["onMessageCommitted"];
    onMessageCommittedError?: ExternalInboundWorkerDependencies["onMessageCommittedError"];
    calls?: { decrypt: number; runtime: number };
  } = {},
): ExternalInboundWorkerDependencies {
  const calls = input.calls ?? { decrypt: 0, runtime: 0 };
  return {
    now: input.now ?? (() => NOW),
    async decryptNormalizedPayload(args) {
      calls.decrypt += 1;
      if (input.decrypt) return input.decrypt(args);
      return args.ciphertext;
    },
    async resolveCurrentRuntime() {
      calls.runtime += 1;
      return input.runtime === undefined ? fixture.authority : input.runtime;
    },
    ...(input.onMessageCommitted ? { onMessageCommitted: input.onMessageCommitted } : {}),
    ...(input.onMessageCommittedError ? { onMessageCommittedError: input.onMessageCommittedError } : {}),
  };
}

async function process(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  deps: ExternalInboundWorkerDependencies | null = dependencies(fixture),
) {
  return processExternalInboundEventOnce({
    db: fixture.db,
    leaseOwner: "inbound-worker-1",
    dependencies: deps,
  });
}

async function createInboundFileHarness(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) {
  const body = Buffer.from("one immutable provider file", "utf8");
  const writes = new Map<string, Buffer>();
  let downloads = 0;
  let inspections = 0;
  let streamWrites = 0;
  let inspectFailure: string | null = null;
  let revokeAfterPutActorId: string | null = null;
  const revokedActors = new Set<string>();
  const maximumByServer = new Map<string, number>();
  let occurrence = 0;
  const storage: StorageBackend = {
    async put(key, data) { writes.set(key, Buffer.from(data)); },
    async putStream(key, data, _contentType, contentLength) {
      streamWrites += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(Buffer.from(chunk));
      const stored = Buffer.concat(chunks);
      assert.equal(stored.length, contentLength);
      writes.set(key, stored);
      if (revokeAfterPutActorId) {
        revokedActors.add(revokeAfterPutActorId);
        revokeAfterPutActorId = null;
      }
    },
    async get(key) {
      const value = writes.get(key);
      if (!value) throw new Error("missing");
      return Readable.from(value);
    },
    async delete(key) { writes.delete(key); },
  };
  const adapter: ExternalInboundAttachmentProviderAdapter<{ fileId: string }> = {
    provider: fixture.authority.provider,
    capabilities: {
      inboundDownload: true,
      outboundUpload: false,
      batchCompletion: false,
      authenticatedCorrelation: false,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024,
    },
    async inspectInboundAsset({ providerFileId }) {
      inspections += 1;
      if (inspectFailure) throw new Error(inspectFailure);
      return {
        metadata: {
          providerFileId,
          sourceExternalActorId: fixture.actor.externalActorId,
          filename: "shared.txt",
          declaredSizeBytes: body.length,
          mimeType: "text/plain",
          providerCreatedAt: NOW,
        },
        downloadHandle: { fileId: providerFileId },
      };
    },
    async *downloadInboundAsset() {
      downloads += 1;
      yield body;
    },
    classifyFailure(error) {
      return {
        class: "deterministic",
        reason: error instanceof Error ? error.message : "fixture_failure",
        retryAfterMs: null,
        scope: "asset_global",
      };
    },
  };

  const attachmentDependencies = (at: Date) => ({
    storage,
    resolveAdapter: (provider: string) => provider === adapter.provider ? adapter : null,
    authorityIsCurrent: async (_authority: unknown, sourceActorProjectionId: string) => (
      !revokedActors.has(sourceActorProjectionId)
    ),
    maximumFileSizeBytes: async (serverId: string) => maximumByServer.get(serverId) ?? 1024,
    now: () => at,
  });
  const prepare = async (
    actor: typeof externalActorProjections.$inferSelect,
    suffix: string,
    target = fixture,
  ) => {
    occurrence += 1;
    const at = new Date(NOW.getTime() + occurrence * 60_000);
    const filePayload: ExternalInboundNormalizedMessage = {
      ...payload(target, `provider-message-${suffix}`),
      schema: "external-inbound-normalized-event.v2",
      projectionId: actor.id,
      actorProjectionRevision: actor.projectionRevision,
      externalActorId: actor.externalActorId,
      providerFileIds: ["provider-file-shared"],
    };
    const admitted = await enqueue(target, `event-${suffix}`, filePayload, at);
    let prepared = await process(target, dependencies(target, { now: () => at }));
    for (let attempt = 0; attempt < 10 && (
      !("eventId" in prepared) || prepared.eventId !== admitted.event.id
    ); attempt += 1) {
      prepared = await process(target, dependencies(target, { now: () => at }));
    }
    assert.deepEqual(prepared, {
      kind: "blocked",
      eventId: admitted.event.id,
      reason: "attachment_transfer_pending",
    });
    return { admitted, at, target };
  };
  const processTransfer = (suffix: string, at: Date) => processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: `attachment-worker-${suffix}`,
    dependencies: attachmentDependencies(at),
  });

  return {
    body,
    writes,
    counters: () => ({ downloads, inspections, streamWrites }),
    failInspection(reason: string) { inspectFailure = reason; },
    revokeActor(actorId: string) { revokedActors.add(actorId); },
    revokeActorAfterNextPut(actorId: string) { revokeAfterPutActorId = actorId; },
    setMaximum(serverId: string, maximumBytes: number) { maximumByServer.set(serverId, maximumBytes); },
    prepare,
    processTransfer,
    async commit(at: Date, target = fixture) {
      return process(target, dependencies(target, {
        now: () => new Date(at.getTime() + 30_000),
      }));
    },
    async deliver(actor: typeof externalActorProjections.$inferSelect, suffix: string) {
      const { admitted, at } = await prepare(actor, suffix);
      let transfer = await processExternalInboundAttachmentOnce({
        db: fixture.db,
        leaseOwner: `attachment-worker-${suffix}-1`,
        dependencies: attachmentDependencies(at),
      });
      if (transfer.kind === "metadata_ready") {
        transfer = await processExternalInboundAttachmentOnce({
          db: fixture.db,
          leaseOwner: `attachment-worker-${suffix}-2`,
          dependencies: attachmentDependencies(at),
        });
      }
      if (transfer.kind === "stored") {
        const committed = await process(fixture, dependencies(fixture, {
          now: () => new Date(at.getTime() + 30_000),
        }));
        assert.equal(committed.kind, "committed");
        return { admitted, transfer, committed };
      }
      return { admitted, transfer, committed: null };
    },
  };
}

test("disabled worker is side-effect free and top-level commit is one atomic canonical unit", async () => {
  const fixture = await seedFixture();
  const admitted = await enqueue(fixture, "event-1", payload(fixture, "provider-message-1"));
  assert.deepEqual(await process(fixture, null), { kind: "disabled" });
  assert.equal((await fixture.db.select().from(externalInboundEvents))[0]?.status, "queued");

  const calls = { decrypt: 0, runtime: 0 };
  const result = await process(fixture, dependencies(fixture, { calls }));
  assert.equal(result.kind, "committed");
  assert.equal(result.eventId, admitted.event.id);
  assert.deepEqual(calls, { decrypt: 1, runtime: 1 });

  const [event] = await fixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "committed");
  assert.equal(event.encryptedPayload, null);
  assert.equal(event.envelopeKeyId, null);
  assert.equal(event.payloadExpiresAt, null);
  assert.ok(event.payloadErasedAt);
  assert.match(event.payloadTombstoneDigest ?? "", /^[0-9a-f]{64}$/);
  assert.ok(event.committedMessageId);
  const projected = await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"));
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.id, event.committedMessageId);
  assert.equal((await fixture.db.select().from(externalMessageAuthorFacts)).length, 1);
  const [link] = await fixture.db.select().from(externalMessageLinks);
  assert.equal(link.firstDirection, "provider_inbound");
  assert.equal(link.providerMessageId, "provider-message-1");
  assert.equal((await fixture.db.select().from(inboxNotificationFacts)).length, 3);
});

test("v2 file events stay non-canonical until provider bytes are stored, then link atomically", async () => {
  const fixture = await seedFixture();
  const fileBodies = new Map([
    ["provider-file-1", Buffer.from("first provider attachment", "utf8")],
    ["provider-file-2", Buffer.from("second provider attachment", "utf8")],
  ]);
  const filePayload: ExternalInboundNormalizedMessage = {
    ...payload(fixture, "provider-message-file-1"),
    schema: "external-inbound-normalized-event.v2",
    providerFileIds: [...fileBodies.keys()],
  };
  const admitted = await enqueue(fixture, "event-file-1", filePayload);
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: admitted.event.id,
    reason: "attachment_transfer_pending",
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 0);
  const writes = new Map<string, Buffer>();
  const storage: StorageBackend = {
    async put(key, data) { writes.set(key, Buffer.from(data)); },
    async putStream(key, data, _contentType, contentLength) {
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(Buffer.from(chunk));
      const stored = Buffer.concat(chunks);
      assert.equal(stored.length, contentLength);
      writes.set(key, stored);
    },
    async get(key) {
      const value = writes.get(key);
      if (!value) throw new Error("missing");
      return Readable.from(value);
    },
    async delete(key) { writes.delete(key); },
  };
  const adapter: ExternalInboundAttachmentProviderAdapter<{ fileId: string }> = {
    provider: fixture.authority.provider,
    capabilities: {
      inboundDownload: true,
      outboundUpload: false,
      batchCompletion: false,
      authenticatedCorrelation: false,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024,
    },
    async inspectInboundAsset({ providerFileId }) {
      const body = fileBodies.get(providerFileId);
      if (!body) throw new Error("unknown fixture file");
      return {
        metadata: {
          providerFileId,
          sourceExternalActorId: fixture.actor.externalActorId,
          filename: `${providerFileId}.txt`,
          declaredSizeBytes: body.length,
          mimeType: "text/plain",
          providerCreatedAt: NOW,
        },
        downloadHandle: { fileId: providerFileId },
      };
    },
    async *downloadInboundAsset({ handle }) {
      yield fileBodies.get(handle.fileId)!;
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
  const attachmentDependencies = {
    storage,
    resolveAdapter: (provider: string) => provider === adapter.provider ? adapter : null,
    authorityIsCurrent: async (authority: { provider: string; bindingId: string; connectionEpoch: number }) => (
      authority.provider === fixture.authority.provider
      && authority.bindingId === fixture.authority.bindingId
      && authority.connectionEpoch === fixture.authority.connectionEpoch
    ),
    maximumFileSizeBytes: async () => 1024,
    now: () => NOW,
  };
  const firstMetadata = await processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: "attachment-worker-first-metadata",
    dependencies: attachmentDependencies,
  });
  assert.equal(firstMetadata.kind, "metadata_ready");
  const jobsAfterFirstMetadata = await fixture.db.select({
    id: externalAttachmentTransferJobs.id,
    providerFileId: externalAttachmentAssets.providerFileId,
    phase: externalAttachmentTransferJobs.phase,
  }).from(externalAttachmentTransferJobs).innerJoin(
    externalAttachmentAssets,
    eq(externalAttachmentAssets.id, externalAttachmentTransferJobs.assetId),
  );
  const delayedMetadataJob = jobsAfterFirstMetadata.find(
    (job) => job.phase === "metadata",
  );
  const waitingDownloadJob = jobsAfterFirstMetadata.find(
    (job) => job.phase === "download",
  );
  assert.ok(delayedMetadataJob && waitingDownloadJob);
  await fixture.db.update(externalAttachmentTransferJobs).set({
    state: "retry_wait",
    nextAttemptAt: new Date(NOW.getTime() + 30_000),
    lastErrorClass: "provider_attachment_credential_busy",
  }).where(eq(externalAttachmentTransferJobs.id, delayedMetadataJob.id));
  const waitingForBatchMetadata = await processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: "attachment-worker-waiting-download",
    dependencies: attachmentDependencies,
  });
  assert.equal(waitingForBatchMetadata.kind, "metadata_ready");
  const [pacedDownloadJob] = await fixture.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.id, waitingDownloadJob.id));
  assert.ok(pacedDownloadJob);
  assert.equal(pacedDownloadJob.state, "queued");
  assert.equal(
    pacedDownloadJob.nextAttemptAt.getTime(),
    NOW.getTime() + 31_000,
    "a batch peer awaiting metadata must yield instead of hot-looping on the shared credential",
  );
  await fixture.db.update(externalAttachmentTransferJobs).set({
    state: "queued",
    nextAttemptAt: NOW,
    lastErrorClass: null,
  }).where(eq(externalAttachmentTransferJobs.id, delayedMetadataJob.id));
  const readyAt = new Date(NOW.getTime() + 31_000);
  const readyAttachmentDependencies = { ...attachmentDependencies, now: () => readyAt };
  let storedCount = 0;
  for (let index = 0; index < fileBodies.size * 3 && storedCount < fileBodies.size; index += 1) {
    const transfer = await processExternalInboundAttachmentOnce({
      db: fixture.db,
      leaseOwner: `attachment-worker-${index + 1}`,
      dependencies: readyAttachmentDependencies,
    });
    assert.ok(transfer.kind === "metadata_ready" || transfer.kind === "stored");
    if (transfer.kind === "stored") storedCount += 1;
  }
  assert.equal(storedCount, fileBodies.size);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 0);
  const committedAt = new Date(NOW.getTime() + 30_000);
  const committed = await process(fixture, dependencies(fixture, { now: () => committedAt }));
  assert.equal(committed.kind, "committed");
  if (committed.kind !== "committed") assert.fail("expected file message commit");
  const linkedAttachments = await fixture.db.select().from(attachments)
    .where(eq(attachments.messageId, committed.messageId));
  assert.deepEqual(
    linkedAttachments.sort((left, right) => left.messagePosition! - right.messagePosition!)
      .map((attachment) => ({
        uploaderType: attachment.uploaderType,
        uploaderId: attachment.uploaderId,
        filename: attachment.filename,
        messagePosition: attachment.messagePosition,
      })),
    [...fileBodies.keys()].map((providerFileId, messagePosition) => ({
      uploaderType: "external_projection",
      uploaderId: fixture.actor.id,
      filename: `${providerFileId}.txt`,
      messagePosition,
    })),
  );
  const assets = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  assert.deepEqual(assets.map((asset) => asset.state), ["linked", "linked"]);
  assert.deepEqual(facts.map((fact) => fact.state), ["linked", "linked"]);
  assert.ok(facts.every((fact) => fact.messageLinkId));
  assert.deepEqual(jobs.map((job) => job.state), ["completed", "completed"]);
  assert.deepEqual(
    [...writes.values()].map((value) => value.toString("utf8")).sort(),
    [...fileBodies.values()].map((value) => value.toString("utf8")).sort(),
  );
});

test("the same actor can re-share one stored provider file without a second download or charge", async () => {
  const fixture = await seedFixture();
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.deliver(fixture.actor, "reshare-same-1");
  const second = await harness.deliver(fixture.actor, "reshare-same-2");
  assert.equal(first.transfer.kind, "stored");
  assert.equal(second.transfer.kind, "stored");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 2, streamWrites: 1 });
  assert.equal(harness.writes.size, 1);
  assert.equal((await fixture.db.select().from(externalAttachmentAssets)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentUploadReservations)).length, 2);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((fact) => fact.sourceActorProjectionId === fixture.actor.id));
  const projections = await fixture.db.select().from(attachments)
    .where(eq(attachments.objectId, (await fixture.db.select().from(attachmentObjects))[0]!.id));
  assert.equal(projections.length, 2);
  assert.ok(projections.every((projection) => (
    projection.uploaderId === fixture.actor.id
    && projection.uploaderType === "external_projection"
    && projection.messageId !== null
  )));
});

test("two queued occurrences elect one materializer across metadata A, metadata B, store A, reuse B", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "interleaved-a");
  const second = await harness.prepare(secondActor, "interleaved-b");

  assert.equal((await harness.processTransfer("interleaved-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("interleaved-2", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("interleaved-3", second.at)).kind, "stored");
  assert.equal((await harness.processTransfer(
    "interleaved-4",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");

  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  const projections = await fixture.db.select().from(attachments);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentUploadReservations)).length, 2);
  assert.equal(facts.length, 2);
  assert.equal(jobs.length, 2);
  assert.equal(projections.length, 2);
  assert.equal(asset.state, "linked");
  assert.equal(asset.materializationOwnerJobId, jobs.find((job) => (
    job.messageFactId === facts.find((fact) => fact.inboundEventId === first.admitted.event.id)!.id
  ))!.id);
  assert.ok(jobs.every((job) => job.state === "completed"));
  assert.ok(facts.every((fact) => fact.state === "linked"));
  assert.deepEqual(
    new Set(projections.map((projection) => projection.uploaderId)),
    new Set([fixture.actor.id, secondActor.id]),
  );
  assert.deepEqual(
    new Set(projections.map((projection) => projection.messageId)),
    new Set([
      (await fixture.db.select().from(externalInboundEvents)
        .where(eq(externalInboundEvents.id, first.admitted.event.id)))[0]!.committedMessageId,
      (await fixture.db.select().from(externalInboundEvents)
        .where(eq(externalInboundEvents.id, second.admitted.event.id)))[0]!.committedMessageId,
    ]),
  );
});

test("two workers racing queued occurrences still perform one materialization", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  await harness.prepare(fixture.actor, "concurrent-a");
  const second = await harness.prepare(secondActor, "concurrent-b");
  assert.equal((await harness.processTransfer("concurrent-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("concurrent-metadata-2", second.at)).kind, "metadata_ready");

  const raceAt = new Date(second.at.getTime() + 1_000);
  const raced = await Promise.all([
    harness.processTransfer("concurrent-store-a", raceAt),
    harness.processTransfer("concurrent-store-b", raceAt),
  ]);
  assert.ok(raced.every((result) => result.kind === "stored" || result.kind === "metadata_ready"));
  let facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  if (facts.some((fact) => fact.state === "pending")) {
    assert.equal((await harness.processTransfer(
      "concurrent-reuse",
      new Date(raceAt.getTime() + 1_000),
    )).kind, "stored");
    facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  }
  assert.ok(facts.every((fact) => fact.state === "stored"));
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(externalAttachmentAssets)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachments)).length, 2);
  assert.equal((await fixture.db.select().from(attachmentUploadReservations)).length, 2);
  assert.ok((await fixture.db.select().from(externalAttachmentTransferJobs))
    .every((job) => job.state === "completed"));
});

test("revoked owner occurrence hands frozen metadata to a valid waiter without poisoning the asset", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "owner-revoked-a");
  const second = await harness.prepare(secondActor, "owner-revoked-b");
  assert.equal((await harness.processTransfer("owner-revoked-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("owner-revoked-metadata-2", second.at)).kind, "metadata_ready");

  harness.revokeActor(fixture.actor.id);
  const revoked = await harness.processTransfer("owner-revoked-a", second.at);
  assert.equal(revoked.kind, "unavailable");
  assert.equal(revoked.kind === "unavailable" ? revoked.reason : null, "attachment_authority_revoked");
  const [transferredAsset] = await fixture.db.select().from(externalAttachmentAssets);
  const factsBeforeStore = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobsBeforeStore = await fixture.db.select().from(externalAttachmentTransferJobs);
  const waiterFact = factsBeforeStore.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const waiterJob = jobsBeforeStore.find((job) => job.messageFactId === waiterFact.id)!;
  assert.equal(transferredAsset.state, "metadata_ready");
  assert.equal(transferredAsset.materializationOwnerJobId, waiterJob.id);

  assert.equal((await harness.processTransfer(
    "owner-revoked-b",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");
  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.equal((await harness.commit(second.at)).kind, "committed");
  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(asset.state, "linked");
  assert.equal(asset.materializationOwnerJobId, waiterJob.id);
  assert.deepEqual(new Set(facts.map((fact) => fact.state)), new Set(["revoked", "linked"]));
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  const [firstEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, first.admitted.event.id));
  assert.ok(firstEvent.committedMessageId);
});

test("ownership can hand off repeatedly when successive occurrence actors are revoked", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const thirdActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  await harness.prepare(fixture.actor, "handoff-a");
  await harness.prepare(secondActor, "handoff-b");
  const third = await harness.prepare(thirdActor, "handoff-c");
  assert.equal((await harness.processTransfer("handoff-metadata-1", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("handoff-metadata-2", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("handoff-metadata-3", third.at)).kind, "metadata_ready");

  harness.revokeActor(fixture.actor.id);
  assert.equal((await harness.processTransfer("handoff-revoked-a", third.at)).kind, "unavailable");
  harness.revokeActor(secondActor.id);
  const afterFirstHandoff = new Date(third.at.getTime() + 1_000);
  assert.equal((await harness.processTransfer("handoff-revoked-b", afterFirstHandoff)).kind, "unavailable");
  assert.equal((await harness.processTransfer(
    "handoff-valid-c",
    new Date(afterFirstHandoff.getTime() + 1_000),
  )).kind, "stored");

  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  const thirdFact = facts.find((fact) => fact.inboundEventId === third.admitted.event.id)!;
  const thirdJob = jobs.find((job) => job.messageFactId === thirdFact.id)!;
  assert.equal(asset.state, "stored");
  assert.equal(asset.materializationOwnerJobId, thirdJob.id);
  assert.deepEqual(facts.map((fact) => fact.state).sort(), ["revoked", "revoked", "stored"]);
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 4, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
});

test("handoff skips a future retry waiter so a runnable occurrence materializes immediately", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const thirdActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "retry-handoff-a");
  const second = await harness.prepare(secondActor, "retry-handoff-b");
  const third = await harness.prepare(thirdActor, "retry-handoff-c");
  assert.equal((await harness.processTransfer("retry-handoff-metadata-1", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("retry-handoff-metadata-2", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("retry-handoff-metadata-3", third.at)).kind, "metadata_ready");

  const factsBeforeHandoff = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobsBeforeHandoff = await fixture.db.select().from(externalAttachmentTransferJobs);
  const secondFact = factsBeforeHandoff.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const thirdFact = factsBeforeHandoff.find((fact) => fact.inboundEventId === third.admitted.event.id)!;
  const secondJob = jobsBeforeHandoff.find((job) => job.messageFactId === secondFact.id)!;
  const thirdJob = jobsBeforeHandoff.find((job) => job.messageFactId === thirdFact.id)!;
  const retryAt = new Date(third.at.getTime() + 24 * 60 * 60 * 1_000);
  await fixture.db.update(externalAttachmentTransferJobs).set({
    state: "retry_wait",
    nextAttemptAt: retryAt,
    lastErrorClass: "provider_rate_limited",
    updatedAt: third.at,
  }).where(eq(externalAttachmentTransferJobs.id, secondJob.id));

  harness.revokeActor(fixture.actor.id);
  const handoffAt = third.at;
  assert.equal((await harness.processTransfer("retry-handoff-revoked-a", handoffAt)).kind, "unavailable");
  const [handedOffAsset] = await fixture.db.select().from(externalAttachmentAssets);
  const [preservedRetry] = await fixture.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.id, secondJob.id));
  assert.equal(handedOffAsset.materializationOwnerJobId, thirdJob.id);
  assert.equal(preservedRetry.state, "retry_wait");
  assert.equal(preservedRetry.nextAttemptAt.getTime(), retryAt.getTime());

  assert.equal((await harness.processTransfer("retry-handoff-zero-eligible", handoffAt)).kind, "empty");
  assert.equal((await harness.processTransfer(
    "retry-handoff-runnable-c",
    new Date(handoffAt.getTime() + 1_000),
  )).kind, "stored");
  assert.equal((await harness.processTransfer(
    "retry-handoff-due-b",
    new Date(retryAt.getTime() + 1_000),
  )).kind, "stored");

  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const firstFact = facts.find((fact) => fact.inboundEventId === first.admitted.event.id)!;
  const secondFinalFact = facts.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const thirdFinalFact = facts.find((fact) => fact.inboundEventId === third.admitted.event.id)!;
  assert.equal(firstFact.state, "revoked");
  assert.equal(secondFinalFact.state, "stored");
  assert.equal(thirdFinalFact.state, "stored");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 4, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
});

test("an unowned metadata-ready asset can be claimed by a future occurrence", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "future-owner-a");
  assert.equal((await harness.processTransfer("future-owner-metadata-a", first.at)).kind, "metadata_ready");
  harness.revokeActor(fixture.actor.id);
  assert.equal((await harness.processTransfer("future-owner-revoked-a", first.at)).kind, "unavailable");
  const [unowned] = await fixture.db.select().from(externalAttachmentAssets);
  assert.equal(unowned.state, "metadata_ready");
  assert.equal(unowned.materializationOwnerJobId, null);

  const second = await harness.prepare(secondActor, "future-owner-b");
  assert.equal((await harness.processTransfer("future-owner-metadata-b", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("future-owner-store-b", second.at)).kind, "stored");
  const [claimed] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  const secondFact = facts.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const secondJob = jobs.find((job) => job.messageFactId === secondFact.id)!;
  assert.equal(claimed.state, "stored");
  assert.equal(claimed.materializationOwnerJobId, secondJob.id);
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
});

test("authority loss after owner PUT leaves its cleanup intent and lets the waiter publish a new object", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "post-put-revoked-a");
  const second = await harness.prepare(secondActor, "post-put-revoked-b");
  assert.equal((await harness.processTransfer("post-put-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("post-put-metadata-2", second.at)).kind, "metadata_ready");

  harness.revokeActorAfterNextPut(fixture.actor.id);
  assert.equal((await harness.processTransfer("post-put-owner", second.at)).kind, "unavailable");
  assert.equal((await harness.processTransfer(
    "post-put-waiter",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");

  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const firstFact = facts.find((fact) => fact.inboundEventId === first.admitted.event.id)!;
  const secondFact = facts.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  assert.equal(await externalInboundAttachmentIntentState(fixture.db, firstFact.id), "planned");
  assert.equal(await externalInboundAttachmentIntentState(fixture.db, secondFact.id), "completed");
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachments)).length, 1);
  assert.deepEqual(harness.counters(), { downloads: 2, inspections: 4, streamWrites: 2 });
  assert.equal(harness.writes.size, 2, "the failed owner's distinct planned artifact remains cleanup-owned");
});

test("owner server-plan rejection transfers materialization to an eligible server", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const secondTarget = await seedSecondServerOccurrence(fixture, secondActor);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "plan-small-a");
  const second = await harness.prepare(secondActor, "plan-large-b", secondTarget);
  assert.equal((await harness.processTransfer("plan-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("plan-metadata-2", second.at)).kind, "metadata_ready");

  harness.setMaximum(fixture.server.id, 1);
  const rejected = await harness.processTransfer("plan-small-owner", second.at);
  assert.equal(rejected.kind, "unavailable");
  assert.equal(rejected.kind === "unavailable" ? rejected.reason : null, "recipient_plan_file_limit_exceeded");
  assert.equal((await harness.processTransfer(
    "plan-large-waiter",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");
  assert.equal((await harness.commit(second.at, fixture)).kind, "committed");
  assert.equal((await harness.commit(second.at, secondTarget)).kind, "committed");

  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(asset.state, "linked");
  assert.deepEqual(new Set(facts.map((fact) => fact.state)), new Set(["unavailable", "linked"]));
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 4, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  const [firstEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, first.admitted.event.id));
  const [secondEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, second.admitted.event.id));
  assert.ok(firstEvent.committedMessageId);
  assert.ok(secondEvent.committedMessageId);
});

test("provider-file global failure is decided once and all queued occurrences converge unavailable", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  await harness.prepare(fixture.actor, "global-failure-a");
  const second = await harness.prepare(secondActor, "global-failure-b");
  assert.equal((await harness.processTransfer("global-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("global-metadata-2", second.at)).kind, "metadata_ready");

  harness.failInspection("provider_file_not_found");
  const ownerFailure = await harness.processTransfer("global-owner", second.at);
  assert.equal(ownerFailure.kind, "unavailable");
  const waiterFailure = await harness.processTransfer(
    "global-waiter",
    new Date(second.at.getTime() + 1_000),
  );
  assert.equal(waiterFailure.kind, "unavailable");
  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(asset.state, "failed");
  assert.equal(asset.terminalFailureClass, "provider_file_not_found");
  assert.ok(facts.every((fact) => fact.state === "unavailable"));
  assert.ok(facts.every((fact) => fact.terminalFailureClass === "provider_file_not_found"));
  assert.deepEqual(harness.counters(), { downloads: 0, inspections: 3, streamWrites: 0 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 0);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 0);
  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.equal((await harness.commit(second.at)).kind, "committed");
});

test("a different actor gets an occurrence-owned projection and later failure cannot poison shared bytes", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.deliver(fixture.actor, "reshare-distinct-1");
  const second = await harness.deliver(secondActor, "reshare-distinct-2");
  assert.equal(first.transfer.kind, "stored");
  assert.equal(second.transfer.kind, "stored");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 2, streamWrites: 1 });

  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(facts.length, 2);
  assert.deepEqual(
    new Set(facts.map((fact) => fact.sourceActorProjectionId)),
    new Set([fixture.actor.id, secondActor.id]),
  );
  const projections = await fixture.db.select().from(attachments);
  assert.equal(projections.length, 2);
  assert.ok(projections.every((projection) => projection.objectId === asset.raftObjectId));
  assert.deepEqual(
    new Set(projections.map((projection) => projection.uploaderId)),
    new Set([fixture.actor.id, secondActor.id]),
  );

  harness.revokeActor(secondActor.id);
  const failed = await harness.deliver(secondActor, "reshare-distinct-failed");
  assert.equal(failed.transfer.kind, "unavailable");
  const [preservedAsset] = await fixture.db.select().from(externalAttachmentAssets);
  assert.equal(preservedAsset.id, asset.id);
  assert.equal(preservedAsset.state, "linked");
  assert.equal(preservedAsset.raftObjectId, asset.raftObjectId);
  assert.equal(preservedAsset.sourceContentDigest, asset.sourceContentDigest);
  const firstProjection = projections.find((projection) => projection.uploaderId === fixture.actor.id)!;
  const [stillLinked] = await fixture.db.select().from(attachments)
    .where(eq(attachments.id, firstProjection.id));
  assert.equal(stillLinked.messageId, firstProjection.messageId);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 2, streamWrites: 1 });
});

test("a terminal provider-file failure commits one visible unavailable marker without a fake attachment", async () => {
  const fixture = await seedFixture();
  const filePayload: ExternalInboundNormalizedMessage = {
    ...payload(fixture, "provider-message-file-missing"),
    schema: "external-inbound-normalized-event.v2",
    providerFileIds: ["provider-file-missing"],
  };
  const admitted = await enqueue(fixture, "event-file-missing", filePayload);
  const pending = await process(fixture);
  assert.equal(pending.kind, "blocked");
  const adapter: ExternalInboundAttachmentProviderAdapter<never> = {
    provider: fixture.authority.provider,
    capabilities: {
      inboundDownload: true,
      outboundUpload: false,
      batchCompletion: false,
      authenticatedCorrelation: false,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024,
    },
    async inspectInboundAsset() { throw new Error("missing"); },
    async *downloadInboundAsset() { throw new Error("must not download"); },
    classifyFailure() {
      return {
        class: "deterministic",
        reason: "provider_file_not_found",
        retryAfterMs: null,
        scope: "asset_global",
      };
    },
  };
  const storage: StorageBackend = {
    async put() { assert.fail("must not store"); },
    async putStream() { assert.fail("must not store"); },
    async get() { throw new Error("must not read"); },
    async delete() {},
  };
  const unavailable = await processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: "attachment-worker-missing",
    dependencies: {
      storage,
      resolveAdapter: () => adapter,
      authorityIsCurrent: async () => true,
      maximumFileSizeBytes: async () => 1024,
      now: () => NOW,
    },
  });
  if (unavailable.kind === "metadata_ready") {
    assert.fail("missing provider file must fail during metadata inspection");
  }
  assert.equal(unavailable.kind, "unavailable");
  if (unavailable.kind !== "unavailable") assert.fail("expected unavailable attachment");
  assert.equal(unavailable.reason, "provider_file_not_found");
  const committed = await process(fixture, dependencies(fixture, {
    now: () => new Date(NOW.getTime() + 30_000),
  }));
  assert.equal(committed.kind, "committed");
  if (committed.kind !== "committed") assert.fail("expected unavailable file message commit");
  const [message] = await fixture.db.select().from(messages)
    .where(eq(messages.id, committed.messageId));
  assert.match(message.content, /\[One or more attachments unavailable\]$/);
  assert.equal((await fixture.db.select().from(attachments)
    .where(eq(attachments.messageId, committed.messageId))).length, 0);
  const [fact] = await fixture.db.select().from(externalAttachmentMessageFacts)
    .where(eq(externalAttachmentMessageFacts.inboundEventId, admitted.event.id));
  assert.equal(fact.state, "unavailable");
  assert.equal(fact.terminalFailureClass, "provider_file_not_found");
  assert.ok(fact.messageLinkId);
});

test("top-level Joint inbound keeps local authority but commits only to canonical storage", async () => {
  const fixture = await seedFixture("public");
  const [storageServer] = await fixture.db.insert(servers).values({
    name: "External inbound Joint storage",
    slug: `external-inbound-storage-${randomUUID()}`,
    ownerId: fixture.owner.id,
  }).returning();
  const [canonical] = await fixture.db.insert(channels).values({
    serverId: storageServer.id,
    name: `external-inbound-canonical-${randomUUID()}`,
    type: "channel",
  }).returning();
  await fixture.db.update(channels).set({ type: "joint" })
    .where(eq(channels.id, fixture.channel.id));
  const [joint] = await fixture.db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await fixture.db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.server.id,
    localChannelId: fixture.channel.id,
    role: "host",
    joinedByUserId: fixture.owner.id,
  });

  const admitted = await enqueue(fixture, "event-joint-1", payload(fixture, "provider-joint-message-1"));
  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  assert.equal(result.eventId, admitted.event.id);
  const [projected] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(projected!.channelId, canonical.id);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.channelId, fixture.channel.id))).length, 0);

  await fixture.db.update(jointChannelServers).set({ role: "participant" })
    .where(eq(jointChannelServers.localChannelId, fixture.channel.id));
  await enqueue(fixture, "event-joint-participant", payload(fixture, "provider-joint-message-2"));
  const rejected = await process(fixture);
  assert.deepEqual(rejected, {
    kind: "blocked",
    eventId: (await fixture.db.select().from(externalInboundEvents)
      .where(eq(externalInboundEvents.providerEventId, "event-joint-participant")))[0]!.id,
    reason: "commit_authority_lost_or_root_unavailable",
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 1);
});

test("provider event replay is exact and conflicting frozen authority fails closed", async () => {
  const fixture = await seedFixture();
  const body = payload(fixture, "provider-message-1");
  const [left, right] = await Promise.all([
    enqueue(fixture, "event-1", body),
    enqueue(fixture, "event-1", body),
  ]);
  const [first, replay] = left.duplicate ? [right, left] : [left, right];
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.id, first.event.id);
  await assert.rejects(
    enqueueExternalInboundEvent({
      db: fixture.db,
      authority: { ...fixture.authority, connectionEpoch: fixture.authority.connectionEpoch + 1 },
      providerEventId: "event-1",
      normalizedPayloadDigest: digest(first.plaintext),
      encryptedPayload: first.plaintext,
      envelopeKeyId: "opaque-envelope-key-1",
      payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
      receivedAt: NOW,
    }),
    /conflicts with frozen admission/,
  );
  assert.equal((await fixture.db.select().from(externalInboundEvents)).length, 1);
});

test("sealed payload parsing is closed, UTC-canonical, and binds privacy in AAD", async () => {
  const fixture = await seedFixture("private");
  const validBody = payload(fixture, "provider-message-aad");
  const admitted = await enqueue(fixture, "event-aad", validBody);
  let observedPrivacyClass: "public" | "private" | null = null;
  const committed = await process(fixture, dependencies(fixture, {
    decrypt: async (args) => {
      observedPrivacyClass = args.aad.privacyClass;
      return admitted.plaintext;
    },
  }));
  assert.equal(committed.kind, "committed");
  assert.equal(observedPrivacyClass, "private");

  const unknownFieldBody = { ...payload(fixture, "provider-message-unknown"), providerRawPayload: "must-not-cross" };
  const plaintext = JSON.stringify(unknownFieldBody);
  const [event] = await fixture.db.insert(externalInboundEvents).values({
    ...fixture.authority,
    providerEventId: "event-unknown",
    normalizedPayloadDigest: digest(plaintext),
    encryptedPayload: plaintext,
    envelopeKeyId: "opaque-envelope-key-2",
    payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
    receivedAt: NOW,
    updatedAt: NOW,
  }).returning();
  const rejected = await process(fixture);
  assert.deepEqual(rejected, { kind: "blocked", eventId: event.id, reason: "payload_invalid" });
  const [quarantined] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, event.id));
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.encryptedPayload, null);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.content, unknownFieldBody.content))).length, 0);

  const nonCanonicalTimeBody = {
    ...payload(fixture, "provider-message-noncanonical-time"),
    createdAt: "2026-08-03T11:59:00Z",
  };
  const nonCanonicalPlaintext = JSON.stringify(nonCanonicalTimeBody);
  const [nonCanonicalEvent] = await fixture.db.insert(externalInboundEvents).values({
    ...fixture.authority,
    providerEventId: "event-noncanonical-time",
    normalizedPayloadDigest: digest(nonCanonicalPlaintext),
    encryptedPayload: nonCanonicalPlaintext,
    envelopeKeyId: "opaque-envelope-key-3",
    payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
    receivedAt: NOW,
    updatedAt: NOW,
  }).returning();
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: nonCanonicalEvent.id,
    reason: "payload_invalid",
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.content, nonCanonicalTimeBody.content))).length, 0);
});

test("inbound schema rejects impossible processing and false terminal evidence", async () => {
  const fixture = await seedFixture();
  const admitted = await enqueue(fixture, "event-shape", payload(fixture, "provider-shape"));
  const [existingMessage] = await fixture.db.insert(messages).values({
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    messageType: "chat",
    content: "existing canonical message",
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  await assert.rejects(
    fixture.db.update(externalInboundEvents).set({ status: "processing" })
      .where(eq(externalInboundEvents.id, admitted.event.id)),
  );
  await assert.rejects(
    fixture.db.update(externalInboundEvents).set({ provider: "p".repeat(81) })
      .where(eq(externalInboundEvents.id, admitted.event.id)),
  );
  await assert.rejects(
    fixture.db.update(externalInboundEvents).set({
      status: "committed",
      committedMessageId: existingMessage.id,
    }).where(eq(externalInboundEvents.id, admitted.event.id)),
  );
  await assert.rejects(fixture.db.execute(sql`
    UPDATE external_inbound_events
    SET status = 'future_state',
        encrypted_payload = NULL,
        envelope_key_id = NULL,
        payload_expires_at = NULL,
        payload_erased_at = ${NOW},
        payload_tombstone_digest = ${"a".repeat(64)}
    WHERE id = ${admitted.event.id}
  `));
  const [event] = await fixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "queued");
  assert.ok(event.encryptedPayload);
  assert.equal(event.committedMessageId, null);
});

test("provider message replay becomes a terminal duplicate with zero second canonical message", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-1", payload(fixture, "provider-message-1"));
  const first = await process(fixture);
  assert.equal(first.kind, "committed");
  await enqueue(fixture, "event-2", payload(fixture, "provider-message-1"));
  const replay = await process(fixture);
  assert.equal(replay.kind, "duplicate");
  assert.equal(replay.messageId, first.messageId);
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageAuthorFacts)).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
});

test("a committed provider message publishes realtime once while notification failure never replays persistence", async () => {
  const fixture = await seedFixture();
  const published: { eventId: string; messageId: string }[] = [];
  const errors: unknown[] = [];
  const deps = dependencies(fixture, {
    async onMessageCommitted(input) {
      published.push(input);
      if (published.length === 2) throw new Error("socket unavailable");
    },
    onMessageCommittedError(error) {
      errors.push(error);
    },
  });

  const firstAdmission = await enqueue(fixture, "event-realtime-1", payload(fixture, "provider-realtime-1"));
  const first = await process(fixture, deps);
  assert.equal(first.kind, "committed");
  assert.deepEqual(published, [{ eventId: firstAdmission.event.id, messageId: first.messageId }]);

  await enqueue(fixture, "event-realtime-duplicate", payload(fixture, "provider-realtime-1"));
  const duplicate = await process(fixture, deps);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(published.length, 1, "provider replay must not emit a duplicate realtime message");

  const secondAdmission = await enqueue(fixture, "event-realtime-2", payload(fixture, "provider-realtime-2"));
  const second = await process(fixture, deps);
  assert.equal(second.kind, "committed", "socket failure must not roll back the canonical commit");
  assert.deepEqual(published[1], { eventId: secondAdmission.event.id, messageId: second.messageId });
  assert.equal(errors.length, 1);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 2);
  const [secondEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, secondAdmission.event.id));
  assert.equal(secondEvent.status, "committed");
});

test("provider message identity with a different payload is quarantined instead of hidden as duplicate", async () => {
  const fixture = await seedFixture();
  const firstBody = payload(fixture, "provider-message-conflict");
  await enqueue(fixture, "event-conflict-1", firstBody);
  const first = await process(fixture);
  assert.equal(first.kind, "committed");

  const conflictingBody = {
    ...firstBody,
    content: "different content under the same provider message identity",
  };
  const admitted = await enqueue(fixture, "event-conflict-2", conflictingBody);
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: admitted.event.id,
    reason: "provider_message_payload_conflict",
  });

  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageAuthorFacts)).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
  assert.equal((await fixture.db.select().from(inboxNotificationFacts)).length, 3);
  const [event] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, admitted.event.id));
  assert.equal(event.status, "quarantined");
  assert.equal(event.outcomeReason, "provider_message_payload_conflict");
  assert.equal(event.committedMessageId, null);
  assert.equal(event.encryptedPayload, null);
  assert.ok(event.payloadErasedAt);
  assert.match(event.payloadTombstoneDigest ?? "", /^[0-9a-f]{64}$/);
});

test("accepted outbound provider identity is terminalized as an echo without a second canonical message", async () => {
  const fixture = await seedFixture();
  const [sourceMessage] = await fixture.db.insert(messages).values({
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    messageType: "chat",
    content: "source already dispatched outbound",
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  await fixture.db.insert(externalMessageLinks).values({
    provider: fixture.authority.provider,
    installId: fixture.authority.installId,
    providerAuthorityId: fixture.authority.providerAuthorityId,
    providerConversationId: fixture.authority.providerConversationId,
    providerMessageId: "provider-outbound-echo",
    providerThreadId: null,
    bindingId: fixture.authority.bindingId,
    bindingEpoch: fixture.authority.bindingEpoch,
    connectionEpoch: fixture.authority.connectionEpoch,
    raftMessageId: sourceMessage.id,
    raftCanonicalRootMessageId: null,
    firstDirection: "raft_outbound",
    payloadFingerprint: "b".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
    stateReason: "provider_accepted",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const admitted = await enqueue(
    fixture,
    "event-outbound-echo",
    payload(fixture, "provider-outbound-echo"),
  );

  assert.deepEqual(await process(fixture), {
    kind: "echo",
    eventId: admitted.event.id,
    messageId: sourceMessage.id,
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 0);
  const [event] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, admitted.event.id));
  assert.equal(event.status, "echo");
  assert.equal(event.encryptedPayload, null);
  assert.equal(event.committedMessageId, sourceMessage.id);
});

test("canonical commit failpoint rolls message, author, link, inbox, and terminal erase back together", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-1", payload(fixture, "provider-message-1"));
  let clock = NOW;
  const workerDependencies = dependencies(fixture, { now: () => clock });
  __setExternalInboundCanonicalCommitHookForTests(() => {
    throw new Error("after-inbox atomic failpoint");
  });
  assert.deepEqual(await process(fixture, workerDependencies), {
    kind: "blocked",
    eventId: (await fixture.db.select().from(externalInboundEvents))[0]?.id,
    reason: "canonical_commit_failed",
  });
  assert.deepEqual({
    projectedMessages: (await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length,
    authors: (await fixture.db.select().from(externalMessageAuthorFacts)).length,
    links: (await fixture.db.select().from(externalMessageLinks)).length,
    inbox: (await fixture.db.select().from(inboxNotificationFacts)).length,
  }, { projectedMessages: 0, authors: 0, links: 0, inbox: 0 });
  const [event] = await fixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "queued");
  assert.ok(event.encryptedPayload);
  assert.equal(event.leaseOwner, null);

  __setExternalInboundCanonicalCommitHookForTests(null);
  clock = new Date(NOW.getTime() + 30_000);
  assert.equal((await process(fixture, workerDependencies)).kind, "committed");
});

test("runtime mismatch and revoked actor each commit zero message/link/inbox residue", async () => {
  const mismatch = await seedFixture();
  await enqueue(mismatch, "event-runtime", payload(mismatch, "provider-message-runtime"));
  let clock = NOW;
  const mismatchResult = await process(mismatch, dependencies(mismatch, {
    now: () => clock,
    runtime: { ...mismatch.authority, runtimeRevision: "runtime-r2" },
  }));
  assert.equal(mismatchResult.kind, "blocked");
  assert.equal(mismatchResult.reason, "runtime_authority_inactive_or_mismatched");
  assert.equal((await mismatch.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await mismatch.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await mismatch.db.select().from(inboxNotificationFacts)).length, 0);
  assert.equal((await mismatch.db.select().from(externalInboundEvents))[0]?.status, "queued");

  await mismatch.db.update(externalActorProjections).set({ state: "tombstoned" })
    .where(eq(externalActorProjections.id, mismatch.actor.id));
  clock = new Date(NOW.getTime() + 30_000);
  const revokedResult = await process(mismatch, dependencies(mismatch, { now: () => clock }));
  assert.equal(revokedResult.kind, "blocked");
  assert.equal(revokedResult.reason, "external_actor_authority_revoked");
  const [revokedEvent] = await mismatch.db.select().from(externalInboundEvents);
  assert.equal(revokedEvent.status, "revoked");
  assert.equal(revokedEvent.encryptedPayload, null);
  assert.equal((await mismatch.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await mismatch.db.select().from(externalMessageAuthorFacts)).length, 0);
  assert.equal((await mismatch.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await mismatch.db.select().from(inboxNotificationFacts)).length, 0);
});

test("freshness-only audience refresh does not revoke an already-enqueued actor event", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-freshness-refresh", payload(fixture, "provider-message-freshness-refresh"));

  const projectionRevision = slackActorProjectionRevisionAfterRefresh(fixture.actor, {
    id: fixture.actor.externalActorId,
    displayName: fixture.actor.displayName,
    handle: "alice",
    actorKind: "human",
  });
  await fixture.db.update(externalActorProjections).set({
    projectionRevision,
    observedAt: new Date(NOW.getTime() + 1_000),
    updatedAt: new Date(NOW.getTime() + 1_000),
  }).where(eq(externalActorProjections.id, fixture.actor.id));

  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
  assert.equal((await fixture.db.select().from(externalInboundEvents))[0]?.status, "committed");
});

test("material audience actor refresh still revokes an event frozen at the previous revision", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-material-refresh", payload(fixture, "provider-message-material-refresh"));

  const projectionRevision = slackActorProjectionRevisionAfterRefresh(fixture.actor, {
    id: fixture.actor.externalActorId,
    displayName: "External Alice Renamed",
    handle: "alice",
    actorKind: "human",
  });
  await fixture.db.update(externalActorProjections).set({
    displayName: "External Alice Renamed",
    projectionRevision,
    observedAt: new Date(NOW.getTime() + 1_000),
    updatedAt: new Date(NOW.getTime() + 1_000),
  }).where(eq(externalActorProjections.id, fixture.actor.id));

  const result = await process(fixture);
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "external_actor_authority_revoked");
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await fixture.db.select().from(externalInboundEvents))[0]?.status, "revoked");
});

test("a blocked oldest event backs off so a newer eligible event commits, then remains retryable", async () => {
  const fixture = await seedFixture();
  const blocked = await enqueue(fixture, "event-blocked", payload(fixture, "provider-message-blocked"));
  let clock = NOW;
  let advanceFirstBlockedResolution = true;
  const workerDependencies: ExternalInboundWorkerDependencies = {
    now: () => clock,
    async decryptNormalizedPayload({ ciphertext }) {
      return ciphertext;
    },
    async resolveCurrentRuntime({ eventId }) {
      if (eventId !== blocked.event.id) return fixture.authority;
      if (advanceFirstBlockedResolution) {
        advanceFirstBlockedResolution = false;
        clock = new Date(clock.getTime() + 31_000);
      }
      return null;
    },
  };

  assert.deepEqual(await process(fixture, workerDependencies), {
    kind: "blocked",
    eventId: blocked.event.id,
    reason: "runtime_authority_inactive_or_mismatched",
  });

  clock = new Date(clock.getTime() + 1_000);
  const newer = await enqueue(
    fixture,
    "event-newer",
    payload(fixture, "provider-message-newer"),
    clock,
  );
  const committed = await process(fixture, workerDependencies);
  assert.equal(committed.kind, "committed");
  assert.equal(committed.eventId, newer.event.id);

  const [blockedDuringBackoff] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, blocked.event.id));
  assert.equal(blockedDuringBackoff.status, "queued");
  assert.equal(blockedDuringBackoff.leaseGeneration, 1);

  clock = new Date(NOW.getTime() + 61_000);
  assert.deepEqual(await process(fixture, workerDependencies), {
    kind: "blocked",
    eventId: blocked.event.id,
    reason: "runtime_authority_inactive_or_mismatched",
  });
  const [retried] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, blocked.event.id));
  assert.equal(retried.status, "queued");
  assert.equal(retried.leaseGeneration, 2);
});

test("thread reply resolves only an exact accepted root and atomically creates the canonical thread", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-root", payload(fixture, "provider-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");

  await enqueue(fixture, "event-reply", payload(fixture, "provider-reply", "provider-root"));
  const reply = await process(fixture);
  assert.equal(reply.kind, "committed");
  const [thread] = await fixture.db.select().from(channels).where(eq(channels.type, "thread"));
  assert.ok(thread);
  const [rootMessage] = await fixture.db.select().from(messages).where(eq(messages.id, root.messageId));
  const [replyMessage] = await fixture.db.select().from(messages).where(eq(messages.id, reply.messageId));
  assert.equal(rootMessage.threadId, thread.id);
  assert.equal(replyMessage.channelId, thread.id);
  const [replyLink] = await fixture.db.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.providerMessageId, "provider-reply"));
  assert.equal(replyLink.providerThreadId, "provider-root");
  assert.equal(replyLink.raftCanonicalRootMessageId, root.messageId);

  const before = (await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length;
  await enqueue(fixture, "event-wrong-root", payload(fixture, "provider-wrong-reply", "missing-root"));
  const blocked = await process(fixture);
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.reason, "commit_authority_lost_or_root_unavailable");
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, before);
});

test("Joint inbound reply atomically materializes every active local thread face and canonical facts", async () => {
  const fixture = await seedFixture("public");
  const jointFixture = await convertFixtureToJointWithParticipant(fixture);
  await enqueue(fixture, "event-joint-root", payload(fixture, "provider-joint-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");

  await enqueue(
    fixture,
    "event-joint-reply",
    payload(fixture, "provider-joint-reply", "provider-joint-root"),
  );
  const reply = await process(fixture);
  assert.equal(reply.kind, "committed");
  const [rootMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, root.messageId));
  assert.ok(rootMessage.threadId);
  const [canonicalThread] = await fixture.db.select().from(channels)
    .where(eq(channels.id, rootMessage.threadId));
  assert.equal(canonicalThread.type, "thread");
  assert.equal(canonicalThread.parentMessageId, root.messageId);
  assert.equal(canonicalThread.serverId, jointFixture.canonical.serverId);

  const [jointThread] = await fixture.db.select().from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, canonicalThread.id));
  assert.ok(jointThread);
  const threadProjections = await fixture.db.select({
    mapping: jointChannelServers,
    channel: channels,
  }).from(jointChannelServers)
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(eq(jointChannelServers.jointChannelId, jointThread.id));
  assert.equal(threadProjections.length, 2);
  assert.deepEqual(
    threadProjections.map(({ mapping, channel }) => ({
      serverId: mapping.serverId,
      role: mapping.role,
      type: channel.type,
      parentMessageId: channel.parentMessageId,
      deletedAt: channel.deletedAt,
    })).sort((left, right) => left.serverId.localeCompare(right.serverId)),
    [
      {
        serverId: fixture.server.id,
        role: "host",
        type: "thread",
        parentMessageId: null,
        deletedAt: null,
      },
      {
        serverId: jointFixture.participantServer.id,
        role: "participant",
        type: "thread",
        parentMessageId: null,
        deletedAt: null,
      },
    ].sort((left, right) => left.serverId.localeCompare(right.serverId)),
  );
  const [replyMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, reply.messageId));
  assert.equal(replyMessage.channelId, canonicalThread.id);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.channelId, threadProjections[0]!.channel.id))).length, 0);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.channelId, threadProjections[1]!.channel.id))).length, 0);
  const [replyLink] = await fixture.db.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.providerMessageId, "provider-joint-reply"));
  assert.equal(replyLink.raftCanonicalRootMessageId, root.messageId);
  assert.equal(replyLink.providerThreadId, "provider-joint-root");

  const facts = await fixture.db.select().from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, reply.messageId));
  assert.equal(facts.length, 0, "external authors do not mint Raft thread-follow authority");

  await enqueue(
    fixture,
    "event-joint-reply-duplicate",
    payload(fixture, "provider-joint-reply", "provider-joint-root"),
  );
  const duplicate = await process(fixture);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.messageId, reply.messageId);
  assert.equal((await fixture.db.select().from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, canonicalThread.id))).length, 1);
  assert.equal((await fixture.db.select().from(jointChannelServers)
    .where(eq(jointChannelServers.jointChannelId, jointThread.id))).length, 2);
});

test("Joint inbound reply fails closed when any active parent face is unavailable", async () => {
  const fixture = await seedFixture("public");
  const jointFixture = await convertFixtureToJointWithParticipant(fixture);
  await enqueue(fixture, "event-joint-block-root", payload(fixture, "provider-joint-block-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");
  await fixture.db.update(channels).set({ archivedAt: NOW })
    .where(eq(channels.id, jointFixture.participant.id));

  const admitted = await enqueue(
    fixture,
    "event-joint-block-reply",
    payload(fixture, "provider-joint-block-reply", "provider-joint-block-root"),
  );
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: admitted.event.id,
    reason: "commit_authority_lost_or_root_unavailable",
  });
  const [rootMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, root.messageId));
  assert.equal(rootMessage.threadId, null);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.content, "provider content provider-joint-block-reply"))).length, 0);
  assert.equal((await fixture.db.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.providerMessageId, "provider-joint-block-reply"))).length, 0);
  assert.equal((await fixture.db.select().from(channels)
    .where(eq(channels.type, "thread"))).length, 0);
});

test("lease expiry is sampled after the exact event row lock and stop abort leaves no lease residue", async () => {
  const expiryFixture = await seedFixture();
  await enqueue(expiryFixture, "event-expiry", payload(expiryFixture, "provider-expiry"));
  let clock = NOW;
  __setExternalInboundEventRowLockHookForTests(() => {
    clock = new Date(NOW.getTime() + 60_000);
  });
  const expired = await process(expiryFixture, dependencies(expiryFixture, { now: () => clock }));
  assert.equal(expired.kind, "blocked");
  assert.equal(expired.reason, "lease_expired_before_canonical_commit");
  assert.equal((await expiryFixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await expiryFixture.db.select().from(externalInboundEvents))[0]?.status, "queued");
  __setExternalInboundEventRowLockHookForTests(null);
  clock = new Date(NOW.getTime() + 90_000);

  let decryptStarted!: () => void;
  const started = new Promise<void>((resolve) => { decryptStarted = resolve; });
  const runtime = createExternalInboundWorkerRuntime({
    db: expiryFixture.db,
    leaseOwner: "runtime-worker",
    intervalMs: 60_000,
    dependencies: dependencies(expiryFixture, {
      now: () => clock,
      decrypt: ({ signal }) => new Promise<string>((_resolve, reject) => {
        decryptStarted();
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }),
  });
  runtime.start();
  await started;
  await runtime.stop();
  const [event] = await expiryFixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "queued");
  assert.equal(event.leaseOwner, null);
  assert.equal(event.leaseExpiresAt, null);
  assert.ok(event.encryptedPayload);
});
