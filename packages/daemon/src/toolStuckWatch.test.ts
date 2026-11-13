import assert from "node:assert/strict";

import { stuckToolActivityDetail, ToolStuckWatch } from "./toolStuckWatch";

const MIN = 60_000;

test("an open call quiet for the threshold is reported once per quiet episode", () => {
  const watch = new ToolStuckWatch();
  watch.noteToolStart("call-1", "bash", 0);

  assert.equal(watch.takeStuck(9 * MIN, 0, 10 * MIN), null, "under the threshold");
  const stuck = watch.takeStuck(10 * MIN, 0, 10 * MIN);
  assert.deepEqual(stuck, { toolName: "bash", callId: "call-1", startedAtMs: 0, quietSinceMs: 0, openToolCalls: 1 });
  assert.equal(watch.takeStuck(30 * MIN, 0, 10 * MIN), null, "the same episode is not reported again");

  // Output at 31 min starts a new episode; quiet again for the threshold reports again.
  assert.equal(watch.takeStuck(40 * MIN, 31 * MIN, 10 * MIN), null);
  assert.equal(watch.takeStuck(41 * MIN, 31 * MIN, 10 * MIN)?.quietSinceMs, 31 * MIN);
});

test("quiet time counts from the call's start when the last runtime event came before it", () => {
  const watch = new ToolStuckWatch();
  watch.noteToolStart("call-1", "bash", 5 * MIN);

  assert.equal(watch.takeStuck(14 * MIN, 0, 10 * MIN), null);
  assert.equal(watch.takeStuck(15 * MIN, 0, 10 * MIN)?.quietSinceMs, 5 * MIN);
});

test("a finished call, a cleared watch or a zero threshold reports nothing", () => {
  const watch = new ToolStuckWatch();
  watch.noteToolStart("call-1", "bash", 0);
  watch.noteToolEnd("call-1");
  assert.equal(watch.takeStuck(60 * MIN, 0, 10 * MIN), null);

  watch.noteToolStart("call-2", "bash", 0);
  assert.equal(watch.takeStuck(60 * MIN, 0, 0), null, "0 turns the report off");
  watch.clear();
  assert.equal(watch.takeStuck(60 * MIN, 0, 10 * MIN), null);
});

test("calls without an id are closed oldest first, and the oldest open call is the one reported", () => {
  const watch = new ToolStuckWatch();
  watch.noteToolStart(undefined, "read", 0);
  watch.noteToolStart("call-b", "bash", 1 * MIN);
  watch.noteToolStart(undefined, "grep", 2 * MIN);

  watch.noteToolEnd(undefined);

  assert.equal(watch.openCount, 2);
  assert.equal(watch.takeStuck(20 * MIN, 0, 10 * MIN)?.toolName, "bash");
});

test("the stuck detail names the action and the threshold", () => {
  assert.equal(stuckToolActivityDetail("Running command…", 10 * MIN), "Stuck: running command, no output for 10+ min");
});
