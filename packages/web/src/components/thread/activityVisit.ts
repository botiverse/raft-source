import { useEffect } from "react";
import { heldAutoReadId, releaseAutoRead } from "../../store/autoReadHold";
import { dropActivityUnreadSnapshot } from "../../store/activityUnreadSnapshot";

/**
 * One visit to Activity, for its arrival reopen (ThreadsInbox) and the
 * auto-read hold on the reopened conversation (store/autoReadHold).
 *
 * A visit lasts while any Activity surface is mounted: the list, or the opened
 * conversation's pane (MainLayout's InboxContentRoute). Either can remount on
 * its own when the layout switches: the list moves between the main area and
 * the column beside the conversation, and on a phone the opened conversation
 * replaces the list. Counting both keeps the visit, and the hold on a
 * conversation still on screen, through those switches; only leaving Activity
 * (nothing left mounted after the remount) ends it, unread, so the next visit
 * reopens again. A leaf module, so MainLayout does not load the lazy list.
 */
let mountedSurfaces = 0;
let arrivalDone = false;
let visit = 0;

/** Keys that are not acting in a conversation: modifiers alone, moving focus away, closing. */
const NOT_ACTING_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Escape"]);
const LISTENER_OPTIONS = { capture: true, passive: true } as const;
const ACTING_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

// Acting in the reopened conversation (a click, a key, a scroll inside the
// detail pane) reads it. Its header (close, back, menus), modifier keys and
// Tab / Escape do not.
function act(event: Event) {
  if (heldAutoReadId() === null) return;
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-activity-detail]")) return;
  if (target.closest('[data-slot="panel-header"], [data-slot="panel-header-root"]')) return;
  if (event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey || event.altKey || NOT_ACTING_KEYS.has(event.key))) return;
  releaseAutoRead({ read: true });
}

function mountSurface() {
  mountedSurfaces += 1;
  // One listener per type for the whole visit (re-adding the same one is a no-op).
  // keydown-global-exempt: passive capture observer that only notes a key in the Activity detail pane; never handles or redirects keys
  for (const type of ACTING_EVENTS) document.addEventListener(type, act, LISTENER_OPTIONS);
}

function unmountSurface() {
  mountedSurfaces -= 1;
  window.setTimeout(() => {
    if (mountedSurfaces > 0) return;
    for (const type of ACTING_EVENTS) document.removeEventListener(type, act, LISTENER_OPTIONS);
    arrivalDone = false;
    visit += 1;
    releaseAutoRead({ read: false });
    // The Unread list is taken afresh on the next visit; nothing to hold meanwhile.
    dropActivityUnreadSnapshot();
  }, 0);
}

/** Mount in every Activity surface (the list, the opened conversation's pane). */
export function useActivityVisitSurface(): void {
  useEffect(() => {
    mountSurface();
    return unmountSurface;
  }, []);
}

export const activityVisit = {
  /** Whether any Activity surface is mounted now. */
  isActive: () => mountedSurfaces > 0,
  /** Counts visits, so a reopen scheduled in one visit is dropped in the next. */
  current: () => visit,
  /** Arrival reopens at most once per visit; claims that once, true if not taken yet. */
  claimArrival: (): boolean => {
    if (arrivalDone) return false;
    arrivalDone = true;
    return true;
  },
};
