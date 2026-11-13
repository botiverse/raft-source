import { createHash } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import type { Tracer } from "@botiverse/raft-shared";
import { captureTimedCpuProfile, tryAcquireCpuProfiler, type CpuProfile, type TimedCpuProfile } from "../lib/cpuProfileCapture";
import type { EventLoopDelaySample } from "./eventLoopDelay";

// When a task's event loop stays saturated, on a chosen share of tasks, one
// `server.cpu_profile.summary` event: the functions the main thread spent the
// most samples in. Tasks with the same requests can differ twofold in event loop
// utilization, and traces do not show pure CPU work, so this says what a saturated
// loop was running without a token, a bucket or someone calling
// POST /api/ops/cpu-profile in time.
// Only code locations and shares; nothing about requests, users or content.
//
// Only when saturated, because starting the profiler is not cheap: on staging it
// blocked the main thread 0.4-1 s (start_ms), growing with the compiled code, and
// raised utilization while it ran. Each event carries the minute before it
// (pre_*), to tell a stall the profile caused from one that was already there.
//
// Reading `idle_share`: the main thread profiler cannot see libuv's thread pool
// (argon2, zlib, DNS), and time waiting for it counts as idle. High idle does not
// mean the task has CPU to spare; read it next to `cpu_cores_used` on
// `server.event_loop.delay`. The gap between them is CPU spent off the main thread.
export const CPU_PROFILE_SUMMARY_WINDOW_MS = 60_000;
export const CPU_PROFILE_SAMPLING_INTERVAL_US = 10_000;
export const CPU_PROFILE_SUMMARY_TOP_N = 30;
// Beyond this the profile is not walked at all: summarizing runs on the main
// thread, so an unusually large profile must not add its own stall.
export const CPU_PROFILE_SUMMARY_MAX_NODES = 50_000;
export const CPU_PROFILE_SATURATION_UTILIZATION = 0.8;
export const CPU_PROFILE_SATURATION_MS = 180_000;
// Each task may start only in its own minute of this cycle, so it samples at most
// once a cycle, and tasks rarely overlap without having to coordinate.
export const CPU_PROFILE_CYCLE_MINUTES = 10;
const PRE_WINDOW_MS = 60_000;
const LOCATION_MAX_LENGTH = 80;

export interface CpuProfileFunctionShare {
  fn: string;
  at: string;
  share: number;
}

export interface CpuProfileSummary {
  node_count: number;
  sample_count: number;
  idle_share: number;
  gc_share: number;
  program_share: number;
  // Share of busy samples outside `top_functions`: what the list leaves out.
  omitted_share: number;
  top_functions: string;
}

// Keep the part of a path that names the code: `node_modules/<pkg>/...` or the
// last segments, never an absolute host path.
function shortLocation(url: string, line: number): string {
  if (!url) return "";
  const path = url.replace(/^file:\/\//, "");
  const modules = path.lastIndexOf("node_modules/");
  const short = modules >= 0 ? path.slice(modules + "node_modules/".length) : path.split("/").slice(-3).join("/");
  return `${short.slice(-LOCATION_MAX_LENGTH)}:${line + 1}`;
}

export function summarizeCpuProfile(profile: CpuProfile, topN: number = CPU_PROFILE_SUMMARY_TOP_N): CpuProfileSummary {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  let total = 0;
  let idle = 0;
  let gc = 0;
  let program = 0;
  const byFunction = new Map<string, { fn: string; at: string; hits: number }>();
  for (const node of profile.nodes) {
    const hits = node.hitCount ?? 0;
    if (hits === 0) continue;
    total += hits;
    const { functionName, url, lineNumber } = node.callFrame;
    if (functionName === "(idle)") idle += hits;
    else if (functionName === "(garbage collector)") gc += hits;
    else if (functionName === "(program)") program += hits;
    else {
      const at = shortLocation(url, lineNumber);
      const fn = functionName || "(anonymous)";
      const key = `${fn}\0${at}`;
      const entry = byFunction.get(key);
      if (entry) entry.hits += hits;
      else byFunction.set(key, { fn, at, hits });
    }
  }
  const sorted = [...byFunction.values()].sort((a, b) => b.hits - a.hits);
  const top = sorted.slice(0, topN);
  const share = (hits: number) => (total > 0 ? round(hits / total) : 0);
  const omitted = sorted.slice(topN).reduce((sum, entry) => sum + entry.hits, 0);
  const functions: CpuProfileFunctionShare[] = top.map(({ fn, at, hits }) => ({ fn: fn.slice(0, LOCATION_MAX_LENGTH), at, share: share(hits) }));
  return {
    node_count: profile.nodes.length,
    sample_count: total,
    idle_share: share(idle),
    gc_share: share(gc),
    program_share: share(program),
    omitted_share: share(omitted),
    top_functions: JSON.stringify(functions),
  };
}

/** CPU_PROFILE_SUMMARY_PERCENT of tasks, chosen by a stable hash of the task. Unset, invalid or 0: none. */
export function cpuProfileSummaryEnabled(env: NodeJS.ProcessEnv, instanceKey: string): boolean {
  const percent = Number(env.CPU_PROFILE_SUMMARY_PERCENT?.trim());
  if (!Number.isFinite(percent) || percent <= 0) return false;
  return instanceBucket(instanceKey, 100) < percent;
}

function instanceBucket(instanceKey: string, buckets: number): number {
  return createHash("sha256").update(instanceKey).digest().readUInt32BE(0) % buckets;
}

/** Above which utilization a task counts as saturated. CPU_PROFILE_SATURATION_UTILIZATION lets a quiet staging reach it. */
export function cpuProfileSaturationUtilization(env: NodeJS.ProcessEnv): number {
  const raw = env.CPU_PROFILE_SATURATION_UTILIZATION?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : CPU_PROFILE_SATURATION_UTILIZATION;
}

export interface CpuProfileSummarySamplerOptions {
  instanceKey: string;
  saturationUtilization?: number;
  windowMs?: number;
  capture?: (durationMs: number, samplingIntervalUs: number) => Promise<TimedCpuProfile>;
  acquire?: () => (() => void) | null;
  nowMs?: () => number;
}

export interface CpuProfileSummarySampler {
  /** Feed every event loop reading; `profiling` readings are the sampler's own and do not count. */
  observe: (sample: Pick<EventLoopDelaySample, "interval_ms" | "utilization" | "delay_p99_ms">, profiling: boolean) => void;
  stop: () => void;
}

export function startCpuProfileSummarySampler(tracer: Tracer, options: CpuProfileSummarySamplerOptions): CpuProfileSummarySampler {
  const windowMs = options.windowMs ?? CPU_PROFILE_SUMMARY_WINDOW_MS;
  const capture = options.capture ?? ((durationMs, intervalUs) => captureTimedCpuProfile(durationMs, { samplingIntervalUs: intervalUs }));
  const acquire = options.acquire ?? tryAcquireCpuProfiler;
  const nowMs = options.nowMs ?? Date.now;
  const threshold = options.saturationUtilization ?? CPU_PROFILE_SATURATION_UTILIZATION;
  const ownMinute = instanceBucket(options.instanceKey, CPU_PROFILE_CYCLE_MINUTES);
  const cpuModel = os.cpus()[0]?.model ?? "unknown";
  const emit = (attrs: Record<string, string | number>) => tracer.emitEvent("server.cpu_profile.summary", {
    surface: "server",
    // saturation_utilization: the line in force; a lowered one on staging is not saturation.
    attrs: { window_ms: windowMs, sampling_interval_us: CPU_PROFILE_SAMPLING_INTERVAL_US, saturation_utilization: threshold, "host.cpu.model.name": cpuModel, ...attrs },
  });
  const roundMs = (ms: number) => Math.round(ms * 10) / 10;
  let stopped = false;
  let running = false;
  let saturatedMs = 0;
  let recent: Array<{ at: number; utilization: number; delayP99Ms: number }> = [];

  const runWindow = async () => {
    const release = acquire();
    if (!release) {
      // An ops capture holds the profiler; its result is the better one anyway.
      emit({ outcome: "skipped", reason: "profiler_busy" });
      return;
    }
    // The minute before: per-interval p99s cannot be merged, so the worst of them.
    const pre = {
      pre_delay_p99_ms: Math.max(...recent.map((reading) => reading.delayP99Ms)),
      pre_utilization: Math.round((recent.reduce((sum, reading) => sum + reading.utilization, 0) / recent.length) * 1000) / 1000,
    };
    running = true;
    saturatedMs = 0;
    try {
      const { profile, startMs, stopMs } = await capture(windowMs, CPU_PROFILE_SAMPLING_INTERVAL_US);
      const timing = { ...pre, start_ms: roundMs(startMs), stop_ms: roundMs(stopMs) };
      if (profile.nodes.length > CPU_PROFILE_SUMMARY_MAX_NODES) {
        emit({ outcome: "skipped", reason: "too_many_nodes", node_count: profile.nodes.length, ...timing });
      } else {
        const startedAt = performance.now();
        const summary = summarizeCpuProfile(profile);
        emit({ outcome: "ok", ...summary, ...timing, summarize_ms: roundMs(performance.now() - startedAt) });
      }
    } catch {
      // Sampling must never affect the process.
      emit({ outcome: "error", reason: "capture_failed", ...pre });
    } finally {
      running = false;
      release();
    }
  };

  return {
    observe: (sample, profiling) => {
      if (stopped || running) return;
      if (profiling) {
        saturatedMs = 0;
        return;
      }
      const now = nowMs();
      recent = recent.filter((reading) => reading.at > now - PRE_WINDOW_MS);
      recent.push({ at: now, utilization: sample.utilization, delayP99Ms: sample.delay_p99_ms });
      saturatedMs = sample.utilization > threshold ? saturatedMs + sample.interval_ms : 0;
      if (saturatedMs < CPU_PROFILE_SATURATION_MS) return;
      if (Math.floor(now / 60_000) % CPU_PROFILE_CYCLE_MINUTES !== ownMinute) return;
      void runWindow();
    },
    stop: () => {
      stopped = true;
    },
  };
}
