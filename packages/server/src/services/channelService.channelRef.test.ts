/**
 * `parseChannelRef` exists so that callers can tell "this channel does not
 * exist" apart from "this message has no thread yet". Those are different
 * answers, and collapsing them is what made `raft message read` on a reply-less
 * thread report `Channel not found` — a reader retried 8 times and concluded the
 * read surface was flaky, when the result was a deterministic empty.
 *
 * The parse MUST agree with resolveChannelByName's own suffix handling. If the
 * two drift, the route will report a thread-specific error for something the
 * resolver treated as a plain channel (or vice versa), which is worse than the
 * original bug because it would be wrong in a confident, specific way. These
 * cases are the ones where the two could plausibly disagree.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { parseChannelRef } from "./channelService.js";

test("channel and DM refs split into channel part plus optional thread short id", () => {
  assert.deepEqual(parseChannelRef("#proj-dx"), { baseRef: "#proj-dx", threadShortId: null });
  assert.deepEqual(parseChannelRef("#proj-dx:4cd28c12"), { baseRef: "#proj-dx", threadShortId: "4cd28c12" });
  assert.deepEqual(parseChannelRef("dm:@richard"), { baseRef: "dm:@richard", threadShortId: null });
  assert.deepEqual(parseChannelRef("dm:@richard:abc12345"), { baseRef: "dm:@richard", threadShortId: "abc12345" });
});

test("the legacy uppercase DM prefix is preserved, not normalised away", () => {
  // resolveChannelByName accepts both `DM:@` and `dm:@`; the base ref handed
  // back here is fed straight into it, so changing the case would turn a
  // resolvable parent into an unresolvable one.
  assert.deepEqual(parseChannelRef("DM:@richard:abc12345"), { baseRef: "DM:@richard", threadShortId: "abc12345" });
});

test("only a hex suffix after the LAST colon counts as a thread id", () => {
  // Mirrors the resolver: it tests the segment after the final colon against
  // /^[0-9a-f]+$/i and otherwise treats the whole rest as a channel name.
  assert.deepEqual(parseChannelRef("#notahex:zzzz"), { baseRef: "#notahex:zzzz", threadShortId: null });
  assert.deepEqual(parseChannelRef("#a:b:deadbeef"), { baseRef: "#a:b", threadShortId: "deadbeef" });
  // A colon at position 0 of the rest is not a suffix separator (lastColon > 0).
  assert.deepEqual(parseChannelRef("#:deadbeef"), { baseRef: "#:deadbeef", threadShortId: null });
});

test("a short id must be all 8 hex characters, not merely hex-shaped", () => {
  // Tightened to MESSAGE_SHORT_ID_RE (the predicate the message resolvers use).
  // A looser [0-9a-f]+ routed `#general:1` into thread lookup, so a channel
  // whose name simply contains a colon was answered as a missing thread.
  assert.deepEqual(parseChannelRef("#general:1"), { baseRef: "#general:1", threadShortId: null });
  assert.deepEqual(parseChannelRef("#general:deadbee"), { baseRef: "#general:deadbee", threadShortId: null });
  assert.deepEqual(parseChannelRef("#general:deadbeef1"), { baseRef: "#general:deadbeef1", threadShortId: null });
  assert.deepEqual(parseChannelRef("#general:deadbeef"), { baseRef: "#general", threadShortId: "deadbeef" });
});

test("refs with no recognised prefix are returned untouched", () => {
  // The resolver falls through to its own handling for these; the parser must
  // not invent a thread id for something it does not own.
  assert.deepEqual(parseChannelRef("proj-dx:4cd28c12"), { baseRef: "proj-dx:4cd28c12", threadShortId: null });
  assert.deepEqual(parseChannelRef(""), { baseRef: "", threadShortId: null });
});
