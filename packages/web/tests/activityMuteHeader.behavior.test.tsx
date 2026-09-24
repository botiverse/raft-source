import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import type { ReactNode } from "react";
import { toast } from "raft-ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
// ChatPanel's Leave-channel flow mounts the react-intl-migrated ConfirmDialog,
// which needs an <IntlProvider> ancestor.
import { TestIntlProvider } from "./helpers/intl";
import type { Locale } from "../src/i18n/locale";
import api from "../src/api/client";
import ChatPanel, {
  ActivityMutedBadge,
  ActivityMuteToggleButton,
  normalizeActivityMuteSettings,
} from "../src/components/message/ChatPanel";
import Sidebar from "../src/components/layout/Sidebar";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { SERVER_NOTIFICATION_PREFS_UPDATED_EVENT } from "../src/store/events/notificationPrefsEvents";
import { useTaskStore } from "../src/store/taskStore";
import { useUIStore } from "../src/store/uiStore";
import {
  resetServerFeatureFlagsForTests,
  setServerFeatureFlagForTests,
} from "../src/store/serverFeatureFlags";

const originalGet = api.get.bind(api);
const originalPatch = api.patch.bind(api);
const test = ((name: string, fn: Parameters<typeof nodeTest>[1]) =>
  nodeTest(name, { concurrency: false }, fn)) as typeof nodeTest;

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

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.patch = originalPatch as typeof api.patch;
  localStorage.clear();
  resetServerFeatureFlagsForTests();
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushAsyncWork() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-activity-mute",
    serverId: "server-activity-mute",
    name: "activity-mute",
    description: null,
    type: "channel",
    createdAt: "2026-06-28T00:00:00.000Z",
    joined: true,
    activityMuteSupported: true,
    ...overrides,
  };
}

function renderChatPanel(
  channel: Channel,
  options: {
    serverRole?: "owner" | "admin" | "member";
    hideHumansFromMembers?: boolean;
    locale?: Locale;
  } = {},
) {
  if (options.serverRole) {
    useAuthStore.setState({
      user: { id: "user-activity-mute", name: "activity-mute-user" },
    } as never);
  }
  useServerStore.setState({
    current: options.serverRole
      ? {
          id: "server-activity-mute",
          name: "Activity Mute Server",
          avatarUrl: null,
          slug: "activity-mute-server",
          ownerId: "user-owner",
          onboardingAgentId: null,
          hideHumansFromMembers: options.hideHumansFromMembers ?? false,
          plan: "free",
          planDowngradedAt: null,
          role: options.serverRole,
          createdAt: "2026-06-28T00:00:00.000Z",
        }
      : null,
    billing: null,
    members: options.serverRole
      ? [{ userId: "user-activity-mute", role: options.serverRole }]
      : [],
    sidebarOrder: makeSidebarOrder(),
  });
  if (options.serverRole) {
    setServerFeatureFlagForTests(
      "server-activity-mute",
      TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
      false,
    );
  }
  useChannelStore.setState({
    channels: channel.type === "dm" ? [] : [channel],
    dmChannels: channel.type === "dm" ? [channel] : [],
    channelActivity: { [channel.id]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channel.id,
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    messages: [],
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    loadMessages: async () => {},
    loadMessageContext: async () => {},
    loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });

  // `wrapper` (not a manual wrap) so the intl context survives `rerender(...)` —
  // testing-library re-applies the wrapper on rerender, whereas a manual wrap
  // would be dropped and force a remount.
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestIntlProvider locale={options.locale}>{children}</TestIntlProvider>
  );
  return render(
    <MemoryRouter>
      <ChatPanel channel={channel} readOnly />
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

function renderSidebarForMute(
  channelOrChannels: Channel | Channel[],
  options: { pinnedChannelIds?: string[]; mobileInline?: boolean; bottomSlot?: ReactNode } = {},
) {
  const channels = Array.isArray(channelOrChannels) ? channelOrChannels : [channelOrChannels];
  const selectedChannel = channels[channels.length - 1]!;
  useAuthStore.setState({
    user: {
      id: "user-sidebar-mute",
      email: "sidebar-mute@example.com",
      gravatarHash: "",
      name: "sidebar-mute-user",
      displayName: null,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  const server = {
    id: "server-sidebar-mute",
    name: "Sidebar Mute Server",
    avatarUrl: null,
    slug: "sidebar-mute-server",
    ownerId: "user-sidebar-mute",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "owner" as const,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
  const sidebarOrder = makeSidebarOrder();
  sidebarOrder.pinned = (options.pinnedChannelIds ?? []).map((id) => ({ kind: "channel" as const, id }));
  sidebarOrder.pinnedChannelIds = options.pinnedChannelIds ?? [];
  sidebarOrder.pinnedOrder = options.pinnedChannelIds ?? [];
  useServerStore.setState({
    current: server,
    servers: [server],
    members: [],
    sidebarOrder,
  });
  setServerFeatureFlagForTests(
    server.id,
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
    false,
  );
  useChannelStore.setState({
    channels,
    dmChannels: [],
    channelActivity: Object.fromEntries(channels.map((channel) => [channel.id, null])),
    loading: false,
  });
  useMessageStore.setState({
    unreadCounts: {},
    mentionFlags: {},
    drafts: {},
    clearUnread: () => {},
    markRead: async () => {},
    markUnread: async () => {},
  });
  useAgentStore.setState({ agents: [], loading: false });
  useMachineStore.setState({ machines: [], loading: false });
  useInboxStore.setState({ totalCount: 0, totalUnreadCount: 0, loadInbox: async () => {} });
  useUIStore.setState({ sidebarOpen: true });

  return render(
    <MemoryRouter initialEntries={[`/s/${server.slug}/channel/${selectedChannel.id}`]}>
      <TestIntlProvider>
        <Sidebar mobileInline={options.mobileInline} bottomSlot={options.bottomSlot} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("Activity mute header control labels channel semantics without implying read or hide", () => {
  let toggles = 0;
  const { rerender } = render(
    <ActivityMuteToggleButton
      activityMuted={false}
      disabled={false}
      onToggle={() => { toggles += 1; }}
    />,
    { wrapper: TestIntlProvider },
  );

  const muteChannel = screen.getByRole("button", { name: "Mute activity for this channel" });
  assert.equal(muteChannel.getAttribute("title"), "Mute activity for this channel");
  assert.equal(muteChannel.className.includes("bg-white"), true);
  fireEvent.click(muteChannel);
  assert.equal(toggles, 1);

  rerender(
    <ActivityMuteToggleButton
      activityMuted={true}
      disabled={false}
      onToggle={() => { toggles += 1; }}
    />,
  );

  const unmuteChannel = screen.getByRole("button", { name: "Unmute activity for this channel" });
  assert.equal(unmuteChannel.getAttribute("title"), "Unmute activity for this channel");
  assert.equal(unmuteChannel.className.includes("bg-brutal-orange"), true);
  fireEvent.click(unmuteChannel);
  assert.equal(toggles, 2);

  rerender(
    <ActivityMuteToggleButton
      activityMuted={true}
      disabled={true}
      onToggle={() => { toggles += 1; }}
    />,
  );

  const disabledUnmuteChannel = screen.getByRole("button", { name: "Unmute activity for this channel" });
  assert.equal((disabledUnmuteChannel as HTMLButtonElement).disabled, true);
  assert.equal(disabledUnmuteChannel.className.includes("cursor-wait"), true);
  assert.equal(disabledUnmuteChannel.className.includes("opacity-60"), true);
});

test("Activity muted badge states that direct mentions still notify", () => {
  render(<ActivityMutedBadge />, { wrapper: TestIntlProvider });

  const badge = screen.getByTestId("activity-muted-badge");
  assert.equal(badge.textContent?.trim(), "Muted");
  assert.equal(badge.getAttribute("title"), "Activity muted. Direct mentions can still notify you.");
});

test("Activity mute settings parser only accepts explicit state, seq, and non-negative integer version", () => {
  assert.deepEqual(normalizeActivityMuteSettings({
    activityMuted: true,
    muteFromSeq: "42",
    activityMuteSupported: true,
    prefsVersion: 7,
  }), {
    activityMuted: true,
    muteFromSeq: "42",
    activityMuteSupported: true,
    prefsVersion: 7,
  });
  assert.deepEqual(normalizeActivityMuteSettings({
    activityMuted: "true",
    muteFromSeq: { seq: 42 },
    prefsVersion: -1,
  }), {
    activityMuted: false,
    muteFromSeq: null,
    activityMuteSupported: false,
  });
  assert.deepEqual(normalizeActivityMuteSettings(null), {
    activityMuted: false,
    muteFromSeq: null,
    activityMuteSupported: false,
  });
  assert.deepEqual(normalizeActivityMuteSettings(false), {
    activityMuted: false,
    muteFromSeq: null,
    activityMuteSupported: false,
  });
  assert.deepEqual(normalizeActivityMuteSettings(undefined), {
    activityMuted: false,
    muteFromSeq: null,
    activityMuteSupported: false,
  });
});

test("channel options stay hidden for unjoined members and #all members", () => {
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: false } };
  }) as typeof api.get;

  renderChatPanel(makeChannel({
    id: "guard-unjoined-channel",
    name: "guard-unjoined",
    joined: false,
    activityMuteSupported: false,
  }), { serverRole: "member" });
  assert.ok(screen.getByRole("button", { name: "Search this channel" }));
  const unjoinedHasOptions = screen.queryByRole("button", { name: "Channel options" }) !== null;
  cleanup();
  assert.equal(unjoinedHasOptions, false);

  renderChatPanel(makeChannel({
    id: "guard-all-channel",
    name: "all",
    joined: true,
    activityMuteSupported: false,
  }), { serverRole: "member" });
  assert.ok(screen.getByRole("button", { name: "Search this channel" }));
  const allHasOptions = screen.queryByRole("button", { name: "Channel options" }) !== null;
  cleanup();
  assert.equal(allHasOptions, false);
});

test("Channel settings opens in a side sheet with an empty description when the channel has none", async () => {
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: true } };
  }) as typeof api.get;

  renderChatPanel(makeChannel({ id: "empty-description-channel", description: null }), { serverRole: "owner" });

  assert.ok(await screen.findByRole("button", { name: "Mute activity for this channel" }));
  fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
  const sheet = await screen.findByRole("dialog", { name: "Settings" });
  assert.equal(sheet.getAttribute("data-testid"), "channel-settings-sheet");
  assert.ok(sheet.classList.contains("right-0"));
  assert.ok(sheet.classList.contains("h-dvh"));
  assert.ok(sheet.classList.contains("transition-[transform,height,opacity,filter]"));
  assert.ok(sheet.classList.contains("data-starting-style:transform-(--closed-transform)"));
  assert.ok(sheet.classList.contains("motion-reduce:transition-none"));
  assert.ok(sheet.classList.contains("[--drawer-exit-x:calc(100%+var(--drawer-inset)+2px)]"));
  assert.equal((screen.getByPlaceholderText("What is this channel about?") as HTMLTextAreaElement).value, "");

  const cleanBackdrop = document.querySelector<HTMLElement>('[data-slot="drawer-overlay"]');
  assert.ok(cleanBackdrop);
  fireEvent.pointerDown(cleanBackdrop);
  fireEvent.click(cleanBackdrop);
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Settings" }), null));

  fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
  const draftDescription = await screen.findByPlaceholderText("What is this channel about?");
  fireEvent.change(draftDescription, { target: { value: "Unsaved side-sheet draft" } });
  const dirtyBackdrop = document.querySelector<HTMLElement>('[data-slot="drawer-overlay"]');
  assert.ok(dirtyBackdrop);
  fireEvent.pointerDown(dirtyBackdrop);
  fireEvent.click(dirtyBackdrop);
  assert.ok(screen.getByRole("dialog", { name: "Settings" }));
  assert.equal((draftDescription as HTMLTextAreaElement).value, "Unsaved side-sheet draft");

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Settings" }), null));

  fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
  assert.ok(await screen.findByRole("dialog", { name: "Settings" }));
  fireEvent.change(screen.getByPlaceholderText("What is this channel about?"), {
    target: { value: "Escape still closes a dirty draft" },
  });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Settings" }), null));
});

test("Channel settings sheet chrome is localized in English and Chinese", async () => {
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: true } };
  }) as typeof api.get;

  renderChatPanel(makeChannel({ id: "localized-settings-en" }), { serverRole: "owner" });
  fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
  const englishSheet = await screen.findByRole("dialog", { name: "Settings" });
  assert.ok(within(englishSheet).getByText("Channel"));
  assert.ok(within(englishSheet).getByRole("button", { name: "Close channel settings" }));
  assert.ok(within(englishSheet).getByText("Channel info"));
  assert.ok(within(englishSheet).getByText("Name and description shown across the workspace."));
  assert.ok(within(englishSheet).getByText("Channel actions"));
  assert.ok(within(englishSheet).getByText("Membership, visibility, conversion, archive, and destructive controls."));
  assert.ok(!within(englishSheet).queryByText("Access"));
  cleanup();

  renderChatPanel(makeChannel({ id: "localized-settings-zh", type: "joint" }), {
    serverRole: "owner",
    locale: "zh-cn",
  });
  fireEvent.click(screen.getByRole("button", { name: "频道设置" }));
  const chineseSheet = await screen.findByRole("dialog", { name: "设置" });
  assert.ok(within(chineseSheet).getByText("频道"));
  assert.ok(within(chineseSheet).getByRole("button", { name: "关闭频道设置" }));
  assert.ok(within(chineseSheet).getByText("频道信息"));
  assert.ok(within(chineseSheet).getByText("在整个工作空间中显示的名称和描述。"));
  assert.ok(within(chineseSheet).getByText("联合频道"));
  assert.ok(within(chineseSheet).getByText("已连接的服务器和联合频道邀请。"));
  assert.ok(within(chineseSheet).getByText("频道操作"));
  assert.ok(within(chineseSheet).getByText("成员资格、可见性、转换、归档和破坏性操作。"));
  assert.ok(!within(chineseSheet).queryByText("访问权限"));
});

test("Activity mute header loads settings, disables while loading, and toggles with server-normalized response", async () => {
  const channel = makeChannel();
  const load = createDeferred<{ data: unknown }>();
  const save = createDeferred<{ data: unknown }>();
  const calls: Array<{ method: "get" | "patch"; url: string; body?: unknown }> = [];
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    calls.push({ method: "get", url });
    return load.promise;
  }) as typeof api.get;
  api.patch = (async (url: string, body?: unknown) => {
    calls.push({ method: "patch", url, body });
    return save.promise;
  }) as typeof api.patch;

  renderChatPanel(channel);

  const loadingButton = screen.getByRole("button", { name: "Mute activity for this channel" });
  assert.equal((loadingButton as HTMLButtonElement).disabled, true);
  assert.deepEqual(calls.filter((call) => call.url.includes("/notification-settings")), [
    { method: "get", url: "/channels/channel-activity-mute/notification-settings" },
  ]);

  await act(async () => {
    load.resolve({ data: { activityMuted: true, muteFromSeq: 7, activityMuteSupported: true } });
    await load.promise;
    await flushAsyncWork();
  });

  const unmuteButton = await screen.findByRole("button", { name: "Unmute activity for this channel" });
  assert.equal((unmuteButton as HTMLButtonElement).disabled, false);
  assert.ok(screen.getByTestId("activity-muted-badge"));
  assert.deepEqual(useChannelStore.getState().channels.find((item) => item.id === channel.id), {
    ...channel,
    activityMuted: true,
    muteFromSeq: 7,
  });

  await act(async () => {
    fireEvent.click(unmuteButton);
  });
  assert.equal((unmuteButton as HTMLButtonElement).disabled, true);
  assert.equal(screen.queryByTestId("activity-muted-badge"), null);
  assert.equal(useChannelStore.getState().channels.find((item) => item.id === channel.id)?.activityMuted, false);
  assert.deepEqual(calls.at(-1), {
    method: "patch",
    url: "/channels/channel-activity-mute/notification-settings",
    body: { activityMuted: false },
  });

  await act(async () => {
    save.resolve({ data: { activityMuted: false, muteFromSeq: "8", activityMuteSupported: true } });
    await save.promise;
    await flushAsyncWork();
  });

  await waitFor(() => {
    assert.equal(screen.getByRole("button", { name: "Mute activity for this channel" }).hasAttribute("disabled"), false);
  });
  assert.equal(screen.queryByTestId("activity-muted-badge"), null);
  assert.equal(useChannelStore.getState().channels.find((item) => item.id === channel.id)?.activityMuted, false);
});

test("Activity mute header reports load and save failures without losing dismiss control", async () => {
  const channel = makeChannel();
  let patchCalls = 0;
  const loadFailure = createDeferred<{ data: unknown }>();
  const saveFailure = createDeferred<{ data: unknown }>();
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return loadFailure.promise;
  }) as typeof api.get;
  api.patch = (async () => {
    patchCalls += 1;
    return saveFailure.promise;
  }) as typeof api.patch;

  const { unmount } = renderChatPanel(channel);

  await act(async () => {
    loadFailure.reject(new Error("load failed"));
    await loadFailure.promise.catch(() => {});
    await flushAsyncWork();
  });

  const loadAlert = await screen.findByTestId("activity-mute-error");
  assert.equal(loadAlert.textContent?.includes("Failed to load Activity mute setting."), true);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Activity mute error" }));
    await flushAsyncWork();
  });
  await waitFor(() => assert.equal(screen.queryByTestId("activity-mute-error"), null));
  await act(async () => {
    unmount();
    await flushAsyncWork();
  });

  const loadSuccess = createDeferred<{ data: unknown }>();
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return loadSuccess.promise;
  }) as typeof api.get;

  renderChatPanel(channel);

  await act(async () => {
    loadSuccess.resolve({ data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: true } });
    await loadSuccess.promise;
    await flushAsyncWork();
  });

  const muteButton = await screen.findByRole("button", { name: "Mute activity for this channel" });
  await act(async () => {
    fireEvent.click(muteButton);
    assert.equal(useChannelStore.getState().channels.find((item) => item.id === channel.id)?.activityMuted, true);
    saveFailure.reject(new Error("save failed"));
    await saveFailure.promise.catch(() => {});
    await flushAsyncWork();
  });

  const saveAlert = await screen.findByTestId("activity-mute-error");
  assert.equal(patchCalls, 1);
  assert.equal(saveAlert.textContent?.includes("Failed to mute Activity for this conversation."), true);
  assert.equal(screen.queryByTestId("activity-muted-badge"), null);
  assert.equal(useChannelStore.getState().channels.find((item) => item.id === channel.id)?.activityMuted, false);
});

test("Activity mute header uses static channel eligibility instead of server capability hydrate", async () => {
  const calls: string[] = [];
  const load = createDeferred<{ data: unknown }>();
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    if (url.includes("/notification-settings")) calls.push(url);
    return load.promise;
  }) as typeof api.get;

  await act(async () => {
    renderChatPanel(makeChannel({ activityMuteSupported: false }));
    await flushAsyncWork();
  });

  assert.ok(screen.getByRole("button", { name: "Mute activity for this channel" }));
  assert.deepEqual(calls, ["/channels/channel-activity-mute/notification-settings"]);
  await act(async () => {
    load.resolve({ data: { activityMuted: true, muteFromSeq: "1", activityMuteSupported: true } });
    await load.promise;
    await flushAsyncWork();
  });
  assert.ok(await screen.findByRole("button", { name: "Unmute activity for this channel" }));
});

test("Activity mute header is unavailable for unjoined channels and threads", async () => {
  const calls: string[] = [];
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    if (url.includes("/notification-settings")) calls.push(url);
    return { data: { activityMuted: true, muteFromSeq: "1", activityMuteSupported: true } };
  }) as typeof api.get;
  useTaskStore.setState({
    tasks: [],
    currentChannelId: "unsupported",
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    messages: [],
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: false,
    hasNewer: false,
    historyLimited: false,
    highlightedMessageId: null,
    contextLoadError: null,
    transientFocusRequest: null,
    loadMessages: async () => {},
    loadMessageContext: async () => {},
    loadMessageWindowSilent: async () => {},
    loadOlderMessages: async () => {},
    loadNewerMessages: async () => {},
  });

  let rerender!: ReturnType<typeof render>["rerender"];
  await act(async () => {
    ({ rerender } = render(
      <MemoryRouter>
        <ChatPanel channel={makeChannel({ joined: false })} readOnly />
      </MemoryRouter>,
      { wrapper: TestIntlProvider },
    ));
    await flushAsyncWork();
  });

  assert.equal(screen.queryByRole("button", { name: /activity for this channel/i }), null);
  assert.equal(calls.length, 0);

  await act(async () => {
    rerender(
      <MemoryRouter>
        <ChatPanel channel={makeChannel({ type: "thread", joined: true })} readOnly />
      </MemoryRouter>,
    );
    await flushAsyncWork();
  });

  assert.equal(screen.queryByRole("button", { name: /activity for this channel/i }), null);
  assert.equal(calls.length, 0);
});

// task #473. Staging served a DM whose API said `activityMuteSupported: true`
// while the DM header rendered zero mute controls in en and zh
// (#proj-qa:8aad2993). Per-DM mute is not a product feature, so the DM must
// stay control-free *and* must not call the settings endpoint — while the
// regular channel keeps its control, in both locales, on both mute states.
// The channel half is what stops "withhold the claim" from silently retiring
// the real feature.
test("Activity mute control is absent for DMs and present for channels in en and zh", async () => {
  const cases = [
    {
      locale: "en" as const,
      mutedLabel: "Unmute activity for this channel",
      unmutedLabel: "Mute activity for this channel",
    },
    {
      locale: "zh-cn" as const,
      mutedLabel: "为此频道取消静音活动",
      unmutedLabel: "为此频道静音活动",
    },
  ];

  for (const { locale, mutedLabel, unmutedLabel } of cases) {
    for (const activityMuted of [false, true]) {
      const calls: string[] = [];
      const patched: Array<{ url: string; body: unknown }> = [];
      api.get = (async (url: string) => {
        if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
        if (url.includes("/notification-settings")) calls.push(url);
        return { data: { activityMuted, muteFromSeq: activityMuted ? "1" : null, prefsVersion: 1 } };
      }) as typeof api.get;
      api.patch = (async (url: string, body: unknown) => {
        patched.push({ url, body });
        return { data: { activityMuted: !activityMuted, muteFromSeq: activityMuted ? null : "2", prefsVersion: 2 } };
      }) as typeof api.patch;

      // DM: no control, and no settings request at all.
      // `finally { cleanup() }` is required, not tidiness: a failing assertion
      // that leaves the tree mounted turns this tooth's RED into a 60s
      // file-level hang, which reads as "broken suite" instead of "defect".
      try {
        await act(async () => {
          renderChatPanel(
            makeChannel({ id: "dm-activity-mute", type: "dm", peerId: "peer-1", activityMuted }),
            { locale },
          );
          await flushAsyncWork();
        });
        // Assert a COUNT, not the node: `assert.equal(<jsdom element>, null)`
        // makes node:assert try to diff a DOM node on failure, which stalls the
        // whole file for ~65s instead of reporting. A hang is not a RED.
        assert.equal(
          screen.queryAllByTestId("activity-mute-toggle").length,
          0,
          `${locale} muted=${activityMuted}: DM must render no Activity mute control`,
        );
        assert.deepEqual(calls, [], `${locale} muted=${activityMuted}: DM must not request notification settings`);
      } finally {
        cleanup();
      }

      // Regular channel: control present, labelled for the current state, and
      // clicking it reaches the API.
      try {
        await act(async () => {
          renderChatPanel(makeChannel({ activityMuted }), { locale });
          await flushAsyncWork();
        });
        const toggle = screen.getByTestId("activity-mute-toggle");
        assert.equal(
          toggle.getAttribute("aria-label"),
          activityMuted ? mutedLabel : unmutedLabel,
          `${locale} muted=${activityMuted}: unexpected control label`,
        );
        assert.deepEqual(
          calls,
          ["/channels/channel-activity-mute/notification-settings"],
          `${locale} muted=${activityMuted}: channel must load its settings exactly once`,
        );

        await act(async () => {
          fireEvent.click(toggle);
          await flushAsyncWork();
        });
        assert.deepEqual(
          patched,
          [{
            url: "/channels/channel-activity-mute/notification-settings",
            body: { activityMuted: !activityMuted },
          }],
          `${locale} muted=${activityMuted}: click must PATCH the inverted state`,
        );
      } finally {
        cleanup();
      }
    }
  }
});

test("Activity mute row state updates only the matching channel or DM", () => {
  const mutedChannel = makeChannel({ id: "channel-muted" });
  const otherChannel = makeChannel({ id: "channel-other", name: "other" });
  const mutedDm = makeChannel({ id: "dm-muted", name: "dm-muted", type: "dm" });
  const otherDm = makeChannel({ id: "dm-other", name: "dm-other", type: "dm" });
  useChannelStore.setState({
    channels: [mutedChannel, otherChannel],
    dmChannels: [mutedDm, otherDm],
  });

  useChannelStore.getState().setActivityMuteState("channel-muted", {
    activityMuted: true,
    muteFromSeq: "12",
  });
  useChannelStore.getState().setActivityMuteState("dm-muted", {
    activityMuted: true,
    muteFromSeq: 13,
  });

  assert.deepEqual(useChannelStore.getState().channels.map((channel) => ({
    id: channel.id,
    activityMuted: channel.activityMuted,
    muteFromSeq: channel.muteFromSeq,
  })), [
    { id: "channel-muted", activityMuted: true, muteFromSeq: "12" },
    { id: "channel-other", activityMuted: undefined, muteFromSeq: undefined },
  ]);
  assert.deepEqual(useChannelStore.getState().dmChannels.map((channel) => ({
    id: channel.id,
    activityMuted: channel.activityMuted,
    muteFromSeq: channel.muteFromSeq,
  })), [
    { id: "dm-muted", activityMuted: true, muteFromSeq: 13 },
    { id: "dm-other", activityMuted: undefined, muteFromSeq: undefined },
  ]);
});

test("Activity mute header uses channel-row state before notification-settings finishes loading", async () => {
  const channel = makeChannel({ activityMuted: true, muteFromSeq: "existing" });
  const load = createDeferred<{ data: unknown }>();
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return load.promise;
  }) as typeof api.get;

  renderChatPanel(channel);

  const button = screen.getByRole("button", { name: "Unmute activity for this channel" });
  assert.equal((button as HTMLButtonElement).disabled, true);
  assert.equal(screen.getByTestId("activity-muted-badge").textContent?.trim(), "Muted");

  await act(async () => {
    load.resolve({ data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: true } });
    await load.promise;
    await flushAsyncWork();
  });
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Mute activity for this channel" }));
  });
});

test("Activity mute header follows channel-store realtime mute updates after settings load", async () => {
  const channel = makeChannel({ activityMuted: false, muteFromSeq: null });
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: true } };
  }) as typeof api.get;

  const { rerender } = renderChatPanel(channel);

  assert.ok(await screen.findByRole("button", { name: "Mute activity for this channel" }));
  assert.equal(screen.queryByTestId("activity-muted-badge"), null);

  await act(async () => {
    useChannelStore.getState().setActivityMuteState(channel.id, {
      activityMuted: true,
      muteFromSeq: "socket-seq",
      activityMuteSupported: true,
    });
    await flushAsyncWork();
  });

  const updatedChannel = useChannelStore.getState().channels.find((item) => item.id === channel.id);
  assert.ok(updatedChannel);
  rerender(
    <MemoryRouter>
      <ChatPanel channel={updatedChannel} readOnly />
    </MemoryRouter>,
  );
  await waitFor(() => {
    assert.ok(screen.getByRole("button", { name: "Unmute activity for this channel" }));
  });
  assert.ok(screen.getByRole("button", { name: "Unmute activity for this channel" }));
  assert.equal(screen.getByTestId("activity-muted-badge").textContent?.trim(), "Muted");
});

test("channel header keeps Activity mute actions distinct from management controls", async () => {
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: true } };
  }) as typeof api.get;
  const channel = makeChannel({
    id: "managed-channel",
    name: "managed",
    description: "Managed channel description",
    joined: true,
  });

  const { rerender } = renderChatPanel(channel, { serverRole: "owner" });

  const headerTitle = await screen.findByRole("heading", { name: "managed" });
  const header = headerTitle.closest(".h-panel-header");
  assert.ok(header, "regular channel title must render inside the shared panel header");
  const headerDescription = within(header as HTMLElement).getByText("Managed channel description");
  assert.equal(headerDescription.tagName, "P");
  assert.ok(
    headerDescription.classList.contains("font-mono"),
    "the channel description is the lower-priority subtitle, not inline title prose",
  );
  assert.equal(
    headerTitle.parentElement?.nextElementSibling,
    headerDescription,
    "the description must follow the title row as a separate subtitle",
  );

  assert.ok(await screen.findByRole("button", { name: "Mute activity for this channel" }));
  assert.ok(screen.getByRole("button", { name: "Stop all agents in this channel" }));
  const editButton = screen.getByRole("button", { name: "Channel settings" });
  assert.equal(editButton.getAttribute("title"), "Channel settings");
  assert.equal(editButton.getAttribute("aria-label"), "Channel settings");
  assert.equal(screen.queryByTitle("Leave channel"), null);
  assert.ok(screen.getByTitle("View participants"));

  fireEvent.click(screen.getByRole("button", { name: "Stop all agents in this channel" }));
  assert.ok(await screen.findByRole("heading", { name: "Stop All Agents" }));
  assert.ok(screen.getByRole("button", { name: "Stop" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByText("Stop All Agents"), null));

  fireEvent.click(editButton);
  assert.ok(await screen.findByRole("dialog", { name: "Settings" }));
  assert.equal(
    (screen.getByPlaceholderText("What is this channel about?") as HTMLTextAreaElement).value,
    "Managed channel description",
  );
  fireEvent.click(screen.getByRole("button", { name: "Leave Channel" }));
  assert.ok(await screen.findByRole("heading", { name: "Leave Channel" }));
  assert.ok(screen.getAllByRole("button", { name: "Leave Channel" }).length >= 2);
  assert.ok(screen.getByTestId("channel-settings-sheet"));
  assert.ok(screen.getByText(/Existing followed threads are not automatically unfollowed/));
  assert.ok(screen.getByText(/Private content remains gated by current access/));
  fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[1]);
  await waitFor(() => assert.equal(screen.getAllByRole("button", { name: "Leave Channel" }).length, 1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Settings" }), null));

  rerender(
    <MemoryRouter>
      <ChatPanel channel={makeChannel({ id: "all-channel", name: "all", joined: true })} readOnly />
    </MemoryRouter>,
  );

  assert.ok(await screen.findByRole("button", { name: "Mute activity for this channel" }));
  assert.equal(screen.queryByTitle("Leave channel"), null);
  fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
  assert.ok(await screen.findByRole("dialog", { name: "Settings" }));
  assert.equal(screen.queryByRole("button", { name: "Leave Channel" }), null);
});

test("channel header gives members additive channel and runtime controls without metadata editing", async () => {
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { agents: [], humans: [] } };
    return { data: { activityMuted: false, muteFromSeq: null, activityMuteSupported: true } };
  }) as typeof api.get;
  const originalLeaveChannel = useChannelStore.getState().leaveChannel;
  const leaveCalls: string[] = [];

  renderChatPanel(makeChannel({
    id: "member-channel",
    name: "member-channel",
    joined: true,
    channelCapabilities: { addChannelMembers: true },
  }), { serverRole: "member" });
  useChannelStore.setState({
    leaveChannel: async (channelId: string) => {
      leaveCalls.push(channelId);
    },
  });

  assert.ok(await screen.findByRole("button", { name: "Mute activity for this channel" }));
  assert.ok(screen.getByRole("button", { name: "Stop all agents in this channel" }));
  const optionsButton = screen.getByRole("button", { name: "Channel settings" });
  assert.equal(optionsButton.getAttribute("title"), "Channel settings");
  assert.equal(optionsButton.getAttribute("aria-label"), "Channel settings");
  assert.equal(screen.queryByTitle("Leave channel"), null);
  fireEvent.click(screen.getByTitle("View participants"));
  assert.ok(await screen.findByRole("button", { name: "Add Member" }));
  assert.equal(screen.queryByLabelText(/Remove /), null);
  cleanup();
  renderChatPanel(makeChannel({
    id: "member-channel",
    name: "member-channel",
    joined: true,
    channelCapabilities: { addChannelMembers: true },
  }), { serverRole: "member" });

  fireEvent.click(screen.getByRole("button", { name: "Channel settings" }));
  assert.ok(await screen.findByRole("button", { name: "Leave Channel" }));
  assert.equal(screen.queryByRole("button", { name: "Save Changes" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Leave Channel" }));
  assert.ok(await screen.findByRole("heading", { name: "Leave Channel" }));
  assert.ok(screen.getAllByRole("button", { name: "Leave Channel" }).length >= 2);
  assert.ok(screen.getByTestId("channel-settings-sheet"));
  fireEvent.click(screen.getAllByRole("button", { name: "Leave Channel" })[1]);
  await waitFor(() => assert.deepEqual(leaveCalls, ["member-channel"]));

  useChannelStore.setState({ leaveChannel: originalLeaveChannel });
  cleanup();

  renderChatPanel(makeChannel({ id: "unjoined-member-channel", name: "unjoined-member", joined: false }), { serverRole: "member" });
  assert.ok(await screen.findByRole("button", { name: "Search this channel" }));
  assert.equal(screen.queryByRole("button", { name: "Channel options" }), null);
  cleanup();

  renderChatPanel(makeChannel({ id: "all-member-channel", name: "all", joined: true }), { serverRole: "member" });
  assert.ok(await screen.findByRole("button", { name: "Mute activity for this channel" }));
  assert.equal(screen.queryByRole("button", { name: "Channel options" }), null);
});

test("sidebar right-click Mute updates the row and failed Unmute rolls back with feedback", async (t) => {
  const channel = makeChannel({
    id: "sidebar-context-mute",
    serverId: "server-sidebar-mute",
    name: "sidebar-context-mute",
    activityMuted: false,
    muteFromSeq: null,
    prefsVersion: 1,
  });
  const patchCalls: Array<{ url: string; body: unknown }> = [];
  api.get = (() => new Promise(() => {})) as typeof api.get;
  api.patch = (async (url: string, body: unknown) => {
    patchCalls.push({ url, body });
    if (patchCalls.length === 1) {
      return {
        data: {
          activityMuted: true,
          muteFromSeq: 12,
          activityMuteSupported: true,
          prefsVersion: 2,
        },
      };
    }
    throw new Error("network failed");
  }) as typeof api.patch;
  const toastError = t.mock.method(toast, "error");

  const unrelated = makeChannel({
    id: "sidebar-context-other",
    serverId: "server-sidebar-mute",
    name: "sidebar-context-other",
    activityMuted: false,
    muteFromSeq: null,
    prefsVersion: 1,
  });
  renderSidebarForMute([unrelated, channel]);

  const row = document.querySelector('[data-sidebar-channel-id="sidebar-context-mute"]');
  assert.ok(row);
  fireEvent.contextMenu(row, { clientX: 80, clientY: 80 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }));

  await waitFor(() => {
    const muted = useChannelStore.getState().channels.find((candidate) => candidate.id === channel.id);
    assert.equal(muted?.activityMuted, true);
    assert.equal(muted?.muteFromSeq, 12);
    assert.equal(muted?.prefsVersion, 2);
  });
  assert.ok(within(row as HTMLElement).getByTestId("sidebar-activity-muted"));

  fireEvent.contextMenu(row, { clientX: 80, clientY: 80 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Unmute" }));

  await waitFor(() => {
    const rolledBack = useChannelStore.getState().channels.find((candidate) => candidate.id === channel.id);
    assert.equal(rolledBack?.activityMuted, true);
    assert.equal(rolledBack?.muteFromSeq, 12);
    assert.equal(rolledBack?.prefsVersion, 2);
    assert.equal(toastError.mock.calls.length, 1);
  });
  assert.equal(toastError.mock.calls[0]?.arguments[0], "Failed to unmute Activity for this channel.");
  assert.deepEqual(patchCalls, [
    {
      url: "/channels/sidebar-context-mute/notification-settings",
      body: { activityMuted: true },
    },
    {
      url: "/channels/sidebar-context-mute/notification-settings",
      body: { activityMuted: false },
    },
  ]);
});

test("sidebar failed Mute rolls back and reports the mute-specific error", async (t) => {
  const channel = makeChannel({
    id: "sidebar-context-mute-failure",
    serverId: "server-sidebar-mute",
    name: "sidebar-context-mute-failure",
    activityMuted: false,
    muteFromSeq: null,
    prefsVersion: 1,
  });
  api.get = (() => new Promise(() => {})) as typeof api.get;
  api.patch = (async () => {
    throw new Error("network failed");
  }) as typeof api.patch;
  const toastError = t.mock.method(toast, "error");

  renderSidebarForMute(channel);
  const row = document.querySelector('[data-sidebar-channel-id="sidebar-context-mute-failure"]');
  assert.ok(row);
  fireEvent.contextMenu(row, { clientX: 80, clientY: 80 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }));

  await waitFor(() => {
    const rolledBack = useChannelStore.getState().channels.find((candidate) => candidate.id === channel.id);
    assert.equal(rolledBack?.activityMuted, false);
    assert.equal(rolledBack?.muteFromSeq, null);
    assert.equal(rolledBack?.prefsVersion, 1);
    assert.equal(toastError.mock.calls.length, 1);
  });
  assert.equal(toastError.mock.calls[0]?.arguments[0], "Failed to mute Activity for this channel.");
});

test("sidebar request failure does not roll back a newer realtime preference", async (t) => {
  const channel = makeChannel({
    id: "sidebar-context-newer-realtime",
    serverId: "server-sidebar-mute",
    name: "sidebar-context-newer-realtime",
    activityMuted: false,
    muteFromSeq: null,
    prefsVersion: 1,
  });
  const patch = createDeferred<{ data: unknown }>();
  api.get = (() => new Promise(() => {})) as typeof api.get;
  api.patch = (() => patch.promise) as typeof api.patch;
  const toastError = t.mock.method(toast, "error");

  renderSidebarForMute(channel);
  const row = document.querySelector('[data-sidebar-channel-id="sidebar-context-newer-realtime"]');
  assert.ok(row);
  fireEvent.contextMenu(row, { clientX: 80, clientY: 80 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }));

  await act(async () => {
    useChannelStore.getState().setActivityMuteState(channel.id, {
      activityMuted: true,
      muteFromSeq: 12,
      activityMuteSupported: true,
      prefsVersion: 2,
    });
    patch.reject(new Error("response lost"));
    await flushAsyncWork();
  });

  const authoritative = useChannelStore.getState().channels.find((candidate) => candidate.id === channel.id);
  assert.equal(authoritative?.activityMuted, true);
  assert.equal(authoritative?.muteFromSeq, 12);
  assert.equal(authoritative?.prefsVersion, 2);
  assert.equal(toastError.mock.calls.length, 0);
});

test("sidebar right-click mute action uses static channel eligibility", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  const unhydrated = makeChannel({
    id: "sidebar-context-unhydrated",
    serverId: "server-sidebar-mute",
    name: "sidebar-context-unhydrated",
    activityMuteSupported: false,
    joined: true,
  });
  renderSidebarForMute(unhydrated);
  const unhydratedRow = document.querySelector('[data-sidebar-channel-id="sidebar-context-unhydrated"]');
  assert.ok(unhydratedRow);
  fireEvent.contextMenu(unhydratedRow, { clientX: 80, clientY: 80 });
  assert.ok(screen.getByRole("menuitem", { name: "Mute" }));
  assert.equal(screen.queryByRole("menuitem", { name: "Unmute" }), null);

  cleanup();

  const unjoined = makeChannel({
    id: "sidebar-context-unjoined",
    serverId: "server-sidebar-mute",
    name: "sidebar-context-unjoined",
    activityMuteSupported: true,
    joined: false,
  });
  renderSidebarForMute(unjoined);
  const unjoinedRow = document.querySelector('[data-sidebar-channel-id="sidebar-context-unjoined"]');
  assert.ok(unjoinedRow);
  fireEvent.contextMenu(unjoinedRow, { clientX: 80, clientY: 80 });
  assert.equal(screen.queryByRole("menuitem", { name: "Mute" }), null);
  assert.equal(screen.queryByRole("menuitem", { name: "Unmute" }), null);
});

test("sidebar shows every active channel regardless of membership and excludes archived rows from sections and pins", async () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  const archived = makeChannel({
    id: "sidebar-archived",
    serverId: "server-sidebar-mute",
    name: "archived-channel",
    joined: true,
    archivedAt: "2026-07-10T01:00:00.000Z",
  });
  const joined = makeChannel({
    id: "sidebar-joined",
    serverId: "server-sidebar-mute",
    name: "joined-channel",
    joined: true,
  });
  const unjoined = makeChannel({
    id: "sidebar-unjoined-visible",
    serverId: "server-sidebar-mute",
    name: "unjoined-visible-channel",
    joined: false,
  });

  const view = renderSidebarForMute([archived, joined, unjoined], {
    pinnedChannelIds: [archived.id, joined.id],
    mobileInline: true,
  });

  try {
    assert.ok(document.querySelector('[data-sidebar-channel-id="sidebar-joined"]'));
    assert.ok(document.querySelector('[data-sidebar-channel-id="sidebar-unjoined-visible"]'));
    assert.equal(document.querySelector('[data-sidebar-channel-id="sidebar-archived"]'), null);
    assert.equal(screen.queryByText("archived-channel"), null);
  } finally {
    await act(async () => view.unmount());
  }
});

test("sidebar bottom activity stays after the bounded scroll region in flex flow", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  const channel = makeChannel({
    id: "sidebar-live-activity-layout",
    serverId: "server-sidebar-mute",
    name: "live-activity-layout",
  });
  renderSidebarForMute(channel, {
    bottomSlot: <div data-testid="sidebar-live-activity-slot">Live activity</div>,
  });

  const root = screen.getByTestId("sidebar-root");
  const scrollRegion = Array.from(root.children).find((element) =>
    element.classList.contains("relative")
      && element.classList.contains("flex")
      && element.classList.contains("min-h-0")
      && element.classList.contains("flex-1"),
  );
  assert.ok(scrollRegion, "the mounted sidebar keeps a bounded flex scroll region");

  const slot = screen.getByTestId("sidebar-live-activity-slot");
  const wrapper = slot.parentElement;
  assert.ok(wrapper, "the live activity slot has a layout wrapper");
  assert.equal(scrollRegion.nextElementSibling, wrapper, "the slot follows the scroll region as a flex sibling");
  assert.equal(wrapper.parentElement, root);
  assert.equal(wrapper.classList.contains("pointer-events-none"), true);
  assert.equal(wrapper.classList.contains("shrink-0"), true);
  assert.equal(wrapper.classList.contains("absolute"), false);
  assert.equal(wrapper.classList.contains("bottom-0"), false);
});

test("sidebar refreshes cross-server unread state after a server notification preference event", async () => {
  let unreadSummaryLoads = 0;
  api.get = (async (url: string) => {
    if (url === "/servers/unread-summary") unreadSummaryLoads += 1;
    return { data: [] };
  }) as typeof api.get;
  const channel = makeChannel({
    id: "sidebar-server-prefs-event",
    serverId: "server-sidebar-mute",
    name: "sidebar-server-prefs-event",
  });

  renderSidebarForMute(channel);
  await waitFor(() => assert.equal(unreadSummaryLoads, 1));

  await act(async () => {
    window.dispatchEvent(new window.CustomEvent(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, {
      detail: { serverId: "server-sidebar-mute", serverPushMuted: true, prefsVersion: 1 },
    }));
    await flushAsyncWork();
  });

  assert.equal(unreadSummaryLoads, 2);
});

test("sidebar mutes ordinary unread presentation while keeping row and draft visibility", () => {
  const mutedUnread = makeChannel({
    id: "channel-muted-unread",
    name: "muted-unread",
    activityMuted: true,
    muteFromSeq: "17",
    joined: true,
  });
  const unmutedUnread = makeChannel({
    id: "channel-unmuted-unread",
    name: "unmuted-unread",
    activityMuted: false,
    joined: true,
  });
  const unjoinedMuted = makeChannel({
    id: "channel-muted-unjoined",
    name: "muted-unjoined",
    activityMuted: true,
    joined: false,
  });
  const mutedDraft = makeChannel({
    id: "channel-muted-draft",
    name: "muted-draft",
    activityMuted: true,
    joined: true,
  });
  const mutedMention = makeChannel({
    id: "channel-muted-mention",
    name: "muted-mention",
    activityMuted: true,
    joined: true,
  });
  const unmutedMention = makeChannel({
    id: "channel-unmuted-mention",
    name: "unmuted-mention",
    activityMuted: false,
    joined: true,
  });
  const normalIdle = makeChannel({
    id: "channel-normal-idle",
    name: "normal-idle",
    activityMuted: false,
    joined: true,
  });
  useAuthStore.setState({
    user: {
      id: "user-sidebar",
      email: "sidebar@example.com",
      gravatarHash: "",
      name: "sidebar-user",
      displayName: null,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  useServerStore.setState({
    current: {
      id: "server-sidebar",
      name: "Sidebar Server",
      avatarUrl: null,
      slug: "sidebar-server",
      ownerId: "user-sidebar",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-06-28T00:00:00.000Z",
    },
    servers: [],
    members: [],
    sidebarOrder: makeSidebarOrder(),
  });
  setServerFeatureFlagForTests(
    "server-sidebar",
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
    false,
  );
  useChannelStore.setState({
    channels: [mutedUnread, unmutedUnread, unjoinedMuted, mutedDraft, mutedMention, unmutedMention, normalIdle],
    dmChannels: [],
    channelActivity: {
      [mutedUnread.id]: null,
      [unmutedUnread.id]: null,
      [unjoinedMuted.id]: null,
      [mutedDraft.id]: null,
      [mutedMention.id]: null,
      [unmutedMention.id]: null,
      [normalIdle.id]: null,
    },
    loading: false,
  });
  useMessageStore.setState({
    unreadCounts: {
      [mutedUnread.id]: 100,
      [unmutedUnread.id]: 100,
      [unjoinedMuted.id]: 99,
      [mutedMention.id]: 99,
      [unmutedMention.id]: 99,
    },
    mentionFlags: { [mutedMention.id]: true, [unmutedMention.id]: true },
    drafts: { [mutedDraft.id]: "draft body" },
    clearUnread: () => {},
    markRead: async () => {},
  });
  useAgentStore.setState({ agents: [], loading: false });
  useMachineStore.setState({ machines: [], loading: false });
  useInboxStore.setState({
    totalCount: 0,
    totalUnreadCount: 0,
    loadInbox: async () => {},
  });
  useUIStore.setState({ sidebarOpen: true });

  render(
    <MemoryRouter initialEntries={["/s/sidebar-server/channel/channel-muted-unread"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const mutedRow = document.querySelector('[data-sidebar-channel-id="channel-muted-unread"]');
  assert.ok(mutedRow);
  const mutedIcon = within(mutedRow as HTMLElement).getByTestId("sidebar-activity-muted");
  assert.equal(mutedIcon.textContent?.trim(), "");
  assert.equal(mutedIcon.getAttribute("aria-label"), "Activity muted");
  assert.equal(mutedIcon.getAttribute("title"), "Activity muted. Direct mentions can still notify you.");
  assert.equal(mutedIcon.className.includes("ml-1"), true);
  assert.equal(mutedIcon.className.includes("ml-auto"), false);
  assert.equal(mutedIcon.className.includes("size-4"), true);
  assert.equal(mutedIcon.className.includes("text-black/40"), true);
  assert.equal(mutedIcon.className.includes("bg-brutal-orange/25"), false);
  assert.ok(mutedIcon.querySelector(".lucide-bell-off"));
  const mutedName = within(mutedRow as HTMLElement).getByText("muted-unread");
  assert.equal(mutedName.className.includes("text-black/70"), true);
  assert.equal(mutedName.className.includes("font-bold"), false);
  const mutedQuietUnread = within(mutedRow as HTMLElement).getByText("99+");
  assert.equal(mutedQuietUnread.className.includes("ml-1"), true);
  assert.equal(mutedQuietUnread.className.includes("text-black/50"), true);
  assert.equal(mutedQuietUnread.className.includes("font-mono"), true);
  assert.equal(mutedQuietUnread.className.includes("bg-brutal-pink"), false);
  assert.equal(within(mutedRow as HTMLElement).queryByTestId("sidebar-mention-marker"), null);

  const mutedMentionRow = document.querySelector('[data-sidebar-channel-id="channel-muted-mention"]');
  assert.ok(mutedMentionRow);
  assert.ok(within(mutedMentionRow as HTMLElement).getByTestId("sidebar-activity-muted"));
  const mutedMentionQuietUnread = within(mutedMentionRow as HTMLElement).getByText("99");
  assert.equal(mutedMentionQuietUnread.className.includes("ml-1"), true);
  assert.equal(mutedMentionQuietUnread.className.includes("text-black/50"), true);
  assert.equal(mutedMentionQuietUnread.className.includes("bg-brutal-pink"), false);
  const mentionMarker = within(mutedMentionRow as HTMLElement).getByTestId("sidebar-mention-marker");
  assert.equal(mentionMarker.getAttribute("aria-label"), "Mentioned you");
  assert.equal(mentionMarker.className.includes("ml-1"), true);
  assert.equal(mentionMarker.className.includes("bg-soft-signal"), true);
  assert.ok(mentionMarker.querySelector(".lucide-at-sign"));

  const unmutedMentionRow = document.querySelector('[data-sidebar-channel-id="channel-unmuted-mention"]');
  assert.ok(unmutedMentionRow);
  assert.equal(within(unmutedMentionRow as HTMLElement).queryByTestId("sidebar-activity-muted"), null);
  const unmutedMentionMarker = within(unmutedMentionRow as HTMLElement).getByTestId("sidebar-mention-marker");
  assert.equal(unmutedMentionMarker.className.includes("ml-1"), true);
  assert.equal(unmutedMentionMarker.className.includes("ml-auto"), false);
  assert.equal(unmutedMentionMarker.className.includes("rounded"), true);
  const unmutedMentionUnreadBadge = within(unmutedMentionRow as HTMLElement).getByText("99");
  assert.equal(unmutedMentionUnreadBadge.className.includes("bg-brutal-pink"), true);
  assert.equal(unmutedMentionUnreadBadge.className.includes("ml-auto"), true);

  const unmutedRow = document.querySelector('[data-sidebar-channel-id="channel-unmuted-unread"]');
  assert.ok(unmutedRow);
  assert.equal(within(unmutedRow as HTMLElement).queryByTestId("sidebar-activity-muted"), null);
  const unmutedName = within(unmutedRow as HTMLElement).getByText("unmuted-unread");
  assert.equal(unmutedName.className.includes("text-black/70"), false);
  assert.equal(unmutedName.className.includes("font-bold"), true);
  const unmutedUnreadBadge = within(unmutedRow as HTMLElement).getByText("99+");
  assert.equal(unmutedUnreadBadge.className.includes("ml-auto"), true);
  assert.equal(unmutedUnreadBadge.className.includes("ml-1"), false);
  assert.equal(unmutedUnreadBadge.className.includes("bg-brutal-pink"), true);

  const normalIdleRow = document.querySelector('[data-sidebar-channel-id="channel-normal-idle"]');
  assert.ok(normalIdleRow);
  const normalIdleName = within(normalIdleRow as HTMLElement).getByText("normal-idle");
  assert.equal(normalIdleName.className.trim(), "min-w-0 truncate");

  const unjoinedRow = document.querySelector('[data-sidebar-channel-id="channel-muted-unjoined"]');
  assert.ok(unjoinedRow);
  assert.equal(within(unjoinedRow as HTMLElement).queryByTestId("sidebar-activity-muted"), null);
  const unjoinedName = within(unjoinedRow as HTMLElement).getByText("muted-unjoined");
  assert.equal(unjoinedName.className.includes("text-black/40"), true);
  const unjoinedUnreadBadge = within(unjoinedRow as HTMLElement).getByText("99");
  assert.equal(unjoinedUnreadBadge.className.includes("ml-auto"), true);
  assert.equal(unjoinedUnreadBadge.className.includes("text-black/50"), true);
  assert.equal(unjoinedUnreadBadge.className.includes("font-mono"), true);

  const mutedDraftRow = document.querySelector('[data-sidebar-channel-id="channel-muted-draft"]');
  assert.ok(mutedDraftRow);
  assert.ok(within(mutedDraftRow as HTMLElement).getByTestId("sidebar-activity-muted"));
  const draftPencil = Array.from((mutedDraftRow as HTMLElement).querySelectorAll("svg"))
    .find((node) => node.className.baseVal.includes("lucide-pencil"));
  assert.ok(draftPencil);
  assert.equal(draftPencil.className.baseVal.includes("ml-1"), true);
  assert.equal(draftPencil.className.baseVal.includes("text-black/40"), true);
});

test("collapsed Sidebar section shows attention for ordinary unread", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  const ordinaryUnread = makeChannel({
    id: "section-ordinary-unread",
    name: "section-ordinary-unread",
    activityMuted: false,
  });
  renderSidebarForMute(ordinaryUnread);

  act(() => {
    useMessageStore.setState({ unreadCounts: { [ordinaryUnread.id]: 1 } });
  });
  fireEvent.click(screen.getByTestId("sidebar-section-toggle-channels"));

  assert.ok(screen.getByTestId("sidebar-section-unread-dot-channels"));
});

test("collapsed Sidebar section stays quiet when every unread chat is muted", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  const mutedOne = makeChannel({
    id: "section-muted-unread-one",
    name: "section-muted-unread-one",
    activityMuted: true,
  });
  const mutedTwo = makeChannel({
    id: "section-muted-unread-two",
    name: "section-muted-unread-two",
    activityMuted: true,
  });
  renderSidebarForMute([mutedOne, mutedTwo]);

  act(() => {
    useMessageStore.setState({ unreadCounts: { [mutedOne.id]: 2, [mutedTwo.id]: 1 } });
  });
  fireEvent.click(screen.getByTestId("sidebar-section-toggle-channels"));

  assert.equal(screen.queryByTestId("sidebar-section-unread-dot-channels"), null);
});

test("collapsed Sidebar section shows attention for mixed muted and unmuted unread", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  const mutedUnread = makeChannel({
    id: "section-mixed-muted",
    name: "section-mixed-muted",
    activityMuted: true,
  });
  const ordinaryUnread = makeChannel({
    id: "section-mixed-ordinary",
    name: "section-mixed-ordinary",
    activityMuted: false,
  });
  renderSidebarForMute([mutedUnread, ordinaryUnread]);

  act(() => {
    useMessageStore.setState({ unreadCounts: { [mutedUnread.id]: 4, [ordinaryUnread.id]: 1 } });
  });
  fireEvent.click(screen.getByTestId("sidebar-section-toggle-channels"));

  assert.ok(screen.getByTestId("sidebar-section-unread-dot-channels"));
});
