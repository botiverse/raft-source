import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiTest } from "../test/integration/apiTest";
import { servers } from "../db/schema";
import { prepareJointHumanMembershipMirror } from "../services/jointHumanMembershipMirror";
import { acceptJointChannelInvite, addHuman, createChannel, createJointChannel } from "../services/channelService";
import { seedBoundGuest } from "../test/guestFixture";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";

type Profile = {
  userId: string;
  serverId: string;
  serverName: string;
  serverSlug: string;
  role: string | null;
  email: string | null;
  servers?: Array<{ id: string; name: string; slug: string }>;
};

// #wg-rbac:#58: a profile opened from a channel (`?channelId=`) names the
// person's servers in THAT channel, as the viewer's roster row does, never
// the first shared joint channel's.
apiTest("a profile opened from a channel names the person's servers in that channel, and a channel the viewer cannot see is the unknown user's 404", async ({ db, seed, http }) => {
  const ownerV = await seed.human(), ownerA = await seed.human(), ownerB = await seed.human();
  const viewer = await seed.human(), pat = await seed.human(), guest = await seed.human();
  const v = await seed.server({ owner: ownerV, name: "Victor", members: [viewer] });
  const a = await seed.server({ owner: ownerA, name: "Alpha", members: [pat] });
  const b = await seed.server({ owner: ownerB, name: "Bravo", members: [pat] });
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, v.id));
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, b.id));
  // #acme-launch: hosted by V, Pat in through Alpha.
  const launch = await createJointChannel({
    hostServerId: v.id, createdByUserId: ownerV.id, name: "acme-launch",
    targetServerSlug: a.slug, invitedPeople: [`@${ownerA.name}`], userIds: [viewer.id],
  });
  const launchAlpha = await acceptJointChannelInvite({ inviteId: launch.invites[0]!.id, targetServerId: a.id, acceptedByUserId: ownerA.id });
  await addHuman(launchAlpha.id, pat.id);
  // #bravo-ops: hosted by Bravo, V joins; Pat in through Bravo.
  const ops = await createJointChannel({
    hostServerId: b.id, createdByUserId: ownerB.id, name: "bravo-ops",
    targetServerSlug: v.slug, invitedPeople: [`@${ownerV.name}`],
  });
  const opsVictor = await acceptJointChannelInvite({ inviteId: ops.invites[0]!.id, targetServerId: v.id, acceptedByUserId: ownerV.id });
  await addHuman(ops.channel.id, pat.id);
  await addHuman(opsVictor.id, viewer.id);
  // V's own channels: one the viewer is in without Pat, one it cannot see.
  const plain = await createChannel(v.id, `plain-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: ownerV.id });
  await addHuman(plain.id, viewer.id);
  const secret = await createChannel(v.id, `secret-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: ownerV.id });

  const profileOf = async (who: { id: string }, memberId: string, channelId?: string) => {
    const query = channelId === undefined ? "" : `?channelId=${encodeURIComponent(channelId)}`;
    const response = await http.as(who, v).get(`/api/servers/${v.id}/members/${memberId}/profile${query}`);
    return { status: response.status, text: await response.text() };
  };
  const ok = async (who: { id: string }, memberId: string, channelId?: string) => {
    const result = await profileOf(who, memberId, channelId);
    assert.equal(result.status, 200, result.text);
    return JSON.parse(result.text) as Profile;
  };
  const roster = async (who: { id: string }, channelId: string) => {
    const response = await http.as(who, v).get(`/api/channels/${channelId}/members`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { humans: Array<{ id: string; servers?: Profile["servers"] }> };
    return body.humans.find((human) => human.id === pat.id);
  };
  const serverOf = (server: { id: string; name: string; slug: string }) => ({ id: server.id, name: server.name, slug: server.slug });

  // Without channelId (older clients): unchanged, one of the shared channels' servers and no `servers`.
  const legacy = await ok(viewer, pat.id);
  assert.ok([a.id, b.id].includes(legacy.serverId), legacy.serverId);
  assert.equal(legacy.servers, undefined);

  // Each channel names its own server, as its roster row does; roles stay with their server.
  const inLaunch = await ok(viewer, pat.id, launch.channel.id);
  assert.deepEqual(inLaunch.servers, [serverOf(a)]);
  assert.deepEqual(inLaunch.servers, (await roster(viewer, launch.channel.id))?.servers);
  assert.deepEqual([inLaunch.serverId, inLaunch.serverName, inLaunch.serverSlug], [a.id, "Alpha", a.slug]);
  assert.equal(inLaunch.role, null);
  assert.equal(inLaunch.email, null);
  const inOps = await ok(viewer, pat.id, opsVictor.id);
  assert.deepEqual(inOps.servers, [serverOf(b)]);
  assert.deepEqual(inOps.servers, (await roster(viewer, opsVictor.id))?.servers);
  assert.deepEqual([inOps.serverId, inOps.serverName, inOps.serverSlug], [b.id, "Bravo", b.slug]);
  assert.equal(inOps.role, null);

  // A channel Pat is not in names no server, never another channel's.
  const notListed = await ok(viewer, pat.id, plain.id);
  assert.deepEqual(notListed.servers, []);
  assert.deepEqual([notListed.serverId, notListed.serverName, notListed.serverSlug], ["", "", ""]);

  // A channel the viewer cannot see answers exactly as an unknown user does.
  const unknown = await profileOf(viewer, randomUUID());
  assert.equal(unknown.status, 404);
  for (const channelId of [secret.id, ops.channel.id, launchAlpha.id, randomUUID(), "not-a-uuid"]) {
    assert.deepEqual(await profileOf(viewer, pat.id, channelId), unknown, `channelId ${channelId}`);
  }

  // A Guest bound to #acme-launch: that channel works, any other is the unknown user's 404.
  await enableExternalChannelsFlag(v.id);
  await seedBoundGuest({ serverId: v.id, userId: guest.id, channelId: launch.channel.id });
  await db.transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { channelIds: [launch.channel.id] }, "join");
    await mirror.apply([guest.id], { actorUserId: ownerV.id });
  });
  const guestCard = await ok(guest, pat.id, launch.channel.id);
  assert.deepEqual(guestCard.servers, [serverOf(a)]);
  assert.deepEqual([guestCard.serverId, guestCard.serverName], [a.id, "Alpha"]);
  assert.equal(guestCard.role, null);
  const guestUnknown = await profileOf(guest, randomUUID());
  assert.equal(guestUnknown.status, 404);
  for (const channelId of [opsVictor.id, plain.id]) {
    assert.deepEqual(await profileOf(guest, pat.id, channelId), guestUnknown, `guest channelId ${channelId}`);
  }
});
