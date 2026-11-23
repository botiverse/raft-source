import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import { focusLost } from "../utils/focusGuard";
import { animationFramesOf, useOwnerDocument } from "../utils/ownerDocument";

type Target = HTMLElement | null | undefined;
/** Where focus goes back to: an element, or places to try in order (the first that takes it). */
type Opener = RefObject<Target> | (() => Target | ReadonlyArray<Target>);
/** How to focus it; a function when that depends on the place found (a row scrolls into view, the list doesn't). */
type RestoreFocusOptions = FocusOptions | ((target: HTMLElement) => FocusOptions);

/** The places `opener` names now, in order. */
function openerTargets(opener: Opener): ReadonlyArray<Target> {
  const resolved = typeof opener === "function" ? opener() : opener.current;
  return Array.isArray(resolved) ? resolved : [resolved as Target];
}

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
  // The document this surface is drawn in (an object window's, features/objectWindows): its presses cancel the
  // restore, its window's frame runs it. The opener itself is read only then (a function opener may act on the page).
  const doc = useOwnerDocument();
  return useCallback(() => {
    pending.current?.();
    const view = animationFramesOf(doc);
    let frame = 0;
    const cancel = () => {
      view.cancelAnimationFrame(frame);
      doc.removeEventListener("pointerdown", cancel, true);
      if (pending.current === cancel) pending.current = null;
    };
    pending.current = cancel;
    // A press before then is the person moving on, wherever it puts focus (the page included).
    doc.addEventListener("pointerdown", cancel, true);
    frame = view.requestAnimationFrame(() => {
      cancel();
      const { opener: source, options: focusOptions } = latest.current;
      for (const target of openerTargets(source)) {
        if (!target?.isConnected || target.closest("[inert]") || !focusLost(target)) continue;
        target.focus(typeof focusOptions === "function" ? focusOptions(target) : focusOptions);
        // One unseen or disabled doesn't take it: the next.
        if (target.ownerDocument.activeElement === target) return;
      }
    });
  }, [doc]);
}
