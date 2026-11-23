import { useArtifactComments } from "./ArtifactCommentsContext";
import { useArtifactListCompose } from "./artifactListCompose";
import { useArtifactReview } from "./ArtifactReviewContext";
import { useShownPicksElements } from "./artifactShownFile";

/**
 * What the header's Comment (and its folded ⋯ item) does where comment mode would change nothing: on a
 * page with no block to pick (artifactShownFile `useShownPicksElements` false: Markdown, a PDF, a file
 * Raft draws), its text is selected to comment either way, so Comment opens the comment list with its
 * box focused, for a comment on the whole Artifact (artifactListCompose `writeInList`; artin,
 * #proj-workspace:#323). Null there while comment mode or C is on (from an HTML page of the same set),
 * so the toggle stays to leave it, and on a page with blocks to pick.
 */
export function useCommentWritesOnArtifact(): (() => void) | null {
  const status = useArtifactReview()?.status ?? null;
  const picksElements = useShownPicksElements(useArtifactComments()?.data ?? null);
  const writeInList = useArtifactListCompose()?.writeInList ?? null;
  return !picksElements && status === "browsing" ? writeInList : null;
}
