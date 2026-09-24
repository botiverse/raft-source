import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import ServerSwitcherMenu from "../src/components/ui/ServerSwitcherMenu";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { getChannelUnreadIndicatorState, hasUnmutedUnread, shouldShowActivityMutedIcon } from "../src/utils/channelUnreadIndicator";
import {
  hasOtherServerLoudUnread,
  parseServerUnreadSummaryRows,
} from "../src/utils/serverUnreadSummary";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => {
  const text = readFileSync(resolve(repoRoot, path), "utf8");
  if (!text.startsWith("// @ts-nocheck\n") && !text.includes("function stryNS_")) return text;
  return execFileSync("git", ["show", `HEAD:packages/web/${path}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
};

const currentServer: Server = {
  id: "server-alpha",
  name: "Alpha",
  avatarUrl: null,
  slug: "alpha",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-05-14T00:00:00.000Z",
};

const targetServer: Server = {
  ...currentServer,
  id: "server-beta",
  name: "Beta",
  slug: "beta",
};
type JoinCommunityServer = ReturnType<typeof useServerStore.getState>["joinCommunityServer"];

function renderMenu({
  onClose = () => {},
  testId,
  navigationMode,
  unreadCounts = {},
  joinCommunityServer = async () => currentServer,
}: {
  onClose?: () => void;
  testId?: string;
  navigationMode?: "restore-surface" | "replace-with-home";
  unreadCounts?: Record<string, {
    unreadCount: number;
    serverPushMuted?: boolean;
    activityUnreadCount?: number;
  }>;
  joinCommunityServer?: JoinCommunityServer;
} = {}) {
  useServerStore.setState({
    current: currentServer,
    servers: [currentServer, targetServer],
    members: [],
    loading: false,
    updateServerOrder: async () => {},
    joinCommunityServer,
  } as never);
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/s/alpha"] },
      createElement(
        TestIntlProvider,
        null,
        createElement(ServerSwitcherMenu, {
          open: true,
          onClose,
          testId,
          navigationMode,
          serverUnreadCounts: unreadCounts,
        }),
        createElement(LocationProbe),
      ),
    ),
  );
}

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location-probe" }, location.pathname + location.search);
}

function setBrowserLanguages(languages: string[]) {
  Object.defineProperty(window.navigator, "languages", {
    configurable: true,
    value: languages,
  });
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: languages[0] ?? "en-US",
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  setBrowserLanguages(["en-US"]);
  useServerStore.setState({ current: null, servers: [], members: [] } as never);
});

// `ServerSwitcherMenu` is the single primitive for the "switch server"
// dropdown. The desktop LeftRail flyout and the mobile Sidebar pill
// drop-down used to inline 70+ identical lines each and drifted on the
// "current server row also shows its own unread badge" detail (LeftRail
// did, Sidebar didn't). The primitive collapses both into one and pins
// the canonical "current row hides unread" rule per stdrc decision C
// 2026-05-14 `#proj-uiux:24e533e3` task #234.

test("ServerSwitcherMenu primitive exists and exports the expected shape", () => {
  let closes = 0;
  renderMenu({ onClose: () => { closes += 1; } });

  assert.ok(screen.getByTestId("server-switcher-menu"));
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.mouseDown(document.body);
  assert.equal(closes, 2, "the primitive owns Escape and outside-click dismissal");
});

test("current server row hides its own unread badge (stdrc decision C)", () => {
  renderMenu({
    unreadCounts: {
      "server-alpha": { unreadCount: 7, activityUnreadCount: 7 },
      "server-beta": { unreadCount: 3, activityUnreadCount: 3 },
    },
  });

  const alpha = screen.getByRole("link", { name: /Alpha/ });
  const beta = screen.getByRole("link", { name: /Beta/ });
  assert.equal(within(alpha).queryByText("7"), null, "current server's own unread badge stays hidden");
  assert.ok(within(beta).getByText("3"), "other servers still show their unread count");
});

test("server switcher unread count is loud unless the server is muted", () => {
  renderMenu({
    unreadCounts: {
      "server-beta": { unreadCount: 5, activityUnreadCount: 5 },
    },
  });
  const loud = within(screen.getByRole("link", { name: /Beta/ })).getByText("5");
  assert.match(loud.className, /text-white/);
  assert.doesNotMatch(loud.className, /text-black\/50/);
  cleanup();

  renderMenu({
    unreadCounts: {
      "server-beta": { unreadCount: 5, serverPushMuted: true, activityUnreadCount: 5 },
    },
  });
  const quiet = within(screen.getByRole("link", { name: /Beta/ })).getByText("5");
  assert.match(quiet.className, /text-black\/50/);
  assert.doesNotMatch(quiet.className, /text-white/);
});

test("muted servers keep numeric counts but do not light cross-server attention dots", () => {
  const summaries = parseServerUnreadSummaryRows([
    { serverId: "server-alpha", unreadCount: 10, serverPushMuted: false, activityUnreadCount: 10 },
    { serverId: "server-beta", unreadCount: 6, serverPushMuted: true, activityUnreadCount: 6 },
    { serverId: "server-gamma", unreadCount: 4, serverPushMuted: false, activityUnreadCount: 4 },
  ]);

  assert.equal(summaries["server-beta"].serverPushMuted, true);
  assert.equal(
    hasOtherServerLoudUnread(
      [{ id: "server-alpha" }, { id: "server-beta" }],
      { id: "server-alpha" },
      summaries,
    ),
    false,
    "muted unread on another server stays numeric-only, not a cross-server attention dot",
  );
  assert.equal(
    hasOtherServerLoudUnread(
      [{ id: "server-alpha" }, { id: "server-gamma" }],
      { id: "server-alpha" },
      summaries,
    ),
    true,
    "unmuted unread on another server still lights cross-server attention",
  );
});

test("Activity counts are independent of server notification mute state", () => {
  const leftRail = read("src/components/layout/LeftRail.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");
  const parser = read("src/utils/serverUnreadSummary.ts");

  assert.match(parser, /serverPushMuted: entry\.serverPushMuted === true/);
  assert.match(parser, /activityUnreadCount/);
  assert.match(leftRail, /hasOtherServerActivityUnread\(servers, server, serverUnreadCounts\)/);
  assert.match(sidebar, /hasOtherServerActivityUnread\(servers, server, serverUnreadCounts\)/);
});

test("muted joined channels still show quiet numeric unread counts", () => {
  assert.deepEqual(
    getChannelUnreadIndicatorState({ unread: 3, joined: true, showMutedIcon: false }),
    { showLoudUnreadBadge: true, showQuietUnreadCount: false },
  );
  assert.deepEqual(
    getChannelUnreadIndicatorState({ unread: 3, joined: true, showMutedIcon: true }),
    { showLoudUnreadBadge: false, showQuietUnreadCount: true },
  );
  assert.deepEqual(
    getChannelUnreadIndicatorState({ unread: 3, joined: false, showMutedIcon: false }),
    { showLoudUnreadBadge: false, showQuietUnreadCount: true },
  );
  assert.deepEqual(
    getChannelUnreadIndicatorState({ unread: 0, joined: true, showMutedIcon: true }),
    { showLoudUnreadBadge: false, showQuietUnreadCount: false },
  );
  assert.equal(shouldShowActivityMutedIcon({ activityMuted: true, joined: true }), true);
  assert.equal(shouldShowActivityMutedIcon({ activityMuted: true, joined: false }), false);
  assert.equal(shouldShowActivityMutedIcon({ activityMuted: false, joined: true }), false);
});

test("sidebar section attention ignores muted unread and preserves ordinary and mixed unread", () => {
  const ordinary = { id: "ordinary", activityMuted: false };
  const mutedOne = { id: "muted-one", activityMuted: true };
  const mutedTwo = { id: "muted-two", activityMuted: true };

  assert.equal(
    hasUnmutedUnread({ ordinary: 2 }, [ordinary]),
    true,
    "ordinary unread must light its section",
  );
  assert.equal(
    hasUnmutedUnread({ "muted-one": 2, "muted-two": 1 }, [mutedOne, mutedTwo]),
    false,
    "a section whose unread chats are all muted must stay quiet",
  );
  assert.equal(
    hasUnmutedUnread({ ordinary: 1, "muted-one": 3 }, [mutedOne, ordinary]),
    true,
    "one unmuted unread chat must still light a mixed section",
  );
});

test("server switcher primitive renders a sortable handle for every server row", () => {
  renderMenu();

  assert.ok(screen.getByRole("button", { name: "Reorder Alpha" }));
  assert.ok(screen.getByRole("button", { name: "Reorder Beta" }));
});

test("server switcher primitive honors desktop and mobile navigation modes", () => {
  localStorage.setItem("slock:serverSurface:v1:beta", "/s/beta/tasks");
  const { rerender } = renderMenu({ testId: "desktop-server-switcher-menu" });
  assert.ok(screen.getByTestId("desktop-server-switcher-menu"));
  assert.equal(screen.getByRole("link", { name: /Beta/ }).getAttribute("href"), "/s/beta/tasks");
  assert.ok(screen.getByText("Switch or Create Server"));

  rerender(
    createElement(
      MemoryRouter,
      { initialEntries: ["/s/alpha"] },
      createElement(
        TestIntlProvider,
        null,
        createElement(ServerSwitcherMenu, {
          open: true,
          onClose: () => {},
          testId: "mobile-server-switcher-menu",
          navigationMode: "replace-with-home",
          serverUnreadCounts: {},
        }),
      ),
    ),
  );
  assert.ok(screen.getByTestId("mobile-server-switcher-menu"));
  assert.equal(
    screen.getByRole("link", { name: /Beta/ }).getAttribute("href"),
    "/s/beta",
    "mobile server switches must land at the selected server Home and replace the previous server entry",
  );
});

test("server switcher primitive renders the shared footer actions", () => {
  renderMenu();

  assert.ok(screen.getByRole("button", { name: "Join Community" }));
  assert.equal(screen.queryByRole("button", { name: "Join Chinese Community" }), null);
  assert.ok(screen.getByRole("button", { name: "Switch or Create Server" }));
});

test("Chinese browser language does not add the QR-page action to the server switcher", async () => {
  setBrowserLanguages(["zh-CN", "en-US"]);
  const joinCalls: Array<{ slug?: string }> = [];
  let closes = 0;
  renderMenu({
    onClose: () => { closes += 1; },
    joinCommunityServer: async (options = {}) => {
      joinCalls.push(options);
      return currentServer;
    },
  });

  assert.equal(screen.queryByRole("button", { name: "Join Chinese Community" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Join Community" }));

  await waitFor(() => {
    assert.equal(joinCalls.length, 1);
  });
  assert.equal(closes, 1);
  assert.equal(joinCalls[0]?.slug, "community");
});
