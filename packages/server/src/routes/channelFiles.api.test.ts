import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { attachmentObjects, attachments, channels, messages, serverMembers, servers, users } from "../db/schema";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { getThumbnailUrl } from "./attachments";
import { createChannel, getOrCreateThread, addHuman, listChannelFiles } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function headers(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

test("GET /api/channels/:id/files lists direct and thread message attachments with source jump metadata", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("files-owner@slock.test", "files-owner");
  const server = await createServer("Files Test", "files-test", owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "files-room");
  await addHuman(channel.id, owner.id);

  const directMessage = await createMessage(channel.id, "user", owner.id, "direct attachment");
  const parentMessage = await createMessage(channel.id, "user", owner.id, "thread parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  const threadMessage = await createMessage(thread.id, "user", owner.id, "thread attachment");

  const older = new Date("2026-05-10T10:00:00Z");
  const newer = new Date("2026-05-10T11:00:00Z");
  await db.update(messages).set({ createdAt: older }).where(eq(messages.id, directMessage.id));
  await db.update(messages).set({ createdAt: newer }).where(eq(messages.id, threadMessage.id));
  await insertAttachmentsWithObjects(db, [
    {
      id: "00000000-0000-4000-8000-000000000101",
      messageId: directMessage.id,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "direct.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      storageKey: "attachments/direct.pdf",
      createdAt: older,
    },
    {
      id: "00000000-0000-4000-8000-000000000102",
      messageId: threadMessage.id,
      channelId: thread.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "thread.png",
      mimeType: "image/png",
      sizeBytes: 5678,
      storageKey: "attachments/thread.png",
      thumbnailKey: "thumbs/thread.webp",
      createdAt: newer,
    },
  ]);

  const token = await tokenForHuman("files-owner@slock.test");
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/files`, {
    headers: headers(token, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { files: any[]; nextCursor: string | null };
  assert.equal(body.files.length, 2);
  assert.deepEqual(body.files.map((file) => file.filename), ["thread.png", "direct.pdf"]);
  assert.equal(body.nextCursor, null);

  const threadFile = body.files[0];
  assert.equal(threadFile.messageId, threadMessage.id);
  assert.equal(threadFile.source.type, "thread");
  assert.equal(threadFile.source.channelId, thread.id);
  assert.equal(threadFile.source.parentMessageId, parentMessage.id);
  assert.equal(threadFile.source.parentMessageShortId, parentMessage.id.slice(0, 8));
  assert.equal(threadFile.uploader.name, "files-owner");

  const directFile = body.files[1];
  assert.equal(directFile.messageId, directMessage.id);
  assert.equal(directFile.source.type, "channel");
  assert.equal(directFile.source.channelId, channel.id);
  assert.equal(directFile.source.parentMessageId, null);

  const cutoffFiles = await listChannelFiles(channel.id, { historyCutoff: new Date("2026-05-10T10:30:00Z") });
  assert.deepEqual(cutoffFiles.map((file) => file.filename), ["thread.png"]);

  const firstPage = await fetch(`${app.baseUrl}/api/channels/${channel.id}/files?limit=1`, {
    headers: headers(token, server.id),
  });
  assert.equal(firstPage.status, 200);
  const firstPageBody = await firstPage.json() as { files: any[]; nextCursor: string | null };
  assert.deepEqual(firstPageBody.files.map((file) => file.filename), ["thread.png"]);
  assert.equal(typeof firstPageBody.nextCursor, "string");

  const secondPage = await fetch(`${app.baseUrl}/api/channels/${channel.id}/files?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor!)}`, {
    headers: headers(token, server.id),
  });
  assert.equal(secondPage.status, 200);
  const secondPageBody = await secondPage.json() as { files: any[]; nextCursor: string | null };
  assert.deepEqual(secondPageBody.files.map((file) => file.filename), ["direct.pdf"]);
  assert.equal(secondPageBody.nextCursor, null);
});

test("GET /api/channels/:id/files rejects private channel non-members", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("files-private-owner@slock.test", "files-private-owner");
  const outsider = await seedUser("files-private-outsider@slock.test", "files-private-outsider");
  const server = await createServer("Private Files Test", "private-files-test", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
  const channel = await createChannel(server.id, "secret-files", undefined, "private");
  await addHuman(channel.id, owner.id);
  const message = await createMessage(channel.id, "user", owner.id, "private attachment");
  await insertAttachmentsWithObjects(db, {
    messageId: message.id,
    channelId: channel.id,
    uploaderId: owner.id,
    uploaderType: "user",
    filename: "secret.txt",
    mimeType: "text/plain",
    sizeBytes: 10,
    storageKey: "attachments/secret.txt",
  });

  const token = await tokenForHuman("files-private-outsider@slock.test");
  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/files`, {
    headers: headers(token, server.id),
  });
  // task #48: JUDGED individually, not flipped to match the code. This caller
  // is "files-private-outsider" -- never a member, no read cursor, no inbox
  // state, no suppression row, no thread follow. The server holds no record
  // that they ever had a relationship with this channel, so they are a
  // stranger by the ruling's definition and must not learn it exists.
  // Denial itself is unchanged; only the disclosure is.
  assert.equal(res.status, 404);
});

test("listChannelFiles resolves user and agent uploaders by id and tolerates non-uuid uploader ids", async ({ app }) => {
  void app; // initializes the database
  const db = getDb();
  const owner = await seedUser("files-uploaders-owner@slock.test", "files-uploaders-owner");
  const server = await createServer("Files Uploaders", "files-uploaders", owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "files-uploaders-room");
  const agent = await createAgent(server.id, "files-uploaders-agent", { runtime: "codex" });
  const message = await createMessage(channel.id, "user", owner.id, "three uploads");
  const at = (minute: number) => new Date(`2026-05-10T10:0${minute}:00Z`);
  await insertAttachmentsWithObjects(db, [
    { messageId: message.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "by-user.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "attachments/by-user.pdf", createdAt: at(1) },
    { messageId: message.id, channelId: channel.id, uploaderId: agent.id, uploaderType: "agent", filename: "by-agent.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "attachments/by-agent.pdf", createdAt: at(2) },
    // Uploader ids are stored as text; a non-uuid one must not fail the uuid comparison.
    { messageId: message.id, channelId: channel.id, uploaderId: "legacy-uploader", uploaderType: "user", filename: "by-legacy.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "attachments/by-legacy.pdf", createdAt: at(3) },
  ]);

  const files = await listChannelFiles(channel.id);
  const byName = new Map(files.map((file) => [file.filename, file]));
  assert.deepEqual(files.map((file) => file.filename), ["by-legacy.pdf", "by-agent.pdf", "by-user.pdf"]);
  assert.equal(byName.get("by-user.pdf")?.uploaderName, "files-uploaders-owner");
  assert.equal(byName.get("by-agent.pdf")?.uploaderName, agent.name);
  assert.equal(byName.get("by-legacy.pdf")?.uploaderId, "legacy-uploader");
  assert.equal(byName.get("by-legacy.pdf")?.uploaderName, null);
});

async function listFilesViaRoute(baseUrl: string, token: string, serverId: string, channelId: string, query = "") {
  const res = await fetch(`${baseUrl}/api/channels/${channelId}/files${query}`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200);
  return await res.json() as { files: any[]; nextCursor: string | null };
}

// Storage step 2b: the list reads physical metadata from attachment_objects.
// These fixtures keep the legacy copies equal to the object, as production
// does (0 mismatches), so this case states the output the legacy read gave
// and must keep giving: images, files, a revoked file (still listed, as
// before), a forwarded copy sharing its source's object, and a thread file.
test("Files list output over object-backed fixtures is unchanged (image, file, revoked, forwarded, thread)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("files-parity-owner@slock.test", "files-parity-owner");
  const server = await createServer("Files Parity", "files-parity", owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "files-parity-room");
  await addHuman(channel.id, owner.id);
  const imageMessage = await createMessage(channel.id, "user", owner.id, "image");
  const fileMessage = await createMessage(channel.id, "user", owner.id, "file");
  const forwardMessage = await createMessage(channel.id, "user", owner.id, "forward");
  const parentMessage = await createMessage(channel.id, "user", owner.id, "thread parent");
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  const threadMessage = await createMessage(thread.id, "user", owner.id, "thread file");
  const at = (minute: number) => new Date(`2026-05-11T10:0${minute}:00Z`);

  const [image] = await insertAttachmentsWithObjects(db, [{
    id: "00000000-0000-4000-8000-000000000201",
    messageId: imageMessage.id,
    channelId: channel.id,
    createdById: owner.id,
    createdByType: "user",
    uploaderId: owner.id,
    uploaderType: "user",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 4096,
    storageKey: "attachments/v2/parity/photo.png",
    thumbnailKey: "content/v2/parity/photo.webp",
    contentHash: "a".repeat(64),
    width: 640,
    height: 480,
    createdAt: at(1),
  }]);
  await insertAttachmentsWithObjects(db, [
    {
      id: "00000000-0000-4000-8000-000000000202",
      messageId: fileMessage.id,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12345,
      storageKey: "attachments/v2/parity/report.pdf",
      contentHash: "b".repeat(64),
      createdAt: at(2),
    },
    {
      id: "00000000-0000-4000-8000-000000000203",
      messageId: fileMessage.id,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "withdrawn.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      storageKey: "attachments/v2/parity/withdrawn.txt",
      revokedAt: at(4),
      revokedById: owner.id,
      revokedByType: "user",
      revokeReason: "test",
      createdAt: at(3),
    },
    // A forward: a new projection over the source's object, the shape
    // attachmentForwardService writes (uploader = the object's uploader).
    {
      id: "00000000-0000-4000-8000-000000000204",
      objectId: image.objectId,
      messageId: forwardMessage.id,
      channelId: channel.id,
      createdById: owner.id,
      createdByType: "user",
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "photo-forwarded.png",
      mimeType: "image/png",
      sizeBytes: 4096,
      storageKey: "attachments/v2/parity/photo.png",
      thumbnailKey: "content/v2/parity/photo.webp",
      contentHash: "a".repeat(64),
      width: 640,
      height: 480,
      createdAt: at(5),
    },
    {
      id: "00000000-0000-4000-8000-000000000205",
      messageId: threadMessage.id,
      channelId: thread.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 99,
      storageKey: "attachments/v2/parity/notes.md",
      createdAt: at(6),
    },
  ]);

  const uploader = { type: "user", id: owner.id, name: "files-parity-owner", displayName: "files-parity-owner" };
  const channelSource = { type: "channel", channelId: channel.id, parentMessageId: null, parentMessageShortId: null };
  const expected = [
    {
      id: "00000000-0000-4000-8000-000000000205", messageId: threadMessage.id, channelId: thread.id,
      filename: "notes.md", mimeType: "text/markdown", sizeBytes: 99, width: null, height: null,
      thumbnailUrl: null, createdAt: "2026-05-11T10:06:00.000000Z", uploader,
      source: { type: "thread", channelId: thread.id, parentMessageId: parentMessage.id, parentMessageShortId: parentMessage.id.slice(0, 8) },
    },
    {
      id: "00000000-0000-4000-8000-000000000204", messageId: forwardMessage.id, channelId: channel.id,
      filename: "photo-forwarded.png", mimeType: "image/png", sizeBytes: 4096, width: 640, height: 480,
      thumbnailUrl: getThumbnailUrl("content/v2/parity/photo.webp"), createdAt: "2026-05-11T10:05:00.000000Z", uploader,
      source: channelSource,
    },
    {
      id: "00000000-0000-4000-8000-000000000203", messageId: fileMessage.id, channelId: channel.id,
      filename: "withdrawn.txt", mimeType: "text/plain", sizeBytes: 7, width: null, height: null,
      thumbnailUrl: null, createdAt: "2026-05-11T10:03:00.000000Z", uploader, source: channelSource,
    },
    {
      id: "00000000-0000-4000-8000-000000000202", messageId: fileMessage.id, channelId: channel.id,
      filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 12345, width: null, height: null,
      thumbnailUrl: null, createdAt: "2026-05-11T10:02:00.000000Z", uploader, source: channelSource,
    },
    {
      id: "00000000-0000-4000-8000-000000000201", messageId: imageMessage.id, channelId: channel.id,
      filename: "photo.png", mimeType: "image/png", sizeBytes: 4096, width: 640, height: 480,
      thumbnailUrl: getThumbnailUrl("content/v2/parity/photo.webp"), createdAt: "2026-05-11T10:01:00.000000Z", uploader,
      source: channelSource,
    },
  ];

  const token = await tokenForHuman("files-parity-owner@slock.test");
  const body = await listFilesViaRoute(app.baseUrl, token, server.id, channel.id);
  assert.deepEqual(body, { files: expected, nextCursor: null });

  // The same rows page by page: ordering and cursors are unchanged.
  const paged: any[] = [];
  let query = "?limit=2";
  for (let guard = 0; guard < 5; guard += 1) {
    const page = await listFilesViaRoute(app.baseUrl, token, server.id, channel.id, query);
    paged.push(...page.files);
    if (!page.nextCursor) break;
    query = `?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`;
  }
  assert.deepEqual(paged, expected);
});

test("Files list on a Free server keeps the history window over object-backed files", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("files-window-owner@slock.test", "files-window-owner");
  const server = await createServer("Files Window", "files-window", owner.id);
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "files-window-room");
  await addHuman(channel.id, owner.id);
  const oldMessage = await createMessage(channel.id, "user", owner.id, "old");
  const recentMessage = await createMessage(channel.id, "user", owner.id, "recent");
  const longAgo = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000);
  await db.update(messages).set({ createdAt: longAgo }).where(eq(messages.id, oldMessage.id));
  await insertAttachmentsWithObjects(db, [
    { messageId: oldMessage.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "old.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "attachments/window/old.pdf", createdAt: longAgo },
    { messageId: recentMessage.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "recent.pdf", mimeType: "application/pdf", sizeBytes: 2, storageKey: "attachments/window/recent.pdf" },
  ]);

  const token = await tokenForHuman("files-window-owner@slock.test");
  const body = await listFilesViaRoute(app.baseUrl, token, server.id, channel.id);
  assert.deepEqual(body.files.map((file) => [file.filename, file.sizeBytes]), [["recent.pdf", 2]]);
  assert.equal(body.nextCursor, null);
});

// #proj-commercial:#24: the panel's "older files are hidden" Banner showed on
// every channel older than the window, files hidden or not.
test("Files list on a Free server says on its first page whether the window hides any of the channel's files", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("files-hidden-owner@slock.test", "files-hidden-owner");
  const server = await createServer("Files Hidden", "files-hidden", owner.id);
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const longAgo = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000);
  const token = await tokenForHuman("files-hidden-owner@slock.test");
  const channelWith = async (name: string, created: Date) => {
    const channel = await createChannel(server.id, name);
    await addHuman(channel.id, owner.id);
    await db.update(channels).set({ createdAt: created }).where(eq(channels.id, channel.id));
    return channel;
  };
  const attach = async (channelId: string, filename: string, at?: Date) => {
    const message = await createMessage(channelId, "user", owner.id, filename);
    if (at) await db.update(messages).set({ createdAt: at }).where(eq(messages.id, message.id));
    await insertAttachmentsWithObjects(db, [
      { messageId: message.id, channelId, uploaderId: owner.id, uploaderType: "user", filename, mimeType: "application/pdf", sizeBytes: 1, storageKey: `attachments/hidden/${channelId}/${filename}`, ...(at ? { createdAt: at } : {}) },
    ]);
    return message;
  };
  type FilesPage = { files: any[]; nextCursor: string | null; historyLimited?: boolean };

  // An old file in a thread: hidden, and the first page says so; a later page doesn't repeat it.
  const hiding = await channelWith("files-hidden-thread", longAgo);
  const parent = await createMessage(hiding.id, "user", owner.id, "parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await attach(thread.id, "old-in-thread.pdf", longAgo);
  await attach(hiding.id, "recent-a.pdf");
  await attach(hiding.id, "recent-b.pdf");
  const first = await listFilesViaRoute(app.baseUrl, token, server.id, hiding.id, "?limit=1") as FilesPage;
  assert.equal(first.files.length, 1);
  assert.equal(first.historyLimited, true);
  const second = await listFilesViaRoute(app.baseUrl, token, server.id, hiding.id, `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`) as FilesPage;
  assert.equal(second.files.length, 1);
  assert.equal("historyLimited" in second, false, "only the first page says it");

  // As old as the window allows, but every file recent: nothing hidden.
  const recentOnly = await channelWith("files-hidden-none", longAgo);
  await attach(recentOnly.id, "recent.pdf");
  assert.equal((await listFilesViaRoute(app.baseUrl, token, server.id, recentOnly.id) as FilesPage).historyLimited, false);

  // Younger than the window: nothing to hide, without looking.
  const young = await channelWith("files-hidden-young", new Date());
  assert.equal((await listFilesViaRoute(app.baseUrl, token, server.id, young.id) as FilesPage).historyLimited, false);

  // No window (paid): the list doesn't say.
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  assert.equal("historyLimited" in await listFilesViaRoute(app.baseUrl, token, server.id, hiding.id), false);
});

test("Files list takes size, type, dimensions and thumbnail from the attachment object", async ({ app }) => {
  void app;
  const db = getDb();
  const owner = await seedUser("files-object-owner@slock.test", "files-object-owner");
  const server = await createServer("Files Object", "files-object", owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "files-object-room");
  const message = await createMessage(channel.id, "user", owner.id, "object read");
  const [projection] = await insertAttachmentsWithObjects(db, {
    messageId: message.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user",
    filename: "diagram.png", mimeType: "image/png", sizeBytes: 2048, width: 300, height: 200,
    storageKey: "attachments/object/diagram.png", thumbnailKey: "content/object/diagram.webp",
  });

  const [file] = await listChannelFiles(channel.id);
  assert.deepEqual(
    [file.mimeType, file.sizeBytes, file.width, file.height, file.thumbnailKey],
    ["image/png", 2048, 300, 200, "content/object/diagram.webp"],
  );
  const [object] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, projection.objectId!));
  assert.equal(object.sizeBytes, 2048);
});

test("Files list createdAt is UTC ISO with microseconds whatever the session time zone, and cursors still page", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("files-tz-owner@slock.test", "files-tz-owner");
  const server = await createServer("Files Time Zone", "files-tz", owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "files-tz-room");
  await addHuman(channel.id, owner.id);
  const message = await createMessage(channel.id, "user", owner.id, "two files");
  await insertAttachmentsWithObjects(db, [
    { messageId: message.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "older.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "attachments/tz/older.pdf", createdAt: new Date("2026-05-13T10:01:00Z") },
    { messageId: message.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "newer.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "attachments/tz/newer.pdf", createdAt: new Date("2026-05-13T10:02:00Z") },
  ]);
  // Both rows in the same millisecond, apart only in microseconds, which
  // toISOString() could not carry: a cursor cut to .123 would skip older.pdf.
  await db.execute(sql`UPDATE attachments SET created_at = '2026-05-13T10:02:00.123456Z' WHERE channel_id = ${channel.id} AND filename = 'newer.pdf'`);
  await db.execute(sql`UPDATE attachments SET created_at = '2026-05-13T10:02:00.123400Z' WHERE channel_id = ${channel.id} AND filename = 'older.pdf'`);

  const zone = await db.execute(sql`SELECT current_setting('TimeZone') AS zone`);
  const originalZone = String((zone.rows[0] as { zone: string }).zone);
  await db.execute(sql`SET TIME ZONE 'Asia/Shanghai'`);
  try {
    const token = await tokenForHuman("files-tz-owner@slock.test");
    const firstPage = await listFilesViaRoute(app.baseUrl, token, server.id, channel.id, "?limit=1");
    assert.deepEqual(firstPage.files.map((file) => file.createdAt), ["2026-05-13T10:02:00.123456Z"]);
    const secondPage = await listFilesViaRoute(
      app.baseUrl, token, server.id, channel.id, `?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    assert.deepEqual(secondPage.files.map((file) => [file.filename, file.createdAt]), [["older.pdf", "2026-05-13T10:02:00.123400Z"]]);
    assert.equal(secondPage.nextCursor, null);
  } finally {
    await db.execute(sql`SELECT set_config('TimeZone', ${originalZone}, false)`);
  }
});

test("Files list never meets a projection without an object: the database refuses one", async ({ app }) => {
  void app;
  const db = getDb();
  const owner = await seedUser("files-objectless-owner@slock.test", "files-objectless-owner");
  const server = await createServer("Files Objectless", "files-objectless", owner.id);
  const channel = await createChannel(server.id, "files-objectless-room");
  const message = await createMessage(channel.id, "user", owner.id, "objectless");
  await assert.rejects(db.insert(attachments).values({
    objectId: null as unknown as string, messageId: message.id, channelId: channel.id,
    uploaderId: owner.id, uploaderType: "user", filename: "objectless.pdf",
  }));
});
