import assert from "node:assert/strict";
import { renderThirdPartyInertText } from "@botiverse/raft-shared";
import type { MarketplaceListing, MarketplaceListingId, McpAppListItem } from "@botiverse/raft-shared";
import type { McpAppView } from "../src/components/settings/mcpApps/mcpAppApi";
import {
  APP_CARD_STATE_PRECEDENCE,
  appToolGroup,
  compareAppViews,
  connectedServiceDetailView,
  connectedServiceView,
  listingView,
  raftAppDetailView,
  raftAppView,
  sortAppViews,
  strongestAppCardState,
} from "../src/features/apps/appView";
import type { AppView, AppViewContext } from "../src/features/apps/appView";
import type { MarketplaceOAuthClientRecord, OAuthClientRecord } from "../src/features/apps/connected-apps/oauthClientRecords";

// The App view model (features/apps/appView.ts): one shape for a card and a
// detail, mapped from the records the web already loads.
const HERE = "server-here";
const manager: AppViewContext = { serverId: HERE, canManage: true, promptTextConsent: true };
const member: AppViewContext = { ...manager, canManage: false };

// Another Server's published Raft App, installed here (GET /integrations/marketplace).
const installed = (over: Partial<MarketplaceOAuthClientRecord> = {}): MarketplaceOAuthClientRecord => ({
  id: "app-1",
  serverId: "server-elsewhere",
  clientId: "client-1",
  appType: "third_party_global",
  publishStatus: "published",
  category: "Other",
  name: "Tracker",
  description: "Tracks things.",
  homepageUrl: "https://tracker.example",
  allowedScopes: ["profile:read"],
  logoUrl: "https://tracker.example/logo.png",
  official: false,
  installationId: "install-1",
  installedAt: "2026-11-01T08:00:00.000Z",
  marketplaceInstallBadge: { kind: "none" },
  publisherName: "Alice",
  publisherServerName: "Acme",
  privateShared: false,
  createdByUserId: "user-elsewhere",
  updatedAt: "2026-11-02T08:00:00.000Z",
  ...over,
}) as MarketplaceOAuthClientRecord;

// An App built on this Server (GET /integrations/clients).
const builtHere = (over: Partial<OAuthClientRecord> = {}): OAuthClientRecord => ({
  id: "app-own",
  serverId: HERE,
  clientId: "client-own",
  appType: "server_local",
  publishStatus: "private",
  category: "Other",
  name: "Our tool",
  description: null,
  homepageUrl: null,
  allowedScopes: null,
  logoUrl: null,
  createdByUserId: "user-alice",
  updatedAt: "2026-11-03T08:00:00.000Z",
  ...over,
}) as OAuthClientRecord;

const service = (over: Partial<McpAppListItem> = {}): McpAppListItem => ({
  kind: "mcp",
  id: "svc-1",
  name: "Notion",
  description: "Pages and databases.",
  logoUrl: null,
  homepageUrl: "https://notion.so",
  category: "Productivity",
  distribution: "server_local",
  source: { kind: "template", templateKey: "notion", maintainedByRaft: true },
  status: { health: "reachable", toolCount: 12, connectionCount: 1, actionNeeded: 0 },
  ...over,
});
const urlService = service({ id: "svc-2", name: "Our wiki", source: { kind: "url", templateKey: null, maintainedByRaft: false } });

type Listing = MarketplaceListing<MarketplaceOAuthClientRecord>;
const listingBase = {
  description: "From the listing.",
  logoUrl: null,
  category: "Other" as const,
  installBucket: null,
  publishedAt: null,
  installed: false,
};
const appListing = (over: Partial<Listing> = {}, app = installed({ installedAt: null, installationId: null })): Listing =>
  ({ ...listingBase, id: "listing-app" as MarketplaceListingId, kind: "app", name: app.name, publisherName: "Acme", app, ...over }) as Listing;
const serviceListing = (over: Partial<Listing> = {}): Listing =>
  ({ ...listingBase, id: "listing-linear" as MarketplaceListingId, kind: "mcp", name: "Linear", templateKey: "linear", homepageUrl: "https://linear.app", ...over }) as Listing;

test("official is a Raft App's own field", () => {
  assert.equal(raftAppView(installed({ official: true }), manager).official, true);
  assert.equal(raftAppView(installed({ official: false }), manager).official, false);
  // GET /integrations/clients may leave it out.
  assert.equal(raftAppView(builtHere(), manager).official, false);
  assert.equal(raftAppView(builtHere({ official: true }), manager).official, true);
  assert.equal(listingView(appListing({}, installed({ official: true })), manager).official, true);
});

test("a connected service is never official, also one Raft lists", () => {
  assert.equal(connectedServiceView(service(), manager).official, false);
  assert.equal(connectedServiceView(urlService, manager).official, false);
  assert.equal(listingView(serviceListing(), manager).official, false);
});

test("source line of a Raft App from elsewhere: its publisher, the server's name first", () => {
  const view = raftAppView(installed(), manager);
  assert.equal(view.publisherName, "Acme");
  assert.equal(view.listedByRaft, false);
  assert.equal(view.createdByUserId, null);
  assert.equal(raftAppView(installed({ publisherServerName: null }), manager).publisherName, "Alice");
  assert.equal(raftAppView(installed({ publisherServerName: null, publisherName: null }), manager).publisherName, null);
});

test("source line of a connected service: no publisher; listed by Raft when Raft maintains it", () => {
  const listed = connectedServiceView(service(), manager);
  assert.equal(listed.publisherName, null);
  assert.equal(listed.listedByRaft, true);
  assert.equal(listed.createdByUserId, null);
  const byUrl = connectedServiceView(urlService, manager);
  assert.equal(byUrl.publisherName, null);
  assert.equal(byUrl.listedByRaft, false);
});

test("source line of an App built here: internal, with its creator's id and no publisher", () => {
  const view = raftAppView(builtHere(), manager);
  assert.equal(view.origin, "internal");
  assert.equal(view.createdByUserId, "user-alice");
  assert.equal(view.publisherName, null);
  // The same App seen through the marketplace list (installed here).
  const viaMarketplace = raftAppView(installed({ serverId: HERE, createdByUserId: "user-alice" }), manager);
  assert.equal(viaMarketplace.origin, "internal");
  assert.equal(viaMarketplace.createdByUserId, "user-alice");
  assert.equal(viaMarketplace.publisherName, null);
});

test("origin of a Raft App", () => {
  assert.equal(raftAppView(installed(), manager).origin, "marketplace");
  assert.equal(raftAppView(installed({ privateShared: true }), manager).origin, "shared");
  // Another Server's server-local App reaches this one only as a private share.
  assert.equal(raftAppView(installed({ appType: "server_local", privateShared: true }), manager).origin, "shared");
  assert.equal(raftAppView(builtHere(), manager).origin, "internal");
  // Built here and published: still this Server's.
  assert.equal(raftAppView(builtHere({ appType: "third_party_global", publishStatus: "published" }), manager).origin, "internal");
  // The Server isn't known yet: a server-local App can only be its own.
  assert.equal(raftAppView(builtHere(), { ...manager, serverId: undefined }).origin, "internal");
});

test("origin of a connected service: Raft's listing is marketplace, a URL is internal", () => {
  assert.equal(connectedServiceView(service(), manager).origin, "marketplace");
  assert.equal(connectedServiceView(urlService, manager).origin, "internal");
  assert.equal(listingView(serviceListing(), manager).origin, "marketplace");
});

test("reach is the server's bucket or null, never a number", () => {
  assert.equal(raftAppView(installed({ marketplaceInstallBadge: { kind: "bucket", bucket: "100_plus" } }), manager).reach, "100_plus");
  assert.equal(raftAppView(installed({ marketplaceInstallBadge: { kind: "new" } }), manager).reach, null);
  assert.equal(raftAppView(installed({ marketplaceInstallBadge: { kind: "none" } }), manager).reach, null);
  assert.equal(raftAppView(builtHere(), manager).reach, null);
  assert.equal(connectedServiceView(service(), manager).reach, null);
  assert.equal(listingView(serviceListing({ installBucket: "1k_plus" }), manager).reach, "1k_plus");
  assert.equal(listingView(appListing({ installBucket: "10_plus" }), manager).reach, "10_plus");
  assert.equal(listingView(appListing(), manager).reach, null);
});

test("an update that waits for approval is the manager's state", () => {
  for (const flags of [
    { permissionApprovalRequired: true },
    { promptTextConfirmationRequired: true },
    { needsAdminReview: true },
  ]) {
    const view = raftAppView(installed(flags), manager);
    assert.equal(view.state, "updateNeedsApproval");
    assert.equal(view.needsAttention, true);
    const forMember = raftAppView(installed(flags), member);
    assert.equal(forMember.state, "normal");
    assert.equal(forMember.needsAttention, false);
  }
  assert.equal(raftAppView(builtHere({ needsAdminReview: true }), manager).state, "updateNeedsApproval");
  const quiet = raftAppView(installed(), manager);
  assert.equal(quiet.state, "normal");
  assert.equal(quiet.needsAttention, false);
});

test("a text confirmation doesn't count while its flag is off", () => {
  const off = { ...manager, promptTextConsent: false };
  assert.equal(raftAppView(installed({ promptTextConfirmationRequired: true }), off).state, "normal");
  assert.equal(raftAppView(installed({ permissionApprovalRequired: true }), off).state, "updateNeedsApproval");
});

const status = (over: Partial<McpAppListItem["status"]> = {}): McpAppListItem["status"] =>
  ({ health: "reachable", toolCount: 12, connectionCount: 1, actionNeeded: 0, ...over });

test("sign-in expired: not produced while the server sends no default connection status", () => {
  // Today's list item: an unreachable server and agents needing action are
  // not an expired sign-in.
  const today = service({ status: status({ health: "unreachable", actionNeeded: 2 }) });
  assert.equal("defaultConnectionStatus" in today.status, false);
  const troubled = connectedServiceView(today, manager);
  assert.equal(troubled.state, "normal");
  assert.equal(troubled.needsAttention, false);
  // A suspended installation is not a card state either.
  assert.equal(raftAppView(installed({ installStatus: "suspended" }), manager).state, "normal");
});

test("sign-in expired: from the default connection's status once the server sends it", () => {
  for (const defaultConnectionStatus of ["expired", "needs_auth"] as const) {
    const view = connectedServiceView(service({ status: status({ defaultConnectionStatus }) }), manager);
    assert.equal(view.state, "signInExpired");
    assert.equal(view.needsAttention, true);
  }
  // No default account (null); ready; a sign-in in progress.
  for (const defaultConnectionStatus of [null, "ready", "pending"] as const) {
    const view = connectedServiceView(service({ status: status({ defaultConnectionStatus }) }), manager);
    assert.equal(view.state, "normal");
    assert.equal(view.needsAttention, false);
  }
  const sorted = sortAppViews([
    connectedServiceView(service({ id: "ok" }), manager),
    connectedServiceView(service({ id: "expired", status: status({ defaultConnectionStatus: "expired" }) }), manager),
  ]);
  assert.deepEqual(sorted.map((view) => view.id), ["expired", "ok"]);
});

test("cannot connect: the default connection fails", () => {
  const view = connectedServiceView(service({ status: status({ defaultConnectionStatus: "error" }) }), manager);
  assert.equal(view.state, "cannotConnect");
  assert.equal(view.needsAttention, true);
});

test("a connected service's connection state is the manager's: anyone else's card is normal, whatever the item carries", () => {
  // The server sends null to a viewer who doesn't manage Apps; the mapper doesn't rely on it.
  for (const defaultConnectionStatus of ["expired", "needs_auth", "error"] as const) {
    const item = service({ status: status({ defaultConnectionStatus }) });
    assert.notEqual(connectedServiceView(item, manager).state, "normal", defaultConnectionStatus);
    const view = connectedServiceView(item, member);
    assert.equal(view.state, "normal", defaultConnectionStatus);
    assert.equal(view.needsAttention, false, defaultConnectionStatus);
  }
});

test("every state but normal needs attention, and the strongest one shows", () => {
  assert.deepEqual(APP_CARD_STATE_PRECEDENCE, ["cannotConnect", "signInExpired", "updateNeedsApproval", "normal"]);
  assert.equal(strongestAppCardState([]), "normal");
  assert.equal(strongestAppCardState(["normal"]), "normal");
  assert.equal(strongestAppCardState(["updateNeedsApproval", "normal"]), "updateNeedsApproval");
  assert.equal(strongestAppCardState(["updateNeedsApproval", "signInExpired"]), "signInExpired");
  assert.equal(strongestAppCardState(["updateNeedsApproval", "signInExpired", "cannotConnect"]), "cannotConnect");
  const views = [
    raftAppView(installed(), manager),
    raftAppView(installed({ permissionApprovalRequired: true }), manager),
    connectedServiceView(service({ status: status({ defaultConnectionStatus: "expired" }) }), manager),
    connectedServiceView(service({ status: status({ defaultConnectionStatus: "error" }) }), manager),
  ];
  assert.deepEqual(views.map((view) => view.state), ["normal", "updateNeedsApproval", "signInExpired", "cannotConnect"]);
  for (const view of views) assert.equal(view.needsAttention, view.state !== "normal");
});

test("a connected service's publisher, once the server sends it", () => {
  const template = { kind: "template" as const, templateKey: "notion", maintainedByRaft: true };
  const named = connectedServiceView(service({ source: { ...template, publisherName: "Notion" } }), manager);
  assert.equal(named.publisherName, "Notion");
  assert.equal(named.listedByRaft, true);
  assert.equal(named.official, false);
  const unnamed = connectedServiceView(service({ source: { ...template, publisherName: null } }), manager);
  assert.equal(unnamed.publisherName, null);
  assert.equal(unnamed.listedByRaft, true);
  const byUrl = connectedServiceView(service({ source: { kind: "url", templateKey: null, maintainedByRaft: false, publisherName: "Acme" } }), manager);
  assert.equal(byUrl.publisherName, "Acme");
  assert.equal(byUrl.listedByRaft, false);

  const listed = listingView(serviceListing({ publisherName: "Linear" }), manager);
  assert.equal(listed.publisherName, "Linear");
  assert.equal(listed.listedByRaft, true);
  assert.equal(listingView(serviceListing({ publisherName: null }), manager).publisherName, null);
});

test("a tool's group comes from its hints", () => {
  assert.equal(appToolGroup(undefined), "unlabeled");
  assert.equal(appToolGroup({}), "unlabeled");
  assert.equal(appToolGroup({ idempotentHint: true }), "unlabeled");
  assert.equal(appToolGroup({ readOnlyHint: true }), "readOnly");
  assert.equal(appToolGroup({ readOnlyHint: false }), "changes");
  assert.equal(appToolGroup({ destructiveHint: true }), "changes");
  assert.equal(appToolGroup({ readOnlyHint: true, destructiveHint: false }), "readOnly");
  // Hints that disagree: the cautious reading.
  assert.equal(appToolGroup({ readOnlyHint: true, destructiveHint: true }), "changes");
});

test("needs-attention sorts first, the rest keep their order", () => {
  const views = [
    raftAppView(installed({ id: "a" }), manager),
    raftAppView(installed({ id: "b", permissionApprovalRequired: true }), manager),
    connectedServiceView(service({ id: "c" }), manager),
    raftAppView(installed({ id: "d", needsAdminReview: true }), manager),
    raftAppView(installed({ id: "e" }), manager),
  ];
  const before = views.map((view) => view.id);
  assert.deepEqual(sortAppViews(views).map((view) => view.id), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(views.map((view) => view.id), before);
  assert.deepEqual([...views].sort(compareAppViews).map((view) => view.id), ["b", "d", "a", "c", "e"]);
  assert.equal(compareAppViews(views[0]!, views[2]!), 0);
});

test("added: always for what the Server has, the listing's installed in Discover", () => {
  assert.equal(raftAppView(installed(), manager).added, true);
  assert.equal(raftAppView(installed({ installedAt: null }), manager).added, false);
  assert.equal(raftAppView(builtHere({ installationId: "install-own" }), manager).added, true);
  assert.equal(raftAppView(builtHere(), manager).added, false);
  assert.equal(connectedServiceView(service(), manager).added, true);
  assert.equal(listingView(appListing(), manager).added, false);
  assert.equal(listingView(appListing({ installed: true }), manager).added, true);
  assert.equal(listingView(serviceListing(), manager).added, false);
  assert.equal(listingView(serviceListing({ installed: true }), manager).added, true);
});

test("a Discover listing is the same model", () => {
  const app = listingView(appListing(), manager);
  assert.equal(app.id, "listing-app");
  assert.equal(app.appId, "app-1");
  assert.equal(app.kind, "raftApp");
  assert.equal(app.publisherName, "Acme");
  assert.equal(app.origin, "marketplace");
  // The listing's publisher stands in when the record names none.
  assert.equal(listingView(appListing({}, installed({ publisherName: null, publisherServerName: null })), manager).publisherName, "Acme");
  // One this Server already has keeps its state.
  assert.equal(listingView(appListing({ installed: true }, installed({ permissionApprovalRequired: true })), manager).state, "updateNeedsApproval");

  const linear = listingView(serviceListing(), manager);
  assert.equal(linear.id, "listing-linear");
  assert.equal(linear.appId, null);
  assert.equal(linear.kind, "connectedService");
  assert.equal(linear.listedByRaft, true);
  assert.equal(linear.publisherName, null);
  assert.equal(linear.logoSeed, "linear");
  assert.equal(linear.state, "normal");
});

test("another Server's text is shown inert, this Server's as written", () => {
  const raw = "Ask @alice in #general";
  const theirs = raftAppView(installed({ name: raw, description: raw, publisherServerName: raw }), manager);
  assert.equal(theirs.name, renderThirdPartyInertText({ field: "app_name", value: raw }));
  assert.equal(theirs.description, renderThirdPartyInertText({ field: "description", value: raw }));
  assert.equal(theirs.publisherName, renderThirdPartyInertText({ field: "developer_name", value: raw }));
  assert.notEqual(theirs.description, raw);
  assert.equal(raftAppView(installed({ description: null }), manager).description, null);
  const ours = raftAppView(builtHere({ name: raw, description: raw }), manager);
  assert.equal(ours.name, raw);
  assert.equal(ours.description, raw);
});

test("the detail adds only facts the endpoints send", () => {
  const raft = raftAppDetailView(installed(), manager);
  assert.equal(raft.homepageUrl, "https://tracker.example");
  assert.equal(raft.category, "Other");
  assert.equal(raft.updatedAt, "2026-11-02T08:00:00.000Z");
  assert.deepEqual(raft.allowedScopes, ["profile:read"]);
  assert.equal(raft.endpointUrl, null);
  assert.equal(raft.publisherName, "Acme");

  const view = {
    id: "svc-1-v2",
    profile: { name: "Notion", description: null, homepageUrl: "https://notion.so", logoUrl: null, category: "Productivity", whenToUse: "For agents." },
    source: { kind: "template", templateKey: "notion", maintainedByRaft: true },
    server: { endpointUrl: "https://mcp.notion.com/mcp", tools: [{ name: "search", description: "Find pages." }, { name: "fetch" }] },
    connections: [{ status: "expired" }],
  } as unknown as McpAppView;
  const svc = connectedServiceDetailView("svc-1", view);
  assert.equal(svc.id, "svc-1");
  assert.equal(svc.endpointUrl, "https://mcp.notion.com/mcp");
  assert.equal(svc.homepageUrl, "https://notion.so");
  assert.equal(svc.category, "Productivity");
  assert.equal(svc.updatedAt, null);
  assert.equal(svc.allowedScopes, null);
  assert.equal(svc.official, false);
  assert.equal(svc.listedByRaft, true);
  assert.equal(svc.origin, "marketplace");
  // The detail's own connections don't set the state: only the list item's field does.
  assert.equal(svc.state, "normal");
  assert.equal(raft.tools, null);
  // Today's server sends no hints: every tool is unlabeled, as sent otherwise.
  assert.deepEqual(svc.tools, [
    { name: "search", description: "Find pages.", group: "unlabeled" },
    { name: "fetch", group: "unlabeled" },
  ]);
  assert.equal(svc.publisherName, null);

  const later = connectedServiceDetailView("svc-1", {
    ...view,
    source: { ...view.source, publisherName: "Notion" },
    server: {
      ...view.server,
      tools: [
        { name: "search", annotations: { readOnlyHint: true } },
        { name: "update_page", annotations: { readOnlyHint: false, idempotentHint: true } },
        { name: "delete_page", annotations: { destructiveHint: true } },
        { name: "ping" },
      ],
    },
  });
  assert.deepEqual(later.tools, [
    { name: "search", annotations: { readOnlyHint: true }, group: "readOnly" },
    { name: "update_page", annotations: { readOnlyHint: false, idempotentHint: true }, group: "changes" },
    { name: "delete_page", annotations: { destructiveHint: true }, group: "changes" },
    { name: "ping", group: "unlabeled" },
  ]);
  assert.equal(later.publisherName, "Notion");
  assert.equal(later.listedByRaft, true);
  // Text for agents is not a description.
  assert.equal(JSON.stringify(svc).includes("For agents."), false);
});

test("no App type label reaches the model", () => {
  const views: AppView[] = [
    raftAppView(installed(), manager),
    raftAppView(installed({ privateShared: true, official: true }), manager),
    raftAppView(builtHere(), manager),
    connectedServiceView(service(), manager),
    connectedServiceView(urlService, manager),
    listingView(appListing(), manager),
    listingView(serviceListing(), manager),
    raftAppDetailView(installed(), manager),
  ];
  const typeWords = /mcp|raft app|oauth|template|custom|third[ _-]?party|server_local|maintained/i;
  for (const view of views) {
    // `kind` is for behaviour; it is one of two fixed values and never shown.
    assert.ok(view.kind === "raftApp" || view.kind === "connectedService");
    const { kind: _kind, ...shown } = view;
    for (const [key, value] of Object.entries(shown)) {
      assert.equal(typeWords.test(key), false, key);
      if (typeof value === "string") assert.equal(typeWords.test(value), false, `${key}: ${value}`);
    }
    assert.equal("developer" in view, false);
    assert.equal("type" in view, false);
  }
});
