import assert from "node:assert/strict";
import {
  channelTypeSupportsThreadSort,
  decodeChannelActivityCursor,
  encodeChannelActivityCursor,
  isChannelThreadSort,
  messageActivityAtMs,
} from "./channelThreadSort";

test("thread sort values and the channel types that may use them", () => {
  assert.equal(isChannelThreadSort("time"), true);
  assert.equal(isChannelThreadSort("activity"), true);
  for (const bad of ["seq", "", null, undefined, 1]) assert.equal(isChannelThreadSort(bad), false);
  assert.deepEqual(
    ["channel", "private", "joint", "dm", "thread", "task", undefined].map(channelTypeSupportsThreadSort),
    [true, true, false, false, false, false, false],
  );
});

test("activity is the later of own time and latest reply", () => {
  const own = "2026-10-21T17:00:00.000Z";
  assert.equal(messageActivityAtMs(own, null), Date.parse(own));
  assert.equal(messageActivityAtMs(own, "2026-10-21T17:05:00.000Z"), Date.parse("2026-10-21T17:05:00.000Z"));
  assert.equal(messageActivityAtMs(own, "2026-10-21T16:00:00.000Z"), Date.parse(own), "a skewed earlier reply never moves it back");
  assert.equal(messageActivityAtMs(own, "garbage"), Date.parse(own));
});

test("the activity cursor round-trips verbatim, microseconds included, and refuses junk", () => {
  const cursor = { activityAt: "2026-10-21T17:00:00.123456Z", seq: 19852431 };
  assert.deepEqual(decodeChannelActivityCursor(encodeChannelActivityCursor(cursor)), cursor);
  for (const bad of [undefined, 1, "", "~1", "2026-10-21T17:00:00Z", "2026-10-21T17:00:00Z~x", "yesterday~1", "2026-10-21T17:00:00Z~1.5"]) {
    assert.equal(decodeChannelActivityCursor(bad), null, JSON.stringify(bad));
  }
});
