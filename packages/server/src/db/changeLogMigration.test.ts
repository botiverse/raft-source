import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  agents, channelAgents, messages, channelHumans, channels, jointChannelMembers, jointChannels, jointChannelServers, serverMembers,
  servers, threadFollows, userChannelInboxStates, userChannelReadCursors, users,
} from "./schema";

// change_log (incremental client sync): the migration's triggers write one row
// per change, scoped to who may see it, in the same transaction as the change.
// Each case starts from the migrated baseline, writes through the real tables
// and reads back what was logged after a watermark.

type Row = { scope_kind: string; scope_id: string; server_id: string | null; parent_id: string | null; entity: string; entity_id: string; op: string; ref_seq: string | null };

const migrationsDir = join(import.meta.dirname, "../../drizzle");

test("the change_log migration exists under its name", () => {
  assert.ok(readdirSync(migrationsDir).some((file) => /^\d{4}_change_log\.sql$/.test(file)));
});

test("change_log triggers log channels, members, profile and per-person state, scoped to who sees them", async ({ db }) => {
  const watermark = async () => Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const since = async (from: number) => (await db.execute(sql`
    SELECT scope_kind, scope_id::text, server_id::text, parent_id::text, entity, entity_id, op, ref_seq::text
    FROM change_log WHERE seq > ${from} ORDER BY seq`)).rows as Row[];

  const [owner] = await db.insert(users).values({ email: "cl-owner@test.com", name: "clOwner", passwordHash: "x", emailVerified: true }).returning();
  const [peer] = await db.insert(users).values({ email: "cl-peer@test.com", name: "clPeer", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "ChangeLog", slug: "change-log", ownerId: owner!.id }).returning();

  let mark = await watermark();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: peer!.id, role: "member" });
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.scope_id, r.server_id, r.entity, r.entity_id, r.op]), [
    ["server", server!.id, server!.id, "server_member", peer!.id, "upsert"],
    ["user", peer!.id, null, "server", server!.id, "scope_added"],
  ], "joining a server: the roster row for the server, and the grant in every one of the person's streams");

  mark = await watermark();
  const [room] = await db.insert(channels).values({ serverId: server!.id, name: "cl-room", type: "private" }).returning();
  await db.insert(channelHumans).values({ channelId: room!.id, userId: peer!.id });
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.scope_id, r.entity, r.entity_id, r.op]), [
    ["channel", room!.id, "channel", room!.id, "upsert"],
    ["channel", room!.id, "channel_member", `${room!.id}:user:${peer!.id}`, "upsert"],
    ["user", peer!.id, "channel", room!.id, "scope_added"],
  ]);

  mark = await watermark();
  await db.update(channels).set({ name: "cl-room-2" }).where(sql`id = ${room!.id}`);
  await db.execute(sql`UPDATE channels SET task_number_high_water = task_number_high_water + 1 WHERE id = ${room!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.entity, r.op]), [["channel", "upsert"]], "a rename is logged; the task counter moving is not");

  mark = await watermark();
  const [agent] = await db.insert(agents).values({ serverId: server!.id, name: "cl-agent", creatorType: "user", creatorId: owner!.id }).returning();
  await db.insert(channelAgents).values({ channelId: room!.id, agentId: agent!.id });
  await db.update(agents).set({ status: "active", sessionId: "s1" }).where(sql`id = ${agent!.id}`);
  await db.update(agents).set({ displayName: "CL Agent" }).where(sql`id = ${agent!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.entity, r.entity_id, r.op]), [
    ["server", "agent", agent!.id, "upsert"],
    ["channel", "channel_member", `${room!.id}:agent:${agent!.id}`, "upsert"],
    ["server", "agent", agent!.id, "upsert"],
  ], "status and session changes are presence, not logged; the directory rename is");

  mark = await watermark();
  await db.update(users).set({ displayName: "Peer!" }).where(sql`id = ${peer!.id}`);
  await db.update(users).set({ lastDesktopAppSeenAt: new Date() }).where(sql`id = ${peer!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.scope_id, r.entity, r.entity_id]), [
    ["server", server!.id, "server_member", peer!.id],
  ], "a profile edit reaches each server the person is in; activity timestamps don't");

  mark = await watermark();
  await db.insert(userChannelReadCursors).values({ userId: peer!.id, channelId: room!.id, lastReadSeq: 5 });
  await db.update(userChannelReadCursors).set({ readStateVersion: 2 }).where(sql`user_id = ${peer!.id} AND channel_id = ${room!.id}`);
  await db.update(userChannelReadCursors).set({ lastReadSeq: 9 }).where(sql`user_id = ${peer!.id} AND channel_id = ${room!.id}`);
  const cursorRows = await since(mark);
  assert.deepEqual(cursorRows.map((r) => [r.scope_kind, r.scope_id, r.server_id, r.entity, r.entity_id, r.ref_seq]), [
    ["user", peer!.id, server!.id, "read_state", room!.id, "5"],
    ["user", peer!.id, server!.id, "read_state", room!.id, "9"],
  ], "only a moving read position is logged, carrying the new position");
  const [mirror] = (await db.execute(sql`SELECT last_read_seq8::text AS v FROM user_channel_read_cursors WHERE user_id = ${peer!.id} AND channel_id = ${room!.id}`)).rows;
  assert.equal(mirror!.v, "9", "the read-cursor mirror still runs");

  // Read reports write through the sequencer's upsert (readMutationSequencer):
  // BEFORE INSERT fires for every attempt, so only an applied write may log.
  const report = (seq: number) => db.execute(sql`
    INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq, read_state_version, updated_at)
    VALUES (${peer!.id}::uuid, ${room!.id}::uuid, ${seq}, 1, now())
    ON CONFLICT (user_id, channel_id) DO UPDATE SET
      last_read_seq = EXCLUDED.last_read_seq,
      read_state_version = user_channel_read_cursors.read_state_version + 1,
      updated_at = now()
    WHERE EXCLUDED.last_read_seq > user_channel_read_cursors.last_read_seq`);
  mark = await watermark();
  await report(9);
  await report(7);
  await report(12);
  await report(12);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.entity, r.entity_id, r.ref_seq]), [
    ["user", "read_state", room!.id, "12"],
  ], "a repeated or stale report logs nothing; a report that moves the position logs it once");
  const [reported] = (await db.execute(sql`SELECT last_read_seq::text AS s, last_read_seq8::text AS v FROM user_channel_read_cursors WHERE user_id = ${peer!.id} AND channel_id = ${room!.id}`)).rows;
  assert.deepEqual([reported!.s, reported!.v], ["12", "12"], "the upsert still applies and mirrors the moving report");

  mark = await watermark();
  await db.insert(userChannelInboxStates).values({ userId: peer!.id, channelId: room!.id, doneAt: new Date() });
  await db.update(userChannelInboxStates).set({ doneAt: null }).where(sql`user_id = ${peer!.id} AND channel_id = ${room!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.entity, r.op]), [["user", "inbox_state", "upsert"], ["user", "inbox_state", "upsert"]]);

  mark = await watermark();
  const [parent] = await db.insert(messages).values({ channelId: room!.id, senderType: "user", senderId: peer!.id, content: "parent" }).returning();
  const [thread] = await db.insert(channels).values({ serverId: server!.id, name: "cl-thread", type: "thread", parentMessageId: parent!.id }).returning();
  await db.insert(threadFollows).values([
    { threadChannelId: thread!.id, followerType: "user", followerId: peer!.id, parentMessageId: parent!.id, reason: "manual" },
    { threadChannelId: thread!.id, followerType: "agent", followerId: agent!.id, parentMessageId: parent!.id, reason: "manual" },
  ]);
  await db.update(threadFollows).set({ doneAt: new Date() }).where(sql`thread_channel_id = ${thread!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.parent_id, r.entity, r.entity_id]), [
    ["channel", room!.id, "channel", thread!.id],
    ["user", null, "followed_thread", thread!.id],
    ["user", null, "followed_thread", thread!.id],
  ], "a thread carries its parent for visibility; a new message is not logged (messages.seq covers it); only a person's follow is, not an agent's");

  mark = await watermark();
  await db.delete(channelHumans).where(sql`channel_id = ${room!.id} AND user_id = ${peer!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.entity, r.op]), [
    ["channel", "channel_member", "delete"],
    ["user", "channel", "scope_removed"],
  ]);
});

test("0456: losing an audience is logged for that audience; a joint disconnect revokes; a guest role change resets", async ({ db }) => {
  const watermark = async () => Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const since = async (from: number) => ((await db.execute(sql`
    SELECT scope_kind, scope_id::text, server_id::text, entity, entity_id, op
    FROM change_log WHERE seq > ${from} ORDER BY seq`)).rows as Row[]).map((r) => [r.scope_kind, r.scope_id, r.server_id, r.entity, r.entity_id, r.op]);
  const [owner] = await db.insert(users).values({ email: "cl-vis-owner@test.com", name: "clVisOwner", passwordHash: "x", emailVerified: true }).returning();
  const [peer] = await db.insert(users).values({ email: "cl-vis-peer@test.com", name: "clVisPeer", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Visibility", slug: "cl-visibility", ownerId: owner!.id }).returning();
  const s = server!.id;
  await db.insert(serverMembers).values({ serverId: s, userId: peer!.id, role: "member" });
  const [open] = await db.insert(channels).values({ serverId: s, name: "cl-open", type: "channel", guestVisible: true }).returning();
  const [closed] = await db.insert(channels).values({ serverId: s, name: "cl-closed", type: "private", guestVisible: true }).returning();

  let mark = await watermark();
  await db.update(channels).set({ guestVisible: false }).where(sql`id = ${open!.id}`);
  assert.deepEqual(await since(mark), [
    ["channel", open!.id, s, "channel", open!.id, "upsert"],
    ["server", s, s, "channel_guest_lost", open!.id, "upsert"],
  ], "guest access off: guests lose it, members do not");

  mark = await watermark();
  await db.update(channels).set({ type: "private" }).where(sql`id = ${open!.id}`);
  assert.deepEqual(await since(mark), [
    ["channel", open!.id, s, "channel", open!.id, "upsert"],
    ["server", s, s, "channel_public_lost", open!.id, "upsert"],
  ], "made private: the server's members lose it");

  mark = await watermark();
  await db.update(channels).set({ name: "cl-closed-2", guestVisible: false }).where(sql`id = ${closed!.id}`);
  await db.update(channels).set({ deletedAt: new Date() }).where(sql`id = ${closed!.id}`);
  assert.deepEqual((await since(mark)).map((r) => r[0]), ["channel", "channel"], "a private channel is never broadcast");

  const [publicRoom] = await db.insert(channels).values({ serverId: s, name: "cl-public", type: "channel" }).returning();
  mark = await watermark();
  await db.update(channels).set({ deletedAt: new Date() }).where(sql`id = ${publicRoom!.id}`);
  assert.deepEqual((await since(mark)).map((r) => [r[0], r[3]]), [["channel", "channel"], ["server", "channel_public_lost"]]);

  const [storage] = await db.insert(channels).values({ serverId: s, name: "cl-joint-storage", type: "channel" }).returning();
  const [projection] = await db.insert(channels).values({ serverId: s, name: "cl-joint", type: "joint" }).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: storage!.id, createdByServerId: s, createdByUserId: owner!.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, serverId: s, localChannelId: projection!.id, role: "host", joinedByUserId: owner!.id });
  await db.insert(jointChannelMembers).values({ jointChannelId: joint!.id, userId: peer!.id });
  mark = await watermark();
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(sql`local_channel_id = ${projection!.id}`);
  assert.deepEqual((await since(mark)).filter((r) => r[0] === "user"), [
    ["user", peer!.id, s, "channel", projection!.id, "scope_removed"],
  ], "every joint member loses the projection");

  mark = await watermark();
  // A Guest is bound to its one channel (#wg-rbac:#15), and the binding goes with the role.
  await db.update(serverMembers).set({ role: "guest", guestChannelId: open!.id }).where(sql`server_id = ${s} AND user_id = ${peer!.id}`);
  await db.update(serverMembers).set({ role: "member", guestChannelId: null }).where(sql`server_id = ${s} AND user_id = ${peer!.id}`);
  await db.update(serverMembers).set({ role: "admin" }).where(sql`server_id = ${s} AND user_id = ${peer!.id}`);
  assert.deepEqual((await since(mark)).filter((r) => r[3] === "server"), [
    ["user", peer!.id, s, "server", s, "reset"],
    ["user", peer!.id, s, "server", s, "reset"],
    ["user", peer!.id, s, "server", s, "reset"],
  ], "every role change resets that person's stream (0458: member to admin changes capabilities too)");
});

test("change_log writes nothing under the transaction-local skip switch, and the switch ends with the transaction", async ({ db }) => {
  const [owner] = await db.insert(users).values({ email: "cl-skip@test.com", name: "clSkip", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Skip", slug: "cl-skip", ownerId: owner!.id }).returning();
  const count = async () => Number((await db.execute(sql`SELECT count(*) AS n FROM change_log WHERE server_id = ${server!.id} OR scope_id = ${server!.id}`)).rows[0]!.n);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL slock.change_log_skip = 'on'`);
    await tx.insert(channels).values({ serverId: server!.id, name: "cl-skipped", type: "channel" });
  });
  assert.equal(await count(), 0, "the skipped write left no row");
  await db.insert(channels).values({ serverId: server!.id, name: "cl-logged", type: "channel" });
  assert.equal(await count(), 1, "the next transaction logs again");
  await db.execute(sql`SELECT change_log_force_reset(${server!.id}::uuid)`);
  const [reset] = (await db.execute(sql`SELECT scope_kind, entity, op FROM change_log WHERE scope_id = ${server!.id} AND op = 'reset'`)).rows;
  assert.deepEqual(reset, { scope_kind: "server", entity: "server", op: "reset" });
});

test("change_log_maintain keeps daily partitions ahead and the default partition empty", async ({ db }) => {
  const parts = async () => (await db.execute(sql`
    SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.change_log'::regclass ORDER BY 1`)).rows.map((r) => String(r.name));
  const before = await parts();
  assert.ok(before.includes("change_log_default"));
  const daily = before.filter((name) => /^change_log_p\d{8}$/.test(name));
  assert.ok(daily.length >= 15, `yesterday through 14 days ahead exist (${daily.length})`);
  // The migrated baseline is a template built earlier (cached across runs), so
  // its partitions are dated to the build day; after a UTC midnight the first
  // call adds the new day ahead. Catch up first, then a rerun must create nothing.
  await db.execute(sql`SELECT action FROM change_log_maintain()`);
  const rerun = (await db.execute(sql`SELECT action FROM change_log_maintain()`)).rows;
  assert.equal(rerun.filter((r) => r.action === "created").length, 0, "maintenance is idempotent");
  await db.insert(channels).values({ serverId: (await db.select().from(servers).limit(1))[0]?.id ?? (await db.insert(servers).values({ name: "P", slug: "cl-parts", ownerId: (await db.insert(users).values({ email: "cl-p@test.com", name: "clP", passwordHash: "x", emailVerified: true }).returning())[0]!.id }).returning())[0]!.id, name: "cl-part-row", type: "channel" });
  const [inDefault] = (await db.execute(sql`SELECT count(*) AS n FROM change_log_default`)).rows;
  assert.equal(Number(inDefault!.n), 0, "today's rows land in today's partition");
});
