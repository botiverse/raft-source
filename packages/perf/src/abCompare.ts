/**
 * Two arms of `raft-perf ab` put side by side, for either channel switches
 * (`compareArms`) or channel startup (`compareStartupArms`).
 *
 * Visit `i` of the `base` arm and visit `i` of the `pr` arm form one pair.
 * Times are judged by the paired rule of `measure` (`src/verdict.ts`: median
 * delta against a noise floor of `max(30 ms, 2%)`, 80% of the pairs agreeing,
 * and Wilcoxon confidence interval). Counts have no noise floor in ms and
 * report medians plus whether every kept pair moved the same way.
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

export interface StartupSample {
  paintedMs: number;
  rowMs: number;
  messagesEndMs: number | null;
  responseToPaintMs: number | null;
  longTasksMs: number;
  /** Main-thread work split inside the post-response render window (`[messagesEnd, painted]`, or `[0, painted]` when messages arrived after paint). */
  split: WorkSplit | null;
}

export interface StartupArmVisit {
  samples: StartupSample[];
}

export type StartupTimingKey =
  | "paintedMs"
  | "responseToPaintMs"
  | "rowMs"
  | "longTasksMs"
  | "taskMs"
  | "scriptMs"
  | "styleMs"
  | "layoutMs"
  | "forcedMs";

export interface StartupArmComparison {
  pairs: number;
  timings: Record<StartupTimingKey, MetricVerdict>;
  counts: Record<"largeStylePasses" | "stylePasses" | "styleElements" | "layouts", CountComparison>;
}

const TIMINGS = ["taskMs", "scriptMs", "styleMs", "layoutMs", "forcedMs"] as const;
const COUNTS = {
  largeStylePasses: (w: WorkSplit) => w.largeStylePasses.length,
  stylePasses: (w: WorkSplit) => w.stylePasses,
  styleElements: (w: WorkSplit) => w.styleElements,
  layouts: (w: WorkSplit) => w.layouts,
};

const round = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/** `leftOut`: indexes of pairs not to count (taken on a busy host). */
export function compareArms(base: readonly ArmVisit[], pr: readonly ArmVisit[], leftOut: readonly number[] = []): ArmComparison {
  const kept = [...Array(Math.min(base.length, pr.length)).keys()].filter((i) => !leftOut.includes(i) && base[i]!.splits.length > 0 && pr[i]!.splits.length > 0);
  const perVisit = (visits: readonly ArmVisit[], of: (w: WorkSplit) => number) => kept.map((i) => median(visits[i]!.splits.map(of))!);
  const timings = Object.fromEntries(TIMINGS.map((name) => [name, pairedVerdict(perVisit(pr, (w) => w[name]), perVisit(base, (w) => w[name]))])) as ArmComparison["timings"];
  const counts = Object.fromEntries(
    Object.entries(COUNTS).map(([name, of]) => {
      const b = perVisit(base, of);
      const p = perVisit(pr, of);
      return [
        name,
        {
          base: round(median(b)),
          pr: round(median(p)),
          everyPairLower: kept.length >= MIN_PAIRS && p.every((v, i) => v < b[i]!),
          everyPairHigher: kept.length >= MIN_PAIRS && p.every((v, i) => v > b[i]!),
        },
      ];
    }),
  ) as ArmComparison["counts"];
  return { pairs: kept.length, timings, counts };
}

const STARTUP_EXTRACTORS: Record<StartupTimingKey, (s: StartupSample) => number | null> = {
  paintedMs: (s) => s.paintedMs,
  responseToPaintMs: (s) => s.responseToPaintMs,
  rowMs: (s) => s.rowMs,
  longTasksMs: (s) => s.longTasksMs,
  taskMs: (s) => s.split?.taskMs ?? null,
  scriptMs: (s) => s.split?.scriptMs ?? null,
  styleMs: (s) => s.split?.styleMs ?? null,
  layoutMs: (s) => s.split?.layoutMs ?? null,
  forcedMs: (s) => s.split?.forcedMs ?? null,
};

/** Paired comparison of two local builds on channel startup (`new-device` or `reopen`). */
export function compareStartupArms(
  base: readonly StartupArmVisit[],
  pr: readonly StartupArmVisit[],
  leftOut: readonly number[] = [],
): StartupArmComparison {
  const kept = [...Array(Math.min(base.length, pr.length)).keys()].filter(
    (i) => !leftOut.includes(i) && base[i]!.samples.length > 0 && pr[i]!.samples.length > 0,
  );
  const perVisitNullable = (visits: readonly StartupArmVisit[], of: (s: StartupSample) => number | null): Array<number | null> =>
    kept.map((i) => {
      const vals = visits[i]!.samples.map(of).filter((v): v is number => v != null && Number.isFinite(v));
      return vals.length ? median(vals) : null;
    });

  const timings = Object.fromEntries(
    (Object.keys(STARTUP_EXTRACTORS) as StartupTimingKey[]).map((key) => {
      const extract = STARTUP_EXTRACTORS[key];
      return [key, pairedVerdict(perVisitNullable(pr, extract), perVisitNullable(base, extract))];
    }),
  ) as StartupArmComparison["timings"];

  const counts = Object.fromEntries(
    Object.entries(COUNTS).map(([name, of]) => {
      const pairIdxWithSplits = kept.filter(
        (i) => base[i]!.samples.some((s) => s.split != null) && pr[i]!.samples.some((s) => s.split != null),
      );
      const b = pairIdxWithSplits.map((i) => median(base[i]!.samples.filter((s) => s.split != null).map((s) => of(s.split!)))!);
      const p = pairIdxWithSplits.map((i) => median(pr[i]!.samples.filter((s) => s.split != null).map((s) => of(s.split!)))!);
      return [
        name,
        {
          base: round(median(b)),
          pr: round(median(p)),
          everyPairLower: pairIdxWithSplits.length >= MIN_PAIRS && p.every((v, idx) => v < b[idx]!),
          everyPairHigher: pairIdxWithSplits.length >= MIN_PAIRS && p.every((v, idx) => v > b[idx]!),
        },
      ];
    }),
  ) as StartupArmComparison["counts"];

  return { pairs: kept.length, timings, counts };
}
