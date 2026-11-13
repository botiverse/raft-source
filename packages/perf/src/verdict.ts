/**
 * The verdict of a paired on/off page measurement (src/measure.ts,
 * docs/frontend/perf-measure.md). Pure, so a unit test pins the rule.
 *
 * Runs are taken in pairs, the two arms alternating, so a slow minute of the
 * network or the server hits both sides. A pair's delta is `on - off` (lower
 * is better). The change is judged by the median delta against a noise floor
 * of max(30 ms, 2% of the off median) — the floor perf-kit uses — and the
 * pairs must agree: at least 80% of them on the same side.
 */

export type Verdict = "better" | "same" | "worse" | "unknown";

export interface MetricVerdict {
  verdict: Verdict;
  /** Why the verdict is unknown, or the rule that decided it. */
  reason: string;
  pairs: number;
  medianOn: number | null;
  medianOff: number | null;
  medianDelta: number | null;
  noiseFloor: number | null;
  /** Pairs whose delta is below -noiseFloor (faster) / above +noiseFloor (slower). */
  fasterPairs: number;
  slowerPairs: number;
}

export const MIN_PAIRS = 3;
export const NOISE_FLOOR_MS = 30;
export const NOISE_FLOOR_RATIO = 0.02;
export const AGREEMENT = 0.8;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * `on[i]` and `off[i]` are one pair. A pair with a missing value on either
 * side is dropped; fewer than MIN_PAIRS complete pairs is `unknown`, never a
 * guess.
 */
export function pairedVerdict(on: ReadonlyArray<number | null>, off: ReadonlyArray<number | null>): MetricVerdict {
  const deltas: number[] = [];
  const onValues: number[] = [];
  const offValues: number[] = [];
  for (let i = 0; i < Math.min(on.length, off.length); i++) {
    const a = on[i];
    const b = off[i];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    onValues.push(a);
    offValues.push(b);
    deltas.push(a - b);
  }
  const base = {
    pairs: deltas.length,
    medianOn: median(onValues),
    medianOff: median(offValues),
    medianDelta: median(deltas),
    fasterPairs: 0,
    slowerPairs: 0,
  };
  if (deltas.length < MIN_PAIRS) {
    return { ...base, noiseFloor: null, verdict: "unknown", reason: `${deltas.length} complete pair(s), need ${MIN_PAIRS}` };
  }
  const noiseFloor = Math.max(NOISE_FLOOR_MS, NOISE_FLOOR_RATIO * (base.medianOff as number));
  const fasterPairs = deltas.filter((d) => d < -noiseFloor).length;
  const slowerPairs = deltas.filter((d) => d > noiseFloor).length;
  const needed = Math.ceil(AGREEMENT * deltas.length);
  const delta = base.medianDelta as number;
  const result = { ...base, noiseFloor, fasterPairs, slowerPairs };
  if (delta < -noiseFloor && fasterPairs >= needed) {
    return { ...result, verdict: "better", reason: `median delta ${Math.round(delta)} ms below -${Math.round(noiseFloor)} ms, ${fasterPairs}/${deltas.length} pairs faster` };
  }
  if (delta > noiseFloor && slowerPairs >= needed) {
    return { ...result, verdict: "worse", reason: `median delta +${Math.round(delta)} ms above ${Math.round(noiseFloor)} ms, ${slowerPairs}/${deltas.length} pairs slower` };
  }
  return { ...result, verdict: "same", reason: `median delta ${Math.round(delta)} ms within ±${Math.round(noiseFloor)} ms or pairs disagree (${fasterPairs} faster, ${slowerPairs} slower of ${deltas.length})` };
}

/** Worse on any metric is worse; better needs at least one better and no worse; any unknown with no worse is unknown. */
export function overallVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("worse")) return "worse";
  if (verdicts.includes("unknown")) return "unknown";
  if (verdicts.includes("better")) return "better";
  return "same";
}
