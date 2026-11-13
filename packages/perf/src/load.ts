#!/usr/bin/env node
/**
 * raft-perf load: how long a page of any product takes until its own content
 * is on screen, and what that time is made of. Driven by a project config
 * (src/project.ts); nothing here names a product.
 *
 *   pnpm --filter @botiverse/raft-perf load -- --project projects/raft-design.json --env production
 *
 * Per load it records the Web Vitals (Chrome's web-vitals library; nothing is
 * intercepted, so TTFB is real on the fast network), `ready_ms` (the page's `ready`
 * element painted: the frame after it is found visible, and never before FCP),
 * bytes and requests before ready, and main-thread long tasks before ready.
 * Exit codes: 0 measured, 2 the measurement failed or a page never became ready.
 * docs/frontend/perf-measure.md, "Any product: project configs and `load`".
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { cliArgs } from "./args";
import type { PageRunRow } from "./pageRuns";
import { type TimeLedger, timeLedger } from "./ledger";
import { parseProjectConfig, selectRun } from "./project";
import { vitalsInitScript } from "./vitals";

const HELP = `raft-perf load — time to a page's own content, for any product

Options:
  --project <file>    project config JSON (required), e.g. projects/raft-design.json
  --env <name>        which environment of the config (required)
  --page <name>       one page of the config (default: all)
  --state <s>         cold | repeat (default cold)
                        cold    a new browser context per load: no cache, no local data
                        repeat  the second load in one context: HTTP cache and local data kept
  --net <n>           fast | slow (slow: 150 ms RTT, 200 KB/s down, 4x CPU)
  --runs <n>          loads per page (default 5)
  --out <file>        also write the JSON here
  --jsonl <file>      also write one row per load (ScopeDB perf.page_runs)
  --run-id <id>       with --jsonl: shared by every row of one collection (default: a new UUID)
  --chromium-arg <a>  extra Chromium switch (repeatable)
`;

class LoadError extends Error {}
const fail = (message: string): never => {
  throw new LoadError(message);
};

/** One load. Times are ms from navigation start; null when the page did not report it. */
export interface LoadResult {
  readyMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  /** Compressed bytes that finished downloading before ready, by kind. */
  jsBytes: number | null;
  cssBytes: number | null;
  totalBytes: number | null;
  requests: number | null;
  /** Main-thread long tasks that started before ready, ms. */
  longtaskMs: number | null;
  /** Where the time to ready went (src/ledger.ts); null when the load never became ready. */
  ledger: TimeLedger | null;
  /** Compressed bytes and requests of the whole load (to the end of the settle wait), whatever ready cut off. */
  loadTotalBytes: number;
  loadRequests: number;
  commitSha: string | null;
}

const median = (values: (number | null)[]): number | null => {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return Math.round((v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2) * 100) / 100;
};

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      project: { type: "string" },
      env: { type: "string" },
      page: { type: "string" },
      state: { type: "string", default: "cold" },
      net: { type: "string", default: "fast" },
      runs: { type: "string", default: "5" },
      out: { type: "string" },
      jsonl: { type: "string" },
      "run-id": { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  });
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.project) fail("--project <file> is required");
  if (!args.env) fail("--env <name> is required");
  const state = args.state as "cold" | "repeat";
  const net = args.net as "fast" | "slow";
  const runs = Number(args.runs);
  if (!["cold", "repeat"].includes(state)) fail(`--state must be cold or repeat, not ${state}`);
  if (!["fast", "slow"].includes(net)) fail(`--net must be fast or slow, not ${net}`);
  if (!Number.isInteger(runs) || runs < 1) fail("--runs must be an integer of at least 1");
  let config;
  try {
    config = parseProjectConfig(JSON.parse(readFileSync(args.project!, "utf8")), args.project);
  } catch (error) {
    return fail((error as Error).message);
  }
  let selected;
  try {
    selected = selectRun(config, args.env!, args.page);
  } catch (error) {
    return fail((error as Error).message);
  }
  const { env, pages } = selected;

  const hook = `;(() => {
    const v = (window.__perfVitals = {});
    const keep = (name) => (m) => { v[name] = m.value; };
    const all = { reportAllChanges: true };
    webVitals.onLCP(keep("lcp"), all); webVitals.onCLS(keep("cls"), all); webVitals.onFCP(keep("fcp"), all); webVitals.onTTFB(keep("ttfb"), all);
    window.__perfLongTasks = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perfLongTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: "longtask", buffered: true });
  })();`;
  let vitalsScript: string;
  try {
    vitalsScript = vitalsInitScript(hook);
  } catch (error) {
    return fail(`cannot load web-vitals' browser build: ${(error as Error).message}`);
  }
  // Finds the page's ready element visible (and holding text, when asked), then stamps the NEXT frame: the one in
  // which it has been painted, not the one in which it was found. An invalid selector is reported, not waited on.
  const watchReady = ({ selector, hasText }: { selector: string; hasText: boolean }) => {
    const w = window as unknown as { __perfReadyAt: number | null; __perfReadyError: string | null };
    w.__perfReadyAt = null;
    w.__perfReadyError = null;
    const tick = () => {
      let el: Element | null;
      try {
        el = document.querySelector(selector);
      } catch (error) {
        w.__perfReadyError = String((error as Error).message ?? error);
        return;
      }
      if (el) {
        const box = el.getBoundingClientRect();
        if (box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden" && (!hasText || (el.textContent ?? "").trim().length > 0)) {
          requestAnimationFrame((t) => (w.__perfReadyAt = t));
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const browser = await chromium.launch({ args: args["chromium-arg"] });
  const results: Record<string, LoadResult[]> = {};
  const warnings: string[] = [];
  try {
    for (const page of pages) {
      results[page.name] = [];
      const url = env.origin + page.path;
      for (let i = 0; i < runs; i++) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
        try {
          const loadOnce = async (): Promise<LoadResult> => {
            const tab = await context.newPage();
            try {
              await tab.addInitScript({ content: vitalsScript });
              await tab.addInitScript(watchReady, { selector: page.ready.selector, hasText: page.ready.hasText !== false });
              const cdp = await context.newCDPSession(tab);
              await cdp.send("Network.enable");
              if (net === "slow") {
                await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 94_000 });
                await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
              }
              const kinds = new Map<string, string>();
              const finished: { kind: string; bytes: number; at: number }[] = [];
              // per request, on CDP's clock (seconds): sent, first response byte, finished
              const timeline = new Map<string, { start: number; response: number | null; lastData: number | null; end: number | null }>();
              let navStart: number | null = null;
              cdp.on("Network.requestWillBeSent", (e) => {
                kinds.set(e.requestId, e.type ?? "Other");
                if (navStart == null && e.type === "Document") navStart = e.timestamp;
              });
              cdp.on("Network.requestWillBeSent", (e) => {
                if (!timeline.has(e.requestId)) timeline.set(e.requestId, { start: e.timestamp, response: null, lastData: null, end: null });
              });
              cdp.on("Network.responseReceived", (e) => {
                const t = timeline.get(e.requestId);
                if (t && t.response == null) t.response = e.timestamp;
              });
              cdp.on("Network.dataReceived", (e) => {
                const t = timeline.get(e.requestId);
                if (t) t.lastData = e.timestamp;
              });
              cdp.on("Network.loadingFailed", (e) => {
                const t = timeline.get(e.requestId);
                if (t) t.end = e.timestamp;
              });
              cdp.on("Network.loadingFinished", (e) => {
                finished.push({ kind: kinds.get(e.requestId) ?? "Other", bytes: e.encodedDataLength, at: e.timestamp });
                const t = timeline.get(e.requestId);
                if (t) t.end = e.timestamp;
              });
              await tab.goto(url, { waitUntil: "load", timeout: 120_000 });
              await tab
                .waitForFunction(() => {
                  const w = window as unknown as { __perfReadyAt: number | null; __perfReadyError: string | null };
                  return w.__perfReadyAt != null || w.__perfReadyError != null;
                }, null, { timeout: 60_000 })
                .catch(() => null);
              const selectorError = await tab.evaluate(() => (window as unknown as { __perfReadyError: string | null }).__perfReadyError);
              if (selectorError) fail(`page "${page.name}": ready.selector ${JSON.stringify(page.ready.selector)} is not a valid CSS selector (${selectorError})`);
              await tab.waitForTimeout(net === "slow" ? 4000 : 2000);
              const read = await tab.evaluate(() => {
                const w = window as unknown as { __perfReadyAt: number | null; __perfVitals?: Record<string, number>; __perfLongTasks?: { start: number; duration: number }[] };
                let commit: string | null = null;
                try {
                  commit = JSON.parse(document.getElementById("raft-frontend-release-identity")?.textContent ?? "{}").commitSha ?? null;
                } catch {
                  /* a page without a release identity */
                }
                // content is not on screen before the first contentful paint: on server-rendered HTML the element exists earlier
                const fcp = (w.__perfVitals ?? {}).fcp;
                const ready = w.__perfReadyAt == null ? null : Math.max(w.__perfReadyAt, fcp ?? 0);
                return { ready, vitals: w.__perfVitals ?? {}, longTasks: w.__perfLongTasks ?? [], longtaskMs: (w.__perfLongTasks ?? []).filter((t) => ready == null || t.start < ready).reduce((a, t) => a + t.duration, 0), commit };
              });
              // requests that finished before ready (CDP timestamps are seconds on the same clock as the navigation's)
              const ms = (x: number | null | undefined) => (x == null ? null : Math.round(x));
              const vitalsOnly = { ttfbMs: net === "slow" ? null : ms(read.vitals.ttfb), fcpMs: ms(read.vitals.fcp), lcpMs: ms(read.vitals.lcp), cls: read.vitals.cls == null ? null : Math.round(read.vitals.cls * 10000) / 10000, commitSha: read.commit };
              // never ready: there is no "before ready", so those fields stay empty instead of holding the whole load
              const whole = { loadTotalBytes: finished.reduce((a, f) => a + f.bytes, 0), loadRequests: finished.length };
              if (read.ready == null) return { readyMs: null, ...vitalsOnly, jsBytes: null, cssBytes: null, totalBytes: null, requests: null, longtaskMs: null, ledger: null, ...whole };
              const before = finished.filter((f) => navStart == null || (f.at - navStart) * 1000 <= read.ready!);
              const sum = (kind?: string) => before.filter((f) => !kind || f.kind === kind).reduce((a, f) => a + f.bytes, 0);
              // The ledger: CDP times are seconds from the same origin as navStart; long tasks are ms from the page's time origin,
              // which is the navigation start (a few ms before the first request). A request with no finish event (an event
              // stream, a long poll) is downloading only up to its last received data, not until ready; one that never got a
              // response is waiting until ready.
              const rel = (t: number) => (t - (navStart ?? t)) * 1000;
              const ledger = timeLedger(
                read.ready,
                [...timeline.values()].map((t) => ({ startMs: rel(t.start), responseMs: t.response == null ? null : rel(t.response), endMs: t.end != null ? rel(t.end) : t.response == null ? read.ready! : rel(t.lastData ?? t.response) })),
                read.longTasks.map((t) => ({ startMs: t.start, durationMs: t.duration })),
              );
              return { readyMs: ms(read.ready), ttfbMs: vitalsOnly.ttfbMs, fcpMs: ms(read.vitals.fcp), lcpMs: ms(read.vitals.lcp), cls: read.vitals.cls == null ? null : Math.round(read.vitals.cls * 10000) / 10000, jsBytes: sum("Script"), cssBytes: sum("Stylesheet"), totalBytes: sum(), requests: before.length, longtaskMs: Math.round(read.longtaskMs), commitSha: read.commit, ledger, ...whole };
            } finally {
              await tab.close().catch(() => {});
            }
          };
          if (state === "repeat") await loadOnce(); // the warm-up visit, not recorded
          results[page.name].push(await loadOnce());
        } finally {
          await context.close();
        }
      }
      if (results[page.name].every((r) => r.lcpMs == null)) warnings.push(`page "${page.name}": no load reported LCP (the web-vitals script did not run)`);
      if (results[page.name].some((r) => r.readyMs == null)) warnings.push(`page "${page.name}": its ready element (${page.ready.selector}) never became visible in a load`);
    }
  } finally {
    await browser.close();
  }

  const measuredAt = new Date().toISOString();
  const summary = Object.fromEntries(
    Object.entries(results).map(([name, loads]) => [
      name,
      {
        ready_ms: median(loads.map((r) => r.readyMs)),
        ttfb_ms: median(loads.map((r) => r.ttfbMs)),
        fcp_ms: median(loads.map((r) => r.fcpMs)),
        lcp_ms: median(loads.map((r) => r.lcpMs)),
        cls: median(loads.map((r) => r.cls)),
        js_bytes: median(loads.map((r) => r.jsBytes)),
        css_bytes: median(loads.map((r) => r.cssBytes)),
        total_bytes: median(loads.map((r) => r.totalBytes)),
        request_count: ((m) => (m == null ? null : Math.round(m)))(median(loads.map((r) => r.requests))),
        longtask_ms: median(loads.map((r) => r.longtaskMs)),
        ledger_main_thread_ms: median(loads.map((r) => r.ledger?.mainThreadMs ?? null)),
        ledger_download_ms: median(loads.map((r) => r.ledger?.downloadMs ?? null)),
        ledger_network_wait_ms: median(loads.map((r) => r.ledger?.networkWaitMs ?? null)),
        ledger_unexplained_ms: median(loads.map((r) => r.ledger?.unexplainedMs ?? null)),
        load_total_bytes: median(loads.map((r) => r.loadTotalBytes)),
        load_request_count: ((m) => (m == null ? null : Math.round(m)))(median(loads.map((r) => r.loadRequests))),
      },
    ]),
  );
  // the command that reproduces this measurement, for advise's "verify" step
  const command = `pnpm --filter @botiverse/raft-perf load -- ${cliArgs().filter((x, i, all) => !["--out", "--jsonl", "--run-id"].includes(x) && !["--out", "--jsonl", "--run-id"].includes(all[i - 1] ?? "")).map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replaceAll("'", "'\\''")}'`)).join(" ")}`;
  const report = { tool: "raft-perf load", command, measuredAt, project: config.project, env: args.env, origin: env.origin, state, net, requestedRuns: runs, pages: summary, warnings, runs: results };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  if (args.jsonl) {
    const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const runId = args["run-id"] ?? randomUUID();
    const rows: PageRunRow[] = Object.entries(results).flatMap(([name, loads]) =>
      loads.map((r, i) => ({
        project: config.project,
        env: args.env!,
        run_id: runId,
        tool_version: toolVersion,
        taken_at: measuredAt,
        origin: env.origin,
        commit_sha: r.commitSha,
        page: name,
        state,
        net,
        ab: "none",
        arm: "on" as const,
        run_idx: i,
        lcp_ms: r.lcpMs,
        inp_ms: null,
        cls: r.cls,
        ttfb_ms: r.ttfbMs,
        fcp_ms: r.fcpMs,
        verdict: r.readyMs == null ? "unknown" : "measured",
        extra: { ready_ms: r.readyMs, js_bytes: r.jsBytes, css_bytes: r.cssBytes, total_bytes: r.totalBytes, request_count: r.requests, longtask_ms: r.longtaskMs, ledger_main_thread_ms: r.ledger?.mainThreadMs ?? null, ledger_download_ms: r.ledger?.downloadMs ?? null, ledger_network_wait_ms: r.ledger?.networkWaitMs ?? null, ledger_unexplained_ms: r.ledger?.unexplainedMs ?? null, load_total_bytes: r.loadTotalBytes, load_request_count: r.loadRequests },
      })),
    );
    writeFileSync(args.jsonl, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  for (const [name, s] of Object.entries(summary)) process.stderr.write(`raft-perf load ${config.project}/${args.env}/${name} ${state}/${net}: ready ${s.ready_ms} ms (ttfb ${s.ttfb_ms}, fcp ${s.fcp_ms}, lcp ${s.lcp_ms}), ${s.request_count} requests, ${Math.round((s.total_bytes ?? 0) / 1024)} KB before ready; time: main thread ${s.ledger_main_thread_ms}, download ${s.ledger_download_ms}, network wait ${s.ledger_network_wait_ms}, unexplained ${s.ledger_unexplained_ms} ms\n`);
  if (warnings.length) process.stderr.write(warnings.map((w) => `warning: ${w}\n`).join(""));
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf load: ${error instanceof LoadError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
