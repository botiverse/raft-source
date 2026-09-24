import assert from "node:assert/strict";
import test from "node:test";
import { calculateViewportClampStyle } from "../src/components/layout/useViewportClamp.js";

// Trigger sits in the middle of the viewport horizontally, with plenty of room
// both above and below.
const centeredTrigger = {
  top: 400,
  left: 480,
  right: 520,
  bottom: 416,
  width: 40,
  height: 16,
};

const popoverRect = {
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 280,
  height: 120,
};

const viewport = { width: 1024, height: 800 };

test("vertical-smart places popover below the trigger when there's room below", () => {
  const result = calculateViewportClampStyle({
    triggerRect: centeredTrigger,
    popoverRect,
    viewport,
    placement: "vertical-smart",
    gutter: 6,
  });

  // spaceBelow = 800 - 416 = 384 >= 120+6 → place below.
  assert.equal(result.top, centeredTrigger.bottom + 6);

  // Centered horizontally on the trigger: trigger center = 500, popover
  // half-width = 140 → left = 360.
  const expectedLeft = centeredTrigger.left + centeredTrigger.width / 2 - popoverRect.width / 2;
  assert.equal(result.left, expectedLeft);
});

test("vertical-smart flips above when there's no room below", () => {
  const triggerNearBottom = {
    top: 740,
    left: 480,
    right: 520,
    bottom: 760,
    width: 40,
    height: 20,
  };

  const result = calculateViewportClampStyle({
    triggerRect: triggerNearBottom,
    popoverRect,
    viewport,
    placement: "vertical-smart",
    gutter: 6,
  });

  // spaceBelow = 800 - 760 = 40 < 126; spaceAbove = 740 > 40 → flip above.
  // top = trigger.top - popover.height - gutter = 740 - 120 - 6 = 614.
  assert.equal(result.top, 614);
});

test("vertical-smart clamps horizontal overflow on the left", () => {
  const triggerNearLeft = {
    top: 400,
    left: 8,
    right: 48,
    bottom: 416,
    width: 40,
    height: 16,
  };

  const result = calculateViewportClampStyle({
    triggerRect: triggerNearLeft,
    popoverRect,
    viewport,
    placement: "vertical-smart",
    gutter: 8,
  });

  // Centered would be 28 - 140 = -112. Clamp to gutter (8).
  assert.equal(result.left, 8);
});

test("vertical-smart clamps horizontal overflow on the right", () => {
  const triggerNearRight = {
    top: 400,
    left: 980,
    right: 1020,
    bottom: 416,
    width: 40,
    height: 16,
  };

  const result = calculateViewportClampStyle({
    triggerRect: triggerNearRight,
    popoverRect,
    viewport,
    placement: "vertical-smart",
    gutter: 8,
  });

  // Centered would be 1000 - 140 = 860. viewport - popover - gutter = 1024 - 280 - 8 = 736.
  assert.equal(result.left, 736);
});

test("vertical-smart picks the side with more room when neither fully fits", () => {
  // Both sides too small for the popover; the side with more space wins.
  const triggerSandwiched = {
    top: 80,
    left: 480,
    right: 520,
    bottom: 96,
    width: 40,
    height: 16,
  };

  const tallPopover = {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 280,
    height: 700,
  };

  const result = calculateViewportClampStyle({
    triggerRect: triggerSandwiched,
    popoverRect: tallPopover,
    viewport,
    placement: "vertical-smart",
    gutter: 6,
  });

  // spaceAbove = 80; spaceBelow = 800 - 96 = 704. Neither fits a 700-tall
  // popover within the gutter, but spaceBelow > spaceAbove so place below.
  assert.equal(result.top, triggerSandwiched.bottom + 6);
});
