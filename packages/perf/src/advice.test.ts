import { describe, expect, it } from "vitest";
import { type PageSummary, advise } from "./advice";
import { type FirstScreenFile, type FirstScreenSnapshot, diffSnapshots, stableName, totals } from "./firstScreen";

const scenario = { project: "landing", env: "production", page: "home", state: "cold", net: "slow" };
const page = (over: Partial<PageSummary>): PageSummary => ({ ready_ms: 1000, ttfb_ms: 50, total_bytes: 200_000, js_bytes: 100_000, request_count: 12, ledger_main_thread_ms: 0, ledger_download_ms: 0, ledger_network_wait_ms: 0, ledger_unexplained_ms: 0, ...over });
const file = (url: string, brBytes: number, cacheControl: string | null = "public, max-age=31536000, immutable", sha = url): FirstScreenFile => ({ url, name: stableName(url), kind: "js", via: "entry", bytes: brBytes * 4, brBytes, sha256: sha, cacheControl });
const snap = (files: FirstScreenFile[], commit = "c"): FirstScreenSnapshot => ({ schema: "raft-perf/first-screen@1", origin: "https://x.example", takenAt: "t", release: { commitSha: commit, builtAt: null, deploymentEnvironment: "production" }, html: { bytes: 0, brBytes: 0 }, files, skipped: [], totals: totals(files) });
const run = (p: PageSummary, extra: Partial<Parameters<typeof advise>[0]> = {}) => advise({ scenario, page: p, loadCommand: "raft-perf load --project projects/landing.json --env production --page home --state cold --net slow", ...extra });

describe("advise", () => {
  it("ranks by the most each finding could save in this scenario", () => {
    const a = run(page({ ledger_download_ms: 600, ledger_main_thread_ms: 250, ledger_network_wait_ms: 150 }));
    expect(a.findings.map((f) => [f.id, f.upperBoundMs])).toEqual([["download-bound", 600], ["main-thread-bound", 250], ["network-wait-bound", 150]]);
    expect(a.findings[0].shareOfReady).toBe(0.6);
  });

  it("the same page on another network gets a different first finding", () => {
    const fast = run(page({ ready_ms: 300, ledger_download_ms: 16, ledger_main_thread_ms: 100, ledger_network_wait_ms: 180 }));
    expect(fast.findings.map((f) => f.id)).toEqual(["network-wait-bound", "main-thread-bound"]);
  });

  it("a segment under 10% of ready is not a finding", () => {
    expect(run(page({ ledger_download_ms: 99, ledger_main_thread_ms: 100 })).findings.map((f) => f.id)).toEqual(["main-thread-bound"]);
  });

  it("a large unexplained share says to understand it first: no bound, and ranked first", () => {
    const a = run(page({ ledger_unexplained_ms: 400, ledger_main_thread_ms: 300 }));
    const u = a.findings.find((f) => f.id === "unexplained")!;
    expect(u.upperBoundMs).toBeNull();
    expect(a.findings[0].id).toBe("unexplained");
  });

  it("sizes files in time at the rate this scenario measured, as estimates capped at the download segment", () => {
    // 200,000 bytes in 800 ms = 250 bytes/ms; a 60,000-byte file is 240 ms; a 500,000-byte file would be 2,000 ms but the segment is 800
    const a = run(page({ ledger_download_ms: 800 }), { snapshot: snap([file("/a/small-AAAAAAAA.js", 60_000), file("/a/huge-BBBBBBBB.js", 500_000)]) });
    const ev = a.findings.find((f) => f.id === "download-bound")!.evidence.join(" | ");
    expect(ev).toMatch(/huge\.js: .* roughly 800 ms/);
    expect(ev).toMatch(/small\.js: .* roughly 240 ms/);
  });

  it("no-store first-screen files are a repeat-visit finding with an exact trust level", () => {
    const a = run(page({ ledger_download_ms: 800 }), { snapshot: snap([file("/main.js", 50_000, "no-store")]) });
    const f = a.findings.find((x) => x.id === "no-store-first-screen")!;
    expect(f).toMatchObject({ segment: "repeat_visit", trust: "exact", upperBoundMs: null, costBytes: 50_000 });
    expect(f.verify).toMatch(/--state repeat/);
  });

  it("a release that invalidates 30% or more of the first screen is a finding; under that it is not", () => {
    const base = snap([file("/a/vendor-AAAAAAAA.js", 60_000), file("/a/app-BBBBBBBB.js", 40_000)], "b");
    const head40 = snap([file("/a/vendor-AAAAAAAA.js", 60_000), file("/a/app-CCCCCCCC.js", 40_000)], "h");
    const head0 = base;
    expect(run(page({ ledger_download_ms: 800 }), { diff: diffSnapshots(base, head40) }).findings.find((f) => f.id === "release-invalidation")!.title).toMatch(/40%/);
    expect(run(page({ ledger_download_ms: 800 }), { diff: diffSnapshots(base, head0) }).findings.find((f) => f.id === "release-invalidation")).toBeUndefined();
  });

  it("a page that never became ready gets no advice, only the reason", () => {
    const a = run(page({ ready_ms: null }));
    expect(a.findings).toEqual([]);
    expect(a.notes[0]).toMatch(/never became ready/);
  });

  it("no time bound is ever larger than the scenario's ready time, whatever the inputs (property)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const ready = 50 + rnd() * 5000;
      const parts = [rnd(), rnd(), rnd(), rnd()]; const total = parts.reduce((a, b) => a + b, 0);
      const [d, m, n, u] = parts.map((x) => (x / total) * ready);
      const base = snap([file("/a/v-AAAAAAAA.js", Math.round(rnd() * 900_000) + 1), file("/a/app-BBBBBBBB.js", Math.round(rnd() * 900_000) + 1, rnd() < 0.3 ? "no-store" : "public")], "b");
      const head = snap([file("/a/v-CCCCCCCC.js", Math.round(rnd() * 900_000) + 1), base.files[1]], "h");
      const a = run(page({ ready_ms: ready, total_bytes: Math.round(rnd() * 2_000_000), ledger_download_ms: d, ledger_main_thread_ms: m, ledger_network_wait_ms: n, ledger_unexplained_ms: u }), { snapshot: head, diff: diffSnapshots(base, head) });
      for (const f of a.findings) if (f.upperBoundMs != null) expect(f.upperBoundMs).toBeLessThanOrEqual(Math.ceil(ready));
      const ranks = a.findings.map((f) => (f.id === "unexplained" ? 3 : f.upperBoundMs != null ? 2 : f.costBytes != null ? 1 : 0));
      expect([...ranks].sort((x, y) => y - x)).toEqual(ranks);
    }
  });

  it("byte findings rank after every time-bounded finding, most bytes first", () => {
    const base = snap([file("/a/vendor-AAAAAAAA.js", 60_000), file("/main.js", 5_000, "no-store")], "b");
    const head = snap([file("/a/vendor-CCCCCCCC.js", 60_000), file("/main.js", 5_000, "no-store")], "h");
    const a = run(page({ ledger_download_ms: 150, ledger_main_thread_ms: 100 }), { snapshot: head, diff: diffSnapshots(base, head) });
    expect(a.findings.map((f) => f.id)).toEqual(["download-bound", "main-thread-bound", "release-invalidation", "no-store-first-screen"]);
    expect(a.notes.join(" ")).toMatch(/sized in bytes/);
  });
});
