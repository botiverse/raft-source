// The web app's core routes for first-party objects (first-party app
// mechanism §四): objects any first-party app owns, read through one entry
// for every app. Core resolves the app that registered the kind, decides by
// the objects' homes who sees what (the platform's rule, never the app's),
// and only then asks the app for what it shows of the objects left.
//
// - Answers are per viewer (whether one is visible, its unread state, what
//   the viewer may do with it), so they are never stored by a cache:
//   `Cache-Control: private, no-store`, and never shared across users.
// - An object the viewer can't see is indistinguishable from one that
//   doesn't exist: the same `unavailable` for every reason.
// - Objects are named by references: each kind declares its own, which
//   always carries the object's `id` (core decides visibility on that alone)
//   and may name more, as a version (the rest is the app's).
// - Errors are `{ error, code, details? }`; `error` is a technical label.

import type { Brand } from "./brandedIds";
import type { ArtifactCard, ArtifactCommentId, ArtifactDeletedReference, ArtifactId, ArtifactReviewId } from "./workspaceArtifacts";

/**
 * A file of a first-party object (an image core stored for one of an app's
 * parts, such as a publish check's screenshot of an Artifact's version): a
 * uuid core assigns, read only through `objectWebPaths.file` with the object
 * it belongs to. Mint with {@link asObjectFileId}.
 */
export type ObjectFileId = Brand<string, "ObjectFileId">;
/** Brand an object file id where it is read (core's own row, an app's stored column, a checked request). */
export const asObjectFileId = (id: string): ObjectFileId => id as ObjectFileId;

/**
 * A reference to an Artifact: its id, and the version it pins (`/v/<n>`, an
 * `@vN` link), a whole number from 1; none for the latest.
 */
export interface ArtifactObjectRef {
  id: ArtifactId;
  version?: number;
}

/**
 * Where an Artifact's Activity row opens (activityObjectsContract
 * ObjectInboxItem.target): a version, and a comment on it when the row is
 * about one (open the comments at it). A row whose newest event is a review
 * (S8, eventKind `review`) also names it: its id (a comment's `reviewId`,
 * for `artifactWebPaths.comments(id, { review })`) and how many comments it
 * posted, its summary included.
 */
export interface ArtifactActivityTarget {
  version: number;
  comment?: ArtifactCommentId;
  review?: { id: ArtifactReviewId; comments: number };
}

/**
 * What is new on an Artifact's Activity row, by part (#81: "a new version",
 * "3 new comments", or both), by the rule that numbers `unreadCount`:
 * while following, versions and live comments by others after the reader's
 * read position; otherwise only live comments by others after it that
 * mention them (`versions` 0). Zeros once the row is read. `versions +
 * comments` is the count `unreadCount` shows (which is at least 1 while the
 * row is unread).
 */
export interface ArtifactActivityUnread {
  versions: number;
  comments: number;
}

/**
 * The id, the reference and the summary of each object kind with summaries:
 * the kind (as the app registers it) to its id, to how a request names one
 * of them, and to what `summaries` answers for that reference. A kind's
 * summary is the card its app shows wherever the object is named (message
 * cards, Activity, search results, sync).
 * - `artifact`: ArtifactObjectRef → ArtifactCard, the viewer's
 *   `card` for the same id and pinned version (the web's message cards read
 *   them, as `ok` ArtifactReferences). A pinned card shows that version: its kind, facts,
 *   preview, publisher (`author`) and when it was published (`updatedAt`);
 *   title, description, `latestVersion`, `commentCount` and home are the
 *   Artifact's. One field is the summaries' own: `unseen`, what changed
 *   since the reader last looked (the viewer's card has none: ArtifactCard
 *   `unseen`). Its Activity row opens at an ArtifactActivityTarget. A
 *   deleted one is an ArtifactDeletedReference (`deleted`), only to a reader
 *   who could see it before.
 * Only objects are kinds here; their parts (an Artifact's versions and
 * comments) are not (docs/development/first-party-apps.md, "Objects, parts
 * and files").
 */
export interface ObjectSummaryKinds {
  artifact: { id: ArtifactId; ref: ArtifactObjectRef; summary: ArtifactCard; activityTarget: ArtifactActivityTarget; activityUnread: ArtifactActivityUnread; deleted: ArtifactDeletedReference };
}
export type SummarizedObjectKind = keyof ObjectSummaryKinds;
export type ObjectIdOf<K extends SummarizedObjectKind> = ObjectSummaryKinds[K]["id"];
export type ObjectRefOf<K extends SummarizedObjectKind> = ObjectSummaryKinds[K]["ref"];
export type ObjectSummaryOf<K extends SummarizedObjectKind> = ObjectSummaryKinds[K]["summary"];
/** What a kind shows of a deleted object, to a reader who could see it before it was deleted. */
export type ObjectDeletedOf<K extends SummarizedObjectKind> = ObjectSummaryKinds[K]["deleted"];
/** Where a kind's Activity row opens. */
export type ObjectActivityTargetOf<K extends SummarizedObjectKind> = ObjectSummaryKinds[K]["activityTarget"];
/** Any kind's Activity target. */
export type ObjectActivityTarget = ObjectActivityTargetOf<SummarizedObjectKind>;
/** What is new on a kind's Activity row, by part: counts only. */
export type ObjectActivityUnreadOf<K extends SummarizedObjectKind> = ObjectSummaryKinds[K]["activityUnread"];
/** Any kind's unread parts. */
export type ObjectActivityUnread = ObjectActivityUnreadOf<SummarizedObjectKind>;
/** Any kind's summary. */
export type ObjectSummary = ObjectSummaryOf<SummarizedObjectKind>;

/** At most this many references in one summaries request. */
export const OBJECT_SUMMARIES_MAX_REFS = 50;
/** At most this many characters in one reference's id (`String.length`). */
export const OBJECT_SUMMARIES_MAX_ID_CHARS = 256;

/** Every core object route, as the client builds it. */
export const objectWebPaths = {
  /**
   * POST ObjectSummariesInput → ObjectSummaries: the summaries of up to
   * OBJECT_SUMMARIES_MAX_REFS references to objects of one kind, for the
   * signed-in person in the request's server (X-Server-Id). Reads only: never
   * moves a read position or writes anything. Checks, in order: the body
   * (400 INVALID_REQUEST: `{ kind, refs }` with 1 to OBJECT_SUMMARIES_MAX_REFS
   * objects, each with an `id` string of 1 to OBJECT_SUMMARIES_MAX_ID_CHARS
   * characters, `details: { limit }` when there are too many); the kind (400
   * UNKNOWN_OBJECT_KIND, `details` naming the kinds there are); each
   * reference as its kind declares it (400 INVALID_REQUEST: for `artifact`,
   * nothing but `id` and an optional whole `version` from 1). The app's flag
   * must be on for the reader's server and for each object's own server:
   * otherwise the object is `unavailable` (every one of them when the
   * reader's server has the app off), so a joint channel's object is
   * summarized across servers only while both have the app on. 300 a minute per user, then 429 RATE_LIMITED.
   */
  summaries: () => "/api/objects/summaries",
  /**
   * GET → the bytes of file `fileId` of object `id` of kind `kind`, for the
   * signed-in person in the request's server (X-Server-Id), when they can see
   * the object now (the app's flag on for their server and the object's, and
   * the object's home, as for summaries); a file not yet claimed by one of the
   * app's parts only for the person who uploaded it. Anything else (no such
   * kind, object or file, a file of another object, one the reader can't
   * see) is the same 404 NOT_FOUND. The answer is the type core detected
   * when the file was stored (PNG, JPEG, WebP or GIF), inline, with nosniff,
   * a sandboxing CSP and `private, max-age=60`; 503 STORAGE_UNAVAILABLE
   * without the platform's storage. In the same 300 a minute per user as
   * summaries, then 429 RATE_LIMITED.
   */
  file: (kind: string, id: string, fileId: ObjectFileId) => `/api/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`,
} as const;

export interface ObjectSummariesInput<K extends SummarizedObjectKind = SummarizedObjectKind> {
  kind: K;
  /** In order; repeats allowed (each answered), the same object at several versions too. */
  refs: Array<ObjectRefOf<K>>;
}

/**
 * One requested reference's answer, echoing the reference (as its kind reads
 * it: an Artifact's without `version` when none was given). `unavailable` for
 * every reason: no such object, deleted, its server or the reader's has the
 * app off, the viewer can't see it (its home: another server's object only
 * when public or in a joint channel the viewer is in), or nothing to show at that
 * reference (an Artifact never published; a version that doesn't exist, is
 * revoked, or that the reader may not read because a reader outside a
 * public Artifact's server reads its current version only).
 *
 * `deleted` (additive; older servers never send it): a deleted object, to a
 * reader who could see it before it was deleted, with what its kind shows of
 * it (`ObjectDeletedOf`). Every other reader gets `unavailable`, and so does
 * everyone for an object revoked by moderation. Clients read a `reason` they
 * don't know, or a `deleted` without its fields, as `unavailable`.
 */
export type ObjectSummaryAnswer<K extends SummarizedObjectKind = SummarizedObjectKind> =
  | { ref: ObjectRefOf<K>; ok: true; summary: ObjectSummaryOf<K> }
  | { ref: ObjectRefOf<K>; ok: false; reason: "unavailable" }
  | { ref: ObjectRefOf<K>; ok: false; reason: "deleted"; deleted: ObjectDeletedOf<K> };

/** One answer per requested reference, in the same order. */
export interface ObjectSummaries<K extends SummarizedObjectKind = SummarizedObjectKind> {
  kind: K;
  summaries: Array<ObjectSummaryAnswer<K>>;
}

/** Error codes the core object routes answer with (besides RATE_LIMITED, 429). */
export const OBJECT_WEB_ERROR_CODES = ["INVALID_REQUEST", "UNKNOWN_OBJECT_KIND", "NOT_FOUND", "STORAGE_UNAVAILABLE", "RATE_LIMITED"] as const;
export type ObjectWebErrorCode = (typeof OBJECT_WEB_ERROR_CODES)[number];

/** `details` of the error codes that carry any. */
export interface ObjectWebErrorDetails {
  /** Only when there are more than OBJECT_SUMMARIES_MAX_REFS references. */
  INVALID_REQUEST: { limit: number };
  /** The kind asked for and every kind there is. */
  UNKNOWN_OBJECT_KIND: { kind: string; kinds: string[] };
}
