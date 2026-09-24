import assert from "node:assert/strict";
import test from "node:test";
import { devOverlayPlacementToPosition, parseDevOverlayPlacement, snapDevOverlayToEdge } from "../src/components/dev/devOverlayPosition";

const viewport = { width: 390, height: 844 };
const overlay = { width: 90, height: 32 };
const insets = { top: 20, right: 0, bottom: 90, left: 0 };

test("edge placement stays inside mobile safe areas", () => {
  assert.deepEqual(devOverlayPlacementToPosition({ placement: { edge: "right", ratio: 1, collapsed: true }, viewport, overlay, insets }), { left: 292, top: 714 });
  assert.deepEqual(devOverlayPlacementToPosition({ placement: { edge: "bottom", ratio: 0.5, collapsed: true }, viewport, overlay, insets }), { left: 150, top: 714 });
});

test("release snaps to the nearest edge and collapses", () => {
  const placement = snapDevOverlayToEdge({ rect: { left: 12, top: 300, width: 90, height: 32 }, viewport, insets });
  assert.equal(placement.edge, "left");
  assert.equal(placement.collapsed, true);
  assert.ok(placement.ratio >= 0 && placement.ratio <= 1);
});

test("persisted placement accepts legacy data and preserves collapsed state", () => {
  assert.deepEqual(parseDevOverlayPlacement(JSON.stringify({ edge: "left", ratio: 0.75 })), { edge: "left", ratio: 0.75, collapsed: false });
  assert.deepEqual(parseDevOverlayPlacement(JSON.stringify({ edge: "right", ratio: 4, collapsed: true })), { edge: "right", ratio: 1, collapsed: true });
  assert.equal(parseDevOverlayPlacement(JSON.stringify({ edge: "center", ratio: 0.5 })), null);
});
