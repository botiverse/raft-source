import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceSink, type CompletedTraceSpan, type TraceSink } from "@botiverse/raft-shared";
import { createTraceClient, MultiSink } from "./traceClient.js";

test("createTraceClient force-injects `source` attr onto every span", () => {
  const sink = new MemoryTraceSink();
  const client = createTraceClient({ source: "daemon", sinks: [sink] });

  const span = client.startSpan("test.op", {
    surface: "daemon",
    kind: "internal",
    attrs: { foo: "bar" },
  });
  span.end("ok");

  const spans = sink.getAllSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].attrs?.source, "daemon");
  assert.equal(spans[0].attrs?.foo, "bar");
});

test("startSpan attrs.source is a compile-time error (type-enforced)", () => {
  // skyzh review msg=0947c7d3: `source` should be type-enforced, not just
  // runtime-stripped. The TraceClientStartSpanOptions type makes source
  // a `?: never`, so the line below is a compile error. The cast escape
  // hatch covers dynamic-typed callsites; the runtime force-inject is
  // defense-in-depth.
  const sink = new MemoryTraceSink();
  const client = createTraceClient({ source: "computer.cli", sinks: [sink] });

  const span = client.startSpan("test.op", {
    surface: "daemon",
    kind: "internal",
    // @ts-expect-error — `source` is a reserved key that callers cannot set
    attrs: { source: "daemon", legitimate: "value" },
  });
  span.end("ok");

  const spans = sink.getAllSpans();
  assert.equal(spans[0].attrs?.source, "computer.cli", "runtime defense-in-depth: client overrides bypass");
  assert.equal(spans[0].attrs?.legitimate, "value", "non-source caller attrs preserved");
});

test("end attrs.source is a compile-time error (type-enforced)", () => {
  const sink = new MemoryTraceSink();
  const client = createTraceClient({ source: "daemon", sinks: [sink] });
  const span = client.startSpan("op", { surface: "daemon", kind: "internal" });
  span.end("ok", {
    // @ts-expect-error — `source` is a reserved key that callers cannot set
    attrs: { source: "computer.cli" },
  });
  assert.equal(sink.getAllSpans()[0].attrs?.source, "daemon",
    "runtime defense-in-depth: end-time source override stripped");
});

test("end-time attrs preserve non-source fields while stripping source", () => {
  const sink = new MemoryTraceSink();
  const client = createTraceClient({ source: "computer.cli", sinks: [sink] });
  const span = client.startSpan("op", { surface: "daemon", kind: "internal", attrs: { phase: "init" } });
  span.end("ok", {
    // @ts-expect-error — `source` is a reserved key that callers cannot set
    attrs: { source: "fake.label", outcome: "success", durationBucket: "fast" },
  });

  const recorded = sink.getAllSpans()[0];
  assert.equal(recorded.attrs?.source, "computer.cli", "source locked to client config");
  assert.equal(recorded.attrs?.phase, "init", "start-time non-source attrs preserved");
  assert.equal(recorded.attrs?.outcome, "success", "end-time non-source attrs preserved");
  assert.equal(recorded.attrs?.durationBucket, "fast", "end-time non-source attrs preserved");
});

test("end() with no options still records the injected source", () => {
  const sink = new MemoryTraceSink();
  const client = createTraceClient({ source: "computer.menu-bar", sinks: [sink] });
  const span = client.startSpan("op", { surface: "daemon", kind: "internal" });
  span.end("ok");
  assert.equal(sink.getAllSpans()[0].attrs?.source, "computer.menu-bar");
});

test("createTraceClient with no caller attrs still injects source", () => {
  const sink = new MemoryTraceSink();
  const client = createTraceClient({ source: "computer.menu-bar", sinks: [sink] });

  const span = client.startSpan("test.op", { surface: "daemon", kind: "internal" });
  span.end("ok");

  assert.equal(sink.getAllSpans()[0].attrs?.source, "computer.menu-bar");
});

test("MultiSink fans out spans to every sink", () => {
  const sink1 = new MemoryTraceSink();
  const sink2 = new MemoryTraceSink();
  const sink3 = new MemoryTraceSink();
  const client = createTraceClient({ source: "daemon", sinks: [sink1, sink2, sink3] });

  client.startSpan("op1", { surface: "daemon", kind: "internal" }).end("ok");
  client.startSpan("op2", { surface: "daemon", kind: "internal" }).end("ok");

  assert.equal(sink1.getAllSpans().length, 2);
  assert.equal(sink2.getAllSpans().length, 2);
  assert.equal(sink3.getAllSpans().length, 2);
});

test("MultiSink failure isolation: a throwing sink does not block other sinks", () => {
  const goodSink1 = new MemoryTraceSink();
  const goodSink2 = new MemoryTraceSink();
  const throwingSink: TraceSink = {
    record: () => { throw new Error("boom"); },
  };
  const errors: Array<{ sink: TraceSink; error: unknown }> = [];

  const multi = new MultiSink(
    [goodSink1, throwingSink, goodSink2],
    (sink, error) => errors.push({ sink, error }),
  );
  const span: CompletedTraceSpan = {
    name: "test.op",
    surface: "daemon",
    kind: "internal",
    context: { traceId: "0".repeat(32), spanId: "0".repeat(16), parentSpanId: null, traceFlags: "00" },
    startTimeMs: 0,
    endTimeMs: 1,
    durationMs: 1,
    status: "ok",
    events: [],
    attrs: { source: "daemon" },
  };

  // Should not throw despite the middle sink throwing.
  assert.doesNotThrow(() => multi.record(span));
  assert.equal(goodSink1.getAllSpans().length, 1, "first sink received the span");
  assert.equal(goodSink2.getAllSpans().length, 1, "third sink received the span despite middle throwing");
  assert.equal(errors.length, 1, "error handler received one notification");
  assert.equal((errors[0].error as Error).message, "boom");
});

test("MultiSink with empty list is a no-op", () => {
  const client = createTraceClient({ source: "daemon", sinks: [] });
  // Should not throw — span just goes nowhere.
  assert.doesNotThrow(() => {
    client.startSpan("op", { surface: "daemon", kind: "internal" }).end("ok");
  });
});
