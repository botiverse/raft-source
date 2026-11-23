import { describe, expect, it } from "vitest";
import { analyzeSoakSamples, olsSlope } from "./soakStats";

const MB = 1024 * 1024;

describe("soakStats", () => {
  it("detects steady-state monotonic memory leaks while skipping round 0 warmup in OLS slope", () => {
    expect(olsSlope([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(2, 6);

    const leak = analyzeSoakSamples([
      { round: 0, jsHeapUsedBytes: 20 * MB, jsHeapTotalBytes: 40 * MB, domNodes: 1000, jsEventListeners: 100, documents: 1 },
      // Warmup jump of +10MB on round 1, then +2MB/round linear leak across rounds 1..5
      { round: 1, jsHeapUsedBytes: 30 * MB, jsHeapTotalBytes: 48 * MB, domNodes: 1200, jsEventListeners: 110, documents: 1 },
      { round: 2, jsHeapUsedBytes: 32 * MB, jsHeapTotalBytes: 48 * MB, domNodes: 1250, jsEventListeners: 120, documents: 1 },
      { round: 3, jsHeapUsedBytes: 34 * MB, jsHeapTotalBytes: 56 * MB, domNodes: 1300, jsEventListeners: 130, documents: 1 },
      { round: 4, jsHeapUsedBytes: 36 * MB, jsHeapTotalBytes: 56 * MB, domNodes: 1350, jsEventListeners: 140, documents: 1 },
      { round: 5, jsHeapUsedBytes: 38 * MB, jsHeapTotalBytes: 64 * MB, domNodes: 1400, jsEventListeners: 150, documents: 1 },
    ]);

    expect(leak.rounds).toBe(5);
    expect(leak.jsHeapStartMb).toBe(20);
    expect(leak.jsHeapEndMb).toBe(38);
    expect(leak.jsHeapDeltaMb).toBe(18);
    // Slope computed over post-warmup rounds 1..5 = exact 2.0 MB/round (not distorted by round 0 -> 1 warmup!)
    expect(leak.jsHeapSlopeMbPerRound).toBe(2);
    expect(leak.domNodesDelta).toBe(400);
    expect(leak.domNodesSlopePerRound).toBe(50);
    expect(leak.jsListenersDelta).toBe(50);
    expect(leak.monotonicHeapGrowth).toBe(true);
  });

  it("reports zero slope and non-monotonic when heap stabilizes after warmup", () => {
    const flat = analyzeSoakSamples([
      { round: 0, jsHeapUsedBytes: 20 * MB, jsHeapTotalBytes: 40 * MB, domNodes: 1000, jsEventListeners: 100, documents: 1 },
      { round: 1, jsHeapUsedBytes: 28 * MB, jsHeapTotalBytes: 48 * MB, domNodes: 1200, jsEventListeners: 110, documents: 1 },
      { round: 2, jsHeapUsedBytes: 27.8 * MB, jsHeapTotalBytes: 48 * MB, domNodes: 1198, jsEventListeners: 110, documents: 1 },
      { round: 3, jsHeapUsedBytes: 28.1 * MB, jsHeapTotalBytes: 48 * MB, domNodes: 1201, jsEventListeners: 110, documents: 1 },
      { round: 4, jsHeapUsedBytes: 27.9 * MB, jsHeapTotalBytes: 48 * MB, domNodes: 1200, jsEventListeners: 110, documents: 1 },
    ]);

    expect(Math.abs(flat.jsHeapSlopeMbPerRound)).toBeLessThan(0.1);
    expect(flat.monotonicHeapGrowth).toBe(false);
  });
});
