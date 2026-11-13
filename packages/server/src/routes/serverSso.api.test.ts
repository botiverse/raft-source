import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { featureFlags, integrationAuditEvents, serverMembers, serverSsoConnections, serverSsoDomains, users } from "../db/schema";
import { SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { createServer } from "../services/serverService";
import { SSO_SECRET_KEY_ENV } from "../services/sso/ssoConnectionSecret";
import { checkServerSsoDomain, recheckServerSsoDomains, setSsoTxtResolverForTests, SSO_DOMAIN_ABSENCE_CONFIRM_MS } from "../services/sso/ssoDomains";

// SSO settings routes (rfcs/083-server-sso.md §4, §5.5, §7): the flag, who
// may do what (manageSso owner only; domains for owners and admins), the
// draft/live rule, the sealed secret, domain verification and the audit trail.

const test = createApiTest();

const savedKey = process.env[SSO_SECRET_KEY_ENV];
beforeAll(() => {
  process.env[SSO_SECRET_KEY_ENV] = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (savedKey === undefined) delete process.env[SSO_SECRET_KEY_ENV];
  else process.env[SSO_SECRET_KEY_ENV] = savedKey;
  setSsoTxtResolverForTests(null);
});

type Json = Record<string, any>;

async function setFlag(key: string, defaultEnabled: boolean): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key, randomizationUnit: "server", salt: "test", defaultEnabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled } });
}

const setSsoFlag = (on: boolean) => setFlag(SERVER_SSO_FEATURE_FLAG_KEY, on);
/** The platform's review of "Require SSO" (`server_sso_required_v1`). */
const setReviewedFlag = (on: boolean) => setFlag(SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY, on);

async function createUser(prefix: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${prefix}-${suffix}@slock.test`,
    name: `${prefix}-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function setup(baseUrl: string) {
  const [owner, admin, member] = await Promise.all([createUser("sso-owner"), createUser("sso-admin"), createUser("sso-member")]);
  const server = await createServer("SSO API", `sso-api-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [ownerToken, adminToken, memberToken] = await Promise.all([
    login(baseUrl, owner.email), login(baseUrl, admin.email), login(baseUrl, member.email),
  ]);
  const url = `${baseUrl}/api/servers/${server.id}/sso`;
  const call = async (token: string, method: string, path = "", body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as Json | null, text };
  };
  return { server, owner, ownerToken, adminToken, memberToken, call };
}

async function ssoAudit(serverId: string) {
  return getDb().select({ eventType: integrationAuditEvents.eventType, actorType: integrationAuditEvents.actorType, metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventCategory, "sso")));
}

async function auditTypes(serverId: string): Promise<string[]> {
  return (await ssoAudit(serverId)).map((row) => row.eventType).sort();
}

const oidc = { protocol: "oidc", displayName: "Acme", issuer: "https://acme.okta.com", clientId: "raft-client" };

test("SSO settings answer 404 while server_sso_v1 is off", async ({ app }) => {
  await setSsoFlag(false);
  const { ownerToken, call } = await setup(app.baseUrl);
  assert.equal((await call(ownerToken, "GET")).status, 404);
  assert.equal((await call(ownerToken, "PUT", "/connection", { ...oidc, clientSecret: "x" })).status, 404);
});

test("the connection is the owner's, sealed, and an active one keeps its live config while an edit waits", async ({ app }) => {
  await setSsoFlag(true);
  const { server, ownerToken, adminToken, memberToken, call } = await setup(app.baseUrl);

  assert.equal((await call(memberToken, "GET")).status, 403);
  const adminRead = await call(adminToken, "GET");
  assert.equal(adminRead.status, 200, adminRead.text);
  assert.equal(adminRead.body!.canManageConnection, false);
  assert.equal(adminRead.body!.canManageDomains, true);
  assert.equal(adminRead.body!.connection, null);
  assert.equal((await call(adminToken, "PUT", "/connection", { ...oidc, clientSecret: "x" })).status, 403);

  const noSecret = await call(ownerToken, "PUT", "/connection", oidc);
  assert.equal(noSecret.status, 400);
  assert.equal(noSecret.body!.field, "clientSecret");

  const created = await call(ownerToken, "PUT", "/connection", { ...oidc, clientSecret: "very-secret-value" });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body!.connection.status, "draft");
  assert.equal(created.body!.connection.hasClientSecret, true);
  assert.equal(created.body!.connection.rules.autoJoin, false, "auto-join is off by default");
  assert.match(created.body!.connection.serviceProvider.oidcRedirectUri, /\/api\/auth\/sso\/oidc\/callback$/u);
  assert.doesNotMatch(created.text, /very-secret-value/u);
  const [stored] = await getDb().select().from(serverSsoConnections).where(eq(serverSsoConnections.serverId, server.id));
  assert.doesNotMatch(stored!.clientSecretCiphertext!, /very-secret-value/u);

  const movedIssuer = await call(ownerToken, "PUT", "/connection", { ...oidc, issuer: "https://attacker.example" });
  assert.equal(movedIssuer.status, 400, "a stored secret never follows a new issuer");
  assert.equal(movedIssuer.body!.field, "clientSecret");
  assert.equal((await call(ownerToken, "PUT", "/connection", { ...oidc, clientId: "other-client" })).status, 400);
  const editedDraft = await call(ownerToken, "PUT", "/connection", { ...oidc, displayName: "Acme Corp" });
  assert.equal(editedDraft.status, 200, editedDraft.text);
  assert.equal(editedDraft.body!.connection.displayName, "Acme Corp");
  assert.equal(editedDraft.body!.connection.hasClientSecret, true, "an edit without a secret keeps it");

  await getDb().update(serverSsoConnections).set({ status: "active" }).where(eq(serverSsoConnections.id, stored!.id));
  const editedActive = await call(ownerToken, "PUT", "/connection", { ...oidc, issuer: "https://acme-new.okta.com", clientSecret: "new-secret" });
  assert.equal(editedActive.status, 200, editedActive.text);
  assert.equal(editedActive.body!.connection.config.issuer, "https://acme.okta.com", "the live config is untouched");
  assert.equal(editedActive.body!.connection.draft.config.issuer, "https://acme-new.okta.com");
  assert.equal(editedActive.body!.connection.draft.replacesClientSecret, true);
  const draftAgain = await call(ownerToken, "PUT", "/connection", { ...oidc, displayName: "Acme Inc", issuer: "https://acme-new.okta.com" });
  assert.equal(draftAgain.body!.connection.draft.replacesClientSecret, true, "a second edit without a secret keeps the draft's");
  const draftMoved = await call(ownerToken, "PUT", "/connection", { ...oidc, issuer: "https://attacker.example" });
  assert.equal(draftMoved.status, 400, "nor does a live or draft secret follow a draft to a new issuer");

  const rules = await call(ownerToken, "PATCH", "/rules", { autoJoin: true, sessionMaxAgeDays: 14 });
  assert.equal(rules.status, 200, rules.text);
  assert.deepEqual(rules.body!.connection.rules, { autoJoin: true, required: false, sessionMaxAgeDays: 14 });
  await setReviewedFlag(false);
  assert.equal((await call(ownerToken, "GET")).body!.requireReviewed, false);
  const unreviewed = await call(ownerToken, "PATCH", "/rules", { required: true });
  assert.equal(unreviewed.status, 409, "only an organization the platform reviewed can require SSO");
  assert.equal(unreviewed.body!.code, "sso_required_not_reviewed");
  await setReviewedFlag(true);
  assert.equal((await call(ownerToken, "GET")).body!.requireReviewed, true);
  const required = await call(ownerToken, "PATCH", "/rules", { required: true });
  assert.equal(required.status, 200, required.text);
  await setReviewedFlag(false);
  assert.equal((await call(ownerToken, "PATCH", "/rules", { sessionMaxAgeDays: 7 })).status, 200, "other rules still change once the review is withdrawn");
  assert.equal(required.body!.connection.rules.required, true);
  assert.equal((await call(adminToken, "PATCH", "/rules", { autoJoin: false })).status, 403);

  assert.equal((await call(ownerToken, "DELETE", "/connection")).status, 204);
  assert.equal((await call(ownerToken, "DELETE", "/connection")).status, 404);
  assert.deepEqual(await auditTypes(server.id), [
    "sso.connection_deleted", "sso.connection_saved", "sso.connection_saved", "sso.connection_saved", "sso.connection_saved", "sso.rules_updated", "sso.rules_updated", "sso.rules_updated",
  ]);
  for (const row of await ssoAudit(server.id)) assert.equal((row.metadata as Json).actorRole, "owner", row.eventType);
});

test("admins add and verify domains by DNS; public mail domains are refused", async ({ app }) => {
  await setSsoFlag(true);
  const { server, adminToken, memberToken, call } = await setup(app.baseUrl);

  assert.equal((await call(memberToken, "POST", "/domains", { domain: "acme.com" })).status, 403);
  const publicDomain = await call(adminToken, "POST", "/domains", { domain: "gmail.com" });
  assert.equal(publicDomain.status, 400);
  assert.equal(publicDomain.body!.code, "domain_public");
  assert.equal((await call(adminToken, "POST", "/domains", { domain: "not a domain" })).body!.code, "domain_invalid");

  const added = await call(adminToken, "POST", "/domains", { domain: "Acme.com" });
  assert.equal(added.status, 201, added.text);
  const domain = added.body!.domain;
  assert.equal(domain.domain, "acme.com");
  assert.equal(domain.verified, false);
  assert.equal(domain.record.name, "_raft-verification.acme.com");
  const again = await call(adminToken, "POST", "/domains", { domain: "acme.com" });
  assert.equal(again.status, 200);
  assert.equal(again.body!.domain.id, domain.id);

  setSsoTxtResolverForTests(async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); });
  const absent = await call(adminToken, "POST", `/domains/${domain.id}/verify`);
  assert.equal(absent.status, 200, absent.text);
  assert.equal(absent.body!.result, "absent");
  assert.equal(absent.body!.domain.verified, false);

  const tooSoon = await call(adminToken, "POST", `/domains/${domain.id}/verify`);
  assert.equal(tooSoon.status, 429, "a domain just checked is not checked again at once");
  await getDb().update(serverSsoDomains).set({ lastCheckedAt: new Date(Date.now() - 60_000) }).where(eq(serverSsoDomains.id, domain.id));
  setSsoTxtResolverForTests(async (name) => (name === domain.record.name ? [[domain.record.value]] : []));
  const present = await call(adminToken, "POST", `/domains/${domain.id}/verify`);
  assert.equal(present.body!.result, "present");
  assert.equal(present.body!.domain.verified, true);

  assert.equal((await call(adminToken, "POST", `/domains/${randomUUID()}/verify`)).status, 404);
  assert.equal((await call(adminToken, "POST", "/domains/not-a-uuid/verify")).status, 404);
  assert.equal((await ssoAudit(server.id)).find((row) => row.eventType === "sso.domain_verified")!.metadata!.actorRole, "admin");
  assert.equal((await call(adminToken, "DELETE", `/domains/${domain.id}`)).status, 204);
  assert.deepEqual(await auditTypes(server.id), ["sso.domain_added", "sso.domain_removed", "sso.domain_verified"]);
});

test("a Server the platform reviewed that verifies another domain leaves operators an event and a log line to re-check", async ({ app }) => {
  await setSsoFlag(true);
  const { server, adminToken, call } = await setup(app.baseUrl);
  const verify = async (name: string) => {
    const domain = (await call(adminToken, "POST", "/domains", { domain: name })).body!.domain;
    setSsoTxtResolverForTests(async () => [[domain.record.value]]);
    assert.equal((await call(adminToken, "POST", `/domains/${domain.id}/verify`)).body!.domain.verified, true);
  };
  await setReviewedFlag(false);
  await verify("before-review.com");
  assert.equal((await auditTypes(server.id)).includes("sso.reviewed_domain_verified"), false, "nothing to re-check before a review");

  await setReviewedFlag(true);
  const warned: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    await verify("after-review.com");
  } finally {
    console.warn = originalWarn;
    await setReviewedFlag(false);
  }
  const event = (await ssoAudit(server.id)).find((row) => row.eventType === "sso.reviewed_domain_verified");
  assert.equal((event?.metadata as Json | undefined)?.domain, "after-review.com");
  assert.ok(warned.some((line) => line.startsWith("[sso-review]") && line.includes("after-review.com")), warned.join("\n"));

  // A domain that lapsed and comes back is not new: no second alert.
  await setReviewedFlag(true);
  try {
    const [lapsed] = await getDb().update(serverSsoDomains).set({ verifiedAt: null, lastCheckedAt: new Date(Date.now() - 60_000) })
      .where(and(eq(serverSsoDomains.serverId, server.id), eq(serverSsoDomains.domain, "after-review.com"))).returning();
    setSsoTxtResolverForTests(async () => [[`raft-domain-verification=${lapsed!.verificationToken}`]]);
    assert.equal((await call(adminToken, "POST", `/domains/${lapsed!.id}/verify`)).body!.domain.verified, true);
  } finally {
    await setReviewedFlag(false);
  }
  assert.equal((await ssoAudit(server.id)).filter((row) => row.eventType === "sso.reviewed_domain_verified").length, 1);
});

test("the maintenance re-check unverifies a domain whose record is confirmed gone, and only then", async ({ app }) => {
  await setSsoFlag(true);
  const { server, adminToken, call } = await setup(app.baseUrl);
  const domain = (await call(adminToken, "POST", "/domains", { domain: "acme.com" })).body!.domain;
  setSsoTxtResolverForTests(async () => [[domain.record.value]]);
  assert.equal((await call(adminToken, "POST", `/domains/${domain.id}/verify`)).body!.domain.verified, true);

  const t0 = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const missing = async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); };
  const failing = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); };
  assert.deepEqual(await recheckServerSsoDomains({ resolveTxt: missing, now: () => t0 }), { checked: 1, unverified: 0 });
  assert.deepEqual(await recheckServerSsoDomains({ resolveTxt: failing, now: () => new Date(t0.getTime() + 1000) }), { checked: 1, unverified: 0 });
  assert.deepEqual(
    await recheckServerSsoDomains({ resolveTxt: missing, now: () => new Date(t0.getTime() + SSO_DOMAIN_ABSENCE_CONFIRM_MS) }),
    { checked: 1, unverified: 1 },
  );
  // A slow "present" that asked DNS before the confirmed absence was stored is dropped.
  const stale = await checkServerSsoDomain(
    { serverId: server.id, domainId: domain.id, actor: { type: "system" }, source: "system" },
    { resolveTxt: async () => [[domain.record.value]], now: () => t0 },
  );
  assert.equal(stale?.superseded, true);
  const after = await call(adminToken, "GET");
  assert.equal(after.body!.domains[0].verified, false);
  const unverified = (await ssoAudit(server.id)).find((row) => row.eventType === "sso.domain_unverified");
  assert.equal(unverified?.actorType, "system");
  // Unverified domains are not swept again.
  assert.deepEqual(await recheckServerSsoDomains({ resolveTxt: missing, now: () => new Date(t0.getTime() + 2 * SSO_DOMAIN_ABSENCE_CONFIRM_MS) }), { checked: 0, unverified: 0 });
});

test("admins are told once when a domain's lookups fail for a day, and when it loses verification", async ({ app }) => {
  await setSsoFlag(true);
  const { server, adminToken, call } = await setup(app.baseUrl);
  void adminToken;
  const domain = (await call(adminToken, "POST", "/domains", { domain: "acme.com" })).body!.domain;
  setSsoTxtResolverForTests(async () => [[domain.record.value]]);
  assert.equal((await call(adminToken, "POST", `/domains/${domain.id}/verify`)).body!.domain.verified, true);

  const failing = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); };
  const t0 = Date.now() + 25 * 60 * 60 * 1000;
  const notices = async (type: string) => (await ssoAudit(server.id)).filter((row) => row.eventType === type).length;
  await recheckServerSsoDomains({ resolveTxt: failing, now: () => new Date(t0) });
  assert.equal(await notices("sso.domain_lookup_failing_notice"), 0, "not after one failure");
  await recheckServerSsoDomains({ resolveTxt: failing, now: () => new Date(t0 + 24 * 60 * 60 * 1000) });
  assert.equal(await notices("sso.domain_lookup_failing_notice"), 1, "after a day of failures");
  await recheckServerSsoDomains({ resolveTxt: failing, now: () => new Date(t0 + 25 * 60 * 60 * 1000) });
  assert.equal(await notices("sso.domain_lookup_failing_notice"), 1, "once per streak");

  const missing = async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); };
  await recheckServerSsoDomains({ resolveTxt: missing, now: () => new Date(t0 + 26 * 60 * 60 * 1000) });
  await recheckServerSsoDomains({ resolveTxt: missing, now: () => new Date(t0 + 28 * 60 * 60 * 1000) });
  assert.equal(await notices("sso.domain_unverified_notice"), 1, "told when it lost verification");
});
