/**
 * raft-perf advise, the pure part: turn what `load` and `snapshot` measured
 * into findings, each valued on the time ledger, ranked by the most it could
 * save in THIS scenario. docs/frontend/perf-measure.md, "advise".
 *
 * Two layers. Rules find things (conditions follow perfsee's and rsdoctor's,
 * re-derived for what we can observe from a deployed page). Valuation hangs
 * each finding on a ledger segment and bounds its gain: a change to bytes
 * cannot save more than the download segment, and so on. A bound is an upper
 * limit, never a promise.
 */
import type { FirstScreenDiff, FirstScreenSnapshot } from "./firstScreen";
import { isNoStore } from "./firstScreen";

/** Medians of one page from a `load` report (`pages[name]`). */
export interface PageSummary {
  ready_ms: number | null;
  ttfb_ms: number | null;
  total_bytes: number | null;
  js_bytes: number | null;
  request_count: number | null;
  ledger_main_thread_ms: number | null;
  ledger_download_ms: number | null;
  ledger_network_wait_ms: number | null;
  ledger_unexplained_ms: number | null;
}

export interface Scenario {
  project: string;
  env: string;
  page: string;
  state: string;
  net: string;
}

export type Segment = "main_thread" | "download" | "network_wait" | "unexplained" | "repeat_visit";
/** How far the bound can be trusted: `relative` = lab timing on one runner, `exact` = bytes and counts. */
export type Trust = "exact" | "relative";

export interface Finding {
  id: string;
  title: string;
  segment: Segment;
  /**
   * The most this could save in this scenario, ms: always within the scenario's ready time. Null when the finding
   * is about another moment (a repeat visit, the first visit after a release) or cannot be bounded from what was measured.
   */
  upperBoundMs: number | null;
  /** For findings about bytes downloaded again: how many compressed bytes. Exact. */
  costBytes?: number;
  /** Share of this scenario's ready time the bound is, 0..1. */
  shareOfReady: number | null;
  trust: Trust;
  evidence: string[];
  /** What to try, in order of how directly it attacks the segment. */
  actions: string[];
  /** The command that shows whether a change helped, for this scenario. */
  verify: string;
}

export interface Advice {
  scenario: Scenario;
  readyMs: number | null;
  /** Ranked: a large unexplained share first when present; then time-bounded findings, largest bound first; then byte findings, most bytes first. */
  findings: Finding[];
  notes: string[];
}

/** A file is "large" for a first screen at perfsee's line for synchronous assets: 200 KB uncompressed. */
export const LARGE_FILE_BYTES = 200_000;
/** A segment under this share of ready is not worth a finding. */
export const MIN_SEGMENT_SHARE = 0.1;
/** perfsee's cache-invalidation lines: 30% of first-screen bytes re-downloaded is a warning, 80% is bad. */
export const INVALIDATION_WARN = 0.3;
export const INVALIDATION_BAD = 0.8;
/** Above this share of ready with nothing observed happening, say so before anything else is sized. */
export const UNEXPLAINED_SHARE = 0.2;

const kb = (n: number) => `${Math.round(n / 1024).toLocaleString("en-US")} KB`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export interface AdviseInput {
  scenario: Scenario;
  page: PageSummary;
  /** The deployed first screen, for per-file evidence and cache findings. */
  snapshot?: FirstScreenSnapshot;
  /** Production (base) against the candidate (head), for the release finding. */
  diff?: FirstScreenDiff;
  /** The command line that produced `page`, repeated as the verification step. */
  loadCommand: string;
}

export function advise(input: AdviseInput): Advice {
  const { scenario, page, snapshot, diff, loadCommand } = input;
  const ready = page.ready_ms;
  const findings: Finding[] = [];
  const notes: string[] = [];
  if (ready == null || ready <= 0) return { scenario, readyMs: ready, findings, notes: ["the page never became ready: fix the measurement before reading advice"] };
  const share = (ms: number | null) => (ms == null ? null : Math.round((ms / ready) * 1000) / 1000);
  const verify = `${loadCommand}   # compare ready_ms and the segment before and after, same state and net`;
  // Bytes per ms while downloading in this scenario. A rough rate (bytes that finished before ready over the download
  // segment): it only sizes files against each other inside the download segment, and is never used as a bound by itself.
  const throughput = page.total_bytes && page.ledger_download_ms && page.ledger_download_ms > 0 ? page.total_bytes / page.ledger_download_ms : null;
  const round = (n: number) => Math.round(n);

  const dl = round(page.ledger_download_ms ?? 0);
  if (dl / ready >= MIN_SEGMENT_SHARE) {
    const evidence = [`${dl} ms of ${ready} ms (${pct(dl / ready)}) is spent receiving response bodies; ${page.total_bytes == null ? "?" : kb(page.total_bytes)} arrive before ready`];
    if (snapshot) {
      const big = [...snapshot.files].filter((f) => f.bytes > LARGE_FILE_BYTES).sort((a, b) => b.brBytes - a.brBytes).slice(0, 5);
      // an estimate, capped: a file cannot account for more of the wait than the whole download segment
      for (const f of big) evidence.push(`${f.name}: ${kb(f.brBytes)} compressed (${kb(f.bytes)} raw)${throughput ? `, roughly ${Math.min(dl, round(f.brBytes / throughput))} ms of this segment at the measured rate (an estimate)` : ""}`);
    }
    findings.push({
      id: "download-bound",
      title: "Most of the wait is downloading bytes",
      segment: "download",
      upperBoundMs: dl,
      shareOfReady: share(dl),
      trust: "relative",
      evidence,
      actions: [
        // when little script finished before ready, the page did not wait for it: the script only competed for bandwidth
        page.js_bytes != null && page.total_bytes && page.js_bytes / page.total_bytes < 0.2
          ? "Ready does not wait for the scripts here: they compete for bandwidth with what the first screen needs. Defer them or lower their priority (fetchpriority, loading them after first paint)"
          : "Load less before ready: split the largest first-screen file and load the parts the first screen does not use on demand",
        "Check that responses are compressed with Brotli",
        "Remove library versions bundled twice",
      ],
      verify,
    });
  }

  const mt = round(page.ledger_main_thread_ms ?? 0);
  if (mt / ready >= MIN_SEGMENT_SHARE) {
    findings.push({
      id: "main-thread-bound",
      title: "The page is busy running code before it can show content",
      segment: "main_thread",
      upperBoundMs: mt,
      shareOfReady: share(mt),
      trust: "relative",
      evidence: [`${mt} ms of ${ready} ms (${pct(mt / ready)}) is long tasks on the main thread${page.js_bytes ? `; ${kb(page.js_bytes)} of script arrive before ready` : ""}`],
      actions: ["Find which modules run before ready and defer those the first screen does not need (dynamic import)", "Render less in the first pass (fewer rows, defer off-screen parts)", "Take a trace of this scenario to see which functions the long tasks are"],
      verify,
    });
  }

  const nw = round(page.ledger_network_wait_ms ?? 0);
  if (nw / ready >= MIN_SEGMENT_SHARE) {
    const serverShare = page.ttfb_ms != null && nw > 0 ? Math.min(1, page.ttfb_ms / nw) : null;
    const evidence = [`${nw} ms of ${ready} ms (${pct(nw / ready)}) has a request out and no response yet; ${page.request_count ?? "?"} requests finish before ready`];
    if (page.ttfb_ms != null) evidence.push(`the document's own first byte takes ${page.ttfb_ms} ms${serverShare != null ? ` (${pct(serverShare)} of this segment)` : ""}: the rest is other requests waiting, queued, or not needed yet`);
    findings.push({
      id: "network-wait-bound",
      title: "The page waits on requests that have not answered",
      segment: "network_wait",
      upperBoundMs: nw,
      shareOfReady: share(nw),
      trust: "relative",
      evidence,
      actions: ["Make requests that wait for each other start together (preload, or start data requests from the HTML)", "Reuse connections: preconnect to other origins the first screen needs", serverShare != null && serverShare >= 0.5 ? "The document itself is most of this: look at the server or its cache" : "Check which requests before ready the first screen does not need, and delay them"],
      verify,
    });
  }

  const un = round(page.ledger_unexplained_ms ?? 0);
  if (un / ready >= UNEXPLAINED_SHARE) {
    findings.push({
      id: "unexplained",
      title: "A large part of the wait is not explained by anything measured",
      segment: "unexplained",
      upperBoundMs: null,
      shareOfReady: share(un),
      trust: "relative",
      evidence: [`${un} ms of ${ready} ms (${pct(un / ready)}) has no long task and no request in flight: timers, short script bursts under 50 ms, or waiting on something not observed`],
      actions: ["Take a trace of this scenario before optimizing anything: the other findings may be mis-sized until this is understood"],
      verify,
    });
  }

  if (snapshot) {
    const uncached = snapshot.files.filter(isNoStore);
    if (uncached.length) {
      const bytes = uncached.reduce((a, f) => a + f.brBytes, 0);
      findings.push({
        id: "no-store-first-screen",
        title: "First-screen files are downloaded again on every visit",
        segment: "repeat_visit",
        // a cost on other visits, not part of this load's time: sized in bytes, not ms
        upperBoundMs: null,
        costBytes: bytes,
        shareOfReady: null,
        trust: "exact",
        evidence: [`${uncached.length} first-screen file(s), ${kb(bytes)} compressed, are served no-store: ${uncached.slice(0, 5).map((f) => f.name).join(", ")}`],
        actions: ["Serve files whose name carries a content hash as immutable with a long max-age"],
        verify: `the same load with --state repeat (${loadCommand})   # load_total_bytes on a repeat visit should fall`,
      });
    }
  }

  if (diff && diff.invalidatedShare >= INVALIDATION_WARN) {
    const changed = diff.files.filter((f) => f.change !== "unchanged").sort((a, b) => (b.headBrBytes ?? 0) - (a.headBrBytes ?? 0)).slice(0, 6);
    findings.push({
      id: "release-invalidation",
      title: `A release makes returning visitors download ${pct(diff.invalidatedShare)} of the first screen again`,
      segment: "repeat_visit",
      upperBoundMs: null,
      costBytes: diff.invalidatedBrBytes,
      shareOfReady: null,
      trust: "exact",
      evidence: [`${kb(diff.invalidatedBrBytes)} of ${kb(diff.head.brBytes)} changed between ${diff.base.commitSha?.slice(0, 8) ?? "base"} and ${diff.head.commitSha?.slice(0, 8) ?? "head"} (${diff.invalidatedShare >= INVALIDATION_BAD ? "bad" : "warning"}: the lines are ${pct(INVALIDATION_WARN)} and ${pct(INVALIDATION_BAD)})`, ...changed.map((f) => `${f.name}: ${f.change}, ${kb(f.headBrBytes ?? 0)}`)],
      actions: ["Keep third-party code in files of its own so app changes do not rename them", "If a vendor file changed without a dependency bump, find what made its content differ (module order, a shared helper pulled in)"],
      verify: "raft-perf diff --base <production> --head <candidate>   # invalidatedShare should fall",
    });
  }

  // "understand it first" leads when it fires: the other findings may be mis-sized until the unexplained time is explained
  const rank = (f: Finding) => (f.id === "unexplained" ? 3 : f.upperBoundMs != null ? 2 : f.costBytes != null ? 1 : 0);
  findings.sort((a, b) => rank(b) - rank(a) || (b.upperBoundMs ?? 0) - (a.upperBoundMs ?? 0) || (b.costBytes ?? 0) - (a.costBytes ?? 0));
  if (findings.some((f) => f.costBytes != null)) notes.push("findings about bytes downloaded again (a repeat visit, the first visit after a release) are sized in bytes: they cost time on those visits, which this scenario did not measure");
  notes.push("time bounds are upper limits for this scenario on this runner, not predictions; the same finding is worth a different amount on another network");
  return { scenario, readyMs: ready, findings, notes };
}
