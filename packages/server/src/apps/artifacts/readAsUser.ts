// Reading one Artifact as a person, for a caller that acts for that person
// and is not their browser (#proj-assistant:#31: a personal assistant reads
// what its owner can see). The checks are the web's own read
// (webCommon readableItemFor, viewerDataOf, the file and comment reads): the
// answer holds nothing the person wouldn't get by opening the Artifact on the
// web, and what they can't open answers the same refusals (403
// ARTIFACTS_NOT_ENABLED, the one 404 NOT_VISIBLE, 404 VERSION_NOT_FOUND, 400
// INVALID_PATH, 404 FILE_NOT_FOUND, 503 CONTENT_UNAVAILABLE).
//
// A read and nothing else: no read position moves, nobody starts following,
// no frame ticket is signed, no product event is recorded. The caller decides
// who it may read for; this module only takes the person it is given.
import {
  AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES,
  artifactFileType,
  isWellFormedArtifactFilePath,
  parseArtifactRef,
  type ArtifactReadAsUser,
  type ArtifactReadAsUserFile,
  type ServerId,
} from "@botiverse/raft-shared";
import { appHosts } from "../../platform/links";
import { json, readTextPrefix, versionFileOf, type ArtifactApiJson } from "./apiCommon";
import { createWebCommentOperations } from "./webComments";
import {
  answerWeb,
  ArtifactWebFailure,
  readableItemFor,
  requireWebEnabled,
  webContentUnavailable,
  webFileNotFound,
  webInvalidPath,
  webNotVisible,
  type ArtifactWebApiError,
  type ArtifactWebReader,
} from "./webCommon";
import { viewerDataOf } from "./webViewer";
import type { AppReadAsUserAnswer, AppReadAsUserInput } from "../../platform/apps";

// The answer's shape lives in shared (workspaceArtifacts.ts): core reads it through the registration (register.ts actingFor).
export type { ArtifactReadAsUser, ArtifactReadAsUserFile } from "@botiverse/raft-shared";

export interface ArtifactReadAsUserInput {
  /** The server the person reads from (one they are a member of: the caller's check). */
  serverId: ServerId;
  userId: string;
  /** An id (`pt_…` or the short id) or any link to the Artifact; a link's `/v/<n>` is the version unless `version` is given. */
  ref: string;
  /** A published version's number; absent: the link's, else the current one. */
  version?: number;
  /** A file of that version; absent: its entry file. */
  path?: string;
  /** Also the newest page of comments the person can read. */
  comments?: boolean;
  /** With `comments`: the page before this cursor (a previous answer's `olderCursor`). */
  commentsBefore?: string;
  /**
   * Whether the caller may read an Artifact living there, asked right after the person's own visibility check and
   * before any version, path or content work: false answers the one not-visible, so nothing past it tells the
   * Artifact exists (Warden, #14494). `channelId` is the conversation home's, null for a server or public home.
   */
  homeAllowed?: (home: { kind: "conversation" | "server" | "public"; channelId: string | null }) => Promise<boolean>;
}

const commentOperations = createWebCommentOperations();

export function readArtifactAsUser(input: ArtifactReadAsUserInput): Promise<ArtifactApiJson<ArtifactReadAsUser> | ArtifactWebApiError> {
  return answerWeb(async () => {
    const reader: ArtifactWebReader = { userId: input.userId, serverId: input.serverId, sessionFamilyId: null };
    const parsed = parseArtifactRef(input.ref.trim(), { appHosts: appHosts() });
    if (parsed.kind !== "id") {
      // Not an id or a link that names one: as an id nobody has (the 403 first, so nothing more is told with Artifacts off).
      await requireWebEnabled(reader);
      throw new ArtifactWebFailure(webNotVisible());
    }
    const item = await readableItemFor(reader, parsed.id);
    if (input.homeAllowed && !await input.homeAllowed({ kind: item.homeKind, channelId: item.homeChannelId })) throw new ArtifactWebFailure(webNotVisible());
    const { body, version } = await viewerDataOf(reader, item, input.version ?? parsed.version);

    const path = input.path ?? version.entry;
    if (!isWellFormedArtifactFilePath(path)) throw new ArtifactWebFailure(webInvalidPath(path));
    const found = await versionFileOf(item, version, path);
    if (found.kind === "missing") throw new ArtifactWebFailure(webFileNotFound(path, version.number));
    if (found.kind === "unavailable") throw new ArtifactWebFailure(webContentUnavailable());
    const type = artifactFileType(found.file.path);
    const facts = { path: found.file.path, entry: found.file.path === version.entry, contentType: type.contentType, sizeBytes: found.file.sizeBytes };
    let file: ArtifactReadAsUserFile = { ...facts, kind: "binary" };
    if (type.text) {
      const bytes = await found.reader.read(found.blob);
      if (!bytes) throw new ArtifactWebFailure(webFileNotFound(path, version.number));
      const { content, truncated } = await readTextPrefix(bytes, AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES);
      file = { ...facts, kind: "text", text: content, truncated };
    }

    let comments: ArtifactReadAsUser["comments"];
    if (input.comments) {
      const page = await commentOperations.comments(reader, item.id, input.commentsBefore !== undefined ? { before: input.commentsBefore } : {});
      if (page.kind !== "json") throw new ArtifactWebFailure(page);
      comments = { comments: page.body.comments, olderCursor: page.body.olderCursor };
    }

    const { card } = body;
    return json<ArtifactReadAsUser>({
      item: {
        id: card.id,
        url: card.url,
        title: card.title,
        description: card.description,
        home: card.home,
        author: card.author,
        version: card.version,
        latestVersion: card.latestVersion,
        // Read before the comments: one that arrives during the read is past it and still stops a publish (the safe side).
        position: item.lastPosition,
        commentCount: card.commentCount,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      },
      versions: body.versions,
      files: body.files,
      file,
      ...(comments ? { comments } : {}),
    }, 200);
  });
}

/** readArtifactAsUser as core's registry hands it out (register.ts actingFor): the web refusal's code and sentence only. */
export async function readArtifactAsUserForCore(input: AppReadAsUserInput): Promise<AppReadAsUserAnswer> {
  const answer = await readArtifactAsUser(input);
  return answer.kind === "json"
    ? { kind: "json", status: answer.status ?? 200, body: answer.body }
    : { kind: "error", status: answer.status, body: { code: answer.body.code, error: answer.body.error } };
}
