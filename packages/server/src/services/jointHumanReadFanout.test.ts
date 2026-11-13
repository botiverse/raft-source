import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { vi } from "vitest";
import { dbTest } from "../test/integration/dbTest";
import { jointHumanReadFixture } from "../test/jointHumanReadFixture";
import {
  agents, agentChannelReadCursors, channelAgents, channels, jointChannels, jointChannelServers, messages,
  serverAgentMembers, serverMembers, servers, userChannelReadCursors,
} from "../db/schema";
import {
  admitReadMutation, claimNextReadMutation, executeReadMutationClaim, executeCompatibilityReadMutation,
  ReadMutationFailpointError, type ReadMutationPayload,
  raiseReadPositionForJoin,
} from "./readMutationSequencer";
import { JOINT_READ_MAX_ENTRIES } from "./jointHumanReadFanout";
import { setJointHumanReadRealtimeIO } from "./jointHumanReadRealtime";
import { RECEIVER_STATE_PUSH_ENABLED_ENV } from "./receiverStatePushService";
import * as tracing from "../tracing/semanticTrace";
import { flushPendingRetractionsForTests } from "./notifications/retraction";

afterEach(async () => { await flushPendingRetractionsForTests(); setJointHumanReadRealtimeIO(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

dbTest("channel storage with joint entries: reading A clears B's unread; marking B unread rewinds A", async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  const [storage] = await db.select().from(channels).where(eq(channels.id, x.joint.jointChannel.canonicalChannelId));
  assert.equal(storage.type, "channel", "canonical top-level storage keeps its ordinary channel type");
  assert.equal(x.joint.channel.type, "joint");
  assert.equal(x.target.type, "joint", "joint entry type differs from canonical storage");
  const a = x.joint.channel.id, b = x.target.id;
  await db.insert(userChannelReadCursors).values([
    { userId: x.peer.id, channelId: a, lastReadSeq: 8, lastAppliedAuthoritySeq: 55 },
    { userId: x.peer.id, channelId: b, lastReadSeq: 2, lastAppliedAuthoritySeq: 89 },
  ]);
  const read = await executeCompatibilityReadMutation({ serverId: x.a.id, principalId: x.peer.id,
    mutation: { kind: "row_read", scopeId: a, throughSeq: 10 } });
  assert.deepEqual(read.scopes.map((row) => row.scopeId), [a], "A's ACK never contains B's scope");
  let cursors = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  assert.equal(cursors.find((row) => row.channelId === a)?.lastReadSeq, 10);
  assert.equal(cursors.find((row) => row.channelId === b)?.lastReadSeq, 10);
  assert.equal(cursors.find((row) => row.channelId === b)?.lastAppliedAuthoritySeq, 89, "A's mutation sequence is not copied to B");
  const unread = await x.run({ kind: "row_unread", scopeId: b, throughSeq: 9 });
  cursors = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  assert.equal(cursors.find((row) => row.channelId === a)?.lastReadSeq, 9);
  assert.equal(cursors.find((row) => row.channelId === b)?.lastReadSeq, 9);
  assert.equal(cursors.find((row) => row.channelId === a)?.lastAppliedAuthoritySeq, read.authoritySeq);
  assert.equal(unread.scopes[0]?.unreadCount, 1);
  const [counts] = (await db.execute<{ a: number; b: number }>(sql`SELECT
    (SELECT count(*)::int FROM messages WHERE channel_id=${x.joint.jointChannel.canonicalChannelId}::uuid
      AND seq>(SELECT last_read_seq FROM user_channel_read_cursors WHERE user_id=${x.peer.id}::uuid AND channel_id=${a}::uuid)) a,
    (SELECT count(*)::int FROM messages WHERE channel_id=${x.joint.jointChannel.canonicalChannelId}::uuid
      AND seq>(SELECT last_read_seq FROM user_channel_read_cursors WHERE user_id=${x.peer.id}::uuid AND channel_id=${b}::uuid)) b`)).rows;
  assert.deepEqual(counts, { a: 1, b: 1 });
});

dbTest("a partial read uses the greatest existing position and aligns old divergence without a backfill", async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  await db.insert(userChannelReadCursors).values({ userId: x.peer.id, channelId: x.joint.channel.id, lastReadSeq: 10, readStateVersion: 5 });
  const ack = await x.run({ kind: "row_read", scopeId: x.target.id, throughSeq: 2 });
  assert.equal(ack.scopes[0]?.maxReadSeq, 10);
  assert.equal(ack.scopes[0]?.unreadCount, 0);
  const rows = await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.userId, x.peer.id), inArray(userChannelReadCursors.channelId, [x.joint.channel.id, x.target.id])));
  assert.deepEqual(rows.map((row) => row.lastReadSeq), [10, 10]);
});

for (const kind of ["row_read", "channel_read_all", "conversation_read_all", "global_read_all", "done"] as const) {
  dbTest(`${kind} mirrors joint cursors while leaving Done and ordinary conversations entry-local`, async ({ db, seed }) => {
    const x = await jointHumanReadFixture({ db, seed });
    const mutation: ReadMutationPayload = kind === "global_read_all" ? { kind }
      : kind === "row_read" ? { kind, scopeId: x.target.id, throughSeq: 10 }
      : kind === "done" ? { kind, scopeId: x.target.id, targetKind: "channel", throughSeq: "10" }
      : { kind, scopeId: x.target.id };
    await x.run(mutation);
    const rows = await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.userId, x.peer.id), inArray(userChannelReadCursors.channelId, [x.joint.channel.id, x.target.id])));
    assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.lastReadSeq === 10));
    const done = await db.execute<{ count: number }>(sql`SELECT count(*)::int count FROM user_channel_inbox_states
      WHERE user_id=${x.peer.id}::uuid AND channel_id=${x.joint.channel.id}::uuid AND done_at IS NOT NULL`);
    assert.equal(done.rows[0]?.count, 0, "reading through Done does not mark the other entry Done");
  });
}

dbTest("own-only unread copies the mark, not cursor positions; later read clears both marks", async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  await db.update(messages).set({ senderId: x.peer.id }).where(eq(messages.channelId, x.joint.jointChannel.canonicalChannelId));
  await db.insert(userChannelReadCursors).values([
    { userId: x.peer.id, channelId: x.joint.channel.id, lastReadSeq: 7 },
    { userId: x.peer.id, channelId: x.target.id, lastReadSeq: 10 },
  ]);
  await x.run({ kind: "row_unread", scopeId: x.target.id, throughSeq: 0 });
  let rows = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  assert.equal(rows.find((row) => row.channelId === x.joint.channel.id)?.lastReadSeq, 7);
  assert.equal(rows.find((row) => row.channelId === x.target.id)?.lastReadSeq, 10);
  assert.ok(rows.every((row) => row.markedUnread));
  await x.run({ kind: "row_read", scopeId: x.target.id, throughSeq: 10 });
  rows = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  assert.ok(rows.every((row) => !row.markedUnread && row.lastReadSeq === 10));
});

dbTest("thread and task reads mirror their own projections without reading the parent or changing follows", async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  for (const child of x.children) {
    const [hostEntry] = await db.insert(channels).values({
      serverId: x.a.id, name: `host-${child.local.type}`, type: child.local.type,
      parentChannelId: x.joint.channel.id, taskId: child.storage.taskId,
    }).returning();
    const [joint] = await db.select().from(jointChannels).where(eq(jointChannels.canonicalChannelId, child.storage.id));
    await db.insert(jointChannelServers).values({ jointChannelId: joint.id, serverId: x.a.id, localChannelId: hostEntry.id, role: "host", status: "active" });
    await x.run({ kind: "row_read", scopeId: child.local.id, throughSeq: 11 });
    const [cursor] = await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.userId, x.peer.id), eq(userChannelReadCursors.channelId, hostEntry.id)));
    assert.equal(cursor?.lastReadSeq, 11);
    const [follow] = (await db.execute<{ count: number }>(sql`SELECT count(*)::int count FROM thread_follows
      WHERE follower_type='user' AND follower_id=${x.peer.id}::uuid AND thread_channel_id=${hostEntry.id}::uuid`)).rows;
    assert.equal(follow.count, 0);
  }
  assert.equal((await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.userId, x.peer.id), eq(userChannelReadCursors.channelId, x.joint.channel.id)))).length, 0);
});

dbTest("durable worker fanout publishes only after commit, only to the reader's matching server rooms, and replay does not write", async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  const sent: Array<{ room: string; event: string; serverId: string; scopes: Array<{ scopeId: string }> }> = [];
  const retractions: Array<{ userId: string; serverId: string }> = [];
  setJointHumanReadRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: { serverId: string; scopes: Array<{ scopeId: string }> }) => {
    sent.push({ room, event, ...payload }); return true;
  } }) } as never, (userId, serverId) => { retractions.push({ userId, serverId }); });
  const mutationId = randomUUID(), mutation = { kind: "row_read", scopeId: x.target.id, throughSeq: 10 } as const;
  await admitReadMutation({ serverId: x.b.id, principalId: x.peer.id, mutationId, mutation });
  const claim = await claimNextReadMutation({ serverId: x.b.id, principalId: x.peer.id, leaseOwner: "fanout-worker" });
  assert.ok(claim);
  await assert.rejects(executeReadMutationClaim({ claim, failpoint: "after_sql_before_commit" }), ReadMutationFailpointError);
  assert.equal(sent.length, 0);
  assert.equal(retractions.length, 0);
  assert.equal((await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id))).length, 0);
  const ack = await executeReadMutationClaim({ claim });
  assert.ok(sent.some((row) => row.serverId === x.a.id && row.scopes[0]?.scopeId === x.joint.channel.id));
  assert.deepEqual(new Set(retractions.map((row) => row.serverId)), new Set([x.a.id, x.b.id]));
  assert.ok(retractions.every((row) => row.userId === x.peer.id));
  for (const row of sent) {
    if (row.event !== "read_state:updated_bulk") continue;
    assert.equal(row.room, `user:${x.peer.id}:server:${row.serverId}`);
    assert.ok(row.scopes.every((scope) => scope.scopeId === (row.serverId === x.a.id ? x.joint.channel.id : x.target.id)));
  }
  const before = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  const replay = await admitReadMutation({ serverId: x.b.id, principalId: x.peer.id, mutationId, mutation });
  assert.equal(replay.terminalDigest, ack.terminalDigest);
  assert.deepEqual(await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id)), before);
  const retractedCount = retractions.length;
  await x.run({ kind: "row_unread", scopeId: x.target.id, throughSeq: 9 });
  assert.equal(retractions.length, retractedCount, "marking unread does not withdraw notifications as though it was read");
});

dbTest("join initialization and agent read positions never fan out human read state", async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  await db.insert(userChannelReadCursors).values({ userId: x.peer.id, channelId: x.joint.channel.id, lastReadSeq: 2 });
  await db.transaction((tx) => raiseReadPositionForJoin(tx, "human", x.peer.id, x.target.id, 10));
  const [unchanged] = await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.userId, x.peer.id), eq(userChannelReadCursors.channelId, x.joint.channel.id)));
  assert.equal(unchanged.lastReadSeq, 2);
  // Deliberately equal UUIDs across kinded identity tables: an agent's id
  // still cannot borrow the human's J membership or touch human cursors.
  await db.insert(agents).values({ id: x.peer.id, serverId: x.a.id, name: "kinded-read-agent" });
  await db.insert(serverAgentMembers).values({ serverId: x.a.id, agentId: x.peer.id, role: "member" });
  await db.insert(channelAgents).values({ channelId: x.joint.channel.id, agentId: x.peer.id });
  await executeCompatibilityReadMutation({ serverId: x.a.id, principalKind: "agent", principalId: x.peer.id,
    mutation: { kind: "row_read", scopeId: x.joint.channel.id, throughSeq: 10 } });
  const humanPositions = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  assert.equal(humanPositions.find((row) => row.channelId === x.joint.channel.id)?.lastReadSeq, 2);
  assert.equal((await db.select().from(agentChannelReadCursors).where(and(eq(agentChannelReadCursors.agentId, x.peer.id), eq(agentChannelReadCursors.channelId, x.target.id)))).length, 0);
});

for (const exclusion of ["guest", "left", "disconnected", "deleted"] as const) {
  dbTest(`fanout does not write an entry excluded by ${exclusion}`, async ({ db, seed }) => {
    const x = await jointHumanReadFixture({ db, seed });
    if (exclusion === "guest") await db.update(serverMembers).set({ role: "guest", guestChannelId: x.joint.channel.id }).where(and(eq(serverMembers.serverId, x.a.id), eq(serverMembers.userId, x.peer.id)));
    if (exclusion === "left") await db.delete(serverMembers).where(and(eq(serverMembers.serverId, x.a.id), eq(serverMembers.userId, x.peer.id)));
    if (exclusion === "disconnected") await db.update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, x.joint.channel.id));
    if (exclusion === "deleted") await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, x.a.id));
    await x.run({ kind: "row_read", scopeId: x.target.id, throughSeq: 10 });
    assert.equal((await db.select().from(userChannelReadCursors).where(and(eq(userChannelReadCursors.userId, x.peer.id), eq(userChannelReadCursors.channelId, x.joint.channel.id)))).length, 0);
  });
}

for (const entryCount of [JOINT_READ_MAX_ENTRIES, JOINT_READ_MAX_ENTRIES + 1]) {
  dbTest(`fanout bounds ${entryCount} eligible entries`, async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  for (let i = 2; i < entryCount; i++) {
    const [server] = await db.insert(servers).values({ ownerId: x.owner.id, name: `extra-${i}`, slug: `extra-${randomUUID()}` }).returning();
    await db.insert(serverMembers).values({ serverId: server.id, userId: x.peer.id, role: "member" });
    const [channel] = await db.insert(channels).values({ serverId: server.id, name: `entry-${i}`, type: "joint" }).returning();
    await db.insert(jointChannelServers).values({ jointChannelId: x.joint.jointChannel.id, serverId: server.id, localChannelId: channel.id, role: "participant", status: "active" });
  }
  const trace = vi.spyOn(tracing, "safeAddTraceEvent");
  await x.run({ kind: "row_read", scopeId: x.target.id, throughSeq: 10 });
  const rows = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  const skipped = trace.mock.calls.filter(([name]) => name === "read_mutation.joint_fanout.skipped");
  if (entryCount > JOINT_READ_MAX_ENTRIES) {
    assert.deepEqual(rows.map((row) => row.channelId), [x.target.id]);
    assert.equal(skipped.length, 1);
    assert.deepEqual(skipped[0]![1](), {
      joint_id: x.joint.jointChannel.id, server_id: x.b.id, reason: "entry_limit", entry_count: entryCount,
    });
  } else {
    assert.equal(rows.length, entryCount);
    assert.ok(rows.every((row) => row.lastReadSeq === 10));
    assert.equal(skipped.length, 0);
  }
  });
}

dbTest("a failing socket or disabled state push does not undo a committed fanout", async ({ db, seed }) => {
  const x = await jointHumanReadFixture({ db, seed });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  setJointHumanReadRealtimeIO({ to: () => { throw new Error("socket unavailable"); } } as never);
  await x.run({ kind: "row_read", scopeId: x.target.id, throughSeq: 10 });
  assert.ok(log.mock.calls.length > 0);
  vi.stubEnv(RECEIVER_STATE_PUSH_ENABLED_ENV, "0");
  await x.run({ kind: "row_unread", scopeId: x.target.id, throughSeq: 9 });
  const rows = await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, x.peer.id));
  assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.lastReadSeq === 9));
});
