import assert from "node:assert/strict";
import test from "node:test";
import { isMemberScopedMentionChannel } from "../src/components/message/mentionCandidates";

test("member-scoped mention autocomplete is limited to private and joint channels", () => {
  assert.equal(isMemberScopedMentionChannel({ type: "private" }), true);
  assert.equal(isMemberScopedMentionChannel({ type: "joint" }), true);
  assert.equal(isMemberScopedMentionChannel({ type: "dm" }), false);
  assert.equal(isMemberScopedMentionChannel({ type: "channel" }), false);
  assert.equal(isMemberScopedMentionChannel({ type: null }), false);
  assert.equal(isMemberScopedMentionChannel(null), false);
  assert.equal(isMemberScopedMentionChannel(undefined), false);
});
