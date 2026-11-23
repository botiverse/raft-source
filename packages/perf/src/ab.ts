#!/usr/bin/env node
/**
 * raft-perf ab: two local builds of the web, one change between them, compared
 * pair-by-pair on a deployed non-production origin (#proj-frontend:#72).
 *
 * Supports two scenarios (`--scenario`):
 *   - `switch` (default): main-thread work in the 3 s after clicking a sidebar channel (`compareArms`).
 *   - `startup`: channel open (`reopen` or `new-device`), judging `paintedMs`, `responseToPaintMs`,
 *     `rowMs`, `longTasksMs`, and post-response `taskMs`/`scriptMs`/`styleMs`/`layoutMs`/`forcedMs`
 *     (`compareStartupArms`), with optional `--cpu <n>` slowdown and `--replay` deterministic API replay.
 *
 * Exit codes: 0 compared cleanly, 2 comparison failed or emitted warnings.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";
import { type ArmVisit, type StartupArmVisit, type StartupSample, compareArms, compareStartupArms } from "./abCompare";
import { ApiReplayStore, canonicalApiRequestKey, evaluateReplayMisses, hashAccountHint, redactedApiRouteShape } from "./apiReplay";
import { cliArgs } from "./args";
import { fetchAndVerifyFixture } from "./benchCheck";
import { loadBenchFixture, resolveFixtureTargets } from "./benchFixture";
import { type BrowserDeviceProbe, buildCohort, probeBrowserDevice } from "./cohort";
import { type HostSample, busyPairs, hostBenchmark, lopsided, readPressure, stallShares } from "./hostHealth";
import { isProductionHost } from "./page";
import { endpointOf, isFirstPage } from "./startupSplit";
import { MIN_PAIRS } from "./verdict";
import {
  DIAGNOSE_TRACE_CATEGORIES,
  TRACE_CATEGORIES,
  type TraceEvent,
  type WorkSplit,
  findTraceMark,
  workSplit,
  workSplitRange,
} from "./workSplit";

const WINDOW_MS = 3000;

const HELP = `raft-perf ab — two local builds of the web compared pair-by-pair on a deployed non-production origin

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --base <dir>          build output of the web as it is (packages/web/dist of base commit)
  --pr <dir>            build output with the change
  --scenario <kind>     switch | startup (default switch)
  --mode <mode>         for --scenario startup: reopen | new-device (default reopen)
  --loads <n>           for --scenario startup: measured loads per visit (default 1)
  --origin <url>        web origin the builds are served into (default https://raft-app-staging.botiverse.dev)
  --api <url>           API origin (default https://api-aws-staging.botiverse.dev)
  --fixture <name>      frozen benchmark fixture (e.g. bench-v1, or path to JSON): sets --server/--channel/--other
                        and verifies the channel's message/thread digest before comparing
  --server <slug>       server slug (required unless --fixture sets it)
  --channel <name>      target channel (required unless --fixture sets it)
  --other <name>        for --scenario switch: channel switched from (default all, or fixture's secondary channel)
  --pairs <n>           pairs of visits, the arms alternating (default 6: fewer cannot settle a verdict)
  --switches <n>        for --scenario switch: switches into the channel per visit (default 3)
  --cpu <n>             slow the page's CPU n times on both arms (1 to 20; default 1)
  --replay              freeze GET /api/* responses via a warm snapshot so network jitter between arms is zero
  --replay-file <file>  load an existing API replay snapshot (or save the newly captured one here with --replay)
  --keep-busy           keep pairs taken while the host was busy
  --out <file>          also write the JSON here
  --chromium-arg <a>    extra Chromium switch (repeatable)
Production origins are refused: the builds would run against real accounts.
`;

/** A socket to a production host (the hosts of `isProductionHost`, src/page.ts). */
export const PRODUCTION_SOCKET = /^wss?:\/\/([^/?#@]*\.)?raft\.build\.?(:\d+)?([/?#]|$)/i;

class AbError extends Error {}
const fail = (message: string): never => {
  throw new AbError(message);
};

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
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

type Arm = "base" | "pr";

const installStartupTimingProbe = () => {
  const w = window as unknown as {
    __abStartup?: {
      anchorNow: number;
      row: number | null;
      painted: number | null;
      longTasks: Array<{ start: number; ms: number }>;
    };
  };
  performance.setResourceTimingBufferSize(20_000);
  performance.mark("__raft_perf_anchor");
  const anchorNow = performance.now();
  w.__abStartup = { anchorNow, row: null, painted: null, longTasks: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__abStartup?.longTasks.push({ start: entry.startTime, ms: entry.duration });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* ignore */
  }
  new MutationObserver(() => {
    const st = w.__abStartup;
    if (!st || st.row != null) return;
    if (!document.querySelector("[data-testid=message-scroller] [data-message-item], [data-testid=message-scroller] [data-message-id]")) return;
    st.row = performance.now();
    requestAnimationFrame(() =>
      setTimeout(() => {
        if (w.__abStartup && w.__abStartup.painted == null) {
          w.__abStartup.painted = performance.now();
        }
      }, 0),
    );
  }).observe(document, { childList: true, subtree: true });
};

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      base: { type: "string" },
      pr: { type: "string" },
      scenario: { type: "string", default: "switch" },
      mode: { type: "string", default: "reopen" },
      loads: { type: "string", default: "1" },
      origin: { type: "string", default: "https://raft-app-staging.botiverse.dev" },
      api: { type: "string", default: "https://api-aws-staging.botiverse.dev" },
      fixture: { type: "string" },
      server: { type: "string" },
      channel: { type: "string" },
      other: { type: "string" },
      pairs: { type: "string", default: "6" },
      switches: { type: "string", default: "3" },
      cpu: { type: "string", default: "1" },
      replay: { type: "boolean", default: false },
      "replay-file": { type: "string" },
      "keep-busy": { type: "boolean", default: false },
      out: { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  });
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const scenario = args.scenario as "switch" | "startup";
  if (scenario !== "switch" && scenario !== "startup") fail("--scenario must be switch or startup");
  const startupMode = args.mode as "reopen" | "new-device";
  if (startupMode !== "reopen" && startupMode !== "new-device") fail("--mode must be reopen or new-device");

  // the browser compares origins in their canonical form: `https://Host:443/` must still match
  const canonical = (url: string, flag: string) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    return parsed && /^https?:$/.test(parsed.protocol) ? parsed.origin : fail(`${flag} must be an http(s) URL`);
  };
  const origin = canonical(args.origin!, "--origin");
  const api = canonical(args.api!, "--api");
  const pairs = Number(args.pairs);
  const switches = Number(args.switches);
  const loadsPerVisit = Number(args.loads);
  const cpu = Number(args.cpu);
  if (!Number.isFinite(cpu) || cpu < 1 || cpu > 20) fail("--cpu must be a number from 1 to 20");

  const fixtureSpec = (() => {
    try {
      return args.fixture ? loadBenchFixture(args.fixture) : null;
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  const resolved = (() => {
    try {
      return resolveFixtureTargets(fixtureSpec, { server: args.server, channel: args.channel, other: args.other }, { channel: "", other: "all" });
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  if (!resolved.server) fail("--server <slug> (or --fixture <name>) is required");
  if (!resolved.channel) fail("--channel <name> (or --fixture <name>) is required");
  if (!Number.isInteger(pairs) || pairs < 1) fail("--pairs must be an integer of at least 1");
  if (scenario === "switch" && (!Number.isInteger(switches) || switches < 1)) fail("--switches must be an integer of at least 1");
  if (scenario === "startup" && (!Number.isInteger(loadsPerVisit) || loadsPerVisit < 1)) fail("--loads must be an integer of at least 1");

  const dirs = {} as Record<Arm, string>;
  for (const arm of ["base", "pr"] as const) {
    const dir = args[arm] ? path.resolve(args[arm]!) : fail(`--${arm} <dir> is required (a build output of the web)`);
    if (!existsSync(path.join(dir, "index.html"))) fail(`--${arm} ${dir} has no index.html: it is not a build output of the web`);
    dirs[arm] = dir;
  }
  if (dirs.base === dirs.pr) fail("--base and --pr are the same directory");
  if (isProductionHost(origin) || isProductionHost(api)) fail("refusing a production origin or API: a local build would run against real accounts");
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
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === resolved.server) ?? fail(`the account is not a member of server ${resolved.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as Named[] | { channels: Named[] };
  const list = Array.isArray(channels) ? channels : channels.channels;
  const busy = list.find((c) => c.name === resolved.channel) ?? fail(`no channel ${resolved.channel} in ${resolved.server}`);
  const other =
    scenario === "switch"
      ? (list.find((c) => c.name === resolved.other) ?? fail(`no channel ${resolved.other} in ${resolved.server}`))
      : null;
  if (scenario === "switch" && other && busy.id === other.id) fail("--channel and --other must differ");

  let verifiedFixtureTag: string | null = null;
  if (fixtureSpec) {
    const check = await fetchAndVerifyFixture(api, session.accessToken!, server.id, busy.id, fixtureSpec).catch((error: Error) => fail(error.message));
    if (!check.ok) fail(`fixture ${fixtureSpec.fixture} drifted (${check.mismatches.join("; ")}): refusing to measure`);
    verifiedFixtureTag = check.tag;
  }

  const warnings: string[] = [];
  const warn = (text: string) => void (warnings.includes(text) || warnings.push(text));

  const replayEnabled = Boolean(args.replay || args["replay-file"]);
  let replayStore: ApiReplayStore | null = null;
  if (args["replay-file"] && existsSync(args["replay-file"])) {
    const loaded = (() => {
      try {
        return ApiReplayStore.loadFromFile(args["replay-file"]!);
      } catch (error) {
        return fail((error as Error).message);
      }
    })();
    const validation = loaded.validateAgainst({
      apiOrigin: api,
      serverSlug: server.slug,
      channelName: busy.name,
      fixtureTag: verifiedFixtureTag,
      accountEmail: email!,
    });
    if (validation.errors.length > 0) {
      fail(`--replay-file ${args["replay-file"]} does not match this run: ${validation.errors.join("; ")}`);
    }
    for (const w of validation.warnings) warn(w);
    replayStore = loaded;
  } else if (replayEnabled) {
    replayStore = new ApiReplayStore({
      apiOrigin: api,
      serverSlug: server.slug,
      channelName: busy.name,
      fixtureTag: verifiedFixtureTag,
      accountHint: hashAccountHint(email!),
    });
  }

  const setupProtectedContext = async (browser: Browser): Promise<{ context: BrowserContext; checkLeakedProd: () => string | null }> => {
    let production: string | null = null;
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
    await context.route(
      (url) => isProductionHost(url.href),
      (route) => {
        if (["fetch", "xhr", "eventsource"].includes(route.request().resourceType())) production ??= new URL(route.request().url()).host;
        return route.abort();
      },
    );
    await context.routeWebSocket(PRODUCTION_SOCKET, (socket) => {
      production ??= new URL(socket.url()).host;
      return socket.close();
    });
    return { context, checkLeakedProd: () => production };
  };

  interface VisitCounters {
    servedLocally: number;
    fromNetwork: number;
    replayedApi: number;
    replayMisses: number;
    criticalReplayMisses: number;
    missedRoutes: Record<string, number>;
  }
  const emptyCounters = (): VisitCounters => ({
    servedLocally: 0,
    fromNetwork: 0,
    replayedApi: 0,
    replayMisses: 0,
    criticalReplayMisses: 0,
    missedRoutes: {},
  });

  const attachBuildAndReplayRoutes = async (
    tab: Page,
    dir: string,
    mode: "capture" | "replay" | "live",
    counters: VisitCounters,
  ) => {
    if (mode !== "live" && replayStore) {
      await tab.route(
        (url) => url.origin === api && url.pathname.startsWith("/api/"),
        async (route) => {
          const req = route.request();
          const key = canonicalApiRequestKey(req.method(), req.url(), req.headers());
          if (!key) {
            counters.fromNetwork++;
            return route.continue();
          }
          if (mode === "replay") {
            const cached = replayStore!.lookup(key);
            if (cached) {
              counters.replayedApi++;
              return route.fulfill({
                status: cached.status,
                contentType: cached.contentType,
                headers: cached.headers,
                body: cached.body,
              });
            }
            // Freeze the snapshot during measured pairs so neither arm pays a one-off populate penalty on uncached/cursor keys.
            counters.replayMisses++;
            if (isFirstPage(endpointOf(req.url(), busy.id))) counters.criticalReplayMisses++;
            const shape = redactedApiRouteShape(req.url());
            counters.missedRoutes[shape] = (counters.missedRoutes[shape] ?? 0) + 1;
            counters.fromNetwork++;
            return route.continue();
          }
          counters.fromNetwork++;
          const response = await route.fetch();
          const body = await response.body();
          replayStore!.record(key, response.status(), response.headers(), body);
          return route.fulfill({ response, body });
        },
      );
    }

    await tab.route(
      (url) => url.origin === origin,
      async (route) => {
        const request = route.request();
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(request.url()).pathname);
        } catch {
          counters.fromNetwork++;
          return route.continue();
        }
        // Do not serve `.map` files into the page; let same-origin `/api` & `/socket.io` fall through
        if (request.method() !== "GET" || pathname.endsWith(".map") || /^\/(api|socket\.io)(\/|$)/.test(pathname)) {
          counters.fromNetwork++;
          return route.continue();
        }
        let file = path.join(dir, pathname);
        const isFile = file.startsWith(dir + path.sep) && existsSync(file) && statSync(file).isFile();
        if (!isFile) {
          if (request.resourceType() !== "document") {
            counters.fromNetwork++;
            return route.continue();
          }
          file = path.join(dir, "index.html");
        }
        counters.servedLocally++;
        return route.fulfill({
          status: 200,
          contentType: TYPES[path.extname(file)] ?? "application/octet-stream",
          body: readFileSync(file),
        });
      },
    );
  };

  /** Capture a warm API snapshot across BOTH builds (cold + reopen in the same context) before pair 1 so reopen sync routes are pre-cached too. */
  const captureInitialReplay = async (browser: Browser) => {
    if (!replayStore || replayStore.size > 0) return;
    for (const arm of ["base", "pr"] as const) {
      const { context, checkLeakedProd } = await setupProtectedContext(browser);
      const counters = emptyCounters();
      try {
        const passes = scenario === "startup" && startupMode === "reopen" ? 2 : 1;
        for (let p = 0; p < passes; p++) {
          const tab = await context.newPage();
          await attachBuildAndReplayRoutes(tab, dirs[arm], "capture", counters);
          await tab.goto(`${origin}/s/${server.slug}/channel/${busy.id}`, { waitUntil: "load", timeout: 120_000 });
          await tab.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
          await tab.waitForTimeout(2500);
          await tab.close();
        }
      } finally {
        await context.close().catch(() => {});
        const leaked = checkLeakedProd();
        if (leaked) fail(`${arm}: the build in ${dirs[arm]} talks to production (${leaked})`);
      }
    }
    if (args["replay-file"]) replayStore.saveToFile(args["replay-file"]);
  };

  if (scenario === "startup") {
    const apiHost = new URL(api).host;

    const visitStartup = async (
      browser: Browser,
      arm: Arm,
    ): Promise<StartupArmVisit & { commitSha: string | null; servedLocally: number | null; fromNetwork: number; replayedApi: number; replayMisses: number; criticalReplayMisses: number; missedRoutes: Record<string, number> }> => {
      const dir = dirs[arm];
      const counters = emptyCounters();
      const samples: StartupSample[] = [];
      let commitSha: string | null = null;
      const routeMode = replayStore ? "replay" : "live";

      const runMeasuredLoad = async (context: BrowserContext): Promise<StartupSample | null> => {
        const tab = await context.newPage();
        const cdp = await context.newCDPSession(tab);
        try {
          if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
          await attachBuildAndReplayRoutes(tab, dir, routeMode, counters);
          await tab.addInitScript(installStartupTimingProbe);
          await browser.startTracing(tab, { categories: DIAGNOSE_TRACE_CATEGORIES });
          let traceBuf: Buffer | null = null;
          try {
            await tab.goto(`${origin}/s/${server.slug}/channel/${busy.id}`, { waitUntil: "load", timeout: 120_000 });
            const shown = await tab
              .locator("[data-testid=message-scroller] [data-message-item], [data-testid=message-scroller] [data-message-id]")
              .first()
              .waitFor({ timeout: 60_000 })
              .then(() => true, () => false);
            if (counters.servedLocally === 0) fail(`${arm}: the page loaded nothing from ${dir}`);
            if (!shown) throw new Error(`the message list did not appear (was ${dir} built with VITE_API_URL=${api}?)`);
            // Wait until `painted` timestamp is recorded plus a brief margin for trace flush
            for (let w = 0; w < 20; w++) {
              const p = await tab.evaluate(() => (window as unknown as { __abStartup?: { painted: number | null } }).__abStartup?.painted ?? null);
              if (p != null) break;
              await tab.waitForTimeout(50);
            }
            await tab.waitForTimeout(250);
          } finally {
            traceBuf = await browser.stopTracing().catch(() => null);
          }

          const state = await tab.evaluate(
            ({ host }) => {
              const w = window as unknown as {
                __abStartup?: { anchorNow: number; row: number | null; painted: number | null; longTasks: Array<{ start: number; ms: number }> };
              };
              const entries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
                .filter((r) => new URL(r.name).host === host && new URL(r.name).pathname.startsWith("/api/"))
                .map((r) => ({ url: r.name, end: r.responseEnd }));
              let sha: string | null = null;
              try {
                sha = (JSON.parse(document.getElementById("raft-frontend-release-identity")?.textContent ?? "{}").commitSha as string | undefined) ?? null;
              } catch {
                sha = null;
              }
              return {
                anchorNow: w.__abStartup?.anchorNow ?? 0,
                row: w.__abStartup?.row ?? null,
                painted: w.__abStartup?.painted ?? null,
                longTasks: w.__abStartup?.longTasks ?? [],
                entries,
                commitSha: sha,
              };
            },
            { host: apiHost },
          );
          commitSha ??= state.commitSha;
          if (state.painted == null || state.row == null) {
            warn(`${arm}: a startup load did not record a message paint timestamp and was not counted`);
            return null;
          }

          const firstPageEntry = state.entries.find((e) => isFirstPage(endpointOf(e.url, busy.id)));
          const messagesEndMs = firstPageEntry ? Math.round(firstPageEntry.end * 10) / 10 : null;
          const paintedMs = Math.round(state.painted * 10) / 10;
          const rowMs = Math.round(state.row * 10) / 10;
          const responseToPaintMs =
            messagesEndMs != null && paintedMs >= messagesEndMs ? Math.round((paintedMs - messagesEndMs) * 10) / 10 : null;
          const rtpFrom = messagesEndMs != null && messagesEndMs <= paintedMs ? messagesEndMs : 0;
          const longTasksMs =
            Math.round(
              state.longTasks
                .reduce((acc, t) => acc + Math.max(0, Math.min(t.start + t.ms, paintedMs) - Math.max(t.start, rtpFrom)), 0) * 10,
            ) / 10;

          let split: WorkSplit | null = null;
          if (traceBuf) {
            try {
              const events = (JSON.parse(traceBuf.toString("utf8")) as { traceEvents?: TraceEvent[] }).traceEvents ?? [];
              const anchor = findTraceMark(events, "__raft_perf_anchor");
              if (anchor) {
                const toUs = (ms: number) => Math.round(anchor.ts + (ms - state.anchorNow) * 1000);
                split = workSplitRange(events, anchor.pid, anchor.tid, toUs(rtpFrom), toUs(paintedMs));
              }
            } catch {
              split = null;
            }
          }
          return { paintedMs, rowMs, messagesEndMs, responseToPaintMs, longTasksMs, split };
        } finally {
          await cdp.detach().catch(() => {});
          await tab.close().catch(() => {});
        }
      };

      if (startupMode === "reopen") {
        const { context, checkLeakedProd } = await setupProtectedContext(browser);
        try {
          // Warm load in this context first
          const warm = await context.newPage();
          await attachBuildAndReplayRoutes(warm, dir, routeMode, counters);
          await warm.goto(`${origin}/s/${server.slug}/channel/${busy.id}`, { waitUntil: "load", timeout: 120_000 });
          const warmShown = await warm.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false);
          if (counters.servedLocally === 0) fail(`${arm}: the page loaded nothing from ${dir}`);
          if (!warmShown) throw new Error(`the message list did not appear (was ${dir} built with VITE_API_URL=${api}?)`);
          await warm.waitForTimeout(2500);
          await warm.close();
          counters.servedLocally = 0;
          counters.fromNetwork = 0;
          counters.replayedApi = 0;
          counters.replayMisses = 0;
          counters.criticalReplayMisses = 0;
          counters.missedRoutes = {};

          for (let l = 0; l < loadsPerVisit; l++) {
            const s = await runMeasuredLoad(context);
            if (s) samples.push(s);
          }
        } finally {
          await context.close().catch(() => {});
          const leaked = checkLeakedProd();
          if (leaked) fail(`${arm}: the build in ${dir} talks to production (${leaked}); build it with VITE_API_URL=${api}`);
        }
      } else {
        for (let l = 0; l < loadsPerVisit; l++) {
          const { context, checkLeakedProd } = await setupProtectedContext(browser);
          try {
            const s = await runMeasuredLoad(context);
            if (s) samples.push(s);
          } finally {
            await context.close().catch(() => {});
            const leaked = checkLeakedProd();
            if (leaked) fail(`${arm}: the build in ${dir} talks to production (${leaked}); build it with VITE_API_URL=${api}`);
          }
        }
      }
      return { samples, commitSha, ...counters };
    };

    const taken: Record<Arm, StartupArmVisit[]> = { base: [], pr: [] };
    const host: Record<Arm, HostSample[]> = { base: [], pr: [] };
    const commits: Record<Arm, Set<string | null>> = { base: new Set(), pr: new Set() };
    const served: Record<
      Arm,
      Array<{
        servedLocally: number | null;
        fromNetwork: number;
        replayedApi: number;
        replayMisses: number;
        criticalReplayMisses: number;
        missedRoutes: Record<string, number>;
      }>
    > = { base: [], pr: [] };
    const browser = await chromium.launch({ args: args["chromium-arg"] });
    let deviceProbe: BrowserDeviceProbe | null = null;
    try {
      deviceProbe = await probeBrowserDevice(browser);
      await captureInitialReplay(browser);
      hostBenchmark();
      for (let pair = 0; pair < pairs; pair++) {
        for (const arm of pair % 2 ? (["pr", "base"] as const) : (["base", "pr"] as const)) {
          const before = { benchMs: hostBenchmark(), pressure: readPressure(), at: Date.now() };
          const seen = await visitStartup(browser, arm).catch((error: unknown) => {
            if (error instanceof AbError) throw error;
            const reason = (error as Error)?.message?.split("\n")[0] ?? String(error);
            if (taken[arm].length === 0) fail(`${arm}: the first visit failed: ${reason}`);
            process.stderr.write(`pair ${pair + 1}/${pairs} ${arm}: the visit failed: ${reason}\n`);
            warn(`a ${arm} visit failed and its pair is not counted: ${reason}`);
            return {
              samples: [] as StartupSample[],
              commitSha: null,
              servedLocally: null,
              fromNetwork: 0,
              replayedApi: 0,
              replayMisses: 0,
              criticalReplayMisses: 0,
              missedRoutes: {},
            };
          });
          host[arm].push({ ...stallShares(before.pressure, readPressure(), Date.now() - before.at), benchMs: Math.max(before.benchMs, hostBenchmark()) });
          taken[arm].push({ samples: seen.samples });
          if (seen.servedLocally != null) commits[arm].add(seen.commitSha);
          served[arm].push({
            servedLocally: seen.servedLocally,
            fromNetwork: seen.fromNetwork,
            replayedApi: seen.replayedApi,
            replayMisses: seen.replayMisses,
            criticalReplayMisses: seen.criticalReplayMisses,
            missedRoutes: seen.missedRoutes,
          });
          if (seen.servedLocally != null) {
            process.stderr.write(
              `pair ${pair + 1}/${pairs} ${arm}: ${seen.samples.length}/${loadsPerVisit} startup load(s), ${seen.servedLocally} files from build` +
                (replayStore ? `, ${seen.replayedApi} replayed API call(s)${seen.replayMisses ? ` (${seen.replayMisses} miss)` : ""}` : "") +
                "\n",
            );
          }
        }
      }
    } finally {
      await browser.close();
    }

    const hostSeen = busyPairs(host.pr, host.base);
    const dropped = args["keep-busy"] ? [] : hostSeen.dropped;
    const comparison = compareStartupArms(taken.base, taken.pr, dropped);
    const notes: string[] = [];
    const replayMissTotals = {
      base: served.base.reduce((acc, s) => acc + s.replayMisses, 0),
      pr: served.pr.reduce((acc, s) => acc + s.replayMisses, 0),
    };
    const mergeMissedRoutes = (arm: Arm): Record<string, number> => {
      const merged: Record<string, number> = {};
      for (const s of served[arm]) {
        for (const [route, count] of Object.entries(s.missedRoutes)) {
          merged[route] = (merged[route] ?? 0) + count;
        }
      }
      return merged;
    };
    const missedRoutesByArm = { base: mergeMissedRoutes("base"), pr: mergeMissedRoutes("pr") };
    const criticalMissTotal =
      served.base.reduce((acc, s) => acc + s.criticalReplayMisses, 0) +
      served.pr.reduce((acc, s) => acc + s.criticalReplayMisses, 0);
    if (replayStore) {
      notes.push(`GET /api/* responses were replayed from a frozen ${replayStore.size}-route snapshot (--replay)`);
      const missEval = evaluateReplayMisses({
        baseMisses: replayMissTotals.base,
        prMisses: replayMissTotals.pr,
        criticalMisses: criticalMissTotal,
        pairs: comparison.pairs || pairs,
      });
      if (missEval.reason) {
        const routeNames = [...new Set([...Object.keys(missedRoutesByArm.base), ...Object.keys(missedRoutesByArm.pr)])].sort();
        const detail = `${missEval.reason}${routeNames.length ? ` [${routeNames.join(", ")}]` : ""}`;
        if (missEval.fatal) warn(detail);
        else notes.push(detail);
      }
    }
    if (cpu > 1) notes.push(`both arms ran with ${cpu}x CPU slowdown (--cpu ${cpu})`);
    if (hostSeen.dropped.length) {
      notes.push(`pair(s) ${hostSeen.dropped.map((i) => i + 1).join(", ")} ${args["keep-busy"] ? "taken on a busy host (kept: --keep-busy)" : `left out: the host was busy (by ${hostSeen.by})`}`);
    }
    const tilted = lopsided(hostSeen.busyOn, hostSeen.busyOff);
    if (tilted) {
      warn(`the busy visits fall mostly on the ${tilted === "on" ? "pr" : "base"} arm: run again with --keep-busy and compare`);
    }
    if (comparison.pairs < MIN_PAIRS) warn(`${comparison.pairs} complete pair(s): fewer than ${MIN_PAIRS} cannot be judged`);
    const commitOf = (arm: Arm) => [...commits[arm]];
    for (const arm of ["base", "pr"] as const) if (commits[arm].size > 1) warn(`${arm}: the page named different commits across visits`);
    const cpus = availableParallelism();
    const cohort = buildCohort({
      browserWhere: "local",
      hostCpuCount: cpus,
      hostBenchmarkMs: hostSeen.benchmarkMedianMs,
      device: deviceProbe,
      cpuSlowdown: cpu,
      net: cpu > 1 ? "throttled" : "fast",
      fixture: verifiedFixtureTag,
    });
    const report = {
      tool: "raft-perf ab",
      scenario: "startup" as const,
      mode: startupMode,
      replay: replayStore
        ? { enabled: true, routes: replayStore.size, misses: replayMissTotals, criticalMisses: criticalMissTotal, missedRoutes: missedRoutesByArm }
        : { enabled: false, routes: 0, misses: { base: 0, pr: 0 }, criticalMisses: 0, missedRoutes: { base: {}, pr: {} } },
      measuredAt: new Date().toISOString(),
      origin,
      page: { server: server.slug, channel: busy.name },
      cohort,
      builds: {
        base: { dir: dirs.base, commitSha: commitOf("base")[0] ?? null },
        pr: { dir: dirs.pr, commitSha: commitOf("pr")[0] ?? null },
      },
      requestedPairs: pairs,
      loadsPerVisit,
      ...comparison,
      warnings,
      notes,
      host: { by: hostSeen.by, cpus, benchmarkMedianMs: hostSeen.benchmarkMedianMs, busyPairs: hostSeen.dropped.map((i) => i + 1), leftOut: !args["keep-busy"] },
      visits: {
        base: taken.base.map((v, i) => ({ ...served.base[i]!, samples: v.samples })),
        pr: taken.pr.map((v, i) => ({ ...served.pr[i]!, samples: v.samples })),
      },
    };
    const text = JSON.stringify(report, null, 2);
    process.stdout.write(`${text}\n`);
    if (args.out) writeFileSync(args.out, `${text}\n`);
    const tenth = (v: number | null) => (v == null ? "-" : Math.round(v * 10) / 10);
    process.stderr.write(`raft-perf ab startup (${startupMode}, cpu=${cpu}x${replayStore ? ", replay" : ""}) #${busy.name}, ${comparison.pairs} pair(s) (base -> pr):\n`);
    for (const [name, m] of Object.entries(comparison.timings)) {
      process.stderr.write(`  ${name.padEnd(18)} ${tenth(m.medianOff)} -> ${tenth(m.medianOn)} ms  ${m.verdict} (${m.confidence}): ${m.reason}\n`);
    }
    for (const [name, c] of Object.entries(comparison.counts)) {
      process.stderr.write(`  ${name.padEnd(18)} ${c.base} -> ${c.pr}${c.everyPairLower ? "  lower in every pair" : c.everyPairHigher ? "  higher in every pair" : ""}\n`);
    }
    if (warnings.length) process.stderr.write(`  ${warnings.length} warning(s): ${warnings.join("; ")}\n`);
    return warnings.length ? 2 : 0;
  }

  /** `--scenario switch` (default): a fresh signed-in tab per visit, then `switches` traced clicks into `busy`. */
  const visit = async (browser: Browser, arm: Arm): Promise<ArmVisit & { commitSha: string | null; servedLocally: number | null; fromNetwork: number }> => {
    const dir = dirs[arm];
    const counters = emptyCounters();
    const { context, checkLeakedProd } = await setupProtectedContext(browser);
    try {
      const tab = await context.newPage();
      const cdp = await context.newCDPSession(tab);
      if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
      await attachBuildAndReplayRoutes(tab, dir, replayStore ? "replay" : "live", counters);
      await tab.goto(`${origin}/s/${server.slug}/channel/${busy.id}`, { waitUntil: "load", timeout: 120_000 });
      const shown = await tab.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false);
      if (counters.servedLocally === 0) fail(`${arm}: the page loaded nothing from ${dir}`);
      if (!shown) throw new Error(`the message list did not appear (was ${dir} built with VITE_API_URL=${api}?)`);
      await tab.waitForTimeout(6000);
      const commitSha = await tab.evaluate(() => {
        try {
          return (JSON.parse(document.getElementById("raft-frontend-release-identity")?.textContent ?? "{}").commitSha as string | undefined) ?? null;
        } catch {
          return null;
        }
      });
      const inSidebar = (channel: Named) => tab.locator("[data-testid=sidebar-root]").getByText(channel.name, { exact: true }).first();
      const splits: WorkSplit[] = [];
      for (let i = 0; i < switches; i++) {
        await inSidebar(other!).click({ timeout: 10_000 });
        await tab.waitForTimeout(2500);
        await browser.startTracing(tab, { categories: TRACE_CATEGORIES });
        let trace: Buffer;
        try {
          await inSidebar(busy).click({ timeout: 10_000 });
          await tab.waitForTimeout(WINDOW_MS + 200);
        } finally {
          trace = await browser.stopTracing();
        }
        const arrived = await tab.evaluate(
          (id) => location.pathname.endsWith(id) && document.querySelector("[data-testid=message-scroller] [data-testid^=message-sender-tail]") != null,
          busy.id,
        );
        const split = arrived ? workSplit((JSON.parse(trace.toString()) as { traceEvents: TraceEvent[] }).traceEvents, WINDOW_MS) : null;
        if (!arrived) warn(`a switch did not show #${busy.name} within ${WINDOW_MS / 1000} s: it is not counted`);
        else if (!split) warn("a trace held no click event: that switch is not counted");
        else if (split.recordedMs < WINDOW_MS) warn("a trace stopped early: that switch is not counted");
        else splits.push(split);
      }
      await cdp.detach().catch(() => {});
      return { splits, commitSha, servedLocally: counters.servedLocally, fromNetwork: counters.fromNetwork };
    } finally {
      await context.close().catch(() => undefined);
      const production = checkLeakedProd();
      if (production) fail(`${arm}: the build in ${dir} talks to production (${production}); build it with VITE_API_URL set to the API of ${origin}`);
    }
  };

  const taken: Record<Arm, ArmVisit[]> = { base: [], pr: [] };
  const host: Record<Arm, HostSample[]> = { base: [], pr: [] };
  const commits: Record<Arm, Set<string | null>> = { base: new Set(), pr: new Set() };
  const served: Record<Arm, Array<{ servedLocally: number | null; fromNetwork: number }>> = { base: [], pr: [] };
  const browser = await chromium.launch({ args: args["chromium-arg"] });
  let deviceProbe: BrowserDeviceProbe | null = null;
  try {
    deviceProbe = await probeBrowserDevice(browser);
    await captureInitialReplay(browser);
    hostBenchmark();
    for (let pair = 0; pair < pairs; pair++) {
      for (const arm of pair % 2 ? (["pr", "base"] as const) : (["base", "pr"] as const)) {
        const before = { benchMs: hostBenchmark(), pressure: readPressure(), at: Date.now() };
        const seen = await visit(browser, arm).catch((error: unknown) => {
          if (error instanceof AbError) throw error;
          const reason = (error as Error)?.message?.split("\n")[0] ?? String(error);
          if (taken[arm].length === 0) fail(`${arm}: the first visit failed: ${reason}`);
          process.stderr.write(`pair ${pair + 1}/${pairs} ${arm}: the visit failed: ${reason}\n`);
          warn(`a ${arm} visit failed and its pair is not counted: ${reason}`);
          return { splits: [] as WorkSplit[], commitSha: null, servedLocally: null, fromNetwork: 0 };
        });
        host[arm].push({ ...stallShares(before.pressure, readPressure(), Date.now() - before.at), benchMs: Math.max(before.benchMs, hostBenchmark()) });
        taken[arm].push({ splits: seen.splits });
        if (seen.servedLocally != null) commits[arm].add(seen.commitSha);
        served[arm].push({ servedLocally: seen.servedLocally, fromNetwork: seen.fromNetwork });
        if (seen.servedLocally != null) process.stderr.write(`pair ${pair + 1}/${pairs} ${arm}: ${seen.splits.length}/${switches} switches, ${seen.servedLocally} files from the build\n`);
      }
    }
  } finally {
    await browser.close();
  }

  const hostSeen = busyPairs(host.pr, host.base);
  const dropped = args["keep-busy"] ? [] : hostSeen.dropped;
  const comparison = compareArms(taken.base, taken.pr, dropped);
  const notes: string[] = [];
  if (cpu > 1) notes.push(`both arms ran with ${cpu}x CPU slowdown (--cpu ${cpu})`);
  if (hostSeen.dropped.length) notes.push(`pair(s) ${hostSeen.dropped.map((i) => i + 1).join(", ")} ${args["keep-busy"] ? "taken on a busy host (kept: --keep-busy)" : `left out: the host was busy (by ${hostSeen.by})`}`);
  const tilted = lopsided(hostSeen.busyOn, hostSeen.busyOff);
  if (tilted) warn(`the busy visits fall mostly on the ${tilted === "on" ? "pr" : "base"} arm: the heavier build may be flagging itself, and leaving its pairs out ${args["keep-busy"] ? "would tilt the result (they were kept)" : "tilts the result (run again with --keep-busy and compare)"}`);
  if (comparison.pairs < MIN_PAIRS) warn(`${comparison.pairs} complete pair(s): fewer than ${MIN_PAIRS} cannot be judged`);
  const commitOf = (arm: Arm) => [...commits[arm]];
  for (const arm of ["base", "pr"] as const) if (commits[arm].size > 1) warn(`${arm}: the page named different commits across visits`);
  const cpus = availableParallelism();
  const cohort = buildCohort({
    browserWhere: "local",
    hostCpuCount: cpus,
    hostBenchmarkMs: hostSeen.benchmarkMedianMs,
    device: deviceProbe,
    cpuSlowdown: cpu,
    net: cpu > 1 ? "throttled" : "fast",
    fixture: verifiedFixtureTag,
  });
  const report = {
    tool: "raft-perf ab",
    scenario: "switch" as const,
    measuredAt: new Date().toISOString(),
    origin,
    page: { server: server.slug, channel: busy.name, other: other!.name },
    cohort,
    builds: { base: { dir: dirs.base, commitSha: commitOf("base")[0] ?? null }, pr: { dir: dirs.pr, commitSha: commitOf("pr")[0] ?? null } },
    requestedPairs: pairs,
    switchesPerVisit: switches,
    windowMs: WINDOW_MS,
    ...comparison,
    warnings,
    notes,
    host: { by: hostSeen.by, cpus, benchmarkMedianMs: hostSeen.benchmarkMedianMs, busyPairs: hostSeen.dropped.map((i) => i + 1), leftOut: !args["keep-busy"] },
    visits: { base: taken.base.map((v, i) => ({ ...served.base[i]!, splits: v.splits })), pr: taken.pr.map((v, i) => ({ ...served.pr[i]!, splits: v.splits })) },
  };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  const tenth = (v: number | null) => (v == null ? "-" : Math.round(v * 10) / 10);
  process.stderr.write(`raft-perf ab #${busy.name}, ${comparison.pairs} pair(s), ${WINDOW_MS / 1000} s after the press (base -> pr):\n`);
  for (const [name, m] of Object.entries(comparison.timings)) process.stderr.write(`  ${name.padEnd(9)} ${tenth(m.medianOff)} -> ${tenth(m.medianOn)} ms  ${m.verdict} (${m.confidence}): ${m.reason}\n`);
  for (const [name, c] of Object.entries(comparison.counts)) process.stderr.write(`  ${name.padEnd(17)} ${c.base} -> ${c.pr}${c.everyPairLower ? "  lower in every pair" : c.everyPairHigher ? "  higher in every pair" : ""}\n`);
  if (warnings.length) process.stderr.write(`  ${warnings.length} warning(s): ${warnings.join("; ")}\n`);
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf ab: ${error instanceof AbError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
