// The public Artifact page, `app.raft.build/artifacts/<id>[/v/<n>]`, when
// app.raft.build is served by CloudFront: CloudFront sends `/artifacts/*` here
// (core's page mount, behind the app edge marker: PublicPageMount), and this
// answers what the Pages Worker (packages/web/public/_worker.js) answers there
// today, so link previews, AI tools and crawlers read the same page wherever
// the web is hosted:
// - an older link, `/artifacts/pt_<uuid>[/v/<n>]`, moves for good (301) to
//   its short id, the query kept;
// - a GET whose Accept prefers text/markdown over text/html gets the
//   Artifact's index.md itself, with its own headers (a sandboxing CSP);
// - any other GET of the page gets the web's shell with the preview head
//   (title, Open Graph and Twitter tags, canonical, alternates, robots
//   noindex: from the meta only) and a visually hidden article in `#root`
//   (title, date, files, index.md's text in a `<pre>`, at most
//   ARTICLE_TEXT_MAX_BYTES), which React replaces on mount;
// - everything else under /artifacts/ gets the shell as it is.
// The meta and index.md are read in-process (publicPageOf: the same
// visibility check and bytes as the `/api/public/artifacts/<id>/meta` and
// `/index.md` routes), never over HTTP. Nothing is cached: every page request
// asks again, so unpublishing, deleting or a takedown shows on the next one;
// a page answer has no validators and is `no-store`. Every answer to a page
// GET or HEAD says `X-Robots-Tag: noindex, nofollow`, and a rewritten one is
// marked (PREVIEW_HEADER) so the web's service worker never keeps it as the
// app's shell. Every injected value is HTML-escaped. Any failure: the page as
// it is, nothing injected, the reason in DIAGNOSTIC_HEADER.
//
// The shell is the deployed web's own (`${APP_URL}/`, or
// ARTIFACT_PAGE_SHELL_URL), fetched on every request with the last copy's
// ETag, so a web release shows here at once and an unchanged shell costs a
// 304; the last good copy answers while the web doesn't. Its security headers
// (the app's CSP among them, if the web sends one) are the page's; the API's
// own helmet CSP never is.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { encodeArtifactShortId, parseArtifactId, type ArtifactId, type ArtifactPublicMeta } from "@botiverse/raft-shared";
import { apiUrl, appUrl } from "../../platform/links";
import type { PublicPageMount } from "../../platform/apps";
import { publicPageOf } from "./publicRoutes";

/** `/artifacts/<short id>[/v/<n>]`: the page (and the web router's pinned version). */
const PAGE_PATH = /^\/artifacts\/([1-9A-HJ-NP-Za-km-z]{22})(?:\/v\/[1-9][0-9]{0,8})?\/?$/;
/** An older link, `/artifacts/pt_<uuid>[/v/<n>]`, moved for good to the short id. */
const LEGACY_LINK = /^\/artifacts\/pt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/v\/[1-9][0-9]{0,8})?\/?$/;
/** How much of index.md the page's article holds (UTF-8 bytes, cut at a character): the rest is in the Markdown version. */
export const ARTICLE_TEXT_MAX_BYTES = 50 * 1024;
// The square app icon: the one brand image a preview card can show.
const PREVIEW_IMAGE_PATH = "/android-chrome-512x512.png";
// Visually hidden (it is replaced when the app mounts), still text to a fetcher that reads the HTML.
const ARTICLE_STYLE = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
/** Marks every answer rewritten or made for a page: the web's service worker (sw.js keepShell) never keeps one as the shell. */
export const PREVIEW_HEADER = "X-Raft-Artifact-Preview";
/** Why a page answer is or isn't rewritten: `injected`, or `skipped=<reason>`; a Markdown request that fell back adds `markdown=<reason>`. */
export const DIAGNOSTIC_HEADER = "X-Raft-Artifact-Diagnostic";
// The shell's headers a page keeps: its content type and its security headers.
const SHELL_HEADERS = ["content-type", "content-security-policy", "x-frame-options", "referrer-policy", "x-content-type-options", "permissions-policy"] as const;
// Core's helmet headers that are the API's, not a page's.
const API_ONLY_HEADERS = ["content-security-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "origin-agent-cluster"] as const;
const SHELL_TIMEOUT_MS = 1_500;

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!);
}

/** A path's segments, each percent-encoded (as the API's file route reads them). */
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** The API's public addresses of an Artifact, by the id the page's path names (its short id). */
function artifactApi(apiOrigin: string, id: string) {
  const base = `${apiOrigin}/api/public/artifacts/${id}`;
  return {
    markdown: `${base}/index.md`,
    zip: `${base}/download.zip`,
    file: (path: string) => `${base}/files/${encodePath(path)}`,
  };
}

/** The q of `type` in an Accept header (exact type only), or null when it isn't listed. */
function acceptQuality(header: string, type: string): number | null {
  for (const part of header.split(",")) {
    const [range, ...params] = part.trim().toLowerCase().split(";");
    if (range!.trim() !== type) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const value = q === undefined ? 1 : Number(q.slice(2));
    return Number.isFinite(value) ? value : 0;
  }
  return null;
}

/** Whether an Accept header prefers text/markdown: listed with q > 0, and text/html absent or with a lower q. */
export function prefersMarkdown(accept: string | undefined): boolean {
  const header = accept ?? "";
  const markdown = acceptQuality(header, "text/markdown");
  if (markdown === null || markdown <= 0) return false;
  const html = acceptQuality(header, "text/html");
  return html === null || markdown > html;
}

/** A size as people read it: bytes, KB or MB (1024s), one decimal under ten (as index.md says it). */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, "KB"] : [bytes / (1024 * 1024), "MB"];
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** The media type the entry file is linked as an alternate with, from its extension: HTML or Markdown, else null (no alternate). */
export function entryAlternateType(entry: string): string | null {
  const name = entry.slice(entry.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  return null;
}

/** The tags written into the page's head for `meta`; every value escaped. */
export function artifactHeadTags({ meta, id, pageOrigin, apiOrigin }: { meta: ArtifactPublicMeta; id: string; pageOrigin: string; apiOrigin: string }): string {
  const canonical = `${pageOrigin}/artifacts/${id}`;
  const api = artifactApi(apiOrigin, id);
  const description = meta.description || `${meta.title}, shared from Raft.`;
  const entryType = entryAlternateType(meta.entry);
  const metaTag = (attr: string, name: string, content: string) => `<meta ${attr}="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
  const link = (attrs: Record<string, string>) => `<link ${Object.entries(attrs).map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(" ")}>`;
  return [
    metaTag("name", "robots", "noindex, nofollow"),
    metaTag("name", "description", description),
    metaTag("property", "og:type", "article"),
    metaTag("property", "og:site_name", "Raft"),
    metaTag("property", "og:title", meta.title),
    metaTag("property", "og:description", description),
    metaTag("property", "og:url", canonical),
    metaTag("property", "og:image", `${pageOrigin}${PREVIEW_IMAGE_PATH}`),
    metaTag("property", "og:image:alt", "Raft"),
    // The image is the square 512 px app icon: a small card, not a large image one.
    metaTag("name", "twitter:card", "summary"),
    metaTag("name", "twitter:title", meta.title),
    metaTag("name", "twitter:description", description),
    link({ rel: "canonical", href: canonical }),
    link({ rel: "alternate", type: "text/markdown", href: api.markdown }),
    entryType ? link({ rel: "alternate", type: entryType, title: "Source", href: api.file(meta.entry) }) : "",
  ].filter(Boolean).join("\n");
}

/** index.md's text for the article: at most ARTICLE_TEXT_MAX_BYTES of UTF-8, cut at a character boundary. */
export function articleText(markdown: string): { text: string; cut: boolean } {
  const bytes = Buffer.from(markdown, "utf8");
  if (bytes.length <= ARTICLE_TEXT_MAX_BYTES) return { text: markdown, cut: false };
  let end = ARTICLE_TEXT_MAX_BYTES;
  // Back to the start of the character the limit falls in (a UTF-8 continuation byte is 10xxxxxx).
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}

/**
 * The readable article written into `#root` for `meta`, with index.md's text
 * (articleText) when there is one, else the meta's description; every value
 * escaped.
 */
export function artifactArticle({ meta, id, apiOrigin, text = null }: { meta: ArtifactPublicMeta; id: string; apiOrigin: string; text?: { text: string; cut: boolean } | null }): string {
  const api = artifactApi(apiOrigin, id);
  const item = (href: string, label: string, note: string) => `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a> (${escapeHtml(note)})</li>`;
  const markdownLink = `<a href="${escapeHtml(api.markdown)}">${escapeHtml(api.markdown)}</a>`;
  return [
    `<article data-raft-artifact-preview style="${ARTICLE_STYLE}">`,
    `<h1>${escapeHtml(meta.title)}</h1>`,
    `<p>Updated ${escapeHtml(meta.updatedAt.slice(0, 10))}</p>`,
    !text && meta.description ? `<p>${escapeHtml(meta.description)}</p>` : "",
    "<p>This is a Raft Artifact. Download its files:</p>",
    "<ul>",
    `<li><a href="${escapeHtml(api.zip)}">All files (zip)</a></li>`,
    ...meta.files.map((file) => item(api.file(file.path), file.path, file.entry ? `${sizeLabel(file.size)}, entry file` : sizeLabel(file.size))),
    "</ul>",
    // A <pre> keeps the Markdown's line breaks for a fetcher turning the HTML into text.
    text ? `<pre>${escapeHtml(text.text)}</pre>` : "",
    text?.cut ? `<p>The text above is cut at ${ARTICLE_TEXT_MAX_BYTES / 1024} KB. The full text is in the Markdown version: ${markdownLink}</p>` : "",
    `<p>Markdown version: ${markdownLink}</p>`,
    "</article>",
  ].filter(Boolean).join("\n");
}

/**
 * The shell with the preview written in at its fixed markers (the title's
 * text, the end of the head, the start of `#root`), or null when one is
 * missing: the web's own build, so a missing marker means a shell this
 * doesn't know, answered as it is. `#root` keeps its attributes (the built
 * shell's is `<div id="root" translate="no" class="notranslate">`).
 */
export function injectPreview(shell: string, { title, head, article }: { title: string; head: string; article: string }): string | null {
  const titleMatch = /<title>[^<]*<\/title>/i.exec(shell);
  const headEnd = shell.search(/<\/head>/i);
  const rootMatch = /<div id="root"(?:\s[^>]*)?>/i.exec(shell);
  if (!titleMatch || headEnd < 0 || !rootMatch || titleMatch.index > headEnd || rootMatch.index < headEnd) return null;
  const rootOpenEnd = rootMatch.index + rootMatch[0].length;
  return shell.slice(0, titleMatch.index)
    + `<title>${escapeHtml(title)}</title>`
    + shell.slice(titleMatch.index + titleMatch[0].length, headEnd)
    + `${head}\n`
    + shell.slice(headEnd, rootOpenEnd)
    + article
    + shell.slice(rootOpenEnd);
}

/** The 301 for an older link (`pt_<uuid>`), the query kept, or null for any other path. */
export function legacyLinkLocation(pathname: string, search: string): string | null {
  const match = LEGACY_LINK.exec(pathname);
  if (!match) return null;
  return `/artifacts/${encodeArtifactShortId(match[1]!)}${match[2] ?? ""}${search}`;
}

/** The short id a page path names, or null for any other path. */
export function pageShortId(pathname: string): string | null {
  return PAGE_PATH.exec(pathname)?.[1] ?? null;
}

/** One copy of the web's shell: its body, the headers a page keeps, and its ETag. */
export type ShellCopy = { body: string; headers: Partial<Record<(typeof SHELL_HEADERS)[number], string>>; etag: string | null };

export interface ShellSource {
  /** The current shell (asked again on every call, the last copy's ETag sent), the last good copy when the web doesn't answer, or null when there has never been one. */
  get(): Promise<ShellCopy | null>;
}

/**
 * The deployed web's shell at `url()`: asked with the last copy's ETag (a 304
 * keeps it), never with a visitor's validators, never following a redirect.
 * Only a 200 HTML answer replaces the copy; anything else, an error or a
 * timeout answers the last good copy.
 */
export function createShellSource({ url, fetch: fetchShell = fetch, timeoutMs = SHELL_TIMEOUT_MS }: { url: () => string; fetch?: typeof fetch; timeoutMs?: number }): ShellSource {
  let copy: ShellCopy | null = null;
  return {
    async get() {
      const headers: Record<string, string> = { Accept: "text/html" };
      if (copy?.etag) headers["If-None-Match"] = copy.etag;
      try {
        const response = await fetchShell(url(), { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        if (response.status === 304 && copy) return copy;
        const contentType = response.headers.get("content-type") ?? "";
        if (response.status !== 200 || !/^text\/html(?:\s*;|$)/i.test(contentType)) return copy;
        const kept: ShellCopy["headers"] = {};
        for (const name of SHELL_HEADERS) {
          const value = response.headers.get(name);
          if (value !== null) kept[name] = value;
        }
        copy = { body: await response.text(), headers: kept, etag: response.headers.get("etag") };
        return copy;
      } catch {
        return copy;
      }
    },
  };
}

/** The shell URL: ARTIFACT_PAGE_SHELL_URL, else the web's root (`${APP_URL}/`). */
export function shellUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARTIFACT_PAGE_SHELL_URL?.trim() || `${appUrl()}/`;
}

export interface PublicPageDeps {
  /** The meta and index.md of a public Artifact (publicPageOf), or null when it isn't one. May reject. */
  page(id: ArtifactId): Promise<{ meta: ArtifactPublicMeta; markdown: string } | null>;
  shell: ShellSource;
  /** Where the page lives (canonical, og:url, og:image): the web's origin, never the request's Host. */
  pageOrigin(): string;
  /** The API's public origin (the head's and article's links), or null when it isn't configured (nothing is injected). */
  apiOrigin(): string | null;
}

/** What a page ask came to: `{ page }`, or why there is none (`not_public`, `invalid`, `error_<name>`). */
async function pageOutcome(deps: PublicPageDeps, shortId: string): Promise<{ page: { meta: ArtifactPublicMeta; markdown: string } | null; reason: string }> {
  const id = parseArtifactId(shortId);
  if (!id) return { page: null, reason: "not_public" };
  try {
    const page = await deps.page(id);
    if (!page) return { page: null, reason: "not_public" };
    if (page.meta.title.trim() === "") return { page: null, reason: "invalid" };
    return { page, reason: "ok" };
  } catch (error) {
    const name = error && typeof (error as Error).name === "string" ? (error as Error).name : "Error";
    return { page: null, reason: `error_${name.replace(/[^A-Za-z0-9_]/g, "")}` };
  }
}

/** The shell's headers on `res` in place of the API's own (helmet's CSP and isolation headers), with the page's defaults where the shell has none. */
function shellHeaders(res: Response, shell: ShellCopy): void {
  for (const name of API_ONLY_HEADERS) res.removeHeader(name);
  for (const [name, value] of Object.entries(shell.headers)) res.setHeader(name, value);
  if (!shell.headers["x-frame-options"]) res.setHeader("X-Frame-Options", "DENY");
  if (!shell.headers["referrer-policy"]) res.setHeader("Referrer-Policy", "no-referrer");
  if (!shell.headers["x-content-type-options"]) res.setHeader("X-Content-Type-Options", "nosniff");
}

/** `body` as the whole answer: a Buffer, so Express adds no ETag; only the headers for a HEAD. */
function end(req: Request, res: Response, status: number, body: string): void {
  const bytes = Buffer.from(body, "utf8");
  res.status(status).setHeader("Content-Length", String(bytes.length));
  if (req.method === "HEAD") res.end();
  else res.end(bytes);
}

function unavailable(req: Request, res: Response): void {
  for (const name of API_ONLY_HEADERS) res.removeHeader(name);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  end(req, res, 503, "The page is not available right now.\n");
}

/** The router core mounts at `/artifacts` (behind the edge marker): GET and HEAD only; anything else passes on. */
export function createArtifactPublicPageRouter(deps: PublicPageDeps, limiter: RequestHandler): Router {
  const router = Router();
  router.use(limiter);
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    answer(deps, req, res).catch(next);
  });
  return router;
}

async function answer(deps: PublicPageDeps, req: Request, res: Response): Promise<void> {
  const url = new URL(req.originalUrl, "http://page.invalid");
  const location = legacyLinkLocation(url.pathname, url.search);
  if (location) {
    for (const name of API_ONLY_HEADERS) res.removeHeader(name);
    res.status(301).set({ Location: location, "Cache-Control": "public, max-age=86400" }).end();
    return;
  }
  const shortId = pageShortId(url.pathname);
  if (!shortId) {
    // Anything else under /artifacts/ is the app's: the shell as it is.
    const shell = await deps.shell.get();
    if (!shell) {
      unavailable(req, res);
      return;
    }
    shellHeaders(res, shell);
    res.setHeader("Cache-Control", "no-cache");
    end(req, res, 200, shell.body);
    return;
  }

  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // Made for this request only (unpublishing shows on the next one); the same address answers Markdown to an Accept that prefers it.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept");
  const apiOrigin = deps.apiOrigin();
  // HEAD: the shell's headers only, nothing asked.
  const asked = req.method === "GET" && apiOrigin ? pageOutcome(deps, shortId) : null;
  let markdownReason: string | null = null;
  if (req.method === "GET" && prefersMarkdown(req.get("accept"))) {
    const outcome = asked ? await asked : { page: null, reason: "no_api_origin" };
    if (outcome.page) {
      for (const name of API_ONLY_HEADERS) res.removeHeader(name);
      res.set({
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        [PREVIEW_HEADER]: "1",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      });
      end(req, res, 200, outcome.page.markdown);
      return;
    }
    markdownReason = outcome.reason;
  }

  const [shell, outcome] = await Promise.all([deps.shell.get(), asked]);
  if (!shell) {
    unavailable(req, res);
    return;
  }
  shellHeaders(res, shell);
  const diagnostic = (value: string) => res.setHeader(DIAGNOSTIC_HEADER, markdownReason ? `${value}; markdown=${markdownReason}` : value);
  if (req.method === "HEAD") {
    end(req, res, 200, shell.body);
    return;
  }
  if (!apiOrigin || !outcome) {
    diagnostic("skipped=no_api_origin");
    end(req, res, 200, shell.body);
    return;
  }
  if (!outcome.page) {
    diagnostic(`skipped=${outcome.reason}`);
    end(req, res, 200, shell.body);
    return;
  }
  const { meta, markdown } = outcome.page;
  const pageOrigin = deps.pageOrigin();
  const rewritten = injectPreview(shell.body, {
    title: `${meta.title} | Raft`,
    head: artifactHeadTags({ meta, id: shortId, pageOrigin, apiOrigin }),
    article: artifactArticle({ meta, id: shortId, apiOrigin, text: articleText(markdown) }),
  });
  if (!rewritten) {
    diagnostic("skipped=shell_markers");
    end(req, res, 200, shell.body);
    return;
  }
  res.setHeader(PREVIEW_HEADER, "1");
  diagnostic("injected");
  end(req, res, 200, rewritten);
}

/** Registers the public page (core mounts it at `/artifacts`, edge-marked requests only). */
export function mountArtifactPublicPage(mount: PublicPageMount, deps: Partial<PublicPageDeps> = {}): void {
  // Per client address, as the signed-out view: a visitor opens a page once, reloads now and then.
  const limiter = mount.rateLimit("view", { perMinute: 60, message: "Too many artifact requests" });
  mount.use(createArtifactPublicPageRouter({
    page: deps.page ?? ((id) => publicPageOf(id)),
    shell: deps.shell ?? createShellSource({ url: () => shellUrl() }),
    pageOrigin: deps.pageOrigin ?? (() => appUrl()),
    apiOrigin: deps.apiOrigin ?? (() => apiUrl()),
  }, limiter));
}
