// Signed-out viewing of public Artifacts (v1; contract: packages/shared
// publicArtifactsContract.ts), `/api/public/artifacts/*`. mount.ts registers
// these with core's signed-out mount (platform/apps PublicWebApiMount): no
// auth, the operations get the path's id and nothing else (no header,
// cookie, query or body), every answer `private, no-store` and noindex, no
// cookie set, each route limited per client address.
//
// Both routes check, in this order, and answer the one 404 NOT_VISIBLE
// (the signed-in routes' body) for every failure:
// 1. the id is an Artifact id (`pt_<uuid>`), and such an item exists;
// 2. it isn't deleted or revoked and its home is public
//    (canViewArtifactsAnonymously: a conversation or server home never);
// 3. it has a current version (a published one);
// 4. its own server isn't deleted and has workspace_artifacts_v0 on
//    (apiCommon itemServerEnabled).
// Then:
// - `GET /:id` answers ArtifactPublicView, exactly its fields: the current
//   version only, no comments, history, home, server, presence or author.
// - `POST /:id/frame` signs an anonymous frame of the current version (no
//   call to the content Worker): viewer ANONYMOUS_CONTENT_VIEWER, subject
//   `v1:anon:<artifact>:<version>` (contentWorker.ts), which authorize allows
//   only while that version is current and the Artifact public
//   (contentRoutes.ts decideAnonymous). A kind the shell draws (not framed)
//   is 409 NOT_FRAMED; the content origin not configured 503
//   CONTENT_UNAVAILABLE.
// - `GET /:id/index.md` (for AI tools; the page's head links it) answers the
//   current version as Markdown (AppPublicMarkdown: text/plain, nosniff,
//   `default-src 'none'; sandbox`, `private, no-store`, noindex): a header
//   (title, the version's date, the page's address on this deployment),
//   `## Files` (where each file is, in words, then every file, linked to its download on SERVER_URL, its size,
//   the entry marked), then a Markdown entry as is, a text or CSV entry's
//   text, an HTML entry's readable text under `## Text` (readableText.ts,
//   never its markup), or a stub naming the kind; at most
//   ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES, the content cut with a note.
// - `GET /:id/files/*path` answers one file of the current version as is
//   (also `GET /:id/*path`, the address an AI tool guesses from a file's
//   path when it has only index.md's text: any path the routes here don't
//   name)
//   (AppBytes: an attachment, text/plain for a text kind, else
//   octet-stream; core adds nosniff and `default-src 'none'; sandbox`), the
//   path matched exactly against the version's files (a malformed one, `..`,
//   or one not among them is the one 404).
// - `GET /:id/download.zip` answers every file of the current version in
//   one zip (versionZip.ts, storedZip.ts), paths as published, `application/zip`, an
//   attachment named by the title, `private, no-store`; over
//   ARTIFACT_PUBLIC_ZIP_MAX_BYTES of files 413 DOWNLOAD_TOO_LARGE; past the
//   process's cap on archives built at once (zipSlots.ts) 429 BUSY with
//   `Retry-After: 5`. Counted in `slock_app_operations_total`
//   (operation `public_zip`: started, busy, failed).
// - `GET /:id/meta` (for link previews; the web's edge writes it into the
//   page) answers ArtifactPublicMeta: the title, the start of the same text
//   as a description (less a first heading repeating the title), the
//   version's time, its kind, entry and files.
// index.md and meta take the entry's text from `version_texts`
// (publicText.ts) when its row is there, so no storage read; else they read
// it as before and store it. Like the view, none names the author, the
// server, a conversation or a viewer, and nothing is cached (`private,
// no-store`), the stored text included: visibility is checked first on
// every request, so unpublishing, deleting or a takedown stops them at once.
import { asc, eq } from "drizzle-orm";
import {
  ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES,
  artifactFileType,
  artifactPublicPaths,
  asArtifactId,
  isArtifactFramedKind,
  isWellFormedArtifactFilePath,
  type ArtifactKind,
  type ArtifactPublicFrame,
  type ArtifactPublicMeta,
  type ArtifactPublicView,
  type ArtifactWebFrame,
} from "@botiverse/raft-shared";
import type { AppBytes, AppError, AppPublicMarkdown } from "../../platform/apps";
import { getDb } from "../../platform/db";
import { apiUrl } from "../../platform/links";
import { refusalBody, type RefusalInput } from "../../platform/refusals";
import { ARTIFACT_CURSOR_ID, artifactAppUrl, byteSize, currentVersionOf, itemServerEnabled, json, versionFileOf, type ArtifactApiJson } from "./apiCommon";
import { attachmentDisposition } from "./blobStore";
import { ANONYMOUS_CONTENT_VIEWER, anonymousContentSubject, signContentFrame } from "./contentWorker";
import { PUBLIC_TEXT_KINDS, publicTextOf, utf8Prefix, type PublicText } from "./publicText";
import { artifactItems, artifactVersionFiles, type ArtifactItemRow, type ArtifactVersionRow } from "./schema";
import { ARTIFACT_ZIP_MAX_BYTES, versionZipOf, zipBaseName } from "./versionZip";
import { canViewArtifactsAnonymously } from "./visibility";
import { notFramed, webContentUnavailable, webFail, webNotVisible as notVisible, type ArtifactWebApiError } from "./webCommon";

/** A refusal whose code isn't one of the web contract's (the zip's): the envelope, as core's AppError. */
function appRefusal(status: number, refusal: RefusalInput): AppError {
  const body = refusalBody(refusal);
  return { kind: "error", status, body, ...(body.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: body.retryAfterSeconds }) };
}

/** The content origin isn't configured: no frame can be signed. */
const contentOriginUnavailable = (): ArtifactWebApiError => webFail(503, {
  code: "CONTENT_UNAVAILABLE",
  error: "This server can't show artifact pages right now because its content origin isn't set up: download the files instead, or try again later.",
});

/**
 * The public item `id` and its current version, or null for every reason it
 * isn't one (the checks above). Also what a signed-in reader outside the
 * Artifact's server reads on the standalone page (webOpen.ts).
 */
export async function publicItemOf(id: string): Promise<{ item: ArtifactItemRow; version: ArtifactVersionRow } | null> {
  if (!ARTIFACT_CURSOR_ID.test(id)) return null;
  const [item] = await getDb().select().from(artifactItems).where(eq(artifactItems.id, id)).limit(1);
  if (!item || !canViewArtifactsAnonymously([item])[0]) return null;
  // Checks 3 and 4 at once: both only read; either failing is the one null.
  const [version, enabled] = await Promise.all([currentVersionOf(item), itemServerEnabled(item)]);
  if (!version || !enabled) return null;
  return { item, version };
}

export function createArtifactPublicApi() {
  return {
    view: async (id: string): Promise<ArtifactApiJson<ArtifactPublicView> | ArtifactWebApiError> => {
      const found = await publicItemOf(id);
      if (!found) return notVisible();
      const { item, version } = found;
      return json<ArtifactPublicView>({
        id: asArtifactId(item.id),
        title: item.title,
        kind: artifactFileType(version.entry).kind,
        version: { number: version.number, updatedAt: version.createdAt.toISOString() },
        attribution: { kind: "raft" },
      });
    },

    frame: async (id: string): Promise<ArtifactApiJson<ArtifactPublicFrame> | ArtifactWebApiError> => {
      const found = await publicItemOf(id);
      if (!found) return notVisible();
      const { item, version } = found;
      if (!isArtifactFramedKind(artifactFileType(version.entry).kind)) return notFramed();
      const frame = await anonymousFrameOf(item, version);
      if (!frame) return contentOriginUnavailable();
      return json(frame);
    },

    markdown: async (id: string): Promise<AppPublicMarkdown | ArtifactWebApiError> => {
      const found = await publicItemOf(id);
      if (!found) return notVisible();
      const { item, version } = found;
      const [files, content] = await Promise.all([filesOf(version), publicTextOf(item, version)]);
      return { kind: "markdown", body: markdownDocument(item, version, files, content) };
    },

    meta: async (id: string): Promise<ArtifactApiJson<ArtifactPublicMeta> | ArtifactWebApiError> => {
      const found = await publicItemOf(id);
      if (!found) return notVisible();
      const { item, version } = found;
      const [files, content] = await Promise.all([filesOf(version), publicTextOf(item, version)]);
      return json<ArtifactPublicMeta>(metaOf(item, version, files, content));
    },

    /**
     * One file of the current version, as published: only a well-formed path
     * matched exactly against the version's files (never `..`, never a path
     * outside it; storage reached through the matched row's blob only),
     * else the one 404. An attachment, `text/plain` or octet-stream (core
     * adds nosniff and the sandboxing CSP), so nothing renders or runs here.
     */
    file: async (id: string, path: string): Promise<AppBytes | ArtifactWebApiError> => {
      const found = await publicItemOf(id);
      if (!found || !isWellFormedArtifactFilePath(path)) return notVisible();
      const { item, version } = found;
      const file = await versionFileOf(item, version, path);
      if (file.kind === "missing") return notVisible();
      if (file.kind === "unavailable") return webContentUnavailable();
      const bytes = await file.reader.read(file.blob);
      if (!bytes) return notVisible();
      return {
        kind: "bytes",
        stream: bytes.stream,
        size: bytes.size,
        contentType: artifactFileType(file.file.path).text ? "text/plain; charset=utf-8" : "application/octet-stream",
        contentDisposition: attachmentDisposition(file.file.path),
      };
    },

    /**
     * Every file of the current version in one zip (storedZip: STORE only),
     * paths as published, named by the title. At most
     * ARTIFACT_PUBLIC_ZIP_MAX_BYTES of files, else 413; a file whose bytes
     * can't be read cuts the answer (never a partial archive passed as whole).
     */
    downloadZip: async (id: string): Promise<AppBytes | AppError | ArtifactWebApiError> => {
      const found = await publicItemOf(id);
      if (!found) return notVisible();
      const { item, version } = found;
      const zip = await versionZipOf(item, version, { pool: "public", fileName: `${zipBaseName(item)}.zip` });
      switch (zip.kind) {
        case "bytes": return zip;
        case "unavailable": return webContentUnavailable();
        case "too_large": return appRefusal(413, {
          code: "DOWNLOAD_TOO_LARGE",
          error: `This artifact's files are over ${byteSize(zip.limit)} together, too large to download as one zip: download its files one by one instead.`,
          details: { limit: zip.limit },
        });
        case "busy": return appRefusal(429, {
          code: "BUSY",
          error: "Too many downloads are being prepared on this server right now: wait a few seconds, then download it again.",
          retryAfterSeconds: zip.retryAfterSeconds,
        });
      }
    },
  };
}

/** The most bytes of files `download.zip` puts in one archive (versionZip.ts). */
export const ARTIFACT_PUBLIC_ZIP_MAX_BYTES = ARTIFACT_ZIP_MAX_BYTES;

/** Every file of `version`, by path. */
async function filesOf(version: ArtifactVersionRow): Promise<Array<{ path: string; sizeBytes: number }>> {
  return getDb().select({ path: artifactVersionFiles.path, sizeBytes: artifactVersionFiles.sizeBytes })
    .from(artifactVersionFiles)
    .where(eq(artifactVersionFiles.versionId, version.id))
    .orderBy(asc(artifactVersionFiles.path));
}

/**
 * A public item's meta and its `index.md` at once (one visibility check, one
 * read of its files and text), exactly what the `meta` and `index.md` routes
 * answer, or null for every reason it isn't public (publicItemOf). For the
 * public page (publicPage.ts), which writes both into the page.
 */
export async function publicPageOf(id: string): Promise<{ meta: ArtifactPublicMeta; markdown: string } | null> {
  const found = await publicItemOf(id);
  if (!found) return null;
  const { item, version } = found;
  const [files, content] = await Promise.all([filesOf(version), publicTextOf(item, version)]);
  return { meta: metaOf(item, version, files, content), markdown: markdownDocument(item, version, files, content) };
}

/** ArtifactPublicMeta of a public item's current version: exactly its fields. */
function metaOf(
  item: ArtifactItemRow,
  version: ArtifactVersionRow,
  files: ReadonlyArray<{ path: string; sizeBytes: number }>,
  content: PublicText,
): ArtifactPublicMeta {
  return {
    title: item.title,
    description: content.description || stubLine(content.kind),
    updatedAt: version.createdAt.toISOString(),
    kind: content.kind,
    entry: version.entry,
    files: files.map((file) => ({ path: file.path, size: file.sizeBytes, entry: file.path === version.entry })),
  };
}

/** `text` on one line: a title inside the header can't start a new Markdown block. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const KIND_NOUN: Record<ArtifactKind, string> = {
  html: "a page", markdown: "a document", text: "a text file", csv: "a table (CSV)", image: "an image", pdf: "a PDF", video: "a video", other: "a file",
};

/** What a file with no text to show is, in one line. */
const stubLine = (kind: ArtifactKind): string => `An Artifact shared from Raft: ${KIND_NOUN[kind]}.`;

/**
 * Where a public item's API path (`artifactPublicPaths`) is: on this
 * deployment's API origin (SERVER_URL) when it is configured, else relative
 * to index.md (which is beside `files/` and `download.zip`).
 */
function apiLink(relative: string): string {
  const origin = apiUrl();
  // `/api/public/artifacts/<id>/<rest>` → `<rest>`.
  return origin ? `${origin}${relative}` : relative.split("/").slice(5).join("/");
}

/** Where a file of a public item downloads (apiLink). */
function fileUrl(item: ArtifactItemRow, path: string): string {
  // Parentheses encoded too (encodeURIComponent keeps them), so a Markdown link's destination never ends early.
  return apiLink(artifactPublicPaths.file(asArtifactId(item.id), path).replace(/\(/g, "%28").replace(/\)/g, "%29"));
}

/** A size as people read it: bytes, KB or MB (1024s), one decimal under ten. */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, "KB"] : [bytes / (1024 * 1024), "MB"];
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** A path as a Markdown link's text: its brackets and backslashes escaped. */
const linkText = (path: string): string => path.replace(/[\\[\]]/g, (c) => `\\${c}`);

/**
 * The `index.md` document: the header; `## Files`, every file of the version
 * linked to its download (the entry marked); then the content: a Markdown,
 * text or CSV entry's text, an HTML entry's readable text under `## Text`
 * (an extract: the original is the entry's file), or a stub. At most
 * ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES: the content is cut first, with a note.
 */
function markdownDocument(
  item: ArtifactItemRow,
  version: ArtifactVersionRow,
  files: ReadonlyArray<{ path: string; sizeBytes: number }>,
  content: PublicText,
): string {
  const source = artifactAppUrl(item.id);
  const header = [
    `# ${oneLine(item.title) || "Untitled"}`,
    "",
    `Updated ${version.createdAt.toISOString().slice(0, 10)}`,
    "",
    `Source: ${source}`,
    "",
    "## Files",
    "",
    // In words too, not only as links: an AI chat's fetch tool may hand its model a summary that
    // keeps the text and drops the links (xxchan, #proj-workspace:ea136a38).
    `Each file is at ${fileUrl(item, "")}<path>, for example ${fileUrl(item, version.entry)}.`,
    "",
    `- [All files (zip)](${apiLink(artifactPublicPaths.downloadZip(asArtifactId(item.id)))})`,
    ...files.map((file) => `- [${linkText(file.path)}](${fileUrl(item, file.path)}) — ${sizeLabel(file.sizeBytes)}${file.path === version.entry ? " (entry file)" : ""}`),
    "",
    "---",
    "",
    "",
  ].join("\n");
  const text = content.body?.trim() ?? "";
  if (!text) {
    const stub = content.body === null && !PUBLIC_TEXT_KINDS.has(content.kind)
      ? `_This Artifact is ${KIND_NOUN[content.kind]}, which has no text version: download it from Files above, or open ${source}._`
      : `_This Artifact has no text to show here. Open ${source} to view it._`;
    return `${header}${stub}\n`;
  }
  const lead = content.kind === "html"
    ? `## Text\n\n_An extract of the page's readable text. The original is the entry file under Files._\n\n`
    : "";
  const note = `\n\n_[Truncated. The full file is under Files; the Artifact is at ${source}]_\n`;
  const whole = `${header}${lead}${text}\n`;
  if (!content.truncated && Buffer.byteLength(whole, "utf8") <= ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES) return whole;
  const budget = ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES - Buffer.byteLength(header + lead + note, "utf8");
  return `${header}${lead}${utf8Prefix(text, budget)}${note}`;
}

/**
 * A public item's current version's anonymous frame (the checks above
 * passed: publicItemOf): viewer ANONYMOUS_CONTENT_VIEWER, its subject naming
 * the Artifact and the version. Null for a kind the shell draws, or when the
 * content origin isn't configured. The frame route here, and the standalone
 * page's frame for a reader outside the Artifact's server (webOpen.ts).
 */
export async function anonymousFrameOf(item: ArtifactItemRow, version: ArtifactVersionRow): Promise<ArtifactWebFrame | null> {
  const kind = artifactFileType(version.entry).kind;
  if (!isArtifactFramedKind(kind)) return null;
  return signContentFrame({
    artifact: item.id,
    version: version.id,
    viewer: ANONYMOUS_CONTENT_VIEWER,
    subject: anonymousContentSubject({ artifact: item.id, version: version.id }),
  }, { kind });
}
