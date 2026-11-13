import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  attachmentTransferArtifacts,
  attachmentTransferIntents,
  attachments,
  featureFlags,
  users,
} from "../db/schema";
import type { StorageBackend } from "./storageService";
import { createChannel } from "./channelService";
import { createServer } from "./serverService";
import { uploadAttachmentBuffers } from "./attachmentUploadWriterService";
import {
  ATTACHMENT_STORAGE_KEY_PREFIX,
  PUBLIC_CONTENT_V2_KEY_PREFIX,
  __setPublicContentStorageForTests,
  __setStorageForTests,
  resetStorageForTests,
} from "./storageService";


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
  assert.equal(
    storage.puts.every((key) => key.startsWith(`${ATTACHMENT_STORAGE_KEY_PREFIX}${server.id}/server/`)),
    true,
  );
  assert.deepEqual(rows.map((row) => row.storageKey).sort(), storage.puts.slice().sort());
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

function recordingPreviewStorage(): StorageBackend & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    put: async (key: string) => { puts.push(key); },
    get: async () => Readable.from([]),
    delete: async () => undefined,
  };
}

const svgPreviewWriter = {
  canGenerate: () => true,
  generateThumbnail: async () => Buffer.from("thumbnail"),
  isSvg: (mimeType: string) => mimeType === "image/svg+xml",
  generateSvgRasterPreview: async () => Buffer.from("raster"),
};

async function uploadSvg(
  input: Awaited<ReturnType<typeof fixture>>,
  cdnStorage: StorageBackend,
) {
  const [row] = await uploadAttachmentBuffers({
    serverId: input.server.id,
    channelId: input.channel.id,
    uploaderId: input.owner.id,
    uploaderType: "user",
    files: [{ buffer: Buffer.from("<svg/>"), filename: "logo.svg", mimeType: "image/svg+xml" }],
    storage: recordingPreviewStorage(),
    cdnStorage,
    preview: svgPreviewWriter,
    now: new Date("2026-08-12T00:00:00.000Z"),
  });
  return row;
}

test("fresh SVG thumbnails and raster previews use content/v2 keys when public-content storage is configured", async () => {
  const input = await fixture();
  const previousBase = process.env.CDN_BASE_URL;
  try {
    process.env.CDN_BASE_URL = "https://cdn.example.test";
    __setPublicContentStorageForTests(recordingPreviewStorage());
    const cdnStorage = recordingPreviewStorage();

    const row = await uploadSvg(input, cdnStorage);

    const thumbnailKey = `${PUBLIC_CONTENT_V2_KEY_PREFIX}thumbs/${input.server.id}/${row.id}.webp`;
    assert.equal(row.thumbnailKey, thumbnailKey);
    assert.deepEqual(cdnStorage.puts, [
      `${PUBLIC_CONTENT_V2_KEY_PREFIX}previews/${input.server.id}/${row.id}.webp`,
      thumbnailKey,
    ]);
  } finally {
    resetStorageForTests();
    if (previousBase === undefined) delete process.env.CDN_BASE_URL;
    else process.env.CDN_BASE_URL = previousBase;
  }
});

test("fresh thumbnails stay on legacy keys when the public-content domain is missing", async () => {
  const input = await fixture();
  const previousCdnBase = process.env.CDN_BASE_URL;
  const previousBase = process.env.PUBLIC_CONTENT_BASE_URL;
  try {
    __setPublicContentStorageForTests(recordingPreviewStorage());
    delete process.env.CDN_BASE_URL;
    delete process.env.PUBLIC_CONTENT_BASE_URL;
    const missingDomainStorage = recordingPreviewStorage();
    const missingDomain = await uploadSvg(input, missingDomainStorage);
    assert.equal(
      missingDomain.thumbnailKey,
      `thumbs/${input.server.id}/${missingDomain.id}.webp`,
      "no content/v2 key may be persisted without a public domain to serve it",
    );
    assert.deepEqual(missingDomainStorage.puts, [
      `previews/${input.server.id}/${missingDomain.id}.webp`,
      `thumbs/${input.server.id}/${missingDomain.id}.webp`,
    ]);
  } finally {
    resetStorageForTests();
    if (previousCdnBase === undefined) delete process.env.CDN_BASE_URL;
    else process.env.CDN_BASE_URL = previousCdnBase;
    if (previousBase === undefined) delete process.env.PUBLIC_CONTENT_BASE_URL;
    else process.env.PUBLIC_CONTENT_BASE_URL = previousBase;
  }
});

test("without the dedicated attachment bucket the writer keeps legacy keys instead of failing", async () => {
  const { owner, server, channel } = await fixture();
  const storage = new InspectingStorage();
  __setStorageForTests(storage, { dedicatedAttachmentKeys: false });
  try {
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
    assert.equal(storage.puts.length, 2);
    assert.deepEqual(
      storage.puts.slice().sort(),
      rows.map((row) => `${server.id}/${row.id}.txt`).sort(),
    );
  } finally {
    resetStorageForTests();
  }
});
