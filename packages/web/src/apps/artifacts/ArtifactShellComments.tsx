import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { AvatarGroup, Button } from "@botiverse/raft-ui";
import { AddCommentIcon } from "@botiverse/ricons";
import {
  COMMENT_HIGHLIGHT,
  COMMENT_HIGHLIGHT_ACTIVE,
  CommentCardQuote,
  CommentMargin,
  CommentMarginItem,
  CommentMarker,
  setCommentHighlights,
} from "@botiverse/raft-ui/wip";
import type { ArtifactCommentDraft, ArtifactCommentId } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { labelWithShortcut } from "../../components/ui/LabelWithShortcut";
import { useShortcut, useShortcutBinding } from "../../features/shortcuts";
import { ArtifactActorAvatar, anchorLabel } from "./ArtifactActorParts";
import { actorKey, anchorOf, buildThreads, isResolvedThread, isShellAnchor, shellAnchorFound, shortQuote } from "./artifactComments";
import type { ArtifactCommentThread, ShellAnchor } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useArtifactReview } from "./ArtifactReviewContext";
import { ShellDraftMarker } from "./ArtifactShellDraftMarker";

type UnitKind = ShellAnchor["type"];
const UNIT_ATTR: Record<UnitKind, string> = { lines: "data-anchor-line", "csv-rows": "data-anchor-row" };

interface Marked {
  thread: ArtifactCommentThread;
  anchor: ShellAnchor;
}

/** A draft of the person's on this file's lines or rows: its marker, keyed apart from the threads' in `tops`. */
interface DraftMarked {
  draft: ArtifactCommentDraft;
  anchor: ShellAnchor;
  key: string;
}

/** The DOM range of units `start`–`end` (their text), or null when they aren't drawn. */
function unitRange(doc: HTMLElement, kind: UnitKind, start: number, end: number): Range | null {
  const first = doc.querySelector(`[${UNIT_ATTR[kind]}="${start}"]`);
  const last = doc.querySelector(`[${UNIT_ATTR[kind]}="${end}"]`);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.childNodes.length);
  return range;
}

/** The unit an element is in, by its data attribute. */
function unitOf(node: Node | null, kind: UnitKind): number | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  const unit = element?.closest(`[${UNIT_ATTR[kind]}]`);
  const n = Number(unit?.getAttribute(UNIT_ATTR[kind]));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Comments on a text or csv file the shell draws itself (F37: lines and
 * rows, as attachment comments do, RFC 036). Beside the document, a
 * `CommentMargin` holds a `CommentMarker` level with each commented passage
 * (the layout raft-ui gives a viewer with no room for cards; the comment
 * list is the panel). The passages are highlighted with raft-ui's comment
 * highlight (CSS Custom Highlight API, the DOM is not changed); the thread
 * being read or hovered takes the active highlight.
 *
 * Selecting text offers Comment at the document's right edge, level with
 * the selection (⌘⌥M / Ctrl+Alt+M from the keyboard); it opens a new
 * comment's card there (ArtifactCommentBubble), on those lines or rows. A
 * marker opens its thread's card beside it, or, while the comment list is
 * open, the list on it (one list at a time). The person's drafts here have
 * markers of their own in the same margin, dashed and empty as a framed
 * page's draft pins (ArtifactShellDraftMarker; not in C, which lists them). Landed on from Activity, the
 * thread's card opens at its marker. A new comment left unsent on its lines or
 * rows before a reload opens its card there again (useUnsentCommentOffer).
 *
 * Page content (html, markdown, pdf) is in the content-origin frame: Porthole
 * draws its markers and reports clicks (ArtifactCommentsContext `frame`);
 * nothing of this applies there.
 *
 * `units` are the file's lines or rows (1-based in the DOM through
 * `data-anchor-line` / `data-anchor-row`), so a moved or deleted passage
 * shows its place dimmed, as lost, in the list instead of a marker.
 */
export default function ArtifactShellComments({ kind, path, units, children }: { kind: UnitKind; path: string; units: readonly string[]; children: ReactNode }) {
  const intl = useIntl();
  const comments = useArtifactComments();
  const [doc, setDoc] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState<HTMLElement | null>(null);
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [tops, setTops] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<{ anchor: ShellAnchor; top: number } | null>(null);

  const setShellUnits = comments?.setShellUnits;
  useEffect(() => {
    if (!setShellUnits) return;
    setShellUnits({ path, units });
    return () => setShellUnits(null);
  }, [setShellUnits, path, units]);

  const loaded = comments?.comments ?? null;
  const hasEarlier = comments?.hasEarlier ?? false;
  const marked = useMemo<Marked[]>(() => {
    if (!loaded) return [];
    return buildThreads(loaded, { parentsMayBeOlder: hasEarlier }).flatMap((thread) => {
      const anchor = anchorOf(thread.first);
      const target = thread.first.target;
      // A resolved thread is marked no more (#249).
      if (isResolvedThread(thread) || !isShellAnchor(anchor) || anchor.type !== kind || target.scope !== "file" || target.path !== path) return [];
      return shellAnchorFound(anchor, units) ? [{ thread, anchor }] : [];
    });
  }, [loaded, hasEarlier, kind, path, units]);

  // The person's drafts on this file's lines or rows that are still where they point (a reply draft is its thread's).
  const review = useArtifactReview();
  const drafts = review && review.status !== "reviewing" ? review.drafts : null;
  const draftMarked = useMemo<DraftMarked[]>(() => (drafts ?? []).flatMap((draft) => {
    if (draft.replyTo || draft.target.scope !== "file" || draft.target.path !== path) return [];
    const anchor = draft.target.anchor ?? null;
    if (!isShellAnchor(anchor) || anchor.type !== kind || !shellAnchorFound(anchor, units)) return [];
    return [{ draft, anchor, key: `draft:${draft.id}` }];
  }), [drafts, path, kind, units]);

  // Where each marker goes: level with the first line of its passage.
  useLayoutEffect(() => {
    if (!doc || !margin) return;
    const measure = () => {
      const origin = margin.getBoundingClientRect().top;
      const next: Record<string, number> = {};
      for (const { key, anchor } of [...marked.map((m): { key: string; anchor: ShellAnchor } => ({ key: m.thread.id, anchor: m.anchor })), ...draftMarked]) {
        const unit = doc.querySelector(`[${UNIT_ATTR[kind]}="${anchor.data.start}"]`);
        if (unit) next[key] = Math.max(0, Math.round(unit.getBoundingClientRect().top - origin));
      }
      setTops(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(doc);
    return () => observer.disconnect();
  }, [doc, margin, marked, draftMarked, kind]);

  // Highlights: every commented passage, and the one being read (or hovered) as active.
  const active = comments?.hoveredThreadId ?? comments?.activeThreadId ?? null;
  useEffect(() => {
    if (!doc) return;
    const passive: Range[] = [];
    const current: Range[] = [];
    for (const { thread, anchor } of marked) {
      const range = unitRange(doc, kind, anchor.data.start, anchor.data.end);
      if (range) (thread.id === active ? current : passive).push(range);
    }
    const clearPassive = setCommentHighlights(COMMENT_HIGHLIGHT, passive);
    const clearActive = setCommentHighlights(COMMENT_HIGHLIGHT_ACTIVE, current);
    return () => {
      clearPassive();
      clearActive();
    };
  }, [doc, marked, active, kind]);

  // A selection inside the document becomes the place a comment can start.
  useEffect(() => {
    if (!doc || !frame || !comments?.data.capabilities.comment) return;
    const read = (): { anchor: ShellAnchor; top: number } | null => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      if (!doc.contains(range.commonAncestorContainer)) return null;
      const a = unitOf(range.startContainer, kind);
      const b = unitOf(range.endContainer, kind);
      if (a === null || b === null) return null;
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      const quote = kind === "lines" ? shortQuote(sel.toString()) : shortQuote(units.slice(start - 1, end).join("\n"));
      // (jsdom has no layout for ranges: the button then sits at the top.)
      const rect = typeof range.getClientRects === "function" ? range.getClientRects()[0] ?? range.getBoundingClientRect() : null;
      const top = rect ? Math.max(0, Math.round(rect.top - frame.getBoundingClientRect().top)) : 0;
      return { anchor: { type: kind, data: { start, end, ...(quote ? { quote } : {}) } }, top };
    };
    const update = () => setSelection(read());
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [doc, frame, kind, units, comments?.data.capabilities.comment]);

  const composeAt = comments?.composeAt;
  const [selectionButton, setSelectionButton] = useState<HTMLButtonElement | null>(null);
  const commentOnSelection = useCallback(() => {
    if (!selection || !composeAt) return;
    const box = selectionButton?.getBoundingClientRect();
    composeAt({ scope: "file", path, anchor: selection.anchor }, box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null);
  }, [selection, composeAt, path, selectionButton]);

  // Landed on from Activity: the thread's card at its marker, once drawn; a passage not found, the list.
  const shellLanding = comments?.shellLanding ?? null;
  const landBubble = comments?.landBubble;
  useLayoutEffect(() => {
    if (!shellLanding || !landBubble || !loaded) return;
    if (!marked.some((m) => m.thread.id === shellLanding)) {
      landBubble(null);
      return;
    }
    const marker = margin?.querySelector<HTMLElement>(`[data-testid='artifact-comment-marker'][data-thread-id="${CSS.escape(shellLanding)}"]`);
    if (!marker) return;
    const box = marker.getBoundingClientRect();
    landBubble({ x: box.left, y: box.top, width: box.width, height: box.height });
  }, [shellLanding, landBubble, loaded, marked, margin]);
  // A new comment left unsent here before a reload (useUnsentCommentOffer): its card opens again at
  // the document's right edge level with its passage, once drawn; a passage not found (the file
  // changed), the list's foot takes the words instead.
  const unsentAt = comments?.unsentAt ?? null;
  const reopenUnsent = comments?.reopenUnsent;
  useLayoutEffect(() => {
    if (!unsentAt || !reopenUnsent || unsentAt.scope !== "file" || unsentAt.path !== path || !isShellAnchor(unsentAt.anchor)) return;
    if (unsentAt.anchor.type !== kind || !shellAnchorFound(unsentAt.anchor, units)) {
      reopenUnsent(null);
      return;
    }
    const unit = doc?.querySelector(`[${UNIT_ATTR[kind]}="${unsentAt.anchor.data.start}"]`);
    if (!unit) return;
    const box = unit.getBoundingClientRect();
    reopenUnsent({ x: box.right, y: box.top, width: 0, height: box.height });
  }, [unsentAt, reopenUnsent, path, kind, units, doc]);
  // ⌘⌥M / Ctrl+Alt+M (or the person's keys) while text in the file is selected. After a mouse selection focus is on
  // the viewer (or the page), not in the file, so the shortcut is heard wherever the focus is while a selection exists.
  useShortcut("comment-selection", () => { commentOnSelection(); }, { enabled: !!selection, ambient: true });
  const commentShortcut = useShortcutBinding("comment-selection");
  // Keep the selection while the button is pressed.
  const keepSelection = useCallback((event: PointerEvent<HTMLButtonElement>) => event.preventDefault(), []);

  const selectionTop = selection?.top ?? 0;
  const selectionStyle = useMemo(() => ({ top: selectionTop }), [selectionTop]);
  if (!comments) return <>{children}</>;
  const commentLabel = intl.formatMessage({ id: "artifacts.comments.commentOnSelection" });
  const commentButton = (
    <Button
      ref={setSelectionButton}
      variant="outline"
      size="md"
      className="absolute end-2 z-float shadow-float"
      style={selectionStyle}
      onPointerDown={keepSelection}
      onClick={commentOnSelection}
      aria-keyshortcuts={commentShortcut.ariaKeyShortcuts || undefined}
      data-testid="artifact-comment-on-selection"
    >
      <AddCommentIcon />
      {commentLabel}
    </Button>
  );
  return (
    <div ref={setFrame} className="relative flex min-w-0 items-start">
      <div ref={setDoc} className="min-w-0 flex-1">{children}</div>
      {marked.length > 0 || draftMarked.length > 0 ? (
        <CommentMargin
          ref={setMargin}
          render={<aside aria-label={intl.formatMessage({ id: "artifacts.comments.markersLabel" })} />}
          className="w-18 shrink-0 self-stretch pe-2 pt-0"
          gap={4}
          data-testid="artifact-comment-markers"
        >
          {marked.map(({ thread, anchor }) => (
            <CommentMarginItem key={thread.id} top={tops[thread.id] ?? 0} active={thread.id === active}>
              <ShellMarker thread={thread} anchor={anchor} active={thread.id === active} />
            </CommentMarginItem>
          ))}
          {draftMarked.map(({ draft, anchor, key }) => (
            <CommentMarginItem key={key} top={tops[key] ?? 0}>
              <ShellDraftMarker draft={draft} anchor={anchor} />
            </CommentMarginItem>
          ))}
        </CommentMargin>
      ) : null}
      {/* The tooltip has the shortcut alone (#250): the button says Comment already; with no keys, no tooltip. */}
      {selection ? (
        commentShortcut.combos[0] ? (
          <Tooltip content={labelWithShortcut(null, commentShortcut.combos[0], intl.formatMessage)}>{commentButton}</Tooltip>
        ) : commentButton
      ) : null}
    </div>
  );
}

function ShellMarker({ thread, anchor, active }: { thread: ArtifactCommentThread; anchor: ShellAnchor; active: boolean }) {
  const intl = useIntl();
  const comments = useArtifactComments();
  const descriptionId = useId();
  const all = [...(thread.root ? [thread.root] : []), ...thread.replies].filter((c) => !c.deletedAt);
  const authors = [...new Map(all.map((c) => [actorKey(c.author), c.author])).values()].slice(0, 3);
  const id: ArtifactCommentId = thread.id;
  const setActive = comments?.setActiveThreadId;
  const setHovered = comments?.setHoveredThreadId;
  const panelOpen = comments?.panelOpen ?? false;
  const openThreadBubble = comments?.openThreadBubble;
  // Its card beside it; while the list is open, the list on it (one list at a time, co-design S8).
  const open = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (panelOpen || !openThreadBubble) {
      setActive?.(id);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    openThreadBubble(id, { x: box.left, y: box.top, width: box.width, height: box.height });
  }, [setActive, panelOpen, openThreadBubble, id]);
  const enter = useCallback(() => setHovered?.(id), [setHovered, id]);
  const leave = useCallback(() => setHovered?.(null), [setHovered]);
  const place = anchorLabel(anchor, intl);
  return (
    <>
      <CommentMarker
        active={active}
        aria-label={intl.formatMessage({ id: "artifacts.card.comments" }, { count: all.length })}
        aria-describedby={descriptionId}
        onClick={open}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onFocus={enter}
        onBlur={leave}
        data-testid="artifact-comment-marker"
        data-thread-id={id}
      >
        {/* A span: the stack sits inside the marker's button. */}
        <AvatarGroup render={<span />}>
          {authors.map((author) => <ArtifactActorAvatar key={actorKey(author)} actor={author} context="comment-marker" />)}
        </AvatarGroup>
        {all.length}
      </CommentMarker>
      <CommentCardQuote id={descriptionId}>
        {anchor.data.quote
          ? intl.formatMessage({ id: "artifacts.comments.anchorWithQuote" }, { place, quote: anchor.data.quote })
          : place}
      </CommentCardQuote>
    </>
  );
}
