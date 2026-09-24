/**
 * Task #47 — the server-sent "newest 3 upfront" leg. `loadSummaries` must
 * hydrate inline reply scopes from `summary.latestReplies`. System messages
 * still count toward replyCount but are not conversation previews, so an older
 * server payload containing them must not surface them or consume a preview
 * slot. Hydration also must NOT clobber a scope realtime has already advanced
 * past the snapshot.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import api from "../src/api/client";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import type { ThreadReplyPreview } from "../src/store/threadRepliesReadModel";

const PARENT_ID = "parent-1";
const originalGet = api.get;

function preview(seq: number, senderType: ThreadReplyPreview["senderType"] = "user"): ThreadReplyPreview {
  return {
    messageId: `m-${seq}`,
    seq,
    preview: `reply ${seq}`,
    senderId: senderType === "system" ? "system" : `sender-${seq}`,
    senderType,
    senderName: senderType === "system" ? "System" : `sender ${seq}`,
    senderAvatarUrl: null,
    createdAt: "2026-07-17T00:00:00Z",
  };
}

function stubSummaries(latestReplies: ThreadReplyPreview[], replyCount: number) {
  api.get = (async () => ({
    data: {
      [PARENT_ID]: {
        threadChannelId: "thread-1",
        replyCount,
        lastReplyAt: null,
        participantIds: [],
        unreadCount: 0,
        firstUnreadMessageId: null,
        latestReplies,
      },
    },
  })) as typeof api.get;
}

afterEach(() => {
  api.get = originalGet as typeof api.get;
  useThreadStore.setState({ replyScopes: {}, summaries: {} });
});

test("loadSummaries excludes system rows while preserving the authoritative reply count", async () => {
  useServerStore.setState({ current: { id: "server-1", name: "S", slug: "s" } } as never);
  stubSummaries([preview(2), preview(3), preview(4, "agent"), preview(5, "system")], 4);

  await useThreadStore.getState().loadSummaries("channel-1");

  const scope = useThreadStore.getState().replyScopes[PARENT_ID];
  assert.ok(scope, "summary payload must hydrate the reply scope");
  assert.equal(scope.replyCount, 4);
  assert.deepEqual(scope.replies.map((reply) => reply.messageId), ["m-2", "m-3", "m-4"]);
  assert.equal(scope.snapshotSeq, 5, "the snapshot seam still covers filtered system history");
});

test("loadSummaries does not clobber a scope realtime already advanced past", async () => {
  useServerStore.setState({ current: { id: "server-1", name: "S", slug: "s" } } as never);
  // Realtime has seq 9; the fetched snapshot only knows up to seq 4.
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [preview(8), preview(9)], 9);
  stubSummaries([preview(3), preview(4)], 4);

  await useThreadStore.getState().loadSummaries("channel-1");

  const scope = useThreadStore.getState().replyScopes[PARENT_ID];
  assert.deepEqual(scope?.replies.map((reply) => reply.messageId), ["m-8", "m-9"]);
  assert.equal(scope?.replyCount, 9);
});
