// Batch comments from the web (S8): a person's review drafts and submitting
// them as one review. Contract: shared webArtifactsContract.ts
// (`reviewDrafts`, `reviewDraft`, `reviewSubmit`), types in
// workspaceArtifacts.ts. A submit goes through reviews.ts submitReview, the
// one function an agent's review goes through too, so the rules are one.
//
// Drafts are kept on the Server and seen only by their author: every route
// finds a draft by its id, the Artifact and the reader together, so someone
// else's draft answers exactly as one that doesn't exist (404
// DRAFT_NOT_FOUND). Each route first checks the flag and the Artifact (one
// 404 NOT_VISIBLE), then that the reader is a person of its server (403
// FORBIDDEN), as commenting does. A draft is checked as a comment is when
// saved (webComments.ts checkWebComment: the same codes) and kept as sent:
// its parts with mentions as actors, its target, the version's number. A
// draft may reply (`replyTo`, xxchan #proj-workspace:f07141a9): to a live
// comment of the same Artifact (404 COMMENT_NOT_FOUND, as a reply's), with
// no place of its own (`target` `{ scope: "artifact" }`, else 400
// INVALID_REQUEST); it is checked, and posted, as that reply would be, at its
// thread's place. At most ARTIFACT_DRAFT_MAX_PER_ARTIFACT per person
// and Artifact (409 DRAFT_LIMIT), counted under an advisory lock per person
// and Artifact. A draft not changed for ARTIFACT_DRAFT_TTL_DAYS is gone: left
// out of every route at once, deleted by the hourly maintenance
// (purgeExpiredArtifactDrafts); `expiresAt` lets the web warn from
// ARTIFACT_DRAFT_WARN_AFTER_DAYS.
//
// A draft's images (commentImages.ts) are claimed when it is made, in the
// transaction that inserts it (each the reader's own unused upload to this
// Artifact, else 400 IMAGE_NOT_FOUND and no draft), hung on `draft:<id>`:
// core lets only their uploader read them. An edit keeps them. Deleting the
// draft, discarding them all and the expiry purge let them go in the
// transaction that deletes the drafts (the bytes after the commit);
// submitting moves them to the posted comment's part.
//
// Submitting (`POST …/review/submit { version, summary, clientKey? }`), in
// this order:
// 1. the flag, the Artifact, a person of its server;
// 2. the body (400 INVALID_REQUEST); with `clientKey`, a review this reader
//    already wrote here under it answers it (200), or 409 CLIENT_KEY_REUSED
//    when its version or summary differ; `version` readable (404
//    VERSION_NOT_FOUND);
// 3. the reader's live drafts, oldest first (none: 409 NO_DRAFTS), each
//    checked again as a comment would be now, then the summary (a comment on
//    the whole Artifact at `version`): the first refused answers 422
//    `rejected` (ArtifactReviewRejected), naming it (`draftId`, null for the
//    summary) with the code and details a comment would have got;
// 4. reviews.ts submitReview, the item row locked: the key again, the reader
//    still sees the Artifact (else the one 404), the drafts unchanged since
//    step 3 (409 DRAFTS_CHANGED), each draft's version again (422
//    `rejected` VERSION_NOT_FOUND, its details as step 3's), each reply
//    draft's comment still there (422 `rejected` COMMENT_NOT_FOUND naming
//    the draft, as in step 3: deleted since, the draft is refused, never
//    posted elsewhere); the review
//    written, each draft's images moved to its comment, and the drafts
//    deleted in the same transaction; after the commit, the notices pushed
//    and Activity told.
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ARTIFACT_DRAFT_MAX_PER_ARTIFACT,
  ARTIFACT_DRAFT_TTL_DAYS,
  asArtifactCommentDraftId,
  asArtifactCommentId,
  asObjectFileId,
  currentDate,
  type ArtifactCommentDraft,
  type ArtifactCommentImage,
  type ArtifactReviewRejected,
  type ArtifactReviewSubmitted,
  type ArtifactWebCommentInput,
  type ArtifactWebReviewDrafts,
  type ArtifactWebReviewDraftSaved,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { currentVersionOf, json, readableVersion, versionNumbers, type ArtifactApiEmpty, type ArtifactApiJson, type ArtifactNoticeOutbox } from "./apiCommon";
import { requestDigest, reviewByKey, reviewComments, submitReview, type ReviewComment } from "./reviews";
import { claimCommentImages, draftImagesPart, moveDraftImages, releasedImagesGone, releaseImages } from "./commentImages";
import { artifactCommentDrafts, artifactVersions, type ArtifactCommentDraftRow, type ArtifactCommentRow, type ArtifactItemRow, type ArtifactReviewRow } from "./schema";
import { checkWebComment, requireTakesPart, type CheckedWebComment } from "./webComments";
import {
  actorsOfComments,
  answerWeb,
  ArtifactWebFailure,
  profiler,
  readerActor,
  readerViewActor,
  refuse,
  visibleItemFor,
  webBadBody,
  webComment,
  webCommentAnchorSchema,
  webFail,
  webImageNotClaimable,
  webNotVisible,
  webVersionNotFound,
  type ArtifactWebApiError,
  type ArtifactWebReader,
} from "./webCommon";

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = ARTIFACT_DRAFT_TTL_DAYS * DAY_MS;
/** Expired drafts one maintenance run deletes. */
const PURGE_BATCH = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const partsSchema = z.array(z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("mention"), actor: z.object({ type: z.enum(["user", "agent"]), id: z.string().min(1).max(64) }) }),
])).max(2000);
const editSchema = z.object({ body: partsSchema });
const submitSchema = z.object({
  version: z.number().int().positive(),
  summary: partsSchema.nullable(),
  clientKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

/** Every code a review's rejection can carry (ArtifactReviewRejected): a comment's refusal with another code is answered as it is. */
const REJECTION_CODES: Record<ArtifactReviewRejected["code"], true> = {
  INVALID_REQUEST: true,
  INVALID_PATH: true,
  FIELD_TOO_LONG: true,
  VERSION_NOT_FOUND: true,
  FILE_NOT_FOUND: true,
  TOO_MANY_MENTIONS: true,
  MENTION_NOT_VISIBLE: true,
  COMMENT_NOT_FOUND: true,
};
const isRejectionCode = (code: string): code is ArtifactReviewRejected["code"] => Object.hasOwn(REJECTION_CODES, code);

/** Drafts changed before this are gone. */
const expiryCutoff = (now: Date) => new Date(now.getTime() - TTL_MS);

/** The reader's live (unexpired) drafts on the item. */
const ownDrafts = (reader: ArtifactWebReader, itemId: string, now: Date) => and(
  eq(artifactCommentDrafts.itemId, itemId),
  eq(artifactCommentDrafts.authorId, reader.userId),
  gte(artifactCommentDrafts.updatedAt, expiryCutoff(now)),
)!;

// One answer for a draft that isn't there, expired, or isn't the reader's: drafts are their author's alone.
const draftNotFound = (): never => refuse(404, { code: "DRAFT_NOT_FOUND", error: "That draft isn't there any more (it may have been posted, deleted or expired): reload the review drafts." });

/** A stored draft as the comment input it was saved from (its images by id: they are its own already). */
function inputOf(row: Pick<ArtifactCommentDraftRow, "version" | "path" | "anchor" | "body" | "replyTo" | "images">): ArtifactWebCommentInput {
  const anchor = row.anchor === null ? null : webCommentAnchorSchema.safeParse(row.anchor);
  return {
    body: row.body,
    version: row.version,
    target: row.path === null ? { scope: "artifact" } : { scope: "file", path: row.path, anchor: anchor?.success ? anchor.data : null },
    replyTo: row.replyTo === null ? null : asArtifactCommentId(row.replyTo),
    ...(row.images.length === 0 ? {} : { images: row.images.map((image) => asObjectFileId(image.fileId)) }),
  };
}

/**
 * A draft input as the comment input it is checked as: `replyTo` absent is
 * none (older clients send none). A reply takes its thread's place, so its
 * target is the whole Artifact (400 INVALID_REQUEST otherwise).
 */
function asCommentInput(rawBody: unknown): unknown {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) return rawBody;
  const body = rawBody as { replyTo?: unknown; target?: unknown };
  const replyTo = body.replyTo ?? null;
  if (replyTo !== null && !(typeof body.target === "object" && body.target !== null && (body.target as { scope?: unknown }).scope === "artifact")) {
    refuse(400, { code: "INVALID_REQUEST", error: "A reply draft takes its thread's place, so its target is the whole artifact ({ scope: \"artifact\" }): reload the page and write the reply again." });
  }
  return { ...rawBody, replyTo };
}

/** Drafts as the web reads them, names filled in, in one profile lookup. */
async function webDrafts(rows: readonly ArtifactCommentDraftRow[]): Promise<ArtifactCommentDraft[]> {
  const actorOf = await profiler(rows.flatMap((row) => row.body.flatMap((part) => (part.type === "mention" ? [part.actor] : []))));
  return rows.map((row) => ({
    id: asArtifactCommentDraftId(row.id),
    version: row.version,
    target: inputOf(row).target,
    body: row.body.map((part) => (part.type === "text" ? part : { type: "mention" as const, actor: actorOf(part.actor) })),
    replyTo: row.replyTo === null ? null : asArtifactCommentId(row.replyTo),
    ...(row.images.length === 0 ? {} : { images: row.images.map((image) => ({ ...image })) }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: new Date(row.updatedAt.getTime() + TTL_MS).toISOString(),
  }));
}

/** What a draft row keeps of a checked input: the input as sent. */
function storedOf(checked: CheckedWebComment) {
  const { input } = checked;
  return {
    version: input.version,
    path: input.target.scope === "file" ? input.target.path : null,
    anchor: input.target.scope === "file" && input.target.anchor !== null ? { type: input.target.anchor.type, data: { ...input.target.anchor.data } } : null,
    body: input.body,
    replyTo: input.replyTo,
  };
}

/**
 * A comment's refusal as a review's rejection, naming the draft (null: the
 * summary). Its details are the refusal's as checkWebComment makes them, in
 * ArtifactWebErrorDetails' shape for its code (the web's error answers are
 * not typed per code: this is where they become so, pinned by
 * reviews.api.test.ts). A code no comment refusal has is no rejection: the
 * failure is answered as it is.
 */
function rejected(draftId: string | null, failure: ArtifactWebFailure): ArtifactApiJson<ArtifactReviewRejected> {
  const { code, error, details } = failure.result.body;
  if (!isRejectionCode(code)) throw failure;
  return json({
    status: "rejected",
    draftId: draftId === null ? null : asArtifactCommentDraftId(draftId),
    code,
    error,
    ...(details ? { details } : {}),
  } as ArtifactReviewRejected, 422);
}

/**
 * Let go of the images of deleted drafts (`gone`, with their items), in the
 * transaction that deleted them: one release per Artifact (core's files are
 * per object). Hand the answers to releasedImagesGone after the commit.
 */
async function releaseDraftImages(tx: DatabaseExecutor, gone: ReadonlyArray<{ id: string; itemId: string }>) {
  const byItem = new Map<string, string[]>();
  for (const draft of gone) byItem.set(draft.itemId, [...(byItem.get(draft.itemId) ?? []), draftImagesPart(draft.id)]);
  const released = [];
  // fanout-ok: one statement per Artifact among the drafts deleted together (a person's, or one purge batch)
  for (const [itemId, parts] of byItem) released.push(await releaseImages(tx, itemId, parts));
  return released;
}

/** Their bytes, once the drafts' delete committed. */
async function draftImagesGone(released: Awaited<ReturnType<typeof releaseDraftImages>>): Promise<void> {
  for (const answer of released) await releasedImagesGone(answer);
}

/**
 * Delete drafts not changed for ARTIFACT_DRAFT_TTL_DAYS, at most `batch` a
 * run (the hourly maintenance, register.ts), and their images with them.
 * Returns how many went.
 */
export async function purgeExpiredArtifactDrafts(opts: { now?: Date; batch?: number } = {}): Promise<number> {
  const cutoff = expiryCutoff(opts.now ?? currentDate());
  const stale = await getDb().select({ id: artifactCommentDrafts.id }).from(artifactCommentDrafts)
    .where(lt(artifactCommentDrafts.updatedAt, cutoff))
    .orderBy(asc(artifactCommentDrafts.updatedAt))
    .limit(opts.batch ?? PURGE_BATCH);
  if (stale.length === 0) return 0;
  const { gone, released } = await getDb().transaction(async (tx) => {
    const deleted = await tx.delete(artifactCommentDrafts)
      .where(and(inArray(artifactCommentDrafts.id, stale.map((row) => row.id)), lt(artifactCommentDrafts.updatedAt, cutoff)))
      .returning({ id: artifactCommentDrafts.id, itemId: artifactCommentDrafts.itemId });
    return { gone: deleted, released: await releaseDraftImages(tx, deleted) };
  });
  await draftImagesGone(released);
  return gone.length;
}

/** Serialize one person's draft writes on one Artifact (the cap's count). */
async function lockDrafts(tx: DatabaseExecutor, itemId: string, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`artifact-drafts:${itemId}:${userId}`}))`);
}

export function createWebReviewOperations() {
  /** Step 1 of every route: the flag, the Artifact, a person who takes part in it (its server's, or its joint's). */
  async function itemFor(reader: ArtifactWebReader, id: string): Promise<ArtifactItemRow> {
    const item = await visibleItemFor(reader, id);
    await requireTakesPart(reader, item);
    return item;
  }

  /** The reader's live draft by id; someone else's, an expired one or none: 404 DRAFT_NOT_FOUND. */
  async function ownDraft(reader: ArtifactWebReader, item: ArtifactItemRow, draftId: string, now: Date): Promise<ArtifactCommentDraftRow> {
    if (!UUID.test(draftId)) return draftNotFound();
    const [row] = await getDb().select().from(artifactCommentDrafts).where(and(ownDrafts(reader, item.id, now), eq(artifactCommentDrafts.id, draftId))).limit(1);
    return row ?? draftNotFound();
  }

  /** A review's comments as posted (the summary last), as the web reads them. */
  async function posted(comments: readonly ArtifactCommentRow[], summary: ArtifactCommentRow | null, status?: number): Promise<ArtifactApiJson<ArtifactReviewSubmitted>> {
    const rows = summary ? [...comments, summary] : [...comments];
    const actorOf = await profiler(actorsOfComments(rows));
    const numbers = await versionNumbers(rows.map((row) => row.versionId));
    return json<ArtifactReviewSubmitted>({ status: "ok", comments: rows.map((row) => webComment(row, numbers.get(row.versionId) ?? 0, actorOf)) }, status);
  }

  /** A review this reader wrote here under the key: answered again, or the key reused for another review. */
  async function replay(review: ArtifactReviewRow, digest: string): Promise<ArtifactApiJson<ArtifactReviewSubmitted>> {
    if (review.requestDigest !== digest) {
      return refuse(409, { code: "CLIENT_KEY_REUSED", error: "A review was already submitted with this clientKey, and this one differs from it: reload the artifact to see what was posted." });
    }
    const { comments, summary } = await reviewComments(getDb(), review);
    return posted(comments, summary);
  }

  return {
    reviewDrafts: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<ArtifactWebReviewDrafts> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await itemFor(reader, id);
      const rows = await getDb().select().from(artifactCommentDrafts).where(ownDrafts(reader, item.id, currentDate()))
        .orderBy(asc(artifactCommentDrafts.createdAt), asc(artifactCommentDrafts.id));
      return json<ArtifactWebReviewDrafts>({ drafts: await webDrafts(rows) });
    }),

    createReviewDraft: (reader: ArtifactWebReader, id: string, rawBody: unknown): Promise<ArtifactApiJson<ArtifactWebReviewDraftSaved> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await itemFor(reader, id);
      const checked = await checkWebComment(reader, item, asCommentInput(rawBody));
      const now = currentDate();
      const row = await getDb().transaction(async (tx) => {
        await lockDrafts(tx, item.id, reader.userId);
        const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(artifactCommentDrafts).where(ownDrafts(reader, item.id, now));
        if (n >= ARTIFACT_DRAFT_MAX_PER_ARTIFACT) {
          refuse(409, {
            code: "DRAFT_LIMIT",
            error: `You have ${ARTIFACT_DRAFT_MAX_PER_ARTIFACT} review drafts on this artifact, the most it keeps: submit the review, or delete some drafts, before adding more.`,
            details: { limit: ARTIFACT_DRAFT_MAX_PER_ARTIFACT },
          });
        }
        // Its images: only the reader's own unused uploads to this Artifact, hung on the draft (read by the reader alone).
        const id = randomUUID();
        const claimed = await claimCommentImages(tx, item.id, readerActor(reader), checked.images, draftImagesPart(id));
        if (claimed.kind === "not_found") return refuse(400, webImageNotClaimable(claimed.fileId));
        const [inserted] = await tx.insert(artifactCommentDrafts).values({
          id,
          itemId: item.id,
          authorId: reader.userId,
          ...storedOf(checked),
          images: claimed.images,
          createdAt: now,
          updatedAt: now,
        }).returning();
        return inserted!;
      });
      const [draft] = await webDrafts([row]);
      return json<ArtifactWebReviewDraftSaved>({ draft: draft! }, 201);
    }),

    /** Its text and mentions; the place, version and images stay (with images, it may have no text). */
    editReviewDraft: (reader: ArtifactWebReader, id: string, draftId: string, rawBody: unknown): Promise<ArtifactApiJson<ArtifactWebReviewDraftSaved> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await itemFor(reader, id);
      const now = currentDate();
      // Whose it is first: someone else's draft is one that doesn't exist, whatever the body.
      const own = await ownDraft(reader, item, draftId, now);
      const parsed = editSchema.safeParse(rawBody);
      if (!parsed.success) throw new ArtifactWebFailure(webBadBody("{ body: ArtifactCommentDraftInput[\"body\"] }"));
      const checked = await checkWebComment(reader, item, { ...inputOf(own), body: parsed.data.body });
      const [row] = await getDb().update(artifactCommentDrafts).set({ body: storedOf(checked).body, updatedAt: now })
        .where(and(ownDrafts(reader, item.id, now), eq(artifactCommentDrafts.id, own.id))).returning();
      if (!row) return draftNotFound();
      const [draft] = await webDrafts([row]);
      return json<ArtifactWebReviewDraftSaved>({ draft: draft! });
    }),

    deleteReviewDraft: (reader: ArtifactWebReader, id: string, draftId: string): Promise<ArtifactApiEmpty | ArtifactWebApiError> => answerWeb(async () => {
      const item = await itemFor(reader, id);
      if (!UUID.test(draftId)) return draftNotFound();
      // The draft and its images, together.
      const { gone, released } = await getDb().transaction(async (tx) => {
        const deleted = await tx.delete(artifactCommentDrafts)
          .where(and(ownDrafts(reader, item.id, currentDate()), eq(artifactCommentDrafts.id, draftId))).returning({ id: artifactCommentDrafts.id, itemId: artifactCommentDrafts.itemId });
        return { gone: deleted, released: await releaseDraftImages(tx, deleted) };
      });
      if (gone.length === 0) return draftNotFound();
      await draftImagesGone(released);
      return { kind: "empty" as const };
    }),

    /** Discard all: every draft of the reader's on the Artifact, at once, and their images. */
    discardReviewDrafts: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiEmpty | ArtifactWebApiError> => answerWeb(async () => {
      const item = await itemFor(reader, id);
      const released = await getDb().transaction(async (tx) => {
        const deleted = await tx.delete(artifactCommentDrafts).where(and(eq(artifactCommentDrafts.itemId, item.id), eq(artifactCommentDrafts.authorId, reader.userId)))
          .returning({ id: artifactCommentDrafts.id, itemId: artifactCommentDrafts.itemId });
        return releaseDraftImages(tx, deleted);
      });
      await draftImagesGone(released);
      return { kind: "empty" as const };
    }),

    submitReview: (reader: ArtifactWebReader, id: string, rawBody: unknown, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactReviewSubmitted> | ArtifactWebApiError> => answerWeb(async () => {
      // Step 1.
      const item = await itemFor(reader, id);

      // Step 2.
      const parsed = submitSchema.safeParse(rawBody);
      if (!parsed.success) throw new ArtifactWebFailure(webBadBody("an ArtifactReviewSubmitInput"));
      const clientKey = parsed.data.clientKey ?? null;
      // A summary without text is none.
      const summaryParts = parsed.data.summary !== null && parsed.data.summary.some((part) => part.type === "mention" || part.text.trim().length > 0) ? parsed.data.summary : null;
      const digest = requestDigest({ version: parsed.data.version, summary: summaryParts });
      const author = readerActor(reader);
      const earlier = clientKey === null ? null : await reviewByKey(getDb(), item.id, author, clientKey);
      if (earlier) return replay(earlier, digest);
      const [version] = await getDb().select().from(artifactVersions)
        .where(and(readableVersion(item.id), eq(artifactVersions.number, parsed.data.version))).limit(1);
      if (!version) {
        const current = await currentVersionOf(item);
        throw new ArtifactWebFailure(webVersionNotFound(parsed.data.version, current?.number));
      }

      // Step 3.
      const now = currentDate();
      const drafts = await getDb().select().from(artifactCommentDrafts).where(ownDrafts(reader, item.id, now))
        .orderBy(asc(artifactCommentDrafts.createdAt), asc(artifactCommentDrafts.id));
      if (drafts.length === 0) return refuse(409, { code: "NO_DRAFTS", error: "There are no review drafts to submit (they may have been posted or expired): add comments to the review first." });
      const checked: CheckedWebComment[] = [];
      for (const [index, draft] of [...drafts, null].entries()) {
        if (draft === null && summaryParts === null) break;
        try {
          checked.push(await checkWebComment(reader, item, draft === null
            ? { body: summaryParts, version: version.number, target: { scope: "artifact" }, replyTo: null }
            : inputOf(draft)));
        } catch (error) {
          if (!(error instanceof ArtifactWebFailure)) throw error;
          return rejected(drafts[index]?.id ?? null, error);
        }
      }
      const reviewComment = (entry: CheckedWebComment): ReviewComment => ({
        version: entry.version,
        path: entry.path,
        anchor: entry.anchor,
        replyTo: entry.replyTo,
        body: entry.body.text,
        mentions: entry.body.stored,
        mentionedAgents: entry.body.agentsToTell,
      });
      const summary = summaryParts === null ? null : reviewComment(checked.pop()!);
      const comments = checked.map(reviewComment);
      const draftIds = drafts.map((draft) => draft.id);

      // Step 4.
      const outcome = await submitReview({
        item,
        viewer: readerViewActor(reader),
        author,
        comments,
        summary,
        version: version.number,
        key: { clientKey, digest },
        outbox,
        now,
        // The drafts as they were checked: none edited, deleted or discarded since.
        claim: async (tx) => {
          const held = await tx.select({ id: artifactCommentDrafts.id, updatedAt: artifactCommentDrafts.updatedAt }).from(artifactCommentDrafts)
            .where(inArray(artifactCommentDrafts.id, draftIds)).for("update");
          const unchanged = drafts.every((draft) => held.some((row) => row.id === draft.id && row.updatedAt.getTime() === draft.updatedAt.getTime()));
          if (!unchanged) refuse(409, { code: "DRAFTS_CHANGED", error: "Your review drafts changed while the review was being submitted, so nothing was posted: check the drafts, then submit again." });
        },
        // Each draft's images, as saved, hung on the comment it is posted as (the summary has none).
        attach: async (tx, ids) => {
          const attached: ArtifactCommentImage[][] = [];
          for (const [index, commentId] of ids.entries()) {
            const draft = drafts[index];
            if (draft && draft.images.length > 0) await moveDraftImages(tx, item.id, draft.id, commentId);
            attached.push(draft?.images.map((image) => ({ ...image })) ?? []);
          }
          return attached;
        },
        release: async (tx) => {
          await tx.delete(artifactCommentDrafts).where(inArray(artifactCommentDrafts.id, draftIds));
        },
      });
      switch (outcome.kind) {
        case "gone": return webNotVisible();
        // A person's review is never held, as a person's comment isn't: no hold was asked.
        case "held": throw new Error("a person's review was held");
        case "replay": return replay(outcome.review, digest);
        case "refused": {
          const { index, refusal } = outcome.refused;
          // A reply draft's comment deleted since step 3: that draft refused, as step 3 refuses it.
          if (refusal.code === "COMMENT_NOT_FOUND") {
            return rejected(drafts[index]?.id ?? null, new ArtifactWebFailure(webFail(refusal.status, { code: refusal.code, error: refusal.error })));
          }
          // As checkWebComment refuses it: the version asked for and the current one, none without one.
          const current = await currentVersionOf(item);
          return rejected(drafts[index]?.id ?? null, new ArtifactWebFailure(webFail(refusal.status, {
            code: refusal.code,
            error: refusal.error,
            ...(current ? { details: { version: refusal.details.version, currentVersion: current.number } } : {}),
          })));
        }
        case "written": return posted(outcome.written.comments, outcome.written.summary, 201);
      }
    }),
  };
}
