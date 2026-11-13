import type { Ref, RefObject } from "react";
import type { ArtifactCommentAnchor, ArtifactCommentId, ArtifactReviewId, ArtifactWebReview } from "@botiverse/raft-shared";
import type { AnnotateMode, AnnotationMark, AnnotationRect, AnnotationReport } from "@botiverse/porthole";
import type { PortholeFrameHandle } from "@botiverse/porthole/react";

import type { FrameBox } from "./artifactTrackedPlaces";

// The comments context's shapes (ArtifactCommentsContext re-exports them).

/** Where a new comment goes: the whole Artifact, or a file (and a place in it). */
export type ArtifactCommentTarget =
  | { scope: "artifact" }
  | { scope: "file"; path: string; anchor: ArtifactCommentAnchor | null };

/**
 * A thread's card a frame's `activated` found the focus in the frame for (Porthole P134): the card
 * takes the focus from `frame`, on its container (ArtifactCommentBubble). Held, it goes on to
 * whatever card replaces this one, any thread's; only a press lifts it (artifactCardHold).
 */
export interface ArtifactBubbleKeyboard {
  frame: HTMLIFrameElement;
  /** The report that last found the focus there (a bubble `key`): the card takes the focus once for each. */
  at: number;
  /** Nothing in the card writes until the person presses in it (artifactCardHold). */
  held: boolean;
}

/**
 * The floating card (co-design S2, S3, S10): `thread`, a discussion opened from its marker
 * (`fromFrame`: by the page's report, so armed and taking no focus, but for `keyboard`; `pinned` once the person
 * pressed in it, after which the page's reports no longer move it), or `compose`, a new comment
 * (Raft's own Comment on a selection, focused; or the page's button, `fromPage`, which the box
 * treats as the page's: armed, unfocused, its text "Suggested by this page"). `rect`: what it
 * opens beside, in client px (null: the frame's top, or nothing known). A thread's `sent`: the
 * comment just sent from the card it took the place of (`revealSent`), marked Sent while it is open.
 * A compose card's `restored`: opened again for words left unsent before a reload
 * (useUnsentCommentOffer), so it takes no focus (no keyboard pops up on a phone).
 */
export type ArtifactCommentBubble =
  | { kind: "thread"; threadId: ArtifactCommentId; rect: AnnotationRect; key: number; fromFrame: boolean; pinned: boolean; sent?: ArtifactCommentId; keyboard?: ArtifactBubbleKeyboard | null }
  | { kind: "compose"; target: ArtifactCommentTarget; rect: AnnotationRect | null; key: number; fromPage: { draft: string | null } | null; restored?: boolean };

/**
 * A review the list is opened at, and how to leave it (the address that names it is its owner's).
 * `shown: false`: left for every comment (Show All, the filter chip's ×), still offered again by the
 * comment list's Filter button through `onShow` (#proj-workspace:#250, Kirby: a FilterChip sits beside
 * a Filter button that always says Filter).
 */
export interface ArtifactCommentsReview {
  id: ArtifactReviewId;
  onShowAll: () => void;
  /** Whether the list shows it alone now; absent: it does. */
  shown?: boolean;
  /** Show it alone again (its owner puts it back in the address); absent: not offered. */
  onShow?: () => void;
}

/** The review the list shows alone, as the server answered for it. */
export type ShownReview =
  | { status: "ok"; review: ArtifactWebReview; commentIds: ReadonlySet<ArtifactCommentId> }
  | { status: "missing" }
  | { status: "failed" };

/** Where a comment was sent from that closes when it sends: its card's place, and the new comment's card it was (null: a selection's). */
export interface SentFrom {
  rect: AnnotationRect | null;
  bubbleKey: number | null;
}

/**
 * What a framed page's PortholeFrame is given and reports to (ArtifactFrame): the comments' own
 * (posted threads' marks, the card's mark followed) or comment mode's on top (ArtifactReviewContext:
 * drafts' marks, what the person may point at, and `handle`, to take a used selection away).
 */
export interface ArtifactFrameLayer {
  marks: AnnotationMark[];
  /** The mark to bring into view; with a key when it is asked for again (a landing, artifactLandingPlace). */
  focusedMark: string | { id: string; key: number } | null;
  /**
   * The mark whose open thread card follows it (Porthole `trackedAnnotation`, P112, P118): its
   * `tracked` boxes move the card (`useTrackedPlace`). Null: no card, or one the person pressed in,
   * or a Markdown margin drawn (the frame follows the margin's reference mark then, ArtifactFrame).
   */
  trackedMark: string | null;
  /**
   * Whether the frame follows the selection instead (Porthole `trackedSelection`, P138, P140): true
   * while comment mode's composer is open at a selection or a picked block, which moves with it
   * (SelectionBox). Always given, false from the first render (the comments' own layer too), so
   * every start of `annotating` keeps what is picked or selected for the follow; never left out.
   */
  trackedSelection: boolean;
  annotating: (kind: "html" | "markdown" | "pdf") => AnnotateMode | null;
  /** `shownMarks`: the marks the frame was given, when another layer (comment mode) gave them. */
  onAnnotation: (report: AnnotationReport, frameBox: FrameBox | null, shownMarks?: readonly { id: string }[]) => void;
  /** The frame's `PortholeFrameHandle`: `clearSelection` for comment mode, `focusMark` for the comments' card. */
  handle?: Ref<PortholeFrameHandle>;
  /** The comments' own: what the frame is drawn in (ArtifactFrame), where a card that took no focus finds it to give it the focus. */
  box?: RefObject<HTMLDivElement | null>;
}
