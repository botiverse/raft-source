import assert from "node:assert/strict";
import test from "node:test";
import { useThreadStore } from "../src/store/threadStore.js";
import api from "../src/api/client.js";

// Regression coverage for #engineering task #417: a thread permalink opened
// while the parent channel was still private / mid private→public conversion
// must not leave ThreadPanel stuck on an unbounded "Loading…" shell. The store
// records the failed anchor (openThreadError) and exposes retryOpenThread so
// the panel can show an actionable error + Retry and recover once the channel
// is public.

const originalGet = api.get.bind(api);

function resetStore() {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openThreadError: null,
    focusedMessageId: null,
    openedAt: 0,
    summaries: {},
    followedThreads: [],
  });
}

function restoreApi() {
  api.get = originalGet;
}

test("openThread flags openThreadError when resolution fails and there is no fallback thread id", async () => {
  resetStore();
  api.get = (async () => {
    throw new Error("403 Access denied");
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-1",
      parentMessageId: "parent-1",
    });

    const state = useThreadStore.getState();
    assert.equal(state.openThreadChannelId, null, "no thread id resolved");
    assert.deepEqual(
      state.openThreadError,
      { parentChannelId: "channel-1", parentMessageId: "parent-1" },
      "failed anchor recorded so the panel can show error + Retry instead of an infinite spinner",
    );
  } finally {
    restoreApi();
    resetStore();
  }
});

test("openThread treats a read-only 404 as a valid empty thread without persisting a channel", async () => {
  resetStore();
  api.get = (async () => {
    throw { response: { status: 404 } };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-1",
      parentMessageId: "parent-empty",
    });

    const state = useThreadStore.getState();
    assert.equal(state.openParentMessageId, "parent-empty");
    assert.equal(state.openThreadChannelId, null);
    assert.equal(state.openThreadError, null);
    assert.equal(state.openThreadLoading, false);
  } finally {
    restoreApi();
    resetStore();
  }
});

test("openThread does NOT flag an error when a known threadChannelId is available as fallback", async () => {
  resetStore();
  // Summary already known (e.g. from followed threads / prior summary push).
  useThreadStore.setState({
    summaries: {
      "parent-1": {
        threadChannelId: "thread-known",
        replyCount: 2,
        lastReplyAt: new Date().toISOString(),
        participantIds: [],
        unreadCount: 0,
        firstUnreadMessageId: null,
      },
    },
  });
  api.get = (async () => {
    throw new Error("network blip");
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-1",
      parentMessageId: "parent-1",
    });

    const state = useThreadStore.getState();
    assert.equal(state.openThreadChannelId, "thread-known", "fallback thread id keeps the panel usable");
    assert.equal(state.openThreadError, null, "no error flagged when the panel is still functional");
  } finally {
    restoreApi();
    resetStore();
  }
});

test("retryOpenThread re-resolves the current anchor and recovers after the channel becomes accessible", async () => {
  resetStore();
  let attempt = 0;
  api.get = (async (url: string) => {
    attempt += 1;
    if (attempt === 1) {
      // First open: channel still private / mid-conversion.
      throw new Error("403 Access denied");
    }
    // Retry: channel is now public.
    return {
      data: {
        threadChannelId: "thread-1",
        replyCount: 0,
        lastReplyAt: null,
        participantIds: [],
      },
      _url: url,
    };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-1",
      parentMessageId: "parent-1",
    });
    assert.deepEqual(useThreadStore.getState().openThreadError, {
      parentChannelId: "channel-1",
      parentMessageId: "parent-1",
    });

    await useThreadStore.getState().retryOpenThread();

    const state = useThreadStore.getState();
    assert.equal(attempt, 2, "retry re-issued the read-only lookup");
    assert.equal(state.openThreadChannelId, "thread-1", "thread resolved on retry");
    assert.equal(state.openThreadError, null, "error cleared once resolution succeeds");
  } finally {
    restoreApi();
    resetStore();
  }
});

test("retryOpenThread is a no-op when there is no open anchor", async () => {
  resetStore();
  let called = false;
  api.get = (async () => {
    called = true;
    return { data: {} };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().retryOpenThread();
    assert.equal(called, false, "no API call without an open parent anchor");
  } finally {
    restoreApi();
    resetStore();
  }
});

test("a successful openThread clears a stale openThreadError", async () => {
  resetStore();
  useThreadStore.setState({
    openThreadError: { parentChannelId: "old", parentMessageId: "old" },
  });
  api.get = (async () => ({
    data: { threadChannelId: "thread-2", replyCount: 0, lastReplyAt: null, participantIds: [] },
  })) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-2",
      parentMessageId: "parent-2",
    });
    assert.equal(useThreadStore.getState().openThreadError, null);
    assert.equal(useThreadStore.getState().openThreadChannelId, "thread-2");
  } finally {
    restoreApi();
    resetStore();
  }
});
