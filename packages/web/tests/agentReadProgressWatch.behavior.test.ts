/**
 * Agent read progress (agent_read_progress_v0) on the socket: the tab's
 * watches (counted per conversation, sent again after a reconnect) and the
 * `read_progress:updated` frames, which move the hydrated agents forward in
 * the read-receipt store and nothing else; `read_progress:detail_changed` and
 * `thread:followers-updated` load a watched conversation's detail again.
 */
import assert from "node:assert/strict";
import {
  READ_PROGRESS_DETAIL_CHANGED_EVENT,
  READ_PROGRESS_MAX_WATCHED_SCOPES,
  READ_PROGRESS_UNWATCH_EVENT,
  READ_PROGRESS_UPDATED_EVENT,
  READ_PROGRESS_WATCH_EVENT,
} from "@botiverse/raft-shared";
import {
  acquireAgentReadProgressWatch,
  isAgentReadProgressWatched,
  resetAgentReadProgressWatchForTests,
  rewatchAgentReadProgress,
  setAgentReadProgressWatchSocket,
} from "../src/store/agentReadProgressWatch";
import { resetAgentActivitySubscriptionsForTests } from "../src/store/agentActivitySubscriptions";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import api from "../src/api/client";
import { CHANNEL_DETAIL_REASON_HEADER } from "../src/store/channelDetailReason";
import { useReadReceiptStore } from "../src/store/readReceiptStore";
import { useServerStore } from "../src/store/serverStore";

const originalGet = api.get.bind(api);

function recordingSocket(connected = true) {
  const emits: Array<[string, unknown]> = [];
  return { emits, socket: { connected, emit: (event: string, payload: unknown) => { emits.push([event, payload]); } } };
}

function binding(event: string) {
  const socket = { connected: true, emit: () => undefined, on: () => undefined, off: () => undefined, onAny: () => undefined, offAny: () => undefined, disconnect: () => undefined, connect: () => undefined } as unknown as MainLayoutSocketBridgeSocket;
  const found = buildMainLayoutSocketBindings(socket, () => undefined, async () => undefined, () => undefined, () => undefined).find((item) => item.event === event);
  assert.ok(found, event);
  return found.handler as (payload: unknown) => void;
}

function reset() {
  api.get = originalGet;
  resetAgentReadProgressWatchForTests();
  resetAgentActivitySubscriptionsForTests();
  useReadReceiptStore.getState().clearAll();
  useServerStore.setState({ current: { id: "server-1" } as never, serverEpoch: 1 });
}

const detail = (peers: Record<string, number>) => ({
  peerReadStates: Object.entries(peers).map(([peerId, maxReadSeq]) => ({ peerKind: "agent", peerId, maxReadSeq })),
});

/** api.get for channel details that answer only when the test says so. */
function deferredDetails() {
  const requests: Array<{ url: string; reason: unknown; resolve: (data: unknown) => void; reject: (error: unknown) => void }> = [];
  api.get = ((url: string, config?: { headers?: Record<string, unknown> }) => new Promise<unknown>((resolve, reject) => {
    requests.push({
      url,
      reason: config?.headers?.[CHANNEL_DETAIL_REASON_HEADER],
      resolve: (data) => resolve({ data }),
      reject,
    });
  })) as unknown as typeof api.get;
  return requests;
}

beforeEach(reset);
afterEach(reset);

test("watches are counted per conversation: the first holder watches, the last release unwatches", () => {
  const { emits, socket } = recordingSocket();
  setAgentReadProgressWatchSocket(() => socket);
  const releaseChannel = acquireAgentReadProgressWatch("channel-1");
  const releaseAgain = acquireAgentReadProgressWatch("channel-1");
  const releaseThread = acquireAgentReadProgressWatch("thread-1");
  assert.deepEqual(emits, [
    [READ_PROGRESS_WATCH_EVENT, { scopeId: "channel-1" }],
    [READ_PROGRESS_WATCH_EVENT, { scopeId: "thread-1" }],
  ]);
  releaseAgain();
  releaseAgain();
  assert.equal(emits.length, 2, "channel-1 is still held; a double release is a no-op");
  assert.equal(isAgentReadProgressWatched("channel-1"), true);
  releaseChannel();
  releaseThread();
  assert.deepEqual(emits.slice(2), [
    [READ_PROGRESS_UNWATCH_EVENT, { scopeId: "channel-1" }],
    [READ_PROGRESS_UNWATCH_EVENT, { scopeId: "thread-1" }],
  ]);
  assert.equal(isAgentReadProgressWatched("channel-1"), false);
});

test("nothing is sent while disconnected; rooms:joined watches every held conversation again", () => {
  const offline = recordingSocket(false);
  setAgentReadProgressWatchSocket(() => offline.socket);
  acquireAgentReadProgressWatch("channel-1");
  assert.deepEqual(offline.emits, []);

  const online = recordingSocket();
  setAgentReadProgressWatchSocket(() => online.socket);
  deferredDetails();
  binding("rooms:joined")(undefined);
  assert.deepEqual(online.emits.filter(([event]) => event === READ_PROGRESS_WATCH_EVENT), [[READ_PROGRESS_WATCH_EVENT, { scopeId: "channel-1" }]]);
});

test("after a reconnect each held conversation's detail loads again, forced: moves made while offline were never sent", async () => {
  useReadReceiptStore.setState({ scopes: { "channel-1": { kind: "peers", peers: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 10 }] } } });
  acquireAgentReadProgressWatch("channel-1");
  acquireAgentReadProgressWatch("thread-1");
  const { socket } = recordingSocket();
  setAgentReadProgressWatchSocket(() => socket);
  const requests = deferredDetails();
  rewatchAgentReadProgress();
  assert.deepEqual(requests.map((request) => request.url), ["/channels/channel-1", "/channels/thread-1"], "even a scope loaded moments ago");
  assert.deepEqual(requests.map((request) => request.reason), ["refresh", "refresh"]);
  requests[0]!.resolve(detail({ "a-1": 30 }));
  await waitForStore(() => {
    const scope = useReadReceiptStore.getState().scopes["channel-1"];
    return scope?.kind === "peers" && scope.peers[0]?.maxReadSeq === 30;
  });
});

test("a frame that arrives while the detail loads is kept and applied when it lands, not dropped", async () => {
  const requests = deferredDetails();
  const loading = useReadReceiptStore.getState().hydrateScope("channel-1");
  const consume = binding(READ_PROGRESS_UPDATED_EVENT);
  consume({ scopeId: "channel-1", peers: [{ peerId: "a-1", maxReadSeq: 40 }, { peerId: "a-9", maxReadSeq: 50 }] });
  consume({ scopeId: "channel-1", peers: [{ peerId: "a-1", maxReadSeq: 35 }] });
  assert.equal("channel-1" in useReadReceiptStore.getState().scopes, false, "nothing shows before the detail");
  requests[0]!.resolve(detail({ "a-1": 20, "a-2": 25 }));
  await loading;
  assert.deepEqual(useReadReceiptStore.getState().scopes["channel-1"], {
    kind: "peers",
    peers: [
      { peerKind: "agent", peerId: "a-1", maxReadSeq: 40 },
      { peerKind: "agent", peerId: "a-2", maxReadSeq: 25 },
    ],
  }, "the highest kept position wins over the older detail; a frame still adds no peer (a-9)");

  // A failed load keeps nothing for later.
  useReadReceiptStore.getState().clearAll();
  const failing = useReadReceiptStore.getState().hydrateScope("channel-2");
  consume({ scopeId: "channel-2", peers: [{ peerId: "a-1", maxReadSeq: 99 }] });
  requests[1]!.reject(new Error("HTTP 500"));
  await failing;
  const retry = useReadReceiptStore.getState().hydrateScope("channel-2");
  requests[2]!.resolve(detail({ "a-1": 5 }));
  await retry;
  assert.deepEqual(useReadReceiptStore.getState().scopes["channel-2"], {
    kind: "peers",
    peers: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 5 }],
  });
});

async function waitForStore(done: () => boolean) {
  for (let attempt = 0; attempt < 50 && !done(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(done(), "the store settled");
}

test("a re-watch sends only the newest conversations the server keeps", () => {
  const { emits, socket } = recordingSocket();
  const held = Array.from({ length: READ_PROGRESS_MAX_WATCHED_SCOPES + 2 }, (_, index) => `scope-${index}`);
  for (const scopeId of held) acquireAgentReadProgressWatch(scopeId);
  setAgentReadProgressWatchSocket(() => socket);
  const requests = deferredDetails();
  rewatchAgentReadProgress();
  assert.equal(requests.length, READ_PROGRESS_MAX_WATCHED_SCOPES, "and only those reload");
  assert.deepEqual(
    emits.map(([, payload]) => (payload as { scopeId: string }).scopeId),
    held.slice(-READ_PROGRESS_MAX_WATCHED_SCOPES),
  );
});

test("a frame moves the hydrated agents forward, and only those", () => {
  const consume = binding(READ_PROGRESS_UPDATED_EVENT);
  const hydrated = {
    kind: "peers" as const,
    peers: [
      { peerKind: "human" as const, peerId: "u-2", maxReadSeq: 5 },
      { peerKind: "agent" as const, peerId: "a-1", maxReadSeq: 10 },
      { peerKind: "agent" as const, peerId: "a-2", maxReadSeq: 30 },
    ],
  };
  useReadReceiptStore.setState({ scopes: { "channel-1": hydrated } });

  consume({ scopeId: "channel-1", peers: [{ peerId: "a-1", maxReadSeq: 20 }, { peerId: "a-2", maxReadSeq: 25 }, { peerId: "a-3", maxReadSeq: 40 }] });
  assert.deepEqual(useReadReceiptStore.getState().scopes["channel-1"], {
    kind: "peers",
    peers: [
      { peerKind: "human", peerId: "u-2", maxReadSeq: 5 },
      { peerKind: "agent", peerId: "a-1", maxReadSeq: 20 },
      { peerKind: "agent", peerId: "a-2", maxReadSeq: 30 },
    ],
  }, "a-1 forward, a-2 never back, a-3 never added");

  const before = useReadReceiptStore.getState().scopes;
  consume({ scopeId: "channel-1", peers: [{ peerId: "a-1", maxReadSeq: 20 }] });
  consume({ scopeId: "channel-2", peers: [{ peerId: "a-1", maxReadSeq: 99 }] });
  consume({ scopeId: "channel-1" });
  assert.equal(useReadReceiptStore.getState().scopes, before, "no move, an unhydrated scope or a bad frame writes nothing");
  assert.equal("channel-2" in useReadReceiptStore.getState().scopes, false, "a frame never creates a scope");
});

test("thread:followers-updated loads a watched thread's detail again; an unwatched one is left alone", () => {
  reset();
  const requests = deferredDetails();
  useReadReceiptStore.setState({
    scopes: {
      "thread-watched": { kind: "peers", peers: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 5 }] },
      "thread-unwatched": { kind: "peers", peers: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 5 }] },
    },
  });
  const release = acquireAgentReadProgressWatch("thread-watched");
  const followersUpdated = binding("thread:followers-updated");

  followersUpdated({ threadChannelId: "thread-unwatched" });
  assert.deepEqual(requests.filter((request) => request.url.startsWith("/channels/thread-")), []);
  followersUpdated({ threadChannelId: "thread-watched" });
  assert.deepEqual(
    requests.filter((request) => request.url.startsWith("/channels/thread-")).map((request) => [request.url, request.reason]),
    [["/channels/thread-watched", "refresh"]],
  );
  release();
});

test("read_progress:detail_changed (an agent muted or unmuted the channel) loads a watched channel's detail again; an unwatched one is left alone", () => {
  reset();
  const requests = deferredDetails();
  useReadReceiptStore.setState({
    scopes: {
      "channel-watched": { kind: "peers", peers: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 5 }] },
      "channel-unwatched": { kind: "peers", peers: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 5 }] },
    },
  });
  const release = acquireAgentReadProgressWatch("channel-watched");
  const detailChanged = binding(READ_PROGRESS_DETAIL_CHANGED_EVENT);
  const channelRequests = () => requests.filter((request) => request.url.startsWith("/channels/channel-"));

  detailChanged({ scopeId: "channel-unwatched" });
  detailChanged({ scopeId: 42 });
  detailChanged(null);
  assert.deepEqual(channelRequests(), []);
  detailChanged({ scopeId: "channel-watched" });
  assert.deepEqual(
    channelRequests().map((request) => [request.url, request.reason]),
    [["/channels/channel-watched", "refresh"]],
  );
  release();
});
