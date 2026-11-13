// Comment mode's drafts (batch review, design v8: deliverables/artifact-comments-interaction
// states.md), with workspace_artifacts_v0 (no flag of its own): a person's comments on one Artifact, kept on
// the server and seen only by them (S8, shared workspaceArtifacts.ts `ArtifactCommentDraft`),
// written one by one in comment mode and posted together as one review. The routes are the
// Artifact source's (`reviewDrafts`, `createReviewDraft`, …, `submitReview`); what is here is
// the web's reading of their answers.
import { ARTIFACT_DRAFT_TTL_DAYS, ARTIFACT_DRAFT_WARN_AFTER_DAYS, currentTimeMs } from "@botiverse/raft-shared";
import type { ArtifactCommentDraft, ArtifactCommentDraftInput, ArtifactCommentPart, ArtifactReviewRejected } from "@botiverse/raft-shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The code of a submit's refusal (ArtifactReviewRejected): the one a comment would have got. */
export type ArtifactReviewRejectCode = ArtifactReviewRejected["code"];

/** Days until a draft is gone, rounded up (1 on its last day, 0 once it is due), from its `expiresAt`. */
export function draftDaysLeft(draft: Pick<ArtifactCommentDraft, "expiresAt">, now = currentTimeMs()): number {
  return Math.max(0, Math.ceil((Date.parse(draft.expiresAt) - now) / DAY_MS));
}

/** From ARTIFACT_DRAFT_WARN_AFTER_DAYS after its last change (`expiresAt` less the days left then), the review says when it goes. */
export function draftExpiresSoon(draft: Pick<ArtifactCommentDraft, "expiresAt">, now = currentTimeMs()): boolean {
  return Date.parse(draft.expiresAt) - now <= (ARTIFACT_DRAFT_TTL_DAYS - ARTIFACT_DRAFT_WARN_AFTER_DAYS) * DAY_MS;
}

/** A body as the draft and submit routes take it: mentions by type and id only. */
export const draftInputBody = (body: readonly ArtifactCommentPart[]): ArtifactCommentDraftInput["body"] =>
  body.map((part) => (part.type === "text" ? part : { type: "mention", actor: { type: part.actor.type, id: part.actor.id } }));

/** A submit attempt's key: a uuid, 36 of the contract's 1–64 `A-Z a-z 0-9 _ -`. */
export function newReviewClientKey(): string {
  return crypto.randomUUID();
}
