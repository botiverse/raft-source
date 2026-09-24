import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  channelAgents,
  channelHumans,
  channelMembershipRoleEvents,
  channels,
  serverAgentMembers,
  serverMembers,
  users,
} from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import { createAgent } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import {
  addAgent,
  addHuman,
  createChannel,
  isChannelHuman,
  listChannelsForAgent,
} from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import { drainChannelMembershipRoleOutbox } from "../services/channelMembershipRoleOutbox.js";
import { setChannelArchivedForAgent } from "./agentChannelLifecycle.js";
import { addChannelMemberForAgent, removeChannelMemberForAgent } from "./agentChannelMembers.js";
import { updateChannelForAgent } from "./agentChannelUpdate.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@example.com`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    passwordHash: "hash",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

function headers(userId: string, serverId: string) {
  return {
    Authorization: `Bearer ${signAccessToken(userId)}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

test("creator bootstrap and initial members commit atomically with distinct roles", async ({ app }) => {
  const owner = await seedUser("channel-admin-owner");
  const peer = await seedUser("channel-admin-peer");
  const server = await createServer("Channel Admin", `channel-admin-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: peer.id, role: "member" });

  const initialAgent = await createAgent(server.id, `creator-initial-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const channel = await createChannel(server.id, "creator-atomic", undefined, "private", {
    type: "user",
    id: owner.id,
    initialUserIds: [peer.id],
    initialAgentIds: [initialAgent.id],
  });
  const memberships = await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, channel.id));
  assert.equal(memberships.find((row) => row.userId === owner.id)?.role, "admin");
  assert.equal(memberships.find((row) => row.userId === peer.id)?.role, "member");
  assert.equal(memberships.every((row) => row.authorityRevision === 1), true);
  const [agentMembership] = await getDb().select().from(channelAgents).where(and(
    eq(channelAgents.channelId, channel.id),
    eq(channelAgents.agentId, initialAgent.id),
  ));
  assert.equal(agentMembership?.role, "member");
});

test("action-card channel:create uses the atomic human creator-admin bootstrap", () => {
  const source = fs.readFileSync(
    new URL("../services/actionCardsService.ts", import.meta.url),
    "utf8",
  );
  const actionStart = source.indexOf(
    'const channelType = action.visibility === "private" ? "private" : "channel";',
  );
  assert.notEqual(actionStart, -1, "channel:create execution block must exist");
  const actionEnd = source.indexOf('case "agent:create":', actionStart);
  assert.notEqual(actionEnd, -1, "channel:create execution block must be bounded");
  const channelCreateBlock = source.slice(actionStart, actionEnd);

  assert.match(
    channelCreateBlock,
    /createChannel\([\s\S]*?channelType,\s*\{[\s\S]*?type: "user",[\s\S]*?id: userId,[\s\S]*?initialUserIds,[\s\S]*?initialAgentIds,[\s\S]*?\},?\s*\)/,
    "action-card creation must pass the executing human to the atomic creator bootstrap",
  );
  assert.doesNotMatch(
    channelCreateBlock,
    /addHuman\(channel\.id,\s*userId\)/,
    "action-card creation must not add the creator in a second write",
  );
});

test("archived-name collision projects the target channel's effective restore capability", async ({ app }) => {
  const owner = await seedUser("collision-owner");
  const localAdmin = await seedUser("collision-local-admin");
  const ordinary = await seedUser("collision-ordinary");
  const server = await createServer("Collision", `collision-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: localAdmin.id, role: "member" },
    { serverId: server.id, userId: ordinary.id, role: "member" },
  ]);
  const archived = await createChannel(server.id, "restore-me", undefined, "channel", { type: "user", id: owner.id });
  await addHuman(archived.id, localAdmin.id, { role: "admin" });
  await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));

  const collide = (userId: string) => fetch(`${app.baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(userId, server.id),
    body: JSON.stringify({ name: "restore-me", visibility: "public" }),
  });
  const allowed = await collide(localAdmin.id);
  assert.equal(allowed.status, 409);
  assert.equal((await allowed.json() as { canUnarchiveArchivedChannel?: boolean }).canUnarchiveArchivedChannel, true);

  const denied = await collide(ordinary.id);
  assert.equal((await denied.json() as { canUnarchiveArchivedChannel?: boolean }).canUnarchiveArchivedChannel, false);

  await getDb().update(channelHumans).set({ role: "member", authorityRevision: 2 }).where(and(
    eq(channelHumans.channelId, archived.id),
    eq(channelHumans.userId, localAdmin.id),
  ));
  const stale = await collide(localAdmin.id);
  assert.equal((await stale.json() as { canUnarchiveArchivedChannel?: boolean }).canUnarchiveArchivedChannel, false);
});

test("human add-member route uses effective channel authority and rechecks it under the channel lock", () => {
  const source = fs.readFileSync(new URL("./channels.ts", import.meta.url), "utf8");
  const routeStart = source.indexOf('channelRouter.post("/:id/members", async (req, res) => {');
  assert.notEqual(routeStart, -1, "human add-member route must exist");
  const routeEnd = source.indexOf("// Human-only v1 surface for channel-local member/admin transitions.", routeStart);
  assert.notEqual(routeEnd, -1, "human add-member route must be bounded");
  const routeBlock = source.slice(routeStart, routeEnd);

  assert.match(
    routeBlock,
    /actorHasChannelCapability\([\s\S]*?"addChannelMembers"\)/,
    "the route-level denial must resolve the effective server-or-channel capability",
  );
  assert.doesNotMatch(
    routeBlock,
    /actorHasServerCapabilityInServer\([\s\S]*?"addChannelMembers"\)/,
    "the add-member route must not collapse channel-local authority back to server role",
  );
  assert.equal(
    routeBlock.match(/withLockedChannelActorCapability\(\{/g)?.length,
    2,
    "human and Agent membership writes must each recheck authority under the channel lock",
  );
});

test("Agent add-member service rechecks both target writes under the channel lock", () => {
  const source = fs.readFileSync(new URL("./agentChannelMembers.ts", import.meta.url), "utf8");
  const serviceStart = source.indexOf("export async function addChannelMemberForAgent");
  assert.notEqual(serviceStart, -1, "Agent add-member service must exist");
  const serviceEnd = source.indexOf("export async function removeChannelMemberForAgent", serviceStart);
  assert.notEqual(serviceEnd, -1, "Agent add-member service must be bounded");
  const serviceBlock = source.slice(serviceStart, serviceEnd);

  assert.equal(
    serviceBlock.match(/withLockedChannelActorCapability\(\{/g)?.length,
    2,
    "Agent add-human and add-Agent writes must each recheck authority under the channel lock",
  );
  assert.match(
    serviceBlock,
    /addAgent\(channel\.id, target\.id, \{ executor: tx \}\)/,
    "Agent-target membership must use the caller-owned locked transaction",
  );
  assert.match(
    serviceBlock,
    /addHumanWithMembershipSystemMessage\([\s\S]*?executor: tx/,
    "human-target membership, notice, and inbox facts must use the caller-owned locked transaction",
  );
  assert.match(
    serviceBlock,
    /capability_required_under_lock[\s\S]*?status: 403/,
    "authority loss at the locked recheck must fail closed as 403",
  );
});

test("mention add surfaces project and recheck effective channel authority", () => {
  const executionSource = fs.readFileSync(new URL("../services/mentionActionService.ts", import.meta.url), "utf8");
  const projectionSource = fs.readFileSync(new URL("../services/messageService.ts", import.meta.url), "utf8");

  assert.doesNotMatch(
    executionSource,
    /actorHasServerCapabilityInServer\([\s\S]*?"addChannelMembers"\)/,
    "mention add execution must not collapse local authority to server role",
  );
  assert.match(
    executionSource,
    /actorHasChannelCapability\([\s\S]*?"addChannelMembers"\)/,
    "mention add execution must check effective authority before entering the mutation",
  );
  assert.match(
    executionSource,
    /\.for\("update"\)[\s\S]*?channelActorHasCapability\(context, "addChannelMembers"\)/,
    "mention add execution must lock its membership channel and recheck effective authority",
  );
  assert.doesNotMatch(
    projectionSource,
    /pendingMentionAvailableActions[\s\S]*?actorHasServerCapabilityInServer\([\s\S]*?"addChannelMembers"\)/,
    "pending mention actions must not advertise add from server role alone",
  );
  assert.match(
    projectionSource,
    /pendingMentionAvailableActions[\s\S]*?actorHasChannelCapability\([\s\S]*?"addChannelMembers",[\s\S]*?executor[\s\S]*?\)/,
    "pending mention actions must advertise add from effective channel authority on the caller-owned executor",
  );
});

test("human channel admin can manage local roles but cannot cross server-only boundaries", async ({ app }) => {
  const owner = await seedUser("role-owner");
  const localAdmin = await seedUser("role-local-admin");
  const peer = await seedUser("role-peer");
  const serverAdmin = await seedUser("role-server-admin");
  const invitee = await seedUser("role-invitee");
  const outsider = await seedUser("role-outsider");
  const server = await createServer("Role API", `role-api-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: localAdmin.id, role: "member" },
    { serverId: server.id, userId: peer.id, role: "member" },
    { serverId: server.id, userId: serverAdmin.id, role: "admin" },
    { serverId: server.id, userId: invitee.id, role: "member" },
    { serverId: server.id, userId: outsider.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, "human-local-admin", undefined, "private", { type: "user", id: owner.id });
  await addHuman(channel.id, localAdmin.id, { role: "admin" });
  await addHuman(channel.id, peer.id);
  await addHuman(channel.id, serverAdmin.id);

  const detail = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    headers: headers(localAdmin.id, server.id),
  });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as {
    channelRole?: string;
    channelAdminBasis?: string;
    channelCapabilities?: Record<string, boolean>;
    channelAuthorityRevision?: number;
  };
  assert.equal(detailBody.channelRole, "admin");
  assert.equal(detailBody.channelAdminBasis, "channel_role");
  assert.equal(detailBody.channelAuthorityRevision, 1);
  assert.equal(detailBody.channelCapabilities?.editChannelMetadata, true);
  assert.equal(detailBody.channelCapabilities?.archiveChannels, true);
  assert.equal(detailBody.channelCapabilities?.addChannelMembers, true);
  assert.equal(detailBody.channelCapabilities?.changeChannelMemberRoles, true);
  assert.equal(detailBody.channelCapabilities?.deleteChannels, false);
  assert.equal(detailBody.channelCapabilities?.changeChannelVisibility, false);
  assert.equal(detailBody.channelCapabilities?.federateChannels, false);

  const roster = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    headers: headers(localAdmin.id, server.id),
  });
  assert.equal(roster.status, 200);
  const rosterBody = await roster.json() as {
    humans: Array<{
      id: string;
      serverRole: string;
      effectiveChannelRole: string;
      channelAdminBasis: string | null;
      canChangeChannelRole: boolean;
    }>;
  };
  const projectedServerAdmin = rosterBody.humans.find((member) => member.id === serverAdmin.id);
  assert.deepEqual(projectedServerAdmin && {
    serverRole: projectedServerAdmin.serverRole,
    effectiveChannelRole: projectedServerAdmin.effectiveChannelRole,
    channelAdminBasis: projectedServerAdmin.channelAdminBasis,
    canChangeChannelRole: projectedServerAdmin.canChangeChannelRole,
  }, {
    serverRole: "admin",
    effectiveChannelRole: "admin",
    channelAdminBasis: "server_role",
    canChangeChannelRole: false,
  });
  const projectedPeer = rosterBody.humans.find((member) => member.id === peer.id);
  assert.deepEqual(projectedPeer && {
    serverRole: projectedPeer.serverRole,
    effectiveChannelRole: projectedPeer.effectiveChannelRole,
    channelAdminBasis: projectedPeer.channelAdminBasis,
    canChangeChannelRole: projectedPeer.canChangeChannelRole,
  }, {
    serverRole: "member",
    effectiveChannelRole: "member",
    channelAdminBasis: null,
    canChangeChannelRole: true,
  });

  const rename = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(localAdmin.id, server.id),
    body: JSON.stringify({ description: "managed locally" }),
  });
  assert.equal(rename.status, 200);

  const visibility = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "PATCH",
    headers: headers(localAdmin.id, server.id),
    body: JSON.stringify({ visibility: "public" }),
  });
  assert.equal(visibility.status, 403);

  const deleteResponse = await fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
    method: "DELETE",
    headers: headers(localAdmin.id, server.id),
  });
  assert.equal(deleteResponse.status, 403);

  const unjoinedMemberAdd = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    method: "POST",
    headers: headers(outsider.id, server.id),
    body: JSON.stringify({ userId: invitee.id }),
  });
  assert.equal(unjoinedMemberAdd.status, 404, "ordinary human members must join a private channel before adding peers");

  const addHumanResponse = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    method: "POST",
    headers: headers(localAdmin.id, server.id),
    body: JSON.stringify({ userId: invitee.id }),
  });
  assert.equal(addHumanResponse.status, 200);
  assert.equal(await isChannelHuman(channel.id, invitee.id), true);

  const invitedAgent = await createAgent(server.id, `role-invited-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const addAgentResponse = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    method: "POST",
    headers: headers(localAdmin.id, server.id),
    body: JSON.stringify({ agentId: invitedAgent.id }),
  });
  assert.equal(addAgentResponse.status, 200);
  const [invitedAgentMembership] = await getDb().select().from(channelAgents).where(and(
    eq(channelAgents.channelId, channel.id),
    eq(channelAgents.agentId, invitedAgent.id),
  ));
  assert.equal(invitedAgentMembership?.role, "member");

  const promote = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${peer.id}/role`, {
    method: "PATCH",
    headers: headers(localAdmin.id, server.id),
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promote.status, 200);
  assert.equal((await promote.json() as { authorityRevision?: number }).authorityRevision, 2);
  const [promoted] = await getDb().select().from(channelHumans).where(and(
    eq(channelHumans.channelId, channel.id),
    eq(channelHumans.userId, peer.id),
  ));
  assert.equal(promoted?.role, "admin");
  const [event] = await getDb().select().from(channelMembershipRoleEvents).where(and(
    eq(channelMembershipRoleEvents.channelId, channel.id),
    eq(channelMembershipRoleEvents.targetId, peer.id),
  ));
  assert.equal(event?.previousRole, "member");
  assert.equal(event?.nextRole, "admin");
  assert.equal(event?.deliveryStatus, "sent");

  const selfDemote = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${localAdmin.id}/role`, {
    method: "PATCH",
    headers: headers(localAdmin.id, server.id),
    body: JSON.stringify({ role: "member" }),
  });
  assert.equal(selfDemote.status, 409);
  assert.equal((await selfDemote.json() as { code?: string }).code, "channel_admin_self_demote_forbidden");

  const protectedTarget = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${serverAdmin.id}/role`, {
    method: "PATCH",
    headers: headers(localAdmin.id, server.id),
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(protectedTarget.status, 403);
  assert.equal((await protectedTarget.json() as { code?: string }).code, "protected_server_role");

  const hiddenPrivate = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${peer.id}/role`, {
    method: "PATCH",
    headers: headers(outsider.id, server.id),
    body: JSON.stringify({ role: "member" }),
  });
  assert.equal(hiddenPrivate.status, 404);
});

test("archived channels reject every human membership and metadata mutation except unarchive", async ({ app }) => {
  const owner = await seedUser("archived-owner");
  const localAdmin = await seedUser("archived-local-admin");
  const peer = await seedUser("archived-peer");
  const candidate = await seedUser("archived-candidate");
  const server = await createServer("Archived Strict", `archived-strict-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: localAdmin.id, role: "member" },
    { serverId: server.id, userId: peer.id, role: "member" },
    { serverId: server.id, userId: candidate.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, "archived-strict", undefined, "private", { type: "user", id: owner.id });
  await addHuman(channel.id, localAdmin.id, { role: "admin" });
  await addHuman(channel.id, peer.id);

  const archive = await fetch(`${app.baseUrl}/api/channels/${channel.id}/archive`, {
    method: "POST",
    headers: headers(localAdmin.id, server.id),
  });
  assert.equal(archive.status, 200);

  const attempts = await Promise.all([
    fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
      method: "PATCH",
      headers: headers(localAdmin.id, server.id),
      body: JSON.stringify({ description: "must stay frozen" }),
    }),
    fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
      method: "POST",
      headers: headers(localAdmin.id, server.id),
      body: JSON.stringify({ userId: candidate.id }),
    }),
    fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${peer.id}`, {
      method: "DELETE",
      headers: headers(localAdmin.id, server.id),
    }),
    fetch(`${app.baseUrl}/api/channels/${channel.id}/members/user/${peer.id}/role`, {
      method: "PATCH",
      headers: headers(localAdmin.id, server.id),
      body: JSON.stringify({ role: "admin" }),
    }),
    fetch(`${app.baseUrl}/api/channels/${channel.id}/leave`, {
      method: "POST",
      headers: headers(localAdmin.id, server.id),
    }),
  ]);
  assert.deepEqual(attempts.map((response) => response.status), [409, 409, 409, 409, 409]);
});

test("agent channel admin uses existing management actions without gaining visibility changes or role API", async ({ app }) => {
  const owner = await seedUser("agent-role-owner");
  const target = await seedUser("agent-role-target");
  const addedTarget = await seedUser("agent-role-added-target");
  const memberAddedTarget = await seedUser("agent-role-member-added-target");
  const adminAddedTarget = await seedUser("agent-role-admin-added-target");
  const server = await createServer("Agent Role", `agent-role-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: target.id, role: "member" },
    { serverId: server.id, userId: addedTarget.id, role: "member" },
    { serverId: server.id, userId: memberAddedTarget.id, role: "member" },
    { serverId: server.id, userId: adminAddedTarget.id, role: "member" },
  ]);
  const agent = await createAgent(server.id, `local-admin-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const credential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["channels"],
    name: "channel-admin-surface-test",
    createdByUserId: null,
  });
  const channel = await createChannel(server.id, "agent-local-admin", undefined, "private", { type: "user", id: owner.id });
  await addAgent(channel.id, agent.id, { role: "admin" });
  await addHuman(channel.id, target.id);
  const actor = { id: agent.id, name: agent.name, serverId: server.id };

  const addHumanResult = await addChannelMemberForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    body: { userId: addedTarget.id },
  });
  assert.equal(addHumanResult.status, 200);
  assert.equal(await isChannelHuman(channel.id, addedTarget.id), true);

  const addedAgent = await createAgent(server.id, `agent-role-added-agent-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const addAgentResult = await addChannelMemberForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    body: { agentId: addedAgent.id },
  });
  assert.equal(addAgentResult.status, 200);
  const [addedAgentMembership] = await getDb().select().from(channelAgents).where(and(
    eq(channelAgents.channelId, channel.id),
    eq(channelAgents.agentId, addedAgent.id),
  ));
  assert.ok(addedAgentMembership);
  const addedAgentProjection = (await listChannelsForAgent(server.id, addedAgent.id))
    .find((candidate) => candidate.id === channel.id);
  assert.ok(addedAgentProjection && "channelRole" in addedAgentProjection);
  assert.equal(addedAgentProjection?.channelRole, "member");
  assert.equal(addedAgentProjection?.channelCapabilities?.addChannelMembers, true);
  const memberAgentAdd = await addChannelMemberForAgent({
    actor: { id: addedAgent.id, name: addedAgent.name, serverId: server.id },
    serverId: server.id,
    channelId: channel.id,
    body: { userId: memberAddedTarget.id },
  });
  assert.equal(memberAgentAdd.status, 200);

  const adminAgent = await createAgent(server.id, `unjoined-admin-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, adminAgent.id),
  ));
  const unjoinedAdminAdd = await addChannelMemberForAgent({
    actor: { id: adminAgent.id, name: adminAgent.name, serverId: server.id },
    serverId: server.id,
    channelId: channel.id,
    body: { userId: adminAddedTarget.id },
  });
  assert.equal(unjoinedAdminAdd.status, 200);

  const ordinaryAgent = await createAgent(server.id, `unjoined-member-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  const unjoinedMemberAgentAdd = await addChannelMemberForAgent({
    actor: { id: ordinaryAgent.id, name: ordinaryAgent.name, serverId: server.id },
    serverId: server.id,
    channelId: channel.id,
    body: { userId: target.id },
  });
  assert.equal(unjoinedMemberAgentAdd.status, 404);

  const rename = await updateChannelForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    body: { description: "agent managed" },
  });
  assert.equal(rename.status, 200);

  const visibility = await updateChannelForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    body: { visibility: "public" },
  });
  assert.equal(visibility.status, 403);

  const remove = await removeChannelMemberForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    body: { userId: target.id },
  });
  assert.equal(remove.status, 200);
  assert.equal(await isChannelHuman(channel.id, target.id), false);

  const archive = await setChannelArchivedForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    archived: true,
  });
  assert.equal(archive.status, 200);

  const archivedAgentAdd = await addChannelMemberForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    body: { userId: target.id },
  });
  assert.equal(archivedAgentAdd.status, 409);
  const archivedAgentEdit = await updateChannelForAgent({
    actor,
    serverId: server.id,
    channelId: channel.id,
    body: { description: "must stay frozen" },
  });
  assert.equal(archivedAgentEdit.status, 409);

  const [storedAgent] = await getDb().select().from(channelAgents).where(and(
    eq(channelAgents.channelId, channel.id),
    eq(channelAgents.agentId, agent.id),
  ));
  assert.equal(storedAgent?.role, "admin");

  const agentRoot = await fetch(`${app.baseUrl}/internal/agent-api`, {
    headers: { Authorization: `Bearer ${credential.apiKey}` },
  });
  assert.equal(agentRoot.status, 200, `agent credential positive control: ${await agentRoot.text()}`);
  const agentApiSource = fs.readFileSync(new URL("./internalAgentApi.ts", import.meta.url), "utf8");
  const legacyAgentApiSource = fs.readFileSync(new URL("./internal.ts", import.meta.url), "utf8");
  assert.doesNotMatch(agentApiSource, /members\/:targetType\/:memberId\/role/);
  assert.doesNotMatch(legacyAgentApiSource, /members\/:targetType\/:memberId\/role/);
});

test("channel-role outbox retries idempotently and dead-letters after a bounded attempt count", async ({ app }) => {
  const owner = await seedUser("outbox-owner");
  const peer = await seedUser("outbox-peer");
  const server = await createServer("Role Outbox", `role-outbox-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: peer.id, role: "member" });
  const channel = await createChannel(server.id, "outbox-channel", undefined, "channel", { type: "user", id: owner.id });
  await addHuman(channel.id, peer.id);
  const [event] = await getDb().insert(channelMembershipRoleEvents).values({
    channelId: channel.id,
    serverId: server.id,
    requesterUserId: owner.id,
    targetType: "user",
    targetId: peer.id,
    previousRole: "member",
    nextRole: "admin",
    authorityRevision: 2,
  }).returning();

  const failingIo = {
    to() {
      throw new Error("synthetic socket failure");
    },
  } as never;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await drainChannelMembershipRoleOutbox({ io: failingIo });
  }
  const [dead] = await getDb().select().from(channelMembershipRoleEvents).where(eq(channelMembershipRoleEvents.id, event.id));
  assert.equal(dead?.deliveryStatus, "dead_letter");
  assert.equal(dead?.deliveryAttempts, 5);
  assert.match(dead?.lastDeliveryError ?? "", /synthetic socket failure/);

  const sixth = await drainChannelMembershipRoleOutbox({ io: failingIo });
  assert.deepEqual(sixth, { attempted: 0, sent: 0, failed: 0, deadLettered: 0 });
});
