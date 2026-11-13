// The agent API for Workspace Artifacts: `/internal/agent-api/artifacts/*`
// (contract: packages/shared agentApiArtifactsContract.ts). The read side
// (S1a) is here; publishing (S1b) is in publish.ts, commenting and following
// (S1c) in comments.ts, reviews (S8) in reviews.ts, the notices they send in notices.ts, moving to the
// whole server and deleting in manage.ts, importing from the standalone app
// in import.ts, saving an attachment in save.ts, a version's publish check
// in checkRead.ts; the list with
// `query` searches the index in search.ts (S9). Each operation answers a
// result core's agent API writes: JSON (checked against the contract there),
// bytes, or an error code; mount.ts registers them (the app's registration,
// register.ts, hands core that mount). Core's data comes through the
// platform entries (packages/server/src/platform: handles, conversation refs,
// target resolution, the flag, visibility); file bytes are under Artifacts'
// prefix of the platform's app-content bucket (blobStore.ts).
//
// Every operation checks first that Artifacts is on for the deployment
// (apiCommon requireEnabled) and answers nothing else when it is off. A read
// of one Artifact also needs the Artifact's own server to still exist
// (apiCommon itemServerEnabled). Visibility is canViewArtifacts /
// visibleArtifactsSql only; anything the caller can't see answers the same
// 404 NOT_VISIBLE.
import { and, asc, desc, eq, gt, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT,
  AGENT_API_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS,
  AGENT_API_ARTIFACT_LIST_DEFAULT_LIMIT,
  AGENT_API_ARTIFACT_LIST_MAX_LIMIT,
  AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN,
  AGENT_API_ARTIFACT_READ_VERSIONS_SHOWN,
  AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES,
  artifactFileType,
  isWellFormedArtifactFilePath,
  type AgentApiArtifactCommentsQuery,
  type AgentApiArtifactCommentsResponse,
  type AgentApiArtifactFileContentResponse,
  type AgentApiArtifactFileParams,
  type AgentApiArtifactFileQuery,
  type AgentApiArtifactListItem,
  type AgentApiArtifactListQuery,
  type AgentApiArtifactListResponse,
  type AgentApiArtifactParams,
  type AgentApiArtifactReadQuery,
  type AgentApiArtifactReadResponse,
} from "@botiverse/raft-shared";
import { resolveConversationTarget } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import { jointHomeAliases } from "../../platform/visibility";
import {
  accessOf,
  advanceReadPosition,
  agentActor,
  answer,
  type ArtifactAgent,
  type ArtifactApiBytes,
  type ArtifactApiError,
  ArtifactApiFailure,
  type ArtifactApiResult,
  byOthers,
  agentComment,
  commentActors,
  currentVersionOf,
  excerptOf,
  fail,
  fileNotFound,
  imageCountOf,
  invalidPath,
  json,
  liveComment,
  namer,
  positionCursor,
  readableVersion,
  readPositionOf,
  readTextPrefix,
  requireEnabled,
  resolveVisibleItem,
  shownInFull,
  shownThrough,
  storageUnavailable,
  summarize,
  targetNotFound,
  takesPartIn,
  versionFileOf,
  versionNotFound,
  versionNumbers,
  versionSummaries,
  viewActor,
  legacyNameOf,
} from "./apiCommon";
import { attachmentDisposition } from "./blobStore";
import { createCheckReadOperations } from "./checkRead";
import { createCommentOperations } from "./comments";
import { createCommentImageOperations } from "./commentImages";
import { createImportOperations } from "./import";
import { createManageOperations } from "./manage";
import { agentOriginOf } from "./origin";
import { createPublishOperations } from "./publish";
import { agentReview, createReviewOperations, reviewComments } from "./reviews";
import { createSaveOperations } from "./save";
import {
  artifactComments,
  artifactItems,
  artifactReviews,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactCommentRow,
  type ArtifactItemRow,
  type ArtifactVersionRow,
} from "./schema";
import { decodeListCursor, encodeListCursor, prepareArtifactSearch, updatedMs } from "./search";
import { visibleArtifactsSql } from "./visibility";

// For this module's tests.
export {
  advanceReadPosition,
  type ArtifactActorRef,
  type ArtifactAgent,
  type ArtifactApiError,
  type ArtifactNoticeOutbox,
} from "./apiCommon";
export { pruneUnreferencedArtifactBlobs } from "./blobs";
export { indexArtifactSearch } from "./search";
export { artifactNoticeDeliveryVerdicts, flushDueArtifactNotices, type ArtifactNoticeEvent } from "./notices";

const invalidCursor = (): ArtifactApiError => fail(400, {
  code: "agent_api_contract_invalid",
  error: "That cursor isn't one this list gave out: pass the cursor the previous page gave exactly, or leave it out to start from the beginning.",
});
/** The list's cursor belongs to one list: a plain one, or one query's. */
const invalidListCursor = (): ArtifactApiError => fail(400, {
  code: "agent_api_contract_invalid",
  error: "That cursor doesn't continue this list: a cursor only continues the list or search it came from, so leave it out to start over.",
});

/** The version a request names (`version`), or the current one. */
async function shownVersionOf(
  agent: ArtifactAgent,
  item: ArtifactItemRow,
  requested: string | undefined,
): Promise<{ version: ArtifactVersionRow | null; current: ArtifactVersionRow | null }> {
  const current = await currentVersionOf(item);
  if (requested === undefined) return { version: current, current };
  const number = Number(requested);
  const [version] = await getDb().select().from(artifactVersions)
    .where(and(readableVersion(item.id), eq(artifactVersions.number, number)))
    .limit(1);
  const allowed = version && (!accessOf(agent, item).historyLimited || version.id === current?.id);
  if (!allowed) {
    throw new ArtifactApiFailure(versionNotFound(item.id, number, current?.number ?? null));
  }
  return { version, current };
}

function parsePositionCursor(cursor: string): number | null {
  return /^\d{1,15}$/.test(cursor) ? Number(cursor) : null;
}

/** The bytes of one file of a version: the file is matched exactly, the bytes reached through its blob row only. */
async function fileOf(
  agent: ArtifactAgent,
  params: AgentApiArtifactFileParams,
  query: AgentApiArtifactFileQuery,
) {
  if (!isWellFormedArtifactFilePath(params.path)) {
    // Refused before reading the Artifact: with the caller's flag off, refused as every read is then.
    await requireEnabled(agent);
    throw new ArtifactApiFailure(invalidPath(params.path));
  }
  const item = await resolveVisibleItem(agent, params.artifact);
  const { version } = await shownVersionOf(agent, item, query.version);
  if (!version) throw new ArtifactApiFailure(versionNotFound(item.id, null, null));
  const missing = () => new ArtifactApiFailure(fileNotFound(item.id, params.path, version.number));
  const found = await versionFileOf(item, version, params.path);
  if (found.kind === "missing") throw missing();
  if (found.kind === "unavailable") throw new ArtifactApiFailure(storageUnavailable());
  return { ...found, version, type: artifactFileType(found.file.path), missing };
}

/**
 * Whether reading the Artifact writes the agent's read position: one it takes
 * part in (apiCommon takesPartIn: its own server's, or its joint's), as a
 * comment's hold reads that position. An outsider reads statelessly.
 */
const keepsReadPosition = (agent: ArtifactAgent, item: ArtifactItemRow): Promise<boolean> => takesPartIn(viewActor(agent), item);

export function createArtifactAgentApi() {
  return {
    ...createPublishOperations(),
    ...createCommentOperations(),
    ...createCommentImageOperations(),
    ...createCheckReadOperations(),
    ...createReviewOperations(),
    ...createManageOperations(),
    ...createSaveOperations(),
    importArtifact: createImportOperations().importArtifact,

    list: (agent: ArtifactAgent, query: AgentApiArtifactListQuery): Promise<ArtifactApiResult<AgentApiArtifactListResponse>> => answer(async () => {
      await requireEnabled(agent);
      const limit = Math.min(Math.max(Number(query.limit ?? AGENT_API_ARTIFACT_LIST_DEFAULT_LIMIT), 1), AGENT_API_ARTIFACT_LIST_MAX_LIMIT);
      // With `query`: Artifacts' search (search.ts), the one core's search runs too.
      const search = query.query === undefined ? null : prepareArtifactSearch(query.query);
      const cursor = query.cursor === undefined ? null : decodeListCursor(query.cursor, search?.digest ?? null);
      if (query.cursor !== undefined && !cursor) return invalidListCursor();
      const target = query.target === undefined ? null : await resolveConversationTarget(agent, query.target);
      if (query.target !== undefined && !target) return targetNotFound({ target: query.target });
      const echo = target ? { target: target.target, conversationId: target.conversationId, homeFromThread: target.homeFromThread } : null;

      // Visibility is in the statement (visibleArtifactsSql), never a filter
      // after LIMIT: a page holds only what the agent can see.
      const visible = await visibleArtifactsSql(viewActor(agent));
      const conditions: SQL[] = [];
      // A joint's Artifacts name its canonical channel, or (published earlier, or in a channel converted since) a server's projection of it.
      const targetHomes = !target ? [] : target.homeChannelId === target.conversationId ? [target.homeChannelId] : await jointHomeAliases([target.homeChannelId]);
      if (target) conditions.push(and(eq(artifactItems.homeKind, "conversation"), inArray(artifactItems.homeChannelId, targetHomes))!);
      if (search) {
        const found = await search.run({ visible, conditions, cursor, limit });
        const summaries = await summarize(agent, found.items);
        return json({
          artifacts: summaries.map((summary, index): AgentApiArtifactListItem => ({ ...summary, matches: found.matches[index]! })),
          nextCursor: found.nextCursor,
          target: echo,
        });
      }

      if (cursor) {
        const at = cursor.updatedAt.toISOString();
        conditions.push(sql`(${updatedMs} < ${at}::timestamptz OR (${updatedMs} = ${at}::timestamptz AND ${artifactItems.id} < ${cursor.id}))`);
      }
      const rows = await getDb().select().from(artifactItems).where(and(visible, ...conditions))
        .orderBy(desc(updatedMs), desc(artifactItems.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return json({
        artifacts: await summarize(agent, page),
        nextCursor: rows.length > limit && last ? encodeListCursor(last, null) : null,
        target: echo,
      });
    }),

    read: (agent: ArtifactAgent, params: AgentApiArtifactParams, query: AgentApiArtifactReadQuery): Promise<ArtifactApiResult<AgentApiArtifactReadResponse>> => answer(async () => {
      const item = await resolveVisibleItem(agent, params.artifact);
      const access = accessOf(agent, item);
      const { version, current } = await shownVersionOf(agent, item, query.version);
      // `version` naming the current version reads the current version too.
      const readingCurrent = version === null ? query.version === undefined : version.id === current?.id;
      const db = getDb();
      const others = byOthers(agent);

      const files = version
        ? await db.select().from(artifactVersionFiles).where(eq(artifactVersionFiles.versionId, version.id)).orderBy(asc(artifactVersionFiles.path))
        : [];
      const latest = access.historyLimited
        ? (current ? [current] : [])
        : await db.select().from(artifactVersions).where(readableVersion(item.id))
          .orderBy(desc(artifactVersions.number)).limit(AGENT_API_ARTIFACT_READ_VERSIONS_SHOWN);
      const [{ total } = { total: 0 }] = access.historyLimited
        ? [{ total: current ? 1 : 0 }]
        : await db.select({ total: sql<number>`count(*)::int` }).from(artifactVersions).where(readableVersion(item.id));

      let unseen: {
        firstRead: boolean;
        after: number;
        versionCount: number;
        commentCount: number;
        versions: ArtifactVersionRow[];
        comments: ArtifactCommentRow[];
        unread: number;
      } | null = null;
      if (readingCurrent) {
        const position = await readPositionOf(agentActor(agent), item.id);
        const after = position ?? 0;
        const versionWhere = and(readableVersion(item.id), gt(artifactVersions.position, after), others.version)!;
        const commentWhere = and(liveComment(item.id), gt(artifactComments.position, after), others.comment)!;
        const [versionCount, versionsShown] = access.historyLimited
          ? [0, []]
          : await Promise.all([
            db.select({ n: sql<number>`count(*)::int` }).from(artifactVersions).where(versionWhere).then(([row]) => row?.n ?? 0),
            db.select().from(artifactVersions).where(versionWhere).orderBy(desc(artifactVersions.position)).limit(AGENT_API_ARTIFACT_READ_VERSIONS_SHOWN),
          ]);
        const [commentCount, commentsShown] = access.comments
          ? await Promise.all([
            db.select({ n: sql<number>`count(*)::int` }).from(artifactComments).where(commentWhere).then(([row]) => row?.n ?? 0),
            db.select().from(artifactComments).where(commentWhere).orderBy(desc(artifactComments.position)).limit(AGENT_API_ARTIFACT_READ_UNSEEN_SHOWN),
          ])
          : [0, []];
        // Reading the current version is looking at what others published
        // up to now, and at the comments it shows in full: the read position
        // moves over those and stops before the first comment it didn't
        // (shownThrough). Only an agent that takes part in it keeps a read
        // position (its own server's or its joint's, as the web viewer's
        // reader): an outsider reads statelessly.
        let unread = commentCount;
        if (await keepsReadPosition(agent, item)) {
          const full = commentsShown.filter(shownInFull).map((comment) => comment.position);
          const seen = await shownThrough(db, agentActor(agent), item.id, after, item.lastPosition, new Set(full), { allVersions: true });
          await advanceReadPosition(agentActor(agent), item.id, seen);
          // Every comment by others up to `seen` is one shown in full.
          unread = Math.max(0, commentCount - full.filter((at) => at <= seen).length);
        }
        unseen = {
          firstRead: position === null,
          after,
          versionCount,
          commentCount,
          versions: [...versionsShown].reverse(),
          comments: [...commentsShown].reverse(),
          unread,
        };
      }

      const name = await namer([
        ...(version ? [{ type: version.publisherType, id: version.publisherId }] : []),
        ...latest.map((row) => ({ type: row.publisherType, id: row.publisherId })),
        ...(unseen?.versions ?? []).map((row) => ({ type: row.publisherType, id: row.publisherId })),
        ...(unseen?.comments ?? []).map((row) => ({ type: row.authorType, id: row.authorId })),
      ]);
      const [summary] = await summarize(agent, [item]);
      const commentVersions = await versionNumbers((unseen?.comments ?? []).map((comment) => comment.versionId));
      const body: AgentApiArtifactReadResponse = {
        artifact: summary!,
        version: version && {
          number: version.number,
          current: version.id === current?.id,
          entry: version.entry,
          label: version.label,
          note: version.note,
          publisher: name({ type: version.publisherType, id: version.publisherId }),
          createdAt: version.createdAt.toISOString(),
          sizeBytes: version.sizeBytes,
          files: files.map((file) => ({ path: file.path, sizeBytes: file.sizeBytes, kind: artifactFileType(file.path).kind, entry: file.path === version.entry })),
        },
        versions: { total, latest: await versionSummaries(item, latest, name, access.historyLimited) },
        unseen: unseen && {
          firstRead: unseen.firstRead,
          versionCount: unseen.versionCount,
          commentCount: unseen.commentCount,
          versions: await versionSummaries(item, unseen.versions, name, access.historyLimited),
          comments: unseen.comments.map((comment) => ({
            id: comment.id,
            author: name({ type: comment.authorType, id: comment.authorId }),
            version: commentVersions.get(comment.versionId) ?? 0,
            path: comment.path,
            createdAt: comment.createdAt.toISOString(),
            ...excerptOf(comment.body),
            anchor: comment.anchor ?? null,
            ...imageCountOf(comment),
          })),
          commentsCursor: unseen.commentCount > unseen.comments.length ? positionCursor(unseen.after) : null,
          unread: unseen.unread,
        },
        origin: await agentOriginOf(agent, item),
        // The push route's rule: only the Artifact's own server pushes to it (publish.ts).
        mayPush: item.serverId === agent.serverId,
        viewing: [],
      };
      return json(body);
    }),

    file: (agent: ArtifactAgent, params: AgentApiArtifactFileParams, query: AgentApiArtifactFileQuery): Promise<ArtifactApiBytes | ArtifactApiError> => answer(async () => {
      const { file, blob, reader, type, missing } = await fileOf(agent, params, query);
      const bytes = await reader.read(blob);
      if (!bytes) throw missing();
      return {
        kind: "bytes" as const,
        stream: bytes.stream,
        size: bytes.size,
        contentType: type.contentType,
        contentDisposition: attachmentDisposition(file.path),
      };
    }),

    fileContent: (agent: ArtifactAgent, params: AgentApiArtifactFileParams, query: AgentApiArtifactFileQuery): Promise<ArtifactApiResult<AgentApiArtifactFileContentResponse>> => answer(async () => {
      const { file, blob, version, reader, type, missing } = await fileOf(agent, params, query);
      if (type.text) {
        const bytes = await reader.read(blob);
        if (!bytes) throw missing();
        const { content, truncated } = await readTextPrefix(bytes, AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES);
        return json({
          kind: "text" as const,
          path: file.path,
          version: version.number,
          size: file.sizeBytes,
          contentType: type.contentType,
          encoding: "utf8" as const,
          content,
          truncated,
        });
      }
      // Stamp the expiry before minting, so it never overstates the URL's lifetime.
      const expiresAt = new Date(Date.now() + AGENT_API_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS * 1000);
      const url = await reader.presign(blob, {
        expiresInSeconds: AGENT_API_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS,
        contentType: type.contentType,
        contentDisposition: attachmentDisposition(file.path),
      });
      if (!url) return fail(503, { code: "ARTIFACTS_STORAGE_UNAVAILABLE", error: "This server's file storage for Artifacts can't hand out download links right now: read the file again in a minute, and tell an admin of this server if it keeps failing." });
      return json({
        kind: "binary" as const,
        path: file.path,
        version: version.number,
        size: file.sizeBytes,
        contentType: type.contentType,
        downloadUrl: url,
        expiresAt: expiresAt.toISOString(),
      });
    }),

    comments: (agent: ArtifactAgent, params: AgentApiArtifactParams, query: AgentApiArtifactCommentsQuery): Promise<ArtifactApiResult<AgentApiArtifactCommentsResponse>> => answer(async () => {
      const item = await resolveVisibleItem(agent, params.artifact);
      const access = accessOf(agent, item);
      // One review's comments (S8): every one of them, as `all`; its summary is the review's `body`, not listed.
      const reviewRow = query.review === undefined || !access.comments ? null : (await getDb().select().from(artifactReviews)
        .where(and(eq(artifactReviews.id, query.review), eq(artifactReviews.itemId, item.id))).limit(1))[0] ?? null;
      const view = query.all === undefined && query.review === undefined ? "unseen" as const : "all" as const;
      const path = query.path ?? null;
      const cursor = query.cursor === undefined ? null : parsePositionCursor(query.cursor);
      if (query.cursor !== undefined && cursor === null) return invalidCursor();
      const db = getDb();
      const others = byOthers(agent);
      const position = await readPositionOf(agentActor(agent), item.id);
      const seen = position ?? 0;
      const after = cursor ?? (view === "unseen" ? seen : 0);
      const pathFilter = path === null ? undefined : eq(artifactComments.path, path);

      const rows = access.comments && (query.review === undefined || reviewRow !== null)
        ? await db.select().from(artifactComments)
          // The unseen view, like artifactRead's count, leaves out the agent's own comments.
          .where(and(
            liveComment(item.id),
            gt(artifactComments.position, after),
            pathFilter,
            reviewRow === null ? undefined : eq(artifactComments.reviewId, reviewRow.id),
            reviewRow?.summaryCommentId ? ne(artifactComments.id, reviewRow.summaryCommentId) : undefined,
            view === "unseen" ? others.comment : undefined,
          ))
          .orderBy(asc(artifactComments.position))
          .limit(AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT + 1)
        : [];
      const page = rows.slice(0, AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT);
      const unseenVersions = access.historyLimited
        ? []
        : await db.select({ position: artifactVersions.position }).from(artifactVersions)
          .where(and(readableVersion(item.id), gt(artifactVersions.position, seen), others.version))
          .orderBy(asc(artifactVersions.position));

      if (view === "unseen" && page.length > 0 && await keepsReadPosition(agent, item)) {
        // Move over what this list showed (each comment in full) and the
        // versions in between (counted in `unseenVersionCount`, as a hold
        // passes them: listing the comments clears what holds a publish),
        // and stop before the first comment by someone else this page
        // skipped (shownThrough): before the cursor, or (with `path`) on
        // another file.
        const through = page[page.length - 1]!.position;
        const stop = await shownThrough(db, agentActor(agent), item.id, seen, through, new Set(page.map((comment) => comment.position)), { allVersions: true });
        if (stop > seen) await advanceReadPosition(agentActor(agent), item.id, stop);
      }

      const name = await namer(commentActors(page));
      const numbers = await versionNumbers(page.map((comment) => comment.versionId));
      const current = await currentVersionOf(item);
      return json({
        artifact: { id: item.id, name: legacyNameOf(item), title: item.title, currentVersion: current?.number ?? null },
        view,
        path,
        comments: page.map((comment) => agentComment(comment, numbers.get(comment.versionId) ?? 0, name)),
        review: query.review === undefined ? null : reviewRow && await agentReview(reviewRow, (await reviewComments(db, reviewRow)).summary),
        nextCursor: rows.length > AGENT_API_ARTIFACT_COMMENTS_PAGE_LIMIT ? positionCursor(page[page.length - 1]!.position) : null,
        unseenVersionCount: unseenVersions.length,
      });
    }),
  };
}

export type ArtifactAgentApi = ReturnType<typeof createArtifactAgentApi>;
