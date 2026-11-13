// A personal assistant changes some of its owner's settings when asked:
// GET/PATCH /internal/agent-api/assistant/owner-settings (theme and
// decorations in THIS server, UI display language, time zone). Pins: the same
// result, refusals and socket event as the owner's own web routes; the theme
// of the owner's other servers is untouched; non-assistants get 403; one audit
// row per changed setting (none for an unchanged one); the read answers the
// theme the owner sees (a Pro theme on a Free server is Raft Yellow) next to
// the stored one; the owner, and only the owner, reads the changes back at
// GET /api/servers/:id/assistant/setting-changes (their look in that server,
// their UI language and time zone changed from any server).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, featureFlags, integrationAuditEvents, serverMembers, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addMember } from "../services/serverService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type EmittedEvent = { room: string; event: string; payload: unknown };

function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  const room = (name: string) => ({
    emit(event: string, payload: unknown) {
      events.push({ room: name, event, payload });
    },
    to: (next: string) => room(`${name} ${next}`),
    in: (next: string) => room(`${name} ${next}`),
  });
  app.set("io", { to: room, in: room, emit: () => undefined });
  return events;
}

async function enableAssistants() {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
}

async function seed() {
  await enableAssistants();
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`settings-owner-${suffix}@slock.test`, `settings-owner-${suffix}`);
  const peer = await seedUser(`settings-peer-${suffix}@slock.test`, `settings-peer-${suffix}`);
  const server = await createServer("Settings Server", `settings-${suffix}`, owner.id);
  const otherServer = await createServer("Other Server", `settings-other-${suffix}`, owner.id);
  await addMember(server.id, peer.id);
  const assistant = await createAgent(server.id, `settings-helper-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "settings-test", issuedVia: "computer", createdByUserId: null });
  const ordinary = await createAgent(server.id, `settings-ordinary-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const { apiKey: ordinaryKey } = await mintAgentCredential({ agentId: ordinary.id, scopes: ["read", "send"], name: "settings-ordinary", issuedVia: "computer", createdByUserId: null });
  const ownerToken = await tokenForHuman(owner.email);
  const peerToken = await tokenForHuman(peer.email);
  return { owner, peer, server, otherServer, assistant, apiKey, ordinaryKey, ownerToken, peerToken };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function agentCall(baseUrl: string, apiKey: string, method: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/assistant/owner-settings`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function humanCall(baseUrl: string, token: string, serverId: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: headers(token, serverId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

/** What the owner's own web reads say. */
async function ownerView(baseUrl: string, f: Seeded, serverId = f.server.id) {
  const me = await humanCall(baseUrl, f.ownerToken, serverId, "GET", "/auth/me");
  const look = await humanCall(baseUrl, f.ownerToken, serverId, "GET", `/servers/${serverId}/appearance-settings`);
  const user = (me.body.user ?? me.body) as { displayLanguage: string | null; preferredTimezone: string | null };
  return { theme: look.body.theme, themeDecor: look.body.themeDecor, displayLanguage: user.displayLanguage, preferredTimezone: user.preferredTimezone };
}

/** The stored part of the assistant's read, in the shape of the owner's own reads (the default theme is null there). */
function storedView(settings: Record<string, any>) {
  return {
    theme: settings.storedTheme === "raft" ? null : settings.storedTheme,
    themeDecor: settings.themeDecor,
    displayLanguage: settings.displayLanguage,
    preferredTimezone: settings.preferredTimezone,
  };
}

const auditRowsOf = (agentId: string) => getDb().select().from(integrationAuditEvents)
  .where(and(eq(integrationAuditEvents.actorId, agentId), eq(integrationAuditEvents.eventType, "assistant.owner_setting_changed")));

test("GET returns the four settings; PATCH changes each one exactly as the owner's own web routes do", async ({ app }) => {
  const events = installFakeIo(app.app);
  const f = await seed();
  await getDb().update(users).set({ displayLanguage: "en", preferredTimezone: "UTC" }).where(eq(users.id, f.owner.id));

  const read = await agentCall(app.baseUrl, f.apiKey, "GET");
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.settings, { theme: "raft", storedTheme: "raft", themeDecor: true, themeDecorShown: false, displayLanguage: "en", preferredTimezone: "UTC" });
  assert.deepEqual(storedView(read.body.settings), await ownerView(app.baseUrl, f));

  // Time zone: as PATCH /api/auth/me stores it, visible on /me.
  const tz = await agentCall(app.baseUrl, f.apiKey, "PATCH", { preferredTimezone: " Europe/Berlin " });
  assert.equal(tz.status, 200, JSON.stringify(tz.body));
  assert.deepEqual(tz.body.changed, ["preferredTimezone"]);
  assert.equal((await ownerView(app.baseUrl, f)).preferredTimezone, "Europe/Berlin");

  // Display language: the web's normalization (zh-Hans -> zh-cn).
  const lang = await agentCall(app.baseUrl, f.apiKey, "PATCH", { displayLanguage: "zh-Hans" });
  assert.equal(lang.status, 200, JSON.stringify(lang.body));
  assert.equal((await ownerView(app.baseUrl, f)).displayLanguage, "zh-cn");
  // The same value through the owner's own route lands on the same stored value.
  await humanCall(app.baseUrl, f.ownerToken, f.server.id, "PATCH", "/auth/me", { displayLanguage: "zh-Hans" });
  assert.equal((await ownerView(app.baseUrl, f)).displayLanguage, "zh-cn");

  // Theme and decorations: the appearance read shows it, and the owner's tabs get the web route's event.
  const look = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "space", themeDecor: false });
  assert.equal(look.status, 200, JSON.stringify(look.body));
  assert.deepEqual(look.body.changed, ["theme", "themeDecor"]);
  assert.deepEqual(look.body.settings, { theme: "space", storedTheme: "space", themeDecor: false, themeDecorShown: false, displayLanguage: "zh-cn", preferredTimezone: "Europe/Berlin" });
  assert.deepEqual(storedView(look.body.settings), await ownerView(app.baseUrl, f));
  assert.deepEqual(events.filter((event) => event.event === "appearance:updated").at(-1), {
    room: `user:${f.owner.id}`,
    event: "appearance:updated",
    payload: { serverId: f.server.id, theme: "space", themeDecor: false },
  });

  // "raft" is the default, stored as none (null), as on the web; null clears language and zone.
  const reset = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "raft", displayLanguage: null, preferredTimezone: null });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.deepEqual(reset.body.settings, { theme: "raft", storedTheme: "raft", themeDecor: false, themeDecorShown: false, displayLanguage: null, preferredTimezone: null });
  assert.deepEqual(storedView(reset.body.settings), await ownerView(app.baseUrl, f));
});

test("GET answers the theme the owner sees: a Pro theme on a Free server reads raft, the stored one stays", async ({ app }) => {
  const events = installFakeIo(app.app);
  const f = await seed();
  await getDb().update(users).set({ displayLanguage: "en", preferredTimezone: "UTC" }).where(eq(users.id, f.owner.id));
  // The fixture's server is not on Free by default; this case is about Free.
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, f.server.id));
  const saved = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "boring" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.changed, ["theme"]);
  assert.deepEqual([saved.body.settings.theme, saved.body.settings.storedTheme], ["raft", "boring"]);
  // The audit and the owner's tabs get the stored choice; each client shows it by the plan.
  assert.deepEqual((await auditRowsOf(f.assistant.id)).map((row) => row.metadata), [{ setting: "theme", previousValue: "raft", nextValue: "boring" }]);
  assert.deepEqual(events.filter((event) => event.event === "appearance:updated").at(-1)?.payload, { serverId: f.server.id, theme: "boring", themeDecor: true });

  const free = await agentCall(app.baseUrl, f.apiKey, "GET");
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.deepEqual(free.body.settings, { theme: "raft", storedTheme: "boring", themeDecor: true, themeDecorShown: false, displayLanguage: "en", preferredTimezone: "UTC" });
  assert.deepEqual(storedView(free.body.settings), await ownerView(app.baseUrl, f));

  // On a paid plan the kept choice shows again.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, f.server.id));
  const paid = await agentCall(app.baseUrl, f.apiKey, "GET");
  assert.deepEqual([paid.body.settings.theme, paid.body.settings.storedTheme, paid.body.settings.themeDecorShown], ["boring", "boring", false]);
  const decorated = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "space" });
  assert.deepEqual([decorated.body.settings.theme, decorated.body.settings.themeDecorShown], ["space", true]);

  // Back on Free, raft is a change of the stored value even though raft was shown.
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, f.server.id));
  await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "boring" });
  const reset = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "raft" });
  assert.deepEqual(reset.body.changed, ["theme"]);
  assert.deepEqual([reset.body.settings.theme, reset.body.settings.storedTheme], ["raft", "raft"]);
});

test("PATCH theme changes only the owner's look in this server, never their other servers", async ({ app }) => {
  installFakeIo(app.app);
  const f = await seed();
  await humanCall(app.baseUrl, f.ownerToken, f.otherServer.id, "PATCH", `/servers/${f.otherServer.id}/appearance-settings`, { theme: "boring", themeDecor: true });
  const res = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "critters", themeDecor: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [here] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.owner.id)));
  const [there] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, f.otherServer.id), eq(serverMembers.userId, f.owner.id)));
  assert.deepEqual([here.theme, here.themeDecor], ["critters", false]);
  assert.deepEqual([there.theme, there.themeDecor], ["boring", true], "the other server keeps its own look");
});

test("invalid values are refused with the web's own errors and nothing is written", async ({ app }) => {
  installFakeIo(app.app);
  const f = await seed();
  await getDb().update(users).set({ displayLanguage: "en", preferredTimezone: "UTC" }).where(eq(users.id, f.owner.id));
  const before = await ownerView(app.baseUrl, f);
  const cases: Array<{ body: Record<string, unknown>; web: { path: string } }> = [
    { body: { theme: "neon" }, web: { path: `/servers/${f.server.id}/appearance-settings` } },
    { body: { theme: null }, web: { path: `/servers/${f.server.id}/appearance-settings` } },
    { body: { themeDecor: "yes" }, web: { path: `/servers/${f.server.id}/appearance-settings` } },
    { body: { preferredTimezone: "Mars/Olympus" }, web: { path: "/auth/me" } },
    { body: { preferredTimezone: 42 }, web: { path: "/auth/me" } },
    { body: { displayLanguage: "fr" }, web: { path: "/auth/me" } },
    { body: { displayLanguage: false }, web: { path: "/auth/me" } },
  ];
  for (const { body, web } of cases) {
    const mine = await agentCall(app.baseUrl, f.apiKey, "PATCH", body);
    const theirs = await humanCall(app.baseUrl, f.ownerToken, f.server.id, "PATCH", web.path, body);
    assert.equal(mine.status, 400, JSON.stringify(body));
    assert.deepEqual([mine.status, mine.body], [theirs.status, theirs.body], `${JSON.stringify(body)}: the web's refusal`);
  }
  // A valid field with an invalid one: nothing of it lands.
  const mixed = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "space", preferredTimezone: "Mars/Olympus" });
  assert.equal(mixed.status, 400);
  const empty = await agentCall(app.baseUrl, f.apiKey, "PATCH", {});
  assert.deepEqual([empty.status, empty.body.error], [400, "theme, themeDecor, displayLanguage or preferredTimezone is required"]);
  assert.deepEqual(await ownerView(app.baseUrl, f), before);
  assert.deepEqual(await auditRowsOf(f.assistant.id), []);
});

test("an agent that is not a personal assistant gets 403 and nothing is written", async ({ app }) => {
  installFakeIo(app.app);
  const f = await seed();
  const before = await ownerView(app.baseUrl, f);
  const read = await agentCall(app.baseUrl, f.ordinaryKey, "GET");
  assert.deepEqual([read.status, read.body.code], [403, "assistant_not_enabled"]);
  const write = await agentCall(app.baseUrl, f.ordinaryKey, "PATCH", { theme: "space", preferredTimezone: "Europe/Berlin" });
  assert.deepEqual([write.status, write.body.code], [403, "assistant_not_enabled"]);
  assert.deepEqual(await ownerView(app.baseUrl, f), before);
  const rows = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "assistant.owner_setting_changed"), eq(integrationAuditEvents.serverId, f.server.id)));
  assert.deepEqual(rows, []);
});

test("audit: one row per changed setting with its old and new value; none for an unchanged one", async ({ app }) => {
  installFakeIo(app.app);
  const f = await seed();
  await getDb().update(users).set({ displayLanguage: "en", preferredTimezone: "UTC" }).where(eq(users.id, f.owner.id));
  const res = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "space", themeDecor: true, displayLanguage: "en", preferredTimezone: "Asia/Tokyo" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.changed, ["theme", "preferredTimezone"]);
  const rows = await auditRowsOf(f.assistant.id);
  const summary = rows
    .map((row) => ({ server: row.serverId, actor: [row.actorType, row.actorId], subject: [row.subjectType, row.subjectId], metadata: row.metadata }))
    .sort((a, b) => String(a.metadata.setting).localeCompare(String(b.metadata.setting)));
  assert.deepEqual(summary, [
    { server: f.server.id, actor: ["agent", f.assistant.id], subject: ["human", f.owner.id], metadata: { setting: "preferredTimezone", previousValue: "UTC", nextValue: "Asia/Tokyo" } },
    { server: f.server.id, actor: ["agent", f.assistant.id], subject: ["human", f.owner.id], metadata: { setting: "theme", previousValue: "raft", nextValue: "space" } },
  ]);
  // The same values again: nothing changed, nothing recorded.
  const again = await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "space", preferredTimezone: "Asia/Tokyo" });
  assert.deepEqual(again.body.changed, []);
  assert.equal((await auditRowsOf(f.assistant.id)).length, 2);
});

test("the owner reads what their assistant changed, newest first; nobody else does", async ({ app }) => {
  installFakeIo(app.app);
  const f = await seed();
  await getDb().update(users).set({ preferredTimezone: "UTC" }).where(eq(users.id, f.owner.id));
  await agentCall(app.baseUrl, f.apiKey, "PATCH", { preferredTimezone: "Europe/Berlin" });
  await agentCall(app.baseUrl, f.apiKey, "PATCH", { theme: "space" });

  const mine = await humanCall(app.baseUrl, f.ownerToken, f.server.id, "GET", `/servers/${f.server.id}/assistant/setting-changes`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const changes = mine.body.changes as Array<Record<string, unknown>>;
  assert.deepEqual(changes.map(({ setting, previousValue, nextValue, agentId, serverId, serverName }) => ({ setting, previousValue, nextValue, agentId, serverId, serverName })), [
    { setting: "theme", previousValue: "raft", nextValue: "space", agentId: f.assistant.id, serverId: f.server.id, serverName: "Settings Server" },
    { setting: "preferredTimezone", previousValue: "UTC", nextValue: "Europe/Berlin", agentId: f.assistant.id, serverId: f.server.id, serverName: "Settings Server" },
  ]);
  assert.ok(changes.every((change) => typeof change.createdAt === "string" && !Number.isNaN(Date.parse(String(change.createdAt)))));

  // Another member of the same server sees none of the owner's changes.
  const theirs = await humanCall(app.baseUrl, f.peerToken, f.server.id, "GET", `/servers/${f.server.id}/assistant/setting-changes`);
  assert.deepEqual([theirs.status, theirs.body.changes], [200, []]);
  // The owner's other server: the time zone is the account's, so it shows
  // there too, with the server it was changed in; this server's theme does not.
  const elsewhere = await humanCall(app.baseUrl, f.ownerToken, f.otherServer.id, "GET", `/servers/${f.otherServer.id}/assistant/setting-changes`);
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
  assert.deepEqual((elsewhere.body.changes as Array<Record<string, unknown>>).map(({ setting, nextValue, serverId, serverName }) => ({ setting, nextValue, serverId, serverName })), [
    { setting: "preferredTimezone", nextValue: "Europe/Berlin", serverId: f.server.id, serverName: "Settings Server" },
  ]);
  // Someone outside the server cannot read it at all.
  const outsider = await seedUser(`settings-outsider-${randomUUID().slice(0, 8)}@slock.test`, `settings-outsider-${randomUUID().slice(0, 8)}`);
  const outside = await humanCall(app.baseUrl, await tokenForHuman(outsider.email), f.server.id, "GET", `/servers/${f.server.id}/assistant/setting-changes`);
  assert.notEqual(outside.status, 200);
});
