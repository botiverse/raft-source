import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, asc, eq, notInArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, integrationAuditEvents, serverMemberRoleAuditEvents, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { addMember, createServer, grantOnboardingAgentRole, removeMember, updateAgentMemberRole } from "../services/serverService";
import { consumeAgentBootstrapToken, issueAgentBootstrapToken, mintAgentCredential } from "../services/agentCredentialService";
import { recordAgentProvisioning } from "../services/agentRuntimeProvisionService";
import { SERVER_AUDIT_HIDDEN_EVENT_TYPES } from "../services/integrationAuditService";
import { updateServerProfileForAgent } from "./agentServerManage";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: label,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

async function eventsOf(serverId: string, eventType: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, eventType)))
    .orderBy(asc(integrationAuditEvents.createdAt));
}

test("a human renames the server: server.profile_updated with a before/after diff", async ({ app }) => {
  const owner = await seedUser("audit-rename-owner");
  const server = await createServer("Before", `audit-rename-${randomUUID()}`, owner.id);
  const token = await login(app.baseUrl, owner.email);

  const response = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
    method: "PATCH",
    headers: headers(token, server.id),
    body: JSON.stringify({ name: "After", hideHumansFromMembers: true }),
  });
  assert.equal(response.status, 200);

  const [event] = await eventsOf(server.id, "server.profile_updated");
  assert.ok(event, "the rename is audited");
  assert.equal(event.eventCategory, "server_profile");
  assert.equal(event.actorType, "human");
  assert.equal(event.actorId, owner.id);
  assert.equal(event.targetType, "server");
  assert.equal(event.targetId, server.id);
  assert.deepEqual(event.metadata, { changedFields: ["name", "hideHumansFromMembers"], actorRole: "owner" });
  assert.deepEqual(event.diff, {
    name: { before: "Before", after: "After" },
    hideHumansFromMembers: { before: false, after: true },
  });

  // A no-op write changes nothing and records nothing.
  const repeat = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
    method: "PATCH",
    headers: headers(token, server.id),
    body: JSON.stringify({ name: "After" }),
  });
  assert.equal(repeat.status, 200);
  assert.equal((await eventsOf(server.id, "server.profile_updated")).length, 1);
});

test("an admin agent renames the server: actor is the agent with its live server role", async ({ db: _db }) => {
  const owner = await seedUser("audit-agent-owner");
  const server = await createServer("Agent before", `audit-agent-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, "audit-admin-agent", { runtime: "external" });
  await updateAgentMemberRole(server.id, agent.id, "admin");

  const result = await updateServerProfileForAgent({
    actor: { id: agent.id, name: agent.name, serverId: server.id },
    serverId: server.id,
    body: { name: "Agent after" },
  });
  assert.equal(result.status, 200);

  const [event] = await eventsOf(server.id, "server.profile_updated");
  assert.ok(event);
  assert.equal(event.actorType, "agent");
  assert.equal(event.actorId, agent.id);
  assert.equal(event.source, "api");
  assert.deepEqual(event.metadata, { changedFields: ["name"], agentServerRole: "admin", actorRole: "admin" });
  assert.deepEqual(event.diff, { name: { before: "Agent before", after: "Agent after" } });
});

test("a member role change writes both the role audit row and membership.role_changed; removal writes membership.removed", async ({ app }) => {
  const owner = await seedUser("audit-role-owner");
  const member = await seedUser("audit-role-member");
  const server = await createServer("Roles", `audit-role-${randomUUID()}`, owner.id);
  await addMember(server.id, member.id, "member");
  const token = await login(app.baseUrl, owner.email);

  const promote = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${member.id}`, {
    method: "PATCH",
    headers: headers(token, server.id),
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(promote.status, 200);

  const legacyRows = await getDb().select().from(serverMemberRoleAuditEvents)
    .where(eq(serverMemberRoleAuditEvents.serverId, server.id));
  assert.equal(legacyRows.length, 1, "the existing role audit table keeps its row");
  assert.equal(legacyRows[0]!.nextRole, "admin");

  const [roleEvent] = await eventsOf(server.id, "membership.role_changed");
  assert.ok(roleEvent, "the server-wide audit table gets the same fact");
  assert.equal(roleEvent.eventCategory, "membership");
  assert.equal(roleEvent.actorId, owner.id);
  assert.equal(roleEvent.targetType, "human");
  assert.equal(roleEvent.targetId, member.id);
  assert.deepEqual(roleEvent.metadata, { previousRole: "member", nextRole: "admin", actorRole: "owner" }, "the actor's role at the time");
  assert.deepEqual(roleEvent.diff, { role: { before: "member", after: "admin" } });

  const remove = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${member.id}`, {
    method: "DELETE",
    headers: headers(token, server.id),
  });
  assert.equal(remove.status, 200);
  const [removed] = await eventsOf(server.id, "membership.removed");
  assert.ok(removed);
  assert.equal(removed.actorType, "human");
  assert.equal(removed.actorId, owner.id);
  assert.equal(removed.targetType, "human");
  assert.equal(removed.targetId, member.id);
  const { operationId, ...removedMetadata } = removed.metadata as Record<string, unknown>;
  assert.deepEqual(removedMetadata, { reason: "removed", removedRole: "admin", revokedAgentCredentialCount: 0, actorRole: "owner" });
  assert.match(String(operationId), /^[0-9a-f-]{36}$/);
});

test("an agent server role change records membership.agent_role_changed", async ({ app }) => {
  const owner = await seedUser("audit-agent-role-owner");
  const server = await createServer("Agent roles", `audit-agent-role-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, "audit-role-agent", { runtime: "external" });
  const token = await login(app.baseUrl, owner.email);

  const response = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: headers(token, server.id),
    body: JSON.stringify({ serverRole: "admin" }),
  });
  assert.equal(response.status, 200, await response.clone().text());

  const [event] = await eventsOf(server.id, "membership.agent_role_changed");
  assert.ok(event);
  assert.equal(event.actorId, owner.id);
  assert.equal(event.targetType, "agent");
  assert.equal(event.targetId, agent.id);
  assert.deepEqual(event.metadata, { agentId: agent.id, previousRole: "member", nextRole: "admin", actorRole: "owner" });
});

test("credential mint and revoke record two events without key material", async ({ app }) => {
  const owner = await seedUser("audit-cred-owner");
  const server = await createServer("Credentials", `audit-cred-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, "audit-cred-agent", { runtime: "external" });
  const token = await login(app.baseUrl, owner.email);
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const mint = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ scopes: ["read"] }),
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json() as { credentialId: string; apiKey: string };

  for (let i = 0; i < 2; i++) {
    const revoke = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials/${minted.credentialId}`, { method: "DELETE", headers: auth });
    assert.equal(revoke.status, 204);
  }

  const issued = await eventsOf(server.id, "agent_credential.issued");
  const revoked = await eventsOf(server.id, "agent_credential.revoked");
  assert.equal(issued.length, 1);
  assert.equal(revoked.length, 1, "an idempotent repeat revoke records nothing");
  assert.equal(issued[0]!.eventCategory, "agent_credential");
  assert.equal(issued[0]!.actorId, owner.id);
  assert.equal(issued[0]!.targetType, "agent_credential");
  assert.equal(issued[0]!.targetId, minted.credentialId);
  // Minted with the owner's web sign-in: its kind is recorded (the family id is trace-only).
  assert.deepEqual(issued[0]!.metadata, {
    agentId: agent.id,
    credentialId: minted.credentialId,
    scopes: ["read"],
    issuedVia: "human",
    replacedCredentialId: null,
    sessionSource: "web_session",
    actorRole: "owner",
  });
  assert.equal(revoked[0]!.targetId, minted.credentialId);
  assert.deepEqual(revoked[0]!.metadata, { agentId: agent.id, credentialId: minted.credentialId, reason: "user_revoked", actorRole: "owner" });

  const stored = JSON.stringify([...issued, ...revoked]);
  assert.ok(!stored.includes(minted.apiKey), "the raw key is never stored");
  assert.ok(!stored.includes(minted.apiKey.slice(0, 14)), "nor its lookup prefix");
  assert.ok(!stored.includes("sk_agent_"));
});

async function withEnvValues<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("every audited credential mint records the same issuedVia as the credential row", async ({ app }) => withEnvValues({
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "issued-via-audit-test-pepper-0123456789",
  SLOCK_PROVIDER_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
}, async () => {
  const owner = await seedUser("audit-issued-via-owner");
  const server = await createServer("Issued via", `audit-issued-via-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, "audit-issued-via-agent", { runtime: "external" });
  const token = await login(app.baseUrl, owner.email);

  // A person's direct mint.
  const mint = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ scopes: ["read"] }),
  });
  assert.equal(mint.status, 201);
  const direct = await mint.json() as { credentialId: string };
  // A person's bootstrap token, exchanged.
  const bootstrap = await issueAgentBootstrapToken({ agentId: agent.id, serverId: server.id, issuedByUserId: owner.id, scopes: ["read"] });
  const exchanged = await consumeAgentBootstrapToken(bootstrap.rawToken);
  assert.ok(exchanged.ok);
  // A cloud runtime's provider-held credential.
  const hosted = await createAgent(server.id, "audit-issued-via-hosted", {
    runtime: "external",
    afterInsert: (tx, created) => recordAgentProvisioning(tx, { agent: created, provider: "antiproton", createdByUserId: owner.id }),
  });

  const issued = await eventsOf(server.id, "agent_credential.issued");
  const rows = await getDb().select().from(agentCredentials);
  const issuedViaOf = new Map(rows.map((row) => [row.id, row]));
  const byCredential = new Map(issued.map((event) => [event.targetId, event]));
  const expected: Array<[string, "human" | "provision", string | null]> = [
    [direct.credentialId, "human", owner.id],
    [exchanged.credentialId, "human", owner.id],
    [rows.find((row) => row.agentId === hosted.id)!.id, "provision", null],
  ];
  assert.equal(issued.length, expected.length, "one issued event per mint");
  for (const [credentialId, issuedVia, createdByUserId] of expected) {
    const event = byCredential.get(credentialId);
    assert.ok(event, `credential ${credentialId} is audited`);
    assert.equal((event.metadata as Record<string, unknown>).issuedVia, issuedVia);
    assert.equal(issuedViaOf.get(credentialId)?.issuedVia, issuedVia);
    assert.equal(issuedViaOf.get(credentialId)?.createdByUserId, createdByUserId);
  }
  assert.equal((byCredential.get(exchanged.credentialId)!.metadata as Record<string, unknown>).viaBootstrapToken, true);

  // Across every server: an issued event always names a live origin, and the one its credential row holds.
  const everyIssued = await getDb().select().from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.eventType, "agent_credential.issued"));
  assert.ok(everyIssued.length >= expected.length);
  for (const event of everyIssued) {
    const issuedVia = (event.metadata as Record<string, unknown>).issuedVia;
    assert.ok(typeof issuedVia === "string" && ["human", "provision", "computer", "app"].includes(issuedVia), `event ${event.id} issuedVia ${String(issuedVia)}`);
    assert.equal(issuedViaOf.get(event.targetId!)?.issuedVia, issuedVia, `event ${event.id} matches its credential row`);
  }
}));

test("machine key rotation and removal are audited without the key", async ({ app }) => {
  const owner = await seedUser("audit-machine-owner");
  const server = await createServer("Machines", `audit-machine-${randomUUID()}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "audit-machine");
  const token = await login(app.baseUrl, owner.email);

  const rotate = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/rotate-key`, {
    method: "POST",
    headers: headers(token, server.id),
  });
  assert.equal(rotate.status, 200);
  const { apiKey } = await rotate.json() as { apiKey: string };

  const remove = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`, {
    method: "DELETE",
    headers: headers(token, server.id),
  });
  assert.equal(remove.status, 200);

  const [rotated] = await eventsOf(server.id, "computer.key_rotated");
  const [removed] = await eventsOf(server.id, "computer.removed");
  for (const event of [rotated, removed]) {
    assert.ok(event);
    assert.equal(event.eventCategory, "computer");
    assert.equal(event.actorId, owner.id);
    assert.equal(event.targetType, "machine");
    assert.equal(event.targetId, machine.id);
    assert.equal(event.requesterType, "human");
    assert.equal(event.requesterId, owner.id, "the person who connected the machine");
    assert.deepEqual(event.metadata, { machineId: machine.id, machineName: "audit-machine", actorRole: "owner" });
  }
  assert.ok(!JSON.stringify([rotated, removed]).includes(apiKey));
});

test("GET /api/servers/:id/audit-events: owners read newest-first events; members are refused", async ({ app }) => {
  const owner = await seedUser("audit-read-owner");
  const member = await seedUser("audit-read-member");
  const server = await createServer("Read 1", `audit-read-${randomUUID()}`, owner.id);
  await addMember(server.id, member.id, "member");
  const ownerToken = await login(app.baseUrl, owner.email);
  for (const name of ["Read 2", "Read 3"]) {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 200);
  }
  await getDb().insert(integrationAuditEvents).values({
    serverId: server.id,
    eventType: "oauth.token_exchange_failed",
    eventCategory: "runtime",
    outcome: "failure",
    source: "api",
    actorType: "system",
    targetType: "app",
    requestId: "internal-request-id",
    metadata: { errorCode: "invalid_grant", requestIdHash: "hash" },
  });

  // A server-audit event can carry a requestIdHash too; it never leaves the server.
  await getDb().insert(integrationAuditEvents).values({
    serverId: server.id,
    eventType: "computer.removed",
    eventCategory: "computer",
    outcome: "success",
    source: "web",
    actorType: "human",
    actorId: owner.id,
    targetType: "machine",
    requestId: "internal-computer-request-id",
    metadata: { machineName: "gone", requestIdHash: "hash" },
  });

  const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/audit-events`, { headers: headers(ownerToken, server.id) });
  assert.equal(response.status, 200);
  const body = await response.json() as { events: Array<{ eventType: string; diff: unknown; metadata: Record<string, unknown> }>; nextCursor: string | null };
  assert.deepEqual(
    body.events.map((event) => event.eventType),
    ["computer.removed", "server.profile_updated", "server.profile_updated"],
    "integration-category events in the same server stay platform-admin only",
  );
  assert.equal(body.nextCursor, null, "everything fit on one page");
  assert.deepEqual(body.events[1]!.diff, { name: { before: "Read 2", after: "Read 3" } });
  assert.deepEqual(body.events[0]!.metadata, { machineName: "gone" }, "requestIdHash is stripped");
  assert.ok(!JSON.stringify(body).includes("internal-request-id"));
  assert.ok(!JSON.stringify(body).includes("internal-computer-request-id"));
  assert.ok(!JSON.stringify(body).includes("oauth.token_exchange_failed"));

  const limited = await fetch(`${app.baseUrl}/api/servers/${server.id}/audit-events?limit=1`, { headers: headers(ownerToken, server.id) });
  const limitedBody = await limited.json() as { events: unknown[]; nextCursor: string | null };
  assert.equal(limitedBody.events.length, 1);
  assert.equal(typeof limitedBody.nextCursor, "string");
  for (const garbage of ["not-a-cursor!", Buffer.from("2026-01-01T00:00:00Z|nope").toString("base64url"), "x"]) {
    const invalid = await fetch(`${app.baseUrl}/api/servers/${server.id}/audit-events?cursor=${encodeURIComponent(garbage)}`, { headers: headers(ownerToken, server.id) });
    assert.equal(invalid.status, 400, garbage);
  }

  const memberToken = await login(app.baseUrl, member.email);
  const refused = await fetch(`${app.baseUrl}/api/servers/${server.id}/audit-events`, { headers: headers(memberToken, server.id) });
  assert.equal(refused.status, 403);
});

test("a role the system gives an agent ends the authorization trail at the system, not at nothing", async ({ db: _db }) => {
  const owner = await getDb().insert(users).values({
    email: `audit-system-grant-${randomUUID()}@slock.test`,
    name: `audit-system-grant-${randomUUID().slice(0, 6)}`,
    displayName: "audit system grant",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning().then((rows) => rows[0]!);
  const server = await createServer("Audit system grant", `audit-system-grant-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, `asg-${randomUUID().slice(0, 6)}`, { runtime: "codex" });
  await grantOnboardingAgentRole(server.id, agent.id, "admin");
  // A re-link that changes nothing records nothing.
  await grantOnboardingAgentRole(server.id, agent.id, "admin");

  const grants = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.serverId, server.id),
    eq(integrationAuditEvents.eventType, "membership.agent_role_changed"),
  ));
  assert.equal(grants.length, 1);
  const event = grants[0]!;
  assert.equal(event.actorType, "system");
  assert.equal(event.targetId, agent.id);
  assert.deepEqual(event.metadata, { agentId: agent.id, previousRole: "member", nextRole: "admin", grantedBy: "onboarding_agent_created" });
});

test("paging returns every event exactly once when one transaction wrote more than a page", async ({ app }) => {
  const owner = await seedUser("audit-page-owner");
  const leaver = await seedUser("audit-page-leaver");
  const server = await createServer("Paging", `audit-page-${randomUUID()}`, owner.id);
  await addMember(server.id, leaver.id, "member");
  const agent = await createAgent(server.id, "audit-page-agent", { runtime: "external" });
  for (let i = 0; i < 6; i++) {
    await mintAgentCredential({ agentId: agent.id, scopes: ["read"], issuedVia: "human", createdByUserId: leaver.id, name: `page-${i}` });
  }
  // One transaction: membership.removed and six agent_credential.revoked share created_at.
  await removeMember(server.id, leaver.id, { reason: "removed", actorUserId: owner.id });
  const written = await getDb().select({ id: integrationAuditEvents.id, createdAt: integrationAuditEvents.createdAt })
    .from(integrationAuditEvents).where(and(eq(integrationAuditEvents.serverId, server.id), notInArray(integrationAuditEvents.eventType, [...SERVER_AUDIT_HIDDEN_EVENT_TYPES])));
  assert.equal(written.length, 7);
  assert.equal(new Set(written.map((row) => row.createdAt.getTime())).size, 1, "the rows share one created_at");

  const token = await login(app.baseUrl, owner.email);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const query: string = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : "limit=2";
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/audit-events?${query}`, { headers: headers(token, server.id) });
    assert.equal(response.status, 200);
    const body = await response.json() as { events: Array<{ id: string }>; nextCursor: string | null };
    seen.push(...body.events.map((event) => event.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null, "paging ends");
  assert.equal(seen.length, 7, "no event is skipped or repeated");
  assert.deepEqual([...seen].sort(), written.map((row) => row.id).sort());
});

test("archiving an agent records one agent_credential.revoked with the count", async ({ app }) => {
  const owner = await seedUser("audit-archive-owner");
  const server = await createServer("Archive", `audit-archive-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, "audit-archive-agent", { runtime: "external" });
  for (let i = 0; i < 3; i++) {
    await mintAgentCredential({ agentId: agent.id, scopes: ["read"], issuedVia: "human", createdByUserId: owner.id, name: `archive-${i}` });
  }
  const token = await login(app.baseUrl, owner.email);

  const response = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "DELETE", headers: headers(token, server.id) });
  assert.equal(response.status, 200, await response.clone().text());

  const revoked = await eventsOf(server.id, "agent_credential.revoked");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0]!.actorType, "human");
  assert.equal(revoked[0]!.actorId, owner.id);
  assert.equal(revoked[0]!.targetType, "agent");
  assert.equal(revoked[0]!.targetId, agent.id);
  const { operationId, ...revokedMetadata } = revoked[0]!.metadata as Record<string, unknown>;
  assert.deepEqual(revokedMetadata, { agentId: agent.id, revokedCount: 3, reason: "agent_archived", actorRole: "owner" });
  assert.equal(typeof operationId, "string");
});

type AuditPage = {
  events: Array<{ id: string; eventType: string; serverId: string; metadata: Record<string, unknown> }>;
  nextCursor: string | null;
  people: Record<string, { type: string; id: string; name: string; displayName: string | null; avatarUrl: string | null; deleted?: boolean }>;
};

async function readAuditPage(baseUrl: string, token: string, serverId: string, query = ""): Promise<{ status: number; body: AuditPage }> {
  const response = await fetch(`${baseUrl}/api/servers/${serverId}/audit-events${query ? `?${query}` : ""}`, { headers: headers(token, serverId) });
  return { status: response.status, body: await response.json() as AuditPage };
}

async function insertAuditEvent(serverId: string, values: {
  eventType: typeof integrationAuditEvents.$inferInsert["eventType"];
  eventCategory: typeof integrationAuditEvents.$inferInsert["eventCategory"];
  actorType: "human" | "agent" | "system";
  actorId?: string | null;
  createdAt: string;
}) {
  const [row] = await getDb().insert(integrationAuditEvents).values({
    serverId,
    eventType: values.eventType,
    eventCategory: values.eventCategory,
    outcome: "success",
    source: "web",
    actorType: values.actorType,
    actorId: values.actorId ?? null,
    targetType: "server",
    targetId: serverId,
    metadata: {},
    createdAt: new Date(values.createdAt),
  }).returning({ id: integrationAuditEvents.id });
  return row!.id;
}

test("GET audit-events filters by category, actor and time, pages with a cursor, and stays inside the server", async ({ app }) => {
  const owner = await seedUser("audit-filter-owner");
  const member = await seedUser("audit-filter-member");
  const server = await createServer("Filters", `audit-filter-${randomUUID()}`, owner.id);
  const other = await createServer("Filters other", `audit-filter-other-${randomUUID()}`, owner.id);
  await addMember(server.id, member.id, "member");
  // createServer writes no server-wide audit rows; these are the only ones.
  const roleChanged = await insertAuditEvent(server.id, { eventType: "membership.role_changed", eventCategory: "membership", actorType: "human", actorId: owner.id, createdAt: "2026-01-01T00:00:00Z" });
  const computerRemoved = await insertAuditEvent(server.id, { eventType: "computer.removed", eventCategory: "computer", actorType: "human", actorId: member.id, createdAt: "2026-01-02T00:00:00Z" });
  const systemRevoked = await insertAuditEvent(server.id, { eventType: "agent_credential.revoked", eventCategory: "agent_credential", actorType: "system", createdAt: "2026-01-03T00:00:00Z" });
  const memberRemoved = await insertAuditEvent(server.id, { eventType: "membership.removed", eventCategory: "membership", actorType: "human", actorId: owner.id, createdAt: "2026-01-04T00:00:00Z" });
  const renamed = await insertAuditEvent(server.id, { eventType: "server.profile_updated", eventCategory: "server_profile", actorType: "human", actorId: owner.id, createdAt: "2026-01-05T00:00:00Z" });
  // Same actor and category, other server: never in this server's results.
  const elsewhere = await insertAuditEvent(other.id, { eventType: "membership.removed", eventCategory: "membership", actorType: "human", actorId: owner.id, createdAt: "2026-01-04T00:00:00Z" });
  // Integration category in this server, same actor: platform-admin only, filters or not.
  const integration = await insertAuditEvent(server.id, { eventType: "oauth.lifecycle", eventCategory: "runtime", actorType: "human", actorId: owner.id, createdAt: "2026-01-04T12:00:00Z" });
  const token = await login(app.baseUrl, owner.email);

  const ids = async (query: string) => {
    const { status, body } = await readAuditPage(app.baseUrl, token, server.id, query);
    assert.equal(status, 200, query);
    for (const event of body.events) assert.equal(event.serverId, server.id, query);
    return body.events.map((event) => event.id);
  };
  assert.deepEqual(await ids(""), [renamed, memberRemoved, systemRevoked, computerRemoved, roleChanged]);
  assert.deepEqual(await ids("category=membership"), [memberRemoved, roleChanged]);
  assert.deepEqual(await ids("category=membership,computer"), [memberRemoved, computerRemoved, roleChanged]);
  assert.deepEqual(await ids("category=membership&category=computer"), [memberRemoved, computerRemoved, roleChanged], "repeated form");
  assert.deepEqual(await ids(`actorType=human&actorId=${owner.id}`), [renamed, memberRemoved, roleChanged]);
  assert.deepEqual(await ids(`actorType=human&actorId=${member.id}`), [computerRemoved]);
  assert.deepEqual(await ids("actorType=system"), [systemRevoked]);
  assert.deepEqual(
    await ids(`since=${encodeURIComponent("2026-01-02T00:00:00Z")}&until=${encodeURIComponent("2026-01-04T00:00:00Z")}`),
    [systemRevoked, computerRemoved],
    "since is inclusive, until exclusive",
  );
  assert.deepEqual(await ids(`since=${encodeURIComponent("2026-01-04T01:00:00+01:00")}`), [renamed, memberRemoved], "offsets are honored");

  // Combined filters page with the cursor and keep every filter on each page.
  const combined = `category=membership,server_profile&actorType=human&actorId=${owner.id}&since=${encodeURIComponent("2026-01-01T00:00:00Z")}`;
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const query: string = `${combined}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const { status, body } = await readAuditPage(app.baseUrl, token, server.id, query);
    assert.equal(status, 200);
    assert.ok(body.events.length <= 1);
    seen.push(...body.events.map((event) => event.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  assert.equal(cursor, null);
  assert.deepEqual(seen, [renamed, memberRemoved, roleChanged]);
  assert.ok(!seen.includes(elsewhere) && !seen.includes(integration));

  // The other server's own read sees only its event.
  assert.deepEqual((await readAuditPage(app.baseUrl, token, other.id, `actorType=human&actorId=${owner.id}`)).body.events.map((event) => event.id), [elsewhere]);

  for (const invalid of [
    "category=runtime",
    "category=bogus",
    "category=membership,bogus",
    "category=",
    "actorType=robot",
    `actorId=${owner.id}`,
    "actorType=human&actorId=not-a-uuid",
    `actorType=system&actorId=${owner.id}`,
    "since=yesterday",
    "since=2026-01-01",
    "since=2026-01-01T00:00:00",
    "until=2026-02-30T00:00:00Z",
    "until=2026-13-01T00:00:00Z",
    "actorType=human&actorType=agent",
  ]) {
    const { status } = await readAuditPage(app.baseUrl, token, server.id, invalid);
    assert.equal(status, 400, invalid);
  }
});

test("GET audit-events returns the people the page names, including a member who left and a deleted agent", async ({ app }) => {
  const owner = await seedUser("audit-people-owner");
  const leaver = await seedUser("audit-people-leaver");
  const server = await createServer("People", `audit-people-${randomUUID()}`, owner.id);
  await addMember(server.id, leaver.id, "member");
  const live = await createAgent(server.id, "audit-people-live", { runtime: "external" });
  const gone = await createAgent(server.id, "audit-people-gone", { runtime: "external" });
  await mintAgentCredential({ agentId: gone.id, scopes: ["read"], issuedVia: "human", createdByUserId: owner.id, name: "people" });
  const token = await login(app.baseUrl, owner.email);

  const promote = await fetch(`${app.baseUrl}/api/agents/${live.id}`, {
    method: "PATCH", headers: headers(token, server.id), body: JSON.stringify({ serverRole: "admin" }),
  });
  assert.equal(promote.status, 200, await promote.clone().text());
  const archive = await fetch(`${app.baseUrl}/api/agents/${gone.id}`, { method: "DELETE", headers: headers(token, server.id) });
  assert.equal(archive.status, 200, await archive.clone().text());
  const remove = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${leaver.id}`, { method: "DELETE", headers: headers(token, server.id) });
  assert.equal(remove.status, 200);

  const { status, body } = await readAuditPage(app.baseUrl, token, server.id);
  assert.equal(status, 200);
  assert.deepEqual(body.events.map((event) => event.eventType).sort(), ["agent_credential.revoked", "membership.agent_role_changed", "membership.removed"]);
  assert.deepEqual(Object.keys(body.people).sort(), [`agent:${gone.id}`, `agent:${live.id}`, `human:${leaver.id}`, `human:${owner.id}`].sort());
  assert.deepEqual(body.people[`human:${owner.id}`], { type: "human", id: owner.id, name: owner.name, displayName: owner.displayName, avatarUrl: null });
  assert.deepEqual(body.people[`human:${leaver.id}`], { type: "human", id: leaver.id, name: leaver.name, displayName: leaver.displayName, avatarUrl: null }, "a member who left still has a name");
  assert.deepEqual(body.people[`agent:${live.id}`], { type: "agent", id: live.id, name: live.name, displayName: live.displayName ?? null, avatarUrl: live.avatarUrl ?? null });
  assert.equal(body.people[`agent:${gone.id}`]!.name, gone.name);
  assert.equal(body.people[`agent:${gone.id}`]!.deleted, true, "a deleted agent keeps its name and is marked deleted");
  assert.ok(!JSON.stringify(body.people).includes("@slock.test"), "never an email");

  // A filtered page names only the people on it.
  const filtered = await readAuditPage(app.baseUrl, token, server.id, "category=membership&limit=1");
  assert.equal(filtered.body.events[0]!.eventType, "membership.removed");
  assert.deepEqual(Object.keys(filtered.body.people).sort(), [`human:${leaver.id}`, `human:${owner.id}`].sort());
});

test("one member removal shares an operationId across its events; each removal and leave records the actor's role", async ({ app }) => {
  const owner = await seedUser("audit-op-owner");
  const admin = await seedUser("audit-op-admin");
  const issuer = await seedUser("audit-op-issuer");
  const other = await seedUser("audit-op-other");
  const server = await createServer("Operations", `audit-op-${randomUUID()}`, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, issuer.id, "member");
  await addMember(server.id, other.id, "member");
  const agent = await createAgent(server.id, "audit-op-agent", { runtime: "external" });
  for (let i = 0; i < 3; i++) {
    await mintAgentCredential({ agentId: agent.id, scopes: ["read"], issuedVia: "human", createdByUserId: issuer.id, name: `op-${i}` });
  }
  const adminToken = await login(app.baseUrl, admin.email);
  const removed = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${issuer.id}`, { method: "DELETE", headers: headers(adminToken, server.id) });
  assert.equal(removed.status, 200);

  const rows = await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.serverId, server.id), notInArray(integrationAuditEvents.eventType, [...SERVER_AUDIT_HIDDEN_EVENT_TYPES])));
  assert.deepEqual(rows.map((row) => row.eventType).sort(), ["agent_credential.revoked", "agent_credential.revoked", "agent_credential.revoked", "membership.removed"]);
  const operationIds = new Set(rows.map((row) => (row.metadata as Record<string, unknown>).operationId));
  assert.equal(operationIds.size, 1, "membership.removed and every revoke share one operationId");
  assert.match(String([...operationIds][0]), /^[0-9a-f-]{36}$/);
  for (const row of rows) {
    assert.equal((row.metadata as Record<string, unknown>).actorRole, "admin", `${row.eventType} records the admin's role`);
  }

  // A member who leaves acts with the role they leave; a separate operation.
  const otherToken = await login(app.baseUrl, other.email);
  const left = await fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, { method: "POST", headers: headers(otherToken, server.id) });
  assert.equal(left.status, 200);
  const [leftEvent] = (await eventsOf(server.id, "membership.removed")).filter((row) => row.targetId === other.id);
  assert.ok(leftEvent);
  const leftMetadata = leftEvent.metadata as Record<string, unknown>;
  assert.equal(leftMetadata.reason, "left");
  assert.equal(leftMetadata.actorRole, "member");
  assert.ok(leftMetadata.operationId && !operationIds.has(leftMetadata.operationId), "another operation, another id");

  // A system removal (no actor) records no role.
  await removeMember(server.id, admin.id, { reason: "removed" });
  const [systemEvent] = (await eventsOf(server.id, "membership.removed")).filter((row) => row.targetId === admin.id);
  assert.equal(systemEvent!.actorType, "system");
  assert.equal((systemEvent!.metadata as Record<string, unknown>).actorRole, undefined);
});
