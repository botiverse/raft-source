import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import type { createHttpClient } from "../test/integration/http";
import type { Database } from "../db/index";
import { channelHumans, servers, threadFollows } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addMember } from "../services/serverService";
import {
  acceptJointChannelInvite,
  addHuman,
  createJointChannel,
  getActiveJointThreadProjectionsByCanonicalThread,
  getJointThreadProjectionByLocalThread,
  getOrCreateThread,
  recordThreadFollow,
} from "../services/channelService";
import { createMessage } from "../services/messageService";

/**
 * Who may remove / restore an Agent follower of a thread (#wg-rbac:#12): the
 * thread author for their own server's Agents, and otherwise the parent
 * channel's member-removal rule for an Agent target. Ordinary channel: a
 * server owner/admin or that channel's admin. Joint channel: the host's
 * owner/admin or appointed manager for any server's Agent; another server's
 * owner/admin for its own server's Agents only.
 */

type Http = ReturnType<typeof createHttpClient>;
type Actor = { id: string };
type Roster = { threads: Array<{ canManage: boolean; agents: Array<{ id: string; canRemove: boolean }> }> };

function followerApi(http: Http, actor: Actor, server: Actor, threadId: string) {
  const client = http.as(actor, server);
  return {
    async roster() {
      const response = await client.get(`/api/channels/threads/followers?threadChannelIds=${threadId}`);
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as Roster).threads[0]!;
    },
    remove(agentId: string) {
      return client.request(`/api/channels/threads/${threadId}/followers/agents/${agentId}`, { method: "DELETE" });
    },
    restore(agentId: string, undoToken: string) {
      return client.request(`/api/channels/threads/${threadId}/followers/agents/${agentId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ undoToken }),
      });
    },
    unfollow() {
      return client.request("/api/channels/threads/unfollow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadChannelId: threadId }),
      });
    },
  };
}

async function isFollowing(db: Database, threadChannelId: string, followerType: "user" | "agent", followerId: string) {
  const [row] = await db.select({ unfollowedAt: threadFollows.unfollowedAt }).from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, threadChannelId),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
  return Boolean(row) && row!.unfollowedAt === null;
}

/** Remove, check the row went, restore with the undo token, check it is back. */
async function removeAndRestore(
  db: Database,
  api: ReturnType<typeof followerApi>,
  agentId: string,
  followerThreadId: string,
  label: string,
) {
  const removed = await api.remove(agentId);
  assert.equal(removed.status, 200, `${label} removes: ${await removed.clone().text()}`);
  const { undoToken } = await removed.json() as { undoToken: string | null };
  assert.ok(undoToken, `${label} gets an undo token`);
  assert.equal(await isFollowing(db, followerThreadId, "agent", agentId), false, `${label}: the follower row is unfollowed`);
  const restored = await api.restore(agentId, undoToken);
  assert.equal(restored.status, 200, `${label} restores: ${await restored.clone().text()}`);
  assert.equal((await restored.json() as { restored: boolean }).restored, true);
  assert.equal(await isFollowing(db, followerThreadId, "agent", agentId), true, `${label}: the follower row is back`);
}

apiTest("ordinary channel: a channel admin manages Agent followers; a plain member cannot", async ({ db, seed, http }) => {
  const owner = await seed.human();
  const author = await seed.human();
  const channelAdmin = await seed.human();
  const serverAdmin = await seed.human();
  const plain = await seed.human();
  const server = await seed.server({ owner, members: [author, channelAdmin, plain] });
  await addMember(server.id, serverAdmin.id, "admin");
  const channel = await seed.channel({ server, members: [owner, author, plain, serverAdmin] });
  await addHuman(channel.id, channelAdmin.id, { role: "admin" });
  const agent = await createAgent(server.id, "ordinary-follower", { runtime: "codex" });
  const parent = await createMessage(channel.id, "user", author.id, "parent");
  const thread = await getOrCreateThread(parent.id, author.id, "user");
  await recordThreadFollow("agent", agent.id, thread.id, parent.id, "manual");
  await recordThreadFollow("user", plain.id, thread.id, parent.id, "manual");
  await recordThreadFollow("user", author.id, thread.id, parent.id, "manual");

  // Regression guard: an appointed channel admin (a plain server member)
  // manages the followers; before, only server admins could.
  const admin = followerApi(http, channelAdmin, server, thread.id);
  const adminRoster = await admin.roster();
  assert.equal(adminRoster.canManage, true);
  assert.equal(adminRoster.agents.find((row) => row.id === agent.id)?.canRemove, true);
  await removeAndRestore(db, admin, agent.id, thread.id, "channel admin");

  await removeAndRestore(db, followerApi(http, serverAdmin, server, thread.id), agent.id, thread.id, "server admin");
  await removeAndRestore(db, followerApi(http, author, server, thread.id), agent.id, thread.id, "thread author");

  const member = followerApi(http, plain, server, thread.id);
  assert.equal((await member.roster()).canManage, false);
  const denied = await member.remove(agent.id);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Only the thread author or a channel manager can remove followers" });
  assert.equal(await isFollowing(db, thread.id, "agent", agent.id), true, "a refused removal leaves the follow");

  // Self-unfollow is unchanged: any reader leaves their own follow.
  assert.equal((await member.unfollow()).status, 200);
  assert.equal(await isFollowing(db, thread.id, "user", plain.id), false);
  // Human followers are not managed here: a human id is no Agent follower.
  assert.equal((await admin.remove(author.id)).status, 404);
  assert.equal(await isFollowing(db, thread.id, "user", author.id), true);

  // The admin role is per channel: demoted, the same person is refused.
  await db.update(channelHumans).set({ role: "member" })
    .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, channelAdmin.id)));
  assert.equal((await admin.remove(agent.id)).status, 403);
});

apiTest("joint channel: host managers manage any server's Agent followers, another server's admin only its own", async ({ db, seed, http }) => {
  const hostOwner = await seed.human(), peerOwner = await seed.human();
  const hostAdmin = await seed.human(), hostManager = await seed.human(), hostPlain = await seed.human();
  const peerPlain = await seed.human();
  const host = await seed.server({ owner: hostOwner, name: "Host", members: [hostManager, hostPlain] });
  const peer = await seed.server({ owner: peerOwner, name: "Peer", members: [peerPlain] });
  await addMember(host.id, hostAdmin.id, "admin");
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, host.id));
  const made = await createJointChannel({
    hostServerId: host.id,
    createdByUserId: hostOwner.id,
    name: "joint-followers",
    jointInvites: [{ targetServerSlug: peer.slug, invitedPeople: [`@${peerOwner.name}`] }],
  });
  const peerEntry = await acceptJointChannelInvite({ inviteId: made.invites[0]!.id, targetServerId: peer.id, acceptedByUserId: peerOwner.id });
  await addHuman(made.channel.id, hostAdmin.id);
  await addHuman(made.channel.id, hostPlain.id);
  await addHuman(made.channel.id, hostManager.id);
  // A joint join admits as a member; the host's appointment is its own write.
  await db.update(channelHumans).set({ role: "admin" })
    .where(and(eq(channelHumans.channelId, made.channel.id), eq(channelHumans.userId, hostManager.id)));
  await addHuman(peerEntry.id, peerPlain.id);
  const hostAgent = await createAgent(host.id, "host-follower", { runtime: "codex" });
  const peerAgent = await createAgent(peer.id, "peer-follower", { runtime: "codex" });

  const root = await http.as(hostOwner, host).request("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelId: made.channel.id, content: "joint thread root" }),
  });
  assert.equal(root.status, 200, await root.clone().text());
  const { id: rootId } = await root.json() as { id: string };
  const created = await http.as(hostOwner, host).request(`/api/channels/${made.channel.id}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentMessageId: rootId, content: "first reply" }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { threadChannelId: hostThreadId } = await created.json() as { threadChannelId: string };
  const projection = await getJointThreadProjectionByLocalThread(hostThreadId, host.id);
  assert.ok(projection);
  const peerThreadId = (await getActiveJointThreadProjectionsByCanonicalThread(projection.canonicalThreadChannelId))
    .find((row) => row.localServerId === peer.id)?.localThreadChannelId;
  assert.ok(peerThreadId, "the peer server has its own projection of the thread");
  // Each Agent follows through its own server's projection.
  await recordThreadFollow("agent", hostAgent.id, hostThreadId, rootId, "manual");
  await recordThreadFollow("agent", peerAgent.id, peerThreadId, rootId, "manual");

  // Regression guard: the host's owner, admin and appointed manager remove and
  // restore another server's Agent; before, the route 404ed any other server's Agent.
  for (const [actor, label] of [[hostOwner, "host owner"], [hostAdmin, "host admin"], [hostManager, "host-appointed manager"]] as const) {
    const api = followerApi(http, actor, host, hostThreadId);
    const roster = await api.roster();
    assert.equal(roster.canManage, true, label);
    assert.deepEqual(roster.agents.map((row) => [row.id, row.canRemove]).sort(),
      [[hostAgent.id, true], [peerAgent.id, true]].sort(), `${label} roster`);
    await removeAndRestore(db, api, peerAgent.id, peerThreadId, `${label} (peer Agent)`);
    await removeAndRestore(db, api, hostAgent.id, hostThreadId, `${label} (own Agent)`);
  }

  // Another server's owner/admin manages only its own server's Agents.
  const peerAdminApi = followerApi(http, peerOwner, peer, peerThreadId);
  const peerRoster = await peerAdminApi.roster();
  assert.equal(peerRoster.canManage, true);
  assert.deepEqual(peerRoster.agents.map((row) => [row.id, row.canRemove]).sort(),
    [[hostAgent.id, false], [peerAgent.id, true]].sort());
  await removeAndRestore(db, peerAdminApi, peerAgent.id, peerThreadId, "peer owner (own Agent)");
  const crossServer = await peerAdminApi.remove(hostAgent.id);
  assert.equal(crossServer.status, 403);
  assert.deepEqual(await crossServer.json(), { error: "Only a channel manager of the host server can remove another server's Agent followers" });
  assert.equal(await isFollowing(db, hostThreadId, "agent", hostAgent.id), true, "the host Agent still follows");
  // Restore follows the removal rule: the peer cannot undo the host's removal.
  const hostApi = followerApi(http, hostOwner, host, hostThreadId);
  const hostRemoval = await hostApi.remove(hostAgent.id);
  const { undoToken } = await hostRemoval.json() as { undoToken: string };
  const crossRestore = await peerAdminApi.restore(hostAgent.id, undoToken);
  assert.equal(crossRestore.status, 403);
  assert.deepEqual(await crossRestore.json(), { error: "Only a channel manager of the host server can restore another server's Agent followers" });
  assert.equal(await isFollowing(db, hostThreadId, "agent", hostAgent.id), false);
  assert.equal((await hostApi.restore(hostAgent.id, undoToken)).status, 200);

  // Plain members of either server manage nothing.
  for (const [actor, server, threadId, label] of [
    [hostPlain, host, hostThreadId, "host plain member"],
    [peerPlain, peer, peerThreadId, "peer plain member"],
  ] as const) {
    const api = followerApi(http, actor, server, threadId);
    assert.equal((await api.roster()).canManage, false, label);
    for (const agentId of [hostAgent.id, peerAgent.id]) {
      const denied = await api.remove(agentId);
      assert.equal(denied.status, 403, label);
      assert.deepEqual(await denied.json(), { error: "Only the thread author or a channel manager can remove followers" });
    }
  }
  assert.equal(await isFollowing(db, peerThreadId, "agent", peerAgent.id), true);
});
