import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { seedBoundGuest } from "../test/guestFixture";
import { getDb } from "../db/index";
import { channels, featureFlags, integrationAuditEvents, jointChannels, jointChannelServers, servers } from "../db/schema";
import { addMember } from "../services/serverService";
import { addHuman, createChannel, getSystemAllChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

// "Visible to visitors" (#wg-rbac:#51, cindyz msg 4987425b): PATCH
// /api/channels/:id visitorVisible (legacy alias guestVisible) puts a plain
// public channel of a public server on its public page for signed-out
// visitors. Server owner/admin only; no longer behind server_guest_v0.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function setFlag(key: string, enabled: boolean) {
  await getDb().update(featureFlags)
    .set({ enabled, killSwitch: false, defaultEnabled: enabled })
    .where(eq(featureFlags.key, key));
}

async function seedPublicServer(prefix: string, opts: { publiclyVisible?: boolean } = {}) {
  await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, true);
  // The old gate stays off throughout: it no longer matters.
  await setFlag(SERVER_GUEST_FEATURE_FLAG_KEY, false);
  const owner = await seedUser(`${prefix}-owner@slock.test`, `${prefix}-owner`);
  const admin = await seedUser(`${prefix}-admin@slock.test`, `${prefix}-admin`);
  const member = await seedUser(`${prefix}-member@slock.test`, `${prefix}-member`);
  const slug = `${prefix}-${randomUUID().slice(0, 8)}`;
  const server = await createServer(`${prefix} server`, slug, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, member.id, "member");
  if (opts.publiclyVisible !== false) {
    await getDb().update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
  }
  const channel = await createChannel(server.id, `${prefix}-room`, undefined, "channel", { type: "user", id: owner.id });
  return {
    server, slug, channel, owner, admin, member,
    token: {
      owner: await tokenForHuman(owner.email),
      admin: await tokenForHuman(admin.email),
      member: await tokenForHuman(member.email),
    },
  };
}

function patch(baseUrl: string, token: string, serverId: string, channelId: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/channels/${channelId}`, {
    method: "PATCH",
    headers: headers(token, serverId),
    body: JSON.stringify(body),
  });
}

async function storedVisible(channelId: string): Promise<boolean> {
  const [row] = await getDb().select({ guestVisible: channels.guestVisible }).from(channels).where(eq(channels.id, channelId));
  return row!.guestVisible;
}

const REQUIRES_PUBLIC_SERVER = {
  error: "Make the server public before making its channels visible to visitors",
  code: "visitor_visibility_requires_public_server",
  errorCode: "visitor_visibility_requires_public_server",
};
const REQUIRES_PUBLIC_CHANNEL = {
  error: "Only a public channel can be visible to visitors",
  code: "visitor_visibility_requires_public_channel",
  errorCode: "visitor_visibility_requires_public_channel",
};
const UNSUPPORTED_CHANNEL = {
  error: "Visitor visibility is supported only for ordinary channels",
  code: "visitor_visibility_unsupported_channel",
  errorCode: "visitor_visibility_unsupported_channel",
};
const FORBIDDEN = {
  error: "Only server owners and admins can change whether a channel is visible to visitors",
  code: "visitor_visibility_forbidden",
  errorCode: "visitor_visibility_forbidden",
};

test("an owner makes a public channel visible to visitors with server_guest_v0 off; a signed-out visitor reads it until it is turned off; each change is audited", async ({ app }) => {
  const f = await seedPublicServer("vv-owner");
  const posted = await createMessage(f.channel.id, "user", f.owner.id, "vv-owner hello");
  const msgsUrl = `${app.baseUrl}/api/public/servers/${f.slug}/channels/${f.channel.id}/messages`;
  assert.equal((await fetch(msgsUrl)).status, 404, "not readable before it is made visible");

  const shown = await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { visitorVisible: true });
  assert.equal(shown.status, 200, await shown.clone().text());
  const shownBody = await shown.json() as { visitorVisible: boolean; guestVisible: boolean };
  assert.equal(shownBody.visitorVisible, true);
  assert.equal(shownBody.guestVisible, true, "older clients still read guestVisible");

  // No Authorization header: a signed-out visitor.
  const read = await fetch(msgsUrl);
  assert.equal(read.status, 200, await read.clone().text());
  assert.ok((await read.text()).includes(posted.id));
  const listed = await (await fetch(`${app.baseUrl}/api/public/servers/${f.slug}`)).json() as { channels: { id: string }[] };
  assert.deepEqual(listed.channels.map((c) => c.id), [f.channel.id]);

  // Payloads Kirby's toggle reads carry the field.
  const got = await (await fetch(`${app.baseUrl}/api/channels/${f.channel.id}`, { headers: headers(f.token.owner, f.server.id) })).json() as { visitorVisible: boolean; channelCapabilities?: Record<string, boolean> };
  assert.equal(got.visitorVisible, true);
  assert.equal(got.channelCapabilities?.manageVisitorAccess, true);
  const list = await (await fetch(`${app.baseUrl}/api/channels`, { headers: headers(f.token.owner, f.server.id) })).json() as Array<{ id: string; visitorVisible?: boolean }>;
  assert.equal(list.find((c) => c.id === f.channel.id)?.visitorVisible, true);

  const hidden = await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { visitorVisible: false });
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json() as { visitorVisible: boolean }).visitorVisible, false);
  assert.equal((await fetch(msgsUrl)).status, 404, "turned off: the visitor's next read fails");

  // A no-op write records nothing.
  assert.equal((await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { visitorVisible: false })).status, 200);
  const events = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.serverId, f.server.id),
    eq(integrationAuditEvents.eventType, "channel.visitor_visibility_changed"),
  )).orderBy(integrationAuditEvents.createdAt);
  assert.deepEqual(events.map((e) => [e.actorType, e.actorId, e.targetType, e.targetId, e.eventCategory, e.metadata]), [
    ["human", f.owner.id, "channel", f.channel.id, "server_profile", { channelId: f.channel.id, visitorVisible: true, actorRole: "owner" }],
    ["human", f.owner.id, "channel", f.channel.id, "server_profile", { channelId: f.channel.id, visitorVisible: false, actorRole: "owner" }],
  ]);
});

test("a server admin may set it; a member, a channel admin who is a member, and a Guest may not", async ({ app }) => {
  const f = await seedPublicServer("vv-roles");
  const byAdmin = await patch(app.baseUrl, f.token.admin, f.server.id, f.channel.id, { visitorVisible: true });
  assert.equal(byAdmin.status, 200, await byAdmin.clone().text());
  assert.equal(await storedVisible(f.channel.id), true);

  const byMember = await patch(app.baseUrl, f.token.member, f.server.id, f.channel.id, { visitorVisible: false });
  assert.equal(byMember.status, 403);
  assert.deepEqual(await byMember.json(), FORBIDDEN);

  // A channel admin role used to grant the old manageGuestAccess; it no longer does.
  await addHuman(f.channel.id, f.member.id, { role: "admin" });
  const byChannelAdmin = await patch(app.baseUrl, f.token.member, f.server.id, f.channel.id, { guestVisible: false });
  assert.equal(byChannelAdmin.status, 403);
  assert.deepEqual(await byChannelAdmin.json(), FORBIDDEN);

  const guest = await seedUser("vv-roles-guest@slock.test", "vv-roles-guest");
  const guestRoom = await createChannel(f.server.id, "vv-roles-guest-room", undefined, "private", { type: "user", id: f.owner.id });
  await seedBoundGuest({ serverId: f.server.id, userId: guest.id, channelId: guestRoom.id });
  const byGuest = await patch(app.baseUrl, await tokenForHuman(guest.email), f.server.id, guestRoom.id, { visitorVisible: false });
  assert.equal(byGuest.status, 403);
  assert.deepEqual(await byGuest.json(), FORBIDDEN);
  assert.equal(await storedVisible(f.channel.id), true, "no refused write changed the channel");
});

test("turning it on is refused on a non-public server, a private channel, #all, a joint channel and a channel with an external relation; turning it off is allowed", async ({ app }) => {
  // Not public: the column off, then the column on but public_server_v0 off.
  const closed = await seedPublicServer("vv-closed", { publiclyVisible: false });
  const notPublic = await patch(app.baseUrl, closed.token.owner, closed.server.id, closed.channel.id, { visitorVisible: true });
  assert.equal(notPublic.status, 400);
  assert.deepEqual(await notPublic.json(), REQUIRES_PUBLIC_SERVER);
  await getDb().update(servers).set({ publiclyVisible: true }).where(eq(servers.id, closed.server.id));
  await setFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY, false);
  const flagOff = await patch(app.baseUrl, closed.token.owner, closed.server.id, closed.channel.id, { visitorVisible: true });
  assert.equal(flagOff.status, 400);
  assert.deepEqual(await flagOff.json(), REQUIRES_PUBLIC_SERVER);
  assert.equal(await storedVisible(closed.channel.id), false);

  const f = await seedPublicServer("vv-kinds");
  const priv = await createChannel(f.server.id, "vv-kinds-private", undefined, "private", { type: "user", id: f.owner.id });
  const onPrivate = await patch(app.baseUrl, f.token.owner, f.server.id, priv.id, { visitorVisible: true });
  assert.equal(onPrivate.status, 400);
  assert.deepEqual(await onPrivate.json(), REQUIRES_PUBLIC_CHANNEL);
  // Off on a private channel is allowed (a no-op).
  assert.equal((await patch(app.baseUrl, f.token.owner, f.server.id, priv.id, { visitorVisible: false })).status, 200);

  // Made private in the same request: refused, nothing written.
  await addHuman(f.channel.id, f.owner.id);
  const goingPrivate = await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { visibility: "private", visitorVisible: true });
  assert.equal(goingPrivate.status, 400);
  assert.deepEqual(await goingPrivate.json(), REQUIRES_PUBLIC_CHANNEL);

  // #all was accepted before #wg-rbac:#51; its audience is managed on its own surfaces.
  const all = await getSystemAllChannel(f.server.id);
  assert.ok(all);
  const onAll = await patch(app.baseUrl, f.token.owner, f.server.id, all.id, { visitorVisible: true });
  assert.equal(onAll.status, 400);
  assert.deepEqual(await onAll.json(), REQUIRES_PUBLIC_CHANNEL);
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, all.id));
  assert.equal((await patch(app.baseUrl, f.token.owner, f.server.id, all.id, { visitorVisible: false })).status, 200, "an #all marked before can be turned off");
  assert.equal(await storedVisible(all.id), false);

  // Joint channel: the existing neutral refusal, on or off.
  const peerOwner = await seedUser("vv-kinds-peer@slock.test", "vv-kinds-peer");
  const peer = await createServer("vv peer", `vv-kinds-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  const canonical = await createChannel(f.server.id, "vv-kinds-storage");
  const hostProjection = await createChannel(f.server.id, "vv-kinds-joint", undefined, "joint");
  const peerProjection = await createChannel(peer.id, "vv-kinds-joint", undefined, "joint");
  await addHuman(hostProjection.id, f.owner.id);
  const [joint] = await getDb().insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: f.server.id, createdByUserId: f.owner.id }).returning();
  await getDb().insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: f.server.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: f.owner.id },
    { jointChannelId: joint!.id, serverId: peer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();
  for (const visitorVisible of [true, false]) {
    const onJoint = await patch(app.baseUrl, f.token.owner, f.server.id, hostProjection.id, { visitorVisible });
    assert.equal(onJoint.status, 400);
    assert.deepEqual(await onJoint.json(), UNSUPPORTED_CHANNEL);
  }

  // A public channel with an external relation (a bound Guest): the same neutral refusal.
  const external = await createChannel(f.server.id, "vv-kinds-external", undefined, "channel", { type: "user", id: f.owner.id });
  const guest = await seedUser("vv-kinds-guest@slock.test", "vv-kinds-guest");
  await seedBoundGuest({ serverId: f.server.id, userId: guest.id, channelId: external.id });
  const onExternal = await patch(app.baseUrl, f.token.owner, f.server.id, external.id, { visitorVisible: true });
  assert.equal(onExternal.status, 400);
  assert.deepEqual(await onExternal.json(), UNSUPPORTED_CHANNEL);
  assert.equal(await storedVisible(external.id), false);
});

test("the legacy guestVisible alias still works; both fields disagreeing or a non-boolean is a 400", async ({ app }) => {
  const f = await seedPublicServer("vv-alias");
  const legacy = await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { guestVisible: true });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal((await legacy.json() as { visitorVisible: boolean }).visitorVisible, true);

  const conflict = await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { visitorVisible: false, guestVisible: true });
  assert.equal(conflict.status, 400);
  assert.deepEqual(await conflict.json(), { error: "visitorVisible and guestVisible disagree; send visitorVisible only", code: "visitor_visible_conflict", errorCode: "visitor_visible_conflict" });
  assert.equal(await storedVisible(f.channel.id), true, "a conflict writes nothing");

  const agreeing = await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { visitorVisible: false, guestVisible: false });
  assert.equal(agreeing.status, 200);
  assert.equal(await storedVisible(f.channel.id), false);

  const notBoolean = await patch(app.baseUrl, f.token.owner, f.server.id, f.channel.id, { visitorVisible: "yes" });
  assert.equal(notBoolean.status, 400);
  assert.deepEqual(await notBoolean.json(), { error: "visitorVisible must be a boolean", code: "visitor_visible_invalid", errorCode: "visitor_visible_invalid" });
});
