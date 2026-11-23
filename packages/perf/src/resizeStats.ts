/**
 * Pure viewport resize jank, session-window CLS, and frame drop analyzer for
 * `raft-perf resize` (#proj-frontend:#78).
 */

import { type FrameStats, frameStats } from "./frames";

export interface RawLayoutShift {
  startTime: number;
  value: number;
  hadRecentInput: boolean;
}

export interface ResizeRunSummary {
  steps: number;
  frames: FrameStats | null;
  /** Frames exceeding 33.4 ms (> 2 × 60 Hz frames). */
  droppedFrames: number;
  /** Frames exceeding 50 ms (long animation frames). */
  longFrames: number;
  /** W3C session-window CLS observed during the resize sweep. */
  cls: number;
  longtaskMs: number;
  forcedLayoutMs: number | null;
  styleMs: number | null;
  layoutMs: number | null;
}

/** Default desktop -> tablet -> mobile -> desktop sweep exercising responsive & virtualizer breakpoints. */
export const DEFAULT_RESIZE_WIDTHS: readonly number[] = [
  1440, 1280, 1120, 960, 800, 720, 640, 768, 960, 1180, 1360, 1440,
];

const CLS_GAP_MS = 1000;
const CLS_MAX_WINDOW_MS = 5000;
const DROPPED_FRAME_MS = 33.4;
const LONG_FRAME_MS = 50;

/** Compute W3C session-window CLS (max session sum, <1s gap, <5s window, ignoring hadRecentInput). */
export function computeSessionWindowCls(shifts: readonly RawLayoutShift[]): number {
  let maxSession = 0;
  let sessionValue = 0;
  let sessionStart = 0;
  let sessionLast = 0;
  const ordered = [...shifts].sort((a, b) => a.startTime - b.startTime);
  for (const s of ordered) {
    if (s.hadRecentInput || !Number.isFinite(s.value) || s.value <= 0) continue;
    if (
      sessionValue > 0 &&
      s.startTime - sessionLast < CLS_GAP_MS &&
      s.startTime - sessionStart < CLS_MAX_WINDOW_MS
    ) {
      sessionValue += s.value;
      sessionLast = s.startTime;
    } else {
      sessionValue = s.value;
      sessionStart = s.startTime;
      sessionLast = s.startTime;
    }
    if (sessionValue > maxSession) maxSession = sessionValue;
  }
  return Math.round(maxSession * 10_000) / 10_000;
}

export function summarizeResizeRun(input: {
  steps: number;
  frameStampsMs: readonly number[];
  layoutShifts: readonly RawLayoutShift[];
  longtaskMs: number;
  forcedLayoutMs?: number | null;
  styleMs?: number | null;
  layoutMs?: number | null;
}): ResizeRunSummary {
  const deltas: number[] = [];
  let droppedFrames = 0;
  let longFrames = 0;
  for (let i = 1; i < input.frameStampsMs.length; i += 1) {
    const dt = input.frameStampsMs[i]! - input.frameStampsMs[i - 1]!;
    if (!Number.isFinite(dt) || dt < 0) continue;
    deltas.push(dt);
    if (dt > DROPPED_FRAME_MS) droppedFrames += 1;
    if (dt > LONG_FRAME_MS) longFrames += 1;
  }
  const frames = frameStats(deltas);
  return {
    steps: input.steps,
    frames,
    droppedFrames,
    longFrames,
    cls: computeSessionWindowCls(input.layoutShifts),
    longtaskMs: Math.round(Math.max(0, input.longtaskMs) * 10) / 10,
    forcedLayoutMs: input.forcedLayoutMs ?? null,
    styleMs: input.styleMs ?? null,
    layoutMs: input.layoutMs ?? null,
  };
}
