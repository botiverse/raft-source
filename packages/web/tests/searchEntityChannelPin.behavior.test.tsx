import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MemoryRouter, useLocation } from "react-router-dom";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import api from "../src/api/client";
import {
  ARCHIVED_CHANNEL_BADGE_CLASS,
  ARCHIVED_CHANNEL_ICON_CLASS,
  ARCHIVED_CHANNEL_MUTED_TEXT_CLASS,
  ARCHIVED_CHANNEL_TEXT_CLASS,
} from "../src/components/channel/channelArchiveVisual.js";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";
import type { Machine } from "../src/store/machineStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }
}

const originalGet = api.get;
const originalPatch = api.patch;
const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");

function assertElementHasClasses(element: Element | null | undefined, classes: string) {
  assert.ok(element instanceof HTMLElement, "expected an HTMLElement");
  for (const className of classes.split(" ")) {
    assert.ok(
      element.className.includes(className),
      `expected class ${className} in ${element.className}`,
    );
  }
}

function currentSearchRoute(): string {
  return screen.getByTestId("search-route-probe").textContent ?? "";
}

function currentRouterState(): unknown {
  return JSON.parse(screen.getByTestId("search-route-probe").getAttribute("data-router-state") ?? "null");
}

function makeUser(): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
    displayName: "Current User",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeServer(): Server {
  return {
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
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeChannel(id: string, name: string, archivedAt: string | null): Channel {
  return {
    id,
    serverId: "server-1",
    name,
    description: null,
    type: "channel",
    createdAt: "2026-07-01T00:00:00.000Z",
    archivedAt,
    joined: true,
  };
}

function makeDmChannel(id: string, peerId: string): Channel {
  return {
    ...makeChannel(id, `dm-${peerId}`, null),
    type: "dm",
    peerType: "agent",
    peerId,
    peerName: peerId,
    peerDisplayName: peerId,
  };
}

function makeMessageResult({
  id,
  channelId,
  channelType = "channel",
  parentChannelId = channelId,
  parentMessageId = null,
}: {
  id: string;
  channelId: string;
  channelType?: "channel" | "dm" | "thread";
  parentChannelId?: string;
  parentMessageId?: string | null;
}) {
  return {
    id,
    channelId,
    threadId: channelType === "thread" ? parentMessageId : null,
    parentMessageId,
    parentMessageContent: parentMessageId ? "Parent message" : null,
    parentChannelId,
    parentChannelName: "route-parent",
    parentChannelType: channelType === "dm" ? "dm" : "channel",
    parentChannelArchivedAt: null,
    senderId: "user-1",
    senderType: "user",
    senderName: "Current User",
    channelName: channelType === "thread" ? "thread" : "route-channel",
    channelType,
    channelArchivedAt: null,
    content: `content ${id}`,
    snippet: `snippet ${id}`,
    createdAt: "2026-07-01T04:00:00.000Z",
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output
      data-testid="search-route-probe"
      data-router-state={JSON.stringify(location.state)}
    >
      {`${location.pathname}${location.search}`}
    </output>
  );
}

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    serverId: "server-1",
    name,
    displayName: null,
    avatarUrl: null,
    description: null,
    status: "idle",
    model: "gpt-5",
    runtime: "codex",
    serverRole: "member",
    runtimeConfig: null,
    lastRuntimeError: null,
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    runtimeProfile: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

async function renderSearchPage({
  query = "design",
  channels = [
    makeChannel("channel-active", "design", null),
    makeChannel("channel-archived", "design-archive", "2026-07-02T00:00:00.000Z"),
  ],
  members = [] as ServerMember[],
  agents = [] as Agent[],
  machines = [] as Machine[],
  dmChannels = [] as Channel[],
} = {}) {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
  localStorage.setItem("slock_access_token", "token");

  const { default: MessageSearchPage } = await import("../src/components/search/MessageSearchPage");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useMachineStore } = await import("../src/store/machineStore");
  const { useSearchContentStore } = await import("../src/store/searchContentStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useThreadStore } = await import("../src/store/threadStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    current: makeServer(),
    members,
    sidebarOrder: { ...DEFAULT_SIDEBAR_ORDER },
  });
  useChannelStore.setState({
    channels,
    dmChannels,
  });
  useAgentStore.setState({
    agents,
    agentActivities: {},
  });
  useMachineStore.setState({ machines });
  useSearchContentStore.setState({ slot: null });
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
  });

  render(
    <MemoryRouter initialEntries={[`/s/server/search?q=${encodeURIComponent(query)}`]}>
      <MessageSearchPage />
      <LocationProbe />
    </MemoryRouter>,
  );

  return { useSearchContentStore, useServerStore };
}

afterEach(() => {
  api.get = originalGet;
  api.patch = originalPatch;
  if (originalWorkerDescriptor) {
    Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "Worker");
  }
  cleanup();
});

test("archived channel search results render with the shared muted visual treatment", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  api.patch = (async (_url: string, data?: unknown) => ({ data })) as typeof api.patch;

  await renderSearchPage();

  const archivedResult = screen.getByTestId("search-channel-result-channel-archived");
  const activeResult = screen.getByTestId("search-channel-result-channel-active");

  assertElementHasClasses(screen.getByText("design-archive"), ARCHIVED_CHANNEL_TEXT_CLASS);
  assert.doesNotMatch(
    screen.getByText("design").className,
    /text-black\/45/,
    "active channel search result title should keep the active visual treatment",
  );
  assertElementHasClasses(
    archivedResult.querySelector("svg")?.closest("div"),
    ARCHIVED_CHANNEL_ICON_CLASS,
  );
  assert.doesNotMatch(
    activeResult.querySelector("svg")?.closest("div")?.className ?? "",
    /bg-black\/5/,
    "active channel search result icon should keep the yellow hash treatment",
  );
  assertElementHasClasses(within(archivedResult).getByText("Archived"), ARCHIVED_CHANNEL_BADGE_CLASS);
  assertElementHasClasses(
    within(archivedResult).getAllByText("Channel").find((element) => element.className.includes("uppercase")),
    ARCHIVED_CHANNEL_BADGE_CLASS,
  );
  assertElementHasClasses(
    within(archivedResult).getAllByText("Channel").find((element) => element.className.includes("text-xs")),
    ARCHIVED_CHANNEL_MUTED_TEXT_CLASS,
  );
});

test("global Search renders a Chinese entity found through the shared pinyin matcher", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  await renderSearchPage({
    query: "duihua",
    channels: [makeChannel("channel-pinyin", "对话流专修", null)],
  });

  assert.ok(screen.getByTestId("search-channel-result-channel-pinyin"));
  assert.ok(screen.getByText("对话流专修"));
});

test("global Search keeps # channel scope literal matching when a large candidate set has no Worker", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  Object.defineProperty(globalThis, "Worker", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const channels = Array.from({ length: 200 }, (_, index) => (
    makeChannel(
      index === 137 ? "channel-design" : `channel-${index}`,
      index === 137 ? "design" : `channel-${index}`,
      null,
    )
  ));

  await renderSearchPage({ query: "#design", channels });

  assert.ok(screen.getByTestId("search-channel-result-channel-design"));
  assert.ok(screen.getByText("design"));
});

test("global Search keeps @ people scope literal matching when a large candidate set has no Worker", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  Object.defineProperty(globalThis, "Worker", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  const agents = Array.from({ length: 200 }, (_, index) => (
    makeAgent(
      index === 137 ? "agent-ray" : `agent-${index}`,
      index === 137 ? "ray" : `agent-${index}`,
    )
  ));

  await renderSearchPage({ query: "@ray", channels: [], agents });

  const rayResult = screen.getByText("ray");
  assert.ok(rayResult.closest("button"), "the degraded @ match should render as an actionable agent result");
});

test("global Search visually selects only the active entity result", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  await renderSearchPage({
    query: "design",
    channels: [makeChannel("channel-design", "design", null)],
    agents: [makeAgent("agent-design", "design-agent")],
  });

  const channelResult = screen.getByTestId("search-channel-result-channel-design");
  const agentButton = screen.getByText("design-agent").closest("button");
  const agentResult = agentButton?.parentElement;

  await waitFor(() => {
    assertElementHasClasses(channelResult, "border-black shadow-brutal-sm");
  });
  assert.ok(agentResult, "agent result card");
  assert.doesNotMatch(
    agentResult.className,
    /(?:^|\s)shadow-brutal-sm(?:\s|$)/,
    "a non-channel entity must not look selected merely because both channel ids are absent",
  );
  assert.match(agentResult.className, /border-black\/30/);
});

test("active channel search results toggle pinned state from the shared right-click menu without opening the result", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  const patches: Array<{ url: string; data: unknown }> = [];
  api.patch = (async (url: string, data?: unknown) => {
    patches.push({ url, data });
    return { data };
  }) as typeof api.patch;

  const { useSearchContentStore } = await renderSearchPage();

  assert.equal(
    screen.queryByRole("button", { name: "Pin #design" }),
    null,
    "search results must not expose a persistent pin button",
  );

  fireEvent.contextMenu(screen.getByTestId("search-channel-result-channel-archived"));
  assert.equal(
    screen.queryByRole("menu", { name: "Channel control menu for #design-archive" }),
    null,
    "archived channel results must not expose the channel control menu",
  );

  fireEvent.contextMenu(screen.getByTestId("search-channel-result-channel-active"));
  assert.ok(screen.getByRole("menu", { name: "Channel control menu for #design" }));
  assert.equal(
    document.activeElement,
    screen.getByRole("menuitem", { name: "Open" }),
    "the right-click menu must move keyboard focus into its first shared action row",
  );
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Open" }), { key: "Escape" });
  assert.equal(
    screen.queryByRole("menu", { name: "Channel control menu for #design" }),
    null,
    "Escape must close the focused channel control menu without a document-level keydown listener",
  );

  fireEvent.contextMenu(screen.getByTestId("search-channel-result-channel-active"));
  assert.ok(screen.getByRole("menuitem", { name: "Open" }));
  assert.equal(screen.queryByRole("menuitem", { name: "Pin" }), null);
  assert.equal(screen.queryByRole("menuitem", { name: "Unpin" }), null);
  assert.deepEqual(patches, []);
  assert.equal(
    useSearchContentStore.getState().slot,
    null,
    "opening the context menu without choosing Open must not open the channel",
  );
});

test("Open from the active channel right-click menu uses the double-click chat route", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;
  api.patch = (async (_url: string, data?: unknown) => ({ data })) as typeof api.patch;

  const { useSearchContentStore } = await renderSearchPage();
  useSearchContentStore.setState({
    slot: { kind: "channel", id: "channel-active" },
  });

  fireEvent.contextMenu(screen.getByTestId("search-channel-result-channel-active"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));

  await waitFor(() => {
    assert.equal(
      useSearchContentStore.getState().slot,
      null,
      "Open must leave the search-detail slot just like a double-click",
    );
    assert.equal(currentSearchRoute(), "/s/server/channel/channel-active");
  });
  assert.deepEqual(currentRouterState(), {
    sidebarChannelFocus: { kind: "channel", id: "channel-active", align: "center" },
  });
  assert.equal(
    screen.queryByRole("menu", { name: "Channel control menu for #design" }),
    null,
  );
});

test("channel result single-click stays in Search detail while double-click routes to centered chat", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  const { useSearchContentStore } = await renderSearchPage({
    query: "route-channel",
    channels: [makeChannel("channel-route", "route-channel", null)],
  });
  const result = screen.getByTestId("search-channel-result-channel-route");
  const button = result.querySelector("button");
  assert.ok(button instanceof HTMLButtonElement);

  fireEvent.click(button, { detail: 1 });
  await waitFor(() => {
    assert.deepEqual(useSearchContentStore.getState().slot, { kind: "channel", id: "channel-route" });
  });
  assert.equal(currentSearchRoute(), "/s/server/search?q=route-channel");

  act(() => useSearchContentStore.setState({ slot: { kind: "channel", id: "channel-route" } }));
  fireEvent.click(button, { detail: 1 });
  fireEvent.click(button, { detail: 2 });
  await waitFor(() => {
    assert.equal(currentSearchRoute(), "/s/server/channel/channel-route");
    assert.equal(useSearchContentStore.getState().slot, null);
  });
  assert.deepEqual(currentRouterState(), {
    sidebarChannelFocus: { kind: "channel", id: "channel-route", align: "center" },
  });
});

test("agent DM result double-click routes to the existing DM conversation", async () => {
  api.get = (async () => ({ data: { hasMore: false, results: [] } })) as typeof api.get;

  const agent = makeAgent("agent-route", "route-agent");
  const { useSearchContentStore } = await renderSearchPage({
    query: "route-agent",
    channels: [],
    agents: [agent],
    dmChannels: [makeDmChannel("dm-route", agent.id)],
  });
  const button = screen.getByText("route-agent").closest("button");
  assert.ok(button instanceof HTMLButtonElement);

  act(() => useSearchContentStore.setState({ slot: { kind: "agent", id: agent.id } }));
  fireEvent.click(button, { detail: 1 });
  fireEvent.click(button, { detail: 2 });
  await waitFor(() => {
    assert.equal(currentSearchRoute(), "/s/server/dm/dm-route");
    assert.equal(useSearchContentStore.getState().slot, null);
  });
});

test("message single-click and Enter stay in Search detail", async () => {
  const clickResult = makeMessageResult({
    id: "message-single",
    channelId: "channel-single",
  });
  api.get = (async () => ({ data: { hasMore: false, results: [clickResult] } })) as typeof api.get;

  let rendered = await renderSearchPage({ query: "single-message", channels: [] });
  let button = (await screen.findByText("snippet message-single")).closest("button");
  assert.ok(button instanceof HTMLButtonElement);
  fireEvent.click(button, { detail: 1 });
  await waitFor(() => {
    assert.deepEqual(rendered.useSearchContentStore.getState().slot, {
      kind: "channel",
      id: "channel-single",
      messageId: "message-single",
    });
  });
  assert.equal(currentSearchRoute(), "/s/server/search?q=single-message");

  cleanup();
  const enterResult = makeMessageResult({
    id: "message-enter",
    channelId: "channel-enter",
  });
  api.get = (async () => ({ data: { hasMore: false, results: [enterResult] } })) as typeof api.get;
  rendered = await renderSearchPage({ query: "enter-message", channels: [] });
  button = (await screen.findByText("snippet message-enter")).closest("button");
  assert.ok(button instanceof HTMLButtonElement);
  button.focus();
  fireEvent.keyDown(button, { key: "Enter" });
  await waitFor(() => {
    assert.deepEqual(rendered.useSearchContentStore.getState().slot, {
      kind: "channel",
      id: "channel-enter",
      messageId: "message-enter",
    });
  });
  assert.equal(currentSearchRoute(), "/s/server/search?q=enter-message");
});

test("message and thread double-clicks route to canonical permalinks with parent context", async () => {
  const messageResult = makeMessageResult({
    id: "message-double",
    channelId: "channel-double",
  });
  api.get = (async () => ({ data: { hasMore: false, results: [messageResult] } })) as typeof api.get;

  let rendered = await renderSearchPage({ query: "double-message", channels: [] });
  let button = (await screen.findByText("snippet message-double")).closest("button");
  assert.ok(button instanceof HTMLButtonElement);
  act(() => rendered.useSearchContentStore.setState({ slot: { kind: "channel", id: "channel-double" } }));
  fireEvent.click(button, { detail: 1 });
  fireEvent.click(button, { detail: 2 });
  await waitFor(() => {
    assert.equal(currentSearchRoute(), "/s/server/channel/channel-double?msg=message-double");
    assert.equal(rendered.useSearchContentStore.getState().slot, null);
  });
  assert.deepEqual(currentRouterState(), {
    sidebarChannelFocus: { kind: "channel", id: "channel-double", align: "center" },
  });

  cleanup();
  const threadResult = makeMessageResult({
    id: "thread-reply",
    channelId: "thread-channel",
    channelType: "thread",
    parentChannelId: "parent-channel",
    parentMessageId: "parent-message",
  });
  api.get = (async () => ({ data: { hasMore: false, results: [threadResult] } })) as typeof api.get;
  rendered = await renderSearchPage({ query: "thread-message", channels: [] });
  button = (await screen.findByText("snippet thread-reply")).closest("button");
  assert.ok(button instanceof HTMLButtonElement);
  act(() => rendered.useSearchContentStore.setState({ slot: { kind: "thread", id: "thread-channel", messageId: "thread-reply" } }));
  fireEvent.click(button, { detail: 1 });
  fireEvent.click(button, { detail: 2 });
  await waitFor(() => {
    assert.equal(
      currentSearchRoute(),
      "/s/server/channel/parent-channel?msg=thread-reply&thread=parent-channel%3Aparent-message",
    );
    assert.equal(rendered.useSearchContentStore.getState().slot, null);
  });
  assert.deepEqual(currentRouterState(), {
    sidebarChannelFocus: { kind: "channel", id: "parent-channel", align: "center" },
  });
});
