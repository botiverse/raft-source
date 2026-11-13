import assert from "node:assert/strict";
import { STRIP_SLOT_PX, reorderAfterDrag, stripCapacity, stripFreePx, stripItems } from "../src/components/topbar/workspaceStripLayout";
import { NAME_GLOBE_PX, switcherFloorPx } from "../src/components/topbar/useStripLayout";

// Task #140: title-bar workspace strip — space decides the count, switcher order
// decides which, the current workspace is always visible, drag edits one order.

const ws = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}` }));

test("capacity follows the free width with no fixed cap; fewer than two never shows", () => {
  assert.equal(stripCapacity(STRIP_SLOT_PX * 3 + 5, 7, STRIP_SLOT_PX), 3);
  assert.equal(stripCapacity(STRIP_SLOT_PX * 12, 20, STRIP_SLOT_PX), 12, "no cap: a wide sidebar shows more");
  assert.equal(stripCapacity(STRIP_SLOT_PX * 12, 4, STRIP_SLOT_PX), 4, "never more than there are");
  assert.equal(stripCapacity(STRIP_SLOT_PX * 1.9, 7, STRIP_SLOT_PX), 0, "one avatar alone is hidden");
  assert.equal(stripCapacity(STRIP_SLOT_PX * 5, 1, STRIP_SLOT_PX), 0, "a single workspace needs no switcher");
  assert.equal(stripCapacity(0, 7, STRIP_SLOT_PX), 0);
});

test("the strip fills the span: no spare slot before the history controls", () => {
  // n avatars (the DS 32px IconButton) take 8 (lead) + 32n + 4(n-1) px,
  // plus the 5px divider an out-of-range current workspace brings. They fit
  // exactly when the span equals that, and one pixel less drops the last one.
  const span = (n: number) => 8 + 32 * n + 4 * (n - 1) + 5;
  for (const n of [2, 5, 9]) {
    assert.equal(stripCapacity(stripFreePx(span(n)), 20, STRIP_SLOT_PX), n, `${n} fit in exactly their width`);
    assert.equal(stripCapacity(stripFreePx(span(n) - 1), 20, STRIP_SLOT_PX), n - 1 < 2 ? 0 : n - 1);
  }
  assert.equal(stripFreePx(0), 0);
});

test("the slot is the avatar as rendered: 34px desktop-density avatars never count as 32", () => {
  // macOS strip-many smoke (7 servers, 1280px): an 83.2px span held two 32px
  // avatars (81px) but not the 34px ones raft-ui renders with a mouse (85px),
  // and the strip pushed ‹ › 1.8px past their region.
  const slot = 34 + 4;
  const span = (n: number) => 8 + 34 * n + 4 * (n - 1) + 5;
  assert.equal(stripCapacity(stripFreePx(83.2), 7, STRIP_SLOT_PX), 2, "the old 32px count");
  assert.equal(stripCapacity(stripFreePx(83.2), 7, slot), 0);
  for (const n of [2, 5, 9]) {
    assert.equal(stripCapacity(stripFreePx(span(n)), 20, slot), n, `${n} fit in exactly their width`);
    assert.equal(stripCapacity(stripFreePx(span(n) - 1), 20, slot), n - 1 < 2 ? 0 : n - 1);
  }
});

test("items are the first N in switcher order; a current workspace beyond them takes the last slot", () => {
  assert.deepEqual(stripItems(ws(7), "s2", 3), { items: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], currentOutside: false });
  assert.deepEqual(stripItems(ws(7), "s6", 3), { items: [{ id: "s1" }, { id: "s2" }, { id: "s6" }], currentOutside: true });
  assert.deepEqual(stripItems(ws(7), null, 2).items.map((s) => s.id), ["s1", "s2"]);
  assert.deepEqual(stripItems(ws(7), "s1", 0), { items: [], currentOutside: false });
});

test("dragging moves one id within the single shared order and clamps at the ends", () => {
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(reorderAfterDrag(order, 1, 2), ["a", "c", "d", "b", "e"]);
  assert.deepEqual(reorderAfterDrag(order, 3, -3), ["d", "a", "b", "c", "e"]);
  assert.deepEqual(reorderAfterDrag(order, 0, 99), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(reorderAfterDrag(order, 2, 0), order);
  assert.notEqual(reorderAfterDrag(order, 2, 0), order, "always a new array");
});

// The public-page globe sits inside the name's cap (WAWQAQ,
// #proj-frontend:9e1b4abd): the slot is sized from the whole list, globes
// included, so it is the same whichever workspace is current.
test("the name slot counts a public workspace's globe, from the list alone", async () => {
  const { NAME_GLOBE_PX, widestLabelPx } = await import("../src/components/topbar/useStripLayout");
  const textPx = (text: string) => text.length * 10;
  const list = [
    { name: "Dev", publicPageLive: true },
    { name: "Partner", publicPageLive: false },
  ];
  // "Dev" (30) + globe (21) = 51 < "Partner" (70): the private name is widest.
  assert.equal(widestLabelPx(list, textPx), 70);
  // A long public name: its globe counts.
  assert.equal(
    widestLabelPx([...list, { name: "Botiverse", publicPageLive: true }], textPx),
    90 + NAME_GLOBE_PX,
  );
  // Order (which is current, which is first) changes nothing.
  assert.equal(widestLabelPx([...list].reverse(), textPx), widestLabelPx(list, textPx));
});

test("the switcher's floor is everything but the name's text: box, avatar, globe, chevron and the gaps", () => {
  // Task #161: raft-ui's WorkspaceButton as measured in the desktop smoke
  // (10px padding + 1px border each side, a 27px avatar, 8px gaps, a 16px
  // chevron pulled in by its -4px margin). The name truncates, so it adds no
  // width, but it still takes its gaps: two in the button (avatar | label |
  // chevron).
  assert.equal(switcherFloorPx({ boxPx: 22, partsPx: [27, 12], gapsPx: 16 }), 77);
  // A public workspace: the label group holds the name and the 13px globe
  // with its own 8px gap. The globe does not truncate, so it counts once,
  // with that gap: NAME_GLOBE_PX more than a private one.
  assert.equal(switcherFloorPx({ boxPx: 22, partsPx: [27, 12, 13], gapsPx: 16 + 8 }), 77 + NAME_GLOBE_PX);
  assert.equal(switcherFloorPx({ boxPx: 22.5, partsPx: [27, 12], gapsPx: 16 }), 78, "rounds up: a floor a fraction short still overflows");
});
