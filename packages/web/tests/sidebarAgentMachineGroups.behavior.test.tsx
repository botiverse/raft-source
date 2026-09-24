import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar.js";
import { sidebarAgentMachineGroupCollapsedStorageKey } from "../src/components/layout/sidebarCollapsedSections";
import { TestIntlProvider } from "./helpers/intl";
import type { Agent } from "../src/store/agentStore";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Machine } from "../src/store/machineStore";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { useUIStore } from "../src/store/uiStore";

const originalApiGet = api.get;

afterEach(() => {
  api.get = originalApiGet;
  cleanup();
  localStorage.clear();
  useUIStore.setState({ sidebarOpen: false });
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

function makeAgent(name: string, machineId: string | null): Agent {
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
    machineId,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-06-28T00:00:00.000Z",
  };
}

function makeMachine(id: string, name: string): Machine {
  return {
    id,
    name,
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: null,
    runtimes: [],
    hostname: null,
    os: null,
    daemonVersion: null,
  } as Machine;
}

function seedSidebar(agents: Agent[], machines: Machine[]) {
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
      role: "owner",
      createdAt: "2026-06-28T00:00:00.000Z",
    },
    servers: [],
    members: [],
    membersLoadError: false,
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
  useMachineStore.setState({ machines, loading: false } as never);
  useAgentStore.setState({
    agents,
    loading: false,
    showCreateAgent: false,
    createAgentOnboarding: false,
  } as never);
}

function renderSidebar() {
  render(
    <MemoryRouter initialEntries={["/s/server/members"]}>
      <TestIntlProvider>
        <Sidebar />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("Members rail agent machine groups collapse and expand per machine", () => {
  seedSidebar(
    [makeAgent("Alpha", "machine-a"), makeAgent("Beta", "machine-a"), makeAgent("Gamma", "machine-b")],
    [makeMachine("machine-a", "maria"), makeMachine("machine-b", "aurora")],
  );
  renderSidebar();

  const toggleA = screen.getByTestId("sidebar-agent-machine-group-toggle-machine-a");
  const toggleB = screen.getByTestId("sidebar-agent-machine-group-toggle-machine-b");
  assert.match(toggleA.textContent ?? "", /maria2/);
  assert.match(toggleB.textContent ?? "", /aurora1/);
  assert.equal(toggleA.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByRole("button", { name: "Alpha" }));
  assert.ok(screen.getByRole("button", { name: "Gamma" }));

  // Collapsing machine-a hides only that group's rows.
  fireEvent.click(toggleA);
  assert.equal(toggleA.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("button", { name: "Alpha" }), null);
  assert.equal(screen.queryByRole("button", { name: "Beta" }), null);
  assert.ok(screen.getByRole("button", { name: "Gamma" }), "other machine groups stay expanded");
  assert.equal(toggleB.getAttribute("aria-expanded"), "true");

  // The choice is persisted per user and stable machine id.
  assert.equal(
    localStorage.getItem(sidebarAgentMachineGroupCollapsedStorageKey("user-1", "machine-a")),
    "true",
  );
  assert.equal(
    localStorage.getItem(sidebarAgentMachineGroupCollapsedStorageKey("user-1", "machine-b")),
    null,
  );

  // Expanding restores the rows.
  fireEvent.click(toggleA);
  assert.ok(screen.getByRole("button", { name: "Alpha" }));
  assert.equal(
    localStorage.getItem(sidebarAgentMachineGroupCollapsedStorageKey("user-1", "machine-a")),
    "false",
  );
});

test("Members rail machine group disclosure survives a remount", () => {
  seedSidebar(
    [makeAgent("Alpha", "machine-a"), makeAgent("Gamma", "machine-b")],
    [makeMachine("machine-a", "maria"), makeMachine("machine-b", "aurora")],
  );
  renderSidebar();
  fireEvent.click(screen.getByTestId("sidebar-agent-machine-group-toggle-machine-a"));
  cleanup();

  renderSidebar();
  assert.equal(screen.queryByRole("button", { name: "Alpha" }), null, "collapsed group stays collapsed after remount");
  assert.ok(screen.getByRole("button", { name: "Gamma" }));
});

test("machine-less agents collapse under their own group", () => {
  seedSidebar(
    [makeAgent("Alpha", "machine-a"), makeAgent("Loose", null)],
    [makeMachine("machine-a", "maria")],
  );
  renderSidebar();

  const toggleOrphan = screen.getByTestId("sidebar-agent-machine-group-toggle-__no_machine__");
  fireEvent.click(toggleOrphan);
  assert.equal(screen.queryByRole("button", { name: "Loose" }), null);
  assert.ok(screen.getByRole("button", { name: "Alpha" }), "machine groups are independent");
});
