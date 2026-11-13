import { useEffect, useLayoutEffect, useRef } from "react";
import { LOCATED_MS } from "@botiverse/raft-ui";

/**
 * How long a key press counts as the cause of a jump asked for after it,
 * as raft-ui's input modality counts a key as the cause of a focus move.
 */
const KEY_CAUSE_WINDOW_MS = 1000;

/** Keys that activate: Enter on a result in a search field, Space on a button. */
const ACTIVATION_KEYS = new Set(["Enter", " ", "Spacebar"]);

let lastActivationKeyAt = -Infinity;
let lastPointerDownAt = -Infinity;
let trackerInstalled = false;

/**
 * raft-ui's modality leaves Enter in a text field alone (it edits), so a jump
 * started by Enter in the ⌘K or search field reads as whatever came before.
 * Record activation keys and pointer presses ourselves, once per page.
 */
function installActivationTracker(doc: Document): void {
  if (trackerInstalled) return;
  trackerInstalled = true;
  const options = { capture: true, passive: true } as const;
  doc.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (ACTIVATION_KEYS.has(event.key)) lastActivationKeyAt = performance.now();
  }, options);
  doc.addEventListener("pointerdown", () => {
    lastPointerDownAt = performance.now();
  }, options);
}

/**
 * Whether the input that just started a jump was the keyboard: raft-ui's input
 * modality on the root (`data-input-modality`, installed by ThemeProvider)
 * says "keyboard" after a navigation key, or an activation key was pressed
 * just now with no pointer press since. A click or a tap, no input at all (a
 * permalink opened on load), or focus that moved by itself ("virtual") is not.
 */
export function lastInputWasKeyboard(doc: Document = document): boolean {
  if (doc.documentElement.getAttribute("data-input-modality") === "keyboard") return true;
  return lastActivationKeyAt > lastPointerDownAt && performance.now() - lastActivationKeyAt < KEY_CAUSE_WINDOW_MS;
}

/**
 * Move focus to the item a jump located (design/foundations/states.md#located):
 * `tabIndex={-1}` on an element that can't take focus, then
 * `focus({ preventScroll: true })`, as the list has already scrolled. The
 * tabindex added here goes again when focus moves elsewhere in the page, so a
 * later click on the item doesn't take focus away from the composer; leaving
 * the window keeps it, so focus is still there on return.
 */
export function focusJumpTarget(el: HTMLElement): void {
  if (!el.hasAttribute("tabindex") && el.tabIndex < 0) {
    el.setAttribute("tabindex", "-1");
    const onBlur = () => {
      if (!el.ownerDocument.hasFocus()) {
        el.addEventListener("blur", onBlur, { once: true });
        return;
      }
      el.removeAttribute("tabindex");
    };
    el.addEventListener("blur", onBlur, { once: true });
  }
  el.focus({ preventScroll: true });
}

/**
 * A jump started from the keyboard also moves focus to the item it located,
 * so keyboard and screen reader users land on it; a jump started with the
 * pointer leaves focus where it was (states.md#located).
 *
 * `jump` names one jump from the moment it is asked for (an id and a nonce,
 * as useLocated's request), or null. The input that started it is read then,
 * not when the item shows. `ready` turns true once the item is loaded;
 * `findTarget` returns its element, or null while the list hasn't scrolled to
 * it and rendered it yet, which is retried for as long as the highlight lasts.
 */
export function useKeyboardJumpFocus(
  jump: string | null | undefined,
  ready: boolean,
  findTarget: () => HTMLElement | null,
): void {
  const findTargetRef = useRef(findTarget);
  findTargetRef.current = findTarget;
  const fromKeyboardRef = useRef<{ jump: string; keyboard: boolean } | null>(null);
  if (typeof document !== "undefined") installActivationTracker(document);
  useLayoutEffect(() => {
    fromKeyboardRef.current = jump == null ? null : { jump, keyboard: lastInputWasKeyboard() };
  }, [jump]);
  useEffect(() => {
    const started = fromKeyboardRef.current;
    if (!ready || jump == null || started?.jump !== jump || !started.keyboard) return;
    const giveUpAt = performance.now() + LOCATED_MS;
    let raf = requestAnimationFrame(function attempt() {
      const target = findTargetRef.current();
      if (target) {
        // One focus per jump: the jump going unready and ready again (a
        // reload of the list) doesn't take focus back.
        started.keyboard = false;
        focusJumpTarget(target);
        return;
      }
      if (performance.now() < giveUpAt) raf = requestAnimationFrame(attempt);
    });
    return () => cancelAnimationFrame(raf);
  }, [jump, ready]);
}

export function resetActivationTrackerForTests(): void {
  lastActivationKeyAt = -Infinity;
  lastPointerDownAt = -Infinity;
}

/**
 * The located row of a message: the element carrying `data-located` around
 * the message's body. Another copy of the same message that isn't located
 * (the thread's root in the side panel) doesn't match.
 */
export function findLocatedMessageRow(messageId: string | null | undefined, doc: Document = document): HTMLElement | null {
  if (!messageId) return null;
  for (const body of doc.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (body.getAttribute("data-message-id") !== messageId) continue;
    const row = body.closest<HTMLElement>("[data-located]");
    if (row) return row;
  }
  return null;
}
