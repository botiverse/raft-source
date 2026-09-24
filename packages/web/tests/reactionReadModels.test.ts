import assert from "node:assert/strict";
import { test } from "node:test";

import {
  messageReactionActorsDiscussion,
  messageRef,
} from "@botiverse/raft-shared";
import { createReactionReadModelStore } from "../src/store/reactionReadModels.js";

const serverId = "server-a";
const channelId = "channel-a";
const principalId = "actor-b";
const parentScopeKey = { serverId, scopeKind: "channel", scopeId: channelId };

function discussion(messageId: string, emoji = "👍") {
  return messageReactionActorsDiscussion(messageRef(serverId, messageId), emoji, parentScopeKey);
}

function ingress(messageId: string, source: "channel-room" | "receiver-private" = "receiver-private") {
  return {
    principalId,
    serverId,
    parentScopeKey,
    messageId,
    source,
    viewerUserId: "actor-b",
    reactions: [{
      emoji: "👍",
      count: 2,
      reactorIds: ["actor-b", "actor-a"],
      reactorNames: ["Bee", "Ada"],
    }],
  } as const;
}

function createActivatedStore(options: { capacity?: number } = {}) {
  const store = createReactionReadModelStore(options);
  store.getState().activatePrincipal(principalId);
  return store;
}

test("legacy ingress stores normalized fact, receiver overlay, and actors in separate models", () => {
  const store = createActivatedStore({ capacity: 4 });
  const sharedFact = store.getState().applyLegacyIngress(ingress("message-a"));

  assert.deepEqual(sharedFact, [{
    emoji: "👍",
    count: 2,
    previewK: [],
  }]);
  assert.deepEqual(store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍"), {
    status: "loaded",
    reactedByMe: true,
  });
  const cached = store.getState().readActors(principalId, discussion("message-a"));
  assert.equal(cached.status, "loaded");
  assert.deepEqual(cached.status === "loaded" ? cached.entry.actors : null, [
    { id: "actor-a", displayName: "Ada" },
    { id: "actor-b", displayName: "Bee" },
  ]);
});

test("cache miss remains unknown and channel-room input cannot write viewer overlay", () => {
  const store = createActivatedStore({ capacity: 2 });
  assert.deepEqual(store.getState().readActors(principalId, discussion("missing")), { status: "missing" });
  assert.deepEqual(
    store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍"),
    { status: "unknown" },
  );

  store.getState().applyLegacyIngress(ingress("message-a", "channel-room"));
  assert.deepEqual(
    store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍"),
    { status: "unknown" },
  );
  assert.equal(store.getState().readActors(principalId, discussion("message-a")).status, "loaded");
});

test("receiver-private complete snapshots clear reactions that disappeared from the message", () => {
  const store = createActivatedStore();
  store.getState().applyLegacyIngress(ingress("message-a"));
  assert.equal(
    store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍").status,
    "loaded",
  );

  store.getState().applyLegacyIngress({ ...ingress("message-a"), reactions: [] });
  assert.deepEqual(store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍"), {
    status: "loaded",
    reactedByMe: false,
  });
});

test("malformed receiver-private rosters cannot replace a previously complete overlay", () => {
  const store = createActivatedStore();
  store.getState().applyLegacyIngress(ingress("message-a"));

  store.getState().applyLegacyIngress({
    ...ingress("message-a"),
    reactions: [{
      emoji: "👍",
      count: 2,
      reactorIds: ["actor-b", "actor-b"],
      reactorNames: ["Bee", "Duplicate Bee"],
    }],
  });

  assert.deepEqual(store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍"), {
    status: "loaded",
    reactedByMe: true,
  });
  assert.notEqual(store.getState().normalizationViolations.length, 0);
});

test("bounded cache eviction is explicit and parent-scope invalidation uses its secondary index", () => {
  const store = createActivatedStore({ capacity: 2 });
  store.getState().applyLegacyIngress(ingress("message-a"));
  store.getState().applyLegacyIngress(ingress("message-b"));
  store.getState().applyLegacyIngress(ingress("message-c"));

  assert.deepEqual(store.getState().readActors(principalId, discussion("message-a")), { status: "missing" });
  assert.equal(store.getState().readActors(principalId, discussion("message-b")).status, "loaded");
  assert.equal(store.getState().readActors(principalId, discussion("message-c")).status, "loaded");
  assert.equal(store.getState().actorCache.size, 2);

  store.getState().clearParentScope(principalId, parentScopeKey);
  assert.deepEqual(store.getState().readActors(principalId, discussion("message-b")), { status: "missing" });
  assert.deepEqual(store.getState().readActors(principalId, discussion("message-c")), { status: "missing" });
  assert.equal(store.getState().parentIndex.size, 0);
});

test("an optimistic receiver-private patch may update overlay without inventing actors", () => {
  const store = createActivatedStore();
  store.getState().applyViewerReactionPatch(principalId, serverId, "message-a", "👍", true);

  assert.deepEqual(store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍"), {
    status: "loaded",
    reactedByMe: true,
  });
  assert.deepEqual(store.getState().readActors(principalId, discussion("message-a")), { status: "missing" });
});

test("same-server principal switch cannot inherit another viewer overlay or actor detail", () => {
  const store = createActivatedStore();
  store.getState().applyLegacyIngress(ingress("message-a"));
  assert.equal(
    store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍").status,
    "loaded",
  );

  store.getState().activatePrincipal("actor-c");
  assert.deepEqual(
    store.getState().readViewerOverlay("actor-c", serverId, "message-a", "👍"),
    { status: "unknown" },
  );
  assert.deepEqual(
    store.getState().readActors("actor-c", discussion("message-a")),
    { status: "missing" },
  );
  assert.equal(store.getState().actorCache.size, 0);
});

test("stale principal ingress is rejected without reactivating or mutating the active lane", () => {
  const store = createReactionReadModelStore();
  store.getState().activatePrincipal("actor-a");
  const staged = store.getState().stageLegacyIngress({
    ...ingress("message-a"),
    principalId: "actor-a",
    viewerUserId: "actor-a",
  }).staged;
  store.getState().activatePrincipal("actor-b");
  const before = store.getState();

  assert.throws(
    () => store.getState().applyStagedLegacyIngressBatch([staged]),
    /principal mismatch/,
  );
  const after = store.getState();
  assert.equal(after.activePrincipalId, "actor-b");
  assert.equal(after.viewerOverlay, before.viewerOverlay);
  assert.equal(after.actorCache, before.actorCache);
  assert.equal(after.parentIndex, before.parentIndex);
  assert.equal(after.normalizationViolations, before.normalizationViolations);
});

test("thread actor detail uses the true local thread parent scope key", () => {
  const store = createActivatedStore();
  const threadScope = { serverId, scopeKind: "thread", scopeId: "thread-a" } as const;
  store.getState().applyLegacyIngress({
    ...ingress("message-thread"),
    parentScopeKey: threadScope,
  });

  const threadDiscussion = messageReactionActorsDiscussion(
    messageRef(serverId, "message-thread"),
    "👍",
    threadScope,
  );
  assert.equal(store.getState().readActors(principalId, threadDiscussion).status, "loaded");
  assert.deepEqual(
    store.getState().readActors(principalId, discussion("message-thread")),
    { status: "missing" },
  );
});

test("versioned complete viewer snapshots drop older and fail-stop equal-different payloads", () => {
  const store = createReactionReadModelStore();
  store.getState().activatePrincipal(principalId);
  assert.deepEqual(store.getState().applyVersionedViewerOverlaySnapshot(principalId, {
    serverId,
    messageId: "message-a",
    viewerVersion: 2,
    reactedEmojis: ["👍"],
  }), { kind: "applied" });
  assert.deepEqual(store.getState().applyVersionedViewerOverlaySnapshot(principalId, {
    serverId,
    messageId: "message-a",
    viewerVersion: 1,
    reactedEmojis: [],
  }), { kind: "stale" });
  assert.deepEqual(store.getState().applyVersionedViewerOverlaySnapshot(principalId, {
    serverId,
    messageId: "message-a",
    viewerVersion: 2,
    reactedEmojis: [],
  }), { kind: "conflict", reason: "equal-version-different-payload" });
  assert.deepEqual(
    store.getState().readViewerOverlay(principalId, serverId, "message-a", "👍"),
    { status: "loaded", reactedByMe: true },
  );
  assert.equal(store.getState().viewerSnapshotConflicts.length, 1);
});
