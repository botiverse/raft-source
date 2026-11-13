import assert from "node:assert/strict";

// raft-ui ScrollArea's overlay scrollbars, on the element that scrolls. With
// sticky gutters (the default) that element is the ScrollArea root and its
// container at once: ScrollArea's own <div>, or an element of the caller's
// bound with `useScrollAreaContainer` (VirtualList's scroller, the Lightbox
// root). Either way the gutters layer is that element's first child, so the
// thumb follows that element's scroll position and nothing else.

export type ScrollAreaRailsExpectation = {
  trigger?: "hover" | "scroll" | "none";
  /** The element is the caller's own, bound with `useScrollAreaContainer` (not ScrollArea's own <div>). */
  ownContainer?: boolean;
};

/** Asserts that `element`, the element the code measures and scrolls, holds ScrollArea's gutters. */
export function assertScrollAreaRailsOn(
  element: Element | null | undefined,
  { trigger, ownContainer }: ScrollAreaRailsExpectation = {},
): asserts element is HTMLElement {
  assert.ok(element instanceof HTMLElement, "the scroller is in the DOM");
  assert.ok(element.classList.contains("r-scroll-area"), "the scroller is the ScrollArea root");
  assert.ok(element.classList.contains("r-scroll-area--sticky-gutters"), "the gutters are sticky, inside the scroller");
  assert.ok(
    element.firstElementChild?.classList.contains("r-scroll-area__gutters"),
    "the scrollbars are the scroller's own first child, not a wrapper's",
  );
  assert.equal(element.querySelectorAll(".r-scroll-area__gutters").length - nestedGutters(element), 1);
  if (ownContainer !== undefined) {
    assert.equal(!element.classList.contains("r-scroll-area__viewport"), ownContainer);
    if (!ownContainer) assert.equal(element.dataset.slot, "scroll-area");
  }
  if (trigger) assert.ok(element.classList.contains(`r-scroll-area--${trigger}-trigger`), `trigger="${trigger}"`);
  assert.ok(!element.classList.contains("scrollbar-quiet"), "the old native scrollbar styling is gone");
  assert.ok(!element.classList.contains("overflow-y-overlay"), "the old overlay overflow is gone");
}

// Gutters of ScrollAreas nested inside (a menu, a code block) are theirs.
function nestedGutters(element: HTMLElement): number {
  let count = 0;
  for (const inner of element.querySelectorAll(".r-scroll-area")) {
    count += inner.querySelectorAll(":scope > .r-scroll-area__gutters").length;
  }
  return count;
}
