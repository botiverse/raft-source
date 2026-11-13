import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { featureFlags, serverMembers, serverSsoConnections, serverSsoDomains, users } from "../db/schema";
import { SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { createServer } from "../services/serverService";
import { EnterpriseSsoUnavailableError } from "../services/sso/ssoEdition";
import { forgetSsoRequirementCache } from "../services/sso/ssoEnforcement";
import { completeSsoSignIn, finishSsoSecondStep } from "../services/sso/ssoSignIn";
import type { SessionIssueProof } from "../services/sessionIssueGate";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";

// Enterprise SSO (rfcs/083-server-sso.md) by edition (edition.ts): the
// source-available edition offers none, refuses every sign-in and settings
// route, and enforces no "Require SSO", so password sign-in keeps working
// whatever connections the database holds. The cloud edition is unchanged.

const test = createApiTest();

// The edition line export-snapshot rewrites (edition.ts), switched per test.
const edition = vi.hoisted(() => ({ value: "cloud" as "cloud" | "source-available" }));
vi.mock("../edition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../edition")>();
  return { ...actual, enterpriseSsoAllowed: () => actual.enterpriseSsoAllowed(edition.value) };
});

afterEach(() => {
  edition.value = "cloud";
  forgetSsoRequirementCache();
});

const PASSWORD = "password123";

async function setFlag(key: string, defaultEnabled: boolean) {
  await getDb().insert(featureFlags)
    .values({ key, randomizationUnit: "server", salt: "test", defaultEnabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled } });
}

async function person(email: string) {
  const [user] = await getDb().insert(users).values({
    email, name: `p-${randomUUID()}`, passwordHash: await fixturePasswordHash(PASSWORD), emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function login(baseUrl: string, email: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }),
  });
}

async function tokenOf(baseUrl: string, email: string): Promise<string> {
  const response = await login(baseUrl, email);
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/**
 * A Server with SSO on and its requirement reviewed, an active, required OIDC
 * connection on a verified domain (the owner's and Alice's), and a SAML
 * connection draft for the metadata route.
 */
async function setup() {
  await setFlag(SERVER_SSO_FEATURE_FLAG_KEY, true);
  await setFlag(SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY, true);
  const tag = randomUUID().slice(0, 8);
  const domain = `acme-${tag}.test`;
  const owner = await person(`owner-${tag}@${domain}`);
  const alice = await person(`alice-${tag}@${domain}`);
  const server = await createServer("Acme", `acme-${tag}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: alice.id, role: "member" });
  const [connection] = await getDb().insert(serverSsoConnections).values({
    serverId: server.id, protocol: "oidc", status: "active", required: true, displayName: "Acme",
    config: { protocol: "oidc", issuer: "https://acme.okta.test", clientId: "raft" },
  }).returning();
  const [domainRow] = await getDb().insert(serverSsoDomains).values({ serverId: server.id, domain, verificationToken: randomUUID(), verifiedAt: new Date() }).returning();
  const otherOwner = await person(`other-${tag}@elsewhere-${tag}.test`);
  const other = await createServer("Saml Co", `saml-${tag}`, otherOwner.id);
  const [saml] = await getDb().insert(serverSsoConnections).values({
    serverId: other.id, protocol: "saml", status: "draft", displayName: "Saml Co",
    config: { protocol: "saml", idpEntityId: "https://idp.saml.test/entity", idpSsoUrl: "https://idp.saml.test/sso", idpCertificates: [] },
  }).returning();
  forgetSsoRequirementCache();
  return { server, connection: connection!, domain, domainRow: domainRow!, owner, alice, saml: saml! };
}

type Probe = { status: number; code?: string };

async function probe(url: string, init: RequestInit = {}): Promise<Probe> {
  const response = await fetch(url, { redirect: "manual", ...init });
  const text = await response.text();
  let code: string | undefined;
  try { code = (JSON.parse(text) as { code?: string }).code; } catch { code = undefined; }
  return { status: response.status, ...(code ? { code } : {}) };
}

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

/** Every SSO sign-in route (/api/auth/sso), each with the input it reads (a code, an assertion). */
async function probeSignInRoutes(baseUrl: string, s: Awaited<ReturnType<typeof setup>>): Promise<Record<string, Probe>> {
  const base = `${baseUrl}/api/auth/sso`;
  return {
    "POST /discover": await probe(`${base}/discover`, json("POST", { email: s.alice.email })),
    "GET /start": await probe(`${base}/start?t=issued-start-token`),
    "GET /servers/:serverId/start": await probe(`${base}/servers/${s.server.id}/start`),
    "GET /oidc/callback": await probe(`${base}/oidc/callback?state=issued-state&code=issued-code`, { headers: { Cookie: "raft_sso_x=issued-state" } }),
    "POST /saml/acs/:connectionId": await probe(`${base}/saml/acs/${s.connection.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SAMLResponse: "issued-assertion" }).toString(),
    }),
    "GET /saml/metadata/:connectionId": await probe(`${base}/saml/metadata/${s.saml.id}`),
    "POST /complete": await probe(`${base}/complete`, json("POST", { code: "issued-completion-code", codeVerifier: "issued-verifier" })),
  };
}

/** Every SSO settings route (/api/servers/:id/sso), as the owner. */
async function probeSettingsRoutes(baseUrl: string, s: Awaited<ReturnType<typeof setup>>, ownerToken: string): Promise<Record<string, Probe>> {
  const base = `${baseUrl}/api/servers/${s.server.id}/sso`;
  const auth = { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": s.server.id };
  return {
    "GET /": await probe(base, { headers: auth }),
    "PUT /connection": await probe(`${base}/connection`, json("PUT", { protocol: "oidc" }, auth)),
    "POST /test": await probe(`${base}/test`, json("POST", { draft: true }, auth)),
    "PATCH /rules": await probe(`${base}/rules`, json("PATCH", { autoJoin: "nope" }, auth)),
    "POST /domains": await probe(`${base}/domains`, json("POST", { domain: "" }, auth)),
    "POST /domains/:domainId/verify": await probe(`${base}/domains/${randomUUID()}/verify`, json("POST", {}, auth)),
    "DELETE /domains/:domainId": await probe(`${base}/domains/${randomUUID()}`, { method: "DELETE", headers: auth }),
    // Last: in the cloud edition it really removes the connection.
    "DELETE /connection": await probe(`${base}/connection`, { method: "DELETE", headers: auth }),
  };
}

async function ssoOffered(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/api/auth/providers`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { sso: boolean }).sso;
}

async function me(baseUrl: string, token: string): Promise<Probe> {
  return probe(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
}

test("the source-available edition offers no SSO, refuses every SSO route, and enforces no requirement", async ({ app }) => {
  const s = await setup();
  edition.value = "source-available";

  assert.equal(await ssoOffered(app.baseUrl), false);

  // A person on a Server whose active connection requires SSO still signs in with a password and uses Raft.
  const aliceLogin = await login(app.baseUrl, s.alice.email);
  assert.equal(aliceLogin.status, 200, await aliceLogin.clone().text());
  const aliceToken = ((await aliceLogin.json()) as { accessToken: string }).accessToken;
  assert.deepEqual(await me(app.baseUrl, aliceToken), { status: 200 });
  const ownerToken = await tokenOf(app.baseUrl, s.owner.email);

  const routes = { ...await probeSignInRoutes(app.baseUrl, s), ...await probeSettingsRoutes(app.baseUrl, s, ownerToken) };
  for (const [route, result] of Object.entries(routes)) {
    assert.deepEqual(result, { status: 404, code: "sso_not_available" }, `${route} must refuse`);
  }
  // Nothing was changed behind the refusals.
  const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.id, s.connection.id));
  assert.equal(connection?.status, "active");

  // What arrives below the routes with an already-issued code or challenge is refused too.
  await assert.rejects(
    completeSsoSignIn({ connectionId: s.connection.id, profile: { subject: "sub", email: s.alice.email, emailVerified: true, linkByEmail: "none" } as never }),
    EnterpriseSsoUnavailableError,
  );
  await assert.rejects(
    finishSsoSecondStep(getDb(), { flow: "sso_login", userId: s.alice.id, ssoConnectionId: s.connection.id, secondFactor: "not_required" } as SessionIssueProof, { userId: s.alice.id, connectionId: s.connection.id }),
    EnterpriseSsoUnavailableError,
  );
});

test("the cloud edition offers SSO, serves its routes, and enforces Require SSO", async ({ app }) => {
  const s = await setup();

  assert.equal(await ssoOffered(app.baseUrl), true);

  // Password sign-in works, but the session is refused until an SSO sign-in (RFC 083 §6.2).
  const aliceToken = await tokenOf(app.baseUrl, s.alice.email);
  assert.deepEqual(await me(app.baseUrl, aliceToken), { status: 403, code: "SSO_REQUIRED" });
  // The owner is never managed by their own Server.
  const ownerToken = await tokenOf(app.baseUrl, s.owner.email);

  const signIn = await probeSignInRoutes(app.baseUrl, s);
  const settings = await probeSettingsRoutes(app.baseUrl, s, ownerToken);
  for (const [route, result] of Object.entries({ ...signIn, ...settings })) {
    assert.notEqual(result.code, "sso_not_available", `${route} must not be refused: ${JSON.stringify(result)}`);
  }
  assert.equal(signIn["POST /discover"]!.status, 200);
  assert.equal(signIn["GET /start"]!.status, 302);
  assert.equal(signIn["GET /servers/:serverId/start"]!.status, 302);
  assert.equal(signIn["GET /oidc/callback"]!.status, 302);
  assert.equal(signIn["POST /saml/acs/:connectionId"]!.status, 303);
  assert.equal(signIn["GET /saml/metadata/:connectionId"]!.status, 200);
  assert.deepEqual(signIn["POST /complete"], { status: 400, code: "invalid_code" });
  assert.equal(settings["GET /"]!.status, 200);
  assert.equal(settings["DELETE /connection"]!.status, 204);
});
