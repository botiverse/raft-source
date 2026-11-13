const BUILT_ASSET_PREFIXES = ["/assets/", "/feedback/assets/"];
const DESKTOP_MANIFEST_PATH = "/desktop-manifest.json";
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_DESKTOP_MANIFEST_BYTES = 65_536;
const WELL_KNOWN_PREFIX = "/.well-known/";
const WELL_KNOWN_CHANGE_PASSWORD_PATH = `${WELL_KNOWN_PREFIX}change-password`;
const CHANGE_PASSWORD_INTENT_PATH = "/change-password";

function isBuiltAssetRequest(request) {
  return BUILT_ASSET_PREFIXES.some(prefix => new URL(request.url).pathname.startsWith(prefix));
}

function isHtmlResponse(response) {
  return /^text\/html(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
}

// Built JS and CSS have a brotli-11 copy beside them, `<file>.br`
// (scripts/precompress-assets.ts): Cloudflare's on-the-fly brotli is a low
// level, about a fifth bigger on our chunks. A GET that accepts br gets the
// copy, sent as is (encodeBody: "manual"); a Range request, a browser without
// br, or a file with no copy gets the file as before.
const PRECOMPRESSED_ASSET = /\.(?:js|css)$/;
const PRECOMPRESSED_CONTENT_TYPES = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

function acceptsBrotli(request) {
  const header = request.headers.get("accept-encoding") ?? "";
  return header.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding.trim() !== "br") return false;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function ifNoneMatchIncludes(header, etag) {
  if (!header) return false;
  const bare = (tag) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

export async function precompressedAssetResponse(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (!isBuiltAssetRequest(request) || request.headers.has("range") || !acceptsBrotli(request)) return null;
  const url = new URL(request.url);
  const extension = PRECOMPRESSED_ASSET.exec(url.pathname)?.[0].slice(1);
  if (!extension) return null;
  url.pathname = `${url.pathname}.br`;
  const copy = await env.ASSETS.fetch(new Request(url.toString(), { method: request.method }));
  // No copy: the Pages fallback answers HTML (or a 404); serve the file itself.
  if (!copy.ok || isHtmlResponse(copy)) return null;
  const headers = applySecurityHeaders(new Headers({
    "Content-Type": PRECOMPRESSED_CONTENT_TYPES[extension],
    "Content-Encoding": "br",
    "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
    Vary: "Accept-Encoding",
  }));
  // What Pages sends on the file itself, kept: its ETag and its CORS header.
  const etag = copy.headers.get("etag");
  if (etag) headers.set("ETag", etag);
  const allowOrigin = copy.headers.get("access-control-allow-origin");
  if (allowOrigin) headers.set("Access-Control-Allow-Origin", allowOrigin);
  if (etag && ifNoneMatchIncludes(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  // Returned as is, not through withSecurityHeaders: a rebuilt Response would
  // drop encodeBody: "manual" and the runtime would compress the copy again.
  return new Response(request.method === "HEAD" ? null : copy.body, { status: 200, headers, encodeBody: "manual" });
}

function isDesktopManifestRequest(request) {
  return new URL(request.url).pathname === DESKTOP_MANIFEST_PATH;
}

function unavailableDesktopManifestResponse() {
  return Response.json(
    { error: "desktop_manifest_unavailable" },
    {
      status: 404,
      statusText: "Not Found",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function isJsonResponse(response) {
  return /^application\/json(?:\s*;|$)/i.test(
    response.headers.get("content-type") ?? "",
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedDesktopManifestBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_DESKTOP_MANIFEST_BYTES
  ) {
    return null;
  }

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_DESKTOP_MANIFEST_BYTES) {
        await reader.cancel("desktop manifest exceeds byte limit");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function normalizeDesktopManifestResponse(request, response) {
  if (!isDesktopManifestRequest(request)) return response;
  if (response.status !== 200 || !isJsonResponse(response)) {
    return unavailableDesktopManifestResponse();
  }

  const body = await readBoundedDesktopManifestBody(response);
  if (body === null) {
    return unavailableDesktopManifestResponse();
  }
  try {
    const decoded = new TextDecoder().decode(body);
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unavailableDesktopManifestResponse();
    }
  } catch {
    return unavailableDesktopManifestResponse();
  }

  const digest = await crypto.subtle.digest("SHA-256", body);
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-cache, must-revalidate");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", `"sha256-${bytesToHex(new Uint8Array(digest))}"`);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function normalizeBuiltAssetResponse(request, response) {
  if (!isBuiltAssetRequest(request)) return response;
  if (response.status !== 404 && !isHtmlResponse(response)) {
    if (!response.ok) return response;

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", IMMUTABLE_ASSET_CACHE_CONTROL);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(null, {
    status: 404,
    statusText: "Not Found",
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}


/**
 * App Links / Universal Links association files.
 *
 * Served from the Worker, NOT from `public/.well-known/`, because Cloudflare
 * Pages drops dot-directories at upload. Measured on a preview deploy before
 * writing this: the file was present in `dist/.well-known/` after the Vite
 * build, and the deployed site answered
 *
 *   GET /.well-known/assetlinks.json  → 200  text/html   (the SPA shell)
 *
 * byte-identical to a nonexistent path. **200, not 404** — so any "is the URL
 * reachable" check passes while the OS receives HTML and association silently
 * never verifies. That is the exact failure this whole feature is trying to
 * avoid, so these paths are answered here where nothing can swallow them.
 *
 * Both must be `application/json`. Apple additionally does NOT follow redirects
 * when fetching the AASA, so this has to be a direct 200 at the exact path, and
 * `apple-app-site-association` has no file extension by design.
 *
 * Contents frozen by @Mahua from the real signed artifacts (#proj-mobile):
 * Android package + both signing certs (legacy and rotated — a device on either
 * must verify), iOS appID from the Team ID in the live signed IPA. Scope is
 * every address the app can open (all Raft links, #proj-mobile:#128): `/download`,
 * channel/DM permalinks (they also carry reply/message anchors in their query),
 * an open Artifact's `/s/<slug>/artifacts?artifact=<id>`, an Artifact's share
 * link `/artifacts/<id>[/v/<n>]` and the external invite link. Android claims
 * the same through its manifest (`/s/`, `/artifacts/`, `/external-invite/`). Until 1.24, App Store builds shipped without the
 * associated-domains entitlement, so widening this list reaches no older app. The native parser validates identities
 * and anchors after delivery; this association is not an authorization check.
 */
const WELL_KNOWN_ASSETLINKS_PATH = "/.well-known/assetlinks.json";
const WELL_KNOWN_AASA_PATH = "/.well-known/apple-app-site-association";

const ANDROID_ASSETLINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "build.raft.app",
      sha256_cert_fingerprints: [
        "B4:91:93:81:D8:F9:CE:DE:4F:8E:B8:F6:D1:32:F6:DF:E0:D6:D1:5B:F6:D1:F6:30:57:D5:EB:A0:45:16:1A:45",
        "5F:08:BB:E8:2A:27:CC:DA:D2:6C:13:52:3A:60:B5:67:0D:3A:A7:63:3E:8E:D2:FD:71:FA:6B:57:51:F9:B0:B1",
      ],
    },
  },
];

const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ["XDAPXFY8FZ.build.raft.app"],
        // Apple stops at the first matching component and its `*` also matches
        // `/`, so the excludes come first and keep the families to exactly
        // `/s/<slug>/<kind>/<id>`: no empty id, no extra segment on either side.
        components: [
          { "/": "/download", comment: "mobile download entry only" },
          {
            "/": "/",
            // Only links from a sign-up started in a native sign-in: returnTo is its pending
            // request, `/login/app?request=<id>` (appLoginService). Apple matches the decoded query
            // value; the `?` in the pattern is its one-character wildcard, standing for the literal
            // `?`. Web sign-ups keep opening in the browser. iOS reopens the link only when the id
            // is the request it is waiting for (a Raft Desktop sign-up has the same shape).
            "?": { verify: "?*", returnTo: "/login/app?request=*" },
            comment: "app sign-up email verification link only; iOS resumes the pending app sign-in",
          },
          { "/": "/s/*/channel/", exclude: true, comment: "no channel id" },
          { "/": "/s/*/*/channel/*", exclude: true, comment: "nested route, not a channel permalink" },
          { "/": "/s/*/channel/*/*", exclude: true, comment: "extra segment after the channel id" },
          { "/": "/s/*/dm/", exclude: true, comment: "no dm id" },
          { "/": "/s/*/*/dm/*", exclude: true, comment: "nested route, not a dm permalink" },
          { "/": "/s/*/dm/*/*", exclude: true, comment: "extra segment after the dm id" },
          {
            "/": "/s/*/channel/*",
            comment: "channel and reply permalinks; native validates identity and query anchors",
          },
          {
            "/": "/s/*/dm/*",
            comment: "direct-message permalinks; native validates identity and query anchors",
          },
          {
            "/": "/s/*/artifacts",
            "?": { artifact: "?*" },
            comment: "an open Artifact's address (?artifact=<id>[&version=<n>]); the app opens it in its viewer",
          },
          { "/": "/artifacts/", exclude: true, comment: "no artifact id" },
          { "/": "/artifacts/*/*/v/*", exclude: true, comment: "extra segment before the version" },
          { "/": "/artifacts/*/v/", exclude: true, comment: "no version number" },
          { "/": "/artifacts/*/v/*/*", exclude: true, comment: "extra segment after the version" },
          { "/": "/artifacts/*/v/*", comment: "an Artifact's share link at a version; the app opens it in its viewer" },
          { "/": "/artifacts/*/*", exclude: true, comment: "any other extra segment after the artifact id" },
          { "/": "/artifacts/*", comment: "an Artifact's share link (raft artifact push, Copy link); the app opens it in its viewer" },
          {
            "/": "/external-invite/*",
            comment: "external channel invite (app 1.24+); the app's invite page reads the rest from the server",
          },
        ],
      },
    ],
  },
};

function associationResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Short, not immutable: rotating a signing cert or adding a path must
      // take effect without waiting out a long cache.
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function associationFileResponse(request) {
  const { pathname } = new URL(request.url);
  if (pathname === WELL_KNOWN_ASSETLINKS_PATH) return associationResponse(ANDROID_ASSETLINKS);
  if (pathname === WELL_KNOWN_AASA_PATH) return associationResponse(APPLE_APP_SITE_ASSOCIATION);
  return null;
}

function unavailableWellKnownResponse() {
  return new Response(null, {
    status: 404,
    statusText: "Not Found",
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function wellKnownResponse(request) {
  const { pathname } = new URL(request.url);
  const association = associationFileResponse(request);
  if (association) return association;

  if (pathname === WELL_KNOWN_CHANGE_PASSWORD_PATH) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL(CHANGE_PASSWORD_INTENT_PATH, request.url).toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  if (pathname === "/.well-known" || pathname.startsWith(WELL_KNOWN_PREFIX)) {
    return unavailableWellKnownResponse();
  }
  return null;
}

/**
 * Public Artifact pages for link previews and AI tools.
 *
 * `/artifacts/<id>` (and `/artifacts/<id>/v/<n>`, the web router's pinned
 * version) is the SPA shell for every client: title "Raft", no preview tags,
 * a body that says "Loading…". On a GET for that page the Worker asks the
 * API what a visitor signed out may know of the Artifact
 * (`/api/public/artifacts/<id>/meta`: the same check as the signed-out page,
 * a 404 for anything not public; never an author, a server or a viewer) and,
 * at the same time, its Markdown version (`index.md`, the same public check),
 * and writes them into the shell:
 * - the head, from the meta only (never from index.md): `<title>`, Open
 *   Graph and Twitter tags (a `summary` card: the image is the square app
 *   icon), the canonical link, the Markdown version and the entry file as
 *   alternates (the entry's only for an HTML or Markdown file, typed by its
 *   extension), and the robots noindex meta tag;
 * - the mount element (`#root`): a plain article (title, date, the files and
 *   the zip to download, the Markdown version, and index.md's text in a
 *   `<pre>`, at most ARTIFACT_ARTICLE_TEXT_MAX_BYTES of it with a note
 *   pointing at the Markdown version when cut; the meta's description in its
 *   place when index.md failed) for fetchers that turn a page's HTML into
 *   text without running it. React's createRoot replaces the root's children
 *   on mount (src/main.tsx; no hydration), and the article is visually hidden
 *   until then.
 * Every answer to an Artifact page GET or HEAD says `X-Robots-Tag: noindex,
 * nofollow`, rewritten or not (handleRequest, withArtifactNoindex). A request whose Accept prefers text/markdown over text/html gets
 * the Markdown version itself instead of the page.
 *
 * The server answers the same at `/artifacts/*` for when app.raft.build is
 * served by CloudFront instead (packages/server apps/artifacts/publicPage.ts):
 * a change to what this writes into the page goes into both.
 *
 * Nothing is cached here: unpublishing, deleting or a takedown must stop the
 * next answer. A rewritten page has no validators and is `no-store`, its
 * shell is fetched without the request's validators, and it is marked
 * (ARTIFACT_PREVIEW_HEADER) so the service worker never keeps it as the
 * app's shell. The meta and index.md are asked beside the shell's fetch,
 * each with the same short timeout (ARTIFACT_META_TIMEOUT_MS), so a page
 * waits about the longest of the three. The meta decides: any failure, a
 * non-200 (not public, unknown), no API origin or no HTMLRewriter: the page
 * as it is, nothing injected. Every injected value is HTML-escaped (titles,
 * paths, descriptions and index.md's text are user content), and index.md's
 * text goes nowhere but inside the hidden article.
 *
 * The API origin is the web build's VITE_API_URL, written over
 * __RAFT_API_ORIGIN__ at build time (scripts/workerApiOrigin.ts). A build
 * without an absolute one (previews, e2e) leaves the placeholder, and the
 * Worker injects nothing.
 */
const API_ORIGIN = "__RAFT_API_ORIGIN__";
// The short id (artifactShortId below): an older pt_ link is moved to it first (legacyArtifactLinkResponse).
const ARTIFACT_PAGE_PATH = /^\/artifacts\/([1-9A-HJ-NP-Za-km-z]{22})(?:\/v\/[1-9][0-9]{0,8})?\/?$/;
// How long a page waits for its meta (asked beside the shell, so a page takes
// about the longer of the two): the API answers in 250-450 ms from the edge
// (measured on staging and production, 2026-10-29); 400 ms gave up on most.
const ARTIFACT_META_TIMEOUT_MS = 1_500;
// How long a request that asked for Markdown waits for index.md: nothing else
// to show it, so it may wait longer.
const ARTIFACT_MARKDOWN_TIMEOUT_MS = 5_000;
// How much of index.md the page's article holds (UTF-8 bytes, cut at a character): the rest is in the Markdown version.
const ARTIFACT_ARTICLE_TEXT_MAX_BYTES = 50 * 1024;
const ARTIFACT_META_STRINGS = ["title", "description", "updatedAt", "kind", "entry"];
// The square app icon: the one brand image here a preview card can show (SVGs aren't; the wordmark PNG is 324×80).
const ARTIFACT_PREVIEW_IMAGE_PATH = "/android-chrome-512x512.png";
// Visually hidden (it is replaced when the app mounts), still text to a fetcher that reads the HTML.
const ARTIFACT_ARTICLE_STYLE = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0";
const SITEMAP_PATH = "/sitemap.xml";

/** The configured API origin (http(s), no path), or null while the placeholder stands or it isn't one. */
export function configuredApiOrigin(value = API_ORIGIN) {
  if (typeof value !== "string" || value.startsWith("__RAFT_")) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
}

/** A path's segments, each percent-encoded (as the API's file route reads them). */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

/** The API's public addresses of an Artifact. */
const artifactApi = (apiOrigin, id) => {
  const base = `${apiOrigin}/api/public/artifacts/${id}`;
  return {
    meta: `${base}/meta`,
    markdown: `${base}/index.md`,
    zip: `${base}/download.zip`,
    file: (path) => `${base}/files/${encodePath(path)}`,
  };
};

/** The meta answer when it is exactly the shape the API gives, else null. */
function validArtifactMeta(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const field of ARTIFACT_META_STRINGS) if (typeof value[field] !== "string") return null;
  if (value.title.trim() === "" || value.entry === "" || !Array.isArray(value.files)) return null;
  const filesValid = value.files.every((file) => typeof file === "object" && file !== null
    && typeof file.path === "string" && file.path !== ""
    && Number.isSafeInteger(file.size) && file.size >= 0
    && typeof file.entry === "boolean");
  return filesValid ? value : null;
}

/**
 * A GET of the API with the short timeout: `{ response }`, or `{ failure }`
 * naming why there is none (a timeout, or the error's name) for
 * ARTIFACT_DIAGNOSTIC_HEADER. Redirects are never followed: `manual`, so a
 * 3xx comes back as itself and its callers refuse anything but a 200. Not
 * `error`: the Workers runtime rejects it outright ("must be one of follow or
 * manual"), which made every ask fail before reaching the API.
 */
async function askApi(fetchApi, url, accept, timeoutMs) {
  try {
    return { response: await fetchApi(url, { method: "GET", headers: { Accept: accept }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }) };
  } catch (error) {
    const name = error && typeof error.name === "string" ? error.name : "Error";
    return { failure: name === "TimeoutError" || name === "AbortError" ? "timeout" : `error_${name.replace(/[^A-Za-z0-9_]/g, "")}` };
  }
}

/** The meta and why there is none: `{ meta, reason }`, reason `ok`, `timeout`, `error_<name>`, `status_<n>`, `not_json` or `invalid`. */
async function artifactMetaOutcome(id, { apiOrigin, fetch: fetchApi, timeoutMs = ARTIFACT_META_TIMEOUT_MS }) {
  const { response, failure } = await askApi(fetchApi, artifactApi(apiOrigin, id).meta, "application/json", timeoutMs);
  if (!response) return { meta: null, reason: failure };
  if (response.status !== 200) return { meta: null, reason: `status_${response.status}` };
  if (!isJsonResponse(response)) return { meta: null, reason: "not_json" };
  try {
    const meta = validArtifactMeta(await response.json());
    return meta ? { meta, reason: "ok" } : { meta: null, reason: "invalid" };
  } catch {
    return { meta: null, reason: "invalid" };
  }
}

/** The public Artifact's meta from the API, or null: not public, a non-200, a malformed answer, a timeout, any error. */
export async function artifactMeta(id, deps) {
  return (await artifactMetaOutcome(id, deps)).meta;
}

/** The q of `type` in an Accept header (exact type only), or null when it isn't listed. */
function acceptQuality(header, type) {
  for (const part of header.split(",")) {
    const [range, ...params] = part.trim().toLowerCase().split(";");
    if (range.trim() !== type) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const value = q === undefined ? 1 : Number(q.slice(2));
    return Number.isFinite(value) ? value : 0;
  }
  return null;
}

/** Whether the request's Accept prefers text/markdown: listed with q > 0, and text/html absent or with a lower q. */
export function prefersMarkdown(request) {
  const header = request.headers.get("accept") ?? "";
  const markdown = acceptQuality(header, "text/markdown");
  if (markdown === null || markdown <= 0) return false;
  const html = acceptQuality(header, "text/html");
  return html === null || markdown > html;
}

/**
 * The Markdown version for a request that prefers it: the API's index.md
 * (which the API sends as text/plain) with its own headers (text/markdown, nosniff, a sandboxing CSP, noindex,
 * no-store), or null (not public, a failure: the page as usual).
 */
export async function artifactMarkdownResponse(request, deps) {
  return (await artifactMarkdownOutcome(request, deps)).response;
}

/**
 * artifactMarkdownResponse with why there is none: `{ response, reason }`,
 * reason null when this isn't a Markdown request for an Artifact page,
 * else `no_api_origin` or the ask's (askApi, `status_<n>`, `not_markdown`).
 */
async function artifactMarkdownOutcome(request, { apiOrigin, fetch: fetchApi, timeoutMs = ARTIFACT_MARKDOWN_TIMEOUT_MS }) {
  if (request.method !== "GET" || !prefersMarkdown(request)) return { response: null, reason: null };
  const match = ARTIFACT_PAGE_PATH.exec(new URL(request.url).pathname);
  if (!match) return { response: null, reason: null };
  if (!apiOrigin) return { response: null, reason: "no_api_origin" };
  const { response, failure } = await askApi(fetchApi, artifactApi(apiOrigin, match[1]).markdown, "text/markdown", timeoutMs);
  if (!response) return { response: null, reason: failure };
  if (response.status !== 200) return { response: null, reason: `status_${response.status}` };
  if (!isMarkdownResponse(response)) return { response: null, reason: "not_markdown" };
  let body;
  try {
    body = await response.text();
  } catch {
    return { response: null, reason: "error_body" };
  }
  return { reason: "ok", response: new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Robots-Tag": "noindex, nofollow",
      [ARTIFACT_PREVIEW_HEADER]: "1",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      Vary: "Accept",
    },
  }) };
}

// index.md as the API sends it: text/plain (ChatGPT's fetch refuses
// text/markdown), or text/markdown from an API before that; never HTML.
const isMarkdownResponse = (response) => /^text\/(?:plain|markdown)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");

/**
 * index.md's text for the page's article: `{ text, cut }`, at most
 * ARTIFACT_ARTICLE_TEXT_MAX_BYTES of UTF-8 (cut at a character boundary;
 * the rest of the body is never read), or null on anything but a 200
 * text/plain or text/markdown (a timeout, an error, not public). Never rejects: it is
 * asked beside the meta and left unawaited when the meta has none.
 */
async function artifactTextOutcome(id, { apiOrigin, fetch: fetchApi, timeoutMs = ARTIFACT_META_TIMEOUT_MS }) {
  const { response } = await askApi(fetchApi, artifactApi(apiOrigin, id).markdown, "text/markdown", timeoutMs);
  if (!response || response.status !== 200 || !isMarkdownResponse(response) || !response.body) return null;
  try {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (length <= ARTIFACT_ARTICLE_TEXT_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
    const cut = length > ARTIFACT_ARTICLE_TEXT_MAX_BYTES;
    if (cut) reader.cancel().catch(() => {});
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    let end = length;
    if (cut) {
      end = ARTIFACT_ARTICLE_TEXT_MAX_BYTES;
      // Back to the start of the character the limit falls in (a UTF-8 continuation byte is 10xxxxxx).
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    }
    return { text: new TextDecoder().decode(bytes.subarray(0, end)), cut };
  } catch {
    return null;
  }
}

/** A size as people read it: bytes, KB or MB (1024s), one decimal under ten (as index.md says it). */
function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, "KB"] : [bytes / (1024 * 1024), "MB"];
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** The tags written into the page's head for `meta`; every value escaped. */
export function artifactHeadTags({ meta, id, pageOrigin, apiOrigin }) {
  const canonical = `${pageOrigin}/artifacts/${id}`;
  const api = artifactApi(apiOrigin, id);
  const description = meta.description || `${meta.title}, shared from Raft.`;
  const entryType = entryAlternateType(meta.entry);
  const metaTag = (attr, name, content) => `<meta ${attr}="${escapeHtml(name)}" content="${escapeHtml(content)}">`;
  const link = (attrs) => `<link ${Object.entries(attrs).map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(" ")}>`;
  return [
    metaTag("name", "robots", "noindex, nofollow"),
    metaTag("name", "description", description),
    metaTag("property", "og:type", "article"),
    metaTag("property", "og:site_name", "Raft"),
    metaTag("property", "og:title", meta.title),
    metaTag("property", "og:description", description),
    metaTag("property", "og:url", canonical),
    metaTag("property", "og:image", `${pageOrigin}${ARTIFACT_PREVIEW_IMAGE_PATH}`),
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

/** The media type the entry file is linked as an alternate with, from its extension: HTML or Markdown, else null (no alternate). */
function entryAlternateType(entry) {
  const name = entry.slice(entry.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "md" || extension === "markdown") return "text/markdown";
  return null;
}

/**
 * The readable article written into `#root` for `meta`, with index.md's
 * text (artifactTextOutcome's `{ text, cut }`) when there is one, else the
 * meta's description; every value escaped.
 */
export function artifactArticle({ meta, id, apiOrigin, text = null }) {
  const api = artifactApi(apiOrigin, id);
  const item = (href, label, note) => `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a> (${escapeHtml(note)})</li>`;
  const markdownLink = `<a href="${escapeHtml(api.markdown)}">${escapeHtml(api.markdown)}</a>`;
  return [
    `<article data-raft-artifact-preview style="${ARTIFACT_ARTICLE_STYLE}">`,
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
    text?.cut ? `<p>The text above is cut at ${ARTIFACT_ARTICLE_TEXT_MAX_BYTES / 1024} KB. The full text is in the Markdown version: ${markdownLink}</p>` : "",
    `<p>Markdown version: ${markdownLink}</p>`,
    "</article>",
  ].filter(Boolean).join("\n");
}

/**
 * Marks every answer the Worker rewrote or made for an Artifact page: the
 * service worker (sw.js keepShell) never keeps one as the app's shell.
 */
export const ARTIFACT_PREVIEW_HEADER = "X-Raft-Artifact-Preview";
/**
 * On every Artifact page answer, why it is or isn't rewritten, so one curl
 * tells: `injected`, or `skipped=` `no_api_origin` (the build left the
 * placeholder), `no_rewriter`, `shell_<status>`, `shell_not_html`, or the
 * meta ask's reason (`timeout`, `error_<name>`, `status_<n>`, `not_json`,
 * `invalid`); a Markdown request that fell back adds `markdown=<reason>`.
 * Reasons only, never a value from the API. Not ARTIFACT_PREVIEW_HEADER:
 * the service worker reads that one as "a rewritten page".
 */
export const ARTIFACT_DIAGNOSTIC_HEADER = "X-Raft-Artifact-Diagnostic";

/** Why an Artifact page request gets no rewrite before anything is asked, or null (not an Artifact page GET, or ready). */
function artifactPageSkip(request, deps) {
  if (request.method !== "GET" || !ARTIFACT_PAGE_PATH.test(new URL(request.url).pathname)) return null;
  if (!deps.apiOrigin) return "no_api_origin";
  if (typeof deps.HTMLRewriter !== "function") return "no_rewriter";
  return null;
}

/** `response` with the diagnostic header (a copy: an ASSETS response's headers are immutable). */
function withArtifactDiagnostic(response, value) {
  const headers = new Headers(response.headers);
  headers.set(ARTIFACT_DIAGNOSTIC_HEADER, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * A GET for `/artifacts/<id>[/v/<n>]` the Worker may rewrite (an API origin
 * and HTMLRewriter there): the id, and its meta and index.md's text asked at
 * once, so both asks run beside the shell's fetch. `askText: false` when
 * index.md was just asked and failed (a Markdown request that fell back).
 * Null for anything else.
 */
export function startArtifactPage(request, deps, { askText = true } = {}) {
  if (request.method !== "GET" || !deps.apiOrigin || typeof deps.HTMLRewriter !== "function") return null;
  const match = ARTIFACT_PAGE_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  // Neither ask ever rejects (null on any failure), so one left unawaited is harmless.
  const outcome = artifactMetaOutcome(match[1], deps);
  const text = askText ? artifactTextOutcome(match[1], deps) : null;
  return { id: match[1], outcome, meta: outcome.then((result) => result.meta), text };
}

/**
 * The request for the shell of an Artifact page that may be rewritten,
 * without its validators: a 304 would let a browser keep a copy rewritten
 * before (an Artifact since unpublished), so the shell is fetched whole and
 * the decision made afresh each time.
 */
export function withoutValidators(request) {
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(request, { headers });
}

/**
 * The public Artifact page with its preview head and article, or `response`
 * with its body unchanged: not a GET for `/artifacts/<id>[/v/<n>]` (headers
 * untouched too), not the 200 HTML shell, no API origin or HTMLRewriter, or
 * no meta (artifactMeta's null); on an Artifact page GET, only the
 * diagnostic header added (withArtifactDiagnostic).
 * `started` is startArtifactPage's (asked beside the shell), else it is asked
 * now. A rewritten page is never kept: no ETag or Last-Modified, `no-store`,
 * and marked for the service worker.
 */
export async function artifactPageResponse(request, response, deps, started = startArtifactPage(request, deps)) {
  if (!started) {
    const skip = artifactPageSkip(request, deps);
    return skip ? withArtifactDiagnostic(response, `skipped=${skip}`) : response;
  }
  if (response.status !== 200) return withArtifactDiagnostic(response, `skipped=shell_${response.status}`);
  if (!isHtmlResponse(response)) return withArtifactDiagnostic(response, "skipped=shell_not_html");
  const { meta, reason } = started.outcome ? await started.outcome : { meta: await started.meta, reason: "invalid" };
  if (!meta) return withArtifactDiagnostic(response, `skipped=${reason}`);
  const { id } = started;
  const { apiOrigin, HTMLRewriter: Rewriter } = deps;
  const tags = artifactHeadTags({ meta, id, pageOrigin: new URL(request.url).origin, apiOrigin });
  // Asked with the meta and the same timeout: waiting for it adds nothing past the slower of the two.
  const text = started.text ? await started.text : null;
  const article = artifactArticle({ meta, id, apiOrigin, text });
  const title = `${meta.title} | Raft`;
  const rewritten = new Rewriter()
    .on("title", { element(element) { element.setInnerContent(escapeHtml(title), { html: true }); } })
    .on("head", { element(element) { element.append(tags, { html: true }); } })
    .on("#root", { element(element) { element.prepend(article, { html: true }); } })
    .transform(response);
  const headers = new Headers(rewritten.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set(ARTIFACT_PREVIEW_HEADER, "1");
  headers.set(ARTIFACT_DIAGNOSTIC_HEADER, "injected");
  // Made for this request only: unpublishing must show on the next one.
  headers.set("Cache-Control", "no-store");
  headers.delete("etag");
  headers.delete("last-modified");
  // The same address answers Markdown to an Accept that prefers it.
  headers.append("Vary", "Accept");
  // The length changed with the head.
  headers.delete("content-length");
  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
}

/** `/sitemap.xml`: none here (the app has no pages to list), a real 404 rather than the SPA shell. */
function sitemapResponse(request) {
  if (new URL(request.url).pathname !== SITEMAP_PATH) return null;
  return new Response("Not Found\n", {
    status: 404,
    statusText: "Not Found",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * An older Artifact link, `/artifacts/pt_<uuid>[/v/<n>]`, moved for good to
 * the form links are written in now, `/artifacts/<short id>[/v/<n>]`: the
 * uuid's 16 bytes in Base58 (the Bitcoin alphabet), always 22 characters,
 * left-padded with "1" (packages/shared artifactShortId.ts, which this
 * mirrors; tests/cloudflareAssetWorker.test.ts checks they agree). GET and
 * HEAD only, the query kept (a browser keeps the fragment). Anything else
 * under /artifacts/ goes to the app as before, which reads both forms and
 * rewrites the address itself where this Worker doesn't run.
 */
const LEGACY_ARTIFACT_LINK = /^\/artifacts\/pt_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/v\/[1-9][0-9]{0,8})?\/?$/;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ARTIFACT_SHORT_ID_LENGTH = 22;

export function artifactShortId(uuid) {
  const hex = uuid.replace(/-/g, "");
  const digits = new Array(ARTIFACT_SHORT_ID_LENGTH).fill(0);
  for (let at = 0; at < hex.length; at += 2) {
    let carry = Number.parseInt(hex.slice(at, at + 2), 16);
    for (let i = ARTIFACT_SHORT_ID_LENGTH - 1; i >= 0; i -= 1) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
  }
  return digits.map((digit) => BASE58_ALPHABET[digit]).join("");
}

function legacyArtifactLinkResponse(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const match = LEGACY_ARTIFACT_LINK.exec(url.pathname);
  if (!match) return null;
  const location = new URL(`/artifacts/${artifactShortId(match[1])}${match[2] ?? ""}${url.search}`, url);
  return new Response(null, {
    status: 301,
    headers: {
      Location: location.toString(),
      "Cache-Control": "public, max-age=86400",
    },
  });
}

function applySecurityHeaders(headers) {
  headers.set("Content-Security-Policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-9/rA/fGEYHRZyCw7+bvhgE1lOzeGdFvDtZBQrvBmyVU=' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://static.cloudflareinsights.com; worker-src 'self' blob:");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function withSecurityHeaders(response) {
  const headers = applySecurityHeaders(new Headers(response.headers));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Every request the Worker answers (the default export's, with the
 * deployment's Artifact dependencies: the API origin written in at build,
 * the runtime's fetch and HTMLRewriter).
 */
export async function handleRequest(request, env, artifactDeps) {
  // Before touching static assets: owned well-known paths must return their
  // exact response, and every other well-known path must be a real 404. A
  // Pages SPA fallback answers 200 text/html for missing routes; Chrome treats
  // that as an unreliable change-password URL and ignores our redirect.
  const wellKnown = wellKnownResponse(request);
  if (wellKnown) return withSecurityHeaders(wellKnown);

  const legacyArtifactLink = legacyArtifactLinkResponse(request);
  if (legacyArtifactLink) return withSecurityHeaders(legacyArtifactLink);

  const sitemap = sitemapResponse(request);
  if (sitemap) return withSecurityHeaders(sitemap);

  const precompressed = await precompressedAssetResponse(request, env);
  if (precompressed) return precompressed;

  // Its own headers (a sandboxing CSP, not the app's): never through withSecurityHeaders.
  const markdown = await artifactMarkdownOutcome(request, artifactDeps);
  if (markdown.response) return markdown.response;

  // An Artifact page's meta is asked before the shell, and awaited only once the shell is the 200 HTML.
  const started = startArtifactPage(request, artifactDeps, { askText: !markdown.reason });
  const response = await env.ASSETS.fetch(started ? withoutValidators(request) : request);
  const manifestResponse = await normalizeDesktopManifestResponse(request, response);
  let page = await artifactPageResponse(request, normalizeBuiltAssetResponse(request, manifestResponse), artifactDeps, started);
  if (markdown.reason) {
    const diagnostic = page.headers.get(ARTIFACT_DIAGNOSTIC_HEADER);
    page = withArtifactDiagnostic(page, `${diagnostic ? `${diagnostic}; ` : ""}markdown=${markdown.reason}`);
  }
  if (isArtifactPageRequest(request)) page = withArtifactNoindex(page);
  return withSecurityHeaders(page);
}

/**
 * A GET or HEAD of an Artifact page (`/artifacts/<id>[/v/<n>]`). Every answer
 * to one says noindex, rewritten or not: robots.txt lets crawlers fetch these
 * pages (so they can see the noindex), and the SPA shell they fall back to
 * carries none of its own.
 */
function isArtifactPageRequest(request) {
  return (request.method === "GET" || request.method === "HEAD") && ARTIFACT_PAGE_PATH.test(new URL(request.url).pathname);
}

/** `response` saying noindex, nofollow (a copy: an ASSETS response's headers are immutable). */
function withArtifactNoindex(response) {
  if (response.headers.get("X-Robots-Tag") === "noindex, nofollow") return response;
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env, {
      apiOrigin: configuredApiOrigin(),
      fetch: (...args) => fetch(...args),
      HTMLRewriter: globalThis.HTMLRewriter,
    });
  },
};
