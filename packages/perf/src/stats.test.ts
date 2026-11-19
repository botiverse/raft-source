import { minPairsForInterval, pairedShift, signedRankCounts, walshAverages } from "./stats";

describe("signedRankCounts", () => {
  it("counts the sign assignments for each rank sum", () => {
    // n = 3: sums 0..6 from subsets of {1,2,3}: {} 0; {1} 1; {2} 2; {3},{1,2} 3; {1,3} 4; {2,3} 5; {1,2,3} 6
    expect(signedRankCounts(3)).toEqual([1, 1, 1, 2, 1, 1, 1]);
    expect(signedRankCounts(10).reduce((a, b) => a + b, 0)).toBe(1024);
  });
});

describe("pairedShift", () => {
  it("estimates the shift as the median of the Walsh averages, which one wild pair hardly moves", () => {
    expect(walshAverages([1, 3])).toEqual([1, 2, 3]);
    expect(pairedShift([-100, -110, -90, -105, -95, -100]).shift).toBe(-100);
    expect(pairedShift([-100, -110, -90, -105, -95, 900]).shift).toBeCloseTo(-97.5, 5);
  });
  it("gives no 95% interval for five pairs, and one for six", () => {
    expect(minPairsForInterval(0.95)).toBe(6);
    expect(pairedShift([-100, -110, -90, -105, -95]).interval).toBeNull();
    const six = pairedShift([-100, -110, -90, -105, -95, -102]);
    // six pairs: only c = 0 fits (2/64), so the interval is the full range of the Walsh averages
    expect(six.interval).toEqual([-110, -90]);
    expect(six.coverage).toBeCloseTo(1 - 2 / 64, 10);
  });
  it("matches the published interval of a textbook sample", () => {
    // Hollander & Wolfe, Hamilton depression data (n = 9 differences): estimate -0.46, 96.1% interval (-0.786, -0.010)
    const d = [0.878 - 1.83, 0.647 - 0.5, 0.598 - 1.62, 2.05 - 2.48, 1.06 - 1.68, 1.29 - 1.88, 1.06 - 1.55, 3.14 - 3.06, 1.29 - 1.3];
    const s = pairedShift(d, 0.95);
    expect(s.shift).toBeCloseTo(-0.46, 2);
    expect(s.interval![0]).toBeCloseTo(-0.786, 3);
    expect(s.interval![1]).toBeCloseTo(-0.01, 3);
    expect(s.coverage).toBeCloseTo(0.961, 3);
  });
  it("narrows as pairs are added", () => {
    const base = [-100, -110, -90, -105, -95, -102, -98, -101, -99, -104, -96, -103];
    const wide = pairedShift(base.slice(0, 6)).interval!;
    const narrow = pairedShift(base).interval!;
    expect(narrow[1] - narrow[0]).toBeLessThan(wide[1] - wide[0]);
  });
  it("has nothing to say without differences", () => {
    expect(pairedShift([])).toEqual({ shift: null, interval: null, coverage: null });
  });
});
