import assert from "node:assert/strict";
import test from "node:test";
import { placeSidebarContextMenu, placeSidebarContextSubmenu } from "../src/components/layout/sidebarContextMenuPosition";

test("sidebar context menu opens upward from a bottom-edge trigger", () => {
  const position = placeSidebarContextMenu({
    x: 640,
    y: 620,
    menuWidth: 192,
    menuHeight: 226,
    viewportWidth: 700,
    viewportHeight: 650,
  });

  assert.equal(position.x, 448);
  assert.equal(position.y, 394);
});

test("sidebar context menu keeps a viewport margin on very small screens", () => {
  const position = placeSidebarContextMenu({
    x: -20,
    y: -40,
    menuWidth: 192,
    menuHeight: 226,
    viewportWidth: 180,
    viewportHeight: 200,
  });

  assert.deepEqual(position, { x: 8, y: 8 });
});

test("sidebar context submenu opens right when it fits", () => {
  assert.deepEqual(placeSidebarContextSubmenu({
    anchor: { left: 100, right: 320, top: 120 },
    menuWidth: 224,
    menuHeight: 240,
    viewportWidth: 800,
    viewportHeight: 600,
  }), { x: 324, y: 120 });
});

test("sidebar context submenu flips left and clamps vertically", () => {
  assert.deepEqual(placeSidebarContextSubmenu({
    anchor: { left: 500, right: 720, top: 560 },
    menuWidth: 224,
    menuHeight: 240,
    viewportWidth: 800,
    viewportHeight: 600,
  }), { x: 272, y: 352 });
});
