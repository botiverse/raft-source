// The production entry point must actually reach the shadow consumer (#364 P1).
//
// Two rounds shipped a consumer, then a host, each with a header comment saying
// it "runs as a shadow consumer" while nothing in production referenced it. A
// test that constructs its own host proves only that the module CAN run.
//
// So these teeth drive the real production entry point (inboxStore.loadInbox)
// and observe whether the Activity sync endpoints get hit. Behavioural, not
// source-matching: a wiring that is deleted stops issuing the request.
import assert from "node:assert/strict";
import test from "node:test";
import api from "../src/api/client";

const originalGet = api.get.bind(api);

test.afterEach(async () => {
  api.get = originalGet;
  const { resetActivityRuntimeForTests } = await import("../src/store/activityPanel/runtime");
  resetActivityRuntimeForTests();
});

/** Record every GET the app issues, and answer them plausibly. */
function captureGets() {
  const urls: string[] = [];
  api.get = (async (url: string) => {
    urls.push(url);
    if (url === "/channels/inbox") {
      return { data: { items: [], totalCount: 0, hasMore: false } };
    }
    return { data: {} };
  }) as typeof api.get;
  return urls;
}

test("W1 gate OFF: the production load issues no Activity sync request at all", async () => {
  // Unconfigured builds must pay nothing — no fetch, no core, no cost.
  const { useInboxStore } = await import("../src/store/inboxStore");
  const urls = captureGets();

  await useInboxStore.getState().loadInbox({ reset: true });

  assert.ok(urls.includes("/channels/inbox"), "the real inbox load must still happen");
  assert.equal(
    urls.filter((u) => u.startsWith("/channels/activity/")).length,
    0,
    `gate off must not touch the Activity sync endpoints, got ${JSON.stringify(urls)}`,
  );
});

const SCOPE = {
  serverId: "server-1", principalId: "user-1", filter: "all", windowId: "main",
} as const;

function row(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "row-1", rowVersion: "2", latestActivitySeq: "42",
    lastActivityAt: "2026-07-30T00:00:00.000Z", unreadCount: 3, hasMention: false,
    firstUnreadMessageId: null, firstMentionMessageId: null, maxReadSeq: "10",
    readStateVersion: "1", type: "channel", channelId: "channel-1",
    channelName: "general", channelKind: "channel", lastMessageId: "m-1",
    lastMessagePreview: "hi", lastMessageSenderKind: "user",
    lastMessageSenderId: "user-2", lastMessageSenderName: "Peer", ...overrides,
  };
}

/** A contract-VALID snapshot, so the payload can actually reach the fold. */
function validSnapshot(requestId: string, watermark = "5") {
  return {
    type: "snapshot", requestId, scope: SCOPE, epoch: "1", watermark,
    activityVersion: "7",
    window: {
      rows: [row()], tombstones: [], nextCursor: null, hasMore: false,
      complete: true, totalCount: 1, totalUnreadCount: 3,
    },
  };
}

test("W2 gate SHADOW: a valid snapshot from the production load reaches the CORE", async () => {
  // The previous version of this tooth returned `{}` from the fetch, so it only
  // proved a URL was requested — the body failed validation and nothing ever
  // reached the core. Asserting the request was the observable effect; the
  // property is that folded state exists afterwards.
  const { useInboxStore } = await import("../src/store/inboxStore");
  const { setActivityGateForTests, activityWindowAuthority } =
    await import("../src/store/activityPanel/runtime");
  setActivityGateForTests("on");

  const urls: string[] = [];
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    urls.push(url);
    if (url === "/channels/activity/snapshot") {
      return { data: validSnapshot(config?.params?.requestId ?? "x") };
    }
    if (url === "/channels/inbox") {
      return { data: { items: [], totalCount: 0, hasMore: false } };
    }
    return { data: {} };
  }) as typeof api.get;

  await useInboxStore.getState().loadInbox({ reset: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(urls.includes("/channels/activity/snapshot"), "the endpoint must be hit");
  const scopeId = JSON.stringify([
    SCOPE.serverId, SCOPE.principalId, SCOPE.filter, SCOPE.windowId,
  ]);
  const verdict = activityWindowAuthority(scopeId);
  assert.equal(
    verdict.authority,
    "core",
    `the folded window must exist in the core, got ${JSON.stringify(verdict)}`,
  );
  assert.equal((verdict as { totalUnreadCount: number }).totalUnreadCount, 3);
});

test("W2b a SUPERSEDED bootstrap response cannot overwrite the newer window", async () => {
  // Issuance order, not receipt order. Two concurrent bootstraps whose responses
  // arrive reversed: registering correlation on receipt would let the older
  // response register itself as newest and replace the whole window.
  const { setActivityGateForTests, observeActivityBootstrap, activityWindowAuthority } =
    await import("../src/store/activityPanel/runtime");
  setActivityGateForTests("on");

  const gates: Array<() => void> = [];
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    const requestId = config?.params?.requestId ?? "x";
    // Hold the FIRST response open so the second completes first.
    //
    // The stale response carries a DIFFERENT EPOCH deliberately. The core drops a
    // stale SAME-epoch snapshot on its own (watermark <= appliedSeq is a
    // comparison no-op), so same-epoch cannot discriminate — its own comment
    // says "Cross-epoch snapshots may lower the watermark: that is a
    // rebaseline". Cross-epoch is precisely the axis the core deliberately
    // leaves open and the issuance fence has to cover.
    if (requestId.endsWith("1")) {
      await new Promise<void>((resolve) => gates.push(resolve));
      return { data: { ...validSnapshot(requestId, "1"), epoch: "2" } };
    }
    return { data: validSnapshot(requestId, "9") };
  }) as typeof api.get;

  const first = observeActivityBootstrap();
  const second = observeActivityBootstrap();
  await second;
  gates.forEach((release) => release());
  await first;

  const scopeId = JSON.stringify([
    SCOPE.serverId, SCOPE.principalId, SCOPE.filter, SCOPE.windowId,
  ]);
  const verdict = activityWindowAuthority(scopeId);
  assert.equal(verdict.authority, "core");
  // The DISCRIMINATING value is the applied watermark: the stale first response
  // carried 1, the newer carried 9. Asserting activityVersion could not tell
  // them apart — both responses set it to "7" — so the earlier form of this
  // assertion stayed green under the very reordering it was meant to catch.
  const { getActivityShadowAppliedSeqForTests } =
    await import("../src/store/activityPanel/runtime");
  assert.equal(
    getActivityShadowAppliedSeqForTests(scopeId),
    9n,
    "the newer response's watermark must survive; a stale one must not rebaseline backwards",
  );
});

test("W2c a REAL server reset drops both the bound runtime scope and its bridge snapshot", async () => {
  const {
    activityWindowForBoundScope,
    getActivityShadowVersion,
    observeActivityBootstrap,
    setActivityGateForTests,
  } = await import("../src/store/activityPanel/runtime");
  const { triggerServerReset } = await import("../src/store/serverResetRegistry");
  setActivityGateForTests("on");

  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      return { data: validSnapshot(config?.params?.requestId ?? "x") };
    }
    return { data: {} };
  }) as typeof api.get;

  await observeActivityBootstrap();
  assert.equal(activityWindowForBoundScope().authority, "core");
  assert.equal(getActivityShadowVersion(), "5");

  // Drive the same registry that serverStore uses. Resetting only the thin
  // bridge would hide the primitive but leave the old Core/active scope able
  // to answer a visible-authority query after the server identity changed.
  triggerServerReset();

  assert.deepEqual(activityWindowForBoundScope(), {
    authority: "legacy",
    reason: "scope_absent",
  });
  assert.equal(getActivityShadowVersion(), null);
});

test("W3 a shadow fetch failure never propagates, with the gate actually OPEN", async () => {
  // The previous version ran with the gate off, so the failure path was never
  // exercised at all — it asserted nothing.
  const { useInboxStore } = await import("../src/store/inboxStore");
  const { setActivityGateForTests } = await import("../src/store/activityPanel/runtime");
  setActivityGateForTests("shadow");

  let activityAttempted = false;
  api.get = (async (url: string) => {
    if (url.startsWith("/channels/activity/")) {
      activityAttempted = true;
      throw new Error("shadow boom");
    }
    if (url === "/channels/inbox") {
      return { data: { items: [], totalCount: 0, hasMore: false } };
    }
    return { data: {} };
  }) as typeof api.get;

  await useInboxStore.getState().loadInbox({ reset: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(activityAttempted, true, "the shadow must actually have tried and failed");
  assert.equal(useInboxStore.getState().loading, false, "the panel load must still complete");
});

test("W4 the cutover gate is fail-closed", async () => {
  const { resolveActivityCutoverGate } = await import("../src/store/activityPanel/host");
  for (const raw of [undefined, null, "", "  ", "OFF", "on!", "enabled", "true"]) {
    assert.equal(
      resolveActivityCutoverGate(raw as string | undefined),
      "off",
      `gate(${JSON.stringify(raw)}) must be off`,
    );
  }
  assert.equal(resolveActivityCutoverGate("shadow"), "shadow");
  assert.equal(resolveActivityCutoverGate(" ON "), "on");
});

test("W6 a real socket event drives the canonical snapshot repair into the Core", async () => {
  // The single production chain, per @赵梓淇: rooms:joined -> loadInboxReset ->
  // loadInbox({reset:true}) -> observeActivityBootstrap -> canonical
  // /activity/snapshot -> generated validate -> correlate -> Core accept/settle.
  //
  // My earlier reading of "W6 stays green when the wake is deleted" was that the
  // wake needed to do more work. The correct reading was that the wake was
  // REDUNDANT — this leg already covers the socket signal — so the wake was dead
  // code and a second active-difference authority would have expanded the Sync
  // Core surface for nothing.
  const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
  const { setActivityGateForTests, getActivityShadowAppliedSeqForTests } =
    await import("../src/store/activityPanel/runtime");
  setActivityGateForTests("on");

  const snapshotRequestIds: string[] = [];
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    const requestId = config?.params?.requestId ?? "x";
    if (url === "/channels/activity/snapshot") {
      snapshotRequestIds.push(requestId);
      return { data: validSnapshot(requestId, "5") };
    }
    return { data: { items: [], totalCount: 0, hasMore: false, threads: [] } };
  }) as typeof api.get;

  const socket = {
    connected: true, emit: () => undefined, on: () => undefined,
    off: () => undefined, onAny: () => undefined, offAny: () => undefined,
    disconnect: () => undefined, connect: () => undefined,
  };
  const bindings = buildMainLayoutSocketBindings(
    socket as never,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const roomsJoined = bindings.find((b) => b.event === "rooms:joined");
  assert.ok(roomsJoined, "the production binding must exist");

  const scopeId = JSON.stringify([
    SCOPE.serverId, SCOPE.principalId, SCOPE.filter, SCOPE.windowId,
  ]);
  roomsJoined!.handler({} as never);
  for (let i = 0; i < 20 && getActivityShadowAppliedSeqForTests(scopeId) === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(
    snapshotRequestIds.length, 1,
    `the socket event must issue exactly one canonical snapshot, got ${JSON.stringify(snapshotRequestIds)}`,
  );
  assert.ok(
    snapshotRequestIds[0].startsWith("web-activity-"),
    `it must carry a freshly issued requestId, got ${snapshotRequestIds[0]}`,
  );
  // Accepted, settled and folded — not merely requested.
  assert.equal(
    getActivityShadowAppliedSeqForTests(scopeId), 5n,
    "the snapshot must reach the Core and settle its own request",
  );
});
