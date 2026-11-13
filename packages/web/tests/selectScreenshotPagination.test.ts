import assert from "node:assert/strict";
import {
  planScreenshotPages,
  ScreenshotPagePlanningError,
} from "../src/utils/selectScreenshotPagination";

test("keeps ordered whole messages together within the preferred-DPR budget", () => {
  const pages = planScreenshotPages([
    { id: "a", cssHeight: 900 },
    { id: "b", cssHeight: 1_100 },
    { id: "c", cssHeight: 1_200 },
  ], {
    cssWidth: 390,
    pageChromeCssHeight: 80,
    preferredPixelRatio: 3,
  });

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.pixelRatio, 3);
  assert.deepEqual(pages[0]?.segments.map((segment) => segment.messageId), ["a", "b", "c"]);
  assert.equal(pages[0]?.cssHeight, 3_280);
});

test("breaks between messages before a page exceeds the output pixel budget", () => {
  const pages = planScreenshotPages([
    { id: "a", cssHeight: 2_000 },
    { id: "b", cssHeight: 2_000 },
    { id: "c", cssHeight: 2_000 },
  ], {
    cssWidth: 390,
    pageChromeCssHeight: 80,
    preferredPixelRatio: 3,
  });

  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => page.segments.map((segment) => segment.messageId)), [
    ["a", "b"],
    ["c"],
  ]);
  for (const page of pages) {
    assert.ok(390 * page.cssHeight * page.pixelRatio * page.pixelRatio <= 16_000_000);
  }
});

test("splits one oversize message into complete ordered continuation slices", () => {
  const pages = planScreenshotPages([
    { id: "long", cssHeight: 11_000 },
  ], {
    cssWidth: 390,
    pageChromeCssHeight: 80,
    continuationChromeCssHeight: 24,
    preferredPixelRatio: 3,
  });

  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => page.pageNumber), [1, 2, 3]);
  assert.ok(pages[0]?.segments[0]?.continuesOnNext);
  assert.ok(pages[1]?.segments[0]?.continuedFromPrevious);
  assert.ok(pages[1]?.segments[0]?.continuesOnNext);
  assert.ok(pages[2]?.segments[0]?.continuedFromPrevious);
  assert.equal(pages[2]?.segments[0]?.continuesOnNext, false);

  const segments = pages.flatMap((page) => page.segments);
  assert.equal(segments[0]?.sourceOffsetTop, 0);
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    assert.equal(current?.sourceOffsetTop, (previous?.sourceOffsetTop ?? 0) + (previous?.cssHeight ?? 0));
  }
  assert.equal(segments.reduce((sum, segment) => sum + segment.cssHeight, 0), 11_000);
  for (const page of pages) {
    assert.ok(390 * page.cssHeight * page.pixelRatio * page.pixelRatio <= 16_000_000);
  }
});

test("uses the highest safe DPR for repeated page chrome", () => {
  const pages = planScreenshotPages([{ id: "a", cssHeight: 10 }], {
    cssWidth: 4_000,
    pageChromeCssHeight: 600,
    preferredPixelRatio: 3,
  });

  assert.equal(pages[0]?.pixelRatio, 2);
  assert.ok(4_000 * (pages[0]?.cssHeight ?? 0) * 4 <= 16_000_000);
});

test("fails instead of planning an over-budget page at 1x", () => {
  assert.throws(() => planScreenshotPages([{ id: "a", cssHeight: 10 }], {
    cssWidth: 20_000,
    pageChromeCssHeight: 1_000,
    preferredPixelRatio: 3,
  }), ScreenshotPagePlanningError);
});

test("rejects invalid measurements before capture", () => {
  assert.throws(() => planScreenshotPages([{ id: "bad", cssHeight: 0 }], {
    cssWidth: 390,
    pageChromeCssHeight: 80,
    preferredPixelRatio: 3,
  }), /cssHeight for bad/);
});
