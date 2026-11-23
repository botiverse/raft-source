import assert from "node:assert/strict";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentJwtIssuanceCounter } from "../metrics";
import { getDb } from "../db/index";
import { users, oauthClients, oauthClientInstalls, integrationAuditEvents, serverAgentMembers } from "../db/schema";
import { AGENT_TOKEN_TYPE_JWT_WITH_REDIRECT_REFUSAL, AGENT_TOKEN_TYPE_REDIRECT_ON_JWT_APP_REFUSAL, createOAuthClient, createOAuthClientShareLink, installOAuthClientShareInvite } from "../services/oauthService";
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

test("an App's agent token signing algorithm is its owner's setting, never the request's", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const seedUser = async (label: string) => {
      const suffix = randomUUID();
      const [user] = await getDb().insert(users).values({ name: `alg-${label}-${suffix}`, email: `${suffix}@raft.test`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date() }).returning();
      return { ...user, token: await tokenForHuman(user.email) };
    };
    const owner = await seedUser("owner");
    const member = await seedUser("member");
    const server = await createServer("Signer", `signer-${randomUUID()}`, owner.id);
    await addMember(server.id, member.id);
    const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `alg-${randomUUID().slice(0, 8)}`, name: "Aliyun federation", allowedScopes: ["openid", "profile"] });
    const agent = await createAgent(server.id, "Federator", { runtime: "external", model: "external" });
    const agentKey = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "alg", issuedVia: "computer", createdByUserId: null });
    const issue = (body: object = { service: client.clientId }) => fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, { method: "POST", headers: { Authorization: `Bearer ${agentKey.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const patch = (token: string, body: object) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const agentUpdate = (body: object) => fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, { method: "POST", headers: { Authorization: `Bearer ${agentKey.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ clientKey: client.clientId, ...body }) });
    const editorRow = async () => {
      const res = await fetch(`${app.baseUrl}/api/integrations/clients`, { headers: { Authorization: `Bearer ${owner.token}`, "X-Server-Id": server.id } });
      assert.equal(res.status, 200);
      return (await res.json() as Array<{ id: string; agentTokenSigningAlg: string }>).find((row) => row.id === client.id);
    };
    const jwks = async () => (await (await fetch(`${app.baseUrl}/oidc/${server.slug}/api/oauth/jwks`)).json()) as { keys: Array<Record<string, string>> };
    // The token's header, after checking its signature against the published key its kid names.
    const issuedHeader = async (res: Response) => {
      assert.equal(res.status, 200);
      const [header, payload, signature] = (await res.json() as { access_token: string }).access_token.split(".");
      const decoded = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg: string; kid: string; typ: string };
      const key = (await jwks()).keys.find((candidate) => candidate.kid === decoded.kid);
      assert.ok(key, "the kid is in the issuer's JWKS");
      assert.equal(key.alg, decoded.alg);
      const publicKey = createPublicKey({ key, format: "jwk" });
      const data = Buffer.from(`${header}.${payload}`);
      const sig = Buffer.from(signature, "base64url");
      assert.equal(decoded.alg === "RS256" ? verify("sha256", data, publicKey, sig) : verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig), true);
      assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).aud, client.clientId);
      return decoded;
    };

    const published = await jwks();
    assert.deepEqual(published.keys.map((key) => key.alg), ["ES256", "RS256"], "the issuer's JWKS publishes both keys");
    for (const key of published.keys) assert.deepEqual(["d", "p", "q", "dp", "dq", "qi"].filter((member) => member in key), [], "public members only");
    const discovery = await (await fetch(`${app.baseUrl}/oidc/${server.slug}/.well-known/openid-configuration`)).json() as { id_token_signing_alg_values_supported: string[] };
    assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["ES256", "RS256"]);

    assert.equal((await editorRow())?.agentTokenSigningAlg, "ES256", "an App defaults to ES256");
    assert.deepEqual(await issuedHeader(await issue()), { alg: "ES256", kid: published.keys[0].kid, typ: "at+jwt" });
    for (const alg of ["RS256", "ES256", "HS256"]) {
      const res = await issue({ service: client.clientId, alg });
      assert.equal(res.status, 400, `a token request cannot name an algorithm (${alg})`);
      assert.equal(JSON.stringify(await res.json()).includes("access_token"), false);
    }

    for (const invalid of ["HS256", "rs256", "none", "", null, 256, ["RS256"]]) {
      const res = await patch(owner.token, { agentTokenSigningAlg: invalid });
      assert.equal(res.status, 400, `${JSON.stringify(invalid)} is refused`);
    }
    assert.equal((await patch(member.token, { agentTokenSigningAlg: "RS256" })).status, 403, "a member cannot change it");
    assert.equal((await editorRow())?.agentTokenSigningAlg, "ES256", "refused writes change nothing");

    const saved = await patch(owner.token, { agentTokenSigningAlg: "RS256" });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as { agentTokenSigningAlg: string }).agentTokenSigningAlg, "RS256");
    assert.equal((await editorRow())?.agentTokenSigningAlg, "RS256");
    const [audit] = await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.clientId, client.id), eq(integrationAuditEvents.eventType, "app.updated")));
    assert.deepEqual((audit.diff as Record<string, unknown>).agentTokenSigningAlg, { before: "ES256", after: "RS256" });

    assert.deepEqual(await issuedHeader(await issue()), { alg: "RS256", kid: published.keys[1].kid, typ: "at+jwt" }, "an RS256 App gets RS256 tokens");
    assert.equal((await issue({ service: client.clientId, alg: "ES256" })).status, 400, "nor can a request ask an RS256 App for ES256");

    // An agent with App authority (here a Server admin agent) sets it through the agent API
    // (raft integration app update --agent-token-signing-alg).
    await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));
    assert.equal((await agentUpdate({ agentTokenSigningAlg: "HS256" })).status, 400, "the contract accepts ES256 or RS256 only");
    const agentSaved = await agentUpdate({ agentTokenSigningAlg: "ES256" });
    assert.equal(agentSaved.status, 200);
    assert.deepEqual((await agentSaved.json() as { updatedFields: string[] }).updatedFields, ["agentTokenSigningAlg"]);
    assert.equal((await editorRow())?.agentTokenSigningAlg, "ES256");
    assert.equal((await issuedHeader(await issue())).alg, "ES256");
  } finally {
    await app.close();
  }
}, 120_000);

test("an App's agent token typ: at+jwt by default, JWT only on a token-only App (no redirect URL)", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const seedUser = async (label: string) => {
      const suffix = randomUUID();
      const [user] = await getDb().insert(users).values({ name: `typ-${label}-${suffix}`, email: `${suffix}@raft.test`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date() }).returning();
      return { ...user, token: await tokenForHuman(user.email) };
    };
    const owner = await seedUser("owner");
    const member = await seedUser("member");
    const server = await createServer("Federation", `federation-${randomUUID()}`, owner.id);
    await addMember(server.id, member.id);
    const callback = "https://federation.example.test/callback";
    const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `typ-${randomUUID().slice(0, 8)}`, name: "Aliyun federation", returnUrl: callback, allowedScopes: ["openid", "profile"] });
    const agent = await createAgent(server.id, "Federator", { runtime: "external", model: "external" });
    const agentKey = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "typ", issuedVia: "computer", createdByUserId: null });
    // An agent with App authority (a Server admin agent), as for raft integration app update.
    await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));
    const issue = () => fetch(`${app.baseUrl}/internal/agent-api/integrations/token`, { method: "POST", headers: { Authorization: `Bearer ${agentKey.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ service: client.clientId }) });
    const patch = (token: string, body: object) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const agentUpdate = (body: object) => fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, { method: "POST", headers: { Authorization: `Bearer ${agentKey.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ clientKey: client.clientId, ...body }) });
    const stored = async () => (await getDb().select({ agentTokenType: oauthClients.agentTokenType, returnUrl: oauthClients.returnUrl, agentTokenSigningAlg: oauthClients.agentTokenSigningAlg }).from(oauthClients).where(eq(oauthClients.id, client.id)))[0];
    const editorRow = async () => {
      const res = await fetch(`${app.baseUrl}/api/integrations/clients`, { headers: { Authorization: `Bearer ${owner.token}`, "X-Server-Id": server.id } });
      assert.equal(res.status, 200);
      return (await res.json() as Array<{ id: string; agentTokenType: string; returnUrl: string | null }>).find((row) => row.id === client.id);
    };
    const jwks = async () => (await (await fetch(`${app.baseUrl}/oidc/${server.slug}/api/oauth/jwks`)).json()) as { keys: Array<Record<string, string>> };
    // The token's header and claims, after checking its signature against the published key its kid names.
    const issued = async () => {
      const res = await issue();
      assert.equal(res.status, 200);
      const [header, payload, signature] = (await res.json() as { access_token: string }).access_token.split(".");
      const decoded = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg: string; kid: string; typ: string };
      const key = (await jwks()).keys.find((candidate) => candidate.kid === decoded.kid);
      assert.ok(key, "the kid is in the issuer's JWKS");
      const publicKey = createPublicKey({ key, format: "jwk" });
      const data = Buffer.from(`${header}.${payload}`);
      const sig = Buffer.from(signature, "base64url");
      assert.equal(decoded.alg === "RS256" ? verify("sha256", data, publicKey, sig) : verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig), true);
      const { iat: _iat, nbf: _nbf, exp: _exp, jti: _jti, ...stable } = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
      return { header: decoded, claims: stable };
    };
    const assertUnchanged = async (expected: { agentTokenType: string; returnUrl: string | null }, label: string) => {
      const row = await stored();
      assert.equal(row.agentTokenType, expected.agentTokenType, `${label}: agent token type unchanged`);
      assert.equal(row.returnUrl, expected.returnUrl, `${label}: redirect URL unchanged`);
    };
    const published = await jwks();

    // 1. The default: at+jwt, as before.
    assert.equal((await editorRow())?.agentTokenType, "at+jwt", "an App defaults to at+jwt");
    const before = await issued();
    assert.deepEqual(before.header, { alg: "ES256", kid: published.keys[0].kid, typ: "at+jwt" });

    // 6. Exactly at+jwt or JWT.
    for (const invalid of ["jwt", "none", "at+JWT", "AT+JWT", " JWT", "", null, 1, ["JWT"]]) {
      const res = await patch(owner.token, { agentTokenType: invalid });
      assert.equal(res.status, 400, `${JSON.stringify(invalid)} is refused`);
      assert.match((await res.json() as { error: string }).error, /agentTokenType/);
    }
    for (const invalid of ["jwt", "none", "at+JWT"]) {
      assert.equal((await agentUpdate({ agentTokenType: invalid })).status, 400, `the contract refuses ${invalid}`);
    }
    await assert.rejects(createOAuthClient({ serverId: server.id, createdByUserId: owner.id, name: "Bad typ", agentTokenType: "jwt" }), /agentTokenType must be exactly one of at\+jwt, JWT/);
    assert.equal((await patch(member.token, { agentTokenType: "at+jwt" })).status, 403, "a member cannot change it");
    await assertUnchanged({ agentTokenType: "at+jwt", returnUrl: callback }, "invalid values");

    // 3. JWT on an App with a redirect URL: refused on every write path, naming the conflict.
    const httpRefused = await patch(owner.token, { agentTokenType: "JWT" });
    assert.equal(httpRefused.status, 409);
    const httpBody = await httpRefused.json() as { code: string; error: string };
    assert.equal(httpBody.code, "AGENT_TOKEN_TYPE_REDIRECT_CONFLICT");
    assert.equal(httpBody.error, AGENT_TOKEN_TYPE_JWT_WITH_REDIRECT_REFUSAL.error);
    const agentRefused = await agentUpdate({ agentTokenType: "JWT" });
    assert.equal(agentRefused.status, 409);
    assert.equal((await agentRefused.json() as { error: string }).error, AGENT_TOKEN_TYPE_JWT_WITH_REDIRECT_REFUSAL.error);
    await assert.rejects(
      createOAuthClient({ serverId: server.id, createdByUserId: owner.id, name: "Both", returnUrl: callback, agentTokenType: "JWT" }),
      (err: Error) => err.message === AGENT_TOKEN_TYPE_JWT_WITH_REDIRECT_REFUSAL.error,
    );
    await assertUnchanged({ agentTokenType: "at+jwt", returnUrl: callback }, "JWT next to a redirect URL");

    // 5. Clearing the redirect URL (raft integration app update --redirect-url ""), then person sign-in is refused without a redirect.
    const cleared = await agentUpdate({ returnUrl: "" });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.deepEqual((await cleared.json() as { updatedFields: string[] }).updatedFields, ["returnUrl"]);
    assert.equal((await editorRow())?.returnUrl, null);
    const authorize = (body: object) => fetch(`${app.baseUrl}/api/oauth/authorize/human`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ clientId: client.clientId, serverId: server.id, scopes: ["openid", "profile"], ...body }) });
    for (const [label, body] of [["OIDC", { oidc: true, returnUrl: callback }], ["legacy with the old callback", { returnUrl: callback }]] as const) {
      const res = await authorize(body);
      assert.equal(res.status, 400, `${label}: refused`);
      const answer = await res.json() as Record<string, unknown>;
      assert.equal(answer.code, undefined, `${label}: no authorization code`);
      assert.equal(answer.returnUrl, undefined, `${label}: nowhere to send the person`);
      assert.match(String(answer.error), /returnUrl/);
    }

    // 3/8. Now token-only: JWT is accepted, answered in the editor row, and audited.
    const saved = await patch(owner.token, { agentTokenType: "JWT" });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json() as { agentTokenType: string }).agentTokenType, "JWT");
    assert.equal((await editorRow())?.agentTokenType, "JWT");
    const audits = await getDb().select().from(integrationAuditEvents).where(and(eq(integrationAuditEvents.clientId, client.id), eq(integrationAuditEvents.eventType, "app.updated")));
    const typAudit = audits.find((event) => event.diff && "agentTokenType" in (event.diff as Record<string, unknown>));
    assert.ok(typAudit, "an app.updated event carries the change");
    assert.deepEqual((typAudit.diff as Record<string, unknown>).agentTokenType, { before: "at+jwt", after: "JWT" });

    // 2. Its agent tokens: typ JWT, alg per its signing algorithm, claims unchanged.
    const jwt = await issued();
    assert.deepEqual(jwt.header, { alg: "ES256", kid: published.keys[0].kid, typ: "JWT" });
    assert.deepEqual(jwt.claims, before.claims, "only the typ header differs");
    assert.equal((await patch(owner.token, { agentTokenSigningAlg: "RS256" })).status, 200);
    const rs256 = await issued();
    assert.deepEqual(rs256.header, { alg: "RS256", kid: published.keys[1].kid, typ: "JWT" });
    assert.deepEqual(rs256.claims, before.claims);

    // 4. A redirect URL on a JWT App: refused on both paths, naming the conflict.
    const addHttp = await patch(owner.token, { returnUrl: callback });
    assert.equal(addHttp.status, 409);
    assert.equal((await addHttp.json() as { error: string }).error, AGENT_TOKEN_TYPE_REDIRECT_ON_JWT_APP_REFUSAL.error);
    const addAgent = await agentUpdate({ returnUrl: callback });
    assert.equal(addAgent.status, 409);
    assert.equal((await addAgent.json() as { error: string }).error, AGENT_TOKEN_TYPE_REDIRECT_ON_JWT_APP_REFUSAL.error);
    await assertUnchanged({ agentTokenType: "JWT", returnUrl: null }, "a redirect URL on a JWT App");
    // The database holds the same rule for any writer the service doesn't cover.
    await assert.rejects(getDb().update(oauthClients).set({ returnUrl: callback }).where(eq(oauthClients.id, client.id)), (err: Error & { cause?: { message?: string; constraint?: string } }) => /oauth_clients_agent_token_type_token_only/.test(`${err.cause?.constraint ?? ""} ${err.cause?.message ?? ""}`));
    await assertUnchanged({ agentTokenType: "JWT", returnUrl: null }, "a direct write");

    // A token-only App takes no sign-in at all: no code without a callback, no exchange at the token endpoint.
    const noCallback = await authorize({});
    assert.equal(noCallback.status, 400);
    assert.equal((await noCallback.json() as { code?: string }).code, undefined);
    for (const body of [{ grant_type: "authorization_code", code: randomUUID() }, { grant_type: "urn:slock:grant-type:agent_request", request_id: randomUUID() }]) {
      const res = await fetch(`${app.baseUrl}/api/oauth/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 400, body.grant_type);
      const answer = await res.json() as Record<string, unknown>;
      assert.equal(answer.error, "unauthorized_client");
      assert.equal(answer.id_token, undefined);
    }

    // Both sides in one update are fine: back to at+jwt with a redirect URL, then token-only again.
    const back = await patch(owner.token, { agentTokenType: "at+jwt", returnUrl: callback });
    assert.equal(back.status, 200, await back.clone().text());
    await assertUnchanged({ agentTokenType: "at+jwt", returnUrl: callback }, "one update, both sides");
    const again = await agentUpdate({ agentTokenType: "JWT", returnUrl: "" });
    assert.equal(again.status, 200, await again.clone().text());
    assert.deepEqual((await again.json() as { updatedFields: string[] }).updatedFields, ["returnUrl", "agentTokenType"]);
    await assertUnchanged({ agentTokenType: "JWT", returnUrl: null }, "agent API, both sides");
  } finally {
    await app.close();
  }
}, 120_000);
