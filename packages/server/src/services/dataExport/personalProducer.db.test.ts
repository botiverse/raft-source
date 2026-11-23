// The personal export's producer (personalProducer.ts, #triage:#512 design
// §4, §7) run through the real runner into in-memory storage, and the zip
// read back: only the requester's own messages; others' only as context
// where allowed, inside the plan's window; a guest's only channel; a server
// left since asking skipped and named in the manifest; a joint channel's own
// messages; files on request, a missing one skipped and listed; and every
// message exactly once when batches, volumes and runs are cut.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import type { PersonalDataExportScope } from "@botiverse/raft-shared";

import { getDb } from "../../db/index";
import { agents, attachmentObjects, attachments, channelAgents, channelHumans, channels, dataExports, messageMentions, messages, serverMembers } from "../../db/schema";
import { MemoryExportStorage, setDataExportFlag, zipEntry, zipEntryNames } from "../../test/dataExportFixture";
import { dbTest as test } from "../../test/integration/dbTest";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { addHuman, createChannel, getOrCreateThreadForChannel } from "../channelService";
import { createMessage } from "../messageService";
import { __setStorageForTests, resetStorageForTests } from "../storageService";
import { createDataExport } from "./jobs";
import { createPersonalDataExportProducer, PERSONAL_EXPORT_RULES } from "./personalProducer";
import { setMemberContextExportEnabled } from "./serverSettings";
import type { PersonalProducerDeps } from "./personalProducer";
import { DataExportProducerRegistry } from "./producer";
import { dataExportTaskDefinition, generateDataExport } from "./runner";

const DAY = 24 * 60 * 60 * 1000;
let storage: MemoryExportStorage;
beforeEach(() => {
  storage = new MemoryExportStorage();
  __setStorageForTests(storage);
});
afterEach(() => resetStorageForTests());

const quiet = async () => undefined;
const scopeOf = (scope: Partial<PersonalDataExportScope> = {}): PersonalDataExportScope => ({ serverIds: "all", includeContext: false, includeFiles: false, ...scope });

/** Ask for an export as of `at` (default now) and run it to the end; the archive's entries, every volume's. */
async function exportOf(requesterUserId: string, scope: PersonalDataExportScope, deps: PersonalProducerDeps & { volumeBytes?: number; at?: Date; between?: () => Promise<void> } = {}) {
  await setDataExportFlag(true);
  const created = await createDataExport({
    kind: "personal",
    requesterUserId,
    requesterSessionFamilyId: randomUUID(),
    serverId: null,
    scope,
    now: deps.at ?? new Date(),
    taskSpec: dataExportTaskDefinition,
  });
  assert.ok(created.ok);
  const producer = createPersonalDataExportProducer(deps);
  const producers = new DataExportProducerRegistry().register(producer);
  await deps.between?.();
  await generateDataExport(created.row.id, { extendLease: async () => true }, { producers, notify: quiet, ...(deps.volumeBytes ? { volumeBytes: deps.volumeBytes } : {}) });
  return archiveOf(created.row.id);
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
  /** Every message line of the archive, `.partN` continuations included. */
  const lines = () => [...entries].filter(([name]) => /\/conversations\/.*\.jsonl$/.test(name))
    .flatMap(([name, bytes]) => bytes.toString().trim().split("\n").filter(Boolean).map((line) => ({ path: name, ...JSON.parse(line) })));
  return { row: row!, entries, json, lines, manifest: json("manifest.json") };
}

const dirOf = (server: { slug: string; id: string }) => `servers/${server.slug}-${server.id}`;
const contents = (lines: Array<{ content: string }>) => lines.map((line) => line.content).sort();

test("only the requester's own messages, in the conversations they see, up to when they asked: threads their own conversations; account.json, channels.json and users.json; retracted ones flagged", async ({ seed }) => {
  const me = await seed.human({ name: "me" });
  const other = await seed.human();
  const server = await seed.server({ owner: me, members: [other] });
  const general = await seed.channel({ server, members: [me, other], name: "general" });
  const secret = await seed.channel({ server, members: [other], name: "secret", visibility: "private" });
  const mine = await createMessage(general.id, "user", me.id, "mine in general");
  await createMessage(general.id, "user", other.id, "theirs in general");
  // The requester's own message in a private channel they are not in (written before they left, say): not visible, not exported (D1).
  await createMessage(secret.id, "user", me.id, "mine in secret");
  const thread = await getOrCreateThreadForChannel(general.id, mine.id, me.id, "user");
  await createMessage(thread.id, "user", me.id, "mine in the thread");
  await createMessage(thread.id, "user", other.id, "theirs in the thread");
  const retracted = await createMessage(general.id, "user", me.id, "the text before it was taken back");
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, retracted.id));
  const mentions = (message: { id: string; seq: number }) => getDb().insert(messageMentions).values({ messageId: message.id, messageSeq: message.seq, serverId: server.id, channelId: general.id, targetType: "user", targetId: other.id, handleAtSendTime: "other" });
  await mentions(mine);
  await mentions(retracted);
  const at = new Date(Date.now() + 1000);
  const late = await createMessage(general.id, "user", me.id, "after asking");
  await getDb().update(messages).set({ createdAt: new Date(at.getTime() + 60_000) }).where(eq(messages.id, late.id));

  const archive = await exportOf(me.id, scopeOf(), { at });
  const all = archive.lines();
  assert.deepEqual(all.map((line) => line.id).sort(), [mine.id, retracted.id, all.find((line) => line.content === "mine in the thread").id].sort());
  assert.ok(all.every((line) => line.mine && line.authorId === me.id && line.authorType === "user"));
  const placeholder = all.find((line) => line.id === retracted.id);
  assert.equal(placeholder.retracted, true);
  assert.equal(placeholder.content, null, "a retracted message keeps only its placeholder: retraction may be a moderator's, and the stored text may survive it");
  assert.deepEqual(placeholder.mentions, [], "a retracted message names no one");
  assert.deepEqual(all.find((line) => line.content === "mine in general").mentions, [{ type: "user", id: other.id, handle: "other" }]);
  const month = mine.createdAt.toISOString().slice(0, 7);
  const dir = dirOf(server);
  assert.ok(archive.entries.has(`${dir}/conversations/general-${general.id}/${month}.jsonl`));
  assert.ok(archive.entries.has(`${dir}/conversations/thread-${thread.id}/${month}.jsonl`), "a thread is its own conversation");
  assert.equal(all.find((line) => line.content === "mine in general").threadConversationId, thread.id, "the parent names its thread");

  const conversations = archive.json(`${dir}/channels.json`).conversations;
  assert.deepEqual(conversations.map((c: { id: string; type: string; parentConversationId: string | null }) => [c.id, c.type, c.parentConversationId]).sort(),
    [[general.id, "channel", null], [thread.id, "thread", general.id]].sort());
  assert.deepEqual(archive.json(`${dir}/users.json`), [{ id: me.id, type: "user", handle: "me", displayName: "me" }]);

  const account = archive.json("account.json");
  assert.equal(account.id, me.id);
  assert.equal(account.email, me.email);
  assert.equal(account.signIn.password, false);
  assert.ok(!JSON.stringify(account).includes(me.passwordHash), "never a secret");
  assert.deepEqual(account.memberships.map((m: { serverId: string; role: string }) => [m.serverId, m.role]), [[server.id, "owner"]]);
  assert.ok(account.memberships[0].channels.some((c: { id: string }) => c.id === general.id));
  assert.ok(!account.memberships[0].channels.some((c: { id: string }) => c.id === secret.id));
  assert.deepEqual(archive.manifest.servers, [{ serverId: server.id, status: "exported", contextIncluded: false }]);
  assert.deepEqual(archive.manifest.rules, JSON.parse(JSON.stringify(PERSONAL_EXPORT_RULES)), "the manifest says what was exported");
  assert.deepEqual(archive.manifest.counts, { messages: 3, contextMessages: 0 });
  assert.deepEqual(archive.manifest.missingFiles, []);
});

test("context: refused while no server allows it; where allowed, others' messages inside the free plan's 30 days and not retracted, while the requester's own older ones stay; a server that doesn't allow it gets only the requester's", async ({ seed }) => {
  const me = await seed.human();
  const other = await seed.human();
  const open = await seed.server({ owner: other, members: [me] });
  const closed = await seed.server({ owner: other, members: [me] });
  const here = await seed.channel({ server: open, members: [me, other] });
  const there = await seed.channel({ server: closed, members: [me, other] });
  const oldMine = await createMessage(here.id, "user", me.id, "my old one");
  const oldTheirs = await createMessage(here.id, "user", other.id, "their old one");
  await getDb().update(messages).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(sql`${messages.id} IN (${oldMine.id}, ${oldTheirs.id})`);
  await createMessage(here.id, "user", other.id, "their recent one");
  const gone = await createMessage(here.id, "user", other.id, "their retracted one");
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, gone.id));
  await createMessage(there.id, "user", other.id, "theirs where context is off");
  await createMessage(there.id, "user", me.id, "mine where context is off");

  // By default no server allows context (the owner's switch is off), so asking for it is refused.
  const byDefault = createPersonalDataExportProducer();
  const refused = await byDefault.validateScope({ requesterUserId: me.id, serverId: null, scope: scopeOf({ includeContext: true }), now: new Date() });
  assert.deepEqual(refused.ok ? null : [refused.status, refused.code], [400, "data_export_context_not_allowed"]);

  const allowsOpen = async (ids: readonly string[]) => new Set(ids.filter((id) => id === open.id));
  assert.equal((await createPersonalDataExportProducer({ contextAllowedServerIds: allowsOpen }).validateScope({ requesterUserId: me.id, serverId: null, scope: scopeOf({ includeContext: true }), now: new Date() })).ok, true);
  const archive = await exportOf(me.id, scopeOf({ includeContext: true }), { contextAllowedServerIds: allowsOpen });
  const byServer = (server: { slug: string; id: string }) => contents(archive.lines().filter((line) => line.path.startsWith(dirOf(server))));
  assert.deepEqual(byServer(open), ["my old one", "their recent one"]);
  assert.deepEqual(byServer(closed), ["mine where context is off"]);
  assert.equal(archive.lines().find((line) => line.content === "their recent one").mine, false);
  assert.deepEqual(archive.json(`${dirOf(open)}/users.json`).map((u: { id: string }) => u.id).sort(), [me.id, other.id].sort());
  assert.deepEqual(archive.manifest.servers.map((s: { serverId: string; contextIncluded: boolean }) => [s.serverId, s.contextIncluded]).sort(),
    [[open.id, true], [closed.id, false]].sort());
  assert.deepEqual(archive.manifest.counts, { messages: 2, contextMessages: 1 });
});

test("a guest's export holds only what the guest sees: their one channel, not their messages elsewhere in the server", async ({ seed }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner });
  const lobby = await seed.channel({ server, members: [owner] });
  const room = await createChannel(server.id, `guest-${randomUUID().slice(0, 8)}`, undefined, "private");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest", guestChannelId: room.id });
  await addHuman(room.id, guest.id);
  await createMessage(room.id, "user", guest.id, "in my room");
  // Written while the person was a full member, say: a guest no longer sees it.
  await createMessage(lobby.id, "user", guest.id, "in the lobby");

  const archive = await exportOf(guest.id, scopeOf());
  assert.deepEqual(contents(archive.lines()), ["in my room"]);
  assert.deepEqual(archive.json("account.json").memberships.map((m: { role: string }) => m.role), ["guest"]);
});

test("a server the requester left after asking is skipped and named in the manifest; the others are exported; named servers must be the requester's", async ({ seed }) => {
  const me = await seed.human();
  const other = await seed.human();
  const stay = await seed.server({ owner: me });
  const leave = await seed.server({ owner: other, members: [me] });
  const notMine = await seed.server({ owner: other });
  await createMessage((await seed.channel({ server: stay, members: [me] })).id, "user", me.id, "where I stay");
  await createMessage((await seed.channel({ server: leave, members: [me] })).id, "user", me.id, "where I left");

  const producer = createPersonalDataExportProducer();
  const named = await producer.validateScope({ requesterUserId: me.id, serverId: null, scope: scopeOf({ serverIds: [notMine.id] }), now: new Date() });
  assert.deepEqual(named.ok ? null : [named.status, named.code], [404, "data_export_server_not_found"]);

  const archive = await exportOf(me.id, scopeOf({ serverIds: [stay.id, leave.id].sort() }), {
    between: async () => { await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, leave.id), eq(serverMembers.userId, me.id))); },
  });
  assert.deepEqual(contents(archive.lines()), ["where I stay"]);
  assert.ok(![...archive.entries.keys()].some((name) => name.startsWith(dirOf(leave))));
  const outcomes = new Map(archive.manifest.servers.map((s: { serverId: string }) => [s.serverId, s]));
  assert.deepEqual(outcomes.get(leave.id), { serverId: leave.id, status: "skipped", reason: "not_a_member" });
  assert.equal((outcomes.get(stay.id) as { status: string }).status, "exported");
});

test("a joint channel: the requester's own messages, from its canonical storage, under the server they see it through", async ({ seed }) => {
  const me = await seed.human();
  const peerOwner = await seed.human();
  const home = await seed.server({ owner: me });
  const peer = await seed.server({ owner: peerOwner });
  const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [home.id, peer.id], createdByUserId: me.id });
  const local = joint.projections[0]!;
  await addHuman(local.id, me.id);
  await addHuman(joint.projections[1]!.id, peerOwner.id);
  await createMessage(joint.canonical.id, "user", me.id, "mine across servers");
  await createMessage(joint.canonical.id, "user", peerOwner.id, "the peer's");

  const archive = await exportOf(me.id, scopeOf());
  const all = archive.lines();
  assert.deepEqual(contents(all), ["mine across servers"]);
  assert.equal(all[0].conversationId, local.id, "named by the local projection, not the storage channel");
  assert.ok(all[0].path.startsWith(`${dirOf(home)}/conversations/${local.name}-${local.id}/`));
  assert.deepEqual(archive.json(`${dirOf(home)}/channels.json`).conversations.map((c: { id: string; type: string }) => [c.id, c.type]), [[local.id, "joint"]]);
});

test("files: the requester's own uploads only when asked for; never a revoked one or someone else's; one storage no longer has is skipped and listed in the manifest, the export still ready", async ({ seed }) => {
  const me = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner: me, members: [other] });
  const channel = await seed.channel({ server, members: [me, other] });
  const upload = async (author: { id: string }, filename: string, options: { stored?: boolean; revoked?: boolean; retracted?: boolean } = {}) => {
    const message = await createMessage(channel.id, "user", author.id, `with ${filename}`);
    if (options.retracted) await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id));
    const storageKey = `attachments/${randomUUID()}`;
    if (options.stored !== false) storage.objects.set(storageKey, Buffer.from(`bytes of ${filename}`));
    const [object] = await getDb().insert(attachmentObjects).values({ originServerId: server.id, uploaderId: author.id, uploaderType: "user", storageKey, mimeType: "text/plain", sizeBytes: 10 }).returning();
    const [row] = await getDb().insert(attachments).values({
      objectId: object!.id, messageId: message.id, channelId: channel.id, uploaderId: author.id, uploaderType: "user", filename,
      ...(options.revoked ? { revokedAt: new Date(), revokedById: author.id, revokedByType: "user" as const } : {}),
    }).returning();
    return row!;
  };
  const kept = await upload(me, "notes.txt");
  const missing = await upload(me, "lost.txt", { stored: false });
  await upload(me, "taken-back.txt", { revoked: true });
  await upload(other, "theirs.txt");
  await upload(me, "in-a-retracted-message.txt", { retracted: true });
  const files = `${dirOf(server)}/files`;

  const without = await exportOf(me.id, scopeOf());
  assert.ok(![...without.entries.keys()].some((name) => name.startsWith(files)));
  const notes = without.lines().find((line) => line.content === "with notes.txt");
  assert.deepEqual(notes.attachments.map((a: { id: string; file: string | null }) => [a.id, a.file]), [[kept.id, null]], "metadata only");
  assert.deepEqual(without.lines().find((line) => line.content === "with taken-back.txt").attachments, [], "a revoked file is not exported");
  assert.deepEqual(without.lines().find((line) => line.retracted).attachments, [], "a retracted message lists no files");

  await getDb().delete(dataExports).where(eq(dataExports.requesterUserId, me.id));
  const withFiles = await exportOf(me.id, scopeOf({ includeFiles: true }));
  assert.deepEqual([...withFiles.entries.keys()].filter((name) => name.startsWith(files)), [`${files}/${kept.id}-notes.txt`]);
  assert.equal(withFiles.entries.get(`${files}/${kept.id}-notes.txt`)!.toString(), "bytes of notes.txt");
  assert.deepEqual(withFiles.manifest.missingFiles, [`${files}/${missing.id}-lost.txt`]);
  assert.equal(withFiles.lines().find((line) => line.content === "with notes.txt").attachments[0].file, `${files}/${kept.id}-notes.txt`);
  assert.equal(withFiles.lines().find((line) => line.content === "with theirs.txt"), undefined, "someone else's message, no context");
  assert.equal(withFiles.manifest.counts.files, 1, "only the file written counts; the missing one is listed instead");
});

test("resume: cut into tiny batches and volumes, and a run lost mid-way, every message is written exactly once", async ({ seed }) => {
  const me = await seed.human();
  const server = await seed.server({ owner: me });
  const expected: string[] = [];
  for (const name of ["alpha", "beta"]) {
    const channel = await seed.channel({ server, members: [me], name });
    for (let i = 0; i < 7; i += 1) expected.push((await createMessage(channel.id, "user", me.id, `${name} ${i}`)).id);
  }
  await setDataExportFlag(true);
  const created = await createDataExport({ kind: "personal", requesterUserId: me.id, requesterSessionFamilyId: randomUUID(), serverId: null, scope: scopeOf(), now: new Date(), taskSpec: dataExportTaskDefinition });
  assert.ok(created.ok);
  const producers = new DataExportProducerRegistry().register(createPersonalDataExportProducer({ messageBatch: 3, conversationsPerBatch: 1 }));
  // The first run loses its lease after a few beats (another replica took over, say): it stops, nothing recorded past its last volume.
  let beats = 0;
  await generateDataExport(created.row.id, { extendLease: async () => (beats += 1) < 6 }, { producers, notify: quiet, volumeBytes: 1 });
  const [halfway] = await getDb().select().from(dataExports).where(eq(dataExports.id, created.row.id));
  assert.equal(halfway!.status, "running");
  assert.ok(halfway!.volumes.length > 0 && halfway!.volumes.length < 10, `stopped part way (${halfway!.volumes.length} volumes)`);
  await generateDataExport(created.row.id, { extendLease: async () => true }, { producers, notify: quiet, volumeBytes: 1 });

  const archive = await archiveOf(created.row.id);
  assert.ok(archive.row.volumes.length > 3);
  const ids = archive.lines().map((line) => line.id);
  assert.equal(ids.length, new Set(ids).size, "no message twice");
  assert.deepEqual(ids.sort(), expected.sort());
  assert.equal(archive.manifest.counts.messages, expected.length, "each batch counted once");
  assert.ok([...archive.entries.keys()].some((name) => /\.part\d+\.jsonl$/.test(name)), "a conversation continued across volumes");
});

test("context never reaches past what the requester sees: not a private channel or DM they aren't in, not an agent-to-agent DM, not a private channel they left (their own messages there neither, D1)", async ({ seed }) => {
  const me = await seed.human();
  const other = await seed.human();
  const third = await seed.human();
  const server = await seed.server({ owner: me, members: [other, third] });
  const general = await seed.channel({ server, members: [me, other] });
  await createMessage(general.id, "user", other.id, "theirs where I am");
  const secret = await seed.channel({ server, members: [other, third], visibility: "private" });
  await createMessage(secret.id, "user", other.id, "theirs in a private channel I'm not in");
  const [dm] = await getDb().insert(channels).values({ serverId: server.id, name: `dm-${randomUUID()}`, type: "dm" }).returning();
  await getDb().insert(channelHumans).values([{ channelId: dm!.id, userId: other.id }, { channelId: dm!.id, userId: third.id }]);
  await createMessage(dm!.id, "user", other.id, "theirs in someone else's DM");
  const [a, b] = await getDb().insert(agents).values([{ serverId: server.id, name: `a-${randomUUID().slice(0, 8)}` }, { serverId: server.id, name: `b-${randomUUID().slice(0, 8)}` }]).returning();
  const [agentDm] = await getDb().insert(channels).values({ serverId: server.id, name: `dm-${randomUUID()}`, type: "dm" }).returning();
  await getDb().insert(channelAgents).values([{ channelId: agentDm!.id, agentId: a!.id }, { channelId: agentDm!.id, agentId: b!.id }]);
  await createMessage(agentDm!.id, "agent", a!.id, "between two agents");
  const left = await seed.channel({ server, members: [me, other], visibility: "private" });
  await createMessage(left.id, "user", other.id, "theirs where I left");
  await createMessage(left.id, "user", me.id, "mine where I left");
  await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, left.id), eq(channelHumans.userId, me.id)));

  const archive = await exportOf(me.id, scopeOf({ includeContext: true }), { contextAllowedServerIds: async (ids) => new Set(ids) });
  assert.deepEqual(contents(archive.lines()), ["theirs where I am"]);
});

test("a guest asking for context gets their one channel's messages only, and account.json lists only the channels they still see", async ({ seed }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner });
  const lobby = await seed.channel({ server, members: [owner] });
  const room = await createChannel(server.id, `guest-${randomUUID().slice(0, 8)}`, undefined, "private");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest", guestChannelId: room.id });
  await addHuman(room.id, guest.id);
  await addHuman(room.id, owner.id);
  // A membership row left over from before they were a guest: still not theirs to see.
  await getDb().insert(channelHumans).values({ channelId: lobby.id, userId: guest.id });
  await createMessage(room.id, "user", owner.id, "the owner in the room");
  await createMessage(lobby.id, "user", owner.id, "the owner in the lobby");

  const archive = await exportOf(guest.id, scopeOf({ includeContext: true }), { contextAllowedServerIds: async (ids) => new Set(ids) });
  assert.deepEqual(contents(archive.lines()), ["the owner in the room"]);
  assert.deepEqual(archive.json("account.json").memberships[0].channels.map((c: { id: string }) => c.id), [room.id]);
});

test("context in a joint channel: the peer's messages inside the free plan's 30 days only, the requester's own older ones kept", async ({ seed }) => {
  const me = await seed.human();
  const peerOwner = await seed.human();
  const home = await seed.server({ owner: me });
  const peer = await seed.server({ owner: peerOwner });
  const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [home.id, peer.id], createdByUserId: me.id });
  await addHuman(joint.projections[0]!.id, me.id);
  await addHuman(joint.projections[1]!.id, peerOwner.id);
  const oldTheirs = await createMessage(joint.canonical.id, "user", peerOwner.id, "the peer's old one");
  const oldMine = await createMessage(joint.canonical.id, "user", me.id, "my old one");
  await getDb().update(messages).set({ createdAt: new Date(Date.now() - 40 * DAY) }).where(sql`${messages.id} IN (${oldTheirs.id}, ${oldMine.id})`);
  await createMessage(joint.canonical.id, "user", peerOwner.id, "the peer's recent one");

  const archive = await exportOf(me.id, scopeOf({ serverIds: [home.id], includeContext: true }), { contextAllowedServerIds: async (ids) => new Set(ids) });
  assert.deepEqual(contents(archive.lines()), ["my old one", "the peer's recent one"]);
});

test("a server left while it was being written: what was written stays, and the manifest calls it partial", async ({ seed }) => {
  const me = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner: other, members: [me] });
  const channel = await seed.channel({ server, members: [me] });
  for (const n of [1, 2, 3]) await createMessage(channel.id, "user", me.id, `mine ${n}`);
  await setDataExportFlag(true);
  const created = await createDataExport({ kind: "personal", requesterUserId: me.id, requesterSessionFamilyId: randomUUID(), serverId: null, scope: scopeOf(), now: new Date(), taskSpec: dataExportTaskDefinition });
  assert.ok(created.ok);
  const producer = createPersonalDataExportProducer({ messageBatch: 1 });
  let left = false;
  const producers = new DataExportProducerRegistry().register({
    ...producer,
    nextBatch: async (job, cursor) => {
      const batch = await producer.nextBatch(job, cursor);
      if (!left && cursor.step === "server" && cursor.phase === "messages") {
        left = true;
        await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, me.id)));
      }
      return batch;
    },
  });
  await generateDataExport(created.row.id, { extendLease: async () => true }, { producers, notify: quiet });
  const archive = await archiveOf(created.row.id);
  assert.deepEqual(contents(archive.lines()), ["mine 1"]);
  assert.deepEqual(archive.manifest.servers, [{ serverId: server.id, status: "partial", reason: "not_a_member" }]);
});

test("the owner's switch decides context: off (the default) refuses it, on lets the export hold others' messages there, and turned off during the run the next batches hold only the requester's", async ({ seed }) => {
  const me = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner, members: [me] });
  const [first, second] = [await seed.channel({ server, members: [me, owner] }), await seed.channel({ server, members: [me, owner] })].sort((a, b) => a.id.localeCompare(b.id));
  for (const channel of [first!, second!]) {
    await createMessage(channel.id, "user", owner.id, `theirs in ${channel.id}`);
    await createMessage(channel.id, "user", me.id, `mine in ${channel.id}`);
  }
  const ask = () => createPersonalDataExportProducer().validateScope({ requesterUserId: me.id, serverId: null, scope: scopeOf({ includeContext: true }), now: new Date() });
  const refused = await ask();
  assert.deepEqual(refused.ok ? null : refused.code, "data_export_context_not_allowed");

  assert.equal(await setMemberContextExportEnabled(server.id, true), true);
  assert.equal((await ask()).ok, true);
  const allowed = await exportOf(me.id, scopeOf({ includeContext: true }));
  assert.deepEqual(contents(allowed.lines()), [`mine in ${first!.id}`, `mine in ${second!.id}`, `theirs in ${first!.id}`, `theirs in ${second!.id}`].sort());

  // One conversation a batch: the switch goes off after the first.
  await getDb().delete(dataExports).where(eq(dataExports.requesterUserId, me.id));
  await setDataExportFlag(true);
  const created = await createDataExport({ kind: "personal", requesterUserId: me.id, requesterSessionFamilyId: randomUUID(), serverId: null, scope: scopeOf({ includeContext: true }), now: new Date(), taskSpec: dataExportTaskDefinition });
  assert.ok(created.ok);
  const producer = createPersonalDataExportProducer({ conversationsPerBatch: 1 });
  let messageBatches = 0;
  const producers = new DataExportProducerRegistry().register({
    ...producer,
    nextBatch: async (job, cursor) => {
      const batch = await producer.nextBatch(job, cursor);
      if (cursor.step === "server" && cursor.phase === "messages" && (messageBatches += 1) === 1) await setMemberContextExportEnabled(server.id, false);
      return batch;
    },
  });
  await generateDataExport(created.row.id, { extendLease: async () => true }, { producers, notify: quiet });
  const partway = await archiveOf(created.row.id);
  assert.deepEqual(contents(partway.lines()), [`mine in ${first!.id}`, `mine in ${second!.id}`, `theirs in ${first!.id}`].sort());
  assert.deepEqual(partway.manifest.servers, [{ serverId: server.id, status: "exported", contextIncluded: true, contextPartial: true }], "some of it held context, not all");
  assert.equal(partway.json(`${dirOf(server)}/channels.json`).contextIncluded, true);
});

test("stable across batches: a conversation renamed during the run keeps its first folder and name in the lines and channels.json; one the person stops seeing is `partial`", async ({ seed }) => {
  const me = await seed.human();
  const server = await seed.server({ owner: me });
  const channel = await seed.channel({ server, members: [me], name: "before" });
  const leaving = await seed.channel({ server, members: [me], name: "leaving", visibility: "private" });
  for (const n of [1, 2, 3]) await createMessage(channel.id, "user", me.id, `mine ${n}`);
  for (const n of [1, 2]) await createMessage(leaving.id, "user", me.id, `leaving ${n}`);
  await setDataExportFlag(true);
  const created = await createDataExport({ kind: "personal", requesterUserId: me.id, requesterSessionFamilyId: randomUUID(), serverId: null, scope: scopeOf(), now: new Date(), taskSpec: dataExportTaskDefinition });
  assert.ok(created.ok);
  const producer = createPersonalDataExportProducer({ messageBatch: 1 });
  let renamed = false;
  const producers = new DataExportProducerRegistry().register({
    ...producer,
    nextBatch: async (job, cursor) => {
      const batch = await producer.nextBatch(job, cursor);
      // Renamed once its first line is written: channels are walked in id order, so the private
      // one may come first and a rename on the first batch would land before this one is seen.
      if (!renamed && batch.ops.some((op) => op.path.includes(channel.id))) {
        renamed = true;
        await getDb().update(channels).set({ name: "after" }).where(eq(channels.id, channel.id));
      }
      // Once the first of the private channel's lines is written, the person leaves it.
      if (batch.ops.some((op) => op.path.includes(leaving.id))) await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, leaving.id), eq(channelHumans.userId, me.id)));
      return batch;
    },
  });
  await generateDataExport(created.row.id, { extendLease: async () => true }, { producers, notify: quiet });
  const archive = await archiveOf(created.row.id);
  const dir = dirOf(server);
  const folders = new Set(archive.lines().filter((line) => line.content.startsWith("mine")).map((line) => line.path.split("/").slice(0, 4).join("/")));
  assert.deepEqual([...folders], [`${dir}/conversations/before-${channel.id}`]);
  assert.equal(archive.lines().filter((line) => line.content.startsWith("mine")).length, 3);
  const listed = archive.json(`${dir}/channels.json`).conversations;
  const entry = listed.find((c: { id: string }) => c.id === channel.id);
  assert.deepEqual([entry.name, entry.path, entry.exported], ["before", `${dir}/conversations/before-${channel.id}/`, "whole"]);
  assert.equal(listed.find((c: { id: string }) => c.id === leaving.id).exported, "partial");
  assert.deepEqual(contents(archive.lines().filter((line) => line.path.includes(leaving.id))), ["leaving 1"]);
});
