import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { ARTIFACT_DRAFT_MAX_PER_ARTIFACT } from "@botiverse/raft-shared";
import type { ArtifactComment, ArtifactCommentPart, ObjectFileId } from "@botiverse/raft-shared";

import type { ArtifactCommentBoxDraftOption } from "./ArtifactCommentBox";
import type { ArtifactCommentTarget } from "./ArtifactCommentsContext";
import { useArtifactReview } from "./ArtifactReviewContext";

/**
 * Save Draft beside Send, for any box that writes a new comment or a reply (#proj-workspace:#148:
 * every box has the pair, with the same Enter rules): `onSave` keeps the words as a draft. Null
 * where drafts aren't offered (no right to comment, the flag off) or in C (a refused send is open),
 * and for a null `onSave`. With drafts already waiting Enter saves one more; at the 50-draft cap
 * Save Draft is off and says why; while a send is out it waits. `onSave` also gets the box's
 * uploaded images' ids (#proj-workspace:#146), for the draft to carry.
 */
export function useDraftOption(onSave: ((body: ArtifactCommentPart[], images: ObjectFileId[]) => Promise<void>) | null): ArtifactCommentBoxDraftOption | null {
  const { formatMessage } = useIntl();
  const review = useArtifactReview();
  const offered = !!review?.draftsOffered && review.status !== "reviewing";
  const submitting = review?.submitting ?? false;
  const draftCount = review?.draftCount ?? 0;
  const full = draftCount >= ARTIFACT_DRAFT_MAX_PER_ARTIFACT;
  return useMemo<ArtifactCommentBoxDraftOption | null>(() => (offered && onSave ? {
    onSave,
    enterSaves: draftCount > 0,
    blocked: full ? formatMessage({ id: "artifacts.review.draftLimit" }, { limit: ARTIFACT_DRAFT_MAX_PER_ARTIFACT }) : null,
    busy: submitting,
  } : null), [offered, onSave, draftCount, full, submitting, formatMessage]);
}

/** Save Draft at a place the box knows (a file's lines or rows, a page's place, the whole Artifact). */
export function useDraftOptionAt(target: ArtifactCommentTarget): ArtifactCommentBoxDraftOption | null {
  const addDraftAt = useArtifactReview()?.addDraftAt;
  const onSave = useCallback((body: ArtifactCommentPart[], images: ObjectFileId[]) => addDraftAt!(target, body, images), [addDraftAt, target]);
  return useDraftOption(addDraftAt ? onSave : null);
}

/**
 * Where Reply is offered (a thread's card, the list) and what its box does: Send posts it at once,
 * Save Draft makes a draft that replies to `replyTo` (xxchan #proj-workspace:f07141a9, as on
 * GitHub), in A and B alike; in C there is no Reply.
 */
export function useReplyDraftOption(replyTo: ArtifactComment | null): { offered: boolean; draftOption: ArtifactCommentBoxDraftOption | null } {
  const review = useArtifactReview();
  const addReplyDraft = review?.addReplyDraft;
  const replyId = replyTo?.id ?? null;
  const onSave = useCallback((body: ArtifactCommentPart[], images: ObjectFileId[]) => addReplyDraft!(replyId!, body, images), [addReplyDraft, replyId]);
  const draftOption = useDraftOption(addReplyDraft && replyId ? onSave : null);
  return { offered: (review?.status ?? "browsing") !== "reviewing", draftOption };
}
