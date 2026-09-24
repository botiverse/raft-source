// Followed-thread content frontier — same-source pairing (task #361 B1 read leg).
//
// The invariant is PAIRING, not presence: latestActivityMessageId and
// latestActivitySeq must describe the same message. Splicing a reply id onto a
// parent seq (or the reverse) would mark Done through a message the user never
// saw. replyCount / lastReplyAt are display-only and may never substitute.
import assert from "node:assert/strict";
import { test } from "vitest";
import { __testFollowedThreadFrontier } from "./channelService.js";

const { latestActivitySeqSameSource } = __testFollowedThreadFrontier;

test("F1 a thread WITH replies takes the seq of the same reply tuple", () => {
  assert.equal(
    latestActivitySeqSameSource(
      { lastReplyMessageId: "m-reply", lastReplySeqExact: "77" },
      41,
    ),
    "77",
    "must use the reply's own seq, not the parent's",
  );
});

test("F2 a ZERO-reply thread falls back to the parent message's own seq", () => {
  assert.equal(
    latestActivitySeqSameSource(
      { lastReplyMessageId: null, lastReplySeqExact: null },
      41,
    ),
    "41",
  );
});

test("F3 a reply row missing its seq FAILS CLOSED rather than borrowing the parent's", () => {
  // This is the splice the pairing rule exists to prevent: the row reports a
  // reply id, so returning the PARENT seq would pair a reply id with a parent
  // frontier and Done would cover the wrong message.
  assert.equal(
    latestActivitySeqSameSource(
      { lastReplyMessageId: "m-reply", lastReplySeqExact: null },
      41,
    ),
    null,
    "a reply present with no seq must be null, never the parent seq",
  );
});

test("F4 absent stats and absent parent seq both fail closed", () => {
  assert.equal(latestActivitySeqSameSource(undefined, 41), "41");
  assert.equal(latestActivitySeqSameSource(undefined, null), null);
  assert.equal(
    latestActivitySeqSameSource({ lastReplyMessageId: null, lastReplySeqExact: null }, undefined),
    null,
  );
});

test("F5 a frontier beyond 2^53 survives verbatim, with no numeric rounding", () => {
  // 9007199254740993 = 2^53 + 1. Any Number() round-trip yields ...992.
  const exact = "9007199254740993";
  assert.equal(
    latestActivitySeqSameSource({ lastReplyMessageId: "m", lastReplySeqExact: exact }, 1),
    exact,
  );
  // The zero-reply path stringifies, so it must also survive a bigint-shaped
  // parent seq arriving as a string from the driver.
  assert.equal(
    latestActivitySeqSameSource({ lastReplyMessageId: null, lastReplySeqExact: null }, exact),
    exact,
  );
});

test("F6 replyCount and lastReplyAt cannot influence the frontier", () => {
  // Keying on replyCount instead of the reply id would re-pair a reply id with a
  // parent seq after a delete leaves count>0 with no joined latest row.
  const spliceable = { lastReplyMessageId: "m-reply", lastReplySeqExact: null } as const;
  assert.equal(
    latestActivitySeqSameSource({ ...spliceable, replyCount: 9, lastReplyAt: "x" } as never, 41),
    null,
    "extra display fields must not unlock a parent-seq fallback",
  );
});

test("F7 a NONCANONICAL seq fails closed rather than being published", () => {
  // Missing is only one way to lack a canonical frontier. UInt64String is what
  // the Done intent validates against, and compareUInt64String keys on string
  // length first, so a leading-zero or float form mis-orders rather than errors.
  for (const bad of ["007", "", " 12", "1e3", "-1", "12.0", "abc"]) {
    assert.equal(
      latestActivitySeqSameSource({ lastReplyMessageId: "m", lastReplySeqExact: bad }, 41),
      null,
      `reply seq ${JSON.stringify(bad)} must fail closed, not borrow the parent`,
    );
  }
  // Same rule on the zero-reply parent fallback.
  for (const bad of ["007", "", "1e3", -1, 1.5]) {
    assert.equal(
      latestActivitySeqSameSource({ lastReplyMessageId: null, lastReplySeqExact: null }, bad as never),
      null,
      `parent seq ${JSON.stringify(bad)} must fail closed`,
    );
  }
});

test("F8 a >2^53 numeric parent seq is refused rather than silently rounded", () => {
  // A driver handing back a JS number past 2^53 has already lost precision;
  // stringifying it would publish a frontier that is off by one.
  assert.equal(
    latestActivitySeqSameSource(
      { lastReplyMessageId: null, lastReplySeqExact: null },
      9007199254740993 as never,
    ),
    null,
    "an unsafe integer must not be published as a frontier",
  );
  // The string form of the same value is exact and must pass.
  assert.equal(
    latestActivitySeqSameSource(
      { lastReplyMessageId: null, lastReplySeqExact: null },
      "9007199254740993",
    ),
    "9007199254740993",
  );
});
