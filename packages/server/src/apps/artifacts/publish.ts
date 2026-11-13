// Pushing (S1b; `publish` in code): `POST /artifacts/push` and `PUT /artifacts/uploads/:sha256`.
//
// A publish names the files it changes; everything else carries over. It is
// checked in this order, and nothing is written until the last step:
//
// 1. the request itself (limits, paths, inline bytes, a title that isn't
//    blank), then who may publish: a new Artifact needs a title (400
//    TITLE_REQUIRED; it has no name, #proj-workspace:98241a2e) and a
//    `target` conversation the agent can see; a new version needs an
//    Artifact it can see (else 404 NOT_VISIBLE) and to be an agent of its
//    server (else 403 FORBIDDEN, D9);
// 2. the same request already went through (a version this agent made from
//    it on the same base, current or not): answer that version (`replayed`);
// 3. the base (freshness v2 §2.1): if versions came after `base`, the changes
//    others made in them are compared with this request's. Files or settings
//    both changed to different outcomes: 409 BASE_MOVED with just those.
//    Otherwise the new version is the current one plus this request's
//    changes, and reports what it took in (`merged`). If that is the current
//    version exactly, nothing is written (200 `unchanged`); if it differs
//    only in its title, the item takes the title without a new version (200
//    `unchanged` with `titleChanged`, in step 6's transaction: Tenny), the
//    search index too, a `renamed` object event records it, and the other
//    agents that follow it are told, without waking them (rename.ts
//    retitleItem, the web's rename too);
// 4. comments: others' comments since the agent last looked (its read
//    position, or `seen`) on files this request changes, or on the whole
//    Artifact, hold it: 409 UNSEEN_CHANGES with the newest few, and the read
//    position moves over those it shows in full (past others' versions in
//    between, counted in `skipped`), stopping before the first comment by
//    others it doesn't show in full (apiCommon shownThrough): the same
//    request again goes through unless some are left `unread` (then the
//    comments list shows them in full). Others' comments on other files are
//    only counted;
// 5. bytes: listed blobs this server lacks answer 200 `{ missing }`; inline
//    files are stored. New bytes (not those the server has) count against
//    the server's monthly file upload quota, the attachments' one: no room
//    for all of them is 403 FILE_UPLOAD_QUOTA_EXCEEDED, nothing stored. The
//    listed ones are checked by their declared sizes before `{ missing }`
//    is answered, so a push that can't fit is refused before any upload
//    (the CLI's: it lists every file), with the upgrade card where one can
//    go; the upload route still checks each upload's own bytes;
// 6. in one transaction, the item row locked: steps 3 and 4 again on what is
//    current now, the blobs locked, then the version, its files, the item's
//    current version and position. The publisher's read position moves to the
//    new version, but not past others' comments it wasn't shown (those on
//    other files, `unseen.otherComments`): it stops before the first; the
//    object event is recorded; the publisher follows the
//    Artifact (unless it stopped); other followers who were the last to
//    publish a file this version changed are told (notices.ts), pushed after
//    the commit. The search index gets the item's title (search.ts). A
//    public Artifact's new version has its signed-out text stored after the
//    commit, in the background (publicText.ts fillPublicText; from the
//    entry's inline bytes when it came inline), never failing the push.
//    When the entry is a page, the answer's `warnings` say which of the
//    version's pages hold themselves to one screen or hold frames of their own
//    (scrollLock.ts: Porthole's scroll-lock and nested-frame rules, and a
//    page script's createElement of a frame), and which of the scripts and
//    stylesheets it brings are copies of common libraries a page may load
//    from a library CDN (bundledLibraries.ts); best effort, bounded in bytes
//    and time. A Markdown entry's excerpt, what its card shows, is stored
//    beside them, as bounded, never failing the push (excerpt.ts
//    fillVersionExcerpt). For an entry a check opens (HTML: shared
//    ARTIFACT_CHECKED_KINDS) the version's publish check is recorded in the
//    same transaction, in a savepoint (checks.ts recordVersionCheck:
//    `pending`, or `skipped` from the start; nothing where the deployment
//    has no check Worker; a failure rolls back the check alone and
//    never fails the push), and the answer's `check` names it. A replay (step
//    2) answers the check of the version it names as it is now.
//
// The agent API's push is one door into this order (`publish`); the other is
// a person's, their personal assistant publishing as them (publishAs.ts):
// both run `publishWith`, which takes who the publish is for (Publisher: the
// author the rows record, its server, and the reader whose read position
// step 4 reads and moves) and what the door brings (PublishDoor: step 1's
// where and whether, how the answer names the Artifact, the assistant's mark).
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, max, notInArray, or, sql } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_MAX_BINARY_FILE_BYTES,
  AGENT_API_ARTIFACT_MAX_DESCRIPTION_CHARS,
  AGENT_API_ARTIFACT_MAX_FILES_PER_REQUEST,
  AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION,
  AGENT_API_ARTIFACT_MAX_INLINE_FILE_BYTES,
  AGENT_API_ARTIFACT_MAX_INLINE_REQUEST_BYTES,
  AGENT_API_ARTIFACT_MAX_LABEL_CHARS,
  AGENT_API_ARTIFACT_MAX_NOTE_CHARS,
  AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES,
  AGENT_API_ARTIFACT_MAX_TITLE_CHARS,
  AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES,
  AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN,
  artifactFileType,
  currentDate,
  isWellFormedArtifactFilePath,
  RAFT_HINTS,
  type AgentApiArtifactMergedChange,
  type AgentApiArtifactPublishBody,
  type AgentApiArtifactPublished,
  type AgentApiArtifactPublishResponse,
  type AgentApiArtifactPushCheck,
  type AgentApiArtifactSetting,
  type AgentApiArtifactSummary,
  type AgentApiArtifactUploadParams,
  type ServerId,
} from "@botiverse/raft-shared";
import { AGENT_LOUNGE_PLACEMENT_REFUSAL, agentMayPlaceInConversation, resolveConversationTarget } from "../../platform/conversations";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { checkFileUploadQuota, FileUploadQuotaExceededError } from "../../platform/fileUploadQuota";
import {
  advanceReadPosition,
  agentActor,
  answer,
  ArtifactApiFailure,
  byOthersThan,
  byteSize,
  currentVersionOf,
  excerptOf,
  fail,
  fileUploadQuotaRefusal,
  imageCountOf,
  invalidPath,
  json,
  liveComment,
  mayNotTakePart,
  namer,
  notVisible,
  positionCursor,
  readableVersion,
  readPositionOf,
  requireEnabled,
  resolveVisibleItem,
  shownInFull,
  shownThrough,
  storageUnavailable,
  summarize,
  targetNotFound,
  unseenChangesError,
  versionNotFound,
  versionNumbers,
  type ArtifactActorRef,
  type ArtifactAgent,
  type ArtifactApiEmpty,
  type ArtifactApiError,
  type ArtifactApiJson,
  type ArtifactApiResult,
  type ArtifactNoticeOutbox,
  type ArtifactRefusal,
  type QuotaCardPlace,
} from "./apiCommon";
import { byteSizeBucket, countBucket, withAppSpan } from "../../platform/tracing";
import { presentBlobs, storeBlob, unreferencedBytes } from "./blobs";
import { artifactR2Store } from "./blobStore";
import { announceObjectEvents } from "../../platform/activity";
import { recordVersionCheck, versionCheckOf } from "./checks";
import { fillVersionExcerpt } from "./excerpt";
import { followerRecipients, recordArtifactEvent } from "./events";
import type { ArtifactHomeRef } from "./names";
import { channelAnnouncementPushRefused } from "./announcement";
import { autoSubscribe, followersOf, noticeChannelAnnouncement, noticeVersion, sendQueued, type NotifiedAgent, type QueuedNotice } from "./notices";
import {
  artifactComments,
  artifactItems,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactCommentRow,
  type ArtifactItemRow,
  type ArtifactVersionCheckRow,
  type ArtifactVersionRow,
} from "./schema";
import { fillPublicText } from "./publicText";
import { mayPublish, retitleItem, storedTitle } from "./rename";
import { scrollLockWarnings } from "./scrollLock";
import { indexArtifactSearch } from "./search";
import { answerAttrs, answerStatus } from "./trace";

/** One file this request lists, with its bytes when they came inline. */
interface ListedFile {
  path: string;
  sha256: string;
  size: number;
  inline: Buffer | null;
}

/** The request, checked: what step 1 leaves for the rest. */
interface PublishRequest {
  listed: ListedFile[];
  deletes: string[];
  entry: string | undefined;
  title: string | undefined;
  description: string | undefined;
  label: string | null;
  note: string | null;
  base: number | undefined;
  seen: number | undefined;
}

/**
 * Who a publish is for (publishWith). `actor`: the author its rows record (a
 * new Artifact's creator, the version's publisher, the object event's actor,
 * who follows it, whose own earlier versions aren't "others'" for the base):
 * an agent through the agent API, or a person their personal assistant
 * publishes for (publishAs.ts). `serverId`: the actor's server, whose quota
 * the bytes count on. `reader`: whose read position the unseen-comments hold
 * reads and moves (step 4, and the new version's in step 6): the actor itself
 * for an agent; for a person, the assistant, who wrote what it pushes and is
 * the one shown the comments (Tenny, #proj-assistant:#31, option 2), so a
 * person's own read position and Activity are never moved by it.
 */
export interface Publisher {
  actor: ArtifactActorRef;
  serverId: ServerId;
  reader: ArtifactActorRef;
}

const agentPublisher = (agent: ArtifactAgent): Publisher => ({ actor: agentActor(agent), serverId: agent.serverId, reader: agentActor(agent) });

/** Agents a publisher's notices leave out besides the actor: the reader, when it is an agent other than the actor (an assistant isn't told of its own push). */
const quietOf = (publisher: Publisher): string[] =>
  (publisher.reader.type === "agent" && !(publisher.actor.type === "agent" && publisher.actor.id === publisher.reader.id) ? [publisher.reader.id] : []);

/** A file of a version: its bytes' sha256 and size, and the blob row once known. */
interface ManifestFile {
  sha256: string;
  size: number;
  blobId: string | null;
}
type Manifest = Map<string, ManifestFile>;

/** A change by someone else after the base (to a file, or a setting). */
interface OthersChange {
  path: string | null;
  setting: AgentApiArtifactSetting | null;
  version: ArtifactVersionRow;
}

/** What publishing would make, against the versions as they are now. */
type Evaluation =
  | { kind: "base_moved"; base: ArtifactVersionRow; current: ArtifactVersionRow; overlaps: OthersChange[] }
  | {
    kind: "held";
    comments: ArtifactCommentRow[];
    count: number;
    after: number;
    /** How far the read position moves: over what the hold shows in full (shownThrough). */
    through: number;
    /** Of `count`, how many it leaves unseen: the same request again is held while any are. */
    unread: number;
    /** What else moving the read position to `through` passes over: others' versions (never a comment: shownThrough stops before one not shown). */
    skipped: { versions: number; otherComments: number };
  }
  /** The result would be the current version exactly (files and settings): nothing to publish. */
  | { kind: "unchanged"; current: ArtifactVersionRow; base: ArtifactVersionRow }
  /** The result would be the current version but for the title: the item takes `title`, no version is made. */
  | { kind: "retitled"; current: ArtifactVersionRow; base: ArtifactVersionRow; title: string }
  | {
    kind: "ok";
    files: Manifest;
    entry: string;
    title: string;
    description: string | null;
    /** Paths this request adds or replaces (not those it lists unchanged), and removes. */
    changed: string[];
    deleted: string[];
    merged: OthersChange[];
    base: ArtifactVersionRow | null;
    previous: ArtifactVersionRow | null;
    otherComments: number;
  };

const SETTINGS: readonly AgentApiArtifactSetting[] = ["entry", "title", "description"];

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const chars = (value: string): number => Array.from(value).length;
const refuse = (status: number, refusal: ArtifactRefusal): never => {
  throw new ArtifactApiFailure(fail(status, refusal));
};

/**
 * A new Artifact without a title (the doc's own example, docs/contracts/agent-api-refusals.md):
 * the sentence names no command; the step says how in each client's words.
 */
export const TITLE_REQUIRED_ERROR = "A new artifact needs a title: give it one, or give its entry page a <title>.";
const TITLE_STEP = "Give the push a title people will recognise (--title on the CLI, title in a tool call), or give the entry page a <title>, then push again.";

/** The body's length isn't its Content-Length: a client's bug, the same upload may go through again. */
const UPLOAD_LENGTH_ERROR = "The upload didn't arrive whole (its bytes don't match its Content-Length): upload the same bytes again, and if it keeps failing it is a client bug to report.";

/** What each limited field of a push is called in a refusal. */
const FIELD_WORDS: Record<string, string> = { label: "label", note: "note", title: "title", description: "description" };

/** A file over its size limit, as a push refuses it. */
const tooLarge = (size: number, limit: number, inline: boolean): string => inline
  ? `A file sent inline is ${byteSize(size)}, over the ${byteSize(limit)} an inline file may be: upload it by its sha256 instead, or make it smaller.`
  : `A file is ${byteSize(size)}, over the ${byteSize(limit)} a file of its kind may be: make it smaller, or leave it out of the artifact.`;

/** The server holds too many uploaded bytes no version uses yet. */
const uploadQuotaExceeded = (used: number, limit: number): ArtifactApiError => fail(413, {
  code: "UPLOAD_QUOTA_EXCEEDED",
  error: `This server holds ${byteSize(used)} of uploaded files no version uses yet, against a limit of ${byteSize(limit)}: try again later (unused uploads are removed after a day), or tell an admin of this server.`,
  details: { used, limit },
});

/**
 * Canonical base64 (padded, standard alphabet), or null. Linear: a regex over
 * a multi-megabyte string overflows V8's backtracking stack.
 */
function decodeBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

/** Text files (pages, scripts, styles, data, SVG) may be 16 MiB, others 15 MiB. */
const fileLimitOf = (path: string): number => (artifactFileType(path).text ? AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES : AGENT_API_ARTIFACT_MAX_BINARY_FILE_BYTES);

/** Step 1: the request alone, before anything is looked up. */
function checkRequest(body: AgentApiArtifactPublishBody): PublishRequest {
  // A `name` an older client sends is ignored: Artifacts have none any more.
  if (body.artifact !== undefined && body.target !== undefined) {
    refuse(400, { code: "agent_api_contract_invalid", error: "A target only places a new artifact, and this push names an existing one: leave the target out to push a new version of it." });
  }
  if (body.artifact === undefined && body.base !== undefined) {
    refuse(400, { code: "agent_api_contract_invalid", error: "A new artifact has no earlier version to base on: leave base out, or name the artifact to push a new version of it." });
  }
  const fields: Array<[string, string | undefined, number]> = [
    ["label", body.label, AGENT_API_ARTIFACT_MAX_LABEL_CHARS],
    ["note", body.note, AGENT_API_ARTIFACT_MAX_NOTE_CHARS],
    ["title", body.title, AGENT_API_ARTIFACT_MAX_TITLE_CHARS],
    ["description", body.description, AGENT_API_ARTIFACT_MAX_DESCRIPTION_CHARS],
  ];
  for (const [field, value, limit] of fields) {
    if (value !== undefined && chars(value) > limit) {
      refuse(400, { code: "FIELD_TOO_LONG", error: `The ${FIELD_WORDS[field] ?? field} can be at most ${limit} characters: shorten it and push again.`, details: { field, limit } });
    }
  }
  // A title is one line wherever agents read it, and trimmed: an Artifact is looked up by its exact title.
  const title = body.title === undefined ? undefined : storedTitle(body.title);
  if (title === "") {
    refuse(400, {
      code: "TITLE_REQUIRED",
      error: "A title can't be blank: give one with words in it, then push again.",
      suggestedNextAction: TITLE_STEP,
      details: { blank: true },
    });
  }

  const deletes = body.delete ?? [];
  const count = body.files.length + deletes.length;
  if (count > AGENT_API_ARTIFACT_MAX_FILES_PER_REQUEST) {
    refuse(413, {
      code: "TOO_MANY_FILES",
      error: `A push lists at most ${AGENT_API_ARTIFACT_MAX_FILES_PER_REQUEST} files and this one has ${count}: push part of the change first (files not listed carry over unchanged), then the rest.`,
      details: { count, limit: AGENT_API_ARTIFACT_MAX_FILES_PER_REQUEST },
    });
  }
  const seenPaths = new Set<string>();
  for (const path of [...body.files.map((file) => file.path), ...deletes]) {
    if (!isWellFormedArtifactFilePath(path)) throw new ArtifactApiFailure(invalidPath(path));
    if (seenPaths.has(path)) {
      refuse(400, { code: "DUPLICATE_PATH", error: "A path is listed twice, or both sent and deleted, in this push: list each path once.", details: { path } });
    }
    seenPaths.add(path);
  }
  if (body.entry !== undefined && !isWellFormedArtifactFilePath(body.entry)) throw new ArtifactApiFailure(invalidPath(body.entry));

  let inlineTotal = 0;
  const listed = body.files.map((file): ListedFile => {
    let inline: Buffer | null = null;
    if ("content" in file) inline = Buffer.from(file.content, "utf8");
    else if ("content_base64" in file) {
      inline = decodeBase64(file.content_base64);
      if (!inline) {
        refuse(400, { code: "INVALID_CONTENT", error: "A file's content_base64 isn't valid padded base64: send it base64-encoded, or as content if it is text.", details: { path: file.path } });
      }
    }
    const size = inline ? inline.length : (file as { size: number }).size;
    const limit = fileLimitOf(file.path);
    if (size > limit) refuse(413, { code: "FILE_TOO_LARGE", error: tooLarge(size, limit, false), details: { path: file.path, size, limit } });
    if (inline) {
      if (size > AGENT_API_ARTIFACT_MAX_INLINE_FILE_BYTES) {
        refuse(413, {
          code: "FILE_TOO_LARGE",
          error: tooLarge(size, AGENT_API_ARTIFACT_MAX_INLINE_FILE_BYTES, true),
          details: { path: file.path, size, limit: AGENT_API_ARTIFACT_MAX_INLINE_FILE_BYTES },
        });
      }
      inlineTotal += size;
      if (inlineTotal > AGENT_API_ARTIFACT_MAX_INLINE_REQUEST_BYTES) {
        refuse(413, {
          code: "REQUEST_TOO_LARGE",
          error: `The files sent inline are over ${byteSize(AGENT_API_ARTIFACT_MAX_INLINE_REQUEST_BYTES)} together: send fewer or smaller files per push (the rest can follow, since files not listed carry over), or upload the large ones by their sha256.`,
          details: { limit: AGENT_API_ARTIFACT_MAX_INLINE_REQUEST_BYTES },
        });
      }
    }
    return { path: file.path, sha256: inline ? sha256Hex(inline) : (file as { sha256: string }).sha256, size, inline };
  });
  return {
    listed,
    deletes,
    entry: body.entry,
    title,
    description: body.description,
    label: body.label ?? null,
    note: body.note ?? null,
    base: body.base,
    seen: body.seen,
  };
}

/**
 * A request's identity: the same request again (same base or home, files,
 * deletes and words) has the same digest, so a repeat finds the version it
 * made (Raft Artifacts' publishDigest).
 */
function digestOf(request: PublishRequest, where: { base: number } | { conversationId: string }): string {
  return createHash("sha256").update(JSON.stringify([
    where,
    [...request.listed].sort((a, b) => (a.path < b.path ? -1 : 1)).map((file) => [file.path, file.sha256]),
    [...request.deletes].sort(),
    request.entry ?? null,
    request.title ?? null,
    request.description ?? null,
    request.label,
    request.note,
  ])).digest("hex");
}

async function manifestsOf(executor: DatabaseExecutor, versionIds: readonly string[]): Promise<Map<string, Manifest>> {
  const manifests = new Map<string, Manifest>(versionIds.map((id) => [id, new Map()]));
  if (versionIds.length === 0) return manifests;
  const rows = await executor.select().from(artifactVersionFiles).where(inArray(artifactVersionFiles.versionId, [...versionIds]));
  for (const row of rows) manifests.get(row.versionId)!.set(row.path, { sha256: row.sha256, size: row.sizeBytes, blobId: row.blobId });
  return manifests;
}

const settingOf = (version: ArtifactVersionRow, setting: AgentApiArtifactSetting): string | null => version[setting];
const publishedBy = (version: ArtifactVersionRow, actor: ArtifactActorRef): boolean => version.publisherType === actor.type && version.publisherId === actor.id;

/** Paths added, changed or removed from `before` to `after`. */
function changedPaths(before: Manifest, after: Manifest): string[] {
  const paths = new Set<string>();
  for (const [path, file] of after) if (before.get(path)?.sha256 !== file.sha256) paths.add(path);
  for (const path of before.keys()) if (!after.has(path)) paths.add(path);
  return [...paths].sort();
}

/**
 * Steps 3 and 4 for a new version, on `item` as `executor` sees it. `report`:
 * describe how a version already made from this request was made, as if
 * `current` were current (a replay), without the comment and unchanged
 * checks. Throws for a base that isn't a published version or a delete the
 * base doesn't have.
 */
async function evaluateVersion(
  executor: DatabaseExecutor,
  publisher: Publisher,
  item: ArtifactItemRow,
  request: PublishRequest,
  opts: { report?: { current: ArtifactVersionRow } } = {},
): Promise<Evaluation> {
  const current = opts.report?.current ?? await currentVersionOf(item, executor);
  const [base] = await executor.select().from(artifactVersions)
    .where(and(readableVersion(item.id), eq(artifactVersions.number, request.base!))).limit(1);
  if (!base || !current || base.number > current.number) {
    throw new ArtifactApiFailure(versionNotFound(item.id, request.base ?? null, current?.number ?? null));
  }
  const between = base.id === current.id
    ? []
    : await executor.select().from(artifactVersions)
      .where(and(readableVersion(item.id), gt(artifactVersions.number, base.number), sql`${artifactVersions.number} <= ${current.number}`))
      .orderBy(asc(artifactVersions.number));
  const manifests = await manifestsOf(executor, [base.id, ...between.map((version) => version.id)]);
  const baseFiles = manifests.get(base.id)!;
  for (const path of request.deletes) {
    if (!baseFiles.has(path)) {
      refuse(400, {
        code: "FILE_NOT_FOUND",
        error: `A path to delete isn't a file of v${base.number}, the version this push is based on: delete only paths its file list shows.`,
        next: RAFT_HINTS.artifactRead({ artifact: item.id, version: base.number, files: true }),
        details: { path, version: base.number },
      });
    }
  }
  // A listed file the base already has, byte for byte, is no change.
  const changes = request.listed.filter((file) => baseFiles.get(file.path)?.sha256 !== file.sha256);
  const touched = new Set([...changes.map((file) => file.path), ...request.deletes]);
  const wanted = { entry: request.entry, title: request.title, description: request.description };
  const settingsTouched = new Set(SETTINGS.filter((setting) => wanted[setting] !== undefined && wanted[setting] !== settingOf(base, setting)));

  // Others' changes, version by version, after the base.
  const others: OthersChange[] = [];
  let previous = base;
  for (const version of between) {
    if (!publishedBy(version, publisher.actor)) {
      for (const path of changedPaths(manifests.get(previous.id)!, manifests.get(version.id)!)) others.push({ path, setting: null, version });
      for (const setting of SETTINGS) if (settingOf(version, setting) !== settingOf(previous, setting)) others.push({ path: null, setting, version });
    }
    previous = version;
  }
  // Deleting the entry file while others moved the entry is about the entry too.
  const currentFiles = manifests.get(current.id) ?? baseFiles;
  if (request.entry === undefined && request.deletes.includes(current.entry)) settingsTouched.add("entry");
  // An overlap is a path or setting both changed, to different outcomes: if
  // others already made it what this request makes it, nothing collides.
  const wantedFile = new Map<string, string | null>([...changes.map((file): [string, string | null] => [file.path, file.sha256]), ...request.deletes.map((path): [string, null] => [path, null])]);
  const overlaps = others.filter((change) => (change.path !== null
    ? wantedFile.has(change.path) && wantedFile.get(change.path) !== (currentFiles.get(change.path)?.sha256 ?? null)
    : settingsTouched.has(change.setting!) && (wanted[change.setting!] ?? null) !== settingOf(current, change.setting!)));
  if (overlaps.length > 0) return { kind: "base_moved", base, current, overlaps };

  // The current version's files (the base's, when it is current), then this request's.
  const files: Manifest = new Map(currentFiles);
  for (const file of changes) files.set(file.path, { sha256: file.sha256, size: file.size, blobId: null });
  for (const path of request.deletes) files.delete(path);
  const entry = request.entry ?? current.entry;
  const title = request.title ?? item.title;
  const description = request.description ?? item.description;

  let otherComments = 0;
  if (!opts.report) {
    const same = files.size === currentFiles.size && [...files].every(([path, file]) => currentFiles.get(path)?.sha256 === file.sha256);
    if (same && entry === current.entry && description === item.description) {
      // A new title alone is the item's (Tenny): no version for it, so nothing for others' comments to hold.
      return title === item.title ? { kind: "unchanged", current, base } : { kind: "retitled", current, base, title };
    }
    // The reader's (Publisher): the agent's own, or the assistant's for a person it pushes for.
    const after = request.seen ?? await readPositionOf(publisher.reader, item.id, executor) ?? 0;
    const theirs = and(liveComment(item.id), gt(artifactComments.position, after), byOthersThan(publisher.reader).comment)!;
    const touchedPaths = [...touched];
    // The whole Artifact's comments, and those on files this request changes.
    const holds = touchedPaths.length > 0 ? or(isNull(artifactComments.path), inArray(artifactComments.path, touchedPaths))! : isNull(artifactComments.path);
    const [{ count } = { count: 0 }] = await executor.select({ count: sql<number>`count(*)::int` }).from(artifactComments).where(and(theirs, holds));
    if (count > 0) {
      const newest = await executor.select().from(artifactComments).where(and(theirs, holds))
        .orderBy(desc(artifactComments.position)).limit(AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN);
      // The read position moves over the held comments the answer shows in
      // full, past others' versions in between (reported, since they weren't
      // shown), and stops before the first comment by others it doesn't show
      // in full: cut short, older than the few shown, or on another file.
      const full = newest.filter(shownInFull).map((comment) => comment.position);
      const through = await shownThrough(executor, publisher.reader, item.id, after, newest[0]!.position, new Set(full), { allVersions: true });
      const [{ versions } = { versions: 0 }] = await executor.select({ versions: sql<number>`count(*)::int` }).from(artifactVersions).where(and(
        readableVersion(item.id), byOthersThan(publisher.reader).version, gt(artifactVersions.position, after), sql`${artifactVersions.position} <= ${through}`,
      ));
      // Every comment by others up to `through` is a held one shown in full.
      const unread = Math.max(0, count - full.filter((at) => at <= through).length);
      return { kind: "held", comments: newest.reverse(), count, after, through, unread, skipped: { versions, otherComments: 0 } };
    }
    const elsewhere = touchedPaths.length > 0 ? and(isNotNull(artifactComments.path), notInArray(artifactComments.path, touchedPaths))! : isNotNull(artifactComments.path);
    [{ count: otherComments } = { count: 0 }] = await executor.select({ count: sql<number>`count(*)::int` }).from(artifactComments).where(and(theirs, elsewhere));
  }

  return {
    kind: "ok",
    files,
    entry,
    title,
    description,
    changed: changes.map((file) => file.path).sort(),
    deleted: [...request.deletes].sort(),
    merged: others,
    base,
    previous: current,
    otherComments,
  };
}

/** Step 3 for a new Artifact (its title checked in step 1): its files are the listed ones. */
function evaluateNew(request: PublishRequest, title: string): Extract<Evaluation, { kind: "ok" }> {
  if (request.deletes.length > 0) {
    refuse(400, { code: "FILE_NOT_FOUND", error: "A new artifact has no files to delete: leave the deletes out of its first push.", details: { path: request.deletes[0], version: null } });
  }
  const files: Manifest = new Map(request.listed.map((file) => [file.path, { sha256: file.sha256, size: file.size, blobId: null }]));
  const only = files.size === 1 ? [...files.keys()][0]! : null;
  const entry = request.entry ?? (files.has("index.html") || !only ? "index.html" : only);
  return {
    kind: "ok",
    files,
    entry,
    title,
    description: request.description ?? null,
    changed: [...files.keys()].sort(),
    deleted: [],
    merged: [],
    base: null,
    previous: null,
    otherComments: 0,
  };
}

/** What every resulting version is held to. */
function checkResult(evaluation: Extract<Evaluation, { kind: "ok" }>): void {
  if (evaluation.files.size > AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION) {
    refuse(413, {
      code: "TOO_MANY_FILES",
      error: `A version holds at most ${AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION} files and this one would have ${evaluation.files.size}: remove files the artifact doesn't need, then push again.`,
      details: { count: evaluation.files.size, limit: AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION },
    });
  }
  if (!evaluation.files.has(evaluation.entry)) {
    refuse(400, {
      code: "ENTRY_NOT_FOUND",
      error: "The entry file isn't in the version this push would make: push that file too, or name an entry file that is in it.",
      details: { entry: evaluation.entry },
    });
  }
}

/** The entry's bytes when this request brought them inline (the version's own: the same sha256), else undefined. */
function inlineEntryOf(request: PublishRequest, evaluation: Extract<Evaluation, { kind: "ok" }>): Buffer | undefined {
  const listed = request.listed.find((file) => file.path === evaluation.entry);
  return listed?.inline && listed.sha256 === evaluation.files.get(evaluation.entry)?.sha256 ? listed.inline : undefined;
}

/** The bytes this request brought inline, by path, that are the version's own (the same sha256). */
function inlineFilesOf(request: PublishRequest, evaluation: Extract<Evaluation, { kind: "ok" }>): Map<string, Buffer> {
  return new Map(request.listed
    .filter((file) => file.inline && file.sha256 === evaluation.files.get(file.path)?.sha256)
    .map((file) => [file.path, file.inline!]));
}

/** Blobs this request brings that the server lacks (inline ones are stored before the commit). */
function missingOf(request: PublishRequest, evaluation: Extract<Evaluation, { kind: "ok" }>, present: ReadonlyMap<string, unknown>): string[] {
  const changed = new Set(evaluation.changed);
  return [...new Set(request.listed.filter((file) => changed.has(file.path) && !present.has(file.sha256)).map((file) => file.sha256))];
}

/** A new Artifact's home: publishing creates into a conversation. */
type NewHome = Extract<ArtifactHomeRef, { kind: "conversation" }>;

/** What a publish writes to: a new version of an item (or its title alone), or a new item with its title. */
type PublishTarget = { existing: ArtifactItemRow } | { home: NewHome; title: string };

/**
 * Where an upgrade card for this push's quota refusal goes (fileUploadQuotaRefusal
 * `card`): the Artifact's home conversation, a new one's target (a joint's
 * canonical channel, where no card goes); none for one homed in the whole
 * server or public. Its lead says the files were not stored. None for a
 * person (an assistant pushing as its owner): the card is an agent's to post,
 * and a person's id is never an agent's.
 */
function quotaCardPlace(publisher: Publisher, target: PublishTarget): QuotaCardPlace | undefined {
  if (publisher.actor.type !== "agent") return undefined;
  const channelId = "existing" in target
    ? (target.existing.homeKind === "conversation" ? target.existing.homeChannelId : null)
    : target.home.channelId;
  return { agentId: publisher.actor.id, channelId, subject: "files" };
}

/**
 * Step 5: bytes. Listed blobs this server lacks answer 200 `{ missing }`,
 * once their declared sizes (each sha256 once; bytes the server has never
 * count) fit in the monthly quota: a push that can't fit is refused here,
 * before its files are uploaded, where the Artifact's home is known for the
 * upgrade card; the upload route still checks the bytes each upload brings,
 * since a size is only declared. Inline files are stored, all their new
 * bytes checked against the monthly quota first, so a publish that doesn't
 * fit stores none of them (each store still reserves its own). Null when the
 * version's bytes are all here. A quota refusal (`artifact_publish`) offers
 * the upgrade card in the Artifact's home conversation (quotaCardPlace) where
 * the agent can post one.
 */
async function storeBytes(publisher: Publisher, request: PublishRequest, evaluation: Extract<Evaluation, { kind: "ok" }>, target: PublishTarget): Promise<ArtifactApiResult<AgentApiArtifactPublishResponse> | null> {
  const present = await presentBlobs(publisher.serverId, request.listed.map((file) => file.sha256));
  const listed = request.listed.filter((file) => file.inline === null);
  const missing = missingOf({ ...request, listed }, evaluation, present);
  const card = quotaCardPlace(publisher, target);
  if (missing.length > 0) {
    const declared = new Map(listed.map((file) => [file.sha256, file.size]));
    const refused = await monthlyQuotaRefusal(publisher, missing.reduce((sum, sha256) => sum + (declared.get(sha256) ?? 0), 0), "artifact_publish", card);
    if (refused) return refused;
    return json<AgentApiArtifactPublishResponse>({ missing }, 200);
  }
  const changed = new Set(evaluation.changed);
  const toStore = request.listed.filter((file) => file.inline !== null && changed.has(file.path) && !present.has(file.sha256));
  if (toStore.length === 0) return null;
  const store = artifactR2Store();
  if (!store) return storageUnavailable();
  const unstored = new Map(toStore.map((file) => [file.sha256, file.inline!.length]));
  const refused = await monthlyQuotaRefusal(publisher, [...unstored.values()].reduce((sum, size) => sum + size, 0), "artifact_publish", card);
  if (refused) return refused;
  for (const file of toStore) {
    const stored = await storeBlob(store, publisher.serverId, file.sha256, file.inline!);
    if (stored.kind === "quota_exceeded") return uploadQuotaExceeded(stored.used, stored.limit);
    if (stored.kind === "file_upload_quota_exceeded") return fileUploadQuotaRefusal(publisher.serverId, stored.error, "artifact_publish", card);
  }
  return null;
}

/**
 * Step 6 for a title alone, on the item locked in `tx`: rename.ts
 * retitleItem (the title and the search index, the `renamed` object event,
 * the other following agents' notices, queued, not pushed), no version
 * made. The same permission as a push: step 1's.
 */
async function retitle(tx: DatabaseExecutor, publisher: Publisher, locked: ArtifactItemRow, evaluation: Extract<Evaluation, { kind: "retitled" }>, outbox: ArtifactNoticeOutbox): Promise<Extract<Committed, { kind: "retitled" }>> {
  const quiet = quietOf(publisher);
  const { item } = await retitleItem(tx, { locked, title: evaluation.title, actor: publisher.actor, outbox, ...(quiet.length > 0 ? { except: quiet } : {}) });
  return { kind: "retitled", item, from: locked.title, current: evaluation.current, base: evaluation.base };
}

/** Why a new version is not written: a collision or a hold (409s), or nothing to publish. */
type NotWritten = Exclude<Evaluation, { kind: "ok" } | { kind: "retitled" }>;

type Committed =
  /** The item took the request's title, and no version was made. `from`: the title it had. Its notices stay queued: a rename wakes no one. */
  | { kind: "retitled"; item: ArtifactItemRow; from: string; current: ArtifactVersionRow; base: ArtifactVersionRow }
  | {
    kind: "published";
    item: ArtifactItemRow;
    version: ArtifactVersionRow;
    evaluation: Extract<Evaluation, { kind: "ok" }>;
    queued: QueuedNotice[];
    notified: NotifiedAgent[];
    newlySubscribed: boolean;
    /** Its object event, announced to people's Activity after the commit. */
    eventId: string;
    /** Its publish check, recorded in the same transaction (null: none, checks.ts recordVersionCheck). */
    check: ArtifactVersionCheckRow | null;
  }
  | { kind: "missing"; missing: string[] }
  | NotWritten;

/**
 * `bytes` new bytes don't fit in the server's monthly file upload quota: its
 * refusal, before anything is stored or read (storeBlob decides for real).
 * `card`: where its upgrade card belongs (fileUploadQuotaRefusal); the raw
 * upload has none, since it names no Artifact.
 */
async function monthlyQuotaRefusal(
  caller: { serverId: ServerId },
  bytes: number,
  via: "artifact_publish" | "artifact_upload",
  card?: QuotaCardPlace,
): Promise<ArtifactApiError | null> {
  try {
    await checkFileUploadQuota(caller.serverId, bytes);
    return null;
  } catch (error) {
    if (error instanceof FileUploadQuotaExceededError) return fileUploadQuotaRefusal(caller.serverId, error, via, card);
    throw error;
  }
}

/** `server.artifacts.publish`'s start: what the request asks, in buckets (trace.ts). */
function publishSpanAttrs(body: AgentApiArtifactPublishBody): Record<string, string> {
  const files = Array.isArray(body.files) ? body.files : [];
  const inlineBytes = files.reduce((sum, file) => sum + (
    "content" in file && typeof file.content === "string" ? Buffer.byteLength(file.content)
      : "content_base64" in file && typeof file.content_base64 === "string" ? Math.floor((file.content_base64.length * 3) / 4)
        : 0
  ), 0);
  return {
    operation: body.artifact === undefined ? "create" : "version",
    files_bucket: countBucket(files.length),
    inline_bytes_bucket: byteSizeBucket(inlineBytes),
    delete_bucket: countBucket(Array.isArray(body.delete) ? body.delete.length : 0),
  };
}

/**
 * The push answer's `check`: the row of the version the push made (recorded
 * with it: `pending` or `skipped`; a replay's as it is now, any status),
 * `skipReason` when skipped; none for no row.
 */
function pushCheckOf(row: ArtifactVersionCheckRow | null): AgentApiArtifactPushCheck | undefined {
  if (row === null) return undefined;
  return { id: row.id, status: row.status, ...(row.status === "skipped" && row.skipReason !== null ? { skipReason: row.skipReason } : {}) };
}

/** A replayed push's answer: the version's answer, and its check as it is now (none without a row or without a check Worker). */
async function withCheckOf(answered: AgentApiArtifactPublished, item: ArtifactItemRow, version: ArtifactVersionRow): Promise<AgentApiArtifactPublished> {
  const check = pushCheckOf(await versionCheckOf(version.id));
  return check ? { ...answered, check } : answered;
}

/** `server.artifacts.publish`'s end: what came of it (never what was published). */
function publishOutcomeAttrs(result: ArtifactApiResult<AgentApiArtifactPublishResponse>) {
  if (result.kind === "error") return answerAttrs(result);
  const body = result.body;
  if ("missing" in body) return { outcome: "missing", status_code: result.status ?? 200, missing_bucket: countBucket(Array.isArray(body.missing) ? body.missing.length : 0) };
  return {
    outcome: body.replayed ? "replayed" : body.titleChanged ? "retitled" : body.unchanged ? "unchanged" : "published",
    status_code: result.status ?? 200,
    kind: body.artifact.kind ?? "none",
    check: body.check?.status ?? "none",
  };
}

/** Where step 1 found the publish goes: an Artifact the publisher may push to, or a new one's home. */
export type PublishLocation = { existing: ArtifactItemRow } | { home: NewHome };

/**
 * What a door into the publish (publishWith) brings besides the publisher:
 * `locate`, step 1's where and whether, after the request is checked and
 * before the announcement, BASE_REQUIRED and TITLE_REQUIRED checks (the
 * agent API's: the Artifact it sees and may push to, or the conversation its
 * `target` names that it may place into; a person's: publishAs.ts);
 * `summaryOf`, the answer's Artifact as the caller may see it named;
 * `assistantAgentId`, the personal assistant publishing (publishAs.ts): a
 * new Artifact's mark, and a repeated create replays only an Artifact with
 * that mark.
 */
export interface PublishDoor {
  locate(): Promise<PublishLocation | ArtifactApiError>;
  summaryOf(items: readonly ArtifactItemRow[]): Promise<AgentApiArtifactSummary[]>;
  assistantAgentId: string | undefined;
}

export function createPublishOperations() {
  async function changesFor(changes: readonly OthersChange[]): Promise<AgentApiArtifactMergedChange[]> {
    const name = await namer(changes.map((change) => ({ type: change.version.publisherType, id: change.version.publisherId })));
    return changes.map((change) => ({
      path: change.path,
      setting: change.setting,
      version: change.version.number,
      author: name({ type: change.version.publisherType, id: change.version.publisherId }),
    }));
  }

  /**
   * 409 BASE_MOVED or UNSEEN_CHANGES (a hold moves the read position over
   * what it shows), or 200 `unchanged`: the current version already is what
   * this request would make.
   */
  /** 200 `unchanged`: no version was made (the current one is `at.current`); `from`, the title this request replaced (`titleChanged`). */
  async function noVersion(door: PublishDoor, item: ArtifactItemRow, at: { current: ArtifactVersionRow; base: ArtifactVersionRow }, from?: string): Promise<ArtifactApiJson<AgentApiArtifactPublishResponse>> {
    const [summary] = await door.summaryOf([item]);
    return json<AgentApiArtifactPublishResponse>({
      artifact: summary!,
      version: { number: at.current.number, filesFromYou: [], deleted: [], base: at.base.number, previous: at.current.number, merged: [] },
      unseen: { otherComments: 0 },
      notified: [],
      newlySubscribed: false,
      replayed: false,
      unchanged: true,
      ...(from === undefined ? {} : { titleChanged: { from } }),
    }, 200);
  }

  async function notWritten(publisher: Publisher, door: PublishDoor, item: ArtifactItemRow, evaluation: NotWritten): Promise<ArtifactApiError | ArtifactApiJson<AgentApiArtifactPublishResponse>> {
    if (evaluation.kind === "unchanged") return noVersion(door, item, evaluation);
    const itemId = item.id;
    if (evaluation.kind === "base_moved") {
      const overlaps = await changesFor(evaluation.overlaps);
      const base = evaluation.base.number;
      const current = evaluation.current.number;
      return fail(409, {
        code: "BASE_MOVED",
        error: `Not pushed: since v${base}, the version this push is based on, others changed ${overlaps.length === 1 ? "something" : `${overlaps.length} things`} you changed too, and the current version is v${current}: read v${current}, redo your change on it, and push again with base ${current}.`,
        next: RAFT_HINTS.artifactRead({ artifact: itemId }),
        // Who changed which file or setting, in which version: released clients list them.
        details: { base, current, overlaps },
      });
    }
    const name = await namer(evaluation.comments.map((comment) => ({ type: comment.authorType, id: comment.authorId })));
    const numbers = await versionNumbers(evaluation.comments.map((comment) => comment.versionId));
    // Shown: the newest held comments, those in full counting as seen
    // (evaluation.through), so the same request again goes through unless
    // some are left `unread`. Also with `seen`, so the CLI and the SDK stay in step.
    await advanceReadPosition(publisher.reader, itemId, evaluation.through);
    return fail(409, {
      code: "UNSEEN_CHANGES",
      error: unseenChangesError("push", { comments: evaluation.count, versions: 0, unread: evaluation.unread }),
      next: RAFT_HINTS.artifactComments({ artifact: itemId }),
      details: {
      unseen: {
        comments: evaluation.comments.map((comment) => ({
          id: comment.id,
          author: name({ type: comment.authorType, id: comment.authorId }),
          version: numbers.get(comment.versionId) ?? 0,
          path: comment.path,
          createdAt: comment.createdAt.toISOString(),
          ...excerptOf(comment.body),
          anchor: comment.anchor ?? null,
          ...imageCountOf(comment),
        })),
        commentCount: evaluation.count,
        commentsCursor: evaluation.count > evaluation.comments.length ? positionCursor(evaluation.after) : null,
        unread: evaluation.unread,
      },
      seen: evaluation.through,
      skipped: evaluation.skipped,
      },
    });
  }

  async function published(
    door: PublishDoor,
    item: ArtifactItemRow,
    version: ArtifactVersionRow,
    evaluation: Extract<Evaluation, { kind: "ok" }>,
    written: { notified: NotifiedAgent[]; newlySubscribed: boolean } | { replayed: true },
  ): Promise<AgentApiArtifactPublished> {
    const [summary] = await door.summaryOf([item]);
    return {
      artifact: summary!,
      version: {
        number: version.number,
        filesFromYou: evaluation.changed.filter((path) => evaluation.files.has(path)),
        deleted: evaluation.deleted,
        base: evaluation.base?.number ?? null,
        previous: evaluation.previous?.number ?? null,
        merged: await changesFor(evaluation.merged),
      },
      unseen: { otherComments: evaluation.otherComments },
      notified: "replayed" in written ? [] : written.notified,
      newlySubscribed: "replayed" in written ? false : written.newlySubscribed,
      replayed: "replayed" in written,
      unchanged: false,
    };
  }

  /**
   * Step 2 for a new version: a version this agent made from this request (same
   * digest, same base), current or not: others may have published since. Not
   * when the agent published again after it (it may have undone it): then the
   * request is evaluated as new, and a plain retry after others' versions is
   * answered `unchanged` instead.
   */
  async function replayOfVersion(publisher: Publisher, door: PublishDoor, item: ArtifactItemRow, request: PublishRequest, digest: string): Promise<AgentApiArtifactPublished | null> {
    const [base] = await getDb().select({ id: artifactVersions.id }).from(artifactVersions)
      .where(and(readableVersion(item.id), eq(artifactVersions.number, request.base!))).limit(1);
    if (!base) return null;
    const [made] = await getDb().select().from(artifactVersions).where(and(
      readableVersion(item.id),
      eq(artifactVersions.publisherType, publisher.actor.type),
      eq(artifactVersions.publisherId, publisher.actor.id),
      eq(artifactVersions.publishDigest, digest),
      eq(artifactVersions.baseId, base.id),
    )).orderBy(desc(artifactVersions.number)).limit(1);
    if (!made) return null;
    const [later] = await getDb().select({ id: artifactVersions.id }).from(artifactVersions).where(and(
      readableVersion(item.id),
      eq(artifactVersions.publisherType, publisher.actor.type),
      eq(artifactVersions.publisherId, publisher.actor.id),
      gt(artifactVersions.number, made.number),
    )).limit(1);
    if (later) return null;
    // Report it as it was made: against the version it followed.
    const [previous] = await getDb().select().from(artifactVersions)
      .where(and(readableVersion(item.id), sql`${artifactVersions.number} < ${made.number}`))
      .orderBy(desc(artifactVersions.number)).limit(1);
    if (!previous) return null;
    const evaluation = await evaluateVersion(getDb(), publisher, item, request, { report: { current: previous } });
    if (evaluation.kind !== "ok") return null;
    return withCheckOf(await published(door, item, made, evaluation, { replayed: true }), item, made);
  }

  /**
   * Step 2 for a new Artifact: this publisher made one in this home from the
   * same request; through a personal assistant, only one carrying that
   * assistant's mark (another assistant's, or none, is another Artifact).
   */
  async function replayOfCreate(publisher: Publisher, door: PublishDoor, home: NewHome, request: PublishRequest, digest: string, title: string) {
    const [row] = await getDb().select({ item: artifactItems, version: artifactVersions }).from(artifactItems)
      .innerJoin(artifactVersions, eq(artifactVersions.id, artifactItems.currentVersionId))
      .where(and(
        eq(artifactItems.homeKind, "conversation"),
        eq(artifactItems.homeChannelId, home.channelId),
        isNull(artifactItems.deletedAt),
        isNull(artifactItems.revokedAt),
        eq(artifactItems.createdByType, publisher.actor.type),
        eq(artifactItems.createdById, publisher.actor.id),
        door.assistantAgentId === undefined ? undefined : eq(artifactItems.publishedByAssistantAgentId, door.assistantAgentId),
        eq(artifactVersions.number, 1),
        isNull(artifactVersions.baseId),
        eq(artifactVersions.publishDigest, digest),
      )).limit(1);
    if (!row) return null;
    return withCheckOf(await published(door, row.item, row.version, evaluateNew(request, title), { replayed: true }), row.item, row.version);
  }

  /** Step 6. */
  async function commit(input: {
    publisher: Publisher;
    request: PublishRequest;
    digest: string;
    outbox: ArtifactNoticeOutbox;
    /** A new version of this item (or its title alone), or a new item. */
    target: PublishTarget;
    /** The personal assistant a new item is published by (publishAs.ts). */
    assistantAgentId: string | undefined;
  }): Promise<Committed> {
    const { publisher, request } = input;
    const { actor } = publisher;
    return getDb().transaction(async (tx): Promise<Committed> => {
      let evaluation: Evaluation;
      let locked: ArtifactItemRow | null = null;
      if ("existing" in input.target) {
        [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, input.target.existing.id)).for("update");
        if (!locked || locked.deletedAt || locked.revokedAt) throw new ArtifactApiFailure(notVisible());
        // Again under the item lock: it may have become a channel's announcement since step 1.
        const announcementRefusal = await channelAnnouncementPushRefused({ ...actor, serverId: publisher.serverId }, locked, tx);
        if (announcementRefusal) refuse(403, announcementRefusal);
        evaluation = await evaluateVersion(tx, publisher, locked, request);
        if (evaluation.kind === "retitled") return retitle(tx, publisher, locked, evaluation, input.outbox);
        if (evaluation.kind !== "ok") return evaluation;
      } else {
        evaluation = evaluateNew(request, input.target.title);
      }
      checkResult(evaluation);

      const present = await presentBlobs(publisher.serverId, request.listed.map((file) => file.sha256), { executor: tx, lock: true });
      const missing = missingOf(request, evaluation, present);
      if (missing.length > 0) return { kind: "missing", missing };
      const changed = new Set(evaluation.changed);
      for (const file of request.listed) {
        if (!changed.has(file.path)) continue;
        const blob = present.get(file.sha256)!;
        // A manifest's size is the caller's word; the blob's is measured.
        if (blob.sizeBytes !== file.size) {
          refuse(400, {
            code: "SIZE_MISMATCH",
            error: `A file is listed as ${file.size} bytes, but the bytes uploaded for its sha256 are ${blob.sizeBytes}: compute the size and the sha256 from the same bytes, then push again.`,
            details: { path: file.path, sha256: file.sha256, size: file.size, actual: blob.sizeBytes },
          });
        }
        evaluation.files.set(file.path, { sha256: file.sha256, size: blob.sizeBytes, blobId: blob.id });
      }

      let item: ArtifactItemRow;
      if ("existing" in input.target) {
        item = locked!;
      } else {
        const { home } = input.target;
        const id = `pt_${randomUUID()}`;
        // No name: an Artifact is its id and its title (#proj-workspace:98241a2e).
        const [inserted] = await tx.insert(artifactItems).values({
          id,
          serverId: publisher.serverId,
          urlKey: id,
          name: null,
          title: evaluation.title,
          description: evaluation.description,
          homeKind: "conversation",
          homeChannelId: home.channelId,
          // Its original conversation (#75), never changed: the only one a narrowing returns it to.
          originalHomeChannelId: home.channelId,
          createdByType: actor.type,
          createdById: actor.id,
          publishedByAssistantAgentId: input.assistantAgentId ?? null,
        }).returning();
        item = inserted!;
      }

      const [{ last } = { last: 0 }] = await tx.select({ last: max(artifactVersions.number) }).from(artifactVersions).where(eq(artifactVersions.itemId, item.id));
      const position = item.lastPosition + 1;
      const files = [...evaluation.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      const [version] = await tx.insert(artifactVersions).values({
        id: `v_${randomUUID()}`,
        itemId: item.id,
        number: (last ?? 0) + 1,
        entry: evaluation.entry,
        title: evaluation.title,
        description: evaluation.description,
        baseId: evaluation.base?.id ?? null,
        label: request.label,
        note: request.note,
        fileCount: files.length,
        sizeBytes: files.reduce((sum, [, file]) => sum + file.size, 0),
        publishDigest: input.digest,
        status: "published",
        publisherType: actor.type,
        publisherId: actor.id,
        position,
      }).returning();
      await tx.insert(artifactVersionFiles).values(files.map(([path, file]) => ({
        versionId: version!.id,
        path,
        sha256: file.sha256,
        sizeBytes: file.size,
        blobId: file.blobId!,
      })));
      // The version's publish check, after its files (its `unchanged` compares them with the previous version's).
      const check = await recordVersionCheck(tx, { item, version: version! });
      const [updated] = await tx.update(artifactItems).set({
        currentVersionId: version!.id,
        lastPosition: position,
        title: evaluation.title,
        description: evaluation.description,
        updatedAt: sql`now()`,
      }).where(eq(artifactItems.id, item.id)).returning();
      await indexArtifactSearch(tx, updated!);
      // Its own version is nothing new to the publisher, nor are others'
      // versions it was built on; others' comments it wasn't shown (those on
      // other files, counted in `unseen.otherComments`) stay unseen: the
      // position stops before the first (shownThrough).
      // The reader's (Publisher): for a person, the assistant's, never theirs.
      const from = await readPositionOf(publisher.reader, item.id, tx) ?? 0;
      const seen = await shownThrough(tx, publisher.reader, item.id, from, position, new Set(), { allVersions: true });
      if (seen > from) await advanceReadPosition(publisher.reader, item.id, seen, tx);
      // For the Artifact's followers (the publisher left out by the platform); the same followers its notices go to.
      const following = await followersOf(tx, item.id);
      const event = await recordArtifactEvent(tx, {
        item: updated!,
        eventKind: "version",
        actor,
        data: { position, version: version!.number },
        recipients: followerRecipients(updated!, following),
      });
      const newlySubscribed = await autoSubscribe(tx, item.id, actor, "published");
      // An assistant publishing as its owner isn't told of its own push (quietOf).
      const quiet = quietOf(publisher);
      const except = quiet.length > 0 ? { except: quiet } : {};
      const noticed = await noticeVersion({ executor: tx, outbox: input.outbox, item: updated!, version: version!, previous: evaluation.previous, now: currentDate(), following, ...except });
      // A channel's announcement (channel_announcement_v0): its channel's other agents hear of the version, queued only.
      await noticeChannelAnnouncement({ executor: tx, outbox: input.outbox, item: updated!, version: version!, now: currentDate(), told: noticed.queued.map((notice) => notice.agentId), ...except });
      return { kind: "published", item: updated!, version: version!, evaluation, newlySubscribed, eventId: event.id, check, ...noticed };
    });
  }

  /**
   * The publish, for any door (PublishDoor): the flag, the request (step 1's
   * own checks), then `locate`, then the announcement and BASE_REQUIRED (a
   * new version) or TITLE_REQUIRED (a new Artifact), then steps 2 to 6, as the
   * file's header has them.
   */
  const publishWith = (publisher: Publisher, body: AgentApiArtifactPublishBody, outbox: ArtifactNoticeOutbox, door: PublishDoor): Promise<ArtifactApiResult<AgentApiArtifactPublishResponse>> => withAppSpan("server.artifacts.publish", publishSpanAttrs(body), () => answer(async (): Promise<ArtifactApiResult<AgentApiArtifactPublishResponse>> => {
    await requireEnabled(publisher);
    const request = checkRequest(body);

    // Step 1: where, and whether the publisher may.
    const located = await door.locate();
    if ("kind" in located) return located;
    let target: PublishTarget;
    if ("existing" in located) {
      const { existing } = located;
      // A channel's announcement: only who may set it pushes to it (channel_announcement_v0).
      const announcementRefusal = await channelAnnouncementPushRefused({ ...publisher.actor, serverId: publisher.serverId }, existing);
      if (announcementRefusal) return fail(403, announcementRefusal);
      if (request.base === undefined) {
        const current = (await currentVersionOf(existing))?.number ?? null;
        return fail(400, {
          code: "BASE_REQUIRED",
          error: `A new version needs base, the version number your files were made from${current === null ? "" : ` (the current one is ${current})`}: read the artifact, then push again with that base.`,
          next: RAFT_HINTS.artifactRead({ artifact: existing.id }),
          details: { currentVersion: current },
        });
      }
      target = { existing };
    } else {
      // No name to fall back on: a new Artifact is titled by its push (a client reads its entry page's <title> first).
      if (request.title === undefined) return fail(400, { code: "TITLE_REQUIRED", error: TITLE_REQUIRED_ERROR, suggestedNextAction: TITLE_STEP });
      target = { home: located.home, title: request.title };
    }

    // Step 2: the same request again.
    const digest = digestOf(request, "existing" in target ? { base: request.base! } : { conversationId: target.home.channelId });
    const replay = "existing" in target
      ? await replayOfVersion(publisher, door, target.existing, request, digest)
      : await replayOfCreate(publisher, door, target.home, request, digest, target.title);
    if (replay) return json<AgentApiArtifactPublishResponse>(replay, 200);

    // Steps 3 and 4, unlocked, to answer early and before storing any bytes.
    // A title alone (`retitled`) makes no version, so it has no bytes to store: step 6 sets it.
    let evaluation: Extract<Evaluation, { kind: "ok" }> | null;
    if ("existing" in target) {
      const evaluated = await evaluateVersion(getDb(), publisher, target.existing, request);
      if (evaluated.kind !== "ok" && evaluated.kind !== "retitled") return notWritten(publisher, door, target.existing, evaluated);
      evaluation = evaluated.kind === "ok" ? evaluated : null;
    } else {
      evaluation = evaluateNew(request, target.title);
    }
    if (evaluation) {
      checkResult(evaluation);
      const refused = await storeBytes(publisher, request, evaluation, target);
      if (refused) return refused;
    }

    // Step 6.
    const committed = await commit({ publisher, request, digest, outbox, target, assistantAgentId: door.assistantAgentId });
    switch (committed.kind) {
      case "published": {
        await sendQueued(outbox, committed.queued);
        await announceObjectEvents([committed.eventId]);
        // A public Artifact's new current version: its signed-out text, in the background (publicText.ts).
        if (committed.item.homeKind === "public") fillPublicText(committed.item, committed.version, { entry: inlineEntryOf(request, committed.evaluation) });
        // Pages held to one screen or holding frames, and copies of common libraries (scrollLock.ts), and a Markdown entry's excerpt (excerpt.ts): beside the answer, best effort, bounded in bytes and time.
        const [answered, warnings] = await Promise.all([
          published(door, committed.item, committed.version, committed.evaluation, committed),
          scrollLockWarnings({ serverId: publisher.serverId, entry: committed.evaluation.entry, files: committed.evaluation.files, changed: committed.evaluation.changed, inline: inlineFilesOf(request, committed.evaluation) }),
          fillVersionExcerpt(committed.item, committed.version, { entry: inlineEntryOf(request, committed.evaluation) }),
        ]);
        const check = pushCheckOf(committed.check);
        return json<AgentApiArtifactPublishResponse>({ ...answered, ...(warnings.length > 0 ? { warnings } : {}), ...(check ? { check } : {}) }, 201);
      }
      case "retitled":
        return noVersion(door, committed.item, committed, committed.from);
      case "missing":
        return json<AgentApiArtifactPublishResponse>({ missing: committed.missing }, 200);
      default:
        // Only a new version is refused here (a new item has no base or comments).
        return notWritten(publisher, door, (target as { existing: ArtifactItemRow }).existing, committed);
    }
  }), { onSuccess: publishOutcomeAttrs, statusOf: answerStatus });

  return {
    /** `as`: through a personal assistant (publishAs.ts, which checks what it may push to): a new Artifact is marked as published by it. */
    publish: (agent: ArtifactAgent, body: AgentApiArtifactPublishBody, outbox: ArtifactNoticeOutbox, as?: { assistantAgentId: string }): Promise<ArtifactApiResult<AgentApiArtifactPublishResponse>> => publishWith(agentPublisher(agent), body, outbox, {
      assistantAgentId: as?.assistantAgentId,
      summaryOf: (items) => summarize(agent, items),
      // Step 1 as the agent API has it: an Artifact the agent sees and may push to, or the conversation its `target` names.
      locate: async () => {
        if (body.artifact !== undefined) {
          const existing = await resolveVisibleItem(agent, body.artifact);
          if (!mayPublish(agent, existing)) return mayNotTakePart("push to it");
          return { existing };
        }
        if (body.target === undefined) {
          return fail(400, {
            code: "TARGET_REQUIRED",
            error: "A new artifact needs a home, the conversation whose members can see it: name one, such as the conversation you're working in, then push again.",
          });
        }
        const resolved = await resolveConversationTarget(agent, body.target);
        if (!resolved) return targetNotFound({ target: body.target }, "push");
        // Agent Lounge: another agent's lounge is readable, not a place to put things.
        if (!await agentMayPlaceInConversation(resolved.conversationId, agent.agentId)) {
          return fail(403, { code: "FORBIDDEN", error: AGENT_LOUNGE_PLACEMENT_REFUSAL, details: { target: body.target } });
        }
        // A joint's home is its canonical channel, the same on every server in it.
        return { home: { kind: "conversation", channelId: resolved.homeChannelId } };
      },
    }),

    /**
     * The publish for a door of its own (publishAs.ts: a person their personal
     * assistant publishes for): `publisher` and `door` as publishWith takes them.
     */
    publishWith,

    upload: (
      agent: ArtifactAgent,
      params: AgentApiArtifactUploadParams,
      input: { contentType: string | undefined; contentLength: string | undefined; body: Readable },
    ): Promise<ArtifactApiEmpty | ArtifactApiError> => answer(async () => {
      await requireEnabled(agent);
      if (input.contentType?.split(";")[0]!.trim().toLowerCase() !== "application/octet-stream") {
        return fail(400, { code: "agent_api_contract_invalid", error: "An upload's body is the file's bytes, sent as application/octet-stream: send it with that Content-Type." });
      }
      // Everything about the size is decided before a byte is read.
      if (input.contentLength === undefined || !/^\d{1,12}$/.test(input.contentLength)) {
        return fail(411, {
          code: "CONTENT_LENGTH_REQUIRED",
          error: "An upload needs a Content-Length header, and this one had none: this is a client bug, so send the file inline (content_base64) meanwhile.",
        });
      }
      const size = Number(input.contentLength);
      if (size > AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES) {
        return fail(413, { code: "FILE_TOO_LARGE", error: tooLarge(size, AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES, false), details: { path: null, size, limit: AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES } });
      }
      const store = artifactR2Store();
      if (!store) return storageUnavailable();
      const already = await presentBlobs(agent.serverId, [params.sha256]);
      if (!already.has(params.sha256)) {
        const used = await unreferencedBytes(agent.serverId);
        if (used + size > AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES) {
          return uploadQuotaExceeded(used, AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES);
        }
        // No upgrade card: an upload is bytes by sha256, of no Artifact or conversation yet.
        const refused = await monthlyQuotaRefusal(agent, size, "artifact_upload");
        if (refused) return refused;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of input.body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        received += buffer.length;
        if (received > size) {
          input.body.destroy();
          return fail(400, { code: "SIZE_MISMATCH", error: UPLOAD_LENGTH_ERROR, details: { path: null, sha256: params.sha256, size, actual: received } });
        }
        chunks.push(buffer);
      }
      if (received !== size) return fail(400, { code: "SIZE_MISMATCH", error: UPLOAD_LENGTH_ERROR, details: { path: null, sha256: params.sha256, size, actual: received } });
      const bytes = Buffer.concat(chunks, received);
      const actual = sha256Hex(bytes);
      if (actual !== params.sha256) {
        return fail(400, {
          code: "SHA256_MISMATCH",
          error: "The uploaded bytes don't hash to the sha256 in the address (the file may have changed while uploading): hash the exact bytes you send, then upload again.",
          details: { expected: params.sha256, actual },
        });
      }
      const stored = await storeBlob(store, agent.serverId, actual, bytes);
      if (stored.kind === "quota_exceeded") return uploadQuotaExceeded(stored.used, stored.limit);
      if (stored.kind === "file_upload_quota_exceeded") return fileUploadQuotaRefusal(agent.serverId, stored.error, "artifact_upload");
      return { kind: "empty" as const };
    }),
  };
}

