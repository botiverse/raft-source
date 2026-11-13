// Notices to agents (S1c; Sage's notices spec, mirroring Raft Artifacts'
// noticeService): what an agent is told about an Artifact, as a
// `system.artifacts` notification whose payload is `{ app_event: { ...notice,
// app: "artifacts", kind: "artifact" } }` (ArtifactAgentNotice, the
// schema register.ts registers) and whose summary is formatArtifactNotice's
// line.
//
// - Mentioned (`mentioned`): an agent @-mentioned in a comment, at once. Being
//   mentioned doesn't follow the Artifact, and reaches an agent that stopped
//   following it.
// - Followers (`subscribed`): others' comments reach the Artifact's followers
//   (subscriptions without unsubscribed_at), one notice per comment, at once,
//   as chat messages reach agents (xxchan, #55: comments follow messages, which
//   aren't batched). A follower mentioned in the comment is told once, as
//   mentioned. (Until #55 they were collected two minutes in pending_notices;
//   flushDueArtifactNotices only drains rows queued before then, legacy.)
// - Changed files (`your_file_changed`): a new version that changes or removes
//   a file a follower was the last to publish tells that follower, at once.
//   Other new versions tell nobody (the next read shows them).
//
// - Reviews (S8): one notice per agent for the whole review, at once
//   (noticeReview): `mentioned` when its summary or any comment mentions the
//   agent, else `subscribed` (a follower), with `review`.
// - Renames (task #147): a new title, by a person on the web or an agent's
//   push, tells the other following agents (noticeRename): `subscribed`,
//   with `renamed` (who, from, to). It only changes what the Artifact is
//   shown as, so it is queued and never pushed: it wakes no agent (Sage,
//   task #160). The agent gets it with whatever wakes it next (its next
//   /events pull or wake-hints read takes its queued events), unless it
//   expires first (ARTIFACT_NOTICE_TTL_MS: dropped, the title is on the
//   Artifact anyway).
//
// - Announcements (#proj-chat:#29, channel_announcement_v0): a new version
//   of the Artifact a channel has as its announcement tells that channel's
//   other agents (noticeChannelAnnouncement): `subscribed`, with `channelAnnouncement`
//   (the channel, who pushed which version). Not a follower's notice: it
//   comes from being in the channel. Queued and never pushed, as a rename's:
//   it wakes no agent. An agent told `your_file_changed` of the same version
//   is not told twice.
//
// - Resolves (#249): someone else resolving a thread tells its author, an
//   agent, at once (noticeResolved), `your_comment_resolved` with `resolved`,
//   whether it follows or not. A reopen tells no one.
//
// Only agents are told for now; a person's comment (the web API) tells them
// exactly as an agent's does, and an edit tells only the agents it newly
// mentions. Who may see the Artifact is checked when a notice is queued (in
// the transaction that writes it: the comment's, the edit's, the version's,
// the review's, the rename's, or the legacy flush's) and again right before it
// is pushed, after the commit (sendQueued; a rename's is never pushed, so the
// delivery guard checks it when it is handed over): a recipient that can't
// see it then is dropped and its queued event taken back. Between the commit and that second
// check the event is in the agent's queue (the agent's next pull could take
// it): a window of milliseconds. Re-deliveries of an event already pushed are
// not checked again here (see ARTIFACT_NOTICE_TTL_MS).
//
// Dropped silently (in neither `notified` nor `notNotified`): followers and
// last publishers who can't see the Artifact. An agent @-mentioned by name
// that can't see it is reported back to the commenter as `cannot_see`
// (Tenny: the commenter can infer it from the home's members, and it tells
// them to reach that agent in the conversation instead).
//
// A notice never moves its recipient's read position (Tenny): it is only a
// notification. Queueing it, handing it over on /events or pushing it to the
// daemon proves nothing about whether the model read it. Only the routes that
// return content to the agent (the read, the comments list, the holds)
// mark anything as seen (apiCommon shownThrough). So a follower told of a
// short comment is still held by it until it reads the Artifact.
import { and, asc, eq, inArray, isNull, lte, max } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN,
  ARTIFACT_NOTICE_MAX_CHARS,
  asArtifactReviewId,
  currentDate,
  formatArtifactNotice,
  type AgentApiArtifactActor,
  type AgentApiArtifactCommentExcerpt,
  type ArtifactAgentNotice,
  type ServerId,
} from "@botiverse/raft-shared";
import { agentServers } from "../../platform/actors";
import { channelAnnouncementAudience } from "../../platform/channelAnnouncements";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import {
  artifactsEnabled,
  excerptOf,
  imageCountOf,
  liveComment,
  namer,
  readableVersion,
  takesPartIn,
  versionNumbers,
  type ArtifactActorRef,
  type ArtifactNoticeOutbox,
} from "./apiCommon";
import {
  artifactComments,
  artifactItems,
  artifactPendingNotices,
  artifactSubscriptions,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactCommentRow,
  type ArtifactItemRow,
  type ArtifactSubscriptionReason,
  type ArtifactVersionRow,
} from "./schema";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { canViewArtifacts } from "./visibility";

/**
 * A queued notice expires after 6 hours. Visibility is checked when a notice
 * is queued, right before its first push (sendQueued), and by core on every
 * later hand-over or re-read (artifactNoticeDeliveryVerdicts, the delivery
 * guard), so the TTL only bounds how stale an undelivered notice may get.
 */
export const ARTIFACT_NOTICE_TTL_MS = 6 * 60 * 60 * 1000;
/** Legacy pending_notices rows one flush takes. */
const FLUSH_LIMIT = 100;

/** A notice queued in a transaction: pushed, or taken back, once it commits (sendQueued). */
export interface QueuedNotice {
  eventId: string;
  agentId: string;
  itemId: string;
}

export type NotifiedAgent<R extends ArtifactAgentNotice["reason"] = ArtifactAgentNotice["reason"]> = { actor: AgentApiArtifactActor; reason: R };

const agentRef = (agentId: string): ArtifactActorRef => ({ type: "agent", id: agentId });

function clipSummary(text: string): string {
  const chars = Array.from(text);
  return chars.length <= ARTIFACT_NOTICE_MAX_CHARS ? text : `${chars.slice(0, ARTIFACT_NOTICE_MAX_CHARS - 1).join("")}…`;
}

/**
 * Follow the Artifact on the actor's behalf (publishing, commenting), unless
 * it has a row already (following, or stopped: that sticks). True when this
 * made it a follower.
 */
export async function autoSubscribe(executor: DatabaseExecutor, itemId: string, actor: ArtifactActorRef, reason: Exclude<ArtifactSubscriptionReason, "followed">): Promise<boolean> {
  const inserted = await executor.insert(artifactSubscriptions)
    .values({ itemId, actorType: actor.type, actorId: actor.id, reason })
    .onConflictDoNothing()
    .returning({ actorId: artifactSubscriptions.actorId });
  return inserted.length > 0;
}

/**
 * Everyone following the Artifact now, people and agents: who hears of its
 * events (object_event_recipients) and, of them, the agents its notices go
 * to. Read once per change and handed to noticeComment / noticeVersion.
 */
export async function followersOf(executor: DatabaseExecutor, itemId: string): Promise<ArtifactActorRef[]> {
  const rows = await executor.select({ type: artifactSubscriptions.actorType, id: artifactSubscriptions.actorId }).from(artifactSubscriptions)
    .where(and(eq(artifactSubscriptions.itemId, itemId), isNull(artifactSubscriptions.unsubscribedAt)));
  return rows.map((row) => ({ type: row.type, id: row.id }));
}

const agentIdsOf = (actors: readonly ArtifactActorRef[]): string[] => actors.filter((actor) => actor.type === "agent").map((actor) => actor.id);

/** Of these agents, those following the Artifact now. */
async function followingAgents(executor: DatabaseExecutor, itemId: string, agentIds?: readonly string[]): Promise<string[]> {
  if (agentIds && agentIds.length === 0) return [];
  const rows = await executor.select({ actorId: artifactSubscriptions.actorId }).from(artifactSubscriptions).where(and(
    eq(artifactSubscriptions.itemId, itemId),
    eq(artifactSubscriptions.actorType, "agent"),
    isNull(artifactSubscriptions.unsubscribedAt),
    agentIds ? inArray(artifactSubscriptions.actorId, [...agentIds]) : undefined,
  ));
  return rows.map((row) => row.actorId);
}

/** Each of these agents' own server, in one query (absent for one that no longer exists). */
const serversOfAgents = (executor: DatabaseExecutor, agentIds: readonly string[]): Promise<Map<string, ServerId>> => agentServers(agentIds, { executor });

/**
 * Whether the agent, in its own server, may be told of the item now: an
 * agent of the item's server that can see it, or, for an item homed in a
 * joint channel, an agent of another server in it that takes part in it
 * (apiCommon takesPartIn: a joint's object is a message there, #68; so one
 * whose server left the joint, or turned Artifacts off, is told nothing more).
 */
async function agentMayBeTold(executor: DatabaseExecutor, item: ArtifactItemRow, agentId: string, serverId: ServerId): Promise<boolean> {
  if (serverId === item.serverId) return (await canViewArtifacts({ type: "agent", id: agentId, serverId }, [item], { executor }))[0]!;
  return item.deletedAt === null && item.revokedAt === null && takesPartIn({ type: "agent", id: agentId, serverId }, item);
}

/** Of these agents, those who may be told of the item now (agentMayBeTold, each in its own server). */
async function agentsWhoSee(executor: DatabaseExecutor, item: ArtifactItemRow, agentIds: readonly string[]): Promise<Set<string>> {
  const seeing = new Set<string>();
  const serverOf = await serversOfAgents(executor, agentIds);
  for (const agentId of agentIds) {
    const serverId = serverOf.get(agentId);
    if (serverId && await agentMayBeTold(executor, item, agentId, serverId)) seeing.add(agentId);
  }
  return seeing;
}

type Following = NonNullable<ArtifactAgentNotice["following"]>;

/**
 * Why each of these followers follows, in one query: the last version it
 * published, else it commented, else it chose to. An agent with no
 * subscription row (callers pass followers only) reads as `followed`.
 */
async function followingOfAll(executor: DatabaseExecutor, itemId: string, agentIds: readonly string[]): Promise<(agentId: string) => Following> {
  const rows = agentIds.length === 0 ? [] : await executor.select({
    actorId: artifactSubscriptions.actorId,
    reason: artifactSubscriptions.reason,
    published: max(artifactVersions.number),
  }).from(artifactSubscriptions)
    .leftJoin(artifactVersions, and(
      readableVersion(itemId),
      eq(artifactVersions.publisherType, "agent"),
      eq(artifactVersions.publisherId, artifactSubscriptions.actorId),
    ))
    .where(and(
      eq(artifactSubscriptions.itemId, itemId),
      eq(artifactSubscriptions.actorType, "agent"),
      inArray(artifactSubscriptions.actorId, [...new Set(agentIds)]),
    ))
    .groupBy(artifactSubscriptions.actorId, artifactSubscriptions.reason);
  const byAgent = new Map(rows.map((row) => [row.actorId, row]));
  return (agentId) => {
    const row = byAgent.get(agentId);
    if (row?.published != null) return { kind: "published", version: row.published };
    if (row?.reason === "published") return { kind: "published", version: null };
    return { kind: row?.reason === "commented" ? "commented" : "followed", version: null };
  };
}

/** Comments as a notice carries them (artifactRead's unseen.comments shape). */
async function excerpts(executor: DatabaseExecutor, comments: readonly ArtifactCommentRow[]): Promise<AgentApiArtifactCommentExcerpt[]> {
  const name = await namer(comments.map((comment) => ({ type: comment.authorType, id: comment.authorId })), executor);
  const numbers = await versionNumbers(comments.map((comment) => comment.versionId), executor);
  return comments.map((comment) => ({
    id: comment.id,
    author: name({ type: comment.authorType, id: comment.authorId }),
    version: numbers.get(comment.versionId) ?? 0,
    path: comment.path,
    createdAt: comment.createdAt.toISOString(),
    ...excerptOf(comment.body),
    anchor: comment.anchor ?? null,
    ...imageCountOf(comment),
  }));
}

/** Queue one notice in `executor`'s transaction. */
async function queueNotice(
  executor: DatabaseExecutor,
  outbox: ArtifactNoticeOutbox,
  item: ArtifactItemRow,
  agentId: string,
  notice: ArtifactAgentNotice,
  now: Date,
): Promise<QueuedNotice> {
  // In the agent's own server: a joint's agent of another server is told there.
  const serverId = (await serversOfAgents(executor, [agentId])).get(agentId) ?? item.serverId;
  const { eventId } = await outbox.queue(executor, {
    serverId,
    agentId,
    summary: clipSummary(formatArtifactNotice(notice, "cli")),
    kind: ARTIFACT_OBJECT_KIND,
    event: notice,
    ttlMs: ARTIFACT_NOTICE_TTL_MS,
    now,
    // RFC 081 D11: an Artifact's notices are one inbox item (`app:system.artifacts/<id>`),
    // about its home conversation (D8; none for a server-wide or orphaned one).
    objectRef: item.id,
    relatedChannelId: item.homeChannelId ?? null,
  });
  return { eventId, agentId, itemId: item.id };
}

/**
 * After the transaction that queued them commits: push each notice whose
 * agent can still see the Artifact (with the flag still on), take back the
 * others. A failure is logged and leaves the notice queued.
 */
export async function sendQueued(outbox: ArtifactNoticeOutbox, queued: readonly QueuedNotice[]): Promise<void> {
  // One answer for the deployment (apiCommon artifactsEnabled): read once.
  let on: boolean | undefined;
  for (const notice of queued) {
    try {
      const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, notice.itemId)).limit(1);
      let send = false;
      if (item) {
        on ??= await artifactsEnabled(item.serverId);
        send = on && (await agentsWhoSee(getDb(), item, [notice.agentId])).has(notice.agentId);
      }
      if (send) await outbox.push(notice.eventId);
      else await outbox.withdraw(notice.eventId);
    } catch (error) {
      console.error("[artifacts] notice send failed; left queued", { eventId: notice.eventId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** What the delivery guard reads of a `system.artifacts` event. */
export interface ArtifactNoticeEvent {
  id: string;
  agentId: string;
  serverId: string;
  payload: Record<string, unknown>;
}

/** The Artifact a notice's payload names (`app_event.artifact.id`), or null. */
function noticedItemId(payload: Record<string, unknown>): string | null {
  const notice = payload.app_event;
  if (typeof notice !== "object" || notice === null) return null;
  const artifact = (notice as Record<string, unknown>).artifact;
  if (typeof artifact !== "object" || artifact === null) return null;
  const id = (artifact as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/**
 * The delivery guard of `system.artifacts` events (register.ts registers it
 * as agentNotice.deliverable; core's systemAppDeliveryGuards runs it). An
 * event is delivered only while the flag is on for its server and its agent
 * can still see the Artifact it is about, in that server; or, an event in
 * another server (a joint's agent there, queued in its own server), while
 * the agent is that server's and takes part in the Artifact (agentMayBeTold,
 * both servers' flags with it); anything else, including a payload that
 * names no Artifact, is vetoed. Core asks it on
 * every path that hands an event over or re-reads it, so a notice queued
 * while the agent could see the Artifact never reaches it after it can't.
 * Constant queries per server and agent in the batch.
 */
export async function artifactNoticeDeliveryVerdicts(events: readonly ArtifactNoticeEvent[]): Promise<Map<string, boolean>> {
  const verdicts = new Map<string, boolean>(events.map((event) => [event.id, false]));
  const itemIds = [...new Set(events.flatMap((event) => noticedItemId(event.payload) ?? []))];
  if (itemIds.length === 0) return verdicts;
  const items = new Map((await getDb().select().from(artifactItems).where(inArray(artifactItems.id, itemIds))).map((item) => [item.id, item]));
  // One answer for the deployment (apiCommon artifactsEnabled): read once.
  let on: boolean | undefined;
  const byAgent = new Map<string, { serverId: ServerId; agentId: string; asked: Array<{ eventId: string; item: ArtifactItemRow }> }>();
  const elsewhere: Array<{ event: ArtifactNoticeEvent; item: ArtifactItemRow }> = [];
  for (const event of events) {
    const itemId = noticedItemId(event.payload);
    const item = itemId === null ? undefined : items.get(itemId);
    if (!item) continue;
    if (item.serverId !== event.serverId) {
      elsewhere.push({ event, item });
      continue;
    }
    // Core's event row carries a plain server id; the item's (equal, just
    // checked) is the branded one.
    on ??= await artifactsEnabled(item.serverId);
    if (!on) continue;
    const key = `${event.serverId}:${event.agentId}`;
    const entry = byAgent.get(key) ?? { serverId: item.serverId, agentId: event.agentId, asked: [] };
    entry.asked.push({ eventId: event.id, item });
    byAgent.set(key, entry);
  }
  for (const { serverId, agentId, asked } of byAgent.values()) {
    const answers = await canViewArtifacts({ type: "agent", id: agentId, serverId }, asked.map((entry) => entry.item));
    asked.forEach((entry, index) => verdicts.set(entry.eventId, answers[index]!));
  }
  // A joint's agent of another server: the event's server must be the agent's own.
  const serverOf = await serversOfAgents(getDb(), elsewhere.map(({ event }) => event.agentId));
  for (const { event, item } of elsewhere) {
    const serverId = serverOf.get(event.agentId);
    if (serverId !== event.serverId) continue;
    verdicts.set(event.id, await agentMayBeTold(getDb(), item, event.agentId, serverId));
  }
  return verdicts;
}

/** Why someone hears about a comment, as the web names it (ArtifactNoticeReason, short of `mentioned`). */
export type ArtifactFollowReason = "author" | "publisher" | "commented" | "subscribed";

/** Why each of these agents follows the Artifact: it made it, it published a version, it commented, or it chose to. */
export async function followReasons(executor: DatabaseExecutor, item: ArtifactItemRow, agentIds: readonly string[]): Promise<Map<string, ArtifactFollowReason>> {
  if (agentIds.length === 0) return new Map();
  const rows = await executor.select({ actorId: artifactSubscriptions.actorId, reason: artifactSubscriptions.reason }).from(artifactSubscriptions).where(and(
    eq(artifactSubscriptions.itemId, item.id),
    eq(artifactSubscriptions.actorType, "agent"),
    inArray(artifactSubscriptions.actorId, [...agentIds]),
  ));
  const reasonOf = new Map(rows.map((row) => [row.actorId, row.reason]));
  const why: Record<ArtifactSubscriptionReason, ArtifactFollowReason> = { published: "publisher", commented: "commented", followed: "subscribed" };
  return new Map(agentIds.map((agentId) => [
    agentId,
    item.createdByType === "agent" && item.createdById === agentId ? "author" : why[reasonOf.get(agentId) ?? "followed"],
  ]));
}

/**
 * Who a new comment on the Artifact tells besides those it mentions, as
 * things stand: its following agents (the author left out) that can see it,
 * with why each follows. Only agents are told for now (people's Activity is
 * S6).
 */
export async function commentFollowers(
  executor: DatabaseExecutor,
  item: ArtifactItemRow,
  author: ArtifactActorRef,
): Promise<Array<{ agentId: string; reason: ArtifactFollowReason }>> {
  const following = (await followingAgents(executor, item.id)).filter((agentId) => !(author.type === "agent" && author.id === agentId));
  const seeing = await agentsWhoSee(executor, item, following);
  const agentIds = following.filter((agentId) => seeing.has(agentId)).sort();
  const reasons = await followReasons(executor, item, agentIds);
  return agentIds.map((agentId) => ({ agentId, reason: reasons.get(agentId)! }));
}

/**
 * A comment's notices, in its transaction, all at once: mentioned agents that
 * can see the Artifact (`mentioned`), then its other followers (not the
 * author) that can (`subscribed`, one notice each for this comment), unless
 * `followers` is false (an edit tells only the mentions it adds). Returns
 * what was queued and who is told (`told`: by agent id).
 */
export async function noticeComment(input: {
  executor: DatabaseExecutor;
  outbox: ArtifactNoticeOutbox;
  item: ArtifactItemRow;
  comment: ArtifactCommentRow;
  /** Mentioned agents of the item's server, not the author, once each. */
  mentioned: readonly string[];
  now: Date;
  followers?: boolean;
  /** The Artifact's followers as this transaction read them (followersOf); read here when absent. */
  following?: readonly ArtifactActorRef[];
  /** Followers not told of it (a resolve's note: the thread's author, told of the resolve instead). */
  quiet?: readonly string[];
}): Promise<{
  queued: QueuedNotice[];
  notified: NotifiedAgent<"mentioned" | "subscribed">[];
  told: Array<{ agentId: string; reason: "mentioned" | "subscribed" }>;
  cannotSee: Set<string>;
}> {
  const { executor, item, comment } = input;
  const author = comment.authorType === "agent" ? comment.authorId : null;
  const seeMentions = await agentsWhoSee(executor, item, input.mentioned);
  const followers = input.followers === false
    ? []
    : (input.following ? agentIdsOf(input.following) : await followingAgents(executor, item.id))
      .filter((agentId) => agentId !== author && !input.mentioned.includes(agentId) && !(input.quiet ?? []).includes(agentId));
  const seeFollowers = await agentsWhoSee(executor, item, followers);

  const queued: QueuedNotice[] = [];
  const told: Array<{ agentId: string; reason: "mentioned" | "subscribed" }> = [
    ...input.mentioned.filter((id) => seeMentions.has(id)).map((agentId) => ({ agentId, reason: "mentioned" as const })),
    ...followers.filter((id) => seeFollowers.has(id)).map((agentId) => ({ agentId, reason: "subscribed" as const })),
  ];
  if (told.length > 0) {
    const [excerpt] = await excerpts(executor, [comment]);
    const followingOf = await followingOfAll(executor, item.id, told.flatMap((entry) => (entry.reason === "subscribed" ? [entry.agentId] : [])));
    for (const { agentId, reason } of told) {
      const notice: ArtifactAgentNotice = {
        artifact: { id: item.id, title: item.title },
        reason,
        following: reason === "mentioned" ? null : followingOf(agentId),
        comments: { count: 1, latest: [excerpt!] },
        version: null,
      };
      queued.push(await queueNotice(executor, input.outbox, item, agentId, notice, input.now));
    }
  }
  const name = await namer(told.map((entry) => agentRef(entry.agentId)), executor);
  return {
    queued,
    notified: told.map((entry) => ({ actor: name(agentRef(entry.agentId)), reason: entry.reason })),
    told,
    cannotSee: new Set(input.mentioned.filter((id) => !seeMentions.has(id))),
  };
}

/**
 * A review's notices (S8), in its transaction: one notice per agent for the
 * whole review, at once, as a single comment's. An agent its summary or any
 * of its comments mentions, that can see the Artifact, is told `mentioned`; the Artifact's other followers
 * (not the reviewer) `subscribed`. Each notice carries `review` (how many
 * comments, on how many files, how often it mentions this agent, the
 * summary's excerpt) and, for clients from before S8, `comments` as a
 * comment notice has them: the review's count, and the comments that
 * mention this agent (mentioned) or the review's last few (oldest first).
 * Returns what was queued and who is told, as noticeComment.
 */
export async function noticeReview(input: {
  executor: DatabaseExecutor;
  outbox: ArtifactNoticeOutbox;
  item: ArtifactItemRow;
  review: { id: string; version: number; reviewer: ArtifactActorRef };
  /** The review's comments in order, each with the agents it mentions (not the reviewer). */
  comments: ReadonlyArray<{ row: ArtifactCommentRow; mentioned: readonly string[] }>;
  /** Its summary (stored as a comment on the whole Artifact, posted last), or null. */
  summary: { row: ArtifactCommentRow; mentioned: readonly string[] } | null;
  now: Date;
  /** The Artifact's followers as this transaction read them (followersOf). */
  following: readonly ArtifactActorRef[];
}): Promise<{
  queued: QueuedNotice[];
  notified: NotifiedAgent<"mentioned" | "subscribed">[];
  told: Array<{ agentId: string; reason: "mentioned" | "subscribed" }>;
  cannotSee: Set<string>;
}> {
  const { executor, item, review, comments, summary } = input;
  const all = summary ? [...comments, summary] : [...comments];
  const reviewer = review.reviewer.type === "agent" ? review.reviewer.id : null;
  const mentioned = [...new Set(all.flatMap((entry) => entry.mentioned))].filter((agentId) => agentId !== reviewer);
  const seeMentions = await agentsWhoSee(executor, item, mentioned);
  const followers = agentIdsOf(input.following).filter((agentId) => agentId !== reviewer && !mentioned.includes(agentId));
  const seeFollowers = await agentsWhoSee(executor, item, followers);

  const queued: QueuedNotice[] = [];
  const recipients = [
    ...mentioned.filter((agentId) => seeMentions.has(agentId)).map((agentId) => ({ agentId, reason: "mentioned" as const })),
    ...followers.filter((agentId) => seeFollowers.has(agentId)).map((agentId) => ({ agentId, reason: "subscribed" as const })),
  ];
  if (recipients.length > 0) {
    const shown = new Map((await excerpts(executor, all.map((entry) => entry.row))).map((excerpt) => [excerpt.id, excerpt]));
    const name = await namer([review.reviewer], executor);
    const about = {
      id: asArtifactReviewId(review.id),
      author: name(review.reviewer),
      version: review.version,
      commentCount: comments.length,
      fileCount: new Set(comments.flatMap((entry) => (entry.row.path === null ? [] : [entry.row.path]))).size,
      summaryExcerpt: summary ? excerptOf(summary.row.body).excerpt : null,
    };
    const followingOf = await followingOfAll(executor, item.id, recipients.flatMap((entry) => (entry.reason === "subscribed" ? [entry.agentId] : [])));
    for (const { agentId, reason } of recipients) {
      // A mention is told with the comments that mention it (the summary among them when it does); a follower with the review's last few.
      const carried = reason === "mentioned" ? all.filter((entry) => entry.mentioned.includes(agentId)) : all;
      const notice: ArtifactAgentNotice = {
        artifact: { id: item.id, title: item.title },
        reason,
        following: reason === "mentioned" ? null : followingOf(agentId),
        comments: { count: comments.length, latest: carried.slice(-AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN).map((entry) => shown.get(entry.row.id)!) },
        version: null,
        review: { ...about, mentionsYou: all.filter((entry) => entry.mentioned.includes(agentId)).length },
      };
      queued.push(await queueNotice(executor, input.outbox, item, agentId, notice, input.now));
    }
  }
  const name = await namer(recipients.map((entry) => agentRef(entry.agentId)), executor);
  return {
    queued,
    notified: recipients.map((entry) => ({ actor: name(agentRef(entry.agentId)), reason: entry.reason })),
    told: recipients,
    cannotSee: new Set(mentioned.filter((id) => !seeMentions.has(id))),
  };
}

/**
 * A rename's notices (rename.ts retitleItem), in its transaction: each agent
 * that follows the Artifact (`following`, as the transaction read it), not
 * the one renaming it, and can see it is told who renamed it, from what to
 * what, so one that knew it by its old title finds it by its id. Queued
 * only, never pushed (sendQueued is not called for them): a rename wakes no
 * agent; it is handed over with the agent's next pull, through the delivery
 * guard. People are told nothing (no Activity row).
 */
export async function noticeRename(input: {
  executor: DatabaseExecutor;
  outbox: ArtifactNoticeOutbox;
  /** The item with its new title. */
  item: ArtifactItemRow;
  by: ArtifactActorRef;
  /** The title it had. */
  from: string;
  following: readonly ArtifactActorRef[];
  /** Agents not told besides the renamer: an assistant renaming as its owner (publish.ts) isn't told of its own rename. */
  except?: readonly string[];
}): Promise<void> {
  const { executor, item, by } = input;
  const followers = agentIdsOf(input.following).filter((agentId) => !(by.type === "agent" && by.id === agentId) && !(input.except ?? []).includes(agentId));
  const seeing = await agentsWhoSee(executor, item, followers);
  const recipients = followers.filter((agentId) => seeing.has(agentId)).sort();
  if (recipients.length === 0) return;
  const name = await namer([by], executor);
  const followingOf = await followingOfAll(executor, item.id, recipients);
  const now = currentDate();
  for (const agentId of recipients) {
    const notice: ArtifactAgentNotice = {
      artifact: { id: item.id, title: item.title },
      reason: "subscribed",
      following: followingOf(agentId),
      comments: null,
      version: null,
      renamed: { by: name(by), from: input.from, to: item.title },
    };
    await queueNotice(executor, input.outbox, item, agentId, notice, now);
  }
}

/**
 * A resolve's notice (#249), in its transaction: the thread's author, an
 * agent other than the resolver, that may be told of the Artifact now, at
 * once, `your_comment_resolved` with `resolved` (who, the thread's root as
 * an excerpt, the note's start). Sent whether it follows the Artifact or
 * not: it is about its own comment, as a mention is about it. A reopen tells
 * no one. Returns what was queued and the agent told (null: none).
 */
export async function noticeResolved(input: {
  executor: DatabaseExecutor;
  outbox: ArtifactNoticeOutbox;
  item: ArtifactItemRow;
  /** The thread's root, resolved. */
  root: ArtifactCommentRow;
  by: ArtifactActorRef;
  /** The note posted as a reply, or null. */
  note: ArtifactCommentRow | null;
  now: Date;
}): Promise<{ queued: QueuedNotice[]; told: string | null }> {
  const { executor, item, root, by } = input;
  if (root.authorType !== "agent" || (by.type === "agent" && by.id === root.authorId)) return { queued: [], told: null };
  const agentId = root.authorId;
  if (!(await agentsWhoSee(executor, item, [agentId])).has(agentId)) return { queued: [], told: null };
  const [excerpt] = await excerpts(executor, [root]);
  const name = await namer([by], executor);
  const notice: ArtifactAgentNotice = {
    artifact: { id: item.id, title: item.title },
    reason: "your_comment_resolved",
    following: null,
    comments: null,
    version: null,
    resolved: { by: name(by), comment: excerpt!, noteExcerpt: input.note ? excerptOf(input.note.body).excerpt : null },
  };
  return { queued: [await queueNotice(executor, input.outbox, item, agentId, notice, input.now)], told: agentId };
}

/** path -> sha256 of one version's files. */
async function filesOf(executor: DatabaseExecutor, versionId: string): Promise<Map<string, string>> {
  const rows = await executor.select({ path: artifactVersionFiles.path, sha256: artifactVersionFiles.sha256 })
    .from(artifactVersionFiles).where(eq(artifactVersionFiles.versionId, versionId));
  return new Map(rows.map((row) => [row.path, row.sha256]));
}

/**
 * Each path's last publisher as of `upTo`: the version that gave the path the
 * bytes it has in `upTo` (the first after the last readable version where it
 * had other bytes, or none). Paths `upTo` doesn't have have none.
 */
async function lastPublishers(executor: DatabaseExecutor, itemId: string, upTo: ArtifactVersionRow, paths: readonly string[]): Promise<Map<string, ArtifactVersionRow>> {
  const found = new Map<string, ArtifactVersionRow>();
  if (paths.length === 0) return found;
  const versions = await executor.select().from(artifactVersions)
    .where(and(readableVersion(itemId), lte(artifactVersions.number, upTo.number)))
    .orderBy(asc(artifactVersions.number));
  const files = await executor.select({ versionId: artifactVersionFiles.versionId, path: artifactVersionFiles.path, sha256: artifactVersionFiles.sha256 })
    .from(artifactVersionFiles)
    .where(and(inArray(artifactVersionFiles.versionId, versions.map((version) => version.id)), inArray(artifactVersionFiles.path, [...paths])));
  const shaOf = new Map(files.map((file) => [`${file.versionId}\u0000${file.path}`, file.sha256]));
  for (const path of paths) {
    let previous: string | undefined;
    let last: ArtifactVersionRow | undefined;
    for (const version of versions) {
      const sha = shaOf.get(`${version.id}\u0000${path}`);
      if (sha !== undefined && sha !== previous) last = version;
      if (sha === undefined) last = undefined;
      previous = sha;
    }
    if (last) found.set(path, last);
  }
  return found;
}

/**
 * A new current version's notices, in its transaction: each other agent that
 * follows the Artifact, can see it, and was the last to publish a file this
 * version changed or removed (against the version it follows) is told at once.
 */
export async function noticeVersion(input: {
  executor: DatabaseExecutor;
  outbox: ArtifactNoticeOutbox;
  item: ArtifactItemRow;
  version: ArtifactVersionRow;
  /** The version that was current before it; null for a new Artifact. */
  previous: ArtifactVersionRow | null;
  now: Date;
  /** The Artifact's followers as this transaction read them (followersOf); read here when absent. */
  following?: readonly ArtifactActorRef[];
  /** Agents not told besides the publisher: an assistant publishing as its owner (publish.ts) isn't told of its own push. */
  except?: readonly string[];
}): Promise<{ queued: QueuedNotice[]; notified: NotifiedAgent[] }> {
  const { executor, item, version, previous } = input;
  if (!previous) return { queued: [], notified: [] };
  const [before, after] = await Promise.all([filesOf(executor, previous.id), filesOf(executor, version.id)]);
  const changed = [...before.keys()].filter((path) => after.get(path) !== before.get(path));
  const owners = await lastPublishers(executor, item.id, previous, changed);
  const byAgent = new Map<string, { paths: string[]; version: number }>();
  for (const [path, owner] of owners) {
    if (owner.publisherType !== "agent" || (version.publisherType === "agent" && owner.publisherId === version.publisherId) || (input.except ?? []).includes(owner.publisherId)) continue;
    const entry = byAgent.get(owner.publisherId) ?? { paths: [], version: 0 };
    entry.paths.push(path);
    entry.version = Math.max(entry.version, owner.number);
    byAgent.set(owner.publisherId, entry);
  }
  const followingNow = input.following ? new Set(agentIdsOf(input.following)) : null;
  const followers = followingNow
    ? [...byAgent.keys()].filter((agentId) => followingNow.has(agentId))
    : await followingAgents(executor, item.id, [...byAgent.keys()]);
  const seeing = await agentsWhoSee(executor, item, followers);
  const recipients = followers.filter((agentId) => seeing.has(agentId)).sort();
  if (recipients.length === 0) return { queued: [], notified: [] };

  const name = await namer([{ type: version.publisherType, id: version.publisherId }, ...recipients.map(agentRef)], executor);
  const queued: QueuedNotice[] = [];
  const followingOf = await followingOfAll(executor, item.id, recipients);
  for (const agentId of recipients) {
    const mine = byAgent.get(agentId)!;
    const notice: ArtifactAgentNotice = {
      artifact: { id: item.id, title: item.title },
      reason: "your_file_changed",
      following: followingOf(agentId),
      comments: null,
      version: {
        number: version.number,
        publisher: name({ type: version.publisherType, id: version.publisherId }),
        note: version.note,
        yourFiles: mine.paths.sort(),
        yourVersion: mine.version,
      },
    };
    queued.push(await queueNotice(executor, input.outbox, item, agentId, notice, input.now));
  }
  return { queued, notified: recipients.map((agentId) => ({ actor: name(agentRef(agentId)), reason: "your_file_changed" as const })) };
}

/**
 * A new version's announcement notices (#proj-chat:#29), in its transaction:
 * when the Artifact is the announcement of a live channel whose server has
 * channel_announcement_v0 on (core decides, platform/channelAnnouncements),
 * each agent member of that channel, not the publisher, not one already told
 * of this version (`told`), that may be told of the Artifact, gets
 * `subscribed` with `channelAnnouncement`. Queued only, never pushed (sendQueued is
 * not called for them), as a rename's: handed over with the agent's next
 * pull, through the delivery guard. Returns the agents told.
 */
export async function noticeChannelAnnouncement(input: {
  executor: DatabaseExecutor;
  outbox: ArtifactNoticeOutbox;
  item: ArtifactItemRow;
  version: ArtifactVersionRow;
  now: Date;
  /** Agents already told of this version (noticeVersion's). */
  told: readonly string[];
  /** Agents not told besides the publisher: an assistant publishing as its owner (publish.ts) isn't told of its own push. */
  except?: readonly string[];
}): Promise<string[]> {
  const { executor, item, version } = input;
  if (item.homeKind !== "conversation" || item.homeChannelId === null) return [];
  const audience = (await channelAnnouncementAudience(item.id, item.homeChannelId, executor))
    .filter((entry) => !(version.publisherType === "agent" && entry.agentId === version.publisherId) && !input.told.includes(entry.agentId) && !(input.except ?? []).includes(entry.agentId));
  if (audience.length === 0) return [];
  const seeing = await agentsWhoSee(executor, item, audience.map((entry) => entry.agentId));
  const recipients = audience.filter((entry) => seeing.has(entry.agentId)).sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  if (recipients.length === 0) return [];
  const publisher = { type: version.publisherType, id: version.publisherId };
  const name = await namer([publisher], executor);
  for (const { agentId, channel } of recipients) {
    const notice: ArtifactAgentNotice = {
      artifact: { id: item.id, title: item.title },
      reason: "subscribed",
      following: null,
      comments: null,
      version: null,
      channelAnnouncement: { channel, publisher: name(publisher), number: version.number, note: version.note },
    };
    await queueNotice(executor, input.outbox, item, agentId, notice, input.now);
  }
  return recipients.map((entry) => entry.agentId);
}

/** Stop following: drop the agent's legacy pending_notices row too (a mention still reaches it). */
export async function dropPendingNotice(executor: DatabaseExecutor, itemId: string, agentId: string): Promise<void> {
  await executor.delete(artifactPendingNotices).where(and(eq(artifactPendingNotices.itemId, itemId), eq(artifactPendingNotices.agentId, agentId)));
}

/**
 * The flush job, legacy (#55): followers' notices are no longer batched, so
 * nothing writes pending_notices; this only drains the rows queued before
 * that, until none can remain, then goes with the table (and
 * dropPendingNotice). Due rows become one notice each.
 * Rows are taken FOR UPDATE SKIP LOCKED (concurrent flushes split them) and
 * deleted in the same transaction. A batch whose agent stopped following, can
 * no longer see the Artifact, or whose server has the flag off sends nothing;
 * nor one whose comments were all deleted. The notice carries the count and
 * the newest few. Each row is handled in its own savepoint: one that fails is
 * rolled back, logged and dropped (its comments stay readable as unseen),
 * and the others still go out.
 */
export async function flushDueArtifactNotices(
  outbox: ArtifactNoticeOutbox,
  opts: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? currentDate();
  const queued = await getDb().transaction(async (tx) => {
    const due = await tx.select().from(artifactPendingNotices)
      .where(lte(artifactPendingNotices.dueAt, now))
      .orderBy(asc(artifactPendingNotices.dueAt))
      .limit(opts.limit ?? FLUSH_LIMIT)
      .for("update", { skipLocked: true });
    // One answer for the deployment (apiCommon artifactsEnabled): read once.
    let on: boolean | undefined;
    const out: QueuedNotice[] = [];
    const flushOne = async (sp: DatabaseExecutor, row: (typeof due)[number]): Promise<QueuedNotice | null> => {
      const [item] = await sp.select().from(artifactItems).where(eq(artifactItems.id, row.itemId)).limit(1);
      if (!item) return null;
      on ??= await artifactsEnabled(item.serverId, { executor: sp });
      if (!on) return null;
      if ((await followingAgents(sp, item.id, [row.agentId])).length === 0) return null;
      if (!(await agentsWhoSee(sp, item, [row.agentId])).has(row.agentId)) return null;
      const comments = await sp.select().from(artifactComments)
        .where(and(liveComment(item.id), inArray(artifactComments.id, row.commentIds)))
        .orderBy(asc(artifactComments.position));
      if (comments.length === 0) return null;
      const notice: ArtifactAgentNotice = {
        artifact: { id: item.id, title: item.title },
        reason: "subscribed",
        following: (await followingOfAll(sp, item.id, [row.agentId]))(row.agentId),
        comments: { count: comments.length, latest: await excerpts(sp, comments.slice(-AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN)) },
        version: null,
      };
      return queueNotice(sp, outbox, item, row.agentId, notice, now);
    };
    for (const row of due) {
      // The row goes either way: a batch that fails is not retried every 30 s.
      await dropPendingNotice(tx, row.itemId, row.agentId);
      try {
        const queued = await tx.transaction((sp) => flushOne(sp, row));
        if (queued) out.push(queued);
      } catch (error) {
        console.error("[artifacts] notice batch failed; dropped", { itemId: row.itemId, agentId: row.agentId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  });
  await sendQueued(outbox, queued);
  return queued.length;
}
