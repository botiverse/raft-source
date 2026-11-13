import { useCallback } from "react";
import type { KeyboardEvent } from "react";

import { isInputMethodKey } from "./artifactInputMethodKey";
import { canTakeFocus } from "./artifactViewerStore";

/** Anything Tab can stop on, before what's disabled, inert or not drawn. */
const TAB_STOPS = "a[href], button, input, select, textarea, summary, [contenteditable], [tabindex]";

/**
 * Whether Tab from `from` (`back`: Shift+Tab) leaves `card`: nothing it can stop on is left that way.
 * Read at each key, as what's disabled, inert or in the card changes while it is open. From the
 * card's own element, or one in it out of the Tab order, the way is the same as from a stop there.
 */
function tabsOut(card: HTMLElement, from: Element, back: boolean) {
  const way = back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  return !Array.from(card.querySelectorAll<HTMLElement>(TAB_STOPS)).some(
    (stop) => (from.compareDocumentPosition(stop) & way) !== 0 && stop.tabIndex >= 0 && !stop.matches(":disabled") && canTakeFocus(stop),
  );
}

/**
 * A comment card's keydown, on its Popover (raft-design elevation.md: a non-modal popover closes on
 * Tab out, in one step, as on Esc). Past the card's ends Tab would land on Base UI's focus guards,
 * which pass it on to a trigger these Popovers haven't got, and then the body, the card still open.
 * So that key is Esc, here, in one handler (`closeByKey`, what Esc does on that card, so its focus
 * and a new comment's words go as Esc's do): the focus stays in the card until it is gone, and is
 * never left on a guard. Armed, Tab has nothing in the card to go to: it stays, not out past the card
 * (which closes it). A key the @ picker took or an input method's stays theirs, Ctrl, Alt or ⌘ with
 * Tab is the browser's, and what's portaled out of the card (its ⋯ menu) comes here through React alone.
 * All of it reads the key's own target, never `document.activeElement`, which can still read the
 * frame with the key in the card (Firefox); `closeByKey` is told that target too.
 */
export function useCardTabOut(armed: boolean, closeByKey: (from: Element) => void) {
  return useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    if (armed) {
      event.preventDefault();
      return;
    }
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || isInputMethodKey(event)) return;
    const card = event.currentTarget;
    const from = event.target as Element;
    if (!card.contains(from) || !tabsOut(card, from, event.shiftKey)) return;
    event.preventDefault();
    closeByKey(from);
  }, [armed, closeByKey]);
}
