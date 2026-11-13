import assert from "node:assert/strict";
import {
  findSidebarDndContainer,
  isPointerWithinSidebarDndBounds,
  isSidebarDndData,
  moveSidebarDndItem,
  nextSidebarDndReservedHeight,
  sidebarDndNeedsReservedHeightMeasure,
  replaceSidebarSubsetOrder,
  resolveSidebarDndRetainedContainer,
  SIDEBAR_DND_DROP_INDEX_KEY,
  sidebarDndCollisionDropIndex,
  sidebarDndContainerDropIndex,
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

test("retains the live projected container, not drag-start geometry, off valid targets", () => {
  const snapshot: SidebarDndProjection = {
    channels: ["channel:a"],
    pinned: [],
  };
  const projected = moveSidebarDndItem(snapshot, "channel:a", "pinned", 0);

  // Once the item was projected into (formerly empty) Pinned, crossing a gap or
  // an invalid section must keep it there. Snapping back to the drag-start
  // container would regrow Pinned under the pointer and re-trigger the move.
  assert.equal(resolveSidebarDndRetainedContainer(projected, snapshot, "channel:a"), "pinned");
  // Before any projection the drag-start container is retained.
  assert.equal(resolveSidebarDndRetainedContainer(null, snapshot, "channel:a"), "channels");
  assert.equal(resolveSidebarDndRetainedContainer(snapshot, snapshot, "channel:a"), "channels");
  assert.equal(resolveSidebarDndRetainedContainer(null, null, "channel:a"), null);
  assert.equal(resolveSidebarDndRetainedContainer(projected, snapshot, "channel:missing"), null);
});

test("drop zones keep their tallest drag height so projection cannot move the pointer onto a valid neighbour", () => {
  // Geometry model of the valid-neighbour ping-pong: Pinned (empty, 2-line
  // hint) sits above a valid custom section; the pointer enters Pinned's lower
  // band. Projecting the row in swaps the 48px hint for a 30px row.
  const HEADER = 40; // mt-3 + h-6 + mb-1 between Pinned's zone and the next zone
  const pinnedTop = 100;
  const pointerY = pinnedTop + 45;
  const zoneUnderPointer = (pinnedHeight: number) => {
    if (pointerY < pinnedTop + pinnedHeight) return "pinned";
    return pointerY < pinnedTop + pinnedHeight + HEADER ? "header" : "custom";
  };
  // The row also leaves a section above Pinned, pulling Pinned up by 30px.
  const shiftedPointer = (pinnedHeight: number, shift: number) => (
    pointerY + shift < pinnedTop + pinnedHeight + HEADER ? "pinned-or-header" : "custom"
  );

  let reserved = nextSidebarDndReservedHeight(true, null, 48);
  assert.equal(zoneUnderPointer(48), "pinned");
  // Unreserved: hint -> row shrink plus the 30px pull-up lands on custom.
  assert.equal(shiftedPointer(30, 30), "custom");
  // Reserved: Pinned keeps 48px, and the source above keeps its height too.
  reserved = nextSidebarDndReservedHeight(true, reserved, 30);
  assert.equal(reserved, 48);
  const sourceReserved = nextSidebarDndReservedHeight(true, 60, 30);
  assert.equal(sourceReserved, 60);
  assert.equal(zoneUnderPointer(reserved), "pinned");
  // Heights only ratchet up mid-drag, and are released when the drag ends.
  assert.equal(nextSidebarDndReservedHeight(true, reserved, 80), 80);
  assert.equal(nextSidebarDndReservedHeight(false, 80, 30), null);
});

test("retains the projection only while the pointer is inside the sidebar section list", () => {
  const rects = [
    { top: 100, bottom: 180, left: 0, right: 240 }, // Pinned block
    { top: 192, bottom: 260, left: 0, right: 240 }, // Joint block, after a 12px gap
    { top: 272, bottom: 700, left: 0, right: 240 }, // Channels block
  ];
  assert.equal(isPointerWithinSidebarDndBounds({ x: 120, y: 150 }, rects), true);
  // The inter-section gap is inside the list: retained, not snapped.
  assert.equal(isPointerWithinSidebarDndBounds({ x: 120, y: 186 }, rects), true);
  // Past the last section (e.g. dragged beyond an auto-scrolled bottom edge)
  // or beside the sidebar: outside, so the nearest valid container applies.
  assert.equal(isPointerWithinSidebarDndBounds({ x: 120, y: 929 }, rects), false);
  assert.equal(isPointerWithinSidebarDndBounds({ x: 600, y: 150 }, rects), false);
  assert.equal(isPointerWithinSidebarDndBounds({ x: 120, y: 150 }, []), false);
});

test("a drop zone measures itself only during an item drag or while a height is reserved (web perf)", () => {
  assert.equal(sidebarDndNeedsReservedHeightMeasure(false, null), false, "an ordinary render forces no layout");
  assert.equal(sidebarDndNeedsReservedHeightMeasure(true, null), true);
  assert.equal(sidebarDndNeedsReservedHeightMeasure(false, 48), true, "a drag just ended: release the reserved height");
  // The skipped case is exactly the one whose answer is "no reservation".
  assert.equal(nextSidebarDndReservedHeight(false, null, 123), null);
});

test("a row dropped in the 8px band under another section's heading goes first, not last", () => {
  // The pinned section's drop zone: py-2 (8px) above its first row, 38px rows
  // 2px apart, 8px below the last (raft-design patterns/lists.md).
  const pinned = "pinned";
  const row = (itemId: string, top: number) => ({
    data: { type: "item", containerId: pinned, itemId },
    rect: { top, bottom: top + 38 },
  });
  const rows = [
    { data: { type: "container", containerId: pinned, kind: "pinned", manual: true }, rect: { top: 100, bottom: 224 } },
    row("channel:c", 108),
    row("channel:d", 148),
    row("channel:e", 188),
    // A row of another section, and the dragged row itself, never count.
    { data: { type: "item", containerId: "channels", itemId: "channel:a" }, rect: { top: 20, bottom: 58 } },
    { data: { type: "item", containerId: pinned, itemId: "channel:b" }, rect: { top: 20, bottom: 58 } },
  ];
  const projection: SidebarDndProjection = {
    channels: ["channel:a", "channel:b"],
    pinned: ["channel:c", "channel:d", "channel:e"],
  };
  const dropAt = (pointerY: number) => {
    const index = sidebarDndContainerDropIndex(pinned, "channel:b", pointerY, rows);
    // What the drag handlers read back off dnd-kit's collision.
    const collisions = [{ id: "sidebar:pinned", data: { [SIDEBAR_DND_DROP_INDEX_KEY]: index } }];
    const read = sidebarDndCollisionDropIndex(collisions, "sidebar:pinned");
    return moveSidebarDndItem(projection, "channel:b", pinned, read ?? projection.pinned.length).pinned;
  };

  assert.deepEqual(dropAt(104), ["channel:b", "channel:c", "channel:d", "channel:e"], "the top band: first");
  assert.deepEqual(dropAt(147), ["channel:c", "channel:b", "channel:d", "channel:e"], "the 2px gap: between the two rows");
  assert.deepEqual(dropAt(230), ["channel:c", "channel:d", "channel:e", "channel:b"], "the bottom band: last");
  assert.equal(sidebarDndContainerDropIndex(pinned, "channel:b", undefined, rows), null, "a keyboard drag has no pointer");
  assert.equal(sidebarDndCollisionDropIndex([{ id: "other", data: {} }], "sidebar:pinned"), null);
});
