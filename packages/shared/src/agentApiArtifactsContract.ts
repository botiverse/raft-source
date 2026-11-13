// Agent API for Workspace Artifacts (feat/workspace-artifacts, segment S1):
// reading (S1a), publishing (S1b), commenting and following (S1c), moving to
// the whole server and deleting, saving an attachment (S5), submitting a
// review (S8). `/internal/agent-api/artifacts/*`,
// behind the per-server flag workspace_artifacts_v0. Routes are declared in
// the app's own fragment, apps/artifacts/agentApi.ts, which the contract
// (agentApiContract.ts) merges after core's routes.
//
// The Server answers data, and refuses in the Server's refusal envelope
// (refusal.ts, docs/contracts/agent-api-refusals.md): `{ error, code,
// errorCode, next?, suggestedNextAction?, details? }`. `error` is one
// sentence an agent can act on, naming no command; `next` is the step as an
// operation; `code` is one of AGENT_API_ARTIFACT_ERROR_CODES. `details` keeps
// the data released clients read to word the refusal themselves
// (agentText/artifacts.ts formatArtifactError) until they show `error`.
//
// Rules the responses follow:
// - An Artifact the caller can't see, one that doesn't exist, a deleted or a
//   revoked one: the same 404 NOT_VISIBLE with the same body. Nothing tells
//   them apart.
// - Actors are named by handle (`name`), never by user or agent id.
// - "Read position": the Server remembers, per caller and Artifact, how far
//   it has looked (one counter over published versions and comments). Only
//   what returns content to the caller moves it, over what it showed in full:
//   reading the current version (`artifactRead` without `version`), the
//   comments list, a hold (UNSEEN_CHANGES); publishing moves it over the
//   version published, commenting over the caller's own comment. A notice
//   never moves it (it proves nothing was read). Callers never need to send
//   it (`seen` on publish and comment is an optional override).
import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { AGENT_API_ARTIFACT_CHECK_STATUSES } from "./agentApiArtifactChecksContract";
import { ARTIFACT_COMMENT_IMAGE_MAX_BYTES, ARTIFACT_COMMENT_IMAGE_TYPES, ARTIFACT_COMMENT_MAX_CHARS, ARTIFACT_COMMENT_MAX_IMAGES } from "./artifactCommentLimits";

const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const AGENT_API_ARTIFACT_ERROR_CODES = [
  /** 403: workspace_artifacts_v0 is off for the caller's server. No data. */
  "ARTIFACTS_NOT_ENABLED",
  /** 404: no Artifact by that id, title or name that the caller can see (also deleted or revoked). */
  "NOT_VISIBLE",
  /**
   * 400: a link that names no Artifact (an old per-version link, another
   * page's link). Refused by the client before any request (parseArtifactRef):
   * the Server reads any other `:artifact` as an id, a title or a name.
   * details: { artifact }.
   */
  "INVALID_ARTIFACT_REF",
  /**
   * 409: a title (or an old name) that more than one visible Artifact has.
   * The code keeps its old word so clients from before titles read it.
   * details: { ref, candidates: [{ id, title, home }] }.
   */
  "AMBIGUOUS_ARTIFACT_NAME",
  /**
   * 404: a version the Artifact doesn't have, or the caller may not read
   * (also a publish `base` that isn't a published version). details: { version, currentVersion }.
   */
  "VERSION_NOT_FOUND",
  /**
   * 404: the version has no file at that path. details: { path, version }.
   * Publish: a `delete` path the base version doesn't have (400). details: { path, version }.
   */
  "FILE_NOT_FOUND",
  /**
   * 400: a malformed file path, refused before any lookup (Porthole's path
   * rules): empty, a leading, trailing or doubled slash, a `.` or `..`
   * segment, or any of `\ % ? #` or a control or format character. A path
   * still percent-encoded after the URL's own decoding is refused as such.
   * details: { path }.
   */
  "INVALID_PATH",
  /** 404: `target` is not a conversation the caller can see. details: { target }. */
  "TARGET_NOT_FOUND",
  /** 503: the bytes' store is not configured on this Server (or can't mint a download URL). */
  "ARTIFACTS_STORAGE_UNAVAILABLE",
  // ---- publish (S1b) ----
  /**
   * 403: the caller sees the Artifact but may not publish to it, comment on it
   * or follow it (not an agent of its server), or move or delete it (not its
   * author; details: { title, author }), or asked to make it public (only a
   * person may). An agent's move also needs the person who manages the agent
   * to see the Artifact now and to be allowed to move it themselves: details
   * add `reason: "manager_cannot_see"` or `"manager_cannot_move"` with
   * `manager` (that person, by handle) and `target` (the home it is in), or
   * `reason: "no_manager"` (no person manages the agent).
   */
  "FORBIDDEN",
  /**
   * 403: a push to an Artifact that is a channel's announcement
   * (channel_announcement_v0) by an agent without editChannelMetadata on that
   * channel (its owner, a channel admin, or a server owner or admin may).
   * Nothing was pushed. details: { channel (`#name`), title }. Clients from
   * before it show `error` and `suggestedNextAction` as sent.
   */
  "CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN",
  /** 400: a new Artifact without `target` (its home). */
  "TARGET_REQUIRED",
  /**
   * 400: a new Artifact without a `title`, or a blank `title` for any push.
   * Clients read it from the entry page's `<title>` when there is no
   * `title` (agentOps artifactsPublish), and refuse it themselves first.
   */
  "TITLE_REQUIRED",
  /**
   * 400: an import's old name (raft-artifacts.com's) isn't a valid Artifact
   * name here (lowercase letters, digits, inner hyphens, at most 63), or is one
   * of AGENT_API_ARTIFACT_RESERVED_NAMES (`reserved: true`). details: { name, reserved? }.
   */
  "INVALID_NAME",
  /**
   * 409: an Artifact from before titles (or an imported one) keeps its old
   * name, still unique among the live Artifacts of a home that have one; a new
   * Artifact has none. An import: another live Artifact of the home has its
   * name, details: { name, existing: { id, url } } (whoever may put an Artifact
   * into a home sees every Artifact there). A move: another live Artifact of
   * the larger home has its name. details: { name }.
   */
  "NAME_TAKEN",
  /** 400: a new version without `base` (the version the files were made from). details: { currentVersion }. */
  "BASE_REQUIRED",
  /**
   * 409: since `base`, others changed what this request changes: the same
   * files, or the same Artifact-wide setting (entry, title, description).
   * Nothing was published. details: { base, current, overlaps: [{ path,
   * setting, version, author }] } (only the overlapping changes; `current` is
   * the current version's number).
   */
  "BASE_MOVED",
  /**
   * 409: others commented, since the caller last looked, on files this request
   * changes or on the whole Artifact. Nothing was published. details:
   * { unseen: { comments (the newest few, oldest first, shaped as
   * artifactRead's unseen.comments), commentCount, commentsCursor, unread },
   * seen, skipped: { versions, otherComments } } (`seen`: what a caller
   * passing `seen` passes next).
   *
   * The caller's read position now covers the held comments shown in full
   * (an excerpt cut short doesn't count), and stops before the first comment
   * by others not shown in full: one cut short, one older than the few shown,
   * one on another file. `unread` (newer servers): how many of the
   * `commentCount` it leaves unseen. With none, the same request again goes
   * through; otherwise it is held again until the caller reads them in full
   * (artifactComments). Unlike the comments list, the position moves past
   * others' versions in between (what the read of the current version also
   * does): `skipped.versions` counts those, which this answer doesn't show;
   * `skipped.otherComments` is 0 (older servers passed comments on other
   * files too).
   *
   * A comment (S1c, freshness v2 §2.2) is held the same way, by others' new
   * comments on its `path` or on the whole Artifact and by others' new
   * versions that changed its `path`; a comment on the whole Artifact (no
   * `path`) by anything new from others. Its details add `unseen.versions`
   * (the newest few holding versions, oldest first, shaped as artifactRead's
   * unseen.versions) and `unseen.versionCount`; `skipped` counts the versions
   * passed over that didn't hold it.
   */
  "UNSEEN_CHANGES",
  /** 400: a path listed twice, or both listed and deleted. details: { path }. */
  "DUPLICATE_PATH",
  /** 400: the entry file isn't in the resulting version. details: { entry }. */
  "ENTRY_NOT_FOUND",
  /** 400: `content_base64` that isn't base64. details: { path }. */
  "INVALID_CONTENT",
  /** 400: a file's `size` isn't the size of the bytes the Server has for its sha256. details: { path, sha256, size, actual }. */
  "SIZE_MISMATCH",
  /** 400 (upload): the bytes don't hash to `:sha256`. details: { expected, actual }. */
  "SHA256_MISMATCH",
  /** 411 (upload): no Content-Length. */
  "CONTENT_LENGTH_REQUIRED",
  /** 413: one file over its limit (text 16 MiB, binary 15 MiB, inline 10 MiB). details: { path, size, limit }. */
  "FILE_TOO_LARGE",
  /** 413: more files than a request may list or a version may hold. details: { count, limit }. */
  "TOO_MANY_FILES",
  /** 413: the request (inline files together, or the JSON body) over its limit. details: { limit }. */
  "REQUEST_TOO_LARGE",
  /** 400: a text field over its limit (label, note, title, description). details: { field, limit }. */
  "FIELD_TOO_LONG",
  /** 413: the server's uploaded bytes not yet in any version are over the cap. details: { used, limit }. */
  "UPLOAD_QUOTA_EXCEEDED",
  /**
   * 403: new bytes (inline or uploaded, or the files an import would copy)
   * don't fit in the server's monthly file upload quota, the one attachments
   * count against (Free: 100 MB a month). A push's listed files the Server
   * lacks are checked by their declared sizes before it answers `missing`,
   * so it is refused before any upload. Nothing was stored (an import:
   * nothing was imported). The body is the attachments' refusal (error, errorCode,
   * requestedBytes, quota, billingUrl, suggestedNextAction) plus `code`;
   * details: { requestedBytes, quota, billingUrl, upgradeHint? }.
   * `upgradeHint` (a Free server's refusal of a push, a save or a comment
   * image, when the agent's CLI can post an upgrade card in the Artifact's
   * conversation, or the attachment's for a save): the attachments' card
   * offer, a sentence and the `raft action prepare` heredoc, also the
   * `suggestedNextAction`; the CLI shows it as the next action.
   */
  "FILE_UPLOAD_QUOTA_EXCEEDED",
  // ---- comments and following (S1c) ----
  /**
   * 404: `replyTo` is not a comment of this Artifact. details: { replyTo }.
   * Resolving or reopening: no comment of this Artifact by that id. details: { comment }.
   */
  "COMMENT_NOT_FOUND",
  /**
   * 409 (#249): resolving or reopening a reply; only a thread is, by its
   * root comment. details: { comment, thread } (the root's id).
   */
  "COMMENT_IS_REPLY",
  /**
   * 400: an id in a comment's `images` that isn't an image the caller
   * uploaded to this Artifact (artifactCommentImageUpload) and no comment has
   * yet: one answer for every reason. Nothing was written (a review: none of
   * it). details: { fileId } (the first such one, as sent). 404 from
   * artifactCommentImage: no image of this Artifact by that id the caller
   * may read (one answer for every reason). details: { fileId }.
   */
  "IMAGE_NOT_FOUND",
  /**
   * An image upload the Server won't keep; nothing was stored. 422
   * `empty`, `unsupported_type` (not a PNG, JPEG, WebP or GIF by its
   * bytes; never SVG), `too_many_pixels` (details.limit: width × height);
   * 413 `too_large` (details.limit, in bytes, after removing metadata),
   * `server_quota_exceeded` (the images billed to the agent's own server
   * are full: details.used, details.limit) and `uploader_quota_exceeded`
   * (the agent's own share there: details.scope `drafts`, images unposted or
   * in drafts at once, freed by posting or deleting drafts, or `total`; with
   * details.used, details.limit). details: { reason, limit?, used?, scope? }.
   */
  "IMAGE_REFUSED",
  /**
   * 404 from artifactCheckShot: the version's publish check has no such
   * screenshot for the caller (no check, not `done`, that one not taken, or
   * let go: only the newest three checked versions keep theirs; or a server
   * that runs no publish checks): one answer for every reason.
   * details: { shot, version }.
   */
  "SCREENSHOT_NOT_FOUND",
  /** 400: an `anchor` without a `path` (an anchor is a place in one file). */
  "ANCHOR_WITHOUT_PATH",
  /** 400: the body @-mentions more distinct names than AGENT_API_ARTIFACT_MAX_MENTIONS. Nothing was written. details: { limit }. */
  "TOO_MANY_MENTIONS",
  // ---- reviews (S8) ----
  // A review is all or nothing. When one of its comments is refused, the
  // answer is that comment's own code, as `artifactComment` would answer it
  // (FILE_NOT_FOUND, INVALID_PATH, COMMENT_NOT_FOUND, ANCHOR_WITHOUT_PATH,
  // FIELD_TOO_LONG, TOO_MANY_MENTIONS), and its details add `index` (the
  // comment's place in `comments`, 0-based) and `path` (the comment's, null
  // for one on the whole Artifact). Nothing of the review was posted. A
  // refusal of the review itself (its summary, its version, the Artifact)
  // carries no `index`.
  /** 400: a review with more comments than AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS. Nothing was posted. details: { count, limit }. */
  "TOO_MANY_COMMENTS",
  /** 409: a review's `idempotencyKey` was used by this agent on this Artifact for a different review. Nothing was posted. */
  "IDEMPOTENCY_KEY_REUSED",
  /** 404: this Server doesn't take reviews yet (the route is there, its handler isn't). Nothing was posted. */
  "REVIEWS_NOT_AVAILABLE",
  // ---- importing from the standalone app (raft-artifacts.com) ----
  /**
   * 503: importing isn't available: not configured on this Server, the
   * standalone app didn't answer (in time, or with something usable), or the
   * whole import took longer than its deadline (`timeout`). Nothing was
   * imported, and the bytes it had copied are deleted.
   * details: { reason: "not_configured" | "unreachable" | "bad_answer" | "rate_limited" | "timeout" }.
   */
  "IMPORT_UNAVAILABLE",
  /**
   * 400: `from` is not a link to an Artifact of the standalone app
   * (`https://raft-artifacts.com/p/<server>/<name>`); it was never requested.
   * details: { from, reason: "not_a_link" | "host" | "legacy_version_link" | "unrecognised" }.
   */
  "NOT_A_LEGACY_LINK",
  /**
   * 403: the link's server slug is another server's now: its Artifact, or the
   * caller's server's own from before a rename (Raft keeps no slug history,
   * so such a link can't be imported). details: { server }.
   */
  "LEGACY_OTHER_SERVER",
  /** 404: the standalone app has no such Artifact (or it has no version). details: { server, name }. */
  "LEGACY_NOT_FOUND",
  /**
   * 413: the Artifact is larger than an Artifact may be here, found before any
   * file was copied: more files than a version may hold (`files`: { count,
   * limit }), one file over its limit (`file`: { path, size, limit }), or more
   * new bytes than the server's upload cap leaves room for (`quota`: { used,
   * needed, limit }). details: { reason, ... }.
   */
  "IMPORT_TOO_LARGE",
  /**
   * 502: a file the standalone app sent is not what its manifest said (its
   * sha256 or size). Nothing was imported. details: { path, reason: "sha256" | "size" }.
   */
  "IMPORT_MISMATCH",
  /**
   * 409: the Artifact was imported before, as an Artifact the caller can't
   * see (it was moved to a home the caller isn't in). No id or title. details: { server, name }.
   */
  "ALREADY_IMPORTED",
  /** 400: an import's target is a conversation Artifacts can't be imported into yet (a joint channel). details: { target, reason: "joint" }. */
  "TARGET_NOT_SUPPORTED",
  /**
   * 403: an import's target conversation has a guest of the server in it
   * (`guest_members`), or is a channel guests may read without joining
   * (`open_to_guests`). An Artifact on raft-artifacts.com was visible to the
   * server's full members only; a home with guests would widen that. Refused
   * for agents too. details: { target, reason: "guest_members" | "open_to_guests" }.
   */
  "TARGET_HAS_GUESTS",
  // ---- moving and deleting ----
  /**
   * 409: a move to a home that isn't larger than the Artifact's (a home only
   * grows: conversation, then the whole server, then public). Nothing
   * changed. details: { title, home, to }.
   */
  "HOME_NOT_WIDER",
  // ---- saving an attachment (the web's codes, S5) ----
  /**
   * 404: no attachment by that id whose message the caller can see, or its
   * message is behind the plan's history window (a Free server's 30 days):
   * one answer for all. details: { attachmentId }.
   */
  "ATTACHMENT_NOT_FOUND",
  /**
   * 409: the attachment was saved before as a live Artifact the caller can't
   * see. An agent meets it when that Artifact is another server's: in
   * practice the other server of a joint channel, while it has Artifacts off
   * (or the Artifact moved to that server's whole-server home). No id or
   * title. details: { attachmentId }.
   */
  "ALREADY_SAVED",
  /**
   * 422: the attachment can't be an Artifact file: larger than one may be
   * (16 MiB text, 15 MiB binary). details: { attachmentId, reason: "too_large", limit }.
   */
  "ATTACHMENT_NOT_SAVABLE",
  /** 503: the attachment's bytes can't be copied now (Artifacts' or the attachments' storage isn't configured, or can't take them). Nothing was saved. */
  "CONTENT_UNAVAILABLE",
] as const;
export type AgentApiArtifactErrorCode = (typeof AGENT_API_ARTIFACT_ERROR_CODES)[number];

/**
 * Names no Artifact may have: the literal words routes under `/artifacts/`
 * use (agent API: `push`, `uploads`; web: `save-attachment`, and `save`
 * kept free for it; `publish`, the agent API's word before `push`, stays
 * reserved), so `/artifacts/<name>/…` never means a route. New Artifacts
 * have no name; an import refuses an old name that is one (INVALID_NAME).
 */
export const AGENT_API_ARTIFACT_RESERVED_NAMES = ["publish", "push", "uploads", "save", "save-attachment"] as const;

/** Artifacts per `artifactList` page. */
export const AGENT_API_ARTIFACT_LIST_DEFAULT_LIMIT = 20;
export const AGENT_API_ARTIFACT_LIST_MAX_LIMIT = 50;
/** `artifactList` with `query`: the longest query, in characters (Unicode code points). */
export const AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS = 200;
/** `artifactList` with `query`: the most `matches` one Artifact carries. */
export const AGENT_API_ARTIFACT_SEARCH_MATCHES_MAX = 3;
/** `artifactList` with `query`: the longest `snippet`, in characters (Unicode code points). */
export const AGENT_API_ARTIFACT_SEARCH_SNIPPET_CHARS = 160;
/** Comments per `artifactComments` page. */
export const AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT = 50;
/** `artifactRead`: the newest versions listed, and the newest unseen versions and comments shown. */
export const AGENT_API_ARTIFACT_READ_VERSIONS_SHOWN = 3;
export const AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN = 5;
/** `artifactRead`: an unseen comment's excerpt, in characters. */
export const AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS = 300;
/** `artifactFileContent`: a text file's content is cut at this many UTF-8 bytes (`truncated: true`). */
export const AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES = 256 * 1024;
/** `artifactFileContent`: lifetime of a binary file's `downloadUrl`. */
export const AGENT_API_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS = 300;

// Publish limits (Raft Artifacts' src/files.ts).
const MiB = 1024 * 1024;
/** Paths one publish may list (files and deletes together). */
export const AGENT_API_ARTIFACT_MAX_FILES_PER_REQUEST = 255;
/** Files one version may hold. */
export const AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION = 500;
/** One file: text (pages, scripts, styles, data, SVG; artifactFileType's `text`) and binary. */
export const AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES = 16 * MiB;
export const AGENT_API_ARTIFACT_MAX_BINARY_FILE_BYTES = 15 * MiB;
/** One file sent inline (`content` / `content_base64`), and all inline files of one request. Larger: upload. */
export const AGENT_API_ARTIFACT_MAX_INLINE_FILE_BYTES = 10 * MiB;
export const AGENT_API_ARTIFACT_MAX_INLINE_REQUEST_BYTES = 24 * MiB;
/**
 * The publish route's JSON body: the inline cap as base64 (4/3) plus room for
 * the manifest. Over it: 413 REQUEST_TOO_LARGE before anything is read.
 */
export const AGENT_API_ARTIFACT_PUBLISH_MAX_BODY_BYTES = Math.ceil(AGENT_API_ARTIFACT_MAX_INLINE_REQUEST_BYTES * 4 / 3) + 1 * MiB;
export const AGENT_API_ARTIFACT_MAX_LABEL_CHARS = 60;
export const AGENT_API_ARTIFACT_MAX_NOTE_CHARS = 500;
export const AGENT_API_ARTIFACT_MAX_TITLE_CHARS = 300;
export const AGENT_API_ARTIFACT_MAX_DESCRIPTION_CHARS = 1000;
/** Uploaded bytes a server may hold that no version uses yet (they are removed after a day). */
export const AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES = 1024 * MiB;
/**
 * How long one import from raft-artifacts.com may take in all (the manifest
 * and every file); past it, 503 IMPORT_UNAVAILABLE `timeout` and the bytes it
 * copied are deleted.
 */
export const AGENT_API_ARTIFACT_IMPORT_DEADLINE_MS = 5 * 60 * 1000;

// Comment limits (Raft Artifacts' addComment).
/**
 * A comment's body, in characters (Unicode code points), after trimming. Over
 * it: FIELD_TOO_LONG (field `body`). One limit with the web API's
 * (ARTIFACT_COMMENT_MAX_CHARS), so the two can't drift.
 */
export const AGENT_API_ARTIFACT_MAX_COMMENT_CHARS = ARTIFACT_COMMENT_MAX_CHARS;
/** A comment's anchor as JSON, in UTF-8 bytes. Over it: FIELD_TOO_LONG (field `anchor`). */
export const AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES = 4096;
/** The most distinct `@names` one comment may have (as written, oneself included). More: 400 TOO_MANY_MENTIONS. */
export const AGENT_API_ARTIFACT_MAX_MENTIONS = 20;
/**
 * The most comments one review may have (the web's drafts limit per person
 * and Artifact). More: 400 TOO_MANY_COMMENTS. A review's summary has a
 * comment's limits (AGENT_API_ARTIFACT_MAX_COMMENT_CHARS, the mentions).
 */
export const AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS = 50;
/** The most images one comment may carry (the web's limit: ARTIFACT_COMMENT_MAX_IMAGES). */
export const AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES = ARTIFACT_COMMENT_MAX_IMAGES;
/** One comment image's bytes, at most (the web's limit: ARTIFACT_COMMENT_IMAGE_MAX_BYTES). */
export const AGENT_API_ARTIFACT_MAX_COMMENT_IMAGE_BYTES = ARTIFACT_COMMENT_IMAGE_MAX_BYTES;

const isoSchema = lazySchema("agentApiArtifactIsoSchema", () => z.string().datetime());
const kindSchema = lazySchema("agentApiArtifactKindSchema", () => z.enum(["html", "markdown", "text", "csv", "image", "pdf", "video", "other"]));
const versionQuerySchema = lazySchema("agentApiArtifactVersionQuerySchema", () => z.string().regex(/^[1-9]\d{0,8}$/).optional());

/** A person or agent, by handle. `name` is null when they no longer resolve (a deleted agent). */
export const agentApiArtifactActorSchema = lazySchema("agentApiArtifactActorSchema", () => passthroughObject({
  type: z.enum(["user", "agent"]),
  name: z.string().nullable(),
}));

/**
 * Where the Artifact lives, which decides who can see it. A conversation home
 * carries its agent-facing `target` (`#channel`, `dm:@peer`); null when the
 * caller has no ref for it (its channel was deleted: an orphan). `id` is
 * null once the deleted channel's row is gone too (an orphan of a hard delete).
 */
export const agentApiArtifactHomeSchema = lazySchema("agentApiArtifactHomeSchema", () => z.discriminatedUnion("kind", [
  passthroughObject({
    kind: z.literal("conversation"),
    conversation: passthroughObject({
      id: z.string().nullable(),
      type: z.enum(["channel", "private", "dm", "joint"]).nullable(),
      target: z.string().nullable(),
    }),
  }),
  /** `serverName`: the server's name ("Everyone in <serverName>"); absent when it can't be found. */
  passthroughObject({ kind: z.literal("server"), serverName: z.string().optional() }),
  passthroughObject({ kind: z.literal("public") }),
]));

export const agentApiArtifactSummarySchema = lazySchema("agentApiArtifactSummarySchema", () => passthroughObject({
  id: z.string(),
  /** https://app.raft.build/artifacts/<id> (the app's origin on other deployments). */
  url: z.string(),
  /**
   * Deprecated: Artifacts have no names any more (an id and a title). The
   * Server still sends the old name, or the short id for an Artifact without
   * one, because CLIs before titles require the field (and pull into
   * `./<name>`). Clients don't read it. Remove once the Server's
   * ARTIFACTS_MIN_CLI_VERSION (cliFloor.ts) is a CLI that doesn't require it.
   */
  name: z.string().optional(),
  title: z.string(),
  description: z.string().nullable(),
  /** The current version's entry file's kind; null before the first version. */
  kind: kindSchema.nullable(),
  home: agentApiArtifactHomeSchema,
  /** Null before the first version. */
  currentVersion: z.number().int().nullable(),
  author: agentApiArtifactActorSchema,
  createdAt: isoSchema,
  updatedAt: isoSchema,
}));

export const agentApiArtifactVersionSummarySchema = lazySchema("agentApiArtifactVersionSummarySchema", () => passthroughObject({
  number: z.number().int(),
  publisher: agentApiArtifactActorSchema,
  createdAt: isoSchema,
  note: z.string().nullable(),
  /** Files added, changed or removed against the version before (all files for v1). */
  changedPaths: z.array(z.string()),
}));

export const agentApiArtifactFileSchema = lazySchema("agentApiArtifactFileSchema", () => passthroughObject({
  path: z.string(),
  sizeBytes: z.number().int(),
  kind: kindSchema,
  entry: z.boolean(),
}));

/**
 * A place in one file, in the attachment-comment anchor format (RFC 036, e.g.
 * `html-region`). Stored and returned as given; the Server checks only its
 * shape and size.
 */
export const agentApiArtifactCommentAnchorSchema = lazySchema("agentApiArtifactCommentAnchorSchema", () => passthroughObject({
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
}));

export const agentApiArtifactCommentExcerptSchema = lazySchema("agentApiArtifactCommentExcerptSchema", () => passthroughObject({
  id: z.string(),
  author: agentApiArtifactActorSchema,
  /** The version it was written on. */
  version: z.number().int(),
  /** The file it is on; null for the Artifact as a whole. */
  path: z.string().nullable(),
  createdAt: isoSchema,
  /** The body's first AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS characters (Unicode code points). */
  excerpt: z.string(),
  truncated: z.boolean(),
  /** The whole body's length, in the same unit as the excerpt is cut in. */
  bodyChars: z.number().int(),
  /**
   * Where in the file (the comment anchor as stored, as artifactComments'
   * comments carry it); null for the whole file or Artifact. Absent from
   * Servers before it.
   */
  anchor: agentApiArtifactCommentAnchorSchema.nullable().optional(),
  /** How many images the comment carries (artifactComments lists them); absent when none, and from Servers before images. */
  imageCount: z.number().int().positive().optional(),
}));

// ---- GET /artifacts ---------------------------------------------------------

export const agentApiArtifactListQuerySchema = lazySchema("agentApiArtifactListQuerySchema", () => passthroughObject({
  /** A conversation (`#channel`, `dm:@peer`; a thread target means its parent): only Artifacts homed there. */
  target: z.string().trim().min(1).optional(),
  /**
   * Search: only Artifacts whose title has every word of it (title only for
   * now), most relevant first, each with its `matches`. Words as the message
   * search splits them (Chinese segmented); a Chinese word of two or three
   * characters may be part of a longer word in the title (the index side's
   * dictionary sub-words), and ASCII words of three or more letters or digits
   * also match as prefixes. Combines with `target`. A cursor belongs to its
   * query.
   */
  query: z.string().trim().min(1)
    .refine((value) => Array.from(value).length <= AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS, { message: `query is longer than ${AGENT_API_ARTIFACT_SEARCH_QUERY_MAX_CHARS} characters: use fewer words` })
    .optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
}));

/**
 * Where a search query matched one Artifact. `snippet`: the text around the
 * match (whitespace collapsed), at most AGENT_API_ARTIFACT_SEARCH_SNIPPET_CHARS
 * characters; `highlights`: the matched words in it. Lengths and offsets are
 * in Unicode code points (not UTF-16 units). Only the title is searched for
 * now, so `field` is always `title` today; the other values stay in the enum
 * for when more is searched (`path`: the file, for `path` and `content`), and
 * clients should skip fields they don't know.
 */
export const agentApiArtifactSearchMatchSchema = lazySchema("agentApiArtifactSearchMatchSchema", () => passthroughObject({
  field: z.enum(["title", "name", "description", "path", "content"]),
  path: z.string().optional(),
  snippet: z.string(),
  highlights: z.array(passthroughObject({ start: z.number().int().nonnegative(), length: z.number().int().positive() })),
}));

/** A listed Artifact; `matches` (at most AGENT_API_ARTIFACT_SEARCH_MATCHES_MAX) only with `query`. */
export const agentApiArtifactListItemSchema = lazySchema("agentApiArtifactListItemSchema", () => agentApiArtifactSummarySchema.extend({
  matches: z.array(agentApiArtifactSearchMatchSchema).max(AGENT_API_ARTIFACT_SEARCH_MATCHES_MAX).optional(),
}));

/** The conversation a `target` resolved to; `homeFromThread` is the thread short id when the target was a thread. */
export const agentApiArtifactTargetEchoSchema = lazySchema("agentApiArtifactTargetEchoSchema", () => passthroughObject({
  target: z.string(),
  conversationId: z.string(),
  homeFromThread: z.string().nullable(),
}));

export const agentApiArtifactListResponseSchema = lazySchema("agentApiArtifactListResponseSchema", () => passthroughObject({
  /** Most recently updated first; with `query`, most relevant first. */
  artifacts: z.array(agentApiArtifactListItemSchema),
  nextCursor: z.string().nullable(),
  target: agentApiArtifactTargetEchoSchema.nullable(),
}));

// ---- GET /artifacts/:artifact -----------------------------------------------

export const agentApiArtifactParamsSchema = lazySchema("agentApiArtifactParamsSchema", () => passthroughObject({
  /**
   * The Artifact: its id (`pt_…` or its short id), else its exact title
   * (trimmed, any case), else the old name of one from before titles, among
   * the caller's server's Artifacts and those of its joint channels; a title
   * or name more than one has is 409 AMBIGUOUS_ARTIFACT_NAME. Links are parsed
   * by the client (parseArtifactRef).
   */
  artifact: z.string().trim().min(1),
}));

export const agentApiArtifactReadQuerySchema = lazySchema("agentApiArtifactReadQuerySchema", () => passthroughObject({
  /** A version number; default the current version. Reading an older one does not move the read position. */
  version: versionQuerySchema,
}));

export const agentApiArtifactReadResponseSchema = lazySchema("agentApiArtifactReadResponseSchema", () => passthroughObject({
  artifact: agentApiArtifactSummarySchema,
  /** The version shown (the current one unless `version` was given); null before the first version. */
  version: passthroughObject({
    number: z.number().int(),
    current: z.boolean(),
    entry: z.string(),
    label: z.string().nullable(),
    note: z.string().nullable(),
    publisher: agentApiArtifactActorSchema,
    createdAt: isoSchema,
    sizeBytes: z.number().int(),
    files: z.array(agentApiArtifactFileSchema),
  }).nullable(),
  /** The newest AGENT_API_ARTIFACT_READ_VERSIONS_SHOWN versions (newest first) and how many the caller may read. */
  versions: passthroughObject({
    total: z.number().int(),
    latest: z.array(agentApiArtifactVersionSummarySchema),
  }),
  /**
   * What others added since the caller last looked; null when an older
   * version was read. Counts are totals; the lists hold the newest few,
   * oldest first. `firstRead`: the caller had never looked (everything counts).
   */
  unseen: passthroughObject({
    firstRead: z.boolean(),
    versionCount: z.number().int(),
    commentCount: z.number().int(),
    versions: z.array(agentApiArtifactVersionSummarySchema),
    comments: z.array(agentApiArtifactCommentExcerptSchema),
    /**
     * When there are more unseen comments than `comments` shows: the cursor
     * for `artifactComments` with `all=1` that starts at the first unseen
     * comment (oldest first). Null otherwise.
     */
    commentsCursor: z.string().nullable(),
    /**
     * Of `commentCount`, how many this read leaves unseen (newer servers):
     * the read position moves over others' versions and the comments shown
     * in full, and stops before the first one not shown in full (cut short,
     * or older than the few shown). A publish they hold stays held until
     * the caller reads them in full (artifactComments).
     */
    unread: z.number().int().optional(),
  }).nullable(),
  /**
   * The Artifact's original message: the one through which it entered a
   * conversation, set once and never moved (`attachment`: saved from that
   * message's attachment; `share`: the message its first share posted;
   * `link`: later). `target` is the conversation as `raft` takes it, from
   * the caller's side: `#channel`, `dm:@peer`, and for a reply in a thread
   * the thread's (`#channel:<root short id>`); `messageId` the full id. Null
   * when it has none, the message is deleted, or the caller can't read that
   * message now (its conversation, the plan's history window), whatever the
   * Artifact's home. Absent from Servers before it.
   */
  origin: passthroughObject({
    target: z.string(),
    messageId: z.string(),
    via: z.enum(["attachment", "share", "link"]),
  }).nullable().optional(),
  /**
   * Whether the caller may push a new version of it (an agent of its own
   * server). False for another server's Artifact it reads (a public one, a
   * joint's): a pull of it is a copy to publish as a new Artifact, if at all.
   * Absent from Servers before it (read as true).
   */
  mayPush: z.boolean().optional(),
  /** Who has it open now. Not computed yet: always empty, so the shape is stable. */
  viewing: z.array(passthroughObject({
    actor: agentApiArtifactActorSchema,
    state: z.enum(["viewing", "reading", "writing"]),
    path: z.string().nullable(),
    since: isoSchema,
  })),
}));

// ---- GET /artifacts/:artifact/files/:path(/content) -------------------------

export const agentApiArtifactFileParamsSchema = lazySchema("agentApiArtifactFileParamsSchema", () => passthroughObject({
  artifact: z.string().trim().min(1),
  /** The file's path in the version, as one percent-encoded segment (`assets%2Flogo.png`). */
  path: z.string().min(1),
}));

export const agentApiArtifactFileQuerySchema = lazySchema("agentApiArtifactFileQuerySchema", () => passthroughObject({
  version: versionQuerySchema,
}));

/**
 * One file as JSON, for callers that can only take JSON: a text file's
 * content (cut at AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES), or a binary
 * file's short-lived download URL (a bearer capability: never log it).
 */
export const agentApiArtifactFileContentResponseSchema = lazySchema("agentApiArtifactFileContentResponseSchema", () => z.discriminatedUnion("kind", [
  passthroughObject({
    kind: z.literal("text"),
    path: z.string(),
    version: z.number().int(),
    size: z.number().int(),
    contentType: z.string(),
    encoding: z.literal("utf8"),
    content: z.string(),
    truncated: z.boolean(),
  }),
  passthroughObject({
    kind: z.literal("binary"),
    path: z.string(),
    version: z.number().int(),
    size: z.number().int(),
    contentType: z.string(),
    downloadUrl: z.string(),
    expiresAt: isoSchema,
  }),
]));

// ---- GET /artifacts/:artifact/comments --------------------------------------

export const agentApiArtifactCommentsQuerySchema = lazySchema("agentApiArtifactCommentsQuerySchema", () => passthroughObject({
  /** Only comments on this file. */
  path: z.string().min(1).optional(),
  /** "1": every comment (paged), not only the ones since the caller last looked. */
  all: z.enum(["1", "true"]).optional(),
  cursor: z.string().trim().min(1).optional(),
  /**
   * Only this review's comments (its id), every one of them in the
   * order they were submitted, as with `all` (the view is `all`); with `path`,
   * only those on that file. An id that isn't a review of this Artifact
   * lists nothing.
   */
  review: z.string().trim().min(1).optional(),
}));

/**
 * An image a comment carries: what the Server kept (its type and pixel size
 * from the bytes, never the uploader's word; metadata removed). Its bytes:
 * artifactCommentImage with `fileId`. The upload's answer
 * (artifactCommentImageUpload) has the same shape.
 */
export const agentApiArtifactCommentImageSchema = lazySchema("agentApiArtifactCommentImageSchema", () => passthroughObject({
  fileId: z.string(),
  contentType: z.enum(ARTIFACT_COMMENT_IMAGE_TYPES),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}));

export const agentApiArtifactCommentSchema = lazySchema("agentApiArtifactCommentSchema", () => passthroughObject({
  id: z.string(),
  author: agentApiArtifactActorSchema,
  version: z.number().int(),
  path: z.string().nullable(),
  /** Where in the file (the comment anchor as stored); null for the whole file or Artifact. */
  anchor: agentApiArtifactCommentAnchorSchema.nullable(),
  replyTo: z.string().nullable(),
  body: z.string(),
  createdAt: isoSchema,
  editedAt: isoSchema.nullable(),
  /** The id of the review it was submitted in, null for a single comment. Absent from Servers before S8. */
  reviewId: z.string().nullable().optional(),
  /** Its images, in order; absent when it has none (and from Servers before images). `body` may then be empty. */
  images: z.array(agentApiArtifactCommentImageSchema).optional(),
  /**
   * A thread's resolution (#249): when and by whom its root was resolved
   * (artifactCommentResolve); null while the thread is open, and always null
   * on a reply (only a thread is resolved). A reply in a resolved thread
   * reopens it. Absent from Servers before resolving.
   */
  resolvedAt: isoSchema.nullable().optional(),
  resolvedBy: agentApiArtifactActorSchema.nullable().optional(),
}));

/** A review (S8): several comments posted together, with an optional summary. */
export const agentApiArtifactReviewSchema = lazySchema("agentApiArtifactReviewSchema", () => passthroughObject({
  /** Its id (ArtifactReviewId); each of its comments carries it as `reviewId`, and `artifactComments` with `review` lists them. */
  id: z.string(),
  author: agentApiArtifactActorSchema,
  version: z.number().int(),
  /** The summary, in full; null without one. */
  body: z.string().nullable(),
  createdAt: isoSchema,
}));

/**
 * The Artifact a comment, a subscription or a delete answer is about.
 * `name`: deprecated, as agentApiArtifactSummarySchema's (sent for CLIs before titles).
 */
const agentApiArtifactRefSchema = lazySchema("agentApiArtifactRefSchema", () => passthroughObject({
  id: z.string(),
  name: z.string().optional(),
  title: z.string(),
  currentVersion: z.number().int().nullable(),
}));

export const agentApiArtifactCommentsResponseSchema = lazySchema("agentApiArtifactCommentsResponseSchema", () => passthroughObject({
  artifact: agentApiArtifactRefSchema,
  /** `unseen`: since the caller last looked (the default); `all`: every comment. */
  view: z.enum(["unseen", "all"]),
  path: z.string().nullable(),
  /**
   * The review the list is limited to (the query's `review`), with its
   * summary, else null (also when it isn't a review of this Artifact: the
   * list is then empty). Absent from Servers before S8.
   */
  review: agentApiArtifactReviewSchema.nullable().optional(),
  /** Oldest first, full text. */
  comments: z.array(agentApiArtifactCommentSchema),
  /**
   * More comments after this page: pass it as `cursor` (same view and path).
   * A cursor is a position: the page holds the comments after it, oldest first.
   */
  nextCursor: z.string().nullable(),
  /**
   * Versions published since the caller last looked, which this list doesn't
   * show (read the Artifact for them). The unseen view moves the read
   * position past those up to the last comment it shows (as a hold does), so
   * listing the comments in full clears what holds a publish; older Servers
   * stopped before the first of them.
   */
  unseenVersionCount: z.number().int(),
}));

// ---- POST /artifacts/push ----------------------------------------------------

const sha256Schema = lazySchema("agentApiArtifactSha256Schema", () => z.string().regex(/^[0-9a-f]{64}$/));

/**
 * One file of a publish: bytes the Server may already have (`sha256`, `size`;
 * missing ones are uploaded first), UTF-8 text, or base64 bytes. Paths follow
 * isWellFormedArtifactFilePath.
 */
export const agentApiArtifactPublishFileSchema = lazySchema("agentApiArtifactPublishFileSchema", () => z.union([
  z.object({ path: z.string(), sha256: sha256Schema, size: z.number().int().nonnegative() }).strict(),
  z.object({ path: z.string(), content: z.string() }).strict(),
  z.object({ path: z.string(), content_base64: z.string() }).strict(),
]));

/**
 * A new Artifact (no `artifact`; `target` is its home) or a new version of one
 * (`artifact` and `base`). The new version is the base's files with `files`
 * added or replaced and `delete` removed; files not listed carry over.
 * Length limits are checked by the Server (FIELD_TOO_LONG, TOO_MANY_FILES, ...),
 * so the codes carry the limits.
 */
export const agentApiArtifactPublishBodySchema = lazySchema("agentApiArtifactPublishBodySchema", () => passthroughObject({
  /** The Artifact to publish a version of, as agentApiArtifactParamsSchema's `artifact` (id, title or old name). Absent: create one. */
  artifact: z.string().trim().min(1).optional(),
  /** A new Artifact's home: a conversation (`#channel`, `dm:@peer`; a thread target means its parent). */
  target: z.string().trim().min(1).optional(),
  /**
   * Required for a new Artifact (400 TITLE_REQUIRED without one, or blank);
   * one line, trimmed. For a new version: unchanged when absent. A request
   * that changes only the title (the files, entry and description stay as
   * they are) sets it without a new version (`titleChanged`). Artifacts have
   * no `name` any more: one sent by an older client is ignored.
   */
  title: z.string().optional(),
  description: z.string().optional(),
  /** The file the Artifact opens at. Default: the base's; for a new one `index.html`, or the only file. */
  entry: z.string().optional(),
  note: z.string().optional(),
  label: z.string().optional(),
  /** The version number the files were made from (required for a new version). */
  base: z.number().int().positive().optional(),
  /** Look for unseen comments after this position instead of the caller's read position. */
  seen: z.number().int().nonnegative().optional(),
  files: z.array(agentApiArtifactPublishFileSchema),
  /** Paths to remove from the base's files. */
  delete: z.array(z.string()).optional(),
}));

/** Nothing published: the Server lacks these blobs. Upload each (artifactUpload), then send the same publish again. */
export const agentApiArtifactPublishMissingSchema = lazySchema("agentApiArtifactPublishMissingSchema", () => passthroughObject({
  missing: z.array(z.string()),
}));

/** Artifact-wide settings a version can change; a change to one is reported with `path` null. */
export const AGENT_API_ARTIFACT_SETTINGS = ["entry", "title", "description"] as const;
export type AgentApiArtifactSetting = (typeof AGENT_API_ARTIFACT_SETTINGS)[number];

/**
 * A change someone else made in a version after the caller's base: to a file
 * (`path`; added, changed or removed), or to a setting (`path` null,
 * `setting`). Listed as `merged` when the new version took it in, and as
 * BASE_MOVED's `overlaps` when it collides with the request.
 */
export const agentApiArtifactMergedChangeSchema = lazySchema("agentApiArtifactMergedChangeSchema", () => passthroughObject({
  path: z.string().nullable(),
  setting: z.enum(AGENT_API_ARTIFACT_SETTINGS).nullable(),
  version: z.number().int(),
  author: agentApiArtifactActorSchema,
}));

/**
 * Something about the pushed version the push didn't refuse (task #71):
 * `scroll-lock`, a page whose own styles hold it to one screen, so the frame
 * shows its first screen and the reader can't scroll to the rest (Porthole's
 * `lintFiles` rule, P106/P110); `nested-frame`, a page with frames of its own,
 * which never load in Raft's frame; `bundled-library`, a pushed copy of a
 * common library a page may load from a library CDN instead (no `line`).
 * `path` is the file it is about (for scroll-lock the page, or a stylesheet it
 * links), `line` its line; `message` says what it found and what to do.
 * `rule` is a string so a later rule parses in this client too.
 */
export const agentApiArtifactPublishWarningSchema = lazySchema("agentApiArtifactPublishWarningSchema", () => passthroughObject({
  rule: z.string(),
  path: z.string(),
  line: z.number().int().optional(),
  message: z.string(),
}));

/**
 * The publish check of the version the push made (task #130;
 * HTML entries, on a server that runs publish checks). A new version's is
 * the one just recorded: `pending` (Raft opens the version in a headless
 * browser soon; read it with artifactCheck), or `skipped` from the start. A
 * replayed push (`replayed`) answers its version's check as it is now, so any
 * status (`running`, `done`, `failed` too). `skipReason` when `skipped`
 * (`unchanged`: the files are the previous version's, byte for byte;
 * `server_daily_cap`, `platform_daily_cap`; a string, so a later reason
 * parses too). Absent without a check, and from `unchanged` answers (no
 * version was made). See agentApiArtifactChecksContract.ts.
 */
export const agentApiArtifactPushCheckSchema = lazySchema("agentApiArtifactPushCheckSchema", () => passthroughObject({
  id: z.string(),
  status: z.enum(AGENT_API_ARTIFACT_CHECK_STATUSES),
  skipReason: z.string().optional(),
}));

export const agentApiArtifactPublishedSchema = lazySchema("agentApiArtifactPublishedSchema", () => passthroughObject({
  artifact: agentApiArtifactSummarySchema,
  version: passthroughObject({
    number: z.number().int(),
    /** Paths this request added or replaced. */
    filesFromYou: z.array(z.string()),
    /** Paths this request removed. */
    deleted: z.array(z.string()),
    /** The request's base; null for a new Artifact. */
    base: z.number().int().nullable(),
    /** The version this one follows (the current one before it); null for a new Artifact. */
    previous: z.number().int().nullable(),
    /** Others' changes between base and previous that this version carries (none when base was current). */
    merged: z.array(agentApiArtifactMergedChangeSchema),
  }),
  unseen: passthroughObject({
    /** Others' comments on files this request didn't change, since the caller last looked (still unseen: not shown here; older servers marked them seen). */
    otherComments: z.number().int(),
  }),
  /**
   * Who is told about the new version: agents (other than the publisher) that
   * follow the Artifact and were the last to publish a file this version
   * changed or removed (reason `your_file_changed`), and can see it now.
   * Empty for a replayed or unchanged answer, and from Servers before S1c.
   */
  notified: z.array(passthroughObject({ actor: agentApiArtifactActorSchema, reason: z.string() })),
  /**
   * This publish made the caller follow the Artifact for the first time
   * (publishing follows it, unless the caller stopped following it before).
   * Absent from Servers before S1c.
   */
  newlySubscribed: z.boolean().optional(),
  /** The same request had already been published (this is that version); nothing new was written. */
  replayed: z.boolean(),
  /**
   * No new version was written: the current version already is what this
   * request would make (its files, entry and description, and its title, or
   * `titleChanged`). A label or note alone doesn't make a version: a request
   * changing only those is `unchanged` too. `version.number` and `previous`
   * are the current version, `filesFromYou`, `deleted` and `merged` are empty.
   */
  unchanged: z.boolean(),
  /**
   * With `unchanged`: the request changed only the title, and the Artifact
   * now has it (`artifact.title`) without a new version. `from` is the title
   * it had. Absent otherwise, and from Servers before titles replaced names
   * (they published a version for it).
   */
  titleChanged: passthroughObject({ from: z.string() }).optional(),
  /**
   * Found in the new version after the commit, best effort (none when it
   * couldn't be checked in time); the version is published either way.
   * Absent from older Servers, and from replayed or unchanged answers.
   */
  warnings: z.array(agentApiArtifactPublishWarningSchema).optional(),
  /**
   * The new version's publish check, recorded with it. Absent when none was
   * recorded (a kind the shell draws, the flag off), from replayed or
   * unchanged answers (artifactCheck reads a version's check), and from
   * older Servers.
   */
  check: agentApiArtifactPushCheckSchema.optional(),
}));

/** 200 `missing`, or 201 published (200 with `replayed`). */
export const agentApiArtifactPublishResponseSchema = lazySchema("agentApiArtifactPublishResponseSchema", () => z.union([
  agentApiArtifactPublishedSchema,
  agentApiArtifactPublishMissingSchema,
]));

// ---- PUT /artifacts/uploads/:sha256 -------------------------------------------

/**
 * The body is the file's raw bytes (`Content-Type: application/octet-stream`,
 * Content-Length required, at most AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES).
 * The Server checks they hash to `sha256`, keeps them for the caller's server,
 * and answers 204; bytes it already has answer 204 too.
 */
export const agentApiArtifactUploadParamsSchema = lazySchema("agentApiArtifactUploadParamsSchema", () => passthroughObject({
  sha256: sha256Schema,
}));

// ---- POST /artifacts/:artifact/comment-images, GET …/comment-images/:fileId ----

/**
 * The upload's body is one image's raw bytes (`Content-Type:
 * application/octet-stream`, Content-Length required, at most
 * AGENT_API_ARTIFACT_MAX_COMMENT_IMAGE_BYTES). 201: what the Server kept
 * (agentApiArtifactCommentImageSchema); its `fileId` goes in a comment's
 * `images`. Unused for an hour, it is gone.
 */
export const agentApiArtifactCommentImageParamsSchema = lazySchema("agentApiArtifactCommentImageParamsSchema", () => passthroughObject({
  artifact: z.string().trim().min(1),
  /** A comment image's `fileId`. */
  fileId: z.string().trim().min(1),
}));

// ---- POST /artifacts/:artifact/comments ---------------------------------------

/**
 * A comment on a version of the Artifact (default the current one): on one
 * file (`path`, optionally a place in it, `anchor`), or on the whole Artifact
 * (no `path`). A reply (`replyTo`) without `path` is on its parent's file and
 * place. `@name`s in the body are looked up among the people and agents of
 * the Artifact's server; agents among them that can see the Artifact are told
 * at once.
 */
export const agentApiArtifactCommentBodySchema = lazySchema("agentApiArtifactCommentBodySchema", () => passthroughObject({
  /**
   * The comment's text (trimmed; at most AGENT_API_ARTIFACT_MAX_COMMENT_CHARS).
   * Required unless `images` has one: a comment is text, images or both
   * (neither: 400 agent_api_contract_invalid, as an empty body always was).
   */
  body: z.string().trim().optional(),
  path: z.string().min(1).optional(),
  anchor: agentApiArtifactCommentAnchorSchema.optional(),
  /** The version number it is written on; default the current version. */
  version: z.number().int().positive().optional(),
  /** The id of the comment it answers. */
  replyTo: z.string().trim().min(1).optional(),
  /** Look for unseen changes after this position instead of the caller's read position. */
  seen: z.number().int().nonnegative().optional(),
  /**
   * Images it carries, in order: each the `fileId` of an image this agent
   * uploaded to this Artifact (artifactCommentImageUpload) that no comment
   * has yet, else 400 IMAGE_NOT_FOUND and nothing is written. At most
   * AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES.
   */
  images: z.array(z.string().trim().min(1).max(200)).max(AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES).optional(),
}));

export const AGENT_API_ARTIFACT_COMMENT_NOTICE_REASONS = ["mentioned", "subscribed"] as const;
/**
 * A `@name` no notice went to: no person or agent of the Artifact's server
 * has that handle (`unknown_name`), the agent or person can't see the
 * Artifact (`cannot_see`; for people from newer Servers, task #141),
 * or it is a person who can (`not_agent`: a person hears through their
 * Activity, which the agent's text counts as notified).
 * Only names the commenter wrote are reported: followers who can't see the
 * Artifact are left out silently, in neither `notified` nor `notNotified`.
 */
export const AGENT_API_ARTIFACT_NOT_NOTIFIED_REASONS = ["unknown_name", "cannot_see", "not_agent"] as const;

/** 201: the comment as written. */
export const agentApiArtifactCommentCreatedSchema = lazySchema("agentApiArtifactCommentCreatedSchema", () => passthroughObject({
  artifact: agentApiArtifactRefSchema,
  /** Shaped as artifactComments' comments. */
  comment: agentApiArtifactCommentSchema,
  /**
   * Agents that are told about it, at once: mentioned ones (`mentioned`) and
   * the Artifact's other followers (`subscribed`). A mentioned follower is
   * told once, as mentioned. Only agents that can see the Artifact.
   */
  notified: z.array(passthroughObject({ actor: agentApiArtifactActorSchema, reason: z.enum(AGENT_API_ARTIFACT_COMMENT_NOTICE_REASONS) })),
  /** `@name`s that reached no one, as written in the body. Mentioning oneself is neither. */
  notNotified: z.array(passthroughObject({ name: z.string(), reason: z.enum(AGENT_API_ARTIFACT_NOT_NOTIFIED_REASONS) })),
  /**
   * This comment made the caller follow the Artifact for the first time
   * (commenting follows it, unless the caller stopped following it before).
   */
  newlySubscribed: z.boolean(),
}));

// ---- POST /artifacts/:artifact/reviews (S8) -------------------------------------

/**
 * One comment of a review: what `artifactComment` takes, without `version`
 * (the review's) and `seen` (checked once, for the whole review).
 */
export const agentApiArtifactReviewCommentSchema = lazySchema("agentApiArtifactReviewCommentSchema", () => passthroughObject({
  /** The comment's text (trimmed; at most AGENT_API_ARTIFACT_MAX_COMMENT_CHARS); required unless `images` has one. */
  body: z.string().trim().optional(),
  path: z.string().min(1).optional(),
  anchor: agentApiArtifactCommentAnchorSchema.optional(),
  /** The id of the comment it answers (a comment posted before this review). */
  replyTo: z.string().trim().min(1).optional(),
  /** Its images, as artifactComment's `images` (each id once in the whole review). */
  images: z.array(z.string().trim().min(1).max(200)).max(AGENT_API_ARTIFACT_MAX_COMMENT_IMAGES).optional(),
}));

/**
 * A review: several comments on one version of the Artifact (default the
 * current one), posted together or not at all, with an optional summary
 * (`body`). The web builds one from a person's drafts; an agent sends it in
 * this one call (agents have no drafts). Each comment is checked as
 * `artifactComment` checks one; the first refused one refuses the review,
 * with its `index` (see the error codes). Unseen changes are checked once,
 * over every file the review comments on (anything new from others when
 * one of its comments is on the whole Artifact): 409 UNSEEN_CHANGES, and the
 * same request again then goes through unless it left some `unread`.
 *
 * `@name`s in the summary and in the comments are looked up as a comment's
 * are. Every agent told about the review gets one notice for it (an
 * Artifacts notice with `review`), as mentioned when any of it mentions
 * them, else as a follower. Submitting follows the Artifact, as commenting
 * does.
 */
export const agentApiArtifactReviewBodySchema = lazySchema("agentApiArtifactReviewBodySchema", () => passthroughObject({
  /** The summary: what the review says as a whole (trimmed; a comment's limits). */
  body: z.string().trim().min(1).optional(),
  /** The version number the review is on; default the current version. */
  version: z.number().int().positive().optional(),
  /**
   * In the order they are posted (and listed). 1 to
   * AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS; more is 400 TOO_MANY_COMMENTS,
   * checked by the route rather than here so the answer says how many.
   */
  comments: z.array(agentApiArtifactReviewCommentSchema).min(1),
  /** Look for unseen changes after this position instead of the caller's read position. */
  seen: z.number().int().nonnegative().optional(),
  /**
   * Retry key (as message send's): the same key with the same request
   * answers the review it posted (200, nothing posted or told again); the
   * same key with a different request is refused (409
   * IDEMPOTENCY_KEY_REUSED). Scoped to the agent and the Artifact, kept as
   * long as the review.
   */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}));

/** 201: the review as posted (200: the one an `idempotencyKey` posted before; `notified` and `notNotified` then empty). */
export const agentApiArtifactReviewCreatedSchema = lazySchema("agentApiArtifactReviewCreatedSchema", () => passthroughObject({
  artifact: agentApiArtifactRefSchema,
  review: agentApiArtifactReviewSchema,
  /** Its comments as posted, in the request's order, shaped as artifactComments' comments. */
  comments: z.array(agentApiArtifactCommentSchema),
  /**
   * Agents that are told about the review, one notice each: `mentioned` when
   * the summary or any comment mentions them, else `subscribed` (they follow
   * the Artifact). Only agents that can see the Artifact.
   */
  notified: z.array(passthroughObject({ actor: agentApiArtifactActorSchema, reason: z.enum(AGENT_API_ARTIFACT_COMMENT_NOTICE_REASONS) })),
  /** `@name`s that reached no one, as written, each once over the whole review. Mentioning oneself is neither. */
  notNotified: z.array(passthroughObject({ name: z.string(), reason: z.enum(AGENT_API_ARTIFACT_NOT_NOTIFIED_REASONS) })),
  /** This review made the caller follow the Artifact for the first time. */
  newlySubscribed: z.boolean(),
}));

// ---- PUT / DELETE /artifacts/:artifact/subscription ----------------------------

/**
 * Following an Artifact: others' comments on it reach the follower, each as
 * it's posted, and so do others' versions that change a file it was the last
 * to publish.
 * Publishing or commenting follows it, unless the agent stopped following it
 * (DELETE), which sticks until it follows again (PUT). Mentions reach an
 * agent whether it follows or not.
 */
export const agentApiArtifactSubscriptionResponseSchema = lazySchema("agentApiArtifactSubscriptionResponseSchema", () => passthroughObject({
  artifact: agentApiArtifactRefSchema,
  following: z.boolean(),
}));

// ---- POST /artifacts/:artifact/comments/:comment/resolve | reopen (#249) ------

/** A thread, by its root comment's id. */
export const agentApiArtifactCommentParamsSchema = lazySchema("agentApiArtifactCommentParamsSchema", () => passthroughObject({
  artifact: z.string().min(1),
  comment: z.string().min(1),
}));

/**
 * Resolve a thread: by its root comment, on a version the caller can comment
 * on. `note`: posted first as the caller's reply in the thread (checked, held
 * and told as a reply is: `@name`s in it are mentions), e.g. the version that
 * answers it; leave it out for none. At most AGENT_API_ARTIFACT_MAX_COMMENT_CHARS.
 */
export const agentApiArtifactResolveBodySchema = lazySchema("agentApiArtifactResolveBodySchema", () => passthroughObject({
  note: z.string().trim().min(1).optional(),
}));

/**
 * 200: the thread as it stands. `changed` false: it already stood so, and
 * nothing was written (a resolve's note neither). Resolving tells the
 * thread's author when someone else (`notified`: an agent among them); a
 * reopen tells no one.
 */
export const agentApiArtifactThreadResolutionSchema = lazySchema("agentApiArtifactThreadResolutionSchema", () => passthroughObject({
  artifact: agentApiArtifactRefSchema,
  /** The thread's root comment, with `resolvedAt` / `resolvedBy`. */
  comment: agentApiArtifactCommentSchema,
  /** The note posted as a reply, null without one (always null for a reopen). */
  note: agentApiArtifactCommentSchema.nullable(),
  changed: z.boolean(),
  /** Agents told: the thread's author (`resolved`) and, for a note, its mentions and the Artifact's other followers, as a reply's. */
  notified: z.array(passthroughObject({ actor: agentApiArtifactActorSchema, reason: z.enum(["resolved", ...AGENT_API_ARTIFACT_COMMENT_NOTICE_REASONS]) })),
  /** A note's `@name`s that reached no one, as a reply's. */
  notNotified: z.array(passthroughObject({ name: z.string(), reason: z.enum(AGENT_API_ARTIFACT_NOT_NOTIFIED_REASONS) })),
}));

// ---- POST /artifacts/:artifact/home, DELETE /artifacts/:artifact ---------------

/**
 * Move the Artifact to a larger home, and its comments and versions with it.
 * An agent gets only `server` (the whole server: its members and agents):
 * `public` is a person's step, 403 FORBIDDEN. Who may: an agent that sees it
 * and is its author (among agents; the Server's manage.ts has the whole
 * rule), and only what the person who manages it could move too (sees it,
 * may widen it), else 403 FORBIDDEN. The
 * home only grows (409 HOME_NOT_WIDER); the larger home must not have a live
 * Artifact of its name (409 NAME_TAKEN).
 */
export const agentApiArtifactMoveBodySchema = lazySchema("agentApiArtifactMoveBodySchema", () => passthroughObject({
  to: z.enum(["server", "public"]),
}));

/** The moved Artifact, and the home it left (an agent can't move it back there: a smaller home is a person's step on the web). */
export const agentApiArtifactMovedSchema = lazySchema("agentApiArtifactMovedSchema", () => passthroughObject({
  artifact: agentApiArtifactSummarySchema,
  from: agentApiArtifactHomeSchema,
}));

/**
 * Deleted: no one opens it or any of its versions any more; can't be undone.
 * Who may: an agent that sees it and is its author, else 403 FORBIDDEN.
 */
export const agentApiArtifactDeletedSchema = lazySchema("agentApiArtifactDeletedSchema", () => passthroughObject({
  artifact: agentApiArtifactRefSchema,
  deleted: z.literal(true),
}));

// ---- POST /artifacts/import ----------------------------------------------------

/**
 * Import one Artifact of the standalone app (raft-artifacts.com) into Raft,
 * as a new Artifact homed in the whole server (as it was there), or in
 * `target` when given (a conversation without guests). `from` is its link
 * (`https://raft-artifacts.com/p/<server>/<name>`): the Server reads only the
 * server slug and the name from it (the slug must be the caller's server's)
 * and asks the standalone app for the Artifact itself, never at the link.
 */
export const agentApiArtifactImportBodySchema = lazySchema("agentApiArtifactImportBodySchema", () => passthroughObject({
  from: z.string().trim().min(1),
  /**
   * The new Artifact's home: a conversation (`#channel`, `dm:@peer`; a thread
   * target means its parent) without guests, not a joint channel. Absent: the
   * whole server (its members and agents, not guests).
   */
  target: z.string().trim().min(1).optional(),
}));

export const agentApiArtifactImportedSchema = lazySchema("agentApiArtifactImportedSchema", () => passthroughObject({
  artifact: agentApiArtifactSummarySchema,
  /**
   * False: it was imported before (by anyone) and that Artifact still exists
   * and the caller sees it: this is that one, nothing new was written.
   */
  created: z.boolean(),
  /** The old link, canonical (`https://raft-artifacts.com/p/<server>/<name>`). */
  from: z.string(),
}));

// ---- POST /artifacts/save-attachment --------------------------------------------

/**
 * Save an attachment as an Artifact, as the web's "Save as Artifact" does
 * (one rule for both: the Server's save.ts). `attachmentId` is the id agents
 * read after the file name in a message, `(id:<uuid>)`. The caller must see
 * the attachment's message, within the plan's history window (else 404
 * ATTACHMENT_NOT_FOUND). The new Artifact is the caller's (it follows it),
 * homed in the attachment's top-level conversation (a thread's: its
 * channel), named and titled after the file, version 1 the one file; the
 * attachment is then saved as it (the web's "Saved as Artifact" line). An
 * attachment saved before as a live Artifact answers that one if the caller
 * sees it (200, created false), else 409 ALREADY_SAVED. Over an Artifact
 * file's limit: 422 ATTACHMENT_NOT_SAVABLE. The copied bytes count against
 * the server's monthly file upload quota, as attachments do (403
 * FILE_UPLOAD_QUOTA_EXCEEDED, nothing saved); storage that can't take them,
 * 503 CONTENT_UNAVAILABLE.
 */
export const agentApiArtifactSaveAttachmentBodySchema = lazySchema("agentApiArtifactSaveAttachmentBodySchema", () => passthroughObject({
  attachmentId: z.string().trim().min(1),
}));

export const agentApiArtifactSavedSchema = lazySchema("agentApiArtifactSavedSchema", () => passthroughObject({
  artifact: agentApiArtifactSummarySchema,
  /** False: the attachment was saved before as this Artifact, which the caller sees; nothing new was made. */
  created: z.boolean(),
  /** The attachment it was saved from: its id and the file name it was posted with. */
  attachment: passthroughObject({ id: z.string(), filename: z.string() }),
}));

export type AgentApiArtifactImportBody = z.infer<typeof agentApiArtifactImportBodySchema>;
export type AgentApiArtifactSaveAttachmentBody = z.infer<typeof agentApiArtifactSaveAttachmentBodySchema>;
export type AgentApiArtifactSaved = z.infer<typeof agentApiArtifactSavedSchema>;
export type AgentApiArtifactImported = z.infer<typeof agentApiArtifactImportedSchema>;
export type AgentApiArtifactActor = z.infer<typeof agentApiArtifactActorSchema>;
export type AgentApiArtifactHome = z.infer<typeof agentApiArtifactHomeSchema>;
export type AgentApiArtifactSummary = z.infer<typeof agentApiArtifactSummarySchema>;
export type AgentApiArtifactVersionSummary = z.infer<typeof agentApiArtifactVersionSummarySchema>;
export type AgentApiArtifactFile = z.infer<typeof agentApiArtifactFileSchema>;
export type AgentApiArtifactCommentExcerpt = z.infer<typeof agentApiArtifactCommentExcerptSchema>;
export type AgentApiArtifactComment = z.infer<typeof agentApiArtifactCommentSchema>;
export type AgentApiArtifactListQuery = z.infer<typeof agentApiArtifactListQuerySchema>;
export type AgentApiArtifactListResponse = z.infer<typeof agentApiArtifactListResponseSchema>;
export type AgentApiArtifactSearchMatch = z.infer<typeof agentApiArtifactSearchMatchSchema>;
export type AgentApiArtifactListItem = z.infer<typeof agentApiArtifactListItemSchema>;
export type AgentApiArtifactParams = z.infer<typeof agentApiArtifactParamsSchema>;
export type AgentApiArtifactReadQuery = z.infer<typeof agentApiArtifactReadQuerySchema>;
export type AgentApiArtifactReadResponse = z.infer<typeof agentApiArtifactReadResponseSchema>;
export type AgentApiArtifactFileParams = z.infer<typeof agentApiArtifactFileParamsSchema>;
export type AgentApiArtifactFileQuery = z.infer<typeof agentApiArtifactFileQuerySchema>;
export type AgentApiArtifactFileContentResponse = z.infer<typeof agentApiArtifactFileContentResponseSchema>;
export type AgentApiArtifactCommentsQuery = z.infer<typeof agentApiArtifactCommentsQuerySchema>;
export type AgentApiArtifactCommentsResponse = z.infer<typeof agentApiArtifactCommentsResponseSchema>;
export type AgentApiArtifactPublishFile = z.infer<typeof agentApiArtifactPublishFileSchema>;
export type AgentApiArtifactPublishBody = z.infer<typeof agentApiArtifactPublishBodySchema>;
export type AgentApiArtifactPublishMissing = z.infer<typeof agentApiArtifactPublishMissingSchema>;
export type AgentApiArtifactPublished = z.infer<typeof agentApiArtifactPublishedSchema>;
export type AgentApiArtifactMergedChange = z.infer<typeof agentApiArtifactMergedChangeSchema>;
export type AgentApiArtifactPublishWarning = z.infer<typeof agentApiArtifactPublishWarningSchema>;
export type AgentApiArtifactPushCheck = z.infer<typeof agentApiArtifactPushCheckSchema>;
export type AgentApiArtifactPublishResponse = z.infer<typeof agentApiArtifactPublishResponseSchema>;
export type AgentApiArtifactUploadParams = z.infer<typeof agentApiArtifactUploadParamsSchema>;
export type AgentApiArtifactCommentImage = z.infer<typeof agentApiArtifactCommentImageSchema>;
export type AgentApiArtifactCommentImageParams = z.infer<typeof agentApiArtifactCommentImageParamsSchema>;
export type AgentApiArtifactCommentAnchor = z.infer<typeof agentApiArtifactCommentAnchorSchema>;
export type AgentApiArtifactCommentBody = z.infer<typeof agentApiArtifactCommentBodySchema>;
export type AgentApiArtifactCommentCreated = z.infer<typeof agentApiArtifactCommentCreatedSchema>;
export type AgentApiArtifactReview = z.infer<typeof agentApiArtifactReviewSchema>;
export type AgentApiArtifactReviewComment = z.infer<typeof agentApiArtifactReviewCommentSchema>;
export type AgentApiArtifactReviewBody = z.infer<typeof agentApiArtifactReviewBodySchema>;
export type AgentApiArtifactReviewCreated = z.infer<typeof agentApiArtifactReviewCreatedSchema>;
export type AgentApiArtifactCommentNoticeReason = (typeof AGENT_API_ARTIFACT_COMMENT_NOTICE_REASONS)[number];
export type AgentApiArtifactNotNotifiedReason = (typeof AGENT_API_ARTIFACT_NOT_NOTIFIED_REASONS)[number];
export type AgentApiArtifactSubscriptionResponse = z.infer<typeof agentApiArtifactSubscriptionResponseSchema>;
export type AgentApiArtifactCommentParams = z.infer<typeof agentApiArtifactCommentParamsSchema>;
export type AgentApiArtifactResolveBody = z.infer<typeof agentApiArtifactResolveBodySchema>;
export type AgentApiArtifactThreadResolution = z.infer<typeof agentApiArtifactThreadResolutionSchema>;
export type AgentApiArtifactMoveBody = z.infer<typeof agentApiArtifactMoveBodySchema>;
export type AgentApiArtifactMoved = z.infer<typeof agentApiArtifactMovedSchema>;
export type AgentApiArtifactDeleted = z.infer<typeof agentApiArtifactDeletedSchema>;

// ---- GET /assistant/owner-artifact (RFC 075, #proj-assistant:#31) ----------
// A personal assistant reads an Artifact as its owner would open it on the web:
// only one its owner can see (and, in a DM, only while the owner lets it read
// DMs), with the owner's comments view. Marks nothing read, follows nothing.

export const agentApiAssistantOwnerArtifactQuerySchema = lazySchema("agentApiAssistantOwnerArtifactQuerySchema", () => passthroughObject({
  /** Its id, its short id (pt_…) or its link (https://app.raft.build/artifacts/<id>). */
  artifact: z.string().trim().min(1).max(2048),
  /** A version number; default the current version. */
  version: versionQuerySchema,
  /** A file of that version; default its entry file. */
  path: z.string().trim().min(1).max(1024).optional(),
  /** The comments before this cursor (an answer's `comments.olderCursor`) instead of the newest page; read back to the oldest to get `position`. */
  commentsBefore: z.string().trim().min(1).max(512).optional(),
}));

export const agentApiAssistantOwnerArtifactResponseSchema = lazySchema("agentApiAssistantOwnerArtifactResponseSchema", () => passthroughObject({
  owner: passthroughObject({ userId: z.string().uuid() }),
  artifact: passthroughObject({
    id: z.string(),
    /** Its link, to the version shown when one was asked for. */
    url: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    /** Where it lives; a conversation is named as your owner sees it (`#channel`, `dm:@peer`). */
    home: agentApiArtifactHomeSchema,
    author: agentApiArtifactActorSchema,
    /** The version shown, and the newest one. */
    version: z.number().int(),
    latestVersion: z.number().int(),
    commentCount: z.number().int(),
    /**
     * Where the Artifact stood when read: pass it as `seen` when you publish a new version, to say you have read
     * every comment up to here. Given only when this first read holds every comment; otherwise null: use
     * `comments.newestPosition` from your first page once you have read every older page.
     */
    position: z.number().int().nullable(),
    createdAt: isoSchema,
    updatedAt: isoSchema,
  }),
  /** The versions your owner may open, newest first. */
  versions: z.array(agentApiArtifactVersionSummarySchema),
  /** Every file of the shown version: name one as `path` to read it. */
  files: z.array(agentApiArtifactFileSchema),
  /** The file read (`path`, else the entry file): a text file's content (cut at the read limit), a binary file's size and type only. */
  file: z.discriminatedUnion("kind", [
    passthroughObject({
      kind: z.literal("text"),
      path: z.string(),
      entry: z.boolean(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
      content: z.string(),
      truncated: z.boolean(),
    }),
    passthroughObject({
      kind: z.literal("binary"),
      path: z.string(),
      entry: z.boolean(),
      contentType: z.string(),
      sizeBytes: z.number().int(),
    }),
  ]),
  /** The newest page of comments your owner can see, oldest first; `olderCursor` when there are more. */
  comments: passthroughObject({
    items: z.array(agentApiArtifactCommentSchema),
    /** Absent from a Server before #14633, which can't page back. */
    olderCursor: z.string().nullable().optional(),
    /**
     * Where the Artifact stood when this page was read. With more than one page: keep your FIRST page's value,
     * read back with `commentsBefore` until `olderCursor` is null, then pass that first value as `seen`; a comment
     * posted while you paged is past it and still counts as unseen. Absent from a Server before #14633: use
     * `artifact.position` there.
     */
    newestPosition: z.number().int().optional(),
  }),
}));

export type AgentApiAssistantOwnerArtifactQuery = z.infer<typeof agentApiAssistantOwnerArtifactQuerySchema>;
export type AgentApiAssistantOwnerArtifactResponse = z.infer<typeof agentApiAssistantOwnerArtifactResponseSchema>;

// ---- POST /assistant/owner-artifact (RFC 075, #proj-assistant:#31, step 2) --
// A personal assistant publishes an Artifact as itself into its DM with its
// owner, or a new version of one it published itself. Artifacts' own publish
// (publishAs.ts): the same checks, refusals, quota and notices as an agent's.

export const agentApiAssistantOwnerArtifactPublishBodySchema = lazySchema("agentApiAssistantOwnerArtifactPublishBodySchema", () => passthroughObject({
  /** An Artifact you published, to push a new version of (its id, pt_ id or link). Absent: a new one, in your DM with your owner. */
  artifact: z.string().trim().min(1).optional(),
  /** Required for a new Artifact; for a new version, a new title with nothing else changed renames it. */
  title: z.string().optional(),
  description: z.string().optional(),
  /** The file it opens at. Default: the base's; for a new one index.html, or the only file. */
  entry: z.string().optional(),
  /** What changed in this version. */
  note: z.string().optional(),
  label: z.string().optional(),
  /** The version your files were made from: required for a new version (the version owner-artifact read returned). */
  base: z.number().int().positive().optional(),
  /** The `position` owner-artifact read returned: you have seen every comment up to it. */
  seen: z.number().int().nonnegative().optional(),
  /** Files to add or replace, inline (`content`, or `content_base64` for bytes); files not listed carry over from base. */
  files: z.array(agentApiArtifactPublishFileSchema),
  /** Paths to remove from the base's files. */
  delete: z.array(z.string()).optional(),
}));

export const agentApiAssistantOwnerArtifactPublishResponseSchema = lazySchema("agentApiAssistantOwnerArtifactPublishResponseSchema", () => passthroughObject({
  artifact: passthroughObject({
    id: z.string(),
    /** Its link: post it to your owner so they can open it. */
    url: z.string(),
    /** The version this made, or the current one when nothing changed. */
    version: z.number().int(),
    /** The current version already was what you sent: no new version. */
    unchanged: z.boolean(),
    /** The conversation it lives in: your DM with your owner. */
    homeConversationId: z.string().nullable(),
  }),
}));

export type AgentApiAssistantOwnerArtifactPublishBody = z.infer<typeof agentApiAssistantOwnerArtifactPublishBodySchema>;
export type AgentApiAssistantOwnerArtifactPublishResponse = z.infer<typeof agentApiAssistantOwnerArtifactPublishResponseSchema>;
