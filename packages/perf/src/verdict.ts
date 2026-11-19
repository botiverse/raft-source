/**
 * The verdict of a paired on/off page measurement (src/measure.ts,
 * docs/frontend/perf-measure.md). Pure, so a unit test pins the rule.
 *
 * Runs are taken in pairs, the two arms alternating, so a slow minute of the
 * network or the server hits both sides. A pair's delta is `on - off` (lower
 * is better). The change is judged by the median delta against a noise floor
 * of max(30 ms, 2% of the off median) — the floor perf-kit uses — and the
 * pairs must agree: at least 80% of them on the same side.
 *
 * Beside the verdict stands how settled it is (`confidence`): the rule
 * always answers, and five pairs that happen to agree read as "better" as
 * firmly as twenty do. The interval of the shift says which it is.
 */

import { minPairsForInterval, pairedShift } from "./stats";

export type Verdict = "better" | "same" | "worse" | "unknown";

/**
 * How far the pairs settle the verdict, from the 95% interval of the shift
 * (src/stats.ts) against the noise floor. `settled`: the whole interval is
 * on the verdict's side of the floor (beyond it for better or worse, inside
 * it for same), so more pairs are unlikely to change the verdict. `open`:
 * the interval crosses a floor line, or lies where the rule did not put the
 * verdict; the verdict is the rule's best reading and more pairs could move it.
 * `too-few`: not enough pairs for a 95% interval at all (fewer than six).
 */
export type Confidence = "settled" | "open" | "too-few";

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
  /** The shift between the arms (on - off) as the Hodges-Lehmann estimate: steadier than the median delta when a pair is wild. */
  shift: number | null;
  /** An interval for the shift at 95% or more; null with fewer than six complete pairs. */
  interval: [number, number] | null;
  confidence: Confidence;
}

/** The fewest complete pairs that can settle a verdict: fewer cannot give a 95% interval however well they agree. */
export const MIN_PAIRS_TO_SETTLE = minPairsForInterval(0.95);

function confidenceOf(interval: [number, number] | null, noiseFloor: number | null, verdict: Verdict): Confidence {
  if (!interval || noiseFloor == null) return "too-few";
  const [low, high] = interval;
  // The interval has to agree with the rule's answer. The rule also wants 80% of the pairs on one side, so an
  // interval can lie wholly beyond the floor while the rule still says "same": that is a verdict more pairs could flip.
  const side: Verdict | null = high < -noiseFloor ? "better" : low > noiseFloor ? "worse" : low >= -noiseFloor && high <= noiseFloor ? "same" : null;
  return side === verdict ? "settled" : "open";
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
  const { shift, interval } = pairedShift(deltas);
  const base = {
    shift,
    interval,
    pairs: deltas.length,
    medianOn: median(onValues),
    medianOff: median(offValues),
    medianDelta: median(deltas),
    fasterPairs: 0,
    slowerPairs: 0,
  };
  if (deltas.length < MIN_PAIRS) {
    return { ...base, noiseFloor: null, confidence: "too-few", verdict: "unknown", reason: `${deltas.length} complete pair(s), need ${MIN_PAIRS}` };
  }
  const noiseFloor = Math.max(NOISE_FLOOR_MS, NOISE_FLOOR_RATIO * (base.medianOff as number));
  const fasterPairs = deltas.filter((d) => d < -noiseFloor).length;
  const slowerPairs = deltas.filter((d) => d > noiseFloor).length;
  const needed = Math.ceil(AGREEMENT * deltas.length);
  const delta = base.medianDelta as number;
  const settle = (verdict: Verdict): Confidence => confidenceOf(interval, noiseFloor, verdict);
  const result = { ...base, noiseFloor, fasterPairs, slowerPairs };
  if (delta < -noiseFloor && fasterPairs >= needed) {
    return { ...result, confidence: settle("better"), verdict: "better", reason: `median delta ${Math.round(delta)} ms below -${Math.round(noiseFloor)} ms, ${fasterPairs}/${deltas.length} pairs faster` };
  }
  if (delta > noiseFloor && slowerPairs >= needed) {
    return { ...result, confidence: settle("worse"), verdict: "worse", reason: `median delta +${Math.round(delta)} ms above ${Math.round(noiseFloor)} ms, ${slowerPairs}/${deltas.length} pairs slower` };
  }
  return { ...result, confidence: settle("same"), verdict: "same", reason: `median delta ${Math.round(delta)} ms within ±${Math.round(noiseFloor)} ms or pairs disagree (${fasterPairs} faster, ${slowerPairs} slower of ${deltas.length})` };
}

/** Worse on any metric is worse; better needs at least one better and no worse; any unknown with no worse is unknown. */
export function overallVerdict(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("worse")) return "worse";
  if (verdicts.includes("unknown")) return "unknown";
  if (verdicts.includes("better")) return "better";
  return "same";
}
