import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { asServerId, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { Database } from "../db";
import {
  channelExternalInvites,
  channelHumans,
  channels,
  computers,
  featureFlags,
  inboxTargetMuteStates,
  integrationAuditEvents,
  jointChannelAdmissions,
  jointChannelMembers,
  jointChannels,
  jointChannelServers,
  serverMembers,
  servers,
  threadFollows,
  userChannelDisplayPrefs,
  userChannelReadCursors,
} from "../db/schema";
import { acceptJointChannelInvite, addHuman, canUserAccessChannel, createChannel, createJointChannel } from "../services/channelService";
import { runChannelConversionJob } from "../services/channelConversionService";
import { runChannelConversionWorkerPass } from "../services/channelConversionWorker";
import { __setSelfConnectHookForTests } from "../services/externalInviteConnectService";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";
import { addMember, removeMember } from "../services/serverService";
import { matchAssistantOwnerActionRoute } from "../services/assistantOwnerActions";
import { createApiTest } from "../test/integration/apiTest";
import { createHttpClient } from "../test/integration/http";
import type { createSeed } from "../test/integration/seed";
import { enableExternalChannelsFlag, storeRetiredMemberConnectFlag } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { setJointFlags } from "../test/jointSourceExitScenario";
import { assertNoDmNotice, channelSystemLines, storedSystemMessages, workerPublish } from "../test/externalChannelSystemMessages";

/**
 * A channel member connects a server they own or administer to the channel
 * (POST /api/channels/:id/connect-my-servers; jointMemberConnectService,
 * design v3 §9): through the real route and the real worker.
 */
const test = createApiTest();

type Seed = ReturnType<typeof createSeed>;
type Human = Awaited<ReturnType<Seed["human"]>>;
type Server = { id: string };

async function founder(db: Database, ...serverIds: string[]) {
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, serverIds));
}

/** A Guest's joint membership through the host copy it is bound to (the mirror's join, as the Guest accept makes it). */
async function joinGuest(db: Database, hostChannelId: string, guestId: string, actorUserId: string) {
  await db.transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { channelIds: [hostChannelId] }, "join");
    await mirror.apply([guestId], { actorUserId });
  });
}

/**
 * Host H (owner, admin, a member outside the channel) and participant P share
 * joint J. X is in J through P and owns S; Y is in J through P and a member
 * of S; Z is a member of S only. G is H's Guest bound to H's copy (in J
 * through it) and owns SG.
 */
async function world(db: Database, seed: Seed, options: { sourceExit?: boolean; flags?: boolean } = {}) {
  await setJointFlags(db, options.sourceExit ?? false);
  const hostOwner = await seed.human(), hostAdmin = await seed.human(), hostOutsider = await seed.human();
  const peerOwner = await seed.human(), x = await seed.human(), y = await seed.human(), z = await seed.human(), g = await seed.human();
  const h = await seed.server({ owner: hostOwner, members: [hostOutsider] });
  await addMember(h.id, hostAdmin.id, "admin");
  const p = await seed.server({ owner: peerOwner, members: [x, y] });
  const s = await seed.server({ owner: x, members: [y, z] });
  const sg = await seed.server({ owner: g });
  await founder(db, h.id, p.id, s.id, sg.id);
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name: `mc-${h.slug}`.slice(0, 40),
    targetServerSlug: p.slug, invitedPeople: [`@${peerOwner.name}`], userIds: [hostAdmin.id] });
  const pLocal = (await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: p.id, acceptedByUserId: peerOwner.id })).id;
  await addHuman(pLocal, x.id);
  await addHuman(pLocal, y.id);
  // The one gate (#wg-rbac:#55): external_channels_v1 for the host, nothing else.
  if (options.flags !== false) await enableExternalChannelsFlag(h.id);
  await seedBoundGuest({ serverId: h.id, userId: g.id, channelId: created.channel.id });
  await joinGuest(db, created.channel.id, g.id, hostOwner.id);
  return { hostOwner, hostAdmin, hostOutsider, peerOwner, x, y, z, g, h, p, s, sg, J: created.jointChannel.id, hLocal: created.channel.id, pLocal };
}

type World = Awaited<ReturnType<typeof world>>;

async function connect(baseUrl: string, who: { id: string }, server: Server, channelId: string, serverIds: unknown) {
  const response = await createHttpClient(baseUrl).as(who, server).request(`/api/channels/${channelId}/connect-my-servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverIds }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

type Outcome = { serverId: string; state: string; code?: string; status?: number; channelId?: string };
const outcomes = (body: Record<string, unknown>) => Object.fromEntries((body.servers as Outcome[]).map((row) => [row.serverId, row]));

async function member(db: Database, jointId: string, userId: string) {
  const [row] = await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, jointId), eq(jointChannelMembers.userId, userId)));
  return row ?? null;
}

async function sources(db: Database, jointId: string, userId: string) {
  return (await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, jointId), eq(jointChannelAdmissions.userId, userId))))
    .map((row) => ({ serverId: row.serverId, generation: row.generation, admittedBy: row.admittedBy, ended: row.endedAt !== null }))
    .sort((a, b) => a.serverId.localeCompare(b.serverId));
}

async function projection(db: Database, jointId: string, serverId: string) {
  const [row] = await db.select().from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, jointId), eq(jointChannelServers.serverId, serverId), eq(jointChannelServers.status, "active")));
  return row ?? null;
}

async function seat(db: Database, serverId: string, userId: string) {
  const [row] = await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row ?? null;
}

// Every `channel.server_connected` but the fixture's own (world() connects P by a joint invite, mode `joint_invite`).
const connectedAudits = async (db: Database) => (await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_connected")))
  .filter((row) => row.metadata.mode !== "joint_invite");
const guestConvertedAudits = async (db: Database, userId: string) => (await db.select().from(integrationAuditEvents)
  .where(inArray(integrationAuditEvents.eventType, ["channel.member_left", "channel.member_removed"])))
  .filter((row) => row.targetId === userId && row.metadata.reason === "guest_converted");
/** The channel's server-connected system messages (#wg-rbac:#40), as stored: one row per connection, on the canonical channel. */
const connectedMessages = (db: Database) => storedSystemMessages(db, "channel.joint_connect");
const serverName = async (db: Database, serverId: string) => (await db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)))[0]!.name;

async function selfInvites(db: Database, channelId: string) {
  return db.select().from(channelExternalInvites).where(and(eq(channelExternalInvites.channelId, channelId), eq(channelExternalInvites.origin, "self_connect")));
}

/** Every read-state row of the person (cursors, display prefs, mutes, follows), for before/after comparison. */
async function readState(db: Database, userId: string) {
  return {
    cursors: await db.select().from(userChannelReadCursors).where(eq(userChannelReadCursors.userId, userId)),
    prefs: await db.select().from(userChannelDisplayPrefs).where(eq(userChannelDisplayPrefs.userId, userId)),
    mutes: await db.select().from(inboxTargetMuteStates).where(and(eq(inboxTargetMuteStates.receiverType, "user"), eq(inboxTargetMuteStates.receiverId, userId))),
    follows: await db.select().from(threadFollows).where(and(eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, userId))),
  };
}

const NOT_FOUND = JSON.stringify({ error: "Channel not found" });

// ── The basic path ──

test("a participant's member connects a server they own: connected, a source of the membership they had, audited once, one system message read on the host, the participant and S; no DM to the host's owners and admins", async ({ app, db, seed }) => {
  const w = await world(db, seed);
  const before = { x: await member(db, w.J, w.x.id), yState: await readState(db, w.y.id), xState: await readState(db, w.x.id) };
  assert.ok(before.x);

  const done = await connect(app.baseUrl, w.x, w.p, w.pLocal, [w.s.id]);
  assert.equal(done.status, 200, done.text);
  const result = outcomes(done.body)[w.s.id]!;
  assert.equal(result.state, "connected", done.text);
  const sProjection = await projection(db, w.J, w.s.id);
  assert.ok(sProjection, "S is in the joint");
  assert.equal(result.channelId, sProjection.localChannelId);

  // The membership X had, unchanged, with S as one more live source of it (admitted by X).
  assert.equal((await member(db, w.J, w.x.id))?.generation, before.x.generation, "no new membership");
  assert.deepEqual((await sources(db, w.J, w.x.id)).filter((row) => row.serverId === w.s.id), [{ serverId: w.s.id, generation: before.x.generation, admittedBy: w.x.id, ended: false }]);

  // One audit event, on the host.
  const audits = await connectedAudits(db);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.serverId, w.h.id);
  assert.deepEqual([audits[0]!.actorType, audits[0]!.actorId, audits[0]!.targetId], ["human", w.x.id, w.s.id]);
  assert.deepEqual({ ...audits[0]!.metadata, operationId: undefined }, {
    mode: "self_connect", jointChannelId: w.J, hostServerId: w.h.id, channelId: w.hLocal, connectedServerId: w.s.id, guestReleased: false, operationId: undefined,
  });

  // The channel says so, once, on every connected server (cindyz #40); no admin is told in a DM (#42 A).
  const line = `${await serverName(db, w.s.id)} connected to this channel.`;
  const [joint] = await db.select({ canonical: jointChannels.canonicalChannelId }).from(jointChannels).where(eq(jointChannels.id, w.J));
  assert.deepEqual(await connectedMessages(db), [{ content: line, channelId: joint!.canonical }]);
  for (const [who, server, channelId] of [[w.hostAdmin, w.h, w.hLocal], [w.peerOwner, w.p, w.pLocal], [w.y, w.s, sProjection.localChannelId]] as const) {
    assert.deepEqual((await channelSystemLines(app.baseUrl, who, server, channelId)).filter((entry) => entry === line), [line], `read on ${server.id}`);
  }
  await assertNoDmNotice(db);

  // Access: X and Y (already in J, members of S) from S's copy; Z (a member of S only) is still refused.
  assert.equal(await canUserAccessChannel(sProjection.localChannelId, w.x.id, asServerId(w.s.id)), true);
  assert.equal(await canUserAccessChannel(sProjection.localChannelId, w.y.id, asServerId(w.s.id)), true);
  assert.equal(await canUserAccessChannel(sProjection.localChannelId, w.z.id, asServerId(w.s.id)), false);
  const listed = await createHttpClient(app.baseUrl).as(w.y, w.s).get("/api/channels");
  assert.ok((await listed.json() as Array<{ id: string }>).some((row) => row.id === sProjection.localChannelId), "Y's list on S shows it");
  const read = await createHttpClient(app.baseUrl).as(w.y, w.s).get(`/api/messages/channel/${sProjection.localChannelId}`);
  assert.equal(read.status, 200);
  const zRead = await createHttpClient(app.baseUrl).as(w.z, w.s).get(`/api/messages/channel/${sProjection.localChannelId}`);
  assert.notEqual(zRead.status, 200, "a member of S outside the channel is refused");

  // Not a new join: X's and Y's read state is exactly as it was.
  assert.deepEqual(await readState(db, w.y.id), before.yState);
  assert.deepEqual(await readState(db, w.x.id), before.xState);
  // The operation ended accepted.
  const [op] = await selfInvites(db, w.hLocal);
  assert.deepEqual({ status: op?.status, state: op?.sourceState, generation: op?.sourceGeneration, released: op?.selfGuestReleasedAt }, {
    status: "accepted", state: "member_at_start", generation: before.x.generation, released: null,
  });
});

// ── Refusals ──

test("refusals: a server they only belong to (server_admin_required), anyone not in the channel and an unknown channel alike (the same 404), the host's external_channels_v1 off (404, whatever the retired joint_member_connect_v1 stores), a public channel (400); the participant's own flags are not read", async ({ app, db, seed }) => {
  const w = await world(db, seed);
  const memberOnly = await seed.server({ owner: w.peerOwner, members: [w.x] });
  await founder(db, memberOnly.id);
  const refused = await connect(app.baseUrl, w.x, w.p, w.pLocal, [memberOnly.id]);
  assert.equal(refused.status, 200, refused.text);
  assert.deepEqual([outcomes(refused.body)[memberOnly.id]?.state, outcomes(refused.body)[memberOnly.id]?.code], ["refused", "server_admin_required"]);

  const unknown = await connect(app.baseUrl, w.x, w.p, randomUUID(), [w.s.id]);
  assert.equal(unknown.status, 404);
  const hidden = [
    // Z on S asking with P's copy id: not that server's channel.
    await connect(app.baseUrl, w.z, w.s, w.pLocal, [w.s.id]),
    // A member of the host outside the private joint copy.
    await connect(app.baseUrl, w.hostOutsider, w.h, w.hLocal, [w.s.id]),
  ];
  for (const answer of hidden) {
    assert.equal(answer.status, 404, answer.text);
    assert.equal(answer.text, unknown.text, "byte-identical to an unknown channel");
  }
  assert.equal(unknown.text, NOT_FOUND);

  // The host's external_channels_v1 off: hidden too, with the retired
  // joint_member_connect_v1 stored off, and stored on for the host (it opens nothing).
  await db.execute(sql`DELETE FROM feature_flag_rules WHERE flag_key = 'external_channels_v1'`);
  for (const retired of ["killed", { allow: [w.h.id] }] as const) {
    await storeRetiredMemberConnectFlag(retired === "killed" ? retired : { allow: [...retired.allow] });
    const externalOff = await connect(app.baseUrl, w.x, w.p, w.pLocal, [w.s.id]);
    assert.equal(externalOff.status, 404, JSON.stringify(retired));
    assert.equal(externalOff.text, NOT_FOUND, JSON.stringify(retired));
  }
  assert.equal(await projection(db, w.J, w.s.id), null, "nothing connected");

  // A public channel of a host with external_channels_v1 on: not supported.
  await enableExternalChannelsFlag(w.h.id);
  const open = await createChannel(w.h.id, `mc-open-${randomUUID().slice(0, 6)}`, undefined, "channel", { type: "user", id: w.hostOwner.id });
  const publicAnswer = await connect(app.baseUrl, w.hostOwner, w.h, open.id, [w.s.id]);
  assert.equal(publicAnswer.status, 400, publicAnswer.text);
  assert.equal(publicAnswer.body.code, "channel_not_invitable");

  // P (the participant) has no flag: X still connects, the host's is the one read.
  // The retired joint_member_connect_v1 stored off for everyone closes nothing.
  await storeRetiredMemberConnectFlag("killed");
  const done = await connect(app.baseUrl, w.x, w.p, w.pLocal, [w.s.id]);
  assert.equal(outcomes(done.body)[w.s.id]?.state, "connected", done.text);
});

test("GET connect-my-servers, on opening: the member's servers they own or administer, not yet in the channel, each with its Free limit; upgradable only by an owner (manageBilling), its owners named; the same 404 as the POST for anyone not in the channel", async ({ app, db, seed }) => {
  const w = await world(db, seed);
  const list = async (who: { id: string }, server: Server, channelId: string) => {
    const response = await createHttpClient(app.baseUrl).as(who, server).request(`/api/channels/${channelId}/connect-my-servers`, { method: "GET" });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) as { servers?: Array<{ id: string; atLimit: boolean; canUpgrade: boolean; owners: Array<{ id: string; name: string }> }> } : {} };
  };
  // Free and already in an external channel (a bound Guest): one X owns, one X administers.
  const ownedFree = await seed.server({ owner: w.x });
  const administeredFree = await seed.server({ owner: w.peerOwner });
  await addMember(administeredFree.id, w.x.id, "admin");
  const memberOnly = await seed.server({ owner: w.peerOwner, members: [w.x] });
  for (const server of [ownedFree, administeredFree, memberOnly]) await seedBoundGuest({ serverId: server.id, userId: (await seed.human()).id });

  const shown = await list(w.x, w.p, w.pLocal);
  assert.equal(shown.status, 200, shown.text);
  const byId = Object.fromEntries((shown.body.servers ?? []).map((row) => [row.id, { atLimit: row.atLimit, canUpgrade: row.canUpgrade, owners: row.owners.map((owner) => owner.id) }]));
  assert.deepEqual(byId, {
    // S: paid (founder), not at a limit.
    [w.s.id]: { atLimit: false, canUpgrade: false, owners: [] },
    [ownedFree.id]: { atLimit: true, canUpgrade: true, owners: [w.x.id] },
    // An admin connects it but can't pay for it: its owner is named for "Ask an owner".
    [administeredFree.id]: { atLimit: true, canUpgrade: false, owners: [w.peerOwner.id] },
  }, "never P (already in the channel, and only a member), the host, or a server they only belong to");
  assert.equal(shown.body.servers!.find((row) => row.id === administeredFree.id)!.owners[0]!.name, w.peerOwner.displayName);

  // Anyone not in the channel, and an unknown channel: the POST's 404, byte for byte.
  const unknown = await list(w.x, w.p, randomUUID());
  for (const answer of [unknown, await list(w.z, w.s, w.pLocal), await list(w.hostOutsider, w.h, w.hLocal)]) {
    assert.equal(answer.status, 404, answer.text);
    assert.equal(answer.text, NOT_FOUND);
  }
  // The host's external_channels_v1 off: hidden too.
  await db.execute(sql`DELETE FROM feature_flag_rules WHERE flag_key = 'external_channels_v1'`);
  const off = await list(w.x, w.p, w.pLocal);
  assert.equal(off.status, 404);
  assert.equal(off.text, NOT_FOUND);
});

test("an agent never reaches the route: a personal assistant's key acting as its owner is refused before it (not an owner action)", () => {
  assert.deepEqual(matchAssistantOwnerActionRoute("POST", `/api/channels/${randomUUID()}/connect-my-servers`), []);
});

// ── A Guest of the host ──

for (const sourceExit of [false, true]) {
  test(`a Guest of the host connects their own server (source exit ${sourceExit ? "on" : "off"}): connected, the Guest seat ends in that commit, they stay in the channel through S with the same membership; audited guest_converted, the channel says SG connected`, async ({ app, db, seed }) => {
    const w = await world(db, seed, { sourceExit });
    const before = await member(db, w.J, w.g.id);
    assert.ok(before);
    assert.equal(await canUserAccessChannel(w.hLocal, w.g.id, asServerId(w.h.id)), true, "fixture: in through H as a Guest");

    const done = await connect(app.baseUrl, w.g, w.h, w.hLocal, [w.sg.id]);
    assert.equal(done.status, 200, done.text);
    assert.equal(outcomes(done.body)[w.sg.id]?.state, "connected", done.text);
    const sgProjection = await projection(db, w.J, w.sg.id);
    assert.ok(sgProjection);

    assert.equal(await seat(db, w.h.id, w.g.id), null, "no longer the host's Guest");
    assert.equal((await member(db, w.J, w.g.id))?.generation, before.generation, "the same membership");
    assert.deepEqual(await sources(db, w.J, w.g.id), [
      { serverId: w.h.id, generation: before.generation, admittedBy: w.hostOwner.id, ended: true },
      { serverId: w.sg.id, generation: before.generation, admittedBy: w.g.id, ended: false },
    ].sort((a, b) => a.serverId.localeCompare(b.serverId)), "the host source ended, SG's live");
    assert.equal(await canUserAccessChannel(sgProjection.localChannelId, w.g.id, asServerId(w.sg.id)), true, "in through SG");
    assert.equal(await canUserAccessChannel(w.hLocal, w.g.id, asServerId(w.h.id)), false, "no longer through H");
    const [guestRow] = await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, w.hLocal), eq(channelHumans.userId, w.g.id)));
    assert.equal(guestRow, undefined, "the host copy's legacy row went with the seat");

    const converted = await guestConvertedAudits(db, w.g.id);
    assert.equal(converted.length, 1, "the entry through the host copy ended: one guest_converted event");
    assert.deepEqual([converted[0]!.serverId, converted[0]!.eventType, converted[0]!.metadata.channelId], [w.h.id, "channel.member_left", w.hLocal]);
    const [audit] = await connectedAudits(db);
    assert.equal(audit?.metadata.guestReleased, true);
    const line = `${await serverName(db, w.sg.id)} connected to this channel.`;
    assert.deepEqual((await connectedMessages(db)).map((row) => row.content), [line]);
    assert.ok((await channelSystemLines(app.baseUrl, w.hostAdmin, w.h, w.hLocal)).includes(line), "read on the host");
    assert.ok((await channelSystemLines(app.baseUrl, w.g, w.sg, sgProjection.localChannelId)).includes(line), "and on SG");
    await assertNoDmNotice(db);
    const [op] = await selfInvites(db, w.hLocal);
    assert.ok(op?.selfGuestReleasedAt, "the operation records the release");
    // Joint not archived: Guests never count toward the host's side, so ending a seat never empties it.
    const [joint] = await db.select({ status: jointChannels.status }).from(jointChannels).where(eq(jointChannels.id, w.J));
    assert.equal(joint?.status, "active");
  });
}

test("a Guest with a Computer attached on the host is refused (guest_has_computer) and nothing changes", async ({ app, db, seed }) => {
  const w = await world(db, seed);
  await db.insert(computers).values({ serverId: w.h.id, name: "g-laptop", apiKeyHash: "x", apiKeyHmac: Buffer.from(randomUUID()), apiKeyPrefix: "rk_test", attachedByUserId: w.g.id });
  const refused = await connect(app.baseUrl, w.g, w.h, w.hLocal, [w.sg.id]);
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.code, "guest_has_computer");
  assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.hLocal });
  assert.equal(await projection(db, w.J, w.sg.id), null);
  assert.deepEqual(await connectedAudits(db), []);
});

test("a failed write rolls everything back (the seat, the connection, the source, the audit) and posts nothing; the next try succeeds and posts once", async ({ app, db, seed }) => {
  const w = await world(db, seed);
  const before = await member(db, w.J, w.g.id);
  for (const stage of ["released", "audited"] as const) {
    __setSelfConnectHookForTests(async (at) => { if (at === stage) throw new Error(`injected at ${stage}`); });
    try {
      const failed = await connect(app.baseUrl, w.g, w.h, w.hLocal, [w.sg.id]);
      assert.equal(failed.status, 200, failed.text);
      assert.equal(outcomes(failed.body)[w.sg.id]?.state, "refused", `${stage}: refused`);
    } finally {
      __setSelfConnectHookForTests(null);
    }
    assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.hLocal }, `${stage}: the seat is kept`);
    assert.equal(await projection(db, w.J, w.sg.id), null);
    assert.deepEqual((await sources(db, w.J, w.g.id)).map((row) => row.serverId), [w.h.id]);
    assert.deepEqual(await connectedAudits(db), []);
    assert.deepEqual(await guestConvertedAudits(db, w.g.id), []);
    assert.deepEqual(await connectedMessages(db), [], `${stage}: nothing posted for a connection that rolled back`);
    assert.equal((await member(db, w.J, w.g.id))?.generation, before?.generation);
  }
  const done = await connect(app.baseUrl, w.g, w.h, w.hLocal, [w.sg.id]);
  assert.equal(outcomes(done.body)[w.sg.id]?.state, "connected", done.text);
  assert.equal(await seat(db, w.h.id, w.g.id), null);
  assert.equal((await connectedAudits(db)).length, 1);
  assert.equal((await connectedMessages(db)).length, 1);
  await assertNoDmNotice(db);
});

test("at 30 of 30 a Guest picking two servers: the first connects and takes the Guest's own slot (credited once), the second is refused joint_server_limit; one release, one audit, one system message", async ({ app, db, seed }) => {
  const w = await world(db, seed);
  const sg2 = await seed.server({ owner: w.g });
  await founder(db, sg2.id);
  // H and P, G, and 27 more Guests bound to H's copy: 30 parties.
  for (let index = 0; index < 27; index += 1) {
    const other = await seed.human();
    await seedBoundGuest({ serverId: w.h.id, userId: other.id, channelId: w.hLocal });
  }
  const ordered = [w.sg.id, sg2.id];
  const done = await connect(app.baseUrl, w.g, w.h, w.hLocal, ordered);
  assert.equal(done.status, 200, done.text);
  const result = outcomes(done.body);
  assert.equal(result[w.sg.id]?.state, "connected", done.text);
  assert.deepEqual([result[sg2.id]?.state, result[sg2.id]?.code], ["refused", "joint_server_limit"], done.text);
  assert.equal(await seat(db, w.h.id, w.g.id), null);
  assert.equal(await projection(db, w.J, sg2.id), null);
  assert.equal((await connectedAudits(db)).length, 1);
  assert.equal((await guestConvertedAudits(db, w.g.id)).length, 1);
  assert.equal((await connectedMessages(db)).length, 1);
});

test("replays: the same request again connects nothing more and writes no second release, audit or system message", async ({ app, db, seed }) => {
  const w = await world(db, seed);
  const first = await connect(app.baseUrl, w.g, w.h, w.hLocal, [w.sg.id]);
  assert.equal(outcomes(first.body)[w.sg.id]?.state, "connected", first.text);
  // G is no longer the host's Guest: from H the channel is gone for them; from SG it is theirs.
  const sgLocal = (await projection(db, w.J, w.sg.id))!.localChannelId;
  const again = await connect(app.baseUrl, w.g, w.sg, sgLocal, [w.sg.id]);
  assert.equal(again.status, 200, again.text);
  assert.equal(outcomes(again.body)[w.sg.id]?.state, "refused");
  // No longer a member of the host at all: refused by the server gate before the route.
  const fromHost = await connect(app.baseUrl, w.g, w.h, w.hLocal, [w.sg.id]);
  assert.equal(fromHost.status, 403, fromHost.text);
  assert.equal((await connectedAudits(db)).length, 1);
  assert.equal((await guestConvertedAudits(db, w.g.id)).length, 1);
  assert.equal((await connectedMessages(db)).length, 1);
  await assertNoDmNotice(db);
});


// ── The host's private channel: the conversion path (design v3 §4, §10) ──

/** Host H's private channel with its owner and G, H's Guest bound to it; G owns SG. */
async function privateWorld(db: Database, seed: Seed) {
  await setJointFlags(db, false);
  const hostOwner = await seed.human(), g = await seed.human();
  const h = await seed.server({ owner: hostOwner });
  const sg = await seed.server({ owner: g });
  await founder(db, h.id, sg.id);
  const room = await createChannel(h.id, `mc-room-${randomUUID().slice(0, 6)}`, undefined, "private", { type: "user", id: hostOwner.id });
  await seedBoundGuest({ serverId: h.id, userId: g.id, channelId: room.id });
  await enableExternalChannelsFlag(h.id);
  return { hostOwner, g, h, sg, room };
}

type PrivateWorld = Awaited<ReturnType<typeof privateWorld>>;

async function reserve(baseUrl: string, db: Database, w: PrivateWorld) {
  const reserved = await connect(baseUrl, w.g, w.h, w.room.id, [w.sg.id]);
  assert.equal(reserved.status, 200, reserved.text);
  assert.equal(outcomes(reserved.body)[w.sg.id]?.state, "connecting", reserved.text);
  const [op] = await selfInvites(db, w.room.id);
  assert.ok(op);
  return op;
}

async function jointOfRoom(db: Database, roomId: string) {
  const [row] = await db.select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers).where(eq(jointChannelServers.localChannelId, roomId));
  return row?.jointChannelId ?? null;
}

async function opRow(db: Database, id: string) {
  const [row] = await db.select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

/** The worker as server.ts runs it: each connection it commits is published (with its system message). */
async function drainWorker(db: Database, id: string, app: { get(key: string): unknown }) {
  for (let pass = 0; pass < 20 && (await opRow(db, id)).status === "self_connecting"; pass += 1) {
    await runChannelConversionWorkerPass(undefined, undefined, undefined, workerPublish(app));
  }
}

test("a Guest of the host's private channel: the reservation binds their membership, the conversion resolves it, the worker connects SG and ends the seat; the seat is kept until then; status consumers read self_connecting", async ({ app, db, seed }) => {
  const w = await privateWorld(db, seed);
  const op = await reserve(app.baseUrl, db, w);
  assert.deepEqual({ status: op.status, phase: op.connectPhase, state: op.sourceState, bound: op.selfMemberJoinedAt !== null }, {
    status: "self_connecting", phase: "conversion", state: "awaiting_joint_creation", bound: true,
  });
  // An older release's worker and finalize select `connecting` only: never this one.
  assert.deepEqual((await db.execute(sql`SELECT id FROM channel_external_invites WHERE status = 'connecting'`)).rows, []);
  // Status consumers in this release: a connection is under way, the slot is held, it is no invitation to list.
  const { channelHasConnectingInvite, listChannelExternalInvites } = await import("../services/externalInviteService");
  assert.equal(await channelHasConnectingInvite(db, w.room.id), true);
  const listed = await listChannelExternalInvites(w.room.id, w.hostOwner.id);
  assert.deepEqual(listed.invites, []);
  assert.equal(listed.slotsLeft, 30 - 2 - 1, "host and Guest, and the operation's open row");
  const revokeDuring = await createHttpClient(app.baseUrl).as(w.hostOwner, w.h).request(`/api/channels/${w.room.id}/external-invites/${op.id}`, { method: "DELETE" });
  assert.equal(revokeDuring.status, 409, "its conversion runs: not revocable");
  assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.room.id }, "the seat is kept while it runs");

  assert.equal((await runChannelConversionJob(op.connectConversionJobId!)).status, "done");
  const jointId = (await jointOfRoom(db, w.room.id))!;
  const gMember = await member(db, jointId, w.g.id);
  assert.ok(gMember, "the conversion carried the Guest into the joint");
  const resolved = await opRow(db, op.id);
  assert.deepEqual({ status: resolved.status, phase: resolved.connectPhase, state: resolved.sourceState, generation: resolved.sourceGeneration }, {
    status: "self_connecting", phase: "connection", state: "member_at_start", generation: gMember.generation,
  });
  assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.room.id }, "still kept after the conversion");

  await drainWorker(db, op.id, app.app);
  const done = await opRow(db, op.id);
  assert.equal(done.status, "accepted");
  assert.ok(done.selfGuestReleasedAt);
  assert.ok(await projection(db, jointId, w.sg.id), "SG connected");
  assert.equal(await seat(db, w.h.id, w.g.id), null, "the seat ended with it");
  assert.equal((await member(db, jointId, w.g.id))?.generation, gMember.generation);
  assert.deepEqual((await sources(db, jointId, w.g.id)).find((row) => row.serverId === w.sg.id), { serverId: w.sg.id, generation: gMember.generation, admittedBy: w.g.id, ended: false });
  assert.equal((await connectedAudits(db)).length, 1);
  assert.equal((await guestConvertedAudits(db, w.g.id)).length, 1);
  const line = `${await serverName(db, w.sg.id)} connected to this channel.`;
  assert.deepEqual((await connectedMessages(db)).map((row) => row.content), [line], "the worker's connection posts once");
  assert.ok((await channelSystemLines(app.baseUrl, w.hostOwner, w.h, w.room.id)).includes(line), "read on the host");
  assert.ok((await channelSystemLines(app.baseUrl, w.g, w.sg, (await projection(db, jointId, w.sg.id))!.localChannelId)).includes(line), "and on SG");
  await assertNoDmNotice(db);
  // A replayed worker pass connects nothing more, and posts nothing more.
  await runChannelConversionWorkerPass(undefined, undefined, undefined, workerPublish(app.app));
  assert.equal((await connectedAudits(db)).length, 1);
  assert.equal((await connectedMessages(db)).length, 1);
});

for (const when of ["after the reservation", "after the reservation, then back as a new Guest", "after the conversion's finalize"] as const) {
  test(`a private channel's Guest who leaves ${when}: refused, never (re)joined by the operation, SG not connected`, async ({ app, db, seed }) => {
    const w = await privateWorld(db, seed);
    const op = await reserve(app.baseUrl, db, w);
    if (when !== "after the conversion's finalize") await removeMember(w.h.id, w.g.id, { reason: "left", actorUserId: w.g.id });
    assert.equal((await runChannelConversionJob(op.connectConversionJobId!)).status, "done");
    const jointId = (await jointOfRoom(db, w.room.id))!;
    if (when === "after the conversion's finalize") {
      assert.equal((await opRow(db, op.id)).sourceState, "member_at_start");
      await removeMember(w.h.id, w.g.id, { reason: "left", actorUserId: w.g.id });
    } else {
      assert.equal((await opRow(db, op.id)).sourceState, "awaiting_joint_creation", "unresolved: they were not in the channel the conversion made joint");
    }
    if (when === "after the reservation, then back as a new Guest") {
      await seedBoundGuest({ serverId: w.h.id, userId: w.g.id, channelId: w.room.id });
      await joinGuest(db, w.room.id, w.g.id, w.hostOwner.id);
    }
    const rejoined = await member(db, jointId, w.g.id);
    await drainWorker(db, op.id, app.app);
    const ended = await opRow(db, op.id);
    assert.equal(ended.status, "revoked", "the operation ended, nothing connected");
    assert.equal(await projection(db, jointId, w.sg.id), null);
    assert.equal((await member(db, jointId, w.g.id))?.generation ?? null, rejoined?.generation ?? null, "membership exactly as they left it (or rejoined it)");
    assert.equal((await sources(db, jointId, w.g.id)).some((row) => row.serverId === w.sg.id), false, "no SG source");
    assert.deepEqual(await connectedAudits(db), []);
  });
}

for (const matches of [true, false]) {
  test(`an older release's finalize (it moves connecting reservations only): this release's worker makes up the step from what the conversion wrote; ${matches ? "the same stint: connected" : "a different stint: refused, the seat kept"}`, async ({ app, db, seed }) => {
    const w = await privateWorld(db, seed);
    const op = await reserve(app.baseUrl, db, w);
    assert.equal((await runChannelConversionJob(op.connectConversionJobId!)).status, "done");
    // What an older finalize leaves: still phase conversion, the membership unresolved.
    await db.execute(sql`UPDATE channel_external_invites SET connect_phase = 'conversion', source_state = 'awaiting_joint_creation', source_generation = NULL
      ${matches ? sql`` : sql`, self_member_joined_at = self_member_joined_at - interval '1 second'`} WHERE id = ${op.id}::uuid`);
    await drainWorker(db, op.id, app.app);
    const jointId = (await jointOfRoom(db, w.room.id))!;
    if (matches) {
      assert.equal((await opRow(db, op.id)).status, "accepted");
      assert.ok(await projection(db, jointId, w.sg.id));
      assert.equal(await seat(db, w.h.id, w.g.id), null);
    } else {
      assert.equal((await opRow(db, op.id)).status, "revoked");
      assert.equal(await projection(db, jointId, w.sg.id), null);
      assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.room.id });
    }
  });
}

test("a self_connecting reservation revoked (as an older release's revoke writes it) or run out: the worker never connects it, the seat is kept", async ({ app, db, seed }) => {
  for (const end of ["revoked", "expired"] as const) {
    const w = await privateWorld(db, seed);
    const op = await reserve(app.baseUrl, db, w);
    assert.equal((await runChannelConversionJob(op.connectConversionJobId!)).status, "done");
    if (end === "revoked") {
      // An older release's revoke: its own CLEARED_CONNECT_STATE and status revoked.
      await db.execute(sql`UPDATE channel_external_invites SET status = 'revoked', decided_at = now(), connect_phase = NULL, connect_server_id = NULL,
        connect_joiner_user_id = NULL, connect_authorizer_user_id = NULL, connect_conversion_job_id = NULL, connect_generation = NULL, connect_outcome = NULL,
        connect_queued_server_ids = '{}' WHERE id = ${op.id}::uuid`);
    } else {
      await db.execute(sql`UPDATE channel_external_invites SET expires_at = now() - interval '1 minute' WHERE id = ${op.id}::uuid`);
    }
    await runChannelConversionWorkerPass();
    await runChannelConversionWorkerPass();
    assert.equal((await opRow(db, op.id)).status, end);
    const jointId = (await jointOfRoom(db, w.room.id))!;
    assert.equal(await projection(db, jointId, w.sg.id), null, `${end}: not connected`);
    assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.room.id }, `${end}: the seat kept`);
  }
});

// ── Every reader of an invite and its origin (Tenny d47d7933) ──

test("every invite entry point handles origin explicitly: an origin this release does not know is refused (or left untouched) everywhere; a self_connect operation is never used through a link, listed or resent", async ({ app, db, seed }) => {
  await setJointFlags(db, false);
  const hostOwner = await seed.human(), selfActor = await seed.human(), unknownInvitee = await seed.human(), approver = await seed.human();
  const h = await seed.server({ owner: hostOwner });
  const target = await seed.server({ owner: approver, members: [unknownInvitee, selfActor] });
  await founder(db, h.id, target.id);
  await enableExternalChannelsFlag(h.id);
  const room = await createChannel(h.id, `mc-origins-${randomUUID().slice(0, 6)}`, undefined, "private", { type: "user", id: hostOwner.id });
  const { createHash } = await import("node:crypto");
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  await db.execute(sql`ALTER TABLE channel_external_invites DROP CONSTRAINT channel_external_invites_origin_known`);
  const seedRow = async (email: string, origin: string) => {
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const [row] = (await db.execute<{ id: string }>(sql`INSERT INTO channel_external_invites (channel_id, host_server_id, email, token_hash, invited_by_user_id, expires_at, origin)
      VALUES (${room.id}::uuid, ${h.id}::uuid, ${email}, ${hash(token)}, ${hostOwner.id}::uuid, now() + interval '14 days', ${origin}) RETURNING id`)).rows;
    return { id: row!.id, token };
  };
  const rows = {
    unknown: { ...await seedRow(unknownInvitee.email.toLowerCase(), "from_a_newer_release"), who: unknownInvitee },
    self: { ...await seedRow(selfActor.email.toLowerCase(), "self_connect"), who: selfActor },
  };
  const [request] = (await db.execute<{ id: string }>(sql`INSERT INTO channel_server_connect_requests (invite_id, channel_id, host_server_id, target_server_id, requester_user_id, approver_user_id, expires_at)
    VALUES (${rows.unknown.id}::uuid, ${room.id}::uuid, ${h.id}::uuid, ${target.id}::uuid, ${unknownInvitee.id}::uuid, ${approver.id}::uuid, now() + interval '14 days') RETURNING id`)).rows;
  const status = async (who: { id: string }, method: string, path: string, body?: unknown, server?: Server) => {
    const response = await createHttpClient(app.baseUrl).as(who, server).request(path, {
      method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.status;
  };
  const serversBefore = (await db.select({ id: servers.id }).from(servers)).length;

  // The link surfaces: the neutral 404 for both (a self_connect operation has no link to use).
  for (const [origin, row] of Object.entries(rows)) {
    const base = `/api/external-invites/${row.token}`;
    // The signed-out link preview: the same neutral 404 as any unusable link, even without a session.
    const preview = await fetch(`${app.baseUrl}${base}/preview`);
    assert.equal(preview.status, 404, `${origin}: signed-out link preview`);
    const unusable = await fetch(`${app.baseUrl}/api/external-invites/${"0".repeat(64)}/preview`);
    assert.equal(await preview.text(), await unusable.text(), `${origin}: preview byte-identical to an unknown link's`);
    const entryPoints: Array<[string, string, string, unknown?]> = [
      ["invite page", "GET", base],
      ["accept as a Guest", "POST", `${base}/accept-as-guest`],
      ["connect", "POST", `${base}/connect`, { serverId: target.id }],
      ["connect several", "POST", `${base}/connect-servers`, { servers: [{ serverId: target.id, approverUserId: approver.id }] }],
      ["connect a new server", "POST", `${base}/connect-new-server`, { name: "New one" }],
      ["request approval", "POST", `${base}/request-approval`, { serverId: target.id, approverUserId: approver.id }],
      ["cancel a request", "POST", `${base}/cancel-request`, {}],
    ];
    for (const [name, method, path, body] of entryPoints) assert.equal(await status(row.who, method, path, body), 404, `${origin}: ${name}`);
  }
  assert.equal((await db.select({ id: servers.id }).from(servers)).length, serversBefore, "connect-new-server created nothing");
  // The approver's request page and its decisions: an invite of another release's is not acted on.
  for (const [name, method, path] of [["request page", "GET", `/api/server-connect-requests/${request!.id}`], ["approve", "POST", `/api/server-connect-requests/${request!.id}/approve`], ["reject", "POST", `/api/server-connect-requests/${request!.id}/reject`]] as const) {
    assert.equal(await status(approver, method, path), 404, name);
  }
  // The host's list: neither (an invitation only); resend: neither.
  const list = await createHttpClient(app.baseUrl).as(hostOwner, h).get(`/api/channels/${room.id}/external-invites`);
  const listed = await list.json() as { invites: Array<{ id: string }>; slotsLeft: number };
  assert.deepEqual(listed.invites, []);
  assert.equal(listed.slotsLeft, 30 - 1 - 2, "both still hold their slots (counting refuses more, never less)");
  for (const row of Object.values(rows)) assert.equal(await status(hostOwner, "POST", `/api/channels/${room.id}/external-invites/${row.id}/resend`, undefined, h), 409);
  // Revoke: another release's row is refused; a self_connect operation the host may end.
  assert.equal(await status(hostOwner, "DELETE", `/api/channels/${room.id}/external-invites/${rows.unknown.id}`, undefined, h), 409);
  // The worker: another release's reservation is only put off.
  await db.execute(sql`UPDATE channel_external_invites SET status = 'connecting', connect_phase = 'connection', connect_generation = gen_random_uuid(), connect_outcome = 'server',
    connect_server_id = ${target.id}::uuid, connect_joiner_user_id = ${unknownInvitee.id}::uuid, connect_authorizer_user_id = ${approver.id}::uuid WHERE id = ${rows.unknown.id}::uuid`);
  const { advanceExternalConnect } = await import("../services/externalInviteConnectService");
  const errors = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    assert.equal(await advanceExternalConnect(rows.unknown.id), null);
  } finally {
    errors.mockRestore();
  }
  assert.equal((await opRow(db, rows.unknown.id)).status, "connecting", "left as it was");
  // The expiry sweep (run by a send) and the archive: another release's row untouched; the self_connect operation ends.
  await db.execute(sql`UPDATE channel_external_invites SET status = 'pending', connect_phase = NULL, connect_generation = NULL, connect_outcome = NULL, connect_server_id = NULL,
    connect_joiner_user_id = NULL, connect_authorizer_user_id = NULL, expires_at = now() - interval '1 minute' WHERE id IN (${rows.unknown.id}::uuid, ${rows.self.id}::uuid)`);
  const send = await createHttpClient(app.baseUrl).as(hostOwner, h).request(`/api/channels/${room.id}/external-invites`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails: [`mc-new-${randomUUID().slice(0, 6)}@slock.test`] }),
  });
  assert.equal(send.status, 200);
  assert.deepEqual([(await opRow(db, rows.unknown.id)).status, (await opRow(db, rows.self.id)).status], ["pending", "expired"]);
  const fresh = await seedRow(selfActor.email.toLowerCase(), "self_connect");
  const { revokeOpenInvitesForArchivedChannel } = await import("../services/externalInviteService");
  await db.execute(sql`UPDATE channel_external_invites SET expires_at = now() + interval '1 day' WHERE id = ${rows.unknown.id}::uuid`);
  const errors2 = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await db.transaction((tx) => revokeOpenInvitesForArchivedChannel(tx, room.id, hostOwner.id));
  } finally {
    errors2.mockRestore();
  }
  assert.deepEqual([(await opRow(db, rows.unknown.id)).status, (await opRow(db, fresh.id)).status], ["pending", "revoked"]);
});

// ── The private channel's reservation re-checks everything under its own locks (Cody 0cd40cd6) ──

for (const change of ["the host's external_channels_v1 turned off", "the actor no longer administers SG", "the actor left the channel", "the actor's account deletion requested"] as const) {
  test(`a private channel's reservation, ${change} after the route's checks: refused, no conversion started, no reservation, nothing half done`, async ({ app, db, seed }) => {
    const w = await privateWorld(db, seed);
    const { withFeatureFlagLock } = await import("../services/featureFlagService");
    const { requestAccountDeletion } = await import("../services/accountDeletion/requests");
    __setSelfConnectHookForTests(async (stage) => {
      if (stage !== "before_reservation") return;
      if (change === "the host's external_channels_v1 turned off") {
        // The retired flag still stored on for the host keeps nothing open.
        await storeRetiredMemberConnectFlag({ allow: [w.h.id] });
        await withFeatureFlagLock(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, async (tx) => {
          await tx.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
        });
      } else if (change === "the actor no longer administers SG") {
        await db.update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, w.sg.id), eq(serverMembers.userId, w.g.id)));
      } else if (change === "the actor left the channel") {
        await removeMember(w.h.id, w.g.id, { reason: "left", actorUserId: w.g.id });
      } else {
        const requested = await requestAccountDeletion({ userId: w.g.id, source: "self", actorUserId: w.g.id });
        assert.equal(requested.kind, "scheduled", JSON.stringify(requested));
      }
    });
    let answer: Awaited<ReturnType<typeof connect>>;
    try {
      answer = await connect(app.baseUrl, w.g, w.h, w.room.id, [w.sg.id]);
    } finally {
      __setSelfConnectHookForTests(null);
    }
    assert.equal(answer.status, 200, answer.text);
    // external_channels_v1 off also closes Guests in joint channels, and the
    // conversion start refuses the channel's bound Guest (the actor) before the
    // flag's own check under its lock (revalidateUnderLocks) is reached: as
    // before #wg-rbac:#55 for this flag going off in this window.
    const expected = { "the host's external_channels_v1 turned off": "guests_present", "the actor no longer administers SG": "server_admin_required",
      "the actor left the channel": "membership_changed", "the actor's account deletion requested": "connect_unavailable" }[change];
    assert.deepEqual([outcomes(answer.body)[w.sg.id]?.state, outcomes(answer.body)[w.sg.id]?.code], ["refused", expected], answer.text);
    const count = async (table: string) => Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE source_channel_id = ${w.room.id}::uuid`)).rows[0]!.n);
    assert.deepEqual([await count("channel_conversion_jobs"), await count("channel_conversion_fences"), await count("channel_conversion_commands")], [0, 0, 0], "no conversion job, fence or command");
    assert.deepEqual((await db.execute(sql`SELECT id FROM channel_external_invites WHERE status = 'self_connecting'`)).rows, [], "no reservation");
    const ops = await selfInvites(db, w.room.id);
    assert.ok(ops.every((op) => op.status === "revoked" && op.connectPhase === null), `the operation ended whole: ${JSON.stringify(ops.map((op) => op.status))}`);
    const [room] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, w.room.id));
    assert.equal(room?.type, "private", "still private");
    if (change !== "the actor left the channel") assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.room.id }, "the seat kept");
  });
}

test("a private channel's member connecting their own server to a host at its hosting limit: refused with the neutral sentence, never the host's plan or the channel using its slot (#wg-rbac:#61)", async ({ app, db, seed }) => {
  const w = await privateWorld(db, seed);
  // The host's one hosting slot: a joint of it another server joined. Then the host is on the Free plan.
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  await founder(db, peer.id);
  const used = await createJointChannel({ hostServerId: w.h.id, createdByUserId: w.hostOwner.id, name: `mc-used-${randomUUID().slice(0, 6)}`,
    targetServerSlug: peer.slug, invitedPeople: [`@${peerOwner.name}`] });
  await acceptJointChannelInvite({ inviteId: used.invites[0]!.id, targetServerId: peer.id, acceptedByUserId: peerOwner.id });
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, w.h.id));

  const refused = await connect(app.baseUrl, w.g, w.h, w.room.id, [w.sg.id]);
  assert.equal(refused.status, 200, refused.text);
  const outcome = outcomes(refused.body)[w.sg.id] as Outcome & { error?: string };
  assert.deepEqual({ state: outcome.state, status: outcome.status, code: outcome.code }, { state: "refused", status: 409, code: "joint_channel_free_limit_reached" });
  assert.equal(outcome.error, "This channel's server can't share another channel with people outside it right now. Ask the person who invited you.");
  assert.equal(refused.text.includes(used.channel.name), false, refused.text);
  assert.equal(/Free plan|Upgrade/.test(refused.text), false, refused.text);
  const [room] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, w.room.id));
  assert.equal(room?.type, "private", "no conversion started");
  assert.deepEqual(await seat(db, w.h.id, w.g.id), { role: "guest", guestChannelId: w.room.id }, "the seat kept");
});
