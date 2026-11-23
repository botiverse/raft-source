import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { SYNC_CAPABILITY_INBOX_ROW, type SyncChange, type SyncChangesResponse, type SyncInboxRowChange } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { type Database } from "../db/index";
import { seedJointChannel } from "../test/integration/jointFixture";
import { featureFlagRules, featureFlags, tasks, userChannelInboxStates, userChannelReadCursors } from "../db/schema";
import { addHuman, archiveChannel, removeHuman, updateChannel, type InboxItem } from "../services/channelService";
import { writeChannelInboxSuppression } from "../services/inboxSuppressionWriters";
import { logInboxRowChanged } from "../services/messageChangeLog";
import * as taskService from "../services/taskService";
import { createTaskConversationsInTransaction } from "../services/taskConversationService";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { createMessage } from "../services/messageService";
import { SYNC_INBOX_ROWS_FEATURE_FLAG_KEY, SYNC_INBOX_STAGING_HELD_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { parseSyncChangesCursor } from "../services/syncChanges";
import {
  __setSyncInboxCapsForTests, __setSyncInboxSourceStatesForTests, __setSyncInboxTargetLatestForTests, SYNC_INBOX_HELD_RETRY_MS, SYNC_INBOX_HOLD_MS, SYNC_INBOX_ROWS_PER_PULL,
  __setSyncInboxHoldMsForTests, withSyncInboxRows, type SyncInboxRowsReader,
} from "../services/syncInboxRows";
import { readSyncChanges } from "../services/syncChanges";
import { messageMentions, servers } from "../db/schema";
import type { ServerId } from "@botiverse/raft-shared";

// GET /api/sync/changes with capabilities=inbox_row (services/syncInboxRows.ts):
// inbox_row changes from the change_log (log arm) and from new messages
// (message arm, the cursor's m<mseq>.<mh> position), and inboxReset. Under
// test the RisingWave Activity read is its Postgres stand-in, so a row's
// target latest seq is Postgres's unless __setSyncInboxTargetLatestForTests
// holds it back. Also the server-only cases of the activity-row contract's
// sync_inbox_row rule (packages/shared/contract-cases/activity-row/README.md):
// sync_own_message_m_advances and sync_held_row_not_sent_m_stops.

const test = createApiTest();

type Client = { get(path: string): Promise<Response> };
type Body = SyncChangesResponse & Record<string, unknown>;

const M_CURSOR = /^c1\.[0-9]+\.[0-9]+\.m[0-9]+\.[0-9]+(\.k)?$/;
const PLAIN_CURSOR = /^c1\.[0-9]+\.[0-9]+(\.k)?$/;

async function sync(client: Client, since?: string, capable = true): Promise<Body> {
  const query = new URLSearchParams();
  if (since !== undefined) query.set("since", since);
  if (capable) query.set("capabilities", `future_thing,${SYNC_CAPABILITY_INBOX_ROW}`);
  const res = await client.get(`/api/sync/changes?${query}`);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as Body;
}

async function inboxRow(client: Client, id: string): Promise<InboxItem | undefined> {
  const res = await client.get(`/api/channels/inbox?ids=${id}`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json() as { items: InboxItem[] }).items[0];
}

async function flagOn(db: Database) {
  await db.insert(featureFlags).values({ key: SYNC_INBOX_ROWS_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: true, randomizationUnit: "server", salt: "sync-inbox-rows" })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
}

async function flagOff(db: Database) {
  await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, SYNC_INBOX_ROWS_FEATURE_FLAG_KEY));
}

const inboxRows = (body: Body) => body.changes.filter((change): change is SyncInboxRowChange & SyncChange => change.entity === "inbox_row");
const rowsOf = (body: Body, id: string) => inboxRows(body).filter((change) => change.id === id);
const messagePosition = (cursor: string) => parseSyncChangesCursor(cursor)?.messages ?? null;

async function setReadCursor(db: Database, userId: string, channelId: string, lastReadSeq: number) {
  await db.insert(userChannelReadCursors).values({ userId, channelId, lastReadSeq })
    .onConflictDoUpdate({ target: [userChannelReadCursors.userId, userChannelReadCursors.channelId], set: { lastReadSeq } });
}

test("flag off or no capability: byte-identical to today; capable: a no-since cursor carries m, an old cursor gets inboxReset init", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);

  // Flag absent: the capability changes nothing.
  const off = await sync(client);
  assert.match(off.cursor, PLAIN_CURSOR);
  assert.equal("inboxReset" in off, false);

  await flagOn(db);
  const plain = await sync(client, undefined, false);
  assert.match(plain.cursor, PLAIN_CURSOR, "flag on, not capable: no message position");
  assert.equal("inboxReset" in plain, false);

  const first = await sync(client);
  assert.match(first.cursor, M_CURSOR, "a capable first pull mints the message position before the snapshots");
  assert.equal(first.inboxReset, null, "no reset: the client takes every snapshot after a first pull anyway");

  // A cursor from before the capability: init, with a position minted now.
  await seed.message({ channel, author: peer, content: "before the position" });
  const upgraded = await sync(client, plain.cursor);
  assert.deepEqual(upgraded.inboxReset, { reason: "init", snapshots: ["inbox"] });
  assert.match(upgraded.cursor, M_CURSOR);
  assert.equal(inboxRows(upgraded).filter((change) => change.op === "upsert" && change.source === "message").length, 0, "init sends no message rows");

  // A capable cursor read without the capability (or with the flag off): m is parsed and dropped.
  const dropped = await sync(client, upgraded.cursor, false);
  assert.match(dropped.cursor, PLAIN_CURSOR);
  await seed.message({ channel, author: peer, content: "after" });
  await setReadCursor(db, owner.id, channel.id, 1);
  await flagOff(db);
  const withM = await sync(client, upgraded.cursor);
  const withoutM = await sync(client, upgraded.cursor.replace(/\.m[0-9]+\.[0-9]+/, ""), false);
  assert.deepEqual(withM, withoutM, "flag off: the same response with or without m and the capability");
  assert.equal(inboxRows(withM).length, 0);
});

test("sync_own_message_m_advances: the viewer's own message is a message-arm upsert (the ?ids= row) at the cursor seq; m passes it", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);

  const own = await createMessage(channel.id, "user", owner.id, "my own message");
  const round = await sync(client, start.cursor);
  const rows = rowsOf(round, channel.id);
  assert.equal(rows.length, 1, `one change per row id: ${JSON.stringify(inboxRows(round))}`);
  const change = rows[0]!;
  assert.ok(change.op === "upsert");
  assert.equal(change.source, "message");
  assert.deepEqual(change.row, await inboxRow(client, channel.id), "the row is GET /channels/inbox?ids='s");
  assert.equal(change.seq, Number(parseSyncChangesCursor(round.cursor)!.seq), "at the response's change_log cursor seq");
  assert.equal(round.changes.at(-1), change, "after the log's changes");
  assert.ok(messagePosition(round.cursor)!.seq >= BigInt(own.seq), "m passes the message");

  const again = await sync(client, round.cursor);
  assert.deepEqual(rowsOf(again, channel.id), [], "nothing new: the message is not sent again");
  assert.equal(again.inboxReset, null);
});

test("sync_held_row_not_sent_m_stops: a row whose read model is behind is held; it goes once caught up; held too long resets with a fresh m", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const other = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const behind = (latest: ReadonlyMap<string, string>) => new Map([...latest].filter(([id]) => id !== channel.id));

  const held = await seed.message({ channel, author: peer, content: "not in the read model yet" });
  const fine = await seed.message({ channel: other, author: peer, content: "in the read model" });
  __setSyncInboxTargetLatestForTests(behind);
  try {
    const round = await sync(client, start.cursor);
    assert.deepEqual(rowsOf(round, channel.id), [], "held: not sent");
    assert.equal(rowsOf(round, other.id).length, 1, "control: a caught-up row goes");
    assert.equal(messagePosition(round.cursor)!.seq, BigInt(held.seq) - 1n, "m stops before the held conversation's first new message");
    assert.ok(BigInt(fine.seq) > BigInt(held.seq));
    assert.equal(round.inboxReset, null);
    assert.equal(round.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS, "held: pull again soon");
    assert.equal(round.hasMore, false, "not hasMore: that would loop while the row is not ready");

    __setSyncInboxTargetLatestForTests(null);
    const caughtUp = await sync(client, round.cursor);
    const sent = rowsOf(caughtUp, channel.id);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.op === "upsert" && sent[0]!.source === "message");
    assert.ok(messagePosition(caughtUp.cursor)!.seq >= BigInt(fine.seq));
    assert.equal("retryAfterMs" in caughtUp, false, "nothing held: no retry hint");

    // Held past SYNC_INBOX_HOLD_MS (its newest message is 40 s old): inboxReset, and m moves on.
    const stale = await seed.message({ channel, author: peer, content: "stuck" });
    await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 seconds' WHERE id = ${stale.id}::uuid`);
    __setSyncInboxTargetLatestForTests(behind);
    const stuck = await sync(client, caughtUp.cursor);
    assert.deepEqual(stuck.inboxReset, { reason: "held_too_long", snapshots: ["inbox"] });
    assert.equal(stuck.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS, "snapshot after a delay, not from the lagging read model at once");
    assert.ok(messagePosition(stuck.cursor)!.seq >= BigInt(stale.seq), "a fresh position, so a stuck read model does not reset every pull");
    const after = await sync(client, stuck.cursor);
    assert.equal(after.inboxReset, null);
  } finally {
    __setSyncInboxTargetLatestForTests(null);
  }
});

async function reserveSeq(db: Database): Promise<number> {
  const result = await db.execute(sql`SELECT nextval(pg_get_serial_sequence('messages', 'seq')) AS seq`);
  return Number((result.rows[0] as { seq: unknown }).seq);
}

test("a message that commits after the pull passed its seq (late) is delivered by the next pull", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const slow = await seed.channel({ server, members: [owner, peer] });
  const fast = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);

  const lateSeq = await reserveSeq(db);
  const b = await seed.message({ channel: fast, author: peer, content: "b" });
  const first = await sync(client, start.cursor);
  assert.equal(rowsOf(first, fast.id).length, 1);
  assert.ok(messagePosition(first.cursor)!.seq >= BigInt(b.seq), "control: m passed the late seq");

  await db.execute(sql`
    INSERT INTO messages (id, seq, channel_id, sender_type, sender_id, content)
    VALUES (${randomUUID()}, ${lateSeq}, ${slow.id}, 'user', ${peer.id}, 'a (late)')
  `);
  const second = await sync(client, first.cursor);
  const late = rowsOf(second, slow.id);
  assert.equal(late.length, 1, JSON.stringify(inboxRows(second)));
  assert.ok(late[0]!.op === "upsert" && late[0]!.source === "message");
  assert.deepEqual(late[0]!.row, await inboxRow(client, slow.id));
});

test("too_many: past the cap of conversations with news, inboxReset too_many with a fresh m and no message rows", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const a = await seed.channel({ server, members: [owner, peer] });
  const b = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  await seed.message({ channel: a, author: peer, content: "a" });
  const last = await seed.message({ channel: b, author: peer, content: "b" });
  __setSyncInboxCapsForTests({ newsCap: 1 });
  try {
    const round = await sync(client, start.cursor);
    assert.deepEqual(round.inboxReset, { reason: "too_many", snapshots: ["inbox"] });
    assert.equal(inboxRows(round).length, 0);
    assert.ok(messagePosition(round.cursor)!.seq >= BigInt(last.seq));
    const next = await sync(client, round.cursor);
    assert.equal(next.inboxReset, null);
  } finally {
    __setSyncInboxCapsForTests({ newsCap: null });
  }
});

test("joint channels are not in the message arm", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const plain = await seed.channel({ server, members: [owner, peer] });
  const joint = await seedJointChannel({ name: "joint-room", serverIds: [server.id], createdByUserId: owner.id });
  const projection = joint.projections[0]!;
  await addHuman(projection.id, owner.id);
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  await createMessage(joint.canonical.id, "user", peer.id, "in the joint");
  await seed.message({ channel: plain, author: peer, content: "control" });
  const round = await sync(client, start.cursor);
  const messageRows = inboxRows(round).filter((change) => change.op === "upsert" && change.source === "message");
  assert.deepEqual(messageRows.map((change) => change.id), [plain.id], "the joint's projection and storage are left out");
});

test("log arm: a read is an upsert after its conversation change; Done a delete at the frontier; leaving a delete, unless re-added in the same pull", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const room = await seed.channel({ server, members: [owner, peer], visibility: "private" });
  const latest = await seed.message({ channel, author: peer, content: "hello" });
  await seed.message({ channel: room, author: peer, content: "in the room" });
  const client = http.as(owner, server);
  await flagOn(db);
  let cursor = (await sync(client)).cursor;

  // A read move: the conversation change as today, and right after it the row.
  await setReadCursor(db, owner.id, channel.id, Number(latest.seq));
  let round = await sync(client, cursor);
  const conversationAt = round.changes.findIndex((change) => change.entity === "conversation" && change.id === channel.id);
  assert.ok(conversationAt >= 0, "the conversation change still comes");
  const read = round.changes[conversationAt + 1];
  assert.ok(read && read.entity === "inbox_row" && read.op === "upsert", JSON.stringify(round.changes));
  assert.equal(read.source, "log");
  assert.equal(read.seq, round.changes[conversationAt]!.seq);
  assert.deepEqual(read.row, await inboxRow(client, channel.id));
  cursor = round.cursor;

  // Done: the row leaves the inbox; a delete at the conversation's latest seq.
  await db.insert(userChannelInboxStates).values({ userId: owner.id, channelId: channel.id, doneAt: new Date() });
  round = await sync(client, cursor);
  assert.equal(await inboxRow(client, channel.id), undefined, "control: Done left the inbox");
  assert.deepEqual(rowsOf(round, channel.id).map(({ seq: _seq, ...rest }) => rest), [
    { entity: "inbox_row", id: channel.id, op: "delete", position: String(latest.seq), reason: "done" },
  ]);
  cursor = round.cursor;

  // Leaving the private room: a left delete, no position.
  await removeHuman(room.id, owner.id, { self: true });
  round = await sync(client, cursor);
  assert.deepEqual(rowsOf(round, room.id).map(({ seq: _seq, ...rest }) => rest), [
    { entity: "inbox_row", id: room.id, op: "delete", position: null, reason: "left" },
  ]);
  cursor = round.cursor;

  // Re-added before the pull: the re-read finds the row, so an upsert, not a delete.
  await addHuman(room.id, owner.id);
  await removeHuman(room.id, owner.id, { self: true });
  await addHuman(room.id, owner.id);
  round = await sync(client, cursor);
  const back = rowsOf(round, room.id);
  assert.equal(back.length, 1, `one change per row id: ${JSON.stringify(back)}`);
  assert.equal(back[0]!.op, "upsert");
});

test("rollback: a cursor whose m part an older server could not parse is 400 invalid_cursor (the client drops it and resnapshots)", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const plain = start.cursor.replace(/\.m[0-9]+\.[0-9]+/, "");
  for (const bad of [`${plain}.mX.Y`, `${plain}.m1`, `${plain}.m01.2`, `${plain}.k.m1.2`]) {
    for (const capable of [true, false]) {
      const query = new URLSearchParams({ since: bad, ...(capable ? { capabilities: SYNC_CAPABILITY_INBOX_ROW } : {}) });
      const res = await client.get(`/api/sync/changes?${query}`);
      assert.equal(res.status, 400, bad);
      assert.equal((await res.json() as { code?: string }).code, "invalid_cursor", bad);
    }
  }
  // A valid m part read by a non-capable request: accepted, answered without it.
  const accepted = await sync(client, start.cursor, false);
  assert.match(accepted.cursor, PLAIN_CURSOR);
});

test("a late-committed mention of the viewer in a channel they have not joined is delivered", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const open = await seed.channel({ server, members: [owner] });
  const mine = await seed.channel({ server, members: [owner, viewer] });
  const client = http.as(viewer, server);
  await flagOn(db);
  const start = await sync(client);
  const lateSeq = await reserveSeq(db);
  await seed.message({ channel: mine, author: owner, content: "moves m past the late seq" });
  const first = await sync(client, start.cursor);
  assert.ok(messagePosition(first.cursor)!.seq > BigInt(lateSeq));

  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO messages (id, seq, channel_id, sender_type, sender_id, content)
      VALUES (${id}, ${lateSeq}, ${open.id}, 'user', ${owner.id}, 'hey @viewer (late)')
    `);
    await tx.insert(messageMentions).values({
      messageId: id, messageSeq: lateSeq, serverId: server.id, channelId: open.id, targetType: "user", targetId: viewer.id, handleAtSendTime: "viewer", notifiedAt: new Date(),
    });
  });
  // What ?ids= answers for it now: recorded, and what sync must agree with (no row: no upsert).
  const listed = await inboxRow(client, open.id);
  // Whether the Activity read lists a mention-only row is its own rule; the arm must ask for it.
  const asked: string[] = [];
  const row = { ...(await inboxRow(client, mine.id))!, channelId: open.id } as InboxItem;
  const result = await pullWith(viewer, server.id, first.cursor, async (ids) => {
    asked.push(...ids);
    return { items: ids.includes(open.id) ? [row] : [], backend: "postgres" };
  });
  assert.ok(asked.includes(open.id), `the late mention's conversation is read: ${JSON.stringify(asked)}`);
  // Through the route (the real read): sync and ?ids= agree on this row.
  const routed = await sync(client, first.cursor);
  assert.deepEqual(rowsOf(routed, open.id).map((change) => (change.op === "upsert" ? change.row : null)), listed ? [listed] : [], "sync sends exactly the ?ids= row (none when ?ids= lists none)");
  const late = result.changes.filter((change) => change.entity === "inbox_row" && change.id === open.id);
  assert.equal(late.length, 1, JSON.stringify(result.changes));
  assert.ok(late[0]!.entity === "inbox_row" && late[0]!.op === "upsert" && late[0]!.source === "message");
});

test("a held row from the late rows keeps mh, so the late row is read again", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const slow = await seed.channel({ server, members: [owner, peer] });
  const fast = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const lateSeq = await reserveSeq(db);
  await seed.message({ channel: fast, author: peer, content: "b" });
  const first = await sync(client, start.cursor);
  await db.execute(sql`
    INSERT INTO messages (id, seq, channel_id, sender_type, sender_id, content)
    VALUES (${randomUUID()}, ${lateSeq}, ${slow.id}, 'user', ${peer.id}, 'late')
  `);
  __setSyncInboxTargetLatestForTests((latest) => new Map([...latest].filter(([id]) => id !== slow.id)));
  try {
    const held = await sync(client, first.cursor);
    assert.deepEqual(rowsOf(held, slow.id), []);
    assert.deepEqual(messagePosition(held.cursor), messagePosition(first.cursor), "mseq and mh both stay: the late row is below mseq");
    __setSyncInboxTargetLatestForTests(null);
    const released = await sync(client, held.cursor);
    assert.equal(rowsOf(released, slow.id).length, 1, "read again from the kept mh");
  } finally {
    __setSyncInboxTargetLatestForTests(null);
  }
});

test("the 51st conversation pages: 50 rows and hasMore, m before the 51st; then the 51st", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const rooms = [];
  for (let i = 0; i <= SYNC_INBOX_ROWS_PER_PULL; i += 1) rooms.push(await seed.channel({ server, members: [owner, peer] }));
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const posted = [];
  for (const room of rooms) posted.push(await seed.message({ channel: room, author: peer, content: "news" }));
  const first = await sync(client, start.cursor);
  const sent = inboxRows(first).filter((change) => change.op === "upsert" && change.source === "message").map((change) => change.id);
  assert.equal(sent.length, SYNC_INBOX_ROWS_PER_PULL);
  assert.deepEqual(new Set(sent), new Set(rooms.slice(0, SYNC_INBOX_ROWS_PER_PULL).map((room) => room.id)), "the smallest new seqs first");
  assert.equal(first.hasMore, true);
  const last = posted[SYNC_INBOX_ROWS_PER_PULL]!;
  assert.equal(messagePosition(first.cursor)!.seq, BigInt(last.seq) - 1n);
  const second = await sync(client, first.cursor);
  assert.deepEqual(inboxRows(second).filter((change) => change.op === "upsert").map((change) => change.id), [rooms.at(-1)!.id]);
  assert.equal(second.hasMore, false);
});

test("the walk pages at its cap; messages behind the plan's history window are not news", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const old = await seed.channel({ server, members: [owner, peer] });
  const a = await seed.channel({ server, members: [owner, peer] });
  const b = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const behind = await seed.message({ channel: old, author: peer, content: "behind the window" });
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${behind.id}::uuid`);
  await seed.message({ channel: a, author: peer, content: "a" });
  await seed.message({ channel: b, author: peer, content: "b" });
  __setSyncInboxCapsForTests({ scanCap: 2 });
  try {
    const first = await sync(client, start.cursor);
    assert.deepEqual(inboxRows(first).map((change) => change.id), [a.id], "two messages walked: the old one is not news, a is");
    assert.equal(first.hasMore, true, "the walk stopped at its cap");
    const second = await sync(client, first.cursor);
    assert.deepEqual(inboxRows(second).map((change) => change.id), [b.id]);
    assert.equal(second.hasMore, false);
  } finally {
    __setSyncInboxCapsForTests({ scanCap: null });
  }
});

/** The capable part of a pull, driven directly with a stand-in row reader. */
async function pullWith(viewer: { id: string }, serverId: string, cursor: string, readRows: SyncInboxRowsReader, alsoKeep: (change: { entity: string }) => boolean = () => false) {
  const since = parseSyncChangesCursor(cursor)!;
  const syncViewer = { userId: viewer.id, serverId: serverId as ServerId, isGuest: false };
  const read = await readSyncChanges({ viewer: syncViewer, since, limit: 100, inboxRows: true });
  // Conversation and scope changes go out as read (the route's builders only rebuild row entities).
  const changes = read.changes.filter((change) => change.entity === "conversation" || change.entity === "scope" || alsoKeep(change)) as SyncChange[];
  return withSyncInboxRows({ viewer: syncViewer, since, read, changes, readRows });
}

test("Done before the read model applied it: the stale row is a delete, and the message arm does not bring it back", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const latest = await seed.message({ channel, author: peer, content: "news, then Done" });
  const stale = await inboxRow(client, channel.id);
  assert.ok(stale && stale.latestActivitySeq === String(latest.seq), "control: the row before Done");
  await db.insert(userChannelInboxStates).values({ userId: owner.id, channelId: channel.id, doneAt: new Date() });
  // A read model that has not applied the Done: the row is still there.
  const result = await pullWith(owner, server.id, start.cursor, async () => ({ items: [stale], backend: "postgres" }));
  assert.deepEqual(result.changes.filter((change) => change.entity === "inbox_row").map(({ seq: _seq, ...rest }) => rest), [
    { entity: "inbox_row", id: channel.id, op: "delete", position: String(latest.seq), reason: "done" },
  ]);
});

test("a failed row read does not fail the pull: the log's changes as before, m unchanged, no inbox_row", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const message = await seed.message({ channel, author: peer, content: "news" });
  await setReadCursor(db, owner.id, channel.id, Number(message.seq));
  const result = await pullWith(owner, server.id, start.cursor, async () => { throw new Error("rw overloaded"); });
  assert.equal(result.stats.failed, true);
  assert.equal(result.inboxReset, null);
  assert.deepEqual(messagePosition(result.cursor), messagePosition(start.cursor), "nothing skipped: the position stays");
  assert.ok(result.changes.some((change) => change.entity === "conversation" && change.id === channel.id), "the conversation change still goes");
  assert.equal(result.changes.filter((change) => change.entity === "inbox_row").length, 0);
});

test("too_many counts the walk's messages of this server only, not other servers'", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const elsewhere = await seed.server({ owner: peer, members: [owner] });
  const here = await seed.channel({ server, members: [owner, peer] });
  const there = await seed.channel({ server: elsewhere, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  await seed.message({ channel: here, author: peer, content: "one here" });
  for (let i = 0; i < 3; i += 1) await seed.message({ channel: there, author: peer, content: `elsewhere ${i}` });
  __setSyncInboxCapsForTests({ backlogCap: 1 });
  try {
    const round = await sync(client, start.cursor);
    assert.equal(round.inboxReset, null, "another server's messages are not this server's backlog");
    assert.deepEqual(inboxRows(round).map((change) => change.id), [here.id]);
    const last = await seed.message({ channel: here, author: peer, content: "two here" });
    await seed.message({ channel: here, author: peer, content: "three here" });
    const over = await sync(client, round.cursor);
    assert.deepEqual(over.inboxReset, { reason: "too_many", snapshots: ["inbox"] });
    assert.equal(inboxRows(over).length, 0);
    assert.ok(messagePosition(over.cursor)!.seq > BigInt(last.seq), "a fresh position");
  } finally {
    __setSyncInboxCapsForTests({ backlogCap: null });
  }
});

test("a late window past its cap is too_many before the late scan, with a fresh position", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const slow = await seed.channel({ server, members: [owner, peer] });
  const fast = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const lateSeq = await reserveSeq(db);
  const b = await seed.message({ channel: fast, author: peer, content: "b" });
  const first = await sync(client, start.cursor);
  await db.execute(sql`
    INSERT INTO messages (id, seq, channel_id, sender_type, sender_id, content)
    VALUES (${randomUUID()}, ${lateSeq}, ${slow.id}, 'user', ${peer.id}, 'late')
  `);
  __setSyncInboxCapsForTests({ lateBacklogCap: 0 });
  try {
    const round = await sync(client, first.cursor);
    assert.deepEqual(round.inboxReset, { reason: "too_many", snapshots: ["inbox"] });
    assert.equal(inboxRows(round).length, 0);
    assert.ok(messagePosition(round.cursor)!.seq >= BigInt(b.seq));
  } finally {
    __setSyncInboxCapsForTests({ lateBacklogCap: null });
  }
});

test("a held conversation at the position with a full walk does not page: hasMore false, retryAfterMs set", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const first = await seed.channel({ server, members: [owner, peer] });
  const second = await seed.channel({ server, members: [owner, peer] });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const heldMessage = await seed.message({ channel: first, author: peer, content: "held" });
  await seed.message({ channel: second, author: peer, content: "not walked yet" });
  __setSyncInboxCapsForTests({ scanCap: 1 });
  __setSyncInboxTargetLatestForTests((latest) => new Map([...latest].filter(([id]) => id !== first.id)));
  try {
    // At most one page can move the position up to the held message; then paging stops.
    let round = await sync(client, start.cursor);
    let pulls = 1;
    while (round.hasMore && pulls < 5) {
      round = await sync(client, round.cursor);
      pulls += 1;
    }
    assert.ok(pulls <= 2, `pulls: ${pulls}`);
    assert.deepEqual(inboxRows(round), [], "the one walked conversation is held");
    assert.equal(messagePosition(round.cursor)!.seq, BigInt(heldMessage.seq) - 1n, "the position stops before the held message");
    assert.equal(round.hasMore, false, "no back-to-back pulls while the position cannot move");
    assert.equal(round.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS);
    const again = await sync(client, round.cursor);
    assert.equal(again.hasMore, false);
    assert.deepEqual(messagePosition(again.cursor)!.seq, messagePosition(round.cursor)!.seq);
  } finally {
    __setSyncInboxCapsForTests({ scanCap: null });
    __setSyncInboxTargetLatestForTests(null);
  }
});

// ---------------------------------------------------------------------------
// PR2: the `inbox_row` log rows (a Done watermark without a Done marker, a
// mute, a retracted message), channel and task changes, and the staging hold.
// ---------------------------------------------------------------------------

type Conversation = Extract<SyncChange, { entity: "conversation" }>;
const conversationOf = (body: { changes: readonly SyncChange[] }, id: string) =>
  body.changes.find((change): change is Conversation => change.entity === "conversation" && change.id === id);
const withoutSeq = (changes: readonly SyncChange[]) => changes.map(({ seq: _seq, ...rest }) => rest);

/** Through the route: the one inbox_row for `id` is the ?ids= row (an upsert), or none when ?ids= lists none. */
async function expectListedUpsert(client: Client, body: Body, id: string, message: string) {
  const listed = await inboxRow(client, id);
  assert.deepEqual(withoutSeq(rowsOf(body, id)), listed ? [{ entity: "inbox_row", id, op: "upsert", row: listed, source: "log" }] : [], message);
  return listed;
}

test("a Done watermark without a Done marker (a mention Done, a Done under newer activity) is a conversation change and its row; not capable or flag off: nothing, the cursor unmoved", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const first = await seed.message({ channel, author: peer, content: "first" });
  await seed.message({ channel, author: peer, content: "newer than the Done" });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const plain = await sync(client, undefined, false);

  await writeChannelInboxSuppression({ userId: owner.id, channelId: channel.id, throughActivitySeq: String(first.seq) });

  const quiet = await sync(client, plain.cursor, false);
  assert.deepEqual(quiet.changes, [], "not capable: the inbox_row log rows are not read");
  assert.equal(parseSyncChangesCursor(quiet.cursor)!.seq, parseSyncChangesCursor(plain.cursor)!.seq, "not capable: the cursor does not move over them");

  const round = await sync(client, start.cursor);
  const conversation = conversationOf(round, channel.id);
  assert.ok(conversation, JSON.stringify(round.changes));
  assert.equal(conversation.refSeq, null);
  assert.equal("done" in conversation || "read" in conversation, false, "no state kind: the watermark is none of them");
  const listed = await expectListedUpsert(client, round, channel.id, "newer activity keeps the row: an upsert of what ?ids= answers");
  assert.ok(listed, "control: the row stays (a message past the watermark)");
  assert.equal(round.changes[round.changes.indexOf(conversation) + 1], rowsOf(round, channel.id)[0], "right after its conversation change");

  await flagOff(db);
  const off = await sync(client, start.cursor);
  const offPlain = await sync(client, start.cursor.replace(/\.m[0-9]+\.[0-9]+/, ""), false);
  assert.deepEqual(off, offPlain, "flag off: as not capable");
  assert.equal(conversationOf(off, channel.id), undefined);
});

test("a Done watermark at the row's latest message: a done delete at the watermark when the row is gone or the read model still shows it", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const latest = await seed.message({ channel, author: peer, content: "mention me" });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const stale = await inboxRow(client, channel.id);
  assert.ok(stale && stale.latestActivitySeq === String(latest.seq), "control: the row before the Done");

  await writeChannelInboxSuppression({ userId: owner.id, channelId: channel.id, throughActivitySeq: String(latest.seq) });
  const expected = [{ entity: "inbox_row", id: channel.id, op: "delete", position: String(latest.seq), reason: "done" }];
  const lagging = await pullWith(owner, server.id, start.cursor, async () => ({ items: [stale], backend: "postgres" }));
  assert.deepEqual(withoutSeq(lagging.changes.filter((change) => change.entity === "inbox_row")), expected, "the read model has not applied it");
  const gone = await pullWith(owner, server.id, start.cursor, async () => ({ items: [], backend: "postgres" }));
  assert.deepEqual(withoutSeq(gone.changes.filter((change) => change.entity === "inbox_row")), expected, "the row is gone");

  // A rolled-back watermark logs nothing: the next pull has no change for the row.
  const after = (await sync(client, start.cursor)).cursor;
  await assert.rejects(db.transaction(async (tx) => {
    await writeChannelInboxSuppression({ userId: owner.id, channelId: channel.id, throughActivitySeq: String(latest.seq), executor: tx });
    throw new Error("roll back");
  }), /roll back/);
  const quiet = await sync(client, after);
  assert.equal(conversationOf(quiet, channel.id), undefined);
  assert.deepEqual(rowsOf(quiet, channel.id), []);
});

test("mention Done through POST /inbox/done on a mention-only row of a channel the viewer has not joined: sync's row agrees with ?ids=", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const open = await seed.channel({ server, members: [owner] });
  const mention = await seed.message({ channel: open, author: owner, content: "hey viewer" });
  await db.insert(messageMentions).values({
    messageId: mention.id, messageSeq: Number(mention.seq), serverId: server.id, channelId: open.id, targetType: "user", targetId: viewer.id, handleAtSendTime: "viewer", notifiedAt: new Date(),
  }).onConflictDoNothing();
  const client = http.as(viewer, server);
  await flagOn(db);
  const start = await sync(client);

  const done = await client.request("/api/channels/inbox/done", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId: open.id, throughActivitySeq: String(mention.seq), frontierSpace: "storage" }),
  });
  assert.equal(done.status, 200, await done.clone().text());

  const round = await sync(client, start.cursor);
  assert.ok(conversationOf(round, open.id), `the Done reaches sync: ${JSON.stringify(round.changes)}`);
  const listed = await inboxRow(client, open.id);
  const rows = withoutSeq(rowsOf(round, open.id));
  assert.deepEqual(rows, listed
    ? [{ entity: "inbox_row", id: open.id, op: "upsert", row: listed, source: "log" }]
    : [{ entity: "inbox_row", id: open.id, op: "delete", position: String(mention.seq), reason: "done" }]);
});

test("mute and unmute (PATCH notification-settings): logged before the response; a conversation change and the ?ids= row; not capable: nothing", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  await seed.message({ channel, author: peer, content: "before the mute" });
  const client = http.as(owner, server);
  await flagOn(db);
  let cursor = (await sync(client)).cursor;
  const plain = await sync(client, undefined, false);
  const setMuted = async (activityMuted: boolean) => {
    const res = await client.request(`/api/channels/${channel.id}/notification-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activityMuted }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };

  for (const muted of [true, false]) {
    const before = Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m as string);
    await setMuted(muted);
    // The response (and the realtime notification_prefs:updated before it) comes after the commit.
    const logged = await db.execute(sql`SELECT count(*)::int AS n FROM change_log WHERE seq > ${before} AND entity = 'inbox_row' AND scope_kind = 'user' AND scope_id = ${owner.id}::uuid AND entity_id = ${channel.id}`);
    assert.equal(Number((logged.rows[0] as { n: unknown }).n), 1, `${muted ? "mute" : "unmute"}: one row, committed`);
    const round = await sync(client, cursor);
    assert.ok(conversationOf(round, channel.id), JSON.stringify(round.changes));
    await expectListedUpsert(client, round, channel.id, muted ? "muted: the row as ?ids= answers it" : "unmuted");
    cursor = round.cursor;
  }
  const quiet = await sync(client, plain.cursor, false);
  assert.deepEqual(quiet.changes, []);
});

test("a retracted message (logInboxRowChanged in its channel's scope): every capable member gets the row; not capable: nothing", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const message = await seed.message({ channel, author: peer, content: "soon retracted" });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const plain = await sync(client, undefined, false);

  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE messages SET content = 'retracted', deleted_at = now() WHERE id = ${message.id}::uuid`);
    await logInboxRowChanged(tx, { channelId: channel.id });
  });
  const round = await sync(client, start.cursor);
  assert.ok(conversationOf(round, channel.id), JSON.stringify(round.changes));
  await expectListedUpsert(client, round, channel.id, "the row as ?ids= answers it after the retraction");
  assert.deepEqual((await sync(client, plain.cursor, false)).changes, []);
});

test("a channel renamed is its row's upsert (new name); archived, a left delete once the row is gone", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  await seed.message({ channel, author: peer, content: "hello" });
  const client = http.as(owner, server);
  await flagOn(db);
  let cursor = (await sync(client)).cursor;

  await updateChannel(channel.id, { name: `renamed-${randomUUID().slice(0, 6)}` });
  let round = await sync(client, cursor);
  const listed = await expectListedUpsert(client, round, channel.id, "renamed: the row with its new name");
  assert.ok(listed && listed.kind !== "thread" && listed.kind !== "task" && listed.channelName.startsWith("renamed-"), "control: the row shows the new name");
  cursor = round.cursor;

  await archiveChannel(channel.id, owner.id);
  round = await sync(client, cursor);
  assert.equal(await inboxRow(client, channel.id), undefined, "control: an archived channel leaves Activity");
  assert.ok(round.changes.some((change) => change.entity === "channel" && change.id === channel.id && change.op === "delete"), "control: the archive is a channel delete");
  assert.deepEqual(withoutSeq(rowsOf(round, channel.id)), [{ entity: "inbox_row", id: channel.id, op: "delete", position: null, reason: "left" }]);
});

test("archived in the same pull as the viewer's own change of that row (a read; a leave and re-add, which coalesces to the re-add): still a left delete, after the channel delete", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const read = await seed.channel({ server, members: [owner, peer] });
  const back = await seed.channel({ server, members: [owner, peer], visibility: "private" });
  const latest = await seed.message({ channel: read, author: peer, content: "read, then archived" });
  await seed.message({ channel: back, author: peer, content: "left, re-added, then archived" });
  const client = http.as(owner, server);
  await flagOn(db);
  const cursor = (await sync(client)).cursor;

  await setReadCursor(db, owner.id, read.id, Number(latest.seq));
  await removeHuman(back.id, owner.id, { self: true });
  await addHuman(back.id, owner.id);
  await archiveChannel(read.id, owner.id);
  await archiveChannel(back.id, peer.id);
  const round = await sync(client, cursor);
  for (const channel of [read, back]) {
    assert.equal(await inboxRow(client, channel.id), undefined, "control: an archived channel leaves Activity");
    const archivedAt = round.changes.findIndex((change) => change.entity === "channel" && change.id === channel.id && change.op === "delete");
    assert.ok(archivedAt >= 0, `control: the archive is a channel delete: ${JSON.stringify(round.changes)}`);
    assert.deepEqual(withoutSeq(rowsOf(round, channel.id)), [{ entity: "inbox_row", id: channel.id, op: "delete", position: null, reason: "left" }], JSON.stringify(round.changes));
    const rowAt = round.changes.findIndex((change) => change.entity === "inbox_row" && change.id === channel.id);
    assert.ok(rowAt > archivedAt, "the row's delete comes after the channel delete");
  }
});

test("a task's status change reads its conversation's row (the ?ids= row, if any)", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "Sync the status" }]);
  assert.ok(task);
  const created = await createTaskConversationsInTransaction(db, { tasks: [{ id: task.id, channelId: channel.id }], storageChannel: { id: channel.id, serverId: server.id, type: "channel" }, initiatingServerId: server.id });
  const conversationId = created.get(task.id)?.canonicalChannelId ?? (await db.execute(sql`SELECT id::text AS id FROM channels WHERE task_id = ${task.id}::uuid AND type = 'task'`)).rows.map((row) => (row as { id: string }).id)[0];
  assert.ok(conversationId, "control: the task has a conversation");
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);

  await db.update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, task.id));
  const asked: string[] = [];
  await pullWith(owner, server.id, start.cursor, async (ids) => {
    asked.push(...ids);
    return { items: [], backend: "postgres" };
  }, (change) => change.entity === "task");
  assert.ok(asked.includes(conversationId.toLowerCase()), `the task conversation's row is read: ${JSON.stringify(asked)}`);
  const round = await sync(client, start.cursor);
  await expectListedUpsert(client, round, conversationId.toLowerCase(), "the row as ?ids= answers it (none: no change)");
});

test("staging testing aid: the staging-held flag holds every message row of the servers it is on (retryAfterMs), then held_too_long past the hold; never read off staging", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const other = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const otherChannel = await seed.channel({ server: other, members: [owner] });
  const client = http.as(owner, server);
  const otherClient = http.as(owner, other);
  await flagOn(db);
  // On for `server` only (a server rule naming it), as FFA sets it on staging.
  await db.insert(featureFlags).values({ key: SYNC_INBOX_STAGING_HELD_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: false, randomizationUnit: "server", salt: "sync-inbox-staging-held" }).onConflictDoNothing();
  await db.insert(featureFlagRules).values({ id: randomUUID(), flagKey: SYNC_INBOX_STAGING_HELD_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  const saved = process.env.DEPLOYMENT_ENV;
  try {
    // Not staging: the flag is not read.
    process.env.DEPLOYMENT_ENV = "production";
    let cursor = (await sync(client)).cursor;
    await seed.message({ channel, author: peer, content: "production" });
    let round = await sync(client, cursor);
    assert.equal(rowsOf(round, channel.id).length, 1, "off staging: the row goes");
    assert.equal("retryAfterMs" in round, false);
    cursor = round.cursor;

    process.env.DEPLOYMENT_ENV = "staging";
    let otherCursor = (await sync(otherClient)).cursor;
    await seed.message({ channel: otherChannel, author: owner, content: "not held elsewhere" });
    const otherRound = await sync(otherClient, otherCursor);
    assert.equal(rowsOf(otherRound, otherChannel.id).length, 1, "a server the flag is off for: the row goes");
    assert.equal("retryAfterMs" in otherRound, false);

    await seed.message({ channel, author: peer, content: "held on staging" });
    round = await sync(client, cursor);
    assert.deepEqual(rowsOf(round, channel.id), [], "held");
    assert.equal(round.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS);
    assert.equal(round.inboxReset, null);

    __setSyncInboxHoldMsForTests(0);
    round = await sync(client, round.cursor);
    assert.deepEqual(round.inboxReset, { reason: "held_too_long", snapshots: ["inbox"] });
    assert.equal(round.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS);
  } finally {
    __setSyncInboxHoldMsForTests(null);
    if (saved === undefined) delete process.env.DEPLOYMENT_ENV; else process.env.DEPLOYMENT_ENV = saved;
  }
});

/** The seq of the newest inbox_row change_log row of `userId` for `id`. */
async function lastInboxRowSeq(db: Database, userId: string, id: string): Promise<bigint> {
  const result = await db.execute(sql`SELECT max(seq)::text AS seq FROM change_log WHERE entity = 'inbox_row' AND scope_kind = 'user' AND scope_id = ${userId}::uuid AND entity_id = ${id}`);
  return BigInt((result.rows[0] as { seq: string }).seq);
}

/** A read model that has not ingested the viewer's mute / Done watermark rows of `id`. */
const notIngested = (id: string) => (states: { suppression: ReadonlyMap<string, string>; mute: ReadonlyMap<string, string> }) => ({
  suppression: new Map([...states.suppression].filter(([key]) => key !== id)),
  mute: new Map([...states.mute].filter(([key]) => key !== id)),
});

test("a mute the read model has not ingested is held: the log stops before it (later changes wait too), retryAfterMs; once caught up it goes; past the hold, held_too_long", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const other = await seed.channel({ server, members: [owner, peer] });
  await seed.message({ channel, author: peer, content: "before the mute" });
  const later = await seed.message({ channel: other, author: peer, content: "read after the mute" });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);
  const setMuted = async (activityMuted: boolean) => {
    const res = await client.request(`/api/channels/${channel.id}/notification-settings`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activityMuted }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };

  __setSyncInboxSourceStatesForTests(notIngested(channel.id));
  try {
    await setMuted(true);
    const muteSeq = await lastInboxRowSeq(db, owner.id, channel.id);
    await setReadCursor(db, owner.id, other.id, Number(later.seq));
    const held = await sync(client, start.cursor);
    assert.equal(conversationOf(held, channel.id), undefined, "held: not even its conversation change");
    assert.deepEqual(rowsOf(held, channel.id), []);
    assert.equal(conversationOf(held, other.id), undefined, "a later change waits behind the held one");
    assert.equal(parseSyncChangesCursor(held.cursor)!.seq, muteSeq - 1n, "the log part stops right before the held row");
    assert.equal(held.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS);
    assert.equal(held.hasMore, false, "not hasMore: that would loop while the row is not ready");
    assert.equal(held.inboxReset, null);
    const again = await sync(client, held.cursor);
    assert.equal(conversationOf(again, channel.id), undefined, "still behind: still held");

    __setSyncInboxSourceStatesForTests(null);
    const caughtUp = await sync(client, again.cursor);
    assert.ok(conversationOf(caughtUp, channel.id), JSON.stringify(caughtUp.changes));
    await expectListedUpsert(client, caughtUp, channel.id, "caught up: the row as ?ids= answers it");
    assert.ok(conversationOf(caughtUp, other.id), "the change behind it goes too");
    assert.equal("retryAfterMs" in caughtUp, false);

    // Held past SYNC_INBOX_HOLD_MS (its change_log row is 40 s old): inboxReset, and the log moves on.
    __setSyncInboxSourceStatesForTests(notIngested(channel.id));
    await setMuted(false);
    const unmuteSeq = await lastInboxRowSeq(db, owner.id, channel.id);
    await db.execute(sql`UPDATE change_log SET created_at = now() - interval '40 seconds' WHERE seq = ${unmuteSeq.toString()}::bigint`);
    const stuck = await sync(client, caughtUp.cursor);
    assert.deepEqual(stuck.inboxReset, { reason: "held_too_long", snapshots: ["inbox"] });
    assert.equal(stuck.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS, "snapshot after a delay");
    assert.ok(conversationOf(stuck, channel.id), "the log's changes still go, as without the capability");
    assert.deepEqual(rowsOf(stuck, channel.id), []);
    assert.ok(parseSyncChangesCursor(stuck.cursor)!.seq >= unmuteSeq, "the log passes it: it does not reset again");
    const after = await sync(client, stuck.cursor);
    assert.equal(after.inboxReset, null);
  } finally {
    __setSyncInboxSourceStatesForTests(null);
  }
});

test("a Done watermark the read model has not ingested is held, not sent as the lagging row; then the done delete", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const latest = await seed.message({ channel, author: peer, content: "mention me" });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);

  __setSyncInboxSourceStatesForTests(notIngested(channel.id));
  try {
    await writeChannelInboxSuppression({ userId: owner.id, channelId: channel.id, throughActivitySeq: String(latest.seq) });
    const held = await sync(client, start.cursor);
    assert.deepEqual(rowsOf(held, channel.id), [], "held");
    assert.equal(held.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS);
    __setSyncInboxSourceStatesForTests(null);
    const sent = await sync(client, held.cursor);
    const listed = await inboxRow(client, channel.id);
    assert.deepEqual(withoutSeq(rowsOf(sent, channel.id)), listed
      ? [{ entity: "inbox_row", id: channel.id, op: "upsert", row: listed, source: "log" }]
      : [{ entity: "inbox_row", id: channel.id, op: "delete", position: String(latest.seq), reason: "done" }]);
  } finally {
    __setSyncInboxSourceStatesForTests(null);
  }
});

test("a hold is aged from the row's newest inbox_row change: an old Done plus a fresh mute the read model is behind on retries, not held_too_long", async ({ seed, db, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const first = await seed.message({ channel, author: peer, content: "first" });
  await seed.message({ channel, author: peer, content: "newer than the Done" });
  const client = http.as(owner, server);
  await flagOn(db);
  const start = await sync(client);

  // Entry A: a Done watermark from 5 minutes ago, long applied by the read model.
  await writeChannelInboxSuppression({ userId: owner.id, channelId: channel.id, throughActivitySeq: String(first.seq) });
  const doneSeq = await lastInboxRowSeq(db, owner.id, channel.id);
  await db.execute(sql`UPDATE change_log SET created_at = now() - interval '5 minutes' WHERE entity = 'inbox_row' AND scope_id = ${owner.id}::uuid AND entity_id = ${channel.id} AND seq <= ${doneSeq.toString()}::bigint`);
  // Entry B: a mute just now, which the read model has not ingested yet.
  const res = await client.request(`/api/channels/${channel.id}/notification-settings`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activityMuted: true }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const muteSeq = await lastInboxRowSeq(db, owner.id, channel.id);
  assert.ok(muteSeq > doneSeq);
  __setSyncInboxSourceStatesForTests((states) => ({ suppression: states.suppression, mute: new Map([...states.mute].filter(([id]) => id !== channel.id)) }));
  try {
    const held = await sync(client, start.cursor);
    assert.equal(held.inboxReset, null, "the newest change is fresh: not held_too_long");
    assert.equal(held.retryAfterMs, SYNC_INBOX_HELD_RETRY_MS);
    assert.deepEqual(rowsOf(held, channel.id), []);
    assert.ok(parseSyncChangesCursor(held.cursor)!.seq < doneSeq, "the cut is still before the row's first inbox_row change");

    // Control: once the newest change is old too, the hold resets.
    await db.execute(sql`UPDATE change_log SET created_at = now() - interval '40 seconds' WHERE seq = ${muteSeq.toString()}::bigint`);
    const stuck = await sync(client, held.cursor);
    assert.deepEqual(stuck.inboxReset, { reason: "held_too_long", snapshots: ["inbox"] });
  } finally {
    __setSyncInboxSourceStatesForTests(null);
  }
});
