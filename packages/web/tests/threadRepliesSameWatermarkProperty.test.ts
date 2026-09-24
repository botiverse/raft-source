import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
  messageRef,
  messageRepliesDiscussion,
  syncScopeWindow,
} from "../../shared/src/discussionGraph.js";
import {
  consumeThreadUpdatedWithSyncCore,
  hydrateThreadRepliesSnapshotWithSyncCore,
  readThreadRepliesSyncCoreScopeForTests,
  resetThreadRepliesSyncCoreForTests,
} from "../src/store/threadRepliesSyncDomain";
import {
  captureReceiverPrivateIngressContext,
  useMessageStore,
} from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { ThreadReplyPreview } from "../src/store/threadRepliesReadModel";

const SEQS = [217, 218, 219, 220, 221] as const;
const AUTHORITATIVE_SEQS = [219, 220, 221] as const;

function reply(seq: number): ThreadReplyPreview {
  return {
    messageId: `reply-${seq}`,
    seq,
    preview: `reply ${seq}`,
    senderId: "user-1",
    senderType: "user",
    senderName: "Ada",
    senderDisplayName: "Ada",
    senderAvatarUrl: null,
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}

function livePayload(seq: number) {
  return {
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replyCount: seq,
    lastReplyAt: "2026-07-13T00:00:00.000Z",
    participantIds: ["user-1"],
    latestReply: {
      id: `reply-${seq}`,
      seq,
      content: `reply ${seq}`,
      senderId: "user-1",
      senderType: "user",
      senderName: "Ada",
      senderAvatarUrl: null,
      createdAt: "2026-07-13T00:00:00.000Z",
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
      window: syncScopeWindow({ epoch: "epoch-1" }),
    },
  };
}

function receiverContext() {
  return {
    serverId: "server-1",
    principalId: "user-1",
    ingressContext: captureReceiverPrivateIngressContext("user-1"),
  };
}

function words(length: number): number[][] {
  if (length === 0) return [[]];
  const shorter = words(length - 1);
  return shorter.flatMap((prefix) => SEQS.map((seq) => [...prefix, seq]));
}

function hydrateAuthoritativeSnapshot() {
  return hydrateThreadRepliesSnapshotWithSyncCore({
    serverId: "server-1",
    principalId: "user-1",
    parentMessageId: "parent-1",
    threadChannelId: "thread-1",
    replies: AUTHORITATIVE_SEQS.map(reply),
    replyCount: 221,
    historyLimited: false,
    watermark: 221,
    epoch: null,
  });
}

// This is deliberately a finite exhaustive property test: every word of length
// 0..5 over seq 217..221, with the authoritative snapshot inserted at every
// position, including repeated/replayed frames. Same epoch, add-only conversation
// replies only: no claim about unbounded streams, system events, edits or deletes.
// The oracle is the independent server fixture [219,220,221], not the production
// hydration/fold output. Every post-snapshot step checks complete preview rows
// and total count; runtime partition/snapshot metadata is outside this property.
test("same-watermark authoritative snapshot wins every bounded live interleaving", () => {
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
  useMessageStore.getState().setCurrentUserId("user-1");

  let cases = 0;
  let sameWatermarkCases = 0;
  const seenWords = new Set<string>();
  const authoritativeReplies = AUTHORITATIVE_SEQS.map(reply);
  for (let length = 0; length <= 5; length += 1) {
    for (const liveSeqs of words(length)) {
      const word = liveSeqs.join(",");
      assert.equal(seenWords.has(word), false, `duplicate enumeration: ${word}`);
      seenWords.add(word);
      for (let insertAt = 0; insertAt <= length; insertAt += 1) {
        resetThreadRepliesSyncCoreForTests();
        const context = receiverContext();
        let snapshotSeen = false;

        for (let position = 0; position <= length; position += 1) {
          if (position === insertAt) {
            const snapshotResult = hydrateAuthoritativeSnapshot();
            snapshotSeen = true;
            if (liveSeqs.slice(0, insertAt).includes(221)) sameWatermarkCases += 1;
            assert.deepEqual(
              snapshotResult.scope?.replies,
              authoritativeReplies,
              `authoritative snapshot projection failed for ${liveSeqs.join(",")} @${insertAt}`,
            );
          }
          if (position < length) {
            const live = consumeThreadUpdatedWithSyncCore(livePayload(liveSeqs[position]!), context);
            assert.ok(
              live.kind === "applied" || live.kind === "duplicate_dropped",
              `valid live seq ${liveSeqs[position]} must reach the sync core: ${live.kind}`,
            );
          }

          if (snapshotSeen) {
            // Read the accepted state after each subsequent delivery. Once the
            // snapshot arrives, later live frames in this bounded universe are
            // at or below watermark 221 and must not change it.
            const accepted = readThreadRepliesSyncCoreScopeForTests({
              serverId: "server-1",
              principalId: "user-1",
              parentMessageId: "parent-1",
              threadChannelId: "thread-1",
            });
            assert.deepEqual(
              accepted?.replies,
              authoritativeReplies,
              `snapshot did not converge for ${liveSeqs.join(",")} @${insertAt} position ${position}`,
            );
            assert.equal(accepted?.replyCount, 221);
          }
        }
        assert.equal(snapshotSeen, true, "every interleaving must include the snapshot");
        cases += 1;
      }
    }
  }

  assert.equal(seenWords.size, 3906, "every word of length 0..5, including duplicates");
  assert.equal(sameWatermarkCases, 8391, "enumeration must retain the same-watermark shape: 8391 interleavings place seq=221 before the snapshot");
  assert.equal(cases, 22461, "bounded enumeration cardinality must stay explicit");
});

after(() => {
  resetThreadRepliesSyncCoreForTests();
  useMessageStore.getState().setCurrentUserId(null);
  useServerStore.setState({ current: null });
});
