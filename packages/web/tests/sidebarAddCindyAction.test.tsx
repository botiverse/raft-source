import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar.js";
import { TestIntlProvider } from "./helpers/intl";
import { WORKSPACE_GRID_OPEN_DM_EVENT } from "../src/components/workspace/workspaceGridOpenEvents";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { ServerMember } from "../src/store/serverStore";
import { useUIStore } from "../src/store/uiStore";

const originalApiGet = api.get;
const originalOpenDM = useChannelStore.getState().openDM;
const originalOpenUserDM = useChannelStore.getState().openUserDM;
const originalResetAgent = useAgentStore.getState().resetAgent;
const originalStopAgent = useAgentStore.getState().stopAgent;

afterEach(() => {
  api.get = originalApiGet;
  cleanup();
  useChannelStore.setState({ openDM: originalOpenDM, openUserDM: originalOpenUserDM });
  useAgentStore.setState({ resetAgent: originalResetAgent, stopAgent: originalStopAgent });
  useUIStore.setState({ sidebarOpen: false });
  useWorkspaceGridNavigationStore.setState({ active: false });
});

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") {
      return { data: [] };
    }
    return { data: [] };
  }) as typeof api.get;
}

function makeAgent(name: string): Agent {
  return {
    id: `agent-${name.trim().toLowerCase() || "blank"}`,
    serverId: "server-1",
    serverName: "Server",
    serverSlug: "server",
    name,
    displayName: null,
    avatarUrl: null,
    description: null,
    status: "stopped",
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
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}

function makeHuman(name: string): ServerMember {
  return {
    userId: `user-${name.trim().toLowerCase() || "human"}`,
    serverId: "server-1",
    email: null,
    gravatarHash: "",
    name,
    displayName: null,
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-13T00:00:00.000Z",
  };
}

function makeDm(id: string, peerType: "agent" | "user", peerId: string): Channel {
  return {
    id,
    name: id,
    description: null,
    type: "dm",
    createdAt: "2026-07-16T00:00:00.000Z",
    joined: true,
    peerType,
    peerId,
  };
}

function seedSidebar(
  agents: Agent[],
  members: ServerMember[] = [],
  membersLoadError = false,
  role: "owner" | "admin" | "member" = "owner",
) {
  installApiStub();
  localStorage.clear();
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "owner@example.com",
      gravatarHash: "hash",
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
      plan: "free",
      planDowngradedAt: null,
      role,
      createdAt: "2026-06-28T00:00:00.000Z",
    },
    servers: [],
    members,
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
      pinned: [],
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      pinnedVersion: 0,
    },
  } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({
    agents,
    loading: false,
    showCreateAgent: false,
    createAgentOnboarding: false,
  } as never);
}

function renderSidebar(workspaceRailMode?: "members") {
  function LocationProbe() {
    return <output data-testid="location-path">{useLocation().pathname}</output>;
  }

  render(
    <MemoryRouter initialEntries={["/s/server/members"]}>
      <TestIntlProvider>
        <Sidebar workspaceRailMode={workspaceRailMode} />
      </TestIntlProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

test("the add-agent menu routes managed and external creation to distinct dialogs", async () => {
  // Cindy belongs to the setup flow, not to the agent menu. The flow keeps its own door
  // open now (a persistent Resume Setup bar after deferring, plus Settings → Finish setup),
  // so a second entry point here only invited a question the product does not want asked:
  // "is Cindy just an agent I hand-create?" (stdrc, 2026-07-13).
  seedSidebar([]);
  renderSidebar();

  fireEvent.click(screen.getByTitle("Add agent"));
  const labels = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());

  assert.equal(labels.includes("Create Cindy"), false);
  assert.deepEqual(labels.slice(0, 2), ["Create Agent", "Create External Agent"]);

  fireEvent.click(screen.getByRole("menuitem", { name: "Create Agent" }));
  assert.equal(
    useAgentStore.getState().showCreateAgent,
    true,
    "managed creation must route through the shared app-level dialog state",
  );
  useAgentStore.setState({ showCreateAgent: false });

  fireEvent.click(screen.getByTitle("Add agent"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Create External Agent" }));
  assert.ok(await screen.findByRole("heading", { name: "Create External Agent" }));
});

test("classic Members rail shows humans alongside agents", () => {
  seedSidebar([makeAgent("Helper")], [makeHuman("Cindy")]);
  renderSidebar();

  assert.equal(screen.getByRole("button", { name: /Agents1/i }) !== null, true);
  assert.equal(screen.getByRole("button", { name: /Humans1/i }) !== null, true);
  assert.equal(screen.getByRole("button", { name: "Cindy" }) !== null, true);
});

test("classic Members agent menu opens the Stop and Restart / Reset confirmation flows", async () => {
  const agent = { ...makeAgent("Helper"), status: "active" as const };
  let resetCalls = 0;
  let stopCalls = 0;
  seedSidebar([agent]);
  useAgentStore.setState({
    resetAgent: async () => {
      resetCalls += 1;
    },
    stopAgent: async () => {
      stopCalls += 1;
    },
  } as never);
  renderSidebar();

  const row = screen.getByRole("button", { name: "Helper" });
  fireEvent.contextMenu(row, { clientX: 120, clientY: 160 });
  assert.ok(await screen.findByRole("menuitem", { name: "Message" }));
  assert.ok(screen.getByRole("menuitem", { name: "Restart / Reset" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Stop" }));
  assert.equal(stopCalls, 0, "opening the confirmation must not directly stop the agent");
  assert.ok(await screen.findByRole("heading", { name: "Stop Agent" }));
  assert.ok(screen.getByText(/Are you sure you want to stop "Helper"/));
  const stopConfirm = screen.getByRole("button", { name: "Stop Agent" });
  assert.match(stopConfirm.className, /bg-brutal-orange/);
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  await waitFor(() => assert.equal(screen.queryByRole("heading", { name: "Stop Agent" }), null));

  fireEvent.contextMenu(row, { clientX: 120, clientY: 160 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Restart / Reset" }));
  assert.equal(resetCalls, 0, "opening the chooser must not directly reset the agent");
  assert.ok(await screen.findByRole("heading", { name: "Restart Helper" }));
  assert.ok(screen.getAllByRole("button", { name: /^Restart/ }).length >= 1);
  assert.ok(screen.getByRole("button", { name: /Reset Session & Restart/ }));
  assert.ok(screen.getByRole("button", { name: /Full Reset & Restart/ }));
});

test("classic Members agent menu gives a member exactly Restart Model and Reset Model", async () => {
  const agent = { ...makeAgent("Helper"), status: "active" as const };
  seedSidebar([agent], [], false, "member");
  renderSidebar();

  const row = screen.getByRole("button", { name: "Helper" });
  fireEvent.contextMenu(row, { clientX: 120, clientY: 160 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Restart / Reset" }));

  await screen.findByRole("dialog");
  assert.equal(screen.getAllByText("Restart Model").length, 2, "selected mode also labels confirm action");
  assert.ok(screen.getByText("Reset Model"));
  assert.equal(screen.queryByText("Reset Session & Restart"), null);
  assert.equal(screen.queryByText("Full Reset & Restart"), null);
});

test("classic Members rail surfaces human load failures", () => {
  seedSidebar([makeAgent("Helper")], [], true);
  renderSidebar();

  assert.equal(screen.getByRole("button", { name: /Humans0/i }) !== null, true);
  assert.equal(screen.getByText("Humans failed to load") !== null, true);
  assert.equal(screen.queryByText("No humans"), null);
});

test("classic Members human row keeps single-click detail and opens its DM on double-click", async () => {
  const human = makeHuman("Cindy");
  const opened: string[] = [];
  let resolveDm!: (dm: Channel) => void;
  seedSidebar([], [human]);
  useUIStore.setState({ sidebarOpen: true });
  useChannelStore.setState({
    dmChannels: [
      makeDm("dm-wrong-kind", "agent", human.userId),
      makeDm("dm-wrong-peer", "user", "user-someone-else"),
    ],
    openUserDM: (userId) => {
      opened.push(userId);
      return new Promise<Channel>((resolve) => {
        resolveDm = resolve;
      });
    },
  });
  renderSidebar();

  const row = screen.getByRole("button", { name: "Cindy" });
  await act(async () => {
    fireEvent.click(row, { detail: 1 });
    await Promise.resolve();
  });
  assert.deepEqual(opened, [], "a single click must keep opening the human detail panel");

  await act(async () => {
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row, { detail: 2 });
    await Promise.resolve();
  });
  await waitFor(() => assert.deepEqual(opened, [human.userId]));
  assert.equal(screen.getByTestId("location-path").textContent, "/s/server");
  await act(async () => {
    resolveDm(makeDm("dm-cindy", "user", human.userId));
    await Promise.resolve();
  });
  assert.equal(screen.getByTestId("location-path").textContent, "/s/server/dm/dm-cindy");
  assert.equal(useUIStore.getState().sidebarOpen, false, "opening the DM closes the mobile sidebar");
});

test("classic Members agent row opens its DM on double-click", async () => {
  const agent = makeAgent("Helper");
  const opened: string[] = [];
  let resolveDm!: (dm: Channel) => void;
  seedSidebar([agent]);
  useChannelStore.setState({
    dmChannels: [
      makeDm("dm-wrong-kind", "user", agent.id),
      makeDm("dm-wrong-peer", "agent", "agent-someone-else"),
    ],
    openDM: (agentId) => {
      opened.push(agentId);
      return new Promise<Channel>((resolve) => {
        resolveDm = resolve;
      });
    },
  });
  renderSidebar();

  const row = screen.getByRole("button", { name: "Helper" });
  await act(async () => {
    fireEvent.click(row, { detail: 1 });
    await Promise.resolve();
  });
  assert.deepEqual(opened, [], "a single click must keep opening the agent detail panel");

  await act(async () => {
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row, { detail: 2 });
    await Promise.resolve();
  });
  await waitFor(() => assert.deepEqual(opened, [agent.id]));
  assert.equal(screen.getByTestId("location-path").textContent, "/s/server");
  await act(async () => {
    resolveDm(makeDm("dm-helper", "agent", agent.id));
    await Promise.resolve();
  });
  assert.equal(screen.getByTestId("location-path").textContent, "/s/server/dm/dm-helper");
});

test("classic Members human row reuses the exact existing human DM", async () => {
  const human = makeHuman("Cindy");
  let opened = 0;
  seedSidebar([], [human]);
  useChannelStore.setState({
    dmChannels: [
      makeDm("dm-wrong-kind", "agent", human.userId),
      makeDm("dm-wrong-peer", "user", "user-someone-else"),
      makeDm("dm-existing-human", "user", human.userId),
    ],
    openUserDM: async () => {
      opened += 1;
      return makeDm("dm-created-human", "user", human.userId);
    },
  });
  renderSidebar();

  const row = screen.getByRole("button", { name: "Cindy" });
  await act(async () => {
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row, { detail: 2 });
    await Promise.resolve();
  });

  assert.equal(opened, 0, "an exact existing human DM must bypass the create/open request");
  assert.equal(screen.getByTestId("location-path").textContent, "/s/server/dm/dm-existing-human");
});

test("classic Members agent row reuses the exact existing agent DM", async () => {
  const agent = makeAgent("Helper");
  let opened = 0;
  seedSidebar([agent]);
  useChannelStore.setState({
    dmChannels: [
      makeDm("dm-wrong-kind", "user", agent.id),
      makeDm("dm-wrong-peer", "agent", "agent-someone-else"),
      makeDm("dm-existing-agent", "agent", agent.id),
    ],
    openDM: async () => {
      opened += 1;
      return makeDm("dm-created-agent", "agent", agent.id);
    },
  });
  renderSidebar();

  const row = screen.getByRole("button", { name: "Helper" });
  await act(async () => {
    fireEvent.click(row, { detail: 1 });
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row, { detail: 2 });
    await Promise.resolve();
  });

  assert.equal(opened, 0, "an exact existing agent DM must bypass the create/open request");
  assert.equal(screen.getByTestId("location-path").textContent, "/s/server/dm/dm-existing-agent");
});

test("workspace Members double-click emits the typed DM open command", async () => {
  const agent = makeAgent("Helper");
  const openedDmIds: string[] = [];
  seedSidebar([agent]);
  useChannelStore.setState({
    dmChannels: [makeDm("dm-workspace-agent", "agent", agent.id)],
  });
  useWorkspaceGridNavigationStore.setState({ active: true });
  renderSidebar("members");

  const onOpenDm = (event: Event) => {
    openedDmIds.push((event as CustomEvent<{ dmChannelId: string }>).detail.dmChannelId);
  };
  window.addEventListener(WORKSPACE_GRID_OPEN_DM_EVENT, onOpenDm);
  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.CustomEvent = window.CustomEvent;
  try {
    const row = screen.getByRole("button", { name: "Helper" });
    await act(async () => {
      fireEvent.click(row, { detail: 1 });
      fireEvent.click(row, { detail: 2 });
      fireEvent.doubleClick(row, { detail: 2 });
      await Promise.resolve();
    });
  } finally {
    globalThis.CustomEvent = originalCustomEvent;
    window.removeEventListener(WORKSPACE_GRID_OPEN_DM_EVENT, onOpenDm);
  }

  assert.deepEqual(openedDmIds, ["dm-workspace-agent"]);
});
