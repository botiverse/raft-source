import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { serverAgentMembers, serverMembers } from "../db/schema";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, getChannel, isChannelAgent, isChannelHuman } from "../services/channelService";
import { createServer, headers, installFakeIo, seedUser } from "./channels.api.fixtures";
import { setChannelArchivedForAgent } from "./agentChannelLifecycle";
import { addChannelMemberForAgent, removeChannelMemberForAgent } from "./agentChannelMembers";
import { updateChannelForAgent } from "./agentChannelUpdate";

// Joint channel parity, agent side (#proj-joint-channel:6a2a81a9, t1–t4): an
// agent can leave, manage members of, edit, and archive a joint channel the
// same way a human admin can. Each case also pins that the other server's
// projection and members are untouched, or updated together where the state
// is shared (name, archive).

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function setupJoint(app: { baseUrl: string }, label: string) {
  const suffix = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`${label}-host-${suffix}@slock.test`, `${label}-host-${suffix}`);
  const targetOwner = await seedUser(`${label}-target-${suffix}@slock.test`, `${label}-target-${suffix}`);
  const hostServer = await createServer(`${label} host`, `${label}-host-${suffix}`, hostOwner.id);
  const targetServer = await createServer(`${label} target`, `${label}-target-${suffix}`, targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(hostToken, hostServer.id),
    body: JSON.stringify({
      name: `${label}-room-${suffix}`,
      visibility: "joint",
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };
  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  const agent = await createAgent(hostServer.id, `${label}-agent-${suffix}`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(
    eq(serverAgentMembers.serverId, hostServer.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));
  await addAgent(hostProjection.id, agent.id);

  return {
    hostServer,
    targetServer,
    hostOwner,
    targetOwner,
    channelName: `${label}-room-${suffix}`,
    hostProjectionId: hostProjection.id,
    targetProjectionId: targetProjection.id,
    agent,
    actor: { id: agent.id, name: agent.name, serverId: hostServer.id },
  };
}

test("an agent can leave a joint channel without touching the other server's members", async ({ app }) => {
  const f = await setupJoint(app, "joint-leave");
  const credential = await mintAgentCredential({
    agentId: f.agent.id,
    scopes: ["channels"],
    name: "joint-leave-test",
    issuedVia: "computer",
    createdByUserId: null,
  });
  // The test orchestrator has no inbox; record the purge the route requests.
  const purges: Array<{ agentId: string; channelId: string; reason?: string }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as {
    purgeAgentInboxForChannelTree: (agentId: string, channelId: string, reason?: string) => Promise<unknown>;
  };
  orchestrator.purgeAgentInboxForChannelTree = async (agentId, channelId, reason) => {
    purges.push({ agentId, channelId, reason });
  };

  const res = await fetch(`${app.baseUrl}/internal/agent-api/channels/${f.hostProjectionId}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.equal(await isChannelAgent(f.hostProjectionId, f.agent.id), false);
  assert.deepEqual(purges, [{ agentId: f.agent.id, channelId: f.hostProjectionId, reason: "channel_membership_removed" }]);
  assert.equal(await isChannelHuman(f.targetProjectionId, f.targetOwner.id), true);
});

test("an admin agent of the host adds its own server's members to a joint channel, never the other server's, and removes members", async ({ app }) => {
  const f = await setupJoint(app, "joint-members");
  const suffix = randomUUID().slice(0, 8);
  const hostMember = await seedUser(`joint-members-local-${suffix}@slock.test`, `joint-members-local-${suffix}`);
  await addMember(f.hostServer.id, hostMember.id, "member");

  const added = await addChannelMemberForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: hostMember.id },
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(await isChannelHuman(f.hostProjectionId, hostMember.id), true);

  // Candidates resolve from the acting server only: the other server's owner
  // is not addressable through this server's projection.
  const crossServer = await addChannelMemberForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: f.targetOwner.id },
  });
  assert.notEqual(crossServer.status, 200);
  assert.equal(await isChannelHuman(f.hostProjectionId, f.targetOwner.id), false);


  const removed = await removeChannelMemberForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: hostMember.id },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await isChannelHuman(f.hostProjectionId, hostMember.id), false);
  assert.equal(await isChannelHuman(f.targetProjectionId, f.targetOwner.id), true);
});

test("an admin agent renames a joint channel for every server and cannot change its visibility", async ({ app }) => {
  const f = await setupJoint(app, "joint-edit");
  const events = installFakeIo(app.app);
  const newName = `joint-renamed-${randomUUID().slice(0, 8)}`;

  const updated = await updateChannelForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { name: newName, description: "shared description" },
    io: app.app.get("io"),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal((await getChannel(f.hostProjectionId))?.name, newName);
  assert.equal((await getChannel(f.targetProjectionId))?.name, newName);
  // The other server's open clients get the new metadata without a reload.
  assert.ok(
    events.some((event) => event.room === `channel:${f.targetProjectionId}` && event.event === "channel:updated"),
    "the other server's projection must receive channel:updated",
  );

  const visibility = await updateChannelForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { visibility: "public" },
  });
  assert.notEqual(visibility.status, 200);
  assert.equal((await getChannel(f.hostProjectionId))?.type, "joint");
});

test("an admin agent archives and unarchives a joint channel for every server; an ordinary agent cannot", async ({ app }) => {
  const f = await setupJoint(app, "joint-archive");

  const ordinary = await createAgent(f.hostServer.id, `joint-archive-member-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await addAgent(f.hostProjectionId, ordinary.id);
  const denied = await setChannelArchivedForAgent({
    actor: { id: ordinary.id, name: ordinary.name, serverId: f.hostServer.id },
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    archived: true,
  });
  assert.equal(denied.status, 403);
  assert.equal((await getChannel(f.targetProjectionId))?.archivedAt, null);

  const events = installFakeIo(app.app);
  const archived = await setChannelArchivedForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    archived: true,
    io: app.app.get("io"),
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.ok((await getChannel(f.hostProjectionId))?.archivedAt);
  assert.ok((await getChannel(f.targetProjectionId))?.archivedAt);
  assert.ok(
    events.some((event) => event.room === `channel:${f.targetProjectionId}` && event.event === "channel:updated"),
    "the other server's projection must receive channel:updated",
  );

  const unarchived = await setChannelArchivedForAgent({
    actor: f.actor,
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    archived: false,
  });
  assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body));
  assert.equal((await getChannel(f.hostProjectionId))?.archivedAt, null);
  assert.equal((await getChannel(f.targetProjectionId))?.archivedAt, null);
});

test("an agent's joint member listing names every server a person takes part through (RFC 075 phase 1)", async ({ app }) => {
  const f = await setupJoint(app, "joint-badges");
  const dualName = `joint-badges-dual-${randomUUID().slice(0, 8)}`;
  const dual = await seedUser(`${dualName}@slock.test`, dualName);
  await getDb().insert(serverMembers).values([
    { serverId: f.hostServer.id, userId: dual.id, role: "member" },
    { serverId: f.targetServer.id, userId: dual.id, role: "member" },
  ]);
  await addHuman(f.hostProjectionId, dual.id);
  await addHuman(f.targetProjectionId, dual.id);
  const credential = await mintAgentCredential({
    agentId: f.agent.id,
    scopes: ["channels"],
    name: "joint-badges-test",
    issuedVia: "computer",
    createdByUserId: null,
  });

  const res = await fetch(`${app.baseUrl}/internal/agent-api/channel-members?channel=${encodeURIComponent(`#${f.channelName}`)}`, {
    headers: { Authorization: `Bearer ${credential.apiKey}` },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { humans: Array<{ name: string; role?: string; servers?: Array<{ name: string; slug: string; yours?: true }> }> };
  const byName = new Map(body.humans.map((human) => [human.name, human]));
  const target = { name: f.targetServer.name, slug: f.targetServer.slug };
  // Already in through the host: adding them through the target records no second source.
  assert.equal(byName.get(dual.name)?.servers, undefined, "the current entry is omitted; no other source");
  assert.deepEqual(byName.get(f.targetOwner.name)?.servers, [target], "a peer-only person names the peer server");
  assert.equal(byName.get(f.hostOwner.name)?.servers, undefined, "a person only on the agent's server is listed as before");
  // No server role is public in a joint roster (computed membership): not
  // even the agent's own server's owner shows one.
  assert.equal("role" in (byName.get(f.targetOwner.name) ?? {}), false);
});

test("an admin agent that is not in a joint channel cannot add members to it, same as a human admin (#wg-rbac B6)", async ({ app }) => {
  const f = await setupJoint(app, "jua");
  const suffix = randomUUID().slice(0, 8);
  const outsider = await createAgent(f.hostServer.id, `jua-admin-${suffix}`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(
    eq(serverAgentMembers.serverId, f.hostServer.id),
    eq(serverAgentMembers.agentId, outsider.id),
  ));
  const hostMember = await seedUser(`joint-unjoined-local-${suffix}@slock.test`, `joint-unjoined-local-${suffix}`);
  await addMember(f.hostServer.id, hostMember.id, "member");

  const refused = await addChannelMemberForAgent({
    actor: { id: outsider.id, name: outsider.name, serverId: f.hostServer.id },
    serverId: f.hostServer.id,
    channelId: f.hostProjectionId,
    body: { userId: hostMember.id },
  });
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(await isChannelHuman(f.hostProjectionId, hostMember.id), false);
});

test("a joint roster shows another server's people and agents without their roles", async ({ app }) => {
  const f = await setupJoint(app, "joint-roles");
  type RosterRow = { id: string; serverRole?: string | null; channelRole?: string | null; role?: string | null; effectiveChannelRole?: string; channelAdminBasis?: string | null };
  const roster = async (owner: { email: string }, serverId: string, channelId: string) => {
    const res = await fetch(`${app.baseUrl}/api/channels/${channelId}/members`, { headers: headers(await tokenForHuman(owner.email), serverId) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { agents: RosterRow[]; humans: RosterRow[] };
    return { agents: new Map(body.agents.map((row) => [row.id, row])), humans: new Map(body.humans.map((row) => [row.id, row])) };
  };

  // The target server's owner reads: the host's admin agent and owner are
  // another organization's, so they read as plain members.
  const fromTarget = await roster(f.targetOwner, f.targetServer.id, f.targetProjectionId);
  const peerAgent = fromTarget.agents.get(f.agent.id);
  assert.deepEqual(
    [peerAgent?.serverRole, peerAgent?.channelRole, peerAgent?.effectiveChannelRole, peerAgent?.channelAdminBasis],
    [null, null, "member", null],
  );
  const peerOwner = fromTarget.humans.get(f.hostOwner.id);
  // No foreign role; the host's owner manages the channel, which every copy shows.
  assert.deepEqual([peerOwner?.role, peerOwner?.serverRole, peerOwner?.effectiveChannelRole], [null, null, "admin"]);

  // The host reads its own agent and owner with their roles.
  const fromHost = await roster(f.hostOwner, f.hostServer.id, f.hostProjectionId);
  assert.equal(fromHost.agents.get(f.agent.id)?.effectiveChannelRole, "admin");
  // The host's owner manages the channel: shown as its admin.
  assert.equal(fromHost.humans.get(f.hostOwner.id)?.effectiveChannelRole, "admin");
});
