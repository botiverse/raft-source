import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { BrowserRouter, MemoryRouter, useSearchParams } from "react-router-dom";
import api from "../src/api/client";
import ChatPanel from "../src/components/message/ChatPanel";
import { createRenderCounter } from "./helpers/renderCount";
import type { User } from "../src/store/authStore";
import { useAuthStore } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { useChannelStore } from "../src/store/channelStore";
import {
  refreshSyncCoreMessagesFlagForCurrentServer,
  resetSyncCoreMessagesFlagForTests,
} from "../src/store/messageSyncFeatureFlag";
import {
  resetMessagesSyncCoreForTests,
  SYNC_CORE_MESSAGES_FLAG_KEY,
} from "../src/store/messageSyncDomain";
import { REGISTERED_SERVER_FEATURE_FLAG_KEYS } from "../src/store/serverFeatureFlags";
import {
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type {
  MainLayoutSocketBridgeSocket,
} from "../src/store/socketBridge";
import {
  selectChannelMessageBucket,
  selectChannelWindowMeta,
  useMessageStore,
} from "../src/store/messageStore";
import type {
  Message,
} from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useTaskStore } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";

const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

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

globalThis.CSS = globalThis.CSS ?? ({ escape: (value: string) => value } as typeof CSS);
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, initialized: false, loading: false });
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {} });
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  resetMessagesSyncCoreForTests();
  resetSyncCoreMessagesFlagForTests();
  useServerStore.setState({ current: null, members: [] });
  useTaskStore.setState({ tasks: [], currentChannelId: null });
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

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

function setServerFlagState() {
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
  });
}

function stubSyncCoreFlagEvaluation(enabled: boolean) {
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-1",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return {
      data: {
        evaluations: [{ key: SYNC_CORE_MESSAGES_FLAG_KEY, enabled }],
      },
    };
  }) as typeof api.post;
}

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

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: "channel-a",
    serverId: "server-1",
    name: "general",
    description: null,
    type: "channel",
    joined: true,
    activityMuteSupported: false,
    createdAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

function setChatPanelState(
  target: Channel,
  rows: Message[],
  metaOverrides: Partial<{
    loading: boolean;
    hasMore: boolean;
    hasNewer: boolean;
    historyLimited: boolean;
  }> = {},
) {
  const loading = metaOverrides.loading ?? true;
  api.get = (async (url: string) => {
    if (url === "/messages/forward/enabled") return { data: { enabled: false } };
    if (url.endsWith("/members")) return { data: { humans: [], agents: [] } };
    if (url.endsWith("/notification-settings")) return { data: { activityMuted: false } };
    return { data: {} };
  }) as typeof api.get;
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
    channels: [target],
    dmChannels: [],
    channelActivity: { [target.id]: null },
  });
  useTaskStore.setState({
    tasks: [],
    currentChannelId: target.id,
    loadTasks: async () => {},
  });
  useMessageStore.setState({
    channelMessages: { [target.id]: rows },
    channelWindowMeta: {
      [target.id]: {
        loading,
        loadingOlder: false,
        loadingNewer: false,
        loadingGap: false,
        hasMore: metaOverrides.hasMore ?? false,
        hasNewer: metaOverrides.hasNewer ?? false,
        hasGap: false,
        historyLimited: metaOverrides.historyLimited ?? false,
        contextLoadError: null,
      },
    },
    messages: [],
    currentChannelId: target.id,
    loading,
    loadingOlder: false,
    loadingNewer: false,
    hasMore: metaOverrides.hasMore ?? false,
    hasNewer: metaOverrides.hasNewer ?? false,
    historyLimited: metaOverrides.historyLimited ?? false,
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

function ChannelProbe({ channelId }: { channelId: string }) {
  const messages = useMessageStore((state) => selectChannelMessageBucket(state, channelId));
  const meta = useMessageStore((state) => selectChannelWindowMeta(state, channelId));
  return (
    <output data-testid={`probe-${channelId}`}>
      {messages.map((item) => item.id).join(",") || "empty"}:{String(meta.loading)}
    </output>
  );
}

function WriteThreadThenBackToBottom({ threadParam }: { threadParam: string }) {
  const [, setSearchParams] = useSearchParams();

  return (
    <button
      type="button"
      data-testid="write-thread-then-back"
      onClick={() => {
        setSearchParams((previous) => {
          const next = new URLSearchParams(previous);
          next.set("thread", threadParam);
          return next;
        }, { replace: true });

        const backToBottom = Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent?.includes("Back to bottom"));
        assert.ok(backToBottom, "ChatPanel Back to bottom button is rendered");
        backToBottom.click();
      }}
    >
      write thread then back
    </button>
  );
}

function messageNewHandler() {
  const socket: MainLayoutSocketBridgeSocket = {
    connected: true,
    emit() {},
    on() {},
    off() {},
    onAny() {},
    offAny() {},
    disconnect() {},
    connect() {},
  };
  const binding = buildMainLayoutSocketBindings(
    socket,
    () => {},
    async () => {},
    () => {},
    () => {},
  ).find((item) => item.event === "message:new");
  assert.ok(binding);
  return binding.handler;
}

async function measureSocketMessageNewRenderCounts(flagVariant: "disabled" | "enabled") {
  resetMessagesSyncCoreForTests();
  resetSyncCoreMessagesFlagForTests();
  setServerFlagState();
  stubSyncCoreFlagEvaluation(flagVariant === "enabled");
  assert.equal(
    await refreshSyncCoreMessagesFlagForCurrentServer(),
    flagVariant === "enabled",
  );
  useMessageStore.setState(useMessageStore.getInitialState(), true);

  const rc = createRenderCounter();
  render(
    <>
      <rc.Count id="a"><ChannelProbe channelId="channel-a" /></rc.Count>
      <rc.Count id="b"><ChannelProbe channelId="channel-b" /></rc.Count>
    </>,
  );
  rc.reset();

  const handleMessageNew = messageNewHandler();
  act(() => {
    handleMessageNew(message("channel-a", 1));
  });

  return {
    channelARenders: rc.get("a"),
    channelBRenders: rc.get("b"),
    channelAText: screen.getByTestId("probe-channel-a").textContent,
    channelBText: screen.getByTestId("probe-channel-b").textContent,
  };
}

test("per-channel message bucket writes do not re-render unrelated channel subscribers", () => {
  const rc = createRenderCounter();
  render(
    <>
      <rc.Count id="a"><ChannelProbe channelId="channel-a" /></rc.Count>
      <rc.Count id="b"><ChannelProbe channelId="channel-b" /></rc.Count>
    </>,
  );

  const a0 = rc.get("a");
  const b0 = rc.get("b");
  assert.ok(a0 >= 1 && b0 >= 1, "both channel probes mounted");

  act(() => {
    useMessageStore.getState().addMessage(message("channel-a", 1));
  });

  assert.equal(screen.getByTestId("probe-channel-a").textContent, "channel-a-1:false");
  assert.equal(screen.getByTestId("probe-channel-b").textContent, "empty:false");
  assert.ok(rc.get("a") > a0, "channel A subscriber re-rendered for channel A message");
  assert.equal(rc.get("b"), b0, "channel B subscriber did not re-render for channel A message");
});

test("flagged socket message:new keeps per-channel render isolation no worse than flag-off", async () => {
  const flagOff = await measureSocketMessageNewRenderCounts("disabled");
  cleanup();
  const flagOn = await measureSocketMessageNewRenderCounts("enabled");

  assert.equal(flagOff.channelAText, "channel-a-1:false");
  assert.equal(flagOff.channelBText, "empty:false");
  assert.equal(flagOn.channelAText, "channel-a-1:false");
  assert.equal(flagOn.channelBText, "empty:false");
  assert.ok(flagOff.channelARenders > 0, "flag-off socket message:new renders the target channel");
  assert.ok(flagOn.channelARenders > 0, "flag-on socket message:new renders the target channel");
  assert.equal(flagOff.channelBRenders, 0, "flag-off socket message:new leaves the unrelated channel quiet");
  assert.equal(flagOn.channelBRenders, 0, "flag-on socket message:new leaves the unrelated channel quiet");
  assert.ok(
    flagOn.channelARenders <= flagOff.channelARenders,
    "flag-on socket message:new must not add target-channel render commits beyond flag-off",
  );
});

test("per-channel window metadata writes do not re-render unrelated channel subscribers", () => {
  const rc = createRenderCounter();
  render(
    <>
      <rc.Count id="a"><ChannelProbe channelId="channel-a" /></rc.Count>
      <rc.Count id="b"><ChannelProbe channelId="channel-b" /></rc.Count>
    </>,
  );

  const a0 = rc.get("a");
  const b0 = rc.get("b");

  act(() => {
    useMessageStore.setState((state) => ({
      channelWindowMeta: {
        ...state.channelWindowMeta,
        "channel-a": {
          loading: true,
          loadingOlder: false,
          loadingNewer: false,
          loadingGap: false,
          hasMore: true,
          hasNewer: false,
          hasGap: false,
          historyLimited: false,
          contextLoadError: null,
        },
      },
    }));
  });

  assert.equal(screen.getByTestId("probe-channel-a").textContent, "empty:true");
  assert.equal(screen.getByTestId("probe-channel-b").textContent, "empty:false");
  assert.ok(rc.get("a") > a0, "channel A subscriber re-rendered for channel A metadata");
  assert.equal(rc.get("b"), b0, "channel B subscriber did not re-render for channel A metadata");
});

test("current-channel window metadata fallback returns a stable snapshot", () => {
  const baseMeta = {
    currentChannelId: "channel-a",
    channelWindowMeta: {},
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    loadingGap: false,
    hasMore: false,
    hasNewer: false,
    hasGap: false,
    historyLimited: false,
    contextLoadError: null,
  };

  useMessageStore.setState(baseMeta);

  const first = selectChannelWindowMeta(useMessageStore.getState(), "channel-a");
  const second = selectChannelWindowMeta(useMessageStore.getState(), "channel-a");
  assert.equal(second, first);

  useMessageStore.setState({ drafts: { "channel-a": "typing does not affect metadata" } });
  const unrelated = selectChannelWindowMeta(useMessageStore.getState(), "channel-a");
  assert.equal(unrelated, first);

  useMessageStore.setState({ loading: true });
  const changed = selectChannelWindowMeta(useMessageStore.getState(), "channel-a");
  assert.notEqual(changed, first);
  assert.equal(selectChannelWindowMeta(useMessageStore.getState(), "channel-a"), changed);

  const invalidatingFields = [
    ["loading", true],
    ["loadingOlder", true],
    ["loadingNewer", true],
    ["loadingGap", true],
    ["hasMore", true],
    ["hasNewer", true],
    ["hasGap", true],
    ["historyLimited", true],
    ["contextLoadError", "failed"],
  ] as const;

  for (const [field, value] of invalidatingFields) {
    useMessageStore.setState(baseMeta);
    const baseline = selectChannelWindowMeta(useMessageStore.getState(), "channel-a");

    useMessageStore.setState({ [field]: value });
    const next = selectChannelWindowMeta(useMessageStore.getState(), "channel-a");

    assert.notEqual(next, baseline, `${field} invalidates the cached fallback snapshot`);
    assert.equal(next[field], value);
    assert.equal(selectChannelWindowMeta(useMessageStore.getState(), "channel-a"), next);
  }
});

test("ChatPanel keeps cached channel rows visible while a same-channel load is pending", async () => {
  const target = channel();
  setChatPanelState(target, [message(target.id, 1)]);

  const view = await act(async () => render(
    <MemoryRouter>
      <ChatPanel channel={target} readOnly />
    </MemoryRouter>,
  ));

  try {
    assert.equal(screen.queryByText("Loading…"), null);
    assert.equal(screen.queryByText("No messages yet"), null);
    assert.ok(screen.getByText("channel-a message 1"));
  } finally {
    await act(async () => view.unmount());
  }
});

test("ChatPanel clear-focused action preserves a same-tick thread param", async () => {
  const target = channel();
  setChatPanelState(target, [message(target.id, 1)], { loading: false, hasNewer: true });
  window.history.replaceState({}, "", `/s/server/channel/${target.id}?msg=${target.id}-1&view=list`);

  const view = await act(async () => render(
    <BrowserRouter>
      <WriteThreadThenBackToBottom threadParam={`${target.id}:${target.id}-1`} />
      <ChatPanel channel={target} readOnly />
    </BrowserRouter>,
  ));

  try {
    await act(async () => {
      screen.getByTestId("write-thread-then-back").click();
      await Promise.resolve();
    });

    const query = new URLSearchParams(window.location.search);
    assert.equal(query.get("view"), "list");
    assert.equal(query.get("thread"), `${target.id}:${target.id}-1`);
    assert.equal(query.has("msg"), false);
    assert.equal(query.has("message"), false);
  } finally {
    await act(async () => view.unmount());
  }
});

test("ChatPanel reloads only when the selected channel id changes, not when same-channel metadata changes", async () => {
  const first = channel({ id: "identity-a", name: "initial-name" });
  const sameIdentity = channel({ id: "identity-a", name: "renamed-channel" });
  const second = channel({ id: "identity-b", name: "second-channel" });
  const loadCalls: string[] = [];
  setChatPanelState(first, [], { loading: false });
  useMessageStore.setState({
    loadMessages: async (channelId) => {
      loadCalls.push(channelId);
    },
  });

  const view = await act(async () => render(
    <MemoryRouter>
      <ChatPanel channel={first} readOnly />
    </MemoryRouter>,
  ));
  try {
    assert.deepEqual(loadCalls, ["identity-a"]);

    await act(async () => {
      view.rerender(
        <MemoryRouter>
          <ChatPanel channel={sameIdentity} readOnly />
        </MemoryRouter>,
      );
    });
    assert.deepEqual(loadCalls, ["identity-a"], "same id with new metadata must not reload the message tail");

    await act(async () => {
      useChannelStore.setState({ channels: [sameIdentity, second] });
      useMessageStore.setState((state) => ({
        channelMessages: { ...state.channelMessages, [second.id]: [] },
        channelWindowMeta: {
          ...state.channelWindowMeta,
          [second.id]: {
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
        currentChannelId: second.id,
      }));
      view.rerender(
        <MemoryRouter>
          <ChatPanel channel={second} readOnly />
        </MemoryRouter>,
      );
    });
    assert.deepEqual(loadCalls, ["identity-a", "identity-b"]);
  } finally {
    await act(async () => view.unmount());
  }
});

test("ChatPanel distinguishes first-load loading from a loaded empty channel", async () => {
  const target = channel();

  setChatPanelState(target, [], { loading: true });
  await act(async () => {
    render(
      <MemoryRouter>
        <ChatPanel channel={target} readOnly />
      </MemoryRouter>,
    );
  });

  assert.ok(screen.getByText("Loading…"));
  assert.equal(screen.queryByText("No messages yet"), null);

  cleanup();
  setChatPanelState(target, [], { loading: false });
  await act(async () => {
    render(
      <MemoryRouter>
        <ChatPanel channel={target} readOnly />
      </MemoryRouter>,
    );
  });

  assert.equal(screen.queryByText("Loading…"), null);
  assert.ok(screen.getByText("No messages yet"));
});

test("ChatPanel does not start a second thread-summary request after channel rows publish", async () => {
  const target = channel();
  const calls: Array<{ channelId: string; parentMessageIds?: string[] }> = [];
  setChatPanelState(target, [
    { ...message(target.id, 1), threadId: "thread-1" },
    message(target.id, 2),
    { ...message(target.id, 3), threadId: "thread-3" },
  ], { loading: false });
  useThreadStore.setState({
    loadSummaries: async (channelId, parentMessageIds) => {
      calls.push({ channelId, parentMessageIds });
    },
  });

  await act(async () => {
    render(
      <MemoryRouter>
        <ChatPanel channel={target} readOnly />
      </MemoryRouter>,
    );
  });

  assert.deepEqual(calls, []);
});
