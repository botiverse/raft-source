// The one rule of where a link opens (#proj-workspace:#293). Every link
// activation asks routeLink, on both sides: Raft's own UI (the web renderer:
// a link in a message, a chip, a card, a description) and a page inside Raft
// Desktop's built-in browser (the main process: a click, target=_blank,
// window.open, a redirect). Pure: the callers find out what was clicked and
// carry the outcome out; nothing here opens anything.
//
// The table is the spec; linkRouter.test.ts walks all of it.
import { isRaftAppHostname } from "./raftPermalinks";

/**
 * What the address is:
 * - `web`: an http(s) page outside Raft, which the built-in browser may show;
 * - `web-credentials`: an http(s) address carrying a user or password, which
 *   it never shows;
 * - `raft`: a page on one of Raft's own hosts (the app, its API, the fixed
 *   Raft hosts): it opens in the app, never in a browser tab;
 * - `scheme`: mailto:, tel:, a custom protocol: another application's;
 * - `unsafe`: javascript:, data:, blob:, file:, about:, the app's own
 *   schemes, or not an address at all.
 */
export type LinkTarget = "web" | "web-credentials" | "raft" | "scheme" | "unsafe";

/**
 * What the person (or the page) asked for:
 * - `plain`: an ordinary activation;
 * - `new-tab`: Ctrl/Cmd-click, a middle click, "Open link in new tab";
 * - `new-window`: Shift-click, target=_blank, window.open;
 * - `beside` / `browser`: the menu's explicit choice.
 */
export type LinkIntent = "plain" | "new-tab" | "new-window" | "beside" | "browser";

/** Where the link is: Raft's own UI, or a page shown in a built-in browser tab. */
export type LinkOrigin = "shell" | "page";

/** Settings › Appearance › How web links open; null until it is chosen. */
export type LinkPreference = "beside" | "browser" | null;

export interface LinkRequest {
  target: LinkTarget;
  intent: LinkIntent;
  origin: LinkOrigin;
  preference: LinkPreference;
  /**
   * The built-in browser can take this link: Raft Desktop with its browser
   * on, and (from the shell) a conversation to open beside. False in a web
   * browser, with the flag off, and where no conversation hosts it.
   */
  browser: boolean;
}

export type LinkOutcome =
  /** Nothing of the router's: the link does what it did before (its own anchor, the platform's new tab, the shell's own-page and scheme handling). */
  | { kind: "default" }
  /** A tab of the built-in browser: the one it is in, a new one in front, or a new one behind. */
  | { kind: "browser-tab"; where: "current" | "new-foreground" | "new-background" }
  /** Hand it to the system browser. */
  | { kind: "system-browser" }
  /** The first-time question (Open links in Raft?), then again with the answer. */
  | { kind: "ask-first" }
  /** Refused where it was asked, and said so on the tab: a Raft page (it opens in the app) or another application's link. */
  | { kind: "refuse-visible"; reason: "raft" | "scheme" }
  /** Dropped: an address nothing may open. */
  | { kind: "drop" };

const DEFAULT: LinkOutcome = { kind: "default" };
const tab = (where: "current" | "new-foreground" | "new-background"): LinkOutcome => ({ kind: "browser-tab", where });

export function routeLink({ target, intent, origin, preference, browser }: LinkRequest): LinkOutcome {
  if (target === "unsafe") return { kind: "drop" };
  if (origin === "page") {
    // A page inside a browser tab: the person already chose the built-in browser, so the preference is not asked.
    if (target === "raft") return { kind: "refuse-visible", reason: "raft" };
    if (target === "scheme") return { kind: "refuse-visible", reason: "scheme" };
    if (target === "web-credentials") return { kind: "drop" };
    if (intent === "browser") return { kind: "system-browser" };
    if (!browser) return { kind: "system-browser" };
    if (intent === "plain") return tab("current");
    return tab(intent === "new-tab" ? "new-background" : "new-foreground");
  }
  // Raft's own UI. Its own pages, other applications' links and anything the browser can't take keep their own way.
  if (target !== "web") return DEFAULT;
  if (intent === "browser") return { kind: "system-browser" };
  if (!browser) return DEFAULT;
  if (intent === "beside") return tab("new-foreground");
  if (preference === "browser") return DEFAULT;
  if (intent === "new-tab") return tab("new-background");
  if (intent === "new-window") return tab("new-foreground");
  return preference === "beside" ? tab("new-foreground") : { kind: "ask-first" };
}

const UNSAFE_SCHEMES = new Set(["javascript", "data", "blob", "file", "about", "app", "raft", "chrome", "devtools", "view-source", "vbscript", "filesystem"]);

/** What `url` is (LinkTarget). `raftHostnames`: this deployment's own hosts, beside the fixed Raft hosts. */
export function classifyLinkTarget(url: unknown, raftHostnames: readonly string[] = []): LinkTarget {
  if (typeof url !== "string" || url.length === 0) return "unsafe";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unsafe";
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "http" || scheme === "https") {
    if (!parsed.hostname) return "unsafe";
    if (isRaftAppHostname(parsed.hostname, raftHostnames)) return "raft";
    return parsed.username || parsed.password ? "web-credentials" : "web";
  }
  return UNSAFE_SCHEMES.has(scheme) ? "unsafe" : "scheme";
}

/**
 * Whether `url` is Raft's own sign-in for another site (Login with Raft): the
 * API's OAuth authorize endpoint (also under a Server's own issuer,
 * `/oidc/<server>/api/oauth/authorize`) or the app's consent page it
 * redirects to (`/login-with-raft/...`, also under its older names
 * `/login-with-slock/...` and `/login-with-slock-human/...`). The path is read as the server's router reads it (Express:
 * letters in either case, one trailing slash or none), so another spelling
 * of the same endpoint is the same refusal; the Server segment is not
 * interpreted. This only names the refusal: what the desktop takes as a
 * sign-in request is its own, exact rule (webPreviewRaftSignInRules.ts
 * raftAuthorizeRequest).
 * A page in a browser tab reaches it by a navigation or a redirect, which the
 * built-in browser refuses like any Raft page; this is the one place that
 * tells that refusal apart, so the tab can say what happened, and so a later
 * change can complete the sign-in in the app instead (the hook that work
 * plugs into: keep the name).
 */
export function isRaftAuthorizeUrl(url: unknown, raftHostnames: readonly string[] = []): boolean {
  if (classifyLinkTarget(url, raftHostnames) !== "raft") return false;
  // One trailing slash is the same route; a second is not (Express answers 404).
  const pathname = new URL(url as string).pathname.replace(/(?<=[^/])\/$/, "").toLowerCase();
  if (/^\/oidc\/[^/]+\/api\/oauth\/authorize$/.test(pathname)) return true;
  if (pathname === "/api/oauth/authorize" || pathname === "/oauth/authorize") return true;
  // The consent page and its two older names (packages/web App.tsx routes all three to it).
  return /^\/login-with-(?:raft|slock|slock-human)(?:\/|$)/.test(pathname);
}
