import type { ArtifactReviewStatus } from "./ArtifactReviewContext";

/** What decides whether the surface shows a newer version at once (followsLatest). */
export interface FollowLatestState {
  /** The reader picked the version shown (version history, or a link to `@vN`): they asked for it, so it stays. */
  pinned: boolean;
  /** A version is loading, or failed to (its strip, with Retry, has the place). */
  loading: boolean;
  /** Comment mode: only A (browsing) follows; B and C are on drafts placed on the version shown. */
  mode: ArtifactReviewStatus;
  /**
   * The reader is in the middle of something on the version shown: a comment box holds their
   * words (any box), or is focused, or was opened by them (a reply's, an edit's: any box but the
   * list's foot), even empty, since spoken words may not have landed yet (#proj-workspace:#144); a
   * thread's or new comment's card is open (a marker's, a link's landing), a selection's options or
   * Comment box is open, or the version sheet is.
   */
  midAction: boolean;
}

/**
 * Whether a newer version is shown at once instead of its strip: by default yes
 * (xxchan, #proj-workspace:b00bda88: reading an Artifact means reading its newest
 * version, so the strip is only for when switching would get in the way). Not on
 * a version the reader picked, not in comment mode's B or C, not while a version
 * loads or failed, and never under someone writing. There the strip stays, and
 * View latest is theirs to press.
 */
export function followsLatest(state: FollowLatestState): boolean {
  return !state.pinned && !state.loading && state.mode === "browsing" && !state.midAction;
}
