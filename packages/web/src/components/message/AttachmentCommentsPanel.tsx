import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, MapPin, X } from "lucide-react";
import { MessageInput } from "../../features/composer/MessageInput";
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
import type { Message, MessageMention } from "../../store/messageStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import MarkdownContent from "../markdown/MarkdownContent";
import {
  MarkdownBlockquote,
  MessageItem,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemGutter,
  MessageItemHeader,
  MessageItemSender,
  MessageItemTime,
  Panel,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelMeta,
  PanelTitle,
  Spinner,
  ScrollArea,
} from "@botiverse/raft-ui";
import { CommentIcon } from "@botiverse/ricons";
import AttachmentTooltip from "./attachmentTooltip";
import EmptyState from "../ui/EmptyState";
import { ReferenceChip } from "./ReferenceChip";
import { COMPOSER_DOCK_CLASS } from "./composerHost";
import { useAttachmentComments } from "./useAttachmentComments";

// Attachment comments panel (attachment-comments MVP spec §5/§5b).
//
// Renders inside AttachmentPreviewShell as a side panel. A comment is a
// normal message in the attachment's parent-message thread; this panel is a
// FILTERED view (refs only) with a composer that posts through
// POST /attachments/:id/comments. General thread replies intentionally never
// appear here — that split is the §6.5 scope-path × visibility contract.

/** A comment's anchor: the muted reference chip, as a link that jumps to the
 *  spot in the file it points at. It says where (§ Rollout, L12, Rows 3–5) and
 *  the quote under it says what. An HTML region has no where of its own but
 *  its quote (anchorLabel is quote-first for it), which the quote block under
 *  the chip already shows in full: the chip says "Jump to location" then, so
 *  the quote shows once. */
function AnchorJumpChip({ anchor, onAnchorJump }: { anchor: StoredAnchor; onAnchorJump?: () => void }) {
  const { formatMessage } = useIntl();
  const jump = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    if (jumpToAnchor(anchor)) onAnchorJump?.();
  }, [anchor, onAnchorJump]);
  const quoteBelow = anchor.type === "html-region" && anchorQuote(anchor) !== undefined;
  return (
    <ReferenceChip
      as="a"
      href="#"
      onClick={jump}
      data-message-affordance="attachment-comment-anchor"
      icon={MapPin}
      variant="muted"
      label={quoteBelow ? formatMessage({ id: "message.attachmentComments.jumpToLocation" }) : anchorLabel(anchor, formatMessage)}
      title={anchorQuote(anchor) ?? formatMessage({ id: "message.attachmentComments.jumpToLocation" })}
    />
  );
}

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
  const { formatMessage } = useIntl();
  const { formatMessageTime } = useTimeFormatter();
  const {
    comments,
    pendingComments,
    canComment,
    writeBlockedCopy,
    error,
    send,
  } = useAttachmentComments(attachmentId);
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
  const clearActiveAnchor = useCallback(() => {
    setAnchorCleared(true);
    onAnchorCleared?.();
  }, [onAnchorCleared]);

  // Delivery for the inherited composer (task #20): comments must pair the
  // message with its ref/anchor in one request, so the composer's store send
  // path is replaced — typing/mentions/shortcuts/error handling stay in
  // MessageInput. The data path (optimistic row, POST, reload) is shared with
  // the margin through useAttachmentComments.
  const sendComment = useCallback(async (content: string, mentions: MessageMention[]) => {
    const anchorForSend = getPendingAnchor ? getPendingAnchor() : activeAnchor;
    const scrollToEnd = () => {
      window.setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }), 0);
    };
    await send(content, mentions, anchorForSend, {
      onQueued: scrollToEnd,
      onAccepted: clearActiveAnchor,
      onDelivered: scrollToEnd,
    });
  }, [getPendingAnchor, activeAnchor, send, clearActiveAnchor]);

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

  /* Pending-anchor chip above the composer: the same reference chip as the
     anchors on the comments, with its remove button trailing. The quote
     tooltip wraps it below only when the anchor has a quote. */
  const pendingAnchorChip = activeAnchor ? (
    <ReferenceChip
      data-message-affordance="attachment-comment-pending-anchor"
      icon={MapPin}
      variant="muted"
      label={anchorLabel(activeAnchor, formatMessage)}
      trailing={(
        <AttachmentTooltip content={formatMessage({ id: "message.attachmentComments.removeAnchor" })}>
          <button
            type="button"
            aria-label={formatMessage({ id: "message.attachmentComments.removeAnchor" })}
            onClick={clearActiveAnchor}
            className="shrink-0 rounded-chip text-foreground-muted outline-none hover:text-foreground focus-visible:shadow-focus"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </AttachmentTooltip>
      )}
    />
  ) : null;
  const pendingAnchorQuote = activeAnchor ? anchorQuote(activeAnchor) : undefined;

  const sheetToggleLabel = sheetControls
    ? formatMessage({ id: sheetControls.expanded ? "message.attachmentComments.collapse" : "message.attachmentComments.expand" })
    : "";

  return (
    <Panel
      edge="inset"
      aria-label={formatMessage({ id: "message.attachmentComments.titleTooltip" }, { filename })}
      className="flex h-full w-full flex-col"
    >
      {/* The DS panel header, like every other side panel: title, the file
          it belongs to as the meta line, and on the phone sheet the expand /
          collapse PanelAction. */}
      <PanelHeader>
        <AttachmentTooltip content={formatMessage({ id: "message.attachmentComments.titleTooltip" }, { filename })}>
          <PanelHeaderContent>
            <PanelHeading>
              <PanelTitle>{formatMessage({ id: "message.attachmentComments.title" })}</PanelTitle>
            </PanelHeading>
            <PanelMeta>{filename}</PanelMeta>
          </PanelHeaderContent>
        </AttachmentTooltip>
        {sheetControls ? (
          <PanelActions>
            <AttachmentTooltip content={sheetToggleLabel}>
              <PanelAction
                aria-label={sheetToggleLabel}
                aria-expanded={sheetControls.expanded}
                onClick={sheetControls.onToggle}
                data-message-affordance="attachment-comments-sheet-toggle"
              >
                {sheetControls.expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
              </PanelAction>
            </AttachmentTooltip>
          </PanelActions>
        ) : null}
      </PanelHeader>

      {/* The comments scroll in a raft-ui ScrollArea (`listRef` is still the
          element that scrolls). The padding stays on it, so the loading and
          empty states fill its height; the comments are text, so it is a
          region named like the panel, a tab stop once it overflows. */}
      <ScrollArea
        ref={listRef}
        role="region"
        aria-label={formatMessage({ id: "message.attachmentComments.title" })}
        className={`min-h-0 flex-1 px-3 py-2 ${collapsedBody ? "hidden" : ""}`}
      >
        {comments === null ? (
          <div className="flex h-full items-center justify-center"><Spinner size="md" aria-label={formatMessage({ id: "common.loadingLabel" })} /></div>
        ) : visible.length === 0 ? (
          <EmptyState
            className="flex h-full flex-col items-center justify-center px-2"
            icon={<CommentIcon width={36} height={36} />}
            title={formatMessage({ id: "message.attachmentComments.emptyTitle" })}
            description={formatMessage(
              { id: "message.attachmentComments.emptyHint" },
              {
                filename,
                strong: (chunks) => <span className="font-semibold" key="attachment-comments-empty-hint-filename">{chunks}</span>,
              },
            )}
          />
        ) : (
          <ul className="flex flex-col" data-testid="attachment-comments-list">
            {visible.map((c) => {
              const anchor = c.anchor;
              const quote = anchor && typeof anchor.data?.quote === "string" && anchor.data.quote ? anchor.data.quote : null;
              /* A comment is a message in the attachment's thread, so it is a
                 raft-ui MessageItem row: avatar, sender and time, then where
                 it points and what it says. An anchored comment's location is
                 the same muted reference chip as a comment's re: chip in the
                 conversation, and the chip is the link that jumps to it.
                 raft-ui 0.24 makes a named MessageItem an `article`; here it
                 is the list's item, so it keeps `listitem` or the list would
                 have none. */
              return (
                <MessageItem key={c.id} render={<li />} role="listitem" data-comment-id={c.id}>
                  <MessageItemGutter>
                    <MessageItemAvatarSlot className="flex items-start">
                      <AvatarSlot
                        context="message-row"
                        type={c.senderType === "agent" ? "agent" : "human"}
                        agentAvatarUrl={c.senderType === "agent" ? c.senderAvatarUrl : undefined}
                        humanAvatarUrl={c.senderType === "user" ? c.senderAvatarUrl : undefined}
                      />
                    </MessageItemAvatarSlot>
                  </MessageItemGutter>
                  <MessageItemContent>
                    <MessageItemHeader>
                      <MessageItemSender>{c.senderName}</MessageItemSender>
                      <MessageItemTime render={<time dateTime={c.createdAt} />}>{formatMessageTime(c.createdAt)}</MessageItemTime>
                    </MessageItemHeader>
                    {/* Only a comment pinned to a spot gets a location chip:
                        a whole-file comment would just repeat the file name
                        the panel header already shows. */}
                    {anchor ? (
                      <div className="mt-0.5">
                        <AnchorJumpChip anchor={anchor} onAnchorJump={onAnchorJump} />
                      </div>
                    ) : null}
                    {quote ? (
                      <MarkdownBlockquote className="mt-1 whitespace-pre-wrap">{quote}</MarkdownBlockquote>
                    ) : null}
                    <MessageItemBody className="mt-1">
                      <MarkdownContent source={c.content} density="compact" enableMermaid />
                    </MessageItemBody>
                  </MessageItemContent>
                </MessageItem>
              );
            })}
          </ul>
        )}
      </ScrollArea>

      <div className={`${COMPOSER_DOCK_CLASS} ${collapsedBody ? "hidden" : ""}`} data-message-affordance="attachment-comment-composer">
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
                   Box + tint synced with the comment anchor chips (a DS
                   token chip on fill-muted — cindyz 6/11). */
                pendingAnchorChip && pendingAnchorQuote ? (
                  <AttachmentTooltip content={pendingAnchorQuote}>{pendingAnchorChip}</AttachmentTooltip>
                ) : (
                  pendingAnchorChip
                )
              }
            />
            {error ? <p className="mt-1 text-caption text-danger-strong">{error}</p> : null}
          </>
        ) : (
          <p
            data-message-affordance="attachment-comment-composer-disabled"
            className="px-1 py-1.5 text-footnote text-foreground-hint"
          >
            {writeBlockedCopy}
          </p>
        )}
      </div>
    </Panel>
  );
}
