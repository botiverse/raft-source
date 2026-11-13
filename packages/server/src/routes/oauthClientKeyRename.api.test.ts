// RFC 084 step 2: an unpublished App can change its client id. Real routes on
// pglite: rename by web and agent, the refusals, what an old id still does,
// which id is signed, and the link-card rows that move.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { getDb } from "../db/index";
import {
  integrationAuditEvents, linkCardClientRequests, linkCardOperations, linkCardUpdateTokens, linkCardViews,
  oauthAccessRequests, oauthAppLinkPreviews, oauthClientInstalls, oauthClientKeyAliases, oauthClientMaintainers, oauthClients, officialAppRegistry, oauthUserConsents,
} from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __setPreviewHttpForTests, recheckAppLinkPreview } from "../services/appLinkPreviewService";
import { __setOAuthClientKeyRenameLimitForTests } from "../services/oauthClientKeyRenameLimits";
import { resolveOAuthClientByKey } from "../services/oauthClientKeys";
import { authenticateOAuthClient, createOAuthClient } from "../services/oauthService";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";

const test = createApiTest();

type Seed = { human(values?: Record<string, unknown>): Promise<{ id: string; email: string }>; server(input: { owner: { id: string } }): Promise<{ id: string; slug: string }> };
type Res = { status: number; body: Record<string, any> };

const key = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;
const previousSigningKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;

beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  __setOAuthClientKeyRenameLimitForTests(null);
});
afterEach(() => {
  __setPreviewHttpForTests(null);
  __setOAuthClientKeyRenameLimitForTests(null);
  if (previousSigningKey === undefined) delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY; else process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = previousSigningKey;
});

async function fixture(seed: Seed) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const token = await tokenForHuman(owner.email);
  return { owner, server, token };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const makeApp = (f: Fixture, clientId = key("app"), name = clientId) =>
  createOAuthClient({ serverId: f.server.id, createdByUserId: f.owner.id, clientId, name, returnUrl: "https://app.example.test/callback", allowedScopes: ["openid", "profile"] });

async function call(baseUrl: string, f: Fixture, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${f.token}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

/** The PATCH the edit form sends; the id is the only change. */
const renameOnWeb = (baseUrl: string, f: Fixture, appId: string, clientId: string) =>
  call(baseUrl, f, "PATCH", `/api/integrations/clients/${appId}`, { clientId });

async function markUsed(f: Fixture, clientId: string) {
  const agent = await createAgent(f.server.id, key("usage"), { runtime: "codex" });
  await getDb().insert(oauthAccessRequests).values({ serverId: f.server.id, principalType: "agent", agentId: agent.id, clientId, scopes: ["openid"], status: "pending" });
}

const aliasRow = async (rowKey: string) =>
  (await getDb().select().from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.key, rowKey)))[0] ?? null;
const currentKey = async (id: string) =>
  (await getDb().select({ clientId: oauthClients.clientId }).from(oauthClients).where(eq(oauthClients.id, id)))[0]!.clientId;

async function agentCredential(f: Fixture, input: { ownerOf?: string } = {}) {
  const agent = await createAgent(f.server.id, key("agent"), { runtime: "codex" });
  if (input.ownerOf) {
    await getDb().insert(oauthClientMaintainers).values({ clientId: input.ownerOf, principalType: "agent", agentId: agent.id, role: "owner", assignedByType: "system" });
  }
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id, scopes: ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"],
    name: "rename", issuedVia: "computer", createdByUserId: null,
  });
  return { agent, apiKey };
}

async function agentCall(baseUrl: string, apiKey: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, any>;

test("the owner renames an unpublished App: a never-used id is simply freed, a used one stays an alias", async ({ app, seed }) => {
  const f = await fixture(seed);
  const unused = key("unused");
  const { client: fresh } = await makeApp(f, unused);
  const nextFresh = key("next-fresh");
  const freed = await renameOnWeb(app.baseUrl, f, fresh.id, nextFresh);
  assert.equal(freed.status, 200, JSON.stringify(freed.body));
  assert.equal(freed.body.clientId, nextFresh);
  assert.equal(await aliasRow(unused), null, "never used: no alias, the id is free again");
  // Another App can register the freed id.
  const reuse = await call(app.baseUrl, f, "POST", "/api/integrations/clients", { name: unused, clientId: unused, returnUrl: "https://app.example.test/callback" });
  assert.equal(reuse.status, 200, JSON.stringify(reuse.body));

  const used = key("used");
  const { client: usedApp, clientSecret } = await makeApp(f, used);
  await markUsed(f, usedApp.id);
  const moved = key("moved");
  const renamed = await renameOnWeb(app.baseUrl, f, usedApp.id, moved);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.clientId, moved);
  const alias = await aliasRow(used);
  assert.equal(alias?.clientId, usedApp.id, "used: the old id stays this App's");
  assert.equal(alias?.sourceServerId, f.server.id);
  assert.deepEqual(await resolveOAuthClientByKey(used), { id: usedApp.id, clientKey: moved, matched: "alias" });
  assert.equal((await authenticateOAuthClient(used, clientSecret))?.id, usedApp.id, "the old id still authenticates");
  // The same PATCH with the id unchanged (the form always sends it) is no rename.
  const sameAgain = await call(app.baseUrl, f, "PATCH", `/api/integrations/clients/${usedApp.id}`, { clientId: moved, description: "edited" });
  assert.equal(sameAgain.status, 200, JSON.stringify(sameAgain.body));
  assert.equal((await aliasRow(moved)), null, "no alias of itself");

  const [audit] = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, usedApp.id), eq(integrationAuditEvents.eventType, "app.client_key_changed")))
    .orderBy(desc(integrationAuditEvents.createdAt));
  assert.equal(audit?.actorType, "human");
  assert.equal(audit?.actorId, f.owner.id);
  assert.deepEqual(
    [audit?.metadata?.previousClientKey, audit?.metadata?.newClientKey, audit?.metadata?.previousKeyKept],
    [used, moved, true],
  );
});

test("an agent with App authority renames with --client-key, addressing the App by either id; without authority it is refused", async ({ app, seed }) => {
  const f = await fixture(seed);
  const old = key("agent-old");
  const { client } = await makeApp(f, old);
  await markUsed(f, client.id);
  const { apiKey } = await agentCredential(f, { ownerOf: client.id });
  const stranger = await agentCredential(f);

  const refused = await agentCall(app.baseUrl, stranger.apiKey, "/integrations/app/update", { clientKey: old, newClientKey: key("nope") });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.errorCode, "APP_MANAGE_AUTHORITY_REQUIRED");
  assert.equal(await currentKey(client.id), old);

  const next = key("agent-next");
  const renamed = await agentCall(app.baseUrl, apiKey, "/integrations/app/update", { clientKey: old, newClientKey: next });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.clientKey, next);
  assert.deepEqual(renamed.body.updatedFields, ["clientKey"]);
  assert.equal((await aliasRow(old))?.clientId, client.id);

  // Still addressed by the old id, as an agent's memory would.
  const third = key("agent-third");
  const again = await agentCall(app.baseUrl, apiKey, "/integrations/app/update", { clientKey: old, newClientKey: third, description: "kept" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(await currentKey(client.id), third);
  const [audit] = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, client.id), eq(integrationAuditEvents.eventType, "app.client_key_changed")))
    .orderBy(desc(integrationAuditEvents.createdAt));
  assert.equal(audit?.actorType, "agent");
});

test("a listed, official or in-review App is refused, on the web route and the agent route; the same id is not a rename", async ({ app, seed }) => {
  const f = await fixture(seed);
  for (const publishStatus of ["published", "publish_requested", "in_review", "unpublish_requested"] as const) {
    const old = key(publishStatus.replaceAll("_", "-"));
    const { client } = await makeApp(f, old);
    await getDb().update(oauthClients).set({ publishStatus }).where(eq(oauthClients.id, client.id));
    const web = await renameOnWeb(app.baseUrl, f, client.id, key("nope"));
    assert.equal(web.status, 409, `${publishStatus} ${JSON.stringify(web.body)}`);
    assert.equal(web.body.code, "CLIENT_KEY_CHANGE_NEEDS_REVIEW");
    assert.equal(await currentKey(client.id), old);
    const unchanged = await renameOnWeb(app.baseUrl, f, client.id, old);
    assert.equal(unchanged.status, 200, `the unchanged id saves on a ${publishStatus} App`);
  }
  // Official: registered in the official registry, whatever its publish status says.
  const officialKey = key("official");
  const { client: official } = await makeApp(f, officialKey);
  await getDb().insert(officialAppRegistry).values({ oauthClientId: official.id, clientKey: officialKey, publisherServerId: f.server.id, purpose: "test" });
  const editPage = await fetch(`${app.baseUrl}/api/integrations/clients`, { headers: { Authorization: `Bearer ${f.token}`, "X-Server-Id": f.server.id } });
  const rows = await editPage.json() as Array<{ id: string; official?: boolean }>;
  assert.equal(rows.find((row) => row.id === official.id)?.official, true, "the edit page knows");
  const officialWeb = await renameOnWeb(app.baseUrl, f, official.id, key("nope"));
  assert.equal(officialWeb.status, 409, JSON.stringify(officialWeb.body));
  assert.equal(officialWeb.body.code, "CLIENT_KEY_CHANGE_NEEDS_REVIEW");
  assert.equal(await currentKey(official.id), officialKey);

  // Refused the same way through the agent route, for an agent that is an admin.
  const adminAgent = await agentCredential(f);
  await getDb().execute(`UPDATE server_agent_members SET role = 'admin' WHERE agent_id = '${adminAgent.agent.id}'`);
  const listedKey = key("listed");
  const { client: listed } = await makeApp(f, listedKey);
  await getDb().update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, listed.id));
  const agentAnswer = await agentCall(app.baseUrl, adminAgent.apiKey, "/integrations/app/update", { clientKey: listedKey, newClientKey: key("nope") });
  assert.equal(agentAnswer.status, 409, JSON.stringify(agentAnswer.body));
  assert.equal(agentAnswer.body.code, "CLIENT_KEY_CHANGE_NEEDS_REVIEW");
});

test("taken and format: another App's id, an alias, a tombstone or an invalid id is refused", async ({ app, seed }) => {
  const f = await fixture(seed);
  const { client } = await makeApp(f, key("mine"));
  const { client: other } = await makeApp(f, key("other"));
  const otherKey = other.clientId;
  const refusedAs = async (target: string, status: number, code: string) => {
    const res = await renameOnWeb(app.baseUrl, f, client.id, target);
    assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(res.body));
    assert.equal(await currentKey(client.id), client.clientId);
  };
  await refusedAs(otherKey, 409, "CLIENT_KEY_TAKEN");
  const othersAlias = key("alias");
  await getDb().insert(oauthClientKeyAliases).values({ key: othersAlias, clientId: other.id, sourceServerId: f.server.id });
  await refusedAs(othersAlias, 409, "CLIENT_KEY_TAKEN");
  // A tombstone: this Server's own one can only be reused by registering (RFC 084 §3.5).
  const tombstone = key("gone");
  await getDb().insert(oauthClientKeyAliases).values({ key: tombstone, clientId: null, sourceServerId: f.server.id });
  await refusedAs(tombstone, 409, "CLIENT_KEY_TAKEN");
  // The legacy scope list is matched as a string: a rename would lose it or hand it over.
  await refusedAs("winbox", 409, "CLIENT_KEY_CARRIES_TRUST");
  const { client: legacy } = await makeApp(f, "linkerdog-796e47");
  const legacyAnswer = await renameOnWeb(app.baseUrl, f, legacy.id, key("no-trust"));
  assert.deepEqual([legacyAnswer.status, legacyAnswer.body.code], [409, "CLIENT_KEY_CARRIES_TRUST"], JSON.stringify(legacyAnswer.body));
  assert.equal(await currentKey(legacy.id), "linkerdog-796e47");
  // The key the deployment names Reminder by: nobody else may take it, and its App keeps it even unused.
  const reminderKey = key("reminder");
  const savedReminder = process.env.REMINDER_APP_CLIENT_ID;
  process.env.REMINDER_APP_CLIENT_ID = reminderKey;
  try {
    await refusedAs(reminderKey, 409, "CLIENT_KEY_CARRIES_TRUST");
    const { client: reminder } = await makeApp(f, reminderKey);
    const moved = key("reminder-moved");
    assert.equal((await renameOnWeb(app.baseUrl, f, reminder.id, moved)).status, 200);
    assert.equal(await currentKey(reminder.id), moved);
    const [kept] = await getDb().select().from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.key, reminderKey));
    assert.equal(kept?.clientId, reminder.id, "kept though the App was never used");
    assert.equal((await renameOnWeb(app.baseUrl, f, reminder.id, reminderKey)).status, 200, "its App may go back");
    assert.equal(await currentKey(reminder.id), reminderKey);
  } finally {
    if (savedReminder === undefined) delete process.env.REMINDER_APP_CLIENT_ID; else process.env.REMINDER_APP_CLIENT_ID = savedReminder;
  }
  await refusedAs("x", 400, "INVALID_CLIENT_KEY");
  await refusedAs("Has Space", 400, "INVALID_CLIENT_KEY");
  // A refusal naming an id containing "scope" is still the refusal, not the route's message match.
  const scopeNamed = key("scope");
  const { client: scopeHolder } = await makeApp(f, scopeNamed);
  assert.ok(scopeHolder);
  await refusedAs(scopeNamed, 409, "CLIENT_KEY_TAKEN");
});

test("limits: at most 20 aliases, and at most 5 renames a day", async ({ app, seed }) => {
  const f = await fixture(seed);
  const { client } = await makeApp(f, key("limits"));
  await markUsed(f, client.id);
  // Nineteen aliases and one rename makes 20: the 20th fits, a 21st doesn't.
  for (let i = 0; i < 19; i++) await getDb().insert(oauthClientKeyAliases).values({ key: key(`alias-${i}`), clientId: client.id, sourceServerId: f.server.id });
  const twentieth = await renameOnWeb(app.baseUrl, f, client.id, key("limit-a"));
  assert.equal(twentieth.status, 200, JSON.stringify(twentieth.body));
  const refused = await renameOnWeb(app.baseUrl, f, client.id, key("limit-b"));
  assert.deepEqual([refused.status, refused.body.code], [409, "CLIENT_KEY_ALIAS_LIMIT"], JSON.stringify(refused.body));
  // Going back to an own alias doesn't grow the list, so it still works at the limit.
  const [own] = await getDb().select({ key: oauthClientKeyAliases.key }).from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.clientId, client.id)).limit(1);
  const back = await renameOnWeb(app.baseUrl, f, client.id, own!.key);
  assert.equal(back.status, 200, JSON.stringify(back.body));

  const { client: busy } = await makeApp(f, key("busy"));
  __setOAuthClientKeyRenameLimitForTests(5);
  for (let i = 0; i < 5; i++) {
    const res = await renameOnWeb(app.baseUrl, f, busy.id, key(`rename-${i}`));
    assert.equal(res.status, 200, `rename ${i}: ${JSON.stringify(res.body)}`);
  }
  const tooMany = await renameOnWeb(app.baseUrl, f, busy.id, key("rename-six"));
  assert.equal(tooMany.status, 429, JSON.stringify(tooMany.body));
  assert.equal(tooMany.body.code, "CLIENT_KEY_RENAME_RATE_LIMITED");
  // A refused attempt doesn't spend one, so the sixth was refused by the limit and not earlier.
  __setOAuthClientKeyRenameLimitForTests(1);
  const { client: spender } = await makeApp(f, key("spender"));
  const taken = await renameOnWeb(app.baseUrl, f, spender.id, await currentKey(busy.id));
  assert.equal(taken.status, 409);
  const stillAllowed = await renameOnWeb(app.baseUrl, f, spender.id, key("spender-next"));
  assert.equal(stillAllowed.status, 200, "the refused attempt didn't use the App's one rename");
});

test("going back to an old id of its own swaps the rows", async ({ app, seed }) => {
  const f = await fixture(seed);
  const first = key("first");
  const { client } = await makeApp(f, first);
  await markUsed(f, client.id);
  const second = key("second");
  assert.equal((await renameOnWeb(app.baseUrl, f, client.id, second)).status, 200);
  assert.equal((await aliasRow(first))?.clientId, client.id);
  const back = await renameOnWeb(app.baseUrl, f, client.id, first);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await currentKey(client.id), first);
  assert.equal(await aliasRow(first), null, "its own id again, not an alias");
  assert.equal((await aliasRow(second))?.clientId, client.id, "the other id became the alias");
  assert.equal((await getDb().select().from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.clientId, client.id))).length, 1);
});

test("an old id still logs in, resolves --service and gets an agent JWT; each signs the id presented", async ({ app, seed }) => {
  const f = await fixture(seed);
  const old = key("signing-old");
  const redirectUri = "https://app.example.test/callback";
  const { client, clientSecret } = await makeApp(f, old);
  await getDb().insert(oauthClientInstalls).values({ clientId: client.id, serverId: f.server.id, installedByUserId: f.owner.id }).onConflictDoNothing();
  await markUsed(f, client.id);
  const next = key("signing-new");
  assert.equal((await renameOnWeb(app.baseUrl, f, client.id, next)).status, 200);

  // A second App that happens to be named like the old id must not win.
  await makeApp(f, key("namesake"), old);

  const verifier = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const humanToken = f.token;
  const login = async (presented: string, exchangeWith = presented) => {
    const authorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: { Authorization: `Bearer ${humanToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: presented, serverId: f.server.id, returnUrl: redirectUri, scopes: ["openid"], oidc: true, codeChallenge: challenge, codeChallengeMethod: "S256" }),
    });
    assert.equal(authorize.status, 200, await authorize.clone().text());
    const { code } = await authorize.json() as { code: string };
    const tokenResponse = await fetch(`${app.baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${exchangeWith}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    return claimsOf((await tokenResponse.json() as { id_token: string }).id_token);
  };
  assert.equal((await login(old)).aud, old, "an App still on the old id gets the old aud");
  assert.equal((await login(next)).aud, next, "an App that moved gets the new one");
  // A code issued under the old id, exchanged after the App moved to the new one.
  assert.equal((await login(old, next)).aud, old, "the id presented at authorize, carried in the code");

  const { apiKey } = await agentCredential(f, { ownerOf: client.id });
  const jwtFor = async (service: string) => {
    const res = await agentCall(app.baseUrl, apiKey, "/integrations/token", { service });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as { access_token: string; audience: string };
  };
  const oldAud = await jwtFor(old);
  assert.equal(oldAud.audience, old);
  assert.equal(claimsOf(oldAud.access_token).aud, old);
  const newAud = await jwtFor(next);
  assert.equal(claimsOf(newAud.access_token).aud, next);

  const listed = await agentCall(app.baseUrl, apiKey, `/integrations?service=${old}`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.resolvedServiceId, client.id, "the old id names this App, not its namesake");
  const byCurrent = await agentCall(app.baseUrl, apiKey, `/integrations?service=${next}`);
  assert.equal(byCurrent.body.resolvedServiceId, client.id);
  const noneAsked = await agentCall(app.baseUrl, apiKey, "/integrations");
  assert.equal("resolvedServiceId" in noneAsked.body, false, "only when a service was asked about");
  const notAKey = await agentCall(app.baseUrl, apiKey, `/integrations?service=${key("unknown")}`);
  assert.equal(notAKey.body.resolvedServiceId, null);
});

test("a link preview keeps the id the App proved until its domain file names the new one", async ({ app, db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const f = { owner, server, token: await tokenForHuman(owner.email) };
  const channel = await seed.channel({ server, members: [owner], visibility: "private" });
  const message = await seed.message({ channel, author: owner, content: "See https://preview.example.test/pr/1" });
  const old = key("preview-old");
  const { client, clientSecret } = await makeApp(f, old);
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: f.server.id, installedByUserId: f.owner.id }).onConflictDoNothing();
  await db.insert(oauthUserConsents).values({ serverId: f.server.id, userId: f.owner.id, clientId: client.id, scopes: ["openid", "profile"] });
  const headers = { Authorization: `Bearer ${f.token}`, "X-Server-Id": f.server.id };
  let fileNames: unknown = old;
  let lastAud = "";
  const card = { version: 1, title: "PR", card: { root: "status", elements: { status: { type: "Badge", props: { text: "Open" } } } } };
  __setPreviewHttpForTests(async (_url, body, assertion) => {
    if (!body) return { client_id: fileNames };
    lastAud = claimsOf(assertion!).aud;
    return card;
  });
  const registration = { origin: "https://preview.example.test", endpoint: "https://preview.example.test/callback", paths: ["/pr"] };
  const clientHeaders = (id: string) => ({ Authorization: `Basic ${Buffer.from(`${id}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json" });
  assert.equal((await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: "PUT", headers: clientHeaders(old), body: JSON.stringify(registration) })).status, 200);
  const provedKey = async () => (await db.select({ key: oauthAppLinkPreviews.provedClientKey }).from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)))[0]!.key;
  assert.equal(await provedKey(), old);
  const read = async () => {
    const res = await fetch(`${app.baseUrl}/api/messages/${message.id}/app-link-previews`, { headers });
    assert.equal(res.status, 200);
    return res.json() as Promise<{ previews: unknown[] }>;
  };
  assert.equal((await read()).previews.length, 1);
  assert.equal(lastAud, `urn:raft:link-preview:${old}`);

  const next = key("preview-new");
  assert.equal((await renameOnWeb(app.baseUrl, f, client.id, next)).status, 200);
  assert.equal((await read()).previews.length, 1);
  assert.equal(lastAud, `urn:raft:link-preview:${old}`, "the proved id, not the new one");
  // Recheck, file unchanged: still proven (an alias of this App), still the old id.
  const recheck = async () => {
    await db.update(oauthAppLinkPreviews).set({ lastCheckedAt: null }).where(eq(oauthAppLinkPreviews.clientId, client.id));
    return recheckAppLinkPreview(client.id);
  };
  assert.equal((await recheck())?.proof, "match");
  assert.equal(await provedKey(), old);
  const [row] = await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id));
  assert.equal(row!.suspendedAt, null, "an alias in the file doesn't suspend the App");

  // The App updates its file: the next proof moves the audience.
  fileNames = next;
  assert.equal((await recheck())?.proof, "match");
  assert.equal(await provedKey(), next);
  assert.equal((await read()).previews.length, 1);
  assert.equal(lastAud, `urn:raft:link-preview:${next}`);

  // A file naming some other App's id is still a mismatch, and still suspends.
  fileNames = key("someone-else");
  assert.equal((await recheck())?.proof, "mismatch");
  assert.notEqual((await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)))[0]!.suspendedAt, null);
});

test("the rename moves open link-card rows to the new id and leaves closed ones", async ({ app, db, seed }) => {
  const f = await fixture(seed);
  const old = key("rows-old");
  const { client } = await makeApp(f, old);
  await markUsed(f, client.id);
  const base = { viewerId: f.owner.id, serverId: f.server.id, providerKind: "app" as const, providerKey: old, installationKey: randomUUID() };
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const operation = async (state: "accepted" | "done") => {
    const [row] = await db.insert(linkCardOperations).values({
      operationId: randomUUID(), ...base, registrationRevision: randomUUID(), viewNonce: randomUUID(), messageId: randomUUID(),
      urlSha256: "a".repeat(64), actionEndpointSha256: "b".repeat(64), actionOrigin: "https://preview.example.test", actionId: "go",
      requestSha256: "0".repeat(64), state, createdAt, firstSendDeadline: new Date(createdAt.getTime() + 600_000),
    }).returning();
    return row!;
  };
  const open = await operation("accepted");
  const closed = await operation("done");
  const closedWithLiveToken = await operation("done");
  const token = (operationId: string, expiresAt: Date) =>
    db.insert(linkCardUpdateTokens).values({ tokenSha256: randomUUID().replaceAll("-", "").padEnd(64, "0"), operationId, ...base, registrationRevision: randomUUID(), expiresAt });
  const live = new Date(Date.now() + 60_000);
  await token(open.operationId, live);
  await token(closedWithLiveToken.operationId, live);
  await token(closed.operationId, new Date(Date.now() - 60_000));
  await db.insert(linkCardClientRequests).values({ ...base, clientRequestId: randomUUID(), operationId: open.operationId, urlSha256: "a".repeat(64), actionId: "go", requestSha256: "0".repeat(64) });
  await db.insert(linkCardViews).values({ viewNonce: randomUUID(), viewInstanceId: randomUUID(), ...base, messageId: randomUUID(), urlSha256: "a".repeat(64), pendingOperationId: open.operationId });

  const next = key("rows-new");
  const renamed = await renameOnWeb(app.baseUrl, f, client.id, next);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  const keyOf = async (operationId: string) => (await db.select({ key: linkCardOperations.providerKey }).from(linkCardOperations).where(eq(linkCardOperations.operationId, operationId)))[0]!.key;
  assert.equal(await keyOf(open.operationId), next, "a non-terminal operation moves");
  assert.equal(await keyOf(closed.operationId), old, "a terminal one keeps the id it was written with");
  assert.equal(await keyOf(closedWithLiveToken.operationId), next, "a terminal operation with a live token moves with it, so accepting the update still matches");
  const tokens = await db.select({ key: linkCardUpdateTokens.providerKey, op: linkCardUpdateTokens.operationId }).from(linkCardUpdateTokens);
  const tokenKey = (opId: string) => tokens.find((row) => row.op === opId)?.key;
  assert.equal(tokenKey(open.operationId), next, "a live token moves");
  assert.equal(tokenKey(closed.operationId), old, "an expired token stays");
  assert.equal((await db.select().from(linkCardClientRequests))[0]?.providerKey, next);
  assert.equal((await db.select().from(linkCardViews))[0]?.providerKey, next);
});
