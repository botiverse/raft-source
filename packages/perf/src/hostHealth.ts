/**
 * Was the measuring machine itself busy? Two signals are taken beside every
 * load. Where Linux reports it, the share of the load's time in which tasks
 * were stalled waiting for a CPU or for memory (pressure stall information).
 * Elsewhere a fixed piece of work is timed (sitespeed.io's CPU benchmark,
 * Lighthouse's benchmarkIndex): on an idle host it takes the same time every
 * time, so a sample well above the session's median means something else had
 * the CPU. A load taken on a busy host says more about the host than about
 * the page: pairs with one are left out of the verdict rather than averaged
 * in. Pure apart from `hostBenchmark` and `readPressure`; pinned by
 * hostHealth.test.ts.
 */

import { readFileSync } from "node:fs";

/** A sample counts as busy above this multiple of the session median… */
export const BUSY_RATIO = 1.5;
/** …and at least this many milliseconds above it (a 2 ms median must not make 3.1 ms "busy"). */
export const BUSY_MARGIN_MS = 5;

/** Milliseconds a fixed amount of integer work takes right now. A few tens of milliseconds on an idle laptop-class core. */
export function hostBenchmark(): number {
  const started = performance.now();
  let hash = 0x811c9dc5;
  for (let i = 0; i < 6_000_000; i++) hash = Math.imul(hash ^ (i & 0xff), 0x01000193);
  // the result is used, so the loop cannot be dropped
  return Math.round((performance.now() - started + (hash === 0 ? 1 : 0)) * 10) / 10;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface HostHealth {
  /** The session's median benchmark time: the idle level. Null without samples. */
  medianMs: number | null;
  /** Per sample, in the order given: the host was busy then. */
  busy: boolean[];
}

/** Which samples were taken on a busy host: above BUSY_RATIO times the median and BUSY_MARGIN_MS over it. */
export function hostHealth(samples: readonly number[]): HostHealth {
  if (samples.length === 0) return { medianMs: null, busy: [] };
  const mid = median(samples);
  return { medianMs: mid, busy: samples.map((s) => s > mid * BUSY_RATIO && s > mid + BUSY_MARGIN_MS) };
}

/**
 * What a stored row says about the machine that measured it (`extra` of perf.page_runs): how many CPUs the tool could
 * use and how long the fixed piece of work took on it (the session's median). Timings from two machines are two
 * series: a reader splits a trend where these step, since a row has no other trace of where it was taken.
 */
export function hostExtra(cpus: number, benchmarkMedianMs: number | null): { host_cpu_count: number; host_benchmark_ms: number | null } {
  return { host_cpu_count: cpus, host_benchmark_ms: benchmarkMedianMs };
}

/** The idle level of this host without a session of loads to take it from: the median of a few benchmark runs, after one unmeasured. */
export function hostBenchmarkMedian(bench: () => number = hostBenchmark, samples = 5): number {
  bench();
  return median(Array.from({ length: samples }, () => bench()));
}

/** Stall totals of the host since boot, in microseconds (Linux pressure stall information). */
export interface Pressure {
  cpu: number;
  memory: number;
}

/**
 * Linux reports how long tasks were stalled waiting for a CPU or for memory
 * (/proc/pressure). Unlike the benchmark it does not depend on which core
 * this process happened to run on (on a machine with fast and slow cores the
 * same work takes 7 or 14 ms by luck). Null where the files do not exist
 * (macOS, some containers): the benchmark is used there.
 *
 * The totals are the whole machine's, this tool's own browser included: a
 * load whose own runnable threads fill every core for a couple of seconds
 * raises them by itself (measured on a 12-core host: 12 busy threads for 2 s
 * of a 9 s window gave 11%). On a runner with few cores read `lopsided`.
 */
export function readPressure(read: (path: string) => string = (path) => readFileSync(path, "utf8")): Pressure | null {
  try {
    const total = (path: string): number => {
      const match = /^some .*total=(\d+)/m.exec(read(path));
      if (!match) throw new Error("no total");
      return Number(match[1]);
    };
    return { cpu: total("/proc/pressure/cpu"), memory: total("/proc/pressure/memory") };
  } catch {
    return null;
  }
}

/** A load counts as busy when tasks on the host were stalled for this share of its wall time or more, for CPU or for memory. */
export const BUSY_STALL_SHARE = 0.1;

/** What was seen of the host beside one load. */
export interface HostSample {
  /** The benchmark's time: the larger of the runs just before and just after the load. */
  benchMs: number;
  /** Share of the load's wall time in which some task waited for a CPU / for memory; null without pressure information. */
  cpuStall: number | null;
  memoryStall: number | null;
}

/** The stall shares between two pressure readings `wallMs` apart. */
export function stallShares(before: Pressure | null, after: Pressure | null, wallMs: number): { cpuStall: number | null; memoryStall: number | null } {
  if (!before || !after || wallMs <= 0) return { cpuStall: null, memoryStall: null };
  const share = (a: number, b: number): number => Math.round(((b - a) / 1000 / wallMs) * 1000) / 1000;
  return { cpuStall: share(before.cpu, after.cpu), memoryStall: share(before.memory, after.memory) };
}

export interface BusyLoads {
  /** What decided: the host's stall shares, or the benchmark where the host reports none. */
  by: "pressure" | "benchmark";
  busy: boolean[];
  benchmarkMedianMs: number | null;
}

/** Which loads ran on a busy host. With pressure information for every load it decides; otherwise the benchmark does. */
export function busyLoads(samples: readonly HostSample[]): BusyLoads {
  const bench = hostHealth(samples.map((s) => s.benchMs));
  if (samples.length && samples.every((s) => s.cpuStall !== null && s.memoryStall !== null)) return { by: "pressure", busy: samples.map((s) => s.cpuStall! >= BUSY_STALL_SHARE || s.memoryStall! >= BUSY_STALL_SHARE), benchmarkMedianMs: bench.medianMs };
  return { by: "benchmark", busy: bench.busy, benchmarkMedianMs: bench.medianMs };
}

export interface BusyPairs {
  by: BusyLoads["by"];
  benchmarkMedianMs: number | null;
  /** Per arm, per load: busy. */
  busyOn: boolean[];
  busyOff: boolean[];
  /** Indexes of the pairs in which either load was busy. */
  dropped: number[];
}

/** Which pairs had a load on a busy host. `hostOn[i]` and `hostOff[i]` are what was seen beside the loads of pair i. */
export function busyPairs(hostOn: readonly HostSample[], hostOff: readonly HostSample[]): BusyPairs {
  const seen = busyLoads([...hostOn, ...hostOff]);
  const busyOn = seen.busy.slice(0, hostOn.length);
  const busyOff = seen.busy.slice(hostOn.length);
  const dropped: number[] = [];
  for (let i = 0; i < Math.min(hostOn.length, hostOff.length); i++) if (busyOn[i] || busyOff[i]) dropped.push(i);
  return { by: seen.by, benchmarkMedianMs: seen.benchmarkMedianMs, busyOn, busyOff, dropped };
}

/** The worse of two samples taken beside the two parts of one run: the larger benchmark and the larger stall shares. */
export function worseSample(a: HostSample, b: HostSample): HostSample {
  const worse = (x: number | null, y: number | null): number | null => (x === null || y === null ? null : Math.max(x, y));
  return { benchMs: Math.max(a.benchMs, b.benchMs), cpuStall: worse(a.cpuStall, b.cpuStall), memoryStall: worse(a.memoryStall, b.memoryStall) };
}

export interface BusyRuns extends BusyLoads {
  /** Indexes of the runs to leave out of the medians: the busy ones, unless every run was busy or `keep` is set. */
  leftOut: number[];
  /** Every run was busy: none is better than another, so all stay in and the numbers are not to be trusted. */
  allBusy: boolean;
}

/**
 * For a collection that is not an A/B (`interact`): which runs were taken on a
 * busy host and which to leave out of the medians. A median over the quiet
 * runs is what the page did; when no run was quiet there is nothing to prefer.
 */
export function busyRuns(samples: readonly HostSample[], keep = false): BusyRuns {
  const seen = busyLoads(samples);
  const busy = seen.busy.flatMap((b, i) => (b ? [i] : []));
  const allBusy = samples.length > 0 && busy.length === samples.length;
  return { ...seen, leftOut: keep || allBusy ? [] : busy, allBusy };
}

/** `values` with the pairs at `dropped` set to null. */
export function withoutPairs<T>(values: ReadonlyArray<T | null>, dropped: readonly number[]): (T | null)[] {
  return values.map((v, i) => (dropped.includes(i) ? null : v));
}

/**
 * Busy loads that fall mostly on one arm are a warning sign of their own: the
 * pressure is the whole machine's, the measuring browser included, so on a
 * machine with few cores the heavier arm can flag itself, and dropping its
 * pairs would tilt the verdict. True when there are at least three busy loads
 * and four fifths or more of them are on one arm.
 */
export function lopsided(busyOn: readonly boolean[], busyOff: readonly boolean[]): "on" | "off" | null {
  const on = busyOn.filter(Boolean).length;
  const off = busyOff.filter(Boolean).length;
  if (on + off < 3) return null;
  if (on >= 0.8 * (on + off)) return "on";
  if (off >= 0.8 * (on + off)) return "off";
  return null;
}
