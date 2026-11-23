import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { asServerId, type AppAgentAccess } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { integrationAuditEvents, oauthClientMaintainers, oauthClients, oauthGrants, serverMembers, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { executeActionCard, prepareActionCard } from "../services/actionCardsService";
import { createOAuthClient, requestAgentAccess, revokeGrant, updateOAuthClientForAgent } from "../services/oauthService";
import { listServerAuditEvents } from "../services/integrationAuditService";

// A server_local App its Server vouched for (oauth_clients.server_vouched_at): every agent there is
// granted it automatically, whatever its creator's role now. Who vouches (an owner or admin creating
// it in their own session, or PUT /integrations/clients/:id/server-vouch), what does not (a member,
// an agent's card), and an agent widening its scopes ending the vouch.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const SCOPES = ["agent:notification:write"];

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** An owner, an admin and a member, each with an agent, oldest first. */
async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("vouch-owner");
  const admin = await seedUser("vouch-admin");
  const member = await seedUser("vouch-member");
  const server = await createServer("Vouch", `vouch-${suffix}`, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, member.id, "member");
  const agent = (label: string, creatorId: string) =>
    createAgent(server.id, `${label}${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId });
  const ownersAgent = await agent("OwnersBot", owner.id);
  const adminsAgent = await agent("AdminsBot", admin.id);
  const membersAgent = await agent("MembersBot", member.id);
  return { suffix, owner, admin, member, server, ownersAgent, adminsAgent, membersAgent };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function headersFor(f: Seeded, email: string) {
  return { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" };
}

function localApp(f: Seeded, createdByUserId: string, key: string, vouchAsCreator = false, allowedScopes = SCOPES) {
  return createOAuthClient({
    serverId: f.server.id, createdByUserId, clientId: `${key}-${f.suffix}`, name: `App ${key}`, allowedScopes, vouchAsCreator,
  });
}

async function vouchOf(clientId: string) {
  const [row] = await getDb().select({ at: oauthClients.serverVouchedAt, by: oauthClients.serverVouchedByUserId })
    .from(oauthClients).where(eq(oauthClients.id, clientId));
  return row;
}

async function vouchEvents(clientId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, clientId)))
    .orderBy(asc(integrationAuditEvents.createdAt))
    .then((rows) => rows.filter((row) => row.eventType.startsWith("app.server_")));
}

async function rowOf(baseUrl: string, f: Seeded, clientId: string, email = f.member.email) {
  const res = await fetch(`${baseUrl}/api/integrations/clients`, { headers: await headersFor(f, email) });
  assert.equal(res.status, 200);
  const rows = await res.json() as Array<{ id: string; serverVouched?: boolean; serverVouchedAt?: string | null; agentAccess: AppAgentAccess | null }>;
  const row = rows.find((candidate) => candidate.id === clientId);
  assert.ok(row, `lists ${clientId}`);
  return row;
}

function ask(f: Seeded, clientId: string, agentId: string) {
  return requestAgentAccess({ clientId, serverSlug: f.server.slug, agentId, scopes: SCOPES });
}

async function vouchRequest(baseUrl: string, f: Seeded, clientId: string, body: unknown, email: string) {
  return fetch(`${baseUrl}/api/integrations/clients/${clientId}/server-vouch`, {
    method: "PUT", headers: await headersFor(f, email), body: JSON.stringify(body),
  });
}

test("creating: an owner or admin in their own session vouches; a member's App and an agent's card do not", async ({ app }) => {
  const f = await seed();

  const res = await fetch(`${app.baseUrl}/api/integrations/clients`, {
    method: "POST", headers: await headersFor(f, f.admin.email),
    body: JSON.stringify({ name: "Admin made", clientId: `admin-made-${f.suffix}`, allowedScopes: SCOPES }),
  });
  assert.equal(res.status, 200);
  const created = (await res.json() as { client: { id: string } }).client;
  const vouch = await vouchOf(created.id);
  assert.ok(vouch?.at, "vouched at creation");
  assert.equal(vouch.by, f.admin.id);
  const [event] = await vouchEvents(created.id);
  assert.equal(event?.eventType, "app.server_vouched");
  assert.equal(event.actorType, "human");
  assert.equal(event.actorId, f.admin.id);
  assert.deepEqual(event.metadata, { clientKey: `admin-made-${f.suffix}`, reason: "created_by_admin" });
  assert.equal((await rowOf(app.baseUrl, f, created.id)).serverVouched, true);
  assert.equal((await ask(f, created.id, f.membersAgent.id)).status, "approved", "another member's agent is granted");

  // A member holds no manageExternalAuth: never vouched, even asked to.
  const byMember = await localApp(f, f.member.id, "member-made", true);
  assert.equal((await vouchOf(byMember.client.id))?.at, null);
  assert.equal((await rowOf(app.baseUrl, f, byMember.client.id)).serverVouched, false);
  assert.equal((await ask(f, byMember.client.id, f.ownersAgent.id)).status, "pending");

  // An agent's register card, confirmed by the owner: the owner is its creator, but it is not vouched.
  const channel = await createChannel(f.server.id, `vouch-card-${f.suffix}`, undefined, "channel");
  await addAgent(channel.id, f.membersAgent.id);
  await addHuman(channel.id, f.owner.id);
  const card = await prepareActionCard({
    serverId: f.server.id, requesterAgentId: f.membersAgent.id, targetChannelId: channel.id,
    action: { type: "integration:register_app", name: "Card made", clientKey: `card-made-${f.suffix}`, category: "Developer Tools",
      returnUrl: "https://card.example.test/callback", scopes: SCOPES },
  });
  await executeActionCard({ webSessionFamilyId: null, messageId: card.messageId, serverId: asServerId(f.server.id), userId: f.owner.id });
  const [registered] = await getDb().select().from(oauthClients).where(eq(oauthClients.clientId, `card-made-${f.suffix}`));
  assert.equal(registered?.createdByUserId, f.owner.id);
  assert.equal(registered.ownerAgentId, f.membersAgent.id);
  assert.equal(registered.serverVouchedAt, null, "an agent's App is never vouched at creation");
  assert.equal((await ask(f, registered.id, f.adminsAgent.id)).status, "pending");
});

test("the rule: vouched reaches every agent whatever the creator's role now; not vouched, only the creator's; a revoke still excepts", async ({ app }) => {
  const f = await seed();
  const vouched = await localApp(f, f.admin.id, "vouched", true);
  const plain = await localApp(f, f.admin.id, "plain");
  const all = [f.ownersAgent.id, f.adminsAgent.id, f.membersAgent.id];

  assert.deepEqual((await rowOf(app.baseUrl, f, vouched.client.id)).agentAccess, { allAgents: true, agentIds: all, exceptAgentIds: [] });
  assert.deepEqual((await rowOf(app.baseUrl, f, plain.client.id)).agentAccess,
    { allAgents: false, agentIds: [f.adminsAgent.id], exceptAgentIds: [f.ownersAgent.id, f.membersAgent.id] },
    "an admin's App nobody vouched for: only the admin's own agents, though the admin has the authority");
  assert.equal((await ask(f, plain.client.id, f.membersAgent.id)).status, "pending");
  assert.equal((await ask(f, plain.client.id, f.adminsAgent.id)).status, "approved");

  // The creator demoted, then gone: the vouch holds.
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)));
  assert.equal((await ask(f, vouched.client.id, f.ownersAgent.id)).status, "approved");
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.admin.id)));
  assert.deepEqual((await rowOf(app.baseUrl, f, vouched.client.id)).agentAccess, { allAgents: true, agentIds: all, exceptAgentIds: [] });

  // A person's revoke leaves a block: that agent is excepted from the vouch.
  const [grant] = await getDb().select({ id: oauthGrants.id }).from(oauthGrants)
    .where(and(eq(oauthGrants.agentId, f.ownersAgent.id), eq(oauthGrants.clientId, vouched.client.id), isNull(oauthGrants.revokedAt)));
  assert.ok(grant && await revokeGrant({ serverId: f.server.id, grantId: grant.id, revokedByUserId: f.owner.id }));
  assert.deepEqual((await rowOf(app.baseUrl, f, vouched.client.id)).agentAccess,
    { allAgents: false, agentIds: [f.adminsAgent.id, f.membersAgent.id], exceptAgentIds: [f.ownersAgent.id] });
  assert.equal((await ask(f, vouched.client.id, f.ownersAgent.id)).status, "pending");
});

test("PUT server-vouch: owners and admins in their own session, idempotent and audited; nobody else, no other App", async ({ app }) => {
  const f = await seed();
  const target = await localApp(f, f.member.id, "target");
  const id = target.client.id;

  const memberTry = await vouchRequest(app.baseUrl, f, id, { vouched: true }, f.member.email);
  assert.equal(memberTry.status, 403);
  assert.equal((await memberTry.json() as { code: string }).code, "SERVER_VOUCH_FORBIDDEN");

  // An agent's own credential (its creator an owner) is refused before the route: never delegable.
  const { apiKey } = await mintAgentCredential({ agentId: f.ownersAgent.id, scopes: ["read", "send"], name: "vouch-test", issuedVia: "computer", createdByUserId: null });
  const agentTry = await fetch(`${app.baseUrl}/api/integrations/clients/${id}/server-vouch`, {
    method: "PUT", headers: { Authorization: `Bearer ${apiKey}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ vouched: true }),
  });
  assert.ok(agentTry.status === 401 || agentTry.status === 403, `agent credential refused (${agentTry.status})`);

  assert.equal((await vouchRequest(app.baseUrl, f, id, { vouched: "yes" }, f.admin.email)).status, 400);
  assert.equal((await vouchOf(id))?.at, null, "nothing written by a refusal");

  const on = await vouchRequest(app.baseUrl, f, id, { vouched: true }, f.admin.email);
  assert.equal(on.status, 200);
  const body = await on.json() as { id: string; serverVouched: boolean; serverVouchedAt: string | null };
  assert.equal(body.id, id);
  assert.equal(body.serverVouched, true);
  assert.ok(body.serverVouchedAt);
  assert.equal((await vouchOf(id))?.by, f.admin.id);
  assert.equal((await vouchRequest(app.baseUrl, f, id, { vouched: true }, f.owner.email)).status, 200, "again: no change");
  assert.equal((await vouchOf(id))?.by, f.admin.id, "the first voucher stays");
  assert.equal((await ask(f, id, f.ownersAgent.id)).status, "approved");

  const off = await vouchRequest(app.baseUrl, f, id, { vouched: false }, f.owner.email);
  assert.equal(off.status, 200);
  assert.equal((await off.json() as { serverVouched: boolean }).serverVouched, false);
  assert.deepEqual(await vouchOf(id), { at: null, by: null });
  assert.equal((await vouchRequest(app.baseUrl, f, id, { vouched: false }, f.owner.email)).status, 200);
  // Future automatic grants stop; the one already made stays.
  assert.equal((await ask(f, id, f.adminsAgent.id)).status, "pending");
  assert.deepEqual((await rowOf(app.baseUrl, f, id)).agentAccess,
    { allAgents: false, agentIds: [f.ownersAgent.id, f.membersAgent.id], exceptAgentIds: [f.adminsAgent.id] });

  const events = await vouchEvents(id);
  assert.deepEqual(events.map((event) => [event.eventType, event.actorId, (event.metadata as { reason?: string }).reason]), [
    ["app.server_vouched", f.admin.id, "vouched"],
    ["app.server_unvouched", f.owner.id, "unvouched"],
  ]);
  // The server's own audit page shows them: a decision its admins make about their agents' access.
  const page = await listServerAuditEvents(f.server.id, { limit: 200 });
  const onPage = page.events.filter((event) => event.eventType.startsWith("app.server_")).map((event) => event.eventType);
  assert.deepEqual([...onPage].sort(), ["app.server_unvouched", "app.server_vouched"]);

  // Another Server's App, and a published-type App of this Server: not vouchable here.
  const otherOwner = await seedUser("vouch-other");
  const other = await createServer("Vouch Other", `vouch-other-${f.suffix}`, otherOwner.id);
  const elsewhere = await createOAuthClient({ serverId: other.id, createdByUserId: otherOwner.id, clientId: `elsewhere-${f.suffix}`, name: "Elsewhere" });
  assert.equal((await vouchRequest(app.baseUrl, f, elsewhere.client.id, { vouched: true }, f.owner.email)).status, 404);
  const global = await createOAuthClient({ serverId: f.server.id, createdByUserId: f.owner.id, appType: "third_party_global", clientId: `global-${f.suffix}`, name: "Global" });
  const globalTry = await vouchRequest(app.baseUrl, f, global.client.id, { vouched: true }, f.owner.email);
  assert.equal(globalTry.status, 409);
  assert.equal((await globalTry.json() as { code: string }).code, "SERVER_VOUCH_NOT_SERVER_LOCAL");
});

test("an agent widening a vouched App's scopes ends the vouch; narrowing, or a person's own edit, keeps it", async ({ app }) => {
  const f = await seed();
  const target = await localApp(f, f.owner.id, "widen", true);
  const id = target.client.id;
  const clientKey = `widen-${f.suffix}`;
  await getDb().insert(oauthClientMaintainers).values({
    clientId: id, principalType: "agent", agentId: f.membersAgent.id, role: "owner", assignedByType: "agent", assignedById: f.membersAgent.id,
  });
  const agentEdit = (allowedScopes: string[]) => updateOAuthClientForAgent({ serverId: f.server.id, clientKey, actorAgentId: f.membersAgent.id, allowedScopes });

  assert.equal((await agentEdit([...SCOPES, "agent:read"])).status, "ok");
  assert.deepEqual(await vouchOf(id), { at: null, by: null }, "widened by an agent: no longer vouched");
  const [lapsed] = (await vouchEvents(id)).filter((event) => event.eventType === "app.server_unvouched");
  assert.equal(lapsed?.actorType, "agent");
  assert.equal(lapsed.actorId, f.membersAgent.id);
  assert.equal((lapsed.metadata as { reason?: string }).reason, "scope_widened");
  assert.equal((await ask(f, id, f.adminsAgent.id)).status, "pending");

  assert.equal((await vouchRequest(app.baseUrl, f, id, { vouched: true }, f.owner.email)).status, 200);
  assert.equal((await agentEdit(SCOPES)).status, "ok");
  assert.ok((await vouchOf(id))?.at, "narrowed: still vouched");

  const patch = await fetch(`${app.baseUrl}/api/integrations/clients/${id}`, {
    method: "PATCH", headers: await headersFor(f, f.admin.email), body: JSON.stringify({ allowedScopes: [...SCOPES, "agent:read", "app:read"] }),
  });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json() as { serverVouched: boolean }).serverVouched, true, "a person's own save is their review");
  assert.ok((await vouchOf(id))?.at);
});
