/**
 * First-class environment and workload cohort (`Cohort`): what machine, browser,
 * network path, throttling, document interception and benchmark fixture a
 * measurement ran on, and whether two measurements belong to the same series
 * (#proj-frontend:#71).
 *
 * Timings are a function of `(Code, Environment, Workload)`. Previously only
 * `host_cpu_count` and `host_benchmark_ms` of the caller's Node process were
 * recorded: a remote Browser Run session reported neither its own CPU speed nor
 * its edge datacenter (`colo`), `--jsonl` was refused for Browser Run, and
 * `check` / `claim verify` could not tell when the machine, datacenter,
 * document-interception path or channel fixture changed. Pure helpers here,
 * pinned by cohort.test.ts; `probeBrowserDevice` runs the same integer benchmark
 * inside an `about:blank` page of the target browser (local or remote).
 */

import type { Browser } from "playwright";
import type { BrowserWhere } from "./browser";

/** CPU speed step that marks another machine (docs/frontend/perf-measure.md, "Which machine measured a row"). */
export const BENCHMARK_STEP_RATIO = 1.5;
export const BENCHMARK_STEP_MS = 5;

/** Connection-setup RTT step that marks another network path / datacenter (e.g. 228 ms -> 11 ms). */
export const CONNECT_RTT_STEP_RATIO = 2;
export const CONNECT_RTT_STEP_MS = 40;

export interface BrowserDeviceProbe {
  /** `navigator.hardwareConcurrency` reported inside the browser. */
  browserCpuCount: number | null;
  /** `navigator.deviceMemory` (GiB) reported inside the browser, when supported. */
  browserMemoryGb: number | null;
  /** Median ms of the FNV-1a integer loop inside `about:blank` (unthrottled). */
  browserBenchmarkMs: number | null;
}

export interface Cohort {
  /** Canonical summary key for grouping series and spotting breaks. */
  key: string;
  browserWhere: BrowserWhere;
  /** 3-letter IATA metro code from `cf-ray` or `x-amz-cf-pop` (e.g. `HEL`, `SIN`, `IAD`), when present. */
  edgeColo: string | null;
  hostCpuCount: number;
  hostBenchmarkMs: number | null;
  browserCpuCount: number | null;
  browserMemoryGb: number | null;
  browserBenchmarkMs: number | null;
  /** Median TCP handshake 1-RTT to the origin/API in ms, when a fresh TCP connection was observed. */
  connectRttMs: number | null;
  cpuSlowdown: number;
  addedRttMs: number;
  net: string;
  /** True when the tool paused and fulfilled the top-level Document via CDP `Fetch.enable` (e.g. `measure --ab boot-prefetch`, or `measure` <= 0.25.0). */
  documentIntercepted: boolean;
  /** Verified frozen fixture tag (e.g. `bench-v1@5395d2b0`), or null for an unpinned channel/page. */
  fixture: string | null;
}

/** Optional cohort rules in a watermark file or derived from `claim --before` rows. */
export interface CohortExpectation {
  browserWhere?: BrowserWhere;
  edgeColo?: string;
  cpuSlowdown?: number;
  addedRttMs?: number;
  net?: string;
  documentIntercepted?: boolean;
  /** Expected fixture tag, or `null` when explicitly requiring unpinned; omit when unspecified. */
  fixture?: string | null;
  /** Reference browser (or local host) benchmark ms; differences past 1.5x and 5 ms (or missing actual) fail comparability. */
  benchmarkMs?: number;
  /** Reference TCP handshake 1-RTT ms; differences past 2x and 40 ms fail comparability. */
  connectRttMs?: number;
}

export interface CohortDifference {
  field: string;
  expected: unknown;
  actual: unknown;
  reason: string;
}

export interface CohortComparison {
  comparable: boolean;
  differences: CohortDifference[];
}

function median(values: readonly number[]): number | null {
  const finite = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!finite.length) return null;
  const mid = Math.floor(finite.length / 2);
  const raw = finite.length % 2 ? finite[mid]! : (finite[mid - 1]! + finite[mid]!) / 2;
  return Math.round(raw * 10) / 10;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower || v == null) continue;
    const text = Array.isArray(v) ? v.join(", ") : v;
    if (text.trim()) return text.trim();
  }
  return null;
}

/**
 * Extract a normalized 3-letter IATA edge metro code from CDN response headers:
 * - Cloudflare `cf-ray`: `8e45ab12cd34ef56-SIN` -> `SIN`
 * - CloudFront `x-amz-cf-pop`: `HEL51-P8` -> `HEL`
 */
export function parseEdgeColo(headers: Record<string, string | string[] | undefined> | null | undefined): string | null {
  if (!headers) return null;
  const cfRay = headerValue(headers, "cf-ray");
  if (cfRay) {
    const m = /-\s*([A-Za-z]{3})\b/.exec(cfRay);
    if (m) return m[1]!.toUpperCase();
  }
  const cfPop = headerValue(headers, "x-amz-cf-pop");
  if (cfPop) {
    const m = /^([A-Za-z]{3})/.exec(cfPop);
    if (m) return m[1]!.toUpperCase();
  }
  return null;
}

/**
 * Parse W3C `Server-Timing` response header(s) into a single server duration in ms.
 * When an overarching metric (`total`, `app`, `request`) is present alongside
 * sub-spans (`db`, `auth`), prefer the overarching one rather than double-counting.
 */
export function parseServerTimingMs(header: string | string[] | null | undefined): number | null {
  if (header == null) return null;
  const text = Array.isArray(header) ? header.join(", ") : header;
  if (!text.trim()) return null;
  const entries: Array<{ name: string; dur: number }> = [];
  for (const rawPart of text.split(",")) {
    const tokens = rawPart.split(";").map((s) => s.trim()).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0]!.toLowerCase();
    for (let i = 1; i < tokens.length; i++) {
      const m = /^dur\s*=\s*"?([0-9]+(?:\.[0-9]+)?)"?$/i.exec(tokens[i]!);
      if (m) {
        const dur = Number(m[1]);
        if (Number.isFinite(dur) && dur >= 0) entries.push({ name, dur });
      }
    }
  }
  if (!entries.length) return null;
  for (const key of ["total", "app", "request"]) {
    const hit = entries.find((e) => e.name === key);
    if (hit) return Math.round(hit.dur * 10) / 10;
  }
  const sum = entries.reduce((acc, e) => acc + e.dur, 0);
  return Math.round(sum * 10) / 10;
}

/**
 * Extract pure TCP handshake 1-RTT (ms) from CDP's `Network.ResourceTiming`.
 * For TCP+TLS (HTTP/1.1, h2), `[sslStart, connectEnd]` is TLS and `[connectStart, sslStart]`
 * is TCP SYN -> SYN-ACK (`sslStart > connectStart`). On HTTP/3 (QUIC), TCP does not exist and
 * Chromium reports `sslStart === connectStart` (which would otherwise read 0 ms and corrupt
 * mixed h2/h3 medians), so QUIC/h3 and `sslStart <= connectStart` return null.
 * Also returns null when the socket was reused (`connectStart < 0`).
 */
export function parseConnectRttMs(
  timing: { connectStart?: number; connectEnd?: number; sslStart?: number } | null | undefined,
  protocol?: string | null,
): number | null {
  if (protocol && /^h3(?:$|[-/])/i.test(protocol.trim())) return null;
  if (!timing || typeof timing.connectStart !== "number" || typeof timing.connectEnd !== "number") return null;
  if (timing.connectStart < 0 || timing.connectEnd <= timing.connectStart) return null;
  if (typeof timing.sslStart === "number" && timing.sslStart >= 0) {
    if (timing.sslStart <= timing.connectStart) return null;
    return Math.round((timing.sslStart - timing.connectStart) * 10) / 10;
  }
  return Math.round((timing.connectEnd - timing.connectStart) * 10) / 10;
}

/** Most frequent non-null string in a list (ties broken alphabetically). */
export function dominantString(values: ReadonlyArray<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (typeof v === "string" && v) counts.set(v, (counts.get(v) ?? 0) + 1);
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/**
 * Deterministic single-core integer work executed inside the browser page.
 * Uses the exact 6M-round FNV-1a loop of `hostHealth.ts` so local and remote
 * Chromium V8 timings live on one scale.
 */
export function inPageBenchmarkEval(samples: number): { browserCpuCount: number | null; browserMemoryGb: number | null; browserBenchmarkMs: number | null } {
  const runOnce = (): number => {
    const started = performance.now();
    let hash = 0x811c9dc5;
    for (let i = 0; i < 6_000_000; i++) hash = Math.imul(hash ^ (i & 0xff), 0x01000193);
    return Math.round((performance.now() - started + (hash === 0 ? 1 : 0)) * 10) / 10;
  };
  runOnce(); // warm V8 JIT before timing
  const runs: number[] = [];
  for (let s = 0; s < samples; s++) runs.push(runOnce());
  runs.sort((a, b) => a - b);
  const mid = Math.floor(runs.length / 2);
  const med = runs.length ? (runs.length % 2 ? runs[mid]! : (runs[mid - 1]! + runs[mid]!) / 2) : null;
  const nav = navigator as Navigator & { deviceMemory?: unknown };
  const cores = typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : null;
  const mem = typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 ? nav.deviceMemory : null;
  return {
    browserCpuCount: cores,
    browserMemoryGb: mem,
    browserBenchmarkMs: med == null ? null : Math.round(med * 10) / 10,
  };
}

/**
 * Probe the target browser's own CPU speed and reported hardware on `about:blank`
 * (unthrottled). Best-effort: never fails a run if a mocked/closed browser cannot open a page.
 */
export async function probeBrowserDevice(browser: Browser, samples = 3): Promise<BrowserDeviceProbe> {
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    return await page.evaluate(inPageBenchmarkEval, samples);
  } catch {
    return { browserCpuCount: null, browserMemoryGb: null, browserBenchmarkMs: null };
  } finally {
    await context?.close().catch(() => {});
  }
}

/**
 * Coarse tier for the human-readable `cohort.key` string; numeric comparability
 * (`compareCohorts`) always checks raw `benchmarkMs` (`>= 1.5x` and `>= 5 ms`).
 * Boundaries (`6`, `14`, `28` ms) sit well clear of typical runner / Browser Run
 * readings (`7.7..11.5 ms`), avoiding key splits from normal +/-1 ms session jitter.
 */
function benchBand(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "?";
  if (ms < 6) return "<6ms";
  if (ms < 14) return "6-14ms";
  if (ms < 28) return "14-28ms";
  return "28ms+";
}

export interface BuildCohortInput {
  browserWhere: BrowserWhere;
  edgeColo?: string | null;
  hostCpuCount: number;
  hostBenchmarkMs: number | null;
  device?: BrowserDeviceProbe | null;
  connectRttSamplesMs?: ReadonlyArray<number | null | undefined>;
  cpuSlowdown?: number;
  addedRttMs?: number;
  net?: string;
  documentIntercepted?: boolean;
  fixture?: string | null;
}

export function buildCohort(input: BuildCohortInput): Cohort {
  const cpuSlowdown = input.cpuSlowdown ?? 1;
  const addedRttMs = input.addedRttMs ?? 0;
  const net = input.net ?? "fast";
  const documentIntercepted = input.documentIntercepted ?? false;
  const edgeColo = input.edgeColo ?? null;
  const fixture = input.fixture ?? null;
  const browserCpuCount = input.device?.browserCpuCount ?? null;
  const browserMemoryGb = input.device?.browserMemoryGb ?? null;
  const browserBenchmarkMs = input.device?.browserBenchmarkMs ?? null;
  const connectRttMs = median((input.connectRttSamplesMs ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
  const effectiveBench = browserBenchmarkMs ?? (input.browserWhere === "local" ? input.hostBenchmarkMs : null);
  const cores = browserCpuCount ?? (input.browserWhere === "local" ? input.hostCpuCount : null);
  const parts = [
    input.browserWhere,
    `colo=${edgeColo ?? "?"}`,
    `cpu=${cores ?? "?"}c/${benchBand(effectiveBench)}`,
    `slow=${cpuSlowdown}x`,
    `rtt=+${addedRttMs}ms`,
    `net=${net}`,
    ...(documentIntercepted ? ["intercept=doc"] : []),
    ...(fixture ? [`fixture=${fixture}`] : []),
  ];
  return {
    key: parts.join("|"),
    browserWhere: input.browserWhere,
    edgeColo,
    hostCpuCount: input.hostCpuCount,
    hostBenchmarkMs: input.hostBenchmarkMs,
    browserCpuCount,
    browserMemoryGb,
    browserBenchmarkMs,
    connectRttMs,
    cpuSlowdown,
    addedRttMs,
    net,
    documentIntercepted,
    fixture,
  };
}

/**
 * Keys written to `perf.page_runs.extra` for a `Cohort`.
 * Numeric fields carry unit suffixes (`_ms`, `_count`, `_bytes`); string/flag identity
 * fields (`browser_where`, `edge_colo`, `fixture_tag`, `document_intercepted`, `cohort_key`)
 * let ScopeDB queries and `claim verify` split or guard series without guessing.
 */
export function cohortExtra(cohort: Cohort): Record<string, number | string | null> {
  return {
    browser_where: cohort.browserWhere,
    edge_colo: cohort.edgeColo,
    fixture_tag: cohort.fixture,
    document_intercepted: cohort.documentIntercepted ? 1 : 0,
    cohort_key: cohort.key,
    browser_cpu_count: cohort.browserCpuCount,
    browser_memory_bytes: cohort.browserMemoryGb == null ? null : Math.round(cohort.browserMemoryGb * 1024 * 1024 * 1024),
    browser_benchmark_ms: cohort.browserBenchmarkMs,
    connect_rtt_ms: cohort.connectRttMs,
    cpu_slowdown_count: cohort.cpuSlowdown,
    added_rtt_ms: cohort.addedRttMs,
  };
}

export function benchmarkStepsApart(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi / lo >= BENCHMARK_STEP_RATIO && hi - lo >= BENCHMARK_STEP_MS;
}

export function connectRttStepsApart(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return false;
  const hi = Math.max(a, b);
  const lo = Math.max(1, Math.min(a, b));
  return hi / lo >= CONNECT_RTT_STEP_RATIO && Math.abs(a - b) >= CONNECT_RTT_STEP_MS;
}

function effectiveBenchmark(c: Partial<Cohort>): number | null {
  if (typeof c.browserBenchmarkMs === "number" && Number.isFinite(c.browserBenchmarkMs)) return c.browserBenchmarkMs;
  if (c.browserWhere !== "browser-run" && typeof c.hostBenchmarkMs === "number" && Number.isFinite(c.hostBenchmarkMs)) return c.hostBenchmarkMs;
  return null;
}

/**
 * Compare a measured cohort against an expected cohort (from a watermark file or
 * baseline rows). Unspecified fields on `expected` are not constrained; constrained
 * fields that are missing (`null`/`undefined`) on `actual` fail comparability
 * instead of silently passing.
 */
export function compareCohorts(expected: CohortExpectation, actual: Partial<Cohort>): CohortComparison {
  const differences: CohortDifference[] = [];
  if (expected.browserWhere !== undefined && expected.browserWhere !== actual.browserWhere) {
    differences.push({
      field: "browserWhere",
      expected: expected.browserWhere,
      actual: actual.browserWhere ?? null,
      reason: `browser ran on ${JSON.stringify(actual.browserWhere ?? null)}, expected "${expected.browserWhere}"`,
    });
  }
  if (expected.fixture !== undefined && (actual.fixture ?? null) !== expected.fixture) {
    differences.push({
      field: "fixture",
      expected: expected.fixture,
      actual: actual.fixture ?? null,
      reason: `fixture is ${JSON.stringify(actual.fixture ?? null)}, expected ${JSON.stringify(expected.fixture)}`,
    });
  }
  if (expected.documentIntercepted !== undefined && (actual.documentIntercepted ?? false) !== expected.documentIntercepted) {
    differences.push({
      field: "documentIntercepted",
      expected: expected.documentIntercepted,
      actual: actual.documentIntercepted ?? false,
      reason: `document interception is ${String(actual.documentIntercepted ?? false)}, expected ${String(expected.documentIntercepted)} (CDP Fetch HTML buffering changed)`,
    });
  }
  if (expected.net !== undefined && expected.net !== actual.net) {
    differences.push({
      field: "net",
      expected: expected.net,
      actual: actual.net ?? null,
      reason: `network preset is ${JSON.stringify(actual.net ?? null)}, expected "${expected.net}"`,
    });
  }
  if (expected.cpuSlowdown !== undefined && expected.cpuSlowdown !== (actual.cpuSlowdown ?? 1)) {
    differences.push({
      field: "cpuSlowdown",
      expected: expected.cpuSlowdown,
      actual: actual.cpuSlowdown ?? 1,
      reason: `CPU slowdown is ${actual.cpuSlowdown ?? 1}x, expected ${expected.cpuSlowdown}x`,
    });
  }
  if (expected.addedRttMs !== undefined && expected.addedRttMs !== (actual.addedRttMs ?? 0)) {
    differences.push({
      field: "addedRttMs",
      expected: expected.addedRttMs,
      actual: actual.addedRttMs ?? 0,
      reason: `added RTT is +${actual.addedRttMs ?? 0} ms, expected +${expected.addedRttMs} ms`,
    });
  }
  if (expected.edgeColo !== undefined) {
    if (actual.edgeColo == null) {
      differences.push({
        field: "edgeColo",
        expected: expected.edgeColo.toUpperCase(),
        actual: null,
        reason: `edge PoP is missing, expected ${expected.edgeColo.toUpperCase()}`,
      });
    } else if (expected.edgeColo.toUpperCase() !== actual.edgeColo.toUpperCase()) {
      differences.push({
        field: "edgeColo",
        expected: expected.edgeColo.toUpperCase(),
        actual: actual.edgeColo,
        reason: `edge PoP is ${actual.edgeColo}, expected ${expected.edgeColo.toUpperCase()}`,
      });
    }
  }
  const actualBench = effectiveBenchmark(actual);
  if (expected.benchmarkMs !== undefined) {
    if (actualBench == null) {
      differences.push({
        field: "benchmarkMs",
        expected: expected.benchmarkMs,
        actual: null,
        reason: `CPU benchmark is missing on the measured cohort, expected ~${expected.benchmarkMs} ms`,
      });
    } else if (benchmarkStepsApart(expected.benchmarkMs, actualBench)) {
      differences.push({
        field: "benchmarkMs",
        expected: expected.benchmarkMs,
        actual: actualBench,
        reason: `CPU benchmark stepped from ${expected.benchmarkMs} ms to ${actualBench} ms (>= ${BENCHMARK_STEP_RATIO}x and >= ${BENCHMARK_STEP_MS} ms: different machine)`,
      });
    }
  }
  if (expected.connectRttMs !== undefined && actual.connectRttMs != null && connectRttStepsApart(expected.connectRttMs, actual.connectRttMs)) {
    differences.push({
      field: "connectRttMs",
      expected: expected.connectRttMs,
      actual: actual.connectRttMs,
      reason: `connection RTT stepped from ${expected.connectRttMs} ms to ${actual.connectRttMs} ms (>= ${CONNECT_RTT_STEP_RATIO}x and >= ${CONNECT_RTT_STEP_MS} ms: different network path)`,
    });
  }
  return { comparable: differences.length === 0, differences };
}

/**
 * Reconstruct a `Cohort` summary from a set of `perf.page_runs` JSONL rows (`claim`).
 * Rows written before 0.26.0 had no `browser_where` or `document_intercepted`:
 * - Because `--jsonl` was refused on `browser-run` prior to 0.26.0, legacy rows with
 *   host or metric fields are inferred as `browserWhere: "local"`.
 * - Because `measure` (`content_ms` in `extra`) buffered Document HTML via `Fetch.enable`
 *   even on `--ab none` prior to 0.26.0, legacy `measure` rows without `document_intercepted`
 *   are inferred as `documentIntercepted: true`, preventing a 0.25 -> 0.26 tool upgrade
 *   from verifying a claim on the removed CDP round-trips.
 */
export function cohortFromRows(rows: ReadonlyArray<Record<string, unknown>>): { expectation: CohortExpectation; actual: Partial<Cohort>; hasCohort: boolean } {
  const extras = rows.map((r) => (r.extra && typeof r.extra === "object" && !Array.isArray(r.extra) ? (r.extra as Record<string, unknown>) : {}));
  const str = (vals: unknown[]): string | undefined => {
    const found = vals.filter((v): v is string => typeof v === "string" && v.length > 0);
    return found.length ? found[0] : undefined;
  };
  const numMed = (vals: unknown[]): number | null => median(vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v)));
  const explicitWhere = str(extras.map((e) => e.browser_where)) as BrowserWhere | undefined;
  const browserBench = numMed(extras.map((e) => e.browser_benchmark_ms));
  const hostBench = numMed(extras.map((e) => e.host_benchmark_ms));
  const hasLegacyLocalRow =
    explicitWhere === undefined &&
    rows.length > 0 &&
    (hostBench !== null || extras.some((e) => "host_cpu_count" in e || "content_ms" in e || "ready_ms" in e || "channel_switch_ms" in e));
  const browserWhere: BrowserWhere | undefined = explicitWhere ?? (hasLegacyLocalRow ? "local" : undefined);

  const hasDocInterceptKey = extras.some((e) => "document_intercepted" in e);
  const isLegacyMeasureRow = !hasDocInterceptKey && extras.some((e) => "content_ms" in e) && rows.some((r) => r.state === "cold" || r.state === "release" || r.state === "repeat");
  const documentIntercepted: boolean | undefined = hasDocInterceptKey
    ? extras.some((e) => e.document_intercepted === 1 || e.document_intercepted === true)
    : isLegacyMeasureRow
      ? true
      : undefined;

  const hasFixtureKey = extras.some((e) => "fixture_tag" in e);
  const fixture = str(extras.map((e) => e.fixture_tag)) ?? null;
  const edgeColo = dominantString(extras.map((e) => (typeof e.edge_colo === "string" ? e.edge_colo : null)));
  const connectRtt = numMed(extras.map((e) => e.connect_rtt_ms));
  const cpuSlowdown = numMed(extras.map((e) => e.cpu_slowdown_count));
  const addedRttMs = numMed(extras.map((e) => e.added_rtt_ms));
  const net = str(rows.map((r) => r.net));
  const bench = browserBench ?? (browserWhere !== "browser-run" ? hostBench : null);
  const hasCohort = browserWhere !== undefined || hasFixtureKey || documentIntercepted !== undefined || browserBench !== null || hostBench !== null;
  return {
    hasCohort,
    expectation: {
      ...(browserWhere !== undefined ? { browserWhere } : {}),
      ...(hasFixtureKey ? { fixture } : {}),
      ...(documentIntercepted !== undefined ? { documentIntercepted } : {}),
      ...(net !== undefined ? { net } : {}),
      ...(cpuSlowdown !== null ? { cpuSlowdown } : {}),
      ...(addedRttMs !== null ? { addedRttMs } : {}),
      ...(bench !== null ? { benchmarkMs: bench } : {}),
      ...(connectRtt !== null ? { connectRttMs: connectRtt } : {}),
    },
    actual: {
      ...(browserWhere !== undefined ? { browserWhere } : {}),
      ...(hasFixtureKey ? { fixture } : {}),
      ...(documentIntercepted !== undefined ? { documentIntercepted } : {}),
      ...(edgeColo !== null ? { edgeColo } : {}),
      ...(net !== undefined ? { net } : {}),
      ...(cpuSlowdown !== null ? { cpuSlowdown } : {}),
      ...(addedRttMs !== null ? { addedRttMs } : {}),
      browserBenchmarkMs: browserBench,
      hostBenchmarkMs: hostBench,
      connectRttMs: connectRtt,
    },
  };
}
