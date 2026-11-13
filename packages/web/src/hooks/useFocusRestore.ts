import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import { focusLost } from "../utils/focusGuard";

type Target = HTMLElement | null | undefined;
/** Where focus goes back to: an element, or places to try in order (the first that takes it). */
type Opener = RefObject<Target> | (() => Target | ReadonlyArray<Target>);
/** How to focus it; a function when that depends on the place found (a row scrolls into view, the list doesn't). */
type RestoreFocusOptions = FocusOptions | ((target: HTMLElement) => FocusOptions);

/**
 * Focus back to the opener after a non-modal surface closes (a side card, a panel, a selection bar, a notice):
 * `restore()`, called as it closes, checks a frame later (the close committed, and whatever focuses itself on mount
 * did) and moves focus to the opener only if focus was lost (focusLost: to <body>, or with the element that held it;
 * never out of an open dialog). Focus the person put somewhere real stays there, and so does any a press moved in the
 * meantime. This surface's newer restore replaces one still waiting. raft-ui's modal layers (Dialog, Drawer) give
 * focus back themselves: not for them.
 *
 * `opener` is read when the restore runs: a ref, or a function (that may give places to try in order).
 */
export function useFocusRestore(opener: Opener, options?: RestoreFocusOptions): () => void {
  const latest = useRef({ opener, options });
  latest.current = { opener, options };
  const pending = useRef<(() => void) | null>(null);
  return useCallback(() => {
    pending.current?.();
    let frame = 0;
    const cancel = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", cancel, true);
      if (pending.current === cancel) pending.current = null;
    };
    pending.current = cancel;
    // A press before then is the person moving on, wherever it puts focus (the page included).
    document.addEventListener("pointerdown", cancel, true);
    frame = requestAnimationFrame(() => {
      cancel();
      const { opener: source, options: focusOptions } = latest.current;
      const resolved = typeof source === "function" ? source() : source.current;
      const targets = Array.isArray(resolved) ? resolved : [resolved];
      for (const target of targets) {
        if (!target?.isConnected || target.closest("[inert]") || !focusLost(target)) continue;
        target.focus(typeof focusOptions === "function" ? focusOptions(target) : focusOptions);
        // One unseen or disabled doesn't take it: the next.
        if (document.activeElement === target) return;
      }
    });
  }, []);
}
