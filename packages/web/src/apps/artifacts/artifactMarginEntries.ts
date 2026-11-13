import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ArtifactComment, ArtifactCommentDraft } from "@botiverse/raft-shared";

import { buildThreads, isResolvedThread } from "./artifactComments";
import type { ArtifactCommentThread } from "./artifactComments";
import { useArtifactComments } from "./ArtifactCommentsContext";
import type { ArtifactCommentsState } from "./ArtifactCommentsContext";
import { NO_MARGIN_PLACES } from "./artifactMarginPlaces";
import type { MarginPlacesStore } from "./artifactMarginPlaces";
import { useArtifactReview } from "./ArtifactReviewContext";

/** The margin's width beside a Markdown Artifact, px (the mockup's cards are 280 wide, with room around them). */
export const MARKDOWN_MARGIN_WIDTH_PX = 304;

type Target = ArtifactComment["target"];

/** Whether `target` is a passage of the file shown (an annotation anchor): only those have a card in the margin. */
const onPassage = (target: Target, path: string | null) =>
  target.scope === "file" && target.path === path && target.anchor?.type === "annotation";

/** A thread's or a draft's card in the margin, by the id its mark has in the frame. */
export type MarginEntry =
  | { kind: "thread"; id: string; thread: ArtifactCommentThread }
  | { kind: "draft"; id: string; draft: ArtifactCommentDraft };

/** The threads on the shown file's passages and the person's own drafts there, as the frame marks them. */
export function useMarginEntries(comments: ArtifactCommentsState | null): MarginEntry[] {
  const review = useArtifactReview();
  const loaded = comments?.comments ?? null;
  const hasEarlier = comments?.hasEarlier ?? false;
  const path = comments?.shownPath ?? null;
  const drafts = review?.drafts ?? null;
  return useMemo(() => {
    const entries: MarginEntry[] = [];
    for (const thread of buildThreads(loaded ?? [], { parentsMayBeOlder: hasEarlier })) {
      // A resolved thread has no mark, so no card beside it either (#249).
      if (thread.root && !isResolvedThread(thread) && onPassage(thread.root.target, path)) entries.push({ kind: "thread", id: thread.id, thread });
    }
    // A reply's draft shows under its thread's replies (ArtifactPendingReplies), not as a card of its own.
    for (const draft of drafts ?? []) {
      if (draft.replyTo === null && onPassage(draft.target, path)) entries.push({ kind: "draft", id: draft.id, draft });
    }
    return entries;
  }, [loaded, hasEarlier, path, drafts]);
}

type MarginValue = ReturnType<MarginPlacesStore["get"]>;

/**
 * A part of where a Markdown Artifact's margin cards go (artifactMarginPlaces): the known tops, the
 * marks whose passage is gone, the reference mark, the refresh. Each changes only when the frame
 * reports where marks are or the margin asks again, never on a scroll (the shift), so reading it
 * re-renders nothing as the page scrolls.
 */
function useMarginPart<T>(select: (value: MarginValue) => T, fallback: T): T {
  const store = useArtifactComments()?.margin.places ?? null;
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  return useSyncExternalStore(subscribe, () => (store ? select(store.get()) : fallback));
}
// Stale tops (the reference lost: they say nothing of where the page is now) are none: cards hidden
// until the next report, never left where the page was before a jump.
const selectTops = ({ places }: MarginValue) => (places.stale ? NO_MARGIN_PLACES.tops : places.tops);
const selectOrphaned = ({ places }: MarginValue) => places.orphaned;
const selectRef = ({ places }: MarginValue) => places.ref;
const selectRefresh = ({ refresh }: MarginValue) => refresh;
export const useMarginTops = () => useMarginPart(selectTops, NO_MARGIN_PLACES.tops);
export const useMarginOrphaned = () => useMarginPart(selectOrphaned, NO_MARGIN_PLACES.orphaned);
/** The margin's reference mark (the frame follows it) and how often it asked for every place again (the refresh mark's number). */
export const useMarginRef = () => useMarginPart(selectRef, null);
export const useMarginRefresh = () => useMarginPart(selectRefresh, 0);
