#!/usr/bin/env node
/**
 * Measure a signed-in page on a deployed web (staging by default) with a
 * paired on/off A/B, and print a JSON verdict an agent can act on.
 * docs/frontend/perf-measure.md is the guide; src/verdict.ts holds the
 * verdict rule.
 *
 *   RAFT_PERF_EMAIL=… RAFT_PERF_PASSWORD=… \
 *   pnpm --filter @botiverse/raft-perf measure -- \
 *     --server <slug> --channel <name> --entry channel --state release --net fast --runs 5
 *
 * Exit codes: 0 measured (any verdict), 1 `--fail-on-worse` and the verdict is
 * worse, 2 the measurement itself failed or is unknown (too few complete pairs).
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cliArgs } from "./args";
import { vitalsInitScript } from "./vitals";
import { type LoadMetrics, type PageRunRow, toPageRunRows } from "./pageRuns";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import process from "node:process";
import type { Browser, BrowserContext } from "playwright";
import { type HostSample, busyPairs, hostBenchmark, hostExtra, lopsided, readPressure, stallShares, withoutPairs } from "./hostHealth";
import { MIN_PAIRS_TO_SETTLE, overallVerdict, pairedVerdict } from "./verdict";
import type { MetricVerdict, Verdict } from "./verdict";
import { BrowserError, type OpenedBrowser, leftOutAsBusy, openBrowser, planBrowser } from "./browser";
import { fetchAndVerifyFixture } from "./benchCheck";
import { loadBenchFixture, resolveFixtureTargets } from "./benchFixture";
import { type BrowserDeviceProbe, buildCohort, dominantString, parseConnectRttMs, parseEdgeColo, parseServerTimingMs, probeBrowserDevice } from "./cohort";
import { bootContentMs, isProductionHost, withoutBootPrefetch } from "./page";

const HELP = `raft-perf measure — paired on/off page measurement with a JSON verdict

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --origin <url>      web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default: --origin; the web calls /api on its own origin)
  --fixture <name>    frozen benchmark fixture (e.g. bench-v1, or path to JSON): sets --server/--channel and verifies
                      its message/thread digest before measuring
  --server <slug>     server slug (required unless --fixture sets it)
  --channel <name>    channel the channel entry opens (default all, or the fixture's channel)
  --entry <e>         channel | root  (root = /s/<slug>, lands on the remembered or first channel)
  --state <s>         cold | release | repeat
                        cold    new browser context per load, no local data, HTTP cache off
                        release local data kept, HTTP cache off (first open after a deploy)
                        repeat  local data and HTTP cache kept
  --net <n>           fast | slow (slow: 150 ms RTT, 200 KB/s down, 4x CPU)
  --ab <name>         boot-prefetch | none (default boot-prefetch)
  --runs <n>          pairs (default 5, minimum 3)
  --max-runs <n>      keep adding pairs past --runs, up to this many, while the verdict is not settled
                      (pairs taken while the host was busy are left out of the verdict, so they are made up for)
  --keep-busy         keep pairs taken while the host was busy in the verdict (they are still reported)
                      (the report's "confidence"; six pairs is the least that can settle). Default: --runs, no extra pairs
  --settle <ms>       wait after load before reading metrics (default 8000 fast / 15000 slow)
  --chromium-arg <a>  extra Chromium switch (repeatable), e.g. a host's run marker
  --browser <where>   local | browser-run (default local). browser-run: a Chromium on Cloudflare Browser Run, driven from
                      here; needs RAFT_PERF_CF_ACCOUNT_ID and RAFT_PERF_CF_API_TOKEN. Each row carries its cohort
                      (browser_where, edge_colo, browser_benchmark_ms, connect_rtt_ms) so series stay apart
  --out <file>        also write the JSON here
  --jsonl <file>      also write one row per measured load (ScopeDB perf.page_runs); needs --project
  --project <name>    with --jsonl: the product this web belongs to (e.g. raft-web)
  --env <env>         with --jsonl: overrides the environment read from the page
  --run-id <id>       with --jsonl: shared by every row of one collection (default: a new UUID)
  --fail-on-worse     exit 1 when the verdict is worse
  --allow-production  measure *.raft.build (signs in and opens pages: production writes)
`;

type Entry = "channel" | "root";
type State = "cold" | "release" | "repeat";
type Arm = "on" | "off";

/** One measured load (fields documented on LoadMetrics). */
type RunMetrics = LoadMetrics;

// Playwright wraps an init script in a function, so the IIFE's \`var webVitals\` is scoped to it, not global: the hook
// must stay in the same script (joined after a newline: the IIFE ends with a sourceMappingURL line comment).
const VITALS_HOOK = `;(() => {
  const v = (window.__perfVitals = {});
  const keep = (name) => (m) => { v[name] = m.value; };
  const all = { reportAllChanges: true };
  webVitals.onLCP(keep("lcp"), all); webVitals.onCLS(keep("cls"), all); webVitals.onFCP(keep("fcp"), all);
  webVitals.onTTFB(keep("ttfb"), all); webVitals.onINP(keep("inp"), all);
})();`;
const toolVersion = (): string => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

class MeasureError extends Error {}
const fail = (message: string): never => {
  throw new MeasureError(message);
};

const TOKEN_REUSE_MS = 10 * 60_000; // access tokens live 15 min (a slow pair takes up to ~5 min); refresh tokens are never shared across contexts

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      origin: { type: "string", default: "https://raft-app-staging.botiverse.dev" },
      api: { type: "string" },
      fixture: { type: "string" },
      server: { type: "string" },
      channel: { type: "string" },
      entry: { type: "string", default: "channel" },
      state: { type: "string", default: "release" },
      net: { type: "string", default: "fast" },
      ab: { type: "string", default: "boot-prefetch" },
      runs: { type: "string", default: "5" },
      "max-runs": { type: "string" },
      "keep-busy": { type: "boolean" },
      settle: { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
      browser: { type: "string" },
      out: { type: "string" },
      jsonl: { type: "string" },
      project: { type: "string" },
      env: { type: "string" },
      "run-id": { type: "string" },
      "fail-on-worse": { type: "boolean", default: false },
      "allow-production": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const origin = args.origin!.replace(/\/$/, "");
  const api = (args.api ?? origin).replace(/\/$/, "");
  const entry = args.entry as Entry;
  const state = args.state as State;
  const net = args.net as "fast" | "slow";
  const ab = args.ab as "boot-prefetch" | "none";
  const runs = Number(args.runs);
  // refused before signing in: with --allow-production a sign-in is a production write
  const plan = planBrowser(args.browser, args["chromium-arg"], process.env);
  const where = plan.where;
  /** The browser is on another machine: what this host was doing beside a load says nothing about that load. */
  const remote = where !== "local";
  const fixtureSpec = (() => {
    try {
      return args.fixture ? loadBenchFixture(args.fixture) : null;
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  const resolved = (() => {
    try {
      return resolveFixtureTargets(fixtureSpec, { server: args.server, channel: args.channel }, { channel: "all" });
    } catch (error) {
      return fail((error as Error).message);
    }
  })();
  if (!resolved.server) fail("--server <slug> (or --fixture <name>) is required");
  if (!["channel", "root"].includes(entry)) fail(`--entry must be channel or root, not ${entry}`);
  if (!["cold", "release", "repeat"].includes(state)) fail(`--state must be cold, release or repeat, not ${state}`);
  if (!["fast", "slow"].includes(net)) fail(`--net must be fast or slow, not ${net}`);
  if (!["boot-prefetch", "none"].includes(ab)) fail(`--ab must be boot-prefetch or none, not ${ab}`);
  if (!Number.isInteger(runs) || runs < 3) fail("--runs must be an integer of at least 3");
  const maxRuns = args["max-runs"] === undefined ? runs : Number(args["max-runs"]);
  if (!Number.isInteger(maxRuns) || maxRuns < runs) fail("--max-runs must be an integer, --runs or more");
  if (args.jsonl && !args.project) fail("--jsonl needs --project (which product this web belongs to)");
  let production: boolean;
  try {
    production = isProductionHost(origin) || isProductionHost(api);
  } catch {
    return fail("--origin and --api must be URLs");
  }
  if (production && !args["allow-production"]) {
    fail("refusing a production origin or API without --allow-production (signing in and opening pages writes)");
  }
  const email = process.env.RAFT_PERF_EMAIL;
  const password = process.env.RAFT_PERF_PASSWORD;
  if (!email || !password) fail("set RAFT_PERF_EMAIL and RAFT_PERF_PASSWORD (a test account)");
  const settle = Number(args.settle ?? (net === "slow" ? 15000 : 8000));
  const bootTimingWait = Math.max(settle, 25000);

  async function json(url: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      return fail(`${init.method ?? "GET"} ${new URL(url).pathname} failed: ${(error as Error).message}`);
    }
    if (!response.ok) fail(`${init.method ?? "GET"} ${new URL(url).pathname} answered ${response.status}`);
    try {
      return await response.json();
    } catch {
      return fail(`${new URL(url).pathname} did not answer JSON`);
    }
  }

  /** A fresh session: each one is used by a single browser context, so no refresh token is ever shared. */
  async function signIn(): Promise<{ accessToken: string; refreshToken: string; at: number }> {
    const session = (await json(`${api}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })) as { accessToken?: string; refreshToken?: string };
    if (!session.accessToken || !session.refreshToken) fail("sign-in returned no tokens");
    return { accessToken: session.accessToken!, refreshToken: session.refreshToken!, at: Date.now() };
  }

  const first = await signIn();
  const auth = { authorization: `Bearer ${first.accessToken}` };
  const servers = (await json(`${api}/api/servers`, { headers: auth })) as Array<{ id: string; slug: string }> | { servers: Array<{ id: string; slug: string }> };
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === resolved.server) ?? fail(`the account is not a member of server ${resolved.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as
    | Array<{ id: string; name: string }>
    | { channels: Array<{ id: string; name: string }> };
  const channel = (Array.isArray(channels) ? channels : channels.channels).find((c) => c.name === resolved.channel) ?? fail(`no channel ${resolved.channel} in ${resolved.server}`);
  let verifiedFixtureTag: string | null = null;
  if (fixtureSpec) {
    const check = await fetchAndVerifyFixture(api, first.accessToken, server.id, channel.id, fixtureSpec).catch((error: Error) => fail(error.message));
    if (!check.ok) fail(`fixture ${fixtureSpec.fixture} drifted (${check.mismatches.join("; ")}): refusing to measure`);
    verifiedFixtureTag = check.tag;
  }
  const url = entry === "channel" ? `${origin}/s/${server.slug}/channel/${channel.id}` : `${origin}/s/${server.slug}`;
  const interceptDocument = ab !== "none";
  const edgeColos: string[] = [];
  const connectRtts: number[] = [];

  const storageState = (s: { accessToken: string; refreshToken: string }) => ({
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          { name: "slock_access_token", value: s.accessToken },
          { name: "slock_refresh_token", value: s.refreshToken },
        ],
      },
    ],
  });

  // A count of the fetch() calls made while the HTML parses (the inline boot script's reads; the app's
  // own requests are XHR, sent later), installed before any page script. The app empties the boot script's own list
  // as it adopts the answers, so the list cannot be read afterwards.
  const countBootFetches = () => {
    const counter = window as unknown as { __perfBootFetches: number };
    counter.__perfBootFetches = 0;
    const original = window.fetch;
    window.fetch = function (...a: Parameters<typeof fetch>) {
      if (document.readyState === "loading") counter.__perfBootFetches++;
      return original.apply(this, a);
    };
  };

  let browser: Browser | undefined;
  let vitalsScript: string;
  try {
    vitalsScript = vitalsInitScript(VITALS_HOOK);
  } catch (error) {
    return fail(`cannot load web-vitals' browser build: ${(error as Error).message}`);
  }
  /** The environment the page names (release identity); rows need one. */
  let pageEnv: string | undefined;
  const checkEnv = () => {
    if (args.jsonl && !args.env && !pageEnv) fail("the page names no environment; pass --env");
  };
  // Service workers are blocked in every state: requests a worker answers are invisible to routing and to the
  // page's CDP session, and its shell cache would turn "release" into a repeat visit (docs: Limits).
  const newContext = async (s: { accessToken: string; refreshToken: string }) =>
    browser!.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block", storageState: storageState(s) });

  async function load(context: BrowserContext, arm: Arm, cacheOff: boolean): Promise<RunMetrics> {
    const page = await context.newPage();
    try {
      await page.addInitScript(countBootFetches);
      await page.addInitScript({ content: vitalsScript });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: cacheOff });
      // When comparing boot-prefetch arms, both arms pause the document's response at the same point (only the off arm's
      // HTML is edited). With --ab none neither arm edits HTML, so the document streams natively without the 2-RTT CDP pause.
      if (interceptDocument) {
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${url}*`, resourceType: "Document", requestStage: "Response" }] });
        cdp.on("Fetch.requestPaused", (e) => {
          void (async () => {
            try {
              const status = e.responseStatusCode ?? 0;
              if (status < 200 || status >= 300) return void (await cdp.send("Fetch.continueRequest", { requestId: e.requestId }));
              const raw = await cdp.send("Fetch.getResponseBody", { requestId: e.requestId });
              const html = raw.base64Encoded ? Buffer.from(raw.body, "base64").toString("utf8") : raw.body;
              const body = ab === "boot-prefetch" && arm === "off" ? withoutBootPrefetch(html) : html;
              const responseHeaders = (e.responseHeaders ?? []).filter((h) => !/^(content-length|content-encoding)$/i.test(h.name));
              await cdp.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: status, responseHeaders, body: Buffer.from(body, "utf8").toString("base64") });
            } catch {
              await cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
            }
          })();
        });
      }
      if (net === "slow") {
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 94_000 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      }
      let preflights = 0;
      let status429 = 0;
      let status5xx = 0;
      let scriptBytes = 0;
      let contentMs: number | null = null;
      let serverTimingMs: number | null = null;
      const scripts = new Set<string>();
      cdp.on("Network.requestWillBeSent", (e) => {
        if (e.type === "Preflight" || e.request.method === "OPTIONS") preflights++;
        if (e.type === "Script") scripts.add(e.requestId);
      });
      cdp.on("Network.responseReceived", (e) => {
        if (e.response.status === 429) status429++;
        else if (e.response.status >= 500) status5xx++;
        if (e.type === "Document" || e.response.url.startsWith(`${api}/api/`)) {
          const colo = parseEdgeColo(e.response.headers);
          if (colo) edgeColos.push(colo);
          const rtt = parseConnectRttMs(e.response.timing, e.response.protocol);
          if (rtt != null) connectRtts.push(rtt);
        }
        if (serverTimingMs == null && e.response.url.includes(`/api/messages/channel/${channel.id}`)) {
          serverTimingMs = parseServerTimingMs(e.response.headers["server-timing"] ?? e.response.headers["Server-Timing"]);
        }
      });
      cdp.on("Network.loadingFinished", (e) => {
        if (scripts.has(e.requestId)) scriptBytes += e.encodedDataLength;
      });
      page.on("request", (request) => {
        if (contentMs == null && /\/web-traces/.test(request.url())) contentMs = bootContentMs(request.postData() ?? "");
      });
      await page.goto(url, { waitUntil: "load", timeout: 120_000 });
      await page.waitForTimeout(settle);
      // The boot timing event goes up with the next trace batch; wait for it, within bootTimingWait.
      for (let waited = settle; contentMs == null && waited < bootTimingWait; waited += 500) await page.waitForTimeout(500);
      const read = await page.evaluate(() => {
        const w = window as unknown as { __perfVitals?: Record<string, number>; __perfBootFetches?: number };
        const messages = performance
          .getEntriesByType("resource")
          .find((r) => /\/api\/messages\/channel\//.test(r.name)) as PerformanceResourceTiming | undefined;
        const identity = document.getElementById("raft-frontend-release-identity")?.textContent;
        let release: { commitSha?: string; deploymentEnvironment?: string } = {};
        try {
          release = identity ? JSON.parse(identity) : {};
        } catch {
          /* no identity: rows carry nulls */
        }
        return { vitals: w.__perfVitals ?? {}, release, messagesFetched: messages ? messages.responseEnd : null, bootReads: w.__perfBootFetches ?? 0 };
      });
      const ms = (x: number | undefined) => (x == null ? null : Math.round(x));
      pageEnv ??= read.release.deploymentEnvironment;
      return {
        arm,
        contentMs,
        lcp: ms(read.vitals.lcp),
        cls: read.vitals.cls == null ? null : Math.round(read.vitals.cls * 10000) / 10000,
        fcp: ms(read.vitals.fcp),
        ttfb: ms(read.vitals.ttfb),
        inp: ms(read.vitals.inp),
        commitSha: read.release.commitSha ?? null,
        messagesFetched: read.messagesFetched == null ? null : Math.round(read.messagesFetched),
        bootReads: read.bootReads,
        preflights,
        status429,
        status5xx,
        scriptBytes,
        ...(serverTimingMs != null ? { serverTimingMs } : {}),
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** What was seen of the host beside each load (src/hostHealth.ts). */
  const host: Record<Arm, HostSample[]> = { on: [], off: [] };
  /** The pairs to leave out: those with a load taken on a busy host (none with --keep-busy). */
  const busyNow = (): number[] => leftOutAsBusy(busyPairs(host.on, host.off).dropped, { keepBusy: !!args["keep-busy"], where });
  type Pick = (r: RunMetrics) => number | null;
  const picks: Pick[] = [(r) => r.contentMs, (r) => r.lcp];
  const judge = (taken: Record<Arm, RunMetrics[]>, pick: Pick, dropped: readonly number[]): MetricVerdict => pairedVerdict(withoutPairs(taken.on.map(pick), dropped), withoutPairs(taken.off.map(pick), dropped));
  /** A metric some load pair has reported, busy or not: one that no load reports (LCP on a page without one) can never settle. */
  const reported = (taken: Record<Arm, RunMetrics[]>, pick: Pick): boolean => taken.on.some((r, i) => pick(r) != null && taken.off[i] != null && pick(taken.off[i]) != null);
  const arms: Arm[] = ab === "none" ? ["on"] : ["on", "off"];
  const results: Record<Arm, RunMetrics[]> = { on: [], off: [] };
  /** Adding pairs stopped because the sessions were running out: more pairs would not have fitted. */
  let outOfTime = false;
  const warnings: string[] = [];
  let opened: OpenedBrowser | null = null;
  let deviceProbe: BrowserDeviceProbe | null = null;
  try {
    opened = await openBrowser(plan);
    browser = opened.browser;
    deviceProbe = await probeBrowserDevice(browser);
    // release and repeat keep one context per arm, each with its own session, warmed by one unmeasured visit.
    const warm: Partial<Record<Arm, BrowserContext>> = {};
    const warmAt = Date.now();
    if (state !== "cold") {
      for (const arm of arms) {
        warm[arm] = await newContext(await signIn());
        await load(warm[arm]!, arm, false);
      }
      checkEnv();
    }
    let coldSession = first;
    hostBenchmark(); // once unmeasured: the first run of the loop is slower while it is compiled
    outOfTime = false;
    for (let i = 0; i < maxRuns; i++) {
      // Past the pairs asked for, another pair is taken only while one of the judged metrics is not settled.
      // A metric no pair has reported is left out; one whose pairs were all dropped as busy is not settled, so pairs keep coming.
      if (i >= runs) {
        const dropped = busyNow();
        if (ab === "none" || picks.filter((pick) => reported(results, pick)).every((pick) => judge(results, pick, dropped).confidence === "settled")) break;
      }
      // An extra pair is not worth losing the pairs already taken: stop adding while the sessions still have two minutes.
      if (i >= runs && state !== "cold" && Date.now() - warmAt > TOKEN_REUSE_MS - 2 * 60_000) {
        warnings.push(`stopped adding pairs at ${i}: the sessions are close to their 10 minutes; the verdict stays as far as it got`);
        outOfTime = true;
        break;
      }
      // Alternate which arm goes first so drift hits both.
      for (const arm of i % 2 ? [...arms].reverse() : arms) {
        if (state !== "cold" && Date.now() - warmAt > TOKEN_REUSE_MS) fail("the run outlived its sessions (10 min); lower --runs or use --net fast");
        if (state === "cold" && Date.now() - coldSession.at > TOKEN_REUSE_MS) coldSession = await signIn();
        const hostBefore = { benchMs: hostBenchmark(), pressure: readPressure(), at: Date.now() };
        if (state === "cold") {
          const context = await newContext(coldSession);
          try {
            results[arm].push(await load(context, arm, true));
          } finally {
            await context.close();
          }
        } else {
          results[arm].push(await load(warm[arm]!, arm, state === "release"));
        }
        host[arm].push({ ...stallShares(hostBefore.pressure, readPressure(), Date.now() - hostBefore.at), benchMs: Math.max(hostBefore.benchMs, hostBenchmark()) });
        checkEnv();
      }
    }
  } finally {
    // to stderr, not to the report's warnings: it says nothing about the measurement, and a failed run writes no report
    const notEnded = await opened?.close();
    if (notEnded) process.stderr.write(`raft-perf measure: ${notEnded}\n`);
  }

  if (ab === "boot-prefetch") {
    if (results.on.every((r) => r.bootReads === 0)) warnings.push("the on arm's boot script sent no reads: this page/state has no prefetch to compare (root without a remembered channel, or a changed boot script)");
    if (results.off.some((r) => r.bootReads > 0)) warnings.push("the off arm's boot script still sent reads: the prefetch config was not removed, the comparison is invalid");
  }
  const loads = results.on.concat(results.off);
  if (loads.length && loads.every((r) => r.lcp == null)) warnings.push("no load reported LCP: the web-vitals script did not run (check the init script)");
  const commits = new Set(loads.map((r) => r.commitSha).filter(Boolean));
  if (commits.size > 1) warnings.push(`the web changed during the run (${[...commits].map((c) => c!.slice(0, 8)).join(", ")}): the comparison is invalid`);
  if (loads.some((r) => r.contentMs == null)) warnings.push("some loads reported no rendered boot timing (content_ms); those pairs are dropped from that metric");

  /** Things a reader needs beside the numbers that are not faults of the run (a warning is one). */
  const notes: string[] = [];
  const hostSeen = busyPairs(host.on, host.off);
  const droppedPairs = leftOutAsBusy(hostSeen.dropped, { keepBusy: !!args["keep-busy"], where });
  const cpus = availableParallelism();
  const verdictMetrics: Record<string, MetricVerdict> | null =
    ab === "none"
      ? null
      : {
          contentMs: judge(results, picks[0], droppedPairs),
          lcp: judge(results, picks[1], droppedPairs),
        };
  if (remote) {
    notes.push("the browser ran on Browser Run: this host's load says nothing about it, so no pair was left out as busy (`cohort.browserBenchmarkMs` and `cohort.edgeColo` describe the remote browser)");
    if (interceptDocument) notes.push("every load hands the page its document through this machine (the pause in which the off arm loses its boot prefetch config), so its times include two round trips between here and Browser Run: arms are affected alike, the absolute times depend on where this command ran");
  }
  else if (ab !== "none" && hostSeen.dropped.length) warnings.push(`${hostSeen.dropped.length} pair(s) ${args["keep-busy"] ? "taken on a busy host (kept: --keep-busy)" : "left out of the verdict: the host was busy during them"} (pair ${hostSeen.dropped.map((i) => i + 1).join(", ")}; ${hostSeen.by === "pressure" ? "tasks on the host were stalled for 10% or more of those loads' time" : `the benchmark beside those loads took over 1.5x its median of ${hostSeen.benchmarkMedianMs} ms`})`);
  const tilted = ab === "none" || remote ? null : lopsided(hostSeen.busyOn, hostSeen.busyOff);
  if (tilted) warnings.push(`the busy loads are mostly on the ${tilted} arm (${hostSeen.busyOn.filter(Boolean).length} on, ${hostSeen.busyOff.filter(Boolean).length} off): on a host with few cores (${cpus} here) the heavier arm can raise the pressure by itself, and leaving its pairs out would tilt the verdict; compare with --keep-busy`);
  const info = ab === "none" ? null : { messagesFetched: pairedVerdict(results.on.map((r) => r.messagesFetched), results.off.map((r) => r.messagesFetched)) };
  let verdict: Verdict = verdictMetrics ? overallVerdict(Object.values(verdictMetrics).map((m) => m.verdict)) : "unknown";
  if (warnings.some((w) => /invalid/.test(w))) verdict = "unknown";
  if (deviceProbe?.browserBenchmarkMs == null) {
    warnings.push("in-browser CPU benchmark probe returned no reading; cohort lacks browserBenchmarkMs");
  }
  const cohort = buildCohort({
    browserWhere: where,
    edgeColo: dominantString(edgeColos),
    hostCpuCount: cpus,
    hostBenchmarkMs: hostSeen.benchmarkMedianMs,
    device: deviceProbe,
    connectRttSamplesMs: connectRtts,
    cpuSlowdown: net === "slow" ? 4 : 1,
    addedRttMs: net === "slow" ? 150 : 0,
    net,
    documentIntercepted: interceptDocument,
    fixture: verifiedFixtureTag,
  });
  const sum = (arm: Arm, key: "preflights" | "status429" | "status5xx") => results[arm].reduce((a, r) => a + r[key], 0);
  const report = {
    tool: "raft-perf measure",
    measuredAt: new Date().toISOString(),
    origin,
    page: { entry, server: server.slug, channel: channel.name },
    cohort,
    state,
    net,
    ab,
    requestedPairs: runs,
    maxPairs: maxRuns,
    // rounds taken: pairs, or single loads with --ab none
    pairs: results.on.length,
    verdict,
    // how far the pairs settle it: the weakest of the judged metrics
    confidence: verdictMetrics ? (["too-few", "open", "settled"] as const).find((level) => Object.values(verdictMetrics).some((m) => m.confidence === level)) ?? null : null,
    metrics: verdictMetrics,
    informational: info,
    // where the browser ran and which Chromium it was: two reports compare only when `where` is the same
    browser: opened?.describe ?? null,
    // what a reader needs beside the numbers that is not a fault of the run
    notes,
    // what was seen of the host beside each load, which signal decided, the pairs with a busy load (1-based) and whether they were left out
    host: { by: hostSeen.by, cpus, benchmarkMedianMs: hostSeen.benchmarkMedianMs, loads: host, busyPairs: ab === "none" ? [] : hostSeen.dropped.map((i) => i + 1), busyLoads: { on: hostSeen.busyOn.filter(Boolean).length, off: hostSeen.busyOff.filter(Boolean).length }, leftOut: !args["keep-busy"] && !remote },
    warnings,
    totals: {
      preflights: { on: sum("on", "preflights"), off: sum("off", "preflights") },
      status429: { on: sum("on", "status429"), off: sum("off", "status429") },
      status5xx: { on: sum("on", "status5xx"), off: sum("off", "status5xx") },
    },
    runs: results,
  };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  if (args.jsonl) {
    const env = args.env ?? pageEnv;
    if (!env) fail("the page names no environment; pass --env");
    const rows: PageRunRow[] = toPageRunRows(results, {
      project: args.project!,
      env: env!,
      runId: args["run-id"] ?? randomUUID(),
      toolVersion: toolVersion(),
      takenAt: report.measuredAt,
      origin,
      page: entry,
      state,
      net,
      ab,
      verdict,
      host: hostExtra(cpus, hostSeen.benchmarkMedianMs),
      cohort,
      storeTtfb: !interceptDocument && net === "fast",
    });
    writeFileSync(args.jsonl, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  const c = verdictMetrics?.contentMs;
  process.stderr.write(
    `raft-perf measure ${entry}/${state}/${net} ab=${ab}: ${verdict}` +
      (c ? ` (content shown ${c.medianOn} vs ${c.medianOff} ms, delta ${c.medianDelta}, floor ${c.noiseFloor == null ? "-" : Math.round(c.noiseFloor)}; ${c.interval ? `shift ${Math.round(c.shift!)} ms, 95% interval ${Math.round(c.interval[0])} to ${Math.round(c.interval[1])}` : `${c.pairs} pair(s), no interval under ${MIN_PAIRS_TO_SETTLE}`}; ${report.confidence})` : "") +
      (warnings.length ? `; ${warnings.length} warning(s)` : "") +
      "\n",
  );
  if (ab !== "none" && report.confidence !== "settled" && verdict !== "unknown") process.stderr.write(outOfTime ? `the verdict is not settled (${report.confidence}) and the sessions' ten minutes ran out: more pairs do not fit in one run on this network\n` : `next: the verdict is not settled (${report.confidence}); run again with --max-runs ${Math.max(maxRuns * 2, 12)} to let it add pairs until it is\n`);
  if (verdict === "unknown" && ab !== "none") return 2;
  return verdict === "worse" && args["fail-on-worse"] ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf measure: ${error instanceof MeasureError || error instanceof BrowserError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
