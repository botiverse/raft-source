import { SESSION_DISAGREE_MS, SESSION_DISAGREE_RATIO, sessionAgreement } from "./startupSplit";

describe("sessionAgreement", () => {
  it("one session always agrees and has no ratio", () => {
    expect(sessionAgreement([[1200, 1300, 1250]])).toEqual({ medians: [1250], ratio: null, agree: true });
  });
  it("flags two sessions of one build that read 2x apart (Browser Run, 2026-11-16: 1.24 s and 2.78 s)", () => {
    const a = sessionAgreement([[1241, 1200, 1300], [2783, 2700, 2900]]);
    expect(a.agree).toBe(false);
    expect(a.medians).toEqual([1241, 2783]);
    expect(a.ratio).toBe(2.24);
  });
  it("needs both thresholds: a large ratio on tiny times, or many ms on large times, is not disagreement", () => {
    // 3x apart but only 200 ms
    expect(sessionAgreement([[100], [300]]).agree).toBe(true);
    // 400 ms apart but only 1.1x
    expect(sessionAgreement([[4000], [4400]]).agree).toBe(true);
    expect(SESSION_DISAGREE_MS).toBe(300);
    expect(SESSION_DISAGREE_RATIO).toBe(1.5);
  });
  it("skips missing values inside a session", () => {
    expect(sessionAgreement([[1300, null], [1350, undefined, 1400]])).toEqual({ medians: [1300, 1375], ratio: 1.06, agree: true });
  });
  it("a session that never painted beside one that did is a disagreement", () => {
    expect(sessionAgreement([[1200], [null]])).toEqual({ medians: [1200, null], ratio: null, agree: false });
    expect(sessionAgreement([[null], [null]])).toEqual({ medians: [null, null], ratio: null, agree: true });
  });
  it("compares the ratio it reports (rounded) and decides on milliseconds alone when the fastest is 0", () => {
    expect(sessionAgreement([[1000], [1504]])).toEqual({ medians: [1000, 1504], ratio: 1.5, agree: true });
    expect(sessionAgreement([[0], [400]])).toEqual({ medians: [0, 400], ratio: null, agree: false });
  });
});
