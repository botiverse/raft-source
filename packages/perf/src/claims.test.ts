import { describe, expect, it } from "vitest";
import { type ClaimRow, claimStates, isCommitSha, judgeClaim, metricRuns, parseClaims, sameCommit, transitionError } from "./claims";

const row = (over: Partial<ClaimRow> = {}): ClaimRow => ({
  claim_id: "raft-web-0001", event: "opened", event_at: "2026-11-12T13:00:00.000Z", project: "raft-web", env: "staging", title: "send the message request at the click", ref: "#triage:#342", author: "Scout",
  scenario: "interact/channel_first_visit", metric: "channel_first_visit_settled_ms", predicted_delta: -350, baseline_value: 936, measured_value: null, measured_delta: null, runs_before: 3, runs_after: null,
  commit_sha: null, runner: "lab-arm64", verify_command: "raft-perf interact …", tool_version: "0.8.0", note: null, ...over,
});

describe("judgeClaim", () => {
  it("verified: moved as predicted, beyond the floor, no run overlaps", () => {
    const j = judgeClaim("channel_first_visit_settled_ms", -350, [908, 1029, 936], [610, 640, 590]);
    expect(j).toMatchObject({ event: "verified", baseline: 936, measured: 610, measuredDelta: -326, floor: 30, calibration: 0.93 });
  });
  it("refuted: nothing moved and the measurement could have seen half the prediction", () => {
    expect(judgeClaim("channel_first_visit_settled_ms", -350, [908, 1029, 936], [920, 1010, 950]).event).toBe("refuted");
  });
  it("refuted: a real move the other way", () => {
    const j = judgeClaim("channel_first_visit_settled_ms", -350, [900, 910, 905], [1200, 1210, 1190]);
    expect(j).toMatchObject({ event: "refuted", calibration: -0.84 });
  });
  it("refuted: a real move as predicted, but under half of what was predicted", () => {
    const j = judgeClaim("ready_ms", -350, [974, 974, 976, 976, 976, 974], [940, 941, 942]);
    expect(j).toMatchObject({ event: "refuted", calibration: 0.1 });
    expect(j.reason).toMatch(/under half/);
  });
  it("refuted with the true reason when it moved the other way and runs overlap", () => {
    const j = judgeClaim("ready_ms", -350, [900, 950, 1000, 1100], [1050, 1200, 1250]);
    expect(j.event).toBe("refuted");
    expect(j.reason).toMatch(/moved the other way.*runs overlap/);
  });
  it("inconclusive: no clear move and the floor is over half the prediction", () => {
    expect(judgeClaim("lcp_ms", -40, [1000, 1010, 1020], [990, 1005, 1015]).event).toBe("inconclusive");
  });
  it("a move as predicted is not verified while runs overlap: inconclusive, not refuted", () => {
    // median -300, but one run after is slower than one run before
    expect(judgeClaim("ready_ms", -350, [900, 1000, 1100], [650, 700, 950]).event).toBe("inconclusive");
  });
  it("works for a prediction upwards and a metric that is not milliseconds", () => {
    expect(judgeClaim("cache_hit_count", 5, [10, 10, 11], [15, 16, 15])).toMatchObject({ event: "verified", floor: 0.2 });
  });
  it("needs three runs on each side", () => {
    expect(() => judgeClaim("ready_ms", -100, [1, 2], [1, 2, 3])).toThrow(/at least 3 runs/);
  });
});

describe("claim rows", () => {
  it("the latest row of a claim is its state", () => {
    const states = claimStates([row(), row({ claim_id: "raft-web-0002" }), row({ event: "shipped", commit_sha: "abc" })]);
    expect(states.map((r) => [r.claim_id, r.event])).toEqual([["raft-web-0001", "shipped"], ["raft-web-0002", "opened"]]);
  });
  it("only the documented transitions are allowed", () => {
    expect(transitionError(null, "opened")).toBeNull();
    expect(transitionError("opened", "shipped")).toBeNull();
    expect(transitionError("shipped", "verified")).toBeNull();
    expect(transitionError("shipped", "withdrawn")).toBeNull();
    expect(transitionError("opened", "opened")).toMatch(/already exists/);
    expect(transitionError("opened", "verified")).toMatch(/has not shipped/);
    expect(transitionError(null, "shipped")).toMatch(/no such claim/);
    expect(transitionError("verified", "refuted")).toMatch(/final/);
    expect(transitionError("shipped", "shipped")).toMatch(/already shipped/);
    expect(transitionError("withdrawn", "shipped")).toMatch(/final/);
  });
  it("parses what it wrote and names the line of a bad row", () => {
    const text = `${JSON.stringify(row())}\n\n${JSON.stringify(row({ event: "shipped", commit_sha: "abc" }))}\n`;
    expect(parseClaims(text)).toHaveLength(2);
    expect(() => parseClaims(`${JSON.stringify(row())}\n${JSON.stringify({ ...row(), predicted_delta: 0 })}`)).toThrow(/line 2: predicted_delta/);
    expect(() => parseClaims(JSON.stringify({ ...row(), event: "done" }))).toThrow(/line 1: event/);
  });
  it("a commit is 7 to 40 hex digits, and two shas match when one is a prefix of the other", () => {
    expect(["2eb3155", "2EB3155A2F85DF3086C104FBB913D31153C71E1E"].every(isCommitSha)).toBe(true);
    expect(["b", "  ", "2eb315", "not-a-sha", null, 7].some(isCommitSha)).toBe(false);
    expect(sameCommit("2eb3155a2f85", "2EB3155")).toBe(true);
    expect(sameCommit("2eb3155", "2eb3166")).toBe(false);
  });
  it("reads a metric's runs from a column or from extra", () => {
    const rows = [{ lcp_ms: 100, extra: { ready_ms: 5 } }, { lcp_ms: null, extra: { ready_ms: 7 } }, { lcp_ms: 120, extra: {} }];
    expect(metricRuns(rows, "lcp_ms")).toEqual([100, 120]);
    expect(metricRuns(rows, "ready_ms")).toEqual([5, 7]);
  });
});
