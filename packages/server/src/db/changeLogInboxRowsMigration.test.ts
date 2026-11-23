import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { inboxSuppressionStates, inboxTargetMuteStates, users } from "./schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel, setInboxTargetActivityMuteState } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { clearChannelDoneSuppression, writeChannelInboxSuppression } from "../services/inboxSuppressionWriters";
import { logInboxRowChanged } from "../services/messageChangeLog";

// change_log: the `inbox_row` entity (migration change_log_inbox_rows; read by
// GET /api/sync/changes with the inbox_row capability only). A person's Done
// watermark (inbox_suppression_states) and channel / DM mute
// (inbox_target_mute_states) log one row in their user scope, in the writing
// transaction (a rollback logs nothing); bookkeeping and agents log nothing. A
// retracted message logs one in its conversation's channel scope
// (logInboxRowChanged), in the caller's transaction.

type Row = { scope_kind: string; scope_id: string; server_id: string | null; parent_id: string | null; entity: string; entity_id: string; op: string; ref_seq: string | null };

test("change_log logs Done watermarks and mutes of people in their user scope, in the writing transaction; not bookkeeping, not agents", async ({ db }) => {
  const watermark = async () => Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const since = async (from: number) => ((await db.execute(sql`
    SELECT scope_kind, scope_id::text, server_id::text, parent_id::text, entity, entity_id, op, ref_seq::text
    FROM change_log WHERE seq > ${from} ORDER BY seq`)).rows as Row[]).filter((r) => r.entity === "inbox_row");
  const [owner] = await db.insert(users).values({ email: "clir-owner@test.com", name: "clirOwner", passwordHash: "x", emailVerified: true }).returning();
  const server = await createServer("InboxRows", "clir-inbox-rows", owner!.id);
  const channel = await createChannel(server.id, "clir-one");
  await addHuman(channel.id, owner!.id);
  const first = await createMessage(channel.id, "user", owner!.id, "one");
  const second = await createMessage(channel.id, "user", owner!.id, "two");

  // A Done watermark (a public channel: its member and public-mention targets, one row each).
  let mark = await watermark();
  await writeChannelInboxSuppression({ userId: owner!.id, channelId: channel.id, throughActivitySeq: String(first.seq) });
  const written = await since(mark);
  assert.ok(written.length >= 1, "a watermark is logged");
  for (const row of written) {
    assert.deepEqual(row, { scope_kind: "user", scope_id: owner!.id, server_id: server.id, parent_id: null, entity: "inbox_row", entity_id: channel.id, op: "upsert", ref_seq: String(first.seq) });
  }

  mark = await watermark();
  await writeChannelInboxSuppression({ userId: owner!.id, channelId: channel.id, throughActivitySeq: String(first.seq) });
  assert.deepEqual(await since(mark), [], "the same watermark again (done_at / updated_at bookkeeping): nothing");

  mark = await watermark();
  await writeChannelInboxSuppression({ userId: owner!.id, channelId: channel.id, throughActivitySeq: String(second.seq) });
  assert.ok((await since(mark)).every((r) => r.ref_seq === String(second.seq)) && (await since(mark)).length >= 1, "a moved watermark carries the new position");

  mark = await watermark();
  await clearChannelDoneSuppression({ userId: owner!.id, channelId: channel.id });
  const cleared = await since(mark);
  assert.ok(cleared.length >= 1);
  for (const row of cleared) assert.deepEqual([row.scope_id, row.entity_id, row.op, row.ref_seq], [owner!.id, channel.id, "upsert", null], "cleared: no position");

  // Rollback: nothing logged.
  mark = await watermark();
  await assert.rejects(db.transaction(async (tx) => {
    await writeChannelInboxSuppression({ userId: owner!.id, channelId: channel.id, throughActivitySeq: String(first.seq), executor: tx });
    throw new Error("roll back");
  }), /roll back/);
  assert.deepEqual(await since(mark), [], "a rolled-back watermark logs nothing");

  // Another writer's watermark (an unfollow): logged, without a Done position.
  mark = await watermark();
  await db.insert(inboxSuppressionStates).values({
    receiverType: "user", receiverId: owner!.id, serverId: server.id, targetKind: "followed_thread",
    targetChannelId: channel.id, sourceChannelId: channel.id, doneThroughSeq: Number(first.seq), writeSite: "thread.unfollowThreadForFollower",
  });
  assert.deepEqual((await since(mark)).map((r) => [r.entity_id, r.ref_seq]), [[channel.id, null]], "not a Done: no position");

  // An agent's watermark: nothing.
  mark = await watermark();
  await db.insert(inboxSuppressionStates).values({
    receiverType: "agent", receiverId: owner!.id, serverId: server.id, targetKind: "channel",
    targetChannelId: channel.id, sourceChannelId: channel.id, doneThroughSeq: Number(first.seq), writeSite: "test",
  });
  assert.deepEqual(await since(mark), [], "agents have no sync");

  // Mute and unmute.
  mark = await watermark();
  await setInboxTargetActivityMuteState({ receiverType: "user", receiverId: owner!.id, serverId: server.id, sourceChannelId: channel.id, activityMuted: true });
  await setInboxTargetActivityMuteState({ receiverType: "user", receiverId: owner!.id, serverId: server.id, sourceChannelId: channel.id, activityMuted: false });
  assert.deepEqual((await since(mark)).map((r) => [r.scope_kind, r.scope_id, r.server_id, r.entity_id, r.op, r.ref_seq]), [
    ["user", owner!.id, server.id, channel.id, "upsert", null],
    ["user", owner!.id, server.id, channel.id, "upsert", null],
  ], "a mute and an unmute: one row each");

  mark = await watermark();
  await db.update(inboxTargetMuteStates).set({ prefsVersion: sql`${inboxTargetMuteStates.prefsVersion} + 1`, updatedAt: new Date(), pushMuted: false })
    .where(and(eq(inboxTargetMuteStates.receiverId, owner!.id), eq(inboxTargetMuteStates.sourceChannelId, channel.id)));
  assert.deepEqual(await since(mark), [], "prefs bookkeeping and push alone: nothing (Activity does not read them)");

  mark = await watermark();
  await assert.rejects(db.transaction(async (tx) => {
    await tx.update(inboxTargetMuteStates).set({ activityMuted: true, muteFromSeq: Number(second.seq) + 1 })
      .where(and(eq(inboxTargetMuteStates.receiverId, owner!.id), eq(inboxTargetMuteStates.sourceChannelId, channel.id)));
    throw new Error("roll back");
  }), /roll back/);
  assert.deepEqual(await since(mark), [], "a rolled-back mute logs nothing");

  mark = await watermark();
  await db.delete(inboxTargetMuteStates).where(and(eq(inboxTargetMuteStates.receiverId, owner!.id), eq(inboxTargetMuteStates.sourceChannelId, channel.id)));
  assert.deepEqual((await since(mark)).map((r) => [r.entity_id, r.ref_seq]), [[channel.id, null]], "a mute row removed");
});

test("logInboxRowChanged: one inbox_row row in the conversation's channel scope (a thread's parent as parent_id), in the caller's transaction", async ({ db }) => {
  const watermark = async () => Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const since = async (from: number) => ((await db.execute(sql`
    SELECT scope_kind, scope_id::text, server_id::text, parent_id::text, entity, entity_id, op, ref_seq::text
    FROM change_log WHERE seq > ${from} ORDER BY seq`)).rows as Row[]).filter((r) => r.entity === "inbox_row");
  const [owner] = await db.insert(users).values({ email: "clir2-owner@test.com", name: "clir2Owner", passwordHash: "x", emailVerified: true }).returning();
  const server = await createServer("InboxRows2", "clir2-inbox-rows", owner!.id);
  const channel = await createChannel(server.id, "clir2-one");

  let mark = await watermark();
  await db.transaction(async (tx) => { await logInboxRowChanged(tx, { channelId: channel.id }); });
  assert.deepEqual(await since(mark), [
    { scope_kind: "channel", scope_id: channel.id, server_id: server.id, parent_id: null, entity: "inbox_row", entity_id: channel.id, op: "upsert", ref_seq: null },
  ]);

  mark = await watermark();
  await assert.rejects(db.transaction(async (tx) => {
    await logInboxRowChanged(tx, { channelId: channel.id });
    throw new Error("roll back");
  }), /roll back/);
  assert.deepEqual(await since(mark), [], "rolled back with the retraction: nothing");
});
