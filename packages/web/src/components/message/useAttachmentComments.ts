import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import { getSocket } from "../../api/socket";
import { useAuthStore } from "../../store/authStore";
import { useMessageStore } from "../../store/messageStore";
import type { Message, MessageMention } from "../../store/messageStore";
import type { CommentAnchor, StoredAnchor } from "./attachmentCommentAnchors";

// The comments on one attachment, shared by the side panel
// (AttachmentCommentsPanel) and the margin beside the document
// (AttachmentCommentMargin): fetch, live refresh, the viewer's permission and
// the optimistic send. A comment is a normal message in the attachment's
// parent-message thread; GET/POST /attachments/:id/comments is its filtered
// view and its delivery path (attachment-comments MVP spec §5/§5b).

interface CommentReaction {
  emoji: string;
  reactorType: "user" | "agent";
  reactorId: string;
}

export interface AttachmentComment {
  id: string;
  channelId: string;
  senderType: "user" | "agent";
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
  reactions: CommentReaction[];
  /** Structural anchor (task #15) — null for unanchored comments. */
  anchor: StoredAnchor | null;
  senderAvatarUrl: string | null;
}

export type AttachmentCommentViewer = {
  canComment: boolean;
  reason: "ok" | "not_member" | "archived" | "unlinked" | "read_only";
};

export type SendAttachmentCommentHooks = {
  /** The optimistic comment is in `pending`. */
  onQueued?: () => void;
  /** The server accepted the comment (before the list reloads). */
  onAccepted?: () => void;
  /** The list reloaded with the comment in it. */
  onDelivered?: () => void;
};

/**
 * The comments on `attachmentId`, or nothing (no request) while it is null:
 * a host that only sometimes shows comments calls the hook unconditionally.
 */
export function useAttachmentComments(attachmentId: string | null) {
  const currentUser = useAuthStore((s) => s.user);
  const viewerUserId = currentUser?.id ?? null;
  const { formatMessage } = useIntl();
  const [comments, setComments] = useState<AttachmentComment[] | null>(null);
  const [pendingComments, setPendingComments] = useState<AttachmentComment[]>([]);
  const [threadChannelId, setThreadChannelId] = useState<string | null>(null);
  const [viewerState, setViewerState] = useState<AttachmentCommentViewer | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The panel can be RE-SCOPED while mounted (image lightbox paging, task #10
  // — Dozy review): a new attachmentId must never show the previous
  // attachment's comments under the new filename, and a slow previous load
  // must never overwrite the new one. Reset to loading state during render;
  // fence every async write on "is this still the active attachment".
  // oxlint-disable-next-line react-doctor/no-derived-useState -- prev-prop tracker for the React-docs "adjust state during render" pattern (Dozy review on 94b7c86e); it stores the PREVIOUS value to detect re-scoping.
  const [lastAttachmentId, setLastAttachmentId] = useState(attachmentId);
  if (attachmentId !== lastAttachmentId) {
    setLastAttachmentId(attachmentId);
    setComments(null);
    setPendingComments([]);
    setThreadChannelId(null);
    setViewerState(null);
    setError(null);
  }
  const attachmentIdRef = useRef(attachmentId);
  attachmentIdRef.current = attachmentId;

  const commentsRef = useRef(comments);
  commentsRef.current = comments;

  const load = useCallback(async () => {
    if (attachmentId === null) return false;
    try {
      const { data } = await api.get(`/attachments/${attachmentId}/comments`);
      if (attachmentIdRef.current !== attachmentId) return false; // stale response
      setComments(data.comments as AttachmentComment[]);
      setThreadChannelId(data.threadChannelId ?? null);
      setViewerState((data.viewer as AttachmentCommentViewer | undefined) ?? null);
      return true;
    } catch {
      if (attachmentIdRef.current !== attachmentId) return false;
      setError(formatMessage({ id: "message.attachmentComments.loadError" }));
      return false;
    }
  }, [attachmentId, formatMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates: comments ARE thread messages, so the existing message
  // events cover them — reactions re-emit the full message as
  // `message:updated`; no comment-specific event types exist.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onMessage = (payload: { channelId?: string }) => {
      if (threadChannelId && payload?.channelId === threadChannelId) void load();
    };
    const onUpdated = (payload: { id?: string; channelId?: string }) => {
      if (
        (threadChannelId && payload?.channelId === threadChannelId)
        || commentsRef.current?.some((c) => c.id === payload?.id)
      ) {
        void load();
      }
    };
    socket.on("message:new", onMessage);
    socket.on("message:updated", onUpdated);
    return () => {
      socket.off("message:new", onMessage);
      socket.off("message:updated", onUpdated);
    };
  }, [threadChannelId, load]);

  const canComment = viewerState?.canComment ?? true;
  const writeBlockedCopy = viewerState && !viewerState.canComment
    ? viewerState.reason === "archived"
      ? formatMessage({ id: "message.attachmentComments.blockedArchived" })
      : viewerState.reason === "not_member"
        ? formatMessage({ id: "message.attachmentComments.blockedNotMember" })
        : viewerState.reason === "read_only"
          ? formatMessage({ id: "message.attachmentComments.blockedReadOnly" })
          : formatMessage({ id: "message.attachmentComments.blockedGeneric" })
    : null;

  // Comments must pair the message with its ref/anchor in one request, so
  // the composer's store send path is replaced by this one (task #20). The
  // optimistic comment carries the anchor it is sent with, so it shows where
  // the delivered one will.
  const send = useCallback(async (
    content: string,
    mentions: MessageMention[],
    anchorForSend: CommentAnchor | StoredAnchor | null,
    hooks: SendAttachmentCommentHooks = {},
  ) => {
    if (attachmentId === null) return;
    const optimisticId = `optimistic-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticComment: AttachmentComment = {
      id: optimisticId,
      channelId: threadChannelId ?? `attachment-comment:${attachmentId}`,
      senderType: "user",
      senderId: viewerUserId ?? "",
      senderName: currentUser?.displayName || currentUser?.name || formatMessage({ id: "message.author.you" }),
      content,
      createdAt: new Date().toISOString(),
      reactions: [],
      anchor: anchorForSend ? { type: anchorForSend.type, data: anchorForSend.data as Record<string, unknown> } : null,
      senderAvatarUrl: currentUser?.avatarUrl ?? null,
    };
    setPendingComments((prev) => [...prev, optimisticComment]);
    hooks.onQueued?.();

    try {
      const { data } = await api.post(`/attachments/${attachmentId}/comments`, {
        content,
        anchor: anchorForSend ?? undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
      });
      // Same staleness fence as load(): if the host re-scoped while the POST
      // was in flight, don't touch the new attachment's UI state.
      if (attachmentIdRef.current !== attachmentId) return;
      hooks.onAccepted?.();
      setError(null);
      if (typeof data?.threadChannelId === "string") {
        setThreadChannelId(data.threadChannelId);
      }
      if (data?.message && typeof data.message.id === "string" && typeof data.message.channelId === "string") {
        useMessageStore.getState().addMessage(data.message as Message);
      }
      const loaded = await load();
      if (loaded) {
        setPendingComments((prev) => prev.filter((comment) => comment.id !== optimisticId));
      }
      hooks.onDelivered?.();
    } catch (err) {
      if (attachmentIdRef.current === attachmentId) {
        setPendingComments((prev) => prev.filter((comment) => comment.id !== optimisticId));
      }
      throw err;
    }
  }, [threadChannelId, attachmentId, viewerUserId, currentUser, formatMessage, load]);

  return {
    /** null while the first load is in flight (and while there is no attachment). */
    comments,
    /** Optimistic comments not yet in `comments`. */
    pendingComments,
    viewer: viewerState,
    canComment,
    /** Why the viewer can't comment, when they can't. */
    writeBlockedCopy,
    error,
    send,
  };
}

export type AttachmentCommentsState = ReturnType<typeof useAttachmentComments>;
