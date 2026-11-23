// Agent API auth suite: principals, credentials, capabilities, traces, route auth
// registry, computer surface, version header, server info, channel members,
// directories and mute, profiles, joint channel joins, rosters.
// Shared fixtures: ./internalAgentApi.auth.testkit.ts.
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { BasicTracer, EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { refusalBody } from "../lib/refusal";
import { profileNotFoundRefusal } from "./agentRouteRefusals";
import { traceAgentIdHash } from "../tracing/traceIdentity";
import {
  agentCredentials,
  agents as agentsTable,
  channelAgents,
  channelHumans,
  channels,
  inboxTargetMuteStates,
  jointChannels,
  jointChannelServers,
  machines,
  serverAgentMembers,
  serverMembers,
  servers as serversTable,
  users,
} from "../db/schema";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createChannel, addAgent, addHuman, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { revealAllChannelForTest } from "../test/allChannelFixture";
import {
  jsonHeaders,
  assertCapabilityDenied,
  mintAgentKey,
  seedAuthFixture,
  setAgentServerRole,
  maskedResponse,
  fetchAgentProfile,
} from "./internalAgentApi.auth.testkit";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("agent-api and computer surfaces reject wrong principals with stable errors", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const machineOnAgentApi = await fetch(`${app.baseUrl}/internal/agent-api`, {
    headers: jsonHeaders(fixture.machineApiKey),
  });
  assert.equal(machineOnAgentApi.status, 401);
  assert.equal((await machineOnAgentApi.json() as { code?: string }).code, "invalid_principal");

  const computerOnAgentApi = await fetch(`${app.baseUrl}/internal/agent-api`, {
    headers: jsonHeaders(fixture.computerApiKey),
  });
  assert.equal(computerOnAgentApi.status, 401);
  assert.equal((await computerOnAgentApi.json() as { code?: string }).code, "invalid_principal");

  const agentOnComputer = await fetch(`${app.baseUrl}/internal/computer/runners/${fixture.agentId}/credentials`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ scopes: ["read"] }),
  });
  assert.equal(agentOnComputer.status, 401);
  assert.equal((await agentOnComputer.json() as { code?: string }).code, "invalid_principal");
});

test("agent-api server info and channel membership use the bound runner identity", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const fixture = await seedAuthFixture();
  const db = getDb();

  const serverInfo = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(serverInfo.status, 200);
  const serverBody = await serverInfo.json() as {
    runtimeContext?: { agentId?: string; runtime?: string; model?: string; reasoningEffort?: string | null };
    serverRole?: string | null;
    serverCapabilities?: { addChannelMembers?: boolean; createPublicChannels?: boolean; createPrivateChannels?: boolean; createChannels?: boolean };
    channels?: Array<{ id: string; joined: boolean }>;
    agents?: Array<{ name: string; status?: string; activity?: string | null; activityDetail?: string | null; role: string | null }>;
  };
  assert.equal(serverBody.runtimeContext?.agentId, fixture.agentId);
  assert.equal(serverBody.runtimeContext?.runtime, "claude");
  assert.equal(serverBody.runtimeContext?.model, "sonnet");
  assert.equal(serverBody.runtimeContext?.reasoningEffort, null);
  assert.equal(serverBody.serverRole, "member");
  assert.equal(serverBody.serverCapabilities?.addChannelMembers, true);
  assert.equal(serverBody.serverCapabilities?.createPublicChannels, true);
  assert.equal(serverBody.serverCapabilities?.createPrivateChannels, true);
  // The key from before the split stays on the wire (public OR private) for older readers.
  assert.equal(serverBody.serverCapabilities?.createChannels, true);
  const ownAgent = serverBody.agents?.find((candidate) => candidate.name === "AgentApiAuthBot");
  assert.equal(ownAgent?.role, "member");
  assert.equal(typeof ownAgent?.status, "string");
  assert.equal(ownAgent?.activity, "offline");
  assert.equal(ownAgent?.activityDetail, "");
  assert.equal(serverBody.channels?.find((channel) => channel.id === fixture.channelId)?.joined, true);
  assert.equal(serverBody.channels?.find((channel) => channel.id === fixture.joinOnlyChannelId)?.joined, false);

  const join = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.joinOnlyChannelId}/join`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(join.status, 200);

  const resolve = await fetch(`${app.baseUrl}/internal/agent-api/resolve-channel`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ target: `#${fixture.channelName}` }),
  });
  assert.equal(resolve.status, 200);
  const resolveBody = await resolve.json() as { channelId?: string };
  assert.equal(resolveBody.channelId, fixture.channelId);

  const memberCreate = await fetch(`${app.baseUrl}/internal/agent-api/channels`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ name: "agent-api-member-create" }),
  });
  assert.equal(memberCreate.status, 200, "member agent holds createPublicChannels");
  const memberPrivateCreate = await fetch(`${app.baseUrl}/internal/agent-api/channels`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ name: "agent-api-member-private-create", visibility: "private" }),
  });
  assert.equal(memberPrivateCreate.status, 200, "member agent holds createPrivateChannels");

  const [targetHuman] = await db.insert(users).values({
    email: `agent-api-auth-target-${randomUUID()}@slock.test`,
    name: `agent-api-auth-target-${randomUUID().slice(0, 8)}`,
    displayName: "Agent API Auth Target",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await db.insert(serverMembers).values({
    serverId: fixture.serverId,
    userId: targetHuman.id,
    role: "member",
  });
  const addMember = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}/members`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ user: targetHuman.name }),
  });
  assert.equal(addMember.status, 200, "member agent holds addChannelMembers");
  const [targetMembership] = await db
    .select({ channelId: channelHumans.channelId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, fixture.channelId), eq(channelHumans.userId, targetHuman.id)));
  assert.equal(targetMembership?.channelId, fixture.channelId, "member agent add-member must persist target human");

  const leave = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}/leave`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(leave.status, 200);

  const deniedUpdateChannel = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}`, {
    method: "PATCH",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ name: "#agent-api-member-renamed" }),
  });
  await assertCapabilityDenied(
    deniedUpdateChannel,
    "Agent requires editChannelMetadata or changeChannelVisibility capability to update channels",
    "member agent channel update",
  );
  const [channelAfterDeniedUpdate] = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, fixture.channelId));
  assert.equal(channelAfterDeniedUpdate?.name, fixture.channelName, "member agent channel update denial must not rename");

  const deniedRemoveMember = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}/members`, {
    method: "DELETE",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ user: fixture.ownerName }),
  });
  await assertCapabilityDenied(
    deniedRemoveMember,
    "Agent requires removeChannelMembers capability to remove channel members",
    "member agent channel remove-member",
  );
  const [ownerMembershipAfterDeniedRemove] = await db
    .select({ channelId: channelHumans.channelId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, fixture.channelId), eq(channelHumans.userId, fixture.ownerId)));
  assert.ok(ownerMembershipAfterDeniedRemove, "member agent remove-member denial must preserve existing human membership");

  const deniedUpdateServer = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    method: "PATCH",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ name: "Member Agent Server Rename" }),
  });
  await assertCapabilityDenied(
    deniedUpdateServer,
    "Agent requires editServerSettings capability to edit the server profile",
    "member agent server update",
  );
  const [serverAfterDeniedUpdate] = await db
    .select({ name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, fixture.serverId));
  assert.equal(serverAfterDeniedUpdate?.name, "Agent API Auth Test", "member agent server update denial must not rename");

  await db
    .update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, fixture.serverId), eq(serverAgentMembers.agentId, fixture.agentId)));

  const create = await fetch(`${app.baseUrl}/internal/agent-api/channels`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ name: "#agent-api-admin-create", visibility: "public" }),
  });
  assert.equal(create.status, 200, `expected 200, got ${create.status}`);
  const createBody = await create.json() as { id: string; name: string; type: string; createdByAgentId: string };
  assert.equal(createBody.name, "agent-api-admin-create");
  assert.equal(createBody.type, "channel");
  assert.equal(createBody.createdByAgentId, fixture.agentId);
  const [membership] = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, createBody.id), eq(channelAgents.agentId, fixture.agentId)));
  assert.ok(membership, "created channel should include creator agent membership");
  const [createdChannel] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, createBody.id));
  assert.ok(createdChannel, "created channel should be persisted");

  const peerAgent = await createAgent(fixture.serverId, `peer-${randomUUID().slice(0, 8)}`, { runtime: "claude" });
  const addAgentMember = await fetch(`${app.baseUrl}/internal/agent-api/channels/${createBody.id}/members`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ agent: peerAgent.name }),
  });
  assert.equal(addAgentMember.status, 200, `expected 200, got ${addAgentMember.status}`);
  const addAgentBody = await addAgentMember.json() as { ok?: boolean; alreadyMember?: boolean; member?: { type?: string; name?: string } };
  assert.equal(addAgentBody.ok, true);
  assert.equal(addAgentBody.alreadyMember, false);
  assert.equal(addAgentBody.member?.type, "agent");
  assert.equal(addAgentBody.member?.name, peerAgent.name);
  const [peerMembership] = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, createBody.id), eq(channelAgents.agentId, peerAgent.id)));
  assert.ok(peerMembership, "add-member should include target agent membership");

  const updateChannel = await fetch(`${app.baseUrl}/internal/agent-api/channels/${createBody.id}`, {
    method: "PATCH",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ name: "#agent-api-admin-renamed" }),
  });
  assert.equal(updateChannel.status, 200, `expected 200, got ${updateChannel.status}`);
  const updateChannelBody = await updateChannel.json() as { id: string; name: string; type: string };
  assert.equal(updateChannelBody.id, createBody.id);
  assert.equal(updateChannelBody.name, "agent-api-admin-renamed");
  assert.equal(updateChannelBody.type, "channel");

  const removeAgentMember = await fetch(`${app.baseUrl}/internal/agent-api/channels/${createBody.id}/members`, {
    method: "DELETE",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ agent: peerAgent.name }),
  });
  assert.equal(removeAgentMember.status, 200, `expected 200, got ${removeAgentMember.status}`);
  const removeAgentBody = await removeAgentMember.json() as {
    ok?: boolean;
    wasMember?: boolean;
    member?: { type?: string; name?: string };
    attention?: { stillArrives?: string[]; threadBoundary?: string; manageCommand?: string };
  };
  assert.equal(removeAgentBody.ok, true);
  assert.equal(removeAgentBody.wasMember, true);
  assert.equal(removeAgentBody.member?.type, "agent");
  assert.equal(removeAgentBody.member?.name, peerAgent.name);
  assert.ok(
    removeAgentBody.attention?.stillArrives?.some((line) => /followed threads still notify/.test(line)),
    "remove-member should warn that public followed threads can still notify",
  );
  assert.match(removeAgentBody.attention?.threadBoundary ?? "", /does not unfollow existing thread follows/);
  assert.match(removeAgentBody.attention?.threadBoundary ?? "", /Private channel\/thread content still requires current parent access/);
  assert.match(removeAgentBody.attention?.manageCommand ?? "", /raft thread unfollow/);
  const [removedPeerMembership] = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, createBody.id), eq(channelAgents.agentId, peerAgent.id)));
  assert.equal(removedPeerMembership, undefined, "remove-member should delete target agent membership");

  const updateServer = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    method: "PATCH",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ name: "Agent API Renamed Server" }),
  });
  assert.equal(updateServer.status, 200, `expected 200, got ${updateServer.status}`);
  const updateServerBody = await updateServer.json() as { id: string; name: string };
  assert.equal(updateServerBody.id, fixture.serverId);
  assert.equal(updateServerBody.name, "Agent API Renamed Server");

  const createSpan = sink.getAllSpans().find((span) =>
    span.name === "server.http.request"
    && span.attrs?.route_pattern === "/internal/agent-api/channels"
    && span.events.some((event) => event.name === "agent_channel_create.created")
  );
  assert.ok(createSpan, "expected agent-api channel create trace span");
  const traceEvents = new Map(createSpan.events.map((event) => [event.name, event]));
  assert.equal(traceEvents.get("agent_channel_create.request.started")?.attrs?.actor_server_match, true);
  assert.equal(traceEvents.get("agent_channel_create.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(traceEvents.get("agent_channel_create.authorization.checked")?.attrs?.required_capability, "createPublicChannels");
  assert.equal(traceEvents.get("agent_channel_create.created")?.attrs?.visibility, "public");
  assert.equal(traceEvents.get("agent_channel_create.created")?.attrs?.creator_joined, true);
  assert.equal(traceEvents.get("agent_channel_create.broadcasted")?.attrs?.visibility, "public");
  assert.equal(createSpan.events.some((event) => Object.values(event.attrs ?? {}).includes(fixture.agentId)), false);
  // The agent is identifiable in traces only by its keyed hash.
  const agentHash = traceAgentIdHash(fixture.agentId);
  assert.match(agentHash ?? "", /^[0-9a-f]{16}$/);
  assert.equal(createSpan.attrs?.agent_id_hash, agentHash);
  assert.equal(createSpan.attrs?.agent_id_present, true);

  const addMemberSpan = sink.getAllSpans().find((span) =>
    span.name === "server.http.request"
    && span.attrs?.route_pattern === "/internal/agent-api/channels/:channelId/members"
    && span.events.some((event) => event.name === "agent_channel_member_add.added")
  );
  assert.ok(addMemberSpan, "expected agent-api channel add-member trace span");
  const addMemberEvents = new Map(addMemberSpan.events.map((event) => [event.name, event]));
  assert.equal(addMemberEvents.get("agent_channel_member_add.request.started")?.attrs?.actor_server_match, true);
  assert.equal(addMemberEvents.get("agent_channel_member_add.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(addMemberEvents.get("agent_channel_member_add.added")?.attrs?.target_type, "human");
  assert.equal(addMemberEvents.get("agent_channel_member_add.added")?.attrs?.channel_visibility, "public");
  const addMemberTraceEvents = addMemberSpan.events.filter((event) => event.name.startsWith("agent_channel_member_add."));
  assert.equal(addMemberTraceEvents.some((event) => Object.values(event.attrs ?? {}).includes(fixture.agentId)), false);
  assert.equal(addMemberTraceEvents.some((event) => Object.values(event.attrs ?? {}).includes(targetHuman.id)), false);
  assert.equal(addMemberTraceEvents.some((event) => Object.values(event.attrs ?? {}).includes(peerAgent.id)), false);

  const updateChannelSpan = sink.getAllSpans().find((span) =>
    span.name === "server.http.request"
    && span.attrs?.route_pattern === "/internal/agent-api/channels/:channelId"
    && span.events.some((event) => event.name === "agent_channel_update.updated")
  );
  assert.ok(updateChannelSpan, "expected agent-api channel update trace span");
  const updateChannelEvents = new Map(updateChannelSpan.events.map((event) => [event.name, event]));
  assert.equal(updateChannelEvents.get("agent_channel_update.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(updateChannelEvents.get("agent_channel_update.updated")?.attrs?.renamed, true);
  assert.equal(updateChannelEvents.get("agent_channel_update.updated")?.attrs?.visibility_changed, false);
  // Scope the no-identity-leak assertion to this route's own trace events
  // (agent_channel_update.*), matching the add-member block above. The channel
  // update request now also emits the message-pipeline events from broadcasting
  // the channel.rename system message, and those legitimately carry
  // receiver_id (an established inbox trace contract) that can include this
  // agent's own id. The invariant we guard here is that the agent-api route's
  // OWN events don't leak identity — not that the whole span is id-free.
  const updateChannelTraceEvents = updateChannelSpan.events.filter((event) =>
    event.name.startsWith("agent_channel_update."),
  );
  // Guard the scoping itself: `some()` over an empty array is false, so if the
  // agent_channel_update.* event names ever change (or stop being emitted) the
  // assertion below would pass vacuously — reporting "no identity leak" when it
  // had nothing to inspect. Narrowing an assertion's scope and creating an empty
  // set are the same motion; this keeps the two distinguishable.
  assert.ok(
    updateChannelTraceEvents.length > 0,
    "expected agent_channel_update.* trace events to scope the identity assertion against",
  );
  assert.equal(updateChannelTraceEvents.some((event) => Object.values(event.attrs ?? {}).includes(fixture.agentId)), false);

  const removeMemberSpan = sink.getAllSpans().find((span) =>
    span.name === "server.http.request"
    && span.attrs?.route_pattern === "/internal/agent-api/channels/:channelId/members"
    && span.events.some((event) => event.name === "agent_channel_member_remove.removed")
  );
  assert.ok(removeMemberSpan, "expected agent-api channel remove-member trace span");
  const removeMemberEvents = new Map(removeMemberSpan.events.map((event) => [event.name, event]));
  assert.equal(removeMemberEvents.get("agent_channel_member_remove.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(removeMemberEvents.get("agent_channel_member_remove.removed")?.attrs?.target_type, "agent");
  assert.equal(removeMemberEvents.get("agent_channel_member_remove.removed")?.attrs?.was_member, true);
  const removeMemberTraceEvents = removeMemberSpan.events.filter((event) => event.name.startsWith("agent_channel_member_remove."));
  assert.equal(removeMemberTraceEvents.some((event) => Object.values(event.attrs ?? {}).includes(fixture.agentId)), false);
  assert.equal(removeMemberTraceEvents.some((event) => Object.values(event.attrs ?? {}).includes(peerAgent.id)), false);

  const updateServerSpan = sink.getAllSpans().find((span) =>
    span.name === "server.http.request"
    && span.attrs?.route_pattern === "/internal/agent-api/server"
    && span.events.some((event) => event.name === "agent_server_profile.updated")
  );
  assert.ok(updateServerSpan, "expected agent-api server update trace span");
  const updateServerEvents = new Map(updateServerSpan.events.map((event) => [event.name, event]));
  assert.equal(updateServerEvents.get("agent_server_profile.authorization.checked")?.attrs?.outcome, "allowed");
  assert.equal(updateServerEvents.get("agent_server_profile.updated")?.attrs?.renamed, true);
  assert.equal(updateServerSpan.events.some((event) => Object.values(event.attrs ?? {}).includes(fixture.agentId)), false);
});

test("agent-api server info and channel members respect hidden human directory", async ({ app }) => {
  const fixture = await seedAuthFixture();
  await revealAllChannelForTest(fixture.serverId);
  const db = getDb();
  const [extraHuman] = await db.insert(users).values({
    email: `agent-api-hidden-extra-${randomUUID()}@slock.test`,
    name: `agent-api-hidden-extra-${randomUUID()}`,
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await db.insert(serverMembers).values({
    serverId: fixture.serverId,
    userId: extraHuman.id,
    role: "member",
  });
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, fixture.serverId));

  const serverInfo = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(serverInfo.status, 200);
  const serverBody = await serverInfo.json() as { humans?: Array<{ name: string }> };
  assert.deepEqual(serverBody.humans, [], "agent-api server info must not enumerate humans when the human directory is hidden");

  const memberList = await fetch(
    `${app.baseUrl}/internal/agent-api/channel-members?channel=${encodeURIComponent("#all")}`,
    { headers: jsonHeaders(fixture.agentApiKey) },
  );
  assert.equal(memberList.status, 200);
  const memberListBody = await memberList.json() as { humans?: Array<{ name: string }>; agents?: Array<{ name: string; role?: string | null }> };
  assert.deepEqual(memberListBody.humans, [], "agent-api channel-members must not enumerate #all humans when the human directory is hidden");
  assert.ok(memberListBody.agents?.some((candidate) => candidate.name === "AgentApiAuthBot"), "human-directory setting must not hide agents");
  assert.ok(memberListBody.agents?.some((candidate) => (
    candidate.name === "AgentApiAuthBot" && candidate.role === "member"
  )), "agent channel member rows should expose server role labels");
});

test("agent profile lookup of a hidden human @handle answers exactly like a missing handle", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  const hiddenName = `hidden-profile-${randomUUID().slice(0, 8)}`;
  const [hiddenHuman] = await db.insert(users).values({
    email: `${hiddenName}@slock.test`,
    name: hiddenName,
    displayName: "Hidden Profile Human",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await db.insert(serverMembers).values({ serverId: fixture.serverId, userId: hiddenHuman.id, role: "member" });
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, fixture.serverId));
  const missingName = `missing-profile-${randomUUID().slice(0, 8)}`;

  const hidden = await maskedResponse(await fetchAgentProfile(app.baseUrl, fixture.agentApiKey, hiddenName), hiddenName);
  const missing = await maskedResponse(await fetchAgentProfile(app.baseUrl, fixture.agentApiKey, missingName), missingName);
  assert.deepEqual(hidden, missing, "a hidden human must be indistinguishable from a missing handle");
  assert.equal(missing.status, 404);

  await setAgentServerRole(fixture.serverId, fixture.agentId, "admin");
  const adminRes = await fetchAgentProfile(app.baseUrl, fixture.agentApiKey, hiddenName);
  const adminBody = await adminRes.json() as { kind?: string; id?: string };
  assert.equal(adminRes.status, 200, JSON.stringify(adminBody));
  assert.deepEqual([adminBody.kind, adminBody.id], ["human", hiddenHuman.id], "an admin agent resolves the hidden person");
});

test("agent profile lookup never returns a human's email, to member, admin or assistant agents", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const emailOf = async (apiKey: string) => {
    const res = await fetchAgentProfile(app.baseUrl, apiKey, fixture.ownerName);
    const body = await res.json() as { kind?: string; email?: string | null };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.kind, "human");
    return body.email;
  };

  assert.equal(await emailOf(fixture.agentApiKey), null, "a member agent gets no human email");
  const assistant = await createAgent(fixture.serverId, `owner-helper-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  // An assistant is on no machine (agents_assistant_not_on_machine).
  await getDb().update(agentsTable).set({ assistantOwnerUserId: fixture.ownerId, machineId: null }).where(eq(agentsTable.id, assistant.id));
  assert.equal(await emailOf(await mintAgentKey(assistant.id, ["read"])), null, "the person's own assistant gets no email either");
  await setAgentServerRole(fixture.serverId, fixture.agentId, "admin");
  assert.equal(await emailOf(fixture.agentApiKey), null, "an admin agent gets no human email");
});

test("agent-api channel mute is agent receiver-keyed and visible in server info", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const fixture = await seedAuthFixture();
  const seededMessage = await createMessage(fixture.channelId, "user", fixture.ownerId, "pre-mute ordinary chatter");

  await getDb().insert(inboxTargetMuteStates).values({
    receiverType: "user",
    receiverId: fixture.ownerId,
    serverId: fixture.serverId,
    sourceChannelId: fixture.channelId,
    muteFromSeq: Number(seededMessage.seq) + 1,
  });

  const before = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(before.status, 200);
  const beforeBody = await before.json() as {
    channels?: Array<{ id: string; activityMuted?: boolean; muteFromSeq?: number | null }>;
  };
  const beforeChannel = beforeBody.channels?.find((channel) => channel.id === fixture.channelId);
  assert.equal(beforeChannel?.activityMuted, false, "human receiver mute must not leak into agent self-read");
  assert.equal(beforeChannel?.muteFromSeq, null);

  const nonMemberMute = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.joinOnlyChannelId}/mute`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(nonMemberMute.status, 403);

  const mute = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}/mute`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(mute.status, 200);
  const muteBody = await mute.json() as {
    activityMuted?: boolean;
    muteFromSeq?: number | null;
    attention?: {
      state?: string;
      unmuteCommand?: string;
      unmuteApi?: string;
      stillArrives?: string[];
      threadBoundary?: string;
      catchUp?: string;
    };
  };
  assert.equal(muteBody.activityMuted, true);
  assert.equal(muteBody.muteFromSeq, Number(seededMessage.seq) + 1);
  assert.equal(muteBody.attention?.state, "muted");
  assert.match(muteBody.attention?.unmuteCommand ?? "", /raft channel unmute #agent-api-auth-room/);
  assert.match(muteBody.attention?.unmuteApi ?? "", new RegExp(`/internal/agent-api/channels/${fixture.channelId}/unmute`));
  assert.ok(muteBody.attention?.stillArrives?.some((line) => /@mentions/.test(line)));
  const threadBoundary = muteBody.attention?.threadBoundary ?? "";
  assert.equal(
    threadBoundary,
    "Channel mute suppresses ordinary Activity from this channel only. Threads you follow keep delivering independently until you unfollow them.",
  );
  assert.doesNotMatch(
    threadBoundary,
    /all its threads|parent mute suppresses/i,
    "mute receipt must not claim parent mute suppresses followed-thread delivery",
  );
  assert.match(muteBody.attention?.catchUp ?? "", /history/);
  const traceEventsAfterManualMute = sink.getAllSpans().flatMap((span) => span.events);
  assert.equal(
    traceEventsAfterManualMute.filter((event) => event.name === "attention_hint_accepted").length,
    0,
    "manual channel mute must not be counted as attention hint acceptance",
  );

  const agentRows = await getDb()
    .select({ receiverType: inboxTargetMuteStates.receiverType, receiverId: inboxTargetMuteStates.receiverId, muteFromSeq: inboxTargetMuteStates.muteFromSeq })
    .from(inboxTargetMuteStates)
    .where(and(
      eq(inboxTargetMuteStates.sourceChannelId, fixture.channelId),
      eq(inboxTargetMuteStates.receiverType, "agent"),
      eq(inboxTargetMuteStates.receiverId, fixture.agentId),
    ));
  assert.deepEqual(agentRows, [{
    receiverType: "agent",
    receiverId: fixture.agentId,
    muteFromSeq: Number(seededMessage.seq) + 1,
  }]);

  const afterMute = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(afterMute.status, 200);
  const afterMuteBody = await afterMute.json() as {
    channels?: Array<{ id: string; activityMuted?: boolean; muteFromSeq?: number | null }>;
  };
  const mutedChannel = afterMuteBody.channels?.find((channel) => channel.id === fixture.channelId);
  assert.equal(mutedChannel?.activityMuted, true);
  assert.equal(mutedChannel?.muteFromSeq, Number(seededMessage.seq) + 1);

  const unmute = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}/unmute`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(unmute.status, 200);
  const unmuteBody = await unmute.json() as { activityMuted?: boolean; muteFromSeq?: number | null; attention?: { state?: string; muteCommand?: string } };
  assert.equal(unmuteBody.activityMuted, false);
  assert.equal(unmuteBody.muteFromSeq, null);
  assert.equal(unmuteBody.attention?.state, "unmuted");
  assert.match(unmuteBody.attention?.muteCommand ?? "", /raft channel mute #agent-api-auth-room/);

  const afterUnmute = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(afterUnmute.status, 200);
  const afterUnmuteBody = await afterUnmute.json() as {
    channels?: Array<{ id: string; activityMuted?: boolean; muteFromSeq?: number | null }>;
  };
  const unmutedChannel = afterUnmuteBody.channels?.find((channel) => channel.id === fixture.channelId);
  assert.equal(unmutedChannel?.activityMuted, false);
  assert.equal(unmutedChannel?.muteFromSeq, null);

  const threadParent = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "thread mute boundary parent",
  );
  const thread = await getOrCreateThread(threadParent.id, fixture.ownerId, "user");
  const threadMute = await fetch(`${app.baseUrl}/internal/agent-api/channels/${thread.id}/mute`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(threadMute.status, 400);
  const threadMuteError = ((await threadMute.json()) as { error?: string }).error ?? "";
  assert.equal(
    threadMuteError,
    "Threads do not have a separate mute state. Ordinary thread delivery is controlled by follow/unfollow and is independent from the parent channel's mute state; unfollow this thread to stop it.",
  );
  assert.match(threadMuteError, /controlled by follow\/unfollow.*independent from the parent channel's mute state/i);

  const hintMute = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}/mute`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      attentionHintAccepted: {
        schema: "attention-dependency-hint.v1",
        trigger: "M3",
        scope: `#${fixture.channelName}`,
        suggested_command: `raft channel mute "#${fixture.channelName}"`,
        copy_version: "attention-hint-copy-v1",
        epoch_ms: 1770000000000,
      },
    }),
  });
  assert.equal(hintMute.status, 200);
  const acceptedEvents = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "attention_hint_accepted");
  assert.equal(acceptedEvents.length, 1);
  assert.equal(acceptedEvents[0]?.attrs?.schema, "attention-dependency-hint.v1");
  assert.equal(acceptedEvents[0]?.attrs?.trigger, "M3");
  assert.equal(acceptedEvents[0]?.attrs?.scope, `#${fixture.channelName}`);
  assert.equal(acceptedEvents[0]?.attrs?.epoch_ms, 1770000000000);
});

test("an unknown agent key is traced by a hash of its prefix, never the key", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const unknownKey = "sk_agent_unknownunknownunknownunknown";

  const res = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: { Authorization: `Bearer ${unknownKey}` },
  });
  assert.equal(res.status, 401);

  const [span] = sink.getAllSpans().filter((candidate) => candidate.name === "server.http.request");
  assert.ok(span);
  const lookup = span.events.find((event) => event.name === "agent_credential_auth.credential_lookup.finished");
  assert.equal(lookup?.attrs?.candidate_count, 0);
  assert.ok(lookup?.attrs?.key_prefix_hash);
  assert.equal(JSON.stringify(span).includes(unknownKey.slice(0, 16)), false);
});

test("agent credential auth records phase traces", async ({ app }) => {
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const fixture = await seedAuthFixture();

  const first = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(first.status, 200);

  const spans = sink.getAllSpans().filter((span) =>
    span.name === "server.http.request"
    && span.attrs?.route_pattern === "/internal/agent-api/server"
  );
  assert.equal(spans.length, 1);
  const [firstSpan] = spans;
  assert.ok(firstSpan);

  const firstEvents = new Map(firstSpan.events.map((event) => [event.name, event]));
  assert.equal(firstEvents.get("agent_credential_auth.credential_lookup.finished")?.attrs?.candidate_count, 1);
  assert.equal(firstEvents.get("agent_credential_auth.argon2_verify.finished")?.attrs?.outcome, "matched");
  assert.equal(firstEvents.get("agent_credential_auth.agent_lookup.finished")?.attrs?.outcome, "found");
  assert.equal(firstEvents.get("agent_credential_auth.server_liveness.checked")?.attrs?.outcome, "found");
  assert.equal(firstEvents.get("agent_credential_auth.agent_liveness.checked")?.attrs?.outcome, "found");
  assert.equal(firstEvents.get("agent_credential_auth.last_used.finished")?.attrs?.outcome, "updated");
});

test("agent-api cannot self-join joint channels", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const jointChannel = await createChannel(
    fixture.serverId,
    `agent-api-joint-invite-only-${randomUUID()}`,
    "joint invite only",
    "joint",
  );

  // A joint channel the agent is not in is invisible to it: 404, the same
  // answer as an id that does not exist (#wg-rbac B14).
  const join = await fetch(`${app.baseUrl}/internal/agent-api/channels/${jointChannel.id}/join`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(join.status, 404, `expected 404, got ${join.status}`);
  const body = (await join.json()) as { code?: string };
  assert.equal(body.code, "channel_not_found");

  const rows = await getDb()
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, jointChannel.id), eq(channelAgents.agentId, fixture.agentId)));
  assert.equal(rows.length, 0, "agent-api join must not add channel_agents rows for joint channels");
});

test("agent-api join on a joint channel the agent can see keeps the joint refusal", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const jointChannel = await createChannel(
    fixture.serverId,
    `agent-api-joint-visible-${randomUUID()}`,
    "joint visible",
    "joint",
  );
  // A real joint projection, so the agent's membership makes it visible.
  const db = getDb();
  const [jointStorageServer] = await db.insert(serversTable).values({
    name: "Joint Visible Storage",
    slug: `joint-visible-storage-${randomUUID()}`,
    kind: "joint_storage",
    ownerId: fixture.ownerId,
    plan: "founder",
    agentAllChannelGreetingEnabled: false,
  }).returning();
  const jointStorageChannel = await createChannel(jointStorageServer.id, `joint-visible-storage-${randomUUID().slice(0, 8)}`);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: jointStorageChannel.id,
    createdByServerId: fixture.serverId,
    createdByUserId: fixture.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.serverId,
    localChannelId: jointChannel.id,
    role: "host",
    status: "active",
    joinedByUserId: fixture.ownerId,
  });
  await addAgent(jointChannel.id, fixture.agentId);

  const join = await fetch(`${app.baseUrl}/internal/agent-api/channels/${jointChannel.id}/join`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(join.status, 403, `expected 403, got ${join.status}`);
  const body = (await join.json()) as { error?: string };
  assert.match(body.error ?? "", /You can't join this channel yourself\. Ask someone from your server who's in it to add you\./);
});

test("agent channel directories skip orphan joint membership and keep valid channels", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  const active = await createChannel(fixture.serverId, `valid-joint-${randomUUID()}`, undefined, "joint");
  const orphan = await createChannel(fixture.serverId, `orphan-joint-${randomUUID()}`, undefined, "joint");
  const canonical = await createChannel(fixture.serverId, `joint-storage-${randomUUID()}`);
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: fixture.serverId,
    createdByUserId: fixture.ownerId,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.serverId,
    localChannelId: active.id,
    role: "host",
    joinedByUserId: fixture.ownerId,
  });
  await addHuman(active.id, fixture.ownerId);
  await addAgent(active.id, fixture.agentId);
  // Historical inconsistent data: today's addAgent correctly rejects an orphan.
  await db.insert(channelAgents).values({ channelId: orphan.id, agentId: fixture.agentId });
  await db.insert(channelHumans).values({ channelId: orphan.id, userId: fixture.ownerId });
  await assert.rejects(() => addAgent(orphan.id, fixture.agentId), /Channel capability required/);

  const directory = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(directory.status, 200);
  const body = await directory.json() as { channels: Array<{ id: string }> };
  assert.ok(body.channels.some(channel => channel.id === fixture.channelId));
  assert.ok(body.channels.some(channel => channel.id === active.id));
  assert.ok(!body.channels.some(channel => channel.id === orphan.id));

  const memberships = await fetch(`${app.baseUrl}/internal/agent-api/users/${fixture.ownerName}/channels`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(memberships.status, 200);
  const memberBody = await memberships.json() as { memberships: Array<{ id: string }> };
  assert.ok(memberBody.memberships.some(channel => channel.id === active.id));
  assert.ok(!memberBody.memberships.some(channel => channel.id === orphan.id));
});

test("route auth registry fails closed for unregistered new-surface siblings", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const unregisteredAgentApi = await fetch(`${app.baseUrl}/internal/agent-api/not-registered`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(unregisteredAgentApi.status, 401);
  assert.equal((await unregisteredAgentApi.json() as { code?: string }).code, "auth_policy_unregistered_path");

  const unregisteredComputer = await fetch(`${app.baseUrl}/internal/computer/not-registered`, {
    headers: jsonHeaders(fixture.machineApiKey),
  });
  assert.equal(unregisteredComputer.status, 401);
  assert.equal((await unregisteredComputer.json() as { code?: string }).code, "auth_policy_unregistered_path");
});

test("computer surface accepts phase-one machine alias for runner credential mint", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${fixture.agentId}/credentials`, {
    method: "POST",
    headers: jsonHeaders(fixture.machineApiKey),
    body: JSON.stringify({ scopes: ["read"], name: "machine-alias-mint" }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("Sec-Slock-Api-Version"), "1");
  const body = await res.json() as { apiKey?: string; scopes?: string[]; agentId?: string; credentialId?: string };
  assert.ok(body.apiKey?.startsWith("sk_agent_"));
  assert.deepEqual(body.scopes, ["read"]);
  assert.equal(body.agentId, fixture.agentId);
  // No device session issued a legacy machine key: the credential carries no session family.
  const [row] = await getDb()
    .select({ family: agentCredentials.issuedBySessionFamilyId })
    .from(agentCredentials)
    .where(eq(agentCredentials.id, body.credentialId!));
  assert.equal(row?.family, null);
});

test("computer surface refuses a migrated machine alias before the runner mint", async ({ app }) => {
  const fixture = await seedAuthFixture();
  await getDb()
    .update(machines)
    .set({ legacyKeyMigratedAt: new Date() })
    .where(eq(machines.id, fixture.machineId));

  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${fixture.agentId}/credentials`, {
    method: "POST",
    headers: jsonHeaders(fixture.machineApiKey),
    body: JSON.stringify({ scopes: ["read"], name: "migrated-alias-mint" }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json() as { code?: string }).code, "legacy_machine_key_migrated");
  const minted = await getDb()
    .select({ id: agentCredentials.id })
    .from(agentCredentials)
    .where(and(eq(agentCredentials.agentId, fixture.agentId), eq(agentCredentials.name, "migrated-alias-mint")));
  assert.deepEqual(minted, []);
});

test("computer surface revokes managed-runner credential and raw sk_agent stops authenticating", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const mint = await fetch(`${app.baseUrl}/internal/computer/runners/${fixture.agentId}/credentials`, {
    method: "POST",
    headers: jsonHeaders(fixture.machineApiKey),
    // GET /server (server info) is a `read` route.
    body: JSON.stringify({ scopes: ["read"], name: "managed-runner-test" }),
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json() as { apiKey?: string; credentialId?: string };
  assert.ok(minted.apiKey?.startsWith("sk_agent_"));
  assert.ok(minted.credentialId);

  const beforeRevoke = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(minted.apiKey!),
  });
  assert.equal(beforeRevoke.status, 200);

  const revoke = await fetch(
    `${app.baseUrl}/internal/computer/runners/${fixture.agentId}/credentials/${minted.credentialId}`,
    {
      method: "DELETE",
      headers: jsonHeaders(fixture.machineApiKey),
    },
  );
  assert.equal(revoke.status, 204);

  const afterRevoke = await fetch(`${app.baseUrl}/internal/agent-api/server`, {
    headers: jsonHeaders(minted.apiKey!),
  });
  assert.equal(afterRevoke.status, 401);
  assert.equal((await afterRevoke.json() as { error?: string }).error, "Invalid agent credential");
});

test("computer surface accepts canonical computer credentials for runner credential mint", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const res = await fetch(`${app.baseUrl}/internal/computer/runners/${fixture.agentId}/credentials`, {
    method: "POST",
    headers: jsonHeaders(fixture.computerApiKey),
    body: JSON.stringify({ scopes: ["read", "server"], name: "computer-mint" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { apiKey?: string; scopes?: string[]; agentId?: string };
  assert.ok(body.apiKey?.startsWith("sk_agent_"));
  assert.deepEqual(body.scopes, ["read", "server"]);
  assert.equal(body.agentId, fixture.agentId);
});

test("experimental internal surfaces return version header on agent-api responses", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const res = await fetch(`${app.baseUrl}/internal/agent-api`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Sec-Slock-Api-Version"), "1");
  const body = await res.json() as { agentId?: string };
  assert.equal(body.agentId, fixture.agentId);
});

test("read-only agent credential is denied on mutating agent-api routes", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const send = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ target: `#${fixture.channelName}`, content: "should not send" }),
  });
  assert.equal(send.status, 403);
  assert.equal((await send.json() as { code?: string; requiredCapability?: string }).code, "capability_not_authorized");

  const resolve = await fetch(`${app.baseUrl}/internal/agent-api/resolve-channel`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ target: `#${fixture.channelName}` }),
  });
  assert.equal(resolve.status, 403);
  assert.equal((await resolve.json() as { requiredCapability?: string }).requiredCapability, "send");

  const taskClaim = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [1] }),
  });
  assert.equal(taskClaim.status, 403);
  assert.equal((await taskClaim.json() as { requiredCapability?: string }).requiredCapability, "tasks");

  const reminderCreate = await fetch(`${app.baseUrl}/internal/agent-api/reminders`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ title: "should not schedule", delaySeconds: 60, msgId: randomUUID() }),
  });
  assert.equal(reminderCreate.status, 403);
  assert.equal((await reminderCreate.json() as { requiredCapability?: string }).requiredCapability, "tasks");

  const reaction = await fetch(`${app.baseUrl}/internal/agent-api/messages/${randomUUID()}/reactions`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  assert.equal(reaction.status, 403);
  assert.equal((await reaction.json() as { requiredCapability?: string }).requiredCapability, "reactions");

  const profileUpdate = await fetch(`${app.baseUrl}/internal/agent-api/profile`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ displayName: "Should Not Update" }),
  });
  assert.equal(profileUpdate.status, 403);
  assert.equal((await profileUpdate.json() as { requiredCapability?: string }).requiredCapability, "send");

  const mute = await fetch(`${app.baseUrl}/internal/agent-api/channels/${fixture.channelId}/mute`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(mute.status, 403);
  assert.equal((await mute.json() as { requiredCapability?: string }).requiredCapability, "channels");

  const archive = await fetch(`${app.baseUrl}/internal/agent-api/channels/archive`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ target: `#${fixture.channelName}` }),
  });
  assert.equal(archive.status, 403);
  assert.equal((await archive.json() as { requiredCapability?: string }).requiredCapability, "channels");

  const unarchive = await fetch(`${app.baseUrl}/internal/agent-api/channels/unarchive`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({ target: `#${fixture.channelName}` }),
  });
  assert.equal(unarchive.status, 403);
  assert.equal((await unarchive.json() as { requiredCapability?: string }).requiredCapability, "channels");
});

test("agent-api activity ingest is read-gated and rejects transcript paths", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const ok = await fetch(`${app.baseUrl}/internal/agent-api/activity`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({
      schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
      events: [{
        eventId: "activity-route-1",
        hookEventName: "PreToolUse",
        toolName: "Bash",
        toolInput: "npm test",
        truncated: true,
      }],
      dropped: 1,
    }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    ok: true,
    acceptedCount: 1,
    rejectedCount: 0,
    droppedCount: 1,
  });

  const forbidden = await fetch(`${app.baseUrl}/internal/agent-api/activity`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({
      schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
      events: [{
        eventId: "activity-route-2",
        hookEventName: "PreToolUse",
        toolName: "Bash",
        transcript_path: "/tmp/claude-transcript.jsonl",
      }],
    }),
  });
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json() as { code?: string }).code, "transcript_path_forbidden");

  // Unknown fields are stripped and reported, not a whole-batch 400 that would
  // stall the sender's cursor; the tool outcome fields are accepted.
  let forwarded: unknown[] = [];
  Object.assign(app.app.get("agentOrchestrator"), {
    recordExternalAgentActivity: async (_agentId: string, request: { events: unknown[] }) => {
      forwarded = request.events;
      return { acceptedCount: request.events.length, rejectedCount: 0, droppedCount: 0 };
    },
  });
  const newer = await fetch(`${app.baseUrl}/internal/agent-api/activity`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({
      schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
      events: [{
        eventId: "activity-route-3",
        hookEventName: "PostToolUse",
        toolName: "Bash",
        tool_use_id: "toolu_1",
        exit_code: 1,
        ok: true,
        futureField: { nested: true },
      }],
    }),
  });
  assert.equal(newer.status, 200);
  assert.deepEqual(await newer.json(), { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0, ignoredFields: ["futureField"] });
  assert.deepEqual(forwarded, [{
    eventId: "activity-route-3",
    hookEventName: "PostToolUse",
    toolName: "Bash",
    tool_use_id: "toolu_1",
    exit_code: 1,
    ok: true,
  }]);

  // A hosted subagent's marker reaches ingest (validated there), not stripped.
  const subagent = { parentToolUseId: "toolu_parent", taskId: "task-1", phase: "ended", outcome: "done", reportChars: 12 };
  const child = await fetch(`${app.baseUrl}/internal/agent-api/activity`, {
    method: "POST",
    headers: jsonHeaders(fixture.readOnlyApiKey),
    body: JSON.stringify({
      schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
      events: [{ eventId: "activity-route-4", hookEventName: "SubagentStop", subagent }],
    }),
  });
  assert.equal(child.status, 200);
  assert.deepEqual(await child.json(), { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 }, "nothing stripped");
  assert.deepEqual(forwarded, [{ eventId: "activity-route-4", hookEventName: "SubagentStop", subagent }]);
});

test("agent-api channel members lists members through the bound runner identity", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const res = await fetch(`${app.baseUrl}/internal/agent-api/channel-members?channel=${encodeURIComponent(`#${fixture.channelName}`)}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const body = await res.json() as {
    error?: string;
    channel: { ref: string; type: string };
    agents: Array<{ name: string; status: string }>;
    humans: Array<{ name: string; role: string }>;
  };
  assert.equal(res.status, 200, body.error);
  assert.deepEqual(body.channel, { ref: `#${fixture.channelName}`, type: "channel" });
  assert.equal(body.agents.some((agent) => agent.name === "AgentApiAuthBot"), true);
  assert.equal(body.humans.some((human) => human.name === fixture.ownerName), true);
});

test("agent-api denies capabilities absent from the active runner session", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks/claim`, {
    method: "POST",
    headers: {
      ...jsonHeaders(fixture.agentApiKey),
      "X-Slock-Agent-Active-Capabilities": "read,server",
    },
    body: JSON.stringify({ channel: `#${fixture.channelName}`, task_numbers: [1] }),
  });
  assert.equal(res.status, 501);
  const body = await res.json() as { code?: string; requiredCapability?: string };
  assert.equal(body.code, "unsupported_capability");
  assert.equal(body.requiredCapability, "tasks");
});

// Wake-bootstrap identity (xxchan, #wg-external-agent 2026-06-12): the wake
// notice tells agents to confirm their identity via `profile show`, but
// typical external credentials are minted with only send/read — and
// GET /profile was gated server-wide. Reading YOUR OWN profile is identity
// introspection and needs only `read`. Looking up another member's profile
// (`raft profile show @someone`) also needs only `read`: it returns only
// profiles the caller can already see, and member listing is already `read`.
test("agent-api profile show needs only read capability, for own profile and target lookup", async ({ app }) => {
  const fixture = await seedAuthFixture();

  const own = await fetch(`${app.baseUrl}/internal/agent-api/profile`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(own.status, 200, "read-scope credential must read its own profile");
  const ownBody = await own.json() as { profile?: { name?: string } } & { name?: string };
  const ownName = ownBody.profile?.name ?? ownBody.name;
  assert.equal(ownName, "AgentApiAuthBot", "own profile must carry the agent's @handle");

  const other = await fetch(`${app.baseUrl}/internal/agent-api/profile?target=${encodeURIComponent(`@${fixture.ownerName}`)}`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(other.status, 200, "read-scope credential can look up a visible member's profile");
  const otherBody = await other.json() as { profile?: { name?: string } } & { name?: string };
  assert.equal(otherBody.profile?.name ?? otherBody.name, fixture.ownerName);

  const missing = await fetch(`${app.baseUrl}/internal/agent-api/profile?target=${encodeURIComponent("@no-such-member-anywhere")}`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(missing.status, 404, "visibility resolution still applies to read-scope target lookups");
  assert.deepEqual(await missing.json(), refusalBody(profileNotFoundRefusal("no-such-member-anywhere")));

  const noRead = await fetch(`${app.baseUrl}/internal/agent-api/profile?target=${encodeURIComponent(`@${fixture.ownerName}`)}`, {
    headers: jsonHeaders(await mintAgentKey(fixture.agentId, ["send"])),
  });
  assert.equal(noRead.status, 403, "a credential without read cannot look up profiles");
  assert.equal((await noRead.json() as { code?: string }).code, "capability_not_authorized");

  const otherWithServer = await fetch(`${app.baseUrl}/internal/agent-api/profile?target=${encodeURIComponent(`@${fixture.ownerName}`)}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(otherWithServer.status, 200, "broader credentials keep target lookup");

  const updatedPushes: Array<{ room: string; payload: unknown }> = [];
  const originalTo = app.io.to.bind(app.io);
  (app.io as any).to = (room: string | string[]) => {
    const operator = originalTo(room as any) as any;
    const originalEmit = operator.emit.bind(operator);
    operator.emit = (event: string, ...args: unknown[]) => {
      if (event === "agent:updated") updatedPushes.push({ room: String(room), payload: args[0] });
      return originalEmit(event, ...args);
    };
    return operator;
  };
  const update = await fetch(`${app.baseUrl}/internal/agent-api/profile`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({ displayName: "Native Profile Bot" }),
  });
  assert.equal(update.status, 200, "server-capability credential can update the bound profile");
  assert.equal(updatedPushes.length, 1, "an agent editing its own profile tells open web clients to re-read it");
  assert.match(updatedPushes[0]!.room, /^server:/);
  assert.equal(typeof (updatedPushes[0]!.payload as { agentId?: unknown }).agentId, "string");
  const updateBody = await update.json() as { displayName?: string };
  assert.equal(updateBody.displayName, "Native Profile Bot");

  const afterUpdate = await fetch(`${app.baseUrl}/internal/agent-api/profile`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(afterUpdate.status, 200);
  const afterBody = await afterUpdate.json() as { displayName?: string };
  assert.equal(afterBody.displayName, "Native Profile Bot");
});

test("agent rosters read activity and server roles as batches, not per agent", async ({ app }) => {
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const fixture = await seedAuthFixture();
  const orchestrator = app.app.get("agentOrchestrator") as {
    getActivity: (agentId: string) => Promise<{ activity: string; activityDetail: string }>;
    getActivities: (rows: ReadonlyArray<{ id: string }>) => Promise<Array<{ activity: string; activityDetail: string }>>;
  };
  let singleReads = 0;
  let batchRows = 0;
  orchestrator.getActivity = async () => {
    singleReads += 1;
    return { activity: "offline", activityDetail: "" };
  };
  orchestrator.getActivities = async (rows) => {
    batchRows += rows.length;
    return rows.map(() => ({ activity: "online", activityDetail: "batched" }));
  };
  const addAgents = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const extra = await createAgent(fixture.serverId, `roster-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
      await addAgent(fixture.channelId, extra.id);
      await placeAgentOnMachine(extra.id, fixture.machineId);
    }
  };
  const routes = {
    serverInfo: { path: "/internal/agent-api/server", key: fixture.agentApiKey },
    channelMembers: { path: `/internal/agent-api/channel-members?channel=${encodeURIComponent(`#${fixture.channelName}`)}`, key: fixture.agentApiKey },
    legacyChannelMembers: { path: `/internal/agent/${fixture.agentId}/channel-members?channel=${encodeURIComponent(`#${fixture.channelName}`)}`, key: fixture.machineApiKey },
    machineAgents: { path: "/internal/machine/agents", key: fixture.machineApiKey },
  };
  const count = async (route: { path: string; key: string }) => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let queries = 0;
    pg.query = ((...args: unknown[]) => {
      queries += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const res = await fetch(`${app.baseUrl}${route.path}`, { headers: jsonHeaders(route.key) });
      const text = await res.text();
      assert.equal(res.status, 200, `${route.path}: ${text}`);
      return { queries, body: JSON.parse(text) as unknown };
    } finally {
      pg.query = originalQuery;
    }
  };
  const countAll = async () => {
    const result: Record<string, { queries: number; body: unknown }> = {};
    for (const [name, route] of Object.entries(routes)) {
      await count(route);
      result[name] = await count(route);
    }
    return result;
  };

  await addAgents(1);
  const few = await countAll();
  await addAgents(10);
  const many = await countAll();

  for (const name of Object.keys(routes)) {
    assert.ok(few[name]!.queries > 0, `${name}: the counter must observe queries`);
    // Each agent used to cost its own role query (and an activity read).
    assert.equal(many[name]!.queries, few[name]!.queries, `${name}: ${few[name]!.queries} -> ${many[name]!.queries} queries`);
  }
  assert.equal(singleReads, 0, "no route reads activity agent by agent");
  assert.ok(batchRows > 0);

  const serverAgents = (many.serverInfo!.body as { agents: Array<{ name: string; activity: string | null; activityDetail: string; role: string | null }> }).agents;
  assert.ok(serverAgents.length >= 12);
  for (const agent of serverAgents) {
    assert.equal(agent.activity, "online", agent.name);
    assert.equal(agent.activityDetail, "batched", agent.name);
    assert.ok(agent.role !== undefined, agent.name);
  }
  for (const name of ["channelMembers", "legacyChannelMembers"] as const) {
    const agents = (many[name]!.body as { agents: Array<{ name: string; role: string | null }> }).agents;
    assert.ok(agents.length >= 12, name);
    assert.ok(agents.every((agent) => agent.role === "member"), `${name}: ${JSON.stringify(agents)}`);
  }
  const machineAgents = many.machineAgents!.body as Array<{ id: string; activity: string; activityDetail: string }>;
  assert.ok(machineAgents.length >= 12);
  assert.ok(machineAgents.every((agent) => agent.activity === "online" && agent.activityDetail === "batched"));
});
