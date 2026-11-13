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
import process from "node:process";
import { chromium } from "playwright";
import type { Browser, BrowserContext } from "playwright";
import { overallVerdict, pairedVerdict } from "./verdict";
import type { MetricVerdict, Verdict } from "./verdict";
import { bootContentMs, isProductionHost, withoutBootPrefetch } from "./page";

const HELP = `raft-perf measure — paired on/off page measurement with a JSON verdict

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --origin <url>      web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default: --origin; the web calls /api on its own origin)
  --server <slug>     server slug (required)
  --channel <name>    channel the channel entry opens (default all)
  --entry <e>         channel | root  (root = /s/<slug>, lands on the remembered or first channel)
  --state <s>         cold | release | repeat
                        cold    new browser context per load, no local data, HTTP cache off
                        release local data kept, HTTP cache off (first open after a deploy)
                        repeat  local data and HTTP cache kept
  --net <n>           fast | slow (slow: 150 ms RTT, 200 KB/s down, 4x CPU)
  --ab <name>         boot-prefetch | none (default boot-prefetch)
  --runs <n>          pairs (default 5, minimum 3)
  --settle <ms>       wait after load before reading metrics (default 8000 fast / 15000 slow)
  --chromium-arg <a>  extra Chromium switch (repeatable), e.g. a host's run marker
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
      server: { type: "string" },
      channel: { type: "string", default: "all" },
      entry: { type: "string", default: "channel" },
      state: { type: "string", default: "release" },
      net: { type: "string", default: "fast" },
      ab: { type: "string", default: "boot-prefetch" },
      runs: { type: "string", default: "5" },
      settle: { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
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
  if (!args.server) fail("--server <slug> is required");
  if (!["channel", "root"].includes(entry)) fail(`--entry must be channel or root, not ${entry}`);
  if (!["cold", "release", "repeat"].includes(state)) fail(`--state must be cold, release or repeat, not ${state}`);
  if (!["fast", "slow"].includes(net)) fail(`--net must be fast or slow, not ${net}`);
  if (!["boot-prefetch", "none"].includes(ab)) fail(`--ab must be boot-prefetch or none, not ${ab}`);
  if (!Number.isInteger(runs) || runs < 3) fail("--runs must be an integer of at least 3");
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
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === args.server) ?? fail(`the account is not a member of server ${args.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as
    | Array<{ id: string; name: string }>
    | { channels: Array<{ id: string; name: string }> };
  const channel = (Array.isArray(channels) ? channels : channels.channels).find((c) => c.name === args.channel) ?? fail(`no channel ${args.channel} in ${args.server}`);
  const url = entry === "channel" ? `${origin}/s/${server.slug}/channel/${channel.id}` : `${origin}/s/${server.slug}`;

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
      // Both arms pause the document's response at the same point (the browser makes the request, throttled and cached
      // as usual; nothing else is intercepted); only the off arm's HTML is edited. Playwright's page.route is not used:
      // it disables the HTTP cache and fetches the document from Node.
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
      if (net === "slow") {
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 94_000 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      }
      let preflights = 0;
      let status429 = 0;
      let status5xx = 0;
      let scriptBytes = 0;
      let contentMs: number | null = null;
      const scripts = new Set<string>();
      cdp.on("Network.requestWillBeSent", (e) => {
        if (e.type === "Preflight" || e.request.method === "OPTIONS") preflights++;
        if (e.type === "Script") scripts.add(e.requestId);
      });
      cdp.on("Network.responseReceived", (e) => {
        if (e.response.status === 429) status429++;
        else if (e.response.status >= 500) status5xx++;
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
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  const arms: Arm[] = ab === "none" ? ["on"] : ["on", "off"];
  const results: Record<Arm, RunMetrics[]> = { on: [], off: [] };
  const warnings: string[] = [];
  try {
    browser = await chromium.launch({ args: args["chromium-arg"] });
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
    for (let i = 0; i < runs; i++) {
      // Alternate which arm goes first so drift hits both.
      for (const arm of i % 2 ? [...arms].reverse() : arms) {
        if (state !== "cold" && Date.now() - warmAt > TOKEN_REUSE_MS) fail("the run outlived its sessions (10 min); lower --runs or use --net fast");
        if (state === "cold" && Date.now() - coldSession.at > TOKEN_REUSE_MS) coldSession = await signIn();
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
        checkEnv();
      }
    }
  } finally {
    await browser?.close();
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

  const verdictMetrics: Record<string, MetricVerdict> | null =
    ab === "none"
      ? null
      : {
          contentMs: pairedVerdict(results.on.map((r) => r.contentMs), results.off.map((r) => r.contentMs)),
          lcp: pairedVerdict(results.on.map((r) => r.lcp), results.off.map((r) => r.lcp)),
        };
  const info = ab === "none" ? null : { messagesFetched: pairedVerdict(results.on.map((r) => r.messagesFetched), results.off.map((r) => r.messagesFetched)) };
  let verdict: Verdict = verdictMetrics ? overallVerdict(Object.values(verdictMetrics).map((m) => m.verdict)) : "unknown";
  if (warnings.some((w) => /invalid/.test(w))) verdict = "unknown";
  const sum = (arm: Arm, key: "preflights" | "status429" | "status5xx") => results[arm].reduce((a, r) => a + r[key], 0);
  const report = {
    tool: "raft-perf measure",
    measuredAt: new Date().toISOString(),
    origin,
    page: { entry, server: server.slug, channel: channel.name },
    state,
    net,
    ab,
    requestedPairs: runs,
    verdict,
    metrics: verdictMetrics,
    informational: info,
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
    });
    writeFileSync(args.jsonl, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  const c = verdictMetrics?.contentMs;
  process.stderr.write(
    `raft-perf measure ${entry}/${state}/${net} ab=${ab}: ${verdict}` +
      (c ? ` (content shown ${c.medianOn} vs ${c.medianOff} ms, delta ${c.medianDelta}, floor ${c.noiseFloor == null ? "-" : Math.round(c.noiseFloor)})` : "") +
      (warnings.length ? `; ${warnings.length} warning(s)` : "") +
      "\n",
  );
  if (verdict === "unknown" && ab !== "none") return 2;
  return verdict === "worse" && args["fail-on-worse"] ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf measure: ${error instanceof MeasureError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
