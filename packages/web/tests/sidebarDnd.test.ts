import assert from "node:assert/strict";
import test from "node:test";
import {
  findSidebarDndContainer,
  isSidebarDndData,
  moveSidebarDndItem,
  replaceSidebarSubsetOrder,
  SIDEBAR_CHANNELS_CONTAINER_ID,
  sidebarCustomContainerId,
  sidebarCustomSectionId,
} from "../src/components/layout/sidebarDnd";
import type { SidebarDndProjection } from "../src/components/layout/sidebarDnd";

test("sidebar DnD data excludes section-level sortable metadata", () => {
  assert.equal(isSidebarDndData({ sortable: { index: 0 } }), false);
  assert.equal(isSidebarDndData({ type: "item", itemId: "channel:1" }), false);
  assert.equal(isSidebarDndData({
    type: "item",
    itemId: "channel:1",
    containerId: SIDEBAR_CHANNELS_CONTAINER_ID,
  }), true);
});

test("moves an item between sidebar containers at the requested position", () => {
  const projection: SidebarDndProjection = {
    channels: ["channel:a", "channel:b"],
    pinned: ["channel:c", "channel:d"],
  };

  const next = moveSidebarDndItem(projection, "channel:b", "pinned", 1);

  assert.deepEqual(next, {
    channels: ["channel:a"],
    pinned: ["channel:c", "channel:b", "channel:d"],
  });
  assert.equal(findSidebarDndContainer(next, "channel:b"), "pinned");
  assert.deepEqual(projection.channels, ["channel:a", "channel:b"]);
});

test("reorders an item within one sidebar container", () => {
  const projection: SidebarDndProjection = {
    pinned: ["channel:a", "channel:b", "channel:c"],
  };

  assert.deepEqual(
    moveSidebarDndItem(projection, "channel:a", "pinned", 2),
    { pinned: ["channel:b", "channel:c", "channel:a"] },
  );
});

test("preserves non-subset positions while replacing a manual order", () => {
  assert.deepEqual(
    replaceSidebarSubsetOrder(
      ["all", "channel:a", "joint:a", "channel:b", "hidden"],
      ["channel:a", "channel:b"],
      ["channel:b", "channel:a"],
    ),
    ["all", "channel:b", "joint:a", "channel:a", "hidden"],
  );
});

test("round-trips custom container ids", () => {
  const containerId = sidebarCustomContainerId("section-1");
  assert.equal(sidebarCustomSectionId(containerId), "section-1");
  assert.equal(sidebarCustomSectionId("sidebar:container:pinned"), null);
});
