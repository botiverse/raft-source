import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/domSetup";

const localStorageValues = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => void localStorageValues.set(key, value),
  removeItem: (key: string) => void localStorageValues.delete(key),
  clear: () => localStorageValues.clear(),
  key: () => null,
  length: 0,
} as Storage;
const currentLocalStorage =
  (globalThis as unknown as { localStorage?: Partial<Storage> }).localStorage;
if (typeof currentLocalStorage?.getItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageStub,
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    }
  }
  throw lastError;
}

function makeMainLayoutSocket() {
  type Handler = (...args: unknown[]) => void;
  const handlers = new Map<string, Set<Handler>>();
  const anyHandlers = new Set<Handler>();
  const socket = {
    connected: true,
    emit: () => undefined,
    on: (event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? new Set<Handler>();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
    onAny: (handler: Handler) => void anyHandlers.add(handler),
    offAny: (handler: Handler) => void anyHandlers.delete(handler),
    disconnect: () => undefined,
    connect: () => undefined,
  };
  return {
    socket,
    fire(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
      for (const handler of anyHandlers) handler(event, payload);
    },
  };
}

test("global layout installs the channel-domain membership binding and removes that exact handler", async (t) => {
  const { buildMainLayoutSocketBindings, installSocketBridge } = await import("../src/store/socketBridge.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const { socket, fire } = makeMainLayoutSocket();
  let loads = 0;
  t.mock.method(useChannelStore.getState(), "loadChannels", async () => {
    loads += 1;
  });

  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  assert.ok(bindings.some((binding) => binding.event === "channel:members-updated"));

  const uninstall = installSocketBridge(socket, "channel-realtime-test", bindings);
  fire("channel:members-updated", {});
  await waitFor(() => assert.equal(loads, 1));

  uninstall();
  fire("channel:members-updated", {});
  assert.equal(loads, 1, "cleanup removes only the installed channel membership handler");
});

test("global layout applies server plan payloads and refreshes request-shaped billing", async (t) => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
  const { useServerStore } = await import("../src/store/serverStore.js");
  const { socket } = makeMainLayoutSocket();
  const store = useServerStore.getState();
  const patches: Array<{ id: string; plan?: string }> = [];
  let serverLoads = 0;
  let billingLoads = 0;
  let usageLoads = 0;
  t.mock.method(store, "applyServerPatch", (patch) => void patches.push(patch));
  t.mock.method(store, "loadServers", async () => { serverLoads += 1; });
  t.mock.method(store, "loadBilling", async () => { billingLoads += 1; });
  t.mock.method(store, "loadUsage", async () => { usageLoads += 1; });

  const binding = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "server:plan-updated");
  assert.ok(binding);

  binding.handler({ serverId: "server-1", plan: "pro" });
  assert.deepEqual(patches, [{ id: "server-1", plan: "pro" }]);
  assert.equal(serverLoads, 0);
  assert.equal(billingLoads, 1);
  assert.equal(usageLoads, 1);

  binding.handler({});
  assert.equal(serverLoads, 1, "missing plan facts trigger an authoritative server reload");
  assert.equal(billingLoads, 2);
  assert.equal(usageLoads, 2);
});

test("installed recovery persists lastSeq on pagehide but not beforeunload", async () => {
  const { installMainLayoutSocketBridge } = await import("../src/store/socketBridge.js");
  const { useMessageStore } = await import("../src/store/messageStore.js");
  const { socket } = makeMainLayoutSocket();
  const previousLastSeq = useMessageStore.getState().lastSeq;
  useMessageStore.setState({ lastSeq: 47 });
  sessionStorage.removeItem("slock_lastSeq");

  const cleanup = installMainLayoutSocketBridge({
    getSocket: () => socket,
    reconnectSocket: () => undefined,
    ensureSocketConnected: () => undefined,
    isSocketConnected: () => true,
  });
  try {
    window.dispatchEvent(new window.Event("beforeunload"));
    assert.equal(sessionStorage.getItem("slock_lastSeq"), null);

    window.dispatchEvent(new window.Event("pagehide"));
    assert.equal(sessionStorage.getItem("slock_lastSeq"), "47");
  } finally {
    cleanup();
    useMessageStore.setState({ lastSeq: previousLastSeq });
    sessionStorage.removeItem("slock_lastSeq");
  }
});

test("new channels join their realtime socket room through the lazy socket import", async (t) => {
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const api = (await import("../src/api/client.js")).default;
  const { getSocket } = await import("../src/api/socket.js");
  const socket = getSocket();
  const emitted: Array<{ event: string; channelId: string }> = [];

  t.mock.method(api, "post", async (url: string) => {
    assert.equal(url, "/channels");
    return {
      data: {
        id: "created-channel",
        name: "created",
        description: null,
        type: "channel",
        createdAt: "2026-07-07T00:00:00.000Z",
        joined: true,
        lastMessageAt: null,
      },
    };
  });
  t.mock.method(socket, "emit", (event: string, channelId: string) => {
    emitted.push({ event, channelId });
    return socket;
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });

  await useChannelStore.getState().createChannel("created");

  await waitFor(() => {
    assert.deepEqual(emitted, [
      { event: "join:channel", channelId: "created-channel" },
    ]);
  });
});

test("channel realtime binding applies channel:updated payloads through the channel store patch API", async () => {
  const { createChannelRealtimeBindings } = await import("../src/store/channelRealtimeSync.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  let inboxRefreshes = 0;
  useChannelStore.setState({
    channels: [{
      id: "c1",
      name: "old",
      description: null,
      type: "channel",
      createdAt: "2026-07-07T00:00:00.000Z",
      joined: true,
    }],
    dmChannels: [],
    channelActivity: { c1: "old-activity" },
    channelLocalMembership: {},
    loading: false,
  });

  const binding = createChannelRealtimeBindings(
    { emit: () => undefined },
    () => { inboxRefreshes += 1; },
  ).find((candidate) => candidate.event === "channel:updated");
  assert.ok(binding);

  binding.handler({
    channel: {
      id: "c1",
      name: "new",
      description: "patched",
      type: "private",
      createdAt: "2026-07-07T00:00:00.000Z",
      joined: true,
      lastMessageAt: "new-activity",
    },
  });

  const state = useChannelStore.getState();
  assert.equal(state.channels[0]?.name, "new");
  assert.equal(state.channels[0]?.description, "patched");
  assert.equal(state.channels[0]?.type, "private");
  assert.equal(state.channelActivity.c1, "new-activity");
  assert.equal(inboxRefreshes, 0);
});

test("message channel activity suppresses muted channel traffic but promotes followed-thread traffic independently", async () => {
  const { applyMessageChannelActivity } = await import("../src/store/channelRealtimeSync.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const { useMessageStore } = await import("../src/store/messageStore.js");
  let inboxRefreshes = 0;
  useMessageStore.getState().setCurrentUserId("user-current");
  useChannelStore.setState({
    channels: [
      {
        id: "c-muted",
        name: "muted",
        description: null,
        type: "channel",
        createdAt: "2026-07-07T00:00:00.000Z",
        activityMuted: true,
        muteFromSeq: 10,
      },
      {
        id: "thread-muted",
        name: "thread",
        description: null,
        type: "thread",
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });

  applyMessageChannelActivity({
    id: "m-muted-channel",
    seq: 10,
    channelId: "c-muted",
    senderType: "user",
    senderId: "user-other",
    content: "ordinary",
    createdAt: "2026-07-07T00:01:00.000Z",
  }, () => { inboxRefreshes += 1; });
  applyMessageChannelActivity({
    id: "m-muted-thread",
    seq: 11,
    channelId: "thread-muted",
    conversationContext: {
      channelType: "thread",
      parentChannelId: "c-muted",
      parentChannelType: "channel",
      parentMessageId: "parent-1",
    },
    senderType: "user",
    senderId: "user-other",
    content: "ordinary thread reply",
    createdAt: "2026-07-07T00:02:00.000Z",
  }, () => { inboxRefreshes += 1; });

  assert.deepEqual(useChannelStore.getState().channelActivity, {
    "thread-muted": "2026-07-07T00:02:00.000Z",
  });
  assert.equal(inboxRefreshes, 1);
});

test("message channel activity lets direct mentions pierce activity mute", async () => {
  const { applyMessageChannelActivity } = await import("../src/store/channelRealtimeSync.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const { useMessageStore } = await import("../src/store/messageStore.js");
  let inboxRefreshes = 0;
  useMessageStore.getState().setCurrentUserId("user-current");
  useChannelStore.setState({
    channels: [{
      id: "c-muted",
      name: "muted",
      description: null,
      type: "channel",
      createdAt: "2026-07-07T00:00:00.000Z",
      activityMuted: true,
      muteFromSeq: 10,
    }],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });

  applyMessageChannelActivity({
    id: "m-mention",
    seq: 10,
    channelId: "c-muted",
    senderType: "user",
    senderId: "user-other",
    content: "@current",
    mentions: [{
      type: "user",
      id: "user-current",
      name: "current",
    }],
    createdAt: "2026-07-07T00:03:00.000Z",
  }, () => { inboxRefreshes += 1; });

  assert.equal(useChannelStore.getState().channelActivity["c-muted"], "2026-07-07T00:03:00.000Z");
  assert.equal(inboxRefreshes, 1);
});

test("thread updated socket event promotes followed-thread activity independently from parent mute", async () => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const { useInboxStore } = await import("../src/store/inboxStore.js");
  const { useMessageStore } = await import("../src/store/messageStore.js");
  const { useThreadStore } = await import("../src/store/threadStore.js");
  let inboxRefreshes = 0;
  useMessageStore.getState().setCurrentUserId("user-current");
  useChannelStore.setState({
    channels: [{
      id: "c-muted",
      name: "muted",
      description: null,
      type: "channel",
      createdAt: "2026-07-07T00:00:00.000Z",
      activityMuted: true,
      muteFromSeq: 10,
    }],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });
  useThreadStore.setState({
    openThreadChannelId: null,
    summaries: {},
    followedThreads: [{
      threadChannelId: "thread-muted",
      parentMessageId: "parent-1",
      parentChannelId: "c-muted",
      parentChannelName: "muted",
      parentChannelType: "channel",
      parentMessagePreview: "parent",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-other",
      replyCount: 1,
      lastReplyAt: "2026-07-07T00:00:00.000Z",
      unreadCount: 0,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    }],
  });
  useInboxStore.setState({
    items: [{
      kind: "thread",
      threadChannelId: "thread-muted",
      parentMessageId: "parent-1",
      parentChannelId: "c-muted",
      parentChannelName: "muted",
      parentChannelType: "channel",
      parentMessagePreview: "parent",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-other",
      latestActivityPreview: "parent",
      latestActivitySenderType: "user",
      latestActivitySenderId: "user-other",
      latestActivityMessageId: "parent-1",
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      replyCount: 1,
      lastActivityAt: "2026-07-07T00:00:00.000Z",
      lastReplyAt: "2026-07-07T00:00:00.000Z",
      unreadCount: 0,
      hasMention: false,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    }],
  });

  const binding = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit: () => undefined,
      on: () => undefined,
      off: () => undefined,
      onAny: () => undefined,
      offAny: () => undefined,
      disconnect: () => undefined,
      connect: () => undefined,
    },
    () => { inboxRefreshes += 1; },
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "thread:updated");
  assert.ok(binding);

  binding.handler({
    parentMessageId: "parent-1",
    threadChannelId: "thread-muted",
    replyCount: 2,
    lastReplyAt: "2026-07-07T00:05:00.000Z",
    participantIds: ["user-other"],
    latestReply: {
      id: "reply-muted",
      seq: 11,
      channelId: "thread-muted",
      conversationContext: {
        channelType: "thread",
        parentChannelId: "c-muted",
        parentChannelType: "channel",
        parentMessageId: "parent-1",
      },
      senderType: "user",
      senderId: "user-other",
      content: "ordinary muted thread reply",
      createdAt: "2026-07-07T00:05:00.000Z",
    },
  });

  const inboxThread = useInboxStore.getState().items.find((item) => item.kind === "thread");
  assert.equal(inboxThread?.latestActivityMessageId, "reply-muted");
  assert.equal(inboxThread?.replyCount, 2);
  assert.equal(inboxRefreshes, 1);
});

test("message:new socket event promotes followed-thread activity independently from parent mute", async () => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const { useInboxStore } = await import("../src/store/inboxStore.js");
  const { useMessageStore } = await import("../src/store/messageStore.js");
  let inboxRefreshes = 0;
  useMessageStore.getState().setCurrentUserId("user-current");
  useChannelStore.setState({
    channels: [{
      id: "c-muted",
      name: "muted",
      description: null,
      type: "channel",
      createdAt: "2026-07-07T00:00:00.000Z",
      activityMuted: true,
      muteFromSeq: 10,
    }],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });
  useInboxStore.setState({
    items: [{
      kind: "thread",
      threadChannelId: "thread-muted",
      parentMessageId: "parent-1",
      parentChannelId: "c-muted",
      parentChannelName: "muted",
      parentChannelType: "channel",
      parentMessagePreview: "parent",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-other",
      latestActivityPreview: "parent",
      latestActivitySenderType: "user",
      latestActivitySenderId: "user-other",
      latestActivityMessageId: "parent-1",
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      replyCount: 1,
      lastActivityAt: "2026-07-07T00:00:00.000Z",
      lastReplyAt: "2026-07-07T00:00:00.000Z",
      unreadCount: 0,
      hasMention: false,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    }],
  });

  const binding = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit: () => undefined,
      on: () => undefined,
      off: () => undefined,
      onAny: () => undefined,
      offAny: () => undefined,
      disconnect: () => undefined,
      connect: () => undefined,
    },
    () => { inboxRefreshes += 1; },
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "message:new");
  assert.ok(binding);

  binding.handler({
    id: "reply-boundary",
    seq: 10,
    channelId: "thread-muted",
    conversationContext: {
      channelType: "thread",
      parentChannelId: "c-muted",
      parentChannelType: "channel",
      parentMessageId: "parent-1",
    },
    senderType: "user",
    senderId: "user-other",
    content: "ordinary muted thread reply",
    createdAt: "2026-07-07T00:05:00.000Z",
  });

  const inboxThread = useInboxStore.getState().items.find((item) => item.kind === "thread");
  assert.equal(inboxThread?.latestActivityMessageId, "reply-boundary");
  assert.equal(inboxThread?.replyCount, 2);
  assert.deepEqual(useChannelStore.getState().channelActivity, {
    "thread-muted": "2026-07-07T00:05:00.000Z",
  });
  assert.equal(inboxRefreshes, 1);
  assert.equal(useMessageStore.getState().channelMessages["thread-muted"]?.[0]?.id, "reply-boundary");
});

test("channel realtime binding refreshes existing DMs without socketBridge store logic", async () => {
  const { createChannelRealtimeBindings } = await import("../src/store/channelRealtimeSync.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const emitted: Array<{ event: string; channelId: string }> = [];
  let inboxRefreshes = 0;
  useChannelStore.setState({
    channels: [],
    dmChannels: [
      {
        id: "dm-old",
        name: "old",
        description: null,
        type: "dm",
        createdAt: "2026-07-07T00:00:00.000Z",
      },
      {
        id: "dm-new",
        name: "new",
        description: null,
        type: "dm",
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ],
    channelActivity: {},
    loading: false,
  });

  const binding = createChannelRealtimeBindings(
    {
      emit: (event, channelId) => {
        emitted.push({ event, channelId: String(channelId) });
      },
    },
    () => { inboxRefreshes += 1; },
  ).find((candidate) => candidate.event === "dm:new");
  assert.ok(binding);

  binding.handler({ channelId: "dm-new" });

  assert.deepEqual(emitted, [{ event: "join:channel", channelId: "dm-new" }]);
  assert.deepEqual(useChannelStore.getState().dmChannels.map((channel) => channel.id), ["dm-new", "dm-old"]);
  assert.equal(typeof useChannelStore.getState().channelActivity["dm-new"], "string");
  assert.equal(inboxRefreshes, 1);
});

test("main socket bridge applies channel notification_prefs:updated to activity mute state", async () => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");

  useChannelStore.setState({
    channels: [{
      id: "channel-prefs",
      name: "prefs",
      description: null,
      type: "channel",
      createdAt: "2026-07-10T00:00:00.000Z",
      joined: true,
      activityMuteSupported: true,
      activityMuted: false,
      muteFromSeq: null,
      prefsVersion: 0,
    }],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });

  const binding = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit: () => undefined,
      on: () => undefined,
      off: () => undefined,
      onAny: () => undefined,
      offAny: () => undefined,
      disconnect: () => undefined,
      connect: () => undefined,
    },
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "notification_prefs:updated");
  assert.ok(binding);

  binding.handler({
    serverId: "server-prefs",
    scopeId: "channel-prefs",
    prefs: { activityMuted: true, muteFromSeq: 42 },
    prefsVersion: 1,
  });

  const channel = useChannelStore.getState().channels.find((item) => item.id === "channel-prefs");
  assert.equal(channel?.activityMuted, true);
  assert.equal(channel?.muteFromSeq, 42);
  assert.equal(channel?.activityMuteSupported, true);
  assert.equal(channel?.prefsVersion, 1);

  binding.handler({
    serverId: "server-prefs",
    scopeId: "channel-prefs",
    prefs: { activityMuted: false, muteFromSeq: null },
    prefsVersion: 2,
  });

  const unmutedChannel = useChannelStore.getState().channels.find((item) => item.id === "channel-prefs");
  assert.equal(unmutedChannel?.activityMuted, false);
  assert.equal(unmutedChannel?.muteFromSeq, null);
  assert.equal(unmutedChannel?.prefsVersion, 2);

  binding.handler({
    serverId: "server-prefs",
    scopeId: "channel-prefs",
    prefs: { activityMuted: true, muteFromSeq: 42 },
    prefsVersion: 1,
  });

  const afterStaleMute = useChannelStore.getState().channels.find((item) => item.id === "channel-prefs");
  assert.equal(afterStaleMute?.activityMuted, false);
  assert.equal(afterStaleMute?.muteFromSeq, null);
  assert.equal(afterStaleMute?.prefsVersion, 2);
});

test("main socket bridge applies message_display_prefs:updated and drops stale prefsVersion", async () => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");

  useChannelStore.setState({
    channels: [{
      id: "channel-display",
      name: "display",
      description: null,
      type: "channel",
      createdAt: "2026-07-10T00:00:00.000Z",
      joined: true,
      collapseLongMessages: true,
      displayPrefsVersion: 0,
    }],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });

  const binding = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit: () => undefined,
      on: () => undefined,
      off: () => undefined,
      onAny: () => undefined,
      offAny: () => undefined,
      disconnect: () => undefined,
      connect: () => undefined,
    },
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "message_display_prefs:updated");
  assert.ok(binding);

  binding.handler({
    serverId: "server-display",
    scopeId: "channel-display",
    prefs: { collapseLongMessages: false },
    prefsVersion: 1,
  });

  const disabledChannel = useChannelStore.getState().channels.find((item) => item.id === "channel-display");
  assert.equal(disabledChannel?.collapseLongMessages, false);
  assert.equal(disabledChannel?.displayPrefsVersion, 1);

  binding.handler({
    serverId: "server-display",
    scopeId: "channel-display",
    prefs: { collapseLongMessages: true },
    prefsVersion: 2,
  });

  const reenabledChannel = useChannelStore.getState().channels.find((item) => item.id === "channel-display");
  assert.equal(reenabledChannel?.collapseLongMessages, true);
  assert.equal(reenabledChannel?.displayPrefsVersion, 2);

  binding.handler({
    serverId: "server-display",
    scopeId: "channel-display",
    prefs: { collapseLongMessages: false },
    prefsVersion: 1,
  });

  const afterStalePatch = useChannelStore.getState().channels.find((item) => item.id === "channel-display");
  assert.equal(afterStalePatch?.collapseLongMessages, true);
  assert.equal(afterStalePatch?.displayPrefsVersion, 2);
});

test("main socket bridge gates channel notification_prefs:updated through sync-core when enabled", async (t) => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const { useServerStore } = await import("../src/store/serverStore.js");
  const api = (await import("../src/api/client.js")).default;
  const {
    REGISTERED_SERVER_FEATURE_FLAG_KEYS,
  } = await import("../src/store/serverFeatureFlags.js");
  const {
    SYNC_CORE_NOTIFICATION_PREFS_FLAG_KEY,
  } = await import("../src/store/serverFeatureFlags.js");
  const {
    refreshSyncCoreNotificationPrefsFlagForCurrentServer,
    resetSyncCoreNotificationPrefsFlagForTests,
  } = await import("../src/store/notificationPrefsSyncFeatureFlag.js");
  const { resetNotificationPrefsSyncCoreForTests } = await import("../src/store/notificationPrefsSyncDomain.js");

  t.after(() => {
    resetSyncCoreNotificationPrefsFlagForTests();
    resetNotificationPrefsSyncCoreForTests();
  });

  useServerStore.setState({
    current: {
      id: "server-prefs",
      name: "Prefs",
      avatarUrl: null,
      slug: "prefs",
      ownerId: "owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  });
  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    assert.equal(url, "/feature-flags/evaluate");
    assert.deepEqual(body, {
      serverId: "server-prefs",
      platform: "web",
      keys: REGISTERED_SERVER_FEATURE_FLAG_KEYS,
    });
    return {
      data: {
        evaluations: REGISTERED_SERVER_FEATURE_FLAG_KEYS.map((key) => ({
          key,
          enabled: key === SYNC_CORE_NOTIFICATION_PREFS_FLAG_KEY,
        })),
      },
    };
  });
  assert.equal(await refreshSyncCoreNotificationPrefsFlagForCurrentServer(), true);

  useChannelStore.setState({
    channels: [{
      id: "channel-prefs",
      name: "prefs",
      description: null,
      type: "channel",
      createdAt: "2026-07-10T00:00:00.000Z",
      joined: true,
      activityMuteSupported: true,
      activityMuted: false,
      muteFromSeq: null,
      prefsVersion: 0,
    }],
    dmChannels: [],
    channelActivity: {},
    channelLocalMembership: {},
    loading: false,
  });

  const binding = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit: () => undefined,
      on: () => undefined,
      off: () => undefined,
      onAny: () => undefined,
      offAny: () => undefined,
      disconnect: () => undefined,
      connect: () => undefined,
    },
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "notification_prefs:updated");
  assert.ok(binding);

  binding.handler({
    serverId: "server-prefs",
    scopeId: "channel-prefs",
    prefs: { activityMuted: true, muteFromSeq: 42 },
    prefsVersion: 3,
  });

  const mutedChannel = useChannelStore.getState().channels.find((item) => item.id === "channel-prefs");
  assert.equal(mutedChannel?.activityMuted, true);
  assert.equal(mutedChannel?.muteFromSeq, 42);
  assert.equal(mutedChannel?.prefsVersion, 3);

  binding.handler({
    serverId: "server-prefs",
    scopeId: "channel-prefs",
    prefs: { activityMuted: false, muteFromSeq: null },
    prefsVersion: 3,
  });

  const afterDuplicate = useChannelStore.getState().channels.find((item) => item.id === "channel-prefs");
  assert.equal(afterDuplicate?.activityMuted, true);
  assert.equal(afterDuplicate?.muteFromSeq, 42);
  assert.equal(afterDuplicate?.prefsVersion, 3);
});

test("main socket bridge applies server notification_prefs:updated and emits UI refresh signal", async (t) => {
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge.js");
  const { useServerStore } = await import("../src/store/serverStore.js");
  const { useMessageStore } = await import("../src/store/messageStore.js");
  const {
    SERVER_NOTIFICATION_PREFS_UPDATED_EVENT,
  } = await import("../src/store/events/notificationPrefsEvents.js");
  const events: Array<{ serverId: string; serverPushMuted: boolean; prefsVersion?: number }> = [];

  useServerStore.setState({
    servers: [{
      id: "server-prefs",
      name: "Prefs",
      avatarUrl: null,
      slug: "prefs",
      ownerId: "owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      serverPushMuted: false,
      notificationPrefsVersion: 0,
      createdAt: "2026-07-10T00:00:00.000Z",
    }],
    current: null,
  });
  const loadUnreadCountsMock = t.mock.method(useMessageStore.getState(), "loadUnreadCounts", async () => undefined);
  const handlePrefsEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ serverId: string; serverPushMuted: boolean; prefsVersion?: number }>).detail;
    events.push(detail);
  };
  window.addEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handlePrefsEvent);
  t.after(() => {
    window.removeEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handlePrefsEvent);
  });

  const binding = buildMainLayoutSocketBindings(
    {
      connected: true,
      emit: () => undefined,
      on: () => undefined,
      off: () => undefined,
      onAny: () => undefined,
      offAny: () => undefined,
      disconnect: () => undefined,
      connect: () => undefined,
    },
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  ).find((candidate) => candidate.event === "notification_prefs:updated");
  assert.ok(binding);

  binding.handler({
    serverId: "server-prefs",
    scopeId: "server-prefs",
    prefs: { serverPushMuted: true },
    prefsVersion: 1,
  });

  assert.equal(useServerStore.getState().servers[0]?.serverPushMuted, true);
  assert.equal(useServerStore.getState().servers[0]?.notificationPrefsVersion, 1);
  assert.deepEqual(events, [{ serverId: "server-prefs", serverPushMuted: true, prefsVersion: 1 }]);
  assert.equal(loadUnreadCountsMock.mock.calls.length, 1);

  binding.handler({
    serverId: "server-prefs",
    scopeId: "server-prefs",
    prefs: { serverPushMuted: false },
    prefsVersion: 0,
  });

  assert.equal(useServerStore.getState().servers[0]?.serverPushMuted, true);
  assert.equal(useServerStore.getState().servers[0]?.notificationPrefsVersion, 1);
  assert.equal(events.length, 1);
  assert.equal(loadUnreadCountsMock.mock.calls.length, 1);
});

test("lazy socket room join failures are logged with context", async (t) => {
  const { useChannelStore } = await import("../src/store/channelStore.js");
  const api = (await import("../src/api/client.js")).default;
  const { getSocket } = await import("../src/api/socket.js");
  const socket = getSocket();
  const logged: Array<{ message: string; error: unknown }> = [];
  const failure = new Error("socket emit failed");

  t.mock.method(api, "post", async (url: string) => {
    assert.equal(url, "/channels");
    return {
      data: {
        id: "logging-channel",
        name: "logging",
        description: null,
        type: "channel",
        createdAt: "2026-07-07T00:00:00.000Z",
        joined: true,
        lastMessageAt: null,
      },
    };
  });
  t.mock.method(socket, "emit", () => {
    throw failure;
  });
  t.mock.method(console, "error", (message: string, error: unknown) => {
    logged.push({ message, error });
  });
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
    loading: false,
  });

  await useChannelStore.getState().createChannel("logging");

  await waitFor(() => {
    assert.deepEqual(logged, [
      {
        message: "Failed to join socket channel:",
        error: failure,
      },
    ]);
  });
});
