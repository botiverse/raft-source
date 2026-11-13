import type { ArtifactAnnotationAnchor, ArtifactComment, ArtifactCommentDraft, ArtifactWebCommentInput } from "@botiverse/raft-shared";
import type { AnnotationMark } from "@botiverse/porthole";

import { anchorOf, buildThreads, isResolvedThread } from "./artifactComments";
import { refreshMark } from "./artifactMarginPlaces";

/** A thread's comments that count for its bubble: those not deleted. */
const shownCount = (comments: readonly ArtifactComment[]) => comments.filter((c) => !c.deletedAt).length;

/** The page's anchor of a comment or draft on `path`, if it is one the frame draws (an annotation). */
function annotationOn(target: ArtifactWebCommentInput["target"], path: string | null): ArtifactAnnotationAnchor | null {
  if (target.scope !== "file" || target.path !== path) return null;
  return target.anchor?.type === "annotation" ? target.anchor.data : null;
}

/** The most marks one `show` carries (Porthole's ANNOTATION_LIMITS.marks). */
const MAX_MARKS = 500;

/**
 * The marks the frame draws (Porthole P104, P107; Remy's shapes): one per posted thread with an
 * annotation anchor on the shown file (`count`: its comments; the shell draws 99+ above 99), and,
 * with comment mode (the review flag), one per draft there (`kind: "draft"`, a dashed line and a
 * hollow bubble, no number). Ids are the thread's comment id and the draft's uuid: nothing else
 * goes into the page. Page, line and row anchors and comments on the whole Artifact get none (they
 * stay in the list), nor does a resolved thread (#249). Posted threads are marked whether or not comment mode is on (co-design S1).
 *
 * `margin`: a Markdown Artifact's comments are cards in the margin beside it (#proj-workspace:#152),
 * so a posted thread's mark has no count (the passage is highlighted, no marker in the page); the
 * frame adds the refresh mark (`withRefreshMark`).
 */
export function commentMarks(
  comments: readonly ArtifactComment[] | null,
  drafts: readonly ArtifactCommentDraft[] | null,
  path: string | null,
  { parentsMayBeOlder = false, margin = false }: { parentsMayBeOlder?: boolean; margin?: boolean } = {},
): AnnotationMark[] {
  const marks: AnnotationMark[] = [];
  for (const thread of buildThreads(comments ?? [], { parentsMayBeOlder })) {
    // A resolved thread is marked no more (#249): it is in the list's Resolved section alone.
    if (!thread.root || isResolvedThread(thread)) continue;
    const anchor = anchorOf(thread.root);
    const data = anchor?.type === "annotation" ? annotationOn(thread.root.target, path) : null;
    const count = shownCount([thread.root, ...thread.replies]);
    if (data && count > 0) marks.push(margin ? { id: thread.id, anchor: data } : { id: thread.id, anchor: data, count: Math.min(count, 999) });
  }
  for (const draft of drafts ?? []) {
    const data = annotationOn(draft.target, path);
    // In the margin a draft is its dashed card there alone (mockup v8): highlighted, no marker in the page.
    if (data) marks.push(margin ? { id: draft.id, anchor: data } : { id: draft.id, anchor: data, kind: "draft" });
  }
  return marks.slice(0, MAX_MARKS);
}

/**
 * A margin's marks as the frame is given them: from `refresh` 1 with the refresh mark last
 * (artifactMarginPlaces: it makes the frame say where every mark is again), in place of the last
 * comment's when there are as many as a `show` carries.
 */
export function withRefreshMark(marks: readonly AnnotationMark[], refresh: number): readonly AnnotationMark[] {
  return refresh < 1 ? marks : [...marks.slice(0, MAX_MARKS - 1), refreshMark(refresh)];
}
