import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { accessTokenForTest } from "../test/integration/credentials";
import { getDb } from "../db/index";
import {
  channelHumans,
  integrationAuditEvents,
  jointChannelMembers,
  serverAgentMembers,
  serverMembers,
} from "../db/schema";
import { createAgent } from "../services/agentService";
import { acceptJointChannelInvite, addAgent, addHuman, createJointChannel, findOrCreateUserDM, isChannelHuman, removeHuman } from "../services/channelService";
import type { ChannelRemovalActor } from "../services/channelMembershipAudit";
import { listIntegrationAuditEventsForAppAdmin } from "../services/integrationAuditService";
import { removeChannelMemberForAgent } from "./agentChannelMembers";
import { seedBoundGuest } from "../test/guestFixture";
import type { createSeed } from "../test/integration/seed";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Seed = ReturnType<typeof createSeed>;

async function headers(userId: string, serverId: string) {
  return {
    Authorization: `Bearer ${await accessTokenForTest(userId)}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

/** The channel-membership audit events naming this person, oldest first. */
async function channelEvents(targetUserId: string) {
  return getDb().select().from(integrationAuditEvents).where(and(
    inArray(integrationAuditEvents.eventType, ["channel.member_left", "channel.member_removed"]),
    eq(integrationAuditEvents.targetId, targetUserId),
  )).orderBy(integrationAuditEvents.createdAt);
}

/** A computed joint hosted by `a`, connected to `b`, with `peer` a J member through `a`. */
async function computedJoint(seed: Seed, input: { peerInB: boolean }) {
  const owner = await seed.human();
  const peer = await seed.human();
  const a = await seed.server({ owner, members: [peer] });
  const b = await seed.server({ owner, members: input.peerInB ? [peer] : [] });
  const joint = await createJointChannel({
    hostServerId: a.id, createdByUserId: owner.id, name: "audit-joint", targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`], userIds: [peer.id],
  });
  const target = await acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: b.id, acceptedByUserId: owner.id });
  return { owner, peer, a, b, hostCopy: joint.channel, targetCopy: target, jointChannelId: joint.jointChannel.id };
}

/** Counts the INSERT statements (not rows) that write channel-membership audit rows from here on. */
async function countChannelAuditInsertStatements() {
  await getDb().execute(sql.raw("CREATE TABLE test_channel_audit_statements (n int)"));
  await getDb().execute(sql.raw(`
    CREATE OR REPLACE FUNCTION test_count_channel_audit_statements() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM new_rows WHERE event_type LIKE 'channel.%') THEN
        INSERT INTO test_channel_audit_statements VALUES (1);
      END IF;
      RETURN NULL;
    END $$
  `));
  await getDb().execute(sql.raw(`
    CREATE TRIGGER test_count_channel_audit_statements AFTER INSERT ON integration_audit_events
      REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION test_count_channel_audit_statements()
  `));
}

/** Every channel-membership audit insert fails, as a broken audit write would. */
async function breakChannelAuditWrites() {
  await getDb().execute(sql.raw(`
    CREATE OR REPLACE FUNCTION test_refuse_channel_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_type LIKE 'channel.%' THEN RAISE EXCEPTION 'channel audit write refused'; END IF;
      RETURN NEW;
    END $$
  `));
  await getDb().execute(sql.raw(`
    CREATE TRIGGER test_refuse_channel_audit BEFORE INSERT ON integration_audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_channel_audit()
  `));
}

test("self-leave writes channel.member_left with the person as actor", async ({ app, seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [member] });

  const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/leave`, { method: "POST", headers: await headers(member.id, server.id) });
  assert.equal(res.status, 200, await res.text());

  const events = await channelEvents(member.id);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event!.eventType, "channel.member_left");
  assert.equal(event!.eventCategory, "membership");
  assert.equal(event!.serverId, server.id);
  assert.equal(event!.actorType, "human");
  assert.equal(event!.actorId, member.id);
  assert.equal(event!.targetType, "human");
  assert.equal(event!.source, "web");
  assert.deepEqual(event!.metadata, { reason: "self_leave", channelId: channel.id, channelType: "channel" });

  // Leaving again ends nothing and records nothing.
  const again = await fetch(`${app.baseUrl}/api/channels/${channel.id}/leave`, { method: "POST", headers: await headers(member.id, server.id) });
  assert.equal(again.status, 200);
  assert.equal((await channelEvents(member.id)).length, 1);
});

test("a server admin's removal is removed_by_admin; a channel admin's is removed_by_channel_admin", async ({ app, seed }) => {
  const owner = await seed.human();
  const channelAdmin = await seed.human();
  const first = await seed.human();
  const second = await seed.human();
  const server = await seed.server({ owner, members: [channelAdmin, first, second] });
  const channel = await seed.channel({ server, members: [first, second], visibility: "private" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, channelAdmin.id, { role: "admin" });

  const byOwner = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${first.id}`, { method: "DELETE", headers: await headers(owner.id, server.id) });
  assert.equal(byOwner.status, 200, await byOwner.text());
  const [ownerEvent, ...ownerRest] = await channelEvents(first.id);
  assert.equal(ownerRest.length, 0);
  assert.equal(ownerEvent!.eventType, "channel.member_removed");
  assert.equal(ownerEvent!.actorType, "human");
  assert.equal(ownerEvent!.actorId, owner.id);
  assert.equal(ownerEvent!.targetId, first.id);
  assert.equal(ownerEvent!.serverId, server.id);
  assert.deepEqual(ownerEvent!.metadata, { reason: "removed_by_admin", channelId: channel.id, channelType: "private", actorRole: "owner" });

  const byChannelAdmin = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${second.id}`, { method: "DELETE", headers: await headers(channelAdmin.id, server.id) });
  assert.equal(byChannelAdmin.status, 200, await byChannelAdmin.text());
  const [adminEvent, ...adminRest] = await channelEvents(second.id);
  assert.equal(adminRest.length, 0);
  assert.equal(adminEvent!.eventType, "channel.member_removed");
  assert.equal(adminEvent!.actorId, channelAdmin.id);
  assert.equal(adminEvent!.targetId, second.id);
  assert.deepEqual(adminEvent!.metadata, { reason: "removed_by_channel_admin", channelId: channel.id, channelType: "private", actorRole: "member" });
});

test("removing oneself from a DM is a self_leave", async ({ app, seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const dm = await findOrCreateUserDM(server.id, owner.id, member.id);
  assert.ok(dm);

  const res = await fetch(`${app.baseUrl}/api/channels/${dm.id}/members/user/${member.id}`, { method: "DELETE", headers: await headers(member.id, server.id) });
  assert.equal(res.status, 200, await res.text());
  const [event, ...rest] = await channelEvents(member.id);
  assert.equal(rest.length, 0);
  assert.equal(event!.eventType, "channel.member_left");
  assert.equal(event!.actorId, member.id);
  assert.deepEqual(event!.metadata, { reason: "self_leave", channelId: dm.id, channelType: "dm" });
});

test("an agent's removal through the agent API is agent_api with the agent as actor", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [member] });
  const agent = await createAgent(server.id, `audit-agent-${channel.id.slice(0, 8)}`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));
  await addAgent(channel.id, agent.id);

  const result = await removeChannelMemberForAgent({
    actor: { id: agent.id, name: agent.name, serverId: server.id },
    serverId: server.id,
    channelId: channel.id,
    body: { userId: member.id },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(await isChannelHuman(channel.id, member.id), false);
  const [event, ...rest] = await channelEvents(member.id);
  assert.equal(rest.length, 0);
  assert.equal(event!.eventType, "channel.member_removed");
  assert.equal(event!.actorType, "agent");
  assert.equal(event!.actorId, agent.id);
  assert.equal(event!.targetId, member.id);
  assert.equal(event!.source, "api");
  assert.deepEqual(event!.metadata, { reason: "agent_api", channelId: channel.id, channelType: "channel", actorRole: "admin" });
});

test("removing a person from a computed joint writes one event for the joint", async ({ app, seed }) => {
  const x = await computedJoint(seed, { peerInB: true });
  // The peer also holds B's copy: the removal ends every copy, still one event.
  await addHuman(x.targetCopy.id, x.peer.id);

  const res = await fetch(`${app.baseUrl}/api/channels/${x.hostCopy.id}/members/user/${x.peer.id}`, { method: "DELETE", headers: await headers(x.owner.id, x.a.id) });
  assert.equal(res.status, 200, await res.text());
  assert.equal((await getDb().select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.jointChannelId), eq(jointChannelMembers.userId, x.peer.id)))).length, 0);
  assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.userId, x.peer.id))).filter((row) => row.channelId === x.targetCopy.id).length, 0);

  const events = await channelEvents(x.peer.id);
  assert.equal(events.length, 1, "one row per joint, not one per server copy");
  const [event] = events;
  assert.equal(event!.eventType, "channel.member_removed");
  assert.equal(event!.serverId, x.a.id);
  assert.equal(event!.actorId, x.owner.id);
  assert.deepEqual(event!.metadata, {
    reason: "removed_by_admin",
    channelId: x.hostCopy.id,
    channelType: "joint",
    jointChannelId: x.jointChannelId,
    initiatingServerId: x.a.id,
    hostServerId: x.a.id,
    actorRole: "owner",
  });
});

test("leaving a server writes a server_departure event per channel and joint lost, in one INSERT", async ({ app, seed }) => {
  const x = await computedJoint(seed, { peerInB: false });
  const publicChannels: Array<{ id: string }> = [];
  const privateChannels: Array<{ id: string }> = [];
  for (let i = 0; i < 3; i++) publicChannels.push(await seed.channel({ server: x.a, members: [x.peer] }));
  for (let i = 0; i < 3; i++) privateChannels.push(await seed.channel({ server: x.a, members: [x.peer], visibility: "private" }));
  await seed.channel({ server: x.a, members: [] }); // not a member: nothing to lose
  const dm = await findOrCreateUserDM(x.a.id, x.owner.id, x.peer.id);
  assert.ok(dm);
  // The person's default-channel memberships from joining the server count too.
  const defaultChannelIds = (await getDb().select({ channelId: channelHumans.channelId }).from(channelHumans).where(eq(channelHumans.userId, x.peer.id)))
    .map((row) => row.channelId)
    .filter((id) => ![...publicChannels, ...privateChannels].some((channel) => channel.id === id) && id !== x.hostCopy.id && id !== dm.id);
  const expectedChannelIds = new Set([...publicChannels, ...privateChannels].map((channel) => channel.id).concat(defaultChannelIds, x.hostCopy.id));
  assert.ok(expectedChannelIds.size >= 7, "at least 6 ordinary channels and one joint");
  await countChannelAuditInsertStatements();

  const res = await fetch(`${app.baseUrl}/api/servers/${x.a.id}/leave`, { method: "POST", headers: await headers(x.peer.id, x.a.id) });
  assert.equal(res.status, 200, await res.text());

  const [{ statements }] = (await getDb().execute<{ statements: number }>(sql`SELECT count(*)::int AS statements FROM test_channel_audit_statements`)).rows as [{ statements: number }];
  assert.equal(statements, 1, "every row of the departure is written by one INSERT statement");
  const events = await channelEvents(x.peer.id);
  assert.equal(events.length, expectedChannelIds.size, JSON.stringify(events.map((event) => event.metadata)));
  const operationIds = new Set(events.map((event) => (event.metadata as { operationId?: string }).operationId));
  assert.equal(operationIds.size, 1, "one operation id, shared with the membership removal");
  const [membershipRemoved] = await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.eventType, "membership.removed"), eq(integrationAuditEvents.targetId, x.peer.id)));
  assert.equal((membershipRemoved!.metadata as { operationId?: string }).operationId, [...operationIds][0]);
  for (const event of events) {
    assert.equal(event.eventType, "channel.member_left");
    assert.equal(event.serverId, x.a.id);
    assert.equal(event.actorType, "human");
    assert.equal(event.actorId, x.peer.id);
    assert.equal((event.metadata as { reason?: string }).reason, "server_departure");
  }
  const byChannel = new Map(events.map((event) => [(event.metadata as { channelId: string }).channelId, event.metadata]));
  assert.deepEqual(new Set(byChannel.keys()), expectedChannelIds, "DMs keep their participants; no event");
  for (const channel of privateChannels) assert.equal(byChannel.get(channel.id)?.channelType, "private");
  for (const channel of publicChannels) assert.equal(byChannel.get(channel.id)?.channelType, "channel");
  assert.deepEqual(byChannel.get(x.hostCopy.id), {
    reason: "server_departure",
    channelId: x.hostCopy.id,
    channelType: "joint",
    jointChannelId: x.jointChannelId,
    initiatingServerId: x.a.id,
    hostServerId: x.a.id,
    actorRole: "member",
    operationId: [...operationIds][0],
  });
});

test("being removed from a server writes server_departure events by the remover", async ({ app, seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [member] });

  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${member.id}`, { method: "DELETE", headers: await headers(owner.id, server.id) });
  assert.equal(res.status, 200, await res.text());
  const [event, ...rest] = await channelEvents(member.id);
  assert.equal(rest.length, 0);
  assert.equal(event!.eventType, "channel.member_removed");
  assert.equal(event!.actorType, "human");
  assert.equal(event!.actorId, owner.id);
  assert.equal((event!.metadata as { reason?: string }).reason, "server_departure");
  assert.equal((event!.metadata as { channelId?: string }).channelId, channel.id);
});

test("a server departure that keeps the joint through another server writes no joint event", async ({ app, seed }) => {
  const x = await computedJoint(seed, { peerInB: true });
  const res = await fetch(`${app.baseUrl}/api/servers/${x.a.id}/leave`, { method: "POST", headers: await headers(x.peer.id, x.a.id) });
  assert.equal(res.status, 200, await res.text());
  assert.equal((await getDb().select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, x.jointChannelId), eq(jointChannelMembers.userId, x.peer.id)))).length, 1);
  assert.deepEqual(await channelEvents(x.peer.id), []);
});

test("a Guest leaving or removed from its channel writes guest_unbind", async ({ app, seed }) => {
  const owner = await seed.human();
  const leaver = await seed.human();
  const removed = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner], visibility: "private" });
  await seedBoundGuest({ serverId: server.id, userId: leaver.id, channelId: channel.id });
  await seedBoundGuest({ serverId: server.id, userId: removed.id, channelId: channel.id });

  const leave = await fetch(`${app.baseUrl}/api/channels/${channel.id}/leave`, { method: "POST", headers: await headers(leaver.id, server.id) });
  assert.equal(leave.status, 200, await leave.text());
  const [left, ...leftRest] = await channelEvents(leaver.id);
  assert.equal(leftRest.length, 0, "no second server_departure row for the same channel");
  assert.equal(left!.eventType, "channel.member_left");
  assert.equal(left!.actorId, leaver.id);
  assert.equal((left!.metadata as { reason?: string }).reason, "guest_unbind");
  assert.equal((left!.metadata as { channelId?: string }).channelId, channel.id);

  const remove = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${removed.id}`, { method: "DELETE", headers: await headers(owner.id, server.id) });
  assert.equal(remove.status, 200, await remove.text());
  const [kicked, ...kickedRest] = await channelEvents(removed.id);
  assert.equal(kickedRest.length, 0);
  assert.equal(kicked!.eventType, "channel.member_removed");
  assert.equal(kicked!.actorId, owner.id);
  assert.equal((kicked!.metadata as { reason?: string }).reason, "guest_unbind");
  assert.equal((kicked!.metadata as { actorRole?: string }).actorRole, "owner");
  assert.equal((await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, removed.id)))).length, 0);
});

test("removeHuman without an actor throws and removes nothing; it is never taken for a self-leave", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [member] });
  // An untyped caller (the type requires one): no default, no self_leave.
  const missing = undefined as unknown as ChannelRemovalActor;

  await assert.rejects(removeHuman(channel.id, member.id, missing), /requires an explicit actor/);
  await assert.rejects(getDb().transaction((tx) => removeHuman(channel.id, member.id, missing, tx)), /requires an explicit actor/);
  assert.equal(await isChannelHuman(channel.id, member.id), true);
  assert.deepEqual(await channelEvents(member.id), []);

  await removeHuman(channel.id, member.id, { system: true, reason: "server_departure" });
  assert.equal(await isChannelHuman(channel.id, member.id), false);
  const [event, ...rest] = await channelEvents(member.id);
  assert.equal(rest.length, 0);
  assert.equal(event!.eventType, "channel.member_removed");
  assert.equal(event!.actorType, "system");
  assert.equal(event!.source, "system");
  assert.equal((event!.metadata as { reason?: string }).reason, "server_departure");
});

test("a failed audit write fails the leave or removal and keeps the membership", async ({ app, seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const channel = await seed.channel({ server, members: [member] });
  await breakChannelAuditWrites();

  const leave = await fetch(`${app.baseUrl}/api/channels/${channel.id}/leave`, { method: "POST", headers: await headers(member.id, server.id) });
  assert.equal(leave.status, 500);
  assert.deepEqual(await leave.json(), { error: "Failed to leave channel" });
  assert.equal(await isChannelHuman(channel.id, member.id), true);

  const remove = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${member.id}`, { method: "DELETE", headers: await headers(owner.id, server.id) });
  assert.equal(remove.status, 500);
  assert.equal(await isChannelHuman(channel.id, member.id), true);

  const leaveServer = await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, { method: "POST", headers: await headers(member.id, server.id) });
  assert.equal(leaveServer.status, 500);
  assert.equal((await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)))).length, 1);
  assert.equal(await isChannelHuman(channel.id, member.id), true);
  assert.deepEqual(await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, member.id)), [], "nothing of the failed removals is recorded");
});

test("server owners do not read channel membership events; the platform-admin list does", async ({ app, seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const privateChannel = await seed.channel({ server, members: [member], visibility: "private" });
  const dm = await findOrCreateUserDM(server.id, owner.id, member.id);
  assert.ok(dm);

  const leave = await fetch(`${app.baseUrl}/api/channels/${privateChannel.id}/leave`, { method: "POST", headers: await headers(member.id, server.id) });
  assert.equal(leave.status, 200, await leave.text());
  const leaveDm = await fetch(`${app.baseUrl}/api/channels/${dm.id}/members/user/${member.id}`, { method: "DELETE", headers: await headers(member.id, server.id) });
  assert.equal(leaveDm.status, 200, await leaveDm.text());
  const written = await channelEvents(member.id);
  assert.deepEqual(new Set(written.map((event) => (event.metadata as { channelId: string }).channelId)), new Set([privateChannel.id, dm.id]));

  for (const query of ["", "?category=membership", `?actorType=human&actorId=${member.id}`]) {
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/audit-events${query}`, { headers: await headers(owner.id, server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { events: Array<{ eventType: string }>; people: Record<string, unknown> };
    assert.deepEqual(body.events.filter((event) => event.eventType.startsWith("channel.")), [], `no channel.* rows (${query || "no filter"})`);
    assert.equal(body.people[`human:${member.id}`], undefined, "the leaver is named by no visible event");
  }

  const platform = (await listIntegrationAuditEventsForAppAdmin(250)).filter((event) => event.eventType.startsWith("channel.") && event.serverId === server.id);
  assert.deepEqual(new Set(platform.map((event) => event.id)), new Set(written.map((event) => event.id)));
});
