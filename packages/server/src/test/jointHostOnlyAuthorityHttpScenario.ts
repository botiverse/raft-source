import assert from "node:assert/strict";
import type { openTestApp } from "./integration/app";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { getDb } from "../db";
import { createSeed } from "./integration/seed";
import { createHttpClient } from "./integration/http";
import {
  servers,
  channelAgents,
  channelHumans,
  userChannelReadCursors,
  serverAgentMembers,
} from "../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { installFakeIo } from "../routes/channels.api.fixtures";
import {
  createJointChannel,
  acceptJointChannelInvite,
  acceptJointChannelInvites,
  addHuman,
  addAgent,
  isChannelAgent,
  changeChannelMembershipRole,
  canUserAccessChannel,
} from "../services/channelService";
import { createAgent } from "../services/agentService";
import { addMember, removeMember } from "../services/serverService";
import { asServerId } from "@botiverse/raft-shared";

type MemberRoster = {
  agents: Array<{ id: string; canRemoveFromChannel: boolean }>;
  humans: Array<{
    id: string;
    canRemoveFromChannel: boolean;
    isManager: boolean;
    servers: Array<{ id: string }>;
  }>;
};

export async function jointHostOnlyAuthorityHttpScenario(
  app: Pick<Awaited<ReturnType<typeof openTestApp>>, "baseUrl" | "app">,
) {
  const events = installFakeIo(app.app);
  const db = getDb(),
    seed = createSeed(db),
    http = createHttpClient(app.baseUrl);
  const owner = await seed.human(),
    peerAdmin = await seed.human(),
    manager = await seed.human(),
    candidate = await seed.human(),
    victim = await seed.human();
  const h = await seed.server({
    owner,
    members: [peerAdmin, manager, candidate],
  });
  const b = await seed.server({
    owner: peerAdmin,
    members: [candidate, victim],
  });
  const made = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: owner.id,
    name: "host-only-http",
    targetServerSlug: b.slug,
    invitedPeople: [`@${peerAdmin.name}`],
    userIds: [manager.id],
  });
  const entry = await acceptJointChannelInvite({
    inviteId: made.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: peerAdmin.id,
  });
  await addHuman(entry.id, candidate.id);
  await addHuman(entry.id, victim.id);
  await changeChannelMembershipRole({
    serverId: h.id,
    channelId: made.channel.id,
    requesterUserId: owner.id,
    targetType: "user",
    targetId: manager.id,
    nextRole: "admin",
  });
  const ha = await createAgent(h.id, "HostAgent", {
    runtime: "claude",
    model: "sonnet",
  });
  const ba = await createAgent(b.id, "PeerAgent", {
    runtime: "claude",
    model: "sonnet",
  });
  await addAgent(made.channel.id, ha.id);
  await addAgent(entry.id, ba.id);
  const other = await seed.channel({
    server: b,
    members: [peerAdmin],
    name: "unrelated-agent-channel",
  });
  await addAgent(other.id, ba.id);
  const purges: Array<{ agentId: string; channelId: string }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as Pick<
    AgentOrchestrator,
    "purgeAgentInboxForChannelTree"
  >;
  orchestrator.purgeAgentInboxForChannelTree = async (
    agentId: string,
    channelId: string,
  ) => {
    purges.push({ agentId, channelId });
    return { localRemovedCount: 0, machineSent: false };
  };
  const path = (channelId: string, kind: "agent" | "user", id: string) =>
    `/api/channels/${channelId}/members/${kind}/${id}`;
  const request = (
    who: { id: string },
    server: { id: string },
    url: string,
    method = "DELETE",
    body?: object,
  ) =>
    http.as(who, server).request(url, {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
  async function expectStatus<T = object>(
    p: Promise<Response>,
    status: number,
  ) {
    const r = await p;
    const body = (await r.json()) as T;
    assert.equal(r.status, status, JSON.stringify(body));
    return body;
  }
  const rosterH = await expectStatus<MemberRoster>(
    http.as(owner, h).get(`/api/channels/${made.channel.id}/members`),
    200,
  );
  const rosterB = await expectStatus<MemberRoster>(
    http.as(peerAdmin, b).get(`/api/channels/${entry.id}/members`),
    200,
  );
  assert.equal(
    rosterH.agents.find((x) => x.id === ba.id)!.canRemoveFromChannel,
    true,
  );
  assert.equal(
    rosterB.agents.find((x) => x.id === ba.id)!.canRemoveFromChannel,
    true,
  );
  assert.equal(
    rosterB.agents.find((x) => x.id === ha.id)!.canRemoveFromChannel,
    false,
  );
  assert.equal(
    rosterB.humans.find((x) => x.id === victim.id)!.canRemoveFromChannel,
    false,
  );
  assert.equal(
    rosterH.humans.find((x) => x.id === victim.id)!.canRemoveFromChannel,
    true,
  );
  // Source labels are entry-scoped, never all identity memberships. Candidate
  // was introduced by B only, despite already belonging to both H and B.
  assert.deepEqual(
    rosterH.humans.find((x) => x.id === candidate.id)!.servers.map((x) => x.id),
    [b.id],
  );
  assert.deepEqual(
    rosterB.humans.find((x) => x.id === candidate.id)!.servers,
    [],
  );
  await expectStatus(
    request(peerAdmin, b, path(entry.id, "user", victim.id)),
    403,
  );
  assert.equal(
    await canUserAccessChannel(entry.id, victim.id, asServerId(b.id)),
    true,
  );
  await expectStatus(
    request(peerAdmin, b, path(entry.id, "agent", ha.id)),
    403,
  );
  assert.equal(await isChannelAgent(made.channel.id, ha.id), true);
  await expectStatus(
    request(peerAdmin, b, path(entry.id, "agent", ba.id)),
    200,
  );
  assert.equal(await isChannelAgent(entry.id, ba.id), false);
  await addAgent(entry.id, ba.id);
  // Host manager removes a foreign agent's real membership, preserving its
  // unrelated membership, and purges the peer entry rather than the host face.
  await expectStatus(
    request(manager, h, path(made.channel.id, "agent", ba.id)),
    200,
  );
  assert.equal(await isChannelAgent(entry.id, ba.id), false);
  assert.equal(await isChannelAgent(other.id, ba.id), true);
  assert.ok(
    events.some(
      (event) =>
        event.room === `channel:${entry.id}` &&
        event.event === "channel:members-updated",
    ),
    "human removal refreshes the peer entry",
  );
  assert.ok(
    purges.some((x) => x.agentId === ba.id && x.channelId === entry.id),
  );
  assert.ok(purges.every((x) => x.channelId !== made.channel.id));
  // Exercise the credentialed agent HTTP route as well as the human route.
  await db
    .update(channelAgents)
    .set({ role: "admin" })
    .where(
      and(
        eq(channelAgents.channelId, made.channel.id),
        eq(channelAgents.agentId, ha.id),
      ),
    );
  const peerOperator = await createAgent(b.id, "PeerOperator", {
    runtime: "codex",
  });
  await db
    .update(serverAgentMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(serverAgentMembers.serverId, b.id),
        eq(serverAgentMembers.agentId, peerOperator.id),
      ),
    );
  await addAgent(entry.id, peerOperator.id);
  const hostCredential = await mintAgentCredential({
    agentId: ha.id,
    scopes: ["channels"],
    name: "host-removal",
    issuedVia: "computer",
    createdByUserId: null,
  });
  const peerCredential = await mintAgentCredential({
    agentId: peerOperator.id,
    scopes: ["channels"],
    name: "peer-removal",
    issuedVia: "computer",
    createdByUserId: null,
  });
  const agentRemove = (apiKey: string, channelId: string, body: object) =>
    fetch(`${app.baseUrl}/internal/agent-api/channels/${channelId}/members`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  await addAgent(entry.id, ba.id);
  await expectStatus(
    agentRemove(peerCredential.apiKey, entry.id, { agentId: ba.id }),
    200,
  );
  assert.equal(
    await isChannelAgent(entry.id, ba.id),
    false,
    "peer admin agent can remove its own server agent",
  );
  await expectStatus(
    agentRemove(peerCredential.apiKey, entry.id, { agentId: ha.id }),
    403,
  );
  assert.equal(await isChannelAgent(made.channel.id, ha.id), true);
  await expectStatus(
    agentRemove(peerCredential.apiKey, entry.id, { userId: victim.id }),
    403,
  );
  for (const target of [{ agentId: ba.id }, { agent: ba.name }]) {
    await addAgent(entry.id, ba.id);
    events.length = 0;
    await expectStatus(
      agentRemove(hostCredential.apiKey, made.channel.id, target),
      200,
    );
    assert.equal(
      await isChannelAgent(entry.id, ba.id),
      false,
      "host agent manager removes peer agent by ID or handle",
    );
    assert.equal(await isChannelAgent(other.id, ba.id), true);
    assert.ok(
      events.some(
        (event) =>
          event.room === `channel:${entry.id}` &&
          event.event === "channel:members-updated",
      ),
      "agent removal refreshes the peer entry",
    );
  }
  const outsideAgent = await createAgent(b.id, "OutsideJoint", {
    runtime: "codex",
  });
  await addAgent(other.id, outsideAgent.id);
  await expectStatus(
    agentRemove(hostCredential.apiKey, made.channel.id, {
      agentId: outsideAgent.id,
    }),
    400,
  );
  assert.equal(
    await isChannelAgent(other.id, outsideAgent.id),
    true,
    "host resolution is limited to this J roster",
  );
  await expectStatus(
    agentRemove(hostCredential.apiKey, made.channel.id, { userId: victim.id }),
    200,
  );
  assert.equal(
    await canUserAccessChannel(entry.id, victim.id, asServerId(b.id)),
    false,
  );
  await addHuman(entry.id, victim.id);
  await expectStatus(
    request(victim, b, `/api/channels/${entry.id}/leave`, "POST", {}),
    200,
  );
  assert.equal(
    await canUserAccessChannel(entry.id, victim.id, asServerId(b.id)),
    false,
    "self leave remains possible on a non-host entry",
  );
  await addHuman(entry.id, victim.id);
  // The actual role endpoint rechecks authority. Appointed managers cannot
  // promote or demote; the host owner can promote a B-introduced H member.
  // An existing J member can be appointed without a host projection or cursor.
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, made.channel.id), eq(channelHumans.userId, candidate.id)));
  await db.delete(userChannelReadCursors).where(and(eq(userChannelReadCursors.channelId, made.channel.id), eq(userChannelReadCursors.userId, candidate.id)));
  const readMarker = await createMessage(made.jointChannel.canonicalChannelId, "user", candidate.id, "read before host appointment");
  await db.insert(userChannelReadCursors).values({
    userId: candidate.id, channelId: entry.id, lastReadSeq: readMarker.seq,
    lastReadSeq8: BigInt(readMarker.seq), readStateVersion: 3,
  }).onConflictDoUpdate({ target: [userChannelReadCursors.userId, userChannelReadCursors.channelId],
    set: { lastReadSeq: readMarker.seq, lastReadSeq8: BigInt(readMarker.seq), readStateVersion: 3 } });
  const candidateReadPositions = () => db.select().from(userChannelReadCursors)
    .where(eq(userChannelReadCursors.userId, candidate.id)).orderBy(asc(userChannelReadCursors.channelId));
  const positionsBeforeAppointment = await candidateReadPositions();
  assert.ok(positionsBeforeAppointment.length > 0, "retain the member's other entry read position");
  const rolePath = `/api/channels/${made.channel.id}/members/user/${candidate.id}/role`;
  await expectStatus(
    request(manager, h, rolePath, "PATCH", { role: "admin" }),
    403,
  );
  await expectStatus(
    request(owner, h, rolePath, "PATCH", { role: "admin" }),
    200,
  );
  assert.deepEqual(await candidateReadPositions(), positionsBeforeAppointment,
    "materializing an existing member's host role must not create or reset read positions");
  await expectStatus(
    request(manager, h, rolePath, "PATCH", { role: "member" }),
    403,
  );
  await removeMember(h.id, candidate.id);
  await addMember(h.id, candidate.id);
  const returned = await expectStatus<MemberRoster>(
    http.as(owner, h).get(`/api/channels/${made.channel.id}/members`),
    200,
  );
  assert.equal(
    returned.humans.find((x) => x.id === candidate.id)!.isManager,
    false,
    "returning H identity does not restore appointment",
  );
  await expectStatus(
    request(owner, h, rolePath, "PATCH", { role: "admin" }),
    200,
  );
  await removeMember(b.id, candidate.id);
  await addMember(b.id, candidate.id);
  const ended = await expectStatus<MemberRoster>(
    http.as(owner, h).get(`/api/channels/${made.channel.id}/members`),
    200,
  );
  assert.deepEqual(
    ended.humans.find((x) => x.id === candidate.id)!.servers,
    [],
  );
  assert.equal(
    ended.humans.find((x) => x.id === candidate.id)!.isManager,
    true,
    "ended display source cannot revoke host appointment",
  );
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, h.id));
  const mei = await seed.human();
  const northwind = await seed.server({ owner: mei, name: "Northwind" });
  const contoso = await seed.server({ owner: mei, name: "Contoso" });
  const dual = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: owner.id,
    name: "dual-source-label-http",
    jointInvites: [
      { targetServerSlug: northwind.slug, invitedPeople: [`@${mei.name}`] },
      { targetServerSlug: contoso.slug, invitedPeople: [`@${mei.name}`] },
    ],
  });
  const dualEntries = await acceptJointChannelInvites({
    inviteIds: dual.invites.map((x) => x.id),
    acceptedByUserId: mei.id,
  });
  for (const entry of dualEntries) {
    const viewerServer = entry.serverId === northwind.id ? northwind : contoso;
    const peer = entry.serverId === northwind.id ? contoso : northwind;
    const result = await expectStatus<MemberRoster>(
      http.as(mei, viewerServer).get(`/api/channels/${entry.id}/members`),
      200,
    );
    assert.deepEqual(
      result.humans.find((x) => x.id === mei.id)!.servers.map((x) => x.id),
      [peer.id],
      "two-source HTTP roster omits exactly the current entry",
    );
  }
  await expectStatus(
    request(manager, h, path(made.channel.id, "user", victim.id)),
    200,
  );
  assert.equal(
    await canUserAccessChannel(entry.id, victim.id, asServerId(b.id)),
    false,
  );
}
