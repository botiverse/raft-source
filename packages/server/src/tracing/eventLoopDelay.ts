import os from "node:os";
import { monitorEventLoopDelay, performance, PerformanceObserver, type EventLoopUtilization } from "node:perf_hooks";
import type { Tracer } from "@botiverse/raft-shared";
import { cpuProfilerActiveSince } from "../lib/cpuProfileCapture";

// Every interval, one `server.event_loop.delay` event per process: how late
// timers fired (delay percentiles) and how busy the loop was (utilization).
// A query that takes 0.04ms in Postgres but shows a 700ms hold on
// server.db.connection points at a busy loop delaying the result callback;
// these events let that be checked per instance and per minute. Tasks serving
// the same requests can differ twofold in utilization, so each event also says
// what the process itself spent (CPU, GC), on what CPU, and what it holds
// (`load`: connections). All process-local, so readings need no AWS access.
export const EVENT_LOOP_SAMPLE_INTERVAL_MS = 10_000;

const NS_PER_MS = 1e6;

export interface EventLoopDelaySample {
  interval_ms: number;
  delay_p50_ms: number;
  delay_p99_ms: number;
  delay_max_ms: number;
  delay_mean_ms: number;
  utilization: number;
}

export type ProcessLoadAttrs = Record<string, number>;

export interface ProcessCpuGcSample {
  /** CPU time over wall time for this process; 1 is one core fully used. */
  cpu_cores_used: number;
  gc_count: number;
  gc_pause_ms: number;
  "host.cpu.model.name": string;
}

export function startEventLoopDelaySampler(
  tracer: Tracer,
  intervalMs: number = EVENT_LOOP_SAMPLE_INTERVAL_MS,
  load?: () => ProcessLoadAttrs,
  onSample?: (sample: EventLoopDelaySample, profiling: boolean) => void,
): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastUtilization: EventLoopUtilization = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastCpuAt = performance.now();
  let gcCount = 0;
  let gcPauseMs = 0;
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount += 1;
      gcPauseMs += entry.duration;
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });
  const cpuModel = os.cpus()[0]?.model ?? "unknown";
  const timer = setInterval(() => {
    try {
      const utilization = performance.eventLoopUtilization(lastUtilization);
      lastUtilization = performance.eventLoopUtilization();
      const sample = toSample(histogram, utilization, intervalMs);
      histogram.reset();
      const now = performance.now();
      const cpu = process.cpuUsage(lastCpu);
      const cpuGc = toCpuGcSample(cpu, now - lastCpuAt, gcCount, gcPauseMs, cpuModel);
      // A CPU profile raises utilization and stalls the loop by itself: these
      // readings say so, and must not be read as the load of the task.
      const profiling = cpuProfilerActiveSince(lastCpuAt);
      lastCpu = process.cpuUsage();
      lastCpuAt = now;
      gcCount = 0;
      gcPauseMs = 0;
      tracer.emitEvent("server.event_loop.delay", {
        surface: "server",
        attrs: { ...sample, ...cpuGc, ...readLoad(load), ...(profiling ? { profiling: true } : {}) },
      });
      onSample?.(sample, profiling);
    } catch {
      // Sampling must never affect the process.
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    histogram.disable();
    gcObserver.disconnect();
  };
}

export function toCpuGcSample(
  cpu: { user: number; system: number },
  wallMs: number,
  gcCount: number,
  gcPauseMs: number,
  cpuModel: string,
): ProcessCpuGcSample {
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return {
    cpu_cores_used: wallMs > 0 ? Math.round((cpuMs / wallMs) * 1000) / 1000 : 0,
    gc_count: gcCount,
    gc_pause_ms: Math.round(gcPauseMs * 10) / 10,
    "host.cpu.model.name": cpuModel,
  };
}

// A broken load reader must not lose the sample it rides on.
function readLoad(load: (() => ProcessLoadAttrs) | undefined): ProcessLoadAttrs {
  if (!load) return {};
  try {
    return load();
  } catch {
    return {};
  }
}

export function toSample(
  histogram: { percentile(p: number): number; max: number; mean: number },
  utilization: Pick<EventLoopUtilization, "utilization">,
  intervalMs: number,
): EventLoopDelaySample {
  const round = (ns: number) => (Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0);
  return {
    interval_ms: intervalMs,
    delay_p50_ms: round(histogram.percentile(50)),
    delay_p99_ms: round(histogram.percentile(99)),
    delay_max_ms: round(histogram.max),
    delay_mean_ms: round(histogram.mean),
    utilization: Math.round(utilization.utilization * 1000) / 1000,
  };
}
