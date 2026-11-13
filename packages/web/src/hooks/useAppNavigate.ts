import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import type { NavigateOptions } from "react-router-dom";
import { searchEntryState } from "../features/search/searchOverlayLocation";
import { useMessageStore } from "../store/messageStore";
import { useServerStore } from "../store/serverStore";
import { useLiveLocation } from "./useLiveLocation";
import { buildSidebarChannelFocusState } from "../components/layout/sidebarChannelFocus";
import { requestChannelNavigation } from "../navigation/channelSwitchGuard";
import { prefetchConversationForPath } from "../navigation/conversationPrefetch";
import { beginViewSwitchToPath } from "../observability/viewSwitchSpan";
import { shareableWebOrigin } from "../utils/desktopShell";
import { formatTaskConversationParam } from "../utils/taskConversation";
import { currentComputerPath } from "../utils/computerPanel";
import { buildMessagePath } from "../utils/messagePath";
import type { MessagePermalinkOptions, MessagePermalinkRouteKind } from "../utils/messagePath";

export { buildMessagePath };
export type { MessagePermalinkOptions, MessagePermalinkRouteKind };

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

// Compressed stack (one entry per commit). Only used when the browser entry
// index is unavailable (MemoryRouter, non-browser): it cannot represent a
// history.go(±n) that travels several entries in one popstate.
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

/**
 * Index-keyed history records (the browser path). react-router stamps each
 * entry's index on history.state.idx, so a commit can be recorded AT its real
 * position: a POP or Forward that travels n entries in one popstate lands on
 * index i and records i; the entries behind it stay exactly what was observed
 * there. A PUSH discards every record at or after its index (they are gone
 * from the browser too). Entries never observed in this document (before a
 * reload, before the app mounted) are UNKNOWN — a back decision treats them
 * like "no in-app history", the same conservative answer a cold start gives.
 */
export const UNKNOWN_NAVIGATION_ENTRY = "\u0000unknown-history-entry";
export type NavigationEntries = Readonly<Record<number, string>>;

export function nextNavigationEntries(
  entries: NavigationEntries,
  navigationType: NavigationKindForDepth,
  index: number,
  locationPath: string,
): Record<number, string> {
  const next: Record<number, string> = {};
  for (const [key, path] of Object.entries(entries)) {
    const at = Number(key);
    if (navigationType === "PUSH" && at >= index) continue;
    next[at] = path;
  }
  next[index] = locationPath;
  return next;
}

/** The path sequence 0..index for the mobile-back decision; gaps are UNKNOWN. */
export function navigationStackFromEntries(entries: NavigationEntries, index: number): string[] {
  const stack: string[] = [];
  for (let at = 0; at <= index; at += 1) stack.push(entries[at] ?? UNKNOWN_NAVIGATION_ENTRY);
  return stack;
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
  if (previousPath && previousPath !== UNKNOWN_NAVIGATION_ENTRY && canUseBrowserBack(previousPath, scopePath)) {
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
  browserHistoryIndex: number | null,
) {
  inAppPushDepth = nextNavigationDepth(inAppPushDepth, navigationType);
  if (browserHistoryIndex === null) {
    // No entry index (MemoryRouter / non-browser): compressed stack.
    inAppNavigationStack = nextNavigationStack(inAppNavigationStack, navigationType, path);
    navigationStackChanged();
    return;
  }
  inAppNavigationEntries = nextNavigationEntries(inAppNavigationEntries, navigationType, browserHistoryIndex, path);
  inAppNavigationStack = navigationStackFromEntries(inAppNavigationEntries, browserHistoryIndex);
  navigationStackChanged();
}

function initializeMobileBackNavigationState(path: string) {
  inAppPushDepth = 0;
  inAppNavigationStack = [path];
  trackedBrowserHistoryIndex = readBrowserHistoryIndex();
  inAppNavigationEntries = trackedBrowserHistoryIndex === null ? {} : { [trackedBrowserHistoryIndex]: path };
  pendingSynchronousNavigation = null;
  navigationStackChanged();
}

function readBrowserHistoryIndex(): number | null {
  if (typeof window === "undefined" || !window.history) return null;
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" ? index : null;
}

// Stryker disable next-line ArrayDeclaration: NavigationDepthTracker overwrites the module default on app mount before mobile-back reads it.
let inAppNavigationStack: string[] = [];
let inAppNavigationEntries: Record<number, string> = {};
let inAppPushDepth = 0;
let trackedBrowserHistoryIndex: number | null = null;
/** Who reads the stack while rendering (useHasInAppPageBehind): told each time it changes. */
const navigationStackListeners = new Set<() => void>();
function navigationStackChanged(): void {
  for (const listener of navigationStackListeners) listener();
}
function subscribeNavigationStack(listener: () => void): () => void {
  navigationStackListeners.add(listener);
  return () => {
    navigationStackListeners.delete(listener);
  };
}
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
  // Callers record AFTER BrowserRouter wrote history (synchronously), so the
  // entry index already points at the destination.
  syncMobileBackNavigationState(navigationType, path, readBrowserHistoryIndex());
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
    // For the index-keyed records a Forward traversal (router POP, index up)
    // must NOT be recorded as a PUSH: it lands on an existing entry and
    // discards nothing. Only a real push (router PUSH) truncates.
    const recordNavigationType: NavigationKindForDepth =
      committedNavigationType === "PUSH" && navigationType === "POP" ? "POP" : committedNavigationType;
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
      browserHistoryIndex === null ? committedNavigationType : recordNavigationType,
      path,
      browserHistoryIndex,
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
 * view-stack added no correctness and only race conditions; it is gone
 * (the phone tab bar keeps only each tab root's filters, `useMobileNav`).
 */
/**
 * Whether the history entry before this one is a page of the app this
 * document has shown, so `navigate(-1)` stays in the app: false for a link
 * opened from outside (a new tab, another app) or after a reload, whose
 * earlier entries are unknown.
 */
export function hasInAppPageBehind(stack: readonly string[] = inAppNavigationStack): boolean {
  const previous = stack.at(-2);
  return previous !== undefined && previous !== UNKNOWN_NAVIGATION_ENTRY;
}

/**
 * The pages this document has shown up to the current entry, oldest first
 * (UNKNOWN_NAVIGATION_ENTRY where an entry was never seen), read while
 * rendering: the page renders again once NavigationDepthTracker records an
 * entry. The assistant page looks for the conversation behind it.
 */
export function useInAppNavigationStack(): readonly string[] {
  return useSyncExternalStore(subscribeNavigationStack, () => inAppNavigationStack, () => inAppNavigationStack);
}

/** hasInAppPageBehind, read while rendering: the page renders again once NavigationDepthTracker records its entry. */
export function useHasInAppPageBehind(): boolean {
  return useSyncExternalStore(subscribeNavigationStack, () => hasInAppPageBehind(), () => false);
}

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

/** A message link's options (toMessage, toDmMessage, toThreadMessage). */
interface MessageNavOptions {
  /** One-shot visual intent for Search → Chat channel navigation. */
  sidebarFocus?: "center";
  /** In place of the current history entry (a phone page that the message takes the place of). */
  replace?: boolean;
  /**
   * Runs once the navigation has happened: at once, or after the unsaved
   * channel-settings prompt lets it go (never, if that prompt keeps the page).
   */
  onNavigated?: () => void;
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

/** A message link's navigate options: the sidebar focus intent, and replacing the current entry. */
function messageNavigateOptions(channelId: string, opts: MessageNavOptions | undefined): NavigateOptions | undefined {
  if (!opts?.sidebarFocus && !opts?.replace) return undefined;
  return {
    ...(opts.sidebarFocus ? { state: buildSidebarChannelFocusState(channelId) } : {}),
    ...(opts.replace ? { replace: true } : {}),
  };
}

export function useAppNavigate() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // The page at event time for search entries (useLiveLocation), behind a ref
  // like navigate so the returned callbacks depend on the server base only.
  const liveLocationRef = useRef(useLiveLocation());
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
    // task #156: every nav.* call funnels through here. A dirty channel-
    // settings draft cannot survive a navigation (the sheet's form remounts
    // on the new channel id), so string destinations go through the sheet's
    // unsaved-changes prompt first — same deferred-action mechanism the
    // search overlay guard uses. Non-string calls (delta navigations) bypass.
    const guardedNavigate = (
      path: string,
      options?: NavigateOptions & { flushSync?: boolean },
      onNavigated?: () => void,
    ) => requestChannelNavigation(path, () => {
      // A conversation, message or thread path starts `web.view.switch` at the click.
      beginViewSwitchToPath(path);
      // Its first messages' read goes out now, while the view renders (counted for the switch).
      prefetchConversationForPath(path, liveLocationRef.current().pathname);
      navigateRef.current(path, options);
      onNavigated?.();
    });
    // A message link to the page already showing it (its `msg=` is the page's):
    // the URL won't change, so nothing would re-run; jump to it again in
    // place, as the first click did (#triage:#157).
    const toMessagePath = (path: string, channelId: string, messageId: string, opts?: MessageNavOptions) => {
      const here = liveLocationRef.current();
      if (`${here.pathname}${here.search}` !== path) return guardedNavigate(path, messageNavigateOptions(channelId, opts), opts?.onNavigated);
      beginViewSwitchToPath(path);
      void useMessageStore.getState().loadMessageContext(channelId, messageId);
      opts?.onNavigated?.();
    };
    return {
    toChannel: (channelId: string, opts?: NavOptions) => guardedNavigate(
      withQuery(`${base}/channel/${channelId}`, opts),
      opts?.sidebarFocus
        ? { state: buildSidebarChannelFocusState(channelId) }
        : undefined,
    ),
    toDm: (dmChannelId: string, opts?: NavOptions) => guardedNavigate(
      withQuery(`${base}/dm/${dmChannelId}`, opts),
      opts?.sidebarFocus
        ? { state: buildSidebarChannelFocusState(dmChannelId, "dm") }
        : undefined,
    ),
    toMessage: (channelId: string, messageId: string, opts?: MessageNavOptions) => toMessagePath(
      buildMessagePath(base, channelId, messageId), channelId, messageId, opts,
    ),
    toDmMessage: (dmChannelId: string, messageId: string, opts?: Omit<MessageNavOptions, "sidebarFocus">) => toMessagePath(
      buildMessagePath(base, dmChannelId, messageId, { routeKind: "dm" }), dmChannelId, messageId, opts,
    ),
    toThreadMessage: (
      channelId: string,
      parentMessageId: string,
      messageId: string,
      routeKind: MessagePermalinkRouteKind = "channel",
      opts?: MessageNavOptions,
    ) => guardedNavigate(
      buildMessagePath(base, channelId, messageId, { routeKind, threadParentMessageId: parentMessageId }),
      messageNavigateOptions(channelId, opts),
      opts?.onNavigated,
    ),
    /**
     * A task's own conversation (task v2), opened over the channel the task
     * lives in: the `task=<channel>:task:<taskId>` slot rightPanelUrlSync
     * projects into the task dialog. `onNavigated` runs once the route has
     * moved, so a caller can focus a message in the conversation it opened.
     */
    toTaskConversation: (
      parentChannelId: string,
      taskId: string,
      routeKind: MessagePermalinkRouteKind = "channel",
      onNavigated?: () => void,
    ) => guardedNavigate(
      `${base}/${routeKind}/${parentChannelId}?${new URLSearchParams({ task: formatTaskConversationParam(parentChannelId, taskId) }).toString()}`,
      undefined,
      onNavigated,
    ),
    toAgent: (agentId: string) => guardedNavigate(`${base}/agent/${agentId}`),
    toAgentWorkspace: (agentId: string) => guardedNavigate(`${base}/agent/${agentId}?agentTab=workspace`),
    /** A computer: its side panel beside the card wall, or its own page (computerPanel.ts). */
    toComputer: (machineId: string) => guardedNavigate(currentComputerPath(base, machineId)),
    /** @deprecated use toComputer */
    toMachine: (machineId: string) => guardedNavigate(currentComputerPath(base, machineId)),
    toHuman: (userId: string) => guardedNavigate(`${base}/human/${userId}`),
    /** The server's migration log, optionally opened on one agent or computer. */
    toMigrationLog: (filter?: { agent?: string; computer?: string }) => guardedNavigate(
      `${base}/migrations${filter?.agent ? `?agent=${encodeURIComponent(filter.agent)}` : filter?.computer ? `?computer=${encodeURIComponent(filter.computer)}` : ""}`,
    ),
    toMembers: () => guardedNavigate(`${base}/members`),
    toComputers: (opts?: ComputersNavOptions) =>
      guardedNavigate(
        opts?.filter ? `${base}/computers?filter=${opts.filter}` : `${base}/computers`,
      ),
    /** The Apps page; `search` (with its `?`) carries a deep link such as `?permission_updates=1`. */
    toApps: (search = "") => guardedNavigate(`${base}/apps${search}`),
    // Desktop: every search entry floats as the ⌘K overlay over the current
    // view (task #96) — carry it as backgroundLocation. Web: full-page /search.
    toSearch: (query?: string, opts?: SearchNavOptions) => guardedNavigate(
      buildSearchPath(base, query, opts),
      {
        state: searchEntryState(liveLocationRef.current()),
        ...(opts?.flushSync ? { flushSync: true } : {}),
      },
    ),
    // A conversation's own search, a pushed page over it (phone; Raft DS ›
    // Navigation › Search on a phone).
    toConversationSearch: (kind: "channel" | "dm", conversationId: string) => guardedNavigate(`${base}/${kind}/${conversationId}/search`),
    toSettings: (tab?: string) => guardedNavigate(tab ? `${base}/settings/${tab}` : `${base}/settings`),
    toReleaseNotes: () => guardedNavigate(`${base}/release-notes`),
    toThreadsInbox: () => guardedNavigate(`${base}/activity`),
    toTasks: () => guardedNavigate(`${base}/tasks`),
    toSaved: () => guardedNavigate(`${base}/saved`),
    toDrafts: () => guardedNavigate(`${base}/drafts`),
    toArtifacts: () => guardedNavigate(`${base}/artifacts`),
    /** A page of the current server by its path under `/s/<slug>` ("/artifacts?artifact=…"): where an app's search hit opens. */
    toServerPath: (path: `/${string}`) => guardedNavigate(`${base}${path}`),
    };
  }, [base]);
}

/** Build a shareable permalink URL for a message.
 *
 * Uses shareableWebOrigin() rather than window.location.origin so that in the Electron
 * desktop shell (page origin `app://raft`) copied/shared permalinks are real, openable
 * web URLs. On Web this returns the page origin unchanged. (task #84) */
export function buildMessagePermalink(
  serverSlug: string,
  channelId: string,
  messageId: string,
  options: MessagePermalinkOptions = {}
): string {
  return `${shareableWebOrigin()}${buildMessagePath(`/s/${serverSlug}`, channelId, messageId, options)}`;
}
