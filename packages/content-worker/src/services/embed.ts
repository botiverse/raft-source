/**
 * Public Artifacts embedded on any site (#proj-workspace:#260; Porthole P143). The pieces of the
 * embed host that need nothing of the Worker's: its settings, the outer page Raft serves on
 * EMBED_DOMAIN (`GET /pt_<uuid>`), the page's one script and style, an embedder's registrable
 * domain, and the answers every hidden case shares. raftContentService.ts routes to them, asks
 * Raft, and mints the embed session.
 *
 * ```
 * any site
 *  └─ <iframe src="https://<EMBED_DOMAIN>/pt_<uuid>">           the outer page: Raft's code alone
 *      ├─ a bar: the title, "Open in Raft"
 *      └─ <iframe src="https://w-<uuid>.<CONTENT_DOMAIN>/_raft/embed">   an embed session (Porthole)
 * ```
 *
 * The outer page holds no state, sets no cookie, listens to no message, frames exactly its
 * Artifact's own label (`frame-src`), and is framed by any page. Its script only asks whether the
 * Artifact is still public (`/pt_<uuid>/live`), and blanks the frame once it isn't.
 */
import { statusPage } from "@botiverse/porthole/server";
import { FONT_VARIABLES, MARKDOWN_FONTS_DIR, MARKDOWN_FONT_FACES, pageLangOf } from "../markdown";
import { RAFT_LOGO_SVG } from "./embedLogo";

/** The settings the embed host reads (RaftContentEnv's). */
export type EmbedSettings = {
  readonly EMBEDS?: string;
  readonly EMBED_DOMAIN?: string;
  readonly CONTENT_DOMAIN?: string;
  readonly APP_ORIGIN?: string;
};

/** A host name, lowercase DNS labels, an optional port (tests, local dev). */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

/** Whether EMBEDS turns embeds on: exactly `1` or `true` (any case). Anything else, or unset, is off. */
export const embedsSwitchedOn = (env: EmbedSettings): boolean => /^(1|true)$/i.test(env.EMBEDS?.trim() ?? "");

const hostOnly = (host: string): string => host.replace(/:\d+$/, "");
const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const lastTwo = (host: string): string => host.split(".").slice(-2).join(".");

/**
 * Why EMBED_DOMAIN can't be the embed host; null if it can. A host (`host[:port]`), never the
 * content domain nor under it (whose hosts are Porthole's alone), never under it the other way,
 * and never on the Raft app's site (the outer page must never share the app's cookies).
 */
export function embedDomainProblem(env: EmbedSettings): string | null {
  const domain = env.EMBED_DOMAIN?.trim().toLowerCase() ?? "";
  if (!HOST.test(domain)) return "EMBED_DOMAIN is not a host name";
  const embed = hostOnly(domain);
  const content = hostOnly(env.CONTENT_DOMAIN?.trim().toLowerCase() ?? "");
  if (content !== "" && (under(embed, content) || under(content, embed))) return "EMBED_DOMAIN overlaps CONTENT_DOMAIN";
  const app = URL.canParse(env.APP_ORIGIN ?? "") ? new URL(env.APP_ORIGIN!).hostname : "";
  if (app !== "" && lastTwo(app) === lastTwo(embed) && !embed.endsWith("localhost")) return "EMBED_DOMAIN is on the Raft app's site";
  return null;
}

/** When EMBED_DOMAIN's problem was last logged: once per value per isolate. */
let loggedProblem: string | null = null;

/**
 * The embed host, lowercase `host[:port]`, while embeds are on: EMBEDS says so (the kill switch)
 * and EMBED_DOMAIN is a usable host. Null otherwise: then the embed host and `/_raft/embed` answer
 * the one 404, and Porthole takes no embed grant (`embeds: false`). A bad EMBED_DOMAIN is logged
 * (the setting, never the visitor's request) and fails closed.
 */
export function embedDomainOf(env: EmbedSettings): string | null {
  if (!embedsSwitchedOn(env)) return null;
  const problem = embedDomainProblem(env);
  if (problem !== null) {
    if (loggedProblem !== `${env.EMBED_DOMAIN}`) console.error("[raft-content] embeds misconfigured:", problem);
    loggedProblem = `${env.EMBED_DOMAIN}`;
    return null;
  }
  return env.EMBED_DOMAIN!.trim().toLowerCase();
}

/** Whether a request is for the embed host (its URL's host or its Host header, the port aside). */
export function onEmbedDomain(request: Request, domain: string): boolean {
  const want = hostOnly(domain);
  return [new URL(request.url).hostname, hostOnly(request.headers.get("host") ?? "")].some((host) => host.toLowerCase() === want);
}

// --- Embedders ----------------------------------------------------------------

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/**
 * Second-level labels under a two-letter country code that are a public suffix of their own
 * (`co.uk`, `com.au`, `ne.jp`): without the public suffix list, the common ones. A rarer one
 * groups its sites into one bucket, which only makes its budget shared, never a log richer.
 */
const COUNTRY_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "gov", "gv", "ltd", "me", "mil", "ne", "net", "or", "org", "plc", "sch"]);

/**
 * The registrable domain of the page that embeds an Artifact, from the outer page's request:
 * its Referer (the browser sends the embedding page's origin by default), else its Origin.
 * `none` when neither names an http(s) page; `ip` for an address (never logged as one);
 * `localhost` for loopback. Otherwise the last two labels, three under a country code's
 * common second level. Only this is ever logged or keyed on: never the path, query or address.
 */
export function embedderOf(request: Request): string {
  for (const header of ["referer", "origin"]) {
    const value = request.headers.get(header) ?? "";
    if (!URL.canParse(value)) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "") continue;
    if (IPV4.test(host) || host.startsWith("[")) return "ip";
    if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
    const labels = host.split(".");
    if (labels.length <= 2) return host;
    const [second, top] = labels.slice(-2) as [string, string];
    const keep = top.length === 2 && COUNTRY_SECOND_LEVELS.has(second) ? 3 : 2;
    return labels.slice(-keep).join(".");
  }
  return "none";
}

/** When each Artifact and embedder last had a view logged in this isolate: at most one line a minute each. */
const viewLogged = new Map<string, number>();

/**
 * Logs an embed view (`raft-content.embed-view`): the Artifact, its kind and the embedder's
 * registrable domain (`embedderOf`), for abuse triage ("who hotlinks it"). Never an address,
 * a path, a query or a cookie. At most once a minute per Artifact and embedder per isolate. Kept
 * as long as the Worker's logs are (Workers Logs, within 30 days).
 */
export function logEmbedView(artifact: string, kind: string, embedder: string): void {
  const key = `${artifact}|${embedder}`;
  const now = Date.now();
  const last = viewLogged.get(key);
  if (last !== undefined && now - last < 60_000) return;
  if (viewLogged.size > 10_000) viewLogged.clear();
  viewLogged.set(key, now);
  console.log(JSON.stringify({ evt: "raft-content.embed-view", artifact, kind, embedder }));
}

// --- What the embed host answers ------------------------------------------------

/** The outer page's own files, under `/_embed/` on the embed host. */
export const EMBED_ASSET_PREFIX = "/_embed/";

/** The outer page's response headers, but `frame-src` (its own label) and the cache. */
const OUTER_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "permissions-policy":
    "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

/**
 * The takedown bound (Tenny): once Raft stops saying an Artifact embeds (unpublished, taken down,
 * deleted, a new kind), every new load and every request of an open embed session is refused within
 * this many seconds. Each chain of caches sums to at most it:
 * - the outer page and `/live`: `no-cache` for the browser (nothing kept past a revalidation), then
 *   Raft's answer reused per isolate (`EMBEDDABLE_TTL_SECONDS`);
 * - an embed session's requests: Raft's authorize answer for its subject, reused per isolate across
 *   sessions (`EMBED_AUTHORIZE_TTL_SECONDS`); Porthole's own per-session copy of it is dropped the
 *   moment that memo expires (raftContentService.ts `sweepEmbedAuthorized`, before every request),
 *   so a copy is never older than the memo it came from.
 */
export const EMBED_TAKEDOWN_BOUND_SECONDS = 30;
/** How long Raft's yes for an Artifact's embed is reused per isolate (a no: `NOT_EMBEDDABLE_TTL_SECONDS`). */
export const EMBEDDABLE_TTL_SECONDS = 30;
export const NOT_EMBEDDABLE_TTL_SECONDS = 10;
/** How long Raft's authorize answer for an embed subject is reused per isolate, across sessions. */
export const EMBED_AUTHORIZE_TTL_SECONDS = 30;
/** How often an open outer page asks `/live` while it shows (and at once when it shows again). */
export const EMBED_LIVE_POLL_SECONDS = 30;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Raft's website, where the logo goes (brand rules: a public page outside the app shows the mark, linked there). */
export const RAFT_WEBSITE = "https://raft.build";
/** The fonts the outer page serves itself (`/_embed/fonts/<file>`): Space Grotesk's faces of the Markdown page's set. */
export const EMBED_FONT_PREFIX = `${"/_embed/"}fonts/`;
export const EMBED_FONT_FACES = MARKDOWN_FONT_FACES.filter((face) => face.family === "Space Grotesk");

/**
 * The outer page (`GET /pt_<uuid>` on the embed host) for a public, current Artifact: its
 * Artifact's embed session in a frame (`content`, `<its origin>/_raft/embed`) and the bar below
 * (the Raft logo linked to Raft's website, the title as escaped text, "Open in Raft" to its page in
 * the app; both links a new tab, no referrer). Its CSP loads only its own script, style and fonts,
 * frames only that one origin and is framed by any page. No cookie, no message listener. `no-cache`:
 * the browser revalidates every load, so the takedown bound is the isolate's cache alone.
 */
export function embedOuterPage(options: { artifact: string; title: string; contentOrigin: string; appOrigin: string; method: string }): Response {
  const { artifact, title, contentOrigin } = options;
  // The Artifact's page in the app by its long id, which the app reads as its short one (shared artifactRef).
  const open = `${new URL(options.appOrigin).origin}/artifacts/${artifact}`;
  const name = escapeHtml(title);
  const body = `<!doctype html><html lang="${pageLangOf(title)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light"><title>${name}</title><link rel="stylesheet" href="${EMBED_ASSET_PREFIX}embed.css"><script src="${EMBED_ASSET_PREFIX}embed.js" defer></script></head><body data-raft-embed="${escapeHtml(artifact)}"><iframe class="content" src="${escapeHtml(`${contentOrigin}/_raft/embed`)}" title="${name}" sandbox="allow-scripts allow-same-origin" allow="" referrerpolicy="no-referrer"></iframe><p class="gone" role="status" hidden>This Artifact isn't available.</p><footer class="bar"><a class="brand" href="${RAFT_WEBSITE}" target="_blank" rel="noopener noreferrer" aria-label="Raft">${RAFT_LOGO_SVG}</a><span class="title" dir="auto">${name}</span><a class="open" href="${escapeHtml(open)}" target="_blank" rel="noopener noreferrer">Open in Raft</a></footer></body></html>`;
  return new Response(options.method.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers: {
      ...OUTER_HEADERS,
      "cache-control": "no-cache",
      "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src ${contentOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors *`,
    },
  });
}

/**
 * The outer page's script: while the page shows, asks `<page>/live` every EMBED_LIVE_POLL_SECONDS,
 * and at once when it shows again; while hidden it asks nothing. A 404 there (no longer public,
 * taken down, a new kind) removes the frame and shows the line saying it isn't available, and the
 * asking stops. Any other answer (a network error) changes nothing.
 */
const EMBED_JS = `(() => {
  const live = location.pathname.replace(/\\/+$/, "") + "/live";
  let timer = null;
  let gone = false;
  const check = () => {
    if (gone || document.visibilityState !== "visible") return;
    fetch(live, { cache: "no-store", credentials: "omit" }).then((answer) => {
      if (answer.status !== 404 || gone) return;
      gone = true;
      stop();
      const frame = document.querySelector("iframe.content");
      if (frame) frame.remove();
      const line = document.querySelector(".gone");
      if (line) line.hidden = false;
    }, () => {});
  };
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    if (gone || document.visibilityState !== "visible") return;
    timer = setInterval(check, ${EMBED_LIVE_POLL_SECONDS * 1_000});
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      check();
      start();
    } else stop();
  });
  start();
})();
`;

/**
 * Raft's light design tokens (raft-ui foundation.css): `foreground`, `foreground-muted`,
 * `foreground-link`, `layer-canvas` (the page), `layer-card` (the bar), `line-seam` (its top edge)
 * and the focus ring; the logo's two tones (raft-logo.svg's). Light only, as the embedded page is:
 * no host passes it the visitor's theme yet, and a dark bar under a light page reads as two things
 * (Kirby, #proj-workspace:#260). Both follow `prefers-color-scheme` together in a follow-up.
 */
const TOKENS = `:root{color-scheme:light;
  --foreground:oklch(0.1813 0.005 17.62);--foreground-muted:oklch(0.1813 0.005 17.62 / 0.678);
  --foreground-link:oklch(0.4327 0.1282 256.54);--layer-canvas:oklch(1 0 0);--layer-card:oklch(1 0 0);
  --line-seam:oklch(0.1813 0.005 17.62 / 0.451);
  --focus-ring:0 0 0 2px oklch(1 0 0),0 0 0 4px oklch(0.1813 0.005 17.62);
  --logo-ink:#141111;--logo-paper:#FFFAEF}`;

/**
 * The outer page's style: Space Grotesk from the embed host itself (the Markdown page's files, the
 * same @font-face ranges) with raft-ui's font variables (CJK stacks per `lang`), the DS's
 * `text-control` size (13/18 on a phone, 14/22 with a fine pointer at 48rem and up), the tokens
 * above, and links with at least a 24 px target (44 px on a coarse pointer) and the DS focus ring.
 */
const EMBED_CSS = `${EMBED_FONT_FACES.map(({ file, family, weight, range }) =>
  `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(${EMBED_FONT_PREFIX}${file}) format('woff2');unicode-range:${range}}`).join("\n")}
${FONT_VARIABLES}
${TOKENS}
html,body{margin:0;height:100%;background:var(--layer-canvas);color:var(--foreground);font:400 13px/18px var(--sans-font)}
@media (min-width:48rem) and (pointer:fine){html,body{font-size:14px;line-height:22px}}
body{display:flex;flex-direction:column}
iframe.content{flex:1;width:100%;border:0;display:block}
.gone{flex:1;display:flex;align-items:center;justify-content:center;margin:0;padding:16px;text-align:center;color:var(--foreground-muted)}
.gone[hidden]{display:none}
.bar{display:flex;align-items:center;gap:8px;padding:4px 8px 4px 12px;border-top:1px solid var(--line-seam);background:var(--layer-card)}
.bar a{display:inline-flex;align-items:center;min-height:24px;min-width:24px;border-radius:6px;outline:none;text-decoration:none}
.bar a:focus-visible{box-shadow:var(--focus-ring)}
.brand{flex:none;padding:0 2px}
.logo{display:block;height:16px;width:auto}
.logo .ink{fill:var(--logo-ink)}.logo .paper{fill:var(--logo-paper)}
.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.open{flex:none;padding:0 8px;color:var(--foreground-link);white-space:nowrap}
.open:hover{text-decoration:underline}
@media (pointer:coarse){.bar a{min-height:44px;min-width:44px}.brand{justify-content:center}}
`;

const ASSETS: ReadonlyMap<string, { readonly type: string; readonly body: string }> = new Map([
  [`${EMBED_ASSET_PREFIX}embed.js`, { type: "text/javascript; charset=utf-8", body: EMBED_JS }],
  [`${EMBED_ASSET_PREFIX}embed.css`, { type: "text/css; charset=utf-8", body: EMBED_CSS }],
]);

/** One of the outer page's own files, or null. Static, the same for everyone, cached a day. */
export function embedAsset(pathname: string, method: string): Response | null {
  const asset = ASSETS.get(pathname);
  if (!asset) return null;
  return new Response(method.toUpperCase() === "HEAD" ? null : asset.body, {
    status: 200,
    headers: {
      "content-type": asset.type,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** One of the outer page's fonts (`/_embed/fonts/<file>`, bytes from markdownFonts.ts), or null for any other path. */
export function embedFont(pathname: string, method: string, files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly sha256: string }>): Response | null {
  if (!pathname.startsWith(EMBED_FONT_PREFIX)) return null;
  const file = pathname.slice(EMBED_FONT_PREFIX.length);
  const face = EMBED_FONT_FACES.find((each) => each.file === file);
  const found = face && files.get(`${MARKDOWN_FONTS_DIR}${face.file}`);
  if (!found) return null;
  return new Response(method.toUpperCase() === "HEAD" ? null : new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=86400",
      etag: `"${found.sha256}"`,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** Whether an Artifact still embeds (`/pt_<uuid>/live`, for the outer page's script): 204, else the one 404. `no-cache`, as the page. */
export function embedLive(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * The one answer for every Artifact that doesn't embed, on the embed host and on `/_raft/embed`
 * alike: nonexistent, malformed, private, server-only, deleted, taken down, not current, a kind
 * that isn't framed, embeds off. Porthole's embed status page (framed by any page, told to no
 * one), the same status, headers and bytes whatever the reason, which is never said.
 */
export function embedNotFound(method: string): Response {
  return statusPage({
    embed: true,
    status: 404,
    title: "Not available",
    detail: "This Artifact isn't available.",
    reason: "not-found",
    method,
  });
}

/**
 * Past an embed budget (per Artifact, per embedding site, per viewer): Porthole's embed status
 * page, 429, blank where the embed is. Never a 5xx, never cached.
 */
export function embedRateLimited(method: string): Response {
  return statusPage({
    embed: true,
    status: 429,
    title: "Too many requests",
    detail: "Try again in a minute.",
    reason: "error",
    method,
  });
}

/** Raft couldn't be asked whether an Artifact embeds: Porthole's embed status page, 503, never cached. */
export function embedUnavailable(method: string): Response {
  return statusPage({
    embed: true,
    status: 503,
    title: "Not available right now",
    detail: "Try again later.",
    reason: "error",
    method,
  });
}
