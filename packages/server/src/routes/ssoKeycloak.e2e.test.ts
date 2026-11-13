import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { featureFlags, serverSsoConnections, sessionFamilies, users } from "../db/schema";
import { SERVER_SSO_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { createServer } from "../services/serverService";
import { SSO_SECRET_KEY_ENV } from "../services/sso/ssoConnectionSecret";
import { setSsoTxtResolverForTests } from "../services/sso/ssoDomains";

// SSO against a real Keycloak (rfcs/083-server-sso.md §5, §7), with no fake
// IdP. OIDC: discovery, JWKS, the code exchange and the ID token are
// Keycloak's. SAML: Keycloak signs the assertions (RSA-SHA256, persistent
// NameID); the test registers the SAML client through Keycloak's admin API,
// as an IdP admin would, since its client ID is the connection's entity ID.
// Skipped unless RAFT_SSO_KEYCLOAK_URL points at one with the realm in
// docs/development/sso.md ("End-to-end with Keycloak").

const KEYCLOAK = process.env.RAFT_SSO_KEYCLOAK_URL;
const test = createApiTest();
const LEGAL = { acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion, privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion };
const saved = { key: process.env[SSO_SECRET_KEY_ENV], http: process.env.RAFT_SSO_ALLOW_HTTP_IDP };

beforeAll(() => {
  process.env[SSO_SECRET_KEY_ENV] = randomBytes(32).toString("base64");
  process.env.RAFT_SSO_ALLOW_HTTP_IDP = "1";
});
afterAll(() => {
  for (const [name, value] of [[SSO_SECRET_KEY_ENV, saved.key], ["RAFT_SSO_ALLOW_HTTP_IDP", saved.http]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setSsoTxtResolverForTests(null);
});

/** What a browser does at Keycloak: open the sign-in URL, post the login form; Keycloak's answer to the post. */
async function keycloakLoginPost(signInUrl: string, username: string, password: string): Promise<Response> {
  const jar = new Map<string, string>();
  const keep = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      jar.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
  };
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const page = await fetch(signInUrl, { redirect: "manual" });
  keep(page);
  assert.equal(page.status, 200, "Keycloak shows its login form");
  const html = await page.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/u.exec(html)?.[1];
  assert.ok(action, "the login form");
  return fetch(action.replaceAll("&amp;", "&"), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookie() },
    body: new URLSearchParams({ username, password, credentialId: "" }).toString(),
  });
}

/** OIDC: Keycloak redirects back to Raft's callback. */
async function keycloakSignIn(authorizeUrl: string, username: string, password: string): Promise<URL> {
  const posted = await keycloakLoginPost(authorizeUrl, username, password);
  assert.equal(posted.status, 302, `Keycloak signs ${username} in`);
  return new URL(posted.headers.get("location")!);
}

/** SAML: Keycloak answers with the HTTP-POST binding's auto-submitting form (SAMLResponse, RelayState). */
async function keycloakSamlSignIn(redirectUrl: string, username: string, password: string): Promise<{ action: string; form: Record<string, string> }> {
  const posted = await keycloakLoginPost(redirectUrl, username, password);
  assert.equal(posted.status, 200, `Keycloak signs ${username} in`);
  const html = await posted.text();
  const action = /<form[^>]*action="([^"]+)"/u.exec(html)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(action, "the auto-post form");
  const form: Record<string, string> = {};
  for (const match of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gu)) form[match[1]!] = match[2]!;
  assert.ok(form.SAMLResponse, "a SAMLResponse");
  return { action, form };
}

/** Keycloak's admin API, as the bootstrap admin, on the acme realm. */
async function keycloakAdmin(): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> {
  const { access_token: token } = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }).toString(),
  }).then((r) => r.json()) as { access_token: string };
  return (method, path, body) => fetch(`${KEYCLOAK}/admin/realms/acme${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** An owner and their Server, with the owner's SSO settings API. */
async function ownerWithServer(baseUrl: string) {
  await getDb().insert(featureFlags)
    .values({ key: SERVER_SSO_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: true } });
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `owner-${suffix}@slock.test`, name: `owner-${suffix}`, passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Acme", `acme-${suffix}`, owner!.id);
  const token = ((await (await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: owner!.email, password: "password123" }),
  })).json()) as { accessToken: string }).accessToken;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/api/servers/${server.id}/sso${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  const verifyDomain = async () => {
    const domain = (await call("POST", "/domains", { domain: "acme.test" })).body!.domain;
    setSsoTxtResolverForTests(async () => [[domain.record.value]]);
    assert.equal((await call("POST", `/domains/${domain.id}/verify`)).body!.domain.verified, true);
  };
  return { server, call, verifyDomain };
}

async function startLeg(baseUrl: string, startUrl: string): Promise<{ cookie: string; authorizeUrl: string }> {
  const url = new URL(startUrl);
  const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, { redirect: "manual" });
  assert.equal(response.status, 302, await response.text());
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!, authorizeUrl: response.headers.get("location")! };
}

/** The completion-binding cookie each callback left in "this browser", by completion code. */
const completionCookies = new Map<string, string>();

function keepCompletionCookie(response: Response, location: URL): URL {
  const line = response.headers.getSetCookie().find((cookie) => cookie.startsWith("raft_sso_done_"));
  const code = location.searchParams.get("code");
  if (line && code) completionCookies.set(code, line.split(";")[0]!);
  return location;
}

/** Keycloak's redirect, delivered to Raft's callback with the leg's cookie. */
async function backToRaft(baseUrl: string, cookie: string, keycloakRedirect: URL): Promise<URL> {
  const response = await fetch(`${baseUrl}/api/auth/sso/oidc/callback${keycloakRedirect.search}`, { redirect: "manual", headers: { cookie } });
  assert.equal(response.status, 302);
  return keepCompletionCookie(response, new URL(response.headers.get("location")!));
}

test.skipIf(!KEYCLOAK)("Keycloak: the owner's test activates; a verified person signs in; an unverified email is refused", async ({ app }) => {
  const { server, call, verifyDomain } = await ownerWithServer(app.baseUrl);
  const saved = await call("PUT", "/connection", { protocol: "oidc", displayName: "Acme Keycloak", issuer: `${KEYCLOAK}/realms/acme`, clientId: "raft", clientSecret: "raft-secret" });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  await verifyDomain();

  const testLeg = await startLeg(app.baseUrl, (await call("POST", "/test")).body!.url);
  const tested = await backToRaft(app.baseUrl, testLeg.cookie, await keycloakSignIn(testLeg.authorizeUrl, "alice", "alice-pass"));
  assert.equal(tested.searchParams.get("sso_test"), "ok", tested.toString());
  const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.equal(connection!.status, "active");

  const signIn = async (username: string, password: string, email: string) => {
    const discovered = await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
    }).then((r) => r.json()) as { connections: Array<{ startUrl: string }> };
    const leg = await startLeg(app.baseUrl, discovered.connections[0]!.startUrl);
    const back = await backToRaft(app.baseUrl, leg.cookie, await keycloakSignIn(leg.authorizeUrl, username, password));
    assert.equal(back.searchParams.get("auth_callback"), "sso", back.toString());
    return fetch(`${app.baseUrl}/api/auth/sso/complete`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie: completionCookies.get(back.searchParams.get("code")!) ?? "" }, body: JSON.stringify({ code: back.searchParams.get("code"), ...LEGAL }),
    });
  };

  const alice = await signIn("alice", "alice-pass", "alice@acme.test");
  assert.equal(alice.status, 200, await alice.clone().text());
  const [person] = await getDb().select().from(users).where(eq(users.email, "alice@acme.test"));
  const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, person!.id));
  assert.equal(family!.ssoConnectionId, connection!.id, "the session was signed in by this connection");

  const mallory = await signIn("mallory", "mallory-pass", "mallory@acme.test");
  assert.equal(mallory.status, 403);
  assert.equal(((await mallory.json()) as { code: string }).code, "email_unverified", "Keycloak's email_verified: false is refused");
});

test.skipIf(!KEYCLOAK)("Keycloak SAML: signed assertions activate the connection and sign a person in; an existing account is not linked without the attestation", async ({ app }) => {
  const { server, call, verifyDomain } = await ownerWithServer(app.baseUrl);
  const descriptor = await fetch(`${KEYCLOAK}/realms/acme/protocol/saml/descriptor`).then((r) => r.text());
  const certificate = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/u.exec(descriptor)![1]!;
  const saved = await call("PUT", "/connection", {
    protocol: "saml",
    displayName: "Acme Keycloak SAML",
    idpEntityId: `${KEYCLOAK}/realms/acme`,
    idpSsoUrl: `${KEYCLOAK}/realms/acme/protocol/saml`,
    idpCertificates: [`-----BEGIN CERTIFICATE-----\n${certificate}\n-----END CERTIFICATE-----`],
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const sp = saved.body!.connection.serviceProvider as { samlEntityId: string; samlAcsUrl: string };

  // The IdP admin's side: a SAML client for this connection's entity ID, signing assertions with SHA-256,
  // a persistent NameID, and the email as an attribute.
  const admin = await keycloakAdmin();
  const bobEmail = `bob-${randomUUID().slice(0, 6)}@acme.test`;
  const created = await admin("POST", "/clients", {
    clientId: sp.samlEntityId,
    protocol: "saml",
    enabled: true,
    redirectUris: ["*"],
    attributes: {
      "saml.assertion.signature": "true",
      "saml.server.signature": "false",
      "saml.client.signature": "false",
      "saml.signature.algorithm": "RSA_SHA256",
      "saml_name_id_format": "persistent",
      "saml.force.name.id.format": "true",
      "saml.authnstatement": "true",
      "saml_assertion_consumer_url_post": sp.samlAcsUrl,
    },
    protocolMappers: [{
      name: "email",
      protocol: "saml",
      protocolMapper: "saml-user-property-mapper",
      config: { "user.attribute": "email", "attribute.name": "email", "attribute.nameformat": "Basic" },
    }],
  });
  assert.equal(created.status, 201, await created.text());
  const clientPath = new URL(created.headers.get("location")!).pathname.replace(/^.*\/admin\/realms\/acme/u, "");
  const bob = await admin("POST", "/users", {
    username: `bob-${randomUUID().slice(0, 6)}`, email: bobEmail, emailVerified: true, enabled: true, firstName: "Bob", lastName: "Acme",
    credentials: [{ type: "password", value: "bob-pass", temporary: false }],
  });
  assert.equal(bob.status, 201, await bob.text());
  const bobPath = new URL(bob.headers.get("location")!).pathname.replace(/^.*\/admin\/realms\/acme/u, "");
  const bobUsername = ((await (await admin("GET", bobPath)).json()) as { username: string }).username;
  try {
    await verifyDomain();
    const answerAtAcs = async (startUrl: string, username: string, password: string) => {
      const leg = await startLeg(app.baseUrl, startUrl);
      const { action, form } = await keycloakSamlSignIn(leg.authorizeUrl, username, password);
      assert.equal(action, sp.samlAcsUrl, "Keycloak posts to this connection's ACS");
      const response = await fetch(`${app.baseUrl}${new URL(action).pathname}`, {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: leg.cookie },
        body: new URLSearchParams(form).toString(),
      });
      return keepCompletionCookie(response, new URL(response.headers.get("location")!, app.baseUrl));
    };

    const tested = await answerAtAcs((await call("POST", "/test")).body!.url, "alice", "alice-pass");
    assert.equal(tested.searchParams.get("sso_test"), "ok", tested.toString());
    const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
    assert.equal(connection!.status, "active");

    const signIn = async (username: string, password: string, email: string) => {
      const discovered = await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      }).then((r) => r.json()) as { connections: Array<{ startUrl: string }> };
      const back = await answerAtAcs(discovered.connections[0]!.startUrl, username, password);
      assert.equal(back.searchParams.get("auth_callback"), "sso", back.toString());
      return fetch(`${app.baseUrl}/api/auth/sso/complete`, {
        method: "POST", headers: { "Content-Type": "application/json", cookie: completionCookies.get(back.searchParams.get("code")!) ?? "" }, body: JSON.stringify({ code: back.searchParams.get("code"), ...LEGAL }),
      });
    };

    const alice = await signIn("alice", "alice-pass", "alice@acme.test");
    assert.equal(alice.status, 200, await alice.clone().text());
    const [person] = await getDb().select().from(users).where(eq(users.email, "alice@acme.test"));
    const [family] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, person!.id));
    assert.equal(family!.ssoConnectionId, connection!.id, "the session was signed in by this connection");

    // Bob already has a Raft account: without the owner's attestation SAML does not link it by email.
    await getDb().insert(users).values({
      email: bobEmail, name: `bob-${randomUUID()}`, passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true, profileSetupCompletedAt: new Date(),
    });
    const refused = await signIn(bobUsername, "bob-pass", bobEmail);
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { code: string }).code, "email_link_not_attested");
  } finally {
    await admin("DELETE", clientPath);
    await admin("DELETE", bobPath);
  }
});
