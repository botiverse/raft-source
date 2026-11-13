import { describe, expect, it } from "vitest";
import { mergeIntervals, subtractIntervals, timeLedger } from "./ledger";

describe("intervals", () => {
  it("merges overlaps and clips to the limit", () => {
    expect(mergeIntervals([[50, 80], [-10, 20], [10, 30], [90, 200]], 100)).toEqual([[0, 30], [50, 80], [90, 100]]);
  });
  it("subtracts a cover", () => {
    expect(subtractIntervals([[0, 100]], [[10, 20], [50, 60]])).toEqual([[0, 10], [20, 50], [60, 100]]);
    expect(subtractIntervals([[0, 10], [20, 30]], [[5, 25]])).toEqual([[0, 5], [25, 30]]);
  });
});

describe("timeLedger", () => {
  it("every millisecond lands in exactly one segment: the segments add up to the total", () => {
    const l = timeLedger(1000, [{ startMs: 0, responseMs: 100, endMs: 300 }, { startMs: 300, responseMs: 500, endMs: 600 }], [{ startMs: 250, durationMs: 100 }, { startMs: 700, durationMs: 200 }]);
    expect(l.mainThreadMs + l.downloadMs + l.networkWaitMs + l.unexplainedMs).toBe(l.totalMs);
    // main thread 250-350 and 700-900 = 300; download 100-250 and 500-600 = 250; waiting 0-100 and 350-500 = 250; rest 200
    expect(l).toMatchObject({ totalMs: 1000, mainThreadMs: 300, downloadMs: 250, networkWaitMs: 250, unexplainedMs: 200, unexplainedShare: 0.2 });
  });
  it("main thread wins over a download, a download over waiting", () => {
    const l = timeLedger(100, [{ startMs: 0, responseMs: 0, endMs: 100 }, { startMs: 0, responseMs: null, endMs: 100 }], [{ startMs: 0, durationMs: 60 }]);
    expect(l).toMatchObject({ mainThreadMs: 60, downloadMs: 40, networkWaitMs: 0, unexplainedMs: 0 });
  });
  it("parallel requests are counted once, not summed", () => {
    const l = timeLedger(200, [{ startMs: 0, responseMs: 100, endMs: 200 }, { startMs: 0, responseMs: 100, endMs: 200 }, { startMs: 0, responseMs: 100, endMs: 200 }], []);
    expect(l).toMatchObject({ networkWaitMs: 100, downloadMs: 100, unexplainedMs: 0 });
  });
  it("the segments add up exactly, for any fractional input (property)", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 3000; i++) {
      const ready = rnd() * 2000;
      const requests = Array.from({ length: Math.floor(rnd() * 6) }, () => { const start = rnd() * 2200 - 100; const response = rnd() < 0.2 ? null : start + rnd() * 400; return { startMs: start, responseMs: response, endMs: (response ?? start) + rnd() * 600 }; });
      const tasks = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ startMs: rnd() * 2000, durationMs: 50 + rnd() * 300 }));
      const l = timeLedger(ready, requests, tasks);
      expect(l.mainThreadMs + l.downloadMs + l.networkWaitMs + l.unexplainedMs).toBe(l.totalMs);
      expect(Math.min(l.mainThreadMs, l.downloadMs, l.networkWaitMs, l.unexplainedMs)).toBeGreaterThanOrEqual(0);
    }
  });
  it("the reviewer's half-millisecond case sums exactly; a non-finite ready is an empty ledger", () => {
    const l = timeLedger(301.5, [{ startMs: 0, responseMs: 100.5, endMs: 201 }], [{ startMs: 201, durationMs: 100.5 }]);
    expect(l.mainThreadMs + l.downloadMs + l.networkWaitMs + l.unexplainedMs).toBe(l.totalMs);
    expect(timeLedger(Number.NaN, [], [])).toMatchObject({ totalMs: 0, unexplainedMs: 0, unexplainedShare: 0 });
  });
  it("what happens after ready does not count; nothing observed is unexplained", () => {
    expect(timeLedger(100, [{ startMs: 150, responseMs: 160, endMs: 300 }], [{ startMs: 120, durationMs: 80 }])).toMatchObject({ totalMs: 100, unexplainedMs: 100, unexplainedShare: 1 });
  });
});
