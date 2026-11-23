/**
 * Trace sampling as a platform setting (docs/observability/trace-sampling.md):
 * one feature flag per sampled trace, key `trace_sample.<trace name or prefix>`,
 * whose variant is the sample rate. Every client (web, App) asks
 * POST /api/feature-flags/evaluate for the keys from {@link traceSampleKeys}
 * and reads the answer with {@link resolveTraceSampleRate}. The App mirrors
 * this file; keep the two in step.
 */

export const TRACE_SAMPLE_FLAG_PREFIX = "trace_sample";

/** The evaluate answer fields this reads (a subset of FeatureFlagEvaluation). */
export interface TraceSampleEvaluation {
  key: string;
  enabled: boolean;
  reason: string;
  variant?: string;
}

/**
 * The flag keys that can set `traceName`'s rate, most specific first:
 * `mobile.thread_open` -> trace_sample.mobile.thread_open, trace_sample.mobile, trace_sample.
 */
export function traceSampleKeys(traceName: string): string[] {
  const parts = traceName.split(".").filter((part) => part !== "");
  const keys: string[] = [];
  for (let n = parts.length; n > 0; n--) keys.push(`${TRACE_SAMPLE_FLAG_PREFIX}.${parts.slice(0, n).join(".")}`);
  keys.push(TRACE_SAMPLE_FLAG_PREFIX);
  return keys;
}

/** A variant as a rate in [0, 1]; null when it is not one. */
export function parseTraceSampleRate(variant: string | null | undefined): number | null {
  if (variant === null || variant === undefined) return null;
  const trimmed = variant.trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(trimmed)) return null;
  const rate = Number(trimmed);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : null;
}

/**
 * The rate for `traceName` from an evaluate answer: the most specific key the
 * answer has a flag for (anything but `missing_flag`) decides. Off -> 0; on
 * with no variant -> 1; on with a rate variant -> that rate. When no key has a
 * flag, or the deciding variant is not a rate, `fallback` (the client's own
 * default) applies.
 */
export function resolveTraceSampleRate(
  traceName: string,
  evaluations: readonly TraceSampleEvaluation[],
  fallback: number,
): number {
  const byKey = new Map(evaluations.map((evaluation) => [evaluation.key, evaluation]));
  for (const key of traceSampleKeys(traceName)) {
    const evaluation = byKey.get(key);
    if (!evaluation || evaluation.reason === "missing_flag") continue;
    if (!evaluation.enabled) return 0;
    if (evaluation.variant === undefined || evaluation.variant === "") return 1;
    return parseTraceSampleRate(evaluation.variant) ?? fallback;
  }
  return fallback;
}

/** One sampling decision per unit of work (one open, one session): sampled in when random < rate. */
export function traceSampled(rate: number, random: () => number = Math.random): boolean {
  return rate >= 1 || (rate > 0 && random() < rate);
}
