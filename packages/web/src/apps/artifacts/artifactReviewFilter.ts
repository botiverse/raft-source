import { useMemo, useState } from "react";
import type { ArtifactActor, ArtifactReviewId } from "@botiverse/raft-shared";

import type { ArtifactCommentsReview, ShownReview } from "./artifactCommentsShapes";

/**
 * The review the comment list was opened at (its Activity row), for the list's Filter button
 * (ArtifactCommentsPanel ReviewFilter, #proj-workspace:#250; Kirby, #13758): whether it is shown
 * alone now, who wrote it (once its page said; kept after Show All drops that answer, so the menu
 * still names it), and how to show it alone again (null: its owner doesn't offer that).
 */
export interface ArtifactReviewFilter {
  shown: boolean;
  author: ArtifactActor | null;
  show: (() => void) | null;
}

export function useReviewFilter(review: ArtifactCommentsReview | null, reviewShown: ArtifactReviewId | null, shownReview: ShownReview | null): ArtifactReviewFilter | null {
  const answered = shownReview?.status === "ok" ? shownReview.review.author : null;
  // oxlint-disable-next-line react-doctor/no-derived-useState -- its author, kept after Show All drops the answer (React's "adjusting state when a prop changes").
  const [kept, setKept] = useState<{ id: ArtifactReviewId; actor: ArtifactActor } | null>(null);
  if (reviewShown !== null && answered && kept?.actor !== answered) setKept({ id: reviewShown, actor: answered });
  const id = review?.id ?? null;
  const show = review?.onShow ?? null;
  return useMemo(() => (id === null ? null : {
    shown: reviewShown !== null,
    author: kept?.id === id ? kept.actor : answered,
    show,
  }), [id, reviewShown, kept, answered, show]);
}
