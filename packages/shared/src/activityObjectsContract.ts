// Activity rows for first-party objects (first-party app mechanism §四, S6):
// what `GET /api/channels/inbox` adds for an object (an Artifact) that has
// news for the signed-in person, and the core routes that act on such a row.
// For the web (Kirby) and the App (Lagoon).
//
// Behind each app's server flag (Artifacts: workspace_artifacts_v0). With
// every object app off for the server, the inbox and unread-summary answers
// are exactly what they were before: no object rows, none of the fields
// below.
//
// When a person gets a row: an object event lists them as a recipient
// (`object_event_recipients`, recipient type user; agents never get rows):
// for Artifacts, a comment that @mentions them, or a new comment or version
// on an Artifact they follow (after Unfollow only mentions reach them). One
// row per (person, object), at the time of its newest such event. A row shows
// only while the person can see the object now (its home, checked on every
// read), and goes away after Done until a newer event. Events are kept 90
// days; a row whose newest event is older goes with it.
//
// A row is unread while its newest event is past both its Done and how far
// the person has read the object (opening it, mark read, Done and mark all
// read move that).
//
// Counts are separate from the existing ones on purpose: older App versions
// drop rows of an unknown kind but badge `totalUnreadCount` and
// `activityUnreadCount` directly, so object unread is never added into them.
// A client that shows object rows adds `objectUnreadCount` (inbox) or
// `activityObjectUnreadCount` (unread-summary) itself. The two always agree:
// both are the number of unread object rows (`unreadCount > 0`) the person
// has in that server, one per object however much is new on it.

import type { ObjectActivityTargetOf, ObjectActivityUnreadOf, ObjectIdOf, ObjectSummaryOf, SummarizedObjectKind } from "./webObjectsContract";

/** Why the newest event reached the person: it mentions them, they follow the object, or they made it and follow it. */
export type ObjectInboxReason = "mentioned" | "following" | "owner";

/**
 * Where the object lives, as the row labels it.
 * - `channel` (a channel, private channel or joint channel): `label` is the
 *   channel's name, shown as `#name`.
 * - `dm`: `label` is the DM as the person sees it (the peer's handle), as DM
 *   rows are labelled; `peerDisplayName` the peer's display name, as the
 *   sidebar shows the DM (absent when it has none). Show
 *   `peerDisplayName || label`.
 * - `server`, `public`: `label` is null.
 * - `orphan`: its conversation was deleted; `label` is null.
 */
export interface ObjectInboxHome {
  kind: "channel" | "dm" | "server" | "public" | "orphan";
  label: string | null;
  /** The conversation for `channel` and `dm`, else null. */
  channelId: string | null;
  /** `dm` only: the peer's display name, as the sidebar labels the DM (absent when it has none, and for other kinds). */
  peerDisplayName?: string;
}

/** A person or an agent, named by its handle (null when it no longer exists). */
export interface ObjectInboxActor {
  type: "user" | "agent";
  id: string;
  name: string | null;
}

/**
 * The newest event that reached the person (the row's time). Clients build
 * the row's verb from (`eventKind`, `reason`), with what `target` names (for
 * an Artifact: "mentioned you" for a `mentioned` comment, "commented",
 * "published v{target.version}").
 */
export interface ObjectInboxEvent {
  /** The app's event kind (Artifacts: `comment`, `comment_edited`, `version`). */
  eventKind: string;
  reason: ObjectInboxReason;
  actor: ObjectInboxActor;
  at: string;
}

/**
 * One line of text for the row (Artifacts: the newest unread comment by
 * someone else, any while following, else only one that mentions them;
 * otherwise, read or not, the comment of the row's newest event (a comment,
 * a review, an edit) while it is live and by someone else, #80). Null when
 * there is no such text (a new version, a deleted comment).
 */
export interface ObjectInboxPreview {
  text: string;
  truncated: boolean;
  author: ObjectInboxActor;
  at: string;
  /**
   * How many images the comment carries (Artifacts, #146); absent when none,
   * and from Servers before images. `text` may then be empty.
   */
  images?: number;
}

/**
 * One Activity row for an object. `kind: "object"` sits beside the existing
 * channel, dm, thread and task rows in `items`, ordered with them by
 * `lastActivityAt` (and paged by the same offset).
 */
export interface ObjectInboxItem<K extends SummarizedObjectKind = SummarizedObjectKind> {
  kind: "object";
  /** The registered object kind; the client picks the app's row by it. */
  objectKind: K;
  objectId: ObjectIdOf<K>;
  /** The kind's summary (Artifacts: ArtifactCard: title, kind for the icon, url), or null when there is nothing to show at the moment. */
  summary: ObjectSummaryOf<K> | null;
  home: ObjectInboxHome;
  latestEvent: ObjectInboxEvent;
  preview: ObjectInboxPreview | null;
  /**
   * Where opening the row lands, as the kind declares it
   * (ObjectSummaryKinds `activityTarget`; Artifacts: `{ version, comment? }`,
   * the newest unread comment when there is one, else the newest event's
   * comment or version). Null when the app names none (open the object).
   */
  target: ObjectActivityTargetOf<K> | null;
  /**
   * 0 when read; otherwise how much is new to the person since they last
   * read it, at least 1 (Artifacts: versions and live comments by others
   * while following, else comments that mention them).
   */
  unreadCount: number;
  /**
   * `unreadCount` by part, as the kind declares it (ObjectSummaryKinds
   * `activityUnread`; Artifacts: `{ versions, comments }`, #81), all zero once
   * read. Absent for a kind that doesn't split it, and from a server before it.
   */
  unreadParts?: ObjectActivityUnreadOf<K>;
  /** A mention of the person is unread (the newest event that mentioned them is past what they read and Done). */
  hasMention: boolean;
  /** Whether the person follows the object now (Unfollow is the app's own route: Artifacts `DELETE /api/artifacts/:id/subscription`). */
  isFollowing: boolean;
  /** = latestEvent.at; the sort key. */
  lastActivityAt: string;
  /** Send this as `throughSeq` with Done (a decimal string). */
  doneFrontierSeq: string;
}

/**
 * What `GET /api/channels/inbox` adds while an object app is on for the
 * server (absent otherwise): `items` may hold ObjectInboxItems; the existing
 * `totalCount`, `totalUnreadCount` and `activeUnreadCount` count no object
 * rows.
 * - `objectUnreadCount`: how many of the person's object rows in this server
 *   are unread (all pages, whatever `filter`); the badge's number.
 * - `objectMentionUnreadCount`: how many of the object rows `filter`
 *   mentions lists are unread (all pages, whatever `filter`): the object
 *   rows' share of the unread count under Mentions, as `totalUnreadCount`
 *   counts the conversation rows that filter lists. It counts a row the
 *   Mentions filter lists while anything on it is unread, the mention itself
 *   read or not (as a conversation row there counts its unread messages), so
 *   it can be more than the rows with `hasMention`. At most
 *   `objectUnreadCount`.
 * - `objectCount`: how many object rows match this request's `filter` (all
 *   pages).
 * Object rows are listed for `filter` all, unread (unreadCount > 0),
 * mentions (a mention since the last Done, read or not) and unread_mentions
 * (hasMention), and not with `q`, `channelId` or a `scope` (the counts are
 * still there, `objectCount` 0). Each filter's unread object rows:
 * all `objectUnreadCount`, mentions `objectMentionUnreadCount`, unread and
 * unread_mentions `objectCount` (every row they list is unread).
 */
export interface ObjectInboxFields {
  objectUnreadCount: number;
  objectMentionUnreadCount: number;
  objectCount: number;
}

/**
 * What `GET /api/servers/unread-summary` adds to a server's entry while an
 * object app is on for it (absent otherwise, and absent when unknown): the
 * same number as that server's inbox `objectUnreadCount`. The phone push
 * badge does not include it yet.
 */
export interface ObjectUnreadSummaryFields {
  activityObjectUnreadCount?: number;
}

/** The socket event that tells a person their Activity changed; the client refetches it. */
export const ACTIVITY_CHANGED_EVENT = "activity:changed" as const;

/**
 * Sent to the person's own room (`user:<id>`) after a change commits: an
 * object event that lists them as a recipient, or their own Done, undo or
 * read of an object row (for their other tabs and devices). Carries no
 * content: refetch the inbox of `serverId` (and the unread summary).
 */
export interface ActivityChangedEvent {
  serverId: string;
  /** What changed: `object` for object rows. */
  source: "object";
}

/** The core routes that act on an object row, for the signed-in person in the request's server (X-Server-Id). */
export const objectActivityWebPaths = {
  /**
   * POST ObjectActivityDoneInput → ObjectActivityAck: Done. The row goes away
   * until an event newer than `throughSeq`; what it showed is marked read up
   * to that event. `throughSeq` omitted: the newest event. Refusals: 400
   * INVALID_REQUEST, 400 UNKNOWN_OBJECT_KIND, 403 APP_NOT_ENABLED, 404
   * NOT_FOUND (no row, or the person can't see the object), 409
   * DONE_FRONTIER_BEYOND_LATEST (`throughSeq` past the row's newest event).
   */
  done: () => "/api/objects/activity/done",
  /** POST ObjectActivityInput → ObjectActivityAck: undo Done; the row shows again (its events still kept). Same refusals, without 409. */
  undone: () => "/api/objects/activity/undone",
  /**
   * POST ObjectActivityReadInput → ObjectActivityAck: mark the object read
   * through `throughSeq` (the row's `doneFrontierSeq` when the person saw
   * it: a later event stays unread), or omitted, everything now (Artifacts:
   * as opening its current version). Same refusals as Done, 409 included.
   */
  read: () => "/api/objects/activity/read",
} as const;

export interface ObjectActivityInput<K extends SummarizedObjectKind = SummarizedObjectKind> {
  kind: K;
  objectId: ObjectIdOf<K>;
}

export interface ObjectActivityDoneInput<K extends SummarizedObjectKind = SummarizedObjectKind> extends ObjectActivityInput<K> {
  /** The row's `doneFrontierSeq`. */
  throughSeq?: string;
}

/** Read takes the same optional frontier as Done. */
export type ObjectActivityReadInput<K extends SummarizedObjectKind = SummarizedObjectKind> = ObjectActivityDoneInput<K>;

export interface ObjectActivityAck {
  ok: true;
}

/** Error codes of the object activity routes (besides RATE_LIMITED). */
export const OBJECT_ACTIVITY_ERROR_CODES = ["INVALID_REQUEST", "UNKNOWN_OBJECT_KIND", "APP_NOT_ENABLED", "NOT_FOUND", "DONE_FRONTIER_BEYOND_LATEST"] as const;
export type ObjectActivityErrorCode = (typeof OBJECT_ACTIVITY_ERROR_CODES)[number];
