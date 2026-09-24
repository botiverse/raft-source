import assert from "node:assert/strict";
import test from "node:test";
import {
  mergePeerReadAdvance,
  mergeReadReceiptHydrate,
  normalizeReadReceiptHydrate,
  normalizeScopeReadUpdated,
  projectReadReceipt,
} from "../src/store/readReceiptDomain";
import type {
  ReadReceiptScope,
} from "../src/store/readReceiptDomain";

test("bounded peer hydrate normalizes and projects message read state", () => {
  const scope = normalizeReadReceiptHydrate({
    peerReadStates: [
      { peerKind: "human", peerId: "u-2", maxReadSeq: 12 },
      { peerKind: "agent", peerId: "a-1", maxReadSeq: 8 },
    ],
  });
  assert.deepEqual(projectReadReceipt(scope ?? undefined, 9), {
    read: true,
    readCount: 1,
    peerCount: 2,
  });
  assert.deepEqual(projectReadReceipt(scope ?? undefined, 13), {
    read: false,
    readCount: 0,
    peerCount: 2,
  });
  assert.equal(normalizeReadReceiptHydrate({ peerReadStates: [
    { peerKind: "human", peerId: "u-2", maxReadSeq: 1 },
    { peerKind: "human", peerId: "u-2", maxReadSeq: 2 },
  ] }), null);
  assert.equal(normalizeReadReceiptHydrate({
    peerReadStates: [],
    peerReadSummary: { peerCount: 0, readCountAtSeq: [] },
  }), null);
});

test("anonymous summary projects counts without peer identity", () => {
  const scope = normalizeReadReceiptHydrate({
    peerReadSummary: {
      peerCount: 3,
      readCountAtSeq: [
        { seq: 4, count: 3 },
        { seq: 10, count: 2 },
        { seq: 15, count: 1 },
      ],
    },
  });
  assert.deepEqual(projectReadReceipt(scope ?? undefined, 1), { read: true, readCount: 3, peerCount: 3 });
  assert.deepEqual(projectReadReceipt(scope ?? undefined, 7), { read: true, readCount: 2, peerCount: 3 });
  assert.deepEqual(projectReadReceipt(scope ?? undefined, 16), { read: false, readCount: 0, peerCount: 3 });
  assert.equal(normalizeReadReceiptHydrate({
    peerReadSummary: { peerCount: 3, readCountAtSeq: [{ seq: 4, count: 2 }, { seq: 10, count: 3 }] },
  }), null);
});

test("peer realtime advances monotonically and unknown peers cannot expand hydrate", () => {
  const scope: ReadReceiptScope = {
    kind: "peers",
    peers: [{ peerKind: "human", peerId: "u-2", maxReadSeq: 10 }],
  };
  const advance = normalizeScopeReadUpdated({
    scopeId: "channel-1",
    peerKind: "human",
    peerId: "u-2",
    maxReadSeq: 14,
  });
  assert.ok(advance && !("summaryChanged" in advance));
  const advanced = mergePeerReadAdvance(scope, advance);
  assert.equal(advanced?.kind, "peers");
  assert.equal(advanced?.kind === "peers" ? advanced.peers[0].maxReadSeq : 0, 14);

  const stale = { ...advance, maxReadSeq: 9 };
  assert.equal(mergePeerReadAdvance(advanced, stale), advanced);
  assert.equal(mergePeerReadAdvance(advanced, { ...advance, peerId: "hidden-peer" }), advanced);
});

test("hydrate cannot roll back a peer advance that raced its response", () => {
  const current: ReadReceiptScope = {
    kind: "peers",
    peers: [{ peerKind: "human", peerId: "u-2", maxReadSeq: 14 }],
  };
  const staleHydrate: ReadReceiptScope = {
    kind: "peers",
    peers: [{ peerKind: "human", peerId: "u-2", maxReadSeq: 10 }],
  };
  assert.deepEqual(mergeReadReceiptHydrate(current, staleHydrate), current);
});

test("flag-off or malformed hydrate has no projection", () => {
  assert.equal(normalizeReadReceiptHydrate({ id: "channel-1" }), null);
  assert.equal(normalizeScopeReadUpdated({ scopeId: "channel-1", summaryChanged: false }), null);
  assert.deepEqual(projectReadReceipt(undefined, 10), { read: false, readCount: 0, peerCount: 0 });
  assert.deepEqual(projectReadReceipt({ kind: "peers", peers: [] }, undefined), {
    read: false,
    readCount: 0,
    peerCount: 0,
  });
});
