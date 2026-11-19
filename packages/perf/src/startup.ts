/**
 * raft-perf startup: where the time of opening a channel goes (docs/frontend/perf-measure.md, "Opening a channel: where the time goes").
 *
 * Opens a signed-in channel page on a deployed web and, for each load, cuts the request for the first page of messages at
 * the points the browser recorded (asked, sent, first byte, last byte), counts the CORS preflights, lists what was asked
 * twice, and measures the gap from the answer to the first message on screen with the long tasks inside it. Each run is
 * two loads in one browser context: the first as a new device (only the sign-in), the second a reopen (local data, HTTP
 * cache and preflight cache kept). No verdict: this command describes one build; compare two with `measure` or `ab`.
 *
 * READ-ONLY apart from what opening a page does (a session, read markers): it clicks nothing and sends nothing.
 * The pieces are pure and unit-tested in src/startupSplit.ts. What this file does with a real browser (the in-page probe,
 * the DevTools events, the join of the two clocks) has no test: it was checked by hand against staging and production.
 *
 * Exit codes: 0 a report without warnings; 2 a report with warnings, or no report (usage, sign-in, browser).
 */

import { writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { BrowserError, type OpenedBrowser, openBrowser, planBrowser } from "./browser";
import { cliArgs } from "./args";
import { bootContentMs, isProductionHost } from "./page";
import { type ApiTiming, type LongTask, type StartupLoad, type StartupSplit, blameTasks, endpointOf, splitStartup, summarize, toPageClock, withinWindow } from "./startupSplit";

const HELP = `raft-perf startup — where the time of opening a channel goes, on a deployed web

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --origin <url>      web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default: --origin)
  --server <slug>     server slug (required)
  --channel <name>    the channel opened (default all)
  --runs <n>          runs; each is a new-device load and then a reopen in the same browser context (default 5)
  --settle <ms>       wait after the first message before reading the load (default 6000)
  --browser <where>   local | browser-run (default local; see measure --help)
  --cpu <n>           slow the page's CPU n times (1 to 20; default 1): a laptop standing in for an ordinary machine.
                      A stand-in, not that machine: only the main thread is slowed, not the network or the GPU
                      The waits (a minute for the first message, --settle) are not stretched: raise --settle with it
  --chromium-arg <a>  extra Chromium switch for a local browser (repeatable)
  --out <file>        also write the JSON here
  --allow-production  open *.raft.build (signs in and opens pages: production writes)
Exit codes: 0 a report without warnings; 2 a report with warnings, or no report.
`;

class StartupError extends Error {}
const fail = (message: string): never => {
  throw new StartupError(message);
};

type Arm = "new-device" | "reopen";

/** Installed before any page script: when the first message row is in the DOM and painted, the long tasks, and the long animation frames with the script each spent the most time in. */
const probe = () => {
  const w = window as unknown as { __startup: { row: number | null; painted: number | null; tasks: Array<{ start: number; ms: number }>; frames: Array<{ start: number; ms: number; script: string }>; bufferFull: boolean } };
  w.__startup = { row: null, painted: null, tasks: [], frames: [], bufferFull: false };
  // Chromium keeps 250 resource entries by default and drops the rest without a word: a signed-in load passes that.
  performance.setResourceTimingBufferSize(20_000);
  performance.addEventListener("resourcetimingbufferfull", () => (w.__startup.bufferFull = true));
  try {
    // long animation frames name the script; long tasks alone only say that the main thread was busy
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { scripts?: Array<{ duration: number; sourceURL?: string; sourceFunctionName?: string; invoker?: string }> }>) {
        const worst = [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
        // file name without its content hash's query, then the function or what invoked it
        // an invoker can be a whole URL (a script's own top level): only its file name is kept, like the source's
        const file = (text: string) => (/^https?:/.test(text) ? (text.split("/").pop()?.split("?")[0] ?? "") : text);
        const by = worst ? file(worst.sourceFunctionName || worst.invoker || "") : "";
        const source = worst ? file(worst.sourceURL ?? "") : "";
        const script = `${source}${by && by !== source ? ` ${by}` : ""}`.trim().slice(0, 120);
        w.__startup.frames.push({ start: Math.round(entry.startTime), ms: Math.round(entry.duration), script });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {
    // a Chromium without long animation frames: tasks then carry no script
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__startup.tasks.push({ start: Math.round(entry.startTime), ms: Math.round(entry.duration) });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // no long task support: the gap is reported without tasks
  }
  new MutationObserver(() => {
    if (w.__startup.row != null || !document.querySelector("[data-testid=message-scroller] [data-message-item], [data-testid=message-scroller] [data-message-id]")) return;
    w.__startup.row = performance.now();
    requestAnimationFrame(() => setTimeout(() => (w.__startup.painted = performance.now()), 0));
  }).observe(document, { childList: true, subtree: true });
};

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      origin: { type: "string", default: "https://raft-app-staging.botiverse.dev" },
      api: { type: "string" },
      server: { type: "string" },
      channel: { type: "string", default: "all" },
      runs: { type: "string", default: "5" },
      settle: { type: "string", default: "6000" },
      browser: { type: "string" },
      cpu: { type: "string", default: "1" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
      out: { type: "string" },
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
  const runs = Number(args.runs);
  const settle = Number(args.settle);
  const plan = planBrowser(args.browser, args["chromium-arg"], process.env);
  if (!args.server) fail("--server <slug> is required");
  if (!Number.isInteger(runs) || runs < 1) fail("--runs must be an integer of at least 1");
  if (!Number.isFinite(settle) || settle < 0) fail("--settle must be a number of milliseconds");
  const cpu = Number(args.cpu);
  if (!Number.isFinite(cpu) || cpu < 1 || cpu > 20) fail("--cpu must be a number from 1 to 20");
  if (cpu > 1 && plan.where !== "local") fail("--cpu slows a local browser; a Browser Run machine is already an ordinary one (4 cores, 2 GB)");
  let production = false;
  try {
    production = isProductionHost(origin) || isProductionHost(api);
  } catch {
    return fail("--origin and --api must be URLs");
  }
  if (production && !args["allow-production"]) fail("refusing a production origin or API without --allow-production (signing in and opening pages writes)");
  const email = process.env.RAFT_PERF_EMAIL;
  const password = process.env.RAFT_PERF_PASSWORD;
  if (!email || !password) fail("set RAFT_PERF_EMAIL and RAFT_PERF_PASSWORD (a test account)");

  async function json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(url, init).catch((error: Error) => fail(`${new URL(url).pathname} failed: ${error.message}`));
    if (!response.ok) fail(`${new URL(url).pathname} answered ${response.status}`);
    return response.json().catch(() => fail(`${new URL(url).pathname} did not answer JSON`));
  }
  /** A fresh session per run: no refresh token is shared between browser contexts. */
  const signIn = async () => {
    const session = (await json(`${api}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })) as { accessToken?: string; refreshToken?: string };
    if (!session.accessToken || !session.refreshToken) fail("sign-in returned no tokens");
    return { accessToken: session.accessToken!, refreshToken: session.refreshToken! };
  };
  const first = await signIn();
  const auth = { authorization: `Bearer ${first.accessToken}` };
  type Named = { id: string; name: string };
  const servers = (await json(`${api}/api/servers`, { headers: auth })) as Array<{ id: string; slug: string }> | { servers: Array<{ id: string; slug: string }> };
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === args.server) ?? fail(`the account is not a member of server ${args.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as Named[] | { channels: Named[] };
  const channel = (Array.isArray(channels) ? channels : channels.channels).find((c) => c.name === args.channel) ?? fail(`no channel ${args.channel} in ${args.server}`);
  const url = `${origin}/s/${server.slug}/channel/${channel.id}`;
  const apiHost = new URL(api).host;

  /** One load of the channel in a context; the page is closed afterwards, the context keeps its data. */
  const load = async (context: BrowserContext): Promise<{ load: StartupLoad; bufferFull: boolean }> => {
    const page: Page = await context.newPage();
    const cdp: CDPSession = await context.newCDPSession(page);
    try {
      await cdp.send("Network.enable");
      if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
      // Preflights and the socket are invisible to Resource Timing: read them from the DevTools protocol. Its events carry
      // its own clock; the document request, which also carries a wall time, joins that clock to the page's (toPageClock)
      // once the page's time origin is read. Only the top document of this load counts: the page is new, so it is the first.
      let docRequest: { timestamp: number; wallTime: number } | null = null;
      const sent = new Map<string, { path: string; sent: number; answered: number | null }>();
      let socketOpen: number | null = null;
      cdp.on("Network.requestWillBeSent", (event) => {
        if (event.type === "Document" && docRequest === null) docRequest = { timestamp: event.timestamp, wallTime: event.wallTime };
        // only the API's: a preflight to any other origin is not this page's API cost
        if ((event.type !== "Preflight" && event.request.method !== "OPTIONS") || new URL(event.request.url).host !== apiHost) return;
        sent.set(event.requestId, { path: endpointOf(event.request.url, channel.id).path, sent: event.timestamp, answered: null });
      });
      cdp.on("Network.responseReceived", (event) => {
        const preflight = sent.get(event.requestId);
        if (preflight && preflight.answered === null) preflight.answered = event.timestamp;
      });
      cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
        if (socketOpen === null) socketOpen = event.timestamp;
      });
      let contentMs: number | null = null;
      page.on("request", (request) => {
        if (contentMs == null && /web-traces/.test(request.url())) contentMs = bootContentMs(request.postData() ?? "");
      });
      await page.goto(url, { waitUntil: "load", timeout: 120_000 });
      const row = page.locator("[data-testid=message-scroller] [data-message-item], [data-testid=message-scroller] [data-message-id]").first();
      await row.waitFor({ timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(settle);
      // the page's own report goes out with its next trace upload; give it a few more seconds, not forever
      for (let i = 0; i < 12 && contentMs == null; i++) await page.waitForTimeout(1000);
      const read = await page.evaluate((host) => {
        const w = window as unknown as { __startup?: { row: number | null; painted: number | null; tasks: Array<{ start: number; ms: number }>; frames: Array<{ start: number; ms: number; script: string }>; bufferFull: boolean } };
        const entries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((e) => {
          const u = new URL(e.name);
          return u.host === host && u.pathname.startsWith("/api/");
        });
        let commitSha: string | null = null;
        try {
          commitSha = (JSON.parse(document.getElementById("raft-frontend-release-identity")?.textContent ?? "{}").commitSha as string | undefined) ?? null;
        } catch {
          // a page without a release identity
        }
        return {
          entries: entries.map((e) => ({ url: e.name, initiator: e.initiatorType, protocol: e.nextHopProtocol, start: e.startTime, requestStart: e.requestStart, responseStart: e.responseStart, responseEnd: e.responseEnd, encodedBytes: e.encodedBodySize, decodedBytes: e.decodedBodySize })),
          row: w.__startup?.row ?? null,
          painted: w.__startup?.painted ?? null,
          tasks: w.__startup?.tasks ?? [],
          frames: w.__startup?.frames ?? [],
          bufferFull: w.__startup?.bufferFull ?? false,
          timeOrigin: performance.timeOrigin,
          loadEnd: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.loadEventEnd ?? 0,
          commitSha,
        };
      }, apiHost);
      const timings: ApiTiming[] = read.entries
        .map(({ url: full, ...rest }) => ({ ...endpointOf(full, channel.id), ...rest, start: Math.round(rest.start), requestStart: Math.round(rest.requestStart), responseStart: Math.round(rest.responseStart), responseEnd: Math.round(rest.responseEnd) }))
        .sort((a, b) => a.start - b.start);
      const tasks: LongTask[] = blameTasks(read.tasks, read.frames);
      // without the document request the protocol's times cannot be placed on the page's clock: an empty list would read as "no preflights"
      const joined = (docRequest as { timestamp: number; wallTime: number } | null) ?? fail("the DevTools protocol reported no document request for the load: preflights and the socket cannot be timed");
      const onPage = (timestamp: number) => toPageClock(timestamp, joined, read.timeOrigin);
      const all: StartupLoad = {
        api: timings,
        preflights: [...sent.values()].map((p) => ({ path: p.path, at: onPage(p.sent), ms: p.answered === null ? null : Math.round((p.answered - p.sent) * 1000) })),
        longTasks: tasks,
        contentMs,
        firstRowMs: read.row == null ? null : Math.round(read.row),
        paintedMs: read.painted == null ? null : Math.round(read.painted),
        socketOpenMs: socketOpen === null ? null : onPage(socketOpen),
        commitSha: read.commitSha,
      };
      // Loads are read at different moments (the page's own report is waited for): count only up to `settle` after the
      // first message (after the load event when no message came), so every load is counted over the same stretch.
      return { load: withinWindow(all, (all.firstRowMs ?? Math.round(read.loadEnd)) + settle), bufferFull: read.bufferFull };
    } finally {
      await cdp.detach().catch(() => {});
      await page.close().catch(() => {});
    }
  };

  const results: Record<Arm, Array<StartupSplit & { commitSha: string | null }>> = { "new-device": [], reopen: [] };
  const warnings: string[] = [];
  let buffersFilled = 0;
  let opened: OpenedBrowser | null = null;
  try {
    opened = await openBrowser(plan);
    for (let i = 0; i < runs; i++) {
      const session = i === 0 ? first : await signIn();
      const context = await opened.browser.newContext({
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
        storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "slock_access_token", value: session.accessToken }, { name: "slock_refresh_token", value: session.refreshToken }] }] },
      });
      try {
        await context.addInitScript(probe);
        for (const arm of ["new-device", "reopen"] as const) {
          const { load: one, bufferFull } = await load(context);
          if (bufferFull) buffersFilled++;
          const split = splitStartup(one);
          results[arm].push({ ...split, commitSha: one.commitSha });
          const m = split.messages;
          process.stderr.write(`run ${i + 1}/${runs} ${arm}: first page ${m ? `asked ${m.start}, before send ${m.beforeSendMs ?? "?"}, first byte ${m.firstByteMs ?? "?"}, download ${m.downloadMs ?? "?"}` : "not requested"}; ${split.preflights} preflight(s); first message painted ${split.paintedMs ?? "never"}\n`);
        }
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    const notEnded = await opened?.close();
    if (notEnded) process.stderr.write(`raft-perf startup: ${notEnded}\n`);
  }

  const every = [...results["new-device"], ...results.reopen];
  const commits = new Set(every.map((r) => r.commitSha).filter(Boolean));
  if (commits.size > 1) warnings.push(`the web changed during the run (${[...commits].map((c) => c!.slice(0, 8)).join(", ")}): the loads are of different builds`);
  if (every.some((r) => r.firstRowMs == null)) warnings.push(`${every.filter((r) => r.firstRowMs == null).length} load(s) showed no message row within a minute; they are counted in "withoutRow" and left out of the medians that need the row`);
  const without = (count: number, all: string, some: string) => (count === every.length ? `no load ${all}` : `${count} of ${every.length} loads ${some}`);
  const noPage = every.filter((r) => r.messages == null).length;
  if (noPage) warnings.push(`${without(noPage, "asked for the channel's first page of messages", "did not ask for the channel's first page of messages")}: wrong page, or the request's path changed (src/startupSplit.ts isFirstPage); the medians stand on the loads that did (summary.withFirstPage)`);
  if (buffersFilled) warnings.push(`the browser's resource timing buffer filled in ${buffersFilled} load(s): later requests of those loads are missing from the counts`);
  if (every.some((r) => r.messages && r.messages.firstByteMs == null)) warnings.push("the browser hid the timing of the first-page request in some loads (a cross-origin API without Timing-Allow-Origin): those loads have no before-send, first-byte and download times");
  const noContent = every.filter((r) => r.contentMs == null).length;
  if (noContent) warnings.push(`${without(noContent, "reported its boot timing (content_ms)", "did not report their boot timing (content_ms)")}: "contentMs" and the answer-to-content gap stand on the loads that did (summary.withContent)`);
  const notes: string[] = [];
  if (plan.where !== "local") notes.push("the browser ran on Browser Run: its machine and network are not this one's; compare only with another report taken there");
  if (new URL(api).origin !== new URL(origin).origin) notes.push("the API is on another origin than the web: every first use of an API URL costs a CORS preflight (\"preflights\" counts the API host's); a reopen has them cached for up to two hours");
  if (cpu > 1) notes.push(`the page's CPU was slowed ${cpu} times (--cpu): script and paint times stand in for a slower machine's, network times are this machine's; compare only with a report taken at the same slowdown`);
  notes.push("a reopen here is the second load in one browser context a few seconds after the first: local data, the HTTP cache, the preflight cache and the connections are all warm, which is the best case of a return visit; service workers are blocked, so it is a return visit without the worker's shell cache");
  const early = every.filter((r) => r.shownBeforeAnswer).length;
  if (early) notes.push(`in ${early} load(s) the messages were on screen before the first request's answer had ended (the page used another answer): those loads have no answer-to-paint gap`);
  const report = {
    tool: "raft-perf startup",
    measuredAt: new Date().toISOString(),
    origin,
    api,
    page: { server: server.slug, channel: channel.name },
    commitSha: [...commits][0] ?? null,
    browser: opened?.describe ?? null,
    cpuSlowdown: cpu,
    requestedRuns: runs,
    summary: { "new-device": summarize(results["new-device"]), reopen: summarize(results.reopen) },
    notes,
    warnings,
    runs: results,
  };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  for (const arm of ["new-device", "reopen"] as const) {
    const s = report.summary[arm];
    process.stderr.write(
      `raft-perf startup ${arm} (${s.loads} loads): first page asked ${s.messagesStartMs ?? "-"} ms, before send ${s.beforeSendMs ?? "-"}, first byte ${s.firstByteMs ?? "-"}, download ${s.downloadMs ?? "-"} (${s.encodedBytes == null ? "-" : Math.round(s.encodedBytes / 1024)} KB on the wire, ${s.decodedBytes == null ? "-" : Math.round(s.decodedBytes / 1024)} KB of JSON), answer to paint ${s.responseToPaintMs ?? "-"}; first message painted ${s.paintedMs ?? "-"} ms; ${s.preflights ?? "-"} preflight(s), ${s.apiBeforeFirstRow ?? "-"} API requests before it; first page asked twice in ${s.raced + s.refetched} load(s) (${s.raced} race, ${s.refetched} refetch); before asking: ${s.beforeAskLongTaskMs ?? "-"} ms of long tasks${s.withFirstPage === 0 ? " (no load asked)" : s.lastAnswerBeforeAsk ? `, asked ${s.lastAnswerBeforeAsk.askedAfterMs} ms after ${s.lastAnswerBeforeAsk.endpoint} answered (${s.lastAnswerBeforeAsk.loads} of ${s.loads} loads)` : ", no API answer was in yet"}\n`,
    );
  }
  if (warnings.length) process.stderr.write(`${warnings.length} warning(s): ${warnings.join("; ")}\n`);
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf startup: ${error instanceof StartupError || error instanceof BrowserError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
