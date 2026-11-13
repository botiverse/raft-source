// Comments and following from the web (web API phase 1): the comment list,
// writing, editing and deleting a comment, who a comment would notify, whom
// `@` offers, and following. A person's comment is written by the same
// insertComment as an agent's (comments.ts), so it takes the item's next
// position, records the object event, makes its author follow the Artifact
// (unless they stopped) and tells agents exactly as an agent's comment does:
// mentioned agents and following agents at once (notices.ts). People are
// not told anything yet (their Activity is S6), so `notified` and willNotify
// name agents only. A person's comment is never held for unseen changes (the
// agent API's UNSEEN_CHANGES): the web shows the comments it is written
// among, and the web contract has no such answer.
//
// A comment is checked in this order, and nothing is written until the last
// step:
// 1. the flag, then the Artifact (one 404 NOT_VISIBLE), then who may comment:
//    a person of its server, or, for an Artifact homed in a joint channel, another
//    server's member of that joint who can see it with Artifacts on for its own
//    server (apiCommon takesPartIn → seenThroughJoint); else 403 FORBIDDEN;
// 2. the request (400 INVALID_REQUEST for a malformed body): the anchor's
//    size (FIELD_TOO_LONG), the path (INVALID_PATH), `replyTo` a live
//    comment of this Artifact (404 COMMENT_NOT_FOUND; a reply on the whole
//    Artifact takes its parent's file and place, as on the agent API),
//    `version` a published version (404 VERSION_NOT_FOUND) that has the file
//    (404 FILE_NOT_FOUND);
// 3. mentions: at most ARTIFACT_COMMENT_MAX_MENTIONS distinct people and
//    agents, the author included (400 TOO_MANY_MENTIONS); each one other than
//    the author stands in the Artifact's server and can see the Artifact, or,
//    for an Artifact homed in a joint channel, is another server's member of
//    that joint who can see it now with Artifacts on for its server
//    (platform/visibility jointViewersOf, as `@` offers them), else 422
//    MENTION_NOT_VISIBLE naming every such one (a mention never grants
//    access); a mention part that stands in code, a link or a block quote
//    is its words there, as in a message, and is not a mention; then the
//    text: stored with each mention as `@handle`
//    (what agents read), not empty unless the comment has images (400
//    INVALID_REQUEST), at most ARTIFACT_COMMENT_MAX_CHARS characters
//    (FIELD_TOO_LONG); `images` at most ARTIFACT_COMMENT_MAX_IMAGES ids
//    (400 INVALID_REQUEST);
// 4. in one transaction, the item row locked: its images claimed
//    (commentImages.ts: each the reader's own unused upload to this
//    Artifact, else 400 IMAGE_NOT_FOUND and nothing written), then
//    insertComment;
// 5. after the commit, the notices are pushed (sendQueued) and people's
//    Activity is told (announceObjectEvents).
//
// An edit (its author only, 403 FORBIDDEN) replaces the text and checks
// mentions the same way, except that only the mentions it adds are checked
// for visibility and told; it records a `comment_edited` event for them. Its
// images stay as they are (v1: a comment's images are given when it is
// written), so a comment with images may be edited to no text. A delete (its
// author only) removes a comment without replies; one with replies stays as
// a placeholder (deleted_at set, empty body, no images) so they keep their
// place, and goes once its last reply goes; either way its images are let
// go in the same transaction (their bytes after the commit). It records a
// `comment_deleted` event, for no one. Both events are written in the
// transaction of the change.
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT,
  AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES,
  ARTIFACT_COMMENT_MAX_CHARS,
  ARTIFACT_COMMENT_MAX_IMAGES,
  ARTIFACT_COMMENT_MAX_MENTIONS,
  asArtifactCommentId,
  asArtifactReviewId,
  asObjectFileId,
  createRaftStructuredUserRefRegex,
  currentDate,
  isWellFormedArtifactFilePath,
  structuredRaftMentionRanges,
  WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  type ArtifactActor,
  type ArtifactCommentAnchor,
  type ArtifactNoticeReason,
  type ArtifactWebCommentCreated,
  type ArtifactWebCommentInput,
  type ArtifactWebCommentsPage,
  type ArtifactWebMentionCandidates,
  type ArtifactWebReview,
  type ArtifactWebThreadResolution,
  type ArtifactWillNotify,
} from "@botiverse/raft-shared";
import { actorKey, actorProfiles, type ActorProfile } from "../../platform/actors";
import { mentionAudience, type MentionableObjectKind } from "../../platform/mentions";
import { jointViewersOf } from "../../platform/visibility";
import { getDb } from "../../platform/db";
import {
  accessOf,
  type ArtifactActorRef,
  type ArtifactApiEmpty,
  type ArtifactApiJson,
  type ArtifactNoticeOutbox,
  currentVersionOf,
  json,
  liveComment,
  readableVersion,
  readPositionOf,
  takePartForbiddenError,
  takesPartIn,
  versionNumbers,
} from "./apiCommon";
import { follow, insertComment, newCommentId, unfollow } from "./comments";
import { claimCommentImages, commentImagesPart, releasedImagesGone, releaseImages } from "./commentImages";
import { changeResolution, noteVersionFor, resolvableThread } from "./resolutions";
import { announceObjectEvents } from "../../platform/activity";
import { recordArtifactEvent } from "./events";
import { commentFollowers, followReasons, noticeComment, sendQueued } from "./notices";
import {
  actorsOfComments,
  answerWeb,
  ArtifactWebFailure,
  profiler,
  readableItemFor,
  readerActor,
  readerViewActor,
  refuse,
  visibleItemFor,
  webComment,
  webCommentAnchorSchema,
  webCommentParts,
  webFileNotFound,
  webImageNotClaimable,
  webInvalidPath,
  webNotVisible,
  webBadBody,
  webVersionNotFound,
  type ArtifactWebApiError,
  type ArtifactWebReader,
  type ArtifactWebRefusal,
} from "./webCommon";
import {
  artifactComments,
  artifactItems,
  artifactReviews,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactCommentAnchor as StoredAnchor,
  type ArtifactCommentRow,
  type ArtifactItemRow,
  type ArtifactReviewRow,
  type ArtifactVersionRow,
} from "./schema";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { actorsWhoCanViewArtifact, artifactHomes } from "./visibility";

/** At most this many people and agents `@` offers. */
const MENTION_CANDIDATES_SHOWN = 20;
/** The Artifact as the platform's mention audience reads an object kind (register.ts registers the same). */
const ARTIFACT_MENTION_AUDIENCE: MentionableObjectKind = {
  app: { id: "artifacts", flag: WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY },
  objectKind: { kind: ARTIFACT_OBJECT_KIND, homes: (ids) => artifactHomes(ids) },
};
const MENTION_QUERY_MAX_CHARS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.array(z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("mention"), actor: z.object({ type: z.enum(["user", "agent"]), id: z.string().min(1).max(64) }) }),
])).max(2000);
const commentInputSchema = z.object({
  body: bodySchema,
  version: z.number().int().positive(),
  target: z.union([
    z.object({ scope: z.literal("artifact") }),
    // The anchor is measured before its shape is checked (FIELD_TOO_LONG first).
    z.object({ scope: z.literal("file"), path: z.string(), anchor: z.json().nullable() }),
  ]),
  replyTo: z.string().min(1).max(200).nullable(),
  // Absent: none (older clients send none). Each one's ownership is checked when it is claimed.
  images: z.array(z.string().min(1).max(200)).max(ARTIFACT_COMMENT_MAX_IMAGES).optional(),
});
const editInputSchema = z.object({ body: bodySchema });
const resolveInputSchema = z.object({ note: bodySchema.nullable().optional() });

const chars = (value: string): number => Array.from(value).length;

/** A comment that isn't there (deleted, or not this Artifact's): the comments of a visible Artifact are all the reader's to see. */
const COMMENT_GONE: ArtifactWebRefusal = { code: "COMMENT_NOT_FOUND", error: "That comment isn't there any more (it may have been deleted): reload the comments and try again." };

/** The one 404, thrown. */
const notVisible = (): never => {
  throw new ArtifactWebFailure(webNotVisible());
};
const optionalString = (value: unknown, field: string): string | undefined => {
  if (value !== undefined && typeof value !== "string") refuse(400, { code: "INVALID_REQUEST", error: `The ${field} asked for isn't one value: ask with one ${field}, after reloading the page.` });
  return value as string | undefined;
};
const wellFormedPath = (path: string): string => {
  if (!isWellFormedArtifactFilePath(path)) throw new ArtifactWebFailure(webInvalidPath(path));
  return path;
};

/**
 * A person of the Artifact's server, or of another server in the joint channel
 * it is homed in (apiCommon takesPartIn): commenting, replying, reviewing and
 * following are theirs, as writing in that channel is.
 */
export async function requireTakesPart(reader: ArtifactWebReader, item: ArtifactItemRow): Promise<void> {
  if (!(await takesPartIn(readerViewActor(reader), item))) refuse(403, { code: "FORBIDDEN", error: takePartForbiddenError("comment on it or follow it") });
}

async function liveCommentOf(itemId: string, commentId: string): Promise<ArtifactCommentRow | null> {
  const [row] = await getDb().select().from(artifactComments).where(and(liveComment(itemId), eq(artifactComments.id, commentId))).limit(1);
  return row ?? null;
}

/** The review `?review=` names, if it is one of this Artifact's, and its summary while live. */
async function reviewOf(itemId: string, reviewId: string): Promise<{ review: ArtifactReviewRow; summary: ArtifactCommentRow | null } | null> {
  const [review] = await getDb().select().from(artifactReviews).where(and(eq(artifactReviews.id, reviewId), eq(artifactReviews.itemId, itemId))).limit(1);
  if (!review) return null;
  return { review, summary: review.summaryCommentId === null ? null : await liveCommentOf(itemId, review.summaryCommentId) };
}

/** A review as the comments page names it: its summary as a comment's body, its author as the page's comment authors. */
function webReview(review: ArtifactReviewRow, summary: ArtifactCommentRow | null, actorOf: (actor: ArtifactActorRef) => ArtifactActor): ArtifactWebReview {
  return {
    id: asArtifactReviewId(review.id),
    author: actorOf({ type: review.authorType, id: review.authorId }),
    body: summary === null ? null : webCommentParts(summary, actorOf),
    createdAt: review.createdAt.toISOString(),
  };
}

/**
 * Step 3: the body's mentions and its text. `known`: mentions the comment
 * already has (an edit), neither checked nor told again. `images`: how many
 * images the comment has; with any, its text may be empty.
 */
export async function resolveBody(reader: ArtifactWebReader, item: ArtifactItemRow, body: ArtifactWebCommentInput["body"], opts: { known?: ReadonlySet<string>; images?: number } = {}) {
  const known = opts.known ?? new Set<string>();
  const sent = [...new Map(body.flatMap((part) => (part.type === "mention" ? [[actorKey(part.actor), part.actor] as const] : []))).values()];
  if (sent.length > ARTIFACT_COMMENT_MAX_MENTIONS) {
    refuse(400, {
      code: "TOO_MANY_MENTIONS",
      error: `A comment can mention at most ${ARTIFACT_COMMENT_MAX_MENTIONS} people or agents: mention fewer, or mention the rest in a reply.`,
      details: { limit: ARTIFACT_COMMENT_MAX_MENTIONS },
    });
  }
  // Actor ids are uuids; anything else names nobody (and never reaches a uuid column).
  const named = sent.filter((actor) => UUID.test(actor.id));
  const profiles = named.length > 0 ? await actorProfiles(named) : new Map<string, ActorProfile>();
  // A mention already in the comment whose actor is gone keeps its text.
  const text = body.map((part) => (part.type === "text" ? part.text : `@${profiles.get(actorKey(part.actor))?.name ?? part.actor.id}`)).join("").trim();
  // A mention part in code, a link or a block quote is its words there, as in
  // a message (shared structuredRaftMentionRanges, which is also where
  // partsOf draws one): nobody is checked, stored or told for it. An actor
  // whose handle can't be looked for in the text is left to the checks below.
  const mentions = sent.filter((actor) => {
    const name = profiles.get(actorKey(actor))?.name;
    return !name || createRaftStructuredUserRefRegex(name) === null || structuredRaftMentionRanges(text, name).length > 0;
  });
  const self = actorKey(readerActor(reader));
  const added = mentions.filter((actor) => actorKey(actor) !== self && !known.has(actorKey(actor)));
  // Each must stand in the Artifact's server and see it, in one batched check
  // (every mention: those an edit keeps are stored only while they still can).
  const profiled = mentions.filter((actor) => profiles.has(actorKey(actor)));
  const answers = await actorsWhoCanViewArtifact(profiled.map((actor) => ({ ...actor, serverId: item.serverId })), item, { requireStanding: true });
  const inServer = new Set(profiled.filter((_, index) => answers[index]).map(actorKey));
  // Or, in a joint home, be another server's member of the joint who can see
  // it now (the audience's rule). Asked only when someone is left.
  const left = profiled.filter((actor) => !inServer.has(actorKey(actor)));
  const peers = left.length === 0 || item.homeKind !== "conversation"
    ? new Set<string>()
    : new Set((await jointViewersOf({
      id: item.id,
      serverId: item.serverId,
      homeKind: item.homeKind,
      homeChannelId: item.homeChannelId,
      author: { type: item.createdByType, id: item.createdById },
    }, left, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY)).keys());
  const seeing = new Set([...inServer, ...left.map(actorKey).filter((key) => peers.has(key))]);
  const hidden: ArtifactActorRef[] = added.filter((actor) => !seeing.has(actorKey(actor))).map((actor) => ({ type: actor.type, id: actor.id }));
  if (hidden.length > 0) {
    refuse(422, {
      code: "MENTION_NOT_VISIBLE",
      error: "Someone you mention can't see this artifact, so they wouldn't be told: remove the mention, or share the artifact with them first.",
      details: { actors: hidden },
    });
  }
  if (text.length === 0 && (opts.images ?? 0) === 0) refuse(400, { code: "INVALID_REQUEST", error: "A comment needs text or an image: write what you want to say." });
  if (chars(text) > ARTIFACT_COMMENT_MAX_CHARS) {
    refuse(400, {
      code: "FIELD_TOO_LONG",
      error: `A comment can be at most ${ARTIFACT_COMMENT_MAX_CHARS} characters: shorten it, or post the rest as a reply.`,
      details: { field: "body", limit: ARTIFACT_COMMENT_MAX_CHARS },
    });
  }
  return {
    text,
    // Only who can see it now: a stored mention is what `waiting` and the unread mention count read (Tenny).
    stored: mentions.filter((actor) => seeing.has(actorKey(actor))).map((actor) => ({ type: actor.type, id: actor.id })),
    /** The mentions this body adds (not the author's own): an edit's event is for them (recordArtifactEvent keeps those of the Artifact's server). */
    added: added.map((actor): ArtifactActorRef => ({ type: actor.type, id: actor.id })),
    /** The added agents who can see it: notices go to them (a joint's agent of another server too, told in its own server). */
    agentsToTell: added.filter((actor) => actor.type === "agent" && seeing.has(actorKey(actor))).map((actor) => actor.id),
  };
}

/** A comment input that passed steps 2 and 3: where it goes, on which version, its text and mentions. */
export interface CheckedWebComment {
  input: ArtifactWebCommentInput;
  path: string | null;
  anchor: StoredAnchor | null;
  replyTo: string | null;
  version: ArtifactVersionRow;
  body: Awaited<ReturnType<typeof resolveBody>>;
  /** Its image ids as sent, in order (claimed when it is written). */
  images: readonly string[];
}

/**
 * Steps 2 and 3 of a comment (the file's header) for `rawBody`, an
 * ArtifactWebCommentInput as sent: the request, then the mentions and the
 * text. Throws the refusal (ArtifactWebFailure). A draft is checked by it
 * when saved and again when its review is submitted.
 */
export async function checkWebComment(reader: ArtifactWebReader, item: ArtifactItemRow, rawBody: unknown): Promise<CheckedWebComment> {
  const parsed = commentInputSchema.safeParse(rawBody);
  if (!parsed.success) throw new ArtifactWebFailure(webBadBody("an ArtifactWebCommentInput"));
  const input = parsed.data;
  let path: string | null = null;
  let anchor: StoredAnchor | null = null;
  // The target as sent, its anchor in the shape the web reads (a draft keeps it so).
  let target: ArtifactWebCommentInput["target"] = { scope: "artifact" };
  if (input.target.scope === "file") {
    let shapedAnchor: ArtifactCommentAnchor | null = null;
    if (input.target.anchor !== null) {
      if (Buffer.byteLength(JSON.stringify(input.target.anchor), "utf8") > AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES) {
        refuse(400, {
          code: "FIELD_TOO_LONG",
          error: "The place this comment is anchored to is too large to keep: select a shorter passage or a smaller element, or comment on the whole file.",
          details: { field: "anchor", limit: AGENT_API_ARTIFACT_MAX_ANCHOR_BYTES },
        });
      }
      const shaped = webCommentAnchorSchema.safeParse(input.target.anchor);
      if (!shaped.success) throw new ArtifactWebFailure(webBadBody("an ArtifactWebCommentInput whose anchor is an ArtifactCommentAnchor"));
      shapedAnchor = shaped.data!;
      anchor = { type: shapedAnchor.type, data: { ...shapedAnchor.data } };
    }
    path = wellFormedPath(input.target.path);
    target = { scope: "file", path, anchor: shapedAnchor };
  }
  if (input.replyTo !== null) {
    const parent = await liveCommentOf(item.id, input.replyTo);
    if (!parent) return refuse(404, COMMENT_GONE);
    // A reply is a comment at the same place (technical design §6b).
    if (input.target.scope === "artifact") {
      path = parent.path;
      anchor = parent.anchor;
    }
  }
  const current = await currentVersionOf(item);
  const [version] = await getDb().select().from(artifactVersions)
    .where(and(readableVersion(item.id), eq(artifactVersions.number, input.version))).limit(1);
  if (!version) throw new ArtifactWebFailure(webVersionNotFound(input.version, current?.number));
  if (path !== null) {
    const [file] = await getDb().select({ path: artifactVersionFiles.path }).from(artifactVersionFiles)
      .where(and(eq(artifactVersionFiles.versionId, version.id), eq(artifactVersionFiles.path, path))).limit(1);
    if (!file) throw new ArtifactWebFailure(webFileNotFound(path, version.number));
  }
  const images = input.images ?? [];
  const body = await resolveBody(reader, item, input.body, { images: images.length });
  return {
    input: {
      body: input.body.map((part) => (part.type === "text" ? { type: "text" as const, text: part.text } : { type: "mention" as const, actor: { type: part.actor.type, id: part.actor.id } })),
      version: input.version,
      target,
      replyTo: input.replyTo === null ? null : asArtifactCommentId(input.replyTo),
      ...(images.length === 0 ? {} : { images: images.map(asObjectFileId) }),
    },
    path,
    anchor,
    replyTo: input.replyTo,
    version,
    body,
    images,
  };
}

/**
 * Resolve or reopen, for a person (resolutions.ts has the rule): the
 * Artifact they see and take part in, the thread (a root: 409
 * COMMENT_IS_REPLY for a reply), who may (403), the note checked as a
 * reply's body, then changeResolution with the note written by insertComment.
 */
async function webResolution(
  reader: ArtifactWebReader,
  id: string,
  commentId: string,
  outbox: ArtifactNoticeOutbox,
  opts: { resolve: boolean; note: ArtifactWebCommentInput["body"] | null },
): Promise<ArtifactApiJson<ArtifactWebThreadResolution>> {
  const item = await visibleItemFor(reader, id);
  await requireTakesPart(reader, item);
  const thread = await resolvableThread(readerViewActor(reader), item, commentId);
  if (thread.kind === "not_found") return refuse(404, COMMENT_GONE);
  if (thread.kind === "reply") {
    return refuse(409, {
      code: "COMMENT_IS_REPLY",
      error: `That's a reply: only a whole thread is ${opts.resolve ? "resolved" : "reopened"}, from its first comment.`,
      ...(thread.thread ? { details: { thread: thread.thread } } : {}),
    });
  }
  if (thread.kind === "forbidden") {
    return refuse(403, { code: "FORBIDDEN", error: `Only the thread's author, the artifact's author (or whoever manages it, when it's an agent), and the server's owners and admins can ${opts.resolve ? "resolve" : "reopen"} a thread: reply to it instead.` });
  }
  const { root } = thread;
  const by = readerActor(reader);
  let note: { body: Awaited<ReturnType<typeof resolveBody>>; version: ArtifactVersionRow } | null = null;
  if (opts.note !== null) {
    const body = await resolveBody(reader, item, opts.note);
    const version = await noteVersionFor(item, root);
    if (!version) throw new ArtifactWebFailure(webVersionNotFound(0, undefined));
    note = { body, version };
  }
  const outcome = await changeResolution({
    outbox,
    item,
    rootId: root.id,
    by,
    resolve: opts.resolve,
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
        body: note!.body.text,
        mentions: note!.body.stored,
        mentionedAgents: note!.body.agentsToTell,
        images: [],
        now: currentDate(),
        quiet,
      }),
    }),
  });
  if (outcome.kind === "gone") return notVisible();
  if (outcome.kind === "not_found") return refuse(404, COMMENT_GONE);
  if (outcome.kind === "held") throw new Error("a person's resolve is never held");
  const rows = [outcome.root, ...(outcome.note ? [outcome.note.comment] : [])];
  const numbers = await versionNumbers(rows.map((row) => row.versionId));
  const actorOf = await profiler(actorsOfComments(rows));
  return json<ArtifactWebThreadResolution>({
    comment: webComment(outcome.root, numbers.get(outcome.root.versionId) ?? 0, actorOf),
    note: outcome.note ? webComment(outcome.note.comment, outcome.note.version.number, actorOf) : null,
    changed: outcome.changed,
  });
}

export function createWebCommentOperations() {
  /** The written comment and who heard, with why. */
  async function created(item: ArtifactItemRow, comment: ArtifactCommentRow, versionNumber: number, told: Array<{ agentId: string; reason: "mentioned" | "subscribed" }>): Promise<ArtifactWebCommentCreated> {
    const reasons = await followReasons(getDb(), item, told.filter((entry) => entry.reason === "subscribed").map((entry) => entry.agentId));
    const actorOf = await profiler([...actorsOfComments([comment]), ...told.map((entry) => ({ type: "agent" as const, id: entry.agentId }))]);
    return {
      comment: webComment(comment, versionNumber, actorOf),
      notified: told.map((entry) => ({
        actor: actorOf({ type: "agent", id: entry.agentId }),
        reason: entry.reason === "mentioned" ? "mentioned" as const : reasons.get(entry.agentId) ?? "subscribed",
      })),
    };
  }

  return {
    comments: (reader: ArtifactWebReader, id: string, query: { before?: unknown; path?: unknown; review?: unknown }): Promise<ArtifactApiJson<ArtifactWebCommentsPage> | ArtifactWebApiError> => answerWeb(async () => {
      // A read (readableItemFor); an outsider is listed none.
      const item = await readableItemFor(reader, id);
      const before = optionalString(query.before, "before");
      if (before !== undefined && !/^\d{1,15}$/.test(before)) {
        refuse(400, { code: "INVALID_REQUEST", error: "That page of comments isn't one this list gave out: reload the comments to start from the newest." });
      }
      const pathQuery = optionalString(query.path, "path");
      const path = pathQuery === undefined ? undefined : wellFormedPath(pathQuery);
      // One review's comments (S8), as on the agent API: its summary left
      // out of the list and answered as `review.body`; an id that names no
      // review of this Artifact lists none, with `review: null`.
      const reviewQuery = optionalString(query.review, "review");
      const none = { comments: [], olderCursor: null, ...(reviewQuery === undefined ? {} : { review: null }) };
      if (!accessOf(reader, item).comments) return json<ArtifactWebCommentsPage>(none);
      const reviewed = reviewQuery === undefined ? null : await reviewOf(item.id, reviewQuery);
      if (reviewQuery !== undefined && reviewed === null) return json<ArtifactWebCommentsPage>(none);
      const summaryId = reviewed?.review.summaryCommentId ?? null;
      // Every row: deleted ones are placeholders kept for their replies.
      const rows = await getDb().select().from(artifactComments).where(and(
        eq(artifactComments.itemId, item.id),
        before === undefined ? undefined : lt(artifactComments.position, Number(before)),
        path === undefined ? undefined : eq(artifactComments.path, path),
        reviewed === null ? undefined : eq(artifactComments.reviewId, reviewed.review.id),
        summaryId === null ? undefined : ne(artifactComments.id, summaryId),
      )).orderBy(desc(artifactComments.position)).limit(AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT + 1);
      const page = rows.slice(0, AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT).reverse();
      const numbers = await versionNumbers(page.map((row) => row.versionId));
      const actorOf = await profiler([
        ...actorsOfComments(page),
        ...(reviewed === null ? [] : [{ type: reviewed.review.authorType, id: reviewed.review.authorId }, ...(reviewed.summary?.mentions ?? [])]),
      ]);
      return json<ArtifactWebCommentsPage>({
        comments: page.map((row) => webComment(row, numbers.get(row.versionId) ?? 0, actorOf)),
        olderCursor: rows.length > AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT ? String(page[0]!.position) : null,
        ...(reviewed === null ? {} : { review: webReview(reviewed.review, reviewed.summary, actorOf) }),
      });
    }),

    postComment: (reader: ArtifactWebReader, id: string, rawBody: unknown, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactWebCommentCreated> | ArtifactWebApiError> => answerWeb(async () => {
      // Step 1.
      const item = await visibleItemFor(reader, id);
      await requireTakesPart(reader, item);

      // Steps 2 and 3.
      const { path, anchor, version, body, input, images } = await checkWebComment(reader, item, rawBody);

      // Step 4.
      const now = currentDate();
      const author = readerActor(reader);
      const outcome = await getDb().transaction(async (tx) => {
        const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, item.id)).for("update");
        if (!locked || locked.deletedAt || locked.revokedAt) return null;
        // Again under the item's lock, which a delete takes too: the parent may
        // have been deleted since it was looked up (Tenny, #10943).
        if (input.replyTo !== null) {
          const [parent] = await tx.select({ id: artifactComments.id }).from(artifactComments)
            .where(and(liveComment(locked.id), eq(artifactComments.id, input.replyTo))).limit(1);
          if (!parent) refuse(404, COMMENT_GONE);
        }
        // Its images: only the reader's own unused uploads to this Artifact; one that isn't refuses it all (the throw rolls back the claims).
        const id = newCommentId();
        const claimed = await claimCommentImages(tx, locked.id, author, images, commentImagesPart(id));
        if (claimed.kind === "not_found") return refuse(400, webImageNotClaimable(claimed.fileId));
        return insertComment(tx, {
          outbox,
          locked,
          id,
          author,
          readPosition: await readPositionOf(author, locked.id, tx),
          version,
          path,
          anchor,
          replyTo: input.replyTo,
          body: body.text,
          mentions: body.stored,
          mentionedAgents: body.agentsToTell,
          images: claimed.images,
          now,
        });
      });
      if (!outcome) return notVisible();

      // Step 5.
      await sendQueued(outbox, outcome.queued);
      await announceObjectEvents([outcome.eventId]);
      return json(await created(item, outcome.comment, version.number, outcome.told), 201);
    }),

    editComment: (reader: ArtifactWebReader, id: string, commentId: string, rawBody: unknown, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactWebCommentCreated> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      const parsed = editInputSchema.safeParse(rawBody);
      if (!parsed.success) throw new ArtifactWebFailure(webBadBody("{ body: ArtifactWebCommentInput[\"body\"] }"));
      const row = accessOf(reader, item).comments ? await liveCommentOf(item.id, commentId) : null;
      if (!row) return refuse(404, COMMENT_GONE);
      if (row.authorType !== "user" || row.authorId !== reader.userId) refuse(403, { code: "FORBIDDEN", error: "Only a comment's author can edit it: reply to it instead." });
      await requireTakesPart(reader, item);
      // The text only: its images stay, so with any it may have no text.
      const body = await resolveBody(reader, item, parsed.data.body, { known: new Set(row.mentions.map(actorKey)), images: row.images.length });

      const now = currentDate();
      const outcome = await getDb().transaction(async (tx) => {
        const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, item.id)).for("update");
        if (!locked || locked.deletedAt || locked.revokedAt) return "gone" as const;
        const [edited] = await tx.update(artifactComments)
          .set({ body: body.text, mentions: body.stored, editedAt: now })
          .where(and(liveComment(item.id), eq(artifactComments.id, row.id)))
          .returning();
        if (!edited) return "deleted" as const;
        // For the mentions it adds, as its notices.
        const event = await recordArtifactEvent(tx, {
          item: locked,
          eventKind: "comment_edited",
          actor: readerActor(reader),
          data: { comment: edited.id, position: edited.position },
          recipients: body.added.map((actor) => ({ actor, reason: "mentioned" as const })),
        });
        const noticed = await noticeComment({ executor: tx, outbox, item: locked, comment: edited, mentioned: body.agentsToTell, now, followers: false });
        return { edited, eventId: event.id, ...noticed };
      });
      if (outcome === "gone") return notVisible();
      if (outcome === "deleted") return refuse(404, COMMENT_GONE);
      await sendQueued(outbox, outcome.queued);
      await announceObjectEvents([outcome.eventId]);
      const numbers = await versionNumbers([outcome.edited.versionId]);
      return json(await created(item, outcome.edited, numbers.get(outcome.edited.versionId) ?? 0, outcome.told));
    }),

    deleteComment: (reader: ArtifactWebReader, id: string, commentId: string): Promise<ArtifactApiEmpty | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      const row = accessOf(reader, item).comments ? await liveCommentOf(item.id, commentId) : null;
      if (!row) return refuse(404, COMMENT_GONE);
      if (row.authorType !== "user" || row.authorId !== reader.userId) refuse(403, { code: "FORBIDDEN", error: "Only a comment's author can delete it: ask them to, or reply to it instead." });
      await requireTakesPart(reader, item);
      // What it let go of (its images), or null: nothing to delete.
      const released = await getDb().transaction(async (tx) => {
        // The item lock orders this against replies being written.
        const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, item.id)).for("update");
        // Told to no one: the event records the change for whoever reads the Artifact's events.
        const recorded = (placeholder: boolean) => recordArtifactEvent(tx, {
          item: locked ?? item,
          eventKind: "comment_deleted",
          actor: readerActor(reader),
          data: { comment: row.id, position: row.position, placeholder },
          recipients: [],
        });
        const hasReplies = async (commentId: string) => (await tx.select({ id: artifactComments.id }).from(artifactComments)
          .where(and(eq(artifactComments.itemId, item.id), eq(artifactComments.replyTo, commentId))).limit(1)).length > 0;
        if (await hasReplies(row.id)) {
          const kept = await tx.update(artifactComments).set({ deletedAt: sql`now()`, body: "", mentions: [], images: [] })
            .where(and(liveComment(item.id), eq(artifactComments.id, row.id))).returning({ id: artifactComments.id });
          if (kept.length === 0) return null;
          await recorded(true);
          // A placeholder keeps no images: they go with the comment, as its text does.
          return releaseImages(tx, item.id, [commentImagesPart(row.id)]);
        }
        const gone = await tx.delete(artifactComments).where(and(liveComment(item.id), eq(artifactComments.id, row.id))).returning();
        if (gone.length === 0) return null;
        await recorded(false);
        const images = await releaseImages(tx, item.id, [commentImagesPart(row.id)]);
        // A placeholder whose last reply this was goes too, and so on up the thread.
        let parentId = gone[0]!.replyTo;
        while (parentId !== null) {
          const [parent] = await tx.select().from(artifactComments).where(and(eq(artifactComments.itemId, item.id), eq(artifactComments.id, parentId))).limit(1);
          if (!parent || parent.deletedAt === null || await hasReplies(parent.id)) break;
          await tx.delete(artifactComments).where(eq(artifactComments.id, parent.id));
          parentId = parent.replyTo;
        }
        return images;
      });
      if (!released) return refuse(404, COMMENT_GONE);
      // Once the delete committed: the images' bytes.
      await releasedImagesGone(released);
      return { kind: "empty" as const };
    }),

    /** Resolve a thread (#249, resolutions.ts): with `note`, posted first as the reader's reply in it. */
    resolveComment: (reader: ArtifactWebReader, id: string, commentId: string, rawBody: unknown, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactWebThreadResolution> | ArtifactWebApiError> => answerWeb(async () => {
      const parsed = resolveInputSchema.safeParse(rawBody ?? {});
      if (!parsed.success) throw new ArtifactWebFailure(webBadBody("an ArtifactWebResolveInput"));
      return webResolution(reader, id, commentId, outbox, { resolve: true, note: parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null });
    }),

    /** Reopen a resolved thread (#249). Tells no one. */
    reopenComment: (reader: ArtifactWebReader, id: string, commentId: string, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactWebThreadResolution> | ArtifactWebApiError> => answerWeb(() => webResolution(reader, id, commentId, outbox, { resolve: false, note: null })),

    /**
     * Who a comment here would notify as things stand: the Artifact's
     * following agents that can see it, with why each follows. `path` and
     * `replyTo` are checked but change nothing: followers hear of every
     * comment. Mentions in the draft are the client's to add.
     */
    willNotify: (reader: ArtifactWebReader, id: string, query: { replyTo?: unknown; path?: unknown }): Promise<ArtifactApiJson<ArtifactWillNotify> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      await requireTakesPart(reader, item);
      const replyTo = optionalString(query.replyTo, "replyTo");
      const path = optionalString(query.path, "path");
      if (path !== undefined) wellFormedPath(path);
      if (replyTo !== undefined && !(await liveCommentOf(item.id, replyTo))) refuse(404, COMMENT_GONE);
      const followers = await commentFollowers(getDb(), item, readerActor(reader));
      const actorOf = await profiler(followers.map((entry) => ({ type: "agent" as const, id: entry.agentId })));
      return json<ArtifactWillNotify>({
        recipients: followers.map((entry): { actor: ArtifactActor; reason: ArtifactNoticeReason } => ({ actor: actorOf({ type: "agent", id: entry.agentId }), reason: entry.reason })),
      });
    }),

    /**
     * Whom `@` offers on the Artifact: the platform's mention audience for it
     * (platform/mentions mentionAudience, the one rule behind core's
     * `POST /api/mentions/audience` and every picker): people and live agents
     * of its server who can see it, of them only whom core shows the reader,
     * and in a joint home the joint's other servers' members who can see it
     * (as its roster shows them), members of its home conversation first, at
     * most 20. The answer keeps this route's shape
     * (ArtifactWebMentionCandidates) until the web uses the shared picker
     * everywhere.
     */
    mentionCandidates: (reader: ArtifactWebReader, id: string, query: { q?: unknown }): Promise<ArtifactApiJson<ArtifactWebMentionCandidates> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      await requireTakesPart(reader, item);
      const q = Array.from((optionalString(query.q, "q") ?? "").trim()).slice(0, MENTION_QUERY_MAX_CHARS).join("");
      const audience = await mentionAudience(
        { userId: reader.userId, serverId: reader.serverId },
        { kind: "object", registered: ARTIFACT_MENTION_AUDIENCE, objectId: item.id },
        { q, limit: MENTION_CANDIDATES_SHOWN },
      );
      if (!audience) return notVisible();
      return json<ArtifactWebMentionCandidates>({
        candidates: audience.candidates.map(({ type, id: actorId, name, displayName, avatarUrl }) => ({ type, id: actorId, name, displayName, avatarUrl })),
      });
    }),

    follow: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<{ following: boolean }> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      await requireTakesPart(reader, item);
      await follow(item.id, readerActor(reader));
      return json({ following: true });
    }),

    /** Stop following (sticky: commenting doesn't follow it again). Someone outside the server and its joint never follows: nothing to stop. */
    unfollow: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<{ following: boolean }> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      if (await takesPartIn(readerViewActor(reader), item)) await unfollow(item.id, readerActor(reader));
      return json({ following: false });
    }),
  };
}
