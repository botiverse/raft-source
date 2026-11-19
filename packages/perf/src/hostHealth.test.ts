import { busyLoads, busyPairs, busyRuns, hostBenchmark, hostBenchmarkMedian, hostExtra, hostHealth, lopsided, readPressure, stallShares, withoutPairs, worseSample } from "./hostHealth";

describe("hostHealth", () => {
  it("marks a sample well above the session's median as busy, and not ordinary jitter", () => {
    expect(hostHealth([20, 21, 19, 22, 20, 48, 20])).toEqual({ medianMs: 20, busy: [false, false, false, false, false, true, false] });
    expect(hostHealth([20, 24, 18, 26, 22]).busy).toEqual([false, false, false, false, false]);
  });
  it("needs the margin too: on a fast host half a millisecond more is not busy", () => {
    // 3.2 is over 1.5 x 2 but only 1.2 ms above the median
    expect(hostHealth([2, 2, 2, 3.2, 2]).busy).toEqual([false, false, false, false, false]);
    expect(hostHealth([2, 2, 2, 9, 2]).busy).toEqual([false, false, false, true, false]);
  });
  it("has nothing to say without samples", () => {
    expect(hostHealth([])).toEqual({ medianMs: null, busy: [] });
  });
});

const quietLoad = (benchMs = 20): { benchMs: number; cpuStall: number | null; memoryStall: number | null } => ({ benchMs, cpuStall: 0.01, memoryStall: 0 });
const noPressure = (benchMs: number) => ({ benchMs, cpuStall: null, memoryStall: null });

describe("readPressure and stallShares", () => {
  const files: Record<string, string> = { "/proc/pressure/cpu": "some avg10=3.32 avg60=5.36 avg300=4.81 total=2000000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n", "/proc/pressure/memory": "some avg10=0.00 avg60=0.00 avg300=0.00 total=500000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=400000\n" };
  it("reads the stall totals, and is null where the host has none", () => {
    expect(readPressure((path) => files[path])).toEqual({ cpu: 2_000_000, memory: 500_000 });
    expect(readPressure(() => { throw new Error("ENOENT"); })).toBeNull();
    expect(readPressure(() => "garbage")).toBeNull();
  });
  it("turns two readings into the share of the wall time tasks were stalled", () => {
    // 300 ms of CPU stall and 50 ms of memory stall during a 2 s load
    expect(stallShares({ cpu: 2_000_000, memory: 500_000 }, { cpu: 2_300_000, memory: 550_000 }, 2000)).toEqual({ cpuStall: 0.15, memoryStall: 0.025 });
    expect(stallShares(null, { cpu: 1, memory: 1 }, 2000)).toEqual({ cpuStall: null, memoryStall: null });
  });
});

describe("busyLoads", () => {
  it("goes by the stall share when every load has one, whatever the benchmark says", () => {
    // the benchmark doubles on the second load (a slower core), yet nothing was stalled: not busy
    const r = busyLoads([quietLoad(7), quietLoad(14.5), { benchMs: 7, cpuStall: 0.22, memoryStall: 0 }, { benchMs: 7, cpuStall: 0.02, memoryStall: 0.1 }]);
    expect(r).toMatchObject({ by: "pressure", busy: [false, false, true, true] });
  });
  it("falls back to the benchmark when a load has no stall share", () => {
    expect(busyLoads([noPressure(20), noPressure(21), noPressure(48), quietLoad(20)])).toMatchObject({ by: "benchmark", busy: [false, false, true, false], benchmarkMedianMs: 20.5 });
  });
});

describe("busyPairs and withoutPairs", () => {
  it("drops the whole pair when either of its loads ran on a busy host, whichever arm", () => {
    const seen = busyPairs([20, 60, 21, 20].map(noPressure), [19, 20, 20, 70].map(noPressure));
    expect(seen).toMatchObject({ by: "benchmark", dropped: [1, 3], busyOn: [false, true, false, false], busyOff: [false, false, false, true], benchmarkMedianMs: 20 });
    expect(withoutPairs([400, 410, 390, 405], seen.dropped)).toEqual([400, null, 390, null]);
    expect(withoutPairs([600, null, 590, 610], seen.dropped)).toEqual([600, null, 590, null]);
  });
  it("drops nothing on a quiet host, and judges only complete pairs while a round is half taken", () => {
    expect(busyPairs([quietLoad(), quietLoad(), quietLoad()], [quietLoad(), quietLoad(), quietLoad()])).toMatchObject({ by: "pressure", dropped: [] });
    // the third pair's off load is not taken yet: its busy on load drops no pair
    expect(busyPairs([quietLoad(), quietLoad(), { benchMs: 20, cpuStall: 0.5, memoryStall: 0 }], [quietLoad(), quietLoad()]).dropped).toEqual([]);
  });
});

describe("lopsided", () => {
  it("names the arm that has four fifths of the busy loads, from three busy loads up", () => {
    expect(lopsided([true, true, true, false], [false, false, false, false])).toBe("on");
    expect(lopsided([false, false, false, false, false], [true, true, true, true, false])).toBe("off");
    expect(lopsided([true, true, false, false], [true, true, false, false])).toBeNull();
    expect(lopsided([true, true, false], [false, false, false])).toBeNull();
  });
});

describe("hostBenchmark", () => {
  it("returns a positive time for its fixed work", () => {
    const ms = hostBenchmark();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
  });
});

describe("busyRuns", () => {
  const quiet = { benchMs: 7, cpuStall: 0.01, memoryStall: 0 };
  const stalled = { benchMs: 7, cpuStall: 0.3, memoryStall: 0 };
  it("leaves the busy runs out and keeps the quiet ones", () => {
    expect(busyRuns([quiet, stalled, quiet])).toMatchObject({ by: "pressure", busy: [false, true, false], leftOut: [1], allBusy: false });
  });
  it("keeps every run when asked to, and still says which were busy", () => {
    expect(busyRuns([quiet, stalled, quiet], true)).toMatchObject({ busy: [false, true, false], leftOut: [], allBusy: false });
  });
  it("leaves nothing out when every run was busy: there is no quiet run to prefer", () => {
    expect(busyRuns([stalled, stalled])).toMatchObject({ leftOut: [], allBusy: true });
  });
  it("has nothing to say about no runs", () => {
    expect(busyRuns([])).toMatchObject({ busy: [], leftOut: [], allBusy: false });
  });
});

describe("worseSample", () => {
  it("takes the larger benchmark and stall shares of a run's two parts", () => {
    expect(worseSample({ benchMs: 7, cpuStall: 0.02, memoryStall: 0.2 }, { benchMs: 14, cpuStall: 0.3, memoryStall: 0 })).toEqual({ benchMs: 14, cpuStall: 0.3, memoryStall: 0.2 });
  });
  it("has no stall share when either part had no pressure information", () => {
    expect(worseSample({ benchMs: 7, cpuStall: null, memoryStall: null }, { benchMs: 9, cpuStall: 0.3, memoryStall: 0 })).toEqual({ benchMs: 9, cpuStall: null, memoryStall: null });
  });
});

describe("hostExtra and hostBenchmarkMedian", () => {
  it("names the machine's two numbers with their unit, as a row's extra wants them", () => {
    expect(hostExtra(10, 4.2)).toEqual({ host_cpu_count: 10, host_benchmark_ms: 4.2 });
    expect(hostExtra(2, null)).toEqual({ host_cpu_count: 2, host_benchmark_ms: null });
  });
  it("takes the median of the samples after one unmeasured run", () => {
    const times = [90, 5, 4, 30, 6, 5];
    let calls = 0;
    expect(hostBenchmarkMedian(() => times[calls++])).toBe(5);
    expect(calls).toBe(6);
  });
});
