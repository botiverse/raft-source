import assert from "node:assert/strict";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAgentStore } from "../../../store/agentStore";
import { useAuthStore } from "../../../store/authStore";
import type { User } from "../../../store/authStore";
import { useChannelStore } from "../../../store/channelStore";
import type { Channel } from "../../../store/channelStore";
import { useMachineStore } from "../../../store/machineStore";
import { useRecentConversationStore } from "../../../store/recentConversationStore";
import { useServerStore } from "../../../store/serverStore";
import type { Server, ServerMember } from "../../../store/serverStore";
import { useRecentConversationEntities, useSearchEntityCatalog } from "../useRecentConversationEntities";

// Task #127: the ⌘K overlay's empty state and the desktop History menu share
// one resolution of "recently visited conversations". This pins the hook the
// menu consumes (visit order, exclusions, the visits-only mode).

function makeUser(): User {
  return {
    id: "user-1", email: "current@example.com", name: "current", displayName: "Current User",
    description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null, preferredTimezone: null,
    autoTranslationEnabled: false, preferredTimeFormat: null, preferredMessageBodyFontSize: null,
    referralSource: null, referralSourceOther: null, referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
    id: "server-1", name: "Server", slug: "server", ownerId: "user-1", onboardingAgentId: null,
    hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner", createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeChannel(id: string, name: string, archivedAt: string | null = null): Channel {
  return { id, serverId: "server-1", name, description: null, type: "channel", createdAt: "2026-07-01T00:00:00.000Z", archivedAt, joined: true };
}

function makeAgentDm(id = "dm-agent-1"): Channel {
  return {
    id, serverId: "server-1", name: "dm", description: null, type: "dm", createdAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null, joined: true, peerType: "agent", peerId: "agent-1", peerName: "Helper", peerAvatarUrl: null,
  } as Channel;
}

function seed(options: { visits?: string[]; activity?: Record<string, string>; hiddenDmIds?: string[] } = {}) {
  useAuthStore.setState({ user: makeUser(), accessToken: "token", refreshToken: "refresh", loading: false, initialized: true });
  useServerStore.setState({
    current: makeServer(),
    members: [] as ServerMember[],
    sidebarOrder: { ...useServerStore.getState().sidebarOrder, hiddenDmIds: options.hiddenDmIds ?? [] },
  });
  useChannelStore.setState({
    channels: [makeChannel("channel-1", "design"), makeChannel("channel-2", "design-system"), makeChannel("channel-3", "random"), makeChannel("channel-4", "old", "2026-08-01T00:00:00.000Z")],
    dmChannels: [makeAgentDm()],
    channelActivity: options.activity ?? {},
  });
  useAgentStore.setState({
    agents: [{ id: "agent-1", name: "helper", displayName: "Helper", description: null, avatarUrl: null, deletedAt: null } as never],
    agentActivities: {},
  });
  useMachineStore.setState({ machines: [] });
  useRecentConversationStore.setState({
    scopes: options.visits ? { "server-1:user-1": { channelIds: options.visits, lastTouchedAt: 1 } } : {},
  });
}

afterEach(() => {
  useRecentConversationStore.setState({ scopes: {} });
  cleanup();
});

const ids = (entities: readonly { channelId: string | null }[]) => entities.map((e) => e.channelId);

test("visits first in visit order; archived, hidden DMs and the current conversation are excluded; activity fills by default", () => {
  seed({
    visits: ["channel-1", "channel-4", "dm-agent-1", "channel-3"],
    activity: { "channel-2": "2026-09-21T00:00:00.000Z" },
    hiddenDmIds: ["dm-agent-1"],
  });
  const { result } = renderHook(() => useRecentConversationEntities({ excludeChannelId: "channel-1" }));
  // channel-1 = current (excluded), channel-4 archived, dm-agent-1 hidden;
  // channel-3 visited; channel-2 filled from activity.
  assert.deepEqual(ids(result.current), ["channel-3", "channel-2"]);
});

test("fillFromActivity=false lists only conversations the user actually visited (History menu)", () => {
  seed({ visits: ["channel-3", "dm-agent-1"], activity: { "channel-2": "2026-09-21T00:00:00.000Z" } });
  const { result } = renderHook(() => useRecentConversationEntities({ fillFromActivity: false }));
  assert.deepEqual(ids(result.current), ["channel-3", "dm-agent-1"]);
  assert.equal(result.current[1]?.type, "agentDm");
});

test("no visits + visits-only → empty; enabled=false → empty selection", () => {
  seed({ activity: { "channel-2": "2026-09-21T00:00:00.000Z" } });
  const visitsOnly = renderHook(() => useRecentConversationEntities({ fillFromActivity: false }));
  assert.deepEqual(ids(visitsOnly.result.current), []);
  const disabled = renderHook(() => useRecentConversationEntities({ enabled: false }));
  assert.deepEqual(ids(disabled.result.current), []);
});

test("a caller-provided catalog is used as-is and the hook builds no catalog of its own (one build per tree)", () => {
  seed({ visits: ["channel-3", "channel-1"] });
  const { result } = renderHook(() => {
    const catalog = useSearchEntityCatalog();
    // Same catalog, restricted by the caller: only channel-3 is eligible — proves
    // the provided catalog (not a rebuilt one) drives the selection.
    const restricted = { entries: catalog.entries, eligibleEntityKeys: new Set(["channel:channel-3"]) };
    return useRecentConversationEntities({ catalog: restricted, fillFromActivity: false });
  });
  assert.deepEqual(ids(result.current), ["channel-3"]);
  // With a provided catalog the inner useSearchEntityCatalog returns that very
  // object, not a freshly built one.
  const probe = renderHook(() => {
    const catalog = useSearchEntityCatalog();
    return { catalog, inner: useSearchEntityCatalog(catalog) };
  });
  assert.equal(probe.result.current.inner, probe.result.current.catalog);
});

test("re-renders when a visit is recorded (store subscription)", () => {
  seed({ visits: ["channel-3"] });
  const { result } = renderHook(() => useRecentConversationEntities({ fillFromActivity: false }));
  assert.deepEqual(ids(result.current), ["channel-3"]);
  act(() => { useRecentConversationStore.getState().recordVisit("server-1:user-1", "channel-2", 2); });
  assert.deepEqual(ids(result.current), ["channel-2", "channel-3"]);
});
