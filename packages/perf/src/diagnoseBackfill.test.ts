import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backfillReportObject, collectJsonFiles, inferEnvFromOrigin, readSiblingBackfillMeta } from "./diagnoseBackfill";

describe("diagnoseBackfill", () => {
  it("auto-detects diagnose and interact --trace JSON reports, skips unrelated JSON, and emits backfilled=true rows", () => {
    const diagRows = backfillReportObject(
      {
        tool: "raft-perf diagnose",
        measuredAt: "2026-11-12T06:00:00.000Z",
        scenario: "startup",
        mode: "reopen",
        origin: "https://raft-app-staging.botiverse.dev",
        page: { server: "qa", channel: "all" },
        cpuProfile: { windowMs: 500, activeMs: 320, gcMs: 12, topSelf: [], topTotal: [], byBucket: [] },
        forcedReflows: [],
      },
      {
        sourceLabel: "2026-11-12/diagnose-reopen.json",
        project: "raft-web",
        toolVersion: "0.29.0",
        backfilled: true,
      },
    );
    expect(diagRows).toHaveLength(1);
    expect(diagRows[0]!.backfilled).toBe(true);
    expect(diagRows[0]!.env).toBe("staging");
    expect(diagRows[0]!.cpu_active_ms).toBe(320);

    const traceRows = backfillReportObject(
      {
        tool: "raft-perf interact",
        measuredAt: "2026-11-13T06:00:00.000Z",
        origin: "https://app.raft.build",
        work: {
          windowMs: 3000,
          channel_switch_back: { switches: 3, taskMs: 400, scriptMs: 250, styleMs: 60, layoutMs: 20, forcedMs: 30, stylePasses: 4, styleElements: 2000, layouts: 2, largeStylePasses: 1 },
        },
      },
      {
        sourceLabel: "2026-11-13/interact-trace.json",
        project: "raft-web",
        toolVersion: "0.29.0",
        backfilled: true,
      },
    );
    expect(traceRows).toHaveLength(1);
    expect(traceRows[0]!.env).toBe("production");
    expect(traceRows[0]!.source_command).toBe("interact-trace");
    expect(traceRows[0]!.backfilled).toBe(true);

    // Unrelated report (e.g. untraced interact or snapshot) yields []
    expect(
      backfillReportObject(
        { tool: "raft-perf interact", measuredAt: "2026-11-13T06:00:00.000Z", metrics: {} },
        { sourceLabel: "x.json", project: "raft-web", toolVersion: "0.29.0", backfilled: true },
      ),
    ).toEqual([]);
  });

  it("collects JSON files recursively in deterministic sorted order and infers env from origin", () => {
    const root = mkdtempSync(path.join(tmpdir(), "raft-perf-backfill-"));
    try {
      mkdirSync(path.join(root, "2026-11-12"));
      mkdirSync(path.join(root, "2026-11-13"));
      writeFileSync(path.join(root, "2026-11-12", "diagnose.json"), "{}");
      writeFileSync(path.join(root, "2026-11-12", "host.txt"), "old-runner-4cpu  bench=20ms\n");
      writeFileSync(path.join(root, "2026-11-12", "notes.txt"), "skip");
      writeFileSync(path.join(root, "2026-11-13", "interact-trace.json"), "{}");
      writeFileSync(path.join(root, "2026-11-13", "host.txt"), "new-runner-12cpu\n");
      writeFileSync(path.join(root, "2026-11-13", "series-break.txt"), "moved to new machine (benchmark 20ms -> 9ms)\n");

      const files = collectJsonFiles([root]);
      expect(files.map((f) => path.relative(root, f))).toEqual([
        "2026-11-12/diagnose.json",
        "2026-11-13/interact-trace.json",
      ]);

      const meta12 = readSiblingBackfillMeta(path.join(root, "2026-11-12"));
      expect(meta12).toEqual({ hostText: "old-runner-4cpu bench=20ms", seriesBreakText: null });
      const meta13 = readSiblingBackfillMeta(path.join(root, "2026-11-13"));
      expect(meta13).toEqual({
        hostText: "new-runner-12cpu",
        seriesBreakText: "moved to new machine (benchmark 20ms -> 9ms)",
      });

      const rowsWithMeta = backfillReportObject(
        {
          tool: "raft-perf interact",
          measuredAt: "2026-11-13T06:00:00.000Z",
          origin: "https://raft-app-staging.botiverse.dev",
          host: { cpus: 12, benchmarkMedianMs: 9.1 },
          work: {
            windowMs: 3000,
            channel_switch_back: { switches: 3, taskMs: 210, scriptMs: 140, styleMs: 30, layoutMs: 10, forcedMs: 12, stylePasses: 2, styleElements: 800, layouts: 1, largeStylePasses: 0 },
          },
        },
        {
          sourceLabel: "2026-11-13/interact-trace.json",
          project: "raft-web",
          toolVersion: "0.29.0",
          backfilled: true,
          siblingMeta: meta13,
        },
      );
      expect(rowsWithMeta[0]?.extra).toMatchObject({
        host_cpu_count: 12,
        host_benchmark_ms: 9.1,
        backfill_host: "new-runner-12cpu",
        series_break: "moved to new machine (benchmark 20ms -> 9ms)",
        has_series_break: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(inferEnvFromOrigin("https://raft-app-staging.botiverse.dev")).toBe("staging");
    expect(inferEnvFromOrigin("https://app.raft.build")).toBe("production");
    expect(inferEnvFromOrigin("http://localhost:5173")).toBe("dev");
  });
});
