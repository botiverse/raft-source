// Forum-style channels (#proj-chat:#24, flag channel_thread_sort_v0):
// PATCH /api/channels/:id `threadSort` (flag, permission, values) and the
// activity-ordered page GET /api/messages/channel/:id/by-activity (order,
// keyset cursor, history cutoff), plus the change_log trigger on the column.
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY, decodeChannelActivityCursor } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channels, featureFlags, messages, users } from "../db/schema";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { addMember, createServer } from "../services/serverService";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage, listTopLevelMessagesByActivity } from "../services/messageService";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function setFlag(on: boolean) {
  await getDb().insert(featureFlags).values({
    key: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
    enabled: true,
    defaultEnabled: on,
    randomizationUnit: "server",
    salt: CHANNEL_THREAD_SORT_FEATURE_FLAG_KEY,
  }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, defaultEnabled: on } });
}

// Times relative to an hour ago, whole seconds, so the plan's history window
// keeps them; `micros` appends sub-millisecond digits Postgres keeps.
const BASE_MS = Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000;
function minute(n: number, micros = "000000"): string {
  return new Date(BASE_MS + n * 60_000).toISOString().replace(/\.\d{3}Z$/, `.${micros}Z`);
}

async function at(messageId: string, iso: string) {
  await getDb().execute(sql`UPDATE ${messages} SET created_at = ${iso}::timestamptz WHERE id = ${messageId}`);
}

test("threadSort: 404 while the flag is off, editChannelMetadata only, values and channel types checked, change_log row", async ({ app }) => {
  const owner = await seedUser("thread-sort-owner@slock.test", "thread-sort-owner");
  const member = await seedUser("thread-sort-member@slock.test", "thread-sort-member");
  const server = await createServer("Thread Sort", "thread-sort", owner.id);
  await addMember(server.id, member.id, "member");
  const channel = await createChannel(server.id, "forum", "forum channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const patch = (token: string, channelId: string, body: unknown) => fetch(`${app.baseUrl}/api/channels/${channelId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const page = (channelId: string) => fetch(`${app.baseUrl}/api/messages/channel/${channelId}/by-activity`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
  });
  const stored = async () => (await getDb().select({ threadSort: channels.threadSort }).from(channels).where(eq(channels.id, channel.id)))[0]?.threadSort;

  assert.equal(await stored(), "time", "a channel starts in post order");

  await setFlag(false);
  assert.equal((await patch(ownerToken, channel.id, { threadSort: "activity" })).status, 404, "flag off: the field does not exist");
  assert.equal(await stored(), "time");
  // Other fields still save with the flag off.
  assert.equal((await patch(ownerToken, channel.id, { description: "still editable" })).status, 200);

  await setFlag(true);
  assert.equal((await patch(memberToken, channel.id, { threadSort: "activity" })).status, 403, "a plain member cannot change it");
  for (const bad of ["seq", "", 1, true, null]) {
    assert.equal((await patch(ownerToken, channel.id, { threadSort: bad })).status, 400, `refuses ${JSON.stringify(bad)}`);
  }
  assert.equal(await stored(), "time");

  // The by-activity page is 404 until the channel is set to activity.
  assert.equal((await page(channel.id)).status, 404);

  const watermark = Number((await getDb().execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const ok = await patch(ownerToken, channel.id, { threadSort: "activity" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { threadSort: string }).threadSort, "activity", "the response row carries the setting");
  assert.equal(await stored(), "activity");
  const logged = (await getDb().execute(sql`
    SELECT entity, entity_id::text AS entity_id FROM change_log WHERE seq > ${watermark} AND entity = 'channel'`)).rows as Array<{ entity: string; entity_id: string }>;
  assert.ok(logged.some((row) => row.entity_id === channel.id), "sync-changes clients hear the change (change_log_channels_upd)");

  const read = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: { Authorization: `Bearer ${memberToken}`, "X-Server-Id": server.id },
  });
  assert.equal((await read.json() as { threadSort?: string }).threadSort, "activity", "members read the setting on the channel");
  assert.equal((await page(channel.id)).status, 200);

  // A thread is not a regular channel: refused.
  const root = await createMessage(channel.id, "user", owner.id, "root");
  const thread = await getOrCreateThread(root.id, owner.id, "user");
  const onThread = await patch(ownerToken, thread.id, { threadSort: "activity" });
  assert.ok(onThread.status === 400 || onThread.status === 403 || onThread.status === 404, `thread refused (${onThread.status})`);
  assert.equal((await getDb().select({ threadSort: channels.threadSort }).from(channels).where(eq(channels.id, thread.id)))[0]?.threadSort, "time");

  // Flag off again: the page disappears even though the channel keeps its setting.
  await setFlag(false);
  assert.equal((await page(channel.id)).status, 404);
});

test("by-activity page: latest activity order, keyset cursor walks every row once, history cutoff", async ({ app }) => {
  await setFlag(true);
  const owner = await seedUser("thread-sort-order@slock.test", "thread-sort-order");
  const server = await createServer("Thread Sort Order", "thread-sort-order", owner.id);
  const channel = await createChannel(server.id, "forum-order", "forum channel");
  await addHuman(channel.id, owner.id);
  await getDb().update(channels).set({ threadSort: "activity" }).where(eq(channels.id, channel.id));

  // a(1) b(2) c(3) d(4) e(5); b gets a reply at 10 (newest), d at 6,
  // a's thread exists but its only reply (0:30) is older than nothing else.
  const a = await createMessage(channel.id, "user", owner.id, "a");
  const b = await createMessage(channel.id, "user", owner.id, "b");
  const c = await createMessage(channel.id, "user", owner.id, "c");
  const d = await createMessage(channel.id, "user", owner.id, "d");
  const e = await createMessage(channel.id, "user", owner.id, "e");
  await at(a.id, minute(1));
  await at(b.id, minute(2));
  await at(c.id, minute(3));
  await at(d.id, minute(4));
  await at(e.id, minute(5));
  const threadB = await getOrCreateThread(b.id, owner.id, "user");
  const replyB = await createMessage(threadB.id, "user", owner.id, "reply to b");
  await at(replyB.id, minute(10, "123456"));
  const threadD = await getOrCreateThread(d.id, owner.id, "user");
  const replyD = await createMessage(threadD.id, "user", owner.id, "reply to d");
  await at(replyD.id, minute(6));
  const threadA = await getOrCreateThread(a.id, owner.id, "user");
  // A reply stamped before its parent (clock skew) never moves the parent back.
  const replyA = await createMessage(threadA.id, "user", owner.id, "skewed reply to a");
  await at(replyA.id, minute(0.5));

  const expected = [a.id, c.id, e.id, d.id, b.id];
  const token = await tokenForHuman(owner.email);
  type Page = { messages: Array<{ id: string; activityAt: string }>; hasMore: boolean; nextCursor: string | null; threadSummariesByParentMessageId: Record<string, unknown> };
  const get = async (query: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}/by-activity?${query}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    return await res.json() as Page;
  };

  const full = await get("limit=50");
  assert.deepEqual(full.messages.map((m) => m.id), expected, "oldest activity first, a replied-to message at the newest end");
  assert.equal(full.hasMore, false);
  assert.equal(full.nextCursor, null);
  assert.equal(full.messages.at(-1)!.activityAt, minute(10, "123456"), "activityAt keeps microseconds");
  assert.ok(full.threadSummariesByParentMessageId[b.id], "thread summaries ride the page");

  // Walk pages of 2 from the newest end: every row exactly once, in order.
  const walked: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i += 1) {
    const pageResult: Page = await get(`limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
    walked.unshift(...pageResult.messages.map((m) => m.id));
    if (!pageResult.hasMore) break;
    assert.ok(pageResult.nextCursor && decodeChannelActivityCursor(pageResult.nextCursor), "a decodable cursor");
    cursor = pageResult.nextCursor;
  }
  assert.deepEqual(walked, expected, "the cursor neither skips nor repeats rows");

  const badCursor = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}/by-activity?before=nope`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
  });
  assert.equal(badCursor.status, 400);

  // Ties on activity fall back to seq; a history cutoff hides older posts.
  await at(c.id, minute(5));
  const tied = await listTopLevelMessagesByActivity(channel.id, 50, null);
  assert.deepEqual(tied.messages.map((m) => m.id), [a.id, c.id, e.id, d.id, b.id], "same activity: lower seq first");
  const cut = await listTopLevelMessagesByActivity(channel.id, 50, null, new Date(minute(3.5)));
  assert.deepEqual(cut.messages.map((m) => m.id), [c.id, e.id, d.id], "posts at or before the cutoff are not listed, even with newer replies");
});
