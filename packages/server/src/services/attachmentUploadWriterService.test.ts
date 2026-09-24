import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import {
  attachmentTransferArtifacts,
  attachmentTransferIntents,
  attachments,
  users,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";
import { createChannel } from "./channelService.js";
import { createServer } from "./serverService.js";
import { uploadAttachmentBuffers } from "./attachmentUploadWriterService.js";


afterEach(async () => {
  await closeTestDatabase();
});

class InspectingStorage implements StorageBackend {
  readonly puts: string[] = [];

  async put(key: string): Promise<void> {
    this.puts.push(key);
    const intents = await getDb().select().from(attachmentTransferIntents);
    const artifacts = await getDb().select().from(attachmentTransferArtifacts);
    assert.equal(intents.length, 2, "every file intent must commit before the first external PUT");
    assert.equal(artifacts.length, 2, "every possible key must commit before the first external PUT");
    assert.equal(artifacts.every((artifact) => artifact.state === "planned"), true);
    assert.equal(artifacts.some((artifact) => artifact.storageKey === key), true);
  }

  async get(): Promise<Readable> { return Readable.from([]); }
  async delete(): Promise<void> {}
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function fixture() {
  await openTestDatabase("pglite://");
  const [owner] = await getDb().insert(users).values({
    email: `transfer-writer-${randomUUID()}@slock.test`,
    name: `transfer-writer-${randomUUID().slice(0, 8)}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Transfer writer", `transfer-writer-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `transfer-writer-${randomUUID()}`);
  return { owner, server, channel };
}

test("the common web and agent writer commits every transfer plan before its first PUT", async () => {
  const { owner, server, channel } = await fixture();
  const storage = new InspectingStorage();

  const rows = await uploadAttachmentBuffers({
    serverId: server.id,
    channelId: channel.id,
    uploaderId: owner.id,
    uploaderType: "user",
    files: [
      { buffer: Buffer.from("one"), filename: "one.txt", mimeType: "text/plain" },
      { buffer: Buffer.from("two"), filename: "two.txt", mimeType: "text/plain" },
    ],
    storage,
    cdnStorage: null,
    preview: {
      canGenerate: () => false,
      generateThumbnail: async () => Buffer.alloc(0),
      isSvg: () => false,
      generateSvgRasterPreview: async () => Buffer.alloc(0),
    },
    now: new Date("2026-08-12T00:00:00.000Z"),
  });

  assert.equal(rows.length, 2);
  assert.equal(storage.puts.length, 2);
  assert.equal((await getDb().select().from(attachments)).length, 2);
  assert.equal(
    (await getDb().select().from(attachmentTransferIntents)).every((intent) => intent.state === "completed"),
    true,
  );
  assert.equal(
    (await getDb().select().from(attachmentTransferArtifacts)).every((artifact) => artifact.state === "adopted"),
    true,
  );
});

test("one failed PUT waits for every concurrent write to settle before cleanup becomes eligible", async () => {
  const { owner, server, channel } = await fixture();
  const secondEntered = deferred();
  const releaseSecond = deferred();
  let calls = 0;
  const storage: StorageBackend = {
    put: async () => {
      calls += 1;
      if (calls === 1) throw new Error("injected first PUT failure");
      secondEntered.resolve();
      await releaseSecond.promise;
    },
    get: async () => Readable.from([]),
    delete: async () => undefined,
  };

  const outcome = uploadAttachmentBuffers({
    serverId: server.id,
    channelId: channel.id,
    uploaderId: owner.id,
    uploaderType: "user",
    files: [
      { buffer: Buffer.from("one"), filename: "one.txt", mimeType: "text/plain" },
      { buffer: Buffer.from("two"), filename: "two.txt", mimeType: "text/plain" },
    ],
    storage,
    cdnStorage: null,
    preview: {
      canGenerate: () => false,
      generateThumbnail: async () => Buffer.alloc(0),
      isSvg: () => false,
      generateSvgRasterPreview: async () => Buffer.alloc(0),
    },
    now: new Date("2026-08-12T00:00:00.000Z"),
  }).then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  await secondEntered.promise;
  const early = await Promise.race([
    outcome,
    new Promise<{ status: "pending" }>((resolve) => setTimeout(() => resolve({ status: "pending" }), 20)),
  ]);
  assert.equal(early.status, "pending");
  assert.equal(
    (await getDb().select().from(attachmentTransferIntents)).every((intent) => intent.state === "planned"),
    true,
  );

  releaseSecond.resolve();
  const completed = await outcome;
  assert.equal(completed.status, "rejected");
  if (completed.status === "rejected") assert.match(String(completed.error), /injected first PUT failure/);
  assert.equal(
    (await getDb().select().from(attachmentTransferIntents)).every((intent) => intent.state === "failed"),
    true,
  );
  assert.equal((await getDb().select().from(attachments)).length, 0);
});
