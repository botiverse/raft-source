import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { oauthAccessRequests, oauthClients, oauthGrants } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { approveAccessRequest, createOAuthClient, exchangeAccessRequest, requestAgentAccess, revokeGrant, AGENT_REQUEST_CODE_TTL_MS } from "../services/oauthService";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";

const test = createApiTest();
const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

test("registered protocol is legacy by default and login reads the server-owned value", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: unique("handoff"), name: "Handoff fixture", returnUrl: "https://app.example.test/callback" });
  const { client: other } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: unique("other"), name: "Other fixture", returnUrl: "https://other.example.test/callback" });
  const [stored] = await getDb().select({ protocol: oauthClients.agentHandoffProtocol }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(stored?.protocol, "legacy");
  const agent = await createAgent(server.id, unique("handoff"), { runtime: "codex" });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "test", issuedVia: "computer", createdByUserId: null });
  const login = async (service: string) => {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ service, agentHandoffChallenge: "A".repeat(43) }),
    });
    assert.equal(response.status, 200);
    return await response.json() as { agentHandoffProtocol?: string };
  };
  assert.equal((await login(client.clientId)).agentHandoffProtocol, "legacy");
  const humanToken = await tokenForHuman(owner.email);
  const patch = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${humanToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Updated fixture", agentHandoffProtocol: "v1" }),
  });
  assert.equal(patch.status, 200);
  assert.equal((await login(client.clientId)).agentHandoffProtocol, "legacy", "an App owner cannot opt in via the ordinary edit API");
  await getDb().update(oauthClients).set({ agentHandoffProtocol: "v1" }).where(eq(oauthClients.id, client.id));
  assert.equal((await login(client.clientId)).agentHandoffProtocol, "v1");
  assert.equal((await login(other.clientId)).agentHandoffProtocol, "legacy");
  await assert.rejects(getDb().execute(sql`UPDATE oauth_clients SET agent_handoff_protocol='legacy' WHERE id=${client.id}`), (error: { cause?: { code?: string; message?: string } }) => error.cause?.code === "23514" && /cannot be downgraded/.test(error.cause.message ?? ""));
  await assert.rejects(getDb().execute(sql`UPDATE oauth_clients SET agent_handoff_protocol='bogus' WHERE id=${other.id}`), (error: { cause?: { code?: string; constraint?: string } }) => error.cause?.code === "23514" && error.cause.constraint === "oauth_clients_agent_handoff_protocol_valid");
});

test("a public approval ID cannot be redeemed without its independent v1 verifier", async ({ app, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: unique("proof"), name: "Proof fixture", returnUrl: "https://app.example.test/callback" });
  await getDb().update(oauthClients).set({ agentHandoffProtocol: "v1" }).where(eq(oauthClients.id, client.id));
  const agent = await createAgent(server.id, unique("proof"), { runtime: "codex" });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const [request] = await getDb().insert(oauthAccessRequests).values({ serverId: server.id, agentId: agent.id, clientId: client.id, principalType: "agent", scopes: [], status: "approved", remember: false, resolvedAt: new Date(), agentHandoffChallenge: challenge }).returning();
  for (const grantType of ["authorization_code", "urn:slock:grant-type:agent_request"]) {
    for (const proof of [undefined, randomBytes(32).toString("base64url")]) {
      const payload = grantType === "authorization_code" ? { grant_type: grantType, code: request!.id } : { grantType, requestId: request!.id };
      const response = await fetch(`${app.baseUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, clientId: client.clientId, clientSecret, agent_handoff_verifier: proof }) });
      assert.ok([400, 404].includes(response.status), `missing or wrong verifier refused for ${grantType}`);
    }
  }
  const success = await fetch(`${app.baseUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: request!.id, clientId: client.clientId, clientSecret, agent_handoff_verifier: verifier }) });
  assert.equal(success.status, 200, await success.clone().text());
});

test("only the requesting Agent can resume its approved request with the original challenge", async ({ app, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: unique("resume"), name: "Resume fixture", returnUrl: "https://app.example.test/callback" });
  await getDb().update(oauthClients).set({ agentHandoffProtocol: "v1" }).where(eq(oauthClients.id, client.id));
  const agent = await createAgent(server.id, unique("requester"), { runtime: "codex" });
  const other = await createAgent(server.id, unique("observer"), { runtime: "codex" });
  const requesterCredential = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "test", issuedVia: "computer", createdByUserId: null });
  const observerCredential = await mintAgentCredential({ agentId: other.id, scopes: ["read", "send"], name: "test", issuedVia: "computer", createdByUserId: null });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const [request] = await getDb().insert(oauthAccessRequests).values({ serverId: server.id, agentId: agent.id, clientId: client.id, principalType: "agent", scopes: ["identity"], status: "pending", remember: false, agentHandoffChallenge: challenge }).returning();
  await approveAccessRequest({ serverId: server.id, requestId: request!.id, resolvedByUserId: owner.id, remember: false });
  const login = (token: string, suppliedChallenge: string) => fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ service: client.clientId, scopes: ["identity"], resumeRequestId: request!.id, agentHandoffChallenge: suppliedChallenge }),
  });
  assert.notEqual((await login(observerCredential.apiKey, challenge)).status, 200);
  assert.notEqual((await login(requesterCredential.apiKey, "A".repeat(43))).status, 200);
  const response = await login(requesterCredential.apiKey, challenge);
  assert.equal(response.status, 200, await response.clone().text());
  const resumed = await response.json() as { status: string; requestId: string };
  assert.equal(resumed.status, "already_logged_in");
  assert.equal(resumed.requestId, request!.id);
});

test("a pending v1 request reuses only a grant covering its full original scope", async ({ seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: unique("standing"), name: "Standing fixture", returnUrl: "https://app.example.test/callback", allowedScopes: ["identity", "profile"] });
  await getDb().update(oauthClients).set({ agentHandoffProtocol: "v1" }).where(eq(oauthClients.id, client.id));
  const agent = await createAgent(server.id, unique("standing"), { runtime: "codex" });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const [request] = await getDb().insert(oauthAccessRequests).values({ serverId: server.id, agentId: agent.id, clientId: client.id, scopes: ["identity", "profile"], status: "pending", remember: false, agentHandoffChallenge: challenge }).returning();
  const [grant] = await getDb().insert(oauthGrants).values({ serverId: server.id, agentId: agent.id, clientId: client.id, scopes: ["identity"], grantedByUserId: owner.id }).returning();
  const resume = () => requestAgentAccess({ serverSlug: server.slug, agentId: agent.id, clientId: client.id, scopes: ["identity"], initiatedByAgent: true, agentHandoffChallenge: challenge, resumeRequestId: request!.id });
  assert.equal((await resume()).status, "pending", "a narrow grant cannot approve the original wider request");
  await getDb().update(oauthGrants).set({ scopes: ["identity", "profile"] }).where(eq(oauthGrants.id, grant!.id));
  const approved = await resume();
  assert.equal(approved.status, "approved");
  assert.equal(approved.request!.remember, true);
  await revokeGrant({ serverId: server.id, grantId: grant!.id, revokedByUserId: owner.id });
  await getDb().insert(oauthGrants).values({ serverId: server.id, agentId: agent.id, clientId: client.id, scopes: ["identity"], grantedByUserId: owner.id });
  await assert.rejects(exchangeAccessRequest({ clientId: client.id, requestId: request!.id, codeVerifier: verifier }), /access_denied/, "the grant is checked again at redemption");
});

test("Agent codes expire ten minutes after approval, not after requesting", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: unique("expiry"), name: "Expiry fixture", returnUrl: "https://app.example.test/callback" });
  const agent = await createAgent(server.id, unique("expiry"), { runtime: "codex" });
  const now = new Date();
  const longWait = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const insert = async (status: "pending" | "approved", resolvedAt: Date | null) => {
    const [row] = await getDb().insert(oauthAccessRequests).values({ serverId: server.id, agentId: agent.id, clientId: client.id, principalType: "agent", scopes: [], status, remember: false, createdAt: longWait, resolvedAt }).returning();
    return row!;
  };
  const recentlyApproved = await insert("approved", now);
  const boundary = await insert("approved", new Date(now.getTime() - AGENT_REQUEST_CODE_TTL_MS));
  const expired = await insert("approved", new Date(now.getTime() - AGENT_REQUEST_CODE_TTL_MS - 1));
  const missingApprovalTime = await insert("approved", null);
  const pending = await insert("pending", null);
  await exchangeAccessRequest({ clientId: client.id, requestId: recentlyApproved.id, now });
  await assert.rejects(exchangeAccessRequest({ clientId: client.id, requestId: boundary.id, now }), /agent_request_expired/);
  await assert.rejects(exchangeAccessRequest({ clientId: client.id, requestId: expired.id, now }), /agent_request_expired/);
  await assert.rejects(exchangeAccessRequest({ clientId: client.id, requestId: missingApprovalTime.id, now }), /agent_request_expired/);
  await assert.rejects(exchangeAccessRequest({ clientId: client.id, requestId: pending.id, now }), /authorization_pending/);
  await assert.rejects(exchangeAccessRequest({ clientId: client.id, requestId: recentlyApproved.id, now }), /request_already_consumed/);
  for (const request of [boundary, expired, missingApprovalTime, pending]) {
    const [row] = await getDb().select({ consumedAt: oauthAccessRequests.consumedAt }).from(oauthAccessRequests).where(eq(oauthAccessRequests.id, request.id));
    assert.equal(row?.consumedAt, null, "a refused code is not consumed");
  }
  const response = await fetch(`${app.baseUrl}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, clientSecret, grantType: "urn:slock:grant-type:agent_request", requestId: expired.id }) });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; error_description: string; next_action: string };
  assert.equal(body.error, "agent_request_expired");
  assert.equal(body.next_action, "obtain_fresh_request");
  assert.doesNotMatch(body.error_description, /human authorization/i);
});
