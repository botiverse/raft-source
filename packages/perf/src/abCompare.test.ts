import { describe, expect, it } from "vitest";
import { compareArms, compareStartupArms } from "./abCompare";
import type { WorkSplit } from "./workSplit";

const split = (styleMs: number, passes: number, more: Partial<WorkSplit> = {}): WorkSplit => ({ windowMs: 3000, recordedMs: 3000, taskMs: 600, scriptMs: 400, styleMs, layoutMs: 40, forcedMs: 100, stylePasses: 40, styleElements: passes * 1000, layouts: 12, largeStylePasses: Array.from({ length: passes }, (_, i) => ({ atMs: i * 100, ms: 20, elements: 1000 })), ...more });
const visit = (...splits: WorkSplit[]) => ({ splits });

describe("compareArms", () => {
  it("a visit counts as the median of its switches, and visit i of each arm is one pair", () => {
    const base = [visit(split(170, 5), split(175, 5), split(400, 5)), visit(split(168, 5)), visit(split(180, 5))];
    const pr = [visit(split(90, 1), split(92, 1), split(88, 1)), visit(split(95, 1)), visit(split(89, 1))];
    const c = compareArms(base, pr);
    expect(c.pairs).toBe(3);
    // the wild 400 ms switch does not decide the first pair: its visit reads 175
    expect(c.timings.styleMs).toMatchObject({ verdict: "better", medianOff: 175, medianOn: 90, medianDelta: -85, pairs: 3 });
    expect(c.timings.scriptMs).toMatchObject({ verdict: "same", medianDelta: 0 });
    expect(c.counts.largeStylePasses).toEqual({ base: 5, pr: 1, everyPairLower: true, everyPairHigher: false });
    expect(c.counts.styleElements).toMatchObject({ base: 5000, pr: 1000, everyPairLower: true });
    expect(c.counts.layouts).toEqual({ base: 12, pr: 12, everyPairLower: false, everyPairHigher: false });
  });

  it("leaves out the pairs it is told to and those in which a visit measured no switch", () => {
    const base = [visit(split(170, 5)), visit(split(900, 9)), visit(), visit(split(172, 5))];
    const pr = [visit(split(90, 1)), visit(split(90, 1)), visit(split(90, 1)), visit(split(91, 2))];
    const c = compareArms(base, pr, [1]);
    expect(c.pairs).toBe(2);
    expect(c.timings.styleMs).toMatchObject({ medianOff: 171, medianOn: 90.5, verdict: "unknown" });
    // two pairs agreeing is not "every pair": too few to judge
    expect(c.counts.largeStylePasses).toEqual({ base: 5, pr: 1.5, everyPairLower: false, everyPairHigher: false });
  });

  it("one pair the other way is not 'every pair'", () => {
    const base = [visit(split(100, 3)), visit(split(100, 3)), visit(split(100, 3))];
    expect(compareArms(base, [visit(split(100, 2)), visit(split(100, 2)), visit(split(100, 4))]).counts.largeStylePasses).toMatchObject({ everyPairLower: false, everyPairHigher: false });
    expect(compareArms(base, [visit(split(100, 2)), visit(split(100, 2)), visit(split(100, 3))]).counts.largeStylePasses).toMatchObject({ everyPairLower: false });
    expect(compareArms(base, [visit(split(100, 4)), visit(split(100, 5)), visit(split(100, 4))]).counts.largeStylePasses).toMatchObject({ everyPairLower: false, everyPairHigher: true });
  });

  it("with no complete pair nothing is claimed", () => {
    const c = compareArms([visit()], [visit(split(90, 1))]);
    expect(c.pairs).toBe(0);
    expect(c.timings.styleMs.verdict).toBe("unknown");
    expect(c.counts.largeStylePasses).toEqual({ base: null, pr: null, everyPairLower: false, everyPairHigher: false });
  });
});

describe("compareStartupArms", () => {
  it("judges paintedMs, responseToPaintMs and post-response script/style splits across alternating startup pairs", () => {
    const mkSample = (paintedMs: number, rtpMs: number, scriptMs: number) => ({
      paintedMs,
      rowMs: paintedMs - 16,
      messagesEndMs: paintedMs - rtpMs,
      responseToPaintMs: rtpMs,
      longTasksMs: scriptMs - 50,
      split: split(80, 2, { taskMs: scriptMs + 80, scriptMs }),
    });
    const base = [1420, 1450, 1410, 1440, 1430, 1425].map((p) => ({ samples: [mkSample(p, p - 300, 950)] }));
    const pr = [1040, 1060, 1030, 1055, 1045, 1050].map((p) => ({ samples: [mkSample(p, p - 300, 570)] }));
    const cmp = compareStartupArms(base, pr);
    expect(cmp.pairs).toBe(6);
    expect(cmp.timings.paintedMs.verdict).toBe("better");
    expect(cmp.timings.responseToPaintMs.verdict).toBe("better");
    expect(cmp.timings.scriptMs.verdict).toBe("better");
    expect(cmp.timings.responseToPaintMs.confidence).toBe("settled");
  });
});
