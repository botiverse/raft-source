/**
 * Rows for ScopeDB perf.page_runs (docs/frontend/perf-measure.md, "Stored data"):
 * one per measured load. Web Vitals get columns (ttfb_ms stays null when measure
 * pauses the document response, and is stored when `storeTtfb` says the document
 * streamed unintercepted); Raft's own metrics and the run's `Cohort` go in
 * `extra`. Pure, pinned by pageRuns.test.ts.
 */

import { type Cohort, cohortExtra } from "./cohort";

export interface LoadMetrics {
  arm: "on" | "off";
  contentMs: number | null;
  lcp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
  inp: number | null;
  /** The commit the page named (its release identity) for this load. */
  commitSha: string | null;
  messagesFetched: number | null;
  bootReads: number;
  preflights: number;
  status429: number;
  status5xx: number;
  scriptBytes: number;
  /** Server-Timing duration of the first-page messages request, when reported. */
  serverTimingMs?: number | null;
}

export interface PageRunContext {
  project: string;
  env: string;
  runId: string;
  toolVersion: string;
  takenAt: string;
  origin: string;
  page: string;
  state: string;
  net: string;
  ab: string;
  verdict: string;
  /** The measuring machine: `hostExtra` (hostHealth.ts). */
  host: { host_cpu_count: number; host_benchmark_ms: number | null };
  /** Structured environment/fixture cohort (0.26.0+); allows Browser Run and fixture series in `perf.page_runs`. */
  cohort?: Cohort;
  /** Store `r.ttfb` in `ttfb_ms` (true when `--ab none` left the document unintercepted on the fast network). */
  storeTtfb?: boolean;
}

export interface PageRunRow {
  project: string;
  env: string;
  run_id: string;
  tool_version: string;
  taken_at: string;
  origin: string;
  commit_sha: string | null;
  page: string;
  state: string;
  net: string;
  ab: string;
  arm: "on" | "off";
  run_idx: number;
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
  ttfb_ms: number | null;
  fcp_ms: number | null;
  verdict: string;
  extra: Record<string, number | string | null>;
}

export function toPageRunRows(results: Record<"on" | "off", readonly LoadMetrics[]>, ctx: PageRunContext): PageRunRow[] {
  const rows: PageRunRow[] = [];
  const cohortFields = ctx.cohort ? cohortExtra(ctx.cohort) : {};
  for (const arm of ["on", "off"] as const) {
    results[arm].forEach((r, i) => {
      rows.push({
        project: ctx.project,
        env: ctx.env,
        run_id: ctx.runId,
        tool_version: ctx.toolVersion,
        taken_at: ctx.takenAt,
        origin: ctx.origin,
        commit_sha: r.commitSha,
        page: ctx.page,
        state: ctx.state,
        net: ctx.net,
        ab: ctx.ab,
        arm,
        run_idx: i,
        lcp_ms: r.lcp,
        inp_ms: r.inp,
        cls: r.cls,
        ttfb_ms: ctx.storeTtfb ? r.ttfb : null,
        fcp_ms: r.fcp,
        verdict: ctx.verdict,
        extra: {
          content_ms: r.contentMs,
          messages_fetched_ms: r.messagesFetched,
          ...(r.serverTimingMs !== undefined ? { server_timing_ms: r.serverTimingMs } : {}),
          boot_read_count: r.bootReads,
          preflight_count: r.preflights,
          status429_count: r.status429,
          status5xx_count: r.status5xx,
          script_bytes: r.scriptBytes,
          ...ctx.host,
          ...cohortFields,
        },
      });
    });
  }
  return rows;
}
