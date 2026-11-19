/**
 * Statistics for paired measurements (src/verdict.ts): how large the shift
 * between the two arms is, and how sure the pairs make us. Rank-based, so a
 * single wild pair moves nothing much and no distribution is assumed
 * (the method sitespeed.io's compare uses for paired runs). Pure; pinned by
 * stats.test.ts.
 */

/**
 * The null distribution of the Wilcoxon signed-rank statistic for `n` pairs
 * without ties: `counts[t]` is the number of sign assignments whose positive
 * ranks sum to `t`, out of 2^n.
 */
export function signedRankCounts(n: number): number[] {
  const max = (n * (n + 1)) / 2;
  let counts = new Array<number>(max + 1).fill(0);
  counts[0] = 1;
  for (let rank = 1; rank <= n; rank++) {
    const next = counts.slice();
    for (let t = rank; t <= max; t++) next[t] += counts[t - rank];
    counts = next;
  }
  return counts;
}

/** Every pairwise average of the differences, each with itself included, sorted: the Walsh averages. */
export function walshAverages(differences: readonly number[]): number[] {
  const averages: number[] = [];
  for (let i = 0; i < differences.length; i++) for (let j = i; j < differences.length; j++) averages.push((differences[i] + differences[j]) / 2);
  return averages.sort((a, b) => a - b);
}

export interface PairedShift {
  /** Hodges-Lehmann estimate of the shift: the median of the Walsh averages. Null without differences. */
  shift: number | null;
  /**
   * A distribution-free interval for the shift at `level` or more (Wilcoxon signed-rank).
   * Null when the pairs are too few for any interval at that level: five pairs cannot give 95%.
   * The null distribution assumes no tied differences; with ties or rounded values the interval
   * covers more than it says (conservative), never less.
   */
  interval: [number, number] | null;
  /** The confidence the interval really has (it is at least `level`; the statistic is discrete). */
  coverage: number | null;
}

/**
 * The shift between the arms from the per-pair differences, with an interval.
 * The interval runs between the (c+1)th smallest and the (c+1)th largest
 * Walsh average, c being the largest rank sum whose two tails together stay
 * within 1 - level under the null distribution (c = 0: the whole range).
 */
export function pairedShift(differences: readonly number[], level = 0.95): PairedShift {
  const n = differences.length;
  if (n === 0) return { shift: null, interval: null, coverage: null };
  const averages = walshAverages(differences);
  const mid = Math.floor(averages.length / 2);
  const shift = averages.length % 2 ? averages[mid] : (averages[mid - 1] + averages[mid]) / 2;
  // 2^n sign assignments are counted exactly in doubles up to 2^53 and stop being finite at 2^1024:
  // past a thousand pairs (no measurement here comes near) there is an estimate and no interval.
  if (n > 1000) return { shift, interval: null, coverage: null };
  const counts = signedRankCounts(n);
  const total = 2 ** n;
  // cumulative[t] = P(T <= t); find the largest c with 2 * P(T <= c) <= 1 - level
  let cumulative = 0;
  let c = -1;
  let tail = 0;
  for (let t = 0; t < counts.length; t++) {
    cumulative += counts[t] / total;
    if (2 * cumulative > 1 - level + 1e-12) break;
    c = t;
    tail = cumulative;
  }
  if (c < 0) return { shift, interval: null, coverage: null };
  return { shift, interval: [averages[c], averages[averages.length - 1 - c]], coverage: 1 - 2 * tail };
}

/** The fewest pairs that can give an interval at `level`: with fewer, even pairs that all agree prove nothing at that level. */
export function minPairsForInterval(level = 0.95): number {
  for (let n = 1; n < 64; n++) if (2 / 2 ** n <= 1 - level + 1e-12) return n;
  return 64;
}
