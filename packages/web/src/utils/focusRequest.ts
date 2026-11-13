// Asking for focus from code (focus plan, rules 1-3): who asks decides how far
// the request may reach, and a request that has to wait can be overtaken by a
// newer one or by the person. Giving focus back after a surface closes (rule 4)
// is useFocusRestore's: it has to wait a frame before it can tell whether focus
// was lost, and it keeps its own pending restore for now.

import { behindModalLayer, focusLost, mayTakeFocus, OVERLAY } from "./focusGuard";

/**
 * Why focus should move: `user`, the person's own key press, click or command (rule 2: the only kind that may take
 * focus from another field); `mount` and `async`, something appeared or finished (only where nobody is using focus:
 * mayTakeFocus).
 */
export type FocusReason = "user" | "mount" | "async";

export interface FocusRequestOptions<T extends HTMLElement> {
  reason: FocusReason;
  /** Runs once focus landed on the target (the search field selects its words). */
  onFocused?: (target: T) => void;
}

let cancelPending: (() => void) | null = null;

function mayFocus(target: HTMLElement, reason: FocusReason): boolean {
  // Rule 1: never behind an open modal layer, whoever asks.
  if (behindModalLayer(target)) return false;
  if (reason === "user") return true;
  return mayTakeFocus(target);
}

/** Focuses the target if it is there and allowed; false when it isn't there yet. */
function attempt<T extends HTMLElement>(getTarget: () => T | null | undefined, options: FocusRequestOptions<T>): boolean {
  const target = getTarget();
  if (!target?.isConnected) return false;
  if (mayFocus(target, options.reason)) {
    target.focus({ preventScroll: true });
    if (target.ownerDocument.activeElement === target) options.onFocused?.(target);
  }
  return true;
}

/**
 * Asks for focus on `getTarget()`, read when the request runs. A target not there yet is tried once more a frame
 * later; until then the request is pending (rule 3): a newer request, or a press or focus move anywhere, cancels it. At
 * most one requestFocus request is pending page-wide.
 */
export function requestFocus<T extends HTMLElement>(getTarget: () => T | null | undefined, options: FocusRequestOptions<T>): void {
  cancelPending?.();
  if (attempt(getTarget, options)) return;
  let frame = 0;
  const cancel = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("focusin", cancel, true);
    if (cancelPending === cancel) cancelPending = null;
  };
  cancelPending = cancel;
  document.addEventListener("pointerdown", cancel, true);
  document.addEventListener("focusin", cancel, true);
  frame = requestAnimationFrame(() => {
    cancel();
    attempt(getTarget, options);
  });
}

/**
 * For focus to move once something the person started by a press is ready (a delete answered, a page loaded, a viewer
 * drawn): call it in their press, as the work starts. The check it returns, asked once the work is done, says whether
 * the move is still wanted (rule 3): no press since (but one in a layer opened over `scope`, the confirmation the work
 * asks first), and focus fell to nowhere, is still where it was at the press (a browser that doesn't focus a pressed
 * button), or is in `scope` (the pressed control's surface). A press, or focus moved elsewhere, meanwhile cancels it.
 * Asking stops watching; make the move itself with requestFocus. With `repeat`, asking doesn't: the check can be asked
 * at each step of longer work (a page that opens, then draws its target later), until a press stops it.
 */
export function watchFocusIntent(scope?: () => Element | null | undefined, { repeat = false }: { repeat?: boolean } = {}): () => boolean {
  const from = document.activeElement;
  let pressed = false;
  const onPress = (event: Event) => {
    const layer = event.target instanceof Element ? event.target.closest(OVERLAY) : null;
    const within = scope?.();
    if (layer && within && !layer.contains(within)) return;
    pressed = true;
    stop();
  };
  const stop = () => document.removeEventListener("pointerdown", onPress, true);
  document.addEventListener("pointerdown", onPress, true);
  return () => {
    if (!repeat) stop();
    if (pressed) return false;
    const active = document.activeElement;
    return focusLost() || (!!active && (active === from || !!scope?.()?.contains(active)));
  };
}
