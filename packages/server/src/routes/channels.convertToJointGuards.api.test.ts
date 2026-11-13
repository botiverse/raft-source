import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelConversionCommands, channelConversionJobs, channels, jointChannelInvites, serverMembers } from "../db/schema";
import { addHuman, createChannel } from "../services/channelService";
import { startChannelToJointConversion } from "../services/channelConversionService";
import { seedBoundGuest } from "../test/guestFixture";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

/**
 * The old ways of making a joint channel from Settings (Convert to joint) and
 * Create Channel (Create Joint Channel):
 * - Convert to joint is retired on every Server (#wg-rbac:#50): 404
 *   joint_conversion_retired, nothing written, whether external_channels_v1
 *   is on or off (it alone allows converting, through an external invite);
 * - with external_channels_v1 on, Create Joint Channel is retired too (404
 *   joint_creation_retired), and so are inviting another Server into an
 *   existing joint channel and re-sending those invites
 *   (joint_server_invite_retired, cindyz #wg-rbac 45b37df9), while an invite
 *   already sent can still be accepted;
 * - the conversion start refuses a channel with a bound Guest
 *   (guests_present, as connecting a server to it is refused): a Guest can't
 *   be in a joint channel until P3, so it would be left bound to a channel it
 *   can't open.
 */
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedRoom(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`${label}-owner-${suffix}@slock.test`, `${label}-owner-${suffix}`);
  const server = await createServer(`${label} ${suffix}`, `${label}-${suffix}`, owner.id);
  const room = await createChannel(server.id, `${label}-room`, undefined, "private");
  await addHuman(room.id, owner.id, { role: "admin" });
  return { owner, server, room, ownerToken: await tokenForHuman(owner.email) };
}

async function convert(baseUrl: string, token: string, serverId: string, channelId: string, body: Record<string, unknown> = { observeProgress: true }) {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}/convert-to-joint`, {
    method: "POST", headers: headers(token, serverId), body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as { code?: string; error?: string; channel?: { type: string } } };
}

async function conversionRows(channelId: string) {
  const db = getDb();
  return {
    commands: (await db.select({ id: channelConversionCommands.id }).from(channelConversionCommands).where(eq(channelConversionCommands.sourceChannelId, channelId))).length,
    jobs: (await db.select({ id: channelConversionJobs.id }).from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, channelId))).length,
  };
}

async function channelType(channelId: string) {
  return (await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, channelId)))[0]?.type;
}

test("converting a private channel with a bound Guest is refused with guests_present; the Guest keeps its channel", async ({ app }) => {
  const f = await seedRoom("cjg-guest");
  const guest = await seedUser(`cjg-guest-${randomUUID().slice(0, 8)}@slock.test`, `cjg-guest-${randomUUID().slice(0, 8)}`);
  await seedBoundGuest({ serverId: f.server.id, userId: guest.id, channelId: f.room.id });

  // The start refuses (under the conversion lock), for every caller (an external invite's reservation).
  await assert.rejects(
    () => startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.room.id, createdByUserId: f.owner.id }),
    { code: "guests_present" },
  );
  assert.deepEqual(await conversionRows(f.room.id), { commands: 0, jobs: 0 });

  const [binding] = await getDb().select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, guest.id)));
  assert.deepEqual(binding, { role: "guest", guestChannelId: f.room.id }, "the Guest is still bound to it");
  const read = await fetch(`${app.baseUrl}/api/messages/channel/${f.room.id}`, { headers: headers(await tokenForHuman(guest.email), f.server.id) });
  assert.equal(read.status, 200, await read.text());
});

test("with external_channels_v1 off, Convert to joint is retired too and writes nothing (#wg-rbac:#50)", async ({ app }) => {
  const f = await seedRoom("cjg-off");
  for (const body of [{}, { observeProgress: true }]) {
    const refused = await convert(app.baseUrl, f.ownerToken, f.server.id, f.room.id, body);
    assert.equal(refused.status, 404, refused.raw);
    assert.equal(refused.body.code, "joint_conversion_retired");
  }
  // Before any lookup: an unknown channel answers the same.
  const unknown = await convert(app.baseUrl, f.ownerToken, f.server.id, randomUUID());
  assert.deepEqual([unknown.status, unknown.body.code], [404, "joint_conversion_retired"], unknown.raw);
  assert.deepEqual(await conversionRows(f.room.id), { commands: 0, jobs: 0 });
  assert.equal(await channelType(f.room.id), "private");
});

test("with external_channels_v1 on, Convert to joint and Create Joint Channel are retired and write nothing", async ({ app }) => {
  const f = await seedRoom("cjg-retired");
  await enableExternalChannelsFlag(f.server.id);

  const refused = await convert(app.baseUrl, f.ownerToken, f.server.id, f.room.id);
  assert.equal(refused.status, 404, refused.raw);
  assert.equal(refused.body.code, "joint_conversion_retired");
  assert.deepEqual(await conversionRows(f.room.id), { commands: 0, jobs: 0 });
  assert.equal(await channelType(f.room.id), "private");

  const peerOwner = await seedUser(`cjg-peer-${randomUUID().slice(0, 8)}@slock.test`, `cjg-peer-${randomUUID().slice(0, 8)}`);
  const peer = await createServer("CJG Peer", `cjg-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  const created = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(f.ownerToken, f.server.id),
    body: JSON.stringify({ name: "cjg-new-joint", visibility: "joint", targetServerSlug: peer.slug, invitedPeople: [`@${peerOwner.name}`] }),
  });
  const createdRaw = await created.text();
  assert.equal(created.status, 404, createdRaw);
  assert.equal((JSON.parse(createdRaw) as { code?: string }).code, "joint_creation_retired");
  assert.equal((await getDb().select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, f.server.id), eq(channels.name, "cjg-new-joint")))).length, 0, "no channel is created");
});

test("with external_channels_v1 on, inviting another Server into a joint channel and re-sending are retired; a pending invite can still be accepted", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const f = await seedRoom("cjg-server-invite");
  const peerOwner = await seedUser(`cjg-si-peer-${suffix}@slock.test`, `cjg-si-peer-${suffix}`);
  const peer = await createServer("CJG SI Peer", `cjg-si-peer-${suffix}`, peerOwner.id);
  const thirdOwner = await seedUser(`cjg-si-third-${suffix}@slock.test`, `cjg-si-third-${suffix}`);
  const third = await createServer("CJG SI Third", `cjg-si-third-${suffix}`, thirdOwner.id);

  // Before the flag: a joint channel with a pending invite to the peer, the old way.
  const created = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(f.ownerToken, f.server.id),
    body: JSON.stringify({ name: "cjg-si-joint", visibility: "joint", targetServerSlug: peer.slug, invitedPeople: [`@${peerOwner.name}`] }),
  });
  const createdRaw = await created.text();
  assert.equal(created.status, 200, createdRaw);
  const joint = JSON.parse(createdRaw) as { id: string; jointInvite?: { id: string } | null };
  assert.ok(joint.jointInvite?.id, createdRaw);
  const invitesOf = async () => (await getDb().select({ id: jointChannelInvites.id, toServerId: jointChannelInvites.toServerId, status: jointChannelInvites.status })
    .from(jointChannelInvites).where(eq(jointChannelInvites.fromServerId, f.server.id))).sort((a, b) => a.id.localeCompare(b.id));
  const before = await invitesOf();
  assert.deepEqual(before.map((row) => [row.toServerId, row.status]), [[peer.id, "pending"]]);

  await enableExternalChannelsFlag(f.server.id);
  const post = async (path: string, body?: unknown) => {
    const response = await fetch(`${app.baseUrl}/api/channels/${joint.id}${path}`, {
      method: "POST", headers: headers(f.ownerToken, f.server.id), body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    return { status: response.status, raw, code: (JSON.parse(raw) as { code?: string }).code };
  };
  const invited = await post("/joint-invites", { targetServerSlug: third.slug, invitedPeople: [`@${thirdOwner.name}`] });
  assert.deepEqual([invited.status, invited.code], [404, "joint_server_invite_retired"], invited.raw);
  const resent = await post("/joint-invite/resend");
  assert.deepEqual([resent.status, resent.code], [404, "joint_server_invite_retired"], resent.raw);
  // Same refusal before any lookup: an unknown channel id answers the same.
  const unknown = await fetch(`${app.baseUrl}/api/channels/${randomUUID()}/joint-invites`, {
    method: "POST", headers: headers(f.ownerToken, f.server.id), body: JSON.stringify({ targetServerSlug: third.slug, invitedPeople: [`@${thirdOwner.name}`] }),
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json() as { code?: string }).code, "joint_server_invite_retired");
  assert.deepEqual(await invitesOf(), before, "nothing is invited or re-sent");

  // The invite already sent is the peer's to accept.
  const accepted = await fetch(`${app.baseUrl}/api/channels/joint-invites/${joint.jointInvite!.id}/accept`, {
    method: "POST", headers: headers(await tokenForHuman(peerOwner.email), peer.id),
  });
  assert.equal(accepted.status, 200, await accepted.text());
  assert.deepEqual((await invitesOf()).map((row) => row.status), ["accepted"]);
});
