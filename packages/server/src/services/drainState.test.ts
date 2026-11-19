import assert from "node:assert/strict";

import { __resetDrainStateForTests, isDraining, markDraining, recordDrainRefusal, setDrainRefusalSink, type DrainRefusalKind } from "./drainState";

afterEach(() => {
  __resetDrainStateForTests();
});

test("a process is not draining until the going-away phase marks it, and stays draining", () => {
  assert.equal(isDraining(), false);
  markDraining();
  assert.equal(isDraining(), true);
  // Both triggers (ECS drain, SIGTERM fallback) may mark it; the second is a no-op.
  markDraining();
  assert.equal(isDraining(), true);
});

test("each refusal reaches the sink with its kind, and a throwing sink never escapes", () => {
  const seen: DrainRefusalKind[] = [];
  setDrainRefusalSink((kind) => { seen.push(kind); });
  recordDrainRefusal("socketio");
  recordDrainRefusal("daemon");
  recordDrainRefusal("sse");
  assert.deepEqual(seen, ["socketio", "daemon", "sse"]);

  setDrainRefusalSink(() => { throw new Error("telemetry down"); });
  assert.doesNotThrow(() => recordDrainRefusal("daemon"));
});
