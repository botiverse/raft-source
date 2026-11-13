import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// `GET /api/agents/:id/external-diagnostics`: the facts that make an external
// agent debuggable (presence, reported status, push webhook, cursor pulls,
// provisioning, account connections), owner/admin or creator only, and no
// secrets (the push endpoint is reduced to its host).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { EXTERNAL_AGENT_ONLINE_WINDOW_MS, type ExternalAgentDiagnosticsView } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agentInboxEventsPendingAcks, agentRuntimeProvisions, agents, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential, recordAgentCredentialUse } from "../services/agentCredentialService";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 7));

const PUSH_SECRET = "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x";
const PUSH_URL = "https://receiver.example.com/raft/inbox?token=path-secret-123";

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function seed() {
  const owner = await seedUser("ext-diag-owner");
  const member = await seedUser("ext-diag-member");
  const server = await createServer("External Diagnostics", `ext-diag-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const external = await createAgent(server.id, `ExtDiag${randomUUID().slice(0, 6)}`, { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: external.id, scopes: ["send", "read"], name: "ext-diag", issuedVia: "human", createdByUserId: owner.id });
  return { owner, member, server, external, minted };
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

async function getDiagnostics(baseUrl: string, agentId: string, token: string, serverId: string) {
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/external-diagnostics`, { headers: headers(token, serverId) });
  const raw = await res.text();
  return { status: res.status, raw, body: raw ? JSON.parse(raw) : null };
}

test("external diagnostics: presence, status, push, cursor pulls and connections, without secrets", async ({ app }) => {
  const f = await seed();
  const ownerToken = await tokenForHuman(f.owner.email);

  await recordAgentCredentialUse({ credentialId: f.minted.credentialId, ip: null, userAgent: null });
  const pushRes = await fetch(`${app.baseUrl}/internal/agent-api/push-webhook`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${f.minted.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ url: PUSH_URL, secret: PUSH_SECRET }),
  });
  assert.equal(pushRes.status, 200, await pushRes.text());
  const adoptedAt = new Date("2026-09-01T10:00:00.000Z");
  await getDb().update(agents).set({ statusProtocolAdoptedAt: adoptedAt }).where(eq(agents.id, f.external.id));
  const pulledAt = new Date("2026-09-02T11:00:00.000Z");
  await getDb().insert(agentInboxEventsPendingAcks).values({ agentId: f.external.id, seqs: [4, 5, 9], updatedAt: pulledAt });

  const res = await getDiagnostics(app.baseUrl, f.external.id, ownerToken, f.server.id);
  assert.equal(res.status, 200, res.raw);
  const view = res.body as ExternalAgentDiagnosticsView;
  assert.equal(view.agentId, f.external.id);
  assert.equal(view.runtime, "external");
  assert.equal(view.provider, null, "self-run external agent has no provider");
  assert.equal(typeof view.presence.lastSeenAt, "string");
  assert.equal(view.presence.online, true);
  assert.equal(view.presence.onlineWindowMs, EXTERNAL_AGENT_ONLINE_WINDOW_MS);
  assert.equal(typeof view.status.activity, "string");
  assert.equal(view.status.statusProtocolAdoptedAt, adoptedAt.toISOString());
  assert.deepEqual(
    { registered: view.push.registered, enabled: view.push.enabled, endpointHost: view.push.endpointHost, consecutiveFailures: view.push.consecutiveFailures, lastDeliveryAt: view.push.lastDeliveryAt },
    { registered: true, enabled: true, endpointHost: "receiver.example.com", consecutiveFailures: 0, lastDeliveryAt: null },
  );
  assert.deepEqual(view.events, { lastCursorPullAt: pulledAt.toISOString(), pendingCursorAckCount: 3 });
  assert.deepEqual(view.connections, [{ provider: "github", state: "not_applicable", account: null, reason: null }]);

  assert.ok(!res.raw.includes("/raft/inbox") && !res.raw.includes("path-secret-123"), "push URL reduced to its host");
  assert.ok(!res.raw.includes(PUSH_SECRET), "no push signing secret");
  assert.ok(!res.raw.includes(f.minted.apiKey) && !res.raw.includes("sk_agent_"), "no agent credential");
  assert.equal(res.body.secretCiphertext, undefined);
});

test("external diagnostics: provider-backed agent reports provisioning and a graceful connection state", async ({ app }) => {
  const f = await seed();
  const ownerToken = await tokenForHuman(f.owner.email);
  await getDb().insert(agentRuntimeProvisions).values({
    agentId: f.external.id,
    serverId: f.server.id,
    provider: "antiproton",
    state: "active",
    providerAgentId: "ap_agent_1",
    credentialId: f.minted.credentialId,
    encryptedCredential: null,
    provisionedName: "ext",
    provisionedInstructions: "",
    activatedAt: new Date("2026-09-03T00:00:00.000Z"),
  });

  const res = await getDiagnostics(app.baseUrl, f.external.id, ownerToken, f.server.id);
  assert.equal(res.status, 200, res.raw);
  const view = res.body as ExternalAgentDiagnosticsView;
  assert.deepEqual(view.provider, {
    kind: "antiproton",
    state: "active",
    providerAgentId: "ap_agent_1",
    syncPending: false,
    lastErrorCode: null,
    lastErrorAt: null,
    activatedAt: "2026-09-03T00:00:00.000Z",
  });
  assert.equal(view.presence.lastSeenAt, null);
  assert.equal(view.presence.online, false);
  assert.deepEqual(view.push, {
    registered: false, enabled: false, endpointHost: null, disabledReason: null, disabledAt: null,
    consecutiveFailures: 0, lastAttemptAt: null, lastDeliveryAt: null, lastError: null, nextAttemptAt: null,
    probeStoppedAt: null, recovery: null,
  });
  assert.deepEqual(view.events, { lastCursorPullAt: null, pendingCursorAckCount: 0 });
  // The provider feature flag is off on this server: reported, not thrown.
  assert.equal(view.connections.length, 1);
  assert.equal(view.connections[0]!.provider, "github");
  assert.equal(view.connections[0]!.state, "unavailable");
  assert.equal(typeof view.connections[0]!.reason, "string");
});

test("external diagnostics: members who are not the creator are refused; managed agents are not external", async ({ app }) => {
  const f = await seed();
  const memberToken = await tokenForHuman(f.member.email);
  const ownerToken = await tokenForHuman(f.owner.email);
  const refused = await getDiagnostics(app.baseUrl, f.external.id, memberToken, f.server.id);
  assert.equal(refused.status, 403);

  const managed = await createAgent(f.server.id, `ManagedDiag${randomUUID().slice(0, 6)}`, { runtime: "codex" });
  const notExternal = await getDiagnostics(app.baseUrl, managed.id, ownerToken, f.server.id);
  assert.equal(notExternal.status, 400);
  assert.equal(notExternal.body.code, "agent_not_external");

  const missing = await getDiagnostics(app.baseUrl, randomUUID(), ownerToken, f.server.id);
  assert.equal(missing.status, 404);
});
