#!/usr/bin/env node
/**
 * raft-perf diagnose: source-level main-thread attribution and critical-path slack
 * decomposition for channel startup (e.g. Raft Web's post-response render gap)
 * and view switches (#proj-frontend:#72).
 *
 * Combines:
 *   1. V8 `Profiler` sampling (200 us interval) sliced to the exact critical window
 *      (`[messagesResponseEnd, firstMessagePainted]` for startup, or `[press, +windowMs]`
 *      for switches),
 *   2. Zero-dependency SourceMap v3 resolution (`--dist` or `--sourcemaps`) mapping
 *      minified bundle positions back to TypeScript/React files, lines, and subsystem
 *      buckets without serving `.map` files into the browser,
 *   3. Chrome trace `WorkSplit` + forced synchronous `Layout` / `RecalcStyle` call-stack
 *      extraction (`attributeForcedReflows`),
 *   4. First-principles critical-path & parallel network-slack model (`buildCriticalPathSummary`).
 *
 * Exit codes: 0 report written, 2 usage / browser / target error.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { cliArgs } from "./args";
import { fetchAndVerifyFixture } from "./benchCheck";
import { loadBenchFixture, resolveFixtureTargets } from "./benchFixture";
import { BrowserError, type OpenedBrowser, openBrowser, planBrowser } from "./browser";
import { type BrowserDeviceProbe, buildCohort, dominantString, parseConnectRttMs, parseEdgeColo, parseServerTimingMs, probeBrowserDevice } from "./cohort";
import { type RawCommitCapture, installCommitWaterfallHook, summarizeCommitWaterfall } from "./commitWaterfall";
import { type CpuProfile, analyzeCpuProfile, attributeForcedReflows, buildCriticalPathSummary } from "./cpuProfile";
import { archiveGzipFile, diagnoseReportToRow } from "./diagnoseRuns";
import { hostBenchmarkMedian } from "./hostHealth";
import { isProductionHost } from "./page";
import { RTT_RANGE_MS, type RttProxy, rttChromiumArgs, startRttProxy } from "./rttProxy";
import { SourceMapRegistry } from "./sourceMap";
import { endpointOf, isFirstPage } from "./startupSplit";
import { DIAGNOSE_TRACE_CATEGORIES, type TraceEvent, findClickStart, findTraceMark, forcedSpansRange, workSplitRange } from "./workSplit";

const HELP = `raft-perf diagnose — source-level V8 CPU profile, SourceMap attribution, forced-reflow stacks, and critical-path slack

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --scenario <kind>     startup | switch (default startup)
  --mode <mode>         for startup: reopen | new-device (default reopen)
  --window <win>        for startup: response-to-paint | full-load | post-paint (default response-to-paint)
  --switch-window <ms>  for switch: window after pointerdown/click in ms (default 3000)
  --origin <url>        web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>           API origin (default: --origin, or https://api-aws-staging.botiverse.dev when --dist is set)
  --dist <dir>          optional local web build output (packages/web/dist): served into --origin (non-prod only)
                        and scanned for .js.map files so hotspots resolve to exact TypeScript lines
  --sourcemaps <dir>    optional directory of .js.map files when profiling a deployed build without --dist
  --fixture <name>      frozen benchmark fixture (e.g. bench-v1): sets --server/--channel/--other and verifies digest
  --server <slug>       server slug (required unless --fixture sets it)
  --channel <name>      target channel (default all, or fixture's channel)
  --other <name>        for switch: starting channel switched from (default all, or fixture's secondary channel)
  --browser <where>     local | browser-run (default local; --dist requires local)
  --cpu <n>             slow local browser CPU n times (1 to 20; default 4 for ordinary-device attribution)
  --rtt <ms>            add round-trip latency via local HTTPS proxy (0 to 1000; default 0)
  --interval-us <n>     V8 CPU profiler sampling interval in microseconds (50 to 5000; default 200)
  --top <n>             number of hotspot functions/files to list (default 20)
  --out <file>          also write JSON report here
  --jsonl <file>        also write one structured ScopeDB perf.diagnose_runs row here; needs --project
  --project <name>      with --jsonl: product name (e.g. raft-web)
  --env <env>           with --jsonl: environment override (default: inferred from origin, else staging)
  --run-id <id>         with --jsonl: shared run_id across a collection (default: a new UUID)
  --commit-sha <sha>    override commitSha in the report and JSONL row (useful with local --dist builds)
  --backfilled          with --jsonl: mark row as backfilled=true
  --save-profile <file> save raw V8 .cpuprofile JSON here (loadable in Chrome DevTools / Speedscope)
  --save-profile-gz <f> save gzipped raw V8 .cpuprofile.gz here and record profile_sha256
  --profile-url <url>   external Artifact/object-storage link recorded in profile_url
  --save-trace <file>   save raw Chrome trace JSON here
  --save-trace-gz <f>   save gzipped raw Chrome .trace.json.gz here and record trace_sha256
  --trace-url <url>     external Artifact/object-storage link recorded in trace_url
  --chromium-arg <a>    extra Chromium switch for a local browser (repeatable)
  --allow-production    allow profiling *.raft.build (refused with --dist)
`;

class DiagnoseError extends Error {}
const fail = (message: string): never => {
  throw new DiagnoseError(message);
};

const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

const PRODUCTION_SOCKET = /^wss?:\/\/([^/?#@]*\.)?raft\.build\.?(:\d+)?([/?#]|$)/i;

interface InPageDiagnoseState {
  anchorNow: number;
  row: number | null;
  painted: number | null;
  messagesStart: number | null;
  messagesEnd: number | null;
  commitSha: string | null;
}

const installDiagnoseStartupProbe = () => {
  const w = window as unknown as {
    __raftDiagnose?: { anchorNow: number; row: number | null; painted: number | null };
  };
  performance.setResourceTimingBufferSize(20_000);
  performance.mark("__raft_perf_anchor");
  const anchorNow = performance.now();
  w.__raftDiagnose = { anchorNow, row: null, painted: null };
  new MutationObserver(() => {
    const state = w.__raftDiagnose;
    if (!state || state.row != null) return;
    if (!document.querySelector("[data-testid=message-scroller] [data-message-item], [data-testid=message-scroller] [data-message-id]")) return;
    state.row = performance.now();
    performance.mark("__raft_perf_row");
    requestAnimationFrame(() =>
      setTimeout(() => {
        if (w.__raftDiagnose && w.__raftDiagnose.painted == null) {
          w.__raftDiagnose.painted = performance.now();
          performance.mark("__raft_perf_painted");
        }
      }, 0),
    );
  }).observe(document, { childList: true, subtree: true });
};

async function startBestEffortTrace(browser: Browser, page: Page): Promise<(() => Promise<TraceEvent[] | null>) | null> {
  try {
    await browser.startTracing(page, { categories: DIAGNOSE_TRACE_CATEGORIES });
    return async () => {
      try {
        const buf = await browser.stopTracing();
        const parsed = JSON.parse(buf.toString("utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
        return Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? null);
      } catch {
        return null;
      }
    };
  } catch {
    // Remote `connectOverCDP` browsers do not expose Playwright's `browser.startTracing`: fall back to browser-level CDP Tracing when available.
    try {
      const bcdp = await browser.newBrowserCDPSession();
      const chunks: TraceEvent[] = [];
      const complete = new Promise<void>((resolve) => {
        bcdp.on("Tracing.dataCollected", (e: { value?: unknown[] }) => {
          if (Array.isArray(e.value)) chunks.push(...(e.value as TraceEvent[]));
        });
        bcdp.on("Tracing.tracingComplete", () => resolve());
      });
      await bcdp.send("Tracing.start", { categories: DIAGNOSE_TRACE_CATEGORIES.join(",") });
      return async () => {
        try {
          await bcdp.send("Tracing.end");
          await Promise.race([complete, new Promise<void>((r) => setTimeout(r, 10_000))]);
          await bcdp.detach().catch(() => {});
          return chunks.length ? chunks : null;
        } catch {
          await bcdp.detach().catch(() => {});
          return null;
        }
      };
    } catch {
      return null;
    }
  }
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      scenario: { type: "string", default: "startup" },
      mode: { type: "string", default: "reopen" },
      window: { type: "string", default: "response-to-paint" },
      "switch-window": { type: "string", default: "3000" },
      origin: { type: "string", default: "https://raft-app-staging.botiverse.dev" },
      api: { type: "string" },
      dist: { type: "string" },
      sourcemaps: { type: "string" },
      fixture: { type: "string" },
      server: { type: "string" },
      channel: { type: "string" },
      other: { type: "string" },
      browser: { type: "string" },
      cpu: { type: "string", default: "4" },
      rtt: { type: "string", default: "0" },
      "interval-us": { type: "string", default: "200" },
      top: { type: "string", default: "20" },
      out: { type: "string" },
      jsonl: { type: "string" },
      project: { type: "string" },
      env: { type: "string" },
      "run-id": { type: "string" },
      "commit-sha": { type: "string" },
      backfilled: { type: "boolean", default: false },
      "save-profile": { type: "string" },
      "save-profile-gz": { type: "string" },
      "profile-url": { type: "string" },
      "save-trace": { type: "string" },
      "save-trace-gz": { type: "string" },
      "trace-url": { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
      "allow-production": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const scenario = args.scenario as "startup" | "switch";
  if (scenario !== "startup" && scenario !== "switch") fail("--scenario must be startup or switch");
  const startupMode = args.mode as "reopen" | "new-device";
  if (startupMode !== "reopen" && startupMode !== "new-device") fail("--mode must be reopen or new-device");
  const focusWindow = args.window as "response-to-paint" | "full-load" | "post-paint";
  if (!["response-to-paint", "full-load", "post-paint"].includes(focusWindow)) {
    fail("--window must be response-to-paint, full-load, or post-paint");
  }
  const switchWindowMs = Number(args["switch-window"]);
  if (!Number.isInteger(switchWindowMs) || switchWindowMs < 200 || switchWindowMs > 30_000) {
    fail("--switch-window must be an integer from 200 to 30000 ms");
  }
  if (args.jsonl && !args.project) {
    fail("--jsonl needs --project (which product this web belongs to)");
  }

  const origin = args.origin!.replace(/\/$/, "");
  const defaultApi = origin.includes("raft-app-staging.botiverse.dev") ? "https://api-aws-staging.botiverse.dev" : origin;
  const api = (args.api ?? defaultApi).replace(/\/$/, "");

  const plan = planBrowser(args.browser, args["chromium-arg"], process.env);
  const distDir = args.dist ? path.resolve(args.dist) : null;
  if (distDir) {
    if (plan.where !== "local") fail("--dist serves local build files and requires --browser local");
    if (!existsSync(path.join(distDir, "index.html"))) fail(`--dist ${distDir} has no index.html`);
  }

  let production = false;
  try {
    production = isProductionHost(origin) || isProductionHost(api);
  } catch {
    return fail("--origin and --api must be valid URLs");
  }
  if (production && distDir) fail("refusing a production origin or API with --dist");
  if (production && !args["allow-production"]) fail("refusing a production origin or API without --allow-production");

  const cpu = Number(args.cpu);
  if (!Number.isFinite(cpu) || cpu < 1 || cpu > 20) fail("--cpu must be a number from 1 to 20");
  if (cpu > 1 && plan.where !== "local") fail("--cpu slows a local browser; pass --cpu 1 with --browser browser-run");

  const rtt = Number(args.rtt);
  if (!Number.isFinite(rtt) || rtt < RTT_RANGE_MS[0] || rtt > RTT_RANGE_MS[1]) {
    fail(`--rtt must be from ${RTT_RANGE_MS[0]} to ${RTT_RANGE_MS[1]} ms`);
  }
  if (rtt > 0 && plan.where !== "local") fail("--rtt requires --browser local");

  const intervalUs = Number(args["interval-us"]);
  if (!Number.isInteger(intervalUs) || intervalUs < 50 || intervalUs > 5000) {
    fail("--interval-us must be an integer from 50 to 5000");
  }
  const topN = Number(args.top);
  if (!Number.isInteger(topN) || topN < 1 || topN > 200) fail("--top must be an integer from 1 to 200");

  const mapDir = args.sourcemaps ? path.resolve(args.sourcemaps) : distDir;
  let registry: SourceMapRegistry | null = null;
  if (mapDir) {
    try {
      registry = SourceMapRegistry.fromDirectory(mapDir);
    } catch (error) {
      if (args.sourcemaps) fail((error as Error).message);
      registry = null;
    }
  }

  const fixtureSpec = (() => {
    try {
      return args.fixture ? loadBenchFixture(args.fixture) : null;
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  const resolved = (() => {
    try {
      return resolveFixtureTargets(fixtureSpec, { server: args.server, channel: args.channel, other: args.other }, { channel: "all", other: "all" });
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  if (!resolved.server) fail("--server <slug> (or --fixture <name>) is required");

  const email = process.env.RAFT_PERF_EMAIL;
  const password = process.env.RAFT_PERF_PASSWORD;
  if (!email || !password) fail("set RAFT_PERF_EMAIL and RAFT_PERF_PASSWORD (a test account)");

  async function json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(url, init).catch((error: Error) => fail(`${new URL(url).pathname} failed: ${error.message}`));
    if (!response.ok) fail(`${new URL(url).pathname} answered ${response.status}`);
    return response.json().catch(() => fail(`${new URL(url).pathname} did not answer JSON`));
  }

  const session = (await json(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })) as { accessToken?: string; refreshToken?: string };
  if (!session.accessToken || !session.refreshToken) fail("sign-in returned no tokens");
  const auth = { authorization: `Bearer ${session.accessToken}` };

  type Named = { id: string; name: string };
  const servers = (await json(`${api}/api/servers`, { headers: auth })) as Array<{ id: string; slug: string }> | { servers: Array<{ id: string; slug: string }> };
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === resolved.server) ?? fail(`account is not in server ${resolved.server}`);
  const channelsRaw = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as Named[] | { channels: Named[] };
  const channelList = Array.isArray(channelsRaw) ? channelsRaw : channelsRaw.channels;
  const targetChannel = channelList.find((c) => c.name === resolved.channel) ?? fail(`no channel ${resolved.channel} in ${resolved.server}`);
  const otherChannel =
    scenario === "switch"
      ? (channelList.find((c) => c.name === resolved.other) ?? fail(`no channel ${resolved.other} in ${resolved.server}`))
      : null;
  if (scenario === "switch" && otherChannel && otherChannel.id === targetChannel.id) {
    fail("--channel and --other must differ for --scenario switch");
  }

  let verifiedFixtureTag: string | null = null;
  if (fixtureSpec) {
    const check = await fetchAndVerifyFixture(api, session.accessToken!, server.id, targetChannel.id, fixtureSpec).catch((error: Error) => fail(error.message));
    if (!check.ok) fail(`fixture ${fixtureSpec.fixture} drifted (${check.mismatches.join("; ")}): refusing to diagnose`);
    verifiedFixtureTag = check.tag;
  }

  const warnings: string[] = [];
  const edgeColos: string[] = [];
  const connectRtts: number[] = [];
  let serverTimingMs: number | null = null;
  let servedLocally = 0;
  let leakedProductionHost: string | null = null;

  let proxy: RttProxy | null = null;
  let opened: OpenedBrowser | null = null;
  let deviceProbe: BrowserDeviceProbe | null = null;

  const installDistRouting = async (context: BrowserContext, page: Page) => {
    if (!distDir) return;
    await context.route(
      (u) => isProductionHost(u.href),
      (route) => {
        if (["fetch", "xhr", "eventsource"].includes(route.request().resourceType())) {
          leakedProductionHost ??= new URL(route.request().url()).host;
        }
        return route.abort();
      },
    );
    await context.routeWebSocket(PRODUCTION_SOCKET, (socket) => {
      leakedProductionHost ??= new URL(socket.url()).host;
      return socket.close();
    });
    await page.route(
      (u) => u.origin === origin,
      async (route) => {
        const req = route.request();
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(req.url()).pathname);
        } catch {
          return route.continue();
        }
        // Never serve `.map` files into the page, and let API/socket calls pass through
        if (req.method() !== "GET" || pathname.endsWith(".map") || /^\/(api|socket\.io)(\/|$)/.test(pathname)) {
          return route.continue();
        }
        let file = path.join(distDir, pathname);
        const isFile = file.startsWith(distDir + path.sep) && existsSync(file) && statSync(file).isFile();
        if (!isFile) {
          if (req.resourceType() !== "document") return route.continue();
          file = path.join(distDir, "index.html");
        }
        servedLocally++;
        return route.fulfill({
          status: 200,
          contentType: MIME_TYPES[path.extname(file)] ?? "application/octet-stream",
          body: readFileSync(file),
        });
      },
    );
  };

  let rawProfile: CpuProfile | null = null;
  let rawTrace: TraceEvent[] | null = null;
  let rawCommits: RawCommitCapture | null = null;
  let switchStartPerfNowMs = 0;
  let switchCommitSha: string | null = null;
  let syncEndPerfNowMs = 0;
  let startupState: InPageDiagnoseState | null = null;

  try {
    if (rtt > 0) proxy = await startRttProxy(rtt);
    const runPlan =
      proxy && plan.where === "local"
        ? { ...plan, chromiumArgs: [...plan.chromiumArgs, ...rttChromiumArgs(proxy)] }
        : plan;
    opened = await openBrowser(runPlan);
    const browser = opened.browser;
    deviceProbe = await probeBrowserDevice(browser);
    if (deviceProbe.browserBenchmarkMs == null) {
      warnings.push("in-browser CPU benchmark probe returned no reading");
    }

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      storageState: {
        cookies: [],
        origins: [
          {
            origin,
            localStorage: [
              { name: "slock_access_token", value: session.accessToken! },
              { name: "slock_refresh_token", value: session.refreshToken! },
            ],
          },
        ],
      },
    });

    try {
      const channelUrl = `${origin}/s/${server.slug}/channel/${targetChannel.id}`;
      const apiHost = new URL(api).host;

      if (scenario === "startup") {
        if (startupMode === "reopen") {
          // Warm load first in the same BrowserContext so IndexedDB, HTTP cache, and preflights are populated
          const warmPage = await context.newPage();
          await installDistRouting(context, warmPage);
          await warmPage.goto(channelUrl, { waitUntil: "load", timeout: 120_000 });
          await warmPage
            .locator("[data-testid=message-scroller] [data-message-item], [data-testid=message-scroller] [data-message-id]")
            .first()
            .waitFor({ timeout: 60_000 })
            .catch(() => {});
          await warmPage.waitForTimeout(3000);
          await warmPage.close();
          servedLocally = 0;
        }

        const page = await context.newPage();
        await installDistRouting(context, page);
        await page.addInitScript(installCommitWaterfallHook);
        await page.addInitScript(installDiagnoseStartupProbe);
        const cdp: CDPSession = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        cdp.on("Network.responseReceived", (e) => {
          if (e.type === "Document" || new URL(e.response.url).host === apiHost) {
            const colo = parseEdgeColo(e.response.headers);
            if (colo) edgeColos.push(colo);
            const cRtt = parseConnectRttMs(e.response.timing, e.response.protocol);
            if (cRtt != null) connectRtts.push(cRtt);
          }
          if (serverTimingMs == null && e.response.url.includes(`/api/messages/channel/${targetChannel.id}`)) {
            serverTimingMs = parseServerTimingMs(e.response.headers["server-timing"] ?? e.response.headers["Server-Timing"]);
          }
        });

        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: intervalUs });
        const stopTrace = await startBestEffortTrace(browser, page);
        await cdp.send("Profiler.start");

        await page.goto(channelUrl, { waitUntil: "load", timeout: 120_000 });
        await page
          .locator("[data-testid=message-scroller] [data-message-item], [data-testid=message-scroller] [data-message-id]")
          .first()
          .waitFor({ timeout: 60_000 })
          .catch(() => {});
        // Allow 2s post-paint settle so `post-paint-settle` captures deferred next-frame work
        await page.waitForTimeout(2200);

        syncEndPerfNowMs = await page.evaluate(() => performance.now());
        const stopped = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
        rawProfile = stopped.profile;
        rawTrace = stopTrace ? await stopTrace() : null;
        rawCommits = await page.evaluate(() => {
          const w = window as unknown as { __raftPerfCommits?: { read: () => RawCommitCapture } };
          return w.__raftPerfCommits ? w.__raftPerfCommits.read() : null;
        });

        startupState = await page.evaluate(
          ({ host, originHost, channelId }) => {
            const w = window as unknown as {
              __raftDiagnose?: { anchorNow: number; row: number | null; painted: number | null };
            };
            const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) => {
              const u = new URL(r.name);
              return (u.host === host || u.host === originHost) && u.pathname.startsWith("/api/");
            });
            const msgEntry = resources.find((r) => r.name.includes(`/api/messages/channel/${channelId}`));
            let commitSha: string | null = null;
            try {
              commitSha = (JSON.parse(document.getElementById("raft-frontend-release-identity")?.textContent ?? "{}").commitSha as string | undefined) ?? null;
            } catch {
              commitSha = null;
            }
            return {
              anchorNow: w.__raftDiagnose?.anchorNow ?? 0,
              row: w.__raftDiagnose?.row ?? null,
              painted: w.__raftDiagnose?.painted ?? null,
              messagesStart: msgEntry ? msgEntry.startTime : null,
              messagesEnd: msgEntry ? msgEntry.responseEnd : null,
              commitSha,
            };
          },
          { host: apiHost, originHost: new URL(origin).host, channelId: targetChannel.id },
        );
        // Double-check endpoint matching via startupSplit's endpointOf if query/route differs
        if (startupState.messagesEnd == null) {
          const fallbackEnd = await page.evaluate(
            ({ host }) => {
              const entries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) => new URL(r.name).host === host);
              return entries.map((r) => ({ url: r.name, start: r.startTime, end: r.responseEnd }));
            },
            { host: apiHost },
          );
          const firstMsg = fallbackEnd.find((e) => isFirstPage(endpointOf(e.url, targetChannel.id)));
          if (firstMsg) {
            startupState.messagesStart = firstMsg.start;
            startupState.messagesEnd = firstMsg.end;
          }
        }
        await page.close();
      } else {
        // `--scenario switch`: start on `otherChannel`, then profile clicking `targetChannel` in the sidebar
        const page = await context.newPage();
        await installDistRouting(context, page);
        await page.addInitScript(installCommitWaterfallHook);
        const cdp: CDPSession = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        cdp.on("Network.responseReceived", (e) => {
          if (e.type === "Document" || new URL(e.response.url).host === apiHost) {
            const colo = parseEdgeColo(e.response.headers);
            if (colo) edgeColos.push(colo);
            const cRtt = parseConnectRttMs(e.response.timing, e.response.protocol);
            if (cRtt != null) connectRtts.push(cRtt);
          }
        });
        await page.goto(`${origin}/s/${server.slug}/channel/${otherChannel!.id}`, { waitUntil: "load", timeout: 120_000 });
        await page.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 });
        await page.waitForTimeout(4000);
        await cdp.send("Network.disable").catch(() => {});

        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: intervalUs });
        const stopTrace = await startBestEffortTrace(browser, page);
        await cdp.send("Profiler.start");
        switchStartPerfNowMs = await page.evaluate(() => {
          const w = window as unknown as { __raftPerfCommits?: { reset: () => void } };
          w.__raftPerfCommits?.reset();
          performance.mark("__raft_perf_switch_arm");
          return performance.now();
        });
        await page.locator("[data-testid=sidebar-root]").getByText(targetChannel.name, { exact: true }).first().click({ timeout: 10_000 });
        await page.waitForTimeout(switchWindowMs + 250);
        const stopped = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
        rawProfile = stopped.profile;
        rawTrace = stopTrace ? await stopTrace() : null;
        rawCommits = await page.evaluate(() => {
          const w = window as unknown as { __raftPerfCommits?: { read: () => RawCommitCapture } };
          return w.__raftPerfCommits ? w.__raftPerfCommits.read() : null;
        });
        switchCommitSha = await page.evaluate(() => {
          try {
            const raw = document.getElementById("raft-frontend-release-identity")?.textContent;
            const parsed = raw ? (JSON.parse(raw) as { commitSha?: string }) : null;
            return parsed?.commitSha ?? null;
          } catch {
            return null;
          }
        });
        await page.close();
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    const closeWarning = opened ? await opened.close() : null;
    if (closeWarning) process.stderr.write(`raft-perf diagnose: ${closeWarning}\n`);
    await proxy?.close().catch(() => {});
  }

  if (leakedProductionHost) {
    fail(`--dist build talked to production host ${leakedProductionHost}; build with VITE_API_URL=${api}`);
  }
  if (distDir && servedLocally === 0) {
    fail(`--dist ${distDir} served 0 files into ${origin}`);
  }
  if (!rawProfile) fail("no CPU profile was captured");

  if (args["save-profile"]) {
    writeFileSync(args["save-profile"], `${JSON.stringify(rawProfile)}\n`);
  }
  if (args["save-trace"] && rawTrace) {
    writeFileSync(args["save-trace"], `${JSON.stringify({ traceEvents: rawTrace })}\n`);
  }
  let profileSha256: string | null = null;
  let traceSha256: string | null = null;
  if (args["save-profile-gz"]) {
    const saved = archiveGzipFile(`${JSON.stringify(rawProfile)}\n`, args["save-profile-gz"]);
    profileSha256 = saved.sha256;
  }
  if (args["save-trace-gz"] && rawTrace) {
    const saved = archiveGzipFile(`${JSON.stringify({ traceEvents: rawTrace })}\n`, args["save-trace-gz"]);
    traceSha256 = saved.sha256;
  }
  const resolvedEnv =
    args.env ?? (production ? "production" : /staging/i.test(origin) ? "staging" : /localhost|127\.0\.0\.1/i.test(origin) ? "dev" : "staging");
  const writeDiagnoseJsonl = (reportObj: Parameters<typeof diagnoseReportToRow>[0]): void => {
    if (!args.jsonl) return;
    const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const row = diagnoseReportToRow(reportObj, {
      project: args.project!,
      env: resolvedEnv,
      runId: args["run-id"] ?? randomUUID(),
      toolVersion,
      backfilled: Boolean(args.backfilled),
      traceUrl: args["trace-url"] ?? null,
      traceSha256,
      profileUrl: args["profile-url"] ?? null,
      profileSha256,
    });
    const outPath = path.resolve(args.jsonl);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(row)}\n`);
  };

  const cpus = availableParallelism();
  const hostBench = hostBenchmarkMedian();
  const cohort = buildCohort({
    browserWhere: plan.where,
    edgeColo: dominantString(edgeColos),
    hostCpuCount: cpus,
    hostBenchmarkMs: hostBench,
    device: deviceProbe,
    connectRttSamplesMs: connectRtts,
    cpuSlowdown: cpu,
    addedRttMs: rtt,
    net: cpu > 1 || rtt > 0 ? "throttled" : "fast",
    fixture: verifiedFixtureTag,
  });

  if (scenario === "startup") {
    const st = startupState!;
    if (st.painted == null) warnings.push("no message row painted within 60 s; profile covers the whole capture");
    if (st.messagesEnd == null) warnings.push("first-page messages request was not found in ResourceTiming");

    // Map `performance.now()` (ms) -> monotonic trace/profiler clock (us)
    const anchorMark = rawTrace ? findTraceMark(rawTrace, "__raft_perf_anchor") : null;
    if (!rawTrace) {
      warnings.push("Chrome trace was unavailable; criticalPath and forcedReflows could not be computed");
    } else if (!anchorMark) {
      warnings.push("trace lacked __raft_perf_anchor user_timing mark; profile window used end-clock alignment and criticalPath is unavailable");
    }
    const toMonoUs = (perfNowMs: number): number => {
      if (anchorMark) return Math.round(anchorMark.ts + (perfNowMs - st.anchorNow) * 1000);
      return Math.round(rawProfile!.endTime + (perfNowMs - syncEndPerfNowMs) * 1000);
    };

    const navStartMs = 0;
    const msgStartMs = st.messagesStart ?? 0;
    const respEndMs = st.messagesEnd ?? 0;
    const paintedMs = st.painted ?? syncEndPerfNowMs;
    const settleEndMs = Math.min(paintedMs + 2000, syncEndPerfNowMs);
    if (focusWindow === "post-paint" && syncEndPerfNowMs - paintedMs < 1800) {
      warnings.push(`recording ended ${Math.round((syncEndPerfNowMs - paintedMs) * 10) / 10} ms after paint (< 2000 ms post-paint window)`);
    }

    const shownBeforeResponse = st.painted != null && (st.messagesEnd == null || st.painted < st.messagesEnd);
    let effectiveWindow: "response-to-paint" | "full-load" | "post-paint" = focusWindow;
    if (focusWindow === "response-to-paint" && shownBeforeResponse) {
      effectiveWindow = "full-load";
      warnings.push(
        st.messagesEnd != null
          ? `messages painted from local cache (${Math.round(st.painted! * 10) / 10} ms) before the network response finished (${Math.round(st.messagesEnd * 10) / 10} ms): response-to-paint gap is 0 ms; CPU profile fell back to full-load [0, painted]`
          : "first-page messages response was not observed; CPU profile fell back to full-load [0, painted]",
      );
    }

    const navStartUs = toMonoUs(navStartMs);
    const msgStartUs = toMonoUs(Math.min(msgStartMs, respEndMs));
    const respEndUs = toMonoUs(respEndMs);
    const paintedUs = toMonoUs(paintedMs);
    const settleEndUs = toMonoUs(Math.max(paintedMs, settleEndMs));

    const windowBoundsUs: [number, number] =
      effectiveWindow === "full-load"
        ? [navStartUs, paintedUs]
        : effectiveWindow === "post-paint"
          ? [paintedUs, settleEndUs]
          : [Math.min(respEndUs, paintedUs), paintedUs];

    const cpuAnalysis = analyzeCpuProfile(rawProfile, {
      fromUs: windowBoundsUs[0],
      toUs: windowBoundsUs[1],
      registry,
      top: topN,
    });

    const pid = anchorMark?.pid ?? -1;
    const tid = anchorMark?.tid ?? -1;
    const criticalPath =
      rawTrace && pid >= 0
        ? buildCriticalPathSummary({
            messagesStartMs: st.messagesStart,
            messagesResponseEndMs: st.messagesEnd,
            paintedMs,
            beforeRequestSplit: st.messagesStart != null ? workSplitRange(rawTrace, pid, tid, navStartUs, msgStartUs) : null,
            inFlightSplit: st.messagesEnd != null ? workSplitRange(rawTrace, pid, tid, msgStartUs, respEndUs) : null,
            responseToPaintSplit:
              !shownBeforeResponse && st.messagesEnd != null ? workSplitRange(rawTrace, pid, tid, respEndUs, paintedUs) : null,
            cachedToPaintSplit: shownBeforeResponse ? workSplitRange(rawTrace, pid, tid, navStartUs, paintedUs) : null,
            postPaintSettleSplit: settleEndUs > paintedUs ? workSplitRange(rawTrace, pid, tid, paintedUs, settleEndUs) : null,
          })
        : null;

    const forcedSpans = rawTrace && pid >= 0 ? forcedSpansRange(rawTrace, pid, tid, windowBoundsUs[0], windowBoundsUs[1]) : [];
    const forcedReflows = attributeForcedReflows(forcedSpans, rawProfile, registry, 10);
    const commitWaterfall = rawCommits
      ? summarizeCommitWaterfall(
          rawCommits,
          {
            kind: "startup",
            messagesStartMs: st.messagesStart,
            messagesResponseEndMs: st.messagesEnd,
            paintedMs: st.painted,
            settleEndMs,
          },
          rawTrace,
        )
      : null;
    if (commitWaterfall && !commitWaterfall.rendererAttached) {
      warnings.push("React commit waterfall hook observed no React renderer (commitWaterfall counts are empty)");
    }

    const report = {
      tool: "raft-perf diagnose",
      measuredAt: new Date().toISOString(),
      scenario: "startup" as const,
      mode: startupMode,
      focusWindow,
      effectiveWindow,
      origin,
      api,
      dist: distDir,
      sourceMapsLoaded: registry?.mapCount ?? 0,
      page: { server: server.slug, channel: targetChannel.name },
      cohort,
      commitSha: args["commit-sha"] ?? st.commitSha ?? null,
      serverTimingMs,
      timings: {
        messagesStartMs: st.messagesStart == null ? null : Math.round(st.messagesStart * 10) / 10,
        messagesResponseEndMs: st.messagesEnd == null ? null : Math.round(st.messagesEnd * 10) / 10,
        firstRowMs: st.row == null ? null : Math.round(st.row * 10) / 10,
        paintedMs: st.painted == null ? null : Math.round(st.painted * 10) / 10,
        responseToPaintMs:
          st.painted != null && st.messagesEnd != null && st.painted >= st.messagesEnd
            ? Math.round((st.painted - st.messagesEnd) * 10) / 10
            : null,
        shownBeforeResponse,
      },
      criticalPath,
      commitWaterfall,
      cpuProfile: cpuAnalysis,
      forcedReflows,
      warnings,
    };

    const text = JSON.stringify(report, null, 2);
    process.stdout.write(`${text}\n`);
    if (args.out) writeFileSync(args.out, `${text}\n`);
    writeDiagnoseJsonl(report);

    process.stderr.write(
      `raft-perf diagnose startup (${startupMode}, window=${focusWindow}, cpu=${cpu}x, maps=${registry?.mapCount ?? 0}): ` +
        `painted=${report.timings.paintedMs ?? "-"} ms, responseToPaint=${report.timings.responseToPaintMs ?? "-"} ms, ` +
        `activeCpu=${cpuAnalysis.activeMs} ms, forcedReflows=${forcedReflows.length}\n`,
    );
    if (commitWaterfall?.rendererAttached) {
      const prePaint =
        commitWaterfall.byPhase.beforeRequest + commitWaterfall.byPhase.inFlight + commitWaterfall.byPhase.responseToPaint;
      process.stderr.write(
        `  commits: ${prePaint} before paint (${commitWaterfall.commitsBeforeScrollerMount} pre-scroller` +
          `${commitWaterfall.scrollerMountDelayAfterResponseMs != null ? `, +${commitWaterfall.scrollerMountDelayAfterResponseMs} ms after response` : ""}), ` +
          `${commitWaterfall.rows.distinctRows} rows (mounts=${commitWaterfall.rows.mounts}, prePaintUpdates=${commitWaterfall.rows.prePaintUpdates}, ` +
          `postPaintUpdates=${commitWaterfall.rows.postPaintUpdates}, median=${commitWaterfall.rows.rendersPerRow.median}x/row)\n`,
      );
    }
    for (const h of cpuAnalysis.topTotal.slice(0, 5)) {
      process.stderr.write(
        `  top total: ${h.totalMs} ms (${h.totalPct}%, self ${h.selfMs} ms) [${h.bucket}] ${h.functionName} (${h.source}${h.line != null ? `:${h.line}` : ""})\n`,
      );
    }
    return warnings.length ? 2 : 0;
  }

  // `switch` report
  const clickStart = rawTrace ? findClickStart(rawTrace) : null;
  const fromUs = clickStart ? clickStart.ts : rawProfile.startTime;
  const toUs = clickStart ? clickStart.ts + switchWindowMs * 1000 : rawProfile.endTime;
  const switchSplit = rawTrace && clickStart ? workSplitRange(rawTrace, clickStart.pid, clickStart.tid, fromUs, toUs) : null;
  if (!clickStart) warnings.push("trace held no click event; CPU profile covers full switch recording");
  const cpuAnalysis = analyzeCpuProfile(rawProfile, { fromUs, toUs, registry, top: topN });
  const forcedSpans = rawTrace && clickStart ? forcedSpansRange(rawTrace, clickStart.pid, clickStart.tid, fromUs, toUs) : [];
  const forcedReflows = attributeForcedReflows(forcedSpans, rawProfile, registry, 10);
  const switchCommitWaterfall = rawCommits
    ? summarizeCommitWaterfall(
        rawCommits,
        {
          kind: "switch",
          startPerfNowMs: switchStartPerfNowMs,
          windowMs: switchWindowMs,
        },
        rawTrace,
      )
    : null;

  const report = {
    tool: "raft-perf diagnose",
    measuredAt: new Date().toISOString(),
    scenario: "switch" as const,
    windowMs: switchWindowMs,
    origin,
    api,
    dist: distDir,
    sourceMapsLoaded: registry?.mapCount ?? 0,
    page: { server: server.slug, channel: targetChannel.name, other: otherChannel!.name },
    cohort,
    commitSha: args["commit-sha"] ?? switchCommitSha ?? null,
    workSplit: switchSplit,
    commitWaterfall: switchCommitWaterfall,
    cpuProfile: cpuAnalysis,
    forcedReflows,
    warnings,
  };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  writeDiagnoseJsonl(report);
  process.stderr.write(
    `raft-perf diagnose switch (#${otherChannel!.name} -> #${targetChannel.name}, cpu=${cpu}x): activeCpu=${cpuAnalysis.activeMs} ms, forcedReflows=${forcedReflows.length}` +
      `${switchCommitWaterfall?.rendererAttached ? `, commits=${switchCommitWaterfall.totalCommits}` : ""}\n`,
  );
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `raft-perf diagnose: ${error instanceof DiagnoseError || error instanceof BrowserError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`,
    );
    process.exitCode = 2;
  },
);
