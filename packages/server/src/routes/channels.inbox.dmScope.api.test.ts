import assert from "node:assert/strict";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { messageMentions, threadFollows } from "../db/schema";
import { addMember } from "../services/serverService";
import {
  addHuman,
  createChannel,
  findOrCreateUserDM,
  getOrCreateThread,
  isDmScopedInboxItem,
  setInboxTargetActivityMuteState,
  type InboxItem,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { channelDoneBody, createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type InboxResponse = {
  items: InboxItem[];
  groups: { channelId: string; channelType: string; count: number }[];
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
  hasMore: boolean;
};

const targetOf = (item: InboxItem) => ((item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId);

async function seedDmScopeFixture() {
  const db = getDb();
  const owner = await seedUser("dm-scope-owner@slock.test", "dm-scope-owner");
  const peer = await seedUser("dm-scope-peer@slock.test", "dm-scope-peer");
  const other = await seedUser("dm-scope-other@slock.test", "dm-scope-other");
  const server = await createServer("DM Scope Server", "dm-scope-server", owner.id);
  await addMember(server.id, peer.id);
  await addMember(server.id, other.id);

  const channel = await createChannel(server.id, "dm-scope-room");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, peer.id);
  const channelMessage = await createMessage(channel.id, "user", peer.id, "ordinary channel activity");
  const channelThread = await getOrCreateThread(channelMessage.id, peer.id, "user");
  await createMessage(channelThread.id, "user", peer.id, "channel thread reply");
  await db.insert(threadFollows).values({
    threadChannelId: channelThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: channelMessage.id,
    reason: "manual",
  });

  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);
  const dmMessage = await createMessage(dm.id, "user", peer.id, "dm activity");

  const followedThread = await getOrCreateThread(dmMessage.id, peer.id, "user");
  await createMessage(followedThread.id, "user", peer.id, "followed dm thread reply");
  await db.insert(threadFollows).values({
    threadChannelId: followedThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: dmMessage.id,
    reason: "manual",
  });

  // A thread under the DM the owner does not follow, where the owner is only @mentioned.
  const mentionParent = await createMessage(dm.id, "user", peer.id, "dm parent for a mention-only thread");
  const mentionThread = await getOrCreateThread(mentionParent.id, peer.id, "user");
  const mentionReply = await createMessage(mentionThread.id, "user", peer.id, "mention-only dm thread reply");
  await db.insert(messageMentions).values({
    messageId: mentionReply.id,
    messageSeq: mentionReply.seq,
    serverId: server.id,
    channelId: mentionThread.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: owner.name,
    notifiedAt: new Date(),
  });

  // Activity All also merges threads the owner unfollowed but has not marked Done.
  const unfollowedChannelParent = await createMessage(channel.id, "user", peer.id, "channel parent for an unfollowed thread");
  const unfollowedChannelThread = await getOrCreateThread(unfollowedChannelParent.id, peer.id, "user");
  await createMessage(unfollowedChannelThread.id, "user", peer.id, "unfollowed channel thread reply");
  const unfollowedDmParent = await createMessage(dm.id, "user", peer.id, "dm parent for an unfollowed thread");
  const unfollowedDmThread = await getOrCreateThread(unfollowedDmParent.id, peer.id, "user");
  await createMessage(unfollowedDmThread.id, "user", peer.id, "unfollowed dm thread reply");
  await db.insert(threadFollows).values([
    {
      threadChannelId: unfollowedChannelThread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: unfollowedChannelParent.id,
      reason: "manual",
      unfollowedAt: new Date(),
    },
    {
      threadChannelId: unfollowedDmThread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: unfollowedDmParent.id,
      reason: "manual",
      unfollowedAt: new Date(),
    },
  ]);

  const mutedDm = await findOrCreateUserDM(server.id, owner.id, other.id);
  assert.ok(mutedDm);
  await createMessage(mutedDm.id, "user", other.id, "muted dm activity");

  const selfDm = await findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(selfDm);
  await createMessage(selfDm.id, "user", owner.id, "note to self");

  return { owner, peer, other, server, channel, channelThread, dm, followedThread, mentionThread, unfollowedChannelThread, unfollowedDmThread, mutedDm, selfDm };
}

test("GET /channels/inbox?scope=dms keeps DMs and DM threads, and scopes counts and groups", async ({ app }) => {
  const f = await seedDmScopeFixture();
  const token = await tokenForHuman(f.owner.email);
  const fetchInbox = async (query: string): Promise<InboxResponse> => {
    const res = await fetch(`${app.baseUrl}/api/channels/inbox?${query}`, { headers: headers(token, f.server.id) });
    assert.equal(res.status, 200);
    return await res.json() as InboxResponse;
  };

  // A mute stored on a DM with a person (PATCH accepted one before it started
  // refusing mutes on DMs that cannot be muted) is still enforced; write it
  // through the service the route uses.
  const muted = await setInboxTargetActivityMuteState({
    receiverType: "user",
    receiverId: f.owner.id,
    serverId: f.server.id,
    sourceChannelId: f.mutedDm.id,
    activityMuted: true,
  });
  assert.equal(muted.activityMuted, true);

  const all = await fetchInbox("filter=all&limit=100");
  const dms = await fetchInbox("filter=all&limit=100&scope=dms");
  const dmTargets = dms.items.map(targetOf);

  // Scope is a pure restriction of Activity: same rows, same order, nothing added.
  assert.deepEqual(dmTargets, all.items.filter(isDmScopedInboxItem).map(targetOf));
  assert.ok(dms.items.every(isDmScopedInboxItem));

  assert.ok(dmTargets.includes(f.dm.id), "a DM with messages is listed");
  assert.ok(dmTargets.includes(f.followedThread.id), "a followed thread under a DM is listed");
  assert.ok(dmTargets.includes(f.selfDm.id), "a DM with yourself is listed");
  assert.ok(!dmTargets.includes(f.channel.id), "an ordinary channel is excluded");
  assert.ok(!dmTargets.includes(f.channelThread.id), "a thread under a channel is excluded");
  assert.ok(dmTargets.includes(f.unfollowedDmThread.id), "an unfollowed, not-Done DM thread is listed in All");
  assert.ok(!dmTargets.includes(f.unfollowedChannelThread.id), "an unfollowed channel thread is excluded");
  assert.ok(all.items.some((item) => targetOf(item) === f.unfollowedChannelThread.id), "control: the unfollowed channel thread is in unscoped All");
  assert.ok(all.items.some((item) => targetOf(item) === f.channel.id), "control: the channel is in unscoped Activity");
  assert.ok(all.items.some((item) => targetOf(item) === f.channelThread.id), "control: the channel thread is in unscoped Activity");
  assert.equal(
    dmTargets.includes(f.mentionThread.id),
    all.items.some((item) => targetOf(item) === f.mentionThread.id),
    "a mention-only DM thread follows unscoped Activity",
  );
  assert.equal(
    dmTargets.includes(f.mutedDm.id),
    all.items.some((item) => targetOf(item) === f.mutedDm.id),
    "a muted DM follows unscoped Activity",
  );

  // Counts and groups are computed within the scope.
  assert.equal(dms.totalCount, dms.items.length);
  assert.ok(dms.totalCount < all.totalCount);
  assert.equal(dms.totalUnreadCount, dms.items.reduce((sum, item) => sum + item.unreadCount, 0));
  assert.ok(dms.activeUnreadCount <= all.activeUnreadCount);
  assert.ok(dms.groups.length > 0);
  assert.ok(dms.groups.every((group) => group.channelType === "dm"), "only DM groups");
  assert.ok(all.groups.some((group) => group.channelId === f.channel.id), "control: unscoped groups include the channel");

  // Other filters compose with the scope.
  for (const filter of ["unread", "mentions", "unread_mentions"]) {
    const scoped = await fetchInbox(`filter=${filter}&limit=100&scope=dms`);
    const unscoped = await fetchInbox(`filter=${filter}&limit=100`);
    assert.deepEqual(scoped.items.map(targetOf), unscoped.items.filter(isDmScopedInboxItem).map(targetOf), filter);
  }

  // Paging walks only the scoped rows.
  const first = await fetchInbox("filter=all&limit=1&scope=dms");
  const second = await fetchInbox("filter=all&limit=1&offset=1&scope=dms");
  assert.equal(first.hasMore, true);
  assert.deepEqual([...first.items, ...second.items].map(targetOf), dmTargets.slice(0, 2));

  // Search runs on the canonical Postgres read; the scope applies there too.
  const search = await fetchInbox("filter=all&limit=100&scope=dms&q=activity");
  assert.ok(search.items.length > 0);
  assert.ok(search.items.every(isDmScopedInboxItem));
  assert.ok(search.items.some((item) => targetOf(item) === f.dm.id));

  // An unknown scope value is ignored rather than rejected.
  const unknown = await fetchInbox("filter=all&limit=100&scope=channels");
  assert.deepEqual(unknown.items.map(targetOf), all.items.map(targetOf));
});

test("GET /channels/inbox?scope=dms drops a DM marked Done", async ({ app }) => {
  const f = await seedDmScopeFixture();
  const token = await tokenForHuman(f.owner.email);
  const done = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: headers(token, f.server.id),
    body: JSON.stringify(await channelDoneBody(f.dm.id)),
  });
  assert.equal(done.status, 200);

  const res = await fetch(`${app.baseUrl}/api/channels/inbox?filter=all&limit=100&scope=dms`, { headers: headers(token, f.server.id) });
  assert.equal(res.status, 200);
  const body = await res.json() as InboxResponse;
  const targets = body.items.map(targetOf);
  assert.ok(!targets.includes(f.dm.id), "a Done DM is excluded");
  assert.ok(targets.includes(f.selfDm.id), "control: other DMs remain");
});
