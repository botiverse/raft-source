import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { IntegrationsSection } from "../src/features/apps/IntegrationsSection";
import { en } from "../src/i18n/messages/en";
import { forgetMarketplaceRecords } from "../src/lib/marketplaceRecords";
import { useAuthStore } from "../src/store/authStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// The Apps page's Discover scope (PR 4 of the Apps redesign, R12, R15, R40,
// R41): the same card as Yours in its Discover variant; a card opens the
// App's details, where Add sits at the top right while the App isn't added;
// a card's own Add adds without them (a Raft App through its install
// confirmation, a connected service at once); "Recommended for {server}"
// tops it; a member has no Discover at all; a connected service not added
// has no Tools; Category and the search are the server's.

const originalApi = { get: api.get, post: api.post, put: api.put, patch: api.patch, delete: api.delete };
const HERE = "server-1";
const LISTINGS = "/integrations/marketplace/listings";
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

// A Raft App on the Marketplace (GET /integrations/marketplace), added here or not.
const raftApp = (id: string, name: string, fields: Record<string, unknown> = {}) => ({
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
  official: false,
  purpose: "",
  installationId: null,
  installStatus: null,
  botGrant: null,
  installedAt: null,
  marketplaceInstallBadge: { kind: "none" },
  publisherName: null,
  publisherServerName: "Acme Studio",
  privateShared: false,
  appNotificationGroups: [],
  appNotificationEvents: [],
  appNotificationReviewPending: false,
  appNotificationPendingRevisionId: null,
  appNotificationPendingGroups: [],
  appNotificationPendingEvents: [],
  ...fields,
});

const RETRO = raftApp("retro", "Retro Board", { enableBot: true, bot: { offered: true, grant: null, handle: "retro" } });
const STAMP = raftApp("stamp", "Stamp", {
  official: true,
  publisherServerName: "Raft",
  installationId: "stamp-install",
  installStatus: "active",
  installedAt: "2026-10-01T00:00:00.000Z",
});

const appListing = (record: ReturnType<typeof raftApp>, category = "Developer Tools") => ({
  id: `app:${record.id}`,
  kind: "app",
  name: record.name,
  description: record.description,
  logoUrl: null,
  category,
  installBucket: "10_plus",
  publishedAt: "2026-10-01T00:00:00.000Z",
  installed: !!record.installedAt,
  publisherName: record.publisherServerName,
  app: record,
});

const serviceListing = (templateKey: string, name: string, publisherName: string | null, installed: boolean, category = "Productivity & Collaboration") => ({
  id: `mcp:${templateKey}`,
  kind: "mcp",
  templateKey,
  name,
  description: `${name} description.`,
  logoUrl: null,
  category,
  homepageUrl: `https://${templateKey}.example.test`,
  publisherName,
  installBucket: "100_plus",
  publishedAt: "2026-10-01T00:00:00.000Z",
  installed,
});

const LISTED = [
  appListing(STAMP),
  serviceListing("notion", "Notion", "Notion", true),
  serviceListing("linear", "Linear", "Linear", false),
  appListing(RETRO, "Communication"),
  serviceListing("postgres", "Postgres", null, false),
];

// This Server's connected services (GET /mcp/apps): Notion, made from Raft's listing.
const NOTION_APP = {
  kind: "mcp",
  id: "notion-app",
  name: "Notion",
  description: "Notion description.",
  logoUrl: null,
  homepageUrl: null,
  category: "Productivity & Collaboration",
  distribution: "server_local",
  source: { kind: "template", templateKey: "notion", maintainedByRaft: true, publisherName: "Notion" },
  status: { health: "reachable", toolCount: 3, connectionCount: 1, actionNeeded: 0 },
};

/**
 * The Server's reads, the listings filtered by the request's category and
 * search as the server does; the list's requests are kept. Adding a
 * connected service (POST /mcp/apps) and a Raft App
 * (POST /integrations/marketplace/:id/install) answer as the server does.
 */
function serveDiscover({
  marketplace = [STAMP, RETRO] as unknown[],
  addService,
}: {
  marketplace?: unknown[];
  /** How POST /mcp/apps answers, when not at once with the made App. */
  addService?: () => Promise<unknown>;
} = {}) {
  const gets: string[] = [];
  const listingParams: Record<string, unknown>[] = [];
  const posts: { url: string; body: unknown }[] = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    gets.push(url);
    if (url === LISTINGS) {
      const params = config?.params ?? {};
      // The scope's count reads the unfiltered total (with the default sort); the list's own reads are kept.
      if (!("sort" in params)) listingParams.push(params);
      const q = typeof params.q === "string" ? params.q.toLowerCase() : "";
      const items = LISTED
        .filter((listing) => !params.category || listing.category === params.category)
        .filter((listing) => !q || listing.name.toLowerCase().includes(q));
      return { data: { items, nextCursor: null, total: items.length } };
    }
    if (url === "/integrations/marketplace") return { data: marketplace };
    if (url === "/integrations/clients") return { data: [] };
    if (url === "/integrations/overview") return { data: [] };
    if (url === "/mcp/apps") return { data: { apps: [NOTION_APP] } };
    if (url === "/integrations/link-preview-consents") return { data: { allowed: [], declined: [] } };
    if (url.startsWith("/mcp/apps/")) throw { response: { status: 404, data: { error: "not found" } } };
    // An installed App's notification choices, which its detail reads: none to show here.
    if (url.endsWith("/app-notifications")) throw { response: { status: 404, data: { error: "not found" } } };
    return { data: [] };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") return { data: { enabled: false } };
    posts.push({ url, body });
    if (url === "/mcp/apps") {
      if (addService) return addService();
      return { data: { id: "linear-app", profile: { name: "Linear" }, server: { authKind: "oauth" } } };
    }
    return { data: {} };
  }) as typeof api.post;
  return { gets, listingParams, posts };
}

function renderApps(entry = "/s/launch/apps?tab=discover") {
  return render(
    <TestIntlProvider>
      <MemoryRouter initialEntries={[entry]}>
        <IntegrationsSection variant="page" />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

/** Discover's cards once the listings are read. */
async function loadedDiscover(): Promise<HTMLElement> {
  const discover = await screen.findByTestId("connected-apps-marketplace-tab");
  await within(discover).findByTestId("connected-apps-marketplace-collection");
  return discover;
}

/** A card's cover button: the card itself, named after the App. */
const card = (discover: HTMLElement, name: string) => within(discover).getByRole("button", { name });
/** The card itself (its cover button's card), by the listing's id. */
const cardOf = (discover: HTMLElement, listingId: string) => within(discover).getByTestId(`apps-marketplace-row-${listingId}`);

/** The open detail: the dialog named after the App. */
async function openDetail(name: string): Promise<HTMLElement> {
  return screen.findByRole("dialog", { name });
}

test("a link's ?tab=discover opens Discover: every listing as the same card, Add on what isn't added, Added on what is", async () => {
  setViewer("owner");
  serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  assert.ok(screen.queryByTestId("connected-apps-yours-tab") === null);
  const collection = within(discover).getByTestId("connected-apps-marketplace-collection");
  assert.deepEqual(
    Array.from(collection.children).map((item) => item.getAttribute("data-testid")),
    ["app:stamp", "mcp:notion", "mcp:linear", "app:retro", "mcp:postgres"].map((id) => `apps-marketplace-row-${id}`),
  );
  // Added once this Server has it; Add, named after the App, otherwise.
  for (const id of ["app:stamp", "mcp:notion"]) {
    assert.ok(within(cardOf(discover, id)).getByTestId("app-card-added"), id);
    assert.ok(within(cardOf(discover, id)).queryByTestId("app-card-add") === null, id);
  }
  for (const name of ["Linear", "Retro Board", "Postgres"]) assert.ok(within(discover).getByRole("button", { name: `Add ${name}` }), name);
  // Who makes it, then how widely it is used; Raft's listing when no maker is named. No App type, no state.
  assert.equal(within(cardOf(discover, "mcp:linear")).getByTestId("app-card-source").textContent, "By Linear · 100+ servers");
  assert.equal(within(cardOf(discover, "mcp:postgres")).getByTestId("app-card-source").textContent, "Listed by Raft · 100+ servers");
  assert.ok(!/MCP|Raft App/u.test(collection.textContent ?? ""), collection.textContent ?? "");
  assert.ok(within(collection).queryByTestId("app-card-status") === null);
  assert.ok(within(collection).queryByTestId("app-card-attention-dot") === null);
});

test("a card opens the App's details first; a Raft App not added has Add at the top right, which adds it", async () => {
  setViewer("owner");
  const probe = serveDiscover();
  renderApps();
  const discover = await loadedDiscover();

  fireEvent.click(card(discover, "Retro Board"));
  const detail = await openDetail("Retro Board");
  assert.equal(probe.posts.length, 0, "opening the details adds nothing");
  // Add is in the head, before ×, named after the App.
  const actions = within(detail).getByTestId("connected-app-detail-actions");
  const add = within(actions).getByRole("button", { name: "Add Retro Board" });
  // What adding approves is in the same details, below.
  assert.ok(within(detail).getByTestId("connected-app-detail-add-approves"));
  fireEvent.click(add);
  await waitFor(() => assert.deepEqual(probe.posts.map((post) => post.url), ["/integrations/marketplace/retro/install"]));
  // Added: the details close (no setup step), and the lists are read again.
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Retro Board" }) === null));
});

test("an added Raft App's card opens its details with no Add", async () => {
  setViewer("owner");
  serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.click(card(discover, "Stamp"));
  const detail = await openDetail("Stamp");
  assert.ok(within(detail).queryByTestId("connected-app-detail-actions") === null);
  assert.ok(within(detail).getByRole("button", { name: "Uninstall from this server" }));
});

test("a Raft App's card Add opens its install confirmation, not its details: what installing approves, its bot, then Add", async () => {
  setViewer("owner");
  const probe = serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.click(within(discover).getByRole("button", { name: "Add Retro Board" }));
  const confirm = await screen.findByRole("dialog", { name: "Add Retro Board" });
  assert.equal(confirm.getAttribute("data-testid"), "apps-install-confirm");
  // No details: the confirmation alone, with the set installing approves and the bot's option.
  assert.ok(screen.queryByTestId("connected-app-detail-body") === null);
  assert.ok(within(confirm).getByText("Also add @retro to Launch Server"));
  assert.equal(probe.posts.length, 0, "opening it adds nothing");

  // Cancel closes it with nothing added.
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByTestId("apps-install-confirm") === null));
  assert.equal(probe.posts.length, 0);

  // Add installs exactly what it showed, the bot unchecked as the admin left it.
  fireEvent.click(within(discover).getByRole("button", { name: "Add Retro Board" }));
  const again = await screen.findByRole("dialog", { name: "Add Retro Board" });
  fireEvent.click(within(again).getByTestId("connected-app-bot-install-checkbox"));
  fireEvent.click(within(again).getByTestId("apps-install-confirm-add"));
  await waitFor(() => assert.deepEqual(probe.posts.map((post) => post.url), ["/integrations/marketplace/retro/install"]));
  assert.equal((probe.posts[0]!.body as { bot?: boolean }).bot, false);
  await waitFor(() => assert.ok(screen.queryByTestId("apps-install-confirm") === null));
  // The card itself still opens the details, not the confirmation.
  fireEvent.click(card(discover, "Retro Board"));
  assert.ok(await openDetail("Retro Board"));
  assert.ok(screen.queryByTestId("apps-install-confirm") === null);
});

test("a connected service's card Add adds it at once, from Raft's listing, and opens it on its accounts", async () => {
  setViewer("owner");
  const probe = serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.click(within(discover).getByRole("button", { name: "Add Linear" }));
  await waitFor(() => assert.equal(probe.posts.length, 1));
  assert.equal(probe.posts[0]!.url, "/mcp/apps");
  assert.deepEqual((probe.posts[0]!.body as { source: unknown }).source, { kind: "template", templateKey: "linear" });
  // No details in between: the editor of what was made opens.
  assert.ok(screen.queryByTestId("apps-discover-service-detail") === null);
  assert.ok(await screen.findByTestId("mcp-app-editor"));
});

test("a connected service not added: its details have who makes it and Information, Add at the top right, and no Tools", async () => {
  setViewer("owner");
  const probe = serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.click(card(discover, "Linear"));
  const detail = await openDetail("Linear");
  assert.equal(probe.posts.length, 0, "opening the details adds nothing");
  assert.ok(within(detail).getByTestId("apps-discover-service-detail"));
  assert.equal(within(detail).getByTestId("apps-discover-detail-source").textContent, "By Linear");
  assert.ok(within(detail).getByText("Linear description."));
  assert.ok(within(detail).getByText("Information"));
  assert.ok(within(detail).getByText("Developer"));
  assert.ok(within(detail).getByText("Listed by"));
  assert.ok(within(detail).getByRole("link", { name: /linear\.example\.test/u }));
  // R40: no Tools before a sign-in, no "Try asking" (the listing has no examples), no selling points.
  for (const absent of ["Tools", "Try asking", "What it does in Raft"]) assert.ok(within(detail).queryByText(absent) === null, absent);
  assert.ok(!/MCP/u.test(detail.textContent ?? ""), detail.textContent ?? "");

  // Its Add, named after the App, makes it; the details close and its editor opens.
  fireEvent.click(within(within(detail).getByTestId("connected-app-detail-actions")).getByRole("button", { name: "Add Linear" }));
  await waitFor(() => assert.deepEqual(probe.posts.map((post) => post.url), ["/mcp/apps"]));
  assert.ok(await screen.findByTestId("mcp-app-editor"));
  assert.ok(screen.queryByTestId("apps-discover-service-detail") === null);
});

test("a connected service with no maker named says Raft listed it; an added one opens its editor for an owner", async () => {
  setViewer("owner");
  const probe = serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.click(card(discover, "Postgres"));
  const detail = await openDetail("Postgres");
  assert.equal(within(detail).getByTestId("apps-discover-detail-source").textContent, "Listed by Raft");
  assert.ok(within(detail).queryByText("Developer") === null);
  fireEvent.click(within(detail).getByRole("button", { name: "Close" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Postgres" }) === null));

  fireEvent.click(card(discover, "Notion"));
  assert.ok(await screen.findByTestId("mcp-app-editor"));
  assert.ok(probe.gets.includes("/mcp/apps/notion-app"), probe.gets.join(", "));
  assert.ok(screen.queryByTestId("apps-discover-service-detail") === null);
});

test("a member has no Discover: no scope switch, and a link's ?tab=discover opens Yours", async () => {
  setViewer("member");
  const probe = serveDiscover();
  renderApps();
  const yours = await screen.findByTestId("connected-apps-yours-tab");
  await within(yours).findByText("Stamp");
  assert.ok(screen.queryByTestId("connected-apps-marketplace-tab") === null);
  assert.ok(screen.queryByTestId("connected-apps-tabs") === null);
  assert.ok(screen.queryByTestId("connected-apps-scope-select") === null);
  assert.ok(screen.queryByTestId("connected-apps-tab-discover") === null);
  assert.ok(screen.queryByTestId("apps-recommended") === null);
  assert.ok(screen.queryByTestId("register-app-menu-trigger") === null);
  // Nothing of Discover is read for a member: no listings, not even their count.
  assert.ok(!probe.gets.includes(LISTINGS), probe.gets.join(", "));
  assert.equal(probe.posts.length, 0);
});

test("Discover's one filter is its Category, sent to the server; no Type, no Sort, no Source", async () => {
  setViewer("owner");
  const probe = serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  for (const absent of ["apps-filter-type", "apps-filter-sort", "apps-filter-origin"]) assert.ok(screen.queryByTestId(absent) === null, absent);
  assert.deepEqual(probe.listingParams.at(-1), {});

  fireEvent.click(screen.getByRole("combobox", { name: en["settings.connectedApps.categoryAll"] }));
  const option = await screen.findByRole("option", { name: en["settings.connectedApps.categoryCommunication"] });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => assert.deepEqual(probe.listingParams.at(-1), { category: "Communication" }));
  await waitFor(() => assert.deepEqual(
    Array.from(within(discover).getByTestId("connected-apps-marketplace-collection").children).map((item) => item.getAttribute("data-testid")),
    ["apps-marketplace-row-app:retro"],
  ));
  assert.ok(screen.getByTestId("apps-filter-clear-all"));
});

test("a search that matches nothing names it, and Clear all brings every listing back", async () => {
  setViewer("owner");
  const probe = serveDiscover();
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search connected apps" }), { target: { value: "calendar" } });
  const noMatch = await within(discover).findByTestId("apps-no-match", undefined, { timeout: 3_000 });
  assert.ok(within(noMatch).getByText("No marketplace apps match this view"));
  assert.ok(noMatch.textContent?.includes("“calendar”"), noMatch.textContent ?? "");
  assert.deepEqual(probe.listingParams.at(-1), { q: "calendar" });
  fireEvent.click(within(noMatch).getByTestId("apps-no-match-clear-all"));
  await waitFor(() => assert.equal(within(discover).getByTestId("connected-apps-marketplace-collection").children.length, LISTED.length));
});

test("Recommended for the Server tops Discover, as the same card: it opens the details, and its Add the install confirmation", async () => {
  setViewer("owner");
  const recommended = raftApp("stamp-official", "Stamp", { clientId: "stamp", official: true, serverId: "raft-official", publisherServerName: "Raft" });
  serveDiscover({ marketplace: [recommended, RETRO] });
  renderApps();
  const discover = await loadedDiscover();
  const section = await within(discover).findByTestId("apps-recommended");
  assert.ok(within(section).getByRole("heading", { name: "Recommended for Launch Server" }));
  assert.ok(within(discover).getByRole("heading", { name: "All apps" }));
  const stamp = within(section).getByTestId("apps-recommended-stamp");
  // No line that says why: who makes it, like every card.
  assert.equal(within(stamp).getByTestId("app-card-source").textContent, "By Raft");
  assert.ok(within(stamp).getByTestId("app-card-official"));
  fireEvent.click(within(stamp).getByRole("button", { name: "Add Stamp" }));
  assert.ok(await screen.findByRole("dialog", { name: "Add Stamp" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(screen.queryByTestId("apps-install-confirm") === null));
  fireEvent.click(within(stamp).getByRole("button", { name: "Stamp" }));
  assert.ok(await openDetail("Stamp"));

  // A search or a category hides it.
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Stamp" }) === null));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search connected apps" }), { target: { value: "retro" } });
  await waitFor(() => assert.ok(within(discover).queryByTestId("apps-recommended") === null));

  // Yours no longer has it.
  fireEvent.click(screen.getByTestId("connected-apps-tab-yours"));
  await screen.findByTestId("connected-apps-yours-tab");
  assert.ok(screen.queryByTestId("apps-recommended") === null);
});

/** A request the test answers when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ADD_REFUSED = "The service refused the template.";
const refused = { response: { status: 400, data: { error: ADD_REFUSED } } };

test("a connected service's card Add says Adding… and waits; every other Add waits with it; a failure says why on that card alone", async () => {
  setViewer("owner");
  const answer = deferred<unknown>();
  const probe = serveDiscover({ addService: () => answer.promise });
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.click(within(discover).getByRole("button", { name: "Add Linear" }));

  // Its own Add says Adding… and takes no press; the others are visibly off, not silently ignored.
  const linearAdd = within(cardOf(discover, "mcp:linear")).getByTestId("app-card-add");
  await waitFor(() => assert.equal(linearAdd.textContent, "Adding…"));
  assert.equal((linearAdd as HTMLButtonElement).disabled, true);
  for (const id of ["mcp:postgres", "app:retro"]) {
    const other = within(cardOf(discover, id)).getByTestId("app-card-add") as HTMLButtonElement;
    assert.equal(other.disabled, true, id);
    assert.equal(other.textContent, "Add", id);
  }
  fireEvent.click(within(cardOf(discover, "mcp:postgres")).getByTestId("app-card-add"));
  assert.equal(probe.posts.length, 1, "one add at a time");

  answer.reject(refused);
  // The failure is on the card whose Add failed, and nowhere else: not in the page's banner.
  const status = await within(cardOf(discover, "mcp:linear")).findByRole("alert");
  assert.equal(status.textContent, ADD_REFUSED);
  assert.equal(screen.getAllByText(ADD_REFUSED).length, 1);
  assert.ok(screen.queryByTestId("mcp-app-editor") === null);
  // The Add is back, described by what failed, and every other Add with it.
  const again = within(cardOf(discover, "mcp:linear")).getByRole("button", { name: "Add Linear" }) as HTMLButtonElement;
  assert.equal(again.disabled, false);
  assert.equal(again.getAttribute("aria-describedby"), within(cardOf(discover, "mcp:linear")).getByTestId("app-card-add-status").id);
  assert.equal((within(cardOf(discover, "mcp:postgres")).getByTestId("app-card-add") as HTMLButtonElement).disabled, false);
  assert.ok(within(cardOf(discover, "mcp:postgres")).queryByRole("alert") === null);

  // Its details don't repeat the card's failure: only their own Add's.
  fireEvent.click(card(discover, "Linear"));
  const detail = await openDetail("Linear");
  assert.ok(within(detail).queryByTestId("apps-discover-detail-error") === null);
});

test("a connected service's details show their own Add's failure, inside them alone, and close with it", async () => {
  setViewer("owner");
  const answer = deferred<unknown>();
  serveDiscover({ addService: () => answer.promise });
  renderApps();
  const discover = await loadedDiscover();
  fireEvent.click(card(discover, "Linear"));
  const detail = await openDetail("Linear");
  const add = within(within(detail).getByTestId("connected-app-detail-actions")).getByRole("button", { name: "Add Linear" }) as HTMLButtonElement;
  fireEvent.click(add);
  await waitFor(() => assert.equal(add.textContent, "Adding…"));
  assert.equal(add.disabled, true);

  answer.reject(refused);
  const banner = await within(detail).findByTestId("apps-discover-detail-error");
  assert.equal(banner.textContent, ADD_REFUSED);
  // Not again in the page's banner behind the dialog, nor on the card.
  assert.equal(screen.getAllByText(ADD_REFUSED).length, 1);
  assert.ok(within(cardOf(discover, "mcp:linear")).queryByRole("alert") === null);

  fireEvent.click(within(detail).getByRole("button", { name: "Close" }));
  await waitFor(() => assert.ok(screen.queryByRole("dialog", { name: "Linear" }) === null));
  assert.ok(screen.queryByText(ADD_REFUSED) === null);
  fireEvent.click(card(discover, "Linear"));
  assert.ok(within(await openDetail("Linear")).queryByTestId("apps-discover-detail-error") === null);
});

test("a Raft App added from its card's confirmation, then uninstalled: a link to it opens its details, not the old confirmation", async () => {
  setViewer("owner");
  const retro = { ...RETRO };
  const marketplace: unknown[] = [STAMP, retro];
  const probe = serveDiscover({ marketplace });
  const installed = { installationId: "retro-install", installStatus: "active", installedAt: "2026-11-01T00:00:00.000Z" };
  const notInstalled = { installationId: null, installStatus: null, installedAt: null };
  const post = api.post;
  api.post = (async (url: string, body?: unknown) => {
    const answer = await post(url, body);
    if (url === "/integrations/marketplace/retro/install") Object.assign(retro, installed);
    return answer;
  }) as typeof api.post;
  const deletes: string[] = [];
  api.delete = (async (url: string) => {
    deletes.push(url);
    return { data: {} };
  }) as typeof api.delete;
  const before = window.location.href;
  try {
    renderApps();
    const discover = await loadedDiscover();
    fireEvent.click(within(discover).getByRole("button", { name: "Add Retro Board" }));
    const confirm = await screen.findByRole("dialog", { name: "Add Retro Board" });
    fireEvent.click(within(confirm).getByTestId("apps-install-confirm-add"));
    await waitFor(() => assert.deepEqual(probe.posts.map((entry) => entry.url), ["/integrations/marketplace/retro/install"]));
    await waitFor(() => assert.ok(screen.queryByTestId("apps-install-confirm") === null));

    // Uninstalled from Yours' installed detail; meanwhile a link names it.
    fireEvent.click(screen.getByTestId("connected-apps-tab-yours"));
    const yours = await screen.findByTestId("connected-apps-yours-tab");
    fireEvent.click(await within(yours).findByRole("button", { name: "Retro Board" }));
    fireEvent.click(await screen.findByTestId("connected-app-installed-uninstall"));
    window.history.replaceState(null, "", "/s/launch/apps?marketplace_app=retro");
    Object.assign(retro, notInstalled);
    fireEvent.click(await screen.findByTestId("connected-app-uninstall-confirm-button"));
    await waitFor(() => assert.deepEqual(deletes, ["/integrations/marketplace/retro/install"]));

    // The lists are read again and the link's App opens: as its details.
    const detail = await openDetail("Retro Board");
    assert.ok(within(detail).getByTestId("connected-app-detail-body"));
    assert.ok(screen.queryByTestId("apps-install-confirm") === null);
  } finally {
    window.history.replaceState(null, "", before);
  }
});
