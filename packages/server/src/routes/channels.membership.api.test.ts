import { tokenForHuman } from "../test/integration/credentials.js";
import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { and, desc, eq } from "drizzle-orm";
import {
  BasicTracer,
  MemoryTraceSink
} from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import {
  users, servers as serversTable,
  serverMembers,
  channels,
  channelHumans,
  channelAgents,
  messages, attachments, inboxNotificationFacts
} from "../db/schema.js";
import { addMember, removeMember, updateServerOnboardingAgent } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, addHuman, addAgent, removeHuman, removeAgent, findOrCreateDM, findOrCreateAgentDM, findOrCreateUserDM, canAgentAccessChannel, canAgentPostToChannel, canUserPostToChannel, isChannelHuman, resolveChannelByName } from "../services/channelService.js";
import {
  __resetMessageServiceDepsForTests,
  __setMessageServiceDepsForTests,
  createMessage,
} from "../services/messageService.js";
import {
  recordInboxNotificationFacts
} from "../services/inboxNotificationService.js";
import { registerMachine } from "../services/machineService.js";
import { assignMachine } from "../services/agentService.js";
import {
  __resetOnboardingServiceDepsForTests,
  __setOnboardingServiceDepsForTests,
  triggerAllChannelUnlockOnboarding,
} from "../services/onboardingService.js";
import { createServer, installFakeIo, headers, seedUser } from "./channels.api.fixtures.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });


test("member channel creator gains local admin edit but not server-only delete authority", async ({ app }) => {
  const owner = await seedUser("member-channel-owner@slock.test", "member-channel-owner");
  const member = await seedUser("member-channel-creator@slock.test", "member-channel-creator");
  const server = await createServer("Member Channel Create", "member-channel-create", owner.id);
  await addMember(server.id, member.id, "member");
  const memberToken = await tokenForHuman(member.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ name: "member-created-channel" }),
  });
  const createText = await createRes.text();
  assert.equal(createRes.status, 200, createText);
  const channel = JSON.parse(createText) as { id: string };

  const editRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ description: "creator has local channel admin authority" }),
  });
  assert.equal(editRes.status, 200);
  const [creatorMembership] = await getDb().select().from(channelHumans).where(and(
    eq(channelHumans.channelId, channel.id),
    eq(channelHumans.userId, member.id),
  ));
  assert.equal(creatorMembership?.role, "admin");

  const deleteRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "DELETE",
    headers: headers(memberToken, server.id),
  });
  assert.equal(deleteRes.status, 403);
});


test("GET /api/channels/dm records DM list phases and constant query shape", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "5".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const owner = await seedUser("dm-trace-owner@slock.test", "dm-trace-owner");
  const peer = await seedUser("dm-trace-peer@slock.test", "dm-trace-peer");
  const server = await createServer("DM Trace Server", "dm-trace-server", owner.id);
  await addMember(server.id, peer.id);
  const agent = await createAgent(server.id, "dm-trace-agent", { runtime: "codex" });
  const agentDm = await findOrCreateDM(server.id, owner.id, agent.id);
  const userDm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  const selfDm = await findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(agentDm);
  assert.ok(userDm);
  assert.ok(selfDm);
  const agentDmMessage = await createMessage(agentDm.id, "user", owner.id, "agent dm message");
  const userDmMessage = await createMessage(userDm.id, "user", peer.id, "user dm message");

  const ownerToken = await tokenForHuman(owner.email);
  sink.clear();

  const res = await fetch(`${app.baseUrl}/api/channels/dm`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: string; peerType: "agent" | "user"; lastMessageAt: string | null }>;
  assert.equal(body.length, 3);
  assert.equal(body.filter((channel) => channel.peerType === "agent").length, 1);
  assert.equal(body.filter((channel) => channel.peerType === "user").length, 2);
  assert.equal(body.find((channel) => channel.id === agentDm.id)?.lastMessageAt, agentDmMessage.createdAt.toISOString());
  assert.equal(body.find((channel) => channel.id === userDm.id)?.lastMessageAt, userDmMessage.createdAt.toISOString());
  assert.equal(body.find((channel) => channel.id === selfDm.id)?.lastMessageAt, null);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/dm",
  );
  assert.ok(span, "expected GET /api/channels/dm root span");

  const processEventNames = span.events
    .map((event) => event.name)
    .filter((name) => name !== "db.query.finished");
  assert.deepEqual(processEventNames, [
    "dm_channels.list.started",
    "dm_channels.loaded",
    "response.ready",
    "http.response.finished",
  ]);

  const dbEvents = span.events.filter((event) => event.name === "db.query.finished");
  assert.deepEqual(
    dbEvents.map((event) => event.attrs?.query_name).sort(),
    [
      "dm_channels.agent_dms_by_user",
      "dm_channels.last_messages_by_channels",
      "dm_channels.self_dms_by_user",
      "dm_channels.user_dms_by_user",
    ],
  );
  assert.equal(dbEvents.length, 4);
  assert.ok(dbEvents.length <= 4, "DM list query count should stay constant for mixed peer types");

  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("dm_channels.agent_dms_by_user")?.attrs?.phase, "dm_channels.loaded");
  assert.equal(dbEventByQuery.get("dm_channels.agent_dms_by_user")?.attrs?.row_count, 1);
  assert.equal(dbEventByQuery.get("dm_channels.user_dms_by_user")?.attrs?.row_count, 3);
  assert.equal(dbEventByQuery.get("dm_channels.self_dms_by_user")?.attrs?.row_count, 1);
  assert.equal(dbEventByQuery.get("dm_channels.last_messages_by_channels")?.attrs?.dm_channels_count, 3);
  assert.equal(dbEventByQuery.get("dm_channels.last_messages_by_channels")?.attrs?.channels_with_messages_count, 2);

  const loadedEvent = span.events.find((event) => event.name === "dm_channels.loaded");
  assert.ok(loadedEvent);
  assert.equal(loadedEvent.attrs?.dm_channels_count, 3);
  assert.equal(loadedEvent.attrs?.agent_dm_channels_count, 1);
  assert.equal(loadedEvent.attrs?.user_dm_channels_count, 2);

  const readyEvent = span.events.find((event) => event.name === "response.ready");
  assert.ok(readyEvent);
  assert.equal(readyEvent.attrs?.dm_channels_count, 3);
  assert.equal(Object.values(span.attrs ?? {}).includes(owner.id), false);
  assert.equal(Object.values(readyEvent.attrs ?? {}).includes(agentDm.id), false);
});


test("agent-to-agent DMs are not readable through human channel and attachment routes", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("agent-dm-owner@slock.test", "agent-dm-owner");
  const viewer = await seedUser("agent-dm-viewer@slock.test", "agent-dm-viewer");
  const server = await createServer("Agent DM Cloak Server", "agent-dm-cloak", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: viewer.id, role: "member" });

  const agentA = await createAgent(server.id, "agent-dm-cloak-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "agent-dm-cloak-b", { runtime: "codex" });
  const dm = await findOrCreateAgentDM(server.id, agentA.id, agentB.id);
  assert.ok(dm, "expected an agent-to-agent DM");

  const secretMessage = await createMessage(dm.id, "agent", agentA.id, "agent private transcript");
  const attachmentId = "00000000-0000-4000-8000-00000000a2ad";
  await db.insert(attachments).values({
    id: attachmentId,
    messageId: secretMessage.id,
    channelId: dm.id,
    uploaderId: agentA.id,
    uploaderType: "agent",
    filename: "agent-secret.html",
    mimeType: "text/html",
    sizeBytes: 64,
    storageKey: "attachments/agent-secret.html",
    contentHash: "agent-dm-secret",
  });

  const viewerToken = await tokenForHuman(viewer.email);
  const viewerHeaders = headers(viewerToken, server.id);

  const channelMessages = await fetch(`${app.baseUrl}/api/messages/channel/${dm.id}?limit=10`, {
    headers: viewerHeaders,
  });
  // task #48: denial is now non-disclosing. This human never had a relationship
  // with the agent-agent DM, so telling them it exists would be the oracle.
  assert.equal(channelMessages.status, 404, "same-server humans must not read agent-agent DM messages");

  const scopedSync = await fetch(`${app.baseUrl}/api/messages/sync?channel_id=${dm.id}&since_seq=0`, {
    headers: viewerHeaders,
  });
  assert.equal(scopedSync.status, 404, "same-server humans must not sync a known agent-agent DM");

  const search = await fetch(`${app.baseUrl}/api/messages/search?channelId=${dm.id}&q=agent`, {
    headers: viewerHeaders,
  });
  assert.equal(search.status, 404, "explicit search filters must cloak known agent-agent DM channels");

  const files = await fetch(`${app.baseUrl}/api/channels/${dm.id}/files`, {
    headers: viewerHeaders,
  });
  assert.equal(files.status, 404, "agent-agent DM files must not be listed for same-server humans");

  const download = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}`, {
    headers: viewerHeaders,
  });
  assert.equal(download.status, 404, "agent-agent DM attachment reads must cloak existence from same-server humans");

  const url = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}/url`, {
    headers: viewerHeaders,
  });
  assert.equal(url.status, 404, "agent-agent DM attachment URL reads must cloak existence from same-server humans");

  const previewUrl = await fetch(`${app.baseUrl}/api/attachments/${attachmentId}/html-preview-url`, {
    headers: viewerHeaders,
  });
  assert.equal(previewUrl.status, 404, "agent-agent DM HTML preview reads must cloak existence from same-server humans");

  const broadSync = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0&limit=100`, {
    headers: viewerHeaders,
  });
  assert.equal(broadSync.status, 200);
  const broadMessages = await broadSync.json() as Array<{ id: string; content: string; channelId: string }>;
  assert.equal(
    broadMessages.some((message) => message.id === secretMessage.id || message.content === "agent private transcript"),
    false,
    "broad sync must not include agent-agent DM messages for same-server humans",
  );
});


test("saved message list re-checks private channel membership", async ({ app, seed, http }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });

  const ownerToken = await tokenForHuman(owner.email);
  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({
      name: "saved-private",
      visibility: "private",
      userIds: [member.id],
    }),
  });
  assert.equal(createRes.status, 200);
  const privateChannel = await createRes.json() as { id: string; type: string };
  assert.equal(privateChannel.type, "private");
  const secretMessage = await createMessage(privateChannel.id, "user", owner.id, "saved private secret");

  const memberToken = await tokenForHuman(member.email);
  const memberHeaders = headers(memberToken, server.id);
  const save = await fetch(`${app.baseUrl}/api/channels/saved`, {
    method: "POST",
    headers: memberHeaders,
    body: JSON.stringify({ messageId: secretMessage.id }),
  });
  assert.equal(save.status, 200);

  const before = await http.as(member, server).get("/api/channels/saved");
  assert.equal(before.status, 200);
  assert.deepEqual((await before.json() as { saved: Array<{ messageId: string }> }).saved.map(row => row.messageId), [secretMessage.id]);
  const ownerClient = http.as(owner, server);
  const ownerSave = await ownerClient.request("/api/channels/saved", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: secretMessage.id }),
  });
  assert.equal(ownerSave.status, 200);

  await removeHuman(privateChannel.id, member.id);

  const hiddenMessages = await fetch(`${app.baseUrl}/api/messages/channel/${privateChannel.id}`, {
    headers: memberHeaders,
  });
  // task #48: a removed member who left NO residue row is indistinguishable
  // from a stranger to the server's own records, so ruling (1) sends them to
  // the non-disclosing 404. Still denied -- which is what this test is about.
  assert.equal(hiddenMessages.status, 404, "removed member must not read the private channel directly");

  const saved = await fetch(`${app.baseUrl}/api/channels/saved`, {
    headers: memberHeaders,
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { saved: Array<{ messageId: string; content: string }>; total: number };
  assert.equal(savedBody.total, 0, "saved count must not retain stale private rows after channel removal");
  assert.equal(
    savedBody.saved.some((entry) => entry.messageId === secretMessage.id || entry.content === "saved private secret"),
    false,
    "saved list must not retain private message content after channel removal",
  );

  const savedCheck = await fetch(`${app.baseUrl}/api/channels/saved/check`, {
    method: "POST",
    headers: memberHeaders,
    body: JSON.stringify({ messageIds: [secretMessage.id] }),
  });
  assert.equal(savedCheck.status, 200);
  const savedCheckBody = await savedCheck.json() as { savedIds: string[] };
  assert.deepEqual(
    savedCheckBody.savedIds,
    [],
    "saved status checks must not affirm a removed member's stale private saved message",
  );

  const unaffected = await ownerClient.get("/api/channels/saved");
  assert.equal(unaffected.status, 200);
  assert.deepEqual((await unaffected.json() as { saved: Array<{ messageId: string }> }).saved.map(row => row.messageId), [secretMessage.id], "revoking one reader preserves another reader's valid saved message");
});


test("POST /api/channels/dm hides newly-created user DM for passive peer only", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("dm-profile-owner@slock.test", "dm-profile-owner");
  const peer = await seedUser("dm-profile-peer@slock.test", "dm-profile-peer");
  const server = await createServer("DM Profile Server", "dm-profile-server", owner.id);
  await addMember(server.id, peer.id);
  const ownerToken = await tokenForHuman(owner.email);
  const peerToken = await tokenForHuman(peer.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ userId: peer.id }),
  });
  assert.equal(createRes.status, 200);
  const dm = await createRes.json() as { id: string; peerId: string };
  assert.equal(dm.peerId, peer.id);

  const memberRows = await db
    .select({ userId: serverMembers.userId, hiddenDmIds: serverMembers.hiddenDmIds })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, server.id));
  assert.deepEqual(memberRows.find((row) => row.userId === owner.id)?.hiddenDmIds ?? [], []);
  assert.deepEqual(memberRows.find((row) => row.userId === peer.id)?.hiddenDmIds ?? [], [dm.id]);

  const peerSidebarRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/sidebar-order`, {
    headers: headers(peerToken, server.id),
  });
  assert.equal(peerSidebarRes.status, 200);
  const peerSidebar = await peerSidebarRes.json() as { hiddenDmIds: string[] };
  assert.deepEqual(peerSidebar.hiddenDmIds, [dm.id]);

  await db.update(serverMembers).set({ hiddenDmIds: [] }).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, peer.id),
  ));
  const reopenExistingRes = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ userId: peer.id }),
  });
  assert.equal(reopenExistingRes.status, 200);
  const reopened = await reopenExistingRes.json() as { id: string };
  assert.equal(reopened.id, dm.id);

  const [peerAfterReopen] = await db
    .select({ hiddenDmIds: serverMembers.hiddenDmIds })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, peer.id)));
  assert.deepEqual(peerAfterReopen?.hiddenDmIds ?? [], [], "opening an existing DM must not re-hide it for the peer");
});


test("POST /api/channels/dm cannot bypass a hidden human directory with a known user id", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("dm-hidden-directory-owner@slock.test", "dm-hidden-directory-owner");
  const requester = await seedUser("dm-hidden-directory-requester@slock.test", "dm-hidden-directory-requester");
  const hiddenPeer = await seedUser("dm-hidden-directory-peer@slock.test", "dm-hidden-directory-peer");
  const server = await createServer("DM Hidden Directory", "dm-hidden-directory", owner.id);
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: requester.id, role: "member" },
    { serverId: server.id, userId: hiddenPeer.id, role: "member" },
  ]);
  const requesterToken = await tokenForHuman(requester.email);

  const openDm = (userId: string) => fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: headers(requesterToken, server.id),
    body: JSON.stringify({ userId }),
  });

  const blocked = await openDm(hiddenPeer.id);
  assert.equal(blocked.status, 404);
  assert.deepEqual(await blocked.json(), { error: "DM target not found" });

  const selfDm = await openDm(requester.id);
  assert.equal(selfDm.status, 200, "hidden-directory policy must not block self-DM");

  const existing = await findOrCreateUserDM(server.id, requester.id, hiddenPeer.id);
  assert.ok(existing);
  const reopened = await openDm(hiddenPeer.id);
  assert.equal(reopened.status, 200, "an existing DM remains available to its participant");
  assert.equal((await reopened.json() as { id: string }).id, existing.id);
});


test("message payload carries authoritative sender membership status", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "membership-owner@slock.test",
    name: "membership-owner",
    displayName: "Membership Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [newcomer] = await db.insert(users).values({
    email: "newcomer@slock.test",
    name: "newcomer",
    displayName: "Newcomer",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Membership Status Server", "membership-status", owner.id);
  await addMember(server.id, newcomer.id);

  const [allChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "expected #all channel");

  const message = await createMessage(allChannel.id, "user", newcomer.id, "hello right after joining");

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "membership-owner@slock.test", password: "password123" }),
  });
  assert.equal(login.status, 200);
  const { accessToken } = await login.json() as { accessToken: string };

  async function list() {
    const res = await fetch(`${app.baseUrl}/api/messages/channel/${allChannel.id}`, {
      headers: headers(accessToken, server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { messages: Array<{ id: string; senderMembershipStatus?: string | null }> };
    return body.messages.find((m) => m.id === message.id);
  }

  assert.equal((await list())?.senderMembershipStatus, "active");

  await removeMember(server.id, newcomer.id);

  assert.equal((await list())?.senderMembershipStatus, "removed");

  await addMember(server.id, newcomer.id);
  assert.equal((await list())?.senderMembershipStatus, "active");

  await removeMember(server.id, newcomer.id, {
    reason: "left",
    actorUserId: newcomer.id,
  });
  assert.equal((await list())?.senderMembershipStatus, "left");
});


test("POST /api/channels rejects each present invalid visibility without persistence or socket side effects", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("channel-create-visibility-owner@slock.test", "channel-create-visibility-owner");
  const server = await createServer("Channel Create Visibility", "channel-create-visibility", owner.id);
  const events = installFakeIo(app.app);
  const ownerToken = await tokenForHuman(owner.email);
  const invalidVisibilities: Array<{ label: string; value: unknown }> = [
    { label: "unknown string", value: "frobnicate" },
    { label: "null", value: null },
    { label: "number", value: 7 },
    { label: "empty string", value: "" },
  ];

  for (const [index, invalidVisibility] of invalidVisibilities.entries()) {
    const channelName = `invalid-visibility-${index}`;
    const membershipRowsBefore = await db.select({ channelId: channelHumans.channelId }).from(channelHumans);
    const eventCountBefore = events.length;

    const invalidRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: channelName, visibility: invalidVisibility.value }),
    });
    assert.equal(invalidRes.status, 400, `${invalidVisibility.label} visibility must fail closed`);
    assert.deepEqual(await invalidRes.json(), { error: "visibility must be one of: public, private, joint" });

    const persistedChannels = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, channelName)));
    assert.deepEqual(persistedChannels, [], `${invalidVisibility.label} must be rejected before inserting a channel`);

    const membershipRowsAfter = await db.select({ channelId: channelHumans.channelId }).from(channelHumans);
    assert.deepEqual(membershipRowsAfter, membershipRowsBefore, `${invalidVisibility.label} must not insert membership rows`);
    assert.equal(events.length, eventCountBefore, `${invalidVisibility.label} must not emit socket events`);
  }

  const omittedRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ name: "omitted-visibility-channel" }),
  });
  assert.equal(omittedRes.status, 200);
  const omittedBody = await omittedRes.json() as { id: string; type: string };
  assert.equal(omittedBody.type, "channel", "omitted visibility must keep the public-channel default");
  assert.equal(events.length, 1, "valid omitted visibility still broadcasts channel creation");
  assert.equal(events[0].room, `user:${owner.id}`);
  assert.equal(events[0].event, "channel:updated");
});


test("private channels are visible/readable only to invited members", async ({ app }) => {
  const owner = await seedUser("private-owner@slock.test", "private-owner");
  const invited = await seedUser("private-invited@slock.test", "private-invited");
  const outsider = await seedUser("private-outsider@slock.test", "private-outsider");
  const adminOutsider = await seedUser("private-admin-outsider@slock.test", "private-admin-outsider");
  const adminAdded = await seedUser("private-admin-added@slock.test", "private-admin-added");
  const server = await createServer("Private Channel Server", "private-channel-server", owner.id);
  await addMember(server.id, invited.id);
  await addMember(server.id, outsider.id);
  await addMember(server.id, adminOutsider.id, "admin");
  await addMember(server.id, adminAdded.id);
  const invitedAgent = await createAgent(server.id, "private-agent", { runtime: "codex" });
  const outsiderAgent = await createAgent(server.id, "private-outsider-agent", { runtime: "codex" });
  const adminAddedAgent = await createAgent(server.id, "private-admin-added-agent", { runtime: "codex" });
  const events = installFakeIo(app.app);

  const ownerToken = await tokenForHuman(owner.email);
  const invitedToken = await tokenForHuman(invited.email);
  const outsiderToken = await tokenForHuman(outsider.email);
  const adminOutsiderToken = await tokenForHuman(adminOutsider.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({
      name: "secret-room",
      description: "invite only",
      visibility: "private",
      userIds: [invited.id],
      agentIds: [invitedAgent.id],
    }),
  });
  assert.equal(createRes.status, 200);
  const privateChannel = await createRes.json() as { id: string; name: string; type: string; joined: boolean };
  assert.equal(privateChannel.name, "secret-room");
  assert.equal(privateChannel.type, "private");
  assert.equal(privateChannel.joined, true);
  assert.ok(!events.some((event) => event.room === `server:${server.id}`), "private create must not broadcast channel details to the whole server");
  assert.ok(events.some((event) => event.room === `user:${invited.id}` && event.event === "channel:updated"), "invited human should receive a targeted channel update");

  async function list(token: string) {
    const res = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(token, server.id),
    });
    assert.equal(res.status, 200);
    return await res.json() as Array<{ id: string; name: string; type: string; joined: boolean }>;
  }

  assert.ok((await list(ownerToken)).some((channel) => channel.id === privateChannel.id && channel.type === "private" && channel.joined));
  assert.ok((await list(invitedToken)).some((channel) => channel.id === privateChannel.id && channel.type === "private" && channel.joined));
  assert.ok(!(await list(outsiderToken)).some((channel) => channel.id === privateChannel.id), "non-invited server member must not see private channel in channel list");
  assert.ok(!(await list(adminOutsiderToken)).some((channel) => channel.id === privateChannel.id), "server admin must not see private channel in channel list without channel membership");

  const outsiderDetails = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(outsiderDetails.status, 404);

  const adminDetails = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    headers: headers(adminOutsiderToken, server.id),
  });
  assert.equal(adminDetails.status, 404, "server admin must not inspect private channel details without channel membership");

  const adminMembers = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/members`, {
    headers: headers(adminOutsiderToken, server.id),
  });
  assert.equal(adminMembers.status, 404, "server admin must not inspect private channel members without channel membership");

  const adminAgents = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/agents`, {
    headers: headers(adminOutsiderToken, server.id),
  });
  assert.equal(adminAgents.status, 404, "server admin must not inspect private channel agents without channel membership");

  const adminAddMember = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/members`, {
    method: "POST",
    headers: headers(adminOutsiderToken, server.id),
    body: JSON.stringify({ userId: adminAdded.id }),
  });
  assert.equal(adminAddMember.status, 200, "server admin may add members to a private channel without first joining");

  const adminAddAgent = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/members`, {
    method: "POST",
    headers: headers(adminOutsiderToken, server.id),
    body: JSON.stringify({ agentId: adminAddedAgent.id }),
  });
  assert.equal(adminAddAgent.status, 200, "server admin may add agents through inherited server authority");

  const adminRemoveHuman = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/members/user/${invited.id}`, {
    method: "DELETE",
    headers: headers(adminOutsiderToken, server.id),
  });
  assert.equal(adminRemoveHuman.status, 404, "server admin must not remove private channel humans without channel membership");

  const adminRemoveAgent = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/members/agent/${invitedAgent.id}`, {
    method: "DELETE",
    headers: headers(adminOutsiderToken, server.id),
  });
  assert.equal(adminRemoveAgent.status, 404, "server admin must not remove private channel agents without channel membership");

  const adminArchive = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/archive`, {
    method: "POST",
    headers: headers(adminOutsiderToken, server.id),
  });
  assert.equal(adminArchive.status, 404, "server admin must not archive an invisible private channel");

  const adminPatch = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    method: "PATCH",
    headers: headers(adminOutsiderToken, server.id),
    body: JSON.stringify({ description: "should stay hidden" }),
  });
  assert.equal(adminPatch.status, 404, "server admin must not patch an invisible private channel");

  const invitedDelete = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    method: "DELETE",
    headers: headers(invitedToken, server.id),
  });
  assert.equal(invitedDelete.status, 403, "private channel members without manageChannels must not delete the channel");

  const joinRes = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/join`, {
    method: "POST",
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(joinRes.status, 403);

  const invitedMessage = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(invitedToken, server.id),
    body: JSON.stringify({ channelId: privateChannel.id, content: "hello private" }),
  });
  assert.equal(invitedMessage.status, 200);
  const invitedMessageBody = await invitedMessage.json() as { id: string };

  const outsiderMessages = await fetch(`${app.baseUrl}/api/messages/channel/${privateChannel.id}`, {
    headers: headers(outsiderToken, server.id),
  });
  // task #48: an outsider gets the 404 that reveals nothing.
  assert.equal(outsiderMessages.status, 404);

  const outsiderPost = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(outsiderToken, server.id),
    body: JSON.stringify({ channelId: privateChannel.id, content: "should not send" }),
  });
  assert.equal(outsiderPost.status, 403);

  const invitedSync = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0`, {
    headers: headers(invitedToken, server.id),
  });
  assert.equal(invitedSync.status, 200);
  const invitedSyncBody = await invitedSync.json() as Array<{ id: string }>;
  assert.ok(invitedSyncBody.some((message) => message.id === invitedMessageBody.id));

  const outsiderSync = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0`, {
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(outsiderSync.status, 200);
  const outsiderSyncBody = await outsiderSync.json() as Array<{ id: string }>;
  assert.ok(!outsiderSyncBody.some((message) => message.id === invitedMessageBody.id), "gap sync must not leak private messages to non-members");

  assert.equal(await canAgentAccessChannel(privateChannel.id, invitedAgent.id), true);
  assert.equal(await canAgentAccessChannel(privateChannel.id, outsiderAgent.id), false);
  assert.deepEqual(await resolveChannelByName(server.id, invitedAgent.id, "#secret-room"), {
    channelId: privateChannel.id,
    type: "private",
  });
  assert.equal(await resolveChannelByName(server.id, outsiderAgent.id, "#secret-room"), null);

  const ownerDelete = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    method: "DELETE",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerDelete.status, 200, "private channel owner/admin can still delete a visible private channel");
});


test("public/private visibility conversion preserves membership rows and updates visibility surfaces", async ({ app }) => {
  const owner = await seedUser("visibility-owner@slock.test", "visibility-owner");
  const member = await seedUser("visibility-member@slock.test", "visibility-member");
  const server = await createServer("Visibility Toggle Server", "visibility-toggle-server", owner.id);
  await addMember(server.id, member.id);
  const agent = await createAgent(server.id, "visibility-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "toggle-room", "convert me");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const message = await createMessage(channel.id, "user", owner.id, "toggle room message");
  const events = installFakeIo(app.app);

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

  async function list(token: string) {
    const res = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(token, server.id),
    });
    assert.equal(res.status, 200);
    return await res.json() as Array<{ id: string; name: string; type: string; joined: boolean }>;
  }

  assert.ok((await list(memberToken)).some((item) => item.id === channel.id && item.type === "channel" && item.joined === false), "public channel is visible to non-joined server members");
  const publicMessages = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: headers(memberToken, server.id),
  });
  assert.equal(publicMessages.status, 200, "non-joined server members can read public channel history");

  events.length = 0;
  const toPrivate = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(toPrivate.status, 200);
  const privateBody = await toPrivate.json() as { id: string; type: string; name: string };
  assert.equal(privateBody.type, "private");

  assert.ok((await list(ownerToken)).some((item) => item.id === channel.id && item.type === "private" && item.joined === true), "existing joined human stays a private member");
  assert.ok(!(await list(memberToken)).some((item) => item.id === channel.id), "non-joined server member loses channel-list visibility after public -> private");
  const hiddenDetails = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(memberToken, server.id),
  });
  assert.equal(hiddenDetails.status, 404, "non-member permalink/details stop resolving after public -> private");
  const hiddenMessages = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: headers(memberToken, server.id),
  });
  // task #48: now byte-identical to the permalink/details 404 asserted just
  // above. Those two disagreeing was itself the inconsistency this closes.
  assert.equal(hiddenMessages.status, 404, "non-members cannot read history after public -> private");
  assert.equal(await canAgentAccessChannel(channel.id, agent.id), true, "existing joined agent stays a private member");

  assert.ok(!events.some((event) => event.room === `server:${server.id}` && event.event === "channel:updated"),
    "private metadata must never be sent to the server room");
  assert.ok(!events.some((event) => event.room === `user:${member.id}` && event.event === "channel:updated"),
    "non-members must not receive private metadata; real Socket tests cover their forced reconnect");
  assert.ok(events.some((event) => event.room === `user:${owner.id}` && event.event === "channel:updated"));

  const membershipRowsAfterPrivate = await getDb()
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, channel.id));
  assert.deepEqual(membershipRowsAfterPrivate.map((row) => row.userId), [owner.id], "public -> private snapshots existing joined humans only");
  const agentRowsAfterPrivate = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, channel.id));
  assert.deepEqual(agentRowsAfterPrivate.map((row) => row.agentId), [agent.id], "public -> private preserves existing joined agents");

  const systemMessagesAfterPrivate = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")));
  assert.deepEqual(systemMessagesAfterPrivate, [], "visibility conversion must not broadcast system messages");

  events.length = 0;
  const toPublic = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "public" }),
  });
  assert.equal(toPublic.status, 200);
  const publicBody = await toPublic.json() as { id: string; type: string };
  assert.equal(publicBody.type, "channel");

  assert.ok((await list(memberToken)).some((item) => item.id === channel.id && item.type === "channel" && item.joined === false), "private -> public restores visibility without joining non-members");
  const restoredMessages = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}`, {
    headers: headers(memberToken, server.id),
  });
  assert.equal(restoredMessages.status, 200);
  const restoredBody = await restoredMessages.json() as { messages: Array<{ id: string }> };
  assert.ok(restoredBody.messages.some((item) => item.id === message.id), "private -> public restores read access to existing history");

  const publicServerEvent = events.find((event) => event.room === `user:${member.id}` && event.event === "channel:updated");
  assert.ok(publicServerEvent, "private -> public must notify newly authorized readers");
  assert.equal((publicServerEvent.payload as { channel?: { id?: string; type?: string } }).channel?.id, channel.id);
  assert.equal((publicServerEvent.payload as { channel?: { type?: string } }).channel?.type, "channel");

  const membershipRowsAfterPublic = await getDb()
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, channel.id));
  assert.deepEqual(membershipRowsAfterPublic.map((row) => row.userId), [owner.id], "private -> public preserves member rows");
});


test("channel visibility conversion requires manageChannels and hides/restores system #all", async ({ app }) => {
  const owner = await seedUser("visibility-guard-owner@slock.test", "visibility-guard-owner");
  const member = await seedUser("visibility-guard-member@slock.test", "visibility-guard-member");
  const activeNewcomer = await seedUser("visibility-guard-active-newcomer@slock.test", "visibility-guard-active-newcomer");
  const hiddenNewcomer = await seedUser("visibility-guard-hidden-newcomer@slock.test", "visibility-guard-hidden-newcomer");
  const server = await createServer("Visibility Guard Server", "visibility-guard-server", owner.id);
  await addMember(server.id, member.id);
  const channel = await createChannel(server.id, "guard-room");
  await addHuman(channel.id, member.id);

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

  const memberToggle = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(memberToggle.status, 403, "ordinary channel members cannot change visibility");

  const invalidToggle = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "secret" }),
  });
  assert.equal(invalidToggle.status, 400);

  const createAll = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ name: "all" }),
  });
  assert.equal(createAll.status, 400, "ordinary channel creation must reserve #all");

  const channelsRes = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(channelsRes.status, 200);
  const allChannel = (await channelsRes.json() as Array<{ id: string; name: string; joined: boolean }>).find((item) => item.name === "all");
  assert.ok(allChannel);
  assert.equal(allChannel.joined, true, "virtual #all should render joined without channel membership rows");

  let allHumanRows = await getDb()
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, allChannel.id));
  assert.equal(allHumanRows.length, 0, "active #all must not persist human membership rows");

  await addMember(server.id, activeNewcomer.id);
  const activeAgent = await createAgent(server.id, "active-all-agent", { runtime: "codex" });
  let allAgentRows = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, allChannel.id));
  assert.equal(allAgentRows.length, 0, "active #all must not persist agent membership rows");
  allHumanRows = await getDb()
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, allChannel.id));
  assert.equal(allHumanRows.length, 0, "server join must not persist #all human membership rows");
  assert.equal(await canUserPostToChannel(allChannel.id, activeNewcomer.id), true, "server humans should be able to post to virtual #all");
  assert.equal(await canAgentPostToChannel(allChannel.id, activeAgent.id), true, "server agents should be able to post to virtual #all");

  const activeMembersRes = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(activeMembersRes.status, 200);
  const activeMembers = await activeMembersRes.json() as {
    humans: Array<{ id: string }>;
    agents: Array<{ id: string }>;
  };
  assert.ok(activeMembers.humans.some((human) => human.id === owner.id), "virtual #all should include server owner");
  assert.ok(activeMembers.humans.some((human) => human.id === member.id), "virtual #all should include existing server member");
  assert.ok(activeMembers.humans.some((human) => human.id === activeNewcomer.id), "virtual #all should include newly joined server member");
  assert.ok(activeMembers.agents.some((agent) => agent.id === activeAgent.id), "virtual #all should include newly created server agent");

  // Repointed to the dedicated endpoint (task #67): the generic visibility field
  // now refuses #all outright. Everything asserted after this point is unchanged.
  const genericHideRefused = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(genericHideRefused.status, 403, "#all must not be hideable through the generic visibility field");

  const allHide = await fetch(`${app.baseUrl}/api/channels/system/all/hide`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(allHide.status, 200, "the dedicated endpoint should hide the system channel");
  const hiddenAllBody = await allHide.json() as { id: string; name: string; type: string };
  assert.equal(hiddenAllBody.id, allChannel.id);
  assert.equal(hiddenAllBody.name, "all");
  assert.equal(hiddenAllBody.type, "private", "hidden #all should become a private virtual channel row");

  const hiddenListRes = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(hiddenListRes.status, 200);
  const hiddenList = await hiddenListRes.json() as Array<{ id: string; name: string }>;
  assert.ok(!hiddenList.some((item) => item.id === allChannel.id), "hidden #all must not list for channel managers");

  const agent = await createAgent(server.id, "hidden-all-agent", { runtime: "codex" });
  const [agentMembership] = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, allChannel.id), eq(channelAgents.agentId, agent.id)));
  assert.equal(agentMembership, undefined, "hidden #all must not auto-add newly created agents");

  await addMember(server.id, hiddenNewcomer.id);
  const [humanMembership] = await getDb()
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, allChannel.id), eq(channelHumans.userId, hiddenNewcomer.id)));
  assert.equal(humanMembership, undefined, "hidden #all must not lazy/auto-add newly joined humans");

  assert.equal(await resolveChannelByName(server.id, agent.id, "#all"), null, "hidden #all must not resolve as an agent send target");
  assert.equal(await canUserPostToChannel(allChannel.id, hiddenNewcomer.id), false, "hidden #all should deny virtual human post authority");
  assert.equal(await canAgentPostToChannel(allChannel.id, agent.id), false, "hidden #all should deny virtual agent post authority");

  const memberRestore = await fetch(`${app.baseUrl}/api/channels/system/all/restore`, {
    method: "POST",
    headers: headers(memberToken, server.id),
  });
  assert.equal(memberRestore.status, 403, "ordinary members cannot restore hidden #all from admin settings");

  const allRestore = await fetch(`${app.baseUrl}/api/channels/system/all/restore`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(allRestore.status, 200, "admin restore endpoint should restore system #all without requiring the hidden channel id");
  const restoredAllBody = await allRestore.json() as { type: string };
  assert.equal(restoredAllBody.type, "channel");

  const restoredListRes = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(restoredListRes.status, 200);
  const restoredList = await restoredListRes.json() as Array<{ id: string; name: string; joined: boolean }>;
  const restoredAll = restoredList.find((item) => item.id === allChannel.id);
  assert.ok(restoredAll, "restored #all must list again");
  assert.equal(restoredAll.joined, true, "restored virtual #all should render joined");
  assert.equal(await canUserPostToChannel(allChannel.id, hiddenNewcomer.id), true, "restored #all should derive human post authority from server membership");
  assert.equal(await canAgentPostToChannel(allChannel.id, agent.id), true, "restored #all should derive agent post authority from server membership");

  const restoredMembersRes = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(restoredMembersRes.status, 200);
  const restoredMembers = await restoredMembersRes.json() as {
    humans: Array<{ id: string }>;
    agents: Array<{ id: string }>;
  };
  assert.ok(restoredMembers.humans.some((human) => human.id === hiddenNewcomer.id), "restored #all should include humans who joined while hidden");
  assert.ok(restoredMembers.agents.some((candidate) => candidate.id === agent.id), "restored #all should include agents created while hidden");
  assert.equal(restoredMembers.humans.length, 4);
  assert.equal(restoredMembers.agents.length, 2);

  allHumanRows = await getDb()
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, allChannel.id));
  allAgentRows = await getDb()
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, allChannel.id));
  assert.equal(allHumanRows.length, 0, "restored #all must remain virtual for humans");
  assert.equal(allAgentRows.length, 0, "restored #all must remain virtual for agents");
});


test("manually hidden #all does not auto-reveal from onboarding unlock after member growth", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("manual-hidden-all-owner@slock.test", "manual-hidden-all-owner");
    const teammate = await seedUser("manual-hidden-all-teammate@slock.test", "manual-hidden-all-teammate");
    const server = await createServer("Manual Hidden All", "manual-hidden-all", owner.id);
    const ownerToken = await tokenForHuman(owner.email);

    const [allChannel] = await getDb()
      .select({ id: channels.id, type: channels.type })
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
    assert.ok(allChannel, "opener-world server should have an #all row");
    assert.equal(allChannel.type, "private", "opener-world #all starts born-hidden");

    const restore = await fetch(`${app.baseUrl}/api/channels/system/all/restore`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(restore.status, 200, "admin can make #all visible before team-growth unlock");

    // Repointed to the dedicated endpoint (task #67). This test is the one that
    // guards the unlock-instruction claim, which moved out of PATCH along with the
    // hide path -- had it stayed on PATCH it would have kept passing against a
    // route nothing uses while the claim silently went missing.
    const hide = await fetch(`${app.baseUrl}/api/channels/system/all/hide`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(hide.status, 200, "admin manual hide should succeed");

    const oaAgent = await createAgent(server.id, "manual-hidden-all-oa", { runtime: "codex" });
    await updateServerOnboardingAgent(server.id, oaAgent.id);
    await addMember(server.id, teammate.id);

    const fired = await triggerAllChannelUnlockOnboarding(app.io, app.app.get("agentOrchestrator"), server.id);
    assert.equal(fired, false, "manual hide must not be mistaken for born-hidden #all awaiting auto-unlock");

    const [allAfterUnlockAttempt] = await getDb()
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, allChannel.id));
    assert.equal(allAfterUnlockAttempt.type, "private", "manual hidden #all must stay hidden after onboarding unlock trigger");

    const hiddenList = await fetch(`${app.baseUrl}/api/channels`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(hiddenList.status, 200);
    const hiddenChannels = await hiddenList.json() as Array<{ id: string }>;
    assert.ok(!hiddenChannels.some((item) => item.id === allChannel.id), "manual hidden #all must stay out of channel lists");
  } finally {
    await app.close();
  }
});


// Provenance: task #94 (#proj-onboarding:55390032, 2026-07-08). The multi-human
// gap: unlock keyed off `agentList.length >= 2` never fired for a server that
// grew via humans (1 agent + N humans stayed hidden). The pinned rule is total
// members (humans + agents) >= 3, so a 2nd human is also a valid unlock trigger.
test("opener-world hidden #all auto-reveals when a 3rd member is a human", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: true });
  __setOnboardingServiceDepsForTests({ broadcastSystemMessage: async () => undefined as never });
  try {
    const owner = await seedUser("opener-human-unlock-owner@slock.test", "opener-human-unlock-owner");
    const server = await createServer("Opener Human Unlock", "opener-human-unlock-server", owner.id);
    const [allChannel] = await getDb()
      .select({ id: channels.id, type: channels.type })
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
    assert.ok(allChannel, "opener-world server should have an #all row");
    assert.equal(allChannel.type, "private", "opener-world #all is born hidden");

    const oaAgent = await createAgent(server.id, "opener-human-unlock-oa", { runtime: "codex" });
    await updateServerOnboardingAgent(server.id, oaAgent.id);
    const agentOrchestrator = app.app.get("agentOrchestrator");

    // Baseline: owner (1 human) + OA (1 agent) = 2 members → still hidden.
    const early = await triggerAllChannelUnlockOnboarding(app.io, agentOrchestrator, server.id);
    assert.equal(early, false, "solo owner + OA (2 members) must not unlock #all");
    const [stillHidden] = await getDb()
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, allChannel.id));
    assert.equal(stillHidden.type, "private", "#all stays hidden below 3 members");

    // A 2nd human joins → 3 members, no 2nd agent → must still unlock.
    const teammate = await seedUser("opener-human-unlock-teammate@slock.test", "opener-human-unlock-teammate");
    await addMember(server.id, teammate.id);
    const unlocked = await triggerAllChannelUnlockOnboarding(app.io, agentOrchestrator, server.id);
    assert.equal(unlocked, true, "a 2nd human (3rd member) must trigger the #all unlock");

    const [revealed] = await getDb()
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, allChannel.id));
    assert.equal(revealed.type, "channel", "human-triggered unlock must flip #all back to an enabled channel");
  } finally {
    __resetOnboardingServiceDepsForTests();
    await app.close();
  }
});


test("private channel creator can leave and then loses all visibility surfaces", async ({ app }) => {
  const owner = await seedUser("private-leave-owner@slock.test", "private-leave-owner");
  const invited = await seedUser("private-leave-invited@slock.test", "private-leave-invited");
  const outsider = await seedUser("private-leave-outsider@slock.test", "private-leave-outsider");
  const ownerAdded = await seedUser("private-leave-owner-added@slock.test", "private-leave-owner-added");
  const server = await createServer("Private Leave Server", "private-leave-server", owner.id);
  await addMember(server.id, invited.id);
  await addMember(server.id, outsider.id);
  await addMember(server.id, ownerAdded.id);

  const ownerToken = await tokenForHuman(owner.email);
  const invitedToken = await tokenForHuman(invited.email);
  const outsiderToken = await tokenForHuman(outsider.email);
  const marker = "private leave marker 20260504";

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({
      name: "creator-can-leave",
      visibility: "private",
      userIds: [invited.id],
    }),
  });
  assert.equal(createRes.status, 200);
  const privateChannel = await createRes.json() as { id: string; type: string };
  assert.equal(privateChannel.type, "private");

  const messageRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: privateChannel.id, content: marker }),
  });
  assert.equal(messageRes.status, 200);

  const ownerSearchBefore = await fetch(`${app.baseUrl}/api/messages/search?q=${encodeURIComponent(marker)}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerSearchBefore.status, 200);
  const ownerSearchBeforeBody = await ownerSearchBefore.json() as { results: Array<{ channelId: string }> };
  assert.ok(ownerSearchBeforeBody.results.some((result) => result.channelId === privateChannel.id));

  const leaveRes = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/leave`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(leaveRes.status, 200, "creator must be able to leave their private channel");

  const ownerList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerList.status, 200);
  const ownerListBody = await ownerList.json() as Array<{ id: string }>;
  assert.ok(!ownerListBody.some((channel) => channel.id === privateChannel.id), "left creator must not see the private channel in channel list");

  const ownerDetails = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerDetails.status, 404, "left creator must not be able to inspect private channel details");

  const ownerMembers = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/members`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerMembers.status, 404, "left creator must not be able to inspect private channel membership");

  const ownerAddWhileUnjoined = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/members`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ userId: ownerAdded.id }),
  });
  assert.equal(ownerAddWhileUnjoined.status, 200, "server owner may add another member without rejoining the private channel");

  const ownerArchive = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/archive`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerArchive.status, 404, "left creator must not be able to archive an invisible private channel");

  const ownerSearchAfter = await fetch(`${app.baseUrl}/api/messages/search?q=${encodeURIComponent(marker)}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerSearchAfter.status, 200);
  const ownerSearchAfterBody = await ownerSearchAfter.json() as { results: Array<{ channelId: string }> };
  assert.ok(!ownerSearchAfterBody.results.some((result) => result.channelId === privateChannel.id), "left creator must not see private channel messages in search");

  const ownerInbox = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerInbox.status, 200);
  const ownerInboxBody = await ownerInbox.json() as { items: Array<{ kind: string; channelId?: string | null; parentChannelId?: string | null }> };
  assert.ok(!ownerInboxBody.items.some((item) => item.channelId === privateChannel.id || item.parentChannelId === privateChannel.id), "left creator must not see private channel in Inbox");

  const invitedDetails = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    headers: headers(invitedToken, server.id),
  });
  assert.equal(invitedDetails.status, 200, "other invited members should retain access after creator leaves");

  const outsiderLeave = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/leave`, {
    method: "POST",
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(outsiderLeave.status, 404, "non-members must not be able to probe private channel existence through leave");
});


test("private channel soft-deletes when the last member leaves", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-empty-owner@slock.test", "private-empty-owner");
  const server = await createServer("Private Empty Server", "private-empty-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({
      name: "empty-after-leave",
      visibility: "private",
    }),
  });
  assert.equal(createRes.status, 200);
  const privateChannel = await createRes.json() as { id: string; type: string };
  assert.equal(privateChannel.type, "private");

  const leaveRes = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/leave`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(leaveRes.status, 200);

  const [deleted] = await db
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, privateChannel.id));
  assert.ok(deleted?.deletedAt, "empty private channel should be soft-deleted");

  const details = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(details.status, 404);
});


test("private channel remains active with an agent member and soft-deletes after the last agent leaves", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("private-agent-empty-owner@slock.test", "private-agent-empty-owner");
  const server = await createServer("Private Agent Empty Server", "private-agent-empty-server", owner.id);
  const agent = await createAgent(server.id, "private-agent-last-member", { runtime: "codex" });
  const privateChannel = await createChannel(server.id, "agent-only-after-human-leaves", undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  await addAgent(privateChannel.id, agent.id);

  await removeHuman(privateChannel.id, owner.id);

  const [stillActive] = await db
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, privateChannel.id));
  assert.equal(stillActive?.deletedAt, null, "agent membership should keep a private channel active");
  assert.equal(await canAgentAccessChannel(privateChannel.id, agent.id), true);

  await removeAgent(privateChannel.id, agent.id);

  const [deleted] = await db
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, privateChannel.id));
  assert.ok(deleted?.deletedAt, "private channel should soft-delete after the last agent leaves");
  assert.equal(await canAgentAccessChannel(privateChannel.id, agent.id), false);
});


test("a human member can add an agent with a persistent system message delivered to the agent", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("agent-add-notice-owner@slock.test", "agent-add-notice-owner");
  const actor = await seedUser("agent-add-notice-member@slock.test", "agent-add-notice-member");
  const server = await createServer("Agent Add Notice Server", "agent-add-notice-server", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: actor.id, role: "member" });
  const channel = await createChannel(server.id, "agent-add-notice");
  await addHuman(channel.id, actor.id);
  const agent = await createAgent(server.id, "agent-add-notice-bot", { runtime: "codex" });
  const actorToken = await tokenForHuman(actor.email);
  const deliveries: Array<{ agentId: string; message: { content: string; sender_type: string; seq?: number } }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (agentId: string, message: { content: string; sender_type: string; seq?: number }) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    deliveries.push({ agentId, message });
  };

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    method: "POST",
    headers: headers(actorToken, server.id),
    body: JSON.stringify({ agentId: agent.id }),
  });
  assert.equal(res.status, 200);

  const [systemMessage] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")))
    .orderBy(desc(messages.createdAt));
  assert.ok(systemMessage, "expected a persistent channel system message");
  assert.equal(systemMessage.content, "@agent-add-notice-bot was added to this channel.");
  assert.equal(systemMessage.senderId, "system");

  const delivery = deliveries.find((item) => item.agentId === agent.id);
  assert.ok(delivery, "added agent should receive the channel system message");
  assert.equal(delivery.message.sender_type, "system");
  assert.equal(delivery.message.content, "@agent-add-notice-bot was added to this channel.");
  assert.ok(delivery.message.seq, "delivery should carry the persisted message seq");
});


test("a human member can add a channel member with one persistent idempotent system message", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("human-add-notice-owner@slock.test", "human-add-notice-owner");
  const actor = await seedUser("human-add-notice-actor@slock.test", "human-add-notice-actor");
  const member = await seedUser("human-add-notice-member@slock.test", "human-add-notice-member");
  const server = await createServer("Human Add Notice Server", "human-add-notice-server", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: actor.id, role: "member" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, "human-add-notice");
  await addHuman(channel.id, actor.id);
  const actorToken = await tokenForHuman(actor.email);

  const addMember = () => fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    method: "POST",
    headers: headers(actorToken, server.id),
    body: JSON.stringify({ userId: member.id }),
  });

  const first = await addMember();
  assert.equal(first.status, 200);

  const systemMessagesAfterFirstAdd = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")))
    .orderBy(desc(messages.createdAt));
  assert.equal(systemMessagesAfterFirstAdd.length, 1, "a new human membership should create one system message");
  assert.equal(systemMessagesAfterFirstAdd[0]?.content, "@human-add-notice-member was added to this channel.");
  assert.equal(systemMessagesAfterFirstAdd[0]?.senderId, "system");

  const facts = await db
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, systemMessagesAfterFirstAdd[0]!.id));
  const actorFact = facts.find((fact) => fact.receiverType === "user" && fact.receiverId === actor.id);
  const memberFact = facts.find((fact) => fact.receiverType === "user" && fact.receiverId === member.id);
  assert.equal(actorFact?.unreadEligible, false, "the acting human member's own membership notice should be born-read");
  assert.equal(memberFact?.unreadEligible, true, "the added human should receive the membership notice unread");

  const retry = await addMember();
  assert.equal(retry.status, 200);
  const systemMessagesAfterRetry = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")));
  assert.equal(systemMessagesAfterRetry.length, 1, "an idempotent retry must not duplicate the membership notice");
});


test("adding a human rolls membership back when notice persistence fails so retry repairs the operation", async ({ app }) => {

  try {
    const db = getDb();
    const owner = await seedUser("human-add-repair-owner@slock.test", "human-add-repair-owner");
    const member = await seedUser("human-add-repair-member@slock.test", "human-add-repair-member");
    const server = await createServer("Human Add Repair Server", "human-add-repair-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const channel = await createChannel(server.id, "human-add-repair");
    await addHuman(channel.id, owner.id);
    const ownerToken = await tokenForHuman(owner.email);
    const addMemberRequest = () => fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ userId: member.id }),
    });

    let failNextMessage = true;
    __setMessageServiceDepsForTests({
      createMessage: async (...args) => {
        if (failNextMessage) {
          failNextMessage = false;
          throw new Error("injected membership notice persistence failure");
        }
        return createMessage(...args);
      },
      recordInboxNotificationFacts,
    });
    try {
      const first = await addMemberRequest();
      assert.equal(first.status, 500);
      assert.equal(
        await isChannelHuman(channel.id, member.id),
        false,
        "notice failure must roll membership back instead of stranding an already-member retry",
      );
      assert.equal(
        (await db.select().from(messages).where(and(
          eq(messages.channelId, channel.id),
          eq(messages.messageType, "system"),
        ))).length,
        0,
      );

      const retry = await addMemberRequest();
      assert.equal(retry.status, 200);
      assert.equal(await isChannelHuman(channel.id, member.id), true);
      const repairedMessages = await db.select().from(messages).where(and(
        eq(messages.channelId, channel.id),
        eq(messages.messageType, "system"),
      ));
      assert.equal(repairedMessages.length, 1, "retry must persist exactly one repaired membership notice");
      assert.equal(repairedMessages[0]?.content, "@human-add-repair-member was added to this channel.");

      const replay = await addMemberRequest();
      assert.equal(replay.status, 200);
      assert.equal(
        (await db.select({ id: messages.id }).from(messages).where(and(
          eq(messages.channelId, channel.id),
          eq(messages.messageType, "system"),
        ))).length,
        1,
        "a successful repair replay must stay idempotent",
      );
    } finally {
      __resetMessageServiceDepsForTests();
    }
  } finally {
    __resetMessageServiceDepsForTests();
    await app.close();
  }
});


test("removing an agent from a channel delivers the persistent system message before removing membership", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("agent-remove-notice-owner@slock.test", "agent-remove-notice-owner");
  const server = await createServer("Agent Remove Notice Server", "agent-remove-notice-server", owner.id);
  const channel = await createChannel(server.id, "agent-remove-notice");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, "agent-remove-notice-bot", { runtime: "codex" });
  await addAgent(channel.id, agent.id);
  const ownerToken = await tokenForHuman(owner.email);
  const deliveries: Array<{
    agentId: string;
    message: { content: string; sender_type: string; seq?: number };
    memberAtDelivery: boolean;
  }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (agentId: string, message: { content: string; sender_type: string; seq?: number }) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    const [membershipAtDelivery] = await db
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, agentId)));
    deliveries.push({
      agentId,
      message,
      memberAtDelivery: Boolean(membershipAtDelivery),
    });
  };

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/agent/${agent.id}`, {
    method: "DELETE",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 200);

  const [systemMessage] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")))
    .orderBy(desc(messages.createdAt));
  assert.ok(systemMessage, "expected a persistent channel system message");
  assert.equal(systemMessage.content, "@agent-remove-notice-bot was removed from this channel.");
  assert.equal(systemMessage.senderId, "system");

  const delivery = deliveries.find((item) => item.agentId === agent.id);
  assert.ok(delivery, "removed agent should receive the channel system message");
  assert.equal(delivery.message.sender_type, "system");
  assert.equal(delivery.message.content, "@agent-remove-notice-bot was removed from this channel.");
  assert.ok(delivery.message.seq, "delivery should carry the persisted message seq");
  assert.equal(delivery.memberAtDelivery, true, "removal notice should be delivered before membership is removed");
  const [membership] = await db
    .select()
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channel.id), eq(channelAgents.agentId, agent.id)));
  assert.equal(membership, undefined, "agent membership row should be removed");
});


test("attempting to remove an agent from #all writes no membership system message and delivers no agent notice", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("all-remove-notice-owner@slock.test", "all-remove-notice-owner");
  const server = await createServer("All Remove Notice Server", "all-remove-notice-server", owner.id);
  const [allChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "createServer should create #all");
  const agent = await createAgent(server.id, "all-remove-notice-bot", { runtime: "codex" });
  await addAgent(allChannel.id, agent.id);
  const ownerToken = await tokenForHuman(owner.email);
  const deliveries: Array<{ agentId: string; message: { content: string } }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (agentId: string, message: { content: string }) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message) => {
    deliveries.push({ agentId, message });
  };

  const res = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members/agent/${agent.id}`, {
    method: "DELETE",
    headers: headers(ownerToken, server.id),
  });
  assert.equal(res.status, 403);

  const systemMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, allChannel.id), eq(messages.messageType, "system")));
  assert.equal(systemMessages.length, 0, "failed #all removal must not write a persistent system message");
  assert.equal(deliveries.length, 0, "failed #all removal must not deliver an agent notice");
  const [membership] = await db
    .select()
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, allChannel.id), eq(channelAgents.agentId, agent.id)));
  assert.equal(membership, undefined, "virtual #all should not persist agent membership rows");
});


test("self join/leave broadcasts channel:members-updated so other clients refresh joined state", async ({ app }) => {
  const db = getDb();
  const [owner, member] = await db.insert(users).values([
    {
      email: "channel-join-owner@slock.test",
      name: "channel-join-owner",
      displayName: "Channel Join Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    },
    {
      email: "channel-join-member@slock.test",
      name: "channel-join-member",
      displayName: "Channel Join Member",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    },
  ]).returning();
  const server = await createServer("Channel Join Socket", "channel-join-socket", owner.id);
  await addMember(server.id, member.id, "member");
  const channel = await createChannel(server.id, "join-live-channel");
  await addHuman(channel.id, owner.id);

  const events = installFakeIo(app.app);

  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: member.email, password: "password123" }),
  });
  assert.equal(login.status, 200);
  const { accessToken } = await login.json() as { accessToken: string };

  const join = await fetch(`${app.baseUrl}/api/channels/${channel.id}/join`, {
    method: "POST",
    headers: headers(accessToken, server.id),
  });
  assert.equal(join.status, 200);

  assert.equal(events.length, 1);
  assert.equal(events[0].room, `server:${server.id}`);
  assert.equal(events[0].event, "channel:members-updated");
  assert.deepEqual(events[0].payload, { channelId: channel.id });

  events.length = 0;
  const leave = await fetch(`${app.baseUrl}/api/channels/${channel.id}/leave`, {
    method: "POST",
    headers: headers(accessToken, server.id),
  });
  assert.equal(leave.status, 200);

  assert.equal(events.length, 1);
  assert.equal(events[0].room, `server:${server.id}`);
  assert.equal(events[0].event, "channel:members-updated");
  assert.deepEqual(events[0].payload, { channelId: channel.id });
});


test("GET /channels/:id/members hides only #all human membership from ordinary members when configured", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("hide-channel-members-owner@slock.test", "hide-channel-members-owner");
  const member = await seedUser("hide-channel-members-member@slock.test", "hide-channel-members-member");
  const other = await seedUser("hide-channel-members-other@slock.test", "hide-channel-members-other");
  const server = await createServer("Hide Channel Members Server", "hide-channel-members-server", owner.id);
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, "hide-channel-members");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  await addHuman(channel.id, other.id);
  const agent = await createAgent(server.id, "hide-channel-members-agent", { runtime: "codex" });
  await addAgent(channel.id, agent.id);
  const [allChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "expected #all channel");
  await addHuman(allChannel.id, member.id);
  await addHuman(allChannel.id, other.id);

  const memberToken = await tokenForHuman(member.email);
  const memberRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    headers: headers(memberToken, server.id),
  });
  assert.equal(memberRes.status, 200);
  const memberBody = await memberRes.json() as { agents: Array<{ id: string }>; humans: Array<{ id: string }> };
  assert.deepEqual(memberBody.humans.map((human) => human.id).sort(), [owner.id, member.id, other.id].sort(), "ordinary channel member lists should remain visible");
  assert.ok(memberBody.agents.some((candidate) => candidate.id === agent.id), "human-directory setting must not hide agents");

  const allMemberRes = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, {
    headers: headers(memberToken, server.id),
  });
  assert.equal(allMemberRes.status, 200);
  const allMemberBody = await allMemberRes.json() as { humans: Array<{ id: string }> };
  assert.deepEqual(allMemberBody.humans.map((human) => human.id), [member.id], "#all must not remain a human directory for ordinary members");

  const dm = await findOrCreateUserDM(server.id, member.id, other.id);
  assert.ok(dm, "DM creation should succeed for two server members");
  const dmRes = await fetch(`${app.baseUrl}/api/channels/${dm.id}/members`, {
    headers: headers(memberToken, server.id),
  });
  assert.equal(dmRes.status, 200);
  const dmBody = await dmRes.json() as { humans: Array<{ id: string }> };
  assert.deepEqual(dmBody.humans.map((human) => human.id).sort(), [member.id, other.id].sort(), "DM member context should remain visible to participants");

  const ownerToken = await tokenForHuman(owner.email);
  const ownerRes = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(ownerRes.status, 200);
  const ownerBody = await ownerRes.json() as { humans: Array<{ id: string }> };
  assert.deepEqual(ownerBody.humans.map((human) => human.id).sort(), [owner.id, member.id, other.id].sort());

  const allOwnerRes = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, {
    headers: headers(ownerToken, server.id),
  });
  assert.equal(allOwnerRes.status, 200);
  const allOwnerBody = await allOwnerRes.json() as { humans: Array<{ id: string }> };
  assert.deepEqual(allOwnerBody.humans.map((human) => human.id).sort(), [owner.id, member.id, other.id].sort());
});


test("GET /channels/:id/members shows community admins in #all when human directory is hidden", async ({ app }) => {
  const db = getDb();

  for (const slug of ["community", "community-cn"] as const) {
    const owner = await seedUser(`hidden-${slug}-owner@slock.test`, `hidden-${slug}-owner`);
    const admin = await seedUser(`hidden-${slug}-admin@slock.test`, `hidden-${slug}-admin`);
    const member = await seedUser(`hidden-${slug}-member@slock.test`, `hidden-${slug}-member`);
    const other = await seedUser(`hidden-${slug}-other@slock.test`, `hidden-${slug}-other`);
    const server = await createServer(`Hidden ${slug}`, slug, owner.id);
    await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: admin.id, role: "admin" },
      { serverId: server.id, userId: member.id, role: "member" },
      { serverId: server.id, userId: other.id, role: "member" },
    ]);
    const [allChannel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
    assert.ok(allChannel, `expected #all channel for /${slug}`);
    await addHuman(allChannel.id, admin.id);
    await addHuman(allChannel.id, member.id);
    await addHuman(allChannel.id, other.id);

    const memberToken = await tokenForHuman(member.email);
    const res = await fetch(`${app.baseUrl}/api/channels/${allChannel.id}/members`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { humans: Array<{ id: string; role: string; serverSlug: string }> };
    assert.deepEqual(
      body.humans.map((human) => human.id).sort(),
      [owner.id, admin.id, member.id].sort(),
      `/${slug} #all should show admins plus the requester, but not ordinary members`,
    );
    assert.ok(body.humans.some((human) => human.id === owner.id && human.role === "owner" && human.serverSlug === slug));
    assert.ok(body.humans.some((human) => human.id === admin.id && human.role === "admin" && human.serverSlug === slug));
    assert.ok(!body.humans.some((human) => human.id === other.id), `/${slug} #all must not become a full human directory`);
  }
});


test("legacy agent channel-members and server info respect hidden human directory", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("legacy-agent-hidden-owner@slock.test", "legacy-agent-hidden-owner");
  const member = await seedUser("legacy-agent-hidden-member@slock.test", "legacy-agent-hidden-member");
  const other = await seedUser("legacy-agent-hidden-other@slock.test", "legacy-agent-hidden-other");
  const server = await createServer("Legacy Agent Hidden Directory", "legacy-agent-hidden-directory", owner.id);
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]);
  const [allChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "expected #all channel");

  const agent = await createAgent(server.id, "legacy-hidden-agent", { runtime: "codex" });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "legacy-hidden-directory-machine");
  await assignMachine(agent.id, machine.id);

  const memberList = await fetch(
    `${app.baseUrl}/internal/agent/${agent.id}/channel-members?channel=${encodeURIComponent("#all")}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(memberList.status, 200);
  const memberListBody = await memberList.json() as { humans: Array<{ name: string }>; agents: Array<{ name: string }> };
  assert.deepEqual(memberListBody.humans, [], "member-role agents must not enumerate #all humans when the human directory is hidden");
  assert.ok(memberListBody.agents.some((candidate) => candidate.name === agent.name), "human-directory setting must not hide agents");

  const serverInfo = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/server`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(serverInfo.status, 200);
  const serverInfoBody = await serverInfo.json() as { humans: Array<{ name: string }> };
  assert.deepEqual(serverInfoBody.humans, [], "legacy agent server info must not enumerate humans when the human directory is hidden");
});
