import { describe, expect, it } from "vitest";
import { type LoadMetrics, toPageRunRows } from "./pageRuns";

const load = (arm: "on" | "off", lcp: number): LoadMetrics => ({ arm, contentMs: lcp - 10, lcp, cls: 0.01, fcp: 100, ttfb: 50, inp: null, commitSha: "abc", messagesFetched: 300, bootReads: arm === "on" ? 2 : 0, preflights: 1, status429: 0, status5xx: 0, scriptBytes: 1000 });
const ctx = { project: "raft-web", env: "staging", runId: "r1", toolVersion: "0.2.0", takenAt: "2026-11-12T00:00:00Z", origin: "https://web.example", page: "channel", state: "release", net: "fast", ab: "boot-prefetch", verdict: "better" };

describe("toPageRunRows", () => {
  it("one row per load, both arms, indexed per arm, with the shared context", () => {
    const rows = toPageRunRows({ on: [load("on", 400), load("on", 410)], off: [load("off", 900)] }, ctx);
    expect(rows.map((r) => [r.arm, r.run_idx, r.lcp_ms])).toEqual([["on", 0, 400], ["on", 1, 410], ["off", 0, 900]]);
    for (const r of rows) expect(r).toMatchObject({ project: "raft-web", env: "staging", run_id: "r1", tool_version: "0.2.0", commit_sha: "abc", verdict: "better" });
  });
  it("puts Raft's own metrics in extra, named with their unit", () => {
    const [r] = toPageRunRows({ on: [load("on", 400)], off: [] }, ctx);
    expect(Object.keys(r.extra).every((k) => /_(ms|count|bytes)$/.test(k))).toBe(true);
    expect(r.extra).toMatchObject({ content_ms: 390, boot_read_count: 2, preflight_count: 1 });
    expect(r.inp_ms).toBeNull();
    expect(r.ttfb_ms).toBeNull();
  });
  it("takes each row's commit from its own load", () => {
    const rows = toPageRunRows({ on: [{ ...load("on", 400), commitSha: "old" }], off: [{ ...load("off", 900), commitSha: "new" }] }, ctx);
    expect(rows.map((r) => r.commit_sha)).toEqual(["old", "new"]);
  });
});
