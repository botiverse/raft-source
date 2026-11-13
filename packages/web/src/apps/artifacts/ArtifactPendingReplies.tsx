import { useCallback, useMemo, useRef, useState } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- Edit draws and focuses its box within the tap: iOS Safari opens the keyboard only for a focus made during the tap event itself (focus plan rule 5 decision).
import { flushSync } from "react-dom";
import { useIntl } from "react-intl";
import { EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@botiverse/raft-ui";
import { CommentEntry, CommentEntryBody, CommentEntryHeader } from "@botiverse/raft-ui/wip";
import type { ArtifactComment, ArtifactCommentDraft, ArtifactCommentId } from "@botiverse/raft-shared";

import { ArtifactCommentText } from "./ArtifactCommentText";
import { ArtifactCommentGallery } from "./ArtifactCommentGallery";
import ArtifactCommentBox from "./ArtifactCommentBox";
import { ArtifactDismissableBox } from "./ArtifactDismissableBox";
import type { ArtifactCommentBoxBatch } from "./ArtifactCommentBox";
import type { ArtifactCommentThread } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useDeleteDraft } from "./artifactDraftDelete";
import { draftDrawn } from "./artifactRestoredFocus";
import { useArtifactReview } from "./ArtifactReviewContext";
import { OVERLAY } from "../../utils/focusGuard";
import { requestFocus, watchFocusIntent } from "../../utils/focusRequest";

/**
 * The person's reply drafts in a thread (Save Draft in a reply box, `replyTo`; useReplyDraftOption): shown
 * under the thread's replies, in its card and in the list (Remy, #proj-workspace:d03c42a0), in A and
 * B alike since drafts are changed where they are (#proj-workspace:#148), so a reply kept as a draft
 * is seen where it was written. Not in C, which lists them as its own cards (ArtifactReviewPanel).
 */
export function usePendingReplies(thread: ArtifactCommentThread): ArtifactCommentDraft[] {
  const review = useArtifactReview();
  const drafts = review && review.status !== "reviewing" ? review.drafts : null;
  return useMemo(() => {
    if (!drafts) return [];
    // A reply draft answers a comment of the thread (its root, or the first reply under a placeholder).
    const ids = new Set<ArtifactCommentId>([thread.id, ...(thread.root ? [thread.root.id] : []), ...thread.replies.map((r) => r.id)]);
    return drafts.filter((d) => d.replyTo !== null && d.replyTo !== undefined && ids.has(d.replyTo));
  }, [drafts, thread]);
}

/** Frames to wait for a layer over the card to close: about a second, then asked as it stands. */
const LAYER_CLOSE_FRAMES = 60;

/**
 * Runs `then` a frame after no layer opened over `card` (a dialog or modal layer not containing it) holds focus: a
 * request made while one does would be refused (focus never goes behind an open modal layer, behindModalLayer), and
 * focus in it is not yet where the person left it.
 */
function afterLayerOver(card: HTMLElement | null, then: () => void, frames = LAYER_CLOSE_FRAMES): void {
  requestAnimationFrame(() => {
    const layer = document.activeElement?.closest(OVERLAY);
    if (frames > 0 && layer && !(card && layer.contains(card))) afterLayerOver(card, then, frames - 1);
    else then();
  });
}

/**
 * One pending reply draft in a thread: one more CommentEntry in the card (DS Comment, as a posted
 * reply), headed "Your draft" where a posted one has its author and time, so it reads as the
 * person's and not yet anyone's to read (raft-ui's comment parts have no pending variant; no rail
 * of its own, tests/artifactsRaftUiOverlays.contract.test.ts). Edit and Delete are behind its ⋯
 * (two presses, so a card the page's report opened deletes nothing in one, Porthole 0.13 host rules;
 * armed, it takes none). Delete goes as every draft's (useDeleteDraft: at once, its toast with
 * Undo; one with images after a confirmation), and focus moves to the thread's card it was in.
 */
export function PendingReplyDraft({ draft, thread, onDelete }: {
  draft: ArtifactCommentDraft;
  thread: ArtifactCommentThread;
  /**
   * The card's own delete, where the card is a popover (the thread's card beside its marker): its
   * confirmation (a draft with images) is drawn outside the card, which steps aside for it, as a
   * comment's delete confirm does. Else this entry's own.
   */
  onDelete?: (draft: ArtifactCommentDraft) => Promise<boolean>;
}) {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const comments = useArtifactComments();
  const [editing, setEditing] = useState(false);
  const updateDraft = review?.updateDraft;
  const submitting = review?.submitting ?? false;
  const replyTo: ArtifactComment = useMemo(
    () => [thread.root, ...thread.replies].find((c) => c?.id === draft.replyTo) ?? thread.root ?? thread.first,
    [thread, draft.replyTo],
  );
  const mode = useMemo(() => ({ kind: "new" as const, target: replyTo.target, replyTo }), [replyTo]);
  const body = draft.body;
  const draftId = draft.id;
  const batch = useMemo<ArtifactCommentBoxBatch | null>(() => (updateDraft ? {
    label: formatMessage({ id: "artifacts.review.save" }),
    initial: body,
    draftId,
    onSubmit: (next) => updateDraft(draftId, next),
    busy: submitting,
    images: draft.images,
  } : null), [formatMessage, body, draftId, updateDraft, submitting, draft.images]);
  // Drawn and focused within the press (flushSync), as Reply: iOS Safari opens the keyboard only for a focus made during
  // the tap itself, and an Edit is the person asking to type, on touch too.
  const startEditing = useCallback(() => flushSync(() => setEditing(true)), []);
  const stopEditing = useCallback(() => setEditing(false), []);
  // The ⋯ menu stays while it is open (its items go): Edit's box takes focus within the tap, then the menu closes with
  // focus already out of it, so it gives none back (gone in the same commit, it would hand focus to an earlier element
  // after the tap).
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [deleteDraft, deleteDraftDialog] = useDeleteDraft();
  const remove = useCallback(() => {
    // The thread's card (the list's, or the card beside its marker) keeps focus once this entry goes, unless the
    // person pressed or moved focus elsewhere before the server answered (focus plan rule 3).
    const card = moreRef.current?.closest<HTMLElement>("[data-thread-id]") ?? null;
    const wanted = watchFocusIntent(() => card);
    void (onDelete ?? deleteDraft)(draft).then((deleted) => {
      if (!deleted) {
        wanted();
        return;
      }
      // A draft with images is deleted from its confirmation, which still holds focus as this resolves (it closes,
      // with this entry, in the render after): asked once it has closed, once focus has fallen with it (focusLost).
      afterLayerOver(card, () => {
        if (wanted() && card?.isConnected && card.hasAttribute("tabindex")) requestFocus(() => card, { reason: "async" });
      });
    });
  }, [onDelete, deleteDraft, draft]);
  // Its ⋯, and, as it is drawn for a draft its deletion's toast made again (its Undo), focus to the
  // thread's card it is back in (a ref, so at once on mount, no effect).
  const attachMore = useCallback((element: HTMLButtonElement | null) => {
    moreRef.current = element;
    if (element) draftDrawn(draftId);
  }, [draftId]);
  const moreLabel = formatMessage({ id: "artifacts.review.draftMore" });
  return (
    <>
      <CommentEntry data-testid="artifact-comment-pending-draft" data-draft-id={draft.id} data-reply-to={draft.replyTo ?? undefined}>
        <CommentEntryHeader>
          {/* The row's status, not helper text: the hairline Draft tag every other draft card has (ArtifactReviewParts, ArtifactMarkdownMargin). */}
          <Badge appearance="outline" className="shrink-0" data-testid="artifact-comment-pending-label">{formatMessage({ id: "artifacts.review.draftTag" })}</Badge>
          {editing && !menuOpen ? null : (
            <DropdownMenu onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                render={(
                  <Button ref={attachMore} variant="ghost" size="icon-md" className="ms-auto" aria-label={moreLabel} disabled={submitting} data-testid="artifact-comment-pending-more">
                    <EllipsisVertical />
                  </Button>
                )}
              />
              <DropdownMenuContent side="bottom" align="end" aria-label={moreLabel}>
                {editing ? null : (
                  <>
                    {/* Relies on Base UI calling this onClick before its own close: flushSync commits the box while the menu is still open (menuOpen above). */}
                    <DropdownMenuItem onClick={startEditing} data-testid="artifact-comment-pending-edit">
                      <Pencil />
                      {formatMessage({ id: "artifacts.review.edit" })}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={remove} data-testid="artifact-comment-pending-delete">
                      <Trash2 />
                      {formatMessage({ id: "artifacts.review.delete" })}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </CommentEntryHeader>
        {editing && batch ? (
          <ArtifactDismissableBox onDismiss={stopEditing}>
            <ArtifactCommentBox mode={mode} batch={batch} autoFocusKey={draft.id} onDone={stopEditing} onCancel={stopEditing} />
          </ArtifactDismissableBox>
        ) : (
          <>
            <CommentEntryBody data-testid="artifact-comment-pending-body">
              <ArtifactCommentText body={draft.body} viewer={comments?.viewer ?? null} />
            </CommentEntryBody>
            <ArtifactCommentGallery artifactId={comments?.data.card.id ?? null} images={draft.images} />
          </>
        )}
      </CommentEntry>
      {deleteDraftDialog}
    </>
  );
}
