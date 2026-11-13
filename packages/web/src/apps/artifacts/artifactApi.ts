import type {
  ArtifactCommentDraftId,
  ArtifactCommentImage,
  ArtifactCommentDraftInput,
  ArtifactCommentId,
  ArtifactDashboardAllDir,
  ArtifactDashboardAllSort,
  ArtifactDashboardAuthor,
  ArtifactDashboardHome,
  ArtifactId,
  ArtifactPresence,
  ArtifactReference,
  ArtifactReviewId,
  ArtifactReviewSubmitInput,
  ArtifactReviewSubmitted,
  ArtifactVersionSummary,
  ArtifactViewerData,
  ArtifactWebCommentCreated,
  ArtifactWebCommentInput,
  ArtifactWebCommentsPage,
  ArtifactWebThreadResolution,
  ArtifactWebDashboardAll,
  ArtifactWebDashboardAuthors,
  ArtifactWebDashboardConversations,
  ArtifactWebErrorCode,
  ArtifactWebErrorDetails,
  ArtifactWebFrame,
  ArtifactWebFrameInput,
  ArtifactWebHomeChange,
  ArtifactWebHomeInput,
  ArtifactWebLocation,
  ArtifactWebOpen,
  ArtifactWebMentionCandidates,
  ArtifactWebReviewDrafts,
  ArtifactWebReviewDraftSaved,
  ArtifactWebAttachmentSaves,
  ArtifactWebSaved,
  ArtifactWebSaveInput,
  ArtifactWebShareAudience,
  ArtifactWebShared,
  ArtifactWebShareInput,
  ArtifactWebConversationArtifacts,
  ArtifactWillNotify,
  ChannelId,
  ObjectFileId,
  artifactWebPaths,
} from "@botiverse/raft-shared";

import type { ArtifactLinkTarget } from "./artifactLinks";

/**
 * What the viewer route answers: the data, or one "can't open" state that
 * says nothing about why. The server answers 404 `NOT_VISIBLE` with the same
 * body for no permission, not found and deleted; the source maps it here.
 */
export type ArtifactViewerResult =
  | { status: "ok"; data: ArtifactViewerData }
  | { status: "unavailable" };

/** A smaller home, as the preview route names it. */
export type ArtifactHomeChangeTarget = Parameters<typeof artifactWebPaths.homeChange>[1];

/** One file of one version, by the address parts the client builds itself. */
export interface ArtifactFileTarget {
  id: ArtifactId;
  version: number;
  path: string;
}

/** The API's error body (`{error, code, details}`). */
export interface ArtifactApiError {
  status: number;
  code: string;
  details?: ArtifactWebErrorDetails[keyof ArtifactWebErrorDetails];
}

/** The `details` of an error with `code`, typed by the contract; null for any other error. */
export function artifactErrorDetails<C extends keyof ArtifactWebErrorDetails>(error: unknown, code: C): ArtifactWebErrorDetails[C] | null {
  const e = error as Partial<ArtifactApiError> | null;
  if (!e || e.code !== code || typeof e.details !== "object" || e.details === null) return null;
  return e.details as ArtifactWebErrorDetails[C];
}

export function artifactErrorCode(error: unknown): ArtifactWebErrorCode | null {
  const e = error as Partial<ArtifactApiError> | null;
  return e && typeof e.code === "string" ? (e.code as ArtifactWebErrorCode) : null;
}

/** Who is signed in (`ArtifactViewerData.viewer`), as comment authors are named: their comments are theirs to edit. */
export interface ArtifactViewerActor {
  type: "user" | "agent";
  id: string;
}

export function isNotVisible(error: unknown): boolean {
  const e = error as Partial<ArtifactApiError> | null;
  return !!e && e.status === 404 && e.code === "NOT_VISIBLE";
}

/**
 * Where the web app reads and writes Artifacts. Shaped after the API draft
 * (Remy): the methods map one to one onto routes, and the fake below answers
 * the way they will. Swapping the fake for the API-backed source is the only
 * change the components need.
 *
 * Addresses: the client builds every address from id, version and path
 * (`artifactWebPaths`); no address in a payload is fetched with the
 * user's auth.
 */
export interface ArtifactSource {
  /**
   * What this source is: `api`, Raft's web API (apiArtifactSource), or
   * `stand-in`, a source that answers in Raft's place (the fake, test
   * doubles). Only a stand-in's own `getMessageArtifactRefs` is ever used;
   * an `api` source's message links are always read by core's object
   * summaries loader (`useArtifactLinkSummaries`, artifactSource.ts), even if
   * it had that method: the one path for them on a real server.
   */
  readonly kind: "api" | "stand-in";
  /**
   * A stand-in's answer for the Artifact links of a message, one per link in
   * order (in place of core's object summaries). Read only when `kind` is
   * `stand-in`; one without it answers every link `unavailable`.
   */
  getMessageArtifactRefs?(inText: ArtifactLinkTarget[]): Promise<ArtifactReference[]>;
  /** GET the viewer data; 404 NOT_VISIBLE → unavailable. */
  viewer(target: ArtifactLinkTarget): Promise<ArtifactViewerResult>;
  /**
   * GET `artifactWebPaths.details(id, version)` (the viewer's answer without a ticket, moving no read
   * position) → that version's summary (its note and changed files), or null when the answer doesn't
   * list it. Rejects with the server's refusal. Optional: a source without it says nothing more of a
   * version than its card does (the new version strip shows no note).
   */
  versionSummary?(target: { id: ArtifactId; version: number }): Promise<ArtifactVersionSummary | null>;
  /** GET a text file's content (csv, text) from Raft's file-content endpoint. */
  readText(file: ArtifactFileTarget): Promise<string>;
  /** GET a file's bytes from Raft's file-content endpoint; the Blob's type is the response's Content-Type. */
  readBytes(file: ArtifactFileTarget): Promise<Blob>;
  /**
   * GET `artifactWebPaths.downloadZip(id, version)`: every file of that
   * version in one zip (the server's refusals as ArtifactApiError:
   * DOWNLOAD_TOO_LARGE, BUSY, RATE_LIMITED, …).
   */
  readZip(target: { id: ArtifactId; version: number }): Promise<Blob>;
  /**
   * POST `artifactWebPaths.frame(id)` {version?, path?} → where to load a
   * framed version (html, markdown, pdf) on the content origin, with a
   * one-time ticket (S2); `path`: another page, Markdown file or PDF of the version to open
   * at instead of its entry. Asked on every mount and every reload; never
   * cached. NOT_VISIBLE, VERSION_NOT_FOUND, NOT_FRAMED, INVALID_PATH,
   * FILE_NOT_FOUND, CONTENT_UNAVAILABLE, INVALID_REQUEST, RATE_LIMITED.
   */
  frame(id: ArtifactId, input: ArtifactWebFrameInput): Promise<ArtifactWebFrame>;
  /** PUT / DELETE /api/artifacts/:id/subscription → {following}. */
  setFollowing(id: ArtifactId, following: boolean): Promise<{ following: boolean }>;
  /**
   * POST /api/artifacts/:id/home (ArtifactWebHomeInput) → the new viewer data:
   * a larger home, or a smaller one (`capabilities.narrowHome`; with the
   * confirmed `expectedLost`). NOT_VISIBLE, TARGET_NOT_FOUND, FORBIDDEN,
   * HOME_NOT_WIDER, HOME_NOT_NARROWER, TARGET_NOT_SUPPORTED {reason},
   * TARGET_HAS_GUESTS {reason}, AUTHOR_LOSES_ACCESS {reason}, NAME_TAKEN,
   * INVALID_REQUEST, LOSS_CHANGED {expected, actual, capped}.
   */
  changeHome(id: ArtifactId, input: ArtifactWebHomeInput): Promise<ArtifactViewerData>;
  /**
   * GET /api/artifacts/:id/home-change?to=… → what a move to a smaller home
   * would take away (counts only), with the move's own checks and refusals.
   */
  homeChange(id: ArtifactId, to: ArtifactHomeChangeTarget): Promise<ArtifactWebHomeChange>;
  /**
   * POST /api/artifacts/:id/unpublish → the new viewer data: a public Artifact
   * back to its whole server (while `capabilities.unpublish`). FORBIDDEN,
   * NOT_PUBLIC, NAME_TAKEN, NOT_VISIBLE.
   */
  unpublish(id: ArtifactId): Promise<ArtifactViewerData>;
  /**
   * PATCH /api/artifacts/:id/title {title} → the new viewer data: a new title,
   * no new version (while `capabilities.publish`). FORBIDDEN, NOT_VISIBLE,
   * INVALID_REQUEST (blank), FIELD_TOO_LONG.
   */
  setTitle(id: ArtifactId, title: string): Promise<ArtifactViewerData>;
  /** DELETE /api/artifacts/:id → 204. */
  deleteArtifact(id: ArtifactId): Promise<void>;

  // Comments (S4). Every version's comments, oldest first (E12).
  /**
   * GET /api/artifacts/:id/comments?before=&path=&review= → the newest page, or the one before `before`
   * (a page's `olderCursor`); with `review` (a comment's `reviewId`), only that review's comments,
   * its summary as the page's `review.body` (`review: null`: not a review of this Artifact).
   */
  getComments(id: ArtifactId, options?: { before?: string; path?: string; review?: ArtifactReviewId }): Promise<ArtifactWebCommentsPage>;
  /** POST /api/artifacts/:id/comments; MENTION_NOT_VISIBLE (details.actors), FIELD_TOO_LONG, VERSION_NOT_FOUND, FILE_NOT_FOUND. */
  postComment(id: ArtifactId, input: ArtifactWebCommentInput): Promise<ArtifactWebCommentCreated>;
  /**
   * PATCH /api/artifacts/:id/comments/:commentId {body} → the comment and who
   * heard (only mentions the edit adds, each checked again:
   * MENTION_NOT_VISIBLE); its author only (FORBIDDEN), COMMENT_NOT_FOUND.
   */
  editComment(id: ArtifactId, commentId: ArtifactCommentId, body: ArtifactWebCommentInput["body"]): Promise<ArtifactWebCommentCreated>;
  /** DELETE /api/artifacts/:id/comments/:commentId → 204; its author only. With replies it stays as a placeholder (`deletedAt`). */
  deleteComment(id: ArtifactId, commentId: ArtifactCommentId): Promise<void>;
  /**
   * POST /api/artifacts/:id/comments/:commentId/resolve → the thread's root as it stands now
   * (#249; no note from the web). Its root only (COMMENT_IS_REPLY), by the thread's author, the
   * Artifact's author (or whoever manages an agent author) and the server's owners and admins
   * (FORBIDDEN); already resolved: `changed: false`.
   */
  resolveComment(id: ArtifactId, commentId: ArtifactCommentId): Promise<ArtifactWebThreadResolution>;
  /** POST /api/artifacts/:id/comments/:commentId/reopen → the root, open again; who may as resolving. Already open: `changed: false`. */
  reopenComment(id: ArtifactId, commentId: ArtifactCommentId): Promise<ArtifactWebThreadResolution>;

  // Comment images (#proj-workspace:#146): uploaded first, then named by `images` on a comment or draft.
  /**
   * POST /api/artifacts/:id/comment-images (the image's raw bytes, its own Content-Type) → the image
   * as the Server kept it (201): no comment's yet, read only by the uploader until a comment or
   * draft takes it, gone after an hour if none does. `onProgress` gets 0–100 as the bytes go;
   * `signal` cancels it (the image removed while it uploads): rejected, and nothing kept.
   * IMAGE_REFUSED { reason, limit? }, FILE_UPLOAD_QUOTA_EXCEEDED, RATE_LIMITED, FORBIDDEN.
   */
  uploadCommentImage(id: ArtifactId, image: Blob, options?: { onProgress?: (percent: number) => void; signal?: AbortSignal }): Promise<ArtifactCommentImage>;
  /**
   * GET core's object file route (`objectWebPaths.file("artifact", id, fileId)`, with the session and
   * X-Server-Id) → a comment image's bytes, typed by the answer. One 404 NOT_FOUND for everything
   * else (gone, an upload no comment took within the hour, not the reader's to read).
   */
  readCommentImage(id: ArtifactId, fileId: ObjectFileId): Promise<Blob>;

  // Batch comments (S8): the signed-in person's review drafts, seen by no one else.
  /** GET /api/artifacts/:id/review/drafts → their drafts here, oldest first, expired ones left out. */
  reviewDrafts(id: ArtifactId): Promise<ArtifactWebReviewDrafts>;
  /**
   * POST /api/artifacts/:id/review/drafts → the draft (201), checked as a comment is (FIELD_TOO_LONG,
   * TOO_MANY_MENTIONS, MENTION_NOT_VISIBLE, FILE_NOT_FOUND, VERSION_NOT_FOUND); 409 DRAFT_LIMIT
   * { limit } past ARTIFACT_DRAFT_MAX_PER_ARTIFACT.
   */
  createReviewDraft(id: ArtifactId, input: ArtifactCommentDraftInput): Promise<ArtifactWebReviewDraftSaved>;
  /** PATCH /api/artifacts/:id/review/drafts/:draftId {body} → the draft, its expiry started again; 404 DRAFT_NOT_FOUND. */
  editReviewDraft(id: ArtifactId, draftId: ArtifactCommentDraftId, body: ArtifactCommentDraftInput["body"]): Promise<ArtifactWebReviewDraftSaved>;
  /** DELETE /api/artifacts/:id/review/drafts/:draftId → 204; 404 DRAFT_NOT_FOUND (someone else's, gone or expired). */
  deleteReviewDraft(id: ArtifactId, draftId: ArtifactCommentDraftId): Promise<void>;
  /** DELETE /api/artifacts/:id/review/drafts → 204: every draft of theirs here, at once. */
  discardReviewDrafts(id: ArtifactId): Promise<void>;
  /**
   * POST /api/artifacts/:id/review/submit → `ok` (201, or 200 for a `clientKey` already used: the
   * review it posted) or `rejected` (the server's 422, resolved here: nothing posted, the first draft
   * refused named, null for the summary). Thrown: 409 NO_DRAFTS, DRAFTS_CHANGED (load the drafts and
   * send again), CLIENT_KEY_REUSED; 404 VERSION_NOT_FOUND, NOT_VISIBLE.
   */
  submitReview(id: ArtifactId, input: ArtifactReviewSubmitInput): Promise<ArtifactReviewSubmitted>;

  /** POST /api/mentions/audience (the Artifact as an object audience) → people and agents who can see it. */
  mentionCandidates(id: ArtifactId, q: string): Promise<ArtifactWebMentionCandidates>;
  /** GET /api/artifacts/:id/will-notify?replyTo=&path= → who a comment would notify, without the draft's @mentions. */
  willNotify(id: ArtifactId, options: { replyTo?: ArtifactCommentId; path?: string }): Promise<ArtifactWillNotify>;
  /** GET /api/artifacts/:id/presence (TODO(S4 server): live updates over the socket, `artifact:presence`). */
  presence(id: ArtifactId): Promise<ArtifactPresence>;

  // Save and share (S5).
  /**
   * POST /api/artifacts/save-attachment {attachmentId} → the Artifact (F14a,
   * no dialog); `created: false` when it was saved before. ALREADY_SAVED
   * (saved as one this person can't see), ATTACHMENT_NOT_SAVABLE {reason},
   * ATTACHMENT_NOT_FOUND, FILE_UPLOAD_QUOTA_EXCEEDED (the server's monthly
   * file upload quota, which the copy counts against).
   */
  saveAttachment(input: ArtifactWebSaveInput): Promise<ArtifactWebSaved>;
  /**
   * GET /api/artifacts/attachment-saves?attachmentIds= → what up to
   * ARTIFACT_ATTACHMENT_SAVES_MAX_IDS attachments were saved as (F7): only
   * saved ones the person can see; messages carry nothing about Artifacts.
   */
  attachmentSaves(attachmentIds: readonly string[]): Promise<ArtifactWebAttachmentSaves>;
  /** GET /api/artifacts/:id/share-audience?conversationId= → who there couldn't see it, as counts (F21). */
  shareAudience(id: ArtifactId, options: { conversationId: ArtifactWebShareInput["conversationId"] }): Promise<ArtifactWebShareAudience>;
  /** POST /api/artifacts/:id/share → the message with its link, as the person (F21, F29); TARGET_NOT_FOUND, FIELD_TOO_LONG {field: "note"}, FORBIDDEN (widen). */
  share(id: ArtifactId, input: ArtifactWebShareInput): Promise<ArtifactWebShared>;

  // The Artifacts home page (S7). Reads only: opening the viewer is what moves read positions.
  /**
   * GET /api/artifacts/dashboard/all?home=&author=&conversation=&q=&sort=&dir=&relevant=&cursor= → a page of the home page's list:
   * every Artifact the reader can see in the current server, newest update first unless `sort` (`updated`, `title`,
   * `comments`, `opened`) and `dir` (`asc`, `desc`; absent: ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS) say otherwise; `author`
   * (ArtifactDashboardAuthor, the key once per value, several any of them) keeps the Artifacts by those authors,
   * `conversation` those homed in that conversation (one the reader can't see is an empty list), `q` is the title search, `relevant` keeps what the reader is involved with (made, follows, mentioned on; read or not) and fixes the order (news first), `cursor` a page's `nextCursor`
   * (same `home`, `author`, `conversation`, `q`, `sort`, `dir` and `relevant`: another order's is 400 INVALID_REQUEST). Each row says
   * `openedAt` and `news`; a first page says `counts`, a later one null; an older Server sends none of the three.
   */
  dashboardAll(options?: {
    home?: ArtifactDashboardHome;
    author?: readonly ArtifactDashboardAuthor[];
    conversation?: string;
    q?: string;
    sort?: ArtifactDashboardAllSort;
    dir?: ArtifactDashboardAllDir;
    cursor?: string;
    relevant?: boolean;
  }): Promise<ArtifactWebDashboardAll>;
  /**
   * GET /api/artifacts/dashboard/authors?q= → the `author` filter's candidates: who wrote the Artifacts the reader can
   * see in the current server, with how many, the most first (at most ARTIFACT_DASHBOARD_AUTHORS_LIMIT); `q` keeps
   * those whose handle or display name contains it.
   */
  dashboardAuthors(options?: { q?: string }): Promise<ArtifactWebDashboardAuthors>;
  /**
   * GET /api/artifacts/dashboard/conversations?q= → the `conversation` filter's candidates: the conversations holding
   * Artifacts the reader can see in the current server, most recently updated first (at most
   * ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT); `q` keeps those whose name contains it.
   */
  dashboardConversations(options?: { q?: string }): Promise<ArtifactWebDashboardConversations>;

  /** GET /api/artifacts/conversations/:channelId?cursor= → a page of the conversation's own Artifacts (the Files tab); see ArtifactWebConversationArtifacts. */
  conversationArtifacts(conversationId: ChannelId, options?: { cursor?: string }): Promise<ArtifactWebConversationArtifacts>;

  /**
   * GET /api/artifacts/:id/open?version=, signed in and sent with no server
   * (X-Server-Id none: its canonical link names none) → where it opens and
   * its viewer data (ArtifactWebOpen): `opensIn` the Artifact's own server,
   * for a member who reads it there; null for a public Artifact read as an
   * outsider. The one 404 for everything else, 401 signed out, RATE_LIMITED.
   */
  open(target: ArtifactLinkTarget): Promise<ArtifactWebOpen>;

  /**
   * GET /api/artifacts/:id/locate, asked from `askFrom` (any server the
   * reader is in, its X-Server-Id) → the slug of the reader's server the
   * Artifact is seen from. Only the canonical link's fallback after `open`'s
   * 404 (ArtifactPermalink): `open` asks about the Artifact's own server
   * alone, `locate` also finds one homed in a joint channel that the reader
   * sees through their other server. NOT_VISIBLE (one answer for every
   * reason), ARTIFACTS_NOT_ENABLED, RATE_LIMITED.
   */
  locate(id: ArtifactId, askFrom: { id: string; slug: string }): Promise<ArtifactWebLocation>;
}

/** Maps the server's single "can't open" answer; anything else is a real error. */
export async function viewerResultOf(load: () => Promise<ArtifactViewerData>): Promise<ArtifactViewerResult> {
  try {
    return { status: "ok", data: await load() };
  } catch (error) {
    if (isNotVisible(error)) return { status: "unavailable" };
    throw error;
  }
}

