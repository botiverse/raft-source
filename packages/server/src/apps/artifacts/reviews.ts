// Reviews (S8): several comments on an Artifact posted at once, all or
// none, with an optional summary posted last (a comment on the whole
// Artifact). A person reviews from their drafts (webReviews.ts); an agent in
// one call, with no drafts (`POST …/:artifact/reviews`, below). Both go
// through submitReview, which writes them (writeReview) in the transaction
// that locked the item row:
//
// - each comment at the item's next position, in order, the summary last,
//   all of them naming the review (`comments.review_id`), and the review row
//   (`reviews`: its author, the attempt's key and the request's digest, its
//   summary);
// - ONE object event, `review`, for everyone any of its comments mentions
//   (`mentioned`) and the Artifact's followers (`following` / `owner`): one
//   Activity update per person, however many comments;
// - the author follows the Artifact (unless it stopped), and its read
//   position moves over the review when nothing unseen lies before it;
// - ONE notice per agent for the whole review, at once (notices.ts
//   noticeReview).
//
// Every comment is checked as a single comment is (the same checks, the same
// codes); the first that fails refuses the whole review with that
// comment's own refusal, its place added to `details`, and nothing is
// written. Its images are hung on each comment in the same transaction, once
// its id is chosen (`attach`): an agent's claimed from its own uploads (one
// that isn't refuses the review, 400 IMAGE_NOT_FOUND with its place), a
// person's moved from their drafts (webReviews.ts). What a concurrent change
// can undo (a reply's parent deleted, a version revoked, the Artifact gone
// or out of sight) is checked again under the item's lock. A repeat of the same attempt (its key) answers the review
// it wrote; the same key for another request is refused.
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_MAX_COMMENT_CHARS,
  AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS,
  asArtifactReviewId,
  currentDate,
  RAFT_HINTS,
  REFUSAL_ERROR_MAX_CHARS,
  type AgentApiArtifactNotNotifiedReason,
  type AgentApiArtifactParams,
  type AgentApiArtifactReview,
  type AgentApiArtifactReviewBody,
  type AgentApiArtifactReviewCreated,
  type ArtifactCommentImage,
} from "@botiverse/raft-shared";
import { announceObjectEvents } from "../../platform/activity";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import type { ServerViewActor } from "../../platform/visibility";
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
  artifactRef,
  commentActors,
  currentVersionOf,
  fail,
  imageNotClaimable,
  json,
  liveComment,
  mayNotTakePart,
  namer,
  notVisible,
  readableVersion,
  readPositionOf,
  resolveVisibleItem,
  takesPartIn,
  versionNotFound,
  viewActor,
} from "./apiCommon";
import { checkCommentFields, checkFileIn, evaluateHold, held, newCommentId, resolveMentions, type CommentHold } from "./comments";
import { claimCommentImages, commentImagesPart } from "./commentImages";
import { followerRecipients, recordArtifactEvent } from "./events";
import { reopenThreadsOf } from "./resolutions";
import { autoSubscribe, followersOf, noticeReview, sendQueued, type NotifiedAgent, type QueuedNotice } from "./notices";
import {
  artifactComments,
  artifactItems,
  artifactReviews,
  artifactVersions,
  type ArtifactCommentAnchor,
  type ArtifactCommentRow,
  type ArtifactItemRow,
  type ArtifactReviewRow,
  type ArtifactVersionRow,
} from "./schema";
import { canViewArtifacts } from "./visibility";

/** One comment of a review, checked: what writeReview stores. */
export interface ReviewComment {
  version: ArtifactVersionRow;
  path: string | null;
  anchor: ArtifactCommentAnchor | null;
  replyTo: string | null;
  body: string;
  /** Who it mentions, as stored. */
  mentions: ArtifactActorRef[];
  /** The agents among them to tell (not the author). */
  mentionedAgents: readonly string[];
}

export interface WrittenReview {
  review: ArtifactReviewRow;
  /** In order, the summary not among them. */
  comments: ArtifactCommentRow[];
  summary: ArtifactCommentRow | null;
  queued: QueuedNotice[];
  notified: NotifiedAgent<"mentioned" | "subscribed">[];
  told: Array<{ agentId: string; reason: "mentioned" | "subscribed" }>;
  cannotSee: Set<string>;
  newlySubscribed: boolean;
  /** Its one object event, announced to people's Activity after the commit. */
  eventId: string;
}

/** sha256 of a request's canonical JSON: a retry under the same key is told from another review. */
export function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The review this author already wrote on the item under `clientKey`, if any. */
export async function reviewByKey(executor: DatabaseExecutor, itemId: string, author: ArtifactActorRef, clientKey: string): Promise<ArtifactReviewRow | null> {
  const [row] = await executor.select().from(artifactReviews).where(and(
    eq(artifactReviews.itemId, itemId),
    eq(artifactReviews.authorType, author.type),
    eq(artifactReviews.authorId, author.id),
    eq(artifactReviews.clientKey, clientKey),
  )).limit(1);
  return row ?? null;
}

/** A written review's comments that are still there (a replay), in order, and which is its summary. */
export async function reviewComments(executor: DatabaseExecutor, review: ArtifactReviewRow): Promise<{ comments: ArtifactCommentRow[]; summary: ArtifactCommentRow | null }> {
  const rows = await executor.select().from(artifactComments)
    .where(and(liveComment(review.itemId), eq(artifactComments.reviewId, review.id)))
    .orderBy(asc(artifactComments.position));
  return {
    comments: rows.filter((row) => row.id !== review.summaryCommentId),
    summary: rows.find((row) => row.id === review.summaryCommentId) ?? null,
  };
}

/** A comment of the review refused under the lock: its index (the summary's is the comments' count) and what it would answer. */
export interface ReviewRefusal {
  index: number;
  refusal:
    | { status: 404; code: "COMMENT_NOT_FOUND"; error: string; details: { replyTo: string } }
    | { status: 404; code: "VERSION_NOT_FOUND"; error: string; details: { version: number } };
}

/** recheckLocked's sentences, the web's review answers them too (webReviews.ts). */
export const REPLY_GONE_ERROR = "The comment it replies to was deleted while the review was sent, so nothing of the review was posted: drop the reply, or answer another comment, and send it again.";
export const VERSION_GONE_ERROR = "The version the review is on was taken down while it was sent, so nothing of the review was posted: review the current version instead.";

/**
 * Again under the item's lock (which a delete takes too), each comment's
 * reply parent is live and its version readable. Returns the index of the
 * first that isn't and its refusal, or null.
 */
async function recheckLocked(
  tx: DatabaseExecutor,
  itemId: string,
  comments: ReadonlyArray<{ replyTo: string | null; version: ArtifactVersionRow }>,
): Promise<ReviewRefusal | null> {
  for (const [index, comment] of comments.entries()) {
    if (comment.replyTo !== null) {
      const [parent] = await tx.select({ id: artifactComments.id }).from(artifactComments)
        .where(and(liveComment(itemId), eq(artifactComments.id, comment.replyTo))).limit(1);
      if (!parent) return { index, refusal: { status: 404, code: "COMMENT_NOT_FOUND", error: REPLY_GONE_ERROR, details: { replyTo: comment.replyTo } } };
    }
    const [version] = await tx.select({ id: artifactVersions.id }).from(artifactVersions)
      .where(and(readableVersion(itemId), eq(artifactVersions.id, comment.version.id))).limit(1);
    if (!version) return { index, refusal: { status: 404, code: "VERSION_NOT_FOUND", error: VERSION_GONE_ERROR, details: { version: comment.version.number } } };
  }
  return null;
}

/**
 * Hang each comment's images on it, in the review's transaction, once the
 * comments' ids are chosen (`ids`: the comments in order, the summary's
 * last): each comment's images as core stored them, in that order. A
 * refusal thrown here rolls the review back.
 */
export type AttachReviewImages = (tx: DatabaseExecutor, ids: readonly string[]) => Promise<ReadonlyArray<ArtifactCommentImage[]>>;

/**
 * Write a checked review inside the transaction that locked its item
 * (`locked`, FOR UPDATE): the file's header. The summary, when there is one,
 * is posted last, as a comment on the whole Artifact. The caller pushes the
 * queued notices and announces the event after the commit.
 */
async function writeReview(tx: DatabaseExecutor, input: {
  outbox: ArtifactNoticeOutbox;
  locked: ArtifactItemRow;
  author: ArtifactActorRef;
  readPosition: number | null;
  comments: readonly ReviewComment[];
  summary: ReviewComment | null;
  version: number;
  clientKey: string | null;
  digest: string;
  attach: AttachReviewImages | undefined;
  now: Date;
}): Promise<WrittenReview> {
  const { locked, author, now } = input;
  const all = input.summary ? [...input.comments, input.summary] : [...input.comments];
  const ids = all.map(() => newCommentId());
  const images = input.attach ? await input.attach(tx, ids) : all.map(() => []);
  const [review] = await tx.insert(artifactReviews).values({
    id: randomUUID(),
    itemId: locked.id,
    authorType: author.type,
    authorId: author.id,
    version: input.version,
    clientKey: input.clientKey,
    requestDigest: input.digest,
    createdAt: now,
  }).returning();
  const rows = await tx.insert(artifactComments).values(all.map((comment, index) => ({
    id: ids[index]!,
    itemId: locked.id,
    versionId: comment.version.id,
    path: comment.path,
    anchor: comment.anchor,
    replyTo: comment.replyTo,
    authorType: author.type,
    authorId: author.id,
    body: comment.body,
    mentions: comment.mentions,
    images: images[index] ?? [],
    position: locked.lastPosition + index + 1,
    createdAt: now,
    reviewId: review!.id,
  }))).returning();
  // Its replies reopen the resolved threads they are in (#249).
  await reopenThreadsOf(tx, locked.id, all.map((comment) => comment.replyTo));
  rows.sort((a, b) => a.position - b.position);
  const summary = input.summary ? rows[rows.length - 1]! : null;
  const written = summary ? (await tx.update(artifactReviews).set({ summaryCommentId: summary.id }).where(eq(artifactReviews.id, review!.id)).returning())[0]! : review!;
  const last = locked.lastPosition + rows.length;
  // A review is activity: the list orders by it.
  const [updated] = await tx.update(artifactItems).set({ lastPosition: last, updatedAt: sql`now()` }).where(eq(artifactItems.id, locked.id)).returning();
  // Its own comments are nothing new to the author; only moved over when nothing unseen lies before them.
  if ((input.readPosition ?? 0) >= locked.lastPosition) await advanceReadPosition(author, locked.id, last, tx);
  // One event for the whole review: those any of it mentions, then the followers.
  const following = await followersOf(tx, locked.id);
  const event = await recordArtifactEvent(tx, {
    item: locked,
    eventKind: "review",
    actor: author,
    data: { review: written.id, position: last, comment: rows[0]!.id, version: all[0]!.version.number, comments: rows.length },
    recipients: [
      ...all.flatMap((comment) => comment.mentions).map((actor) => ({ actor, reason: "mentioned" as const })),
      ...followerRecipients(locked, following),
    ],
  });
  const newlySubscribed = await autoSubscribe(tx, locked.id, author, "commented");
  const entries = rows.map((row, index) => ({ row, mentioned: all[index]!.mentionedAgents }));
  const noticed = await noticeReview({
    executor: tx,
    outbox: input.outbox,
    item: updated!,
    review: { id: written.id, version: input.version, reviewer: author },
    comments: summary ? entries.slice(0, -1) : entries,
    summary: summary ? entries[entries.length - 1]! : null,
    now,
    following,
  });
  return { review: written, comments: summary ? rows.slice(0, -1) : rows, summary, newlySubscribed, eventId: event.id, ...noticed };
}

export type ReviewOutcome =
  | { kind: "written"; written: WrittenReview }
  | { kind: "replay"; review: ArtifactReviewRow }
  | { kind: "held"; hold: CommentHold }
  | { kind: "refused"; refused: ReviewRefusal }
  | { kind: "gone" };

/**
 * Submit a checked review, the one rule for a person's (webReviews.ts) and
 * an agent's (below). In one transaction, the item row locked: the Artifact
 * still live and seen by `viewer` (else `gone`, the caller's one 404); the
 * attempt's key again (`replay`); the caller's hold (an agent's unseen
 * changes: `held`, the read position moved in this transaction); the
 * caller's claim (a person's drafts, unchanged); each reply's parent and
 * version again (`refused`); then the review written, each comment's images
 * attached (`attach`), and the claim released. After the commit the notices
 * are pushed and people's Activity told.
 */
export async function submitReview(input: {
  item: ArtifactItemRow;
  viewer: ServerViewActor;
  author: ArtifactActorRef;
  comments: readonly ReviewComment[];
  summary: ReviewComment | null;
  /** The version the review is on (ArtifactReviewRow.version). */
  version: number;
  key: { clientKey: string | null; digest: string };
  outbox: ArtifactNoticeOutbox;
  now: Date;
  hold?: (tx: DatabaseExecutor, locked: ArtifactItemRow, readPosition: number | null) => Promise<CommentHold | null>;
  claim?: (tx: DatabaseExecutor) => Promise<void>;
  /** Each comment's images (AttachReviewImages); none without it. */
  attach?: AttachReviewImages;
  release?: (tx: DatabaseExecutor) => Promise<void>;
}): Promise<ReviewOutcome> {
  const { item, author } = input;
  const outcome = await getDb().transaction(async (tx): Promise<ReviewOutcome> => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, item.id)).for("update");
    if (!locked || locked.deletedAt || locked.revokedAt) return { kind: "gone" };
    // The same attempt finished while this one waited for the lock.
    if (input.key.clientKey !== null) {
      const earlier = await reviewByKey(tx, item.id, author, input.key.clientKey);
      if (earlier) return { kind: "replay", review: earlier };
    }
    // Still sees it now: its home may have narrowed since, or the author left it.
    if (!(await canViewArtifacts(input.viewer, [locked], { executor: tx }))[0]) return { kind: "gone" };
    const readPosition = await readPositionOf(author, locked.id, tx);
    const hold = input.hold ? await input.hold(tx, locked, readPosition) : null;
    if (hold) return { kind: "held", hold };
    await input.claim?.(tx);
    const refused = await recheckLocked(tx, locked.id, input.summary ? [...input.comments, input.summary] : input.comments);
    if (refused) return { kind: "refused", refused };
    const written = await writeReview(tx, {
      outbox: input.outbox,
      locked,
      author,
      readPosition,
      comments: input.comments,
      summary: input.summary,
      version: input.version,
      clientKey: input.key.clientKey,
      digest: input.key.digest,
      attach: input.attach,
      now: input.now,
    });
    await input.release?.(tx);
    return { kind: "written", written };
  });
  if (outcome.kind === "written") {
    await sendQueued(input.outbox, outcome.written.queued);
    await announceObjectEvents([outcome.written.eventId]);
  }
  return outcome;
}

// ---- the agent API: POST /artifacts/:artifact/reviews --------------------------

/** `notNotified` of a review: each name once over the whole review, in the order written. */
function uniqueNotNotified(entries: ReadonlyArray<{ name: string; reason: AgentApiArtifactNotNotifiedReason }>): Array<{ name: string; reason: AgentApiArtifactNotNotifiedReason }> {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
}

/** A review as the agent API answers it (agentApiArtifactReviewSchema): its summary in full, while live. */
export async function agentReview(review: ArtifactReviewRow, summary: ArtifactCommentRow | null): Promise<AgentApiArtifactReview> {
  const author = { type: review.authorType, id: review.authorId };
  const name = await namer([author]);
  return { id: asArtifactReviewId(review.id), author: name(author), version: review.version, body: summary?.body ?? null, createdAt: review.createdAt.toISOString() };
}

/**
 * A comment's refusal as the review's: its sentence after the comment's place
 * ("Comment 2 of 5: …", and that nothing was posted), its step kept, its place
 * added to `details` (`index`, and its `path` as sent).
 */
function atPlace(refused: ArtifactApiError, index: number, total: number, place: Record<string, unknown>): ArtifactApiError {
  const { status, body } = refused;
  const placed = `Comment ${index + 1} of ${total} of the review, nothing of which was posted: ${body.error}`;
  return fail(status, {
    code: body.code,
    error: placed.length <= REFUSAL_ERROR_MAX_CHARS ? placed : body.error,
    ...(body.next ? { next: body.next } : body.suggestedNextAction ? { suggestedNextAction: body.suggestedNextAction } : {}),
    details: { ...body.details, ...place },
  });
}

/** Run one comment's checks; its refusal becomes the review's, its place added (`index`, and its `path` as sent). */
async function atComment<T>(index: number, total: number, path: string | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ArtifactApiFailure)) throw error;
    throw new ArtifactApiFailure(atPlace(error.result, index, total, { index, path }));
  }
}

export function createReviewOperations() {
  return {
    /**
     * An agent's review, in this order: the flag and the Artifact (the one
     * 404), an agent of its server or its joint (403 FORBIDDEN); at most
     * AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS comments (400
     * TOO_MANY_COMMENTS); the review's version (404 VERSION_NOT_FOUND) and
     * summary (FIELD_TOO_LONG, TOO_MANY_MENTIONS), with no `index`; each
     * comment as comments.ts checks one (its own code, `index` and `path`
     * added); then submitReview, held once over every file commented on (a
     * comment on the whole Artifact: anything new from others).
     */
    review: (
      agent: ArtifactAgent,
      params: AgentApiArtifactParams,
      body: AgentApiArtifactReviewBody,
      outbox: ArtifactNoticeOutbox,
    ): Promise<ArtifactApiResult<AgentApiArtifactReviewCreated>> => answer(async () => {
      const item = await resolveVisibleItem(agent, params.artifact);
      if (!(await takesPartIn(viewActor(agent), item))) return mayNotTakePart("review it");
      // A retry of a review this agent posted under the key answers it, before anything that may have changed since.
      const { idempotencyKey, ...request } = body;
      const key = { clientKey: idempotencyKey ?? null, digest: requestDigest(request) };
      const replay = async (review: ArtifactReviewRow): Promise<ArtifactApiResult<AgentApiArtifactReviewCreated>> => {
        if (review.requestDigest !== key.digest) {
          return fail(409, {
            code: "IDEMPOTENCY_KEY_REUSED",
            error: "A review was already posted under that idempotencyKey, and this request differs from it, so nothing more was posted: see the posted review among the comments, and use a new key only to post a second one.",
            next: RAFT_HINTS.artifactComments({ artifact: item.id, all: true }),
          });
        }
        const { comments: rows, summary: summaryRow } = await reviewComments(getDb(), review);
        const answer = await agentReview(review, summaryRow);
        // Its comments may have been resolved since (#249): name their resolvers too.
        const name = await namer(commentActors(rows));
        return json<AgentApiArtifactReviewCreated>({
          artifact: await artifactRef(item),
          review: answer,
          comments: rows.map((row) => agentComment(row, review.version, name)),
          notified: [],
          notNotified: [],
          newlySubscribed: false,
        });
      };
      if (key.clientKey !== null) {
        const earlier = await reviewByKey(getDb(), item.id, agentActor(agent), key.clientKey);
        if (earlier) return replay(earlier);
      }
      if (body.comments.length > AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS) {
        return fail(400, {
          code: "TOO_MANY_COMMENTS",
          error: `A review holds at most ${AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS} comments and this one has ${body.comments.length}, so nothing was posted: send the first ${AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS} as one review and the rest as another, or merge comments on the same file.`,
          details: { count: body.comments.length, limit: AGENT_API_ARTIFACT_MAX_REVIEW_COMMENTS },
        });
      }
      const current = await currentVersionOf(item);
      let version: ArtifactVersionRow | null = current;
      if (body.version !== undefined) {
        [version = null] = await getDb().select().from(artifactVersions)
          .where(and(readableVersion(item.id), eq(artifactVersions.number, body.version))).limit(1);
      }
      if (!version) return versionNotFound(item.id, body.version ?? null, current?.number ?? null);
      const summaryText = body.body?.trim() || null;
      if (summaryText !== null && Array.from(summaryText).length > AGENT_API_ARTIFACT_MAX_COMMENT_CHARS) {
        return fail(400, {
          code: "FIELD_TOO_LONG",
          error: `The review's summary can be at most ${AGENT_API_ARTIFACT_MAX_COMMENT_CHARS} characters, so nothing was posted: shorten it, or move part of it into a comment of the review.`,
          details: { field: "body", limit: AGENT_API_ARTIFACT_MAX_COMMENT_CHARS },
        });
      }

      const notNotified: Array<{ name: string; reason: AgentApiArtifactNotNotifiedReason }> = [];
      const handles = new Map<string, string>();
      const checked = async (text: string, fields: { path: string | null; anchor: ReviewComment["anchor"]; replyTo: string | null }): Promise<ReviewComment> => {
        const mentions = await resolveMentions(agent, item, text);
        notNotified.push(...mentions.notNotified);
        for (const agentId of mentions.agents) handles.set(agentId, mentions.handleOf(agentId));
        return { version: version!, ...fields, body: text, mentions: mentions.stored, mentionedAgents: mentions.agents };
      };
      const comments: ReviewComment[] = [];
      // Each comment's image ids as sent, by its index (the summary has none).
      const imageIds: Array<readonly string[]> = [];
      for (const [index, comment] of body.comments.entries()) {
        comments.push(await atComment(index, body.comments.length, comment.path ?? null, async () => {
          const { text, path, anchor, images } = await checkCommentFields(item, comment);
          await checkFileIn(version!, path);
          imageIds.push(images);
          return checked(text, { path, anchor, replyTo: comment.replyTo ?? null });
        }));
      }
      const summary = summaryText === null ? null : await checked(summaryText, { path: null, anchor: null, replyTo: null });
      // Held once over every file the comments are on; one on the whole Artifact counts everything new.
      const paths = comments.some((comment) => comment.path === null) ? null : [...new Set(comments.map((comment) => comment.path!))];

      const author = agentActor(agent);
      const outcome = await submitReview({
        item,
        viewer: viewActor(agent),
        author,
        comments,
        summary,
        version: version.number,
        key,
        outbox,
        now: currentDate(),
        hold: async (tx, locked, readPosition) => {
          const hold = await evaluateHold(tx, agent, locked, paths, body.seen ?? readPosition ?? 0);
          if (hold) await advanceReadPosition(author, locked.id, hold.through, tx);
          return hold;
        },
        // Only this agent's own unused uploads to this Artifact; the first that isn't refuses the review, with its place.
        attach: async (tx, ids) => {
          const attached: ArtifactCommentImage[][] = [];
          for (const [index, id] of ids.entries()) {
            const claimed = await claimCommentImages(tx, item.id, author, imageIds[index] ?? [], commentImagesPart(id));
            if (claimed.kind === "not_found") {
              throw new ArtifactApiFailure(atPlace(fail(400, imageNotClaimable(claimed.fileId)), index, body.comments.length, { index, path: body.comments[index]!.path ?? null }));
            }
            attached.push(claimed.images);
          }
          return attached;
        },
      });
      switch (outcome.kind) {
        case "gone": return notVisible();
        case "replay": return replay(outcome.review);
        case "held": return held(item, outcome.hold, "review");
        case "refused": {
          const { index, refusal } = outcome.refused;
          // The version is the review's: refused as the review's, without an index.
          const place = refusal.code === "VERSION_NOT_FOUND" || index >= comments.length ? {} : { index, path: body.comments[index]!.path ?? null };
          return fail(refusal.status, {
            code: refusal.code,
            error: refusal.error,
            ...(refusal.code === "VERSION_NOT_FOUND" ? { next: RAFT_HINTS.artifactRead({ artifact: item.id }) } : { next: RAFT_HINTS.artifactComments({ artifact: item.id, all: true }) }),
            details: { ...refusal.details, ...place },
          });
        }
        case "written": break;
      }
      const { written } = outcome;
      const review = await agentReview(written.review, written.summary);
      return json<AgentApiArtifactReviewCreated>({
        artifact: await artifactRef(item),
        review,
        comments: written.comments.map((row) => agentComment(row, version!.number, () => review.author)),
        notified: written.notified,
        notNotified: uniqueNotNotified([
          ...notNotified,
          ...[...written.cannotSee].map((agentId) => ({ name: handles.get(agentId) ?? agentId, reason: "cannot_see" as const })),
        ]),
        newlySubscribed: written.newlySubscribed,
      }, 201);
    }),
  };
}
