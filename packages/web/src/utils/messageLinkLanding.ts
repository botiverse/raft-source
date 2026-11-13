/**
 * Deep links v1 (#proj-mobile, item d): a message link is
 * `/s/{slug}/channel|dm/{cid}?msg={mid}&thread={cid}:{pid}`, the form "Copy
 * Link" builds (useAppNavigate's buildMessagePath). This module says whether
 * the page is such a link, whether it is well formed, and whether this app
 * *landed* on it: opened from a link or a fresh load, or handed over by
 * raft:// in Raft Desktop. Only a landing gets the link-specific behaviour
 * (the shared "Message not found" state); a URL the app wrote for itself
 * while someone moves around (a side thread kept open over another channel,
 * a reload, Raft Desktop reopening the page after an update restart) keeps
 * behaving as it always has.
 *
 * A landing counts once: when the app moves on from it, it is spent, so
 * coming back to the same address later (Chat's remembered tab, History, the
 * sidebar) is an address the app wrote itself.
 *
 * The first load itself (which address, from where) is read by pageLanding.ts,
 * which also keeps it for the open-in-app offers: those are about any page a
 * native app can open, not only a message link.
 */
import { capturePageLanding, desktopResumedLocation, isReferrerOutside, readFirstLoad, resetPageLandingForTests } from "./pageLanding";

export interface MessageLinkTarget {
  serverSlug: string;
  routeKind: "channel" | "dm";
  channelId: string;
  messageId: string | null;
  /** The raw `thread` value, `{cid}:{pid}`; null when absent. */
  thread: string | null;
  threadChannelId: string | null;
  threadParentMessageId: string | null;
}

const MESSAGE_LINK_PATH = /^\/s\/([^/]+)\/(channel|dm)\/([^/?#]+)\/?$/;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** The message link this location is, or null: a conversation path with `msg` and/or `thread`. */
export function parseMessageLink(pathname: string, search: string): MessageLinkTarget | null {
  const match = MESSAGE_LINK_PATH.exec(pathname);
  if (!match) return null;
  const params = new URLSearchParams(search);
  const messageId = params.get("msg") || null;
  const thread = params.get("thread") || null;
  if (!messageId && !thread) return null;
  const serverSlug = safeDecode(match[1]!);
  const channelId = safeDecode(match[3]!);
  if (!serverSlug || !channelId) return null;
  const separator = thread ? thread.indexOf(":") : -1;
  return {
    serverSlug,
    routeKind: match[2] as "channel" | "dm",
    channelId,
    messageId,
    thread,
    threadChannelId: separator > 0 ? thread!.slice(0, separator) : null,
    threadParentMessageId: separator > 0 ? thread!.slice(separator + 1) || null : null,
  };
}

/**
 * A `thread` that names another conversation than the path (or no parent at
 * all). The proposal rejects the whole link: never open some other channel's
 * thread beside this one.
 */
export function isThreadMismatch(target: MessageLinkTarget): boolean {
  if (!target.thread) return false;
  return target.threadChannelId !== target.channelId || !target.threadParentMessageId;
}

function landingKey(pathname: string, search: string): string | null {
  const target = parseMessageLink(pathname, search);
  if (!target) return null;
  // Not the raw search: the app may reorder or add panel params on the same link.
  return `${pathname}\u0000${target.messageId ?? ""}\u0000${target.thread ?? ""}`;
}

interface InitialLanding {
  key: string;
  /** Opened from outside: no referrer, or one from another origin. */
  fromOutside: boolean;
}

let initialLanding: InitialLanding | null = null;
let initialLandingCaptured = false;
const handedOverLandings = new Set<string>();
/** Landings the app has shown: spent once it is somewhere else. */
const shownLandings = new Set<string>();

/** Raft Desktop's first load after an update restart reopened this very page (resumeRouteArg.ts). */
function isDesktopResumedLoad(key: string): boolean {
  const resumed = desktopResumedLocation();
  return !!resumed && landingKey(resumed.pathname, resumed.search) === key;
}

/**
 * Called once at boot (main.tsx), before the router can touch the URL. A
 * reload, Back/Forward into the page or Raft Desktop reopening it after an
 * update restart is not a landing: the person is already here.
 */
export function captureMessageLinkLanding(): void {
  if (initialLandingCaptured || typeof window === "undefined") return;
  initialLandingCaptured = true;
  const first = readFirstLoad();
  // The same first load, kept for any page (the open-in-app offers).
  capturePageLanding(first);
  if (!first) return;
  const key = landingKey(first.pathname, first.search);
  if (!key) return;
  if (isDesktopResumedLoad(key)) return;
  initialLanding = { key, fromOutside: first.fromOutside };
}

/** Raft Desktop's raft:// hand-off (host/hostCommands.ts open-route) is a landing too. */
export function markMessageLinkHandOff(pathAndSearch: string): void {
  const queryAt = pathAndSearch.indexOf("?");
  const pathname = queryAt < 0 ? pathAndSearch : pathAndSearch.slice(0, queryAt);
  const search = queryAt < 0 ? "" : pathAndSearch.slice(queryAt);
  const key = landingKey(pathname, search);
  if (key) handedOverLandings.add(key);
}

/** This location is a message link the app landed on (not one it wrote itself). */
export function isMessageLinkLanding(pathname: string, search: string): boolean {
  const key = landingKey(pathname, search);
  if (!key) return false;
  return initialLanding?.key === key || handedOverLandings.has(key);
}

/**
 * The app is showing this location (MainLayout, on every location change). A
 * landing shown earlier that this location is not is spent: the app moved on
 * from it. Detours before the app first shows a landing (sign-in, joining a
 * public server) don't spend it.
 */
export function noteMessageLinkLocation(pathname: string, search: string): void {
  const key = landingKey(pathname, search);
  for (const shown of shownLandings) {
    if (shown === key) continue;
    shownLandings.delete(shown);
    handedOverLandings.delete(shown);
    if (initialLanding?.key === shown) initialLanding = null;
  }
  if (key && (initialLanding?.key === key || handedOverLandings.has(key))) shownLandings.add(key);
}

/**
 * The page's first load was this message link, opened from outside Raft. The
 * desktop banner's condition while it was for message links only; it now asks
 * pageLanding.ts, for any page.
 */
export function isMessageLinkLandingFromOutside(pathname: string, search: string): boolean {
  const key = landingKey(pathname, search);
  return !!key && initialLanding?.key === key && initialLanding.fromOutside;
}

export function resetMessageLinkLandingForTests(landing?: { pathname: string; search: string; referrer?: string; origin?: string }): void {
  initialLandingCaptured = false;
  initialLanding = null;
  handedOverLandings.clear();
  shownLandings.clear();
  // As at boot: the same first load is the page landing too.
  resetPageLandingForTests(landing);
  if (!landing) return;
  initialLandingCaptured = true;
  const key = landingKey(landing.pathname, landing.search);
  if (!key) return;
  initialLanding = { key, fromOutside: isReferrerOutside(landing.referrer ?? "", landing.origin ?? window.location.origin) };
}
