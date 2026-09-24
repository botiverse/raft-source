import { create } from "zustand";
import type { RailMode } from "../hooks/useSidebarTab";

// Mobile-only per-tab navigation stack. Each MOBILE TAB (chat / tasks /
// members / settings — 4 tabs, per @stdrc 2026-04-30 #proj-uiux:c8711d2a)
// keeps its own list of paths the user has visited within that tab.
// iOS NavigationView semantics:
//
// - Cold tap a tab from elsewhere → land on the stack's current top
//   (the place the user left when they last switched away). If empty,
//   land on the tab's canonical home.
// - Tap a tab while already on it → pop everything down to root (just
//   the tab home). This is the "scroll-to-top / reset" gesture.
// - Drilling into a detail (e.g. agent/<id> from members list) pushes
//   the new path onto the active tab's stack. The detail covers the
//   tab bar — there is no concept of "switch tabs from inside a detail",
//   user must hit the back button first.
// - In-app or browser back pops one entry off the active tab's stack.
//
// Computers is NOT a top-level mobile tab — it lives inside Settings.
// On mobile, /computers and /computer/<id> are part of the Settings stack.
// Search is NOT a top-level mobile tab — it is a Home drill-in.
// On mobile, /search is part of the Chat/Home stack.
//
// URL paths are still shared with desktop — only navigation BEHAVIOR
// is mobile-specific. The stack only matters for tab tap / back.
//
// Stacks are not persisted across reloads: a fresh page load
// reconstructs the active tab's stack from [tabHome, currentPath]
// (see hydrateFromLocation).

export type MobileTabId = "chat" | "tasks" | "members" | "settings";

export const MOBILE_TAB_IDS: readonly MobileTabId[] = ["chat", "tasks", "members", "settings"];

/** Which mobile tab does this desktop rail mode belong to?
 *  - desktop "computers" rail mode → mobile "settings" tab
 *  - desktop "search" rail mode    → mobile "chat" tab (Search lives under
 *    Home on mobile)
 *  - desktop "activity" rail mode  → mobile "chat" tab (Activity lives under
 *    Home on mobile too — same shape as Search; mobile Activity surface is
 *    a follow-up if/when stdrc spec'd it)
 *  - everything else maps 1:1
 */
export function railModeToMobileTab(mode: RailMode): MobileTabId {
  if (mode === "search") return "chat";
  if (mode === "activity") return "chat";
  if (mode === "wiki") return "chat";
  if (mode === "computers") return "settings";
  return mode;
}

const TAB_HOME_BY_MOBILE_TAB: Record<MobileTabId, (pathBase: string) => string> = {
  chat: (base) => base,
  tasks: (base) => `${base}/tasks`,
  members: (base) => `${base}/members`,
  // /settings (no sub-tab) is the master view that renders the settings
  // sub-nav (Account / Browser / Server / Computers / Release Notes) inline.
  settings: (base) => `${base}/settings`,
};

export function tabHomeFor(mode: MobileTabId, pathBase: string): string {
  return TAB_HOME_BY_MOBILE_TAB[mode](pathBase);
}

// Query params that encode right-panel overlays (thread / profile). On a
// cold-start URL these overlays sit ON TOP of the base route — so the natural
// back-stop is the same pathname with the overlay param stripped, not the
// tab home. Without this intermediate layer, hitting back once on a thread
// permalink (#proj-uiux:c8711d2a bug reported by @stdrc msg=768680bf) would
// jump past the parent channel straight to Home. Keep this list in sync
// with `useRightPanelUrlSync` in MainLayout.tsx (L442-498).
const OVERLAY_QUERY_PARAMS = ["thread", "profile"] as const;

/** Strip overlay params (?thread, ?profile) from a "pathname?search" string. */
function stripOverlayParams(pathAndSearch: string): string {
  const qIndex = pathAndSearch.indexOf("?");
  if (qIndex < 0) return pathAndSearch;
  const pathname = pathAndSearch.slice(0, qIndex);
  const params = new URLSearchParams(pathAndSearch.slice(qIndex + 1));
  let removedAny = false;
  for (const key of OVERLAY_QUERY_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      removedAny = true;
    }
  }
  if (!removedAny) return pathAndSearch;
  const remaining = params.toString();
  return remaining ? `${pathname}?${remaining}` : pathname;
}

interface MobileNavState {
  // Per-tab stacks of path+search strings. Top of stack = bottom of array
  // is the home; last element is the current view.
  stacks: Record<MobileTabId, string[]>;
  // True when the next location change came from in-app navigation
  // (push/pop/replace). False on browser back/forward.
  // We only use this to skip duplicate hydration; default false is safe.
  expectingNav: boolean;

  hydrate: (mode: MobileTabId, pathBase: string, currentPathAndSearch: string) => void;
  push: (mode: MobileTabId, pathAndSearch: string) => void;
  pop: (mode: MobileTabId) => string | null;
  popToRoot: (mode: MobileTabId) => string;
  replaceTop: (mode: MobileTabId, pathAndSearch: string) => void;
  reset: () => void;
}

const emptyStacks = (): Record<MobileTabId, string[]> => ({
  chat: [],
  tasks: [],
  members: [],
  settings: [],
});

export const useMobileNavStore = create<MobileNavState>((set, get) => ({
  stacks: emptyStacks(),
  expectingNav: false,

  // Initialize a tab's stack on cold load. Shapes (by current URL):
  //   - current IS the tab home             → [home]
  //   - current has an overlay param        → [home, currentWithoutOverlay, current]
  //   - otherwise                           → [home, current]
  //
  // The three-layer shape matters for cold-starting on a thread permalink
  // (`/channel/<id>?thread=<..>`): the first back should close the thread
  // (land at `/channel/<id>`), the second back should land at Home. Without
  // the intermediate layer we'd jump past the parent channel in one click.
  //
  // Subsequent calls within the same session won't re-hydrate (we keep
  // whatever the user has built up).
  hydrate: (mode, pathBase, current) => {
    const existing = get().stacks[mode];
    if (existing.length > 0) return;
    const home = tabHomeFor(mode, pathBase);
    if (current === home) {
      set((state) => ({ stacks: { ...state.stacks, [mode]: [home] } }));
      return;
    }
    const intermediate = stripOverlayParams(current);
    const layers: string[] = [home];
    if (intermediate !== current && intermediate !== home) {
      layers.push(intermediate);
    }
    layers.push(current);
    set((state) => ({ stacks: { ...state.stacks, [mode]: layers } }));
  },

  push: (mode, pathAndSearch) => {
    set((state) => {
      const top = state.stacks[mode].at(-1);
      if (top === pathAndSearch) return {};
      return { stacks: { ...state.stacks, [mode]: [...state.stacks[mode], pathAndSearch] } };
    });
  },

  pop: (mode) => {
    const cur = get().stacks[mode];
    if (cur.length <= 1) return null;
    const next = cur.slice(0, -1);
    set((state) => ({ stacks: { ...state.stacks, [mode]: next } }));
    return next.at(-1) ?? null;
  },

  popToRoot: (mode) => {
    const cur = get().stacks[mode];
    const home = cur[0] ?? "";
    set((state) => ({ stacks: { ...state.stacks, [mode]: home ? [home] : [] } }));
    return home;
  },

  replaceTop: (mode, pathAndSearch) => {
    set((state) => {
      const cur = state.stacks[mode];
      if (cur.length === 0) {
        return { stacks: { ...state.stacks, [mode]: [pathAndSearch] } };
      }
      const next = [...cur.slice(0, -1), pathAndSearch];
      return { stacks: { ...state.stacks, [mode]: next } };
    });
  },

  reset: () => set({ stacks: emptyStacks(), expectingNav: false }),
}));
