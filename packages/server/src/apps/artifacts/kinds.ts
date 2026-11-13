// The Artifact as the platform's object kind (first-party app mechanism §三):
// its kind, event kinds and object tables, as register.ts declares them to
// core and events.ts records them. A leaf module (no imports): core's
// registry reads these while loading, through an import cycle.

export const ARTIFACT_OBJECT_KIND = "artifact";
/**
 * Recorded: `version` (publish.ts), `comment` (comments.ts insertComment,
 * from the agent API and the web), `review` (several comments posted at
 * once, one event for all of them: reviews.ts, S8), `comment_edited` and
 * `comment_deleted` (the web, webComments.ts), `moved` (with the home before it) and
 * `deleted` (manage.ts), `renamed` (a push that changes only the title, with
 * `from` and `to`: publish.ts retitle; no one's Activity), `comment_resolved`
 * (for the thread's author, a person) and `comment_reopened` (for no one), a
 * thread's resolution (resolutions.ts, #249).
 */
export const ARTIFACT_OBJECT_EVENTS = ["version", "comment", "comment_edited", "comment_deleted", "renamed", "moved", "deleted", "review", "comment_resolved", "comment_reopened"] as const;
export type ArtifactObjectEvent = (typeof ARTIFACT_OBJECT_EVENTS)[number];
/** The tables whose writes change what others see of an Artifact (§十 check 3). */
export const ARTIFACT_OBJECT_TABLES = ["items", "versions", "comments"] as const;
