import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../db/index";
import { oauthAccessRequests, oauthAgentAutoGrantBlocks, oauthGrants, thirdPartyAgentEvents, users } from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createOAuthClient, requestAgentAccess } from "../services/oauthService";
import { AGENT_APP_EVENT_RETENTION_AFTER_EXPIRY_MS, pruneExpiredAgentAppEvents } from "../services/agentAppEventsService";
import type { AgentAppEventDetail, AgentAppEventListResponse } from "@botiverse/raft-shared";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const SCOPES = ["agent:notification:write"];
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedUser(prefix: string, suffix: string) {
  const name = `${prefix}-${suffix.slice(0, 8)}`;
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** Owner, a member who created an agent, a plain member, and the owner's own agent. */
async function seedServer() {
  const suffix = randomUUID();
  const owner = await seedUser("aaa-owner", suffix);
  const creator = await seedUser("aaa-creator", suffix);
  const member = await seedUser("aaa-member", suffix);
  const server = await createServer("Agent App Access", `agent-app-access-${suffix.slice(0, 8)}`, owner.id);
  await addMember(server.id, creator.id, "member");
  await addMember(server.id, member.id, "member");
  const creatorAgent = await createAgent(server.id, `CreatorBot${suffix.slice(0, 4)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: creator.id,
  });
  const ownerAgent = await createAgent(server.id, `OwnerBot${suffix.slice(0, 4)}`, {
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: owner.id,
  });
  return { suffix, owner, creator, member, server, creatorAgent, ownerAgent };
}

async function createApp(serverId: string, createdByUserId: string, key: string) {
  return createOAuthClient({
    serverId,
    createdByUserId,
    clientId: key,
    name: `App ${key}`,
    allowedScopes: ["openid", "profile", "agent:event:write", "agent:notification:write"],
  });
}

async function requestAgent(baseUrl: string, input: { clientKey: string; clientSecret: string; serverSlug: string; agentName: string }) {
  const res = await fetch(`${baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: input.clientKey,
      clientSecret: input.clientSecret,
      serverSlug: input.serverSlug,
      agentName: input.agentName,
      scopes: SCOPES,
    }),
  });
  assert.equal(res.status, 200);
  return await res.json() as { status: string; requestId: string };
}

async function activeGrants(agentId: string, clientId: string) {
  return getDb().select().from(oauthGrants).where(and(
    eq(oauthGrants.agentId, agentId),
    eq(oauthGrants.clientId, clientId),
    isNull(oauthGrants.revokedAt),
  ));
}

function api(baseUrl: string, token: string, serverId: string) {
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" };
  return {
    get: (path: string) => fetch(`${baseUrl}/api${path}`, { headers }),
    post: (path: string, body?: unknown) => fetch(`${baseUrl}/api${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) }),
  };
}

test("automatic agent grants need authority over the agent, and a person's revoke sticks", async ({ app }) => {
  const s = await seedServer();
  // A plain member's app may not grant itself access to someone else's agent.
  const memberApp = await createApp(s.server.id, s.member.id, `aaa-m-${s.suffix.slice(0, 6)}`);
  const foreign = await requestAgent(app.baseUrl, {
    clientKey: memberApp.client.clientId,
    clientSecret: memberApp.clientSecret,
    serverSlug: s.server.slug,
    agentName: s.creatorAgent.name,
  });
  assert.equal(foreign.status, "pending");
  assert.equal((await activeGrants(s.creatorAgent.id, memberApp.client.id)).length, 0);

  // The agent's own creator's app is granted automatically.
  const creatorApp = await createApp(s.server.id, s.creator.id, `aaa-c-${s.suffix.slice(0, 6)}`);
  const own = await requestAgent(app.baseUrl, {
    clientKey: creatorApp.client.clientId,
    clientSecret: creatorApp.clientSecret,
    serverSlug: s.server.slug,
    agentName: s.creatorAgent.name,
  });
  assert.equal(own.status, "approved");
  const [grant] = await activeGrants(s.creatorAgent.id, creatorApp.client.id);
  assert.ok(grant);
  assert.equal(grant.grantSource, "app_request");

  // An owner/admin's app is granted automatically for any agent.
  const ownerApp = await createApp(s.server.id, s.owner.id, `aaa-o-${s.suffix.slice(0, 6)}`);
  const byOwner = await requestAgent(app.baseUrl, {
    clientKey: ownerApp.client.clientId,
    clientSecret: ownerApp.clientSecret,
    serverSlug: s.server.slug,
    agentName: s.creatorAgent.name,
  });
  assert.equal(byOwner.status, "approved");

  // The agent's creator revokes; the app's next request waits for a person.
  const creatorApi = api(app.baseUrl, await tokenForHuman(s.creator.email), s.server.id);
  const revoke = await creatorApi.post(`/integrations/grants/${grant.id}/revoke`);
  assert.equal(revoke.status, 200);
  const afterRevoke = await requestAgent(app.baseUrl, {
    clientKey: creatorApp.client.clientId,
    clientSecret: creatorApp.clientSecret,
    serverSlug: s.server.slug,
    agentName: s.creatorAgent.name,
  });
  assert.equal(afterRevoke.status, "pending");
  assert.equal((await activeGrants(s.creatorAgent.id, creatorApp.client.id)).length, 0);

  // Granting again on the agent's behalf clears the block; the next request reuses that grant.
  const regrant = await creatorApi.post(`/integrations/agents/${s.creatorAgent.id}/grants`, {
    clientId: creatorApp.client.id,
    scopes: SCOPES,
  });
  assert.equal(regrant.status, 201);
  assert.equal((await activeGrants(s.creatorAgent.id, creatorApp.client.id))[0]?.grantSource, "person");
  const blocks = await getDb().select().from(oauthAgentAutoGrantBlocks).where(eq(oauthAgentAutoGrantBlocks.agentId, s.creatorAgent.id));
  assert.equal(blocks.length, 0);
  const reused = await requestAgent(app.baseUrl, {
    clientKey: creatorApp.client.clientId,
    clientSecret: creatorApp.clientSecret,
    serverSlug: s.server.slug,
    agentName: s.creatorAgent.name,
  });
  assert.equal(reused.status, "approved");
  // Reused the person's grant rather than creating another one.
  assert.equal((await activeGrants(s.creatorAgent.id, creatorApp.client.id)).length, 1);
});

test("the agent's creator and owners/admins manage its app access; other members cannot", async ({ app }) => {
  const s = await seedServer();
  const memberApp = await createApp(s.server.id, s.member.id, `aab-m-${s.suffix.slice(0, 6)}`);
  const ownerApp = await createApp(s.server.id, s.owner.id, `aab-o-${s.suffix.slice(0, 6)}`);
  const creatorApi = api(app.baseUrl, await tokenForHuman(s.creator.email), s.server.id);
  const memberApi = api(app.baseUrl, await tokenForHuman(s.member.email), s.server.id);
  const ownerApi = api(app.baseUrl, await tokenForHuman(s.owner.email), s.server.id);

  // Pending request for the creator's agent: another member may not approve it, the creator may.
  const pending = await requestAgent(app.baseUrl, {
    clientKey: memberApp.client.clientId,
    clientSecret: memberApp.clientSecret,
    serverSlug: s.server.slug,
    agentName: s.creatorAgent.name,
  });
  assert.equal(pending.status, "pending");
  assert.equal((await memberApi.post(`/integrations/requests/${pending.requestId}/approve`, { remember: true })).status, 403);
  assert.equal((await creatorApi.post(`/integrations/requests/${pending.requestId}/approve`, { remember: true })).status, 200);
  const [approvedRequest] = await getDb().select().from(oauthAccessRequests).where(eq(oauthAccessRequests.id, pending.requestId));
  assert.equal(approvedRequest?.status, "approved");
  assert.equal((await activeGrants(s.creatorAgent.id, memberApp.client.id)).length, 1);

  // The creator may not manage the owner's agent.
  const forOwnerAgent = await creatorApi.post(`/integrations/agents/${s.ownerAgent.id}/grants`, { clientId: ownerApp.client.id, scopes: SCOPES });
  assert.equal(forOwnerAgent.status, 403);
  assert.equal((await memberApi.post(`/integrations/agents/${s.creatorAgent.id}/grants`, { clientId: ownerApp.client.id, scopes: SCOPES })).status, 403);

  // Owner grants on the agent's behalf; a repeat reuses the grant.
  const first = await ownerApi.post(`/integrations/agents/${s.creatorAgent.id}/grants`, { clientId: ownerApp.client.id, scopes: SCOPES });
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { grantId: string; created: boolean };
  assert.equal(firstBody.created, true);
  const [stored] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.id, firstBody.grantId));
  assert.equal(stored?.grantedByUserId, s.owner.id);
  const repeat = await ownerApi.post(`/integrations/agents/${s.creatorAgent.id}/grants`, { clientId: ownerApp.client.id, scopes: SCOPES });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json() as { grantId: string }).grantId, firstBody.grantId);

  // Scopes outside the app's allowed set, and apps not usable on this server, are refused.
  const badScope = await ownerApi.post(`/integrations/agents/${s.creatorAgent.id}/grants`, { clientId: ownerApp.client.id, scopes: ["agent:action_request:write"] });
  assert.equal(badScope.status, 400);
  const otherOwner = await seedUser("aab-other", s.suffix);
  const otherServer = await createServer("Other", `aab-other-${s.suffix.slice(0, 8)}`, otherOwner.id);
  const foreignApp = await createApp(otherServer.id, otherOwner.id, `aab-f-${s.suffix.slice(0, 6)}`);
  const foreign = await ownerApi.post(`/integrations/agents/${s.creatorAgent.id}/grants`, { clientId: foreignApp.client.id, scopes: SCOPES });
  assert.equal(foreign.status, 404);

  // The picker lists apps usable on this server, for the same people who may grant.
  const picker = await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/grantable-apps`);
  assert.equal(picker.status, 200);
  const apps = (await picker.json() as { apps: Array<{ clientId: string; scopes: string[] }> }).apps;
  const ids = apps.map((a) => a.clientId);
  assert.ok(ids.includes(ownerApp.client.id));
  assert.ok(ids.includes(memberApp.client.id));
  assert.ok(!ids.includes(foreignApp.client.id));
  assert.ok(apps.find((a) => a.clientId === ownerApp.client.id)?.scopes.includes("agent:notification:write"));
  assert.equal((await memberApi.get(`/integrations/agents/${s.creatorAgent.id}/grantable-apps`)).status, 403);
  assert.equal((await creatorApi.get(`/integrations/agents/not-an-id/grantable-apps`)).status, 404);
});

test("app events list newest first with paging, expiry display, and private visibility", async ({ app }) => {
  const s = await seedServer();
  const ownerApp = await createApp(s.server.id, s.owner.id, `aac-o-${s.suffix.slice(0, 6)}`);
  const now = Date.now();
  const rows = await getDb().insert(thirdPartyAgentEvents).values([0, 1, 2].map((i) => ({
    serverId: s.server.id,
    agentId: s.creatorAgent.id,
    clientId: ownerApp.client.id,
    externalEventId: `ext-${i}`,
    kind: "notification" as const,
    summary: `reminder ${i}`,
    payload: { text: `payload ${i}` },
    payloadHash: `hash-${i}`,
    resource: `urn:raft:server:${s.server.id}:agent-inbound`,
    status: i === 2 ? "delivered" as const : "queued" as const,
    deliveredAt: i === 2 ? new Date(now) : null,
    // Event 0 expired undelivered; 1 still queued; 2 delivered.
    expiresAt: new Date(i === 0 ? now - 1_000 : now + DAY_MS),
    createdAt: new Date(now - (3 - i) * 60_000),
  }))).returning();
  // Another agent's event never shows up for this agent.
  const [otherEvent] = await getDb().insert(thirdPartyAgentEvents).values({
    serverId: s.server.id,
    agentId: s.ownerAgent.id,
    clientId: ownerApp.client.id,
    kind: "notification",
    summary: "owner agent only",
    payload: {},
    payloadHash: "h",
    resource: "r",
    expiresAt: new Date(now + DAY_MS),
  }).returning();

  const creatorApi = api(app.baseUrl, await tokenForHuman(s.creator.email), s.server.id);
  const page1 = await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/events?limit=2`);
  assert.equal(page1.status, 200);
  const body1 = await page1.json() as AgentAppEventListResponse;
  assert.deepEqual(body1.events.map((e) => e.summary), ["reminder 2", "reminder 1"]);
  assert.deepEqual(body1.events.map((e) => e.status), ["delivered", "queued"]);
  assert.equal(body1.events[0]?.app.clientKey, ownerApp.client.clientId);
  assert.ok(body1.nextCursor);
  const page2 = await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/events?limit=2&before=${encodeURIComponent(body1.nextCursor!)}`);
  const body2 = await page2.json() as AgentAppEventListResponse;
  assert.deepEqual(body2.events.map((e) => [e.summary, e.status]), [["reminder 0", "expired"]]);
  assert.equal(body2.nextCursor, null);

  const detail = await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/events/${rows[1]!.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json() as AgentAppEventDetail).payload, { text: "payload 1" });
  // Another agent's event id reads the same as an unknown one.
  assert.equal((await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/events/${otherEvent!.id}`)).status, 404);
  assert.equal((await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/events/${randomUUID()}`)).status, 404);

  assert.equal((await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/events?limit=0`)).status, 400);
  assert.equal((await creatorApi.get(`/integrations/agents/${s.creatorAgent.id}/events?before=nope`)).status, 400);

  // Plain members cannot see an agent's app events; owners can.
  const memberApi = api(app.baseUrl, await tokenForHuman(s.member.email), s.server.id);
  assert.equal((await memberApi.get(`/integrations/agents/${s.creatorAgent.id}/events`)).status, 403);
  const ownerApi = api(app.baseUrl, await tokenForHuman(s.owner.email), s.server.id);
  assert.equal((await ownerApi.get(`/integrations/agents/${s.creatorAgent.id}/events`)).status, 200);
});

test("pruneExpiredAgentAppEvents deletes only events past the retention window", async ({ app: _app }) => {
  const s = await seedServer();
  const ownerApp = await createApp(s.server.id, s.owner.id, `aad-o-${s.suffix.slice(0, 6)}`);
  const now = new Date("2026-10-05T00:00:00Z");
  const base = {
    serverId: s.server.id,
    agentId: s.creatorAgent.id,
    clientId: ownerApp.client.id,
    kind: "notification" as const,
    payload: {},
    payloadHash: "h",
    resource: "r",
  };
  const [old, recent] = await getDb().insert(thirdPartyAgentEvents).values([
    { ...base, summary: "old", expiresAt: new Date(now.getTime() - AGENT_APP_EVENT_RETENTION_AFTER_EXPIRY_MS - 1_000) },
    { ...base, summary: "recent", expiresAt: new Date(now.getTime() - AGENT_APP_EVENT_RETENTION_AFTER_EXPIRY_MS + DAY_MS) },
  ]).returning();
  const deleted = await pruneExpiredAgentAppEvents({ now, batchSize: 1 });
  assert.ok(deleted >= 1);
  const remaining = await getDb().select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents)
    .where(eq(thirdPartyAgentEvents.agentId, s.creatorAgent.id));
  const ids = remaining.map((r) => r.id);
  assert.ok(!ids.includes(old!.id));
  assert.ok(ids.includes(recent!.id));
});

test("an agent's own login still gets an automatic grant, but not after a person revoked it", async ({ app }) => {
  const s = await seedServer();
  const memberApp = await createApp(s.server.id, s.member.id, `aae-m-${s.suffix.slice(0, 6)}`);
  const login = () => requestAgentAccess({
    clientId: memberApp.client.id,
    serverSlug: s.server.slug,
    agentName: s.creatorAgent.name,
    scopes: SCOPES,
    initiatedByAgent: true,
  });
  const first = await login();
  assert.equal(first.status, "approved");
  const [grant] = await activeGrants(s.creatorAgent.id, memberApp.client.id);
  assert.ok(grant);
  assert.equal(grant.grantSource, "agent_login");
  // The panel shows the owner that the agent's own login granted it.
  const ownerApiForList = api(app.baseUrl, await tokenForHuman(s.owner.email), s.server.id);
  const listed = await (await ownerApiForList.get(`/integrations/agents/${s.creatorAgent.id}`)).json() as Array<{ id: string; grantSource: string | null }>;
  assert.equal(listed.find((item) => item.id === grant.id)?.grantSource, "agent_login");

  const ownerApi = api(app.baseUrl, await tokenForHuman(s.owner.email), s.server.id);
  assert.equal((await ownerApi.post(`/integrations/grants/${grant.id}/revoke`)).status, 200);
  const again = await login();
  assert.equal(again.status, "pending");
  assert.equal((await activeGrants(s.creatorAgent.id, memberApp.client.id)).length, 0);
});

test("requests/agent accepts the agent id instead of its name", async ({ app }) => {
  const s = await seedServer();
  const ownerApp = await createApp(s.server.id, s.owner.id, `aaf-o-${s.suffix.slice(0, 6)}`);
  const post = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/oauth/requests/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: ownerApp.client.clientId,
      clientSecret: ownerApp.clientSecret,
      serverSlug: s.server.slug,
      scopes: SCOPES,
      ...body,
    }),
  });
  const byId = await post({ agentId: s.creatorAgent.id });
  assert.equal(byId.status, 200);
  assert.equal((await byId.json() as { status: string }).status, "approved");
  assert.equal((await activeGrants(s.creatorAgent.id, ownerApp.client.id)).length, 1);
  // The id wins over a name, and a malformed or foreign id is not found.
  assert.equal((await post({ agentId: s.creatorAgent.id, agentName: "someone-else" })).status, 200);
  assert.equal((await post({ agentId: "not-a-uuid" })).status, 404);
  assert.equal((await post({ agentId: randomUUID() })).status, 404);
});
