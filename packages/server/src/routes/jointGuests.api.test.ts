import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { jointChannelAdmissions, jointChannelMembers, jointChannelServers, serverMembers } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { createSeed } from "../test/integration/seed";
import { createHttpClient } from "../test/integration/http";
import { seedBoundGuest } from "../test/guestFixture";
import { captureEmails, enableExternalChannelsFlag, tokenOf } from "../test/externalInviteFixture";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";
import { acceptJointChannelInvite, addAgent, addHuman, createJointChannel } from "../services/channelService";
import { createAgent } from "../services/agentService";
import { createMessage } from "../services/messageService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { checkJointAdmission } from "../services/jointChannelLimitService";
import { assertCanAdmitExternalGuest, EXTERNAL_CHANNEL_MAX_SLOTS } from "../services/externalChannelLimitService";
import { channelConversionJobs, channelExternalInvites, channels, featureFlagRules } from "../db/schema";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { acceptExternalInviteAsGuest } from "../services/externalInviteService";

/**
 * P3: guests in joint channels (design v2, #wg-rbac:#25). A Guest of the host,
 * bound to the host's projection, stays in the channel once it is joint: it
 * enters only from the host, reads/posts like a guest in a normal channel,
 * manages nothing, and the host's external_channels_v1 gates all of it.
 */
const test = createApiTest();

type Http = ReturnType<typeof createHttpClient>;

/** Host H (owner, member) and peer B (admin, member) share a joint channel; a Guest of H is bound to H's projection. */
async function seedJointWithGuest(options: { externalChannels?: boolean; guestJoins?: boolean } = {}) {
  const db = getDb();
  const seed = createSeed(db);
  const hostOwner = await seed.human();
  const hostMember = await seed.human();
  const peerAdmin = await seed.human();
  const peerMember = await seed.human();
  const guest = await seed.human();
  const outsider = await seed.human();
  const host = await seed.server({ owner: hostOwner, members: [hostMember, outsider] });
  const peer = await seed.server({ owner: peerAdmin, members: [peerMember] });
  const made = await createJointChannel({
    hostServerId: host.id,
    createdByUserId: hostOwner.id,
    name: `p3-${host.slug}`.slice(0, 40),
    targetServerSlug: peer.slug,
    invitedPeople: [`@${peerAdmin.name}`],
    userIds: [hostMember.id],
  });
  const entry = await acceptJointChannelInvite({
    inviteId: made.invites[0]!.id,
    targetServerId: peer.id,
    acceptedByUserId: peerAdmin.id,
  });
  await addHuman(entry.id, peerMember.id);
  if (options.externalChannels !== false) await enableExternalChannelsFlag(host.id);
  await seedBoundGuest({ serverId: host.id, userId: guest.id, channelId: made.channel.id });
  if (options.guestJoins !== false) await joinGuest(made.channel.id, guest.id, hostOwner.id);
  return { host, peer, hostOwner, hostMember, peerAdmin, peerMember, guest, outsider, hostChannel: made.channel, peerChannel: entry, jointId: made.jointChannel.id, canonicalId: made.jointChannel.canonicalChannelId };
}

/** The guest's computed joint membership, admitted by the host (the mirror's join path). */
async function joinGuest(hostChannelId: string, guestId: string, actorUserId: string) {
  await getDb().transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { channelIds: [hostChannelId] }, "join");
    await mirror.apply([guestId], { actorUserId });
  });
}

async function status(http: Http, who: { id: string }, server: { id: string }, path: string, init?: RequestInit) {
  const response = init ? await http.as(who, server).request(path, init) : await http.as(who, server).get(path);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const post = (body: object): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a host Guest enters the joint channel only from the host: reads, posts, replies; computed membership names the host as its only source", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();

  const [member] = await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)));
  assert.ok(member, "the guest has a joint membership row");
  const sources = await getDb().select({ serverId: jointChannelAdmissions.serverId }).from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, f.jointId), eq(jointChannelAdmissions.userId, f.guest.id)));
  assert.deepEqual(sources.map((row) => row.serverId), [f.host.id], "the host is its only admission");

  const read = await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const sent = await status(http, f.guest, f.host, "/api/messages", post({ channelId: f.hostChannel.id, content: "hello from the guest" }));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  // A peer member's message: the guest replies in its thread.
  const peerMessage = await createMessage(f.canonicalId, "user", f.peerMember.id, "peer says hi");
  const reply = await status(http, f.guest, f.host, `/api/channels/${f.hostChannel.id}/threads`, post({ parentMessageId: peerMessage.id, content: "guest reply" }));
  assert.equal(reply.status, 200, JSON.stringify(reply.body));

  // The channel list shows it to the guest.
  const listed = await status(http, f.guest, f.host, "/api/channels");
  const rows = (listed.body as unknown as Array<{ id: string; joined?: boolean }>);
  assert.equal(Array.isArray(rows) && rows.some((row) => row.id === f.hostChannel.id && row.joined === true), true, JSON.stringify(listed.body));
});

test("a Guest never enters from another server: a peer Guest bound to the peer projection is refused, even with a forced joint membership row", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  await enableExternalChannelsFlag(f.peer.id);
  const peerGuest = await createSeed(getDb()).human();
  await seedBoundGuest({ serverId: f.peer.id, userId: peerGuest.id, channelId: f.peerChannel.id });
  await assert.rejects(() => joinGuest(f.peerChannel.id, peerGuest.id, f.peerAdmin.id), /Channel capability required/);
  // Forced J row: the entry rule itself (host projection only) still refuses.
  await getDb().insert(jointChannelMembers).values({ jointChannelId: f.jointId, userId: peerGuest.id });
  assert.equal((await status(http, peerGuest, f.peer, `/api/messages/channel/${f.peerChannel.id}`)).status, 404);
  const sent = await status(http, peerGuest, f.peer, "/api/messages", post({ channelId: f.peerChannel.id, content: "must not send" }));
  assert.notEqual(sent.status, 200);

  // A host Guest bound to another host channel is not in the joint either.
  const otherGuest = await createSeed(getDb()).human();
  const otherRoom = await createSeed(getDb()).channel({ server: f.host, members: [f.hostOwner], visibility: "private" });
  await seedBoundGuest({ serverId: f.host.id, userId: otherGuest.id, channelId: otherRoom.id });
  await getDb().insert(jointChannelMembers).values({ jointChannelId: f.jointId, userId: otherGuest.id });
  assert.equal((await status(http, otherGuest, f.host, `/api/messages/channel/${f.hostChannel.id}`)).status, 404);
});

test("flag off: with the host's external_channels_v1 off the bound Guest is refused everywhere and cannot be joined", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest({ externalChannels: false, guestJoins: false });
  await assert.rejects(() => joinGuest(f.hostChannel.id, f.guest.id, f.hostOwner.id), /Channel capability required/);
  // Even a forced membership row admits nothing while the host flag is off.
  await getDb().insert(jointChannelMembers).values({ jointChannelId: f.jointId, userId: f.guest.id });
  assert.equal((await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`)).status, 404);
  const sent = await status(http, f.guest, f.host, "/api/messages", post({ channelId: f.hostChannel.id, content: "must not send" }));
  assert.notEqual(sent.status, 200);
  const listed = await status(http, f.guest, f.host, "/api/channels");
  assert.equal((listed.body as unknown as Array<{ id: string }>).some((row) => row.id === f.hostChannel.id), false);
  assert.equal((await status(http, f.guest, f.host, `/api/channels/${f.hostChannel.id}/members`)).status, 404);
  // Nor does the membership predicate itself open other servers' cards.
  assert.equal((await status(http, f.guest, f.host, `/api/servers/${f.host.id}/members/${f.peerMember.id}/profile`)).status, 404);
});

test("computed membership revalidation keeps the bound Guest", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  await getDb().transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { serverId: f.host.id, userId: f.guest.id }, "revalidate");
    await mirror.apply([f.guest.id]);
  });
  const rows = await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)));
  assert.equal(rows.length, 1, "revalidation keeps the guest's membership");
  const [source] = await getDb().select({ endedAt: jointChannelAdmissions.endedAt }).from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, f.jointId), eq(jointChannelAdmissions.userId, f.guest.id)));
  assert.equal(source?.endedAt ?? null, null, "and its host source");
  assert.equal((await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`)).status, 200);
});

test("joint threads: the Guest reads and replies in a thread of its joint channel", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const root = await createMessage(f.canonicalId, "user", f.hostMember.id, "thread root");
  const first = await status(http, f.hostMember, f.host, `/api/channels/${f.hostChannel.id}/threads`, post({ parentMessageId: root.id, content: "member reply" }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const threadId = (first.body as { threadChannelId?: string; channelId?: string; thread?: { id: string } }).threadChannelId
    ?? (first.body as { thread?: { id: string } }).thread?.id
    ?? (first.body as { channelId?: string }).channelId;
  assert.ok(threadId, JSON.stringify(first.body));
  assert.equal((await status(http, f.guest, f.host, `/api/messages/channel/${threadId}`)).status, 200);
  const reply = await status(http, f.guest, f.host, "/api/messages", post({ channelId: threadId, content: "guest in thread" }));
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
});

const json = (method: string, body?: object): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("the Guest manages nothing in the joint channel", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const c = f.hostChannel.id;
  const attempts: Array<[string, string, RequestInit]> = [
    ["rename", `/api/channels/${c}`, json("PATCH", { name: "guest-renamed" })],
    ["archive", `/api/channels/${c}/archive`, json("POST")],
    ["add a member", `/api/channels/${c}/members`, json("POST", { userId: f.outsider.id })],
    ["remove a member", `/api/channels/${c}/members/user/${f.hostMember.id}`, json("DELETE")],
    ["appoint a manager", `/api/channels/${c}/members/user/${f.hostMember.id}/role`, json("PATCH", { role: "admin" })],
    ["disconnect", `/api/channels/${c}/disconnect`, json("POST")],
    ["invite people", `/api/channels/${c}/external-invites`, json("POST", { emails: ["someone@example.test"] })],
    ["connect servers", `/api/channels/${c}/external-connect-servers`, json("POST", { serverIds: [f.peer.id] })],
  ];
  for (const [label, path, init] of attempts) {
    const response = await status(http, f.guest, f.host, path, init);
    assert.ok(response.status === 403 || response.status === 404 || response.status === 409, `${label}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const roster = await status(http, f.guest, f.host, `/api/channels/${c}/members`);
  assert.equal(roster.status, 200);
  const humans = roster.body.humans as Array<{ id: string; canRemoveFromChannel?: boolean; canChangeChannelRole?: boolean }>;
  assert.equal(humans.some((human) => human.canRemoveFromChannel === true || human.canChangeChannelRole === true), false);
  const [after] = await getDb().select({ name: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.hostMember.id)));
  assert.ok(after, "the member is still there");
});

test("only the host removes a Guest: another server's admin cannot; the host's removal ends its server membership and access at once", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const peerRemove = await status(http, f.peerAdmin, f.peer, `/api/channels/${f.peerChannel.id}/members/user/${f.guest.id}`, json("DELETE"));
  assert.ok(peerRemove.status === 403 || peerRemove.status === 404, `${peerRemove.status} ${JSON.stringify(peerRemove.body)}`);
  assert.equal((await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`)).status, 200, "still in");

  const hostRemove = await status(http, f.hostOwner, f.host, `/api/channels/${f.hostChannel.id}/members/user/${f.guest.id}`, json("DELETE"));
  assert.equal(hostRemove.status, 200, JSON.stringify(hostRemove.body));
  const membership = await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)));
  assert.equal(membership.length, 0, "the Guest left the host server");
  const jointRows = await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)));
  assert.equal(jointRows.length, 0, "and the joint channel");
  const gone = await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`);
  // No longer a member of the host server: the server gate refuses first.
  assert.ok(gone.status === 403 || gone.status === 404, `${gone.status} ${JSON.stringify(gone.body)}`);
});

test("a Guest leaving the joint channel leaves the host server", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const left = await status(http, f.guest, f.host, `/api/channels/${f.hostChannel.id}/leave`, json("POST"));
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal((await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)))).length, 0);
  assert.equal((await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)))).length, 0);
});

test("other servers see the Guest only as from the host, with no guest role; the host still sees the Guest label", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  type Human = { id: string; role?: string | null; serverRole?: string | null; effectiveChannelRole?: string; servers?: Array<{ id: string }>; email?: string };
  const peerView = await status(http, f.peerMember, f.peer, `/api/channels/${f.peerChannel.id}/members`);
  assert.equal(peerView.status, 200, JSON.stringify(peerView.body));
  const seenByPeer = (peerView.body.humans as Human[]).find((human) => human.id === f.guest.id);
  assert.ok(seenByPeer, "the peer lists the guest");
  assert.equal(seenByPeer.role ?? null, null);
  assert.equal(seenByPeer.serverRole ?? null, null);
  assert.equal(seenByPeer.effectiveChannelRole, "member");
  assert.deepEqual(seenByPeer.servers?.map((server) => server.id), [f.host.id], "from the host");
  assert.equal(JSON.stringify(peerView.body).includes("\"guest\""), false, "no guest role anywhere in the peer's roster");

  const peerProfile = await status(http, f.peerMember, f.peer, `/api/servers/${f.peer.id}/members/${f.guest.id}/profile`);
  assert.equal(peerProfile.status, 200, JSON.stringify(peerProfile.body));
  assert.equal(peerProfile.body.role ?? null, null);
  assert.equal(peerProfile.body.serverId, f.host.id);
  assert.equal(JSON.stringify(peerProfile.body).includes("\"guest\""), false);

  const hostView = await status(http, f.hostMember, f.host, `/api/channels/${f.hostChannel.id}/members`);
  const seenByHost = (hostView.body.humans as Human[]).find((human) => human.id === f.guest.id);
  assert.equal(seenByHost?.effectiveChannelRole, "guest", "the host keeps the Guest label");
});

test("the Guest sees other servers' members with their server, opens their simplified card, and nobody outside the channel", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const roster = await status(http, f.guest, f.host, `/api/channels/${f.hostChannel.id}/members`);
  type Human = { id: string; email?: string; servers?: Array<{ id: string }>; inViewerServer?: boolean; role?: string };
  const peerRow = (roster.body.humans as Human[]).find((human) => human.id === f.peerMember.id);
  assert.ok(peerRow, JSON.stringify(roster.body));
  assert.deepEqual(peerRow.servers?.map((server) => server.id), [f.peer.id], "from the peer");
  assert.equal(peerRow.inViewerServer, false);
  assert.equal(peerRow.email, undefined);

  const card = await status(http, f.guest, f.host, `/api/servers/${f.host.id}/members/${f.peerMember.id}/profile`);
  assert.equal(card.status, 200, JSON.stringify(card.body));
  assert.equal(card.body.profileProjection, "channel_summary");
  assert.equal(card.body.email ?? null, null);
  assert.equal(card.body.role ?? null, null);

  const stranger = await createSeed(getDb()).human();
  await getDb().insert(serverMembers).values({ serverId: f.peer.id, userId: stranger.id, role: "member" });
  assert.equal((await status(http, f.guest, f.host, `/api/servers/${f.host.id}/members/${stranger.id}/profile`)).status, 404, "a peer member outside the channel");
  assert.equal((await status(http, f.guest, f.host, `/api/servers/${f.host.id}/members/${f.outsider.id}/profile`)).status, 404, "a host member outside the channel");
});

test("the Guest sees other servers' agents tagged with their own server, not the Guest's", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const peerAgent = await createAgent(f.peer.id, `peerbot${Date.now() % 100000}`, { runtime: "codex" });
  await addAgent(f.peerChannel.id, peerAgent.id);
  const roster = await status(http, f.guest, f.host, `/api/channels/${f.hostChannel.id}/members`);
  const row = (roster.body.agents as Array<{ id: string; serverId?: string }>).find((agent) => agent.id === peerAgent.id);
  assert.ok(row, JSON.stringify(roster.body.agents));
  assert.equal(row.serverId, f.peer.id, "from the peer, not the Guest's host");
});

test("archiving the joint channel ends its Guest's host membership at once; unarchiving does not bring it back", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const archived = await status(http, f.hostOwner, f.host, `/api/channels/${f.hostChannel.id}/archive`, json("POST"));
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const gone = await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`);
  assert.ok(gone.status === 403 || gone.status === 404, `${gone.status}`);
  assert.equal((await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)))).length, 0, "the Guest left the host server");
  assert.equal((await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)))).length, 0);

  const unarchived = await status(http, f.hostOwner, f.host, `/api/channels/${f.hostChannel.id}/unarchive`, json("POST"));
  assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body));
  assert.equal((await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)))).length, 0, "not back");
});

test("archiving a joint channel ends a bound Guest's host membership even with the host flag off (a preserving write is ungated)", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest({ externalChannels: false, guestJoins: false });
  const archived = await status(http, f.hostOwner, f.host, `/api/channels/${f.hostChannel.id}/archive`, json("POST"));
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal((await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)))).length, 0);
});

test("another server disconnecting does not affect the Guest", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const disconnected = await status(http, f.peerAdmin, f.peer, `/api/channels/${f.peerChannel.id}/disconnect`, json("POST"));
  assert.equal(disconnected.status, 200, JSON.stringify(disconnected.body));
  assert.equal((await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`)).status, 200);
  assert.equal((await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)))).length, 1);
});

test("converting a channel with a bound Guest carries it into the joint channel (computed membership, host source)", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const seed = createSeed(getDb());
  const owner = await seed.human();
  const guest = await seed.human();
  const host = await seed.server({ owner });
  await enableExternalChannelsFlag(host.id);
  const room = await seed.channel({ server: host, members: [owner], visibility: "private" });
  await seedBoundGuest({ serverId: host.id, userId: guest.id, channelId: room.id });
  const job = await startChannelToJointConversion({ serverId: host.id, sourceChannelId: room.id, createdByUserId: owner.id });
  const jobId = (job as { jobId?: string; id?: string }).jobId ?? (job as { id?: string }).id
    ?? (await getDb().select({ id: channelConversionJobs.id }).from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, room.id)))[0]!.id;
  assert.equal((await runChannelConversionJob(jobId)).status, "done");
  const [joint] = await getDb().select({ id: jointChannelMembers.jointChannelId }).from(jointChannelMembers)
    .where(eq(jointChannelMembers.userId, guest.id));
  assert.ok(joint, "the Guest has a joint membership");
  const sources = await getDb().select({ serverId: jointChannelAdmissions.serverId }).from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, joint.id), eq(jointChannelAdmissions.userId, guest.id)));
  assert.deepEqual(sources.map((row) => row.serverId), [host.id]);
  assert.equal((await status(http, guest, host, `/api/messages/channel/${room.id}`)).status, 200);
});

test("flag off: converting a channel with a bound Guest is still refused with guests_present", async ({ app }) => {
  void app;
  const seed = createSeed(getDb());
  const owner = await seed.human();
  const guest = await seed.human();
  const host = await seed.server({ owner });
  const room = await seed.channel({ server: host, members: [owner], visibility: "private" });
  await seedBoundGuest({ serverId: host.id, userId: guest.id, channelId: room.id });
  await assert.rejects(() => startChannelToJointConversion({ serverId: host.id, sourceChannelId: room.id, createdByUserId: owner.id }), { code: "guests_present" });
});

test("one party cap: servers and Guests together; a full joint takes neither another Guest nor another server", async ({ app }) => {
  void app;
  const f = await seedJointWithGuest();
  const now = new Date();
  // Host + peer + 1 guest = 3 parties; fill to the cap with more host Guests.
  const seed = createSeed(getDb());
  for (let i = 3; i < EXTERNAL_CHANNEL_MAX_SLOTS; i += 1) {
    const extra = await seed.human();
    await seedBoundGuest({ serverId: f.host.id, userId: extra.id, channelId: f.hostChannel.id });
  }
  await assert.rejects(
    () => assertCanAdmitExternalGuest(getDb(), { serverId: f.host.id, channelId: f.hostChannel.id, now }),
    { code: "channel_full" },
  );
  const another = await seed.server({ owner: await seed.human() });
  await assert.rejects(
    () => checkJointAdmission(getDb(), f.jointId, { kind: "accept", serverId: another.id }, now),
    { code: "joint_server_limit" },
  );
  // One Guest fewer: both have room again.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)));
  await assertCanAdmitExternalGuest(getDb(), { serverId: f.host.id, channelId: f.hostChannel.id, now });
  await checkJointAdmission(getDb(), f.jointId, { kind: "accept", serverId: another.id }, now);
});

test("accepting an external invite to a joint channel as a guest binds the host projection and gives a host-sourced joint membership; the peer projection takes no Guest", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const invitee = await createSeed(getDb()).human();
  const mail = captureEmails();
  let token: string;
  try {
    const sent = await status(http, f.hostOwner, f.host, `/api/channels/${f.hostChannel.id}/external-invites`, post({ emails: [invitee.email] }));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    token = tokenOf(mail.deliveries.find((delivery) => delivery.to === invitee.email)!);
  } finally {
    mail.stop();
  }
  const page = await status(http, invitee, f.host, `/api/external-invites/${token}`);
  assert.equal((page.body.options as { guest: boolean }).guest, true);
  const accepted = await status(http, invitee, f.host, `/api/external-invites/${token}/accept-as-guest`, post({}));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const sources = await getDb().select({ serverId: jointChannelAdmissions.serverId }).from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, f.jointId), eq(jointChannelAdmissions.userId, invitee.id)));
  assert.deepEqual(sources.map((row) => row.serverId), [f.host.id]);
  assert.equal((await status(http, invitee, f.host, `/api/messages/channel/${f.hostChannel.id}`)).status, 200);
});

test("another server's projection takes no Guest, and with the host flag off no joint invite does", async ({ app }) => {
  void app;
  const f = await seedJointWithGuest({ guestJoins: false });
  await enableExternalChannelsFlag(f.peer.id);
  const { createHash, randomBytes } = await import("node:crypto");
  const invite = async (channelId: string, hostServerId: string, invitedByUserId: string) => {
    const invitee = await createSeed(getDb()).human();
    const raw = randomBytes(32).toString("hex");
    await getDb().insert(channelExternalInvites).values({
      channelId, hostServerId, email: invitee.email, tokenHash: createHash("sha256").update(raw).digest("hex"),
      invitedByUserId, expiresAt: new Date(Date.now() + 86_400_000),
    });
    return { invitee, raw };
  };
  const onPeer = await invite(f.peerChannel.id, f.peer.id, f.peerAdmin.id);
  await assert.rejects(() => acceptExternalInviteAsGuest(onPeer.raw, onPeer.invitee.id), { code: "guest_unavailable" });
  assert.equal((await getDb().select().from(serverMembers).where(eq(serverMembers.userId, onPeer.invitee.id))).length, 0);

  // The host's flag goes off: the guest way in closes again, exactly as before P3.
  const onHost = await invite(f.hostChannel.id, f.host.id, f.hostOwner.id);
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  await assert.rejects(() => acceptExternalInviteAsGuest(onHost.raw, onHost.invitee.id));
  assert.equal((await getDb().select().from(serverMembers).where(eq(serverMembers.userId, onHost.invitee.id))).length, 0);
});

test("the Guest creates tasks in the joint channel, assigns them to people of any server in it and to nobody outside; it reacts and lists its inbox", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const created = await status(http, f.guest, f.host, `/api/tasks/channel/${f.hostChannel.id}`, post({ tasks: [{ title: "guest task" }] }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const [task] = created.body.tasks as Array<{ id: string }>;
  assert.ok(task);
  const assign = (id: string) => status(http, f.guest, f.host, `/api/tasks/${task.id}/assignee`, json("PATCH", { assignee: { type: "user", id } }));
  const toPeer = await assign(f.peerMember.id);
  assert.equal(toPeer.status, 200, JSON.stringify(toPeer.body));
  const toOutsider = await assign(f.outsider.id);
  assert.equal(toOutsider.status, 409, JSON.stringify(toOutsider.body));

  const message = await createMessage(f.canonicalId, "user", f.peerMember.id, "react to me");
  const reacted = await status(http, f.guest, f.host, `/api/messages/${message.id}/reactions`, post({ emoji: "👍" }));
  assert.equal(reacted.status, 200, JSON.stringify(reacted.body));

  assert.equal((await status(http, f.guest, f.host, "/api/channels/inbox")).status, 200);
});

test("search: the Guest finds messages of its joint channel", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  await createMessage(f.canonicalId, "user", f.peerMember.id, "p3sentinel from the peer");
  const found = await status(http, f.guest, f.host, "/api/messages/search?q=p3sentinel");
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.ok((found.body.results as unknown[]).length >= 1, JSON.stringify(found.body));
});

test("a conversion admitted with the host flag on carries its Guest in even if the flag is off at finalize; access follows the flag, membership stays", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const seed = createSeed(getDb());
  const owner = await seed.human();
  const guest = await seed.human();
  const host = await seed.server({ owner });
  await enableExternalChannelsFlag(host.id);
  const room = await seed.channel({ server: host, members: [owner], visibility: "private" });
  await seedBoundGuest({ serverId: host.id, userId: guest.id, channelId: room.id });
  await startChannelToJointConversion({ serverId: host.id, sourceChannelId: room.id, createdByUserId: owner.id });
  const [job] = await getDb().select({ id: channelConversionJobs.id }).from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, room.id));
  // The host's flag goes off before finalize.
  const rules = await getDb().select().from(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  assert.equal((await runChannelConversionJob(job!.id)).status, "done");
  const [member] = await getDb().select({ id: jointChannelMembers.jointChannelId }).from(jointChannelMembers).where(eq(jointChannelMembers.userId, guest.id));
  assert.ok(member, "the Guest's joint membership is written at finalize, flag off");
  const sources = await getDb().select({ serverId: jointChannelAdmissions.serverId }).from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, member.id), eq(jointChannelAdmissions.userId, guest.id)));
  assert.deepEqual(sources.map((row) => row.serverId), [host.id], "with its host source");
  assert.equal((await status(http, guest, host, `/api/messages/channel/${room.id}`)).status, 404, "no access while the flag is off");
  // The flag comes back: the Guest is in again, without a new invite.
  await getDb().insert(featureFlagRules).values(rules);
  assert.equal((await status(http, guest, host, `/api/messages/channel/${room.id}`)).status, 200);
});

test("a conversion that would put the channel over the party cap is refused and writes nothing; at the cap it converts", async ({ app }) => {
  void app;
  const seed = createSeed(getDb());
  const owner = await seed.human();
  const host = await seed.server({ owner });
  await enableExternalChannelsFlag(host.id);
  const seedRoom = async (guests: number) => {
    const room = await seed.channel({ server: host, members: [owner], visibility: "private" });
    for (let i = 0; i < guests; i += 1) await seedBoundGuest({ serverId: host.id, userId: (await seed.human()).id, channelId: room.id });
    return room;
  };
  // Host + guests + the server it is shared with: 1 + 29 + 1 = 31 > 30.
  const over = await seedRoom(EXTERNAL_CHANNEL_MAX_SLOTS - 1);
  await assert.rejects(() => startChannelToJointConversion({ serverId: host.id, sourceChannelId: over.id, createdByUserId: owner.id }), { code: "joint_party_limit" });
  assert.equal((await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, over.id))).length, 0, "no job");
  const [still] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, over.id));
  assert.equal(still?.type, "private");
  // 1 + 28 + 1 = 30: exactly the cap, converts.
  const atCap = await seedRoom(EXTERNAL_CHANNEL_MAX_SLOTS - 2);
  const started = await startChannelToJointConversion({ serverId: host.id, sourceChannelId: atCap.id, createdByUserId: owner.id });
  assert.ok(started);
});

test("flag off: a host disconnect with a bound Guest is refused with guests_present and changes nothing; the Guest is back when the flag is", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest();
  const rules = await getDb().select().from(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
  const refused = await status(http, f.hostOwner, f.host, `/api/channels/${f.hostChannel.id}/disconnect`, json("POST"));
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "guests_present");
  const [projection] = await getDb().select({ status: jointChannelServers.status }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, f.hostChannel.id));
  assert.equal(projection?.status, "active", "the host projection stays");
  assert.equal((await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)))).length, 1, "the Guest's membership stays");
  await getDb().insert(featureFlagRules).values(rules);
  assert.equal((await status(http, f.guest, f.host, `/api/messages/channel/${f.hostChannel.id}`)).status, 200, "the Guest is back with the flag");
});

test("flag off without Guests: the host disconnect works as before", async ({ app }) => {
  const http = createHttpClient(app.baseUrl);
  const f = await seedJointWithGuest({ externalChannels: false, guestJoins: false });
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)));
  const done = await status(http, f.hostOwner, f.host, `/api/channels/${f.hostChannel.id}/disconnect`, json("POST"));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const [projection] = await getDb().select({ status: jointChannelServers.status }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, f.hostChannel.id));
  assert.equal(projection?.status, "disconnected");
});
