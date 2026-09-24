/**
 * Task #47 — `thread:updated` → thread-replies read model.
 *
 * The server emits `thread:updated` with `{ parentMessageId, ...threadInfo,
 * latestReply, threadChannelId }` (messageService.ts:1620). `threadInfo` carries
 * the authoritative `replyCount`; `latestReply` is a projected message payload
 * that keeps `seq` (projectFrontendMessagePayload only omits agentSendKey /
 * searchText / searchVector).
 *
 * THE GUARD THAT MATTERS: `seq` is typed OPTIONAL on the shared message payload
 * (`seq?: number`). Every ordering gate in the read model is a magnitude
 * comparison on seq, and `undefined` does not fail those comparisons loudly — it
 * fails them SILENTLY and in the worst direction:
 *
 *   undefined <= snapshotSeq   →  false   ⇒ sails straight through the seam gate
 *   sort((a, b) => a.seq - b.seq)         ⇒ NaN ⇒ arbitrary order
 *
 * So a frame with no seq would be admitted and then scramble the window. A frame
 * we cannot order is a frame we cannot apply: drop it. Fail-closed, like the flag.
 */
import type {
  MessageRepliesDiscussion,
  SyncScopeWindow,
} from "@botiverse/raft-shared";
import type { ThreadReplyPreview } from "./threadRepliesReadModel";
import { useThreadStore } from "./threadStore";

export interface ThreadRepliesSyncWindowEnvelope {
  producer: string;
  discussion: MessageRepliesDiscussion;
  window: SyncScopeWindow;
  parentChannelId: string;
  parentScopeKind: string;
  epoch: string | null;
}

/** The wire shape we depend on. Everything here is verified against the emitter. */
export interface ThreadUpdatedPayload {
  parentMessageId?: unknown;
  threadChannelId?: unknown;
  replyCount?: unknown;
  syncCoreReplyWindow?: unknown;
  lastReplyAt?: unknown;
  participantIds?: unknown;
  unreadCount?: unknown;
  firstUnreadMessageId?: unknown;
  latestReply?: {
    id?: unknown;
    seq?: unknown;
    content?: unknown;
    senderId?: unknown;
    senderType?: unknown;
    senderName?: unknown;
    senderDisplayName?: unknown;
    senderAvatarUrl?: unknown;
    createdAt?: unknown;
    conversationContext?: unknown;
  } | null;
}

const SENDER_TYPES = new Set(["user", "agent", "system", "external_projection"]);

/**
 * Project the socket payload into a reply preview, or null when the frame cannot
 * be trusted to order. Returning null is a real outcome, not an error path.
 */
export function projectThreadReplyFrame(
  payload: ThreadUpdatedPayload,
): { parentMessageId: string; reply: ThreadReplyPreview; replyCount: number } | null {
  const parentMessageId = payload.parentMessageId;
  const latest = payload.latestReply;
  if (typeof parentMessageId !== "string" || !latest) return null;

  // seq and replyCount are the two ordering-critical fields. Neither may be
  // coerced: `Number(undefined)` is NaN, and NaN silently defeats every gate.
  const seq = latest.seq;
  const replyCount = payload.replyCount;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  if (typeof replyCount !== "number" || !Number.isFinite(replyCount)) return null;

  const messageId = latest.id;
  if (typeof messageId !== "string") return null;

  const senderType = latest.senderType;

  return {
    parentMessageId,
    replyCount,
    reply: {
      messageId,
      seq,
      preview: typeof latest.content === "string" ? latest.content : "",
      senderId: typeof latest.senderId === "string" ? latest.senderId : "",
      senderType: typeof senderType === "string" && SENDER_TYPES.has(senderType)
        ? (senderType as ThreadReplyPreview["senderType"])
        : "user",
      senderName: typeof latest.senderName === "string" ? latest.senderName : "",
      senderDisplayName: typeof latest.senderDisplayName === "string"
        ? latest.senderDisplayName
        : (typeof latest.senderName === "string" ? latest.senderName : ""),
      senderAvatarUrl: typeof latest.senderAvatarUrl === "string" ? latest.senderAvatarUrl : null,
      createdAt: typeof latest.createdAt === "string" ? latest.createdAt : "",
    },
  };
}

export function readThreadRepliesSyncWindowEnvelope(
  payload: ThreadUpdatedPayload,
): ThreadRepliesSyncWindowEnvelope | null {
  const envelope = payload.syncCoreReplyWindow;
  if (!envelope || typeof envelope !== "object") return null;
  const candidate = envelope as Record<string, unknown>;
  const discussion = candidate.discussion as Record<string, unknown> | null | undefined;
  const window = candidate.window as Record<string, unknown> | null | undefined;
  const producer = candidate.producer;
  if (typeof producer !== "string") return null;
  if (!discussion || typeof discussion !== "object") return null;
  if (!window || typeof window !== "object") return null;
  const root = discussion.root as Record<string, unknown> | null | undefined;
  const relation = discussion.relation as Record<string, unknown> | null | undefined;
  const parentScopeKey = discussion.parentScopeKey as Record<string, unknown> | null | undefined;
  if (!root || typeof root !== "object") return null;
  if (!relation || typeof relation !== "object") return null;
  if (!parentScopeKey || typeof parentScopeKey !== "object") return null;
  if (root.kind !== "message" || typeof root.serverId !== "string" || typeof root.id !== "string") return null;
  if (relation.kind !== "replies") return null;
  if (discussion.backing !== "sync-scope") return null;
  if (typeof parentScopeKey.serverId !== "string") return null;
  if (typeof parentScopeKey.scopeKind !== "string") return null;
  if (typeof parentScopeKey.scopeId !== "string") return null;
  if (window.kind !== "sync-scope-window") return null;
  if (window.scopeCursor !== null && typeof window.scopeCursor !== "string") return null;
  if (window.epoch !== null && typeof window.epoch !== "string") return null;
  return {
    producer,
    discussion: discussion as unknown as MessageRepliesDiscussion,
    window: window as unknown as SyncScopeWindow,
    parentChannelId: parentScopeKey.scopeId,
    parentScopeKind: parentScopeKey.scopeKind,
    epoch: window.epoch,
  };
}

/** Apply one `thread:updated` frame to the read model. A frame we cannot order is dropped. */
export function handleThreadUpdatedForReplies(payload: ThreadUpdatedPayload): void {
  const frame = projectThreadReplyFrame(payload);
  if (!frame) return;
  useThreadStore.getState().applyReplyFrame(frame.parentMessageId, frame.reply, frame.replyCount);
}
