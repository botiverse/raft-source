import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentJwtIssuanceCounter } from "../metrics";
import { getDb } from "../db/index";
import { users, oauthClients, oauthClientInstalls, integrationAuditEvents } from "../db/schema";
import { createOAuthClient, createOAuthClientShareLink, installOAuthClientShareInvite } from "../services/oauthService";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { createServer, addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("Agent JWT is built in: no App or installation setting, same availability boundary as Agent Login", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const seedUser = async (label: string) => {
      const suffix = randomUUID();
      const [user] = await getDb().insert(users).values({ name: `jwt-${label}-${suffix}`, email: `${suffix}@raft.test`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date() }).returning();
      return { ...user, token: await tokenForHuman(user.email) };
    };
    const owner = await seedUser("owner");
    const installer = await seedUser("installer");
    const member = await seedUser("member");
    const source = await createServer("Publisher", `publisher-${randomUUID()}`, owner.id);
    const target = await createServer("Installer", `installer-${randomUUID()}`, installer.id);
    await addMember(source.id, member.id);
    const { client } = await createOAuthClient({ serverId: source.id, createdByUserId: owner.id, clientId: `jwt-${randomUUID().slice(0, 8)}`, name: "Audience app", allowedScopes: ["openid", "profile"] });
    const sourceAgent = await createAgent(source.id, "SourceAgent", { runtime: "external", model: "external" });
    const targetAgent = await createAgent(target.id, "TargetAgent", { runtime: "external", model: "external" });
    const sourceKey = await mintAgentCredential({ agentId: sourceAgent.id, scopes: ["read"], name: "source", issuedVia: "computer", createdByUserId: null });
    const targetKey = await mintAgentCredential({ agentId: targetAgent.id, scopes: ["read"], name: "target", issuedVia: "computer", createdByUserId: null });
    const issue = (token: string, service = client.clientId) => fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ service }) });
    const settings = (serverId: string, token: string, body?: object) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/agent-jwt`, {
      method: body ? "PUT" : "GET", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const [stored] = await getDb().select({ enabled: oauthClients.agentJwtEnabled }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(stored.enabled, false, "fixture: the old column default is still false");
    const firstIssue = await issue(sourceKey.apiKey);
    assert.equal(firstIssue.status, 200, "a new App issues with no setting");
    const issued = await firstIssue.json() as { access_token: string; expires_in: number };
    const claims = JSON.parse(Buffer.from(issued.access_token.split(".")[1], "base64url").toString());
    assert.equal(claims.aud, client.clientId);
    assert.equal(claims.server_id, source.id);
    assert.equal(issued.expires_in, 300);
    for (const legacy of [null, true]) {
      await getDb().update(oauthClients).set({ agentJwtEnabled: legacy }).where(eq(oauthClients.id, client.id));
      assert.equal((await issue(sourceKey.apiKey)).status, 200, `old column value ${legacy} is ignored`);
    }
    await getDb().update(oauthClients).set({ agentJwtEnabled: false }).where(eq(oauthClients.id, client.id));

    const unknown = await issue(targetKey.apiKey, "unknown-private-app");
    const unknownError = await unknown.json() as { errorCode: string };
    const privateIssue = await issue(targetKey.apiKey);
    assert.equal(privateIssue.status, unknown.status);
    assert.equal((await privateIssue.json() as { errorCode: string }).errorCode, unknownError.errorCode, "an unavailable private App is indistinguishable from an unknown one");
    const unknownService = `unregistered-${randomUUID()}`;
    await issue(sourceKey.apiKey, unknownService);
    const metric = await agentJwtIssuanceCounter.get();
    assert.ok(metric.values.some((value) => value.labels.client_id === client.clientId && value.labels.outcome === "issued"));
    assert.ok(metric.values.every((value) => value.labels.client_id !== unknownService && value.labels.client_id !== sourceAgent.id));
    assert.equal(JSON.stringify(metric).includes(issued.access_token), false);

    // Private share: the source keeps an active installation and the target installs by invite.
    const share = await createOAuthClientShareLink({ serverId: source.id, clientId: client.id, targetServerSlug: target.slug, createdByUserId: owner.id });
    assert.ok(share);
    assert.equal((await issue(sourceKey.apiKey)).status, 200, "source keeps issuing after conversion to a private share");
    assert.equal((await issue(targetKey.apiKey)).status, 403, "a share link alone does not install the App");
    assert.equal((await installOAuthClientShareInvite({ token: share.token, userId: installer.id, serverId: target.id, expected: await currentAppPermissions(client.id) }))?.status, "ok");
    const [installation] = await getDb().select().from(oauthClientInstalls).where(and(eq(oauthClientInstalls.clientId, client.id), eq(oauthClientInstalls.serverId, target.id)));
    assert.equal(installation.agentJwtEnabled, false, "fixture: the old installation column default is still false");
    const targetIssued = await issue(targetKey.apiKey);
    assert.equal(targetIssued.status, 200, "a private-share installation issues with no approval step");
    const targetClaims = JSON.parse(Buffer.from((await targetIssued.json() as { access_token: string }).access_token.split(".")[1], "base64url").toString());
    assert.equal(targetClaims.server_id, target.id, "issuer identity comes from the invoking Agent, not the publisher");
    assert.equal(targetClaims.aud, client.clientId);

    await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, installation.id));
    assert.equal((await issue(targetKey.apiKey)).status, 403, "suspended installation stops issuance");
    await getDb().update(oauthClientInstalls).set({ status: "active" }).where(eq(oauthClientInstalls.id, installation.id));
    await getDb().update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, client.id));
    assert.equal((await issue(targetKey.apiKey)).status, 403, "disabled App stops issuance");
    await getDb().update(oauthClients).set({ enabled: true, allowedScopes: ["openid"] }).where(eq(oauthClients.id, client.id));
    assert.equal((await issue(targetKey.apiKey)).status, 403, "App without openid/profile cannot issue");
    await getDb().update(oauthClients).set({ allowedScopes: ["openid", "profile"] }).where(eq(oauthClients.id, client.id));
    await getDb().delete(oauthClientInstalls).where(eq(oauthClientInstalls.id, installation.id));
    assert.equal((await issue(targetKey.apiKey)).status, 403, "uninstalled App stops issuance");

    // Compatibility for the previous web bundle only: read-only state, writes refused.
    assert.equal((await settings(source.id, member.token)).status, 403, "reading still needs manageIntegrations");
    const compat = await settings(source.id, owner.token);
    assert.equal(compat.status, 200);
    assert.deepEqual(await compat.json(), { scope: "app", enabled: true, appEnabled: true, effectiveEnabled: true, canEnable: false, audience: client.clientId, expiresIn: 300 });
    const write = await settings(source.id, owner.token, { enabled: false });
    assert.equal(write.status, 410);
    const [afterWrite] = await getDb().select({ enabled: oauthClients.agentJwtEnabled }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(afterWrite.enabled, false, "the refused write changes nothing");
    assert.equal((await issue(sourceKey.apiKey)).status, 200, "a refused off request cannot disable issuance");
    const policyEvents = await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.clientId, client.id), eq(integrationAuditEvents.eventType, "app.agent_jwt_updated")));
    assert.equal(policyEvents.length, 0);
  } finally {
    await app.close();
  }
}, 120_000);
