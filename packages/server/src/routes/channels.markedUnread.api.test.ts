/**
 * Mark as Unread always takes effect (#triage:#101, Tenny's rule).
 *
 * When something others wrote lies past the read cursor, Mark as Unread rewinds
 * the cursor as before and the count is exact (no extra +1). When nothing
 * countable lies past it (the "T3" thread: its only message from someone else
 * is the parent, stored in the parent channel, and every reply is the person's
 * own), the scope is marked unread instead (user_channel_read_cursors.
 * marked_unread): the /unread answer, the read_state:updated event, the sidebar
 * summary, the Activity row and the sync pull report it with unread 0, and any
 * read of the scope clears it.
 */
import assert from "node:assert/strict";

import { and, desc, eq } from "drizzle-orm";
import { markConversationUnreadResponseSchema, type InboxScopeReadFrontier, type SyncChangesResponse } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { messages, readMutations, userChannelReadCursors } from "../db/schema";
import { getOrCreateThread, markThreadDone, recordThreadFollow, unfollowThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation, insertTaskConversationFollow } from "../services/taskConversationService";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { createApiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import { installFakeIo, type EmittedEvent } from "./channels.api.fixtures";

const test = createApiTest();

type Client = { get(path: string): Promise<Response>; request(path: string, init: RequestInit): Promise<Response> };

async function post(client: Client, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await client.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as Record<string, unknown>;
}

async function get<T>(client: Client, path: string): Promise<T> {
  const res = await client.get(path);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as T;
}

type SummaryEntry = { unreadCount: number; readState?: InboxScopeReadFrontier };
type InboxRow = { kind: string; channelId?: string; threadChannelId?: string; unreadCount: number; readState?: InboxScopeReadFrontier };

async function summaryEntry(client: Client, scopeId: string): Promise<SummaryEntry | undefined> {
  const body = await get<{ channels: Record<string, SummaryEntry> }>(client, "/api/channels/unread?summary=1");
  return body.channels[scopeId];
}

async function inboxRow(client: Client, scopeId: string): Promise<InboxRow> {
  const body = await get<{ items: InboxRow[] }>(client, `/api/channels/inbox?ids=${scopeId}`);
  const row = body.items.find((item) => (item.threadChannelId ?? item.channelId) === scopeId);
  assert.ok(row, JSON.stringify(body));
  return row;
}

const markedOf = (readState: InboxScopeReadFrontier | undefined) =>
  readState?.kind === "present" ? readState.markedUnread === true : false;

function readStateEvents(events: EmittedEvent[], scopeId: string) {
  return events
    .filter((event) => event.event === "read_state:updated")
    .map((event) => event.payload as Record<string, unknown>)
    .filter((payload) => payload.scopeId === scopeId);
}

/** A channel with a peer's message, a thread on it holding only the owner's replies, all read by the owner. */
async function t3Thread({ seed }: { seed: ReturnType<typeof createSeed> }) {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const parent = await seed.message({ channel, author: peer, content: "a question from the peer" });
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "my first answer");
  const lastReply = await createMessage(thread.id, "user", owner.id, "my second answer");
  await recordThreadFollow("user", owner.id, thread.id, parent.id, "replied", { joinedThroughSeq: "latest" });
  return { owner, peer, server, channel, parent, thread, lastReply };
}

test("Mark as Unread on a thread of only the owner's replies marks it unread with no count; reading it clears the mark", async ({ seed, db, app, http }) => {
  const { owner, server, channel, thread, lastReply } = await t3Thread({ seed });
  const events = installFakeIo(app.app);
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  const readAll = await post(client, `/api/channels/${thread.id}/read-all`);
  assert.equal(markedOf((await inboxRow(client, thread.id)).readState), false, "control: read and not marked");
  const syncStart = await get<SyncChangesResponse>(client, "/api/sync/changes");

  const marked = await post(client, `/api/channels/${thread.id}/unread`);
  assert.equal(marked.unreadCount, 0, "nothing countable: no count");
  assert.equal(marked.markedUnread, true);
  assert.equal(marked.outcome, "marked");
  assert.equal(marked.maxReadSeq, readAll.seq, "the cursor stays where it was");
  assert.ok(Number(marked.readStateVersion) > Number(readAll.readStateVersion), "the mark is a read-state change");
  assert.deepEqual(readStateEvents(events, thread.id).at(-1), {
    serverId: server.id,
    scopeId: thread.id,
    maxReadSeq: readAll.seq,
    readStateVersion: marked.readStateVersion,
    unreadCount: 0,
    markedUnread: true,
  });

  // The sidebar and Activity report it unread without a number.
  const entry = await summaryEntry(client, thread.id);
  assert.ok(entry, "a marked thread is in the sidebar summary with nothing unread");
  assert.equal(entry.unreadCount, 0);
  assert.equal(markedOf(entry.readState), true);
  assert.equal(entry.readState?.kind === "present" ? entry.readState.readStateVersion : null, marked.readStateVersion);
  const row = await inboxRow(client, thread.id);
  assert.equal(row.unreadCount, 0);
  assert.equal(markedOf(row.readState), true);

  // Other devices learn it from the sync pull.
  const pulled = await get<SyncChangesResponse>(client, `/api/sync/changes?since=${encodeURIComponent(syncStart.cursor)}`);
  const change = pulled.changes.find((c) => c.entity === "conversation" && c.id === thread.id);
  assert.ok(change && change.entity === "conversation", JSON.stringify(pulled.changes));
  assert.deepEqual(change.read, {
    readSeq: readAll.seq,
    readStateVersion: marked.readStateVersion,
    markedUnread: true,
  });

  // Marking again changes nothing and emits nothing.
  const eventCount = events.length;
  const again = await post(client, `/api/channels/${thread.id}/unread`);
  assert.equal(again.markedUnread, true);
  assert.equal(again.outcome, "marked", "already marked: still marked");
  assert.equal(again.readStateVersion, marked.readStateVersion);
  assert.equal(events.length, eventCount, "an unchanged mark does not emit");

  // Opening the thread reads it at the position it already had: the mark clears.
  const opened = await post(client, `/api/channels/${thread.id}/read`, { seq: lastReply.seq });
  assert.equal(opened.maxReadSeq, readAll.seq);
  assert.ok(Number(opened.readStateVersion) > Number(marked.readStateVersion));
  const cleared = readStateEvents(events, thread.id).at(-1);
  assert.equal(cleared?.readStateVersion, opened.readStateVersion);
  assert.equal("markedUnread" in (cleared ?? {}), false, "a read's event carries no mark");
  assert.equal(await summaryEntry(client, thread.id), undefined, "read again: out of the summary");
  assert.equal(markedOf((await inboxRow(client, thread.id)).readState), false);
  const [cursor] = await db.select({ markedUnread: userChannelReadCursors.markedUnread })
    .from(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, owner.id), eq(userChannelReadCursors.channelId, thread.id)));
  assert.equal(cursor?.markedUnread, false);
});

test("every read write of the scope clears the mark: read-all, the parent's conversation read-all, Activity read-all, Done", async ({ seed, http }) => {
  const { owner, server, channel, thread, lastReply } = await t3Thread({ seed });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/read-all`);
  const reads: Array<[string, () => Promise<unknown>]> = [
    ["read-all", () => post(client, `/api/channels/${thread.id}/read-all`)],
    ["conversation read-all on the parent", () => post(client, `/api/channels/${channel.id}/conversation-read-all`)],
    ["Activity read-all", () => post(client, "/api/channels/inbox/read-all")],
    // Activity's Done on a thread row (the route's service call; the route adds authorization only).
    ["Activity Done", () => markThreadDone(owner.id, thread.id, String(lastReply.seq))],
  ];
  for (const [label, read] of reads) {
    assert.equal((await post(client, `/api/channels/${thread.id}/unread`)).markedUnread, true, `${label}: marked`);
    assert.equal(await isMarked(owner.id, thread.id), true);
    await read();
    assert.equal(await isMarked(owner.id, thread.id), false, `${label} clears the mark`);
  }
});

test("a normal channel and thread: Mark as Unread counts exactly what others wrote, no mark and no extra +1", async ({ seed, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  const parent = await seed.message({ channel, author: peer, content: "first" });
  await seed.message({ channel, author: owner, content: "mine" });
  const thread = await getOrCreateThread(parent.id, peer.id, "user");
  await createMessage(thread.id, "user", peer.id, "a peer reply");
  await createMessage(thread.id, "user", owner.id, "my reply");
  await recordThreadFollow("user", owner.id, thread.id, parent.id, "replied", { joinedThroughSeq: "latest" });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/read-all`);

  for (const scopeId of [channel.id, thread.id]) {
    const marked = await post(client, `/api/channels/${scopeId}/unread`);
    assert.equal(marked.unreadCount, 1, "the latest message of someone else, once");
    assert.equal(marked.markedUnread, false);
    assert.equal(marked.outcome, "counted");
    const entry = await summaryEntry(client, scopeId);
    assert.equal(entry?.unreadCount, 1);
    assert.equal(markedOf(entry?.readState), false);
    const row = await inboxRow(client, scopeId);
    assert.equal(row.unreadCount, 1);
    assert.equal(markedOf(row.readState), false);
  }

  // A new message from the peer adds exactly one.
  await seed.message({ channel, author: peer, content: "second" });
  assert.equal((await summaryEntry(client, channel.id))?.unreadCount, 2);
  assert.equal((await inboxRow(client, channel.id)).unreadCount, 2);
});


async function isMarked(userId: string, scopeId: string): Promise<boolean> {
  const [cursor] = await getDb().select({ markedUnread: userChannelReadCursors.markedUnread })
    .from(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, userId), eq(userChannelReadCursors.channelId, scopeId)));
  return cursor?.markedUnread === true;
}

type InboxPage = { items: InboxRow[]; totalCount: number; totalUnreadCount: number };

test("the Unread filter lists a marked conversation: one row in its total, nothing in its unread count; Mentions does not", async ({ seed, http }) => {
  const { owner, peer, server, channel, thread } = await t3Thread({ seed });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/read-all`);
  const unreadOf = async (filter: string) => get<InboxPage>(client, `/api/channels/inbox?filter=${filter}`);
  const listed = (page: InboxPage) => page.items.find((item) => item.threadChannelId === thread.id);

  assert.equal(listed(await unreadOf("unread")), undefined, "control: read, not listed");
  await post(client, `/api/channels/${thread.id}/unread`);
  const page = await unreadOf("unread");
  const row = listed(page);
  assert.ok(row, JSON.stringify(page.items));
  assert.equal(row.unreadCount, 0);
  assert.equal(markedOf(row.readState), true);
  assert.equal(page.totalCount, 1);
  assert.equal(page.totalUnreadCount, 0, "the mark adds no unread messages");
  assert.equal(listed(await unreadOf("mentions")), undefined);

  // A conversation with something unread is listed beside it, counted exactly.
  const other = await seed.channel({ server, members: [owner, peer] });
  await seed.message({ channel: other, author: peer, content: "news" });
  const both = await unreadOf("unread");
  assert.equal(both.totalCount, 2);
  assert.equal(both.totalUnreadCount, 1);

  // Read: gone from the Unread filter.
  await post(client, `/api/channels/${thread.id}/read-all`);
  assert.equal(listed(await unreadOf("unread")), undefined);
});

test("marked, then a peer replies: the count is exactly 1 (the number shows, the mark is ignored while counted); the read clears both", async ({ seed, http }) => {
  const { owner, peer, server, channel, thread } = await t3Thread({ seed });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/unread`);
  const reply = await createMessage(thread.id, "user", peer.id, "the peer answers");

  const entry = await summaryEntry(client, thread.id);
  assert.equal(entry?.unreadCount, 1, "no extra +1 for the mark");
  assert.equal((await inboxRow(client, thread.id)).unreadCount, 1);

  await post(client, `/api/channels/${thread.id}/read`, { seq: reply.seq });
  assert.equal(await isMarked(owner.id, thread.id), false);
  assert.equal(await summaryEntry(client, thread.id), undefined);
});

test("sending a message in the marked conversation reads it: the mark clears", async ({ seed, http }) => {
  const { owner, server, channel, thread } = await t3Thread({ seed });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/read-all`);
  assert.equal((await post(client, `/api/channels/${thread.id}/unread`)).markedUnread, true);
  await post(client, "/api/messages", { channelId: thread.id, content: "one more from me" });
  // The sender's own read runs with the send (not awaited by the response).
  for (let attempt = 0; attempt < 50 && await isMarked(owner.id, thread.id); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await isMarked(owner.id, thread.id), false);
});

test("refused, not marked: a conversation with no messages at all, and a thread the person no longer follows", async ({ seed, app, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const empty = await seed.channel({ server, members: [owner] });
  const events = installFakeIo(app.app);
  const client = http.as(owner, server);
  const refused = await post(client, `/api/channels/${empty.id}/unread`);
  assert.equal(refused.unreadCount, 0);
  assert.equal(refused.markedUnread, false, "nothing to come back to: the web says there is nothing to mark");
  assert.equal(refused.outcome, "nothing");
  assert.equal(readStateEvents(events, empty.id).length, 0);
  assert.equal(await isMarked(owner.id, empty.id), false);

  const t3 = await t3Thread({ seed });
  const t3Client = http.as(t3.owner, t3.server);
  await post(t3Client, `/api/channels/${t3.thread.id}/read-all`);
  await unfollowThread(t3.owner.id, t3.thread.id);
  const notFollowed = await post(t3Client, `/api/channels/${t3.thread.id}/unread`);
  assert.equal(notFollowed.markedUnread, false);
  assert.equal(notFollowed.outcome, "nothing");
  assert.equal(await isMarked(t3.owner.id, t3.thread.id), false);
});

test("unfollowing reads a marked thread, which clears the mark; a mark left behind does not come back with a re-follow", async ({ seed, http }) => {
  const { owner, server, channel, parent, thread } = await t3Thread({ seed });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/unread`);
  assert.equal(await isMarked(owner.id, thread.id), true, "control: marked");
  // Unfollow marks the thread read (markReadLatest), and a read clears the mark.
  await unfollowThread(owner.id, thread.id);
  assert.equal(await isMarked(owner.id, thread.id), false, "unfollowing reads it");
  assert.equal(await summaryEntry(client, thread.id), undefined, "not followed: not shown");
  // That read can be refused by a read-state fence (the unfollow still
  // succeeds), leaving the mark: the re-follow's join position clears it.
  await getDb().update(userChannelReadCursors).set({ markedUnread: true })
    .where(and(eq(userChannelReadCursors.userId, owner.id), eq(userChannelReadCursors.channelId, thread.id)));
  await recordThreadFollow("user", owner.id, thread.id, parent.id, "manual", { reactivateUnfollowed: true, joinedThroughSeq: "latest" });
  assert.equal(await isMarked(owner.id, thread.id), false);
});

test("a task conversation counts chat messages only: with only lifecycle lines from others, Mark as Unread marks it", async ({ seed, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  await enableTaskV2ConversationsForServer(server.id);
  const task = (await createTasks(channel.id, "user", owner.id, [{ title: "ship it" }], { initiatingServerId: server.id })).tasks[0]!;
  const conversation = (await ensureTaskConversation(task.id, { initiatingServerId: server.id }))!.conversation;
  const conversationId = conversation.canonicalChannelId;
  await insertTaskConversationFollow(getDb(), {
    conversationChannelId: conversationId,
    taskId: task.id,
    follower: { type: "user", id: owner.id },
    reason: "authored",
    reactivateUnfollowed: true,
  });
  await createMessage(conversationId, "user", owner.id, "my notes on it");
  // A lifecycle line by the peer (a system message): not "new" in a task conversation.
  await getDb().insert(messages).values({
    channelId: conversationId,
    senderType: "user",
    senderId: peer.id,
    content: "claimed the task",
    messageType: "system",
    causalActorType: "user",
    causalActorId: peer.id,
  });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${conversationId}/read-all`);

  const marked = await post(client, `/api/channels/${conversationId}/unread`);
  assert.equal(marked.unreadCount, 0);
  assert.equal(marked.markedUnread, true, "the lifecycle line is not rewound over (it would count 0)");
  assert.equal(marked.outcome, "marked");
  assert.equal(await isMarked(owner.id, conversationId), true);

  // Activity's Mark all read reads task conversations too: the mark clears.
  await post(client, "/api/channels/inbox/read-all");
  assert.equal(await isMarked(owner.id, conversationId), false);
});

test("Mark as Unread that can rewind (a peer replied since the mark) rewinds and clears the old mark; its event carries no mark", async ({ seed, app, http }) => {
  const { owner, peer, server, channel, thread } = await t3Thread({ seed });
  const client = http.as(owner, server);
  await post(client, `/api/channels/${channel.id}/read-all`);
  await post(client, `/api/channels/${thread.id}/read-all`);
  assert.equal((await post(client, `/api/channels/${thread.id}/unread`)).markedUnread, true);
  await createMessage(thread.id, "user", peer.id, "the peer answers");
  const events = installFakeIo(app.app);

  const rewound = await post(client, `/api/channels/${thread.id}/unread`);
  assert.equal(rewound.unreadCount, 1);
  assert.equal(rewound.markedUnread, false);
  assert.equal(rewound.outcome, "counted", "a rewind clears the old mark: counted, not marked");
  assert.equal(await isMarked(owner.id, thread.id), false);
  const event = readStateEvents(events, thread.id).at(-1);
  assert.equal(event?.readStateVersion, rewound.readStateVersion);
  assert.equal("markedUnread" in (event ?? {}), false, "the newer version without the mark clears it on clients");
});

/** The ack the sequencer stored with the latest row_unread of the scope (written in the same transaction as the cursor). */
async function storedUnread(userId: string, scopeId: string): Promise<{ unreadOutcome?: unknown; unreadCount?: unknown } | undefined> {
  const [row] = await getDb().select({ ack: readMutations.ack })
    .from(readMutations)
    .where(and(eq(readMutations.principalId, userId), eq(readMutations.scopeId, scopeId), eq(readMutations.kind, "row_unread")))
    .orderBy(desc(readMutations.authoritySeq))
    .limit(1);
  const ack = row?.ack as { scopes?: Array<{ scopeId: string; unreadOutcome?: unknown; unreadCount?: unknown }> } | null | undefined;
  return ack?.scopes?.find((scope) => scope.scopeId === scopeId);
}

/** POST /unread, its real answer parsed with the registered contract schema (strict), and the ack it came from. */
async function markUnread(client: Client, userId: string, scopeId: string) {
  const answer = markConversationUnreadResponseSchema.parse(await post(client, `/api/channels/${scopeId}/unread`));
  assert.ok(answer.outcome, "this server always sends the outcome");
  const stored = await storedUnread(userId, scopeId);
  assert.equal(stored?.unreadOutcome, answer.outcome, "the answer's outcome is the one stored with the write");
  assert.equal(stored?.unreadCount, answer.unreadCount, "and so is its count");
  assert.equal(answer.outcome === "counted", answer.unreadCount > 0, "counted exactly when there is a count");
  return answer;
}

test("outcome is decided in the read-state transaction and matches the state it wrote: counted, already unread, marked, nothing", async ({ seed, http }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const server = await seed.server({ owner, members: [peer] });
  const channel = await seed.channel({ server, members: [owner, peer] });
  await seed.message({ channel, author: peer, content: "zero" });
  const client = http.as(owner, server);
  const read = await post(client, `/api/channels/${channel.id}/read-all`);
  await seed.message({ channel, author: peer, content: "one" });
  await seed.message({ channel, author: peer, content: "two" });

  // Already unread (two from the peer past the cursor): the cursor stays, still counted.
  assert.equal((await summaryEntry(client, channel.id))?.unreadCount, 2, "control: unread before the mark");
  const already = await markUnread(client, owner.id, channel.id);
  assert.equal(already.outcome, "counted", "already unread: counted");
  assert.equal(already.unreadCount, 2);
  assert.equal(already.maxReadSeq, read.seq, "nothing moved");
  assert.equal(already.markedUnread, false);
  assert.equal((await summaryEntry(client, channel.id))?.unreadCount, 2, "post-write: counted in the sidebar");

  // Read, then marked: rewinds over the peer's latest message.
  await post(client, `/api/channels/${channel.id}/read-all`);
  const rewound = await markUnread(client, owner.id, channel.id);
  assert.equal(rewound.outcome, "counted");
  assert.equal((await summaryEntry(client, channel.id))?.unreadCount, 1);

  // A thread with only my replies: marked.
  const t3 = await t3Thread({ seed });
  const t3Client = http.as(t3.owner, t3.server);
  await post(t3Client, `/api/channels/${t3.thread.id}/read-all`);
  const marked = await markUnread(t3Client, t3.owner.id, t3.thread.id);
  assert.equal(marked.outcome, "marked");
  assert.equal(await isMarked(t3.owner.id, t3.thread.id), true, "post-write: the flag is set");

  // An empty channel: nothing.
  const empty = await seed.channel({ server, members: [owner] });
  const nothing = await markUnread(client, owner.id, empty.id);
  assert.equal(nothing.outcome, "nothing");
  assert.equal(await summaryEntry(client, empty.id), undefined, "post-write: neither counted nor marked");
});
