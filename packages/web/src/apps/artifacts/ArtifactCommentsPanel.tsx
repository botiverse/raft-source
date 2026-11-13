import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- Reply and Edit draw and focus their box within the tap: iOS Safari opens the keyboard only for a focus made during the tap event itself (focus plan rule 5 decision).
import { flushSync } from "react-dom";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight, EllipsisVertical, MapPinOff, Pencil, Reply, Trash2, X } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { CommentIcon } from "@botiverse/ricons";
import {
  CommentCard,
  CommentCardMeta,
  CommentEntry,
  CommentEntryAuthor,
  CommentEntryBody,
  CommentEntryHeader,
  CommentEntryTime,
} from "@botiverse/raft-ui/wip";
import type { ArtifactComment, ArtifactCommentDraft, ArtifactCommentDraftId, ArtifactCommentId } from "@botiverse/raft-shared";

import type { ArtifactCommentBoxMode } from "./ArtifactCommentBox";
import type { ArtifactCardListWay } from "./artifactCardHold";

import ConfirmDialog from "../../components/ConfirmDialog";
import { ContentLoading } from "../../components/ui/ContentLoading";
import Tooltip from "../../components/ui/Tooltip";
import { formatRelativeTime } from "../../utils/relativeTime";
import { requestFocus, watchFocusIntent } from "../../utils/focusRequest";
import { AgentTag, AnchorMeta, ArtifactActorAvatar } from "./ArtifactActorParts";
import { ArtifactCommentText } from "./ArtifactCommentText";
import { ArtifactCommentGallery } from "./ArtifactCommentGallery";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { ArtifactDismissableBox } from "./ArtifactDismissableBox";
import { actorKey, anchorOf, buildThreads, groupThreads, isOwnComment, isResolvedThread } from "./artifactComments";
import type { ArtifactCommentGroup, ArtifactCommentThread } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { LIST_ON_ARTIFACT, useArtifactListCompose } from "./artifactListCompose";
import { useAnchorFound } from "./artifactAnchorStatus";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { PendingReplyDraft, usePendingReplies } from "./ArtifactPendingReplies";
import { useDeleteDraft } from "./artifactDraftDelete";
import { draftFocusRestorations } from "./artifactRestoredFocus";
import { artifactSource } from "./artifactSource";
import { useArtifactReview } from "./ArtifactReviewContext";
import { DraftCard } from "./ArtifactReviewPanel";
import { useArmed } from "./useArmed";
import { useDraftOptionAt, useReplyDraftOption } from "./useDraftOption";
import { artifactActorName } from "./artifactFacts";
import { ResolveButton, ResolvedBy } from "./ArtifactThreadResolution";
import { useThreadResolution } from "./useThreadResolution";
import { ReviewFilter, ReviewSummary } from "./ArtifactCommentsReviewParts";

/**
 * The comment list (co-design S8, "Show All Comments"): every posted comment, nothing else. Beside
 * the content where the viewer is wide (pushing it aside), over it where narrow, a bottom sheet on
 * a phone (ArtifactViewer, ArtifactSurface `fit`). Every version's
 * comments, oldest first (E12), grouped by what they are on: the whole Artifact, then each file
 * (comments on the whole file before anchored ones). A reply sits under its thread; Reply opens a
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
 * Resolved threads (#249) are folded below the open ones under "Resolved (N)", in the same
 * groups; each card says who resolved it and when. Resolve (an open thread) and Reopen (a resolved
 * one) sit beside Reply for whoever may (mayResolveThread); a reply reopens a thread.
 *
 * Opened at a review (its Activity row, S8), the list shows that review's
 * comments alone, its summary first as its author's entry; the header's
 * Filter button and its chip say so ("Review by Remy"), the × or the menu's
 * All comments shows every comment, the menu the review again (ReviewFilter,
 * #250). A review that failed to load or isn't here says so in a strip,
 * with Show All Comments.
 *
 * Esc: the @ picker first (a reply box), then reply or edit mode, then the
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
    if (!openedFrom.current.activeThreadId) requestFocus(() => regionRef.current, { reason: "mount" });
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
    const stillWriting = sentId !== null && document.activeElement instanceof HTMLTextAreaElement;
    if (threadFromFrame === null && !stillWriting && card && !card.contains(document.activeElement)) requestFocus(() => card, { reason: pickReason(card) });
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
  // Open threads in their groups; resolved ones (#249) folded below them, in the same groups.
  const { groups, resolvedGroups, resolvedCount } = useMemo(() => {
    // One review's comments have no thread around them to wait for: each is a root or a reply to one of them.
    const threads = listed ? buildThreads(listed, { parentsMayBeOlder: reviewShown !== null || (comments?.hasEarlier ?? false) }) : [];
    const files = comments?.data.files ?? [];
    const resolved = threads.filter(isResolvedThread);
    return { groups: groupThreads(threads.filter((t) => !isResolvedThread(t)), files), resolvedGroups: groupThreads(resolved, files), resolvedCount: resolved.length };
  }, [listed, reviewShown, comments?.hasEarlier, comments?.data.files]);
  // Folded until opened; a thread picked there (a landing, a marker, the bubble's way to the list) opens it.
  const resolvedHeadingId = useId();
  const resolvedPanelId = useId();
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const toggleResolved = useCallback(() => setResolvedOpen((open) => !open), []);
  // The thread being read when the list last looked (once loaded): one picked while resolved opens
  // the section; one resolved while being read (its card's Resolve) leaves it folded.
  const [seenActive, setSeenActive] = useState<ArtifactCommentId | null>(null);
  if (listed && seenActive !== activeThreadId) {
    setSeenActive(activeThreadId);
    if (activeThreadId && resolvedGroups.some((g) => g.threads.some((t) => t.id === activeThreadId))) setResolvedOpen(true);
  }

  const startReply = useCallback((threadId: ArtifactCommentId, comment: ArtifactComment) => {
    setReplying((current) => ({ threadId, replyTo: comment, key: (current?.key ?? 0) + 1 }));
  }, []);
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
  // Resolved or reopened from its card (#249): the card moved to the other part of the list. Focus
  // follows it while it can be seen: reopened, to its card; resolved, to the folded section's heading.
  // Made once the server answered: `wanted`, watched from the press (useThreadResolution).
  const resolvedHere = useCallback((threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => {
    // As the thread stands when the focus moves: resolved, its folded section's heading (or its card
    // in the open section); reopened, its card. Gone by then (Undo reopened it), nothing.
    const card = `[data-thread-id="${CSS.escape(threadId)}"]`;
    const selector = !resolved ? card : resolvedOpen ? `[data-testid='artifact-comments-resolved'] ${card}` : "[data-testid='artifact-comments-resolved-toggle']";
    planRefocus({ selector, exact: true, wanted });
  }, [resolvedOpen, planRefocus]);
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
    // After the dialog has given focus back, so this wins.
    const frame = requestAnimationFrame(() => {
      setRefocus(null);
      // Asked in every case, so it stops watching.
      const wanted = refocus.wanted?.() ?? true;
      if (refocus.restorations !== undefined && refocus.restorations !== draftFocusRestorations()) return;
      if (!wanted) return;
      const target = regionRef.current?.querySelector<HTMLElement>(refocus.selector) ?? (refocus.exact ? null : regionRef.current?.querySelector<HTMLElement>("[data-testid='artifact-comments-list']"));
      if (target) requestFocus(() => target, { reason: refocus.wanted ? "async" : "user" });
    });
    return () => cancelAnimationFrame(frame);
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

  // A group of threads under its heading (`h4` in the Resolved section, under its own heading).
  const renderGroup = (group: ArtifactCommentGroup, Heading: "h3" | "h4") => (
    <section key={group.kind === "artifact" ? "artifact" : `file:${group.path}`} className="flex flex-col gap-2" data-testid="artifact-comment-group" data-group={group.kind === "artifact" ? "artifact" : group.path}>
      <Text.Sans
        size="group"
        className="px-1"
        render={<Heading>{group.kind === "artifact" ? formatMessage({ id: "artifacts.comments.groupArtifact" }) : <span className="font-mono">{group.path}</span>}</Heading>}
      />
      {group.threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          editing={editing}
          replying={replyOffered && replying?.threadId === thread.id ? replying : null}
          replyOffered={replyOffered}
          onReply={startReply}
          onStopReplying={stopReplying}
          onEdit={setEditing}
          onStopEditing={stopEditing}
          onDelete={setDeleting}
          onResolved={resolvedHere}
        />
      ))}
    </section>
  );

  if (!comments) return null;
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
          <Tooltip content={formatMessage({ id: "artifacts.comments.close" })}>
            <PanelAction aria-label={formatMessage({ id: "artifacts.comments.close" })} onClick={onClose} data-testid="artifact-comments-close">
              <X />
            </PanelAction>
          </Tooltip>
        </PanelActions>
      </PanelHeader>
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
      <ScrollArea tabIndex={-1} aria-busy={comments.loadingEarlier || undefined} className="min-h-0 flex-1 outline-none" contentClassName="px-3 py-3" data-testid="artifact-comments-list">
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
        {!reviewShown && (ownDrafts.length > 0 || draftsEmptied) ? (
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
        ) : reviewShown && shownReview?.status !== "ok" ? null : groups.length === 0 && resolvedCount === 0 && !(shownReview?.status === "ok" && shownReview.review.body) ? (
          <p className="px-1 text-footnote text-foreground-muted" data-testid="artifact-comments-empty">{formatMessage({ id: "artifacts.comments.empty" })}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {shownReview?.status === "ok" && shownReview.review.body ? (
              <ReviewSummary review={shownReview.review} body={shownReview.review.body} />
            ) : null}
            {groups.map((group) => renderGroup(group, "h3"))}
            {resolvedCount > 0 ? (
              <section className="flex flex-col gap-2" aria-labelledby={resolvedHeadingId} data-testid="artifact-comments-resolved">
                <h3>
                  {/* raft-ui's Button, as Load earlier: its own focus ring (a disclosure toggle of raft-ui's is tracked). */}
                  <Button
                    variant="ghost"
                    size="md"
                    id={resolvedHeadingId}
                    onClick={toggleResolved}
                    aria-expanded={resolvedOpen}
                    aria-controls={resolvedOpen ? resolvedPanelId : undefined}
                    data-testid="artifact-comments-resolved-toggle"
                  >
                    {resolvedOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                    {formatMessage({ id: "artifacts.comments.resolvedGroup" }, { count: resolvedCount })}
                  </Button>
                </h3>
                {resolvedOpen ? (
                  <div id={resolvedPanelId} className="flex flex-col gap-4">
                    {resolvedGroups.map((group) => renderGroup(group, "h4"))}
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

function ThreadCard({
  thread,
  editing,
  replying,
  replyOffered,
  onReply,
  onStopReplying,
  onEdit,
  onStopEditing,
  onDelete,
  onResolved,
}: {
  thread: ArtifactCommentThread;
  editing: ArtifactCommentId | null;
  /** This card's reply box, when Reply opened it. */
  replying: { replyTo: ArtifactComment; key: number } | null;
  /** Whether Reply is offered (A, posted at once; B, Send or Save Draft). */
  replyOffered: boolean;
  onReply: (threadId: ArtifactCommentId, comment: ArtifactComment) => void;
  onStopReplying: () => void;
  onEdit: (id: ArtifactCommentId) => void;
  onStopEditing: (id: ArtifactCommentId, wanted?: () => boolean) => void;
  onDelete: (comment: ArtifactComment) => void;
  /** Resolve or Reopen changed it (#249): resolved now, or open. */
  onResolved: (threadId: ArtifactCommentId, resolved: boolean, wanted: () => boolean) => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const comments = useArtifactComments();
  const resolution = useThreadResolution(thread, onResolved);
  const anchor = anchorOf(thread.first);
  const pending = usePendingReplies(thread);
  const found = useAnchorFound(thread.first);
  const active = comments?.activeThreadId === thread.id;
  const setActive = comments?.setActiveThreadId;
  const activate = useCallback(() => setActive?.(thread.id), [setActive, thread.id]);
  // Under a placeholder (the comment it answers is on an earlier page), a reply answers the first reply. Drawn and
  // focused within the press (flushSync): iOS Safari opens the keyboard only for a focus made during the tap itself, and
  // a Reply is the person asking to type, on touch too.
  const reply = useCallback(() => flushSync(() => onReply(thread.id, thread.root ?? thread.first)), [onReply, thread.id, thread.root, thread.first]);
  const replyTo = replying?.replyTo ?? null;
  const replyMode = useMemo(() => (replyTo ? { kind: "new" as const, target: replyTo.target, replyTo } : null), [replyTo]);
  const { draftOption } = useReplyDraftOption(replyTo);
  return (
    <CommentCard
      active={active}
      aria-current={active || undefined}
      tabIndex={-1}
      onClick={activate}
      onFocus={activate}
      data-thread-id={thread.id}
      data-testid="artifact-comment-thread"
      className="outline-none"
    >
      {anchor ? (
        // A button: from the keyboard too, it makes this the thread being read (its passage takes the active highlight).
        // raft-ui's CommentCardMeta draws a button render as clickable text: the hover underline and the focus ring.
        <CommentCardMeta
          render={<button type="button" />}
          onClick={activate}
          data-testid="artifact-comment-anchor"
          data-found={found ? "true" : "false"}
        >
          {found ? null : <MapPinOff aria-hidden />}
          <span className="min-w-0 truncate"><AnchorMeta anchor={anchor} found={found} /></span>
        </CommentCardMeta>
      ) : null}
      {thread.root ? (
        <CommentItem comment={thread.root} editing={editing === thread.root.id} onEdit={onEdit} onStopEditing={onStopEditing} onDelete={onDelete} />
      ) : (
        <p className="text-callout text-foreground-hint italic" data-testid="artifact-comment-earlier-placeholder">
          {formatMessage({ id: "artifacts.comments.replyToEarlier" })}
        </p>
      )}
      {/* DS Comment: each reply is one more CommentEntry in the card's column, straight after the one before. */}
      {thread.replies.map((replyComment) => (
        <CommentItem key={replyComment.id} comment={replyComment} editing={editing === replyComment.id} onEdit={onEdit} onStopEditing={onStopEditing} onDelete={onDelete} />
      ))}
      {pending.map((draft) => <PendingReplyDraft key={draft.id} draft={draft} thread={thread} />)}
      {resolution.resolved ? <ResolvedBy root={thread.root!} /> : null}
      {replyMode && replying ? (
        <ArtifactDismissableBox onDismiss={onStopReplying}>
          <ArtifactCommentBox key={replying.key} mode={replyMode} draftOption={draftOption} onCancel={onStopReplying} onDone={onStopReplying} autoFocusKey={replying.key} />
        </ArtifactDismissableBox>
      ) : (replyOffered && comments?.data.capabilities.comment) || resolution.may ? (
        <div className="flex items-center gap-1">
          {replyOffered && comments?.data.capabilities.comment ? (
            <Button variant="ghost" size="md" onClick={reply} data-testid="artifact-comment-reply">
              <Reply />
              {formatMessage({ id: "artifacts.comments.reply" })}
            </Button>
          ) : null}
          <ResolveButton resolution={resolution} />
        </div>
      ) : null}
    </CommentCard>
  );
}

export function CommentItem({
  comment,
  editing,
  onEdit,
  onStopEditing,
  onDelete,
  listWay = null,
  inCard = false,
}: {
  comment: ArtifactComment;
  editing: boolean;
  onEdit: (id: ArtifactCommentId) => void;
  onStopEditing: (id: ArtifactCommentId, wanted?: () => boolean, pressed?: boolean) => void;
  onDelete: (comment: ArtifactComment) => void;
  /** First in this comment's ⋯, which it brings to a comment that has none: anyone's, or one being edited. */
  listWay?: ArtifactCardListWay | null;
  /** In the open thread's card (its edit box keeps the card while it holds words). */
  inCard?: boolean;
}) {
  const intl = useIntl();
  const { formatMessage, locale } = intl;
  const comments = useArtifactComments();
  const viewer = comments?.viewer ?? null;
  const own = isOwnComment(comment, viewer);
  const shownVersion = comments?.data.card.version;
  // Drawn and focused within the press (flushSync), as Reply: iOS Safari opens the keyboard only for a focus made during
  // the tap itself, and an Edit is the person asking to type, on touch too.
  const edit = useCallback(() => flushSync(() => onEdit(comment.id)), [onEdit, comment.id]);
  const remove = useCallback(() => onDelete(comment), [onDelete, comment]);
  const editMode = useMemo(() => ({ kind: "edit" as const, comment }), [comment]);
  const stop = useCallback(() => onStopEditing(comment.id), [onStopEditing, comment.id]);
  const saved = useCallback((wanted?: () => boolean) => onStopEditing(comment.id, wanted), [onStopEditing, comment.id]);
  // The ⋯ menu stays while it is open (its items go): Edit's box takes focus within the tap, then the menu closes with
  // focus already out of it, so it gives none back (gone in the same commit, it would hand focus to an earlier element
  // after the tap).
  const [menuOpen, setMenuOpen] = useState(false);
  const pressedOutside = useCallback(() => onStopEditing(comment.id, undefined, true), [onStopEditing, comment.id]);
  if (comment.deletedAt) {
    // Kept for its replies (contract #10877): no author, no text.
    return (
      <CommentEntry data-testid="artifact-comment-deleted" data-comment-id={comment.id}>
        <CommentEntryBody className="text-foreground-hint italic">{formatMessage({ id: "artifacts.comments.deleted" })}</CommentEntryBody>
      </CommentEntry>
    );
  }
  const authorName = artifactActorName(comment.author, formatMessage);
  const moreLabel = formatMessage({ id: "artifacts.comments.more" }, { name: authorName });
  const writable = own && !editing;
  return (
    <CommentEntry data-testid="artifact-comment" data-comment-id={comment.id} data-author={actorKey(comment.author)}>
      <CommentEntryHeader>
        <ArtifactActorAvatar actor={comment.author} context="comment-entry" />
        <CommentEntryAuthor>{authorName}</CommentEntryAuthor>
        {comment.author.type === "agent" ? <AgentTag /> : null}
        <CommentEntryTime dateTime={comment.createdAt}>{formatRelativeTime(comment.createdAt, locale) ?? ""}</CommentEntryTime>
        {comment.editedAt ? (
          <span className="shrink-0 text-caption text-foreground-hint" data-testid="artifact-comment-edited">
            {formatMessage({ id: "artifacts.comments.edited" })}
          </span>
        ) : null}
        {shownVersion !== undefined && comment.version !== shownVersion ? (
          <span className="shrink-0" data-testid="artifact-comment-version"><ArtifactVersionBadge version={comment.version} /></span>
        ) : null}
        {writable || listWay || menuOpen ? (
          <DropdownMenu onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={(
                <Button variant="ghost" size="icon-md" className="ms-auto" aria-label={moreLabel} data-testid="artifact-comment-menu">
                  <EllipsisVertical />
                </Button>
              )}
            />
            <DropdownMenuContent side="bottom" align="end" aria-label={moreLabel}>
              {listWay ? (
                <DropdownMenuItem onClick={listWay.open} disabled={listWay.off} data-testid="artifact-comment-open-in-list">
                  <CommentIcon />
                  {formatMessage({ id: "artifacts.comments.openInList" })}
                </DropdownMenuItem>
              ) : null}
              {writable ? (
                <>
                  {/* Relies on Base UI calling this onClick before its own close: flushSync commits the box while the menu is still open (menuOpen above). */}
                  <DropdownMenuItem onClick={edit} data-testid="artifact-comment-edit">
                    <Pencil />
                    {formatMessage({ id: "artifacts.comments.edit" })}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={remove} data-testid="artifact-comment-delete">
                    <Trash2 />
                    {formatMessage({ id: "artifacts.comments.delete" })}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </CommentEntryHeader>
      {editing ? (
        <ArtifactDismissableBox onDismiss={pressedOutside}>
          <ArtifactCommentBox mode={editMode} onDone={saved} onCancel={stop} autoFocusKey={1} inCard={inCard} />
        </ArtifactDismissableBox>
      ) : (
        <>
          <CommentEntryBody data-testid="artifact-comment-body">
            <ArtifactCommentText body={comment.body} viewer={viewer} />
          </CommentEntryBody>
          <ArtifactCommentGallery artifactId={comments?.data.card.id ?? null} images={comment.images} />
        </>
      )}
    </CommentEntry>
  );
}
