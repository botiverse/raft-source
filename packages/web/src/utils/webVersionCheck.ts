import { create } from "zustand";
import { resolveWebRelease } from "./webAppVersion";
import { FRONTEND_RELEASE_IDENTITY } from "../buildIdentity";
import { canReloadWithoutLosingWork, prepareReload } from "./reloadSafety";
import { dropKeptShell } from "./serviceWorkerRecovery";
import { getOfflineBundleHost } from "./offlineBundleHost";
import { isHostShell } from "../embed";

// An open tab runs the release it loaded until it is reloaded. Each Web build
// publishes its release at /version.json (scripts/webVersionFile.ts, never
// cached: public/_headers); the tab compares it with its own now and then, and
// when they differ offers Reload: the Update button in the top bar
// (WebUpdateButton), or on a phone or a page without the bar the banner
// (NewWebVersionBanner). It also reloads itself at the first safe moment
// (#triage:1ce24cc5, Jasper): the tab hidden for 5 minutes, or nobody
// touching it (pointer, key, touch, wheel, focus, also into an embedded
// frame) for 5, a wake from sleep starting both over, and nothing to lose
// (reloadSafety: drafts written to the device first, the message list's spot
// saved), with /version.json read again just before (offline: no reload).
// Not safe yet: it looks again every 30 seconds while the release waits. A
// release still waiting 24 hours after the first newer one was seen (a tab
// always in front and in use) shows the banner at desktop width too, beside
// the Update button, once per release (its Dismiss is remembered on the
// device, and goes in every tab). The
// release is the frontend release id (VITE_FRONTEND_RELEASE_ID, else
// VITE_COMMIT_SHA), which every deploy sets and changes; the package version
// would only change with a version bump.
export const WEB_VERSION_URL = "/version.json";
// How long reading it may take before it counts as unreadable.
export const WEB_VERSION_FETCH_TIMEOUT_MS = 10_000;
export const VERSION_CHECK_INTERVAL_MS = 30 * 60_000;
// Spread over every open tab, so a deploy is not answered by all of them at once.
export const VERSION_CHECK_JITTER_MS = 5 * 60_000;
// Coming back to the tab checks at once, unless it checked this recently.
export const VISIBLE_CHECK_THROTTLE_MS = 5 * 60_000;
// The safe moment: hidden this long, or no input this long.
export const AUTO_RELOAD_QUIET_MS = 5 * 60_000;
// While a newer release waits, how often the moment is looked for again.
export const AUTO_RELOAD_RECHECK_MS = 30_000;
// A release waiting this long shows the banner at desktop width too.
export const OVERDUE_BANNER_AFTER_MS = 24 * 60 * 60_000;
// Input that says someone is using the tab (focusin: also focus moving into an embedded frame).
const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel", "focusin"] as const;
// This tab's session: the release it already reloaded itself for, once (a
// CDN that still serves the old files, a staged rollout, must not make it
// reload forever), and the release whose prompt was put away.
export const RELOADED_FOR_KEY = "raft.webVersion.reloadedFor";
export const DISMISSED_KEY = "raft.webVersion.dismissed";
// On the device (localStorage): the release whose 24-hour banner was put away.
export const OVERDUE_DISMISSED_KEY = "raft.webVersion.overdueDismissed";

/** This tab's own release, the one /version.json is compared with. */
export const WEB_RELEASE = resolveWebRelease(FRONTEND_RELEASE_IDENTITY.releaseId, import.meta.env);

/**
 * `release`: the newer release Reload is offered for. `chunkStripShown`: the
 * stale-build strip (RootErrorBoundary) is up; it already offers a refresh,
 * so the prompt waits while it shows. `topBarSlots`: how many top bars hold
 * the Update button (WebUpdateButton); at desktop width the prompt is that
 * button, and only a page without the bar shows the banner instead.
 * `overdue`: `release` has waited 24 hours; the banner shows beside the bar's
 * button too, until put away.
 */
export const useWebVersionPromptStore = create<{ release: string | null; chunkStripShown: boolean; topBarSlots: number; overdue: boolean }>(() => ({
  release: null,
  chunkStripShown: false,
  topBarSlots: 0,
  overdue: false,
}));

/** The top bar's Update button is mounted: the prompt shows there; returns its unmount. */
export function holdTopBarUpdateSlot(): () => void {
  useWebVersionPromptStore.setState((state) => ({ topBarSlots: state.topBarSlots + 1 }));
  return () => useWebVersionPromptStore.setState((state) => ({ topBarSlots: state.topBarSlots - 1 }));
}

/** RootErrorBoundary: whether its stale-build strip is showing. */
export function setChunkStripShown(shown: boolean): void {
  if (useWebVersionPromptStore.getState().chunkStripShown !== shown) useWebVersionPromptStore.setState({ chunkStripShown: shown });
}

type SessionStore = Pick<Storage, "getItem" | "setItem">;

export type WebVersionCheckDeps = {
  currentRelease: string;
  fetchPublishedRelease: () => Promise<string | null>;
  canReloadSilently: () => boolean;
  /** Right before reloading itself: drafts written, spots saved (reloadSafety.prepareReload). */
  prepareReload: () => void;
  reload: () => void;
  showPrompt: (release: string) => void;
  /** The release has waited 24 hours: the banner at desktop width too. */
  showOverdue: (release: string) => void;
  /** Its banner goes: put away in another tab, or a newer release came. */
  hideOverdue: () => void;
  /** The running release is published again (a rollback): the prompt and its banner go. */
  hidePrompt: () => void;
  storage: SessionStore | null;
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  win: Pick<Window, "addEventListener" | "removeEventListener">;
  random: () => number;
};

function read(storage: SessionStore | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

// True only when it is there to read back: a reload that could not be
// recorded could not be refused next time either.
function record(storage: SessionStore | null, key: string, value: string): boolean {
  try {
    storage?.setItem(key, value);
    return read(storage, key) === value;
  } catch {
    return false;
  }
}

/** The release the server publishes; null when it can't be read (offline, no file, not JSON). */
export async function fetchPublishedWebRelease(): Promise<string | null> {
  // A request that hangs gives up, so the checks and looks after it go on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_VERSION_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(WEB_VERSION_URL, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { release?: unknown } | null;
    const release = typeof body?.release === "string" ? body.release.trim() : "";
    return release || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Starts the checks; returns what stops them. */
export function startWebVersionCheck(deps: WebVersionCheckDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastCheckAt = -Infinity;
  let checking = false;
  let stopped = false;
  // When the tab was last hidden (null while shown) and last used.
  let hiddenSince: number | null = deps.doc.visibilityState === "hidden" ? Date.now() : null;
  let lastInputAt = Date.now();
  // The newer release waiting for its moment, and whether its 24 hours are up.
  // The 24 hours count from the first newer release this tab saw: a newer
  // one again does not start them over.
  let waiting: { release: string; overdue: boolean } | null = null;
  let firstSeenAt: number | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  let reloading = false;

  // The running release is published again (a rollback): nothing waits any
  // more; the prompt and any 24-hour banner go.
  const withdraw = () => {
    if (!waiting) return;
    waiting = null;
    firstSeenAt = null;
    deps.hidePrompt();
  };

  const used = () => {
    lastInputAt = Date.now();
  };
  // A timer that fires well after it was due: the machine slept (or the tab
  // was frozen). Waking up is someone coming back: the quiet starts over.
  const wokeIfLate = (dueAt: number) => {
    if (Date.now() - dueAt <= 2 * AUTO_RELOAD_RECHECK_MS) return;
    used();
    if (hiddenSince !== null) hiddenSince = Date.now();
  };

  const quiet = () => {
    const now = Date.now();
    const hiddenLongEnough = deps.doc.visibilityState === "hidden" && hiddenSince !== null && now - hiddenSince >= AUTO_RELOAD_QUIET_MS;
    return hiddenLongEnough || now - lastInputAt >= AUTO_RELOAD_QUIET_MS;
  };
  const mayReload = (release: string) => !stopped && quiet() && read(deps.storage, RELOADED_FOR_KEY) !== release && deps.canReloadSilently();

  // Once per release (a CDN still serving the old files must not make it
  // reload forever), and only once that is remembered. `fresh`: the release
  // was read just now; otherwise /version.json is read again first, and only
  // a newer release read there reloads (offline, or woken onto an old
  // answer: no reload, and the kept shell is not dropped).
  const reloadIfSafe = async (fresh: boolean): Promise<boolean> => {
    if (!waiting || reloading || !mayReload(waiting.release)) return false;
    let release = waiting.release;
    if (!fresh) {
      reloading = true;
      let published: string | null;
      try {
        published = await deps.fetchPublishedRelease();
      } finally {
        reloading = false;
      }
      if (published === deps.currentRelease) {
        withdraw();
        return false;
      }
      if (!published || !mayReload(published)) return false;
      release = published;
    }
    deps.prepareReload();
    if (!record(deps.storage, RELOADED_FOR_KEY, release)) return false;
    stopped = true;
    deps.reload();
    return true;
  };

  const scheduleLook = () => {
    if (stopped || recheck !== null) return;
    const dueAt = Date.now() + AUTO_RELOAD_RECHECK_MS;
    recheck = setTimeout(() => void lookAgain(dueAt), AUTO_RELOAD_RECHECK_MS);
  };

  const lookAgain = async (dueAt: number) => {
    recheck = null;
    if (stopped || !waiting) return;
    wokeIfLate(dueAt);
    if (await reloadIfSafe(false) || !waiting) return;
    if (!waiting.overdue && firstSeenAt !== null && Date.now() - firstSeenAt >= OVERDUE_BANNER_AFTER_MS) {
      waiting.overdue = true;
      deps.showOverdue(waiting.release);
    }
    scheduleLook();
  };

  const onNewRelease = async (release: string) => {
    firstSeenAt ??= Date.now();
    if (waiting?.release !== release) {
      // A newer release again: its own banner, under its own id.
      if (waiting?.overdue) deps.hideOverdue();
      waiting = { release, overdue: false };
    }
    if (await reloadIfSafe(true)) return;
    scheduleLook();
    if (read(deps.storage, DISMISSED_KEY) === release) return;
    deps.showPrompt(release);
  };

  const check = async () => {
    if (checking || stopped) return;
    checking = true;
    lastCheckAt = Date.now();
    try {
      const published = await deps.fetchPublishedRelease();
      if (stopped || !published) return;
      if (published === deps.currentRelease) withdraw();
      else await onNewRelease(published);
    } finally {
      checking = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    const delay = VERSION_CHECK_INTERVAL_MS + deps.random() * VERSION_CHECK_JITTER_MS;
    const dueAt = Date.now() + delay;
    timer = setTimeout(() => {
      wokeIfLate(dueAt);
      void check().finally(schedule);
    }, delay);
  };

  const onVisibilityChange = () => {
    if (deps.doc.visibilityState === "hidden") {
      hiddenSince ??= Date.now();
      return;
    }
    if (deps.doc.visibilityState !== "visible") return;
    // Back in front: someone is looking at it, so its idle time starts over.
    hiddenSince = null;
    used();
    if (Date.now() - lastCheckAt < VISIBLE_CHECK_THROTTLE_MS) return;
    void check();
  };
  // Focus leaving this page while it is shown (into an embedded frame: an
  // Artifact, a web preview, a PDF, whose input never reaches this page) is use.
  const onWindowBlur = () => {
    if (deps.doc.visibilityState === "visible") used();
  };
  // The 24-hour banner put away in another tab: here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key === OVERDUE_DISMISSED_KEY && waiting && event.newValue === waiting.release) deps.hideOverdue();
  };

  deps.doc.addEventListener("visibilitychange", onVisibilityChange);
  for (const type of INPUT_EVENTS) deps.doc.addEventListener(type, used, { capture: true, passive: true });
  deps.win.addEventListener("blur", onWindowBlur);
  deps.win.addEventListener("storage", onStorage);
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (recheck !== null) clearTimeout(recheck);
    deps.doc.removeEventListener("visibilitychange", onVisibilityChange);
    for (const type of INPUT_EVENTS) deps.doc.removeEventListener(type, used, { capture: true });
    deps.win.removeEventListener("blur", onWindowBlur);
    deps.win.removeEventListener("storage", onStorage);
  };
}

function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function deviceStore(): SessionStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reload onto the published release, not the HTML the service worker kept
 * from before it. The Update button's and the automatic reload's alike; the
 * same URL, so the open channel, thread and panel come back.
 */
export async function reloadOntoPublishedRelease(): Promise<void> {
  await dropKeptShell().catch(() => {});
  window.location.reload();
}

/** The 24-hour banner, unless it was already put away for this release on this device. */
export function showOverdueWebVersionBanner(release: string): void {
  if (read(deviceStore(), OVERDUE_DISMISSED_KEY) === release) return;
  useWebVersionPromptStore.setState({ release, overdue: true });
}

/**
 * The banner's Dismiss. `keepButton`: the 24-hour banner beside the top bar's
 * Update button goes, the button stays. Otherwise the prompt goes for this
 * release in this tab. Either way a 24-hour banner is not shown again for
 * this release on this device.
 */
export function dismissWebVersionPrompt({ keepButton = false }: { keepButton?: boolean } = {}): void {
  const { release, overdue } = useWebVersionPromptStore.getState();
  if (release && overdue) record(deviceStore(), OVERDUE_DISMISSED_KEY, release);
  if (keepButton) {
    useWebVersionPromptStore.setState({ overdue: false });
    return;
  }
  if (release) record(sessionStore(), DISMISSED_KEY, release);
  useWebVersionPromptStore.setState({ release: null, overdue: false });
}

/**
 * main.tsx: an ordinary web page of a deployed build only. A build with no
 * release id (local, dev, test) has nothing that tells deploys apart, and a
 * page whose files a native host owns (an offline bundle, the App's host-shell
 * embed) would reload onto the same files. The desktop app bundles its own
 * copy of the web (apps/desktop/frontend) and never runs this; it updates
 * through its own updater.
 */
export function installWebVersionCheck(): void {
  if (import.meta.env.DEV || import.meta.env.MODE === "test" || FRONTEND_RELEASE_IDENTITY.releaseId === null) return;
  if (getOfflineBundleHost().kind !== "none" || isHostShell()) return;
  startWebVersionCheck({
    currentRelease: WEB_RELEASE,
    fetchPublishedRelease: fetchPublishedWebRelease,
    canReloadSilently: () => canReloadWithoutLosingWork(document),
    prepareReload,
    reload: () => void reloadOntoPublishedRelease(),
    showPrompt: (release) => useWebVersionPromptStore.setState({ release }),
    showOverdue: showOverdueWebVersionBanner,
    hideOverdue: () => useWebVersionPromptStore.setState({ overdue: false }),
    hidePrompt: () => useWebVersionPromptStore.setState({ release: null, overdue: false }),
    storage: sessionStore(),
    doc: document,
    win: window,
    random: Math.random,
  });
}
