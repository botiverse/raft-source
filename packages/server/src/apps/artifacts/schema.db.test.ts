// The app_artifacts invariants the database itself holds, on the migrated
// schema: one home per item, a deleted home channel never takes its Artifacts
// with it nor is refused (a hard delete leaves an orphan), names unique per
// home among live items, blobs deduplicated per server, anchors only on a
// path (a reply draft on none), nothing of the app holds back core deleting an attachment, a
// message or a conversation, the backfills of the original message and
// the original conversation, a version's stored public text going with
// its version (and item) within its loose limits, and a version's publish
// check: one per version, its states' columns held together, going with its
// version, item and server.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { asObjectFileId, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { attachmentObjects, attachments, channels, messages, servers } from "../../db/schema";
import { createChannel } from "../../services/channelService";
import { createMessage } from "../../services/messageService";
import { dbTest as test } from "../../test/integration/dbTest";
import { artifactAttachmentSaves, artifactAudit, artifactBlobs, artifactCommentDrafts, artifactComments, artifactItems, artifactVersionChecks, artifactVersions, artifactVersionTexts } from "./schema";

const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

/** Drizzle wraps the driver error; the constraint name is in the cause. */
function violates(name: string) {
  return (error: unknown) => {
    const text = `${error instanceof Error ? error.message : ""} ${String((error as { cause?: unknown })?.cause ?? "")}`;
    assert.match(text, new RegExp(name));
    return true;
  };
}

test("app_artifacts holds its invariants in the database", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const channel = await createChannel(server.id, `schema-home-${randomUUID().slice(0, 8)}`);
  const item = (values: Partial<typeof artifactItems.$inferInsert>) => {
    const id = newId("pt");
    return { id, serverId, urlKey: id, name: id, title: id, homeKind: "public" as const, createdByType: "user" as const, createdById: owner.id, ...values };
  };

  // One home: only a conversation names a channel. A conversation home
  // without one is an orphan (its channel was hard-deleted), allowed.
  await assert.rejects(db.insert(artifactItems).values(item({ homeKind: "server", homeChannelId: channel.id })), violates("items_home_channel"));
  await assert.rejects(db.insert(artifactItems).values(item({ homeKind: "public", homeChannelId: channel.id })), violates("items_home_channel"));
  await db.insert(artifactItems).values(item({ homeKind: "conversation", homeChannelId: null }));
  await assert.rejects(
    db.insert(artifactItems).values(item({ homeKind: "self" as never })),
    violates("items_home_kind"),
  );
  const [homed] = await db.insert(artifactItems).values(item({ homeKind: "conversation", homeChannelId: channel.id })).returning();

  // A name is unique among the live items of one home, and only there. A
  // server or public home has no channel: NULLs must not make every name free.
  const other = await createChannel(server.id, `schema-other-${randomUUID().slice(0, 8)}`);
  const name = `name-${randomUUID().slice(0, 8)}`;
  await db.insert(artifactItems).values(item({ name, homeKind: "conversation", homeChannelId: channel.id }));
  await assert.rejects(db.insert(artifactItems).values(item({ name, homeKind: "conversation", homeChannelId: channel.id })), violates("idx_items_live_name_conversation"));
  await db.insert(artifactItems).values(item({ name, homeKind: "conversation", homeChannelId: other.id }));
  for (const homeKind of ["server", "public"] as const) {
    await db.insert(artifactItems).values(item({ name, homeKind }));
    await assert.rejects(db.insert(artifactItems).values(item({ name, homeKind })), violates("idx_items_live_name_server_home"));
  }
  // Deleted and revoked items free their name.
  await db.insert(artifactItems).values([item({ name, homeKind: "server", deletedAt: new Date() }), item({ name, homeKind: "server", revokedAt: new Date() })]);
  // Artifacts made since titles have no name (NULL): any number of them in one home, every kind.
  await db.insert(artifactItems).values([
    item({ name: null, homeKind: "conversation", homeChannelId: channel.id }),
    item({ name: null, homeKind: "conversation", homeChannelId: channel.id }),
    item({ name: null, homeKind: "server" }),
    item({ name: null, homeKind: "server" }),
  ]);

  // A deleted home channel never takes its Artifacts with it. Soft-deleted,
  // the item keeps its channel; hard-deleted, the delete goes through (the
  // app holds nothing back) and the item stays, an orphan with no channel.
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, channel.id));
  assert.equal((await db.select().from(artifactItems).where(eq(artifactItems.id, homed!.id)))[0]!.homeChannelId, channel.id);
  await db.delete(channels).where(eq(channels.id, channel.id));
  const [orphan] = await db.select().from(artifactItems).where(eq(artifactItems.id, homed!.id));
  assert.equal(orphan!.homeKind, "conversation");
  assert.equal(orphan!.homeChannelId, null);

  // Versions are numbered once per item.
  const version = (number: number) => ({
    id: newId("v"), itemId: homed!.id, number, entry: "index.html", fileCount: 1, sizeBytes: 10,
    publishDigest: "digest", status: "ready", publisherType: "user" as const, publisherId: owner.id,
  });
  const [v1] = await db.insert(artifactVersions).values(version(1)).returning();
  // Loose limit on an excerpt: 1000 characters fit, whatever their bytes; more doesn't.
  await db.update(artifactVersions).set({ excerpt: "é".repeat(1000) }).where(eq(artifactVersions.id, v1!.id));
  await assert.rejects(db.update(artifactVersions).set({ excerpt: "x".repeat(1001) }).where(eq(artifactVersions.id, v1!.id)), violates("versions_excerpt_length"));
  // An excerpt's blocks: a list, loosely bounded in bytes, never without the text.
  const longBlock = (text: string) => [{ type: "paragraph" as const, spans: [{ text }] }];
  await db.update(artifactVersions).set({ excerptBlocks: longBlock("é".repeat(5000)) }).where(eq(artifactVersions.id, v1!.id));
  await assert.rejects(db.update(artifactVersions).set({ excerptBlocks: longBlock("é".repeat(7000)) }).where(eq(artifactVersions.id, v1!.id)), violates("versions_excerpt_blocks_shape"));
  await assert.rejects(db.update(artifactVersions).set({ excerpt: null }).where(eq(artifactVersions.id, v1!.id)), violates("versions_excerpt_blocks_shape"));
  await assert.rejects(db.update(artifactVersions).set({ excerptBlocks: { not: "a list" } as never }).where(eq(artifactVersions.id, v1!.id)), violates("versions_excerpt_blocks_shape"));
  await db.update(artifactVersions).set({ excerpt: null, excerptBlocks: null }).where(eq(artifactVersions.id, v1!.id));
  await assert.rejects(db.insert(artifactVersions).values(version(1)), violates("idx_versions_item_number"));

  // Every blob is in Artifacts' R2, of one server, at its key.
  const blob = (values: Partial<typeof artifactBlobs.$inferInsert>) => ({ id: newId("b"), serverId, sha256: randomUUID(), sizeBytes: 10, r2Key: `k-${randomUUID()}`, ...values });
  await assert.rejects(db.insert(artifactBlobs).values(blob({ r2Key: null as never })), /r2_key/);
  await assert.rejects(db.insert(artifactBlobs).values(blob({ serverId: null as never })), /server_id/);
  // One blob per server and sha256; another server's same bytes are its own.
  const peer = await seed.server({ owner });
  const sha256 = randomUUID();
  await db.insert(artifactBlobs).values(blob({ sha256 }));
  await assert.rejects(db.insert(artifactBlobs).values(blob({ sha256 })), violates("idx_blobs_server_sha256"));
  await db.insert(artifactBlobs).values(blob({ sha256, serverId: asServerId(peer.id) }));

  // An anchor points inside a file.
  const comment = (values: Partial<typeof artifactComments.$inferInsert>) => ({
    id: newId("c"), itemId: homed!.id, versionId: v1!.id, authorType: "user" as const, authorId: owner.id, body: "hi", position: 1, ...values,
  });
  await assert.rejects(db.insert(artifactComments).values(comment({ anchor: { type: "html-region", data: {} } })), violates("comments_anchor_needs_path"));
  const [written] = await db.insert(artifactComments).values(comment({ path: "index.html", anchor: { type: "html-region", data: { quote: "x" } } })).returning();
  assert.deepEqual(written!.mentions, []);

  // A reply draft has no place of its own, and its comment going (outright, as one without replies does) leaves it for the submit to refuse.
  const draft = (values: Partial<typeof artifactCommentDrafts.$inferInsert>) => ({ id: randomUUID(), itemId: homed!.id, authorId: owner.id, version: 1, body: [{ type: "text" as const, text: "re" }], ...values });
  await assert.rejects(db.insert(artifactCommentDrafts).values(draft({ replyTo: written!.id, path: "index.html" })), violates("comment_drafts_reply_has_no_place"));
  const [reply] = await db.insert(artifactCommentDrafts).values(draft({ replyTo: written!.id })).returning();
  await db.delete(artifactComments).where(eq(artifactComments.id, written!.id));
  const [left] = await db.select().from(artifactCommentDrafts).where(eq(artifactCommentDrafts.id, reply!.id));
  assert.equal(left?.replyTo, written!.id, "no foreign key: neither cascaded nor set null");

  // Core deletes an attachment, and then its object, without the app in the
  // way: saving copied the bytes, so nothing points at attachment storage, and
  // the "saved as Artifact" row goes with the attachment.
  const posted = await createChannel(server.id, `schema-posted-${randomUUID().slice(0, 8)}`);
  const [object] = await db.insert(attachmentObjects).values({
    originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey: `schema/${randomUUID()}`, mimeType: "text/html", sizeBytes: 10,
  }).returning();
  const [attachment] = await db.insert(attachments).values({
    objectId: object!.id, channelId: posted.id, uploaderId: owner.id, uploaderType: "user", filename: "page.html",
  }).returning();
  await db.insert(artifactAttachmentSaves).values({ attachmentId: attachment!.id, itemId: homed!.id, versionId: v1!.id });
  await db.delete(attachments).where(eq(attachments.id, attachment!.id));
  assert.equal((await db.select().from(artifactAttachmentSaves).where(eq(artifactAttachmentSaves.attachmentId, attachment!.id))).length, 0);
  await db.delete(attachmentObjects).where(eq(attachmentObjects.id, object!.id));
  assert.equal((await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, object!.id))).length, 0);
  assert.equal((await db.select().from(artifactItems).where(eq(artifactItems.id, homed!.id))).length, 1, "the Artifact keeps its own copy");
});

test("the original message: set with how it came, a message's delete goes through and leaves it as it was, and the migration's backfill takes the earliest save's message", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const channel = await createChannel(server.id, `schema-origin-${randomUUID().slice(0, 8)}`);
  const item = (values: Partial<typeof artifactItems.$inferInsert> = {}) => {
    const id = newId("pt");
    return { id, serverId, urlKey: id, name: id, title: id, homeKind: "server" as const, createdByType: "user" as const, createdById: owner.id, ...values };
  };
  const message = async () => (await createMessage(channel.id, "user", owner.id, "with a file")).id;

  // A message is an origin only with how it became one, and only as one of those.
  await assert.rejects(db.insert(artifactItems).values(item({ originMessageId: await message() })), violates("items_origin_message_via"));
  await assert.rejects(db.insert(artifactItems).values(item({ originMessageId: await message(), originVia: "link" as never })), violates("items_origin_via"));

  // No foreign key (Tenny): core deletes the message without the app in the
  // way, and the Artifact keeps the id as it was (readers show none: the
  // origin tests in share.api.test.ts and saveAgent.api.test.ts).
  const gone = await message();
  const [shared] = await db.insert(artifactItems).values(item({ originMessageId: gone, originVia: "share" })).returning();
  await db.delete(messages).where(eq(messages.id, gone));
  const [after] = await db.select().from(artifactItems).where(eq(artifactItems.id, shared!.id));
  assert.deepEqual([after!.originMessageId, after!.originVia], [gone, "share"]);

  // The backfill: an item saved from attachments takes the earliest save's
  // message; one already with an origin, or never saved, is left as it is.
  const attachmentOn = async (messageId: string) => {
    const [object] = await db.insert(attachmentObjects).values({
      originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey: `schema/${randomUUID()}`, mimeType: "text/plain", sizeBytes: 1,
    }).returning();
    const [row] = await db.insert(attachments).values({ objectId: object!.id, messageId, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "a.txt" }).returning();
    return row!.id;
  };
  const versionOf = async (itemId: string) => (await db.insert(artifactVersions).values({
    id: newId("v"), itemId, number: 1, entry: "a.txt", fileCount: 1, sizeBytes: 1, publishDigest: "d", status: "published", publisherType: "user", publisherId: owner.id,
  }).returning())[0]!.id;
  const [saved] = await db.insert(artifactItems).values(item()).returning();
  const [kept] = await db.insert(artifactItems).values(item()).returning();
  const [never] = await db.insert(artifactItems).values(item()).returning();
  const first = await message();
  const later = await message();
  const savedVersion = await versionOf(saved!.id);
  await db.insert(artifactAttachmentSaves).values([
    { attachmentId: await attachmentOn(later), itemId: saved!.id, versionId: savedVersion, createdAt: new Date("2026-10-02T00:00:00Z") },
    { attachmentId: await attachmentOn(first), itemId: saved!.id, versionId: savedVersion, createdAt: new Date("2026-10-01T00:00:00Z") },
  ]);
  const ownOrigin = await message();
  await db.update(artifactItems).set({ originMessageId: ownOrigin, originVia: "share" }).where(eq(artifactItems.id, kept!.id));
  await db.insert(artifactAttachmentSaves).values({ attachmentId: await attachmentOn(await message()), itemId: kept!.id, versionId: await versionOf(kept!.id) });

  await db.execute(sql.raw(originBackfillStatement()));
  const originOf = async (id: string) => {
    const [row] = await db.select({ messageId: artifactItems.originMessageId, via: artifactItems.originVia }).from(artifactItems).where(eq(artifactItems.id, id));
    return row;
  };
  assert.deepEqual(await originOf(saved!.id), { messageId: first, via: "attachment" });
  assert.deepEqual(await originOf(kept!.id), { messageId: ownOrigin, via: "share" });
  assert.deepEqual(await originOf(never!.id), { messageId: null, via: null });
});

/** The backfill statement of the migration that added the original message (found by name: its number moves). */
function originBackfillStatement(): string {
  return backfillStatementOf("artifact_origin_message");
}

/** The one `UPDATE app_artifacts.items` statement of the migration named `tag` (found by name: its number moves). */
function backfillStatementOf(tag: string): string {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const file = readdirSync(dir).find((name) => name.endsWith(`_${tag}.sql`));
  assert.ok(file, `the ${tag} migration`);
  const statements = readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint");
  const backfill = statements.filter((statement) => /UPDATE "app_artifacts"\."items"/.test(statement));
  assert.equal(backfill.length, 1);
  return backfill[0]!;
}

test("the original conversation (#75): no foreign key, a conversation's delete leaves it as it was; the migration's backfill takes the conversation it is in, else the earliest one its audit rows record, else none", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const channel = async () => createChannel(server.id, `schema-original-${randomUUID().slice(0, 8)}`);
  const item = (values: Partial<typeof artifactItems.$inferInsert> = {}) => {
    const id = newId("pt");
    return { id, serverId, urlKey: id, name: id, title: id, homeKind: "server" as const, createdByType: "user" as const, createdById: owner.id, ...values };
  };

  // No foreign key (Tenny): core hard-deletes the conversation without the app in the way; the id stays as it was.
  const gone = await channel();
  const [orphaned] = await db.insert(artifactItems).values(item({ originalHomeChannelId: gone.id })).returning();
  await db.delete(channels).where(eq(channels.id, gone.id));
  assert.equal((await db.select().from(artifactItems).where(eq(artifactItems.id, orphaned!.id)))[0]!.originalHomeChannelId, gone.id);

  // The backfill. Audit rows as the home changes write them (manage.ts homeFacts: `before` { home_kind, home_channel_id }).
  const audit = (itemId: string, action: string, before: Record<string, unknown>, at: string) =>
    db.insert(artifactAudit).values({ itemId, actorType: "user", actorId: owner.id, action, before, after: {}, createdAt: new Date(at) });
  const here = await channel();
  const first = randomUUID();
  const later = randomUUID();
  const [inConversation] = await db.insert(artifactItems).values(item({ homeKind: "conversation", homeChannelId: here.id })).returning();
  // Moved from `first` to the server, then (narrowed to `later`) widened again: the earliest conversation home.
  const [widened] = await db.insert(artifactItems).values(item({ homeKind: "public" })).returning();
  await audit(widened!.id, "made_public", { home_kind: "server", home_channel_id: null }, "2026-10-03T00:00:00Z");
  await audit(widened!.id, "home_changed", { home_kind: "conversation", home_channel_id: later }, "2026-10-02T00:00:00Z");
  await audit(widened!.id, "home_changed", { home_kind: "conversation", home_channel_id: first }, "2026-10-01T00:00:00Z");
  // Made in the whole server, made public: never in a conversation.
  const [serverMade] = await db.insert(artifactItems).values(item({ homeKind: "public" })).returning();
  await audit(serverMade!.id, "made_public", { home_kind: "server", home_channel_id: null }, "2026-10-01T00:00:00Z");
  await audit(serverMade!.id, "deleted", { deleted_at: null }, "2026-10-02T00:00:00Z");
  const [noAudit] = await db.insert(artifactItems).values(item()).returning();
  // Already set (made after the column): kept.
  const own = randomUUID();
  const [kept] = await db.insert(artifactItems).values(item({ originalHomeChannelId: own })).returning();
  await audit(kept!.id, "home_changed", { home_kind: "conversation", home_channel_id: first }, "2026-10-01T00:00:00Z");

  await db.execute(sql.raw(backfillStatementOf("artifact_original_home")));
  const originalOf = async (id: string) => (await db.select({ original: artifactItems.originalHomeChannelId }).from(artifactItems).where(eq(artifactItems.id, id)))[0]!.original;
  assert.equal(await originalOf(inConversation!.id), here.id, "in a conversation now: that one");
  assert.equal(await originalOf(widened!.id), first, "moved out of conversations: the earliest one recorded");
  assert.equal(await originalOf(serverMade!.id), null, "never in a conversation");
  assert.equal(await originalOf(noAudit!.id), null, "no move recorded");
  assert.equal(await originalOf(kept!.id), own, "already set");
});

test("version_texts: one row per version, going with the version and with the item; its limits loose but held; no row without a version", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const makeItem = async () => {
    const id = newId("pt");
    await db.insert(artifactItems).values({ id, serverId, urlKey: id, name: id, title: id, homeKind: "public", createdByType: "user", createdById: owner.id });
    return id;
  };
  const makeVersion = async (itemId: string, number: number) => {
    const [row] = await db.insert(artifactVersions).values({
      id: newId("v"), itemId, number, entry: "index.md", fileCount: 1, sizeBytes: 10,
      publishDigest: "digest", status: "published", publisherType: "user", publisherId: owner.id,
    }).returning();
    return row!.id;
  };
  const text = (versionId: string, values: Partial<typeof artifactVersionTexts.$inferInsert> = {}) =>
    ({ versionId, extractor: 1, kind: "markdown", description: "d", body: "b", truncated: false, ...values });
  const rowsOf = async (...versionIds: string[]) => (await db.select({ versionId: artifactVersionTexts.versionId }).from(artifactVersionTexts)).filter((row) => versionIds.includes(row.versionId)).length;

  const itemId = await makeItem();
  const [v1, v2] = [await makeVersion(itemId, 1), await makeVersion(itemId, 2)];
  await db.insert(artifactVersionTexts).values([text(v1), text(v2)]);
  await assert.rejects(db.insert(artifactVersionTexts).values(text(v1)), violates("version_texts_pkey"), "one per version");
  await assert.rejects(db.insert(artifactVersionTexts).values(text(newId("v"))), violates("version_texts_version_id_versions_id_fk"));
  // Loose limits: a description of 1000 characters and a body of 256 KiB fit; more doesn't.
  const v3 = await makeVersion(itemId, 3);
  await db.insert(artifactVersionTexts).values(text(v3, { description: "é".repeat(1000), body: "x".repeat(262144) }));
  await db.delete(artifactVersionTexts).where(eq(artifactVersionTexts.versionId, v3));
  await assert.rejects(db.insert(artifactVersionTexts).values(text(v3, { description: "x".repeat(1001) })), violates("version_texts_description_length"));
  // Bytes, not characters: 131073 two-byte characters are over 256 KiB.
  await assert.rejects(db.insert(artifactVersionTexts).values(text(v3, { body: "é".repeat(131073) })), violates("version_texts_body_length"));
  await assert.rejects(db.insert(artifactVersionTexts).values(text(v3, { kind: null as never })), violates("kind"));

  // A version deleted takes its row, the other version's stays; the item deleted takes the rest.
  await db.delete(artifactVersions).where(eq(artifactVersions.id, v1));
  assert.deepEqual([await rowsOf(v1), await rowsOf(v2)], [0, 1]);
  await db.delete(artifactItems).where(eq(artifactItems.id, itemId));
  assert.equal(await rowsOf(v2), 0);
});

test("version_checks: one per version, its states' columns held together, and gone with its version, its item and its server", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const makeItem = async (serverId: string) => {
    const id = newId("pt");
    await db.insert(artifactItems).values({ id, serverId: asServerId(serverId), urlKey: id, name: id, title: id, homeKind: "server", createdByType: "user", createdById: owner.id });
    return id;
  };
  const makeVersion = async (itemId: string, number: number) => {
    const [row] = await db.insert(artifactVersions).values({
      id: newId("v"), itemId, number, entry: "index.html", fileCount: 1, sizeBytes: 10,
      publishDigest: "digest", status: "published", publisherType: "user", publisherId: owner.id,
    }).returning();
    return row!.id;
  };
  const finished = new Date();
  const findings = { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null };
  const check = (versionId: string, values: Partial<typeof artifactVersionChecks.$inferInsert> = {}) => ({ versionId, ...values });
  const checksOf = async (...versionIds: string[]) => (await db.select({ versionId: artifactVersionChecks.versionId }).from(artifactVersionChecks)).filter((row) => versionIds.includes(row.versionId)).length;

  const server = await seed.server({ owner });
  const itemId = await makeItem(server.id);
  const [v1, v2, v3] = [await makeVersion(itemId, 1), await makeVersion(itemId, 2), await makeVersion(itemId, 3)];

  // Pending by default, with nothing else; one per version; only of a version.
  const [pending] = await db.insert(artifactVersionChecks).values(check(v1)).returning();
  assert.equal(pending!.status, "pending");
  assert.deepEqual([pending!.skipReason, pending!.desktopFileId, pending!.phoneFileId, pending!.findings, pending!.finishedAt], [null, null, null, null, null]);
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v1)), violates("idx_version_checks_version"), "one per version");
  await assert.rejects(db.insert(artifactVersionChecks).values(check(newId("v"))), violates("version_checks_version_id_versions_id_fk"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "queued" as never, finishedAt: finished })), violates("version_checks_status"));

  // Skipped exactly with a reason, and finished from the start; finished only when done, failed or skipped.
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "skipped", finishedAt: finished })), violates("version_checks_skip_reason"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { skipReason: "unchanged" })), violates("version_checks_skip_reason"), "a reason on a pending check");
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "skipped", skipReason: "tired" as never, finishedAt: finished })), violates("version_checks_skip_reason"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "skipped", skipReason: "unchanged" })), violates("version_checks_finished"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "running", finishedAt: finished })), violates("version_checks_finished"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "done" })), violates("version_checks_finished"));
  // An error class only on a failed check; findings and screenshots (core object file ids) only on a done one.
  const fileId = asObjectFileId(randomUUID());
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "done", finishedAt: finished, errorClass: "Timeout" })), violates("version_checks_error_class"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "failed", finishedAt: finished, findings })), violates("version_checks_findings"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "failed", finishedAt: finished, desktopFileId: fileId })), violates("version_checks_desktop_file"));
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "running", phoneFileId: fileId })), violates("version_checks_phone_file"));
  const tooMuch = { ...findings, blockedResources: ["x".repeat(65536)] };
  await assert.rejects(db.insert(artifactVersionChecks).values(check(v2, { status: "done", finishedAt: finished, findings: tooMuch })), violates("version_checks_findings"));
  await db.insert(artifactVersionChecks).values([
    check(v2, { status: "done", finishedAt: finished, findings, desktopFileId: fileId, phoneFileId: asObjectFileId(randomUUID()) }),
    check(v3, { status: "failed", finishedAt: finished, errorClass: "Timeout" }),
  ]);
  // A done check whose screenshots were cleared keeps its findings.
  await db.update(artifactVersionChecks).set({ desktopFileId: null, phoneFileId: null }).where(eq(artifactVersionChecks.versionId, v2));

  // A version deleted takes its check; the item deleted takes the rest.
  await db.delete(artifactVersions).where(eq(artifactVersions.id, v1));
  assert.deepEqual([await checksOf(v1), await checksOf(v2, v3)], [0, 2]);
  await db.delete(artifactItems).where(eq(artifactItems.id, itemId));
  assert.equal(await checksOf(v2, v3), 0);

  // The server deleted (hard: servers -> items -> versions -> version_checks, each ON DELETE CASCADE) takes its checks.
  const doomed = await seed.server({ owner });
  const doomedItem = await makeItem(doomed.id);
  const doomedVersion = await makeVersion(doomedItem, 1);
  await db.insert(artifactVersionChecks).values(check(doomedVersion, { status: "running" }));
  await db.delete(servers).where(eq(servers.id, doomed.id));
  assert.equal(await checksOf(doomedVersion), 0);
});
