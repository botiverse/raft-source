import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { test } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import {
  attachmentObjectArtifacts,
  attachmentObjectCharges,
  attachmentObjectGcJobs,
  attachmentObjects,
  attachmentStorageArtifacts,
  attachmentUploadReservations,
  attachments,
  channels,
  messages,
  servers,
  users,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";
import {
  expireAttachmentReservation,
  getAttachmentFoundationReadiness,
  runAttachmentLifecycleSweep,
} from "./attachmentLifecycleService.js";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService.js";
import { AttachmentLinkError, linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService.js";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const COMPLETED_AT = new Date("2026-08-12T00:00:00.000Z");
const EXPIRED_AT = new Date("2026-08-12T01:00:00.000Z");

class FakeStorage implements StorageBackend {
  readonly deletes: string[] = [];
  failDeletes = 0;

  async put(): Promise<void> {}
  async get(): Promise<Readable> { return Readable.from([]); }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("injected delete response loss");
    }
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({
    id: USER_ID,
    email: "attachment-lifecycle@slock.test",
    name: "attachment-lifecycle",
    passwordHash: "test",
  });
  await db.insert(servers).values({
    id: SERVER_ID,
    name: "Attachment lifecycle",
    slug: "attachment-lifecycle",
    ownerId: USER_ID,
  });
  await db.insert(channels).values({ id: CHANNEL_ID, serverId: SERVER_ID, name: "lifecycle" });
  await db.insert(messages).values({
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: USER_ID,
    content: "host",
  });
  return { client, db };
}

async function upload(db: Database, id: string, options: { mimeType?: string; thumbnailKey?: string } = {}) {
  const objectId = randomUUID();
  const transferIntentId = randomUUID();
  const mimeType = options.mimeType ?? "text/plain";
  const storageKey = `${SERVER_ID}/${id}`;
  await createAttachmentTransferIntent({
    id: transferIntentId,
    reservationId: id,
    objectId,
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user",
    filename: `${id}.svg`,
    mimeType,
    declaredSizeBytes: 42,
    expiresAt: new Date(COMPLETED_AT.getTime() + 15 * 60 * 1000),
    artifacts: buildAttachmentTransferArtifactPlan({ storageKey, thumbnailKey: options.thumbnailKey, mimeType }),
  }, db, COMPLETED_AT);
  return db.transaction((tx) => createPendingAttachmentProjectionWithExecutor(tx, {
    id,
    objectId,
    transferIntentId,
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user",
    filename: `${id}.svg`,
    mimeType,
    sizeBytes: 42,
    storageKey,
    thumbnailKey: options.thumbnailKey,
  }, COMPLETED_AT));
}

test("completion atomically records the 1h reservation and every planned artifact", async () => {
  const { client, db } = await fixture();
  try {
    const id = "55555555-5555-4555-8555-555555555555";
    const thumbnailKey = `thumbs/${SERVER_ID}/${id}.webp`;
    const projection = await upload(db, id, { mimeType: "image/svg+xml", thumbnailKey });
    const [reservation] = await db.select().from(attachmentUploadReservations)
      .where(eq(attachmentUploadReservations.id, id));
    const artifacts = await db.select({
      role: attachmentObjectArtifacts.role,
      backend: attachmentStorageArtifacts.backend,
      key: attachmentStorageArtifacts.storageKey,
      availability: attachmentStorageArtifacts.availabilityState,
    }).from(attachmentObjectArtifacts)
      .innerJoin(
        attachmentStorageArtifacts,
        eq(attachmentStorageArtifacts.id, attachmentObjectArtifacts.artifactId),
      )
      .where(eq(attachmentObjectArtifacts.objectId, projection.objectId!));

    assert.equal(reservation?.state, "pending");
    assert.equal(reservation?.expiresAt.toISOString(), EXPIRED_AT.toISOString());
    artifacts.sort((left, right) => left.role.localeCompare(right.role));
    assert.deepEqual(artifacts, [
      {
        role: "original",
        backend: "attachment",
        key: `${SERVER_ID}/${id}`,
        availability: "verified",
      },
      {
        role: "svg_raster_preview",
        backend: "cdn",
        key: `previews/${SERVER_ID}/${id}.webp`,
        availability: "verified",
      },
      { role: "thumbnail", backend: "cdn", key: thumbnailKey, availability: "verified" },
    ]);
    assert.deepEqual(await getAttachmentFoundationReadiness(db), {
      eligible: true,
      activeObjectsWithoutVerifiedOriginal: 0,
      activeDetachedObjects: 0,
      objectBackedPendingWithoutReservation: 0,
      legacyObjectlessPending: 0,
      gcDeadLetters: 0,
    });

    await db.update(attachmentStorageArtifacts).set({ availabilityState: "missing" })
      .where(eq(attachmentStorageArtifacts.storageKey, `${SERVER_ID}/${id}`));
    const missingReadiness = await getAttachmentFoundationReadiness(db);
    assert.equal(missingReadiness.eligible, false);
    assert.equal(missingReadiness.activeObjectsWithoutVerifiedOriginal, 1);
  } finally {
    await client.close();
  }
});

test("an active object with neither projection nor pending reservation blocks readiness", async () => {
  const { client, db } = await fixture();
  try {
    const id = "56565656-5656-4656-8656-565656565656";
    await upload(db, id);
    await db.delete(attachments).where(eq(attachments.id, id));
    await db.delete(attachmentUploadReservations).where(eq(attachmentUploadReservations.id, id));

    assert.deepEqual(await getAttachmentFoundationReadiness(db), {
      eligible: false,
      activeObjectsWithoutVerifiedOriginal: 0,
      activeDetachedObjects: 1,
      objectBackedPendingWithoutReservation: 0,
      legacyObjectlessPending: 0,
      gcDeadLetters: 0,
    });
  } finally {
    await client.close();
  }
});

test("send wins the terminal transition and later expiry cannot claim object or bytes", async () => {
  const { client, db } = await fixture();
  try {
    const id = "66666666-6666-4666-8666-666666666666";
    const projection = await upload(db, id);
    await db.transaction((tx) => linkAttachmentsToMessageWithExecutor(
      tx,
      [id],
      MESSAGE_ID,
      USER_ID,
      "new",
      new Date("2026-08-12T00:30:00.000Z"),
    ));
    const result = await expireAttachmentReservation(id, new Date("2026-08-12T02:00:00.000Z"), db);
    const [object] = await db.select().from(attachmentObjects)
      .where(eq(attachmentObjects.id, projection.objectId!));
    assert.equal(result?.state, "consumed");
    assert.equal(object?.lifecycleState, "active");
    assert.equal((await db.select().from(attachmentObjectGcJobs)).length, 0);
    assert.equal((await db.select().from(attachments)).length, 1);
  } finally {
    await client.close();
  }
});

test("expiry wins with a stable code, durable GC, tombstones, and immutable charge", async () => {
  const { client, db } = await fixture();
  try {
    const id = "77777777-7777-4777-8777-777777777777";
    const projection = await upload(db, id);
    const expired = await expireAttachmentReservation(id, EXPIRED_AT, db);
    assert.equal(expired?.state, "expired");
    await assert.rejects(
      db.transaction((tx) => linkAttachmentsToMessageWithExecutor(
        tx,
        [id],
        MESSAGE_ID,
        USER_ID,
        "new",
        new Date("2026-08-12T01:01:00.000Z"),
      )),
      (error: unknown) => error instanceof AttachmentLinkError && error.code === "attachment_expired",
    );

    const storage = new FakeStorage();
    const sweep = await runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:01:00.000Z"),
      storage,
      cdnStorage: null,
    });
    const [object] = await db.select().from(attachmentObjects)
      .where(eq(attachmentObjects.id, projection.objectId!));
    const [job] = await db.select().from(attachmentObjectGcJobs)
      .where(eq(attachmentObjectGcJobs.objectId, projection.objectId!));
    assert.deepEqual(sweep, {
      expired: 0,
      gcCompleted: 1,
      transferArtifactsDeleted: 0,
      transferArtifactFailures: 0,
    });
    assert.deepEqual(storage.deletes, [`${SERVER_ID}/${id}`]);
    assert.equal(object?.lifecycleState, "deleted");
    assert.equal(job?.state, "completed");
    assert.equal((await db.select().from(attachments)).length, 0);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 1);
  } finally {
    await client.close();
  }
});

test("GC emits a token-and-lease trace without storage keys or object identities", async () => {
  const { client, db } = await fixture();
  try {
    const id = "78787878-7878-4878-8878-787878787878";
    const projection = await upload(db, id);
    await expireAttachmentReservation(id, EXPIRED_AT, db);
    const storage = new FakeStorage();
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({ sink });
    const span = tracer.startSpan("attachment.lifecycle.sweep", {
      surface: "server",
      kind: "consumer",
    });

    await runWithTraceSpan(span, () => runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:01:00.000Z"),
      storage,
      cdnStorage: null,
      metrics: null,
    }), tracer);
    span.end();

    const [recorded] = sink.getAllSpans();
    assert.ok(recorded);
    assert.deepEqual(recorded.events.map((event) => event.name), [
      "attachment.gc.job.claimed",
      "attachment.gc.artifact.claimed",
      "attachment.gc.artifact.delete.finished",
      "attachment.gc.job.finished",
    ]);
    const values = JSON.stringify(recorded.events.map((event) => event.attrs));
    assert.equal(values.includes(`${SERVER_ID}/${id}`), false, "storage key stays out of tracing");
    assert.equal(values.includes(projection.objectId!), false, "object identity stays out of tracing");
    assert.match(values, /gc_token/);
    assert.match(values, /gc_lease_id/);
    assert.match(values, /artifact_delete_token/);
    assert.match(values, /artifact_delete_lease_id/);
  } finally {
    await client.close();
  }
});

test("GC publishes closed outcomes, per-state backlog, and oldest-pending age", async () => {
  const { client, db } = await fixture();
  try {
    const id = "69696969-6969-4969-8969-696969696969";
    await upload(db, id);
    await expireAttachmentReservation(id, EXPIRED_AT, db);
    const storage = new FakeStorage();
    storage.failDeletes = 1;
    const outcomes: string[] = [];
    const backlog = new Map<string, number>();
    const oldestPendingSeconds: number[] = [];

    await runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:01:00.000Z"),
      storage,
      cdnStorage: null,
      metrics: {
        onGcOutcome: (outcome) => outcomes.push(outcome),
        onGcBacklog: (state, count) => backlog.set(state, count),
        onGcOldestPendingSeconds: (seconds) => oldestPendingSeconds.push(seconds),
      },
    });

    assert.deepEqual(outcomes, ["retry"]);
    assert.deepEqual(Object.fromEntries(backlog), {
      ready: 0,
      leased: 0,
      retry: 1,
      blocked: 0,
      dead_letter: 0,
      completed: 0,
    });
    assert.deepEqual(oldestPendingSeconds, [60]);
  } finally {
    await client.close();
  }
});

test("a lost delete response is retried from the durable token without duplicate state", async () => {
  const { client, db } = await fixture();
  try {
    const id = "88888888-8888-4888-8888-888888888888";
    const projection = await upload(db, id);
    await expireAttachmentReservation(id, EXPIRED_AT, db);
    const storage = new FakeStorage();
    storage.failDeletes = 1;

    assert.deepEqual(await runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:01:00.000Z"),
      storage,
      cdnStorage: null,
    }), { expired: 0, gcCompleted: 0, transferArtifactsDeleted: 0, transferArtifactFailures: 0 });
    let [job] = await db.select().from(attachmentObjectGcJobs)
      .where(eq(attachmentObjectGcJobs.objectId, projection.objectId!));
    assert.equal(job?.state, "retry");

    assert.deepEqual(await runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:02:00.000Z"),
      storage,
      cdnStorage: null,
    }), { expired: 0, gcCompleted: 1, transferArtifactsDeleted: 0, transferArtifactFailures: 0 });
    [job] = await db.select().from(attachmentObjectGcJobs)
      .where(eq(attachmentObjectGcJobs.objectId, projection.objectId!));
    assert.equal(job?.state, "completed");
    assert.deepEqual(storage.deletes, [`${SERVER_ID}/${id}`, `${SERVER_ID}/${id}`]);
  } finally {
    await client.close();
  }
});

test("repeated physical-delete failures become a visible dead letter", async () => {
  const { client, db } = await fixture();
  try {
    const id = "79797979-7979-4979-8979-797979797979";
    const projection = await upload(db, id);
    await expireAttachmentReservation(id, EXPIRED_AT, db);
    const storage = new FakeStorage();
    storage.failDeletes = 20;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await runAttachmentLifecycleSweep({
        db,
        now: new Date(EXPIRED_AT.getTime() + 60_000 + attempt * 60_000),
        storage,
        cdnStorage: null,
      });
    }
    const [job] = await db.select().from(attachmentObjectGcJobs)
      .where(eq(attachmentObjectGcJobs.objectId, projection.objectId!));
    assert.equal(job?.attempts, 10);
    assert.equal(job?.state, "dead_letter");

    await runAttachmentLifecycleSweep({
      db,
      now: new Date(EXPIRED_AT.getTime() + 20 * 60_000),
      storage,
      cdnStorage: null,
    });
    assert.equal(storage.deletes.length, 10, "dead letters are not blindly retried");
  } finally {
    await client.close();
  }
});

test("an expired GC worker cannot finalize after another worker owns the durable lease", async () => {
  const { client, db } = await fixture();
  try {
    const id = "89898989-8989-4989-8989-898989898989";
    const projection = await upload(db, id);
    await expireAttachmentReservation(id, EXPIRED_AT, db);
    const storage = new FakeStorage();
    const firstLeased = deferred();
    const releaseFirst = deferred();
    const secondLeased = deferred();
    const releaseSecond = deferred();

    const firstSweep = runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:01:00.000Z"),
      storage,
      cdnStorage: null,
      hooks: {
        afterGcJobLease: async () => {
          firstLeased.resolve();
          await releaseFirst.promise;
        },
      },
    });
    await firstLeased.promise;

    const secondSweep = runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:03:00.000Z"),
      storage,
      cdnStorage: null,
      hooks: {
        afterGcJobLease: async () => {
          secondLeased.resolve();
          await releaseSecond.promise;
        },
      },
    });
    await secondLeased.promise;

    releaseFirst.resolve();
    assert.deepEqual(await firstSweep, {
      expired: 0,
      gcCompleted: 0,
      transferArtifactsDeleted: 0,
      transferArtifactFailures: 0,
    });
    let [object] = await db.select().from(attachmentObjects)
      .where(eq(attachmentObjects.id, projection.objectId!));
    let [job] = await db.select().from(attachmentObjectGcJobs)
      .where(eq(attachmentObjectGcJobs.objectId, projection.objectId!));
    assert.equal(object?.lifecycleState, "gc_pending");
    assert.equal(job?.state, "leased");

    releaseSecond.resolve();
    assert.deepEqual(await secondSweep, {
      expired: 0,
      gcCompleted: 1,
      transferArtifactsDeleted: 0,
      transferArtifactFailures: 0,
    });
    [object] = await db.select().from(attachmentObjects)
      .where(eq(attachmentObjects.id, projection.objectId!));
    [job] = await db.select().from(attachmentObjectGcJobs)
      .where(eq(attachmentObjectGcJobs.objectId, projection.objectId!));
    assert.equal(object?.lifecycleState, "deleted");
    assert.equal(job?.state, "completed");
    assert.deepEqual(storage.deletes, [`${SERVER_ID}/${id}`]);
  } finally {
    await client.close();
  }
});

test("historical shared artifacts remain blocked while any sibling object is active", async () => {
  const { client, db } = await fixture();
  try {
    const id = "99999999-9999-4999-8999-999999999999";
    const projection = await upload(db, id);
    const [artifact] = await db.select().from(attachmentStorageArtifacts);
    const siblingObjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await db.insert(attachmentObjects).values({
      id: siblingObjectId,
      originServerId: SERVER_ID,
      uploaderId: USER_ID,
      uploaderType: "user",
      storageKey: `${SERVER_ID}/${id}`,
      mimeType: "text/plain",
      sizeBytes: 42,
      createdAt: COMPLETED_AT,
    });
    await db.insert(attachmentObjectArtifacts).values({
      objectId: siblingObjectId,
      artifactId: artifact.id,
      role: "original",
      createdAt: COMPLETED_AT,
    });
    await db.insert(attachments).values({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      objectId: siblingObjectId,
      messageId: MESSAGE_ID,
      channelId: CHANNEL_ID,
      uploaderId: USER_ID,
      uploaderType: "user",
      filename: "sibling.txt",
      mimeType: "text/plain",
      sizeBytes: 42,
      storageKey: `${SERVER_ID}/${id}`,
      createdAt: COMPLETED_AT,
    });
    await expireAttachmentReservation(id, EXPIRED_AT, db);
    const storage = new FakeStorage();
    assert.deepEqual(await runAttachmentLifecycleSweep({
      db,
      now: new Date("2026-08-12T01:01:00.000Z"),
      storage,
      cdnStorage: null,
    }), { expired: 0, gcCompleted: 0, transferArtifactsDeleted: 0, transferArtifactFailures: 0 });
    const [job] = await db.select().from(attachmentObjectGcJobs)
      .where(eq(attachmentObjectGcJobs.objectId, projection.objectId!));
    assert.equal(job?.state, "blocked");
    assert.deepEqual(storage.deletes, []);
    assert.equal((await db.select().from(attachmentStorageArtifacts))[0]?.lifecycleState, "active");
  } finally {
    await client.close();
  }
});

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));

test.skipIf(inSourceSnapshot)("required typecheck CI pins the attachment lifecycle real-PostgreSQL lock contract", async () => {
  const workflow = await readFile(new URL("../../../../.github/workflows/test.yml", import.meta.url), "utf8");
  const typecheckJob = workflow.match(/\n  typecheck:\n(?<body>[\s\S]*?)(?=\n  [a-z][a-z0-9-]+:\n)/)?.groups?.body;
  assert.ok(typecheckJob, "typecheck job must remain present");
  assert.match(typecheckJob, /services:\s*\n\s+postgres:\s*\n\s+image: postgres:16-alpine/);
  assert.match(typecheckJob, /--health-cmd "pg_isready -U read_mutation_ci -d postgres"/);
  const focusedStep = typecheckJob.match(
    /- name: Attachment lifecycle real PostgreSQL object-first lock contract(?<body>[\s\S]*?)(?=\n\s+- name:)/,
  )?.groups?.body;
  assert.ok(focusedStep, "required typecheck job must execute the focused attachment lifecycle real-PG contract");
  assert.match(focusedStep, /working-directory: packages\/server/);
  assert.match(focusedStep, /timeout-minutes: 3/);
  assert.match(focusedStep, /ATTACHMENT_LIFECYCLE_REAL_PG_REQUIRED: "1"/);
  assert.match(
    focusedStep,
    /ATTACHMENT_LIFECYCLE_REAL_PG_URL: postgresql:\/\/read_mutation_ci:read_mutation_ci_password@127\.0\.0\.1:5432\/postgres/,
  );
  assert.match(
    focusedStep,
    /pnpm exec vitest run src\/services\/attachmentLifecycleService\.realPg\.test\.ts/,
  );
  assert.doesNotMatch(focusedStep, /continue-on-error/);
});
