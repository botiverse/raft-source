import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, FileText, MapPin, X } from "lucide-react";
import api from "../../api/client";
import MessageInput from "./MessageInput";
import AvatarSlot from "../ui/AvatarSlot";
import {
  anchorLabel,
  anchorOrderKey,
  anchorQuote,
  jumpToAnchor,
} from "./attachmentCommentAnchors";
import type {
  CommentAnchor,
  StoredAnchor,
} from "./attachmentCommentAnchors";
import { getSocket } from "../../api/socket";
import { useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { useAuthStore } from "../../store/authStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import MarkdownContent from "../markdown/MarkdownContent";
import Spinner from "../ui/Spinner";

// Attachment comments panel (attachment-comments MVP spec §5/§5b).
//
// Renders inside AttachmentPreviewShell as a side panel. A comment is a
// normal message in the attachment's parent-message thread; this panel is a
// FILTERED view (refs only) with a composer that posts through
// POST /attachments/:id/comments. General thread replies intentionally never
// appear here — that split is the §6.5 scope-path × visibility contract.

interface CommentReaction {
  emoji: string;
  reactorType: "user" | "agent";
  reactorId: string;
}

interface AttachmentComment {
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
  senderGravatarHash: string | null;
}

type ViewerState = {
  canComment: boolean;
  reason: "ok" | "not_member" | "archived" | "unlinked" | "read_only";
};


export function AttachmentCommentsPanel({
  attachmentId,
  filename,
  parentMessage,
  pendingAnchor,
  getPendingAnchor,
  onAnchorCleared,
  onAnchorJump,
  sheetControls,
  collapsedBody,
}: {
  attachmentId: string;
  filename: string;
  parentMessage: Pick<Message, "id" | "channelId">;
  /** Structural anchor captured from the selection at open time (task #15). */
  pendingAnchor?: CommentAnchor | null;
  /** Read the shell's latest pending anchor at submit time, before React renders the prop update. */
  getPendingAnchor?: () => CommentAnchor | null;
  /** Keep the preview shell's pending-anchor state in sync when this panel clears it. */
  onAnchorCleared?: () => void;
  /**
   * Fired after a successful anchor jump — the mobile sheet collapses so the
   * flash highlight is visible instead of hidden behind the panel (task #26).
   */
  onAnchorJump?: () => void;
  /**
   * Mobile sheet integration (cindyz 6/11): the expand/collapse chevron
   * renders inside the panel's control row — there is no separate handle
   * bar. Absent on desktop surfaces.
   */
  sheetControls?: { expanded: boolean; onToggle: () => void };
  /** Hide list+composer (display:none → out of tab order/a11y tree) while
   *  the mobile sheet is collapsed to its header row. */
  collapsedBody?: boolean;
}) {
  const currentUser = useAuthStore((s) => s.user);
  const viewerUserId = currentUser?.id ?? null;
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  const [comments, setComments] = useState<AttachmentComment[] | null>(null);
  const [pendingComments, setPendingComments] = useState<AttachmentComment[]>([]);
  const [threadChannelId, setThreadChannelId] = useState<string | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // The panel stays mounted across open/close (collapse animation, task #14),
  // so per-open inputs arrive as PROP CHANGES, not fresh mounts: a new
  // captured anchor resets the per-open "cleared" flag during render.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- prev-prop tracker for the React-docs "adjust state during render" pattern; it must NOT stay in sync (it stores the PREVIOUS value to detect changes).
  const [lastAnchor, setLastAnchor] = useState(pendingAnchor);
  const [anchorCleared, setAnchorCleared] = useState(false);
  if (pendingAnchor !== lastAnchor) {
    setLastAnchor(pendingAnchor);
    setAnchorCleared(false);
  }
  const activeAnchor = anchorCleared ? null : (pendingAnchor ?? null);
  const clearActiveAnchor = () => {
    setAnchorCleared(true);
    onAnchorCleared?.();
  };

  // The panel can also be RE-SCOPED while mounted (image lightbox paging,
  // task #10 — Dozy review): a new attachmentId must never show the previous
  // attachment's comments under the new filename, and a slow previous load
  // must never overwrite the new one. Reset to loading state during render;
  // fence every async write on "is this still the active attachment".
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same prev-prop tracker pattern as above, for re-scoping resets (Dozy review on 94b7c86e).
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
    try {
      const { data } = await api.get(`/attachments/${attachmentId}/comments`);
      if (attachmentIdRef.current !== attachmentId) return false; // stale response
      setComments(data.comments as AttachmentComment[]);
      setThreadChannelId(data.threadChannelId ?? null);
      setViewerState((data.viewer as ViewerState | undefined) ?? null);
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

  // Delivery for the inherited composer (task #20): comments must pair the
  // message with its ref/anchor in one request, so the composer's store send
  // path is replaced — typing/mentions/shortcuts/error handling stay in
  // MessageInput.
  const sendComment = async (content: string, mentions: { type: string; id: string; name: string }[]) => {
    const anchorForSend = getPendingAnchor ? getPendingAnchor() : activeAnchor;
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
      senderGravatarHash: currentUser?.gravatarHash ?? null,
    };
    setPendingComments((prev) => [...prev, optimisticComment]);
    window.setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }), 0);

    try {
      const { data } = await api.post(`/attachments/${attachmentId}/comments`, {
        content,
        anchor: anchorForSend ?? undefined,
        mentions: mentions.length > 0 ? mentions : undefined,
      });
      // Same staleness fence as load(): if the host re-scoped the panel while
      // the POST was in flight, don't touch the new attachment's UI state
      // (future-proofing for pageable hosts that pass pendingAnchor).
      if (attachmentIdRef.current !== attachmentId) return;
      clearActiveAnchor();
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
      window.setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }), 0);
    } catch (err) {
      if (attachmentIdRef.current === attachmentId) {
        setPendingComments((prev) => prev.filter((comment) => comment.id !== optimisticId));
      }
      throw err;
    }
  };

  // Fixed order (cindyz 6/11, task #28): by anchor position in the document;
  // comments WITHOUT a position always sit on top. No user-facing sort
  // control — this is the list's one canonical order.
  const visible = [...(comments ?? []), ...pendingComments]
    .map((c) => ({ c, key: c.anchor ? anchorOrderKey(c.anchor) : null }))
    .sort((a, b) => {
      const ka = a.key ?? Number.NEGATIVE_INFINITY;
      const kb = b.key ?? Number.NEGATIVE_INFINITY;
      if (ka !== kb) return ka - kb;
      return a.c.createdAt.localeCompare(b.c.createdAt);
    })
    .map(({ c }) => c);

  return (
    <div className="flex h-full w-full flex-col bg-white">
      <div className="flex shrink-0 items-center gap-2 border-b-2 border-black px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-bold text-black" title={formatMessage({ id: "message.attachmentComments.titleTooltip" }, { filename })}>
          {formatMessage({ id: "message.attachmentComments.header" }, { filename })}
        </span>
        {sheetControls ? (
          <button
            type="button"
            title={formatMessage({ id: sheetControls.expanded ? "message.attachmentComments.collapse" : "message.attachmentComments.expand" })}
            aria-expanded={sheetControls.expanded}
            onClick={sheetControls.onToggle}
            className="btn-brutal-sm bg-white p-0.5 text-black"
            data-message-affordance="attachment-comments-sheet-toggle"
          >
            {sheetControls.expanded ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
          </button>
        ) : null}
      </div>

      <div ref={listRef} className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 ${collapsedBody ? "hidden" : ""}`}>
        {comments === null ? (
          <div className="flex h-full items-center justify-center"><Spinner size="sm" /></div>
        ) : visible.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-black/45">
            {formatMessage(
              { id: "message.attachmentComments.emptyHint" },
              {
                filename,
                strong: (chunks) => <span className="font-bold" key="attachment-comments-empty-hint-filename">{chunks}</span>,
              },
            )}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((c) => {
              const jump = c.anchor
                ? () => {
                    if (jumpToAnchor(c.anchor!)) onAnchorJump?.();
                  }
                : null;
              /* Figma-list card (cindyz 6/11): avatar-led header, anchor chip
                 as location ref, body. The whole card is the jump affordance
                 when an anchor exists — a real <button> (semantic, lint-
                 clean); the resolve control is a SIBLING in the corner, not
                 nested inside it. This location-ref card explicitly keeps the
                 arrow cursor even though normal app controls use the link hand. */
              const inner = (
                <>
                  <div className="flex items-center gap-1.5 pr-6">
                    <AvatarSlot
                      context="compact-list"
                      type={c.senderType === "agent" ? "agent" : "human"}
                      agentAvatarUrl={c.senderType === "agent" ? c.senderAvatarUrl : undefined}
                      humanAvatarUrl={c.senderType === "user" ? c.senderAvatarUrl : undefined}
                      gravatarHash={c.senderType === "user" ? c.senderGravatarHash : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-black">{c.senderName}</span>
                    <span className="shrink-0 text-[10px] text-black/40">
                      {formatMessageTime(c.createdAt)}
                    </span>
                  </div>
                  <span
                    data-message-affordance="attachment-comment-anchor"
                    className="mt-1 inline-flex max-w-full items-center gap-1 overflow-hidden border border-black bg-brutal-stone/25 px-1.5 py-0.5 text-[10px] font-display font-bold text-black"
                  >
                    {c.anchor ? <MapPin size={9} className="shrink-0" /> : <FileText size={9} className="shrink-0" />}
                    <span className="min-w-0 truncate">{c.anchor ? anchorLabel(c.anchor, formatMessage) : filename}</span>
                  </span>
                  {c.anchor && typeof (c.anchor.data as Record<string, unknown>)?.quote === "string" && (c.anchor.data as Record<string, unknown>).quote ? (
                    <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-black/20 pl-2 text-[11px] italic text-black/50">
                      {(c.anchor.data as Record<string, unknown>).quote as string}
                    </div>
                  ) : null}
                  <div className="mt-1 text-xs leading-relaxed text-black/80">
                    <MarkdownContent source={c.content} density="compact" enableMermaid />
                  </div>
                </>
              );
              return (
                <li key={c.id} className="relative">
                  {jump ? (
                    <button
                      type="button"
                      onClick={jump}
                      title={anchorQuote(c.anchor!) ?? formatMessage({ id: "message.attachmentComments.jumpToLocation" })}
                      className="block w-full rounded border border-black/15 bg-white px-2.5 py-2 text-left transition-colors hover:border-black/40 hover:bg-brutal-stone/10"
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="rounded border border-black/15 bg-white px-2.5 py-2">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className={`shrink-0 border-t-2 border-black p-2 ${collapsedBody ? "hidden" : ""}`} data-message-affordance="attachment-comment-composer">
        {canComment ? (
          <>
            {/* Inherited composer (task #20, cindyz + Dozy): the channel/
                thread MessageInput in compact form — drafts, mentions,
                shortcuts, IME guard, sending/error states all come from the
                base. Comment-specific surface = the two chips (accessoryRow)
                + delivery override (ref/anchor pairing). Draft key is a
                synthetic per-attachment slot; mention scope = the parent
                channel the attachment lives in. */}
            <MessageInput
              channelId={`attachment-comment:${attachmentId}`}
              channelName={filename}
              placeholder={formatMessage({ id: "message.attachmentComments.composerPlaceholder" }, { filename })}
              variant="compact"
              mentionChannelId={parentMessage.channelId}
              isChannelThread
              onSendOverride={sendComment}
              accessoryRow={
                /* Scope is already stated by the panel header + placeholder,
                   so no re: chip here (cindyz task #21); only the location
                   anchor rides above the input, attachment-strip style.
                   Box + tint synced with the thread re: chip (Option A,
                   bg-brutal-stone/25 — cindyz 6/11). */
                activeAnchor ? (
                  <span
                    title={anchorQuote(activeAnchor) ?? undefined}
                    data-message-affordance="attachment-comment-pending-anchor"
                    className="inline-flex max-w-full items-center gap-1 overflow-hidden border border-black bg-brutal-stone/25 px-1.5 py-0.5 text-[10px] font-display font-bold text-black"
                  >
                    <MapPin size={9} className="shrink-0" />
                    <span className="min-w-0 truncate">{anchorLabel(activeAnchor, formatMessage)}</span>
                    <button
                      type="button"
                      title={formatMessage({ id: "message.attachmentComments.removeAnchor" })}
                      onClick={clearActiveAnchor}
                      className="shrink-0 text-black/50 hover:text-black"
                    >
                      <X size={9} />
                    </button>
                  </span>
                ) : null
              }
            />
            {error ? <p className="mt-1 text-[10px] font-bold text-red-600">{error}</p> : null}
          </>
        ) : (
          <p
            data-message-affordance="attachment-comment-composer-disabled"
            className="px-1 py-1.5 text-[11px] font-bold text-black/45"
          >
            {writeBlockedCopy}
          </p>
        )}
      </div>
    </div>
  );
}
