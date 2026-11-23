import { describe, expect, it } from "vitest";
import { classifyInputEvent, summarizeInputInteractions } from "./inputStats";

describe("inputStats", () => {
  it("groups multi-event interactions by interactionId, prefers click over pointer, and computes key/click percentiles", () => {
    expect(classifyInputEvent("keydown")).toBe("key");
    expect(classifyInputEvent("click")).toBe("click");
    expect(classifyInputEvent("pointerup")).toBe("pointer");
    expect(classifyInputEvent("mousemove")).toBeNull();

    const summary = summarizeInputInteractions(
      [
        { name: "pointerup", interactionId: 1, startTime: 100, duration: 80, processingStart: 110, processingEnd: 150 },
        { name: "click", interactionId: 1, startTime: 100, duration: 224, processingStart: 120, processingEnd: 290 },
        { name: "keydown", interactionId: 2, startTime: 500, duration: 48 },
        { name: "keydown", interactionId: 3, startTime: 600, duration: 96 },
        { name: "keydown", interactionId: 4, startTime: 700, duration: 64 },
        { name: "click", interactionId: 0, startTime: 800, duration: 999 }, // interactionId=0 ignored
      ],
      142.34,
    );

    expect(summary.inpMs).toBe(224);
    expect(summary.inpInteraction).toBe("click");
    expect(summary.interactionCount).toBe(4);
    expect(summary.longInteractionCount).toBe(1);
    expect(summary.keyCount).toBe(3);
    expect(summary.keyP50Ms).toBe(64);
    expect(summary.keyP95Ms).toBe(96);
    expect(summary.keyMaxMs).toBe(96);
    expect(summary.clickCount).toBe(1);
    expect(summary.clickMaxMs).toBe(224);
    expect(summary.longtaskMs).toBe(142.3);
    expect(summary.worstInteractions[0]).toMatchObject({
      id: 1,
      kind: "click",
      durationMs: 224,
      inputDelayMs: 20,
      processingMs: 170,
      presentationDelayMs: 34,
    });
  });

  it("applies W3C p98 rule (drops 1 worst interaction per 50 distinct interactions)", () => {
    const entries = [
      { name: "click", interactionId: 1, startTime: 10, duration: 360 },
      { name: "keydown", interactionId: 2, startTime: 20, duration: 112 },
      ...Array.from({ length: 50 }, (_, i) => ({
        name: "keydown",
        interactionId: i + 3,
        startTime: 100 + i * 10,
        duration: 40,
      })),
    ];
    const summary = summarizeInputInteractions(entries, 0);
    expect(summary.interactionCount).toBe(52);
    expect(summary.inpMs).toBe(112);
    expect(summary.inpInteraction).toBe("key");
  });

  it("returns null INP cleanly when no interactions occurred", () => {
    const summary = summarizeInputInteractions([], 0);
    expect(summary.inpMs).toBeNull();
    expect(summary.inpInteraction).toBeNull();
    expect(summary.interactionCount).toBe(0);
  });
});
