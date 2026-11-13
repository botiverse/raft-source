import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, test as nativeTest } from "vitest";
import pg from "pg";
import { spawn } from "node:child_process";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { getDb } from "../db";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { createOAuthClient } from "../services/oauthService";
import { integrationAuditEvents, oauthAccessTokens, oauthClients, oauthClientInstalls, oauthAppLinkPreviews, oauthLinkPreviewDeclines, oauthUserConsents, messages } from "../db/schema";
import { __setPreviewHttpForTests, LINK_PREVIEW_VERSION_2_DROPPED_EVENT, MAX_IN_FLIGHT_CALLBACKS_PER_USER } from "../services/appLinkPreviewService";
import { getOidcJwks } from "../services/oidcService";
import { z } from "zod";
import { appLinkPreviewResponseSchema } from "@botiverse/raft-shared/src/appLinkPreview";

const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
afterEach(() => { __setPreviewHttpForTests(null); if (originalKey === undefined) delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY; else process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = originalKey; });
const registration = { origin: 'https://preview.example.test', endpoint: 'https://preview.example.test/callback', paths: ['/pr'] };
const card = { version: 1, title: 'Private PR', card: { root: 'status', elements: { status: { type: 'Badge', props: { text: 'Approved' } } } } };

test("App registers its verified domain; viewer-bound callback renders only for an authorized reader", async ({ app, db, seed }) => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const owner = await seed.human(); const outsider = await seed.human();
  const server = await seed.server({ owner, members: [outsider] });
  const channel = await seed.channel({ server, members: [owner], visibility: 'private' });
  const message = await seed.message({ channel, author: owner, content: 'See https://preview.example.test/pr/1' });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-fixture', name: 'Preview App' });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  const clientHeaders = { Authorization: 'Basic ' + Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/json' };
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, 'X-Server-Id': server.id };
  const otherHeaders = { Authorization: `Bearer ${await tokenForHuman(outsider.email)}`, 'X-Server-Id': server.id };
  let callbacks = 0;
  __setPreviewHttpForTests(async (url, body, assertion) => {
    if (!body) return { client_id: client.clientId };
    callbacks++;
    assert.equal(url, registration.endpoint);
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['request_id','url','version']);
    const [h,p,s] = assertion!.split('.'); const claims = JSON.parse(Buffer.from(p,'base64url').toString());
    assert.equal(JSON.parse(Buffer.from(h,'base64url').toString()).typ, 'raft-link-preview+jwt');
    assert.equal(claims.sub, owner.id); assert.equal(claims.server_id, server.id); assert.equal(claims.aud, `urn:raft:link-preview:${client.clientId}`);
    assert.equal(claims.token_use, 'link_preview'); assert.equal(claims.exp - claims.iat, 30); assert.equal(claims.server_role, 'owner');
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: getOidcJwks().keys[0], format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s,'base64url')));
    return card;
  });
  const put = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: 'PUT', headers: clientHeaders, body: JSON.stringify(registration) });
  assert.equal(put.status, 200, await put.clone().text());
  const read = (h = headers) => fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers: h });
  assert.equal((await read(otherHeaders)).status, 404); assert.equal(callbacks, 0);
  const otherServer = await seed.server({ owner });
  assert.equal((await read({ ...headers, 'X-Server-Id': otherServer.id })).status, 404); assert.equal(callbacks, 0);
  // Not consented yet: a prompt for the App, and no callback.
  const prompt = { url: 'https://preview.example.test/pr/1', app: { id: client.id, name: 'Preview App', icon: null } };
  assert.deepEqual(await (await read()).json(), { previews: [], prompts: [prompt], appIcons: {} }); assert.equal(callbacks, 0);
  const [consent] = await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ['openid','profile'] }).returning();
  const response = await read(); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  const rendered = await response.json();
  assert.equal(rendered.previews[0].title, 'Private PR'); assert.equal(callbacks, 1);
  // The chip's icon is Raft's stored one for the App (none uploaded yet), keyed by the preview's link.
  assert.deepEqual(rendered.appIcons, { 'https://preview.example.test/pr/1': null });
  await db.update(oauthClients).set({ logoUrl: '/api/integration-logos/preview-fixture/logo.webp' }).where(eq(oauthClients.id, client.id));
  const withIcon = await (await read()).json(); assert.equal(callbacks, 2);
  assert.deepEqual(withIcon.appIcons, { 'https://preview.example.test/pr/1': '/api/integration-logos/preview-fixture/logo.webp' });
  // Additive at the top level: the list schema deployed clients shipped before
  // appIcons (strict previews, at most three, nothing else) still reads them.
  const deployedListSchema = z.object({ previews: z.array(appLinkPreviewResponseSchema.extend({ url: z.string(), appName: z.string().max(300) })).max(3) });
  assert.deepEqual(deployedListSchema.parse(withIcon).previews.map((preview) => preview.title), ['Private PR']);
  await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.id, consent.id));
  assert.deepEqual(await (await read()).json(), { previews: [], prompts: [{ ...prompt, app: { ...prompt.app, icon: '/api/integration-logos/preview-fixture/logo.webp' } }], appIcons: {} }); assert.equal(callbacks, 2);
  const removed = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: 'DELETE', headers: clientHeaders }); assert.equal(removed.status, 204);
  assert.equal((await db.select().from(oauthAppLinkPreviews)).length, 0);
});

// Only a bare link can become the App's chip (protocol v3.2.3 addendum 5 §1),
// so a link the author gave words to is neither sent to the App nor asked about.
test("a link the author gave words to is never previewed nor prompted, and the App never hears of it", async ({ app, db, seed }) => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: 'See [my fix](https://preview.example.test/pr/1), [<b>https://preview.example.test/pr/3</b>](https://preview.example.test/pr/3) and https://preview.example.test/pr/2' });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-worded', name: 'Worded App' });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, ...registration });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, 'X-Server-Id': server.id };
  const asked: string[] = [];
  __setPreviewHttpForTests(async (_url, body) => { if (body) asked.push(JSON.parse(body).url); return card; });
  const read = async () => (await fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers })).json();
  // Not consented: the prompt goes on the bare link, the only one that can be a chip.
  assert.deepEqual((await read()).prompts.map((prompt: { url: string }) => prompt.url), ['https://preview.example.test/pr/2']);
  await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ['openid','profile'] });
  assert.deepEqual((await read()).previews.map((preview: { url: string }) => preview.url), ['https://preview.example.test/pr/2']);
  assert.deepEqual(asked, ['https://preview.example.test/pr/2']);
});

test("a callback cannot survive message edit, App disable, uninstall, consent revocation or a decline; malformed results fall back", async ({ app, db, seed }) => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: 'https://preview.example.test/pr/1' });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-race', name: 'Race App' });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, ...registration });
  const [consent] = await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ['openid','profile'] }).returning();
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, 'X-Server-Id': server.id };
  const read = () => fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers });
  for (const change of ['edit','disable','uninstall','revoke','decline','scope','reregister','malformed','delete']) {
    await db.update(messages).set({ content: message.content }).where(eq(messages.id,message.id));
    await db.update(oauthClients).set({ enabled: true, allowedScopes: ['openid','profile'] }).where(eq(oauthClients.id,client.id));
    await db.update(oauthClientInstalls).set({ status: 'active' }).where(eq(oauthClientInstalls.clientId,client.id));
    await db.update(oauthUserConsents).set({ revokedAt: null }).where(eq(oauthUserConsents.id,consent.id));
    await db.delete(oauthLinkPreviewDeclines);
    let called = false;
    __setPreviewHttpForTests(async () => {
      called = true;
      if (change === 'edit') await db.update(messages).set({ content: 'removed' }).where(eq(messages.id,message.id));
      if (change === 'disable') await db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id,client.id));
      if (change === 'uninstall') await db.update(oauthClientInstalls).set({ status: 'suspended' }).where(eq(oauthClientInstalls.clientId,client.id));
      if (change === 'revoke') await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.id,consent.id));
      if (change === 'decline') await db.insert(oauthLinkPreviewDeclines).values({ serverId: server.id, userId: owner.id, clientId: client.id });
      if (change === 'scope') await db.update(oauthClients).set({ allowedScopes: ['openid'] }).where(eq(oauthClients.id,client.id));
      if (change === 'reregister') { await db.delete(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId,client.id)); await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, ...registration }); }
      if (change === 'delete') await db.delete(messages).where(eq(messages.id,message.id));
      return change === 'malformed' ? { ...card, html: '<script>bad</script>' } : card;
    });
    assert.deepEqual(await (await read()).json(), { previews: [], prompts: [], appIcons: {} }, change); assert.ok(called, change);
  }
});

test("previews follow the viewer's standing consent, not the expiry of their one-hour Login with Raft token", async ({ app, db, seed }) => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: 'https://preview.example.test/pr/1' });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-consent', name: 'Consent App' });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, ...registration });
  // The viewer logged in yesterday: the token is long expired, the consent stands.
  await db.insert(oauthAccessTokens).values({ serverId: server.id, principalType: 'human', userId: owner.id, clientId: client.id, tokenHash: 'expired-preview-token', scopes: ['openid','profile'], expiresAt: new Date(Date.now()-23*3600000), createdAt: new Date(Date.now()-24*3600000) });
  const [consent] = await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ['openid','profile'] }).returning();
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, 'X-Server-Id': server.id };
  let callbacks = 0;
  __setPreviewHttpForTests(async () => { callbacks++; return card; });
  const titles = async () => (await (await fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers })).json()).previews.map((p: { title: string }) => p.title);
  assert.deepEqual(await titles(), ['Private PR']);
  for (const scopes of [['openid'], ['profile'], ['email']]) {
    await db.update(oauthUserConsents).set({ scopes }).where(eq(oauthUserConsents.id, consent.id));
    assert.deepEqual(await titles(), [], scopes.join(' '));
  }
  await db.update(oauthUserConsents).set({ scopes: ['openid','profile','email'] }).where(eq(oauthUserConsents.id, consent.id));
  assert.deepEqual(await titles(), ['Private PR'], 'extra scopes still include openid profile');
  await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.id, consent.id));
  assert.deepEqual(await titles(), [], 'revoked consent');
  await db.delete(oauthUserConsents).where(eq(oauthUserConsents.id, consent.id));
  assert.deepEqual(await titles(), [], 'no consent');
  // Consent is per Server: consenting to the same App on another Server does not count here.
  const elsewhere = await seed.server({ owner });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: elsewhere.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthUserConsents).values({ serverId: elsewhere.id, userId: owner.id, clientId: client.id, scopes: ['openid','profile'] });
  assert.deepEqual(await titles(), [], 'consent on another Server');
  assert.equal(callbacks, 2);
});

test("configuration cannot claim another domain, change another App, or receive anonymous writes", async ({ app, db, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-denied', name: 'Denied' });
  const endpoint = `${app.baseUrl}/api/oauth/link-preview`;
  const headers = { Authorization: 'Basic '+Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/json' };
  __setPreviewHttpForTests(async () => ({ client_id: 'another-app' }));
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(registration) })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration) })).status, 401);
  assert.equal((await db.select().from(oauthAppLinkPreviews)).length, 0);
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  assert.equal((await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(registration) })).status, 200);
  const second = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-conflict', name: 'Conflicting App' });
  __setPreviewHttpForTests(async () => ({ client_id: second.client.clientId }));
  const conflictHeaders = { ...headers, Authorization: 'Basic '+Buffer.from(`${second.client.clientId}:${second.clientSecret}`).toString('base64') };
  // The well-known file now names the second App, so it takes the origin over.
  assert.equal((await fetch(endpoint, { method: 'PUT', headers: conflictHeaders, body: JSON.stringify(registration) })).status, 200);
  assert.deepEqual((await db.select().from(oauthAppLinkPreviews)).map((row) => row.clientId), [second.client.id]);
});

// What moves the revision, for a registration with an action endpoint (Edgar,
// Stamp App Staging's re-registration moved it): only a change in force.
test("adding preview_versions to an otherwise identical registration keeps the revision, with an action endpoint too; a changed path, or an action endpoint the last registration did not have, moves it", async ({ app, db, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'revision-moves', name: 'Revision App' });
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  const headers = { Authorization: 'Basic '+Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/json' };
  const saved = async (body: unknown) => {
    const response = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: 'PUT', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).registration as { revision: string; previewVersions: number[] };
  };
  const withActions = { ...registration, action_endpoint: `${registration.origin}/card-actions` };

  const first = await saved(withActions);
  const declared = await saved({ ...withActions, preview_versions: [1, 2, 3] });
  assert.deepEqual([declared.previewVersions, declared.revision], [[1, 2, 3], first.revision]);
  assert.equal((await saved(withActions)).revision, first.revision, 'and rolling it back keeps it too');

  const noActions = await saved(registration);
  assert.notEqual(noActions.revision, first.revision, 'removing the action endpoint is a change in force');
  const added = await saved(withActions);
  assert.notEqual(added.revision, noActions.revision, 'so is adding one, at once on an unpublished App');
  const paths = await saved({ ...withActions, paths: [...registration.paths, '/requests'] });
  assert.notEqual(paths.revision, added.revision, 'so is a changed path');
});

// A PUT replaces the registration, so leaving preview_versions out takes an App
// off version 2 with no error (Tenny, #proj-apps:#47 8e0fa8d8).
test("a registration that takes an App off version 2 records a trace event naming only the App; narrowing to [1, 2], a first [1] and a repeat [1] record none", async ({ app, seed }) => {
  const sink = new MemoryTraceSink();
  app.app.set('serverTracer', new BasicTracer({ sink }));
  const dropped = () => sink.getAllLogEvents().filter((event) => event.name === LINK_PREVIEW_VERSION_2_DROPPED_EVENT).map(({ attrs }) => attrs);
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'version-2-dropped', name: 'Dropped App' });
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  const headers = { Authorization: 'Basic '+Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/json' };
  const put = async (body: unknown) => {
    const response = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: 'PUT', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
  };

  await put(registration); await put(registration);
  await put({ ...registration, preview_versions: [1, 2, 3] });
  await put({ ...registration, preview_versions: [1, 2] });
  assert.deepEqual(dropped(), []);
  await put(registration);
  assert.deepEqual(dropped().map((attrs) => attrs?.app_id), [client.id]);
  assert.deepEqual(Object.keys(dropped()[0]!).filter((key) => /url|origin|endpoint|path/i.test(key)), []);
  await put(registration);
  assert.equal(dropped().length, 1, 'a repeat registration is not another drop');
});

// #proj-apps:#55: what the App's page under My Apps reads.
test("GET /integrations/clients tells App managers which Apps have read-only link previews (registered without version 2); ordinary members never get it", async ({ app, db, seed }) => {
  const owner = await seed.human(); const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const clientFor = async (key: string) => (await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: key, name: key })).client;
  const [readOnly, declared, unregistered] = [await clientFor('read-only-app'), await clientFor('declared-app'), await clientFor('unregistered-app')];
  await db.insert(oauthAppLinkPreviews).values([
    { clientId: readOnly.id, origin: 'https://read-only.example.test', endpoint: 'https://read-only.example.test/callback', paths: ['/pr'] },
    { clientId: declared.id, origin: 'https://declared.example.test', endpoint: 'https://declared.example.test/callback', paths: ['/pr'], previewVersions: [1, 2] },
  ]);
  const flags = async (email: string) => {
    const response = await fetch(`${app.baseUrl}/api/integrations/clients`, { headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, 'X-Server-Id': server.id } });
    assert.equal(response.status, 200, await response.clone().text());
    const rows = await response.json() as { id: string; linkPreviewReadOnly?: boolean }[];
    return Object.fromEntries(rows.map((row) => [row.id, row.linkPreviewReadOnly]));
  };
  assert.deepEqual(await flags(owner.email), { [readOnly.id]: true, [declared.id]: undefined, [unregistered.id]: undefined });
  assert.deepEqual(Object.values(await flags(member.email)).filter(Boolean), []);
});

// An App declares the preview request versions it answers (#proj-apps
// e1a02bef / eb7082bc); the reads that follow it are in linkCardRead.api.test.ts.
test("an App's declared preview versions are stored sorted and returned, [1] when left out; a change neither waits for review nor moves the revision", async ({ app, db, seed }) => {
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-versions', name: 'Versions App' });
  // Published, so a reviewed field (action_endpoint) would wait; this one does not.
  await db.update(oauthClients).set({ appType: 'third_party_global', publishStatus: 'published' }).where(eq(oauthClients.id, client.id));
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  const endpoint = `${app.baseUrl}/api/oauth/link-preview`;
  const headers = { Authorization: 'Basic '+Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/json' };
  const put = (body: unknown) => fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(body) });
  const saved = async (body: unknown) => {
    const response = await put(body); assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).registration as { revision: string; previewVersions: number[] };
  };
  const read = async () => (await (await fetch(endpoint, { headers })).json()).registration as { revision: string; previewVersions: number[] };
  const row = async () => (await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)))[0]!;
  const audits = async (eventType: string) => (await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.clientId, client.id)))
    .filter((event) => event.eventType === eventType).length;

  const first = await saved(registration);
  assert.deepEqual(first.previewVersions, [1], 'left out: version 1 only');
  assert.deepEqual((await read()).previewVersions, [1]);

  const updatesBefore = await audits('app.updated');
  const declared = await saved({ ...registration, preview_versions: [3, 1, 2] });
  assert.deepEqual(declared.previewVersions, [1, 2, 3], 'stored sorted');
  assert.deepEqual((await row()).previewVersions, [1, 2, 3]);
  assert.deepEqual(await read(), declared, 'GET returns what PUT stored');
  assert.equal(declared.revision, first.revision, 'not a change in force: outstanding card handles stay valid');
  assert.equal(await audits('app.updated'), updatesBefore + 1, 'the change is audited');
  assert.equal(await audits('app.action_endpoint_requested'), 0, 'and needs no marketplace review');

  const stored = await row();
  assert.equal((await saved({ ...registration, preview_versions: [2, 3, 1] })).revision, first.revision);
  assert.equal((await row()).updatedAt.getTime(), stored.updatedAt.getTime(), 'the same set in another order is a repeat registration: nothing is written');
  assert.equal(await audits('app.updated'), updatesBefore + 1);

  const narrowed = await saved({ ...registration, preview_versions: [1, 2] });
  assert.deepEqual([narrowed.previewVersions, narrowed.revision], [[1, 2], first.revision]);
  const omitted = await saved(registration);
  assert.deepEqual([omitted.previewVersions, omitted.revision], [[1], first.revision], 'a PUT replaces the registration: leaving the field out goes back to [1]');

  // A change in force still moves the revision, whatever the versions do.
  const paths = await saved({ ...registration, paths: ['/pr', '/issues'], preview_versions: [1, 2] });
  assert.notEqual(paths.revision, first.revision); assert.deepEqual(paths.previewVersions, [1, 2]);

  for (const preview_versions of [[0], [4], [1, 4], [2], [2, 3], [1, 3], [], [1, 1], [1, 2, 2], ['1'], [1.5], null, 1, '1,2', { 0: 1 }]) {
    const response = await put({ ...registration, paths: ['/pr', '/issues'], preview_versions });
    assert.equal(response.status, 400, JSON.stringify(preview_versions));
    assert.deepEqual(await response.json(), { error: 'Invalid link preview registration' });
  }
  assert.deepEqual(await read(), paths, 'a refused registration changes nothing');

  // A row written without the column (registrations from before it, code
  // from before it) declares version 1 only, and re-registering it is a repeat.
  await db.delete(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id));
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, ...registration });
  const legacy = await read();
  assert.deepEqual(legacy.previewVersions, [1]);
  assert.equal((await saved(registration)).revision, legacy.revision);
});

test("the preview read budget is per person, not multiplied by Server memberships", async ({ app, seed }) => {
  const viewer = await seed.human();
  const first = await seed.server({ owner: viewer }); const second = await seed.server({ owner: viewer });
  const token = await tokenForHuman(viewer.email);
  // The limiter runs before message lookup, so unknown ids still spend budget.
  const read = (serverId: string) => fetch(`${app.baseUrl}/api/messages/${randomUUID()}/app-link-previews`, { headers: { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId } });
  for (let i = 0; i < 60; i++) assert.equal((await read(first.id)).status, 404);
  const other = await read(second.id);
  assert.equal(other.status, 429); assert.deepEqual(await other.json(), { previews: [], prompts: [] });
});

// #proj-o11y:#29: a 404 says which check refused it on the trace (never to the
// client), with the message as its keyed hash, never the raw id.
test("a refused preview read records why on its trace, with the message hashed, and still answers the unknown message's 404", async ({ app, seed }) => {
  const sink = new MemoryTraceSink();
  app.app.set('serverTracer', new BasicTracer({ sink }));
  const refusals = () => [...sink.getAllSpans().flatMap((span) => span.events), ...sink.getAllLogEvents()]
    .filter((event) => event.name === 'link_preview.refused').map(({ attrs }) => attrs);
  const owner = await seed.human(); const outsider = await seed.human();
  const server = await seed.server({ owner, members: [outsider] });
  const channel = await seed.channel({ server, members: [owner], visibility: 'private' });
  const message = await seed.message({ channel, author: owner, content: 'See https://preview.example.test/pr/1' });
  const outsiderHeaders = { Authorization: `Bearer ${await tokenForHuman(outsider.email)}`, 'X-Server-Id': server.id };
  const unknown = randomUUID();
  const missing = await fetch(`${app.baseUrl}/api/messages/${unknown}/app-link-previews`, { headers: outsiderHeaders });
  assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: 'Message not found' });
  const hidden = await fetch(`${app.baseUrl}/api/messages/${message.id}/link-cards/read`, {
    method: 'POST', headers: { ...outsiderHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ view_instance_id: randomUUID(), capabilities: [], locale: 'en' }),
  });
  assert.equal(hidden.status, 404); assert.deepEqual(await hidden.json(), { error: 'Message not found' });
  const recorded = refusals();
  assert.equal(recorded[0]?.route_action, 'app_link_previews'); assert.equal(recorded[0]?.preview_refusal, 'not_found');
  assert.equal(recorded[1]?.route_action, 'link_cards_read'); assert.equal(recorded[1]?.preview_refusal, 'not_visible');
  const traced = JSON.stringify(sink.getAllSpans()) + JSON.stringify(sink.getAllLogEvents());
  assert.ok(!traced.includes(unknown)); assert.ok(!traced.includes(message.id));
});

test("one viewer cannot hold more than the in-flight callback budget open at once", async ({ app, db, seed }) => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: 'https://preview.example.test/pr/1 https://preview.example.test/pr/2 https://preview.example.test/pr/3' });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: 'preview-inflight', name: 'In-flight App' });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, ...registration });
  await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ['openid','profile'] });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, 'X-Server-Id': server.id };
  const read = async () => (await (await fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers })).json()).previews.length;
  let calls = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let saturated!: () => void; const full = new Promise<void>((resolve) => { saturated = resolve; });
  __setPreviewHttpForTests(async () => {
    // Only the budget-filling callbacks block, so a missing cap fails fast instead of hanging.
    if (++calls > MAX_IN_FLIGHT_CALLBACKS_PER_USER) return card;
    if (calls === MAX_IN_FLIGHT_CALLBACKS_PER_USER) saturated();
    await gate; return card;
  });
  // Each read fans out to three callbacks; fill the budget, then one more read.
  const held = Array.from({ length: MAX_IN_FLIGHT_CALLBACKS_PER_USER / 3 }, read);
  await full;
  assert.equal(await read(), 0); assert.equal(calls, MAX_IN_FLIGHT_CALLBACKS_PER_USER);
  release();
  assert.deepEqual(await Promise.all(held), held.map(() => 3));
  assert.equal(await read(), 3); // slots are returned after callbacks settle
});

// Opt-in disposable native PG run; the ordinary three API cases always run.
if (process.env.APP_PREVIEW_TEST_DATABASE_URL) nativeTest("native PG: migrated App registration and viewer callback cross the real HTTP/database boundary", async () => {
  const root = new URL(process.env.APP_PREVIEW_TEST_DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(root.hostname));
  const control = new pg.Client({ connectionString: root.toString() }); await control.connect();
  const name = `preview_${randomUUID().replaceAll("-", "")}`;
  let app: Awaited<ReturnType<typeof openTestApp>> | undefined;
  let clientDb: pg.Client | undefined;
  let example: ReturnType<typeof spawn> | undefined;
  const originalServerUrl = process.env.SERVER_URL;
  try {
    await control.query(`CREATE DATABASE "${name}"`); root.pathname = `/${name}`;
    clientDb = new pg.Client({ connectionString: root.toString() }); await clientDb.connect();
    await migrate(drizzle(clientDb), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    app = await openTestApp(root.toString(), 0);
    const db = getDb(); const seed = createSeed(db);
    const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
    const message = await seed.message({ channel, author: owner, content: "https://preview.example.test/pr/3" });
    const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "preview-native", name: "Native App" });
    await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
    await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ["openid","profile"] });
    process.env.SERVER_URL = app.baseUrl;
    const examplePath = process.env.APP_PREVIEW_EXAMPLE_PATH;
    assert.ok(examplePath, "Set APP_PREVIEW_EXAMPLE_PATH to the create-raft-app examples/app-link-preview/server.mjs checkout");
    example = spawn(process.execPath, [examplePath], {
      env: { PATH: process.env.PATH, PORT: "0", RAFT_ISSUER: `${app.baseUrl}/oidc/${server.slug}`, RAFT_CLIENT_ID: client.clientId,
        RAFT_SERVER_ID: server.id, APP_ORIGIN: registration.origin, ALLOWED_VIEWER_IDS: owner.id }, stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Example startup timeout")), 5000);
      example!.once("error", (error) => { clearTimeout(timer); reject(error); });
      example!.stdout!.on("data", (chunk: Buffer) => { const found = /listening on (\d+)/.exec(chunk.toString()); if (found) { clearTimeout(timer); resolve(Number(found[1])); } });
    });
    __setPreviewHttpForTests(async (url, body, assertion) => {
      const target = new URL(url);
      const response = await fetch(`http://127.0.0.1:${port}${target.pathname === "/callback" ? "/preview" : target.pathname}`, {
        method: body ? "POST" : "GET", body, headers: { "content-type": "application/json", ...(assertion ? { Authorization: `Bearer ${assertion}` } : {}) },
      });
      assert.equal(response.status, 200, "Example callback must verify the real signed assertion");
      return response.json();
    });
    const clientHeaders = { Authorization: "Basic "+Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" };
    const updates = await Promise.all(Array.from({ length: 4 }, () => fetch(`${app!.baseUrl}/api/oauth/link-preview`, { method: "PUT", headers: clientHeaders, body: JSON.stringify(registration) })));
    assert.ok(updates.every((r) => r.status === 200));
    const versions = await Promise.all(updates.map(async (r) => (await r.json()).registration.revision));
    assert.equal(new Set(versions).size, 1, "identical concurrent registrations converge on one revision (Tenny 2108c37c)");
    assert.equal((await db.select().from(oauthAppLinkPreviews)).length, 1);
    const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
    const response = await fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).previews[0].title, "Example PR 3");
  } finally {
    __setPreviewHttpForTests(null);
    if (originalServerUrl === undefined) delete process.env.SERVER_URL; else process.env.SERVER_URL = originalServerUrl;
    if (example && example.exitCode === null) { example.kill("SIGTERM"); await new Promise<void>((resolve) => example!.once("close", () => resolve())); }
    try { await app?.close(); await clientDb?.end(); }
    finally { await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await control.end(); }
  }
});
