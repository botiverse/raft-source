import { useLayoutEffect } from "react";
import type { RefObject } from "react";
import type { DesktopPaneFocus } from "@botiverse/raft-shared";

import { getDesktopBridge } from "../../utils/desktopBridge";

/**
 * Which pane of the workspace grid holds the keyboard focus: the ONE source of it, for the shell's keys.
 *
 * Every pane is a focus scope, whatever it holds; its outer frame is the scope's edge, and what is drawn inside it
 * (a tab strip, an address row, an empty tab) and what it embeds (a native page view) are the same scope. Each pane
 * KIND declares its own shortcut table in the shell (apps/desktop paneKeys.ts; the browser's is BROWSER_SHORTCUTS),
 * and a key goes to the pane with the focus first; only a key it does not claim reaches the window's menu. A pane
 * marks its frame with `usePaneFrame` (it then carries `data-pane-kind`); a pane kind that claims no key needs no
 * frame. This module says which frame holds document.activeElement, recomputed on every focusin and focusout, and
 * when a frame mounts, changes or unmounts (released explicitly then, never left to a blur on removal), and tells
 * the shell (raftDesktop.paneFocus) only when that changes. A shell that predates it is told nothing, and keeps the
 * keys as before. The shell drops what it was told when this page reloads.
 *
 * A key pressed in a pane's embedded page (the browser's native view) never reaches this page: the shell knows its
 * pane, and offers it to the same pane kind.
 *
 * Separate from the web's own shortcut scopes (features/shortcuts, `data-shortcut-scope`), which act on DOM keydown
 * and cannot keep a key from the shell's menu; folding the two together is a possible follow-up.
 */

export const PANE_KIND_ATTRIBUTE = "data-pane-kind";

/** What a pane frame is: its kind, whose it is (the conversation), and its tab in front (null: none). */
export type PaneFrame = DesktopPaneFocus;

const frames = new Map<Element, PaneFrame>();
/** What the shell was last told; null: no pane (also before anything was told). */
let reported: PaneFrame | null = null;
let listening = false;

function same(a: PaneFrame | null, b: PaneFrame | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.owner === b.owner && a.tabId === b.tabId);
}

/** The frame that contains `node` (the innermost, should frames ever nest), or null. */
function frameOf(node: Node | null): PaneFrame | null {
  for (let at: Node | null = node; at; at = at.parentNode) {
    const frame = at instanceof Element ? frames.get(at) : undefined;
    if (frame) return frame;
  }
  return null;
}

function tell(next: PaneFrame | null): void {
  if (same(reported, next)) return;
  reported = next === null ? null : { ...next };
  getDesktopBridge()?.paneFocus?.set(reported);
}

/** The pane that holds the focus now, from document.activeElement (or where the focus is going: `to`). */
function recompute(to?: Node | null): void {
  if (typeof document === "undefined") return;
  tell(frameOf(to ?? document.activeElement));
}

const onFocusIn = () => recompute();
// Leaving an element: where the focus goes (relatedTarget) decides; with none (the window lost the focus, the
// element went), the element that still has it, if any.
const onFocusOut = (event: FocusEvent) => recompute(event.relatedTarget instanceof Node ? event.relatedTarget : null);

function listen(on: boolean): void {
  if (typeof document === "undefined" || listening === on) return;
  listening = on;
  if (on) {
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
  } else {
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
  }
}

/** Marks `element` as a pane's frame. Returns the release (the pane went): the shell is told at once. */
export function registerPaneFrame(element: Element, frame: PaneFrame): () => void {
  frames.set(element, frame);
  element.setAttribute(PANE_KIND_ATTRIBUTE, frame.kind);
  listen(true);
  recompute();
  return () => {
    if (frames.get(element) !== frame) return;
    frames.delete(element);
    element.removeAttribute(PANE_KIND_ATTRIBUTE);
    if (frames.size === 0) listen(false);
    // Whatever the DOM says of a focused element on its way out: this frame holds no focus from now on.
    tell(frameOf(document.activeElement));
  };
}

/** The pane `ref` is the outer frame of, for as long as it is mounted (its tab in front as it changes). */
export function usePaneFrame(ref: RefObject<Element | null>, kind: string, owner: string, tabId: string | null): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    return registerPaneFrame(element, { kind, owner, tabId });
  }, [ref, kind, owner, tabId]);
}

/** For tests: what the shell was last told. */
export function reportedPaneFocus(): PaneFrame | null {
  return reported;
}
