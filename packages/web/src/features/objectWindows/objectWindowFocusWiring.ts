// Focus in an object window (Kirby's review, item 5; Kaze's keepKeyboard):
// activating a window gives the keyboard to its document, not back to the
// element that had it, so the element focused when the window lost the focus
// is remembered and focused again when it comes back (only if nothing else
// took it meanwhile). A window that closes gives the focus back to the
// element it was opened from in the main window (the row, the card).

import { focusLost } from "../../utils/focusGuard";
import { isElementNode, isHTMLElementNode } from "../../utils/ownerDocument";

/** Nothing focused in the document: null or its <body>. */
function nothingFocused(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || active === doc.documentElement;
}

/**
 * Remember what had the focus in `doc` when `win` lost it, and focus it
 * again when `win` gets it back with nothing focused. Returns the stop.
 */
export function installObjectWindowFocus(win: Window, doc: Document): () => void {
  let remembered: HTMLElement | null = null;
  const onBlur = (event: Event) => {
    // The window's own blur (a focus moving inside it blurs its elements, which don't bubble here).
    if (event.target !== win) return;
    const active = doc.activeElement;
    remembered = isHTMLElementNode(active) && active !== doc.body ? active : null;
  };
  const onFocus = (event: Event) => {
    if (event.target !== win) return;
    const element = remembered;
    remembered = null;
    if (!element?.isConnected || element.ownerDocument !== doc || !nothingFocused(doc)) return;
    element.focus({ preventScroll: true });
  };
  win.addEventListener("blur", onBlur);
  win.addEventListener("focus", onFocus);
  return () => {
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("focus", onFocus);
  };
}

/**
 * An object window closed: give the focus back to `opener` (in the main
 * window) if it is still there and focus there was lost; true when it took
 * it. It does not raise the main window: the system decides which window
 * comes forward, and the focus is waiting there when it does.
 */
export function restoreOpenerFocus(opener: Element | null | undefined): boolean {
  if (!isElementNode(opener) || !opener.isConnected || !isHTMLElementNode(opener)) return false;
  if (opener.closest("[inert]") || !focusLost(opener)) return false;
  opener.focus({ preventScroll: true });
  return opener.ownerDocument.activeElement === opener;
}
