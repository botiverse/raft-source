import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { TriangleAlert, MapPinOff } from "lucide-react";
import {
  AvatarGroup,
  Button,
  Drawer,
  DrawerActions,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ScrollArea,
} from "@botiverse/raft-ui";
import { CommentIcon, AddCommentIcon } from "@botiverse/ricons";
import {
  COMMENT_HIGHLIGHT,
  COMMENT_HIGHLIGHT_ACTIVE,
  CommentCard,
  CommentCardMeta,
  CommentCardQuote,
  CommentCardTrigger,
  CommentEntry,
  CommentEntryAuthor,
  CommentEntryBody,
  CommentEntryHeader,
  CommentEntryTime,
  CommentMargin,
  CommentMarginItem,
  CommentMarker,
  setCommentHighlights,
  useCommentMarginFits,
} from "@botiverse/raft-ui/wip";
import type { Message, MessageMention } from "../../store/messageStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useShortcut } from "../../features/shortcuts/useShortcut";
import { useShortcutBinding } from "../../features/shortcuts/useShortcutBinding";
import MarkdownContent from "../markdown/MarkdownContent";
import AvatarSlot from "../ui/AvatarSlot";
import AttachmentTooltip from "./attachmentTooltip";
import { labelWithShortcut } from "../ui/LabelWithShortcut";
import { MessageInput } from "../../features/composer/MessageInput";
import { anchorLabel, anchorQuote, captureSelectionAnchor } from "./attachmentCommentAnchors";
import type { CommentAnchor, StoredAnchor } from "./attachmentCommentAnchors";
import {
  WHOLE_FILE_DISCUSSION_KEY,
  discussionHash,
  discussionKey,
  groupDiscussions,
} from "./attachmentCommentDiscussions";
import type { CommentDiscussion } from "./attachmentCommentDiscussions";
import { placeAnchor } from "./attachmentCommentPlacement";
import type { AttachmentComment, AttachmentCommentsState } from "./useAttachmentComments";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";

export type AttachmentCommentMarginActions = {
  /** Open the whole file's card, or a new comment on the whole file. */
  commentOnFile: () => void;
};

// Comments beside the document (task #118; raft-design patterns/comments.md
// and the Comment parts in raft-ui/wip). Each discussion's card sits in the
// right margin level with the passage it is about, the passage highlighted;
// where the viewer has no room for the margin, a marker beside the passage
// opens the discussion in a bottom sheet. The margin lives inside the same
// scroll container as the document, so cards scroll with the text and no
// scroll syncing is needed: the only measurement is each passage's top
// relative to the margin's top.

type Placement = { kind: "placed"; range: Range; exact: boolean } | { kind: "lost" };

/**
 * What a new comment is on: the text selected in the document, or the whole
 * file (no range). A selection the anchor vocabulary can't name (Markdown
 * text above the first h1-h3, which md-section requires server-side) is
 * still offered, as a comment on the whole file: it records nothing
 * positional rather than a place it can't keep.
 */
type Selected = { anchor: CommentAnchor | null; range: Range | null };

/** What the narrow layout's bottom sheet shows. */
type Sheet =
  | { kind: "top" }
  | { kind: "discussion"; key: string }
  | { kind: "new"; selected: Selected };

// Cards for the whole file and for lost positions go to the top, in that
// order, stacked in ONE margin item at top 0. Separate items can't all sit at
// the top: resolveCommentMarginLayout bounds each item above the open card by
// its own top, so a second top item (or a negative top) always reads as "the
// cards above don't fit" and the open card (or the add button) is never
// pinned level with its passage.
const SELECTION_KEY = "\u0000selection";
const TOP_MARKER = "\u0000top";
const DRAFT_KEY = "\u0000draft";

/**
 * The top of what the person is doing now (the add button, the new comment),
 * a pixel above the selection: the margin orders items with the same top by
 * when they first rendered, so a card whose passage starts on the same line
 * would otherwise come first and push them below it.
 */
function aheadOf(top: number): number {
  return Math.max(top - 1, 0);
}

function rangeTop(range: Range): number | null {
  if (typeof range.getBoundingClientRect !== "function") return null;
  const rect = range.getBoundingClientRect();
  return Number.isFinite(rect.top) ? rect.top : null;
}

function rangeHit(range: Range, x: number, y: number): boolean {
  if (typeof range.getClientRects !== "function") return false;
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width === 0 && rect.height === 0) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

/** The passage a discussion is about, in words, for screen readers and the sheet. */
function passageText(anchor: StoredAnchor, formatMessage: ReturnType<typeof useIntl>["formatMessage"]): string {
  return anchorQuote(anchor) ?? anchorLabel(anchor, formatMessage);
}

function draftKeyFor(attachmentId: string, key: string): string {
  // The whole-file discussion keeps the panel's composer slot, so a draft
  // typed there before survives the move into the margin.
  return key === WHOLE_FILE_DISCUSSION_KEY
    ? `attachment-comment:${attachmentId}`
    : `attachment-comment:${attachmentId}:${discussionHash(key)}`;
}

function DiscussionEntry({ comment, clamp }: { comment: AttachmentComment; clamp?: boolean }) {
  const { formatMessageTime } = useTimeFormatter();
  return (
    <CommentEntry data-comment-id={comment.id}>
      <CommentEntryHeader>
        <AvatarSlot
          context="comment-entry"
          type={comment.senderType === "agent" ? "agent" : "human"}
          agentAvatarUrl={comment.senderType === "agent" ? comment.senderAvatarUrl : undefined}
          humanAvatarUrl={comment.senderType === "user" ? comment.senderAvatarUrl : undefined}
        />
        <CommentEntryAuthor>{comment.senderName}</CommentEntryAuthor>
        <CommentEntryTime dateTime={comment.createdAt}>{formatMessageTime(comment.createdAt)}</CommentEntryTime>
      </CommentEntryHeader>
      <CommentEntryBody clamp={clamp}>
        <MarkdownContent source={comment.content} density="compact" enableMermaid />
      </CommentEntryBody>
    </CommentEntry>
  );
}

/** The reply box: the inherited compact composer (task #20), delivering through the margin. */
function ReplyBox({
  draftKey,
  filename,
  parentChannelId,
  placeholder,
  onSend,
}: {
  draftKey: string;
  filename: string;
  parentChannelId: string;
  placeholder: string;
  onSend: (content: string, mentions: MessageMention[]) => Promise<void>;
}) {
  return (
    <div data-message-affordance="attachment-comment-composer">
      <MessageInput
        channelId={draftKey}
        channelName={filename}
        placeholder={placeholder}
        variant="compact"
        mentionChannelId={parentChannelId}
        isChannelThread
        onSendOverride={onSend}
      />
    </div>
  );
}

function BlockedLine({ children }: { children: ReactNode }) {
  return (
    <p data-message-affordance="attachment-comment-composer-disabled" className="text-footnote text-foreground-hint">
      {children}
    </p>
  );
}

type FocusTarget = "card" | "input" | "trigger";

/**
 * One discussion in the margin. Collapsed: its first comment cut to 2 lines
 * and the number of replies, the whole card a button that opens it. Open:
 * every comment and the reply box, focus inside (the reply box from the
 * keyboard, the card after a click), Esc closes it and returns focus to it.
 */
function DiscussionCard({
  discussion,
  note,
  lost = false,
  quote,
  active,
  focusOnOpen,
  onOpen,
  onClose,
  reply,
}: {
  discussion: CommentDiscussion;
  /** "On the whole file" / "Position not found". */
  note?: string;
  /** The note says the passage is gone. */
  lost?: boolean;
  /** The passage, in words, for screen readers. */
  quote?: string;
  active: boolean;
  /** Where focus goes when this card opens; read once per opening. */
  focusOnOpen: React.RefObject<{ key: string; target: FocusTarget } | null>;
  onOpen: (key: string, target: FocusTarget) => void;
  onClose: (key: string, returnFocus: boolean) => void;
  reply: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const card = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const noteId = useId();
  const quoteId = useId();
  const [first, ...replies] = discussion.comments;

  useEffect(() => {
    const request = focusOnOpen.current;
    if (!request || request.key !== discussion.key) return;
    focusOnOpen.current = null;
    if (request.target === "input") {
      const input = card.current?.querySelector<HTMLTextAreaElement>("textarea");
      (input ?? card.current)?.focus({ preventScroll: true });
    } else if (request.target === "card") {
      card.current?.focus({ preventScroll: true });
    } else {
      trigger.current?.focus({ preventScroll: true });
    }
  }, [active, discussion.key, focusOnOpen]);

  const open = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    // A click from Enter or Space has no pointer detail: go to the reply box.
    onOpen(discussion.key, event.detail === 0 ? "input" : "card");
  }, [discussion.key, onOpen]);

  const keyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Esc inside an open card is the card's, never the viewer's.
    event.stopPropagation();
    // A mention popover in the reply box took this one.
    if (event.defaultPrevented) return;
    event.preventDefault();
    onClose(discussion.key, true);
  }, [discussion.key, onClose]);

  const where = (
    <>
      {note ? (
        <CommentCardMeta id={noteId}>
          {lost ? <MapPinOff aria-hidden /> : null}
          {note}
        </CommentCardMeta>
      ) : null}
      {quote ? (
        <CommentCardQuote id={quoteId}>{formatMessage({ id: "message.attachmentComments.onPassage" }, { quote })}</CommentCardQuote>
      ) : null}
    </>
  );

  if (!active || !first) {
    return (
      <CommentCard data-discussion-key={discussion.key}>
        {where}
        {first ? <DiscussionEntry comment={first} clamp /> : null}
        {replies.length > 0 ? (
          <CommentCardMeta>
            <CommentIcon aria-hidden />
            {formatMessage({ id: "message.attachmentComments.replyCount" }, { count: replies.length })}
          </CommentCardMeta>
        ) : null}
        <CommentCardTrigger
          ref={trigger}
          aria-label={formatMessage({ id: "message.attachmentComments.commentFrom" }, { name: first?.senderName ?? "" })}
          aria-describedby={[note ? noteId : "", quote ? quoteId : ""].join(" ").trim() || undefined}
          onClick={open}
        />
      </CommentCard>
    );
  }

  return (
    <CommentCard
      active
      ref={card}
      tabIndex={-1}
      onKeyDown={keyDown}
      data-discussion-key={discussion.key}
      className="outline-none"
    >
      {where}
      {discussion.comments.map((comment) => (
        <DiscussionEntry key={comment.id} comment={comment} />
      ))}
      {reply}
    </CommentCard>
  );
}

/** A marker beside a passage (or at the top) where the margin doesn't fit. */
function Marker({
  id,
  comments,
  description,
  active,
  onOpen,
}: {
  /** The discussion's key, or TOP_MARKER for the whole file and lost positions. */
  id: string;
  comments: AttachmentComment[];
  description: string;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const descriptionId = useId();
  const open = useCallback(() => onOpen(id), [id, onOpen]);
  const authors = [...new Map(comments.map((comment) => [`${comment.senderType}:${comment.senderId}`, comment])).values()];
  return (
    <>
      <CommentMarker
        active={active}
        aria-label={formatMessage({ id: "message.attachmentComments.commentCount" }, { count: comments.length })}
        aria-describedby={descriptionId}
        onClick={open}
      >
        <AvatarGroup render={<span />}>
          {authors.slice(0, 3).map((author) => (
            <AvatarSlot
              key={`${author.senderType}:${author.senderId}`}
              context="comment-marker"
              type={author.senderType === "agent" ? "agent" : "human"}
              agentAvatarUrl={author.senderType === "agent" ? author.senderAvatarUrl : undefined}
              humanAvatarUrl={author.senderType === "user" ? author.senderAvatarUrl : undefined}
            />
          ))}
        </AvatarGroup>
        {comments.length}
      </CommentMarker>
      <CommentCardQuote id={descriptionId}>{description}</CommentCardQuote>
    </>
  );
}

/**
 * The add-comment button, level with the selected text. It takes its place
 * in the margin like a card (pinned there unless a card is open), so the
 * cards beside the selection move out of its way instead of sitting under it.
 */
function AddCommentButton({
  top,
  pinned,
  overlay = false,
  onAdd,
}: {
  top: number;
  pinned: boolean;
  /** No margin is laid out (no comments yet): float at the document's right edge instead. */
  overlay?: boolean;
  onAdd: () => void;
}) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "message.attachmentComments.addComment" });
  const shortcut = useShortcutBinding("comment-selection");
  // Keep the document's selection: the button comments on it.
  const keepSelection = useCallback((event: ReactMouseEvent) => event.preventDefault(), []);
  const button = (
    <AttachmentTooltip
      content={shortcut.combos[0] ? labelWithShortcut(label, shortcut.combos[0], formatMessage) : label}
    >
      <Button
        type="button"
        variant="outline"
        size="icon-md"
        aria-label={label}
        aria-keyshortcuts={shortcut.ariaKeyShortcuts || undefined}
        data-message-affordance="attachment-comment-add"
        onMouseDown={keepSelection}
        onClick={onAdd}
      >
        <AddCommentIcon aria-hidden />
      </Button>
    </AttachmentTooltip>
  );
  if (overlay) {
    // A layer over the document's right edge: showing the button never
    // reflows the text being selected.
    return (
      <div className="absolute right-4 z-raised" style={{ top: Math.max(top, 0) }}>
        {button}
      </div>
    );
  }
  return (
    <CommentMarginItem top={top} active={pinned}>
      {button}
    </CommentMarginItem>
  );
}

export function AttachmentCommentMargin({
  attachmentId,
  filename,
  parentMessage,
  shown,
  data,
  actionsRef,
  children,
}: {
  attachmentId: string;
  filename: string;
  parentMessage: Pick<Message, "id" | "channelId">;
  /** The header's show/hide comments toggle. Hidden: no cards, markers or highlights. */
  shown: boolean;
  /** The attachment's comments: the shell loads them, since its header
   *  button acts on whether there are any. */
  data: AttachmentCommentsState;
  /** Lets the header's Comments button start a comment on the whole file. */
  actionsRef?: React.Ref<AttachmentCommentMarginActions>;
  /** The document. */
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const { comments, pendingComments, canComment, writeBlockedCopy, error, send } = data;
  const [viewerElement, setViewerElement] = useState<HTMLDivElement | null>(null);
  const [documentElement, setDocumentElement] = useState<HTMLDivElement | null>(null);
  const [marginElement, setMarginElement] = useState<HTMLElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const fits = useCommentMarginFits(viewerElement);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [draft, setDraft] = useState<Selected | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const focusOnOpen = useRef<{ key: string; target: FocusTarget } | null>(null);

  // Hiding comments closes whatever was open: shown again, nothing is. The
  // same when the viewer crosses between the margin and the markers: cards
  // and the sheet are different trees, and an open state neither of them
  // shows would keep a strong highlight and swallow the next Esc.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- prev-value tracker for the React-docs "adjust state during render" pattern; it stores the PREVIOUS layout to detect a change.
  const [lastLayout, setLastLayout] = useState({ shown, fits });
  if (shown !== lastLayout.shown || fits !== lastLayout.fits) {
    setLastLayout({ shown, fits });
    setActiveKey(null);
    setSelected(null);
    setDraft(null);
    setSheet(null);
  }

  const discussions = useMemo(
    () => (comments ? groupDiscussions(comments, pendingComments) : []),
    [comments, pendingComments],
  );

  // Where each anchored discussion is in the document. Recomputed when the
  // comments change and when the document's DOM changes under them (a
  // Mermaid diagram rendering, a late re-render); never by changing it.
  const [contentVersion, bumpContentVersion] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    if (!documentElement || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(bumpContentVersion);
    });
    observer.observe(documentElement, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [documentElement]);

  const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(() => new Map());
  useLayoutEffect(() => {
    const next = new Map<string, Placement>();
    if (documentElement && shown) {
      for (const discussion of discussions) {
        if (!discussion.anchor) continue;
        const placed = placeAnchor(documentElement, discussion.anchor);
        // An anchor this document can't measure has no place in it either:
        // it goes to the top with the lost ones, never onto other text.
        next.set(discussion.key, placed.kind === "placed" ? placed : { kind: "lost" });
      }
    }
    setPlacements(next);
  }, [documentElement, discussions, shown, contentVersion]);

  // Each passage's top, measured from the margin's top, again whenever the
  // document rewraps (the viewer resizes, a font loads).
  const [tops, setTops] = useState<Readonly<Record<string, number>>>({});
  const measure = useCallback(() => {
    // From the margin's top; with no margin laid out (no comments yet), from
    // the viewer's, where the add-comment button then floats.
    const originElement = marginElement ?? viewerElement;
    if (!originElement) return;
    const origin = originElement.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    const add = (key: string, range: Range) => {
      const top = rangeTop(range);
      if (top !== null) next[key] = Math.round(top - origin);
    };
    for (const [key, placement] of placements) {
      if (placement.kind === "placed") add(key, placement.range);
    }
    if (selected?.range) add(SELECTION_KEY, selected.range);
    const newRange = draft?.range ?? (sheet?.kind === "new" ? sheet.selected.range : null);
    if (newRange) add(DRAFT_KEY, newRange);
    setTops((current) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key])) return current;
      return next;
    });
  }, [marginElement, viewerElement, placements, selected, draft, sheet]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    if (!documentElement) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    observer?.observe(documentElement);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    let live = true;
    void fonts?.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [documentElement, measure]);

  // What the document's selection can be commented as, if anything.
  const readSelection = useCallback((): Selected | null => {
    if (!documentElement) return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!documentElement.contains(range.startContainer) || !documentElement.contains(range.endContainer)) return null;
    const anchor = captureSelectionAnchor();
    if (anchor) return { anchor, range: range.cloneRange() };
    // Markdown text above the first h1-h3 has no section to anchor to, and
    // the server only accepts md-section with a heading: comment on the
    // whole file instead of offering nothing.
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    return start?.closest("[data-anchor-md-root]") ? { anchor: null, range: range.cloneRange() } : null;
  }, [documentElement]);

  // A selection inside the document offers the add-comment button.
  useEffect(() => {
    if (!shown || !canComment || !documentElement) return;
    let timer: number | null = null;
    const update = () => setSelected(readSelection());
    const onSelectionChange = () => {
      if (timer !== null) window.clearTimeout(timer);
      // selectionchange streams while a drag or the touch handles move.
      timer = window.setTimeout(update, 120);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [shown, canComment, documentElement, readSelection]);

  const openKey = sheet?.kind === "discussion" ? sheet.key : activeKey;

  // The passages, highlighted without touching the document's DOM: every
  // commented passage softly, the open one (or the text a new comment is
  // being written on) strongly. Inexact placements (only the section's
  // heading was found) sit by the heading but highlight nothing: the quoted
  // words aren't there any more.
  useEffect(() => {
    if (!shown) return;
    const newRange = draft?.range ?? (sheet?.kind === "new" ? sheet.selected.range : null);
    const openPlacement = openKey ? placements.get(openKey) : undefined;
    const activeRange = newRange ?? (openPlacement?.kind === "placed" && openPlacement.exact ? openPlacement.range : null);
    const passive: Range[] = [];
    for (const [key, placement] of placements) {
      if (placement.kind === "placed" && placement.exact && key !== openKey) passive.push(placement.range);
    }
    const clearPassive = setCommentHighlights(COMMENT_HIGHLIGHT, passive);
    const clearActive = setCommentHighlights(COMMENT_HIGHLIGHT_ACTIVE, activeRange ? [activeRange] : []);
    return () => {
      clearPassive();
      clearActive();
    };
  }, [shown, placements, openKey, draft, sheet]);

  const openDiscussion = useCallback((key: string, target: FocusTarget) => {
    focusOnOpen.current = { key, target };
    setDraft(null);
    setActiveKey(key);
  }, []);

  const closeDiscussion = useCallback((key: string, returnFocus: boolean) => {
    if (returnFocus) focusOnOpen.current = { key, target: "trigger" };
    setActiveKey(null);
  }, []);

  const closeAll = useCallback(() => {
    setActiveKey(null);
    setDraft(null);
    setSheet(null);
  }, []);

  // Esc closes the open card (or the new comment, or the sheet) before the
  // file viewer's own Esc closes the viewer. Inside the margin and the sheet
  // their own key handlers decide (a mention popover may take the key first);
  // anywhere else in the viewer, this capture listener takes it.
  const somethingOpen = activeKey !== null || draft !== null || sheet !== null;
  // A capture-phase layer: it closes the open comment card before the file viewer's own Esc closes the viewer.
  useShortcutLayer("commentCard", somethingOpen, {
    phase: "capture",
    stopPropagation: true,
    onEscape: (event) => {
      const target = event.target;
      if (target instanceof Node && (columnRef.current?.contains(target) || sheetRef.current?.contains(target))) return false;
      // A dialog other than the viewer itself (raft-ui's Lightbox is one) keeps its Esc: a sheet, a confirm.
      if (target instanceof Element && target.closest('[role="menu"], [role="listbox"], [role="dialog"]:not([data-slot="lightbox-content"]), input, textarea, [contenteditable="true"]')) return false;
      closeAll();
    },
  });

  // Esc anywhere else in the margin (a collapsed card's trigger, the add
  // button) also closes what is open rather than the viewer.
  const onColumnKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || (activeKey === null && draft === null)) return;
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (draft) setDraft(null);
    else setActiveKey(null);
  }, [activeKey, draft]);

  // Clicking a highlighted passage opens its discussion; clicking elsewhere
  // in the document closes the open one (a new comment stays until sent or
  // cancelled).
  const onDocumentClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!shown) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    let hit: { key: string; length: number } | null = null;
    for (const [key, placement] of placements) {
      if (placement.kind !== "placed" || !placement.exact) continue;
      if (!rangeHit(placement.range, event.clientX, event.clientY)) continue;
      const length = placement.range.toString().length;
      if (!hit || length < hit.length) hit = { key, length };
    }
    if (hit) {
      if (fits) openDiscussion(hit.key, "card");
      else setSheet({ kind: "discussion", key: hit.key });
    } else if (activeKey !== null) {
      setActiveKey(null);
    }
  }, [shown, placements, fits, openDiscussion, activeKey]);

  const commentOn = useCallback((target: Selected) => {
    if (fits) {
      focusOnOpen.current = { key: DRAFT_KEY, target: "input" };
      setActiveKey(null);
      setDraft(target);
    } else {
      setSheet({ kind: "new", selected: target });
    }
    setSelected(null);
  }, [fits]);
  const startComment = useCallback(() => {
    if (selected) commentOn(selected);
  }, [selected, commentOn]);

  // ⌘⌥M / Ctrl+Alt+M comments on the selection, as the add-comment button
  // does, whenever the button could be offered: not while a new comment is
  // open, nor from a text field (the reply box, the mention picker).
  const canStartComment = shown && canComment && draft === null && (fits || sheet === null);
  // Through the registry ("comment-selection", the person's keys): heard wherever the focus is, since the document's
  // text selection never holds it, and never from a text field (the reply box, the mention picker); the new card
  // then focuses its own reply box.
  useShortcut("comment-selection", () => {
    // Read now: the button's copy of the selection lags it by a debounce.
    const current = readSelection();
    if (!current) return false;
    commentOn(current);
  }, { enabled: canStartComment, ambient: true });

  const cancelDraft = useCallback(() => setDraft(null), []);

  // Replying in a discussion posts a comment with the discussion's anchor
  // (none for the whole file), so it lands back in the same card.
  const replyTo = useCallback((anchor: StoredAnchor | null) => (
    async (content: string, mentions: MessageMention[]) => {
      await send(content, mentions, anchor);
    }
  ), [send]);

  const sendNew = useCallback(async (content: string, mentions: MessageMention[]) => {
    const target = draft ?? (sheet?.kind === "new" ? sheet.selected : null);
    if (!target) return;
    const key = discussionKey(target.anchor);
    await send(content, mentions, target.anchor, {
      onAccepted: () => {
        // The new discussion opens where it was started.
        if (draft) {
          focusOnOpen.current = { key, target: "card" };
          setDraft(null);
          setActiveKey(key);
        } else {
          setSheet({ kind: "discussion", key });
        }
      },
    });
  }, [draft, sheet, send]);

  const replyPlaceholder = formatMessage({ id: "message.attachmentComments.replyPlaceholder" });
  const replyBox = (discussion: CommentDiscussion) => (canComment ? (
    <ReplyBox
      draftKey={draftKeyFor(attachmentId, discussion.key)}
      filename={filename}
      parentChannelId={parentMessage.channelId}
      placeholder={replyPlaceholder}
      onSend={replyTo(discussion.anchor)}
    />
  ) : (
    <BlockedLine>{writeBlockedCopy}</BlockedLine>
  ));
  const newCommentBox = (
    <ReplyBox
      draftKey={`attachment-comment:${attachmentId}:new`}
      filename={filename}
      parentChannelId={parentMessage.channelId}
      placeholder={formatMessage({ id: "message.attachmentComments.newCommentPlaceholder" })}
      onSend={sendNew}
    />
  );

  // Reading order, which is also the margin's order: the whole file, the
  // lost positions, then the passages from the top of the document.
  const draftKeyForNew = draft ? discussionKey(draft.anchor) : null;
  // While a new comment is being sent its optimistic copy belongs to the
  // card it is written in, not a second card beside it.
  const onlyBeingWritten = useCallback(
    (discussion: CommentDiscussion) =>
      discussion.key === draftKeyForNew && discussion.comments.every((c) => c.id.startsWith("optimistic-")),
    [draftKeyForNew],
  );
  const wholeFileDiscussion = discussions.find((discussion) => discussion.key === WHOLE_FILE_DISCUSSION_KEY) ?? null;
  const wholeFile = wholeFileDiscussion && !onlyBeingWritten(wholeFileDiscussion) ? wholeFileDiscussion : null;
  const lost = useMemo(
    () => discussions.filter((discussion) => discussion.anchor && placements.get(discussion.key)?.kind === "lost"),
    [discussions, placements],
  );
  const topKeys = useMemo(
    () => [...(wholeFile ? [wholeFile.key] : []), ...lost.map((discussion) => discussion.key)],
    [wholeFile, lost],
  );
  // The narrow layout's top marker holds both.
  const topComments = useMemo(
    () => [...(wholeFile?.comments ?? []), ...lost.flatMap((discussion) => discussion.comments)],
    [wholeFile, lost],
  );
  const openSheet = useCallback((id: string) => {
    setSheet(id === TOP_MARKER ? { kind: "top" } : { kind: "discussion", key: id });
  }, []);
  const placed = discussions
    .filter((discussion) => placements.get(discussion.key)?.kind === "placed")
    .filter((discussion) => !onlyBeingWritten(discussion))
    .map((discussion, index) => ({ discussion, index, top: tops[discussion.key] ?? 0 }))
    .sort((a, b) => a.top - b.top || a.index - b.index);

  // A comment on the whole file: its card when there is one, else a new
  // comment card at the top (the sheet's reply box where the margin doesn't
  // fit). The margin's "Comment on file" button and, on a file with no
  // comments yet, the header's Comments button start one.
  const openFileComment = useCallback(() => {
    if (!canComment) return;
    if (!fits) {
      setSheet({ kind: "top" });
    } else if (wholeFileDiscussion) {
      openDiscussion(wholeFileDiscussion.key, "input");
    } else {
      focusOnOpen.current = { key: DRAFT_KEY, target: "input" };
      setActiveKey(null);
      setDraft({ anchor: null, range: null });
    }
  }, [canComment, fits, wholeFileDiscussion, openDiscussion]);
  useImperativeHandle(actionsRef, () => ({ commentOnFile: openFileComment }), [openFileComment]);

  const hasDiscussions = discussions.length > 0;

  const noteWholeFile = formatMessage({ id: "message.attachmentComments.onWholeFile" });
  const noteLost = formatMessage({ id: "message.attachmentComments.positionNotFound" });
  const commentOnFileLabel = formatMessage({ id: "message.attachmentComments.commentOnFile" });

  // Show nothing where there are no comments (comments.md): the margin (and
  // its "Comments" landmark) is laid out only while it has something in it.
  // Until then the add-comment button floats over the document's right edge,
  // so selecting never reflows the text; the document makes room once the
  // first comment is being written.
  const showColumn = shown && (hasDiscussions || error !== null || (fits && draft !== null));
  const selectionTop = selected ? tops[SELECTION_KEY] : undefined;
  const showAdd = canStartComment && selected !== null && selectionTop !== undefined;
  const offerFileComment = canComment && !wholeFileDiscussion && draft === null;
  // A new comment on the whole file (no passage to sit by) opens first at
  // the top, above any lost positions, as the whole file's card would.
  const fileDraft = draft !== null && draft.range === null;

  const newCommentCard = draft ? (
    <NewCommentCard
      note={draft.anchor ? undefined : noteWholeFile}
      quote={draft.anchor ? passageText(draft.anchor, formatMessage) : undefined}
      focusOnOpen={focusOnOpen}
      onCancel={cancelDraft}
    >
      {newCommentBox}
    </NewCommentCard>
  ) : null;

  // The column's top inset (pt-4, the text and CSV panes' own padding) keeps
  // the cards and markers at the top off the viewer's header.
  let column: ReactNode = null;
  if (showColumn && fits) {
    column = (
      <div ref={columnRef} className="relative ml-2 mr-4 w-[280px] shrink-0 pt-4" onKeyDown={onColumnKeyDown}>
        {error ? (
          <p role="status" className="py-1 text-caption text-danger-strong" data-message-affordance="attachment-comments-load-error">
            {error}
          </p>
        ) : null}
        <CommentMargin
          ref={setMarginElement}
          render={<aside aria-label={formatMessage({ id: "message.attachmentComments.title" })} />}
          className="w-full"
          data-testid="attachment-comment-margin"
        >
          {wholeFile || lost.length > 0 || (offerFileComment && hasDiscussions) || fileDraft ? (
            <CommentMarginItem
              top={0}
              active={fileDraft || (activeKey !== null && topKeys.includes(activeKey))}
              className="flex flex-col gap-2"
            >
              {fileDraft ? newCommentCard : null}
              {offerFileComment && hasDiscussions ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  className="self-start"
                  data-message-affordance="attachment-comment-on-file"
                  onClick={openFileComment}
                >
                  <AddCommentIcon aria-hidden />
                  {commentOnFileLabel}
                </Button>
              ) : null}
              {wholeFile ? (
                <DiscussionCard
                  discussion={wholeFile}
                  note={noteWholeFile}
                  active={activeKey === wholeFile.key}
                  focusOnOpen={focusOnOpen}
                  onOpen={openDiscussion}
                  onClose={closeDiscussion}
                  reply={replyBox(wholeFile)}
                />
              ) : null}
              {lost.map((discussion) => (
                <DiscussionCard
                  key={discussion.key}
                  discussion={discussion}
                  note={noteLost}
                  lost
                  quote={discussion.anchor ? passageText(discussion.anchor, formatMessage) : undefined}
                  active={activeKey === discussion.key}
                  focusOnOpen={focusOnOpen}
                  onOpen={openDiscussion}
                  onClose={closeDiscussion}
                  reply={replyBox(discussion)}
                />
              ))}
            </CommentMarginItem>
          ) : null}
          {placed.map(({ discussion, top }) => (
            <CommentMarginItem key={discussion.key} top={top} active={activeKey === discussion.key}>
              <DiscussionCard
                discussion={discussion}
                quote={discussion.anchor ? passageText(discussion.anchor, formatMessage) : undefined}
                active={activeKey === discussion.key}
                focusOnOpen={focusOnOpen}
                onOpen={openDiscussion}
                onClose={closeDiscussion}
                reply={replyBox(discussion)}
              />
            </CommentMarginItem>
          ))}
          {draft?.range ? (
            // Until the draft's own range is measured, it sits where the
            // selection was measured: a first frame at 0 would scroll the
            // viewer to the top of the margin.
            <CommentMarginItem top={aheadOf(tops[DRAFT_KEY] ?? tops[SELECTION_KEY] ?? 0)} active>
              {newCommentCard}
            </CommentMarginItem>
          ) : null}
          {showAdd ? <AddCommentButton top={aheadOf(selectionTop)} pinned={activeKey === null} onAdd={startComment} /> : null}
        </CommentMargin>
      </div>
    );
  } else if (showColumn) {
    column = (
      <div ref={columnRef} className="relative mr-2 w-18 shrink-0 pt-4">
        {error ? (
          <AttachmentTooltip content={error}>
            <span role="status" aria-label={error} className="flex h-7 items-center text-danger-strong" data-message-affordance="attachment-comments-load-error">
              <TriangleAlert aria-hidden className="size-4" />
            </span>
          </AttachmentTooltip>
        ) : null}
        <CommentMargin
          ref={setMarginElement}
          render={<aside aria-label={formatMessage({ id: "message.attachmentComments.title" })} />}
          className="w-full"
          gap={4}
          data-testid="attachment-comment-markers"
        >
          {topComments.length > 0 ? (
            <CommentMarginItem top={0}>
              <Marker
                id={TOP_MARKER}
                comments={topComments}
                description={lost.length > 0 ? formatMessage({ id: "message.attachmentComments.wholeFileAndLost" }) : noteWholeFile}
                active={sheet?.kind === "top"}
                onOpen={openSheet}
              />
            </CommentMarginItem>
          ) : offerFileComment ? (
            <CommentMarginItem top={0}>
              <AttachmentTooltip content={commentOnFileLabel}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-md"
                  aria-label={commentOnFileLabel}
                  data-message-affordance="attachment-comment-on-file"
                  onClick={openFileComment}
                >
                  <AddCommentIcon aria-hidden />
                </Button>
              </AttachmentTooltip>
            </CommentMarginItem>
          ) : null}
          {placed.map(({ discussion, top }) => (
            <CommentMarginItem key={discussion.key} top={top}>
              <Marker
                id={discussion.key}
                comments={discussion.comments}
                description={formatMessage(
                  { id: "message.attachmentComments.onPassage" },
                  { quote: discussion.anchor ? passageText(discussion.anchor, formatMessage) : "" },
                )}
                active={openKey === discussion.key}
                onOpen={openSheet}
              />
            </CommentMarginItem>
          ))}
          {showAdd ? <AddCommentButton top={aheadOf(selectionTop)} pinned onAdd={startComment} /> : null}
        </CommentMargin>
      </div>
    );
  }
  const overlayAdd = showAdd && column === null
    ? <AddCommentButton top={selectionTop} pinned={false} overlay onAdd={startComment} />
    : null;

  // The bottom sheet of the narrow layout.
  const sheetDiscussion = sheet?.kind === "discussion"
    ? discussions.find((discussion) => discussion.key === sheet.key) ?? null
    : null;
  let sheetTitle = "";
  let sheetDescription = "";
  let sheetBody: ReactNode = null;
  if (sheet?.kind === "top") {
    sheetTitle = topComments.length > 0
      ? formatMessage({ id: "message.attachmentComments.commentCount" }, { count: topComments.length })
      : formatMessage({ id: "message.attachmentComments.newCommentTitle" });
    sheetDescription = noteWholeFile;
    sheetBody = (
      <>
        {(wholeFile?.comments ?? []).map((comment) => <DiscussionEntry key={comment.id} comment={comment} />)}
        {canComment ? (
          <ReplyBox
            draftKey={draftKeyFor(attachmentId, WHOLE_FILE_DISCUSSION_KEY)}
            filename={filename}
            parentChannelId={parentMessage.channelId}
            placeholder={replyPlaceholder}
            onSend={replyTo(null)}
          />
        ) : <BlockedLine>{writeBlockedCopy}</BlockedLine>}
        {lost.map((discussion) => (
          <section key={discussion.key} className="flex flex-col gap-2" aria-label={noteLost}>
            <CommentCardMeta>
              <MapPinOff aria-hidden />
              {noteLost}
            </CommentCardMeta>
            {discussion.anchor ? (
              <CommentCardQuote>
                {formatMessage({ id: "message.attachmentComments.wasOnPassage" }, { quote: passageText(discussion.anchor, formatMessage) })}
              </CommentCardQuote>
            ) : null}
            {discussion.comments.map((comment) => <DiscussionEntry key={comment.id} comment={comment} />)}
          </section>
        ))}
      </>
    );
  } else if (sheet?.kind === "discussion" && sheetDiscussion) {
    sheetTitle = formatMessage({ id: "message.attachmentComments.commentCount" }, { count: sheetDiscussion.comments.length });
    sheetDescription = sheetDiscussion.anchor
      ? formatMessage({ id: "message.attachmentComments.onPassage" }, { quote: passageText(sheetDiscussion.anchor, formatMessage) })
      : noteWholeFile;
    sheetBody = (
      <>
        {sheetDiscussion.comments.map((comment) => <DiscussionEntry key={comment.id} comment={comment} />)}
        {replyBox(sheetDiscussion)}
      </>
    );
  } else if (sheet?.kind === "new") {
    sheetTitle = formatMessage({ id: "message.attachmentComments.newCommentTitle" });
    sheetDescription = sheet.selected.anchor
      ? formatMessage({ id: "message.attachmentComments.onPassage" }, { quote: passageText(sheet.selected.anchor, formatMessage) })
      : noteWholeFile;
    sheetBody = newCommentBox;
  }

  const changeSheetOpen = useCallback((open: boolean) => {
    if (!open) setSheet(null);
  }, []);
  const onSheetKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // The sheet's Esc closes the sheet, never the viewer behind it.
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    setSheet(null);
  }, []);

  return (
    // isolate: an open card lifts above the others (its own z-index), which
    // must stay inside the viewer.
    <div ref={setViewerElement} className="relative isolate flex w-full min-w-0 items-start" data-comment-viewer="">
      <div ref={setDocumentElement} className="min-w-0 flex-1" onClick={onDocumentClick}>
        {children}
      </div>
      {column}
      {overlayAdd}
      {!fits && shown ? (
        <Drawer open={sheet !== null} onOpenChange={changeSheetOpen}>
          <DrawerContent ref={sheetRef} onKeyDown={onSheetKeyDown} data-testid="attachment-comment-sheet">
            <DrawerHeader>
              <DrawerTitle>{sheetTitle}</DrawerTitle>
              <DrawerDescription>{sheetDescription}</DrawerDescription>
            </DrawerHeader>
            <DrawerBody render={<ScrollArea tabIndex={-1} contentClassName="flex flex-col gap-4" />} className="min-h-0">{sheetBody}</DrawerBody>
            <DrawerFooter>
              <DrawerActions>
                <DrawerClose render={<Button variant="outline" size="lg" />}>
                  {formatMessage({ id: "common.close" })}
                </DrawerClose>
              </DrawerActions>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      ) : null}
    </div>
  );
}

/** The card a new comment is written in, level with the selected text. */
function NewCommentCard({
  note,
  quote,
  focusOnOpen,
  onCancel,
  children,
}: {
  /** "On the whole file", for a comment that isn't on a passage. */
  note?: string;
  quote?: string;
  focusOnOpen: React.RefObject<{ key: string; target: FocusTarget } | null>;
  onCancel: () => void;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const card = useRef<HTMLDivElement>(null);
  const describedById = useId();
  useEffect(() => {
    if (focusOnOpen.current?.key !== DRAFT_KEY) return;
    focusOnOpen.current = null;
    const input = card.current?.querySelector<HTMLTextAreaElement>("textarea");
    (input ?? card.current)?.focus({ preventScroll: true });
    // A selection near the bottom of the viewport would open the card partly
    // below it: bring the whole card in, moving the page as little as can be,
    // once the margin has placed it (the body scrolls under the header, not behind it).
    // Not cancelled on cleanup: the request is consumed above, so a StrictMode
    // replay of this effect would never scroll; an unmounted card has no ref.
    requestAnimationFrame(() => card.current?.scrollIntoView({ block: "nearest" }));
  }, [focusOnOpen]);
  const keyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    onCancel();
  }, [onCancel]);
  return (
    <CommentCard
      active
      ref={card}
      tabIndex={-1}
      aria-describedby={quote || note ? describedById : undefined}
      onKeyDown={keyDown}
      data-message-affordance="attachment-comment-new"
      className="scroll-mt-4 scroll-mb-4 outline-none"
    >
      {/* What the comment is on, said once: the visible note for the whole
          file, else the passage (hidden on screen, where the highlight says it). */}
      {quote ? (
        <CommentCardQuote id={describedById}>
          {formatMessage({ id: "message.attachmentComments.onPassage" }, { quote })}
        </CommentCardQuote>
      ) : note ? (
        <CommentCardMeta id={describedById}>{note}</CommentCardMeta>
      ) : null}
      {children}
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="md" onClick={onCancel}>
          {formatMessage({ id: "common.confirm.cancel" })}
        </Button>
      </div>
    </CommentCard>
  );
}
