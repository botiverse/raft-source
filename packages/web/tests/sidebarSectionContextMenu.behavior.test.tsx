import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import Sidebar, {
  getSidebarDropIndicatorEdge,
  getWorkspaceSidebarReorderScope,
  isSidebarCollisionCandidate,
  reorderSidebarSubset,
} from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import { sidebarJoinedChannelsOnlyStorageKey } from "../src/components/layout/sidebarChannelVisibility";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";

const originalApiGet = api.get;
const originalApiPatch = api.patch;

globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

afterEach(() => {
  api.get = originalApiGet;
  api.patch = originalApiPatch;
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

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") return { data: [] };
    return { data: [] };
  }) as typeof api.get;
  api.patch = (async () => ({ data: {} })) as typeof api.patch;
}

function seedSidebar() {
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
      createdAt: "2026-07-12T00:00:00.000Z",
    },
    servers: [],
    members: [],
    loading: false,
    sidebarOrder: {
      channelOrder: ["joined-channel", "unjoined-channel"],
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
      customSections: [],
      sectionOrder: ["system:pinned", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [],
      sectionsVersion: 0,
      pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({
    channels: [
      {
        id: "joined-channel",
        serverId: "server-1",
        name: "joined-channel",
        type: "public",
        joined: true,
        archivedAt: null,
        createdAt: "2026-07-12T00:00:00.000Z",
      },
      {
        id: "unjoined-channel",
        serverId: "server-1",
        name: "unjoined-channel",
        type: "public",
        joined: false,
        archivedAt: null,
        createdAt: "2026-07-12T00:00:00.000Z",
      },
    ],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
}

function renderSidebar(
  initialEntry = "/s/server/channel/joined-channel",
  workspaceRailMode?: "humans",
) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TestIntlProvider>
        <Sidebar mobileInline workspaceRailMode={workspaceRailMode} />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function assertSectionDescriptionTypography(text: string) {
  const description = screen.getByText(text).closest<HTMLElement>("[data-sidebar-section-description]");
  assert.ok(description, `${text} must use the Sidebar section-description primitive`);
  assert.match(description.className, /(?:^|\s)text-xs(?:\s|$)/);
  assert.match(description.className, /(?:^|\s)font-mono(?:\s|$)/);
  assert.match(description.className, /(?:^|\s)leading-snug(?:\s|$)/);
}

test("sidebar empty and help descriptions share one typography contract across rails", () => {
  seedSidebar();
  renderSidebar();

  assertSectionDescriptionTypography("Drag channels or DMs here to pin");
  assertSectionDescriptionTypography("No joint channels yet");

  cleanup();
  seedSidebar();
  renderSidebar("/s/server/members");

  assertSectionDescriptionTypography("No agents yet");

  cleanup();
  seedSidebar();
  useWorkspaceGridNavigationStore.setState({ active: true, enabled: true, railMode: "humans" });
  renderSidebar("/s/server", "humans");

  assertSectionDescriptionTypography("No humans");

  cleanup();
  seedSidebar();
  renderSidebar("/s/server/computers");

  assertSectionDescriptionTypography("No computers yet");
});

test("sidebar sections own their create actions and joint channels remain visible while empty", () => {
  seedSidebar();
  renderSidebar();

  assert.ok(screen.getByTestId("sidebar-section-toggle-joint-channels"));
  assert.ok(screen.getByText("No joint channels yet"));
  assert.equal(screen.queryByText("No channels yet"), null);
  assert.ok(screen.getByRole("button", { name: "Create Channel" }));
  assert.ok(screen.getByRole("button", { name: "Create Joint Channel" }));

  fireEvent.contextMenu(screen.getByRole("button", { name: "Create Joint Channel" }));
  const jointMenu = screen.getByRole("menu", { name: "Joint Channels options" });
  assert.ok(jointMenu);
  const jointItems = Array.from(jointMenu.querySelectorAll('[role^="menuitem"]'));
  assert.ok(jointItems.some((item) => item.textContent?.trim() === "New section…"));
  assert.equal(jointItems.some((item) => item.textContent?.trim() === "Manage sections…"), false);
  assert.equal(jointItems.some((item) => item.textContent?.trim() === "Reorder sections"), false);
  assert.ok(jointItems.some((item) => item.textContent?.trim() === "Create Joint Channel"));
  assert.equal(screen.getAllByRole("menuitemradio").length, 3);
});

test("pinned titles and the joint sort control route to their matching menus", () => {
  seedSidebar();
  useServerStore.setState((state) => ({
    sidebarOrder: {
      ...state.sidebarOrder,
      pinnedChannelIds: ["joined-channel"],
    },
  } as never));
  renderSidebar();

  fireEvent.contextMenu(screen.getByText("Pinned"));
  assert.ok(screen.getByRole("menu", { name: "Pinned options" }));
  fireEvent.keyDown(document, { key: "Escape" });

  const jointSortButton = document.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-sort-menu-button"][data-sort-section="jointChannels"]',
  );
  assert.ok(jointSortButton);
  fireEvent.click(jointSortButton);
  assert.ok(screen.getByText("Recent"));
});

test("non-empty joint channels render their rows instead of the empty state", () => {
  seedSidebar();
  useChannelStore.setState((state) => ({
    channels: [
      ...state.channels,
      {
        id: "joint-channel",
        serverId: "server-1",
        name: "joint-channel",
        type: "joint",
        joined: true,
        archivedAt: null,
        createdAt: "2026-07-12T00:00:00.000Z",
      },
    ],
  } as never));
  renderSidebar();

  assert.ok(screen.getByText("joint-channel"));
  assert.equal(screen.queryByText("No joint channels yet"), null);
});

test("channels right-click menu defaults to all and persists the joined-only view per server", async () => {
  seedSidebar();
  renderSidebar();

  assert.ok(screen.getByText("joined-channel"));
  assert.ok(screen.getByText("unjoined-channel"));

  fireEvent.contextMenu(screen.getByRole("button", { name: "Create Channel" }));
  assert.ok(screen.getByRole("menu", { name: "Channels options" }));
  const joinedOnly = screen.getByRole("menuitemcheckbox", { name: "Show joined channels only" });
  assert.equal(joinedOnly.getAttribute("aria-checked"), "false");
  const channelMenu = screen.getByRole("menu", { name: "Channels options" });
  const channelItems = Array.from(channelMenu.querySelectorAll('[role^="menuitem"]'));
  assert.ok(channelItems.some((item) => item.textContent?.trim() === "Create Channel"));
  assert.ok((channelMenu.textContent?.indexOf("Create Channel") ?? -1) < (channelMenu.textContent?.indexOf("Sort") ?? -1));
  assert.ok((channelMenu.textContent?.indexOf("Sort") ?? -1) < (channelMenu.textContent?.indexOf("Display") ?? -1));
  assert.ok(screen.getByText("Display"));
  assert.ok(screen.getByText("Sort"));

  fireEvent.click(joinedOnly);

  await waitFor(() => assert.equal(screen.queryByText("unjoined-channel"), null));
  assert.ok(screen.getByText("joined-channel"));
  assert.equal(localStorage.getItem(sidebarJoinedChannelsOnlyStorageKey("server-1")), "true");
});

test("custom sections render mixed placement chrome and expose direct management from the full header", () => {
  seedSidebar();
  useServerStore.setState((state) => ({
    sidebarOrder: {
      ...state.sidebarOrder,
      customSections: [{ id: "project", name: "Project", emoji: "📁", sortMode: "manual" }],
      sectionOrder: ["system:pinned", "project", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [{ kind: "channel", id: "joined-channel", sectionId: "project", position: 0 }],
    },
  } as never));
  renderSidebar();

  const customSection = screen.getByTestId("sidebar-custom-section-project");
  assert.ok(customSection.textContent?.includes("Project"));
  assert.ok(customSection.textContent?.includes("joined-channel"));
  const channelRow = customSection.querySelector('button[data-sidebar-channel-id="joined-channel"]');
  assert.ok(channelRow);
  assert.ok(channelRow.classList.contains("items-center"));
  assert.equal(channelRow.classList.contains("items-start"), false);
  assert.ok(customSection.querySelector('[data-sidebar-dnd-container="sidebar:container:custom:project"]'));
  fireEvent.contextMenu(customSection.querySelector("button")!);
  const menu = screen.getByRole("menu", { name: "Project options" });
  assert.ok(menu.textContent?.includes("New section…"));
  assert.equal(menu.textContent?.includes("Manage sections…"), false);
  assert.ok(menu.textContent?.includes("Rename / change icon…"));
  assert.ok(menu.textContent?.includes("Delete section"));
  assert.ok((menu.textContent?.indexOf("Rename / change icon…") ?? -1) < (menu.textContent?.indexOf("New section…") ?? -1));
  assert.ok((menu.textContent?.indexOf("New section…") ?? -1) < (menu.textContent?.indexOf("Delete section") ?? -1));
});

test("conversation menu offers only pinned and user-created sections as move destinations", () => {
  seedSidebar();
  useServerStore.setState((state) => ({
    sidebarOrder: {
      ...state.sidebarOrder,
      customSections: [{ id: "project", name: "Project", emoji: null, sortMode: "manual" }],
      sectionOrder: ["system:pinned", "project", "system:joint", "system:channels", "system:dms"],
    },
  } as never));
  renderSidebar();

  fireEvent.contextMenu(screen.getByText("unjoined-channel"));
  const moveTrigger = screen.getByRole("menuitem", { name: "Move to section" });
  assert.equal(moveTrigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(moveTrigger.getAttribute("aria-expanded"), "false");
  fireEvent.click(moveTrigger);
  const menu = screen.getByRole("menu", { name: "Move to section" });
  assert.ok(menu.textContent?.includes("Pinned"));
  assert.ok(menu.textContent?.includes("Project"));
  assert.ok(menu.textContent?.includes("New section…"));
  assert.equal(menu.textContent?.includes("Joint Channels"), false);
  assert.equal(menu.textContent?.includes("Direct Messages"), false);
});

test("move submenu closes when hover or keyboard focus enters another top-level action", () => {
  seedSidebar();
  useServerStore.setState((state) => ({
    sidebarOrder: {
      ...state.sidebarOrder,
      customSections: [{ id: "project", name: "Project", emoji: null, sortMode: "manual" }],
      sectionOrder: ["system:pinned", "project", "system:joint", "system:channels", "system:dms"],
    },
  } as never));
  renderSidebar();

  fireEvent.contextMenu(screen.getByText("unjoined-channel"));
  const moveTrigger = screen.getByRole("menuitem", { name: "Move to section" });
  fireEvent.mouseEnter(moveTrigger);
  assert.ok(screen.getByRole("menu", { name: "Move to section" }));

  const markUnread = screen.getByRole("menuitem", { name: "Mark as Unread" });
  fireEvent.mouseOver(markUnread);
  assert.equal(screen.queryByRole("menu", { name: "Move to section" }), null);
  assert.equal(moveTrigger.getAttribute("aria-expanded"), "false");

  fireEvent.click(moveTrigger);
  assert.ok(screen.getByRole("menu", { name: "Move to section" }));
  fireEvent.focus(markUnread);
  assert.equal(screen.queryByRole("menu", { name: "Move to section" }), null);
});

test("moving a channel updates the rendered custom and fallback projections", async () => {
  seedSidebar();
  useServerStore.setState((state) => ({
    sidebarOrder: {
      ...state.sidebarOrder,
      customSections: [{ id: "project", name: "Project", emoji: null, sortMode: "manual" }],
      sectionOrder: ["system:pinned", "project", "system:joint", "system:channels", "system:dms"],
    },
  } as never));
  renderSidebar();

  fireEvent.contextMenu(screen.getByText("joined-channel"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move to section" }));
  fireEvent.click(within(screen.getByRole("menu", { name: "Move to section" })).getByRole("menuitem", { name: "Project" }));

  await waitFor(() => {
    const customSection = screen.getByTestId("sidebar-custom-section-project");
    assert.ok(customSection.textContent?.includes("joined-channel"));
  });
  assert.equal(screen.getAllByText("joined-channel").length, 1);
});

test("custom sections accept direct-message channel placements", () => {
  seedSidebar();
  useChannelStore.setState({
    dmChannels: [{
      id: "dm-alice",
      serverId: "server-1",
      name: "dm-alice",
      type: "dm",
      peerType: "user",
      peerId: "alice",
      peerName: "alice",
      peerDisplayName: "Alice",
      peerDescription: "Alice profile description",
      archivedAt: null,
      createdAt: "2026-07-12T00:00:00.000Z",
    }],
    loading: false,
  } as never);
  useServerStore.setState((state) => ({
    sidebarOrder: {
      ...state.sidebarOrder,
      customSections: [{ id: "project", name: "Project", emoji: null, sortMode: "manual" }],
      sectionOrder: ["system:pinned", "project", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [{ kind: "channel", id: "dm-alice", sectionId: "project", position: 0 }],
    },
  } as never));
  renderSidebar();

  const customSection = screen.getByTestId("sidebar-custom-section-project");
  assert.ok(customSection.textContent?.includes("Alice"));
  assert.equal(customSection.textContent?.includes("Alice profile description"), false);
  const dmRow = customSection.querySelector('button[data-sidebar-channel-id="dm-alice"]');
  assert.ok(dmRow);
  assert.ok(dmRow.classList.contains("items-center"));
  assert.equal(dmRow.classList.contains("items-start"), false);
  const dmSection = screen.getByTestId("sidebar-section-toggle-dms");
  assert.ok(dmSection.textContent?.endsWith("0"));
});

test("every section context menu can create a custom section", async () => {
  seedSidebar();
  renderSidebar();

  fireEvent.contextMenu(screen.getByTestId("sidebar-section-toggle-joint-channels"));
  fireEvent.click(screen.getByRole("menuitem", { name: "New section…" }));
  fireEvent.change(screen.getByPlaceholderText("My Project"), { target: { value: "Launch" } });
  assert.equal(screen.queryByPlaceholderText("📁"), null);
  assert.equal(screen.queryByRole("dialog", { name: "Choose section emoji" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Choose section emoji" }));
  const emojiPicker = screen.getByRole("dialog", { name: "Choose section emoji" });
  assert.ok(await within(emojiPicker).findByRole("textbox", { name: "Type to search for an emoji" }));
  fireEvent.click(screen.getByRole("button", { name: "Choose section emoji" }));
  fireEvent.click(screen.getByRole("button", { name: "Create section" }));

  await waitFor(() => {
    assert.ok(screen.getByText("Launch"));
  });
  assert.equal(screen.queryByText("🚀"), null);
});

test("blank chat sidebar space opens only target-free creation and section actions", () => {
  seedSidebar();
  renderSidebar();

  fireEvent.contextMenu(screen.getByTestId("sidebar-scroll-surface"), {
    clientX: 40,
    clientY: 500,
  });

  const menu = screen.getByRole("menu", { name: "Sidebar options" });
  assert.ok(within(menu).getByRole("menuitem", { name: "Create Channel" }));
  assert.ok(within(menu).getByRole("menuitem", { name: "Create Joint Channel" }));
  assert.ok(within(menu).getByRole("menuitem", { name: "New section…" }));
  assert.equal(within(menu).queryByRole("menuitem", { name: "Manage sections…" }), null);
  assert.equal(within(menu).queryByText("Sort"), null);
  assert.equal(within(menu).queryByRole("menuitem", { name: "Move to section" }), null);
  assert.equal(within(menu).queryByRole("menuitem", { name: "Rename / change icon…" }), null);
});

test("section headers are direct drag activators in persisted visual order", () => {
  seedSidebar();
  useServerStore.setState((state) => ({
    sidebarOrder: {
      ...state.sidebarOrder,
      customSections: [{ id: "project", name: "Project", emoji: "📁", sortMode: "manual" }],
      sectionOrder: ["system:dms", "project", "system:channels", "system:joint", "system:pinned"],
    },
  } as never));
  renderSidebar();

  assert.equal(screen.getByTestId("sidebar-section-block-dms").style.order, "0");
  assert.equal(screen.getByTestId("sidebar-custom-section-project").style.order, "1");
  assert.equal(screen.getByTestId("sidebar-section-block-channels").style.order, "2");

  for (const section of [
    screen.getByTestId("sidebar-section-block-dms"),
    screen.getByTestId("sidebar-custom-section-project"),
    screen.getByTestId("sidebar-section-block-channels"),
  ]) {
    const headerActivator = section.firstElementChild?.querySelector("button");
    assert.equal(headerActivator?.getAttribute("aria-roledescription"), "sortable");
    assert.match(headerActivator?.className ?? "", /cursor-default/);
    assert.doesNotMatch(headerActivator?.className ?? "", /cursor-grab/);
  }
  assert.equal(screen.queryByRole("button", { name: /Reorder/ }), null);
  fireEvent.contextMenu(screen.getByTestId("sidebar-section-toggle-dms"));
  assert.equal(screen.queryByRole("menuitem", { name: "Reorder sections" }), null);
});

test("item drags ignore sortable section containers during collision detection", () => {
  const sectionOrder = ["system:pinned", "project", "system:channels", "system:dms"];
  assert.equal(isSidebarCollisionCandidate("channel:one", "system:channels", sectionOrder), false);
  assert.equal(isSidebarCollisionCandidate("channel:one", "channel:two", sectionOrder), true);
  assert.equal(isSidebarCollisionCandidate("project", "system:channels", sectionOrder), true);
  assert.equal(isSidebarCollisionCandidate("project", "channel:two", sectionOrder), false);
});

test("sidebar insertion edge follows the dragged row center around the target midpoint", () => {
  assert.equal(getSidebarDropIndicatorEdge(90, 100), "before");
  assert.equal(getSidebarDropIndicatorEdge(110, 100), "after");
  assert.equal(getSidebarDropIndicatorEdge(100, 100), "after");
});

test("native Workspace reorder preserves non-sortable channel and DM positions", () => {
  assert.deepEqual(
    reorderSidebarSubset(
      ["all", "one", "joint", "two"],
      ["one", "two"],
      "two",
      "one",
    ),
    ["all", "two", "joint", "one"],
  );
  assert.deepEqual(
    reorderSidebarSubset(
      ["visible-one", "hidden", "custom", "visible-two"],
      ["visible-one", "visible-two"],
      "visible-two",
      "visible-one",
    ),
    ["visible-two", "hidden", "custom", "visible-one"],
  );
  assert.equal(reorderSidebarSubset(["one", "two"], ["one", "two"], "missing", "one"), null);
});

test("Workspace DM reorder is owned only by the visible default-DMs surface", () => {
  const options = {
    channelManualSort: true,
    jointChannelManualSort: true,
    dmManualSort: true,
    sortableChannelIds: ["channel-one", "channel-two"],
    sortableJointChannelIds: ["joint-one", "joint-two"],
    sortableDmIds: ["default-one", "default-two"],
  };

  assert.equal(getWorkspaceSidebarReorderScope("dm:default-one", "dm:default-two", options), "dms");
  assert.equal(getWorkspaceSidebarReorderScope("dm:pinned", "dm:default-two", options), null);
  assert.equal(getWorkspaceSidebarReorderScope("dm:custom", "dm:default-two", options), null);
  assert.equal(getWorkspaceSidebarReorderScope("dm:hidden", "dm:default-two", options), null);
  assert.equal(getWorkspaceSidebarReorderScope("dm:default-one", "dm:pinned", options), null);
});

test("channel empty states distinguish the all-channel and joined-only views", () => {
  seedSidebar();
  useChannelStore.setState({ channels: [] } as never);
  renderSidebar();
  assert.ok(screen.getByText("No channels yet"));
  assertSectionDescriptionTypography("No channels yet");
  cleanup();

  seedSidebar();
  localStorage.setItem(sidebarJoinedChannelsOnlyStorageKey("server-1"), "true");
  useChannelStore.setState((state) => ({
    channels: state.channels.filter((channel) => channel.joined === false),
  } as never));
  renderSidebar();
  assert.ok(screen.getByText("No joined channels"));
  assertSectionDescriptionTypography("No joined channels");
  assert.equal(screen.queryByText("No channels yet"), null);
});

test("direct-message section right-click keeps sorting but omits channel creation", () => {
  seedSidebar();
  renderSidebar();

  const dmSortButton = document.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-sort-menu-button"][data-sort-section="dms"]',
  );
  assert.ok(dmSortButton);
  fireEvent.contextMenu(dmSortButton);
  assert.ok(screen.getByRole("menu", { name: "Direct Messages options" }));
  assert.equal(screen.getAllByRole("menuitemradio").length, 3);
  assert.equal(screen.queryByRole("menuitem", { name: "Create Channel" }), null);
  assert.equal(screen.queryByRole("menuitem", { name: "Create Joint Channel" }), null);
});
