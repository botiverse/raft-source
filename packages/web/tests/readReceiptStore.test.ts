import assert from "node:assert/strict";
import api from "../src/api/client";
import { CHANNEL_DETAIL_REASON_HEADER } from "../src/store/channelDetailReason";
import { SHARED_DETAIL_MS, useReadReceiptStore } from "../src/store/readReceiptStore";
import { useServerStore } from "../src/store/serverStore";

const originalGet = api.get.bind(api);

function setCurrentServer() {
  useServerStore.setState((state) => ({
    ...state,
    current: { id: "server-1" } as typeof state.current,
    serverEpoch: 1,
  }));
}

afterEach(() => {
  api.get = originalGet;
  // Also forgets freshness and offered detail, so no test reuses another's load.
  useReadReceiptStore.getState().clearAll();
});

test("flag-off detail keeps receipt state absent", async () => {
  setCurrentServer();
  api.get = (async () => ({ data: { id: "channel-1" } })) as typeof api.get;

  await useReadReceiptStore.getState().hydrateScope("channel-1");

  assert.deepEqual(useReadReceiptStore.getState().scopes, {});
});

test("clearing a disabled scope removes any previously projected receipt UI state", () => {
  useReadReceiptStore.setState({
    scopes: {
      "channel-1": {
        kind: "peers",
        peers: [{ peerKind: "human", peerId: "user-2", maxReadSeq: 8 }],
      },
    },
  });
  useReadReceiptStore.getState().clearScope("channel-1");
  assert.deepEqual(useReadReceiptStore.getState().scopes, {});
});

test("store consumes only monotonic updates for canonically hydrated peers", async () => {
  setCurrentServer();
  api.get = (async () => ({
    data: {
      peerReadStates: [{ peerKind: "human", peerId: "user-2", maxReadSeq: 8 }],
    },
  })) as typeof api.get;
  await useReadReceiptStore.getState().hydrateScope("channel-1");

  const hydrated = useReadReceiptStore.getState().scopes;
  useReadReceiptStore.getState().consumeScopeUpdated({
    scopeId: "channel-1",
    peerKind: "human",
    peerId: "user-2",
    maxReadSeq: 7,
  });
  assert.equal(useReadReceiptStore.getState().scopes, hydrated);

  useReadReceiptStore.getState().consumeScopeUpdated({
    scopeId: "channel-1",
    peerKind: "human",
    peerId: "user-2",
    maxReadSeq: 12,
  });
  const scope = useReadReceiptStore.getState().scopes["channel-1"];
  assert.equal(scope.kind, "peers");
  assert.equal(scope.kind === "peers" ? scope.peers[0].maxReadSeq : 0, 12);

  useReadReceiptStore.getState().consumeScopeUpdated({
    scopeId: "not-hydrated",
    peerKind: "human",
    peerId: "hidden-user",
    maxReadSeq: 99,
  });
  assert.equal(useReadReceiptStore.getState().scopes["not-hydrated"], undefined);
});

test("anonymous summaryChanged refreshes canonical detail without learning identities", async () => {
  setCurrentServer();
  let requestCount = 0;
  api.get = (async () => {
    requestCount += 1;
    return {
      data: {
        peerReadSummary: {
          peerCount: 60,
          readCountAtSeq: [{ seq: 10 + requestCount, count: 1 }],
        },
      },
    };
  }) as typeof api.get;
  await useReadReceiptStore.getState().hydrateScope("channel-1");

  useReadReceiptStore.getState().consumeScopeUpdated({
    scopeId: "channel-1",
    summaryChanged: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requestCount, 2);
  const scope = useReadReceiptStore.getState().scopes["channel-1"];
  assert.equal(scope.kind, "summary");
  assert.deepEqual(scope.kind === "summary" ? scope.summary.readCountAtSeq : [], [
    { seq: 12, count: 1 },
  ]);
  assert.equal(JSON.stringify(scope).includes("peerId"), false);
});

test("re-opening a loaded scope inside the fresh window does not fetch it again; a reconnect or summaryChanged does", async () => {
  setCurrentServer();
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return { data: { peerReadStates: [{ peerKind: "human", peerId: "user-2", maxReadSeq: 8 }] } };
  }) as typeof api.get;
  const store = useReadReceiptStore.getState();
  await store.hydrateScope("thread-fresh");
  await store.hydrateScope("thread-fresh");
  assert.equal(calls, 1, "a re-open reuses the loaded scope (scope events keep it current)");

  store.forgetFreshness();
  await store.hydrateScope("thread-fresh");
  assert.equal(calls, 2, "after a reconnect the next open loads again");

  await store.hydrateScope("thread-fresh", { force: true });
  assert.equal(calls, 3, "force (summaryChanged) always loads");

  store.clearScope("thread-fresh");
  await store.hydrateScope("thread-fresh");
  assert.equal(calls, 4, "a cleared scope loads again");

  store.forgetScopeFreshness("thread-fresh");
  await store.hydrateScope("thread-fresh");
  assert.equal(calls, 5, "a thread that left its room (closed) loads again on its next open");
});

test("a scope without receipts is fresh too: re-opening it does not ask again", async () => {
  setCurrentServer();
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return { data: { id: "thread-under-all" } };
  }) as typeof api.get;
  const store = useReadReceiptStore.getState();
  await store.hydrateScope("thread-under-all");
  await store.hydrateScope("thread-under-all");
  assert.equal(calls, 1);
  assert.deepEqual(useReadReceiptStore.getState().scopes, {});
});

test("the detail ensureChannel just loaded is taken instead of asking again, unless forced or old", async () => {
  setCurrentServer();
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return { data: { peerReadStates: [{ peerKind: "human", peerId: "user-2", maxReadSeq: 9 }] } };
  }) as typeof api.get;
  const store = useReadReceiptStore.getState();
  const detail = { peerReadStates: [{ peerKind: "human", peerId: "user-2", maxReadSeq: 8 }] };

  store.offerChannelDetail("channel-offered", detail);
  await store.hydrateScope("channel-offered");
  assert.equal(calls, 0, "the offered answer is used");
  assert.ok(useReadReceiptStore.getState().scopes["channel-offered"]);

  store.forgetFreshness();
  store.offerChannelDetail("channel-offered", detail);
  await store.hydrateScope("channel-offered", { force: true });
  assert.equal(calls, 1, "summaryChanged asks the server");

  store.forgetFreshness();
  store.offerChannelDetail("channel-offered", detail);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + SHARED_DETAIL_MS + 1);
  await store.hydrateScope("channel-offered");
  assert.equal(calls, 2, "an offer older than SHARED_DETAIL_MS is not used");
});

test("detail requests say why they were made", async () => {
  setCurrentServer();
  const reasons: unknown[] = [];
  api.get = (async (_url: string, config?: { headers?: Record<string, unknown> }) => {
    reasons.push(config?.headers?.[CHANNEL_DETAIL_REASON_HEADER]);
    return { data: { peerReadStates: [] } };
  }) as typeof api.get;
  const store = useReadReceiptStore.getState();
  await store.hydrateScope("channel-reason");
  await store.hydrateScope("channel-reason", { force: true });
  assert.deepEqual(reasons, ["receipts", "summary_changed"]);
});

test("a follower change reloads a per-peer scope, after any load in flight, and leaves the rest alone", async () => {
  setCurrentServer();
  const answers: Array<(value: unknown) => void> = [];
  const reasons: unknown[] = [];
  api.get = ((_url: string, config?: { headers?: Record<string, unknown> }) => {
    reasons.push(config?.headers?.[CHANNEL_DETAIL_REASON_HEADER]);
    return new Promise((resolve) => { answers.push(resolve); });
  }) as typeof api.get;
  const stopped = { data: { peerReadStates: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 3, stoppedFollowing: true }] } };
  const following = { data: { peerReadStates: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 3 }] } };
  const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const store = useReadReceiptStore.getState();

  store.refreshFollowState("thread-unknown");
  await flush();
  assert.equal(answers.length, 0, "a scope this tab never loaded is not loaded for it");

  const first = store.hydrateScope("thread-1");
  store.refreshFollowState("thread-1");
  store.refreshFollowState("thread-1");
  await flush();
  assert.equal(answers.length, 1, "waits for the load in flight, which may have read before the change");
  answers[0]!(stopped);
  await first;
  await flush();
  assert.equal(answers.length, 2, "one reload for both events");
  answers[1]!(following);
  await flush();
  assert.deepEqual(useReadReceiptStore.getState().scopes["thread-1"], {
    kind: "peers",
    peers: [{ peerKind: "agent", peerId: "a-1", maxReadSeq: 3 }],
  });
  assert.deepEqual(reasons, ["receipts", "refresh"]);

  useReadReceiptStore.setState({
    scopes: { "thread-big": { kind: "summary", summary: { peerCount: 60, readCountAtSeq: [] } } },
  });
  store.refreshFollowState("thread-big");
  await flush();
  assert.equal(answers.length, 2, "a summary scope shows no agent to update");
});
