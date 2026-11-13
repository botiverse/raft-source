import type { Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export type CpuProfile = Profiler.Profile;

export interface TimedCpuProfile {
  profile: CpuProfile;
  // Main thread time blocked to start and to stop the profiler: V8 registers all
  // existing code on start, and the profile is serialized and parsed on stop.
  startMs: number;
  stopMs: number;
}

/**
 * Sample this process's main thread with V8's CPU profiler for `durationMs`
 * (V8 default sampling interval) and return the `.cpuprofile` object. The
 * session is always disconnected, also when a step throws. Callers serialize
 * captures with tryAcquireCpuProfiler: V8 keeps one profiler per isolate.
 */
export async function captureCpuProfile(
  durationMs: number,
  options: { samplingIntervalUs?: number } = {},
): Promise<CpuProfile> {
  return (await captureTimedCpuProfile(durationMs, options)).profile;
}

export async function captureTimedCpuProfile(
  durationMs: number,
  options: { samplingIntervalUs?: number } = {},
): Promise<TimedCpuProfile> {
  const startedAt = performance.now();
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    if (options.samplingIntervalUs) {
      await session.post("Profiler.setSamplingInterval", { interval: options.samplingIntervalUs });
    }
    await session.post("Profiler.start");
    const startMs = performance.now() - startedAt;
    await delay(durationMs, undefined, { ref: false });
    const stoppingAt = performance.now();
    const { profile } = await session.post("Profiler.stop");
    return { profile, startMs, stopMs: performance.now() - stoppingAt };
  } finally {
    session.disconnect();
  }
}

let profilerHeld = false;
let profilerReleasedAt = -Infinity;

/**
 * One capture per process: two overlapping captures would each perturb the
 * other's samples. Returns the release function, or null when one is running.
 */
export function tryAcquireCpuProfiler(): (() => void) | null {
  if (profilerHeld) return null;
  profilerHeld = true;
  return () => {
    profilerHeld = false;
    profilerReleasedAt = performance.now();
  };
}

// Readings right after a capture may still be affected; a margin costs only a few
// excluded readings.
const PROFILING_TAIL_MS = 30_000;

/** Whether a capture ran since `sincePerfNow` (performance.now() time), or ended just before it. */
export function cpuProfilerActiveSince(sincePerfNow: number): boolean {
  return profilerHeld || profilerReleasedAt + PROFILING_TAIL_MS >= sincePerfNow;
}
