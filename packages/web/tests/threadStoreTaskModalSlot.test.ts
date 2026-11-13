import assert from "node:assert/strict";
import { useThreadStore } from "../src/store/threadStore";
import type { ThreadSummary } from "../src/store/threadStore";
import api from "../src/api/client";

const originalGet = api.get.bind(api);

function resetStore() {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openServerSlug: null,
    openIntent: null,
    openThreadError: null,
    openThreadLoading: false,
    focusedMessageId: null,
    openedAt: 0,
    taskModal: null,
    summaries: {},
    replyScopes: {},
    followedThreads: [],
  });
}

function makeSummary(threadChannelId: string): ThreadSummary {
  return {
    threadChannelId,
    replyCount: 1,
    lastReplyAt: new Date().toISOString(),
    participantIds: ["agent-1"],
    unreadCount: 0,
    firstUnreadMessageId: null,
  };
}

function restoreApi() {
  api.get = originalGet;
}

function openSideThread() {
  useThreadStore.setState({
    openParentMessageId: "parent-side",
    openParentChannelId: "channel-side",
    openThreadChannelId: "thread-side",
    openServerSlug: "acme",
    openIntent: "thread",
    focusedMessageId: null,
    openedAt: 123,
  });
}

function assertSideThreadUntouched() {
  const state = useThreadStore.getState();
  assert.deepEqual(
    {
      openParentMessageId: state.openParentMessageId,
      openParentChannelId: state.openParentChannelId,
      openThreadChannelId: state.openThreadChannelId,
      openServerSlug: state.openServerSlug,
      openIntent: state.openIntent,
      openedAt: state.openedAt,
    },
    {
      openParentMessageId: "parent-side",
      openParentChannelId: "channel-side",
      openThreadChannelId: "thread-side",
      openServerSlug: "acme",
      openIntent: "thread",
      openedAt: 123,
    },
    "the side thread's identity must not move when the task modal opens/closes",
  );
}

test("openThread with intent=task fills the independent slot and leaves the side thread identity untouched", async () => {
  resetStore();
  openSideThread();
  useThreadStore.setState({ summaries: { "parent-task": makeSummary("thread-task") } });
  let getCalled = false;
  api.get = (async () => {
    getCalled = true;
    return { data: {} };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
      intent: "task",
    });

    assertSideThreadUntouched();
    const slot = useThreadStore.getState().taskModal;
    assert.equal(slot?.parentMessageId, "parent-task");
    assert.equal(slot?.parentChannelId, "channel-task");
    assert.equal(slot?.threadChannelId, "thread-task", "known summary seeds the slot without a lookup");
    assert.equal(slot?.loading, false);
    assert.equal(getCalled, false);
  } finally {
    restoreApi();
    resetStore();
  }
});

test("closing the task modal empties the slot only — the side thread needs no restore", async () => {
  resetStore();
  openSideThread();
  useThreadStore.setState({ summaries: { "parent-task": makeSummary("thread-task") } });

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.equal(useThreadStore.getState().taskModal?.parentMessageId, "parent-task");

    useThreadStore.getState().closeTaskModal();

    assert.equal(useThreadStore.getState().taskModal, null);
    assertSideThreadUntouched();
  } finally {
    resetStore();
  }
});

test("opening an ordinary side thread clears the task modal slot", async () => {
  resetStore();
  useThreadStore.setState({ summaries: { "parent-task": makeSummary("thread-task") } });

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.notEqual(useThreadStore.getState().taskModal, null);

    useThreadStore.setState({ summaries: { "parent-new": makeSummary("thread-new") } });
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-new",
      parentMessageId: "parent-new",
    });

    assert.equal(useThreadStore.getState().taskModal, null);
    assert.equal(useThreadStore.getState().openParentMessageId, "parent-new");
    assert.equal(useThreadStore.getState().openThreadChannelId, "thread-new");
  } finally {
    resetStore();
  }
});

test("openTaskModal resolves an unknown thread channel with the same read-only lookup as openThread", async () => {
  resetStore();
  openSideThread();
  const getCalls: string[] = [];
  api.get = (async (url: string) => {
    getCalls.push(url);
    return {
      data: {
        threadChannelId: "thread-task",
        replyCount: 2,
        lastReplyAt: null,
        participantIds: [],
      },
    };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });

    assert.deepEqual(getCalls, ["/channels/channel-task/threads/parent-task"]);
    const slot = useThreadStore.getState().taskModal;
    assert.equal(slot?.threadChannelId, "thread-task");
    assert.equal(slot?.loading, false);
    assert.equal(slot?.error, null);
    assert.equal(
      useThreadStore.getState().summaries["parent-task"]?.threadChannelId,
      "thread-task",
    );
    assertSideThreadUntouched();
  } finally {
    restoreApi();
    resetStore();
  }
});

test("a failed slot lookup lands on the slot's own error state, never on the side thread's", async () => {
  resetStore();
  openSideThread();
  api.get = (async () => {
    throw new Error("boom");
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });

    const state = useThreadStore.getState();
    assert.deepEqual(state.taskModal?.error, {
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
      unavailable: false,
    });
    assert.equal(state.taskModal?.loading, false);
    assert.equal(state.openThreadError, null);
    assertSideThreadUntouched();
  } finally {
    restoreApi();
    resetStore();
  }
});

test("retryTaskModal re-runs the slot lookup after an error", async () => {
  resetStore();
  openSideThread();
  let fail = true;
  api.get = (async () => {
    if (fail) throw new Error("boom");
    return {
      data: {
        threadChannelId: "thread-task",
        replyCount: 0,
        lastReplyAt: null,
        participantIds: [],
      },
    };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.notEqual(useThreadStore.getState().taskModal?.error, null);

    fail = false;
    await useThreadStore.getState().retryTaskModal();

    const slot = useThreadStore.getState().taskModal;
    assert.equal(slot?.error, null);
    assert.equal(slot?.threadChannelId, "thread-task");
    assertSideThreadUntouched();
  } finally {
    restoreApi();
    resetStore();
  }
});

const originalPost = api.post.bind(api);

function restorePost() {
  api.post = originalPost;
}

test("task #750: ensureTaskModalThreadChannel resolves from the modal slot anchor, not the side thread", async () => {
  resetStore();
  // A side thread being open underneath must not matter: the old code read
  // the side open* slots for a modal send, which threw "No open thread to
  // resolve" whenever they were empty. Pin both directions: with NO side
  // thread open the modal ensure still resolves.
  const postCalls: Array<{ url: string; body: unknown }> = [];
  api.get = (async () => ({ data: {} })) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    return { data: { threadChannelId: "thread-created-from-modal" } };
  }) as typeof api.post;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.equal(useThreadStore.getState().taskModal?.threadChannelId, null, "zero-reply task: no thread yet");

    const resolved = await useThreadStore.getState().ensureTaskModalThreadChannel();
    assert.equal(resolved, "thread-created-from-modal");
    assert.deepEqual(postCalls, [{
      url: "/channels/channel-task/threads",
      body: { parentMessageId: "parent-task" },
    }]);
    // Same discipline as the side thread: resolution alone stays local; the
    // slot is bound on durable accept (ThreadPanel's onChannelResolved).
    assert.equal(
      useThreadStore.getState().taskModal?.threadChannelId,
      null,
      "resolution alone does not bind the slot",
    );
  } finally {
    restorePost();
    restoreApi();
    resetStore();
  }
});

test("task #750: an already-bound modal slot resolves without a second POST", async () => {
  resetStore();
  useThreadStore.setState({ summaries: { "parent-task": makeSummary("thread-task") } });
  let postCalled = false;
  api.post = (async () => {
    postCalled = true;
    return { data: {} };
  }) as typeof api.post;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    assert.equal(useThreadStore.getState().taskModal?.threadChannelId, "thread-task");

    const resolved = await useThreadStore.getState().ensureTaskModalThreadChannel();
    assert.equal(resolved, "thread-task");
    assert.equal(postCalled, false, "known thread id short-circuits the writer");
  } finally {
    restorePost();
    resetStore();
  }
});

test("task #750: modal ensure with no slot open fails without touching the side thread", async () => {
  resetStore();
  openSideThread();

  await assert.rejects(
    () => useThreadStore.getState().ensureTaskModalThreadChannel(),
    /No open task modal to resolve/,
  );
  assertSideThreadUntouched();
});

test("task #750 follow-up: a server switch mid-flight is caught by the slot guard", async () => {
  resetStore();
  api.get = (async () => ({ data: {} })) as typeof api.get;
  api.post = (async () => {
    // The slot's server changes while the create call is in flight — the
    // guard must compare the server slug like it compares the anchor.
    useThreadStore.setState((prev) => ({
      taskModal: prev.taskModal ? { ...prev.taskModal, serverSlug: "other-server" } : null,
    }));
    return { data: { threadChannelId: "thread-late" } };
  }) as typeof api.post;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    await assert.rejects(
      () => useThreadStore.getState().ensureTaskModalThreadChannel(),
      /Thread context changed while creating the thread/,
    );
    assert.equal(
      useThreadStore.getState().taskModal?.threadChannelId,
      null,
      "a cross-server stale accept must not bind the slot",
    );
  } finally {
    restorePost();
    restoreApi();
    resetStore();
  }
});

test("task #750: a stale resolution (anchor changed mid-flight) throws and writes nothing", async () => {
  resetStore();
  api.get = (async () => ({ data: {} })) as typeof api.get;
  api.post = (async () => {
    // The modal is closed while the create call is in flight.
    useThreadStore.getState().closeTaskModal();
    return { data: { threadChannelId: "thread-late" } };
  }) as typeof api.post;

  try {
    await useThreadStore.getState().openTaskModal({
      parentChannelId: "channel-task",
      parentMessageId: "parent-task",
    });
    await assert.rejects(
      () => useThreadStore.getState().ensureTaskModalThreadChannel(),
      /Thread context changed while creating the thread/,
    );
    assert.equal(useThreadStore.getState().taskModal, null);
  } finally {
    restorePost();
    restoreApi();
    resetStore();
  }
});
