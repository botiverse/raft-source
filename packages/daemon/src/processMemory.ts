import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getHeapSpaceStatistics } from "node:v8";

import { lazySchemaStats } from "@botiverse/raft-shared";

import type { Clock } from "./connection";
import { PI_SESSION_MEMORY_TRACE_ATTRS } from "./drivers/piSessionMemory";

// How much memory this daemon process holds, sampled on a timer: process and
// V8 counters only, never heap contents. The sample goes to a local file the
// Computer reads for `raft-computer doctor`, and every TRACE_EVERY_MS to the
// `daemon.process.memory` event, so memory against uptime is visible across
// the fleet (is a runner growing, and did a memory fix land?).

export const PROCESS_MEMORY_SAMPLE_MS = 5 * 60_000;
export const PROCESS_MEMORY_TRACE_EVERY_MS = 30 * 60_000;
// Let startup (module loading, first connect) settle before the first sample.
export const PROCESS_MEMORY_FIRST_SAMPLE_MS = 60_000;

export interface ProcessMemorySample {
  sampledAt: string;
  pid: number;
  uptimeMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** Swapped-out bytes (Linux); absent elsewhere. */
  swapBytes?: number;
  /** Used bytes per V8 heap space (old_space, code_space, large_object_space, ...). */
  heapSpaceUsedBytes: Record<string, number>;
  lazySchemas: { registered: number; built: number };
}

/** Linux only: this process's swapped-out bytes (VmSwap). RSS alone hides them. */
export function readSwapBytes(statusText?: string): number | undefined {
  try {
    const text = statusText ?? (process.platform === "linux" ? readFileSync("/proc/self/status", "utf8") : "");
    const match = /^VmSwap:\s+(\d+)\s+kB$/m.exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export function sampleProcessMemory(nowMs: number): ProcessMemorySample {
  const usage = process.memoryUsage();
  const swap = readSwapBytes();
  const heapSpaceUsedBytes: Record<string, number> = {};
  for (const space of getHeapSpaceStatistics()) heapSpaceUsedBytes[space.space_name] = space.space_used_size;
  return {
    sampledAt: new Date(nowMs).toISOString(),
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    ...(swap === undefined ? {} : { swapBytes: swap }),
    heapSpaceUsedBytes,
    lazySchemas: lazySchemaStats(),
  };
}

export const PROCESS_MEMORY_TRACE_ATTRS = [
  // Context from the daemon: which process (its instance id, under the
  // allowlisted process_instance_id key), and how much it is running.
  "process_instance_id",
  "agents_running",
  "agents_in_process",
  "uptime_ms",
  "rss_mb",
  "heap_used_mb",
  "heap_total_mb",
  "external_mb",
  "array_buffers_mb",
  "old_space_mb",
  "code_space_mb",
  "large_object_space_mb",
  "lazy_schemas_built",
  "lazy_schemas_registered",
  // The Computer service's latest sample (its traces stay local, so runners
  // carry it); absent when there is no service or its sample is stale.
  "service_rss_mb",
  "service_heap_used_mb",
  // Linux only; a long-idle runner can have a third of itself swapped out.
  "swap_mb",
  "service_swap_mb",
  // How much transcript the in-process pi sessions hold, from the daemon;
  // pi_session_count is 0 when there are none.
  ...PI_SESSION_MEMORY_TRACE_ATTRS,
] as const;

const mb = (bytes: number | undefined): number => Math.round((bytes ?? 0) / (1024 * 1024));

type SampleAttr = Exclude<
  (typeof PROCESS_MEMORY_TRACE_ATTRS)[number],
  | "process_instance_id" | "agents_running" | "agents_in_process" | "service_rss_mb" | "service_heap_used_mb" | "swap_mb" | "service_swap_mb"
  | (typeof PI_SESSION_MEMORY_TRACE_ATTRS)[number]
>;

export function processMemoryTraceAttrs(sample: ProcessMemorySample): Record<SampleAttr, number> & { swap_mb?: number } {
  return {
    ...(sample.swapBytes === undefined ? {} : { swap_mb: mb(sample.swapBytes) }),
    uptime_ms: sample.uptimeMs,
    rss_mb: mb(sample.rssBytes),
    heap_used_mb: mb(sample.heapUsedBytes),
    heap_total_mb: mb(sample.heapTotalBytes),
    external_mb: mb(sample.externalBytes),
    array_buffers_mb: mb(sample.arrayBuffersBytes),
    old_space_mb: mb(sample.heapSpaceUsedBytes.old_space),
    code_space_mb: mb(sample.heapSpaceUsedBytes.code_space),
    large_object_space_mb: mb(sample.heapSpaceUsedBytes.large_object_space),
    lazy_schemas_built: sample.lazySchemas.built,
    lazy_schemas_registered: sample.lazySchemas.registered,
  };
}

// The service samples every 5 minutes; older than this means it is not running.
const SERVICE_SAMPLE_MAX_AGE_MS = 15 * 60_000;

/** The Computer service's sample as event attrs, or none if missing or stale. */
export function serviceMemoryAttrs(samplePath: string | null | undefined, nowMs: number): Record<string, number> {
  if (!samplePath) return {};
  try {
    const sample = JSON.parse(readFileSync(samplePath, "utf8")) as Partial<ProcessMemorySample>;
    const age = nowMs - Date.parse(String(sample.sampledAt));
    if (!(age >= 0 && age <= SERVICE_SAMPLE_MAX_AGE_MS)) return {};
    if (typeof sample.rssBytes !== "number" || typeof sample.heapUsedBytes !== "number") return {};
    return {
      service_rss_mb: mb(sample.rssBytes),
      service_heap_used_mb: mb(sample.heapUsedBytes),
      ...(typeof sample.swapBytes === "number" ? { service_swap_mb: mb(sample.swapBytes) } : {}),
    };
  } catch {
    return {};
  }
}

/** Write-then-rename so a reader never sees a half-written file. */
export function writeProcessMemorySample(path: string, sample: ProcessMemorySample): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function startProcessMemoryReporter(options: {
  clock: Clock;
  trace: (attrs: Record<string, string | number>) => void;
  /** Attrs read at trace time (daemon instance, running agents). */
  context?: () => Record<string, string | number>;
  /** Where the latest sample is written; absent for a standalone daemon. */
  samplePath?: string | null;
  sample?: (nowMs: number) => ProcessMemorySample;
  sampleMs?: number;
  traceEveryMs?: number;
  firstSampleMs?: number;
  onWriteError?: (error: unknown) => void;
}): { stop(): void } {
  const { clock } = options;
  const sample = options.sample ?? sampleProcessMemory;
  const sampleMs = options.sampleMs ?? PROCESS_MEMORY_SAMPLE_MS;
  const traceEveryMs = options.traceEveryMs ?? PROCESS_MEMORY_TRACE_EVERY_MS;
  let lastTraceAt: number | null = null;
  let timer: unknown = null;
  let stopped = false;

  const tick = () => {
    timer = null;
    if (stopped) return;
    const now = clock.now();
    const current = sample(now);
    if (options.samplePath) {
      try {
        writeProcessMemorySample(options.samplePath, current);
      } catch (error) {
        options.onWriteError?.(error);
      }
    }
    if (lastTraceAt === null || now - lastTraceAt >= traceEveryMs) {
      lastTraceAt = now;
      options.trace({ ...options.context?.(), ...processMemoryTraceAttrs(current) });
    }
    timer = clock.setTimeout(tick, sampleMs);
  };

  timer = clock.setTimeout(tick, options.firstSampleMs ?? PROCESS_MEMORY_FIRST_SAMPLE_MS);
  return {
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
