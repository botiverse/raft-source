import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentBootstrapTokens, agentCredentials, agentRuntimeProvisions, integrationAuditEvents, serverMembers, users } from "../db/schema";
import { createAgent } from "./agentService";
import {
  consumeAgentBootstrapToken,
  ISSUER_LEFT_SERVER_REVOKE_REASON,
  issueAgentBootstrapToken,
  mintAgentCredential,
} from "./agentCredentialService";
import { createServer, removeMember } from "./serverService";

// #wg-rbac B12: leaving a server takes back the Agent credentials a person
// issued there, whichever way they were issued, and nothing else.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

const PEPPER = "revoke-issued-credentials-test-pepper-0123456789";

async function withBootstrapPepper<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = PEPPER;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = prev;
  }
}

async function credential(id: string) {
  const [row] = await getDb().select().from(agentCredentials).where(eq(agentCredentials.id, id));
  return row;
}

test("removing a member revokes the Agent credentials they issued in that server, and only those", async ({ db }) => withBootstrapPepper(async () => {
  void db;
  const owner = await seedUser("revoke-issued-owner");
  const leaver = await seedUser("revoke-issued-leaver");
  const server = await createServer("Revoke issued", `revoke-issued-${randomUUID()}`, owner.id);
  const otherServer = await createServer("Revoke issued other", `revoke-issued-other-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: leaver.id, role: "member" },
    { serverId: otherServer.id, userId: leaver.id, role: "member" },
  ]);
  const agent = await createAgent(server.id, "revoke-issued-agent", { runtime: "external" });
  const otherAgent = await createAgent(otherServer.id, "revoke-issued-other-agent", { runtime: "external" });

  // 1. Minted directly by the leaver.
  const direct = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], issuedVia: "human", createdByUserId: leaver.id, name: "direct" });
  // 2. Exchanged from a bootstrap token the leaver issued (the token's issuer is the credential's).
  const issued = await issueAgentBootstrapToken({ agentId: agent.id, serverId: server.id, issuedByUserId: leaver.id, scopes: ["read"] });
  const exchanged = await consumeAgentBootstrapToken(issued.rawToken);
  assert.ok(exchanged.ok);
  const exchangedCredentialId = exchanged.credentialId;
  const exchangedRow = await credential(exchangedCredentialId);
  assert.equal(exchangedRow?.issuedVia, "human");
  assert.equal(exchangedRow?.createdByUserId, leaver.id, "the exchange records the token's issuer");
  // 2b. Exchanged before the exchange recorded the token's issuer (no issuer,
  //     issued_via not yet backfilled): still found through the token.
  const legacyIssued = await issueAgentBootstrapToken({ agentId: agent.id, serverId: server.id, issuedByUserId: leaver.id, scopes: ["read"] });
  const legacyExchanged = await consumeAgentBootstrapToken(legacyIssued.rawToken);
  assert.ok(legacyExchanged.ok);
  const legacyExchangedCredentialId = legacyExchanged.credentialId;
  await getDb().update(agentCredentials)
    .set({ createdByUserId: null, issuedVia: null })
    .where(eq(agentCredentials.id, legacyExchangedCredentialId));
  // 3. An unconsumed bootstrap token the leaver issued.
  const pending = await issueAgentBootstrapToken({ agentId: agent.id, serverId: server.id, issuedByUserId: leaver.id, scopes: ["read"] });
  // Untouched: a Computer-minted runner credential (no human issuer), another person's
  // credential, and the leaver's own credential in a server they still belong to.
  const computerMinted = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], issuedVia: "computer", createdByUserId: null, name: "computer" });
  const ownersOwn = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], issuedVia: "human", createdByUserId: owner.id, name: "owner" });
  const elsewhere = await mintAgentCredential({ agentId: otherAgent.id, scopes: ["read"], issuedVia: "human", createdByUserId: leaver.id, name: "elsewhere" });
  // A cloud runtime's credential: minted under the leaver's authority but held
  // by the provider (no person saw the key), so the departure must not stop it.
  const hostedAgent = await createAgent(server.id, "revoke-issued-hosted-agent", { runtime: "external" });
  const providerHeld = await mintAgentCredential({ agentId: hostedAgent.id, scopes: ["read"], issuedVia: "provision", createdByUserId: null, name: "Cloud runtime" });
  await getDb().insert(agentRuntimeProvisions).values({
    agentId: hostedAgent.id,
    serverId: server.id,
    provider: "antiproton",
    state: "active",
    credentialId: providerHeld.credentialId,
    provisionedName: "revoke-issued-hosted-agent",
    provisionedInstructions: "",
  });

  // Rollout window: an older server build minted a cloud runtime's credential
  // with its creator as issuer, and the insert trigger classed it 'human'. The
  // provision link still keeps it from being revoked.
  const rolloutHostedAgent = await createAgent(server.id, "revoke-rollout-hosted", { runtime: "external" });
  const rolloutProviderHeld = await mintAgentCredential({ agentId: rolloutHostedAgent.id, scopes: ["read"], issuedVia: "human", createdByUserId: leaver.id, name: "Cloud runtime" });
  await getDb().insert(agentRuntimeProvisions).values({
    agentId: rolloutHostedAgent.id,
    serverId: server.id,
    provider: "antiproton",
    state: "active",
    credentialId: rolloutProviderHeld.credentialId,
    provisionedName: "revoke-rollout-hosted",
    provisionedInstructions: "",
  });
  const rolloutRow = await credential(rolloutProviderHeld.credentialId);
  assert.equal(rolloutRow?.issuedVia, "human");
  assert.equal(rolloutRow?.createdByUserId, leaver.id);

  await removeMember(server.id, leaver.id, { reason: "removed", actorUserId: owner.id });

  for (const id of [direct.credentialId, exchangedCredentialId, legacyExchangedCredentialId]) {
    const row = await credential(id);
    assert.ok(row?.revokedAt, `credential ${id} is revoked`);
    assert.equal(row?.revokedReason, ISSUER_LEFT_SERVER_REVOKE_REASON);
  }
  const [pendingRow] = await getDb().select().from(agentBootstrapTokens).where(eq(agentBootstrapTokens.id, pending.tokenId));
  assert.ok(pendingRow?.revokedAt, "the unconsumed bootstrap token is revoked");
  assert.equal((await consumeAgentBootstrapToken(pending.rawToken)).ok, false, "and can no longer be exchanged");

  for (const id of [computerMinted.credentialId, ownersOwn.credentialId, elsewhere.credentialId, providerHeld.credentialId, rolloutProviderHeld.credentialId]) {
    assert.equal((await credential(id))?.revokedAt ?? null, null, `credential ${id} stays active`);
  }

  const auditRows = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.serverId, server.id));
  const removed = auditRows.find((row) => row.eventType === "membership.removed");
  assert.equal((removed?.metadata as Record<string, unknown>)?.revokedAgentCredentialCount, 3);
  const revokedIds = auditRows
    .filter((row) => row.eventType === "agent_credential.revoked")
    .map((row) => row.targetId)
    .sort();
  assert.deepEqual(revokedIds, [direct.credentialId, exchangedCredentialId, legacyExchangedCredentialId].sort());

  // The exchange is audited in its own commit, with the token's issuer as the authorizing human.
  const exchangeIssued = auditRows.find((row) => row.eventType === "agent_credential.issued" && row.targetId === exchangedCredentialId);
  assert.ok(exchangeIssued, "the bootstrap exchange records agent_credential.issued");
  assert.equal(exchangeIssued.actorType, "system");
  assert.equal(exchangeIssued.requesterType, "human");
  assert.equal(exchangeIssued.requesterId, leaver.id);
  assert.deepEqual(exchangeIssued.metadata, {
    agentId: agent.id,
    credentialId: exchangedCredentialId,
    scopes: ["read"],
    issuedVia: "human",
    viaBootstrapToken: true,
    bootstrapTokenId: issued.tokenId,
  });
  assert.ok(!JSON.stringify(auditRows).includes(issued.rawToken), "never the token");
}));
