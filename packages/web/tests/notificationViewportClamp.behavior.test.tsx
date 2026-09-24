import assert from "node:assert/strict";
import test from "node:test";
import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import {
  calculateViewportClampStyle,
  useViewportClamp,
} from "../src/components/layout/useViewportClamp.js";

const triggerRect = {
  top: 700,
  left: 24,
  right: 64,
  bottom: 740,
  width: 40,
  height: 40,
};

test("right-side popover repositions when measured height changes", () => {
  const tall = calculateViewportClampStyle({
    triggerRect,
    popoverRect: { top: 0, left: 0, right: 0, bottom: 0, width: 320, height: 260 },
    viewport: { width: 1024, height: 800 },
    placement: "right",
    gutter: 8,
  });

  const compact = calculateViewportClampStyle({
    triggerRect,
    popoverRect: { top: 0, left: 0, right: 0, bottom: 0, width: 320, height: 120 },
    viewport: { width: 1024, height: 800 },
    placement: "right",
    gutter: 8,
  });

  assert.equal(tall.top, 480);
  assert.equal(compact.top, 620);
  assert.equal(Number(compact.top) + 120, triggerRect.bottom);
});

test("notification popup remeasures when observed content changes size", () => {
  let popoverHeight = 260;
  let observed: Element | undefined;
  let resize: ResizeObserverCallback | undefined;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe(target: Element) {
        observed = target;
      }
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

  const trigger = { getBoundingClientRect: () => triggerRect } as HTMLElement;
  const popover = {
    getBoundingClientRect: () => ({ ...triggerRect, width: 320, height: popoverHeight }),
  } as HTMLElement;
  const triggerRef = { current: trigger } as RefObject<HTMLElement | null>;
  const popoverRef = { current: popover } as RefObject<HTMLElement | null>;
  const { result, unmount } = renderHook(() =>
    useViewportClamp({ triggerRef, popoverRef, placement: "right", open: true }),
  );

  assert.equal(result.current.style.top, 480);
  assert.equal(observed, popover);

  popoverHeight = 120;
  act(() => resize?.([], {} as ResizeObserver));
  assert.equal(result.current.style.top, 620);
  unmount();
});
