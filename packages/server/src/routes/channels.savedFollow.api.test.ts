import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { threadFollows, userSaved } from "../db/schema";
import { addMember } from "../services/serverService";
import { addHuman, createChannel, getOrCreateThread, type InboxItem } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

// Thread contract D (db/schema.ts thread_follows): saving a message follows its
// thread with reason 'saved' unless a follow is already active; unsaving the
// last save linked to the thread deletes only a follow the save started.
// Activity's Saved filter (scope=saved) lists the threads followed through a save.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type InboxResponse = {
  items: InboxItem[];
  totalCount: number;
  hasMore: boolean;
};

const targetOf = (item: InboxItem) => (item.kind === "thread" || item.kind === "task" ? item.threadChannelId : item.channelId);

async function seedSavedFollowFixture(slug: string) {
  const owner = await seedUser(`${slug}-owner@slock.test`, `${slug}-owner`);
  const peer = await seedUser(`${slug}-peer@slock.test`, `${slug}-peer`);
  const server = await createServer(`${slug} server`, `${slug}-server`, owner.id);
  await addMember(server.id, peer.id);
  const channel = await createChannel(server.id, `${slug}-room`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, peer.id);
  const token = await tokenForHuman(owner.email);
  return { owner, peer, server, channel, token };
}

type Fixture = Awaited<ReturnType<typeof seedSavedFollowFixture>>;

function api(baseUrl: string, f: Fixture) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: headers(f.token, f.server.id),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, 200, `${method} ${path}`);
    return await res.json() as unknown;
  };
  return {
    save: (messageId: string) => call("POST", "/channels/saved", { messageId }),
    unsave: (messageId: string) => call("DELETE", `/channels/saved/${messageId}`),
    follow: (parentMessageId: string) => call("POST", "/channels/threads/follow", { parentMessageId }),
    reply: (threadChannelId: string, content: string) => call("POST", "/messages", { channelId: threadChannelId, content }),
    inbox: (query: string) => call("GET", `/channels/inbox?${query}`) as Promise<InboxResponse>,
  };
}

async function ownerFollow(threadChannelId: string, userId: string) {
  const [row] = await getDb()
    .select({ reason: threadFollows.reason, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannelId),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, userId),
    ));
  return row ?? null;
}

async function threadOf(parentMessageId: string, creatorId: string) {
  return (await getOrCreateThread(parentMessageId, creatorId, "user")).id;
}

test("saving a top-level message follows the thread rooted at it with reason saved; unsaving removes that follow", async ({ app }) => {
  const f = await seedSavedFollowFixture("save-follow-root");
  const http = api(app.baseUrl, f);
  const parent = await createMessage(f.channel.id, "user", f.peer.id, "a message worth keeping");

  await http.save(parent.id);
  const threadId = await threadOf(parent.id, f.peer.id);
  assert.deepEqual(await ownerFollow(threadId, f.owner.id), { reason: "saved", unfollowedAt: null });
  const [saved] = await getDb().select({ threadChannelId: userSaved.threadChannelId }).from(userSaved)
    .where(and(eq(userSaved.userId, f.owner.id), eq(userSaved.messageId, parent.id)));
  assert.equal(saved?.threadChannelId, threadId, "the save is linked to the thread it followed");

  await http.unsave(parent.id);
  assert.equal(await ownerFollow(threadId, f.owner.id), null, "a follow only the save started goes with it");
});

test("saving a reply follows the reply's own thread", async ({ app }) => {
  const f = await seedSavedFollowFixture("save-follow-reply");
  const http = api(app.baseUrl, f);
  const parent = await createMessage(f.channel.id, "user", f.peer.id, "thread parent");
  const threadId = await threadOf(parent.id, f.peer.id);
  const reply = await createMessage(threadId, "user", f.peer.id, "the reply worth keeping");

  await http.save(reply.id);
  assert.deepEqual(await ownerFollow(threadId, f.owner.id), { reason: "saved", unfollowedAt: null });
});

test("unsaving keeps a manual follow: followed by hand, then saved, then unsaved, the thread stays followed", async ({ app }) => {
  const f = await seedSavedFollowFixture("save-follow-manual");
  const http = api(app.baseUrl, f);
  const parent = await createMessage(f.channel.id, "user", f.peer.id, "followed by hand first");
  await http.follow(parent.id);
  const threadId = await threadOf(parent.id, f.peer.id);
  assert.equal((await ownerFollow(threadId, f.owner.id))?.reason, "manual");

  await http.save(parent.id);
  assert.deepEqual(await ownerFollow(threadId, f.owner.id), { reason: "manual", unfollowedAt: null }, "an active follow is not downgraded");

  await http.unsave(parent.id);
  assert.deepEqual(await ownerFollow(threadId, f.owner.id), { reason: "manual", unfollowedAt: null }, "the manual follow stays");
});

test("a follow the save started stays once another reason replaced it, and while another save in the thread remains", async ({ app }) => {
  const f = await seedSavedFollowFixture("save-follow-reasons");
  const http = api(app.baseUrl, f);

  // Saved, then the person replied: the follow is theirs by replying now.
  const repliedParent = await createMessage(f.channel.id, "user", f.peer.id, "saved, then replied to");
  await http.save(repliedParent.id);
  const repliedThread = await threadOf(repliedParent.id, f.peer.id);
  await http.reply(repliedThread, "my own reply");
  assert.equal((await ownerFollow(repliedThread, f.owner.id))?.reason, "replied");
  await http.unsave(repliedParent.id);
  assert.deepEqual(await ownerFollow(repliedThread, f.owner.id), { reason: "replied", unfollowedAt: null });

  // Two saves in one thread: the follow goes with the last of them.
  const parent = await createMessage(f.channel.id, "user", f.peer.id, "two saves in this thread");
  const threadId = await threadOf(parent.id, f.peer.id);
  const reply = await createMessage(threadId, "user", f.peer.id, "second saved message");
  await http.save(parent.id);
  await http.save(reply.id);
  await http.unsave(parent.id);
  assert.deepEqual(await ownerFollow(threadId, f.owner.id), { reason: "saved", unfollowedAt: null }, "another save still holds it");
  await http.unsave(reply.id);
  assert.equal(await ownerFollow(threadId, f.owner.id), null);
});

test("GET /channels/inbox?scope=saved lists only the threads followed through a save, in Activity's order", async ({ app }) => {
  const f = await seedSavedFollowFixture("save-follow-scope");
  const http = api(app.baseUrl, f);

  // Nothing saved yet: the scope is empty, not unscoped.
  const empty = await http.inbox("filter=all&limit=100&scope=saved");
  assert.deepEqual(empty.items, []);
  assert.equal(empty.totalCount, 0);

  const seedThread = async (label: string) => {
    const parent = await createMessage(f.channel.id, "user", f.peer.id, `${label} parent`);
    const threadId = await threadOf(parent.id, f.peer.id);
    await createMessage(threadId, "user", f.peer.id, `${label} reply`);
    return { parent, threadId };
  };
  const savedOnly = await seedThread("saved only");
  const manualThenSaved = await seedThread("manual then saved");
  const manualOnly = await seedThread("manual only");
  const legacySave = await seedThread("saved before the link");

  await http.save(savedOnly.parent.id);
  await http.follow(manualThenSaved.parent.id);
  await http.save(manualThenSaved.parent.id);
  await http.follow(manualOnly.parent.id);
  // A save from before this change: no thread link, so no Saved row (no backfill).
  await getDb().insert(userSaved).values({ userId: f.owner.id, messageId: legacySave.parent.id, serverId: f.server.id });
  await http.follow(legacySave.parent.id);
  // New activity after the follows, so the threads have something to list.
  for (const thread of [savedOnly, manualThenSaved, manualOnly, legacySave]) {
    await createMessage(thread.threadId, "user", f.peer.id, "later activity");
  }

  const all = await http.inbox("filter=all&limit=100");
  const saved = await http.inbox("filter=all&limit=100&scope=saved");
  const savedTargets = saved.items.map(targetOf);
  const expected = new Set([savedOnly.threadId, manualThenSaved.threadId]);
  assert.deepEqual(new Set(savedTargets), expected, "only the save-linked threads");
  assert.deepEqual(savedTargets, all.items.map(targetOf).filter((id) => expected.has(id)), "Activity's own order (latest message first)");
  assert.ok(saved.items.every((item) => item.kind === "thread"));
  assert.equal(saved.totalCount, 2);
  assert.ok(all.items.some((item) => targetOf(item) === f.channel.id), "control: the channel row is in All");
  assert.ok(all.items.some((item) => targetOf(item) === manualOnly.threadId), "control: a manual follow is in All");

  // Paging walks only the scoped rows.
  const first = await http.inbox("filter=all&limit=1&scope=saved");
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.items.map(targetOf), savedTargets.slice(0, 1));

  // Unsaving drops the thread from Saved; the unfollowed history has no Saved rows.
  await http.unsave(savedOnly.parent.id);
  const afterUnsave = await http.inbox("filter=all&limit=100&scope=saved");
  assert.deepEqual(afterUnsave.items.map(targetOf), [manualThenSaved.threadId]);
  const unfollowed = await fetch(`${app.baseUrl}/api/channels/inbox/unfollowed?scope=saved`, { headers: headers(f.token, f.server.id) });
  assert.equal(unfollowed.status, 200);
  assert.deepEqual((await unfollowed.json() as { items: unknown[] }).items, []);
});

test("a saved top-level message with no replies lists its thread under scope=saved", async ({ app }) => {
  const f = await seedSavedFollowFixture("save-follow-empty");
  const http = api(app.baseUrl, f);
  const parent = await createMessage(f.channel.id, "user", f.peer.id, "no replies yet");

  await http.save(parent.id);
  const threadId = await threadOf(parent.id, f.peer.id);
  const saved = await http.inbox("filter=all&limit=100&scope=saved");
  assert.deepEqual(saved.items.map(targetOf), [threadId], "the thread created by the save is listed, with zero replies");
  assert.equal(saved.totalCount, 1);
});

test("re-saving a saved message restores its follow when it has none, and leaves an explicit unfollow", async ({ app }) => {
  const f = await seedSavedFollowFixture("save-follow-resave");
  const http = api(app.baseUrl, f);
  const parent = await createMessage(f.channel.id, "user", f.peer.id, "saved twice");
  await http.save(parent.id);
  const threadId = await threadOf(parent.id, f.peer.id);
  const followRow = and(
    eq(threadFollows.threadChannelId, threadId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, f.owner.id),
  );

  // The linked save lost its follow (say, a crash between writes before they were one transaction).
  await getDb().delete(threadFollows).where(followRow);
  await http.save(parent.id);
  assert.deepEqual(await ownerFollow(threadId, f.owner.id), { reason: "saved", unfollowedAt: null }, "the follow is back");

  // An explicit unfollow is not undone by saving the same message again.
  const unfollowedAt = new Date();
  await getDb().update(threadFollows).set({ reason: "manual", unfollowedAt }).where(followRow);
  await http.save(parent.id);
  assert.equal((await ownerFollow(threadId, f.owner.id))?.unfollowedAt?.getTime(), unfollowedAt.getTime());
});
