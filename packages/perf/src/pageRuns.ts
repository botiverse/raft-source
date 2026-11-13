/**
 * Rows for ScopeDB perf.page_runs (docs/frontend/perf-measure.md, "Stored data"):
 * one per measured load. Web Vitals get columns (ttfb_ms stays null from measure: see below); Raft's own metrics go in
 * `extra`, named with their unit. Pure, pinned by pageRuns.test.ts.
 */

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
  extra: Record<string, number | null>;
}

export function toPageRunRows(results: Record<"on" | "off", readonly LoadMetrics[]>, ctx: PageRunContext): PageRunRow[] {
  const rows: PageRunRow[] = [];
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
        // measure pauses the document response (both arms) and hands it to the browser whole, so its TTFB is close to
        // the last byte: not comparable with field TTFB, so not stored (still in the run JSON).
        ttfb_ms: null,
        fcp_ms: r.fcp,
        verdict: ctx.verdict,
        extra: {
          content_ms: r.contentMs,
          messages_fetched_ms: r.messagesFetched,
          boot_read_count: r.bootReads,
          preflight_count: r.preflights,
          status429_count: r.status429,
          status5xx_count: r.status5xx,
          script_bytes: r.scriptBytes,
        },
      });
    });
  }
  return rows;
}
