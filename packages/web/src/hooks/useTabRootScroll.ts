import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useServerStore } from "../store/serverStore";
import type { MobileTabId } from "../store/mobileNavStore";

// The scroller of each phone tab root, for the two things the tab bar does to
// it (Raft DS › Navigation › Going back, design lead 2026-10-21):
//
// - Tapping the selected tab scrolls its root to the top. At the top it does
//   nothing else (no reset, no navigation); only Search adds a step there, it
//   focuses its field. Activity is the one exception (artin 2026-10-21): it
//   goes to the next unread item instead (`onRetap`, ThreadsInbox).
// - Switching to another tab and back keeps the root's scroll position.
//   Search and Activity keep theirs with their own state (the search snapshot,
//   the inbox store), so they pass `rememberScroll: false`.

type RetapHandler = () => void;

const retapHandlers = new Map<MobileTabId, RetapHandler>();
const savedScrollTops = new Map<string, number>();

/** The tab bar's tap on the selected tab. Returns false when no root of that
 *  tab is on screen to take it. */
export function retapTabRoot(tab: MobileTabId): boolean {
  const handler = retapHandlers.get(tab);
  if (!handler) return false;
  handler();
  return true;
}

/** Test seam: forget remembered positions (a fresh page load). */
export function resetTabRootScrollMemory() {
  savedScrollTops.clear();
}

export function useTabRootScroll(
  /** The tab whose root this scroller is, or null while it is not showing
   *  one (desktop, a pushed page, a channel's own Tasks view). */
  tab: MobileTabId | null,
  scrollRef: RefObject<HTMLElement | null>,
  { onRetap, onRetapAtTop, rememberScroll = true }: {
    /** Replaces the scroll to the top (Activity only: the next unread item). */
    onRetap?: () => void;
    onRetapAtTop?: () => void;
    rememberScroll?: boolean;
  } = {},
) {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const memoryKey = tab && rememberScroll ? `${serverId ?? ""}|${tab}` : null;
  const onRetapRef = useRef(onRetap);
  onRetapRef.current = onRetap;
  const onRetapAtTopRef = useRef(onRetapAtTop);
  onRetapAtTopRef.current = onRetapAtTop;

  useEffect(() => {
    if (!tab) return;
    const handler = () => {
      if (onRetapRef.current) {
        onRetapRef.current();
        return;
      }
      const scroller = scrollRef.current;
      if (scroller && scroller.scrollTop > 0) {
        scroller.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      onRetapAtTopRef.current?.();
    };
    retapHandlers.set(tab, handler);
    return () => {
      if (retapHandlers.get(tab) === handler) retapHandlers.delete(tab);
    };
  }, [scrollRef, tab]);

  // Restore before paint when the root (re)appears, then follow the user's
  // scrolling. A root whose rows are still arriving gets one more try on the
  // next frame; a list that is shorter now simply clamps.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!memoryKey || !scroller) return;
    const saved = savedScrollTops.get(memoryKey) ?? 0;
    scroller.scrollTop = saved;
    const retry = scroller.scrollTop < saved
      ? window.requestAnimationFrame(() => { scroller.scrollTop = saved; })
      : null;
    const remember = () => savedScrollTops.set(memoryKey, scroller.scrollTop);
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => {
      if (retry !== null) window.cancelAnimationFrame(retry);
      scroller.removeEventListener("scroll", remember);
    };
  }, [memoryKey, scrollRef]);
}
