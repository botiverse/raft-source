import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { captureCpuProfile, captureTimedCpuProfile, cpuProfilerActiveSince, tryAcquireCpuProfiler } from "./cpuProfileCapture";

test("captures a real V8 CPU profile and leaves the profiler free for the next capture", async () => {
  const profile = await captureCpuProfile(20);
  assert.ok(profile.nodes.length > 0);
  assert.ok(profile.endTime > profile.startTime);
  assert.ok(Array.isArray(profile.samples));

  // The first session was stopped and disconnected: a second capture works.
  const again = await captureCpuProfile(5);
  assert.ok(again.nodes.length > 0);
});

test("the sampling interval is honoured and only one holder gets the profiler", async () => {
  const profile = await captureCpuProfile(20, { samplingIntervalUs: 10_000 });
  assert.ok(profile.nodes.length > 0);

  const release = tryAcquireCpuProfiler();
  assert.ok(release);
  assert.equal(tryAcquireCpuProfiler(), null);
  release();
  const again = tryAcquireCpuProfiler();
  assert.ok(again);
  again();
});

test("reports how long the main thread was blocked starting and stopping the profiler", async () => {
  const { profile, startMs, stopMs } = await captureTimedCpuProfile(20);
  assert.ok(profile.nodes.length > 0);
  assert.ok(startMs > 0);
  assert.ok(stopMs > 0);
});

test("cpuProfilerActiveSince covers a capture that is running, or ended up to 30 s before the interval", () => {
  const before = performance.now();
  const release = tryAcquireCpuProfiler();
  assert.ok(release);
  assert.equal(cpuProfilerActiveSince(before), true);
  release();
  assert.equal(cpuProfilerActiveSince(before), true);
  assert.equal(cpuProfilerActiveSince(performance.now() + 20_000), true);
  assert.equal(cpuProfilerActiveSince(performance.now() + 31_000), false);
});
