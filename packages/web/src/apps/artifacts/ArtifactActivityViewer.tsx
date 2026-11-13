import { useMemo, useState } from "react";
import { parseArtifactId } from "@botiverse/raft-shared";
import type { ArtifactCommentId, ArtifactReviewId } from "@botiverse/raft-shared";

import type { ArtifactLinkTarget } from "./artifactLinks";

import ArtifactViewer from "./ArtifactViewer";

export interface ArtifactActivityViewerProps {
  /** The Artifact's id, as Activity's detail slot (and its address, `?artifact=<id>`) names it. */
  id: string;
  /** The version the row is about when it is not the latest (`&version=`), else the latest. */
  version?: number;
  /** The review the row is about (`&review=`): the comment list opens on its comments alone. */
  review?: ArtifactReviewId;
  /** The comment the row is about (its target's): the viewer lands on it (ArtifactCommentsProvider's `landOn`). */
  comment?: ArtifactCommentId;
  /** Show All Comments: the slot without its review (the address loses `&review=`). */
  onShowAllComments?: () => void;
  /** The review shown alone again (the comment list's Filter button): the slot's `review`, the address's `&review=`. */
  onShowReview?: (review: ArtifactReviewId) => void;
  /** A version picked in the viewer (null: the latest): the slot's `version`, the address's `&version=` replaced. */
  onShowVersion?: (version: number | null) => void;
  /** A phone: the viewer is a page pushed in place of the list, with its own Back. */
  covering: boolean;
  onClose: () => void;
  /** What it was opened from (`artifact_opened`): an Activity row, or a Search hit (its detail slot too). */
  source?: "activity" | "search";
}

/**
 * An Artifact opened from its Activity row (xxchan, Remy): the viewer in
 * Activity's main area, beside the list, as a conversation row opens its
 * conversation; on a phone a page pushed in place of the list, whose Back
 * returns to it. It records `artifact_opened` source `activity`; Search's
 * detail slot shows an Artifact hit the same way, source `search`.
 */
export default function ArtifactActivityViewer({ id, version, review, comment, onShowAllComments, onShowReview, onShowVersion, covering, onClose, source = "activity" }: ArtifactActivityViewerProps) {
  const target = useMemo<ArtifactLinkTarget | null>(() => {
    const parsed = parseArtifactId(id);
    // Never otherwise: the slot's address only takes a bare Artifact id (parseSearchOpenParam).
    return parsed === null ? null : { id: parsed, version: version ?? null };
  }, [id, version]);
  // The review this Artifact was opened at, kept after Show All, so the list's Filter button offers it again.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the last review the row named, for this Artifact (React's "adjusting state when a prop changes").
  const [last, setLast] = useState<{ id: string; review: ArtifactReviewId } | null>(review ? { id, review } : null);
  if (review && (last?.id !== id || last.review !== review)) setLast({ id, review });
  const lastReview = last?.id === id ? last.review : null;
  // The same viewer across Show All (no reload of the page); another review reopens its list.
  const reviewOpen = useMemo(() => (lastReview && onShowAllComments ? {
    id: lastReview,
    onShowAll: onShowAllComments,
    shown: review === lastReview,
    onShow: onShowReview ? () => onShowReview(lastReview) : undefined,
  } : null), [lastReview, review, onShowAllComments, onShowReview]);
  if (!target) return null;
  // One viewer per Artifact: another version (a pick here, written to the address) is shown in it, as Show All is.
  return (
    <ArtifactViewer
      key={target.id}
      target={target}
      review={reviewOpen}
      landOn={comment ?? null}
      source={source}
      expanded
      covering={covering}
      ownBack
      onClose={onClose}
      onShowVersion={onShowVersion}
    />
  );
}
