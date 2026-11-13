import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join as pathJoin, sep as pathSep } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channelExternalInvites,
  channelHumans,
  featureFlags,
  integrationAuditEvents,
  jointMembershipDepartures,
  jointAdmissionRecoveries,
  jointChannelAdmissions,
  jointChannelInvites,
  jointChannelMembers,
  jointChannelServers,
  messageMentions,
  serverMembers,
  servers,
} from "../db/schema";
import {
  acceptJointChannelInvite,
  acceptJointChannelInvites,
  addHuman,
  archiveChannel,
  canUserAccessChannel,
  createChannel,
  createJointChannel,
  disconnectJointChannel,
  getChannel,
  inviteServerToJointChannel,
  removeHuman,
  __setSameAdminAcceptBarrierForTests,
} from "../services/channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { __initializeInviteSourcesForTests, __setInviteSourcesStartedBarrierForTests, advanceExternalConnect } from "../services/externalInviteConnectService";
import { createDirectConnectInvite } from "../services/externalInviteService";
import { JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, jointHumanCurrentSourceSql } from "../services/jointHumanMembershipAccess";
import { executeMentionActionId } from "../services/mentionActionService";
import { addHumanWithMembershipSystemMessage, createMessage } from "../services/messageService";
import { cleanJointMembershipDepartureBatch, type JointMembershipDepartureId } from "../services/jointMembershipDeparture";
import { createServer, removeMember } from "../services/serverService";
import { ensureTaskConversation } from "../services/taskConversationService";
import { createTasks } from "../services/taskService";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { captureEmails, enableExternalChannelsFlag, login, seedUser, sha256 } from "../test/externalInviteFixture";

// Joint membership sources recorded by one external invite (the operation)
// in computed membership mode (externalInviteConnectService, "Membership
// sources"): every server one operation connects is a source of the one
// membership it created or started from; an operation whose joiner left, or
// rejoined another way, records nothing and never re-adds them.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DAY_MS = 24 * 60 * 60 * 1000;

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${randomBytes(4).toString("hex")}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

/**
 * `legacyJointCreation`: the host keeps external_channels_v1 off, the only
 * state in which the legacy create-joint route still answers (#13038 retires
 * it, 404 joint_creation_retired, once the flag is on for the server).
 */
async function seedHost(baseUrl: string, options: { legacyJointCreation?: boolean } = {}) {
  const owner = await person(baseUrl, "src-host-owner");
  const server = await createServer("Sources Host", `src-host-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  if (!options.legacyJointCreation) await enableExternalChannelsFlag(server.id);
  const room = () => createChannel(server.id, `src-room-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: owner.id });
  return { owner, server, room };
}

type Host = Awaited<ReturnType<typeof seedHost>>;

async function seedTarget(owner: Person, members: Array<[Person, "admin" | "member"]> = []) {
  const server = await createServer("Target", `src-target-${randomBytes(4).toString("hex")}`, owner.id);
  for (const [member, role] of members) await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  return server;
}

async function seedInvite(host: Host, channelId: string, email: string) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId,
    hostServerId: host.server.id,
    email,
    tokenHash: sha256(token),
    invitedByUserId: host.owner.id,
    expiresAt: new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

function call(baseUrl: string, as: Person, method: string, path: string, body?: unknown, serverId?: string) {
  return fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json", ...(serverId ? { "X-Server-Id": serverId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const mail = captureEmails();
  try {
    return await work();
  } finally {
    mail.stop();
  }
}

const connectServers = (baseUrl: string, as: Person, token: string, selections: unknown) =>
  quietly(() => call(baseUrl, as, "POST", `external-invites/${token}/connect-servers`, { servers: selections }));
const connectOwn = (baseUrl: string, as: Person, hostId: string, channelId: string, serverIds: string[]) =>
  quietly(() => call(baseUrl, as, "POST", `channels/${channelId}/external-connect-servers`, { serverIds }, hostId));
const approve = (baseUrl: string, as: Person, requestId: string) =>
  quietly(() => call(baseUrl, as, "POST", `server-connect-requests/${requestId}/approve`));

async function expectStatus(response: Response, status: number, code?: string) {
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.code, code);
  return body;
}

type Outcome = { serverId: string; state: string; code?: string; requestId?: string };
const outcomesOf = (body: Record<string, unknown>) => Object.fromEntries((body.servers as Outcome[]).map((outcome) => [outcome.serverId, outcome]));

async function inviteRow(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

async function jointOf(hostChannelId: string): Promise<string> {
  const [row] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, hostChannelId));
  assert.ok(row, "the channel is joint");
  return row.jointChannelId;
}

async function projectionOn(hostChannelId: string, serverId: string) {
  const [row] = await getDb().select().from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, await jointOf(hostChannelId)), eq(jointChannelServers.serverId, serverId), eq(jointChannelServers.status, "active")));
  return row ?? null;
}

async function memberOf(jointId: string, userId: string) {
  const [row] = await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, jointId), eq(jointChannelMembers.userId, userId)));
  return row ?? null;
}

/** The person's sources, ordered by server id: [server, generation, admitted_by, ended]. */
async function sourcesOf(jointId: string, userId: string) {
  const rows = await getDb().select().from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, jointId), eq(jointChannelAdmissions.userId, userId)));
  return rows
    .map((row) => ({ serverId: row.serverId, generation: row.generation, admittedBy: row.admittedBy, ended: row.endedAt !== null }))
    .sort((a, b) => a.serverId.localeCompare(b.serverId));
}

const source = (serverId: string, generation: number, admittedBy: string | null, ended = false) => ({ serverId, generation, admittedBy, ended });
const byServer = <T extends { serverId: string }>(rows: T[]) => [...rows].sort((a, b) => a.serverId.localeCompare(b.serverId));

async function convertToJoint(host: Host, channelId: string) {
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channelId, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
}

async function driveWorker(inviteId: string) {
  for (let pass = 0; pass < 40 && (await inviteRow(inviteId)).status === "connecting"; pass += 1) await runChannelConversionWorkerPass();
}

/**
 * The person joins another way: a joint invite from the host to a server
 * they own, which they accept (an external invite to their address is the
 * one open invite of theirs to the channel).
 */
async function joinAnotherWay(host: Host, hostChannelId: string, invitee: Person, serverId: string) {
  const [server] = await getDb().select({ slug: servers.slug }).from(servers).where(eq(servers.id, serverId));
  const sent = await inviteServerToJointChannel({ localChannelId: hostChannelId, fromServerId: host.server.id, invitedByUserId: host.owner.id, targetServerSlug: server!.slug, invitedPeople: [`@${invitee.name}`] });
  await acceptJointChannelInvite({ inviteId: sent.invites[0]!.id, targetServerId: serverId, acceptedByUserId: invitee.id });
}

/** The person leaves the joint channel (from the projection on `serverId`): their membership ends J-wide. */
async function leave(hostChannelId: string, serverId: string, userId: string) {
  const projection = await projectionOn(hostChannelId, serverId);
  assert.ok(projection, "connected there");
  await removeHuman(projection.localChannelId, userId, { self: true });
  assert.equal(await memberOf(await jointOf(hostChannelId), userId), null, "left");
}

test("Your servers: both servers the invitee connects directly are sources of the one membership it made", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-a");
  const a = await seedTarget(invitee);
  const b = await seedTarget(invitee);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);

  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: a.id }, { serverId: b.id }]), 200));
  assert.deepEqual([outcomes[a.id]!.state, outcomes[b.id]!.state], ["connected", "connected"]);
  const jointId = await jointOf(room.id);
  const member = await memberOf(jointId, invitee.id);
  assert.ok(member);
  assert.deepEqual(await sourcesOf(jointId, invitee.id), byServer([source(a.id, member.generation, invitee.id), source(b.id, member.generation, invitee.id)]));
  const row = await inviteRow(invite.id);
  assert.deepEqual({ state: row.sourceState, generation: row.sourceGeneration }, { state: "joined", generation: member.generation });
});

/** POST /api/channels as Create Channel does: a private channel of the host, its creator its first member. */
async function createRoom(baseUrl: string, as: Person, host: Host): Promise<string> {
  const body = await expectStatus(await call(baseUrl, as, "POST", "channels", { name: `src-new-${randomBytes(4).toString("hex")}`, visibility: "private" }, host.server.id), 200);
  return body.id as string;
}

async function ownInvite(channelId: string) {
  const [invite] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.channelId, channelId));
  assert.ok(invite);
  return invite;
}

test("creation ticks, as Create Channel sends them (create, then connect my own servers): every ticked server that connects is a source with the host; a refused one has none; a connected server's own disconnect ends its sources in that commit", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const s1 = await seedTarget(host.owner);
  const s2 = await seedTarget(host.owner);
  const stranger = await person(app.baseUrl, "src-b-other");
  const notMine = await seedTarget(stranger, [[host.owner, "member"]]);
  const roomId = await createRoom(app.baseUrl, host.owner, host);

  const outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, roomId, [s1.id, s2.id, notMine.id]), 200));
  assert.deepEqual([outcomes[s1.id]!.state, outcomes[s2.id]!.state, outcomes[notMine.id]!.state], ["connecting", "connecting", "refused"]);
  const invite = await ownInvite(roomId);
  assert.equal(invite.sourceState, "awaiting_joint_creation", "resolved by the conversion that creates the joint");
  await driveWorker(invite.id);
  assert.equal((await projectionOn(roomId, s2.id))?.status, "active");
  const jointId = await jointOf(roomId);
  const generation = (await memberOf(jointId, host.owner.id))!.generation;
  assert.deepEqual({ state: (await inviteRow(invite.id)).sourceState, generation: (await inviteRow(invite.id)).sourceGeneration },
    { state: "member_at_start", generation }, "the membership the conversion wrote");
  const hostSource = (await sourcesOf(jointId, host.owner.id)).find((row) => row.serverId === host.server.id);
  assert.ok(hostSource && !hostSource.ended, "the host is a source from the conversion");
  assert.deepEqual(
    (await sourcesOf(jointId, host.owner.id)).filter((row) => row.serverId !== host.server.id),
    byServer([source(s1.id, generation, host.owner.id), source(s2.id, generation, host.owner.id)]),
    "both connected servers; none for the refused one",
  );

  // The connected server disconnects itself (its owner): its sources, the
  // creator's self-source included, end in the same commit.
  await disconnectJointChannel((await projectionOn(roomId, s1.id))!.localChannelId, host.owner.id);
  const after = await sourcesOf(jointId, host.owner.id);
  assert.deepEqual(after.find((row) => row.serverId === s1.id)?.ended, true);
  assert.deepEqual(after.find((row) => row.serverId === s2.id)?.ended, false);
  assert.deepEqual(after.find((row) => row.serverId === host.server.id)?.ended, false);
});

test("creation ticks by an actor no longer in the private channel when it converts: the conversion makes them no member, so the first connection admits them and each connected server is a source", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const admin = await person(app.baseUrl, "src-b-admin");
  await getDb().insert(serverMembers).values({ serverId: host.server.id, userId: admin.id, role: "admin" });
  const s1 = await seedTarget(admin);
  const s2 = await seedTarget(admin);
  const room = await host.room();
  await addHuman(room.id, admin.id);

  await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s1.id, s2.id]), 200);
  const invite = await ownInvite(room.id);
  assert.equal(invite.sourceState, "awaiting_joint_creation");
  // Out of the channel when it converts. Reachable only as a race: leaving
  // after the operation started but before its conversion fenced the channel
  // (a leave during the conversion is refused); the row is removed directly
  // to stand in for that leave.
  await getDb().delete(channelHumans).where(and(eq(channelHumans.channelId, room.id), eq(channelHumans.userId, admin.id)));
  assert.equal((await runChannelConversionJob(invite.connectConversionJobId!)).status, "done");
  const jointId = await jointOf(room.id);
  assert.equal(await memberOf(jointId, admin.id), null, "the conversion made them no member");
  assert.deepEqual({ state: (await inviteRow(invite.id)).sourceState, start: (await inviteRow(invite.id)).sourceStartGeneration }, { state: "awaiting_first_join", start: 0 });
  await driveWorker(invite.id);
  const member = await memberOf(jointId, admin.id);
  assert.ok(member, "admitted by the first connection");
  assert.deepEqual(await sourcesOf(jointId, admin.id), byServer([source(s1.id, member.generation, admin.id), source(s2.id, member.generation, admin.id)]));
});

test("creation ticks: the creator leaves and rejoins between the conversion and the queued connects: no source for the new membership", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const s1 = await seedTarget(host.owner);
  const s2 = await seedTarget(host.owner);
  const roomId = await createRoom(app.baseUrl, host.owner, host);
  await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, roomId, [s1.id, s2.id]), 200);
  const invite = await ownInvite(roomId);
  assert.equal((await runChannelConversionJob(invite.connectConversionJobId!)).status, "done");
  const jointId = await jointOf(roomId);
  const created = (await memberOf(jointId, host.owner.id))!.generation;
  assert.deepEqual({ state: (await inviteRow(invite.id)).sourceState, generation: (await inviteRow(invite.id)).sourceGeneration }, { state: "member_at_start", generation: created });

  await removeHuman(roomId, host.owner.id, { self: true });
  await addHuman(roomId, host.owner.id);
  const rejoined = (await memberOf(jointId, host.owner.id))!.generation;
  assert.notEqual(rejoined, created);
  await quietly(() => driveWorker(invite.id));
  assert.equal(await projectionOn(roomId, s1.id), null);
  assert.equal(await projectionOn(roomId, s2.id), null);
  const sources = await sourcesOf(jointId, host.owner.id);
  assert.equal(sources.some((row) => row.serverId === s1.id || row.serverId === s2.id), false, "no source of either membership");
});

test("the legacy create-joint route with two same-admin targets: each target that connects is a source of the creator's membership", async ({ app }) => {
  const host = await seedHost(app.baseUrl, { legacyJointCreation: true });
  const t1 = await seedTarget(host.owner);
  const t2 = await seedTarget(host.owner);
  const body = await expectStatus(await call(app.baseUrl, host.owner, "POST", "channels", {
    name: `src-legacy-${randomBytes(4).toString("hex")}`,
    visibility: "joint",
    jointInvites: [t1, t2].map((target) => ({ targetServerSlug: target.slug, invitedPeople: [`@${host.owner.name}`], sameAdmin: true })),
  }, host.server.id), 200);
  const jointId = await jointOf(body.id as string);
  assert.equal((await projectionOn(body.id as string, t1.id))?.status, "active");
  assert.equal((await projectionOn(body.id as string, t2.id))?.status, "active");
  const generation = (await memberOf(jointId, host.owner.id))!.generation;
  assert.deepEqual(
    (await sourcesOf(jointId, host.owner.id)).filter((row) => row.serverId !== host.server.id),
    byServer([source(t1.id, generation, host.owner.id), source(t2.id, generation, host.owner.id)]),
  );
});

/** The legacy create-joint route, with `between` run once after the creation commits and before its first same-admin accept. */
async function createLegacyJointWith(baseUrl: string, host: Awaited<ReturnType<typeof seedHost>>, targets: Array<{ id: string; slug: string }>, between: (hostChannelId: string) => Promise<void>) {
  let ran = false;
  let hostChannelId = "";
  __setSameAdminAcceptBarrierForTests(async (inviteId) => {
    if (ran) return;
    ran = true;
    const [row] = await getDb().select({ jointChannelId: jointChannelInvites.jointChannelId }).from(jointChannelInvites).where(eq(jointChannelInvites.id, inviteId));
    const [hostProjection] = await getDb().select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
      .where(and(eq(jointChannelServers.jointChannelId, row!.jointChannelId), eq(jointChannelServers.serverId, host.server.id)));
    hostChannelId = hostProjection!.localChannelId;
    await between(hostChannelId);
  });
  try {
    const body = await expectStatus(await quietly(() => call(baseUrl, host.owner, "POST", "channels", {
      name: `src-legacy-${randomBytes(4).toString("hex")}`,
      visibility: "joint",
      jointInvites: targets.map((target) => ({ targetServerSlug: target.slug, invitedPeople: [`@${host.owner.name}`], sameAdmin: true })),
    }, host.server.id)), 200);
    assert.ok(ran, "the barrier ran before the same-admin accepts");
    return body.id as string;
  } finally {
    __setSameAdminAcceptBarrierForTests(null);
  }
}

test("the legacy create-joint route: a creator who left before the same-admin accepts is not re-added, and no target connects or records a source", async ({ app }) => {
  const host = await seedHost(app.baseUrl, { legacyJointCreation: true });
  const t1 = await seedTarget(host.owner);
  const t2 = await seedTarget(host.owner);
  const roomId = await createLegacyJointWith(app.baseUrl, host, [t1, t2], async (hostChannelId) => {
    await removeHuman(hostChannelId, host.owner.id, { self: true });
  });
  const jointId = await jointOf(roomId);
  assert.equal(await memberOf(jointId, host.owner.id), null, "not re-added by the creation's accepts");
  assert.notEqual((await projectionOn(roomId, t1.id))?.status, "active");
  assert.notEqual((await projectionOn(roomId, t2.id))?.status, "active");
  const sources = await sourcesOf(jointId, host.owner.id);
  assert.equal(sources.some((row) => row.serverId === t1.id || row.serverId === t2.id), false, "no target source");
});

test("the legacy create-joint route: a creator who left and rejoined another way before the same-admin accepts gets no source of the new membership, and no target connects", async ({ app }) => {
  const host = await seedHost(app.baseUrl, { legacyJointCreation: true });
  const t1 = await seedTarget(host.owner);
  const t2 = await seedTarget(host.owner);
  let created = 0;
  const roomId = await createLegacyJointWith(app.baseUrl, host, [t1, t2], async (hostChannelId) => {
    created = (await memberOf(await jointOf(hostChannelId), host.owner.id))!.generation;
    await removeHuman(hostChannelId, host.owner.id, { self: true });
    await addHuman(hostChannelId, host.owner.id);
  });
  const jointId = await jointOf(roomId);
  const rejoined = (await memberOf(jointId, host.owner.id))!.generation;
  assert.notEqual(rejoined, created, "a new membership");
  assert.notEqual((await projectionOn(roomId, t1.id))?.status, "active");
  assert.notEqual((await projectionOn(roomId, t2.id))?.status, "active");
  const sources = await sourcesOf(jointId, host.owner.id);
  assert.equal(sources.some((row) => row.serverId === t1.id || row.serverId === t2.id), false, "no target source of either membership");
});

test("my own servers on a channel already joint when the operation starts: the server connects and is a source of the membership the actor had at the start (host_direct, cindyz c6f0faee)", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const later = await seedTarget(host.owner);
  const room = await host.room();
  // The channel turning joint after the actor's invite was made (the race
  // connectOwnServersToChannel can meet); the route itself also takes a
  // joint channel's host projection (below, "Your servers" on a joint).
  const { invite } = await createDirectConnectInvite(room.id, host.owner.id, {});
  assert.equal(invite.origin, "host_direct");
  await convertToJoint(host, room.id);
  await __initializeInviteSourcesForTests(invite.id, host.owner.id, "direct");
  const jointId = await jointOf(room.id);
  const member = await memberOf(jointId, host.owner.id);
  assert.ok(member, "a member through the conversion");
  assert.deepEqual({ state: (await inviteRow(invite.id)).sourceState, generation: (await inviteRow(invite.id)).sourceGeneration },
    { state: "member_at_start", generation: member.generation }, "not the operation that created the joint: the membership it started from");
  const before = await sourcesOf(jointId, host.owner.id);

  // Connect with that invite (its token is thrown away: give it a known one).
  const token = randomBytes(32).toString("hex");
  await getDb().update(channelExternalInvites).set({ tokenHash: sha256(token) }).where(eq(channelExternalInvites.id, invite.id));
  await expectStatus(await quietly(() => call(app.baseUrl, host.owner, "POST", `external-invites/${token}/connect`, { serverId: later.id })), 200);
  assert.equal((await projectionOn(room.id, later.id))?.status, "active", "connected");
  assert.deepEqual(await sourcesOf(jointId, host.owner.id), byServer([...before, source(later.id, member.generation, host.owner.id)]), "the self-source, of that membership");
  assert.equal((await memberOf(jointId, host.owner.id))?.generation, member.generation, "no new membership");
});

test("every server waiting for approval: the first approval joins them, the second records its source (admitted by its approver)", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-c");
  const approver = await person(app.baseUrl, "src-c-approver");
  const m1 = await seedTarget(approver, [[invitee, "member"]]);
  const m2 = await seedTarget(approver, [[invitee, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
    { serverId: m1.id, approverUserId: approver.id },
    { serverId: m2.id, approverUserId: approver.id },
  ]), 200));
  assert.deepEqual({ state: (await inviteRow(invite.id)).sourceState, start: (await inviteRow(invite.id)).sourceStartGeneration }, { state: "awaiting_first_join", start: 0 });

  await expectStatus(await approve(app.baseUrl, approver, outcomes[m1.id]!.requestId!), 200);
  const jointId = await jointOf(room.id);
  const member = await memberOf(jointId, invitee.id);
  assert.ok(member);
  assert.deepEqual({ state: (await inviteRow(invite.id)).sourceState, generation: (await inviteRow(invite.id)).sourceGeneration }, { state: "joined", generation: member.generation });
  await expectStatus(await approve(app.baseUrl, approver, outcomes[m2.id]!.requestId!), 200);
  assert.deepEqual(await sourcesOf(jointId, invitee.id), byServer([source(m1.id, member.generation, approver.id), source(m2.id, member.generation, approver.id)]));
});

test("the second approval over a live recovery source of that server upgrades it to an ordinary admission by its approver (#wg-rbac:#23)", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-r");
  const approver = await person(app.baseUrl, "src-r-approver");
  const m1 = await seedTarget(approver, [[invitee, "member"]]);
  const m2 = await seedTarget(approver, [[invitee, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
    { serverId: m1.id, approverUserId: approver.id },
    { serverId: m2.id, approverUserId: approver.id },
  ]), 200));
  await expectStatus(await approve(app.baseUrl, approver, outcomes[m1.id]!.requestId!), 200);
  const jointId = await jointOf(room.id);
  const member = await memberOf(jointId, invitee.id);
  assert.ok(member);
  // What the ops recovery tool will write (written directly here).
  const tuple = { jointChannelId: jointId, userId: invitee.id, serverId: m2.id, generation: member.generation };
  const old = new Date("2020-01-01T00:00:00Z");
  await getDb().insert(jointChannelAdmissions).values({ ...tuple, kind: "recovery", admittedBy: null, admittedAt: old });
  await getDb().insert(jointAdmissionRecoveries).values({ ...tuple, runId: "run", approvalRef: "approval" });

  await expectStatus(await approve(app.baseUrl, approver, outcomes[m2.id]!.requestId!), 200);
  assert.deepEqual(await sourcesOf(jointId, invitee.id), byServer([source(m1.id, member.generation, approver.id), source(m2.id, member.generation, approver.id)]));
  const [row] = await getDb().select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, jointId),
    eq(jointChannelAdmissions.userId, invitee.id), eq(jointChannelAdmissions.serverId, m2.id)));
  assert.equal(row?.kind, "admission");
  assert.ok(row && row.admittedAt.getTime() > old.getTime());
  assert.equal((await getDb().select().from(jointAdmissionRecoveries).where(eq(jointAdmissionRecoveries.userId, invitee.id))).length, 1, "the recovery record stays");
});

test("a queued server whose turn comes after the person left is refused: nothing written, they are not re-added", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-d");
  const a = await seedTarget(invitee);
  const b = await seedTarget(invitee);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [{ serverId: a.id }, { serverId: b.id }]), 200);
  const reserved = await inviteRow(invite.id);
  assert.deepEqual({ state: reserved.sourceState, start: reserved.sourceStartGeneration }, { state: "awaiting_first_join", start: 0 });
  assert.equal((await runChannelConversionJob(reserved.connectConversionJobId!)).status, "done");
  assert.ok(await advanceExternalConnect(invite.id), "the first server connects");
  const queued = await inviteRow(invite.id);
  assert.deepEqual({ status: queued.status, head: queued.connectServerId, state: queued.sourceState, generation: queued.sourceGeneration },
    { status: "connecting", head: b.id, state: "joined", generation: 1 }, "moving to the next server keeps the source state");
  const jointId = await jointOf(room.id);

  await leave(room.id, a.id, invitee.id);
  const before = await sourcesOf(jointId, invitee.id);
  await quietly(() => advanceExternalConnect(invite.id));
  assert.equal(await memberOf(jointId, invitee.id), null, "not re-added");
  assert.equal(await projectionOn(room.id, b.id), null, "not connected");
  assert.deepEqual(await sourcesOf(jointId, invitee.id), before, "no source written");
  const done = await inviteRow(invite.id);
  assert.deepEqual({ status: done.status, state: done.sourceState, generation: done.sourceGeneration }, { status: "accepted", state: "joined", generation: 1 });
});

test("an approval landing after the person rejoined another way (a new membership) records no source for the old operation", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-e");
  const approver = await person(app.baseUrl, "src-e-approver");
  const a = await seedTarget(invitee);
  const c = await seedTarget(invitee);
  const m = await seedTarget(approver, [[invitee, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const first = await seedInvite(host, room.id, invitee.email);
  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, first.token, [
    { serverId: a.id },
    { serverId: m.id, approverUserId: approver.id },
  ]), 200));
  const jointId = await jointOf(room.id);
  assert.equal((await memberOf(jointId, invitee.id))?.generation, 1);
  await leave(room.id, a.id, invitee.id);
  // Back another way: a new membership.
  await joinAnotherWay(host, room.id, invitee, c.id);
  assert.equal((await memberOf(jointId, invitee.id))?.generation, 2);

  await expectStatus(await approve(app.baseUrl, approver, outcomes[m.id]!.requestId!), 409, "membership_changed");
  assert.equal(await projectionOn(room.id, m.id), null);
  const sources = await sourcesOf(jointId, invitee.id);
  assert.equal(sources.some((row) => row.serverId === m.id), false, "no source of either membership on the approved server");
  assert.deepEqual(sources.filter((row) => row.generation === 2), [source(c.id, 2, invitee.id)]);
});

test("a connection after the channel was archived is refused and records no source", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-f");
  const approver = await person(app.baseUrl, "src-f-approver");
  const m1 = await seedTarget(approver, [[invitee, "member"]]);
  const m2 = await seedTarget(approver, [[invitee, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const invite = await seedInvite(host, room.id, invitee.email);
  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, invite.token, [
    { serverId: m1.id, approverUserId: approver.id },
    { serverId: m2.id, approverUserId: approver.id },
  ]), 200));
  await expectStatus(await approve(app.baseUrl, approver, outcomes[m1.id]!.requestId!), 200);
  const jointId = await jointOf(room.id);
  const before = await sourcesOf(jointId, invitee.id);
  await archiveChannel(room.id, host.owner.id);
  const response = await approve(app.baseUrl, approver, outcomes[m2.id]!.requestId!);
  assert.equal(response.status, 409);
  assert.equal(await projectionOn(room.id, m2.id), null);
  assert.deepEqual(await sourcesOf(jointId, invitee.id), before, "no source written");
});

test("two operations racing for the first join: only the one that made the member records sources; the other never re-adds them", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-g");
  const approver = await person(app.baseUrl, "src-g-approver");
  const a = await seedTarget(invitee);
  const m1 = await seedTarget(approver, [[invitee, "member"]]);
  const m2 = await seedTarget(approver, [[invitee, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const slow = await seedInvite(host, room.id, invitee.email);
  const slowOutcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, slow.token, [
    { serverId: m1.id, approverUserId: approver.id },
    { serverId: m2.id, approverUserId: approver.id },
  ]), 200));
  // The other operation joins them first.
  await joinAnotherWay(host, room.id, invitee, a.id);
  assert.equal((await inviteRow(slow.id)).sourceState, "awaiting_first_join");
  const jointId = await jointOf(room.id);

  // The slow one's approval: they are a member already (another way).
  await expectStatus(await approve(app.baseUrl, approver, slowOutcomes[m1.id]!.requestId!), 200);
  assert.equal((await projectionOn(room.id, m1.id))?.status, "active", "the server still connects");
  assert.equal((await inviteRow(slow.id)).sourceState, "no_sources");
  assert.deepEqual(await sourcesOf(jointId, invitee.id), [source(a.id, 1, invitee.id)], "only the operation that joined them");

  // Left: the old operation's last approval must not bring them back.
  await leave(room.id, a.id, invitee.id);
  await expectStatus(await approve(app.baseUrl, approver, slowOutcomes[m2.id]!.requestId!), 409, "membership_changed");
  assert.equal(await memberOf(jointId, invitee.id), null, "not re-added");
  assert.equal(await projectionOn(room.id, m2.id), null);
});

test("waiting for the first join: a person who joined and left another way meanwhile is not admitted by it", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-g2");
  const approver = await person(app.baseUrl, "src-g2-approver");
  const a = await seedTarget(invitee);
  const m = await seedTarget(approver, [[invitee, "member"]]);
  const room = await host.room();
  await convertToJoint(host, room.id);
  const slow = await seedInvite(host, room.id, invitee.email);
  const outcomes = outcomesOf(await expectStatus(await connectServers(app.baseUrl, invitee, slow.token, [{ serverId: m.id, approverUserId: approver.id }]), 200));
  await joinAnotherWay(host, room.id, invitee, a.id);
  await leave(room.id, a.id, invitee.id);
  const jointId = await jointOf(room.id);
  const before = await sourcesOf(jointId, invitee.id);

  await expectStatus(await approve(app.baseUrl, approver, outcomes[m.id]!.requestId!), 409, "membership_changed");
  assert.equal(await memberOf(jointId, invitee.id), null, "not re-added");
  assert.equal(await projectionOn(room.id, m.id), null);
  assert.deepEqual(await sourcesOf(jointId, invitee.id), before);
});

test("admitted_by is the actor: an admin's add, a joint invite accept, a batch accept", async ({ seed }) => {
  const owner = await seed.human();
  const acceptor = await seed.human();
  const newcomer = await seed.human();
  const h = await seed.server({ owner, members: [newcomer] });
  const p1 = await seed.server({ owner: acceptor });
  const p2 = await seed.server({ owner: acceptor });
  const p3 = await seed.server({ owner: acceptor });
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, h.id));
  for (const peer of [p1, p2, p3]) await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, peer.id));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: owner.id, name: "admitted-by", targetServerSlug: p1.slug, invitedPeople: [`@${acceptor.name}`] });
  const jointId = created.jointChannel.id;
  assert.deepEqual(await sourcesOf(jointId, owner.id), [source(h.id, 1, owner.id)], "creation: the creator admitted themselves");

  await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: p1.id, acceptedByUserId: acceptor.id });
  assert.deepEqual(await sourcesOf(jointId, acceptor.id), [source(p1.id, 1, acceptor.id)], "single accept");

  const hostChannel = (await getChannel(created.channel.id))!;
  const added = await addHumanWithMembershipSystemMessage({ channel: hostChannel, userId: newcomer.id, userName: newcomer.name, causalActor: { type: "user", id: owner.id } });
  assert.equal(added.added, true);
  assert.deepEqual(await sourcesOf(jointId, newcomer.id), [source(h.id, 1, owner.id)], "admin add");

  // Batch: a second person accepts two servers at once.
  const batcher = await seed.human();
  const q1 = await seed.server({ owner: batcher });
  const q2 = await seed.server({ owner: batcher });
  for (const peer of [q1, q2]) await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, peer.id));
  const inviteIds: string[] = [];
  for (const peer of [q1, q2]) {
    const result = await inviteServerToJointChannel({ localChannelId: created.channel.id, fromServerId: h.id, invitedByUserId: owner.id, targetServerSlug: peer.slug, invitedPeople: [`@${batcher.name}`] });
    inviteIds.push(...result.invites.map((invite) => invite.id));
  }
  await acceptJointChannelInvites({ inviteIds, acceptedByUserId: batcher.id });
  const batch = await sourcesOf(jointId, batcher.id);
  assert.equal(batch.length, 2);
  assert.ok(batch.every((row) => row.admittedBy === batcher.id), JSON.stringify(batch));
});

test("a mention add of someone already a joint member writes no channel_humans row", async ({ db, seed }) => {
  const owner = await seed.human();
  const peer = await seed.human();
  const a = await seed.server({ owner, members: [peer] });
  const b = await seed.server({ owner, members: [peer] });
  const joint = await createJointChannel({ hostServerId: a.id, createdByUserId: owner.id, name: "mention-add", targetServerSlug: b.slug, invitedPeople: [`@${owner.name}`] });
  const target = await acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: b.id, acceptedByUserId: owner.id });
  // The peer joins on B: a joint member, with no row on A's projection.
  assert.equal(await addHuman(target.id, peer.id), true);
  assert.ok(await memberOf(joint.jointChannel.id, peer.id));
  const hostRow = () => db.select().from(channelHumans).where(and(eq(channelHumans.channelId, joint.channel.id), eq(channelHumans.userId, peer.id)));
  assert.equal((await hostRow()).length, 0);
  const sourcesBefore = await sourcesOf(joint.jointChannel.id, peer.id);

  // A mention add reaches a joint channel through one of its conversations (a task's).
  await enableTaskV2ConversationsForServer(a.id);
  const created = await createTasks(joint.jointChannel.canonicalChannelId, "user", owner.id, [{ title: "mention add" }], { initiatingServerId: a.id });
  const discussion = await ensureTaskConversation(created.tasks[0]!.id, { initiatingServerId: a.id, createdByUserId: owner.id });
  const localTask = discussion?.conversation.localByServer.get(a.id);
  assert.ok(discussion && localTask);
  const message = await createMessage(discussion.conversation.canonicalChannelId, "user", owner.id, "mention add of a joint member");
  const [mention] = await db.insert(messageMentions).values({ messageId: message.id, messageSeq: message.seq,
    serverId: a.id, channelId: localTask.localChannelId, targetType: "user", targetId: peer.id,
    handleAtSendTime: peer.name, notifiableAtSend: false }).returning();
  const result = await executeMentionActionId(mention!.id, a.id, "user", owner.id, "add");
  assert.equal(result.status, "delivered", JSON.stringify(result));
  assert.equal((await hostRow()).length, 0, "no legacy row for a current joint member");
  assert.deepEqual(await sourcesOf(joint.jointChannel.id, peer.id), sourcesBefore);

  // A mention add that actually makes someone a member: admitted by the person who acted.
  const fresh = await seed.human();
  await db.insert(serverMembers).values({ serverId: a.id, userId: fresh.id, role: "member" });
  assert.equal(await memberOf(joint.jointChannel.id, fresh.id), null);
  const [freshMention] = await db.insert(messageMentions).values({ messageId: message.id, messageSeq: message.seq,
    serverId: a.id, channelId: localTask.localChannelId, targetType: "user", targetId: fresh.id,
    handleAtSendTime: fresh.name, notifiableAtSend: false }).returning();
  const freshResult = await executeMentionActionId(freshMention!.id, a.id, "user", owner.id, "add");
  assert.equal(freshResult.status, "delivered", JSON.stringify(freshResult));
  assert.ok(await memberOf(joint.jointChannel.id, fresh.id), "a member now");
  assert.deepEqual(await sourcesOf(joint.jointChannel.id, fresh.id), [source(a.id, 1, owner.id)], "admitted by the mentioner");
});

// ── Origin (channel_external_invites.origin) and an existing member's own servers ──

async function sourceExit(on: boolean) {
  await getDb().insert(featureFlags).values({ key: JOINT_SOURCE_EXIT_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: on,
    randomizationUnit: "server", salt: "external-invite-sources" })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: on } });
}

/** A host admin in the joint (made one by the conversion, through the host), owning `owned` servers of their own. */
async function jointWithAdmin(baseUrl: string, label: string) {
  const host = await seedHost(baseUrl);
  const admin = await person(baseUrl, label);
  await getDb().insert(serverMembers).values({ serverId: host.server.id, userId: admin.id, role: "admin" });
  const room = await host.room();
  await addHuman(room.id, admin.id);
  await convertToJoint(host, room.id);
  const jointId = await jointOf(room.id);
  const member = await memberOf(jointId, admin.id);
  assert.ok(member, "in the joint through the host");
  return { host, admin, room, jointId, generation: member.generation };
}

const ownInvites = async (channelId: string, email: string) => (await getDb().select().from(channelExternalInvites)
  .where(and(eq(channelExternalInvites.channelId, channelId), eq(channelExternalInvites.email, email))));

test("Your servers by a host admin already in the joint: each server connected is a source of the membership they had (admitted by them); with joint_source_exit_v1 on, leaving the host keeps them in the joint through it", async ({ app }) => {
  const { host, admin, room, jointId, generation } = await jointWithAdmin(app.baseUrl, "src-own-admin");
  const s1 = await seedTarget(admin);
  const s2 = await seedTarget(admin);
  // A witness with the host as their only source: the same leave ends their membership.
  const other = await person(app.baseUrl, "src-own-witness");
  await getDb().insert(serverMembers).values({ serverId: host.server.id, userId: other.id, role: "member" });
  await addHuman(room.id, other.id);
  assert.ok(await memberOf(jointId, other.id));
  const before = await sourcesOf(jointId, admin.id);
  assert.deepEqual(before.map((row) => [row.serverId, row.ended]), [[host.server.id, false]], "the host alone, from the conversion");

  const outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s1.id, s2.id]), 200));
  assert.deepEqual([outcomes[s1.id]!.state, outcomes[s2.id]!.state], ["connected", "connected"]);
  const [invite] = await ownInvites(room.id, admin.email);
  assert.deepEqual({ origin: invite!.origin, state: invite!.sourceState, generation: invite!.sourceGeneration },
    { origin: "host_direct", state: "member_at_start", generation });
  assert.equal((await memberOf(jointId, admin.id))?.generation, generation, "no new membership");
  assert.deepEqual(await sourcesOf(jointId, admin.id), byServer([...before, source(s1.id, generation, admin.id), source(s2.id, generation, admin.id)]));
  const [admission] = await getDb().select().from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, jointId), eq(jointChannelAdmissions.userId, admin.id), eq(jointChannelAdmissions.serverId, s1.id)));
  assert.equal(admission?.kind, "admission", "an ordinary admission (not a recovery), as every other connection's source");

  await sourceExit(true);
  await removeMember(host.server.id, admin.id, { reason: "left" });
  await removeMember(host.server.id, other.id, { reason: "left" });
  assert.equal(await memberOf(jointId, other.id), null, "witness: the host was their only source, so leaving it ends the membership");
  assert.equal((await memberOf(jointId, admin.id))?.generation, generation, "still in the joint, the same membership");
  const after = await sourcesOf(jointId, admin.id);
  assert.deepEqual(after.map((row) => [row.serverId, row.ended]), byServer([
    { serverId: host.server.id, ended: true }, { serverId: s1.id, ended: false }, { serverId: s2.id, ended: false },
  ]).map((row) => [row.serverId, row.ended]));
  const s1Local = (await projectionOn(room.id, s1.id))!.localChannelId;
  assert.equal(await canUserAccessChannel(s1Local, admin.id, asServerId(s1.id)), true, "entered through their own server");
});

test("Your servers by a member who leaves and rejoins (a new generation) after the operation started: refused membership_changed, no source, nothing re-added", async ({ app }) => {
  const { host, admin, room, jointId, generation } = await jointWithAdmin(app.baseUrl, "src-own-rejoin");
  const s1 = await seedTarget(admin);
  __setInviteSourcesStartedBarrierForTests(async () => {
    __setInviteSourcesStartedBarrierForTests(null);
    await removeHuman(room.id, admin.id, { self: true });
    await addHuman(room.id, admin.id);
  });
  let outcomes: Record<string, Outcome>;
  try {
    outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s1.id]), 200));
  } finally {
    __setInviteSourcesStartedBarrierForTests(null);
  }
  assert.deepEqual({ state: outcomes[s1.id]!.state, code: outcomes[s1.id]!.code }, { state: "refused", code: "membership_changed" });
  const rejoined = await memberOf(jointId, admin.id);
  assert.ok(rejoined && rejoined.generation !== generation, "the rejoin's own membership");
  assert.equal(await projectionOn(room.id, s1.id), null, "not connected");
  assert.equal((await sourcesOf(jointId, admin.id)).some((row) => row.serverId === s1.id), false, "no source of either membership");
  const [invite] = await ownInvites(room.id, admin.email);
  assert.deepEqual({ state: invite!.sourceState, generation: invite!.sourceGeneration, status: invite!.status },
    { state: "member_at_start", generation, status: "revoked" }, "bound to the start's membership; withdrawn, nothing connected");
});

test("Your servers by a member who left after the operation started: refused membership_changed, not re-added", async ({ app }) => {
  const { host, admin, room, jointId } = await jointWithAdmin(app.baseUrl, "src-own-left");
  const s1 = await seedTarget(admin);
  __setInviteSourcesStartedBarrierForTests(async () => {
    __setInviteSourcesStartedBarrierForTests(null);
    await removeHuman(room.id, admin.id, { self: true });
  });
  let outcomes: Record<string, Outcome>;
  try {
    outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s1.id]), 200));
  } finally {
    __setInviteSourcesStartedBarrierForTests(null);
  }
  assert.deepEqual({ state: outcomes[s1.id]!.state, code: outcomes[s1.id]!.code }, { state: "refused", code: "membership_changed" });
  assert.equal(await memberOf(jointId, admin.id), null, "not re-added");
  assert.equal(await projectionOn(room.id, s1.id), null);
  assert.equal((await sourcesOf(jointId, admin.id)).some((row) => row.serverId === s1.id), false);
});

for (const origin of ["external_invite", null] as const) {
  test(`Your servers over an open ${origin ?? "legacy (NULL-origin)"} invite to the actor's own address: that invite is revoked (by them), never relabelled, and a fresh host_direct one connects and records the source (Tenny d47d7933)`, async ({ app }) => {
    const { host, admin, room, jointId, generation } = await jointWithAdmin(app.baseUrl, "src-own-replace");
    const s1 = await seedTarget(admin);
    // Inserted as the release before the column (NULL), or as an emailed invite.
    const old = await seedInvite(host, room.id, admin.email);
    if (origin) await getDb().update(channelExternalInvites).set({ origin }).where(eq(channelExternalInvites.id, old.id));
    const before = await sourcesOf(jointId, admin.id);

    const outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s1.id]), 200));
    assert.equal(outcomes[s1.id]!.state, "connected");
    assert.deepEqual(await sourcesOf(jointId, admin.id), byServer([...before, source(s1.id, generation, admin.id)]), "the source, of the membership they had");
    const revoked = await inviteRow(old.id);
    assert.deepEqual({ status: revoked.status, by: revoked.revokedByUserId, decided: revoked.decidedAt !== null, origin: revoked.origin, state: revoked.sourceState },
      { status: "revoked", by: admin.id, decided: true, origin, state: null }, "revoked as revokeExternalInvite does; origin kept, never used");
    const rows = (await ownInvites(room.id, admin.email)).filter((row) => row.id !== old.id);
    assert.equal(rows.length, 1);
    assert.deepEqual({ origin: rows[0]!.origin, status: rows[0]!.status, state: rows[0]!.sourceState, generation: rows[0]!.sourceGeneration },
      { origin: "host_direct", status: "accepted", state: "member_at_start", generation });
  });
}

test("Your servers over an open host_direct invite of the actor's: reused as before (no revoke)", async ({ app }) => {
  const { host, admin, room, jointId, generation } = await jointWithAdmin(app.baseUrl, "src-own-reuse");
  const s1 = await seedTarget(admin);
  const { invite: open } = await createDirectConnectInvite(room.id, admin.id, {});
  assert.deepEqual({ origin: open.origin, status: open.status }, { origin: "host_direct", status: "pending" });

  const outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s1.id]), 200));
  assert.equal(outcomes[s1.id]!.state, "connected");
  const rows = await ownInvites(room.id, admin.email);
  assert.deepEqual(rows.map((row) => [row.id, row.status]), [[open.id, "accepted"]], "the same invite, nothing revoked");
  assert.ok((await sourcesOf(jointId, admin.id)).some((row) => row.serverId === s1.id && row.generation === generation));
});

test("Your servers while an emailed invite to the actor's own address is connecting: refused, nothing changed (its conversion running: the channel's writer fence; after it: connecting, 409)", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const admin = await person(app.baseUrl, "src-own-busy");
  await getDb().insert(serverMembers).values({ serverId: host.server.id, userId: admin.id, role: "admin" });
  const s1 = await seedTarget(admin);
  const s2 = await seedTarget(admin);
  const room = await host.room();
  await addHuman(room.id, admin.id);
  const old = await seedInvite(host, room.id, admin.email);
  await getDb().update(channelExternalInvites).set({ origin: "external_invite" }).where(eq(channelExternalInvites.id, old.id));
  await expectStatus(await quietly(() => call(app.baseUrl, admin, "POST", `external-invites/${old.token}/connect`, { serverId: s1.id })), 202);
  const unchanged = async (expected: Awaited<ReturnType<typeof inviteRow>>) => {
    assert.deepEqual(await inviteRow(old.id), expected, "the connecting invite untouched");
    assert.deepEqual((await ownInvites(room.id, admin.email)).map((row) => row.id), [old.id], "no new invite");
  };

  // Conversion running: refused before this code runs (ChannelConversionInProgressError
  // from the channel's writer fence; the route answers it 500, as on staging).
  const converting = await inviteRow(old.id);
  assert.deepEqual({ status: converting.status, phase: converting.connectPhase }, { status: "connecting", phase: "conversion" });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    assert.equal((await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s2.id])).ok, false);
  } finally {
    errors.mockRestore();
  }
  await unchanged(converting);

  // Conversion committed, the connection still to come: the existing refusal.
  assert.equal((await runChannelConversionJob(converting.connectConversionJobId!)).status, "done");
  const connecting = await inviteRow(old.id);
  assert.deepEqual({ status: connecting.status, phase: connecting.connectPhase }, { status: "connecting", phase: "connection" });
  await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s2.id]), 409, "connecting");
  await unchanged(connecting);
});

test("a legacy invite (no origin) on a private channel: the invitee's connection converts it and the worker completes it as before", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-legacy-worker");
  const a = await seedTarget(invitee);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await quietly(() => call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect`, { serverId: a.id })), 202);
  assert.equal((await inviteRow(invite.id)).status, "connecting");
  await quietly(() => driveWorker(invite.id));
  const row = await inviteRow(invite.id);
  assert.deepEqual({ origin: row.origin, status: row.status, outcome: row.outcome, state: row.sourceState }, { origin: null, status: "accepted", outcome: "server", state: "joined" });
  const jointId = await jointOf(room.id);
  const member = await memberOf(jointId, invitee.id);
  assert.ok(member);
  assert.deepEqual(await sourcesOf(jointId, invitee.id), [source(a.id, member.generation, invitee.id)]);
});

test("an origin this release does not connect (self_connect, or a newer release's value): the worker never connects it, writes no member or source, only puts it off; the invitee's own route is a 404", async ({ app, db }) => {
  const host = await seedHost(app.baseUrl);
  const invitee = await person(app.baseUrl, "src-unknown");
  const a = await seedTarget(invitee);
  const room = await host.room();
  const invite = await seedInvite(host, room.id, invitee.email);
  await expectStatus(await quietly(() => call(app.baseUrl, invitee, "POST", `external-invites/${invite.token}/connect`, { serverId: a.id })), 202);
  const reserved = await inviteRow(invite.id);
  assert.equal((await runChannelConversionJob(reserved.connectConversionJobId!)).status, "done");
  assert.equal((await inviteRow(invite.id)).connectPhase, "connection");
  const jointId = await jointOf(room.id);

  // self_connect: allowed by the CHECK, connected only by a later release.
  // Then a value no release here knows (the CHECK widened by a newer one).
  await db.execute(sql`ALTER TABLE channel_external_invites DROP CONSTRAINT channel_external_invites_origin_known`);
  for (const origin of ["self_connect", "from_a_newer_release"]) {
    await db.execute(sql`UPDATE channel_external_invites SET origin = ${origin}, connect_next_attempt_at = NULL WHERE id = ${invite.id}::uuid`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      assert.equal(await quietly(() => advanceExternalConnect(invite.id)), null);
      assert.ok(errors.mock.calls.some((args) => String(args[0]).includes("origin this release does not connect")), "logged");
    } finally {
      errors.mockRestore();
    }
    const row = await inviteRow(invite.id);
    assert.deepEqual({ status: row.status, phase: row.connectPhase, server: row.connectServerId, generation: row.connectGeneration },
      { status: "connecting", phase: "connection", server: a.id, generation: reserved.connectGeneration }, `${origin}: left as it was`);
    assert.ok(row.connectNextAttemptAt && row.connectNextAttemptAt > new Date(), "put off, not holding up other invites");
    assert.match(row.connectLastError ?? "", /unknown origin/);
    assert.equal(await projectionOn(room.id, a.id), null, `${origin}: not connected`);
    assert.equal(await memberOf(jointId, invitee.id), null, `${origin}: no member`);
    assert.deepEqual(await sourcesOf(jointId, invitee.id), [], `${origin}: no source`);
  }

  // A pending invite of an unknown origin on the joint channel: the invitee's connect is the neutral 404, nothing set.
  const second = await person(app.baseUrl, "src-unknown-2");
  const b = await seedTarget(second);
  const pending = await seedInvite(host, room.id, second.email);
  await db.execute(sql`UPDATE channel_external_invites SET origin = 'from_a_newer_release' WHERE id = ${pending.id}::uuid`);
  await expectStatus(await quietly(() => call(app.baseUrl, second, "POST", `external-invites/${pending.token}/connect`, { serverId: b.id })), 404);
  const untouched = await inviteRow(pending.id);
  assert.deepEqual({ status: untouched.status, state: untouched.sourceState }, { status: "pending", state: null });
  assert.equal(await projectionOn(room.id, b.id), null);
});

test("every creation path writes its origin: an email send and its resend external_invite, Your servers host_direct; no new row is NULL", async ({ app }) => {
  const host = await seedHost(app.baseUrl);
  const room = await host.room();
  const own = await seedTarget(host.owner);
  const outsiders = [`src-origin-a-${randomBytes(4).toString("hex")}@slock.test`, `src-origin-b-${randomBytes(4).toString("hex")}@slock.test`];

  const sent = await expectStatus(await quietly(() => call(app.baseUrl, host.owner, "POST", `channels/${room.id}/external-invites`, { emails: outsiders }, host.server.id)), 200);
  const sentIds = (sent.sent as Array<{ id: string }>).map((row) => row.id);
  assert.equal(sentIds.length, 2);
  const resent = await expectStatus(await quietly(() => call(app.baseUrl, host.owner, "POST", `channels/${room.id}/external-invites/${sentIds[0]}/resend`, undefined, host.server.id)), 200);
  await expectStatus(await connectOwn(app.baseUrl, host.owner, host.server.id, room.id, [own.id]), 200);
  const [direct] = await ownInvites(room.id, host.owner.email);

  const origins = Object.fromEntries((await getDb().select({ id: channelExternalInvites.id, origin: channelExternalInvites.origin }).from(channelExternalInvites))
    .map((row) => [row.id, row.origin]));
  assert.deepEqual(origins, {
    [sentIds[0]!]: "external_invite",
    [sentIds[1]!]: "external_invite",
    [resent.id as string]: "external_invite",
    [direct!.id]: "host_direct",
  });
});

test("insertExternalInvites is the only production insert into channel_external_invites", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const offenders: string[] = [];
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file) || file.startsWith(`test${pathSep}`)) continue;
    const text = readFileSync(pathJoin(root, file), "utf8");
    const inserts = (text.match(/\.insert\(channelExternalInvites\)/g) ?? []).length + (text.match(/INSERT INTO\s+"?channel_external_invites/gi) ?? []).length;
    if (inserts > 0 && !(file === pathJoin("services", "externalInviteService.ts") && inserts === 1)) offenders.push(`${file}: ${inserts}`);
  }
  assert.deepEqual(offenders, []);
  const helper = readFileSync(pathJoin(root, "services", "externalInviteService.ts"), "utf8");
  assert.match(helper, /export function insertExternalInvites\([^)]*\) \{\n {2}return executor\.insert\(channelExternalInvites\)/);
});

// ── Reconnecting one's own server after its source ended (Tenny 627d2ea6) ──

/** The full source row of (J, user, generation, server), or null. */
async function admissionRow(jointId: string, userId: string, generation: number, serverId: string) {
  const [row] = await getDb().select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, jointId),
    eq(jointChannelAdmissions.userId, userId), eq(jointChannelAdmissions.generation, generation), eq(jointChannelAdmissions.serverId, serverId)));
  return row ?? null;
}

async function liveSource(jointId: string, userId: string, serverId: string): Promise<boolean> {
  const result = await getDb().execute<{ live: boolean }>(sql`SELECT ${jointHumanCurrentSourceSql(sql`${jointId}::uuid`, sql`${userId}::uuid`, sql`${serverId}::uuid`)} AS live`);
  return result.rows[0]!.live;
}

const readmittedEvents = () => getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.source_readmitted"));

/**
 * X (a host admin in the joint through the host) connected S and S2 of theirs
 * with "Your servers" (sources of generation g); Y joined through S. Then S
 * and S2 disconnected themselves: X's S and S2 sources and Y's S source ended,
 * X still in the joint through the host.
 */
async function endedOwnSources(baseUrl: string) {
  const world = await jointWithAdmin(baseUrl, "src-reopen");
  const { host, admin, room, jointId, generation } = world;
  const s = await seedTarget(admin);
  const s2 = await seedTarget(admin);
  await expectStatus(await connectOwn(baseUrl, admin, host.server.id, room.id, [s.id, s2.id]), 200);
  const other = await person(baseUrl, "src-reopen-other");
  await getDb().insert(serverMembers).values({ serverId: s.id, userId: other.id, role: "member" });
  await addHuman((await projectionOn(room.id, s.id))!.localChannelId, other.id);
  const otherGeneration = (await memberOf(jointId, other.id))!.generation;
  assert.equal((await admissionRow(jointId, other.id, otherGeneration, s.id))?.endedAt, null);
  for (const server of [s, s2]) await disconnectJointChannel((await projectionOn(room.id, server.id))!.localChannelId, admin.id);
  // The disconnects' cleanup, as the departure worker runs it: a reconnect waits for it (assertJointReconnectReady).
  for (const departure of await getDb().select({ id: jointMembershipDepartures.id }).from(jointMembershipDepartures)) {
    for (let batch = 0; batch < 10 && !(await cleanJointMembershipDepartureBatch(departure.id as JointMembershipDepartureId, { revoke: async () => {} })); batch += 1);
  }
  const endedS = await admissionRow(jointId, admin.id, generation, s.id);
  assert.ok(endedS?.endedAt, "X's S source ended with S's disconnect");
  assert.ok((await admissionRow(jointId, admin.id, generation, s2.id))?.endedAt);
  assert.ok((await admissionRow(jointId, other.id, otherGeneration, s.id))?.endedAt, "Y's S source ended too");
  assert.equal((await memberOf(jointId, admin.id))?.generation, generation, "X still in, through the host");
  return { ...world, s, s2, other, otherGeneration, endedS };
}

test("Your servers connecting one's own server again after its source ended: exactly that row is reopened (admitted by them now), with channel.source_readmitted on the host carrying the old row; nobody else's ended rows change", async ({ app }) => {
  const { host, admin, room, jointId, generation, s, s2, other, otherGeneration, endedS } = await endedOwnSources(app.baseUrl);
  const otherBefore = await admissionRow(jointId, other.id, otherGeneration, s.id);
  const s2Before = await admissionRow(jointId, admin.id, generation, s2.id);

  const outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s.id]), 200));
  assert.equal(outcomes[s.id]!.state, "connected", JSON.stringify(outcomes[s.id]));
  assert.equal(await liveSource(jointId, admin.id, s.id), true, "a live S source of their current membership");
  const reopened = await admissionRow(jointId, admin.id, generation, s.id);
  assert.ok(reopened);
  assert.deepEqual({ ended: reopened.endedAt, by: reopened.admittedBy, kind: reopened.kind, newer: reopened.admittedAt > endedS!.admittedAt },
    { ended: null, by: admin.id, kind: "admission", newer: true });
  assert.deepEqual(await admissionRow(jointId, other.id, otherGeneration, s.id), otherBefore, "Y's ended S row untouched");
  assert.deepEqual(await admissionRow(jointId, admin.id, generation, s2.id), s2Before, "X's ended S2 row untouched");

  const events = await readmittedEvents();
  assert.equal(events.length, 1);
  const [event] = events;
  assert.deepEqual({ serverId: event!.serverId, actorId: event!.actorId, targetType: event!.targetType, targetId: event!.targetId },
    { serverId: host.server.id, actorId: admin.id, targetType: "user", targetId: admin.id });
  const metadata = event!.metadata as Record<string, unknown>;
  assert.deepEqual({
    jointChannelId: metadata.jointChannelId, hostServerId: metadata.hostServerId, channelId: metadata.channelId, sourceServerId: metadata.sourceServerId,
    userId: metadata.userId, generation: metadata.generation, previousAdmittedBy: metadata.previousAdmittedBy, previousKind: metadata.previousKind,
  }, {
    jointChannelId: jointId, hostServerId: host.server.id, channelId: room.id, sourceServerId: s.id,
    userId: admin.id, generation, previousAdmittedBy: endedS!.admittedBy, previousKind: endedS!.kind,
  });
  assert.equal(new Date(metadata.previousEndedAt as string).getTime(), endedS!.endedAt!.getTime());
  assert.equal(new Date(metadata.previousAdmittedAt as string).getTime(), endedS!.admittedAt.getTime());
});

test("connecting one's own server again after leaving and rejoining (a new generation): refused, the ended row stays ended, nothing written", async ({ app }) => {
  const { host, admin, room, jointId, generation, s, endedS } = await endedOwnSources(app.baseUrl);
  __setInviteSourcesStartedBarrierForTests(async () => {
    __setInviteSourcesStartedBarrierForTests(null);
    await removeHuman(room.id, admin.id, { self: true });
    await addHuman(room.id, admin.id);
  });
  let outcomes: Record<string, Outcome>;
  try {
    outcomes = outcomesOf(await expectStatus(await connectOwn(app.baseUrl, admin, host.server.id, room.id, [s.id]), 200));
  } finally {
    __setInviteSourcesStartedBarrierForTests(null);
  }
  assert.deepEqual({ state: outcomes[s.id]!.state, code: outcomes[s.id]!.code }, { state: "refused", code: "membership_changed" });
  assert.deepEqual(await admissionRow(jointId, admin.id, generation, s.id), endedS, "not reopened");
  const rejoined = (await memberOf(jointId, admin.id))!.generation;
  assert.notEqual(rejoined, generation);
  assert.equal(await admissionRow(jointId, admin.id, rejoined, s.id), null, "no source of the new membership");
  assert.equal((await projectionOn(room.id, s.id)), null, "not connected");
  assert.deepEqual(await readmittedEvents(), []);
});
