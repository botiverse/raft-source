import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { createElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import ChatPanel from "../src/components/message/ChatPanel";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { buildSearchPath } from "../src/hooks/useAppNavigate";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { EXPECTED_RAFT_UI_VERSION } from "./helpers/raftUiVersion";

const repoRoot = resolve(import.meta.dirname, "..");
const originalGet = api.get.bind(api);

window.matchMedia = window.matchMedia ?? (() => ({
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

function makeSidebarOrder() {
  return {
    channelOrder: [],
    agentOrder: [],
    dmOrder: [],
    channelSortMode: "manual" as const,
    jointChannelSortMode: "manual" as const,
    dmSortMode: "manual" as const,
    pinnedSortMode: "manual" as const,
    pinned: [],
    pinnedChannelIds: [],
    pinnedAgentIds: [],
    pinnedOrder: [],
    hiddenDmIds: [],
    channelPanelTabOrder: [],
    agentPanelTabOrder: [],
    pinnedVersion: 0,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "source-channel",
    serverId: "server-search",
    name: "source",
    description: null,
    type: "channel",
    createdAt: "2026-07-02T00:00:00.000Z",
    joined: true,
    activityMuteSupported: false,
    ...overrides,
  };
}

function LocationProbe({ onChange }: { onChange: (path: string) => void }) {
  const location = useLocation();
  onChange(`${location.pathname}${location.search}`);
  return null;
}

function renderSearchHeaderPanel(channel: Channel, onPathChange: (path: string) => void) {
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;

  useServerStore.setState({
    current: {
      id: "server-search",
      name: "Search Server",
      avatarUrl: null,
      slug: "dev",
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-02T00:00:00.000Z",
    },
    billing: null,
    members: [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [channel],
    dmChannels: [],
    channelActivity: { [channel.id]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channel.id,
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    messages: [],
    channelMessages: { [channel.id]: [] },
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    unreadCounts: {},
    drafts: {},
    loadMessages: async () => {},
    loadMessageContext: async () => {},
    loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });

  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/dev/channel/${channel.id}`] },
      createElement(LocationProbe, { onChange: onPathChange }),
      createElement(ChatPanel, { channel }),
    ),
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  localStorage.clear();
});

test("channel header icon-only actions stay square while matching text action height", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/message/ChatPanel.tsx"),
    "utf8",
  );
  const buttonSource = readFileSync(
    resolve(repoRoot, "src/components/ui/Button.tsx"),
    "utf8",
  );

  // ChatPanel header labels migrated to react-intl (B2a): titles now resolve
  // through the message.chatPanel.* catalog; the icon-Button structure is intact.
  assert.match(source, /<Button[\s\S]*?shape="icon"[\s\S]*?title=\{formatMessage\(\{ id: "message\.chatPanel\.stopAllAgents" \}\)\}/);
  assert.match(source, /<Button[\s\S]*?shape="icon"[\s\S]*?<Settings size=\{14\}/);
  assert.match(source, /message\.chatPanel\.editChannel/);
  assert.match(source, /message\.chatPanel\.channelOptions/);
  assert.match(source, /<Button[\s\S]*?shape="icon"[\s\S]*?title=\{formatMessage\(\{ id: "message\.chatPanel\.searchChannel" \}\)\}/);
  assert.doesNotMatch(source, /size-8/);
  assert.match(buttonSource, /icon: "size-7 text-xs"/);
});

test("archived channels expose restore only across both settings and member entry surfaces", () => {
  const overflow = readFileSync(
    resolve(repoRoot, "src/components/channel/ChannelOverflowMenu.tsx"),
    "utf8",
  );
  const members = readFileSync(
    resolve(repoRoot, "src/components/agent/ChannelMembers.tsx"),
    "utf8",
  );
  const legacyMembers = readFileSync(
    resolve(repoRoot, "src/components/agent/LegacyChannelMembers.tsx"),
    "utf8",
  );
  const currentSettings = readFileSync(
    resolve(repoRoot, "src/components/channel/EditChannelDialog.tsx"),
    "utf8",
  );
  const legacySettings = readFileSync(
    resolve(repoRoot, "src/components/channel/LegacyEditChannelDialog.tsx"),
    "utf8",
  );

  assert.match(overflow, /canUseChannelMemberAction\([\s\S]*?\) && !channel\?\.archivedAt;/);
  assert.match(members, /const isArchived = !!currentChannel\?\.archivedAt;[\s\S]*?canUseChannelMemberAction\([\s\S]*?\) && !isArchived;/);
  assert.match(legacyMembers, /const isArchived = !!currentChannel\?\.archivedAt;[\s\S]*?canUseChannelMemberAction\([\s\S]*?\) && !isArchived;/);
  for (const source of [members, legacyMembers]) {
    assert.match(source, /const canChangeRole = !isArchived && !isAllChannel && member\.canChangeChannelRole;/);
    assert.match(source, /const canExplainProtectedDemote = !isArchived[\s\S]*?currentChannel\?\.channelCapabilities\?\.changeChannelMemberRoles === true/);
    assert.match(source, /const showRoleAction = channelManagerRoleActionsEnabled\s*&& \(canChangeRole \|\| canExplainProtectedDemote\);/);
    assert.match(source, /roleAction=\{showRoleAction \?/);
  }
  for (const source of [members, legacyMembers]) assert.match(source, /showAddSection && canAddChannelMembers/);
  for (const source of [currentSettings, legacySettings]) {
    assert.match(source, /const showLeaveAction = !!onLeaveChannel && !isAllChannel && !isArchived;/);
    assert.match(source, /const showManageActions = canEditChannel && !isArchived;/);
    assert.match(source, /isArchived && effectiveCapabilities\.archiveChannels/);
  }
});

test("regular channel header search opens Search with the current channel filter", () => {
  const chatPanel = readFileSync(
    resolve(repoRoot, "src/components/message/ChatPanel.tsx"),
    "utf8",
  );
  const appNavigate = readFileSync(
    resolve(repoRoot, "src/hooks/useAppNavigate.ts"),
    "utf8",
  );

  assert.match(
    chatPanel,
    /const showChannelSearchButton = isJoinableChannel;/,
    "the header shortcut should stay scoped to regular channel surfaces",
  );
  assert.match(
    chatPanel,
    /handleSearchThisChannel\(channel\.id\)/,
    "the header shortcut should preserve the current channel as the search filter",
  );
  assert.match(
    appNavigate,
    /interface SearchNavOptions \{[\s\S]*?channelId\?: string;[\s\S]*?\}/,
    "search navigation should expose an explicit channel filter option",
  );
  assert.match(
    appNavigate,
    /if \(opts\?\.channelId\) params\.set\("channelId", opts\.channelId\);/,
    "search navigation should serialize the channelId URL param used by MessageSearchPage",
  );
  assert.match(
    appNavigate,
    /if \(opts\?\.deferUntilQuery\) params\.set\("defer", "1"\);/,
    "channel header search can prefill scope without immediately searching",
  );
});

test("search navigation preserves query and channel filter params", () => {
  assert.equal(buildSearchPath("/s/dev"), "/s/dev/search");
  assert.equal(
    buildSearchPath("/s/dev", undefined, { channelId: "channel-123" }),
    "/s/dev/search?channelId=channel-123",
  );
  assert.equal(
    buildSearchPath("/s/dev", "hello world", { channelId: "channel 123" }),
    "/s/dev/search?q=hello+world&channelId=channel+123",
  );
});

test("clicking regular channel header search navigates with the current channel filter", () => {
  const channel = makeChannel({ id: "channel-search-123" });
  let currentPath = "";
  renderSearchHeaderPanel(channel, (path) => {
    currentPath = path;
  });

  fireEvent.click(screen.getByLabelText("Search this channel"));

  assert.equal(
    currentPath,
    "/s/dev/search?channelId=channel-search-123&defer=1",
  );
});

test("channel header text and count actions use the shared button size contract", () => {
  const chatPanel = readFileSync(
    resolve(repoRoot, "src/components/message/ChatPanel.tsx"),
    "utf8",
  );
  const channelMembers = readFileSync(
    resolve(repoRoot, "src/components/agent/ChannelMembers.tsx"),
    "utf8",
  );
  const memberCountButton = channelMembers.match(/<Button[\s\S]*?shape="iconText"[\s\S]*?<\/Button>/)?.[0] ?? "";
  assert.doesNotMatch(chatPanel, /title="Leave channel"/);
  assert.match(
    channelMembers,
    /<Button[\s\S]*?shape="iconText"[\s\S]*?className="min-w-7 gap-1 px-1\.5"/,
  );
  assert.match(channelMembers, /text-\[11px\][^"]*tabular-nums/);
  assert.doesNotMatch(channelMembers, /h-8 min-w-8/);
  assert.doesNotMatch(memberCountButton, /badge=/);
  const buttonSource = readFileSync(resolve(repoRoot, "src/components/ui/Button.tsx"), "utf8");
  assert.match(buttonSource, /iconText: "h-7 gap-1\.5 px-2\.5 text-xs"/);
  assert.doesNotMatch(buttonSource, /\bcount:/);
});

test("channel leave action lives inside channel options above visibility actions", () => {
  const chatPanel = readFileSync(
    resolve(repoRoot, "src/components/message/ChatPanel.tsx"),
    "utf8",
  );
  const editDialog = readFileSync(
    resolve(repoRoot, "src/components/channel/EditChannelDialog.tsx"),
    "utf8",
  );
  const memberRemoval = readFileSync(
    resolve(repoRoot, "src/components/channel/useChannelMemberRemoval.tsx"),
    "utf8",
  );
  const englishMessages = readFileSync(
    resolve(repoRoot, "src/i18n/messages/en.ts"),
    "utf8",
  );

  assert.match(chatPanel, /<EditChannelDialog/);
  assert.match(chatPanel, /onLeaveChannel=/);
  assert.match(chatPanel, /canLeaveChannel/);
  assert.match(chatPanel, /leaveChannel\(channel\.id\)/);
  // The leave warning is `channel.edit.confirmLeave` now. Keep BOTH halves of the
  // contract: the id is wired at the call site, and en.ts still carries the exact
  // three clauses this test was written to protect.
  assert.match(editDialog, /id: "channel\.edit\.confirmLeave"/);
  assert.match(englishMessages, /Existing followed threads are not automatically unfollowed/);
  assert.match(englishMessages, /followed public threads can still notify you until you unfollow or manage those threads/);
  assert.match(englishMessages, /Private content remains gated by current access/);
  // The remove warning moved with the shared removal flow
  // (useChannelMemberRemoval, consumed by ChannelMembers AND the member
  // page). Keep BOTH halves of the contract: the id is wired at the
  // dialog site, and en.ts still carries the exact copy.
  assert.match(memberRemoval, /id: "agent\.channelMembers\.removeMemberMessage"/);
  assert.match(englishMessages, /"agent\.channelMembers\.removeMemberMessage":\s*\n\s*"\{name\} will stop receiving ordinary delivery from #\{channel\} and cannot send messages until they rejoin\. Existing followed threads are not automatically unfollowed; followed public threads can still notify them until they unfollow or manage those threads\. Private content remains gated by current access\."/);
  assert.match(
    editDialog,
    /channel\.edit\.leaveChannel[\s\S]*?channel\.edit\.makePublic/,
    "Leave Channel should stay above the Make Public/Private visibility action",
  );
  assert.match(
    editDialog,
    /setShowLeaveConfirm\(true\)[\s\S]*?<ConfirmDialog[\s\S]*?id: "channel\.edit\.leaveChannel"[\s\S]*?layer=\{1\}/,
    "leave warning should stack above Channel settings instead of replacing it",
  );
});

test("Channel settings uses the raft-ui right-side full-height Drawer shell", () => {
  const editDialog = readFileSync(
    resolve(repoRoot, "src/components/channel/EditChannelDialog.tsx"),
    "utf8",
  );
  const webPackage = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  assert.equal(webPackage.dependencies["raft-ui"], EXPECTED_RAFT_UI_VERSION);
  assert.match(editDialog, /function ChannelSettingsSheet/);
  assert.match(editDialog, /const isDirty = name !== initialName/);
  assert.match(editDialog, /import \{[\s\S]*?Drawer,[\s\S]*?DrawerClose,[\s\S]*?DrawerContent,[\s\S]*?DrawerDescription,[\s\S]*?DrawerTitle,[\s\S]*?\} from "raft-ui"/);
  assert.match(editDialog, /<Drawer[\s\S]*?swipeDirection="right"[\s\S]*?disablePointerDismissal=\{isDirty\}/);
  assert.match(editDialog, /eventDetails\.reason === "outside-press"[\s\S]*?eventDetails\.reason === "swipe"[\s\S]*?eventDetails\.cancel\(\)/);
  assert.match(editDialog, /onOpenChangeComplete=\{\(nextOpen\) => \{[\s\S]*?if \(!nextOpen\) onClose\(\);/);
  assert.match(editDialog, /data-testid="channel-settings-sheet"/);
  assert.match(editDialog, /inset-y-0 right-0 h-dvh w-full max-w-\[min\(100vw,34rem\)\]/);
  assert.match(editDialog, /\[--drawer-content-height:100dvh\] \[--drawer-inset:0px\]/);
  assert.match(editDialog, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(editDialog, /id=\{CHANNEL_SETTINGS_FORM_ID\}/);
  assert.match(editDialog, /form=\{CHANNEL_SETTINGS_FORM_ID\}/);
  assert.match(
    editDialog,
    /message\.chatPanel\.overflow\.manageGroup[\s\S]*message\.chatPanel\.overflow\.lifecycleGroup/,
    "drawer panel should keep the current flat Info → Lifecycle hierarchy",
  );
  assert.match(editDialog, /message\.channelSettings\.actionsTitle/);
  assert.doesNotMatch(editDialog, /message\.channelSettings\.access(?:Title|Description)/);
  assert.match(editDialog, /<DrawerTitle id="channel-settings-title"/);
  assert.match(editDialog, /<DrawerDescription/);
  assert.match(editDialog, /<DrawerClose[\s\S]*?message\.channelSettings\.close/);
  assert.doesNotMatch(editDialog, /<Modal onClose=\{onClose\}>/);
  assert.doesNotMatch(editDialog, /DismissBackdrop|createPortal|document\.addEventListener\("keydown"/);
});

test("#all hides the header members button for ordinary members when human directory is hidden", () => {
  const chatPanel = readFileSync(
    resolve(repoRoot, "src/components/message/ChatPanel.tsx"),
    "utf8",
  );

  assert.match(
    chatPanel,
    /const hideAllChannelMembersButton = isAllChannel\s*&&\s*currentServer\?\.role === "member"\s*&&\s*currentServer\.hideHumansFromMembers;/,
  );
  assert.match(
    chatPanel,
    /!\{?hideAllChannelMembersButton[\s\S]*?<ChannelMembers channelId=\{channel\.id\} \/>/,
  );
});
