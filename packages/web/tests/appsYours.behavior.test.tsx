import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { NavigateFunction } from "react-router-dom";
import api from "../src/api/client";
import { IntegrationsSection } from "../src/features/apps/IntegrationsSection";
import { forgetMarketplaceRecords } from "../src/lib/marketplaceRecords";
import { useAuthStore } from "../src/store/authStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { openYours, yoursCard } from "./helpers/appsYours";
import { TestIntlProvider } from "./helpers/intl";
import { serveMarketplaceListingsFromAppRecords } from "./helpers/marketplaceListings";
import { chooseRegisterAppMenuItem } from "./helpers/registerAppMenu";

// The Apps page's Yours scope (PR 3 of the Apps redesign): the two scopes and
// the old tab names, Yours' cards in their order, its origin filter, a
// member's read-only view, and that everything an installed row offered is
// still reached from what its card opens.

serveMarketplaceListingsFromAppRecords();

const originalApi = { get: api.get, post: api.post, put: api.put, patch: api.patch, delete: api.delete };
const HERE = "server-1";
const server: Server = {
  id: HERE,
  name: "Launch Server",
  avatarUrl: null,
  slug: "launch",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-06-25T00:00:00.000Z",
};

function setViewer(role: Server["role"]) {
  useAuthStore.setState({ user: { id: "user-1", email: "owner@example.com", name: "Owner", displayName: "Owner" }, loading: false, initialized: true } as never);
  const current = { ...server, role };
  useServerStore.setState({ servers: [current], current, members: [], loading: false } as never);
}

afterEach(() => {
  cleanup();
  Object.assign(api, originalApi);
  forgetMarketplaceRecords();
  resetServerFeatureFlagsForTests();
});

const base = (id: string, name: string, fields: Record<string, unknown> = {}) => ({
  id,
  serverId: "publisher-server",
  clientId: `${id}-key`,
  appType: "third_party_global",
  publishStatus: "published",
  category: "Developer Tools",
  dataAccessSummary: null,
  publishRejectionReason: null,
  name,
  description: `${name} description.`,
  whenToUse: null,
  homepageUrl: `https://${id}.example.test`,
  returnUrl: `https://${id}.example.test/callback`,
  agentManifestUrl: null,
  allowedScopes: ["openid", "profile"],
  logoUrl: null,
  humanMarketplaceVisible: true,
  enableBot: false,
  createdByUserId: "user-9",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...fields,
});

// GET /integrations/marketplace: another Server's App installed here.
const listed = (id: string, name: string, fields: Record<string, unknown> = {}) => base(id, name, {
  official: false,
  purpose: "",
  installationId: `${id}-install`,
  installStatus: "active",
  botGrant: null,
  installedAt: "2026-10-01T00:00:00.000Z",
  marketplaceInstallBadge: { kind: "none" },
  publisherName: null,
  publisherServerName: "Acme",
  privateShared: false,
  appNotificationGroups: [],
  appNotificationEvents: [],
  appNotificationReviewPending: false,
  appNotificationPendingRevisionId: null,
  appNotificationPendingGroups: [],
  appNotificationPendingEvents: [],
  ...fields,
});

// GET /integrations/clients: an App built on this Server.
const built = (id: string, name: string, fields: Record<string, unknown> = {}) => base(id, name, {
  serverId: HERE,
  appType: "server_local",
  publishStatus: "private",
  humanMarketplaceVisible: false,
  createdByUserId: "user-1",
  ...fields,
});

const serviceItem = (id: string, name: string, kind: "url" | "template") => ({
  kind: "mcp",
  id,
  name,
  description: `${name} description.`,
  logoUrl: null,
  homepageUrl: null,
  category: "Other",
  distribution: "server_local",
  source: { kind, templateKey: kind === "template" ? id : null, maintainedByRaft: kind === "template" },
  status: { health: "reachable", toolCount: 3, connectionCount: 1, actionNeeded: 0 },
});

const installState = (approvalRequired: boolean) => ({
  installation_id: "install-1",
  status: "active",
  approved_request_revision_id: "perm-1",
  requested_groups: approvalRequired ? ["agent", "server"] : ["server"],
  requested_events: [],
  requested_scopes: ["openid", "profile"],
  new_scopes: [],
  approved_groups: ["server"],
  subscribed_events: [],
  effective_groups: ["server"],
  effective_events: [],
  grant_revision: 1,
  subscription_revision: 1,
  app_review_pending: false,
  approval_required: approvalRequired,
});

/**
 * A Server with one of each: another Server's App (Tracker, its bot not yet
 * added), one whose update waits (Figma), a private share (Ledger), an App
 * built and installed here (Deploy bot), one built here and not installed
 * (Draft tool), a listed service (Notion) and one connected by its URL (Team
 * wiki). The server marks what waits for App managers only.
 */
function serveApps({ manager = true, draftMaker = "user-1", serviceConnection }: { manager?: boolean; draftMaker?: string; serviceConnection?: string } = {}) {
  const gets: string[] = [];
  const deletes: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/integrations/clients") {
      return { data: [
        built("deploys", "Deploy bot", { installationId: "deploys-install", installStatus: "active" }),
        built("draft", "Draft tool", { createdByUserId: draftMaker }),
      ] };
    }
    if (url === "/integrations/marketplace") {
      return { data: [
        listed("tracker", "Tracker", { enableBot: true, bot: { offered: true, grant: "pending", handle: "tracker" } }),
        listed("figma", "Figma", { permissionApprovalRequired: true, ...(manager ? { needsAdminReview: true } : {}) }),
        listed("ledger", "Ledger", { publishStatus: "private", humanMarketplaceVisible: false, privateShared: true }),
      ] };
    }
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/mcp/apps") {
      const notion = serviceItem("notion", "Notion", "template");
      // What only App managers are sent; a test may send it to anyone.
      return { data: { apps: [serviceConnection ? { ...notion, status: { ...notion.status, defaultConnectionStatus: serviceConnection } } : notion, serviceItem("wiki", "Team wiki", "url")] } };
    }
    if (url === "/integrations/link-preview-consents") return { data: { allowed: [], declined: [] } };
    if (url === "/integrations/marketplace/figma/install/app-notifications") return { data: installState(true) };
    if (/^\/integrations\/marketplace\/[^/]+\/install\/app-notifications$/u.test(url)) return { data: installState(false) };
    if (url.endsWith("/share-links")) throw { response: { status: 404, data: { error: "not found" } } };
    if (url.endsWith("/app-notifications")) {
      return { data: { request_revision: 0, current_revision_id: null, current_groups: [], current_events: [], pending_revision: null, webhook: null } };
    }
    if (url.startsWith("/mcp/apps/")) throw { response: { status: 404, data: { error: "not found" } } };
    return { data: [] };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { enabled: false } };
    return { data: {} };
  }) as typeof api.post;
  api.delete = (async (url: string) => {
    deletes.push(url);
    return { data: {} };
  }) as typeof api.delete;
  return { gets, deletes };
}

// The address the page is at: every search it has had since the render, and a way to change it.
const address: { searches: string[]; navigate: NavigateFunction | null } = { searches: [], navigate: null };

function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    address.navigate = navigate;
  }, [navigate]);
  useEffect(() => {
    address.searches.push(location.search);
  }, [location.search]);
  return null;
}

const currentSearch = () => address.searches.at(-1) ?? "";

function renderApps(entry = "/s/launch/apps", variant: "page" | "settings" = "page") {
  address.searches = [];
  address.navigate = null;
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[entry]}>
        <AddressProbe />
        <IntegrationsSection variant={variant} />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

/**
 * The address gains a parameter while the page stays open (a bot's profile
 * opening adds `?profile=`): the others are kept, and the page has rendered
 * with the new address when this returns.
 */
async function addressGains(name: string, value: string) {
  const params = new URLSearchParams(currentSearch());
  params.set(name, value);
  const search = `?${params.toString()}`;
  await act(async () => {
    await address.navigate?.({ search });
  });
  await waitFor(() => assert.ok(address.searches.includes(search), `the address never was ${search}`));
}

const shownScope = () => (screen.queryByTestId("connected-apps-yours-tab") ? "yours" : screen.queryByTestId("connected-apps-marketplace-tab") ? "discover" : "none");

const cardIds = (yours: HTMLElement) => Array.from(within(yours).getByTestId("connected-apps-yours-collection").children)
  .map((card) => card.getAttribute("data-testid")?.replace("connected-app-item-", ""));

async function loadedYours(): Promise<HTMLElement> {
  const yours = await screen.findByTestId("connected-apps-yours-tab");
  await within(yours).findByText("Tracker");
  return yours;
}

async function pickOrigin(current: string, next: string) {
  fireEvent.click(screen.getByRole("combobox", { name: `Source: ${current}` }));
  const option = await screen.findByRole("option", { name: next });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => assert.ok(screen.getByRole("combobox", { name: `Source: ${next}` })));
}

test("the page opens on Yours; a link's old tab name opens the scope that holds its list now", async () => {
  setViewer("owner");
  serveApps();
  renderApps();
  await loadedYours();
  const scope = screen.getByTestId("connected-apps-tabs");
  assert.deepEqual(within(scope).getAllByRole("radio").map((segment) => segment.textContent?.replace(/\d+$/u, "")), ["Yours", "Discover"]);
  assert.equal(screen.getByTestId("connected-apps-tab-yours-count").textContent, "7");
  assert.equal(screen.getByTestId("connected-apps-tab-yours").getAttribute("aria-checked"), "true");

  for (const [tab, shown] of [["marketplace", "connected-apps-marketplace-tab"], ["discover", "connected-apps-marketplace-tab"], ["installed", "connected-apps-yours-tab"], ["myapps", "connected-apps-yours-tab"], ["nonsense", "connected-apps-yours-tab"]] as const) {
    cleanup();
    forgetMarketplaceRecords();
    serveApps();
    renderApps(`/s/launch/apps?tab=${tab}`);
    assert.ok(await screen.findByTestId(shown), tab);
    assert.ok(screen.queryByTestId(shown === "connected-apps-yours-tab" ? "connected-apps-marketplace-tab" : "connected-apps-yours-tab") === null, tab);
  }
});

test("Yours lists every App once as a card, those that need someone first, then today's order", async () => {
  setViewer("owner");
  serveApps();
  renderApps();
  const yours = await loadedYours();
  await within(yours).findByText("Notion");
  assert.deepEqual(cardIds(yours), ["figma", "tracker", "ledger", "deploys", "notion", "wiki", "draft"]);
  const figma = within(yours).getByTestId("connected-app-item-figma");
  assert.equal(figma.getAttribute("data-state"), "updateNeedsApproval");
  assert.equal(within(figma).getByTestId("app-card-status").textContent, "Update needs your approval");
  // Only the App that waits has a button; where each came from is its source line.
  assert.equal(within(yours).getAllByTestId("app-card-action").length, 1);
  const source = (id: string) => within(within(yours).getByTestId(`connected-app-item-${id}`)).getByTestId("app-card-source").textContent;
  assert.equal(source("tracker"), "By Acme");
  assert.equal(source("ledger"), "Shared with you · By Acme");
  assert.equal(source("deploys"), "Internal");
  assert.equal(source("notion"), "Listed by Raft");
  assert.equal(source("wiki"), "Internal");
  assert.equal(source("draft"), "Internal");
  // No App type, no address, no Edit or Uninstall on a card.
  const collection = within(yours).getByTestId("connected-apps-yours-collection");
  assert.ok(!/MCP|Raft App|https?:|example\.test/u.test(collection.textContent ?? ""), collection.textContent ?? "");
  assert.ok(within(collection).queryByRole("link") === null);
  assert.ok(within(collection).queryByTestId("apps-mcp-tag") === null);
  for (const name of ["Edit", "Uninstall"]) assert.ok(within(collection).queryByRole("button", { name }) === null, name);
});

test("an App built here names its maker from the Server's people; one whose maker left says Internal alone", async () => {
  setViewer("owner");
  // The people the page already has: no request is made for them here.
  useServerStore.setState({ members: [
    { userId: "user-1", email: null, name: "olivia", displayName: "Olivia Owner", description: null, avatarUrl: null, role: "owner", joinedAt: "2026-06-25T00:00:00.000Z" },
  ] });
  const { gets } = serveApps({ draftMaker: "user-gone" });
  renderApps();
  const yours = await loadedYours();
  await within(yours).findByText("Notion");
  const source = (id: string) => within(within(yours).getByTestId(`connected-app-item-${id}`)).getByTestId("app-card-source").textContent;
  assert.equal(source("deploys"), "Internal · made by Olivia Owner");
  // Its maker is no longer among the Server's people.
  assert.equal(source("draft"), "Internal");
  // A connected service has no maker.
  assert.equal(source("wiki"), "Internal");
  // Another Server's App names its publisher, never one of this Server's people.
  assert.equal(source("tracker"), "By Acme");
  assert.ok(!gets.some((url) => url.includes("/members")), gets.join(" "));

  // A member reads the same line.
  cleanup();
  forgetMarketplaceRecords();
  setViewer("member");
  useServerStore.setState({ members: [
    { userId: "user-1", email: null, name: "olivia", displayName: null, description: null, avatarUrl: null, role: "owner", joinedAt: "2026-06-25T00:00:00.000Z" },
  ] });
  serveApps({ manager: false, draftMaker: "user-gone" });
  renderApps();
  const membersYours = await loadedYours();
  await within(membersYours).findByText("Notion");
  assert.equal(within(within(membersYours).getByTestId("connected-app-item-deploys")).getByTestId("app-card-source").textContent, "Internal · made by olivia");
  assert.equal(within(within(membersYours).getByTestId("connected-app-item-draft")).getByTestId("app-card-source").textContent, "Internal");
});

test("the origin filter shows its value and keeps the Apps from that origin; nothing left says which filter is on", async () => {
  setViewer("owner");
  serveApps();
  renderApps();
  const yours = await loadedYours();
  await within(yours).findByText("Notion");
  // One filter on Yours: its Source, no Category.
  assert.equal(screen.getByTestId("apps-filter-origin").textContent, "All");
  assert.ok(screen.queryByTestId("connected-apps-category-filter") === null);
  assert.ok(screen.queryByTestId("apps-filter-clear-all") === null);

  await pickOrigin("All", "Internal");
  assert.deepEqual(cardIds(yours), ["deploys", "wiki", "draft"]);
  assert.equal(screen.getByTestId("apps-filter-origin").textContent, "Internal");
  assert.ok(screen.getByTestId("apps-filter-origin").hasAttribute("data-has-value"));
  await pickOrigin("Internal", "Shared with you");
  assert.deepEqual(cardIds(yours), ["ledger"]);
  await pickOrigin("Shared with you", "From marketplace");
  assert.deepEqual(cardIds(yours), ["figma", "tracker", "notion"]);
  // The scope's count is the whole list, not the filtered one.
  assert.equal(screen.getByTestId("connected-apps-tab-yours-count").textContent, "7");

  // With the search too: nothing matches, and the state names both conditions.
  fireEvent.change(screen.getByRole("searchbox", { name: "Search connected apps" }), { target: { value: "ledger" } });
  const noMatch = await screen.findByTestId("apps-no-match");
  assert.ok(within(noMatch).getByText("No apps match this view"));
  assert.ok(noMatch.textContent?.includes("“ledger”") && noMatch.textContent.includes("From marketplace"), noMatch.textContent ?? "");
  assert.ok(within(yours).queryByTestId("connected-apps-yours-collection") === null);
  fireEvent.click(within(noMatch).getByTestId("apps-no-match-clear-all"));
  await waitFor(() => assert.equal(cardIds(yours).length, 7));
  assert.equal(screen.getByTestId("apps-filter-origin").textContent, "All");

  // Discover has its own filter, its Category, and not this one.
  fireEvent.click(screen.getByTestId("connected-apps-tab-discover"));
  await screen.findByTestId("connected-apps-marketplace-tab");
  assert.ok(screen.queryByTestId("apps-filter-origin") === null);
  assert.ok(screen.getByTestId("connected-apps-category-filter"));
});

test("a Server with no Apps says so under the new scope names; its button opens Discover", async () => {
  setViewer("owner");
  api.get = (async (url: string) => (url === "/mcp/apps" ? { data: { apps: [] } } : url === "/integrations/link-preview-consents" ? { data: { allowed: [], declined: [] } } : { data: [] })) as typeof api.get;
  api.post = (async () => ({ data: { enabled: false } })) as typeof api.post;
  renderApps();
  const empty = await screen.findByTestId("apps-yours-empty");
  assert.ok(within(empty).getByText("No apps yet"));
  assert.ok(within(empty).getByText("Add one from Discover, or add your own with Add app."));
  fireEvent.click(within(empty).getByRole("button", { name: "Browse apps" }));
  assert.ok(await screen.findByTestId("connected-apps-marketplace-tab"));

  cleanup();
  forgetMarketplaceRecords();
  setViewer("member");
  renderApps();
  const memberEmpty = await screen.findByTestId("apps-yours-empty");
  assert.ok(within(memberEmpty).getByText("Server owners and admins add apps here."));
  assert.ok(within(memberEmpty).queryByRole("button") === null);
});

test("a member reads Yours: no Add, no state button, and only what a member could open before", async () => {
  setViewer("member");
  const { gets } = serveApps({ manager: false });
  renderApps();
  const yours = await loadedYours();
  await within(yours).findByText("Notion");
  assert.ok(screen.getByTestId("apps-admin-only-note"));
  assert.ok(screen.queryByTestId("register-app-menu-trigger") === null);
  assert.ok(screen.queryByRole("button", { name: "Add app" }) === null);
  // Yours alone: a member has no Discover (R15), so there is no scope to switch.
  assert.ok(screen.queryByTestId("connected-apps-tabs") === null);
  assert.ok(screen.queryByTestId("connected-apps-tab-discover") === null);
  // The same Apps; nothing is marked as waiting for a member, and no card has a button of its own.
  assert.deepEqual(cardIds(yours), ["tracker", "figma", "ledger", "deploys", "notion", "wiki", "draft"]);
  assert.ok(within(yours).queryByTestId("app-card-action") === null);
  assert.ok(within(yours).queryByTestId("app-card-status") === null);
  // An installed App's detail was readable by a member and still is; an
  // editor never was, so those cards are not buttons.
  const cards = Array.from(yours.querySelectorAll("[data-app-card-open]")).map((card) => card.getAttribute("aria-label"));
  assert.deepEqual(cards, ["Tracker", "Figma", "Ledger", "Deploy bot"]);
  fireEvent.click(yoursCard(yours, "Deploy bot"));
  await screen.findByText("Login with Raft access");
  for (const absent of ["connected-app-installed-edit", "connected-app-installed-uninstall", "connected-app-editor", "installed-app-notifications"]) {
    assert.ok(screen.queryByTestId(absent) === null, absent);
  }
  assert.deepEqual(gets.filter((url) => url.startsWith("/mcp/apps/") || url.includes("/app-notifications")), []);
});

test("a connected service's connection state shows to App managers only, also when the read carries it for a member", async () => {
  setViewer("owner");
  serveApps({ serviceConnection: "expired" });
  renderApps();
  const yours = await loadedYours();
  await within(yours).findByText("Notion");
  const notion = within(yours).getByTestId("connected-app-item-notion");
  assert.equal(notion.getAttribute("data-state"), "signInExpired");
  assert.ok(within(notion).getByTestId("app-card-status"));
  assert.deepEqual(cardIds(yours).slice(0, 2), ["figma", "notion"]);

  // The server sends a member null there; the page doesn't rely on it.
  cleanup();
  forgetMarketplaceRecords();
  setViewer("member");
  serveApps({ manager: false, serviceConnection: "expired" });
  renderApps();
  const membersYours = await loadedYours();
  await within(membersYours).findByText("Notion");
  assert.equal(within(membersYours).getByTestId("connected-app-item-notion").getAttribute("data-state"), "normal");
  assert.ok(within(membersYours).queryByTestId("app-card-status") === null);
  assert.ok(within(membersYours).queryByTestId("app-card-action") === null);
  assert.deepEqual(cardIds(membersYours), ["tracker", "figma", "ledger", "deploys", "notion", "wiki", "draft"]);
});

test("another Server's App: the card opens its detail, where its homepage, its bot, and Uninstall are", async () => {
  setViewer("owner");
  const { deletes } = serveApps();
  renderApps();
  const yours = await loadedYours();
  fireEvent.click(yoursCard(yours, "Tracker"));
  const uninstall = await screen.findByTestId("connected-app-installed-uninstall");
  const detail = uninstall.closest('[role="dialog"]') as HTMLElement;
  // Open: the homepage the row linked to.
  assert.equal(within(detail).getByRole("link", { name: /tracker\.example\.test/u }).getAttribute("href"), "https://tracker.example.test");
  // Bot add: the pending bot's section, with its Add.
  assert.ok(within(detail).getByTestId("connected-app-bot-section"));
  // No editor for an App this Server didn't build.
  assert.ok(within(detail).queryByTestId("connected-app-installed-edit") === null);
  // Uninstall: asks first, then removes the installation and closes the detail.
  fireEvent.click(uninstall);
  assert.ok(await screen.findByText("Uninstall Tracker?"));
  assert.deepEqual(deletes, []);
  fireEvent.click(screen.getByTestId("connected-app-uninstall-confirm-button"));
  await waitFor(() => assert.deepEqual(deletes, ["/integrations/marketplace/tracker/install"]));
  await waitFor(() => assert.ok(screen.queryByTestId("connected-app-installed-uninstall") === null));
});

test("an update that waits: the card's Review opens today's review, where Approve update is", async () => {
  setViewer("owner");
  serveApps();
  renderApps();
  const yours = await loadedYours();
  fireEvent.click(within(yours).getByRole("button", { name: "Review Figma" }));
  const review = await screen.findByTestId("installed-app-notifications");
  const banner = await within(review).findByTestId("app-notifications-approval-required");
  assert.ok(within(banner).getByRole("button", { name: "Approve update" }));
  // The same detail as the card opens, so Uninstall is there too.
  assert.ok(screen.getByTestId("connected-app-installed-uninstall"));
});

test("an App built here: Edit is in its installed detail, or the card opens the editor when it isn't installed; share links are in the editor", async () => {
  setViewer("owner");
  serveApps();
  renderApps();
  const yours = await loadedYours();

  // Installed here: the card opens the installed detail (as its name did), which now offers Edit and no Uninstall.
  fireEvent.click(yoursCard(yours, "Deploy bot"));
  const edit = await screen.findByTestId("connected-app-installed-edit");
  assert.ok(screen.queryByTestId("connected-app-installed-uninstall") === null);
  fireEvent.click(edit);
  let editor = await screen.findByTestId("connected-app-editor");
  assert.ok(within(editor).getByText("Edit Deploy bot"));
  assert.ok(screen.queryByTestId("connected-app-installed-edit") === null, "the detail closed for the editor");
  // Share links, the client secret and Delete are where they were: in the editor.
  assert.ok(await within(editor).findByTestId("connected-app-private-share-card"));
  assert.ok(within(editor).getByTestId("connected-app-regenerate-secret-button"));
  assert.ok(within(editor).getByTestId("connected-app-delete-card"));
  fireEvent.click(within(editor).getByRole("button", { name: "Close app form" }));
  await waitFor(() => assert.ok(screen.queryByTestId("connected-app-editor") === null));

  // Not installed here: the card opens the editor itself, as its row's Edit did.
  fireEvent.click(yoursCard(yours, "Draft tool"));
  editor = await screen.findByTestId("connected-app-editor");
  assert.ok(within(editor).getByText("Edit Draft tool"));
  assert.ok(await within(editor).findByTestId("connected-app-private-share-card"));
});

test("a connected service: the card opens its editor for an App manager, as its row did", async () => {
  setViewer("owner");
  const { gets } = serveApps();
  renderApps();
  const yours = await loadedYours();
  await within(yours).findByText("Team wiki");
  assert.equal(gets.some((url) => url.startsWith("/mcp/apps/")), false);
  fireEvent.click(yoursCard(yours, "Team wiki"));
  await waitFor(() => assert.ok(gets.includes("/mcp/apps/wiki")));
});

test("Add keeps its menu and its two flows", async () => {
  setViewer("owner");
  serveApps();
  renderApps();
  await loadedYours();
  assert.equal(screen.getByTestId("register-app-menu-trigger").textContent, "Add app");
  await chooseRegisterAppMenuItem("own-service");
  const editor = await screen.findByTestId("connected-app-editor");
  assert.ok(within(editor).getByText("Create Raft app"));
});

test("the links that open an installed App's detail still do, on Yours", async () => {
  setViewer("owner");
  serveApps();
  // An App bot's profile names its App by the App's id.
  renderApps("/s/launch/apps?installed_app=ledger");
  assert.ok(await screen.findByTestId("connected-app-installed-uninstall"));
  assert.ok(within(screen.getByTestId("connected-app-detail-body").closest('[role="dialog"]') as HTMLElement).getByText("Ledger"));
  assert.ok(screen.getByTestId("connected-apps-yours-tab"));

  cleanup();
  forgetMarketplaceRecords();
  serveApps();
  // The link an App sends to get its bot added names its client id; it wins over a scope named beside it.
  renderApps("/s/launch/apps?tab=marketplace&app_bot=tracker-key");
  assert.ok(await screen.findByTestId("connected-app-bot-section"));
  assert.equal(shownScope(), "yours");
  // The scope named in the link is not applied again when the address changes later: both left the address.
  await waitFor(() => assert.ok(!currentSearch().includes("app_bot"), currentSearch()));
  await addressGains("profile", "x");
  assert.equal(shownScope(), "yours");
  assert.equal(currentSearch(), "?profile=x");
});

test("a link's ?tab= is used once and leaves the address: a later address change keeps the scope the person chose", async () => {
  setViewer("owner");
  serveApps();
  renderApps("/s/launch/apps?tab=discover&keep=1");
  assert.ok(await screen.findByTestId("connected-apps-marketplace-tab"));
  await openYours();
  assert.equal(shownScope(), "yours");
  // Opening a bot's profile from an App's detail adds ?profile= to the address.
  await addressGains("profile", "x");
  assert.equal(shownScope(), "yours");
  // It left the address in one replace, the other parameter kept.
  assert.deepEqual(address.searches, ["?tab=discover&keep=1", "?keep=1", "?keep=1&profile=x"]);
});

test("?tab= beside ?app_bot= leaves the address with it in one replace, and is not applied again afterwards", async () => {
  setViewer("owner");
  serveApps();
  renderApps("/s/launch/apps?tab=discover&app_bot=tracker-key&keep=1");
  // Until the list is read the link's scope shows; then the bot link opens its App on Yours.
  assert.ok(await screen.findByTestId("connected-app-bot-section"));
  assert.equal(shownScope(), "yours");
  await waitFor(() => assert.ok(!currentSearch().includes("app_bot"), currentSearch()));
  await addressGains("profile", "x");
  assert.equal(shownScope(), "yours");
  assert.deepEqual(address.searches, ["?tab=discover&app_bot=tracker-key&keep=1", "?keep=1", "?keep=1&profile=x"]);
  // A link followed while the page is open is used the same way, once.
  await addressGains("tab", "discover");
  await waitFor(() => assert.equal(shownScope(), "discover"));
  await waitFor(() => assert.equal(currentSearch(), "?keep=1&profile=x"));
  await openYours();
  await addressGains("member", "y");
  assert.equal(shownScope(), "yours");
});

test("Settings › Applications shows the same Yours, with Add in its header", async () => {
  setViewer("owner");
  serveApps();
  renderApps("/s/launch/settings/applications", "settings");
  const yours = await loadedYours();
  await within(yours).findByText("Notion");
  assert.deepEqual(cardIds(yours), ["figma", "tracker", "ledger", "deploys", "notion", "wiki", "draft"]);
  assert.ok(screen.getByTestId("register-app-menu-trigger"));
  // As before: no page head, no link-preview row and no Discover count in Settings.
  assert.ok(screen.queryByTestId("apps-page") === null);
  assert.ok(screen.queryByTestId("apps-link-previews") === null);
  assert.ok(screen.queryByTestId("connected-apps-tab-discover-count") === null);
});
