import assert from "node:assert/strict";
import test from "node:test";

import { BLANK_UNIFORM_SHARE, isBlank, phoneOverflowOf } from "../src/pageChecks";
import { isPng, uniformShare } from "../src/png";
import { makePng, SPLIT_PNG, WHITE_PNG } from "./fakes";

/** The blank and sideways-scrolling findings (src/pageChecks.ts) and the PNG reader behind blank (src/png.ts). */

test("blank: no text and a uniform shot; text, a busy shot or an unknown share is not blank", () => {
  assert.equal(isBlank(0, 1), true);
  assert.equal(isBlank(0, BLANK_UNIFORM_SHARE), true);
  assert.equal(isBlank(0, 0.5), false, "a picture or a canvas, no text");
  assert.equal(isBlank(12, 1), false, "white-on-white text");
  assert.equal(isBlank(0, null), false);
});

test("phone overflow: content wider than the window by more than a pixel of rounding", () => {
  assert.deepEqual(phoneOverflowOf({ scrollWidth: 1280, innerWidth: 390 }), { contentWidth: 1280, viewportWidth: 390 });
  assert.equal(phoneOverflowOf({ scrollWidth: 390, innerWidth: 390 }), null);
  assert.equal(phoneOverflowOf({ scrollWidth: 391, innerWidth: 390 }), null);
  assert.deepEqual(phoneOverflowOf({ scrollWidth: 392.4, innerWidth: 390 }), { contentWidth: 392, viewportWidth: 390 });
  assert.equal(phoneOverflowOf({ scrollWidth: Number.NaN, innerWidth: 390 }), null);
  assert.equal(phoneOverflowOf({ scrollWidth: 500, innerWidth: 0 }), null);
});

test("png: a uniform shot is 1, two halves about one half", async () => {
  assert.equal(isPng(WHITE_PNG), true);
  assert.equal(isPng(new TextEncoder().encode("GIF89a....")), false);
  assert.equal(await uniformShare(WHITE_PNG), 1);
  const split = await uniformShare(SPLIT_PNG);
  assert.ok(split !== null && split > 0.4 && split < 0.6, String(split));
});

test("png: every row filter is undone (none, sub, up, average, paeth), RGB and RGBA", async () => {
  for (const channels of [3, 4] as const) {
    const gradient = makePng(50, 30, (x, y) => [x * 5, y * 8, (x + y) % 256, 255], { channels, filterOf: (y) => y % 5 });
    const share = await uniformShare(gradient);
    assert.ok(share !== null && share < 0.2, `a gradient is far from uniform (${share})`);
    const uniform = makePng(50, 30, () => [10, 20, 30, 255], { channels, filterOf: (y) => y % 5 });
    assert.equal(await uniformShare(uniform), 1, `uniform with filters, ${channels} channels`);
  }
  // Mostly one colour, a small mark: above the blank threshold only when tiny.
  const mark = makePng(200, 100, (x, y) => (x < 4 && y < 4 ? [0, 0, 0] : [255, 255, 255]), { filterOf: (y) => (y % 2 ? 4 : 1) });
  const share = await uniformShare(mark);
  assert.ok(share !== null && share >= BLANK_UNIFORM_SHARE, String(share));
});

test("png: what the reader doesn't read is null (never blank)", async () => {
  assert.equal(await uniformShare(new TextEncoder().encode("not a png at all")), null);
  assert.equal(await uniformShare(makePng(4, 4, () => [0, 0, 0], { colorType: 0 })), null, "greyscale");
  assert.equal(await uniformShare(makePng(4, 4, () => [0, 0, 0], { bitDepth: 16 })), null, "16-bit");
  assert.equal(await uniformShare(WHITE_PNG.subarray(0, 40)), null, "cut short");
  const corrupt = new Uint8Array(WHITE_PNG);
  corrupt.fill(0x41, 41, 60);
  assert.equal(await uniformShare(corrupt), null, "IDAT that doesn't inflate");
});
