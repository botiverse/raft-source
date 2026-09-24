import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { createElement } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import ChannelMembers from "../src/components/agent/ChannelMembers";
import ChatPanel from "../src/components/message/ChatPanel";
import EditChannelDialog from "../src/components/channel/EditChannelDialog";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import AgentProfileOverflowMenu from "../src/components/agent/AgentProfileOverflowMenu";
import ThreadOverflowMenu from "../src/components/message/ThreadOverflowMenu";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import { useProfileStore } from "../src/store/profileStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { useServerStore } from "../src/store/serverStore";
import { resetServerFeatureFlagsForTests } from "../src/store/serverFeatureFlags";
import { useTaskStore } from "../src/store/taskStore";
import type { FollowedThread } from "../src/store/threadStore";
import { useThreadStore } from "../src/store/threadStore";
import { renderWithIntl, TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);
const originalPatch = api.patch.bind(api);
const originalDelete = api.delete.bind(api);
const originalConsoleError = console.error;

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

// jsdom has no scrollIntoView; the selected-chips auto-scroll calls it.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const FLAG_KEY = "topbar_overflow_v0";
const CHANNEL_MANAGER_ROLE_ACTIONS_FLAG_KEY = "channel_manager_role_actions_v0";

type RecordedPost = { url: string; body: unknown };
let postCalls: RecordedPost[] = [];
let getCalls: string[] = [];

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

function makeServer(role: Server["role"] = "owner"): Server {
  return {
    id: "server-1",
    name: "Design",
    avatarUrl: null,
    slug: "design",
    ownerId: "owner-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role,
    createdAt: "2026-07-08T00:00:00.000Z",
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "design",
    description: null,
    type: "channel",
    createdAt: "2026-07-08T00:00:00.000Z",
    joined: true,
    activityMuteSupported: false,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    serverId: "server-1",
    name: "agent-1",
    displayName: null,
    avatarUrl: null,
    description: null,
    status: "active",
    model: "gpt-5",
    runtime: "codex",
    serverRole: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function makeHuman(overrides: Partial<ServerMember>): ServerMember {
  return {
    userId: "human-1",
    serverId: "server-1",
    email: "human@example.test",
    gravatarHash: "",
    name: "human-1",
    displayName: null,
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function makeFollowedThread(overrides: Partial<FollowedThread> = {}): FollowedThread {
  return {
    threadChannelId: "thread-channel-1",
    parentMessageId: "parent-message-1",
    parentChannelId: "channel-1",
    parentChannelName: "design",
    parentChannelType: "channel",
    parentMessagePreview: "Parent message",
    parentMessageSenderType: "user",
    parentMessageSenderId: "owner-1",
    latestActivitySeq: null,
    replyCount: 1,
    lastReplyAt: null,
    unreadCount: 0,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

function seedBaseStores(channel: Channel, role: Server["role"] = "owner") {
  const inheritedManager = role === "owner" || role === "admin";
  const channelCapabilities = channel.channelCapabilities ?? {
    editChannelMetadata: inheritedManager,
    archiveChannels: inheritedManager,
    deleteChannels: inheritedManager,
    changeChannelVisibility: inheritedManager,
    federateChannels: inheritedManager,
    addChannelMembers: (channel.type === "channel" || channel.type === "private")
      && channel.name !== "all"
      && !channel.archivedAt
      && (inheritedManager || channel.joined === true),
    removeChannelMembers: inheritedManager,
    changeChannelMemberRoles: inheritedManager,
  };
  channel.channelCapabilities = channelCapabilities;
  const projectedChannel = { ...channel, channelCapabilities };
  useServerStore.setState({
    current: makeServer(role),
    billing: null,
    members: [],
    sidebarOrder: makeSidebarOrder(),
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [projectedChannel],
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
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useAuthStore.setState({ user: { id: "owner-1" } as never });
}

function mockApis({
  flagEnabled,
  roleActionsEnabled = true,
  failBatchAdd = false,
  jointInviteError,
}: {
  flagEnabled: boolean;
  roleActionsEnabled?: boolean;
  failBatchAdd?: boolean;
  jointInviteError?: string;
}) {
  api.get = (async (url: string) => {
    getCalls.push(url);
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    if (url.endsWith("/message-display-settings")) return { data: { collapseLongMessages: true, prefsVersion: 0 } };
    if (url === "/channels/threads/followed") return { data: { threads: [] } };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [
        { key: FLAG_KEY, enabled: flagEnabled },
        { key: CHANNEL_MANAGER_ROLE_ACTIONS_FLAG_KEY, enabled: roleActionsEnabled },
      ] } };
    }
    if (url.endsWith("/unread")) return { data: { unreadCount: 1 } };
    if (url.endsWith("/read-all")) return { data: { seq: 10 } };
    if (url.endsWith("/joint-invites") && jointInviteError) {
      throw { response: { data: { error: jointInviteError } } };
    }
    if (url.endsWith("/members/batch")) {
      if (failBatchAdd) throw new Error("add members failed");
      const payload = body as { userIds: string[]; agentIds: string[] };
      return {
        data: {
          ok: true,
          added: payload,
          alreadyMembers: { userIds: [], agentIds: [] },
        },
      };
    }
    return { data: {} };
  }) as typeof api.post;
  api.patch = (async () => ({ data: { activityMuted: true } })) as typeof api.patch;
}

function renderChatPanel(
  channel: Channel,
  onSearchChannel?: (channelId: string) => void,
  locale: "en" | "zh-cn" = "en",
) {
  return renderWithIntl(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(ChatPanel, { channel, onSearchChannel }),
    ),
    { locale },
  );
}

/** Opens the channel details/settings drawer and navigates into the drawer-internal
 *  members page (task #187: page navigation INSIDE the sheet). */
async function openMembersPageInDrawer() {
  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  const sheet = await screen.findByTestId("channel-overflow-sheet");
  fireEvent.click(await screen.findByTestId("channel-overflow-members-entry"));
  const page = await screen.findByTestId("member-page");
  return { sheet, page };
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  api.patch = originalPatch as typeof api.patch;
  api.delete = originalDelete as typeof api.delete;
  console.error = originalConsoleError;
  postCalls = [];
  getCalls = [];
  localStorage.clear();
  resetServerFeatureFlagsForTests();
  useAgentStore.setState({ agents: [], agentActivities: {} });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  useServerStore.setState({ current: null, members: [] });
  useMessageStore.setState({ unreadCounts: {} });
  useThreadStore.setState({ followedThreads: [] });
  useProfileStore.getState().closeProfile();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

test("flag off keeps the legacy header action row and hides the overflow trigger", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: false });
  renderChatPanel(channel);

  await waitFor(() => {
    assert.ok(screen.getByTitle("Search this channel"));
  });
  assert.ok(!screen.queryByTestId("channel-overflow-trigger"));
});

test("flag off keeps the complete legacy settings surface and never loads the new display preference", async () => {
  const channel = makeChannel({ activityMuteSupported: true, collapseLongMessages: false });
  seedBaseStores(channel);
  mockApis({ flagEnabled: false });
  renderChatPanel(channel);

  const edit = await screen.findByRole("button", { name: "Channel settings" });
  await waitFor(() => {
    assert.ok(getCalls.some((url) => url.endsWith("/notification-settings")));
  });
  assert.ok(
    !getCalls.some((url) => url.endsWith("/message-display-settings")),
    "flag off must not load a preference that only the gated UI can change",
  );

  fireEvent.click(edit);
  await screen.findByTestId("channel-settings-sheet");
  assert.equal(screen.queryByTestId("channel-settings-panel"), null);
  assert.equal(screen.queryByTestId("channel-settings-preferences"), null);
  assert.equal(screen.queryByTestId("channel-settings-save-inline"), null);
  assert.equal(screen.queryByTestId("channel-settings-joint-invite-form"), null);
});

test("channel-manager role-action gate also hides promote in the legacy member surface", async () => {
  const channel = makeChannel({
    channelRole: "admin",
    channelAdminBasis: "channel_role",
    channelCapabilities: {
      editChannelMetadata: true,
      archiveChannels: true,
      addChannelMembers: true,
      removeChannelMembers: true,
      changeChannelMemberRoles: true,
      deleteChannels: false,
      changeChannelVisibility: false,
      federateChannels: false,
    },
  });
  seedBaseStores(channel, "member");
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "local-admin", role: "member" })],
  });
  mockApis({ flagEnabled: false, roleActionsEnabled: false });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [{
            ...makeHuman({ userId: "peer-1", name: "peer", role: "member" }),
            id: "peer-1",
            serverRole: "member",
            channelRole: "member",
            effectiveChannelRole: "member",
            channelAdminBasis: null,
            canChangeChannelRole: true,
          }],
          agents: [],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  render(createElement(ChannelMembers, { channelId: channel.id }));

  fireEvent.click(await screen.findByTitle("View participants"));
  await screen.findByText("peer");
  assert.ok(!screen.queryByRole("button", { name: "Make peer a channel admin" }));
  assert.ok(screen.getByRole("button", { name: "Remove peer" }));
});

test("flag on collapses channel actions into the overflow drawer", async () => {
  const channel = makeChannel({ description: "Design collaboration" });
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const searches: string[] = [];
  renderChatPanel(channel, (channelId) => searches.push(channelId));

  const trigger = await screen.findByTestId("channel-overflow-trigger");
  assert.equal(trigger.getAttribute("aria-label"), "Channel details and settings");
  assert.ok(trigger.querySelector(".lucide-settings"));
  const topbarSearch = screen.getByTestId("channel-topbar-search");
  assert.equal(topbarSearch.getAttribute("aria-label"), "Search this channel");

  fireEvent.click(trigger);
  await screen.findByTestId("channel-overflow-sheet");

  // Owner role, v2「重量随风险」 (Artea 2026-08-06): the yellow header
  // is the identity surface (visibility pill + search icon); members are
  // a two-tone avatar strip (lavender =
  // human, cyan = agent) whose count row opens the members page and
  // whose dashed pink tile jumps straight into the add flow; the
  // management group header (Channel info name/description form FIRST)
  // + BARE preferences group (Pin / Mute / collapse, hairlines) + the
  // SINGLE heavy action zone (visibility → Archive → Leave → Stop
  // agents → Delete — the only filled row, destructive last) — all in
  // one plane, no unread row (the thread drawer keeps its own).
  // NOTE: never assert.equal(HTMLElement, null) — node inspects the failing
  // element (whole jsdom tree) and the child process OOMs with SIGKILL.
  const sheet = screen.getByTestId("channel-overflow-sheet");
  const header = screen.getByTestId("overflow-sheet-header");
  const headerTitle = screen.getByTestId("overflow-sheet-title");
  assert.ok(header.className.includes("h-panel-header"));
  assert.ok(header.className.includes("items-center"));
  assert.ok(!header.className.includes("py-3"));
  assert.ok(headerTitle.className.includes("text-base"));
  assert.ok(headerTitle.className.includes("leading-tight"));
  assert.ok(!headerTitle.className.includes("text-xl"));
  const channelTitleText = screen.getByTestId("channel-overflow-title-text");
  const visibilityBadge = screen.getByTestId("channel-overflow-visibility-badge");
  assert.ok(channelTitleText.className.includes("truncate"));
  assert.ok(channelTitleText.parentElement?.className.includes("flex"));
  assert.ok(channelTitleText.parentElement?.className.includes("min-w-0"));
  assert.ok(visibilityBadge.className.includes("shrink-0"));
  const searchIcon = screen.getByTestId("channel-topbar-search");
  assert.ok(!sheet.contains(searchIcon));
  // Follow-up: Search is a sibling topbar action, not part of the Settings drawer.
  assert.equal(searchIcon.tagName, "BUTTON");
  assert.ok(searchIcon.className.includes("btn-brutal-sm"));
  assert.ok(searchIcon.className.includes("size-7"));
  assert.ok(searchIcon.className.includes("bg-white"));
  assert.ok(searchIcon.querySelector("svg"));
  assert.ok(!searchIcon.textContent?.includes("Search this channel"));
  // The visible description shares the same identity stack as the title. If it
  // sits in a separate grid row, the action button height opens a visible line
  // gap that no longer matches PanelHeader.
  const identityDescription = screen.getByTestId("channel-overflow-identity-desc");
  assert.ok(identityDescription.className.includes("font-mono"));
  assert.ok(identityDescription.className.includes("text-black/50"));
  assert.ok(!identityDescription.className.includes("text-black/60"));
  assert.ok(!identityDescription.className.includes("mt-1"));
  const title = screen.getByTestId("overflow-sheet-title");
  const subtitleRow = screen.getByTestId("overflow-sheet-subtitle-row");
  assert.ok(subtitleRow.contains(identityDescription));
  assert.equal(subtitleRow.parentElement, title.parentElement);
  assert.ok(!subtitleRow.className.includes("col-start-2"));
  assert.ok(!subtitleRow.className.includes("md:col-start-1"));
  // v2 identity: visibility pill rides the header title.
  assert.ok(visibilityBadge);
  // v2 members strip: two-tone tiles by member kind, dashed pink add
  // tile, count entry row opens the members page (inline 280px list
  // stays gone).
  const strip = screen.getByTestId("channel-overflow-members-strip");
  assert.ok(sheet.contains(strip));
  assert.ok(strip.contains(screen.getByTestId("channel-overflow-members-entry")));
  assert.ok(strip.contains(screen.getByTestId("channel-overflow-members-add-tile")));
  assert.ok(!screen.queryByTestId("channel-members-panel"));
  assert.ok(!screen.queryByTestId("channel-members-scroll"));
  const settingsPanel = screen.getByTestId("channel-settings-panel");
  assert.ok(settingsPanel.classList.contains("safe-bottom"));
  const preferences = screen.getByTestId("channel-settings-preferences");
  assert.ok(preferences.contains(screen.getByTestId("channel-settings-pin-switch")));
  assert.ok(preferences.contains(screen.getByTestId("channel-overflow-mute-switch")));
  assert.ok(preferences.contains(screen.getByTestId("channel-settings-collapse-switch")));
  // final11: the channel actions group is gone — Mute moved to
  // preferences, Leave moved to lifecycle.
  assert.ok(!screen.queryByTestId("channel-overflow-actions-group"));
  assert.ok(screen.getByTestId("channel-settings-manage-group"));
  const lifecycleGroup = screen.getByTestId("channel-settings-lifecycle-group");
  // Artea 2026-08-10: all four primary section titles are single words at
  // the same visual level — Members / Info / Preferences / Actions. The
  // former subordinate "Channel info" heading is removed as redundant;
  // its description belongs directly to Info. Sibling setting labels share
  // one medium-weight treatment. The required star stays intact.
  const membersHeading = screen.getByTestId("channel-overflow-members-heading");
  assert.equal(membersHeading.textContent, "Members");
  assert.equal(membersHeading.className, "text-base font-bold text-black");
  const manageHeading = screen.getByTestId("channel-settings-manage-group");
  assert.equal(manageHeading.textContent?.trim(), "Info");
  assert.ok(manageHeading.className.includes("text-base"));
  assert.ok(manageHeading.className.includes("font-bold"));
  assert.ok(manageHeading.className.includes("text-black"));
  assert.ok(!manageHeading.className.includes("text-black/55"));
  const preferencesHeading = preferences.querySelector(":scope > h3")!;
  const lifecycleHeading = lifecycleGroup.querySelector(":scope > h3")!;
  assert.equal(preferencesHeading.textContent?.trim(), "Preferences");
  assert.equal(lifecycleHeading.textContent?.trim(), "Actions");
  for (const sectionHeading of [preferencesHeading, lifecycleHeading]) {
    assert.equal(sectionHeading.className, "text-base font-bold text-black");
  }
  assert.equal(screen.queryByTestId("channel-settings-info-title"), null);
  const infoDescription = screen.getByTestId("channel-settings-info-description");
  assert.equal(infoDescription.textContent?.trim(), "Name and description shown across the workspace.");
  assert.equal(infoDescription.previousElementSibling, manageHeading);
  const nameLabel = screen.getByText("Name", { selector: "label" });
  assert.ok(nameLabel.parentElement?.className.includes("[&>label]:!font-medium"));
  assert.equal(nameLabel.querySelector("span")?.textContent, "*");
  assert.ok(nameLabel.querySelector("span")?.className.includes("text-brutal-pink"));
  const optionalMarker = screen.getByText("(optional)");
  assert.ok(optionalMarker.className.includes("font-normal"));
  assert.ok(optionalMarker.className.includes("text-black/40"));
  // The inline information-form actions share the same compact 28px
  // primitive as the rest of Channel Settings; raw `.btn-brutal` padding
  // made this pair visibly taller than adjacent controls.
  for (const testId of ["channel-settings-discard-draft", "channel-settings-save-inline"]) {
    const button = screen.getByTestId(testId);
    assert.ok(button.classList.contains("btn-brutal-sm"));
    assert.ok(button.classList.contains("h-7"));
    assert.ok(button.classList.contains("text-xs"));
    assert.ok(!button.classList.contains("btn-brutal"));
  }
  for (const labelId of [
    "channel-settings-pin-label",
    "channel-settings-mute-label",
    "channel-settings-collapse-label",
  ]) {
    const label = document.getElementById(labelId)!;
    assert.ok(label.className.includes("text-sm"));
    assert.ok(label.className.includes("font-medium"));
    assert.ok(label.className.includes("text-black"));
    assert.ok(!label.className.includes("font-bold"));
  }
  // Artea 2026-08-06: Channel info (management group) leads the panel,
  // preferences follow the form, lifecycle closes it.
  const manageGroup = screen.getByTestId("channel-settings-manage-group");
  assert.ok(
    manageGroup.compareDocumentPosition(preferences) & Node.DOCUMENT_POSITION_FOLLOWING,
    "preferences group must render after the management group (Channel info first)",
  );
  assert.ok(
    preferences.compareDocumentPosition(lifecycleGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    "lifecycle group must render after the preferences group",
  );
  // v2: one vertical Button stack contains every channel action, including
  // the host's stop-all-agents row (was its own danger group).
  const zone = screen.getByTestId("channel-settings-action-zone");
  assert.ok(lifecycleGroup.contains(zone));
  assert.ok(zone.contains(screen.getByTestId("channel-settings-visibility-action")));
  assert.ok(zone.contains(screen.getByTestId("channel-settings-archive-action")));
  assert.ok(zone.contains(screen.getByTestId("channel-overflow-leave")));
  assert.ok(zone.contains(screen.getByTestId("channel-overflow-stop-agents")));
  // v2 zone order: visibility → Archive → Leave → Stop agents → Delete
  // (the only filled row closes the zone).
  const zoneTestIds = Array.from(zone.querySelectorAll("[data-testid]"))
    .map((el) => el.getAttribute("data-testid"))
    .filter((id) => [
      "channel-settings-visibility-action",
      "channel-settings-archive-action",
      "channel-overflow-leave",
      "channel-overflow-stop-agents",
      "channel-settings-delete-action",
    ].includes(id!));
  assert.deepEqual(zoneTestIds, [
    "channel-settings-visibility-action",
    "channel-settings-archive-action",
    "channel-overflow-leave",
    "channel-overflow-stop-agents",
    "channel-settings-delete-action",
  ]);
  // Artea 2026-08-09: action rows use raft-ui Button interaction instead
  // of painting the whole row yellow on hover. The primitive owns the
  // brutal lift/shadow feedback.
  const visibilityRow = screen.getByTestId("channel-settings-visibility-action");
  const actionZone = screen.getByTestId("channel-settings-action-zone");
  const stopAgentsRow = screen.getByTestId("channel-overflow-stop-agents");
  assert.ok(!actionZone.className.includes("border-2"));
  assert.ok(!actionZone.className.includes("shadow-brutal-sm"));
  assert.ok(actionZone.className.includes("!justify-center"));
  assert.ok(visibilityRow.className.includes("border-2"));
  assert.ok(visibilityRow.className.includes("shadow-raft-sm"));
  assert.ok(visibilityRow.className.includes("hover:-translate-y-px"));
  assert.ok(visibilityRow.className.includes("hover:shadow-raft-md"));
  assert.ok(!visibilityRow.className.includes("hover:bg-soft-signal"));
  assert.equal(stopAgentsRow.textContent, "Stop Agents");
  assert.equal(stopAgentsRow.getAttribute("aria-label"), "Stop all agents in this channel");
  // v2: Delete is the drawer's ONLY filled action (irreversible earns
  // the fill); it no longer renders as a red-text outline row.
  const deleteRow = screen.getByTestId("channel-settings-delete-action");
  assert.ok(deleteRow.className.includes("bg-brutal-red"));
  assert.ok(!deleteRow.className.includes("text-brutal-red"));
  assert.ok(!screen.queryByTestId("channel-settings-mute-switch"));
  assert.ok(!screen.queryByTestId("channel-overflow-unread-switch"));
  assert.ok(!screen.queryByTestId("channel-overflow-sheet-back"));

  // The SOS confirmation is a temporary layer over the settings drawer.
  // Closing it must restore the same drawer instead of dropping the user's
  // navigation context (Artea 2026-08-09 regression report).
  fireEvent.click(stopAgentsRow);
  await screen.findByRole("heading", { name: "Stop All Agents" });
  assert.ok(screen.getByRole("button", { name: "Stop" }));
  assert.ok(screen.getByTestId("channel-overflow-sheet"));
  fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);
  await waitFor(() => assert.equal(screen.queryByText("Stop All Agents"), null));
  assert.ok(screen.getByTestId("channel-overflow-sheet"));

  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  assert.deepEqual(searches, [channel.id]);
});

test("channel overflow header joins the panel height contract when no description is shown", async () => {
  const channel = makeChannel({ description: null });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");
  const header = screen.getByTestId("overflow-sheet-header");
  const headerTitle = screen.getByTestId("overflow-sheet-title");
  assert.ok(header.className.includes("h-panel-header"));
  assert.ok(header.className.includes("items-center"));
  assert.ok(!header.className.includes("py-3"));
  assert.ok(headerTitle.className.includes("text-base"));
  assert.ok(headerTitle.className.includes("leading-tight"));
  assert.ok(!headerTitle.className.includes("text-xl"));
  assert.ok(header.firstElementChild?.className.includes("w-full"));
});

test("long channel overflow titles truncate the name without clipping the visibility badge", async () => {
  const channel = makeChannel({
    name: "very-long-channel-name-with-runtime-and-release-details-that-should-truncate",
    type: "joint",
    description: "Long description stays on its own subtitle row while the badge remains visible.",
  });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  const headerTitle = screen.getByTestId("overflow-sheet-title");
  const channelTitleText = screen.getByTestId("channel-overflow-title-text");
  const visibilityBadge = screen.getByTestId("channel-overflow-visibility-badge");
  assert.equal(visibilityBadge.textContent, "Joint Channel");
  assert.ok(headerTitle.contains(channelTitleText));
  assert.equal(channelTitleText.nextElementSibling, visibilityBadge);
  assert.ok(channelTitleText.className.includes("truncate"));
  assert.ok(channelTitleText.parentElement?.className.includes("flex"));
  assert.ok(channelTitleText.parentElement?.className.includes("min-w-0"));
  assert.ok(visibilityBadge.className.includes("shrink-0"));
});

test("ordinary members can enter the add-members flow from the avatar strip", async () => {
  const channel = makeChannel();
  seedBaseStores(channel, "member");
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "member", role: "member" })],
  });
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-members-strip");
  assert.ok(screen.getByTestId("channel-overflow-members-add-tile"));

  fireEvent.click(screen.getByTestId("channel-overflow-members-add-tile"));
  await screen.findByTestId("member-page");
  assert.ok(screen.getByTestId("add-member-confirm"));
  assert.equal(screen.queryByLabelText("Remove member"), null);
});

test("#all owner cannot see or enter the add-members flow from the avatar strip", async () => {
  const channel = makeChannel({ name: "all" });
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-members-strip");
  assert.equal(screen.queryByTestId("channel-overflow-members-add-tile"), null);

  fireEvent.click(screen.getByTestId("channel-overflow-members-entry"));
  await screen.findByTestId("member-page");
  assert.equal(screen.queryByTestId("member-page-add"), null);
  assert.equal(screen.queryByTestId("add-member-confirm"), null);
});

test("joint channel settings reuse the flat channel drawer hierarchy", async () => {
  const channel = makeChannel({
    type: "joint",
    jointServers: [
      {
        serverId: "server-1",
        serverName: "Design",
        serverSlug: "design",
        role: "host",
        status: "active",
        isCurrentServer: true,
      },
      {
        serverId: "server-2",
        serverName: "Partner Workspace",
        serverSlug: "partner",
        role: null,
        status: "pending",
      },
    ],
    jointPendingInvites: [{
      id: "joint-invite-1",
      fromServerId: "server-1",
      toServerId: "server-2",
      serverName: "Partner Workspace",
      serverSlug: "partner",
      invitedUserId: "partner-admin-1",
      status: "pending",
    }],
  });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true, jointInviteError: "Target server not found" });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  assert.equal(screen.getByTestId("channel-overflow-visibility-badge").textContent, "Joint Channel");
  const infoSection = screen.getByTestId("channel-settings-save-inline").closest("section");
  assert.ok(infoSection);
  assert.match(infoSection.className, /border-b border-black\/10/);
  assert.doesNotMatch(infoSection.className, /border-b-2/);
  const jointSection = screen.getByTestId("channel-settings-joint-section");
  assert.match(jointSection.className, /border-b border-black\/10/);
  assert.doesNotMatch(jointSection.className, /border-b-2/);

  const serverList = screen.getByTestId("channel-settings-joint-servers");
  assert.match(serverList.className, /divide-y divide-black\/10/);
  const serverRows = screen.getAllByTestId("channel-settings-joint-server-row");
  assert.equal(serverRows.length, 2);
  for (const row of serverRows) {
    assert.match(row.className, /\bpy-3\b/);
    assert.doesNotMatch(row.className, /border-2|bg-brutal-gray/);
  }
  const resendRow = screen.getByTestId("channel-settings-joint-resend-row");
  assert.match(resendRow.className, /\bflex\b/);
  assert.match(resendRow.className, /\bjustify-end\b/);
  assert.ok(within(resendRow).getByRole("button", { name: "Resend Invite" }));

  const invite = screen.getByTestId("channel-settings-joint-invite");
  assert.match(invite.className, /border-t border-black\/10/);
  assert.doesNotMatch(invite.className, /border-t-2/);
  const inviteForm = screen.getByTestId("channel-settings-joint-invite-form");
  assert.equal(inviteForm.tagName, "FORM");
  const sendInvite = screen.getByTestId("channel-settings-joint-send-invite");
  const sendInviteRow = screen.getByTestId("channel-settings-joint-send-invite-row");
  assert.match(sendInviteRow.className, /\bflex\b/);
  assert.match(sendInviteRow.className, /\bjustify-end\b/);
  assert.match(sendInvite.className, /\bh-7\b/);
  assert.match(sendInvite.className, /\bbg-brutal-pink\b/);
  assert.doesNotMatch(sendInvite.className, /\bw-full\b/);
  assert.equal((sendInvite as HTMLButtonElement).disabled, true);

  const slugInput = screen.getByLabelText(/^Server slug/) as HTMLInputElement;
  const peopleInput = screen.getByLabelText(/^Invited people/) as HTMLTextAreaElement;
  assert.equal(slugInput.parentElement?.querySelector("span")?.textContent, "/");
  fireEvent.blur(slugInput);
  assert.ok(within(inviteForm).getByText("Invite server slug is required"));
  assert.equal(slugInput.getAttribute("aria-invalid"), "true");
  assert.equal((sendInvite as HTMLButtonElement).disabled, true);

  fireEvent.change(slugInput, { target: { value: "team" } });
  assert.ok(within(inviteForm).getByText("Server slug must be at least 5 characters"));
  assert.equal(slugInput.getAttribute("aria-invalid"), "true");

  fireEvent.blur(peopleInput);
  assert.ok(within(inviteForm).getByText("At least one invited person is required"));
  assert.equal(peopleInput.getAttribute("aria-invalid"), "true");
  fireEvent.change(peopleInput, { target: { value: "@Developer" } });
  assert.equal((sendInvite as HTMLButtonElement).disabled, true);
  const callsBeforeInvalidSubmit = postCalls.filter((call) => call.url.endsWith("/joint-invites")).length;
  fireEvent.submit(inviteForm);
  assert.equal(
    postCalls.filter((call) => call.url.endsWith("/joint-invites")).length,
    callsBeforeInvalidSubmit,
  );

  fireEvent.change(slugInput, { target: { value: "Partner-workspace" } });
  assert.ok(within(inviteForm).getByText(
    "Server slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens",
  ));
  assert.equal((sendInvite as HTMLButtonElement).disabled, true);

  fireEvent.change(slugInput, { target: { value: "joint-invite-target" } });
  assert.equal(within(inviteForm).queryByText("Invite server slug is required"), null);
  assert.equal(slugInput.getAttribute("aria-invalid"), null);
  assert.equal(within(inviteForm).queryByText("At least one invited person is required"), null);
  assert.equal(peopleInput.getAttribute("aria-invalid"), null);
  assert.equal((sendInvite as HTMLButtonElement).disabled, false);
  assert.equal(screen.queryByTestId("channel-settings-joint-invite-submit-error"), null);

  fireEvent.submit(inviteForm);
  await waitFor(() => {
    assert.ok(within(inviteForm).getByText("Target server not found"));
  });
  assert.equal(slugInput.getAttribute("aria-invalid"), "true");
  const settingsInfoForm = document.getElementById("channel-settings-form");
  assert.ok(settingsInfoForm);
  assert.equal(within(settingsInfoForm).queryByText("Target server not found"), null);

  const leaveAction = screen.getByTestId("channel-overflow-leave");
  const disconnectAction = screen.getByTestId("channel-settings-delete-action");
  assert.ok(leaveAction.querySelector(".lucide-log-out"));
  assert.ok(disconnectAction.querySelector(".lucide-unplug"));
  assert.equal(disconnectAction.querySelector(".lucide-log-out"), null);
});

test("joint invite resend keeps drawer geometry stable across busy and success states", async () => {
  const channel = makeChannel({
    type: "joint",
    jointServers: [
      {
        serverId: "server-1",
        serverName: "Design",
        serverSlug: "design",
        role: "host",
        status: "active",
        isCurrentServer: true,
      },
      {
        serverId: "server-2",
        serverName: "Partner Workspace",
        serverSlug: "partner",
        role: null,
        status: "pending",
      },
    ],
    jointPendingInvites: [{
      id: "joint-invite-1",
      fromServerId: "server-1",
      toServerId: "server-2",
      serverName: "Partner Workspace",
      serverSlug: "partner",
      invitedUserId: "partner-admin-1",
      status: "pending",
    }],
  });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const basePost = api.post;
  let resolveResend: ((value: { data: { resentCount: number } }) => void) | null = null;
  const resendResponse = new Promise<{ data: { resentCount: number } }>((resolve) => {
    resolveResend = resolve;
  });
  api.post = (async (url: string, body?: unknown) => {
    if (url === `/channels/${channel.id}/joint-invite/resend`) {
      postCalls.push({ url, body });
      return resendResponse;
    }
    return basePost(url, body);
  }) as typeof api.post;

  renderChatPanel(channel);
  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  const resendButton = within(screen.getByTestId("channel-settings-joint-resend-row"))
    .getByRole("button", { name: "Resend Invite" }) as HTMLButtonElement;
  const labelGrid = screen.getByTestId("channel-settings-joint-resend-label-grid");
  assert.ok(labelGrid.classList.contains("grid"));
  assert.ok(labelGrid.classList.contains("w-max"));
  const labelLayers = Array.from(labelGrid.querySelectorAll(":scope > span"));
  assert.equal(labelLayers.length, 4);
  for (const reservedLabel of labelLayers.slice(0, 3)) {
    assert.equal(reservedLabel.getAttribute("aria-hidden"), "true");
    assert.ok(reservedLabel.classList.contains("invisible"));
    assert.ok(reservedLabel.classList.contains("col-start-1"));
    assert.ok(reservedLabel.classList.contains("row-start-1"));
  }
  assert.ok(labelLayers[3]?.classList.contains("col-start-1"));
  assert.ok(labelLayers[3]?.classList.contains("row-start-1"));
  assert.equal(screen.queryByTestId("channel-settings-joint-resend-status"), null);

  fireEvent.click(resendButton);
  await waitFor(() => {
    assert.equal(resendButton.disabled, true);
    assert.equal(screen.getByTestId("channel-settings-joint-resend-label").textContent, "Resending…");
  });
  assert.equal(screen.queryByTestId("channel-settings-joint-resend-status"), null);
  assert.equal(postCalls.filter((call) => call.url.endsWith("/joint-invite/resend")).length, 1);

  resolveResend!({ data: { resentCount: 1 } });
  await waitFor(() => {
    assert.equal(resendButton.disabled, false);
    assert.equal(screen.getByTestId("channel-settings-joint-resend-label").textContent, "Invite resent");
  });
  const status = screen.getByTestId("channel-settings-joint-resend-status");
  assert.equal(status.getAttribute("role"), "status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.ok(status.classList.contains("sr-only"));
  assert.equal(status.textContent, "Invite email resent.");
  assert.ok(resendButton.classList.contains("bg-brutal-lime"));
  assert.equal(screen.queryByText("Invite email resent.", { selector: "p" }), null);

  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 1600));
  });
  assert.equal(screen.queryByTestId("channel-settings-joint-resend-status"), null);
  assert.equal(screen.getByTestId("channel-settings-joint-resend-label").textContent, "Resend Invite");
  assert.ok(resendButton.classList.contains("bg-white"));
});

test("channel info save reports durable success and keeps failures visible", async () => {
  const channel = makeChannel({ description: "Original description" });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const patchCalls: Array<{ url: string; body: unknown }> = [];
  api.patch = (async (url: string, body?: unknown) => {
    patchCalls.push({ url, body });
    const updates = body as { name?: string; description?: string };
    return { data: { ...channel, ...updates } };
  }) as typeof api.patch;

  function LiveSettingsHarness() {
    const liveChannel = useChannelStore((state) => state.channels[0]);
    return createElement(EditChannelDialog, {
      channelId: liveChannel.id,
      initialName: liveChannel.name,
      initialDescription: liveChannel.description || "",
      onClose: () => {},
      presentation: "panel" as const,
    });
  }

  render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(LiveSettingsHarness),
    ),
  );

  const name = await screen.findByLabelText(/^Name/) as HTMLInputElement;
  const description = await screen.findByLabelText(/^Description/) as HTMLTextAreaElement;
  fireEvent.change(name, { target: { value: "design-updated" } });
  fireEvent.change(description, { target: { value: "Persisted description" } });
  fireEvent.click(screen.getByTestId("channel-settings-save-inline"));

  const success = await screen.findByTestId("channel-settings-save-status");
  assert.equal(success.getAttribute("role"), "status");
  assert.equal(success.getAttribute("aria-live"), "polite");
  assert.ok(success.classList.contains("sr-only"));
  assert.equal(success.textContent, "Changes saved");
  assert.deepEqual(patchCalls, [{
    url: `/channels/${channel.id}`,
    body: { name: "design-updated", description: "Persisted description" },
  }]);
  assert.equal(useChannelStore.getState().channels[0]?.name, "design-updated");
  assert.equal(useChannelStore.getState().channels[0]?.description, "Persisted description");
  const saveButton = screen.getByTestId("channel-settings-save-inline") as HTMLButtonElement;
  assert.equal(saveButton.disabled, true);
  assert.equal(saveButton.textContent?.trim(), "Changes saved");
  assert.ok(saveButton.classList.contains("bg-brutal-lime"));

  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 1600));
  });
  assert.equal(screen.queryByTestId("channel-settings-save-status"), null);
  assert.equal(saveButton.textContent?.trim(), "Save Changes");
  assert.ok(saveButton.classList.contains("bg-brutal-pink"));

  api.patch = (async () => {
    throw new Error("network unavailable");
  }) as typeof api.patch;
  fireEvent.change(description, { target: { value: "Unsaved description" } });
  assert.equal(screen.queryByTestId("channel-settings-save-status"), null);
  fireEvent.click(screen.getByTestId("channel-settings-save-inline"));

  const failure = await screen.findByTestId("channel-settings-save-error");
  assert.equal(failure.getAttribute("role"), "alert");
  assert.equal(failure.textContent, "Failed to update channel");
  assert.equal(description.value, "Unsaved description");
});

test("ordinary member sees runtime stop plus lifecycle Leave and personal Mute", async () => {
  const channel = makeChannel();
  seedBaseStores(channel, "member");
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  assert.ok(screen.getByTestId("channel-overflow-stop-agents"));
  // Runtime control, Leave, and Mute are independently granted; channel
  // archive/delete actions remain absent.
  assert.ok(screen.getByTestId("channel-settings-panel"));
  const lifecycleGroup = screen.getByTestId("channel-settings-lifecycle-group");
  assert.ok(lifecycleGroup.contains(screen.getByTestId("channel-overflow-leave")));
  assert.ok(!lifecycleGroup.querySelector("[data-testid='channel-settings-archive-action']"));
  const preferences = screen.getByTestId("channel-settings-preferences");
  assert.ok(preferences.contains(screen.getByTestId("channel-overflow-mute-switch")));
});

test("channel drawer has no unread row; activity mute lives in the preferences group", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useMessageStore.setState({ unreadCounts: { [channel.id]: 3 } });
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  // final5: the unread marker is gone from the channel drawer (the old
  // header had no such action); the thread drawer keeps its own.
  assert.ok(!screen.queryByTestId("channel-overflow-unread-switch"));

  // final11: Mute sits in the preferences group between Pin and collapse
  // (not in a channel actions group) and still drives the same toggle
  // path (optimistic flip → aria-checked).
  const preferences = screen.getByTestId("channel-settings-preferences");
  const muteSwitch = await screen.findByTestId("channel-overflow-mute-switch");
  assert.ok(preferences.contains(muteSwitch));
  assert.ok(!screen.queryByTestId("channel-overflow-actions-group"));
  assert.ok(!screen.queryByTestId("channel-settings-mute-switch"));
  assert.equal(muteSwitch.getAttribute("aria-checked"), "false");
  fireEvent.click(muteSwitch);
  await waitFor(() => {
    assert.equal(muteSwitch.getAttribute("aria-checked"), "true");
  });
  // Artea 2026-08-11: the drawer already exposes the mute switch in
  // Preferences; do not duplicate that state as an icon in its header.
  assert.ok(!screen.queryByTestId("channel-overflow-muted-pill"));

  // final7: under the flag the title-adjacent muted badge is icon-only —
  // no text label, no frame (flag off keeps the framed "Muted" badge).
  const badge = await screen.findByTestId("activity-muted-badge");
  assert.equal(badge.textContent?.trim(), "");
  assert.ok(badge.querySelector("svg"));
});

test("collapse long messages switch lives in the preferences group and drives the display prefs PATCH", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const patchCalls: Array<{ url: string; body: unknown }> = [];
  const basePatch = api.patch;
  api.patch = (async (url: string, body?: unknown) => {
    patchCalls.push({ url, body });
    if (url.endsWith("/message-display-settings")) {
      return { data: { collapseLongMessages: (body as { collapseLongMessages: boolean }).collapseLongMessages, prefsVersion: 1 } };
    }
    return basePatch(url, body);
  }) as typeof api.patch;
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  // task #187 collapse-long-messages: the switch sits in the preferences
  // group below Pin (Mute stays in the channel actions group) and toggles
  // through the same optimistic flip → PATCH path.
  const preferencesGroup = screen.getByTestId("channel-settings-preferences");
  assert.ok(preferencesGroup.contains(screen.getByTestId("channel-settings-pin-switch")));
  const collapseSwitch = screen.getByTestId("channel-settings-collapse-switch");
  assert.ok(preferencesGroup.contains(collapseSwitch));
  assert.equal(collapseSwitch.getAttribute("aria-checked"), "true");
  fireEvent.click(collapseSwitch);
  await waitFor(() => {
    assert.equal(collapseSwitch.getAttribute("aria-checked"), "false");
  });
  await waitFor(() => {
    assert.ok(patchCalls.some((call) =>
      call.url === `/channels/${channel.id}/message-display-settings`
      && (call.body as { collapseLongMessages?: boolean }).collapseLongMessages === false));
  });
  await waitFor(() => {
    const stored = useChannelStore.getState().channels.find((candidate) => candidate.id === channel.id);
    assert.equal(stored?.collapseLongMessages, false);
    assert.equal(stored?.displayPrefsVersion, 1);
  });
});

test("legacy settings sheet renders the collapse switch in the preferences group when the pref is provided", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const toggles: boolean[] = [];
  render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(EditChannelDialog, {
        channelId: channel.id,
        initialName: channel.name,
        initialDescription: "",
        onClose: () => {},
        collapseLongMessages: {
          enabled: true,
          busy: false,
          onToggle: () => toggles.push(false),
        },
      }),
    ),
  );

  const preferencesGroup = await screen.findByTestId("channel-settings-preferences");
  assert.ok(preferencesGroup.contains(screen.getByTestId("channel-settings-pin-switch")));
  const collapseSwitch = screen.getByTestId("channel-settings-collapse-switch");
  assert.ok(preferencesGroup.contains(collapseSwitch));
  assert.equal(collapseSwitch.getAttribute("aria-checked"), "true");
  fireEvent.click(collapseSwitch);
  assert.deepEqual(toggles, [false]);
});

test("lifecycle Leave row asks for confirmation and leaves the channel", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  // final11: Leave lives at the end of the lifecycle group inside the
  // settings panel, not in the members entry row.
  const lifecycleGroup = screen.getByTestId("channel-settings-lifecycle-group");
  const leaveRow = screen.getByTestId("channel-overflow-leave");
  assert.ok(lifecycleGroup.contains(leaveRow));
  const membersEntry = screen.getByTestId("channel-overflow-members-entry");
  assert.ok(!membersEntry.contains(leaveRow));

  fireEvent.click(leaveRow);
  const confirm = await screen.findByTestId("channel-overflow-leave-confirm");
  fireEvent.click(confirm);
  await waitFor(() => {
    assert.ok(postCalls.some((call) => call.url === `/channels/${channel.id}/leave`));
  });
});

test("multi-select add flow stages candidates and commits on confirm — inside the drawer, no Modal", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [
      // Viewer role is resolved from serverMembers/channelHumans, not from
      // serverStore.current.role — the current user must be listed as owner
      // or canUseChannelMemberAction trims the add entry away.
      makeHuman({ userId: "owner-1", name: "owner", role: "owner" }),
      makeHuman({ userId: "human-candidate", name: "human-candidate", displayName: "Candidate Human" }),
    ],
  });
  useAgentStore.setState({
    agents: [makeAgent({ id: "agent-candidate", name: "agent-candidate", displayName: "Candidate Agent" })],
    agentActivities: {},
  });
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  // The drawer carries only the members ENTRY row; the staged add flow
  // lives behind the members page's ＋ button, INSIDE the same sheet.
  const { sheet } = await openMembersPageInDrawer();

  fireEvent.click(await screen.findByTestId("member-page-add"));

  const confirm = await screen.findByTestId("add-member-confirm");
  // The whole add interaction completes in the drawer (third level) —
  // no Modal backdrop, and the add view renders inside the sheet.
  assert.ok(sheet.contains(confirm));
  assert.ok(!document.querySelector('[class*="bg-black/60"]'));
  // artin task #1060: the drawer's add page is a full-height flex column.
  // The candidate list owns the remaining height/scroll while the confirm
  // action stays pinned after it instead of leaving a large blank tail.
  const addView = screen.getByTestId("add-member-view");
  const candidateList = screen.getByTestId("add-member-candidate-list");
  const addPageBody = addView.parentElement;
  const confirmFooter = confirm.parentElement;
  assert.ok(addPageBody);
  assert.ok(confirmFooter);
  for (const token of ["flex", "min-h-0", "flex-1", "flex-col"]) {
    assert.ok(addPageBody.classList.contains(token));
    assert.ok(addView.classList.contains(token));
  }
  assert.ok(candidateList.classList.contains("min-h-0"));
  assert.ok(candidateList.classList.contains("flex-1"));
  assert.ok(candidateList.classList.contains("overflow-y-auto"));
  assert.ok(!candidateList.classList.contains("max-h-72"));
  assert.ok(confirmFooter.classList.contains("shrink-0"));
  assert.equal(candidateList.nextElementSibling, confirmFooter);
  assert.equal(addView.lastElementChild, confirmFooter);
  // N=0 disabled.
  assert.ok((confirm as HTMLButtonElement).disabled);

  fireEvent.click(await screen.findByTestId("add-candidate-agent-agent-candidate"));
  fireEvent.click(await screen.findByTestId("add-candidate-human-human-candidate"));
  const selectedChips = screen.getByTestId("add-member-selected-chips");
  const agentChip = within(selectedChips).getByTestId("add-member-selected-chip-agent:agent-candidate");
  const humanChip = within(selectedChips).getByTestId("add-member-selected-chip-human:human-candidate");
  assert.equal(agentChip.getAttribute("data-member-kind"), "agent");
  assert.equal(humanChip.getAttribute("data-member-kind"), "human");
  assert.ok(agentChip.className.includes("bg-brutal-cyan"));
  assert.ok(humanChip.className.includes("bg-brutal-lavender"));
  assert.ok(!agentChip.className.includes("bg-soft-signal"));
  assert.ok(!humanChip.className.includes("bg-soft-signal"));
  assert.ok(!(confirm as HTMLButtonElement).disabled);

  // ‹ back in the add view is the add flow's own back (add-member-back):
  // it returns to the roster without closing the drawer.
  fireEvent.click(screen.getByTestId("add-member-back"));
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("add-member-confirm"));
  });
  assert.ok(screen.getByTestId("member-page-search"));
  fireEvent.click(await screen.findByTestId("member-page-add"));
  fireEvent.click(await screen.findByTestId("add-candidate-agent-agent-candidate"));
  fireEvent.click(await screen.findByTestId("add-candidate-human-human-candidate"));
  const confirmAgain = await screen.findByTestId("add-member-confirm");

  fireEvent.click(confirmAgain);
  await waitFor(() => {
    const memberPosts = postCalls.filter((call) => call.url === `/channels/${channel.id}/members/batch`);
    assert.equal(memberPosts.length, 1);
  });
  assert.deepEqual(
    postCalls.find((call) => call.url === `/channels/${channel.id}/members/batch`)?.body,
    { userIds: ["human-candidate"], agentIds: ["agent-candidate"] },
  );

  // Success → back to the member list, no add view residue.
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("add-member-confirm"));
  });
  assert.ok(screen.getByTestId("member-page"));
  assert.ok(screen.getByTestId("channel-overflow-sheet"));
});

test("atomic add failure keeps every selected row available for retry", async () => {
  console.error = () => {};
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [
      makeHuman({ userId: "owner-1", name: "owner", role: "owner" }),
      makeHuman({ userId: "human-candidate", name: "human-candidate", displayName: "Candidate Human" }),
    ],
  });
  useAgentStore.setState({
    agents: [makeAgent({ id: "agent-candidate", name: "agent-candidate", displayName: "Candidate Agent" })],
    agentActivities: {},
  });
  mockApis({ flagEnabled: true, failBatchAdd: true });
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  fireEvent.click(await screen.findByTestId("member-page-add"));

  fireEvent.click(await screen.findByTestId("add-candidate-agent-agent-candidate"));
  fireEvent.click(await screen.findByTestId("add-candidate-human-human-candidate"));
  fireEvent.click(await screen.findByTestId("add-member-confirm"));

  // Atomic failure: the server commits no rows, so the drawer keeps the whole
  // requested selection highlighted for correction or retry.
  await screen.findByTestId("add-member-error");
  const humanRow = await screen.findByTestId("add-candidate-human-human-candidate");
  assert.equal(humanRow.getAttribute("aria-pressed"), "true");
  assert.match(humanRow.className, /bg-brutal-red\/15/);
  const humanChip = screen.getByTestId("add-member-selected-chip-human:human-candidate");
  assert.ok(humanChip.className.includes("bg-brutal-red/25"));
  assert.ok(!humanChip.className.includes("bg-brutal-lavender"));
  const agentRow = screen.getByTestId("add-candidate-agent-agent-candidate");
  assert.equal(agentRow.getAttribute("aria-pressed"), "true");
  assert.match(agentRow.className, /bg-brutal-red\/15/);
  const agentChip = screen.getByTestId("add-member-selected-chip-agent:agent-candidate");
  assert.ok(agentChip.className.includes("bg-brutal-red/25"));
  assert.ok(!agentChip.className.includes("bg-brutal-cyan"));
});

test("channel settings pin switch drives sidebar pinned refs", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const pinnedUpdates: Array<unknown> = [];
  useServerStore.setState({
    updateSidebarOrder: async (updates) => {
      pinnedUpdates.push(updates.pinned);
    },
  });

  render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(EditChannelDialog, {
        channelId: channel.id,
        initialName: channel.name,
        initialDescription: "",
        onClose: () => {},
      }),
    ),
  );

  const pinSwitch = await screen.findByTestId("channel-settings-pin-switch");
  assert.equal(pinSwitch.getAttribute("aria-checked"), "false");
  fireEvent.click(pinSwitch);
  await waitFor(() => {
    assert.deepEqual(pinnedUpdates, [[{ kind: "channel", id: channel.id }]]);
  });
});

test("thread vertical-ellipsis opens the Raft UI action menu without a drawer or invented unread action", async () => {
  mockApis({ flagEnabled: true });
  useThreadStore.setState({ followedThreads: [] });
  useMessageStore.setState({ unreadCounts: {} });
  const searches: number[] = [];
  const viewInChannelActions: number[] = [];
  const openInNewTabActions: number[] = [];

  render(
    createElement(ThreadOverflowMenu, {
      threadChannelId: "thread-channel-1",
      parentMessageId: "parent-message-1",
      viewInChannelLabel: "View in channel",
      onViewInChannel: () => viewInChannelActions.push(1),
      onOpenInNewTab: () => openInNewTabActions.push(1),
      onSearch: () => searches.push(1),
    }),
  );

  const trigger = await screen.findByTestId("thread-overflow-trigger");
  assert.match(trigger.querySelector("svg")?.getAttribute("class") ?? "", /lucide-ellipsis-vertical/);
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  fireEvent.click(trigger);
  const menu = await screen.findByTestId("thread-overflow-menu");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.ok(!screen.queryByTestId("thread-overflow-sheet"));

  const actions = screen.getAllByRole("menuitem");
  assert.deepEqual(actions.map((action) => action.textContent), [
    "Search in thread",
    "Open in New Tab",
    "View in channel",
    "Follow Thread",
  ]);

  const search = screen.getByTestId("thread-overflow-search");
  assert.match(search.querySelector("svg")?.getAttribute("class") ?? "", /lucide-search/);
  fireEvent.click(search);
  assert.deepEqual(searches, [1]);
  await waitFor(() => assert.equal(screen.queryByTestId("thread-overflow-menu"), null));

  fireEvent.click(trigger);
  const openInNewTab = await screen.findByTestId("thread-overflow-open-new-tab");
  assert.match(openInNewTab.querySelector("svg")?.getAttribute("class") ?? "", /lucide-external-link/);
  fireEvent.click(openInNewTab);
  assert.deepEqual(openInNewTabActions, [1]);

  fireEvent.click(trigger);
  const viewInChannel = await screen.findByTestId("thread-overflow-view-in-channel");
  assert.equal(viewInChannel.textContent, "View in channel");
  assert.match(viewInChannel.querySelector("svg")?.getAttribute("class") ?? "", /lucide-map-pin/);
  fireEvent.click(viewInChannel);
  assert.deepEqual(viewInChannelActions, [1]);

  fireEvent.click(trigger);
  let followAction = await screen.findByTestId("thread-overflow-follow-action");
  assert.equal(followAction.getAttribute("aria-checked"), null);
  assert.ok(!screen.queryByTestId("thread-overflow-follow-switch"));
  assert.equal(followAction.textContent, "Follow Thread");
  assert.match(
    followAction.querySelector("svg")?.getAttribute("class") ?? "",
    /lucide-message-circle-plus/,
  );
  fireEvent.click(followAction);
  await waitFor(() => {
    assert.ok(postCalls.some((call) =>
      call.url === "/channels/threads/follow"
      && (call.body as { parentMessageId?: string }).parentMessageId === "parent-message-1"));
  });
  act(() => useThreadStore.setState({ followedThreads: [makeFollowedThread()] }));
  fireEvent.click(trigger);
  followAction = await screen.findByTestId("thread-overflow-follow-action");
  assert.equal(followAction.textContent, "Unfollow Thread");
  assert.match(
    followAction.querySelector("svg")?.getAttribute("class") ?? "",
    /lucide-message-circle-off/,
  );
  fireEvent.click(followAction);
  await waitFor(() => {
    assert.ok(postCalls.some((call) =>
      call.url === "/channels/threads/unfollow"
      && (call.body as { threadChannelId?: string }).threadChannelId === "thread-channel-1"));
  });

  assert.ok(!screen.queryByTestId("thread-overflow-unread-switch"));
  assert.ok(!screen.queryByText("Unread"));
  assert.ok(!postCalls.some((call) => call.url === "/channels/thread-channel-1/unread"));
});

test("agent profile vertical-ellipsis groups immediate commands in the Raft UI menu", async () => {
  const calls: string[] = [];
  const view = render(
    createElement(AgentProfileOverflowMenu, {
      canMessageAgent: true,
      canControlAgentRuntime: true,
      isOnline: true,
      messageLabel: "Messages",
      onMessage: () => calls.push("message"),
      onStartStop: () => calls.push("stop"),
      onRestartReset: () => calls.push("restart"),
    }),
  );

  const trigger = screen.getByTestId("agent-profile-overflow-trigger");
  assert.match(trigger.querySelector("svg")?.getAttribute("class") ?? "", /lucide-ellipsis-vertical/);
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");

  fireEvent.click(trigger);
  const menu = await screen.findByTestId("agent-profile-overflow-menu");
  assert.equal(menu.getAttribute("role"), "menu");
  assert.deepEqual(screen.getAllByRole("menuitem").map((item) => item.textContent), [
    "Messages",
    "Stop Agent",
    "Restart / Reset",
  ]);
  assert.match(
    screen.getByTestId("agent-profile-overflow-message").querySelector("svg")?.getAttribute("class") ?? "",
    /lucide-message-square/,
  );
  assert.match(
    screen.getByTestId("agent-profile-overflow-start-stop").querySelector("svg")?.getAttribute("class") ?? "",
    /lucide-square/,
  );

  fireEvent.click(screen.getByTestId("agent-profile-overflow-message"));
  assert.deepEqual(calls, ["message"]);
  await waitFor(() => assert.equal(screen.queryByTestId("agent-profile-overflow-menu"), null));

  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId("agent-profile-overflow-start-stop"));
  assert.deepEqual(calls, ["message", "stop"]);

  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId("agent-profile-overflow-restart-reset"));
  assert.deepEqual(calls, ["message", "stop", "restart"]);

  view.rerender(createElement(AgentProfileOverflowMenu, {
    canMessageAgent: false,
    canControlAgentRuntime: true,
    isOnline: false,
    messageLabel: "Messages",
    onMessage: () => calls.push("message"),
    onStartStop: () => calls.push("start"),
    onRestartReset: () => calls.push("restart"),
  }));
  fireEvent.click(screen.getByTestId("agent-profile-overflow-trigger"));
  assert.deepEqual(screen.getAllByRole("menuitem").map((item) => item.textContent), [
    "Start Agent",
    "Restart / Reset",
  ]);
  assert.match(
    screen.getByTestId("agent-profile-overflow-start-stop").querySelector("svg")?.getAttribute("class") ?? "",
    /lucide-play/,
  );

  view.rerender(createElement(AgentProfileOverflowMenu, {
    canMessageAgent: false,
    canControlAgentRuntime: false,
    isOnline: false,
    messageLabel: "Messages",
    onMessage: () => calls.push("message"),
    onStartStop: () => calls.push("start"),
    onRestartReset: () => calls.push("restart"),
  }));
  assert.equal(screen.queryByTestId("agent-profile-overflow-trigger"), null);
});

test("responsive agent profile actions keep inline commands wired while retaining the overflow fallback", async () => {
  const calls: string[] = [];
  render(
    createElement(AgentProfileOverflowMenu, {
      canMessageAgent: true,
      canControlAgentRuntime: true,
      isOnline: false,
      messageLabel: "Messages",
      responsive: true,
      onMessage: () => calls.push("message"),
      onStartStop: () => calls.push("start"),
      onRestartReset: () => calls.push("restart"),
    }),
  );

  assert.ok(screen.getByTestId("agent-profile-inline-actions"));
  assert.ok(screen.getByTestId("agent-profile-overflow-trigger"));
  assert.equal(screen.getByTestId("agent-profile-inline-message").getAttribute("title"), null);
  assert.equal(screen.getByTestId("agent-profile-inline-message").getAttribute("data-slot"), "tooltip-trigger");
  assert.equal(screen.getByTestId("agent-profile-overflow-trigger").getAttribute("title"), null);
  assert.equal(screen.getByTestId("agent-profile-overflow-trigger").getAttribute("data-slot"), "tooltip-trigger");
  fireEvent.click(screen.getByTestId("agent-profile-inline-message"));
  fireEvent.click(screen.getByTestId("agent-profile-inline-start-stop"));
  fireEvent.click(screen.getByTestId("agent-profile-inline-restart-reset"));
  assert.deepEqual(calls, ["message", "start", "restart"]);
});

test("agent profile header adopts the vertical-ellipsis under the topbar flag and keeps Close structural", async () => {
  const channel = makeChannel();
  const agent = makeAgent({});
  seedBaseStores(channel);
  useAgentStore.setState({ agents: [agent], agentActivities: {} });
  mockApis({ flagEnabled: true });

  render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(AgentDetailPanel, { agent, onClose: () => {} }),
    ),
  );

  const trigger = await screen.findByTestId("agent-profile-overflow-trigger");
  assert.match(trigger.querySelector("svg")?.getAttribute("class") ?? "", /lucide-ellipsis-vertical/);
  assert.ok(screen.getByTitle("Close"));
  const responsiveActions = screen.getByTestId("agent-profile-responsive-actions");
  assert.ok(responsiveActions.classList.contains("agent-profile-responsive-actions"));
  assert.ok(screen.getByTestId("agent-profile-inline-actions").classList.contains("hidden"));
  assert.ok(screen.getByTestId("agent-profile-inline-message"));
  assert.equal(screen.queryByTitle("Messages"), null);

  fireEvent.click(trigger);
  assert.deepEqual(screen.getAllByRole("menuitem").map((item) => item.textContent), [
    "Direct Message",
    "Stop Agent",
    "Restart / Reset",
  ]);
});

test("human members get exactly Restart Model and Reset Model without destructive reset", async () => {
  const channel = makeChannel();
  const agent = makeAgent({ creatorType: "user", creatorId: "different-user" });
  seedBaseStores(channel, "member");
  useAgentStore.setState({ agents: [agent], agentActivities: {} });
  mockApis({ flagEnabled: true });

  render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(AgentDetailPanel, { agent, onClose: () => {} }),
    ),
  );

  const trigger = await screen.findByTestId("agent-profile-overflow-trigger");
  fireEvent.click(trigger);
  assert.deepEqual(screen.getAllByRole("menuitem").map((item) => item.textContent), [
    "Direct Message",
    "Stop Agent",
    "Restart / Reset",
  ]);
  fireEvent.click(screen.getByTestId("agent-profile-overflow-restart-reset"));

  const dialog = await screen.findByRole("dialog");
  assert.equal(within(dialog).getAllByText("Restart Model").length, 2, "selected mode also labels confirm action");
  assert.ok(within(dialog).getByText("Reset Model"));
  assert.equal(within(dialog).queryByText("Restart"), null);
  assert.equal(within(dialog).queryByText("Reset Session & Restart"), null);
  assert.equal(within(dialog).queryByText("Full Reset & Restart"), null);
  assert.equal(screen.queryByRole("button", { name: "Delete Agent" }), null);
});

test("agent profile flag off keeps the legacy separate header actions", async () => {
  const channel = makeChannel();
  const agent = makeAgent({});
  seedBaseStores(channel);
  useAgentStore.setState({ agents: [agent], agentActivities: {} });
  mockApis({ flagEnabled: false });

  render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(AgentDetailPanel, { agent, onClose: () => {} }),
    ),
  );

  await waitFor(() => assert.ok(screen.getByTitle("Messages")));
  assert.equal(screen.queryByTestId("agent-profile-overflow-trigger"), null);
  assert.ok(screen.getByTitle("Stop Agent"));
  assert.ok(screen.getByTitle("Restart / Reset"));
  assert.ok(screen.getByTitle("Close"));
});

test("agent profile confirmation chrome follows the active Chinese locale", async () => {
  const channel = makeChannel();
  const agent = makeAgent({});
  seedBaseStores(channel);
  useAgentStore.setState({ agents: [agent], agentActivities: {} });
  mockApis({ flagEnabled: true });

  renderWithIntl(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(AgentDetailPanel, { agent, onClose: () => {} }),
    ),
    { locale: "zh-cn" },
  );

  const trigger = await screen.findByTestId("agent-profile-overflow-trigger");
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId("agent-profile-overflow-start-stop"));
  let dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByRole("button", { name: "取消" }));
  assert.equal(within(dialog).queryByRole("button", { name: "Cancel" }), null);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId("agent-profile-overflow-restart-reset"));
  dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByRole("button", { name: "取消" }));
  assert.equal(within(dialog).queryByRole("button", { name: "Cancel" }), null);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

  fireEvent.click(screen.getByRole("button", { name: "删除 Agent" }));
  dialog = await screen.findByRole("dialog");
  assert.ok(within(dialog).getByRole("button", { name: "取消" }));
  assert.equal(within(dialog).queryByRole("button", { name: "Cancel" }), null);
});

test("archived channel unarchive link opens the overflow drawer instead of the legacy sheet", async () => {
  const channel = makeChannel({ archivedAt: "2026-08-01T00:00:00.000Z" });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByText("Unarchive"));

  await screen.findByTestId("channel-overflow-sheet");
  // The legacy side sheet must NOT appear under the overflow flag.
  assert.ok(!screen.queryByTestId("channel-settings-sheet"));
});

test("flag off archived channel unarchive link still opens the legacy sheet", async () => {
  const channel = makeChannel({ archivedAt: "2026-08-01T00:00:00.000Z" });
  seedBaseStores(channel);
  mockApis({ flagEnabled: false });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByText("Unarchive"));

  await screen.findByTestId("channel-settings-sheet");
  assert.ok(!screen.queryByTestId("channel-overflow-sheet"));
});

test("dirty settings draft routes close attempts through the unsaved prompt", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-settings-panel");

  // Make the settings form dirty (name field starts as the channel name).
  fireEvent.change(screen.getByDisplayValue("design"), { target: { value: "design-renamed" } });

  // Outside-press while dirty: drawer stays open and the prompt appears.
  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
  await screen.findByTestId("channel-overflow-unsaved-prompt");
  assert.ok(screen.getByTestId("channel-overflow-sheet"));
  assert.ok(screen.getByDisplayValue("design-renamed"));

  // "Keep editing" dismisses only the prompt — draft and drawer survive.
  fireEvent.click(screen.getByText("Keep editing"));
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("channel-overflow-unsaved-prompt"));
  });
  assert.ok(screen.getByTestId("channel-overflow-sheet"));
  assert.ok(screen.getByDisplayValue("design-renamed"));

  // A second close attempt prompts again; discard closes the drawer.
  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
  await screen.findByTestId("channel-overflow-unsaved-prompt");
  fireEvent.click(screen.getByTestId("channel-overflow-unsaved-discard"));
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("channel-overflow-sheet"));
  });
});

test("dirty settings draft guards Search until the user explicitly discards it", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const searches: string[] = [];
  renderChatPanel(channel, (channelId) => searches.push(channelId));

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-settings-panel");
  fireEvent.change(screen.getByDisplayValue("design"), { target: { value: "draft-name" } });

  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  await screen.findByTestId("channel-overflow-unsaved-prompt");
  assert.deepEqual(searches, []);
  assert.ok(screen.getByTestId("channel-overflow-sheet"));
  assert.ok(screen.getByDisplayValue("draft-name"));

  fireEvent.click(screen.getByText("Keep editing"));
  await waitFor(() => {
    assert.equal(screen.queryByTestId("channel-overflow-unsaved-prompt"), null);
  });
  assert.ok(screen.getByDisplayValue("draft-name"));

  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  await screen.findByTestId("channel-overflow-unsaved-prompt");
  fireEvent.click(screen.getByTestId("channel-overflow-unsaved-discard"));
  await waitFor(() => {
    assert.deepEqual(searches, [channel.id]);
    assert.equal(screen.queryByTestId("channel-overflow-sheet"), null);
  });
});

test("unsent Joint invite draft cannot be save-and-closed before Search", async () => {
  const channel = makeChannel({
    type: "joint",
    jointServers: [{
      serverId: "server-1",
      serverName: "Design",
      serverSlug: "design",
      role: "host",
      status: "active",
      isCurrentServer: true,
    }],
  });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const searches: string[] = [];
  renderChatPanel(channel, (channelId) => searches.push(channelId));

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-settings-joint-invite-form");
  const slugInput = screen.getByLabelText(/^Server slug/) as HTMLInputElement;
  const peopleInput = screen.getByLabelText(/^Invited people/) as HTMLTextAreaElement;
  fireEvent.change(slugInput, { target: { value: "partner-workspace" } });
  fireEvent.change(peopleInput, { target: { value: "@PartnerAdmin" } });
  // A simultaneous rename is saveable, but the independent invitation
  // draft is not: the prompt must fail closed for the whole draft set.
  fireEvent.change(screen.getByDisplayValue("design"), { target: { value: "design-renamed" } });

  const invitePostsBeforeSearch = postCalls.filter((call) => call.url.endsWith("/joint-invites")).length;
  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  const prompt = await screen.findByTestId("channel-overflow-unsaved-prompt");
  assert.ok(within(prompt).getByText(
    "A Joint invitation has not been sent. Keep editing to send it, or discard all unsaved changes before closing.",
  ));
  assert.equal(
    within(prompt).queryByText("The channel name or description has unsaved edits. Save them before closing?"),
    null,
  );
  assert.deepEqual(searches, []);
  assert.equal(
    postCalls.filter((call) => call.url.endsWith("/joint-invites")).length,
    invitePostsBeforeSearch,
  );
  assert.equal(screen.queryByTestId("channel-overflow-unsaved-save"), null);

  fireEvent.click(screen.getByText("Keep editing"));
  await waitFor(() => {
    assert.equal(screen.queryByTestId("channel-overflow-unsaved-prompt"), null);
  });
  assert.equal(slugInput.value, "partner-workspace");
  assert.equal(peopleInput.value, "@PartnerAdmin");
  assert.ok(screen.getByDisplayValue("design-renamed"));
  assert.deepEqual(searches, []);

  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  await screen.findByTestId("channel-overflow-unsaved-prompt");
  assert.equal(screen.queryByTestId("channel-overflow-unsaved-save"), null);
  fireEvent.click(screen.getByTestId("channel-overflow-unsaved-discard"));
  await waitFor(() => {
    assert.deepEqual(searches, [channel.id]);
    assert.equal(screen.queryByTestId("channel-overflow-sheet"), null);
  });
  assert.equal(
    postCalls.filter((call) => call.url.endsWith("/joint-invites")).length,
    invitePostsBeforeSearch,
  );
});

test("unsent Joint invite draft prompt explains the unavailable save action in Chinese", async () => {
  const channel = makeChannel({
    type: "joint",
    jointServers: [{
      serverId: "server-1",
      serverName: "Design",
      serverSlug: "design",
      role: "host",
      status: "active",
      isCurrentServer: true,
    }],
  });
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel, undefined, "zh-cn");

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  const inviteForm = await screen.findByTestId("channel-settings-joint-invite-form");
  const slugInput = inviteForm.querySelector<HTMLInputElement>('input[name="targetServerSlug"]');
  const peopleInput = inviteForm.querySelector<HTMLTextAreaElement>('textarea[name="invitedPeople"]');
  assert.ok(slugInput);
  assert.ok(peopleInput);
  fireEvent.change(slugInput, { target: { value: "partner-workspace" } });
  fireEvent.change(peopleInput, { target: { value: "@PartnerAdmin" } });

  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  const prompt = await screen.findByTestId("channel-overflow-unsaved-prompt");
  assert.ok(within(prompt).getByText(
    "Joint 邀请尚未发送。请继续编辑并发送邀请，或放弃所有未保存的修改后关闭。",
  ));
  assert.equal(
    within(prompt).queryByText("频道名称或描述有未保存的修改，关闭前要保存吗？"),
    null,
  );
  assert.equal(screen.queryByTestId("channel-overflow-unsaved-save"), null);
});

test("dirty Search runs only after save-and-close successfully persists the rename", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  const patchCalls: Array<{ url: string; body: unknown }> = [];
  const searches: string[] = [];
  const basePatch = api.patch;
  let failNextSave = true;
  api.patch = (async (url: string, body?: unknown) => {
    patchCalls.push({ url, body });
    if (url === `/channels/${channel.id}` && failNextSave) {
      failNextSave = false;
      throw new Error("save failed");
    }
    return basePatch(url, body);
  }) as typeof api.patch;
  renderChatPanel(channel, (channelId) => searches.push(channelId));

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-settings-panel");
  fireEvent.change(screen.getByDisplayValue("design"), { target: { value: "design-renamed" } });

  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  await screen.findByTestId("channel-overflow-unsaved-prompt");
  assert.deepEqual(searches, []);
  fireEvent.click(screen.getByTestId("channel-overflow-unsaved-save"));

  await screen.findByTestId("channel-settings-save-error");
  assert.deepEqual(searches, []);
  assert.ok(screen.getByTestId("channel-overflow-sheet"));
  assert.ok(screen.getByTestId("channel-overflow-unsaved-prompt"));

  const saveAndClose = screen.getByTestId("channel-overflow-unsaved-save") as HTMLButtonElement;
  await waitFor(() => {
    assert.equal(saveAndClose.disabled, false);
  });
  await act(async () => {
    fireEvent.click(saveAndClose);
  });

  await waitFor(() => {
    assert.equal(screen.queryByTestId("channel-overflow-sheet"), null);
    assert.deepEqual(searches, [channel.id]);
  });
  assert.ok(patchCalls.some((call) =>
    call.url === `/channels/${channel.id}`
    && (call.body as { name?: string }).name === "design-renamed"));
});

test("clean settings state allows outside-press dismissal of the overflow drawer", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("channel-overflow-sheet"));
  });
});

test("members strip dashed add tile lands directly in the add flow — inside the drawer, no Modal", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [
      makeHuman({ userId: "owner-1", name: "owner", role: "owner" }),
      makeHuman({ userId: "human-candidate", name: "human-candidate", displayName: "Candidate Human" }),
    ],
  });
  useAgentStore.setState({
    agents: [makeAgent({ id: "agent-candidate", name: "agent-candidate", displayName: "Candidate Agent" })],
    agentActivities: {},
  });
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  const sheet = await screen.findByTestId("channel-overflow-sheet");

  // v2: the strip's dashed pink 「+」 tile skips the roster and opens
  // the staged add flow directly (one hop fewer than the count row).
  fireEvent.click(await screen.findByTestId("channel-overflow-members-add-tile"));
  const confirm = await screen.findByTestId("add-member-confirm");
  assert.ok(sheet.contains(confirm));
  assert.ok(!document.querySelector('[class*="bg-black/60"]'));

  // The add flow's own ‹ back returns to the roster, not the root.
  fireEvent.click(screen.getByTestId("add-member-back"));
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("add-member-confirm"));
  });
  assert.ok(screen.getByTestId("member-page"));
});

test("members entry row shows the human/agent split count", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  let memberRequestCount = 0;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      memberRequestCount += 1;
      return {
        data: {
          // ChannelHuman carries `id` — ChannelMembers uses it as the row key.
          humans: [{
            ...makeHuman({
              userId: "owner-1",
              name: "owner",
              role: "owner",
              avatarUrl: "/avatars/users/a1b2c3.webp",
            }),
            id: "owner-1",
          }],
          agents: [makeAgent({
            id: "agent-1",
            name: "agent-1",
            avatarUrl: "pixel:random:strip-agent",
          })],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  // ChatPanel needs the roster for mentions anyway, so it prefetches once on
  // page mount. The closed drawer consumes that same result and warms avatar
  // images without issuing a second, open-time request.
  await waitFor(() => assert.equal(memberRequestCount, 1));
  const preloader = await screen.findByTestId("channel-overflow-avatar-preloader");
  assert.equal(
    preloader.querySelector('img[src="/avatars/users/a1b2c3.webp"]')?.getAttribute("src"),
    "/avatars/users/a1b2c3.webp",
  );

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  const entry = await screen.findByTestId("channel-overflow-members-entry");

  await waitFor(() => {
    // ICU plural: singular forms, not "1 humans · 1 agents".
    assert.ok(entry.textContent?.includes("1 human · 1 agent"));
  });
  assert.equal(memberRequestCount, 1, "opening the settings drawer must reuse the prefetched roster");
  assert.ok(entry.textContent?.includes("Members"));
  // No combined total on the entry row.
  assert.ok(!entry.textContent?.includes("Members (2)"));

  // The compact strip must use the same canonical avatar renderer as the
  // full member list. Human uploads render as their real image; pixel-agent
  // identities render the sprite instead of treating `pixel:*` as an image
  // URL (the old hand-rolled tiles did exactly that).
  const strip = screen.getByTestId("channel-overflow-members-strip");
  const humanTile = strip.querySelector<HTMLButtonElement>('[data-kind="human"]');
  const agentTile = strip.querySelector<HTMLButtonElement>('[data-kind="agent"]');
  assert.equal(humanTile?.getAttribute("title"), null);
  assert.equal(agentTile?.getAttribute("title"), null);
  assert.equal(humanTile?.getAttribute("aria-label"), "owner");
  assert.equal(agentTile?.getAttribute("aria-label"), "agent-1");
  assert.equal(humanTile?.querySelector("img")?.getAttribute("src"), "/avatars/users/a1b2c3.webp");
  assert.ok(agentTile?.querySelector("[data-cell-size]"));
  assert.equal(agentTile?.querySelector('img[src="pixel:random:strip-agent"]'), null);
});

test("members page stays in loading state until the prefetched roster is settled", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  let memberRequestCount = 0;
  let resolveMembers!: (value: {
    data: {
      humans: Array<ServerMember & { id: string }>;
      agents: Agent[];
    };
  }) => void;
  const memberResponse = new Promise<{
    data: {
      humans: Array<ServerMember & { id: string }>;
      agents: Agent[];
    };
  }>((resolve) => {
    resolveMembers = resolve;
  });
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      memberRequestCount += 1;
      return memberResponse;
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  await openMembersPageInDrawer();

  // Loading is a first-class state: an unresolved request is never exposed
  // as the user-visible, semantically different result "0 / No members".
  assert.ok(screen.getByTestId("member-page-loading"));
  assert.ok(screen.getByTestId("member-page-count-loading"));
  assert.equal(screen.queryByTestId("member-page-count"), null);
  assert.equal(screen.queryByText("No members"), null);
  assert.equal((screen.getByTestId("member-page-search") as HTMLInputElement).disabled, true);
  assert.equal(screen.queryByTestId("member-page-add"), null);
  assert.equal(memberRequestCount, 1, "the page must join ChatPanel's roster request, not start another one");

  await act(async () => {
    resolveMembers({
      data: {
        humans: [{
          ...makeHuman({ userId: "owner-1", name: "owner", role: "owner" }),
          id: "owner-1",
        }],
        agents: [makeAgent({ id: "agent-1", name: "agent-1" })],
      },
    });
    await memberResponse;
  });

  await screen.findByText("owner");
  assert.equal(screen.queryByTestId("member-page-loading"), null);
  assert.equal(screen.getByTestId("member-page-count").textContent, "2");
  assert.equal((screen.getByTestId("member-page-search") as HTMLInputElement).disabled, false);
  assert.equal(screen.queryByText("No members"), null);
  assert.equal(memberRequestCount, 1, "opening Members must reuse the settled prefetched roster too");
});

test("members strip fills at most three responsive rows and keeps +N plus Add visible", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  const humans = Array.from({ length: 20 }, (_, index) => ({
    ...makeHuman({
      userId: `human-${index + 1}`,
      name: `human-${index + 1}`,
    }),
    id: `human-${index + 1}`,
  }));
  const agents = Array.from({ length: 10 }, (_, index) => makeAgent({
    id: `agent-${index + 1}`,
    name: `agent-${index + 1}`,
  }));
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return { data: { humans, agents } };
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  const grid = await screen.findByTestId("channel-overflow-members-grid");
  await waitFor(() => {
    assert.equal(grid.querySelectorAll("[data-kind]").length, 19);
  });

  // jsdom has no layout width, so the component's stable seven-column
  // fallback exercises the same capacity math: 3×7 slots, with two slots
  // reserved for +N and Add when the roster overflows.
  assert.equal(grid.getAttribute("data-max-rows"), "3");
  assert.equal(grid.getAttribute("data-column-count"), "7");
  assert.ok(grid.className.includes("flex-wrap"));
  // Capacity math already limits the rendered slots to three rows. Let those
  // rows define the natural block size so AvatarBadge can overflow without a
  // second, geometry-coupled CSS clipping contract.
  assert.ok(!grid.className.includes("max-h-"));
  assert.ok(!grid.className.includes("overflow-hidden"));
  assert.ok(!grid.className.includes("4.75px"));
  const heading = screen.getByTestId("channel-overflow-members-heading");
  assert.equal(heading.textContent, "Members");
  assert.equal(heading.getAttribute("role"), "heading");
  assert.equal(heading.getAttribute("aria-level"), "3");
  assert.ok(heading.className.includes("text-base"));
  assert.ok(heading.className.includes("font-bold"));
  assert.ok(heading.className.includes("text-black"));
  assert.equal(screen.getByTestId("channel-overflow-members-more").textContent, "+11");
  assert.ok(grid.contains(screen.getByTestId("channel-overflow-members-add-tile")));
});

test("members entry swaps the drawer into the members page — same size, root stays mounted, ‹ back returns, no X", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  const sheet = await screen.findByTestId("channel-overflow-sheet");

  // Dirty the settings draft — it must survive root → members → back.
  fireEvent.change(screen.getByDisplayValue("design"), { target: { value: "design-renamed" } });

  fireEvent.click(screen.getByTestId("channel-overflow-members-entry"));
  const page = await screen.findByTestId("member-page");

  // Page navigation INSIDE the drawer: the sheet stays open at the same
  // size, and the members page renders inside it.
  assert.ok(sheet.contains(page));
  assert.ok(sheet.className.includes("max-w-[min(100vw,34rem)]"));
  for (const headerButton of [
    screen.getByTestId("member-page-back"),
  ]) {
    assert.ok(headerButton.className.includes("btn-brutal-sm"));
    assert.ok(headerButton.className.includes("size-7"));
    assert.ok(headerButton.className.includes("bg-white"));
  }
  // Root content stays mounted but hidden (draft survival).
  const settingsPanel = screen.getByTestId("channel-settings-panel");
  assert.ok(settingsPanel.closest(".hidden"));

  // ‹ back (top-left of the members page) returns to the drawer root —
  // the settings panel is visible again with the draft intact.
  fireEvent.click(screen.getByTestId("member-page-back"));
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("member-page"));
  });
  assert.ok(screen.getByTestId("channel-overflow-sheet"));
  assert.ok(!screen.getByTestId("channel-settings-panel").closest(".hidden"));
  assert.ok(screen.getByDisplayValue("design-renamed"));

  // The explicit X is intentionally absent. The drawer still supports its
  // standard outside-press dismissal after the user returns to the root.
  assert.equal(screen.queryByTestId("member-page-close"), null);
  fireEvent.pointerDown(document.body);
  fireEvent.click(document.body);
  await screen.findByTestId("channel-overflow-unsaved-prompt");
  fireEvent.click(screen.getByTestId("channel-overflow-unsaved-discard"));
  await waitFor(() => {
    assert.ok(!screen.queryByTestId("channel-overflow-sheet"));
  });
  assert.ok(!screen.queryByTestId("member-page"));
});

test("members page keeps its roster state under an in-drawer profile page; Back restores it", async () => {
  const channel = makeChannel();
  const nestedAgent = makeAgent({ id: "nested-agent", name: "nested-agent" });
  seedBaseStores(channel);
  useAgentStore.setState({ agents: [nestedAgent], agentActivities: {} });
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [{ ...makeHuman({ userId: "owner-1", name: "owner", role: "owner" }), id: "owner-1" }],
          agents: [makeAgent({ id: "agent-1", name: "agent-1", serverRole: "admin" })],
        },
      };
    }
    if (url === "/servers/server-1/members/owner-1/profile") {
      return {
        data: {
          ...makeHuman({ userId: "owner-1", name: "owner", role: "owner" }),
          membershipStatus: "active",
          createdAgents: [nestedAgent],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  await openMembersPageInDrawer();

  await waitFor(() => {
    assert.ok(screen.getByTestId("member-page-section-humans").textContent?.includes("1"));
  });
  assert.equal(screen.getByTestId("member-page-section-humans").textContent, "Humans · 1");
  assert.equal(screen.getByTestId("member-page-section-agents").textContent, "Agents · 1");
  assert.equal(screen.getByTestId("member-page-count").textContent, "2");
  // Server Owner/Admin and explicit local admins share the minimal
  // user-facing label. Ordinary members render no role badge.
  const adminBadges = screen.getAllByTestId("member-page-role-channel-admin");
  assert.deepEqual(adminBadges.map((badge) => badge.textContent), ["Channel Admin", "Channel Admin"]);
  const adminTrailing = adminBadges[1]?.closest("[data-testid='member-page-trailing']");
  assert.ok(adminTrailing, "the agent role needs the shared trailing column");
  assert.match(adminTrailing.className, /md:grid/);
  assert.equal(adminTrailing.children.length, 2);
  for (const cell of adminTrailing.children) {
    assert.match((cell as HTMLElement).className, /md:col-start-1/);
    assert.match((cell as HTMLElement).className, /md:row-start-1/);
  }

  // Both Raft UI disclosures start open. Closing Humans hides only its panel;
  // Agents stays open, then reopening restores the profile-row interaction.
  const memberPage = screen.getByTestId("member-page");
  const humansToggle = screen.getByTestId("member-page-section-humans-toggle");
  const agentsToggle = screen.getByTestId("member-page-section-agents-toggle");
  assert.equal(humansToggle.getAttribute("aria-expanded"), "true");
  assert.equal(agentsToggle.getAttribute("aria-expanded"), "true");
  assert.ok(humansToggle.querySelector('[data-slot="sidebar-section-chevron"]'));
  fireEvent.click(humansToggle);
  await waitFor(() => assert.equal(humansToggle.getAttribute("aria-expanded"), "false"));
  assert.equal(within(memberPage).queryByRole("button", { name: /^owner/ }), null);
  assert.ok(within(memberPage).getByRole("button", { name: /^agent-1/ }));
  fireEvent.click(humansToggle);
  await waitFor(() => {
    assert.ok(within(memberPage).getByRole("button", { name: /^owner/ }));
  });

  // The live roster query is part of the previous page state and must
  // survive member → profile → Back, rather than being recreated blank.
  fireEvent.change(screen.getByTestId("member-page-search"), { target: { value: "own" } });

  // Row click → a THIRD page inside the same fixed drawer. ^owner skips
  // the row's "Remove owner" control (a sibling button, not the profile
  // target). The global profile overlay/store stays untouched: otherwise
  // the modal drawer would have to close and the actual previous page would
  // be lost.
  fireEvent.click(
    within(memberPage).getByRole("button", { name: /^owner/ }),
  );
  const profile = await screen.findByTestId("profile-panel");
  const sheet = screen.getByTestId("channel-overflow-sheet");
  assert.ok(sheet.contains(profile));
  assert.equal(profile.getAttribute("data-presentation"), "embedded");
  assert.equal(useProfileStore.getState().profileType, null);
  assert.equal(useProfileStore.getState().profileId, null);
  // Previous page stays mounted but hidden so query/disclosure/scroll state
  // remain real state, not a guessed reconstruction.
  assert.ok(screen.getByTestId("member-page").className.includes("hidden"));

  // Existing links inside a profile stay in the same page stack too. Opening
  // a created Agent adds one level; its Back returns to the human before the
  // human Back returns to Members. The global overlay remains untouched.
  const nestedAgentLink = await within(profile).findByRole("button", { name: /^nested-agent/ });
  fireEvent.click(nestedAgentLink);
  const nestedBack = await screen.findByTestId("agent-mobile-back");
  assert.ok(!nestedBack.className.includes("md:hidden"));
  assert.equal(useProfileStore.getState().profileType, null);
  fireEvent.click(nestedBack);

  const profileBack = await screen.findByTestId("human-mobile-back");
  assert.ok(!profileBack.className.includes("md:hidden"), "in-drawer Back stays visible on desktop");
  fireEvent.click(profileBack);
  await waitFor(() => assert.ok(!screen.queryByTestId("profile-panel")));
  const restoredPage = screen.getByTestId("member-page");
  assert.ok(!restoredPage.className.includes("hidden"));
  assert.equal((screen.getByTestId("member-page-search") as HTMLInputElement).value, "own");
  assert.ok(within(restoredPage).getByRole("button", { name: /^owner/ }));

  // Back and Close are distinct: reopen the profile, then the explicit X
  // exits the whole drawer instead of returning to Members.
  fireEvent.click(within(restoredPage).getByRole("button", { name: /^owner/ }));
  const reopenedProfile = await screen.findByTestId("profile-panel");
  const profileClose = within(reopenedProfile).getByTitle("Close");
  assert.ok(!profileClose.className.includes("md:flex"), "in-drawer Close remains available on mobile");
  fireEvent.click(profileClose);
  await waitFor(() => assert.ok(!screen.queryByTestId("channel-overflow-sheet")));
});

test("members page search filters both sections live", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [
            { ...makeHuman({ userId: "owner-1", name: "owner", role: "owner" }), id: "owner-1" },
            { ...makeHuman({ userId: "human-2", name: "xxchan" }), id: "human-2" },
          ],
          agents: [makeAgent({ id: "agent-1", name: "agent-1" })],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  await screen.findByText("xxchan");

  fireEvent.change(screen.getByTestId("member-page-search"), { target: { value: "xxc" } });
  await waitFor(() => {
    assert.ok(!screen.queryByText("owner"));
  });
  assert.ok(screen.getByText("xxchan"));
  assert.ok(!screen.queryByText("agent-1"));
  // Filtered-out sections drop their headers; the survivors recount.
  assert.equal(screen.getByTestId("member-page-section-humans").textContent, "Humans · 1");
  assert.ok(!screen.queryByTestId("member-page-section-agents"));

  fireEvent.change(screen.getByTestId("member-page-search"), { target: { value: "zzz" } });
  await waitFor(() => {
    assert.ok(screen.getByText(/No matches/));
  });
});

test("members can add channel members but cannot remove them", async () => {
  const channel = makeChannel();
  seedBaseStores(channel, "member");
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "ordinary", role: "member" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [{ ...makeHuman({ userId: "owner-1", name: "ordinary", role: "member" }), id: "owner-1" }],
          agents: [],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  await screen.findByText("ordinary");

  assert.ok(screen.getByTestId("member-page-add"));
  assert.ok(!screen.queryByLabelText("Remove ordinary"));
});

test("channel admin sees minimal Admin state and can promote an eligible member", async () => {
  const channel = makeChannel({
    channelRole: "admin",
    channelAdminBasis: "channel_role",
    channelCapabilities: {
      editChannelMetadata: true,
      archiveChannels: true,
      addChannelMembers: true,
      removeChannelMembers: true,
      changeChannelMemberRoles: true,
      deleteChannels: false,
      changeChannelVisibility: false,
      federateChannels: false,
    },
  });
  seedBaseStores(channel, "member");
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "local-admin", role: "member" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [{
            ...makeHuman({ userId: "peer-1", name: "peer", role: "member" }),
            id: "peer-1",
            serverRole: "member",
            channelRole: "member",
            effectiveChannelRole: "member",
            channelAdminBasis: null,
            canChangeChannelRole: true,
          }],
          agents: [],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  const patchCalls: Array<{ url: string; body: unknown }> = [];
  api.patch = (async (url: string, body?: unknown) => {
    patchCalls.push({ url, body });
    return { data: { changed: true } };
  }) as typeof api.patch;
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  const promote = await screen.findByRole("button", { name: "Make peer a channel admin" });
  fireEvent.click(promote);
  await waitFor(() => assert.equal(patchCalls.length, 1));
  assert.deepEqual(patchCalls[0], {
    url: `/channels/${channel.id}/members/user/peer-1/role`,
    body: { role: "admin" },
  });
});

test("channel-manager role-action gate hides promote and demote without removing other manager actions", async () => {
  const channel = makeChannel({
    channelRole: "admin",
    channelAdminBasis: "channel_role",
    channelCapabilities: {
      editChannelMetadata: true,
      archiveChannels: true,
      addChannelMembers: true,
      removeChannelMembers: true,
      changeChannelMemberRoles: true,
      deleteChannels: false,
      changeChannelVisibility: false,
      federateChannels: false,
    },
  });
  seedBaseStores(channel, "member");
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "local-admin", role: "member" })],
  });
  mockApis({ flagEnabled: true, roleActionsEnabled: false });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [
            {
              ...makeHuman({ userId: "peer-1", name: "peer", role: "member" }),
              id: "peer-1",
              serverRole: "member",
              channelRole: "member",
              effectiveChannelRole: "member",
              channelAdminBasis: null,
              canChangeChannelRole: true,
            },
            {
              ...makeHuman({ userId: "manager-1", name: "manager", role: "member" }),
              id: "manager-1",
              serverRole: "member",
              channelRole: "admin",
              effectiveChannelRole: "admin",
              channelAdminBasis: "channel_role",
              canChangeChannelRole: true,
            },
          ],
          agents: [],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  await screen.findByText("peer");
  assert.ok(!screen.queryByRole("button", { name: "Make peer a channel admin" }));
  assert.ok(!screen.queryByRole("button", { name: "Remove channel admin from manager" }));
  assert.ok(screen.getByRole("button", { name: "Remove peer" }));
  assert.ok(screen.getByRole("button", { name: "Remove manager" }));
  assert.equal(screen.getByTestId("member-page-role-channel-admin").textContent, "Channel Admin");
});

test("channel role failure state renders the member role error banner", async () => {
  const channel = makeChannel({
    channelRole: "admin",
    channelAdminBasis: "channel_role",
    channelCapabilities: {
      editChannelMetadata: true,
      archiveChannels: true,
      addChannelMembers: true,
      removeChannelMembers: true,
      changeChannelMemberRoles: true,
      deleteChannels: false,
      changeChannelVisibility: false,
      federateChannels: false,
    },
  });
  seedBaseStores(channel, "member");
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "local-admin", role: "member" })],
  });
  mockApis({ flagEnabled: true });
  render(createElement(
    MemoryRouter,
    { initialEntries: [`/s/design/channel/${channel.id}`] },
    createElement(ChannelMembers, {
      channelId: channel.id,
      open: true,
      presentation: "page",
      prefetchedMembers: {
        channelAgents: [],
        channelHumans: [{
          ...makeHuman({ userId: "peer-1", name: "peer", role: "member" }),
          id: "peer-1",
          serverRole: "member",
          channelRole: "member",
          effectiveChannelRole: "member",
          channelAdminBasis: null,
          canChangeChannelRole: true,
        }],
        loading: false,
        addAgent: async () => {},
        removeAgent: async () => {},
        addHuman: async () => {},
        removeHuman: async () => {},
        changeMemberRole: async () => {},
        roleChangeFailed: true,
      },
    }),
  ));

  const error = await screen.findByTestId("channel-member-role-error");
  assert.equal(error.textContent, "Could not update this member's channel role. Try again.");
});

test("server owner/admin rows expose Demote but explain inherited authority instead of mutating", async () => {
  const channel = makeChannel({
    channelRole: "admin",
    channelAdminBasis: "channel_role",
    channelCapabilities: {
      editChannelMetadata: true,
      archiveChannels: true,
      addChannelMembers: true,
      removeChannelMembers: true,
      changeChannelMemberRoles: true,
      deleteChannels: false,
      changeChannelVisibility: false,
      federateChannels: false,
    },
  });
  seedBaseStores(channel, "member");
  useServerStore.setState({
    members: [
      makeHuman({ userId: "owner-1", name: "local-admin", role: "member" }),
      makeHuman({ userId: "server-admin-1", name: "server-admin", role: "admin" }),
    ],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [{
            ...makeHuman({ userId: "server-admin-1", name: "server-admin", role: "admin" }),
            id: "server-admin-1",
            serverRole: "admin",
            channelRole: "member",
            effectiveChannelRole: "admin",
            channelAdminBasis: "server_role",
            canChangeChannelRole: false,
          }],
          agents: [],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  const patchCalls: Array<{ url: string; body: unknown }> = [];
  api.patch = (async (url: string, body?: unknown) => {
    patchCalls.push({ url, body });
    return { data: { changed: true } };
  }) as typeof api.patch;
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  assert.equal(screen.getByTestId("member-page-role-channel-admin").textContent, "Channel Admin");
  const demote = await screen.findByRole("button", { name: "Remove channel admin from server-admin" });
  assert.equal(demote.textContent, "Demote");
  fireEvent.click(demote);

  const dialog = await screen.findByRole("dialog", { name: "Can't demote server admins" });
  assert.match(dialog.textContent ?? "", /server owner or admin/);
  assert.equal(patchCalls.length, 0);
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Can't demote server admins" }), null));
});

test("members page remove control runs the same confirm flow as the old drawer list", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [{ ...makeHuman({ userId: "owner-1", name: "owner", role: "owner" }), id: "owner-1" }],
          agents: [makeAgent({ id: "agent-1", name: "agent-1" })],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  const deleteCalls: string[] = [];
  api.delete = (async (url: string) => {
    deleteCalls.push(url);
    return { data: {} };
  }) as typeof api.delete;
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  await screen.findByText("agent-1");

  // Manager (owner) sees the remove control on BOTH sections.
  assert.ok(screen.getByLabelText("Remove owner"));
  assert.ok(screen.getByLabelText("Remove agent-1"));

  // Confirm → DELETE through useChannelMembers.removeHuman — the
  // control is a sibling of the row's profile button, so this click
  // must NOT open a profile.
  fireEvent.click(screen.getByLabelText("Remove owner"));
  await screen.findByText(/owner will stop receiving ordinary delivery from #design/);
  assert.equal(useProfileStore.getState().profileId, null);
  // Desktop and mobile use the same shared confirmation dialog. The Drawer
  // remains mounted behind it, while the dialog portals to the shared modal
  // layer instead of becoming a breakpoint-specific sheet.
  const removeDialog = screen.getByRole("dialog", { name: /remove member/i });
  const drawer = screen.getByTestId("channel-overflow-sheet");
  assert.ok(!drawer.contains(removeDialog));
  assert.equal(screen.getAllByRole("dialog", { name: /remove member/i }).length, 1);
  const removeButton = within(removeDialog).getByRole("button", { name: "Remove" });
  const cancelButton = within(removeDialog).getByRole("button", { name: "Cancel" });
  assert.ok(removeButton.classList.contains("h-6"));
  assert.ok(cancelButton.classList.contains("h-6"));
  fireEvent.click(removeButton);
  await waitFor(() => {
    assert.ok(deleteCalls.includes(`/channels/${channel.id}/members/user/owner-1`));
  });

  // Cancel path: stages the dialog, dismisses without a DELETE. Scoped —
  // the hidden root view's settings form also has a Cancel button.
  fireEvent.click(screen.getByLabelText("Remove agent-1"));
  const dialog = await screen.findByRole("dialog", { name: /remove member/i });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    assert.ok(!screen.queryByRole("dialog", { name: /remove member/i }));
  });
  assert.ok(!deleteCalls.includes(`/channels/${channel.id}/members/agent/agent-1`));
});

test("members page removal dialog is one complete Chinese surface", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [{ ...makeHuman({ userId: "owner-1", name: "owner", role: "owner" }), id: "owner-1" }],
          agents: [],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;

  renderWithIntl(
    createElement(
      MemoryRouter,
      { initialEntries: [`/s/design/channel/${channel.id}`] },
      createElement(ChatPanel, { channel }),
    ),
    { locale: "zh-cn" },
  );

  await openMembersPageInDrawer();
  await screen.findByText("owner");
  fireEvent.click(screen.getByLabelText("移除 owner"));

  const dialog = await screen.findByRole("dialog", { name: "移除成员" });
  const cancel = within(dialog).getByRole("button", { name: "取消" });
  const remove = within(dialog).getByRole("button", { name: "移除" });
  assert.ok(within(dialog).getByRole("button", { name: "关闭对话框" }));
  assert.equal(within(dialog).queryByRole("button", { name: "Cancel" }), null);
  assert.equal(within(dialog).queryByRole("button", { name: "Remove" }), null);
  assert.ok(cancel.classList.contains("h-6"));
  assert.ok(remove.classList.contains("h-6"));
});

test("members page joint-channel rows badge remote members and skip their remove control", async () => {
  const channel = makeChannel({ type: "joint" });
  seedBaseStores(channel);
  useServerStore.setState({
    members: [makeHuman({ userId: "owner-1", name: "owner", role: "owner" })],
  });
  mockApis({ flagEnabled: true });
  const mockedGet = api.get;
  api.get = (async (url: string) => {
    if (url === `/channels/${channel.id}/members`) {
      return {
        data: {
          humans: [
            { ...makeHuman({ userId: "owner-1", name: "owner", role: "owner" }), id: "owner-1" },
            {
              ...makeHuman({ userId: "human-remote", name: "remote-human", serverId: "server-2" }),
              id: "human-remote",
              serverName: "Peer",
            },
          ],
          agents: [],
        },
      };
    }
    return mockedGet(url);
  }) as typeof api.get;
  renderChatPanel(channel);

  await openMembersPageInDrawer();
  await screen.findByText("remote-human");

  // Remote-server member carries the peer badge; the local row does not.
  assert.ok(screen.getByText("Peer"));
  // Remote members are managed on their own server — no remove control
  // here even for a manager, while the LOCAL member keeps it.
  assert.ok(!screen.queryByLabelText("Remove remote-human"));
  assert.ok(screen.getByLabelText("Remove owner"));
});

test("#all with hidden humans has no members entry row in the drawer", async () => {
  const channel = makeChannel({ name: "all" });
  seedBaseStores(channel, "member");
  useServerStore.setState({
    current: { ...makeServer("member"), hideHumansFromMembers: true },
  });
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  assert.ok(!screen.queryByTestId("channel-overflow-members-entry"));
});

test("channel overflow keeps the mobile back arrow while desktop X is removed", async () => {
  const channel = makeChannel();
  seedBaseStores(channel);
  mockApis({ flagEnabled: true });
  renderChatPanel(channel);

  fireEvent.click(await screen.findByTestId("channel-overflow-trigger"));
  await screen.findByTestId("channel-overflow-sheet");

  // Desktop X is removed; the responsive mobile back/close arrow remains in
  // the DOM for the full-screen drawer layout.
  assert.equal(screen.getAllByLabelText("Close channel details and settings").length, 1);
  assert.ok(!screen.queryByLabelText("Close channel settings"));

  cleanup();

  useThreadStore.setState({ followedThreads: [] });
  useMessageStore.setState({ unreadCounts: {} });
  render(
    createElement(ThreadOverflowMenu, {
      threadChannelId: "thread-channel-1",
      parentMessageId: "parent-message-1",
      viewInChannelLabel: "View in channel",
      onViewInChannel: () => {},
      onSearch: () => {},
    }),
  );
  fireEvent.click(await screen.findByTestId("thread-overflow-trigger"));
  await screen.findByTestId("thread-overflow-menu");
  assert.ok(!screen.queryByTestId("thread-overflow-sheet"));
  assert.ok(!screen.queryByLabelText("Close thread actions"));
  assert.ok(!screen.queryByLabelText("Close channel settings"));
});
