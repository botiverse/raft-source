import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import type { AttachmentUploadSessionContext } from "../routes/attachmentUploadSessions.js";
import { getDb } from "../db/index.js";
import {
  attachmentObjectCharges,
  attachmentTransferArtifacts,
  attachmentTransferIntents,
  attachmentUploadReservations,
  attachments,
  attachmentUploadSessions,
  messages,
  servers,
  users,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";
import {
  ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX,
  __setDirectUploadStorageForTests,
  __setStorageForTests,
  resetStorageForTests,
} from "./storageService.js";
import { createChannel } from "./channelService.js";
import { createServer } from "./serverService.js";
import { getFileUploadQuotaSummary } from "./fileUploadQuotaService.js";
import {
  type AttachmentUploadSessionServiceHooks,
  DurableAttachmentUploadSessionService,
  createDurableAttachmentUploadSessionService,
  isAttachmentDirectUploadEnabled,
} from "./attachmentUploadSessionService.js";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService.js";


afterEach(async () => {
  await closeTestDatabase();
  resetStorageForTests();
});

class FakeDirectStorage implements StorageBackend {
  readonly objects = new Map<string, { sizeBytes: number; contentType: string | null; etag: string | null }>();
  readonly presigns: Array<{ key: string; options: { expiresIn?: number; contentType?: string; ifNoneMatch?: "*" } }> = [];
  readonly deletes: string[] = [];
  readonly heads: string[] = [];

  async put(): Promise<void> {}
  async get(): Promise<Readable> { return Readable.from([]); }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }
  async head(key: string) {
    this.heads.push(key);
    return this.objects.get(key) ?? null;
  }
  async getPresignedPutUrl(
    key: string,
    options?: { expiresIn?: number; contentType?: string; ifNoneMatch?: "*" },
  ): Promise<string> {
    this.presigns.push({ key, options: options ?? {} });
    return `https://r2.example.test/${encodeURIComponent(key)}?signature=secret`;
  }
}

async function fixture() {
  await openTestDatabase("pglite://");
  const [owner] = await getDb().insert(users).values({
    email: `direct-${randomUUID()}@slock.test`,
    name: `direct-${randomUUID().slice(0, 8)}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Direct Upload", `direct-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `direct-${randomUUID()}`);
  return { owner, server, channel, context: { serverId: server.id as ServerId, userId: owner.id } };
}

function input(channelId: string, sizeBytes = 42) {
  return {
    channelId,
    filename: " demo.txt ",
    mimeType: "TEXT/PLAIN",
    sizeBytes,
    clientRequestId: randomUUID(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createEnabledService(
  storage: StorageBackend,
  now: () => Date,
  hooks: AttachmentUploadSessionServiceHooks = {},
) {
  return new DurableAttachmentUploadSessionService(storage, async () => true, now, hooks);
}

test("create reserves quota once and replays one write-once presigned session", async () => {
  const { server, channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  const service = createEnabledService(storage, () => new Date("2026-07-27T00:00:00Z"));
  const request = input(channel.id);

  const first = await service.create(context, request);
  assert.equal(first.status, 201);
  const created = first.body as {
    uploadId: string;
    attachmentId: string;
    upload: { headers: Record<string, string> };
  };
  assert.deepEqual(created.upload.headers, { "Content-Type": "text/plain", "If-None-Match": "*" });
  assert.equal(storage.presigns[0]?.options.ifNoneMatch, "*");
  assert.equal(storage.presigns[0]?.options.contentType, "text/plain");

  const replay = await service.create(context, request);
  assert.equal(replay.status, 201);
  assert.equal((replay.body as { uploadId: string }).uploadId, created.uploadId);
  assert.equal((replay.body as { attachmentId: string }).attachmentId, created.attachmentId);

  const [session] = await getDb().select().from(attachmentUploadSessions);
  assert.ok(session.storageKey.startsWith(ATTACHMENT_DIRECT_UPLOAD_STORAGE_KEY_PREFIX));
  assert.equal(session.filename, " demo.txt ", "direct uploads preserve the existing attachment filename contract");
  assert.equal(session.quotaState, "reserved");
  const [intent] = await getDb().select().from(attachmentTransferIntents)
    .where(eq(attachmentTransferIntents.id, session.transferIntentId!));
  const [artifact] = await getDb().select().from(attachmentTransferArtifacts)
    .where(eq(attachmentTransferArtifacts.intentId, session.transferIntentId!));
  assert.equal(session.objectId, intent?.objectId);
  assert.equal(intent?.state, "planned");
  assert.equal(artifact?.state, "planned");
  assert.equal(artifact?.storageKey, session.storageKey);
  const quota = await getFileUploadQuotaSummary(server.id, new Date("2026-07-27T00:00:00Z"));
  assert.equal(quota.reservedBytes, request.sizeBytes);
  assert.equal(quota.usedBytes, 0);
});

test("complete HEAD-verifies, creates one attachment, and finalizes quota exactly once", async () => {
  const { server, channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  let now = new Date("2026-07-31T23:59:30Z");
  const service = createEnabledService(storage, () => now);
  const request = input(channel.id, 64);
  const create = await service.create(context, request);
  const { uploadId } = create.body as { uploadId: string };
  const [session] = await getDb().select().from(attachmentUploadSessions).where(eq(attachmentUploadSessions.id, uploadId));
  assert.equal(session.quotaMonth, "2026-07");
  now = new Date("2026-08-01T00:00:30Z");

  const missing = await service.complete(context, uploadId);
  assert.equal(missing.status, 404);
  const [afterMissing] = await getDb().select().from(attachmentUploadSessions).where(eq(attachmentUploadSessions.id, uploadId));
  assert.equal(afterMissing.state, "pending");
  assert.equal(afterMissing.quotaState, "reserved");

  storage.objects.set(session.storageKey, { sizeBytes: 64, contentType: "text/plain", etag: "etag-v1" });
  const completed = await service.complete(context, uploadId);
  assert.equal(completed.status, 200);
  const attachmentId = (completed.body as { attachment: { id: string } }).attachment.id;
  const replay = await service.complete(context, uploadId);
  assert.equal(replay.status, 200);
  assert.equal((replay.body as { attachment: { id: string } }).attachment.id, attachmentId);

  const rows = await getDb().select().from(attachments).where(eq(attachments.id, attachmentId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.contentHash, null);
  assert.equal(rows[0]?.thumbnailKey, null);
  const [intent] = await getDb().select().from(attachmentTransferIntents)
    .where(eq(attachmentTransferIntents.id, session.transferIntentId!));
  const [artifact] = await getDb().select().from(attachmentTransferArtifacts)
    .where(eq(attachmentTransferArtifacts.intentId, session.transferIntentId!));
  assert.equal(intent?.state, "completed");
  assert.equal(artifact?.state, "adopted");
  const [charge] = await getDb().select().from(attachmentObjectCharges)
    .where(eq(attachmentObjectCharges.objectId, rows[0]!.objectId!));
  assert.equal(charge.chargeMonth, "2026-07-01");
  const quota = await getFileUploadQuotaSummary(server.id, new Date("2026-07-31T23:59:30Z"));
  assert.equal(quota.reservedBytes, 0);
  assert.equal(quota.usedBytes, 64);
});

test("canceling a completed upload terminates its reservation instead of returning a no-op", async () => {
  const { server, channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  const now = new Date("2026-08-12T00:00:00Z");
  const service = createEnabledService(storage, () => now);
  const create = await service.create(context, input(channel.id, 32));
  const { uploadId } = create.body as { uploadId: string };
  const [session] = await getDb().select().from(attachmentUploadSessions)
    .where(eq(attachmentUploadSessions.id, uploadId));
  storage.objects.set(session.storageKey, { sizeBytes: 32, contentType: "text/plain", etag: "etag-cancel" });
  assert.equal((await service.complete(context, uploadId)).status, 200);

  const canceled = await service.cancel(context, uploadId);
  assert.equal(canceled.status, 200);
  assert.equal((canceled.body as { reservationState: string }).reservationState, "canceled");
  assert.equal((canceled.body as { attachment: unknown }).attachment, null);
  const [reservation] = await getDb().select().from(attachmentUploadReservations)
    .where(eq(attachmentUploadReservations.id, session.attachmentId));
  assert.equal(reservation?.state, "canceled");
  assert.equal((await getDb().select().from(attachments)).length, 0);
  const quota = await getFileUploadQuotaSummary(server.id, now);
  assert.equal(quota.usedBytes, 32, "successful-upload charge is immutable after reservation cancel");
  assert.equal((await service.cancel(context, uploadId)).status, 200);
});

test("canceling a consumed completed upload returns stable already-consumed", async () => {
  const { channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  const now = new Date();
  const service = createEnabledService(storage, () => now);
  const create = await service.create(context, input(channel.id, 24));
  const { uploadId } = create.body as { uploadId: string };
  const [session] = await getDb().select().from(attachmentUploadSessions)
    .where(eq(attachmentUploadSessions.id, uploadId));
  storage.objects.set(session.storageKey, { sizeBytes: 24, contentType: "text/plain", etag: "etag-consumed" });
  await service.complete(context, uploadId);
  const [message] = await getDb().insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: context.userId,
    content: "host",
  }).returning();
  await getDb().transaction((tx) => linkAttachmentsToMessageWithExecutor(
    tx,
    [session.attachmentId],
    message.id,
    context.userId,
    "new",
    new Date(now.getTime() + 30 * 60 * 1000),
  ));

  const canceled = await service.cancel(context, uploadId);
  assert.equal(canceled.status, 409);
  assert.equal((canceled.body as { code: string }).code, "ATTACHMENT_ALREADY_CONSUMED");
  assert.equal((await getDb().select().from(attachments)).length, 1);
});

test("a stale cancel cannot delete an object after complete wins the terminal lock", async () => {
  const { server, channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  const cancelEntered = deferred();
  const releaseCancel = deferred();
  const service = createEnabledService(
    storage,
    () => new Date("2026-07-27T00:00:00Z"),
    {
      beforeTerminalTransition: async (_uploadId, state) => {
        if (state !== "canceled") return;
        cancelEntered.resolve();
        await releaseCancel.promise;
      },
    },
  );
  const create = await service.create(context, input(channel.id, 64));
  const { uploadId } = create.body as { uploadId: string };
  const [session] = await getDb().select().from(attachmentUploadSessions)
    .where(eq(attachmentUploadSessions.id, uploadId));
  storage.objects.set(session.storageKey, { sizeBytes: 64, contentType: "text/plain", etag: "etag-race" });

  const cancel = service.cancel(context, uploadId);
  await cancelEntered.promise;
  const completed = await service.complete(context, uploadId);
  assert.equal(completed.status, 200);
  releaseCancel.resolve();
  const cancelResult = await cancel;

  assert.equal(cancelResult.status, 200);
  assert.equal((cancelResult.body as { state: string }).state, "completed");
  assert.deepEqual(storage.deletes, []);
  assert.equal(storage.objects.has(session.storageKey), true);
  assert.equal((await getDb().select().from(attachments)).length, 1);
  const quota = await getFileUploadQuotaSummary(server.id, new Date("2026-07-27T00:00:00Z"));
  assert.equal(quota.reservedBytes, 0);
  assert.equal(quota.usedBytes, 64);
});

test("a stale expiry sweep cannot delete an object after complete wins the terminal lock", async () => {
  const { server, channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  let now = new Date("2026-07-27T00:00:00Z");
  const sweepEntered = deferred();
  const releaseSweep = deferred();
  const service = createEnabledService(
    storage,
    () => now,
    {
      beforeTerminalTransition: async (_uploadId, state) => {
        if (state !== "expired") return;
        sweepEntered.resolve();
        await releaseSweep.promise;
      },
    },
  );
  const create = await service.create(context, input(channel.id, 80));
  const { uploadId } = create.body as { uploadId: string };
  const [session] = await getDb().select().from(attachmentUploadSessions)
    .where(eq(attachmentUploadSessions.id, uploadId));
  storage.objects.set(session.storageKey, { sizeBytes: 80, contentType: "text/plain", etag: "etag-sweep-race" });

  now = new Date("2026-07-27T00:16:00Z");
  const sweep = service.cleanupExpiredSessions();
  await sweepEntered.promise;
  now = new Date("2026-07-27T00:14:00Z");
  const completed = await service.complete(context, uploadId);
  assert.equal(completed.status, 200);
  releaseSweep.resolve();
  assert.equal(await sweep, 0);

  assert.deepEqual(storage.deletes, []);
  assert.equal(storage.objects.has(session.storageKey), true);
  assert.equal((await getDb().select().from(attachments)).length, 1);
  const quota = await getFileUploadQuotaSummary(server.id, now);
  assert.equal(quota.reservedBytes, 0);
  assert.equal(quota.usedBytes, 80);
});

test("metadata mismatch and cancel release reservations without creating attachments", async () => {
  const { server, channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  const service = createEnabledService(storage, () => new Date("2026-07-27T00:00:00Z"));

  const mismatchedCreate = await service.create(context, input(channel.id, 100));
  const mismatchId = (mismatchedCreate.body as { uploadId: string }).uploadId;
  const [mismatchSession] = await getDb().select().from(attachmentUploadSessions)
    .where(eq(attachmentUploadSessions.id, mismatchId));
  storage.objects.set(mismatchSession.storageKey, { sizeBytes: 99, contentType: "text/plain", etag: null });
  const mismatch = await service.complete(context, mismatchId);
  assert.equal(mismatch.status, 422);

  const cancelCreate = await service.create(context, input(channel.id, 200));
  const cancelId = (cancelCreate.body as { uploadId: string }).uploadId;
  const canceled = await service.cancel(context, cancelId);
  assert.equal(canceled.status, 200);
  assert.equal((canceled.body as { state: string }).state, "canceled");
  const cancelReplay = await service.cancel(context, cancelId);
  assert.equal(cancelReplay.status, 200);

  const quota = await getFileUploadQuotaSummary(server.id, new Date("2026-07-27T00:00:00Z"));
  assert.equal(quota.reservedBytes, 0);
  assert.equal(quota.usedBytes, 0);
  assert.equal((await getDb().select().from(attachments)).length, 0);
  assert.deepEqual(new Set(storage.deletes), new Set([mismatchSession.storageKey, storage.presigns[1]!.key]));
});

test("enabled direct-upload capability projects the threshold without lowering the plan limit", async () => {
  const previous = process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
  process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = String(10 * 1024 * 1024);
  try {
    const { server, context } = await fixture();
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
    const storage = new FakeDirectStorage();
    const service = createEnabledService(storage, () => new Date("2026-07-27T00:00:00Z"));
    const capability = await service.capabilities(context);
    assert.equal(capability.status, 200);
    assert.deepEqual(capability.body, {
      directUploadEnabled: true,
      directUploadThresholdBytes: 10 * 1024 * 1024,
      maxBytes: 200 * 1024 * 1024,
      sessionExpiresInSeconds: 900,
    });
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = previous;
  }
});

test("enabled direct-upload capability leaves no gap above the legacy transport ceiling", async () => {
  const previous = process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
  process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = String(200 * 1024 * 1024);
  try {
    const { server, context } = await fixture();
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
    const storage = new FakeDirectStorage();
    const service = createEnabledService(storage, () => new Date("2026-07-27T00:00:00Z"));
    const capability = await service.capabilities(context);
    assert.equal(capability.status, 200);
    assert.deepEqual(capability.body, {
      directUploadEnabled: true,
      directUploadThresholdBytes: 90 * 1024 * 1024,
      maxBytes: 200 * 1024 * 1024,
      sessionExpiresInSeconds: 900,
    });
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES = previous;
  }
});

test("server feature flag fails closed across capability and every direct-session operation", async () => {
  const { channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  const evaluated: AttachmentUploadSessionContext[] = [];
  const service = new DurableAttachmentUploadSessionService(
    storage,
    async (candidate) => {
      evaluated.push(candidate);
      return false;
    },
    () => new Date("2026-07-27T00:00:00Z"),
    {},
  );

  assert.deepEqual((await service.capabilities(context)).body, {
    directUploadEnabled: false,
    directUploadThresholdBytes: null,
    maxBytes: 50 * 1024 * 1024,
    sessionExpiresInSeconds: null,
  });
  const request = input(channel.id);
  const uploadId = randomUUID();
  for (const result of [
    await service.create(context, request),
    await service.complete(context, uploadId),
    await service.cancel(context, uploadId),
    await service.status(context, uploadId),
  ]) {
    assert.equal(result.status, 403);
    assert.equal((result.body as { code: string }).code, "UPLOAD_FORBIDDEN");
  }
  assert.equal(evaluated.length, 5);
  assert.ok(evaluated.every((candidate) => candidate === context));
  assert.deepEqual(storage.presigns, []);
  assert.equal((await getDb().select().from(attachmentUploadSessions)).length, 0);
});

test("a different server cannot inspect, complete, or cancel a direct-upload session", async () => {
  const { channel, context } = await fixture();
  const storage = new FakeDirectStorage();
  const service = createEnabledService(storage, () => new Date("2026-07-27T00:00:00Z"));
  const created = await service.create(context, input(channel.id, 64));
  assert.equal(created.status, 201);
  const uploadId = (created.body as { uploadId: string }).uploadId;
  const [session] = await getDb().select().from(attachmentUploadSessions)
    .where(eq(attachmentUploadSessions.id, uploadId));
  storage.objects.set(session.storageKey, { sizeBytes: 64, contentType: "text/plain", etag: "etag-cross-server" });

  const outsider = await getDb().insert(users).values({
    email: `direct-outsider-${randomUUID()}@slock.test`,
    name: `direct-outsider-${randomUUID().slice(0, 8)}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const outsiderServer = await createServer("Direct Upload Outsider", `direct-outsider-${randomUUID()}`, outsider[0]!.id);
  const outsiderContext = { serverId: outsiderServer.id as ServerId, userId: outsider[0]!.id };

  const outsiderStatus = await service.status(outsiderContext, uploadId);
  assert.equal(outsiderStatus.status, 404);
  assert.equal((outsiderStatus.body as { code: string }).code, "UPLOAD_SESSION_NOT_FOUND");
  const outsiderComplete = await service.complete(outsiderContext, uploadId);
  assert.equal(outsiderComplete.status, 403);
  assert.equal((outsiderComplete.body as { code: string }).code, "UPLOAD_FORBIDDEN");
  const outsiderCancel = await service.cancel(outsiderContext, uploadId);
  assert.equal(outsiderCancel.status, 404);
  assert.equal((outsiderCancel.body as { code: string }).code, "UPLOAD_SESSION_NOT_FOUND");
  assert.deepEqual(storage.heads, [], "cross-server completion must not probe the physical object");
  assert.deepEqual(storage.deletes, [], "cross-server cancellation must not delete the physical object");
  const [unchanged] = await getDb().select().from(attachmentUploadSessions)
    .where(eq(attachmentUploadSessions.id, uploadId));
  assert.equal(unchanged.state, "pending");
});

test("agent sessions are actor-type scoped and complete as agent-owned attachments", async () => {
  const { server, channel } = await fixture();
  const agentId = randomUUID();
  const agentContext = { serverId: server.id as ServerId, agentId };
  const storage = new FakeDirectStorage();
  const service = createEnabledService(storage, () => new Date("2026-07-27T00:00:00Z"));
  const created = await service.create(agentContext, input(channel.id, 64));
  assert.equal(created.status, 201);
  const uploadId = (created.body as { uploadId: string }).uploadId;
  const [session] = await getDb().select().from(attachmentUploadSessions).where(eq(attachmentUploadSessions.id, uploadId));
  assert.equal(session.uploaderId, agentId);
  assert.equal(session.uploaderType, "agent");

  const wrongActorType = await service.status({ serverId: server.id as ServerId, userId: agentId }, uploadId);
  assert.equal(wrongActorType.status, 404);

  storage.objects.set(session.storageKey, { sizeBytes: 64, contentType: "text/plain", etag: "etag-agent" });
  const completed = await service.complete(agentContext, uploadId);
  assert.equal(completed.status, 200);
  const attachmentId = (completed.body as { attachment: { id: string } }).attachment.id;
  const [attachment] = await getDb().select().from(attachments).where(eq(attachments.id, attachmentId));
  assert.equal(attachment.uploaderId, agentId);
  assert.equal(attachment.uploaderType, "agent");
});

test("direct upload rollout is exact-true and default-off", () => {
  const previous = process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED;
  try {
    delete process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED;
    assert.equal(isAttachmentDirectUploadEnabled(), false);
    process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED = "false";
    assert.equal(isAttachmentDirectUploadEnabled(), false);
    process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED = " true ";
    assert.equal(isAttachmentDirectUploadEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED = previous;
  }
});

test("durable direct-upload service fails closed without an isolated storage backend", () => {
  const previous = process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED;
  try {
    process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED = "true";
    __setStorageForTests(new FakeDirectStorage());
    __setDirectUploadStorageForTests(null);
    assert.equal(createDurableAttachmentUploadSessionService(), null);

    __setDirectUploadStorageForTests(new FakeDirectStorage());
    assert.ok(createDurableAttachmentUploadSessionService());
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED;
    else process.env.ATTACHMENT_DIRECT_UPLOAD_ENABLED = previous;
  }
});
