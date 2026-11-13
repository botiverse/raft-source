// Importing one Artifact of the standalone app (raft-artifacts.com) into
// Raft, on demand: the agent API's `POST /artifacts/import { from, target? }`
// and the web's `POST /api/artifacts/import { from, conversationId? }`. The
// conditions are Tenny's (approved with them); checked in this order, and
// nothing is requested from the standalone app before step 6:
//
// 1. workspace_artifacts_v0 for the caller's server S (403 ARTIFACTS_NOT_ENABLED);
// 2. `from` is parsed only, never requested (SSRF): a link on one of the
//    standalone app's hosts (shared ARTIFACT_LEGACY_HOSTS, plus
//    ARTIFACTS_LEGACY_LINK_HOSTS) naming `/p/<server>/<name>`; anything
//    else is 400 NOT_A_LEGACY_LINK;
// 3. the caller is a member of S, not a guest, or a live agent of it (the
//    server home's audience: canViewHomes; else 403 FORBIDDEN);
// 4. the link's server slug names S, or no server at all (Raft keeps no slug
//    history, so a slug renamed since is taken as S's; the standalone app,
//    asked by S's id, 404s when the Artifact isn't S's); a slug another
//    server has now is 403 LEGACY_OTHER_SERVER, also when it was S's before
//    a rename (nothing tells that apart). The standalone app is only ever
//    asked about the caller's own server;
// 5. the home: by default the whole server S (`server`), the old Artifact's
//    own audience (S's full members and agents). A target, when given, is a
//    conversation of S the caller can see, as publishing's home (an agent's
//    `target` through resolveConversationTarget, a person's conversation id
//    through canViewHomes; a thread means its conversation; 404
//    TARGET_NOT_FOUND), not a joint channel (400 TARGET_NOT_SUPPORTED), and
//    with no guest in it nor open to guests (403 TARGET_HAS_GUESTS, agents
//    too: a home guests see would widen the old Artifact's audience);
// 6. importing is configured (ARTIFACTS_LEGACY_IMPORT_URL and _TOKEN, else
//    503 IMPORT_UNAVAILABLE), and the standalone app has the Artifact (its
//    manifest; 404 LEGACY_NOT_FOUND);
// 7. imported before: an Artifact the standalone app says it went to
//    (`importedTo`) or this server's audit records for its id (`import`
//    rows), live in S: the caller sees it → that one (200, created false);
//    it doesn't → 409 ALREADY_IMPORTED (no id or title); deleted → import again;
// 8. the manifest against publishing's limits, before any byte is copied:
//    the name (400 INVALID_NAME), files per version, each file's size, and
//    the server's cap on bytes no version uses (413 IMPORT_TOO_LARGE); the
//    name free in the home (409 NAME_TAKEN, with the Artifact that has it);
// 9. the bytes this server lacks, one file at a time: each read only up to
//    its manifest size, its sha256 computed here and compared; any mismatch
//    fails the whole import (502 IMPORT_MISMATCH) before that file is stored;
// 10. one transaction: the Artifact, its version 1 (noted "Imported from
//     <old link>"), its files, the search index, the object event, the
//     importer's and the author's (when it sees the home) read position (at
//     version 1: nothing unread) and following (the per-server move's with
//     no author Raft confirms: the server's live human owners', `followed`),
//     and the audit row
//     (`import`, by the importer, with the old Artifact's id and its
//     `legacyCreator`). Imports of one old Artifact into one server are
//     serialised by an advisory lock, and step 7 is repeated under it, so
//     two at once make one Artifact;
// 11. after the commit, the standalone app is told where it went and
//     whether that home is public (best effort: a failure is logged, the
//     import stands).
//
// At most ARTIFACT_IMPORTS_AT_ONCE (2) imports of agents and people run at
// once per server, counted across replicas (platform/slots: a lease per
// import in Redis, given back when it ends however it ends, and expiring
// a minute after the deadline should a replica die mid-way): a third is
// refused after step 5, before anything is asked of the standalone app,
// 429 RATE_LIMITED with Retry-After (the rate limits' body: `limit` the
// imports at once, `windowSeconds` the wait; its span's rate_limiter
// `artifact-import`). The per-server move (ops) isn't counted:
// it runs one import at a time.
//
// Steps 6 to 10 have one deadline (AGENT_API_ARTIFACT_IMPORT_DEADLINE_MS, 5 min),
// besides each request's own timeout: past it, 503 IMPORT_UNAVAILABLE
// `timeout`. An import that fails (or makes nothing) deletes at once the blob
// rows it made that no version uses (deleteClaimedBlobs), so they don't hold
// S's upload cap until the day-old sweep.
//
// The files it copies count against the server's monthly file upload quota
// (the attachments' one) as every Artifact store does (storeBlob): checked for
// all of them with the cap in step 8, so a server without room is refused
// (403 FILE_UPLOAD_QUOTA_EXCEEDED) before any file is fetched; files the
// server already has cost nothing. Bytes a failed import stored and made
// ready were used this month: deleting them gives nothing back (as for
// attachments); a row still pending gives the reservation recorded on it back
// in the transaction that deletes it (storeBlob's own, after a failed PUT, or
// deleteClaimedBlobs').
//
// The author (the item's created_by and version 1's publisher) is the old
// Artifact's creator (the manifest's `creator`) when Raft confirms it
// (legacyAuthor): the standalone app's `type` and `raftId` are hints only,
// taken when that id is, now, a live principal of exactly that type in S: an
// agent row of S not deleted, or a person with a membership row in S (any
// role: a guest author is D13's too, it may delete its own and never widen).
// So the agent that published `my-report` there keeps its author's rights
// here (D9/D13) and its "publish another version of my-report" flow. Anything
// else (no creator, another type, another server's, a deleted agent, a person
// who left, an id that isn't one) is no author: the importer is, the person
// or agent importing on demand, the ops actor in the per-server move (whose
// Artifacts the orphan rule hands to the server's owners and admins). Decided
// with Tenny (CTO) 2026-10-26, both paths alike: on demand too the original
// creator, when confirmed, rather than whoever happened to import it. The
// creator follows it and has read it (nothing unread) only when it sees the
// home (a guest doesn't see the whole server's; a target conversation it
// isn't in): an author's rights don't show it an Artifact.
//
// The per-server move (legacyBulkImport.ts, an operator's script, never a
// request) imports through the same steps 6 to 11 (importLegacyArtifactAsOps):
// the importer is the ops actor (ARTIFACT_OPS_IMPORT_ACTOR, a fixed id, with
// the operator's name in the audit row's `after.ops`), the home the whole
// server, and the server's id and the old Artifact's name come from the
// standalone app's `list`, not a link. Steps 1 to 5 are a person's or agent's
// and don't apply (the move runs before the flag is on, and the operator is
// no member); in step 7 the ops actor sees every earlier import; its bytes
// don't count against the monthly file upload quota (storeBlob's `quota:
// "exempt"`: a migration, not an upload); the cap and every other check stand.
//
// The move may also import an Artifact public on raft-artifacts.com into the
// server's public home (anyone with the link), when its operator asks for it
// (`--public`; importLegacyArtifactAsOps `home: "public"`), by the same steps,
// only where Raft's rule for who may turn on an Artifact's link sharing
// (manage.ts widenRefusal, #11285: a person, who may widen it, so not a guest)
// allows it for the new Artifact's author (publicImportRefusal): the old
// creator, confirmed by legacyAuthor, is a person of the server who may widen
// it. No confirmed creator (the ops actor would be the author:
// `system_author`), an agent (`agent_author`: on Raft only a person turns on
// link sharing) or a person who may not widen it (`may_not_make_public`: a
// guest) is refused (the move skips it, nothing fetched past the manifest and
// nothing kept), checked before any byte is copied and again in the commit's
// transaction. It writes, beside the `import` row (its `after` with `home:
// "public"`), the `made_public` row a move to the public home writes, by the
// ops actor, naming the author the rule was checked for; and, after the
// commit, the version's signed-out text (publicText.ts), as making it public does.
// The ops actor itself is never taken as one who may make an Artifact public.
//
// With an approval (the move's `--approved-by`, Tenny 2026-10-30: it keeps
// pages already public there public, it widens nothing; xxchan and Tenny
// 2026-10-30, #proj-workspace:e7b3e687: one approval of the whole move by a
// platform owner, "the move doesn't change who can see it"): a Raft platform
// owner or admin (isPlatformOwnerOrAdmin: a human owner or admin of
// Botiverse, the platform's own Server, not a retired account; checked
// again in the commit's transaction) stands behind keeping public an
// Artifact the rule refuses only for its author (publicImportAssessment:
// `agent_author`, or `system_author` with truly no creator or a creator id
// confirmed an agent of the server; never a guest's, whatever its stated
// type, nor a creator Raft can't confirm), and only while the standalone app answered it public in this run
// (`legacyVisibility`, from its list after the freeze; anything else: the
// rule alone). Its `made_public` row is then the approver's (the actor), with
// the operator and the Raft message that records the approval.
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_IMPORT_DEADLINE_MS,
  AGENT_API_RATE_LIMITED_CODE,
  AGENT_API_ARTIFACT_MAX_BINARY_FILE_BYTES,
  AGENT_API_ARTIFACT_MAX_DESCRIPTION_CHARS,
  AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION,
  AGENT_API_ARTIFACT_MAX_NOTE_CHARS,
  AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES,
  AGENT_API_ARTIFACT_MAX_TITLE_CHARS,
  AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES,
  artifactFileType,
  isWellFormedArtifactFilePath,
  parseArtifactRef,
  parseLegacyArtifactLink,
  ARTIFACT_LEGACY_HOSTS,
  type AgentApiArtifactErrorCode,
  type AgentApiArtifactImportBody,
  type AgentApiArtifactImported,
  type ArtifactWebErrorCode,
  type ArtifactWebImported,
  type ServerId,
} from "@botiverse/raft-shared";
import { actorKey, actorNames, isPlatformOwnerOrAdmin, principalInServer, serverOwnerIds } from "../../platform/actors";
import { AGENT_LOUNGE_PLACEMENT_REFUSAL, agentMayPlaceInConversation, conversationGuestAccess, resolveConversationTarget, topLevelConversationOf } from "../../platform/conversations";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { checkFileUploadQuota, FileUploadQuotaExceededError } from "../../platform/fileUploadQuota";
import { appHosts, serverIdBySlug } from "../../platform/links";
import { createSharedSlots } from "../../platform/slots";
import { byteSizeBucket, countBucket, withAppSpan } from "../../platform/tracing";
import { assertNeverViewActor, canManageObject, canViewHomes, standsInOwnServer, type ViewActor } from "../../platform/visibility";
import {
  ARTIFACT_OPS_IMPORT_ACTOR,
  ARTIFACTS_NOT_ENABLED_ERROR,
  advanceReadPosition,
  artifactAppUrl,
  artifactsEnabled,
  byteSize,
  fail,
  fileUploadQuotaRefusal,
  json,
  STORAGE_UNAVAILABLE_ERROR,
  summarize,
  TARGET_NOT_FOUND_ERROR,
  type ArtifactActorRef,
  type ArtifactAgent,
  type ArtifactApiError,
  type ArtifactApiJson,
} from "./apiCommon";
import { deleteClaimedBlobs, presentBlobs, storeBlob, unreferencedBytes, type BlobClaim, type StoreBlobQuota } from "./blobs";
import { artifactR2Store, type ArtifactR2Store } from "./blobStore";
import { recordArtifactEvent } from "./events";
import {
  fetchLegacyBlob,
  fetchLegacyManifest,
  legacyWorkerConfig,
  LegacyWorkerUnavailable,
  notifyLegacyImported,
  type LegacyCreator,
  type LegacyManifest,
  type LegacyWorkerConfig,
} from "./legacyWorker";
import { ARTIFACT_NAME, isReservedArtifactName, liveInHome, type ArtifactHomeRef } from "./names";
import { autoSubscribe } from "./notices";
import { fillCurrentExcerpt } from "./excerpt";
import { fillCurrentPublicText } from "./publicText";
import { artifactAudit, artifactItems, artifactSubscriptions, artifactVersionFiles, artifactVersions, type ArtifactItemRow } from "./schema";
import { indexArtifactSearch } from "./search";
import { answerAttrs, answerStatus } from "./trace";
import { canViewArtifacts } from "./visibility";
import { atCurrentVersions, artifactCards, cardAuthorRef } from "./webCards";
import { profiler, webBadBody, webFail, webFileUploadQuotaRefusal, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";

/** The audit action an import writes; its `after` names the old Artifact. */
export const ARTIFACT_IMPORT_AUDIT_ACTION = "import";
/** The longest `from` looked at; a longer one is no link. */
const FROM_MAX_CHARS = 2048;
let deadlineMs = AGENT_API_ARTIFACT_IMPORT_DEADLINE_MS;

/** Tests: a shorter deadline for the whole import; undefined goes back to the default. */
export function __setImportDeadlineForTests(ms: number | undefined): void {
  deadlineMs = ms ?? AGENT_API_ARTIFACT_IMPORT_DEADLINE_MS;
}

/** Imports of agents and people that may run at once in one server, across replicas. */
export const ARTIFACT_IMPORTS_AT_ONCE = 2;
/** The wait a refused import is told: most imports take seconds. */
export const ARTIFACT_IMPORT_BUSY_RETRY_AFTER_SECONDS = 30;
/** The span's `rate_limiter` of an import refused as one too many at once. */
export const ARTIFACT_IMPORT_RATE_LIMITER = "artifact-import";
/** Past the deadline, an import's lease outlives it by this much (the commit and the notice after it). */
const IMPORT_LEASE_GRACE_MS = 60_000;
const importSlots = createSharedSlots();

/** Tests: forget this process's import leases. */
export function __clearImportSlotsForTests(): void {
  importSlots.clear();
}

/**
 * Who imports: an agent (agent API) or a person (web), in their server; or
 * the ops actor (`ops`: the per-server move, with the operator's name).
 */
type Importer = { actor: ArtifactActorRef; serverId: ServerId; ops?: { operator: string; maxFileBytes?: number } };

// The per-server move's importer and an operator's takedown act as fixed system actors (apiCommon).
export { ARTIFACT_OPS_IMPORT_ACTOR, ARTIFACT_OPS_MODERATION_ACTOR } from "./apiCommon";
/** What the standalone app is told imported an Artifact the per-server move took. */
const OPS_IMPORTED_BY = "Raft migration";
/** Where to: an agent's target (`#channel`, `dm:@peer`, a thread's), a person's conversation id, or (none given) the whole server. */
type ImportTarget = { kind: "agent"; agent: ArtifactAgent; target: string } | { kind: "id"; conversationId: string } | { kind: "server" };
/** The new Artifact's home: the whole server, a conversation, or (the per-server move only, `--public`) the server's public home. */
type ImportHome = Extract<ArtifactHomeRef, { kind: "conversation" }> | { kind: "server" } | { kind: "public" };

/** The codes an import answers with, on both APIs (RATE_LIMITED: core's, too many imports at once). */
type ImportErrorCode = Extract<AgentApiArtifactErrorCode, ArtifactWebErrorCode> | typeof AGENT_API_RATE_LIMITED_CODE;

/**
 * An import's refusal, the same on both APIs: the envelope's fields with one
 * of the codes both answer; `rateLimiter` names the limit on the request's span.
 */
type ImportRefusalInput = { code: ImportErrorCode; error: string; details?: Record<string, unknown>; retryAfterSeconds?: number; rateLimiter?: string };

class ImportRefusal extends Error {
  constructor(readonly status: number, readonly refusal: ImportRefusalInput) {
    super(refusal.code);
  }

  get code(): ImportErrorCode {
    return this.refusal.code;
  }
}
const refuse = (status: number, refusal: ImportRefusalInput): never => {
  throw new ImportRefusal(status, refusal);
};

/** "Nothing was imported", after why: an import is all or nothing. */
const NOTHING_IMPORTED = "nothing was imported";

/** raft-artifacts.com sent a file other than its manifest lists. */
const mismatch = (path: string, reason: "size" | "sha256"): ImportRefusalInput => ({
  code: "IMPORT_MISMATCH",
  error: `raft-artifacts.com sent a file with other bytes than it listed, so ${NOTHING_IMPORTED}: try the same import again, and if it keeps failing tell a human.`,
  details: { path, reason },
});

/** The old Artifact's name can't be one here (or is reserved). */
const invalidName = (name: string, reserved: boolean): ImportRefusalInput => ({
  code: "INVALID_NAME",
  error: reserved
    ? `That old artifact's name is reserved here, so ${NOTHING_IMPORTED}: it can't be imported as it is, so tell a human.`
    : `That old artifact's name can't be an artifact's name here (lowercase letters, digits and inner hyphens, at most 63), so ${NOTHING_IMPORTED}: it can't be imported as it is, so tell a human.`,
  details: { name, reserved },
});

/** More new bytes than the server's cap on uploads no version uses leaves room for. */
const overCap = (used: number, needed: number, limit: number): ImportRefusalInput => ({
  code: "IMPORT_TOO_LARGE",
  error: `Importing it needs ${byteSize(needed)} of new files, more than this server has room for now (${byteSize(used)} of ${byteSize(limit)} held by files no version uses yet), so ${NOTHING_IMPORTED}: try again in a day, when unused uploads are cleared.`,
  details: { reason: "quota", used, needed, limit },
});

/** The monthly file upload quota has no room for the files an import would copy: 403 FILE_UPLOAD_QUOTA_EXCEEDED on both APIs. */
class ImportQuotaRefusal extends Error {
  constructor(readonly serverId: ServerId, readonly error: FileUploadQuotaExceededError) {
    super("FILE_UPLOAD_QUOTA_EXCEEDED");
  }
}

/**
 * Why the per-server move may not keep an old public Artifact public here
 * (publicImportRefusal): no author Raft confirms (the ops actor would be it),
 * an agent author (only a person turns on link sharing), or a person who
 * may not widen it (a guest).
 */
export type PublicImportRefusal = "system_author" | "agent_author" | "may_not_make_public";

/**
 * publicImportRefusal's answer, and whether a platform owner's or admin's
 * approval may lift it (publicImportAssessment): only an agent's
 * (`agent_author`, confirmed live) or, for `system_author`, only when there
 * is truly no creator or the creator's id is confirmed an agent of the
 * server (a deleted one). Never a guest's, whatever type the standalone app
 * gave it, nor anything Raft can't confirm (a former member or guest, a
 * member typed as an agent, another server's, an id that isn't one).
 */
export interface PublicImportAssessment {
  refusal: PublicImportRefusal | null;
  approvable: boolean;
}

/**
 * A Raft platform owner's or admin's approval (isPlatformOwnerOrAdmin) to keep an old public page public here
 * when its author can't (the per-server move's `--approved-by`).
 */
export interface PublicImportApproval {
  approver: { id: string; name: string };
  /** The Raft message that records the approval. */
  ref: string;
  /** The page's visibility on raft-artifacts.com, as the standalone app answered it in this run (after the freeze); null: not known. */
  legacyVisibility: "public" | "private" | null;
}

/** On what an import into the public home stands: its author's own right (#11285), or an approval. */
type PublicBasis = { kind: "author" } | { kind: "approval"; approval: PublicImportApproval };

/** The per-server move's public import refused by publicImportRefusal: the move skips it. */
class PublicImportRefused extends Error {
  constructor(readonly reason: PublicImportRefusal) {
    super(reason);
  }
}

/** The old Artifact's `after` in its audit row. */
interface ImportAudit {
  legacyArtifactId: string;
  from: string;
  server: string;
  name: string;
  version: number;
  /** The per-server move: the operator who ran it. */
  ops?: { operator: string };
  /** Who published it on raft-artifacts.com (null: unknown), and whether that one is the author here. */
  legacyCreator: (LegacyCreator & { author: boolean }) | null;
  /** Imported into the public home (the per-server move's `--public`); absent: a private home. */
  home?: "public";
}

/** `byCreator` (a new one only): its author is the old Artifact's creator, not the importer. */
type ImportOutcome = { item: ArtifactItemRow; created: boolean; byCreator?: boolean; publicBasis?: PublicBasis["kind"]; from: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const cut = (text: string, max: number): string => {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
};
const viewActorOf = (importer: Importer): ViewActor => ({ type: importer.actor.type, id: importer.actor.id, serverId: importer.serverId });
const homeRefOf = (serverId: ServerId, home: ImportHome) => (home.kind === "server" ? { kind: "server" as const, serverId } : home);
const homeFacts = (item: Pick<ArtifactItemRow, "homeKind" | "homeChannelId">) => ({ home_kind: item.homeKind, home_channel_id: item.homeChannelId });
const fileLimitOf = (path: string): number => (artifactFileType(path).text ? AGENT_API_ARTIFACT_MAX_TEXT_FILE_BYTES : AGENT_API_ARTIFACT_MAX_BINARY_FILE_BYTES);

/**
 * The most the per-server move may raise a file's limit to (`maxFileBytes`,
 * #proj-workspace:#114): old Artifacts whose one oversized file is a
 * download (a zip, a tar.xz, a split archive, up to 46 MB). Publishing's
 * limits stay; the raised one is the move's alone, for files the page only
 * offers to download: not text, and not the entry unless the entry itself is
 * one Raft only offers to download (`other`: an archive, a split part; 27
 * old pages are exactly that, one file each, #proj-workspace:#114). An entry
 * that is shown (a page, Markdown, an image, a PDF, a video) keeps its limit.
 */
export const ARTIFACT_OPS_IMPORT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const artifactLink = (id: string): string => artifactAppUrl(id);

/** ARTIFACTS_LEGACY_LINK_HOSTS: hosts, besides the standalone app's own, whose `/p/<server>/<name>` links count (a staging copy of it). */
function extraLegacyHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ARTIFACTS_LEGACY_LINK_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
}

/**
 * Step 5: the home. No target: the whole server. A target: a top-level
 * conversation of the importer's server it can see, not a joint channel,
 * with no guest in it nor open to guests.
 */
async function homeOf(importer: Importer, target: ImportTarget): Promise<ImportHome> {
  if (target.kind === "server") return { kind: "server" };
  let conversationId: string | null = null;
  const named = target.kind === "agent" ? { target: target.target } : { conversationId: target.conversationId };
  if (target.kind === "agent") {
    conversationId = (await resolveConversationTarget(target.agent, target.target))?.conversationId ?? null;
    // Agent Lounge: another agent's lounge is readable, not a place to put things.
    if (conversationId && !await agentMayPlaceInConversation(conversationId, target.agent.agentId)) {
      return refuse(403, { code: "FORBIDDEN", error: AGENT_LOUNGE_PLACEMENT_REFUSAL, details: named });
    }
  } else if (UUID.test(target.conversationId)) {
    conversationId = target.conversationId;
  }
  const conversation = conversationId ? await topLevelConversationOf(importer.serverId, conversationId) : null;
  if (!conversation) return refuse(404, { code: "TARGET_NOT_FOUND", error: TARGET_NOT_FOUND_ERROR, details: named });
  const [visible] = await canViewHomes(viewActorOf(importer), [{ serverId: importer.serverId, home: { kind: "conversation", channelId: conversation.conversationId }, author: importer.actor }]);
  if (!visible) return refuse(404, { code: "TARGET_NOT_FOUND", error: TARGET_NOT_FOUND_ERROR, details: named });
  if (conversation.type === "joint") {
    return refuse(400, {
      code: "TARGET_NOT_SUPPORTED",
      error: `Artifacts can't be imported into a joint channel yet, so ${NOTHING_IMPORTED}: import it into a channel or DM of this server instead.`,
      details: { ...named, reason: "joint" },
    });
  }
  const guests = await conversationGuestAccess(importer.serverId, conversation.conversationId);
  if (guests) {
    return refuse(403, {
      code: "TARGET_HAS_GUESTS",
      error: `${guests === "open_to_guests" ? "That conversation is open to this server's guests" : "That conversation has guests in it"}, and the old artifact was only for this server's members and agents, so ${NOTHING_IMPORTED}: import it for the whole server instead, or into a conversation without guests.`,
      details: { ...named, reason: guests },
    });
  }
  return { kind: "conversation", channelId: conversation.conversationId };
}

/** Live Artifacts of the server an earlier import of this old Artifact made: the one the standalone app names, and the audit's. */
async function earlierImports(executor: DatabaseExecutor, serverId: ServerId, manifest: Pick<LegacyManifest, "artifactId" | "importedTo">): Promise<ArtifactItemRow[]> {
  const ids = new Set<string>();
  if (manifest.importedTo) {
    const ref = parseArtifactRef(manifest.importedTo, { appHosts: appHosts() });
    if (ref.kind === "id") ids.add(ref.id);
  }
  const audited = await executor.select({ itemId: artifactAudit.itemId }).from(artifactAudit)
    .innerJoin(artifactItems, eq(artifactItems.id, artifactAudit.itemId))
    .where(and(
      eq(artifactItems.serverId, serverId),
      eq(artifactAudit.action, ARTIFACT_IMPORT_AUDIT_ACTION),
      sql`${artifactAudit.after}->>'legacyArtifactId' = ${manifest.artifactId}`,
    ));
  for (const row of audited) ids.add(row.itemId);
  if (ids.size === 0) return [];
  return executor.select().from(artifactItems).where(and(
    inArray(artifactItems.id, [...ids]),
    eq(artifactItems.serverId, serverId),
    isNull(artifactItems.deletedAt),
    isNull(artifactItems.revokedAt),
  )).orderBy(desc(artifactItems.createdAt));
}

/** Step 7: the earlier import the importer sees (the ops actor: any); ALREADY_IMPORTED when there is one it doesn't; null when none stands. */
async function earlierImportFor(executor: DatabaseExecutor, importer: Importer, manifest: LegacyManifest, named: { server: string; name: string }): Promise<ArtifactItemRow | null> {
  const earlier = await earlierImports(executor, importer.serverId, manifest);
  if (earlier.length === 0) return null;
  if (importer.ops) return earlier[0]!;
  const visible = await canViewArtifacts(viewActorOf(importer), earlier, { executor });
  const seen = earlier.find((_, index) => visible[index]);
  return seen ?? refuse(409, {
    code: "ALREADY_IMPORTED",
    error: "That artifact was already imported, and the result is somewhere you can't see: ask whoever imported it, or a member of where it lives, to share it with you.",
    details: named,
  });
}

/**
 * The old Artifact's creator as the new one's author, or null when Raft
 * doesn't confirm it: the standalone app's `type` and `raftId` are hints,
 * taken only when the id is a live principal of exactly that type in
 * `serverId` now (an agent of it not deleted, or a member of any role, guests
 * included: standsInOwnServer). Another type, another server's, a deleted
 * agent, a person who left, an id that isn't one, or none: null. Read only.
 */
export async function legacyAuthor(
  serverId: ServerId,
  creator: LegacyCreator | null,
  opts?: { executor?: DatabaseExecutor },
): Promise<ArtifactActorRef | null> {
  if (!creator || !UUID.test(creator.raftId)) return null;
  const actor: ArtifactActorRef = { type: creator.type, id: creator.raftId.toLowerCase() };
  return (await standsInOwnServer({ ...actor, serverId }, opts)) ? actor : null;
}

/**
 * Whether the per-server move may import an old public Artifact into the
 * public home, keeping it public: Raft's rule for turning on an Artifact's
 * link sharing (manage.ts widenRefusal, #11285) asked for the author the
 * import would give it. That author is the old creator Raft confirms
 * (legacyAuthor), and must be a person (`public` only by a person) who may
 * widen it (canManageObject "widen": an author standing in the server, not
 * a guest); it sees the public home by definition. No confirmed creator is
 * `system_author`: the ops actor is no one, and no person of the server is
 * known to stand behind it. Read only.
 */
export async function publicImportRefusal(
  serverId: ServerId,
  creator: LegacyCreator | null,
  opts?: { executor?: DatabaseExecutor },
): Promise<PublicImportRefusal | null> {
  return (await publicImportAssessment(serverId, creator, opts)).refusal;
}

/** publicImportRefusal, and whether an approval may lift it (PublicImportAssessment). Read only. */
export async function publicImportAssessment(
  serverId: ServerId,
  creator: LegacyCreator | null,
  opts?: { executor?: DatabaseExecutor },
): Promise<PublicImportAssessment> {
  const author = await legacyAuthor(serverId, creator, opts);
  if (author) {
    switch (author.type) {
      case "agent":
        return { refusal: "agent_author", approvable: true };
      case "user": {
        const may = await canManageObject({ type: "user", id: author.id, serverId }, { serverId, author }, "widen", opts);
        return { refusal: may ? null : "may_not_make_public", approvable: false };
      }
      default:
        return assertNeverViewActor(author.type);
    }
  }
  // No author Raft confirms. Truly no creator: an approval may stand behind it.
  if (!creator) return { refusal: "system_author", approvable: true };
  // A creator named but not confirmed: only an id that is an agent of this
  // server (a deleted one) may be approved; a guest (whatever type it was
  // given), a former member, a member typed as an agent, anything else: not.
  const found = await principalInServer(serverId, creator.raftId, opts);
  return { refusal: "system_author", approvable: found?.kind === "agent" };
}

/**
 * publicImportRefusal for an import into `home`, thrown, or what it stands
 * on: its author's right, else an approval that may lift the refusal (only
 * an author's, only for a page the standalone app answered public, only by
 * one who is a Raft platform owner or admin now). Nothing to check
 * for a private home (null).
 */
async function checkPublicImport(
  serverId: ServerId,
  home: ImportHome,
  creator: LegacyCreator | null,
  approval: PublicImportApproval | undefined,
  opts?: { executor?: DatabaseExecutor },
): Promise<PublicBasis | null> {
  if (home.kind !== "public") return null;
  const { refusal, approvable } = await publicImportAssessment(serverId, creator, opts);
  if (!refusal) return { kind: "author" };
  if (approval && approvable && approval.legacyVisibility === "public" && (await isPlatformOwnerOrAdmin(approval.approver.id, opts))) {
    return { kind: "approval", approval };
  }
  throw new PublicImportRefused(refusal);
}

/** The live Artifact of the home that has `name`, if any. */
async function holderOf(executor: DatabaseExecutor, serverId: ServerId, home: ImportHome, name: string): Promise<ArtifactItemRow | null> {
  const [row] = await executor.select().from(artifactItems)
    .where(and(await liveInHome(executor, serverId, home), eq(artifactItems.name, name))).limit(1);
  return row ?? null;
}
const nameTaken = (holder: ArtifactItemRow): never =>
  refuse(409, {
    code: "NAME_TAKEN",
    error: `Another artifact where this would be imported already has the old artifact's name, so ${NOTHING_IMPORTED}: open that one instead, or import into another conversation.`,
    details: { name: holder.name, existing: { id: holder.id, url: artifactLink(holder.id) } },
  });

/** The whole import's deadline (steps 6 to 10): its signal ends the requests to the standalone app, `check` the steps between them. */
function importDeadline() {
  const signal = AbortSignal.timeout(deadlineMs);
  const timedOut = (): never => refuse(503, {
    code: "IMPORT_UNAVAILABLE",
    error: `The import took longer than ${Math.round(deadlineMs / 60_000)} minutes, so it was stopped and ${NOTHING_IMPORTED}: try the same import again later.`,
    details: { reason: "timeout" },
  });
  return { signal, timedOut, check: () => { if (signal.aborted) timedOut(); } };
}
type ImportDeadline = ReturnType<typeof importDeadline>;

/**
 * Step 8 for the manifest alone: its files are well-formed and within
 * publishing's limits, or, in the per-server move with `maxFileBytes`, a
 * download (not the entry, not text) within that.
 */
function checkManifest(manifest: LegacyManifest, maxFileBytes?: number): void {
  const files = manifest.version.files;
  if (files.length > AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION) {
    refuse(413, {
      code: "IMPORT_TOO_LARGE",
      error: `The old artifact has ${files.length} files and an artifact here holds at most ${AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION}, so ${NOTHING_IMPORTED}: it can't be imported as it is.`,
      details: { reason: "files", count: files.length, limit: AGENT_API_ARTIFACT_MAX_FILES_PER_VERSION },
    });
  }
  const paths = new Set<string>();
  for (const file of files) {
    // The standalone app's own paths follow the same rules; one that doesn't is a bad answer, not the caller's fault.
    if (!isWellFormedArtifactFilePath(file.path) || paths.has(file.path)) throw new LegacyWorkerUnavailable("bad_answer");
    paths.add(file.path);
    const type = artifactFileType(file.path);
    // A download: not text, and not shown (any file but the entry, or an entry Raft offers only to download).
    const download = maxFileBytes !== undefined && !type.text && (file.path !== manifest.entry || type.kind === "other");
    const limit = download ? Math.max(fileLimitOf(file.path), maxFileBytes) : fileLimitOf(file.path);
    if (file.size > limit) {
      refuse(413, {
        code: "IMPORT_TOO_LARGE",
        error: `A file of the old artifact is ${byteSize(file.size)}, over the ${byteSize(limit)} a file here may be, so ${NOTHING_IMPORTED}: it can't be imported as it is.`,
        details: { reason: "file", path: file.path, size: file.size, limit },
      });
    }
  }
  if (!paths.has(manifest.entry)) throw new LegacyWorkerUnavailable("bad_answer");
}

/**
 * Steps 8 (the cap, and the monthly file upload quota) and 9: store the
 * bytes the server lacks. Both are checked for all of them before the first
 * is read; storeBlob checks them again, exactly, for each (and counts each
 * against the quota; `quota: "exempt"`, the per-server move: neither checks
 * nor counts it). Every blob row made is added to `claims` (for deleting them
 * if the import fails). Answers how many files, and bytes, it fetched.
 */
async function copyBytes(input: {
  config: LegacyWorkerConfig;
  store: ArtifactR2Store | null;
  serverId: ServerId;
  named: { server: string; name: string };
  manifest: LegacyManifest;
  deadline: ImportDeadline;
  claims: BlobClaim[];
  quota: StoreBlobQuota;
}): Promise<{ files: number; bytes: number }> {
  const { config, store, serverId, named, manifest, deadline, claims, quota } = input;
  const { name } = named;
  const bySha = new Map(manifest.version.files.map((file) => [file.sha256, file]));
  const present = await presentBlobs(serverId, [...bySha.keys()]);
  for (const [sha256, blob] of present) {
    // Bytes this server holds for that sha256 are another size: the manifest is wrong about them.
    if (blob.sizeBytes !== bySha.get(sha256)!.size) refuse(502, mismatch(bySha.get(sha256)!.path, "size"));
  }
  const missing = [...bySha.values()].filter((file) => !present.has(file.sha256));
  if (missing.length === 0) return { files: 0, bytes: 0 };
  const needed = missing.reduce((sum, file) => sum + file.size, 0);
  const used = await unreferencedBytes(serverId);
  if (used + needed > AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES) {
    refuse(413, overCap(used, needed, AGENT_API_ARTIFACT_MAX_UNREFERENCED_UPLOAD_BYTES));
  }
  if (quota === "count") {
    try {
      await checkFileUploadQuota(serverId, needed);
    } catch (error) {
      if (error instanceof FileUploadQuotaExceededError) throw new ImportQuotaRefusal(serverId, error);
      throw error;
    }
  }
  if (!store) return refuse(503, { code: "ARTIFACTS_STORAGE_UNAVAILABLE", error: STORAGE_UNAVAILABLE_ERROR });
  for (const file of missing) {
    deadline.check();
    const fetched = await fetchLegacyBlob(config, { serverId, name, sha256: file.sha256, size: file.size }, deadline.signal);
    if (fetched.kind === "not_found") {
      return refuse(404, { code: "LEGACY_NOT_FOUND", error: `raft-artifacts.com no longer has a file of this artifact, so ${NOTHING_IMPORTED}: it may have been deleted there.`, details: named });
    }
    if (fetched.kind === "too_long" || fetched.bytes.length !== file.size) {
      return refuse(502, mismatch(file.path, "size"));
    }
    const bytes = fetched.bytes;
    if (sha256Hex(bytes) !== file.sha256) refuse(502, mismatch(file.path, "sha256"));
    deadline.check();
    const stored = await storeBlob(store, serverId, file.sha256, bytes, { onClaim: (claim) => claims.push(claim), quota });
    if (stored.kind === "quota_exceeded") {
      refuse(413, overCap(stored.used, file.size, stored.limit));
    }
    // Another upload took the month's room since the check above.
    if (stored.kind === "file_upload_quota_exceeded") throw new ImportQuotaRefusal(serverId, stored.error);
  }
  return { files: missing.length, bytes: needed };
}

/** A thrown refusal's code on the step's span (trace.ts); anything else only has its error class. */
const refusalAttrs = (error: unknown) => (error instanceof ImportRefusal ? { code: error.code } : error instanceof ImportQuotaRefusal ? { code: "FILE_UPLOAD_QUOTA_EXCEEDED" } : {});

/** Step 10. An earlier import that stands (found again under the lock) instead of a new one. `byCreator`: the author is the old Artifact's creator (else the importer). */
async function commitImport(input: {
  importer: Importer;
  home: ImportHome;
  manifest: LegacyManifest;
  link: { server: string; name: string; link: string };
  approval?: PublicImportApproval;
}): Promise<{ item: ArtifactItemRow; created: boolean; byCreator?: boolean; publicBasis?: PublicBasis["kind"] }> {
  const { importer, home, manifest, link, approval } = input;
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`artifact-import:${importer.serverId}:${manifest.artifactId}`}))`);
    const earlier = await earlierImportFor(tx, importer, manifest, { server: link.server, name: link.name });
    if (earlier) return { item: earlier, created: false };
    // Again in this transaction: the author's role may have changed since the first check.
    const basis = await checkPublicImport(importer.serverId, home, manifest.creator, approval, { executor: tx });
    const holder = await holderOf(tx, importer.serverId, home, link.name);
    if (holder) nameTaken(holder);

    const files = [...manifest.version.files].sort((a, b) => (a.path < b.path ? -1 : 1));
    const present = await presentBlobs(importer.serverId, files.map((file) => file.sha256), { executor: tx, lock: true });
    for (const file of files) {
      // Stored in step 9 or before; the hourly sweep takes only blobs a day old with no version (and a failed import only its own).
      if (!present.has(file.sha256)) throw new Error(`artifact import: the bytes of ${file.path} are gone before the commit`);
    }
    const creator = await legacyAuthor(importer.serverId, manifest.creator, { executor: tx });
    const author = creator ?? importer.actor;
    // The creator follows it only when it sees it.
    const creatorSees = creator !== null && (await canViewHomes({ ...creator, serverId: importer.serverId }, [{ serverId: importer.serverId, home: homeRefOf(importer.serverId, home), author: creator }], { executor: tx }))[0] === true;
    const title = cut(manifest.title.trim() || link.name, AGENT_API_ARTIFACT_MAX_TITLE_CHARS);
    const description = manifest.description === null ? null : cut(manifest.description, AGENT_API_ARTIFACT_MAX_DESCRIPTION_CHARS);
    const id = `pt_${randomUUID()}`;
    const [inserted] = await tx.insert(artifactItems).values({
      id,
      serverId: importer.serverId,
      urlKey: id,
      name: link.name,
      title,
      description,
      homeKind: home.kind,
      homeChannelId: home.kind === "conversation" ? home.channelId : null,
      // Its original conversation (#75; none when imported into the whole server), never changed.
      originalHomeChannelId: home.kind === "conversation" ? home.channelId : null,
      createdByType: author.type,
      createdById: author.id,
    }).returning();
    const position = inserted!.lastPosition + 1;
    const [version] = await tx.insert(artifactVersions).values({
      id: `v_${randomUUID()}`,
      itemId: id,
      number: 1,
      entry: manifest.entry,
      title,
      description,
      baseId: null,
      label: null,
      note: cut(`Imported from ${link.link}`, AGENT_API_ARTIFACT_MAX_NOTE_CHARS),
      fileCount: files.length,
      sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      publishDigest: createHash("sha256").update(JSON.stringify(["import", manifest.artifactId, manifest.version.number])).digest("hex"),
      provenance: { importedFrom: { link: link.link, legacyArtifactId: manifest.artifactId, version: manifest.version.number } },
      status: "published",
      publisherType: author.type,
      publisherId: author.id,
      position,
    }).returning();
    if (files.length > 0) {
      await tx.insert(artifactVersionFiles).values(files.map((file) => ({
        versionId: version!.id,
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.size,
        blobId: present.get(file.sha256)!.id,
      })));
    }
    const [item] = await tx.update(artifactItems).set({ currentVersionId: version!.id, lastPosition: position, updatedAt: sql`now()` })
      .where(eq(artifactItems.id, id)).returning();
    await indexArtifactSearch(tx, item!);
    // The author (when it sees it) and the importer have read it (nothing
    // unread) and follow it, as a publisher does; the ops actor is no one:
    // it reads and follows nothing.
    const readers: ArtifactActorRef[] = creator && creatorSees ? [creator] : [];
    if (!importer.ops && !(creator && actorKey(creator) === actorKey(importer.actor))) readers.push(importer.actor);
    for (const reader of readers) await advanceReadPosition(reader, id, position, tx);
    // A new Artifact has no followers yet: the event is for no one.
    await recordArtifactEvent(tx, { item: item!, eventKind: "version", actor: importer.actor, data: { position, version: 1 }, recipients: [] });
    for (const reader of readers) await autoSubscribe(tx, id, reader, "published");
    // No author Raft confirms (the ops actor is the author, and it follows
    // nothing): the server's live human owners follow it instead (Tenny
    // 2026-10-30), as following does (a `followed` row, read up to its last
    // position), so someone of the server has it on their Artifacts page and
    // hears of its comments. They see the whole server's and the public home.
    if (importer.ops && !creator) {
      for (const ownerId of await serverOwnerIds(importer.serverId, { executor: tx })) {
        const owner: ArtifactActorRef = { type: "user", id: ownerId };
        await advanceReadPosition(owner, id, position, tx);
        await tx.insert(artifactSubscriptions).values({ itemId: id, actorType: owner.type, actorId: owner.id, reason: "followed" }).onConflictDoNothing();
      }
    }
    const after: ImportAudit = {
      legacyArtifactId: manifest.artifactId, from: link.link, server: link.server, name: link.name, version: manifest.version.number,
      ...(importer.ops ? { ops: { operator: importer.ops.operator } } : {}),
      legacyCreator: manifest.creator && { type: manifest.creator.type, raftId: manifest.creator.raftId, name: cut(manifest.creator.name, 200), author: creator !== null },
      ...(home.kind === "public" ? { home: "public" as const } : {}),
    };
    await tx.insert(artifactAudit).values({
      itemId: id,
      actorType: importer.actor.type,
      actorId: importer.actor.id,
      action: ARTIFACT_IMPORT_AUDIT_ACTION,
      before: null,
      after: { ...after },
    });
    if (basis) {
      // As a move to the public home writes it (manage.ts widenArtifactHome), by
      // whoever made it public here: the ops actor on its author's right
      // (publicImportRefusal, naming the author), or the approver, with the
      // operator and the approval's message.
      const approved = basis.kind === "approval" ? basis.approval : null;
      await tx.insert(artifactAudit).values({
        itemId: id,
        actorType: approved ? "user" : importer.actor.type,
        actorId: approved ? approved.approver.id : importer.actor.id,
        action: "made_public",
        before: null,
        after: {
          ...homeFacts(item!),
          via: ARTIFACT_IMPORT_AUDIT_ACTION,
          author: { type: author.type, id: author.id },
          ...(importer.ops ? { ops: { operator: importer.ops.operator } } : {}),
          ...(approved ? { approvedBy: { type: "user", id: approved.approver.id, name: approved.approver.name }, approvalRef: approved.ref } : {}),
        },
      });
    }
    return { item: item!, created: true, byCreator: creator !== null, ...(basis ? { publicBasis: basis.kind } : {}) };
  });
}

const isUniqueViolation = (error: unknown): boolean => {
  for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === "23505") return true;
  }
  return false;
};

/** Steps 1 to 11. */
async function importLegacyArtifact(importer: Importer, input: { from: string; target: ImportTarget }): Promise<ImportOutcome> {
  if (!(await artifactsEnabled(importer.serverId))) refuse(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });
  const from = input.from.trim();
  const parsed = from.length > FROM_MAX_CHARS
    ? { kind: "invalid" as const, reason: "not_a_link" as const }
    : parseLegacyArtifactLink(from, { extraHosts: extraLegacyHosts() });
  if (parsed.kind === "invalid") {
    return refuse(400, {
      code: "NOT_A_LEGACY_LINK",
      error: parsed.reason === "legacy_version_link"
        ? "That is an old link to a single version, which doesn't say which artifact it belongs to: ask whoever shared it for the artifact's link, https://raft-artifacts.com/p/<server>/<name>."
        : "That isn't a link to an artifact on raft-artifacts.com: pass the artifact's link as https://raft-artifacts.com/p/<server>/<name>, the address of its page there.",
      details: { from: cut(from, 200), reason: parsed.reason },
    });
  }

  const [member] = await canViewHomes(viewActorOf(importer), [{ serverId: importer.serverId, home: { kind: "server", serverId: importer.serverId }, author: importer.actor }]);
  if (!member) refuse(403, { code: "FORBIDDEN", error: "Only this server's members (not its guests) and agents can import an artifact: ask a member to import it." });
  // Raft keeps no slug history: a slug that names no server now (renamed
  // since) is taken as the caller's own server, and the standalone app,
  // asked by S's id, answers 404 if the Artifact isn't S's. A slug another
  // server has now is refused, though it may have been S's before a rename.
  const slugServer = await serverIdBySlug(parsed.server.toLowerCase());
  if (slugServer !== null && slugServer !== importer.serverId) {
    refuse(403, {
      code: "LEGACY_OTHER_SERVER",
      error: "This link's server name now belongs to another server, and an import only brings in this server's artifacts: if it is that server's, ask someone there to import it.",
      details: { server: parsed.server },
    });
  }
  const home = await homeOf(importer, input.target);
  const slot = await importSlots.take(`slock:artifacts:imports:${importer.serverId}`, ARTIFACT_IMPORTS_AT_ONCE, deadlineMs + IMPORT_LEASE_GRACE_MS);
  if (!slot.taken) {
    return refuse(429, {
      code: AGENT_API_RATE_LIMITED_CODE,
      error: `This server already has ${ARTIFACT_IMPORTS_AT_ONCE} imports running, the most at once, so ${NOTHING_IMPORTED}: try the same import again in ${ARTIFACT_IMPORT_BUSY_RETRY_AFTER_SECONDS} seconds.`,
      details: { operation: "artifactImport", limit: ARTIFACT_IMPORTS_AT_ONCE, windowSeconds: ARTIFACT_IMPORT_BUSY_RETRY_AFTER_SECONDS, retryAfterSeconds: ARTIFACT_IMPORT_BUSY_RETRY_AFTER_SECONDS },
      retryAfterSeconds: ARTIFACT_IMPORT_BUSY_RETRY_AFTER_SECONDS,
      rateLimiter: ARTIFACT_IMPORT_RATE_LIMITER,
    });
  }
  try {
    return await importFromStandaloneApp(importer, { link: parsed, home });
  } finally {
    await slot.release();
  }
}

/** Steps 6 to 11, for `link` (its server slug, name and canonical form) into `home`. */
async function importFromStandaloneApp(importer: Importer, input: { link: { server: string; name: string; link: string }; home: ImportHome; approval?: PublicImportApproval; expectedArtifactId?: string }): Promise<ImportOutcome> {
  const { link: parsed, home, approval, expectedArtifactId } = input;
  const config = legacyWorkerConfig();
  if (!config) {
    return refuse(503, {
      code: "IMPORT_UNAVAILABLE",
      error: `Importing from raft-artifacts.com isn't set up on this Raft server, so ${NOTHING_IMPORTED}: tell an admin of this server, since retrying won't help.`,
      details: { reason: "not_configured" },
    });
  }
  const legacyRef = { server: parsed.server, name: parsed.name };
  const deadline = importDeadline();
  const store = artifactR2Store();
  // The blob rows this import made: deleted at once unless it creates the Artifact.
  const claims: BlobClaim[] = [];
  let created = false;
  try {
    const manifest = await withAppSpan("server.artifacts.import.manifest", {}, () => fetchLegacyManifest(config, importer.serverId, parsed.name, deadline.signal), {
      onSuccess: (found) => (found
        ? { outcome: "found", files_bucket: countBucket(found.version.files.length), bytes_bucket: byteSizeBucket(found.version.files.reduce((sum, file) => sum + file.size, 0)) }
        : { outcome: "not_found" }),
      onError: refusalAttrs,
    });
    if (!manifest) {
      return refuse(404, {
        code: "LEGACY_NOT_FOUND",
        error: "raft-artifacts.com has no artifact by that name in this server: check the name after /p/<server>/ in the link, since it may have been deleted there.",
        details: legacyRef,
      });
    }
    if (manifest.name !== parsed.name) throw new LegacyWorkerUnavailable("bad_answer");
    // Pages are fetched by name: the one the move listed (and its plan names) by id, or none.
    if (expectedArtifactId !== undefined && manifest.artifactId !== expectedArtifactId) {
      refuse(502, {
        code: "IMPORT_MISMATCH",
        error: `raft-artifacts.com's artifact by this name is not the one listed for it, so ${NOTHING_IMPORTED}: list the server's artifacts again before importing it.`,
        details: { reason: "artifact_id", expected: expectedArtifactId, actual: manifest.artifactId },
      });
    }

    const earlier = await earlierImportFor(getDb(), importer, manifest, legacyRef);
    if (earlier) {
      await tellStandaloneApp(config, importer, earlier, manifest);
      return { item: earlier, created: false, from: parsed.link };
    }
    if (!ARTIFACT_NAME.test(parsed.name) || isReservedArtifactName(parsed.name)) {
      refuse(400, invalidName(parsed.name, isReservedArtifactName(parsed.name)));
    }
    checkManifest(manifest, importer.ops?.maxFileBytes);
    // Kept public only where Raft's rule lets its author make it public; before any byte is copied.
    await checkPublicImport(importer.serverId, home, manifest.creator, approval);
    const holder = await holderOf(getDb(), importer.serverId, home, parsed.name);
    if (holder) nameTaken(holder);
    await withAppSpan("server.artifacts.import.blobs", {}, () => copyBytes({ config, store, serverId: importer.serverId, named: legacyRef, manifest, deadline, claims, quota: importer.ops ? "exempt" : "count" }), {
      onSuccess: (copied) => ({ files_bucket: countBucket(copied.files), bytes_bucket: byteSizeBucket(copied.bytes) }),
      onError: refusalAttrs,
    });
    deadline.check();

    let committed: { item: ArtifactItemRow; created: boolean; byCreator?: boolean };
    try {
      committed = await withAppSpan("server.artifacts.import.commit", {}, () => commitImport({ importer, home, manifest, link: parsed, approval }), {
        onSuccess: (done) => ({ created: done.created }),
      });
    } catch (error) {
      // Another Artifact took the name in the home meanwhile.
      if (!isUniqueViolation(error)) throw error;
      const taken = await holderOf(getDb(), importer.serverId, home, parsed.name);
      if (!taken) throw error;
      return nameTaken(taken);
    }
    created = committed.created;
    // Public: its signed-out text, in the background, as making an Artifact public does (publicText.ts).
    if (created) fillCurrentPublicText(committed.item);
    // A Markdown entry's excerpt, what its card shows (excerpt.ts): bounded, never failing the import.
    if (created) await fillCurrentExcerpt(committed.item);
    await tellStandaloneApp(config, importer, committed.item, manifest);
    return { ...committed, from: parsed.link };
  } catch (error) {
    if (error instanceof LegacyWorkerUnavailable) {
      // A request the deadline ended is the deadline's.
      if (deadline.signal.aborted) return deadline.timedOut();
      return refuse(503, {
        code: "IMPORT_UNAVAILABLE",
        error: error.reason === "rate_limited"
          ? `raft-artifacts.com is busy with other imports right now, so ${NOTHING_IMPORTED}: try the same import again in a minute.`
          : `raft-artifacts.com didn't answer usably, so ${NOTHING_IMPORTED}: try the same import again in a minute, and if it keeps failing tell a human.`,
        details: { reason: error.reason },
      });
    }
    throw error;
  } finally {
    if (!created && store && claims.length > 0) await forgetBytes(store, importer.serverId, claims);
  }
}

/** Step 9 undone: a failed import's blob rows, deleted at once (best effort: what stays, the day-old sweep takes). */
async function forgetBytes(store: ArtifactR2Store, serverId: ServerId, claims: readonly BlobClaim[]): Promise<void> {
  try {
    await deleteClaimedBlobs(store, serverId, claims);
  } catch (error) {
    console.warn("[artifacts] a failed import's bytes could not be deleted; the sweep takes them", { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Step 11: tell the standalone app where its Artifact went, unless it already
 * names that one (an earlier import whose notice failed is told again).
 */
async function tellStandaloneApp(config: LegacyWorkerConfig, importer: Importer, item: ArtifactItemRow, manifest: LegacyManifest): Promise<void> {
  if (manifest.importedTo) {
    const ref = parseArtifactRef(manifest.importedTo, { appHosts: appHosts() });
    if (ref.kind === "id" && ref.id === item.id) return;
  }
  const names = importer.ops ? new Map<string, string>() : await actorNames([importer.actor]);
  await notifyLegacyImported(config, {
    serverId: importer.serverId,
    name: manifest.name,
    newUrl: artifactLink(item.id),
    // Its home here now: public only for the per-server move's `--public` (the standalone app's 301 needs it).
    public: item.homeKind === "public",
    importedBy: importer.ops ? OPS_IMPORTED_BY : names.get(actorKey(importer.actor)) ?? `${importer.actor.type}:${importer.actor.id}`,
  });
}

/**
 * The per-server move's answer for one old Artifact; `failed`: the refusal,
 * as the APIs would answer it. `author` (imported): its old creator, or
 * `ops` when Raft doesn't confirm that one in the server (the ops actor).
 */
export type OpsImportOutcome =
  | { kind: "imported"; item: { id: string; url: string }; author: "creator" | "ops"; publicBasis?: "author" | "approval" }
  | { kind: "already_imported"; item: { id: string; url: string } }
  /** `home: "public"` only: Raft's rule doesn't let its author make it public (publicImportRefusal); nothing imported. */
  | { kind: "refused_public"; reason: PublicImportRefusal }
  | { kind: "failed"; status: number; code: string; message: string; details?: Record<string, unknown> };

/** The old Artifact's link on raft-artifacts.com, as the move's note and audit name it; null for a name no link can carry. */
export function legacyLinkOf(serverSlug: string, name: string): string | null {
  const parsed = parseLegacyArtifactLink(`https://${ARTIFACT_LEGACY_HOSTS[0]}/p/${encodeURIComponent(serverSlug)}/${encodeURIComponent(name)}`);
  return parsed.kind === "invalid" || parsed.name !== name ? null : parsed.link;
}

/**
 * The per-server move (legacyBulkImport.ts): import the standalone app's
 * Artifact `name` of `serverId` (whose slug now is `serverSlug`, for the old
 * link the note and audit name) into the whole server, or with `home:
 * "public"` into its public home (an Artifact public there; refused_public
 * where publicImportRefusal refuses it), as the ops actor, steps 6 to 11
 * (see the top of this file). Never requests anything but the configured
 * standalone app. A refusal is `failed`; anything else unexpected (a store
 * error) throws, the bytes it stored deleted as for any import.
 */
export async function importLegacyArtifactAsOps(input: {
  serverId: ServerId;
  serverSlug: string;
  name: string;
  operator: string;
  home?: "server" | "public";
  approval?: PublicImportApproval;
  /** The old Artifact's id as the move listed it: a manifest naming another is IMPORT_MISMATCH (`artifact_id`). */
  expectedArtifactId?: string;
  /** A download's limit raised to this (at most ARTIFACT_OPS_IMPORT_MAX_FILE_BYTES): checkManifest. */
  maxFileBytes?: number;
}): Promise<OpsImportOutcome> {
  if (input.maxFileBytes !== undefined && !(Number.isInteger(input.maxFileBytes) && input.maxFileBytes > 0 && input.maxFileBytes <= ARTIFACT_OPS_IMPORT_MAX_FILE_BYTES)) {
    throw new Error(`maxFileBytes is at most ${ARTIFACT_OPS_IMPORT_MAX_FILE_BYTES} bytes`);
  }
  const ops = { operator: input.operator, ...(input.maxFileBytes !== undefined ? { maxFileBytes: input.maxFileBytes } : {}) };
  const importer: Importer = { actor: ARTIFACT_OPS_IMPORT_ACTOR, serverId: input.serverId, ops };
  const parsed = parseLegacyArtifactLink(`https://${ARTIFACT_LEGACY_HOSTS[0]}/p/${encodeURIComponent(input.serverSlug)}/${encodeURIComponent(input.name)}`);
  try {
    if (parsed.kind === "invalid" || parsed.name !== input.name) {
      return refuse(400, invalidName(input.name, false));
    }
    const outcome = await importFromStandaloneApp(importer, {
      link: parsed, home: { kind: input.home ?? "server" },
      ...(input.approval ? { approval: input.approval } : {}),
      ...(input.expectedArtifactId !== undefined ? { expectedArtifactId: input.expectedArtifactId } : {}),
    });
    const item = { id: outcome.item.id, url: artifactLink(outcome.item.id) };
    return outcome.created
      ? { kind: "imported", item, author: outcome.byCreator ? "creator" : "ops", ...(outcome.publicBasis ? { publicBasis: outcome.publicBasis } : {}) }
      : { kind: "already_imported", item };
  } catch (error) {
    if (error instanceof PublicImportRefused) return { kind: "refused_public", reason: error.reason };
    if (error instanceof ImportRefusal) {
      const { details } = error.refusal;
      return { kind: "failed", status: error.status, code: error.code, message: error.refusal.error, ...(details ? { details } : {}) };
    }
    if (error instanceof ImportQuotaRefusal) return { kind: "failed", status: error.error.status, code: "FILE_UPLOAD_QUOTA_EXCEEDED", message: error.error.message };
    throw error;
  }
}

/**
 * The per-server move's step 7 without asking the standalone app: the live
 * Artifact of `serverId` an earlier import of this old Artifact made (the one
 * `importedTo` names, or the audit's), or null when none stands. Read only.
 */
export async function standingImport(serverId: ServerId, legacy: { artifactId: string; importedTo: string | null }): Promise<{ id: string; url: string } | null> {
  const [item] = await earlierImports(getDb(), serverId, legacy);
  return item ? { id: item.id, url: artifactLink(item.id) } : null;
}

/** A refusal as the agent API answers it. */
async function asAgentAnswer<T>(run: () => Promise<T>): Promise<T | ArtifactApiError> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ImportRefusal) {
      const { rateLimiter, ...refusal } = error.refusal;
      const answer = fail(error.status, refusal);
      return rateLimiter ? { ...answer, rateLimiter } : answer;
    }
    // The attachments' body, as publish answers it. No upgrade card: no released CLI or SDK imports any more (#12378).
    if (error instanceof ImportQuotaRefusal) return fileUploadQuotaRefusal(error.serverId, error.error, "artifact_import");
    throw error;
  }
}

/** A refusal as the web API answers it. */
async function asWebAnswer<T>(run: () => Promise<T>): Promise<T | ArtifactWebApiError> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ImportRefusal) {
      const { rateLimiter, ...refusal } = error.refusal;
      const answer = webFail(error.status, refusal);
      return rateLimiter ? { ...answer, rateLimiter } : answer;
    }
    if (error instanceof ImportQuotaRefusal) return webFileUploadQuotaRefusal(error.serverId, error.error, "artifact_import");
    throw error;
  }
}

/** The web body: `{ from, conversationId? }`, strings, nothing else; null otherwise. */
function parseWebImportInput(body: unknown): { from: string; conversationId?: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { from, conversationId, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof from !== "string") return null;
  if (conversationId === undefined) return { from };
  return typeof conversationId === "string" ? { from, conversationId } : null;
}

/** `server.artifacts.import` (trace.ts) around one import's answer: created, existing, or the refusal's code. */
function importSpan<T extends { kind: "json"; body: { created: boolean }; status?: number } | { kind: "error"; status: number; body: { code: string } }>(via: "agent" | "web", run: () => Promise<T>): Promise<T> {
  return withAppSpan("server.artifacts.import", { via }, run, {
    onSuccess: (result) => (result.kind === "json" ? { outcome: result.body.created ? "created" : "existing", status_code: result.status ?? 200 } : answerAttrs(result)),
    statusOf: answerStatus,
  });
}

export function createImportOperations() {
  return {
    /**
     * `POST /internal/agent-api/artifacts/import` (the body is checked against the contract by core).
     * Only CLIs from before `raft artifact import` was removed call it: delete it once the
     * `server.artifacts.import` span with `via=agent` has been zero for 30 days in a row.
     */
    importArtifact: (agent: ArtifactAgent, body: AgentApiArtifactImportBody): Promise<ArtifactApiJson<AgentApiArtifactImported> | ArtifactApiError> => importSpan("agent", () => asAgentAnswer(async () => {
      const importer: Importer = { actor: { type: "agent", id: agent.agentId }, serverId: agent.serverId };
      const target: ImportTarget = body.target === undefined ? { kind: "server" } : { kind: "agent", agent, target: body.target };
      const outcome = await importLegacyArtifact(importer, { from: body.from, target });
      const [artifact] = await summarize(agent, [outcome.item]);
      return json<AgentApiArtifactImported>({ artifact: artifact!, created: outcome.created, from: outcome.from }, outcome.created ? 201 : 200);
    })),

    /** `POST /api/artifacts/import`. */
    webImport: (reader: ArtifactWebReader, body: unknown): Promise<ArtifactApiJson<ArtifactWebImported> | ArtifactWebApiError> => importSpan("web", () => asWebAnswer(async () => {
      const input = parseWebImportInput(body);
      if (!input) return webBadBody("{ from, conversationId? }");
      const importer: Importer = { actor: { type: "user", id: reader.userId }, serverId: reader.serverId };
      const target: ImportTarget = input.conversationId === undefined ? { kind: "server" } : { kind: "id", conversationId: input.conversationId };
      const outcome = await importLegacyArtifact(importer, { from: input.from, target });
      const shown = await atCurrentVersions([outcome.item]);
      const actorOf = await profiler(shown.map(cardAuthorRef));
      const [card] = await artifactCards(reader, shown, actorOf);
      return json<ArtifactWebImported>({ card: card!, created: outcome.created, from: outcome.from }, outcome.created ? 201 : 200);
    })),
  };
}
