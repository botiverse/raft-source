import "../../../../tests/helpers/domSetup";

// The conversation header's entries (Nova, 2026-11-17): Search, the details (Settings or the channel's name), an agent
// DM's Lounge and Call, and the ⋯ record conversation_header_action_selected; Tasks / Files record channel_tab_selected.
// `compact`: the head was folded.
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, test } from "vitest";
import { AGENT_VOICE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import api from "../../../api/client";
import { flushProductEvents, resetProductEventsForTest } from "../../../analytics/track";
import { useRowPlanStore } from "../../../components/layout/rowPlanStore";
import { useAgentStore } from "../../../store/agentStore";
import type { Agent } from "../../../store/agentStore";
import { useAuthStore } from "../../../store/authStore";
import type { User } from "../../../store/authStore";
import { useChannelStore } from "../../../store/channelStore";
import type { Channel } from "../../../store/channelStore";
import { useMessageStore } from "../../../store/messageStore";
import { useServerStore } from "../../../store/serverStore";
import { AGENT_LOUNGE_FLAG_KEY, resetServerFeatureFlagsForTests, setServerFeatureFlagForTests, TASK_V2_CONVERSATIONS_FLAG_KEY } from "../../../store/serverFeatureFlags";
import { useTaskStore } from "../../../store/taskStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { useAgentVoiceCallStore } from "../../agent/agentVoiceCallStore";
import { ChatPanel } from "../ChatPanel";

type SentEvent = { event: string; properties: Record<string, unknown> };

const originalGet = api.get;
const originalRect = HTMLElement.prototype.getBoundingClientRect;
const HEADER_EVENTS = new Set(["conversation_header_action_selected", "channel_tab_selected"]);
const originalOpenLounge = useChannelStore.getState().openLounge;
const originalStartCall = useAgentVoiceCallStore.getState().startCall;

afterEach(() => {
  cleanup();
  api.get = originalGet;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  useRowPlanStore.setState({ plan: null });
  resetServerFeatureFlagsForTests();
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, openLounge: originalOpenLounge });
  useAgentVoiceCallStore.setState({ startCall: originalStartCall });
  useAgentStore.setState({ agents: [] });
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useServerStore.setState({ current: null, members: [] });
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
});

function captureProductEvents(): SentEvent[] {
  const sent: SentEvent[] = [];
  for (const storage of new Set([window.localStorage, globalThis.localStorage])) storage?.setItem("slock_access_token", "token-1");
  resetProductEventsForTest(async (url, init) => {
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: true }), { status: 200 });
    for (const { event, properties } of (JSON.parse(String(init?.body)) as { events: SentEvent[] }).events) sent.push({ event, properties });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });
  return sent;
}

async function headerEvents(sent: SentEvent[]) {
  await flushProductEvents();
  return sent.filter((item) => HEADER_EVENTS.has(item.event)).map(({ event, properties }) => [event, properties]);
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-1",
    serverId: "server-1",
    name: "general",
    description: null,
    type: "channel",
    joined: true,
    activityMuteSupported: false,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

/** The head as wide as `width` px; `planned`: the row is laid out by the plan (the head folds only then). */
function setHeadWidth(width: number, planned: boolean) {
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 40, width, height: 40, toJSON: () => ({}) } as DOMRect;
  };
  useRowPlanStore.setState({ plan: planned ? ({ units: [], groups: [] } as never) : null });
}

function renderChat(channel: Channel) {
  api.get = (async (url: string) => {
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;
  useAuthStore.setState({ user: { id: "user-1", name: "owner", displayName: "Owner" } as User, accessToken: "token", refreshToken: "refresh", initialized: true, loading: false });
  useServerStore.setState({
    current: { id: "server-1", name: "Server", slug: "server", ownerId: "user-1", role: "member", plan: "free", hideHumansFromMembers: false, createdAt: "2026-07-10T00:00:00.000Z" },
    members: [],
    billing: null,
    loadBilling: async () => {},
  } as never);
  setServerFeatureFlagForTests("server-1", TASK_V2_CONVERSATIONS_FLAG_KEY, true);
  useChannelStore.setState(channel.type === "dm"
    ? { channels: [], dmChannels: [channel], channelActivity: { [channel.id]: null } }
    : { channels: [channel], dmChannels: [], channelActivity: { [channel.id]: null } });
  useTaskStore.setState({ tasks: [], currentChannelId: channel.id, loadTasks: async () => {} } as never);
  return render(
    <MemoryRouter initialEntries={["/s/server/channel/channel-1"]}>
      <ChatPanel channel={channel} readOnly />
    </MemoryRouter>,
    { wrapper: TestIntlProvider },
  );
}

test("a wide channel header: Settings and the name opening the details, Search and Tasks record from the header, not compact", async () => {
  const sent = captureProductEvents();
  setHeadWidth(1200, true);
  await act(async () => {
    renderChat(makeChannel());
  });
  fireEvent.click(screen.getByTestId("channel-overflow-trigger"));
  fireEvent.click(screen.getByTestId("channel-overflow-trigger"));
  fireEvent.click(screen.getByTestId("channel-header-title-button"));
  fireEvent.click(screen.getByTestId("channel-header-title-button"));
  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  fireEvent.click(screen.getByTestId("channel-tasks-toggle"));
  assert.ok(screen.queryByTestId("channel-header-overflow-trigger") === null, "nothing folded: no ⋯");
  assert.deepEqual(await headerEvents(sent), [
    // Settings is a toggle: its second click closed the details and records nothing. The name's second tap, with the
    // details already open, records nothing either.
    ["conversation_header_action_selected", { action: "open_details", surface: "header", conversation: "channel", compact: false }],
    ["conversation_header_action_selected", { action: "open_details", surface: "title", conversation: "channel", compact: false }],
    ["conversation_header_action_selected", { action: "search", surface: "header", conversation: "channel", compact: false }],
    ["channel_tab_selected", { tab: "tasks", surface: "side_card_toggle", was_active: false, compact: false }],
  ]);
});

test("a narrow channel header: the ⋯ opening and Search, Files and Settings chosen in it record more_menu, compact", async () => {
  const sent = captureProductEvents();
  setHeadWidth(160, true);
  await act(async () => {
    renderChat(makeChannel());
  });
  await waitFor(() => assert.ok(screen.getByTestId("channel-header-overflow-trigger")));
  assert.ok(screen.queryByTestId("channel-topbar-search") === null, "Search folded into ⋯");
  for (const item of ["channel-header-overflow-search", "channel-header-overflow-files", "channel-header-overflow-settings"]) {
    fireEvent.click(screen.getByTestId("channel-header-overflow-trigger"));
    fireEvent.click(await screen.findByTestId(item));
    await waitFor(() => assert.ok(screen.queryByTestId("channel-header-overflow-menu") === null, "the ⋯ closed"));
  }
  const menu = ["conversation_header_action_selected", { action: "open_menu", surface: "header", conversation: "channel", compact: true }];
  assert.deepEqual(await headerEvents(sent), [
    menu,
    ["conversation_header_action_selected", { action: "search", surface: "more_menu", conversation: "channel", compact: true }],
    menu,
    ["channel_tab_selected", { tab: "files", surface: "more_menu", was_active: false, compact: true }],
    menu,
    ["conversation_header_action_selected", { action: "open_details", surface: "more_menu", conversation: "channel", compact: true }],
  ]);
});

test("a DM header's Search records conversation dm", async () => {
  const sent = captureProductEvents();
  setHeadWidth(1200, true);
  await act(async () => {
    renderChat(makeChannel({ id: "dm-1", name: "dm-1", type: "dm", peerType: "user", peerId: "user-2", peerName: "ann" } as Partial<Channel>));
  });
  fireEvent.click(screen.getByTestId("channel-topbar-search"));
  assert.deepEqual(await headerEvents(sent), [
    ["conversation_header_action_selected", { action: "search", surface: "header", conversation: "dm", compact: false }],
  ]);
});

/** An agent DM whose agent offers a Lounge and can be called (the Lounge and Call flags on). */
async function renderAgentDm() {
  useAgentStore.setState({ agents: [{ id: "agent-1", name: "nova", displayName: "Nova", status: "active" } as Agent] });
  useChannelStore.setState({ openLounge: () => new Promise(() => {}) } as never);
  useAgentVoiceCallStore.setState({ startCall: () => {} });
  setServerFeatureFlagForTests("server-1", AGENT_LOUNGE_FLAG_KEY, true);
  setServerFeatureFlagForTests("server-1", AGENT_VOICE_FEATURE_FLAG_KEY, true);
  await act(async () => {
    renderChat(makeChannel({ id: "dm-1", name: "dm-1", type: "dm", peerType: "agent", peerId: "agent-1", peerName: "nova" } as Partial<Channel>));
  });
}

test("an agent DM's Call and Lounge record start_call / open_lounge, from the head and from inside the ⋯", async () => {
  const sent = captureProductEvents();
  setHeadWidth(1200, true);
  await renderAgentDm();
  fireEvent.click(screen.getByTestId("agent-dm-call"));
  fireEvent.click(screen.getByTestId("agent-dm-open-lounge"));
  cleanup();
  setHeadWidth(160, true);
  await renderAgentDm();
  await waitFor(() => assert.ok(screen.getByTestId("channel-header-overflow-trigger")));
  for (const item of ["channel-header-overflow-call", "channel-header-overflow-lounge"]) {
    fireEvent.click(screen.getByTestId("channel-header-overflow-trigger"));
    fireEvent.click(await screen.findByTestId(item));
    await waitFor(() => assert.ok(screen.queryByTestId("channel-header-overflow-menu") === null, "the ⋯ closed"));
  }
  const menu = ["conversation_header_action_selected", { action: "open_menu", surface: "header", conversation: "dm", compact: true }];
  assert.deepEqual(await headerEvents(sent), [
    ["conversation_header_action_selected", { action: "start_call", surface: "header", conversation: "dm", compact: false }],
    ["conversation_header_action_selected", { action: "open_lounge", surface: "header", conversation: "dm", compact: false }],
    menu,
    ["conversation_header_action_selected", { action: "start_call", surface: "more_menu", conversation: "dm", compact: true }],
    menu,
    ["conversation_header_action_selected", { action: "open_lounge", surface: "more_menu", conversation: "dm", compact: true }],
  ]);
});
