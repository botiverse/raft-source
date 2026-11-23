import { describe, expect, it } from "vitest";
import { computeSessionWindowCls, summarizeResizeRun } from "./resizeStats";

describe("resizeStats", () => {
  it("computes W3C session-window CLS ignoring hadRecentInput and splitting on >1s gap or >=5s cap", () => {
    const cls = computeSessionWindowCls([
      { startTime: 100, value: 0.04, hadRecentInput: false },
      { startTime: 500, value: 0.03, hadRecentInput: false },
      { startTime: 600, value: 0.85, hadRecentInput: true }, // ignored
      { startTime: 2000, value: 0.05, hadRecentInput: false },
      { startTime: 2900, value: 0.05, hadRecentInput: false },
      { startTime: 3800, value: 0.02, hadRecentInput: false },
      { startTime: 4700, value: 0.02, hadRecentInput: false },
      { startTime: 5600, value: 0.02, hadRecentInput: false },
      { startTime: 6500, value: 0.02, hadRecentInput: false },
      // 600ms after 6500 (<1s gap), but 7100 - 2000 = 5100ms >= 5s cap -> new session!
      { startTime: 7100, value: 0.09, hadRecentInput: false },
    ]);
    expect(cls).toBe(0.18);
  });

  it("counts dropped (>33.4ms) and long (>50ms) frames alongside CLS and trace layout work", () => {
    const summary = summarizeResizeRun({
      steps: 12,
      // deltas: 16, 16, 40 (dropped), 65 (dropped+long), 16, 16, 16, 16, 16, 16, 16
      frameStampsMs: [0, 16, 32, 72, 137, 153, 169, 185, 201, 217, 233, 249],
      layoutShifts: [{ startTime: 50, value: 0.025, hadRecentInput: false }],
      longtaskMs: 88.24,
      forcedLayoutMs: 41.5,
      styleMs: 30.2,
      layoutMs: 22.1,
    });
    expect(summary.steps).toBe(12);
    expect(summary.droppedFrames).toBe(2);
    expect(summary.longFrames).toBe(1);
    expect(summary.cls).toBe(0.025);
    expect(summary.longtaskMs).toBe(88.2);
    expect(summary.forcedLayoutMs).toBe(41.5);
    expect(summary.frames?.maxMs).toBe(65);
  });
});
