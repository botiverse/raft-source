// What the agent API's operations share (read side in routes.ts, publish in
// publish.ts, comments and following in comments.ts, moving and deleting in
// manage.ts, notices in notices.ts): the caller, the notice outbox core
// supplies, results and errors, the flag gate, resolving a visible Artifact,
// read positions, handles and summaries. Core's data comes through the
// platform entries (packages/server/src/platform/*); core reaches the module
// only through its registration (register.ts), which mounts the operations
// (mount.ts).
import type { Readable } from "node:stream";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, min, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  type AGENT_API_RATE_LIMITED_CODE,
  AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS,
  artifactFileType,
  artifactLinkId,
  artifactPagePath,
  asArtifactId,
  asArtifactReviewId,
  isArtifactName,
  parseArtifactId,
  type AgentApiArtifactActor,
  type AgentApiArtifactComment,
  type AgentApiArtifactErrorCode,
  type AgentApiArtifactHome,
  type AgentApiArtifactSummary,
  RAFT_HINTS,
  taskRefConversationTarget,
  type PaywallHitVia,
  type RefusalBody,
  type ServerId,
  WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { markObjectRead } from "../../platform/activity";
import { actorKey, actorNames } from "../../platform/actors";
import type { AppNoticeOutbox, AppPaywallHit } from "../../platform/apps";
import { agentConversationRefs, conversationNames, type ConversationName, type ConversationType } from "../../platform/conversations";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import {
  agentQuotaUpgradeHint,
  fileUploadQuotaExceededResponse,
  fileUploadQuotaPaywallHit,
  type FileUploadQuotaExceededError,
  type FileUploadQuotaExceededResponse,
  type UpgradeCardUploadSubject,
} from "../../platform/fileUploadQuota";
import { appEnabled, appEnabledOnLiveServer, appEnabledOnLiveServers } from "../../platform/flags";
import { appUrl, serverNames } from "../../platform/links";
import { refusalBody, type RefusalInput } from "../../platform/refusals";
import { seenThroughJoint, type ServerViewActor } from "../../platform/visibility";
import { artifactR2Store, type ArtifactBlobBytes, type ArtifactBlobReader } from "./blobStore";
// Registers what answers workspace_artifacts_v0 (the deployment, not Feature Flag Admin) before anything here asks it.
import "./deployment";
import {
  artifactBlobs,
  artifactComments,
  artifactItems,
  artifactReadPositions,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactActorType,
  type ArtifactBlobRow,
  type ArtifactCommentRow,
  type ArtifactItemRow,
  type ArtifactVersionFileRow,
  type ArtifactVersionRow,
} from "./schema";
import { namedForLookup, titledForLookup } from "./names";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { canViewArtifacts, type ArtifactVisibilitySubject } from "./visibility";

/** The calling agent, from its credential. */
export interface ArtifactAgent {
  agentId: string;
  serverId: ServerId;
}

export type ArtifactActorRef = { type: ArtifactActorType; id: string };

/**
 * The fixed system actors Raft acts as on its own (the audit table's rule:
 * a fixed id, actor_type still user or agent; no person or agent has them).
 * The per-server move's importer: an Artifact it is the author of (Raft
 * doesn't confirm its creator in the server, import.ts legacyAuthor) is
 * managed by the server's owners and admins, and it follows nothing and
 * reads nothing (the server's live human owners follow such an Artifact
 * instead, commitImport).
 */
export const ARTIFACT_OPS_IMPORT_ACTOR: ArtifactActorRef = { type: "user", id: "00000000-0000-4000-8000-0000a7f1fac7" };
/**
 * A Raft operator's takedown or restore (takedown.ts, the operator's script):
 * a fixed system actor of its own, by the same rule as the import's, so the
 * audit tells moderation from the move.
 */
export const ARTIFACT_OPS_MODERATION_ACTOR: ArtifactActorRef = { type: "user", id: "00000000-0000-4000-8000-0000a7f1d0a1" };
/** Whether `actor` is one of Raft's own (shown as "System", ArtifactActor.gone). */
export const isArtifactSystemActor = (actor: ArtifactActorRef): boolean =>
  [ARTIFACT_OPS_IMPORT_ACTOR, ARTIFACT_OPS_MODERATION_ACTOR].some((system) => system.type === actor.type && system.id === actor.id);

/**
 * Where notices to agents go: `system.artifacts` notifications in core's
 * agent event queue (platform/apps AppNoticeOutbox; payload `{ app_event:
 * { ...notice, app: "artifacts", kind: "artifact" } }`). Core hands one to
 * each request (the router's agent orchestrator) and to the flush job.
 */
export type ArtifactNoticeOutbox = AppNoticeOutbox;

/** A code the agent API's Artifacts routes answer a refusal with (AGENT_API_ARTIFACT_ERROR_CODES, or the contract's own). */
export type ArtifactApiErrorCode = AgentApiArtifactErrorCode | "agent_api_contract_invalid" | typeof AGENT_API_RATE_LIMITED_CODE;

/**
 * A refusal of the agent API's Artifacts routes: the Server's refusal
 * envelope (platform/refusals, docs/contracts/agent-api-refusals.md) with one
 * of the contract's codes. `error` is one sentence an agent can act on, naming
 * no command; the step as an operation goes in `next`. `details` keeps the
 * data released clients read to word the refusal themselves (agentText
 * formatArtifactError): it stays until they show `error` instead (#wg-ax:#13 P3).
 */
export type ArtifactRefusal = Omit<RefusalInput, "code"> & { code: ArtifactApiErrorCode };

export type ArtifactApiError = {
  kind: "error";
  status: number;
  /** The refusal envelope. FILE_UPLOAD_QUOTA_EXCEEDED also carries the attachments' refusal fields (fileUploadQuotaRefusal). */
  body: Omit<RefusalBody, "code"> & { code: ArtifactApiErrorCode } & Partial<Omit<FileUploadQuotaExceededResponse, "error" | "errorCode" | "suggestedNextAction">>;
  /** Also Retry-After, where core's transport writes it. */
  retryAfterSeconds?: number;
  /** A plan paywall, recorded by core with the answer (fileUploadQuotaRefusal); not in the body. */
  paywallHit?: AppPaywallHit;
  /** A rate limit's refusal: the limit's name on the request's span (AppError.rateLimiter). */
  rateLimiter?: string;
};
/** A JSON answer; `status` defaults to 200. */
export type ArtifactApiJson<T> = { kind: "json"; body: T; status?: number };
export type ArtifactApiBytes = {
  kind: "bytes";
  stream: Readable;
  size: number;
  contentType: string;
  contentDisposition: string;
};
export type ArtifactApiEmpty = { kind: "empty" };
export type ArtifactApiResult<T> = ArtifactApiJson<T> | ArtifactApiError;

/** A refusal answer, in the envelope (refusalBody checks the sentence: in tests and development a malformed one throws). */
export function fail(status: number, refusal: ArtifactRefusal): ArtifactApiError {
  const body = refusalBody(refusal);
  return {
    kind: "error",
    status,
    body: { ...body, code: refusal.code },
    ...(body.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: body.retryAfterSeconds }),
  };
}

/** A size as a refusal's sentence says it: 1.5 MiB, 12 KiB, 300 bytes. */
export function byteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} bytes`;
}

/**
 * Where an agent's quota refusal offers an upgrade card (fileUploadQuotaRefusal):
 * the agent; the conversation it belongs in (the Artifact's home
 * conversation; the attachment's for a save), null when there is none (a
 * home in the whole server or public); and what was refused, which the
 * offer's lead names (`files` for a push, `saved_file`, `image`).
 */
export interface QuotaCardPlace {
  agentId: string;
  channelId: string | null;
  subject: UpgradeCardUploadSubject;
}

/**
 * The monthly file upload quota (the attachments' one) has no room: 403 with
 * the attachments' sentence and step, in the envelope, with their fields
 * (requestedBytes, quota, billingUrl) at the top level for clients that read
 * them there and as `details` (FILE_UPLOAD_QUOTA_EXCEEDED is in
 * REFUSAL_CODES). The agent API's (CLI and SDK publish, save, import), so the
 * next action is the agent's: say why the file wasn't uploaded, and a server
 * owner can look at Settings > Billing. `via`: the write refused, for the
 * `paywall_hit` core records with it (an agent's: no person).
 *
 * `card` (QuotaCardPlace): the agent, the conversation an upgrade card for
 * this refusal belongs in and what was refused. On a Free server, where the
 * agent's CLI can post one there (platform/fileUploadQuota
 * agentQuotaUpgradeHint), the card offer is the next action, as an attachment
 * upload's is: `suggestedNextAction` and `details.upgradeHint`, which the CLI
 * shows (agentText formatArtifactError).
 */
export async function fileUploadQuotaRefusal(
  serverId: ServerId,
  error: FileUploadQuotaExceededError,
  via: PaywallHitVia,
  card?: QuotaCardPlace,
): Promise<ArtifactApiError> {
  const response = await fileUploadQuotaExceededResponse(serverId, error, "agent");
  const upgradeHint = card?.channelId
    ? await agentQuotaUpgradeHint({ serverId, agentId: card.agentId, channelId: card.channelId, subject: card.subject, error })
    : null;
  const refused = fail(error.status, {
    code: "FILE_UPLOAD_QUOTA_EXCEEDED",
    error: response.error,
    suggestedNextAction: upgradeHint ?? response.suggestedNextAction,
    details: { requestedBytes: response.requestedBytes, quota: response.quota, billingUrl: response.billingUrl, ...(upgradeHint ? { upgradeHint } : {}) },
  });
  return {
    ...refused,
    body: { ...refused.body, requestedBytes: response.requestedBytes, quota: response.quota, billingUrl: response.billingUrl },
    paywallHit: fileUploadQuotaPaywallHit(serverId, error, via),
  };
}

export const json = <T>(body: T, status?: number): ArtifactApiJson<T> => (status === undefined ? { kind: "json", body } : { kind: "json", body, status });
/**
 * The one sentence of every "you can't see it" 404 (Warden reviews it,
 * docs/contracts/agent-api-refusals.md "Uniform refusals"): no such
 * Artifact, one not yours to see, a deleted or a revoked one, read the same.
 * The agent API, the web API and the signed-out routes all answer it.
 */
export const NOT_VISIBLE_ERROR = "No artifact you can see has that id, link or title: it may not exist, may have been deleted, or may not be shared with you, so check the reference or ask whoever shared it.";

/**
 * The one sentence of every 404 TARGET_NOT_FOUND, agent and web alike: a
 * conversation (or thread) named as a home, a list's target or where to share,
 * that doesn't exist or that the caller can't see (or post in) reads the same.
 */
export const TARGET_NOT_FOUND_ERROR = "No conversation you can see matches that: it may not exist, or you may not be in it, so pick a conversation you are a member of.";

/**
 * TARGET_NOT_FOUND's sentence for a target that is a task ref (`#channel:#7`, `dm:@peer:#7`): no
 * conversation, so no home, whether or not the caller can see the task (the ref's shape alone says
 * it; the task isn't looked up).
 */
export const TARGET_IS_TASK_ERROR = "That target is a task, and a task can't be an artifact's home: use the task's conversation (its channel or DM), or the thread the task came from, as the target.";

/**
 * TARGET_NOT_FOUND on the agent API: the sentence above; `details` echoes what was sent (`target`),
 * never what was found. A task ref says why it is no target (TARGET_IS_TASK_ERROR), and its step
 * names the conversation the ref itself names: `via` a push, pushing there; else listing there.
 */
export const targetNotFound = (details: Record<string, unknown>, via: "push" | "list" = "list"): ArtifactApiError => {
  const taskConversation = typeof details.target === "string" ? taskRefConversationTarget(details.target) : null;
  if (taskConversation !== null) {
    const next = via === "push" ? RAFT_HINTS.artifactPublish({ target: taskConversation }) : RAFT_HINTS.artifactList({ target: taskConversation });
    return fail(404, { code: "TARGET_NOT_FOUND", error: TARGET_IS_TASK_ERROR, next, details });
  }
  return fail(404, { code: "TARGET_NOT_FOUND", error: TARGET_NOT_FOUND_ERROR, next: RAFT_HINTS.serverInfo({ view: "channels" }), details });
};

/** One body for "not found", "not yours to see", deleted and revoked alike; the step is the list of what the agent can see. */
export const notVisible = (): ArtifactApiError => fail(404, { code: "NOT_VISIBLE", error: NOT_VISIBLE_ERROR, next: RAFT_HINTS.artifactList({}) });

/**
 * A version the caller can't read: no such number, revoked, or (an outsider
 * of a public Artifact) not the current one. `version` null: the Artifact has
 * no published version at all. The web's refusal says the same (webCommon).
 */
export function versionNotFoundError(version: number | null, currentVersion: number | null): string {
  if (version === null) return "This artifact has no published version yet, so it has no files to read: wait for its first push.";
  const now = currentVersion === null ? "it has no published version yet" : `the current one is v${currentVersion}`;
  return `This artifact has no version ${version} that you can read (${now}): read the current version, or name one it has.`;
}

export function versionNotFound(itemId: string, version: number | null, currentVersion: number | null): ArtifactApiError {
  return fail(404, {
    code: "VERSION_NOT_FOUND",
    error: versionNotFoundError(version, currentVersion),
    next: RAFT_HINTS.artifactRead({ artifact: itemId }),
    details: { version, currentVersion },
  });
}

/** A path the version has no file at. */
export const fileNotFoundError = (version: number): string =>
  `Version ${version} of this artifact has no file at that path: use a path exactly as its file list shows it.`;

export function fileNotFound(itemId: string, path: string, version: number): ArtifactApiError {
  return fail(404, {
    code: "FILE_NOT_FOUND",
    error: fileNotFoundError(version),
    next: RAFT_HINTS.artifactRead({ artifact: itemId, version, files: true }),
    details: { path, version },
  });
}

/** A file path that breaks the rule every artifact file path follows (shared isWellFormedArtifactFilePath). */
export const INVALID_PATH_ERROR = "That isn't a valid artifact file path: a path has no empty, \".\" or \"..\" parts (so no leading, trailing or double slash), no \".git\" part, and none of the characters \\ % ? # or control characters, so use one like assets/app.js.";

export const invalidPath = (path: string): ArtifactApiError => fail(400, { code: "INVALID_PATH", error: INVALID_PATH_ERROR, details: { path } });

/** A reply's `replyTo` that names no live comment of the Artifact (deleted, or another Artifact's). */
export const commentNotFound = (itemId: string, replyTo: string): ArtifactRefusal => ({
  code: "COMMENT_NOT_FOUND",
  error: "This artifact has no comment by that id to reply to (it may have been deleted): take the id from its comments, or comment without replying.",
  next: RAFT_HINTS.artifactComments({ artifact: itemId, all: true }),
  details: { replyTo },
});

/**
 * An image id a comment names that isn't the caller's own unused upload to
 * this Artifact: one answer for every reason (someone else's, used already,
 * expired, none), so it tells nothing of others' uploads.
 */
export const IMAGE_NOT_CLAIMABLE_ERROR = "That image id isn't an image you uploaded to this artifact that no comment has yet: upload the image again (an unused upload is gone after an hour, and each goes in one comment only), then use the new id.";
export const imageNotClaimable = (fileId: string, place: Record<string, unknown> = {}): ArtifactRefusal =>
  ({ code: "IMAGE_NOT_FOUND", error: IMAGE_NOT_CLAIMABLE_ERROR, details: { fileId, ...place } });

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * Why a push, a comment or a review was held (409 UNSEEN_CHANGES, freshness
 * v2): what others added since the caller last looked, and the way on. The
 * excerpts themselves are in `details.unseen` (released clients list them);
 * `unread` of the comments stay unseen until read in full.
 */
export function unseenChangesError(what: "push" | "comment" | "review", counts: { comments: number; versions: number; unread: number }): string {
  const parts = [
    ...(counts.comments > 0 ? [plural(counts.comments, "comment", "comments")] : []),
    ...(counts.versions > 0 ? [plural(counts.versions, "version", "versions")] : []),
  ];
  const counted = parts.length > 0 ? ` (${parts.join(" and ")})` : "";
  const heldWhat = what === "push" ? "Held, not pushed" : what === "review" ? "Held, nothing of the review was posted" : "Held, not posted";
  const about = what === "push" ? "others commented on what you're changing" : what === "review" ? "others added to what the review comments on" : "others added to what you're commenting on";
  const read = counts.unread > 0
    ? `read the ${plural(counts.unread, "comment", "comments")} still unseen in full first, then`
    : "read them, then";
  return `${heldWhat}: since you last looked, ${about}${counted}; ${read} send the same request again if they don't change what you meant, or change it first.`;
}

/**
 * A visible Artifact the caller may read but not take part in (apiCommon
 * takesPartIn: another server's public one): it sees the Artifact already, so
 * saying why tells nothing more.
 */
export const takePartForbiddenError = (verb: "comment on it" | "follow it" | "review it" | "push to it" | "comment on it or follow it" | "resolve or reopen its threads"): string =>
  `You can see this artifact but can't ${verb}: only members and agents of its own server, or of the joint channel it lives in, can, so ask one of them instead.`;

export const mayNotTakePart = (verb: Parameters<typeof takePartForbiddenError>[0]): ArtifactApiError => fail(403, { code: "FORBIDDEN", error: takePartForbiddenError(verb) });

/** The answer while Artifacts' file storage (R2) isn't configured on this deployment: retrying won't help. */
export const STORAGE_UNAVAILABLE_ERROR = "This server's file storage for Artifacts isn't set up, so artifact files can't be stored or read here: tell an admin of this server, since retrying won't help.";
export const storageUnavailable = (): ArtifactApiError => fail(503, { code: "ARTIFACTS_STORAGE_UNAVAILABLE", error: STORAGE_UNAVAILABLE_ERROR });

export class ArtifactApiFailure extends Error {
  constructor(readonly result: ArtifactApiError) {
    super(result.body.code);
  }
}

/** Run an operation; an ArtifactApiFailure thrown inside becomes its error result. */
export async function answer<T>(run: () => Promise<T>): Promise<T | ArtifactApiError> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ArtifactApiFailure) return error.result;
    throw error;
  }
}

export const viewActor = (agent: ArtifactAgent): ServerViewActor => ({ type: "agent", id: agent.agentId, serverId: agent.serverId });
export const agentActor = (agent: ArtifactAgent): ArtifactActorRef => ({ type: "agent", id: agent.agentId });

/**
 * Whether Artifacts is on for a server: the deployment runs it (deployment.ts
 * artifactsConfigured answers the key workspace_artifacts_v0, the same for
 * every server; no Feature Flag Admin row is read). `executor`: kept for the
 * callers that read inside a transaction; nothing is read from it now.
 */
export function artifactsEnabled(serverId: ServerId, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  return appEnabled(serverId, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, opts);
}

/**
 * Whether an Artifact of this server is read at all: Artifacts is on for the
 * deployment (artifactsEnabled: one answer, the reader's server's and the
 * Artifact's can't differ) and the item's own server still exists. A
 * soft-deleted server keeps its rows, and none of its Artifacts is read any
 * more, by another server's reader, a joint's other side or a signed-out
 * visitor (platform/flags appEnabledOnLiveServer; Tenny on #11397).
 */
export function itemServerEnabled(item: Pick<ArtifactItemRow, "serverId">): Promise<boolean> {
  return appEnabledOnLiveServer(item.serverId, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
}

/** itemServerEnabled for many Artifacts, one answer per item in input order, in one batched read. */
export function itemsServerEnabled(items: ReadonlyArray<Pick<ArtifactItemRow, "serverId">>): Promise<boolean[]> {
  return appEnabledOnLiveServers(items.map((item) => item.serverId), WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
}

/**
 * The one sentence of the flag's 403, wherever it is answered (agent, web,
 * dashboard, locate): it also stands in for "not visible" where a reader whose
 * server has the flag off asks for something that isn't public (resolveVisibleItem),
 * so it never says more than that.
 */
export const ARTIFACTS_NOT_ENABLED_ERROR = "Artifacts aren't turned on for this server yet, so nothing can be published, changed or listed here; from here you can only read an artifact anyone with the link can open, from a server that has Artifacts, so share files as attachments meanwhile.";

/** The answer of every agent API route while Artifacts is off on the deployment. */
export const ARTIFACTS_NOT_ENABLED = fail(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });

/** Artifacts on for the deployment (artifactsEnabled): what every operation, read, write or list, checks first. */
export async function requireEnabled(caller: { serverId: ServerId }): Promise<void> {
  if (!(await artifactsEnabled(caller.serverId))) throw new ArtifactApiFailure(ARTIFACTS_NOT_ENABLED);
}

/** Of `candidates`, those the viewer can see whose own server still exists (itemServerEnabled). */
async function seenOf(viewer: ServerViewActor, candidates: ArtifactItemRow[]): Promise<ArtifactItemRow[]> {
  if (candidates.length === 0) return [];
  const [visible, enabled] = await Promise.all([canViewArtifacts(viewer, candidates), itemsServerEnabled(candidates)]);
  return candidates.filter((_, index) => visible[index] && enabled[index]);
}

/**
 * The Artifact `ref` names if Artifacts is on for the deployment
 * (requireEnabled, first: 403 ARTIFACTS_NOT_ENABLED before reading
 * anything), the agent can see it and the Artifact's own server still
 * exists (itemServerEnabled); otherwise 404 NOT_VISIBLE. `ref`, trimmed, is
 * looked up in this order, the first that finds a visible Artifact winning
 * (#proj-workspace:98241a2e: an Artifact is its id and its title):
 *
 * 1. an id, `pt_…` or a short id (parseArtifactId; clients send a link's);
 * 2. an exact title, in any case (names.ts titledForLookup), among the
 *    agent's server's Artifacts and its joints';
 * 3. an old name (an Artifact from before titles, or an imported one;
 *    names.ts namedForLookup), so what agents remember keeps working.
 *
 * An id is the id whenever an Artifact has it, deleted, revoked or not the
 * caller's to see (then the one 404): an invisible id is never answered with
 * a same-titled or same-named Artifact. Only a short id no Artifact has at
 * all goes on to 2 and 3 (a `pt_…` id doesn't). Several visible Artifacts with
 * that title (or old name): 409 AMBIGUOUS_ARTIFACT_NAME with each one's id,
 * title and home, for the next request to pass an id.
 *
 */
/** The ids an ambiguous title's refusal names in its sentence (all of them are in `details`). */
const AMBIGUOUS_IDS_SHOWN = 5;

export async function resolveVisibleItem(agent: ArtifactAgent, rawRef: string): Promise<ArtifactItemRow> {
  await requireEnabled(agent);
  const ref = rawRef.trim();
  const id = parseArtifactId(ref);
  const db = getDb();
  let seen: ArtifactItemRow[] = [];
  let byId = false;
  if (id !== null) {
    const [item] = await db.select().from(artifactItems).where(eq(artifactItems.id, id)).limit(1);
    byId = item !== undefined || id === ref;
    if (item) seen = await seenOf(viewActor(agent), [item]);
  }
  if (!byId) {
    seen = await seenOf(viewActor(agent), await titledForLookup(db, agent.serverId, ref));
    if (seen.length === 0 && isArtifactName(ref)) seen = await seenOf(viewActor(agent), await namedForLookup(db, agent.serverId, ref));
  }
  if (seen.length === 0) throw new ArtifactApiFailure(notVisible());
  if (seen.length > 1) {
    const homes = await homesOf(agent, seen);
    const shown = seen.slice(0, AMBIGUOUS_IDS_SHOWN).map((item) => item.id);
    const more = seen.length > shown.length ? ` and ${seen.length - shown.length} more` : "";
    throw new ArtifactApiFailure(fail(409, {
      code: "AMBIGUOUS_ARTIFACT_NAME",
      error: `${seen.length} artifacts you can see are called that: pass the id of the one you mean instead (${shown.join(", ")}${more}).`,
      next: RAFT_HINTS.artifactRead({ artifact: seen[0]!.id }),
      details: { ref, candidates: seen.map((item) => ({ id: item.id, title: item.title, home: homes.get(item.id)! })) },
    }));
  }
  return seen[0]!;
}

/**
 * The Artifact `ref` names by its id alone (a `pt_…` id, a short id or a
 * link's, parseArtifactId), if Artifacts is on for the deployment
 * (requireEnabled, first), `viewer` can see it and its own server still
 * exists (itemServerEnabled); otherwise the one 404 NOT_VISIBLE. No title or
 * old name is looked up: a caller that already holds the id (a person's
 * write through their assistant, publishAs.ts) names one Artifact, never an
 * ambiguous few, so no other Artifact's home is ever named to it.
 */
export async function resolveVisibleItemById(viewer: ServerViewActor, rawRef: string): Promise<ArtifactItemRow> {
  await requireEnabled(viewer);
  const id = parseArtifactId(rawRef.trim());
  if (id === null) throw new ArtifactApiFailure(notVisible());
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)).limit(1);
  const [seen] = item ? await seenOf(viewer, [item]) : [];
  if (!seen) throw new ArtifactApiFailure(notVisible());
  return seen;
}

/**
 * An Artifact's canonical link on this deployment (`appUrl`, APP_URL:
 * `https://app.raft.build/artifacts/<short id>`, `/v/<n>` when pinned): what
 * every link the server builds for one is (agent API `url`, cards, a
 * share's message, an import's answer). The id itself stays `pt_…`
 * wherever a payload carries it.
 */
export const artifactAppUrl = (id: string, version: number | null = null, origin: string = appUrl()): string =>
  `${origin}${artifactPagePath(asArtifactId(id), version)}`;

/**
 * A web or signed-out route's `:id` as the module keys items: a short id
 * read as the `pt_<uuid>` it stands for; anything else as it is, for the
 * route's own checks (the one 404). These routes take ids only, never a
 * name, so a short id with no Artifact is that 404 either way; the name
 * fallback is the agent API's (resolveVisibleItem).
 */
export const artifactIdParam = (value: string): string => parseArtifactId(value) ?? value;

/** Published versions: ones that became current (they have a position), not revoked. */
export const readableVersion = (itemId: string): SQL => and(
  eq(artifactVersions.itemId, itemId),
  isNull(artifactVersions.revokedAt),
  isNotNull(artifactVersions.position),
)!;

/**
 * Whether a reader of `serverId` reads a visible item as an outsider: a
 * reader outside the item's server, which can only be another server's
 * reader of a public item. An outsider reads the current version only and no
 * comments (a fixed rule, xxchan and Tenny: making an Artifact public
 * publishes its current version, not its working history or discussion).
 * Another server's reader who sees an item homed in a conversation is a
 * member of its joint channel (nothing else lets it see one): it is not an
 * outsider and reads the item as its own server's readers do, the whole
 * history and the comments, but writes nothing to it (`inside`: only the
 * item's own server comments, follows and publishes).
 */
export const readsAsOutsider = (serverId: ServerId, item: Pick<ArtifactItemRow, "serverId" | "homeKind">): boolean =>
  item.serverId !== serverId && item.homeKind === "public";

/**
 * What a reader (a person on the web, an agent) may do with an item it can
 * see. `inside`: the item is its own server's, so it may see who else is
 * there and manage it. `historyLimited` and no `comments`: it reads as an
 * outsider (readsAsOutsider), so the current version only and no comments.
 * Taking part (commenting, following, a read position) is takesPartIn's.
 */
export function accessOf(reader: { serverId: ServerId }, item: Pick<ArtifactItemRow, "serverId" | "homeKind">): { inside: boolean; historyLimited: boolean; comments: boolean } {
  const outsider = readsAsOutsider(reader.serverId, item);
  return { inside: item.serverId === reader.serverId, historyLimited: outsider, comments: !outsider };
}

/**
 * Whether a reader (a person on the web, an agent) takes part in an item:
 * comments, replies, reviews and follows it and keeps a read position on it.
 * The item is its own server's, or another server's homed in a joint channel
 * the reader sees it through, as it writes in that channel (Tenny on #68):
 * platform/visibility seenThroughJoint, the rule core's Activity asks of
 * another server's rows too, so leaving the joint ends both at once. Only
 * the caller's sight of the item is assumed (it resolved it); no other way of
 * seeing another server's item (a public one) lets it take part.
 */
export async function takesPartIn(reader: ServerViewActor, item: ArtifactVisibilitySubject & Pick<ArtifactItemRow, "id">): Promise<boolean> {
  if (item.serverId === reader.serverId) return true;
  const seen = await seenThroughJoint(reader, [{
    id: item.id,
    serverId: item.serverId,
    homeKind: item.homeKind,
    homeChannelId: item.homeChannelId,
    author: { type: item.createdByType, id: item.createdById },
  }], WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
  return seen.has(item.id);
}

export const liveComment = (itemId: string): SQL => and(eq(artifactComments.itemId, itemId), isNull(artifactComments.deletedAt))!;

export async function currentVersionOf(item: ArtifactItemRow, executor: DatabaseExecutor = getDb()): Promise<ArtifactVersionRow | null> {
  if (!item.currentVersionId) return null;
  const [version] = await executor.select().from(artifactVersions)
    .where(and(readableVersion(item.id), eq(artifactVersions.id, item.currentVersionId)))
    .limit(1);
  return version ?? null;
}

/** How far a person or agent has looked at an Artifact (an item position); null before its first look. */
export async function readPositionOf(actor: ArtifactActorRef, itemId: string, executor: DatabaseExecutor = getDb()): Promise<number | null> {
  const [row] = await executor.select({ position: artifactReadPositions.position }).from(artifactReadPositions).where(and(
    eq(artifactReadPositions.itemId, itemId),
    eq(artifactReadPositions.actorType, actor.type),
    eq(artifactReadPositions.actorId, actor.id),
  )).limit(1);
  return row?.position ?? null;
}

/** Move the actor's read position forward to `position`; never back. */
export async function advanceReadPosition(actor: ArtifactActorRef, itemId: string, position: number, executor: DatabaseExecutor = getDb()): Promise<void> {
  await executor.insert(artifactReadPositions)
    .values({ itemId, actorType: actor.type, actorId: actor.id, position })
    .onConflictDoUpdate({
      target: [artifactReadPositions.itemId, artifactReadPositions.actorType, artifactReadPositions.actorId],
      set: {
        position: sql`GREATEST(${artifactReadPositions.position}, excluded.position)`,
        updatedAt: sql`now()`,
      },
    });
  // A person's Activity row knows what they have read (core's unread and badge), in this transaction.
  if (actor.type === "user") await reportRead(executor, actor.id, [{ itemId, position }]);
}

/**
 * How far an agent has now seen an Artifact, having just been shown things
 * that lie after its read position `from`, up to `through`: the one rule for
 * every read position an agent's being shown something moves (task #71; the
 * read, the comments list, a hold; never a notice, which proves nothing was
 * read). It moves past others' comments
 * it was shown in full (`shown`: their positions; an excerpt cut short, or a
 * comment left out, doesn't count) and others' versions it was shown
 * (`shown`, or every one with `allVersions`: the current version's files are
 * what they came to), and stops before the first one it wasn't shown. Its
 * own comments and versions never stop it. At least `from`; the caller moves
 * the position (advanceReadPosition), or only reports how far.
 */
export async function shownThrough(
  executor: DatabaseExecutor,
  actor: ArtifactActorRef,
  itemId: string,
  from: number,
  through: number,
  shown: ReadonlySet<number>,
  opts: { allVersions?: boolean } = {},
): Promise<number> {
  if (through <= from) return from;
  const notShown = (position: typeof artifactComments.position | typeof artifactVersions.position) => and(
    gt(position, from),
    lte(position, through),
    shown.size > 0 ? notInArray(position, [...shown]) : undefined,
  );
  const [[comment], [version]] = await Promise.all([
    executor.select({ first: min(artifactComments.position) }).from(artifactComments).where(and(
      liveComment(itemId),
      or(ne(artifactComments.authorType, actor.type), ne(artifactComments.authorId, actor.id)),
      notShown(artifactComments.position),
    )),
    opts.allVersions ? [] : executor.select({ first: min(artifactVersions.position) }).from(artifactVersions).where(and(
      readableVersion(itemId),
      or(ne(artifactVersions.publisherType, actor.type), ne(artifactVersions.publisherId, actor.id)),
      notShown(artifactVersions.position),
    )),
  ]);
  const stops = [comment?.first, version?.first].filter((position): position is number => position != null).map((position) => position - 1);
  return Math.max(from, Math.min(through, ...stops));
}

/** Whether a comment's excerpt (excerptOf) shows its whole text: what counts as seen. */
export const shownInFull = (comment: { body: string }): boolean => !excerptOf(comment.body).truncated;

/**
 * Tell core how far a person has read these Artifacts (platform/activity
 * markObjectRead): every event whose `position` is at most the read position.
 * Every event this module records carries the item position it is about.
 */
export async function reportRead(executor: DatabaseExecutor, userId: string, reads: ReadonlyArray<{ itemId: string; position: number }>): Promise<void> {
  await markObjectRead(executor, {
    userId,
    kind: ARTIFACT_OBJECT_KIND,
    objects: reads.map((read) => ({ objectId: read.itemId, through: { field: "position", upTo: read.position } })),
  });
}

/** Handles for actors, in one lookup per request. `executor`: read inside the caller's transaction. */
export async function namer(
  actors: readonly ArtifactActorRef[],
  executor?: DatabaseExecutor,
): Promise<(actor: ArtifactActorRef) => AgentApiArtifactActor> {
  const unique = [...new Map(actors.map((actor) => [actorKey(actor), actor])).values()];
  const names = unique.length > 0 ? await actorNames(unique, executor) : new Map<string, string>();
  return (actor) => ({ type: actor.type, name: names.get(actorKey(actor)) ?? null });
}

/**
 * Each item's home as the agent names it (a conversation by its agent-facing
 * target and its id in the agent's server: a joint by the server's
 * projection). An orphan has no target, and no id once its channel row is gone.
 */
export async function homesOf(agent: ArtifactAgent, items: readonly ArtifactItemRow[]): Promise<Map<string, AgentApiArtifactHome>> {
  const channelIds = [...new Set(items.flatMap((item) => (item.homeKind === "conversation" && item.homeChannelId ? [item.homeChannelId] : [])))];
  // A server-wide Artifact an agent sees is on its own server: named by that server's row (#84), absent if it has none.
  const serverIds = items.flatMap((item) => (item.homeKind === "server" ? [item.serverId] : []));
  const [refs, names] = await Promise.all([
    channelIds.length > 0 ? agentConversationRefs(agent, channelIds) : new Map<string, { id: string; type: ConversationType; target: string | null }>(),
    serverNames(serverIds),
  ]);
  return new Map(items.map((item): [string, AgentApiArtifactHome] => {
    if (item.homeKind === "server") {
      const serverName = names.get(item.serverId);
      return [item.id, serverName === undefined ? { kind: "server" } : { kind: "server", serverName }];
    }
    if (item.homeKind !== "conversation") return [item.id, { kind: item.homeKind }];
    const ref = item.homeChannelId ? refs.get(item.homeChannelId) : undefined;
    return [item.id, { kind: "conversation", conversation: { id: ref?.id ?? item.homeChannelId, type: ref?.type ?? null, target: ref?.target ?? null } }];
  }));
}

export async function summarize(
  agent: ArtifactAgent,
  items: readonly ArtifactItemRow[],
): Promise<AgentApiArtifactSummary[]> {
  return summariesWith(items, await homesOf(agent, items));
}

/**
 * summarize's answer for a person (a write a personal assistant makes as its
 * owner, publishAs.ts), never through an agent's names for conversations
 * (agentConversationRefs names a channel to whoever asks): a conversation
 * home by its id and type in the person's server (conversationNames: a
 * joint's canonical channel by the server's projection), no target; a
 * server-wide one by the server's name, as homesOf.
 */
export async function summarizeForPerson(
  reader: { userId: string; serverId: ServerId },
  items: readonly ArtifactItemRow[],
): Promise<AgentApiArtifactSummary[]> {
  const channelIds = [...new Set(items.flatMap((item) => (item.homeKind === "conversation" && item.homeChannelId ? [item.homeChannelId] : [])))];
  const [names, servers] = await Promise.all([
    channelIds.length > 0 ? conversationNames(reader, channelIds) : new Map<string, ConversationName>(),
    serverNames(items.flatMap((item) => (item.homeKind === "server" ? [item.serverId] : []))),
  ]);
  const homes = new Map(items.map((item): [string, AgentApiArtifactHome] => {
    if (item.homeKind === "server") {
      const serverName = servers.get(item.serverId);
      return [item.id, serverName === undefined ? { kind: "server" } : { kind: "server", serverName }];
    }
    if (item.homeKind !== "conversation") return [item.id, { kind: item.homeKind }];
    const named = item.homeChannelId ? names.get(item.homeChannelId) : undefined;
    return [item.id, { kind: "conversation", conversation: { id: named?.id ?? item.homeChannelId, type: named?.type ?? null, target: null } }];
  }));
  return summariesWith(items, homes);
}

async function summariesWith(
  items: readonly ArtifactItemRow[],
  homes: ReadonlyMap<string, AgentApiArtifactHome>,
): Promise<AgentApiArtifactSummary[]> {
  const db = getDb();
  const currentIds = items.flatMap((item) => (item.currentVersionId ? [item.currentVersionId] : []));
  const currents = currentIds.length > 0
    ? await db.select({ id: artifactVersions.id, number: artifactVersions.number, entry: artifactVersions.entry })
      .from(artifactVersions)
      .where(and(inArray(artifactVersions.id, currentIds), isNull(artifactVersions.revokedAt), isNotNull(artifactVersions.position)))
    : [];
  const currentById = new Map(currents.map((version) => [version.id, version]));
  const name = await namer(items.map((item) => ({ type: item.createdByType, id: item.createdById })));
  const origin = appUrl();
  return items.map((item) => {
    const current = item.currentVersionId ? currentById.get(item.currentVersionId) : undefined;
    return {
      id: item.id,
      url: artifactAppUrl(item.id, null, origin),
      name: legacyNameOf(item),
      title: item.title,
      description: item.description,
      kind: current ? artifactFileType(current.entry).kind : null,
      home: homes.get(item.id)!,
      currentVersion: current?.number ?? null,
      author: name({ type: item.createdByType, id: item.createdById }),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  });
}

/**
 * The deprecated `name` of the agent API's answers (agentApiArtifactSummarySchema):
 * CLIs before titles require it and pull into `./<name>`, so an Artifact
 * without an old name sends its short id (which resolves back to it). Remove
 * with the field, once ARTIFACTS_MIN_CLI_VERSION (cliFloor.ts) is a CLI that
 * doesn't require it.
 */
export const legacyNameOf = (item: Pick<ArtifactItemRow, "id" | "name">): string => item.name ?? artifactLinkId(asArtifactId(item.id));

/** The Artifact a comment, a subscription or a delete answer is about: id, title, current version (and the deprecated name). */
export const artifactRef = async (item: ArtifactItemRow) => ({
  id: item.id,
  name: legacyNameOf(item),
  title: item.title,
  currentVersion: (await currentVersionOf(item))?.number ?? null,
});

/** Comments by others, and versions published by others: what "new since you last looked" counts. */
export const byOthers = (agent: ArtifactAgent) => byOthersThan(agentActor(agent));

/** byOthers for any reader, a person or an agent: comments and versions not by `actor`. */
export const byOthersThan = (actor: ArtifactActorRef) => ({
  comment: or(ne(artifactComments.authorType, actor.type), ne(artifactComments.authorId, actor.id))!,
  version: or(ne(artifactVersions.publisherType, actor.type), ne(artifactVersions.publisherId, actor.id))!,
});

/** The actors a comment row names to the agent API: its author and, a resolved thread's root, who resolved it. */
export const commentActors = (rows: readonly ArtifactCommentRow[]): ArtifactActorRef[] => rows.flatMap((row) => [
  { type: row.authorType, id: row.authorId },
  ...(row.resolvedByType === null || row.resolvedById === null ? [] : [{ type: row.resolvedByType, id: row.resolvedById }]),
]);

/**
 * A comment as the agent API answers it (artifactComments' shape): its
 * images only when it has any; its thread's resolution (#249) on a root.
 * `name` names commentActors(rows) (namer).
 */
export function agentComment(row: ArtifactCommentRow, versionNumber: number, name: (actor: ArtifactActorRef) => AgentApiArtifactActor): AgentApiArtifactComment {
  return {
    id: row.id,
    author: name({ type: row.authorType, id: row.authorId }),
    version: versionNumber,
    path: row.path,
    anchor: row.anchor ?? null,
    replyTo: row.replyTo,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    reviewId: row.reviewId === null ? null : asArtifactReviewId(row.reviewId),
    ...(row.images.length === 0 ? {} : { images: row.images.map((image) => ({ ...image })) }),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedByType === null || row.resolvedById === null ? null : name({ type: row.resolvedByType, id: row.resolvedById }),
  };
}

/** An excerpt's `imageCount`: how many images the comment carries, only when it has any (agentApiArtifactCommentExcerptSchema). */
export const imageCountOf = (comment: Pick<ArtifactCommentRow, "images">): { imageCount?: number } =>
  (comment.images.length === 0 ? {} : { imageCount: comment.images.length });

export function excerptOf(body: string): { excerpt: string; truncated: boolean; bodyChars: number } {
  const chars = Array.from(body);
  const truncated = chars.length > AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS;
  return {
    excerpt: truncated ? chars.slice(0, AGENT_API_ARTIFACT_COMMENT_EXCERPT_CHARS).join("") : body,
    truncated,
    bodyChars: chars.length,
  };
}

export async function versionNumbers(versionIds: readonly string[], executor: DatabaseExecutor = getDb()): Promise<Map<string, number>> {
  if (versionIds.length === 0) return new Map();
  const rows = await executor.select({ id: artifactVersions.id, number: artifactVersions.number })
    .from(artifactVersions).where(inArray(artifactVersions.id, [...new Set(versionIds)]));
  return new Map(rows.map((row) => [row.id, row.number]));
}

/** A comments cursor is a position: the page holds the comments after it. */
export const positionCursor = (position: number): string => String(position);

/**
 * Version summaries with the paths each changed against the readable version
 * before it. `historyLimited`: the caller may not see other versions, so no
 * comparison is made (changedPaths is empty); a diff against a hidden version
 * would name its files. `readable`: every readable version of the item
 * (readableVersion), when the caller has just read them all (the viewer), so
 * they aren't read again.
 */
export async function versionSummaries<A = AgentApiArtifactActor>(
  item: ArtifactItemRow,
  versions: readonly ArtifactVersionRow[],
  name: (actor: ArtifactActorRef) => A,
  historyLimited: boolean,
  readable?: ReadonlyArray<Pick<ArtifactVersionRow, "id" | "number">>,
): Promise<Array<{ number: number; publisher: A; createdAt: string; note: string | null; changedPaths: string[] }>> {
  if (versions.length === 0) return [];
  if (historyLimited) {
    return versions.map((version) => ({
      number: version.number,
      publisher: name({ type: version.publisherType, id: version.publisherId }),
      createdAt: version.createdAt.toISOString(),
      note: version.note,
      changedPaths: [],
    }));
  }
  const db = getDb();
  const all = readable
    ? [...readable].sort((a, b) => a.number - b.number)
    : await db.select({ id: artifactVersions.id, number: artifactVersions.number })
      .from(artifactVersions).where(readableVersion(item.id)).orderBy(asc(artifactVersions.number));
  const previous = new Map<string, string>();
  all.forEach((version, index) => {
    if (index > 0) previous.set(version.id, all[index - 1]!.id);
  });
  const ids = [...new Set(versions.flatMap((version) => [version.id, ...(previous.has(version.id) ? [previous.get(version.id)!] : [])]))];
  const files = await db.select({ versionId: artifactVersionFiles.versionId, path: artifactVersionFiles.path, sha256: artifactVersionFiles.sha256 })
    .from(artifactVersionFiles).where(inArray(artifactVersionFiles.versionId, ids));
  const manifest = new Map<string, Map<string, string>>();
  for (const file of files) {
    const paths = manifest.get(file.versionId) ?? new Map<string, string>();
    paths.set(file.path, file.sha256);
    manifest.set(file.versionId, paths);
  }
  return versions.map((version) => {
    const now = manifest.get(version.id) ?? new Map<string, string>();
    const before = manifest.get(previous.get(version.id) ?? "") ?? new Map<string, string>();
    const changed = new Set<string>();
    for (const [path, sha] of now) if (before.get(path) !== sha) changed.add(path);
    for (const path of before.keys()) if (!now.has(path)) changed.add(path);
    return {
      number: version.number,
      publisher: name({ type: version.publisherType, id: version.publisherId }),
      createdAt: version.createdAt.toISOString(),
      note: version.note,
      changedPaths: [...changed].sort(),
    };
  });
}

/**
 * One file of a version, matched exactly by path, and the reader for its
 * blob: bytes are reached only through the matched row's blob, and only a
 * ready one of the item's own server (as the content manifest). `missing`:
 * no such file, or no such blob; `unavailable`: R2 isn't configured on this
 * Server.
 */
export async function versionFileOf(
  item: Pick<ArtifactItemRow, "serverId">,
  version: Pick<ArtifactVersionRow, "id">,
  path: string,
): Promise<
  | { kind: "found"; file: ArtifactVersionFileRow; blob: ArtifactBlobRow; reader: ArtifactBlobReader }
  | { kind: "missing" }
  | { kind: "unavailable" }
> {
  const db = getDb();
  const [file] = await db.select().from(artifactVersionFiles)
    .where(and(eq(artifactVersionFiles.versionId, version.id), eq(artifactVersionFiles.path, path)))
    .limit(1);
  if (!file) return { kind: "missing" };
  const [blob] = await db.select().from(artifactBlobs).where(and(
    eq(artifactBlobs.id, file.blobId),
    eq(artifactBlobs.state, "ready"),
    eq(artifactBlobs.serverId, item.serverId),
  )).limit(1);
  if (!blob) return { kind: "missing" };
  const reader = artifactR2Store();
  return reader ? { kind: "found", file, blob, reader } : { kind: "unavailable" };
}

/**
 * At most `maxBytes` of a text file as UTF-8, cut at a character boundary;
 * `truncated` when the file is longer. Reads no more than it needs, then
 * closes the stream.
 */
export async function readTextPrefix(bytes: ArtifactBlobBytes, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of bytes.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer);
      total += buffer.length;
      if (total > maxBytes) break;
    }
  } finally {
    bytes.stream.destroy();
  }
  const prefix = Buffer.concat(chunks, total);
  let end = Math.min(prefix.length, maxBytes);
  // Back off continuation bytes (10xxxxxx) so a character is never split.
  if (end < prefix.length) while (end > 0 && (prefix[end]! & 0xc0) === 0x80) end -= 1;
  return {
    content: new TextDecoder("utf-8").decode(prefix.subarray(0, end)),
    truncated: prefix.length > maxBytes || bytes.size > maxBytes,
  };
}

/**
 * The item ids a list cursor may carry (the agent API's list and the web
 * dashboard's): `pt_<uuid>`, what every Artifact's id is (publish makes
 * them, and the D1 import keeps the old ones, of the same form). Anything
 * else names no Artifact and is refused before it reaches the query.
 */
export const ARTIFACT_CURSOR_ID = /^pt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
