// The `app_artifacts` schema: Workspace Artifacts' own tables (technical
// design §2.2 / §2b). Raft core never reads these; the module reads core only
// through its entry points (see README.md). Foreign keys point at core only for
// servers (ON DELETE CASCADE), channels (ON DELETE SET NULL: an orphan) and
// attachments (attachment_saves, CASCADE): core deletes what it owns without
// asking the app (first-party app mechanism §八). Columns added since name
// core rows without one (origin_message_id, original_home_channel_id: Tenny,
// never a new foreign key from an app table to a hot core table). Actors are polymorphic
// (type, id) pairs without a foreign key, resolved live.
import { sql } from "drizzle-orm";
import type { ArtifactCommentImage, ArtifactExcerptBlock, ObjectFileId, ServerId } from "@botiverse/raft-shared";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { attachments, channels, servers } from "../../db/schema";

export const appArtifacts = pgSchema("app_artifacts");

export const ARTIFACT_ACTOR_TYPES = ["user", "agent"] as const;
export type ArtifactActorType = (typeof ARTIFACT_ACTOR_TYPES)[number];

/**
 * Where an Artifact lives, which decides who can see it (§3.1, one home):
 * a conversation (channel, private channel, DM or joint), the whole server,
 * or public. The "only me" home of the design is not in the first step.
 */
export const ARTIFACT_HOME_KINDS = ["conversation", "server", "public"] as const;
export type ArtifactHomeKind = (typeof ARTIFACT_HOME_KINDS)[number];

/**
 * How an Artifact entered a conversation (its original message, xxchan
 * #proj-workspace:2e5a5da3): saved from that message's attachment, or the
 * message a share posted while it had none. Links in ordinary messages come
 * later (shared ArtifactOriginVia `link`).
 */
export const ARTIFACT_ORIGIN_VIAS = ["attachment", "share"] as const;
export type ArtifactOriginViaStored = (typeof ARTIFACT_ORIGIN_VIAS)[number];

/**
 * A blob is `pending` while its bytes are being written (the row is
 * inserted first, the PUT runs outside any transaction) and `ready` once
 * they are. Only ready blobs are present to a publish.
 */
export const ARTIFACT_BLOB_STATES = ["pending", "ready"] as const;
export type ArtifactBlobState = (typeof ARTIFACT_BLOB_STATES)[number];

/** Comment anchor, the attachment-comment format (RFC 036; e.g. `html-region`). */
export type ArtifactCommentAnchor = { type: string; data: Record<string, unknown> };
export type ArtifactCommentMention = { type: ArtifactActorType; id: string };
/** A review draft's body part, as the web sends a comment's (S8). */
export type ArtifactDraftPart = { type: "text"; text: string } | { type: "mention"; actor: ArtifactCommentMention };
/** A comment copied from an attachment comment when the attachment was saved as an Artifact (E3). */
export type ArtifactCommentCopiedFrom = { attachmentId: string; commentId: string };

export const artifactItems = appArtifacts.table("items", {
  /** `pt_…`. A new id for every Artifact, an imported one too (no D1 migration: workspace-artifacts.md, decisions of 2026-10-26). */
  id: text("id").primaryKey(),
  serverId: uuid("server_id").$type<ServerId>().notNull().references(() => servers.id, { onDelete: "cascade" }),
  urlKey: text("url_key").notNull().unique(),
  /**
   * The old name (lowercase, digits, hyphens) of an Artifact from before
   * titles, or of one imported from raft-artifacts.com: only an alias the
   * agent API still resolves (apiCommon resolveVisibleItem, after the id and
   * the title). Null for every Artifact made since (#proj-workspace:98241a2e):
   * an Artifact is its id and its title.
   */
  name: text("name"),
  title: text("title").notNull(),
  description: text("description"),
  icon: text("icon"),
  currentVersionId: text("current_version_id").references((): AnyPgColumn => artifactVersions.id),
  homeKind: text("home_kind", { enum: ARTIFACT_HOME_KINDS }).notNull(),
  /**
   * The home conversation, a top-level conversation's own id (channel,
   * private, dm or the server's joint projection; not a thread). A deleted
   * conversation never takes its Artifacts with it, nor is its delete
   * refused: the Artifact becomes an orphan (platform/visibility decides who
   * still sees one). Soft-deleted (`channels.deleted_at`), the id stays;
   * hard-deleted, ON DELETE SET NULL clears it, and a conversation home
   * without a channel is the orphan state (items_home_channel allows it).
   */
  homeChannelId: uuid("home_channel_id").references(() => channels.id, { onDelete: "set null" }),
  /**
   * The original conversation (#75): the conversation it was published,
   * saved or imported into (a top-level conversation's id, as
   * `home_channel_id` was then), set when it is made and never changed; null
   * for one made in the whole server. The only conversation a narrowing may
   * return it to (manage.ts). No foreign key (Tenny: never from an app table
   * to a hot core table): a deleted conversation leaves the id dangling, and
   * readers then offer no narrowing (manage.ts shownOriginalHome).
   */
  originalHomeChannelId: uuid("original_home_channel_id"),
  createdByType: text("created_by_type", { enum: ARTIFACT_ACTOR_TYPES }).notNull(),
  createdById: uuid("created_by_id").notNull(),
  /**
   * The personal assistant that published it (publishAs.ts,
   * #proj-assistant:#31), set when it is made and never changed; null for
   * every other Artifact. Not its author: an assistant may publish as its
   * owner, so "which Artifacts may this assistant push to" is read from here
   * (only the ones it made). No foreign key, as the other actor columns.
   */
  publishedByAssistantAgentId: uuid("published_by_assistant_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /**
   * The Artifact's event counter (E14): every comment, and every version when
   * it becomes current, takes the next position. Read positions are compared
   * against it ("what's new since you last looked").
   */
  lastPosition: bigint("last_position", { mode: "number" }).notNull().default(0),
  /**
   * The original message: the one through which it entered a conversation
   * (saved from its attachment; else the first share's message), set once
   * with `origin_via` and never changed, so it never moves. No foreign key
   * (Tenny, review of #11613): core's message deletes never wait on or touch
   * this table, and adding one would lock `messages`. A deleted message
   * leaves the id dangling; readers never show it (platform/messages
   * messageSource finds no message).
   */
  originMessageId: uuid("origin_message_id"),
  originVia: text("origin_via", { enum: ARTIFACT_ORIGIN_VIAS }),
}, (t) => [
  check("items_home_kind", sql`${t.homeKind} IN ('conversation', 'server', 'public')`),
  // A message is an origin only with how it became one.
  check("items_origin_via", sql`${t.originVia} IS NULL OR ${t.originVia} IN ('attachment', 'share')`),
  check("items_origin_message_via", sql`${t.originMessageId} IS NULL OR ${t.originVia} IS NOT NULL`),
  // Only a conversation home names a channel; one whose channel is NULL is an orphan.
  check("items_home_channel", sql`${t.homeKind} = 'conversation' OR ${t.homeChannelId} IS NULL`),
  check("items_created_by_type", sql`${t.createdByType} IN ('user', 'agent')`),
  index("idx_items_server_home").on(t.serverId, t.homeKind),
  index("idx_items_home_channel").on(t.homeChannelId),
  // An old name is unique among the live Artifacts of one home that have one
  // (Tenny, #proj-workspace): whoever may put an Artifact into a home already
  // sees every Artifact in it, so "taken" tells them nothing new. NULLs are
  // distinct in a unique index, so Artifacts without a name never collide.
  // Two indexes because a server or public home has no channel.
  uniqueIndex("idx_items_live_name_conversation").on(t.homeChannelId, t.name)
    .where(sql`${t.homeKind} = 'conversation' AND ${t.deletedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  uniqueIndex("idx_items_live_name_server_home").on(t.serverId, t.homeKind, t.name)
    .where(sql`${t.homeKind} <> 'conversation' AND ${t.deletedAt} IS NULL AND ${t.revokedAt} IS NULL`),
]);

/** One published version of an Artifact. Immutable once written, except revocation. */
export const artifactVersions = appArtifacts.table("versions", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  entry: text("entry").notNull(),
  /**
   * The Artifact's title and description as this version set them (a
   * publish may change them; items holds the current ones). Compared between
   * versions to tell who changed them. Null: not recorded (imported).
   */
  title: text("title"),
  description: text("description"),
  /** The version the publisher's files were made from (null for the first). */
  baseId: text("base_id"),
  label: text("label"),
  note: text("note"),
  spa: boolean("spa").notNull().default(false),
  fileCount: integer("file_count").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  publishDigest: text("publish_digest").notNull(),
  provenance: jsonb("provenance").$type<Record<string, unknown>>(),
  status: text("status").notNull(),
  publisherType: text("publisher_type", { enum: ARTIFACT_ACTOR_TYPES }).notNull(),
  publisherId: uuid("publisher_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByType: text("revoked_by_type", { enum: ARTIFACT_ACTOR_TYPES }),
  revokedById: uuid("revoked_by_id"),
  /** The item's position at which this version became current; null until then. */
  position: bigint("position", { mode: "number" }),
  /**
   * What a card shows of a Markdown version (excerpt.ts): the start of its
   * entry as plain text, at most ARTIFACT_EXCERPT_MAX_CHARS. Agent-made words,
   * only ever shown as text. Null: not Markdown, nothing to show, it couldn't
   * be read, or published before excerpts (not backfilled).
   */
  excerpt: text("excerpt"),
  /**
   * The same start as data, for a card to draw with its hierarchy
   * (excerptBlocks.ts, shared parseArtifactExcerptBlocks): bounded, agent-made
   * words only ever shown as text, no URL. Null: no excerpt, or published
   * before these (not backfilled), and the card draws `excerpt`.
   */
  excerptBlocks: jsonb("excerpt_blocks").$type<ArtifactExcerptBlock[]>(),
}, (t) => [
  uniqueIndex("idx_versions_item_number").on(t.itemId, t.number),
  uniqueIndex("idx_versions_item_position").on(t.itemId, t.position).where(sql`${t.position} IS NOT NULL`),
  // What one actor published (the dashboard's `recent`).
  index("idx_versions_publisher").on(t.publisherType, t.publisherId, t.itemId),
  check("versions_publisher_type", sql`${t.publisherType} IN ('user', 'agent')`),
  check("versions_revoked_by", sql`(${t.revokedByType} IS NULL) = (${t.revokedById} IS NULL) AND (${t.revokedByType} IS NULL OR ${t.revokedByType} IN ('user', 'agent'))`),
  // Loose on purpose, as version_texts': an excerpt is at most 600 characters.
  check("versions_excerpt_length", sql`char_length(${t.excerpt}) <= 1000`),
  // Loose on purpose, twice what is made (ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES, and jsonb's text has more spaces); never without the text, so clearing that clears these.
  check("versions_excerpt_blocks_shape", sql`${t.excerptBlocks} IS NULL OR (${t.excerpt} IS NOT NULL AND jsonb_typeof(${t.excerptBlocks}) = 'array' AND octet_length(${t.excerptBlocks}::text) <= 12288)`),
]);

/**
 * Content-addressed bytes, in the platform's app-content bucket at
 * `apps/artifacts/<r2_key>` (the platform adds the prefix), one row
 * per server and sha256. Nothing here points at core's attachment storage:
 * saving an attachment as an Artifact copies its bytes in
 * (platform/attachments readAttachmentForSave), so core deletes an
 * attachment without asking the app (first-party app mechanism §八).
 *
 * A blob no version_files row points at is an upload not yet published:
 * the publish route caps their bytes per server and a maintenance sweep
 * deletes them (row, then object) a day after `created_at`, which an upload of
 * the same bytes moves forward. A `pending` row older than that is an upload
 * that never finished, swept the same way. Blobs also need their own GC once
 * items are deleted (a later segment).
 */
export const artifactBlobs = appArtifacts.table("blobs", {
  id: text("id").primaryKey(),
  /**
   * The server whose publishes uploaded the blob. Blobs are deduplicated per
   * server only, so whether bytes are already here never says anything about
   * another server's files (Tenny).
   */
  serverId: uuid("server_id").$type<ServerId>().notNull().references(() => servers.id, { onDelete: "cascade" }),
  sha256: text("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  state: text("state", { enum: ARTIFACT_BLOB_STATES }).notNull().default("ready"),
  /**
   * `servers/<server_id>/blobs/<sha256>/<id>`, relative to Artifacts' prefix
   * (blobStore.ts): one object per row, never reused by another row.
   */
  r2Key: text("r2_key").notNull(),
  /**
   * While the row is pending: the bytes its upload reserved of the server's
   * monthly file upload quota (platform/fileUploadQuota), and the quota month
   * they count in. Set in the transaction that inserts the row; cleared in
   * the one that makes it ready (committing them) or deletes it (giving them
   * back), so an upload that never finishes holds them only until the sweep.
   * Null: nothing reserved (the plan is not limited).
   */
  quotaMonth: text("quota_month"),
  quotaReservedBytes: bigint("quota_reserved_bytes", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("blobs_state", sql`${t.state} IN ('pending', 'ready')`),
  check("blobs_quota_reservation", sql`(${t.quotaMonth} IS NULL) = (${t.quotaReservedBytes} IS NULL) AND (${t.quotaMonth} IS NULL OR ${t.state} = 'pending')`),
  uniqueIndex("idx_blobs_server_sha256").on(t.serverId, t.sha256),
  // Unreferenced-upload cleanup scans by age.
  index("idx_blobs_created").on(t.createdAt),
]);

export const artifactVersionFiles = appArtifacts.table("version_files", {
  versionId: text("version_id").notNull().references(() => artifactVersions.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  blobId: text("blob_id").notNull().references(() => artifactBlobs.id, { onDelete: "restrict" }),
}, (t) => [
  primaryKey({ columns: [t.versionId, t.path] }),
  index("idx_version_files_blob").on(t.blobId),
]);

/**
 * A version's readable text as the signed-out `meta` and `index.md` answer
 * it (publicText.ts; task #110, Tenny): written for a version of a public
 * Artifact once it is current (after the push's commit, after it is made
 * public, or by the first signed-out view that finds none), so those routes
 * answer without reading storage. Only what they already serve publicly:
 * no author, server, home or viewer; links are built per request. Kept when
 * the Artifact stops being public (visibility is checked on every request,
 * before the row is read); goes with its version. A row of an older
 * `extractor`, or whose `kind` isn't the entry's kind now, is recomputed.
 */
export const artifactVersionTexts = appArtifacts.table("version_texts", {
  versionId: text("version_id").primaryKey().references(() => artifactVersions.id, { onDelete: "cascade" }),
  /** readableText.ts READABLE_TEXT_EXTRACTOR when it was computed. */
  extractor: smallint("extractor").notNull(),
  /** The entry's kind when it was computed (artifactFileType). */
  kind: text("kind").notNull(),
  /** meta's description; "" when the text has none (the kind's stub line is said then). */
  description: text("description").notNull(),
  /** The entry's readable text, trimmed, at most ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES of UTF-8. */
  body: text("body").notNull(),
  /** The entry was longer than what was read, or the text longer than `body`. */
  truncated: boolean("truncated").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Loose on purpose: description is at most 161 characters, body 200 KB.
  check("version_texts_description_length", sql`char_length(${t.description}) <= 1000`),
  check("version_texts_body_length", sql`octet_length(${t.body}) <= 262144`),
]);

/**
 * A publish check's state (checks.ts, checkTask.ts; task #130): `pending`
 * when the push recorded it, `running` while the check Worker holds its
 * lease (the version open top-level in its headless browser), then `done` or
 * `failed`; `skipped`, with its reason, when it never runs (from the start,
 * or when its lease finds a daily cap reached).
 */
export const ARTIFACT_CHECK_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type ArtifactCheckStatus = (typeof ARTIFACT_CHECK_STATUSES)[number];

/**
 * Why a check never ran: the version's files are the previous version's byte
 * for byte (`unchanged`), or the day's checks of its server, or of the whole
 * platform, are used up (checks.ts mayCheck).
 */
export const ARTIFACT_CHECK_SKIP_REASONS = ["unchanged", "server_daily_cap", "platform_daily_cap"] as const;
export type ArtifactCheckSkipReason = (typeof ARTIFACT_CHECK_SKIP_REASONS)[number];

/** What a finished check found on the page (the check Worker's report, as the check task stores it). */
export interface ArtifactCheckFindings {
  /** The page's own console errors, in order, at most ten. */
  consoleErrors: Array<{ message: string; source: string | null; line: number | null }>;
  /** What the page's content security policy blocked (Porthole's shell reports it): each resource's URL. */
  blockedResources: string[];
  /** Hardly any visible text and a nearly uniform screenshot. */
  blank: boolean;
  /** At phone width the page scrolls sideways: its content's width against the screen's. Null when it doesn't. */
  phoneOverflow: { contentWidth: number; viewportWidth: number } | null;
}

/**
 * A version's publish check (checks.ts; task #130, where the
 * deployment has a check Worker): at most one per version, going with it (ON
 * DELETE CASCADE, so with its item and its server too). Its screenshots are
 * core's object files (platform/objectFiles) of the Artifact, hung on the
 * version (`version:<version id>`): `desktop_file_id` / `phone_file_id` name
 * them (no foreign key: the files are core's, read by core's route); only the
 * newest three versions of an Artifact with screenshots keep them
 * (keepNewestCheckShots clears the older rows' ids and lets their files go in
 * the same transaction). Deleting the Artifact deletes its rows and lets
 * every file of the Artifact go in the delete's transaction; core deletes the
 * bytes after it commits, and a soft-deleted server's files in its own sweep.
 */
export const artifactVersionChecks = appArtifacts.table("version_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  versionId: text("version_id").notNull().references(() => artifactVersions.id, { onDelete: "cascade" }),
  status: text("status", { enum: ARTIFACT_CHECK_STATUSES }).notNull().default("pending"),
  /** Set exactly when `skipped`. */
  skipReason: text("skip_reason", { enum: ARTIFACT_CHECK_SKIP_REASONS }),
  /** A `done` check's screenshot at desktop width, a core object file of the Artifact (null: none, or cleared). */
  desktopFileId: uuid("desktop_file_id").$type<ObjectFileId>(),
  /** The same at phone width. */
  phoneFileId: uuid("phone_file_id").$type<ObjectFileId>(),
  /** A `done` check's findings. */
  findings: jsonb("findings").$type<ArtifactCheckFindings>(),
  /**
   * A `failed` check's cause, code-shaped, never a message from the page: the check Worker's
   * (`load_timeout`, `load_error:<class>`) or the check task's (checkTask.ts: `not_readable`,
   * `not_framed`, `not_checked`, `disabled`, `expired`, `lease_expired`).
   */
  errorClass: text("error_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** When it ended (done, failed) or was skipped; null while pending or running. */
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /**
   * A running check's lease (Tenny, #proj-workspace:#130): its subject may read the version only
   * until then, so a task that died mid-check leaves no open door. Set when it starts running.
   */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("idx_version_checks_version").on(t.versionId),
  // The daily caps count today's checks that run (mayCheck, mayStartCheck); a
  // lease (checkTask.ts) that finds a cap reached skips a pending row, which
  // then leaves the index. The lease and expiry read recent rows through it.
  index("idx_version_checks_created").on(t.createdAt).where(sql`${t.status} <> 'skipped'`),
  check("version_checks_status", sql`${t.status} IN ('pending', 'running', 'done', 'failed', 'skipped')`),
  check("version_checks_skip_reason", sql`(${t.status} = 'skipped') = (${t.skipReason} IS NOT NULL) AND (${t.skipReason} IS NULL OR ${t.skipReason} IN ('unchanged', 'server_daily_cap', 'platform_daily_cap'))`),
  check("version_checks_finished", sql`(${t.finishedAt} IS NULL) = (${t.status} IN ('pending', 'running'))`),
  check("version_checks_error_class", sql`${t.errorClass} IS NULL OR ${t.status} = 'failed'`),
  // A screenshot only of a finished check.
  check("version_checks_desktop_file", sql`${t.desktopFileId} IS NULL OR ${t.status} = 'done'`),
  check("version_checks_phone_file", sql`${t.phoneFileId} IS NULL OR ${t.status} = 'done'`),
  // Loose on purpose: ten console errors and a list of URLs are a few KB.
  check("version_checks_findings", sql`${t.findings} IS NULL OR (${t.status} = 'done' AND octet_length(${t.findings}::text) <= 65536)`),
]);

/** Comments belong to the Artifact (E1), each on the version it was written on. */
export const artifactComments = appArtifacts.table("comments", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  versionId: text("version_id").notNull().references(() => artifactVersions.id, { onDelete: "cascade" }),
  path: text("path"),
  anchor: jsonb("anchor").$type<ArtifactCommentAnchor>(),
  replyTo: text("reply_to"),
  authorType: text("author_type", { enum: ARTIFACT_ACTOR_TYPES }).notNull(),
  authorId: uuid("author_id").notNull(),
  body: text("body").notNull(),
  mentions: jsonb("mentions").$type<ArtifactCommentMention[]>().notNull().default(sql`'[]'::jsonb`),
  copiedFrom: jsonb("copied_from").$type<ArtifactCommentCopiedFrom>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /** The item's position this comment took (see items.last_position). */
  position: bigint("position", { mode: "number" }).notNull(),
  /** The review (S8) that posted it, with the others it posted at once; null for a single comment. */
  reviewId: text("review_id").references((): AnyPgColumn => artifactReviews.id, { onDelete: "set null" }),
  /**
   * Its images, in order: core object files of the item hung on
   * `comment:<id>` (commentImages.ts), as core stored them when the comment
   * was written (claimObjectFile's or moveObjectFiles' answer). Never edited;
   * a placeholder (deleted_at) keeps none, and its files go with it.
   */
  images: jsonb("images").$type<ArtifactCommentImage[]>().notNull().default(sql`'[]'::jsonb`),
  /**
   * A thread's resolution (#proj-workspace:#249, resolutions.ts): set on its
   * root only, when and by whom (an actor as the author is, type and id),
   * all three or none. Cleared by a reopen and by a reply in the thread.
   */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByType: text("resolved_by_type", { enum: ARTIFACT_ACTOR_TYPES }),
  resolvedById: uuid("resolved_by_id"),
}, (t) => [
  uniqueIndex("idx_comments_item_position").on(t.itemId, t.position),
  check("comments_anchor_needs_path", sql`${t.path} IS NOT NULL OR ${t.anchor} IS NULL`),
  check("comments_author_type", sql`${t.authorType} IN ('user', 'agent')`),
  check("comments_resolution", sql`(${t.resolvedAt} IS NULL AND ${t.resolvedByType} IS NULL AND ${t.resolvedById} IS NULL) OR (${t.resolvedAt} IS NOT NULL AND ${t.resolvedByType} IN ('user', 'agent') AND ${t.resolvedById} IS NOT NULL AND ${t.replyTo} IS NULL)`),
  index("idx_comments_item_created").on(t.itemId, t.createdAt),
  // The dashboard's `waiting` finds the comments that mention a reader
  // (`mentions @> '[{"type":"user","id":…}]'`) from this index, not by
  // walking every item.
  index("idx_comments_mentions").using("gin", t.mentions.op("jsonb_path_ops")),
  // One review's comments (`?review=`).
  index("idx_comments_review").on(t.reviewId).where(sql`${t.reviewId} IS NOT NULL`),
]);

/**
 * A review draft (S8): a person's comment not posted yet, seen only by its
 * author, shaped as the web's draft input. A reply draft (`reply_to`, a
 * comment of the same item) has no place of its own: it takes its thread's
 * when posted. `reply_to` has no foreign key on purpose: a comment with no
 * replies is deleted outright, and neither cascading (the draft gone
 * unseen) nor SET NULL (the draft silently a new thread) is right; the
 * submit refuses the draft instead (COMMENT_NOT_FOUND), so its author
 * decides. The item's delete still cascades here. `body` keeps the
 * parts as sent (mentions as actors, not text), so a submit checks each
 * mention again as it stands then; `version` is a number, looked up again
 * then. Drafts are a person's web flow (an agent reviews in one call), so the
 * author is a user.
 * At most ARTIFACT_DRAFT_MAX_PER_ARTIFACT per author and item; gone
 * ARTIFACT_DRAFT_TTL_DAYS after `updated_at` (left out of every read, then
 * deleted by the hourly `purge_artifact_drafts`).
 */
export const artifactCommentDrafts = appArtifacts.table("comment_drafts", {
  id: uuid("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull(),
  version: integer("version").notNull(),
  path: text("path"),
  anchor: jsonb("anchor").$type<ArtifactCommentAnchor>(),
  body: jsonb("body").$type<ArtifactDraftPart[]>().notNull(),
  /** The comment it replies to (`comments.id`), or null. */
  replyTo: text("reply_to"),
  /**
   * Its images, in order: core object files of the item hung on
   * `draft:<id>` (read only by their uploader, the draft's author), as core
   * stored them; moved to the comment's part when the review is submitted,
   * let go with the draft otherwise.
   */
  images: jsonb("images").$type<ArtifactCommentImage[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("comment_drafts_anchor_needs_path", sql`${t.path} IS NOT NULL OR ${t.anchor} IS NULL`),
  // A reply takes its thread's place: none of its own.
  check("comment_drafts_reply_has_no_place", sql`${t.replyTo} IS NULL OR ${t.path} IS NULL`),
  // One author's drafts on one Artifact, in the order they were made.
  index("idx_comment_drafts_author_item").on(t.authorId, t.itemId, t.createdAt),
  // The purge scans by age.
  index("idx_comment_drafts_updated").on(t.updatedAt),
]);

/**
 * A posted review (S8): several comments at once (comments.review_id), and
 * its summary when it had one. `client_key` makes a submit idempotent per
 * author and Artifact (the web's per-attempt key, an agent's optional
 * `idempotencyKey`); `request_digest` tells a retry from another review
 * under the same key.
 */
export const artifactReviews = appArtifacts.table("reviews", {
  /** A uuid (opaque to clients). */
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  authorType: text("author_type", { enum: ARTIFACT_ACTOR_TYPES }).notNull(),
  authorId: uuid("author_id").notNull(),
  /** The version it is on (an agent's review: all its comments'; a person's: the current one when submitted, its summary's). */
  version: integer("version").notNull(),
  clientKey: text("client_key"),
  requestDigest: text("request_digest").notNull(),
  summaryCommentId: text("summary_comment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("reviews_author_type", sql`${t.authorType} IN ('user', 'agent')`),
  // An Artifact's reviews (its delete cascades here; `?review=` looks one up by item).
  index("idx_reviews_item").on(t.itemId),
  uniqueIndex("idx_reviews_client_key").on(t.itemId, t.authorType, t.authorId, t.clientKey).where(sql`${t.clientKey} IS NOT NULL`),
]);

/** Changes to an Artifact worth keeping (D7): home changes, going public, deletion, import. */
export const artifactAudit = appArtifacts.table("audit", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ARTIFACT_ACTOR_TYPES }).notNull(),
  /**
   * Always a real actor. Actions the system takes on its own (scheduled
   * cleanup, the D1 import) get one fixed system actor when they arrive: a
   * fixed id with actor_type still user or agent. The constraint is not
   * relaxed for them.
   */
  actorId: uuid("actor_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_audit_item_created").on(t.itemId, t.createdAt),
]);

/** Which Artifact an attachment was saved as ("saved as Artifact" on the message). */
export const artifactAttachmentSaves = appArtifacts.table("attachment_saves", {
  attachmentId: uuid("attachment_id").primaryKey().references(() => attachments.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  versionId: text("version_id").notNull().references(() => artifactVersions.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_attachment_saves_item").on(t.itemId),
]);

/**
 * How far each person or agent has looked at an Artifact: an item position
 * (items.last_position). Only ever moves forward (GREATEST).
 */
export const artifactReadPositions = appArtifacts.table("read_positions", {
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ARTIFACT_ACTOR_TYPES }).notNull(),
  actorId: uuid("actor_id").notNull(),
  position: bigint("position", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.itemId, t.actorType, t.actorId] }),
  check("read_positions_actor_type", sql`${t.actorType} IN ('user', 'agent')`),
  // One actor's read positions (the dashboard's `recent` and `waiting`); the primary key leads with the item.
  index("idx_read_positions_actor").on(t.actorType, t.actorId, t.itemId),
]);

/** How an actor came to follow an Artifact: it published, it commented, or it chose to (PUT subscription). */
export const ARTIFACT_SUBSCRIPTION_REASONS = ["published", "commented", "followed"] as const;
export type ArtifactSubscriptionReason = (typeof ARTIFACT_SUBSCRIPTION_REASONS)[number];

/**
 * Who follows an Artifact (S1c). Publishing or commenting adds a row unless
 * one exists; an explicit stop sets `unsubscribed_at` and keeps the row, so
 * publishing or commenting again doesn't follow it again (sticky) until the
 * actor follows it (PUT clears it). People follow too (the web API), but only
 * agents are told anything for now (people's Activity is S6).
 */
export const artifactSubscriptions = appArtifacts.table("subscriptions", {
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  actorType: text("actor_type", { enum: ARTIFACT_ACTOR_TYPES }).notNull(),
  actorId: uuid("actor_id").notNull(),
  /** How the row came to be (the first time): published, commented or followed. */
  reason: text("reason", { enum: ARTIFACT_SUBSCRIPTION_REASONS }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set when the actor stopped following; null while following. */
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.itemId, t.actorType, t.actorId] }),
  check("subscriptions_actor_type", sql`${t.actorType} IN ('user', 'agent')`),
  check("subscriptions_reason", sql`${t.reason} IN ('published', 'commented', 'followed')`),
  // What one actor follows (the dashboard's `following`); the primary key leads with the item.
  index("idx_subscriptions_actor").on(t.actorType, t.actorId, t.itemId),
]);

/**
 * Legacy (#55): followers' comment notices that were waiting to go out. Until
 * #55 one row per Artifact and agent collected the comments others wrote
 * within two minutes of the first, then the flush job
 * (flushDueArtifactNotices) sent them as one notice and deleted the row.
 * Followers are now told of each comment at once and nothing writes here; the
 * flush job only drains rows queued before that. Drop the table (and the job)
 * once none can remain. No foreign key to the agent: a deleted agent's row is
 * dropped when it falls due (it sees nothing).
 */
export const artifactPendingNotices = appArtifacts.table("pending_notices", {
  itemId: text("item_id").notNull().references(() => artifactItems.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull(),
  /** The comments collected, oldest first. */
  commentIds: text("comment_ids").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Two minutes after the first comment. */
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.itemId, t.agentId] }),
  index("idx_pending_notices_due").on(t.dueAt),
]);

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Search (S9): one row per Artifact, its title's index-side tokens
 * (searchTokenizer.ts, buildSearchIndexText) and their tsvector. Title only,
 * by product decision (xxchan, 2026-10-23); content search is deferred.
 * Written in the same transaction as whatever sets the title (publish;
 * renames and metadata edits through indexArtifactSearch); removed with the
 * item (cascade). The title lives on the item, so there is no version to
 * fence: the row follows the item's title, not a version.
 */
export const artifactSearch = appArtifacts.table("search", {
  itemId: text("item_id").primaryKey().references(() => artifactItems.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").$type<ServerId>().notNull().references(() => servers.id, { onDelete: "cascade" }),
  titleTokens: text("title_tokens").notNull(),
  searchVector: tsvector("search_vector").notNull().generatedAlwaysAs(sql`to_tsvector('simple', title_tokens)`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_search_vector_gin").using("gin", t.searchVector),
]);

/**
 * An operator's purge of one Artifact (purge.ts purgeArtifact; runbook
 * docs/operations/artifact-takedown.md): the record that outlives it, since
 * everything else of the Artifact goes, its audit rows included. Only the
 * counts of what went (`removed`) and the reason, beside the Artifact's id
 * and server (no foreign key to either: the record stays when they go) and
 * when. Never its title or content, nor who ran or
 * approved it: those are in the script's receipt and the approval thread;
 * the reason is the operator's own words and must not repeat the content
 * (the runbook says so). `pending_object_keys`: the storage keys of its
 * deleted blobs whose object isn't deleted yet (relative, as blobs.r2_key),
 * only until a delete of it succeeds: the purge deletes them right after
 * its commit and keeps only the ones that failed; running it again retries
 * them and clears each that goes. One row per Artifact: a second run finds
 * it.
 */
export const artifactPurges = appArtifacts.table("purges", {
  itemId: text("item_id").primaryKey(),
  serverId: uuid("server_id").$type<ServerId>().notNull(),
  reason: text("reason").notNull(),
  removed: jsonb("removed").$type<Record<string, number>>().notNull(),
  pendingObjectKeys: text("pending_object_keys").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("purges_reason_length", sql`char_length(${t.reason}) BETWEEN 1 AND 1000`),
]);

export type ArtifactItemRow = typeof artifactItems.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
export type ArtifactCommentRow = typeof artifactComments.$inferSelect;
export type ArtifactBlobRow = typeof artifactBlobs.$inferSelect;
export type ArtifactVersionFileRow = typeof artifactVersionFiles.$inferSelect;
export type ArtifactSubscriptionRow = typeof artifactSubscriptions.$inferSelect;
export type ArtifactCommentDraftRow = typeof artifactCommentDrafts.$inferSelect;
export type ArtifactReviewRow = typeof artifactReviews.$inferSelect;
export type ArtifactVersionCheckRow = typeof artifactVersionChecks.$inferSelect;
