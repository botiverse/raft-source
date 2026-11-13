import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll } from "vitest";
import { SignedXml } from "xml-crypto";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { featureFlags, integrationAuditEvents, serverSsoConnections, ssoIdentities, users } from "../db/schema";
import { SERVER_SSO_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { createServer } from "../services/serverService";
import { SSO_SECRET_KEY_ENV } from "../services/sso/ssoConnectionSecret";
import { setSsoTxtResolverForTests } from "../services/sso/ssoDomains";
import { rememberSamlAssertion, SAML_PERSISTENT_NAMEID } from "../services/sso/ssoSaml";

// SSO over SAML end to end (rfcs/083-server-sso.md §5, §7) against an IdP
// that signs real assertions: the owner's test activates; a person signs in;
// unsigned, foreign-signed, wrong-audience, transient-NameID and replayed
// answers are refused; an unsolicited answer starts a normal sign-in instead.

const test = createApiTest();
const IDP_SSO_URL = "https://idp.saml.acme.test/sso";
const IDP_ENTITY = "https://idp.saml.acme.test/entity";
const LEGAL = { acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion, privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion };

/** Test-only signing material, generated per run (no private key is committed). */
function keyPair(dir: string, name: string): { key: string; cert: string } {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.pem`), "-days", "2", "-subj", `/CN=${name}`], { stdio: "ignore" });
  return { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.pem`), "utf8") };
}

let dir = "";
let idp: { key: string; cert: string };
let attacker: { key: string; cert: string };
const savedKey = process.env[SSO_SECRET_KEY_ENV];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "raft-saml-"));
  idp = keyPair(dir, "idp");
  attacker = keyPair(dir, "attacker");
  process.env[SSO_SECRET_KEY_ENV] = randomBytes(32).toString("base64");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env[SSO_SECRET_KEY_ENV];
  else process.env[SSO_SECRET_KEY_ENV] = savedKey;
  setSsoTxtResolverForTests(null);
});

type Answer = { email: string; nameId?: string; nameIdFormat?: string; audience?: string; issuer?: string; sha1?: boolean; signWith?: "idp" | "attacker" | "none"; encodeAlgorithms?: boolean };

/** A SAML Response to `requestId`, its assertion signed (enveloped, exclusive c14n, RSA-SHA256). */
function samlResponse(sp: { entityId: string; acsUrl: string }, requestId: string, answer: Answer): string {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const assertionId = `_a${randomBytes(12).toString("hex")}`;
  const nameId = answer.nameId ?? `sub-${randomUUID()}`;
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">`
    + `<saml:Issuer>${answer.issuer ?? IDP_ENTITY}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="${answer.nameIdFormat ?? SAML_PERSISTENT_NAMEID}">${nameId}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" NotOnOrAfter="${later}" Recipient="${sp.acsUrl}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${answer.audience ?? sp.entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${answer.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    + `</saml:Assertion>`;
  let signed = assertion;
  if ((answer.signWith ?? "idp") !== "none") {
    const sig = new SignedXml({
      privateKey: (answer.signWith === "attacker" ? attacker : idp).key,
      signatureAlgorithm: answer.sha1 ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1" : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      digestAlgorithm: answer.sha1 ? "http://www.w3.org/2000/09/xmldsig#sha1" : "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    });
    sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: "after" } });
    signed = sig.getSignedXml();
    // The same URIs with `#` as a character reference: the parsed value (and the signature) are unchanged.
    if (answer.encodeAlgorithms) signed = signed.replace(/Algorithm="([^"]*)#/gu, 'Algorithm="$1&#x23;');
  }
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${sp.acsUrl}" InResponseTo="${requestId}">`
    + `<saml:Issuer>${IDP_ENTITY}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(response).toString("base64");
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function setup(baseUrl: string, options: { emailManagedByAdmins?: boolean } = {}) {
  await getDb().insert(featureFlags)
    .values({ key: SERVER_SSO_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: true } });
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `owner-${suffix}@slock.test`, name: `owner-${suffix}`, passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Acme", `acme-${suffix}`, owner!.id);
  const token = await login(baseUrl, owner!.email);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/api/servers/${server.id}/sso${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  const saved = await call("PUT", "/connection", { protocol: "saml", displayName: "Acme SAML", idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO_URL, idpCertificates: [idp.cert], ...options });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const sp = { entityId: saved.body!.connection.serviceProvider.samlEntityId as string, acsUrl: saved.body!.connection.serviceProvider.samlAcsUrl as string };
  const domain = (await call("POST", "/domains", { domain: "acme.test" })).body!.domain;
  setSsoTxtResolverForTests(async () => [[domain.record.value]]);
  assert.equal((await call("POST", `/domains/${domain.id}/verify`)).body!.domain.verified, true);
  return { server, call, sp, owner: owner! };
}

async function discoverStart(baseUrl: string, email: string): Promise<string> {
  return ((await fetch(`${baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
  }).then((r) => r.json())) as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
}

/** A whole sign-in for `answer`: the /complete status and refusal code. */
async function signIn(baseUrl: string, sp: { entityId: string; acsUrl: string }, answer: Answer): Promise<{ status: number; code: string | null }> {
  const leg = await startLeg(baseUrl, await discoverStart(baseUrl, answer.email));
  const back = await post(baseUrl, sp, { SAMLResponse: samlResponse(sp, leg.requestId, answer), RelayState: leg.relayState }, leg.cookie);
  assert.equal(back.location.searchParams.get("auth_callback"), "sso", back.location.toString());
  const done = await fetch(`${baseUrl}/api/auth/sso/complete`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: back.completionCookie }, body: JSON.stringify({ code: back.location.searchParams.get("code"), ...LEGAL }),
  });
  const body = await done.json().catch(() => null) as { code?: string } | null;
  return { status: done.status, code: body?.code ?? null };
}

async function existingAccount(email: string) {
  const suffix = randomUUID();
  const [person] = await getDb().insert(users).values({
    email, name: `p-${suffix}`, passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return person!;
}

/** A started SAML leg: its cookie, RelayState and AuthnRequest ID. */
async function startLeg(baseUrl: string, startUrl: string): Promise<{ cookie: string; relayState: string; requestId: string }> {
  const url = new URL(startUrl);
  const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, { redirect: "manual" });
  assert.equal(response.status, 302, await response.text());
  const location = new URL(response.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, IDP_SSO_URL);
  const request = inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!,
    relayState: location.searchParams.get("RelayState")!,
    requestId: /ID="([^"]+)"/u.exec(request)![1]!,
  };
}

async function post(baseUrl: string, sp: { acsUrl: string }, form: Record<string, string>, cookie?: string): Promise<{ status: number; location: URL; completionCookie: string }> {
  const response = await fetch(`${baseUrl}${new URL(sp.acsUrl).pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(form).toString(),
  });
  const completionCookie = (response.headers.getSetCookie().find((line) => line.startsWith("raft_sso_done_")) ?? "").split(";")[0]!;
  return { status: response.status, location: new URL(response.headers.get("location")!, baseUrl), completionCookie };
}

async function activate(baseUrl: string, call: Awaited<ReturnType<typeof setup>>["call"], sp: { entityId: string; acsUrl: string }) {
  const leg = await startLeg(baseUrl, (await call("POST", "/test")).body!.url);
  const back = await post(baseUrl, sp, { SAMLResponse: samlResponse(sp, leg.requestId, { email: "it@acme.test" }), RelayState: leg.relayState }, leg.cookie);
  assert.equal(back.location.searchParams.get("sso_test"), "ok");
}

test("SAML: the owner's test activates, a person signs in, and the SP metadata names the ACS", async ({ app }) => {
  const { server, call, sp } = await setup(app.baseUrl);
  await activate(app.baseUrl, call, sp);
  const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.equal(connection!.status, "active");

  const metadata = await fetch(`${app.baseUrl}${new URL(sp.entityId).pathname}`).then((r) => r.text());
  assert.match(metadata, new RegExp(`entityID="${sp.entityId}"`, "u"));
  assert.match(metadata, new RegExp(`Location="${sp.acsUrl}"`, "u"));

  const startUrl = ((await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "sam@acme.test" }),
  }).then((r) => r.json())) as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
  const leg = await startLeg(app.baseUrl, startUrl);
  const back = await post(app.baseUrl, sp, { SAMLResponse: samlResponse(sp, leg.requestId, { email: "sam@acme.test", nameId: "sam-123" }), RelayState: leg.relayState }, leg.cookie);
  assert.equal(back.location.searchParams.get("auth_callback"), "sso", back.location.toString());
  assert.match(back.completionCookie, /^raft_sso_done_[0-9a-f]{16}=/u, "the ACS binds the code to this browser");

  // Another browser (the code without its cookie) is refused, and the code is spent.
  const elsewhereLeg = await startLeg(app.baseUrl, startUrl);
  const elsewhereBack = await post(app.baseUrl, sp, { SAMLResponse: samlResponse(sp, elsewhereLeg.requestId, { email: "sam@acme.test", nameId: "sam-123" }), RelayState: elsewhereLeg.relayState }, elsewhereLeg.cookie);
  const elsewhere = await fetch(`${app.baseUrl}/api/auth/sso/complete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: elsewhereBack.location.searchParams.get("code"), ...LEGAL }),
  });
  assert.equal(elsewhere.status, 400);
  assert.equal(((await elsewhere.json()) as { code: string }).code, "browser_mismatch");

  const done = await fetch(`${app.baseUrl}/api/auth/sso/complete`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: back.completionCookie }, body: JSON.stringify({ code: back.location.searchParams.get("code"), ...LEGAL }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  const [identity] = await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.connectionId, connection!.id));
  assert.equal(identity!.subject, "sam-123", "the persistent NameID is the subject");
});

test("SAML: unsigned, foreign-signed, wrong-audience, transient and replayed answers are refused", async ({ app }) => {
  const { call, sp } = await setup(app.baseUrl);
  await activate(app.baseUrl, call, sp);
  const startUrl = async () => ((await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "eve@acme.test" }),
  }).then((r) => r.json())) as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
  const refusedWith = async (answer: Answer) => {
    const leg = await startLeg(app.baseUrl, await startUrl());
    const back = await post(app.baseUrl, sp, { SAMLResponse: samlResponse(sp, leg.requestId, answer), RelayState: leg.relayState }, leg.cookie);
    return back.location.searchParams.get("error");
  };
  assert.equal(await refusedWith({ email: "eve@acme.test", signWith: "none" }), "idp_answer_refused", "unsigned");
  assert.equal(await refusedWith({ email: "eve@acme.test", signWith: "attacker" }), "idp_answer_refused", "signed by someone else");
  assert.equal(await refusedWith({ email: "eve@acme.test", audience: "https://other-sp.test" }), "idp_answer_refused", "another audience");
  assert.equal(await refusedWith({ email: "eve@acme.test", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" }), "idp_answer_refused", "not persistent");
  assert.equal(await refusedWith({ email: "eve@acme.test", issuer: "https://another-entity.test" }), "idp_answer_refused", "another Issuer, same key");
  assert.equal(await refusedWith({ email: "eve@acme.test", sha1: true }), "idp_answer_refused", "SHA-1");

  // A leg's answer posted to another connection's ACS.
  const other = await startLeg(app.baseUrl, await startUrl());
  const elsewhere = await fetch(`${app.baseUrl}/api/auth/sso/saml/acs/${randomUUID()}`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: other.cookie },
    body: new URLSearchParams({ SAMLResponse: samlResponse(sp, other.requestId, { email: "eve@acme.test" }), RelayState: other.relayState }).toString(),
  });
  assert.equal(new URL(elsewhere.headers.get("location")!, app.baseUrl).searchParams.get("error"), "idp_answer_refused");

  // The same answer twice: the leg is claimed once.
  const leg = await startLeg(app.baseUrl, await startUrl());
  const response = samlResponse(sp, leg.requestId, { email: "eve@acme.test" });
  const first = await post(app.baseUrl, sp, { SAMLResponse: response, RelayState: leg.relayState }, leg.cookie);
  assert.equal(first.location.searchParams.get("auth_callback"), "sso");
  const again = await post(app.baseUrl, sp, { SAMLResponse: response, RelayState: leg.relayState }, leg.cookie);
  assert.equal(again.location.searchParams.get("error"), "sso_link_expired");
  assert.equal((await getDb().select().from(users).where(eq(users.email, "eve@acme.test"))).length, 0, "no account until completion");
});

test("SAML: an unsolicited answer is not validated and starts a normal sign-in", async ({ app }) => {
  const { server, call, sp } = await setup(app.baseUrl);
  await activate(app.baseUrl, call, sp);
  const back = await post(app.baseUrl, sp, { SAMLResponse: samlResponse(sp, "_unsolicited", { email: "ida@acme.test" }) });
  assert.equal(back.status, 303);
  assert.equal(back.location.pathname, "/api/auth/sso/start", "an opaque start link");
  assert.doesNotMatch(back.location.toString(), new RegExp(server.id, "u"), "the answer reveals no Server");
});

test("SAML: a signature-wrapping answer (a forged assertion beside a signed one) is refused", async ({ app }) => {
  const { call, sp } = await setup(app.baseUrl);
  await activate(app.baseUrl, call, sp);
  const startUrl = ((await fetch(`${app.baseUrl}/api/auth/sso/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "vic@acme.test" }),
  }).then((r) => r.json())) as { connections: Array<{ startUrl: string }> }).connections[0]!.startUrl;
  const leg = await startLeg(app.baseUrl, startUrl);
  const genuine = Buffer.from(samlResponse(sp, leg.requestId, { email: "mallory@acme.test", nameId: "mallory" }), "base64").toString("utf8");
  // Copy the signed assertion, change who it is about, drop its signature, and put it first.
  const signed = /<saml:Assertion[\s\S]*<\/saml:Assertion>/u.exec(genuine)![0];
  const forged = signed
    .replace(/ID="[^"]+"/u, `ID="_forged${randomBytes(6).toString("hex")}"`)
    .replace(/<ds:Signature[\s\S]*<\/ds:Signature>|<Signature[\s\S]*<\/Signature>/u, "")
    .replace(">mallory<", ">vic<")
    .replace("mallory@acme.test", "vic@acme.test");
  const wrapped = genuine.replace(signed, forged + signed);
  const back = await post(app.baseUrl, sp, { SAMLResponse: Buffer.from(wrapped).toString("base64"), RelayState: leg.relayState }, leg.cookie);
  assert.equal(back.location.searchParams.get("error"), "idp_answer_refused", "two assertions are refused");
  assert.equal((await getDb().select().from(users).where(eq(users.email, "vic@acme.test"))).length, 0);
});

test("SAML: an assertion ID is accepted once per connection (the replay table, defence in depth)", async ({ app }) => {
  const { server } = await setup(app.baseUrl);
  const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  const until = Date.now() + 60_000;
  assert.equal(await rememberSamlAssertion(connection!.id, "assertion-1", until), true);
  assert.equal(await rememberSamlAssertion(connection!.id, "assertion-1", until), false, "a replay");
  assert.equal(await rememberSamlAssertion(connection!.id, "assertion-2", until), true);
});

async function refusalReasons(serverId: string): Promise<string[]> {
  const rows = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, "sso.sign_in_refused")));
  return rows.map((row) => String((row.metadata as { reason?: unknown } | null)?.reason));
}

test("SAML: SHA-1 is refused even when the Algorithm URIs are entity-encoded", async ({ app }) => {
  const { server, call, sp } = await setup(app.baseUrl);
  await activate(app.baseUrl, call, sp);
  const leg = await startLeg(app.baseUrl, await discoverStart(app.baseUrl, "enc@acme.test"));
  const response = samlResponse(sp, leg.requestId, { email: "enc@acme.test", sha1: true, encodeAlgorithms: true });
  assert.match(Buffer.from(response, "base64").toString("utf8"), /xmldsig&#x23;rsa-sha1/u, "the encoded form is what is sent");
  const back = await post(app.baseUrl, sp, { SAMLResponse: response, RelayState: leg.relayState }, leg.cookie);
  assert.equal(back.location.searchParams.get("error"), "idp_answer_refused");
  assert.deepEqual(await refusalReasons(server.id), ["saml_weak_signature"]);

  // SHA-256 in the same encoded form is accepted: the check reads the decoded value.
  const ok = await startLeg(app.baseUrl, await discoverStart(app.baseUrl, "enc@acme.test"));
  const fine = await post(app.baseUrl, sp, { SAMLResponse: samlResponse(sp, ok.requestId, { email: "enc@acme.test", encodeAlgorithms: true }), RelayState: ok.relayState }, ok.cookie);
  assert.equal(fine.location.searchParams.get("auth_callback"), "sso", fine.location.toString());
});

test("SAML: a RelayState that names a leg but arrives without its cookie fails instead of starting another leg", async ({ app }) => {
  const { call, sp } = await setup(app.baseUrl);
  await activate(app.baseUrl, call, sp);
  const leg = await startLeg(app.baseUrl, await discoverStart(app.baseUrl, "jo@acme.test"));
  const form = { SAMLResponse: samlResponse(sp, leg.requestId, { email: "jo@acme.test" }), RelayState: leg.relayState };
  const missing = await post(app.baseUrl, sp, form);
  assert.equal(missing.location.searchParams.get("error"), "sso_cookie_missing", missing.location.toString());
  const foreign = await post(app.baseUrl, sp, form, `${leg.cookie.split("=")[0]}=someone-else`);
  assert.equal(foreign.location.searchParams.get("error"), "sso_state_mismatch");
  // An unknown RelayState is still treated as unsolicited.
  const unknown = await post(app.baseUrl, sp, { ...form, RelayState: "not-a-leg" });
  assert.equal(unknown.location.pathname, "/api/auth/sso/start");
});

test("SAML: an existing account is linked by email only after the owner's attestation, and a link never moves to a new subject", async ({ app }) => {
  const { server, call, sp } = await setup(app.baseUrl);
  await activate(app.baseUrl, call, sp);
  const carol = await existingAccount(`carol-${randomUUID().slice(0, 6)}@acme.test`);
  assert.deepEqual(await signIn(app.baseUrl, sp, { email: carol.email, nameId: "carol-1" }), { status: 403, code: "email_link_not_attested" });
  const created = await signIn(app.baseUrl, sp, { email: "newbie@acme.test", nameId: "newbie-1" });
  assert.equal(created.status, 200, "a new account is still created without the attestation");

  // The owner attests (a draft, promoted by the test sign-in; the IdP is the same, so links stay).
  const saved = await call("PUT", "/connection", { protocol: "saml", displayName: "Acme SAML", idpEntityId: IDP_ENTITY, idpSsoUrl: IDP_SSO_URL, idpCertificates: [idp.cert], emailManagedByAdmins: true });
  assert.ok(saved.status < 300, JSON.stringify(saved.body));
  await activate(app.baseUrl, call, sp);
  const [connection] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.equal(connection!.config.protocol === "saml" && connection!.config.emailManagedByAdmins, true);
  assert.equal((await getDb().select().from(ssoIdentities).where(eq(ssoIdentities.connectionId, connection!.id))).length, 1, "newbie's link survived");

  assert.equal((await signIn(app.baseUrl, sp, { email: carol.email, nameId: "carol-1" })).status, 200, "linked after attesting");
  // Someone else at the IdP now carries carol's email under a new subject: never moved.
  assert.deepEqual(await signIn(app.baseUrl, sp, { email: carol.email, nameId: "carol-2" }), { status: 403, code: "identity_subject_changed" });
  const links = await getDb().select().from(ssoIdentities).where(and(eq(ssoIdentities.connectionId, connection!.id), eq(ssoIdentities.userId, carol.id)));
  assert.deepEqual(links.map((link) => link.subject), ["carol-1"]);
});
