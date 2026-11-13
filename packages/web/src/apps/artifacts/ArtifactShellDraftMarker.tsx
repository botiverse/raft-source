import { useCallback, useId } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { CommentCardQuote, CommentMarker } from "@botiverse/raft-ui/wip";
import type { ArtifactCommentDraft } from "@botiverse/raft-shared";

import { anchorLabel } from "./ArtifactActorParts";
import type { ShellAnchor } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { draftExcerpt } from "./artifactDraftDelete";
import { useArtifactReview } from "./ArtifactReviewContext";
import { draftDrawn } from "./artifactRestoredFocus";

/**
 * A draft of the person's on a text or csv file's lines or rows (#148 follow-up): a marker in the
 * file's margin beside the posted comments' (ArtifactShellComments), drawn as a framed page's draft
 * pin is (Porthole's: dashed, hollow, no text), so a draft is seen where it was written on every
 * kind of file. raft-ui's CommentMarker with a dashed edge and nothing in it; its name says it is
 * the person's draft and its description where and what. Pressed, the draft's own view opens
 * beside it (ArtifactDraftView, Raft's own press: not armed, focus in it); while the comment list is
 * open, its card in "Your drafts" instead (one list at a time, as a thread's marker).
 */
export function ShellDraftMarker({ draft, anchor }: { draft: ArtifactCommentDraft; anchor: ShellAnchor }) {
  const intl = useIntl();
  const review = useArtifactReview();
  const panelOpen = useArtifactComments()?.panelOpen ?? false;
  const descriptionId = useId();
  const openDraftView = review?.openDraftView;
  const draftId = draft.id;
  const open = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (panelOpen) {
      const card = event.currentTarget.closest("[data-artifact-focus]")
        ?.querySelector<HTMLElement>(`[data-testid='artifact-comments-drafts'] [data-draft-id="${CSS.escape(draftId)}"]`);
      if (card) {
        card.scrollIntoView?.({ block: "nearest" });
        card.focus({ preventScroll: true });
        return;
      }
    }
    const box = event.currentTarget.getBoundingClientRect();
    openDraftView?.(draftId, { x: box.left, y: box.top, width: box.width, height: box.height });
  }, [panelOpen, openDraftView, draftId]);
  // Made again by its deletion's toast (its Undo): focus comes as it is drawn (a ref, at once on mount).
  const attach = useCallback((element: HTMLButtonElement | null) => {
    if (element) draftDrawn(draftId);
  }, [draftId]);
  const place = anchorLabel(anchor, intl);
  return (
    <>
      <CommentMarker
        ref={attach}
        active={review?.draftView?.draftId === draftId}
        aria-label={intl.formatMessage({ id: "artifacts.review.draftViewLabel" })}
        aria-describedby={descriptionId}
        onClick={open}
        className="w-6 justify-center border-dashed bg-transparent ps-0 pe-0 data-active:ps-0 data-active:pe-0"
        data-testid="artifact-comment-draft-marker"
        data-draft-id={draftId}
      />
      <CommentCardQuote id={descriptionId}>
        {intl.formatMessage({ id: "artifacts.comments.anchorWithQuote" }, { place, quote: draftExcerpt(draft, intl, null) })}
      </CommentCardQuote>
    </>
  );
}
