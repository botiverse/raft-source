import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
// POST /internal/agent-api/credentials/self/revoke: the holder of an sk_agent_*
// key revokes that key and nothing else. Person-minted keys only; a runner
// (or cloud-runtime) key is refused and stays live; no other principal reaches it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, computers, integrationAuditEvents, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { subscribeAgentCredentialRevocation } from "../services/agentCredentialRevocationBus";

const test = createApiTest();

const SELF_REVOKE = "/internal/agent-api/credentials/self/revoke";

async function seedFixture() {
  const suffix = randomUUID();
  const email = `self-revoke-${suffix}@slock.test`;
  const [owner] = await getDb().insert(users).values({
    email,
    name: `self-revoke-${suffix}`,
    displayName: "Self Revoke Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Self Revoke", `self-revoke-${suffix}`, owner!.id);
  const { machine } = await registerMachine(server.id, owner!.id, "self-revoke-machine");
  const external = await createAgent(server.id, "SelfRevokeExt", { runtime: "external", model: "external" });
  const managed = await createAgent(server.id, "SelfRevokeRunner", { runtime: "claude", model: "sonnet", machineId: machine.id });
  const computerMaterial = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "self-revoke-computer",
    apiKeyHash: computerMaterial.apiKeyHash,
    apiKeyPrefix: computerMaterial.apiKeyPrefix,
    attachedByUserId: owner!.id,
    machineId: machine.id,
  });
  return {
    ownerId: owner!.id,
    ownerToken: await tokenForHuman(email),
    serverId: server.id,
    machineId: machine.id,
    externalId: external.id,
    managedId: managed.id,
    computerApiKey: computerMaterial.apiKey,
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function mintHuman(f: Fixture, name: string) {
  return mintAgentCredential({ agentId: f.externalId, scopes: ["read", "send"], issuedVia: "human", createdByUserId: f.ownerId, name });
}

function mintRunner(f: Fixture) {
  return mintAgentCredential({ agentId: f.managedId, scopes: ["read", "send"], issuedVia: "computer", createdByUserId: null, issuedByMachineId: f.machineId, name: "runner:self-revoke" });
}

function selfRevoke(baseUrl: string, bearer?: string) {
  return fetch(`${baseUrl}${SELF_REVOKE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: "{}",
  });
}

function whoami(baseUrl: string, apiKey: string) {
  return fetch(`${baseUrl}/internal/agent-api`, { headers: { Authorization: `Bearer ${apiKey}` } });
}

async function credentialRow(id: string) {
  const [row] = await getDb().select({
    revokedAt: agentCredentials.revokedAt,
    revokedReason: agentCredentials.revokedReason,
    revokedByUserId: agentCredentials.revokedByUserId,
  }).from(agentCredentials).where(eq(agentCredentials.id, id));
  return row!;
}

function revokedAuditEvents(credentialId: string) {
  return getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "agent_credential.revoked"),
    eq(integrationAuditEvents.targetId, credentialId),
  ));
}

test("a live person-minted key revokes itself: 200, then 401 everywhere; the agent's other key stays live", async ({ app }) => {
  const f = await seedFixture();
  const key = await mintHuman(f, "laptop");
  const sibling = await mintHuman(f, "desktop");
  let broadcasts = 0;
  const unsubscribe = subscribeAgentCredentialRevocation(f.externalId, () => { broadcasts += 1; });
  try {
    assert.equal((await whoami(app.baseUrl, key.apiKey)).status, 200, "precondition: the key is live");

    const res = await selfRevoke(app.baseUrl, key.apiKey);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { revoked: true, credentialId: key.credentialId });
    assert.equal(broadcasts, 1, "the revocation is broadcast so open streams close now");

    const row = await credentialRow(key.credentialId);
    assert.ok(row.revokedAt, "revoked");
    assert.equal(row.revokedReason, "self_revoked");
    assert.equal(row.revokedByUserId, null, "no person revoked it");

    // The same key is now refused like any revoked key, including a repeat.
    assert.equal((await whoami(app.baseUrl, key.apiKey)).status, 401);
    assert.equal((await selfRevoke(app.baseUrl, key.apiKey)).status, 401);
    assert.equal((await fetch(`${app.baseUrl}/internal/agent-api/history?channel=%23general`, { headers: { Authorization: `Bearer ${key.apiKey}` } })).status, 401);

    // Only the authenticating credential: the sibling is untouched and works.
    assert.equal((await credentialRow(sibling.credentialId)).revokedAt, null);
    const siblingWhoami = await whoami(app.baseUrl, sibling.apiKey);
    assert.equal(siblingWhoami.status, 200);
    assert.equal(((await siblingWhoami.json()) as { credentialId: string }).credentialId, sibling.credentialId);
  } finally {
    unsubscribe();
  }
});

test("self-revoke records one agent_credential.revoked audit event, reason self_revoked, with no key material", async ({ app }) => {
  const f = await seedFixture();
  const key = await mintHuman(f, "audited");
  assert.equal((await selfRevoke(app.baseUrl, key.apiKey)).status, 200);

  const events = await revokedAuditEvents(key.credentialId);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event!.serverId, f.serverId);
  assert.equal(event!.outcome, "success");
  assert.equal(event!.source, "api");
  assert.equal(event!.actorType, "agent");
  assert.equal(event!.actorId, f.externalId);
  assert.equal(event!.subjectId, f.externalId);
  assert.equal(event!.targetType, "agent_credential");
  assert.deepEqual(event!.metadata, { agentId: f.externalId, credentialId: key.credentialId, reason: "self_revoked" });
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes(key.apiKey), "never the key");
  assert.ok(!serialized.includes(key.apiKey.slice(0, 16)), "never its prefix");
});

test("a Computer's runner key (issued_via computer, runner:*) and a cloud runtime's key are refused 403 and stay live", async ({ app }) => {
  const f = await seedFixture();
  const runner = await mintRunner(f);
  const provision = await mintAgentCredential({ agentId: f.externalId, scopes: ["read"], issuedVia: "provision", createdByUserId: null, name: "provision" });
  for (const key of [runner, provision]) {
    const res = await selfRevoke(app.baseUrl, key.apiKey);
    assert.equal(res.status, 403, key.credentialId);
    assert.equal(((await res.json()) as { code: string }).code, "credential_not_self_revocable");
    assert.equal((await credentialRow(key.credentialId)).revokedAt, null, "still live in the database");
    assert.equal((await whoami(app.baseUrl, key.apiKey)).status, 200, "still authenticates");
    assert.equal((await revokedAuditEvents(key.credentialId)).length, 0, "nothing recorded");
  }
});

test("no auth, a person's session and a Computer key cannot reach it; nothing is revoked", async ({ app }) => {
  const f = await seedFixture();
  const key = await mintHuman(f, "bystander");
  const runner = await mintRunner(f);
  for (const bearer of [undefined, f.ownerToken, f.computerApiKey, "sk_agent_not-a-real-key"]) {
    const res = await selfRevoke(app.baseUrl, bearer);
    assert.equal(res.status, 401, `bearer ${bearer?.slice(0, 12) ?? "(none)"}`);
  }
  for (const id of [key.credentialId, runner.credentialId]) {
    assert.equal((await credentialRow(id)).revokedAt, null, "nothing revoked");
    assert.equal((await revokedAuditEvents(id)).length, 0);
  }
  assert.equal((await whoami(app.baseUrl, key.apiKey)).status, 200);
});
