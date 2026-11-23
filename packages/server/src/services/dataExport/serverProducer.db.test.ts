// The server export's producer (serverProducer.ts, #triage:#512 design §5,
// §7) run through the real runner into in-memory storage, and the zip read
// back: only public channels, their threads and task conversations (never a
// private channel, DM or joint); a channel made private since the request,
// or during the run, left out; the free plan's 30 days, a paid plan's all,
// a closed server's full history; users.json with id, display name and type
// only; retracted messages as placeholders; files on request; authorize
// refusing a requester who is no longer an owner; the other owners told.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { asDataExportId, asServerId } from "@botiverse/raft-shared";
import type { ServerDataExportScope } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { attachmentObjects, attachments, channelHumans, channels, dataExports, jointChannelServers, messageMentions, messages, notificationOutbox, serverMembers, servers, tasks, users } from "../../db/schema";
import { MemoryExportStorage, setDataExportFlag, zipEntry, zipEntryNames } from "../../test/dataExportFixture";
import { dbTest as test } from "../../test/integration/dbTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { getOrCreateThreadForChannel } from "../channelService";
import { createMessage } from "../messageService";
import { __setEmailDeliveryObserverForTests } from "../emailService";
import type { EmailDelivery } from "../emailService";
import { __setStorageForTests, resetStorageForTests } from "../storageService";
import { createDataExport } from "./jobs";
import { notifyDataExportOutcome } from "./notifications";
import { DataExportProducerRegistry } from "./producer";
import { dataExportTaskDefinition, generateDataExport } from "./runner";
import { createServerDataExportProducer, SERVER_EXPORT_RULES, serverExportSummary } from "./serverProducer";
import type { ServerProducerDeps } from "./serverProducer";

const DAY = 24 * 60 * 60 * 1000;
let storage: MemoryExportStorage;
beforeEach(() => {
  storage = new MemoryExportStorage();
  __setStorageForTests(storage);
});
afterEach(() => resetStorageForTests());

const quiet = async () => undefined;
const scopeOf = (scope: Partial<ServerDataExportScope> = {}): ServerDataExportScope => ({ includeFiles: false, fullHistoryAfterClose: false, ...scope });

async function queue(requesterUserId: string, serverId: string, scope: ServerDataExportScope, at = new Date()) {
  await setDataExportFlag(true);
  // One server export per server per 24 hours: a test asking again starts from no rows.
  await getDb().delete(dataExports).where(eq(dataExports.serverId, serverId));
  const created = await createDataExport({ kind: "server", requesterUserId, requesterSessionFamilyId: randomUUID(), serverId, scope, now: at, taskSpec: dataExportTaskDefinition });
  assert.ok(created.ok);
  return created.row;
}

/** Ask for an export and run it to the end; the archive's entries, every volume's. */
async function exportOf(requesterUserId: string, serverId: string, scope: ServerDataExportScope, deps: ServerProducerDeps & { at?: Date; between?: () => Promise<void>; afterFirstBatch?: () => Promise<void>; realNotify?: boolean } = {}) {
  const row = await queue(requesterUserId, serverId, scope, deps.at);
  const producer = createServerDataExportProducer(deps);
  let batches = 0;
  const producers = new DataExportProducerRegistry().register({
    ...producer,
    nextBatch: async (job, cursor) => {
      const batch = await producer.nextBatch(job, cursor);
      if ((batches += 1) === 1) await deps.afterFirstBatch?.();
      return batch;
    },
  });
  await deps.between?.();
  await generateDataExport(row.id, { extendLease: async () => true }, { producers, ...(deps.realNotify ? {} : { notify: quiet }) });
  return archiveOf(row.id);
}

async function archiveOf(exportId: string) {
  const [row] = await getDb().select().from(dataExports).where(eq(dataExports.id, exportId));
  assert.equal(row!.status, "ready", `export ${row!.status} ${row!.errorCode}`);
  const entries = new Map<string, Buffer>();
  for (const volume of row!.volumes) {
    const zip = storage.objects.get(volume.key)!;
    for (const name of zipEntryNames(zip)) {
      assert.ok(!entries.has(name), `${name} written once`);
      entries.set(name, zipEntry(zip, name));
    }
  }
  const json = (name: string) => JSON.parse(entries.get(name)!.toString());
  const lines = () => [...entries].filter(([name]) => /^conversations\/.*\.jsonl$/.test(name))
    .flatMap(([name, bytes]) => bytes.toString().trim().split("\n").filter(Boolean).map((line) => ({ path: name, ...JSON.parse(line) })));
  return { row: row!, entries, json, lines, manifest: json("manifest.json") };
}

const contents = (lines: Array<{ content: string | null }>) => lines.map((line) => line.content).sort();

test("public channels only, with their threads and task conversations: never a private channel, a DM or a joint; users.json has id, display name and type only; retracted messages a placeholder", async ({ seed }) => {
  const owner = await seed.human({ name: "Olive" });
  const member = await seed.human({ name: "Max" });
  const server = await seed.server({ owner, members: [member] });
  const peer = await seed.server({ owner: member });
  const general = await seed.channel({ server, members: [owner, member], name: "general" });
  const archived = await seed.channel({ server, members: [owner], name: "old-news", archivedAt: new Date() });
  const secret = await seed.channel({ server, members: [owner, member], name: "secret", visibility: "private" });
  const first = await createMessage(general.id, "user", owner.id, "hello all");
  await createMessage(general.id, "user", member.id, "hi");
  await createMessage(archived.id, "user", owner.id, "in an archived public channel");
  const thread = await getOrCreateThreadForChannel(general.id, first.id, owner.id, "user");
  await createMessage(thread.id, "user", member.id, "in the thread");
  const [card] = await getDb().insert(tasks).values({ channelId: general.id, taskNumber: 9001, title: "t", status: "todo", createdByType: "user", createdById: owner.id }).returning();
  const [task] = await getDb().insert(channels).values({ serverId: server.id, name: `task-${randomUUID().slice(0, 8)}`, type: "task", taskId: card!.id, parentChannelId: general.id }).returning();
  await createMessage(task!.id, "user", owner.id, "in a task conversation");
  await createMessage(secret.id, "user", owner.id, "in a private channel the owner is in");
  const [dm] = await getDb().insert(channels).values({ serverId: server.id, name: `dm-${randomUUID()}`, type: "dm" }).returning();
  await getDb().insert(channelHumans).values([{ channelId: dm!.id, userId: owner.id }, { channelId: dm!.id, userId: member.id }]);
  await createMessage(dm!.id, "user", owner.id, "in a DM");
  const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [server.id, peer.id], createdByUserId: owner.id });
  await getDb().insert(channelHumans).values({ channelId: joint.projections[0]!.id, userId: owner.id });
  await createMessage(joint.canonical.id, "user", owner.id, "in a joint channel");
  const retracted = await createMessage(general.id, "user", member.id, "taken back");
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, retracted.id));
  await getDb().insert(messageMentions).values({ messageId: retracted.id, messageSeq: retracted.seq, serverId: server.id, channelId: general.id, targetType: "user", targetId: owner.id, handleAtSendTime: "olive" });

  const archive = await exportOf(owner.id, server.id, scopeOf());
  assert.deepEqual(contents(archive.lines()), [null, "hello all", "hi", "in a task conversation", "in an archived public channel", "in the thread"].sort());
  const placeholder = archive.lines().find((line) => line.id === retracted.id);
  assert.deepEqual([placeholder.retracted, placeholder.content, placeholder.mentions, placeholder.attachments], [true, null, [], []]);
  assert.equal(archive.lines().find((line) => line.content === "hello all").threadConversationId, thread.id);
  const month = first.createdAt.toISOString().slice(0, 7);
  assert.ok(archive.entries.has(`conversations/general-${general.id}/${month}.jsonl`));
  assert.ok(archive.entries.has(`conversations/thread-${thread.id}/${month}.jsonl`));
  assert.ok(archive.entries.has(`conversations/task-${task!.id}/${month}.jsonl`));

  const conversations = archive.json("channels.json").conversations;
  assert.deepEqual(conversations.map((c: { id: string; type: string; parentConversationId: string | null }) => [c.id, c.type, c.parentConversationId]).sort(),
    [[general.id, "channel", null], [archived.id, "channel", null], [thread.id, "thread", general.id], [task!.id, "task", general.id]].sort());
  assert.equal(conversations.find((c: { id: string }) => c.id === archived.id).archived, true);
  assert.deepEqual(archive.json("users.json").sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
    [{ id: owner.id, type: "user", displayName: "Olive" }, { id: member.id, type: "user", displayName: "Max" }].sort((a, b) => a.id.localeCompare(b.id)));
  const everything = [...archive.entries.values()].map((bytes) => bytes.toString()).join("\n");
  assert.ok(!everything.includes(owner.email) && !everything.includes(member.email), "no email anywhere");
  assert.ok(!everything.includes(secret.id) && !everything.includes(dm!.id) && !everything.includes(joint.projections[0]!.id));
  assert.deepEqual(archive.manifest.rules, JSON.parse(JSON.stringify(SERVER_EXPORT_RULES)));
  assert.equal(archive.manifest.counts.messages, 6);
  assert.ok(archive.manifest.historyFrom, "the free plan's window is named");
});

test("visibility as of every batch: a channel made private before the run, or during it, is left out from then on", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const before = await seed.channel({ server, members: [owner], name: "a-before" });
  const during = await seed.channel({ server, members: [owner], name: "b-during" });
  const stays = await seed.channel({ server, members: [owner], name: "c-stays" });
  const [first, second, third] = [before, during, stays].sort((a, b) => a.id.localeCompare(b.id));
  // Walked in id order, one conversation a batch: the second is made private after the first batch.
  await createMessage(first!.id, "user", owner.id, "first");
  await createMessage(second!.id, "user", owner.id, "second");
  await createMessage(third!.id, "user", owner.id, "third");
  const makePrivate = (id: string) => getDb().update(channels).set({ type: "private" }).where(eq(channels.id, id));

  const archive = await exportOf(owner.id, server.id, scopeOf(), {
    conversationsPerBatch: 1,
    between: () => makePrivate(third!.id).then(() => undefined),
    afterFirstBatch: () => makePrivate(second!.id).then(() => undefined),
  });
  assert.deepEqual(contents(archive.lines()), ["first"]);
});

test("history: the free plan's last 30 days, a paid plan's all of it, and a closed server's full history with fullHistoryAfterClose", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const old = await createMessage(channel.id, "user", owner.id, "40 days ago");
  await getDb().update(messages).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(eq(messages.id, old.id));
  await createMessage(channel.id, "user", owner.id, "today");

  const free = await exportOf(owner.id, server.id, scopeOf());
  assert.deepEqual(contents(free.lines()), ["today"]);
  assert.equal(new Date(free.manifest.historyFrom).getTime() < Date.now() - 29 * DAY, true);
  const freeSummary = await serverExportSummary({ serverId: asServerId(server.id), requesterUserId: owner.id, fullHistory: false, now: new Date() });
  assert.deepEqual([freeSummary.publicChannels >= 1, freeSummary.messages, freeSummary.messagesCapped], [true, 1, false]);

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  const paid = await exportOf(owner.id, server.id, scopeOf());
  assert.deepEqual(contents(paid.lines()), ["40 days ago", "today"]);
  assert.equal(paid.manifest.historyFrom, null);

  await getDb().update(servers).set({ plan: "free", deletedAt: new Date() }).where(eq(servers.id, server.id));
  const closed = await exportOf(owner.id, server.id, scopeOf({ fullHistoryAfterClose: true }));
  assert.deepEqual(contents(closed.lines()), ["40 days ago", "today"]);
  assert.equal((await serverExportSummary({ serverId: asServerId(server.id), requesterUserId: owner.id, fullHistory: true, now: new Date() })).messages, 2);
});

test("files: metadata always; with includeFiles every live file of the exported messages (anyone's), never a revoked one or a retracted message's; one storage no longer has skipped and listed", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [owner, member] });
  const secret = await seed.channel({ server, members: [owner], visibility: "private" });
  const upload = async (author: { id: string }, filename: string, options: { stored?: boolean; revoked?: boolean; retracted?: boolean; in?: { id: string } } = {}) => {
    const where = options.in ?? channel;
    const message = await createMessage(where.id, "user", author.id, `with ${filename}`);
    if (options.retracted) await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id));
    const storageKey = `attachments/${randomUUID()}`;
    if (options.stored !== false) storage.objects.set(storageKey, Buffer.from(`bytes of ${filename}`));
    const [object] = await getDb().insert(attachmentObjects).values({ originServerId: server.id, uploaderId: author.id, uploaderType: "user", storageKey, mimeType: "text/plain", sizeBytes: 10 }).returning();
    const [row] = await getDb().insert(attachments).values({
      objectId: object!.id, messageId: message.id, channelId: where.id, uploaderId: author.id, uploaderType: "user", filename,
      ...(options.revoked ? { revokedAt: new Date(), revokedById: author.id, revokedByType: "user" as const } : {}),
    }).returning();
    return row!;
  };
  const mine = await upload(owner, "mine.txt");
  const theirs = await upload(member, "theirs.txt");
  const lost = await upload(member, "lost.txt", { stored: false });
  await upload(owner, "revoked.txt", { revoked: true });
  await upload(owner, "retracted.txt", { retracted: true });
  await upload(owner, "private.txt", { in: secret });

  const without = await exportOf(owner.id, server.id, scopeOf());
  assert.ok(![...without.entries.keys()].some((name) => name.startsWith("files/")));
  assert.deepEqual(without.lines().find((line) => line.content === "with theirs.txt").attachments.map((a: { id: string; file: string | null }) => [a.id, a.file]), [[theirs.id, null]], "metadata only");

  const withFiles = await exportOf(owner.id, server.id, scopeOf({ includeFiles: true }));
  assert.deepEqual([...withFiles.entries.keys()].filter((name) => name.startsWith("files/")).sort(), [`files/${mine.id}-mine.txt`, `files/${theirs.id}-theirs.txt`].sort());
  assert.equal(withFiles.entries.get(`files/${theirs.id}-theirs.txt`)!.toString(), "bytes of theirs.txt");
  assert.deepEqual(withFiles.manifest.missingFiles, [`files/${lost.id}-lost.txt`]);
  assert.equal(withFiles.manifest.counts.files, 2);
  assert.equal(withFiles.lines().find((line) => line.content === "with mine.txt").attachments[0].file, `files/${mine.id}-mine.txt`);
  const summary = await serverExportSummary({ serverId: asServerId(server.id), requesterUserId: owner.id, fullHistory: false, now: new Date() });
  assert.deepEqual([summary.files, summary.fileBytes], [3, 30], "the live files of public messages, the lost one counted (storage is not read)");
});

test("authorize: an owner only, with a live account; demoted or retired, the create, every batch and every download are refused, and a running export fails not_authorized", async ({ seed }) => {
  const owner = await seed.human();
  const coOwner = await seed.human();
  const server = await seed.server({ owner, members: [coOwner] });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, coOwner.id)));
  await createMessage((await seed.channel({ server, members: [owner] })).id, "user", owner.id, "something");
  const producer = createServerDataExportProducer();
  const jobOf = (userId: string) => ({ id: asDataExportId(randomUUID()), kind: "server" as const, requesterUserId: userId, serverId: asServerId(server.id), scope: scopeOf(), createdAt: new Date() });
  assert.deepEqual(await producer.authorize(jobOf(owner.id), "create"), { ok: true });

  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  for (const stage of ["create", "batch", "download"] as const) {
    const refused = await producer.authorize(jobOf(owner.id), stage);
    assert.deepEqual(refused.ok ? null : refused.code, "data_export_owner_only", `an admin is refused at ${stage}`);
  }
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, coOwner.id));
  const retired = await producer.authorize(jobOf(coOwner.id), "batch");
  assert.deepEqual(retired.ok ? null : retired.code, "data_export_account_inactive");

  // Asked as an owner, demoted before the run: the export fails at its first batch, nothing stored.
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  const row = await queue(owner.id, server.id, scopeOf());
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
  await generateDataExport(row.id, { extendLease: async () => true }, { producers: new DataExportProducerRegistry().register(producer), notify: quiet });
  const [failed] = await getDb().select().from(dataExports).where(eq(dataExports.id, row.id));
  assert.deepEqual([failed!.status, failed!.errorCode, failed!.volumes], ["failed", "not_authorized", []]);
});

test("ready: the server's other owners get one in-app notice each, naming who exported it, however often it is told; the requester gets their own and the only email, a member nothing", async ({ seed }) => {
  const owner = await seed.human({ name: "Olive" });
  const coOwner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [coOwner, member], name: "Acme" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, coOwner.id)));
  await createMessage((await seed.channel({ server, members: [owner] })).id, "user", owner.id, "something");

  const emails: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => emails.push(delivery));
  const archive = await exportOf(owner.id, server.id, scopeOf(), { realNotify: true });
  __setEmailDeliveryObserverForTests(null);
  // Email to the requester only, its link naming the server so the web opens that server's settings.
  assert.deepEqual(emails.map((email) => email.to), [owner.email]);
  assert.match(emails[0]!.text ?? "", new RegExp(`data_export=${archive.row.id}&data_export_server=${server.id}`));
  const notices = (userId: string) => getDb().select().from(notificationOutbox).where(and(eq(notificationOutbox.receiverId, userId), eq(notificationOutbox.category, "system_notice")));
  const coOwners = await notices(coOwner.id);
  assert.equal(coOwners.length, 1);
  assert.match(JSON.stringify(coOwners[0]!.payload), /Olive exported Acme/);
  assert.equal((await notices(owner.id)).length, 1);
  assert.match(JSON.stringify((await notices(owner.id))[0]!.payload), /The export of Acme is ready/);
  assert.equal((await notices(member.id)).length, 0);
  // Told again (a run that repeats after a crash, say): keyed by export, nobody is told twice.
  await notifyDataExportOutcome(archive.row, "ready", new Date());
  assert.equal((await notices(coOwner.id)).length, 1);
  assert.equal((await notices(owner.id)).length, 1);
});

test("stable across batches: a channel renamed during the run keeps its first folder and name (lines and channels.json); one that leaves the view during the run is `partial`", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const renamed = await seed.channel({ server, members: [owner], name: "before" });
  for (const n of [1, 2, 3]) await createMessage(renamed.id, "user", owner.id, `renamed ${n}`);
  const archive = await exportOf(owner.id, server.id, scopeOf(), {
    messageBatch: 1,
    afterFirstBatch: async () => { await getDb().update(channels).set({ name: "after" }).where(eq(channels.id, renamed.id)); },
  });
  const paths = new Set(archive.lines().map((line) => line.path.split("/").slice(0, 2).join("/")));
  assert.deepEqual([...paths], [`conversations/before-${renamed.id}`]);
  const entry = archive.json("channels.json").conversations.find((c: { id: string }) => c.id === renamed.id);
  assert.deepEqual([entry.name, entry.path, entry.exported], ["before", `conversations/before-${renamed.id}/`, "whole"]);

  const leaving = await seed.channel({ server, members: [owner], name: "leaving" });
  for (const n of [1, 2]) await createMessage(leaving.id, "user", owner.id, `leaving ${n}`);
  await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, renamed.id));
  const partial = await exportOf(owner.id, server.id, scopeOf(), {
    messageBatch: 1,
    afterFirstBatch: async () => { await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, leaving.id)); },
  });
  assert.deepEqual(contents(partial.lines()), ["leaving 1"]);
  assert.deepEqual(partial.json("channels.json").conversations.map((c: { id: string; exported: string }) => [c.id, c.exported]), [[leaving.id, "partial"]]);
});

test("files: each conversation's files right after its lines; a file a written line named but retracted or revoked since, or whose channel left the view, is listed in missingFiles, never written", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const attach = async (filename: string, where = channel) => {
    const message = await createMessage(where.id, "user", owner.id, `with ${filename}`);
    const storageKey = `attachments/${randomUUID()}`;
    storage.objects.set(storageKey, Buffer.from(filename));
    const [object] = await getDb().insert(attachmentObjects).values({ originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey, mimeType: "text/plain", sizeBytes: 1 }).returning();
    const [row] = await getDb().insert(attachments).values({ objectId: object!.id, messageId: message.id, channelId: where.id, uploaderId: owner.id, uploaderType: "user", filename }).returning();
    return { message, attachment: row! };
  };
  const kept = await attach("kept.txt");
  const revoked = await attach("revoked.txt");
  const retracted = await attach("retracted.txt");
  const archive = await exportOf(owner.id, server.id, scopeOf({ includeFiles: true }), {
    // The first batch writes the lines; then, before the files are written, one file is revoked and one message retracted.
    afterFirstBatch: async () => {
      await getDb().update(attachments).set({ revokedAt: new Date(), revokedById: owner.id, revokedByType: "user" }).where(eq(attachments.id, revoked.attachment.id));
      await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, retracted.message.id));
    },
  });
  const named = archive.lines().flatMap((line) => line.attachments.map((a: { file: string }) => a.file)).sort();
  assert.equal(named.length, 3, "all three were live when their lines were written");
  assert.deepEqual([...archive.entries.keys()].filter((name) => name.startsWith("files/")), [`files/${kept.attachment.id}-kept.txt`]);
  assert.deepEqual([...archive.manifest.missingFiles].sort(), named.filter((path: string) => !path.includes(kept.attachment.id)));

  // A channel that leaves the view between its lines and its files: its files are listed, not written.
  await getDb().delete(dataExports).where(eq(dataExports.serverId, server.id));
  const other = await seed.channel({ server, members: [owner] });
  const there = await attach("there.txt", other);
  await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, channel.id));
  const left = await exportOf(owner.id, server.id, scopeOf({ includeFiles: true }), {
    afterFirstBatch: async () => { await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, other.id)); },
  });
  assert.deepEqual(left.manifest.missingFiles, [`files/${there.attachment.id}-there.txt`]);
  assert.ok(![...left.entries.keys()].some((name) => name.startsWith("files/")));
});

test("a public channel with an active joint projection (being converted into a shared channel, still type channel) is not exported, nor its threads; one whose projection was disconnected follows the normal rule", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const peer = await seed.server({ owner });
  const converting = await seed.channel({ server, members: [owner], name: "converting" });
  const disconnected = await seed.channel({ server, members: [owner], name: "disconnected" });
  const plain = await seed.channel({ server, members: [owner], name: "plain" });
  const root = await createMessage(converting.id, "user", owner.id, "in the converting channel");
  const thread = await getOrCreateThreadForChannel(converting.id, root.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "in its thread");
  await createMessage(disconnected.id, "user", owner.id, "in the disconnected one");
  await createMessage(plain.id, "user", owner.id, "in the plain one");
  // A projection row on the local channel, as a conversion writes before its cutover (only the peer's projection is a joint channel).
  for (const [channel, status] of [[converting, "active"], [disconnected, "disconnected"]] as const) {
    const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [peer.id], createdByUserId: owner.id });
    await getDb().insert(jointChannelServers).values({ jointChannelId: joint.jointChannelId, serverId: server.id, localChannelId: channel.id, status, joinedByUserId: owner.id, ...(status === "disconnected" ? { disconnectedAt: new Date() } : {}) });
  }

  const archive = await exportOf(owner.id, server.id, scopeOf());
  assert.deepEqual(contents(archive.lines()), ["in the disconnected one", "in the plain one"]);
  const listed = archive.json("channels.json").conversations.map((c: { id: string }) => c.id);
  assert.ok(!listed.includes(converting.id) && !listed.includes(thread.id));
  const summary = await serverExportSummary({ serverId: asServerId(server.id), requesterUserId: owner.id, fullHistory: false, now: new Date() });
  assert.equal(summary.messages, 2, "the summary leaves it out too");
});
