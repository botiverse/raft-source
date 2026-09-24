import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import api from "../src/api/client";
import { useReadReceiptStore } from "../src/store/readReceiptStore";
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
  useReadReceiptStore.setState({ scopes: {} });
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
