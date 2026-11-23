/**
 * Structured rows for ScopeDB `perf.diagnose_runs` (#proj-frontend:#78; agreed
 * with AndyLok and InNOut in #proj-frontend:ac6e1283).
 *
 * Joins with `perf.page_runs` via `run_id` and `cohort_key`.
 *
 * Layout:
 *   - Top-level numeric columns for direct SQL trending and regression queries:
 *     main-thread buckets (`task_ms`, `script_ms`, `style_ms`, `layout_ms`),
 *     forced reflow counts & ms, V8 CPU buckets, and React commit counts,
 *     total/max duration, scroller delay, and pre-paint row mounts/updates.
 *   - Bounded Top-N JSON columns (`top_self_frames`, `top_total_frames`,
 *     `top_forced_stacks`, `commit_summary`, `extra`) so rows stay compact.
 *   - Raw compressed traces/profiles live in Raft Artifacts or object storage
 *     and are referenced here only by `trace_url` + `trace_sha256` (and
 *     `profile_url` + `profile_sha256`), never embedded in ScopeDB.
 *   - `backfilled`: `true` for rows converted from historical daily JSON reports
 *     (e.g. 2026-11-12+ via `raft-perf diagnose-backfill`), `false` for live runs.
 *
 * Pure serialization & archiving helpers, pinned by `diagnoseRuns.test.ts`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { type Cohort, cohortExtra } from "./cohort";
import type { CommitWaterfallSummary } from "./commitWaterfall";
import type { CpuWindowAnalysis, CriticalPathSummary, ForcedReflowCulprit, HotspotEntry } from "./cpuProfile";
import type { WorkSplit } from "./workSplit";

export const MAX_TOP_FRAMES = 10;
export const MAX_TOP_FORCED_STACKS = 10;
export const MAX_FORCED_STACK_DEPTH = 8;
export const MAX_COMMIT_WATERFALL_ENTRIES = 15;

export interface DiagnoseHotspotSummary {
  functionName: string;
  source: string;
  line: number | null;
  bucket: string;
  selfMs: number;
  totalMs: number;
  selfPct: number;
  totalPct: number;
}

export interface DiagnoseForcedReflowSummary {
  functionName: string;
  source: string;
  line: number | null;
  bucket: string;
  count: number;
  layoutCount: number;
  styleCount: number;
  totalForcedMs: number;
  maxElements: number;
  callStack: string[];
}

export interface DiagnoseCommitEntrySummary {
  index: number;
  atMs: number;
  phase: string;
  durationMs: number | null;
  fiberMounts: number;
  fiberUpdates: number;
  rowMounts: number;
  rowUpdates: number;
  topComponents: Array<{ name: string; count: number }>;
}

export interface DiagnoseCommitSummary {
  rendererAttached: boolean;
  totalCommits: number;
  droppedCommits: number;
  byPhase: Record<string, number>;
  rows: {
    distinctRows: number;
    mounts: number;
    prePaintUpdates: number;
    postPaintUpdates: number;
    rendersPerRowMedian: number;
    rendersPerRowMax: number;
  };
  commits: DiagnoseCommitEntrySummary[];
}

export interface DiagnoseRunRow {
  project: string;
  env: string;
  run_id: string;
  tool_version: string;
  taken_at: string;
  origin: string;
  commit_sha: string | null;
  source_command: "diagnose" | "interact-trace";
  scenario: string;
  mode: string | null;
  focus_window: string | null;
  page_server: string | null;
  page_channel: string | null;
  page_other: string | null;
  cohort_key: string | null;
  browser_where: string | null;
  fixture_tag: string | null;
  cpu_slowdown: number | null;
  backfilled: boolean;

  // Top-level numeric columns for direct SQL trending
  window_ms: number | null;
  painted_ms: number | null;
  response_to_paint_ms: number | null;
  task_ms: number | null;
  script_ms: number | null;
  style_ms: number | null;
  layout_ms: number | null;
  forced_layout_ms: number | null;
  forced_layout_count: number | null;
  style_passes: number | null;
  style_elements: number | null;
  large_style_passes: number | null;
  cpu_active_ms: number | null;
  cpu_gc_ms: number | null;
  cpu_react_ms: number | null;
  cpu_app_ms: number | null;
  react_commit_count: number | null;
  react_commit_total_ms: number | null;
  react_commit_max_ms: number | null;
  commits_before_scroller: number | null;
  scroller_mount_delay_ms: number | null;
  pre_paint_row_commits: number | null;
  distinct_rows: number | null;
  row_pre_paint_updates: number | null;
  max_main_thread_savings_ms: number | null;

  // Bounded Top-N JSON columns
  top_self_frames: DiagnoseHotspotSummary[];
  top_total_frames: DiagnoseHotspotSummary[];
  top_forced_stacks: DiagnoseForcedReflowSummary[];
  commit_summary: DiagnoseCommitSummary | null;
  extra: Record<string, number | string | boolean | null>;

  // External compressed raw trace / CPU profile references (never stored inline in ScopeDB)
  trace_url: string | null;
  trace_sha256: string | null;
  profile_url: string | null;
  profile_sha256: string | null;
}

export interface DiagnoseRowContext {
  project: string;
  env: string;
  runId: string;
  toolVersion: string;
  backfilled?: boolean;
  traceUrl?: string | null;
  traceSha256?: string | null;
  profileUrl?: string | null;
  profileSha256?: string | null;
  /** Optional additional metadata merged into `extra` (e.g. `backfill_host`, `series_break`, `has_series_break`). */
  extraOverrides?: Record<string, number | string | boolean | null>;
}

/** Minimal shape accepted from both live and historical `raft-perf diagnose` JSON reports. */
export interface DiagnoseReportLike {
  tool?: string;
  measuredAt?: string;
  scenario?: string;
  mode?: string | null;
  focusWindow?: string | null;
  effectiveWindow?: string | null;
  windowMs?: number | null;
  origin?: string;
  sourceMapsLoaded?: number;
  page?: { server?: string; channel?: string; other?: string };
  cohort?: Cohort | null;
  host?: { cpus?: number; benchmarkMedianMs?: number | null } | null;
  commitSha?: string | null;
  serverTimingMs?: number | null;
  timings?: {
    messagesStartMs?: number | null;
    messagesResponseEndMs?: number | null;
    firstRowMs?: number | null;
    paintedMs?: number | null;
    responseToPaintMs?: number | null;
    shownBeforeResponse?: boolean;
  } | null;
  criticalPath?: CriticalPathSummary | null;
  workSplit?: WorkSplit | null;
  commitWaterfall?: Partial<CommitWaterfallSummary> | null;
  cpuProfile?: Partial<CpuWindowAnalysis> | null;
  forcedReflows?: readonly ForcedReflowCulprit[] | null;
  warnings?: readonly string[];
}

export interface InteractTraceWorkEntry {
  switches?: number;
  taskMs?: number;
  scriptMs?: number;
  styleMs?: number;
  layoutMs?: number;
  forcedMs?: number;
  stylePasses?: number;
  styleElements?: number;
  layouts?: number;
  largeStylePasses?: number;
}

/** Minimal shape accepted from both live and historical `raft-perf interact --trace` JSON reports. */
export interface InteractTraceReportLike {
  tool?: string;
  measuredAt?: string;
  origin?: string;
  page?: { server?: string; channel?: string; other?: string };
  cohort?: Cohort | null;
  host?: { cpus?: number; benchmarkMedianMs?: number | null } | null;
  commitSha?: string | null;
  warnings?: readonly string[];
  metrics?: Record<string, number | null | undefined>;
  work?: {
    windowMs?: number;
    channel_first_visit?: InteractTraceWorkEntry | null;
    thread_open?: InteractTraceWorkEntry | null;
    channel_switch_away?: InteractTraceWorkEntry | null;
    channel_switch_back?: InteractTraceWorkEntry | null;
  } | null;
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

const intOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;

function compactHotspots(list: readonly HotspotEntry[] | undefined | null): DiagnoseHotspotSummary[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_TOP_FRAMES).map((h) => ({
    functionName: h.functionName,
    source: h.source,
    line: h.line ?? null,
    bucket: h.bucket,
    selfMs: h.selfMs,
    totalMs: h.totalMs,
    selfPct: h.selfPct,
    totalPct: h.totalPct,
  }));
}

function compactForcedStacks(list: readonly ForcedReflowCulprit[] | undefined | null): DiagnoseForcedReflowSummary[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_TOP_FORCED_STACKS).map((f) => ({
    functionName: f.functionName,
    source: f.source,
    line: f.line ?? null,
    bucket: f.bucket,
    count: f.count,
    layoutCount: f.layoutCount,
    styleCount: f.styleCount,
    totalForcedMs: f.totalForcedMs,
    maxElements: f.maxElements,
    callStack: Array.isArray(f.callStack) ? f.callStack.slice(0, MAX_FORCED_STACK_DEPTH) : [],
  }));
}

function compactCommitSummary(cw: Partial<CommitWaterfallSummary> | undefined | null): DiagnoseCommitSummary | null {
  if (!cw) return null;
  const commits = Array.isArray(cw.commits)
    ? cw.commits.slice(0, MAX_COMMIT_WATERFALL_ENTRIES).map((c) => ({
        index: c.index,
        atMs: c.atMs,
        phase: c.phase,
        durationMs: typeof c.durationMs === "number" && Number.isFinite(c.durationMs) ? c.durationMs : null,
        fiberMounts: c.fiberMounts,
        fiberUpdates: c.fiberUpdates,
        rowMounts: c.rowMounts,
        rowUpdates: c.rowUpdates,
        topComponents: Array.isArray(c.topComponents) ? c.topComponents.slice(0, 3) : [],
      }))
    : [];
  return {
    rendererAttached: Boolean(cw.rendererAttached),
    totalCommits: cw.totalCommits ?? commits.length,
    droppedCommits: cw.droppedCommits ?? 0,
    byPhase: (cw.byPhase as Record<string, number> | undefined) ?? {},
    rows: {
      distinctRows: cw.rows?.distinctRows ?? 0,
      mounts: cw.rows?.mounts ?? 0,
      prePaintUpdates: cw.rows?.prePaintUpdates ?? 0,
      postPaintUpdates: cw.rows?.postPaintUpdates ?? 0,
      rendersPerRowMedian: cw.rows?.rendersPerRow?.median ?? 0,
      rendersPerRowMax: cw.rows?.rendersPerRow?.max ?? 0,
    },
    commits,
  };
}

function selectPrimaryWorkSplit(report: DiagnoseReportLike): WorkSplit | null {
  if (report.workSplit) return report.workSplit;
  const phases = report.criticalPath?.phases;
  if (!Array.isArray(phases) || phases.length === 0) return null;
  const effective = report.effectiveWindow ?? report.focusWindow ?? "response-to-paint";
  if (effective === "post-paint") {
    return phases.find((p) => p.phase === "post-paint-settle")?.workSplit ?? null;
  }
  if (effective === "response-to-paint") {
    return (
      phases.find((p) => p.phase === "response-to-paint")?.workSplit ??
      phases.find((p) => p.phase === "cached-to-paint")?.workSplit ??
      null
    );
  }
  // full-load: aggregate all pre-paint phases (`before-request`, `in-flight`, `response-to-paint`, `cached-to-paint`)
  const prePaint = phases.filter((p) => p.phase !== "post-paint-settle");
  if (prePaint.length === 0) return phases[0]!.workSplit;
  return {
    windowMs: Math.round(prePaint.reduce((s, p) => s + p.workSplit.windowMs, 0) * 10) / 10,
    recordedMs: Math.round(prePaint.reduce((s, p) => s + p.workSplit.recordedMs, 0) * 10) / 10,
    taskMs: Math.round(prePaint.reduce((s, p) => s + p.workSplit.taskMs, 0) * 10) / 10,
    scriptMs: Math.round(prePaint.reduce((s, p) => s + p.workSplit.scriptMs, 0) * 10) / 10,
    styleMs: Math.round(prePaint.reduce((s, p) => s + p.workSplit.styleMs, 0) * 10) / 10,
    layoutMs: Math.round(prePaint.reduce((s, p) => s + p.workSplit.layoutMs, 0) * 10) / 10,
    forcedMs: Math.round(prePaint.reduce((s, p) => s + p.workSplit.forcedMs, 0) * 10) / 10,
    stylePasses: prePaint.reduce((s, p) => s + p.workSplit.stylePasses, 0),
    styleElements: prePaint.reduce((s, p) => s + p.workSplit.styleElements, 0),
    layouts: prePaint.reduce((s, p) => s + p.workSplit.layouts, 0),
    largeStylePasses: prePaint.flatMap((p) => p.workSplit.largeStylePasses),
  };
}

/** Convert a `raft-perf diagnose` JSON report (live or historical) into a ScopeDB `perf.diagnose_runs` row. */
export function diagnoseReportToRow(report: DiagnoseReportLike, ctx: DiagnoseRowContext): DiagnoseRunRow {
  const split = selectPrimaryWorkSplit(report);
  const cpu = report.cpuProfile ?? null;
  const cw = report.commitWaterfall ?? null;
  const forcedList = Array.isArray(report.forcedReflows) ? report.forcedReflows : [];
  const forcedCountFromCulprits = forcedList.reduce((sum, f) => sum + (f.count ?? 0), 0);
  const forcedMsFromCulprits = forcedList.reduce((sum, f) => sum + (f.totalForcedMs ?? 0), 0);

  const byBucket = Array.isArray(cpu?.byBucket) ? cpu.byBucket : [];
  const bucketMs = (name: string): number | null => {
    const hit = byBucket.find((b) => b.bucket === name);
    return hit ? numOrNull(hit.selfMs) : byBucket.length > 0 ? 0 : null;
  };

  const cohortFields = report.cohort ? cohortExtra(report.cohort) : {};
  const legacyHostFields: Record<string, number | null> = !report.cohort && report.host
    ? {
        ...(typeof report.host.cpus === "number" ? { host_cpu_count: report.host.cpus } : {}),
        ...(report.host.benchmarkMedianMs !== undefined ? { host_benchmark_ms: report.host.benchmarkMedianMs } : {}),
      }
    : {};

  return {
    project: ctx.project,
    env: ctx.env,
    run_id: ctx.runId,
    tool_version: ctx.toolVersion,
    taken_at: report.measuredAt ?? new Date().toISOString(),
    origin: report.origin ?? "",
    commit_sha: report.commitSha ?? null,
    source_command: "diagnose",
    scenario: report.scenario ?? "startup",
    mode: report.mode ?? null,
    focus_window: report.effectiveWindow ?? report.focusWindow ?? (report.windowMs != null ? `${report.windowMs}ms` : null),
    page_server: report.page?.server ?? null,
    page_channel: report.page?.channel ?? null,
    page_other: report.page?.other ?? null,
    cohort_key: report.cohort?.key ?? null,
    browser_where: report.cohort?.browserWhere ?? null,
    fixture_tag: report.cohort?.fixture ?? null,
    cpu_slowdown: numOrNull(report.cohort?.cpuSlowdown),
    backfilled: Boolean(ctx.backfilled),

    window_ms: numOrNull(cpu?.windowMs ?? split?.windowMs ?? report.windowMs),
    painted_ms: numOrNull(report.timings?.paintedMs),
    response_to_paint_ms: numOrNull(report.timings?.responseToPaintMs),
    task_ms: numOrNull(split?.taskMs),
    script_ms: numOrNull(split?.scriptMs),
    style_ms: numOrNull(split?.styleMs),
    layout_ms: numOrNull(split?.layoutMs),
    forced_layout_ms: numOrNull(split ? split.forcedMs : forcedList.length > 0 ? forcedMsFromCulprits : null),
    forced_layout_count: forcedList.length > 0 ? forcedCountFromCulprits : split ? 0 : null,
    style_passes: intOrNull(split?.stylePasses),
    style_elements: intOrNull(split?.styleElements),
    large_style_passes: split ? split.largeStylePasses.length : null,
    cpu_active_ms: numOrNull(cpu?.activeMs),
    cpu_gc_ms: numOrNull(cpu?.gcMs),
    cpu_react_ms: bucketMs("react"),
    cpu_app_ms: bucketMs("app"),
    react_commit_count: cw?.rendererAttached ? intOrNull(cw.totalCommits) : null,
    react_commit_total_ms: cw?.rendererAttached ? numOrNull(cw.totalCommitMs) : null,
    react_commit_max_ms: cw?.rendererAttached ? numOrNull(cw.maxCommitMs) : null,
    commits_before_scroller: cw?.rendererAttached ? intOrNull(cw.commitsBeforeScrollerMount) : null,
    scroller_mount_delay_ms: cw?.rendererAttached ? numOrNull(cw.scrollerMountDelayAfterResponseMs) : null,
    pre_paint_row_commits: cw?.rendererAttached ? intOrNull(cw.prePaintRowMountCommits) : null,
    distinct_rows: cw?.rendererAttached ? intOrNull(cw.rows?.distinctRows) : null,
    row_pre_paint_updates: cw?.rendererAttached ? intOrNull(cw.rows?.prePaintUpdates) : null,
    max_main_thread_savings_ms: numOrNull(report.criticalPath?.maxMainThreadSavingsMs),

    top_self_frames: compactHotspots(cpu?.topSelf),
    top_total_frames: compactHotspots(cpu?.topTotal),
    top_forced_stacks: compactForcedStacks(report.forcedReflows),
    commit_summary: compactCommitSummary(cw),
    extra: {
      source_maps_loaded: report.sourceMapsLoaded ?? 0,
      warnings_count: report.warnings?.length ?? 0,
      ...(report.serverTimingMs !== undefined ? { server_timing_ms: report.serverTimingMs } : {}),
      ...(report.timings?.messagesStartMs !== undefined ? { messages_start_ms: report.timings.messagesStartMs } : {}),
      ...(report.timings?.messagesResponseEndMs !== undefined ? { messages_response_end_ms: report.timings.messagesResponseEndMs } : {}),
      ...(report.timings?.shownBeforeResponse !== undefined ? { shown_before_response: report.timings.shownBeforeResponse } : {}),
      ...legacyHostFields,
      ...cohortFields,
      ...(ctx.extraOverrides ?? {}),
    },

    trace_url: ctx.traceUrl ?? null,
    trace_sha256: ctx.traceSha256 ?? null,
    profile_url: ctx.profileUrl ?? null,
    profile_sha256: ctx.profileSha256 ?? null,
  };
}

const INTERACT_TRACE_KINDS = [
  ["channel_first_visit", "channel_first_visit_ms"],
  ["thread_open", "thread_open_ms"],
  ["channel_switch_away", "channel_switch_ms"],
  ["channel_switch_back", "channel_switch_ms"],
] as const;

/**
 * Convert a `raft-perf interact --trace` JSON report into `perf.diagnose_runs`
 * rows (one row per traced switch kind present in `report.work`).
 */
export function interactTraceReportToRows(
  report: InteractTraceReportLike,
  ctx: DiagnoseRowContext,
): DiagnoseRunRow[] {
  const work = report.work;
  if (!work || typeof work !== "object") return [];
  const windowMs = numOrNull(work.windowMs) ?? 3000;
  const cohortFields = report.cohort ? cohortExtra(report.cohort) : {};
  const legacyHostFields: Record<string, number | null> = !report.cohort && report.host
    ? {
        ...(typeof report.host.cpus === "number" ? { host_cpu_count: report.host.cpus } : {}),
        ...(report.host.benchmarkMedianMs !== undefined ? { host_benchmark_ms: report.host.benchmarkMedianMs } : {}),
      }
    : {};
  const rows: DiagnoseRunRow[] = [];

  for (const [kind, metricKey] of INTERACT_TRACE_KINDS) {
    const entry = work[kind];
    if (!entry || typeof entry !== "object") continue;
    rows.push({
      project: ctx.project,
      env: ctx.env,
      run_id: ctx.runId,
      tool_version: ctx.toolVersion,
      taken_at: report.measuredAt ?? new Date().toISOString(),
      origin: report.origin ?? "",
      commit_sha: report.commitSha ?? null,
      source_command: "interact-trace",
      scenario: kind,
      mode: null,
      focus_window: `${windowMs}ms`,
      page_server: report.page?.server ?? null,
      page_channel: report.page?.channel ?? null,
      page_other: report.page?.other ?? null,
      cohort_key: report.cohort?.key ?? null,
      browser_where: report.cohort?.browserWhere ?? null,
      fixture_tag: report.cohort?.fixture ?? null,
      cpu_slowdown: numOrNull(report.cohort?.cpuSlowdown),
      backfilled: Boolean(ctx.backfilled),

      window_ms: windowMs,
      painted_ms: numOrNull(report.metrics?.[metricKey]),
      response_to_paint_ms: null,
      task_ms: numOrNull(entry.taskMs),
      script_ms: numOrNull(entry.scriptMs),
      style_ms: numOrNull(entry.styleMs),
      layout_ms: numOrNull(entry.layoutMs),
      forced_layout_ms: numOrNull(entry.forcedMs),
      forced_layout_count: null,
      style_passes: intOrNull(entry.stylePasses),
      style_elements: intOrNull(entry.styleElements),
      large_style_passes: intOrNull(entry.largeStylePasses),
      cpu_active_ms: null,
      cpu_gc_ms: null,
      cpu_react_ms: null,
      cpu_app_ms: null,
      react_commit_count: null,
      react_commit_total_ms: null,
      react_commit_max_ms: null,
      commits_before_scroller: null,
      scroller_mount_delay_ms: null,
      pre_paint_row_commits: null,
      distinct_rows: null,
      row_pre_paint_updates: null,
      max_main_thread_savings_ms: null,

      top_self_frames: [],
      top_total_frames: [],
      top_forced_stacks: [],
      commit_summary: null,
      extra: {
        traced_switches: entry.switches ?? 0,
        layouts: entry.layouts ?? 0,
        warnings_count: report.warnings?.length ?? 0,
        ...legacyHostFields,
        ...cohortFields,
        ...(ctx.extraOverrides ?? {}),
      },

      trace_url: ctx.traceUrl ?? null,
      trace_sha256: ctx.traceSha256 ?? null,
      profile_url: null,
      profile_sha256: null,
    });
  }
  return rows;
}

/**
 * Compress a raw trace or CPU profile to deterministic gzip (mtime=0) and
 * return its output path, uncompressed/compressed byte sizes, and SHA-256 hex digest.
 */
export function archiveGzipFile(
  raw: string | Buffer,
  outPath: string,
): { path: string; sha256: string; compressedBytes: number; rawBytes: number } {
  const buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const gz = gzipSync(buf, { level: 6 });
  // Zero out gzip MTIME (bytes 4..7) & OS byte (byte 9) for deterministic sha256 across platforms.
  if (gz.byteLength >= 10) {
    gz[4] = 0;
    gz[5] = 0;
    gz[6] = 0;
    gz[7] = 0;
    gz[9] = 0xff;
  }
  const sha256 = createHash("sha256").update(gz).digest("hex");
  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(outPath, gz);
  return {
    path: outPath,
    sha256,
    compressedBytes: gz.byteLength,
    rawBytes: buf.byteLength,
  };
}

/**
 * Deterministic UUID-formatted backfill `run_id` derived from a stable seed
 * (e.g. relative file path + measuredAt) so repeated backfills are idempotent
 * for ScopeDB deduplication by `run_id`.
 */
export function deterministicBackfillRunId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
