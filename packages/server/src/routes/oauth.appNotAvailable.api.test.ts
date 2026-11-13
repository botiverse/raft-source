import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { integrationAuditEvents, oauthAccessRequests, oauthClientInstalls, oauthClients, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { currentAppPermissions } from "../test/integration/appPermissions";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { addMember, createServer } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { createOAuthClient, installMarketplaceOAuthClient } from "../services/oauthService";

// RFC 079 2a: when an app is not available to the signed-in person on the
// Server they chose, the setup page's lookup and its continue give one answer,
// the same status and bytes, whether the client is unknown, the Server is
// outside the app's audience, or the person is not a member there (D4). And
// membership is decided first (L1), so a non-member can't learn that an
// installation is suspended, or anything else about the app on that Server.
const test = createApiTest();

const RETURN_URL = "https://audience.example.test/login/raft/callback";
const REFUSAL = { status: 403, body: JSON.stringify({ error: "This app isn't available to you.", code: "app_not_available" }) };

type Base = { baseUrl: string };

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return { ...user, bearer: await tokenForHuman(user.email) };
}

/**
 * Server S with an owner, admin, member and guest; an outsider who is in the
 * publisher Server but not in S; and one app of each availability on S.
 */
async function seedAudience() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("aud-owner");
  const admin = await seedUser("aud-admin");
  const member = await seedUser("aud-member");
  const guest = await seedUser("aud-guest");
  const outsider = await seedUser("aud-outsider");
  const server = await createServer("Audience", `aud-${suffix}`, owner.id);
  const publisher = await createServer("Publisher", `aud-pub-${suffix}`, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, member.id, "member");
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  await addMember(publisher.id, outsider.id, "member");

  const register = async (label: string, serverId: string, appType: "server_local" | "third_party_global") => (
    await createOAuthClient({
      serverId,
      createdByUserId: owner.id,
      appType,
      clientId: `aud-${label}-${suffix}`,
      name: `Audience ${label}`,
      returnUrl: RETURN_URL,
      allowedScopes: ["openid", "profile"],
    })
  ).client;
  const publish = (clientId: string) => getDb().update(oauthClients)
    .set({ enabled: true, publishStatus: "published", humanMarketplaceVisible: true })
    .where(eq(oauthClients.id, clientId));
  const install = async (clientId: string) => assert.ok(await installMarketplaceOAuthClient({
    serverId: server.id,
    clientId,
    installedByUserId: owner.id,
    expected: await currentAppPermissions(clientId),
  }));

  const local = await register("local", server.id, "server_local");
  const otherLocal = await register("other-local", publisher.id, "server_local");
  const privateGlobal = await register("private", publisher.id, "third_party_global");
  const installed = await register("installed", publisher.id, "third_party_global");
  const suspended = await register("suspended", publisher.id, "third_party_global");
  const marketplace = await register("marketplace", publisher.id, "third_party_global");
  for (const client of [installed, suspended, marketplace]) await publish(client.id);
  await install(installed.id);
  await install(suspended.id);
  await getDb().update(oauthClientInstalls).set({ status: "suspended" }).where(and(
    eq(oauthClientInstalls.clientId, suspended.id),
    eq(oauthClientInstalls.serverId, server.id),
  ));

  return {
    owner, admin, member, guest, outsider, server,
    local, otherLocal, privateGlobal, installed, suspended, marketplace,
  };
}

function lookup(app: Base, bearer: string, clientKey: string, serverId: string) {
  return fetch(`${app.baseUrl}/api/oauth/clients/lookup?${new URLSearchParams({ client_id: clientKey, server_id: serverId })}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

function continueLogin(app: Base, bearer: string, body: Record<string, unknown>) {
  return fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function legacyBody(clientKey: string, serverId: string, extra: Record<string, unknown> = {}) {
  return { clientId: clientKey, serverId, returnUrl: RETURN_URL, scopes: ["openid", "profile"], ...extra };
}

function oidcBody(clientKey: string, serverId: string, extra: Record<string, unknown> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  return {
    ...legacyBody(clientKey, serverId),
    oidc: true,
    nonce: `nonce-${randomUUID()}`,
    codeChallenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
    codeChallengeMethod: "S256",
    ...extra,
  };
}

/** Both continue shapes the setup page sends. */
function continueBodies(clientKey: string, serverId: string, extra: Record<string, unknown> = {}) {
  return [
    ["legacy", legacyBody(clientKey, serverId, extra)],
    ["OIDC", oidcBody(clientKey, serverId, extra)],
  ] as const;
}

async function answer(res: Response) {
  return { status: res.status, body: await res.text() };
}

/** Codes issued, and the audit trail's record of them. */
async function issuedCodes() {
  const requests = await getDb().select({ id: oauthAccessRequests.id }).from(oauthAccessRequests)
    .where(eq(oauthAccessRequests.principalType, "human"));
  const issuedEvents = (await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "oauth.lifecycle"), eq(integrationAuditEvents.outcome, "success"))))
    .filter((row) => row.metadata.result === "issued" && row.metadata.principalType === "human");
  return { requests: requests.length, issuedEvents: issuedEvents.length };
}

test("an unknown client, a Server outside the audience and a non-member get the same 403 app_not_available, byte for byte, on the lookup and the continue", async ({ app }) => {
  const f = await seedAudience();
  const unknownKey = `aud-unknown-${randomUUID().slice(0, 8)}`;
  const cases: Array<[label: string, bearer: string, clientKey: string, serverId: string]> = [
    ["unknown client", f.member.bearer, unknownKey, f.server.id],
    ["server-local app of another Server", f.member.bearer, f.otherLocal.clientId, f.server.id],
    ["private third-party app not installed here", f.member.bearer, f.privateGlobal.clientId, f.server.id],
    ["non-member, server-local app of this Server", f.outsider.bearer, f.local.clientId, f.server.id],
    ["non-member, app installed here", f.outsider.bearer, f.installed.clientId, f.server.id],
    ["non-member, installation suspended here", f.outsider.bearer, f.suspended.clientId, f.server.id],
    ["non-member, public Marketplace app", f.outsider.bearer, f.marketplace.clientId, f.server.id],
    ["non-member, unknown client", f.outsider.bearer, unknownKey, f.server.id],
    ["a Server that doesn't exist", f.member.bearer, f.local.clientId, randomUUID()],
    ["not a Server id", f.member.bearer, f.local.clientId, "not-a-server-id"],
  ];
  const before = await issuedCodes();

  for (const [label, bearer, clientKey, serverId] of cases) {
    assert.deepEqual(await answer(await lookup(app, bearer, clientKey, serverId)), REFUSAL, `lookup: ${label}`);
    for (const [shape, body] of continueBodies(clientKey, serverId)) {
      assert.deepEqual(await answer(await continueLogin(app, bearer, body)), REFUSAL, `continue (${shape}): ${label}`);
    }
  }

  assert.deepEqual(await issuedCodes(), before, "no authorization code was issued on any refused continue");
});

test("membership is decided before suspension and everything else (L1): a non-member can't tell a suspended installation, a wrong callback, scope or Server hint from any other refusal", async ({ app }) => {
  const f = await seedAudience();
  const before = await issuedCodes();

  // A member is told the installation here is suspended...
  const memberLookup = await lookup(app, f.member.bearer, f.suspended.clientId, f.server.id);
  assert.equal(memberLookup.status, 200);
  const memberLookupBody = await memberLookup.json() as { availability: string; installation?: unknown };
  assert.equal(memberLookupBody.availability, "suspended");
  assert.equal(memberLookupBody.installation, undefined, "a suspended installation offers no install");
  for (const [shape, body] of continueBodies(f.suspended.clientId, f.server.id)) {
    const refused = await continueLogin(app, f.member.bearer, body);
    assert.equal(refused.status, 403, shape);
    const refusedBody = await refused.json() as { error: string; errorCode: string };
    assert.equal(refusedBody.error, "installation_suspended", shape);
    assert.equal(refusedBody.errorCode, "OAUTH_INSTALLATION_SUSPENDED", shape);
  }

  // ...a non-member gets the refusal they would get for an app that isn't there.
  assert.deepEqual(await answer(await lookup(app, f.outsider.bearer, f.suspended.clientId, f.server.id)), REFUSAL);
  for (const [shape, body] of continueBodies(f.suspended.clientId, f.server.id)) {
    assert.deepEqual(await answer(await continueLogin(app, f.outsider.bearer, body)), REFUSAL, shape);
  }

  // The rest of the continue's checks come after membership too. Each one
  // refuses a member (400), so it is reached; a non-member never gets there.
  const restOfTheChecks: Array<[label: string, body: Record<string, unknown>]> = [
    ["a callback that isn't registered", legacyBody(f.installed.clientId, f.server.id, { returnUrl: "https://attacker.example.test/callback" })],
    ["a scope the app can't ask for", legacyBody(f.installed.clientId, f.server.id, { scopes: ["openid", "agent:read"] })],
    ["a Server hint for another Server", oidcBody(f.installed.clientId, f.server.id, { server: "another-server" })],
  ];
  for (const [label, body] of restOfTheChecks) {
    assert.equal((await continueLogin(app, f.member.bearer, body)).status, 400, `member: ${label}`);
    assert.deepEqual(await answer(await continueLogin(app, f.outsider.bearer, body)), REFUSAL, `non-member: ${label}`);
  }

  assert.deepEqual(await issuedCodes(), before, "no authorization code was issued");
});

test("members keep ready, the Marketplace install offer by role, and suspended; the continue issues a code only where the app is available", async ({ app }) => {
  const f = await seedAudience();

  for (const [label, bearer, client] of [
    ["server-local app, member", f.member.bearer, f.local],
    ["installed app, member", f.member.bearer, f.installed],
    ["installed app, guest", f.guest.bearer, f.installed],
  ] as const) {
    const ready = await lookup(app, bearer, client.clientId, f.server.id);
    assert.equal(ready.status, 200, label);
    assert.equal((await ready.json() as { availability: string }).availability, "ready", label);
  }

  // A public Marketplace app not installed here: owners and admins can install inline (D5).
  for (const [role, user, canInstall] of [
    ["owner", f.owner, true],
    ["admin", f.admin, true],
    ["member", f.member, false],
    ["guest", f.guest, false],
  ] as const) {
    const offer = await lookup(app, user.bearer, f.marketplace.clientId, f.server.id);
    assert.equal(offer.status, 200, role);
    const offerBody = await offer.json() as { availability: string; marketplace: boolean; installation: { serverId: string; canInstall: boolean } };
    assert.equal(offerBody.availability, "install_required", role);
    assert.equal(offerBody.marketplace, true, role);
    assert.deepEqual(offerBody.installation, { serverId: f.server.id, canInstall }, role);
    assert.equal("bot" in offerBody, false, `${role}: an App without a bot offers none`);
  }

  // An App that ships a bot: the install offer names the handle it would join as,
  // so the page can say "Also add @handle" and send `bot` with the install.
  await getDb().update(oauthClients).set({ enableBot: true }).where(eq(oauthClients.id, f.marketplace.id));
  const botOffer = await lookup(app, f.admin.bearer, f.marketplace.clientId, f.server.id);
  assert.equal(botOffer.status, 200);
  const { deriveAppBotHandle } = await import("../services/appBotIdentityService");
  assert.deepEqual((await botOffer.json() as { bot?: unknown }).bot, { handle: deriveAppBotHandle(f.marketplace.clientId) });
  await getDb().update(oauthClients).set({ enableBot: false }).where(eq(oauthClients.id, f.marketplace.id));

  const suspended = await lookup(app, f.member.bearer, f.suspended.clientId, f.server.id);
  assert.equal(suspended.status, 200);
  assert.equal((await suspended.json() as { availability: string }).availability, "suspended");

  for (const client of [f.local, f.installed]) {
    for (const [shape, body] of continueBodies(client.clientId, f.server.id)) {
      const issued = await continueLogin(app, f.member.bearer, body);
      assert.equal(issued.status, 200, `${client.name} (${shape}): ${await issued.clone().text()}`);
      assert.ok((await issued.json() as { code?: string }).code, `${client.name} (${shape})`);
    }
  }

  // The continue never installs: the Marketplace app is outside the audience
  // until someone installs it, for the owner too.
  const before = await issuedCodes();
  for (const [shape, body] of continueBodies(f.marketplace.clientId, f.server.id)) {
    assert.deepEqual(await answer(await continueLogin(app, f.owner.bearer, body)), REFUSAL, shape);
  }
  assert.deepEqual(await issuedCodes(), before);
});
