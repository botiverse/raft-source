import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import api from "../src/api/client";
import { LeftRail } from "../src/components/layout/LeftRail";
import { useWorkspaceGridNavigationStore } from "../src/components/workspace/workspaceGridNavigationStore";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

const originalApiGet = api.get;
const originalServerState = useServerStore.getState();

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  localStorage.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useInboxStore.setState(useInboxStore.getInitialState(), true);
  useServerStore.setState(originalServerState, true);
  useThreadStore.setState(useThreadStore.getInitialState(), true);
  useWorkspaceGridNavigationStore.setState(useWorkspaceGridNavigationStore.getInitialState(), true);
});

function seedActivityRail(
  loadInboxCalls: Array<{ reset?: boolean; background?: boolean }>,
  openThreadCalls: unknown[],
) {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  useAuthStore.setState({
    user: {
      id: "user-activity-rail",
      email: "activity-rail@example.com",
      gravatarHash: "",
      name: "activity-rail",
      displayName: "Activity Rail",
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
    ...originalServerState,
    current: {
      id: "server-activity-rail",
      name: "Activity Rail Server",
      slug: "activity-rail",
      avatarUrl: null,
      ownerId: "user-activity-rail",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-08-20T00:00:00.000Z",
    },
    servers: [],
    members: [],
  } as never);
  useInboxStore.setState({
    pendingFocusKind: null,
    loadInbox: async (options) => {
      loadInboxCalls.push(options ?? {});
    },
  });
  useThreadStore.setState({
    openThreadChannelId: null,
    openThread: async (request) => {
      openThreadCalls.push(request);
    },
  });
}

function LocationRecorder({ paths }: { paths: string[] }) {
  const location = useLocation();
  useEffect(() => {
    paths.push(location.pathname);
  }, [location, paths]);
  return <div data-testid="activity-rail-location">{location.pathname}</div>;
}

test("the rail server avatar falls back to its initial after an image load error", () => {
  api.get = (() => new Promise(() => {})) as typeof api.get;
  useServerStore.setState({
    ...originalServerState,
    current: {
      id: "server-1",
      name: "Botiverse",
      slug: "botiverse",
      avatarUrl: "https://cdn.example.com/broken-server.png",
    } as never,
  });

  const { container } = render(
    <MemoryRouter initialEntries={["/s/botiverse/channel/general"]}>
      <TestIntlProvider>
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const switcher = container.querySelector<HTMLButtonElement>('button[aria-label*="Botiverse"]');
  assert.ok(switcher);
  const avatar = switcher.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/broken-server.png"]');
  assert.ok(avatar);
  assert.equal(switcher.textContent?.trim(), "B");

  fireEvent.error(avatar);
  assert.equal(avatar.hidden, true);
  assert.equal(switcher.textContent?.trim(), "B");

  act(() => {
    useServerStore.setState({
      current: {
        ...useServerStore.getState().current!,
        avatarUrl: "https://cdn.example.com/replacement-server.png",
      },
    });
  });
  const replacement = switcher.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/replacement-server.png"]');
  assert.ok(replacement);
  assert.equal(replacement.hidden, false);
});

test("the Activity dot follows the server-authoritative summary, not the local inbox aggregate", async () => {
  seedActivityRail([], []);
  let summaryRequests = 0;
  api.get = (() => {
    summaryRequests += 1;
    return Promise.resolve({
      data: [{
        serverId: "server-activity-rail",
        unreadCount: 1,
        serverPushMuted: false,
        activityUnreadCount: 1,
      }],
    });
  }) as typeof api.get;
  useInboxStore.setState({ activeUnreadCount: 0 });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <TestIntlProvider>
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const activityButton = document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  assert.ok(activityButton, "Activity rail button renders");
  const currentActivityButton = () => document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  await waitFor(() => {
    assert.equal(summaryRequests, 1, "left rail must load the server summary");
    assert.notEqual(currentActivityButton()?.querySelector('span[aria-hidden="true"]'), null, "positive server-authoritative unread shows the dot");
  });

  act(() => {
    useInboxStore.setState({ activeUnreadCount: 2 });
  });
  // The rail may commit for unrelated async work already queued by the full
  // suite; the contract is that this local aggregate cannot change the
  // server-authoritative Activity presentation.
  assert.notEqual(currentActivityButton()?.querySelector('span[aria-hidden="true"]'), null, "server-authoritative dot remains visible");
});

test("classic Activity double-click navigates once and only adds first-unread focus", () => {
  const loadInboxCalls: Array<{ reset?: boolean; background?: boolean }> = [];
  const openThreadCalls: unknown[] = [];
  const paths: string[] = [];
  seedActivityRail(loadInboxCalls, openThreadCalls);
  useWorkspaceGridNavigationStore.setState({ active: false, enabled: false });

  render(
    <MemoryRouter initialEntries={["/s/activity-rail/channel/general"]}>
      <TestIntlProvider>
        <LocationRecorder paths={paths} />
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const activityButton = document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  assert.ok(activityButton);
  assert.deepEqual(paths, ["/s/activity-rail/channel/general"]);

  fireEvent.click(activityButton, { detail: 1 });
  assert.deepEqual(paths, ["/s/activity-rail/channel/general", "/s/activity-rail/activity"]);

  fireEvent.click(activityButton, { detail: 2 });
  fireEvent.doubleClick(activityButton);

  assert.deepEqual(
    paths,
    ["/s/activity-rail/channel/general", "/s/activity-rail/activity"],
    "the second click in the browser double-click sequence must not navigate again",
  );
  assert.equal(useInboxStore.getState().pendingFocusKind, "first-unread");
  assert.deepEqual(loadInboxCalls, [{ reset: true }]);
  assert.deepEqual(openThreadCalls, []);
  assert.equal(useThreadStore.getState().openThreadChannelId, null);
});

test("Workspace Activity double-click selects its rail once and only adds first-unread focus", () => {
  const loadInboxCalls: Array<{ reset?: boolean; background?: boolean }> = [];
  const openThreadCalls: unknown[] = [];
  const railModeCalls: string[] = [];
  seedActivityRail(loadInboxCalls, openThreadCalls);
  useWorkspaceGridNavigationStore.setState({
    active: true,
    enabled: true,
    railMode: null,
    activeRailSide: "left",
    railLayout: { left: ["activity"], right: [] },
    sidebars: {
      left: { activeItem: null, collapsed: true },
      right: { activeItem: null, collapsed: true },
    },
  });
  const setRailMode = useWorkspaceGridNavigationStore.getState().setRailMode;
  useWorkspaceGridNavigationStore.setState({
    setRailMode: (mode, side, userId) => {
      railModeCalls.push(mode ?? "null");
      setRailMode(mode, side, userId);
    },
  });

  render(
    <MemoryRouter initialEntries={["/s/activity-rail/channel/general"]}>
      <TestIntlProvider>
        <LeftRail side="left" />
      </TestIntlProvider>
    </MemoryRouter>,
  );

  const activityButton = document.querySelector<HTMLButtonElement>('[data-testid="left-rail-tab-activity"]');
  assert.ok(activityButton);

  fireEvent.click(activityButton, { detail: 1 });
  assert.deepEqual(railModeCalls, ["activity"]);
  assert.equal(useWorkspaceGridNavigationStore.getState().sidebars.left.activeItem, "activity");

  fireEvent.click(activityButton, { detail: 2 });
  fireEvent.doubleClick(activityButton);

  assert.deepEqual(railModeCalls, ["activity"], "the second click must not re-select Workspace Activity");
  assert.equal(useInboxStore.getState().pendingFocusKind, "first-unread");
  assert.deepEqual(loadInboxCalls, [{ reset: true }]);
  assert.deepEqual(openThreadCalls, []);
  assert.equal(useThreadStore.getState().openThreadChannelId, null);
});
