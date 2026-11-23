#!/usr/bin/env node
/**
 * raft-perf load: how long a page of any product takes until its own content
 * is on screen, and what that time is made of. Driven by a ProjectSpec v2 config
 * (`src/project.ts`, e.g. `projects/raft-design.json` or `projects/stamp.json`);
 * nothing here names a product (#proj-frontend:#74).
 *
 *   npx raft-perf load --project stamp --env staging
 *   npx raft-perf load --project projects/raft-design.json --env production
 *
 * Supports both public pages and signed-in pages (cookies or Playwright storageState
 * resolved from environment variables, never stored in configs or reports), optional
 * `shell` + `ready` milestones (`shell_ms`, `ready_ms`, `shell_to_ready_ms`), script
 * waterfall request counts (`script_request_count`), and `/api/*` request summaries.
 *
 * Exit codes: 0 measured, 2 the measurement failed or a page never became ready.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import { redactedApiRouteShape } from "./apiReplay";
import { cliArgs } from "./args";
import { BrowserError, openBrowser, planBrowser } from "./browser";
import {
  type BrowserDeviceProbe,
  buildCohort,
  cohortExtra,
  dominantString,
  parseConnectRttMs,
  parseEdgeColo,
  parseServerTimingMs,
  probeBrowserDevice,
} from "./cohort";
import { hostBenchmarkMedian, hostExtra } from "./hostHealth";
import { type TimeLedger, timeLedger } from "./ledger";
import type { PageRunRow } from "./pageRuns";
import {
  type ResolvedProjectAuth,
  detectAuthRedirect,
  loadProjectConfig,
  resolveProjectAuth,
  scrubAuthSecrets,
  selectRun,
} from "./project";
import { vitalsInitScript } from "./vitals";

const HELP = `raft-perf load — time to a page's own content, for any product (public or signed-in)

Options:
  --project <name|file>   built-in project name (e.g. stamp, raft-design) or config JSON path (required)
  --env <name>            which environment of the config (required)
  --page <name>           one page of the config (default: all)
  --state <s>             cold | repeat (default cold)
                            cold    a new browser context per load: no cache, no local data
                            repeat  the second load in one context: HTTP cache and local data kept
  --net <n>               fast | slow (slow: 150 ms RTT, 200 KB/s down, 4x CPU)
  --runs <n>              loads per page (default 5)
  --storage-state <file>  Playwright storageState JSON file for signed-in pages (overrides project auth env)
  --unauthenticated       skip project auth even when configured (measures logged-out behavior)
  --out <file>            also write the JSON here
  --jsonl <file>          also write one row per load (ScopeDB perf.page_runs)
  --run-id <id>           with --jsonl: shared by every row of one collection (default: a new UUID)
  --chromium-arg <a>      extra Chromium switch (repeatable)
  --browser <where>       local | browser-run (default local)
`;

class LoadError extends Error {}
const fail = (message: string): never => {
  throw new LoadError(message);
};

export interface LoadApiRequestSample {
  route: string;
  status: number | null;
  startMs: number;
  ttfbMs: number | null;
  endMs: number | null;
  bytes: number;
  fromCache: boolean;
  serverTimingMs: number | null;
}

export interface LoadApiRouteSummary {
  route: string;
  count: number;
  start_ms: number | null;
  ttfb_ms: number | null;
  end_ms: number | null;
  bytes: number | null;
  server_timing_ms: number | null;
}

/** One load. Times are ms from navigation start; null when the page did not report it. */
export interface LoadResult {
  shellMs: number | null;
  readyMs: number | null;
  shellToReadyMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  /** Compressed bytes that finished downloading before ready, by kind. */
  jsBytes: number | null;
  cssBytes: number | null;
  totalBytes: number | null;
  requests: number | null;
  /** Non-cached network Script requests that finished before ready. */
  scriptRequests: number | null;
  /** Main-thread long tasks that started before ready, ms. */
  longtaskMs: number | null;
  /** Where the time to ready went (src/ledger.ts); null when the load never became ready. */
  ledger: TimeLedger | null;
  /** Compressed bytes, total requests, and network script count of the whole load. */
  loadTotalBytes: number;
  loadRequests: number;
  loadScriptRequests: number;
  apiRequests: LoadApiRequestSample[];
  finalPath: string | null;
  redirectedToAuth: boolean;
  serverTimingMs: number | null;
  releaseTag: string | null;
  commitSha: string | null;
}

const median = (values: (number | null)[]): number | null => {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return Math.round((v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2) * 100) / 100;
};

let activeSecretsToScrub: string[] = [];

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
      "storage-state": { type: "string" },
      unauthenticated: { type: "boolean", default: false },
      out: { type: "string" },
      jsonl: { type: "string" },
      "run-id": { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
      browser: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const plan = planBrowser(args.browser, args["chromium-arg"], process.env);
  const projectArg = args.project ?? fail("--project <name|file> is required");
  const envArg = args.env ?? fail("--env <name> is required");
  const state = args.state as "cold" | "repeat";
  const net = args.net as "fast" | "slow";
  const runs = Number(args.runs);
  if (!["cold", "repeat"].includes(state)) fail(`--state must be cold or repeat, not ${state}`);
  if (!["fast", "slow"].includes(net)) fail(`--net must be fast or slow, not ${net}`);
  if (!Number.isInteger(runs) || runs < 1) fail("--runs must be an integer of at least 1");

  let config;
  try {
    config = loadProjectConfig(projectArg);
  } catch (error) {
    return fail((error as Error).message);
  }
  let selected;
  try {
    selected = selectRun(config, envArg, args.page);
  } catch (error) {
    return fail((error as Error).message);
  }
  const { env, pages } = selected;
  const anyPageNeedsAuth = pages.some((p) => p.auth !== false);
  let resolvedAuth: ResolvedProjectAuth;
  try {
    resolvedAuth = resolveProjectAuth(config, envArg, process.env, {
      storageStateFile: args["storage-state"],
      unauthenticated: args.unauthenticated || !anyPageNeedsAuth,
    });
  } catch (error) {
    return fail((error as Error).message);
  }
  activeSecretsToScrub = resolvedAuth.secretsToScrub;
  const targetOriginHost = new URL(env.origin).host;

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

  // Finds the page's optional `shell` and required `ready` elements visible, stamping the NEXT frame (the painted one).
  const watchMilestones = (spec: {
    shell: { selector: string; hasText: boolean } | null;
    ready: { selector: string; hasText: boolean };
  }) => {
    const w = window as unknown as {
      __perfShellAt: number | null;
      __perfReadyAt: number | null;
      __perfSelectorError: { which: "shell" | "ready"; message: string } | null;
    };
    w.__perfShellAt = null;
    w.__perfReadyAt = null;
    w.__perfSelectorError = null;
    let shellPending = false;
    let readyPending = false;

    const isVisible = (selector: string, hasText: boolean, which: "shell" | "ready"): boolean => {
      let el: Element | null;
      try {
        el = document.querySelector(selector);
      } catch (error) {
        w.__perfSelectorError = { which, message: String((error as Error).message ?? error) };
        return false;
      }
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        getComputedStyle(el).visibility !== "hidden" &&
        (!hasText || (el.textContent ?? "").trim().length > 0)
      );
    };

    const tick = () => {
      if (w.__perfSelectorError) return;
      if (spec.shell && w.__perfShellAt == null && !shellPending) {
        if (isVisible(spec.shell.selector, spec.shell.hasText, "shell")) {
          shellPending = true;
          requestAnimationFrame((t) => {
            w.__perfShellAt = t;
          });
        }
      }
      if (w.__perfSelectorError) return;
      if (w.__perfReadyAt == null && !readyPending) {
        if (isVisible(spec.ready.selector, spec.ready.hasText, "ready")) {
          readyPending = true;
          requestAnimationFrame((t) => {
            w.__perfReadyAt = t;
          });
        }
      }
      if ((spec.shell && !shellPending && w.__perfShellAt == null) || (!readyPending && w.__perfReadyAt == null)) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  };

  const opened = await openBrowser(plan);
  const { browser, describe: browserSeen } = opened;
  const results: Record<string, LoadResult[]> = {};
  const warnings: string[] = [];
  const edgeColos: string[] = [];
  const connectRtts: number[] = [];
  let deviceProbe: BrowserDeviceProbe | null = null;
  try {
    deviceProbe = await probeBrowserDevice(browser);
    for (const page of pages) {
      results[page.name] = [];
      const url = env.origin + page.path;
      const pageUsesAuth = resolvedAuth.authenticated && page.auth !== false;
      for (let i = 0; i < runs; i++) {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          serviceWorkers: "block",
          ...(pageUsesAuth && resolvedAuth.storageStatePath ? { storageState: resolvedAuth.storageStatePath } : {}),
        });
        if (pageUsesAuth && resolvedAuth.cookies.length > 0) {
          await context.addCookies(resolvedAuth.cookies);
        }
        try {
          const loadOnce = async (): Promise<LoadResult> => {
            const tab = await context.newPage();
            try {
              await tab.addInitScript({ content: vitalsScript });
              await tab.addInitScript(watchMilestones, {
                shell: page.shell ? { selector: page.shell.selector, hasText: page.shell.hasText !== false } : null,
                ready: { selector: page.ready.selector, hasText: page.ready.hasText !== false },
              });
              const cdp = await context.newCDPSession(tab);
              await cdp.send("Network.enable");
              if (net === "slow") {
                await cdp.send("Network.emulateNetworkConditions", {
                  offline: false,
                  latency: 150,
                  downloadThroughput: 200_000,
                  uploadThroughput: 94_000,
                });
                await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
              }
              interface TrackedReq {
                url: string;
                kind: string;
                start: number;
                response: number | null;
                lastData: number | null;
                end: number | null;
                status: number | null;
                fromCache: boolean;
                bytes: number;
                serverTimingMs: number | null;
              }
              const reqs = new Map<string, TrackedReq>();
              const finished: { kind: string; bytes: number; at: number; fromCache: boolean }[] = [];
              let navStart: number | null = null;
              let docServerTimingMs: number | null = null;
              let headerRelease: string | null = null;
              let resolveApiAuthWall: (() => void) | null = null;
              const apiAuthWallDetected = new Promise<void>((res) => {
                resolveApiAuthWall = res;
              });

              cdp.on("Network.requestWillBeSent", (e) => {
                if (navStart == null && e.type === "Document") navStart = e.timestamp;
                if (!reqs.has(e.requestId)) {
                  reqs.set(e.requestId, {
                    url: e.request.url,
                    kind: e.type ?? "Other",
                    start: e.timestamp,
                    response: null,
                    lastData: null,
                    end: null,
                    status: null,
                    fromCache: false,
                    bytes: 0,
                    serverTimingMs: null,
                  });
                }
              });
              cdp.on("Network.responseReceived", (e) => {
                const t = reqs.get(e.requestId);
                if (t) {
                  if (t.response == null) t.response = e.timestamp;
                  t.status = e.response.status;
                  t.fromCache = Boolean(e.response.fromDiskCache || e.response.fromPrefetchCache);
                  t.serverTimingMs = parseServerTimingMs(e.response.headers["server-timing"] ?? e.response.headers["Server-Timing"]);
                  if (pageUsesAuth) {
                    try {
                      const u = new URL(t.url);
                      if (
                        u.pathname.startsWith("/api/") &&
                        (e.response.status === 401 || /^\/api\/([^/]+\/)?(sign-in|signin|login)(\/|$)/i.test(u.pathname))
                      ) {
                        resolveApiAuthWall?.();
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                }
                if (e.type === "Document") {
                  const colo = parseEdgeColo(e.response.headers);
                  if (colo) edgeColos.push(colo);
                  const rtt = parseConnectRttMs(e.response.timing, e.response.protocol);
                  if (rtt != null) connectRtts.push(rtt);
                  docServerTimingMs ??= parseServerTimingMs(e.response.headers["server-timing"] ?? e.response.headers["Server-Timing"]);
                  const sr = e.response.headers["stamp-release"] ?? e.response.headers["Stamp-Release"];
                  if (!headerRelease && typeof sr === "string" && sr.trim()) headerRelease = sr.trim();
                }
              });
              cdp.on("Network.dataReceived", (e) => {
                const t = reqs.get(e.requestId);
                if (t) t.lastData = e.timestamp;
              });
              cdp.on("Network.loadingFailed", (e) => {
                const t = reqs.get(e.requestId);
                if (t) t.end = e.timestamp;
              });
              cdp.on("Network.loadingFinished", (e) => {
                const t = reqs.get(e.requestId);
                if (t) {
                  t.end = e.timestamp;
                  t.bytes = e.encodedDataLength;
                }
                finished.push({
                  kind: t?.kind ?? "Other",
                  bytes: e.encodedDataLength,
                  at: e.timestamp,
                  fromCache: t?.fromCache ?? false,
                });
              });

              await tab.goto(url, { waitUntil: "load", timeout: 120_000 });
              const earlyApiSnapshot = [...reqs.values()]
                .filter((r) => {
                  try {
                    return new URL(r.url).pathname.startsWith("/api/");
                  } catch {
                    return false;
                  }
                })
                .map((r) => ({ route: redactedApiRouteShape(r.url), status: r.status }));
              const earlyRedirect = detectAuthRedirect(pageUsesAuth, targetOriginHost, page.path, tab.url(), earlyApiSnapshot);

              if (!earlyRedirect.redirectedToAuth) {
                await Promise.race([
                  apiAuthWallDetected,
                  tab
                    .waitForFunction(
                      (expectedPath: string) => {
                        const w = window as unknown as {
                          __perfReadyAt: number | null;
                          __perfSelectorError: { which: string; message: string } | null;
                        };
                        const p = window.location.pathname;
                        const clientAuthRedirect = p !== expectedPath && /^\/(login|signin|sign-in|auth)(\/|$)/i.test(p);
                        return w.__perfReadyAt != null || w.__perfSelectorError != null || clientAuthRedirect;
                      },
                      page.path,
                      { timeout: 60_000 },
                    )
                    .catch(() => null),
                ]);
              }
              const selectorError = await tab.evaluate(
                () => (window as unknown as { __perfSelectorError: { which: "shell" | "ready"; message: string } | null }).__perfSelectorError,
              );
              if (selectorError) {
                const badSel = selectorError.which === "shell" ? page.shell?.selector : page.ready.selector;
                fail(
                  `page "${page.name}": ${selectorError.which}.selector ${JSON.stringify(badSel)} is not a valid CSS selector (${selectorError.message})`,
                );
              }
              await tab.waitForTimeout(net === "slow" ? 4000 : 2000);

              const read = await tab.evaluate(() => {
                const w = window as unknown as {
                  __perfShellAt: number | null;
                  __perfReadyAt: number | null;
                  __perfVitals?: Record<string, number>;
                  __perfLongTasks?: { start: number; duration: number }[];
                };
                let commit: string | null = null;
                try {
                  commit = JSON.parse(document.getElementById("raft-frontend-release-identity")?.textContent ?? "{}").commitSha ?? null;
                } catch {
                  /* a page without a release identity */
                }
                const fcp = (w.__perfVitals ?? {}).fcp;
                const shell = w.__perfShellAt == null ? null : Math.max(w.__perfShellAt, fcp ?? 0);
                const ready = w.__perfReadyAt == null ? null : Math.max(w.__perfReadyAt, fcp ?? 0);
                return {
                  shell,
                  ready,
                  vitals: w.__perfVitals ?? {},
                  longTasks: w.__perfLongTasks ?? [],
                  longtaskMs: (w.__perfLongTasks ?? [])
                    .filter((t) => ready == null || t.start < ready)
                    .reduce((a, t) => a + t.duration, 0),
                  commit,
                };
              });

              const ms = (x: number | null | undefined) => (x == null ? null : Math.round(x));
              const rel = (t: number) => (t - (navStart ?? t)) * 1000;
              const apiRequests: LoadApiRequestSample[] = [];
              for (const req of reqs.values()) {
                try {
                  const u = new URL(req.url);
                  if (u.pathname.startsWith("/api/")) {
                    apiRequests.push({
                      route: redactedApiRouteShape(req.url),
                      status: req.status,
                      startMs: Math.round(rel(req.start)),
                      ttfbMs: req.response == null ? null : Math.round((req.response - req.start) * 1000),
                      endMs: req.end == null ? null : Math.round(rel(req.end)),
                      bytes: req.bytes,
                      fromCache: req.fromCache,
                      serverTimingMs: req.serverTimingMs,
                    });
                  }
                } catch {
                  /* ignore malformed URL */
                }
              }

              const postSettleRedirect = detectAuthRedirect(pageUsesAuth, targetOriginHost, page.path, tab.url(), apiRequests);
              const redirectedToAuth = earlyRedirect.redirectedToAuth || postSettleRedirect.redirectedToAuth;
              const finalPath = postSettleRedirect.finalPath ?? earlyRedirect.finalPath;

              const whole = {
                loadTotalBytes: finished.reduce((a, f) => a + f.bytes, 0),
                loadRequests: finished.length,
                loadScriptRequests: finished.filter((f) => f.kind === "Script" && !f.fromCache).length,
                apiRequests,
                finalPath,
                redirectedToAuth,
                serverTimingMs: docServerTimingMs,
                releaseTag: headerRelease,
              };

              // A redirect onto `/sign-in` or an external OAuth wall measured the login wall, NOT the target page:
              // clear all milestones and Web Vitals so login-wall elements matching `h2` or `nav` never enter ScopeDB as measured.
              if (redirectedToAuth) {
                return {
                  shellMs: null,
                  readyMs: null,
                  shellToReadyMs: null,
                  ttfbMs: null,
                  fcpMs: null,
                  lcpMs: null,
                  cls: null,
                  commitSha: read.commit,
                  jsBytes: null,
                  cssBytes: null,
                  totalBytes: null,
                  requests: null,
                  scriptRequests: null,
                  longtaskMs: null,
                  ledger: null,
                  ...whole,
                };
              }

              const vitalsOnly = {
                ttfbMs: net === "slow" ? null : ms(read.vitals.ttfb),
                fcpMs: ms(read.vitals.fcp),
                lcpMs: ms(read.vitals.lcp),
                cls: read.vitals.cls == null ? null : Math.round(read.vitals.cls * 10000) / 10000,
                commitSha: read.commit,
              };
              const shellMs = ms(read.shell);
              if (read.ready == null) {
                return {
                  shellMs,
                  readyMs: null,
                  shellToReadyMs: null,
                  ...vitalsOnly,
                  jsBytes: null,
                  cssBytes: null,
                  totalBytes: null,
                  requests: null,
                  scriptRequests: null,
                  longtaskMs: null,
                  ledger: null,
                  ...whole,
                };
              }
              const before = finished.filter((f) => navStart == null || (f.at - navStart) * 1000 <= read.ready!);
              const sum = (kind?: string) => before.filter((f) => !kind || f.kind === kind).reduce((a, f) => a + f.bytes, 0);
              const ledger = timeLedger(
                read.ready,
                [...reqs.values()].map((t) => ({
                  startMs: rel(t.start),
                  responseMs: t.response == null ? null : rel(t.response),
                  endMs: t.end != null ? rel(t.end) : t.response == null ? read.ready! : rel(t.lastData ?? t.response),
                })),
                read.longTasks.map((t) => ({ startMs: t.start, durationMs: t.duration })),
              );
              const readyRounded = ms(read.ready)!;
              return {
                shellMs,
                readyMs: readyRounded,
                shellToReadyMs: shellMs != null ? Math.max(0, readyRounded - shellMs) : null,
                ttfbMs: vitalsOnly.ttfbMs,
                fcpMs: ms(read.vitals.fcp),
                lcpMs: ms(read.vitals.lcp),
                cls: vitalsOnly.cls,
                jsBytes: sum("Script"),
                cssBytes: sum("Stylesheet"),
                totalBytes: sum(),
                requests: before.length,
                scriptRequests: before.filter((f) => f.kind === "Script" && !f.fromCache).length,
                longtaskMs: Math.round(read.longtaskMs),
                commitSha: read.commit,
                ledger,
                ...whole,
              };
            } finally {
              await tab.close().catch(() => {});
            }
          };
          if (state === "repeat") await loadOnce(); // the warm-up visit, not recorded
          results[page.name]!.push(await loadOnce());
        } finally {
          await context.close();
        }
      }
      const loads = results[page.name]!;
      if (loads.some((r) => r.redirectedToAuth)) {
        warnings.push(`page "${page.name}": redirected to login (${loads.find((r) => r.redirectedToAuth)?.finalPath ?? "auth"}); session cookie or storageState may be expired`);
      } else {
        if (loads.every((r) => r.lcpMs == null)) {
          warnings.push(`page "${page.name}": no load reported LCP (the web-vitals script did not run)`);
        }
        if (loads.some((r) => r.readyMs == null)) {
          warnings.push(`page "${page.name}": its ready element (${page.ready.selector}) never became visible in a load`);
        }
      }
    }
  } finally {
    const notEnded = await opened.close();
    if (notEnded) process.stderr.write(`raft-perf load: ${notEnded}\n`);
  }

  const summarizeApiCalls = (loads: LoadResult[]): LoadApiRouteSummary[] => {
    const byRoute = new Map<string, LoadApiRequestSample[]>();
    for (const load of loads) {
      for (const sample of load.apiRequests) {
        const list = byRoute.get(sample.route);
        if (list) list.push(sample);
        else byRoute.set(sample.route, [sample]);
      }
    }
    return [...byRoute.entries()]
      .map(([route, samples]): LoadApiRouteSummary => ({
        route,
        count: samples.length,
        start_ms: median(samples.map((s) => s.startMs)),
        ttfb_ms: median(samples.map((s) => s.ttfbMs)),
        end_ms: median(samples.map((s) => s.endMs)),
        bytes: median(samples.map((s) => s.bytes)),
        server_timing_ms: median(samples.map((s) => s.serverTimingMs)),
      }))
      .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0));
  };

  const intOrNull = (m: number | null): number | null => (m == null ? null : Math.round(m));
  const measuredAt = new Date().toISOString();
  const summary = Object.fromEntries(
    Object.entries(results).map(([name, loads]) => [
      name,
      {
        shell_ms: median(loads.map((r) => r.shellMs)),
        ready_ms: median(loads.map((r) => r.readyMs)),
        shell_to_ready_ms: median(loads.map((r) => r.shellToReadyMs)),
        ttfb_ms: median(loads.map((r) => r.ttfbMs)),
        fcp_ms: median(loads.map((r) => r.fcpMs)),
        lcp_ms: median(loads.map((r) => r.lcpMs)),
        cls: median(loads.map((r) => r.cls)),
        js_bytes: median(loads.map((r) => r.jsBytes)),
        css_bytes: median(loads.map((r) => r.cssBytes)),
        total_bytes: median(loads.map((r) => r.totalBytes)),
        request_count: intOrNull(median(loads.map((r) => r.requests))),
        script_request_count: intOrNull(median(loads.map((r) => r.scriptRequests))),
        longtask_ms: median(loads.map((r) => r.longtaskMs)),
        ledger_main_thread_ms: median(loads.map((r) => r.ledger?.mainThreadMs ?? null)),
        ledger_download_ms: median(loads.map((r) => r.ledger?.downloadMs ?? null)),
        ledger_network_wait_ms: median(loads.map((r) => r.ledger?.networkWaitMs ?? null)),
        ledger_unexplained_ms: median(loads.map((r) => r.ledger?.unexplainedMs ?? null)),
        load_total_bytes: median(loads.map((r) => r.loadTotalBytes)),
        load_request_count: intOrNull(median(loads.map((r) => r.loadRequests))),
        load_script_request_count: intOrNull(median(loads.map((r) => r.loadScriptRequests))),
        server_timing_ms: median(loads.map((r) => r.serverTimingMs)),
        api_requests: summarizeApiCalls(loads),
      },
    ]),
  );
  const hostBench = hostBenchmarkMedian();
  const cpus = availableParallelism();
  if (deviceProbe?.browserBenchmarkMs == null) {
    warnings.push("in-browser CPU benchmark probe returned no reading; cohort lacks browserBenchmarkMs");
  }
  const cohort = buildCohort({
    browserWhere: plan.where,
    edgeColo: dominantString(edgeColos),
    hostCpuCount: cpus,
    hostBenchmarkMs: hostBench,
    device: deviceProbe,
    connectRttSamplesMs: connectRtts,
    cpuSlowdown: net === "slow" ? 4 : 1,
    addedRttMs: net === "slow" ? 150 : 0,
    net,
  });
  const command = `pnpm --filter @botiverse/raft-perf load -- ${cliArgs()
    .filter((x, i, all) => !["--out", "--jsonl", "--run-id", "--storage-state"].includes(x) && !["--out", "--jsonl", "--run-id", "--storage-state"].includes(all[i - 1] ?? ""))
    .map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replaceAll("'", "'\\''")}'`))
    .join(" ")}`;
  const report = {
    tool: "raft-perf load",
    command,
    measuredAt,
    project: config.project,
    env: args.env,
    origin: env.origin,
    authenticated: resolvedAuth.authenticated,
    cohort,
    state,
    net,
    browser: browserSeen,
    requestedRuns: runs,
    pages: summary,
    warnings,
    runs: results,
  };
  const text = scrubAuthSecrets(JSON.stringify(report, null, 2), activeSecretsToScrub);
  process.stdout.write(`${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  if (args.jsonl) {
    const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const runId = args["run-id"] ?? randomUUID();
    const host = hostExtra(cpus, hostBench);
    const cohortFields = cohortExtra(cohort);
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
        verdict: r.redirectedToAuth || r.readyMs == null ? "unknown" : "measured",
        extra: {
          ...(r.redirectedToAuth ? { redirected_to_auth: 1, ...(r.finalPath ? { final_path: r.finalPath } : {}) } : {}),
          ...(r.shellMs != null ? { shell_ms: r.shellMs } : {}),
          ready_ms: r.readyMs,
          ...(r.shellToReadyMs != null ? { shell_to_ready_ms: r.shellToReadyMs } : {}),
          js_bytes: r.jsBytes,
          css_bytes: r.cssBytes,
          total_bytes: r.totalBytes,
          request_count: r.requests,
          ...(r.scriptRequests != null ? { script_request_count: r.scriptRequests } : {}),
          longtask_ms: r.longtaskMs,
          ledger_main_thread_ms: r.ledger?.mainThreadMs ?? null,
          ledger_download_ms: r.ledger?.downloadMs ?? null,
          ledger_network_wait_ms: r.ledger?.networkWaitMs ?? null,
          ledger_unexplained_ms: r.ledger?.unexplainedMs ?? null,
          load_total_bytes: r.loadTotalBytes,
          load_request_count: r.loadRequests,
          load_script_request_count: r.loadScriptRequests,
          ...(r.serverTimingMs != null ? { server_timing_ms: r.serverTimingMs } : {}),
          ...(r.releaseTag != null ? { release_tag: r.releaseTag } : {}),
          ...host,
          ...cohortFields,
        },
      })),
    );
    writeFileSync(
      args.jsonl,
      scrubAuthSecrets(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", activeSecretsToScrub),
    );
  }
  for (const [name, s] of Object.entries(summary)) {
    const shellPart = s.shell_ms != null ? `shell ${s.shell_ms} -> ` : "";
    const scriptsPart = s.load_script_request_count != null ? ` (${s.load_script_request_count} scripts)` : "";
    process.stderr.write(
      `raft-perf load ${config.project}/${args.env}/${name} ${state}/${net}: ${shellPart}ready ${s.ready_ms} ms (ttfb ${s.ttfb_ms}, fcp ${s.fcp_ms}, lcp ${s.lcp_ms}), ${s.request_count} requests${scriptsPart}, ${Math.round((s.total_bytes ?? 0) / 1024)} KB before ready; time: main thread ${s.ledger_main_thread_ms}, download ${s.ledger_download_ms}, network wait ${s.ledger_network_wait_ms}, unexplained ${s.ledger_unexplained_ms} ms\n`,
    );
  }
  if (warnings.length) process.stderr.write(warnings.map((w) => `warning: ${scrubAuthSecrets(w, activeSecretsToScrub)}\n`).join(""));
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const rawMsg =
      error instanceof LoadError || error instanceof BrowserError
        ? error.message
        : `failed: ${(error as Error)?.stack ?? String(error)}`;
    process.stderr.write(`raft-perf load: ${scrubAuthSecrets(rawMsg, activeSecretsToScrub)}\n`);
    process.exitCode = 2;
  },
);
