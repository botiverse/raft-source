import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { getDb } from "../db/index";
import { managedMcpCredentials, managedMcpServers, mcpAppTemplates, users } from "../db/schema";
import { addMember, createServer } from "./serverService";
import { encryptManagedMcpHeaders } from "./managedMcpCredentialService";
import { clearMcpAppLogo, createMcpApp, getMcpAppView, listMcpApps, updateMcpApp } from "./managedMcpAppService";
import { createManagedMcpServer, listManagedMcpServerCatalog, rethrowIfMcpAppNameTaken, updateManagedMcpServer } from "./managedMcpService";
import { __resetMcpAppTemplatesForTests, findActiveMcpAppTemplate, findMcpAppTemplate, findMcpAppTemplateRow, listMcpAppTemplates, parseMcpAppTemplates } from "./mcpAppTemplates";
import * as mcpTemplateCatalog from "./mcpAppTemplates";
import type { McpProbeResult } from "./managedMcpProbe";

const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(async () => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 29).toString("base64");
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});

async function seed() {
  const makeUser = async (label: string) => (await getDb().insert(users).values({
    email: `mcp-apps-${label}-${randomUUID()}@slock.test`,
    name: `mcp-apps-${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning())[0];
  const owner = await makeUser("owner");
  const member = await makeUser("member");
  const server = await createServer("MCP Apps", `mcp-apps-${randomUUID()}`, owner.id);
  await addMember(server.id, member.id, "member");
  return { owner, member, server };
}

const ENDPOINT = "https://apps.example.test/mcp";
const probeAs = (result: Partial<McpProbeResult>, toolCatalog: Array<{ name: string; inputSchema: { type: "object" } }> | null = null) =>
  async (endpointUrl: string) => ({ result: { endpointUrl, latencyMs: 42, ...result } as McpProbeResult, toolCatalog });
const appRows = async (serverId: string) => getDb().select().from(managedMcpServers).where(eq(managedMcpServers.serverId, serverId));

test("⭐ a recommended App takes its endpoint and sign-in from Raft, and the request cannot override them", async () => {
  const f = await seed();
  const create = (source: Record<string, unknown>, extra: Record<string, unknown> = {}) => createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: source as never, profile: { name: `Notion ${randomUUID().slice(0, 4)}` }, ...extra,
  });
  await assert.rejects(create({ kind: "template", templateKey: "notion", endpointUrl: "https://evil.example.test/mcp" }), { code: "managed_mcp_template_field_locked" });
  await assert.rejects(create({ kind: "template", templateKey: "notion" }, { authKind: "headers" }), { code: "managed_mcp_template_field_locked" });
  await assert.rejects(create({ kind: "template", templateKey: "no-such-app" }), { code: "managed_mcp_template_not_found" });
  assert.equal((await appRows(f.server.id)).length, 0);

  const view = await create({ kind: "template", templateKey: "notion" });
  assert.equal(view.server.endpointUrl, "https://mcp.notion.com/mcp");
  assert.equal(view.server.authKind, "oauth");
  assert.deepEqual(view.source, { kind: "template", templateKey: "notion", maintainedByRaft: true });
  assert.deepEqual(view.connections, [], "an App starts with no Connection");
  const [row] = await appRows(f.server.id);
  assert.equal(row.provider, "notion", "older binaries still recognise it");

  await assert.rejects(
    updateMcpApp({ serverId: f.server.id, userId: f.owner.id, appId: view.id, patch: { endpointUrl: "https://evil.example.test/mcp" } }),
    { code: "managed_mcp_template_field_locked" },
  );
});

test("⭐ a URL App is probed server-side: unreachable writes nothing, auth-less stores its catalogue", async () => {
  const f = await seed();
  const create = (probe: ReturnType<typeof probeAs>, extra: Record<string, unknown> = {}) => createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: ENDPOINT }, profile: { name: "Docs" }, ...extra,
  }, { probe });
  await assert.rejects(create(probeAs({ outcome: "unreachable", latencyMs: null, error: { code: "managed_mcp_unreachable", message: "down" } })), { code: "managed_mcp_unreachable" });
  await assert.rejects(create(probeAs({ outcome: "unreachable", latencyMs: null, error: { code: "managed_mcp_endpoint_blocked", message: "blocked" } })), { code: "managed_mcp_endpoint_blocked" });
  await assert.rejects(create(probeAs({ outcome: "oauth" }), { authKind: "none" }), { code: "managed_mcp_auth_invalid" },
    "an auth-less App must complete its handshake");
  assert.equal((await appRows(f.server.id)).length, 0, "⭐ nothing written for a failed handshake");

  const view = await create(probeAs(
    { outcome: "ready", serverInfo: { protocolVersion: "2025-06-18", name: "Stub" }, tools: { count: 1, names: ["search"] } },
    [{ name: "search", inputSchema: { type: "object" } }],
  ), { profile: { name: "Docs", category: "Developer Tools", whenToUse: "Look things up in the docs" } });
  assert.equal(view.server.authKind, "none");
  assert.deepEqual(view.server.tools, [{ name: "search" }]);
  assert.deepEqual(view.server.serverInfo, { protocolVersion: "2025-06-18", name: "Stub" });
  assert.equal(view.profile.category, "Developer Tools");
  assert.deepEqual(view.source, { kind: "url", templateKey: null, maintainedByRaft: false });

  const oauth = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: "https://other.example.test/mcp" }, profile: { name: "Signed" },
  }, { probe: probeAs({ outcome: "oauth", oauth: { issuer: "https://auth.example.test", registration: "dcr", scopes: [] } }) });
  assert.equal(oauth.server.authKind, "oauth");
  assert.deepEqual(oauth.server.authProbe, { issuer: "https://auth.example.test", registration: "dcr", scopes: [] });

  const keyed = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: "https://keyed.example.test/mcp" }, profile: { name: "Keyed" },
    requiredHeaderNames: ["X-Api-Key"],
  }, { probe: probeAs({ outcome: "headers", suggestedHeaderNames: ["Authorization"] }) });
  assert.deepEqual(keyed.server.requiredHeaderNames, ["X-Api-Key"]);
});

test("⭐ a server that offers OAuth but listed its tools without a token may be added either way; the save-time probe decides", async () => {
  const f = await seed();
  const create = (name: string, probe: ReturnType<typeof probeAs>, authKind?: "none" | "oauth") => createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: ENDPOINT }, profile: { name }, ...(authKind ? { authKind } : {}),
  }, { probe });
  const catalog = [{ name: "search", inputSchema: { type: "object" as const } }];
  const both = () => probeAs(
    { outcome: "oauth", oauth: { issuer: "https://accounts.example.test", registration: "manual_required", scopes: [] }, tools: { count: 1, names: ["search"] } },
    catalog,
  );
  const anonymous = await create("Anonymous", both(), "none");
  assert.equal(anonymous.server.authKind, "none", "the user chose to use it without signing in");
  assert.deepEqual(anonymous.server.tools, [{ name: "search" }]);
  const signedIn = await create("Signed", both());
  assert.equal(signedIn.server.authKind, "oauth", "sign-in is the default");

  // The page's choice is checked against the probe the save makes, not the page's own.
  await assert.rejects(create("Stale OAuth", probeAs({ outcome: "ready" }, catalog), "oauth"), { code: "managed_mcp_auth_invalid" },
    "OAuth chosen on the page, but the server no longer offers it");
  await assert.rejects(create("Stale anonymous", probeAs({ outcome: "oauth", oauth: { issuer: "https://accounts.example.test", registration: "dcr", scopes: [] } }), "none"),
    { code: "managed_mcp_auth_invalid" }, "no sign-in chosen on the page, but the server now refuses tokenless tool listing");
  assert.deepEqual((await appRows(f.server.id)).map((row) => row.name).sort(), ["Anonymous", "Signed"], "nothing saved for a stale choice");
});

test("⭐ PATCH refuses sections an MCP App does not have, by name", async () => {
  const f = await seed();
  const view = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: ENDPOINT }, profile: { name: "Docs" },
  }, { probe: probeAs({ outcome: "ready" }, [{ name: "search", inputSchema: { type: "object" } }]) });
  for (const patch of [{ returnUrl: "https://x.example.test" }, { allowedScopes: ["a"] }, { profile: { logoUrl: "https://x.example.test/l.png" } }]) {
    await assert.rejects(
      updateMcpApp({ serverId: f.server.id, userId: f.owner.id, appId: view.id, patch }),
      { code: "managed_mcp_app_section_not_supported" },
    );
  }
  const renamed = await updateMcpApp({ serverId: f.server.id, userId: f.owner.id, appId: view.id, patch: { profile: { name: "Docs 2" }, enabled: false } });
  assert.equal(renamed.profile.name, "Docs 2");
  assert.equal(renamed.server.enabled, false);
});

test("⭐ moving a URL App to another origin clears every Connection's secrets; same origin keeps API keys", async () => {
  const f = await seed();
  const view = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: ENDPOINT }, profile: { name: "Keyed" }, requiredHeaderNames: ["X-Api-Key"],
  }, { probe: probeAs({ outcome: "headers" }) });
  await getDb().insert(managedMcpCredentials).values({
    serverId: f.server.id, mcpServerId: view.id, isServerDefault: true, name: "Team", authKind: "headers", authStatus: "ready",
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "fixture-key" }), headerNames: ["X-Api-Key"],
  });
  const connection = async () => (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, view.id)))[0];
  const before = (await appRows(f.server.id))[0];

  await updateMcpApp({ serverId: f.server.id, userId: f.owner.id, appId: view.id, patch: { endpointUrl: "https://apps.example.test/v2/mcp" } });
  assert.ok((await connection()).encryptedHeaders !== null, "same origin: the key stays");
  assert.equal((await connection()).authStatus, "ready");

  await updateMcpApp({ serverId: f.server.id, userId: f.owner.id, appId: view.id, patch: { endpointUrl: "https://elsewhere.example.test/mcp" } });
  const moved = await connection();
  assert.ok(moved.encryptedHeaders === null, "⭐ a key is never sent to a host it was not entered for");
  assert.equal(moved.authStatus, "needs_auth");
  assert.deepEqual(moved.headerNames, ["X-Api-Key"], "the names stay, so the UI can ask for the values again");
  const after = (await appRows(f.server.id))[0];
  assert.equal(after.configVersion, before.configVersion + 2);
  assert.deepEqual(after.toolCatalog, []);
});

test("the App list says which MCP Apps are maintained by Raft, including rows older than MCP Apps", async () => {
  const f = await seed();
  await createMcpApp({ serverId: f.server.id, userId: f.owner.id, source: { kind: "template", templateKey: "linear" }, profile: { name: "Linear" } });
  await createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: ENDPOINT }, profile: { name: "Keyed" }, requiredHeaderNames: ["X-Api-Key"],
  }, { probe: probeAs({ outcome: "headers" }) });
  // A hand-added Notion row from before MCP Apps: no source_kind, provider names the template.
  await getDb().insert(managedMcpServers).values({
    serverId: f.server.id, name: "Old Notion", provider: "notion", endpointUrl: "https://mcp.notion.com/mcp", authMode: "oauth", createdByUserId: f.owner.id,
  });
  const sources = Object.fromEntries((await listMcpApps(f.server.id)).map((app) => [app.name, app.source]));
  assert.deepEqual(sources, {
    Keyed: { kind: "url", templateKey: null, maintainedByRaft: false },
    Linear: { kind: "template", templateKey: "linear", maintainedByRaft: true },
    "Old Notion": { kind: "template", templateKey: "notion", maintainedByRaft: true },
  });
});

test("the App view shows Connections only to people who manage integrations", async () => {
  const f = await seed();
  const view = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: ENDPOINT }, profile: { name: "Keyed" }, requiredHeaderNames: ["X-Api-Key"],
  }, { probe: probeAs({ outcome: "headers" }) });
  await getDb().insert(managedMcpCredentials).values({
    serverId: f.server.id, mcpServerId: view.id, isServerDefault: true, name: "Team", authKind: "headers", authStatus: "ready",
    encryptedHeaders: encryptManagedMcpHeaders({ "X-Api-Key": "fixture-key" }), headerNames: ["X-Api-Key"],
  });
  const asOwner = await getMcpAppView(f.server.id, view.id, f.owner.id);
  const asMember = await getMcpAppView(f.server.id, view.id, f.member.id);
  assert.equal(asOwner.connections.length, 1);
  assert.equal(asOwner.viewer.canManage, true);
  assert.deepEqual(asMember.connections, []);
  assert.ok(asMember.defaultConnectionId === null);
  assert.equal(JSON.stringify(asMember).includes(asOwner.connections[0].id), false);
  assert.equal(JSON.stringify(asOwner).includes("fixture-key"), false);
});

test("⭐ recommended Apps are server data: validated, and the legacy recommendations come from them", async () => {
  const keys = (await listMcpAppTemplates()).map((template) => template.key);
  assert.deepEqual(keys, [
    "notion", "linear", "atlassian", "figma", "gmail", "drive", "calendar", "sentry", "airtable",
    "monday", "asana", "hubspot", "stripe", "supabase", "sheets", "docs", "slides", "workiq", "canva",
  ]);
  const valid = { key: "x", name: "X", description: "d", homepageUrl: "https://x.example.test", logoUrl: null, category: "Other", endpointUrl: "https://x.example.test/mcp", authKind: "oauth" };
  assert.throws(() => parseMcpAppTemplates({ templates: [{ ...valid, endpointUrl: "http://x.example.test/mcp" }] }), "https only");
  assert.throws(() => parseMcpAppTemplates({ templates: [valid, valid] }), "unique keys");
  assert.throws(() => parseMcpAppTemplates({ templates: [{ ...valid, category: "Gadgets" }] }), "known categories");
  assert.throws(() => parseMcpAppTemplates({ templates: [{ ...valid, surprise: true }] }), "no unknown fields");
  const f = await seed();
  const legacy = await listManagedMcpServerCatalog(f.server.id);
  // The legacy provider union supports only Notion and Linear, even as App templates expand.
  assert.deepEqual(legacy.recommendations.map((item) => [item.id, item.endpointUrl]), [
    ["notion", "https://mcp.notion.com/mcp"],
    ["linear", "https://mcp.linear.app/mcp"],
  ]);
});

test("the catalog hides unusable endpoints without losing existing App metadata or query compatibility", async () => {
  const f = await seed();
  const existing = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id,
    source: { kind: "template", templateKey: "notion" }, profile: { name: "Existing" },
  });
  const badEndpoint = "https://fixture-user:fixture-password@mcp.example.test/mcp";
  const badFragment = "https://mcp.example.test/mcp#fixture-fragment";
  const logo = "https://assets.example.test/logo.png";
  await getDb().update(mcpAppTemplates).set({
    endpointUrl: badEndpoint, logoUrl: logo, oauthClientMode: "registered",
  }).where(eq(mcpAppTemplates.key, "notion"));
  await getDb().update(mcpAppTemplates).set({ endpointUrl: badFragment }).where(eq(mcpAppTemplates.key, "atlassian"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const catalog = await listMcpAppTemplates();
    assert.equal(catalog.some((template) => template.key === "notion"), false);
    assert.equal(catalog.some((template) => template.key === "atlassian"), false);
    assert.equal(catalog.some((template) => template.key === "linear"), true, "one bad row does not hide the catalog");
    await listMcpAppTemplates();
    assert.equal(logged.mock.calls.filter(([message]) => String(message).includes("notion")).length, 1, "the same invalid row is not logged on every request");
    assert.equal(await findActiveMcpAppTemplate("notion"), null);
    const before = await appRows(f.server.id);
    await assert.rejects(createMcpApp({
      serverId: f.server.id, userId: f.owner.id,
      source: { kind: "template", templateKey: "notion" }, profile: { name: "Not created" },
    }), { code: "managed_mcp_template_not_found" });
    assert.equal((await appRows(f.server.id)).length, before.length, "refusal leaves no new App");
    assert.equal((await getMcpAppView(f.server.id, existing.id, f.owner.id)).server.oauthClientMode, "registered");
    assert.equal((await clearMcpAppLogo({ serverId: f.server.id, appId: existing.id, userId: f.owner.id })).profile.logoUrl, logo);
    const messages = logged.mock.calls.flat().map(String).join(" ");
    assert.match(messages, /notion/u);
    assert.equal(messages.includes(badEndpoint), false, "logs do not contain the endpoint");
    assert.equal(messages.includes(badFragment), false, "logs do not contain fragments");

    const bundledBase = { name: "Fixture", description: "Test", homepageUrl: "https://example.test", logoUrl: null, category: "Other", authKind: "oauth" };
    const bundled = parseMcpAppTemplates({ templates: [
      { ...bundledBase, key: "safe", endpointUrl: "https://mcp.example.test/mcp?region=example" },
      { ...bundledBase, key: "user", endpointUrl: "https://fixture-user@mcp.example.test/mcp" },
      { ...bundledBase, key: "password", endpointUrl: "https://:fixture-password@mcp.example.test/mcp" },
      { ...bundledBase, key: "fragment", endpointUrl: badFragment },
    ] });
    assert.deepEqual(bundled.map((template) => template.key), ["safe"], "the bundled fallback keeps queries and skips invalid endpoints");

    const endpointWithQuery = "https://mcp.example.test/mcp?region=example";
    await getDb().update(mcpAppTemplates).set({ endpointUrl: endpointWithQuery }).where(eq(mcpAppTemplates.key, "notion"));
    assert.equal((await findActiveMcpAppTemplate("notion"))?.endpointUrl, endpointWithQuery);
    await getDb().update(mcpAppTemplates).set({ endpointUrl: badEndpoint }).where(eq(mcpAppTemplates.key, "notion"));
    await listMcpAppTemplates();
    assert.equal(logged.mock.calls.filter(([message]) => String(message).includes("notion")).length, 2, "a new invalid state after a fix is reported again");
    await getDb().update(mcpAppTemplates).set({ endpointUrl: endpointWithQuery }).where(eq(mcpAppTemplates.key, "notion"));
    const created = await createMcpApp({
      serverId: f.server.id, userId: f.owner.id,
      source: { kind: "template", templateKey: "notion" }, profile: { name: "Query template" },
    });
    const [stored] = await getDb().select({ endpointUrl: managedMcpServers.endpointUrl })
      .from(managedMcpServers).where(eq(managedMcpServers.id, created.id));
    assert.equal(stored.endpointUrl, endpointWithQuery, "a non-secret provider query remains in the connection target");
    assert.equal(created.server.endpointUrl, "https://mcp.example.test/mcp", "the App view still hides the query");
  } finally {
    logged.mockRestore();
  }
});

test("an unavailable catalog uses a filtered bundled fallback without exposing invalid addresses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raft-mcp-fallback-"));
  const previous = process.env.MCP_APP_TEMPLATES_PATH;
  const base = { name: "Fixture", description: "Test", homepageUrl: "https://example.test", logoUrl: null, category: "Other", authKind: "oauth" };
  const badEndpoint = "https://fixture-user@mcp.example.test/mcp";
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const path = join(directory, "templates.json");
    writeFileSync(path, JSON.stringify({ templates: [
      { ...base, key: "safe", endpointUrl: "https://mcp.example.test/mcp?region=example" },
      { ...base, key: "bad", endpointUrl: badEndpoint },
      { ...base, key: "retired", endpointUrl: "https://mcp.example.test/mcp", status: "retired" },
    ] }));
    process.env.MCP_APP_TEMPLATES_PATH = path;
    __resetMcpAppTemplatesForTests();
    await getDb().execute(sql.raw("DROP TABLE mcp_app_templates CASCADE"));
    assert.deepEqual((await listMcpAppTemplates()).map((template) => template.key), ["safe"]);
    assert.equal(await findActiveMcpAppTemplate("bad"), null);
    assert.equal(await findMcpAppTemplateRow("safe"), "unavailable", "client mode must not fall back to a bundled default");
    const messages = logged.mock.calls.flat().map(String).join(" ");
    assert.match(messages, /bad/u);
    assert.equal(messages.includes(badEndpoint), false);
  } finally {
    if (previous === undefined) delete process.env.MCP_APP_TEMPLATES_PATH;
    else process.env.MCP_APP_TEMPLATES_PATH = previous;
    __resetMcpAppTemplatesForTests();
    logged.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy App views hide URL credentials and preserve the stored endpoint on profile edits", async () => {
  const f = await seed();
  const created = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id,
    source: { kind: "template", templateKey: "linear" }, profile: { name: "Existing" },
  });
  const legacyEndpoint = "https://fixture-user:fixture-password@mcp.example.test/mcp?region=example#fixture-fragment";
  await getDb().update(managedMcpServers).set({ endpointUrl: legacyEndpoint }).where(eq(managedMcpServers.id, created.id));
  assert.equal((await getMcpAppView(f.server.id, created.id, f.owner.id)).server.endpointUrl, "https://mcp.example.test/mcp");
  assert.equal((await listManagedMcpServerCatalog(f.server.id)).servers.find((app) => app.id === created.id)?.endpointUrl, "https://mcp.example.test/mcp");
  await updateMcpApp({ serverId: f.server.id, userId: f.owner.id, appId: created.id, patch: { profile: { description: "Updated" } } });
  const [stored] = await getDb().select({ endpointUrl: managedMcpServers.endpointUrl })
    .from(managedMcpServers).where(eq(managedMcpServers.id, created.id));
  assert.equal(stored.endpointUrl, legacyEndpoint, "profile edits do not rewrite the connection target");

  await getDb().update(managedMcpServers).set({ endpointUrl: "not a URL" }).where(eq(managedMcpServers.id, created.id));
  assert.equal((await getMcpAppView(f.server.id, created.id, f.owner.id)).server.endpointUrl, "");
  assert.equal((await listManagedMcpServerCatalog(f.server.id)).servers.find((app) => app.id === created.id)?.endpointUrl, "");
  await getDb().update(managedMcpServers).set({ endpointUrl: "data:text/plain,fixture-value" }).where(eq(managedMcpServers.id, created.id));
  assert.equal((await getMcpAppView(f.server.id, created.id, f.owner.id)).server.endpointUrl, "");
});

test("App creation rechecks a selected template before writing", async () => {
  const f = await seed();
  const template = await findActiveMcpAppTemplate("notion");
  assert.ok(template);
  const lookup = vi.spyOn(mcpTemplateCatalog, "findActiveMcpAppTemplate").mockResolvedValueOnce({
    ...template, endpointUrl: "https://fixture-user@mcp.example.test/mcp",
  });
  try {
    await assert.rejects(createMcpApp({
      serverId: f.server.id, userId: f.owner.id,
      source: { kind: "template", templateKey: "notion" }, profile: { name: "Not created" },
    }), { code: "managed_mcp_endpoint_invalid" });
    assert.equal((await appRows(f.server.id)).length, 0);
  } finally {
    lookup.mockRestore();
  }
});

test("⭐ a retired template cannot mint a new App but still resolves for an existing one", async () => {
  const f = await seed();
  const activeKeys = (await listMcpAppTemplates()).map((t) => t.key);
  // An App created while the template is still active …
  const existing = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id,
    source: { kind: "template", templateKey: "notion" }, profile: { name: "Notion" },
  });
  // … then an admin retires the template …
  await getDb().update(mcpAppTemplates).set({ status: "retired" }).where(eq(mcpAppTemplates.key, "notion"));
  // … which stops it from minting new Apps or appearing in the catalog …
  await assert.rejects(
    createMcpApp({
      serverId: f.server.id, userId: f.owner.id,
      source: { kind: "template", templateKey: "notion" }, profile: { name: "Notion 2" },
    }),
    { code: "managed_mcp_template_not_found" },
  );
  assert.equal(await findActiveMcpAppTemplate("notion"), null, "retired rows cannot mint");
  assert.deepEqual((await listMcpAppTemplates()).map((t) => t.key), activeKeys.filter((key) => key !== "notion"), "list only serves active rows");
  // … but the existing App still resolves its template (templateKey → logo/maintainedByRaft).
  assert.equal((await findMcpAppTemplate("notion"))?.key, "notion", "retired rows still resolve");
  assert.equal(existing.source.kind, "template");
  const view = await getMcpAppView(f.server.id, existing.id, f.owner.id);
  assert.equal(view.source.kind === "template" ? view.source.templateKey : null, "notion");
  // The legacy managed-provider creation path is refused the same way (not silently treated as
  // "no fixed endpoint"), while existing Apps of that provider are untouched.
  await assert.rejects(
    createManagedMcpServer({ serverId: f.server.id, userId: f.owner.id, name: "Notion 3", provider: "notion", endpointUrl: "https://mcp.notion.com/mcp", authMode: "oauth" }),
    { code: "managed_mcp_template_not_found" },
  );
});

test("⭐ an App name taken by a concurrent write is a 409, not a 500 (the unique index answers)", async () => {
  const f = await seed();
  await createManagedMcpServer({ serverId: f.server.id, userId: f.owner.id, name: "Docs", endpointUrl: ENDPOINT });
  const other = await createManagedMcpServer({ serverId: f.server.id, userId: f.owner.id, name: "Other", endpointUrl: "https://other.example.test/mcp" });
  // The original routes write without a pre-check, exactly like the loser of a race past one.
  await assert.rejects(
    createManagedMcpServer({ serverId: f.server.id, userId: f.owner.id, name: "Docs", endpointUrl: "https://third.example.test/mcp" }),
    { code: "managed_mcp_app_name_taken" },
  );
  await assert.rejects(
    updateManagedMcpServer({ serverId: f.server.id, userId: f.owner.id, mcpServerId: other.id, name: "Docs" }),
    { code: "managed_mcp_app_name_taken" },
  );
  assert.throws(() => rethrowIfMcpAppNameTaken(new Error("boom")), /boom/, "any other error passes through");
});

test("⭐ moving an App clears the old server's sign-in probe and server info", async () => {
  const f = await seed();
  const view = await createMcpApp({
    serverId: f.server.id, userId: f.owner.id, source: { kind: "url", endpointUrl: ENDPOINT }, profile: { name: "Signed" },
  }, { probe: probeAs({ outcome: "oauth", oauth: { issuer: "https://auth.example.test", registration: "dcr", scopes: ["read"] }, serverInfo: { protocolVersion: "2025-06-18" } }) });
  assert.ok(view.server.authProbe !== null);
  const moved = await updateMcpApp({ serverId: f.server.id, userId: f.owner.id, appId: view.id, patch: { endpointUrl: "https://elsewhere.example.test/mcp" } });
  assert.ok(moved.server.authProbe === null, "⭐ the old server's issuer is not shown for the new one");
  assert.ok(moved.server.serverInfo === null);
});

test("fresh migrated catalog matches the bundled fallback, including the Supabase MCP resource", async () => {
  const bundled = parseMcpAppTemplates(JSON.parse(readFileSync(new URL("../config/mcpAppTemplates.json", import.meta.url), "utf8")))
    .map(({ maintainedByRaft: _maintainedByRaft, ...template }) => template)
    .sort((a, b) => a.key.localeCompare(b.key));
  // Read real migrated rows directly: a DB-read failure must not silently test the JSON fallback against itself.
  const migrated = await getDb().select({
    key: mcpAppTemplates.key,
    name: mcpAppTemplates.name,
    description: mcpAppTemplates.description,
    homepageUrl: mcpAppTemplates.homepageUrl,
    logoUrl: mcpAppTemplates.logoUrl,
    category: mcpAppTemplates.category,
    endpointUrl: mcpAppTemplates.endpointUrl,
    authKind: mcpAppTemplates.authKind,
    oauthClientMode: mcpAppTemplates.oauthClientMode,
  }).from(mcpAppTemplates);
  assert.deepEqual(migrated.sort((a, b) => a.key.localeCompare(b.key)), bundled);
  // The marketing URL redirects to documentation; redirect-refusing MCP clients need this resource URL.
  assert.equal(migrated.find(({ key }) => key === "supabase")?.endpointUrl, "https://mcp.supabase.com/mcp");
});

test("catalog expansion preserves administrator edits and retirement when replayed", async () => {
  const [edited] = await getDb().update(mcpAppTemplates).set({
    name: "Company Asana", endpointUrl: "https://custom.example.test/mcp", logoUrl: "https://custom.example.test/asana.svg", status: "retired", revision: 3,
  }).where(eq(mcpAppTemplates.key, "asana")).returning();
  assert.ok(edited);
  await getDb().delete(mcpAppTemplates).where(eq(mcpAppTemplates.key, "figma"));
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string }> };
  const entry = journal.entries.find(({ tag }) => tag.endsWith("_mcp_template_catalog_expansion"));
  assert.ok(entry);
  const expansion = readFileSync(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), "utf8");
  await getDb().execute(sql.raw(expansion));
  await getDb().execute(sql.raw(expansion));
  const [preserved] = await getDb().select().from(mcpAppTemplates).where(eq(mcpAppTemplates.key, "asana"));
  assert.deepEqual(preserved, edited, "no admin-owned field, id, or timestamp is overwritten");
  const all = await getDb().select().from(mcpAppTemplates);
  assert.equal(all.length, 19, "replay adds missing rows without duplicates");
  assert.equal(all.filter((row) => row.key === "figma").length, 1);
  assert.equal((await listMcpAppTemplates()).some((template) => template.key === "asana"), false, "retired rows stay hidden");
});
