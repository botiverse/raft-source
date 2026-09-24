import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import Sidebar from "../src/components/layout/Sidebar";
import { TestIntlProvider } from "./helpers/intl";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";

const originalApiGet = api.get;

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

function installApiStub() {
  api.get = (async (url: string) => {
    if (url === "/channels/inbox") {
      return { data: { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 } };
    }
    if (url === "/servers/unread-summary") return { data: [] };
    return { data: [] };
  }) as typeof api.get;
}

function seedOwner() {
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
    sidebarOrder: { ...DEFAULT_SIDEBAR_ORDER },
  } as never);
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
    loading: true,
  } as never);
  useMachineStore.setState({ machines: [], loading: true } as never);
  useAgentStore.setState({ agents: [], loading: true } as never);
}

function renderSidebar(initialEntry = "/s/server/channel/channel-1") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TestIntlProvider>
        <Sidebar mobileInline />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

function sectionHasSkeleton(sectionId: string) {
  return Boolean(document.querySelector(`#${sectionId} [aria-hidden="true"] .animate-pulse`));
}

test("Sidebar loading lists render shared skeleton rows instead of empty copy", () => {
  seedOwner();
  renderSidebar();

  assert.equal(screen.queryByText("No channels yet"), null);
  assert.equal(screen.queryByText("No joint channels yet"), null);
  assert.ok(sectionHasSkeleton("sidebar-section-channels"), "channels must skeleton while loading");
  assert.ok(sectionHasSkeleton("sidebar-section-joint-channels"), "joint channels must skeleton while loading");
  assert.ok(sectionHasSkeleton("sidebar-section-direct-messages"), "DMs must skeleton while loading");

  cleanup();
  seedOwner();
  renderSidebar("/s/server/computers");
  assert.equal(screen.queryByText("No computers yet"), null);
  assert.ok(document.querySelector(".animate-pulse"), "computers must skeleton while loading");

  cleanup();
  seedOwner();
  renderSidebar("/s/server/members");
  assert.equal(screen.queryByText("No agents yet"), null);
  assert.ok(document.querySelector(".animate-pulse"), "agents must skeleton while loading");
});

test("Sidebar empty copy appears only after the matching list has finished loading", () => {
  seedOwner();
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);

  renderSidebar();
  assert.ok(screen.getByText("No channels yet"));
  assert.ok(screen.getByText("No joint channels yet"));
  assert.equal(sectionHasSkeleton("sidebar-section-channels"), false);
  assert.equal(sectionHasSkeleton("sidebar-section-joint-channels"), false);
  assert.equal(sectionHasSkeleton("sidebar-section-direct-messages"), false);

  cleanup();
  seedOwner();
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  renderSidebar("/s/server/computers");
  assert.ok(screen.getByText("No computers yet"));

  cleanup();
  seedOwner();
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, loading: false } as never);
  useMachineStore.setState({ machines: [], loading: false } as never);
  useAgentStore.setState({ agents: [], loading: false } as never);
  renderSidebar("/s/server/members");
  assert.ok(screen.getByText("No agents yet"));
});
