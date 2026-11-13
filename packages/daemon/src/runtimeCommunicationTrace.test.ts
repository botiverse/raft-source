import assert from "node:assert/strict";
import { test } from "vitest";
import {
  TURN_SPAN_EVENT_BYTES_BUDGET,
  TURN_SPAN_EVENT_MAX_BYTES,
  admitTurnSpanEvent,
  createRuntimeTraceCounters,
  runtimeTraceCounterAttrs,
} from "./runtimeCommunicationTrace";

// #botiverse-raft-deployment:#208: TeleScope drops a trace row over 8 MiB, and
// long turns carried ~12 MB of events on their span.
test("turn span events stop at the byte budget and the span end says what was left off", () => {
  const counters = createRuntimeTraceCounters();
  const attrs = { detail: "x".repeat(1000) };
  let kept = 0;
  while (admitTurnSpanEvent(counters, "runtime.tool_call", attrs)) kept++;
  assert.ok(kept > 0);
  assert.ok(counters.spanEventBytes <= TURN_SPAN_EVENT_BYTES_BUDGET, "kept events fit the budget");
  assert.ok(counters.spanEventBytes > TURN_SPAN_EVENT_BYTES_BUDGET - 2000, "the budget is used, not refused early");
  assert.equal(counters.spanEventsDropped, 1);

  // Every later event is dropped and counted, small ones too.
  assert.equal(admitTurnSpanEvent(counters, "runtime.text", { a: 1 }), false);
  assert.equal(counters.spanEventsDropped, 2);

  const end = runtimeTraceCounterAttrs({ runtimeTraceCounters: counters });
  assert.equal(end.runtime_span_events_dropped_count, 2);
  assert.ok(Number(end.runtime_span_event_bytes_dropped) > 1000);
});

test("one oversized turn span event is dropped alone; the next small one is kept", () => {
  const counters = createRuntimeTraceCounters();
  assert.equal(admitTurnSpanEvent(counters, "runtime.telemetry.big", { blob: "y".repeat(TURN_SPAN_EVENT_MAX_BYTES) }), false);
  assert.equal(counters.spanEventsDropped, 1);
  assert.equal(counters.spanEventBytes, 0);
  assert.equal(admitTurnSpanEvent(counters, "runtime.text", { a: 1 }), true);
});

test("the size counts UTF-8 bytes, not characters", () => {
  const counters = createRuntimeTraceCounters();
  // 100k three-byte characters: ~300 KiB in UTF-8, over the one-event cap.
  assert.equal(admitTurnSpanEvent(counters, "runtime.text", { s: "字".repeat(100_000) }), false);
});

test("a turn that drops nothing reports zero and no dropped-bytes attribute", () => {
  const counters = createRuntimeTraceCounters();
  assert.equal(admitTurnSpanEvent(counters, "runtime.text", { a: 1 }), true);
  const end = runtimeTraceCounterAttrs({ runtimeTraceCounters: counters });
  assert.equal(end.runtime_span_events_dropped_count, 0);
  assert.equal("runtime_span_event_bytes_dropped" in end, false);
});

test("attributes that cannot be serialized still get a size and never throw", () => {
  const counters = createRuntimeTraceCounters();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(admitTurnSpanEvent(counters, "runtime.text", circular), true);
  assert.equal(admitTurnSpanEvent(counters, "runtime.text", { n: 10n }), true);
});
