#!/usr/bin/env node
/**
 * raft-perf ab: two builds of the web, one change between them, compared on
 * the real page. Both builds are served into the deployed origin inside the
 * measuring browser (the API, the account and the data stay the deployed
 * ones), the two arms alternate, and each switch into a channel is traced:
 * what the main thread did in the seconds after the press (src/workSplit.ts),
 * judged pair by pair (src/verdict.ts) with the busy-host gate
 * (src/hostHealth.ts).
 *
 *   RAFT_PERF_EMAIL=… RAFT_PERF_PASSWORD=… \
 *   pnpm --filter @botiverse/raft-perf ab -- --base <dist of the build as it is> --pr <dist with the change> --server <slug> --channel <busy>
 *
 * Exit codes: 0 compared, 2 the comparison failed or is not to be trusted.
 * docs/frontend/perf-measure.md, "Two builds, one change (`ab`)".
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { type Browser, chromium } from "playwright";
import { type ArmVisit, compareArms } from "./abCompare";
import { MIN_PAIRS } from "./verdict";
import { cliArgs } from "./args";
import { type HostSample, busyPairs, hostBenchmark, lopsided, readPressure, stallShares } from "./hostHealth";
import { isProductionHost } from "./page";
import { TRACE_CATEGORIES, type TraceEvent, type WorkSplit, workSplit } from "./workSplit";

const WINDOW_MS = 3000;

const HELP = `raft-perf ab — two local builds of the web compared on a deployed page: main-thread work of a channel switch

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --base <dir>        build output of the web as it is (packages/web/dist of a build of the base commit)
  --pr <dir>          build output with the change
  --origin <url>      web origin the builds are served into (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default https://api-aws-staging.botiverse.dev)
  --server <slug>     server slug (required)
  --channel <name>    the channel switched into (required)
  --other <name>      the channel switched from (default all)
  --pairs <n>         pairs of visits, the arms alternating (default 6: fewer cannot settle a verdict)
  --switches <n>      switches into the channel per visit; a visit counts as their median (default 3)
  --keep-busy         keep pairs taken while the host was busy
  --out <file>        also write the JSON here
  --chromium-arg <a>  extra Chromium switch (repeatable)
Production origins are refused: the builds would run against real accounts.
`;

/** A socket to a production host (the hosts of `isProductionHost`, src/page.ts). */
export const PRODUCTION_SOCKET = /^wss?:\/\/([^/?#@]*\.)?raft\.build\.?(:\d+)?([/?#]|$)/i;

class AbError extends Error {}
const fail = (message: string): never => {
  throw new AbError(message);
};

const TYPES: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };

type Arm = "base" | "pr";

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      base: { type: "string" },
      pr: { type: "string" },
      origin: { type: "string", default: "https://raft-app-staging.botiverse.dev" },
      api: { type: "string", default: "https://api-aws-staging.botiverse.dev" },
      server: { type: "string" },
      channel: { type: "string" },
      other: { type: "string", default: "all" },
      pairs: { type: "string", default: "6" },
      switches: { type: "string", default: "3" },
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
  // the browser compares origins in their canonical form: `https://Host:443/` must still match
  const canonical = (url: string, flag: string) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    // `localhost:5173` parses, as a URL of scheme "localhost" with no origin
    return parsed && /^https?:$/.test(parsed.protocol) ? parsed.origin : fail(`${flag} must be an http(s) URL`);
  };
  const origin = canonical(args.origin!, "--origin");
  const api = canonical(args.api!, "--api");
  const pairs = Number(args.pairs);
  const switches = Number(args.switches);
  if (!args.server) fail("--server <slug> is required");
  if (!args.channel) fail("--channel <name> is required");
  if (!Number.isInteger(pairs) || pairs < 1) fail("--pairs must be an integer of at least 1");
  if (!Number.isInteger(switches) || switches < 1) fail("--switches must be an integer of at least 1");
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
  const session = (await json(`${api}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })) as { accessToken?: string; refreshToken?: string };
  if (!session.accessToken || !session.refreshToken) fail("sign-in returned no tokens");
  const auth = { authorization: `Bearer ${session.accessToken}` };
  type Named = { id: string; name: string };
  const servers = (await json(`${api}/api/servers`, { headers: auth })) as Array<{ id: string; slug: string }> | { servers: Array<{ id: string; slug: string }> };
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === args.server) ?? fail(`the account is not a member of server ${args.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as Named[] | { channels: Named[] };
  const list = Array.isArray(channels) ? channels : channels.channels;
  const busy = list.find((c) => c.name === args.channel) ?? fail(`no channel ${args.channel} in ${args.server}`);
  const other = list.find((c) => c.name === args.other) ?? fail(`no channel ${args.other} in ${args.server}`);
  if (busy.id === other.id) fail("--channel and --other must differ");

  const warnings: string[] = [];
  const warn = (text: string) => void (warnings.includes(text) || warnings.push(text));

  /** One visit of one arm: a fresh signed-in tab with the build served into the origin, then the switches, each traced. */
  const visit = async (browser: Browser, arm: Arm): Promise<ArmVisit & { commitSha: string | null; servedLocally: number | null; fromNetwork: number }> => {
    const dir = dirs[arm];
    let servedLocally = 0;
    let fromNetwork = 0;
    let production: string | null = null;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "slock_access_token", value: session.accessToken! }, { name: "slock_refresh_token", value: session.refreshToken! }] }] },
    });
    try {
      // A build compiled for production would send the test account's token to the production API, in request headers and in the
      // socket's handshake: nothing of this browser goes to a production host. A request the app makes (fetch, XHR) or a socket
      // means the build talks to production and stops the run; an image or a frame in a message is only blocked.
      await context.route(
        (url) => isProductionHost(url.href),
        (route) => {
          if (["fetch", "xhr", "eventsource"].includes(route.request().resourceType())) production ??= new URL(route.request().url()).host;
          return route.abort();
        },
      );
      // a pattern, not a function: with a function Playwright relays every socket of the page through its driver, the deployed one included
      await context.routeWebSocket(PRODUCTION_SOCKET, (socket) => {
        production ??= new URL(socket.url()).host;
        return socket.close();
      });
      const tab = await context.newPage();
      // The build's files replace the deployed ones; everything that is not a file of the build (the API when it shares the origin, uploads, sockets) goes out as usual.
      await tab.route(
        (url) => url.origin === origin,
        async (route) => {
          const request = route.request();
          let pathname: string;
          try {
            pathname = decodeURIComponent(new URL(request.url()).pathname);
          } catch {
            // not a path of the build
            fromNetwork++;
            return route.continue();
          }
          if (request.method() !== "GET" || /^\/(api|socket\.io)(\/|$)/.test(pathname)) {
            fromNetwork++;
            return route.continue();
          }
          let file = path.join(dir, pathname);
          const isFile = file.startsWith(dir + path.sep) && existsSync(file) && statSync(file).isFile();
          if (!isFile) {
            // an app route: the build's own index.html, as the host would answer
            if (request.resourceType() !== "document") {
              fromNetwork++;
              return route.continue();
            }
            file = path.join(dir, "index.html");
          }
          servedLocally++;
          return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
        },
      );
      await tab.goto(`${origin}/s/${server.slug}/channel/${busy.id}`, { waitUntil: "load", timeout: 120_000 });
      const shown = await tab.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false);
      if (servedLocally === 0) fail(`${arm}: the page loaded nothing from ${dir}`);
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
        await inSidebar(other).click({ timeout: 10_000 });
        await tab.waitForTimeout(2500);
        await browser.startTracing(tab, { categories: TRACE_CATEGORIES });
        let trace: Buffer;
        try {
          await inSidebar(busy).click({ timeout: 10_000 });
          // the press and the click are no later than this: the window is counted from the press, so the recording outlasts it
          await tab.waitForTimeout(WINDOW_MS + 200);
        } finally {
          trace = await browser.stopTracing();
        }
        const arrived = await tab.evaluate((id) => location.pathname.endsWith(id) && document.querySelector("[data-testid=message-scroller] [data-testid^=message-sender-tail]") != null, busy.id);
        const split = arrived ? workSplit((JSON.parse(trace.toString()) as { traceEvents: TraceEvent[] }).traceEvents, WINDOW_MS) : null;
        if (!arrived) warn(`a switch did not show #${busy.name} within ${WINDOW_MS / 1000} s: it is not counted`);
        else if (!split) warn("a trace held no click event: that switch is not counted");
        else if (split.recordedMs < WINDOW_MS) warn("a trace stopped early: that switch is not counted");
        else splits.push(split);
      }
      return { splits, commitSha, servedLocally, fromNetwork };
    } finally {
      await context.close().catch(() => undefined);
      // whenever it was seen (while loading, during a switch, behind another failure), and whatever else went wrong
      // (thrown from here on purpose: it replaces the visit's own result or error)
      if (production) fail(`${arm}: the build in ${dir} talks to production (${production}); build it with VITE_API_URL set to the API of ${origin}`);
    }
  };

  const taken: Record<Arm, ArmVisit[]> = { base: [], pr: [] };
  const host: Record<Arm, HostSample[]> = { base: [], pr: [] };
  const commits: Record<Arm, Set<string | null>> = { base: new Set(), pr: new Set() };
  /** Per visit; `servedLocally` null for a visit that failed. */
  const served: Record<Arm, { servedLocally: number | null; fromNetwork: number }[]> = { base: [], pr: [] };
  const browser = await chromium.launch({ args: args["chromium-arg"] });
  try {
    // the first run of the benchmark is slower while it is compiled
    hostBenchmark();
    for (let pair = 0; pair < pairs; pair++) {
      // alternate which arm goes first, so drift over the collection hits both
      for (const arm of pair % 2 ? (["pr", "base"] as const) : (["base", "pr"] as const)) {
        const before = { benchMs: hostBenchmark(), pressure: readPressure(), at: Date.now() };
        // A visit that fails (a click that times out, a page that does not come up) costs its pair, not the collection.
        const seen = await visit(browser, arm).catch((error: unknown) => {
          if (error instanceof AbError) throw error;
          const reason = (error as Error)?.message?.split("\n")[0] ?? String(error);
          // the first visit of an arm failing is a build that does not work here, not a hiccup: stop instead of waiting through every pair
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
  if (hostSeen.dropped.length) notes.push(`pair(s) ${hostSeen.dropped.map((i) => i + 1).join(", ")} ${args["keep-busy"] ? "taken on a busy host (kept: --keep-busy)" : `left out: the host was busy (by ${hostSeen.by})`}`);
  const tilted = lopsided(hostSeen.busyOn, hostSeen.busyOff);
  if (tilted) warn(`the busy visits fall mostly on the ${tilted === "on" ? "pr" : "base"} arm: the heavier build may be flagging itself, and leaving its pairs out ${args["keep-busy"] ? "would tilt the result (they were kept)" : "tilts the result (run again with --keep-busy and compare)"}`);
  if (comparison.pairs < MIN_PAIRS) warn(`${comparison.pairs} complete pair(s): fewer than ${MIN_PAIRS} cannot be judged`);
  const commitOf = (arm: Arm) => [...commits[arm]];
  for (const arm of ["base", "pr"] as const) if (commits[arm].size > 1) warn(`${arm}: the page named different commits across visits`);
  const report = {
    tool: "raft-perf ab",
    measuredAt: new Date().toISOString(),
    origin,
    page: { server: server.slug, channel: busy.name, other: other.name },
    builds: { base: { dir: dirs.base, commitSha: commitOf("base")[0] ?? null }, pr: { dir: dirs.pr, commitSha: commitOf("pr")[0] ?? null } },
    requestedPairs: pairs,
    switchesPerVisit: switches,
    windowMs: WINDOW_MS,
    ...comparison,
    warnings,
    notes,
    host: { by: hostSeen.by, cpus: availableParallelism(), benchmarkMedianMs: hostSeen.benchmarkMedianMs, busyPairs: hostSeen.dropped.map((i) => i + 1), leftOut: !args["keep-busy"] },
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
