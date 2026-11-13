// Workspace Artifacts: the payloads the web app and the agent API read
// (feat/workspace-artifacts, docs/development/workspace-artifacts.md). Behind
// the per-server flag workspace_artifacts_v0.
//
// Rules every payload here follows (decision log and technical design):
// - Visibility is decided on the server, per viewer. Someone who can't see an
//   Artifact gets the bare link and nothing else: no title, no home, no
//   preview, and no way to tell "no access" from "doesn't exist" (§4, F11).
// - An Artifact has one home; it is the only thing that decides who can see
//   it (D15). A card posted elsewhere is a reference and grants nothing.
// - The viewer route answers the same way: a viewer who can't open an
//   Artifact gets one "can't open" state, whatever the reason (no
//   ArtifactViewerData at all).
// - Someone outside the server viewing a public Artifact gets its current
//   version and author only: no other version, no comments, never presence
//   or who a comment would notify. A joint channel's member on another
//   server reads it all, history and comments, and writes nothing.
// - Times are ISO 8601 strings; display text is the client's to format.

import type { ArtifactCommentImageType } from "./artifactCommentLimits";
import type { ArtifactExcerptBlock } from "./artifactExcerptBlocks";
import type { Brand, ChannelId, MessageId } from "./brandedIds";
import type { ArtifactWebFrame } from "./webArtifactsContract";
import type { ObjectFileId } from "./webObjectsContract";

/** An Artifact id (`pt_…`): stable across renames, home changes and servers. */
export type ArtifactId = Brand<string, "ArtifactId">;

/** Brand a string as an {@link ArtifactId} where it is first known to be one (validated param, row). */
export const asArtifactId = (id: string): ArtifactId => id as ArtifactId;

/** An Artifact comment's id. */
export type ArtifactCommentId = Brand<string, "ArtifactCommentId">;

/** Brand a string as an {@link ArtifactCommentId} where it is first known to be one (validated param, row). */
export const asArtifactCommentId = (id: string): ArtifactCommentId => id as ArtifactCommentId;

/** How an Artifact's entry file is shown (F37). ARTIFACT_FRAMED_KINDS go through the content origin. */
export type ArtifactKind = "html" | "markdown" | "text" | "csv" | "image" | "pdf" | "video" | "other";

/**
 * The kinds shown in a frame on the content origin (S2, `artifactWebPaths.frame`);
 * the Raft shell draws the others itself.
 */
export const ARTIFACT_FRAMED_KINDS = ["html", "markdown", "pdf"] as const satisfies readonly ArtifactKind[];
export type ArtifactFramedKind = (typeof ARTIFACT_FRAMED_KINDS)[number];

/** Whether `kind` is shown in a frame on the content origin. */
export const isArtifactFramedKind = (kind: ArtifactKind): kind is ArtifactFramedKind =>
  (ARTIFACT_FRAMED_KINDS as readonly ArtifactKind[]).includes(kind);

/**
 * The kinds a publish check opens (task #130): HTML. Not Markdown (xxchan,
 * task #proj-workspace:#217): its card shows a text excerpt instead
 * (ArtifactPreview `excerpt`); versions checked before keep what they have.
 * Not PDF, though the shell frames it too: headless
 * Chrome shows a PDF as a blank page or a download, and cards use the
 * screenshots as covers, so a blank one is worse than none (Tenny, #12896
 * review). PDF returns once a staging run shows its real first page.
 */
export const ARTIFACT_CHECKED_KINDS = ["html"] as const satisfies readonly ArtifactFramedKind[];
export type ArtifactCheckedKind = (typeof ARTIFACT_CHECKED_KINDS)[number];

/** Whether a version whose entry is of `kind` gets a publish check (recorded, leased, signed, authorized). */
export const isArtifactCheckedKind = (kind: ArtifactKind): kind is ArtifactCheckedKind =>
  (ARTIFACT_CHECKED_KINDS as readonly ArtifactKind[]).includes(kind);

/** A person or agent, as any Artifact payload names them (`type` as in the agent API's mentions). */
export interface ArtifactActor {
  type: "user" | "agent";
  id: string;
  name: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Set when no one stands behind the id any more, with `name` and
   * `displayName` empty: `deleted`, a deleted agent or a person whose account
   * is gone; `system`, Raft itself (the per-server move's import, a
   * takedown). The web names them ("Deleted agent", "Deleted user",
   * "System") rather than showing nothing.
   */
  gone?: "deleted" | "system";
  /**
   * Set when the actor is an agent that is someone's personal assistant:
   * the person it works for (their user id, handle and display name), so
   * the web can say whose assistant wrote it. Absent for people, other
   * agents, and older Servers.
   */
  onBehalfOf?: { id: string; name: string; displayName: string };
}

/**
 * Who wrote or published an Artifact, as a card (`author`) and the version
 * list (`publisher`) name them: an ArtifactActor, without `id` and
 * `onBehalfOf` for a reader outside the Artifact's server (another server's
 * signed-in reader of a public Artifact), who is shown the name and avatar
 * but not who in that server it is (as a visitor signed out is shown no
 * one).
 */
export type ArtifactShownActor = Omit<ArtifactActor, "id"> & { id?: string };

/**
 * Where an Artifact lives: who can see it (D15). Only sent to viewers who can
 * see the Artifact. A conversation that was deleted (an orphan, seen only by
 * its author, the author agent's manager, owners and admins) has an empty
 * name, and a null `id` once its row is gone too (a hard delete).
 */
export type ArtifactHome =
  | { kind: "conversation"; conversation: { id: string | null; name: string; type: "channel" | "private" | "dm" | "joint"; /** A DM's peer by display name, as the reader's sidebar shows it (absent when it has none, and for other types). */ peerDisplayName?: string } }
  | { kind: "server" }
  | { kind: "public" };

/** Raw counts for the card's fact line; the client formats them ("6 pages", "5 rows × 4 columns"). */
export interface ArtifactFacts {
  sizeBytes: number;
  fileCount: number;
  pages?: number;
  rows?: number;
  columns?: number;
  columnNames?: string[];
  lines?: number;
  width?: number;
  height?: number;
}

/**
 * The longest ArtifactPreview `excerpt`, in code points (… included): a little
 * more than the largest frame holds (a message card, 440 by 192 px, about 500
 * Latin characters of `text-callout`), so a long version's text always reaches
 * the frame's fade, and at most 2,400 bytes on a card.
 */
export const ARTIFACT_EXCERPT_MAX_CHARS = 600;

/**
 * What a card shows of the Artifact: a text excerpt, a publisher-given cover,
 * the publish check's screenshots, or nothing. No payload carries a URL to
 * fetch with the viewer's credentials; the client builds each address:
 * - `excerpt` (task #proj-workspace:#217): the start of a Markdown version's
 *   entry, made when the version is published (at most
 *   ARTIFACT_EXCERPT_MAX_CHARS). Plain text, one line per block, with `\n`
 *   between them: agent-made words, which a client shows as text and nothing
 *   else (never as Markdown or HTML, no links, images or mentions). A version
 *   that still has a check's screenshots sends those instead.
 *   With it, when the version has them, `blocks` (#proj-workspace:#220): the
 *   same start as data, for a client that draws it with its hierarchy
 *   (artifactExcerptBlocks.ts, parseArtifactExcerptBlocks). Optional: a version
 *   from before it has none, a client that doesn't know it ignores it, and
 *   `text` stays the whole of the older contract (the Android App reads it).
 * - `image`: a cover, a file of the card's version: the Raft API path from
 *   the card's id, `version` and this `path`.
 * - `screenshot` (task #130): the card's version was opened by the publish
 *   check, which took it at desktop width (`desktop`) and, when it could, at
 *   phone width (`phone`, else null). Each is a core object file of the
 *   Artifact: `objectWebPaths.file("artifact", card.id, fileId)`, which
 *   checks the reader's sight of the Artifact. Only where
 *   the deployment runs publish checks, only for a
 *   version whose check finished with its screenshots kept (the newest three
 *   versions' are), and never for another server's reader of a public
 *   Artifact (`fromAnotherServer`: core serves it none of the files); else the
 *   card falls back to the other kinds.
 * A client must draw a kind it doesn't know as `none` (a newer Server may add
 * kinds).
 */
export type ArtifactPreview =
  | { kind: "excerpt"; text: string; blocks?: ArtifactExcerptBlock[] }
  | { kind: "image"; path: string }
  | { kind: "screenshot"; desktop: ObjectFileId; phone: ObjectFileId | null }
  | { kind: "none" };

/** What a card shows, wherever it is drawn (message, Activity, Files, home page). */
export interface ArtifactCard {
  id: ArtifactId;
  /** The one address (G2, G3): https://app.raft.build/artifacts/<id>, with /v/<n> when pinned. */
  url: string;
  title: string;
  description: string | null;
  kind: ArtifactKind;
  facts: ArtifactFacts;
  preview: ArtifactPreview;
  /** The version this card shows: the pinned one for an @vN reference, else the latest (F10). */
  version: number;
  pinned: boolean;
  latestVersion: number;
  /** Who the card names: a pinned card's version's publisher, else the Artifact's author (no `id` outside its server). */
  author: ArtifactShownActor;
  createdAt: string;
  /** A pinned card: when its version was published; else the Artifact's last update. */
  updatedAt: string;
  commentCount: number;
  home: ArtifactHome;
  /**
   * The Artifact is another server's, read here as an outsider (a public
   * one): the card says so ("Public · from another server"), naming no
   * server, and it opens read-only. Absent otherwise, and from older Servers.
   */
  fromAnotherServer?: true;
  /**
   * What changed in the Artifact since this reader last looked (their read
   * position: opening its current version, or reading it in Activity; the
   * badge's notion of read), for a message card to mark (task #141).
   * Only in core's object summaries (the cards messages and Activity read),
   * for the signed-in reader asking. Null when the reader has no read
   * position on it: never opened it (everything would be new, so nothing is
   * marked), or reads it as an outsider (another server's public Artifact,
   * which keeps none). Absent elsewhere (the viewer's own `card`, the
   * dashboard, search) and from older Servers: draw no marks.
   */
  unseen?: ArtifactCardUnseen | null;
}

/**
 * ArtifactCard `unseen`: others' changes past the reader's read position.
 * The reader's own versions and comments never count (as shownThrough and
 * Activity's unread: what one wrote oneself is never new to one).
 */
export interface ArtifactCardUnseen {
  /** A version published by someone else became current after the reader last looked (a published, unrevoked one). */
  newerVersion: boolean;
  /** Live comments by others written after the reader last looked (deleted ones never count). */
  newComments: number;
  /**
   * The first of those (the oldest past the read position): where the card
   * opens the comment list. Null with none; absent from older Servers.
   */
  firstNewComment?: ArtifactCommentId | null;
}

/**
 * A deleted Artifact, as a viewer who could see it before it was deleted
 * sees a reference to it (xxchan, Remy): its title, who deleted it and when;
 * nothing else of it (no preview, comments or viewer). Only to that viewer:
 * one who couldn't see it is answered `unavailable`, as for any Artifact they
 * can't see, so neither its existence nor its title reaches them. An Artifact
 * revoked by moderation is never `deleted`: it is `unavailable` to everyone.
 */
export interface ArtifactDeletedReference {
  status: "deleted";
  title: string;
  deletedBy: ArtifactShownActor;
  /** ISO 8601. */
  deletedAt: string;
}

/**
 * A reference to an Artifact as one viewer sees it. `unavailable` covers no
 * access, not found, revoked, and deleted for a viewer who couldn't see it,
 * and carries only the id-only link (never the name the sender's link may
 * have had, which would leak it). `deleted`: ArtifactDeletedReference.
 * Clients read a status they don't know as `unavailable`.
 */
export type ArtifactReference =
  | { status: "ok"; card: ArtifactCard }
  | { status: "unavailable"; url: string }
  | ArtifactDeletedReference;

export interface ArtifactFile {
  path: string;
  kind: ArtifactKind;
  sizeBytes: number;
  /** The file the version opens at. */
  entry: boolean;
}

/**
 * Where a file's bytes come from (Tenny, #proj-workspace:ee8634e1 d6bfc5a7):
 * the client builds `/api/artifacts/<id>/files/<percent-encoded path>?version=<n>`
 * itself and never fetches an address a payload gives it with the viewer's
 * credentials. Text and csv are read as text; png, jpeg, gif, webp and svg
 * images become `blob:` URLs drawn only as `<img src=blob:>`: SVG is never
 * inlined and never put in an `<object>` or `<embed>`, so its scripts never
 * run (an `<img>` runs none). html, markdown and pdf are drawn only on the
 * content origin (ARTIFACT_FRAMED_KINDS, `artifactWebPaths.frame`).
 */
export const ARTIFACT_INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;

export interface ArtifactVersionSummary {
  number: number;
  /** No `id` outside the Artifact's server. */
  publisher: ArtifactShownActor;
  createdAt: string;
  note: string | null;
  /** Files added, changed or removed against the version before. */
  changedPaths: string[];
}

/**
 * What the signed-in viewer may do; menus show only these (F13).
 * `changeHome` and `delete`: the author, the manager of an agent author, the
 * owners and admins of the Artifact's own server; `changeHome` only while a
 * larger home exists and never for a guest (a guest may delete their own).
 * `unpublish`: the same people as `changeHome` (none a guest), only while the
 * home is `public` (`artifactWebPaths.unpublish` moves it back to the server).
 * `narrowHome`: the same people, only while the home is `server` or
 * `public` and `originalHome` is set: back to the Artifact's original
 * conversation (#75: narrowing undoes a too-wide share, so its only
 * conversation is the one it was published or saved in), through
 * `artifactWebPaths.home` with `to: "conversation"` and
 * `originalHome.conversationId`, previewed by `artifactWebPaths.homeChange`.
 * Public back to the whole server stays `unpublish`.
 */
export interface ArtifactCapabilities {
  publish: boolean;
  comment: boolean;
  changeHome: boolean;
  unpublish: boolean;
  narrowHome: boolean;
  delete: boolean;
}

/** Everything the viewer (panel card or full page) needs for one version. */
export interface ArtifactViewerData {
  /** `card.version` is the version shown. */
  card: ArtifactCard;
  files: ArtifactFile[];
  /** Newest first. */
  versions: ArtifactVersionSummary[];
  capabilities: ArtifactCapabilities;
  /** Who is signed in: their comments are the ones they may edit and delete. */
  viewer: ArtifactActor;
  following: boolean;
  /**
   * The attachment it was saved from ("view original attachment", F13). Null
   * unless the viewer can see that message too: after a home change the
   * source can be in a conversation the viewer can't see.
   */
  savedFrom: { attachmentId: string; messageId: string; conversationId: string } | null;
  /**
   * The Artifact's original message: the one through which it entered a
   * conversation (xxchan, #proj-workspace:2e5a5da3), set once and never
   * moved. Null when it has none, the message is deleted, or the viewer
   * can't read that message now (its conversation, as the viewer's server
   * shows it, and the plan's history window), whatever the Artifact's home.
   */
  origin: ArtifactOrigin | null;
  /**
   * The conversation a narrowing may return it to (#75): its original
   * conversation, where it was published, saved or imported into, recorded
   * once and never moved. Set only for a reader who may move it
   * (`capabilities.narrowHome`) while its home is the server or public, that
   * conversation still exists (not deleted, not a joint channel) and the
   * reader can see it now (as `origin`: a private conversation's id is never
   * told to someone who can't see it). Null otherwise, one answer for every
   * reason; absent only from a server that predates it.
   */
  originalHome?: { conversationId: ChannelId } | null;
  /**
   * Where the shown version loads on the content origin (S2): the frame
   * route's answer for this version (`artifactWebPaths.frame`), its ticket
   * signed for this reader, so the first screen needs no second request.
   * Only for a framed kind (ARTIFACT_FRAMED_KINDS) while the content origin
   * is configured, and only in the viewer route's own answer
   * (`artifactWebPaths.viewer`, and the standalone page's `open`, whose
   * outsider's frame is the signed-out page's), never in another route's
   * ArtifactViewerData (home, unpublish, save-attachment). Its url's ticket opens once, within 60 seconds of the
   * answer: use it for the frame's first load right after this answer, and
   * never cache, log or store it. Every later load (a remount, a reload, a
   * version switch, a retry, a payload from a cache) and an absent `frame`
   * ask the frame route.
   */
  frame?: ArtifactWebFrame;
}

/**
 * How an Artifact entered a conversation: `attachment`, saved from that
 * message's attachment; `share`, the message a share posted when it had no
 * original message yet; `link` (later: a link to it in an ordinary message).
 */
export type ArtifactOriginVia = "attachment" | "share" | "link";

/** ArtifactViewerData.origin: where the message is, as the viewer's server has it. */
export interface ArtifactOrigin {
  messageId: MessageId;
  /** The top-level conversation (a thread reply's: the thread's parent conversation; a joint by the viewer's projection). */
  conversationId: ChannelId;
  /** A thread reply's thread: the message it hangs off. Absent outside a thread. */
  threadRootId?: MessageId;
  via: ArtifactOriginVia;
}

/** A position in a page, as Porthole's annotations make it (W3C selectors); the content's word, never a permission. */
export interface ArtifactAnnotationAnchor {
  kind: "element" | "text";
  selectors: Array<
    | { type: "CssSelector"; value: string }
    | { type: "TextQuoteSelector"; exact: string; prefix?: string; suffix?: string }
    | { type: "TextPositionSelector"; start: number; end: number }
  >;
  label: string;
}

/**
 * A place a page names itself (Porthole P090, P108): a page's button opens
 * the comment box there with `comments.open({ name, label, quote })`. All
 * three are the page's word, its author's or agent's: `name` is an
 * identifier, only ever compared, never read as a path or a link (Tenny);
 * `label` and `quote` are plain text, the quote shown as the page's excerpt,
 * never as text the person selected.
 */
export interface ArtifactPageAnchor {
  name: string;
  label?: string;
  quote?: string;
}

/** A page anchor's `name`: no spaces or control characters, at most 256 (Porthole's own limit). */
export const ARTIFACT_PAGE_ANCHOR_NAME = /^[A-Za-z0-9._~:/#-]{1,256}$/;
export const ARTIFACT_PAGE_ANCHOR_MAX_LABEL = 200;
/** Under Porthole's 2,000: the stored anchor is at most 4 KiB of JSON (AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES), and a quote of CJK text is 3 bytes a character; the viewer cuts a longer one. */
export const ARTIFACT_PAGE_ANCHOR_MAX_QUOTE = 1_000;
/** A comment's draft from the page (`comments.open(anchor, { draft })`, P108): Porthole's own limit. */
export const ARTIFACT_PAGE_DRAFT_MAX = 2_000;

/**
 * What text from a page (a page anchor's label and quote, a comment's draft)
 * may not hold (P108): lone surrogates, controls but tab and new lines,
 * format and private-use characters (zero-width, bidi, tags): what a person
 * would be shown as nothing and an agent would read. The server refuses an
 * anchor with them; the viewer refuses a page's request with them.
 */
export const ARTIFACT_PAGE_TEXT_UNSEEN = /[\p{Cf}\p{Co}]|[^\P{Cc}\n\t\r]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Text a page gave that a person can be shown whole as plain text: at most `max` characters, not blank, nothing unseen. */
export function isArtifactPageText(text: unknown, max: number): text is string {
  return typeof text === "string" && text.length <= max && text.trim() !== "" && !ARTIFACT_PAGE_TEXT_UNSEEN.test(text);
}

/**
 * Where a comment points. Pages (html, markdown) use Porthole annotations,
 * or a place the page names (`page`); text and csv use the attachment
 * comments' line and row anchors (RFC 036, E2); null is the whole file.
 * Whether a page anchor is still found in the shown version is reported by
 * the frame at run time, not stored (E9).
 */
export type ArtifactCommentAnchor =
  | { type: "annotation"; data: ArtifactAnnotationAnchor }
  | { type: "page"; data: ArtifactPageAnchor }
  | { type: "lines"; data: { start: number; end: number; quote?: string } }
  | { type: "csv-rows"; data: { start: number; end: number; quote?: string } };

/** A run of comment text, so a mention renders as a mention. */
export type ArtifactCommentPart =
  | { type: "text"; text: string }
  | { type: "mention"; actor: ArtifactActor };

/**
 * An image a comment carries: a core object file of the Artifact (read at
 * webObjectsContract `objectWebPaths.file("artifact", artifactId, fileId)`
 * by whoever can read the Artifact's comments). Everything here is what the
 * Server found in the bytes it kept (their type, size and pixel size), never
 * what the uploader said; metadata (EXIF, text chunks) is removed before
 * they are kept.
 */
export interface ArtifactCommentImage {
  fileId: ObjectFileId;
  contentType: ArtifactCommentImageType;
  sizeBytes: number;
  width: number;
  height: number;
}

export interface ArtifactComment {
  id: ArtifactCommentId;
  author: ArtifactActor;
  body: ArtifactCommentPart[];
  createdAt: string;
  editedAt: string | null;
  /** Set on a deleted comment kept as a placeholder for its replies; its body is then empty. */
  deletedAt: string | null;
  /** The version it was written on; the list holds every version's comments (E12). */
  version: number;
  /** The Artifact as a whole, or one file of it: the whole file, or a place in it. */
  target: { scope: "artifact" } | { scope: "file"; path: string; anchor: ArtifactCommentAnchor | null };
  replyTo: ArtifactCommentId | null;
  /** The id of the review (S8) that posted it with others at once; absent for a single comment. */
  reviewId?: ArtifactReviewId;
  /**
   * Its images, in the order they were attached (at most
   * ARTIFACT_COMMENT_MAX_IMAGES); absent when it has none (and on a deleted
   * placeholder). Images are given when a comment is written and can't be
   * edited.
   */
  images?: ArtifactCommentImage[];
  /**
   * A thread's resolution (#249): when and by whom its root was resolved;
   * both null while the thread is open, and always null on a reply (only a
   * thread is resolved). A reply in a resolved thread reopens it.
   */
  resolvedAt: string | null;
  resolvedBy: ArtifactActor | null;
}

/**
 * A posted review's id (S8): a uuid, opaque to clients. Each of its comments
 * carries it as `reviewId`; the comments list takes it as `review`.
 */
export type ArtifactReviewId = Brand<string, "ArtifactReviewId">;

/** Brand a string as an {@link ArtifactReviewId} where it is first known to be one (validated param, row). */
export const asArtifactReviewId = (id: string): ArtifactReviewId => id as ArtifactReviewId;

/**
 * A review draft's id (S8): a uuid. Drafts are their author's alone: any
 * other draft id answers 404 DRAFT_NOT_FOUND.
 */
export type ArtifactCommentDraftId = Brand<string, "ArtifactCommentDraftId">;

/** Brand a string as an {@link ArtifactCommentDraftId} where it is first known to be one (validated param, row). */
export const asArtifactCommentDraftId = (id: string): ArtifactCommentDraftId => id as ArtifactCommentDraftId;

/** At most this many review drafts per person and Artifact; one more: 409 DRAFT_LIMIT { limit }. */
export const ARTIFACT_DRAFT_MAX_PER_ARTIFACT = 50;
/** A draft not changed for this many days is gone (left out of every answer, then purged). */
export const ARTIFACT_DRAFT_TTL_DAYS = 30;
/** From this many days after its last change the web warns when a draft goes (`expiresAt`). */
export const ARTIFACT_DRAFT_WARN_AFTER_DAYS = 25;

/**
 * A review draft (S8, batch comments): a comment not posted yet, kept on the
 * Server and seen only by its author. `target` and `body` are a comment's.
 * Checked as a comment is when saved, and again when the review is submitted.
 * A reply draft (`replyTo`) is posted as a reply to that comment's thread;
 * it has no place of its own (`target` is `{ scope: "artifact" }`, the
 * thread's place is the comment's).
 */
export interface ArtifactCommentDraft {
  id: ArtifactCommentDraftId;
  /** The version it is written on. */
  version: number;
  target: ArtifactComment["target"];
  body: ArtifactCommentPart[];
  /** The comment it replies to; null: a comment of its own. */
  replyTo: ArtifactCommentId | null;
  /** Its images, as the comment will carry them; absent when it has none. Read only by the draft's author. */
  images?: ArtifactCommentImage[];
  createdAt: string;
  updatedAt: string;
  /** ARTIFACT_DRAFT_TTL_DAYS after `updatedAt`; warn from ARTIFACT_DRAFT_WARN_AFTER_DAYS. */
  expiresAt: string;
}

/** What the comment box sends for a draft: a comment's. */
export interface ArtifactCommentDraftInput {
  version: number;
  /** A reply's is `{ scope: "artifact" }`: it takes its thread's place (else 400 INVALID_REQUEST). */
  target: ArtifactComment["target"];
  body: Array<{ type: "text"; text: string } | { type: "mention"; actor: { type: "user" | "agent"; id: string } }>;
  /**
   * A live comment of this Artifact this draft replies to; posted as a reply
   * to it when the review is submitted (404 COMMENT_NOT_FOUND when there is
   * none). Absent or null: a comment of its own (older clients send none).
   */
  replyTo?: ArtifactCommentId | null;
  /**
   * Images uploaded for it (`POST …/comment-images`, each the upload's
   * `fileId`), at most ARTIFACT_COMMENT_MAX_IMAGES; absent: none. Each must
   * be the reader's own upload to this Artifact not yet used by another
   * comment or draft, else 400 IMAGE_NOT_FOUND and nothing saved. Only when
   * the draft is made: an edit keeps them.
   */
  images?: ObjectFileId[];
}

/** Submitting a person's drafts as one review. */
export interface ArtifactReviewSubmitInput {
  /** The version the reviewer is looking at: the review's, and its summary's. */
  version: number;
  /** A comment on the whole Artifact posted after the drafts; null or no text: none. */
  summary: ArtifactCommentDraftInput["body"] | null;
  /**
   * One per attempt (1 to 64 of `A-Z a-z 0-9 _ -`), sent again on a retry:
   * the same key answers the review it posted (200) instead of posting
   * again; with another version or summary, 409 CLIENT_KEY_REUSED. Without
   * it a submit is not idempotent.
   */
  clientKey?: string;
}

/** Why someone hears about a new comment or version. */
export type ArtifactNoticeReason = "author" | "publisher" | "commented" | "subscribed" | "mentioned";

/** Who is looking at the Artifact now, and who has read the shown version (I7, I8). */
export interface ArtifactPresence {
  /**
   * People with it open (from the socket) and agents working on it: an agent
   * is "reading" when it read the Artifact in its current turn and "writing"
   * while it is typing a comment or publishing.
   */
  viewing: Array<
    | { actor: ArtifactActor & { type: "user" }; state: "viewing"; path: string | null; since: string }
    | { actor: ArtifactActor & { type: "agent" }; state: "reading" | "writing"; path: string | null; since: string }
  >;
  /**
   * Read the current version but not here now (drawn faded), the latest
   * first: people and agents of the Artifact's server who can see it and
   * whose read position (how far they have looked) is at or past the
   * current version. A person's moves when they open the current version
   * in the viewer; an agent's when it reads the current version, and also
   * when a notice carries the version or newer comments, or a held publish
   * or comment shows it what it missed: so an agent may count before it
   * fetched any file.
   */
  readCurrentVersion: Array<{ actor: ArtifactActor; at: string }>;
  /**
   * Read the Artifact but not its current version, the latest first: the same
   * people and agents, whose read position is before the current version,
   * each with the last version it had reached.
   */
  readOtherVersion: Array<{ actor: ArtifactActor; at: string; version: number }>;
  /**
   * The reader's own read position (task #136: the "who has read it" list
   * reads it while the reader looks at an older version): the last version
   * it had reached (the current one when at or past it) and when it last
   * moved. Null when the reader has none, or when no readable version had
   * become current by its position; absent from Servers before it, for a
   * reader outside the Artifact's server, and while the Artifact has no
   * current version.
   */
  ownRead?: { version: number; at: string } | null;
}

/**
 * Who a comment would notify, shown beside the comment box (I10). With no
 * agent in it, the client says so and suggests @-mentioning one.
 */
export interface ArtifactWillNotify {
  recipients: Array<{ actor: ArtifactActor; reason: ArtifactNoticeReason }>;
}

/**
 * The Artifacts that live in one conversation (its Files panel,
 * `artifactWebPaths.conversationArtifacts`): live Artifacts whose home is
 * that conversation (a joint channel's: the joint, on every server), with a
 * published current version, that the reader can see, by the same rule as
 * every list; never ones only linked or sent there. Newest first by the
 * Artifact's last update (`card.updatedAt`), each card exactly the viewer's
 * for the current version. `nextCursor`: there is more (ask again with it),
 * else null. An Artifact updated while the pages are read moves to the top,
 * so it may be missing from the later pages of that run; none is ever
 * listed twice. A row is an object so it can say more later (why it is
 * here) without breaking the shape.
 */
export interface ArtifactWebConversationArtifacts {
  rows: Array<{ card: ArtifactCard }>;
  nextCursor: string | null;
}

// ---- Reading one Artifact as a person (#proj-assistant:#31) ------------------
// The answer of the Artifacts server app's readArtifactAsUser (apps/artifacts/readAsUser.ts), here so core can
// read it through the app's registration (FirstPartyApp.actingFor) without importing the app.

/** One file of the shown version: its text when it is a text kind (cut at the agent API's limit), else only what it is. */
export type ArtifactReadAsUserFile =
  & { path: string; entry: boolean; contentType: string; sizeBytes: number }
  & ({ kind: "text"; text: string; truncated: boolean } | { kind: "binary" });

export interface ArtifactReadAsUser {
  item: {
    id: string;
    /** The canonical link, to the version shown when one was asked for. */
    url: string;
    title: string;
    description: string | null;
    home: ArtifactHome;
    author: ArtifactShownActor;
    /** The version this answer shows, and the newest published one. */
    version: number;
    latestVersion: number;
    /**
     * The Artifact's event counter when it was read: every comment and version up to it existed then.
     * A publish may pass it as "seen" once the caller has shown the reader every comment it needs.
     */
    position: number;
    commentCount: number;
    createdAt: string;
    updatedAt: string;
  };
  /** The versions the person may open, as the viewer lists them (an outsider: the current one only). */
  versions: ArtifactViewerData["versions"];
  /** Every file of the shown version, by path. */
  files: ArtifactViewerData["files"];
  file: ArtifactReadAsUserFile;
  /** With `comments`: the newest page, oldest first, as the web lists them; `olderCursor` when there are more. */
  comments?: { comments: ArtifactComment[]; olderCursor: string | null };
}


