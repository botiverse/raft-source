import assert from "node:assert/strict";
import { test } from "vitest";
import { BasicTracer, type TraceLogEvent } from "@botiverse/raft-shared";
import { startEventLoopDelaySampler, toCpuGcSample, toSample } from "./eventLoopDelay";

test("toSample converts nanoseconds to rounded milliseconds", () => {
  const sample = toSample(
    { percentile: (p) => (p === 50 ? 1_234_567 : 98_765_432), max: 250_000_000, mean: 2_500_000 },
    { utilization: 0.73456 },
    10_000,
  );
  assert.deepEqual(sample, {
    interval_ms: 10_000,
    delay_p50_ms: 1.2,
    delay_p99_ms: 98.8,
    delay_max_ms: 250,
    delay_mean_ms: 2.5,
    utilization: 0.735,
  });
});

test("the sampler emits one server.event_loop.delay event per interval", async () => {
  const events: TraceLogEvent[] = [];
  const tracer = new BasicTracer({ sink: { record: () => undefined, recordLogEvent: (event) => { events.push(event); } } });
  const stop = startEventLoopDelaySampler(tracer, 30);
  await new Promise((resolve) => setTimeout(resolve, 100));
  stop();
  assert.ok(events.length >= 2, `got ${events.length} events`);
  const event = events[0]!;
  assert.equal(event.name, "server.event_loop.delay");
  assert.equal(event.surface, "server");
  for (const key of ["delay_p50_ms", "delay_p99_ms", "delay_max_ms", "delay_mean_ms", "utilization"]) {
    assert.equal(typeof event.attrs?.[key], "number", key);
  }
});

test("toCpuGcSample reports CPU as cores used over the wall interval", () => {
  assert.deepEqual(toCpuGcSample({ user: 6_000_000, system: 1_500_000 }, 10_000, 4, 12.34, "Intel Xeon"), {
    cpu_cores_used: 0.75,
    gc_count: 4,
    gc_pause_ms: 12.3,
    "host.cpu.model.name": "Intel Xeon",
  });
  assert.equal(toCpuGcSample({ user: 1, system: 1 }, 0, 0, 0, "x").cpu_cores_used, 0);
});

test("the sampler carries the load reader's counts, and survives one that throws", async () => {
  for (const [load, expected] of [
    [() => ({ machine_connections: 7 }), 7],
    [() => { throw new Error("boom"); }, undefined],
  ] as const) {
    const events: TraceLogEvent[] = [];
    const tracer = new BasicTracer({ sink: { record: () => undefined, recordLogEvent: (event) => { events.push(event); } } });
    const stop = startEventLoopDelaySampler(tracer, 20, load);
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    assert.ok(events.length >= 1);
    const attrs = events[0]!.attrs as Record<string, unknown>;
    assert.equal(attrs.machine_connections, expected);
    assert.equal(typeof attrs.cpu_cores_used, "number");
    assert.equal(typeof attrs["host.cpu.model.name"], "string");
  }
});
