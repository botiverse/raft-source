import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BasicTracer, type TraceLogEvent } from "@botiverse/raft-shared";
import type { CpuProfile } from "../lib/cpuProfileCapture";
import {
  CPU_PROFILE_CYCLE_MINUTES,
  CPU_PROFILE_SATURATION_MS,
  cpuProfileSaturationUtilization,
  cpuProfileSummaryEnabled,
  startCpuProfileSummarySampler,
  type CpuProfileSummarySamplerOptions,
  summarizeCpuProfile,
} from "./cpuProfileSummary";

function node(id: number, functionName: string, hitCount: number, url = "", lineNumber = 0) {
  return { id, hitCount, callFrame: { functionName, url, lineNumber, columnNumber: 0, scriptId: "1" } };
}

function profile(nodes: ReturnType<typeof node>[]): CpuProfile {
  return { nodes, startTime: 0, endTime: 1, samples: [], timeDeltas: [] } as unknown as CpuProfile;
}

test("summarizes self samples by function, naming idle and GC apart and reporting what the list leaves out", () => {
  const summary = summarizeCpuProfile(profile([
    node(1, "(idle)", 50),
    node(2, "(garbage collector)", 10),
    node(3, "(program)", 5),
    node(4, "hot", 20, "file:///home/app/packages/server/dist/services/agent.js", 41),
    node(5, "hot", 10, "file:///home/app/packages/server/dist/services/agent.js", 41),
    node(6, "", 4, "file:///app/node_modules/pg/lib/client.js", 9),
    node(7, "small", 1, "file:///app/a.js", 0),
    node(8, "never", 0, "file:///app/b.js", 0),
  ]), 2);
  assert.equal(summary.sample_count, 100);
  assert.equal(summary.idle_share, 0.5);
  assert.equal(summary.gc_share, 0.1);
  assert.equal(summary.program_share, 0.05);
  assert.equal(summary.omitted_share, 0.01);
  assert.deepEqual(JSON.parse(summary.top_functions), [
    { fn: "hot", at: "dist/services/agent.js:42", share: 0.3 },
    { fn: "(anonymous)", at: "pg/lib/client.js:10", share: 0.04 },
  ]);
  assert.doesNotMatch(summary.top_functions, /home\/app/);
});

test("an empty profile gives zero shares", () => {
  const summary = summarizeCpuProfile(profile([]));
  assert.equal(summary.sample_count, 0);
  assert.equal(summary.idle_share, 0);
  assert.equal(summary.top_functions, "[]");
});

test("off unless a percent is set; 100 picks every task, and the pick is stable per task", () => {
  assert.equal(cpuProfileSummaryEnabled({}, "ecs:a"), false);
  assert.equal(cpuProfileSummaryEnabled({ CPU_PROFILE_SUMMARY_PERCENT: "0" }, "ecs:a"), false);
  assert.equal(cpuProfileSummaryEnabled({ CPU_PROFILE_SUMMARY_PERCENT: "x" }, "ecs:a"), false);
  assert.equal(cpuProfileSummaryEnabled({ CPU_PROFILE_SUMMARY_PERCENT: "100" }, "ecs:a"), true);
  const picks = Array.from({ length: 400 }, (_, i) => cpuProfileSummaryEnabled({ CPU_PROFILE_SUMMARY_PERCENT: "10" }, `ecs:${i}`));
  const count = picks.filter(Boolean).length;
  assert.ok(count > 15 && count < 70, `picked ${count} of 400`);
  assert.equal(cpuProfileSummaryEnabled({ CPU_PROFILE_SUMMARY_PERCENT: "10" }, "ecs:7"), picks[7]);
});

const KEY = "ecs:task";
// A time in the task's own minute of the cycle.
function ownMinuteMs(key: string): number {
  const bucket = createHash("sha256").update(key).digest().readUInt32BE(0) % CPU_PROFILE_CYCLE_MINUTES;
  return bucket * 60_000 + 30_000;
}

const saturated = { interval_ms: 10_000, utilization: 0.95, delay_p99_ms: 40 };
const READINGS_TO_SATURATE = CPU_PROFILE_SATURATION_MS / saturated.interval_ms;

function sampler(options: Partial<CpuProfileSummarySamplerOptions>) {
  const events: TraceLogEvent[] = [];
  const tracer = new BasicTracer({ sink: { record: () => undefined, recordLogEvent: (event) => { events.push(event); } } });
  let now = ownMinuteMs(KEY);
  const captures = { count: 0 };
  const { observe, stop } = startCpuProfileSummarySampler(tracer, {
    instanceKey: KEY,
    nowMs: () => now,
    capture: async () => {
      captures.count += 1;
      return { profile: profile([node(1, "hot", 3, "file:///app/a.js", 0)]), startMs: 12.84, stopMs: 3.21 };
    },
    acquire: () => () => undefined,
    ...options,
  });
  const attrsOf = (index: number) => events[index]!.attrs as Record<string, unknown>;
  return { events, captures, observe, stop, attrsOf, setNow: (value: number) => { now = value; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("samples only after three minutes saturated, in the task's own minute, and records the minute before", async () => {
  const { events, captures, observe, attrsOf } = sampler({});
  for (let i = 0; i < READINGS_TO_SATURATE - 1; i += 1) observe(saturated, false);
  await settle();
  assert.equal(captures.count, 0);

  observe({ ...saturated, delay_p99_ms: 120 }, false);
  await settle();
  assert.equal(captures.count, 1);
  const attrs = attrsOf(0);
  assert.equal(events[0]!.name, "server.cpu_profile.summary");
  assert.equal(attrs.outcome, "ok");
  assert.equal(attrs.start_ms, 12.8);
  assert.equal(attrs.stop_ms, 3.2);
  assert.equal(attrs.saturation_utilization, 0.8);
  assert.equal(attrs.pre_delay_p99_ms, 120);
  assert.equal(attrs.pre_utilization, 0.95);
  assert.equal(typeof attrs.summarize_ms, "number");
});

test("a reading below the line restarts the count; another minute of the cycle waits", async () => {
  const dip = sampler({});
  for (let i = 0; i < READINGS_TO_SATURATE - 1; i += 1) dip.observe(saturated, false);
  dip.observe({ ...saturated, utilization: 0.5 }, false);
  dip.observe(saturated, false);
  await settle();
  assert.equal(dip.captures.count, 0);

  const otherMinute = sampler({});
  otherMinute.setNow(ownMinuteMs(KEY) + 60_000);
  for (let i = 0; i < READINGS_TO_SATURATE; i += 1) otherMinute.observe(saturated, false);
  await settle();
  assert.equal(otherMinute.captures.count, 0);
  otherMinute.setNow(ownMinuteMs(KEY) + CPU_PROFILE_CYCLE_MINUTES * 60_000);
  otherMinute.observe(saturated, false);
  await settle();
  assert.equal(otherMinute.captures.count, 1);
});

test("readings taken while profiling never count toward saturation, so a profile cannot trigger itself", async () => {
  const { captures, observe } = sampler({});
  for (let i = 0; i < READINGS_TO_SATURATE * 2; i += 1) observe(saturated, true);
  await settle();
  assert.equal(captures.count, 0);

  for (let i = 0; i < READINGS_TO_SATURATE - 1; i += 1) observe(saturated, false);
  observe(saturated, true);
  observe(saturated, false);
  await settle();
  assert.equal(captures.count, 0);
});

test("skips while an ops capture holds the profiler, refuses a huge profile, and survives a failed capture", async () => {
  const saturate = async (s: ReturnType<typeof sampler>) => {
    for (let i = 0; i < READINGS_TO_SATURATE; i += 1) s.observe(saturated, false);
    await settle();
  };
  const busy = sampler({ acquire: () => null });
  await saturate(busy);
  assert.equal(busy.attrsOf(0).reason, "profiler_busy");
  assert.equal(busy.attrsOf(0).saturation_utilization, 0.8);

  const huge = sampler({
    capture: async () => ({ profile: profile(Array.from({ length: 50_001 }, (_, i) => node(i, "f", 1))), startMs: 1, stopMs: 40 }),
  });
  await saturate(huge);
  assert.equal(huge.attrsOf(0).reason, "too_many_nodes");
  assert.equal(huge.attrsOf(0).stop_ms, 40);

  const failed = sampler({ capture: async () => { throw new Error("boom"); } });
  await saturate(failed);
  assert.equal(failed.attrsOf(0).outcome, "error");
  assert.equal(failed.attrsOf(0).pre_utilization, 0.95);
});

test("the saturation line defaults to 0.8 and can be lowered for a quiet staging", () => {
  assert.equal(cpuProfileSaturationUtilization({}), 0.8);
  assert.equal(cpuProfileSaturationUtilization({ CPU_PROFILE_SATURATION_UTILIZATION: "0.1" }), 0.1);
  assert.equal(cpuProfileSaturationUtilization({ CPU_PROFILE_SATURATION_UTILIZATION: "x" }), 0.8);
  assert.equal(cpuProfileSaturationUtilization({ CPU_PROFILE_SATURATION_UTILIZATION: "0" }), 0.8);
});
