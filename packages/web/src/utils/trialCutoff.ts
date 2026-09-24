import { TRIAL_END_DATE } from "@botiverse/raft-shared";

/**
 * The trial cutoff is a single GLOBAL instant, and the billing copy promises the
 * trial "remains active through {date} in every time zone".
 *
 * For that sentence to be true for every reader, the displayed day must be the
 * last calendar day on which the trial is still active for the EARLIEST time
 * zone on Earth — UTC-12. Formatting in the viewer's own zone would show a
 * later day to anyone east of that, and the copy would be a promise the product
 * does not keep.
 *
 * `Etc/GMT+12` is UTC-12: the POSIX sign convention in the `Etc/*` zone names is
 * inverted relative to the ISO offset, so `GMT+12` here means twelve hours
 * BEHIND UTC. Do not "correct" it to `Etc/GMT-12`.
 */
export const GLOBAL_TRIAL_CUTOFF_TIME_ZONE = "Etc/GMT+12";

/**
 * Formats the last day the trial is active, per the global-cutoff contract.
 *
 * Two details are load-bearing and both are pinned in tests/trialCutoff.test.ts:
 *   - the `- 1` makes this the last INSTANT inside the trial rather than the
 *     cutoff itself, so an exclusive end does not display as an extra day;
 *   - the explicit `timeZone` makes the result identical on every machine.
 * Dropping either one shifts the rendered date by a day.
 */
export function formatGlobalTrialCutoffDate(locale?: string): string {
  return new Date(TRIAL_END_DATE.getTime() - 1).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: GLOBAL_TRIAL_CUTOFF_TIME_ZONE,
  });
}
