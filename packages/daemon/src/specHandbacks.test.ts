// #proj-runtime:#63: an intentional idle stop's handback is parked. Its next
// delivery may be hours away, and that delivery's refusal must report the
// agent waking (then the usual deadline), not an unavailable runtime.
import assert from "node:assert/strict";
import { SPEC_HANDBACK_START_DEADLINE_MS, SpecHandbacks } from "./specHandbacks";

test("a config handback waits out its deadline from when it was set", () => {
  let now = 0;
  const handbacks = new SpecHandbacks(() => now);
  handbacks.mark("a");
  now = SPEC_HANDBACK_START_DEADLINE_MS - 1;
  assert.equal(handbacks.awaitingStart("a"), "handback");
  now = SPEC_HANDBACK_START_DEADLINE_MS + 1;
  assert.equal(handbacks.awaitingStart("a"), false, "past the deadline: the runtime is reported unavailable");
  assert.equal(handbacks.has("a"), false);
});

test("a parked handback waits however long until the next refusal, then the deadline counts from that refusal", () => {
  let now = 0;
  const handbacks = new SpecHandbacks(() => now);
  handbacks.park("a");
  now = 3 * 60 * 60_000;
  assert.equal(handbacks.awaitingStart("a"), "idle_stop", "hours later: the agent is waking");
  now += SPEC_HANDBACK_START_DEADLINE_MS - 1;
  assert.equal(handbacks.awaitingStart("a"), "handback", "a refusal again within the deadline still waits for the start");
  now += 2;
  assert.equal(handbacks.awaitingStart("a"), false, "then the usual deadline applies");
});

test("forget ends a parked handback", () => {
  const handbacks = new SpecHandbacks(() => 0);
  handbacks.park("a");
  handbacks.forget("a");
  assert.equal(handbacks.has("a"), false);
  assert.equal(handbacks.awaitingStart("a"), false);
});
