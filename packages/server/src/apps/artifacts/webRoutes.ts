// The web API for Workspace Artifacts, `/api/artifacts/*` (contract:
// packages/shared webArtifactsContract.ts). mount.ts registers its operations
// with core, which mounts them behind the web app's auth and server scoping
// and supplies the agent event queue notices go through. Names and avatars,
// conversation names, candidates for `@` and attachments come from
// packages/server/src/platform. Each
// operation answers JSON, bytes, nothing, or an error code; core writes it.
// Every operation checks first that Artifacts is on for the deployment (403
// ARTIFACTS_NOT_ENABLED), then visibility: anything the reader can't see is
// one 404 NOT_VISIBLE. Route by route:
// - readableItemFor (reads): `GET /:id` (the viewer; its `capabilities`
//   offer no write to a reader outside the item's server),
//   `GET /:id/files/:path` and `/content`, `POST /:id/frame`,
//   `GET /:id/comments` (none for an outsider), `GET /:id/presence` (none
//   for an outsider), and the refusal of an undecodable path (below);
// - visibleItemFor (the same answer): every write (comments, following,
//   review drafts and reviews, sending, the home route, unpublishing,
//   deleting) and the write-side reads (`@` candidates, will-notify, review
//   drafts, share-audience, home-change);
// - `GET /:id/locate` (webLocate.ts) names the server of the reader's the
//   Artifact opens in, reading each candidate server (one may be deleted).
// - `GET /:id/open` (webOpen.ts), the standalone page's one call, is
//   core's account route (no server scoping): readableItemFor in the
//   Artifact's own server for a member, else a public Artifact read as an
//   outsider; one 404 otherwise.
//
// S2: the frame route (docs/development/workspace-artifacts-content-origin.md,
// "Flow" step 1). Web API phase 1: the viewer, files and presence
// (webViewer.ts), comments, `@` candidates, who a comment would notify and
// following (webComments.ts). S8: review drafts and submitting a review
// (webReviews.ts). S7: the dashboard, the
// reader's waiting, following and recent Artifacts, and its All tab, every
// Artifact the reader can see (webDashboard.ts). S5:
// sending to a conversation, its audience, saving an attachment and what
// attachments were saved as (webShare.ts). Where an Artifact's canonical
// link opens, which of the reader's servers (webLocate.ts). The Artifacts
// that live in a conversation, its Files panel (webConversation.ts).
// Moving an Artifact to another home and deleting it (manage.ts, which
// holds the rule and the checks after the flag):
// - `POST /api/artifacts/:id/home { to, conversationId? }`: the flag (403),
//   visibility (one 404 NOT_VISIBLE), the body ArtifactWebHomeInput (400
//   INVALID_REQUEST), then by `expectedLost` (`narrows`): with it,
//   narrowArtifactHome (who may: 403 FORBIDDEN; a smaller home: 409 HOME_NOT_NARROWER; the
//   conversation only the original one, #75: 409 NOT_ORIGINAL_HOME
//   { originalConversationId }; the conversation: 404 TARGET_NOT_FOUND, 400 TARGET_NOT_SUPPORTED, 403
//   TARGET_HAS_GUESTS; its author keeps it: 409 AUTHOR_LOSES_ACCESS; the
//   name: 409 NAME_TAKEN; `expectedLost` given and no longer the count: 409
//   LOSS_CHANGED), whose forgotten Activity rows are announced after
//   its commit; without it a move only widens (Kirby, #45): `to:
//   "conversation"` from one who may move it (else 403 FORBIDDEN) 409
//   HOME_NOT_WIDER { home, to }, anything else
//   widenArtifactHome: who may (403 FORBIDDEN), the home only grows (409
//   HOME_NOT_WIDER { home, to }, also `"server"` for a public Artifact), the
//   name free in the larger home (409 NAME_TAKEN { name }). Answers ArtifactViewerData of
//   the current version, moving no read position.
// - `GET /api/artifacts/:id/home-change?to=…&conversationId=…`: the flag,
//   visibility, the query (400 INVALID_REQUEST), then previewNarrowing:
//   narrowArtifactHome's checks and refusals without the lock or a write,
//   and how many of the server's people and agents would lose it.
// - `POST /api/artifacts/:id/unpublish` (body not read): the flag (403),
//   visibility (the one 404), then unpublishArtifact: who may (the same as
//   making it public: 403 FORBIDDEN), its home public (409 NOT_PUBLIC
//   { home }), the name free in the server home (409 NAME_TAKEN { name }).
//   Answers ArtifactViewerData of the current version, moving no read
//   position.
// - `PATCH /api/artifacts/:id/title { title }` (rename.ts): the flag (403),
//   visibility (the one 404), the body ArtifactWebTitleInput (400
//   INVALID_REQUEST, a blank title too; 400 FIELD_TOO_LONG past
//   AGENT_API_ARTIFACT_MAX_TITLE_CHARS, counted as sent), then
//   renameArtifact: under the item's lock, seen still (the one 404) and who
//   may (mayPublish, the Artifact's own server: 403 FORBIDDEN); the same
//   title writes nothing; while it is a channel's announcement, only who may
//   set that channel's announcement (403 CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN
//   { channel, title }). Answers ArtifactViewerData of the current version,
//   moving no read position.
// - `DELETE /api/artifacts/:id`: the flag (403), then deleteArtifact: who
//   may, whether or not they see it (one who may not: 403 FORBIDDEN if they
//   see it, else the one 404); people's Activity rows for it go in its
//   transaction, and their clients are told after it (activity:changed).
//   Answers 204.
// - `POST /api/artifacts/:id/takedown { reason }` and `POST
//   /api/artifacts/:id/restore { reason }` (takedown.ts, moderation): the
//   flag (403), the body (400 INVALID_REQUEST), then who may: the owners
//   and admins of the Artifact's own server, whether or not they see it
//   (one who may not: 403 FORBIDDEN if they see it, else the one 404; a
//   taken-down one nobody sees); a restore whose name was taken meanwhile
//   409 NAME_TAKEN. Idempotent (`changed: false`). A takedown's forgotten
//   Activity rows are announced after its commit. Answers ArtifactWebTakedown.
//
// `POST /api/artifacts/:id/frame { version?, path? }` checks, in this order:
// 1-2. the Artifact (readableItemFor): Artifacts on for the deployment (403
//    ARTIFACTS_NOT_ENABLED), then seen by the reader (canViewArtifacts) while
//    its own server still exists, else one 404 NOT_VISIBLE for every reason;
// 3. the body: `{}`, `{ version: <positive integer> }`, `{ path: <string> }` or
//    both (400 INVALID_REQUEST);
// 4. the version: the current one, or `version` among the published ones (a
//    reader outside the Artifact's server gets only the current one of a
//    members-only-history Artifact; 404 VERSION_NOT_FOUND). The reader stands
//    in `reader.serverId`: core's requireServer checks the membership on
//    every request, so "inside" is a live membership, never a claim;
// 5. its kind, from the entry (artifactFileType): only ARTIFACT_FRAMED_KINDS
//    (409 NOT_FRAMED);
// 5a. `path`, when it names another file than the entry (#proj-workspace:#272,
//    webViewer.ts framePageOf): a file path (400 INVALID_PATH), of this version
//    (404 FILE_NOT_FOUND), an HTML page, a Markdown file or a PDF (409
//    NOT_FRAMED); the frame then opens at that file's page, its tickets naming
//    it (`page`);
// 6. the frame, its ticket signed here (contentWorker.ts signContentFrame,
//    the same as the viewer's `frame`): no call to the content Worker (503
//    CONTENT_UNAVAILABLE when the content origin isn't configured).
import {
  AGENT_API_ARTIFACT_MAX_TITLE_CHARS,
  artifactFileType,
  asChannelId,
  channelAnnouncementChangeForbiddenText,
  isArtifactFramedKind,
  type ArtifactViewerData,
  type ArtifactWebFrame,
  type ArtifactWebFrameInput,
  type ArtifactWebHomeChange,
  type ArtifactWebHomeInput,
  type ArtifactWebTakedown,
  type ArtifactWebTitleInput,
} from "@botiverse/raft-shared";
import { json, type ArtifactApiEmpty, type ArtifactApiJson, type ArtifactNoticeOutbox } from "./apiCommon";
import {
  announceForgottenActivity,
  deleteArtifact,
  mayNotMove,
  narrowArtifactHome,
  previewNarrowing,
  unpublishArtifact,
  widenArtifactHome,
  type ArtifactNarrowerHome,
} from "./manage";
import {
  answerWeb,
  readableItemFor,
  readerViewActor,
  requireWebEnabled,
  notFramed,
  visibleItemFor,
  webBadBody as badBody,
  webFail as fail,
  webInvalidPath,
  webManageRefusal,
  type ArtifactWebApiError,
  type ArtifactWebReader,
} from "./webCommon";
import { createImportOperations } from "./import";
import { renameArtifact, storedTitle } from "./rename";
import { restoreArtifact, takedownAnswer, takedownArtifact, takedownReason } from "./takedown";
import { createConversationOperations } from "./webConversation";
import { createDashboardOperations } from "./webDashboard";
import { createLocateOperations } from "./webLocate";
import { createOpenOperations } from "./webOpen";
import { createWebCommentOperations } from "./webComments";
import { createWebCommentImageOperations } from "./commentImages";
import { createWebReviewOperations } from "./webReviews";
import { createShareOperations } from "./webShare";
import { createViewerOperations, framePageOf, readerFrameOf, shownVersionOf, viewerDataOf } from "./webViewer";

// For mount.ts and this module's tests.
export { checkContentWorkerConfig } from "./contentWorker";
export type { ArtifactActorRef, ArtifactApiBytes, ArtifactNoticeOutbox } from "./apiCommon";
export type { ArtifactWebApiError, ArtifactWebReader } from "./webCommon";

/**
 * The frame route's body, or null when it is anything but `{}`, `{ version: <positive integer> }`,
 * `{ path: <string> }` or both (whether `path` is a file of the version is checked with the version: `framePageOf`).
 */
function parseFrameInput(body: unknown): ArtifactWebFrameInput | null {
  // No body at all (no JSON content type) reads as `{}`.
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { version, path, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (version !== undefined && !(typeof version === "number" && Number.isSafeInteger(version) && version > 0)) return null;
  if (path !== undefined && typeof path !== "string") return null;
  return { ...(version === undefined ? {} : { version }), ...(path === undefined ? {} : { path }) };
}

/**
 * The home route's body (ArtifactWebHomeInput): exactly `{ to: "server" |
 * "public" }` or `{ to: "conversation", conversationId }`, else null.
 */
function parseHomeInput(body: unknown): ArtifactWebHomeInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { to, conversationId, expectedLost, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (expectedLost !== undefined && !(typeof expectedLost === "number" && Number.isSafeInteger(expectedLost) && expectedLost >= 0)) return null;
  const expected = expectedLost === undefined ? {} : { expectedLost };
  if (to === "conversation") return typeof conversationId === "string" && conversationId !== "" ? { to, conversationId: asChannelId(conversationId), ...expected } : null;
  if (conversationId !== undefined) return null;
  if (to === "server") return { to, ...expected };
  return to === "public" && expectedLost === undefined ? { to } : null;
}

/** The title route's body: exactly ArtifactWebTitleInput, else null. */
function parseTitleInput(body: unknown): ArtifactWebTitleInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { title, ...rest } = body as Record<string, unknown>;
  return Object.keys(rest).length === 0 && typeof title === "string" ? { title } : null;
}

/**
 * Whether a move is a narrowing: only with `expectedLost`, the count the
 * mover confirmed from the preview (so a home changed since the preview is
 * refused, never widened). Without it a move only widens (Kirby, #45: a
 * stale chip's `to: "server"` on a public Artifact must not narrow it):
 * widenArtifactHome refuses anything not larger (HOME_NOT_WIDER), and `to:
 * "conversation"`, never larger, is refused before it. The home route's
 * split; each side checks again under the item's lock.
 */
const narrows = (input: ArtifactWebHomeInput): boolean => input.to !== "public" && input.expectedLost !== undefined;

/** The smaller home a narrowing input names. */
const narrowerHome = (input: ArtifactWebHomeInput): ArtifactNarrowerHome =>
  input.to === "conversation" ? { kind: "conversation", conversationId: input.conversationId } : { kind: "server" };

/** The narrowing preview's query: `to=server`, or `to=conversation&conversationId=…`, else null. */
function parseHomeChangeQuery(query: Record<string, unknown>): ArtifactNarrowerHome | null {
  const { to, conversationId } = query;
  if (to === "server" && conversationId === undefined) return { kind: "server" };
  if (to === "conversation" && typeof conversationId === "string" && conversationId !== "") return { kind: "conversation", conversationId };
  return null;
}

export function createArtifactWebApi() {
  // Saving an attachment answers the Artifact as the viewer does, but without `frame`: a ticket only in the viewer route's own answer.
  const { viewerWithoutFrame, ...viewerOperations } = createViewerOperations();
  return {
    ...viewerOperations,
    ...createShareOperations(viewerWithoutFrame),
    ...createWebCommentOperations(),
    ...createWebCommentImageOperations(),
    ...createWebReviewOperations(),
    ...createDashboardOperations(),
    ...createConversationOperations(),
    ...createLocateOperations(),
    ...createOpenOperations(),
    webImport: createImportOperations().webImport,

    /**
     * A request whose path segment isn't valid percent-encoding (the router
     * couldn't decode it): the Artifact first as the read routes resolve it
     * (readableItemFor: Artifacts on for the deployment, then
     * visibility), then 400 INVALID_PATH for a file path
     * (`rawPath`, as sent), else INVALID_REQUEST. It writes nothing.
     */
    undecodable: async (reader: ArtifactWebReader, id: string, rawPath: string | null): Promise<ArtifactWebApiError> => {
      const refused = await answerWeb(async () => {
        await readableItemFor(reader, id);
        return rawPath === null
          ? fail(400, { code: "INVALID_REQUEST", error: "Part of this address isn't valid percent-encoding, so it names nothing: check the link, or open the artifact from where it was shared." })
          : webInvalidPath(rawPath);
      });
      return refused;
    },

    frame: (reader: ArtifactWebReader, id: string, body: unknown): Promise<ArtifactApiJson<ArtifactWebFrame> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await readableItemFor(reader, id);
      const input = parseFrameInput(body);
      if (!input) return badBody("{}, { version: <a whole number from 1> }, { path: <a file of the version> } or both");
      const { version } = await shownVersionOf(reader, item, input.version);
      if (!isArtifactFramedKind(artifactFileType(version.entry).kind)) return notFramed();
      const at = input.path === undefined ? undefined : await framePageOf(version, input.path);
      const frame = await readerFrameOf(reader, item, version, at);
      if (!frame) return fail(503, {
        code: "CONTENT_UNAVAILABLE",
        error: "This server can't show artifact pages right now because its content origin isn't set up: download the files instead, or try again later.",
      });
      return { kind: "json" as const, body: frame };
    }),

    home: (reader: ArtifactWebReader, id: string, body: unknown): Promise<ArtifactApiJson<ArtifactViewerData> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      const input = parseHomeInput(body);
      if (!input) return badBody("{ to: \"server\" | \"public\" } or { to: \"conversation\", conversationId, expectedLost }");
      if (narrows(input)) {
        const narrowed = await narrowArtifactHome(readerViewActor(reader), id, narrowerHome(input), input.to === "public" ? {} : { expectedLost: input.expectedLost });
        if (narrowed.kind !== "moved") return webManageRefusal(narrowed);
        announceForgottenActivity(narrowed.forgotten);
        return json((await viewerDataOf(reader, narrowed.item, undefined)).body);
      }
      if (input.to === "conversation") {
        // Who may comes first, as from either move: 403 before the 409.
        const refusal = await mayNotMove(readerViewActor(reader), item);
        if (refusal) return webManageRefusal(refusal);
        return fail(409, {
          code: "HOME_NOT_WIDER",
          error: "A conversation is never a wider home: to move this artifact back to a conversation, confirm who would lose access first, then move it again.",
          details: { home: item.homeKind, to: input.to },
        });
      }
      const result = await widenArtifactHome(readerViewActor(reader), id, input.to);
      if (result.kind !== "moved") return webManageRefusal(result);
      return json((await viewerDataOf(reader, result.item, undefined)).body);
    }),

    homeChange: (reader: ArtifactWebReader, id: string, query: Record<string, unknown>): Promise<ArtifactApiJson<ArtifactWebHomeChange> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await visibleItemFor(reader, id);
      const to = parseHomeChangeQuery(query);
      if (!to) return fail(400, { code: "INVALID_REQUEST", error: "This preview asks for no home it can show: ask with to=server, or to=conversation and a conversationId, after reloading the page." });
      const preview = await previewNarrowing(readerViewActor(reader), item, to);
      if (preview.kind !== "impact") return webManageRefusal(preview);
      const { impact } = preview;
      return json<ArtifactWebHomeChange>({
        peopleLosingAccess: impact.people,
        agentsLosingAccess: impact.agents,
        ...(impact.capped ? { capped: true } : {}),
        leavesPublic: impact.leavesPublic,
      });
    }),

    unpublish: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<ArtifactViewerData> | ArtifactWebApiError> => answerWeb(async () => {
      await visibleItemFor(reader, id);
      const result = await unpublishArtifact(readerViewActor(reader), id);
      if (result.kind !== "moved") return webManageRefusal(result);
      return json((await viewerDataOf(reader, result.item, undefined)).body);
    }),

    rename: (reader: ArtifactWebReader, id: string, body: unknown, outbox: ArtifactNoticeOutbox): Promise<ArtifactApiJson<ArtifactViewerData> | ArtifactWebApiError> => answerWeb(async () => {
      await visibleItemFor(reader, id);
      const input = parseTitleInput(body);
      const limit = AGENT_API_ARTIFACT_MAX_TITLE_CHARS;
      if (input && Array.from(input.title).length > limit) {
        return fail(400, { code: "FIELD_TOO_LONG", error: `A title can be at most ${limit} characters: shorten it and save again.`, details: { field: "title", limit } });
      }
      const title = input ? storedTitle(input.title) : "";
      if (title === "") return fail(400, { code: "INVALID_REQUEST", error: "A title can't be blank: give the artifact a title with words in it." });
      const result = await renameArtifact(readerViewActor(reader), id, title, outbox);
      if (result.kind === "channel_announcement") {
        const text = channelAnnouncementChangeForbiddenText(result.channel);
        return fail(403, { code: "CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN", error: text.message, suggestedNextAction: text.nextAction, details: { channel: result.channel, title: result.title } });
      }
      if (result.kind !== "done") return webManageRefusal(result);
      return json((await viewerDataOf(reader, result.item, undefined)).body);
    }),

    deleteArtifact: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiEmpty | ArtifactWebApiError> => answerWeb(async () => {
      await requireWebEnabled(reader);
      const result = await deleteArtifact(readerViewActor(reader), id);
      if (result.kind !== "deleted") return webManageRefusal(result);
      announceForgottenActivity(result.forgotten);
      return { kind: "empty" as const };
    }),

    takedown: (reader: ArtifactWebReader, id: string, body: unknown): Promise<ArtifactApiJson<ArtifactWebTakedown> | ArtifactWebApiError> =>
      moderate(reader, id, body, takedownArtifact),

    restore: (reader: ArtifactWebReader, id: string, body: unknown): Promise<ArtifactApiJson<ArtifactWebTakedown> | ArtifactWebApiError> =>
      moderate(reader, id, body, restoreArtifact),
  };
}

/** The takedown and restore routes (the header's checks; takedown.ts holds the rule). */
function moderate(
  reader: ArtifactWebReader,
  id: string,
  body: unknown,
  act: typeof takedownArtifact,
): Promise<ArtifactApiJson<ArtifactWebTakedown> | ArtifactWebApiError> {
  return answerWeb(async () => {
    await requireWebEnabled(reader);
    // Exactly ArtifactWebTakedownInput.
    const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const recorded = input && Object.keys(input).every((key) => key === "reason") ? takedownReason(input.reason) : null;
    if (recorded === null) return fail(400, { code: "INVALID_REQUEST", error: "A takedown or restore needs a reason of 1 to 1000 characters: write why, then send it again." });
    const result = await act({ kind: "member", actor: readerViewActor(reader) }, id, recorded);
    if (result.kind !== "done") return webManageRefusal(result);
    announceForgottenActivity(result.forgotten);
    return json(takedownAnswer(result));
  });
}

export type ArtifactWebApi = ReturnType<typeof createArtifactWebApi>;
