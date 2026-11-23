import { describe, expect, it } from "vitest";
import { filterMatchingRunJsonlLines, loadSuiteSpec, parseSuiteSpec, planSuiteSteps, stepOutputFilesToClean } from "./suite";

describe("loadSuiteSpec, parseSuiteSpec, and planSuiteSteps", () => {
  it("loads built-in daily-staging and daily-stamp suites and expands placeholders plus shared runId JSONL wiring", () => {
    const staging = loadSuiteSpec("daily-staging");
    expect(staging.suite).toBe("daily-staging");
    expect(staging.steps.map((s) => s.id)).toEqual([
      "bench-check",
      "snapshot-staging",
      "measure-release",
      "measure-repeat",
      "interact",
      "interact-trace",
      "input",
      "resize",
      "soak",
      "diagnose-reopen",
    ]);

    const stamp = loadSuiteSpec("daily-stamp");
    expect(stamp.suite).toBe("daily-stamp");
    expect(stamp.steps).toHaveLength(2);

    const planned = planSuiteSteps(
      staging,
      {
        outDir: "/tmp/perf-2026-11-18",
        runId: "run-uuid-1",
        fixture: "e40-bench.json",
        browser: "browser-run",
        origin: "https://custom-staging.example.test",
        dist: "/tmp/mapped-build",
        commitSha: "deadbeef1234",
      },
      ["bench-check", "measure-release", "interact-trace", "diagnose-reopen"],
    );
    expect(planned).toHaveLength(4);
    expect(planned[0]).toMatchObject({
      id: "bench-check",
      required: true,
      args: ["--fixture", "e40-bench.json", "--out", "/tmp/perf-2026-11-18/bench-check.json"],
    });
    expect(planned[1]?.stepJsonlPath).toBe("/tmp/perf-2026-11-18/measure-release.jsonl");
    expect(planned[1]?.args).toContain("browser-run");
    expect(planned[1]?.args).toContain("https://custom-staging.example.test");
    expect(planned[1]?.args).toContain("run-uuid-1");
    // interact-trace wires --diagnose-jsonl sharing run_id
    expect(planned[2]?.collectDiagnoseJsonl).toBe(true);
    expect(planned[2]?.stepDiagnoseJsonlPath).toBe("/tmp/perf-2026-11-18/interact-trace.diagnose.jsonl");
    expect(planned[2]?.args).toContain("--diagnose-jsonl");
    expect(planned[2]?.args).toContain("run-uuid-1");
    // diagnose-reopen pins --browser local and receives forwarded --dist and --commit-sha
    expect(planned[3]?.args).toContain("local");
    expect(planned[3]?.collectDiagnoseJsonl).toBe(true);
    expect(planned[3]?.stepDiagnoseJsonlPath).toBe("/tmp/perf-2026-11-18/diagnose-reopen.diagnose.jsonl");
    expect(planned[3]?.args).toContain("--dist");
    expect(planned[3]?.args).toContain("/tmp/mapped-build");
    expect(planned[3]?.args).toContain("--commit-sha");
    expect(planned[3]?.args).toContain("deadbeef1234");
    expect(planned[3]?.args).toContain("run-uuid-1");

    // Pre-step stale cleanup targets both --out and --jsonl files, and run_id guard drops stale rows
    expect(stepOutputFilesToClean(planned[1]!)).toEqual([
      "/tmp/perf-2026-11-18/measure-release.jsonl",
      "/tmp/perf-2026-11-18/measure-release.json",
    ]);
    expect(
      filterMatchingRunJsonlLines(
        '{"run_id":"old-run","page":"bench"}\n{"run_id":"run-uuid-1","page":"bench"}\n',
        "run-uuid-1",
      ),
    ).toEqual(['{"run_id":"run-uuid-1","page":"bench"}']);
  });

  it("rejects recursive suite calls, duplicate step IDs, unknown placeholders, and unknown --only IDs", () => {
    expect(() =>
      parseSuiteSpec({
        suite: "bad",
        steps: [{ id: "loop", command: "suite", args: [] }],
      }),
    ).toThrow(/disallowed command/);

    expect(() =>
      parseSuiteSpec({
        suite: "dup",
        steps: [
          { id: "s1", command: "snapshot", args: [] },
          { id: "s1", command: "snapshot", args: [] },
        ],
      }),
    ).toThrow(/twice/);

    const valid = parseSuiteSpec({
      suite: "custom",
      steps: [{ id: "s1", command: "snapshot", args: ["--out", "{{unknownVar}}"] }],
    });
    expect(() =>
      planSuiteSteps(valid, { outDir: "/tmp/x", runId: "r1", fixture: "bench-v1", browser: "local" }),
    ).toThrow(/unknown placeholder/);
    expect(() =>
      planSuiteSteps(loadSuiteSpec("daily-staging"), { outDir: "/tmp/x", runId: "r1", fixture: "bench-v1", browser: "local" }, ["no-such-step"]),
    ).toThrow(/has no step/);
  });
});
