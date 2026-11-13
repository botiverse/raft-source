import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, integrationAuditEvents, jointChannelServers } from "../db/schema";
import { addMember } from "../services/serverService";
import { resolveJointHumanMembershipScopes } from "../services/jointHumanMembershipAccess";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

/**
 * Disconnect under computed joint membership: the host-only management rules must not take Disconnect away. Each other
 * connected server's owner/admin may disconnect their own server (the web
 * shows it from channelCapabilities.deleteChannels); a plain member may not.
 * With external_channels_v1 on for the host, the host can't disconnect itself
 * (host_cannot_disconnect): its owner/admins may only remove the other
 * servers. With it off, the host's owner/admin may, as before.
 *
 * Audit (#wg-rbac:#62): the joint invite's accept writes one
 * `channel.server_connected` on the host; a server disconnecting itself writes
 * one `channel.server_disconnected` (`byHost: false`) on each of the two
 * servers, each naming its own copy.
 */
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const auditRows = (eventType: "channel.server_connected" | "channel.server_disconnected") =>
  getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, eventType));

async function seedComputedJoint(baseUrl: string) {
  const db = getDb();
  const hostOwner = await seedUser("jdc-host-owner@slock.test", "jdc-host-owner");
  const peerOwner = await seedUser("jdc-peer-owner@slock.test", "jdc-peer-owner");
  const peerMember = await seedUser("jdc-peer-member@slock.test", "jdc-peer-member");
  const hostServer = await createServer("JDC Host", "jdc-host", hostOwner.id);
  const peerServer = await createServer("JDC Peer", "jdc-peer", peerOwner.id);
  await addMember(peerServer.id, peerMember.id, "member");
  const token = {
    hostOwner: await tokenForHuman(hostOwner.email),
    peerOwner: await tokenForHuman(peerOwner.email),
    peerMember: await tokenForHuman(peerMember.email),
  };

  const created = await fetch(`${baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(token.hostOwner, hostServer.id),
    body: JSON.stringify({ name: "jdc-room", visibility: "joint", targetServerSlug: peerServer.slug, invitedPeople: [`@${peerOwner.name}`] }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const hostProjection = await created.json() as { id: string; jointInvite: { id: string } };
  // An invite the member can't accept: refused, nothing connected, nothing audited.
  const refusedAccept = await fetch(`${baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(token.peerMember, peerServer.id),
  });
  assert.equal(refusedAccept.status, 404, await refusedAccept.clone().text());
  assert.deepEqual(await auditRows("channel.server_connected"), [], "a refused accept writes no channel.server_connected");
  const accepted = await fetch(`${baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(token.peerOwner, peerServer.id),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const peerProjection = await accepted.json() as { id: string };
  const connected = await auditRows("channel.server_connected");
  assert.equal(connected.length, 1, "one event for the accepted joint invite, on the host only");
  assert.deepEqual(
    { serverId: connected[0]!.serverId, actorId: connected[0]!.actorId, targetId: connected[0]!.targetId },
    { serverId: hostServer.id, actorId: peerOwner.id, targetId: peerServer.id },
  );
  const { operationId: connectOperationId, jointChannelId, ...connectedMetadata } = connected[0]!.metadata as Record<string, unknown>;
  assert.equal(typeof connectOperationId, "string");
  assert.deepEqual(connectedMetadata, { mode: "joint_invite", hostServerId: hostServer.id, channelId: hostProjection.id, connectedServerId: peerServer.id });
  const added = await fetch(`${baseUrl}/api/channels/${peerProjection.id}/members`, {
    method: "POST",
    headers: headers(token.peerOwner, peerServer.id),
    body: JSON.stringify({ userId: peerMember.id }),
  });
  assert.equal(added.status, 200, await added.clone().text());
  const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [peerProjection.id] }, db)).get(peerProjection.id);
  assert.ok(scope, "fixture: a joint projection");
  return { hostServer, peerServer, hostProjection, peerProjection, peerMember, peerOwner, jointChannelId, token };
}

async function capabilities(baseUrl: string, token: string, serverId: string, channelId: string) {
  const response = await fetch(`${baseUrl}/api/channels`, { headers: headers(token, serverId) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const row = (JSON.parse(raw) as Array<Record<string, any>>).find((channel) => channel.id === channelId);
  assert.ok(row, "the joint is in the list");
  return row.channelCapabilities as Record<string, boolean>;
}

test("with computed membership each other server's owner/admin may disconnect their own server; management stays with the host", async ({ app }) => {
  const f = await seedComputedJoint(app.baseUrl);

  const peerOwner = await capabilities(app.baseUrl, f.token.peerOwner, f.peerServer.id, f.peerProjection.id);
  assert.equal(peerOwner.deleteChannels, true, "the partner's owner sees Disconnect");
  assert.equal(peerOwner.editChannelMetadata, false, "renaming stays with the host");
  assert.equal(peerOwner.archiveChannels, false, "archiving stays with the host");
  const hostOwner = await capabilities(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  assert.equal(hostOwner.deleteChannels, true, "external channels off: the host's owner sees Disconnect");
  const peerMember = await capabilities(app.baseUrl, f.token.peerMember, f.peerServer.id, f.peerProjection.id);
  assert.equal(peerMember.deleteChannels, false, "a member doesn't");

  const refused = await fetch(`${app.baseUrl}/api/channels/${f.peerProjection.id}/disconnect`, {
    method: "POST", headers: headers(f.token.peerMember, f.peerServer.id),
  });
  assert.equal(refused.status, 403, await refused.text());
  assert.deepEqual(await auditRows("channel.server_disconnected"), [], "a refused disconnect is not audited");
  const disconnected = await fetch(`${app.baseUrl}/api/channels/${f.peerProjection.id}/disconnect`, {
    method: "POST", headers: headers(f.token.peerOwner, f.peerServer.id),
  });
  assert.equal(disconnected.status, 200, await disconnected.text());
  // One event on each of the two servers, each naming its own copy; the actor's role is the partner's, on its row only.
  const audit = await auditRows("channel.server_disconnected");
  assert.deepEqual(audit.map((row) => row.serverId).sort(), [f.hostServer.id, f.peerServer.id].sort(), "one event on each server");
  for (const row of audit) {
    const own = row.serverId === f.peerServer.id;
    assert.deepEqual(
      { actorType: row.actorType, actorId: row.actorId, targetType: row.targetType, targetId: row.targetId, category: row.eventCategory },
      { actorType: "human", actorId: f.peerOwner.id, targetType: "server", targetId: f.peerServer.id, category: "membership" },
    );
    const { operationId, ...metadata } = row.metadata as Record<string, unknown>;
    assert.equal(operationId, audit[0]!.metadata.operationId, "one operation");
    assert.deepEqual(metadata, {
      jointChannelId: f.jointChannelId,
      hostServerId: f.hostServer.id,
      disconnectedServerId: f.peerServer.id,
      channelId: own ? f.peerProjection.id : f.hostProjection.id,
      byHost: false,
      ...(own ? { actorRole: "owner" } : {}),
    });
  }
  const again = await fetch(`${app.baseUrl}/api/channels/${f.peerProjection.id}/disconnect`, {
    method: "POST", headers: headers(f.token.peerOwner, f.peerServer.id),
  });
  assert.ok(again.status >= 400, `already disconnected: ${again.status}`);
  assert.equal((await auditRows("channel.server_disconnected")).length, 2, "a repeated disconnect writes nothing more");
  const [peerSide] = await getDb().select({ status: jointChannelServers.status }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.localChannelId, f.peerProjection.id), eq(jointChannelServers.serverId, f.peerServer.id)));
  assert.notEqual(peerSide?.status, "active", "the partner's side is disconnected");
});

async function projectionState(serverId: string, channelId: string) {
  const db = getDb();
  const [side] = await db.select({ status: jointChannelServers.status, role: jointChannelServers.role }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.localChannelId, channelId), eq(jointChannelServers.serverId, serverId)));
  const [row] = await db.select({ deletedAt: channels.deletedAt }).from(channels).where(eq(channels.id, channelId));
  return { status: side?.status, role: side?.role, deleted: row?.deletedAt !== null };
}

test("external channels on for the host: its owner can't disconnect the host's copy; nothing changes and the partner still can", async ({ app }) => {
  const f = await seedComputedJoint(app.baseUrl);
  await enableExternalChannelsFlag(f.hostServer.id);
  const hostOwner = await capabilities(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  assert.equal(hostOwner.deleteChannels, false, "the host's owner doesn't see Disconnect");
  assert.equal(hostOwner.editChannelMetadata, true, "the host's owner still manages it");

  const refused = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/disconnect`, {
    method: "POST", headers: headers(f.token.hostOwner, f.hostServer.id),
  });
  const body = await refused.text();
  assert.equal(refused.status, 403, body);
  assert.deepEqual(JSON.parse(body), {
    code: "host_cannot_disconnect",
    error: "The host server can't disconnect from its own channel. Archive the channel instead.",
  }, "the host is told what it can do instead");
  assert.deepEqual(await projectionState(f.hostServer.id, f.hostProjection.id), { status: "active", role: "host", deleted: false }, "the host's copy is untouched");
  assert.deepEqual(await projectionState(f.peerServer.id, f.peerProjection.id), { status: "active", role: "participant", deleted: false }, "so is the partner's");

  const disconnected = await fetch(`${app.baseUrl}/api/channels/${f.peerProjection.id}/disconnect`, {
    method: "POST", headers: headers(f.token.peerOwner, f.peerServer.id),
  });
  assert.equal(disconnected.status, 200, await disconnected.text());
  assert.equal((await projectionState(f.peerServer.id, f.peerProjection.id)).status, "disconnected");
  assert.equal((await projectionState(f.hostServer.id, f.hostProjection.id)).status, "active");
});

test("external channels off: the host's owner can still disconnect the host's copy", async ({ app }) => {
  const f = await seedComputedJoint(app.baseUrl);
  const disconnected = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/disconnect`, {
    method: "POST", headers: headers(f.token.hostOwner, f.hostServer.id),
  });
  assert.equal(disconnected.status, 200, await disconnected.text());
  assert.deepEqual(await projectionState(f.hostServer.id, f.hostProjection.id), { status: "disconnected", role: "host", deleted: true });
  assert.deepEqual(await auditRows("channel.server_disconnected"), [], "the host leaving its own channel is not a participant's disconnect: no event");
});
