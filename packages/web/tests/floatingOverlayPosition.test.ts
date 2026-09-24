import assert from "node:assert/strict";
import test from "node:test";
import { FLOATING_OVERLAY_VIEWPORT_PADDING, placeFloatingOverlay } from "../src/components/ui/floatingOverlayPosition";

test("floating overlay flips left and upward from a bottom-right point anchor", () => {
  const position = placeFloatingOverlay({
    anchor: { x: 390, y: 290 },
    floatingSize: { width: 160, height: 120 },
    viewport: { width: 400, height: 300 },
  });

  assert.equal(position.x, 230);
  assert.equal(position.y, 170);
});

test("floating overlay shifts back inside viewport when no side has enough room", () => {
  const position = placeFloatingOverlay({
    anchor: { x: -20, y: -30 },
    floatingSize: { width: 120, height: 80 },
    viewport: { width: 100, height: 90 },
  });

  assert.deepEqual(position, {
    x: FLOATING_OVERLAY_VIEWPORT_PADDING,
    y: FLOATING_OVERLAY_VIEWPORT_PADDING,
    maxWidth: 84,
    maxHeight: 74,
  });
});

test("floating overlay respects visual viewport offsets", () => {
  const position = placeFloatingOverlay({
    anchor: { x: 520, y: 420 },
    floatingSize: { width: 180, height: 140 },
    viewport: { width: 500, height: 400, offsetLeft: 40, offsetTop: 20 },
  });

  assert.equal(position.x, 340);
  assert.equal(position.y, 280);
  assert.equal(position.maxWidth, 484);
  assert.equal(position.maxHeight, 384);
});
