import assert from "node:assert/strict";
import type { McpAppListItem } from "@botiverse/raft-shared";
import { DEFAULT_APPS_FILTERS, hasActiveAppsFilters } from "../src/components/apps/appsFilters";
import { appsScopeFromTab } from "../src/features/apps/appsScope";
import type { AppViewContext } from "../src/features/apps/appView";
import type { InstalledConnectedApp, ServerRegisteredApp } from "../src/features/apps/connected-apps/connectedAppTypes";
import type { MarketplaceOAuthClientRecord, OAuthClientRecord } from "../src/features/apps/connected-apps/oauthClientRecords";
import { appMakerNames, buildYoursApps, filterYoursApps } from "../src/features/apps/yoursApps";
import type { YoursAppsSources, YoursServiceRow } from "../src/features/apps/yoursApps";

// Yours (features/apps/yoursApps.ts): today's Installed and Developer lists as
// one list of App views, and the scope's name mapping and filter.
const HERE = "server-here";
const manager: AppViewContext = { serverId: HERE, canManage: true, promptTextConsent: true };

const client = (id: string, over: Partial<OAuthClientRecord> = {}): OAuthClientRecord => ({
  id,
  serverId: HERE,
  clientId: `${id}-key`,
  appType: "server_local",
  publishStatus: "private",
  category: "Other",
  name: id,
  description: null,
  homepageUrl: null,
  allowedScopes: [],
  logoUrl: null,
  createdByUserId: "user-1",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
}) as OAuthClientRecord;

const marketplace = (id: string, over: Partial<MarketplaceOAuthClientRecord> = {}): MarketplaceOAuthClientRecord => ({
  ...client(id, { serverId: "server-elsewhere", appType: "third_party_global", publishStatus: "published" }),
  official: false,
  installationId: `${id}-install`,
  installedAt: "2026-11-01T00:00:00.000Z",
  marketplaceInstallBadge: { kind: "none" },
  publisherName: "Alice",
  publisherServerName: "Acme",
  privateShared: false,
  ...over,
}) as MarketplaceOAuthClientRecord;

// Today's installed-app entry, as IntegrationsSection builds it.
const entry = (id: string, over: Partial<InstalledConnectedApp> = {}): InstalledConnectedApp => ({
  id,
  clientId: `${id}-key`,
  name: id,
  developer: "Acme",
  description: null,
  homepageUrl: null,
  homepageDomain: null,
  callbackDomain: null,
  logoUrl: null,
  defaultLogoSeed: `${id}-key`,
  origin: "marketplace",
  privateShared: false,
  editable: false,
  official: false,
  allowedScopes: [],
  grantedScopes: [],
  category: "Other",
  publishStatus: "published",
  ...over,
});

const registered = (record: OAuthClientRecord): ServerRegisteredApp => ({ ...record, status: record.publishStatus, defaultLogoSeed: record.clientId });

const service = (id: string, source: McpAppListItem["source"], status: Partial<McpAppListItem["status"]> = {}): McpAppListItem => ({
  kind: "mcp",
  id,
  name: id,
  description: null,
  logoUrl: null,
  homepageUrl: null,
  category: null,
  distribution: "server_local",
  source,
  status: { health: "reachable", toolCount: 0, connectionCount: 0, actionNeeded: 0, ...status },
}) as McpAppListItem;

const serviceRow = (item: McpAppListItem): YoursServiceRow => ({
  ...entry(item.id, { editable: true, origin: "private", publishStatus: "private", developer: "Custom" }),
  status: "private",
});

function sources(over: Partial<YoursAppsSources> = {}): YoursAppsSources {
  return { installedApps: [], appEntries: [], serviceItems: [], serviceRow, registeredApps: [], clients: [], marketplaceClients: [], context: manager, ...over };
}

test("an old tab name opens the scope that holds its list now", () => {
  assert.equal(appsScopeFromTab("installed"), "yours");
  assert.equal(appsScopeFromTab("myapps"), "yours");
  assert.equal(appsScopeFromTab("marketplace"), "discover");
  assert.equal(appsScopeFromTab("yours"), "yours");
  assert.equal(appsScopeFromTab("discover"), "discover");
  assert.equal(appsScopeFromTab(" Marketplace "), "discover");
});

test("an unknown, empty or missing tab name names no scope", () => {
  for (const value of ["developer", "constructor", "__proto__", "", null, undefined]) {
    assert.equal(appsScopeFromTab(value), null, String(value));
  }
});

test("a scope counts only its own filters as narrowing its list", () => {
  assert.equal(hasActiveAppsFilters(DEFAULT_APPS_FILTERS, "yours"), false);
  assert.equal(hasActiveAppsFilters(DEFAULT_APPS_FILTERS, "discover"), false);
  assert.equal(hasActiveAppsFilters({ ...DEFAULT_APPS_FILTERS, search: " notion " }, "yours"), true);
  assert.equal(hasActiveAppsFilters({ ...DEFAULT_APPS_FILTERS, search: "notion" }, "discover"), true);
  assert.equal(hasActiveAppsFilters({ ...DEFAULT_APPS_FILTERS, origin: "internal" }, "yours"), true);
  assert.equal(hasActiveAppsFilters({ ...DEFAULT_APPS_FILTERS, origin: "internal" }, "discover"), false);
  assert.equal(hasActiveAppsFilters({ ...DEFAULT_APPS_FILTERS, category: "Other" }, "discover"), true);
  assert.equal(hasActiveAppsFilters({ ...DEFAULT_APPS_FILTERS, category: "Other" }, "yours"), false);
});

// One of each: another Server's App, a private share, an App built here and
// installed, one built here and not installed, a listed service and one
// connected by its URL.
function mixed(context: AppViewContext = manager) {
  const tracker = marketplace("tracker");
  const ledger = marketplace("ledger", { privateShared: true, publishStatus: "private" });
  const ownInstalled = client("own-installed", { installationId: "own-install" });
  const ownDraft = client("own-draft");
  return buildYoursApps(sources({
    installedApps: [
      entry("tracker"),
      entry("ledger", { privateShared: true }),
      entry("own-installed", { editable: true, origin: "private", developer: "This server", installedHere: true, sourceClientId: "own-installed" }),
    ],
    appEntries: [
      entry("tracker"),
      entry("ledger", { privateShared: true }),
      entry("own-installed", { editable: true, origin: "private", developer: "This server", installedHere: true }),
      entry("own-draft", { editable: true, origin: "private", developer: "This server" }),
    ],
    serviceItems: [
      service("notion", { kind: "template", templateKey: "notion", maintainedByRaft: true }),
      service("wiki", { kind: "url", templateKey: null, maintainedByRaft: false }),
    ],
    registeredApps: [registered(ownInstalled), registered(ownDraft)],
    clients: [ownInstalled, ownDraft],
    marketplaceClients: [tracker, ledger],
    context,
  }));
}

test("Yours lists every App once: today's Installed list, the services, then the Apps built here that aren't installed", () => {
  const apps = mixed();
  assert.deepEqual(apps.map((app) => [app.kind, app.app.id]), [
    ["installed", "tracker"],
    ["installed", "ledger"],
    ["installed", "own-installed"],
    ["service", "notion"],
    ["service", "wiki"],
    ["built", "own-draft"],
  ]);
  assert.deepEqual(apps.map((app) => app.view.origin), ["marketplace", "shared", "internal", "marketplace", "internal", "internal"]);
  assert.equal(new Set(apps.map((app) => app.key)).size, apps.length);
});

test("the origin filter keeps the Apps from that origin, in their order", () => {
  const apps = mixed();
  const ids = (origin: Parameters<typeof filterYoursApps>[2], search = "") => filterYoursApps(apps, search, origin).map((app) => app.app.id);
  assert.deepEqual(ids("all"), ["tracker", "ledger", "own-installed", "notion", "wiki", "own-draft"]);
  assert.deepEqual(ids("internal"), ["own-installed", "wiki", "own-draft"]);
  assert.deepEqual(ids("shared"), ["ledger"]);
  assert.deepEqual(ids("marketplace"), ["tracker", "notion"]);
  // With the search: name, description, maker and client id, as today's lists.
  assert.deepEqual(ids("internal", " OWN "), ["own-installed", "own-draft"]);
  assert.deepEqual(ids("all", "acme"), ["tracker", "ledger"]);
  assert.deepEqual(ids("all", "tracker-key"), ["tracker"]);
  assert.deepEqual(ids("shared", "tracker"), []);
});

test("an App that needs someone comes first; the others keep today's order", () => {
  const tracker = marketplace("tracker");
  const figma = marketplace("figma", { permissionApprovalRequired: true });
  const apps = buildYoursApps(sources({
    installedApps: [entry("tracker"), entry("figma", { permissionApprovalRequired: true })],
    appEntries: [entry("tracker"), entry("figma", { permissionApprovalRequired: true })],
    serviceItems: [
      service("wiki", { kind: "url", templateKey: null, maintainedByRaft: false }),
      service("notion", { kind: "template", templateKey: "notion", maintainedByRaft: true }, { defaultConnectionStatus: "expired" }),
    ],
    marketplaceClients: [tracker, figma],
  }));
  assert.deepEqual(apps.map((app) => [app.app.id, app.view.state]), [
    ["figma", "updateNeedsApproval"],
    ["notion", "signInExpired"],
    ["tracker", "normal"],
    ["wiki", "normal"],
  ]);
});

test("a member's list carries no connection state of a connected service, whatever the read sent", () => {
  const serviceItems = [
    service("wiki", { kind: "url", templateKey: null, maintainedByRaft: false }),
    service("notion", { kind: "template", templateKey: "notion", maintainedByRaft: true }, { defaultConnectionStatus: "expired" }),
    service("linear", { kind: "template", templateKey: "linear", maintainedByRaft: true }, { defaultConnectionStatus: "error" }),
  ];
  const asManager = buildYoursApps(sources({ serviceItems }));
  assert.deepEqual(asManager.map((app) => [app.app.id, app.view.state]), [["notion", "signInExpired"], ["linear", "cannotConnect"], ["wiki", "normal"]]);
  const asMember = buildYoursApps(sources({ serviceItems, context: { ...manager, canManage: false } }));
  // Normal, and in the read's order: nothing is sorted first for a member.
  assert.deepEqual(asMember.map((app) => [app.app.id, app.view.state, app.view.needsAttention]), [["wiki", "normal", false], ["notion", "normal", false], ["linear", "normal", false]]);
});

test("an App's maker is named as the Server's people name them; someone who left has no name", () => {
  const names = appMakerNames([
    { userId: "user-1", name: "olivia", displayName: "Olivia Owner" },
    { userId: "user-2", name: "sam", displayName: null },
    { userId: "user-3", name: "kim", displayName: "" },
  ]);
  assert.equal(names.get("user-1"), "Olivia Owner");
  assert.equal(names.get("user-2"), "sam");
  assert.equal(names.get("user-3"), "kim");
  assert.equal(names.get("user-gone"), undefined);
});

test("an App built here keeps the review state today's list merges from other reads", () => {
  const own = client("own", { installationId: "own-install" });
  const draft = client("draft");
  const build = (context: AppViewContext) => buildYoursApps(sources({
    // The clients row says nothing; the permission flag comes from the
    // marketplace row and the text flag from the App's prompt-text state.
    installedApps: [entry("own", { editable: true, origin: "private", installedHere: true, permissionApprovalRequired: true })],
    appEntries: [
      entry("own", { editable: true, origin: "private", installedHere: true, permissionApprovalRequired: true }),
      entry("draft", { editable: true, origin: "private", promptTextConfirmationRequired: true }),
    ],
    registeredApps: [registered(own), registered(draft)],
    clients: [own, draft],
    context,
  }));
  assert.deepEqual(build(manager).map((app) => [app.kind, app.app.id, app.view.state, app.view.origin]), [
    ["installed", "own", "updateNeedsApproval", "internal"],
    ["built", "draft", "updateNeedsApproval", "internal"],
  ]);
  // A member is shown no review state, as the mapper has it.
  assert.deepEqual(build({ ...manager, canManage: false }).map((app) => app.view.state), ["normal", "normal"]);
});

test("an installed entry whose record is in neither read is still listed", () => {
  const apps = buildYoursApps(sources({ installedApps: [entry("orphan", { privateShared: true, needsAdminReview: true })] }));
  assert.equal(apps.length, 1);
  assert.equal(apps[0]!.view.name, "orphan");
  assert.equal(apps[0]!.view.origin, "shared");
  assert.equal(apps[0]!.view.state, "updateNeedsApproval");
});
