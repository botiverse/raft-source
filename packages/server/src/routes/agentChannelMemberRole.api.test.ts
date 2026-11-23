import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channelAgents, channelHumans, channelMembershipRoleEvents, serverAgentMembers, servers } from "../db/schema";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { updateAgentScopes } from "../services/agentScopesService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createServer, headers, installFakeIo, seedUser } from "./channels.api.fixtures";

// An agent changes a channel member's channel role on its own authority
// (POST /internal/agent-api/channels/member-role, `raft channel set-role`;
// product decision 2026-11-17), under the web route's rule: a channel admin
// there, or a server owner/admin with access; never its own role, never a
// server owner's or admin's; on a joint channel only the host's owners/admins.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Refusal = { error?: string; code?: string; suggestedNextAction?: string };

async function agentKey(agentId: string): Promise<string> {
  const credential = await mintAgentCredential({
    agentId,
    scopes: ["channels"],
    name: "channel-member-role-test",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return credential.apiKey;
}

async function setRole(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/channels/member-role`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> & Refusal };
}

async function setAgentServerRole(serverId: string, agentId: string, role: "admin" | "member") {
  await getDb().update(serverAgentMembers).set({ role }).where(and(
    eq(serverAgentMembers.serverId, serverId),
    eq(serverAgentMembers.agentId, agentId),
  ));
}

async function humanRole(channelId: string, userId: string) {
  const [row] = await getDb().select({ role: channelHumans.role }).from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return row?.role;
}

async function agentRole(channelId: string, agentId: string) {
  const [row] = await getDb().select({ role: channelAgents.role }).from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)));
  return row?.role;
}

async function seedPrivateChannel(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`${label}-owner-${suffix}@slock.test`, `${label}-owner-${suffix}`);
  const peer = await seedUser(`${label}-peer-${suffix}@slock.test`, `${label}-peer-${suffix}`);
  const serverAdmin = await seedUser(`${label}-sadmin-${suffix}@slock.test`, `${label}-sadmin-${suffix}`);
  const outsider = await seedUser(`${label}-outsider-${suffix}@slock.test`, `${label}-outsider-${suffix}`);
  const server = await createServer(`${label}`, `${label}-${suffix}`, owner.id);
  await addMember(server.id, peer.id, "member");
  await addMember(server.id, serverAdmin.id, "admin");
  await addMember(server.id, outsider.id, "member");
  const channelName = `${label}-room-${suffix}`;
  const channel = await createChannel(server.id, channelName, undefined, "private", { type: "user", id: owner.id });
  await addHuman(channel.id, peer.id);
  await addHuman(channel.id, serverAdmin.id);

  const adminAgent = await createAgent(server.id, `adm-${suffix}`, { runtime: "codex" });
  await addAgent(channel.id, adminAgent.id, { role: "admin" });
  const memberAgent = await createAgent(server.id, `mem-${suffix}`, { runtime: "codex" });
  await addAgent(channel.id, memberAgent.id);
  return { server, owner, peer, serverAdmin, outsider, channel, target: `#${channelName}`, adminAgent, memberAgent };
}

test("a channel-admin agent appoints and revokes a channel admin, recorded as its own act and delivered like the web route's", async ({ app }) => {
  const events = installFakeIo(app.app);
  const f = await seedPrivateChannel("agent-role-appoint");
  const key = await agentKey(f.adminAgent.id);

  const promote = await setRole(app.baseUrl, key, { target: f.target, user: `@${f.peer.name}`, role: "admin" });
  assert.equal(promote.status, 200, JSON.stringify(promote.body));
  assert.deepEqual(promote.body, {
    ok: true,
    changed: true,
    channelId: f.channel.id,
    member: { type: "human", id: f.peer.id, name: f.peer.name },
    channelRole: "admin",
  });
  assert.equal(await humanRole(f.channel.id, f.peer.id), "admin");
  const [event] = await getDb().select().from(channelMembershipRoleEvents).where(and(
    eq(channelMembershipRoleEvents.channelId, f.channel.id),
    eq(channelMembershipRoleEvents.targetId, f.peer.id),
  ));
  assert.equal(event?.requesterAgentId, f.adminAgent.id);
  assert.equal(event?.requesterUserId, null);
  assert.equal(event?.previousRole, "member");
  assert.equal(event?.nextRole, "admin");
  assert.equal(event?.deliveryStatus, "sent");
  assert.ok(events.some((e) => e.room === `channel:${f.channel.id}` && e.event === "channel:members-updated"));
  assert.ok(events.some((e) => e.room === `user:${f.peer.id}` && e.event === "channel:authority-updated"
    && (e.payload as { channelRole?: string }).channelRole === "admin"));

  const again = await setRole(app.baseUrl, key, { target: f.target, user: f.peer.name, role: "admin" });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);

  const revoke = await setRole(app.baseUrl, key, { target: f.target, user: `@${f.peer.name}`, role: "member" });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
  assert.equal(revoke.body.channelRole, "member");
  assert.equal(await humanRole(f.channel.id, f.peer.id), "member");

  // An agent member too.
  const promoteAgent = await setRole(app.baseUrl, key, { target: f.target, agent: `@${f.memberAgent.name}`, role: "admin" });
  assert.equal(promoteAgent.status, 200, JSON.stringify(promoteAgent.body));
  assert.equal(await agentRole(f.channel.id, f.memberAgent.id), "admin");
  assert.ok(events.some((e) => e.room === `agent:${f.memberAgent.id}` && e.event === "channel:authority-updated"));
});

test("an agent's role change is refused with the web route's codes and sentences", async ({ app }) => {
  const f = await seedPrivateChannel("agent-role-refuse");
  const adminKey = await agentKey(f.adminAgent.id);
  const memberKey = await agentKey(f.memberAgent.id);

  // A plain member agent: no changeChannelMemberRoles.
  const plain = await setRole(app.baseUrl, memberKey, { target: f.target, user: f.peer.name, role: "admin" });
  assert.equal(plain.status, 403);
  assert.equal(plain.body.code, "channel_capability_required");
  assert.equal(plain.body.error, "You do not have permission to change channel member roles");
  assert.ok(plain.body.suggestedNextAction);
  assert.equal(await humanRole(f.channel.id, f.peer.id), "member");

  // Its own role.
  const self = await setRole(app.baseUrl, adminKey, { target: f.target, agent: f.adminAgent.name, role: "member" });
  assert.equal(self.status, 409);
  assert.equal(self.body.code, "channel_admin_self_demote_forbidden");
  assert.equal(self.body.error, "A channel admin cannot change their own channel role");
  assert.equal(await agentRole(f.channel.id, f.adminAgent.id), "admin");

  // A server owner or admin (person or agent).
  for (const body of [{ user: f.owner.name }, { user: f.serverAdmin.name }]) {
    const res = await setRole(app.baseUrl, adminKey, { target: f.target, ...body, role: "member" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, "protected_server_role");
    assert.equal(res.body.error, "Server owners and admins cannot be changed from channel role management");
  }
  await setAgentServerRole(f.server.id, f.memberAgent.id, "admin");
  const adminAgentTarget = await setRole(app.baseUrl, adminKey, { target: f.target, agent: f.memberAgent.name, role: "admin" });
  assert.equal(adminAgentTarget.status, 403);
  assert.equal(adminAgentTarget.body.code, "protected_server_role");
  await setAgentServerRole(f.server.id, f.memberAgent.id, "member");

  // Not a member of the channel; a handle nobody has reads the same.
  for (const body of [{ user: f.outsider.name }, { user: `nobody-${randomUUID().slice(0, 8)}` }]) {
    const res = await setRole(app.baseUrl, adminKey, { target: f.target, ...body, role: "admin" });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "channel_member_required");
    assert.equal(res.body.error, "Target must already be a channel member");
  }

  // A private channel the agent is not in reads as not found.
  const stranger = await createAgent(f.server.id, `str-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await setAgentServerRole(f.server.id, stranger.id, "admin");
  const hidden = await setRole(app.baseUrl, await agentKey(stranger.id), { target: f.target, user: f.peer.name, role: "admin" });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, "channel_not_found");

  // Exactly one member.
  const both = await setRole(app.baseUrl, adminKey, { target: f.target, user: f.peer.name, agent: f.memberAgent.name, role: "admin" });
  assert.equal(both.status, 400);
  assert.equal(both.body.code, "invalid_member_target");

  // A narrowed scope set without channel:update.
  await updateAgentScopes({ agentId: f.adminAgent.id, scopes: ["channel:read", "message:read"], updatedByUserId: f.owner.id });
  const noScope = await setRole(app.baseUrl, adminKey, { target: f.target, user: f.peer.name, role: "admin" });
  assert.equal(noScope.status, 403);
  assert.equal(await humanRole(f.channel.id, f.peer.id), "member");
});

test("a server-admin agent changes roles in a public channel it is not in", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`agent-role-public-owner-${suffix}@slock.test`, `agent-role-public-owner-${suffix}`);
  const peer = await seedUser(`agent-role-public-peer-${suffix}@slock.test`, `agent-role-public-peer-${suffix}`);
  const server = await createServer("agent-role-public", `agent-role-public-${suffix}`, owner.id);
  await addMember(server.id, peer.id, "member");
  const channel = await createChannel(server.id, `agent-role-public-${suffix}`, undefined, "channel", { type: "user", id: owner.id });
  await addHuman(channel.id, peer.id);
  const adminAgent = await createAgent(server.id, `padm-${suffix}`, { runtime: "codex" });
  await setAgentServerRole(server.id, adminAgent.id, "admin");
  const memberAgent = await createAgent(server.id, `pmem-${suffix}`, { runtime: "codex" });

  const refused = await setRole(app.baseUrl, await agentKey(memberAgent.id), { target: `#${channel.name}`, user: peer.name, role: "admin" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "channel_capability_required");

  const promoted = await setRole(app.baseUrl, await agentKey(adminAgent.id), { target: `#${channel.name}`, user: peer.name, role: "admin" });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(await humanRole(channel.id, peer.id), "admin");
});

test("on a joint channel only the host's admin agent changes roles; another server's admin agent is refused", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`agent-role-joint-host-${suffix}@slock.test`, `agent-role-joint-host-${suffix}`);
  const targetOwner = await seedUser(`agent-role-joint-target-${suffix}@slock.test`, `agent-role-joint-target-${suffix}`);
  const hostServer = await createServer("agent-role-joint host", `agent-role-joint-host-${suffix}`, hostOwner.id);
  const targetServer = await createServer("agent-role-joint target", `agent-role-joint-target-${suffix}`, targetOwner.id);
  const channelName = `agent-role-joint-${suffix}`;
  const createRes = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(await tokenForHuman(hostOwner.email), hostServer.id),
    body: JSON.stringify({ name: channelName, visibility: "joint", targetServerSlug: targetServer.slug, invitedPeople: [`@${targetOwner.name}`] }),
  });
  assert.equal(createRes.status, 200);
  const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };
  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(await tokenForHuman(targetOwner.email), targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string };

  // Each side: a server-admin agent and a plain agent, both in the channel.
  const seedSide = async (serverId: string, projectionId: string, side: string) => {
    const admin = await createAgent(serverId, `${side}-adm-${suffix}`, { runtime: "codex" });
    await setAgentServerRole(serverId, admin.id, "admin");
    await addAgent(projectionId, admin.id);
    const plain = await createAgent(serverId, `${side}-mem-${suffix}`, { runtime: "codex" });
    await addAgent(projectionId, plain.id);
    return { admin, plain };
  };
  const host = await seedSide(hostServer.id, hostProjection.id, "host");
  const other = await seedSide(targetServer.id, targetProjection.id, "other");

  const nonHost = await setRole(app.baseUrl, await agentKey(other.admin.id), { target: `#${channelName}`, agent: other.plain.name, role: "admin" });
  assert.equal(nonHost.status, 403, JSON.stringify(nonHost.body));
  assert.equal(nonHost.body.code, "channel_capability_required");
  // No role on this server can do it, so the next step names the host's owners and admins.
  assert.equal(nonHost.body.suggestedNextAction, `Ask an owner or admin of the host server of #${channelName} to change it.`);
  assert.equal(await agentRole(targetProjection.id, other.plain.id), "member");

  const hostAllowed = await setRole(app.baseUrl, await agentKey(host.admin.id), { target: `#${channelName}`, agent: host.plain.name, role: "admin" });
  assert.equal(hostAllowed.status, 200, JSON.stringify(hostAllowed.body));
  assert.equal(await agentRole(hostProjection.id, host.plain.id), "admin");
});

type RosterRow = { name: string; role?: string | null; channelRole?: string };
async function agentRoster(baseUrl: string, apiKey: string, target: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/channel-members?channel=${encodeURIComponent(target)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as { agents: RosterRow[]; humans: RosterRow[] };
}
const rolesByName = (rows: RosterRow[]) => Object.fromEntries(rows.map((row) => [row.name, row.channelRole ?? null]));

test("`raft channel members` shows every member's channel role, as the web member list does to a member; none where a channel has no roles", async ({ app }) => {
  const f = await seedPrivateChannel("agent-role-roster");
  await getDb().update(channelHumans).set({ role: "admin" })
    .where(and(eq(channelHumans.channelId, f.channel.id), eq(channelHumans.userId, f.peer.id)));
  // A plain member agent lists them: no authority is needed to see who the channel admins are.
  const key = await agentKey(f.memberAgent.id);

  const roster = await agentRoster(app.baseUrl, key, f.target);
  assert.deepEqual(rolesByName(roster.humans), {
    [f.owner.name]: "admin", // the channel's creator
    [f.peer.name]: "admin",
    [f.serverAdmin.name]: "member", // a server admin: their authority is their server role, shown as `role`
  });
  assert.equal(roster.humans.find((row) => row.name === f.serverAdmin.name)?.role, "admin");
  assert.deepEqual(rolesByName(roster.agents), { [f.adminAgent.name]: "admin", [f.memberAgent.name]: "member" });

  // The web member list, read by a member of the channel, stores the same roles.
  const web = await fetch(`${app.baseUrl}/api/channels/${f.channel.id}/members`, {
    headers: headers(await tokenForHuman(f.peer.email), f.server.id),
  });
  assert.equal(web.status, 200);
  const webBody = await web.json() as { agents: Array<{ name: string; channelRole?: string | null }>; humans: Array<{ name: string; channelRole?: string | null }> };
  assert.deepEqual(rolesByName(roster.humans), Object.fromEntries(webBody.humans.map((row) => [row.name, row.channelRole ?? null])));
  assert.deepEqual(rolesByName(roster.agents), Object.fromEntries(webBody.agents.map((row) => [row.name, row.channelRole ?? null])));

  // #all has no channel roles: nothing extra on any row.
  const all = await agentRoster(app.baseUrl, key, "#all");
  assert.ok(all.humans.length > 0 && all.agents.length > 0, JSON.stringify(all));
  for (const row of [...all.humans, ...all.agents]) assert.equal("channelRole" in row, false, JSON.stringify(row));
});

// An unauthorized role mutation must not become a hidden human-directory lookup.
test("a member agent cannot distinguish a hidden server member from a missing handle through role refusals", async ({ app }) => {
  const f = await seedPrivateChannel("agent-role-hidden-directory");
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, f.server.id));
  const credential = await mintAgentCredential({ agentId: f.memberAgent.id, scopes: ["read", "channels"], name: "hidden-directory-role-test", issuedVia: "computer", createdByUserId: null });
  const info = await fetch(`${app.baseUrl}/internal/agent-api/server`, { headers: { Authorization: `Bearer ${credential.apiKey}` } });
  assert.equal(info.status, 200);
  assert.deepEqual((await info.json() as { humans: unknown[] }).humans, [], "the directory actually hides people from this caller");
  assert.equal(await humanRole(f.channel.id, f.outsider.id), undefined, "the target shares no visible channel membership with the caller here");

  const hidden = await setRole(app.baseUrl, credential.apiKey, { target: f.target, user: f.outsider.name, role: "admin" });
  const missing = await setRole(app.baseUrl, credential.apiKey, { target: f.target, user: `nobody-${randomUUID().slice(0, 8)}`, role: "admin" });
  assert.deepEqual(hidden, missing, "an unauthorized caller must not learn whether the hidden person exists");
  assert.equal(hidden.status, 403, "lack of role-changing authority is checked before resolving either person");
  assert.equal(await humanRole(f.channel.id, f.outsider.id), undefined);
  assert.deepEqual(await getDb().select().from(channelMembershipRoleEvents).where(eq(channelMembershipRoleEvents.channelId, f.channel.id)), []);
});
