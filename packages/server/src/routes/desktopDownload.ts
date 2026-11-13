import { Router } from "express";
import { mobileDownloadChooserUrl } from "./mobileDownload";

/**
 * Public redirect to the current Raft Desktop build.
 *
 * `GET /api/desktop-download?target=mac|mac-arm64|mac-x64|linux-appimage|linux-deb|windows`
 * `GET /api/desktop-download/platforms` — what the Latest release offers (JSON)
 *
 * The desktop twin of `/api/mobile-download`, and public for the same reason:
 * the `/download` page is anonymous.
 *
 * **The version comes from the desktop's own auto-update feed** — the
 * `latest-mac.yml` / `latest-linux.yml` / `latest.yml` that electron-updater
 * reads. By default that is the Hands feed the app itself is built against
 * (`apps/desktop/electron-builder.yml`, `provider: generic`), so a download from
 * the web and an in-app update can never disagree about which build is current,
 * the bytes come from the same CDN (fast in China too), and a release needs no
 * extra step to reach this route: activating it on Hands is the switch.
 * The asset filenames carry the version (`Raft-Desktop-0.1.42-arm64.dmg`), so
 * there is no stable per-file URL to link to directly; this route is the stable
 * address.
 *
 * **An explicit target is required; the UA is never consulted.** An iPad
 * reports a User-Agent byte-identical to a Mac (see `platformFromUserAgent` in
 * mobileDownload.ts), so a UA guess here would hand an iPad a .dmg. Only the
 * browser can tell them apart (`maxTouchPoints`), so the web decides the target
 * and anything without one goes to the `/download` chooser.
 *
 * **Where the feed is read (two layouts):**
 * - Generic feed (default): one flat folder, as electron-builder's `generic`
 *   provider and `apps/desktop/scripts/publish-hands-desktop.ts` lay it out.
 *   Feed `<base>/<feed>`, installer `<base>/<file>`. Base:
 *   `RAFT_DESKTOP_FEED_BASE_URL`, default
 *   `https://hands.build/electron/raft-desktop/main`. No build for the
 *   platform (a 404 feed, or a feed without that installer) sends a person to
 *   the `/download` chooser; Hands failing sends them to the GitHub Latest
 *   release page (`https://github.com/botiverse/desktop/releases/latest`),
 *   which carries every build too, so downloads keep working while Hands is down.
 * - GitHub releases: set `RAFT_DESKTOP_RELEASES_BASE_URL` (e.g.
 *   `https://github.com/botiverse/desktop/releases`; it wins over the generic
 *   base). Feed `<base>/latest/download/<feed>`, installer
 *   `<base>/download/v<version>/<file>`, fallback `<base>/latest` (either case).
 */

export const HANDS_FEED_BASE = "https://hands.build/electron/raft-desktop/main";
/** Every release is also published here (docs/operations/desktop-release-sop.md). */
export const GITHUB_RELEASES_BASE = "https://github.com/botiverse/desktop/releases";

export type DesktopFeedSource = { layout: "generic" | "github"; base: string };

/** The env's choice of feed (see the header comment). */
export function desktopFeedSourceFromEnv(env: NodeJS.ProcessEnv): DesktopFeedSource {
  if (env.RAFT_DESKTOP_RELEASES_BASE_URL) return { layout: "github", base: env.RAFT_DESKTOP_RELEASES_BASE_URL };
  return { layout: "generic", base: env.RAFT_DESKTOP_FEED_BASE_URL || HANDS_FEED_BASE };
}

const SOURCE = desktopFeedSourceFromEnv(process.env);

const baseOf = (source: DesktopFeedSource) => source.base.replace(/\/+$/, "");

function feedUrl(source: DesktopFeedSource, feed: Feed): string {
  return source.layout === "github" ? `${baseOf(source)}/latest/download/${feed}` : `${baseOf(source)}/${feed}`;
}

function assetUrl(source: DesktopFeedSource, version: string, file: string): string {
  const name = encodeURIComponent(file);
  return source.layout === "github" ? `${baseOf(source)}/download/v${version}/${name}` : `${baseOf(source)}/${name}`;
}

/**
 * Where a click goes when there is no installer to hand out. GitHub layout:
 * its Latest release page either way. Generic feed: no build for the platform
 * is the `/download` chooser (honest: it shows what exists); the feed host
 * failing is the GitHub Latest release page, where the same builds are.
 */
export function desktopDownloadFallbackUrl(
  outcome: "no_build" | "upstream_error",
  source: DesktopFeedSource = SOURCE,
): string {
  if (source.layout === "github") return `${baseOf(source)}/latest`;
  return outcome === "upstream_error" ? `${GITHUB_RELEASES_BASE}/latest` : mobileDownloadChooserUrl();
}

type Feed = "latest-mac.yml" | "latest-linux.yml" | "latest.yml";

/**
 * Which feed lists the target, and which listed file it is.
 *
 * `mac` prefers a universal build and falls back to Apple silicon: universal
 * installs on every Mac, and Apple silicon is what a Mac without a universal
 * build most likely is. The Intel build stays reachable as `mac-x64`.
 */
const TARGETS = {
  mac: { feed: "latest-mac.yml", files: [/-universal\.dmg$/, /-arm64\.dmg$/] },
  "mac-arm64": { feed: "latest-mac.yml", files: [/-universal\.dmg$/, /-arm64\.dmg$/] },
  "mac-x64": { feed: "latest-mac.yml", files: [/-universal\.dmg$/, /-x64\.dmg$/] },
  "linux-appimage": { feed: "latest-linux.yml", files: [/-x86_64\.AppImage$/] },
  "linux-deb": { feed: "latest-linux.yml", files: [/-amd64\.deb$/] },
  windows: { feed: "latest.yml", files: [/-x64\.exe$/, /\.exe$/] },
} as const satisfies Record<string, { feed: Feed; files: readonly RegExp[] }>;

export type DesktopTarget = keyof typeof TARGETS;

export function isDesktopTarget(value: unknown): value is DesktopTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TARGETS, value);
}

/**
 * `version` and the `files[].url` entries of an electron-builder update feed.
 *
 * The feed is a fixed, flat shape that electron-builder writes, so this reads
 * just those two keys rather than pulling a YAML parser into the server.
 * Anything it does not recognise is ignored; a feed without a version reads as
 * no feed at all.
 */
export function parseUpdateFeed(text: string): { version: string; files: string[] } | null {
  const version = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
  // The version becomes a path segment of the redirect (`/download/v<version>/`),
  // in the GitHub layout, so it must be a plain semver: a `../` or `?` here
  // would point the redirect at another path of that host. Whoever can publish
  // a release is trusted, but the redirect target should not depend on that.
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  const files = [...text.matchAll(/^\s*-\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  return { version, files };
}

type FeedRead =
  | { outcome: "feed"; version: string; files: string[] }
  | { outcome: "no_feed" }
  | { outcome: "upstream_error"; detail: string };

type Deps = {
  fetch: typeof fetch;
  /** Defaults to the env-configured source (Hands unless overridden). */
  source?: DesktopFeedSource;
  /** Shared by the router; tests pass none so each starts cold. */
  cache?: Map<string, { at: number; read: FeedRead }>;
  now?: () => number;
};

/** How long a feed read is reused. A new Latest release reaches people within a minute. */
const FEED_TTL_MS = 60_000;
/**
 * A failure is reused briefly too: while the feed host is down, every About
 * page open would otherwise make the server wait out the timeout three times over.
 */
const FEED_ERROR_TTL_MS = 10_000;
/** The feed host normally answers in well under a second; never hold a download click for minutes. */
const FEED_TIMEOUT_MS = 10_000;

async function readFeed(feed: Feed, deps: Deps): Promise<FeedRead> {
  const url = feedUrl(deps.source ?? SOURCE, feed);
  const key = url;
  const now = (deps.now ?? Date.now)();
  const hit = deps.cache?.get(key);
  if (hit && now - hit.at < (hit.read.outcome === "upstream_error" ? FEED_ERROR_TTL_MS : FEED_TTL_MS)) return hit.read;
  const read = await fetchFeed(url, feed, deps.fetch);
  deps.cache?.set(key, { at: now, read });
  return read;
}

async function fetchFeed(url: string, feed: Feed, fetchImpl: typeof fetch): Promise<FeedRead> {
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    // No such feed on the current release: that platform has not shipped
    // (Windows before its first release). A legal state, not a fault.
    if (response.status === 404) return { outcome: "no_feed" };
    if (!response.ok) return { outcome: "upstream_error", detail: `HTTP ${response.status}` };
    const parsed = parseUpdateFeed(await response.text());
    if (!parsed) return { outcome: "upstream_error", detail: `${feed} has no valid version` };
    return { outcome: "feed", ...parsed };
  } catch (cause) {
    return { outcome: "upstream_error", detail: `request failed: ${String(cause)}` };
  }
}

/**
 * A listed file the redirect may name: a bare file name. Feed `url`s resolve
 * against the feed folder, and in the flat layout the name is the whole path
 * under the base, so a `/`, `\`, `?`, `#` or `..` would point the redirect
 * somewhere else on the host. Such an entry is skipped, never followed.
 */
function isPlainFileName(file: string): boolean {
  return !/[/\\?#]/.test(file) && !file.includes("..");
}

function pick(files: string[], patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const name = files.find((file) => pattern.test(file) && isPlainFileName(file));
    if (name) return name;
  }
  return null;
}

export type DesktopLookup =
  | { outcome: "asset"; url: string; version: string }
  | { outcome: "no_build" }
  | { outcome: "upstream_error"; detail: string };

export async function lookupDesktopAsset(target: DesktopTarget, deps: Deps): Promise<DesktopLookup> {
  const { feed, files } = TARGETS[target];
  const read = await readFeed(feed, deps);
  if (read.outcome === "no_feed") return { outcome: "no_build" };
  if (read.outcome === "upstream_error") return read;
  const name = pick(read.files, files);
  return name
    ? { outcome: "asset", url: assetUrl(deps.source ?? SOURCE, read.version, name), version: read.version }
    : { outcome: "no_build" };
}

export type PlatformStatus = { status: "available"; version: string } | { status: "none" } | { status: "unknown" };
export type DesktopPlatforms = {
  mac: PlatformStatus & { universal?: boolean };
  linux: PlatformStatus;
  windows: PlatformStatus;
};

/**
 * What the current release offers, for the web to render from — so shipping a
 * platform (the first Windows build, a universal Mac build) is a release, not a
 * web code edit. `unknown` means the feed host did not answer; the web then falls back
 * to its defaults rather than hiding a platform that probably exists.
 */
export async function lookupDesktopPlatforms(deps: Deps): Promise<DesktopPlatforms> {
  const status = (read: FeedRead, installers: readonly RegExp[]): PlatformStatus => {
    if (read.outcome === "upstream_error") return { status: "unknown" };
    if (read.outcome === "no_feed" || !pick(read.files, installers)) return { status: "none" };
    return { status: "available", version: read.version };
  };
  const [mac, linux, windows] = await Promise.all([
    readFeed("latest-mac.yml", deps),
    readFeed("latest-linux.yml", deps),
    readFeed("latest.yml", deps),
  ]);
  const macStatus = status(mac, TARGETS.mac.files);
  return {
    mac: macStatus.status === "available" && mac.outcome === "feed"
      ? { ...macStatus, universal: pick(mac.files, [/-universal\.dmg$/]) !== null }
      : macStatus,
    linux: status(linux, TARGETS["linux-appimage"].files),
    windows: status(windows, TARGETS.windows.files),
  };
}

const feedCache = new Map<string, { at: number; read: FeedRead }>();

/** Tests only: the router's feed cache otherwise carries reads between tests. */
export function resetDesktopDownloadCacheForTest(): void {
  feedCache.clear();
}

export const desktopDownloadRouter: Router = Router();

desktopDownloadRouter.get("/platforms", async (_req, res) => {
  const platforms = await lookupDesktopPlatforms({ fetch, cache: feedCache });
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(platforms);
});

desktopDownloadRouter.get("/", async (req, res) => {
  const target = req.query.target;
  if (!isDesktopTarget(target)) {
    res.setHeader("Cache-Control", "private, max-age=300");
    res.redirect(302, mobileDownloadChooserUrl());
    return;
  }
  const result = await lookupDesktopAsset(target, { fetch, cache: feedCache });
  if (result.outcome === "asset") {
    // Short: a new release should reach people within minutes.
    res.setHeader("Cache-Control", "private, max-age=300");
    res.redirect(302, result.url);
    return;
  }
  // The links are downloads opened in the same tab, so a JSON error body would
  // be a dead page. Hand the person a page instead (desktopDownloadFallbackUrl).
  if (result.outcome === "upstream_error") {
    console.error("[desktop-download] upstream error", { target, detail: result.detail });
  }
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, desktopDownloadFallbackUrl(result.outcome));
});
