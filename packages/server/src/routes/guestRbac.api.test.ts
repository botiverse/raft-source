import { fixturePasswordHash } from "../test/integration/credentials";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { PUBLIC_SERVER_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY, STORED_ACTION_CARD_ACTION_TYPES, actionCardTypeAuthority, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, agents, channelExternalInvites, channelHumans, channelServerConnectRequests, channels, featureFlagRules, featureFlags, messages, oauthClients, serverAgentMembers, serverMembers, serverMembershipDepartures, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { assertActionCardWritableByUser, prepareActionCard } from "../services/actionCardsService";
import { addAgent, addHuman, archiveChannel, createChannel, findOrCreateDM, findOrCreateUserDM, getOrCreateThread, getSystemAllChannel, isChannelHuman, setLocalChannelArchivedByAgent, unarchiveChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createOAuthClient } from "../services/oauthService";
import { ServerMemberRoleTransitionError, createServer, removeMemberInTransaction, transitionMemberRole } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { enableExternalChannelsFlag, sha256 } from "../test/externalInviteFixture";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __setStorageForTests, resetStorageForTests } from "../services/storageService";
import { expectedAppPermissionsJson } from "../test/integration/appPermissions";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function enableGuestFlag(serverId: string): Promise<void> {
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: SERVER_GUEST_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

/** Whether channels still has a guest_joinable column (retired, #wg-rbac:#47; dropped by channels_guest_joinable_drop). */
async function guestJoinableColumnExists(): Promise<boolean> {
  const result = await getDb().execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'guest_joinable'
  `);
  return result.rows.length > 0;
}

test("guest_joinable is gone: the column is dropped, PATCH ignores guestJoinable, guestVisible still saves, archive and unarchive work without it", async ({ app }) => {
  const owner = await seedUser("guest-joinable-retired-owner@slock.test", "guest-joinable-retired-owner");
  const server = await createServer("Guest Join retired", `guest-joinable-retired-${randomUUID()}`, owner.id);
  // guestVisible (now visitorVisible) turns on only for a public server (#wg-rbac:#51).
  await getDb().update(featureFlags).set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
  await getDb().update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
  const channel = await createChannel(server.id, "guest-joinable-retired", undefined, "channel", { type: "user", id: owner.id });
  const headers = authHeaders(await login(app.baseUrl, owner.email), server.id);
  assert.equal(await guestJoinableColumnExists(), false, "channels.guest_joinable is dropped");

  const response = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ guestVisible: true, guestJoinable: true }),
  });
  assert.equal(response.status, 200, "the visible half still saves for an owner of a public server");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.guestVisible, true);
  assert.equal("guestJoinable" in body, false, "the channel payload no longer carries guestJoinable");

  // guestJoinable alone is no Guest-policy request: no flag, no capability, no write.
  const joinableOnly = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ guestJoinable: true }),
  });
  assert.equal(joinableOnly.status, 200);

  const hide = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ guestVisible: false }),
  });
  assert.equal(hide.status, 200);
  assert.equal((await hide.json() as { guestVisible: boolean }).guestVisible, false);
  await archiveChannel(channel.id, owner.id);
  await unarchiveChannel(channel.id);
});

test("Guest channel access is its one bound channel, membership-aware, and denied everywhere else", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-rbac-owner@slock.test", "guest-rbac-owner");
  const guest = await seedUser("guest-rbac-guest@slock.test", "guest-rbac-guest");
  const peer = await seedUser("guest-rbac-peer@slock.test", "guest-rbac-peer");
  const server = await createServer("Guest RBAC", `guest-rbac-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: peer.id, role: "member" });
  // The guest's one channel (#wg-rbac:#15), with the peer in it.
  const guestChannel = await createChannel(server.id, "guest-home", undefined, "private");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: guestChannel.id });
  await addHuman(guestChannel.id, peer.id, { role: "admin" });
  // A public channel open to guests by the old flags, which grant nothing now.
  const publicChannel = await createChannel(server.id, "guest-public", undefined, "channel");
  const hiddenPublicChannel = await createChannel(server.id, "guest-hidden-public", undefined, "channel");
  // A private channel the guest is a member of, but not its bound channel.
  const privateChannel = await createChannel(server.id, "guest-private", undefined, "private");
  await addHuman(privateChannel.id, guest.id);
  const ownerToken = await login(app.baseUrl, owner.email);
  const guestToken = await login(app.baseUrl, guest.email);
  const peerToken = await login(app.baseUrl, peer.email);
  const ownerHeaders = authHeaders(ownerToken, server.id);
  const guestHeaders = authHeaders(guestToken, server.id);
  const peerHeaders = authHeaders(peerToken, server.id);

  for (const serverWidePath of [
    `/api/servers/${server.id}/settings`,
    `/api/servers/${server.id}/usage`,
    `/api/servers/${server.id}/members`,
    `/api/servers/${server.id}/machines`,
  ]) {
    const hiddenSurface = await fetch(`${app.baseUrl}${serverWidePath}`, { headers: guestHeaders });
    assert.equal(hiddenSurface.status, 403, `${serverWidePath} must stay hidden from Guests`);
  }
  // The visitor-visibility marker (guestVisible) grants Guests nothing
  // (#wg-rbac:#15); a channel admin may no longer set it (#wg-rbac:#51).
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, publicChannel.id));
  await addHuman(publicChannel.id, peer.id, { role: "admin" });
  const visiblePatch = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: peerHeaders,
    body: JSON.stringify({ guestVisible: false }),
  });
  assert.equal(visiblePatch.status, 403, "a channel admin role does not grant visitor access");
  const localAdminVisibility = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: peerHeaders,
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(localAdminVisibility.status, 403, "Guest access authority does not grant visibility changes");
  const invalidGuestVisible = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ guestVisible: "yes" }),
  });
  assert.equal(invalidGuestVisible.status, 400, "a non-boolean guestVisible is rejected before persistence");
  const guestCannotManagePolicy = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: guestHeaders,
    body: JSON.stringify({ guestVisible: false }),
  });
  assert.equal(guestCannotManagePolicy.status, 404, "a Guest cannot even see a channel other than its own");
  await addHuman(publicChannel.id, owner.id);

  // People: a Guest opens the profile of people in its channel, reduced to
  // identity, and nobody else's (matrix §1, cindyz 2026-11-03).
  const visibleHumanProfile = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${peer.id}/profile`, { headers: guestHeaders });
  assert.equal(visibleHumanProfile.status, 200, "a Guest opens the profile of someone in its channel");
  const visibleHumanProfileBody = await visibleHumanProfile.json() as Record<string, unknown>;
  assert.equal(visibleHumanProfileBody.profileProjection, "channel_summary");
  assert.equal(visibleHumanProfileBody.userId, peer.id);
  assert.equal(visibleHumanProfileBody.name, peer.name);
  assert.equal(visibleHumanProfileBody.email, null);
  assert.equal(visibleHumanProfileBody.role, null);
  assert.equal(visibleHumanProfileBody.joinedAt, null);
  assert.deepEqual(visibleHumanProfileBody.createdAgents, []);
  assert.equal("guestChannel" in visibleHumanProfileBody, false);
  const outsideMember = await seedUser("guest-rbac-outside@slock.test", "guest-rbac-outside");
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsideMember.id, role: "member" });
  for (const other of [owner, outsideMember]) {
    const hiddenHumanProfile = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${other.id}/profile`, { headers: guestHeaders });
    assert.equal(hiddenHumanProfile.status, 404, "a server member outside the Guest's channel stays hidden");
  }
  const guestCannotManage = await fetch(`${app.baseUrl}/api/channels/${guestChannel.id}`, {
    method: "PATCH",
    headers: guestHeaders,
    body: JSON.stringify({ name: "guest-renamed" }),
  });
  assert.equal(guestCannotManage.status, 403, "a Guest never manages its channel");

  const visibleAgent = await createAgent(server.id, `guest-visible-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const readOnlyAgent = await createAgent(server.id, `guest-readonly-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const hiddenAgent = await createAgent(server.id, `guest-hidden-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await db.update(agents).set({
    description: "Objective channel-visible role description",
    envVars: { MUST_NOT_LEAK: "secret" },
  }).where(eq(agents.id, visibleAgent.id));
  await addAgent(guestChannel.id, visibleAgent.id);
  await addAgent(publicChannel.id, readOnlyAgent.id);
  await addAgent(privateChannel.id, hiddenAgent.id);

  const guestAgentDirectory = await fetch(`${app.baseUrl}/api/agents`, { headers: guestHeaders });
  assert.equal(guestAgentDirectory.status, 200);
  const guestAgentRows = await guestAgentDirectory.json() as Array<Record<string, unknown>>;
  assert.deepEqual(
    new Set(guestAgentRows.map((row) => row.id)),
    new Set([visibleAgent.id]),
    "Guest Agent list is its channel's projection, not the server directory",
  );
  const visibleAgentSummary = await fetch(`${app.baseUrl}/api/agents/${visibleAgent.id}`, { headers: guestHeaders });
  assert.equal(visibleAgentSummary.status, 200);
  const summary = await visibleAgentSummary.json() as Record<string, unknown>;
  assert.equal(summary.profileProjection, "channel_summary");
  assert.equal(summary.description, "Objective channel-visible role description");
  for (const privateKey of ["envVars", "runtimeConfig", "runtime", "model", "machineId", "creatorId", "creatorType"]) {
    assert.equal(privateKey in summary, false, `Guest Agent summary must omit ${privateKey}`);
  }
  const privateAgentActivity = await fetch(`${app.baseUrl}/api/agents/${visibleAgent.id}/activity`, { headers: guestHeaders });
  assert.equal(privateAgentActivity.status, 403, "bounded Agent profiles must not open operational subresources");
  for (const agentId of [readOnlyAgent.id, hiddenAgent.id]) {
    const hiddenAgentSummary = await fetch(`${app.baseUrl}/api/agents/${agentId}`, { headers: guestHeaders });
    assert.equal(hiddenAgentSummary.status, 404, "known Agent ids outside its channel must not bypass projection scope");
  }
  const guestVisibleJoin = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}/join`, { method: "POST", headers: guestHeaders });
  assert.equal(guestVisibleJoin.status, 403, "Guest Join no longer lets a Guest join anything");
  assert.equal(await isChannelHuman(publicChannel.id, guest.id), false);

  const listed = await fetch(`${app.baseUrl}/api/channels`, { headers: guestHeaders });
  assert.equal(listed.status, 200);
  const listedIds = new Set(((await listed.json()) as Array<{ id: string }>).map((row) => row.id));
  assert.equal(listedIds.has(guestChannel.id), true, "its own channel is listed");
  for (const other of [publicChannel, hiddenPublicChannel, privateChannel]) {
    assert.equal(listedIds.has(other.id), false, `${other.name} is not listed`);
  }

  // #all, even marked visible (a row from before #wg-rbac:#51 refused it): nothing.
  const allChannel = await getSystemAllChannel(server.id);
  assert.ok(allChannel);
  // (Revealed by now: the server has grown into a team.)
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, allChannel.id));
  const allMessage = await createMessage(allChannel.id, "user", owner.id, "guest-all-hidden");
  const allList = await fetch(`${app.baseUrl}/api/channels`, { headers: guestHeaders });
  assert.equal(((await allList.json()) as Array<{ id: string }>).some((row) => row.id === allChannel.id), false);
  const allHistory = await fetch(`${app.baseUrl}/api/messages/channel/${allChannel.id}`, { headers: guestHeaders });
  assert.notEqual(allHistory.status, 200, "#all is never readable to a Guest");
  assert.equal((await allHistory.text()).includes(allMessage.id), false);
  const joinAll = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/join`, { method: "POST", headers: guestHeaders });
  assert.equal(joinAll.status, 403);
  const addGuestToAll = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ userId: guest.id }),
  });
  assert.equal(addGuestToAll.status, 403);
  assert.equal(await isChannelHuman(allChannel.id, guest.id), false);

  // A Member is never turned into a Guest: Guests are invited to a channel.
  const member = await seedUser("guest-rbac-transition@slock.test", "guest-rbac-transition");
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await db.insert(channelHumans).values({ channelId: allChannel.id, userId: member.id, role: "member" });
  await assert.rejects(
    transitionMemberRole({ serverId: server.id, actorUserId: owner.id, targetUserId: member.id, nextRole: "guest" }),
    (error: unknown) => error instanceof ServerMemberRoleTransitionError && error.code === "transition_forbidden",
  );
  const [stillMember] = await db.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  assert.equal(stillMember?.role, "member");
  assert.equal(await isChannelHuman(allChannel.id, member.id), true, "a refused transition leaves #all as it was");

  // Search: its channel only.
  const ownMessage = await createMessage(guestChannel.id, "user", peer.id, "guest-own-search-sentinel");
  await createMessage(publicChannel.id, "user", owner.id, "guest-visible-search-sentinel");
  await createMessage(hiddenPublicChannel.id, "user", owner.id, "guest-hidden-search-sentinel");
  await createMessage(privateChannel.id, "user", owner.id, "guest-private-search-sentinel");
  const guestSearch = await fetch(`${app.baseUrl}/api/messages/search?q=search-sentinel`, { headers: guestHeaders });
  assert.equal(guestSearch.status, 200);
  const searchBody = await guestSearch.json() as { results: Array<{ channelId: string }> };
  assert.equal(searchBody.results.some((row) => row.channelId === guestChannel.id), true);
  for (const other of [publicChannel, hiddenPublicChannel, privateChannel]) {
    assert.equal(searchBody.results.some((row) => row.channelId === other.id), false, `no ${other.name} hit`);
  }

  // Its channel: read, post, reply in threads, and tasks.
  const ownHistory = await fetch(`${app.baseUrl}/api/messages/channel/${guestChannel.id}`, { headers: guestHeaders });
  assert.equal(ownHistory.status, 200);
  const ownSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: guestChannel.id, content: "a Guest posts in its channel" }),
  });
  assert.equal(ownSend.status, 200, await ownSend.clone().text());
  const firstReply = await fetch(`${app.baseUrl}/api/channels/${guestChannel.id}/threads`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ parentMessageId: ownMessage.id, content: "a Guest's first thread reply" }),
  });
  assert.equal(firstReply.status, 200, await firstReply.clone().text());
  const thread = await getOrCreateThread(ownMessage.id, owner.id, "user");
  const threadRead = await fetch(`${app.baseUrl}/api/messages/channel/${thread.id}`, { headers: guestHeaders });
  assert.equal(threadRead.status, 200, "thread reads follow the parent channel");
  const threadSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: thread.id, content: "a Guest's thread reply" }),
  });
  assert.equal(threadSend.status, 200, await threadSend.clone().text());
  const promoteGuest = await fetch(`${app.baseUrl}/api/channels/${guestChannel.id}/members/user/${guest.id}/role`, {
    method: "PATCH",
    headers: peerHeaders,
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promoteGuest.status, 409, "Guest membership cannot acquire channel-admin capabilities");
  assert.equal((await promoteGuest.json() as { code?: string }).code, "guest_channel_admin_forbidden");
  const ownerTaskCreate = await fetch(`${app.baseUrl}/api/tasks/channel/${guestChannel.id}`, {
    method: "POST",
    headers: authHeaders(peerToken, server.id),
    body: JSON.stringify({ tasks: [{ title: "Guest-readable task" }] }),
  });
  assert.equal(ownerTaskCreate.status, 200);
  const publicTaskCreate = await fetch(`${app.baseUrl}/api/tasks/channel/${publicChannel.id}`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ tasks: [{ title: "Guest-hidden task" }] }),
  });
  assert.equal(publicTaskCreate.status, 200);
  const guestTaskList = await fetch(`${app.baseUrl}/api/tasks/channel/${guestChannel.id}`, { headers: guestHeaders });
  assert.equal(guestTaskList.status, 200, "Guests read tasks in their channel");
  const guestServerTasks = await fetch(`${app.baseUrl}/api/tasks/server`, { headers: guestHeaders });
  assert.equal(guestServerTasks.status, 200);
  const guestServerTaskBody = await guestServerTasks.json() as { tasks: Array<{ channelId: string }> };
  assert.equal(guestServerTaskBody.tasks.some((task) => task.channelId === guestChannel.id), true);
  assert.equal(guestServerTaskBody.tasks.some((task) => task.channelId === publicChannel.id), false);

  // Everywhere else: no read, no post, no task.
  for (const other of [publicChannel, hiddenPublicChannel, privateChannel]) {
    const read = await fetch(`${app.baseUrl}/api/messages/channel/${other.id}`, { headers: guestHeaders });
    assert.notEqual(read.status, 200, `${other.name}: no read`);
    const send = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: guestHeaders,
      body: JSON.stringify({ channelId: other.id, content: "must not send" }),
    });
    assert.equal(send.status, 403, `${other.name}: no post`);
    const taskCreate = await fetch(`${app.baseUrl}/api/tasks/channel/${other.id}`, {
      method: "POST",
      headers: guestHeaders,
      body: JSON.stringify({ tasks: [{ title: "Guest must not create" }] }),
    });
    assert.notEqual(taskCreate.status, 200, `${other.name}: no task`);
  }

  const roster = await fetch(`${app.baseUrl}/api/channels/${guestChannel.id}/members`, { headers: guestHeaders });
  assert.equal(roster.status, 200);
  const rosterBody = await roster.json() as { humans: Array<Record<string, unknown>> };
  const guestRow = rosterBody.humans.find((row) => row.id === guest.id);
  assert.equal(guestRow?.effectiveChannelRole, "guest");
  assert.equal("serverRole" in (guestRow ?? {}), false);
  assert.equal("description" in (guestRow ?? {}), false);

  // No DMs at all: none opened, an existing one neither opened nor written.
  const newDm = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ userId: peer.id }),
  });
  assert.equal(newDm.status, 403);
  const existing = await findOrCreateUserDM(server.id, guest.id, owner.id);
  assert.ok(existing);
  const existingDmRead = await fetch(`${app.baseUrl}/api/messages/channel/${existing.id}`, { headers: guestHeaders });
  assert.notEqual(existingDmRead.status, 200, "an existing Guest DM is not readable");
  const existingDmSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: existing.id, content: "must not send" }),
  });
  assert.equal(existingDmSend.status, 403, "an existing Guest DM is not writable");

  // Removed from its channel: access ends.
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, guestChannel.id), eq(channelHumans.userId, guest.id)));
  const revokedRead = await fetch(`${app.baseUrl}/api/messages/channel/${guestChannel.id}`, { headers: guestHeaders });
  // 403 rather than 404: the Guest was in it, so it already knows the channel
  // exists, and a 404 would only stop it clearing its stale Activity entry.
  assert.equal(revokedRead.status, 403, "removing the membership revokes a former member's stale deep-link read");
  const revokedSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: guestChannel.id, content: "must not send after removal" }),
  });
  assert.equal(revokedSend.status, 403);
});

test("a Guest's action cards are decided by its own permissions, in its own channel only (matrix §1)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-card-owner@slock.test", "guest-card-owner");
  const guest = await seedUser("guest-card-guest@slock.test", "guest-card-guest");
  const server = await createServer("Guest Card", `guest-card-${randomUUID()}`, owner.id);
  const carrier = await createChannel(server.id, "guest-card-carrier", undefined, "channel");
  const elsewhere = await createChannel(server.id, "guest-card-elsewhere", undefined, "channel");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: carrier.id });
  const agent = await createAgent(server.id, `guest-card-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await addAgent(carrier.id, agent.id);
  await addAgent(elsewhere.id, agent.id);
  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: carrier.id,
    action: { type: "channel:create", name: "guest-must-not-create", visibility: "public" },
  });
  const elsewhereCard = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: elsewhere.id,
    action: { type: "channel:create", name: "guest-elsewhere-create", visibility: "public" },
  });
  const token = await login(app.baseUrl, guest.email);
  const headers = authHeaders(token, server.id);

  const history = await fetch(`${app.baseUrl}/api/messages/channel/${carrier.id}`, { headers });
  assert.equal(history.status, 200);
  const historyBody = await history.json() as { messages?: Array<{ id: string }> } | Array<{ id: string }>;
  const rows = Array.isArray(historyBody) ? historyBody : historyBody.messages ?? [];
  assert.equal(rows.some((row) => row.id === card.messageId), true, "Guest should read the card summary carrier");

  // In its own channel the Guest passes the channel gate, and is then judged by
  // the card type's authority row (channel:create takes createChannels).
  await assert.rejects(
    assertActionCardWritableByUser({
      messageId: card.messageId, channelId: carrier.id, serverId: asServerId(server.id), userId: guest.id, executor: db,
    }),
    (error: unknown) => (error as { code?: string }).code === "MISSING_CREATE_CHANNELS_CAPABILITY",
    "refused by its own permission, not by the channel",
  );
  await assert.rejects(
    assertActionCardWritableByUser({
      messageId: elsewhereCard.messageId, channelId: elsewhere.id, serverId: asServerId(server.id), userId: guest.id, executor: db,
    }),
    (error: unknown) => [403, 404].includes((error as { status?: number }).status ?? 0),
    "never in another channel",
  );

  // The card's action takes the Guest's own permission, which it lacks here (createChannels).
  const execute = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(execute.status, 403, await execute.clone().text());
  assert.equal((await execute.json() as { errorCode?: string }).errorCode, "MISSING_CREATE_CHANNELS_CAPABILITY");
  const mark = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/mark-executed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ result: { kind: "channel", id: carrier.id, name: "fake" } }),
  });
  assert.equal(mark.status, 403);
  const [stored] = await db.select({ actionMetadata: messages.actionMetadata })
    .from(messages)
    .where(eq(messages.id, card.messageId));
  assert.equal((stored?.actionMetadata as { state?: string } | null)?.state, "prepared");
  const created = await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "guest-must-not-create")));
  assert.equal(created.length, 0, "no channel was created");
});

test("Guest access ends when its channel is archived, and deletion cloaks every message and attachment path", async ({ app }) => {

  __setStorageForTests({
    async put() {},
    async get() { throw new Error("streaming is not expected"); },
    async delete() {},
    async getPresignedUrl() { return "https://storage.example.test/guest-lifecycle"; },
  });
  try {
    const db = getDb();
    const owner = await seedUser("guest-lifecycle-owner@slock.test", "guest-lifecycle-owner");
    const archivedGuest = await seedUser("guest-lifecycle-guest@slock.test", "guest-lifecycle-guest");
    const deletedGuest = await seedUser("guest-lifecycle-guest-b@slock.test", "guest-lifecycle-guest-b");
    const server = await createServer("Guest lifecycle", `guest-lifecycle-${randomUUID()}`, owner.id);

    // Each Guest belongs to one channel (#wg-rbac:#15).
    const archivedChannel = await createChannel(server.id, "guest-archived", undefined, "channel");
    const deletedChannel = await createChannel(server.id, "guest-deleted", undefined, "channel");
    await seedBoundGuest({ serverId: server.id, userId: archivedGuest.id, channelId: archivedChannel.id });
    await seedBoundGuest({ serverId: server.id, userId: deletedGuest.id, channelId: deletedChannel.id });

    const archivedMarker = `guest-archive-${randomUUID()}`;
    await createMessage(archivedChannel.id, "user", owner.id, archivedMarker);
    const deletedMarker = `guest-delete-${randomUUID()}`;
    const deletedMessage = await createMessage(deletedChannel.id, "user", owner.id, deletedMarker);
    const deletedThread = await getOrCreateThread(deletedMessage.id, owner.id, "user");
    await createMessage(deletedThread.id, "user", owner.id, `${deletedMarker}-thread`);
    const [attachment] = await insertAttachmentsWithObjects(db, {
      messageId: deletedMessage.id,
      channelId: deletedChannel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "guest-lifecycle.txt",
      mimeType: "text/plain",
      sizeBytes: 24,
      storageKey: `${server.id}/guest-lifecycle.txt`,
      contentHash: "guest-lifecycle",
    });

    const archivedHeaders = authHeaders(await login(app.baseUrl, archivedGuest.email), server.id);
    const headers = authHeaders(await login(app.baseUrl, deletedGuest.email), server.id);
    for (const [who, channel] of [[archivedHeaders, archivedChannel], [headers, deletedChannel]] as const) {
      const initialList = await fetch(`${app.baseUrl}/api/channels`, { headers: who });
      assert.equal(initialList.status, 200);
      const initialIds = new Set(((await initialList.json()) as Array<{ id: string }>).map((row) => row.id));
      assert.equal(initialIds.has(channel.id), true, `${channel.name} is listed before`);
      const initialRead = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, { headers: who });
      assert.equal(initialRead.status, 200, `${channel.name} is readable before`);
    }

    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archivedChannel.id));
    const activeAfterArchive = await fetch(`${app.baseUrl}/api/channels`, { headers: archivedHeaders });
    const activeAfterArchiveIds = new Set(((await activeAfterArchive.json()) as Array<{ id: string }>).map((row) => row.id));
    assert.equal(activeAfterArchiveIds.has(archivedChannel.id), false, "archived channels leave the active list");
    const archivedRead = await fetch(`${app.baseUrl}/api/messages/channel/${archivedChannel.id}`, { headers: archivedHeaders });
    assert.notEqual(archivedRead.status, 200, "an archived channel ends the Guest's access");
    const archivedSearch = await fetch(`${app.baseUrl}/api/messages/search?q=${encodeURIComponent(archivedMarker)}`, { headers: archivedHeaders });
    assert.equal(archivedSearch.status, 200);
    const archivedSearchBody = await archivedSearch.json() as { results: Array<{ channelId: string }> };
    assert.equal(archivedSearchBody.results.some((row) => row.channelId === archivedChannel.id), false, "no archived hit for the Guest");
    const archivedPost = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: archivedHeaders,
      body: JSON.stringify({ channelId: archivedChannel.id, content: "must stay read-only" }),
    });
    assert.equal(archivedPost.status, 403);

    const attachmentBeforeDelete = await fetch(`${app.baseUrl}/api/attachments/${attachment.id}/url`, { headers });
    assert.equal(attachmentBeforeDelete.status, 200, "fixture attachment must be readable before deletion");
    await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deletedChannel.id));

    const activeAfterDelete = await fetch(`${app.baseUrl}/api/channels`, { headers });
    const activeAfterDeleteIds = new Set(((await activeAfterDelete.json()) as Array<{ id: string }>).map((row) => row.id));
    assert.equal(activeAfterDeleteIds.has(deletedChannel.id), false, "deleted channels remain absent from lists");
    const deletedRead = await fetch(`${app.baseUrl}/api/messages/channel/${deletedChannel.id}`, { headers });
    assert.equal(deletedRead.status, 404, "deleted channel deep-links are cloaked");
    const deletedThreadRead = await fetch(`${app.baseUrl}/api/messages/channel/${deletedThread.id}`, { headers });
    assert.equal(deletedThreadRead.status, 404, "thread deep-links are cloaked after parent deletion");
    const deletedSearch = await fetch(`${app.baseUrl}/api/messages/search?q=${encodeURIComponent(deletedMarker)}`, { headers });
    assert.equal(deletedSearch.status, 200);
    const deletedSearchBody = await deletedSearch.json() as { results: Array<{ channelId: string }> };
    assert.equal(deletedSearchBody.results.some((row) => row.channelId === deletedChannel.id), false);
    const attachmentAfterDelete = await fetch(`${app.baseUrl}/api/attachments/${attachment.id}/url`, { headers });
    assert.equal(attachmentAfterDelete.status, 404, "deleted channel attachments are cloaked");
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

test("channel detail and rosters apply guest visibility", async ({ app }) => {
  const owner = await seedUser("audit-metadata-owner@slock.test", "audit-metadata-owner");
  const guest = await seedUser("audit-metadata-guest@slock.test", "audit-metadata-guest");
  const server = await createServer("Metadata", `metadata-${randomUUID()}`, owner.id);
  const own = await createChannel(server.id, "guest-own-metadata", undefined, "private");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: own.id });
  // Another channel, guest-visible and with the guest in it: still not its channel.
  const channel = await createChannel(server.id, "hidden-metadata", undefined, "channel");
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
  await addHuman(channel.id, guest.id);
  const headers = authHeaders(await login(app.baseUrl, guest.email), server.id);
  for (const [target, visible] of [[channel, false], [own, true]] as const) {
    for (const suffix of ["", "/members", "/agents"]) {
      const response = await fetch(`${app.baseUrl}/api/channels/${target.id}${suffix}`, { headers });
      assert.equal(response.status, visible ? 200 : 404, `${target.name}${suffix}: ${await response.text()}`);
    }
  }
});

test("an agent cannot open a new DM with a Guest by name; existing Guest DMs and member DMs still work", async ({ app, db }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`agent-guest-dm-owner-${suffix}@slock.test`, `agent-guest-dm-owner-${suffix}`);
  const guest = await seedUser(`agent-guest-dm-guest-${suffix}@slock.test`, `agent-guest-dm-guest-${suffix}`);
  const earlyGuest = await seedUser(`agent-guest-dm-early-${suffix}@slock.test`, `agent-guest-dm-early-${suffix}`);
  const member = await seedUser(`agent-guest-dm-member-${suffix}@slock.test`, `agent-guest-dm-member-${suffix}`);
  const server = await createServer("Agent Guest DM", `agent-guest-dm-${suffix}`, owner.id);
  await enableGuestFlag(server.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  await seedBoundGuest({ serverId: server.id, userId: earlyGuest.id });
  const agent = await createAgent(server.id, `agent-guest-dm-bot-${suffix}`, { runtime: "codex" });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "agent-guest-dm", issuedVia: "computer", createdByUserId: null });
  // A DM that already exists (e.g. opened before the Guest gate) stays usable.
  const existingGuestDm = await findOrCreateDM(server.id, earlyGuest.id, agent.id);
  assert.ok(existingGuestDm);

  const send = async (target: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target, content: `hello ${target}` }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const dmCount = async () => (await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.type, "dm")))).length;

  const dmsBefore = await dmCount();
  const refused = await send(`dm:@${guest.name}`);
  assert.equal(refused.status, 403);
  assert.equal(typeof refused.body.error, "string");
  assert.equal(await dmCount(), dmsBefore, "no DM channel is created for the Guest");

  const existing = await send(`dm:@${earlyGuest.name}`);
  assert.equal(existing.status, 200);
  assert.equal(existing.body.state, "sent");
  const existingRows = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, existingGuestDm.id));
  assert.equal(existingRows.length, 1);

  const memberDm = await send(`dm:@${member.name}`);
  assert.equal(memberDm.status, 200);
  assert.equal(memberDm.body.state, "sent");
  assert.equal(await dmCount(), dmsBefore + 1);
});

test("Guests cannot read server-wide App catalogues; members still can (B18)", async ({ app }) => {
  const owner = await seedUser("guest-integrations-owner@slock.test", "guest-integrations-owner");
  const member = await seedUser("guest-integrations-member@slock.test", "guest-integrations-member");
  const guest = await seedUser("guest-integrations-guest@slock.test", "guest-integrations-guest");
  const publisher = await createServer("Publisher", `guest-integrations-pub-${randomUUID()}`, owner.id);
  const server = await createServer("Guest integrations", `guest-integrations-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  await enableGuestFlag(server.id);
  // An App installed here, so the per-App setup read has a real target for the member control.
  const created = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    name: "Guest Gate App",
    setupUrl: "https://setup.example.test/configure",
    setupDescription: "Choose a repository",
  });
  await getDb().update(oauthClients).set({ appType: "third_party_global", publishStatus: "published" })
    .where(eq(oauthClients.id, created.client.id));
  const install = await fetch(`${app.baseUrl}/api/integrations/marketplace/${created.client.id}/install`, {
    method: "POST",
    headers: authHeaders(await login(app.baseUrl, owner.email), server.id),
    body: await expectedAppPermissionsJson(created.client.id),
  });
  assert.equal(install.status, 200, await install.clone().text());

  const memberHeaders = authHeaders(await login(app.baseUrl, member.email), server.id);
  const guestHeaders = authHeaders(await login(app.baseUrl, guest.email), server.id);
  for (const path of [
    "/api/integrations/clients",
    "/api/integrations/overview",
    "/api/integrations/marketplace",
    "/api/integrations/marketplace/listings",
    `/api/integrations/clients/${created.client.id}/setup`,
  ]) {
    const memberRead = await fetch(`${app.baseUrl}${path}`, { headers: memberHeaders });
    assert.equal(memberRead.status, 200, `${path} member control: ${await memberRead.text()}`);
    const guestRead = await fetch(`${app.baseUrl}${path}`, { headers: guestHeaders });
    assert.equal(guestRead.status, 403, `${path} must be hidden from Guests`);
    assert.deepEqual(await guestRead.json(), { error: "Guests can't access server management" });
  }
});

test("A Guest's channel binding exists only on a Guest and is cleared on promotion (#wg-rbac:#15)", async ({ app: _app }) => {
  const db = getDb();
  const owner = await seedUser("guest-binding-owner@slock.test", "guest-binding-owner");
  const guest = await seedUser("guest-binding-guest@slock.test", "guest-binding-guest");
  const member = await seedUser("guest-binding-member@slock.test", "guest-binding-member");
  const server = await createServer("Guest binding", `guest-binding-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "guest-binding", undefined, "private");
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: guest.id, role: "guest", guestChannelId: channel.id },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  await addHuman(channel.id, guest.id);

  // A binding on anyone but a Guest is refused by the database.
  await assert.rejects(
    db.update(serverMembers).set({ guestChannelId: channel.id })
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id))),
    (error: unknown) => String((error as { cause?: unknown }).cause ?? error).includes("server_members_guest_channel_only_for_guest"),
  );

  await transitionMemberRole({
    serverId: server.id,
    actorUserId: owner.id,
    targetUserId: guest.id,
    nextRole: "member",
  });
  const [promoted] = await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guest.id)));
  assert.deepEqual(promoted, { role: "member", guestChannelId: null });
  assert.equal(await isChannelHuman(channel.id, guest.id), true, "promotion keeps the channel membership");
});

test("A Guest's server membership ends with its channel: leaving, removal, deletion and archive (#wg-rbac:#15)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-life-owner@slock.test", "guest-life-owner");
  const server = await createServer("Guest lifecycle", `guest-life-${randomUUID()}`, owner.id);
  const ownerHeaders = authHeaders(await login(app.baseUrl, owner.email), server.id);
  const membership = async (userId: string) => (await db.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, userId))))[0] ?? null;
  const departure = async (userId: string) => (await db.select({ reason: serverMembershipDepartures.reason, actorUserId: serverMembershipDepartures.actorUserId })
    .from(serverMembershipDepartures)
    .where(and(eq(serverMembershipDepartures.serverId, server.id), eq(serverMembershipDepartures.userId, userId))))[0] ?? null;
  const boundGuest = async (label: string) => {
    const guest = await seedUser(`guest-life-${label}@slock.test`, `guest-life-${label}`);
    const channel = await createChannel(server.id, `guest-life-${label}`, undefined, "private");
    await addHuman(channel.id, owner.id);
    await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
    return { guest, channel, headers: authHeaders(await login(app.baseUrl, guest.email), server.id) };
  };

  // Leaving its channel ends the Guest's server membership in the same commit.
  const leaver = await boundGuest("leaver");
  const left = await fetch(`${app.baseUrl}/api/channels/${leaver.channel.id}/leave`, { method: "POST", headers: leaver.headers });
  assert.equal(left.status, 200, await left.clone().text());
  assert.equal(await membership(leaver.guest.id), null, "no Guest is left with only a server membership");
  assert.equal(await isChannelHuman(leaver.channel.id, leaver.guest.id), false);
  assert.deepEqual(await departure(leaver.guest.id), { reason: "left", actorUserId: leaver.guest.id });

  // Removal by an admin: the same, recorded as removed by that admin.
  const removed = await boundGuest("removed");
  const removal = await fetch(`${app.baseUrl}/api/channels/${removed.channel.id}/members/user/${removed.guest.id}`, { method: "DELETE", headers: ownerHeaders });
  assert.equal(removal.status, 200, await removal.clone().text());
  assert.equal(await membership(removed.guest.id), null);
  assert.deepEqual(await departure(removed.guest.id), { reason: "removed", actorUserId: owner.id });

  // A member removed from a channel keeps the server, as before.
  const member = await seedUser("guest-life-member@slock.test", "guest-life-member");
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(removed.channel.id, member.id);
  const memberRemoval = await fetch(`${app.baseUrl}/api/channels/${removed.channel.id}/members/user/${member.id}`, { method: "DELETE", headers: ownerHeaders });
  assert.equal(memberRemoval.status, 200, await memberRemoval.clone().text());
  assert.deepEqual(await membership(member.id), { role: "member" });

  // Deleting the channel removes its Guest from the server.
  const deleted = await boundGuest("deleted");
  const deletion = await fetch(`${app.baseUrl}/api/channels/${deleted.channel.id}`, { method: "DELETE", headers: ownerHeaders });
  assert.equal(deletion.status, 200, await deletion.clone().text());
  assert.equal(await membership(deleted.guest.id), null);
  assert.deepEqual(await departure(deleted.guest.id), { reason: "removed", actorUserId: null });
  assert.equal(await isChannelHuman(deleted.channel.id, deleted.guest.id), false, "the deleted channel keeps no row for its departed Guest");

  // Archiving ends the Guest's membership too (owner decision 2026-11-03): no read, no post, no read-state write.
  const archived = await boundGuest("archived");
  const before = await fetch(`${app.baseUrl}/api/channels/${archived.channel.id}`, { headers: archived.headers });
  assert.equal(before.status, 200, await before.clone().text());
  const archive = await fetch(`${app.baseUrl}/api/channels/${archived.channel.id}/archive`, { method: "POST", headers: ownerHeaders });
  assert.equal(archive.status, 200, await archive.clone().text());
  const after = await fetch(`${app.baseUrl}/api/channels/${archived.channel.id}`, { headers: archived.headers });
  assert.notEqual(after.status, 200, "an archived channel is no longer readable to its Guest");
  const post = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST", headers: archived.headers, body: JSON.stringify({ channelId: archived.channel.id, content: "still here?" }),
  });
  assert.notEqual(post.status, 200);
  assert.notEqual(post.status, 201);
  const readAll = await fetch(`${app.baseUrl}/api/channels/${archived.channel.id}/read-all`, { method: "POST", headers: archived.headers });
  assert.notEqual(readAll.status, 200, "no read-state write on an archived channel");
  assert.equal(await membership(archived.guest.id), null, "archive ends the Guest's server membership");
  assert.deepEqual(await departure(archived.guest.id), { reason: "removed", actorUserId: owner.id });
  assert.equal(await isChannelHuman(archived.channel.id, archived.guest.id), false);
  // Unarchiving brings nobody back: the Guest needs a new invite.
  const unarchive = await fetch(`${app.baseUrl}/api/channels/${archived.channel.id}/unarchive`, { method: "POST", headers: ownerHeaders });
  assert.equal(unarchive.status, 200, await unarchive.clone().text());
  assert.equal(await membership(archived.guest.id), null, "unarchive does not restore the Guest");
  const afterUnarchive = await fetch(`${app.baseUrl}/api/channels/${archived.channel.id}`, { headers: archived.headers });
  assert.notEqual(afterUnarchive.status, 200);

  // An agent archiving the channel ends its Guest the same way.
  const agentArchived = await boundGuest("agent-archived");
  const archiver = await createAgent(server.id, `guest-life-archiver-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await addAgent(agentArchived.channel.id, archiver.id);
  await db.insert(serverAgentMembers).values({ serverId: server.id, agentId: archiver.id, role: "admin" })
    .onConflictDoUpdate({ target: [serverAgentMembers.serverId, serverAgentMembers.agentId], set: { role: "admin" } });
  const { channel: agentArchiveResult } = await setLocalChannelArchivedByAgent(agentArchived.channel.id, archiver.id, true);
  assert.ok(agentArchiveResult.archivedAt);
  assert.equal(await membership(agentArchived.guest.id), null, "an agent's archive ends the Guest's membership");
  assert.deepEqual(await departure(agentArchived.guest.id), { reason: "removed", actorUserId: null });
});

test("archiving a channel revokes its open external invites and their approval requests; unarchive revives none (plan §8)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-arch-inv-owner@slock.test", "guest-arch-inv-owner");
  const invitee = await seedUser("guest-arch-inv-invitee@slock.test", "guest-arch-inv-invitee");
  const requester = await seedUser("guest-arch-inv-requester@slock.test", "guest-arch-inv-requester");
  const server = await createServer("Archive invites", `guest-arch-inv-${randomUUID()}`, owner.id);
  const target = await createServer("Archive target", `guest-arch-target-${randomUUID()}`, requester.id);
  await enableExternalChannelsFlag(server.id);
  const channel = await createChannel(server.id, "guest-arch-inv", undefined, "private");
  await addHuman(channel.id, owner.id);
  const other = await createChannel(server.id, "guest-arch-inv-other", undefined, "private");
  await addHuman(other.id, owner.id);
  const seedInvite = async (channelId: string, email: string, status: "pending" | "awaiting_approval") => {
    const token = randomBytes(32).toString("hex");
    const [row] = await db.insert(channelExternalInvites).values({
      channelId, hostServerId: server.id, email, tokenHash: sha256(token), invitedByUserId: owner.id,
      status, expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    }).returning({ id: channelExternalInvites.id });
    return { id: row!.id, token };
  };
  const pending = await seedInvite(channel.id, invitee.email, "pending");
  const awaiting = await seedInvite(channel.id, requester.email, "awaiting_approval");
  const [request] = await db.insert(channelServerConnectRequests).values({
    inviteId: awaiting.id, channelId: channel.id, hostServerId: server.id, targetServerId: target.id,
    requesterUserId: requester.id, approverUserId: requester.id, expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  }).returning({ id: channelServerConnectRequests.id });
  const untouched = await seedInvite(other.id, invitee.email, "pending");
  const inviteeHeaders = authHeaders(await login(app.baseUrl, invitee.email), server.id);
  const ownerHeaders = authHeaders(await login(app.baseUrl, owner.email), server.id);
  const before = await fetch(`${app.baseUrl}/api/external-invites/${pending.token}`, { headers: inviteeHeaders });
  assert.equal(before.status, 200, await before.clone().text());

  const archive = await fetch(`${app.baseUrl}/api/channels/${channel.id}/archive`, { method: "POST", headers: ownerHeaders });
  assert.equal(archive.status, 200, await archive.clone().text());
  const inviteRow = async (id: string) => (await db.select({ status: channelExternalInvites.status, revokedByUserId: channelExternalInvites.revokedByUserId })
    .from(channelExternalInvites).where(eq(channelExternalInvites.id, id)))[0];
  assert.deepEqual(await inviteRow(pending.id), { status: "revoked", revokedByUserId: owner.id });
  assert.deepEqual(await inviteRow(awaiting.id), { status: "revoked", revokedByUserId: owner.id });
  assert.deepEqual(await inviteRow(untouched.id), { status: "pending", revokedByUserId: null }, "another channel's invite is untouched");
  const [requestRow] = await db.select({ status: channelServerConnectRequests.status, cancelReason: channelServerConnectRequests.cancelReason })
    .from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, request!.id));
  assert.deepEqual(requestRow, { status: "cancelled", cancelReason: "invite_revoked" });

  // Unarchiving revives no link: the old one stays invalid.
  const unarchive = await fetch(`${app.baseUrl}/api/channels/${channel.id}/unarchive`, { method: "POST", headers: ownerHeaders });
  assert.equal(unarchive.status, 200, await unarchive.clone().text());
  const after = await fetch(`${app.baseUrl}/api/external-invites/${pending.token}`, { headers: inviteeHeaders });
  assert.equal(after.status, 404, "the old invite link stays invalid after unarchive");
  assert.deepEqual((await inviteRow(pending.id))?.status, "revoked");
});

test("A Guest removal re-checks the binding under the membership lock: a promoted Guest is never removed from the server (#wg-rbac:#15)", async ({ app: _app }) => {
  const db = getDb();
  const owner = await seedUser("guest-race-owner@slock.test", "guest-race-owner");
  const promoted = await seedUser("guest-race-promoted@slock.test", "guest-race-promoted");
  const server = await createServer("Guest race", `guest-race-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, "guest-race", undefined, "private");
  const other = await createChannel(server.id, "guest-race-other", undefined, "private");
  await seedBoundGuest({ serverId: server.id, userId: promoted.id, channelId: channel.id });
  // The promotion commits after the removal's unlocked routing read.
  await transitionMemberRole({ serverId: server.id, actorUserId: owner.id, targetUserId: promoted.id, nextRole: "member" });
  assert.equal(await db.transaction((tx) => removeMemberInTransaction(tx, server.id, promoted.id, { onlyIfGuestBoundTo: channel.id })), null);
  // A Guest bound to another channel is not this channel's to remove either.
  const elsewhere = await seedUser("guest-race-elsewhere@slock.test", "guest-race-elsewhere");
  await seedBoundGuest({ serverId: server.id, userId: elsewhere.id, channelId: other.id });
  assert.equal(await db.transaction((tx) => removeMemberInTransaction(tx, server.id, elsewhere.id, { onlyIfGuestBoundTo: channel.id })), null);
  const rows = await db.select({ userId: serverMembers.userId, role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id)));
  assert.deepEqual(rows.find((row) => row.userId === promoted.id)?.role, "member");
  assert.deepEqual(rows.find((row) => row.userId === elsewhere.id)?.role, "guest");
});

test("The server member directory lists Guests only to owners and admins (#wg-rbac:#15)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-dir-owner@slock.test", "guest-dir-owner");
  const admin = await seedUser("guest-dir-admin@slock.test", "guest-dir-admin");
  const member = await seedUser("guest-dir-member@slock.test", "guest-dir-member");
  const guest = await seedUser("guest-dir-guest@slock.test", "guest-dir-guest");
  const server = await createServer("Guest directory", `guest-dir-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, "guest-dir", undefined, "private");
  await addHuman(channel.id, member.id);
  // Even a member sharing the Guest's channel meets it on the channel roster, not in the directory.
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
  const directoryIds = async (viewer: { email: string }) => {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, { headers: authHeaders(await login(app.baseUrl, viewer.email), server.id) });
    assert.equal(response.status, 200, await response.clone().text());
    return new Set((await response.json() as Array<{ userId: string }>).map((row) => row.userId));
  };
  assert.equal((await directoryIds(owner)).has(guest.id), true, "an owner sees the Guest");
  assert.equal((await directoryIds(admin)).has(guest.id), true, "an admin sees the Guest");
  const memberView = await directoryIds(member);
  assert.equal(memberView.has(guest.id), false, "a member does not see the Guest in the directory");
  assert.equal(memberView.has(owner.id), true, "a member still sees the other members");
});

test("a bound Guest reacts, uploads and works tasks in its own channel, assigning only to people in it (matrix §1)", async ({ app }) => {
  __setStorageForTests({
    async put() {},
    async get() { throw new Error("streaming is not expected"); },
    async delete() {},
    async getPresignedUrl() { return "https://storage.example.test/guest-work"; },
  });
  try {
    const db = getDb();
    const owner = await seedUser("guest-work-owner@slock.test", "guest-work-owner");
    const guest = await seedUser("guest-work-guest@slock.test", "guest-work-guest");
    const peer = await seedUser("guest-work-peer@slock.test", "guest-work-peer");
    const outsider = await seedUser("guest-work-outsider@slock.test", "guest-work-outsider");
    const server = await createServer("Guest work", `guest-work-${randomUUID()}`, owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: peer.id, role: "member" },
      { serverId: server.id, userId: outsider.id, role: "member" },
    ]);
    const home = await createChannel(server.id, "guest-work-home", undefined, "private");
    await addHuman(home.id, peer.id);
    await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: home.id });
    const other = await createChannel(server.id, "guest-work-other", undefined, "channel");
    await addHuman(other.id, outsider.id);
    const headers = authHeaders(await login(app.baseUrl, guest.email), server.id);
    const outsiderHeaders = authHeaders(await login(app.baseUrl, outsider.email), server.id);

    // Reactions: its channel yes, elsewhere no.
    const homeMessage = await createMessage(home.id, "user", peer.id, "react to me");
    const otherMessage = await createMessage(other.id, "user", outsider.id, "not yours");
    const react = await fetch(`${app.baseUrl}/api/messages/${homeMessage.id}/reactions`, { method: "POST", headers, body: JSON.stringify({ emoji: "👍" }) });
    assert.equal(react.status, 200, await react.clone().text());
    const reactElsewhere = await fetch(`${app.baseUrl}/api/messages/${otherMessage.id}/reactions`, { method: "POST", headers, body: JSON.stringify({ emoji: "👍" }) });
    assert.notEqual(reactElsewhere.status, 200, "no reaction outside its channel");

    // Uploads: its channel yes, elsewhere no.
    const upload = async (channelId: string) => {
      const body = new FormData();
      body.append("channelId", channelId);
      body.append("files", new Blob(["guest bytes"], { type: "text/plain" }), "guest.txt");
      return fetch(`${app.baseUrl}/api/attachments/upload`, {
        method: "POST",
        headers: { Authorization: headers.Authorization, "X-Server-Id": server.id },
        body,
      });
    };
    const homeUpload = await upload(home.id);
    assert.equal(homeUpload.status, 200, await homeUpload.clone().text());
    assert.equal((await upload(other.id)).status, 403, "no upload outside its channel");

    // Tasks: create, assign to someone in the channel, not to someone outside it; claim and unclaim.
    const create = await fetch(`${app.baseUrl}/api/tasks/channel/${home.id}`, {
      method: "POST", headers, body: JSON.stringify({ tasks: [{ title: "Guest task" }] }),
    });
    assert.equal(create.status, 200, await create.clone().text());
    const [task] = (await create.json() as { tasks: Array<{ id: string }> }).tasks;
    assert.ok(task);
    const assign = (assignee: { type: "user"; id: string } | null) => fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
      method: "PATCH", headers, body: JSON.stringify({ assignee }),
    });
    const toPeer = await assign({ type: "user", id: peer.id });
    assert.equal(toPeer.status, 200, await toPeer.clone().text());
    const toOutsider = await assign({ type: "user", id: outsider.id });
    assert.equal(toOutsider.status, 409, "assignee must be in the channel");
    assert.match((await toOutsider.json() as { error: string }).error, /not a member of this channel/);
    const unassign = await assign(null);
    assert.equal(unassign.status, 200, await unassign.clone().text());
    const claim = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, { method: "PATCH", headers });
    assert.equal(claim.status, 200, await claim.clone().text());
    const unclaim = await fetch(`${app.baseUrl}/api/tasks/${task.id}/unclaim`, { method: "PATCH", headers });
    assert.equal(unclaim.status, 200, await unclaim.clone().text());
    const status = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, { method: "PATCH", headers, body: JSON.stringify({ status: "in_review" }) });
    assert.equal(status.status, 200, await status.clone().text());

    // Another channel's task: not even visible, so not assignable.
    const otherCreate = await fetch(`${app.baseUrl}/api/tasks/channel/${other.id}`, {
      method: "POST", headers: outsiderHeaders, body: JSON.stringify({ tasks: [{ title: "Not the Guest's" }] }),
    });
    assert.equal(otherCreate.status, 200, await otherCreate.clone().text());
    const [otherTask] = (await otherCreate.json() as { tasks: Array<{ id: string }> }).tasks;
    const otherAssign = await fetch(`${app.baseUrl}/api/tasks/${otherTask!.id}/assignee`, {
      method: "PATCH", headers, body: JSON.stringify({ assignee: { type: "user", id: guest.id } }),
    });
    assert.equal(otherAssign.status, 404, "a Guest cannot touch another channel's task");
    const guestCreateElsewhere = await fetch(`${app.baseUrl}/api/tasks/channel/${other.id}`, {
      method: "POST", headers, body: JSON.stringify({ tasks: [{ title: "Guest must not create" }] }),
    });
    assert.notEqual(guestCreateElsewhere.status, 200);
  } finally {
    resetStorageForTests();
  }
});

test("a Guest's bound channel reaches only viewers who may see it; promotion clears the binding and keeps the channel (matrix §1, design D1/D2)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-bind-owner@slock.test", "guest-bind-owner");
  const admin = await seedUser("guest-bind-admin@slock.test", "guest-bind-admin");
  const insider = await seedUser("guest-bind-insider@slock.test", "guest-bind-insider");
  const outsider = await seedUser("guest-bind-outsider@slock.test", "guest-bind-outsider");
  const guest = await seedUser("guest-bind-guest@slock.test", "guest-bind-guest");
  const server = await createServer("Guest binding view", `guest-bind-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: insider.id, role: "member" },
    { serverId: server.id, userId: outsider.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, "guest-bind-secret", undefined, "private");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, admin.id);
  await addHuman(channel.id, insider.id);
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
  const headersOf = async (user: { email: string }) => authHeaders(await login(app.baseUrl, user.email), server.id);
  const ownerHeaders = await headersOf(owner);
  const expected = { id: channel.id, name: channel.name };

  // Members page Guests group: owners and admins, each Guest with its channel.
  for (const viewer of [owner, admin]) {
    const directory = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, { headers: await headersOf(viewer) });
    assert.equal(directory.status, 200);
    const rows = await directory.json() as Array<{ userId: string; guestChannel?: unknown }>;
    assert.deepEqual(rows.find((row) => row.userId === guest.id)?.guestChannel, expected, `${viewer.email} sees the Guest's channel`);
    assert.equal(rows.find((row) => row.userId === owner.id)?.guestChannel, null, "non-guests carry no channel");
  }
  // Profile: whoever may see the channel sees it; a member outside a private channel never learns its name.
  const profileOf = async (viewer: { email: string }) => {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${guest.id}/profile`, { headers: await headersOf(viewer) });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { role: string | null; guestChannel?: unknown };
  };
  assert.deepEqual((await profileOf(owner)).guestChannel, expected);
  assert.deepEqual((await profileOf(insider)).guestChannel, expected, "a member of the channel sees it");
  const outsiderView = await profileOf(outsider);
  assert.equal(outsiderView.guestChannel, null, "a member outside the private channel does not get its name");
  assert.equal(JSON.stringify(outsiderView).includes(channel.name), false);

  // Promote (design D2) is the role change: binding cleared, channel kept.
  const promote = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${guest.id}`, {
    method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "member" }),
  });
  assert.equal(promote.status, 200, await promote.clone().text());
  const [row] = await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guest.id)));
  assert.deepEqual(row, { role: "member", guestChannelId: null });
  assert.equal(await isChannelHuman(channel.id, guest.id), true, "promotion keeps the channel");
  const promotedProfile = await profileOf(owner);
  assert.equal(promotedProfile.role, "member");
  assert.equal(promotedProfile.guestChannel, undefined, "a member's profile names no guest channel");
});

test("an admin removes a bound Guest from the server, as a member; a member cannot (design D1)", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-rm-owner@slock.test", "guest-rm-owner");
  const admin = await seedUser("guest-rm-admin@slock.test", "guest-rm-admin");
  const member = await seedUser("guest-rm-member@slock.test", "guest-rm-member");
  const guest = await seedUser("guest-rm-guest@slock.test", "guest-rm-guest");
  const server = await createServer("Guest removal", `guest-rm-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, "guest-rm", undefined, "private");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
  const remove = async (viewer: { email: string }, targetId: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/members/${targetId}`, {
    method: "DELETE", headers: authHeaders(await login(app.baseUrl, viewer.email), server.id),
  });
  const membership = async (userId: string) => (await db.select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, userId))))[0] ?? null;

  assert.equal((await remove(member, guest.id)).status, 403, "a member cannot remove a Guest");
  assert.deepEqual(await membership(guest.id), { role: "guest" });
  assert.equal((await remove(admin, owner.id)).status, 403, "an admin still cannot remove the owner");
  const removed = await remove(admin, guest.id);
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(await membership(guest.id), null, "the admin's removal ends the Guest's membership");
  assert.equal(await isChannelHuman(channel.id, guest.id), false);
});

test("every action card type is gated by its authority row, on execute and mark-executed, for a Guest in its own channel", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-cardtypes-owner@slock.test", "guest-cardtypes-owner");
  const guest = await seedUser("guest-cardtypes-guest@slock.test", "guest-cardtypes-guest");
  const server = await createServer("Guest card types", `guest-cardtypes-${randomUUID()}`, owner.id);
  const carrier = await createChannel(server.id, "guest-cardtypes", undefined, "channel");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: carrier.id });
  const agent = await createAgent(server.id, `guest-cardtypes-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await addAgent(carrier.id, agent.id);
  const headers = authHeaders(await login(app.baseUrl, guest.email), server.id);
  const channelCount = async () => (await db.select({ id: channels.id }).from(channels).where(eq(channels.serverId, server.id))).length;
  const agentCount = async () => (await db.select({ id: agents.id }).from(agents).where(eq(agents.serverId, server.id))).length;

  // The same list the authority table is total over (STORED_ACTION_CARD_ACTION_TYPES):
  // a new type without a row does not compile, and gets checked here.
  for (const type of STORED_ACTION_CARD_ACTION_TYPES) {
    const authority = actionCardTypeAuthority(type);
    const payload = { type, agentId: agent.id, channel: carrier.id, name: `guest-cardtypes-${type.replace(/[^a-z]/g, "-")}` };
    const message = await createMessage(carrier.id, "agent", agent.id, "");
    await db.update(messages).set({
      actionMetadata: { kind: "action-card", state: "prepared", sourceServerId: server.id, action: payload, presentation: { title: type, confirmLabel: "Run", genericApprovalAllowed: false, displayItems: [] } },
    }).where(eq(messages.id, message.id));
    await db.insert(actionCards).values({ serverId: server.id, messageId: message.id, requesterAgentId: agent.id, actionType: type, payload });
    const before = { channels: await channelCount(), agents: await agentCount() };

    const execute = await fetch(`${app.baseUrl}/api/actions/${message.id}/execute`, {
      method: "POST", headers, body: JSON.stringify({ expectedState: "prepared" }),
    });
    const executeBody = await execute.json() as { errorCode?: string };
    const mark = await fetch(`${app.baseUrl}/api/actions/${message.id}/mark-executed`, {
      method: "POST", headers, body: JSON.stringify({ result: { kind: "channel", id: carrier.id, name: carrier.name } }),
    });
    const markBody = await mark.json() as { errorCode?: string };
    const permissionRefusal = (code: string | undefined) => code === "OWNER_ONLY" || /^MISSING_.*_CAPABILITY$/.test(code ?? "");

    if (authority.kind === "none") {
      assert.equal(permissionRefusal(executeBody.errorCode), false, `${type}: execute is not refused for a permission (${executeBody.errorCode})`);
      assert.equal(permissionRefusal(markBody.errorCode), false, `${type}: mark-executed is not refused for a permission (${markBody.errorCode})`);
    } else {
      assert.equal(execute.status, 403, `${type}: execute ${JSON.stringify(executeBody)}`);
      assert.equal(permissionRefusal(executeBody.errorCode), true, `${type}: execute refused by the authority row`);
      assert.equal(mark.status, 403, `${type}: mark-executed ${JSON.stringify(markBody)}`);
      assert.equal(permissionRefusal(markBody.errorCode), true, `${type}: mark-executed refused by the authority row`);
      const [card] = await db.select({ state: actionCards.state, executedByUserId: actionCards.executedByUserId })
        .from(actionCards).where(eq(actionCards.messageId, message.id));
      assert.deepEqual(card, { state: "prepared", executedByUserId: null }, `${type}: the card is unchanged`);
      const [carrierRow] = await db.select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, message.id));
      assert.equal((carrierRow?.actionMetadata as { state?: string }).state, "prepared", `${type}: the carrier is unchanged`);
      assert.deepEqual({ channels: await channelCount(), agents: await agentCount() }, before, `${type}: nothing was created`);
    }
  }
});
