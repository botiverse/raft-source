import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { Badge } from "@botiverse/raft-ui";
import { CommentIcon } from "@botiverse/ricons";
import {
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
} from "@botiverse/raft-ui/wip";
import type { ArtifactCommentDraft, ArtifactCommentId } from "@botiverse/raft-shared";
import type { AnnotationRect } from "@botiverse/porthole";

import { formatRelativeTime } from "../../utils/relativeTime";
import { focusLost } from "../../utils/focusGuard";
import { ArtifactActorAvatar, anchorLabel } from "./ArtifactActorParts";
import { ArtifactCommentText } from "./ArtifactCommentText";
import { MarginThreadCard } from "./ArtifactCommentBubble";
import { anchorOf } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import type { ArtifactCommentsState } from "./ArtifactCommentsContext";
import { artifactActorName } from "./artifactFacts";
import { useMarginEntries, useMarginTops } from "./artifactMarginEntries";
import type { MarginEntry } from "./artifactMarginEntries";
import { marginOffsetOf } from "./artifactMarginPlaces";
import { useArtifactReview } from "./ArtifactReviewContext";
import { draftDrawn } from "./artifactRestoredFocus";

/**
 * A Markdown Artifact's comments as cards in the margin beside its frame (#proj-workspace:#152;
 * comment redesign mockup v8, Markdown scene; raft-design patterns/comments.md, the margin;
 * raft-ui `CommentMargin`): each posted thread's card level with its passage, collapsed until it is
 * chosen, then the thread's own card in its place (MarginThreadCard: replies, reply box, edit and
 * delete); each of the person's drafts a dashed card that opens the draft's view. Threads on the
 * whole Artifact, or whose passage the page no longer has, stay in the list (the header's
 * Comments): the margin has a place only for what the page says where it is.
 *
 * Where each card goes is the frame's word (artifactMarginPlaces): its tops as last reported,
 * laid out in those coordinates (cards keep document order and never overlap, the open one pinned
 * to its passage), and the whole column moved by how far the page scrolled since (the reference
 * mark followed) and by where the frame's top is. That move is a transform written as the frame
 * reports it, so scrolling re-renders no card. A card whose passage's place isn't known (past the
 * frame's edge: Porthole clamps what it reports there) isn't drawn.
 *
 * A newer frame (Porthole 0.14.10's P132: document mode) says where every passage is in its
 * document, offscreen ones too, and the document's scroll: every card is drawn, laid out in the
 * document's coordinates, and the column moved by the scroll (`marginOffsetOf`), so a card scrolls
 * into the margin with its passage. Those places are the page's word and unclamped (any number
 * within Porthole's bound, far above or below): the margin column clips what it holds to its own
 * box (`overflow: clip`, and the column the containing block of everything in it), so no place a
 * page says puts a card over the rest of the app. That clip is the host's half of P132's promise
 * (THREAT_MODEL §6; Tenny): never take it off, nor draw a card from these places anywhere else.
 * A card wholly outside the column is `inert` (not focusable nor read out: it isn't seen), the
 * active one excepted; focus in it goes to the surface.
 *
 * The keyboard: a collapsed card is a button (aria-expanded); Enter opens the thread's card with
 * focus in it; Esc (or ×) closes it and focus goes back to that thread's button.
 *
 * `page`: the element the frame fills beside the margin, watched for a new width (the page reflows,
 * so every place is asked for again): first as the margin appears (the frame narrowed by its width;
 * its cards wait for that answer, useArtifactMargin), then as the viewer is resized.
 */
export function ArtifactMarkdownMargin({ page }: { page: HTMLElement | null }) {
  const comments = useArtifactComments();
  const column = useRef<HTMLDivElement | null>(null);
  const shift = useRef<HTMLDivElement | null>(null);
  const store = comments?.margin.places ?? null;
  const tops = useMarginTops();
  const requestRefresh = comments?.margin.requestRefresh;

  // The page beside the margin got a size: as the margin is drawn (the frame narrower by it), and
  // again as the viewer is resized (a window, a sidebar opened) or the page's height changes (a find
  // bar). It reflowed, so ask where every mark is now. The observer's first callback comes once the
  // page is laid out beside the margin. No ResizeObserver, no margin: the surface draws none
  // (ArtifactSurface), since this observer is what asks first and raft-ui's CommentMargin needs one.
  useLayoutEffect(() => {
    if (!page || typeof ResizeObserver === "undefined" || !requestRefresh) return;
    const observer = new ResizeObserver(() => requestRefresh());
    observer.observe(page);
    return () => observer.disconnect();
  }, [page, requestRefresh]);

  const entries = useMarginEntries(comments);
  const placed = useMemo(() => entries.filter((entry) => tops.has(entry.id)), [entries, tops]);
  const floor = useMemo(() => placed.reduce((low, entry) => Math.min(low, tops.get(entry.id) ?? 0), Number.POSITIVE_INFINITY), [placed, tops]);

  // How far the column is moved up so the open card, past the margin's foot, is whole (0: none open).
  const lift = useRef(0);
  // The column's move: where the frame's top is in it, the scroll since the tops were reported (in
  // document mode the document's scroll), and the lowest top (the cards are laid out from 0).
  useLayoutEffect(() => {
    if (!store) return;
    const write = () => {
      const element = shift.current;
      const host = column.current;
      if (!element || !host) return;
      const { places: now, frameTop } = store.get();
      const offset = frameTop === null ? 0 : frameTop - host.getBoundingClientRect().top;
      const y = offset + marginOffsetOf(now) + (Number.isFinite(floor) ? floor : 0) - lift.current;
      element.style.transform = `translateY(${y}px)`;
    };
    write();
    return store.subscribe(write);
  }, [store, floor]);

  // A thread's card closed (Esc, ×, another card opened) with focus gone with it: back to its button.
  const bubble = comments?.bubble ?? null;
  const openThread = bubble?.kind === "thread" ? bubble.threadId : null;
  const wasOpen = useRef<string | null>(null);
  useLayoutEffect(() => {
    const closed = wasOpen.current;
    wasOpen.current = openThread;
    if (closed === null || closed === openThread) return;
    // Only focus that went with the card (focusLost): never taken from where the person put it.
    if (!focusLost()) return;
    const trigger = column.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(closed)}"] [data-testid="artifact-margin-thread-open"]`);
    trigger?.focus({ preventScroll: true });
  }, [openThread]);

  // An open card past the margin's foot (a passage near the frame's bottom, a long thread): the
  // column moves up until it is whole, never its top above the margin's. Measured as it opens and
  // again as it grows or shrinks (replies loaded, the reply box grown). The whole column moves, so
  // the collapsed cards move with it while one is open (one column, its order kept). A card taller
  // than the margin stays clipped at the foot: its top (the thread's start) is what is kept in view.
  // Closed (or none open), the lift is 0 and the move is written again at once, not left lifted
  // until the next scroll or report.
  useLayoutEffect(() => {
    const host = column.current;
    const moving = shift.current;
    lift.current = 0;
    if (!host || !moving || !store) return;
    const place = () => {
      const { places: now, frameTop } = store.get();
      const offset = frameTop === null ? 0 : frameTop - host.getBoundingClientRect().top;
      moving.style.transform = `translateY(${offset + marginOffsetOf(now) + (Number.isFinite(floor) ? floor : 0) - lift.current}px)`;
    };
    place();
    if (openThread === null) return;
    const card = host.querySelector<HTMLElement>("[data-testid='artifact-comment-bubble']");
    if (!card) return;
    // Measured unlifted (the lift written as 0 first), so the card's box says how far it is over.
    const measure = () => {
      const was = lift.current;
      lift.current = 0;
      if (was !== 0) place();
      const box = card.getBoundingClientRect();
      const room = host.getBoundingClientRect();
      const over = box.bottom + MARGIN_FOOT_PX - room.bottom;
      lift.current = over > 0 ? Math.max(0, Math.min(over, box.top - room.top - MARGIN_FOOT_PX)) : 0;
      if (lift.current !== 0 || was !== 0) place();
    };
    measure();
    // No ResizeObserver (jsdom): measured as it opens only.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [openThread, tops, floor, store]);

  // A card wholly outside the column (clipped: in document mode the cards of passages scrolled away
  // are drawn) is inert, so neither Tab nor a screen reader reaches what isn't seen; the active card
  // (the open thread) never is, so focus in it stays. Watched against the column's own box, so the
  // scroll, the lift and raft-ui's collisions all count. No IntersectionObserver (jsdom): none is.
  useLayoutEffect(() => {
    const host = column.current;
    if (!host || typeof IntersectionObserver === "undefined") return;
    const items = [...host.querySelectorAll<HTMLElement>("[data-slot='comment-margin-item']")];
    const observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const item = record.target as HTMLElement;
        const unseen = !record.isIntersecting && !item.hasAttribute("data-active");
        if (item.inert === unseen) continue;
        // Made inert it would drop focus to the body: what holds it hands it to the surface first.
        if (unseen && item.contains(document.activeElement)) host.closest<HTMLElement>("[data-artifact-focus]")?.focus({ preventScroll: true });
        item.inert = unseen;
      }
    }, { root: host });
    for (const item of items) observer.observe(item);
    return () => {
      observer.disconnect();
      for (const item of items) item.inert = false;
    };
  }, [placed, openThread, comments?.activeThreadId]);

  if (!comments) return null;
  return (
    // Clipped, never scrolled (overflow-clip): a focus inside can't scroll it out of line with the page.
    // The clip is also what holds a card to this column wherever the page says its passage is (P132:
    // unclamped places): `relative` makes the column the containing block of the absolute move inside.
    <div ref={column} className="relative h-full min-h-0 overflow-clip" data-testid="artifact-markdown-margin">
      <div ref={shift} className="absolute inset-x-3 top-0 will-change-transform">
        <MarginCards entries={placed} tops={tops} floor={floor} comments={comments} />
      </div>
    </div>
  );
}

/** The cards, laid out from the lowest top (memoized: the scroll moves their column, not them). */
const MarginCards = memo(function MarginCards({ entries, tops, floor, comments }: {
  entries: MarginEntry[];
  tops: ReadonlyMap<string, number>;
  floor: number;
  comments: ArtifactCommentsState;
}) {
  const bubble = comments.bubble;
  const open = bubble?.kind === "thread" ? bubble : null;
  return (
    <CommentMargin>
      {entries.map((entry) => {
        const top = (tops.get(entry.id) ?? 0) - (Number.isFinite(floor) ? floor : 0);
        if (entry.kind === "draft") {
          return (
            <CommentMarginItem key={entry.id} top={top}>
              <MarginDraftCard draft={entry.draft} />
            </CommentMarginItem>
          );
        }
        const isOpen = open?.threadId === entry.thread.id;
        return (
          <CommentMarginItem key={entry.id} top={top} active={isOpen || comments.activeThreadId === entry.thread.id}>
            {isOpen && open ? <MarginThreadCard bubble={open} /> : <MarginThreadSummary thread={entry.thread} />}
          </CommentMarginItem>
        );
      })}
    </CommentMargin>
  );
});

/** The room an open card keeps below it at the margin's foot, px. */
const MARGIN_FOOT_PX = 8;

/** A box on screen for the card the person chose (its own box, client px). */
function rectOf(element: Element): AnnotationRect {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/**
 * A posted thread, collapsed (raft-design comments.md): who started it and what they said, cut to 2
 * lines (CommentEntryBody `clamp`), and how many replies; choosing it opens the thread here. The
 * passage isn't repeated on the card: it sits beside the passage's highlight, and every card here
 * is on a passage (whole-Artifact threads stay in the list). The passage is said only to a screen
 * reader (CommentCardQuote is hidden on screen), as the trigger's description.
 */
function MarginThreadSummary({ thread }: { thread: ArtifactCommentThread }) {
  const intl = useIntl();
  const { formatMessage, locale } = intl;
  const comments = useArtifactComments();
  const quoteId = useId();
  const first = thread.root ?? thread.first;
  const anchor = anchorOf(first);
  const name = first.deletedAt ? "" : artifactActorName(first.author, formatMessage);
  const label = first.deletedAt
    ? formatMessage({ id: "artifacts.comments.deleted" })
    : formatMessage({ id: "artifacts.comments.margin.commentFrom" }, { name });
  const replies = thread.replies.filter((reply) => !reply.deletedAt).length;
  const openThreadBubble = comments?.openThreadBubble;
  const open = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const card = event.currentTarget.closest("[data-slot='comment-card']") ?? event.currentTarget;
    openThreadBubble?.(thread.id as ArtifactCommentId, rectOf(card));
  }, [openThreadBubble, thread.id]);
  return (
    <CommentCard data-thread-id={thread.id} data-testid="artifact-margin-thread">
      {anchor ? <CommentCardQuote id={quoteId}>{anchorLabel(anchor, intl)}</CommentCardQuote> : null}
      <CommentEntry>
        {first.deletedAt ? (
          <CommentEntryBody className="text-foreground-hint italic">{formatMessage({ id: "artifacts.comments.deleted" })}</CommentEntryBody>
        ) : (
          <>
            <CommentEntryHeader>
              <ArtifactActorAvatar actor={first.author} context="comment-entry" />
              <CommentEntryAuthor>{name}</CommentEntryAuthor>
              <CommentEntryTime dateTime={first.createdAt}>{formatRelativeTime(first.createdAt, locale) ?? ""}</CommentEntryTime>
            </CommentEntryHeader>
            <CommentEntryBody clamp>
              <ArtifactCommentText body={first.body} viewer={comments?.viewer ?? null} />
            </CommentEntryBody>
          </>
        )}
      </CommentEntry>
      {replies > 0 ? (
        <CommentCardMeta>
          <CommentIcon aria-hidden />
          {formatMessage({ id: "artifacts.comments.margin.replyCount" }, { count: replies })}
        </CommentCardMeta>
      ) : null}
      {/* Collapsed: this thread's card is closed (opened, MarginThreadCard takes its place). */}
      <CommentCardTrigger
        aria-label={label}
        aria-expanded={false}
        aria-describedby={anchor ? quoteId : undefined}
        onClick={open}
        data-testid="artifact-margin-thread-open"
      />
    </CommentCard>
  );
}

/** One of the person's drafts: dashed, "Draft"; choosing it opens the draft's own view (edit, delete). */
function MarginDraftCard({ draft }: { draft: ArtifactCommentDraft }) {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments();
  const openDraftView = useArtifactReview()?.openDraftView;
  const excerpt = draft.body.map((part) => (part.type === "text" ? part.text : "")).join("").trim().slice(0, 60);
  const open = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const card = event.currentTarget.closest("[data-slot='comment-card']") ?? event.currentTarget;
    openDraftView?.(draft.id, rectOf(card));
  }, [openDraftView, draft.id]);
  // Made again by its deletion's toast (its Undo): focus comes as it is drawn (a ref, at once on
  // mount), which is once the frame says where its new mark is.
  const draftId = draft.id;
  const attachTrigger = useCallback((element: HTMLButtonElement | null) => {
    if (element) draftDrawn(draftId);
  }, [draftId]);
  return (
    <CommentCard className="border-dashed" data-draft-id={draft.id} data-testid="artifact-margin-draft">
      <CommentCardMeta>
        <Badge appearance="outline" className="shrink-0">{formatMessage({ id: "artifacts.review.draftTag" })}</Badge>
      </CommentCardMeta>
      <CommentEntry>
        <CommentEntryBody clamp>
          <ArtifactCommentText body={draft.body} viewer={comments?.viewer ?? null} />
        </CommentEntryBody>
      </CommentEntry>
      {openDraftView ? (
        <CommentCardTrigger
          ref={attachTrigger}
          aria-label={formatMessage({ id: "artifacts.review.editDraftNamed" }, { excerpt })}
          onClick={open}
          data-testid="artifact-margin-draft-open"
        />
      ) : null}
    </CommentCard>
  );
}

