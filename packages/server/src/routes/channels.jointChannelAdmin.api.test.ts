import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, channelHumans, jointChannels, jointChannelServers } from "../db/schema";
import { addMember } from "../services/serverService";
import { addHuman, createChannel } from "../services/channelService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

// Joint channel parity t5 (#proj-joint-channel:2541153f), under computed
// membership (the only mode): a channel admin appointed on the host's copy is
// a host manager. It edits the shared name/description, archives and removes
// members from the host; roles stay with the host's owners/admins.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedJoint(prefix: string) {
  const db = getDb();
  const hostOwner = await seedUser(`${prefix}-host-owner@slock.test`, `${prefix}-host-owner`);
  const hostMember = await seedUser(`${prefix}-host-member@slock.test`, `${prefix}-host-member`);
  const hostOther = await seedUser(`${prefix}-host-other@slock.test`, `${prefix}-host-other`);
  const peerOwner = await seedUser(`${prefix}-peer-owner@slock.test`, `${prefix}-peer-owner`);
  const peerMember = await seedUser(`${prefix}-peer-member@slock.test`, `${prefix}-peer-member`);
  const hostServer = await createServer(`${prefix} host`, `${prefix}-host`, hostOwner.id);
  const peerServer = await createServer(`${prefix} peer`, `${prefix}-peer`, peerOwner.id);
  await addMember(hostServer.id, hostMember.id, "member");
  await addMember(hostServer.id, hostOther.id, "member");
  await addMember(peerServer.id, peerMember.id, "member");

  const canonical = await createChannel(hostServer.id, `${prefix}-storage`);
  const hostProjection = await createChannel(hostServer.id, `${prefix}-room`, undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, `${prefix}-room`, undefined, "joint");
  for (const user of [hostOwner, hostMember, hostOther]) await addHuman(hostProjection.id, user.id);
  for (const user of [peerOwner, peerMember]) await addHuman(peerProjection.id, user.id);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();
  return {
    hostServer, peerServer, hostProjection, peerProjection,
    hostOwner, hostMember, hostOther, peerMember,
    token: {
      hostOwner: await tokenForHuman(hostOwner.email),
      hostMember: await tokenForHuman(hostMember.email),
      hostOther: await tokenForHuman(hostOther.email),
    },
  };
}

async function setRole(baseUrl: string, token: string, serverId: string, channelId: string, userId: string, role: "admin" | "member") {
  return fetch(`${baseUrl}/api/channels/${channelId}/members/user/${userId}/role`, {
    method: "PATCH",
    headers: headers(token, serverId),
    body: JSON.stringify({ role }),
  });
}

async function patchChannel(baseUrl: string, token: string, serverId: string, channelId: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/channels/${channelId}`, {
    method: "PATCH",
    headers: headers(token, serverId),
    body: JSON.stringify(body),
  });
}

test("a joint channel admin renames the joint channel for every server; a plain member cannot", async ({ app }) => {
  const f = await seedJoint("jca-rename");

  // Before promotion a plain server member cannot edit the shared metadata.
  const denied = await patchChannel(app.baseUrl, f.token.hostMember, f.hostServer.id, f.hostProjection.id, { description: "nope" });
  assert.equal(denied.status, 403, await denied.text());

  // The host server's owner makes a host member channel admin on the host projection.
  const promote = await setRole(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id, f.hostMember.id, "admin");
  assert.equal(promote.status, 200, await promote.text());
  const [row] = await getDb().select({ role: channelHumans.role }).from(channelHumans)
    .where(and(eq(channelHumans.channelId, f.hostProjection.id), eq(channelHumans.userId, f.hostMember.id)));
  assert.equal(row?.role, "admin");

  const renamed = await patchChannel(app.baseUrl, f.token.hostMember, f.hostServer.id, f.hostProjection.id, {
    name: "jca-renamed",
    description: "set by a joint channel admin",
  });
  assert.equal(renamed.status, 200, await renamed.text());
  for (const projectionId of [f.hostProjection.id, f.peerProjection.id]) {
    const [projection] = await getDb().select({ name: channels.name, description: channels.description })
      .from(channels).where(eq(channels.id, projectionId));
    assert.deepEqual(projection, { name: "jca-renamed", description: "set by a joint channel admin" }, projectionId);
  }

  // Visibility still cannot change, even for an admin.
  const visibility = await patchChannel(app.baseUrl, f.token.hostMember, f.hostServer.id, f.hostProjection.id, { visibility: "private" });
  assert.equal(visibility.status, 403, await visibility.text());

  // Another plain member is still denied.
  const other = await patchChannel(app.baseUrl, f.token.hostOther, f.hostServer.id, f.hostProjection.id, { description: "nope" });
  assert.equal(other.status, 403, await other.text());
});

test("the joint roster offers a role change only for this server's own members", async ({ app }) => {
  const f = await seedJoint("jca-roster");
  const response = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/members`, {
    headers: headers(f.token.hostOwner, f.hostServer.id),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const roster = JSON.parse(raw) as { humans: Array<{ id: string; canChangeChannelRole?: boolean }> };
  const byId = new Map(roster.humans.map((human) => [human.id, human]));
  assert.equal(byId.get(f.hostMember.id)?.canChangeChannelRole, true, "own server's member");
  assert.ok(byId.has(f.peerMember.id), "the joint roster merges the peer server's members");
  assert.equal(byId.get(f.peerMember.id)?.canChangeChannelRole, false, "another server's member");
});

test("the channel list grants a host-appointed manager the host's management capabilities, never member roles or visitor access", async ({ app }) => {
  const f = await seedJoint("jca-caps");
  const promote = await setRole(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id, f.hostMember.id, "admin");
  assert.equal(promote.status, 200, await promote.text());
  const response = await fetch(`${app.baseUrl}/api/channels`, { headers: headers(f.token.hostMember, f.hostServer.id) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const row = (JSON.parse(raw) as Array<Record<string, any>>).find((channel) => channel.id === f.hostProjection.id);
  assert.equal(row?.type, "joint");
  assert.equal(row?.channelCapabilities?.editChannelMetadata, true);
  // Roles and inviting servers stay with the host's owners/admins.
  assert.equal(row?.channelCapabilities?.changeChannelMemberRoles, false);
  assert.equal(row?.channelCapabilities?.archiveChannels, true);
  assert.equal(row?.channelCapabilities?.removeChannelMembers, true);
  assert.equal(row?.channelCapabilities?.manageVisitorAccess, false);
});
