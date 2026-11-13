// Signed-out viewing of public Artifacts (v1, Tenny and xxchan 2026-10-26):
// the routes a visitor with no Raft sign-in reads, `/api/public/artifacts/*`,
// and what they answer. Both the server and the web's signed-out page import
// these.
//
// - A visitor may view an Artifact if and only if its home is `public`, it
//   isn't deleted or revoked, it has a current version and its own server
//   still exists and has workspace_artifacts_v0 on. Every other case
//   (another home, deleted, revoked, never published, the flag off or the
//   server deleted, no such id, a malformed id) is
//   the same 404 NOT_VISIBLE refusal (refusal.ts's envelope), one sentence
//   for every reason.
// - Only the current version: no comments, no history, no server or
//   conversation, no presence, no author, no viewers (ArtifactPublicView is
//   all there is; the routes below add the version's text and files, never
//   a name).
// - The routes never read a credential (Authorization or a cookie): a
//   signed-in person asking gets the same answer as anyone. They never set a
//   cookie, answer `Cache-Control: private, no-store` (nothing is kept by any
//   cache, so unpublishing, deleting or a takedown stops them at once) and
//   `X-Robots-Tag: noindex, nofollow`, and are limited per client address
//   (429 RATE_LIMITED past it).
// - For AI tools and link previews (2026-10-29): `index.md` (the current
//   version as Markdown, listing its files), `files/<path>` (one file, as
//   is), `download.zip` (all of them) and `meta` (what a link preview
//   shows), for exactly the Artifacts the view answers for, the same 404
//   otherwise. `index.md` is never HTML (`text/plain`, nosniff, a
//   sandboxing CSP); files and the zip are attachments (a file `text/plain`
//   for a text kind, else `application/octet-stream`; nosniff, a sandboxing
//   CSP), so nothing renders or runs on the API's origin.

import { artifactLinkId } from "./artifactRef";
import type { ArtifactId, ArtifactKind } from "./workspaceArtifacts";
import type { ArtifactWebFrame } from "./webArtifactsContract";

const enc = encodeURIComponent;

/** The signed-out routes for an Artifact, as the client builds them. */
export const artifactPublicPaths = {
  /** GET → ArtifactPublicView. 60 a minute per client address. */
  view: (id: ArtifactId) => `/api/public/artifacts/${enc(id)}`,
  /**
   * POST → ArtifactPublicFrame: where the current version loads on the
   * content origin, with a one-time ticket for this Artifact's current
   * version only (no viewer: the content Worker issues it anonymously). The
   * body is not read. Past the visibility checks: a kind the shell draws
   * itself (not ARTIFACT_FRAMED_KINDS) is 409 NOT_FRAMED, the content origin
   * not configured or not answering 503 CONTENT_UNAVAILABLE. 30 a minute per
   * client address. Asked on every mount: the ticket is good once.
   */
  frame: (id: ArtifactId) => `/api/public/artifacts/${enc(id)}/frame`,
  /**
   * GET → the current version as Markdown, sent as `text/plain; charset=utf-8`
   * (ChatGPT's fetch refuses text/markdown):
   * a header (title, `Updated <date>`, the page's address), then a
   * `## Files` section (where each file is, in words, then the zip, then every file, each linked to `file`,
   * with its size, the entry marked), then a Markdown entry as is, a text or
   * CSV entry's text, an HTML entry's readable text (an extract, its
   * images' alt text included, under `## Text`), or a line saying what kind
   * of file it is. At most
   * ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES. Linked from the page's head
   * (`rel="alternate"`). 60 a minute per client address. Writes the short
   * id (artifactLinkId), the form the page's address and its head link use;
   * the route reads both forms.
   */
  markdown: (id: ArtifactId) => `/api/public/artifacts/${enc(artifactLinkId(id))}/index.md`,
  /**
   * GET → one file of the current version, its bytes as published, as an
   * attachment named by its last segment: `text/plain; charset=utf-8` for a
   * text kind (HTML, CSS, JS, Markdown, JSON, CSV, text, SVG, XML), else
   * `application/octet-stream`. Only a path of the version's files; any
   * other (malformed, `..`, not in it) is the one 404. 120 a minute per
   * client address. Writes the short id (artifactLinkId): index.md publishes
   * this path as a link; the route reads both forms.
   */
  file: (id: ArtifactId, path: string) => `/api/public/artifacts/${enc(artifactLinkId(id))}/files/${path.split("/").map(enc).join("/")}`,
  /**
   * GET → every file of the current version in one zip (stored, paths as
   * published), `application/zip`, an attachment named by the title. Over
   * 100 MB of files: 413 DOWNLOAD_TOO_LARGE. 10 a minute per client address,
   * and a few at once per server process (ARTIFACTS_PUBLIC_ZIP_CONCURRENCY,
   * default 4): past that 429 `{ code: "BUSY" }` with `Retry-After: 5`.
   * Writes the short id (artifactLinkId): index.md publishes this path as a
   * link; the route reads both forms.
   */
  downloadZip: (id: ArtifactId) => `/api/public/artifacts/${enc(artifactLinkId(id))}/download.zip`,
  /** GET → ArtifactPublicMeta: what a link preview of the page shows. 300 a minute per client address (the web's edge asks on every page view; never cached). */
  meta: (id: ArtifactId) => `/api/public/artifacts/${enc(id)}/meta`,
} as const;

/** The most `index.md` answers, header included (UTF-8 bytes). */
export const ARTIFACT_PUBLIC_MARKDOWN_MAX_BYTES = 200 * 1024;

/** The most characters of ArtifactPublicMeta's `description`, before its "…". */
export const ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS = 160;

/**
 * What a link preview of a public Artifact's page shows (the web's edge
 * writes it into the page's head): exactly these fields.
 */
export interface ArtifactPublicMeta {
  title: string;
  /**
   * The start of the current version's readable text (index.md's content),
   * less a first heading that only repeats the title, whitespace collapsed,
   * at most ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS cut at a word, then "…"
   * when cut; for a file with no text, a line saying what it is.
   */
  description: string;
  /** When the current version was published (ISO 8601). */
  updatedAt: string;
  /** How the entry file is shown. */
  kind: ArtifactKind;
  /** The current version's entry file's path (its `file` route serves it). */
  entry: string;
  /** Every file of the current version, by path: its size in bytes, and whether it is the entry. */
  files: ArtifactPublicFile[];
}

/** One file of a public Artifact's current version, as ArtifactPublicMeta lists it. */
export interface ArtifactPublicFile {
  path: string;
  size: number;
  entry: boolean;
}

/**
 * Who the signed-out page credits. v1 always `{ kind: "raft" }` ("Made with
 * Raft"); a variant naming the author may come later (an additive change).
 */
export type ArtifactPublicAttribution = { kind: "raft" };

/** What a signed-out visitor reads of a public Artifact: exactly these fields. */
export interface ArtifactPublicView {
  id: ArtifactId;
  title: string;
  /** How the current version's entry file is shown (frame it when ARTIFACT_FRAMED_KINDS). */
  kind: ArtifactKind;
  /** The current version: its number, and when it was published. */
  version: { number: number; updatedAt: string };
  attribution: ArtifactPublicAttribution;
}

/** The frame route's answer: the same FrameLocation the signed-in viewer gets, always for the current version. */
export type ArtifactPublicFrame = ArtifactWebFrame;
