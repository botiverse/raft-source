import assert from "node:assert/strict";
import test from "node:test";

const {
  beginRightPanelSearchTransition,
  hasRightPanelThreadAnchorChanged,
  isCurrentRightPanelSearchSnapshot,
  subscribeRightPanelThreadAnchor,
  syncRightPanelStoresFromSearch,
  syncRightPanelUrlFromStores,
  transitionThreadToParentMessage,
} = await import("../src/components/layout/rightPanelUrlSync.js");
const { useProfileStore } = await import("../src/store/profileStore.js");
const { useServerStore } = await import("../src/store/serverStore.js");
const { useThreadStore } = await import("../src/store/threadStore.js");
const { useLegacyTaskPanelStore } = await import("../src/store/legacyTaskPanelStore.js");
const { useTaskStore } = await import("../src/store/taskStore.js");

const originalThreadState = useThreadStore.getState();
const originalProfileState = useProfileStore.getState();
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
    openThread: originalThreadState.openThread,
    closeThread: originalThreadState.closeThread,
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
    defaultAgentTabIntent: null,
    openProfile: originalProfileState.openProfile,
    clearDefaultAgentTabIntent: originalProfileState.clearDefaultAgentTabIntent,
    closeProfile: originalProfileState.closeProfile,
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
  restoreWindow();
});

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

test("task intent pushes when it replaces an already-open thread so Back restores the origin", () => {
  resetStores();
  installWindowLocation(
    "/s/acme/channel/channel-1",
    "?msg=origin-reply&thread=channel-1:origin-parent",
  );
  useThreadStore.setState({
    openParentChannelId: "channel-1",
    openParentMessageId: "task-parent",
    openThreadChannelId: "task-thread",
    openIntent: "task",
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
        search: "?msg=origin-reply&thread=channel-1%3Atask-parent&task=1",
      },
      options: { replace: false },
    },
  ]);
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
