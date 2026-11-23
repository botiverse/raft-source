#!/usr/bin/env node
/**
 * raft-perf interact: how the signed-in Raft web behaves while it is used,
 * not while it loads. Scrolls the message list of a busy channel, switches
 * channels from the sidebar (a first visit in a fresh tab, and back and forth),
 * opens a thread, and reports frame and timing numbers a watermark can be set
 * on (src/watermarks.ts, `raft-perf check`). Each switch also says where its
 * time went (src/switchTiming.ts).
 *
 *   RAFT_PERF_EMAIL=… RAFT_PERF_PASSWORD=… \
 *   pnpm --filter @botiverse/raft-perf interact -- --server <slug> --channel <busy> --other <another>
 *
 * Exit codes: 0 measured, 2 the measurement failed.
 * docs/frontend/perf-measure.md, "Interaction metrics and watermarks".
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import { type Locator, type Page, type Request, chromium } from "playwright";
import { cliArgs } from "./args";
import { fetchAndVerifyFixture } from "./benchCheck";
import { loadBenchFixture, resolveFixtureTargets } from "./benchFixture";
import { type BrowserDeviceProbe, buildCohort, cohortExtra, dominantString, parseConnectRttMs, parseEdgeColo, probeBrowserDevice } from "./cohort";
import { interactTraceReportToRows } from "./diagnoseRuns";
import { type FrameStats, frameStats, median } from "./frames";
import { type HostSample, busyRuns, hostBenchmark, hostExtra, readPressure, stallShares, worseSample } from "./hostHealth";
import { isProductionHost } from "./page";
import type { PageRunRow } from "./pageRuns";
import { type SwitchLongTask, type SwitchRequest, type SwitchTiming, isMessageRoute, routeOf, switchTiming } from "./switchTiming";
import { TRACE_CATEGORIES, type TraceEvent, type WorkSplit, workSplit } from "./workSplit";

/** With --trace: how long after the click main-thread work is counted. */
const TRACE_WINDOW_MS = 3000;
const NO_TRACE = "a trace could not be recorded or read: that switch has no work split";
const NO_CLICK_IN_TRACE = "a trace held no click event: that switch has no work split";
const SHORT_TRACE = `a trace stopped before ${TRACE_WINDOW_MS / 1000} s had passed since the click: that switch's work split misses the end (recordedMs)`;

const HELP = `raft-perf interact — message-list scroll, channel switch and thread open on a deployed Raft web

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --origin <url>      web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default: --origin)
  --fixture <name>    frozen benchmark fixture (e.g. bench-v1, or path to JSON): sets --server/--channel/--other
                      and verifies the channel's message/thread digest before measuring
  --server <slug>     server slug (required unless --fixture sets it)
  --channel <name>    a channel with a long history, the one scrolled (required unless --fixture sets it); its last
                      message with replies is the thread that gets opened, if it has one
  --other <name>      a second channel to switch to and back (default all, or the fixture's secondary channel)
  --runs <n>          repetitions (default 3)
  --keep-busy         keep runs taken while the host was busy in the medians (they are still reported)
  --trace             record a Chrome trace of each switch and report what the main thread did in the
                      ${TRACE_WINDOW_MS / 1000} s after the click: script, style, layout, large style passes (not with --jsonl)
  --diagnose-jsonl <f> with --trace: write one ScopeDB perf.diagnose_runs row per traced switch kind; needs --project
  --out <file>        also write the JSON here
  --jsonl <file>      also write one row per run (ScopeDB perf.page_runs, metrics in extra); needs --project
  --project <name>    with --jsonl or --diagnose-jsonl: the product this web belongs to (e.g. raft-web)
  --env <env>         with --jsonl: overrides the environment read from the page
  --run-id <id>       with --jsonl: shared by every row of one collection (default: a new UUID)
  --chromium-arg <a>  extra Chromium switch (repeatable)
  --allow-production  measure *.raft.build (signs in and opens pages: production writes)
`;

const BUFFER_FULL = "the page's resource timing buffer filled: requests of later switches were not seen";

class InteractError extends Error {}
const fail = (message: string): never => {
  throw new InteractError(message);
};

/** One switch; with --trace also what the main thread did after its click (null: the trace could not be read). */
export type TimedSwitch = SwitchTiming & { work?: WorkSplit | null };

/** One repetition: a first visit and a thread open in a fresh tab; then a scroll up, a scroll down, a switch away and back. */
export interface InteractRun {
  scrollUp: FrameStats | null;
  scrollDown: FrameStats | null;
  /** Main-thread long tasks during both scrolls, ms. */
  scrollLongtaskMs: number;
  /** Sidebar click to the other channel's messages painted, ms. */
  switchAwayMs: number | null;
  /** …and back to the busy channel. */
  switchBackMs: number | null;
  /** Where the time of those two switches went. */
  switchAway: TimedSwitch | null;
  switchBack: TimedSwitch | null;
  /** In a fresh tab opened on the other channel: the first click on the busy channel. */
  firstVisit: TimedSwitch | null;
  /** …then a click on the busy channel's last message with replies; null also when it has none. */
  threadOpen: TimedSwitch | null;
  domNodes: number;
}

const SCROLL_STEPS = 40;
const SCROLL_STEP_PX = 300;

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      origin: { type: "string", default: "https://raft-app-staging.botiverse.dev" },
      api: { type: "string" },
      fixture: { type: "string" },
      server: { type: "string" },
      channel: { type: "string" },
      other: { type: "string" },
      runs: { type: "string", default: "3" },
      "keep-busy": { type: "boolean", default: false },
      trace: { type: "boolean", default: false },
      "diagnose-jsonl": { type: "string" },
      out: { type: "string" },
      jsonl: { type: "string" },
      project: { type: "string" },
      env: { type: "string" },
      "run-id": { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
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
  if (!resolved.channel) fail("--channel <name> (or --fixture <name>) is required (a channel with a long history)");
  if (!Number.isInteger(runs) || runs < 1) fail("--runs must be an integer of at least 1");
  // recording a trace can slow the page: its timings are for reading beside the split, not for the ledger
  if (args.trace && args.jsonl) fail("--trace and --jsonl do not go together: rows are for untraced runs");
  if (args["diagnose-jsonl"] && !args.trace) fail("--diagnose-jsonl requires --trace");
  if ((args.jsonl || args["diagnose-jsonl"]) && !args.project) fail("--jsonl / --diagnose-jsonl needs --project (which product this web belongs to)");
  let production: boolean;
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
  const session = (await json(`${api}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })) as { accessToken?: string; refreshToken?: string };
  if (!session.accessToken || !session.refreshToken) fail("sign-in returned no tokens");
  const auth = { authorization: `Bearer ${session.accessToken}` };
  type Named = { id: string; name: string };
  const servers = (await json(`${api}/api/servers`, { headers: auth })) as Array<{ id: string; slug: string }> | { servers: Array<{ id: string; slug: string }> };
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === resolved.server) ?? fail(`the account is not a member of server ${resolved.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as Named[] | { channels: Named[] };
  const list = Array.isArray(channels) ? channels : channels.channels;
  const busy = list.find((c) => c.name === resolved.channel) ?? fail(`no channel ${resolved.channel} in ${resolved.server}`);
  const other = list.find((c) => c.name === resolved.other) ?? fail(`no channel ${resolved.other} in ${resolved.server}`);
  if (busy.id === other.id) fail("--channel and --other must differ");
  let verifiedFixtureTag: string | null = null;
  if (fixtureSpec) {
    const check = await fetchAndVerifyFixture(api, session.accessToken!, server.id, busy.id, fixtureSpec).catch((error: Error) => fail(error.message));
    if (!check.ok) fail(`fixture ${fixtureSpec.fixture} drifted (${check.mismatches.join("; ")}): refusing to measure`);
    verifiedFixtureTag = check.tag;
  }

  const browser = await chromium.launch({ args: args["chromium-arg"] });
  const results: InteractRun[] = [];
  let release: { commitSha?: string; deploymentEnvironment?: string } = {};
  const warnings: string[] = [];
  /** Per run, what was seen of the host beside it: the worse of its two parts. */
  const hostSamples: HostSample[] = [];
  const edgeColos: string[] = [];
  const connectRtts: number[] = [];
  let deviceProbe: BrowserDeviceProbe | null = null;
  let hasThread = false;
  try {
    deviceProbe = await probeBrowserDevice(browser);
    /** A signed-in tab on one channel, settled, with long tasks recorded from the start. */
    const openTab = async (channel: Named): Promise<Page> => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
        storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "slock_access_token", value: session.accessToken! }, { name: "slock_refresh_token", value: session.refreshToken! }] }] },
      });
      const tab = await context.newPage();
      const cdp = await context.newCDPSession(tab);
      await cdp.send("Network.enable");
      cdp.on("Network.responseReceived", (e) => {
        if (e.type === "Document" || e.response.url.startsWith(`${api}/api/`)) {
          const colo = parseEdgeColo(e.response.headers);
          if (colo) edgeColos.push(colo);
          const rtt = parseConnectRttMs(e.response.timing, e.response.protocol);
          if (rtt != null) connectRtts.push(rtt);
        }
      });
      await tab.addInitScript(() => {
        const w = window as unknown as { __perfLongTasks: { start: number; duration: number }[] };
        w.__perfLongTasks = [];
        // Chromium keeps 250 resource entries by default and then drops new ones: a long session would read every later switch as a hit
        performance.setResourceTimingBufferSize(20_000);
        performance.addEventListener("resourcetimingbufferfull", () => ((window as unknown as { __perfBufferFull: boolean }).__perfBufferFull = true));
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__perfLongTasks.push({ start: e.startTime, duration: e.duration });
        }).observe({ type: "longtask", buffered: true });
      });
      await tab.goto(`${origin}/s/${server.slug}/channel/${channel.id}`, { waitUntil: "load", timeout: 120_000 });
      // Detach Network domain before any scroll or view-switch timing window so CDP event traffic adds zero overhead.
      await cdp.send("Network.disable").catch(() => {});
      await cdp.detach().catch(() => {});
      await tab.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 }).catch(() => fail("the message list did not appear"));
      await tab.waitForTimeout(6000);
      return tab;
    };

    /**
     * One view switch, timed in the page: from the click event's own timestamp to the first frame after the
     * target's messages are in the DOM. `target` is a channel id (a message that was not on screen before appears
     * under the new URL) or "thread" (the thread panel shows replies and no loading state).
     */
    const timedClick = async (tab: Page, item: Locator, target: string): Promise<TimedSwitch | null> => {
      // The target's own messages. A sidebar click loads a channel through its page and nothing else: other channels'
      // pages (inline reply previews) and message contexts (quoted permalinks) are someone else's. A thread's channel
      // id is not known from outside, so there any channel page or context counts.
      const carriesMessages = (pathname: string) => {
        if (!isMessageRoute(routeOf(pathname))) return false;
        return target === "thread" || pathname === `/api/messages/channel/${target}`;
      };
      try {
        await item.waitFor({ state: "visible", timeout: 10_000 });
        // one trace at a time per browser: switches are measured one after another. Started before the page's timer is armed.
        const tracing = args.trace && (await browser.startTracing(tab, { categories: TRACE_CATEGORIES }).then(() => true, () => false));
        const done = tab.evaluate(
          ({ target, timeoutMs }) =>
            new Promise<{ start: number; handled: number; end: number } | null>((resolve) => {
              const shown = () => [...document.querySelectorAll("[data-testid=message-scroller] [data-testid^=message-sender-tail]")].map((el) => (el as HTMLElement).dataset.testid);
              const before = new Set(shown());
              const ready = () =>
                target === "thread"
                  ? !document.querySelector("[data-testid=thread-replies-loading]") && document.querySelector("[data-testid=thread-message-scroller] [data-message-item]") != null
                  : location.pathname.endsWith(target) && shown().some((t) => !before.has(t));
              let clickedAt: number | null = null;
              let handledAt = 0;
              // the event's own timestamp is when the click happened; this listener (capture, on the document) runs before
              // the app's own click handlers, so the gap between the two is the input delay (handlers on pointerdown or
              // on window run earlier still: a request they send predates the click and is not counted)
              document.addEventListener("click", (e) => { if (clickedAt == null) { clickedAt = e.timeStamp; handledAt = performance.now(); } }, { capture: true, once: true });
              const armedAt = performance.now();
              const tick = () => {
                if (clickedAt != null && ready()) {
                  // one more frame: painted, not only in the DOM
                  const start = clickedAt;
                  const handled = handledAt;
                  return requestAnimationFrame((end) => resolve({ start, handled, end }));
                }
                if (performance.now() - armedAt > timeoutMs) return resolve(null);
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
          { target, timeoutMs: 15_000 },
        );
        // if the click below throws, nothing awaits `done`: keep its later rejection (page closed) from crashing the run
        done.catch(() => null);
        // Resource Timing lists a request only once it has finished: count message requests still out, to wait for them
        // (a set, not a count: one sent before this switch and finishing inside it must not cancel one of ours)
        const out = new Set<Request>();
        const sent = (r: Request) => void (carriesMessages(new URL(r.url()).pathname) && out.add(r));
        const settled = (r: Request) => void out.delete(r);
        tab.on("request", sent).on("requestfinished", settled).on("requestfailed", settled);
        let window: { start: number; handled: number; end: number } | null;
        let trace: Buffer | null = null;
        try {
          await item.click({ timeout: 10_000 });
          // the click event is no later than this
          const clickedBy = Date.now();
          window = await done;
          // a refresh behind a local paint is sent after it, and long tasks are delivered late: give both time,
          // then wait (up to 8 s more) for the message requests still out
          await tab.waitForTimeout(1200);
          for (let i = 0; i < 40 && out.size > 0; i++) await tab.waitForTimeout(200);
          // the split covers a fixed time from the click: keep recording until it has passed
          if (tracing) await tab.waitForTimeout(Math.max(0, TRACE_WINDOW_MS + 200 - (Date.now() - clickedBy)));
        } finally {
          tab.off("request", sent).off("requestfinished", settled).off("requestfailed", settled);
          if (tracing) trace = await browser.stopTracing().catch(() => null);
        }
        if (!window) return null;
        const seen = await tab.evaluate(
          ({ start, end }) => ({
            requests: (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
              .filter((r) => r.startTime >= start && r.startTime < end + 1000 && new URL(r.name).pathname.startsWith("/api/"))
              .map((r) => ({ pathname: new URL(r.name).pathname, startMs: r.startTime - start, sentMs: (r.requestStart || r.fetchStart) - start, responseMs: (r.responseStart || r.responseEnd) - start, endMs: r.responseEnd - start, bytes: r.transferSize })),
            longTasks: (window as unknown as { __perfLongTasks: { start: number; duration: number }[] }).__perfLongTasks.map((t) => ({ startMs: t.start - start, durationMs: t.duration })),
            bufferFull: (window as unknown as { __perfBufferFull?: boolean }).__perfBufferFull === true,
          }),
          window,
        );
        if (seen.bufferFull && !warnings.includes(BUFFER_FULL)) warnings.push(BUFFER_FULL);
        const requests: SwitchRequest[] = seen.requests.map(({ pathname, ...r }) => ({ path: routeOf(pathname), message: carriesMessages(pathname), ...r }));
        const timing = switchTiming(window.end - window.start, requests, seen.longTasks satisfies SwitchLongTask[], window.handled - window.start);
        if (!args.trace) return timing;
        const warn = (text: string) => void (warnings.includes(text) || warnings.push(text));
        let events: TraceEvent[] | null = null;
        try {
          events = trace ? (JSON.parse(trace.toString()) as { traceEvents: TraceEvent[] }).traceEvents : null;
        } catch {
          events = null;
        }
        if (!Array.isArray(events)) {
          warn(NO_TRACE);
          return { ...timing, work: null };
        }
        const work = workSplit(events, TRACE_WINDOW_MS);
        if (!work) warn(NO_CLICK_IN_TRACE);
        else if (work.recordedMs < TRACE_WINDOW_MS) warn(SHORT_TRACE);
        return { ...timing, work };
      } catch {
        return null;
      }
    };
    const inSidebar = (tab: Page, channel: Named) => tab.locator("[data-testid=sidebar-root]").getByText(channel.name, { exact: true }).first();

    const page = await openTab(busy);
    const scroller = page.locator("[data-testid=message-scroller]").first();
    release = await page.evaluate(() => {
      try {
        return JSON.parse(document.getElementById("raft-frontend-release-identity")?.textContent ?? "{}");
      } catch {
        return {};
      }
    });
    if (args.jsonl && !args.env && !release.deploymentEnvironment) fail("the page names no environment; pass --env");

    // Per run, what a tab that has never shown the busy channel does: the first visit, then a thread. Each in its own browser context.
    const fresh: Pick<InteractRun, "firstVisit" | "threadOpen">[] = [];
    /** What was seen of the host beside each part of a run (src/hostHealth.ts): a benchmark and a pressure reading before, the same after. */
    const beside = async <T>(part: () => Promise<T>): Promise<{ value: T; host: HostSample }> => {
      const before = { benchMs: hostBenchmark(), pressure: readPressure(), at: Date.now() };
      const value = await part();
      return { value, host: { ...stallShares(before.pressure, readPressure(), Date.now() - before.at), benchMs: Math.max(before.benchMs, hostBenchmark()) } };
    };
    // the first run of the benchmark is slower while it is compiled: take it before any run is sampled (as measure does)
    hostBenchmark();
    const freshHost: HostSample[] = [];
    for (let i = 0; i < runs; i++) {
      const { value, host } = await beside(async () => {
        const tab = await openTab(other);
        try {
          const firstVisit = await timedClick(tab, inSidebar(tab, busy), busy.id);
          await tab.waitForTimeout(1000);
          // without the first visit the tab is not on the busy channel: its thread is not there to open
          const replies = tab.locator("[data-testid=message-scroller] [data-message-affordance=inline-thread-replies]");
          const threads = firstVisit ? await replies.count() : 0;
          hasThread ||= threads > 0;
          return { firstVisit, threadOpen: threads > 0 ? await timedClick(tab, replies.last(), "thread") : null };
        } finally {
          await tab.context().close();
        }
      });
      fresh.push(value);
      freshHost.push(host);
    }

    const scroll = async (direction: 1 | -1): Promise<{ stats: FrameStats | null; longtaskMs: number }> => {
      const box = (await scroller.boundingBox()) ?? fail("the message list has no box");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.evaluate(() => {
        const w = window as unknown as { __perfFrames: number[]; __perfRunning: boolean; __perfScrollStart: number };
        w.__perfFrames = [];
        w.__perfRunning = true;
        w.__perfScrollStart = performance.now();
        let last = performance.now();
        const tick = (t: number) => {
          w.__perfFrames.push(t - last);
          last = t;
          if (w.__perfRunning) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      for (let i = 0; i < SCROLL_STEPS; i++) {
        await page.mouse.wheel(0, direction * SCROLL_STEP_PX);
        await page.waitForTimeout(16);
      }
      // Stop the frame capture two frames after the last wheel event: an idle tail would dilute the slow share.
      const frames = await page.evaluate(
        () =>
          new Promise<number[]>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const w = window as unknown as { __perfFrames: number[]; __perfRunning: boolean };
                w.__perfRunning = false;
                // the first interval spans the time before the first frame, not a frame
                resolve(w.__perfFrames.slice(1));
              }),
            ),
          ),
      );
      // Long tasks are delivered late: give the observer time, then count those that started during the scroll.
      await page.waitForTimeout(600);
      const read = await page.evaluate(() => {
        const w = window as unknown as { __perfScrollStart: number; __perfLongTasks: { start: number; duration: number }[] };
        return { longtaskMs: w.__perfLongTasks.filter((t) => t.start >= w.__perfScrollStart).reduce((a, t) => a + t.duration, 0) };
      });
      return { stats: frameStats(frames), longtaskMs: Math.round(read.longtaskMs) };
    };

    for (let i = 0; i < runs; i++) {
      const { value, host: mainHost } = await beside(async () => {
        const up = await scroll(-1);
        const down = await scroll(1);
        const away = await timedClick(page, inSidebar(page, other), other.id);
        await page.waitForTimeout(1000);
        const back = await timedClick(page, inSidebar(page, busy), busy.id);
        await page.waitForTimeout(1500);
        return { up, down, away, back };
      });
      const { up, down, away, back } = value;
      hostSamples.push(worseSample(freshHost[i]!, mainHost));
      results.push({ scrollUp: up.stats, scrollDown: down.stats, scrollLongtaskMs: up.longtaskMs + down.longtaskMs, switchAwayMs: away?.totalMs ?? null, switchBackMs: back?.totalMs ?? null, switchAway: away, switchBack: back, ...fresh[i]!, domNodes: await page.evaluate(() => document.querySelectorAll("*").length) });
    }
  } finally {
    await browser.close();
  }

  // A run taken while something else had the machine says more about the machine than about the page: it stays in `runs`, out of the medians.
  const hostSeen = busyRuns(hostSamples, args["keep-busy"]);
  const kept = results.filter((_, i) => !hostSeen.leftOut.includes(i));
  const medOf = (of: readonly InteractRun[]) => (pick: (r: InteractRun) => number | null | undefined) => {
    const m = median(of.map(pick).filter((v): v is number => v != null));
    return m == null ? null : Math.round(m * 10) / 10;
  };
  const switchesOf = (of: readonly InteractRun[]) => of.flatMap((r) => [r.firstVisit, r.threadOpen, r.switchAway, r.switchBack]).filter((t): t is SwitchTiming => t != null);
  const switches = switchesOf(kept);
  const worst = (a: FrameStats | null, b: FrameStats | null, key: "slowPct" | "p95Ms" | "maxMs") => (a && b ? Math.max(a[key], b[key]) : (a ?? b)?.[key] ?? null);
  /** The numbers watermarks are set on: medians over the runs kept (all of them unless the host was busy for some); per run, the worse of the two scroll directions. */
  const metricsOf = (of: readonly InteractRun[]) => {
    const med = medOf(of);
    const switches = switchesOf(of);
    return {
      scroll_slow_frame_pct: med((r) => worst(r.scrollUp, r.scrollDown, "slowPct")),
      scroll_frame_p95_ms: med((r) => worst(r.scrollUp, r.scrollDown, "p95Ms")),
      scroll_frame_max_ms: med((r) => worst(r.scrollUp, r.scrollDown, "maxMs")),
      scroll_longtask_ms: med((r) => r.scrollLongtaskMs),
      channel_switch_ms: med((r) => (r.switchAwayMs != null && r.switchBackMs != null ? Math.max(r.switchAwayMs, r.switchBackMs) : null)),
      channel_first_visit_ms: med((r) => r.firstVisit?.totalMs),
      /** …and when the view was also current: the refresh behind a local paint had arrived. */
      channel_first_visit_settled_ms: med((r) => r.firstVisit?.settledMs),
      channel_switch_settled_ms: med((r) => (r.switchAway && r.switchBack ? Math.max(r.switchAway.settledMs, r.switchBack.settledMs) : null)),
      thread_open_ms: med((r) => r.threadOpen?.totalMs),
      /** Over every switch measured: the share of its time the main thread was busy, and how long after the click the messages were asked for. */
      switch_main_thread_pct: (() => {
        const m = median(switches.filter((t) => t.totalMs > 0).map((t) => (100 * t.mainThreadMs) / t.totalMs));
        return m == null ? null : Math.round(m * 10) / 10;
      })(),
      switch_request_delay_ms: median(switches.map((t) => t.requestDelayMs).filter((v): v is number => v != null)),
      /** …of which, over the same switches (those that asked): the browser was busy before the page handled the click (the runner's share), and the rest (the app's). */
      switch_input_delay_ms: median(switches.filter((t) => t.requestDelayMs != null).map((t) => t.inputDelayMs)),
      switch_app_request_delay_ms: median(switches.map((t) => t.appRequestDelayMs).filter((v): v is number => v != null)),
      dom_node_count: med((r) => r.domNodes),
    };
  };
  const metrics = metricsOf(kept);
  /** The same medians over every run, when some were left out: a change that makes the page heavier can make its own runs read busy, and this shows what leaving them out moved. */
  const metricsAllRuns = hostSeen.leftOut.length ? metricsOf(results) : null;
  /** One switch as row columns, each named with its unit; the cache state as two 0/1 counts (neither: a hit). All null when it was not measured. */
  const switchExtra = (name: string, t: SwitchTiming | null): Record<string, number | null> => ({
    [`${name}_settled_ms`]: t?.settledMs ?? null,
    [`${name}_main_thread_ms`]: t?.mainThreadMs ?? null,
    [`${name}_request_delay_ms`]: t?.requestDelayMs ?? null,
    [`${name}_message_request_count`]: t?.messageRequests ?? null,
    [`${name}_input_delay_ms`]: t?.inputDelayMs ?? null,
    [`${name}_app_request_delay_ms`]: t?.appRequestDelayMs ?? null,
    [`${name}_waited_start_ms`]: t?.waitedStartMs ?? null,
    [`${name}_queue_ms`]: t?.queueMs ?? null,
    [`${name}_ttfb_ms`]: t?.ttfbMs ?? null,
    [`${name}_download_ms`]: t?.downloadMs ?? null,
    [`${name}_render_ms`]: t?.renderMs ?? null,
    [`${name}_request_count`]: t?.requests ?? null,
    [`${name}_bytes`]: t?.bytes ?? null,
    [`${name}_miss_count`]: t ? (t.cache === "miss" ? 1 : 0) : null,
    [`${name}_stale_count`]: t ? (t.cache === "stale" ? 1 : 0) : null,
  });
  /** With --trace, per kind of switch over the runs kept: medians of what the main thread did in the window after the click. */
  const workOf = (pick: (r: InteractRun) => TimedSwitch | null) => {
    const splits = kept.map((r) => pick(r)?.work).filter((w): w is WorkSplit => w != null);
    if (!splits.length) return null;
    const med = (of: (w: WorkSplit) => number) => Math.round(median(splits.map(of))! * 10) / 10;
    return { switches: splits.length, taskMs: med((w) => w.taskMs), scriptMs: med((w) => w.scriptMs), styleMs: med((w) => w.styleMs), layoutMs: med((w) => w.layoutMs), forcedMs: med((w) => w.forcedMs), stylePasses: med((w) => w.stylePasses), styleElements: med((w) => w.styleElements), layouts: med((w) => w.layouts), largeStylePasses: med((w) => w.largeStylePasses.length) };
  };
  const work = args.trace ? { windowMs: TRACE_WINDOW_MS, channel_first_visit: workOf((r) => r.firstVisit), thread_open: workOf((r) => r.threadOpen), channel_switch_away: workOf((r) => r.switchAway), channel_switch_back: workOf((r) => r.switchBack) } : null;
  const cacheCounts = { hit: 0, stale: 0, miss: 0 };
  for (const t of switches) cacheCounts[t.cache]++;
  if (results.some((r) => !r.scrollUp || !r.scrollDown)) warnings.push("a scroll produced too few frames to measure");
  if (results.some((r) => r.switchAwayMs == null || r.switchBackMs == null || r.firstVisit == null)) warnings.push("a channel switch did not finish in 15 s");
  if (hasThread && results.some((r) => r.threadOpen == null)) warnings.push("a thread did not open in 15 s");
  // only a first visit that worked could look for a thread
  const notes: string[] = hasThread || results.every((r) => r.firstVisit == null) ? [] : [`#${busy.name} has no message with replies: thread_open_ms was not measured`];
  if (args.trace) notes.push("taken with --trace: recording can slow the page, so do not hold these timings against a watermark or put them beside an untraced run's");
  const busyRunNumbers = hostSeen.busy.flatMap((b, i) => (b ? [i + 1] : []));
  if (hostSeen.allBusy) warnings.push(`every run was taken on a busy host (by ${hostSeen.by}): the numbers say more about the machine than about the page`);
  else if (busyRunNumbers.length) notes.push(`run(s) ${busyRunNumbers.join(", ")} ${args["keep-busy"] ? "taken on a busy host (kept: --keep-busy)" : `left out of the medians: the host was busy (by ${hostSeen.by})`}`);
  const measuredAt = new Date().toISOString();
  const cpus = availableParallelism();
  const cohort = buildCohort({
    browserWhere: "local",
    edgeColo: dominantString(edgeColos),
    hostCpuCount: cpus,
    hostBenchmarkMs: hostSeen.benchmarkMedianMs,
    device: deviceProbe,
    connectRttSamplesMs: connectRtts,
    net: "fast",
    fixture: verifiedFixtureTag,
  });
  const report = { tool: "raft-perf interact", measuredAt, origin, page: { server: server.slug, channel: busy.name, other: other.name }, cohort, commitSha: release.commitSha ?? null, requestedRuns: runs, metrics, ...(metricsAllRuns ? { metricsAllRuns } : {}), ...(work ? { work } : {}), switchCache: cacheCounts, warnings, notes, host: { by: hostSeen.by, cpus, benchmarkMedianMs: hostSeen.benchmarkMedianMs, runs: hostSamples, busyRuns: busyRunNumbers, leftOut: hostSeen.leftOut.map((i) => i + 1) }, runs: results };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (args.out) writeFileSync(args.out, `${text}\n`);
  if (args.jsonl) {
    const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const runId = args["run-id"] ?? randomUUID();
    const cohortFields = cohortExtra(cohort);
    const rows: PageRunRow[] = results.map((r, i) => ({
      project: args.project!,
      env: args.env ?? release.deploymentEnvironment!,
      run_id: runId,
      tool_version: toolVersion,
      taken_at: measuredAt,
      origin,
      commit_sha: release.commitSha ?? null,
      page: "channel",
      state: "interact",
      net: "fast",
      ab: "none",
      arm: "on",
      run_idx: i,
      lcp_ms: null,
      inp_ms: null,
      cls: null,
      ttfb_ms: null,
      fcp_ms: null,
      // not an A/B: "measured" when every step of the collection completed, "unknown" when a warning says one did not
      verdict: warnings.length ? "unknown" : "measured",
      extra: {
        scroll_slow_frame_pct: worst(r.scrollUp, r.scrollDown, "slowPct"),
        scroll_frame_p95_ms: worst(r.scrollUp, r.scrollDown, "p95Ms"),
        scroll_frame_max_ms: worst(r.scrollUp, r.scrollDown, "maxMs"),
        scroll_longtask_ms: r.scrollLongtaskMs,
        channel_switch_ms: r.switchAwayMs != null && r.switchBackMs != null ? Math.max(r.switchAwayMs, r.switchBackMs) : null,
        channel_switch_away_ms: r.switchAwayMs,
        channel_switch_back_ms: r.switchBackMs,
        channel_first_visit_ms: r.firstVisit?.totalMs ?? null,
        thread_open_ms: r.threadOpen?.totalMs ?? null,
        ...switchExtra("channel_first_visit", r.firstVisit),
        ...switchExtra("thread_open", r.threadOpen),
        ...switchExtra("channel_switch_away", r.switchAway),
        ...switchExtra("channel_switch_back", r.switchBack),
        dom_node_count: r.domNodes,
        // 1 when this run was taken on a busy host; 1 when it was left out of the report's medians for it (readers of the rows skip those: claims.ts metricRuns)
        host_busy: hostSeen.busy[i] ? 1 : 0,
        host_left_out: hostSeen.leftOut.includes(i) ? 1 : 0,
        ...hostExtra(cpus, hostSeen.benchmarkMedianMs),
        ...cohortFields,
      },
    }));
    writeFileSync(args.jsonl, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  if (args["diagnose-jsonl"] && work) {
    const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const diagRows = interactTraceReportToRows(report, {
      project: args.project!,
      env: args.env ?? release.deploymentEnvironment ?? (production ? "production" : "staging"),
      runId: args["run-id"] ?? randomUUID(),
      toolVersion,
      backfilled: false,
    });
    writeFileSync(args["diagnose-jsonl"], diagRows.map((r) => JSON.stringify(r)).join("\n") + (diagRows.length ? "\n" : ""));
  }
  process.stderr.write(
    `raft-perf interact ${busy.name}: slow frames ${metrics.scroll_slow_frame_pct}% (p95 ${metrics.scroll_frame_p95_ms} ms), channel switch ${metrics.channel_switch_ms} ms (first visit ${metrics.channel_first_visit_ms}, current after ${metrics.channel_first_visit_settled_ms}; thread ${metrics.thread_open_ms}; main thread ${metrics.switch_main_thread_pct}% of a switch, messages asked for ${metrics.switch_request_delay_ms} ms after the click (${metrics.switch_input_delay_ms} ms of it input delay); cache hit/stale/miss ${cacheCounts.hit}/${cacheCounts.stale}/${cacheCounts.miss})` + (warnings.length ? `; ${warnings.length} warning(s)` : "") + "\n",
  );
  if (work)
    for (const [name, w] of Object.entries(work))
      if (w && typeof w === "object") process.stderr.write(`  ${name}, ${TRACE_WINDOW_MS / 1000} s after the click: tasks ${w.taskMs} ms, of it script ${w.scriptMs}, style ${w.styleMs}, layout ${w.layoutMs} (${w.forcedMs} of style and layout forced from script); ${w.largeStylePasses} large style pass(es), ${w.styleElements} elements restyled\n`);
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf interact: ${error instanceof InteractError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
