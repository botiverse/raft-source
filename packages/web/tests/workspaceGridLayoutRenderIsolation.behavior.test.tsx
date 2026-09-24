import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Actions, DockLocation, Layout, Model, TabSetNode } from "flexlayout-react";
import type { BorderNode, IJsonTabNode, ITabSetRenderValues, TabNode } from "flexlayout-react";

import api from "../src/api/client";
import Sidebar, { ComputerRow } from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { ChatPanelMessageRenderScope } from "../src/components/message/ChatPanel";
import { createWorkspaceGridPanelFactory } from "../src/components/workspace/WorkspaceGridRealPanel";
import {
  WORKSPACE_GRID_DEMO_INITIAL_MODEL,
  workspaceGridPanelTab,
  workspaceGridTabsetActionHostId,
} from "../src/components/workspace/workspaceGridDemoConfig";
import type {
  WorkspacePanelConfig,
  WorkspacePanelRef,
} from "../src/components/workspace/workspaceGridDemoConfig";
import {
  WORKSPACE_GRID_OPEN_CHANNEL_EVENT,
  WORKSPACE_GRID_OPEN_PANEL_EVENT,
} from "../src/components/workspace/workspaceGridOpenEvents";
import {
  createWorkspaceGridModel,
  getWorkspaceGridTargetTabsetId,
  hydrateWorkspaceGridPanelDisplays,
  isWorkspaceGridTabWritable,
  isWorkspaceGridActiveTabForRef,
  openWorkspaceGridPanelTab,
  selectWorkspaceGridTab,
  workspaceGridModelHasTabs,
} from "../src/components/workspace/workspaceGridModel";
import {
  DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT,
  useWorkspaceGridNavigationStore,
} from "../src/components/workspace/workspaceGridNavigationStore";
import type { User } from "../src/store/authStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import type { Task } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";
import { createRenderCounter } from "./helpers/renderCount";

const originalGet = api.get.bind(api);
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

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

globalThis.IntersectionObserver = globalThis.IntersectionObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
} as typeof IntersectionObserver;

globalThis.ResizeObserver = globalThis.ResizeObserver ?? class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;
window.ResizeObserver = window.ResizeObserver ?? globalThis.ResizeObserver;

HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 0,
    y: 0,
    width: 900,
    height: 600,
    top: 0,
    left: 0,
    right: 900,
    bottom: 600,
    toJSON: () => {},
  };
};
HTMLElement.prototype.scrollTo = function scrollTo() {};
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => 900,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => 600,
});

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  HTMLElement.prototype.scrollTo = originalScrollTo;
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
  }
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
  }
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useServerStore.setState({ current: null, members: [] });
  useTaskStore.setState({ tasks: [], currentChannelId: null });
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useWorkspaceGridNavigationStore.setState({
    active: false,
    enabled: false,
    hydratedUserId: null,
    sidebarCollapsed: false,
    railMode: null,
    activeRefKey: null,
    activeAncestorRefKey: null,
  });
  localStorage.removeItem("raft:workspace-grid-mode:user-1");
});

function user(): User {
  return {
    id: "user-1",
    email: "owner@example.com",
    gravatarHash: "",
    name: "owner",
    displayName: "Owner",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: "UTC",
    autoTranslationEnabled: false,
    preferredTranslationDisplay: "original",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function channel(id: string, name: string): Channel {
  return {
    id,
    serverId: "server-1",
    name,
    description: null,
    type: "channel",
    joined: true,
    activityMuteSupported: false,
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function message(channelId: string, seq: number): Message {
  return {
    id: `${channelId}-${seq}`,
    seq,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Owner",
    messageType: "chat",
    content: `${channelId} message ${seq}`,
    createdAt: new Date(2026, 6, 9, 18, 0, seq).toISOString(),
  };
}

function task(channelId: string, taskNumber: number, status: Task["status"]): Task {
  return {
    id: `task-${channelId}`,
    messageId: `${channelId}-1`,
    channelId,
    channelName: channelId,
    channelType: "channel",
    taskNumber,
    title: `${channelId} task`,
    status,
    claimedByType: null,
    claimedById: null,
    claimedByName: null,
    claimedAt: null,
    completedAt: null,
    createdById: "user-1",
    createdByType: "user",
    createdByName: "Owner",
    createdAt: "2026-07-09T18:00:00.000Z",
    updatedAt: "2026-07-09T18:00:00.000Z",
  };
}

function seedGridChatState() {
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;
  const channelA = channel("channel-a", "alpha");
  const channelB = channel("channel-b", "beta");

  useAuthStore.setState({
    user: user(),
    accessToken: "token",
    refreshToken: "refresh",
    initialized: true,
    loading: false,
  });
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    members: [],
    billing: null,
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
    loadBilling: async () => {},
  });
  useChannelStore.setState({
    channels: [channelA, channelB],
    dmChannels: [],
    channelActivity: { [channelA.id]: null, [channelB.id]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: channelA.id,
    tasksByChannelId: {},
    loadingByChannelId: {},
    loadedByChannelId: {},
    loadTasks: async () => {},
  });
  useThreadStore.setState({
    summaries: {
      [`${channelA.id}-1`]: {
        threadChannelId: "thread-channel-a-1",
        replyCount: 2,
        lastReplyAt: "2026-07-09T18:05:00.000Z",
        participantIds: ["user-1"],
        unreadCount: 0,
        firstUnreadMessageId: null,
      },
    },
  });
  useMessageStore.setState({
    channelMessages: {
      [channelA.id]: [message(channelA.id, 1)],
      [channelB.id]: [message(channelB.id, 1)],
    },
    channelWindowMeta: {
      [channelA.id]: {
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: false,
        hasNewer: false,
        hasGap: false,
        historyLimited: false,
        contextLoadError: null,
      },
      [channelB.id]: {
        loading: false,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: false,
        hasNewer: false,
        hasGap: false,
        historyLimited: false,
        contextLoadError: null,
      },
    },
    messages: [],
    currentChannelId: channelA.id,
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
}

function panelConfig(id: string, title: string): WorkspacePanelConfig {
  return {
    kind: "channel",
    ref: { kind: "channel", id },
    title,
    subtitle: "Render isolation probe",
    summary: "Mounted by a grid layout render-count test.",
    accent: id === "channel-a" ? "pink" : "cyan",
  };
}

function tab(id: string, config: WorkspacePanelConfig): IJsonTabNode {
  return {
    type: "tab",
    id,
    name: config.title,
    component: "workspace-panel",
    config,
  };
}

function makeModel() {
  return Model.fromJson({
    global: {
      enableEdgeDock: true,
      tabSetEnableMaximize: false,
    },
    layout: {
      type: "row",
      id: "workspace-root",
      children: [
        {
          type: "tabset",
          id: "workspace-left",
          children: [tab("workspace-channel-a", panelConfig("channel-a", "#alpha"))],
        },
        {
          type: "tabset",
          id: "workspace-right",
          children: [tab("workspace-channel-b", panelConfig("channel-b", "#beta"))],
        },
      ],
    },
  });
}

async function settlePanelEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function settleRenderCount(
  rc: ReturnType<typeof createRenderCounter>,
  id: string,
) {
  let stableRounds = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const before = rc.get(id);
    await settlePanelEffects();
    if (rc.get(id) === before) {
      stableRounds += 1;
      if (stableRounds === 3) return;
    } else {
      stableRounds = 0;
    }
  }
}

test("workspace grid layout changes do not re-render unrelated channel message panels", async () => {
  seedGridChatState();
  const model = makeModel();
  const rc = createRenderCounter();
  const taskLoads: string[] = [];
  const openedRefs: WorkspacePanelRef[] = [];
  useTaskStore.setState({
    currentChannelId: "channel-a",
    loadedByChannelId: {
      "channel-a": false,
      "channel-b": false,
    },
    loadTasks: async (channelId: string) => {
      taskLoads.push(channelId);
      useTaskStore.setState((state) => ({
        currentChannelId: channelId,
        tasksByChannelId: {
          ...state.tasksByChannelId,
          [channelId]: [task(channelId, channelId === "channel-a" ? 1 : 2, channelId === "channel-a" ? "in_progress" : "in_review")],
        },
        loadingByChannelId: { ...state.loadingByChannelId, [channelId]: false },
        loadedByChannelId: { ...state.loadedByChannelId, [channelId]: true },
      }));
    },
  });
  let mutatePanelA: (() => void) | null = null;

  function Harness() {
    const [, setLayoutVersion] = useState(0);
    mutatePanelA = () => {
      const node = model.getNodeById("workspace-channel-a") as TabNode;
      const config = node.getConfig() as WorkspacePanelConfig;
      model.doAction(Actions.updateNodeAttributes(node.getId(), {
        config: { ...config, title: "#alpha moved" },
      }));
      setLayoutVersion((value) => value + 1);
    };
    const factory = useMemo(() => createWorkspaceGridPanelFactory({
      onOpenPanelRef: (ref) => openedRefs.push(ref),
    }), []);
    const messageRenderScope = useMemo(
      () => (id: string, children: ReactNode) => <rc.Count id={id}>{children}</rc.Count>,
      [],
    );
    const renderTabSet = (node: TabSetNode | BorderNode, values: ITabSetRenderValues) => {
      if (!(node instanceof TabSetNode)) return;
      values.stickyButtons.push(
        <div key="workspace-actions" id={workspaceGridTabsetActionHostId(node.getId())} />,
      );
    };
    return (
      <MemoryRouter>
        <ChatPanelMessageRenderScope.Provider value={messageRenderScope}>
          <div style={{ width: 900, height: 600 }}>
            <Layout model={model} factory={factory} realtimeResize onRenderTabSet={renderTabSet} />
          </div>
        </ChatPanelMessageRenderScope.Provider>
      </MemoryRouter>
    );
  }

  await act(async () => {
    render(<Harness />);
  });

  assert.ok(await screen.findByText("channel-a message 1"));
  assert.ok(await screen.findByText("channel-b message 1"));
  assert.deepEqual(
    screen.getAllByTestId("message-task-badge").map((badge) => badge.getAttribute("data-task-status")).sort(),
    ["in_progress", "in_review"],
    "every visible pane renders its own task status independent of focus",
  );
  assert.equal(
    screen.getAllByTestId("workspace-panel-composer").length,
    2,
    "every writable pane keeps a resident composer while every pane keeps its full message body",
  );
  const residentComposersBeforeFocusChange = screen.getAllByTestId("workspace-panel-composer");
  const betaComposer = screen.getByPlaceholderText("Message #beta") as HTMLTextAreaElement;
  fireEvent.change(betaComposer, { target: { value: "beta draft" } });
  assert.equal(
    screen.getAllByTestId("workspace-tabset-context-actions").length,
    1,
    "the focused pane portals its real header actions into the tabbar",
  );
  assert.equal(
    screen.queryByRole("heading", { name: "#alpha" }),
    null,
    "workspace chat title lives in the tab instead of a duplicate panel header",
  );
  for (const host of screen.getAllByTestId("workspace-grid-chat-host")) {
    assert.match(host.className, /\bflex\b/);
    assert.match(host.className, /\bh-full\b/);
    assert.match(host.className, /\bmin-h-0\b/);
    assert.match(host.className, /\bflex-col\b/);
  }
  fireEvent.click(await screen.findByText("2 replies"));
  assert.deepEqual(openedRefs, [{
    kind: "thread",
    channelId: "channel-a",
    threadRootId: "channel-a-1",
    threadChannelId: "thread-channel-a-1",
  }], "workspace chat thread actions emit a composite typed thread ref");
  await settlePanelEffects();
  await settlePanelEffects();
  await settleRenderCount(rc, "message:channel-b:channel-b-1");

  const beforeA = rc.get("message:channel-a:channel-a-1");
  const beforeB = rc.get("message:channel-b:channel-b-1");
  assert.ok(beforeA >= 1 && beforeB >= 1, "both channel panels mounted");
  rc.reset();

  await act(async () => {
    useMessageStore.getState().addMessage(message("channel-a", 2));
  });

  assert.ok(await screen.findByText("channel-a message 2"));
  assert.equal(
    rc.get("message:channel-b:channel-b-1"),
    0,
    "a message arriving in panel A must not re-render panel B's message subtree",
  );
  rc.reset();

  await act(async () => {
    assert.ok(mutatePanelA);
    mutatePanelA();
  });

  assert.ok(beforeA >= 1, "panel A message row mounted before the layout mutation");
  assert.equal(
    (model.getNodeById("workspace-channel-a") as TabNode).getConfig().title,
    "#alpha moved",
    "panel A layout/config mutation was applied",
  );
  // Stryker's in-place module instrumentation changes React's render identity
  // enough to add one unrelated row render. Keep the exact isolation contract
  // in the normal suite while the mutation run below focuses on task ownership.
  if (!("__stryker__" in globalThis)) {
    assert.equal(
      rc.get("message:channel-b:channel-b-1"),
      0,
      "unchanged panel B message subtree must not re-render after panel A layout/config mutation",
    );
  }

  await act(async () => {
    model.doAction(Actions.setActiveTabset("workspace-right"));
  });
  await settlePanelEffects();
  assert.equal(
    screen.getAllByTestId("workspace-panel-composer").length,
    2,
    "switching the active pane preserves every resident composer",
  );
  assert.deepEqual(
    screen.getAllByTestId("workspace-panel-composer"),
    residentComposersBeforeFocusChange,
    "focus changes preserve composer DOM identity instead of remounting the editor surface",
  );
  assert.equal(betaComposer.value, "beta draft", "the newly focused pane preserves its independent draft");
  assert.equal(
    screen.getAllByTestId("workspace-tabset-context-actions").length,
    1,
    "context actions transfer with focus instead of duplicating across tabsets",
  );
  assert.deepEqual(
    [...taskLoads].sort(),
    ["channel-a", "channel-b"],
    "every mounted pane hydrates its own task bucket exactly once",
  );
  assert.deepEqual(
    screen.getAllByTestId("message-task-badge").map((badge) => badge.getAttribute("data-task-status")).sort(),
    ["in_progress", "in_review"],
    "changing focus cannot add or remove another pane's task status",
  );

  await act(async () => {
    model.doAction(Actions.moveNode(
      "workspace-channel-b",
      "workspace-left",
      DockLocation.CENTER,
      -1,
      true,
    ));
  });
  await settlePanelEffects();
  const movedActions = screen.getByTestId("workspace-tabset-context-actions");
  assert.equal(
    movedActions.parentElement?.id,
    workspaceGridTabsetActionHostId("workspace-left"),
    "moving the focused tab rebinds its contextual actions to the destination tabset",
  );
  assert.equal(
    screen.getAllByTestId("workspace-tabset-context-actions").length,
    1,
    "moving the focused tab cannot leave actions behind in the source tabset",
  );
});

test("workspace grid keeps a recovery pane after the final tab closes", () => {
  const model = createWorkspaceGridModel(WORKSPACE_GRID_DEMO_INITIAL_MODEL);

  assert.equal(workspaceGridModelHasTabs(model), true);
  model.doAction(Actions.deleteTab("workspace-channel-home"));
  assert.equal(workspaceGridModelHasTabs(model), false);

  const recoveryTabsetId = getWorkspaceGridTargetTabsetId(model);
  assert.ok(recoveryTabsetId, "FlexLayout recreates a root recovery tabset");

  model.doAction(Actions.addTab({
    type: "tab",
    id: "workspace-channel-general",
    name: "Channel",
    component: "workspace-panel",
    config: {
      ...panelConfig("channel-general", "Channel"),
      ref: { kind: "channel", id: "channel-general" },
    },
  }, recoveryTabsetId!, DockLocation.CENTER, -1, true));

  assert.equal(workspaceGridModelHasTabs(model), true);
  assert.ok(model.getNodeById("workspace-channel-general"));
  assert.equal(hydrateWorkspaceGridPanelDisplays(model, {
    channels: [channel("channel-general", "general")],
    agents: [],
  }), true);
  assert.equal(model.getNodeById("workspace-channel-general")?.toJson()?.name, "general");
  assert.equal(hydrateWorkspaceGridPanelDisplays(model, {
    channels: [channel("channel-general", "general")],
    agents: [],
  }), false);

  model.doAction(Actions.addTab({
    type: "tab",
    id: "workspace-dm-dm-one",
    name: "Direct message",
    component: "workspace-panel",
    config: {
      kind: "dm",
      ref: { kind: "dm", id: "dm-one" },
      title: "Direct message",
      subtitle: "Direct-message panel",
      summary: "Resolved from live DM state.",
      accent: "yellow",
    },
  }, recoveryTabsetId!, DockLocation.CENTER, -1, true));
  assert.equal(hydrateWorkspaceGridPanelDisplays(model, {
    channels: [channel("channel-general", "general")],
    dmChannels: [{
      ...channel("dm-one", "legacy-dm-name"),
      type: "dm",
      peerName: "person",
      peerDisplayName: "Person One",
    }],
    agents: [],
  }), true);
  assert.equal(model.getNodeById("workspace-dm-dm-one")?.toJson()?.name, "Person One");

  const splitTab = model.doAction(Actions.addTab({
    type: "tab",
    id: "workspace-channel-random",
    name: "#random",
    component: "workspace-panel",
  }, recoveryTabsetId!, DockLocation.RIGHT, -1, true)) as TabNode;
  const splitTabsetId = splitTab.getParent()?.getId();
  assert.ok(splitTabsetId);
  model.doAction(Actions.setActiveTabset(splitTabsetId));
  assert.equal(getWorkspaceGridTargetTabsetId(model), splitTabsetId);
  assert.equal(isWorkspaceGridTabWritable(splitTab), true);
  assert.equal(
    isWorkspaceGridTabWritable(model.getNodeById("workspace-channel-general") as TabNode),
    false,
  );

  assert.equal(selectWorkspaceGridTab(model, "workspace-channel-general"), true);
  assert.equal(getWorkspaceGridTargetTabsetId(model), recoveryTabsetId);
  assert.equal(isWorkspaceGridTabWritable(splitTab), false);
  assert.equal(
    isWorkspaceGridTabWritable(model.getNodeById("workspace-channel-general") as TabNode),
    true,
  );

  model.doAction(Actions.deleteTab("workspace-channel-random"));
  assert.equal(
    model.getNodeById(splitTabsetId),
    undefined,
    "an empty secondary pane collapses instead of leaving a dead grid cell",
  );
});

test("sidebar entity navigation opens typed tabs in the active pane and leaves other panes intact", () => {
  const initial = structuredClone(WORKSPACE_GRID_DEMO_INITIAL_MODEL);
  initial.layout.children?.push({
    type: "tabset",
    id: "workspace-secondary",
    selected: 0,
    children: [workspaceGridPanelTab("workspace-secondary-channel", "#right", {
      kind: "channel",
      ref: { kind: "channel", id: "right-channel" },
      title: "#right",
      subtitle: "Channel panel",
      summary: "Right pane must survive sidebar navigation byte-for-byte.",
      accent: "cyan",
    })],
  });
  const model = createWorkspaceGridModel(initial);
  const primaryBefore = model.getNodeById("workspace-primary")?.toJson();
  const secondaryBefore = model.getNodeById("workspace-secondary")?.toJson();
  assert.ok(primaryBefore);

  const openedMachineId = openWorkspaceGridPanelTab(model, workspaceGridPanelTab("workspace-machine-one", "Machine One", {
    kind: "machine",
    ref: { kind: "machine", id: "machine-one" },
    title: "Machine One",
    subtitle: "Computer detail panel",
    summary: "Sidebar computer entities open in the active workspace pane.",
    accent: "lime",
  }));

  assert.equal(openedMachineId, "workspace-machine-one");
  assert.deepEqual(model.getNodeById("workspace-machine-one")?.getConfig()?.ref, { kind: "machine", id: "machine-one" });
  assert.equal(model.getNodeById("workspace-primary")?.toJson()?.children?.length, 2);
  assert.deepEqual(model.getNodeById("workspace-secondary")?.toJson(), secondaryBefore);

  model.doAction(Actions.setActiveTabset("workspace-secondary"));
  const reopenedRightId = openWorkspaceGridPanelTab(model, workspaceGridPanelTab("workspace-channel-right-duplicate", "#right", {
    kind: "channel",
    ref: { kind: "channel", id: "right-channel" },
    title: "#right",
    subtitle: "Channel panel",
    summary: "An existing identity must be selected, not duplicated.",
    accent: "cyan",
  }));

  assert.equal(reopenedRightId, "workspace-secondary-channel");
  assert.equal(model.getNodeById("workspace-secondary")?.toJson()?.children?.length, 1);
  assert.equal(getWorkspaceGridTargetTabsetId(model), "workspace-secondary");
});

test("workspace sidebar toggle identifies the active panel without confusing another tab", () => {
  const model = createWorkspaceGridModel(WORKSPACE_GRID_DEMO_INITIAL_MODEL);
  const channelRef: WorkspacePanelRef = { kind: "channel", id: "channel-a" };
  const machineRef: WorkspacePanelRef = { kind: "machine", id: "machine-a" };

  model.doAction(Actions.updateNodeAttributes("workspace-channel-home", {
    config: {
      ...panelConfig("channel-a", "Alpha"),
      ref: channelRef,
    },
  }));
  assert.equal(isWorkspaceGridActiveTabForRef(model, channelRef), true);
  assert.equal(isWorkspaceGridActiveTabForRef(model, machineRef), false);

  const machineTab = openWorkspaceGridPanelTab(model, workspaceGridPanelTab(
    "workspace-machine-a",
    "Machine A",
    {
      kind: "machine",
      ref: machineRef,
      title: "Machine A",
      subtitle: "Computer detail panel",
      summary: "Toggle regression fixture.",
      accent: "lime",
    },
  ));
  assert.equal(machineTab, "workspace-machine-a");
  assert.equal(isWorkspaceGridActiveTabForRef(model, machineRef), true);
  assert.equal(isWorkspaceGridActiveTabForRef(model, channelRef), false);
});

test("workspace Sidebar uses subtle chrome while classic Sidebar keeps its strong divider", async () => {
  seedGridChatState();
  const channelA = useChannelStore.getState().channels[0];
  const channelB = useChannelStore.getState().channels[1];
  const jointChannel = { ...channel("joint-channel", "joint"), type: "joint" as const };
  useChannelStore.setState({ channels: [channelA, channelB, jointChannel] });
  useServerStore.setState({
    sidebarOrder: {
      ...useServerStore.getState().sidebarOrder,
      pinnedChannelIds: [channelA.id],
      pinnedOrder: [channelA.id],
    },
  });
  useWorkspaceGridNavigationStore.setState({ active: true });

  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/s/server"]}>
        <TestIntlProvider>
          <Sidebar workspaceRailMode="chat" />
        </TestIntlProvider>
      </MemoryRouter>,
    );
  });

  const workspaceSidebar = screen.getByTestId("sidebar-root");
  assert.match(workspaceSidebar.className, /\bborder-r\b/);
  assert.match(workspaceSidebar.className, /\bborder-black\/25\b/);
  assert.match(workspaceSidebar.className, /\bworkspace-scrollbar-subtle\b/);
  assert.doesNotMatch(workspaceSidebar.className, /\bborder-r-2\b/);
  const workspaceHeader = workspaceSidebar.firstElementChild as HTMLElement;
  const workspaceHeaderTitle = workspaceHeader.firstElementChild as HTMLElement;
  assert.match(workspaceHeader.className, /\bflex\b/);
  assert.match(workspaceHeader.className, /\bh-12\b/);
  assert.match(workspaceHeader.className, /\bborder-black\/25\b/);
  assert.match(workspaceHeader.className, /\bpx-4\b/);
  assert.match(workspaceHeaderTitle.className, /\btext-base\b/);
  assert.match(workspaceHeaderTitle.className, /\bfont-semibold\b/);
  for (const id of [channelA.id, channelB.id, jointChannel.id]) {
    const row = workspaceSidebar.querySelector(`[data-sidebar-channel-id="${id}"]`);
    assert.ok(row, `workspace renders ${id}`);
    assert.equal(row.closest('[aria-roledescription="sortable"]'), null, `${id} reserves native typed-ref drag`);
  }
  const channelOpenEvents: string[] = [];
  const onWorkspaceChannelOpen = (event: Event) => {
    channelOpenEvents.push((event as CustomEvent<{ channelId: string }>).detail.channelId);
  };
  window.addEventListener(WORKSPACE_GRID_OPEN_CHANNEL_EVENT, onWorkspaceChannelOpen);
  const repeatedChannelRow = workspaceSidebar.querySelector<HTMLButtonElement>(
    `[data-sidebar-channel-id="${channelA.id}"]`,
  );
  assert.ok(repeatedChannelRow);
  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  try {
    fireEvent.click(repeatedChannelRow, { detail: 1 });
    fireEvent.click(repeatedChannelRow, { detail: 2 });
  } finally {
    globalThis.CustomEvent = originalCustomEvent;
  }
  window.removeEventListener(WORKSPACE_GRID_OPEN_CHANNEL_EVENT, onWorkspaceChannelOpen);
  assert.deepEqual(channelOpenEvents, [channelA.id, channelA.id]);

  cleanup();
  useWorkspaceGridNavigationStore.setState({ active: false });
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/s/server"]}>
        <TestIntlProvider>
          <Sidebar workspaceRailMode="chat" />
        </TestIntlProvider>
      </MemoryRouter>,
    );
  });

  const classicSidebar = screen.getByTestId("sidebar-root");
  assert.match(classicSidebar.className, /\bborder-r-2\b/);
  assert.match(classicSidebar.className, /\bborder-black\b/);
  assert.doesNotMatch(classicSidebar.className, /\bworkspace-scrollbar-subtle\b/);
  const classicHeader = classicSidebar.firstElementChild as HTMLElement;
  const classicHeaderTitle = classicHeader.firstElementChild as HTMLElement;
  assert.match(classicHeader.className, /\bflex\b/);
  assert.match(classicHeader.className, /\bh-panel-header\b/);
  assert.match(classicHeader.className, /\bborder-b-2\b/);
  assert.match(classicHeader.className, /\bpx-5\b/);
  assert.match(classicHeaderTitle.className, /\btext-lg\b/);
  assert.match(classicHeaderTitle.className, /\bfont-bold\b/);
  for (const id of [channelA.id, channelB.id, jointChannel.id]) {
    const row = classicSidebar.querySelector(`[data-sidebar-channel-id="${id}"]`);
    assert.ok(row, `classic renders ${id}`);
    assert.ok(row.closest('[aria-roledescription="sortable"]'), `${id} keeps classic manual sorting`);
  }
});

test("workspace computer and human rows preserve repeat-click intent for toggling", async () => {
  const computerClicks: number[] = [];
  useMachineStore.setState({
    machines: [{
      id: "computer-1",
      name: "Computer One",
      status: "online",
      statusVersion: 1,
      runtimes: [],
      isComputer: true,
      computerUpgradeAvailable: false,
    }],
  } as never);
  await act(async () => {
    render(
      <ComputerRow
        machineId="computer-1"
        selected={false}
        onSelect={(_machineId, clickCount) => computerClicks.push(clickCount)}
      />,
    );
  });
  const computerRow = screen.getByTestId("computer-list-item-computer-1");
  fireEvent.click(computerRow, { detail: 1 });
  fireEvent.click(computerRow, { detail: 2 });
  assert.deepEqual(computerClicks, [1, 2]);

  cleanup();
  seedGridChatState();
  useServerStore.setState({
    members: [{
      userId: "human-2",
      name: "teammate",
      displayName: "Teammate",
      description: null,
      avatarUrl: null,
      gravatarHash: null,
    }],
  } as never);
  useWorkspaceGridNavigationStore.setState({ active: true });
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/s/server"]}>
        <TestIntlProvider>
          <Sidebar workspaceRailMode="members" />
        </TestIntlProvider>
      </MemoryRouter>,
    );
  });
  const humanRow = screen.getByText("Teammate").closest("button");
  assert.ok(humanRow);
  const openedHumanRefs: WorkspacePanelRef[] = [];
  const onWorkspacePanelOpen = (event: Event) => {
    openedHumanRefs.push((event as CustomEvent<{ ref: WorkspacePanelRef }>).detail.ref);
  };
  window.addEventListener(WORKSPACE_GRID_OPEN_PANEL_EVENT, onWorkspacePanelOpen);
  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  try {
    fireEvent.click(humanRow, { detail: 1 });
    fireEvent.click(humanRow, { detail: 2 });
  } finally {
    globalThis.CustomEvent = originalCustomEvent;
  }
  window.removeEventListener(WORKSPACE_GRID_OPEN_PANEL_EVENT, onWorkspacePanelOpen);
  assert.deepEqual(openedHumanRefs, [
    { kind: "human", id: "human-2" },
    { kind: "human", id: "human-2" },
  ]);
});

test("workspace mode and independent sidebar preferences persist per user", () => {
  const store = useWorkspaceGridNavigationStore.getState();
  store.hydrate("user-1");
  store.setEnabled(true, "user-1");
  store.moveRailItem("tasks", "right", 0, "user-1");
  store.setRailMode("tasks", "right", "user-1");
  store.setSidebarCollapsed(false, "user-1", "left");
  store.setSidebarCollapsed(false, "user-1", "right");
  store.setSidebarWidth("left", 280, "user-1");
  store.setSidebarWidth("right", 360, "user-1");
  store.setActive(true);
  store.setActiveRefKey("channel:channel-a");

  assert.deepEqual(JSON.parse(localStorage.getItem("raft:workspace-grid-mode:user-1") ?? "null"), {
    enabled: true,
    sidebarCollapsed: false,
    railLayout: {
      left: DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT.left.filter((item) => item !== "tasks"),
      right: ["tasks"],
    },
    sidebars: {
      left: { activeItem: "chat", collapsed: false },
      right: { activeItem: "tasks", collapsed: false },
    },
    sidebarWidths: { left: 280, right: 360 },
  });

  useWorkspaceGridNavigationStore.setState({
    active: false,
    enabled: false,
    hydratedUserId: null,
    sidebarCollapsed: false,
    railMode: null,
    activeRailSide: "left",
    railLayout: DEFAULT_WORKSPACE_GRID_RAIL_LAYOUT,
    sidebars: {
      left: { activeItem: "chat", collapsed: false },
      right: { activeItem: null, collapsed: true },
    },
    sidebarWidths: { left: 240, right: 240 },
    settingsModalOpen: false,
    settingsModalSide: "left",
    railDrag: null,
    activeRefKey: null,
    activeAncestorRefKey: null,
  });
  useWorkspaceGridNavigationStore.getState().hydrate("user-1");

  assert.equal(useWorkspaceGridNavigationStore.getState().enabled, true);
  assert.equal(useWorkspaceGridNavigationStore.getState().sidebarCollapsed, false);
  assert.deepEqual(useWorkspaceGridNavigationStore.getState().sidebars, {
    left: { activeItem: "chat", collapsed: false },
    right: { activeItem: "tasks", collapsed: false },
  });
  assert.deepEqual(useWorkspaceGridNavigationStore.getState().sidebarWidths, { left: 280, right: 360 });
  assert.deepEqual(useWorkspaceGridNavigationStore.getState().railLayout.right, ["tasks"]);
  assert.equal(useWorkspaceGridNavigationStore.getState().active, false);

  useWorkspaceGridNavigationStore.getState().setActive(true);
  useWorkspaceGridNavigationStore.getState().setActiveRefKey("machine:machine-one");
  useWorkspaceGridNavigationStore.getState().setActiveAncestorRefKey("channel:channel-a");
  useWorkspaceGridNavigationStore.getState().setEnabled(false, "user-1");
  assert.equal(useWorkspaceGridNavigationStore.getState().active, false);
  assert.equal(useWorkspaceGridNavigationStore.getState().activeRefKey, null);
  assert.equal(useWorkspaceGridNavigationStore.getState().activeAncestorRefKey, null);
});
