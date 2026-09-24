import assert from "node:assert/strict";
import test from "node:test";
import {
  canAutoMarkLiveAppendRead,
  canAutoMarkCurrentChannelRead,
  filterUnreadCountsByLocalReadSuppressions,
} from "../src/store/messageStore.js";

test("filters stale unread snapshots while a local read is still settling", () => {
  const suppressions = new Map([
    ["channel-read-locally", { seq: 42, expiresAt: 2_000 }],
  ]);

  const filtered = filterUnreadCountsByLocalReadSuppressions(
    {
      "channel-read-locally": 3,
      "channel-still-unread": 2,
    },
    suppressions,
    1_000,
  );

  assert.deepEqual(filtered, { "channel-still-unread": 2 });
});

test("allows server unread snapshots through after the local read suppression expires", () => {
  const suppressions = new Map([
    ["channel-read-locally", { seq: 42, expiresAt: 2_000 }],
  ]);

  const filtered = filterUnreadCountsByLocalReadSuppressions(
    { "channel-read-locally": 3 },
    suppressions,
    2_001,
  );

  assert.deepEqual(filtered, { "channel-read-locally": 3 });
  assert.equal(suppressions.has("channel-read-locally"), false);
});

test("auto-read only runs when the document is visible and focused", () => {
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "visible", hasFocus: () => true }, () => true),
    true
  );
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "hidden", hasFocus: () => true }, () => true),
    false
  );
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "visible", hasFocus: () => false }, () => true),
    false
  );
  assert.equal(
    canAutoMarkCurrentChannelRead({ visibilityState: "visible", hasFocus: () => true }, () => false),
    false
  );
});

test("live append auto-read requires explicit user activity in this tab", () => {
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "visible", hasFocus: () => true },
      () => true,
      () => false,
    ),
    false
  );
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "visible", hasFocus: () => true },
      () => true,
      () => true,
    ),
    true
  );
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "hidden", hasFocus: () => true },
      () => true,
      () => true,
    ),
    false
  );
  assert.equal(
    canAutoMarkLiveAppendRead(
      { visibilityState: "visible", hasFocus: () => false },
      () => true,
      () => true,
    ),
    false
  );
});
