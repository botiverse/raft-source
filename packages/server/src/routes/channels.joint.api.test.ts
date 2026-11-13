import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { tokenForHuman } from "../test/integration/credentials";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  BasicTracer,
  JOINT_INVITES_CHANGED_EVENT,
  MemoryTraceSink
} from "@botiverse/raft-shared";
import { setListChangedRealtimeIO } from "../services/listChangedRealtime";
import { openTestApp } from "../test/integration/app";
import { admitJointInvite, JOINT_INVITE_RATE_LIMIT_MAX_PEOPLE } from "../services/jointInviteRateLimit";
import { getDb } from "../db/index";
import {
  servers as serversTable,
  serverMembers,
  channels,
  channelHumans, messages,
  messageReactions,
  messageMentions,
  attachments,
  threadFollows, userChannelReadCursors, inboxNotificationFacts,
  inboxSuppressionStates, integrationAuditEvents, jointChannels,
  jointChannelServers,
  jointChannelInvites,
  users as usersTable
} from "../db/schema";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET, disconnectJointChannel, resendPendingJointChannelInvites, createChannel, getOrCreateThread, addHuman, addAgent, removeHuman, isChannelHuman, resolveChannelAccess, getChannel, markRead, listJointActivityProjectionChannelIdsForAgent, recordThreadFollow } from "../services/channelService";
import {
  createMessage
} from "../services/messageService";
import {
} from "../services/inboxNotificationService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createServer, installFakeIo, recordTestInboxFact, seedThreadFixture, headers, seedUser, fetchInboxAll } from "./channels.api.fixtures";
import { emitJointLimitStateChange } from "./channels";
import { onJointLimitStateChanged, reconcileJointsForServer } from "../services/jointChannelLimitService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });


test("GET /api/channels/:id/threads scopes joint summaries before local projection", async ({ app }) => {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "7".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  app.app.set("serverTracer", tracer);

  const hostOwner = await seedUser("joint-summary-scope-host@slock.test", "joint-summary-scope-host");
  const targetOwner = await seedUser("joint-summary-scope-target@slock.test", "joint-summary-scope-target");
  const hostServer = await createServer("Joint Summary Scope Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Summary Scope Target", "joint-summary-scope-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "joint-summary-scope-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  const parentOneRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "joint scoped parent one" }),
  });
  assert.equal(parentOneRes.status, 200);
  const parentOne = await parentOneRes.json() as { id: string };
  const threadOneRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ parentMessageId: parentOne.id, content: "joint scoped reply one" }),
    // Executor drift used to deadlock PGlite's single connection until
    // Undici's five-minute headers timeout. Keep this regression fail-fast.
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(threadOneRes.status, 200);
  const threadOne = await threadOneRes.json() as { threadChannelId: string };

  const parentTwoRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "joint scoped parent two" }),
  });
  assert.equal(parentTwoRes.status, 200);
  const parentTwo = await parentTwoRes.json() as { id: string };
  const threadTwoRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ parentMessageId: parentTwo.id, content: "joint scoped reply two" }),
  });
  assert.equal(threadTwoRes.status, 200);

  sink.clear();
  const scopedRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads?parentMessageIds=${parentOne.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(scopedRes.status, 200);
  const scopedBody = await scopedRes.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  assert.deepEqual(Object.keys(scopedBody), [parentOne.id]);
  assert.equal(scopedBody[parentOne.id]?.replyCount, 1);
  assert.notEqual(
    scopedBody[parentOne.id]?.threadChannelId,
    threadOne.threadChannelId,
    "peer summaries should still expose the peer local thread projection id",
  );
  assert.equal(scopedBody[parentTwo.id], undefined);

  const span = sink.getAllSpans().find((candidate) =>
    candidate.name === "server.http.request"
    && candidate.attrs?.route_pattern === "/api/channels/:id/threads",
  );
  assert.ok(span, "expected GET /api/channels/:id/threads root span");
  const dbEvents = span.events.filter((event) => event.name === "db.query.finished");
  const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.row_count, 1);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_count, 1);
  assert.equal(dbEventByQuery.get("channel_threads.list_by_channel")?.attrs?.parent_message_scope_source, "client");
  assert.equal(dbEventByQuery.get("channel_threads.participants_by_threads")?.attrs?.input_count, 1);
  assert.equal(dbEventByQuery.get("channel_threads.unread_by_threads")?.attrs?.input_count, 1);
});


test("ordinary add-member API lands a joint add on the addressed projection with one canonical notice", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("joint-human-add-owner@slock.test", "joint-human-add-owner");
  const member = await seedUser("joint-human-add-member@slock.test", "joint-human-add-member");
  const peerOwner = await seedUser("joint-human-add-peer@slock.test", "joint-human-add-peer");
  const server = await createServer("Joint Human Add Host", "joint-human-add-host", owner.id);
  const peerServer = await createServer("Joint Human Add Peer", "joint-human-add-peer", peerOwner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const canonical = await createChannel(server.id, "joint-human-add-storage");
  const hostProjection = await createChannel(server.id, "joint-human-add-host", undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, "joint-human-add-peer", undefined, "joint");
  await addHuman(hostProjection.id, owner.id);
  await addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint!.id,
      serverId: server.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: owner.id,
    },
    {
      jointChannelId: joint!.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: peerOwner.id,
    },
  ]);
  await fillJointMembersFromChannelHumans();
  const ownerToken = await tokenForHuman(owner.email);

  const response = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/members`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ userId: member.id }),
  });
  // task #1150: joint channels are addable again. Membership is local to the
  // addressed projection while the notice is stored canonically, so both
  // servers read the same event exactly once.
  assert.equal(response.status, 200, await response.text());
  assert.equal(await isChannelHuman(hostProjection.id, member.id), true);
  assert.equal(
    await isChannelHuman(peerProjection.id, member.id),
    false,
    "membership stays on the projection that was addressed",
  );

  const peerToken = await tokenForHuman(peerOwner.email);
  const peerRoster = await fetch(`${app.baseUrl}/api/channels/${peerProjection.id}/members`, {
    headers: headers(peerToken, peerServer.id),
  });
  assert.equal(peerRoster.status, 200);
  const peerRosterBody = await peerRoster.json() as { humans?: Array<{ id: string }> };
  assert.equal(
    (peerRosterBody.humans ?? []).some((human) => human.id === member.id),
    true,
    "the peer server must still see the person: rosters read the joint union",
  );

  const noticeContent = "@joint-human-add-member was added to this channel.";
  const canonicalSystemMessages = await db.select().from(messages).where(and(
    eq(messages.channelId, canonical.id),
    eq(messages.messageType, "system"),
    eq(messages.content, noticeContent),
  ));
  assert.equal(canonicalSystemMessages.length, 1, "the notice is stored once, canonically");
  for (const projectionId of [hostProjection.id, peerProjection.id]) {
    assert.equal(
      (await db.select({ id: messages.id }).from(messages).where(and(
        eq(messages.channelId, projectionId),
        eq(messages.messageType, "system"),
        eq(messages.content, noticeContent),
      ))).length,
      0,
      `the notice lives in canonical storage, not on projection ${projectionId}`,
    );
  }
});


test("POST /channels/inbox/done requires storage identity and fixes the incident-shaped joint split", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  const [canonical, local] = await db.insert(channels).values([
    { serverId: f.serverId, name: "api-done-space-canonical", type: "joint" },
    { serverId: f.serverId, name: "api-done-space-local", type: "joint" },
  ]).returning();
  await db.insert(channelHumans).values({ channelId: local.id, userId: f.ownerId });
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: f.serverId,
    localChannelId: local.id,
    role: "host",
    status: "active",
  });
  await fillJointMembersFromChannelHumans();
  await db.insert(messages).values({
    channelId: canonical.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API canonical Done frontier",
    seq: 11_426_997,
  });
  const [localMessage] = await db.insert(messages).values({
    channelId: local.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API legacy display frontier",
    seq: 11_429_659,
  }).returning();
  await db.insert(inboxNotificationFacts).values({
    receiverType: "user",
    receiverId: f.ownerId,
    serverId: f.serverId,
    kind: "channel",
    sourceChannelId: local.id,
    messageId: localMessage.id,
    messageSeq: localMessage.seq,
    activityAt: localMessage.createdAt,
  });

  const activeItem = (await fetchInboxAll(app.baseUrl, f.ownerToken, f.serverId))
    .find((item) => item.kind === "channel" && item.channelId === local.id) as
    | { latestActivitySeq?: string; doneFrontierSeq?: string }
    | undefined;
  // 2026-09-21 teardown: both surviving read surfaces (the RW derivation
  // chain and the canonical inline SQL) see joint activity exclusively
  // through canonical storage. The stray local-projection message this
  // fixture plants (the facts-era incident accommodation that used to
  // surface as the display frontier) is invisible by design now — display
  // and guard frontiers coincide in the storage space.
  assert.equal(activeItem?.latestActivitySeq, "11426997");
  assert.equal(
    activeItem?.doneFrontierSeq,
    "11426997",
    "the active API carries the storage-space frontier",
  );

  const requestHeaders = headers(f.ownerToken, f.serverId);
  let response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    // A pre-upgrade tab has no space identity. It must refresh rather than
    // send its display value through the storage guard.
    body: JSON.stringify({ channelId: local.id, throughActivitySeq: "11429659" }),
  });
  assert.equal(response.status, 412);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_SPACE_REQUIRED",
  );

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: local.id,
      throughActivitySeq: "11426997",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const [suppression] = await db.select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.ownerId),
    eq(inboxSuppressionStates.targetChannelId, local.id),
  ));
  assert.equal(String(suppression?.doneThroughSeq), "11426997");
  assert.equal(suppression?.sourceChannelId, canonical.id);

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: local.id,
      throughActivitySeq: "11426998",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code?: string }).code, "DONE_FRONTIER_BEYOND_LATEST");

  response = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      channelId: local.id,
      throughActivitySeq: "11426997",
      frontierSpace: "display",
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code?: string }).code, "DONE_FRONTIER_UNMAPPABLE");
});


test("POST /channels/threads/done requires storage identity before the strict joint guard", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();
  const [canonicalParent, localParent] = await db.insert(channels).values([
    { serverId: f.serverId, name: "api-thread-space-parent-canonical", type: "joint" },
    { serverId: f.serverId, name: "api-thread-space-parent-local", type: "joint" },
  ]).returning();
  await db.insert(channelHumans).values({ channelId: localParent.id, userId: f.ownerId });
  const [parentJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalParent.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: parentJoint.id,
    serverId: f.serverId,
    localChannelId: localParent.id,
    role: "host",
    status: "active",
  });
  await fillJointMembersFromChannelHumans();
  const [parentMessage] = await db.insert(messages).values({
    channelId: canonicalParent.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API joint-thread parent",
    seq: 11_426_000,
  }).returning();
  const [canonicalThread, localThread] = await db.insert(channels).values([
    {
      serverId: f.serverId,
      name: "api-thread-space-canonical",
      type: "thread",
      parentMessageId: parentMessage.id,
    },
    { serverId: f.serverId, name: "api-thread-space-local", type: "thread" },
  ]).returning();
  await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, parentMessage.id));
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: threadJoint.id,
    serverId: f.serverId,
    localChannelId: localThread.id,
    role: "host",
    status: "active",
  });
  await fillJointMembersFromChannelHumans();
  await db.insert(threadFollows).values({
    threadChannelId: localThread.id,
    followerType: "user",
    followerId: f.ownerId,
    parentMessageId: parentMessage.id,
    reason: "authored",
  });
  await db.insert(messages).values({
    channelId: canonicalThread.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API canonical joint-thread frontier",
    seq: 11_426_997,
  });
  const [localReply] = await db.insert(messages).values({
    channelId: localThread.id,
    senderType: "user",
    senderId: f.memberBId,
    content: "API legacy joint-thread display frontier",
    seq: 11_429_659,
  }).returning();
  await db.insert(inboxNotificationFacts).values({
    receiverType: "user",
    receiverId: f.ownerId,
    serverId: f.serverId,
    kind: "thread",
    sourceChannelId: localThread.id,
    messageId: localReply.id,
    messageSeq: localReply.seq,
    activityAt: localReply.createdAt,
  });

  const requestHeaders = headers(f.ownerToken, f.serverId);
  let response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    // A pre-upgrade tab must refresh; the server does not guess whether this
    // local fact or a storage reply supplied the value.
    body: JSON.stringify({
      threadChannelId: localThread.id,
      throughActivitySeq: "11429659",
    }),
  });
  assert.equal(response.status, 412);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_SPACE_REQUIRED",
  );

  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: localThread.id,
      throughActivitySeq: "11426997",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const [suppression] = await db.select().from(inboxSuppressionStates).where(and(
    eq(inboxSuppressionStates.receiverId, f.ownerId),
    eq(inboxSuppressionStates.targetChannelId, localThread.id),
  ));
  assert.equal(String(suppression?.doneThroughSeq), "11426997");
  assert.equal(suppression?.sourceChannelId, canonicalThread.id);

  response = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      threadChannelId: localThread.id,
      throughActivitySeq: "11426998",
      frontierSpace: "storage",
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code?: string }).code,
    "DONE_FRONTIER_BEYOND_LATEST",
    "a value above canonical storage must not weaken the strict guard",
  );
});


test("GET /channels/inbox includes top-level joint channel activity through local projection", async ({ app }) => {
  const f = await seedThreadFixture(app.baseUrl);
  const db = getDb();

  const [storageNamespace] = await db.insert(serversTable).values({
    name: "Joint Storage Namespace",
    slug: "__joint_storage__",
    kind: "joint_storage",
    ownerId: f.ownerId,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const canonical = await createChannel(storageNamespace.id, "joint-storage-inbox-activity");
  const projection = await createChannel(f.serverId, "joint-inbox-activity", undefined, "joint");
  await addHuman(projection.id, f.ownerId);
  await addHuman(projection.id, f.memberBId);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: f.serverId,
    createdByUserId: f.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: f.serverId,
    localChannelId: projection.id,
    role: "host",
    joinedByUserId: f.ownerId,
  });
  await fillJointMembersFromChannelHumans();
  const sendRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.memberBToken, f.serverId),
    body: JSON.stringify({
      channelId: projection.id,
      content: "joint inbox mention @owner",
      mentions: [{ type: "user", id: f.ownerId, name: "owner" }],
    }),
  });
  assert.equal(sendRes.status, 200);
  const latest = await sendRes.json() as { id: string; seq: number; channelId: string };
  assert.equal(latest.channelId, projection.id, "message response should expose the local joint projection id");

  // A joint channel's sender from another server is in neither of this
  // server's rosters, so the row carries the sender's face itself.
  // A person's avatar counts only when Raft stores it, as on a chat message.
  await db.update(usersTable).set({ avatarUrl: "https://provider.example.test/member-b.png" }).where(eq(usersTable.id, f.memberBId));
  const providerInbox = await fetch(`${app.baseUrl}/api/channels/inbox`, { headers: headers(f.ownerToken, f.serverId) });
  const providerRow = (await providerInbox.json() as { items: Array<{ channelId?: string; senderAvatarUrl?: string | null }> }).items
    .find((item) => item.channelId === projection.id);
  assert.equal(providerRow?.senderAvatarUrl, null);
  const senderAvatarUrl = "https://cdn.example.test/avatars/users/0123456789abcdef0123456789abcdef.webp";
  await db.update(usersTable).set({ avatarUrl: senderAvatarUrl }).where(eq(usersTable.id, f.memberBId));

  const inboxRes = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(inboxRes.status, 200);
  const inboxBody = await inboxRes.json() as {
    items: Array<{ kind: string; channelId?: string; channelType?: string; lastMessageId?: string; firstUnreadMessageId?: string | null; unreadCount?: number; senderAvatarUrl?: string | null }>;
  };
  const jointItem = inboxBody.items.find((item) => item.kind === "channel" && item.channelId === projection.id);
  assert.ok(jointItem, "top-level joint channel messages should appear in Activity through the local projection");
  assert.equal(jointItem.channelType, "joint");
  assert.equal(jointItem.lastMessageId, latest.id);
  assert.equal(jointItem.firstUnreadMessageId, latest.id);
  assert.equal(jointItem.unreadCount, 1);
  assert.equal(jointItem.senderAvatarUrl, senderAvatarUrl);
  assert.equal("senderGravatarHash" in jointItem, false, "no email-derived hash for another organization's people");

  const unreadUrl = new URL(`${app.baseUrl}/api/channels/inbox`);
  unreadUrl.searchParams.set("filter", "unread");
  const unreadRes = await fetch(unreadUrl, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(unreadRes.status, 200);
  const unreadBody = await unreadRes.json() as {
    items: Array<{ kind: string; channelId?: string; unreadCount?: number }>;
  };
  assert.ok(
    unreadBody.items.some((item) => item.kind === "channel" && item.channelId === projection.id && item.unreadCount === 1),
    "unread Activity filter should include top-level joint channel messages",
  );

  const mentionsUrl = new URL(`${app.baseUrl}/api/channels/inbox`);
  mentionsUrl.searchParams.set("filter", "mentions");
  const mentionsRes = await fetch(mentionsUrl, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(mentionsRes.status, 200);
  const mentionsBody = await mentionsRes.json() as {
    items: Array<{ kind: string; channelId?: string; hasMention?: boolean }>;
  };
  assert.ok(
    mentionsBody.items.some((item) => item.kind === "channel" && item.channelId === projection.id && item.hasMention),
    "mention Activity filter should include top-level joint channel mentions",
  );

  const readRes = await fetch(`${app.baseUrl}/api/channels/${projection.id}/read-all`, {
    method: "POST",
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(readRes.status, 200);
  const readBody = await readRes.json() as { seq: number };
  assert.equal(readBody.seq, latest.seq, "mark-read for a joint projection should advance to canonical storage seq");

  const unreadSummaryAfterReadRes = await fetch(`${app.baseUrl}/api/channels/unread?summary=1`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(unreadSummaryAfterReadRes.status, 200);
  const unreadSummaryAfterRead = await unreadSummaryAfterReadRes.json() as {
    channels: Record<string, { unreadCount: number; hasMention: boolean; hasAnyMention: boolean }>;
  };
  // A fully read conversation with no mention row may be absent from the summary.
  assert.equal(
    unreadSummaryAfterRead.channels[projection.id]?.unreadCount ?? 0,
    0,
    "sidebar unread summary must compare participant joint reads in the canonical seq domain",
  );
  assert.equal(
    unreadSummaryAfterRead.channels[projection.id]?.hasMention ?? false,
    false,
    "sidebar @mention summary must not re-light a read joint local projection",
  );

  const afterReadRes = await fetch(`${app.baseUrl}/api/channels/inbox`, {
    headers: headers(f.ownerToken, f.serverId),
  });
  assert.equal(afterReadRes.status, 200);
  const afterReadBody = await afterReadRes.json() as {
    items: Array<{ kind: string; channelId?: string; firstUnreadMessageId?: string | null; unreadCount?: number }>;
  };
  const afterReadJointItem = afterReadBody.items.find((item) => item.kind === "channel" && item.channelId === projection.id);
  assert.ok(afterReadJointItem, "read top-level joint projection should stay visible in Activity");
  assert.equal(afterReadJointItem.firstUnreadMessageId, null);
  assert.equal(afterReadJointItem.unreadCount, 0);
});


test("joint channel resolver requires an active local projection in the caller server", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-host-owner@slock.test", "joint-host-owner");
  const guestOwner = await seedUser("joint-guest-owner@slock.test", "joint-guest-owner");
  const hostServer = await createServer("Joint Host", "joint-host", hostOwner.id);
  const guestServer = await createServer("Joint Guest", "joint-guest", guestOwner.id);

  const hostProjection = await createChannel(hostServer.id, "partner-room", undefined, "joint");
  const guestProjection = await createChannel(guestServer.id, "partner-room", undefined, "joint");
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(guestProjection.id, guestOwner.id);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: hostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: guestServer.id,
      localChannelId: guestProjection.id,
      role: "participant",
      joinedByUserId: guestOwner.id,
    },
  ]);
  await fillJointMembersFromChannelHumans();

  const hostResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: hostProjection.id });
  assert.equal(hostResolved?.kind, "joint");
  assert.equal(hostResolved?.canonicalChannelId, hostProjection.id);
  assert.equal(hostResolved?.role, "host");

  const guestResolved = await resolveChannelAccess({ serverId: guestServer.id, channelId: guestProjection.id });
  assert.equal(guestResolved?.kind, "joint");
  assert.equal(guestResolved?.canonicalChannelId, hostProjection.id);
  assert.equal(guestResolved?.role, "participant");

  assert.equal(
    await resolveChannelAccess({ serverId: hostServer.id, channelId: guestProjection.id }),
    null,
    "a projection id from another server must not grant access",
  );

  await db.update(jointChannelServers)
    .set({ status: "disconnected" })
    .where(and(eq(jointChannelServers.jointChannelId, joint.id), eq(jointChannelServers.serverId, guestServer.id)));
  assert.equal(
    await resolveChannelAccess({ serverId: guestServer.id, channelId: guestProjection.id }),
    null,
    "a disconnected projection must not resolve",
  );
});


test("joint channels are listed and fetched only for explicit members", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("joint-list-owner@slock.test", "joint-list-owner");
  const joined = await seedUser("joint-list-joined@slock.test", "joint-list-joined");
  const nonMember = await seedUser("joint-list-nonmember@slock.test", "joint-list-nonmember");
  const server = await createServer("Joint List", "joint-list", owner.id);
  await addMember(server.id, joined.id);
  await addMember(server.id, nonMember.id);
  const jointProjection = await createChannel(server.id, "shared-room", undefined, "joint");
  await addHuman(jointProjection.id, owner.id);
  await addHuman(jointProjection.id, joined.id);
  await createMessage(jointProjection.id, "user", owner.id, "joint secret");
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: jointProjection.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: server.id,
    localChannelId: jointProjection.id,
    role: "host",
    joinedByUserId: owner.id,
  });
  await fillJointMembersFromChannelHumans();

  const joinedToken = await tokenForHuman(joined.email);
  const nonMemberToken = await tokenForHuman(nonMember.email);

  const joinedList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(joinedToken, server.id),
  });
  assert.equal(joinedList.status, 200);
  const joinedBody = await joinedList.json() as Array<{ id: string; type: string; joined?: boolean }>;
  assert.ok(
    joinedBody.some((channel) => channel.id === jointProjection.id && channel.type === "joint" && channel.joined === true),
    "joined members should see the joint channel projection",
  );

  const nonMemberList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberList.status, 200);
  const nonMemberBody = await nonMemberList.json() as Array<{ id: string }>;
  assert.ok(!nonMemberBody.some((channel) => channel.id === jointProjection.id), "non-members should not see joint channels");

  const nonMemberUnread = await fetch(`${app.baseUrl}/api/channels/unread`, {
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberUnread.status, 200);
  const nonMemberUnreadBody = await nonMemberUnread.json() as Record<string, number>;
  assert.equal(
    nonMemberUnreadBody[jointProjection.id],
    undefined,
    "non-members must not receive joint projection unread counts",
  );

  const joinedDetail = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}`, {
    headers: headers(joinedToken, server.id),
  });
  assert.equal(joinedDetail.status, 200);
  const detailBody = await joinedDetail.json() as { id: string; type: string; joined?: boolean };
  assert.equal(detailBody.id, jointProjection.id);
  assert.equal(detailBody.type, "joint");
  assert.equal(detailBody.joined, true);

  const nonMemberDetail = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}`, {
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberDetail.status, 404);

  const nonMemberRead = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}/read`, {
    method: "POST",
    headers: headers(nonMemberToken, server.id),
    body: JSON.stringify({ seq: 1 }),
  });
  assert.equal(nonMemberRead.status, 404, "non-members must not mark known joint channels read");

  const nonMemberReadAll = await fetch(`${app.baseUrl}/api/channels/${jointProjection.id}/read-all`, {
    method: "POST",
    headers: headers(nonMemberToken, server.id),
  });
  assert.equal(nonMemberReadAll.status, 404, "non-members must not learn latest seq via joint read-all");

  const [nonMemberCursor] = await db
    .select()
    .from(userChannelReadCursors)
    .where(and(
      eq(userChannelReadCursors.userId, nonMember.id),
      eq(userChannelReadCursors.channelId, jointProjection.id),
    ));
  assert.equal(nonMemberCursor, undefined, "non-member read attempts must not create read cursor side effects");
});


test("joint channel create uses directed person invites and target invitee accept creates a local projection", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-create-host@slock.test", "joint-create-host");
  const targetOwner = await seedUser("joint-create-target-owner@slock.test", "joint-create-target-owner");
  const targetAdmin = await seedUser("joint-create-target-admin@slock.test", "joint-create-target-admin");
  const targetSecondAdmin = await seedUser("joint-create-target-second-admin@slock.test", "joint-create-target-second-admin");
  const targetMember = await seedUser("joint-create-target-member@slock.test", "joint-create-target-member");
  const hostServer = await createServer("Joint Create Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Create Target", "joint-create-target", targetOwner.id);
  await addMember(targetServer.id, hostOwner.id);
  await addMember(targetServer.id, targetAdmin.id, "admin");
  await addMember(targetServer.id, targetSecondAdmin.id, "admin");
  await addMember(targetServer.id, targetMember.id);

  const hostToken = await tokenForHuman(hostOwner.email);
  const targetOwnerToken = await tokenForHuman(targetOwner.email);
  const targetSecondAdminToken = await tokenForHuman(targetSecondAdmin.email);
  const targetMemberToken = await tokenForHuman(targetMember.email);

  const emailLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    emailLogs.push(args.map(String).join(" "));
  };
  let createRes: Response;
  try {
    createRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "partner-room",
        description: "shared partner work",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email, `@${targetSecondAdmin.name}`],
      }),
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(createRes.status, 200);
  assert.ok(emailLogs.some((log) => log.includes(`To: ${targetOwner.email}`)), "directly invited target user should receive the joint-channel invite email");
  assert.ok(emailLogs.some((log) => log.includes(`To: ${targetSecondAdmin.email}`)), "second directly invited admin should receive the joint-channel invite email");
  assert.ok(!emailLogs.some((log) => log.includes(`To: ${targetAdmin.email}`)), "uninvited target admins should not receive a person-scoped invite email");
  assert.ok(!emailLogs.some((log) => log.includes(`To: ${targetMember.email}`)), "uninvited target members should not receive a person-scoped invite email");
  const hostProjection = await createRes.json() as {
    id: string;
    type: string;
    joined: boolean;
    jointPeerServerSlug?: string;
    jointPeerStatus?: string;
    jointServers?: Array<{ serverId: string; serverSlug: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
    jointPendingInvites?: Array<{ id: string; fromServerId: string; toServerId: string; invitedUserId: string; status: "pending" }>;
    jointInvite?: { id: string; toServerId: string };
    jointInvites?: Array<{ id: string; toServerId: string; invitedUserId: string }>;
  };
  assert.equal(hostProjection.type, "joint");
  assert.equal(hostProjection.joined, true);
  assert.equal(hostProjection.jointPeerServerSlug, targetServer.slug);
  assert.equal(hostProjection.jointPeerStatus, "pending");
  assert.ok(hostProjection.jointServers?.some((server) => server.serverId === hostServer.id && server.status === "active" && server.isCurrentServer));
  assert.ok(hostProjection.jointServers?.some((server) => server.serverId === targetServer.id && server.status === "pending"));
  assert.deepEqual(hostProjection.jointPendingInvites?.map((invite) => invite.invitedUserId).sort(), [targetOwner.id, targetSecondAdmin.id].sort());
  assert.equal(hostProjection.jointInvite?.toServerId, targetServer.id);
  assert.deepEqual(hostProjection.jointInvites?.map((invite) => invite.invitedUserId), [targetOwner.id, targetSecondAdmin.id]);
  const secondInvite = hostProjection.jointInvites?.find((invite) => invite.invitedUserId === targetSecondAdmin.id);
  assert.ok(secondInvite, "second invited admin should get a separate pending invite");

  const [hostProjectionRow] = await db.select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, hostProjection.id));
  assert.ok(hostProjectionRow, "host projection should be registered separately from canonical storage");
  const [joint] = await db.select().from(jointChannels).where(eq(jointChannels.id, hostProjectionRow.jointChannelId));
  assert.ok(joint, "joint channel authority row should be created");
  assert.notEqual(joint.canonicalChannelId, hostProjection.id, "canonical storage must not be the host-side local projection");
  const [canonicalStorageChannel] = await db
    .select({ id: channels.id, serverId: channels.serverId, name: channels.name, type: channels.type })
    .from(channels)
    .where(eq(channels.id, joint.canonicalChannelId));
  assert.equal(canonicalStorageChannel.type, "channel", "joint storage should reuse ordinary channel storage rows");
  assert.match(canonicalStorageChannel.name, /^joint-storage-/, "joint storage channel should stay storage-named");
  assert.notEqual(canonicalStorageChannel.serverId, hostServer.id, "canonical storage must not belong to the host product server");
  assert.notEqual(canonicalStorageChannel.serverId, targetServer.id, "canonical storage must not belong to the target product server");
  const [storageNamespace] = await db
    .select({ id: serversTable.id, slug: serversTable.slug, kind: serversTable.kind })
    .from(serversTable)
    .where(eq(serversTable.id, canonicalStorageChannel.serverId));
  assert.equal(storageNamespace.kind, "joint_storage", "canonical storage should live under the reserved joint storage namespace");
  assert.equal(storageNamespace.slug, "__joint_storage__");
  const hostResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: hostProjection.id });
  assert.equal(hostResolved?.kind, "joint");
  assert.equal(hostResolved?.canonicalChannelId, joint.canonicalChannelId);
  const canonicalResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: joint.canonicalChannelId });
  assert.equal(canonicalResolved, null, "canonical storage channel must not be directly routable");
  const canonicalFetch = await fetch(`${app.baseUrl}/api/channels/${joint.canonicalChannelId}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(canonicalFetch.status, 404, "canonical storage channel must not be fetchable as a local channel");
  await db.insert(serverMembers).values({ serverId: storageNamespace.id, userId: hostOwner.id }).onConflictDoNothing();
  const serverListRes = await fetch(`${app.baseUrl}/api/servers`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  assert.equal(serverListRes.status, 200);
  const serverListBody = await serverListRes.json() as Array<{ id: string; slug: string }>;
  assert.ok(
    !serverListBody.some((server) => server.id === storageNamespace.id || server.slug === "__joint_storage__"),
    "joint storage namespace must not appear in ordinary server lists even if a stale member row exists",
  );
  const [inviteRow] = await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, hostProjection.jointInvite!.id));
  assert.equal(inviteRow.status, "pending");
  assert.equal(inviteRow.fromServerId, hostServer.id);
  assert.equal(inviteRow.toServerId, targetServer.id);
  assert.equal(inviteRow.invitedUserId, targetOwner.id);

  const resendEmailLogs: string[] = [];
  console.log = (...args: unknown[]) => {
    resendEmailLogs.push(args.map(String).join(" "));
  };
  let resendRes: Response;
  try {
    resendRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invite/resend`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.equal(resendRes.status, 200);
  assert.deepEqual(await resendRes.json(), { ok: true, resentCount: 2 });
  assert.ok(resendEmailLogs.some((log) => log.includes(`To: ${targetOwner.email}`)), "resend should email the first pending invitee");
  assert.ok(resendEmailLogs.some((log) => log.includes(`To: ${targetSecondAdmin.email}`)), "resend should email every pending directed invitee");

  const targetMemberInvites = await fetch(`${app.baseUrl}/api/channels/joint-invites`, {
    headers: headers(targetMemberToken, targetServer.id),
  });
  assert.equal(targetMemberInvites.status, 200);
  const targetMemberInvitesBody = await targetMemberInvites.json() as { invites: unknown[] };
  assert.deepEqual(targetMemberInvitesBody.invites, [], "uninvited target members should not see someone else's joint-channel invite");

  const targetInvites = await fetch(`${app.baseUrl}/api/channels/joint-invites`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetInvites.status, 200);
  const targetInvitesBody = await targetInvites.json() as { invites: Array<{ id: string; fromServerSlug: string; channelName: string }> };
  assert.deepEqual(targetInvitesBody.invites.map((invite) => invite.id), [hostProjection.jointInvite!.id]);
  assert.equal(targetInvitesBody.invites[0].fromServerSlug, hostServer.slug);
  assert.equal(targetInvitesBody.invites[0].channelName, "partner-room");

  const targetAdminToken = await tokenForHuman(targetAdmin.email);
  const targetAdminInvites = await fetch(`${app.baseUrl}/api/channels/joint-invites`, {
    headers: headers(targetAdminToken, targetServer.id),
  });
  assert.equal(targetAdminInvites.status, 200);
  const targetAdminInvitesBody = await targetAdminInvites.json() as { invites: unknown[] };
  assert.deepEqual(targetAdminInvitesBody.invites, [], "target admins do not see directed invites unless they are explicitly invited");

  const malformedInviteAccept = await fetch(`${app.baseUrl}/api/channels/joint-invites/${"x".repeat(12000)}/accept`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(malformedInviteAccept.status, 404, "malformed joint-channel invite IDs should cloak without hitting UUID DB casts");

  const targetAdminAccept = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite!.id}/accept`, {
    method: "POST",
    headers: headers(targetAdminToken, targetServer.id),
  });
  assert.equal(targetAdminAccept.status, 404, "uninvited target admins cannot accept someone else's joint-channel invite");

  const events = installFakeIo(app.app);
  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite!.id}/accept`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as {
    id: string;
    type: string;
    joined: boolean;
    name: string;
    description: string | null;
    jointPeerServerSlug?: string;
    jointPeerStatus?: string;
    jointServers?: Array<{ serverId: string; serverSlug: string; status: "active" | "pending"; isCurrentServer?: boolean; channelName?: string }>;
    jointPendingInvites?: Array<{ id: string; fromServerId: string; toServerId: string; invitedUserId: string; status: "pending" }>;
  };
  assert.equal(targetProjection.type, "joint");
  assert.equal(targetProjection.name, "partner-room");
  assert.equal(targetProjection.description, "shared partner work");
  assert.equal(targetProjection.joined, true);
  assert.equal(targetProjection.jointPeerServerSlug, hostServer.slug);
  assert.equal(targetProjection.jointPeerStatus, "active");
  assert.ok(targetProjection.jointServers?.some((server) => server.serverId === hostServer.id && server.status === "active"));
  assert.ok(targetProjection.jointServers?.some((server) => server.serverId === targetServer.id && server.status === "active" && server.isCurrentServer));
  // Each active server carries its own name for the channel (names are per
  // server), so a task ref written on the other server maps to this one.
  const [hostLocalName] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, hostProjection.id));
  assert.equal(targetProjection.jointServers?.find((server) => server.serverId === hostServer.id)?.channelName, hostLocalName?.name);
  assert.equal(targetProjection.jointServers?.find((server) => server.serverId === targetServer.id)?.channelName, targetProjection.name);
  assert.ok(targetProjection.jointPendingInvites?.some((invite) => invite.toServerId === targetServer.id && invite.invitedUserId === targetSecondAdmin.id));
  assert.notEqual(targetProjection.id, hostProjection.id);
  assert.ok(
    !events.some((event) => event.room === `server:${targetServer.id}` && typeof event.payload === "object" && event.payload !== null && "channel" in event.payload),
    "accepting a joint invite must not broadcast full joint channel metadata to every target-server member",
  );
  assert.ok(
    events.some((event) => event.room === `user:${targetOwner.id}:server:${targetServer.id}` && event.event === "channel:updated"),
    "accepting invitee should receive the new joint channel metadata directly",
  );
  assert.ok(
    !events.some((event) => event.room === `user:${targetOwner.id}` && event.event === "channel:updated"),
    "the target projection must not reach the invitee's sockets on their other servers (duplicate sidebar rows)",
  );

  const secondAcceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${secondInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetSecondAdminToken, targetServer.id),
  });
  assert.equal(secondAcceptRes.status, 200);
  const secondAcceptBody = await secondAcceptRes.json() as { id: string; joined?: boolean };
  assert.equal(secondAcceptBody.id, targetProjection.id, "second invitee should join the existing target projection");
  assert.equal(secondAcceptBody.joined, true);
  const secondAdminList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(targetSecondAdminToken, targetServer.id),
  });
  assert.equal(secondAdminList.status, 200);
  const secondAdminListBody = await secondAdminList.json() as Array<{ id: string; joined?: boolean }>;
  assert.ok(
    secondAdminListBody.some((channel) => channel.id === targetProjection.id && channel.joined),
    "second invitee must get real channel membership when accepting an existing projection",
  );

  const acceptedInvite = await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, hostProjection.jointInvite!.id));
  assert.equal(acceptedInvite[0]?.status, "accepted");
  assert.equal(acceptedInvite[0]?.acceptedVia, "invitee");
  const targetResolved = await resolveChannelAccess({ serverId: targetServer.id, channelId: targetProjection.id });
  assert.equal(targetResolved?.kind, "joint");
  assert.equal(targetResolved?.canonicalChannelId, joint.canonicalChannelId);
  assert.equal(targetResolved?.role, "participant");
  await addHuman(targetProjection.id, hostOwner.id);

  const targetMemberList = await fetch(`${app.baseUrl}/api/channels`, {
    headers: headers(targetMemberToken, targetServer.id),
  });
  assert.equal(targetMemberList.status, 200);
  const targetMemberListBody = await targetMemberList.json() as Array<{ id: string }>;
  assert.ok(!targetMemberListBody.some((channel) => channel.id === targetProjection.id), "accepting a server invite does not auto-add all target server members");
  const targetMemberJoin = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/join`, {
    method: "POST",
    headers: headers(targetMemberToken, targetServer.id),
  });
  assert.equal(targetMemberJoin.status, 403, "ordinary target server members cannot self-join a joint channel by id");

  const targetAgent = await createAgent(targetServer.id, "joint-target-agent", {
    runtime: "codex",
    creatorType: "user",
    creatorId: targetOwner.id,
  });
  const hostJointAgent = await createAgent(hostServer.id, "joint-host-agent", { runtime: "codex" });
  const hostWideAgent = await createAgent(hostServer.id, "joint-host-wide-agent", { runtime: "codex" });
  await addAgent(targetProjection.id, targetAgent.id);
  await addAgent(hostProjection.id, hostJointAgent.id);

  const hostMembers = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/members`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMembers.status, 200);
  const hostMembersBody = await hostMembers.json() as {
    agents: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string; status?: string }>;
    humans: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string }>;
  };
  assert.deepEqual(
    hostMembersBody.humans.map((human) => human.id).sort(),
    [hostOwner.id, targetOwner.id, targetSecondAdmin.id].sort(),
    "host-side joint member list should aggregate human members from all active projections",
  );
  assert.deepEqual(
    hostMembersBody.agents.map((agent) => agent.id).sort(),
    [hostJointAgent.id, targetAgent.id].sort(),
    "host-side joint member list should aggregate agent members from all active projections",
  );
  assert.ok(!hostMembersBody.agents.some((agent) => agent.id === hostWideAgent.id), "host-side joint member list must exclude same-server agents outside the joint projection");
  assert.ok(
    hostMembersBody.humans.some((human) => (
      human.id === targetOwner.id
      && human.serverId === targetServer.id
      && human.serverName === targetServer.name
      && human.serverSlug === targetServer.slug
    )),
    "host-side joint member list should include the target admin with peer server metadata",
  );
  assert.ok(
    hostMembersBody.agents.some((agent) => (
      agent.id === targetAgent.id
      && agent.serverId === targetServer.id
      && agent.serverName === targetServer.name
      && agent.serverSlug === targetServer.slug
      && typeof agent.status === "string"
    )),
    "host-side joint member list should include agents added from the target server projection with profile/status metadata",
  );

  const targetMembers = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/members`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetMembers.status, 200);
  const targetMembersBody = await targetMembers.json() as {
    agents: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string; status?: string }>;
    humans: Array<{ id: string; serverId?: string; serverName?: string; serverSlug?: string; name: string }>;
  };
  assert.deepEqual(
    targetMembersBody.humans.map((human) => human.id).sort(),
    [hostOwner.id, targetOwner.id, targetSecondAdmin.id].sort(),
    "target-side joint member list should aggregate human members from all active projections",
  );
  assert.deepEqual(
    targetMembersBody.agents.map((agent) => agent.id).sort(),
    [hostJointAgent.id, targetAgent.id].sort(),
    "target-side joint member list should aggregate agent members from all active projections",
  );
  assert.ok(!targetMembersBody.humans.some((human) => human.id === targetMember.id), "target-side joint member list must exclude same-server humans outside the joint projection");
  assert.ok(
    targetMembersBody.agents.some((agent) => (
      agent.id === hostJointAgent.id
      && agent.serverId === hostServer.id
      && agent.serverName === hostServer.name
      && agent.serverSlug === hostServer.slug
      && typeof agent.status === "string"
    )),
    "target-side joint member list should include agents added from the host server projection with profile/status metadata",
  );

  const peerAgentProfile = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentProfile.status, 200, "joint channel members can open peer-server agent profiles");
  const peerAgentProfileBody = await peerAgentProfile.json() as Record<string, unknown>;
  assert.equal(peerAgentProfileBody.id, targetAgent.id);
  assert.equal(peerAgentProfileBody.serverId, targetServer.id);
  assert.equal(peerAgentProfileBody.serverName, targetServer.name);
  assert.equal(peerAgentProfileBody.serverSlug, targetServer.slug);
  assert.equal(peerAgentProfileBody.name, "joint-target-agent");
  assert.equal(typeof peerAgentProfileBody.status, "string");
  assert.equal(peerAgentProfileBody.activityDetail, "", "remote joint profile must not expose private activity detail");
  assert.equal("machineId" in peerAgentProfileBody, false, "remote joint profile must not expose machine binding");
  assert.equal("runtimeProfile" in peerAgentProfileBody, false, "remote joint profile must not expose runtime profile");
  assert.equal("envVars" in peerAgentProfileBody, false, "remote joint profile must not expose env vars");
  assert.equal("createdAgents" in peerAgentProfileBody, false, "remote joint profile must not expose created-agent graph");
  assert.equal("model" in peerAgentProfileBody, false, "remote joint profile must not expose model config");
  assert.equal("runtime" in peerAgentProfileBody, false, "remote joint profile must not expose runtime config");

  const peerAgentScopes = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}/scopes`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentScopes.status, 404, "joint visibility must not expose peer-server agent permissions");

  const peerAgentActivityLog = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}/activity-log`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentActivityLog.status, 404, "joint visibility must not expose peer-server agent activity logs");

  const peerAgentWorkspace = await fetch(`${app.baseUrl}/api/agents/${targetAgent.id}/workspace-files`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentWorkspace.status, 404, "joint visibility must not expose peer-server agent workspace");

  const peerAgentReminders = await fetch(`${app.baseUrl}/api/reminders?ownerAgentId=${targetAgent.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerAgentReminders.status, 404, "joint visibility must not expose peer-server agent reminders");

  const peerHumanProfile = await fetch(`${app.baseUrl}/api/servers/${hostServer.id}/members/${targetOwner.id}/profile`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerHumanProfile.status, 200, "joint channel members can open peer-server human profiles");
  const peerHumanProfileBody = await peerHumanProfile.json() as {
    serverId: string;
    serverName: string;
    serverSlug: string;
    email: string | null;
    joinedAt: string | null;
    gravatarHash: string;
    role: string | null;
    membershipStatus: string;
    createdAgents: unknown[];
  };
  assert.equal(peerHumanProfileBody.serverId, targetServer.id);
  assert.equal(peerHumanProfileBody.serverName, targetServer.name);
  assert.equal(peerHumanProfileBody.serverSlug, targetServer.slug);
  assert.equal(peerHumanProfileBody.email, null, "remote joint human profile must not expose peer-server email");
  assert.equal(peerHumanProfileBody.gravatarHash, "", "remote joint human profile must not expose email-derived gravatar hash");
  assert.equal(peerHumanProfileBody.role, null, "remote joint human profile must not expose peer-server role");
  assert.equal(peerHumanProfileBody.joinedAt, null, "remote joint human profile must not expose peer-server join date");
  assert.equal(peerHumanProfileBody.membershipStatus, "active", "remote joint human profile only reports active visibility on the shared channel");
  assert.deepEqual(peerHumanProfileBody.createdAgents, [], "remote joint human profile must not expose peer-server created-agent graph");

  const peerHumanDm = await fetch(`${app.baseUrl}/api/channels/dm`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ userId: targetOwner.id }),
  });
  assert.equal(peerHumanDm.status, 400, "joint visibility alone must not allow cross-server human DMs");
  const peerHumanDmBody = await peerHumanDm.json() as { error?: string };
  assert.equal(peerHumanDmBody.error, "User is not a member of this server");

  const targetMessage = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ channelId: targetProjection.id, content: "hello from target server @joint-target-agent @joint-host-wide-agent" }),
  });
  assert.equal(targetMessage.status, 200);
  const targetMessageBody = await targetMessage.json() as { id: string; channelId: string; content: string };
  assert.equal(targetMessageBody.channelId, targetProjection.id, "sender receives their local projection id");
  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `channel:${hostProjection.id}`),
    "joint message socket fanout should use the host local projection room",
  );
  assert.ok(
    events.some((event) => event.event === "message:new" && event.room === `channel:${targetProjection.id}`),
    "joint message socket fanout should use the target local projection room",
  );
  assert.ok(
    !events.some((event) => event.event === "message:new" && event.room === `channel:${joint.canonicalChannelId}`),
    "joint message socket fanout must not expose the canonical storage room",
  );

  const saveTargetJointMessage = await fetch(`${app.baseUrl}/api/channels/saved`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ messageId: targetMessageBody.id }),
  });
  assert.equal(saveTargetJointMessage.status, 200, "joint participants should be able to save canonical-storage messages");

  const targetSavedList = await fetch(`${app.baseUrl}/api/channels/saved`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetSavedList.status, 200);
  const targetSavedListBody = await targetSavedList.json() as {
    total: number;
    saved: Array<{ messageId: string; channelId: string; channelType: string; content: string }>;
  };
  assert.equal(targetSavedListBody.total, 1);
  assert.ok(
    targetSavedListBody.saved.some((entry) => (
      entry.messageId === targetMessageBody.id
      && entry.channelId === targetProjection.id
      && entry.channelType === "joint"
      && entry.content === targetMessageBody.content
    )),
    "saved joint messages should list through the caller's local projection, not canonical storage",
  );

  const targetSavedCheck = await fetch(`${app.baseUrl}/api/channels/saved/check`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ messageIds: [targetMessageBody.id] }),
  });
  assert.equal(targetSavedCheck.status, 200);
  assert.deepEqual(await targetSavedCheck.json(), { savedIds: [targetMessageBody.id] });

  const nonMemberSave = await fetch(`${app.baseUrl}/api/channels/saved`, {
    method: "POST",
    headers: headers(targetMemberToken, targetServer.id),
    body: JSON.stringify({ messageId: targetMessageBody.id }),
  });
  assert.equal(nonMemberSave.status, 404, "server members outside the joint projection must not save by message id");

  const mentionRows = await db.select().from(messageMentions).where(eq(messageMentions.messageId, targetMessageBody.id));
  assert.ok(
    mentionRows.some((row) => row.targetType === "agent" && row.targetId === targetAgent.id),
    "joint mentions should resolve active peer projection agents",
  );
  assert.ok(
    !mentionRows.some((row) => row.targetType === "agent" && row.targetId === hostWideAgent.id),
    "joint mentions must not resolve host server-wide agents outside the joint channel",
  );

  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200);
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ id: string; channelId: string; content: string; senderMembershipStatus: "active" | "removed" | null }> };
  assert.ok(
    hostMessagesBody.messages.some((message) => message.channelId === hostProjection.id && message.content === targetMessageBody.content),
    "host-side projection should read messages sent from the target-side projection",
  );
  const projectedTargetMessage = hostMessagesBody.messages.find((message) => message.id === targetMessageBody.id);
  assert.equal(
    projectedTargetMessage?.senderMembershipStatus,
    "active",
    "peer-server joint human senders must not be marked removed just because they are not members of the canonical host server",
  );
  const peerHumanProfileAfterMessage = await fetch(`${app.baseUrl}/api/servers/${hostServer.id}/members/${targetOwner.id}/profile`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(peerHumanProfileAfterMessage.status, 200);
  const peerHumanProfileAfterMessageBody = await peerHumanProfileAfterMessage.json() as {
    serverId: string;
    email: string | null;
    joinedAt: string | null;
    role: string | null;
    membershipStatus: string;
    createdAgents: unknown[];
  };
  assert.equal(peerHumanProfileAfterMessageBody.serverId, targetServer.id);
  assert.equal(peerHumanProfileAfterMessageBody.email, null, "remote joint human profile must stay identity-only after they have sent a shared message");
  assert.equal(peerHumanProfileAfterMessageBody.role, null, "remote joint human profile must not fall back to current-server removed-member details");
  assert.equal(peerHumanProfileAfterMessageBody.joinedAt, null);
  assert.equal(peerHumanProfileAfterMessageBody.membershipStatus, "active");
  assert.deepEqual(peerHumanProfileAfterMessageBody.createdAgents, []);

  const hostMessage = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "hello from host server" }),
  });
  assert.equal(hostMessage.status, 200);

  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetProjection.id}`, {
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200);
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(
    targetMessagesBody.messages.some((message) => message.channelId === targetProjection.id && message.content === "hello from host server"),
    "target-side projection should read messages sent from the host-side projection",
  );

  // Only the host renames and archives (computed joint membership).
  const renameRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}`, {
    method: "PATCH",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ name: "renamed-partner-room", description: "shared updated description" }),
  });
  assert.equal(renameRes.status, 200);

  const hostAfterRename = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostAfterRename.status, 200);
  const hostAfterRenameBody = await hostAfterRename.json() as { name: string; description: string | null };
  assert.equal(hostAfterRenameBody.name, "renamed-partner-room");
  assert.equal(hostAfterRenameBody.description, "shared updated description");

  const rejectVisibility = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}`, {
    method: "PATCH",
    headers: headers(targetOwnerToken, targetServer.id),
    body: JSON.stringify({ visibility: "private" }),
  });
  assert.equal(rejectVisibility.status, 403, "joint channels cannot be converted to private/public visibility");

  const archiveRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/archive`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(archiveRes.status, 200, "joint channel archive should be a shared operation");
  const hostArchived = await getChannel(hostProjection.id);
  const targetArchived = await getChannel(targetProjection.id);
  assert.ok(hostArchived?.archivedAt, "host projection should be archived when target side archives the joint channel");
  assert.ok(targetArchived?.archivedAt, "target projection should be archived when target side archives the joint channel");

  const unarchiveRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/unarchive`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(unarchiveRes.status, 200, "joint channel unarchive should be a shared operation");
  const hostUnarchived = await getChannel(hostProjection.id);
  const targetUnarchived = await getChannel(targetProjection.id);
  assert.equal(hostUnarchived?.archivedAt, null, "host projection should be unarchived");
  assert.equal(targetUnarchived?.archivedAt, null, "target projection should be unarchived");

  const deleteJoint = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}`, {
    method: "DELETE",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(deleteJoint.status, 400, "joint channels do not support ordinary delete");

  const disconnectRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/disconnect`, {
    method: "POST",
    headers: headers(targetOwnerToken, targetServer.id),
  });
  assert.equal(disconnectRes.status, 200, "target server admin can disconnect its local joint projection");
  assert.equal(
    await resolveChannelAccess({ serverId: targetServer.id, channelId: targetProjection.id }),
    null,
    "disconnected projection should no longer resolve",
  );
  const disconnectedTargetProjection = await getChannel(targetProjection.id);
  assert.equal(disconnectedTargetProjection, null, "disconnected projection should be removed from ordinary channel fetches");
  const hostStillResolved = await resolveChannelAccess({ serverId: hostServer.id, channelId: hostProjection.id });
  assert.equal(hostStillResolved?.kind, "joint", "disconnecting one server should not delete the other projection");
});


async function captureInviteEmails<T>(run: () => Promise<T>): Promise<{ result: T; emailLogs: string[] }> {
  const emailLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    emailLogs.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), emailLogs };
  } finally {
    console.log = originalConsoleLog;
  }
}

test("joint create connects directly without email when the inviter administers both servers (RFC 075 §4.5)", async ({ app }) => {
  const db = getDb();
  const admin = await seedUser("joint-same-admin@slock.test", "joint-same-admin");
  const hostServer = await createServer("Joint Same Admin Host", "botiverse", admin.id);
  const targetServer = await createServer("Joint Same Admin Target", "joint-same-admin-target", admin.id);
  const adminToken = await tokenForHuman(admin.email);

  const events = installFakeIo(app.app);
  const { result: createRes, emailLogs } = await captureInviteEmails(() => fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(adminToken, hostServer.id),
    body: JSON.stringify({
      name: "same-admin-room",
      visibility: "joint",
      jointInvites: [{ targetServerSlug: targetServer.slug, invitedPeople: [`@${admin.name}`], sameAdmin: true }],
    }),
  }));
  assert.equal(createRes.status, 200);
  assert.ok(!emailLogs.some((log) => log.includes(`To: ${admin.email}`)), "a same-admin connection must not email the inviter");
  const body = await createRes.json() as {
    id: string;
    jointInvites: Array<{ id: string; status: string }>;
    jointServers?: Array<{ serverId: string; status: "active" | "pending" }>;
  };
  assert.equal(body.jointInvites[0]?.status, "accepted");
  assert.ok(body.jointServers?.some((server) => server.serverId === targetServer.id && server.status === "active"));

  const [invite] = await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, body.jointInvites[0]!.id));
  assert.equal(invite?.status, "accepted");
  assert.equal(invite?.acceptedVia, "same_admin");
  assert.equal(invite?.invitedUserId, admin.id);
  assert.equal(invite?.acceptedByUserId, admin.id);
  // The same-admin connection is audited once, on the host.
  const connectedAudit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_connected"));
  assert.deepEqual(
    connectedAudit.map((row) => ({ serverId: row.serverId, actorId: row.actorId, mode: row.metadata.mode, channelId: row.metadata.channelId, connectedServerId: row.metadata.connectedServerId })),
    [{ serverId: hostServer.id, actorId: admin.id, mode: "same_admin", channelId: body.id, connectedServerId: targetServer.id }],
  );

  const [targetProjection] = await db
    .select({ localChannelId: jointChannelServers.localChannelId, status: jointChannelServers.status })
    .from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, invite!.jointChannelId), eq(jointChannelServers.serverId, targetServer.id)));
  assert.equal(targetProjection?.status, "active");
  assert.ok(await isChannelHuman(targetProjection!.localChannelId, admin.id), "the admin joins the target projection");
  assert.ok(
    events.some((event) => event.room === `user:${admin.id}:server:${targetServer.id}` && event.event === "channel:updated"),
    "the target projection reaches the admin's sockets on the target server",
  );

  const pending = await fetch(`${app.baseUrl}/api/channels/joint-invites`, { headers: headers(adminToken, targetServer.id) });
  assert.deepEqual((await pending.json() as { invites: unknown[] }).invites, []);
});

test("joint same-admin is opt-in, inviter-only and re-checks target authority", async ({ app }) => {
  const db = getDb();
  const admin = await seedUser("joint-same-admin-gate@slock.test", "joint-same-admin-gate");
  const otherAdmin = await seedUser("joint-same-admin-gate-other@slock.test", "joint-same-admin-gate-other");
  const hostServer = await createServer("Joint Same Admin Gate Host", "botiverse", admin.id);
  const adminTarget = await createServer("Joint Same Admin Gate Target", "joint-same-admin-gate-target", admin.id);
  const memberTarget = await createServer("Joint Same Admin Gate Member", "joint-same-admin-gate-member", otherAdmin.id);
  await addMember(memberTarget.id, admin.id);
  const adminToken = await tokenForHuman(admin.email);

  // Without the confirmation flag a self-invite keeps the email flow.
  const { result: unconfirmedRes, emailLogs: unconfirmedEmails } = await captureInviteEmails(() => fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(adminToken, hostServer.id),
    body: JSON.stringify({ name: "same-admin-unconfirmed", visibility: "joint", targetServerSlug: adminTarget.slug, invitedPeople: [admin.email] }),
  }));
  assert.equal(unconfirmedRes.status, 200);
  assert.ok(unconfirmedEmails.some((log) => log.includes(`To: ${admin.email}`)));
  const unconfirmed = await unconfirmedRes.json() as { jointInvite: { id: string; status: string } };
  assert.equal(unconfirmed.jointInvite.status, "pending");

  // The flag never applies to someone else: they are emailed as before.
  const { result: otherRes, emailLogs: otherEmails } = await captureInviteEmails(() => fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(adminToken, hostServer.id),
    body: JSON.stringify({
      name: "same-admin-other-invitee",
      visibility: "joint",
      jointInvites: [{ targetServerSlug: memberTarget.slug, invitedPeople: [otherAdmin.email], sameAdmin: true }],
    }),
  }));
  assert.equal(otherRes.status, 200);
  assert.ok(otherEmails.some((log) => log.includes(`To: ${otherAdmin.email}`)));
  const other = await otherRes.json() as { jointInvite: { id: string; status: string } };
  assert.equal(other.jointInvite.status, "pending");

  // The flag does not grant authority: a plain member of the target is rejected.
  const { result: memberRes, emailLogs: memberEmails } = await captureInviteEmails(() => fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(adminToken, hostServer.id),
    body: JSON.stringify({
      name: "same-admin-not-target-admin",
      visibility: "joint",
      jointInvites: [{ targetServerSlug: memberTarget.slug, invitedPeople: [admin.email], sameAdmin: true }],
    }),
  }));
  assert.equal(memberRes.status, 400);
  assert.equal((await memberRes.json() as { code: string }).code, "joint_invitee_unavailable");
  assert.ok(!memberEmails.some((log) => log.includes(`To: ${admin.email}`)));

  // A link accept is recorded as the invitee's own accept.
  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${unconfirmed.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(adminToken, adminTarget.id),
  });
  assert.equal(acceptRes.status, 200);
  const [linkAccepted] = await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, unconfirmed.jointInvite.id));
  assert.equal(linkAccepted?.acceptedVia, "invitee");
});

test("joint server invite connects directly when the inviter administers the new server", async ({ app }) => {
  const db = getDb();
  const admin = await seedUser("joint-same-admin-invite@slock.test", "joint-same-admin-invite");
  const peer = await seedUser("joint-same-admin-invite-peer@slock.test", "joint-same-admin-invite-peer");
  const hostServer = await createServer("Joint Same Admin Invite Host", "botiverse", admin.id);
  const peerServer = await createServer("Joint Same Admin Invite Peer", "joint-same-admin-invite-peer", peer.id);
  const thirdServer = await createServer("Joint Same Admin Invite Third", "joint-same-admin-invite-third", peer.id);
  await addMember(thirdServer.id, admin.id, "admin");
  const adminToken = await tokenForHuman(admin.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(adminToken, hostServer.id),
    body: JSON.stringify({ name: "same-admin-invite-room", visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [peer.email] }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string };

  const { result: inviteRes, emailLogs } = await captureInviteEmails(() => fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(adminToken, hostServer.id),
    body: JSON.stringify({ targetServerSlug: thirdServer.slug, invitedPeople: [`@${admin.name}`], sameAdmin: true }),
  }));
  assert.equal(inviteRes.status, 200);
  assert.ok(!emailLogs.some((log) => log.includes(`To: ${admin.email}`)));
  const invited = await inviteRes.json() as { jointInvite: { id: string; status: string } };
  assert.equal(invited.jointInvite.status, "accepted");
  const [invite] = await db.select().from(jointChannelInvites).where(eq(jointChannelInvites.id, invited.jointInvite.id));
  assert.equal(invite?.acceptedVia, "same_admin");
  const [thirdProjection] = await db
    .select({ status: jointChannelServers.status })
    .from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, invite!.jointChannelId), eq(jointChannelServers.serverId, thirdServer.id)));
  assert.equal(thirdProjection?.status, "active");
});

test("joint channel create can invite multiple target servers in the initial request", async ({ app }) => {
  const hostOwner = await seedUser("joint-create-multi-host@slock.test", "joint-create-multi-host");
  const targetOwner = await seedUser("joint-create-multi-target@slock.test", "joint-create-multi-target");
  const thirdOwner = await seedUser("joint-create-multi-third@slock.test", "joint-create-multi-third");
  const hostServer = await createServer("Joint Create Multi Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Create Multi Target", "joint-create-multi-target", targetOwner.id);
  const thirdServer = await createServer("Joint Create Multi Third", "joint-create-multi-third", thirdOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "multi-initial-room",
      visibility: "joint",
      jointInvites: [
        { targetServerSlug: targetServer.slug, invitedPeople: [`@${targetOwner.name}`] },
        { targetServerSlug: thirdServer.slug, invitedPeople: [thirdOwner.email] },
      ],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as {
    id: string;
    jointInvites: Array<{ id: string; toServerId: string; invitedUserId: string }>;
    jointPendingInvites: Array<{ toServerId: string; invitedUserId: string; status: "pending" }>;
    jointServers: Array<{ serverId: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
  };
  assert.ok(hostProjection.jointServers.some((server) => server.serverId === hostServer.id && server.status === "active" && server.isCurrentServer));
  assert.ok(hostProjection.jointServers.some((server) => server.serverId === targetServer.id && server.status === "pending"));
  assert.ok(hostProjection.jointServers.some((server) => server.serverId === thirdServer.id && server.status === "pending"));
  assert.deepEqual(
    hostProjection.jointInvites.map((invite) => [invite.toServerId, invite.invitedUserId]).sort(),
    [[targetServer.id, targetOwner.id], [thirdServer.id, thirdOwner.id]].sort(),
  );
  assert.deepEqual(
    hostProjection.jointPendingInvites.map((invite) => [invite.toServerId, invite.invitedUserId, invite.status]).sort(),
    [[targetServer.id, targetOwner.id, "pending"], [thirdServer.id, thirdOwner.id, "pending"]].sort(),
  );
});


test("joint channel create rejects more than thirty total servers", async ({ app }) => {
  const hostOwner = await seedUser("joint-create-limit-host@slock.test", "joint-create-limit-host");
  const hostServer = await createServer("Joint Create Limit Host", "botiverse", hostOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  // Contract v0.3 §18.6: 30 servers including the host, so 30 invite targets
  // is one too many. Parsing rejects before any target is resolved.
  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "too-many-initial-servers",
      visibility: "joint",
      jointInvites: Array.from({ length: 30 }, (_, index) => ({
        targetServerSlug: `joint-limit-target-${index}`,
        invitedPeople: [`owner-${index}@slock.test`],
      })),
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string; code?: string };
  assert.match(body.error, /maximum of 30 servers/);
  assert.equal(body.code, "joint_invite_limit_exceeded");
});

test("joint channel create rejects oversized directed invitee arrays", async ({ app }) => {
  const hostOwner = await seedUser("joint-create-invitee-cap-host@slock.test", "joint-create-invitee-cap-host");
  const targetOwner = await seedUser("joint-create-invitee-cap-target@slock.test", "joint-create-invitee-cap-target");
  const hostServer = await createServer("Joint Create Invitee Cap Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Create Invitee Cap Target", "joint-create-invitee-cap-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "oversized-invitees",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: Array.from({ length: MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET + 1 }, (_, index) => `person-${index}@slock.test`),
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string; code?: string };
  assert.match(body.error, /maximum of 20 invited people/);
  assert.equal(body.code, "joint_invite_limit_exceeded");
});


test("joint storage migration preserves active legacy projections and moves storage-only state", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-migration-host@slock.test", "joint-migration-host");
  const targetOwner = await seedUser("joint-migration-target@slock.test", "joint-migration-target");
  const hostServer = await createServer("Joint Migration Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Migration Target", "joint-migration-target", targetOwner.id);

  const legacyHostProjection = await createChannel(hostServer.id, "legacy-joint", undefined, "joint");
  const legacyTargetProjection = await createChannel(targetServer.id, "legacy-joint", undefined, "joint");
  await addHuman(legacyHostProjection.id, hostOwner.id);
  await addHuman(legacyTargetProjection.id, targetOwner.id);
  const [legacyJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: legacyHostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: legacyJoint.id,
      serverId: hostServer.id,
      localChannelId: legacyHostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: legacyJoint.id,
      serverId: targetServer.id,
      localChannelId: legacyTargetProjection.id,
      role: "participant",
      joinedByUserId: targetOwner.id,
    },
  ]);
  await fillJointMembersFromChannelHumans();
  const legacyMessage = await createMessage(
    legacyHostProjection.id,
    "user",
    hostOwner.id,
    "legacy production message survives migration",
  );
  await db.insert(messageReactions).values({
    messageId: legacyMessage.id,
    reactorType: "user",
    reactorId: hostOwner.id,
    emoji: "👀",
  });
  const [legacyAttachment] = await insertAttachmentsWithObjects(db, {
    messageId: legacyMessage.id,
    channelId: legacyHostProjection.id,
    uploaderId: hostOwner.id,
    uploaderType: "user",
    filename: "legacy.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1234,
    storageKey: "test/legacy.pdf",
  });
  await db.insert(userChannelReadCursors).values([
    {
      userId: hostOwner.id,
      channelId: legacyHostProjection.id,
      lastReadSeq: legacyMessage.seq,
    },
    {
      userId: targetOwner.id,
      channelId: legacyTargetProjection.id,
      lastReadSeq: legacyMessage.seq - 1,
    },
  ]);

  const archivedHostProjection = await createChannel(hostServer.id, "archived-legacy-joint", undefined, "joint");
  const archivedTargetProjection = await createChannel(targetServer.id, "archived-legacy-joint", undefined, "joint");
  const [archivedJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: archivedHostProjection.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
    status: "closed",
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: archivedJoint.id,
      serverId: hostServer.id,
      localChannelId: archivedHostProjection.id,
      role: "host",
      status: "disconnected",
      joinedByUserId: hostOwner.id,
      disconnectedAt: new Date(),
    },
    {
      jointChannelId: archivedJoint.id,
      serverId: targetServer.id,
      localChannelId: archivedTargetProjection.id,
      role: "participant",
      status: "disconnected",
      joinedByUserId: targetOwner.id,
      disconnectedAt: new Date(),
    },
  ]);
  await fillJointMembersFromChannelHumans();
  await db.update(channels)
    .set({ archivedAt: new Date(), deletedAt: new Date() })
    .where(eq(channels.id, archivedHostProjection.id));
  await db.update(channels)
    .set({ archivedAt: new Date(), deletedAt: new Date() })
    .where(eq(channels.id, archivedTargetProjection.id));

  const [storageNamespace] = await db.insert(serversTable).values({
    name: "Joint Storage Namespace",
    slug: "__joint_storage__",
    kind: "joint_storage",
    ownerId: hostOwner.id,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const storageChannel = await createChannel(storageNamespace.id, "joint-storage-test");
  const newHostProjection = await createChannel(hostServer.id, "new-shape-joint", undefined, "joint");
  await addHuman(newHostProjection.id, hostOwner.id);
  const [newShapeJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: storageChannel.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: newShapeJoint.id,
    serverId: hostServer.id,
    localChannelId: newHostProjection.id,
    role: "host",
    joinedByUserId: hostOwner.id,
  });
  await fillJointMembersFromChannelHumans();

  const migrationSql = readFileSync(new URL("../../drizzle/0100_joint_storage_legacy_convert.sql", import.meta.url), "utf8");
  for (const statement of migrationSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await db.execute(sql.raw(statement));
  }

  const [migratedLegacyJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, legacyJoint.id));
  assert.equal(migratedLegacyJoint.status, "active", "active legacy joint authority row should remain active");
  assert.notEqual(
    migratedLegacyJoint.canonicalChannelId,
    legacyHostProjection.id,
    "active legacy joint canonical storage should move away from the host local projection",
  );
  const legacyServerRows = await db.select().from(jointChannelServers).where(eq(jointChannelServers.jointChannelId, legacyJoint.id));
  assert.ok(legacyServerRows.every((row) => row.status === "active"), "active local projections should remain connected");
  const [hostProjectionAfter] = await db.select().from(channels).where(eq(channels.id, legacyHostProjection.id));
  const [targetProjectionAfter] = await db.select().from(channels).where(eq(channels.id, legacyTargetProjection.id));
  assert.equal(hostProjectionAfter.deletedAt, null, "host local projection must not be soft-deleted");
  assert.equal(hostProjectionAfter.archivedAt, null, "host local projection must not be archived");
  assert.equal(targetProjectionAfter.deletedAt, null, "peer local projection must not be soft-deleted");
  assert.equal(targetProjectionAfter.archivedAt, null, "peer local projection must not be archived");

  const [migratedStorage] = await db
    .select({
      channelId: channels.id,
      serverKind: serversTable.kind,
      type: channels.type,
      deletedAt: channels.deletedAt,
    })
    .from(channels)
    .innerJoin(serversTable, eq(serversTable.id, channels.serverId))
    .where(eq(channels.id, migratedLegacyJoint.canonicalChannelId));
  assert.equal(migratedStorage.serverKind, "joint_storage", "new canonical channel should live in the storage namespace");
  assert.equal(migratedStorage.type, "channel", "new canonical storage channel should be an ordinary storage channel");
  assert.equal(migratedStorage.deletedAt, null);

  const [migratedMessage] = await db.select().from(messages).where(eq(messages.id, legacyMessage.id));
  assert.equal(migratedMessage.channelId, migratedLegacyJoint.canonicalChannelId, "existing messages should move to canonical storage");
  const [migratedAttachment] = await db.select().from(attachments).where(eq(attachments.id, legacyAttachment.id));
  assert.equal(migratedAttachment.channelId, migratedLegacyJoint.canonicalChannelId, "linked attachments should move with their canonical message");
  const persistedReactions = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, legacyMessage.id));
  assert.equal(persistedReactions.length, 1, "message-child reactions should stay attached by message id");
  const readCursors = await db
    .select()
    .from(userChannelReadCursors)
    .where(eq(userChannelReadCursors.userId, targetOwner.id));
  assert.equal(readCursors.find((cursor) => cursor.channelId === legacyTargetProjection.id)?.lastReadSeq, legacyMessage.seq - 1);

  const [stillArchivedJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, archivedJoint.id));
  const [stillArchivedHostProjection] = await db.select().from(channels).where(eq(channels.id, archivedHostProjection.id));
  assert.equal(stillArchivedJoint.status, "closed", "previously archived legacy joint rows must stay closed");
  assert.equal(
    stillArchivedJoint.canonicalChannelId,
    archivedHostProjection.id,
    "previously archived legacy rows must not be reopened or remapped",
  );
  assert.ok(stillArchivedHostProjection.deletedAt, "previously archived local projection should remain deleted");

  const [untouchedNewJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, newShapeJoint.id));
  const [untouchedStorage] = await db.select().from(channels).where(eq(channels.id, storageChannel.id));
  const [untouchedProjection] = await db.select().from(channels).where(eq(channels.id, newHostProjection.id));
  assert.equal(untouchedNewJoint.status, "active", "storage-only canonical rows should remain active");
  assert.equal(untouchedStorage.deletedAt, null, "new-shape storage channel must not be drained");
  assert.equal(untouchedProjection.deletedAt, null, "new-shape local projections must not be drained");

  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyHostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200, "host side should still read the migrated joint timeline");
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ id: string; channelId: string; content: string }> };
  assert.equal(hostMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyHostProjection.id);

  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyTargetProjection.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200, "peer side should still read the migrated joint timeline");
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ id: string; channelId: string; content: string }> };
  assert.equal(targetMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyTargetProjection.id);

  const targetReaction = await fetch(`${app.baseUrl}/api/messages/${legacyMessage.id}/reactions`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(targetReaction.status, 200, "peer side should be able to react to a migrated legacy message");
  const targetReactionBody = await targetReaction.json() as { channelId: string; reactions: Array<{ emoji: string; count: number }> };
  assert.equal(targetReactionBody.channelId, legacyTargetProjection.id);
  assert.equal(targetReactionBody.reactions.find((reaction) => reaction.emoji === "👍")?.count, 1);

  const attachmentUrl = await fetch(`${app.baseUrl}/api/attachments/${legacyAttachment.id}/url`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.ok(
    [200, 503].includes(attachmentUrl.status),
    `peer-side attachment URL should pass joint access before storage handling, got ${attachmentUrl.status}`,
  );
});


test("joint storage migration converts host-server canonical storage rows", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-host-storage-host@slock.test", "joint-host-storage-host");
  const targetOwner = await seedUser("joint-host-storage-target@slock.test", "joint-host-storage-target");
  const hostServer = await createServer("Joint Host Storage Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Host Storage Target", "joint-host-storage-target", targetOwner.id);

  const legacyStorage = await createChannel(hostServer.id, "legacy-host-storage", undefined, "joint");
  const legacyHostProjection = await createChannel(hostServer.id, "legacy-host-projection", undefined, "joint");
  const legacyTargetProjection = await createChannel(targetServer.id, "legacy-target-projection", undefined, "joint");
  await addHuman(legacyHostProjection.id, hostOwner.id);
  await addHuman(legacyTargetProjection.id, targetOwner.id);
  const [legacyJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: legacyStorage.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: legacyJoint.id,
      serverId: hostServer.id,
      localChannelId: legacyHostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: legacyJoint.id,
      serverId: targetServer.id,
      localChannelId: legacyTargetProjection.id,
      role: "participant",
      joinedByUserId: targetOwner.id,
    },
  ]);
  await fillJointMembersFromChannelHumans();
  const legacyMessage = await createMessage(
    legacyStorage.id,
    "user",
    hostOwner.id,
    "legacy host-server storage message survives migration",
  );
  await db.insert(messageReactions).values({
    messageId: legacyMessage.id,
    reactorType: "user",
    reactorId: hostOwner.id,
    emoji: "👀",
  });
  const [legacyAttachment] = await insertAttachmentsWithObjects(db, {
    messageId: legacyMessage.id,
    channelId: legacyStorage.id,
    uploaderId: hostOwner.id,
    uploaderType: "user",
    filename: "legacy-host-storage.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2345,
    storageKey: "test/legacy-host-storage.pdf",
  });

  const legacyThread = await getOrCreateThread(legacyMessage.id, hostOwner.id, "user");
  const legacyThreadReply = await createMessage(
    legacyThread.id,
    "user",
    targetOwner.id,
    "legacy host-server storage thread reply survives migration",
  );
  const [legacyThreadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: legacyThread.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  const [legacyHostThreadProjection] = await db.insert(channels).values({
    serverId: hostServer.id,
    name: `thread-${legacyMessage.id.slice(0, 8)}-host-projection`,
    type: "thread",
    parentMessageId: null,
  }).returning();
  const [legacyTargetThreadProjection] = await db.insert(channels).values({
    serverId: targetServer.id,
    name: `thread-${legacyMessage.id.slice(0, 8)}-target-projection`,
    type: "thread",
    parentMessageId: null,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: legacyThreadJoint.id,
      serverId: hostServer.id,
      localChannelId: legacyHostThreadProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: legacyThreadJoint.id,
      serverId: targetServer.id,
      localChannelId: legacyTargetThreadProjection.id,
      role: "participant",
      joinedByUserId: targetOwner.id,
    },
  ]);
  await fillJointMembersFromChannelHumans();

  const migrationSql = readFileSync(new URL("../../drizzle/0102_joint_storage_host_namespace_convert.sql", import.meta.url), "utf8");
  // 0102 is the one historic write that moved channels between servers; 0310
  // later made channels.server_id immutable (message_server_timeline copies it).
  // Replaying 0102 against today's schema needs that guard off. This test does
  // not read the timeline, so its rows for moved channels are left as they are.
  await db.execute(sql`ALTER TABLE channels DISABLE TRIGGER channels_server_id_immutable`);
  try {
    for (const statement of migrationSql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
      await db.execute(sql.raw(statement));
    }
  } finally {
    await db.execute(sql`ALTER TABLE channels ENABLE TRIGGER channels_server_id_immutable`);
  }

  const [migratedLegacyJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, legacyJoint.id));
  assert.equal(
    migratedLegacyJoint.canonicalChannelId,
    legacyStorage.id,
    "host-server canonical storage should keep its stable channel id",
  );
  const [migratedTopLevelStorage] = await db
    .select({
      channelId: channels.id,
      serverKind: serversTable.kind,
      type: channels.type,
    })
    .from(channels)
    .innerJoin(serversTable, eq(serversTable.id, channels.serverId))
    .where(eq(channels.id, migratedLegacyJoint.canonicalChannelId));
  assert.equal(migratedTopLevelStorage.serverKind, "joint_storage");
  assert.equal(migratedTopLevelStorage.type, "channel");

  const [migratedMessage] = await db.select().from(messages).where(eq(messages.id, legacyMessage.id));
  assert.equal(migratedMessage.channelId, legacyStorage.id, "legacy messages should keep their canonical storage id");
  const [migratedAttachment] = await db.select().from(attachments).where(eq(attachments.id, legacyAttachment.id));
  assert.equal(migratedAttachment.channelId, legacyStorage.id, "linked attachments should keep their canonical storage id");
  const existingReactions = await db.select().from(messageReactions).where(eq(messageReactions.messageId, legacyMessage.id));
  assert.equal(existingReactions.length, 1, "message reactions should stay attached by message id");

  const [migratedThreadJoint] = await db.select().from(jointChannels).where(eq(jointChannels.id, legacyThreadJoint.id));
  assert.equal(migratedThreadJoint.canonicalChannelId, legacyThread.id, "canonical joint thread should keep its stable channel id");
  const [migratedThreadStorage] = await db
    .select({
      channelId: channels.id,
      serverKind: serversTable.kind,
      type: channels.type,
      parentMessageId: channels.parentMessageId,
    })
    .from(channels)
    .innerJoin(serversTable, eq(serversTable.id, channels.serverId))
    .where(eq(channels.id, migratedThreadJoint.canonicalChannelId));
  assert.equal(migratedThreadStorage.serverKind, "joint_storage");
  assert.equal(migratedThreadStorage.type, "thread");
  assert.equal(migratedThreadStorage.parentMessageId, legacyMessage.id);
  const [migratedParentMessage] = await db.select().from(messages).where(eq(messages.id, legacyMessage.id));
  assert.equal(migratedParentMessage.threadId, legacyThread.id);
  const [migratedThreadReply] = await db.select().from(messages).where(eq(messages.id, legacyThreadReply.id));
  assert.equal(migratedThreadReply.channelId, legacyThread.id, "legacy replies should keep their canonical thread id");

  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyHostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200, "host side should read migrated host-server storage messages via projection");
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ id: string; channelId: string }> };
  assert.equal(hostMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyHostProjection.id);

  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyTargetProjection.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200, "peer side should read migrated host-server storage messages via projection");
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ id: string; channelId: string }> };
  assert.equal(targetMessagesBody.messages.find((message) => message.id === legacyMessage.id)?.channelId, legacyTargetProjection.id);

  const hostReaction = await fetch(`${app.baseUrl}/api/messages/${legacyMessage.id}/reactions`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(hostReaction.status, 200, "host side should be able to react to migrated legacy storage messages");
  const hostReactionBody = await hostReaction.json() as { channelId: string; reactions: Array<{ emoji: string; count: number }> };
  assert.equal(hostReactionBody.channelId, legacyHostProjection.id);
  assert.equal(hostReactionBody.reactions.find((reaction) => reaction.emoji === "👍")?.count, 1);

  const targetAttachmentUrl = await fetch(`${app.baseUrl}/api/attachments/${legacyAttachment.id}/url`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.ok(
    [200, 503].includes(targetAttachmentUrl.status),
    `peer-side attachment URL should pass joint access after host-storage migration, got ${targetAttachmentUrl.status}`,
  );

  const hostThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${legacyHostThreadProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostThreadMessages.status, 200, "host local thread projection should read migrated canonical replies");
  const hostThreadMessagesBody = await hostThreadMessages.json() as { messages: Array<{ id: string; channelId: string }> };
  assert.equal(
    hostThreadMessagesBody.messages.find((message) => message.id === legacyThreadReply.id)?.channelId,
    legacyHostThreadProjection.id,
  );
});


test("joint channel threads use per-server local thread projections over canonical storage", async ({ app }) => {

  const previousRisingWaveDatabaseUrl = process.env.RISINGWAVE_DATABASE_URL;
  try {
    const db = getDb();
    const hostOwner = await seedUser("joint-thread-host@slock.test", "joint-thread-host");
    const targetOwner = await seedUser("joint-thread-target@slock.test", "joint-thread-target");
    const targetMember = await seedUser("joint-thread-target-member@slock.test", "joint-thread-target-member");
    const hostServer = await createServer("Joint Thread Host", "botiverse", hostOwner.id);
    const targetServer = await createServer("Joint Thread Target", "joint-thread-target", targetOwner.id);
    await addMember(targetServer.id, targetMember.id, "member");
    const hostAgent = await createAgent(hostServer.id, "joint-thread-host-agent", { runtime: "codex" });
    const targetAgent = await createAgent(targetServer.id, "joint-thread-target-agent", { runtime: "codex" });
    const hostToken = await tokenForHuman(hostOwner.email);
    const targetToken = await tokenForHuman(targetOwner.email);
    const targetMemberToken = await tokenForHuman(targetMember.email);

    const createRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "threaded-partner-room",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [`@${targetOwner.name}`],
      }),
    });
    assert.equal(createRes.status, 200);
    const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

    const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(acceptRes.status, 200);
    const targetProjection = await acceptRes.json() as { id: string };
    await addAgent(hostProjection.id, hostAgent.id);
    await addAgent(targetProjection.id, targetAgent.id);
    const agentOrchestratorForMembers = app.app.get("agentOrchestrator") as {
      getActivity: (agentId: string, opts?: unknown) => Promise<{ activity: string; activityDetail: string }>;
    };
    const originalGetActivity = agentOrchestratorForMembers.getActivity.bind(agentOrchestratorForMembers);
    agentOrchestratorForMembers.getActivity = async (agentId, opts) => {
      if (agentId === hostAgent.id) {
        return { activity: "working", activityDetail: "Responding from host" };
      }
      return originalGetActivity(agentId, opts);
    };

    const targetMembers = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/members`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetMembers.status, 200);
    const targetMembersBody = await targetMembers.json() as { agents: Array<{ id: string; activity?: string; activityDetail?: string }> };
    const visibleHostAgent = targetMembersBody.agents.find((agent) => agent.id === hostAgent.id);
    assert.equal(
      visibleHostAgent?.activity,
      "working",
      "peer-side joint member list should include live activity for remote origin agents",
    );
    // Another server's agent: its state only, never its work summary
    // (as the joint rooms' `agent:activity` push, `detail: ""`).
    assert.equal(visibleHostAgent?.activityDetail, "");
    const [parentJointProjection] = await db
      .select({ jointChannelId: jointChannelServers.jointChannelId })
      .from(jointChannelServers)
      .where(eq(jointChannelServers.localChannelId, hostProjection.id));
    assert.ok(parentJointProjection, "host parent projection should resolve to the parent joint channel");

    const parentRes = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ channelId: hostProjection.id, content: "parent visible on both sides" }),
    });
    assert.equal(parentRes.status, 200);
    const parent = await parentRes.json() as { id: string };

    const deniedPermalink = await fetch(`${app.baseUrl}/api/messages/context/${parent.id}?channelId=${targetProjection.id}`, {
      headers: headers(targetMemberToken, targetServer.id),
    });
    assert.equal(deniedPermalink.status, 404, "joint permalink access for non-members should degrade to neutral not found");
    assert.deepEqual(await deniedPermalink.json(), { error: "Message not found" });

    const events = installFakeIo(app.app);
    const targetReaction = await fetch(`${app.baseUrl}/api/messages/${parent.id}/reactions`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(targetReaction.status, 200);
    const targetReactionBody = await targetReaction.json() as {
      channelId: string;
      reactions: Array<{ emoji: string; count: number; reactorIds: string[] }>;
    };
    assert.equal(
      targetReactionBody.channelId,
      targetProjection.id,
      "joint reaction response should expose the actor's local parent projection id",
    );
    assert.equal(targetReactionBody.reactions.find((reaction) => reaction.emoji === "👍")?.count, 1);
    assert.ok(
      events.some((event) => (
        event.room === `channel:${hostProjection.id}`
        && event.event === "message:updated"
        && (event.payload as any).channelId === hostProjection.id
        && (event.payload as any).reactions?.some((reaction: { emoji: string; count: number }) => reaction.emoji === "👍" && reaction.count === 1)
      )),
      "joint reaction update should fan out to the host projection room with the host local channel id",
    );
    assert.ok(
      events.some((event) => (
        event.room === `channel:${targetProjection.id}`
        && event.event === "message:updated"
        && (event.payload as any).channelId === targetProjection.id
        && (event.payload as any).reactions?.some((reaction: { emoji: string; count: number }) => reaction.emoji === "👍" && reaction.count === 1)
      )),
      "joint reaction update should fan out to the target projection room with the target local channel id",
    );

    const targetReactionRemove = await fetch(`${app.baseUrl}/api/messages/${parent.id}/reactions`, {
      method: "DELETE",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(targetReactionRemove.status, 200);
    const targetReactionRemoveBody = await targetReactionRemove.json() as { channelId: string; reactions: Array<{ emoji: string }> };
    assert.equal(targetReactionRemoveBody.channelId, targetProjection.id);
    assert.deepEqual(targetReactionRemoveBody.reactions, []);
    const persistedReactions = await db
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, parent.id));
    assert.deepEqual(persistedReactions, []);
    events.length = 0;

    const createThreadRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ parentMessageId: parent.id, content: "host thread reply" }),
    });
    assert.equal(createThreadRes.status, 200);
    const createdThread = await createThreadRes.json() as { threadChannelId: string; replyCount: number };
    assert.equal(createdThread.replyCount, 1);

    const [hostThreadProjection] = await db
      .select({
        jointThreadId: jointChannelServers.jointChannelId,
        canonicalThreadChannelId: jointChannels.canonicalChannelId,
      })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(eq(jointChannelServers.localChannelId, createdThread.threadChannelId));
    assert.ok(hostThreadProjection, "creating a joint thread should register a host local projection");
    assert.notEqual(
      hostThreadProjection.canonicalThreadChannelId,
      createdThread.threadChannelId,
      "thread API should return the local thread projection, not canonical storage",
    );

    const [targetThreadProjection] = await db
      .select({ localChannelId: jointChannelServers.localChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.jointChannelId, hostThreadProjection.jointThreadId),
        eq(jointChannelServers.serverId, targetServer.id),
      ));
    assert.ok(targetThreadProjection, "creating a joint thread should create the peer local thread projection");

    const hostThreadUpdate = events.find((event) => (
        event.room === `channel:${hostProjection.id}`
        && event.event === "thread:updated"
        && (event.payload as any).threadChannelId === createdThread.threadChannelId
      ));
    assert.ok(
      hostThreadUpdate,
      "host parent room should receive thread updates with the host local thread id",
    );
    assert.equal((hostThreadUpdate.payload as any).latestReply.content, "host thread reply");
    assert.equal((hostThreadUpdate.payload as any).latestReply.channelId, createdThread.threadChannelId);

    const targetThreadUpdate = events.find((event) => (
        event.room === `channel:${targetProjection.id}`
        && event.event === "thread:updated"
        && (event.payload as any).threadChannelId === targetThreadProjection.localChannelId
      ));
    assert.ok(
      targetThreadUpdate,
      "target parent room should receive thread updates with the target local thread id",
    );
    assert.equal((targetThreadUpdate.payload as any).latestReply.content, "host thread reply");
    assert.equal((targetThreadUpdate.payload as any).latestReply.channelId, targetThreadProjection.localChannelId);
    assert.ok(
      !events.some((event) => event.room === `channel:${hostThreadProjection.canonicalThreadChannelId}`),
      "canonical joint thread storage room must not be used for frontend socket delivery",
    );

    const hostParentMessages = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, {
      headers: headers(hostToken, hostServer.id),
    });
    assert.equal(hostParentMessages.status, 200);
    const hostParentMessagesBody = await hostParentMessages.json() as { messages: Array<{ id: string; threadId: string | null }> };
    assert.equal(
      hostParentMessagesBody.messages.find((message) => message.id === parent.id)?.threadId,
      createdThread.threadChannelId,
      "host parent timeline should expose the host local thread projection id",
    );

    const targetParentMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetProjection.id}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetParentMessages.status, 200);
    const targetParentMessagesBody = await targetParentMessages.json() as {
      messages: Array<{ id: string; threadId: string | null }>;
      messageWindow: { serverId: string; receiverId: string; scopeId: string; completeThroughLatest: boolean };
    };
    assert.equal(
      targetParentMessagesBody.messages.find((message) => message.id === parent.id)?.threadId,
      targetThreadProjection.localChannelId,
      "target parent timeline should expose the target local thread projection id",
    );
    assert.deepEqual(targetParentMessagesBody.messageWindow, {
      ...targetParentMessagesBody.messageWindow,
      serverId: targetServer.id,
      receiverId: targetOwner.id,
      scopeId: targetProjection.id,
      completeThroughLatest: true,
    });

    const targetSummaries = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetSummaries.status, 200);
    const targetSummariesBody = await targetSummaries.json() as Record<string, { threadChannelId: string; replyCount: number }>;
    assert.equal(
      targetSummariesBody[parent.id]?.threadChannelId,
      targetThreadProjection.localChannelId,
      "peer summaries should expose the peer local thread projection id",
    );

    const targetThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetThreadProjection.localChannelId}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetThreadMessages.status, 200);
    const targetThreadMessagesBody = await targetThreadMessages.json() as {
      messages: Array<{ channelId: string; content: string }>;
      messageWindow: { serverId: string; receiverId: string; scopeId: string; completeThroughLatest: boolean };
    };
    assert.ok(
      targetThreadMessagesBody.messages.some((message) => message.channelId === targetThreadProjection.localChannelId && message.content === "host thread reply"),
      "peer local thread projection should read canonical replies projected to its local id",
    );
    assert.deepEqual(targetThreadMessagesBody.messageWindow, {
      ...targetThreadMessagesBody.messageWindow,
      serverId: targetServer.id,
      receiverId: targetOwner.id,
      scopeId: targetThreadProjection.localChannelId,
      completeThroughLatest: true,
    });

    const deliveries: Array<{
      agentId: string;
      message: { channel_id?: string; parent_channel_id?: string; parent_channel_type?: string; content: string; thread_join_context?: unknown };
      options?: { adminAuthority?: boolean };
    }> = [];
    const agentOrchestrator = app.app.get("agentOrchestrator") as {
      deliverMessage: (
        agentId: string,
        message: { channel_id?: string; parent_channel_id?: string; parent_channel_type?: string; content: string; thread_join_context?: unknown },
        options?: { adminAuthority?: boolean },
      ) => Promise<void>;
    };
    agentOrchestrator.deliverMessage = async (agentId, message, options) => {
      deliveries.push({ agentId, message, options });
    };

    const mentionReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        channelId: createdThread.threadChannelId,
        content: `hello @${targetAgent.name} @${targetOwner.name}`,
        mentions: [
          { type: "agent", id: targetAgent.id, name: targetAgent.name },
          { type: "user", id: targetOwner.id, name: targetOwner.name },
        ],
      }),
    });
    assert.equal(mentionReply.status, 200);
    await mentionReply.json();
    const targetAgentMentionDelivery = deliveries.find((delivery) => (
      delivery.agentId === targetAgent.id
      && delivery.message.content === `hello @${targetAgent.name} @${targetOwner.name}`
    ));
    assert.ok(targetAgentMentionDelivery, "mentioning a peer projection agent in a joint thread should deliver to that agent");
    assert.equal(
      targetAgentMentionDelivery.message.channel_id,
      targetThreadProjection.localChannelId,
      "peer agent delivery should target the peer local thread projection id",
    );
    assert.equal(
      targetAgentMentionDelivery.message.parent_channel_id,
      targetProjection.id,
      "peer agent delivery should identify the peer local parent projection id",
    );
    assert.equal(targetAgentMentionDelivery.message.parent_channel_type, "joint");
    assert.ok(targetAgentMentionDelivery.message.thread_join_context, "first mention delivery should include thread join context");
    const [targetAgentFollow] = await db
      .select({ followerId: threadFollows.followerId })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, targetThreadProjection.localChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, targetAgent.id),
        isNull(threadFollows.unfollowedAt),
      ))
      .limit(1);
    assert.ok(targetAgentFollow, "peer agent follow should be recorded against the peer local thread projection");
    assert.ok(
      events.some((event) => (
        event.room === `user:${targetOwner.id}`
        && event.event === "message:new"
        && (event.payload as any).channelId === targetThreadProjection.localChannelId
        && (event.payload as any).content === `hello @${targetAgent.name} @${targetOwner.name}`
      )),
      "first joint thread mention should live-deliver to the peer mentioned human through their local thread projection",
    );

    await recordThreadFollow("agent", hostAgent.id, createdThread.threadChannelId, parent.id, "manual");
    const hostManagedRoster = await fetch(
      `${app.baseUrl}/api/channels/threads/followers?threadChannelIds=${createdThread.threadChannelId}`,
      { headers: headers(hostToken, hostServer.id) },
    );
    assert.equal(hostManagedRoster.status, 200);
    const hostManagedRosterBody = await hostManagedRoster.json() as {
      threads: Array<{
        threadChannelId: string;
        agents: Array<{
          id: string;
          name: string;
          serverId: string;
          serverName: string;
          serverSlug: string;
          isCurrentServer: boolean;
          canRemove: boolean;
        }>;
      }>;
    };
    const managedHostAgent = hostManagedRosterBody.threads[0]?.agents.find((agent) => agent.id === hostAgent.id);
    const managedTargetAgent = hostManagedRosterBody.threads[0]?.agents.find((agent) => agent.id === targetAgent.id);
    assert.equal(hostManagedRosterBody.threads[0]?.threadChannelId, createdThread.threadChannelId);
    assert.equal(managedHostAgent?.serverId, hostServer.id);
    assert.equal(managedHostAgent?.serverName, hostServer.name);
    assert.equal(managedHostAgent?.serverSlug, hostServer.slug);
    assert.equal(managedHostAgent?.isCurrentServer, true);
    assert.equal(managedHostAgent?.canRemove, true);
    assert.equal(managedTargetAgent?.serverId, targetServer.id);
    assert.equal(managedTargetAgent?.serverName, targetServer.name);
    assert.equal(managedTargetAgent?.serverSlug, targetServer.slug);
    assert.equal(managedTargetAgent?.isCurrentServer, false);
    // The host manages the joint: its owner may remove any server's Agent
    // follower (channels.threadFollowerManagement.api.test.ts covers the removal).
    assert.equal(managedTargetAgent?.canRemove, true, "the host manages any server's Agent followers");

    events.length = 0;
    const localFollowerRemove = await fetch(
      `${app.baseUrl}/api/channels/threads/${createdThread.threadChannelId}/followers/agents/${hostAgent.id}`,
      { method: "DELETE", headers: headers(hostToken, hostServer.id) },
    );
    assert.equal(localFollowerRemove.status, 200);
    const localFollowerRemoveBody = await localFollowerRemove.json() as { removed: boolean; undoToken: string | null };
    assert.equal(localFollowerRemoveBody.removed, true);
    assert.ok(localFollowerRemoveBody.undoToken);
    const localRemoveFollowerUpdates = events.filter((event) => event.event === "thread:followers-updated");
    assert.deepEqual(
      localRemoveFollowerUpdates.map((event) => event.room).sort(),
      [`channel:${createdThread.threadChannelId}`, `channel:${targetThreadProjection.localChannelId}`].sort(),
      "local follower changes in a joint thread must refresh every local projection room",
    );
    for (const event of localRemoveFollowerUpdates) {
      assert.deepEqual(
        Object.keys(event.payload as Record<string, unknown>).sort(),
        ["threadChannelId"],
        "follower-refresh payload must not expose agent, user, or server details",
      );
      assert.equal(
        (event.payload as { threadChannelId?: string }).threadChannelId,
        event.room === `channel:${createdThread.threadChannelId}`
          ? createdThread.threadChannelId
          : targetThreadProjection.localChannelId,
        "each room receives its own local thread projection id",
      );
    }
    assert.ok(
      !events.some((event) => event.room === `channel:${hostThreadProjection.canonicalThreadChannelId}`),
      "canonical joint thread storage room must not receive follower-refresh events",
    );
    const [removedHostAgentFollow] = await db
      .select({ unfollowedAt: threadFollows.unfollowedAt })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, createdThread.threadChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, hostAgent.id),
      ))
      .limit(1);
    assert.ok(removedHostAgentFollow?.unfollowedAt, "host-local Agent follower should still be removable");
    const [retainedTargetAgentFollow] = await db
      .select({ unfollowedAt: threadFollows.unfollowedAt })
      .from(threadFollows)
      .where(and(
        eq(threadFollows.threadChannelId, targetThreadProjection.localChannelId),
        eq(threadFollows.followerType, "agent"),
        eq(threadFollows.followerId, targetAgent.id),
      ))
      .limit(1);
    assert.equal(
      retainedTargetAgentFollow?.unfollowedAt ?? null,
      null,
      "failed peer removal must leave the peer local projection follow active",
    );

    const targetMentionInbox = await fetch(`${app.baseUrl}/api/channels/inbox?filter=mentions`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetMentionInbox.status, 200);
    const targetMentionInboxBody = await targetMentionInbox.json() as {
      items: Array<{ kind: string; threadChannelId?: string; parentChannelId?: string; unreadCount?: number; hasMention?: boolean }>;
    };
    const targetMentionThreadItem = targetMentionInboxBody.items.find((item) => item.threadChannelId === targetThreadProjection.localChannelId);
    assert.ok(targetMentionThreadItem, "joint local thread mentions should appear in Activity/Mentions through the local projection");
    assert.equal(targetMentionThreadItem.kind, "thread");
    assert.equal(targetMentionThreadItem.parentChannelId, targetProjection.id);
    assert.equal(targetMentionThreadItem.hasMention, true);
    assert.ok((targetMentionThreadItem.unreadCount ?? 0) > 0);

    deliveries.length = 0;
    events.length = 0;
    const followupReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ channelId: createdThread.threadChannelId, content: "ordinary joint thread follow-up" }),
    });
    assert.equal(followupReply.status, 200);
    const followupReplyBody = await followupReply.json() as { id: string; seq: number };
    const targetAgentFollowupDelivery = deliveries.find((delivery) => (
      delivery.agentId === targetAgent.id
      && delivery.message.content === "ordinary joint thread follow-up"
    ));
    assert.ok(targetAgentFollowupDelivery, "a peer agent that follows a joint thread should receive later ordinary replies");
    assert.equal(targetAgentFollowupDelivery.message.channel_id, targetThreadProjection.localChannelId);
    assert.equal(targetAgentFollowupDelivery.message.parent_channel_id, targetProjection.id);

    const targetAgentReadCredential = await mintAgentCredential({
      agentId: targetAgent.id,
      scopes: ["read"],
      name: "joint-thread-history-read",
      issuedVia: "computer",
      createdByUserId: null,
    });
    const targetThreadRef = encodeURIComponent(`#threaded-partner-room:${parent.id.slice(0, 8)}`);
    const targetAgentHistory = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${targetThreadRef}&limit=10`, {
      headers: { Authorization: `Bearer ${targetAgentReadCredential.apiKey}` },
    });
    assert.equal(targetAgentHistory.status, 200, "peer agent should read joint thread history via its local thread projection");
    const targetAgentHistoryBody = await targetAgentHistory.json() as {
      messages: Array<{ id: string; channelId: string; content: string }>;
    };
    assert.ok(
      targetAgentHistoryBody.messages.some((message) => (
        message.channelId === targetThreadProjection.localChannelId
        && message.content === "host thread reply"
      )),
      "peer agent history should include earlier canonical replies projected to the peer local thread id",
    );
    assert.ok(
      targetAgentHistoryBody.messages.some((message) => (
        message.channelId === targetThreadProjection.localChannelId
        && message.content === "ordinary joint thread follow-up"
      )),
      "peer agent history should include follow-up replies projected to the peer local thread id",
    );
    // Its projection has no parent message; the card is the reader's local channel.
    const targetProjectionRow = await getChannel(targetProjection.id);
    assert.ok(targetProjectionRow);
    assert.deepEqual(
      (targetAgentHistoryBody as { channel_card?: unknown }).channel_card,
      {
        id: targetProjection.id,
        name: targetProjectionRow.name,
        type: "joint",
        description: targetProjectionRow.description ?? null,
        archived: false,
      },
      "a joint thread read carries the card of the reader's local channel projection",
    );

    const targetAgentAroundHistory = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${targetThreadRef}&around=${followupReplyBody.id.slice(0, 8)}&limit=3`, {
      headers: { Authorization: `Bearer ${targetAgentReadCredential.apiKey}` },
    });
    assert.equal(targetAgentAroundHistory.status, 200, "peer agent history anchors should resolve against canonical joint thread storage");
    const targetAgentAroundHistoryBody = await targetAgentAroundHistory.json() as {
      messages: Array<{ id: string; channelId: string; content: string }>;
    };
    assert.ok(
      targetAgentAroundHistoryBody.messages.some((message) => (
        message.id === followupReplyBody.id
        && message.channelId === targetThreadProjection.localChannelId
        && message.content === "ordinary joint thread follow-up"
      )),
      "around=<short-id> should return the canonical reply projected to the peer local thread id",
    );
    assert.ok(
      events.some((event) => (
        event.room === `user:${targetOwner.id}`
        && event.event === "message:new"
        && (event.payload as any).channelId === targetThreadProjection.localChannelId
        && (event.payload as any).content === "ordinary joint thread follow-up"
      )),
      "peer human followers should receive live joint thread replies through their local thread projection",
    );

    const targetAllInbox = await fetch(`${app.baseUrl}/api/channels/inbox`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetAllInbox.status, 200);
    const targetAllInboxBody = await targetAllInbox.json() as {
      items: Array<{ kind: string; threadChannelId?: string; parentChannelId?: string }>;
    };
    const targetAllThreadItem = targetAllInboxBody.items.find((item) => item.threadChannelId === targetThreadProjection.localChannelId);
    assert.ok(targetAllThreadItem, "joint local threads should appear in all Activity through the local thread projection");
    assert.equal(targetAllThreadItem.kind, "thread");
    assert.equal(targetAllThreadItem.parentChannelId, targetProjection.id);

    // The RisingWave v1 unread/sidebar MVs do not yet understand joint
    // local-projection -> canonical-storage split. A configured RW env must
    // therefore fail closed to the inline Postgres path for those surfaces.
    process.env.RISINGWAVE_DATABASE_URL = "postgres://127.0.0.1:9/slock_rw_guard_should_not_connect";

    const targetUnread = await fetch(`${app.baseUrl}/api/channels/unread`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetUnread.status, 200);
    const targetUnreadBody = await targetUnread.json() as Record<string, number>;
    assert.ok(
      (targetUnreadBody[targetProjection.id] ?? 0) > 0,
      "peer reload unread counts should read top-level joint messages from canonical storage but return the peer parent projection id",
    );
    assert.ok(
      (targetUnreadBody[targetThreadProjection.localChannelId] ?? 0) > 0,
      "peer reload unread counts should read joint thread replies from canonical storage but return the peer local thread id",
    );

    // The peer's local thread projection has no parent message of its own; its
    // thread unread folds onto the peer's local joint channel, not the host's.
    const targetChannelSummary = await fetch(`${app.baseUrl}/api/channels/unread?summary=1`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetChannelSummary.status, 200);
    const targetChannelSummaryBody = await targetChannelSummary.json() as {
      channels: Record<string, { parentChannelId?: string }>;
      threadUnread: Record<string, { count: number; hasMention: boolean }>;
    };
    assert.equal(
      targetChannelSummaryBody.channels[targetThreadProjection.localChannelId]?.parentChannelId,
      targetProjection.id,
      "a joint local thread's parent is this server's projection of the joint channel",
    );
    assert.equal(targetChannelSummaryBody.threadUnread[targetProjection.id]?.count, 1);

    const targetUnreadSummary = await fetch(`${app.baseUrl}/api/servers/unread-summary`, {
      headers: { Authorization: `Bearer ${targetToken}` },
    });
    assert.equal(targetUnreadSummary.status, 200);
    const targetUnreadSummaryBody = await targetUnreadSummary.json() as Array<{ serverId: string; unreadCount: number }>;
    assert.ok(
      (targetUnreadSummaryBody.find((item) => item.serverId === targetServer.id)?.unreadCount ?? 0) > 0,
      "sidebar unread summary should count top-level joint projection unread from canonical storage",
    );

    const targetSummariesAfterUnread = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetSummariesAfterUnread.status, 200);
    const targetSummariesAfterUnreadBody = await targetSummariesAfterUnread.json() as Record<string, { threadChannelId: string; unreadCount: number; firstUnreadMessageId: string | null; participantIds: string[] }>;
    assert.equal(targetSummariesAfterUnreadBody[parent.id]?.threadChannelId, targetThreadProjection.localChannelId);
    assert.ok(
      targetSummariesAfterUnreadBody[parent.id]?.unreadCount > 0,
      "peer parent thread summary unread count should read canonical thread storage",
    );
    assert.ok(
      targetSummariesAfterUnreadBody[parent.id]?.firstUnreadMessageId,
      "peer parent thread summary first unread id should come from canonical thread storage",
    );
    assert.ok(
      targetSummariesAfterUnreadBody[parent.id]?.participantIds.includes(hostOwner.id),
      "peer parent thread summary participants should read canonical thread storage",
    );

    const targetReadAll = await fetch(`${app.baseUrl}/api/channels/inbox/read-all`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetReadAll.status, 200);
    const targetThreadCursorRows = await db
      .select({ lastReadSeq: userChannelReadCursors.lastReadSeq })
      .from(userChannelReadCursors)
      .where(and(
        eq(userChannelReadCursors.userId, targetOwner.id),
        eq(userChannelReadCursors.channelId, targetThreadProjection.localChannelId),
      ));
    assert.equal(targetThreadCursorRows.length, 1, "Activity mark-all should advance joint local thread cursors");
    assert.ok(targetThreadCursorRows[0].lastReadSeq >= followupReplyBody.seq);

    const targetUnreadAfterReadAll = await fetch(`${app.baseUrl}/api/channels/unread`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetUnreadAfterReadAll.status, 200);
    const targetUnreadAfterReadAllBody = await targetUnreadAfterReadAll.json() as Record<string, number>;
    assert.equal(targetUnreadAfterReadAllBody[targetProjection.id], undefined);
    assert.equal(targetUnreadAfterReadAllBody[targetThreadProjection.localChannelId], undefined);

    const targetReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ channelId: targetThreadProjection.localChannelId, content: "target thread reply" }),
    });
    assert.equal(targetReply.status, 200);
    const targetReplyBody = await targetReply.json() as { channelId: string };
    assert.equal(targetReplyBody.channelId, targetThreadProjection.localChannelId);

    const hostThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${createdThread.threadChannelId}`, {
      headers: headers(hostToken, hostServer.id),
    });
    assert.equal(hostThreadMessages.status, 200);
    const hostThreadMessagesBody = await hostThreadMessages.json() as { messages: Array<{ channelId: string; content: string; senderId: string; senderMembershipStatus?: string | null }> };
    assert.ok(
      hostThreadMessagesBody.messages.some((message) => message.channelId === createdThread.threadChannelId && message.content === "target thread reply"),
      "host local thread projection should read peer replies projected to its local id",
    );
    assert.ok(
      hostThreadMessagesBody.messages.some((message) => (
        message.content === "target thread reply"
        && message.senderId === targetOwner.id
        && message.senderMembershipStatus === "active"
      )),
      "peer human senders in joint thread replies should stay active through parent projection membership",
    );

    const targetCanonicalFetch = await fetch(`${app.baseUrl}/api/messages/channel/${hostThreadProjection.canonicalThreadChannelId}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(targetCanonicalFetch.status, 404, "peer server must not access canonical thread storage by id");
    const hostCanonicalFetch = await fetch(`${app.baseUrl}/api/messages/channel/${hostThreadProjection.canonicalThreadChannelId}`, {
      headers: headers(hostToken, hostServer.id),
    });
    assert.equal(hostCanonicalFetch.status, 404, "host server must not use canonical thread storage as a routable thread surface");

    events.length = 0;
    const targetUnfollow = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ threadChannelId: targetThreadProjection.localChannelId }),
    });
    assert.equal(targetUnfollow.status, 200);
    const targetUnfollowFollowerUpdates = events.filter((event) => event.event === "thread:followers-updated");
    assert.deepEqual(
      targetUnfollowFollowerUpdates.map((event) => event.room).sort(),
      [`channel:${createdThread.threadChannelId}`, `channel:${targetThreadProjection.localChannelId}`].sort(),
      "peer-side unfollow must refresh already-open rosters without waiting for another thread message",
    );
    assert.ok(
      targetUnfollowFollowerUpdates.every((event) => (
        Object.keys(event.payload as Record<string, unknown>).length === 1
        && typeof (event.payload as { threadChannelId?: unknown }).threadChannelId === "string"
      )),
      "peer-side unfollow refresh payload stays scoped to local thread ids only",
    );
    const targetSuppression = await db.select().from(inboxSuppressionStates)
      .where(and(
        eq(inboxSuppressionStates.receiverId, targetOwner.id),
        eq(inboxSuppressionStates.targetKind, "public_thread_mention"),
        eq(inboxSuppressionStates.targetChannelId, targetThreadProjection.localChannelId),
      ));
    assert.equal(targetSuppression.length, 1, "joint unfollow must persist the local projection boundary");
    assert.ok((targetSuppression[0]?.doneThroughSeq ?? 0) > 0);

    const targetPreBoundSearch = await fetch(
      `${app.baseUrl}/api/channels/inbox/unfollowed?limit=10&q=host%20thread%20reply`,
      { headers: headers(targetToken, targetServer.id) },
    );
    assert.equal(targetPreBoundSearch.status, 200);
    const targetPreBoundSearchBody = await targetPreBoundSearch.json() as {
      items: Array<{ threadChannelId?: string }>;
    };
    assert.ok(
      targetPreBoundSearchBody.items.some((item) => item.threadChannelId === targetThreadProjection.localChannelId),
      "joint unfollowed search must include canonical replies at or before the durable boundary",
    );

    const jointPostBoundReply = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ channelId: createdThread.threadChannelId, content: "joint-post-bound-search-token" }),
    });
    assert.equal(jointPostBoundReply.status, 200);

    const targetPostBoundSearch = await fetch(
      `${app.baseUrl}/api/channels/inbox/unfollowed?limit=10&q=joint-post-bound-search-token`,
      { headers: headers(targetToken, targetServer.id) },
    );
    assert.equal(targetPostBoundSearch.status, 200);
    const targetPostBoundSearchBody = await targetPostBoundSearch.json() as {
      items: Array<{ threadChannelId?: string }>;
    };
    assert.equal(
      targetPostBoundSearchBody.items.some((item) => item.threadChannelId === targetThreadProjection.localChannelId),
      false,
      "post-bound canonical replies must not change joint unfollowed-search membership",
    );
  } finally {
    if (previousRisingWaveDatabaseUrl === undefined) {
      delete process.env.RISINGWAVE_DATABASE_URL;
    } else {
      process.env.RISINGWAVE_DATABASE_URL = previousRisingWaveDatabaseUrl;
    }
    await app.close();
  }
});


test("joint channel peer-side top-level sends use the sender projection authority for agent delivery", async ({ app }) => {
  const hostOwner = await seedUser("joint-peer-delivery-host@slock.test", "joint-peer-delivery-host");
  const targetOwner = await seedUser("joint-peer-delivery-target@slock.test", "joint-peer-delivery-target");
  const hostServer = await createServer("Joint Peer Delivery Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Peer Delivery Target", "joint-peer-delivery-target", targetOwner.id);
  const hostAgent = await createAgent(hostServer.id, "joint-peer-delivery-host-agent", { runtime: "codex" });
  const targetAgent = await createAgent(targetServer.id, "joint-peer-delivery-target-agent", { runtime: "codex" });
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "peer-delivery-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(targetProjection.id, targetAgent.id);

  const deliveries: Array<{
    agentId: string;
    message: { channel_id?: string; content: string };
    options?: { adminAuthority?: boolean };
  }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    deliverMessage: (
      agentId: string,
      message: { channel_id?: string; content: string },
      options?: { adminAuthority?: boolean },
    ) => Promise<void>;
  };
  agentOrchestrator.deliverMessage = async (agentId, message, options) => {
    deliveries.push({ agentId, message, options });
  };

  const peerTopLevelMention = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
    body: JSON.stringify({
      channelId: targetProjection.id,
      content: `peer top-level hello @${hostAgent.name}`,
      mentions: [
        { type: "agent", id: hostAgent.id, name: hostAgent.name },
      ],
    }),
  });
  assert.equal(peerTopLevelMention.status, 200);
  await peerTopLevelMention.json();

  const hostAgentDelivery = deliveries.find((delivery) => (
    delivery.agentId === hostAgent.id
    && delivery.message.content === `peer top-level hello @${hostAgent.name}`
  ));
  assert.ok(hostAgentDelivery, "peer-side joint top-level mention should deliver to host-side agents");
  assert.equal(
    hostAgentDelivery.message.channel_id,
    hostProjection.id,
    "host agent delivery should target the host local joint projection id",
  );
  assert.equal(
    hostAgentDelivery.options?.adminAuthority,
    true,
    "peer-side owner/admin sends should use the sender's local projection authority instead of canonical storage server authority",
  );
  assert.equal(
    typeof (hostAgentDelivery.options as { mentionDeliveryOccurrenceId?: unknown } | undefined)?.mentionDeliveryOccurrenceId,
    "string",
    "a joint mention delivery carries its durable occurrence id",
  );

  deliveries.length = 0;
  const hostTopLevelMention = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      channelId: hostProjection.id,
      content: `host top-level hello @${targetAgent.name}`,
      mentions: [
        { type: "agent", id: targetAgent.id, name: targetAgent.name },
      ],
    }),
  });
  assert.equal(hostTopLevelMention.status, 200);
  await hostTopLevelMention.json();

  const targetAgentDelivery = deliveries.find((delivery) => (
    delivery.agentId === targetAgent.id
    && delivery.message.content === `host top-level hello @${targetAgent.name}`
  ));
  assert.ok(targetAgentDelivery, "host-side joint top-level mention should deliver to peer-side agents");
  assert.equal(
    targetAgentDelivery.message.channel_id,
    targetProjection.id,
    "peer agent delivery should target the peer local joint projection id",
  );
  assert.equal(
    targetAgentDelivery.options?.adminAuthority,
    true,
    "host-side owner/admin sends should use the sender's local projection authority instead of canonical storage server authority",
  );
  assert.equal(
    typeof (targetAgentDelivery.options as { mentionDeliveryOccurrenceId?: unknown } | undefined)?.mentionDeliveryOccurrenceId,
    "string",
    "a joint mention delivery carries its durable occurrence id",
  );
});


test("late joint invite accept backfills existing local thread projections for the second server", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-thread-backfill-host@slock.test", "joint-thread-backfill-host");
  const targetOwner = await seedUser("joint-thread-backfill-target@slock.test", "joint-thread-backfill-target");
  const hostServer = await createServer("Joint Thread Backfill Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Thread Backfill Target", "joint-thread-backfill-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "thread-backfill-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const [parentJointProjection] = await db
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(eq(jointChannelServers.localChannelId, hostProjection.id));
  assert.ok(parentJointProjection, "host parent projection should resolve to the parent joint channel");

  const parentRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ channelId: hostProjection.id, content: "parent before second server accepts" }),
  });
  assert.equal(parentRes.status, 200);
  const parent = await parentRes.json() as { id: string };

  const createThreadRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ parentMessageId: parent.id, content: "thread before second server accepts" }),
  });
  assert.equal(createThreadRes.status, 200);
  const createdThread = await createThreadRes.json() as { threadChannelId: string };
  const [hostThreadProjection] = await db
    .select({ jointThreadId: jointChannelServers.jointChannelId })
    .from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, createdThread.threadChannelId));
  assert.ok(hostThreadProjection, "host thread projection should exist before peer accept");

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  const [targetThreadProjection] = await db
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, hostThreadProjection.jointThreadId),
      eq(jointChannelServers.serverId, targetServer.id),
    ));
  assert.ok(targetThreadProjection, "second server accept should backfill local projections for existing joint threads");
  // One audit event for the channel's connection, on the host; none for the thread copy it backfilled.
  const connectedAudit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_connected"));
  assert.deepEqual(
    connectedAudit.map((row) => ({ serverId: row.serverId, mode: row.metadata.mode, jointChannelId: row.metadata.jointChannelId, channelId: row.metadata.channelId, connectedServerId: row.metadata.connectedServerId })),
    [{ serverId: hostServer.id, mode: "joint_invite", jointChannelId: parentJointProjection.jointChannelId, channelId: hostProjection.id, connectedServerId: targetServer.id }],
  );

  const targetSummaries = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetSummaries.status, 200);
  const targetSummariesBody = await targetSummaries.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  assert.equal(
    targetSummariesBody[parent.id]?.threadChannelId,
    targetThreadProjection.localChannelId,
    "second server summaries should expose the backfilled local thread projection id",
  );
  const targetThreadMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetThreadProjection.localChannelId}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetThreadMessages.status, 200);
  const targetThreadMessagesBody = await targetThreadMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(
    targetThreadMessagesBody.messages.some((message) => (
      message.channelId === targetThreadProjection.localChannelId
      && message.content === "thread before second server accepts"
    )),
    "second server should read existing canonical thread replies through its local projection",
  );

  // The second server disconnects itself: its thread copy goes with the channel's, and the
  // disconnection is one audit event per server (byHost: false), none for the thread.
  const disconnectRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/disconnect`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(disconnectRes.status, 200, await disconnectRes.clone().text());
  const [threadCopyAfter] = await db.select({ status: jointChannelServers.status }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, targetThreadProjection.localChannelId));
  assert.equal(threadCopyAfter?.status, "disconnected", "the thread copy went with the channel");
  const disconnectedAudit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_disconnected"));
  assert.deepEqual(
    disconnectedAudit.map((row) => ({ serverId: String(row.serverId), byHost: row.metadata.byHost, jointChannelId: row.metadata.jointChannelId, channelId: row.metadata.channelId, disconnectedServerId: row.metadata.disconnectedServerId }))
      .sort((a, b) => a.serverId.localeCompare(b.serverId)),
    [
      { serverId: hostServer.id, byHost: false, jointChannelId: parentJointProjection.jointChannelId, channelId: hostProjection.id, disconnectedServerId: targetServer.id },
      { serverId: targetServer.id, byHost: false, jointChannelId: parentJointProjection.jointChannelId, channelId: targetProjection.id, disconnectedServerId: targetServer.id },
    ].sort((a, b) => a.serverId.localeCompare(b.serverId)),
  );
});


test("joint channel invites can add a third active server to the shared canonical stream", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-three-host@slock.test", "joint-three-host");
  const targetOwner = await seedUser("joint-three-target@slock.test", "joint-three-target");
  const thirdOwner = await seedUser("joint-three-third@slock.test", "joint-three-third");
  const fourthOwner = await seedUser("joint-three-fourth@slock.test", "joint-three-fourth");
  const hostServer = await createServer("Joint Three Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Three Target", "joint-three-target", targetOwner.id);
  const thirdServer = await createServer("Joint Three Third", "joint-three-third", thirdOwner.id);
  const fourthServer = await createServer("Joint Three Fourth", "joint-three-fourth", fourthOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const thirdToken = await tokenForHuman(thirdOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "three-server-room",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };

  const acceptTargetRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptTargetRes.status, 200);
  const targetProjection = await acceptTargetRes.json() as { id: string };

  const oversizedInviteesRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
    body: JSON.stringify({
      targetServerSlug: thirdServer.slug,
      invitedPeople: Array.from({ length: MAX_JOINT_CHANNEL_INVITED_PEOPLE_PER_TARGET + 1 }, (_, index) => `person-${index}@slock.test`),
    }),
  });
  assert.equal(oversizedInviteesRes.status, 400);
  const oversizedInviteesBody = await oversizedInviteesRes.json() as { error: string };
  assert.match(oversizedInviteesBody.error, /maximum of 20 invited people/);

  // Only the host invites servers (computed joint membership).
  const inviteThirdRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      targetServerSlug: thirdServer.slug,
      invitedPeople: [`@${thirdOwner.name}`],
    }),
  });
  assert.equal(inviteThirdRes.status, 200);
  const targetAfterInvite = await inviteThirdRes.json() as {
    id: string;
    jointInvite: { id: string; toServerId: string; invitedUserId: string };
    jointServers: Array<{ serverId: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
    jointPendingInvites: Array<{ fromServerId: string; toServerId: string; invitedUserId: string; status: "pending" }>;
  };
  assert.equal(targetAfterInvite.id, hostProjection.id);
  assert.equal(targetAfterInvite.jointInvite.toServerId, thirdServer.id);
  assert.equal(targetAfterInvite.jointInvite.invitedUserId, thirdOwner.id);
  assert.ok(targetAfterInvite.jointServers.some((server) => server.serverId === thirdServer.id && server.status === "pending"));
  assert.ok(targetAfterInvite.jointPendingInvites.some((invite) => invite.fromServerId === hostServer.id && invite.toServerId === thirdServer.id && invite.invitedUserId === thirdOwner.id));

  const acceptThirdRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${targetAfterInvite.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(thirdToken, thirdServer.id),
  });
  assert.equal(acceptThirdRes.status, 200);
  const thirdProjection = await acceptThirdRes.json() as {
    id: string;
    jointServers: Array<{ serverId: string; status: "active" | "pending"; isCurrentServer?: boolean }>;
  };
  assert.ok(thirdProjection.jointServers.some((server) => server.serverId === thirdServer.id && server.status === "active" && server.isCurrentServer));

  const projectionRows = await db
    .select({ jointChannelId: jointChannelServers.jointChannelId, localChannelId: jointChannelServers.localChannelId, serverId: jointChannelServers.serverId })
    .from(jointChannelServers)
    .where(eq(jointChannelServers.status, "active"));
  const parentJointIds = projectionRows
    .filter((row) => [hostProjection.id, targetProjection.id, thirdProjection.id].includes(row.localChannelId))
    .map((row) => row.jointChannelId);
  assert.equal(new Set(parentJointIds).size, 1, "all three local projections should point at the same joint channel");

  for (const [token, server, channelId, currentServerId] of [
    [hostToken, hostServer, hostProjection.id, hostServer.id],
    [targetToken, targetServer, targetProjection.id, targetServer.id],
    [thirdToken, thirdServer, thirdProjection.id, thirdServer.id],
  ] as const) {
    const listRes = await fetch(`${app.baseUrl}/api/channels/${channelId}`, {
      headers: headers(token, server.id),
    });
    assert.equal(listRes.status, 200);
    const channel = await listRes.json() as {
      jointServers: Array<{ serverId: string; status: "active"; isCurrentServer?: boolean }>;
      jointPendingInvites: unknown[];
    };
    assert.deepEqual(
      channel.jointServers.map((jointServer) => jointServer.serverId).sort(),
      [hostServer.id, targetServer.id, thirdServer.id].sort(),
    );
    assert.ok(channel.jointServers.every((jointServer) => jointServer.status === "active"));
    assert.ok(channel.jointServers.some((jointServer) => jointServer.serverId === currentServerId && jointServer.isCurrentServer));
    assert.deepEqual(channel.jointPendingInvites, []);
  }

  const hostAgent = await createAgent(hostServer.id, "joint-three-host-agent", { runtime: "codex" });
  const targetAgent = await createAgent(targetServer.id, "joint-three-target-agent", { runtime: "codex" });
  const thirdAgent = await createAgent(thirdServer.id, "joint-three-third-agent", { runtime: "codex" });
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(targetProjection.id, targetAgent.id);
  await addAgent(thirdProjection.id, thirdAgent.id);

  assert.deepEqual(
    (await listJointActivityProjectionChannelIdsForAgent(thirdAgent.id, thirdServer.id)).sort(),
    [hostProjection.id, targetProjection.id].sort(),
    "third-server agent activity should fan out to the first two local projection channel rooms",
  );

  for (const [token, server, channelId] of [
    [hostToken, hostServer, hostProjection.id],
    [targetToken, targetServer, targetProjection.id],
    [thirdToken, thirdServer, thirdProjection.id],
  ] as const) {
    const membersRes = await fetch(`${app.baseUrl}/api/channels/${channelId}/members`, {
      headers: headers(token, server.id),
    });
    assert.equal(membersRes.status, 200);
    const membersBody = await membersRes.json() as { agents: Array<{ id: string }> };
    assert.deepEqual(
      membersBody.agents.map((agent) => agent.id).sort(),
      [hostAgent.id, targetAgent.id, thirdAgent.id].sort(),
      "three-server joint member lists should include agents from every active projection",
    );
  }

  const inviteFourthRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      targetServerSlug: fourthServer.slug,
      invitedPeople: [`@${fourthOwner.name}`],
    }),
  });
  // Contract v0.3 §18.6: up to 30 servers; these fixture servers are paid,
  // so a fourth server is now admitted.
  assert.equal(inviteFourthRes.status, 200);

  const thirdMessage = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(thirdToken, thirdServer.id),
    body: JSON.stringify({ channelId: thirdProjection.id, content: "hello from third server" }),
  });
  assert.equal(thirdMessage.status, 200);
  const hostMessages = await fetch(`${app.baseUrl}/api/messages/channel/${hostProjection.id}`, {
    headers: headers(hostToken, hostServer.id),
  });
  assert.equal(hostMessages.status, 200);
  const hostMessagesBody = await hostMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(hostMessagesBody.messages.some((message) => message.channelId === hostProjection.id && message.content === "hello from third server"));
  const targetMessages = await fetch(`${app.baseUrl}/api/messages/channel/${targetProjection.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetMessages.status, 200);
  const targetMessagesBody = await targetMessages.json() as { messages: Array<{ channelId: string; content: string }> };
  assert.ok(targetMessagesBody.messages.some((message) => message.channelId === targetProjection.id && message.content === "hello from third server"));
});


test("joint channel create requires an invite server slug", async ({ app }) => {
  const owner = await seedUser("joint-required-host@slock.test", "joint-required-host");
  const server = await createServer("Joint Required Host", "joint-required-host", owner.id);
  const token = await tokenForHuman(owner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({
      name: "missing-server",
      visibility: "joint",
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string };
  assert.equal(body.error, "Invite server slug is required");
});


test("joint channel create requires at least one invited person", async ({ app }) => {
  const hostOwner = await seedUser("joint-required-person-host@slock.test", "joint-required-person-host");
  const targetOwner = await seedUser("joint-required-person-target@slock.test", "joint-required-person-target");
  const hostServer = await createServer("Joint Required Person Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Required Person Target", "joint-required-person-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "missing-person",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string };
  assert.equal(body.error, "At least one invited person is required");
});


test("joint channel create rejects missing target invitees before writing joint rows", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-missing-invitee-host@slock.test", "joint-missing-invitee-host");
  const targetOwner = await seedUser("joint-missing-invitee-target@slock.test", "joint-missing-invitee-target");
  const hostServer = await createServer("Joint Missing Invitee Host", "joint-missing-invitee-host", hostOwner.id);
  const targetServer = await createServer("Joint Missing Invitee Target", "joint-missing-invitee-target", targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "missing-invitee-blocked",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: ["wrong-email@slock.test"],
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string; code?: string; targetServerSlug?: string; invitee?: string; inviteeIndex?: number };
  assert.equal(body.code, "joint_invitee_unavailable");
  assert.match(body.error, /Cannot invite wrong-email@slock\.test/);
  assert.equal(body.targetServerSlug, targetServer.slug);
  assert.equal(body.invitee, "wrong-email@slock.test");
  assert.equal(body.inviteeIndex, 0);
  assert.equal(
    (await db.select({ id: channels.id }).from(channels).where(and(
      eq(channels.serverId, hostServer.id),
      eq(channels.name, "missing-invitee-blocked"),
      isNull(channels.deletedAt),
    ))).length,
    0,
    "validation failure must not create the host projection",
  );
  assert.equal(
    (await db.select({ id: jointChannels.id }).from(jointChannels).where(eq(jointChannels.createdByServerId, hostServer.id))).length,
    0,
    "validation failure must not create joint authority rows",
  );
  assert.equal(
    (await db.select({ id: jointChannelInvites.id }).from(jointChannelInvites).where(eq(jointChannelInvites.fromServerId, hostServer.id))).length,
    0,
    "validation failure must not create pending invite rows",
  );
});


test("joint channel invitee errors carry the invitee itself, independent of the deduped index", async ({ app }) => {
  const hostOwner = await seedUser("joint-invitee-field-host@slock.test", "joint-invitee-field-host");
  const targetOwner = await seedUser("joint-invitee-field-target@slock.test", "joint-invitee-field-target");
  const dupeAdmin = await seedUser("dupe@slock.test", "dupe");
  const hostServer = await createServer("Joint Invitee Field Host", "joint-invitee-field-host", hostOwner.id);
  const targetServer = await createServer("Joint Invitee Field Target", "joint-invitee-field-target", targetOwner.id);
  await addMember(targetServer.id, dupeAdmin.id, "admin");
  const hostToken = await tokenForHuman(hostOwner.email);

  // The server dedupes case-insensitively, so "DUPE@slock.test" merges into
  // "dupe@slock.test" and the failure lands at index 1 of the deduped list —
  // index 2 of what the client submitted. `invitee` names the rejected person
  // regardless, which is why clients must read it instead of the index.
  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "invitee-field-blocked",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: ["dupe@slock.test", "DUPE@slock.test", "ghost@slock.test"],
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string; code?: string; targetServerSlug?: string; invitee?: string; inviteeIndex?: number };
  assert.equal(body.code, "joint_invitee_unavailable");
  assert.equal(body.targetServerSlug, targetServer.slug);
  assert.equal(body.invitee, "ghost@slock.test");
  assert.equal(body.inviteeIndex, 1, "index refers to the server's deduplicated list, not the submitted one");
});


test("joint channel create only allows target server admins as invited people", async ({ app }) => {
  const db = getDb();
  const hostOwner = await seedUser("joint-admin-only-host@slock.test", "joint-admin-only-host");
  const targetOwner = await seedUser("joint-admin-only-target-owner@slock.test", "joint-admin-only-target-owner");
  const targetMember = await seedUser("joint-admin-only-target-member@slock.test", "joint-admin-only-target-member");
  const hostServer = await createServer("Joint Admin Only Host", "botiverse", hostOwner.id);
  const targetServer = await createServer("Joint Admin Only Target", "joint-admin-only-target", targetOwner.id);
  await addMember(targetServer.id, targetMember.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "member-invite-blocked",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [targetMember.email],
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string; code?: string; targetServerSlug?: string; invitee?: string; inviteeIndex?: number };
  assert.equal(body.code, "joint_invitee_unavailable");
  assert.match(body.error, /owner or admin of the target server/);
  assert.equal(body.targetServerSlug, targetServer.slug);
  assert.equal(body.invitee, targetMember.email);
  assert.equal(body.inviteeIndex, 0);

  // A member and an unknown address get the same answer, so an inviter on
  // another server cannot tell whether an email belongs to the target's members.
  const unknownRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "member-invite-blocked",
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: ["nobody-here@slock.test"],
    }),
  });
  assert.equal(unknownRes.status, createRes.status);
  const unknownBody = await unknownRes.json() as typeof body;
  const withoutInvitee = (value: typeof body) => ({ ...value, invitee: undefined, error: value.error.replace(value.invitee ?? "", "<invitee>") });
  assert.deepEqual(withoutInvitee(unknownBody), withoutInvitee(body));
  assert.equal(
    (await db.select({ id: channels.id }).from(channels).where(and(
      eq(channels.serverId, hostServer.id),
      eq(channels.name, "member-invite-blocked"),
      isNull(channels.deletedAt),
    ))).length,
    0,
    "non-admin validation failure must not create the host projection",
  );
  assert.equal(
    (await db.select({ id: jointChannels.id }).from(jointChannels).where(eq(jointChannels.createdByServerId, hostServer.id))).length,
    0,
    "non-admin validation failure must not create joint authority rows",
  );
  assert.equal(
    (await db.select({ id: jointChannelInvites.id }).from(jointChannelInvites).where(eq(jointChannelInvites.fromServerId, hostServer.id))).length,
    0,
    "non-admin validation failure must not create pending invite rows",
  );
});


test("joint channel create rejects invalid target servers with a stable code", async ({ app }) => {
  const hostOwner = await seedUser("joint-invalid-target-host@slock.test", "joint-invalid-target-host");
  const hostServer = await createServer("Joint Invalid Target Host", "joint-invalid-target-host", hostOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "invalid-target-blocked",
      visibility: "joint",
      targetServerSlug: "missing-target-server",
      invitedPeople: ["admin@slock.test"],
    }),
  });
  assert.equal(createRes.status, 400);
  const body = await createRes.json() as { error: string; code?: string; targetServerSlug?: string };
  assert.equal(body.code, "joint_target_server_invalid");
  assert.equal(body.error, "Target server not found");
  assert.equal(body.targetServerSlug, "missing-target-server");
});


test("joint channel create permanently allows one Free channel and Pro channels after upgrade", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, clock: { now: () => new Date("2040-01-01T00:00:00Z") } });
  try {
    const hostOwner = await seedUser("joint-pro-host@slock.test", "joint-pro-host");
    const targetOwner = await seedUser("joint-pro-target@slock.test", "joint-pro-target");
    const hostServer = await createServer("Joint Pro Host", "joint-pro-host", hostOwner.id);
    const targetServer = await createServer("Joint Pro Target", "joint-pro-target", targetOwner.id);
    // Exercise the permanent Free allowance: createServer defaults to founder.
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, hostServer.id));
    const hostToken = await tokenForHuman(hostOwner.email);

    const trialAllowedRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "free-allowed-joint",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email],
      }),
    });
    assert.equal(trialAllowedRes.status, 200);

    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, hostServer.id));

    const allowedRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "allowed-joint",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email],
      }),
    });
    assert.equal(allowedRes.status, 200);
  } finally {
    await app.close();
  }
});


test("a Free host whose joint another server joined gets a stable 403 on accept, invite and create, naming the joint", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, clock: { now: () => new Date("2040-01-01T00:00:00Z") } });
  try {
    const hostOwner = await seedUser("joint-free-host@slock.test", "joint-free-host");
    const xOwner = await seedUser("joint-free-x@slock.test", "joint-free-x");
    const yOwner = await seedUser("joint-free-y@slock.test", "joint-free-y");
    const hostServer = await createServer("Joint Free Host", "joint-free-host", hostOwner.id);
    const xServer = await createServer("Joint Free X", "joint-free-x", xOwner.id);
    const yServer = await createServer("Joint Free Y", "joint-free-y", yOwner.id);
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, hostServer.id));
    const hostToken = await tokenForHuman(hostOwner.email);
    const create = (name: string, target: { slug: string }, invitee: string) => fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ name, visibility: "joint", targetServerSlug: target.slug, invitedPeople: [invitee] }),
    });
    const acceptAs = (inviteId: string, token: string, serverId: string) => fetch(`${app.baseUrl}/api/channels/joint-invites/${inviteId}/accept`, {
      method: "POST",
      headers: headers(token, serverId),
    });

    // Two joints with pending invites: neither uses the slot.
    const aRes = await create("free-joint-a", xServer, xOwner.email);
    const bRes = await create("free-joint-b", yServer, yOwner.email);
    assert.equal(aRes.status, 200);
    assert.equal(bRes.status, 200);
    const a = await aRes.json() as { id: string; jointInvite: { id: string } };
    const b = await bRes.json() as { id: string; jointInvite: { id: string } };

    assert.equal((await acceptAs(a.jointInvite.id, await tokenForHuman(xOwner.email), xServer.id)).status, 200);

    const acceptB = await acceptAs(b.jointInvite.id, await tokenForHuman(yOwner.email), yServer.id);
    assert.equal(acceptB.status, 403);
    assert.equal((await acceptB.json() as { code?: string }).code, "joint_channel_free_limit_reached");

    const inviteFromB = await fetch(`${app.baseUrl}/api/channels/${b.id}/joint-invites`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ targetServerSlug: xServer.slug, invitedPeople: [xOwner.email] }),
    });
    assert.equal(inviteFromB.status, 403);
    const inviteBody = await inviteFromB.json() as { code?: string; blockingChannel?: { name: string } };
    assert.equal(inviteBody.code, "joint_channel_free_limit_reached");
    assert.deepEqual(inviteBody.blockingChannel, { name: "free-joint-a" });

    const createC = await create("free-joint-c", yServer, yOwner.email);
    assert.equal(createC.status, 403);
    const createBody = await createC.json() as { code?: string; blockingChannel?: { name: string } };
    assert.equal(createBody.code, "joint_channel_free_limit_reached");
    assert.deepEqual(createBody.blockingChannel, { name: "free-joint-a" });
  } finally {
    await app.close();
  }
});


test("concurrent invites from two participant servers cannot push a joint past two free servers", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, clock: { now: () => new Date("2040-01-01T00:00:00Z") } });
  try {
    const hostOwner = await seedUser("joint-race-host@slock.test", "joint-race-host");
    const paidOwner = await seedUser("joint-race-paid@slock.test", "joint-race-paid");
    const freeXOwner = await seedUser("joint-race-free-x@slock.test", "joint-race-free-x");
    const freeYOwner = await seedUser("joint-race-free-y@slock.test", "joint-race-free-y");
    const hostServer = await createServer("Joint Race Host", "joint-race-host", hostOwner.id);
    const paidServer = await createServer("Joint Race Paid", "joint-race-paid", paidOwner.id);
    const freeXServer = await createServer("Joint Race Free X", "joint-race-free-x", freeXOwner.id);
    const freeYServer = await createServer("Joint Race Free Y", "joint-race-free-y", freeYOwner.id);
    for (const serverId of [hostServer.id, freeXServer.id, freeYServer.id]) {
      await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, serverId));
    }
    await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, paidServer.id));
    const hostToken = await tokenForHuman(hostOwner.email);
    const paidToken = await tokenForHuman(paidOwner.email);

    const createRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "joint-race-room",
        visibility: "joint",
        targetServerSlug: paidServer.slug,
        invitedPeople: [paidOwner.email],
      }),
    });
    assert.equal(createRes.status, 200);
    const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };
    const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
      method: "POST",
      headers: headers(paidToken, paidServer.id),
    });
    assert.equal(acceptRes.status, 200);
    const paidProjection = await acceptRes.json() as { id: string };

    // One free server (the host) so far. Each invite alone fits; together
    // they would make three. The parent joint row lock serializes them
    // (§18.7; only the host invites servers).
    const responses = await Promise.all([
      fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invites`, {
        method: "POST",
        headers: headers(hostToken, hostServer.id),
        body: JSON.stringify({ targetServerSlug: freeXServer.slug, invitedPeople: [freeXOwner.email] }),
      }),
      fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invites`, {
        method: "POST",
        headers: headers(hostToken, hostServer.id),
        body: JSON.stringify({ targetServerSlug: freeYServer.slug, invitedPeople: [freeYOwner.email] }),
      }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
    const rejected = responses.find((response) => response.status === 403);
    assert.ok(rejected);
    assert.equal((await rejected.json() as { code?: string }).code, "joint_free_server_limit");
  } finally {
    await app.close();
  }
});


test("accepting a Pro-hosted Joint Channel does not consume a Free target's permanent host allowance", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, clock: { now: () => new Date("2040-01-01T00:00:00Z") } });
  try {
    const hostOwner = await seedUser("joint-pro-inviter@slock.test", "joint-pro-inviter");
    const targetOwner = await seedUser("joint-free-invitee@slock.test", "joint-free-invitee");
    const nextTargetOwner = await seedUser("joint-permanent-target@slock.test", "joint-permanent-target");
    const hostServer = await createServer("Joint Pro Inviter", "joint-pro-inviter", hostOwner.id);
    const targetServer = await createServer("Joint Free Invitee", "joint-free-invitee", targetOwner.id);
    const nextTargetServer = await createServer("Joint Permanent Target", "joint-permanent-target", nextTargetOwner.id);
    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, hostServer.id));
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, targetServer.id));
    const hostToken = await tokenForHuman(hostOwner.email);
    const targetToken = await tokenForHuman(targetOwner.email);

    const allowedRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "pro-hosted-joint",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [targetOwner.email],
      }),
    });
    assert.equal(allowedRes.status, 200);
    const allowedBody = await allowedRes.json() as { jointInvite: { id: string } };

    const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${allowedBody.jointInvite.id}/accept`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(acceptRes.status, 200);
    // Settings shows each server's plan chip from the same free/paid decision
    // the free-server cap uses.
    const accepted = await acceptRes.json() as { jointServers: Array<{ serverId: string; plan?: string }> };
    assert.deepEqual(
      Object.fromEntries(accepted.jointServers.map((server) => [server.serverId, server.plan])),
      { [hostServer.id]: "paid", [targetServer.id]: "free" },
    );

    const targetCreateRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({
        name: "free-target-own-joint",
        visibility: "joint",
        targetServerSlug: nextTargetServer.slug,
        invitedPeople: [nextTargetOwner.email],
      }),
    });
    assert.equal(targetCreateRes.status, 200);
  } finally {
    await app.close();
  }
});

test("joint projection delivers the addChannelMembers capability to its members", async ({ app }) => {
  // The web client never inspects the channel type: it renders the add-member
  // entry from channelCapabilities.addChannelMembers alone. #7415 fixed the
  // shared predicate, so this pins the delivered payload the UI actually reads.
  const db = getDb();
  const owner = await seedUser("joint-cap-owner@slock.test", "joint-cap-owner");
  const peerOwner = await seedUser("joint-cap-peer@slock.test", "joint-cap-peer");
  const server = await createServer("Joint Cap Host", "joint-cap-host", owner.id);
  const peerServer = await createServer("Joint Cap Peer", "joint-cap-peer", peerOwner.id);

  const canonical = await createChannel(server.id, "joint-cap-storage");
  const hostProjection = await createChannel(server.id, "joint-cap-host-proj", undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, "joint-cap-peer-proj", undefined, "joint");
  const ordinary = await createChannel(server.id, "joint-cap-ordinary");
  await addHuman(hostProjection.id, owner.id);
  await addHuman(ordinary.id, owner.id);
  await addHuman(peerProjection.id, peerOwner.id);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint!.id,
      serverId: server.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: owner.id,
    },
    {
      jointChannelId: joint!.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: peerOwner.id,
    },
  ]);
  await fillJointMembersFromChannelHumans();

  const token = await tokenForHuman(owner.email);
  const response = await fetch(`${app.baseUrl}/api/channels`, { headers: headers(token, server.id) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const list = JSON.parse(raw) as Array<Record<string, any>>;

  const jointRow = list.find((channel) => channel.id === hostProjection.id);
  const ordinaryRow = list.find((channel) => channel.id === ordinary.id);
  assert.ok(jointRow, "joint projection must appear in the channel list");
  assert.ok(ordinaryRow, "ordinary channel must appear in the channel list");
  // Without this the test would still pass if the fixture stopped producing a
  // joint projection, which is exactly how a probe rots into a vacuous assert.
  assert.equal(jointRow!.type, "joint");

  assert.equal(jointRow!.channelCapabilities?.addChannelMembers, true);
  assert.equal(ordinaryRow!.channelCapabilities?.addChannelMembers, true);
});

test("joint channel create and invite accept existing server slugs shorter than the create-time minimum", async ({ app }) => {
  const hostOwner = await seedUser("joint-short-slug-host@slock.test", "joint-short-slug-host");
  const targetOwner = await seedUser("joint-short-slug-target@slock.test", "joint-short-slug-target");
  const thirdOwner = await seedUser("joint-short-slug-third@slock.test", "joint-short-slug-third");
  const hostServer = await createServer("Joint Short Slug Host", "botiverse", hostOwner.id);
  // Historical servers may predate the 5-character creation floor.
  const targetServer = await createServer("Joint Short Slug Target", "tiny", targetOwner.id);
  const thirdServer = await createServer("Joint Short Slug Third", "ab", thirdOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: "short-slug-room",
      visibility: "joint",
      targetServerSlug: "tiny",
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string; toServerId: string } };
  assert.equal(hostProjection.jointInvite.toServerId, targetServer.id);

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);

  const inviteRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/joint-invites`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      targetServerSlug: "ab",
      invitedPeople: [`@${thirdOwner.name}`],
    }),
  });
  assert.equal(inviteRes.status, 200);
  const invited = await inviteRes.json() as { jointInvite: { toServerId: string } };
  assert.equal(invited.jointInvite.toServerId, thirdServer.id);
});


test("every route that changes a joint channel notifies every active participant", async ({ app }) => {
  // One list of routes that change shared joint state. Adding a route that
  // skips emitJointProjectionUpdates / emitJointLimitStateChange makes its step
  // fail here, instead of being found by hand on staging.
  const owners = await Promise.all(["host", "second", "third", "fourth"].map((label) =>
    seedUser(`joint-notify-${label}@slock.test`, `joint-notify-${label}`)));
  const [hostOwner, secondOwner, thirdOwner, fourthOwner] = owners;
  const [hostServer, secondServer, thirdServer, fourthServer] = await Promise.all([
    createServer("Notify Host", "joint-notify-host", hostOwner.id),
    createServer("Notify Second", "joint-notify-second", secondOwner.id),
    createServer("Notify Third", "joint-notify-third", thirdOwner.id),
    createServer("Notify Fourth", "joint-notify-fourth", fourthOwner.id),
  ]);
  // The fixture pins servers to founder (paid). Host and second are free; third
  // and fourth stay paid so a later downgrade of third takes the joint over.
  for (const server of [hostServer, secondServer]) {
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, server.id));
  }
  const [hostToken, secondToken, thirdToken, fourthToken] = await Promise.all(owners.map((owner) => tokenForHuman(owner.email)));
  const events = installFakeIo(app.app);

  const post = async (path: string, token: string, serverId: string, body?: unknown, method = "POST") => {
    const res = await fetch(`${app.baseUrl}/api/channels${path}`, {
      method,
      headers: headers(token, serverId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, 200, `${method} ${path} should succeed`);
    return res.json() as Promise<{ id: string; jointInvite?: { id: string } }>;
  };
  const notified = (projectionIds: string[], step: string) => {
    const updated = new Set(events.splice(0)
      .filter((event) => event.event === "channel:updated")
      .map((event) => {
        const payload = event.payload as { channel?: { id?: string }; channelId?: string };
        return payload.channel?.id ?? payload.channelId;
      }));
    for (const id of projectionIds) assert.ok(updated.has(id), `${step}: projection ${id} was not sent channel:updated`);
  };

  const host = await post("", hostToken, hostServer.id, {
    name: "notify-room", visibility: "joint", targetServerSlug: secondServer.slug, invitedPeople: [`@${secondOwner.name}`],
  });
  notified([host.id], "create");

  const second = await post(`/joint-invites/${host.jointInvite!.id}/accept`, secondToken, secondServer.id);
  notified([host.id, second.id], "accept");

  const thirdInvite = await post(`/${host.id}/joint-invites`, hostToken, hostServer.id, {
    targetServerSlug: thirdServer.slug, invitedPeople: [`@${thirdOwner.name}`],
  });
  notified([host.id, second.id], "invite");
  const third = await post(`/joint-invites/${thirdInvite.jointInvite!.id}/accept`, thirdToken, thirdServer.id);
  const all = [host.id, second.id, third.id];
  notified(all, "accept third");

  // Only the host renames and archives (computed joint membership).
  await post(`/${host.id}`, hostToken, hostServer.id, { name: "notify-room-renamed" }, "PATCH");
  notified(all, "rename");
  await post(`/${host.id}/archive`, hostToken, hostServer.id);
  notified(all, "archive");
  await post(`/${host.id}/unarchive`, hostToken, hostServer.id);
  notified(all, "unarchive");

  // Limit change from a background observer (billing sync here; the sweep uses
  // the same listener). server.ts wires the listener the same way.
  onJointLimitStateChanged((parentJointId) => emitJointLimitStateChange(app.app.get("io"), parentJointId));
  try {
    const fourthInvite = await post(`/${host.id}/joint-invites`, hostToken, hostServer.id, {
      targetServerSlug: fourthServer.slug, invitedPeople: [`@${fourthOwner.name}`],
    });
    const fourth = await post(`/joint-invites/${fourthInvite.jointInvite!.id}/accept`, fourthToken, fourthServer.id);
    events.splice(0);
    await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, thirdServer.id));
    await reconcileJointsForServer(thirdServer.id);
    notified([...all, fourth.id], "going over the limit");

    // Disconnecting the extra free server brings the joint back within the
    // limit; the servers that stay must hear about it (peng,
    // #proj-joint-channel:a17703a2 cf2427a8).
    await post(`/${third.id}/disconnect`, thirdToken, thirdServer.id);
    notified([host.id, second.id, fourth.id], "disconnect");
  } finally {
    onJointLimitStateChanged(null);
  }
});

test("GET /api/channels/:id/threads resolves joint thread projections in one read, not one per thread", async ({ app }) => {
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const tag = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`joint-batch-host-${tag}@slock.test`, `joint-batch-host-${tag}`);
  const targetOwner = await seedUser(`joint-batch-target-${tag}@slock.test`, `joint-batch-target-${tag}`);
  const hostServer = await createServer("Joint Batch Host", `joint-batch-host-${tag}`, hostOwner.id);
  const targetServer = await createServer("Joint Batch Target", `joint-batch-target-${tag}`, targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ name: `joint-batch-${tag}`, visibility: "joint", targetServerSlug: targetServer.slug, invitedPeople: [`@${targetOwner.name}`] }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };
  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  const addThreads = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const parentRes = await fetch(`${app.baseUrl}/api/messages`, {
        method: "POST",
        headers: headers(hostToken, hostServer.id),
        body: JSON.stringify({ channelId: hostProjection.id, content: `joint batch parent ${i}` }),
      });
      assert.equal(parentRes.status, 200);
      const parent = await parentRes.json() as { id: string };
      const threadRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
        method: "POST",
        headers: headers(hostToken, hostServer.id),
        body: JSON.stringify({ parentMessageId: parent.id, content: `joint batch reply ${i}` }),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(threadRes.status, 200);
    }
  };
  // The per-thread projection lookup filtered on the canonical thread id.
  const projectionLookup = /"joint_thread_parent_projection"/;
  const countSummaries = async () => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let lookups = 0;
    pg.query = ((...args: unknown[]) => {
      if (typeof args[0] === "string" && projectionLookup.test(args[0])) lookups += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const res = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads`, { headers: headers(targetToken, targetServer.id) });
      assert.equal(res.status, 200);
      return { lookups, summaries: Object.keys(await res.json() as Record<string, unknown>).length };
    } finally {
      pg.query = originalQuery;
    }
  };

  await addThreads(2);
  const few = await countSummaries();
  await addThreads(6);
  const many = await countSummaries();
  assert.equal(few.summaries, 2);
  assert.equal(many.summaries, 8);
  assert.equal(many.lookups, few.lookups, `projection lookups: 2 threads ${few.lookups}, 8 threads ${many.lookups}`);
});

test("joint invites spend an hourly budget of invited people per person, refused ones included", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`joint-budget-host-${suffix}@slock.test`, `joint-budget-host-${suffix}`);
  const targetOwner = await seedUser(`joint-budget-target-${suffix}@slock.test`, `joint-budget-target-${suffix}`);
  const hostServer = await createServer("Joint Budget Host", `joint-budget-host-${suffix}`, hostOwner.id);
  const targetServer = await createServer("Joint Budget Target", `joint-budget-target-${suffix}`, targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const create = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify(body),
  });
  const people = (count: number, label: string) => Array.from({ length: count }, (_, index) => `${label}-${index}@slock.test`);

  // Trying addresses one batch after another: refusals count too.
  for (const batch of ["a", "b", "c"]) {
    const res = await create({ name: `budget-${batch}`, visibility: "joint", targetServerSlug: targetServer.slug, invitedPeople: people(20, batch) });
    assert.equal(res.status, 400, await res.clone().text());
    assert.equal((await res.json() as { code: string }).code, "joint_invitee_unavailable");
  }
  const spent = await create({ name: "budget-d", visibility: "joint", targetServerSlug: targetServer.slug, invitedPeople: [`@${targetOwner.name}`] });
  assert.equal(spent.status, 429);
  assert.ok(Number(spent.headers.get("retry-after")) > 0);
  const body = await spent.json() as { code: string; retryAfterSeconds: number };
  assert.equal(body.code, "joint_invite_rate_limited");
  assert.ok(body.retryAfterSeconds > 0);

  // Inviting a server into an existing joint channel draws on the same budget;
  // an ordinary channel does not.
  const ordinary = await create({ name: "budget-ordinary", visibility: "public" });
  assert.equal(ordinary.status, 200, await ordinary.clone().text());
  const { id: ordinaryId } = await ordinary.json() as { id: string };
  const invite = await fetch(`${app.baseUrl}/api/channels/${ordinaryId}/joint-invites`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ targetServerSlug: targetServer.slug, invitedPeople: [`@${targetOwner.name}`] }),
  });
  assert.equal(invite.status, 429);
});

test("a joint invite resend spends the same budget, one unit per pending invitee, and a refused resend changes nothing", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`joint-resend-budget-host-${suffix}@slock.test`, `joint-resend-budget-host-${suffix}`);
  const targetOwner = await seedUser(`joint-resend-budget-target-${suffix}@slock.test`, `joint-resend-budget-target-${suffix}`);
  const targetAdmin = await seedUser(`joint-resend-budget-admin-${suffix}@slock.test`, `joint-resend-budget-admin-${suffix}`);
  const hostServer = await createServer("Joint Resend Budget Host", `joint-resend-host-${suffix}`, hostOwner.id);
  const targetServer = await createServer("Joint Resend Budget Target", `joint-resend-target-${suffix}`, targetOwner.id);
  await addMember(targetServer.id, targetAdmin.id, "admin");
  const hostToken = await tokenForHuman(hostOwner.email);
  const created = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({ name: "resend-budget", visibility: "joint", targetServerSlug: targetServer.slug, invitedPeople: [targetOwner.email, `@${targetAdmin.name}`] }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { id: channelId } = await created.json() as { id: string };
  const resend = () => fetch(`${app.baseUrl}/api/channels/${channelId}/joint-invite/resend`, { method: "POST", headers: headers(hostToken, hostServer.id) });

  // 2 invited, 2 resent: 4 of the budget spent; then leave room for one more person only.
  const ok = await resend();
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(await ok.json(), { ok: true, resentCount: 2 });
  assert.equal((await admitJointInvite(hostOwner.id, JOINT_INVITE_RATE_LIMIT_MAX_PEOPLE - 5)).admitted, true);
  const before = await getDb().select({ id: jointChannelInvites.id, expiresAt: jointChannelInvites.expiresAt }).from(jointChannelInvites)
    .where(and(eq(jointChannelInvites.fromServerId, hostServer.id), eq(jointChannelInvites.status, "pending")));
  assert.equal(before.length, 2);

  const refused = await resend();
  assert.equal(refused.status, 429, await refused.clone().text());
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  assert.equal((await refused.json() as { code: string }).code, "joint_invite_rate_limited");
  const after = await getDb().select({ id: jointChannelInvites.id, expiresAt: jointChannelInvites.expiresAt }).from(jointChannelInvites)
    .where(and(eq(jointChannelInvites.fromServerId, hostServer.id), eq(jointChannelInvites.status, "pending")));
  assert.deepEqual(after.map((row) => row.expiresAt.getTime()).sort(), before.map((row) => row.expiresAt.getTime()).sort(), "a refused resend does not renew the invites");
});

test("joint-invites:changed: create, resend, a same-admin connect and accept each ping the invitee's sockets on the invited server once, after commit; a rollback pings nothing", async ({ app }) => {
  const host = await seedUser("joint-ping-host@slock.test", "joint-ping-host");
  const peer = await seedUser("joint-ping-peer@slock.test", "joint-ping-peer");
  const hostServer = await createServer("Joint Ping Host", "botiverse", host.id);
  const peerServer = await createServer("Joint Ping Peer", "joint-ping-peer", peer.id);
  const thirdServer = await createServer("Joint Ping Third", "joint-ping-third", peer.id);
  await addMember(thirdServer.id, host.id, "admin");
  const hostToken = await tokenForHuman(host.email);
  const peerToken = await tokenForHuman(peer.email);
  const frames: string[] = [];
  setListChangedRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: unknown) => {
    if (event === JOINT_INVITES_CHANGED_EVENT) frames.push(`${room} ${JSON.stringify(payload)}`);
    return true;
  } }) } as never);
  const take = () => frames.splice(0);
  const ping = (userId: string, serverId: string) => `user:${userId}:server:${serverId} ${JSON.stringify({ serverId })}`;
  try {
    const created = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ name: "ping-room", visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [peer.email] }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const projection = await created.json() as { id: string; jointInvites: Array<{ id: string }> };
    assert.deepEqual(take(), [ping(peer.id, peerServer.id)], "created: the invitee on the invited server, not the inviter");

    const resent = await fetch(`${app.baseUrl}/api/channels/${projection.id}/joint-invite/resend`, { method: "POST", headers: headers(hostToken, hostServer.id) });
    assert.equal(resent.status, 200, await resent.clone().text());
    assert.deepEqual(take(), [ping(peer.id, peerServer.id)], "resent");

    await assert.rejects(getDb().transaction(async () => {
      await resendPendingJointChannelInvites({ localChannelId: projection.id, fromServerId: hostServer.id, requestedByUserId: host.id });
      throw new Error("roll back");
    }), /roll back/);
    assert.deepEqual(take(), [], "a rolled-back resend pings nothing");

    // The invite and its same-admin accept commit apart, in one request: one ping.
    const sameAdmin = await fetch(`${app.baseUrl}/api/channels/${projection.id}/joint-invites`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ targetServerSlug: thirdServer.slug, invitedPeople: [`@${host.name}`], sameAdmin: true }),
    });
    assert.equal(sameAdmin.status, 200, await sameAdmin.clone().text());
    assert.equal((await sameAdmin.json() as { jointInvite: { status: string } }).jointInvite.status, "accepted");
    assert.deepEqual(take(), [ping(host.id, thirdServer.id)]);

    const accepted = await fetch(`${app.baseUrl}/api/channels/joint-invites/${projection.jointInvites[0]!.id}/accept`, { method: "POST", headers: headers(peerToken, peerServer.id) });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.deepEqual(take(), [ping(peer.id, peerServer.id)], "accepted: gone from the invitee's list");
  } finally {
    setListChangedRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});

test("joint-invites:changed: a pending invite's source copy disconnecting pings its invitee once it commits, with no invite row written; a rollback pings nothing (review F3)", async ({ app }) => {
  const host = await seedUser("joint-left-host@slock.test", "joint-left-host");
  const second = await seedUser("joint-left-second@slock.test", "joint-left-second");
  const third = await seedUser("joint-left-third@slock.test", "joint-left-third");
  const hostServer = await createServer("Joint Left Host", "botiverse", host.id);
  const secondServer = await createServer("Joint Left Second", "joint-left-second", second.id);
  const thirdServer = await createServer("Joint Left Third", "joint-left-third", third.id);
  const hostToken = await tokenForHuman(host.email);
  const secondToken = await tokenForHuman(second.email);
  const thirdToken = await tokenForHuman(third.email);
  const call = async <T,>(path: string, token: string, serverId: string, body?: unknown, method = "POST") => {
    const res = await fetch(`${app.baseUrl}/api/channels${path}`, { method, headers: headers(token, serverId), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as T;
  };
  const pendingForThird = async () => (await call<{ invites: Array<{ id: string }> }>("/joint-invites", thirdToken, thirdServer.id, undefined, "GET")).invites.length;

  // The second server joins; a pending invite of a third has the second's copy
  // as its source (written before only the host could invite servers).
  const hostCopy = await call<{ id: string; jointInvite: { id: string } }>("", hostToken, hostServer.id, {
    name: "left-room", visibility: "joint", targetServerSlug: secondServer.slug, invitedPeople: [`@${second.name}`],
  });
  const secondCopy = await call<{ id: string }>(`/joint-invites/${hostCopy.jointInvite.id}/accept`, secondToken, secondServer.id);
  const [secondProjection] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, secondCopy.id));
  await getDb().insert(jointChannelInvites).values({ jointChannelId: secondProjection!.jointChannelId, fromServerId: secondServer.id,
    toServerId: thirdServer.id, invitedUserId: third.id, invitedByUserId: second.id, expiresAt: new Date(Date.now() + 86_400_000) });
  assert.equal(await pendingForThird(), 1);

  const frames: string[] = [];
  setListChangedRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: unknown) => {
    if (event === JOINT_INVITES_CHANGED_EVENT) frames.push(`${room} ${JSON.stringify(payload)}`);
    return true;
  } }) } as never);
  const ping = `user:${third.id}:server:${thirdServer.id} ${JSON.stringify({ serverId: thirdServer.id })}`;
  try {
    await assert.rejects(getDb().transaction(async () => {
      await disconnectJointChannel(secondCopy.id, second.id);
      throw new Error("roll back");
    }), /roll back/);
    assert.deepEqual(frames.splice(0), [], "a rolled-back disconnect pings nothing");
    assert.equal(await pendingForThird(), 1);

    await call(`/${secondCopy.id}/disconnect`, secondToken, secondServer.id);
    assert.deepEqual(frames.splice(0), [ping], "the source copy left: its invitee's list loses the invite, once");
    assert.equal(await pendingForThird(), 0, "the list the ping asks for no longer has it");
  } finally {
    setListChangedRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});
