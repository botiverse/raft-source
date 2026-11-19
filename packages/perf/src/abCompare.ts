/**
 * Two arms of `raft-perf ab` put side by side. One visit of an arm makes
 * several traced switches; the visit counts as their median, so one wild
 * switch does not decide a pair. Visit i of the base arm and visit i of the
 * pr arm are one pair. Pure, pinned by abCompare.test.ts.
 *
 * Times are judged by the paired rule of `measure` (src/verdict.ts: median
 * delta against a noise floor of max(30 ms, 2%), 80% of the pairs agreeing,
 * and how settled that is). Counts (style passes, elements restyled) have no
 * noise floor in milliseconds: they are given as medians, with whether every
 * pair moved the same way.
 */
import { MIN_PAIRS, type MetricVerdict, median, pairedVerdict } from "./verdict";
import type { WorkSplit } from "./workSplit";

export interface ArmVisit {
  /** The switches of the visit that were measured; may be empty. */
  splits: WorkSplit[];
}

export interface CountComparison {
  base: number | null;
  pr: number | null;
  /** Over the complete pairs, when there are at least `MIN_PAIRS` (one or two pairs agreeing is not a result): pr below base in every one / above in every one. */
  everyPairLower: boolean;
  everyPairHigher: boolean;
}

export interface ArmComparison {
  /** Pairs in which both visits measured at least one switch and that were not left out. */
  pairs: number;
  /** `medianOn` is the pr arm, `medianOff` the base arm; better means the pr arm did less. */
  timings: Record<"taskMs" | "scriptMs" | "styleMs" | "layoutMs" | "forcedMs", MetricVerdict>;
  counts: Record<"largeStylePasses" | "stylePasses" | "styleElements" | "layouts", CountComparison>;
}

const TIMINGS = ["taskMs", "scriptMs", "styleMs", "layoutMs", "forcedMs"] as const;
const COUNTS = { largeStylePasses: (w: WorkSplit) => w.largeStylePasses.length, stylePasses: (w: WorkSplit) => w.stylePasses, styleElements: (w: WorkSplit) => w.styleElements, layouts: (w: WorkSplit) => w.layouts };

/** `leftOut`: indexes of pairs not to count (taken on a busy host). */
export function compareArms(base: readonly ArmVisit[], pr: readonly ArmVisit[], leftOut: readonly number[] = []): ArmComparison {
  const kept = [...Array(Math.min(base.length, pr.length)).keys()].filter((i) => !leftOut.includes(i) && base[i]!.splits.length > 0 && pr[i]!.splits.length > 0);
  const perVisit = (visits: readonly ArmVisit[], of: (w: WorkSplit) => number) => kept.map((i) => median(visits[i]!.splits.map(of))!);
  const round = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  const timings = Object.fromEntries(TIMINGS.map((name) => [name, pairedVerdict(perVisit(pr, (w) => w[name]), perVisit(base, (w) => w[name]))])) as ArmComparison["timings"];
  const counts = Object.fromEntries(
    Object.entries(COUNTS).map(([name, of]) => {
      const b = perVisit(base, of);
      const p = perVisit(pr, of);
      return [name, { base: round(median(b)), pr: round(median(p)), everyPairLower: kept.length >= MIN_PAIRS && p.every((v, i) => v < b[i]!), everyPairHigher: kept.length >= MIN_PAIRS && p.every((v, i) => v > b[i]!) }];
    }),
  ) as ArmComparison["counts"];
  return { pairs: kept.length, timings, counts };
}
