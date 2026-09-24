import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { useServerStore } from "../store/serverStore";
import { buildSidebarChannelFocusState } from "../components/layout/sidebarChannelFocus";

export type NavigationKindForDepth = "PUSH" | "POP" | "REPLACE";

// `location.key !== "default"` was the previous heuristic for "is there
// browser history to pop?" and it's unreliable: the very first
// navigate({replace:true}) after a cold-start fallback flips the key away
// from "default" while the browser history stack is still empty, so the
// next back press would silently do nothing.
export function nextNavigationDepth(
  depth: number,
  navigationType: NavigationKindForDepth,
): number {
  if (navigationType === "PUSH") return depth + 1;
  if (navigationType === "POP") return Math.max(0, depth - 1);
  return depth;
}

export function nextNavigationStack(
  stack: readonly string[],
  navigationType: NavigationKindForDepth,
  locationPath: string,
): string[] {
  if (navigationType === "PUSH") return [...stack, locationPath];
  const nextStack = stack.slice(0, -1);
  if (navigationType === "POP" && nextStack.at(-1) === locationPath) {
    return [...nextStack];
  }
  return [...nextStack, locationPath];
}

export type MobileBackAction =
  | { kind: "back" }
  | { kind: "fallback"; path: string };

export function resolveMobileBackAction(
  stackOrDepth: readonly string[] | number,
  fallbackPath: string,
  scopePath = fallbackPath,
): MobileBackAction {
  if (typeof stackOrDepth === "number") {
    if (stackOrDepth > 0) return { kind: "back" };
    return { kind: "fallback", path: fallbackPath };
  }
  const stack = stackOrDepth;
  const previousPath = stack.at(-2);
  if (previousPath && canUseBrowserBack(previousPath, scopePath)) {
    return { kind: "back" };
  }
  return { kind: "fallback", path: fallbackPath };
}

function serverSlugFromPath(path: string): string | null {
  const match = path.match(/^\/s\/([^/?#]+)/);
  return match?.[1] ?? null;
}

export function canUseBrowserBack(
  previousPath: string,
  fallbackPath: string,
): boolean {
  const fallbackServerSlug = serverSlugFromPath(fallbackPath);
  if (!fallbackServerSlug) return true;
  return serverSlugFromPath(previousPath) === fallbackServerSlug;
}

function locationPath(location: Pick<Location, "pathname" | "search" | "hash">): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function fallbackScopePath(
  fallback: string | (() => void),
  serverSlug: string | undefined,
  location: Pick<Location, "pathname" | "search" | "hash">,
): string {
  const currentPath = locationPath(location);
  const fallbackPath = typeof fallback === "string" ? fallback : null;
  if (fallbackPath && serverSlugFromPath(fallbackPath)) return fallbackPath;
  if (serverSlugFromPath(currentPath)) return currentPath;
  if (fallbackPath) return fallbackPath;
  if (serverSlug) return `/s/${serverSlug}`;
  return currentPath;
}

function syncMobileBackNavigationState(
  navigationType: NavigationKindForDepth,
  path: string,
) {
  inAppPushDepth = nextNavigationDepth(inAppPushDepth, navigationType);
  inAppNavigationStack = nextNavigationStack(
    inAppNavigationStack,
    navigationType,
    path,
  );
}

function initializeMobileBackNavigationState(path: string) {
  inAppPushDepth = 0;
  inAppNavigationStack = [path];
  trackedBrowserHistoryIndex = readBrowserHistoryIndex();
  pendingSynchronousNavigation = null;
}

function readBrowserHistoryIndex(): number | null {
  if (typeof window === "undefined" || !window.history) return null;
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" ? index : null;
}

// Stryker disable next-line ArrayDeclaration: NavigationDepthTracker overwrites the module default on app mount before mobile-back reads it.
let inAppNavigationStack: string[] = [];
let inAppPushDepth = 0;
let trackedBrowserHistoryIndex: number | null = null;
export interface SynchronousNavigationRecord {
  navigationType: Exclude<NavigationKindForDepth, "POP">;
  historyIndex: number | null;
  path: string;
}

let pendingSynchronousNavigation: SynchronousNavigationRecord | null = null;
let synchronousNavigationVersion = 0;
const synchronousNavigationListeners = new Set<() => void>();

function subscribeSynchronousNavigation(listener: () => void): () => void {
  synchronousNavigationListeners.add(listener);
  const onPopState = () => listener();
  window.addEventListener("popstate", onPopState);
  return () => {
    synchronousNavigationListeners.delete(listener);
    window.removeEventListener("popstate", onPopState);
  };
}

function getSynchronousNavigationSnapshot(): string {
  const index = readBrowserHistoryIndex();
  const state = typeof window === "undefined"
    ? null
    : window.history.state as { key?: unknown } | null;
  const key = typeof state?.key === "string" ? state.key : "";
  return `${synchronousNavigationVersion}:${index ?? "null"}:${key}`;
}

export function shouldConsumeSynchronousNavigation(
  pending: SynchronousNavigationRecord | null,
  committed: {
    navigationType: NavigationKindForDepth;
    historyIndex: number | null;
    path: string;
  },
): boolean {
  return pending?.path === committed.path
    && pending.navigationType === committed.navigationType
    && (pending.historyIndex === null || pending.historyIndex === committed.historyIndex);
}

export function isIdempotentNavigationCommit(
  previousKey: string,
  currentKey: string,
  trackedHistoryIndex: number | null,
  browserHistoryIndex: number | null,
): boolean {
  if (currentKey !== previousKey) return false;
  // A fast store-owned PUSH → close REPLACE → POP can return to the original
  // entry before Router ever commits either destination. The final location
  // therefore has the same key as the last committed location, but the
  // browser idx has moved back. Treating key equality alone as an idempotency
  // signal skips that real POP and leaves a false module-stack depth behind.
  if (trackedHistoryIndex !== null && browserHistoryIndex !== null) {
    return trackedHistoryIndex === browserHistoryIndex;
  }
  return true;
}

/**
 * Record a route-owner navigation in the same synchronous turn that writes
 * browser history. Store-owned overlays can render their Back control before
 * React Router commits the destination location, so the post-commit tracker
 * alone cannot observe that PUSH in time. The destination tracker consumes
 * this record instead of applying the same navigation twice.
 */
export function recordSynchronousMobileBackNavigation(
  navigationType: Exclude<NavigationKindForDepth, "POP">,
  path: string,
): void {
  if (inAppNavigationStack.length === 0 && typeof window !== "undefined") {
    initializeMobileBackNavigationState(locationPath(window.location));
  }
  syncMobileBackNavigationState(navigationType, path);
  trackedBrowserHistoryIndex = readBrowserHistoryIndex();
  pendingSynchronousNavigation = {
    navigationType,
    historyIndex: trackedBrowserHistoryIndex,
    path,
  };
  synchronousNavigationVersion += 1;
  for (const listener of synchronousNavigationListeners) listener();
}

/**
 * Mount once inside <BrowserRouter> to maintain `inAppPushDepth`. Renders
 * nothing.
 */
export function NavigationDepthTracker() {
  const navigationType = useNavigationType();
  const { hash, key, pathname, search } = useLocation();
  const prevKeyRef = useRef<string | null>(null);
  // A PUSH → close REPLACE → POP can return to the exact location/key before
  // Router commits either intermediate entry. Its location dependencies are
  // then identical to the previous render; this subscribed history snapshot
  // makes both the skipped synchronous write and its POP observable.
  const synchronousNavigationSnapshotAtRender = useSyncExternalStore(
    subscribeSynchronousNavigation,
    getSynchronousNavigationSnapshot,
    getSynchronousNavigationSnapshot,
  );
  // Back controls become interactive in this same commit. Record the new
  // history entry before paint so a fast click cannot read the previous
  // passive-effect snapshot and replace the current entry with its fallback.
  useLayoutEffect(() => {
    const path = locationPath({ pathname, search, hash });
    if (prevKeyRef.current === null) {
      prevKeyRef.current = key;
      initializeMobileBackNavigationState(path);
      return;
    }
    const browserHistoryIndex = readBrowserHistoryIndex();
    // A same-key render is idempotent only while browser history stayed on the
    // same entry. When idx changed, Router skipped an intermediate commit and
    // this layout effect is the only observation of the real PUSH/POP.
    if (isIdempotentNavigationCommit(
      prevKeyRef.current,
      key,
      trackedBrowserHistoryIndex,
      browserHistoryIndex,
    )) return;
    prevKeyRef.current = key;
    let committedNavigationType = navigationType as NavigationKindForDepth;
    if (browserHistoryIndex !== null && trackedBrowserHistoryIndex !== null) {
      if (browserHistoryIndex < trackedBrowserHistoryIndex) committedNavigationType = "POP";
      else if (browserHistoryIndex > trackedBrowserHistoryIndex) committedNavigationType = "PUSH";
    }
    if (shouldConsumeSynchronousNavigation(pendingSynchronousNavigation, {
      navigationType: committedNavigationType,
      historyIndex: browserHistoryIndex,
      path,
    })) {
      trackedBrowserHistoryIndex = browserHistoryIndex;
      pendingSynchronousNavigation = null;
      return;
    }
    trackedBrowserHistoryIndex = browserHistoryIndex;
    pendingSynchronousNavigation = null;
    syncMobileBackNavigationState(
      committedNavigationType,
      path,
    );
  }, [hash, key, navigationType, pathname, search, synchronousNavigationSnapshotAtRender]);
  return null;
}

/**
 * Back-button navigation shared by mobile detail-panel back buttons and
 * anywhere else that needs a semantic "go back" action.
 *
 * Two-step rule (per @stdrc 2026-05-01 `#proj-uiux:c8711d2a`
 * msg=3e59ad5d, superseding the earlier 3-step contract from
 * msg=548eda5f / msg=49bf9068):
 *   1. Same-server browser history first — if the previous in-app entry is
 *      still in the caller's current `/s/<server>` scope, call
 *      `navigate(-1)`. Keeps back consistent with OS/browser back gestures
 *      without letting an in-app server switch make a detail-panel back
 *      button leave the current server.
 *   2. Explicit `fallback` — on cold-start (PWA launch, shared link,
 *      push-notification tap, bookmark) history is empty, so either
 *      navigate to the caller's semantic parent (string) or run the
 *      caller's custom close handler (function — used by overlay panels
 *      to close themselves rather than skip past their underlying
 *      surface).
 *
 * Why a callback variant exists: profile detail panels (Agent/Human) can
 * be rendered two ways — (a) standalone via `/agent/<id>` / `/human/<id>`
 * routes where the semantic parent is `/members`, or (b) as an OVERLAY on
 * top of an underlying surface via `?profile=<type>:<id>` driven by
 * `useProfileStore`. In case (b) the user's mental model of "back" is
 * "close this overlay and go back to the channel I was looking at", NOT
 * "jump to /members". Cold-starting a profile permalink (`/channel/X?profile=...`,
 * #proj-mobile:b1c622e5 stdrc 2026-05-08) hits the depth=0 branch with
 * no underlying push to pop, so the panel must surface its own close
 * action as the fallback. Passing `closeProfile` (the zustand setter) lets
 * the store→URL sync replace `?profile=` with the underlying pathname
 * cleanly, so the user lands on the channel rather than on `/members`.
 *
 * The per-tab view-stack (`useMobileNav.goBack`) used to sit between 1 and 2
 * as a reconstructed "you probably came from here" fallback. It was fragile
 * in cold-start + overlay (`?thread=`) scenarios: the hydrate+push effect
 * would push the post-back URL onto a stack that still contained the
 * pre-back URL, so the next back click popped INTO the URL we had just
 * left — notably the thread permalink we were trying to close. Repro:
 * msg=768680bf. CI log trace: msg=68fc6426. Since every caller already
 * passes a semantic `fallback` (ThreadPanel → parent channel, ChatPanel
 * → `/s/<slug>`, AgentDetail → `/members` or closeProfile, etc.), the
 * view-stack adds no correctness and only adds race conditions. The
 * view-stack still drives tab-switch memory and popToRoot in
 * `useMobileNav.selectTab`.
 */
export function useMobileBack(
  fallback: string | (() => void),
  beforeNavigate?: () => void,
) {
  const navigate = useNavigate();
  const { hash, pathname, search } = useLocation();
  const serverSlug = useServerStore((s) => s.current?.slug);
  return useCallback(() => {
    beforeNavigate?.();
    const scopePath = fallbackScopePath(
      fallback,
      serverSlug,
      { pathname, search, hash },
    );
    if (typeof fallback === "function") {
      const action = resolveMobileBackAction(
        inAppNavigationStack,
        scopePath,
        scopePath,
      );
      if (action.kind === "back") {
        navigate(-1);
        return;
      }
      fallback();
      return;
    }
    const action = resolveMobileBackAction(
      inAppNavigationStack,
      fallback,
      scopePath,
    );
    if (action.kind === "back") {
      navigate(-1);
      return;
    }
    navigate(action.path, { replace: true });
  }, [navigate, fallback, beforeNavigate, hash, pathname, search, serverSlug]);
}

// Legacy export kept for back-compat: still used by useRailLegacyRedirect to
// strip the ?sidebarTab= param off old URLs and by a few transitional tests.
// New code should not read or write ?sidebarTab= — rail mode lives in the
// path now (`/members`, `/computers`, `/computer/<id>`, etc.).
export const SIDEBAR_TAB_QUERY_PARAM = "sidebarTab";

export const CHAT_TAB_QUERY_PARAM = "chatTab";
export type ChatTabQueryValue = "chat" | "tasks" | "files";

interface NavOptions {
  /** Chat panel state appended as ?chatTab= for shareable URLs */
  chatTab?: ChatTabQueryValue;
  /** One-shot visual intent for Search → Chat channel navigation. */
  sidebarFocus?: "center";
}

interface ComputersNavOptions {
  /** Focus the Computers list on devices needing user attention. */
  filter?: "attention";
}

interface SearchNavOptions {
  /** Preselect a channel/DM filter on the Search page. */
  channelId?: string;
  /** Open the Search page with filters prefilled, but wait for a query before fetching. */
  deferUntilQuery?: boolean;
  /** Commit the route DOM in the same turn as the history write. */
  flushSync?: boolean;
}

export function buildSearchPath(
  base: string,
  query?: string,
  opts?: SearchNavOptions,
) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (opts?.channelId) params.set("channelId", opts.channelId);
  if (opts?.deferUntilQuery) params.set("defer", "1");
  const paramsText = params.toString();
  return paramsText ? `${base}/search?${paramsText}` : `${base}/search`;
}

export type MessagePermalinkRouteKind = "channel" | "dm";

interface MessagePermalinkOptions {
  routeKind?: MessagePermalinkRouteKind;
  threadParentMessageId?: string | null;
}

function buildMessagePath(
  base: string,
  channelId: string,
  messageId: string,
  { routeKind = "channel", threadParentMessageId = null }: MessagePermalinkOptions = {}
): string {
  const params = new URLSearchParams({ msg: messageId });
  if (threadParentMessageId) {
    params.set("thread", `${channelId}:${threadParentMessageId}`);
  }
  return `${base}/${routeKind}/${channelId}?${params.toString()}`;
}

export function useAppNavigate() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const slug = useServerStore((s) => s.current?.slug);
  const base = slug ? `/s/${slug}` : "";
  // Memoized so the returned object has a STABLE identity across renders
  // (changes only when the server-slug-derived `base` changes).
  // react-router's `useNavigate()` can return a new function reference after
  // location changes; keep it behind a ref so route changes do not churn every
  // memoized row handler that depends on `nav`.
  // Consumers thread these methods into useCallback/useMemo deps and into
  // memoized children (e.g. MessageItem's markdown render); an unstable nav
  // object there breaks those memos and forces re-parse/re-render storms.
  return useMemo(() => {
    const withQuery = (path: string, opts?: NavOptions) => {
      const params = new URLSearchParams();
      if (opts?.chatTab && opts.chatTab !== "chat") params.set(CHAT_TAB_QUERY_PARAM, opts.chatTab);
      const query = params.toString();
      return query ? `${path}?${query}` : path;
    };
    return {
    toChannel: (channelId: string, opts?: NavOptions) => navigateRef.current(
      withQuery(`${base}/channel/${channelId}`, opts),
      opts?.sidebarFocus
        ? { state: buildSidebarChannelFocusState(channelId) }
        : undefined,
    ),
    toDm: (dmChannelId: string, opts?: NavOptions) => navigateRef.current(withQuery(`${base}/dm/${dmChannelId}`, opts)),
    toMessage: (channelId: string, messageId: string, opts?: NavOptions) => navigateRef.current(
      buildMessagePath(base, channelId, messageId),
      opts?.sidebarFocus
        ? { state: buildSidebarChannelFocusState(channelId) }
        : undefined,
    ),
    toDmMessage: (dmChannelId: string, messageId: string) => navigateRef.current(buildMessagePath(base, dmChannelId, messageId, { routeKind: "dm" })),
    toThreadMessage: (
      channelId: string,
      parentMessageId: string,
      messageId: string,
      routeKind: MessagePermalinkRouteKind = "channel",
      opts?: NavOptions,
    ) => navigateRef.current(
      buildMessagePath(base, channelId, messageId, { routeKind, threadParentMessageId: parentMessageId }),
      opts?.sidebarFocus
        ? { state: buildSidebarChannelFocusState(channelId) }
        : undefined,
    ),
    toAgent: (agentId: string) => navigateRef.current(`${base}/agent/${agentId}`),
    toComputer: (machineId: string) => navigateRef.current(`${base}/computer/${machineId}`),
    /** @deprecated use toComputer */
    toMachine: (machineId: string) => navigateRef.current(`${base}/computer/${machineId}`),
    toHuman: (userId: string) => navigateRef.current(`${base}/human/${userId}`),
    toMembers: () => navigateRef.current(`${base}/members`),
    toComputers: (opts?: ComputersNavOptions) =>
      navigateRef.current(
        opts?.filter ? `${base}/computers?filter=${opts.filter}` : `${base}/computers`,
      ),
    toSearch: (query?: string, opts?: SearchNavOptions) => navigateRef.current(
      buildSearchPath(base, query, opts),
      opts?.flushSync ? { flushSync: true } : undefined,
    ),
    toSettings: (tab?: string) => navigateRef.current(tab ? `${base}/settings/${tab}` : `${base}/settings`),
    toReleaseNotes: () => navigateRef.current(`${base}/release-notes`),
    toThreadsInbox: () => navigateRef.current(`${base}/activity`),
    toTasks: () => navigateRef.current(`${base}/tasks`),
    toSaved: () => navigateRef.current(`${base}/saved`),
    toWiki: () => navigateRef.current(`${base}/wiki`),
    };
  }, [base]);
}

/** Build a shareable permalink URL for a message. */
export function buildMessagePermalink(
  serverSlug: string,
  channelId: string,
  messageId: string,
  options: MessagePermalinkOptions = {}
): string {
  return `${window.location.origin}${buildMessagePath(`/s/${serverSlug}`, channelId, messageId, options)}`;
}
