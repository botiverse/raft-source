/**
 * Frame statistics for an interaction (scrolling): requestAnimationFrame
 * intervals in, the numbers a watermark is set on out. Pure, pinned by
 * frames.test.ts.
 */

/** A frame slower than two 60 Hz frames: the eye sees it as a hitch. */
export const SLOW_FRAME_MS = 33.4;

export interface FrameStats {
  frames: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /**
   * Share of the measured time spent in frames slower than SLOW_FRAME_MS, in
   * percent. By time, not by count: one 133 ms frame replaces eight smooth
   * ones, and a count would call that one slow frame.
   */
  slowPct: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** null when there are too few frames to say anything (fewer than 10). */
export function frameStats(intervalsMs: readonly number[]): FrameStats | null {
  if (intervalsMs.length < 10) return null;
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  return {
    frames: sorted.length,
    p50Ms: round1(quantile(sorted, 0.5)),
    p95Ms: round1(quantile(sorted, 0.95)),
    maxMs: round1(sorted[sorted.length - 1]),
    slowPct: round1((100 * sorted.filter((x) => x > SLOW_FRAME_MS).reduce((a, x) => a + x, 0)) / sorted.reduce((a, x) => a + x, 0)),
  };
}
