import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach } from "vitest";
import type { Database, DatabaseExecutor } from "../db";
import {
  featureFlags, integrationAuditEvents, linkCardOperations, oauthAccessTokens, oauthAppLinkPreviews, oauthClientInstalls, oauthLinkPreviewDeclines,
  oauthUserConsents, servers, users,
} from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests, registeredApps } from "../services/appLinkPreviewService";
import { allowLinkPreviews, declineLinkPreviews, listLinkPreviewChoices } from "../services/appLinkPreviewConsentService";
import { __setLinkCardActionHooksForTests } from "../services/linkCardActionService";
import { linkCardReceiptReadable, type LinkCardMessageReader } from "../services/linkCardLiveState";
import { isAccountLoginEnabledFor } from "../services/oauthAccountLogin";
import { OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { createOAuthClient } from "../services/oauthService";
import { seedBoundGuest } from "../test/guestFixture";
import { appAnswer, cardFixture, clientRequestId, handleFor, post, stubApp } from "../test/linkCardActionFixture";

// RFC 079 phase 3b, D17: link previews and link cards of an account-mode App.
// The assertion Raft sends the App is unchanged (it names the viewer's
// current Server); the viewer's answer to the App's prompt is one per
// (viewer, App) instead of one per (viewer, Server, App). Server-mode Apps
// are pinned by appLinkPreviewPrompt.api.test.ts and the link card tests.
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
afterEach(async () => {
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  __setLinkCardActionHooksForTests(null);
  if (originalKey === undefined) delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY; else process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = originalKey;
});
const useSigningKey = () => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
};
const card = { version: 1, title: "Secret" };
type Human = typeof users.$inferSelect;
type Server = typeof servers.$inferSelect;
type App = Awaited<ReturnType<typeof createOAuthClient>>;
type Claims = Record<string, unknown>;

/** A published third-party App with a link-preview registration for `origin`, installed on each of `installOn`. */
async function previewApp(db: Database, owner: Human, publisher: Server, key: string, origin: string, installOn: Server[]): Promise<App> {
  const app = await createOAuthClient({
    serverId: publisher.id, createdByUserId: owner.id, clientId: key, name: key, appType: "third_party_global",
    allowedScopes: ["openid", "profile", "email"], returnUrl: `${origin}/login/raft/callback`,
  });
  for (const server of installOn) await db.insert(oauthClientInstalls).values({ clientId: app.client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthAppLinkPreviews).values({ clientId: app.client.id, origin, endpoint: `${origin}/callback`, paths: ["/s"] });
  return app;
}

/** The reviewed switch's write, with SQL, as db/oauthClientLoginMode.test.ts does. */
async function switchToAccountMode(db: Database, clientId: string) {
  await db.execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${clientId}`);
}

/** The kill switch oauth_account_login for everyone: on (enabled, default on), or off with its kill switch, the runbook's rollback. */
async function setAccountLogin(db: Database, on: boolean) {
  const values = { enabled: true, killSwitch: !on, defaultEnabled: true };
  await db.insert(featureFlags).values({ key: OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "account-link-previews-test", ...values })
    .onConflictDoUpdate({ target: featureFlags.key, set: values });
}

async function headersFor(human: Human, server: Server) {
  return { Authorization: `Bearer ${await tokenForHuman(human.email)}`, "X-Server-Id": server.id };
}

function answer(baseUrl: string, headers: Record<string, string>, clientId: string, choice: "link-preview-consent" | "link-preview-decline") {
  return fetch(`${baseUrl}/api/integrations/clients/${clientId}/${choice}`, { method: "POST", headers });
}

async function readPreviews(baseUrl: string, headers: Record<string, string>, messageId: string) {
  const response = await fetch(`${baseUrl}/api/messages/${messageId}/app-link-previews`, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { previews: Array<{ url: string }>; prompts: Array<{ url: string; app: { id: string } }> };
  return { previews: body.previews.map((preview) => preview.url), prompts: body.prompts.map((prompt) => prompt.app.id) };
}

async function choices(baseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}/api/integrations/link-preview-consents`, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { allowed: Array<{ app: { id: string }; source: string }>; declined: Array<{ app: { id: string } }> };
  return { allowed: body.allowed.map((row) => row.app.id), declined: body.declined.map((row) => row.app.id) };
}

/** Every consent and decline of the person for the App, as `<kind>:<server or every>[:revoked]`, sorted. */
async function rowsOf(db: Database, userId: string, clientId: string, label: (serverId: string | null) => string) {
  const consents = await db.select().from(oauthUserConsents).where(and(eq(oauthUserConsents.userId, userId), eq(oauthUserConsents.clientId, clientId)));
  const declines = await db.select().from(oauthLinkPreviewDeclines).where(and(eq(oauthLinkPreviewDeclines.userId, userId), eq(oauthLinkPreviewDeclines.clientId, clientId)));
  return [
    ...consents.map((row) => `consent:${label(row.serverId)}${row.revokedAt ? ":revoked" : ""}`),
    ...declines.map((row) => `decline:${label(row.serverId)}`),
  ].sort();
}

/** Records each preview callback's assertion claims. */
function recordAssertions() {
  const claims: Claims[] = [];
  __setPreviewHttpForTests(async (_url, _body, assertion) => {
    claims.push(JSON.parse(Buffer.from(assertion!.split(".")[1]!, "base64url").toString()) as Claims);
    return card;
  });
  return claims;
}

/**
 * The App `vault`, installed on A and B (the person a member of both) and
 * published from P; C is a Server of the person's where it is not installed.
 * A message with one of its links on A and on B.
 */
async function seedVault(db: Database, seed: ReturnType<typeof createSeed>, options: { installOnC?: boolean } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seed.human(); const person = await seed.human();
  const publisher = await seed.server({ owner });
  const a = await seed.server({ owner, members: [person] }); const b = await seed.server({ owner, members: [person] }); const c = await seed.server({ owner, members: [person] });
  const origin = `https://vault-${suffix}.example.test`;
  const vault = await previewApp(db, owner, publisher, `vault-${suffix}`, origin, options.installOnC ? [a, b, c] : [a, b]);
  await setAccountLogin(db, true);
  const url = `${origin}/s/1`;
  const message = async (server: Server) => seed.message({ channel: await seed.channel({ server, members: [owner, person] }), author: owner, content: `see ${url}` });
  const label = (serverId: string | null) => serverId === null ? "every" : ({ [a.id]: "A", [b.id]: "B", [c.id]: "C" } as Record<string, string>)[serverId] ?? serverId;
  return {
    owner, person, publisher, a, b, c, vault, url, label,
    messages: { a: await message(a), b: await message(b), c: await message(c) },
    as: { a: await headersFor(person, a), b: await headersFor(person, b), c: await headersFor(person, c) },
  };
}

test("D17: one Allow on any Server covers every Server where the account-mode App is installed; the assertion still names the viewer's current Server", async ({ app, db, seed }) => {
  useSigningKey();
  const f = await seedVault(db, seed, { installOnC: true });
  await switchToAccountMode(db, f.vault.client.id);
  const assertions = recordAssertions();
  assert.equal(await isAccountLoginEnabledFor(f.person.id), true);

  for (const server of ["a", "b", "c"] as const) {
    assert.deepEqual(await readPreviews(app.baseUrl, f.as[server], f.messages[server].id), { previews: [], prompts: [f.vault.client.id] }, `${server}: a prompt first`);
  }
  assert.equal(assertions.length, 0, "a prompt never calls the App");

  const allowed = await answer(app.baseUrl, f.as.a, f.vault.client.id, "link-preview-consent");
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const body = await allowed.json() as { scopes: string[]; source: string };
  assert.deepEqual([body.scopes, body.source], [["openid", "profile"], "preview_prompt"]);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:every"], "one consent for every Server, none per Server");

  for (const server of ["b", "a", "c"] as const) {
    assert.deepEqual(await readPreviews(app.baseUrl, f.as[server], f.messages[server].id), { previews: [f.url], prompts: [] }, `${server}: previewed`);
  }
  assert.deepEqual(assertions.map((claims) => [claims.sub, claims.server_id, claims.server_role, claims.installation_id !== undefined, claims.aud]), [
    [f.person.id, f.b.id, "member", true, `urn:raft:link-preview:${f.vault.client.clientId}`],
    [f.person.id, f.a.id, "member", true, `urn:raft:link-preview:${f.vault.client.clientId}`],
    [f.person.id, f.c.id, "member", true, `urn:raft:link-preview:${f.vault.client.clientId}`],
  ], "the assertion of each read names the Server the viewer reads from");
  const installations = await db.select({ id: oauthClientInstalls.id, serverId: oauthClientInstalls.serverId }).from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, f.vault.client.id));
  assert.deepEqual(assertions.map((claims) => installations.find((row) => row.id === claims.installation_id)?.serverId), [f.b.id, f.a.id, f.c.id],
    "and that Server's installation");

  // Listed once on each Server where it can be changed.
  for (const server of ["a", "b", "c"] as const) assert.deepEqual(await choices(app.baseUrl, f.as[server]), { allowed: [f.vault.client.id], declined: [] }, server);

  const audit = await db.select({ serverId: integrationAuditEvents.serverId, metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.eventType, "link_preview.consent_granted"));
  assert.deepEqual(audit, [{ serverId: f.a.id, metadata: { clientKey: f.vault.client.clientId, consentSource: "preview_prompt", removedDecline: false, loginMode: "account" } }],
    "audited on the Server it was given on, marked as an account-mode answer");
});

test("D17: declining on one Server turns previews off on every Server, and allowing on any Server turns them back on; the choice is listed only where the App is installed", async ({ app, db, seed }) => {
  useSigningKey();
  const f = await seedVault(db, seed);
  await switchToAccountMode(db, f.vault.client.id);
  recordAssertions();
  assert.equal((await answer(app.baseUrl, f.as.a, f.vault.client.id, "link-preview-consent")).status, 200);

  const declined = await answer(app.baseUrl, f.as.b, f.vault.client.id, "link-preview-decline");
  assert.equal(declined.status, 200, await declined.clone().text());
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:every", "decline:every"], "the consent stays; the decline is for every Server");
  for (const server of ["a", "b"] as const) {
    assert.deepEqual(await readPreviews(app.baseUrl, f.as[server], f.messages[server].id), { previews: [], prompts: [] }, `${server}: neither preview nor prompt`);
    assert.deepEqual(await choices(app.baseUrl, f.as[server]), { allowed: [], declined: [f.vault.client.id] }, server);
  }
  assert.deepEqual(await choices(app.baseUrl, f.as.c), { allowed: [], declined: [] }, "not listed where it is not installed");
  // Declining again (as Settings' Revoke does) updates the one row.
  assert.equal((await answer(app.baseUrl, f.as.a, f.vault.client.id, "link-preview-decline")).status, 200);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:every", "decline:every"]);

  assert.equal((await answer(app.baseUrl, f.as.b, f.vault.client.id, "link-preview-consent")).status, 200);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:every"]);
  for (const server of ["a", "b"] as const) {
    assert.deepEqual(await readPreviews(app.baseUrl, f.as[server], f.messages[server].id), { previews: [f.url], prompts: [] }, `${server}: back on`);
  }
  assert.deepEqual((await db.select({ eventType: integrationAuditEvents.eventType, serverId: integrationAuditEvents.serverId, metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "link_preview.declined"))).map((row) => [row.serverId, row.metadata]), [
    [f.b.id, { clientKey: f.vault.client.clientId, loginMode: "account" }],
    [f.a.id, { clientKey: f.vault.client.clientId, loginMode: "account" }],
  ]);
});

test("D17: revoking the App's access (per-app revoke) revokes the preview consent on every Server; a consent that only allowed previews is not listed as a sign-in", async ({ app, db, seed }) => {
  useSigningKey();
  const f = await seedVault(db, seed);
  await switchToAccountMode(db, f.vault.client.id);
  recordAssertions();
  const me = { Authorization: f.as.a.Authorization };
  const logins = async () => {
    const response = await fetch(`${app.baseUrl}/api/me/app-logins`, { headers: me });
    assert.equal(response.status, 200);
    return ((await response.json()) as Array<{ clientId: string }>).map((row) => row.clientId);
  };

  assert.equal((await answer(app.baseUrl, f.as.b, f.vault.client.id, "link-preview-consent")).status, 200);
  assert.deepEqual(await logins(), [], "allowing previews is not signing in");
  // An account-mode sign-in (its token row; the login itself is oauthAccountLogin.api.test.ts's): now it is listed.
  const createdAt = new Date();
  await db.insert(oauthAccessTokens).values({
    serverId: null, principalType: "human", userId: f.person.id, clientId: f.vault.client.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    scopes: ["openid", "profile"], createdAt, expiresAt: new Date(createdAt.getTime() + 3600_000),
  });
  assert.deepEqual(await logins(), [f.vault.client.clientId]);

  const revoked = await fetch(`${app.baseUrl}/api/me/app-logins/${f.vault.client.clientId}`, { method: "DELETE", headers: me });
  assert.equal(revoked.status, 204);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:every:revoked"]);
  for (const server of ["a", "b"] as const) {
    assert.deepEqual(await readPreviews(app.baseUrl, f.as[server], f.messages[server].id), { previews: [], prompts: [f.vault.client.id] }, `${server}: asked again`);
  }
  assert.deepEqual(await logins(), []);
  // Allowing previews again is not a sign-in either, though the revoked token row remains.
  assert.equal((await answer(app.baseUrl, f.as.a, f.vault.client.id, "link-preview-consent")).status, 200);
  assert.deepEqual(await logins(), []);
  assert.deepEqual(await readPreviews(app.baseUrl, f.as.b, f.messages.b.id), { previews: [f.url], prompts: [] });
});

test("D17: a consent or decline given on one Server before the App switched keeps counting on that Server only; an answer after the switch is for every Server", async ({ app, db, seed }) => {
  useSigningKey();
  const f = await seedVault(db, seed, { installOnC: true });
  recordAssertions();
  // Server mode: allowed on A, declined on B.
  assert.equal((await answer(app.baseUrl, f.as.a, f.vault.client.id, "link-preview-consent")).status, 200);
  assert.equal((await answer(app.baseUrl, f.as.b, f.vault.client.id, "link-preview-decline")).status, 200);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:A", "decline:B"]);
  await switchToAccountMode(db, f.vault.client.id);

  const read = async () => ({
    a: await readPreviews(app.baseUrl, f.as.a, f.messages.a.id),
    b: await readPreviews(app.baseUrl, f.as.b, f.messages.b.id),
    c: await readPreviews(app.baseUrl, f.as.c, f.messages.c.id),
  });
  const shown = { previews: [f.url], prompts: [] }; const hidden = { previews: [], prompts: [] }; const asked = { previews: [], prompts: [f.vault.client.id] };
  assert.deepEqual(await read(), { a: shown, b: hidden, c: asked }, "nothing widens or vanishes at the switch");
  assert.deepEqual(await choices(app.baseUrl, f.as.c), { allowed: [], declined: [] });

  // Allowing on C is for every Server, but B's earlier "no" stands until it is answered there.
  assert.equal((await answer(app.baseUrl, f.as.c, f.vault.client.id, "link-preview-consent")).status, 200);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:A", "consent:every", "decline:B"]);
  assert.deepEqual(await read(), { a: shown, b: hidden, c: shown });
  assert.deepEqual(await choices(app.baseUrl, f.as.a), { allowed: [f.vault.client.id], declined: [] }, "one row per App, the earlier consent and the one for every Server");
  assert.deepEqual(await choices(app.baseUrl, f.as.b), { allowed: [], declined: [f.vault.client.id] });
  assert.equal((await answer(app.baseUrl, f.as.b, f.vault.client.id, "link-preview-consent")).status, 200);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:A", "consent:every"]);
  assert.deepEqual(await read(), { a: shown, b: shown, c: shown });

  // Declining after the switch is for every Server, A's earlier consent included.
  assert.equal((await answer(app.baseUrl, f.as.a, f.vault.client.id, "link-preview-decline")).status, 200);
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:A", "consent:every", "decline:every"]);
  assert.deepEqual(await read(), { a: hidden, b: hidden, c: hidden });
  assert.deepEqual(await choices(app.baseUrl, f.as.a), { allowed: [], declined: [f.vault.client.id] });
});

test("kill switch off for the viewer: the account consent and the prompt are gone (no assertion is sent) and the answer is refused, as for a guest; per-Server answers from before the switch work as before; a decline for every Server still stops; turning it back on restores it", async ({ app, db, seed }) => {
  useSigningKey();
  const f = await seedVault(db, seed, { installOnC: true });
  const assertions = recordAssertions();
  // Server mode: allowed on C. Then the switch, and an Allow (for every Server) on A.
  assert.equal((await answer(app.baseUrl, f.as.c, f.vault.client.id, "link-preview-consent")).status, 200);
  await switchToAccountMode(db, f.vault.client.id);
  assert.equal((await answer(app.baseUrl, f.as.a, f.vault.client.id, "link-preview-consent")).status, 200);
  const read = async () => ({
    a: await readPreviews(app.baseUrl, f.as.a, f.messages.a.id),
    b: await readPreviews(app.baseUrl, f.as.b, f.messages.b.id),
    c: await readPreviews(app.baseUrl, f.as.c, f.messages.c.id),
  });
  const shown = { previews: [f.url], prompts: [] }; const hidden = { previews: [], prompts: [] };
  assert.deepEqual(await read(), { a: shown, b: shown, c: shown });

  await setAccountLogin(db, false);
  assertions.length = 0;
  assert.deepEqual(await read(), { a: hidden, b: hidden, c: shown }, "no preview and no prompt from the account consent; C's own consent as before");
  assert.deepEqual(assertions.map((claims) => claims.server_id), [f.c.id], "the App got an assertion for C only");
  for (const [server, choice] of [["b", "link-preview-consent"], ["a", "link-preview-decline"], ["c", "link-preview-consent"]] as const) {
    const refused = await answer(app.baseUrl, f.as[server], f.vault.client.id, choice);
    assert.equal(refused.status, 404, `${server} ${choice}`);
    assert.deepEqual(await refused.json(), { error: "App not found", code: "LINK_PREVIEW_APP_NOT_FOUND", errorCode: "LINK_PREVIEW_APP_NOT_FOUND" }, "the guest's answer");
  }
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:C", "consent:every"], "nothing written while off");
  assert.deepEqual(await choices(app.baseUrl, f.as.a), { allowed: [], declined: [] }, "the row for every Server is not listed while off");
  assert.deepEqual(await choices(app.baseUrl, f.as.c), { allowed: [f.vault.client.id], declined: [] });

  await setAccountLogin(db, true);
  assert.deepEqual(await read(), { a: shown, b: shown, c: shown }, "back on: the account consent counts again");
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:C", "consent:every"]);

  // A decline for every Server is the person's own "no": it stops C's earlier consent whether the switch is on or off.
  assert.equal((await answer(app.baseUrl, f.as.b, f.vault.client.id, "link-preview-decline")).status, 200);
  assert.deepEqual(await read(), { a: hidden, b: hidden, c: hidden });
  await setAccountLogin(db, false);
  assertions.length = 0;
  assert.deepEqual(await read(), { a: hidden, b: hidden, c: hidden });
  assert.deepEqual(assertions, []);
  assert.deepEqual(await choices(app.baseUrl, f.as.c), { allowed: [], declined: [] }, "C's consent is not listed as allowed under that decline");
});

test("D17 with D7: an account-mode App neither previews nor prompts for a guest on that Server, and a guest cannot answer for it there; a server-mode App is as before", async ({ db, seed }) => {
  const f = await seedVault(db, seed);
  const suffix = randomUUID().slice(0, 8);
  const reference = await previewApp(db, f.owner, f.publisher, `reference-${suffix}`, `https://reference-${suffix}.example.test`, [f.a, f.b]);
  await switchToAccountMode(db, f.vault.client.id);
  assert.deepEqual(await allowLinkPreviews({ serverId: f.a.id, userId: f.person.id, clientId: f.vault.client.id }).then((result) => result.kind), "allowed");
  await seedBoundGuest({ serverId: f.b.id, userId: f.person.id });
  const origins = [`https://${new URL(f.url).host}`, `https://reference-${suffix}.example.test`];

  assert.deepEqual((await registeredApps(f.a.id, f.person.id, origins)).map((row) => [row.app.id, row.consentId !== null]).sort(),
    [[f.vault.client.id, true], [reference.client.id, false]].sort(), "a member: both Apps, the account consent counting");
  assert.deepEqual((await registeredApps(f.b.id, f.person.id, origins)).map((row) => row.app.id), [reference.client.id], "a guest: only the server-mode App");
  for (const choose of [allowLinkPreviews, declineLinkPreviews]) {
    assert.deepEqual(await choose({ serverId: f.b.id, userId: f.person.id, clientId: f.vault.client.id }), { kind: "not_found" }, choose.name);
  }
  assert.equal((await allowLinkPreviews({ serverId: f.b.id, userId: f.person.id, clientId: reference.client.id })).kind, "allowed");
  const listed = async (serverId: string) => {
    const { allowed, declined } = await listLinkPreviewChoices({ serverId, userId: f.person.id });
    return { allowed: allowed.map((row) => row.app.id).sort(), declined: declined.map((row) => row.app.id) };
  };
  assert.deepEqual(await listed(f.b.id), { allowed: [reference.client.id], declined: [] }, "the guest's Settings list only what they can change there");
  assert.deepEqual(await listed(f.a.id), { allowed: [f.vault.client.id], declined: [] });
  assert.deepEqual(await rowsOf(db, f.person.id, f.vault.client.id, f.label), ["consent:every"], "the guest's refused answers wrote nothing");
});

test("D17 link card execute: the account consent lets the card act on its Server; revoked, declined (for every Server) or the kill switch turned off while execute waits is 410, and the receipt follows the same rows", async ({ app, db, seed }) => {
  useSigningKey();
  const fx = await cardFixture(db, seed);
  await switchToAccountMode(db, fx.client.id);
  await setAccountLogin(db, true);
  // The fixture's per-Server consent replaced by the account consent the prompt now writes.
  await db.delete(oauthUserConsents).where(eq(oauthUserConsents.clientId, fx.client.id));
  const [consent] = await db.insert(oauthUserConsents).values({ serverId: null, userId: fx.owner.id, clientId: fx.client.id, scopes: ["openid", "profile"], source: "preview_prompt" }).returning();
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const executeOnce = () => post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });

  const control = await executeOnce();
  assert.equal(control.status, 200, JSON.stringify(control.body));
  assert.equal(calls.filter((call) => call.url === fx.actionEndpoint).length, 1);
  const [operation] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, control.body.operation_id as string));
  const readMessage: LinkCardMessageReader = async () => ({ content: fx.content });
  assert.equal(await linkCardReceiptReadable(operation!, readMessage), true, "the receipt is readable on the account consent");

  const changes: [string, (tx: DatabaseExecutor) => Promise<unknown>][] = [
    ["consent revoked", (tx) => tx.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.id, consent!.id))],
    ["previews declined for every Server", (tx) => tx.insert(oauthLinkPreviewDeclines).values({ serverId: null, userId: fx.owner.id, clientId: fx.client.id })],
    ["the kill switch turned off", (tx) => tx.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, OAUTH_ACCOUNT_LOGIN_FEATURE_FLAG_KEY))],
  ];
  for (const [why, change] of changes) {
    __setLinkCardActionHooksForTests({ underAdmissionLocks: (tx) => change(tx).then(() => undefined) });
    const res = await executeOnce();
    assert.equal(res.status, 410, `${why}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "HANDLE_INVALID", why);
  }
  assert.equal(calls.filter((call) => call.url === fx.actionEndpoint).length, 1, "the App was never called for them");

  __setLinkCardActionHooksForTests(null);
  await setAccountLogin(db, false);
  assert.equal(await linkCardReceiptReadable(operation!, readMessage), false, "kill switch off: the account consent does not count");
  assert.equal((await executeOnce()).status, 410);
  await setAccountLogin(db, true);
  assert.equal(await linkCardReceiptReadable(operation!, readMessage), true, "back on: it counts again");
  await db.insert(oauthLinkPreviewDeclines).values({ serverId: null, userId: fx.owner.id, clientId: fx.client.id });
  assert.equal(await linkCardReceiptReadable(operation!, readMessage), false, "declined for every Server: not readable");
  assert.equal((await executeOnce()).status, 410);
});
