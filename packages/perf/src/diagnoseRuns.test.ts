import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MAX_COMMIT_WATERFALL_ENTRIES,
  MAX_FORCED_STACK_DEPTH,
  MAX_TOP_FORCED_STACKS,
  MAX_TOP_FRAMES,
  archiveGzipFile,
  deterministicBackfillRunId,
  diagnoseReportToRow,
  interactTraceReportToRows,
} from "./diagnoseRuns";

describe("diagnoseReportToRow", () => {
  it("extracts top-level numeric columns, bounded Top-N JSON arrays, and archive links from startup diagnose reports", () => {
    const hotspots = Array.from({ length: 18 }, (_, i) => ({
      functionName: `fn${i}`,
      source: `src/file${i}.ts`,
      line: i + 10,
      column: 2,
      bucket: i === 0 ? ("react" as const) : ("app" as const),
      selfMs: 20 - i,
      totalMs: 40 - i,
      selfPct: 10,
      totalPct: 20,
    }));
    const forced = Array.from({ length: 14 }, (_, i) => ({
      functionName: `reflow${i}`,
      source: `src/layout${i}.ts`,
      line: 50 + i,
      column: 1,
      bucket: "ui" as const,
      count: 2,
      layoutCount: 1,
      styleCount: 1,
      totalForcedMs: 12.5,
      maxElements: 200,
      callStack: Array.from({ length: 12 }, (_, k) => `frame${k}`),
    }));
    const commits = Array.from({ length: 20 }, (_, i) => ({
      index: i + 1,
      atMs: 100 + i * 25,
      phase: "response-to-paint" as const,
      durationMs: 15 + i,
      scrollerMounted: i >= 2,
      domRows: i * 3,
      fiberMounts: 5,
      fiberUpdates: 10,
      rowMounts: i === 2 ? 10 : 0,
      rowUpdates: i > 2 ? 2 : 0,
      topComponents: [
        { name: "ChatPanel", count: 1 },
        { name: "MessageItem", count: 5 },
        { name: "Avatar", count: 5 },
        { name: "ExtraComp", count: 1 },
      ],
    }));

    const row = diagnoseReportToRow(
      {
        tool: "raft-perf diagnose",
        measuredAt: "2026-11-19T12:00:00.000Z",
        scenario: "startup",
        mode: "reopen",
        focusWindow: "response-to-paint",
        effectiveWindow: "response-to-paint",
        origin: "https://raft-app-staging.botiverse.dev",
        sourceMapsLoaded: 4,
        page: { server: "qa-perf-bench", channel: "bench-v1" },
        commitSha: "abcdef12",
        serverTimingMs: 18.4,
        cohort: {
          key: "local|SJC|bench-v1@5395d2b0|cpu4|rtt0",
          browserWhere: "local",
          edgeColo: "SJC",
          hostCpuCount: 12,
          hostBenchmarkMs: 8.5,
          browserCpuCount: 12,
          browserMemoryGb: 8,
          browserBenchmarkMs: 11.2,
          connectRttMs: 22,
          cpuSlowdown: 4,
          addedRttMs: 0,
          net: "throttled",
          documentIntercepted: false,
          fixture: "bench-v1@5395d2b0",
        },
        timings: {
          messagesStartMs: 70,
          messagesResponseEndMs: 320,
          firstRowMs: 910,
          paintedMs: 960.5,
          responseToPaintMs: 640.5,
          shownBeforeResponse: false,
        },
        criticalPath: {
          totalToPaintMs: 960.5,
          messagesStartMs: 70,
          messagesResponseEndMs: 320,
          responseToPaintMs: 640.5,
          shownBeforeResponse: false,
          maxMainThreadSavingsMs: 610.2,
          phases: [
            {
              phase: "response-to-paint",
              startMs: 320,
              endMs: 960.5,
              durationMs: 640.5,
              networkSlackMs: 0,
              role: "critical-path",
              workSplit: {
                windowMs: 640.5,
                recordedMs: 640.5,
                taskMs: 580.4,
                scriptMs: 390.2,
                styleMs: 95.1,
                layoutMs: 42.3,
                forcedMs: 65.4,
                stylePasses: 7,
                styleElements: 3200,
                layouts: 5,
                largeStylePasses: [{ atMs: 12, ms: 55, elements: 2100 }],
              },
            },
          ],
        },
        commitWaterfall: {
          rendererAttached: true,
          totalCommits: 20,
          droppedCommits: 0,
          walkOverheadMs: 14.2,
          totalCommitMs: 312.8,
          maxCommitMs: 48.5,
          byPhase: { beforeRequest: 1, inFlight: 1, responseToPaint: 18, postPaintSettle: 0, switchWindow: 0 },
          commitsBeforeScrollerMount: 2,
          scrollerMountAtMs: 520,
          scrollerMountDelayAfterResponseMs: 200,
          firstRowMountAtMs: 540,
          prePaintRowMountCommits: 1,
          rows: {
            distinctRows: 10,
            mounts: 10,
            prePaintUpdates: 14,
            postPaintUpdates: 2,
            totalUpdates: 16,
            rendersPerRow: { min: 1, median: 2, max: 3 },
          },
          commits,
        },
        cpuProfile: {
          windowMs: 640.5,
          sampledMs: 630,
          activeMs: 510.2,
          idleMs: 90,
          gcMs: 18.4,
          programMs: 11.4,
          sampleCount: 3000,
          topSelf: hotspots,
          topTotal: hotspots,
          topAppEntrypoints: [],
          bySource: [],
          byBucket: [
            { bucket: "react", selfMs: 182.3, selfPct: 35.7 },
            { bucket: "app", selfMs: 140.1, selfPct: 27.5 },
          ],
        },
        forcedReflows: forced,
        warnings: [],
      },
      {
        project: "raft-web",
        env: "staging",
        runId: "run-123",
        toolVersion: "0.29.0",
        backfilled: false,
        traceUrl: "https://app.raft.build/artifacts/abc/trace.json.gz",
        traceSha256: "deadbeef",
        profileUrl: "https://app.raft.build/artifacts/abc/profile.cpuprofile.gz",
        profileSha256: "cafebabe",
      },
    );

    expect(row.source_command).toBe("diagnose");
    expect(row.run_id).toBe("run-123");
    expect(row.backfilled).toBe(false);
    expect(row.cohort_key).toBe("local|SJC|bench-v1@5395d2b0|cpu4|rtt0");
    expect(row.task_ms).toBe(580.4);
    expect(row.script_ms).toBe(390.2);
    expect(row.style_ms).toBe(95.1);
    expect(row.layout_ms).toBe(42.3);
    expect(row.forced_layout_ms).toBe(65.4);
    expect(row.forced_layout_count).toBe(28);
    expect(row.large_style_passes).toBe(1);
    expect(row.cpu_active_ms).toBe(510.2);
    expect(row.cpu_gc_ms).toBe(18.4);
    expect(row.cpu_react_ms).toBe(182.3);
    expect(row.cpu_app_ms).toBe(140.1);
    expect(row.react_commit_count).toBe(20);
    expect(row.react_commit_total_ms).toBe(312.8);
    expect(row.react_commit_max_ms).toBe(48.5);
    expect(row.commits_before_scroller).toBe(2);
    expect(row.scroller_mount_delay_ms).toBe(200);
    expect(row.pre_paint_row_commits).toBe(1);
    expect(row.distinct_rows).toBe(10);
    expect(row.row_pre_paint_updates).toBe(14);
    expect(row.max_main_thread_savings_ms).toBe(610.2);

    // Bounded Top-N JSON caps
    expect(row.top_self_frames).toHaveLength(MAX_TOP_FRAMES);
    expect(row.top_total_frames).toHaveLength(MAX_TOP_FRAMES);
    expect(row.top_forced_stacks).toHaveLength(MAX_TOP_FORCED_STACKS);
    expect(row.top_forced_stacks[0]!.callStack).toHaveLength(MAX_FORCED_STACK_DEPTH);
    expect(row.commit_summary?.commits).toHaveLength(MAX_COMMIT_WATERFALL_ENTRIES);
    expect(row.commit_summary?.commits[0]!.topComponents).toHaveLength(3);

    // External compressed trace references
    expect(row.trace_url).toBe("https://app.raft.build/artifacts/abc/trace.json.gz");
    expect(row.trace_sha256).toBe("deadbeef");
    expect(row.profile_sha256).toBe("cafebabe");
  });

  it("converts interact --trace reports into one perf.diagnose_runs row per traced switch kind", () => {
    const rows = interactTraceReportToRows(
      {
        tool: "raft-perf interact",
        measuredAt: "2026-11-15T06:00:00.000Z",
        origin: "https://raft-app-staging.botiverse.dev",
        page: { server: "qa-perf-bench", channel: "bench-v1", other: "bench-other" },
        commitSha: "11223344",
        metrics: { channel_first_visit_ms: 410, channel_switch_ms: 215, thread_open_ms: 190 },
        work: {
          windowMs: 3000,
          channel_first_visit: { switches: 3, taskMs: 620, scriptMs: 410, styleMs: 90, layoutMs: 35, forcedMs: 50, stylePasses: 6, styleElements: 4100, layouts: 4, largeStylePasses: 2 },
          thread_open: null,
          channel_switch_away: { switches: 3, taskMs: 310, scriptMs: 200, styleMs: 40, layoutMs: 15, forcedMs: 20, stylePasses: 3, styleElements: 1800, layouts: 2, largeStylePasses: 1 },
          channel_switch_back: { switches: 3, taskMs: 450, scriptMs: 300, styleMs: 70, layoutMs: 25, forcedMs: 40, stylePasses: 5, styleElements: 3600, layouts: 3, largeStylePasses: 1 },
        },
      },
      {
        project: "raft-web",
        env: "staging",
        runId: "run-trace-1",
        toolVersion: "0.29.0",
        backfilled: true,
      },
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.scenario)).toEqual(["channel_first_visit", "channel_switch_away", "channel_switch_back"]);
    expect(rows[0]!.source_command).toBe("interact-trace");
    expect(rows[0]!.backfilled).toBe(true);
    expect(rows[0]!.task_ms).toBe(620);
    expect(rows[0]!.forced_layout_ms).toBe(50);
    expect(rows[0]!.painted_ms).toBe(410);
  });

  it("writes deterministic gzipped archives with matching sha256 and deterministic backfill run_ids", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "raft-perf-gz-"));
    try {
      const p1 = path.join(dir, "a.trace.json.gz");
      const p2 = path.join(dir, "b.trace.json.gz");
      const payload = JSON.stringify({ traceEvents: [{ name: "RunTask", dur: 5000 }] });
      const r1 = archiveGzipFile(payload, p1);
      const r2 = archiveGzipFile(payload, p2);
      expect(r1.sha256).toBe(r2.sha256);
      expect(r1.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(gunzipSync(readFileSync(p1)).toString("utf8")).toBe(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const id1 = deterministicBackfillRunId("2026-11-12/diagnose.json");
    const id2 = deterministicBackfillRunId("2026-11-12/diagnose.json");
    const id3 = deterministicBackfillRunId("2026-11-13/diagnose.json");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
