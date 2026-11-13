// What the web API's operations share (webRoutes.ts is the entry; viewer and
// files in webViewer.ts, comments and following in webComments.ts, cards and
// summaries in webCards.ts): the signed-in reader, errors,
// the flag gate and the one 404, what a reader may read of a visible
// Artifact, and actors and comments as the web payloads name them
// (workspaceArtifacts.ts).
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  ARTIFACT_PAGE_ANCHOR_MAX_LABEL,
  ARTIFACT_PAGE_ANCHOR_MAX_QUOTE,
  ARTIFACT_PAGE_ANCHOR_NAME,
  isArtifactPageText,
  asArtifactCommentId,
  asArtifactReviewId,
  structuredRaftMentionRanges,
  type ArtifactActor,
  type ArtifactComment,
  type ArtifactCommentAnchor,
  type ArtifactCommentPart,
  type ArtifactShownActor,
  type ArtifactWebErrorCode,
  type PaywallHitVia,
  type RefusalBody,
  type ServerId,
} from "@botiverse/raft-shared";
import { actorKey, actorProfiles, type ActorProfile } from "../../platform/actors";
import { getDb } from "../../platform/db";
import type { AppPaywallHit } from "../../platform/apps";
import { fileUploadQuotaExceededResponse, fileUploadQuotaPaywallHit, type FileUploadQuotaExceededError } from "../../platform/fileUploadQuota";
import { refusalBody, type RefusalInput } from "../../platform/refusals";
import type { ServerViewActor } from "../../platform/visibility";
import {
  ARTIFACTS_NOT_ENABLED_ERROR,
  artifactsEnabled,
  fileNotFoundError,
  INVALID_PATH_ERROR,
  isArtifactSystemActor,
  itemServerEnabled,
  NOT_VISIBLE_ERROR,
  readsAsOutsider,
  STORAGE_UNAVAILABLE_ERROR,
  TARGET_NOT_FOUND_ERROR,
  versionNotFoundError,
  type ArtifactActorRef,
} from "./apiCommon";
import type { ArtifactManageRefusal } from "./manage";
import { artifactItems, type ArtifactCommentRow, type ArtifactItemRow } from "./schema";
import { canViewArtifacts } from "./visibility";

/** The signed-in reader, from the web app's auth: user, active server, and sign-in (session family). */
export interface ArtifactWebReader {
  userId: string;
  serverId: ServerId;
  /** Null for a legacy access token without a session family. */
  sessionFamilyId: string | null;
}

/**
 * A refusal of the web API's Artifacts routes: the Server's refusal envelope
 * (platform/refusals, docs/contracts/agent-api-refusals.md) with one of the
 * web contract's codes. `error` is one sentence a person can act on; the web
 * branches on `code` and the listed codes' `details` (webArtifactsContract
 * ArtifactWebErrorDetails), and ignores `next`.
 */
export type ArtifactWebRefusal = Omit<RefusalInput, "code"> & { code: ArtifactWebErrorCode };

export type ArtifactWebApiError = {
  kind: "error";
  status: number;
  body: Omit<RefusalBody, "code"> & { code: ArtifactWebErrorCode };
  retryAfterSeconds?: number;
  /** A plan paywall, recorded by core with the answer (webFileUploadQuotaRefusal); not in the body. */
  paywallHit?: AppPaywallHit;
  /** A rate limit's refusal: the limit's name on the request's span (AppError.rateLimiter). */
  rateLimiter?: string;
};

/** A refusal answer, in the envelope (refusalBody checks the sentence: in tests and development a malformed one throws). */
export function webFail(status: number, refusal: ArtifactWebRefusal): ArtifactWebApiError {
  const body = refusalBody(refusal);
  return {
    kind: "error",
    status,
    body: { ...body, code: refusal.code },
    ...(body.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: body.retryAfterSeconds }),
  };
}

/**
 * The server's monthly file upload quota (the attachments' one) has no room
 * for the bytes: 403 FILE_UPLOAD_QUOTA_EXCEEDED, the attachments' sentence and
 * step for a person, and their fields as `details` (ArtifactWebErrorDetails).
 * `via`: the write refused, for the `paywall_hit` core records with it.
 */
export async function webFileUploadQuotaRefusal(serverId: ServerId, error: FileUploadQuotaExceededError, via: PaywallHitVia): Promise<ArtifactWebApiError> {
  const refusal = await fileUploadQuotaExceededResponse(serverId, error, "human");
  const refused = webFail(error.status, {
    code: "FILE_UPLOAD_QUOTA_EXCEEDED",
    error: refusal.error,
    suggestedNextAction: refusal.suggestedNextAction,
    details: { requestedBytes: refusal.requestedBytes, quota: refusal.quota, billingUrl: refusal.billingUrl },
  });
  return { ...refused, paywallHit: fileUploadQuotaPaywallHit(serverId, error, via) };
}

/** One body for "not found", "not yours to see", deleted and revoked alike: the agent API's sentence (apiCommon NOT_VISIBLE_ERROR). */
export const webNotVisible = (): ArtifactWebApiError => webFail(404, { code: "NOT_VISIBLE", error: NOT_VISIBLE_ERROR });

/**
 * A version the reader can't open; `details` (ArtifactWebErrorDetails) only
 * when both numbers are known, as before.
 */
export function webVersionNotFound(version: number | undefined, currentVersion: number | undefined): ArtifactWebApiError {
  return webFail(404, {
    code: "VERSION_NOT_FOUND",
    error: versionNotFoundError(version ?? null, currentVersion ?? null),
    ...(version !== undefined && currentVersion !== undefined ? { details: { version, currentVersion } } : {}),
  });
}

/** A path the shown version has no file at. */
export const webFileNotFound = (path: string, version: number): ArtifactWebApiError =>
  webFail(404, { code: "FILE_NOT_FOUND", error: fileNotFoundError(version), details: { path, version } });

/** A path no artifact file can have. */
export const webInvalidPath = (path: string): ArtifactWebApiError => webFail(400, { code: "INVALID_PATH", error: INVALID_PATH_ERROR, details: { path } });

/** Artifacts' file storage isn't configured here (or can't be read now): the web's code for it. */
export const webContentUnavailable = (): ArtifactWebApiError => webFail(503, { code: "CONTENT_UNAVAILABLE", error: STORAGE_UNAVAILABLE_ERROR });

/**
 * A body the route doesn't take: the web's own requests never send one, so
 * the person reloads (a stale page) and the sentence names the shape for
 * whoever reads the logs.
 */
export const webBadBody = (shape: string): ArtifactWebApiError => webFail(400, {
  code: "INVALID_REQUEST",
  error: `This request isn't one the route takes (its body is ${shape}): reload the page and try again.`,
});

/**
 * An image id a comment or draft names that isn't the reader's own unused
 * upload to this Artifact: one answer for every reason (apiCommon imageNotClaimable).
 */
export const webImageNotClaimable = (fileId: string): ArtifactWebRefusal => ({
  code: "IMAGE_NOT_FOUND",
  error: "That image isn't one you added to this artifact that no comment has yet (an unused image is gone after an hour, and each goes in one comment only): add the image again.",
  details: { fileId },
});

/** A kind the Raft shell draws itself (Markdown, CSV, an image, …): the frame route signs nothing for it. */
export const notFramed = (): ArtifactWebApiError => webFail(409, {
  code: "NOT_FRAMED",
  error: "This kind of artifact is shown by Raft itself, not in a frame: open it in the artifact viewer instead.",
});

/** A file the frame can't open at (#proj-workspace:#272): only an HTML page, a Markdown file or a PDF of the version opens beside its entry. */
export const fileNotFramed = (path: string): ArtifactWebApiError => webFail(409, {
  code: "NOT_FRAMED",
  error: "Only an HTML page, a Markdown file or a PDF opens in the frame beside the artifact's entry, and this file is none of those: read it in the artifact viewer, or download it.",
  details: { path },
});

export class ArtifactWebFailure extends Error {
  constructor(readonly result: ArtifactWebApiError) {
    super(result.body.code);
  }
}

const HOME_WORDS: Record<"conversation" | "server" | "public", string> = {
  conversation: "its conversation's members",
  server: "the whole server",
  public: "anyone with the link",
};

/** A refused move or delete (manage.ts) as the web answers it: the home route, unpublish, delete, the narrowing preview and a share's `widenTo`. */
export function webManageRefusal(refusal: ArtifactManageRefusal): ArtifactWebApiError {
  switch (refusal.kind) {
    case "not_visible": return webNotVisible();
    case "forbidden": return webFail(403, { code: "FORBIDDEN", error: refusal.reason });
    case "not_wider": return webFail(409, {
      code: "HOME_NOT_WIDER",
      error: `Nothing changed: ${HOME_WORDS[refusal.home]} can already see this artifact, which is at least as wide as the home asked for.`,
      details: { home: refusal.home, to: refusal.to },
    });
    case "not_narrower": return webFail(409, {
      code: "HOME_NOT_NARROWER",
      error: `Nothing changed: ${HOME_WORDS[refusal.home]} can see this artifact, and the home asked for isn't smaller, so pick a smaller one or leave it.`,
      details: { home: refusal.home, to: refusal.to },
    });
    case "not_public": return webFail(409, { code: "NOT_PUBLIC", error: "Nothing changed: link sharing is already off for this artifact.", details: { home: refusal.home } });
    case "name_taken": return webFail(409, {
      code: "NAME_TAKEN",
      error: "Another artifact in that home already has this artifact's name, so it can't move there; rename or delete the other one first.",
      details: { name: refusal.name },
    });
    case "target_not_found": return webFail(404, { code: "TARGET_NOT_FOUND", error: TARGET_NOT_FOUND_ERROR, details: { conversationId: refusal.conversationId } });
    case "target_not_supported": return webFail(400, {
      code: "TARGET_NOT_SUPPORTED",
      error: refusal.reason === "thread"
        ? "An artifact can't live in a thread: pick the channel or DM the thread is in instead."
        : "An artifact can't live in a joint channel yet: pick a channel or DM of this server instead.",
      details: { conversationId: refusal.conversationId, reason: refusal.reason },
    });
    case "target_has_guests": return webFail(403, {
      code: "TARGET_HAS_GUESTS",
      error: refusal.reason === "open_to_guests"
        ? "That conversation is open to this server's guests, and this artifact is only for members: pick a conversation without guests."
        : "That conversation has guests in it, and this artifact is only for members: pick a conversation without guests.",
      details: { conversationId: refusal.conversationId, reason: refusal.reason },
    });
    case "author_loses_access": return webFail(409, {
      code: "AUTHOR_LOSES_ACCESS",
      error: refusal.reason === "agent_not_member"
        ? "The artifact's author is an agent that isn't in that conversation, so it would lose the artifact there: add the agent first, or pick another conversation."
        : "The artifact's author couldn't see it in that conversation, so it can't move there: pick a conversation its author is in.",
      details: { reason: refusal.reason },
    });
    case "loss_changed": return webFail(409, {
      code: "LOSS_CHANGED",
      error: "Who would lose access changed since you confirmed: check the new count and confirm again.",
      details: { expected: refusal.expected, actual: refusal.actual, capped: refusal.capped },
    });
    case "not_original_home": return webFail(409, {
      code: "NOT_ORIGINAL_HOME",
      error: "An artifact moves back to a single conversation only to the one it started in: pick that conversation, or keep its wider home.",
      details: { originalConversationId: refusal.originalConversationId },
    });
  }
}

/** Stop the operation with a refusal (answerWeb turns it into the answer). */
export const refuse = (status: number, refusal: ArtifactWebRefusal): never => {
  throw new ArtifactWebFailure(webFail(status, refusal));
};

/** Run an operation; an ArtifactWebFailure thrown inside becomes its error answer. */
export async function answerWeb<T>(run: () => Promise<T>): Promise<T | ArtifactWebApiError> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ArtifactWebFailure) return error.result;
    throw error;
  }
}

export const readerActor = (reader: ArtifactWebReader): ArtifactActorRef => ({ type: "user", id: reader.userId });
export const readerViewActor = (reader: ArtifactWebReader): ServerViewActor => ({ type: "user", id: reader.userId, serverId: reader.serverId });

/** Artifacts on for this deployment (apiCommon artifactsEnabled), else 403 ARTIFACTS_NOT_ENABLED. */
export async function requireWebEnabled(reader: ArtifactWebReader): Promise<void> {
  if (!(await artifactsEnabled(reader.serverId))) refuseNotEnabled();
}

const refuseNotEnabled = (): never => refuse(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });

/**
 * Artifacts on for this deployment (403 ARTIFACTS_NOT_ENABLED), then the
 * Artifact if the reader can see it and its own server still exists
 * (apiCommon itemServerEnabled), else one 404 NOT_VISIBLE for every
 * reason. Every write route and the write-side reads (`@` candidates, who a
 * comment would notify, review drafts, the share audience, the narrowing
 * preview) resolve with this; the read routes the viewer uses with
 * readableItemFor, which answers the same. Writes need the reader to take
 * part in the item (apiCommon takesPartIn: its own server's, or a joint's).
 * The reader stands in `reader.serverId`: core's requireServer checks the
 * membership on every request.
 */
export async function visibleItemFor(reader: ArtifactWebReader, id: string): Promise<ArtifactItemRow> {
  await requireWebEnabled(reader);
  const item = await itemSeenBy(reader, id);
  if (!item) throw new ArtifactWebFailure(webNotVisible());
  return item;
}

/** The item `id` if the reader can see it (canViewArtifacts) and its own server still exists (itemServerEnabled), else null. */
async function itemSeenBy(reader: ArtifactWebReader, id: string): Promise<ArtifactItemRow | null> {
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)).limit(1);
  const visible = item !== undefined && (await canViewArtifacts(readerViewActor(reader), [item]))[0]! && await itemServerEnabled(item);
  return visible ? item : null;
}

/**
 * What the read routes the viewer and the Artifact's own page use (the
 * viewer, a file's bytes and content, the frame, the comment list, presence;
 * and the refusal of an undecodable path) resolve the Artifact with. The same
 * answer as visibleItemFor, its reads made at once (the viewer opens on
 * this): Artifacts off on this deployment is 403 ARTIFACTS_NOT_ENABLED for
 * every id (unknown, deleted, not theirs, public), so nothing tells an
 * Artifact from no Artifact; on, the item if the reader sees it
 * (canViewArtifacts) and its own server still exists (itemServerEnabled),
 * else the one 404 NOT_VISIBLE. A public Artifact of another server is seen
 * by sight alone: the reader reads it as an outsider (the current version, no
 * comments, no presence, and `capabilities` offer no write).
 */
export async function readableItemFor(reader: ArtifactWebReader, id: string): Promise<ArtifactItemRow> {
  const [[item], enabled] = await Promise.all([
    getDb().select().from(artifactItems).where(eq(artifactItems.id, id)).limit(1),
    artifactsEnabled(reader.serverId),
  ]);
  if (!enabled) refuseNotEnabled();
  if (!item) throw new ArtifactWebFailure(webNotVisible());
  const [[visible], itemServerOn] = await Promise.all([canViewArtifacts(readerViewActor(reader), [item]), itemServerEnabled(item)]);
  if (!visible || !itemServerOn) throw new ArtifactWebFailure(webNotVisible());
  return item;
}

/**
 * ArtifactActors for these actors, in one lookup. One that no longer exists
 * (a deleted agent, a person whose account is gone) is named by nothing and
 * marked `gone: "deleted"`; Raft's own system actors `gone: "system"`. The
 * web names both instead of showing nothing. A personal assistant carries
 * the person it works for (`onBehalfOf`), read in the same lookup (the
 * agents' query of platform/actors actorProfiles), never one more query.
 */
export async function profiler(actors: readonly ArtifactActorRef[]): Promise<(actor: ArtifactActorRef) => ArtifactActor> {
  const unique = [...new Map(actors.map((actor) => [actorKey(actor), actor])).values()];
  const profiles = unique.length > 0 ? await actorProfiles(unique) : new Map<string, ActorProfile>();
  return (actor) => {
    const profile = profiles.get(actorKey(actor));
    if (profile) {
      return {
        type: actor.type,
        id: actor.id,
        name: profile.name,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        ...(profile.assistantOf ? { onBehalfOf: { ...profile.assistantOf } } : {}),
      };
    }
    return { type: actor.type, id: actor.id, name: "", displayName: "", avatarUrl: null, gone: isArtifactSystemActor(actor) ? "system" : "deleted" };
  };
}

/**
 * Who wrote or published `item` as `reader` is shown them (a card's author, a
 * version's publisher): without the id, nor whose assistant it is
 * (`onBehalfOf`, which names a person of that server by id), for a reader
 * outside its server (readsAsOutsider: another server's reader of a public
 * Artifact), who is shown the name and avatar, not who in that server it is
 * (Remy, after Tenny's review; a visitor signed out is shown no one).
 */
export function shownActorOf(reader: { serverId: ServerId }, item: Pick<ArtifactItemRow, "serverId" | "homeKind">, actor: ArtifactActor): ArtifactShownActor {
  if (!readsAsOutsider(reader.serverId, item)) return actor;
  return { type: actor.type, name: actor.name, displayName: actor.displayName, avatarUrl: actor.avatarUrl, ...(actor.gone ? { gone: actor.gone } : {}) };
}

/**
 * Text a page gave (P108): at most `max` characters, not blank, and all of it text a person sees
 * (shared isArtifactPageText, the rule the viewer checks a page's request by).
 */
const plainText = (max: number) => z.string().max(max).refine((text) => isArtifactPageText(text, max));

const lineRange = z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().optional() })
  .refine((range) => range.end >= range.start);
/** ArtifactCommentAnchor, as the web sends and reads it. */
export const webCommentAnchorSchema: z.ZodType<ArtifactCommentAnchor> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("annotation"),
    data: z.object({
      kind: z.enum(["element", "text"]),
      selectors: z.array(z.union([
        z.object({ type: z.literal("CssSelector"), value: z.string() }),
        z.object({ type: z.literal("TextQuoteSelector"), exact: z.string(), prefix: z.string().optional(), suffix: z.string().optional() }),
        z.object({ type: z.literal("TextPositionSelector"), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
      ])),
      label: z.string(),
    }),
  }),
  z.object({
    type: z.literal("page"),
    // The page's word (P108): an identifier and plain text, each bounded; blank text is no text.
    data: z.object({
      name: z.string().regex(ARTIFACT_PAGE_ANCHOR_NAME),
      label: plainText(ARTIFACT_PAGE_ANCHOR_MAX_LABEL).optional(),
      quote: plainText(ARTIFACT_PAGE_ANCHOR_MAX_QUOTE).optional(),
    }).strict(),
  }),
  z.object({ type: z.literal("lines"), data: lineRange }),
  z.object({ type: z.literal("csv-rows"), data: lineRange }),
]);

/**
 * A stored comment's text as parts: each `@handle` of an actor the comment
 * mentions (comments.mentions, by its handle now) is a mention where a
 * message's would be one (shared structuredRaftMentionRanges: not in code, a
 * link or a block quote), the rest is text. A mention whose actor was renamed
 * since stays text.
 */
function partsOf(body: string, mentions: readonly ArtifactActorRef[], actorOf: (actor: ArtifactActorRef) => ArtifactActor): ArtifactCommentPart[] {
  const found: Array<{ start: number; end: number; actor: ArtifactActor }> = [];
  for (const ref of mentions) {
    const actor = actorOf(ref);
    if (!actor.name) continue;
    for (const range of structuredRaftMentionRanges(body, actor.name)) found.push({ ...range, actor });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: ArtifactCommentPart[] = [];
  let cursor = 0;
  for (const mention of found) {
    if (mention.start < cursor) continue;
    if (mention.start > cursor) parts.push({ type: "text", text: body.slice(cursor, mention.start) });
    parts.push({ type: "mention", actor: mention.actor });
    cursor = mention.end;
  }
  if (cursor < body.length) parts.push({ type: "text", text: body.slice(cursor) });
  return parts;
}

/** The actors a comment row names: its author and those it mentions. */
export const actorsOfComments = (rows: readonly ArtifactCommentRow[]): ArtifactActorRef[] =>
  rows.flatMap((row) => [
    { type: row.authorType, id: row.authorId },
    ...row.mentions,
    ...(row.resolvedByType === null || row.resolvedById === null ? [] : [{ type: row.resolvedByType, id: row.resolvedById }]),
  ]);

/** A live comment's text as the web reads it: its mentions as actors. */
export const webCommentParts = (row: Pick<ArtifactCommentRow, "body" | "mentions">, actorOf: (actor: ArtifactActorRef) => ArtifactActor): ArtifactCommentPart[] =>
  partsOf(row.body, row.mentions, actorOf);

/** A comment row as the web reads it. A deleted one (a placeholder for its replies) has an empty body. */
export function webComment(row: ArtifactCommentRow, versionNumber: number, actorOf: (actor: ArtifactActorRef) => ArtifactActor): ArtifactComment {
  const anchor = row.anchor === null ? null : webCommentAnchorSchema.safeParse(row.anchor);
  return {
    id: asArtifactCommentId(row.id),
    author: actorOf({ type: row.authorType, id: row.authorId }),
    body: row.deletedAt ? [] : webCommentParts(row, actorOf),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    version: versionNumber,
    // An anchor in a format the web doesn't draw (an agent's `html-region`) reads as the whole file.
    target: row.path === null ? { scope: "artifact" } : { scope: "file", path: row.path, anchor: anchor?.success ? anchor.data : null },
    replyTo: row.replyTo === null ? null : asArtifactCommentId(row.replyTo),
    ...(row.reviewId === null ? {} : { reviewId: asArtifactReviewId(row.reviewId) }),
    // Only when it has some (a placeholder keeps none).
    ...(row.deletedAt || row.images.length === 0 ? {} : { images: row.images.map((image) => ({ ...image })) }),
    // A thread's resolution (#249), on its root only.
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedByType === null || row.resolvedById === null ? null : actorOf({ type: row.resolvedByType, id: row.resolvedById }),
  };
}
