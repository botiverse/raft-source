import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { asServerId, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { Database } from "../db";
import { channels, dmChannelIdentities, featureFlags, integrationAuditEvents, jointChannelMembers, jointChannels, jointChannelServers, notificationOutbox, serverMembers, servers } from "../db/schema";
import { __setHostDisconnectBeforeLocksHookForTests, acceptJointChannelInvite, addHuman, canUserAccessChannel, createJointChannel, removeHuman } from "../services/channelService";
import { addMember } from "../services/serverService";
import { withFeatureFlagLock } from "../services/featureFlagService";
import { createApiTest } from "../test/integration/apiTest";
import { createHttpClient } from "../test/integration/http";
import type { createSeed } from "../test/integration/seed";
import { enableExternalChannelsFlag, storeRetiredMemberConnectFlag } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { setJointFlags } from "../test/jointSourceExitScenario";
import { assertNoDmNotice, channelSystemLines, storedSystemMessages } from "../test/externalChannelSystemMessages";

/**
 * A joint channel's host disconnects a participant server
 * (POST /channels/:id/joint-servers/:serverId/disconnect, external_channels_v1
 * for the host; the retired joint_member_connect_v1 is not read, #wg-rbac:#55). The participant's copy goes as its own disconnect would take
 * it; only the host's owners/admins who can open the host's copy may do it.
 */
const test = createApiTest();

type Seed = ReturnType<typeof createSeed>;

/** The one gate (#wg-rbac:#55): external_channels_v1 on for the host. */
const enableHostDisconnect = (hostServerId: string) => enableExternalChannelsFlag(hostServerId);

/** Host H and participants B and C of one joint J. On B:
 * `onlyB` (B only) and `both` (H and B member, in through B). On H: a plain
 * member inside the channel and one outside it. */
async function seedJoint(db: Database, seed: Seed) {
  await setJointFlags(db, false);
  const hostOwner = await seed.human(), hostMember = await seed.human(), hostOutsider = await seed.human();
  const peerOwner = await seed.human(), thirdOwner = await seed.human();
  const onlyB = await seed.human(), both = await seed.human();
  const h = await seed.server({ owner: hostOwner, members: [hostMember, hostOutsider] });
  const b = await seed.server({ owner: peerOwner, members: [onlyB] });
  const c = await seed.server({ owner: thirdOwner });
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [h.id, b.id, c.id]));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name: `hd-${h.slug}`.slice(0, 40),
    targetServerSlug: b.slug, invitedPeople: [`@${peerOwner.name}`], userIds: [hostMember.id] });
  const bLocal = (await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: peerOwner.id })).id;
  await addMember(h.id, both.id); await addMember(b.id, both.id);
  await addHuman(bLocal, onlyB.id);
  await addHuman(bLocal, both.id);
  return { hostOwner, hostMember, hostOutsider, peerOwner, thirdOwner, onlyB, both, h, b, c,
    J: created.jointChannel.id, hLocal: created.channel.id, bLocal };
}

async function projectionState(db: Database, serverId: string, channelId: string) {
  const [side] = await db.select({ status: jointChannelServers.status, role: jointChannelServers.role, by: jointChannelServers.disconnectedByUserId })
    .from(jointChannelServers)
    .where(and(eq(jointChannelServers.localChannelId, channelId), eq(jointChannelServers.serverId, serverId)));
  const [row] = await db.select({ deletedAt: channels.deletedAt }).from(channels).where(eq(channels.id, channelId));
  return { status: side?.status, role: side?.role, deleted: row?.deletedAt !== null, by: side?.by ?? null };
}

async function auditRows(db: Database, jointId: string) {
  return (await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_disconnected")))
    .filter((row) => row.metadata.jointChannelId === jointId);
}

async function call(baseUrl: string, who: { id: string }, server: { id: string }, channelId: string, targetServerId: string) {
  const response = await createHttpClient(baseUrl).as(who, server)
    .request(`/api/channels/${channelId}/joint-servers/${targetServerId}/disconnect`, { method: "POST" });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

/** Nothing about B's connection changed and nothing was audited. */
async function assertUntouched(db: Database, x: Awaited<ReturnType<typeof seedJoint>>) {
  assert.deepEqual(await projectionState(db, x.b.id, x.bLocal), { status: "active", role: "participant", deleted: false, by: null });
  assert.deepEqual(await projectionState(db, x.h.id, x.hLocal), { status: "active", role: "host", deleted: false, by: null });
  assert.deepEqual(await auditRows(db, x.J), []);
}

test("external_channels_v1 off for the host: answered as an unknown channel and nothing changes, whatever the retired joint_member_connect_v1 stores", async ({ app, db, seed }) => {
  const x = await seedJoint(db, seed);
  // No stored row, stored off, stored on for the host: the same hidden 404.
  for (const retired of [null, "killed", { allow: [x.h.id] }] as const) {
    if (retired) await storeRetiredMemberConnectFlag(retired === "killed" ? retired : { allow: [...retired.allow] });
    const refused = await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.b.id);
    assert.equal(refused.status, 404, JSON.stringify([retired, refused.body]));
    assert.deepEqual(refused.body, { error: "Channel not found" }, JSON.stringify(retired));
    await assertUntouched(db, x);
  }
});

test("the host's owner disconnects B: B's copy goes, the joint stays, only people in through B alone lose it, both servers audited", async ({ app, db, seed }) => {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);
  // external_channels_v1 alone: the retired joint_member_connect_v1 stored off for everyone closes nothing.
  await storeRetiredMemberConnectFlag("killed");
  assert.equal(await canUserAccessChannel(x.bLocal, x.onlyB.id, asServerId(x.b.id)), true, "fixture: onlyB is in through B");

  const done = await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.b.id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(await projectionState(db, x.b.id, x.bLocal), { status: "disconnected", role: "participant", deleted: true, by: x.hostOwner.id });
  assert.deepEqual(await projectionState(db, x.h.id, x.hLocal), { status: "active", role: "host", deleted: false, by: null });
  const [joint] = await db.select({ status: jointChannels.status }).from(jointChannels).where(eq(jointChannels.id, x.J));
  assert.equal(joint?.status, "active", "the joint stays for the host");

  const member = async (userId: string) => (await db.select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, x.J), eq(jointChannelMembers.userId, userId))))[0];
  assert.equal(await member(x.onlyB.id), undefined, "no other entry: out of the joint");
  assert.equal(await canUserAccessChannel(x.bLocal, x.onlyB.id, asServerId(x.b.id)), false);
  assert.ok(await member(x.both.id), "an H identity keeps the joint");
  assert.equal(await canUserAccessChannel(x.hLocal, x.both.id, asServerId(x.h.id)), true, "and the entry through H");
  assert.equal(await canUserAccessChannel(x.hLocal, x.hostOwner.id, asServerId(x.h.id)), true);

  const audit = await auditRows(db, x.J);
  assert.deepEqual(audit.map((row) => row.serverId).sort(), [x.h.id, x.b.id].sort(), "one event on each server");
  for (const row of audit) {
    assert.equal(row.actorType, "human");
    assert.equal(row.actorId, x.hostOwner.id);
    assert.equal(row.targetId, x.b.id);
    assert.equal(row.eventCategory, "membership");
    assert.equal(row.metadata.byHost, true);
    assert.equal(row.metadata.hostServerId, x.h.id);
    assert.equal(row.metadata.disconnectedServerId, x.b.id);
    assert.equal(row.metadata.channelId, row.serverId === x.h.id ? x.hLocal : x.bLocal);
    assert.equal(row.metadata.actorRole, "owner");
  }
  assert.equal(audit[0]!.metadata.operationId, audit[1]!.metadata.operationId, "one operation");

  const again = await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.b.id);
  assert.equal(again.status, 404, JSON.stringify(again.body));
  assert.equal(again.body.code, "server_not_connected", "B is gone");
});

test("only the host's owners and admins, from the host's copy", async ({ app, db, seed }) => {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);
  await enableHostDisconnect(x.b.id);

  const member = await call(app.baseUrl, x.hostMember, x.h, x.hLocal, x.b.id);
  assert.equal(member.status, 403, JSON.stringify(member.body));
  assert.equal(member.body.code, "forbidden");
  assert.equal(member.body.error, "Only admins of the host server can disconnect another server.");

  const fromB = await call(app.baseUrl, x.peerOwner, x.b, x.bLocal, x.h.id);
  assert.equal(fromB.status, 400, JSON.stringify(fromB.body));
  assert.equal(fromB.body.code, "not_joint_host", "a participant disconnects itself through POST /:id/disconnect");
  assert.equal(fromB.body.error, "Only the host server can disconnect another server. To leave, disconnect your own server instead.");
  await assertUntouched(db, x);
});

test("a host owner/admin who can't open the host's copy is refused; an outsider sees an unknown channel", async ({ app, db, seed }) => {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);
  const hostAdmin = await seed.human();
  await addMember(x.h.id, hostAdmin.id, "admin");

  const unknown = await call(app.baseUrl, x.hostOutsider, x.h, randomUUID(), x.b.id);
  const hidden = await call(app.baseUrl, x.hostOutsider, x.h, x.hLocal, x.b.id);
  assert.equal(unknown.status, 404);
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, unknown.body, "byte-identical to an unknown channel");
  assert.deepEqual(hidden.body, { error: "Channel not found" });

  // An admin outside the channel: canSeeChannel hides it, as for anyone outside.
  const admin = await call(app.baseUrl, hostAdmin, x.h, x.hLocal, x.b.id);
  assert.equal(admin.status, 404, JSON.stringify(admin.body));
  assert.deepEqual(admin.body, { error: "Channel not found" });
  await assertUntouched(db, x);
});

test("the target must be an active participant of this joint", async ({ app, db, seed }) => {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);

  for (const target of [x.c.id, randomUUID(), "not-a-uuid"]) {
    const refused = await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, target);
    assert.equal(refused.status, 404, `${target}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "server_not_connected");
  }
  const self = await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.h.id);
  assert.equal(self.status, 400, JSON.stringify(self.body));
  assert.equal(self.body.code, "host_cannot_be_disconnected");
  assert.equal(self.body.error, "The host server can't disconnect from its own channel. Archive the channel instead.");
  await assertUntouched(db, x);
});

test("a participant copy with a bound Guest is refused with guests_present and nothing changes", async ({ app, db, seed }) => {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);
  const guest = await seed.human();
  await seedBoundGuest({ serverId: x.b.id, userId: guest.id, channelId: x.bLocal, member: false });

  const refused = await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.b.id);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "guests_present");
  await assertUntouched(db, x);
});

/** Runs `change` (committed) after the route's checks passed and before the service takes its locks. */
async function withChangeBeforeLocks<T>(change: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  let ran = false;
  __setHostDisconnectBeforeLocksHookForTests(async () => { ran = true; await change(); });
  try {
    const result = await run();
    assert.equal(ran, true, "the change ran inside the window");
    return result;
  } finally {
    __setHostDisconnectBeforeLocksHookForTests(null);
  }
}

test("external_channels_v1 turned off after the route's check: the service re-reads it under its lock and refuses as an unknown channel", async ({ app, db, seed }) => {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);
  const refused = await withChangeBeforeLocks(
    () => withFeatureFlagLock(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, async (tx) => {
      await tx.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
    }),
    () => call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.b.id));
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, { error: "Channel not found" });
  await assertUntouched(db, x);
});

/** A host admin in the host's copy. */
async function seedWithHostAdmin(db: Database, seed: Seed) {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);
  const hostAdmin = await seed.human();
  await addMember(x.h.id, hostAdmin.id, "admin");
  await addHuman(x.hLocal, hostAdmin.id);
  return { ...x, hostAdmin };
}

test("a host admin still in the host's copy disconnects B", async ({ app, db, seed }) => {
  const x = await seedWithHostAdmin(db, seed);
  const done = await call(app.baseUrl, x.hostAdmin, x.h, x.hLocal, x.b.id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(await projectionState(db, x.b.id, x.bLocal), { status: "disconnected", role: "participant", deleted: true, by: x.hostAdmin.id });
});

test("an admin demoted after the route's check is refused under the locks, nothing written", async ({ app, db, seed }) => {
  const x = await seedWithHostAdmin(db, seed);
  const refused = await withChangeBeforeLocks(
    async () => { await db.update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, x.h.id), eq(serverMembers.userId, x.hostAdmin.id))); },
    () => call(app.baseUrl, x.hostAdmin, x.h, x.hLocal, x.b.id));
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "forbidden");
  await assertUntouched(db, x);
});

test("an admin removed from the host's copy after the route's check is refused under the locks, nothing written", async ({ app, db, seed }) => {
  const x = await seedWithHostAdmin(db, seed);
  const refused = await withChangeBeforeLocks(
    async () => { await removeHuman(x.hLocal, x.hostAdmin.id, { self: true }); },
    () => call(app.baseUrl, x.hostAdmin, x.h, x.hLocal, x.b.id));
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "forbidden");
  await assertUntouched(db, x);
});

/** B and H with their own names, and a B admin besides its owner. */
async function seedNamed(db: Database, seed: Seed) {
  const x = await seedJoint(db, seed);
  await enableHostDisconnect(x.h.id);
  await db.update(servers).set({ name: "Hostco" }).where(eq(servers.id, x.h.id));
  await db.update(servers).set({ name: "Bravo Labs" }).where(eq(servers.id, x.b.id));
  const bAdmin = await seed.human();
  await addMember(x.b.id, bAdmin.id, "admin");
  return { ...x, bAdmin };
}

const DISCONNECTED_LINE = "Hostco disconnected Bravo Labs from this channel.";

test("the host disconnects B: one system message in the channel, read from the host's copy; B's owners and admins get no self-DM notice (cindyz, #42 A)", async ({ app, db, seed }) => {
  const x = await seedNamed(db, seed);
  const [joint] = await db.select({ canonical: jointChannels.canonicalChannelId }).from(jointChannels).where(eq(jointChannels.id, x.J));
  const done = await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.b.id);
  assert.equal(done.status, 200, JSON.stringify(done.body));

  assert.deepEqual(await storedSystemMessages(db, "channel.joint_disconnect"), [{ content: DISCONNECTED_LINE, channelId: joint!.canonical }], "one row, on the canonical channel");
  assert.deepEqual((await channelSystemLines(app.baseUrl, x.hostMember, x.h, x.hLocal)).filter((line) => line === DISCONNECTED_LINE), [DISCONNECTED_LINE], "a host member reads it");

  await assertNoDmNotice(db);
  assert.deepEqual(await db.select({ id: dmChannelIdentities.channelId }).from(dmChannelIdentities)
    .where(and(eq(dmChannelIdentities.serverId, x.b.id), eq(dmChannelIdentities.kind, "human_self"))), [], "no self-DM created on B");
  for (const who of [x.peerOwner, x.bAdmin]) {
    assert.deepEqual(await db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(and(eq(notificationOutbox.receiverId, who.id), eq(notificationOutbox.category, "system_notice"))), [], `${who.name}: no device notice`);
  }
  assert.equal((await auditRows(db, x.J)).length, 2, "the audit events stay");

  // A replay finds B gone: no second message.
  assert.equal((await call(app.baseUrl, x.hostOwner, x.h, x.hLocal, x.b.id)).status, 404);
  assert.equal((await storedSystemMessages(db, "channel.joint_disconnect")).length, 1);
});
