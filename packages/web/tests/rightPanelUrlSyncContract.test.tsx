import assert from "node:assert/strict";

const {
  beginRightPanelSearchTransition,
  hasRightPanelThreadAnchorChanged,
  isCurrentRightPanelSearchSnapshot,
  openThreadParentMessageRoute,
  subscribeRightPanelThreadAnchor,
  syncRightPanelStoresFromSearch,
  syncRightPanelUrlFromStores,
  transitionThreadToParentMessage,
} = await import("../src/components/layout/rightPanelUrlSync");
const { useProfileStore } = await import("../src/store/profileStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { default: api } = await import("../src/api/client");
const { useServerStore } = await import("../src/store/serverStore");
const { useThreadStore } = await import("../src/store/threadStore");
const { useLegacyTaskPanelStore } = await import("../src/store/legacyTaskPanelStore");
const { useTaskStore } = await import("../src/store/taskStore");

const originalThreadState = useThreadStore.getState();
const originalProfileState = useProfileStore.getState();
const originalMessageState = useMessageStore.getState();
const originalApiGet = api.get;
const originalServerState = useServerStore.getState();
const originalTaskState = useTaskStore.getState();
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function resetStores(): void {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openIntent: null,
    openParentChannelId: null,
    openThreadError: null,
    focusedMessageId: null,
    taskModal: null,
    openThread: originalThreadState.openThread,
    closeThread: originalThreadState.closeThread,
    openTaskModal: originalThreadState.openTaskModal,
    closeTaskModal: originalThreadState.closeTaskModal,
  });
  useLegacyTaskPanelStore.setState({ task: null });
  useTaskStore.setState({
    tasksByChannelId: {},
    loadingByChannelId: {},
    loadedByChannelId: {},
    loadTasks: originalTaskState.loadTasks,
  });
  useProfileStore.setState({
    profileType: null,
    profileId: null,
    externalProfile: null,
    externalProfileChannelId: null,
    defaultAgentTabIntent: null,
    openProfile: originalProfileState.openProfile,
    openExternalProfile: originalProfileState.openExternalProfile,
    clearDefaultAgentTabIntent: originalProfileState.clearDefaultAgentTabIntent,
    closeProfile: originalProfileState.closeProfile,
  });
  useMessageStore.setState({
    channelMessages: {},
    messages: [],
    currentChannelId: null,
    loadMessageContext: originalMessageState.loadMessageContext,
  });
  useServerStore.setState({
    sidebarOrder: originalServerState.sidebarOrder,
  });
}

function installWindowLocation(pathname: string, search: string): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname, search } },
  });
}

function installWindowHistoryEntry(
  pathname: string,
  search: string,
  state: { idx: number; key: string },
): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      history: { state },
      location: { pathname, search },
    },
  });
}

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
}

test.afterEach(() => {
  resetStores();
  api.get = originalApiGet;
  restoreWindow();
});

const externalAuthor = {
  projectionId: "projection-1",
  provider: "slack",
  appRegistrationId: "app-1",
  installId: "install-1",
  workspaceId: "opaque-workspace-id",
  workspaceName: "Analytical Engines",
  externalActorId: "actor-1",
  externalConversationId: "conversation-1",
  externalMessageId: "external-message-1",
  displayName: "Ada Lovelace",
  actorKind: "human" as const,
  avatarUrl: null,
  avatarDigest: null,
  actorProjectionRevision: 3,
};

const externalMessage = {
  id: "message-1",
  channelId: "channel-1",
  senderType: "external_projection" as const,
  senderId: "projection-1",
  externalAuthor,
  content: "hello",
  createdAt: "2026-09-24T00:00:00.000Z",
};

test("right-panel URL sync removes closed panel params from the live browser URL", () => {
  resetStores();
  installWindowLocation("/s/acme/inbox", "?thread=channel-1:parent-1&keep=1");

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const fallback = {
    pathname: "/s/acme/channel/stale",
    search: "?thread=stale-channel:stale-message&keep=stale",
  };
  let syncedFallback: { pathname: string; search: string } | null = null;

  const changed = syncRightPanelUrlFromStores({
    mode: "replace",
    fallback,
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
    updateFallback: (next) => {
      syncedFallback = next;
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(navigations, [
    {
      to: { pathname: "/s/acme/inbox", search: "?keep=1" },
      options: { replace: true },
    },
  ]);
  assert.deepEqual(syncedFallback, { pathname: "/s/acme/inbox", search: "?keep=1" });
});

test("right-panel closeThread writes the cleaned Activity URL back to location", () => {
  resetStores();
  installWindowLocation("/s/acme/inbox", "?filter=mentions&thread=channel-1:parent-1");
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const fallback = {
    pathname: "/s/acme/channel/stale",
    search: "?thread=stale-channel:stale-message&filter=stale",
  };
  let syncedFallback: { pathname: string; search: string } | null = null;
  const unsubscribe = useThreadStore.subscribe(() => {
    syncRightPanelUrlFromStores({
      fallback,
      navigate: (to, options) => {
        navigations.push({ to, options });
      },
      updateFallback: (next) => {
        syncedFallback = next;
      },
    });
  });

  try {
    useThreadStore.getState().closeThread();
  } finally {
    unsubscribe();
  }

  assert.deepEqual(navigations, [
    {
      to: { pathname: "/s/acme/inbox", search: "?filter=mentions" },
      options: { replace: true },
    },
  ]);
  assert.deepEqual(syncedFallback, { pathname: "/s/acme/inbox", search: "?filter=mentions" });
});

test("right-panel profile open clears stale agentTab so agent overlay uses order-zero default", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?profile=agent:old-agent&agentTab=profile&keep=1",
  );
  useProfileStore.setState({
    profileType: "agent",
    profileId: "new-agent",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/channel-1", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(navigations, [
    {
      to: {
        pathname: "/s/acme/channel/channel-1",
        search: "?keep=1&profile=agent%3Anew-agent",
      },
      options: { replace: true },
    },
  ]);
});

test("external identity Back closes and Forward restores the frozen author from message state", async () => {
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "");
  useMessageStore.setState({
    channelMessages: { "channel-1": [externalMessage] },
  });
  useProfileStore.getState().openExternalProfile("message-1", externalAuthor, {
    channelId: "channel-1",
    openSource: "channel",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/channel-1", search: "" },
    navigate: (to, options) => navigations.push({ to, options }),
  });
  assert.deepEqual(navigations, [{
    to: {
      pathname: "/s/acme/channel/channel-1",
      search: "?profile=external%3Achannel-1%3Amessage-1",
    },
    options: { replace: false },
  }]);

  installWindowLocation("/s/acme/channel/channel-1", "");
  syncRightPanelStoresFromSearch("");
  assert.equal(useProfileStore.getState().profileType, null, "Back closes the panel");

  const forwardSearch = "?profile=external%3Achannel-1%3Amessage-1";
  installWindowLocation("/s/acme/channel/channel-1", forwardSearch);
  syncRightPanelStoresFromSearch(forwardSearch);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(useProfileStore.getState().profileType, "external");
  assert.equal(useProfileStore.getState().profileId, "message-1");
  assert.equal(useProfileStore.getState().externalProfileChannelId, "channel-1");
  assert.equal(useProfileStore.getState().externalProfile, externalAuthor);
});

test("cold external identity URL fetches the message context before opening the panel", async () => {
  resetStores();
  const search = "?profile=external%3Achannel-1%3Amessage-1";
  installWindowLocation("/s/acme/channel/channel-1", search);
  const requests: Array<{ url: string; channelId: unknown }> = [];
  api.get = (async (url: string, config?: { params?: { channelId?: unknown } }) => {
    requests.push({ url, channelId: config?.params?.channelId });
    return {
      data: {
        messages: [externalMessage],
        targetMessageId: "message-1",
      },
    };
  }) as typeof api.get;

  syncRightPanelStoresFromSearch(search);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(requests, [{
    url: "/messages/context/message-1",
    channelId: "channel-1",
  }]);
  assert.equal(useProfileStore.getState().profileType, "external");
  assert.equal(useProfileStore.getState().externalProfile, externalAuthor);
});

test("stale external identity fetch cannot reopen after Browser Back", async () => {
  resetStores();
  const search = "?profile=external%3Achannel-1%3Amessage-1";
  installWindowLocation("/s/acme/channel/channel-1", search);
  let resolveRequest!: (value: unknown) => void;
  api.get = (() => new Promise((resolve) => {
    resolveRequest = resolve;
  })) as typeof api.get;

  syncRightPanelStoresFromSearch(search);
  installWindowLocation("/s/acme/channel/channel-1", "");
  syncRightPanelStoresFromSearch("");
  resolveRequest({ data: { messages: [externalMessage], targetMessageId: "message-1" } });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(useProfileStore.getState().profileType, null);
  assert.equal(useProfileStore.getState().externalProfile, null);
});

test("right-panel ordered-first profile intent writes explicit agentTab", () => {
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "?keep=1");
  useServerStore.setState({
    sidebarOrder: {
      ...originalServerState.sidebarOrder,
      agentPanelTabOrder: ["activity", "profile", "chat"],
    },
  });
  useProfileStore.setState({
    profileType: "agent",
    profileId: "agent-1",
    defaultAgentTabIntent: "ordered-first",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/channel-1", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(navigations, [
    {
      to: {
        pathname: "/s/acme/channel/channel-1",
        search: "?keep=1&profile=agent%3Aagent-1&agentTab=activity",
      },
      options: { replace: false },
    },
  ]);
});

function makeTaskModalSlot(parentMessageId: string, parentChannelId = "channel-1") {
  return {
    parentMessageId,
    parentChannelId,
    threadChannelId: `${parentMessageId}-thread`,
    serverSlug: "acme",
    focusedMessageId: null,
    loading: false,
    error: null,
  };
}

test("opening a task modal over a side thread pushes task=<anchor> and keeps the side thread in the URL", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?msg=origin-reply&thread=channel-1:origin-parent",
  );
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "origin-parent",
    openThreadChannelId: "origin-thread",
    openIntent: "thread",
    taskModal: makeTaskModalSlot("task-parent"),
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/stale", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(navigations, [
    {
      to: {
        pathname: "/s/acme/channel/channel-1",
        search: "?msg=origin-reply&thread=channel-1%3Aorigin-parent&task=channel-1%3Atask-parent",
      },
      options: { replace: false },
    },
  ]);
});

test("a task modal with no side thread underneath writes its own task=<anchor> deep link", () => {
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "");
  useThreadStore.setState({ taskModal: makeTaskModalSlot("task-parent") });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/stale", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(navigations, [
    {
      to: {
        pathname: "/s/acme/channel/channel-1",
        search: "?task=channel-1%3Atask-parent",
      },
      options: { replace: false },
    },
  ]);
});

test("task=<ch>:<msg> deep link opens the task modal slot without touching the side thread", () => {
  resetStores();
  const opened: Array<[string, string]> = [];
  useThreadStore.setState({
    openTaskModal: async ({ parentChannelId, parentMessageId }) => {
      opened.push([parentChannelId, parentMessageId]);
      useThreadStore.setState({ taskModal: makeTaskModalSlot(parentMessageId, parentChannelId) });
    },
  });

  syncRightPanelStoresFromSearch("?task=channel-1:task-parent");

  assert.deepEqual(opened, [["channel-1", "task-parent"]]);
  assert.equal(useThreadStore.getState().openParentMessageId, null);
  assert.equal(useThreadStore.getState().taskModal?.parentMessageId, "task-parent");
});

test("task=<anchor> matching the open side thread opens the modal slot over it, not a retarget", () => {
  resetStores();
  const taskOpens: string[] = [];
  let threadOpens = 0;
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
    openIntent: "thread",
    openThread: async () => {
      threadOpens += 1;
    },
    openTaskModal: async ({ parentMessageId }) => {
      taskOpens.push(parentMessageId);
      useThreadStore.setState({ taskModal: makeTaskModalSlot(parentMessageId) });
    },
  });

  syncRightPanelStoresFromSearch("?thread=channel-1:parent-1&task=channel-1:parent-1");

  assert.deepEqual(taskOpens, ["parent-1"]);
  assert.equal(threadOpens, 0, "same-anchor thread param must not reopen the side thread");
  assert.equal(useThreadStore.getState().openParentMessageId, "parent-1");
});

test("dropping the task param closes the task modal slot and leaves the side thread open", () => {
  resetStores();
  let closes = 0;
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
    openIntent: "thread",
    taskModal: makeTaskModalSlot("parent-1"),
    closeTaskModal: () => {
      closes += 1;
      useThreadStore.setState({ taskModal: null });
    },
  });

  syncRightPanelStoresFromSearch("?thread=channel-1:parent-1");

  assert.equal(closes, 1);
  assert.equal(useThreadStore.getState().taskModal, null);
  assert.equal(useThreadStore.getState().openParentMessageId, "parent-1");
});

test("legacy task permalink survives the async cold-load before its panel store opens", async () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?chatTab=tasks&legacyTask=channel-1%3Alegacy-7",
  );
  let resolveLoad!: () => void;
  useTaskStore.setState({
    loadTasks: () => new Promise<void>((resolve) => { resolveLoad = resolve; }),
  });

  syncRightPanelStoresFromSearch("?chatTab=tasks&legacyTask=channel-1%3Alegacy-7");
  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/channel-1", search: "" },
    navigate: (to, options) => navigations.push({ to, options }),
  });

  assert.equal(changed, false);
  assert.deepEqual(navigations, []);

  const legacyTask = {
    id: "legacy-7",
    messageId: "legacy-7",
    channelId: "channel-1",
    channelName: "design",
    taskNumber: 7,
    title: "Legacy task",
    description: null,
    status: "todo" as const,
    createdById: "user-1",
    createdByType: "user" as const,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    isLegacy: true,
  };
  useTaskStore.setState({ tasksByChannelId: { "channel-1": [legacyTask] } });
  resolveLoad();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(useLegacyTaskPanelStore.getState().task?.id, "legacy-7");
});

test("ordinary thread retarget keeps replace semantics", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?msg=origin-reply&thread=channel-1:origin-parent",
  );
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "next-parent",
    openThreadChannelId: "next-thread",
    openIntent: "thread",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/stale", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
  });

  assert.equal(navigations[0]?.options.replace, true);
});

test("right-panel explicit same-agent reopen clears agentTab", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?profile=agent:same-agent&agentTab=profile",
  );
  useProfileStore.setState({
    profileType: "agent",
    profileId: "same-agent",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/channel-1", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
    options: { resetAgentTabForProfileReopen: true },
  });

  assert.equal(changed, true);
  assert.deepEqual(navigations, [
    {
      to: {
        pathname: "/s/acme/channel/channel-1",
        search: "?profile=agent%3Asame-agent",
      },
      options: { replace: true },
    },
  ]);
});

test("right-panel same-agent URL sync preserves explicit agentTab", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?profile=agent:same-agent&agentTab=workspace",
  );
  useProfileStore.setState({
    profileType: "agent",
    profileId: "same-agent",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/channel-1", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(navigations, [
    {
      to: {
        pathname: "/s/acme/channel/channel-1",
        search: "?agentTab=workspace&profile=agent%3Asame-agent",
      },
      options: { replace: true },
    },
  ]);
});

test("right-panel URL sync ignores stale search snapshots after a fast close", () => {
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "");

  assert.equal(
    isCurrentRightPanelSearchSnapshot("?thread=channel-1:parent-1"),
    false,
    "stale effect snapshot must not reopen a just-closed thread",
  );
  assert.equal(isCurrentRightPanelSearchSnapshot(""), true);
});

test("route-owned transition rejects the old thread snapshot before BrowserRouter commits", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/activity",
    "?open=channel%3Achannel-1&msg=parent-1&thread=channel-1%3Aparent-1",
  );

  beginRightPanelSearchTransition("?msg=parent-1", "/s/acme/channel/channel-1");

  assert.equal(
    isCurrentRightPanelSearchSnapshot(
      "?open=channel%3Achannel-1&msg=parent-1&thread=channel-1%3Aparent-1",
    ),
    false,
    "the queued origin effect must not regain thread-store ownership",
  );

  installWindowLocation("/s/acme/channel/channel-1", "?msg=parent-1");
  assert.equal(
    isCurrentRightPanelSearchSnapshot("?msg=parent-1"),
    true,
    "the destination effect consumes the route-owned transition",
  );
});

test("a POP to a different history entry invalidates an unconsumed close marker", () => {
  installWindowHistoryEntry(
    "/s/acme/channel/channel-1",
    "?msg=parent-1",
    { idx: 1, key: "closed-thread-entry" },
  );
  beginRightPanelSearchTransition("?msg=parent-1", "/s/acme/channel/channel-1");

  installWindowHistoryEntry(
    "/s/acme/activity",
    "",
    { idx: 0, key: "activity-origin" },
  );
  assert.equal(
    isCurrentRightPanelSearchSnapshot(""),
    true,
    "the origin projection must run instead of carrying the replaced entry's marker forward",
  );
});

test("View in channel reserves URL ownership and completes the thread teardown synchronously", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/activity",
    "?open=channel%3Achannel-1&thread=channel-1%3Aparent-1",
  );
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
  });
  const events: string[] = [];

  transitionThreadToParentMessage({
    pathname: "/s/acme/channel/channel-1",
    parentMessageId: "parent-1",
    navigate: (to, options) => {
      assert.equal(
        isCurrentRightPanelSearchSnapshot(
          "?open=channel%3Achannel-1&thread=channel-1%3Aparent-1",
        ),
        false,
        "origin effect must lose ownership before navigate",
      );
      events.push(`navigate:${to}:${options.replace}`);
    },
  });

  assert.deepEqual(events, [
    "navigate:/s/acme/channel/channel-1?msg=parent-1:true",
  ]);
  assert.equal(
    useThreadStore.getState().openParentMessageId,
    null,
    "route completion must not wait for the destination React effect",
  );

  installWindowLocation("/s/acme/channel/channel-1", "?msg=parent-1");
  assert.equal(isCurrentRightPanelSearchSnapshot("?msg=parent-1"), true);
});

test("desktop View in channel pushes and blocks stale thread snapshots before route commit", () => {
  resetStores();
  installWindowHistoryEntry(
    "/s/acme/channel/channel-1",
    "?thread=channel-1%3Aparent-1",
    { idx: 4, key: "origin-thread" },
  );
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
  });
  const navigations: Array<{ to: string; replace: boolean }> = [];
  const mobileBackRecords: Array<{ type: "PUSH" | "REPLACE"; path: string }> = [];

  openThreadParentMessageRoute({
    isDesktop: true,
    parentRouteKind: "channel",
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    serverSlug: "acme",
    navigate: (to, options) => {
      navigations.push({ to, replace: options.replace });
      installWindowHistoryEntry(
        "/s/acme/channel/channel-1",
        "?msg=parent-1",
        { idx: 5, key: "parent-message" },
      );
    },
    recordMobileBackNavigation: (type, path) => {
      mobileBackRecords.push({ type, path });
    },
  });

  assert.deepEqual(navigations, [
    { to: "/s/acme/channel/channel-1?msg=parent-1", replace: false },
  ]);
  assert.deepEqual(mobileBackRecords, []);
  assert.equal(useThreadStore.getState().openParentMessageId, null);
  assert.equal(
    isCurrentRightPanelSearchSnapshot("?thread=channel-1%3Aparent-1"),
    false,
    "the stale thread snapshot must not regain ownership after the desktop push",
  );
  assert.equal(isCurrentRightPanelSearchSnapshot("?msg=parent-1"), true);
});

test("desktop DM View in channel keeps push semantics and closes the thread", () => {
  resetStores();
  installWindowHistoryEntry(
    "/s/acme/dm/dm-1",
    "?thread=dm-1%3Aparent-1",
    { idx: 7, key: "origin-dm-thread" },
  );
  useThreadStore.setState({
    openParentChannelId: "dm-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
  });
  const navigations: Array<{ to: string; replace: boolean }> = [];
  const mobileBackRecords: Array<{ type: "PUSH" | "REPLACE"; path: string }> = [];

  openThreadParentMessageRoute({
    isDesktop: true,
    parentRouteKind: "dm",
    parentChannelId: "dm-1",
    parentMessageId: "parent-1",
    serverSlug: "acme",
    navigate: (to, options) => {
      navigations.push({ to, replace: options.replace });
    },
    recordMobileBackNavigation: (type, path) => {
      mobileBackRecords.push({ type, path });
    },
  });

  assert.deepEqual(navigations, [
    { to: "/s/acme/dm/dm-1?msg=parent-1", replace: false },
  ]);
  assert.deepEqual(mobileBackRecords, []);
  assert.equal(useThreadStore.getState().openParentMessageId, null);
});

test("mobile View in channel replaces and records mobile back state", () => {
  resetStores();
  installWindowHistoryEntry(
    "/s/acme/activity",
    "?open=channel%3Achannel-1&thread=channel-1%3Aparent-1",
    { idx: 9, key: "activity-thread" },
  );
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
  });
  const navigations: Array<{ to: string; replace: boolean }> = [];
  const mobileBackRecords: Array<{ type: "PUSH" | "REPLACE"; path: string }> = [];

  openThreadParentMessageRoute({
    isDesktop: false,
    parentRouteKind: "channel",
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    serverSlug: "acme",
    navigate: (to, options) => {
      navigations.push({ to, replace: options.replace });
    },
    recordMobileBackNavigation: (type, path) => {
      mobileBackRecords.push({ type, path });
    },
  });

  assert.deepEqual(navigations, [
    { to: "/s/acme/channel/channel-1?msg=parent-1", replace: true },
  ]);
  assert.deepEqual(mobileBackRecords, [
    { type: "REPLACE", path: "/s/acme/channel/channel-1?msg=parent-1" },
  ]);
  assert.equal(useThreadStore.getState().openParentMessageId, null);
});

test("right-panel URL subscription reacts only to thread anchor ownership changes", () => {
  const anchor = {
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
  };

  assert.equal(hasRightPanelThreadAnchorChanged(anchor, anchor), false);
  assert.equal(
    hasRightPanelThreadAnchorChanged(
      { ...anchor, openParentMessageId: "parent-2" },
      anchor,
    ),
    true,
  );
  assert.equal(
    hasRightPanelThreadAnchorChanged(
      { ...anchor, openParentChannelId: "channel-2" },
      anchor,
    ),
    true,
  );
  // The task modal slot is an anchor-owning surface too (task #699): opening
  // or closing it must trigger the store→URL sync.
  assert.equal(
    hasRightPanelThreadAnchorChanged(
      { ...anchor, taskModal: { parentMessageId: "parent-1" } },
      anchor,
    ),
    true,
  );

  let syncCalls = 0;
  const unsubscribe = subscribeRightPanelThreadAnchor(() => {
    syncCalls += 1;
  });
  try {
    useThreadStore.setState({
      summaries: {
        "unrelated-parent": {
          threadChannelId: "thread-1",
          replyCount: 1,
          lastReplyAt: null,
          participantIds: [],
          unreadCount: 0,
          firstUnreadMessageId: null,
        },
      },
    });
    assert.equal(syncCalls, 0, "summary completion must not write navigation");

    useThreadStore.setState({
      openParentChannelId: "channel-1",
      openParentMessageId: "parent-1",
    });
    assert.equal(syncCalls, 1, "anchor ownership change must write navigation once");
  } finally {
    unsubscribe();
  }
});

test("right-panel close suppresses the stale thread permalink until the cleaned URL lands", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?msg=parent-1&thread=channel-1:parent-1",
  );
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    openThreadChannelId: "thread-1",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const unsubscribe = useThreadStore.subscribe(() => {
    syncRightPanelUrlFromStores({
      fallback: {
        pathname: "/s/acme/channel/channel-1",
        search: "?msg=parent-1&thread=channel-1:parent-1",
      },
      navigate: (to, options) => {
        navigations.push({ to, options });
      },
    });
  });

  try {
    useThreadStore.getState().closeThread();
  } finally {
    unsubscribe();
  }

  assert.deepEqual(navigations, [
    {
      to: {
        pathname: "/s/acme/channel/channel-1",
        search: "?msg=parent-1",
      },
      options: { replace: true },
    },
  ]);
  assert.equal(
    isCurrentRightPanelSearchSnapshot("?msg=parent-1&thread=channel-1:parent-1"),
    false,
    "stale URL->store effect must not reopen the just-closed thread permalink",
  );

  installWindowLocation("/s/acme/channel/channel-1", "?msg=parent-1");
  assert.equal(isCurrentRightPanelSearchSnapshot("?msg=parent-1"), true);
});

test("right-panel URL sync restores Activity thread params without a route gate", () => {
  resetStores();
  const opened: Array<[string, string, string | null]> = [];
  useThreadStore.setState({
    openThread: async ({
      parentChannelId,
      parentMessageId,
      focusedMessageId = null,
    }) => {
      opened.push([parentChannelId, parentMessageId, focusedMessageId]);
      useThreadStore.setState({
        openParentChannelId: parentChannelId,
        openParentMessageId: parentMessageId,
        focusedMessageId,
      });
    },
  });

  syncRightPanelStoresFromSearch("?thread=channel-1:parent-1");

  assert.deepEqual(opened, [["channel-1", "parent-1", null]]);
  assert.equal(useThreadStore.getState().openParentChannelId, "channel-1");
  assert.equal(useThreadStore.getState().openParentMessageId, "parent-1");
});

test("a cold-loaded search thread slot hands its thread channel id to openThread (task #14)", () => {
  resetStores();
  const opened: Array<{ parentChannelId: string; parentMessageId: string; threadChannelId: string | null | undefined }> = [];
  useThreadStore.setState({
    openThread: async ({ parentChannelId, parentMessageId, threadChannelId }) => {
      opened.push({ parentChannelId, parentMessageId, threadChannelId });
    },
  });

  syncRightPanelStoresFromSearch("?open=thread:thread-1&msg=reply-1&thread=channel-1:parent-1");
  // A non-thread content slot does not name the thread channel.
  resetStores();
  useThreadStore.setState({
    openThread: async ({ parentChannelId, parentMessageId, threadChannelId }) => {
      opened.push({ parentChannelId, parentMessageId, threadChannelId });
    },
  });
  syncRightPanelStoresFromSearch("?open=channel:channel-9&thread=channel-1:parent-1");

  assert.deepEqual(opened, [
    { parentChannelId: "channel-1", parentMessageId: "parent-1", threadChannelId: "thread-1" },
    { parentChannelId: "channel-1", parentMessageId: "parent-1", threadChannelId: null },
  ]);
});

test("task deep link restores task intent on a cold-loaded thread panel", () => {
  resetStores();
  const opened: Array<[string, string, string | undefined]> = [];
  useThreadStore.setState({
    openThread: async ({ parentChannelId, parentMessageId, intent }) => {
      opened.push([parentChannelId, parentMessageId, intent]);
      useThreadStore.setState({
        openParentChannelId: parentChannelId,
        openParentMessageId: parentMessageId,
        openIntent: intent ?? "thread",
      });
    },
  });

  syncRightPanelStoresFromSearch("?thread=channel-1:task-parent&task=1");

  assert.deepEqual(opened, [["channel-1", "task-parent", "task"]]);
  assert.equal(useThreadStore.getState().openIntent, "task");
});

test("right-panel URL sync updates focused thread reply when the same thread is already open", () => {
  resetStores();
  const opened: Array<[string, string, string | null]> = [];
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "parent-1",
    focusedMessageId: null,
    openThread: async ({
      parentChannelId,
      parentMessageId,
      focusedMessageId = null,
    }) => {
      opened.push([parentChannelId, parentMessageId, focusedMessageId]);
    },
  });

  syncRightPanelStoresFromSearch("?thread=channel-1:parent-1&msg=reply-2");

  assert.deepEqual(opened, []);
  assert.equal(useThreadStore.getState().focusedMessageId, "reply-2");
});

test("a specific agent tab intent is written through as that tab, not the ordered-first one", () => {
  // task #608 / @Jianwei: the hover card's activity affordance asks for a
  // SPECIFIC tab. The ordered-first path above would happily pick a different
  // tab here — the user's order starts with "profile" in this fixture — so this
  // pins that an explicit intent wins over the ordering.
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "?keep=1");
  useServerStore.setState({
    sidebarOrder: {
      ...originalServerState.sidebarOrder,
      agentPanelTabOrder: ["profile", "chat", "activity"],
    },
  });
  useProfileStore.setState({
    profileType: "agent",
    profileId: "agent-1",
    defaultAgentTabIntent: "activity",
  });

  const navigations: Array<{
    to: { pathname: string; search: string };
    options: { replace: boolean };
  }> = [];
  const changed = syncRightPanelUrlFromStores({
    fallback: { pathname: "/s/acme/channel/channel-1", search: "" },
    navigate: (to, options) => {
      navigations.push({ to, options });
    },
  });

  assert.equal(changed, true);
  assert.equal(
    navigations[0]?.to.search,
    "?keep=1&profile=agent%3Aagent-1&agentTab=activity",
    "an explicit tab intent must reach the URL as that tab",
  );
});

const externalMentionMember = {
  id: "projection-1",
  provider: "slack" as const,
  displayName: "Ada Lovelace",
  handles: ["ada.lovelace"],
  actorKind: "human" as const,
  avatarUrl: null,
  workspaceId: "opaque-workspace-id",
  externalActorId: "actor-1",
  installId: "install-1",
  appRegistrationId: "app-1",
  workspaceName: "Analytical Engines",
};

test("external mention profile restores via channel members (not message context)", async () => {
  resetStores();
  const search = "?profile=external-mention%3Achannel-1%3Aprojection-1";
  installWindowLocation("/s/acme/channel/channel-1", search);
  const requests: Array<{ url: string }> = [];
  api.get = (async (url: string) => {
    requests.push({ url });
    return {
      data: {
        agents: [],
        humans: [],
        externalMembers: [externalMentionMember],
      },
    };
  }) as typeof api.get;

  syncRightPanelStoresFromSearch(search);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(requests, [{ url: "/channels/channel-1/members" }]);
  assert.equal(useProfileStore.getState().profileType, "external");
  assert.equal(useProfileStore.getState().profileId, "projection-1");
  assert.equal(useProfileStore.getState().externalProfile?.displayName, "Ada Lovelace");
  assert.equal(useProfileStore.getState().externalProfileIsMention, true);
});

test("external mention profile closes when the projection is no longer in the binding", async () => {
  resetStores();
  const search = "?profile=external-mention%3Achannel-1%3Aprojection-gone";
  installWindowLocation("/s/acme/channel/channel-1", search);
  api.get = (async () => ({
    data: { agents: [], humans: [], externalMembers: [] },
  })) as typeof api.get;

  syncRightPanelStoresFromSearch(search);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(useProfileStore.getState().profileType, null);
});

test("external mention profile URL restores with parent channelId in a thread", async () => {
  resetStores();
  const search = "?profile=external-mention%3Aparent-channel-1%3Aprojection-1";
  installWindowLocation("/s/acme/channel/thread-1", search);
  api.get = (async () => ({
    data: { agents: [], humans: [], externalMembers: [externalMentionMember] },
  })) as typeof api.get;

  syncRightPanelStoresFromSearch(search);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(useProfileStore.getState().profileType, "external");
  assert.equal(useProfileStore.getState().externalProfileChannelId, "parent-channel-1");
});

// Hands 52c09462: View in channel to the message the URL already anchors
// (`?msg=` unchanged: the thread was opened from a link to it, from Activity,
// or after an earlier View in channel) doesn't reload the channel, so nothing
// located the message again. The jump itself asks for the highlight.
test("View in channel to the same ?msg= anchor locates the parent again", () => {
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "?msg=parent-1&thread=channel-1%3Aparent-1");
  useMessageStore.setState({ highlightedMessageId: null, channelMessages: { "channel-1": [{ id: "parent-1", channelId: "channel-1" } as never] } });
  const nonceBefore = useMessageStore.getState().highlightNonce;
  openThreadParentMessageRoute({
    isDesktop: true,
    parentRouteKind: "channel",
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    serverSlug: "acme",
    // As BrowserRouter does: the URL changes at once, so the anchor must be read before navigating.
    navigate: (to) => {
      const [path, search] = to.split("?");
      installWindowLocation(path, `?${search}`);
    },
    recordMobileBackNavigation: () => {},
  });
  assert.equal(useMessageStore.getState().highlightedMessageId, "parent-1");
  assert.equal(useMessageStore.getState().highlightNonce, nonceBefore + 1, "a new jump, so it lights again");
});

test("View in channel to a new ?msg= anchor leaves the highlight to the channel's load", () => {
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "?thread=channel-1%3Aparent-1");
  useMessageStore.setState({ highlightedMessageId: null, channelMessages: { "channel-1": [{ id: "parent-1", channelId: "channel-1" } as never] } });
  const nonceBefore = useMessageStore.getState().highlightNonce;
  openThreadParentMessageRoute({
    isDesktop: true,
    parentRouteKind: "channel",
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    serverSlug: "acme",
    navigate: (to) => {
      const [path, search] = to.split("?");
      installWindowLocation(path, `?${search}`);
    },
    recordMobileBackNavigation: () => {},
  });
  assert.equal(useMessageStore.getState().highlightedMessageId, null);
  assert.equal(useMessageStore.getState().highlightNonce, nonceBefore);
});

test("View in channel to the same anchor, parent not loaded: loads its window instead of a highlight with nothing to show", () => {
  resetStores();
  installWindowLocation("/s/acme/channel/channel-1", "?msg=parent-1&thread=channel-1%3Aparent-1");
  const loads: string[] = [];
  useMessageStore.setState({
    highlightedMessageId: null,
    channelMessages: { "channel-1": [{ id: "other", channelId: "channel-1" } as never] },
    loadMessageContext: async (channelId: string, messageId: string) => { loads.push(`${channelId}:${messageId}`); },
  });
  openThreadParentMessageRoute({
    isDesktop: true,
    parentRouteKind: "channel",
    parentChannelId: "channel-1",
    parentMessageId: "parent-1",
    serverSlug: "acme",
    navigate: () => {},
    recordMobileBackNavigation: () => {},
  });
  assert.deepEqual(loads, ["channel-1:parent-1"]);
  assert.equal(useMessageStore.getState().highlightedMessageId, null, "the context load highlights it once loaded");
});
