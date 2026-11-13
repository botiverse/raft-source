import assert from "node:assert/strict";
import { vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { SYNC_CHANNEL_SCOPE_SNAPSHOTS, SYNC_SNAPSHOT_NAMES, type SyncChange, type SyncChangesResponse } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb, type Database } from "../db/index";
import { seedJointChannel } from "../test/integration/jointFixture";
import { agents, channels, featureFlags, jointChannelMembers, jointChannels, jointChannelServers, machines, serverMembers, servers, threadFollows, userChannelInboxStates, userChannelReadCursors, users } from "../db/schema";
import { addAgent, addHuman, getOrCreateThread, markChannelInboxActive, recordThreadFollow, removeHuman, unfollowThread, updateChannel, type InboxItem } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { __setSyncLateCapForTests } from "../services/syncHorizon";
import { __setSyncScopedRowsCapForTests } from "../services/syncChanges";
import { seedBoundGuest } from "../test/guestFixture";
import { SYNC_CHANGES_API_FEATURE_FLAG_KEY } from "../services/featureFlagService";

// GET /api/sync/changes (services/syncChanges.ts): the change_log rows after a
// cursor, scoped to the viewer, each upsert rebuilt as its list endpoint's
// item. Writes go through the real tables, so the triggers (0450) log them.

const test = createApiTest();

type Client = { get(path: string): Promise<Response>; request(path: string, init: RequestInit): Promise<Response> };

async function sync(client: Client, since?: string, limit?: number): Promise<SyncChangesResponse> {
  const query = new URLSearchParams();
  if (since !== undefined) query.set("since", since);
  if (limit !== undefined) query.set("limit", String(limit));
  const res = await client.get(`/api/sync/changes?${query}`);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as SyncChangesResponse;
}

async function json<T>(client: Client, path: string): Promise<T> {
  const res = await client.get(path);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as T;
}

/** A read position move, as the read path writes it (the 0215 trigger logs it). */
async function setReadCursor(db: Database, userId: string, channelId: string, lastReadSeq: number) {
  await db.insert(userChannelReadCursors).values({ userId, channelId, lastReadSeq })
    .onConflictDoUpdate({ target: [userChannelReadCursors.userId, userChannelReadCursors.channelId], set: { lastReadSeq } });
}

const brief = (changes: SyncChange[]) => changes.map((change) => [change.entity, change.id, change.op]);

test("no since: the current cursor; a rename after it is one upsert carrying the GET /api/channels item", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [member, outsider] });
  const channel = await seed.channel({ server, members: [owner, member] });
  const hidden = await seed.channel({ server, members: [owner], visibility: "private" });
  const otherOwner = await seed.human();
  const otherServer = await seed.server({ owner: otherOwner, members: [member] });
  const otherChannel = await seed.channel({ server: otherServer, members: [otherOwner, member] });
  const client = http.as(member, server);

  const start = await sync(client);
  assert.match(start.cursor, /^c1\.[0-9]+\.[0-9]+$/);
  assert.deepEqual({ ...start, cursor: "" }, { cursor: "", hasMore: false, changes: [], reset: null });

  await updateChannel(channel.id, { name: "renamed-1" });
  await updateChannel(channel.id, { name: "renamed-2" });
  await updateChannel(channel.id, { name: "renamed-3" });
  await updateChannel(hidden.id, { name: "hidden-renamed" });
  await updateChannel(otherChannel.id, { name: "other-server-renamed" });
  // Another person's own state (their read position) is theirs only.
  await addHuman(channel.id, outsider.id);
  await setReadCursor(db, outsider.id, channel.id, 3);

  const round = await sync(client, start.cursor);
  const channelChanges = round.changes.filter((change) => change.entity === "channel");
  assert.equal(channelChanges.length, 1, "three renames coalesce; the private channel and the other server's channel are not delivered");
  const change = channelChanges[0]!;
  assert.equal(change.id, channel.id);
  assert.equal(change.op, "upsert");
  const list = await json<Array<{ id: string; name: string }>>(client, "/api/channels");
  const item = list.find((row) => row.id === channel.id);
  assert.ok(item);
  assert.equal(item.name, "renamed-3");
  assert.deepEqual(change.op === "upsert" ? change.row : null, item, "the row is the list endpoint's item");
  assert.ok(!round.changes.some((c) => c.entity === "conversation"), "the outsider's read state stays theirs");
  assert.ok(round.changes.some((c) => c.entity === "channel_member" && c.id === `${channel.id}:user:${outsider.id}`), "a public channel's roster change reaches every member");
  assert.equal(round.hasMore, false);
  assert.equal(round.reset, null);

  // Nothing new: the same cursor position, no changes.
  const again = await sync(client, round.cursor);
  assert.deepEqual(again.changes, []);
});

test("a soft-deleted channel is a delete; a private channel's member add/remove is a scope change with its member row", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const doomed = await seed.channel({ server, members: [owner, peer] });
  const room = await seed.channel({ server, members: [owner], visibility: "private" });
  const peerClient = http.as(peer, server);
  const ownerClient = http.as(owner, server);
  const start = await sync(peerClient);
  const ownerStart = await sync(ownerClient);

  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, doomed.id));
  await addHuman(room.id, peer.id);
  const added = await sync(peerClient, start.cursor);
  assert.deepEqual(added.changes.find((c) => c.entity === "channel" && c.id === doomed.id)?.op, "delete");
  const scope = added.changes.find((c) => c.entity === "scope");
  assert.deepEqual(scope && { ...scope, seq: 0 }, {
    seq: 0, entity: "scope", id: room.id, op: "added", scopeKind: "channel", snapshots: [...SYNC_CHANNEL_SCOPE_SNAPSHOTS],
  });
  // The room is visible now, so its own rows come too: its member row, as the roster shows it.
  const memberChange = added.changes.find((c) => c.entity === "channel_member" && c.id === `${room.id}:user:${peer.id}`);
  assert.equal(memberChange?.op, "upsert");
  const roster = await json<{ humans: Array<{ id: string }> }>(peerClient, `/api/channels/${room.id}/members`);
  assert.deepEqual(memberChange.op === "upsert" ? memberChange.row : null, roster.humans.find((h) => h.id === peer.id));

  await removeHuman(room.id, peer.id, { self: true });
  const removed = await sync(peerClient, added.cursor);
  assert.deepEqual(
    brief(removed.changes.filter((c) => c.entity !== "conversation")),
    [["scope", room.id, "removed"]],
    "the revoke reaches the person who can no longer see the room; its roster row does not",
  );

  // The owner (still a member) sees the roster row go.
  const ownerRound = await sync(ownerClient, ownerStart.cursor);
  assert.equal(ownerRound.changes.find((c) => c.entity === "channel_member" && c.id === `${room.id}:user:${peer.id}`)?.op, "delete");
});

test("server_member, agent and conversation rows: the list items as this viewer sees them", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [peer, viewer] });
  const channel = await seed.channel({ server, members: [owner, viewer] });
  const client = http.as(viewer, server);
  const start = await sync(client);

  await db.update(users).set({ displayName: "Peer Renamed" }).where(eq(users.id, peer.id));
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `sync-agent-${peer.id.slice(0, 6)}`, creatorType: "user", creatorId: owner.id }).returning();
  await addAgent(channel.id, agent!.id);
  await setReadCursor(db, viewer.id, channel.id, 4);
  await setReadCursor(db, viewer.id, channel.id, 7);

  const round = await sync(client, start.cursor);
  const memberChange = round.changes.find((c) => c.entity === "server_member" && c.id === peer.id);
  assert.equal(memberChange?.op, "upsert");
  const directory = await json<Array<{ userId: string; email: string | null }>>(client, `/api/servers/${server.id}/members`);
  const peerItem = directory.find((m) => m.userId === peer.id);
  assert.equal(peerItem?.email, null, "a member sees no one else's email");
  assert.deepEqual(memberChange.op === "upsert" ? memberChange.row : null, peerItem);

  const agentChange = round.changes.find((c) => c.entity === "agent" && c.id === agent!.id);
  assert.equal(agentChange?.op, "upsert");
  const agentList = await json<Array<{ id: string }>>(client, "/api/agents");
  assert.deepEqual(agentChange.op === "upsert" ? agentChange.row : null, agentList.find((a) => a.id === agent!.id));

  const agentMember = round.changes.find((c) => c.entity === "channel_member" && c.id === `${channel.id}:agent:${agent!.id}`);
  const roster = await json<{ agents: Array<{ id: string }> }>(client, `/api/channels/${channel.id}/members`);
  assert.deepEqual(agentMember?.op === "upsert" ? agentMember.row : null, roster.agents.find((a) => a.id === agent!.id));

  const conversation = round.changes.filter((c) => c.entity === "conversation");
  assert.deepEqual(conversation.map((c) => ({ ...c, seq: 0 })), [
    { seq: 0, entity: "conversation", id: channel.id, op: "stale", refSeq: 7, read: { readSeq: 7, readStateVersion: 0 } },
  ], "two read moves coalesce to the latest position");
});

test("conversation changes carry the current state of each kind the page saw: read, done (inbox doneFrontierSeq), a removed cursor left out", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  await seed.message({ channel, author: peer, content: "one" });
  const latest = await seed.message({ channel, author: peer, content: "two" });
  const client = http.as(owner, server);
  const conversationOf = (round: SyncChangesResponse) => {
    const found = round.changes.filter((c) => c.entity === "conversation" && c.id === channel.id);
    assert.equal(found.length, 1, JSON.stringify(round.changes));
    const change = found[0]!;
    assert.ok(change.entity === "conversation");
    const { seq: _seq, ...rest } = change;
    return rest;
  };
  let cursor = (await sync(client)).cursor;

  // (a) A read move: the cursor as it is now, not as of the change.
  await setReadCursor(db, owner.id, channel.id, 1);
  await db.update(userChannelReadCursors).set({ readStateVersion: 3 })
    .where(and(eq(userChannelReadCursors.userId, owner.id), eq(userChannelReadCursors.channelId, channel.id)));
  let round = await sync(client, cursor);
  assert.deepEqual(conversationOf(round), {
    entity: "conversation", id: channel.id, op: "stale", refSeq: 1, read: { readSeq: 1, readStateVersion: 3 },
  });
  cursor = round.cursor;

  // (b) A read move then Done in one page: both kinds; refSeq stays the read's.
  await setReadCursor(db, owner.id, channel.id, 2);
  await db.insert(userChannelInboxStates).values({ userId: owner.id, channelId: channel.id, doneAt: new Date() });
  round = await sync(client, cursor);
  assert.deepEqual(conversationOf(round), {
    entity: "conversation", id: channel.id, op: "stale", refSeq: 2,
    read: { readSeq: 2, readStateVersion: 3 },
    done: { done: true, doneFrontierSeq: String(latest.seq) },
  });
  cursor = round.cursor;

  // (f) Undone: done false, with the frontier the inbox row reports.
  await markChannelInboxActive(owner.id, channel.id);
  round = await sync(client, cursor);
  const inbox = await json<{ items: InboxItem[] }>(client, `/api/channels/inbox?ids=${channel.id}`);
  const row = inbox.items[0];
  assert.ok(row && row.kind === "channel", JSON.stringify(inbox));
  assert.equal(row.doneFrontierSeq, String(latest.seq), "control: the inbox's frontier is the latest message");
  const undone = conversationOf(round);
  assert.deepEqual(undone.done, { done: false, doneFrontierSeq: row.doneFrontierSeq });
  cursor = round.cursor;

  // (e) The cursor row is gone by the time the page is built: read left out.
  await setReadCursor(db, owner.id, channel.id, 3);
  await db.delete(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, owner.id), eq(userChannelReadCursors.channelId, channel.id)));
  round = await sync(client, cursor);
  assert.deepEqual(conversationOf(round), { entity: "conversation", id: channel.id, op: "stale", refSeq: 3 });
});

test("conversation changes of a thread carry its follow state: followed and done, then unfollowed", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const parent = await seed.message({ channel, author: peer, content: "a thread start" });
  const thread = await getOrCreateThread(parent.id, peer.id, "user");
  await createMessage(thread.id, "user", peer.id, "a reply");
  const client = http.as(owner, server);
  const followOf = (round: SyncChangesResponse) => {
    const found = round.changes.find((c) => c.entity === "conversation" && c.id === thread.id);
    assert.ok(found && found.entity === "conversation", JSON.stringify(round.changes));
    return found.follow;
  };
  const start = await sync(client);

  // (c) Followed, then marked done, in one page.
  await recordThreadFollow("user", owner.id, thread.id, parent.id, "manual", { joinedThroughSeq: "latest" });
  await db.update(threadFollows).set({ doneAt: new Date() })
    .where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, owner.id)));
  const followed = await sync(client, start.cursor);
  assert.deepEqual(followOf(followed), { followed: true, threadDone: true });

  // (d) Unfollowed (the row stays, unfollowed_at set).
  await unfollowThread(owner.id, thread.id);
  const unfollowed = await sync(client, followed.cursor);
  assert.deepEqual(followOf(unfollowed), { followed: false, threadDone: true });
});

test("paging: limit counts log rows, hasMore until the end, cursors chain", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const a = await seed.channel({ server, members: [owner] });
  const b = await seed.channel({ server, members: [owner] });
  const c = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  const start = await sync(client);
  await updateChannel(a.id, { name: "page-a" });
  await updateChannel(b.id, { name: "page-b" });
  await updateChannel(c.id, { name: "page-c" });

  const first = await sync(client, start.cursor, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(brief(first.changes), [["channel", a.id, "upsert"], ["channel", b.id, "upsert"]]);
  const second = await sync(client, first.cursor, 2);
  assert.equal(second.hasMore, false);
  assert.deepEqual(brief(second.changes), [["channel", c.id, "upsert"]]);
  assert.ok(second.changes[0]!.seq > first.changes[1]!.seq);
});

test("late arm: a row whose seq was taken before the cursor but committed after it still arrives", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const other = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  // A long transaction takes its seq (nextval at INSERT) ...
  const lateSeq = Number((await db.execute(sql`SELECT nextval('change_log_seq_seq') AS seq`)).rows[0]!.seq);
  await updateChannel(other.id, { name: "passes-the-late-seq" });
  const start = await sync(client);
  const round1 = await sync(client, start.cursor);
  // ... and commits after the reader passed it.
  await db.execute(sql`
    INSERT INTO change_log (seq, server_id, scope_kind, scope_id, entity, entity_id, op)
    VALUES (${lateSeq}, ${server.id}, 'channel', ${channel.id}, 'channel', ${channel.id}, 'upsert')`);
  const round2 = await sync(client, round1.cursor);
  assert.deepEqual(brief(round2.changes), [["channel", channel.id, "upsert"]]);
  assert.equal(round2.changes[0]!.seq, lateSeq);

  // More late rows than the cap: a reset, not a partial catch-up.
  const lateSeq2 = Number((await db.execute(sql`SELECT nextval('change_log_seq_seq') AS seq`)).rows[0]!.seq);
  await updateChannel(other.id, { name: "passes-again" });
  const round3 = await sync(client, round2.cursor);
  await db.execute(sql`
    INSERT INTO change_log (seq, server_id, scope_kind, scope_id, entity, entity_id, op)
    VALUES (${lateSeq2}, ${server.id}, 'channel', ${channel.id}, 'channel', ${channel.id}, 'upsert')`);
  __setSyncLateCapForTests(0);
  try {
    const capped = await sync(client, round3.cursor);
    assert.deepEqual(capped.reset, { reason: "too_many", snapshots: [...SYNC_SNAPSHOT_NAMES] });
    assert.deepEqual(capped.changes, []);
  } finally {
    __setSyncLateCapForTests(null);
  }
});

test("resets: a cursor older than the log keeps, and change_log_force_reset", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  const start = await sync(client);
  await updateChannel(channel.id, { name: "after-start" });
  await updateChannel(channel.id, { name: "after-start-2" });
  // Retention dropped everything up to the newest row.
  await db.execute(sql`DELETE FROM change_log WHERE seq < (SELECT max(seq) FROM change_log)`);
  const old = await sync(client, start.cursor);
  assert.deepEqual(old.reset, { reason: "too_old", snapshots: [...SYNC_SNAPSHOT_NAMES] });
  assert.deepEqual(old.changes, []);
  const resumed = await sync(client, old.cursor);
  assert.equal(resumed.reset, null, "the reset's cursor is the current position");

  await db.execute(sql`SELECT change_log_force_reset(${server.id}::uuid)`);
  const forced = await sync(client, resumed.cursor);
  assert.deepEqual(forced.reset, { reason: "forced", snapshots: [...SYNC_SNAPSHOT_NAMES] });
  assert.equal((await sync(client, forced.cursor)).reset, null);
});

test("invalid cursor and limit are 400", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const client = http.as(owner, server);
  for (const bad of ["", "c1", "c1.1", "c2.1.1", "c1.-1.1", "c1.01.1", "c1.1.01", "c1.1.18446744073709551616", "c1.9223372036854775808.1"]) {
    const res = await client.get(`/api/sync/changes?since=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, bad);
    assert.equal((await res.json() as { code: string }).code, "invalid_cursor");
  }
  const repeated = await client.get("/api/sync/changes?since=c1.1.1&since=c1.1.1");
  assert.equal(repeated.status, 400);
  for (const bad of ["x", "1.5", "-1"]) {
    const res = await client.get(`/api/sync/changes?limit=${bad}`);
    assert.equal(res.status, 400, bad);
  }
  const clamped = await client.get("/api/sync/changes?limit=100000");
  assert.equal(clamped.status, 200);
});

test("joint channel: canonical-scoped grant and roster rows come back under the viewer's local projection id", async ({ seed, http }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const joint = await seedJointChannel({ name: `joint-${viewer.id.slice(0, 6)}`, serverIds: [server.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  const client = http.as(viewer, server);
  const start = await sync(client);

  // Joining logs the projection's roster row and grant, and the joint
  // membership's, which name the canonical storage channel.
  await addHuman(local.id, viewer.id);
  const round = await sync(client, start.cursor);
  assert.ok(!round.changes.some((c) => c.id.includes(joint.canonical.id)), "no change names the canonical channel");
  assert.deepEqual(brief(round.changes.filter((c) => c.entity === "scope")), [["scope", local.id, "added"]], "both grants coalesce under the local id");
  const members = round.changes.filter((c) => c.entity === "channel_member");
  assert.deepEqual(brief(members), [["channel_member", `${local.id}:user:${viewer.id}`, "upsert"]]);
  const roster = await json<{ humans: Array<{ id: string }> }>(client, `/api/channels/${local.id}/members`);
  const member = members[0]!;
  assert.deepEqual(member.op === "upsert" ? member.row : null, roster.humans.find((h) => h.id === viewer.id));
});

test("joint channel: leaving it is a scope removal under the viewer's local projection id", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const joint = await seedJointChannel({ name: `joint-lv-${viewer.id.slice(0, 6)}`, serverIds: [server.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  await addHuman(local.id, viewer.id);
  const client = http.as(viewer, server);
  const start = await sync(client);

  await removeHuman(local.id, viewer.id, { self: true });
  const logged = await db.execute(sql`
    SELECT entity_id, op, server_id FROM change_log
    WHERE scope_kind = 'user' AND scope_id = ${viewer.id} AND op = 'scope_removed' ORDER BY seq`);
  const round = await sync(client, start.cursor);
  assert.ok(!round.changes.some((c) => c.id.includes(joint.canonical.id)), "no change names the canonical channel");
  assert.deepEqual(brief(round.changes.filter((c) => c.entity === "scope")), [["scope", local.id, "removed"]], JSON.stringify(logged.rows));
});

test("joint channel: a revoke logged only under the canonical id still reaches the viewer under the local id", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const joint = await seedJointChannel({ name: `joint-cr-${viewer.id.slice(0, 6)}`, serverIds: [server.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  await addHuman(local.id, viewer.id);
  const client = http.as(viewer, server);
  const start = await sync(client);
  // The viewer loses the channel with only the joint membership's revoke
  // logged (the local roster triggers off), so the visible map has no entry.
  await db.execute(sql`ALTER TABLE channel_humans DISABLE TRIGGER change_log_channel_humans_ins_del`);
  await db.execute(sql`DELETE FROM channel_humans WHERE channel_id = ${local.id} AND user_id = ${viewer.id}`);
  await db.execute(sql`ALTER TABLE channel_humans ENABLE TRIGGER change_log_channel_humans_ins_del`);
  await db.delete(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, joint.jointChannelId), eq(jointChannelMembers.userId, viewer.id)));
  const round = await sync(client, start.cursor);
  assert.ok(!round.changes.some((c) => c.id.includes(joint.canonical.id)), "no change names the canonical channel");
  assert.deepEqual(brief(round.changes.filter((c) => c.entity === "scope")), [["scope", local.id, "removed"]]);
});

for (const computed of [false, true]) {
  test(`joint channel (${computed ? "computed" : "stored"} membership): leaving through the API is a scope removal under the local id`, async ({ seed, db, http }) => {
    if (computed) {
    }
    const owner = await seed.human();
    const viewer = await seed.human();
    const server = await seed.server({ owner, members: [viewer] });
    const joint = await seedJointChannel({ name: `joint-ap-${viewer.id.slice(0, 6)}`, serverIds: [server.id], createdByUserId: owner.id });
    const local = joint.projections[0]!;
    await addHuman(local.id, viewer.id);
    const client = http.as(viewer, server);
    const start = await sync(client);
    const left = await client.request(`/api/channels/${local.id}/leave`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.ok(left.status < 300, `${left.status} ${await left.clone().text()}`);
    const logged = await db.execute(sql`
      SELECT entity_id, op, server_id FROM change_log
      WHERE scope_kind = 'user' AND scope_id = ${viewer.id} AND op LIKE 'scope_%' ORDER BY seq`);
    const round = await sync(client, start.cursor);
    assert.ok(!round.changes.some((c) => c.id.includes(joint.canonical.id)), "no change names the canonical channel");
    assert.deepEqual(brief(round.changes.filter((c) => c.entity === "scope")), [["scope", local.id, "removed"]], JSON.stringify(logged.rows));
  });
}

/** A change row as the write side's triggers will log it (machines and orders have none on this branch yet). */
async function logChange(db: Database, row: { serverId: string | null; scopeKind: "server" | "user"; scopeId: string; entity: string; entityId: string; op: string }) {
  await db.execute(sql`
    INSERT INTO change_log (server_id, scope_kind, scope_id, entity, entity_id, op)
    VALUES (${row.serverId}, ${row.scopeKind}, ${row.scopeId}, ${row.entity}, ${row.entityId}, ${row.op})`);
}

test("machine, sidebar_order and server_order: the endpoint bodies; machines only with viewMachines", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [member, guest] });
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);
  const [machine] = await db.insert(machines).values({
    serverId: server.id, userId: owner.id, name: "sync-machine", apiKeyHash: `sync-machine-${server.id}`, runtimes: [],
  }).returning();
  const memberClient = http.as(member, server);
  const guestClient = http.as(guest, server);
  const ownerClient = http.as(owner, server);
  const memberStart = await sync(memberClient);
  const guestStart = await sync(guestClient);
  const ownerStart = await sync(ownerClient);

  await db.update(machines).set({ name: "sync-machine-renamed" }).where(eq(machines.id, machine!.id));
  await logChange(db, { serverId: server.id, scopeKind: "server", scopeId: server.id, entity: "machine", entityId: machine!.id, op: "upsert" });
  await logChange(db, { serverId: server.id, scopeKind: "server", scopeId: server.id, entity: "machine", entityId: owner.id, op: "delete" });
  await logChange(db, { serverId: server.id, scopeKind: "user", scopeId: member.id, entity: "sidebar_order", entityId: server.id, op: "upsert" });
  await logChange(db, { serverId: null, scopeKind: "user", scopeId: member.id, entity: "server_order", entityId: member.id, op: "upsert" });
  await logChange(db, { serverId: server.id, scopeKind: "user", scopeId: owner.id, entity: "sidebar_order", entityId: server.id, op: "upsert" });

  const round = await sync(memberClient, memberStart.cursor);
  assert.deepEqual(brief(round.changes), [
    ["machine", machine!.id, "upsert"],
    ["machine", owner.id, "delete"],
    ["sidebar_order", server.id, "upsert"],
    ["server_order", member.id, "upsert"],
  ], "the owner's own sidebar order is theirs only");
  const row = (entity: string) => {
    const change = round.changes.find((c) => c.entity === entity);
    return change && "row" in change ? change.row : null;
  };
  const list = await json<{ machines: Array<{ id: string }> }>(memberClient, `/api/servers/${server.id}/machines`);
  assert.deepEqual(row("machine"), list.machines.find((m) => m.id === machine!.id));
  assert.deepEqual(row("sidebar_order"), await json(memberClient, `/api/servers/${server.id}/sidebar-order`));
  assert.deepEqual(row("server_order"), await json(memberClient, "/api/servers/order"));

  assert.equal((row("machine") as { name?: string } | null)?.name, "sync-machine-renamed");

  // The owner (an admin) gets the same upsert, with the owner's own per-viewer fields.
  const ownerRound = await sync(ownerClient, ownerStart.cursor);
  const ownerMachine = ownerRound.changes.find((c) => c.entity === "machine" && c.id === machine!.id);
  const ownerList = await json<{ machines: Array<{ id: string }> }>(ownerClient, `/api/servers/${server.id}/machines`);
  assert.deepEqual(ownerMachine?.op === "upsert" ? ownerMachine.row : null, ownerList.machines.find((m) => m.id === machine!.id));

  // The guest lacks viewMachines (and has no server member list): no machine
  // change at all, not even a delete, and no machine id anywhere.
  assert.equal((await guestClient.get(`/api/servers/${server.id}/machines`)).status, 403);
  const guestRound = await sync(guestClient, guestStart.cursor);
  assert.ok(!guestRound.changes.some((c) => c.entity === "machine" || c.entity === "server_member"), JSON.stringify(brief(guestRound.changes)));
  assert.ok(!JSON.stringify(guestRound).includes(machine!.id));
  // Nor do their snapshot lists name what they cannot read.
  await db.execute(sql`SELECT change_log_force_reset(${server.id}::uuid)`);
  const guestReset = await sync(guestClient, guestRound.cursor);
  assert.deepEqual(guestReset.reset?.snapshots, SYNC_SNAPSHOT_NAMES.filter((name) => name !== "machines" && name !== "server_members"));
  const memberReset = await sync(memberClient, round.cursor);
  assert.deepEqual(memberReset.reset?.snapshots, [...SYNC_SNAPSHOT_NAMES]);
});

/** A Guest is bound to a channel of its own (never one a test asserts it loses); a member has no binding. */
async function setRole(db: Database, serverId: string, userId: string, role: "guest" | "member") {
  if (role === "guest") {
    await seedBoundGuest({ serverId, userId }, db);
    return;
  }
  await db.update(serverMembers).set({ role, guestChannelId: null }).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

test("a channel leaving an audience reaches that audience: made private (non-members delete), guest access off (guests delete); a private rename is not broadcast", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const outsider = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [member, outsider, guest] });
  await setRole(db, server.id, guest.id, "guest");
  const going = await seed.channel({ server, members: [owner, member] });
  const guestRoom = await seed.channel({ server, members: [owner] });
  await updateChannel(guestRoom.id, { guestVisible: true });
  const secret = await seed.channel({ server, members: [owner], visibility: "private" });
  const memberClient = http.as(member, server);
  const outsiderClient = http.as(outsider, server);
  const guestClient = http.as(guest, server);
  const [memberStart, outsiderStart, guestStart] = [await sync(memberClient), await sync(outsiderClient), await sync(guestClient)];

  await updateChannel(going.id, { type: "private" });
  await updateChannel(guestRoom.id, { guestVisible: false });
  await updateChannel(secret.id, { name: "secret-renamed" });

  const outsiderRound = await sync(outsiderClient, outsiderStart.cursor);
  assert.equal(outsiderRound.changes.find((c) => c.entity === "channel" && c.id === going.id)?.op, "delete", "the public audience is told the channel left it");
  assert.ok(!JSON.stringify(outsiderRound).includes(secret.id), "a private channel's change never reaches non-members");
  assert.notEqual(outsiderRound.changes.find((c) => c.entity === "channel" && c.id === guestRoom.id)?.op, "delete", "guest access is not the members' audience");
  const memberRound = await sync(memberClient, memberStart.cursor);
  const kept = memberRound.changes.find((c) => c.entity === "channel" && c.id === going.id);
  assert.equal(kept?.op, "upsert", "a member still sees it, now private");
  const guestRound = await sync(guestClient, guestStart.cursor);
  assert.equal(guestRound.changes.find((c) => c.entity === "channel" && c.id === guestRoom.id)?.op, "delete");
  assert.ok(!JSON.stringify(guestRound).includes(secret.id));
});

test("a role change to or from guest resets that person's stream in the server", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const bystander = await seed.human();
  const server = await seed.server({ owner, members: [member, bystander] });
  const client = http.as(member, server);
  const bystanderClient = http.as(bystander, server);
  const start = await sync(client);
  const bystanderStart = await sync(bystanderClient);
  await setRole(db, server.id, member.id, "guest");
  const demoted = await sync(client, start.cursor);
  assert.equal(demoted.reset?.reason, "forced");
  assert.ok(!demoted.reset?.snapshots.includes("server_members"), "a guest is not told to fetch what it cannot");
  await setRole(db, server.id, member.id, "member");
  const promoted = await sync(client, demoted.cursor);
  assert.equal(promoted.reset?.reason, "forced");
  assert.equal((await sync(bystanderClient, bystanderStart.cursor)).reset, null, "only that person's stream");
});

test("a joint projection disconnecting revokes the channel from the joint's members", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const joint = await seedJointChannel({ name: `joint-dc-${viewer.id.slice(0, 6)}`, serverIds: [server.id], createdByUserId: owner.id });
  const local = joint.projections[0]!;
  await addHuman(local.id, viewer.id);
  const client = http.as(viewer, server);
  const start = await sync(client);
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, local.id));
  const round = await sync(client, start.cursor);
  assert.deepEqual(brief(round.changes.filter((c) => c.entity === "scope")), [["scope", local.id, "removed"]]);
});

test("a channel row about another server's channel (an unmapped joint storage, a foreign projection) is skipped", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const elsewhereOwner = await seed.human();
  const elsewhere = await seed.server({ owner: elsewhereOwner, members: [viewer] });
  const foreign = await seed.channel({ server: elsewhere, members: [elsewhereOwner, viewer] });
  const mine = await seed.channel({ server, members: [owner, viewer], visibility: "private" });
  const client = http.as(viewer, server);
  const start = await sync(client);
  // Joint membership grants name the canonical channel and no server.
  for (const channelId of [foreign.id, mine.id]) {
    await logChange(db, { serverId: null, scopeKind: "user", scopeId: viewer.id, entity: "channel", entityId: channelId, op: "scope_added" });
  }
  const round = await sync(client, start.cursor);
  assert.deepEqual(brief(round.changes.filter((c) => c.entity === "scope")), [["scope", mine.id, "added"]]);
  assert.ok(!JSON.stringify(round).includes(foreign.id));
});

test("server-wide rows a viewer's list does not hold are dropped: agents a guest cannot see, members a hidden directory hides", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const member = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner, members: [guest, member, other] });
  await setRole(db, server.id, guest.id, "guest");
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `hidden-agent-${guest.id.slice(0, 6)}`, creatorType: "user", creatorId: owner.id }).returning();
  const guestClient = http.as(guest, server);
  const memberClient = http.as(member, server);
  const guestStart = await sync(guestClient);

  await db.update(agents).set({ displayName: "Renamed" }).where(eq(agents.id, agent!.id));
  await logChange(db, { serverId: server.id, scopeKind: "server", scopeId: server.id, entity: "agent", entityId: agent!.id, op: "delete" });
  const guestRound = await sync(guestClient, guestStart.cursor);
  assert.ok(!JSON.stringify(guestRound).includes(agent!.id), JSON.stringify(brief(guestRound.changes)));

  await db.update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, server.id));
  const memberStart = await sync(memberClient);
  await db.update(users).set({ displayName: "Other Renamed" }).where(eq(users.id, other.id));
  await logChange(db, { serverId: server.id, scopeKind: "server", scopeId: server.id, entity: "server_member", entityId: owner.id, op: "delete" });
  await db.update(users).set({ displayName: "Me Renamed" }).where(eq(users.id, member.id));
  const memberRound = await sync(memberClient, memberStart.cursor);
  assert.deepEqual(brief(memberRound.changes.filter((c) => c.entity === "server_member")), [["server_member", member.id, "upsert"]], "only the viewer's own row");
});

test("late arm and too_many: a forged old horizon reads at most the cap, then resets; a pull's later pages (.k) skip the count", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const a = await seed.channel({ server, members: [owner] });
  const b = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  const start = await sync(client);
  const [, seq] = /^c1\.([0-9]+)\./.exec(start.cursor)!;
  const forged = await sync(client, `c1.${seq}.0`);
  assert.equal(forged.reset?.reason, "too_old", "a horizon below every retained row would span the whole retention");
  const [{ min_xid: minXid }] = (await getDb().execute(sql`SELECT min(xid)::text AS min_xid FROM change_log`)).rows as Array<{ min_xid: string }>;
  __setSyncLateCapForTests(2);
  try {
    const old = await sync(client, `c1.${seq}.${minXid}`);
    assert.equal(old.reset?.reason, "too_many", "an old in-range horizon reads at most the cap, then resets");
  } finally {
    __setSyncLateCapForTests(null);
  }

  await updateChannel(a.id, { name: "count-a" });
  await updateChannel(b.id, { name: "count-b" });
  await updateChannel(a.id, { name: "count-a2" });
  const first = await sync(client, start.cursor, 1);
  assert.equal(first.hasMore, true);
  assert.match(first.cursor, /^c1\.[0-9]+\.[0-9]+\.k$/, "a later page of the pull");
  __setSyncScopedRowsCapForTests(1);
  try {
    assert.equal((await sync(client, start.cursor, 1)).reset?.reason, "too_many", "a first page counts");
    const later = await sync(client, first.cursor, 1);
    assert.equal(later.reset, null, "a .k page does not count again");
    let cursor = later.cursor;
    let page = later;
    while (page.hasMore) { page = await sync(client, cursor, 1); cursor = page.cursor; }
    assert.match(cursor, /^c1\.[0-9]+\.[0-9]+$/, "the pull's last page returns a plain cursor");
  } finally {
    __setSyncScopedRowsCapForTests(null);
  }
});

test("visibility follow-ups: any role change resets, an archived guest channel leaves guests, the guest flag resets guests only", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const admin = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [admin, guest] });
  await db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);
  const room = await seed.channel({ server, members: [owner] });
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, room.id));
  const adminClient = http.as(admin, server);
  const guestClient = http.as(guest, server);
  const ownerClient = http.as(owner, server);
  const adminStart = await sync(adminClient);
  const guestStart = await sync(guestClient);
  const ownerStart = await sync(ownerClient);

  // An admin demoted to member loses viewMachines: their stream resets.
  await db.update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  assert.equal((await sync(adminClient, adminStart.cursor)).reset?.reason, "forced");

  // Archiving a guest-readable channel: guests are told (delete), the owner still sees it in its own scope.
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, room.id));
  const guestRound = await sync(guestClient, guestStart.cursor);
  assert.ok(guestRound.changes.some((c) => c.entity === "channel" && c.id === room.id && c.op === "delete"), JSON.stringify(guestRound));

  // A deleted channel updated again does not log another lost-audience row.
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, room.id));
  const count = async () => Number((await db.execute(sql`SELECT count(*) AS n FROM change_log WHERE entity IN ('channel_public_lost', 'channel_guest_lost') AND entity_id = ${room.id}`)).rows[0]!.n);
  const before = await count();
  await db.update(channels).set({ description: "after delete" }).where(eq(channels.id, room.id));
  assert.equal(await count(), before);

  // The guest feature flag changing resets guest viewers only.
  const ownerMid = await sync(ownerClient, ownerStart.cursor);
  const guestMid = await sync(guestClient, guestRound.cursor);
  const flipped = await db.execute(sql`UPDATE feature_flags SET kill_switch = NOT kill_switch WHERE key = 'server_guest_v0'`);
  assert.equal(flipped.rowCount ?? (flipped as { affectedRows?: number }).affectedRows, 1, "the guest flag is in the migrated baseline");
  assert.equal((await sync(guestClient, guestMid.cursor)).reset?.reason, "forced");
  assert.equal((await sync(ownerClient, ownerMid.cursor)).reset, null);
});

test("an inactive joint revokes it from the joint's members on every projection", async ({ seed, db }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const a = await seed.server({ owner, members: [member] });
  const b = await seed.server({ owner });
  const joint = await seedJointChannel({ name: "joint-close", serverIds: [a.id, b.id], createdByUserId: owner.id });
  await db.insert(jointChannelMembers).values({ jointChannelId: joint.jointChannelId, userId: member.id });
  const watermark = Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  await db.update(jointChannels).set({ status: "closed" }).where(eq(jointChannels.id, joint.jointChannelId));
  const rows = (await db.execute(sql`SELECT scope_id::text AS user_id, server_id::text AS server_id, entity_id FROM change_log
    WHERE seq > ${watermark} AND op = 'scope_removed' AND entity = 'channel' ORDER BY seq`)).rows as Array<{ user_id: string; server_id: string; entity_id: string }>;
  assert.deepEqual(
    rows.map((row) => [row.user_id, row.server_id, row.entity_id]).sort(),
    joint.projections.map((projection) => [member.id, projection.serverId, projection.id]).sort(),
    "the member loses the joint on each active projection",
  );
});

test("a guest_access reset that commits after the guest's cursor passed its seq still reaches the guest", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [guest] });
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);
  const guestClient = http.as(guest, server);
  const ownerClient = http.as(owner, server);
  const guestStart = await sync(guestClient);
  const ownerStart = await sync(ownerClient);
  const [, seq] = /^c1\.([0-9]+)\./.exec(guestStart.cursor)!;
  // The flag change's transaction took its seq before the guest's read but
  // committed after it: seq <= the cursor's seq, xid >= its horizon.
  await db.execute(sql`INSERT INTO change_log (seq, server_id, scope_kind, scope_id, entity, entity_id, op)
    VALUES (${seq}::bigint, NULL, 'server', '00000000-0000-0000-0000-000000000000', 'guest_access', 'server_guest_v0', 'reset')`);
  assert.equal((await sync(guestClient, guestStart.cursor)).reset?.reason, "forced", "the late row still resets the guest");
  assert.equal((await sync(ownerClient, ownerStart.cursor)).reset, null, "non-guests are unaffected");
});

test("a cursor taken on an empty log is not too_old once rows arrive (Scout, local full stack)", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const room = await seed.channel({ server, members: [owner] });
  const client = http.as(owner, server);
  await db.execute(sql`TRUNCATE change_log`);
  const start = await sync(client);
  await updateChannel(room.id, { name: "after-empty" });
  const next = await sync(client, start.cursor);
  assert.equal(next.reset, null, "every row written after the read has a newer xid; that is not a retention gap");
  assert.ok(next.changes.some((c) => c.entity === "channel" && c.id === room.id && c.op === "upsert"), JSON.stringify(next));
});

test("the server switch: absent or on serves; killed or turned off answers 404 to every client of the server", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const client = http.as(owner, server);
  const status = async () => (await client.get("/api/sync/changes")).status;
  assert.equal(await status(), 200, "no flag row: served");
  await db.insert(featureFlags).values({ key: SYNC_CHANGES_API_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: true, randomizationUnit: "server", salt: "sync-api" });
  assert.equal(await status(), 200, "on: served");
  await db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, SYNC_CHANGES_API_FEATURE_FLAG_KEY));
  const killed = await client.get("/api/sync/changes?since=0");
  assert.equal(killed.status, 404);
  assert.equal((await killed.json() as { code?: string }).code, "sync_changes_off");
  await db.update(featureFlags).set({ killSwitch: false, enabled: false }).where(eq(featureFlags.key, SYNC_CHANGES_API_FEATURE_FLAG_KEY));
  assert.equal(await status(), 404, "turned off: 404");
  await db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, SYNC_CHANGES_API_FEATURE_FLAG_KEY));
  assert.equal(await status(), 200, "back on: served");
});

test("a failed read is a logged 500 with a correlation id, not a silent one", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const client = http.as(owner, server);
  const start = await sync(client);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await db.execute(sql`ALTER TABLE change_log RENAME TO change_log_hidden`);
  try {
    const res = await client.get(`/api/sync/changes?since=${encodeURIComponent(start.cursor)}`);
    assert.equal(res.status, 500);
    const body = await res.json() as { error: string; correlationId?: string };
    assert.equal(body.error, "Failed to read sync changes");
    assert.ok(body.correlationId, "the response carries the logged correlation id");
    assert.ok(logged.mock.calls.some(([prefix, detail]) => prefix === "Failed to read sync changes:"
      && (detail as { correlationId?: string }).correlationId === body.correlationId), "the failure is logged with the same id");
  } finally {
    await db.execute(sql`ALTER TABLE change_log_hidden RENAME TO change_log`);
    logged.mockRestore();
  }
});
