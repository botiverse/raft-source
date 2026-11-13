import "./helpers/domSetup";

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import api from "../src/api/client";
import { AgentDetailPanel } from "../src/features/agent/AgentDetailPanel";
import { Sidebar } from "../src/features/sidebar/Sidebar";
import { MachineDetailPanel } from "../src/features/computer/MachineDetailPanel";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import type { Machine } from "../src/store/machineStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import { useUIStore } from "../src/store/uiStore";
import { TestIntlProvider } from "./helpers/intl";

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

const agent: Agent = {
  id: "agent-1",
  serverId: "server-1",
  serverName: "Server",
  serverSlug: "server",
  name: "helper",
  displayName: "Helper",
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
  creatorType: "user",
  creatorId: "user-1",
  creator: null,
  createdAgents: [],
  deletedAt: null,
  createdAt: "2026-08-22T00:00:00.000Z",
};

const machine: Machine = {
  id: "machine-1",
  name: "Studio",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: ["codex"],
  hostname: "studio.local",
  os: "darwin",
  daemonVersion: "1.0.0",
  isComputer: true,
  computerAttachedByCurrentUser: true,
  computerVersion: "1.0.0",
  computerUpgradeAvailable: false,
  lastHeartbeat: "2026-08-22T00:00:00.000Z",
  createdAt: "2026-08-22T00:00:00.000Z",
};

function sidebarOrder() {
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

function seedStores() {
  useAuthStore.setState({
    user: { id: "user-1", name: "Owner", email: "owner@example.com" },
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "user-1",
      role: "owner",
      plan: "free",
    },
    servers: [],
    members: [],
    sidebarOrder: sidebarOrder(),
  } as never);
  useAgentStore.setState({
    agents: [agent],
    activityLogs: {},
    agentActivities: {},
    loading: false,
  } as never);
  useMachineStore.setState({ machines: [machine], computerOperationProgress: {}, loading: false } as never);
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false } as never);
  useMessageStore.setState({ unreadCounts: {}, mentionFlags: {}, drafts: {} } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), total: 0 } as never);
  useInboxStore.setState({ totalCount: 0, totalUnreadCount: 0, loadInbox: async () => {} } as never);
  useUIStore.setState({ sidebarOpen: true } as never);
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") return { data: [] };
    if (url === "/provider-connections") return { data: { connections: [], providerOptions: [] } };
    if (url.includes("/runtime-account-usage/")) return { data: { state: "missing", snapshot: null } };
    return { data: [] };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url === "/feature-flags/evaluate") return { data: { evaluations: [] } };
    return { data: {} };
  }) as typeof api.post;
}

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

function wrap(child: ReturnType<typeof createElement>, initial = "/s/server/members") {
  return createElement(
    MemoryRouter,
    { initialEntries: [initial] },
    createElement(TestIntlProvider, null, child),
    createElement(LocationProbe),
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useMachineStore.setState(useMachineStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  localStorage.clear();
});

test("mounted agent detail closes an open delete confirmation when deletion is observed", async () => {
  seedStores();
  const view = render(wrap(createElement(AgentDetailPanel, { agent })));

  fireEvent.click(await screen.findByRole("button", { name: "Archive agent" }));
  assert.ok(await screen.findByRole("dialog"));

  view.rerender(wrap(createElement(AgentDetailPanel, {
    agent: { ...agent, deletedAt: "2026-08-22T01:00:00.000Z" },
  })));
  assert.ok(screen.queryByRole("dialog") === null, "observed deletion must dismiss the open dialog");
  assert.equal(screen.getByTestId("location").textContent, "/s/server/members");
});

test("mounted agent delete success closes locally without navigating", async () => {
  seedStores();
  const deletedAgents: string[] = [];
  useAgentStore.setState({
    deleteAgent: async (id: string) => { deletedAgents.push(id); },
  } as never);
  const agentView = render(wrap(createElement(AgentDetailPanel, { agent })));
  fireEvent.click(screen.getByRole("button", { name: "Archive agent" }));
  await act(async () => {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
  });
  assert.ok(screen.queryByRole("dialog") === null);
  assert.deepEqual(deletedAgents, [agent.id]);
  assert.equal(screen.getByTestId("location").textContent, "/s/server/members");
  agentView.unmount();
});

test("mounted computer delete success closes locally without navigating", async () => {
  seedStores();
  const deletedMachines: string[] = [];
  useAgentStore.setState({ agents: [] } as never);
  useMachineStore.setState({
    machines: [machine],
    deleteMachine: async (id: string) => { deletedMachines.push(id); },
  } as never);
  render(wrap(
    createElement(MachineDetailPanel, { machine, hideHeader: true }),
    "/s/server/settings/computers/machine-1",
  ));
  fireEvent.click(screen.getByRole("button", { name: "Delete computer" }));
  await act(async () => {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete computer" }));
  });
  assert.ok(screen.queryByRole("dialog") === null);
  assert.deepEqual(deletedMachines, [machine.id]);
  assert.equal(screen.getByTestId("location").textContent, "/s/server/settings/computers/machine-1");
});

// The Sidebar's agent menu is the chat sidebar's agent row now (the Members
// sidebar and its member rows went with the Members page, 2026-11-05): the
// agent's row under Direct messages, from its DM.
test("the mounted Sidebar agent menu does not fabricate an unreachable delete confirmation", async () => {
  seedStores();
  // The sidebar holds its DM rows behind a skeleton until the DMs have loaded.
  useChannelStore.setState({
    dmsLoading: false,
    dmChannels: [{
      id: "dm-agent-1", name: "helper", description: null, type: "dm", createdAt: "2026-08-22T00:00:00.000Z",
      peerType: "agent", peerId: "agent-1", peerName: "helper", peerDisplayName: "Helper",
    }],
  } as never);
  render(wrap(createElement(Sidebar), "/s/server"));

  await screen.findAllByRole("button", { name: "Helper" });
  // The row itself (its avatar is a second "Helper" control inside it).
  const row = screen.getAllByRole("button", { name: "Helper" }).find((el) => el.getAttribute("data-slot") === "sidebar-item");
  assert.ok(row, "the agent's sidebar row");
  fireEvent.contextMenu(row, { clientX: 120, clientY: 160 });
  assert.ok(await screen.findByRole("menuitem", { name: "Pin" }), "the agent row's menu is open");
  assert.ok(screen.queryByRole("menuitem", { name: "Archive agent" }) === null);
  assert.ok(screen.queryByRole("dialog") === null);
});
