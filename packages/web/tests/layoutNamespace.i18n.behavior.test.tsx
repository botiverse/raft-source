import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { MobileTabBar } from "../src/components/layout/MainLayout";
import NotificationTrigger from "../src/components/layout/NotificationTrigger";
import Sidebar from "../src/components/layout/Sidebar";
import ServerSetupHandoffStep from "../src/components/onboarding/ServerSetupHandoffStep";
import { TestIntlProvider } from "./helpers/intl";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";

// layout namespace (react-intl migration acceptance): the app-chrome copy
// finalized by @AngLee on 2026-07-22 (notes/i18n-layout-zh-final.md) must
// actually reach the DOM in Chinese when the active display locale is zh-cn.
//
// Sibling of settingsSubBatchA.i18n.behavior.test.tsx, but the teeth here are
// spread across ALL FIVE production call-site families the layout catalog owns —
// one file per family, because a single component rendering Chinese proves
// nothing about the other four:
//
//   1. LeftRail.tsx           → `layout.leftRail.*`     (rail tab labels)
//   2. MainLayout.tsx         → `layout.mobileTabBar.*` (mobile bottom bar)
//   3. Sidebar.tsx            → `layout.sidebar.*`      (section headers)
//   4. Sidebar.tsx dialogs    → `layout.sidebar.archiveChannel*` (PLACEHOLDER)
//   5. onboarding/ steps      → `layout.onboarding.letsGo`
//   + NotificationTrigger.tsx → `layout.notifications.*` (PLACEHOLDER)
//
// The two placeholder-bearing families are the ones a mechanical migration
// silently breaks: an ICU argument that is never passed renders the literal
// `{name}` / `{count}` to the user. Both are asserted twice — the seeded value
// must appear in the DOM, AND no raw `{...}` may survive.

const originalApiGet = api.get;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
}

afterEach(() => {
  api.get = originalApiGet;
  cleanup();
  localStorage.clear();
  useMessageStore.setState({ unreadCounts: {}, drafts: {}, mentionFlags: {} });
  useAgentStore.setState({ agents: [], agentActivities: {}, loading: true });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: true });
  useMachineStore.setState({ machines: [], loading: true });
  useServerStore.setState({ current: null, servers: [], members: [] });
  useAuthStore.setState({ user: null, loading: false, initialized: true });
  useWorkspaceGridNavigationStore.setState({ active: false, enabled: false, railMode: null });
});

/** A channel name no catalog string could ever contain — so finding it in the
 *  rendered dialog can only mean the ICU `{name}` argument was really passed. */
const PROBE_CHANNEL_NAME = "zh-probe-71428";

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") return { data: [] };
    return { data: [] };
  }) as typeof api.get;
}

function seedServerChrome() {
  installApiStub();
  localStorage.clear();
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
      createdAt: "2026-07-22T00:00:00.000Z",
    },
    servers: [],
    members: [],
    loading: false,
    sidebarOrder: {
      channelOrder: ["probe-channel"],
      agentOrder: [],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "manual",
      pinnedSortMode: "manual",
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
    },
  } as never);
  useChannelStore.setState({
    channels: [
      {
        id: "probe-channel",
        serverId: "server-1",
        name: PROBE_CHANNEL_NAME,
        type: "public",
        joined: true,
        archivedAt: null,
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    ],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

function renderZh(node: ReactElement, initialEntry = "/s/server") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TestIntlProvider locale="zh-cn">{node}</TestIntlProvider>
    </MemoryRouter>,
  );
}

/** No message may leak an unresolved ICU argument into the DOM. */
function assertNoRawPlaceholders(scope: HTMLElement = document.body) {
  const text = scope.textContent ?? "";
  assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, `unresolved ICU placeholder in: ${text.slice(0, 240)}`);
  for (const el of scope.querySelectorAll("[title], [aria-label], [placeholder]")) {
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      const value = el.getAttribute(attribute);
      if (value) assert.doesNotMatch(value, /\{[a-zA-Z]+\}/, `unresolved ICU placeholder in ${attribute}="${value}"`);
    }
  }
}

// Family 1 — LeftRail.tsx / `layout.leftRail.*`. The labels feed raft-ui
// Tooltip content and `aria-label`, so the accessible name IS the migrated copy.
test("LeftRail rail tabs render the finalized Chinese labels under zh-cn", () => {
  seedServerChrome();
  renderZh(<LeftRail />);

  for (const zh of ["搜索", "聊天", "动态", "任务", "成员", "计算机", "帮助", "设置"]) {
    assert.ok(screen.getByRole("button", { name: zh }), `rail tab ${zh}`);
  }
  // …and none of them may still be English.
  for (const english of ["Search", "Chat", "Activity", "Tasks", "Members", "Computers", "Help", "Settings"]) {
    assert.equal(screen.queryByRole("button", { name: english }), null, `rail tab ${english} not migrated`);
  }
  // `layout.leftRail.switchServerAria` — the placeholder family on this surface.
  // The server name is real data; it must survive interpolation into the zh copy.
  assert.ok(screen.getByRole("button", { name: "切换服务器（当前：Server）" }), "server switcher aria");
  assertNoRawPlaceholders();
});

// Family 2 — MainLayout.tsx / `layout.mobileTabBar.*`.
test("the mobile bottom tab bar renders the finalized Chinese labels under zh-cn", () => {
  seedServerChrome();
  const { container } = renderZh(<MobileTabBar />, "/s/server/settings");

  const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());
  assert.deepEqual(labels, ["主页", "任务", "成员", "设置"]);
  assertNoRawPlaceholders(container);
});

// Family 3 — Sidebar.tsx / `layout.sidebar.*` section headers + nav rows.
test("Sidebar section headers and nav rows render the finalized Chinese under zh-cn", () => {
  seedServerChrome();
  renderZh(<Sidebar mobileInline />, "/s/server");

  // Chat-tab section headers.
  assert.ok(screen.getByText("已置顶"), "pinned section header");
  assert.ok(screen.getByText("联合频道"), "joint channels section header");
  assert.ok(screen.getByText("频道"), "channels section header");
  assert.ok(screen.getByText("私信"), "direct messages section header");
  // Mobile-only Chat-tab nav rows.
  assert.ok(screen.getByText("搜索"), "search nav row");
  assert.ok(screen.getByText("动态"), "activity nav row");
  assert.ok(screen.getByText("已保存"), "saved nav row");
  // The sort control's aria-label + title (title carries a placeholder).
  const sortButton = document.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-sort-menu-button"][data-sort-section="channels"]',
  );
  assert.ok(sortButton, "channels sort control");
  assert.equal(sortButton.getAttribute("aria-label"), "对侧栏会话排序");
  assert.equal(sortButton.getAttribute("title"), "对侧栏会话排序：手动");
  // Same rail, Members tab: `layout.sidebar.agents` / `humans` / empty states.
  cleanup();
  seedServerChrome();
  renderZh(<Sidebar mobileInline />, "/s/server/members");
  assert.ok(screen.getByText("关系图"), "graph row");
  assert.ok(screen.getByText("Agent"), "agents section header");
  assert.ok(screen.getByText("暂无 Agent"), "agents empty state");
  // These two USED to be the same word, so one `getAllByText("成员") >= 2` covered
  // both. @AngLee's 2026-08-01 ruling split them — `Humans` standardised on 人类
  // when set against Agent — so they are asserted separately now. Relaxing the
  // count to >= 1 instead would have let either one silently stop rendering.
  assert.ok(screen.getByText("成员"), "mobile rail header (layout.sidebar.headerMembers)");
  assert.ok(screen.getByText("人类"), "humans section header (layout.sidebar.humans)");
  assertNoRawPlaceholders();
});

// Family 3b — Sidebar.tsx section context menu / `layout.sidebar.sectionOptionsAria`.
// This accessible name used to be built by template concatenation:
// `${formatMessage(sectionLabelId)} options`, which under zh-cn produced the
// mixed-language string "频道 options" in the real DOM. It is now a single ICU
// message with a `{section}` argument, so the zh arm can drop the space and the
// word order is owned by the catalog, not by the call site.
test("the Sidebar section context menu exposes a fully-Chinese accessible name under zh-cn", () => {
  seedServerChrome();
  renderZh(<Sidebar mobileInline />, "/s/server");

  // Open it the way a user does: right-click on the Channels section header.
  fireEvent.contextMenu(screen.getByText("频道"));

  const menu = screen.getByTestId("sidebar-section-context-menu-channels");
  assert.equal(menu.getAttribute("role"), "menu", "section context menu is a menu");
  const ariaLabel = menu.getAttribute("aria-label");
  assert.equal(ariaLabel, "频道选项");
  // No English remnant of the old concatenation may survive — neither the
  // literal word nor any Latin letter at all.
  assert.doesNotMatch(ariaLabel ?? "", /options/i, "English ' options' remnant in the accessible name");
  assert.doesNotMatch(ariaLabel ?? "", /[A-Za-z]/, "Latin-letter remnant in the accessible name");
  assertNoRawPlaceholders();
});

// Family 4 — Sidebar.tsx confirm dialogs / `layout.sidebar.archiveChannel*`.
// This is the placeholder gate: the archive message interpolates the channel
// name, so a dropped ICU argument shows the user a literal `{name}`.
test("the Sidebar archive confirm dialog renders the finalized Chinese WITH its interpolated channel name", () => {
  seedServerChrome();
  renderZh(<Sidebar mobileInline />, "/s/server");

  fireEvent.contextMenu(screen.getByText(PROBE_CHANNEL_NAME));
  // The row context menu is a portal-rendered plain div (no ARIA role), so it is
  // located by its own class contract rather than by role.
  const menu = document.querySelector<HTMLElement>("div.card-brutal.w-48");
  assert.ok(menu, "channel context menu");
  // `layout.sidebar.markAsUnread` / `pin` / `archive` all live in this menu.
  assert.ok(within(menu).getByText("标为未读"), "mark as unread action");
  assert.ok(within(menu).getByText("置顶"), "pin action");
  const archiveAction = within(menu).getByText("归档");
  fireEvent.click(archiveAction);

  // Title + confirm label = `layout.sidebar.archiveChannelTitle`; the body is
  // `layout.sidebar.archiveChannelMessage` with `{name}` filled in.
  assert.ok(screen.getAllByText("归档频道").length > 0, "archive dialog title");
  // Scoped to the dialog body (the sidebar row also carries the channel name).
  const message = screen.getByText(
    "归档“zh-probe-71428”？成员仍可查看历史消息和读取内容，但将无法写入，频道也会从侧栏中隐藏。你之后可以取消归档。",
  );
  assert.ok(message, "archive confirm body must be the AngLee-final zh with the real channel name spliced in");
  assert.match(message.textContent ?? "", new RegExp(PROBE_CHANNEL_NAME), "the {name} argument really reached the DOM");

  // The shared ConfirmDialog chrome must follow the display locale too. Migrating
  // the leaf copy (title/body/confirm) without passing chromeLocale="active" left
  // a Chinese body against an English "Cancel" — the mixed-language defect this
  // workstream exists to kill, which shipped in #5252. This asserts the chrome is
  // Chinese and the English "Cancel" is gone; it goes RED if chromeLocale="active"
  // is dropped from the archive dialog.
  const dialog = message.closest<HTMLElement>("[data-testid='confirm-dialog']") ?? document.body;
  assert.ok(within(dialog).getByText("取消"), "the Cancel chrome must render Chinese 取消 under zh");
  assert.equal(within(dialog).queryByText("Cancel"), null, "no English Cancel may leak into the zh dialog");
  assertNoRawPlaceholders();
});

// The NotificationTrigger family carries the other placeholder — a count.
test("the notification-center trigger renders the finalized Chinese aria-label with its count", () => {
  seedServerChrome();
  const { container } = renderZh(
    <NotificationTrigger
      flavor="rail-bottom"
      notifications={[
        { id: "n1", kind: "warning", title: "a", body: "a" },
        { id: "n2", kind: "warning", title: "b", body: "b" },
        { id: "n3", kind: "warning", title: "c", body: "c" },
      ]}
    />,
  );

  const trigger = screen.getByTestId("notification-trigger-rail");
  assert.equal(trigger.getAttribute("aria-label"), "通知中心（3 条待处理）");
  assertNoRawPlaceholders(container);
});

// Family 5 — components/onboarding/ / `layout.onboarding.letsGo`. The #3874
// catalog wrote this row against OwnerOnboardingModal; that wizard is gone
// (task #164) and this handoff step is where the same button survived.
test("the setup handoff step renders the finalized Chinese primary action under zh-cn", () => {
  seedServerChrome();
  const { container } = renderZh(<ServerSetupHandoffStep serverId="server-1" onDone={() => {}} />);

  const done = screen.getByTestId("server-setup-handoff-done");
  assert.equal(done.textContent?.trim(), "开始吧");
  assert.equal(screen.queryByText("Let's Go"), null, "primary action migrated away from English");
  assertNoRawPlaceholders(container);
});
