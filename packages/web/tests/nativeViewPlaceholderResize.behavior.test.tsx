// The desktop web preview's native view follows its placeholder in the same
// frame on a resize (#proj-deskop:#14): the placeholder's box is reported the
// moment it or the window resizes, not a frame later. Waiting for the next
// animation frame left the native view a frame or two behind the placeholder
// while the window was dragged. Scrolls still report once a frame.
import assert from "node:assert/strict";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, test } from "vitest";
import type { DesktopWebPreviewBounds } from "@botiverse/raft-shared";

import { useNativeViewPlaceholder } from "../src/features/webPreview/useNativeViewPlaceholder";

let observers: Array<() => void> = [];
let frames: Array<FrameRequestCallback> = [];
const realResizeObserver = globalThis.ResizeObserver;
const realRequestAnimationFrame = globalThis.requestAnimationFrame;

beforeEach(() => {
  observers = [];
  frames = [];
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      observers.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => frames.push(callback);
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = realResizeObserver;
  globalThis.requestAnimationFrame = realRequestAnimationFrame;
});

function setup() {
  const element = document.createElement("div");
  document.body.append(element);
  let box = { left: 10, top: 20, width: 300, height: 200 };
  element.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON() {} }) as DOMRect;
  const sent: DesktopWebPreviewBounds[] = [];
  const view = { setBounds: (bounds: DesktopWebPreviewBounds) => void sent.push(bounds), setVisible: async () => null };
  renderHook(() => useNativeViewPlaceholder({ current: element }, view));
  return {
    sent,
    resizeTo(width: number) {
      box = { ...box, width };
    },
  };
}

test("a resize of the placeholder is reported in the same frame", () => {
  const { sent, resizeTo } = setup();
  assert.equal(sent.length, 1);
  resizeTo(420);
  for (const observer of observers) observer();
  assert.deepEqual(sent.at(-1), { x: 10, y: 20, width: 420, height: 200 });
  assert.equal(frames.length, 0);
});

test("a resize of the window is reported in the same frame", () => {
  const { sent, resizeTo } = setup();
  resizeTo(512);
  window.dispatchEvent(new window.Event("resize"));
  assert.deepEqual(sent.at(-1), { x: 10, y: 20, width: 512, height: 200 });
  assert.equal(frames.length, 0);
});

test("scrolls still report once a frame", () => {
  const { sent } = setup();
  window.dispatchEvent(new window.Event("scroll"));
  window.dispatchEvent(new window.Event("scroll"));
  assert.equal(sent.length, 1);
  assert.equal(frames.length, 1);
  frames[0]!(0);
  assert.equal(sent.length, 2);
});
