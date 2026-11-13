import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach } from "vitest";
import { appLinkPreviewListResponseSchema } from "@botiverse/raft-shared/src/appLinkPreview";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { integrationAuditEvents, oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthLinkPreviewDeclines, oauthUserConsents, users } from "../db/schema";
import type { Database } from "../db";
import { createOAuthClient } from "../services/oauthService";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests, LINK_PREVIEW_PROOF_HARD_TTL_MS, LINK_PREVIEW_PROOF_SOFT_TTL_MS } from "../services/appLinkPreviewService";
import { allowLinkPreviews, declineLinkPreviews } from "../services/appLinkPreviewConsentService";

// The first-view link-preview prompt: a viewer who has neither consented to an
// App on this Server nor declined it gets a prompt instead of a preview, and
// answers it for themselves (docs/development/app-link-previews.md).
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
afterEach(() => { __setPreviewHttpForTests(null); if (originalKey === undefined) delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY; else process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = originalKey; });
const useSigningKey = () => { process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(); };
const card = { version: 1, title: 'Private PR' };
type Human = typeof users.$inferSelect;
type App = Awaited<ReturnType<typeof createOAuthClient>>;

/** An App with a link-preview registration for `origin`, installed on `serverId` unless told otherwise. */
async function previewApp(db: Database, owner: Human, serverId: string, key: string, origin: string, options: { install?: boolean; allowedScopes?: string[] } = {}): Promise<App> {
  const app = await createOAuthClient({ serverId, createdByUserId: owner.id, clientId: key, name: key, allowedScopes: options.allowedScopes ?? ['openid', 'profile', 'email'] });
  if (options.install !== false) await db.insert(oauthClientInstalls).values({ clientId: app.client.id, serverId, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthAppLinkPreviews).values({ clientId: app.client.id, origin, endpoint: `${origin}/callback`, paths: ['/pr'] });
  return app;
}

async function headersFor(human: Human, serverId: string) {
  return { Authorization: `Bearer ${await tokenForHuman(human.email)}`, 'X-Server-Id': serverId };
}

function answer(baseUrl: string, headers: Record<string, string>, clientId: string, choice: 'link-preview-consent' | 'link-preview-decline') {
  return fetch(`${baseUrl}/api/integrations/clients/${clientId}/${choice}`, { method: 'POST', headers });
}

async function readPreviews(baseUrl: string, headers: Record<string, string>, messageId: string) {
  const response = await fetch(`${baseUrl}/api/messages/${messageId}/app-link-previews`, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { previews: Array<{ url: string; title: string }>; prompts: Array<{ url: string; app: { id: string; name: string; icon: string | null } }> };
}

async function choices(baseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}/api/integrations/link-preview-consents`, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as { allowed: Array<{ app: { id: string }; scopes: string[]; source: string; granted_at: string }>; declined: Array<{ app: { id: string }; declined_at: string }> };
}

async function consentOf(db: Database, userId: string, serverId: string, clientId: string) {
  const [row] = await db.select().from(oauthUserConsents).where(and(eq(oauthUserConsents.userId, userId), eq(oauthUserConsents.serverId, serverId), eq(oauthUserConsents.clientId, clientId)));
  return row ?? null;
}

async function declineOf(db: Database, userId: string, serverId: string, clientId: string) {
  const [row] = await db.select().from(oauthLinkPreviewDeclines).where(and(eq(oauthLinkPreviewDeclines.userId, userId), eq(oauthLinkPreviewDeclines.serverId, serverId), eq(oauthLinkPreviewDeclines.clientId, clientId)));
  return row ?? null;
}

async function promptAudits(db: Database) {
  const rows = await db.select().from(integrationAuditEvents)
    .where(inArray(integrationAuditEvents.eventType, ['link_preview.consent_granted', 'link_preview.declined']))
    .orderBy(integrationAuditEvents.createdAt);
  return rows.map((row) => ({ eventType: row.eventType, serverId: row.serverId, clientId: row.clientId, actorId: row.actorId, subjectId: row.subjectId, targetId: row.targetId, metadata: row.metadata }));
}

/** A completed Login with Raft (approve, then the App exchanges the code). */
async function login(baseUrl: string, human: Human, serverId: string, app: App, scopes: string[]) {
  const authorized = await fetch(`${baseUrl}/api/oauth/authorize/human`, {
    method: 'POST', headers: { Authorization: `Bearer ${await tokenForHuman(human.email)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: app.client.clientId, serverId, scopes }),
  });
  assert.equal(authorized.status, 200, await authorized.clone().text());
  const { code } = await authorized.json() as { code: string };
  const exchanged = await fetch(`${baseUrl}/api/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: app.client.clientId, clientSecret: app.clientSecret, grantType: 'authorization_code', code }),
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
}

test("a viewer who has not answered gets one prompt per App per message and no callback; allowing renders the preview, declining hides the prompt", async ({ app, db, seed }) => {
  useSigningKey();
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const alpha = await previewApp(db, owner, server.id, 'prompt-alpha', 'https://alpha.example.test');
  const beta = await previewApp(db, owner, server.id, 'prompt-beta', 'https://beta.example.test');
  await db.update(oauthClients).set({ logoUrl: 'https://cdn.example.test/beta.webp' }).where(eq(oauthClients.id, beta.client.id));
  const message = await seed.message({ channel, author: owner, content: 'https://alpha.example.test/pr/1 https://beta.example.test/pr/9 https://alpha.example.test/pr/2' });
  const headers = await headersFor(owner, server.id);
  const called: string[] = [];
  __setPreviewHttpForTests(async (url) => { called.push(url); return card; });
  const alphaView = { id: alpha.client.id, name: 'prompt-alpha', icon: null };
  const betaView = { id: beta.client.id, name: 'prompt-beta', icon: 'https://cdn.example.test/beta.webp' };

  const unanswered = await readPreviews(app.baseUrl, headers, message.id);
  assert.deepEqual(unanswered, { previews: [], prompts: [
    { url: 'https://alpha.example.test/pr/1', app: alphaView },
    { url: 'https://beta.example.test/pr/9', app: betaView },
  ], appIcons: {} }, 'one prompt per App, on its first link');
  assert.equal(called.length, 0, 'a prompt never calls the App');
  // Deployed web clients read the response with this schema: they drop `prompts` and keep working.
  assert.deepEqual(appLinkPreviewListResponseSchema.parse(unanswered).previews, []);

  const allowed = await answer(app.baseUrl, headers, alpha.client.id, 'link-preview-consent');
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const allowedBody = await allowed.json();
  assert.ok(!Number.isNaN(Date.parse(allowedBody.granted_at)));
  assert.deepEqual({ ...allowedBody, granted_at: null }, { app: alphaView, scopes: ['openid', 'profile'], source: 'preview_prompt', granted_at: null });

  const afterAllow = await readPreviews(app.baseUrl, headers, message.id);
  assert.deepEqual(afterAllow.previews.map((preview) => preview.url), ['https://alpha.example.test/pr/1', 'https://alpha.example.test/pr/2']);
  assert.deepEqual(afterAllow.prompts, [{ url: 'https://beta.example.test/pr/9', app: betaView }]);
  assert.deepEqual(appLinkPreviewListResponseSchema.parse(afterAllow).previews.map((preview) => preview.title), ['Private PR', 'Private PR']);
  assert.deepEqual(called, ['https://alpha.example.test/callback', 'https://alpha.example.test/callback']);

  const declined = await answer(app.baseUrl, headers, beta.client.id, 'link-preview-decline');
  assert.equal(declined.status, 200, await declined.clone().text());
  const declinedBody = await declined.json();
  assert.deepEqual(declinedBody.app, betaView); assert.ok(!Number.isNaN(Date.parse(declinedBody.declined_at)));
  const afterDecline = await readPreviews(app.baseUrl, headers, message.id);
  assert.deepEqual(afterDecline.prompts, []);
  assert.equal(afterDecline.previews.length, 2);
  assert.ok(!called.includes('https://beta.example.test/callback'), 'a declined App is never called');

  const listed = await choices(app.baseUrl, headers);
  assert.deepEqual(listed.allowed.map((row) => ({ ...row, granted_at: null })), [{ app: alphaView, scopes: ['openid', 'profile'], source: 'preview_prompt', granted_at: null }]);
  assert.deepEqual(listed.declined.map((row) => row.app), [betaView]);

  const audit = (clientId: string) => ({ serverId: server.id, clientId, actorId: owner.id, subjectId: owner.id, targetId: clientId });
  assert.deepEqual(await promptAudits(db), [
    { eventType: 'link_preview.consent_granted', ...audit(alpha.client.id), metadata: { clientKey: 'prompt-alpha', consentSource: 'preview_prompt', removedDecline: false } },
    { eventType: 'link_preview.declined', ...audit(beta.client.id), metadata: { clientKey: 'prompt-beta' } },
  ]);
});

test("prompts and answers need an enabled App installed on this Server with a link-preview registration; anything else is a uniform 404", async ({ app, db, seed }) => {
  const owner = await seed.human(); const member = await seed.human(); const outsider = await seed.human();
  const server = await seed.server({ owner, members: [member] }); const outsiderServer = await seed.server({ owner: outsider });
  const channel = await seed.channel({ server, members: [owner, member] });
  const installed = await previewApp(db, owner, server.id, 'prompt-installed', 'https://installed.example.test');
  const notInstalled = await previewApp(db, owner, server.id, 'prompt-not-installed', 'https://not-installed.example.test', { install: false });
  const disabled = await previewApp(db, owner, server.id, 'prompt-disabled', 'https://disabled.example.test');
  await db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, disabled.client.id));
  const noProfile = await previewApp(db, owner, server.id, 'prompt-no-profile', 'https://no-profile.example.test', { allowedScopes: ['openid'] });
  const unregistered = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'prompt-unregistered', name: 'prompt-unregistered' });
  await db.insert(oauthClientInstalls).values({ clientId: unregistered.client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  const ineligible = await seed.message({ channel, author: owner, content: 'https://not-installed.example.test/pr/1 https://disabled.example.test/pr/1 https://no-profile.example.test/pr/1' });
  const eligible = await seed.message({ channel, author: owner, content: 'https://installed.example.test/pr/1' });
  let callbacks = 0;
  __setPreviewHttpForTests(async () => { callbacks++; return card; });
  const ownerHeaders = await headersFor(owner, server.id); const memberHeaders = await headersFor(member, server.id);

  assert.deepEqual(await readPreviews(app.baseUrl, ownerHeaders, ineligible.id), { previews: [], prompts: [], appIcons: {} });
  const promptFor = { url: 'https://installed.example.test/pr/1', app: { id: installed.client.id, name: 'prompt-installed', icon: null } };
  assert.deepEqual(await readPreviews(app.baseUrl, ownerHeaders, eligible.id), { previews: [], prompts: [promptFor], appIcons: {} });

  for (const [label, clientId] of [['not installed here', notInstalled.client.id], ['disabled', disabled.client.id], ['no link-preview registration', unregistered.client.id], ['unknown', randomUUID()]] as const) {
    for (const choice of ['link-preview-consent', 'link-preview-decline'] as const) {
      const response = await answer(app.baseUrl, ownerHeaders, clientId, choice);
      assert.equal(response.status, 404, `${label} ${choice}`);
      assert.deepEqual(await response.json(), { error: 'App not found', code: 'LINK_PREVIEW_APP_NOT_FOUND' }, `${label} ${choice}`);
    }
  }
  assert.equal((await answer(app.baseUrl, ownerHeaders, 'not-a-uuid', 'link-preview-consent')).status, 404);
  const scopeless = await answer(app.baseUrl, ownerHeaders, noProfile.client.id, 'link-preview-consent');
  assert.equal(scopeless.status, 409);
  assert.equal((await scopeless.json()).code, 'LINK_PREVIEW_SCOPES_NOT_ALLOWED');
  // A non-member is stopped by the Server middleware, like every /api/integrations route;
  // on their own Server the App is not installed.
  assert.equal((await answer(app.baseUrl, await headersFor(outsider, server.id), installed.client.id, 'link-preview-consent')).status, 403);
  assert.equal((await answer(app.baseUrl, await headersFor(outsider, outsiderServer.id), installed.client.id, 'link-preview-decline')).status, 404);
  // The membership is checked again inside the write, under its row lock.
  assert.deepEqual(await allowLinkPreviews({ serverId: server.id, userId: outsider.id, clientId: installed.client.id }), { kind: 'not_found' });
  assert.deepEqual(await declineLinkPreviews({ serverId: server.id, userId: outsider.id, clientId: installed.client.id }), { kind: 'not_found' });
  assert.equal((await db.select().from(oauthUserConsents)).length, 0, 'no refused answer wrote a consent');
  assert.equal((await db.select().from(oauthLinkPreviewDeclines)).length, 0, 'no refused answer wrote a decline');
  assert.deepEqual(await promptAudits(db), []);

  // Each person answers for themselves.
  assert.equal((await answer(app.baseUrl, ownerHeaders, installed.client.id, 'link-preview-consent')).status, 200);
  assert.deepEqual((await readPreviews(app.baseUrl, memberHeaders, eligible.id)).prompts, [promptFor]);
  assert.deepEqual((await choices(app.baseUrl, memberHeaders)), { allowed: [], declined: [] });
  assert.equal(callbacks, 0);
});

test("a suspended or long-unproven registration gets no prompt, and a prompt read never starts a proof recheck", async ({ app, db, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const stale = await previewApp(db, owner, server.id, 'prompt-stale', 'https://stale.example.test');
  const expired = await previewApp(db, owner, server.id, 'prompt-expired', 'https://expired.example.test');
  const suspended = await previewApp(db, owner, server.id, 'prompt-suspended', 'https://suspended.example.test');
  const hour = 3600_000;
  // Past SOFT_TTL (a consented read would recheck it) but within HARD_TTL.
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date(Date.now() - LINK_PREVIEW_PROOF_SOFT_TTL_MS - hour) }).where(eq(oauthAppLinkPreviews.clientId, stale.client.id));
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date(Date.now() - LINK_PREVIEW_PROOF_HARD_TTL_MS - hour) }).where(eq(oauthAppLinkPreviews.clientId, expired.client.id));
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: new Date(), suspendedReason: 'proof_mismatch' }).where(eq(oauthAppLinkPreviews.clientId, suspended.client.id));
  const message = await seed.message({ channel, author: owner, content: 'https://stale.example.test/pr/1 https://expired.example.test/pr/1 https://suspended.example.test/pr/1' });
  const requested: string[] = [];
  __setPreviewHttpForTests(async (url) => { requested.push(url); return { client_id: 'unused' }; });

  const body = await readPreviews(app.baseUrl, await headersFor(owner, server.id), message.id);
  await __settleAppLinkPreviewRechecksForTests();
  assert.deepEqual(body, { previews: [], prompts: [{ url: 'https://stale.example.test/pr/1', app: { id: stale.client.id, name: 'prompt-stale', icon: null } }], appIcons: {} });
  assert.equal(requested.length, 0, 'neither a callback nor a domain proof fetch');
});

test("an answer is for the current Server only and leaves other Servers' consents and declines alone", async ({ app, db, seed }) => {
  const owner = await seed.human(); const member = await seed.human();
  const first = await seed.server({ owner, members: [member] }); const second = await seed.server({ owner, members: [member] });
  const vault = await createOAuthClient({
    serverId: first.id, createdByUserId: owner.id, clientId: 'prompt-vault', name: 'prompt-vault', appType: 'third_party_global',
    allowedScopes: ['openid', 'profile', 'email'], returnUrl: 'https://vault.example.test/callback',
  });
  for (const server of [first, second]) await db.insert(oauthClientInstalls).values({ clientId: vault.client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthAppLinkPreviews).values({ clientId: vault.client.id, origin: 'https://vault.example.test', endpoint: 'https://vault.example.test/callback', paths: ['/pr'] });
  await db.insert(oauthLinkPreviewDeclines).values({ userId: owner.id, serverId: first.id, clientId: vault.client.id });

  assert.equal((await answer(app.baseUrl, await headersFor(member, first.id), vault.client.id, 'link-preview-consent')).status, 200);
  assert.equal((await consentOf(db, member.id, first.id, vault.client.id))?.revokedAt, null);
  assert.equal(await consentOf(db, member.id, second.id, vault.client.id), null, 'allowing on one Server consents there only');

  assert.equal((await answer(app.baseUrl, await headersFor(member, second.id), vault.client.id, 'link-preview-decline')).status, 200);
  assert.ok(await declineOf(db, member.id, second.id, vault.client.id));
  assert.equal(await declineOf(db, member.id, first.id, vault.client.id), null, 'declining on one Server declines there only');
  assert.equal((await consentOf(db, member.id, first.id, vault.client.id))?.revokedAt, null);
  assert.ok(await declineOf(db, owner.id, first.id, vault.client.id), "another person's decline stays");
  assert.deepEqual((await choices(app.baseUrl, await headersFor(member, first.id))).declined, []);
  assert.deepEqual((await choices(app.baseUrl, await headersFor(member, second.id))).allowed, []);
});

test("declining turns previews off without touching the consent; a later Login with Raft keeps them off; allowing again brings them back", async ({ app, db, seed }) => {
  useSigningKey();
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const alpha = await previewApp(db, owner, server.id, 'prompt-relogin', 'https://relogin.example.test');
  const message = await seed.message({ channel, author: owner, content: 'https://relogin.example.test/pr/7' });
  const headers = await headersFor(owner, server.id);
  let callbacks = 0;
  __setPreviewHttpForTests(async () => { callbacks++; return card; });
  const titles = async () => {
    const body = await readPreviews(app.baseUrl, headers, message.id);
    return { previews: body.previews.map((preview) => preview.title), prompts: body.prompts.length };
  };

  await login(app.baseUrl, owner, server.id, alpha, ['openid', 'profile']);
  assert.deepEqual(await titles(), { previews: ['Private PR'], prompts: 0 }); assert.equal(callbacks, 1);
  const before = await consentOf(db, owner.id, server.id, alpha.client.id);

  assert.equal((await answer(app.baseUrl, headers, alpha.client.id, 'link-preview-decline')).status, 200);
  assert.deepEqual(await consentOf(db, owner.id, server.id, alpha.client.id), before, 'a decline leaves the consent row as it is');
  assert.deepEqual(await titles(), { previews: [], prompts: 0 }, 'declined: neither a preview nor a prompt'); assert.equal(callbacks, 1);

  await login(app.baseUrl, owner, server.id, alpha, ['openid', 'email']);
  assert.ok(await declineOf(db, owner.id, server.id, alpha.client.id), 'a login does not lift a decline');
  assert.deepEqual((await consentOf(db, owner.id, server.id, alpha.client.id))?.scopes, ['email', 'openid', 'profile']);
  assert.deepEqual(await titles(), { previews: [], prompts: 0 }); assert.equal(callbacks, 1);
  assert.deepEqual((await choices(app.baseUrl, headers)).allowed, []);

  const allowed = await answer(app.baseUrl, headers, alpha.client.id, 'link-preview-consent');
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.deepEqual([body.scopes, body.source], [['email', 'openid', 'profile'], 'login'], 'the standing login consent keeps its scopes and source');
  assert.equal(body.granted_at, before!.grantedAt.toISOString());
  assert.equal(await declineOf(db, owner.id, server.id, alpha.client.id), null);
  assert.deepEqual(await titles(), { previews: ['Private PR'], prompts: 0 }); assert.equal(callbacks, 2);
  const listed = await choices(app.baseUrl, headers);
  assert.deepEqual([listed.allowed.map((row) => [row.app.id, row.source]), listed.declined], [[[alpha.client.id, 'login']], []]);
  assert.deepEqual((await promptAudits(db)).map((row) => [row.eventType, row.metadata]), [
    ['link_preview.declined', { clientKey: 'prompt-relogin' }],
    ['link_preview.consent_granted', { clientKey: 'prompt-relogin', consentSource: 'login', removedDecline: true }],
  ]);
});
