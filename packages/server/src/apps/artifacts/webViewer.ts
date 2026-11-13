// The web viewer's reads (web API phase 1): `GET /api/artifacts/:id`
// (ArtifactViewerData), a file's bytes and its content as JSON, and presence
// (a publish check's screenshots are core's object files, read through core's
// `GET /api/objects/artifact/:id/files/:fileId`: checks.ts). Every operation resolves the Artifact as a read (webCommon readableItemFor):
// Artifacts on for the deployment (403), then visibility (one 404 NOT_VISIBLE);
// then the version: the current one, or `?version=` among the published ones
// (a reader outside the Artifact's server gets only the current one of a
// members-only-history Artifact, as the frame route; 404 VERSION_NOT_FOUND).
// The viewer also carries the shown version's `frame` for a framed kind
// (readerFrameOf, the frame route's answer), so the first screen needs no
// second request before the content origin. Only the viewer route's own
// answer (viewerAnswerOf, which the standalone page's open route, webOpen.ts,
// answers with in the Artifact's own server): save-attachment's
// (viewerWithoutFrame), `GET /:id/details` (the App's own bar) and the home
// routes' (viewerDataOf) never sign a ticket. `GET /:id/download.zip` is
// every file of the shown version in one zip (versionZip.ts), resolved as a
// file is: the same reader, the same version, the same refusals.
import { and, asc, desc, eq, gte, isNotNull, lt, ne, or } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES,
  ARTIFACT_INLINE_IMAGE_TYPES,
  artifactFileType,
  artifactFramedPagePath,
  asChannelId,
  isArtifactFramedKind,
  isWellFormedArtifactFilePath,
  type ArtifactFramedKind,
  type ArtifactPresence,
  type ArtifactViewerData,
  type ArtifactWebFileContent,
  type ArtifactWebFrame,
} from "@botiverse/raft-shared";
import { artifactContentTicketPage } from "@botiverse/raft-shared/src/artifactContentTicket";
import { attachmentSource } from "../../platform/attachments";
import { getDb } from "../../platform/db";
import {
  accessOf,
  advanceReadPosition,
  byteSize,
  type ArtifactApiBytes,
  type ArtifactApiJson,
  currentVersionOf,
  json,
  readableVersion,
  readTextPrefix,
  takesPartIn,
  versionFileOf,
  versionSummaries,
} from "./apiCommon";
import { attachmentDisposition } from "./blobStore";
import { versionZipOf, zipBaseName } from "./versionZip";
import { isFollowing } from "./comments";
import { contentSubject, contentViewer, signContentFrame } from "./contentWorker";
import { webOriginOf } from "./origin";
import { artifactCardFacts, cardAuthorRef, cardsOf } from "./webCards";
import {
  answerWeb,
  ArtifactWebFailure,
  fileNotFramed,
  profiler,
  readerActor,
  readerViewActor,
  refuse,
  readableItemFor,
  shownActorOf,
  webContentUnavailable,
  webFileNotFound,
  webInvalidPath,
  webFail,
  webVersionNotFound,
  type ArtifactWebApiError,
  type ArtifactWebReader,
} from "./webCommon";
import {
  artifactAttachmentSaves,
  artifactReadPositions,
  artifactVersionFiles,
  artifactVersions,
  type ArtifactItemRow,
  type ArtifactVersionRow,
} from "./schema";
import { mayManageArtifactActions, shownOriginalHome } from "./manage";
import { actorsWhoCanViewArtifact } from "./visibility";

/** At most this many people and agents in presence's `readCurrentVersion`, the latest first. */
const PRESENCE_READERS_SHOWN = 20;

/** `?version=`: absent, or a positive integer (else 400 INVALID_REQUEST). */
export function parseVersionQuery(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) refuse(400, { code: "INVALID_REQUEST", error: "The version asked for isn't a version number: ask for a whole number from 1, or leave it out for the current version." });
  return Number(value);
}

/** The version a request names, or the current one (404 VERSION_NOT_FOUND). */
export async function shownVersionOf(reader: ArtifactWebReader, item: ArtifactItemRow, requested: number | undefined): Promise<{ version: ArtifactVersionRow; current: ArtifactVersionRow | null }> {
  const current = await currentVersionOf(item);
  let version = current;
  if (requested !== undefined && requested !== current?.number) {
    const [row] = accessOf(reader, item).historyLimited
      ? []
      : await getDb().select().from(artifactVersions).where(and(readableVersion(item.id), eq(artifactVersions.number, requested))).limit(1);
    version = row ?? null;
  }
  return { version: shownOrRefused(version, requested, current), current };
}

/** The version shownVersionOf found, or its 404 VERSION_NOT_FOUND. */
function shownOrRefused(version: ArtifactVersionRow | null, requested: number | undefined, current: ArtifactVersionRow | null): ArtifactVersionRow {
  if (!version) {
    throw new ArtifactWebFailure(webVersionNotFound(requested, requested !== undefined ? current?.number : undefined));
  }
  return version!;
}

/**
 * shownVersionOf, and the versions the viewer lists, in one query: every
 * readable version (the newest first), the current and the requested one
 * among them; for a reader limited to the current version
 * (accessOf.historyLimited), only that one.
 */
async function viewerVersionsOf(reader: ArtifactWebReader, item: ArtifactItemRow, requested: number | undefined): Promise<{ version: ArtifactVersionRow; current: ArtifactVersionRow | null; versions: ArtifactVersionRow[] }> {
  if (accessOf(reader, item).historyLimited) {
    const { version, current } = await shownVersionOf(reader, item, requested);
    return { version, current, versions: current ? [current] : [] };
  }
  const versions = await getDb().select().from(artifactVersions).where(readableVersion(item.id)).orderBy(desc(artifactVersions.number));
  // As currentVersionOf and shownVersionOf read them: the item's current version, and a version by number, if readable.
  const current = (item.currentVersionId ? versions.find((row) => row.id === item.currentVersionId) : undefined) ?? null;
  const version = requested === undefined || requested === current?.number ? current : versions.find((row) => row.number === requested) ?? null;
  return { version: shownOrRefused(version, requested, current), current, versions };
}

/**
 * Where a version the reader sees loads on the content origin (S2): its
 * ArtifactWebFrame, the ticket signed here for the reader (viewer
 * `user:<id>`, their subject) with no call to the content Worker. Null for a
 * kind the shell draws, or when the content origin isn't configured. The
 * caller has checked visibility and the version (visibleItemFor,
 * shownVersionOf). The frame route and the viewer's `frame`. `at`: the
 * frame route's alone, another file of the version to open at
 * (`framePageOf`: its page, and its kind for the span); the viewer's `frame`
 * is always the entry's.
 */
export async function readerFrameOf(reader: ArtifactWebReader, item: ArtifactItemRow, version: ArtifactVersionRow, at?: ArtifactFramePage): Promise<ArtifactWebFrame | null> {
  const kind = artifactFileType(version.entry).kind;
  if (!isArtifactFramedKind(kind)) return null;
  return signContentFrame(
    { artifact: item.id, version: version.id, viewer: contentViewer(reader.userId), subject: contentSubject(reader), ...(at === undefined ? {} : { page: at.page }) },
    { kind: at === undefined ? kind : at.kind },
  );
}

/** Another file of a version than its entry, as a frame opens at it: its page (the ticket's `page`) and its kind. */
export interface ArtifactFramePage {
  page: string;
  kind: ArtifactFramedKind;
}

/**
 * Where a frame of `version` opens for the file at `path`
 * (#proj-workspace:#272, a file the reader opened from Files): undefined for
 * the entry itself, else that file's page as an address below the version's
 * base (the ticket's `page`: the file itself for an HTML page, the page the
 * content Worker makes beside a Markdown file or a PDF) and its kind. Throws the route's refusal for anything else: no file
 * path (400 INVALID_PATH), no file of this version (404 FILE_NOT_FOUND), a
 * file of a kind no frame shows (not html, markdown or pdf: shared
 * `artifactFramedPagePath`) or whose path no address names (409 NOT_FRAMED). The
 * caller has checked the version's entry is framed: the content origin opens
 * a version only when its entry is a page.
 */
export async function framePageOf(version: Pick<ArtifactVersionRow, "id" | "number" | "entry">, path: string): Promise<ArtifactFramePage | undefined> {
  if (path === version.entry) return undefined;
  if (!isWellFormedArtifactFilePath(path)) throw new ArtifactWebFailure(webInvalidPath(path));
  const [file] = await getDb().select({ path: artifactVersionFiles.path }).from(artifactVersionFiles)
    .where(and(eq(artifactVersionFiles.versionId, version.id), eq(artifactVersionFiles.path, path)))
    .limit(1);
  if (!file) throw new ArtifactWebFailure(webFileNotFound(path, version.number));
  const { kind } = artifactFileType(path);
  const served = artifactFramedPagePath(path);
  const page = served === null ? null : artifactContentTicketPage(served);
  if (page === null || !isArtifactFramedKind(kind)) throw new ArtifactWebFailure(fileNotFramed(path));
  return { page, kind };
}

/**
 * The type a file's bytes are served with on Raft's own origin. The inline
 * image types as they are (ARTIFACT_INLINE_IMAGE_TYPES, SVG included: the
 * shell draws it as `<img src=blob:>`, which needs its type), csv as csv,
 * other text (html, markdown, xml, scripts) as plain text, anything else as
 * octet-stream. Always as an attachment, with nosniff and a CSP of
 * `default-src 'none'; sandbox` (the router), so even an SVG opened directly
 * runs nothing on this origin.
 */
export function servedContentType(path: string): string {
  const type = artifactFileType(path);
  const bare = type.contentType.split(";")[0]!;
  if ((ARTIFACT_INLINE_IMAGE_TYPES as readonly string[]).includes(bare)) return bare;
  if (type.kind === "csv") return "text/csv; charset=utf-8";
  if (type.text) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/**
 * ArtifactViewerData for a visible item at `requested` (else the current
 * version), as the viewer route answers it; moves no read position unless
 * `advanceRead` (the viewer route; the home routes answer with this alone).
 * Capabilities:
 * `comment` for people of the item's server (never a reader outside it,
 * who reads only a public Artifact); `changeHome` and `delete` by
 * mayManageArtifact (manage.ts: a guest deletes their own, never widens it),
 * `changeHome` only while a larger home exists, `unpublish` (the same people)
 * only while it is public, `narrowHome` (the same people) only while its home
 * is the server or public and `originalHome` is set (#75: manage.ts
 * shownOriginalHome, its original conversation still there and seen by the
 * reader); `publish` (renaming it: rename.ts mayRename's rule, a non-guest
 * member of its own server or its author, answered from delete's and widen's
 * standing read, mayManageArtifactActions `rename`; pushing a version is the
 * agents').
 *
 * Its reads are made at once: what needs only the item (the card's comment
 * count and home, capabilities, the original home, following, savedFrom,
 * origin) beside the versions, then what needs the shown version (its files,
 * the names, the versions' changed paths) and the read position's move.
 */
export async function viewerDataOf(
  reader: ArtifactWebReader,
  item: ArtifactItemRow,
  requested: number | undefined,
  opts: { advanceRead?: boolean } = {},
): Promise<{ body: ArtifactViewerData; version: ArtifactVersionRow; current: ArtifactVersionRow | null }> {
  const access = accessOf(reader, item);
  const takesPart = await takesPartIn(readerViewActor(reader), item);
  const pinned = requested !== undefined;
  // The one conversation a narrowing may return it to (#75), read beside the rest; used only for one who may move it.
  const mayHaveOriginal = access.inside && item.homeKind !== "conversation" && item.originalHomeChannelId !== null;
  const [shown, facts, [deletes, widens, renames], seenOriginal, following, savedFrom, origin] = await Promise.all([
    shownWithVersions(reader, item, requested, opts.advanceRead === true && takesPart),
    // The card's screenshots by the version asked (null: the current one), read beside the versions.
    artifactCardFacts(reader, [item], [{ item, number: requested ?? null }]),
    // One standing read for the three (rename: rename.ts mayRename's rule; outside its server none, as mayPublish).
    access.inside ? mayManageArtifactActions(readerViewActor(reader), item, ["delete", "widen", "rename"]) : [false, false, false],
    mayHaveOriginal ? shownOriginalHome(readerViewActor(reader), item) : null,
    takesPart ? isFollowing(item.id, readerActor(reader)) : false,
    savedFromOf(reader, item),
    webOriginOf(reader, item),
  ]);
  const { version, current, files, actorOf, versions } = shown;
  // The card as the summaries build it (webCards.ts), so a message's card and the viewer's are the same.
  const [card] = cardsOf(reader, [{ item, version, current, pinned }], actorOf, facts);
  // Who may delete it and may widen it differ only for a guest. Widening needs a larger home; making it private again (unpublish) the same people, while it is public.
  const manages = deletes! && widens!;
  const originalHome = manages ? seenOriginal : null;
  const body: ArtifactViewerData = {
    card: card!,
    files: files.map((file) => ({ path: file.path, kind: artifactFileType(file.path).kind, sizeBytes: file.sizeBytes, entry: file.path === version.entry })),
    versions: versions.map((summary) => ({ ...summary, publisher: shownActorOf(reader, item, actorOf(summary.publisher)) })),
    capabilities: {
      publish: renames!,
      comment: takesPart,
      changeHome: manages && item.homeKind !== "public",
      unpublish: manages && item.homeKind === "public",
      narrowHome: originalHome !== null,
      delete: deletes!,
    },
    viewer: actorOf(readerActor(reader)),
    following,
    savedFrom,
    origin,
    originalHome: originalHome === null ? null : { conversationId: asChannelId(originalHome) },
  };
  return { body, version, current };
}

/**
 * viewerDataOf's reads that need the shown version: the version
 * (viewerVersionsOf), then at once its files, the names (the author, the
 * card's, the reader, the publishers: one lookup) and the versions' summaries
 * (publishers as refs, named by the caller), with the read position moved
 * beside them when `advanceRead` and the current version is shown.
 */
async function shownWithVersions(reader: ArtifactWebReader, item: ArtifactItemRow, requested: number | undefined, advanceRead: boolean) {
  const access = accessOf(reader, item);
  const { version, current, versions } = await viewerVersionsOf(reader, item, requested);
  const pinned = requested !== undefined;
  const [files, actorOf, summaries] = await Promise.all([
    getDb().select().from(artifactVersionFiles).where(eq(artifactVersionFiles.versionId, version.id)).orderBy(asc(artifactVersionFiles.path)),
    profiler([
      { type: item.createdByType, id: item.createdById },
      cardAuthorRef({ item, version, pinned }),
      readerActor(reader),
      ...versions.map((row) => ({ type: row.publisherType, id: row.publisherId })),
    ]),
    versionSummaries(item, versions, (publisher) => publisher, access.historyLimited, access.historyLimited ? undefined : versions),
    // Opening the current version is looking at everything up to now (as an agent's read); presence reads it.
    advanceRead && version.id === current?.id ? advanceReadPosition(readerActor(reader), item.id, item.lastPosition) : null,
  ]);
  return { version, current, files, actorOf, versions: summaries };
}

/**
 * The attachment the Artifact was saved from, when the reader (inside its
 * server) can see that message's conversation (platform/attachments
 * attachmentSource: a live attachment, its message's conversation as the
 * reader's server shows it).
 */
async function savedFromOf(reader: ArtifactWebReader, item: ArtifactItemRow): Promise<ArtifactViewerData["savedFrom"]> {
  if (!accessOf(reader, item).inside) return null;
  const [save] = await getDb().select({ attachmentId: artifactAttachmentSaves.attachmentId }).from(artifactAttachmentSaves)
    .where(eq(artifactAttachmentSaves.itemId, item.id)).orderBy(asc(artifactAttachmentSaves.createdAt)).limit(1);
  if (!save) return null;
  const source = await attachmentSource(readerViewActor(reader), save.attachmentId);
  return source ? { attachmentId: save.attachmentId, messageId: source.messageId, conversationId: source.channelId } : null;
}

/**
 * The viewer route's checks and answer before its `frame` (visibility, the
 * version, ArtifactViewerData), with the read position moved as opening the
 * current version moves it.
 */
async function openViewer(reader: ArtifactWebReader, id: string, query: { version?: unknown }) {
  return openReadable(reader, await readableItemFor(reader, id), query);
}

/** openViewer for an item the caller resolved with readableItemFor for this reader. */
async function openReadable(reader: ArtifactWebReader, item: ArtifactItemRow, query: { version?: unknown }) {
  const { body, version } = await viewerDataOf(reader, item, parseVersionQuery(query.version), { advanceRead: true });
  return { body, item, version };
}

/**
 * The viewer route's answer for an item the caller resolved with
 * readableItemFor for this reader: the version (`?version=`), the read
 * position moved, and the shown version's `frame` (its ticket). The viewer
 * route, and the standalone page's open route (webOpen.ts) in the
 * Artifact's own server.
 */
export async function viewerAnswerOf(reader: ArtifactWebReader, item: ArtifactItemRow, query: { version?: unknown }): Promise<ArtifactViewerData> {
  const { body, version } = await openReadable(reader, item, query);
  // Only the viewer's own answer carries the frame (its ticket); see ArtifactViewerData.frame.
  const frame = await readerFrameOf(reader, item, version);
  return frame ? { ...body, frame } : body;
}

export function createViewerOperations() {
  /** The file at `path` of the shown version, and its blob's reader. */
  async function fileOf(reader: ArtifactWebReader, id: string, path: string, query: { version?: unknown }) {
    const item = await readableItemFor(reader, id);
    if (!isWellFormedArtifactFilePath(path)) throw new ArtifactWebFailure(webInvalidPath(path));
    const { version } = await shownVersionOf(reader, item, parseVersionQuery(query.version));
    const missing = (): never => {
      throw new ArtifactWebFailure(webFileNotFound(path, version.number));
    };
    const found = await versionFileOf(item, version, path);
    if (found.kind === "missing") return missing();
    if (found.kind === "unavailable") throw new ArtifactWebFailure(webContentUnavailable());
    return { ...found, version, missing };
  }

  return {
    viewer: (reader: ArtifactWebReader, id: string, query: { version?: unknown }): Promise<ArtifactApiJson<ArtifactViewerData> | ArtifactWebApiError> => answerWeb(async () =>
      json(await viewerAnswerOf(reader, await readableItemFor(reader, id), query))),

    /** `GET /:id/details`: the viewer's answer without `frame` (no ticket signed), and no read position moved. */
    details: (reader: ArtifactWebReader, id: string, query: { version?: unknown }): Promise<ArtifactApiJson<ArtifactViewerData> | ArtifactWebApiError> => answerWeb(async () =>
      json((await viewerDataOf(reader, await readableItemFor(reader, id), parseVersionQuery(query.version))).body)),

    /** The viewer's answer without `frame` (no ticket signed): what save-attachment answers the Artifact with. */
    viewerWithoutFrame: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<ArtifactViewerData> | ArtifactWebApiError> => answerWeb(async () =>
      json((await openViewer(reader, id, {})).body)),

    file: (reader: ArtifactWebReader, id: string, path: string, query: { version?: unknown }): Promise<ArtifactApiBytes | ArtifactWebApiError> => answerWeb(async () => {
      const { file, blob, reader: blobReader, missing } = await fileOf(reader, id, path, query);
      const bytes = await blobReader.read(blob);
      if (!bytes) return missing();
      return {
        kind: "bytes" as const,
        stream: bytes.stream,
        size: bytes.size,
        contentType: servedContentType(file.path),
        contentDisposition: attachmentDisposition(file.path),
      };
    }),

    /**
     * Every file of the shown version (the current one, or `?version=` as
     * the file route reads it) in one zip, paths as published, named by the
     * title and the version (`Title v3.zip`). The same reader check and
     * refusals as a file (readableItemFor: 403 with the flag off, the one 404
     * NOT_VISIBLE; 400 INVALID_REQUEST, 404 VERSION_NOT_FOUND), then
     * versionZip's: over ARTIFACT_ZIP_MAX_BYTES of files 413
     * DOWNLOAD_TOO_LARGE { limit }, a file not in storage 503
     * CONTENT_UNAVAILABLE, past the web pool's archives at once 429 BUSY
     * with Retry-After. A read: no write budget, no read position moved.
     */
    downloadZip: (reader: ArtifactWebReader, id: string, query: { version?: unknown }): Promise<ArtifactApiBytes | ArtifactWebApiError> => answerWeb(async () => {
      const item = await readableItemFor(reader, id);
      const { version } = await shownVersionOf(reader, item, parseVersionQuery(query.version));
      const zip = await versionZipOf(item, version, { pool: "web", fileName: `${zipBaseName(item)} v${version.number}.zip` });
      switch (zip.kind) {
        case "bytes": return zip;
        case "unavailable": return webContentUnavailable();
        case "too_large": return webFail(413, {
          code: "DOWNLOAD_TOO_LARGE",
          error: `This artifact's files are over ${byteSize(zip.limit)} together, too large to download as one zip: download its files one by one from Files instead.`,
          details: { limit: zip.limit },
        });
        case "busy": return webFail(429, {
          code: "BUSY",
          error: "Too many downloads are being prepared on this server right now: wait a few seconds, then download it again.",
          retryAfterSeconds: zip.retryAfterSeconds,
        });
      }
    }),

    /** Text and csv inline (cut at 256 KiB); any other kind only by size and type, never its bytes. */
    fileContent: (reader: ArtifactWebReader, id: string, path: string, query: { version?: unknown }): Promise<ArtifactApiJson<ArtifactWebFileContent> | ArtifactWebApiError> => answerWeb(async () => {
      const { file, blob, version, reader: blobReader, missing } = await fileOf(reader, id, path, query);
      const type = artifactFileType(file.path);
      const facts = { path: file.path, version: version.number, size: file.sizeBytes, contentType: type.contentType };
      if (type.kind !== "text" && type.kind !== "csv") return json<ArtifactWebFileContent>({ kind: "binary", ...facts });
      const bytes = await blobReader.read(blob);
      if (!bytes) return missing();
      const { content, truncated } = await readTextPrefix(bytes, AGENT_API_ARTIFACT_TEXT_CONTENT_MAX_BYTES);
      return json<ArtifactWebFileContent>({ kind: "text", ...facts, content, truncated });
    }),

    /**
     * Who is looking now and who has read the current version. `viewing`
     * needs the socket layer (`artifact:presence`), which doesn't exist yet:
     * always empty. `readCurrentVersion`: people and agents of the Artifact's
     * server, other than the reader, whose read position is at or past the
     * current version (they opened it, or an agent read it, since it became
     * current) and who can still see it. `readOtherVersion`: the same, for
     * those whose read position is before the current version, each with the
     * last version it had reached (the newest readable version that became
     * current at or before its position). `ownRead`: the reader's own position the
     * same way (task #136), null when it has none. Nothing for a reader
     * outside the Artifact's server.
     */
    presence: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<ArtifactPresence> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await readableItemFor(reader, id);
      const current = accessOf(reader, item).inside ? await currentVersionOf(item) : null;
      if (!current) return json<ArtifactPresence>({ viewing: [], readCurrentVersion: [], readOtherVersion: [] });
      const others = or(ne(artifactReadPositions.actorType, "user"), ne(artifactReadPositions.actorId, reader.userId));
      const [mine] = await getDb().select({ position: artifactReadPositions.position, updatedAt: artifactReadPositions.updatedAt })
        .from(artifactReadPositions)
        .where(and(eq(artifactReadPositions.itemId, item.id), eq(artifactReadPositions.actorType, "user"), eq(artifactReadPositions.actorId, reader.userId)))
        .limit(1);
      const latest = await getDb().select().from(artifactReadPositions).where(and(
        eq(artifactReadPositions.itemId, item.id),
        gte(artifactReadPositions.position, current.position!),
        others,
      )).orderBy(desc(artifactReadPositions.updatedAt)).limit(PRESENCE_READERS_SHOWN);
      const earlier = await getDb().select().from(artifactReadPositions).where(and(
        eq(artifactReadPositions.itemId, item.id),
        lt(artifactReadPositions.position, current.position!),
        others,
      )).orderBy(desc(artifactReadPositions.updatedAt)).limit(PRESENCE_READERS_SHOWN);
      // The versions in the order they became current: a position falls after the last one at or before it.
      const mineEarlier = mine !== undefined && mine.position < current.position!;
      const versions = earlier.length === 0 && !mineEarlier ? [] : await getDb().select({ number: artifactVersions.number, position: artifactVersions.position })
        .from(artifactVersions)
        .where(and(readableVersion(item.id), isNotNull(artifactVersions.position)))
        .orderBy(asc(artifactVersions.position));
      const versionAt = (position: number): number | null => {
        let found: number | null = null;
        for (const version of versions) {
          if (version.position! > position) break;
          found = version.number;
        }
        return found;
      };
      const rows = [...latest, ...earlier];
      const answers = await actorsWhoCanViewArtifact(rows.map((row) => ({ type: row.actorType, id: row.actorId, serverId: item.serverId })), item, { requireStanding: true });
      const seeing = rows.filter((_, index) => answers[index]);
      const actorOf = await profiler(seeing.map((row) => ({ type: row.actorType, id: row.actorId })));
      const entry = (row: (typeof rows)[number]) => ({ actor: actorOf({ type: row.actorType, id: row.actorId }), at: row.updatedAt.toISOString() });
      // One that no longer exists (a deleted agent) has no name.
      const named = (shown: { actor: { name: string } }) => shown.actor.name !== "";
      const onCurrent = new Set(latest);
      // The reader's own: the current version when at or past it, else the last one it reached (none before the first).
      const ownVersion = mine === undefined ? null : mineEarlier ? versionAt(mine.position) : current.number;
      const ownRead = mine === undefined || ownVersion === null ? null : { version: ownVersion, at: mine.updatedAt.toISOString() };
      return json<ArtifactPresence>({
        ownRead,
        viewing: [],
        readCurrentVersion: seeing.filter((row) => onCurrent.has(row)).map(entry).filter(named),
        readOtherVersion: seeing
          .filter((row) => !onCurrent.has(row))
          .flatMap((row) => {
            const version = versionAt(row.position);
            return version === null ? [] : [{ ...entry(row), version }];
          })
          .filter(named),
      });
    }),
  };
}
