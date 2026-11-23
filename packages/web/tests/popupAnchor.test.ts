import assert from "node:assert/strict";
import { capturePointAnchor } from "../src/components/ui/popupAnchor";

function fakeElement(initial: { left: number; top: number; width?: number; height?: number; connected?: boolean }) {
  const state = {
    left: initial.left,
    top: initial.top,
    width: initial.width ?? 200,
    height: initial.height ?? 40,
    connected: initial.connected ?? true,
  };
  const element = {
    nodeType: 1,
    get isConnected() {
      return state.connected;
    },
    getBoundingClientRect() {
      return {
        x: state.left,
        y: state.top,
        left: state.left,
        top: state.top,
        right: state.left + state.width,
        bottom: state.top + state.height,
        width: state.width,
        height: state.height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  } as unknown as Element;
  return { element, state };
}

test("capturePointAnchor captures offset atomically at event time, emits 1x1 point rect, and tracks scroll and resize", () => {
  const { element, state } = fakeElement({ left: 100, top: 300 });
  // Right-click at (145, 322) -> offset (+45, +22) relative to element.
  const anchor = capturePointAnchor(145, 322, element);
  assert.equal(anchor.contextElement === element, true);

  // Even if the element moves BEFORE the popup's first layout measurement,
  // the captured offset tracks the movement from capture time.
  state.top = 240;
  state.left = 120;
  const first = anchor.getBoundingClientRect();
  assert.equal(first.left, 165);
  assert.equal(first.top, 262);
  assert.equal(first.width, 1);
  assert.equal(first.height, 1);

  // Subsequent scroll moves the anchor further up.
  state.top = -120;
  const scrolled = anchor.getBoundingClientRect();
  assert.equal(scrolled.left, 165);
  assert.equal(scrolled.top, -98);

  // If the row is recycled out of the DOM after scrolling off-screen, the anchor
  // holds its last measured off-screen coordinates instead of jumping back or to (0, 0).
  state.connected = false;
  const detached = anchor.getBoundingClientRect();
  assert.equal(detached.left, 165);
  assert.equal(detached.top, -98);
});

test("capturePointAnchor returns 0x0 collapsed rect when a connected visible element hides via display:none", () => {
  const { element, state } = fakeElement({ left: 200, top: 150, width: 320, height: 48 });
  const anchor = capturePointAnchor(450, 170, element);
  assert.equal(anchor.getBoundingClientRect().left, 450);
  assert.equal(anchor.getBoundingClientRect().top, 170);

  // Element remains connected but collapses via display:none -> 0x0 at (0, 0).
  // Must NOT add (+250, +20) and teleport to (250, 20); returns 0x0 so Base UI marks anchorHidden.
  state.left = 0;
  state.top = 0;
  state.width = 0;
  state.height = 0;
  const hidden = anchor.getBoundingClientRect();
  assert.equal(hidden.left, 0);
  assert.equal(hidden.top, 0);
  assert.equal(hidden.width, 0);
  assert.equal(hidden.height, 0);
});

test("capturePointAnchor places keyboard (0, 0) context menu inside a laid-out element and falls back when absent/detached", () => {
  const { element, state } = fakeElement({ left: 80, top: 200, width: 240, height: 36 });
  const keyboardAnchor = capturePointAnchor(0, 0, element);
  assert.equal(keyboardAnchor.getBoundingClientRect().left, 92);
  assert.equal(keyboardAnchor.getBoundingClientRect().top, 212);
  state.top = 160;
  assert.equal(keyboardAnchor.getBoundingClientRect().top, 172);

  const withoutEl = capturePointAnchor(80, 140, null);
  assert.equal(withoutEl.contextElement, undefined);
  assert.equal(withoutEl.getBoundingClientRect().left, 80);
  assert.equal(withoutEl.getBoundingClientRect().top, 140);
  assert.equal(withoutEl.getBoundingClientRect().width, 1);

  const { element: detachedEl } = fakeElement({ left: 10, top: 20, connected: false });
  const fallback = capturePointAnchor(80, 140, detachedEl);
  assert.equal(fallback.contextElement, undefined);
  assert.equal(fallback.getBoundingClientRect().left, 80);
  assert.equal(fallback.getBoundingClientRect().top, 140);
});
