import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { serverMembers, threadFollows } from "../db/schema";
import { addMember } from "../services/serverService";
import {
  addHuman,
  createChannel,
  findOrCreateUserDM,
  getOrCreateThread,
  isPinnedScopedInboxItem,
  type InboxItem,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import * as taskService from "../services/taskService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type InboxResponse = {
  items: InboxItem[];
  groups: { channelId: string; channelType: string; count: number }[];
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
  hasMore: boolean;
};

const targetOf = (item: InboxItem) => (item.kind === "thread" || item.kind === "task" ? item.threadChannelId : item.channelId);

async function seedPinnedScopeFixture() {
  const db = getDb();
  const owner = await seedUser("pin-scope-owner@slock.test", "pin-scope-owner");
  const peer = await seedUser("pin-scope-peer@slock.test", "pin-scope-peer");
  const other = await seedUser("pin-scope-other@slock.test", "pin-scope-other");
  const server = await createServer("Pin Scope Server", "pin-scope-server", owner.id);
  await addMember(server.id, peer.id);
  await addMember(server.id, other.id);

  const follow = async (threadChannelId: string, parentMessageId: string, unfollowedAt?: Date) => {
    await db.insert(threadFollows).values({
      threadChannelId,
      followerType: "user",
      followerId: owner.id,
      parentMessageId,
      reason: "manual",
      ...(unfollowedAt ? { unfollowedAt } : {}),
    });
  };
  // A followed thread with a reply from someone else, under `channelId`.
  const seedThread = async (channelId: string, sender: string, label: string) => {
    const parent = await createMessage(channelId, "user", sender, `${label} parent`);
    const thread = await getOrCreateThread(parent.id, sender, "user");
    await createMessage(thread.id, "user", sender, `${label} reply`);
    await follow(thread.id, parent.id);
    return thread;
  };
  // A task (a thread row whose parent message hosts a task), followed.
  const seedTaskThread = async (channelId: string, sender: string, label: string) => {
    const { tasks: [task], hostMessages: [host] } = await taskService.createTasks(channelId, "user", sender, [{ title: `${label} task` }]);
    assert.ok(task && host);
    const thread = await getOrCreateThread(host.id, sender, "user");
    await createMessage(thread.id, "user", sender, `${label} task reply`);
    await follow(thread.id, host.id);
    return thread;
  };

  const pinnedChannel = await createChannel(server.id, "pin-scope-pinned");
  await addHuman(pinnedChannel.id, owner.id);
  await addHuman(pinnedChannel.id, peer.id);
  await createMessage(pinnedChannel.id, "user", peer.id, "pinned channel activity");
  const pinnedChannelThread = await seedThread(pinnedChannel.id, peer.id, "pinned channel thread");
  const pinnedChannelTask = await seedTaskThread(pinnedChannel.id, peer.id, "pinned channel");

  const pinnedDm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(pinnedDm);
  await createMessage(pinnedDm.id, "user", peer.id, "pinned dm activity");
  const pinnedDmThread = await seedThread(pinnedDm.id, peer.id, "pinned dm thread");
  const pinnedDmTask = await seedTaskThread(pinnedDm.id, peer.id, "pinned dm");

  // Unpinned controls: a channel and a DM, each with a followed thread.
  const controlChannel = await createChannel(server.id, "pin-scope-control");
  await addHuman(controlChannel.id, owner.id);
  await addHuman(controlChannel.id, other.id);
  await createMessage(controlChannel.id, "user", other.id, "control channel activity");
  const controlChannelThread = await seedThread(controlChannel.id, other.id, "control channel thread");
  const controlDm = await findOrCreateUserDM(server.id, owner.id, other.id);
  assert.ok(controlDm);
  await createMessage(controlDm.id, "user", other.id, "control dm activity");

  // Unfollowed, not-Done threads: Activity All merges these; /inbox/unfollowed lists them.
  const unfollowedPinnedParent = await createMessage(pinnedChannel.id, "user", peer.id, "pinned parent for an unfollowed thread");
  const unfollowedPinnedThread = await getOrCreateThread(unfollowedPinnedParent.id, peer.id, "user");
  await createMessage(unfollowedPinnedThread.id, "user", peer.id, "unfollowed pinned thread reply");
  await follow(unfollowedPinnedThread.id, unfollowedPinnedParent.id, new Date());
  const unfollowedControlParent = await createMessage(controlChannel.id, "user", other.id, "control parent for an unfollowed thread");
  const unfollowedControlThread = await getOrCreateThread(unfollowedControlParent.id, other.id, "user");
  await createMessage(unfollowedControlThread.id, "user", other.id, "unfollowed control thread reply");
  await follow(unfollowedControlThread.id, unfollowedControlParent.id, new Date());

  return {
    owner, peer, other, server,
    pinnedChannel, pinnedChannelThread, pinnedChannelTask,
    pinnedDm, pinnedDmThread, pinnedDmTask,
    controlChannel, controlChannelThread, controlDm,
    unfollowedPinnedThread, unfollowedControlThread,
  };
}

test("GET /channels/inbox?scope=pinned keeps pinned conversations and their threads, and scopes counts, groups and paging", async ({ app }) => {
  const f = await seedPinnedScopeFixture();
  const token = await tokenForHuman(f.owner.email);
  const fetchJson = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${app.baseUrl}/api/channels/${path}`, { headers: headers(token, f.server.id) });
    assert.equal(res.status, 200, path);
    return await res.json() as T;
  };
  const fetchInbox = (query: string) => fetchJson<InboxResponse>(`inbox?${query}`);

  // Nothing pinned yet: the scope is empty, not unscoped.
  const empty = await fetchInbox("filter=all&limit=100&scope=pinned");
  assert.deepEqual(empty, { items: [], groups: [], hasMore: false, totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0 });
  const emptyUnfollowed = await fetchJson<{ items: InboxItem[]; hasMore: boolean }>("inbox/unfollowed?scope=pinned");
  assert.deepEqual(emptyUnfollowed.items, []);
  assert.equal(emptyUnfollowed.hasMore, false);

  // Pin the channel and the peer (a human ref pins the DM with that peer).
  const pinRes = await fetch(`${app.baseUrl}/api/servers/${f.server.id}/sidebar-order`, {
    method: "PATCH",
    headers: headers(token, f.server.id),
    body: JSON.stringify({ pinned: [{ kind: "channel", id: f.pinnedChannel.id }, { kind: "human", id: f.peer.id }] }),
  });
  assert.equal(pinRes.status, 200);

  const pinnedIds = new Set([f.pinnedChannel.id, f.pinnedDm.id]);
  const all = await fetchInbox("filter=all&limit=100");
  const pinned = await fetchInbox("filter=all&limit=100&scope=pinned");
  const pinnedTargets = pinned.items.map(targetOf);

  // Scope is a pure restriction of Activity: same rows, same order, nothing added.
  assert.deepEqual(pinnedTargets, all.items.filter((item) => isPinnedScopedInboxItem(item, pinnedIds)).map(targetOf));
  for (const [id, label] of [
    [f.pinnedChannel.id, "the pinned channel"],
    [f.pinnedChannelThread.id, "a followed thread under the pinned channel"],
    [f.pinnedChannelTask.id, "a task under the pinned channel"],
    [f.pinnedDm.id, "the pinned peer's DM"],
    [f.pinnedDmThread.id, "a followed thread under the pinned DM"],
    [f.pinnedDmTask.id, "a task under the pinned DM"],
    [f.unfollowedPinnedThread.id, "an unfollowed, not-Done thread under the pinned channel (All)"],
  ] as const) {
    assert.ok(pinnedTargets.includes(id), `${label} is listed`);
  }
  for (const [id, label] of [
    [f.controlChannel.id, "an unpinned channel"],
    [f.controlChannelThread.id, "a thread under an unpinned channel"],
    [f.controlDm.id, "an unpinned DM"],
    [f.unfollowedControlThread.id, "an unfollowed thread under an unpinned channel"],
  ] as const) {
    assert.ok(!pinnedTargets.includes(id), `${label} is excluded`);
    assert.ok(all.items.some((item) => targetOf(item) === id), `control: ${label} is in unscoped Activity`);
  }
  const taskRow = pinned.items.find((item) => targetOf(item) === f.pinnedChannelTask.id);
  assert.ok(taskRow?.kind === "thread" && taskRow.taskNumber != null, "the task row carries its task number");

  // Counts and groups are computed within the scope.
  assert.equal(pinned.totalCount, pinned.items.length);
  assert.ok(pinned.totalCount < all.totalCount);
  assert.equal(pinned.totalUnreadCount, pinned.items.reduce((sum, item) => sum + item.unreadCount, 0));
  assert.ok(pinned.activeUnreadCount < all.activeUnreadCount);
  assert.deepEqual(new Set(pinned.groups.map((group) => group.channelId)), pinnedIds, "only pinned groups");
  assert.equal(pinned.groups.reduce((sum, group) => sum + group.count, 0), pinned.totalCount);

  // Other filters compose with the scope.
  for (const filter of ["unread", "mentions", "unread_mentions"]) {
    const scoped = await fetchInbox(`filter=${filter}&limit=100&scope=pinned`);
    const unscoped = await fetchInbox(`filter=${filter}&limit=100`);
    assert.deepEqual(
      scoped.items.map(targetOf),
      unscoped.items.filter((item) => isPinnedScopedInboxItem(item, pinnedIds)).map(targetOf),
      filter,
    );
    assert.equal(scoped.totalCount, scoped.items.length, `${filter}: totalCount`);
  }

  // The channel facet still narrows within the scope; totals follow the facet.
  const faceted = await fetchInbox(`filter=all&limit=100&scope=pinned&channelId=${f.pinnedDm.id}`);
  assert.deepEqual(faceted.items.map(targetOf), pinnedTargets.filter((id) => [f.pinnedDm.id, f.pinnedDmThread.id, f.pinnedDmTask.id].includes(id)));
  assert.equal(faceted.groups.length, pinned.groups.length, "groups stay scope-wide under a facet");

  // Paging walks only the scoped rows, complete across pages.
  const first = await fetchInbox("filter=all&limit=1&scope=pinned");
  const second = await fetchInbox("filter=all&limit=1&offset=1&scope=pinned");
  assert.equal(first.hasMore, true);
  assert.equal(first.totalCount, pinned.totalCount);
  assert.deepEqual([...first.items, ...second.items].map(targetOf), pinnedTargets.slice(0, 2));
  const paged: string[] = [];
  for (let offset = 0; ; offset += 3) {
    const page = await fetchInbox(`filter=all&limit=3&offset=${offset}&scope=pinned`);
    paged.push(...page.items.map(targetOf));
    if (!page.hasMore) break;
  }
  assert.deepEqual(paged, pinnedTargets);

  // Search runs on the canonical Postgres read; the scope applies there too.
  const search = await fetchInbox("filter=all&limit=100&scope=pinned&q=activity");
  assert.ok(search.items.some((item) => targetOf(item) === f.pinnedChannel.id));
  assert.ok(search.items.every((item) => isPinnedScopedInboxItem(item, pinnedIds)));

  // Compatibility history of unfollowed threads takes the same scope.
  const unfollowed = await fetchJson<{ items: InboxItem[] }>("inbox/unfollowed?scope=pinned");
  assert.deepEqual(unfollowed.items.map(targetOf), [f.unfollowedPinnedThread.id]);
  const unfollowedAll = await fetchJson<{ items: InboxItem[] }>("inbox/unfollowed");
  assert.ok(unfollowedAll.items.some((item) => targetOf(item) === f.unfollowedControlThread.id), "control: unscoped history");

  // Unpinning is reflected on the next read (the first-page cache key follows the pin set).
  const unpinRes = await fetch(`${app.baseUrl}/api/servers/${f.server.id}/sidebar-order`, {
    method: "PATCH",
    headers: headers(token, f.server.id),
    body: JSON.stringify({ pinned: [{ kind: "human", id: f.peer.id }] }),
  });
  assert.equal(unpinRes.status, 200);
  const dmOnly = await fetchInbox("filter=all&limit=100&scope=pinned");
  assert.deepEqual(
    dmOnly.items.map(targetOf),
    all.items.filter((item) => isPinnedScopedInboxItem(item, new Set([f.pinnedDm.id]))).map(targetOf),
  );
});

test("GET /channels/inbox?scope=pinned falls back to legacy pinned fields when pinned_refs was never written", async ({ app }) => {
  const f = await seedPinnedScopeFixture();
  const token = await tokenForHuman(f.owner.email);
  await getDb().update(serverMembers)
    .set({ pinnedRefs: null, pinnedChannelIds: [f.pinnedDm.id], pinnedOrder: [f.pinnedDm.id] })
    .where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.owner.id)));

  const res = await fetch(`${app.baseUrl}/api/channels/inbox?filter=all&limit=100&scope=pinned`, { headers: headers(token, f.server.id) });
  assert.equal(res.status, 200);
  const body = await res.json() as InboxResponse;
  const targets = body.items.map(targetOf);
  assert.ok(targets.includes(f.pinnedDm.id), "the legacy-pinned DM is listed");
  assert.ok(targets.includes(f.pinnedDmThread.id), "its thread is listed");
  assert.ok(!targets.includes(f.pinnedChannel.id), "an unpinned channel is excluded");
});
