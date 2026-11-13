import { describe, expect, it } from "vitest";
import { frameStats, median } from "./frames";

describe("frameStats", () => {
  it("slow share is by time: frames over two 60 Hz frames, weighted by their length", () => {
    const s = frameStats([...Array(18).fill(16.7), 50, 100])!;
    expect(s).toMatchObject({ frames: 20, p50Ms: 16.7, maxMs: 100 });
    expect(s.p95Ms).toBe(100);
    expect(s.slowPct).toBe(33.3); // 150 ms of 450.6 ms
  });
  it("one long frame counts for the smooth frames it replaced", () => {
    expect(frameStats([...Array(9).fill(16.7), 150.3])!.slowPct).toBe(50);
  });
  it("33.4 ms itself is not slow", () => {
    expect(frameStats(Array(10).fill(33.4))!.slowPct).toBe(0);
  });
  it("too few frames is no result, not a clean one", () => {
    expect(frameStats([16.7, 16.7])).toBeNull();
  });
});

describe("median", () => {
  it("odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
