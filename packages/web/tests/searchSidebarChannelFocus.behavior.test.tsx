import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar";
import { __testInternals } from "../src/components/layout/MainLayout";
import {
  sidebarCollapsedSectionStorageKey,
  writeSidebarCollapsedSection,
} from "../src/components/layout/sidebarCollapsedSections";
import {
  buildSidebarChannelFocusState,
  buildSidebarDisclosureRestoreState,
} from "../src/components/layout/sidebarChannelFocus";
import MessageSearchPage from "../src/components/search/MessageSearchPage";
import { useAppNavigate } from "../src/hooks/useAppNavigate";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import { useSearchContentStore } from "../src/store/searchContentStore";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { useUIStore } from "../src/store/uiStore";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";
import { TestIntlProvider } from "./helpers/intl";

const TARGET_CHANNEL_ID = "channel-target";
const OTHER_CHANNEL_ID = "channel-other";
const originalApiGet = api.get;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const originalWindowRequestAnimationFrame = window.requestAnimationFrame;
const originalWindowCancelAnimationFrame = window.cancelAnimationFrame;
const originalMatchMedia = window.matchMedia;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

type ScrollCall = {
  element: HTMLElement;
  options: ScrollToOptions | number | undefined;
};

let scrollCalls: ScrollCall[] = [];
let nextAnimationFrameId = 1;
let pendingAnimationFrames = new Map<number, FrameRequestCallback>();

function makeChannel(id: string, name: string) {
  return {
    id,
    serverId: "server-1",
    name,
    description: null,
    type: "public" as const,
    createdAt: "2026-07-25T00:00:00.000Z",
    archivedAt: null,
    joined: true,
  };
}

function makeDmChannel(id: string, peerId: string, displayName: string) {
  return {
    id,
    serverId: "server-1",
    name: displayName,
    description: null,
    type: "dm" as const,
    createdAt: "2026-07-25T00:00:00.000Z",
    peerType: "user" as const,
    peerId,
    peerName: displayName.toLowerCase().replaceAll(" ", "-"),
    peerDisplayName: displayName,
    peerDescription: null,
    peerGravatarHash: null,
    peerAvatarUrl: null,
  };
}

function installDomGeometry() {
  scrollCalls = [];
  nextAnimationFrameId = 1;
  pendingAnimationFrames = new Map();
  const requestFrame = ((callback: FrameRequestCallback) => {
    const frameId = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    pendingAnimationFrames.set(frameId, callback);
    return frameId;
  }) as typeof requestAnimationFrame;
  const cancelFrame = ((handle: number) => {
    pendingAnimationFrames.delete(handle);
  }) as typeof cancelAnimationFrame;
  globalThis.requestAnimationFrame = requestFrame;
  globalThis.cancelAnimationFrame = cancelFrame;
  window.requestAnimationFrame = requestFrame;
  window.cancelAnimationFrame = cancelFrame;
  HTMLElement.prototype.scrollTo = function scrollTo(
    options?: ScrollToOptions | number,
  ) {
    scrollCalls.push({ element: this, options });
  };
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const channelId = this.dataset.sidebarChannelId;
    if (channelId === TARGET_CHANNEL_ID) {
      return {
        bottom: 340,
        height: 40,
        left: 0,
        right: 200,
        top: 300,
        width: 200,
        x: 0,
        y: 300,
        toJSON: () => ({}),
      };
    }
    if (channelId === OTHER_CHANNEL_ID) {
      return {
        bottom: 140,
        height: 40,
        left: 0,
        right: 200,
        top: 100,
        width: 200,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      };
    }
    return {
      bottom: 220,
      height: 200,
      left: 0,
      right: 200,
      top: 20,
      width: 200,
      x: 0,
      y: 20,
      toJSON: () => ({}),
    };
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.classList.contains("overflow-y-auto") ? 200 : 0;
    },
  });
}

async function flushAnimationFramesUntilIdle() {
  let consecutiveIdleTurns = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    const callbacks = Array.from(pendingAnimationFrames.values());
    pendingAnimationFrames.clear();
    if (callbacks.length === 0) {
      consecutiveIdleTurns += 1;
      if (consecutiveIdleTurns >= 2) return;
      continue;
    }
    consecutiveIdleTurns = 0;
    await act(async () => {
      for (const callback of callbacks) callback(performance.now());
    });
  }
  assert.fail("requestAnimationFrame queue did not settle");
}

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return {
        data: {
          items: [],
          hasMore: false,
          totalCount: 0,
          totalUnreadCount: 0,
        },
      };
    }
    if (url === "/servers/unread-summary") return { data: [] };
    if (url.includes("/search")) {
      return { data: { hasMore: false, results: [] } };
    }
    return { data: [] };
  }) as typeof api.get;
}

function seedStores() {
  installApiStub();
  localStorage.clear();
  localStorage.setItem("slock_access_token", "token");
  writeSidebarCollapsedSection("user-1", "channels", true, localStorage);

  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      gravatarHash: "",
      name: "owner",
      displayName: "Owner",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "original",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "pro",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-25T00:00:00.000Z",
    },
    servers: [],
    members: [],
    loading: false,
    sidebarOrder: {
      ...DEFAULT_SIDEBAR_ORDER,
      channelOrder: [OTHER_CHANNEL_ID, TARGET_CHANNEL_ID],
    },
  } as never);
  useChannelStore.setState({
    channels: [
      makeChannel(OTHER_CHANNEL_ID, "other-room"),
      makeChannel(TARGET_CHANNEL_ID, "target-room"),
    ],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  } as never);
  useMessageStore.setState({
    unreadCounts: {},
    mentionFlags: {},
    drafts: {},
    clearUnread: () => {},
    markRead: async () => {},
  } as never);
  useAgentStore.setState({ agents: [], agentActivities: {}, loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useInboxStore.setState({
    totalCount: 0,
    activeUnreadCount: 0,
    totalUnreadCount: 0,
    loadInbox: async () => {},
  } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), total: 0 } as never);
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
  });
  useUIStore.setState({ sidebarOpen: true });
  useWorkspaceGridNavigationStore.setState({
    active: false,
    enabled: false,
    railMode: null,
  });
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output
      data-testid="location-probe"
      data-pathname={location.pathname}
      data-state={JSON.stringify(location.state)}
    />
  );
}

function RouteWriter() {
  const navigate = useNavigate();
  const nav = useAppNavigate();
  return (
    <>
      <button type="button" onClick={() => nav.toDm("dm-target")}>route-dm</button>
      <button
        type="button"
        onClick={() => navigate(`/s/server/channel/${TARGET_CHANNEL_ID}`)}
      >
        route-without-state
      </button>
      <button
        type="button"
        onClick={() => navigate(
          `/s/server/channel/${TARGET_CHANNEL_ID}`,
          { state: buildSidebarDisclosureRestoreState() },
        )}
      >
        route-from-chat-root
      </button>
      <button
        type="button"
        onClick={() => navigate(
          `/s/server/channel/${TARGET_CHANNEL_ID}`,
          { state: buildSidebarChannelFocusState(OTHER_CHANNEL_ID) },
        )}
      >
        route-mismatch
      </button>
    </>
  );
}

function renderRouteSurface({
  includeSearch = false,
  includeRouteWriter = false,
  initialEntry = "/s/server/search?q=target",
}: {
  includeSearch?: boolean;
  includeRouteWriter?: boolean;
  initialEntry?: string;
} = {}) {
  const router = createMemoryRouter([
    {
      path: "*",
      element: (
        <TestIntlProvider>
          <Sidebar />
          {includeSearch ? <MessageSearchPage /> : null}
          {includeRouteWriter ? <RouteWriter /> : null}
          <LocationProbe />
        </TestIntlProvider>
      ),
    },
  ], {
    initialEntries: [initialEntry],
  });
  render(<RouterProvider router={router} />);
  return router;
}

function renderClassicRouteSurface(initialEntry: string) {
  const router = createMemoryRouter([
    {
      path: "*",
      element: (
        <TestIntlProvider>
          <Sidebar />
          <Routes>
            <Route path="/s/server" element={<__testInternals.DefaultRoute />} />
            <Route path="*" element={<div data-testid="classic-route-placeholder" />} />
          </Routes>
          <LocationProbe />
        </TestIntlProvider>
      ),
    },
  ], { initialEntries: [initialEntry] });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  api.get = originalApiGet;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  window.requestAnimationFrame = originalWindowRequestAnimationFrame;
  window.cancelAnimationFrame = originalWindowCancelAnimationFrame;
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia;
  } else {
    delete (window as Partial<Window>).matchMedia;
  }
  HTMLElement.prototype.scrollTo = originalScrollTo;
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).clientHeight;
  }
  cleanup();
  localStorage.clear();
});

test("an active channel route does not override the remembered collapsed section on first render", async () => {
  seedStores();
  renderRouteSurface({ initialEntry: `/s/server/channel/${TARGET_CHANNEL_ID}` });

  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  const sectionToggle = screen.getByTestId("sidebar-section-toggle-channels");
  assert.equal(sectionToggle.getAttribute("aria-expanded"), "false");
  assert.equal(
    document.querySelector("[data-sidebar-channel-id]"),
    null,
    "restoring the active route must not silently discard the user's collapsed preference",
  );
});

test("every Chat section remembers only the active user's explicit disclosure choice", () => {
  seedStores();
  renderRouteSurface();

  fireEvent.click(screen.getByTestId("sidebar-section-toggle-pinned"));
  fireEvent.click(screen.getByTestId("sidebar-section-toggle-joint-channels"));
  fireEvent.click(screen.getByTestId("sidebar-section-toggle-channels"));
  fireEvent.click(screen.getByTestId("sidebar-section-toggle-dms"));

  assert.equal(localStorage.getItem(sidebarCollapsedSectionStorageKey("user-1", "pinned")), "true");
  assert.equal(localStorage.getItem(sidebarCollapsedSectionStorageKey("user-1", "jointChannels")), "true");
  assert.equal(localStorage.getItem(sidebarCollapsedSectionStorageKey("user-1", "channels")), "false");
  assert.equal(localStorage.getItem(sidebarCollapsedSectionStorageKey("user-1", "agents")), "true");

  cleanup();
  renderRouteSurface();

  assert.equal(screen.getByTestId("sidebar-section-toggle-pinned").getAttribute("aria-expanded"), "false");
  assert.equal(screen.getByTestId("sidebar-section-toggle-joint-channels").getAttribute("aria-expanded"), "false");
  assert.equal(screen.getByTestId("sidebar-section-toggle-channels").getAttribute("aria-expanded"), "true");
  assert.equal(screen.getByTestId("sidebar-section-toggle-dms").getAttribute("aria-expanded"), "false");
});

test("the desktop Chat root redirect preserves the remembered collapsed section", async () => {
  seedStores();
  renderRouteSurface({ includeRouteWriter: true });

  fireEvent.click(screen.getByRole("button", { name: "route-from-chat-root" }));

  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location-probe").getAttribute("data-pathname"),
      `/s/server/channel/${TARGET_CHANNEL_ID}`,
    );
    assert.equal(
      screen.getByTestId("sidebar-section-toggle-channels").getAttribute("aria-expanded"),
      "false",
    );
  });
  assert.equal(
    localStorage.getItem(sidebarCollapsedSectionStorageKey("user-1", "channels")),
    "true",
  );
});

test("the mounted desktop Chat root redirect preserves the remembered collapsed section", async () => {
  seedStores();
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 768px)",
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  const DefaultRoute = __testInternals.DefaultRoute;
  try {
    render(
      <MemoryRouter initialEntries={["/s/server"]}>
        <DefaultRoute />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => {
      assert.equal(
        screen.getByTestId("location-probe").getAttribute("data-pathname"),
        `/s/server/channel/${OTHER_CHANNEL_ID}`,
      );
      assert.equal(
        screen.getByTestId("location-probe").getAttribute("data-state"),
        JSON.stringify(buildSidebarDisclosureRestoreState()),
      );
    });
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

test("classic sidebar toggles the active channel and DM back to an empty server root", async () => {
  seedStores();
  const dm = makeDmChannel("dm-target", "user-2", "Design Friend");
  useChannelStore.setState({ dmChannels: [dm] });
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 768px)",
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  renderClassicRouteSurface(`/s/server/channel/${TARGET_CHANNEL_ID}`);

  fireEvent.click(screen.getByTestId("sidebar-section-toggle-channels"));
  const channelRow = () => document.querySelector<HTMLButtonElement>(
    `[data-sidebar-channel-id="${TARGET_CHANNEL_ID}"]`,
  );
  // The row is intentionally selected by its stable data attribute rather than
  // the route's visual class: this verifies the actual sidebar click contract.
  assert.ok(channelRow());
  fireEvent.click(channelRow()!);

  await waitFor(() => {
    assert.equal(screen.getByTestId("location-probe").getAttribute("data-pathname"), "/s/server");
    assert.equal(
      screen.getByTestId("location-probe").getAttribute("data-state"),
      JSON.stringify({ suppressDefaultRouteRedirect: true }),
    );
    assert.ok(screen.getByText("Select a channel"));
  });

  assert.ok(channelRow());
  fireEvent.click(channelRow()!);
  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location-probe").getAttribute("data-pathname"),
      `/s/server/channel/${TARGET_CHANNEL_ID}`,
    );
    assert.equal(screen.getByTestId("location-probe").getAttribute("data-state"), "null");
  });

  const dmRow = () => document.querySelector<HTMLButtonElement>(
    '[data-sidebar-channel-id="dm-target"]',
  );
  assert.ok(dmRow());
  fireEvent.click(dmRow()!);
  await waitFor(() => {
    assert.equal(screen.getByTestId("location-probe").getAttribute("data-pathname"), "/s/server/dm/dm-target");
  });

  assert.ok(dmRow());
  fireEvent.click(dmRow()!);
  await waitFor(() => {
    assert.equal(screen.getByTestId("location-probe").getAttribute("data-pathname"), "/s/server");
    assert.equal(
      screen.getByTestId("location-probe").getAttribute("data-state"),
      JSON.stringify({ suppressDefaultRouteRedirect: true }),
    );
  });
});

test("Search Open routes through useAppNavigate, reveals the owning section, and centers only the target row once", async () => {
  installDomGeometry();
  seedStores();
  renderRouteSurface({ includeSearch: true });

  const sectionToggle = screen.getByTestId("sidebar-section-toggle-channels");
  assert.equal(sectionToggle.getAttribute("aria-expanded"), "false");
  assert.equal(
    document.querySelector("[data-sidebar-channel-id]"),
    null,
    "the collapsed section must begin with no measurable channel row",
  );

  fireEvent.contextMenu(screen.getByTestId(`search-channel-result-${TARGET_CHANNEL_ID}`));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));

  await waitFor(() => {
    assert.equal(
      screen.getByTestId("location-probe").getAttribute("data-pathname"),
      `/s/server/channel/${TARGET_CHANNEL_ID}`,
    );
    assert.equal(sectionToggle.getAttribute("aria-expanded"), "true");
    assert.ok(document.querySelector(`[data-sidebar-channel-id="${TARGET_CHANNEL_ID}"]`));
    assert.ok(document.querySelector(`[data-sidebar-channel-id="${OTHER_CHANNEL_ID}"]`));
  });
  await flushAnimationFramesUntilIdle();
  assert.equal(scrollCalls.length, 1);

  assert.equal(
    screen.getByTestId("location-probe").getAttribute("data-state"),
    JSON.stringify(buildSidebarChannelFocusState(TARGET_CHANNEL_ID)),
    "Search Open must carry the typed one-shot channel focus state",
  );
  const [scrollCall] = scrollCalls;
  assert.ok(scrollCall.element.classList.contains("overflow-y-auto"));
  assert.equal(scrollCall.element.closest("[data-testid=sidebar-root]") !== null, true);
  assert.deepEqual(scrollCall.options, { top: 200, behavior: "auto" });
  assert.equal(
    localStorage.getItem(sidebarCollapsedSectionStorageKey("user-1", "channels")),
    "true",
    "a route-owned reveal must not rewrite the user's explicit collapsed preference",
  );
});

test("Sidebar focus fails closed for DM, missing state, and route/state mismatch", async () => {
  const cases = [
    {
      buttonName: "route-dm",
      pathname: "/s/server/dm/dm-target",
      state: null,
      expectExpandedRows: false,
    },
    {
      buttonName: "route-without-state",
      pathname: `/s/server/channel/${TARGET_CHANNEL_ID}`,
      state: null,
      expectExpandedRows: false,
    },
    {
      buttonName: "route-mismatch",
      pathname: `/s/server/channel/${TARGET_CHANNEL_ID}`,
      state: buildSidebarChannelFocusState(OTHER_CHANNEL_ID),
      expectExpandedRows: true,
    },
  ] as const;

  for (const {
    buttonName,
    pathname,
    state,
    expectExpandedRows,
  } of cases) {
    installDomGeometry();
    seedStores();
    renderRouteSurface({ includeRouteWriter: true });

    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    const sectionToggle = screen.getByTestId("sidebar-section-toggle-channels");
    await waitFor(() => {
      const locationProbe = screen.getByTestId("location-probe");
      assert.equal(locationProbe.getAttribute("data-pathname"), pathname);
      assert.equal(locationProbe.getAttribute("data-state"), JSON.stringify(state));
      if (expectExpandedRows) {
        assert.equal(sectionToggle.getAttribute("aria-expanded"), "true");
        assert.ok(document.querySelector(
          `[data-sidebar-channel-id="${TARGET_CHANNEL_ID}"]`,
        ));
        assert.ok(document.querySelector(
          `[data-sidebar-channel-id="${OTHER_CHANNEL_ID}"]`,
        ));
      }
    });
    await flushAnimationFramesUntilIdle();
    assert.equal(scrollCalls.length, 0, `${buttonName} must not scroll the Sidebar`);

    cleanup();
  }
});
