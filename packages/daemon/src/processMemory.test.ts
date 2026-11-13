import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { BasicTracer } from "@botiverse/raft-shared";
import { LocalRotatingTraceSink } from "@botiverse/raft-trace-client";

import type { Clock } from "./connection";
import {
  PROCESS_MEMORY_TRACE_ATTRS,
  processMemoryTraceAttrs,
  readSwapBytes,
  serviceMemoryAttrs,
  sampleProcessMemory,
  startProcessMemoryReporter,
  type ProcessMemorySample,
} from "./processMemory";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { clock, advance, pending: () => timers.size };
}

const MB = 1024 * 1024;

function sampleAt(nowMs: number, heapUsedMb = 100): ProcessMemorySample {
  return {
    sampledAt: new Date(nowMs).toISOString(),
    pid: 4242,
    uptimeMs: nowMs,
    rssBytes: 300 * MB,
    heapUsedBytes: heapUsedMb * MB,
    heapTotalBytes: 150 * MB,
    externalBytes: 20 * MB,
    arrayBuffersBytes: 5 * MB,
    heapSpaceUsedBytes: { old_space: 70 * MB, code_space: 12 * MB, large_object_space: 8 * MB },
    lazySchemas: { registered: 372, built: 3 },
  };
}

test("samples after startup settles, writes every sample, traces at most every 30 minutes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "process-memory-"));
  try {
    const samplePath = path.join(dir, "servers", "s1", "runner.memory.json");
    const { clock, advance, pending } = fakeClock();
    const traced: Record<string, string | number>[] = [];
    let running = 2;
    const reporter = startProcessMemoryReporter({
      clock,
      trace: (attrs) => traced.push(attrs),
      context: () => ({ process_instance_id: "daemon-1", agents_running: running, agents_in_process: 1 }),
      samplePath,
      sample: (now) => sampleAt(now, 100 + now / 60_000),
    });

    advance(59_000);
    assert.equal(traced.length, 0, "nothing before the first sample");
    advance(1_000);
    assert.equal(traced.length, 1);
    assert.equal(JSON.parse(readFileSync(samplePath, "utf8")).heapUsedBytes, 101 * MB);

    // Samples every 5 minutes keep the file fresh; the trace waits 30 minutes.
    advance(25 * 60_000);
    assert.equal(traced.length, 1);
    assert.equal(JSON.parse(readFileSync(samplePath, "utf8")).heapUsedBytes, 126 * MB);
    running = 5;
    advance(5 * 60_000);
    assert.equal(traced.length, 2);
    assert.equal(traced[1]!.heap_used_mb, 131);
    // Context is read when the event is emitted, not when the reporter starts.
    assert.equal(traced[1]!.agents_running, 5);
    // Without a service sample every contract key but the service ones is set
    // (the pi session ones come from the daemon's context, not this fake).
    assert.deepEqual(
      Object.keys(traced[1]!).sort(),
      PROCESS_MEMORY_TRACE_ATTRS.filter(
        (key) => !key.startsWith("service_") && !key.startsWith("pi_") && key !== "swap_mb",
      ).sort(),
    );

    reporter.stop();
    assert.equal(pending(), 0, "stop clears the timer");
    advance(60 * 60_000);
    assert.equal(traced.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed file write is reported and does not stop sampling", () => {
  const { clock, advance } = fakeClock();
  const traced: Record<string, string | number>[] = [];
  const errors: unknown[] = [];
  const reporter = startProcessMemoryReporter({
    clock,
    trace: (attrs) => traced.push(attrs),
    // A path under a regular file cannot be created.
    samplePath: path.join(fileURLToPath(import.meta.url), "nested", "runner.memory.json"),
    sample: (now) => sampleAt(now),
    onWriteError: (error) => errors.push(error),
  });
  advance(60_000 + 30 * 60_000);
  assert.equal(errors.length, 7);
  assert.equal(traced.length, 2);
  reporter.stop();
});

test("sample attrs are whole megabytes", () => {
  const attrs = processMemoryTraceAttrs(sampleAt(90_000));
  assert.equal(attrs.rss_mb, 300);
  assert.equal(attrs.old_space_mb, 70);
  assert.equal(attrs.lazy_schemas_built, 3);
});

test("a real sample carries the process's own numbers and no heap contents", () => {
  const sample = sampleProcessMemory(Date.now());
  assert.equal(sample.pid, process.pid);
  assert.ok(sample.rssBytes > 0 && sample.heapUsedBytes > 0);
  assert.ok("old_space" in sample.heapSpaceUsedBytes);
  for (const value of Object.values(sample.heapSpaceUsedBytes)) assert.equal(typeof value, "number");
});

test("the service's sample is carried only while it is fresh", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "service-memory-"));
  try {
    const file = path.join(dir, "service.memory.json");
    const now = Date.parse("2026-10-15T09:00:00Z");
    assert.deepEqual(serviceMemoryAttrs(file, now), {}, "no file");
    assert.deepEqual(serviceMemoryAttrs(null, now), {}, "no path (standalone daemon)");
    writeFileSync(file, JSON.stringify({ sampledAt: "2026-10-15T08:56:00Z", rssBytes: 75 * MB, heapUsedBytes: 14 * MB }));
    assert.deepEqual(serviceMemoryAttrs(file, now), { service_rss_mb: 75, service_heap_used_mb: 14 });
    writeFileSync(file, JSON.stringify({ sampledAt: "2026-10-15T08:56:00Z", rssBytes: 18 * MB, heapUsedBytes: 14 * MB, swapBytes: 182 * MB }));
    assert.deepEqual(serviceMemoryAttrs(file, now), { service_rss_mb: 18, service_heap_used_mb: 14, service_swap_mb: 182 });
    writeFileSync(file, JSON.stringify({ sampledAt: "2026-10-15T08:30:00Z", rssBytes: 75 * MB, heapUsedBytes: 14 * MB }));
    assert.deepEqual(serviceMemoryAttrs(file, now), {}, "older than 15 minutes: the service is not running");
    writeFileSync(file, "{");
    assert.deepEqual(serviceMemoryAttrs(file, now), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swap comes from VmSwap in /proc/self/status and is absent when unknown", () => {
  assert.equal(readSwapBytes("Name:\traft\nVmRSS:\t   18256 kB\nVmSwap:\t  186844 kB\n"), 186844 * 1024);
  assert.equal(readSwapBytes("Name:\traft\n"), undefined);
  assert.equal(processMemoryTraceAttrs({ ...sampleAt(1), swapBytes: 181 * MB }).swap_mb, 181);
  assert.equal("swap_mb" in processMemoryTraceAttrs(sampleAt(1)), false);
});

test("every memory event attr survives the local trace sink's key rules", () => {
  // The sink drops keys by name (ids, paths, files, content words), so a new
  // attr named like `pi_session_file_kb` would vanish without an error.
  const machineDir = mkdtempSync(path.join(os.tmpdir(), "process-memory-sink-"));
  try {
    const sink = new LocalRotatingTraceSink({ machineDir, maxFileBytes: 1024 * 1024, maxFiles: 4 });
    const attrs = Object.fromEntries(PROCESS_MEMORY_TRACE_ATTRS.map((key) => [key, 1]));
    new BasicTracer({ sink }).startSpan("daemon.process.memory", { surface: "daemon", kind: "internal", attrs }).end("ok");
    const dir = path.join(machineDir, "traces");
    const written = readdirSync(dir)
      .flatMap((name) => readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as { name?: string; attrs?: Record<string, unknown> })
      .find((record) => record.name === "daemon.process.memory");
    assert.ok(written, "the event reached disk");
    const missing = PROCESS_MEMORY_TRACE_ATTRS.filter((key) => !(key in (written.attrs ?? {})));
    assert.deepEqual(missing, []);
  } finally {
    rmSync(machineDir, { recursive: true, force: true });
  }
});
