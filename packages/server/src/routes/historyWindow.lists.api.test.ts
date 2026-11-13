import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { servers, userSaved, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel, findOrCreateDM, getOrCreateThread, recordThreadFollow } from "../services/channelService";
import { createAgent } from "../services/agentService";
import { createMessage } from "../services/messageService";

const test = createApiTest();

// Lists and previews on a Free server, where messages older than the plan's
// 30-day window are not shown (services/historyWindow.ts; cindyz,
// #proj-commercial task #8): what a list leaves out is counted, not listed,
// and a header that can't do without a message behind the window shows 40
// characters of it.

const LONG_PARENT = "the plan we agreed on in the summer offsite, with every number spelled out in full";

async function backdate(messageId: string) {
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${messageId}::uuid`);
}

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `history-lists-${suffix}@slock.test`,
    name: `history-lists-${suffix}`,
    displayName: "Lists Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("History Lists", `history-lists-${suffix}`, owner!.id);
  const channel = await createChannel(server.id, `lists-${suffix}`);
  await addHuman(channel.id, owner!.id);
  const old = await createMessage(channel.id, "user", owner!.id, "an old saved message", "chat");
  const recent = await createMessage(channel.id, "user", owner!.id, "a recent saved message", "chat");
  const oldParent = await createMessage(channel.id, "user", owner!.id, LONG_PARENT, "chat");
  const thread = await getOrCreateThread(oldParent.id, owner!.id, "user");
  const reply = await createMessage(thread.id, "user", owner!.id, "a recent reply under an old start", "chat");
  await backdate(old.id);
  await backdate(oldParent.id);
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  return { db, server, owner: owner!, channel, old, recent, oldParent, thread, reply, token: await tokenForHuman(owner!.email) };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function get(baseUrl: string, fx: Fixture, path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${fx.token}`, "X-Server-Id": fx.server.id } });
}

test("the saved list leaves out what the window hides and counts it; a thread start behind it is a 40-character glimpse", async ({ app }) => {
  const fx = await seedFixture();
  for (const message of [fx.old, fx.recent, fx.reply]) {
    await fx.db.insert(userSaved).values({ userId: fx.owner.id, serverId: fx.server.id, messageId: message.id });
  }
  type SavedBody = {
    saved: Array<{ messageId: string; parentMessagePreview: string | null }>;
    total: number;
    globalTotal: number;
    historyHidden?: { count: number };
  };

  const list = await get(app.baseUrl, fx, "/api/channels/saved");
  assert.equal(list.status, 200);
  const body = await list.json() as SavedBody;
  assert.deepEqual(body.saved.map((entry) => entry.messageId).sort(), [fx.recent.id, fx.reply.id].sort());
  assert.equal(body.total, 2);
  assert.equal(body.globalTotal, 2, "the badge counts what is listed");
  assert.deepEqual(body.historyHidden, { count: 1 });
  const replyEntry = body.saved.find((entry) => entry.messageId === fx.reply.id);
  assert.equal(replyEntry?.parentMessagePreview, "the plan we agreed on in the summer off…");
  assert.equal(Array.from(replyEntry?.parentMessagePreview ?? "").length, 40);

  // A search neither finds nor counts what the window hides, in a message or in a thread's start.
  const search = await get(app.baseUrl, fx, "/api/channels/saved?q=old%20saved");
  const searchBody = await search.json() as SavedBody;
  assert.deepEqual(searchBody.saved, []);
  assert.equal(searchBody.historyHidden, undefined);
  const parentSearch = await get(app.baseUrl, fx, "/api/channels/saved?q=offsite");
  assert.deepEqual((await parentSearch.json() as SavedBody).saved, [], "the old thread start's text is not searchable");

  // Pro lists everything, in full.
  await fx.db.update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  const pro = await (await get(app.baseUrl, fx, "/api/channels/saved")).json() as SavedBody;
  assert.equal(pro.total, 3);
  assert.equal(pro.historyHidden, undefined);
  assert.equal(pro.saved.find((entry) => entry.messageId === fx.reply.id)?.parentMessagePreview, LONG_PARENT);
});

test("a thread summary previews only replies inside the window", async ({ app }) => {
  const fx = await seedFixture();
  const oldReply = await createMessage(fx.thread.id, "user", fx.owner.id, "an old reply nobody here can read", "chat");
  await backdate(oldReply.id);
  const res = await get(app.baseUrl, fx, `/api/channels/${fx.channel.id}/threads?parentMessageIds=${fx.oldParent.id}`);
  assert.equal(res.status, 200, await res.clone().text());
  const text = JSON.stringify(await res.json());
  assert.ok(text.includes("a recent reply under an old start"), text);
  assert.ok(!text.includes("an old reply nobody here can read"), "a reply behind the window is not previewed");

  await fx.db.update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  const pro = JSON.stringify(await (await get(app.baseUrl, fx, `/api/channels/${fx.channel.id}/threads?parentMessageIds=${fx.oldParent.id}`)).json());
  assert.ok(pro.includes("an old reply nobody here can read"));
});

test("Activity's followed threads show a thread start behind the window as a 40-character glimpse", async ({ app }) => {
  const fx = await seedFixture();
  await recordThreadFollow("user", fx.owner.id, fx.thread.id, fx.oldParent.id, "manual");
  const res = await get(app.baseUrl, fx, "/api/channels/threads/followed");
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as unknown;
  const rows = (Array.isArray(body) ? body : (body as { threads?: unknown[] }).threads ?? []) as Array<{ threadChannelId: string; parentMessagePreview: string }>;
  const row = rows.find((candidate) => candidate.threadChannelId === fx.thread.id);
  assert.equal(row?.parentMessagePreview, "the plan we agreed on in the summer off…");
});

test("the DM list shows a last message behind the window as 40 characters", async ({ app }) => {
  const fx = await seedFixture();
  const agent = await createAgent(fx.server.id, `ListsDm${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
  const dm = await findOrCreateDM(fx.server.id, fx.owner.id, agent.id);
  assert.ok(dm);
  const last = await createMessage(dm.id, "agent", agent.id, LONG_PARENT, "chat");
  await backdate(last.id);
  const res = await get(app.baseUrl, fx, "/api/channels/dm");
  assert.equal(res.status, 200);
  const entry = (await res.json() as Array<{ id: string; lastMessagePreview: string | null }>).find((row) => row.id === dm.id);
  assert.equal(entry?.lastMessagePreview, "the plan we agreed on in the summer off…");

  await fx.db.update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  const pro = (await (await get(app.baseUrl, fx, "/api/channels/dm")).json() as Array<{ id: string; lastMessagePreview: string | null }>).find((row) => row.id === dm.id);
  assert.equal(pro?.lastMessagePreview, LONG_PARENT);
});

test("an Activity search does not match what the window hides", async ({ app }) => {
  const fx = await seedFixture();
  const other = await createChannel(fx.server.id, `lists-search-${randomUUID().slice(0, 6)}`);
  await addHuman(other.id, fx.owner.id);
  const word = `zebrafish${randomUUID().slice(0, 6)}`;
  const old = await createMessage(other.id, "user", fx.owner.id, `the ${word} plan from the summer`, "chat");
  await backdate(old.id);
  const search = async () => JSON.stringify(await (await get(app.baseUrl, fx, `/api/channels/inbox?q=${word}`)).json());

  await fx.db.update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  const pro = await search();
  assert.ok(pro.includes(other.id), `control: Pro finds the channel by its old message (${pro.slice(0, 300)})`);

  await fx.db.update(servers).set({ plan: "free" }).where(eq(servers.id, fx.server.id));
  const free = await search();
  assert.ok(!free.includes(word), "no text from behind the window");
  assert.ok(!free.includes(other.id), "and no match on it");
});

type InboxBody = {
  items: Array<{ kind: string; threadChannelId?: string; channelId?: string; parentMessagePreview?: string; latestActivityPreview?: string; lastMessagePreview?: string }>;
};

test("Activity shows a thread start behind the window as a 40-character glimpse, in every filter and in search", async ({ app }) => {
  const fx = await seedFixture();
  await recordThreadFollow("user", fx.owner.id, fx.thread.id, fx.oldParent.id, "manual");
  // Someone else's reply makes the thread unread for the owner.
  const [replier] = await fx.db.insert(users).values({
    email: `history-lists-replier-${randomUUID().slice(0, 8)}@slock.test`,
    name: `history-lists-replier-${randomUUID().slice(0, 8)}`,
    displayName: "Replier",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await createMessage(fx.thread.id, "user", replier!.id, "a fresh reply in the old thread", "chat");

  for (const filter of ["all", "unread"]) {
    const res = await get(app.baseUrl, fx, `/api/channels/inbox?filter=${filter}&limit=30`);
    assert.equal(res.status, 200, await res.clone().text());
    const row = (await res.json() as InboxBody).items.find((item) => item.threadChannelId === fx.thread.id);
    assert.ok(row, `the thread is in Activity (${filter})`);
    assert.equal(row.parentMessagePreview, "the plan we agreed on in the summer off…", filter);
    assert.equal(row.latestActivityPreview, "a fresh reply in the old thread", `${filter}: the reply inside the window is shown as it is`);
  }

  // Search finds the thread by its reply, never by the old start's text.
  const byReply = (await (await get(app.baseUrl, fx, "/api/channels/inbox?q=fresh%20reply")).json() as InboxBody).items;
  assert.ok(byReply.some((item) => item.threadChannelId === fx.thread.id));
  assert.equal(byReply.find((item) => item.threadChannelId === fx.thread.id)?.parentMessagePreview, "the plan we agreed on in the summer off…");
  const byOldStart = (await (await get(app.baseUrl, fx, "/api/channels/inbox?q=offsite")).json() as InboxBody).items;
  assert.ok(!byOldStart.some((item) => item.threadChannelId === fx.thread.id), "the old start's text is not searchable");

  await fx.db.update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  const pro = (await (await get(app.baseUrl, fx, "/api/channels/inbox?filter=all&limit=30")).json() as InboxBody).items
    .find((item) => item.threadChannelId === fx.thread.id);
  assert.equal(pro?.parentMessagePreview, LONG_PARENT);
});

test("the saved list's count of what the window hides follows the channel filter and only comes with the first page", async ({ app }) => {
  const fx = await seedFixture();
  const other = await createChannel(fx.server.id, `lists-saved-other-${randomUUID().slice(0, 6)}`);
  await addHuman(other.id, fx.owner.id);
  const otherOld = await createMessage(other.id, "user", fx.owner.id, "an old saved message elsewhere", "chat");
  await backdate(otherOld.id);
  for (const message of [fx.old, fx.recent, otherOld]) {
    await fx.db.insert(userSaved).values({ userId: fx.owner.id, serverId: fx.server.id, messageId: message.id });
  }
  type SavedBody = { historyHidden?: { count: number } };
  assert.deepEqual((await (await get(app.baseUrl, fx, "/api/channels/saved")).json() as SavedBody).historyHidden, { count: 2 });
  assert.deepEqual((await (await get(app.baseUrl, fx, `/api/channels/saved?channelId=${other.id}`)).json() as SavedBody).historyHidden, { count: 1 });
  assert.equal((await (await get(app.baseUrl, fx, "/api/channels/saved?offset=1")).json() as SavedBody).historyHidden, undefined);
});

test("followed threads say whether the parent and a reply are inside the window, so the web knows what opening shows", async ({ app }) => {
  const fx = await seedFixture();
  const agent = await createAgent(fx.server.id, `ListsRih${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
  // A: parent and replies behind the window. B: old parent, last reply recent. C: an ordinary recent thread.
  const parentA = await createMessage(fx.channel.id, "user", fx.owner.id, "thread A start", "chat");
  const threadA = await getOrCreateThread(parentA.id, fx.owner.id, "user");
  const parentB = await createMessage(fx.channel.id, "user", fx.owner.id, "thread B start", "chat");
  const threadB = await getOrCreateThread(parentB.id, fx.owner.id, "user");
  const parentC = await createMessage(fx.channel.id, "user", fx.owner.id, "thread C start", "chat");
  const threadC = await getOrCreateThread(parentC.id, fx.owner.id, "user");
  const oldA = await createMessage(threadA.id, "agent", agent.id, "old reply A", "chat");
  const oldB = await createMessage(threadB.id, "agent", agent.id, "old reply B", "chat");
  await createMessage(threadB.id, "agent", agent.id, "recent reply B", "chat");
  await createMessage(threadC.id, "agent", agent.id, "recent reply C", "chat");
  for (const message of [parentA, parentB, oldA, oldB]) await backdate(message.id);
  const names = new Map([[threadA.id, "A"], [threadB.id, "B"], [threadC.id, "C"]]);
  for (const [thread, parent] of [[threadA, parentA], [threadB, parentB], [threadC, parentC]] as const) {
    await recordThreadFollow("user", fx.owner.id, thread.id, parent.id, "manual");
  }

  type Row = { threadChannelId: string; parentInHistory?: boolean; repliesInHistory?: boolean };
  const flags = async () => {
    const res = await get(app.baseUrl, fx, "/api/channels/threads/followed");
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as unknown;
    const rows = (Array.isArray(body) ? body : (body as { threads?: unknown[] }).threads ?? []) as Row[];
    return Object.fromEntries(rows.filter((row) => names.has(row.threadChannelId))
      .map((row) => [names.get(row.threadChannelId), [row.parentInHistory, row.repliesInHistory]]));
  };
  assert.deepEqual(await flags(), {
    A: [false, false], // opens on the paywall, as before
    B: [false, true], // the only case the web opens the panel directly
    C: [true, true], // an ordinary thread: behaviour unchanged
  }, "Free: each thread against the window the paywall reads");

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  assert.deepEqual(await flags(), { A: [true, true], B: [true, true], C: [true, true] }, "a plan that keeps all history: every thread is ordinary");
});
