import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { ArrowDownUp, ChevronDown, ChevronRight, PanelRightClose } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItemLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelNotice,
  PanelNoticeActions,
  PanelNoticeContent,
  PanelTitle,
  Text,
  ScrollArea,
} from "@botiverse/raft-ui";
import type { ArtifactComment, ArtifactCommentDraft, ArtifactCommentDraftId, ArtifactCommentId, ArtifactFile } from "@botiverse/raft-shared";

import type { ArtifactCommentBoxMode } from "./ArtifactCommentBox";

import ConfirmDialog from "../../components/ConfirmDialog";
import { ContentLoading } from "../../components/ui/ContentLoading";
import Tooltip from "../../components/ui/Tooltip";
import { requestFocus, watchFocusIntent } from "../../utils/focusRequest";
import { animationFramesOf, isElementNode } from "../../utils/ownerDocument";
import { isTextEditableElement } from "../../utils/keyboardShortcuts";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { ArtifactCommentSearchField } from "./ArtifactCommentSearchField";
import { buildThreads, groupThreads } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";
import { ARTIFACT_COMMENT_SORTS, NO_READ_MARK, isSingleThread, neighbourAfterResolve } from "./artifactCommentListOrder";
import type { ArtifactCommentSort } from "./artifactCommentListOrder";
import { ThreadCard } from "./ArtifactCommentThreadCard";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { LIST_ON_ARTIFACT, useArtifactListCompose } from "./artifactListCompose";
import { useDeleteDraft } from "./artifactDraftDelete";
import { focusListOnOpen } from "./artifactListOpenFocus";
import { draftFocusRestorations } from "./artifactRestoredFocus";
import { isEscapeTakenElsewhere } from "./artifactInputMethodKey";
import { artifactSource } from "./artifactSource";
import { useArtifactReview } from "./ArtifactReviewContext";
import { DraftCard } from "./ArtifactReviewPanel";
import { useArmed } from "./useArmed";
import { useArtifactCommentList } from "./useArtifactCommentList";
import { useArtifactCommentSearch } from "./useArtifactCommentSearch";
import { useDraftOptionAt } from "./useDraftOption";
import { ReviewFilter, ReviewSummary } from "./ArtifactCommentsReviewParts";

const NO_FILES: ArtifactFile[] = [];
const noPlaces = () => null;
const SORT_LABELS = { updated: "artifacts.comments.sortUpdated", page: "artifacts.comments.sortPage" } as const satisfies Record<ArtifactCommentSort, string>;

/**
 * The comment list (co-design S8, "Show All Comments"): every posted comment, nothing else. Beside
 * the content where the viewer is wide (pushing it aside), over it where narrow, a bottom sheet on
 * a phone (ArtifactViewer, ArtifactSurface `fit`). Every version's comments (E12), in the sort
 * the header's Sort menu picks, kept on the device (useArtifactCommentList): Last updated (the
 * default; by each thread's last comment, newest first, no groups: each card's anchor line says
 * where) or Page order (grouped by what they are on: the whole Artifact, then each file in order,
 * comments on the whole file first, then by where they are in the page; artifactCommentListOrder).
 * The order and which threads are open or folded are made as the list opens and when a sort is
 * picked, and never move while it is open but by the reader's own Resolve and Reopen. A thread
 * of two comments or more is collapsed (its seen comments on one line, its new ones in full after
 * a "New replies" divider) until the reader expands it (ArtifactCommentThreadCard). A reply sits under its thread; Reply opens a
 * box in that thread's card (A: posted at once; B: Send or Save Draft, a reply draft; C: no Reply). New
 * comments start elsewhere: a selection's Comment, a marker's bubble; one on the whole Artifact
 * starts in the box at the list's foot (A only, where the viewer may comment; xxchan,
 * #proj-workspace:afc83052: no box always at the viewer's foot). One sent from any of those shows
 * where it landed (stdrc, #proj-workspace:#119; #250: no "Sent" under it, the comment is there): from a selection or a
 * new comment's card at a place a marker shows, that card becomes its thread's card in place, and
 * the list doesn't open (xxchan); from the list's foot (or at a page's place) the list shows it,
 * the active card, until the list closes. Drafts are changed where they are (#proj-workspace:#148):
 * a thread shows the person's reply drafts for it under its replies, marked as pending
 * (ArtifactPendingReplies; Remy, #proj-workspace:d03c42a0); the others are pins in the page. All of
 * them, reply drafts too (after the others, each saying whom and what it answers), are first in
 * the list under "Your drafts", so the list holds every draft the bar counts.
 *
 * Resolved threads (#249) are folded below the open ones under "Resolved (N)", in the same order
 * (and groups), but for those with comments new to the reader, which stay open until the list
 * opens again; an expanded card says who resolved it and when. Resolve (an open thread) and Reopen
 * (a resolved one) sit beside Reply for whoever may (mayResolveThread): resolved, the thread
 * collapses into the folded section, focus to the card after it; reopened, it comes back. A reply
 * reopens a thread where it is.
 *
 * Search (#proj-workspace:#341, useArtifactCommentSearch): the field in the head's second row shows
 * only the threads with a comment, its root or a reply, whose words or author's name hold every word
 * typed (any case, inside a run of Chinese, Japanese or Korean too), in the list's order and areas,
 * resolved ones too (the Resolved section open while searching unless folded), with the words marked
 * in the comments that match. A collapsed thread whose match is on one of its one-line comments
 * shows whole. It changes nothing of the list's own state: nothing moves, nothing is seen, the
 * Resolved section's own fold stays; Esc (in the field, or in the results where nothing else took it)
 * or the field's × gives the list back as it was, the focus in the field. A thread picked that the
 * search doesn't show (a marker in the page, a comment sent) ends the search, so the list shows it.
 * A thread resolved from the results stays collapsed. No match: "No comments match", announced (a
 * live region kept while the field is). Drafts and a review's summary wait while it searches. It
 * finds in the comments loaded (Load earlier stays).
 *
 * Opened at a review (its Activity row, S8), the list shows that review's
 * comments alone, its summary first as its author's entry; the header's
 * Filter button and its chip say so ("Review by Remy"), the × or the menu's
 * All comments shows every comment, the menu the review again (ReviewFilter,
 * #250). A review that failed to load or isn't here says so in a strip,
 * with Show All Comments.
 *
 * Esc: the @ picker first (a reply box), then reply or edit mode, then an
 * expanded thread (it collapses), then the search's words (from the field or
 * the results, but a text box; the focus goes to the field), then the
 * panel (the viewer's key handler, which closes the viewer only after it).
 *
 * Opened by a marker in the page while it was closed, or with the list open
 * (Porthole `activated`, the page's word), it takes no focus and no press for
 * its first moments (THREAT_MODEL §6): the thread is scrolled to, not focused.
 */
export default function ArtifactCommentsPanel({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const comments = useArtifactComments();
  const headingId = useId();
  const draftsHeadingId = useId();
  const regionRef = useRef<HTMLElement | null>(null);
  const activeThreadId = comments?.activeThreadId ?? null;
  const review = useArtifactReview();
  const listCompose = useArtifactListCompose();
  const [editing, setEditing] = useState<ArtifactCommentId | null>(null);
  const [deleting, setDeleting] = useState<ArtifactComment | null>(null);
  // The person's drafts, every one the bar counts: those on a place of their own, then reply drafts
  // (each also under its thread): the way to edit or delete them from the keyboard, as a page's pins
  // aren't (#148). Not in C, which lists them.
  const [editingDraft, setEditingDraft] = useState<ArtifactCommentDraftId | null>(null);
  const ownDrafts = useMemo(() => {
    const all = review && review.status !== "reviewing" ? review.drafts ?? [] : [];
    return [...all.filter((d) => !d.replyTo), ...all.filter((d) => d.replyTo)];
  }, [review]);
  // The thread whose card holds a reply box (Reply), and that opening (its box takes focus).
  const [replying, setReplying] = useState<{ threadId: ArtifactCommentId; replyTo: ArtifactComment; key: number } | null>(null);
  // Reply in A and B (Send or Save Draft, useReplyDraftOption); not in C. A change of
  // mode drops a reply box that was open: its send would do something else now.
  const status = review?.status ?? "browsing";
  const replyOffered = status !== "reviewing";
  const [replyingIn, setReplyingIn] = useState(status);
  if (replyingIn !== status) {
    setReplyingIn(status);
    if (replying) setReplying(null);
  }

  // Opened without a place to start from: focus the region, so Esc and Tab start here (opened to write in
  // its foot box, Doesn't display well here's, the box takes it after: ArtifactCommentBox `insert`). A mount, also
  // of a list an answer opened (a review posted, a landing): not from a text field or dialog the person is in.
  const openedFrom = useRef({ activeThreadId });
  useEffect(() => {
    if (!openedFrom.current.activeThreadId) focusListOnOpen(() => regionRef.current);
  }, []);

  // A thread picked: bring it into view, and focus it unless the page's marker picked it (a view
  // the page's report opens takes no focus, THREAT_MODEL §6; it is armed instead).
  const threadFromFrame = comments?.threadFromFrame ?? null;
  const armed = useArmed(threadFromFrame);
  const sentId = comments?.sentId ?? null;
  const landedOn = comments?.landedOn ?? null;
  // Whose the pick is, read as the thread changes (not a reason to focus again): a landing's, or a sent comment's, comes
  // after an answer (the comments it waited on, the server's to the send), by when the person may be in a text field or
  // dialog, which keeps the focus (focus plan rule 2); any other is the person's own.
  const pickReason = useEffectEvent((card: HTMLElement) => {
    const holds = (id: ArtifactCommentId | null) => id !== null && !!card.querySelector(`[data-comment-id="${CSS.escape(id)}"]`);
    return holds(landedOn) || holds(sentId) ? "async" as const : "user" as const;
  });
  useEffect(() => {
    if (!activeThreadId) return;
    const card = regionRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(activeThreadId)}"]`);
    card?.scrollIntoView?.({ block: "nearest" });
    // Focus already in it (its reply box) stays there; so does focus still in the box a comment was
    // just sent from (the list's foot, which stays to write the next one). A box that went with
    // its send (a selection's, a card's) left focus nowhere: it moves to the comment sent.
    const active = card?.ownerDocument.activeElement ?? null;
    const stillWriting = sentId !== null && active?.localName === "textarea";
    if (threadFromFrame === null && !stillWriting && card && !card.contains(active)) requestFocus(() => card, { reason: pickReason(card) });
  }, [activeThreadId, threadFromFrame, sentId]);

  const reviewShown = comments?.reviewShown ?? null;
  const shownReview = comments?.shownReview ?? null;
  // At a review: exactly its comments as its page listed them (its summary is `review.body`, not one
  // of them); nothing when it isn't this Artifact's or didn't load.
  const listed = useMemo(
    () => {
      if (!comments?.comments || !reviewShown) return comments?.comments ?? null;
      if (shownReview?.status !== "ok") return [];
      return comments.comments.filter((c) => shownReview.commentIds.has(c.id));
    },
    [comments?.comments, reviewShown, shownReview],
  );
  // The threads (#249: resolved ones folded below the open), in the list's order and areas (useArtifactCommentList).
  const threads = useMemo(
    // One review's comments have no thread around them to wait for: each is a root or a reply to one of them.
    () => (listed ? buildThreads(listed, { parentsMayBeOlder: reviewShown !== null || (comments?.hasEarlier ?? false) }) : null),
    [listed, reviewShown, comments?.hasEarlier],
  );
  const files = comments?.data.files ?? NO_FILES;
  const list = useArtifactCommentList({
    threads,
    files,
    readMark: comments?.readMark ?? NO_READ_MARK,
    viewer: comments?.viewer ?? null,
    markPlaces: comments?.markPlaces ?? noPlaces,
    placesKnown: comments?.placesKnown ?? false,
  });
  // The search: the threads it finds, in the list's order and areas; all of them without words.
  const listRef = useRef<HTMLDivElement | null>(null);
  const search = useArtifactCommentSearch(threads, listRef);
  const found = search.found;
  const searching = found !== null;
  const shownOpen = found ? list.open.filter((t) => found.threads.has(t.id)) : list.open;
  const shownRest = found ? list.rest.filter((t) => found.threads.has(t.id)) : list.rest;
  const resolvedCount = shownRest.length;
  // Folded until opened; a thread picked there (a landing, a marker, the bubble's way to the list) opens it.
  const resolvedHeadingId = useId();
  const resolvedPanelId = useId();
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const toggleResolved = useCallback(() => setResolvedOpen((open) => !open), []);
  // While searching, the search's own (open, unless the reader folds it): the list's is as it was once the words go.
  const resolvedShownOpen = searching ? search.resolvedOpen : resolvedOpen;
  // The thread being read when the list last looked (once loaded): one picked while resolved opens
  // the section; one resolved while being read (its card's Resolve) leaves it folded.
  // While searching, the list's fold stays as it was: one the search shows opens the search's section; one it
  // doesn't show (a marker in the page, a comment sent) ends the search, so the list shows it.
  const [seenActive, setSeenActive] = useState<ArtifactCommentId | null>(null);
  if (list.layout && seenActive !== activeThreadId) {
    setSeenActive(activeThreadId);
    const resolvedPick = activeThreadId !== null && list.rest.some((t) => t.id === activeThreadId);
    if (found && activeThreadId !== null && !found.threads.has(activeThreadId)) {
      search.clear();
      if (resolvedPick) setResolvedOpen(true);
    } else if (resolvedPick) {
      if (found) search.showResolved();
      else setResolvedOpen(true);
    }
  }

  // Reply opens a box in an expanded card, which stays expanded once the reply is in (a thread of one comment too).
  const { keepExpanded } = list;
  const startReply = useCallback((threadId: ArtifactCommentId, comment: ArtifactComment) => {
    setReplying((current) => ({ threadId, replyTo: comment, key: (current?.key ?? 0) + 1 }));
    const thread = threads?.find((t) => t.id === threadId);
    if (thread) keepExpanded(thread);
  }, [threads, keepExpanded]);
  const stopReplying = useCallback(() => setReplying(null), []);
  // Where focus goes once an edit or a delete is over (the menu that started it is gone or moved).
  // `restorations`: draftFocusRestorations() when a deletion planned it; a made-again draft that
  // took focus since (its toast's Undo, before this frame) keeps it.
  // `exact`: that element or nothing (a resolve's: once its Undo has reopened the thread, the toggle is
  // gone and the Undo's own focus move stands; the list's fallback would take the focus off it).
  // `wanted`: a move after a server's answer (a draft deleted), still wanted once it comes (watchFocusIntent): made as
  // an `async` request, never from a text field or dialog; the others follow the person's press at once.
  const [refocus, setRefocus] = useState<{ selector: string; restorations?: number; exact?: boolean; wanted?: () => boolean } | null>(null);
  // The planned move's `wanted`, asked (so it stops watching) when a newer plan replaces it or the list goes first.
  const watching = useRef<(() => boolean) | null>(null);
  const present = useRef(true);
  const planRefocus = useCallback((next: NonNullable<typeof refocus>) => {
    watching.current?.();
    watching.current = null;
    if (!present.current) {
      next.wanted?.();
      return;
    }
    watching.current = next.wanted ?? null;
    setRefocus(next);
  }, []);
  useEffect(() => {
    present.current = true;
    return () => {
      present.current = false;
      watching.current?.();
      watching.current = null;
    };
  }, []);
  // Cancelled, at the person's press; saved, once the server answered (`wanted`, watched from the save).
  // `pressed`: a press outside closed it (the dismissal layer): the focus is where that press put it.
  const stopEditing = useCallback((id: ArtifactCommentId, wanted?: () => boolean, pressed = false) => {
    setEditing(null);
    if (pressed) {
      wanted?.();
      return;
    }
    planRefocus({ selector: `[data-comment-id="${CSS.escape(id)}"] [data-testid="artifact-comment-menu"]`, wanted });
  }, [planRefocus]);
  // Resolved or reopened from its card (#249), the reader's own act: the card moves at once (useArtifactCommentList
  // `moved`; a resolve's Undo reopens it so too). Resolved from the open area, focus to the card that was after it (or
  // before it; none left, the folded section's heading); reopened, to its card. Made once the server answered: `wanted`,
  // watched from the press (useThreadResolution); gone by then (Undo reopened it), nothing.
  // While searching, the card after it among those shown; resolved there, it stays collapsed (the search doesn't open it again).
  const { moved, layout: listLayout } = list;
  const { fold } = search;
  const layout = useMemo(() => (listLayout && found
    ? { open: listLayout.open.filter((id) => found.threads.has(id)), rest: listLayout.rest.filter((id) => found.threads.has(id)) }
    : listLayout), [listLayout, found]);
  const resolvedHere = useCallback((threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => {
    const thread = threads?.find((t) => t.id === threadId);
    if (thread) moved(thread, !resolved);
    if (thread && resolved && searching) fold(thread);
    const card = (id: ArtifactCommentId) => `[data-thread-id="${CSS.escape(id)}"]`;
    const next = layout ? neighbourAfterResolve(layout, threadId) : null;
    const fromOpen = layout?.open.includes(threadId) ?? false;
    const selector = !resolved || !fromOpen ? card(threadId) : next ? card(next) : "[data-testid='artifact-comments-resolved-toggle']";
    planRefocus({ selector, exact: true, wanted });
  }, [threads, moved, searching, fold, layout, planRefocus]);
  // Expanded from its collapsed card: the card keeps the focus (its trigger goes), and it is the thread being read.
  // Collapsed (its Collapse, Esc): focus back on the card's trigger, the card where it was. One the search opened
  // folds back for this search, still not read; one the reader expanded is collapsed (all it showed is seen).
  const { expand, collapse, isExpanded } = list;
  const setActiveThread = comments?.setActiveThreadId;
  const expandThread = useCallback((thread: ArtifactCommentThread) => {
    expand(thread);
    setActiveThread?.(thread.id);
    planRefocus({ selector: `[data-thread-id="${CSS.escape(thread.id)}"]`, exact: true });
  }, [expand, setActiveThread, planRefocus]);
  const collapseThread = useCallback((thread: ArtifactCommentThread) => {
    if (isExpanded(thread)) collapse(thread);
    if (searching) fold(thread);
    setReplying((current) => (current?.threadId === thread.id ? null : current));
    setEditing((current) => (current !== null && [thread.root, ...thread.replies].some((c) => c?.id === current) ? null : current));
    planRefocus({ selector: `[data-thread-id="${CSS.escape(thread.id)}"] [data-slot='comment-card-trigger']`, exact: true });
  }, [isExpanded, collapse, searching, fold, planRefocus]);
  // A sort picked: the list's order again (its areas and what is expanded kept), from its top.
  const { pickSort } = list;
  const chooseSort = useCallback((value: unknown) => {
    if (!ARTIFACT_COMMENT_SORTS.includes(value as ArtifactCommentSort)) return;
    pickSort(value as ArtifactCommentSort);
    listRef.current?.scrollTo?.({ top: 0 });
  }, [pickSort]);
  const cancelDelete = useCallback(() => {
    if (deleting) planRefocus({ selector: `[data-comment-id="${CSS.escape(deleting.id)}"] [data-testid="artifact-comment-menu"]` });
    setDeleting(null);
  }, [deleting, planRefocus]);
  // A failure keeps the dialog open with its error (ConfirmDialog); success closes it.
  const confirmDelete = useCallback(async () => {
    if (!comments || !deleting) return;
    await artifactSource().deleteComment(comments.data.card.id, deleting.id);
    comments.removed(deleting.id);
    planRefocus({ selector: "[data-testid='artifact-comments-list']" });
  }, [comments, deleting, planRefocus]);
  // A draft deleted from "Your drafts": focus to the next one's Edit, else the one before's, else
  // the section's heading (kept, saying none are left, while the list is open: Undo brings it back).
  const [deleteDraft, deleteDraftDialog] = useDeleteDraft();
  // Once the person deleted the last one here, the section stays (its heading, "No drafts left.").
  const [draftsEmptied, setDraftsEmptied] = useState(false);
  const deleteOwnDraft = useCallback((draft: ArtifactCommentDraft) => {
    const at = ownDrafts.findIndex((d) => d.id === draft.id);
    const next = ownDrafts[at + 1] ?? ownDrafts[at - 1] ?? null;
    if (next === null) setDraftsEmptied(true);
    // A press elsewhere before the server answers (focus plan rule 3) is the person moving on.
    const wanted = watchFocusIntent(() => regionRef.current);
    void deleteDraft(draft).then((deleted) => {
      if (!deleted) {
        wanted();
        return;
      }
      planRefocus({
        selector: next ? `[data-testid='artifact-comments-drafts'] [data-draft-id="${CSS.escape(next.id)}"] [data-testid='artifact-review-draft-edit']` : "[data-testid='artifact-comments-drafts-heading']",
        restorations: draftFocusRestorations(),
        wanted,
      });
    });
  }, [ownDrafts, deleteDraft, planRefocus]);
  useEffect(() => {
    if (!refocus || editing || deleting) return;
    // After the dialog has given focus back, so this wins. The list's own window's frame (an object window's, #337 PR3).
    const frames = animationFramesOf(regionRef.current?.ownerDocument);
    const frame = frames.requestAnimationFrame(() => {
      setRefocus(null);
      // Asked in every case, so it stops watching.
      const wanted = refocus.wanted?.() ?? true;
      if (refocus.restorations !== undefined && refocus.restorations !== draftFocusRestorations()) return;
      if (!wanted) return;
      const target = regionRef.current?.querySelector<HTMLElement>(refocus.selector) ?? (refocus.exact ? null : regionRef.current?.querySelector<HTMLElement>("[data-testid='artifact-comments-list']"));
      if (target) requestFocus(() => target, { reason: refocus.wanted ? "async" : "user" });
    });
    return () => frames.cancelAnimationFrame(frame);
  }, [refocus, editing, deleting]);

  // Load earlier: when the last page arrives the button goes; focus moves to the earliest comment, unless the person
  // pressed elsewhere or moved focus out of the list meanwhile (focus plan rule 3: watchFocusIntent).
  const loadedEarlierByButton = useRef<(() => boolean) | null>(null);
  const loadEarlierNow = comments?.loadEarlier;
  const loadEarlier = useCallback(() => {
    loadedEarlierByButton.current?.();
    loadedEarlierByButton.current = watchFocusIntent(() => regionRef.current);
    loadEarlierNow?.();
  }, [loadEarlierNow]);
  const hasEarlier = comments?.hasEarlier ?? false;
  const earlierFailed = comments?.earlierFailed ?? false;
  useEffect(() => {
    const wanted = loadedEarlierByButton.current;
    if ((hasEarlier && !earlierFailed) || !wanted) return;
    loadedEarlierByButton.current = null;
    // Failed: Retry is a press of its own.
    if (!wanted() || hasEarlier) return;
    const first = regionRef.current?.querySelector<HTMLElement>("[data-testid='artifact-comment-thread']");
    const target = first ?? regionRef.current?.querySelector<HTMLElement>("[data-testid='artifact-comments-list']");
    if (target) requestFocus(() => target, { reason: "async", onFocused: (el) => el.scrollIntoView?.({ block: "nearest" }) });
  }, [hasEarlier, earlierFailed]);

  // Esc in the results that nothing took (a result card, a button in one; not a text box, a menu's or a dialog's, nor an
  // input method's): the search's words go first and the focus goes to the field; the next Esc is the panel's.
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const { clear: clearSearch, query: searchQuery } = search;
  const searchEscape = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || searchQuery === "" || isEscapeTakenElsewhere(event)) return;
    const target = event.target;
    if (!isElementNode(target) || !event.currentTarget.contains(target) || isTextEditableElement(target)) return;
    event.preventDefault();
    clearSearch();
    fieldRef.current?.focus();
  }, [searchQuery, clearSearch]);

  const renderThread = (thread: ArtifactCommentThread) => {
    const newIds = list.newIn(thread);
    return (
      <ThreadCard
        key={thread.id}
        thread={thread}
        sort={list.sort}
        manyFiles={files.length > 1}
        // The search opens a collapsed thread to show a match on one of its one-line comments (not read for it).
        expanded={isExpanded(thread) || search.opens(thread, newIds)}
        single={isSingleThread(thread)}
        newIds={newIds}
        editing={editing}
        replying={replyOffered && replying?.threadId === thread.id ? replying : null}
        replyOffered={replyOffered}
        onReply={startReply}
        onStopReplying={stopReplying}
        onEdit={setEditing}
        onStopEditing={stopEditing}
        onDelete={setDeleting}
        onResolved={resolvedHere}
        onExpand={expandThread}
        onCollapse={collapseThread}
        highlight={search.terms}
        matching={found?.comments ?? null}
      />
    );
  };
  // An area's threads: in Page order in their groups, each under its heading (`h4` in the Resolved section, under its
  // own heading); in Last updated one column, each card's anchor line saying where.
  const renderArea = (area: ArtifactCommentThread[], Heading: "h3" | "h4") => (list.sort === "updated" ? (
    <div className="flex flex-col gap-2" data-testid="artifact-comment-column">{area.map(renderThread)}</div>
  ) : groupThreads(area, files).map((group) => (
    <section key={group.kind === "artifact" ? "artifact" : `file:${group.path}`} className="flex flex-col gap-2" data-testid="artifact-comment-group" data-group={group.kind === "artifact" ? "artifact" : group.path}>
      <Text.Sans
        size="group"
        className="px-1"
        render={<Heading>{group.kind === "artifact" ? formatMessage({ id: "artifacts.comments.groupArtifact" }) : <span className="font-mono">{group.path}</span>}</Heading>}
      />
      {group.threads.map(renderThread)}
    </section>
  )));
  const sortLabel = formatMessage({ id: "artifacts.comments.sort" });

  if (!comments) return null;
  const searchOffered = comments.comments !== null && ((threads?.length ?? 0) > 0 || search.query !== "");
  const noneFound = searching && shownOpen.length === 0 && resolvedCount === 0;
  return (
    <section
      ref={regionRef}
      aria-labelledby={headingId}
      tabIndex={-1}
      inert={armed || undefined}
      className="flex size-full min-h-0 flex-col bg-layer-card outline-none"
      data-testid="artifact-comments-panel"
      data-armed={armed || undefined}
    >
      {/* DS Panel: every column has the same header, seam under it. */}
      <PanelHeader>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle id={headingId} render={<h2>{formatMessage({ id: "artifacts.comments.title" })}</h2>} />
          </PanelHeading>
        </PanelHeaderContent>
        <PanelActions>
          <ReviewFilter />
          <DropdownMenu>
            <Tooltip content={sortLabel}>
              <DropdownMenuTrigger
                render={(
                  <PanelAction aria-label={sortLabel} className="data-popup-open:bg-fill-medium" data-testid="artifact-comments-sort">
                    <ArrowDownUp />
                  </PanelAction>
                )}
              />
            </Tooltip>
            <DropdownMenuContent side="bottom" align="end" aria-label={sortLabel} className="min-w-44" data-testid="artifact-comments-sort-menu">
              <DropdownMenuRadioGroup value={list.sort} onValueChange={chooseSort}>
                {ARTIFACT_COMMENT_SORTS.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value} data-testid={`artifact-comments-sort-${value}`}>
                    <DropdownMenuItemLabel>{formatMessage({ id: SORT_LABELS[value] })}</DropdownMenuItemLabel>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content={formatMessage({ id: "artifacts.comments.hide" })}>
            <PanelAction aria-label={formatMessage({ id: "artifacts.comments.hide" })} onClick={onClose} data-testid="artifact-comments-close">
              <PanelRightClose />
            </PanelAction>
          </Tooltip>
        </PanelActions>
      </PanelHeader>
      {searchOffered ? <ArtifactCommentSearchField query={search.query} onQuery={search.type} onClear={search.clear} fieldRef={fieldRef} /> : null}
      {reviewShown && comments.comments !== null && shownReview && shownReview.status !== "ok" ? (
        <PanelNotice status="warning" data-testid="artifact-comments-review-only" data-review={shownReview.status}>
          <PanelNoticeContent>
            {shownReview.status === "failed"
              ? formatMessage({ id: "artifacts.comments.reviewLoadFailed" })
              : formatMessage({ id: "artifacts.comments.reviewMissing" })}
          </PanelNoticeContent>
          <PanelNoticeActions>
            {shownReview.status === "failed" ? (
              <Button variant="ghost" size="md" onClick={comments.reload} data-testid="artifact-comments-review-retry">
                {formatMessage({ id: "artifacts.review.retry" })}
              </Button>
            ) : null}
            <Button variant="ghost" size="md" onClick={comments.showAllComments} data-testid="artifact-comments-review-show-all">
              {formatMessage({ id: "artifacts.comments.reviewShowAll" })}
            </Button>
          </PanelNoticeActions>
        </PanelNotice>
      ) : null}
      {/* The thread scrolls in a raft-ui ScrollArea, its padding on the
          content; no tab stop, as before (its cards and buttons take focus). */}
      <ScrollArea ref={listRef} tabIndex={-1} onKeyDown={searchEscape} aria-busy={comments.loadingEarlier || undefined} className="min-h-0 flex-1 outline-none" contentClassName="px-3 py-3" data-testid="artifact-comments-list">
        {comments.hasEarlier && !reviewShown ? (
          <div className="mb-3 flex flex-col items-center gap-1">
            {comments.earlierFailed ? (
              <p role="alert" className="text-footnote text-danger-strong" data-testid="artifact-comments-load-earlier-error">
                {formatMessage({ id: "artifacts.comments.loadEarlierFailed" })}
              </p>
            ) : null}
            <Button variant="ghost" size="md" onClick={loadEarlier} disabled={comments.loadingEarlier} data-testid="artifact-comments-load-earlier">
              {formatMessage({ id: comments.earlierFailed ? "artifacts.comments.loadEarlierRetry" : "artifacts.comments.loadEarlier" })}
            </Button>
          </div>
        ) : null}
        {/* Kept while the field is, its words changed, so a screen reader says when nothing matches. */}
        {searchOffered ? (
          <p role="status" className="px-1 text-footnote text-foreground-muted" data-testid="artifact-comments-search-empty">
            {noneFound ? formatMessage({ id: "artifacts.comments.searchEmpty" }) : ""}
          </p>
        ) : null}
        {!reviewShown && !searching && (ownDrafts.length > 0 || draftsEmptied) ? (
          <section className="mb-4 flex flex-col gap-2" data-testid="artifact-comments-drafts" aria-labelledby={draftsHeadingId}>
            <Text.Sans
              size="group"
              className="px-1 outline-none"
              render={<h3 id={draftsHeadingId} tabIndex={-1} data-testid="artifact-comments-drafts-heading">{formatMessage({ id: "artifacts.comments.groupDrafts" })}</h3>}
            />
            {ownDrafts.map((draft) => (
              <DraftCard key={draft.id} draft={draft} editing={editingDraft === draft.id} onEdit={setEditingDraft} rejection={null} onDelete={deleteOwnDraft} />
            ))}
            {ownDrafts.length === 0 ? (
              <p className="px-1 text-footnote text-foreground-muted" data-testid="artifact-comments-drafts-none">{formatMessage({ id: "artifacts.comments.draftsNoneLeft" })}</p>
            ) : null}
          </section>
        ) : null}
        {comments.comments === null ? (
          comments.failed ? (
            <p className="px-1 text-footnote text-foreground-muted">{formatMessage({ id: "artifacts.comments.loadFailed" })}</p>
          ) : (
            <ContentLoading>{formatMessage({ id: "artifacts.comments.loading" })}</ContentLoading>
          )
        ) : (reviewShown && shownReview?.status !== "ok") || noneFound ? null : list.open.length === 0 && resolvedCount === 0 && !(shownReview?.status === "ok" && shownReview.review.body) ? (
          <p className="px-1 text-footnote text-foreground-muted" data-testid="artifact-comments-empty">{formatMessage({ id: "artifacts.comments.empty" })}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {shownReview?.status === "ok" && shownReview.review.body && !searching ? (
              <ReviewSummary review={shownReview.review} body={shownReview.review.body} />
            ) : null}
            {shownOpen.length > 0 ? renderArea(shownOpen, "h3") : null}
            {resolvedCount > 0 ? (
              <section className="flex flex-col gap-2" aria-labelledby={resolvedHeadingId} data-testid="artifact-comments-resolved">
                <h3>
                  {/* raft-ui's Button, as Load earlier: its own focus ring (a disclosure toggle of raft-ui's is tracked). */}
                  <Button
                    variant="ghost"
                    size="md"
                    id={resolvedHeadingId}
                    onClick={searching ? search.toggleResolved : toggleResolved}
                    aria-expanded={resolvedShownOpen}
                    aria-controls={resolvedShownOpen ? resolvedPanelId : undefined}
                    data-testid="artifact-comments-resolved-toggle"
                  >
                    {resolvedShownOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                    {formatMessage({ id: "artifacts.comments.resolvedGroup" }, { count: resolvedCount })}
                  </Button>
                </h3>
                {resolvedShownOpen ? (
                  <div id={resolvedPanelId} className="flex flex-col gap-4">
                    {renderArea(shownRest, "h4")}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        )}
      </ScrollArea>
      {((status === "browsing" && !reviewShown) || listCompose?.compose) && comments.data.capabilities.comment ? <ListComposer /> : null}
      {deleteDraftDialog}
      {deleting ? (
        <ConfirmDialog
          title={formatMessage({ id: "artifacts.comments.deleteTitle" })}
          message={formatMessage({ id: "artifacts.comments.deleteBody" })}
          confirmLabel={formatMessage({ id: "artifacts.comments.deleteConfirm" })}
          onConfirm={confirmDelete}
          onClose={cancelDelete}
        />
      ) : null}
    </section>
  );
}

/**
 * The list's foot: a comment on the whole Artifact, posted at once (A), then shown in the list above
 * the box, focus kept in it for the next one (`revealSent`). Always on the whole Artifact, with every
 * box's placeholder ("Comment"): no target picker (#250; a file or a place is commented on from the
 * page). Not in B or C (B's words
 * all go into the batch, its summary is C's), nor while the list shows one review alone (what is
 * sent wouldn't show there), unless the list was opened to write in it (artifactListCompose: Doesn't
 * display well here, which puts its lines in it, #proj-workspace:#243).
 */
function ListComposer() {
  const comments = useArtifactComments();
  const compose = useArtifactListCompose();
  const mode = useMemo<ArtifactCommentBoxMode>(() => ({ kind: "new", target: LIST_ON_ARTIFACT, replyTo: null }), []);
  // An unsent comment given to it after a reload (useUnsentCommentOffer): made again to take its words.
  const unsent = comments?.unsentForList ?? null;
  // Send or Save Draft, as every box (#148): a draft where it posts.
  const draftOption = useDraftOptionAt(LIST_ON_ARTIFACT);
  return (
    // Its own region at the list's foot: its seam is the region's edge (DS Separator: not a separator).
    <div className="shrink-0 border-t border-line-seam px-3 pt-2 pb-3" data-testid="artifact-list-composer">
      <ArtifactCommentBox
        key={unsent ?? "own"}
        adoptKey={unsent}
        mode={mode}
        draftOption={draftOption}
        guardsPagePlace={false}
        revealSent="list"
        standing
        insert={compose?.compose ?? null}
      />
    </div>
  );
}
