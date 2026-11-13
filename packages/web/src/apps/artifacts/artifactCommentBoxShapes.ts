import type { ArtifactActor, ArtifactComment, ArtifactCommentDraftId, ArtifactCommentImage, ArtifactCommentPart, ObjectFileId } from "@botiverse/raft-shared";

import type { MentionCandidate } from "../../components/mention";
import type { ArtifactCommentTarget } from "./ArtifactCommentsContext";

// The comment box's shapes (ArtifactCommentBox re-exports the public ones), and its own.

export type ArtifactCommentBoxMode =
  | { kind: "new"; target: ArtifactCommentTarget; replyTo: ArtifactComment | null }
  | { kind: "edit"; comment: ArtifactComment };

/**
 * The box editing a draft (ArtifactReviewContext) instead of posting: its one action is `label`
 * (Save), a text button, never the pink send.
 */
export interface ArtifactCommentBoxBatch {
  label: string;
  /** The body with each mention's picked actor (named, for the draft list). */
  onSubmit: (body: ArtifactCommentPart[]) => Promise<void>;
  /** The draft's body, to edit it. Read on mount. */
  initial?: readonly ArtifactCommentPart[];
  /** The draft edited (with `initial`): its unsent words here are kept under its id (artifactLocalDrafts). */
  draftId?: ArtifactCommentDraftId;
  /** Off for now, saying nothing (a review is being submitted): the words wait in the box. */
  busy?: boolean;
  /** The draft's images: shown, kept as they are (an edit is its text), and enough without text. */
  images?: readonly ArtifactCommentImage[];
}

/**
 * A new comment's box that also keeps it as a draft (#proj-workspace:#148): beside Send (posted at
 * once, notifying), Save Draft (only the writer sees it, until the drafts are sent together). Enter
 * does one, Cmd/Ctrl+Enter the other.
 */
export interface ArtifactCommentBoxDraftOption {
  /** The body with each mention's picked actor (named, for the drafts), and the box's uploaded images' ids, in order. */
  onSave: (body: ArtifactCommentPart[], images: ObjectFileId[]) => Promise<void>;
  /** Enter saves a draft (the person already has drafts here) rather than sending. */
  enterSaves: boolean;
  /** Save Draft off, saying why (the 50-draft cap); Send stays. */
  blocked?: string | null;
  /** Save Draft off for now, saying nothing (the drafts are being sent). */
  busy?: boolean;
}

/**
 * What came of keeping a closing card's words as a draft (`keepRef`): `kept` (saved, the box's
 * `onDone` has run); `failed` (said in the box, which stays); `busy` (a send or an upload is out:
 * nothing now); `unavailable` (no draft can be saved here now: the cap, a review being sent, words
 * the person may not act on yet), so the card closes as before, its words kept on this device.
 */
export type ArtifactCommentBoxKeep = "kept" | "failed" | "busy" | "unavailable";

/** What a box's press does: post the comment, or keep it as a draft. */
export type BoxAction = "post" | "draft";

export type BoxError =
  | { kind: "draftLimit"; limit: number }
  | { kind: "tooLong"; limit: number | null }
  | { kind: "mentionNotVisible"; actors: Array<{ type: string; id: string }> }
  | { kind: "tooManyMentions"; limit: number }
  | { kind: "failed"; draft: boolean };

/** A picked candidate as the Artifact actor its mention names (the audience offers only people and agents). */
export function actorOf(candidate: MentionCandidate): ArtifactActor {
  return {
    type: candidate.type === "agent" ? "agent" : "user",
    id: candidate.id,
    name: candidate.name,
    displayName: candidate.displayName ?? candidate.name,
    avatarUrl: candidate.avatarUrl,
  };
}

export const mentionOptionTestId = (candidate: MentionCandidate) => `artifact-mention-option-${candidate.id}`;
