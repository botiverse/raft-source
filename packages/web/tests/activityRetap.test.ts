import assert from "node:assert/strict";
import { ACTIVITY_RETAP_IN_FLIGHT_MS, hasUnloadedUnread, nextActivityRetapTarget } from "../src/components/thread/activityRetap";
import type { ActivityRetapAnchor, ActivityRetapRow } from "../src/components/thread/activityRetap";

// Tapping Activity again on a phone (artin 2026-10-21): the next unread row
// below the current position, then back to the top, then round again.

const ROW = 72;
/** Long after the anchoring tap: only the position keeps an anchor. */
const LATER = 10_000;

/** Rows in list order, 72px apart; `unread` lists the unread ones' indexes. */
function rows(count: number, unread: number[]): ActivityRetapRow[] {
  return Array.from({ length: count }, (_, index) => ({ key: `row-${index}`, top: index * ROW, unread: unread.includes(index) }));
}

function next(list: ActivityRetapRow[], scrollTop: number, anchor: ActivityRetapAnchor | null = null, { maxScrollTop = 10_000, now = LATER } = {}) {
  return nextActivityRetapTarget({ rows: list, scrollTop, maxScrollTop, anchor, now });
}

/** Taps from the top, each one after the last scroll has arrived. */
function tapSequence(list: ActivityRetapRow[], taps: number, maxScrollTop = 10_000): string[] {
  let scrollTop = 0;
  let anchor: ActivityRetapAnchor | null = null;
  const seen: string[] = [];
  for (let i = 0; i < taps; i += 1) {
    const target = next(list, scrollTop, anchor, { maxScrollTop });
    if (target.kind === "top") {
      seen.push("top");
      anchor = { key: null, to: 0, at: 0 };
      scrollTop = 0;
    } else {
      seen.push(target.key);
      anchor = { key: target.key, to: target.top, at: 0 };
      scrollTop = target.top;
    }
  }
  return seen;
}

test("with nothing unread it goes to the top", () => {
  assert.deepEqual(next(rows(5, []), 300), { kind: "top" });
  assert.deepEqual(next(rows(5, []), 0), { kind: "top" });
  assert.deepEqual(next([], 0), { kind: "top" });
});

test("it goes to the first unread row below the current position, and puts it at the top", () => {
  // At 100, row 2 (144) is the first unread below; row 1 (72) is above.
  assert.deepEqual(next(rows(8, [1, 2, 5]), 100), { kind: "row", key: "row-2", top: 144 });
  // A row a hair below the current position is not below it (epsilon).
  assert.deepEqual(next(rows(8, [2, 5]), 142), { kind: "row", key: "row-5", top: 360 });
  // Past the last unread row: back to the top.
  assert.deepEqual(next(rows(8, [1, 2]), 400), { kind: "top" });
});

test("at the top of the list the first unread row counts, even the first row", () => {
  assert.deepEqual(next(rows(4, [0, 2]), 0), { kind: "row", key: "row-0", top: 0 });
  assert.deepEqual(next(rows(4, [3]), 0), { kind: "row", key: "row-3", top: 216 });
});

test("repeated taps walk the unread rows in order, go back to the top after the last, and start again", () => {
  assert.deepEqual(
    tapSequence(rows(10, [0, 3, 7]), 9),
    ["row-0", "row-3", "row-7", "top", "row-0", "row-3", "row-7", "top", "row-0"],
  );
});

test("near the end of the list, where rows can't reach the top, each unread row still gets its turn", () => {
  // The list scrolls at most 400px: rows 7, 8 and 9 all land at 400.
  assert.deepEqual(next(rows(10, [7, 9]), 0, null, { maxScrollTop: 400 }), { kind: "row", key: "row-7", top: 400 });
  assert.deepEqual(tapSequence(rows(10, [2, 7, 9]), 5, 400), ["row-2", "row-7", "row-9", "top", "row-2"]);
});

test("a tap during the smooth scroll to a row goes on to the row after it", () => {
  const anchor = { key: "row-3", to: 216, at: 0 };
  // Halfway there, just after the tap.
  assert.deepEqual(next(rows(10, [3, 6]), 100, anchor, { now: ACTIVITY_RETAP_IN_FLIGHT_MS - 100 }), { kind: "row", key: "row-6", top: 432 });
});

test("a tap during the trip back to the top starts again from the first unread row", () => {
  const anchor = { key: null, to: 0, at: 0 };
  // Still on the way up from the last row, just after the tap.
  assert.deepEqual(next(rows(10, [3, 6]), 300, anchor, { now: 200 }), { kind: "row", key: "row-3", top: 216 });
});

test("scrolled back up after a tap, the position decides again", () => {
  const list = rows(10, [3, 6]);
  const anchor = { key: "row-3", to: 216, at: 0 };
  // Back at the top: row 3 is the first unread row again, not row 6.
  assert.deepEqual(next(list, 0, anchor), { kind: "row", key: "row-3", top: 216 });
  // Between the top and row 3: row 3 is still below.
  assert.deepEqual(next(list, 150, anchor), { kind: "row", key: "row-3", top: 216 });
  // Scrolled down past row 6: nothing unread below.
  assert.deepEqual(next(list, 500, anchor), { kind: "top" });
});

test("after a filter switch the first unread row of the new filter comes first", () => {
  // The list is back at the top with other rows; the old anchor is gone
  // (ThreadsInbox drops it) or names a row that isn't in this filter.
  const unreadOnly = [
    { key: "row-a", top: 0, unread: true },
    { key: "row-b", top: 72, unread: true },
  ];
  assert.deepEqual(next(unreadOnly, 0, null), { kind: "row", key: "row-a", top: 0 });
  assert.deepEqual(next(unreadOnly, 0, { key: "row-9", to: 648, at: 0 }, { now: 100 }), { kind: "row", key: "row-a", top: 0 });
});

test("following the anchor goes by where its row is now, not its old index", () => {
  // Since the last tap (row-3), new activity moved row-6 above it.
  const reordered: ActivityRetapRow[] = [
    { key: "row-0", top: 0, unread: false },
    { key: "row-6", top: 72, unread: true },
    { key: "row-3", top: 144, unread: true },
    { key: "row-8", top: 216, unread: true },
  ];
  assert.deepEqual(next(reordered, 144, { key: "row-3", to: 144, at: 0 }), { kind: "row", key: "row-8", top: 216 });
  // The anchored row is gone (marked done): the position decides.
  assert.deepEqual(next(reordered.filter((row) => row.key !== "row-3"), 144, { key: "row-3", to: 144, at: 0 }), { kind: "row", key: "row-8", top: 216 });
});

test("past the loaded unread rows, another page is worth loading only when the totals say so", () => {
  assert.equal(hasUnloadedUnread({ loadedUnreadCount: 4, totalUnreadCount: 9, hasMore: true }), true);
  assert.equal(hasUnloadedUnread({ loadedUnreadCount: 9, totalUnreadCount: 9, hasMore: true }), false);
  assert.equal(hasUnloadedUnread({ loadedUnreadCount: 4, totalUnreadCount: 9, hasMore: false }), false);
});
