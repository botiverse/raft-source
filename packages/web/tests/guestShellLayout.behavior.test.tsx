import assert from "node:assert/strict";
import "./helpers/installResizeObserver";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import api from "../src/api/client";
import MainLayout, { __testInternals } from "../src/components/layout/MainLayout";
import { shellRouteLayout } from "../src/components/layout/shellRouteLayout";
import { useRailMode } from "../src/hooks/useSidebarTab";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useChannelSideCardStore } from "../src/store/channelSideCardStore";
import { useArtifactViewerStore } from "../src/apps/artifacts/artifactViewerStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests, TASK_V2_CONVERSATIONS_FLAG_KEY } from "../src/store/serverFeatureFlags";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, asArtifactId } from "@botiverse/raft-shared";
import { useServerStore } from "../src/store/serverStore";
import { AppThemeProvider } from "../src/theme/AppThemeProvider";
import { TestIntlProvider } from "./helpers/intl";

// No realtime connection in a unit test: MainLayout's bridge gets an inert socket.
vi.mock("../src/api/socket", () => {
  const inert: object = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "connected" || prop === "active") return false;
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (prop === "id") return undefined;
      if (prop === "io") return inert;
      return () => inert;
    },
  });
  return {
    getSocket: () => inert,
    connectSocket() {},
    disconnectSocket() {},
    resetSocket() {},
    reconnectSocket() {},
    ensureSocketConnected() {},
    isSocketConnected: () => false,
    onSocketCreated: () => () => {},
    updateSocketAuthFromStorage() {},
  };
});

// A Guest is bound to one channel (#wg-rbac:#15): no navigation sidebar
// (Saved, Drafts, the channel sections, DMs) on any width, only the Settings
// list; the server's landing is that channel, on a phone too.

const BASE = "/s/acme";
const layout = (path: string, options: { isDesktop: boolean; guest: boolean; searchSlotOpen?: boolean }) =>
  shellRouteLayout(`${BASE}${path}`, BASE, { searchSlotOpen: false, ...options });

test("a Guest gets no navigation sidebar, desktop or phone; Settings and Activity keep their lists", () => {
  for (const path of ["", "/channel/c1", "/saved", "/drafts"]) {
    assert.equal(layout(path, { isDesktop: true, guest: true }).hideSidebar, true, `desktop ${path || "/"}`);
    assert.equal(layout(path, { isDesktop: true, guest: false }).hideSidebar, false, `a member keeps it on ${path || "/"}`);
  }
  // Nothing to collapse, so no toggle on the rail.
  assert.equal(layout("/channel/c1", { isDesktop: true, guest: true }).sidebarCollapsible, false);
  // A phone's server root is the channel list as a page for a member, not for a Guest.
  const phoneRoot = layout("", { isDesktop: false, guest: true });
  assert.deepEqual({ inline: phoneRoot.mobileShowSidebarInline, hidden: phoneRoot.hideSidebar }, { inline: false, hidden: true });
  assert.equal(layout("", { isDesktop: false, guest: false }).mobileShowSidebarInline, true);

  // The Settings list is the Guest's too, as a page on a phone and beside the page on desktop.
  assert.equal(layout("/settings", { isDesktop: true, guest: true }).hideSidebar, false);
  assert.equal(layout("/settings", { isDesktop: false, guest: true }).mobileShowSidebarInline, true);
  // Activity's own list in col 2 is not the navigation sidebar.
  assert.equal(layout("/activity", { isDesktop: true, guest: true }).hideSidebar, false);
});

test("on a phone a Guest's channel is its Home tab's top-level page; a member's is a pushed page", () => {
  const guestChannel = layout("/channel/c1", { isDesktop: false, guest: true });
  assert.equal(guestChannel.mobileTabRoot, "chat");
  // Its header is the channel's own, paper like any channel's.
  assert.equal(guestChannel.topEdgeSurface, "paper");
  assert.equal(layout("/channel/c1", { isDesktop: false, guest: false }).mobileTabRoot, null);
  // The channel's own search is pushed over it, for a Guest too.
  assert.equal(layout("/channel/c1/search", { isDesktop: false, guest: true }).mobileTabRoot, null);
  assert.equal(layout("/channel/c1", { isDesktop: true, guest: true }).mobileTabRoot, null);
});

const DefaultRoute = __testInternals.DefaultRoute;
const originalMatchMedia = window.matchMedia;

const originalApi = { get: api.get, post: api.post, put: api.put, patch: api.patch, delete: api.delete };

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  Object.assign(api, originalApi);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useChannelSideCardStore.setState({ open: { tasks: false, files: false } });
  useArtifactViewerStore.setState(useArtifactViewerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function phoneLanding(role: "guest" | "member") {
  // A phone: no width match, no fine pointer.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  useServerStore.setState({ current: { id: "s1", slug: "acme", name: "Acme", role } } as never);
  // A Guest's channel list is its one bound channel (listChannels).
  useChannelStore.setState({ channels: [{ id: "bound", serverId: "s1", name: "vendor-sync", type: "private" }], loading: false } as never);
  window.history.replaceState(null, "", BASE);
  render(<TestIntlProvider><BrowserRouter><DefaultRoute /></BrowserRouter></TestIntlProvider>);
}

test("a Guest opening the server on a phone lands in its channel", async () => {
  phoneLanding("guest");
  await waitFor(() => assert.equal(window.location.pathname, `${BASE}/channel/bound`));
});

test("a member opening the server on a phone stays on the channel list", async () => {
  phoneLanding("member");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(window.location.pathname, BASE);
});

// The way out (review of #13021, H1 and M1): the real MainLayout, as a Guest.

const GUEST_SERVER = { id: "s1", slug: "acme", name: "Acme", role: "guest" };
const OTHER_SERVER = { id: "s2", slug: "globex", name: "Globex", role: "member" };
const BOUND = { id: "bound", serverId: "s1", name: "vendor-sync", type: "private", joined: true, createdAt: "2026-10-01T00:00:00.000Z" };

function signInAsGuest({ desktop, channels = [BOUND] }: { desktop: boolean; channels?: unknown[] }) {
  window.matchMedia = ((media: string) => ({
    // A 390px phone: every max-width query matches, no min-width one does. Desktop: the reverse.
    matches: desktop ? !media.includes("max-width") : media.includes("max-width"), media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  // A Guest reads no other conversation: the server answers 403 for it.
  const pending = () => new Promise(() => {});
  const get = (url: string) => ["/channels/other", "/channels/d1", "/channels/archived"].includes(url)
    ? Promise.reject(Object.assign(new Error("forbidden"), { response: { status: 403 } }))
    : pending();
  Object.assign(api, { get, post: pending, put: pending, patch: pending, delete: pending });
  useAuthStore.setState({ user: { id: "gina", name: "Gina", email: "gina@example.com" } as User, initialized: true, loading: false } as never);
  useServerStore.setState({ current: GUEST_SERVER as never, servers: [GUEST_SERVER, OTHER_SERVER] as never, members: [] as never });
  useChannelStore.setState({ channels: channels as never, dmChannels: [] as never, loading: false, dmsLoading: false } as never);
}

function renderMainLayout(entry: string) {
  window.history.replaceState(null, "", entry);
  return render(
    <BrowserRouter>
      <TestIntlProvider>
        <AppThemeProvider>
          <Routes>
            <Route path="/s/:slug/*" element={<MainLayout />} />
          </Routes>
        </AppThemeProvider>
      </TestIntlProvider>
    </BrowserRouter>,
  );
}

/** A Back at the top on a phone: an ArrowLeft action (raft-ui's PanelHeader) or a `*-mobile-back` control. */
function phoneBackControls(): Element[] {
  const byIcon = Array.from(document.querySelectorAll("button svg.lucide-arrow-left")).map((svg) => svg.closest("button")!);
  const byTestId = Array.from(document.querySelectorAll("[data-testid$=mobile-back]"));
  return Array.from(new Set([...byIcon, ...byTestId])).filter((el) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.classList.contains("hidden") || node.classList.contains("max-md:hidden")) return false;
    }
    return true;
  });
}

test("a Guest on a phone lands in its channel with the tab bar and no Back, and reaches Settings and its other servers", async () => {
  signInAsGuest({ desktop: false });
  renderMainLayout(BASE);
  await waitFor(() => assert.equal(window.location.pathname, `${BASE}/channel/bound`));
  await waitFor(() => assert.ok(screen.queryByTestId("mobile-tab-bar") !== null));
  // Its Home: no Back (it only led back into this channel).
  assert.equal(phoneBackControls().length, 0);

  // The server tab: the other servers to switch to, and Settings (its account and Sign out).
  fireEvent.click(screen.getByTestId("mobile-tab-server"));
  const popover = await screen.findByTestId("mobile-server-tab-popover");
  const servers = Array.from(popover.querySelectorAll("[data-testid=mobile-server-tab-server]")).map((row) => row.getAttribute("data-server-id"));
  assert.deepEqual(servers.sort(), ["s1", "s2"]);
  fireEvent.click(screen.getByTestId("mobile-server-tab-settings"));
  await waitFor(() => assert.equal(window.location.pathname, `${BASE}/settings`));
  // Its Settings list › Account: Sign out.
  const account = (await screen.findByText("Account", undefined, { timeout: 4000 })).closest("a, button");
  assert.ok(account !== null, "the Account row");
  fireEvent.click(account);
  await waitFor(() => assert.equal(window.location.pathname, `${BASE}/settings/account`));
  await screen.findByTestId("account-logout", undefined, { timeout: 4000 });

  // And the server tab switches to another server.
  window.history.pushState(null, "", `${BASE}/channel/bound`);
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  fireEvent.click(await screen.findByTestId("mobile-tab-server"));
  const other = (await screen.findByTestId("mobile-server-tab-popover")).querySelector("[data-testid=mobile-server-tab-server][data-server-id=s2]");
  assert.ok(other !== null, "the Globex row");
  // The switch replaces the URL with Globex's (its Home). ServerResolver, not
  // mounted here, would make Globex current from it; without it this layout
  // still has Acme current and sends the root on to its channel.
  const replaced = vi.spyOn(window.history, "replaceState");
  fireEvent.click(other);
  assert.equal(replaced.mock.calls[0]?.[2], "/s/globex");
  replaced.mockRestore();
});

test("a Guest on a phone: a Tasks / Files card or an Artifact over its channel has Back and covers the tab bar", async () => {
  setServerFeatureFlagForTests("s1", TASK_V2_CONVERSATIONS_FLAG_KEY, true);
  setServerFeatureFlagForTests("s1", WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const covers: Array<{ name: string; open: () => void; close: () => void; query?: string }> = [
    // Left open on a visit before (the store remembers it).
    { name: "Tasks card", open: () => useChannelSideCardStore.getState().setCardOpen("tasks", true), close: () => useChannelSideCardStore.getState().setCardOpen("tasks", false) },
    { name: "Files card", open: () => useChannelSideCardStore.getState().setCardOpen("files", true), close: () => useChannelSideCardStore.getState().setCardOpen("files", false) },
    // The side card is the channel's address (`?artifact=`, #proj-workspace:#240): a reload or a link opens it.
    {
      name: "Artifact",
      open: () => {},
      close: () => useArtifactViewerStore.getState().close(),
      query: `?artifact=${asArtifactId("pt_fake-launch-plan")}`,
    },
  ];
  for (const cover of covers) {
    signInAsGuest({ desktop: false });
    cover.open();
    renderMainLayout(`${BASE}/channel/bound${cover.query ?? ""}`);
    await waitFor(() => assert.equal(phoneBackControls().length, 1, `${cover.name}: one Back`));
    assert.ok(screen.queryByTestId("mobile-tab-bar") === null, `${cover.name}: no tab bar beside Back`);
    // Back closes it: the Home page again, the bar and no Back.
    fireEvent.click(phoneBackControls()[0]);
    await waitFor(() => assert.ok(screen.queryByTestId("mobile-tab-bar") !== null, `${cover.name}: the bar again`));
    assert.equal(phoneBackControls().length, 0, `${cover.name}: no Back on Home`);
    assert.equal(new URLSearchParams(window.location.search).has("artifact"), false, `${cover.name}: its address went with it`);
    cover.close();
    cleanup();
  }
});

test("a Guest on a phone reaches the other tabs from its channel", async () => {
  signInAsGuest({ desktop: false });
  renderMainLayout(`${BASE}/channel/bound`);
  const bar = await screen.findByTestId("mobile-tab-bar");
  const tasks = Array.from(bar.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Tasks");
  assert.ok(tasks !== undefined, "the Tasks tab");
  fireEvent.click(tasks);
  await waitFor(() => assert.equal(window.location.pathname, `${BASE}/tasks`));
});

test("a Guest opening a channel or DM it can't read goes to its own channel, not \"Select a channel\"", async () => {
  for (const path of ["/channel/other", "/dm/d1"]) {
    signInAsGuest({ desktop: true });
    renderMainLayout(`${BASE}${path}`);
    await waitFor(() => assert.equal(window.location.pathname, `${BASE}/channel/bound`), { timeout: 4000 });
    assert.ok(screen.queryByTestId("chat-no-channel") === null, `no "Select a channel" after ${path}`);
    cleanup();
  }
});

test("a Guest with no channel it can read is told so, with the way to Settings, on desktop and on a phone", async () => {
  for (const desktop of [true, false]) {
    signInAsGuest({ desktop, channels: [] });
    renderMainLayout(`${BASE}/channel/archived`);
    // The channel can't be read, so the server's root, which has none to open.
    const empty = await screen.findByTestId("guest-no-channel", undefined, { timeout: 4000 });
    assert.equal(window.location.pathname, BASE);
    assert.match(empty.textContent ?? "", /You don't have access to any channel in Acme/);
    // The title and Open Settings carry it: no "When you're added… it opens here" line (HelperText step 1).
    assert.ok(!(empty.textContent ?? "").includes("it opens here"), empty.textContent ?? "");
    assert.ok(screen.queryByTestId("chat-no-channel") === null, "no \"Select a channel\"");
    // A phone keeps the tab bar (the server tab) under it.
    if (!desktop) assert.ok(screen.queryByTestId("mobile-tab-bar") !== null);
    fireEvent.click(screen.getByTestId("guest-no-channel-settings"));
    await waitFor(() => assert.equal(window.location.pathname, `${BASE}/settings`));
    cleanup();
  }
});

test("behind the desktop ⌘K overlay, a Guest with a channel is not told it has none", async () => {
  signInAsGuest({ desktop: true });
  window.history.replaceState({ usr: { suppressDefaultRouteRedirect: true }, key: "k", idx: 0 }, "", BASE);
  render(<TestIntlProvider><BrowserRouter><DefaultRoute /></BrowserRouter></TestIntlProvider>);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(window.location.pathname, BASE, "the overlay keeps its background");
  assert.ok(screen.queryByTestId("guest-no-channel") === null, "no \"You don't have access to any channel\"");
  cleanup();
  // With none it can read, the empty state.
  signInAsGuest({ desktop: true, channels: [] });
  window.history.replaceState({ usr: { suppressDefaultRouteRedirect: true }, key: "k", idx: 0 }, "", BASE);
  render(<TestIntlProvider><BrowserRouter><DefaultRoute /></BrowserRouter></TestIntlProvider>);
  assert.ok((await screen.findByTestId("guest-no-channel")) !== null);
});

test("a Guest on a conversation's own search it can't read goes to its own channel", async () => {
  for (const path of ["/channel/other/search", "/dm/d1/search"]) {
    signInAsGuest({ desktop: true });
    renderMainLayout(`${BASE}${path}`);
    await waitFor(() => assert.equal(window.location.pathname, `${BASE}/channel/bound`), { timeout: 4000 });
    cleanup();
  }
  // Its own channel's search stays.
  signInAsGuest({ desktop: true });
  renderMainLayout(`${BASE}/channel/bound/search`);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(window.location.pathname, `${BASE}/channel/bound/search`);
});

test("removed from its open channel, a Guest's button opens Settings, not \"Back to channels\"", async () => {
  const { ChannelAccessLost } = await import("../src/features/channel/ChannelAccessLost");
  for (const role of ["guest", "member"] as const) {
    useServerStore.setState({ current: { ...GUEST_SERVER, role } as never });
    window.history.replaceState(null, "", `${BASE}/channel/bound`);
    render(<TestIntlProvider><BrowserRouter><ChannelAccessLost /></BrowserRouter></TestIntlProvider>);
    const button = screen.getByTestId("channel-access-lost-back");
    assert.equal(button.textContent, role === "guest" ? "Open Settings" : "Back to channels", role);
    fireEvent.click(button);
    assert.equal(window.location.pathname, role === "guest" ? `${BASE}/settings` : BASE, role);
    cleanup();
  }
});

function RailChat() {
  const { selectRailMode } = useRailMode();
  return <button data-testid="rail-chat" onClick={() => selectRailMode("chat")}>Chat</button>;
}

test("the rail's Chat takes a Guest to the server's root (its channel), not a remembered conversation", () => {
  for (const role of ["guest", "member"] as const) {
    useServerStore.setState({ current: { ...GUEST_SERVER, role } as never });
    // Remembered from before (a channel it was in as a member, a DM).
    localStorage.setItem("slock:tabMemory:v2:acme:chat", `${BASE}/dm/d1`);
    window.history.replaceState(null, "", `${BASE}/activity`);
    render(<BrowserRouter><RailChat /></BrowserRouter>);
    fireEvent.click(screen.getByTestId("rail-chat"));
    assert.equal(window.location.pathname, role === "guest" ? BASE : `${BASE}/dm/d1`, role);
    cleanup();
  }
});
