// Commenting and following (S1c): `POST /artifacts/:artifact/comments`,
// `PUT|DELETE /artifacts/:artifact/subscription`, and a thread's resolve and
// reopen, `POST …/comments/:comment/resolve | reopen` (#249: the rule is
// resolutions.ts). Notices are notices.ts.
//
// A comment is checked in this order, and nothing is written until the last
// step:
//
// 1. the flag, then the Artifact (404 NOT_VISIBLE) and who may comment: an
//    agent of its server or of its joint channel (apiCommon takesPartIn, else
//    403 FORBIDDEN);
// 2. the request: text or at least one image (neither: 400
//    agent_api_contract_invalid, as an empty body always was), the body's
//    length, the anchor's size, the path; `replyTo` a live comment of this
//    Artifact (404 COMMENT_NOT_FOUND), whose file and place a reply without
//    `path` takes; an anchor needs a path; `version` a published version
//    (default the current one), which has the file;
// 3. `@name`s (at most AGENT_API_ARTIFACT_MAX_MENTIONS distinct, else 400
//    TOO_MANY_MENTIONS), looked up among the people and live agents of the
//    Artifact's server (as messages match them, exactly); oneself is not a
//    mention;
// 4. in one transaction, the item row locked: the hold (freshness v2 §2.2):
//    others' new comments on the same file or on the whole Artifact, and
//    others' new versions that changed the file, since the caller's read
//    position (or `seen`); a comment on the whole Artifact is held by
//    anything new from others. Held: 409 UNSEEN_CHANGES, the read position
//    moved over what it shows (as a held publish: holding comments only in
//    full, apiCommon shownThrough), so the same request again goes through
//    unless some are left `unread`. Otherwise its images are claimed
//    (commentImages.ts: each an unused upload of this agent's to this
//    Artifact, else 400 IMAGE_NOT_FOUND and nothing written), and the
//    comment takes the item's next
//    position, the object event is recorded, the author follows the
//    Artifact (unless it stopped), and the notices are queued; the author's
//    read position moves over its own comment when nothing unseen lies
//    before it;
// 5. after the commit, the notices are pushed (sendQueued) and people's
//    Activity is told (announceObjectEvents).
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES,
  AGENT_API_ARTIFACT_MAX_COMMENT_CHARS,
  AGENT_API_ARTIFACT_MAX_MENTIONS,
  AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN,
  AGENT_API_ARTIFACT_READ_VERSIONS_SHOWN,
  currentDate,
  extractRaftMentionHandles,
  isWellFormedArtifactFilePath,
  RAFT_HINTS,
  WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  type AgentApiArtifactCommentBody,
  type AgentApiArtifactCommentCreated,
  type AgentApiArtifactCommentParams,
  type AgentApiArtifactResolveBody,
  type AgentApiArtifactThreadResolution,
  type AgentApiArtifactNotNotifiedReason,
  type AgentApiArtifactParams,
  type AgentApiArtifactSubscriptionResponse,
  type ArtifactCommentImage,
} from "@botiverse/raft-shared";
import { actorsByHandle } from "../../platform/actors";
import { jointServersOf, jointViewersOf } from "../../platform/visibility";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import {
  advanceReadPosition,
  agentActor,
  agentComment,
  answer,
  type ArtifactActorRef,
  type ArtifactAgent,
  type ArtifactApiError,
  ArtifactApiFailure,
  type ArtifactApiResult,
  type ArtifactNoticeOutbox,
  type ArtifactRefusal,
  artifactRef,
  byOthers,
  commentActors,
  commentNotFound,
  currentVersionOf,
  excerptOf,
  fail,
  fileNotFound,
  imageCountOf,
  imageNotClaimable,
  invalidPath,
  json,
  liveComment,
  mayNotTakePart,
  namer,
  notVisible,
  positionCursor,
  readableVersion,
  readPositionOf,
  resolveVisibleItem,
  shownInFull,
  shownThrough,
  takesPartIn,
  unseenChangesError,
  versionNotFound,
  versionNumbers,
  versionSummaries,
  viewActor,
} from "./apiCommon";
import { announceObjectEvents } from "../../platform/activity";
import { followerRecipients, recordArtifactEvent } from "./events";
import { actorsWhoCanViewArtifact } from "./visibility";
import { claimCommentImages, commentImagesPart } from "./commentImages";
import { changeResolution, noteVersionFor, reopenThreadsOf, resolvableThread } from "./resolutions";
import { autoSubscribe, dropPendingNotice, followersOf, noticeComment, sendQueued, type NotifiedAgent, type QueuedNotice } from "./notices";
import {
  artifactComments,
  artifactItems,
  artifactSubscriptions,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactCommentAnchor,
  type ArtifactCommentRow,
  type ArtifactItemRow,
  type ArtifactVersionRow,
} from "./schema";

const chars = (value: string): number => Array.from(value).length;
/** A new comment's id, chosen before it is written so its images can hang on it (commentImages.ts). */
export const newCommentId = (): string => `c_${randomUUID()}`;
const refuse = (status: number, refusal: ArtifactRefusal): never => {
  throw new ArtifactApiFailure(fail(status, refusal));
};

/** What holds a comment back (freshness v2 §2.2). */
export interface CommentHold {
  /** The newest holding comments (oldest first) and how many there are. */
  comments: ArtifactCommentRow[];
  commentCount: number;
  /** The newest holding versions (oldest first) and how many there are. */
  versions: ArtifactVersionRow[];
  versionCount: number;
  after: number;
  /**
   * Where the read position moves: over the holding comments shown in full
   * and every version up to the newest holding thing, stopping before the
   * first comment by others not shown in full (shownThrough).
   */
  through: number;
  /** Of `commentCount`, how many it leaves unseen: the same request again is held while any are. */
  unread: number;
  /** What moving there passes over that didn't hold it: versions (never a comment). */
  skipped: { versions: number; otherComments: number };
}

/**
 * The readable versions that changed `path` against the readable version
 * before each: added it, gave it other bytes, or removed it.
 */
async function versionsChanging(executor: DatabaseExecutor, itemId: string, path: string): Promise<Set<string>> {
  const all = await executor.select({ id: artifactVersions.id }).from(artifactVersions)
    .where(readableVersion(itemId)).orderBy(asc(artifactVersions.number));
  const files = await executor.select({ versionId: artifactVersionFiles.versionId, sha256: artifactVersionFiles.sha256 })
    .from(artifactVersionFiles)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionFiles.versionId))
    .where(and(readableVersion(itemId), eq(artifactVersionFiles.path, path)));
  const shaOf = new Map(files.map((file) => [file.versionId, file.sha256]));
  const changing = new Set<string>();
  let previous: string | undefined;
  for (const version of all) {
    const sha = shaOf.get(version.id);
    if (sha !== previous) changing.add(version.id);
    previous = sha;
  }
  return changing;
}

/** The readable versions that changed any of `paths` (versionsChanging, for each). */
async function versionsChangingAny(executor: DatabaseExecutor, itemId: string, paths: readonly string[]): Promise<Set<string>> {
  const changing = new Set<string>();
  for (const path of new Set(paths)) for (const id of await versionsChanging(executor, itemId, path)) changing.add(id);
  return changing;
}

/**
 * What holds comments on `paths` (null: on the whole Artifact) back, after
 * position `after`. A comment on files is held by others' comments on any of
 * them or on the whole Artifact, and by others' versions that changed any of
 * them; one on the whole Artifact by anything new from others. A review is
 * held once, over all the files it comments on (reviews.ts).
 */
export async function evaluateHold(executor: DatabaseExecutor, agent: ArtifactAgent, item: ArtifactItemRow, paths: readonly string[] | null, after: number): Promise<CommentHold | null> {
  const others = byOthers(agent);
  const theirs = and(liveComment(item.id), gt(artifactComments.position, after), others.comment)!;
  // A comment on a file is held by others' comments there or on the whole Artifact; one on the whole Artifact by any.
  const holding: SQL | undefined = paths === null ? undefined : or(isNull(artifactComments.path), inArray(artifactComments.path, [...paths]));
  const [{ count } = { count: 0 }] = await executor.select({ count: sql<number>`count(*)::int` }).from(artifactComments).where(and(theirs, holding));
  const newest = count > 0
    ? await executor.select().from(artifactComments).where(and(theirs, holding)).orderBy(desc(artifactComments.position)).limit(AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN)
    : [];
  const later = await executor.select().from(artifactVersions)
    .where(and(readableVersion(item.id), gt(artifactVersions.position, after), others.version))
    .orderBy(asc(artifactVersions.position));
  const changing = paths === null || later.length === 0 ? null : await versionsChangingAny(executor, item.id, paths);
  const holdingVersions = changing === null ? later : later.filter((version) => changing.has(version.id));
  if (count === 0 && holdingVersions.length === 0) return null;

  const newestHolding = Math.max(newest[0]?.position ?? 0, ...holdingVersions.map((version) => version.position!));
  const full = newest.filter(shownInFull).map((comment) => comment.position);
  const through = await shownThrough(executor, agentActor(agent), item.id, after, newestHolding, new Set(full), { allVersions: true });
  const passedVersions = later.filter((version) => version.position! <= through && !holdingVersions.includes(version)).length;
  return {
    comments: newest.reverse(),
    commentCount: count,
    versions: holdingVersions.slice(-AGENT_API_ARTIFACT_READ_VERSIONS_SHOWN),
    versionCount: holdingVersions.length,
    after,
    through,
    // Every comment by others up to `through` is a holding one shown in full.
    unread: Math.max(0, count - full.filter((at) => at <= through).length),
    skipped: { versions: passedVersions, otherComments: 0 },
  };
}

/** The `@name`s of a body, looked up in the item's server. */
/**
 * Of a joint channel's other servers (the item homed there, the app on for
 * both), the people and agents with these handles who see the item from
 * there (platform/visibility jointViewersOf), as the joint's own messages
 * name the joint's members: the first server's, where two share a handle.
 */
async function jointActorsByHandle(item: ArtifactItemRow, handles: readonly string[]): Promise<Array<ArtifactActorRef & { name: string }>> {
  const servers = await jointServersOf(item, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
  if (servers.length === 0) return [];
  // An agent of another server is never there someone's own assistant (`{}`).
  // fanout-ok: one lookup per other server in the joint (a joint has a few), each batched over the handles
  const named = (await Promise.all(servers.map((serverId) => actorsByHandle(serverId, handles, {})))).flat();
  const unique = [...new Map(named.map((actor) => [`${actor.type}:${actor.name}`, actor])).values()];
  const sees = await jointViewersOf({ id: item.id, serverId: item.serverId, homeKind: item.homeKind, homeChannelId: item.homeChannelId, author: { type: item.createdByType, id: item.createdById } }, unique, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
  return unique.filter((actor) => sees.has(`${actor.type}:${actor.id}`));
}

export async function resolveMentions(agent: ArtifactAgent, item: ArtifactItemRow, body: string) {
  const handles = extractRaftMentionHandles(body);
  if (handles.length > AGENT_API_ARTIFACT_MAX_MENTIONS) {
    refuse(400, {
      code: "TOO_MANY_MENTIONS",
      error: `This mentions more than ${AGENT_API_ARTIFACT_MAX_MENTIONS} people or agents, and at most ${AGENT_API_ARTIFACT_MAX_MENTIONS} are looked up: mention fewer, or split it into a comment and a reply that mentions the rest.`,
      details: { limit: AGENT_API_ARTIFACT_MAX_MENTIONS },
    });
  }
  // Another person's assistant reads as a name nobody has (agentFindableBy).
  const found = handles.length > 0 ? await actorsByHandle(item.serverId, handles, { agentId: agent.agentId }) : [];
  // In a joint channel, a name the item's server doesn't have may be another server's in it, who sees the item (#68).
  const unknown = handles.filter((handle) => !found.some((actor) => actor.name === handle));
  if (unknown.length > 0) found.push(...await jointActorsByHandle(item, unknown));
  const agents: string[] = [];
  const stored: ArtifactActorRef[] = [];
  const notNotified: Array<{ name: string; reason: AgentApiArtifactNotNotifiedReason }> = [];
  /** The people mentioned, by their place in `notNotified`. */
  const people = new Map<number, string>();
  for (const handle of handles) {
    // A person and an agent may share a handle: the agent is the one told.
    const who = found.find((actor) => actor.type === "agent" && actor.name === handle) ?? found.find((actor) => actor.type === "user" && actor.name === handle);
    if (!who) {
      notNotified.push({ name: handle, reason: "unknown_name" });
      continue;
    }
    if (who.type === "agent" && who.id === agent.agentId) continue;
    if (stored.some((actor) => actor.type === who.type && actor.id === who.id)) continue;
    stored.push({ type: who.type, id: who.id });
    if (who.type === "agent") agents.push(who.id);
    else {
      // A person: `not_agent` once known to see it (below), else `cannot_see`, in this place.
      people.set(notNotified.length, who.id);
      notNotified.push({ name: handle, reason: "not_agent" });
    }
  }
  // Kept on the comment only who can see the Artifact now: a stored mention is
  // what the dashboard's `waiting` and the unread mention count read, so one
  // of someone who couldn't see it would surface once they could (Tenny). An
  // agent among them is still asked about below and reported `cannot_see`.
  const seeing = await actorsWhoCanViewArtifact(stored.map((actor) => ({ ...actor, serverId: item.serverId })), item, { requireStanding: true });
  // A joint's member of another server sees it from there (jointActorsByHandle found only such ones).
  const peers = await jointViewersOf({ id: item.id, serverId: item.serverId, homeKind: item.homeKind, homeChannelId: item.homeChannelId, author: { type: item.createdByType, id: item.createdById } }, stored.filter((_, index) => !seeing[index]), WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
  const sees = stored.filter((actor, index) => seeing[index] || peers.has(`${actor.type}:${actor.id}`));
  // A person who can't see the Artifact gets nothing (their Activity lists only what they can see),
  // so they are reported as an agent that can't is: `cannot_see`, never as notified (#proj-workspace:#141).
  for (const [index, userId] of people) {
    if (!sees.some((actor) => actor.type === "user" && actor.id === userId)) notNotified[index] = { name: notNotified[index]!.name, reason: "cannot_see" };
  }
  return {
    agents,
    stored: sees,
    notNotified,
    handleOf: (agentId: string) => found.find((actor) => actor.type === "agent" && actor.id === agentId)?.name ?? agentId,
  };
}

/**
 * Step 2 of a comment, short of its version: text or images, the body's
 * length, the anchor's size, the path, `replyTo` a live comment of this
 * Artifact (whose file and place a reply without `path` takes), an anchor
 * only with a path. Throws the refusal. A review checks each of its comments
 * with it.
 */
export async function checkCommentFields(
  item: ArtifactItemRow,
  fields: { body?: string; path?: string; anchor?: ArtifactCommentAnchor; replyTo?: string; images?: readonly string[] },
): Promise<{ text: string; path: string | null; anchor: ArtifactCommentAnchor | null; images: readonly string[] }> {
  const text = (fields.body ?? "").trim();
  const images = fields.images ?? [];
  // What the contract refused before images: a comment of nothing.
  if (text.length === 0 && images.length === 0) refuse(400, { code: "agent_api_contract_invalid", error: "A comment needs text or an image, and this one has neither: write what you want to say." });
  if (chars(text) > AGENT_API_ARTIFACT_MAX_COMMENT_CHARS) {
    refuse(400, {
      code: "FIELD_TOO_LONG",
      error: `A comment can be at most ${AGENT_API_ARTIFACT_MAX_COMMENT_CHARS} characters: shorten it, or post it in parts as a comment and replies to it.`,
      details: { field: "body", limit: AGENT_API_ARTIFACT_MAX_COMMENT_CHARS },
    });
  }
  if (fields.anchor !== undefined && Buffer.byteLength(JSON.stringify(fields.anchor), "utf8") > AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES) {
    refuse(400, {
      code: "FIELD_TOO_LONG",
      error: `A comment's anchor can be at most ${AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES} bytes as JSON: anchor it to a shorter quote or a smaller range, or leave the anchor out.`,
      details: { field: "anchor", limit: AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES },
    });
  }
  if (fields.path !== undefined && !isWellFormedArtifactFilePath(fields.path)) throw new ArtifactApiFailure(invalidPath(fields.path));
  let path = fields.path ?? null;
  let anchor: ArtifactCommentAnchor | null = fields.anchor ?? null;
  if (fields.replyTo !== undefined) {
    const [parent] = await getDb().select().from(artifactComments)
      .where(and(liveComment(item.id), eq(artifactComments.id, fields.replyTo))).limit(1);
    if (!parent) refuse(404, commentNotFound(item.id, fields.replyTo));
    // A reply is a comment at the same place (technical design §6b).
    if (fields.path === undefined) {
      path = parent!.path;
      anchor = fields.anchor ?? parent!.anchor ?? null;
    }
  }
  if (anchor !== null && path === null) {
    refuse(400, { code: "ANCHOR_WITHOUT_PATH", error: "An anchor is a place in one file, so it needs that file's path: pass the path of the file the anchor is in, or leave the anchor out." });
  }
  return { text, path, anchor, images };
}

/** The version has the file a comment is on (none: on the whole Artifact), else 404 FILE_NOT_FOUND. */
export async function checkFileIn(version: ArtifactVersionRow, path: string | null): Promise<void> {
  if (path === null) return;
  const [file] = await getDb().select({ path: artifactVersionFiles.path }).from(artifactVersionFiles)
    .where(and(eq(artifactVersionFiles.versionId, version.id), eq(artifactVersionFiles.path, path))).limit(1);
  if (!file) throw new ArtifactApiFailure(fileNotFound(version.itemId, path, version.number));
}

export type WrittenComment = {
  kind: "written";
  comment: ArtifactCommentRow;
  version: ArtifactVersionRow;
  queued: QueuedNotice[];
  notified: NotifiedAgent<"mentioned" | "subscribed">[];
  told: Array<{ agentId: string; reason: "mentioned" | "subscribed" }>;
  cannotSee: Set<string>;
  newlySubscribed: boolean;
  /** Its object event, announced to people's Activity after the commit (announceObjectEvents). */
  eventId: string;
};

/**
 * Write a checked comment, inside the transaction that locked its item
 * (`locked`, FOR UPDATE), for an agent (the agent API) or a person (the web
 * API) alike: the item's next position, the object event (for those it
 * mentions and the Artifact's followers), the author follows
 * the Artifact (unless it stopped), the notices are queued; the author's read
 * position moves over its own comment when nothing unseen lies before it
 * (`readPosition`, read in the same transaction). The caller pushes the
 * queued notices after the commit (sendQueued).
 */
export async function insertComment(tx: DatabaseExecutor, input: {
  outbox: ArtifactNoticeOutbox;
  locked: ArtifactItemRow;
  /** Its id (newCommentId), chosen before so its images could be claimed for it in this transaction. */
  id: string;
  author: ArtifactActorRef;
  readPosition: number | null;
  version: ArtifactVersionRow;
  path: string | null;
  anchor: ArtifactCommentAnchor | null;
  replyTo: string | null;
  body: string;
  /** Who the body mentions, as stored; `mentionedAgents` are the agents among them to tell (not the author). */
  mentions: ArtifactActorRef[];
  mentionedAgents: readonly string[];
  /** Its images as core claimed them for it (claimCommentImages). */
  images: ArtifactCommentImage[];
  now: Date;
  /** Followers not told of it (a resolve's note: the thread's author, told of the resolve instead; resolutions.ts). */
  quiet?: readonly string[];
}): Promise<WrittenComment> {
  const { locked, author, version, now } = input;
  const next = locked.lastPosition + 1;
  const [comment] = await tx.insert(artifactComments).values({
    id: input.id,
    itemId: locked.id,
    versionId: version.id,
    path: input.path,
    anchor: input.anchor,
    replyTo: input.replyTo,
    authorType: author.type,
    authorId: author.id,
    body: input.body,
    mentions: input.mentions,
    images: input.images,
    position: next,
    createdAt: now,
  }).returning();
  // A reply in a resolved thread reopens it (#249), in this transaction.
  await reopenThreadsOf(tx, locked.id, [input.replyTo]);
  // A comment is activity: the list orders by it (most recently active first).
  const [updated] = await tx.update(artifactItems).set({ lastPosition: next, updatedAt: sql`now()` }).where(eq(artifactItems.id, locked.id)).returning();
  // Its own comment is nothing new to the author; only moved over when nothing unseen lies before it.
  if ((input.readPosition ?? 0) >= locked.lastPosition) await advanceReadPosition(author, locked.id, next, tx);
  // Whom the event is for: those it mentions, then the Artifact's followers
  // (the author is left out by the platform); the same followers its notices go to.
  const following = await followersOf(tx, locked.id);
  const event = await recordArtifactEvent(tx, {
    item: locked,
    eventKind: "comment",
    actor: author,
    data: { position: next, comment: comment!.id, version: version.number },
    recipients: [
      ...input.mentions.map((actor) => ({ actor, reason: "mentioned" as const })),
      ...followerRecipients(locked, following),
    ],
  });
  const newlySubscribed = await autoSubscribe(tx, locked.id, author, "commented");
  const noticed = await noticeComment({ executor: tx, outbox: input.outbox, item: updated!, comment: comment!, mentioned: input.mentionedAgents, now, following, ...(input.quiet ? { quiet: input.quiet } : {}) });
  return { kind: "written", comment: comment!, version, newlySubscribed, eventId: event.id, ...noticed };
}

/**
 * Follow: a new row, or the stop cleared. A person who starts following
 * (wasn't already) has read the Artifact up to now, in the same
 * transaction: what is unread while following counts from when they started
 * (decision of 2026-10-26), so following never turns its whole history
 * unread. Their read position moves to the Artifact's last position, never
 * back, and core's Activity row with it (advanceReadPosition).
 */
export async function follow(itemId: string, actor: ArtifactActorRef): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [before] = await tx.select({ unsubscribedAt: artifactSubscriptions.unsubscribedAt }).from(artifactSubscriptions).where(and(
      eq(artifactSubscriptions.itemId, itemId),
      eq(artifactSubscriptions.actorType, actor.type),
      eq(artifactSubscriptions.actorId, actor.id),
    )).limit(1);
    await tx.insert(artifactSubscriptions)
      .values({ itemId, actorType: actor.type, actorId: actor.id, reason: "followed" })
      .onConflictDoUpdate({
        target: [artifactSubscriptions.itemId, artifactSubscriptions.actorType, artifactSubscriptions.actorId],
        set: { unsubscribedAt: null },
      });
    if (actor.type !== "user" || (before && before.unsubscribedAt === null)) return;
    const [item] = await tx.select({ lastPosition: artifactItems.lastPosition }).from(artifactItems).where(eq(artifactItems.id, itemId)).limit(1);
    if (item) await advanceReadPosition(actor, itemId, item.lastPosition, tx);
  });
}

/**
 * Stop following, and drop what was waiting for an agent. The row stays
 * (with unsubscribed_at), so publishing or commenting doesn't follow it
 * again.
 */
export async function unfollow(itemId: string, actor: ArtifactActorRef): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.insert(artifactSubscriptions)
      .values({ itemId, actorType: actor.type, actorId: actor.id, reason: "followed", unsubscribedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [artifactSubscriptions.itemId, artifactSubscriptions.actorType, artifactSubscriptions.actorId],
        set: { unsubscribedAt: sql`coalesce(${artifactSubscriptions.unsubscribedAt}, now())` },
      });
    if (actor.type === "agent") await dropPendingNotice(tx, itemId, actor.id);
  });
}

/** Whether the actor follows the Artifact now. */
export async function isFollowing(itemId: string, actor: ArtifactActorRef): Promise<boolean> {
  const [row] = await getDb().select({ unsubscribedAt: artifactSubscriptions.unsubscribedAt }).from(artifactSubscriptions).where(and(
    eq(artifactSubscriptions.itemId, itemId),
    eq(artifactSubscriptions.actorType, actor.type),
    eq(artifactSubscriptions.actorId, actor.id),
  )).limit(1);
  return row !== undefined && row.unsubscribedAt === null;
}

/** A held comment (or review) as the agent API answers it: 409 UNSEEN_CHANGES. */
export async function held(item: ArtifactItemRow, hold: CommentHold, what: "comment" | "review" = "comment"): Promise<ArtifactApiError> {
  const name = await namer([
    ...hold.comments.map((comment) => ({ type: comment.authorType, id: comment.authorId })),
    ...hold.versions.map((version) => ({ type: version.publisherType, id: version.publisherId })),
  ]);
  const numbers = await versionNumbers(hold.comments.map((comment) => comment.versionId));
  return fail(409, {
    code: "UNSEEN_CHANGES",
    error: unseenChangesError(what, { comments: hold.commentCount, versions: hold.versionCount, unread: hold.unread }),
    next: RAFT_HINTS.artifactComments({ artifact: item.id }),
    details: {
    unseen: {
      comments: hold.comments.map((comment) => ({
        id: comment.id,
        author: name({ type: comment.authorType, id: comment.authorId }),
        version: numbers.get(comment.versionId) ?? 0,
        path: comment.path,
        createdAt: comment.createdAt.toISOString(),
        ...excerptOf(comment.body),
        anchor: comment.anchor ?? null,
        ...imageCountOf(comment),
      })),
      commentCount: hold.commentCount,
      commentsCursor: hold.commentCount > hold.comments.length ? positionCursor(hold.after) : null,
      unread: hold.unread,
      versions: await versionSummaries(item, hold.versions, name, false),
      versionCount: hold.versionCount,
    },
    seen: hold.through,
    skipped: hold.skipped,
    },
  });
}

/** A thread that isn't a comment of this Artifact (resolving or reopening it). */
const threadNotFound = (itemId: string, comment: string): ArtifactRefusal => ({
  code: "COMMENT_NOT_FOUND",
  error: "This artifact has no comment by that id (it may have been deleted): take the thread's first comment id from its comments.",
  next: RAFT_HINTS.artifactComments({ artifact: itemId, all: true }),
  details: { comment },
});

/**
 * Resolve or reopen, for an agent (resolutions.ts has the rule): the
 * Artifact it sees and takes part in, the thread (a root, 409 for a reply),
 * who may (403), then, resolving with a note, the note checked as a reply in
 * that thread (its text and `@name`s), and changeResolution with the agent's
 * hold (as a reply there is held) and the note written by insertComment.
 */
async function agentResolution(
  agent: ArtifactAgent,
  params: AgentApiArtifactCommentParams,
  outbox: ArtifactNoticeOutbox,
  opts: { resolve: boolean; note: string | null },
): Promise<ArtifactApiResult<AgentApiArtifactThreadResolution>> {
  const item = await resolveVisibleItem(agent, params.artifact);
  if (!(await takesPartIn(viewActor(agent), item))) return mayNotTakePart("resolve or reopen its threads");
  const thread = await resolvableThread(viewActor(agent), item, params.comment);
  switch (thread.kind) {
    case "not_found": return fail(404, threadNotFound(item.id, params.comment));
    case "reply":
      return fail(409, {
        code: "COMMENT_IS_REPLY",
        error: `That comment is a reply: only a whole thread is ${opts.resolve ? "resolved" : "reopened"}, by its first comment${thread.thread ? ` (${thread.thread})` : ""}.`,
        ...(thread.thread ? { next: opts.resolve ? RAFT_HINTS.artifactResolve({ artifact: item.id, comment: thread.thread }) : RAFT_HINTS.artifactReopen({ artifact: item.id, comment: thread.thread }) } : {}),
        details: { comment: params.comment, ...(thread.thread ? { thread: thread.thread } : {}) },
      });
    case "forbidden": {
      const name = await namer([thread.threadAuthor, thread.author]);
      return fail(403, {
        code: "FORBIDDEN",
        error: `Only the thread's author, the artifact's author (or whoever manages it, when it's an agent), and the server's owners and admins can ${opts.resolve ? "resolve" : "reopen"} a thread: if you addressed it, say so in a reply and let them resolve it.`,
        next: RAFT_HINTS.artifactComment({ artifact: item.id, replyTo: params.comment }),
        details: { reason: "not_resolver", title: item.title, threadAuthor: name(thread.threadAuthor), author: name(thread.author) },
      });
    }
    case "ok": break;
  }
  const { root } = thread;
  const by = agentActor(agent);

  // A note: a reply in the thread, checked as one (its text, its @names), at the thread's place.
  let note: { text: string; version: ArtifactVersionRow; mentions: Awaited<ReturnType<typeof resolveMentions>> } | null = null;
  if (opts.note !== null) {
    const { text } = await checkCommentFields(item, { body: opts.note });
    const version = await noteVersionFor(item, root);
    if (!version) throw new ArtifactApiFailure(versionNotFound(item.id, null, null));
    note = { text, version, mentions: await resolveMentions(agent, item, text) };
  }

  const outcome = await changeResolution({
    outbox,
    item,
    rootId: root.id,
    by,
    resolve: opts.resolve,
    // Held as a reply in that thread would be: by others' news on its file (or anything, a thread on the whole Artifact).
    hold: async (tx, locked, current) => {
      const position = await readPositionOf(by, locked.id, tx);
      const hold = await evaluateHold(tx, agent, locked, current.path === null ? null : [current.path], position ?? 0);
      if (hold) await advanceReadPosition(by, locked.id, hold.through, tx);
      return hold;
    },
    ...(note === null ? {} : {
      note: async (tx, locked, quiet) => insertComment(tx, {
        outbox,
        locked,
        id: newCommentId(),
        author: by,
        readPosition: await readPositionOf(by, locked.id, tx),
        version: note!.version,
        path: root.path,
        anchor: root.anchor,
        replyTo: root.id,
        body: note!.text,
        mentions: note!.mentions.stored,
        mentionedAgents: note!.mentions.agents,
        images: [],
        now: currentDate(),
        quiet,
      }),
    }),
  });
  if (outcome.kind === "gone") throw new ArtifactApiFailure(notVisible());
  if (outcome.kind === "not_found") return fail(404, threadNotFound(item.id, params.comment));
  if (outcome.kind === "held") return held(item, outcome.hold, "comment");

  const rows = [outcome.root, ...(outcome.note ? [outcome.note.comment] : [])];
  const name = await namer([...commentActors(rows), ...(outcome.toldAgent ? [{ type: "agent" as const, id: outcome.toldAgent }] : [])]);
  const numbers = await versionNumbers(rows.map((row) => row.versionId));
  const written = outcome.note;
  return json<AgentApiArtifactThreadResolution>({
    artifact: await artifactRef(item),
    comment: agentComment(outcome.root, numbers.get(outcome.root.versionId) ?? 0, name),
    note: written ? agentComment(written.comment, written.version.number, name) : null,
    changed: outcome.changed,
    notified: [
      ...(outcome.toldAgent ? [{ actor: name({ type: "agent", id: outcome.toldAgent }), reason: "resolved" as const }] : []),
      ...(written?.notified ?? []),
    ],
    notNotified: written && note ? [
      ...note.mentions.notNotified,
      ...note.mentions.agents.filter((agentId) => written.cannotSee.has(agentId)).map((agentId) => ({ name: note!.mentions.handleOf(agentId), reason: "cannot_see" as const })),
    ] : [],
  });
}

export function createCommentOperations() {
  return {
    comment: (
      agent: ArtifactAgent,
      params: AgentApiArtifactParams,
      body: AgentApiArtifactCommentBody,
      outbox: ArtifactNoticeOutbox,
    ): Promise<ArtifactApiResult<AgentApiArtifactCommentCreated>> => answer(async () => {
      // Step 1.
      // resolveVisibleItem checks the caller's flag first.
      const item = await resolveVisibleItem(agent, params.artifact);
      if (!(await takesPartIn(viewActor(agent), item))) return mayNotTakePart("comment on it");

      // Step 2.
      const { text, path, anchor, images } = await checkCommentFields(item, body);
      const current = await currentVersionOf(item);
      let version: ArtifactVersionRow | null = current;
      if (body.version !== undefined) {
        [version = null] = await getDb().select().from(artifactVersions)
          .where(and(readableVersion(item.id), eq(artifactVersions.number, body.version))).limit(1);
      }
      if (!version) throw new ArtifactApiFailure(versionNotFound(item.id, body.version ?? null, current?.number ?? null));
      await checkFileIn(version!, path);

      // Step 3.
      const mentions = await resolveMentions(agent, item, text);

      // Step 4.
      const now = currentDate();
      const outcome = await getDb().transaction(async (tx): Promise<WrittenComment | { kind: "held"; hold: CommentHold }> => {
        const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, item.id)).for("update");
        if (!locked || locked.deletedAt || locked.revokedAt) throw new ArtifactApiFailure(notVisible());
        // Again under the item's lock, which a delete takes too: the parent may
        // have been deleted since it was looked up (Tenny, #10943).
        if (body.replyTo !== undefined) {
          const [parent] = await tx.select({ id: artifactComments.id }).from(artifactComments)
            .where(and(liveComment(locked.id), eq(artifactComments.id, body.replyTo))).limit(1);
          if (!parent) refuse(404, commentNotFound(locked.id, body.replyTo));
        }
        const position = await readPositionOf(agentActor(agent), locked.id, tx);
        const hold = await evaluateHold(tx, agent, locked, path === null ? null : [path], body.seen ?? position ?? 0);
        if (hold) {
          await advanceReadPosition(agentActor(agent), locked.id, hold.through, tx);
          return { kind: "held", hold };
        }
        // Its images: only this agent's own unused uploads to this Artifact; one that isn't refuses it all (the throw rolls back the claims).
        const id = newCommentId();
        const claimed = await claimCommentImages(tx, locked.id, agentActor(agent), images, commentImagesPart(id));
        if (claimed.kind === "not_found") return refuse(400, imageNotClaimable(claimed.fileId));
        return insertComment(tx, {
          outbox,
          locked,
          id,
          author: agentActor(agent),
          readPosition: position,
          version: version!,
          path,
          anchor,
          replyTo: body.replyTo ?? null,
          body: text,
          mentions: mentions.stored,
          mentionedAgents: mentions.agents,
          images: claimed.images,
          now,
        });
      });
      if (outcome.kind === "held") return held(item, outcome.hold);

      // Step 5.
      await sendQueued(outbox, outcome.queued);
      await announceObjectEvents([outcome.eventId]);
      const { comment } = outcome;
      const name = await namer(commentActors([comment]));
      return json<AgentApiArtifactCommentCreated>({
        artifact: await artifactRef(item),
        comment: agentComment(comment, outcome.version.number, name),
        notified: outcome.notified,
        notNotified: [
          ...mentions.notNotified,
          ...mentions.agents.filter((agentId) => outcome.cannotSee.has(agentId)).map((agentId) => ({ name: mentions.handleOf(agentId), reason: "cannot_see" as const })),
        ],
        newlySubscribed: outcome.newlySubscribed,
      }, 201);
    }),

    /** Resolve a thread (#249, resolutions.ts), with an optional note posted first as the agent's reply. */
    resolve: (
      agent: ArtifactAgent,
      params: AgentApiArtifactCommentParams,
      body: AgentApiArtifactResolveBody,
      outbox: ArtifactNoticeOutbox,
    ): Promise<ArtifactApiResult<AgentApiArtifactThreadResolution>> => answer(() => agentResolution(agent, params, outbox, { resolve: true, note: body.note ?? null })),

    /** Reopen a resolved thread (#249). Tells no one. */
    reopen: (
      agent: ArtifactAgent,
      params: AgentApiArtifactCommentParams,
      outbox: ArtifactNoticeOutbox,
    ): Promise<ArtifactApiResult<AgentApiArtifactThreadResolution>> => answer(() => agentResolution(agent, params, outbox, { resolve: false, note: null })),

    /** Follow: a new row, or the stop cleared. Only an agent of the Artifact's server or of its joint channel follows it (takesPartIn). */
    subscribe: (agent: ArtifactAgent, params: AgentApiArtifactParams): Promise<ArtifactApiResult<AgentApiArtifactSubscriptionResponse>> => answer(async () => {
      // resolveVisibleItem checks the caller's flag first.
      const item = await resolveVisibleItem(agent, params.artifact);
      if (!(await takesPartIn(viewActor(agent), item))) return mayNotTakePart("follow it");
      await follow(item.id, agentActor(agent));
      return json({ artifact: await artifactRef(item), following: true });
    }),

    /**
     * Stop following, and drop what was waiting for the agent. The row stays
     * (with unsubscribed_at), so publishing or commenting doesn't follow it
     * again. Someone else (outside the server and its joint) never follows: nothing to stop.
     */
    unsubscribe: (agent: ArtifactAgent, params: AgentApiArtifactParams): Promise<ArtifactApiResult<AgentApiArtifactSubscriptionResponse>> => answer(async () => {
      // resolveVisibleItem checks the caller's flag first.
      const item = await resolveVisibleItem(agent, params.artifact);
      if (await takesPartIn(viewActor(agent), item)) await unfollow(item.id, agentActor(agent));
      return json({ artifact: await artifactRef(item), following: false });
    }),
  };
}
