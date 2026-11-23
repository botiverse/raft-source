import assert from "node:assert/strict";
import { parseRaftPermalink } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { useUIStore } from "../src/store/uiStore";
import { useChannelAccessLossStore } from "../src/store/channelAccessLoss";
import { needsCanonicalId, resolveMessageLinkIds } from "../src/store/threadLinkIds";

// #503: a link naming a thread parent by its 8-hex short id opened the thread
// with that short id, the thread route's non-UUID guard answered 404, and the
// panel said "You can't access this thread". The web resolves link ids through
// `/messages/context/:id` before any UUID route sees them.

const CHANNEL = "0d9f3c2a-1111-4222-8333-444444444444";
const PARENT = "7a1b2c3d-5555-4666-8777-888888888888";
const PARENT_SHORT = "7a1b2c3d";
const REPLY = "9e8d7c6b-aaaa-4bbb-8ccc-dddddddddddd";
const THREAD_CHANNEL = "5f4e3d2c-eeee-4fff-8000-111111111111";

const originalGet = api.get.bind(api);
let requests: Array<{ url: string; params?: Record<string, unknown> }> = [];

function mockGet(answer: (url: string, params?: Record<string, unknown>) => unknown) {
  requests = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    requests.push({ url, params: config?.params });
    return { data: answer(url, config?.params) };
  }) as typeof api.get;
}

/** Holds every context lookup until `release()`; other requests answer at once. */
function gateContext(answer: (url: string) => unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  requests = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    requests.push({ url, params: config?.params });
    if (url.startsWith("/messages/context/")) await gate;
    return { data: answer(url) };
  }) as typeof api.get;
  return async () => {
    release();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
}

const OTHER_PARENT = "3c3c3c3c-2222-4333-8444-555555555555";
const OTHER_THREAD_CHANNEL = "6a6a6a6a-2222-4333-8444-555555555555";
const resolvedParent = (url: string) => url.startsWith("/messages/context/")
  ? { channelId: CHANNEL, targetMessageId: PARENT, canonicalTarget: null }
  : { threadChannelId: url.includes(OTHER_PARENT) ? OTHER_THREAD_CHANNEL : THREAD_CHANNEL };

function notFound(): never {
  throw { response: { status: 404, data: { error: "Message not found" } } };
}

function resetStores() {
  useThreadStore.setState({
    openParentMessageId: null,
    openThreadChannelId: null,
    openParentChannelId: null,
    openThreadError: null,
    openThreadLoading: false,
    focusedMessageId: null,
    taskModal: null,
    summaries: {},
    followedThreads: [],
  });
}

const quietConsole = console.error;
beforeEach(() => {
  resetStores();
  console.error = () => {};
});
afterEach(() => {
  api.get = originalGet;
  console.error = quietConsole;
  resetStores();
});

test("needsCanonicalId flags short and cut UUIDs only", () => {
  assert.equal(needsCanonicalId(PARENT_SHORT), true);
  assert.equal(needsCanonicalId(PARENT.slice(0, 20)), true);
  assert.equal(needsCanonicalId(PARENT), false);
  assert.equal(needsCanonicalId(PARENT.toUpperCase()), false);
});

test("a same-server thread link with an 8-hex parent resolves through one context lookup", async () => {
  mockGet((url) => {
    assert.equal(url, `/messages/context/${PARENT_SHORT}`);
    return { channelId: CHANNEL, targetMessageId: PARENT, canonicalTarget: null };
  });
  const link = parseRaftPermalink(`https://app.raft.build/s/acme/channel/${CHANNEL}?thread=${CHANNEL}:${PARENT_SHORT}`);
  assert.ok(link);
  assert.equal(link.threadParentMessageId, PARENT_SHORT);

  const resolved = await resolveMessageLinkIds(link);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].params?.channelId, CHANNEL);
  assert.deepEqual(resolved, { ...link, channelId: CHANNEL, messageId: PARENT, threadParentMessageId: PARENT });
});

test("a link to a reply by short id resolves to its thread's canonical parent", async () => {
  mockGet(() => ({
    channelId: THREAD_CHANNEL,
    targetMessageId: REPLY,
    canonicalTarget: { kind: "thread", channelId: CHANNEL, threadParentMessageId: PARENT, threadChannelId: THREAD_CHANNEL, messageId: REPLY },
  }));
  const link = parseRaftPermalink(`https://app.raft.build/s/acme/channel/${CHANNEL}?thread=${CHANNEL}:${PARENT_SHORT}&msg=${REPLY.slice(0, 8)}`);
  assert.ok(link);

  const resolved = await resolveMessageLinkIds(link);

  assert.equal(requests.length, 1, "the reply's lookup names its parent: no second lookup");
  assert.deepEqual(resolved, { ...link, channelId: CHANNEL, messageId: REPLY, threadParentMessageId: PARENT });
});

test("a link with full UUIDs passes through with no request", async () => {
  mockGet(() => assert.fail("no lookup for canonical ids"));
  const link = parseRaftPermalink(`https://app.raft.build/s/acme/channel/${CHANNEL}?thread=${CHANNEL}:${PARENT}&msg=${REPLY}`);
  assert.ok(link);
  assert.equal(await resolveMessageLinkIds(link), link);
});

test("openThread with an 8-hex parent sends the thread lookup canonical UUIDs", async () => {
  mockGet((url) => {
    if (url.startsWith("/messages/context/")) return { channelId: CHANNEL, targetMessageId: PARENT, canonicalTarget: null };
    return { threadChannelId: THREAD_CHANNEL, replyCount: 2 };
  });

  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });

  // (then the resolved thread's replies prefetch)
  assert.deepEqual(requests.slice(0, 2).map((request) => request.url), [
    `/messages/context/${PARENT_SHORT}`,
    `/channels/${CHANNEL}/threads/${PARENT}`,
  ]);
  const state = useThreadStore.getState();
  assert.equal(state.openParentMessageId, PARENT);
  assert.equal(state.openParentChannelId, CHANNEL);
  assert.equal(state.openThreadChannelId, THREAD_CHANNEL);
  assert.equal(state.openThreadError, null);
});

test("openThread with full UUIDs makes no context lookup", async () => {
  mockGet(() => ({ threadChannelId: THREAD_CHANNEL }));
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT });
  assert.deepEqual(requests.map((request) => request.url), [`/channels/${CHANNEL}/threads/${PARENT}`]);
});

test("an 8-hex parent nothing resolves ends on the generic failure, without Retry and without a thread lookup", async () => {
  mockGet(notFound);

  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });

  assert.deepEqual(requests.map((request) => request.url), [`/messages/context/${PARENT_SHORT}`]);
  const state = useThreadStore.getState();
  assert.equal(state.openParentMessageId, PARENT_SHORT);
  assert.equal(state.openThreadLoading, false);
  assert.deepEqual(state.openThreadError, {
    parentChannelId: CHANNEL,
    parentMessageId: PARENT_SHORT,
    unavailable: false,
    unresolved: true,
  });

  // Retry (were it offered) re-resolves; it never sends the short id to the thread route.
  await useThreadStore.getState().retryOpenThread();
  assert.ok(requests.every((request) => request.url.startsWith("/messages/context/")));
});

test("a short id under a cut channel id makes no request at all", async () => {
  mockGet(() => assert.fail("nothing can be resolved"));
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL.slice(0, 13), parentMessageId: PARENT_SHORT });
  assert.equal(requests.length, 0);
  assert.equal(useThreadStore.getState().openThreadError?.unresolved, true);
});

test("a context lookup that fails transiently keeps Retry", async () => {
  mockGet(() => {
    throw { response: { status: 503 } };
  });
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  assert.deepEqual(useThreadStore.getState().openThreadError, {
    parentChannelId: CHANNEL,
    parentMessageId: PARENT_SHORT,
    unavailable: false,
    unresolved: false,
  });
});

test("a 403 from the thread lookup still reads as can't access", async () => {
  mockGet(() => {
    throw { response: { status: 403, data: { error: "Access denied" } } };
  });
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT });
  assert.equal(useThreadStore.getState().openThreadError?.unavailable, true);
});

test("openTaskModal with an 8-hex parent opens the task with canonical ids", async () => {
  mockGet((url) => {
    if (url.startsWith("/messages/context/")) return { channelId: CHANNEL, targetMessageId: PARENT };
    return { threadChannelId: THREAD_CHANNEL };
  });
  await useThreadStore.getState().openTaskModal({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  assert.deepEqual(requests.map((request) => request.url), [
    `/messages/context/${PARENT_SHORT}`,
    `/channels/${CHANNEL}/threads/${PARENT}`,
  ]);
  assert.equal(useThreadStore.getState().taskModal?.parentMessageId, PARENT);
});

test("ensureChannel does not request a short channel id", async () => {
  const { current } = useServerStore.getState();
  useServerStore.setState({ current: { id: "server-1", slug: "acme" } as never });
  try {
    mockGet(() => assert.fail("no channel request for a short id"));
    assert.equal(await useChannelStore.getState().ensureChannel(PARENT_SHORT), null);
    assert.equal(requests.length, 0);
  } finally {
    useServerStore.setState({ current });
  }
});

test("while the short id is looked up the raw anchor is the open one, loading", async () => {
  const release = gateContext(resolvedParent);
  const opening = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });

  const pending = useThreadStore.getState();
  assert.equal(pending.openParentMessageId, PARENT_SHORT);
  assert.equal(pending.openParentChannelId, CHANNEL);
  assert.equal(pending.openThreadLoading, true);
  assert.equal(pending.openThreadError, null);

  await release();
  await opening;
  assert.equal(useThreadStore.getState().openParentMessageId, PARENT);
  assert.equal(useThreadStore.getState().openThreadChannelId, THREAD_CHANNEL);
});

test("a thread closed (Back) while its short id is looked up stays closed", async () => {
  const release = gateContext(resolvedParent);
  const opening = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  useThreadStore.getState().closeThread();

  await release();
  await opening;
  const state = useThreadStore.getState();
  assert.equal(state.openParentMessageId, null);
  assert.equal(state.openThreadError, null);
  assert.deepEqual(requests.map((request) => request.url), [`/messages/context/${PARENT_SHORT}`], "no thread lookup for the stale open");
});

test("a newer open while a short id is looked up wins (A open, B by short id, A again)", async () => {
  const release = gateContext(resolvedParent);
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: OTHER_PARENT });
  assert.equal(useThreadStore.getState().openThreadChannelId, OTHER_THREAD_CHANNEL);

  const opening = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  assert.equal(useThreadStore.getState().openParentMessageId, PARENT_SHORT);
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: OTHER_PARENT });

  await release();
  await opening;
  const state = useThreadStore.getState();
  assert.equal(state.openParentMessageId, OTHER_PARENT);
  assert.equal(state.openThreadChannelId, OTHER_THREAD_CHANNEL);
  assert.equal(state.openThreadError, null);
});

test("a stale failed lookup does not put its failure on a newer open", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  api.get = (async (url: string) => {
    if (url.startsWith("/messages/context/")) {
      await gate;
      notFound();
    }
    return { data: { threadChannelId: OTHER_THREAD_CHANNEL } };
  }) as typeof api.get;
  const opening = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: OTHER_PARENT });
  release();
  await opening;
  assert.equal(useThreadStore.getState().openParentMessageId, OTHER_PARENT);
  assert.equal(useThreadStore.getState().openThreadError, null);
});

test("the same short open again after a close (Back, Forward) while looked up still opens", async () => {
  const release = gateContext(resolvedParent);
  const first = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  useThreadStore.getState().closeThread();
  const again = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  assert.equal(useThreadStore.getState().openThreadLoading, true);

  await release();
  await Promise.all([first, again]);
  assert.equal(useThreadStore.getState().openParentMessageId, PARENT);
  assert.equal(useThreadStore.getState().openThreadChannelId, THREAD_CHANNEL);
});

test("a task modal closed while its short id is looked up stays closed", async () => {
  const release = gateContext(resolvedParent);
  const opening = useThreadStore.getState().openTaskModal({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  assert.equal(useThreadStore.getState().taskModal?.loading, true);
  useThreadStore.setState({ taskModal: null });

  await release();
  await opening;
  assert.equal(useThreadStore.getState().taskModal, null);
  assert.equal(requests.length, 1);
});

test("a target behind the history window (404 history_limited) still resolves", async () => {
  requests = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    requests.push({ url, params: config?.params });
    if (url.startsWith("/messages/context/")) {
      throw { response: { status: 404, data: { code: "history_limited", channelId: CHANNEL, targetMessageId: PARENT, canonicalTarget: null } } };
    }
    return { data: { threadChannelId: THREAD_CHANNEL } };
  }) as typeof api.get;

  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });

  assert.equal(requests[1]?.url, `/channels/${CHANNEL}/threads/${PARENT}`);
  assert.equal(useThreadStore.getState().openParentMessageId, PARENT);
  assert.equal(useThreadStore.getState().openThreadError, null);
});

test("a short link that fails over a maximized thread leaves Focus Mode", async () => {
  mockGet((url) => {
    if (url.startsWith("/messages/context/")) notFound();
    return { threadChannelId: OTHER_THREAD_CHANNEL };
  });
  await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: OTHER_PARENT });
  useUIStore.setState({ threadMaximized: true });
  try {
    await useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
    assert.equal(useThreadStore.getState().openThreadError?.unresolved, true);
    assert.equal(useUIStore.getState().threadMaximized, false);
  } finally {
    useUIStore.getState().restoreThreadLayout();
  }
});

test("a short channel id is marked unavailable, as a refused one is", async () => {
  const { current } = useServerStore.getState();
  useServerStore.setState({ current: { id: "server-1", slug: "acme" } as never });
  try {
    mockGet(() => assert.fail("no channel request for a short id"));
    assert.equal(await useChannelStore.getState().ensureChannel(PARENT_SHORT), null);
    assert.equal(useChannelAccessLossStore.getState().unavailable[PARENT_SHORT], true);
  } finally {
    useServerStore.setState({ current });
    useChannelAccessLossStore.setState({ unavailable: {} });
  }
});

test("the same short open again after the lookup answered (the thread request still out) joins it, not stranding the panel loading", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  requests = [];
  api.get = (async (url: string, config?: { params?: Record<string, unknown> }) => {
    requests.push({ url, params: config?.params });
    if (url.includes("/threads/")) await gate;
    return { data: resolvedParent(url) };
  }) as typeof api.get;
  const first = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const again = useThreadStore.getState().openThread({ parentChannelId: CHANNEL, parentMessageId: PARENT_SHORT });
  release();
  await Promise.all([first, again]);
  assert.equal(useThreadStore.getState().openParentMessageId, PARENT);
  assert.equal(useThreadStore.getState().openThreadChannelId, THREAD_CHANNEL);
  assert.equal(useThreadStore.getState().openThreadLoading, false);
});
