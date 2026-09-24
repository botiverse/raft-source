import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createIntl } from "react-intl";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar";
import { sidebarJoinedChannelsOnlyStorageKey } from "../src/components/layout/sidebarChannelVisibility";
import { TestIntlProvider } from "./helpers/intl";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { mergedMessages } from "../src/i18n/messages";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;
const originalApiGet = api.get;

const IDS = [
  "layout.sidebar.mute",
  "layout.sidebar.unmute",
  "layout.sidebar.noJoinedChannels",
  "layout.sidebar.displaySection",
  "layout.sidebar.humansFailedToLoad",
  "layout.sidebar.showJoinedChannelsOnly",
  "layout.sidebar.wiki",
  "layout.sidebar.failedMuteActivity",
  "layout.sidebar.failedUnmuteActivity",
] as const;

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
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAuthStore.setState({ user: null, loading: false, initialized: true } as never);
});

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") return { data: [] };
    return { data: [] };
  }) as typeof api.get;
}

function seedEmptySidebar({ membersLoadError = false }: { membersLoadError?: boolean } = {}) {
  installApiStub();
  localStorage.clear();
  localStorage.setItem(sidebarJoinedChannelsOnlyStorageKey("server-1"), "true");
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
    membersLoadError,
    loading: false,
    sidebarOrder: {
      channelOrder: [],
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
    channels: [],
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

test("catalog pins sidebar residue MessageIds with Chinese", () => {
  assert.equal(en["layout.sidebar.mute"], "Mute");
  assert.equal(en["layout.sidebar.unmute"], "Unmute");
  assert.equal(en["layout.sidebar.noJoinedChannels"], "No joined channels");
  assert.equal(en["layout.sidebar.displaySection"], "Display");
  assert.equal(en["layout.sidebar.humansFailedToLoad"], "Humans failed to load");
  assert.equal(en["layout.sidebar.showJoinedChannelsOnly"], "Show joined channels only");
  assert.equal(en["layout.sidebar.wiki"], "Wiki");
  assert.equal(en["layout.sidebar.failedMuteActivity"], "Failed to mute Activity for this channel.");
  assert.equal(en["layout.sidebar.failedUnmuteActivity"], "Failed to unmute Activity for this channel.");

  assert.equal(zh["layout.sidebar.mute"], "静音");
  assert.equal(zh["layout.sidebar.unmute"], "取消静音");
  assert.equal(zh["layout.sidebar.noJoinedChannels"], "没有已加入的频道");
  assert.equal(zh["layout.sidebar.displaySection"], "显示");
  assert.equal(zh["layout.sidebar.humansFailedToLoad"], "人类成员加载失败");
  assert.equal(zh["layout.sidebar.showJoinedChannelsOnly"], "仅显示已加入的频道");
  assert.equal(zh["layout.sidebar.wiki"], "Wiki");
  assert.match(zh["layout.sidebar.failedMuteActivity"], /\p{Script=Han}/u);
  assert.match(zh["layout.sidebar.failedUnmuteActivity"], /\p{Script=Han}/u);
  assert.notEqual(zh["layout.sidebar.failedMuteActivity"], en["layout.sidebar.failedMuteActivity"]);
});

test("sidebar residue ids format under zh-cn", () => {
  const zhIntl = createIntl({
    locale: "zh-cn",
    defaultLocale: "en",
    messages: mergedMessages("zh-cn"),
  });
  for (const id of IDS) {
    assert.equal(zhIntl.formatMessage({ id }), zh[id]);
  }
});

test("mounted Sidebar empty joined-channel state is Chinese, not English residue", () => {
  seedEmptySidebar();
  renderZh(<Sidebar mobileInline />);

  assert.ok(screen.getByText(zh["layout.sidebar.noJoinedChannels"]));
  assert.equal(screen.queryByText("No joined channels"), null);
});

test("mounted Sidebar channel options menu renders Chinese display controls", () => {
  seedEmptySidebar();
  renderZh(<Sidebar mobileInline />);

  fireEvent.contextMenu(screen.getByText("频道"));
  assert.ok(screen.getByText(zh["layout.sidebar.displaySection"]));
  assert.ok(screen.getByRole("menuitemcheckbox", { name: zh["layout.sidebar.showJoinedChannelsOnly"] }));
  assert.equal(screen.queryByText("Display"), null);
  assert.equal(screen.queryByText("Show joined channels only"), null);
});

test("mounted Sidebar humans-load failure is Chinese, not English residue", () => {
  seedEmptySidebar({ membersLoadError: true });
  renderZh(<Sidebar mobileInline />, "/s/server/members");

  assert.ok(screen.getByText(zh["layout.sidebar.humansFailedToLoad"]));
  assert.equal(screen.queryByText("Humans failed to load"), null);
});
