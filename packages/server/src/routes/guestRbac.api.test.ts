import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { SERVER_GUEST_FEATURE_FLAG_KEY, asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agents, attachments, channelHumans, channels, featureFlagRules, featureFlags, messages, serverMembers, users } from "../db/schema.js";
import { createAgent } from "../services/agentService.js";
import { prepareActionCard } from "../services/actionCardsService.js";
import { addAgent, addHuman, createChannel, findOrCreateUserDM, getOrCreateThread, getSystemAllChannel, isChannelHuman } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { createServer, transitionMemberRole } from "../services/serverService.js";
import { __setStorageForTests, resetStorageForTests } from "../services/storageService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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

test("Guest channel access is gate-scoped, membership-aware, and read-only outside messaging", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-rbac-owner@slock.test", "guest-rbac-owner");
  const guest = await seedUser("guest-rbac-guest@slock.test", "guest-rbac-guest");
  const peer = await seedUser("guest-rbac-peer@slock.test", "guest-rbac-peer");
  const server = await createServer("Guest RBAC", `guest-rbac-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: guest.id, role: "guest" },
    { serverId: server.id, userId: peer.id, role: "member" },
  ]);
  const publicChannel = await createChannel(server.id, "guest-public", undefined, "channel");
  const hiddenPublicChannel = await createChannel(server.id, "guest-hidden-public", undefined, "channel");
  const privateChannel = await createChannel(server.id, "guest-private", undefined, "private");
  const ownerToken = await login(app.baseUrl, owner.email);
  const guestToken = await login(app.baseUrl, guest.email);
  const peerToken = await login(app.baseUrl, peer.email);
  const ownerHeaders = authHeaders(ownerToken, server.id);
  const guestHeaders = authHeaders(guestToken, server.id);
  const peerHeaders = authHeaders(peerToken, server.id);

  const gateOffPatch = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ guestVisible: true }),
  });
  assert.equal(gateOffPatch.status, 404, "missing/off Guest gate must hide the settings writer");
  const gateOffList = await fetch(`${app.baseUrl}/api/channels`, { headers: guestHeaders });
  assert.equal(gateOffList.status, 200);
  assert.equal(((await gateOffList.json()) as Array<{ id: string }>).some((row) => row.id === publicChannel.id), false);

  await enableGuestFlag(server.id);
  for (const serverWidePath of [
    `/api/servers/${server.id}/settings`,
    `/api/servers/${server.id}/usage`,
    `/api/servers/${server.id}/members`,
    `/api/servers/${server.id}/member-graph`,
    `/api/servers/${server.id}/machines`,
  ]) {
    const hiddenSurface = await fetch(`${app.baseUrl}${serverWidePath}`, { headers: guestHeaders });
    assert.equal(hiddenSurface.status, 403, `${serverWidePath} must stay hidden from Guests`);
  }
  await addHuman(publicChannel.id, peer.id, { role: "admin" });
  const visiblePatch = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: peerHeaders,
    body: JSON.stringify({ guestVisible: true, guestJoinable: true }),
  });
  assert.equal(visiblePatch.status, 200, "effective local admins may manage Guest access");
  const visibleHumanProfile = await fetch(
    `${app.baseUrl}/api/servers/${server.id}/members/${peer.id}/profile`,
    { headers: guestHeaders },
  );
  assert.equal(visibleHumanProfile.status, 200, "Guests may open a minimal profile for humans in readable channels");
  const visibleHumanProfileBody = await visibleHumanProfile.json() as Record<string, unknown>;
  assert.equal(visibleHumanProfileBody.profileProjection, "channel_summary");
  assert.equal(visibleHumanProfileBody.userId, peer.id);
  assert.equal(visibleHumanProfileBody.name, peer.name);
  assert.equal(visibleHumanProfileBody.email, null);
  assert.equal(visibleHumanProfileBody.role, null);
  assert.equal(visibleHumanProfileBody.joinedAt, null);
  assert.deepEqual(visibleHumanProfileBody.createdAgents, []);
  const localAdminVisibility = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: peerHeaders,
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(localAdminVisibility.status, 403, "Guest access authority does not grant visibility changes");
  const invalidInvariant = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ guestVisible: false, guestJoinable: true }),
  });
  assert.equal(invalidInvariant.status, 400, "invalid Guest policy is rejected before persistence");
  const guestCannotManage = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: guestHeaders,
    body: JSON.stringify({ guestVisible: false }),
  });
  assert.equal(guestCannotManage.status, 403);
  const readOnlyPatch = await fetch(`${app.baseUrl}/api/channels/${hiddenPublicChannel.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ guestVisible: true, guestJoinable: false }),
  });
  assert.equal(readOnlyPatch.status, 200);
  const visibleAgent = await createAgent(server.id, `guest-visible-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const readOnlyAgent = await createAgent(server.id, `guest-readonly-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const hiddenAgent = await createAgent(server.id, `guest-hidden-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await db.update(agents).set({
    description: "Objective channel-visible role description",
    envVars: { MUST_NOT_LEAK: "secret" },
  }).where(eq(agents.id, readOnlyAgent.id));
  await addAgent(publicChannel.id, visibleAgent.id);
  await addAgent(hiddenPublicChannel.id, readOnlyAgent.id);
  const invisibleAgentChannel = await createChannel(server.id, "guest-invisible-agent", undefined, "channel");
  await addAgent(invisibleAgentChannel.id, hiddenAgent.id);

  const guestAgentDirectory = await fetch(`${app.baseUrl}/api/agents`, { headers: guestHeaders });
  assert.equal(guestAgentDirectory.status, 200);
  const guestAgentRows = await guestAgentDirectory.json() as Array<Record<string, unknown>>;
  assert.deepEqual(
    new Set(guestAgentRows.map((row) => row.id)),
    new Set([visibleAgent.id, readOnlyAgent.id]),
    "Guest Agent list must be the union of readable-channel projections, not the server directory",
  );
  const readOnlyAgentSummary = await fetch(`${app.baseUrl}/api/agents/${readOnlyAgent.id}`, { headers: guestHeaders });
  assert.equal(readOnlyAgentSummary.status, 200);
  const summary = await readOnlyAgentSummary.json() as Record<string, unknown>;
  assert.equal(summary.profileProjection, "channel_summary");
  assert.equal(summary.description, "Objective channel-visible role description");
  for (const privateKey of ["envVars", "runtimeConfig", "runtime", "model", "machineId", "creatorId", "creatorType"]) {
    assert.equal(privateKey in summary, false, `Guest Agent summary must omit ${privateKey}`);
  }
  const privateAgentActivity = await fetch(`${app.baseUrl}/api/agents/${readOnlyAgent.id}/activity`, { headers: guestHeaders });
  assert.equal(privateAgentActivity.status, 403, "bounded Agent profiles must not open operational subresources");
  const hiddenAgentSummary = await fetch(`${app.baseUrl}/api/agents/${hiddenAgent.id}`, { headers: guestHeaders });
  assert.equal(hiddenAgentSummary.status, 404, "known Agent ids outside readable channels must not bypass projection scope");
  const readOnlyJoin = await fetch(`${app.baseUrl}/api/channels/${hiddenPublicChannel.id}/join`, {
    method: "POST",
    headers: guestHeaders,
  });
  assert.equal(readOnlyJoin.status, 403, "Guest-visible alone must not grant self-join");
  await db.update(channels).set({ guestVisible: false }).where(eq(channels.id, hiddenPublicChannel.id));
  const revokedAgentSummary = await fetch(`${app.baseUrl}/api/agents/${readOnlyAgent.id}`, { headers: guestHeaders });
  assert.equal(revokedAgentSummary.status, 404, "Agent profile access must revoke with the last readable-channel relation");
  const visibleList = await fetch(`${app.baseUrl}/api/channels`, { headers: guestHeaders });
  assert.equal(visibleList.status, 200);
  const guestChannels = await visibleList.json() as Array<{ id: string; joined: boolean; guestVisible: boolean; guestJoinable: boolean }>;
  const listedPublic = guestChannels.find((row) => row.id === publicChannel.id);
  assert.equal(listedPublic?.joined, false);
  assert.equal(listedPublic?.guestVisible, true);
  assert.equal(listedPublic?.guestJoinable, true);

  const allChannel = await getSystemAllChannel(server.id);
  assert.ok(allChannel);
  const exposeAll = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ guestVisible: true, guestJoinable: true }),
  });
  assert.equal(exposeAll.status, 400, "#all rejects the unsupported Guest Joinable field");
  const exposeAllReadOnly = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ guestVisible: true }),
  });
  assert.equal(exposeAllReadOnly.status, 200);
  const allVisibleList = await fetch(`${app.baseUrl}/api/channels`, { headers: guestHeaders });
  const allVisibleRows = await allVisibleList.json() as Array<{ id: string; joined: boolean; guestJoinable: boolean }>;
  const visibleAll = allVisibleRows.find((row) => row.id === allChannel.id);
  assert.equal(visibleAll?.joined, false);
  assert.equal(visibleAll?.guestJoinable, false);
  const joinAll = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/join`, {
    method: "POST",
    headers: guestHeaders,
  });
  assert.equal(joinAll.status, 403);
  assert.equal(await isChannelHuman(allChannel.id, guest.id), false);
  const addGuestToAll = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ userId: guest.id }),
  });
  assert.equal(addGuestToAll.status, 403);
  assert.equal(await isChannelHuman(allChannel.id, guest.id), false);
  const transitioningGuest = await seedUser("guest-rbac-transition@slock.test", "guest-rbac-transition");
  await db.insert(serverMembers).values({ serverId: server.id, userId: transitioningGuest.id, role: "member" });
  await db.insert(channelHumans).values({ channelId: allChannel.id, userId: transitioningGuest.id, role: "member" });
  await addHuman(publicChannel.id, transitioningGuest.id, { role: "admin" });
  const transitioningGuestToken = await login(app.baseUrl, transitioningGuest.email);
  const transitioningGuestHeaders = authHeaders(transitioningGuestToken, server.id);
  assert.equal(await isChannelHuman(allChannel.id, transitioningGuest.id), true);
  await transitionMemberRole({
    serverId: server.id,
    actorUserId: owner.id,
    targetUserId: transitioningGuest.id,
    nextRole: "guest",
    guestTransitionsEnabled: true,
  });
  assert.equal(
    await isChannelHuman(allChannel.id, transitioningGuest.id),
    false,
    "Member-to-Guest removes any legacy explicit #all membership atomically",
  );
  const [transitionedOrdinaryMembership] = await db.select().from(channelHumans).where(and(
    eq(channelHumans.channelId, publicChannel.id),
    eq(channelHumans.userId, transitioningGuest.id),
  ));
  assert.equal(
    transitionedOrdinaryMembership?.role,
    "member",
    "Member-to-Guest revokes stored ordinary-channel admin while preserving membership",
  );
  assert.equal(
    transitionedOrdinaryMembership?.authorityRevision,
    2,
    "Member-to-Guest invalidates the prior stored authority revision",
  );
  const transitionedGuestManage = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}`, {
    method: "PATCH",
    headers: transitioningGuestHeaders,
    body: JSON.stringify({ guestJoinable: false }),
  });
  assert.equal(transitionedGuestManage.status, 403, "transitioned Guest cannot retain channel management authority");
  const transitionedGuestRoleChange = await fetch(
    `${app.baseUrl}/api/channels/${publicChannel.id}/members/user/${peer.id}/role`,
    {
      method: "PATCH",
      headers: transitioningGuestHeaders,
      body: JSON.stringify({ role: "member" }),
    },
  );
  assert.equal(transitionedGuestRoleChange.status, 403, "transitioned Guest cannot change channel member roles");
  const allMessage = await createMessage(allChannel.id, "user", owner.id, "guest-all-read-only");
  const allHistory = await fetch(`${app.baseUrl}/api/messages/channel/${allChannel.id}`, { headers: guestHeaders });
  assert.equal(allHistory.status, 200);
  const allHistoryBody = await allHistory.json() as { messages?: Array<{ id: string }> } | Array<{ id: string }>;
  const allMessages = Array.isArray(allHistoryBody) ? allHistoryBody : allHistoryBody.messages ?? [];
  assert.equal(allMessages.some((row) => row.id === allMessage.id), true);
  const reactAll = await fetch(`${app.baseUrl}/api/messages/${allMessage.id}/reactions`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(reactAll.status, 403, "readable #all never grants reaction authority");
  const allRoster = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, { headers: guestHeaders });
  assert.equal(allRoster.status, 200);
  const allRosterBody = await allRoster.json() as { humans: Array<{ id: string }> };
  assert.equal(allRosterBody.humans.some((row) => row.id === guest.id), false);
  // Repointed to the dedicated endpoint (task #67): #all is no longer hideable
  // through the generic visibility field. What this test asserts about Guests is
  // unchanged -- only the way the fixture reaches the hidden state.
  const hideAll = await fetch(`${app.baseUrl}/api/channels/system/all/hide`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(hideAll.status, 200);
  const allHiddenList = await fetch(`${app.baseUrl}/api/channels`, { headers: guestHeaders });
  assert.equal(((await allHiddenList.json()) as Array<{ id: string }>).some((row) => row.id === allChannel.id), false);

  const parentMessage = await createMessage(publicChannel.id, "user", owner.id, "guest-visible-search-sentinel");
  await createMessage(hiddenPublicChannel.id, "user", owner.id, "guest-hidden-search-sentinel");
  const guestSearch = await fetch(`${app.baseUrl}/api/messages/search?q=guest-search-sentinel`, { headers: guestHeaders });
  assert.equal(guestSearch.status, 200);
  const searchBody = await guestSearch.json() as { results: Array<{ channelId: string }> };
  assert.equal(searchBody.results.some((row) => row.channelId === publicChannel.id), true);
  assert.equal(searchBody.results.some((row) => row.channelId === hiddenPublicChannel.id), false);

  const unjoinedSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: publicChannel.id, content: "must not send yet" }),
  });
  assert.equal(unjoinedSend.status, 403);

  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");
  const unjoinedThreadRead = await fetch(`${app.baseUrl}/api/messages/channel/${thread.id}`, { headers: guestHeaders });
  assert.equal(unjoinedThreadRead.status, 200, "thread reads inherit Guest visibility from the parent channel");
  const unjoinedThreadSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: thread.id, content: "must not reply yet" }),
  });
  assert.equal(unjoinedThreadSend.status, 403);

  const joinPublic = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}/join`, {
    method: "POST",
    headers: guestHeaders,
  });
  assert.equal(joinPublic.status, 200);
  const repeatJoin = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}/join`, {
    method: "POST",
    headers: guestHeaders,
  });
  assert.equal(repeatJoin.status, 200, "already-member Guest join remains an idempotent no-op");
  const promoteGuest = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}/members/user/${guest.id}/role`, {
    method: "PATCH",
    headers: peerHeaders,
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promoteGuest.status, 409, "Guest membership cannot acquire channel-admin capabilities");
  assert.equal((await promoteGuest.json() as { code?: string }).code, "guest_channel_admin_forbidden");
  const guestMembershipRows = await db.select({ userId: channelHumans.userId, role: channelHumans.role })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, publicChannel.id));
  assert.equal(guestMembershipRows.filter((row) => row.userId === guest.id).length, 1);
  assert.equal(guestMembershipRows.find((row) => row.userId === guest.id)?.role, "member");
  const joinedSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: publicChannel.id, content: "joined Guest message" }),
  });
  assert.equal(joinedSend.status, 200);
  const joinedThreadSend = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ channelId: thread.id, content: "joined Guest thread reply" }),
  });
  assert.equal(joinedThreadSend.status, 200);

  await db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, SERVER_GUEST_FEATURE_FLAG_KEY));
  const killedList = await fetch(`${app.baseUrl}/api/channels`, { headers: guestHeaders });
  assert.equal(killedList.status, 200);
  assert.equal(((await killedList.json()) as Array<{ id: string }>).some((row) => row.id === publicChannel.id), false);
  await db.update(featureFlags).set({ killSwitch: false }).where(eq(featureFlags.key, SERVER_GUEST_FEATURE_FLAG_KEY));

  await addHuman(publicChannel.id, owner.id);
  const ownerTaskCreate = await fetch(`${app.baseUrl}/api/tasks/channel/${publicChannel.id}`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ tasks: [{ title: "Guest-readable task" }] }),
  });
  assert.equal(ownerTaskCreate.status, 200);
  const guestTaskList = await fetch(`${app.baseUrl}/api/tasks/channel/${publicChannel.id}`, { headers: guestHeaders });
  assert.equal(guestTaskList.status, 200, "Guests may read tasks in readable channels");
  const guestServerTasks = await fetch(`${app.baseUrl}/api/tasks/server`, { headers: guestHeaders });
  assert.equal(guestServerTasks.status, 200);
  const guestServerTaskBody = await guestServerTasks.json() as { tasks: Array<{ channelId: string }> };
  assert.equal(guestServerTaskBody.tasks.some((task) => task.channelId === publicChannel.id), true);
  assert.equal(guestServerTaskBody.tasks.some((task) => task.channelId === hiddenPublicChannel.id), false);

  const taskCreate = await fetch(`${app.baseUrl}/api/tasks/channel/${publicChannel.id}`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ tasks: [{ title: "Guest must not create" }] }),
  });
  assert.equal(taskCreate.status, 403);

  await addHuman(privateChannel.id, guest.id);
  const privateRead = await fetch(`${app.baseUrl}/api/messages/channel/${privateChannel.id}`, { headers: guestHeaders });
  assert.equal(privateRead.status, 200, "explicit private membership grants Guest read access");

  const roster = await fetch(`${app.baseUrl}/api/channels/${publicChannel.id}/members`, { headers: guestHeaders });
  assert.equal(roster.status, 200);
  const rosterBody = await roster.json() as { humans: Array<Record<string, unknown>> };
  const guestRow = rosterBody.humans.find((row) => row.id === guest.id);
  assert.equal(guestRow?.effectiveChannelRole, "guest");
  assert.equal("serverRole" in (guestRow ?? {}), false);
  assert.equal("description" in (guestRow ?? {}), false);

  const newDm = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ userId: peer.id }),
  });
  assert.equal(newDm.status, 403);
  const existing = await findOrCreateUserDM(server.id, guest.id, owner.id);
  assert.ok(existing);
  const existingDm = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ userId: owner.id }),
  });
  assert.equal(existingDm.status, 200, "existing Guest DM remains openable");

  await db.update(channels).set({ guestVisible: false, guestJoinable: false }).where(eq(channels.id, publicChannel.id));
  await db.delete(channelHumans).where(eq(channelHumans.channelId, publicChannel.id));
  const revokedRead = await fetch(`${app.baseUrl}/api/messages/channel/${publicChannel.id}`, { headers: guestHeaders });
  assert.equal(revokedRead.status, 403, "removing both policy and membership revokes stale deep-link reads");
});

test("joined Guests can read action-card summaries but cannot execute or mark them", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("guest-card-owner@slock.test", "guest-card-owner");
  const guest = await seedUser("guest-card-guest@slock.test", "guest-card-guest");
  const server = await createServer("Guest Card", `guest-card-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest" });
  await enableGuestFlag(server.id);
  const carrier = await createChannel(server.id, "guest-card-carrier", undefined, "channel");
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, carrier.id));
  await addHuman(carrier.id, guest.id);
  const agent = await createAgent(server.id, `guest-card-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await addAgent(carrier.id, agent.id);
  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: carrier.id,
    action: { type: "channel:create", name: "guest-must-not-create", visibility: "public" },
  });
  const token = await login(app.baseUrl, guest.email);
  const headers = authHeaders(token, server.id);

  const history = await fetch(`${app.baseUrl}/api/messages/channel/${carrier.id}`, { headers });
  assert.equal(history.status, 200);
  const historyBody = await history.json() as { messages?: Array<{ id: string }> } | Array<{ id: string }>;
  const rows = Array.isArray(historyBody) ? historyBody : historyBody.messages ?? [];
  assert.equal(rows.some((row) => row.id === card.messageId), true, "Guest should read the card summary carrier");

  const execute = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(execute.status, 403);
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
});

test("Guest archive stays read-only while deletion cloaks every message and attachment path", async ({ app }) => {

  __setStorageForTests({
    async put() {},
    async get() { throw new Error("streaming is not expected"); },
    async delete() {},
    async getPresignedUrl() { return "https://storage.example.test/guest-lifecycle"; },
  });
  try {
    const db = getDb();
    const owner = await seedUser("guest-lifecycle-owner@slock.test", "guest-lifecycle-owner");
    const guest = await seedUser("guest-lifecycle-guest@slock.test", "guest-lifecycle-guest");
    const server = await createServer("Guest lifecycle", `guest-lifecycle-${randomUUID()}`, owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest" });
    await enableGuestFlag(server.id);

    const archivedChannel = await createChannel(server.id, "guest-archived", undefined, "channel");
    const deletedChannel = await createChannel(server.id, "guest-deleted", undefined, "channel");
    await db.update(channels).set({ guestVisible: true, guestJoinable: true })
      .where(eq(channels.id, archivedChannel.id));
    await db.update(channels).set({ guestVisible: true, guestJoinable: true })
      .where(eq(channels.id, deletedChannel.id));
    await addHuman(archivedChannel.id, guest.id);
    await addHuman(deletedChannel.id, guest.id);

    const archivedMarker = `guest-archive-${randomUUID()}`;
    await createMessage(archivedChannel.id, "user", owner.id, archivedMarker);
    const deletedMarker = `guest-delete-${randomUUID()}`;
    const deletedMessage = await createMessage(deletedChannel.id, "user", owner.id, deletedMarker);
    const deletedThread = await getOrCreateThread(deletedMessage.id, owner.id, "user");
    await createMessage(deletedThread.id, "user", owner.id, `${deletedMarker}-thread`);
    const [attachment] = await db.insert(attachments).values({
      messageId: deletedMessage.id,
      channelId: deletedChannel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "guest-lifecycle.txt",
      mimeType: "text/plain",
      sizeBytes: 24,
      storageKey: `${server.id}/guest-lifecycle.txt`,
      contentHash: "guest-lifecycle",
    }).returning();

    const guestToken = await login(app.baseUrl, guest.email);
    const headers = authHeaders(guestToken, server.id);
    const initialList = await fetch(`${app.baseUrl}/api/channels`, { headers });
    assert.equal(initialList.status, 200);
    const initialIds = new Set(((await initialList.json()) as Array<{ id: string }>).map((row) => row.id));
    assert.equal(initialIds.has(archivedChannel.id), true);
    assert.equal(initialIds.has(deletedChannel.id), true);

    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archivedChannel.id));
    const activeAfterArchive = await fetch(`${app.baseUrl}/api/channels`, { headers });
    const activeAfterArchiveIds = new Set(((await activeAfterArchive.json()) as Array<{ id: string }>).map((row) => row.id));
    assert.equal(activeAfterArchiveIds.has(archivedChannel.id), false, "archived channels leave the active list");
    const archivedRead = await fetch(`${app.baseUrl}/api/messages/channel/${archivedChannel.id}`, { headers });
    assert.equal(archivedRead.status, 200, "archived Guest history remains readable");
    const archivedSearch = await fetch(`${app.baseUrl}/api/messages/search?q=${encodeURIComponent(archivedMarker)}`, { headers });
    assert.equal(archivedSearch.status, 200);
    const archivedSearchBody = await archivedSearch.json() as { results: Array<{ channelId: string; channelArchivedAt: string | null }> };
    const archivedHit = archivedSearchBody.results.find((row) => row.channelId === archivedChannel.id);
    assert.ok(archivedHit?.channelArchivedAt, "archived Guest search hits retain their read-only marker");
    const archivedJoin = await fetch(`${app.baseUrl}/api/channels/${archivedChannel.id}/join`, { method: "POST", headers });
    assert.equal(archivedJoin.status, 409);
    const archivedPost = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers,
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
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest" });
  await enableGuestFlag(server.id);
  const channel = await createChannel(server.id, "hidden-metadata", undefined, "channel");
  const headers = authHeaders(await login(app.baseUrl, guest.email), server.id);
  for (const visible of [false, true]) {
    await getDb().update(channels).set({ guestVisible: visible }).where(eq(channels.id, channel.id));
    for (const suffix of ["", "/members", "/agents"]) {
      const response = await fetch(`${app.baseUrl}/api/channels/${channel.id}${suffix}`, { headers });
      assert.equal(response.status, visible ? 200 : 404, `${suffix}: ${await response.text()}`);
    }
  }
});
