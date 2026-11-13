import assert from "node:assert/strict";
import { createTimelinePageGuard } from "../src/components/message/timelinePageGuard";

// Task #5 (InNOut, staging): paging a thread up asked for the same page twice,
// because the guard lived in React state and a scroll event landed between
// the answer and the re-render.

test("a page is asked for once, even when asked again before the next render", () => {
  const guard = createTimelinePageGuard();
  assert.equal(guard.start("t:100"), true);
  assert.equal(guard.start("t:100"), false, "while in flight");
  guard.finish("t:100", true);
  assert.equal(guard.start("t:100"), false, "after it landed, before the render moved the cursor");
  assert.equal(guard.start("t:50"), true, "the next page");
});

test("a page that failed may be asked for again", () => {
  const guard = createTimelinePageGuard();
  guard.start("t:100");
  guard.finish("t:100", false);
  assert.equal(guard.start("t:100"), true);
});

test("a timeline that starts over may ask for any page again", () => {
  const guard = createTimelinePageGuard();
  guard.start("t:100");
  guard.finish("t:100", true);
  guard.reset();
  assert.equal(guard.start("t:100"), true);
});
