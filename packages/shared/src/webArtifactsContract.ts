// The web app's routes for workspace Artifacts (feat/workspace-artifacts, S3
// and S4): paths, request and response shapes. The payloads are the types in
// workspaceArtifacts.ts; this file says which route returns which.
//
// Same rules as the agent API (agentApiArtifactsContract.ts):
// - Behind the per-server flag workspace_artifacts_v0: off → 403
//   ARTIFACTS_NOT_ENABLED.
// - An Artifact the viewer can't see is indistinguishable from one that
//   doesn't exist: 404 NOT_VISIBLE with the same body for every reason. The
//   client shows one "can't open" state.
// - Errors are the Server's refusal envelope (refusal.ts,
//   docs/contracts/agent-api-refusals.md): `{ error, code, errorCode,
//   details?, … }`; `error` is one sentence a person can act on, the client
//   branches on `code` (and the listed codes' `details`).
// - A path is one percent-encoded segment (`assets%2Flogo.png`) following
//   isWellFormedArtifactFilePath.
// - The client builds every address itself from an id, a version and a path;
//   it never fetches an address a payload gives it with the viewer's
//   credentials (Tenny, #proj-workspace:ee8634e1 d6bfc5a7).

import type { AgentApiArtifactSearchMatch } from "./agentApiArtifactsContract";
import type { Brand, ChannelId, MessageId, ServerId } from "./brandedIds";
import type { ObjectFileId } from "./webObjectsContract";
import type {
  ArtifactActor,
  ArtifactCard,
  ArtifactComment,
  ArtifactCommentAnchor,
  ArtifactCommentDraft,
  ArtifactCommentDraftId,
  ArtifactCommentId,
  ArtifactCommentImage,
  ArtifactCommentPart,
  ArtifactHome,
  ArtifactId,
  ArtifactPresence,
  ArtifactReference,
  ArtifactReviewId,
  ArtifactViewerData,
  ArtifactWebConversationArtifacts,
  ArtifactWillNotify,
} from "./workspaceArtifacts";

const enc = encodeURIComponent;

/**
 * A publish check's screenshots of a version (task #130): desktop width and
 * phone width. Each is a core object file of the Artifact
 * (webObjectsContract `objectWebPaths.file`, kind `artifact`).
 */
export const ARTIFACT_CHECK_SHOTS = ["desktop", "phone"] as const;
export type ArtifactCheckShot = (typeof ARTIFACT_CHECK_SHOTS)[number];
/**
 * `?a=1&b=2` from the given values, leaving out undefined and null; a list
 * is its key once per value (`?author=me&author=my-agents`), none when
 * empty; "" when none.
 */
function query(params: Record<string, string | number | readonly string[] | null | undefined>): string {
  const pairs = Object.entries(params).flatMap(([key, value]): Array<[string, string]> => {
    if (value === undefined || value === null) return [];
    if (typeof value === "string" || typeof value === "number") return [[key, String(value)]];
    return value.map((item) => [key, item]);
  });
  return pairs.length === 0 ? "" : `?${pairs.map(([key, value]) => `${enc(key)}=${enc(value)}`).join("&")}`;
}
const versionQuery = (version?: number) => query({ version });

/** Every web route for Artifacts, as the client builds it. */
export const artifactWebPaths = {
  /**
   * GET → ArtifactViewerData (the current version, or `version`), with the
   * shown version's `frame` for a framed kind (S2; the frame route's answer,
   * good once, within 60 s: see ArtifactViewerData.frame). In the frame
   * route's budget: 120 a minute per user for both, then 429 RATE_LIMITED.
   */
  viewer: (id: ArtifactId, version?: number) => `/api/artifacts/${enc(id)}${versionQuery(version)}`,
  /**
   * GET → ArtifactViewerData without `frame`, for a caller that draws no
   * frame (the App's own bar: its counts, versions and following). Signs no
   * ticket and moves no read position (opening the viewer does), so it is
   * outside the frame route's budget. `?version=` and the refusals as the
   * viewer's.
   */
  details: (id: ArtifactId, version?: number) => `/api/artifacts/${enc(id)}/details${versionQuery(version)}`,
  /** GET → the file's exact bytes, as an attachment (draw only text, csv and ARTIFACT_INLINE_IMAGE_TYPES in the shell). */
  file: (id: ArtifactId, path: string, version?: number) => `/api/artifacts/${enc(id)}/files/${enc(path)}${versionQuery(version)}`,
  /**
   * GET → every file of the version (the current one, or `version`) in one
   * zip: stored (no compression), paths as published, `application/zip`,
   * an attachment named by the title and the version (`Title v3.zip`),
   * with its Content-Length. Read as a file is (the flag, the one 404, 400
   * INVALID_REQUEST and 404 VERSION_NOT_FOUND for `version`); over 100 MiB
   * of files 413 DOWNLOAD_TOO_LARGE { limit }; a file not in storage 503
   * CONTENT_UNAVAILABLE; a few being built at once per server process
   * (ARTIFACTS_WEB_ZIP_CONCURRENCY, default 4), past that 429 BUSY with
   * Retry-After. A read: outside the writes' budget, in its own, 20 a minute
   * per user, then 429 RATE_LIMITED. Moves no read position.
   */
  downloadZip: (id: ArtifactId, version?: number) => `/api/artifacts/${enc(id)}/download.zip${versionQuery(version)}`,
  /** GET → ArtifactWebFileContent. */
  fileContent: (id: ArtifactId, path: string, version?: number) => `/api/artifacts/${enc(id)}/files/${enc(path)}/content${versionQuery(version)}`,
  /**
   * GET → ArtifactWebCommentsPage: the newest page first, one file's with
   * `path`, one review's (S8) with `review` (a comment's `reviewId`: its
   * comments without its summary, which is the page's `review.body`, as on
   * the agent API); `before` (a page's `olderCursor`) loads the page before
   * it.
   * POST (no options) ArtifactWebCommentInput → ArtifactWebCommentCreated:
   * text, or at least one image (`images`, uploaded first with
   * `commentImages`), else 400 INVALID_REQUEST; an image id that isn't the
   * reader's own upload to this Artifact, or one another comment or draft
   * already has: 400 IMAGE_NOT_FOUND, nothing posted.
   * Writes (this POST, `comment` PATCH and DELETE, `subscription` PUT and
   * DELETE) share 60 a minute per user; past it 429 RATE_LIMITED.
   */
  comments: (id: ArtifactId, options: { before?: string; path?: string; review?: ArtifactReviewId } = {}) => `/api/artifacts/${enc(id)}/comments${query(options)}`,
  /**
   * PATCH `{ body }` → ArtifactWebCommentCreated (only mentions added by the
   * edit are notified, and each is checked again: MENTION_NOT_VISIBLE); the
   * text only, its images stay (a comment with images may have no text).
   * DELETE → 204. Its author only. A deleted comment with replies stays as a
   * placeholder (`deletedAt` set, empty body, no images) so the replies keep
   * their place; one without replies is gone. A deleted comment's images go
   * with it.
   */
  comment: (id: ArtifactId, commentId: ArtifactCommentId) => `/api/artifacts/${enc(id)}/comments/${enc(commentId)}`,
  /**
   * POST ArtifactWebResolveInput → ArtifactWebThreadResolution (#249):
   * resolve a thread, by its root comment. Who may: the thread's author, the
   * Artifact's author (or the person who manages an agent author), and the
   * server's owners and admins (else 403
   * FORBIDDEN); a reply: 409 COMMENT_IS_REPLY { thread } (its root's id).
   * A `note` is posted first as the resolver's reply in the thread (checked
   * and told as a reply is). The thread's author, when someone else, is told
   * (their Activity). Already resolved: `changed: false`, nothing written
   * (no note). In the writes' budget.
   */
  commentResolve: (id: ArtifactId, commentId: ArtifactCommentId) => `/api/artifacts/${enc(id)}/comments/${enc(commentId)}/resolve`,
  /**
   * POST (no body) → ArtifactWebThreadResolution with `note: null`: reopen a
   * resolved thread; who may, as resolving. Tells no one. Already open:
   * `changed: false`. A reply posted in a resolved thread reopens it too.
   */
  commentReopen: (id: ArtifactId, commentId: ArtifactCommentId) => `/api/artifacts/${enc(id)}/comments/${enc(commentId)}/reopen`,
  /**
   * GET → ArtifactWillNotify, for the line beside the comment box: who would
   * hear about a comment here (`path`) or a reply (`replyTo`) as things stand.
   * People @-mentioned in the draft aren't in it: the client adds them with
   * reason "mentioned" as they are typed, without another request.
   */
  willNotify: (id: ArtifactId, options: { replyTo?: ArtifactCommentId; path?: string } = {}) => `/api/artifacts/${enc(id)}/will-notify${query(options)}`,
  /**
   * GET → ArtifactWebMentionCandidates: people and agents who can see this
   * Artifact, matching `q` (at most 20). Asked as the name is typed: 300 a
   * minute per user, then 429 RATE_LIMITED.
   */
  mentionCandidates: (id: ArtifactId, options: { q?: string } = {}) => `/api/artifacts/${enc(id)}/mention-candidates${query(options)}`,
  /**
   * POST the raw bytes of one image (its own Content-Type, Content-Length at
   * most ARTIFACT_COMMENT_IMAGE_MAX_BYTES) → ArtifactCommentImage (201): an
   * image for a comment or review draft not posted yet, read only by the
   * reader until a comment (`images`) or draft takes it, and gone after an
   * hour if none does. The Server decides the type from the bytes (PNG,
   * JPEG, WebP or GIF; never SVG), reads the pixel size from the header and
   * removes metadata (JPEG and WebP are encoded again, PNG keeps only what
   * drawing needs, GIF as it is) before keeping it. 422 IMAGE_REFUSED
   * `{ reason }` (`empty`, `unsupported_type`, `too_many_pixels` with
   * `limit`), 413 IMAGE_REFUSED (`too_large` with `limit`,
   * `server_quota_exceeded`, `uploader_quota_exceeded` with `scope`), 403
   * FILE_UPLOAD_QUOTA_EXCEEDED (the bytes count against the monthly file
   * upload quota of the server the request stands in, the uploader's own,
   * as attachments' do), 503 ARTIFACTS_STORAGE_UNAVAILABLE. Outside the Artifact's server
   * 403 FORBIDDEN. 30 a minute per user, then 429 RATE_LIMITED.
   */
  commentImages: (id: ArtifactId) => `/api/artifacts/${enc(id)}/comment-images`,
  /** GET → ArtifactPresence. Live updates come over the socket (event `artifact:presence`). */
  presence: (id: ArtifactId) => `/api/artifacts/${enc(id)}/presence`,
  /** PUT → `{ following: true }`; DELETE → `{ following: false }`. */
  subscription: (id: ArtifactId) => `/api/artifacts/${enc(id)}/subscription`,
  /**
   * Batch comments (S8): the reader's own review drafts on this Artifact,
   * seen by no one else, oldest first, expired ones left out. GET →
   * ArtifactWebReviewDrafts. POST ArtifactCommentDraftInput →
   * ArtifactWebReviewDraftSaved (201), checked as a comment is (its codes:
   * INVALID_REQUEST, FIELD_TOO_LONG, INVALID_PATH, VERSION_NOT_FOUND,
   * FILE_NOT_FOUND, TOO_MANY_MENTIONS, MENTION_NOT_VISIBLE; a reply's
   * `replyTo` not a live comment of this Artifact 404 COMMENT_NOT_FOUND, a
   * reply with a file target 400 INVALID_REQUEST; an image that isn't the
   * reader's unused upload to this Artifact 400 IMAGE_NOT_FOUND, no draft
   * saved; a draft's images are read by the reader alone until the review
   * posts them); at most
   * ARTIFACT_DRAFT_MAX_PER_ARTIFACT per person and Artifact, 409 DRAFT_LIMIT
   * { limit }. DELETE → 204: discard them all, at once. Outside the
   * Artifact's server 403 FORBIDDEN. The writes share the 60 a minute.
   */
  reviewDrafts: (id: ArtifactId) => `/api/artifacts/${enc(id)}/review/drafts`,
  /**
   * PATCH `{ body }` → ArtifactWebReviewDraftSaved (its text and mentions,
   * checked again, a reply's comment too: gone, 404 COMMENT_NOT_FOUND; its
   * expiry starts again); DELETE → 204. Someone else's
   * draft, or one that doesn't exist or expired: 404 DRAFT_NOT_FOUND, one
   * body for all.
   */
  reviewDraft: (id: ArtifactId, draftId: ArtifactCommentDraftId) => `/api/artifacts/${enc(id)}/review/drafts/${enc(draftId)}`,
  /**
   * POST ArtifactReviewSubmitInput → ArtifactReviewSubmitted: every draft at
   * once, then the summary, in one transaction (the same rules as an
   * agent's review, `POST /internal/agent-api/artifacts/:artifact/reviews`).
   * Each draft, then the summary, is checked again as a comment would be
   * now; the first refused refuses the review, nothing posted: 422
   * `rejected` (ArtifactReviewRejected: its `draftId`, null for the summary,
   * and the comment's own code and details; a reply draft whose comment was
   * deleted since, COMMENT_NOT_FOUND). Reply drafts are posted as replies to
   * their comment, at its place, told as a single reply is. 201 `ok` (200 for a
   * `clientKey` already used). No drafts 409 NO_DRAFTS; a version that
   * isn't readable 404 VERSION_NOT_FOUND; the reader can't see the Artifact
   * any more, the one 404; drafts changed while it was checked 409
   * DRAFTS_CHANGED (send it again); the key used for another review 409
   * CLIENT_KEY_REUSED. Each agent told hears once per review; each person's
   * Activity gets one event. A write.
   */
  reviewSubmit: (id: ArtifactId) => `/api/artifacts/${enc(id)}/review/submit`,
  /**
   * POST ArtifactWebHomeInput → ArtifactViewerData (the current version, as
   * the mover now sees it; no read position moves). To a larger home
   * (conversation → server → public) or a smaller one (public → server,
   * server or public → a conversation; `capabilities.narrowHome`): only a
   * request with `expectedLost` (the count confirmed from `homeChange`)
   * narrows; without it a move only widens (Kirby, #45): `to: "server"` on a
   * public Artifact (a stale choice) and `to: "conversation"` are 409
   * HOME_NOT_WIDER { home, to } and change nothing.
   * May: the author, the manager of an agent author, the owners and admins
   * of the Artifact's own server, none of them a guest, each of them seeing
   * it now (else the one 404 NOT_VISIBLE); anyone else 403 FORBIDDEN (a
   * smaller home too). Widening: the same home 409 HOME_NOT_WIDER. Narrowing
   * (preview it first with `homeChange`): a conversation to a conversation
   * 409 HOME_NOT_NARROWER; a conversation only the Artifact's original one
   * (#75: `originalHome`), any other 409 NOT_ORIGINAL_HOME
   * { originalConversationId } (null unless the mover may be told of it:
   * the rule of `originalHome`); the target must be a top-level conversation of
   * the Artifact's server the mover can see (else 404 TARGET_NOT_FOUND), not
   * a thread nor a joint channel (400 TARGET_NOT_SUPPORTED), with no guest
   * in it nor open to guests (403 TARGET_HAS_GUESTS); its author must still
   * see it there and an agent author be in the conversation (409
   * AUTHOR_LOSES_ACCESS; `expectedLost` given and no longer the count: 409
   * LOSS_CHANGED). Either way the name taken in the new home 409
   * NAME_TAKEN; a body other than ArtifactWebHomeInput 400 INVALID_REQUEST.
   * Audited (`home_changed`, `made_public`, or `narrowed` with how many lost
   * it). Narrowing takes it out of the Activity of the people who can't see
   * it there, in the same transaction; their links and cards then read as
   * no access (404 NOT_VISIBLE, `unavailable`).
   */
  home: (id: ArtifactId) => `/api/artifacts/${enc(id)}/home`,
  /**
   * GET → ArtifactWebHomeChange: before confirming a move to a smaller home
   * (`to` "server", or "conversation" with `conversationId`: the original
   * one, `originalHome`, else 409 NOT_ORIGINAL_HOME), how many of
   * the Artifact's server's people and agents who see it now wouldn't
   * there, counts only. The same checks as `home`'s narrowing, with the
   * same refusals (so the dialog can say why before confirming); `to` that
   * isn't smaller 409 HOME_NOT_NARROWER; a malformed query 400
   * INVALID_REQUEST. Reads only. 300 a minute per user, then 429 RATE_LIMITED.
   */
  homeChange: (id: ArtifactId, options: { to: "server" } | { to: "conversation"; conversationId: ChannelId }) => `/api/artifacts/${enc(id)}/home-change${query(options)}`,
  /**
   * POST (body not read) → ArtifactViewerData: move a public Artifact back
   * to the whole server (the menu's "Make private", while
   * `capabilities.unpublish`). May: the same people as `home` (none of them
   * a guest), each of them seeing it now (else the one 404 NOT_VISIBLE);
   * anyone else 403 FORBIDDEN. A home other than public 409 NOT_PUBLIC; the
   * name taken in the server 409 NAME_TAKEN. Signed-out visitors lose it at
   * once; a frame already open on the content origin within the content
   * Worker's authorize cache (30 s). Audited (`made_private`). Shares the
   * writes' 60 a minute.
   */
  unpublish: (id: ArtifactId) => `/api/artifacts/${enc(id)}/unpublish`,
  /**
   * PATCH ArtifactWebTitleInput → ArtifactViewerData (the current version;
   * no read position moves): give the Artifact a new title, without a new
   * version, as an agent's push with only a title does. The title is a
   * property of the Artifact: stored trimmed and on one line, then the
   * search index and the `renamed` object event (`{ from, to }`, no one's
   * Activity); agents that follow it (not the one renaming) are told who
   * renamed it, from what to what. May: whoever may publish a new version
   * (`capabilities.publish`: a member of the Artifact's own server who sees
   * it now; else the one 404 NOT_VISIBLE, or 403 FORBIDDEN from another
   * server). A blank title or a body other than ArtifactWebTitleInput 400
   * INVALID_REQUEST; more than AGENT_API_ARTIFACT_MAX_TITLE_CHARS 400
   * FIELD_TOO_LONG { field: "title", limit }. The same title (once trimmed)
   * writes nothing. Shares the writes' 60 a minute.
   */
  title: (id: ArtifactId) => `/api/artifacts/${enc(id)}/title`,
  /**
   * DELETE → 204. The same people as `home` may, a guest author too,
   * without having to see it (an admin deletes what they can't see); one who may not gets 403
   * FORBIDDEN if they see it, else the one 404. Afterwards the Artifact is
   * NOT_VISIBLE everywhere. Audited.
   */
  artifact: (id: ArtifactId) => `/api/artifacts/${enc(id)}`,
  /**
   * POST ArtifactWebTakedownInput → ArtifactWebTakedown: take the Artifact
   * down (moderation, not a delete: docs/operations/artifact-takedown.md).
   * Only the owners and admins of the Artifact's own server may, without
   * having to see it; anyone else 403 FORBIDDEN if they see it, else the
   * one 404. Afterwards it is NOT_VISIBLE everywhere, its author included,
   * as a deleted one (the content Worker within its 30 s authorize cache).
   * Already down: 200 `changed: false`, nothing written. Audited
   * (`taken_down`, with the reason). A body other than
   * ArtifactWebTakedownInput 400 INVALID_REQUEST. Shares the writes' 60 a minute.
   */
  takedown: (id: ArtifactId) => `/api/artifacts/${enc(id)}/takedown`,
  /**
   * POST ArtifactWebTakedownInput → ArtifactWebTakedown: undo a takedown
   * (the same people, the same refusals; a taken-down Artifact is seen by
   * no one, so anyone else gets the one 404). Not down: 200 `changed:
   * false`. Another live Artifact of its home took its name meanwhile: 409
   * NAME_TAKEN. Audited (`restored`, with the reason).
   */
  restore: (id: ArtifactId) => `/api/artifacts/${enc(id)}/restore`,
  /**
   * POST ArtifactWebSaveInput → ArtifactWebSaved (S5, F14a): save an
   * attachment as an Artifact, no dialog: 201 when it makes one, 200 for one
   * already saved. Title = the file name (no name: Artifacts have none), home = the top-level conversation
   * the attachment's message is in (a thread's: its channel); the bytes are
   * copied into Artifacts' own storage (never referenced). An attachment the
   * saver can't see, that doesn't exist, or whose message is behind the
   * plan's history window (a Free server's 30 days, as the attachment routes
   * answer it): 404 ATTACHMENT_NOT_FOUND. Anyone who can see the message may
   * save it, a read-only member too (as an agent may publish). The saver owns
   * the new Artifact: it stays when the message or attachment is deleted.
   * Saving one already saved returns the existing Artifact (`created: false`)
   * only if the saver can see it now (it may have moved to a home the saver
   * isn't in, e.g. a guest and a server home); otherwise 409 ALREADY_SAVED
   * with no id or title (that it was saved is fine to say: the saver sees
   * the attachment). Tenny, #proj-workspace:ee8634e1 ece4f914. One saved
   * as an Artifact deleted or revoked since is no longer saved: saving it
   * again makes a new one. The copied bytes count against the server's
   * monthly file upload quota (the attachments' one; bytes the server's
   * Artifacts already have cost nothing): no room is 403
   * FILE_UPLOAD_QUOTA_EXCEEDED, nothing saved. A write: 60 a minute per user, shared with the
   * other writes.
   */
  saveAttachment: () => "/api/artifacts/save-attachment",
  /**
   * POST ArtifactWebImportInput → ArtifactWebImported: import one Artifact of
   * the standalone app (raft-artifacts.com) as a new Artifact homed in the
   * whole server (as it was there), or in `conversationId` when given (a
   * channel or DM of the reader's server the reader can see, with no guest
   * in it and not open to guests, else 403 TARGET_HAS_GUESTS; a thread means
   * its conversation; not a joint channel). Only the server slug and the
   * name are read from `from`; the slug must be the reader's server's (one
   * another server has now is 403 LEGACY_OTHER_SERVER), and the reader a
   * member, not a guest (403 FORBIDDEN). Past its deadline (5 minutes) 503
   * IMPORT_UNAVAILABLE `timeout`; a failed import deletes the bytes it copied.
   * The Server asks the standalone app at its configured address, never at
   * the link. 201 `created`; 200 the Artifact an earlier import made, when it
   * still exists and the reader sees it (else 409 ALREADY_IMPORTED). Shares
   * the writes' 60 a minute. At most two imports (people's and agents'
   * together) run at once in a server: a third is 429 RATE_LIMITED with
   * Retry-After, nothing imported.
   */
  import: () => "/api/artifacts/import",
  /**
   * GET → ArtifactWebAttachmentSaves: what the attachments on screen were
   * saved as (S5, F7), at most ARTIFACT_ATTACHMENT_SAVES_MAX_IDS ids (more,
   * none, or a malformed list: 400 INVALID_REQUEST). Messages carry nothing
   * about Artifacts (xxchan 2026-10-26), so the "Saved as Artifact" lines
   * come from here. 300 a minute per user, then 429 RATE_LIMITED.
   */
  attachmentSaves: (attachmentIds: readonly string[]) => `/api/artifacts/attachment-saves${query({ attachmentIds: attachmentIds.join(",") })}`,
  /**
   * GET → ArtifactWebShareAudience: who in `conversationId` (a channel or DM;
   * a thread has its channel's audience) couldn't see this
   * Artifact, as counts only (F21; Tenny: "who can't see" is itself
   * information), before sending it there, the larger homes the reader
   * may move it to so they could (`widenTo`), and those that would help
   * but that the reader can't move it to, with why (`widenRefused`, #77). A
   * conversation the reader can't see, or that doesn't exist: 404
   * TARGET_NOT_FOUND.
   */
  shareAudience: (id: ArtifactId, options: { conversationId: ChannelId }) => `/api/artifacts/${enc(id)}/share-audience${query(options)}`,
  /**
   * POST ArtifactWebShareInput → ArtifactWebShared (F21, F29): the sender
   * posts an ordinary message, as themselves, into the conversation (or the
   * thread): the note, a blank line, then the Artifact's address
   * on the deployment's origin (`https://app.raft.build/artifacts/<id>` in
   * production, the staging origin on staging), which the web draws as the
   * card. Nothing on the message says it came from here (xxchan 2026-10-26:
   * messages carry nothing about Artifacts). The same checks as sending a
   * message there; refused: 404 TARGET_NOT_FOUND. With `widenTo`, once those
   * checks passed and before anything is posted, the Artifact moves to that
   * larger home by the home route's rule and code (refused as it refuses:
   * 404 NOT_VISIBLE, 403 FORBIDDEN, 409 NAME_TAKEN; nothing is posted then);
   * already that wide is no refusal; a retry of the attempt (its `clientKey`
   * already made the message) or a key reused for another conversation
   * never moves it. A write: 60 a minute per
   * user, shared with the other writes, and a message: also within core's
   * message limit (`POST /api/messages`'s, shared with sending messages; its
   * 429 carries no code). Idempotent per `clientKey`: sending again with the
   * same key answers the message the first send posted (the same
   * `messageId`, nothing posted again); the same key for another
   * conversation or thread is 400 INVALID_REQUEST.
   */
  share: (id: ArtifactId) => `/api/artifacts/${enc(id)}/share`,
  /**
   * POST ArtifactWebFrameInput → ArtifactWebFrame (S2): where to load the
   * version (current, or `version`) on the content origin, with a one-time
   * ticket the server signs (no call to the content origin). Checked in this
   * order: the flag, visibility (404 NOT_VISIBLE), the version (404
   * VERSION_NOT_FOUND), its kind (only ARTIFACT_FRAMED_KINDS, else 409
   * NOT_FRAMED), `path` when it names another file than the entry (400
   * INVALID_PATH for no file path, 404 FILE_NOT_FOUND for none of that
   * version, 409 NOT_FRAMED for a file that is no HTML page, Markdown file
   * or PDF), then the
   * content origin (503 CONTENT_UNAVAILABLE when it isn't configured). A body
   * other than `{}`, `{ version: <positive integer> }`, `{ path: <string> }`
   * or both is 400 INVALID_REQUEST; more than 120 a minute per user, together with the
   * viewer (which signs one too), 429 RATE_LIMITED (apart from the writes'
   * 60 a minute: see RATE_LIMITED).
   * Asked on every mount: a ticket is good once, and the
   * answer is never cached or kept in a payload.
   */
  frame: (id: ArtifactId) => `/api/artifacts/${enc(id)}/frame`,
  /**
   * GET → ArtifactWebDashboard (S7, the Artifacts home page): the reader's
   * sections in the current server, the first page of each. `home` narrows
   * every section to one kind of home; `author` to Artifacts by those
   * authors (ArtifactDashboardAuthor, sent once per value; several are
   * any of them). Reads only: never moves a read
   * position (opening the viewer does). 120 a minute per user, shared with
   * `dashboardSection`, then 429 RATE_LIMITED. A `home` other than
   * ARTIFACT_DASHBOARD_HOMES, an `author` that isn't an
   * ArtifactDashboardAuthor or more than ARTIFACT_DASHBOARD_AUTHORS_MAX of
   * them, or any `cursor` (a cursor pages one section), is 400
   * INVALID_REQUEST.
   */
  dashboard: (options: { home?: ArtifactDashboardHome; author?: readonly ArtifactDashboardAuthor[] } = {}) => `/api/artifacts/dashboard${query(options)}`,
  /**
   * GET → ArtifactWebDashboard[section]: the next page of one
   * section, `cursor` a page's `nextCursor` (with the same `home` and
   * `author`). A cursor that doesn't parse, a section other than
   * ARTIFACT_DASHBOARD_SECTIONS, or an `author` as `dashboard` refuses it,
   * is 400 INVALID_REQUEST.
   */
  dashboardSection: (section: ArtifactDashboardSection, options: { home?: ArtifactDashboardHome; author?: readonly ArtifactDashboardAuthor[]; cursor?: string } = {}) =>
    `/api/artifacts/dashboard/${enc(section)}${query(options)}`,
  /**
   * GET → ArtifactWebDashboardAll: the page's All tab, every Artifact the
   * reader can see in the current server (by the same rule as the viewer
   * and the dashboard's sections), in the order `sort` and `dir` ask,
   * ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT a page; `cursor` a page's `nextCursor`
   * (with the same `home`, `author`, `conversation`, `q`, `sort`, `dir` and `relevant`). `home` narrows
   * to one kind of home, as the dashboard's; `q` keeps only Artifacts whose
   * title has every word of it (Artifacts' one title search, the agent
   * list's `query` and core search's), trimmed, at most
   * WEB_SEARCH_QUERY_MAX_CHARS code points; an empty `q` is none. The order
   * never depends on `q` (no rank). `author` keeps only Artifacts by those
   * authors, as the dashboard's. `conversation` keeps only Artifacts homed in
   * that one conversation (an id from `dashboardConversations`, or a card's
   * home; a thread's or task's id means its parent): one uuid, and a
   * conversation the reader can't see, or that doesn't exist, is an ordinary
   * empty page (no rows, `filtered` and `relevant` 0, `total` as ever), never
   * an error, so the answer says nothing of whether it exists. Beside `home`
   * both apply. `sort` (ArtifactDashboardAllSort, absent:
   * `updated`, the order older Servers answer) and `dir`
   * (ArtifactDashboardAllDir, absent: ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS of
   * the sort) say the order, every sort then by the Artifact's id in the
   * same direction. `relevant` keeps every Artifact the reader is involved
   * with, read or not: one it made (published any version of, itself or by an agent it created), one it follows, or one with a live
   * comment by someone else that mentions it; and fixes the order: what has
   * news (ArtifactDashboardAllNews) first, among it what is waiting on the
   * reader (`news.mentions` above 0) first; then the rest; each newest update
   * first, then by id. `sort` and
   * `dir` are still checked but order nothing then. The path sends it as
   * `relevant=1`, the only value it takes. A cursor pages only the order it
   * came from: one of another `sort` or `dir`, or from a list with `relevant`
   * for one without (either way), is 400 INVALID_REQUEST. Reads only, moves no
   * read position. 120 a minute per user, shared with the dashboard, then
   * 429 RATE_LIMITED. A `home` other than ARTIFACT_DASHBOARD_HOMES, a `q`
   * that isn't one string or is too long, an `author` as `dashboard` refuses
   * it, a `conversation` that isn't one uuid, a `sort` other than
   * ARTIFACT_DASHBOARD_ALL_SORTS, a `dir` other than
   * ARTIFACT_DASHBOARD_ALL_DIRS, a `relevant` other than `1`, or a cursor
   * that doesn't parse or is of another order: 400 INVALID_REQUEST.
   */
  dashboardAll: ({ relevant, ...options }: {
    home?: ArtifactDashboardHome;
    author?: readonly ArtifactDashboardAuthor[];
    conversation?: string;
    q?: string;
    sort?: ArtifactDashboardAllSort;
    dir?: ArtifactDashboardAllDir;
    cursor?: string;
    relevant?: boolean;
  } = {}) => `/api/artifacts/dashboard/all${query({ ...options, relevant: relevant ? "1" : undefined })}`,
  /**
   * GET → ArtifactWebDashboardAuthors: who wrote the Artifacts the reader
   * can see in the current server (those `dashboardAll` lists without a
   * filter), each once with how many of them, the most first, at most
   * ARTIFACT_DASHBOARD_AUTHORS_LIMIT; the candidates of the `author`
   * filter. `q` keeps only those whose handle or display name contains it
   * (any case), trimmed, at most WEB_SEARCH_QUERY_MAX_CHARS code points; an
   * empty `q` is none. Reads only. 120 a minute per user, shared with the
   * dashboard, then 429 RATE_LIMITED. A `q` that isn't one string or is too
   * long: 400 INVALID_REQUEST.
   */
  dashboardAuthors: (options: { q?: string } = {}) => `/api/artifacts/dashboard/authors${query(options)}`,
  /**
   * GET → ArtifactWebDashboardConversations: the conversations that hold
   * Artifacts the reader can see in the current server (those `dashboardAll`
   * lists in a conversation), most recently updated first, at most
   * ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT; the candidates of the
   * `conversation` filter. A conversation the reader can't see is never
   * listed, whatever `q` says. `q` keeps only those whose name (a DM's peer
   * by handle or display name) contains it (any case; a leading `#` is how a
   * channel is written and is ignored), trimmed, at most
   * WEB_SEARCH_QUERY_MAX_CHARS code points; an empty `q` is none. Reads only.
   * 120 a minute per user, shared with the dashboard, then 429 RATE_LIMITED.
   * A `q` that isn't one string or is too long: 400 INVALID_REQUEST.
   */
  dashboardConversations: (options: { q?: string } = {}) => `/api/artifacts/dashboard/conversations${query(options)}`,
  /**
   * GET → ArtifactWebLocation: which of the reader's servers to open the
   * Artifact in, for its canonical link (`/artifacts/<id>`, which names no
   * server). Asked with any server the reader is in (X-Server-Id); answers
   * about every server they are in: the Artifact's own first, then the
   * one asked with, then (an Artifact in a joint channel) the others. The
   * first one they can see it from whose Artifacts are on, both its own and
   * the Artifact's server's. Reads only, moves no read position.
   * - A public Artifact whose own server has Artifacts on, seen only from
   *   servers whose Artifacts are off (the reader isn't in its server):
   *   `{ serverSlug, serverArtifactsOff: true }`, the server they see it
   *   from. A public Artifact opens by its own server's flag alone: there
   *   the viewer, its files, frame, comment list and presence answer (as an
   *   outsider's: the current version, no comments), every write is 403
   *   ARTIFACTS_NOT_ENABLED and the viewer's `capabilities` offer none.
   * - Seen from none of them, whatever the reason (no such id, deleted,
   *   revoked, not theirs to see, another server's Artifact whose server has
   *   Artifacts off): the one 404 NOT_VISIBLE.
   * - Seen, but Artifacts off there: 403 ARTIFACTS_NOT_ENABLED naming that
   *   server (`details.serverSlug`): the Artifact's own server when the
   *   reader is in it, else the server they see it from (never for a public
   *   Artifact of a server they aren't in).
   * 120 a minute per user, then 429 RATE_LIMITED.
   */
  locate: (id: ArtifactId) => `/api/artifacts/${enc(id)}/locate`,
  /**
   * GET → ArtifactWebOpen: the standalone page's one call (`/artifacts/<id>`,
   * `/artifacts/<id>/v/<n>`): where the Artifact opens and its viewer data,
   * instead of `/auth/me`, `/servers`, `locate` and `viewer` in turn. Signed
   * in, with no X-Server-Id (the session's person, whatever server the web
   * last used); signed out is 401 (show the signed-out page,
   * artifactPublicPaths). Only the Artifact's own server is asked about:
   * - the reader is a member of the Artifact's server and reads it there
   *   (its home, and that server's Artifacts on): `opensIn` is that server,
   *   `viewer` exactly `viewer(id, version)`'s answer there (capabilities,
   *   the read position moved, `frame`, and its refusals: `version` unknown
   *   404 VERSION_NOT_FOUND, malformed 400 INVALID_REQUEST). Being a member
   *   is not enough: one who can't see its home gets the next answer;
   * - otherwise, a public Artifact whose own server has Artifacts on:
   *   `opensIn: null`, `viewer` read as an outsider (no capability, the
   *   current version only, no comments, nothing moved), its `frame` the
   *   signed-out page's (`artifactPublicPaths.frame` gives the next one);
   *   `version` naming any other version is the one 404;
   * - otherwise, whatever the reason (no such id, not theirs to see, its own
   *   server's Artifacts off), the one 404 NOT_VISIBLE. The reader's other
   *   servers are never asked: an Artifact of a joint channel they see
   *   only through another server answers this 404 (`locate` finds it).
   * `private, no-store`, `Vary: Authorization, Cookie`. In the frame route's
   * budget (its answer signs a ticket, as the viewer's): 120 a minute per
   * user together with the viewer and frame, then 429 RATE_LIMITED.
   */
  open: (id: ArtifactId, options: { version?: number } = {}) => `/api/artifacts/${enc(id)}/open${versionQuery(options.version)}`,
  /**
   * GET → ArtifactWebConversationArtifacts: the Artifacts that live in a
   * conversation (its Files panel), ARTIFACT_CONVERSATION_PAGE_LIMIT a page,
   * newest first; `cursor` a page's `nextCursor`. `conversationId` as the
   * reader's server has it (a joint channel by the reader's projection; a
   * thread means its conversation). A conversation the reader can't see now,
   * or that doesn't exist: 404 TARGET_NOT_FOUND, the same for both. A cursor
   * that doesn't parse: 400 INVALID_REQUEST. Reads only, moves no read
   * position. 120 a minute per user, shared with the dashboard, then 429
   * RATE_LIMITED.
   */
  conversationArtifacts: (conversationId: ChannelId, options: { cursor?: string } = {}) =>
    `/api/artifacts/conversations/${enc(conversationId)}${query(options)}`,
} as const;

/** Where to open an Artifact (`locate`): the slug of the server it opens in (`/s/<slug>`). */
export interface ArtifactWebLocation {
  serverSlug: string;
  /**
   * Artifacts are off in `serverSlug`: a public Artifact of another server
   * that opens there only to read (its own server's flag decides). That
   * server has no Artifacts page to return to, and no write will answer.
   */
  serverArtifactsOff?: true;
}

/** The standalone page's one call (`open`): where the Artifact opens, and what its viewer shows. */
export interface ArtifactWebOpen {
  /**
   * The Artifact's own server, which the reader is a member of and reads it
   * in: open it there (`/s/<slug>/artifacts?artifact=<id>`, every later
   * request with X-Server-Id `serverId`), its name for the page's header.
   * Null: read as an outsider (a public Artifact of a server they aren't
   * in): no server to return to, every write is off, and
   * later frames come from `artifactPublicPaths.frame`.
   */
  opensIn: { serverId: ServerId; slug: string; name: string } | null;
  /**
   * What the viewer shows. With `opensIn`, the viewer route's answer in that
   * server; without, an outsider's (`capabilities` all false, `versions`
   * the current one only, `following` false, no `origin` or `savedFrom`).
   * Its `frame`, when present, is good once within 60 seconds, as the
   * viewer's (ArtifactViewerData.frame).
   */
  viewer: ArtifactViewerData;
}

/** At most this many rows in one page of a dashboard section. */
export const ARTIFACT_DASHBOARD_PAGE_LIMIT = 20;

/** At most this many rows in one page of the Artifacts page's All tab (`dashboardAll`). */
export const ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT = 50;

/**
 * The All tab's orders (`dashboardAll`'s `sort`), each then by the
 * Artifact's id in the same direction:
 * - `updated`: the card's `updatedAt` (the Artifact's last update), at
 *   millisecond precision; the default, and the only order before `sort`.
 * - `title`: the card's `title`, in any case (compared lower-cased, in the
 *   database's collation).
 * - `comments`: the card's `commentCount`, the Artifact's live (not deleted)
 *   comments, counted when the page is read.
 * - `opened`: when the reader last opened it (the row's `openedAt`, at
 *   millisecond precision), then the card's `updatedAt`. What the reader
 *   never opened comes after everything opened, in either direction, in the
 *   same direction by update. The new home page's default; a client that
 *   leaves `sort` out still gets `updated`.
 * There is no author order: the `author` filter narrows by author instead.
 */
export const ARTIFACT_DASHBOARD_ALL_SORTS = ["updated", "title", "comments", "opened"] as const;
export type ArtifactDashboardAllSort = (typeof ARTIFACT_DASHBOARD_ALL_SORTS)[number];

/** The All tab's directions (`dashboardAll`'s `dir`): ascending or descending. */
export const ARTIFACT_DASHBOARD_ALL_DIRS = ["asc", "desc"] as const;
export type ArtifactDashboardAllDir = (typeof ARTIFACT_DASHBOARD_ALL_DIRS)[number];

/** The direction of each `sort` when `dir` is absent: the newest and the most commented first, titles from A. */
export const ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS: Readonly<Record<ArtifactDashboardAllSort, ArtifactDashboardAllDir>> = {
  updated: "desc",
  title: "asc",
  comments: "desc",
  opened: "desc",
};

/** At most this many rows in one page of a conversation's Artifacts (`conversationArtifacts`). */
export const ARTIFACT_CONVERSATION_PAGE_LIMIT = 20;

/**
 * The dashboard's sections. Drafts (S8) and review requests have no data
 * source yet: they are not here, and come as new sections (an additive
 * change) when they do.
 */
export const ARTIFACT_DASHBOARD_SECTIONS = ["waiting", "following", "recent"] as const;
export type ArtifactDashboardSection = (typeof ARTIFACT_DASHBOARD_SECTIONS)[number];

/**
 * The dashboard's `home` filter, by the kind of the Artifact's home:
 * `channel` a conversation other than a DM (channel, private channel,
 * joint), `dm` a DM, `server` the whole server, `public` public. Absent: all.
 */
export const ARTIFACT_DASHBOARD_HOMES = ["channel", "dm", "server", "public"] as const;
export type ArtifactDashboardHome = (typeof ARTIFACT_DASHBOARD_HOMES)[number];

/** At most this many `author` values in one dashboard request (`dashboard`, `dashboardSection`, `dashboardAll`). */
export const ARTIFACT_DASHBOARD_AUTHORS_MAX = 20;

/** At most this many authors in `dashboardAuthors`' answer. */
export const ARTIFACT_DASHBOARD_AUTHORS_LIMIT = 50;

/**
 * One value of the dashboard's `author` filter, which keeps Artifacts by
 * their author (the item's, a latest card's `author`): `me` the reader;
 * `my-agents` the agents the reader manages in the current server (their
 * personal assistant, and the agents they made that are no one's
 * assistant: the rule by which an agent's manager may manage its
 * Artifacts); `user:<id>` or `agent:<id>` one person or agent (an
 * ArtifactActor's `id`, a uuid). Several values are any of them. The
 * filter only narrows what the reader can see.
 */
export type ArtifactDashboardAuthor = "me" | "my-agents" | `user:${string}` | `agent:${string}`;

/** One of `dashboardAuthors`' authors: who, and how many of the Artifacts the reader can see they wrote. */
export type ArtifactDashboardAuthorCandidate = ArtifactActor & { count: number };

/**
 * The `author` filter's candidates (`dashboardAuthors`): the authors of the
 * Artifacts the reader can see in the current server, by how many of them
 * they wrote (the most first), then by display name.
 */
export interface ArtifactWebDashboardAuthors {
  authors: ArtifactDashboardAuthorCandidate[];
}

/** At most this many conversations in `dashboardConversations`' answer. */
export const ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT = 50;

/**
 * One of `dashboardConversations`' conversations, as a card's home names it
 * for the reader (a joint by the reader's server's projection, a DM by its
 * peer): its `id` is what `conversation` takes. `count`: the Artifacts the
 * reader can see in it. `updatedAt`: the newest of their cards' `updatedAt`.
 * `peer`: a DM's other side, for its avatar; absent for any other type and
 * when it can't be told.
 */
export type ArtifactDashboardConversation = Omit<Extract<ArtifactHome, { kind: "conversation" }>["conversation"], "id"> & {
  id: string;
  count: number;
  updatedAt: string;
  peer?: ArtifactActor;
};

/** The `conversation` filter's candidates (`dashboardConversations`), most recently updated first, then by id. */
export interface ArtifactWebDashboardConversations {
  conversations: ArtifactDashboardConversation[];
}

/**
 * One page of a dashboard section, newest first. `nextCursor`: there is more
 * (`dashboardSection`), else null. An Artifact with new activity while the
 * pages are read moves to the top, so it may be missing from the later pages
 * of that run; none is ever listed twice.
 */
export interface ArtifactDashboardPage<Row> {
  rows: Row[];
  nextCursor: string | null;
}

/**
 * An Artifact where someone is waiting for the reader: it has comments that
 * @-mention the reader, by others, after the reader's read position (unread),
 * not deleted. One row per Artifact, ordered by its newest such comment.
 * Opening the Artifact's current version (the viewer) clears it.
 */
export interface ArtifactDashboardWaiting {
  card: ArtifactCard;
  /** The newest such comment. */
  comment: {
    id: ArtifactCommentId;
    author: ArtifactActor;
    /**
     * The comment's first AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS characters
     * as plain text, each mention written as its `@handle` (the text agents
     * read); `truncated` when there is more.
     */
    excerpt: string;
    truncated: boolean;
    createdAt: string;
    /** The version it was written on. */
    version: number;
    /** The file it is on, or null for the whole Artifact. */
    path: string | null;
  };
  /** How many such comments (unread, mentioning the reader), the newest included. */
  count: number;
}

/**
 * An Artifact the reader follows that has something new by others since
 * their read position: published versions, comments (not deleted), or both.
 * Ordered by the newest of it. Opening the current version clears it.
 */
export interface ArtifactDashboardFollowing {
  card: ArtifactCard;
  unread: { versions: number; comments: number };
  /** When the newest unread version or comment was made. */
  activityAt: string;
}

/**
 * An Artifact the reader published a version of or opened, the latest of
 * the two first, each Artifact once.
 */
export interface ArtifactDashboardRecent {
  card: ArtifactCard;
  /** The reader's newest published version of it; null if they never published one. */
  publishedAt: string | null;
  /** When the reader last opened it (their read position last moved); null if never. */
  openedAt: string | null;
  /** The later of the two: what the section is ordered by. */
  at: string;
}

/**
 * The Artifacts home page (S7): the reader's sections in the current server
 * (the request's server; another server's Artifacts never appear), each its
 * first page; `dashboardSection` answers one section's next page as
 * `ArtifactWebDashboard[section]`. Every row is an Artifact the reader can
 * see now, by the same rule as the viewer, its card exactly the viewer's for
 * the current version. Never-published Artifacts (no current version) and
 * orphans (their home conversation deleted) are left out.
 */
export interface ArtifactWebDashboard {
  waiting: ArtifactDashboardPage<ArtifactDashboardWaiting>;
  following: ArtifactDashboardPage<ArtifactDashboardFollowing>;
  recent: ArtifactDashboardPage<ArtifactDashboardRecent>;
}

/**
 * What is new for the reader on one Artifact of the All tab, by the sections'
 * own rules, whichever `sort` and `relevant` asked: `mentions` is
 * ArtifactDashboardWaiting's `count`, `versions` and `comments` are
 * ArtifactDashboardFollowing's `unread` (so 0 unless the reader follows it).
 * Any of them above 0 is what `counts.relevant` counts and what `relevant`
 * lists first (it lists what the reader is involved with, news or not), so a
 * card with something to say is the same card with the filter on or off. An opened Artifact the reader doesn't follow says nothing here however
 * many new comments it has (the message card's `unseen` would mark them).
 */
export interface ArtifactDashboardAllNews {
  mentions: number;
  versions: number;
  comments: number;
}

/**
 * One row of the All tab: an Artifact the reader can see, its card exactly
 * the viewer's for the current version (`card.updatedAt`, `card.title`,
 * `card.commentCount` or `openedAt` is what the tab is ordered by:
 * ArtifactDashboardAllSort), and the reader's own facts about it. An object
 * so it can say more later without breaking the shape.
 */
export interface ArtifactDashboardAllRow {
  card: ArtifactCard;
  /**
   * When the reader last opened it, as ArtifactDashboardRecent's `openedAt`
   * (their read position last moved); null if never. Absent from older
   * Servers.
   */
  openedAt?: string | null;
  /** The sticker's facts; every count 0 when there are none. Absent from older Servers. */
  news?: ArtifactDashboardAllNews;
}

/**
 * The All tab's counts, for the page's count line ("24", "5 of 24") and the
 * `relevant` toggle's number. Artifacts, each once.
 */
export interface ArtifactDashboardAllCounts {
  /** Everything the reader can see in the current server: no `home`, `author`, `conversation`, `q` or `relevant`, whichever were asked. */
  total: number;
  /** What this list pages through: `home`, `author`, `conversation`, `q` and `relevant` as asked. */
  filtered: number;
  /**
   * What has news for the reader (ArtifactDashboardAllNews above 0) of `home`, `author`, `conversation` and `q` as asked,
   * whether or not `relevant` was asked: the toggle's "something new for you". Every one is something `relevant` lists
   * (it lists what the reader is involved with, news or not), so with the filter on it is at most `filtered`.
   */
  relevant: number;
}

/**
 * The Artifacts page's All tab (`dashboardAll`): every Artifact the reader
 * can see in the current server, in the order asked (newest update first by
 * default), live and with a readable current version; never-published,
 * deleted, revoked and orphaned Artifacts are left out, as in the sections.
 * Paging is by keyset on the order's key and the id: an Artifact whose key
 * changes while the pages are read (updated, renamed, commented on) moves
 * in the order, so it may be missing from the later pages of that run, or
 * listed again on one of them. Newest update first and `opened` newest first
 * never list one twice (an update or an open only moves it to the top).
 *
 * `counts`: on a first page (no `cursor`) only, null on the pages after it
 * (the first one's still stand; counting again would cost a page each).
 * Absent from older Servers.
 */
export type ArtifactWebDashboardAll = ArtifactDashboardPage<ArtifactDashboardAllRow> & {
  counts?: ArtifactDashboardAllCounts | null;
};

export interface ArtifactWebFrameInput {
  /** The version to show; the current one when absent. */
  version?: number;
  /**
   * The file of that version the frame opens at, when it isn't the entry
   * (#proj-workspace:#272: a file the reader opened from Files): an HTML
   * page, a Markdown file or a PDF of a version whose entry is framed (an
   * older Server: an HTML page only, 409 NOT_FRAMED for the others).
   * Absent, or the entry's own
   * path: the entry. Absent from older Servers, which answer 400
   * INVALID_REQUEST for it.
   */
  path?: string;
}

/**
 * Where a framed version loads: Porthole's `FrameLocation`
 * (`@botiverse/porthole`, isolation/types.ts). `url` is
 * `<origin>/_raft/open?ticket=<ticket>`, the ticket signed by Raft's server
 * (shared artifactContentTicket.ts) and opened once, within 60 seconds, by
 * the content Worker: load it once, never log or store it.
 * `origin` is the version's own origin on the content domain; the host takes
 * messages only from it (Porthole's `checkFrameLocation` also refuses one
 * that may be same-site with the app). `reports`: the page reports how
 * loading went (`porthole/notifications/frame-status`). No `viewer`: Raft's
 * grant names no viewer level. `door` (Porthole P125, P126): the frame's
 * door, `<origin>/__porthole/door/_raft?ticket=<door ticket>`, its own
 * one-time ticket signed beside the content's, which Porthole 0.14.6+ frames
 * first (hidden, opaque) and takes how loading went from; an older host
 * ignores it. Pass it to Porthole as it came (a custom locator must), and
 * never reuse a frame: both tickets open once.
 * `instanceVersion`: the version the tickets were signed for, as the content
 * Worker's Porthole instance names it (`ArtifactInstanceVersion`); the web
 * mounts the frame's instance with it. Absent from older Servers.
 */
export interface ArtifactWebFrame {
  url: string;
  origin: string;
  reports?: boolean;
  door?: { url: string };
  instanceVersion?: ArtifactInstanceVersion;
}

/**
 * The version a frame's tickets name, as the content Worker's Porthole
 * instance has it (`document.version` of `{ kind: "artifact", id, version }`):
 * an opaque handle, today the version's own id (`v_<uuid>`). Never parse it,
 * show it, or use it to ask for anything; the only use is the frame's
 * `instance`, compared by Porthole as it came.
 *
 * Why a version id leaves the server here, despite "No `id` outside the
 * Artifact's server" (ArtifactVersionSummary): the frame's own shell already
 * posts it to the app's window in every `porthole/navigating` notice (its
 * `set`, from the ticket's instance), and Porthole's host (pages-of-set, P084,
 * P098) takes a notice as the display's own page only when that `set` equals
 * the mounted instance exactly. Mounted with the version's number, every
 * in-set link was taken for the content leaving and the display started again
 * (#proj-workspace:#251). Nothing else of the version's id is given.
 *
 * Mint with {@link asArtifactInstanceVersion}: the server from the version
 * row it signs for, the web from a frame answer (null when it isn't one).
 */
export type ArtifactInstanceVersion = Brand<string, "ArtifactInstanceVersion">;

const ARTIFACT_INSTANCE_VERSION = /^v_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** {@link ArtifactInstanceVersion} from a version's id, or from a frame answer's field: null for anything else. */
export function asArtifactInstanceVersion(raw: unknown): ArtifactInstanceVersion | null {
  return typeof raw === "string" && ARTIFACT_INSTANCE_VERSION.test(raw) ? (raw as ArtifactInstanceVersion) : null;
}

/**
 * The content frame's `sandbox` tokens, and the same tokens in every content
 * page's CSP `sandbox` header (Porthole P099). No popups and no top
 * navigation: links go to the host through Porthole's shell. `allow-same-origin`
 * gives the page its own origin on the content domain (never Raft's), for
 * storage. Pinned by a test here and by the Worker's.
 */
export const ARTIFACT_FRAME_SANDBOX = "allow-scripts allow-same-origin";

/** A file of a version as JSON: text inline (cut at 256 KiB), or only its size and type. */
export type ArtifactWebFileContent =
  | { kind: "text"; path: string; version: number; size: number; contentType: string; content: string; truncated: boolean }
  | { kind: "binary"; path: string; version: number; size: number; contentType: string };

/**
 * Every version's comments (E12), a page at a time from the newest: each page
 * is in oldest-first order, `olderCursor` loads the one before it (null at the
 * first comment). Pages are up to 50 comments. A reply can arrive on a
 * newer page than the comment it answers; the client holds it under a
 * placeholder until the older page with its parent loads (the Server does not
 * keep a thread on one page).
 */
export interface ArtifactWebCommentsPage {
  comments: ArtifactComment[];
  olderCursor: string | null;
  /**
   * Only with the query's `review` (S8), on every page: that review, its
   * summary here and not in `comments` (as the agent API's `review`). Null,
   * with nothing listed, for an id that isn't a review of this Artifact or a
   * reader who can't read its comments. Without `review` it is absent, and
   * a review's summary is listed as any comment (with `reviewId`).
   */
  review?: ArtifactWebReview | null;
}

/** A posted review (S8), as the comments page names it under `review`. */
export interface ArtifactWebReview {
  id: ArtifactReviewId;
  /** Named as the page's comment authors are. */
  author: ArtifactActor;
  /** Its summary, as a comment's body (mentions as actors); null without one, or once the summary was deleted. */
  body: ArtifactCommentPart[] | null;
  createdAt: string;
}

/**
 * What the comment box sends. A mention names the actor by type and id; the
 * Server checks the mentioned can see the Artifact (a mention never grants
 * access) and returns the stored comment with names filled in.
 */
/**
 * At most this many distinct people and agents mentioned in one comment
 * (the author included), as on the agent API; more → 400 TOO_MANY_MENTIONS.
 */
export const ARTIFACT_COMMENT_MAX_MENTIONS = 20;

/**
 * At most this many characters (Unicode code points) in a comment's text as
 * stored: the text parts with each mention written as its `@handle`, trimmed;
 * more → 400 FIELD_TOO_LONG { field: "body", limit }. The same limit as the
 * agent API: AGENT_API_ARTIFACT_MAX_COMMENT_CHARS is this constant. Defined
 * in artifactCommentLimits.ts, which both contracts import (the agent
 * contract importing this file directly trips the tsrs checker).
 */
export { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, ARTIFACT_COMMENT_IMAGE_TYPES, ARTIFACT_COMMENT_MAX_CHARS, ARTIFACT_COMMENT_MAX_IMAGES, type ArtifactCommentImageType } from "./artifactCommentLimits";

export interface ArtifactWebCommentInput {
  /** Its text and mentions; may be empty when it has images. */
  body: Array<{ type: "text"; text: string } | { type: "mention"; actor: { type: "user" | "agent"; id: string } }>;
  /** The version the commenter is looking at. */
  version: number;
  target: { scope: "artifact" } | { scope: "file"; path: string; anchor: ArtifactCommentAnchor | null };
  replyTo: ArtifactCommentId | null;
  /**
   * Images uploaded for it (`artifactWebPaths.commentImages`, each the
   * upload's `fileId`), in the order shown, at most
   * ARTIFACT_COMMENT_MAX_IMAGES; absent: none (older clients send none).
   */
  images?: ObjectFileId[];
}

export interface ArtifactWebCommentCreated {
  comment: ArtifactComment;
  /** Who heard about it, with why (the same reasons as ArtifactWillNotify). */
  notified: ArtifactWillNotify["recipients"];
}

/** A resolve's request (`artifactWebPaths.commentResolve`): an optional note, posted as the resolver's reply in the thread. */
export interface ArtifactWebResolveInput {
  /** The note's text and mentions, as a comment's body; null or absent: none. */
  note?: ArtifactWebCommentInput["body"] | null;
}

/** A resolve's or reopen's answer: the thread's root as it stands now. */
export interface ArtifactWebThreadResolution {
  comment: ArtifactComment;
  /** The note posted as a reply (a resolve with one that changed something), else null. */
  note: ArtifactComment | null;
  /** False when it already stood so: nothing written. */
  changed: boolean;
}

export interface ArtifactWebReviewDrafts {
  drafts: ArtifactCommentDraft[];
}

export interface ArtifactWebReviewDraftSaved {
  draft: ArtifactCommentDraft;
}

/**
 * A submit refused (422, S8): nothing posted. `draftId` names the first
 * draft refused, in the order they were made; null when it is the summary
 * (checked after every draft). `code` and `details` are the refusal the
 * draft (or the summary) would have got as a comment of its own
 * (ArtifactWebErrorDetails' shapes). These are every code it can be (never
 * FORBIDDEN: the reader was checked before, as the route's own 403):
 * - INVALID_REQUEST, no details, and INVALID_PATH `{ path }`: what the
 *   draft keeps no longer passes as a comment (only after the rules
 *   tightened since it was saved);
 * - FIELD_TOO_LONG `{ field: "body" | "anchor", limit }`;
 * - VERSION_NOT_FOUND `{ version, currentVersion }`: the draft's (or the
 *   summary's) version is no longer readable (revoked); no details when the
 *   Artifact has no readable version left;
 * - FILE_NOT_FOUND `{ path, version }`: that version has no such file;
 * - TOO_MANY_MENTIONS `{ limit }`;
 * - MENTION_NOT_VISIBLE `{ actors }`: who it mentions that can't see the
 *   Artifact now;
 * - COMMENT_NOT_FOUND, no details: a reply draft's comment (its `replyTo`)
 *   was deleted since; only that draft is in the way (delete it, or write it
 *   again as a comment of its own).
 */
export type ArtifactReviewRejected =
  | ArtifactReviewRejection<"INVALID_REQUEST", { details?: never }>
  | ArtifactReviewRejection<"INVALID_PATH", { details: ArtifactWebErrorDetails["INVALID_PATH"] }>
  | ArtifactReviewRejection<"FIELD_TOO_LONG", { details: ArtifactWebErrorDetails["FIELD_TOO_LONG"] & { field: "body" | "anchor" } }>
  | ArtifactReviewRejection<"VERSION_NOT_FOUND", { details?: ArtifactWebErrorDetails["VERSION_NOT_FOUND"] }>
  | ArtifactReviewRejection<"FILE_NOT_FOUND", { details: ArtifactWebErrorDetails["FILE_NOT_FOUND"] }>
  | ArtifactReviewRejection<"TOO_MANY_MENTIONS", { details: ArtifactWebErrorDetails["TOO_MANY_MENTIONS"] }>
  | ArtifactReviewRejection<"MENTION_NOT_VISIBLE", { details: ArtifactWebErrorDetails["MENTION_NOT_VISIBLE"] }>
  | ArtifactReviewRejection<"COMMENT_NOT_FOUND", { details?: never }>;

/** One code of ArtifactReviewRejected, with its `details`. */
type ArtifactReviewRejection<Code extends ArtifactWebErrorCode, Details> = {
  status: "rejected";
  draftId: ArtifactCommentDraftId | null;
  code: Code;
  /** The refusal's sentence: why the draft was refused and what to change. */
  error: string;
} & Details;

/**
 * A submitted review: `ok`, its comments as posted (the drafts in the order
 * they were made, then the summary), each carrying `reviewId`; or
 * ArtifactReviewRejected (422).
 */
export type ArtifactReviewSubmitted =
  | { status: "ok"; comments: ArtifactComment[] }
  | ArtifactReviewRejected;

export interface ArtifactWebMentionCandidates {
  candidates: ArtifactActor[];
  /**
   * With `q` empty: false when `candidates` is everyone eligible (the client
   * then filters locally as the name is typed); true when there were more
   * than the server sent (the client asks again by `q`). Older servers leave
   * it out, which the client reads as true.
   */
  capped?: boolean;
}

/**
 * Move an Artifact to another home (D15): a larger one, or a smaller one (a
 * conversation by its id: only the Artifact's original conversation,
 * ArtifactViewerData.originalHome, #75). The confirmation dialog states what
 * changes (for a smaller home: ArtifactWebHomeChange).
 *
 * `expectedLost` (a narrowing only): the preview's `peopleLosingAccess +
 * agentsLosingAccess` the person confirmed. Given, the request is a
 * narrowing whatever the home is now (a home that changed since is refused,
 * never widened), and it moves only if the same count (the same capped way)
 * still holds: else 409 LOSS_CHANGED { expected, actual, capped } and
 * nothing changes; preview again and ask again. A non-negative integer.
 * Without it the request only widens (409 HOME_NOT_WIDER otherwise).
 */
/** The title route's body (`artifactWebPaths.title`): the new title, trimmed by the server. */
export interface ArtifactWebTitleInput {
  title: string;
}

export type ArtifactWebHomeInput =
  | { to: "public" }
  | { to: "server"; expectedLost?: number }
  | { to: "conversation"; conversationId: ChannelId; expectedLost?: number };

/**
 * What a move to a smaller home would take away, before confirming it.
 * Counts only, never names: of the Artifact's server's people (any role,
 * guests included) and agents, those who see it now and wouldn't in the new
 * home. Its author never loses it (the move is refused instead).
 */
export interface ArtifactWebHomeChange {
  peopleLosingAccess: number;
  agentsLosingAccess: number;
  /**
   * Set when the server has more people and agents than
   * ARTIFACT_HOME_CHANGE_MAX_COUNTED: only that many were checked, and the
   * counts are a lower bound (shown as "500+").
   */
  capped?: boolean;
  /** It is public now: signed-out visitors and other servers' people lose it too; they are not counted. */
  leavesPublic: boolean;
}

/** At most this many of a server's people and agents are checked for ArtifactWebHomeChange; past it the counts are `capped`. */
export const ARTIFACT_HOME_CHANGE_MAX_COUNTED = 500;

/** At most this many characters of a takedown's or a restore's reason (trimmed; required, recorded in the audit row). */
export const ARTIFACT_TAKEDOWN_REASON_MAX_CHARS = 1000;

/** `takedown` and `restore`: why, for the audit row (a report's reference, the policy it breaks). */
export interface ArtifactWebTakedownInput {
  reason: string;
}

/** The Artifact's takedown state after `takedown` or `restore`; `changed: false` when it already was. */
export interface ArtifactWebTakedown {
  id: ArtifactId;
  takenDown: boolean;
  /** When it was taken down (ISO), null once restored. */
  revokedAt: string | null;
  changed: boolean;
}

/**
 * Any attachment can be saved, whatever its type, except one larger than an
 * Artifact file may be (16 MiB text, 15 MiB binary, as for publishing) or
 * still uploading: 422 ATTACHMENT_NOT_SAVABLE { reason }. The client can hide
 * "Save as Artifact" for those from the attachment's size and state.
 */
export const ARTIFACT_SAVE_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const ARTIFACT_SAVE_MAX_BINARY_BYTES = 15 * 1024 * 1024;

export interface ArtifactWebSaveInput {
  /** An attachment id (no shared brand for attachment ids yet). */
  attachmentId: string;
}

export interface ArtifactWebSaved {
  /** The Artifact, as the saver now sees it (the viewer route's payload, without `frame`). */
  artifact: ArtifactViewerData;
  /** False when the attachment was already saved: the existing Artifact. */
  created: boolean;
}

export interface ArtifactWebImportInput {
  /** The old link, `https://raft-artifacts.com/p/<server>/<name>`. */
  from: string;
  /** The new Artifact's home (a thread: its conversation). Absent: the whole server. */
  conversationId?: ChannelId;
}

export interface ArtifactWebImported {
  /** The imported Artifact at its current version, as the reader sees it. */
  card: ArtifactCard;
  /** False when it was imported before and that Artifact still stands: the existing one. */
  created: boolean;
  /** The old link, canonical. */
  from: string;
}

/**
 * How many members of a conversation couldn't see the Artifact if it were
 * sent there now. Counts only, never names. Members are the conversation's
 * people and agents (a thread's: its channel's; a joint channel's: every
 * server's), the reader included. `widenTo` lists the larger homes the
 * reader may move it to now (the home route's rule: its author, an agent
 * author's manager, the server's owners and admins, none a guest; the name
 * free there) that would let some of them see it, narrowest first: `server`
 * when it reaches any of them, `public` only when it reaches some `server`
 * doesn't (guests, other servers' members). Empty when the reader may not
 * move it or no larger home would help. A conversation is never offered: it
 * is never larger than another home (moving to it is a narrowing, the home
 * route's).
 *
 * `widenRefused` (#77): the larger homes that would let some of them see it
 * (the same test as `widenTo`'s, against those a home offered in `widenTo`
 * doesn't reach) but that the reader may not move it to now, narrowest
 * first, each with why, so the dialog can say it instead of offering
 * nothing. Never a home in `widenTo`.
 */
export interface ArtifactWebShareAudience {
  members: number;
  cannotSee: number;
  /** Guests among `cannotSee`: a server home never reaches them (D4); only public does. */
  guestsCannotSee: number;
  /**
   * Set when the conversation is too large to count exactly within the
   * request's budget (more than ARTIFACT_SHARE_AUDIENCE_MAX_COUNTED
   * members): `cannotSee` (and `guestsCannotSee`) count only that many of
   * them and are then a lower bound, shown as "500+" (Tenny,
   * #proj-workspace:ee8634e1 695de3a7). `members` is still exact.
   */
  capped?: boolean;
  widenTo: Array<"server" | "public">;
  /** Absent only from a server that predates it. */
  widenRefused?: ArtifactWebWidenRefusal[];
}

/**
 * Why a larger home isn't offered (ArtifactWebShareAudience.widenRefused):
 * `forbidden`, the reader may not move it (not its author, an agent author's
 * manager or one of the server's owners and admins, or a guest), with no
 * more said; `name_taken`, another Artifact of that home has its name
 * (`name`, which the reader sees already: it is this Artifact's).
 */
export type ArtifactWebWidenRefusal =
  | { to: "server" | "public"; reason: "forbidden" }
  | { to: "server" | "public"; reason: "name_taken"; name: string };

/** At most this many members are checked for ArtifactWebShareAudience; past it the counts are `capped`. */
export const ARTIFACT_SHARE_AUDIENCE_MAX_COUNTED = 500;

/**
 * Send the Artifact to a conversation as a message with an optional note
 * (F29). `widenTo` (one of share-audience's `widenTo`) first moves it to that
 * larger home (audited, the home route's rule and code), then sends;
 * without it, members who can't see it get a link they can't open (F21
 * "send anyway").
 */
export interface ArtifactWebShareInput {
  /** A channel or DM the sender can post in (not a thread: name it by `threadRootId`). */
  conversationId: ChannelId;
  /** Post into this thread of the conversation instead (its root message; its audience is the conversation's). */
  threadRootId: MessageId | null;
  /**
   * Up to ARTIFACT_SHARE_NOTE_MAX_CHARS characters; longer → FIELD_TOO_LONG
   * { field: "note", limit }. Plain text: `@name` in it mentions no one.
   */
  note: string | null;
  widenTo: "server" | "public" | null;
  /**
   * One per send attempt, chosen by the client (1 to 64 of `A-Z a-z 0-9 - _`;
   * a uuid): a retry of the same attempt sends the same key, so it posts
   * the message once (core's idempotent send). A new attempt (another
   * conversation, note or choice) has a new key.
   */
  clientKey: string;
}

export const ARTIFACT_SHARE_NOTE_MAX_CHARS = 1000;

export interface ArtifactWebShared {
  messageId: MessageId;
  /**
   * Set when the share had `widenTo` and this attempt ran it: the home it is
   * in now (that one, or a larger one it already had). Null on a retry that
   * answered an earlier attempt's message: a retry never moves it again.
   */
  home: ArtifactViewerData["card"]["home"] | null;
}

/** At most this many attachment ids in one `attachmentSaves` request. */
export const ARTIFACT_ATTACHMENT_SAVES_MAX_IDS = 50;

/**
 * What the asked attachments were saved as (S5, F7, F23), for this reader.
 * Only attachments the reader can see (their message's conversation, within
 * the plan's history window) that were saved as an Artifact not deleted or
 * revoked are listed; one not saved, not visible, behind the window or not
 * existing is absent, the same for each. `savedAs` is the Artifact's card when the
 * reader can see it; one the reader can't see is `{ status: "unavailable",
 * url }` with no title, so the line never carries the title to someone who
 * can't open it.
 */
export interface ArtifactWebAttachmentSaves {
  saves: Array<{ attachmentId: string; savedAs: ArtifactReference }>;
}

/**
 * One Artifact a search found: the `artifacts` group of core's
 * `GET /api/search` (webSearchContract.ts). Title only for now (xxchan
 * 2026-10-23), so `matches` is the title's (`field: "title"`), as the agent
 * API's list with `query` answers them; empty when the index found the title
 * only through the tokenizer's normalization.
 */
export interface ArtifactSearchHit {
  card: ArtifactCard;
  matches: AgentApiArtifactSearchMatch[];
}

/** Error codes a web Artifacts route can answer with. */
export const ARTIFACT_WEB_ERROR_CODES = [
  "ARTIFACTS_NOT_ENABLED",
  "NOT_VISIBLE",
  "VERSION_NOT_FOUND",
  "FILE_NOT_FOUND",
  "INVALID_PATH",
  "FORBIDDEN",
  // A rename of an Artifact that is a channel's announcement (channel_announcement_v0) by a person
  // without editChannelMetadata on that channel. details: { channel, title }.
  "CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN",
  "HOME_NOT_WIDER",
  // `home` to a smaller home that isn't smaller (a conversation to a conversation), and its preview.
  "HOME_NOT_NARROWER",
  // `home` to a smaller home its author (or an agent author, not in the conversation) wouldn't see.
  "AUTHOR_LOSES_ACCESS",
  // `home` to a smaller home with `expectedLost`, when a different number would lose it now.
  "LOSS_CHANGED",
  // `home` (and its preview) to a conversation other than the Artifact's original one (#75).
  "NOT_ORIGINAL_HOME",
  // `unpublish` of an Artifact whose home isn't public.
  "NOT_PUBLIC",
  "NAME_TAKEN",
  "COMMENT_NOT_FOUND",
  // `commentResolve` / `commentReopen` (#249) of a reply: only a thread (its root) is resolved.
  "COMMENT_IS_REPLY",
  "MENTION_NOT_VISIBLE",
  "FIELD_TOO_LONG",
  "ATTACHMENT_NOT_FOUND",
  "TARGET_NOT_FOUND",
  "ALREADY_SAVED",
  "ATTACHMENT_NOT_SAVABLE",
  "TOO_MANY_MENTIONS",
  // Review drafts and submitting a review (S8).
  "DRAFT_NOT_FOUND",
  "DRAFT_LIMIT",
  "NO_DRAFTS",
  "DRAFTS_CHANGED",
  "CLIENT_KEY_REUSED",
  // Importing from the standalone app (raft-artifacts.com).
  "INVALID_NAME",
  "ARTIFACTS_STORAGE_UNAVAILABLE",
  "IMPORT_UNAVAILABLE",
  "NOT_A_LEGACY_LINK",
  "LEGACY_OTHER_SERVER",
  "LEGACY_NOT_FOUND",
  "IMPORT_TOO_LARGE",
  // 403: the files an import would copy, the attachment a save would, or a
  // comment image, don't fit in the server's monthly file upload quota (the
  // attachments' one); nothing imported, saved or uploaded.
  "FILE_UPLOAD_QUOTA_EXCEEDED",
  // Comment images: an upload the Server won't keep (`commentImages`), and a
  // comment or draft naming an image that isn't the reader's own unused
  // upload to this Artifact (one answer for every reason; nothing written).
  "IMAGE_REFUSED",
  "IMAGE_NOT_FOUND",
  "IMPORT_MISMATCH",
  "ALREADY_IMPORTED",
  "TARGET_NOT_SUPPORTED",
  "TARGET_HAS_GUESTS",
  // The frame route (S2).
  "NOT_FRAMED",
  "CONTENT_UNAVAILABLE",
  "INVALID_REQUEST",
  // `downloadZip`: the version's files are over the archive's limit (413), or
  // too many archives are being built at once on this server process (429,
  // with Retry-After; not a per-user limit).
  "DOWNLOAD_TOO_LARGE",
  "BUSY",
  // 429, per user: the frame route, the viewer and open (each signs a
  // ticket) 120 a minute together; the writes (comment
  // POST, PATCH and DELETE, a thread's resolve and reopen, review drafts POST, PATCH and DELETE, review
  // submit, subscription PUT and DELETE, home and unpublish POST, title PATCH, the
  // Artifact's DELETE, import, save-attachment, share) 60 a minute together;
  // comment image uploads 30 a minute;
  // mention candidates 300 a minute; the dashboard (its All tab and its authors included)
  // and a conversation's Artifacts 120 a minute together; attachment saves, share audiences and
  // home-change previews 300 a minute each; locate 120 a minute; open in
  // the frame route's and the viewer's 120; a version's zip 20 a minute.
  "RATE_LIMITED",
] as const;
export type ArtifactWebErrorCode = (typeof ARTIFACT_WEB_ERROR_CODES)[number];

/**
 * `details` of the error codes that carry any. MENTION_NOT_VISIBLE names the
 * mentioned actors who can't see the Artifact, so the box can mark exactly
 * those mentions.
 */
export interface ArtifactWebErrorDetails {
  /** Only from `locate`: the server the reader sees it from, where Artifacts are off. Every other route answers it without details. */
  ARTIFACTS_NOT_ENABLED: { serverSlug: string };
  MENTION_NOT_VISIBLE: { actors: Array<{ type: "user" | "agent"; id: string }> };
  /** The root comment of the reply's thread: resolve or reopen that one. */
  COMMENT_IS_REPLY: { thread: ArtifactCommentId };
  /** Left out by the frame route when either number is unknown (no current version). */
  VERSION_NOT_FOUND: { version: number; currentVersion: number };
  FILE_NOT_FOUND: { path: string; version: number };
  INVALID_PATH: { path: string };
  /** `to: "conversation"`: a narrowing without `expectedLost`. */
  HOME_NOT_WIDER: { home: "conversation" | "server" | "public"; to: "server" | "public" | "conversation" };
  HOME_NOT_NARROWER: { home: "conversation" | "server" | "public"; to: "server" | "conversation" };
  /** `cannot_see`: its author couldn't see it in the new home; `agent_not_member`: an agent author isn't in the conversation. */
  AUTHOR_LOSES_ACCESS: { reason: "cannot_see" | "agent_not_member" };
  /** `actual`: people + agents losing it now, counted as the preview counts (`capped`: a lower bound). */
  LOSS_CHANGED: { expected: number; actual: number; capped: boolean };
  /**
   * The original conversation, the only one a narrowing may name (#75):
   * null when it has none, it no longer exists, or the mover can't see it
   * (ArtifactViewerData.originalHome's rule).
   */
  NOT_ORIGINAL_HOME: { originalConversationId: ChannelId | null };
  /** An import adds the Artifact that has the name (`existing`). */
  NAME_TAKEN: { name: string; existing?: { id: string; url: string } };
  IMPORT_UNAVAILABLE: { reason: "not_configured" | "unreachable" | "bad_answer" | "rate_limited" | "timeout" };
  NOT_A_LEGACY_LINK: { from: string; reason: "not_a_link" | "host" | "legacy_version_link" | "unrecognised" };
  LEGACY_OTHER_SERVER: { server: string };
  LEGACY_NOT_FOUND: { server: string; name: string };
  IMPORT_TOO_LARGE:
    | { reason: "files"; count: number; limit: number }
    | { reason: "file"; path: string; size: number; limit: number }
    | { reason: "quota"; used: number; needed: number; limit: number };
  /** As the agent API's: the bytes asked for, the month's quota (`usedBytes`, `limitBytes`, …) and where to upgrade. */
  FILE_UPLOAD_QUOTA_EXCEEDED: { requestedBytes: number; quota: Record<string, unknown>; billingUrl: string };
  IMPORT_MISMATCH: { path: string; reason: "sha256" | "size" };
  ALREADY_IMPORTED: { server: string; name: string };
  /** `thread`: a thread (or task conversation) named as a home (the home route; import takes a thread as its conversation). */
  TARGET_NOT_SUPPORTED: { conversationId: string; reason: "joint" | "thread" };
  /** A guest of the server is in the conversation, or guests may read it without joining. */
  TARGET_HAS_GUESTS: { conversationId: string; reason: "guest_members" | "open_to_guests" };
  FIELD_TOO_LONG: { field: string; limit: number };
  /** `limit`: the most bytes of files one archive holds. */
  DOWNLOAD_TOO_LARGE: { limit: number };
  /** An attachment the viewer can't see, or that doesn't exist: one answer for both. */
  ATTACHMENT_NOT_FOUND: { attachmentId: string };
  /** A conversation (or thread in it) the viewer can't see or post in, or that doesn't exist. */
  TARGET_NOT_FOUND: { conversationId: string; threadRootId?: string };
  /** Saved before as an Artifact the saver can't see now; no id or title. */
  ALREADY_SAVED: { attachmentId: string };
  ATTACHMENT_NOT_SAVABLE: { attachmentId: string; reason: "too_large" | "uploading"; limit?: number };
  TOO_MANY_MENTIONS: { limit: number };
  DRAFT_LIMIT: { limit: number };
  /**
   * `limit`: OBJECT_FILE_MAX_BYTES for `too_large`, the pixels (width ×
   * height) for `too_many_pixels`; `server_quota_exceeded`: the images of
   * the server the upload is billed to (the uploader's own) are full
   * (`used`, `limit` in bytes); `uploader_quota_exceeded`: the uploader's
   * own share there is (`scope` `drafts`: images unposted or in drafts at
   * once, freed by posting or deleting drafts; `total`: all of theirs;
   * `used`, `limit` in bytes).
   */
  IMAGE_REFUSED: {
    reason: "empty" | "too_large" | "unsupported_type" | "too_many_pixels" | "server_quota_exceeded" | "uploader_quota_exceeded";
    limit?: number;
    used?: number;
    scope?: "drafts" | "total";
  };
  /** The first image id that isn't one (as sent). */
  IMAGE_NOT_FOUND: { fileId: string };
}

/** The payloads the routes above return, for fake data sources. */
export interface ArtifactWebResponses {
  viewer: ArtifactViewerData;
  fileContent: ArtifactWebFileContent;
  comments: ArtifactWebCommentsPage;
  commentCreated: ArtifactWebCommentCreated;
  threadResolution: ArtifactWebThreadResolution;
  willNotify: ArtifactWillNotify;
  mentionCandidates: ArtifactWebMentionCandidates;
  presence: ArtifactPresence;
  saved: ArtifactWebSaved;
  attachmentSaves: ArtifactWebAttachmentSaves;
  shareAudience: ArtifactWebShareAudience;
  homeChange: ArtifactWebHomeChange;
  shared: ArtifactWebShared;
  frame: ArtifactWebFrame;
  dashboard: ArtifactWebDashboard;
  dashboardAll: ArtifactWebDashboardAll;
  dashboardAuthors: ArtifactWebDashboardAuthors;
  dashboardConversations: ArtifactWebDashboardConversations;
  location: ArtifactWebLocation;
  open: ArtifactWebOpen;
  conversationArtifacts: ArtifactWebConversationArtifacts;
  reviewDrafts: ArtifactWebReviewDrafts;
  reviewDraftSaved: ArtifactWebReviewDraftSaved;
  reviewSubmitted: ArtifactReviewSubmitted;
  commentImage: ArtifactCommentImage;
}
