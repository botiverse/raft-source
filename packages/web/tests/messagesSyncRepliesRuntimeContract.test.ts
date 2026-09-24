import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { afterEach } from "node:test";
import {
  CANONICAL_NESTED_WIRE_SHAPES,
} from "../../shared/src/canonicalMessageManifest.js";
import {
  DISCUSSION_RELATION_REGISTRY,
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
  messageRef,
  messageRepliesDiscussion,
  syncScopeWindow,
} from "../../shared/src/discussionGraph.js";
import vectors from "@botiverse/raft-shared/src/testVectors/messageRepliesDiscussionGraph.vectors.json" with { type: "json" };
import {
  applyThreadReplyFrame,
  hydrateThreadRepliesScope,
} from "../src/store/threadRepliesReadModel";
import type {
  ThreadReplyPreview,
} from "../src/store/threadRepliesReadModel";
import {
  consumeThreadUpdatedWithSyncCore,
  hydrateThreadRepliesRebaselineSnapshotWithSyncCore,
  hydrateThreadRepliesSnapshotWithSyncCore,
  readThreadRepliesSyncCoreScopeForTests,
  releaseThreadRepliesRebaselineRequest,
  resetThreadRepliesSyncCoreForTests,
} from "../src/store/threadRepliesSyncDomain";
import {
  captureReceiverPrivateIngressContext,
  useMessageStore,
} from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function assertSourceMatches(source: string, pattern: RegExp, message: string): void {
  assert.equal(pattern.test(source), true, message);
}

function assertSourceDoesNotMatch(source: string, pattern: RegExp, message: string): void {
  assert.equal(pattern.test(source), false, message);
}

function reply(seq: number, overrides: Partial<ThreadReplyPreview> = {}): ThreadReplyPreview {
  return {
    messageId: `reply-${seq}`,
    seq,
    preview: `reply ${seq}`,
    senderId: "user-1",
    senderType: "user",
    senderName: "Ada",
    senderAvatarUrl: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function threadUpdatedPayload(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replyCount: seq,
    lastReplyAt: `2026-07-13T00:00:${String(seq).padStart(2, "0")}.000Z`,
    participantIds: [`user-${seq}`],
    latestReply: {
      id: `reply-${seq}`,
      seq,
      content: `reply ${seq}`,
      senderId: "user-2",
      senderType: "user",
      senderName: "Ben",
      senderAvatarUrl: null,
      createdAt: "2026-07-13T00:00:00.000Z",
    },
    ...overrides,
  };
}

function canonicalThreadUpdatedPayload(seq: number, epoch = "epoch-1", overrides: Record<string, unknown> = {}) {
  const base = threadUpdatedPayload(seq);
  return threadUpdatedPayload(seq, {
    latestReply: {
      ...base.latestReply,
      conversationContext: {
        channelType: "thread",
        parentMessageId: "parent-1",
        parentChannelId: "channel-1",
        parentChannelType: "channel",
      },
    },
    syncCoreReplyWindow: {
      producer: MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
      discussion: messageRepliesDiscussion(
        messageRef("server-1", "parent-1"),
        { serverId: "server-1", scopeKind: "channel", scopeId: "channel-1" },
      ),
      window: syncScopeWindow({ epoch }),
    },
    ...overrides,
  });
}

function receiverContext(input: {
  principalId?: string | null;
  generation?: number;
} = {}) {
  return {
    serverId: "server-1",
    principalId: input.principalId ?? "user-1",
    ingressContext: {
      ...captureReceiverPrivateIngressContext(input.principalId ?? "user-1"),
      ...(input.generation === undefined ? {} : { generation: input.generation }),
    },
  };
}

function setCurrentServerForContract() {
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "owner-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "member",
      createdAt: "2026-07-13T00:00:00.000Z",
    },
  });
}

afterEach(() => {
  resetThreadRepliesSyncCoreForTests();
  useMessageStore.getState().setCurrentUserId(null);
  useServerStore.setState({ current: null });
});

function nestedFieldNames(shape: readonly { name: string }[]): string[] {
  return shape.map((field) => field.name).sort();
}

function requiredNestedFieldNames(shape: readonly { name: string; optionalKey?: true }[]): string[] {
  return shape
    .filter((field) => !field.optionalKey)
    .map((field) => field.name)
    .sort();
}

test("replies/commentRef neutral vector skeleton keeps message commentRef separate from the replies graph", () => {
  assert.equal(vectors.contract, "message-replies-discussion-graph-v0-draft");
  assert.equal(vectors.canonicalBytesFrozen, false, "HanXin M2 must ack before Web freezes bytes");
  assert.ok(Array.isArray(vectors.cases));
  assert.ok(vectors.cases.length >= 2);

  assert.deepEqual(DISCUSSION_RELATION_REGISTRY.messageReplies, {
    rootKind: "message",
    relation: "replies",
    backing: "sync-scope",
    consistency: "sync-scope-window",
    provenance: { replyCount: "shared-parent-fold" },
    invalidation: "own-scope-rebaseline",
    allowedCommands: ["reply"],
  });

  for (const vectorCase of vectors.cases) {
    assert.deepEqual(
      vectorCase.discussion,
      messageRepliesDiscussion(
        messageRef(vectorCase.discussion.root.serverId, vectorCase.discussion.root.id),
        vectorCase.discussion.parentScopeKey,
      ),
      "vector discussion must serialize the shared MessageRepliesDiscussion factory shape",
    );
    assert.deepEqual(
      vectorCase.window,
      syncScopeWindow({
        scopeCursor: vectorCase.window.scopeCursor,
        epoch: vectorCase.window.epoch,
      }),
      "vector window must serialize the shared SyncScopeWindow factory shape",
    );
    assert.equal(Object.hasOwn(vectorCase.window, "principalId"), false);
    assert.ok(vectorCase.receiverPartition.principalId);
    assert.ok(vectorCase.replyWindow);
    assert.ok(Object.hasOwn(vectorCase.replyWindow, "historyLimited"));
    assert.ok(!Object.hasOwn(vectorCase.replyWindow, "commentRef"));
    assert.ok(Object.hasOwn(vectorCase, "messageProjection"));
    assert.ok(Object.hasOwn(vectorCase.messageProjection, "commentRef"));
    assert.equal(Object.hasOwn(vectorCase, "messageFact"), false);
    const commentRef = vectorCase.messageProjection.commentRef;
    if (commentRef) {
      assert.deepEqual(
        Object.keys(commentRef).sort(),
        nestedFieldNames(CANONICAL_NESTED_WIRE_SHAPES.commentRef),
        "commentRef projection keys must come from the canonical nested wire shape",
      );
      if (commentRef.hostSource) {
        const allowedHostSourceKeys = nestedFieldNames(CANONICAL_NESTED_WIRE_SHAPES.commentRefHostSource);
        const requiredHostSourceKeys = requiredNestedFieldNames(CANONICAL_NESTED_WIRE_SHAPES.commentRefHostSource);
        const hostSourceKeys = Object.keys(commentRef.hostSource).sort();
        assert.deepEqual(
          hostSourceKeys.filter((key) => !allowedHostSourceKeys.includes(key)),
          [],
          "commentRef.hostSource must not invent keys outside the canonical nested wire shape",
        );
        assert.deepEqual(
          requiredHostSourceKeys.filter((key) => !hostSourceKeys.includes(key)),
          [],
          "commentRef.hostSource must include every non-optional canonical nested key",
        );
      }
    }
  }
});

test("sync-core replies runtime: eligible thread updates have no rollout gate or legacy direct authority", () => {
  const socketBridge = readSource("src/store/socketBridge.ts");
  const replyDomain = readSource("src/store/threadRepliesSyncDomain.ts");

  assertSourceMatches(
    socketBridge,
    /consumeThreadUpdatedWithSyncCore\(/,
    "thread:updated must enter the replies Sync Core consumer before mutating reply scope or summaries",
  );
  assertSourceDoesNotMatch(
    socketBridge,
    /InlineThreadRepliesFlag|inline_thread_replies_v0/,
    "inline replies are the default surface; runtime authority must not depend on a retired second flag",
  );
  assertSourceDoesNotMatch(
    replyDomain,
    /syncCoreMessagesEnabled|isSyncCoreMessagesFlagEnabled|flag_off/,
    "the replies domain must ship without inheriting the broader messages rollout gate",
  );
});

test("sync-core replies runtime: pure consumer fail-opens ineligible wire and strictly applies eligible wire", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  const ineligible = consumeThreadUpdatedWithSyncCore(
    threadUpdatedPayload(2),
    receiverContext(),
  );
  assert.equal(ineligible.kind, "shadow_fail_open");
  assert.equal(ineligible.frame?.reply.seq, 2);

  const strict = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(3),
    receiverContext(),
  );
  assert.equal(strict.kind, "applied");
  if (strict.kind !== "applied") throw new Error("expected strict apply");
  assert.deepEqual(strict.scope.replies.map((item) => item.seq), [3]);
  assert.equal(strict.scope.replyCount, 3);

  const sharedShapeWithoutProducer = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(4, "epoch-1", {
      syncCoreReplyWindow: {
        discussion: messageRepliesDiscussion(
          messageRef("server-1", "parent-1"),
          { serverId: "server-1", scopeKind: "channel", scopeId: "channel-1" },
        ),
        window: syncScopeWindow({ epoch: "epoch-1" }),
      },
    }),
    receiverContext(),
  );
  assert.equal(sharedShapeWithoutProducer.kind, "shadow_fail_open");
  assert.equal(sharedShapeWithoutProducer.frame?.reply.seq, 4);

  const selfAssertingEnvelope = consumeThreadUpdatedWithSyncCore(
    threadUpdatedPayload(5, {
      syncCoreReplyWindow: {
        producer: "message-replies-window",
        canonicalFactSoleApplyEligible: true,
        epoch: "epoch-1",
        parentChannelId: "channel-1",
      },
    }),
    receiverContext(),
  );
  assert.equal(selfAssertingEnvelope.kind, "shadow_fail_open");
  assert.equal(selfAssertingEnvelope.frame?.reply.seq, 5);
});

test("bundled latest-three snapshot repairs a live first-frame one-row baseline", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  // The socket can deliver the first reply before the initial channel page.
  // A sparse scope currently adopts that one frame as its baseline. The later
  // HTTP snapshot has the same watermark but contains the required latest 3;
  // it must still replace the incomplete one-row baseline.
  const live = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(221, "epoch-1"),
    receiverContext(),
  );
  assert.equal(live.kind, "applied");
  if (live.kind !== "applied") throw new Error("expected initial frame to apply");

  const snapshot = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(219), reply(220), reply(221)],
    replyCount: 221,
    historyLimited: false,
    watermark: 221,
    epoch: null,
  });

  assert.equal(snapshot.scope?.replies.length, 3);
  assert.deepEqual(snapshot.scope?.replies.map((item) => item.seq), [219, 220, 221]);

  const staleSnapshot = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(221)],
    replyCount: 221,
    historyLimited: false,
    watermark: 221,
    epoch: null,
  });
  assert.equal(staleSnapshot.outcome.kind, "duplicate_dropped");
  assert.deepEqual(staleSnapshot.scope?.replies.map((item) => item.seq), [219, 220, 221]);
});

test("same-size latest-three snapshot repairs an out-of-order sparse window", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  // Three sparse frames can arrive before HTTP, with an older retained slot
  // displaced by a later frame: [218, 219, 221]. The authoritative snapshot
  // has the same watermark and same window length, but the correct [219, 220,
  // 221] membership; equal length must not make it look stale.
  for (const seq of [218, 219, 221]) {
    const live = consumeThreadUpdatedWithSyncCore(
      canonicalThreadUpdatedPayload(seq, "epoch-1"),
      receiverContext(),
    );
    assert.equal(live.kind, "applied");
  }

  const snapshot = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(219), reply(220), reply(221)],
    replyCount: 221,
    historyLimited: false,
    watermark: 221,
    epoch: null,
  });

  assert.equal(snapshot.scope?.replies.length, 3);
  assert.deepEqual(snapshot.scope?.replies.map((item) => item.seq), [219, 220, 221]);
});

test("sync-core replies runtime: known producer invalid envelopes fail closed", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  const invalidEnvelopes = [
    {
      name: "wrong root server",
      discussion: messageRepliesDiscussion(
        messageRef("server-other", "parent-1"),
        { serverId: "server-1", scopeKind: "channel" as const, scopeId: "channel-1" },
      ),
      window: syncScopeWindow({ epoch: "epoch-1" }),
    },
    {
      name: "wrong root parent",
      discussion: messageRepliesDiscussion(
        messageRef("server-1", "parent-other"),
        { serverId: "server-1", scopeKind: "channel" as const, scopeId: "channel-1" },
      ),
      window: syncScopeWindow({ epoch: "epoch-1" }),
    },
    {
      name: "wrong parent scope server",
      discussion: messageRepliesDiscussion(
        messageRef("server-1", "parent-1"),
        { serverId: "server-other", scopeKind: "channel" as const, scopeId: "channel-1" },
      ),
      window: syncScopeWindow({ epoch: "epoch-1" }),
    },
    {
      name: "wrong parent scope id",
      discussion: messageRepliesDiscussion(
        messageRef("server-1", "parent-1"),
        { serverId: "server-1", scopeKind: "channel" as const, scopeId: "channel-other" },
      ),
      window: syncScopeWindow({ epoch: "epoch-1" }),
    },
    {
      name: "wrong parent scope kind",
      discussion: {
        ...messageRepliesDiscussion(
          messageRef("server-1", "parent-1"),
          { serverId: "server-1", scopeKind: "channel" as const, scopeId: "channel-1" },
        ),
        parentScopeKey: {
          serverId: "server-1",
          scopeKind: "unsupported",
          scopeId: "channel-1",
        },
      },
      window: syncScopeWindow({ epoch: "epoch-1" }),
    },
    {
      name: "malformed window",
      discussion: messageRepliesDiscussion(
        messageRef("server-1", "parent-1"),
        { serverId: "server-1", scopeKind: "channel" as const, scopeId: "channel-1" },
      ),
      window: { ...syncScopeWindow({ epoch: "epoch-1" }), kind: "wrong-window" },
    },
  ];

  for (const [index, invalid] of invalidEnvelopes.entries()) {
    const result = consumeThreadUpdatedWithSyncCore(
      canonicalThreadUpdatedPayload(index + 10, "epoch-1", {
        syncCoreReplyWindow: {
          producer: MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
          discussion: invalid.discussion,
          window: invalid.window,
        },
      }),
      receiverContext(),
    );
    assert.deepEqual(result, { kind: "dropped", reason: "invalid_frame" }, invalid.name);
  }
});

test("sync-core replies runtime: receiver principal and epoch rebaseline prevent stale mutation", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-b");

  const stalePrincipal = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(1),
    receiverContext({ principalId: "user-a" }),
  );
  assert.equal(stalePrincipal.kind, "dropped");
  assert.equal(stalePrincipal.reason, "stale_ingress", "stale principal frames must not fail-open into B's reply scope");

  useMessageStore.getState().setCurrentUserId("user-1");
  const first = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(1, "epoch-a"),
    receiverContext(),
  );
  assert.equal(first.kind, "applied");

  const crossEpoch = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(2, "epoch-b"),
    receiverContext(),
  );
  assert.equal(crossEpoch.kind, "rebaseline_requested");
});

test("sync-core replies runtime: historyLimited is snapshot-authoritative and can clear on later snapshots", () => {
  const limited = hydrateThreadRepliesScope(
    [reply(1)],
    1,
    { historyLimited: true, principalId: "user-1", parentMessageId: "parent-1", threadChannelId: "thread-1", epoch: "a" },
  ) as ReturnType<typeof hydrateThreadRepliesScope> & { historyLimited?: boolean };

  assert.equal(limited.historyLimited, true, "snapshot/cutoff authority must seed historyLimited");

  const live = applyThreadReplyFrame(
    limited,
    reply(2),
    2,
    { source: "thread-updated" },
  ) as ReturnType<typeof applyThreadReplyFrame> & { historyLimited?: boolean };

  assert.equal(
    live.historyLimited,
    true,
    "a live thread frame must not clear historyLimited; only a later authoritative snapshot may clear it",
  );

  const upgraded = hydrateThreadRepliesScope(
    [reply(1), reply(2)],
    2,
    { historyLimited: false, principalId: "user-1", parentMessageId: "parent-1", threadChannelId: "thread-1", epoch: "b" },
  ) as ReturnType<typeof hydrateThreadRepliesScope> & { historyLimited?: boolean };

  assert.equal(
    upgraded.historyLimited,
    false,
    "historyLimited must not be max/OR sticky; true -> false is reachable after an authoritative snapshot",
  );
});

test("sync-core replies runtime: stale same-epoch snapshots cannot overwrite the accepted scope", () => {
  const newest = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(10)],
    replyCount: 10,
    historyLimited: false,
    watermark: 10,
    epoch: "epoch-a",
  });
  assert.equal(newest.outcome.kind, "applied");

  const stale = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(5)],
    replyCount: 5,
    historyLimited: false,
    watermark: 5,
    epoch: "epoch-a",
  });
  assert.equal(stale.outcome.kind, "duplicate_dropped");
  assert.deepEqual(
    stale.scope?.replies.map((item) => item.seq),
    [10],
    "stale snapshot arrival must surface the core-accepted state, not the incoming stale window",
  );
  assert.equal(stale.scope?.replyCount, 10);
});

test("sync-core replies runtime: older null-epoch HTTP compatibility snapshots cannot overwrite newer realtime", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  const realtime = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(10, "epoch-live"),
    receiverContext(),
  );
  assert.equal(realtime.kind, "applied");

  const olderHttp = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(5)],
    replyCount: 5,
    historyLimited: false,
    watermark: 5,
    epoch: null,
  });
  assert.equal(olderHttp.outcome.kind, "duplicate_dropped");
  assert.deepEqual(olderHttp.scope?.replies.map((item) => item.seq), [10]);
  assert.equal(olderHttp.scope?.replyCount, 10);
});

test("sync-core replies runtime: HTTP null epoch upgrades to canonical and blocks a later epoch", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  const http = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(10)],
    replyCount: 10,
    historyLimited: false,
    watermark: 10,
    epoch: null,
  });
  assert.equal(http.outcome.kind, "applied");

  const canonical = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(11, "epoch-1"),
    receiverContext(),
  );
  assert.equal(canonical.kind, "applied");

  const changed = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(12, "epoch-2"),
    receiverContext(),
  );
  assert.equal(changed.kind, "rebaseline_requested");
  assert.deepEqual(
    readThreadRepliesSyncCoreScopeForTests({
      serverId: "server-1",
      principalId: "user-1",
      parentMessageId: "parent-1",
      threadChannelId: "thread-1",
    })?.replies.map((item) => item.seq),
    [10, 11],
    "epoch-2 must be rejected before it can mutate the accepted scope",
  );
});

test("sync-core replies runtime: duplicate canonical arrival still establishes epoch authority", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(10)],
    replyCount: 10,
    historyLimited: false,
    watermark: 10,
    epoch: null,
  });

  const duplicateCanonical = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(10, "epoch-1"),
    receiverContext(),
  );
  assert.equal(duplicateCanonical.kind, "duplicate_dropped");

  const changed = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(11, "epoch-2"),
    receiverContext(),
  );
  assert.equal(changed.kind, "rebaseline_requested");
  assert.deepEqual(
    readThreadRepliesSyncCoreScopeForTests({
      serverId: "server-1",
      principalId: "user-1",
      parentMessageId: "parent-1",
      threadChannelId: "thread-1",
    })?.replies.map((item) => item.seq),
    [10],
  );
});

test("sync-core replies runtime: newer HTTP null epoch cannot downgrade an established canonical epoch", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");

  const canonical = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(10, "epoch-1"),
    receiverContext(),
  );
  assert.equal(canonical.kind, "applied");

  const http = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(11)],
    replyCount: 11,
    historyLimited: false,
    watermark: 11,
    epoch: null,
  });
  assert.equal(http.outcome.kind, "applied");

  const changed = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(12, "epoch-2"),
    receiverContext(),
  );
  assert.equal(changed.kind, "rebaseline_requested");
  assert.deepEqual(http.scope?.replies.map((item) => item.seq), [11]);
  assert.deepEqual(
    readThreadRepliesSyncCoreScopeForTests({
      serverId: "server-1",
      principalId: "user-1",
      parentMessageId: "parent-1",
      threadChannelId: "thread-1",
    })?.replies.map((item) => item.seq),
    [11],
    "epoch-2 must remain blocked after the compatibility snapshot",
  );
});

test("sync-core replies runtime: a superseded rebaseline response cannot roll back a newer epoch", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");
  assert.equal(
    consumeThreadUpdatedWithSyncCore(
      canonicalThreadUpdatedPayload(10, "epoch-1"),
      receiverContext(),
    ).kind,
    "applied",
  );

  const epoch2 = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(11, "epoch-2"),
    receiverContext(),
  );
  const epoch3 = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(12, "epoch-3"),
    receiverContext(),
  );
  assert.equal(epoch2.kind, "rebaseline_requested");
  assert.equal(epoch3.kind, "rebaseline_requested");
  if (epoch2.kind !== "rebaseline_requested" || epoch3.kind !== "rebaseline_requested") {
    throw new Error("expected two distinct rebaseline generations");
  }

  const newest = hydrateThreadRepliesRebaselineSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(12)],
    replyCount: 12,
    historyLimited: false,
    watermark: 12,
    epoch: "epoch-3",
    request: epoch3.request,
  });
  assert.equal(newest.outcome.kind, "applied");

  const late = hydrateThreadRepliesRebaselineSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(11)],
    replyCount: 11,
    historyLimited: false,
    watermark: 11,
    epoch: "epoch-2",
    request: epoch2.request,
  });
  assert.equal(late.outcome.kind, "duplicate_dropped");
  assert.deepEqual(late.scope?.replies.map((item) => item.seq), [12]);

  const nextEpoch3 = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(13, "epoch-3"),
    receiverContext(),
  );
  assert.equal(nextEpoch3.kind, "applied");
  if (nextEpoch3.kind !== "applied") throw new Error("expected epoch-3 apply");
  assert.deepEqual(nextEpoch3.scope.replies.map((item) => item.seq), [12, 13]);
});

test("sync-core replies runtime: same-epoch rebaseline requests coalesce until completion", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");
  consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(10, "epoch-1"),
    receiverContext(),
  );

  const first = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(11, "epoch-2"),
    receiverContext(),
  );
  const duplicate = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(12, "epoch-2"),
    receiverContext(),
  );
  const third = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(13, "epoch-2"),
    receiverContext(),
  );
  assert.equal(first.kind, "rebaseline_requested");
  assert.equal(duplicate.kind, "rebaseline_pending");
  assert.equal(third.kind, "rebaseline_pending");
  if (first.kind !== "rebaseline_requested") throw new Error("expected rebaseline request");

  const applied = hydrateThreadRepliesRebaselineSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: [reply(10)],
    replyCount: 10,
    historyLimited: false,
    watermark: 10,
    epoch: "epoch-2",
    request: first.request,
  });
  assert.equal(applied.outcome.kind, "applied");
  assert.deepEqual(applied.scope?.replies.map((item) => item.seq), [11, 12, 13]);
});

test("sync-core replies runtime: an old generation cannot release its replacement", () => {
  setCurrentServerForContract();
  useMessageStore.getState().setCurrentUserId("user-1");
  consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(10, "epoch-1"),
    receiverContext(),
  );
  const oldRequest = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(11, "epoch-2"),
    receiverContext(),
  );
  assert.equal(oldRequest.kind, "rebaseline_requested");
  if (oldRequest.kind !== "rebaseline_requested") throw new Error("expected old request");
  releaseThreadRepliesRebaselineRequest(oldRequest.request);

  const replacement = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(12, "epoch-2"),
    receiverContext(),
  );
  assert.equal(replacement.kind, "rebaseline_requested");
  releaseThreadRepliesRebaselineRequest(oldRequest.request);

  const whileReplacementPending = consumeThreadUpdatedWithSyncCore(
    canonicalThreadUpdatedPayload(13, "epoch-2"),
    receiverContext(),
  );
  assert.equal(whileReplacementPending.kind, "rebaseline_pending");
});

test("sync-core replies runtime: HTTP compatibility snapshots are isolated by server and principal", () => {
  const base = {
    parentMessageId: "parent-shared-id",
    threadChannelId: "thread-shared-id",
    historyLimited: false,
    epoch: null,
  } as const;
  hydrateThreadRepliesSnapshotWithSyncCore({
    ...base,
    serverId: "server-a",
    principalId: "user-a",
    replies: [reply(9)],
    replyCount: 9,
    watermark: 9,
  });
  const otherPrincipal = hydrateThreadRepliesSnapshotWithSyncCore({
    ...base,
    serverId: "server-a",
    principalId: "user-b",
    replies: [reply(2)],
    replyCount: 2,
    watermark: 2,
  });
  const otherServer = hydrateThreadRepliesSnapshotWithSyncCore({
    ...base,
    serverId: "server-b",
    principalId: "user-a",
    replies: [reply(3)],
    replyCount: 3,
    watermark: 3,
  });

  assert.deepEqual(otherPrincipal.scope?.replies.map((item) => item.seq), [2]);
  assert.equal(otherPrincipal.scope?.replyCount, 2);
  assert.deepEqual(otherServer.scope?.replies.map((item) => item.seq), [3]);
  assert.equal(otherServer.scope?.replyCount, 3);
});

test("sync-core replies runtime: empty-preview compatibility watermark is explicitly zero", () => {
  const first = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-empty",
    threadChannelId: "thread-empty",
    replies: [],
    replyCount: 4,
    historyLimited: false,
    watermark: 0,
    epoch: null,
  });
  assert.equal(first.outcome.kind, "applied");
  assert.equal(first.scope?.snapshotSeq, 0);
  assert.equal(first.scope?.replyCount, 4);

  const sameProvisionalWatermark = hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-empty",
    threadChannelId: "thread-empty",
    replies: [],
    replyCount: 5,
    historyLimited: false,
    watermark: 0,
    epoch: null,
  });
  assert.equal(sameProvisionalWatermark.outcome.kind, "duplicate_dropped");
  assert.equal(
    sameProvisionalWatermark.scope?.replyCount,
    4,
    "without a canonical server cursor, equal zero-watermark snapshots cannot assert newer authority",
  );
});

test("sync-core replies runtime: commentRef remains a message canonical field with shared-null-preserve", () => {
  const manifest = readSource("../shared/src/canonicalMessageManifest.ts");

  assertSourceMatches(
    manifest,
    /\{ name: "commentRef"[\s\S]*?mergePolicy: "shared-null-preserve"/,
    "commentRef is a message canonical field, not part of the typed replies read cache",
  );
});
