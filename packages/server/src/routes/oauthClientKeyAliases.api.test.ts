// RFC 084 step 1: a client key resolves to its App (current key, then alias), a
// taken key is refused, a used App's key stays reserved when it is deleted, and
// registration is limited per Server. Real routes and the real database (pglite:
// one connection, so the concurrency test below proves the answer two racing
// registrations get, not that the advisory lock serializes separate connections).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { oauthAccessRequests, oauthAccessTokens, oauthAppLinkPreviews, oauthClientKeyAliases, oauthClients, oauthGrants } from "../db/schema";
import { prepareActionCard } from "../services/actionCardsService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import {
  OAUTH_CLIENT_RECLAIMABLE_TOMBSTONES_PER_SERVER,
  OAuthClientKeyTakenError,
  resolveAgentLoginClient,
  resolveOAuthClientByKey,
} from "../services/oauthClientKeys";
import { __setOAuthAppRegistrationLimitForTests } from "../services/oauthClientRegistrationLimits";
import { authenticateOAuthClient, createOAuthClient, getOAuthClientForServer } from "../services/oauthService";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest();

type Seed = { human(values?: Record<string, unknown>): Promise<{ id: string; email: string }>; server(input: { owner: { id: string } }): Promise<{ id: string; slug: string }> };
type Res = { status: number; body: Record<string, any> };

const key = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;
const keyInputs = (value: string) => [value, value.toUpperCase(), value[0].toUpperCase() + value.slice(1)];

async function fixture(seed: Seed) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const token = await tokenForHuman(owner.email);
  return { owner, server, token };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function call(baseUrl: string, f: Fixture, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${f.token}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const register = (baseUrl: string, f: Fixture, clientId: string) =>
  call(baseUrl, f, "POST", "/api/integrations/clients", { name: clientId, clientId, returnUrl: "https://app.example.test/callback" });

const deleteApp = (baseUrl: string, f: Fixture, id: string) => call(baseUrl, f, "DELETE", `/api/integrations/clients/${id}`);

const makeApp = (f: Fixture, clientId: string, name = clientId) =>
  createOAuthClient({ serverId: f.server.id, createdByUserId: f.owner.id, clientId, name, returnUrl: "https://app.example.test/callback" });

const aliasRow = async (rowKey: string) =>
  (await getDb().select().from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.key, rowKey)))[0] ?? null;

const addAlias = (rowKey: string, clientId: string | null, sourceServerId: string, createdAt?: Date) =>
  getDb().insert(oauthClientKeyAliases).values({ key: rowKey, clientId, sourceServerId, ...(createdAt ? { createdAt } : {}) });

async function markUsedByRequest(f: Fixture, clientId: string) {
  const agent = await createAgent(f.server.id, key("usage"), { runtime: "codex" });
  await getDb().insert(oauthAccessRequests).values({ serverId: f.server.id, principalType: "agent", agentId: agent.id, clientId, scopes: ["openid"], status: "pending" });
}

async function assertTaken(baseUrl: string, f: Fixture, clientId: string) {
  const res = await register(baseUrl, f, clientId);
  assert.deepEqual([res.status, res.body.error], [409, "Client ID is already taken"], JSON.stringify(res.body));
}

test("the resolver: current key, alias, a tombstone or unknown key is not found", async ({ seed }) => {
  const f = await fixture(seed);
  const currentKey = key("current");
  const { client, clientSecret } = await makeApp(f, currentKey);
  const oldKey = key("old-id");
  const goneKey = key("gone");
  await addAlias(oldKey, client.id, f.server.id);
  await addAlias(goneKey, null, f.server.id);

  assert.deepEqual(await resolveOAuthClientByKey(currentKey), { id: client.id, clientKey: currentKey, matched: "current" });
  assert.deepEqual(await resolveOAuthClientByKey(oldKey), { id: client.id, clientKey: currentKey, matched: "alias" });
  assert.equal(await resolveOAuthClientByKey(goneKey), null);
  assert.equal(await resolveOAuthClientByKey(key("unknown")), null);

  // Client authentication goes through it; the secret is still that App's.
  assert.equal((await authenticateOAuthClient(oldKey, clientSecret))?.id, client.id);
  assert.equal(await authenticateOAuthClient(oldKey, "wrong-secret"), null);
  assert.equal(await authenticateOAuthClient(goneKey, clientSecret), null);

  // As the login routes' lookup does.
  assert.equal((await getOAuthClientForServer({ clientKey: oldKey, serverId: f.server.id }))?.id, client.id);
  assert.equal(await getOAuthClientForServer({ clientKey: goneKey, serverId: f.server.id }), null);
});

test("integration login: an alias wins over the exact name of another App, and never falls through to it", async ({ app, seed }) => {
  const f = await fixture(seed);
  const oldId = key("old-id");
  const { client: renamed } = await makeApp(f, key("renamed-app"), "Renamed App");
  await addAlias(oldId, renamed.id, f.server.id);
  const { client: sameName } = await makeApp(f, key("other-app"), oldId);
  const agent = await createAgent(f.server.id, key("login"), { runtime: "codex" });
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp"],
    name: "alias-login", issuedVia: "computer", createdByUserId: null,
  });

  for (const service of keyInputs(oldId)) {
    const login = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ service }),
    });
    const body = await login.json() as { status: string; service: { clientId: string } };
    assert.equal(login.status, 200, JSON.stringify(body));
    assert.equal(body.service.clientId, renamed.clientId, "the alias, not the App named like it, in every input case");
    // The alias's App outside the list: not found, not the name match.
    assert.deepEqual(await resolveAgentLoginClient([sameName], service), {
      ok: false, status: 404, error: "Registered service not found", clientKeyMatched: true,
    });
  }
  const { client: named } = await makeApp(f, key("named-app"), "An ordinary display name");
  assert.deepEqual(await resolveAgentLoginClient([named], "AN ORDINARY DISPLAY NAME"), { ok: true, client: named }, "names remain case insensitive when no key conflicts");
  assert.equal((await resolveAgentLoginClient([named], "Other Name That Is Not Here")).ok, false);
});

test("integration login: a deleted App's reserved key never names another OAuth App", async ({ app, seed }) => {
  const f = await fixture(seed);
  const oldKey = key("retired-login");
  const { client: oldApp } = await makeApp(f, oldKey);
  await markUsedByRequest(f, oldApp.id);
  assert.equal((await deleteApp(app.baseUrl, f, oldApp.id)).status, 200);
  assert.equal((await aliasRow(oldKey))?.clientId, null, "the used key stays reserved");
  const { client: other } = await makeApp(f, key("other-login"), oldKey);
  const agent = await createAgent(f.server.id, key("login"), { runtime: "codex" });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "reserved-login", issuedVia: "computer", createdByUserId: null });
  const login = async (service: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ service }),
    });
    return { status: res.status, body: await res.json() as { service?: { id: string }; error?: string } };
  };
  const legitimate = await login(other.clientId);
  assert.equal(legitimate.status, 200);
  assert.equal(legitimate.body.service?.id, other.id, "the other App remains usable by its own key");
  for (const service of keyInputs(oldKey)) {
    const refused = await login(service);
    assert.deepEqual(refused, { status: 404, body: { error: "Registered service not found" } });
    const inventory = await fetch(`${app.baseUrl}/internal/agent-api/integrations?service=${encodeURIComponent(service)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(inventory.status, 200);
    const directory = await inventory.json() as { resolvedServiceId: string | null; services: Array<{ id: string }> };
    assert.equal(directory.resolvedServiceId, null, "CLI and SDK resolution must not choose the namesake either");
    assert.ok(directory.services.some((client) => client.id === other.id), "the other App remains available");
  }
});

test("integration login: an unavailable current key never falls through to a candidate's display name", async ({ app, seed }) => {
  const f = await fixture(seed);
  const publisher = await fixture(seed);
  const currentKey = key("unavailable-login");
  const { client: holder } = await makeApp(publisher, currentKey, "Key holder");
  const { client: other } = await makeApp(f, key("other-login"), currentKey);
  const { client: named } = await makeApp(f, key("named-login"), "An ordinary display name");
  assert.deepEqual(await resolveAgentLoginClient([other], other.clientId), { ok: true, client: other });
  assert.deepEqual(await resolveAgentLoginClient([named], "AN ORDINARY DISPLAY NAME"), { ok: true, client: named });
  // A key-shaped display name with no registered/reserved key also remains usable.
  const { client: slugNamed } = await makeApp(f, key("slug-name-app"), key("ordinary-name"));
  assert.deepEqual(await resolveAgentLoginClient([slugNamed], slugNamed.name.toUpperCase()), { ok: true, client: slugNamed });
  const agent = await createAgent(f.server.id, key("login"), { runtime: "codex" });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "send"], name: "unavailable-login", issuedVia: "computer", createdByUserId: null });
  for (const service of keyInputs(currentKey)) {
    assert.deepEqual(await resolveAgentLoginClient([holder, other], service), { ok: true, client: holder });
    assert.deepEqual(await resolveAgentLoginClient([other], service), {
      ok: false, status: 404, error: "Registered service not found", clientKeyMatched: true,
    });
    const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/login`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ service }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Registered service not found" });
  }
});

test("taken: a current key, an alias and another Server's tombstone are refused, on the web route and the card", async ({ app, seed }) => {
  const f = await fixture(seed);
  const other = await fixture(seed);
  const currentKey = key("held");
  const { client } = await makeApp(f, currentKey);
  const aliased = key("aliased");
  const foreignTombstone = key("foreign");
  await addAlias(aliased, client.id, f.server.id);
  await addAlias(foreignTombstone, null, other.server.id);

  await assertTaken(app.baseUrl, f, currentKey);
  await assertTaken(app.baseUrl, f, aliased);
  await assertTaken(app.baseUrl, f, foreignTombstone);
  assert.ok(await aliasRow(foreignTombstone), "a refused registration removes nothing");

  // The card, refused at prepare by an alias row (a key some App holds is refused at execute, as it always was).
  const human = await seed.human();
  const server = await seed.server({ owner: human });
  const agent = await createAgent(server.id, key("card"), { runtime: "codex" });
  const channel = await createChannel(server.id, key("cards"), undefined, "channel");
  await addHuman(channel.id, human.id);
  await addAgent(channel.id, agent.id);
  const prepare = (clientKey: string) => prepareActionCard({
    serverId: server.id, requesterAgentId: agent.id, targetChannelId: channel.id,
    action: { type: "integration:register_app", name: "Card App", clientKey, returnUrl: "https://app.example.test/callback", scopes: [], unsafeDemoUrlOverride: false },
  });
  await assert.rejects(prepare(aliased), (err: Error & { code?: string }) => err.code === "CLIENT_KEY_TAKEN");

  const session = await signInForTest(human.id);
  const heldAtExecute = await prepare(currentKey);
  const executed = await fetch(`${app.baseUrl}/api/actions/${heldAtExecute.messageId}/execute`, {
    method: "POST", headers: { Authorization: `Bearer ${session.token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(executed.status, 409);
  assert.equal((await executed.json() as { errorCode: string }).errorCode, "CLIENT_KEY_TAKEN");
});

test("a tombstone reused by its own Server is a new App with a new uuid, and the row is gone", async ({ app, seed }) => {
  const f = await fixture(seed);
  const tombstone = key("reused");
  const { client: first } = await makeApp(f, tombstone);
  await markUsedByRequest(f, first.id);
  assert.equal((await deleteApp(app.baseUrl, f, first.id)).status, 200);
  assert.ok(await aliasRow(tombstone));

  const res = await register(app.baseUrl, f, tombstone);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(res.body.client.id, first.id, "a new uuid: nothing tied to the old App's id carries over");
  assert.equal(await aliasRow(tombstone), null, "removed in the transaction that took the key back");
  assert.deepEqual(await resolveOAuthClientByKey(tombstone), { id: res.body.client.id, clientKey: tombstone, matched: "current" });
});

test("delete: a used App leaves a tombstone, an unused one does not, and aliases become tombstones", async ({ app, seed }) => {
  const f = await fixture(seed);
  const agent = await createAgent(f.server.id, key("used-agent"), { runtime: "codex" });

  // Each way of being used, one at a time, so none is carried by another.
  const usedBy: Array<[string, (clientId: string) => Promise<unknown>]> = [
    ["grant", (clientId) => getDb().insert(oauthGrants).values({ serverId: f.server.id, agentId: agent.id, clientId, scopes: ["openid"], grantedByUserId: f.owner.id })],
    ["token", (clientId) => getDb().insert(oauthAccessTokens).values({ serverId: f.server.id, agentId: agent.id, clientId, tokenHash: `hash-${randomUUID()}`, scopes: ["openid"], expiresAt: new Date(Date.now() + 60_000) })],
    ["login request", (clientId) => markUsedByRequest(f, clientId)],
    ["link preview registration", (clientId) => getDb().insert(oauthAppLinkPreviews).values({ clientId, origin: `https://${randomUUID()}.example.test`, endpoint: "https://x.example.test/preview", paths: ["/"] })],
  ];
  for (const [label, markUsed] of usedBy) {
    const usedKey = key("used");
    const { client } = await makeApp(f, usedKey);
    await markUsed(client.id);
    assert.equal((await deleteApp(app.baseUrl, f, client.id)).status, 200, label);
    const row = await aliasRow(usedKey);
    assert.ok(row, `${label}: the key stays reserved`);
    assert.deepEqual([row!.clientId, row!.sourceServerId, row!.reclaimable], [null, f.server.id, true], label);
  }

  // The rows that showed use can go: the key is still reserved, because the
  // origin's domain file can still name it (Tenny, #proj-apps:#57).
  for (const [label, table] of [["link preview registration", oauthAppLinkPreviews], ["token", oauthAccessTokens]] as const) {
    const goneKey = key("used-then-gone");
    const { client } = await makeApp(f, goneKey);
    await usedBy.find(([name]) => name === label)![1](client.id);
    await getDb().delete(table).where(eq(table.clientId, client.id));
    assert.equal((await deleteApp(app.baseUrl, f, client.id)).status, 200, label);
    assert.ok(await aliasRow(goneKey), `${label}: reserved after its row was removed`);
  }

  const unusedKey = key("unused");
  const { client: unused } = await makeApp(f, unusedKey);
  assert.equal((await deleteApp(app.baseUrl, f, unused.id)).status, 200);
  assert.equal(await aliasRow(unusedKey), null, "create then delete reserves nothing");
  assert.equal((await register(app.baseUrl, f, unusedKey)).status, 200, "and the key is free again");

  const aliasedKey = key("aliased-current");
  const oldKey = key("aliased-old");
  const { client: aliasedApp } = await makeApp(f, aliasedKey);
  await addAlias(oldKey, aliasedApp.id, f.server.id);
  await markUsedByRequest(f, aliasedApp.id);
  assert.equal((await deleteApp(app.baseUrl, f, aliasedApp.id)).status, 200);
  assert.equal((await aliasRow(oldKey))?.clientId, null, "an alias of a deleted App is a tombstone");
  assert.ok(await aliasRow(aliasedKey));
  assert.equal(await resolveOAuthClientByKey(oldKey), null);
});

test("past 50 reclaimable tombstones the oldest stays reserved but its Server can no longer reuse it", async ({ app, seed }) => {
  const f = await fixture(seed);
  const hour = 60 * 60 * 1000;
  const keys = Array.from({ length: OAUTH_CLIENT_RECLAIMABLE_TOMBSTONES_PER_SERVER }, (_, i) => `seeded-${i}-${randomUUID().slice(0, 6)}`);
  await getDb().insert(oauthClientKeyAliases).values(keys.map((rowKey, i) => ({
    key: rowKey, clientId: null, sourceServerId: f.server.id, createdAt: new Date(Date.now() - (keys.length - i) * hour),
  })));

  const { client } = await makeApp(f, key("pushes-over"));
  await markUsedByRequest(f, client.id);
  assert.equal((await deleteApp(app.baseUrl, f, client.id)).status, 200);

  const oldest = await aliasRow(keys[0]!);
  assert.equal(oldest?.reclaimable, false, "the oldest lost the right, and the row stays");
  assert.equal((await aliasRow(keys[1]!))?.reclaimable, true, "the next oldest keeps it");
  await assertTaken(app.baseUrl, f, keys[0]!);
  assert.ok(await aliasRow(keys[0]!), "still reserved against everyone");
  const reusedNext = await register(app.baseUrl, f, keys[1]!);
  assert.equal(reusedNext.status, 200, JSON.stringify(reusedNext.body));

  const reclaimable = await getDb().select().from(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.sourceServerId, f.server.id));
  assert.equal(reclaimable.filter((row) => row.reclaimable && row.clientId === null).length, OAUTH_CLIENT_RECLAIMABLE_TOMBSTONES_PER_SERVER - 1,
    "the row that lost the right no longer counts");
});

test("a key on a trust list can't be reused from a tombstone, so a new App inherits neither legacy scopes nor Reminder trust", async ({ app, seed }) => {
  const f = await fixture(seed);
  await addAlias("winbox", null, f.server.id);
  await assertTaken(app.baseUrl, f, "winbox");

  const reminderKey = key("reminder");
  await addAlias(reminderKey, null, f.server.id);
  const saved = process.env.REMINDER_APP_CLIENT_ID;
  process.env.REMINDER_APP_CLIENT_ID = reminderKey;
  try {
    await assertTaken(app.baseUrl, f, reminderKey);
  } finally {
    if (saved === undefined) delete process.env.REMINDER_APP_CLIENT_ID; else process.env.REMINDER_APP_CLIENT_ID = saved;
  }

  // Deleting an App that holds a listed key reserves it even unused: the string itself carries the trust.
  await getDb().delete(oauthClientKeyAliases).where(eq(oauthClientKeyAliases.key, "winbox"));
  const { client: listed } = await makeApp(f, "winbox");
  assert.equal((await deleteApp(app.baseUrl, f, listed.id)).status, 200);
  assert.ok(await aliasRow("winbox"), "kept though the App was never used");
  await assertTaken(app.baseUrl, f, "winbox");
});

test("registration limit: past the budget the web route and the card both refuse, and deleting gives nothing back", async ({ app, seed }) => {
  const f = await fixture(seed);
  __setOAuthAppRegistrationLimitForTests(2);
  try {
    const first = await register(app.baseUrl, f, key("limit-one"));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await deleteApp(app.baseUrl, f, first.body.client.id)).status, 200);
    assert.equal((await register(app.baseUrl, f, key("limit-two"))).status, 200);

    const refused = await register(app.baseUrl, f, key("limit-three"));
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "oauth_app_registration_rate_limited");
    assert.match(refused.body.error, /limit of 2 new Apps/);

    const agent = await createAgent(f.server.id, key("limit-card"), { runtime: "codex" });
    const channel = await createChannel(f.server.id, key("limit-cards"), undefined, "channel");
    await addHuman(channel.id, f.owner.id);
    await addAgent(channel.id, agent.id);
    const card = await prepareActionCard({
      serverId: f.server.id, requesterAgentId: agent.id, targetChannelId: channel.id,
      action: { type: "integration:register_app", name: "Limited App", clientKey: key("limit-card-app"), returnUrl: "https://app.example.test/callback", scopes: [], unsafeDemoUrlOverride: false },
    });
    const session = await signInForTest(f.owner.id);
    const executed = await fetch(`${app.baseUrl}/api/actions/${card.messageId}/execute`, {
      method: "POST", headers: { Authorization: `Bearer ${session.token}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedState: "prepared" }),
    });
    assert.equal(executed.status, 429, await executed.clone().text());
    assert.equal((await executed.json() as { code: string }).code, "oauth_app_registration_rate_limited");
  } finally {
    __setOAuthAppRegistrationLimitForTests(null);
  }
});

test("two registrations of one key: one gets it, the other is told it is taken", async ({ seed }) => {
  const f = await fixture(seed);
  const raced = key("raced");
  const results = await Promise.allSettled([makeApp(f, raced), makeApp(f, raced)]);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof OAuthClientKeyTakenError, String(rejected[0]!.reason));
  assert.equal((await getDb().select().from(oauthClients).where(eq(oauthClients.clientId, raced))).length, 1);
});
