import assert from "node:assert/strict";
import { ROW_SWIPE_EDGE_ZONE } from "../src/hooks/useRowSwipe";
import {
  overflowXScrolls,
  scrollsSideways,
  startsInScreenEdgeZone,
  TIME_REVEAL_DISTANCE,
  TIME_REVEAL_EDGE_ZONE,
  TIME_REVEAL_MAX,
  TIME_REVEAL_RUBBER_BAND,
  TIME_REVEAL_SETTLE_MS,
  timeRevealOffset,
} from "../src/components/message/useTimelineTimeReveal";

// Drag the conversation left on a touch screen to see every message's time
// (raft-design Conversation and Responsive layout › Touch screens; artin,
// 2026-11-04, #triage:530f8c36): the distances, the screen edges and which
// sideways scrollers keep their drag.

test("the rows follow the finger 1:1 up to 64px, then at 0.55, and stop at 88px", () => {
  assert.equal(TIME_REVEAL_DISTANCE, 64);
  assert.equal(TIME_REVEAL_RUBBER_BAND, 0.55);
  assert.equal(TIME_REVEAL_MAX, 88);
  assert.equal(timeRevealOffset(0), 0);
  assert.equal(timeRevealOffset(30), 30);
  assert.equal(timeRevealOffset(64), 64);
  assert.ok(Math.abs(timeRevealOffset(80) - (64 + 16 * 0.55)) < 1e-9, "past 64px the rubber band");
  assert.equal(timeRevealOffset(200), 88, "capped");
  assert.equal(timeRevealOffset(10_000), 88);
});

test("a finger back to the right of where the drag was claimed leaves the rows at rest", () => {
  assert.equal(timeRevealOffset(-12), 0);
  assert.equal(timeRevealOffset(Number.NaN), 0);
});

test("the offset never jumps and never goes back as the finger goes on", () => {
  let previous = 0;
  for (let pulled = 0; pulled <= 160; pulled += 0.5) {
    const offset = timeRevealOffset(pulled);
    assert.ok(offset >= previous, `monotonic at ${pulled}px`);
    assert.ok(offset - previous <= 0.5 + 1e-9, `continuous at ${pulled}px`);
    previous = offset;
  }
});

test("a drag that starts within 24px of either screen edge is the system's", () => {
  assert.equal(TIME_REVEAL_EDGE_ZONE, ROW_SWIPE_EDGE_ZONE, "the same zone as a row swipe");
  assert.equal(TIME_REVEAL_EDGE_ZONE, 24);
  const width = 390;
  assert.equal(startsInScreenEdgeZone(0, width), true);
  assert.equal(startsInScreenEdgeZone(23.5, width), true);
  assert.equal(startsInScreenEdgeZone(24, width), false);
  assert.equal(startsInScreenEdgeZone(195, width), false);
  assert.equal(startsInScreenEdgeZone(width - 24, width), false);
  assert.equal(startsInScreenEdgeZone(width - 23.5, width), true);
  assert.equal(startsInScreenEdgeZone(width, width), true);
  // A tablet: the zone is the same 24px, not a share of the width.
  assert.equal(startsInScreenEdgeZone(40, 1024), false);
  assert.equal(startsInScreenEdgeZone(1010, 1024), true);
});

test("only a sideways scroller with something to scroll keeps its drag", () => {
  assert.equal(scrollsSideways({ overflowX: "auto", scrollWidth: 900, clientWidth: 320 }), true, "a wide table");
  assert.equal(scrollsSideways({ overflowX: "scroll", scrollWidth: 900, clientWidth: 320 }), true);
  assert.equal(scrollsSideways({ overflowX: "overlay", scrollWidth: 900, clientWidth: 320 }), true);
  assert.equal(scrollsSideways({ overflowX: "auto", scrollWidth: 320, clientWidth: 320 }), false, "a table that fits");
  assert.equal(scrollsSideways({ overflowX: "auto", scrollWidth: 321, clientWidth: 320 }), false, "a 1px rounding is no overflow");
  assert.equal(scrollsSideways({ overflowX: "hidden", scrollWidth: 900, clientWidth: 320 }), false, "no finger scrolls a hidden overflow (the list itself)");
  assert.equal(scrollsSideways({ overflowX: "clip", scrollWidth: 900, clientWidth: 320 }), false);
  assert.equal(scrollsSideways({ overflowX: "visible", scrollWidth: 900, clientWidth: 320 }), false);
  assert.equal(overflowXScrolls("auto"), true);
  assert.equal(overflowXScrolls("hidden"), false);
});

test("the spring back takes raft-ui's drag settle time", () => {
  // raft-ui foundation.css: --motion-drag-settle-duration: 160ms (index.css uses the token itself).
  assert.equal(TIME_REVEAL_SETTLE_MS, 160);
});
