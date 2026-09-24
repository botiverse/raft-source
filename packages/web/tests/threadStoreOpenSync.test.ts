import assert from "node:assert/strict";
import test from "node:test";
import { useThreadStore } from "../src/store/threadStore.js";
import type { ThreadSummary } from "../src/store/threadStore.js";
import { hydrateThreadRepliesScope } from "../src/store/threadRepliesReadModel.js";
import api from "../src/api/client.js";
import { useServerStore } from "../src/store/serverStore.js";
import type { Server } from "../src/store/serverStore.js";

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

function resetStore() {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openServerSlug: null,
    focusedMessageId: null,
    openedAt: 0,
    summaries: {},
    replyScopes: {},
    followedThreads: [],
  });
}

function makeServer(slug: string): Server {
  return {
    id: `${slug}-id`,
    name: slug,
    avatarUrl: null,
    slug,
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-07-14T00:00:00.000Z",
  };
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
  api.post = originalPost;
  api.get = originalGet;
}

test("updateSummary promotes threadChannelId into openThreadChannelId when a summary arrives for the currently-open empty panel", () => {
  resetStore();
  useThreadStore.setState({
    openParentMessageId: "parent-1",
    openParentChannelId: "channel-1",
    openThreadChannelId: null,
    openedAt: Date.now(),
  });

  useThreadStore.getState().updateSummary("parent-1", makeSummary("thread-1"));

  const state = useThreadStore.getState();
  assert.equal(state.openThreadChannelId, "thread-1");
  assert.equal(state.summaries["parent-1"].threadChannelId, "thread-1");
});

test("rebaseline hydration promotes the first reply's threadChannelId into an already-open empty panel", () => {
  resetStore();
  useThreadStore.setState({
    openParentMessageId: "parent-1",
    openParentChannelId: "channel-1",
    openThreadChannelId: null,
    openThreadLoading: false,
    openedAt: Date.now(),
  });

  const summary = makeSummary("thread-1");
  const scope = hydrateThreadRepliesScope([
    {
      messageId: "reply-1",
      seq: 1,
      preview: "first reply",
      senderType: "agent",
      senderId: "agent-1",
      senderName: "agent-1",
      senderDisplayName: "Agent One",
      createdAt: "2026-07-27T06:24:00.000Z",
    },
  ], 1);

  useThreadStore.getState().hydrateSummariesWithReplyScopes(
    { "parent-1": summary },
    { "parent-1": scope },
  );

  const state = useThreadStore.getState();
  assert.equal(
    state.openThreadChannelId,
    "thread-1",
    "the open panel must bind to the durable thread created by the 0→1 reply",
  );
  assert.equal(state.summaries["parent-1"].replyCount, 1);
  assert.equal(state.replyScopes["parent-1"].replyCount, 1);
  assert.equal(state.replyScopes["parent-1"].replies[0]?.messageId, "reply-1");
});

test("updateSummary does not touch openThreadChannelId when the summary is for a different parent", () => {
  resetStore();
  useThreadStore.setState({
    openParentMessageId: "parent-1",
    openParentChannelId: "channel-1",
    openThreadChannelId: null,
    openedAt: Date.now(),
  });

  useThreadStore.getState().updateSummary("parent-other", makeSummary("thread-other"));

  assert.equal(useThreadStore.getState().openThreadChannelId, null);
});

test("updateSummary does not overwrite an already-known openThreadChannelId", () => {
  resetStore();
  useThreadStore.setState({
    openParentMessageId: "parent-1",
    openParentChannelId: "channel-1",
    openThreadChannelId: "thread-existing",
    openedAt: Date.now(),
  });

  useThreadStore.getState().updateSummary("parent-1", makeSummary("thread-different"));

  assert.equal(useThreadStore.getState().openThreadChannelId, "thread-existing");
});

test("openThread resolves an existing thread with a read-only lookup", async () => {
  resetStore();
  const postCalls: Array<{ url: string; body: unknown }> = [];
  const getCalls: string[] = [];
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    throw new Error("openThread must not write");
  }) as typeof api.post;
  api.get = (async (url: string) => {
    getCalls.push(url);
    return {
      data: {
        threadChannelId: "thread-1",
        replyCount: 0,
        lastReplyAt: null,
        participantIds: [],
      },
    };
  }) as typeof api.get;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-1",
      parentMessageId: "parent-1",
    });

    const state = useThreadStore.getState();
    assert.deepEqual(postCalls, []);
    assert.deepEqual(getCalls, ["/channels/channel-1/threads/parent-1"]);
    assert.equal(state.openParentMessageId, "parent-1");
    assert.equal(state.openParentChannelId, "channel-1");
    assert.equal(state.openThreadChannelId, "thread-1");
    assert.deepEqual(state.summaries["parent-1"], {
      threadChannelId: "thread-1",
      replyCount: 0,
      lastReplyAt: null,
      participantIds: [],
      unreadCount: 0,
      firstUnreadMessageId: null,
    });
  } finally {
    restoreApi();
    resetStore();
  }
});

test("openThread can seed threadChannelId from an activity inbox row without any lookup or write", async () => {
  resetStore();
  let getCalled = false;
  let postCalled = false;
  api.get = (async () => {
    getCalled = true;
    return { data: {} };
  }) as typeof api.get;
  api.post = (async () => {
    postCalled = true;
    return { data: {} };
  }) as typeof api.post;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "joint-parent-local",
      parentMessageId: "parent-1",
      focusedMessageId: "reply-1",
      initialThreadChannelId: "joint-thread-local",
    });

    let state = useThreadStore.getState();
    assert.equal(state.openParentMessageId, "parent-1");
    assert.equal(state.openParentChannelId, "joint-parent-local");
    assert.equal(state.focusedMessageId, "reply-1");
    assert.equal(
      state.openThreadChannelId,
      "joint-thread-local",
      "activity inbox already knows the local joint thread projection id",
    );
    assert.equal(state.openThreadError, null);
    assert.equal(getCalled, false);
    assert.equal(postCalled, false);
  } finally {
    restoreApi();
    resetStore();
  }
});

test("ensureOpenThreadChannel is the explicit first-durable-action writer", async () => {
  resetStore();
  const postCalls: Array<{ url: string; body: unknown }> = [];
  api.get = (async () => {
    throw { response: { status: 404 } };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    return { data: { threadChannelId: "thread-created" } };
  }) as typeof api.post;

  try {
    await useThreadStore.getState().openThread({
      parentChannelId: "channel-1",
      parentMessageId: "parent-1",
    });
    assert.deepEqual(postCalls, [], "view-only open must not create storage");

    const threadChannelId = await useThreadStore.getState().ensureOpenThreadChannel();
    assert.equal(threadChannelId, "thread-created");
    assert.deepEqual(postCalls, [{
      url: "/channels/channel-1/threads",
      body: { parentMessageId: "parent-1" },
    }]);
    assert.equal(
      useThreadStore.getState().openThreadChannelId,
      null,
      "resolution alone stays local until the durable message is accepted",
    );
  } finally {
    restoreApi();
    resetStore();
  }
});

test("typed openThread preserves participant projection ids and drops a stale server-epoch response", async () => {
  resetStore();
  const originalServer = useServerStore.getState().current;
  const originalEpoch = useServerStore.getState().serverEpoch;
  useServerStore.setState({ current: makeServer("guest-server"), serverEpoch: originalEpoch + 1 });
  let getCalled = false;
  api.get = (async () => {
    getCalled = true;
    return { data: {} };
  }) as typeof api.get;

  try {
    const pending = useThreadStore.getState().openThread({
      serverSlug: "guest-server",
      parentChannelId: "guest-parent-projection",
      parentMessageId: "parent-1",
      threadChannelId: "guest-thread-projection",
      focusedMessageId: "reply-1",
    });

    assert.deepEqual(
      {
        serverSlug: useThreadStore.getState().openServerSlug,
        parentChannelId: useThreadStore.getState().openParentChannelId,
        threadChannelId: useThreadStore.getState().openThreadChannelId,
        focusedMessageId: useThreadStore.getState().focusedMessageId,
      },
      {
        serverSlug: "guest-server",
        parentChannelId: "guest-parent-projection",
        threadChannelId: "guest-thread-projection",
        focusedMessageId: "reply-1",
      },
    );

    useServerStore.setState({ current: makeServer("other-server"), serverEpoch: originalEpoch + 2 });
    await pending;

    assert.equal(getCalled, false, "known route identity never launches a lookup");
    assert.equal(useThreadStore.getState().openThreadChannelId, "guest-thread-projection");
    assert.equal(useThreadStore.getState().summaries["parent-1"], undefined, "stale response cannot rewrite route state");
  } finally {
    restoreApi();
    useServerStore.setState({ current: originalServer, serverEpoch: originalEpoch });
    resetStore();
  }
});

test("typed openThread fails closed when its route server is not active", async () => {
  resetStore();
  const originalServer = useServerStore.getState().current;
  const originalEpoch = useServerStore.getState().serverEpoch;
  useServerStore.setState({ current: makeServer("guest-server"), serverEpoch: originalEpoch + 1 });
  let called = false;
  api.post = (async () => {
    called = true;
    return { data: {} };
  }) as typeof api.post;

  try {
    await useThreadStore.getState().openThread({
      serverSlug: "host-server",
      parentChannelId: "host-parent",
      parentMessageId: "parent-1",
      threadChannelId: "host-thread",
    });
    assert.equal(called, false);
    assert.equal(useThreadStore.getState().openParentMessageId, null);
  } finally {
    restoreApi();
    useServerStore.setState({ current: originalServer, serverEpoch: originalEpoch });
    resetStore();
  }
});
