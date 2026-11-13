// platform/attachments: an attachment's bytes for an app to copy, and where it
// was posted, only for a viewer who can see that message's conversation,
// within the plan's history window; a revoked attachment, one whose object GC
// deleted, one in a message behind the window or an id that isn't one answer
// null; storage unconfigured throws. (An unbound row cannot exist: object_id
// is NOT NULL since storage step 2c.)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { attachmentObjects, attachments, servers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { __setStorageForTests, resetStorageForTests, type StorageBackend } from "../services/storageService";
import type { ViewActor } from "../services/visibilityService";
import { dbTest as test } from "../test/integration/dbTest";
import { AttachmentStorageUnavailableError, attachmentSource, attachmentSources, readAttachmentForSave } from "./attachments";

afterEach(() => {
  resetStorageForTests();
});

function memoryStorage(objects: Map<string, Buffer>): StorageBackend {
  return {
    put: async () => {},
    delete: async () => {},
    get: async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error(`no object ${key}`), { name: "NoSuchKey" });
      return Readable.from([bytes]);
    },
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

test("readAttachmentForSave and attachmentSource: only for a viewer who can see the message's conversation", async ({ seed }) => {
  const db = getDb();
  const label = () => randomUUID().slice(0, 8);
  const owner = await seed.human();
  const member = await seed.human();
  const peerOwner = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const peer = await seed.server({ owner: peerOwner });
  const serverId = asServerId(server.id);
  const agentIn = await createAgent(server.id, `att-in-${label()}`, { runtime: "claude", model: "sonnet" });
  const agentOut = await createAgent(server.id, `att-out-${label()}`, { runtime: "claude", model: "sonnet" });
  const priv = await createChannel(server.id, `att-priv-${label()}`, undefined, "private");
  await addHuman(priv.id, owner.id);
  await addAgent(priv.id, agentIn.id);
  const message = await createMessage(priv.id, "user", owner.id, "the original");

  const objects = new Map<string, Buffer>();
  __setStorageForTests(memoryStorage(objects));
  const bytes = Buffer.from("<h1>saved</h1>");
  const post = async (values: Partial<typeof attachments.$inferInsert> = {}) => {
    const storageKey = `att/${randomUUID()}`;
    objects.set(storageKey, bytes);
    const [object] = await db.insert(attachmentObjects).values({
      originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey, mimeType: "text/html", sizeBytes: bytes.length,
    }).returning();
    const [row] = await db.insert(attachments).values({
      objectId: object!.id, messageId: message.id, channelId: priv.id, uploaderId: owner.id, uploaderType: "user",
      filename: "page.html", ...values,
    }).returning();
    return { attachment: row!, object: object! };
  };
  const { attachment, object } = await post();

  const viewers = {
    owner: { type: "user", id: owner.id, serverId },
    agentIn: { type: "agent", id: agentIn.id, serverId },
    member: { type: "user", id: member.id, serverId },
    agentOut: { type: "agent", id: agentOut.id, serverId },
    outsider: { type: "user", id: peerOwner.id, serverId: asServerId(peer.id) },
  } satisfies Record<string, ViewActor>;
  const source = { attachmentId: attachment.id, messageId: message.id, channelId: priv.id, conversationId: priv.id, name: "page.html", mime: "text/html", size: bytes.length };

  for (const name of ["owner", "agentIn"] as const) {
    assert.deepEqual(await attachmentSource(viewers[name], attachment.id), source, `${name}: attachmentSource`);
    const saved = await readAttachmentForSave(viewers[name], attachment.id);
    assert.ok(saved, `${name}: readAttachmentForSave`);
    const { stream, ...rest } = saved;
    assert.deepEqual(rest, source);
    assert.deepEqual(await readAll(stream), bytes);
  }
  // Who can't see the message's conversation gets nothing, bytes or source.
  for (const name of ["member", "agentOut", "outsider"] as const) {
    assert.equal(await attachmentSource(viewers[name], attachment.id), null, `${name}: attachmentSource`);
    assert.equal(await readAttachmentForSave(viewers[name], attachment.id), null, `${name}: readAttachmentForSave`);
  }

  // Not an attachment id, or no such attachment.
  assert.equal(await readAttachmentForSave(viewers.owner, "not-a-uuid"), null);
  assert.equal(await readAttachmentForSave(viewers.owner, randomUUID()), null);
  // Revoked; an object GC deleted; bytes gone from storage. A row bound to no object cannot exist.
  const revoked = await post({ revokedAt: new Date(), revokedById: owner.id, revokedByType: "user" });
  assert.equal(await readAttachmentForSave(viewers.owner, revoked.attachment.id), null, "revoked");
  await assert.rejects(post({ objectId: null as unknown as string }), "object_id is NOT NULL");
  const collected = await post();
  await db.update(attachmentObjects).set({ lifecycleState: "deleted", gcToken: randomUUID(), gcStartedAt: new Date() }).where(eq(attachmentObjects.id, collected.object.id));
  assert.equal(await readAttachmentForSave(viewers.owner, collected.attachment.id), null, "GC-deleted object");
  objects.delete(object.storageKey);
  assert.equal(await readAttachmentForSave(viewers.owner, attachment.id), null, "bytes gone from storage");

  // Without attachment storage the bytes can't be read; the source still can.
  __setStorageForTests(null);
  const fresh = await post();
  await assert.rejects(readAttachmentForSave(viewers.owner, fresh.attachment.id), AttachmentStorageUnavailableError);
  assert.deepEqual(await attachmentSource(viewers.owner, fresh.attachment.id), { ...source, attachmentId: fresh.attachment.id });
  // Storage isn't asked before the viewer is checked.
  assert.equal(await readAttachmentForSave(viewers.member, fresh.attachment.id), null);

  // In a thread: `channelId` is the thread, `conversationId` the conversation it is in.
  const thread = await getOrCreateThread(message.id, owner.id, "user");
  const reply = await createMessage(thread.id, "user", owner.id, "a reply");
  const inThread = await post({ messageId: reply.id, channelId: thread.id });
  assert.deepEqual(await attachmentSource(viewers.owner, inThread.attachment.id), {
    ...source, attachmentId: inThread.attachment.id, messageId: reply.id, channelId: thread.id, conversationId: priv.id,
  });
});

test("the plan's history window: a file in a message behind it is null for every read, as the attachment routes answer it", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const viewer: ViewActor = { type: "user", id: owner.id, serverId: asServerId(server.id) };
  const channel = await createChannel(server.id, `att-window-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(channel.id, owner.id);
  const objects = new Map<string, Buffer>();
  __setStorageForTests(memoryStorage(objects));
  const post = async (messageId: string) => {
    const storageKey = `att/${randomUUID()}`;
    objects.set(storageKey, Buffer.from("x"));
    const [object] = await db.insert(attachmentObjects).values({
      originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey, mimeType: "text/plain", sizeBytes: 1,
    }).returning();
    const [row] = await db.insert(attachments).values({
      objectId: object!.id, messageId, channelId: channel.id, uploaderId: owner.id, uploaderType: "user",
      filename: "a.txt",
    }).returning();
    return row!;
  };
  const old = await createMessage(channel.id, "user", owner.id, "an old file");
  const recent = await createMessage(channel.id, "user", owner.id, "a recent file");
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);
  const oldFile = await post(old.id);
  const recentFile = await post(recent.id);

  // Free (30 days): the old one is behind the window.
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  assert.equal(await attachmentSource(viewer, oldFile.id), null);
  assert.equal(await readAttachmentForSave(viewer, oldFile.id), null);
  assert.ok(await attachmentSource(viewer, recentFile.id));
  assert.deepEqual((await attachmentSources(viewer, [oldFile.id, recentFile.id, "not-a-uuid"])).map((source) => source?.attachmentId ?? null), [null, recentFile.id, null]);
  assert.deepEqual(await attachmentSources(viewer, []), []);

  // Pro keeps all history: both are readable.
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  assert.equal((await attachmentSource(viewer, oldFile.id))?.attachmentId, oldFile.id);
  const saved = await readAttachmentForSave(viewer, oldFile.id);
  assert.ok(saved);
  saved.stream.destroy();
});
