import assert from "node:assert/strict";
import { DECOR_TOP_GAP_PX, DECOR_TOP_STRIP_PX, SEARCH_MAX_PX, elasticSearchWidth, frameDecorTop, leftOverRoom, searchBaseWidth, trailingRoomAtBase } from "../src/components/topbar/useElasticSearch";

// Task #773: the top bar's search field takes the room its side regions leave
// over, both sides at once (it stays centred), up to its maximum.

test("the base width is raft-ui's clamp(360px, 32vw, 520px)", () => {
  assert.equal(searchBaseWidth(800), 360);
  assert.equal(searchBaseWidth(1280), 409.6);
  assert.equal(searchBaseWidth(2000), 520);
});

test("the field grows by the smaller side's room, twice over, up to its maximum", () => {
  assert.equal(elasticSearchWidth(400, 400, 30, 300), 460, "30px each side");
  assert.equal(elasticSearchWidth(400, 400, 300, 30), 460, "the smaller side decides");
  assert.equal(elasticSearchWidth(400, 400, 300, 300), SEARCH_MAX_PX, "never past the maximum");
  assert.equal(elasticSearchWidth(400, 400, 0, 300), 400, "no room: the base width");
  assert.equal(elasticSearchWidth(400, 400, -12, 300), 400, "overflowing content never shrinks it below the base");
});

test("measuring again after growing gives the same width", () => {
  // Having grown by 60, each region has 30px less room.
  const first = elasticSearchWidth(400, 400, 30, 300);
  assert.equal(elasticSearchWidth(400, first, 0, 270), first);
  // The window narrowed by 20px: each side has 10px less, the field 20px less.
  assert.equal(elasticSearchWidth(400, first, -10, 260), first - 20);
});

test("a region's room counts only the items in its row", () => {
  const trigger = { width: 80, inFlow: true };
  const bell = { width: 36, inFlow: true };
  assert.equal(leftOverRoom(300, [trigger, bell], 8), 176);
  // An open popover puts a 1px fixed focus guard on each side of its trigger:
  // the room, and so the search field, must not change.
  const guard = { width: 1, inFlow: false };
  assert.equal(leftOverRoom(300, [guard, trigger, guard, bell], 8), 176);
  assert.equal(leftOverRoom(300, [{ width: 0, inFlow: true }, trigger, bell], 8), 176, "an empty item takes no gap");
});

// Task #174: the theme's top strip sits between the field and the trailing
// actions, 16px clear of each, or not at all.
test("the strip ends its gap before the trailing actions, counted inside the reserved corner", () => {
  // Region's right edge at 1142 (a 1280px window less 138px of caption buttons),
  // its first item at 1050: raft-ui adds the 138px itself.
  assert.deepEqual(frameDecorTop(1142, 1050, 700), { endPx: 92 + DECOR_TOP_GAP_PX, fits: true });
});

test("the strip is dropped unless all of it, with a gap on both sides, fits", () => {
  const whole = DECOR_TOP_STRIP_PX + 2 * DECOR_TOP_GAP_PX;
  assert.equal(frameDecorTop(1280, 1000, 1000 - whole).fits, true, "exactly room for it");
  assert.equal(frameDecorTop(1280, 1000, 1000 - whole + 1).fits, false, "1px short: no half strip");
});

// The web's Update button reads the right region's room with the field at its
// base, to give up its label before the region's items run over the field.
test("the trailing room counts what the field took beyond its base, so it does not depend on the field having grown", () => {
  assert.equal(trailingRoomAtBase(0, 460, 400), 30, "the field grew 60: 30 of it on this side");
  assert.equal(trailingRoomAtBase(30, 400, 400), 30, "the same room before it grew");
  assert.equal(trailingRoomAtBase(-12, 360, 360), -12, "items run over the field's base");
});
