#!/usr/bin/env node
/**
 * raft-perf resize: measure viewport resize jank (dropped/long frames,
 * session-window CLS, long tasks, and forced layout) across responsive desktop,
 * tablet, and mobile breakpoints (#proj-frontend:#78).
 *
 * Writes standard `perf.page_runs` JSONL rows (`state = "resize"`) with the
 * top-level `cls` column populated and frame/layout details in `extra`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { cliArgs } from "./args";
import { fetchAndVerifyFixture } from "./benchCheck";
import { loadBenchFixture, resolveFixtureTargets } from "./benchFixture";
import {
  type BrowserDeviceProbe,
  buildCohort,
  cohortExtra,
  dominantString,
  parseConnectRttMs,
  parseEdgeColo,
  probeBrowserDevice,
} from "./cohort";
import { median } from "./frames";
import { type HostSample, busyRuns, hostBenchmark, hostExtra, readPressure, stallShares, worseSample } from "./hostHealth";
import { isProductionHost } from "./page";
import type { PageRunRow } from "./pageRuns";
import { DEFAULT_RESIZE_WIDTHS, type RawLayoutShift, type ResizeRunSummary, summarizeResizeRun } from "./resizeStats";
import { DIAGNOSE_TRACE_CATEGORIES, type TraceEvent, findTraceMark, workSplitRange } from "./workSplit";

const HELP = `raft-perf resize — measure viewport resize jank, CLS, and forced layout on a signed-in Raft channel

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --origin <url>      web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default: --origin)
  --fixture <name>    frozen benchmark fixture (e.g. bench-v1): sets --server/--channel and verifies digest
  --server <slug>     server slug (required unless --fixture sets it)
  --channel <name>    target channel (required unless --fixture sets it)
  --runs <n>          repetitions (default 3)
  --trace             also record Chrome trace during resize to capture forced layout / style ms
  --keep-busy         keep runs taken while the host was busy in the medians
  --out <file>        also write JSON report here
  --jsonl <file>      also write one perf.page_runs row per run (state="resize", populates cls); needs --project
  --project <name>    with --jsonl: product name (e.g. raft-web)
  --env <env>         with --jsonl: environment override
  --run-id <id>       with --jsonl: shared run_id across a collection (default: a new UUID)
  --chromium-arg <a>  extra Chromium switch (repeatable)
  --allow-production  measure *.raft.build
`;

class ResizeError extends Error {}
const fail = (message: string): never => {
  throw new ResizeError(message);
};

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    args: cliArgs(),
    options: {
      origin: { type: "string", default: "https://raft-app-staging.botiverse.dev" },
      api: { type: "string" },
      fixture: { type: "string" },
      server: { type: "string" },
      channel: { type: "string" },
      runs: { type: "string", default: "3" },
      trace: { type: "boolean", default: false },
      "keep-busy": { type: "boolean", default: false },
      out: { type: "string" },
      jsonl: { type: "string" },
      project: { type: "string" },
      env: { type: "string" },
      "run-id": { type: "string" },
      "chromium-arg": { type: "string", multiple: true, default: [] },
      "allow-production": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const origin = args.origin!.replace(/\/$/, "");
  const defaultApi = origin.includes("raft-app-staging.botiverse.dev") ? "https://api-aws-staging.botiverse.dev" : origin;
  const api = (args.api ?? defaultApi).replace(/\/$/, "");
  const runs = Number(args.runs);
  if (!Number.isInteger(runs) || runs < 1) fail("--runs must be an integer of at least 1");
  if (args.jsonl && !args.project) fail("--jsonl needs --project (which product this web belongs to)");

  const fixtureSpec = args.fixture ? loadBenchFixture(args.fixture) : null;
  const resolved = resolveFixtureTargets(
    fixtureSpec,
    { server: args.server, channel: args.channel },
    { channel: "", other: "all" },
  );
  if (!resolved.server) fail("--server <slug> (or --fixture <name>) is required");
  if (!resolved.channel) fail("--channel <name> (or --fixture <name>) is required");

  let production = false;
  try {
    production = isProductionHost(origin) || isProductionHost(api);
  } catch {
    return fail("--origin and --api must be valid URLs");
  }
  if (production && !args["allow-production"]) fail("refusing a production origin or API without --allow-production");

  const email = process.env.RAFT_PERF_EMAIL;
  const password = process.env.RAFT_PERF_PASSWORD;
  if (!email || !password) fail("set RAFT_PERF_EMAIL and RAFT_PERF_PASSWORD (a test account)");

  async function json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(url, init).catch((e: Error) => fail(`${new URL(url).pathname} failed: ${e.message}`));
    if (!response.ok) fail(`${new URL(url).pathname} answered ${response.status}`);
    return response.json().catch(() => fail(`${new URL(url).pathname} did not answer JSON`));
  }

  const session = (await json(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })) as { accessToken?: string; refreshToken?: string };
  if (!session.accessToken || !session.refreshToken) fail("sign-in returned no tokens");
  const accessToken = session.accessToken!;
  const refreshToken = session.refreshToken!;
  const auth = { authorization: `Bearer ${accessToken}` };

  type Named = { id: string; name: string };
  const servers = (await json(`${api}/api/servers`, { headers: auth })) as Array<{ id: string; slug: string }> | { servers: Array<{ id: string; slug: string }> };
  const server = (Array.isArray(servers) ? servers : servers.servers).find((s) => s.slug === resolved.server) ?? fail(`account is not a member of ${resolved.server}`);
  const channels = (await json(`${api}/api/channels`, { headers: { ...auth, "x-server-id": server.id } })) as Named[] | { channels: Named[] };
  const list = Array.isArray(channels) ? channels : channels.channels;
  const targetChannel = list.find((c) => c.name === resolved.channel) ?? fail(`no channel ${resolved.channel} in ${resolved.server}`);

  let verifiedFixtureTag: string | null = null;
  if (fixtureSpec) {
    const check = await fetchAndVerifyFixture(api, accessToken, server.id, targetChannel.id, fixtureSpec);
    if (!check.ok) fail(`fixture ${fixtureSpec.fixture} drifted (${check.mismatches.join("; ")})`);
    verifiedFixtureTag = check.tag;
  }

  const browser = await chromium.launch({ args: args["chromium-arg"] });
  const results: ResizeRunSummary[] = [];
  const hostSamples: HostSample[] = [];
  const edgeColos: string[] = [];
  const connectRtts: number[] = [];
  const warnings: string[] = [];
  let release: { commitSha?: string; deploymentEnvironment?: string } = {};
  let deviceProbe: BrowserDeviceProbe | null = null;

  try {
    deviceProbe = await probeBrowserDevice(browser);
    for (let runIdx = 0; runIdx < runs; runIdx += 1) {
      const benchBefore = hostBenchmark();
      const p0 = readPressure();
      const tWall0 = performance.now();

      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
        storageState: {
          cookies: [],
          origins: [
            {
              origin,
              localStorage: [
                { name: "slock_access_token", value: accessToken },
                { name: "slock_refresh_token", value: refreshToken },
              ],
            },
          ],
        },
      });
      const page = await context.newPage();
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        cdp.on("Network.responseReceived", (e) => {
          if (e.type === "Document" || e.response.url.startsWith(`${api}/api/`)) {
            const colo = parseEdgeColo(e.response.headers);
            if (colo) edgeColos.push(colo);
            const rtt = parseConnectRttMs(e.response.timing, e.response.protocol);
            if (rtt != null) connectRtts.push(rtt);
          }
        });

        await page.addInitScript(() => {
          const w = window as unknown as {
            __perfResizeShifts: RawLayoutShift[];
            __perfResizeLongTasks: Array<{ start: number; duration: number }>;
            __perfResizeFrames: number[];
            __perfResizeArmed: boolean;
            __perfResizeStopRaf?: () => void;
          };
          w.__perfResizeShifts = [];
          w.__perfResizeLongTasks = [];
          w.__perfResizeFrames = [];
          w.__perfResizeArmed = false;
          try {
            new PerformanceObserver((list) => {
              if (!w.__perfResizeArmed) return;
              for (const entry of list.getEntries()) {
                const ls = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
                w.__perfResizeShifts.push({
                  startTime: ls.startTime,
                  value: ls.value ?? 0,
                  hadRecentInput: Boolean(ls.hadRecentInput),
                });
              }
            }).observe({ type: "layout-shift", buffered: false });
          } catch {
            /* unsupported */
          }
          try {
            new PerformanceObserver((list) => {
              if (!w.__perfResizeArmed) return;
              for (const entry of list.getEntries()) {
                w.__perfResizeLongTasks.push({ start: entry.startTime, duration: entry.duration });
              }
            }).observe({ type: "longtask", buffered: false });
          } catch {
            /* unsupported */
          }
        });

        await page.goto(`${origin}/s/${server.slug}/channel/${targetChannel.id}`, { waitUntil: "load", timeout: 120_000 });
        await cdp.send("Network.disable").catch(() => {});
        await cdp.detach().catch(() => {});
        await page.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 });
        await page.waitForTimeout(3000);

        if (!release.commitSha) {
          const rawRelease = await page.evaluate(() => document.getElementById("raft-frontend-release-identity")?.textContent ?? null);
          if (rawRelease) {
            try {
              release = JSON.parse(rawRelease) as { commitSha?: string; deploymentEnvironment?: string };
            } catch {
              /* ignore */
            }
          }
        }

        const tracing = args.trace && (await browser.startTracing(page, { categories: DIAGNOSE_TRACE_CATEGORIES }).then(() => true, () => false));

        await page.evaluate(() => {
          const w = window as unknown as {
            __perfResizeShifts: RawLayoutShift[];
            __perfResizeLongTasks: Array<{ start: number; duration: number }>;
            __perfResizeFrames: number[];
            __perfResizeArmed: boolean;
            __perfResizeStopRaf?: () => void;
          };
          w.__perfResizeShifts = [];
          w.__perfResizeLongTasks = [];
          w.__perfResizeFrames = [];
          w.__perfResizeArmed = true;
          performance.mark("__raft_perf_resize_start");
          let running = true;
          const tick = (ts: number) => {
            if (!running) return;
            w.__perfResizeFrames.push(ts);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          w.__perfResizeStopRaf = () => {
            running = false;
          };
        });

        for (const width of DEFAULT_RESIZE_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForTimeout(120);
        }
        await page.waitForTimeout(250);

        const captured = await page.evaluate(() => {
          const w = window as unknown as {
            __perfResizeShifts: RawLayoutShift[];
            __perfResizeLongTasks: Array<{ start: number; duration: number }>;
            __perfResizeFrames: number[];
            __perfResizeStopRaf?: () => void;
          };
          w.__perfResizeStopRaf?.();
          performance.mark("__raft_perf_resize_end");
          const longtaskMs = (w.__perfResizeLongTasks ?? []).reduce((s, t) => s + t.duration, 0);
          return {
            frames: w.__perfResizeFrames ?? [],
            shifts: w.__perfResizeShifts ?? [],
            longtaskMs,
          };
        });

        let forcedLayoutMs: number | null = null;
        let styleMs: number | null = null;
        let layoutMs: number | null = null;
        if (tracing) {
          try {
            const buf = await browser.stopTracing();
            const parsed = JSON.parse(buf.toString("utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
            const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
            const m0 = findTraceMark(events, "__raft_perf_resize_start");
            const m1 = findTraceMark(events, "__raft_perf_resize_end");
            if (m0 && m1 && m1.ts > m0.ts) {
              const split = workSplitRange(events, m0.pid, m0.tid, m0.ts, m1.ts);
              forcedLayoutMs = split.forcedMs;
              styleMs = split.styleMs;
              layoutMs = split.layoutMs;
            }
          } catch {
            /* ignore trace errors */
          }
        }

        const summary = summarizeResizeRun({
          steps: DEFAULT_RESIZE_WIDTHS.length,
          frameStampsMs: captured.frames,
          layoutShifts: captured.shifts,
          longtaskMs: captured.longtaskMs,
          forcedLayoutMs,
          styleMs,
          layoutMs,
        });
        if (!summary.frames) warnings.push(`run ${runIdx + 1}: too few frames captured during resize`);
        results.push(summary);
      } finally {
        await context.close().catch(() => {});
      }

      const wallMs = performance.now() - tWall0;
      const p1 = readPressure();
      const benchAfter = hostBenchmark();
      const sample: HostSample = {
        benchMs: Math.max(benchBefore, benchAfter),
        ...stallShares(p0, p1, wallMs),
      };
      hostSamples.push(worseSample(sample, sample));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const hostSeen = busyRuns(hostSamples, args["keep-busy"]);
  const kept = results.filter((_, i) => !hostSeen.leftOut.includes(i));
  const med = (pick: (r: ResizeRunSummary) => number | null | undefined, digits = 1): number | null => {
    const vals = kept.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const m = median(vals);
    if (m == null) return null;
    const scale = 10 ** digits;
    return Math.round(m * scale) / scale;
  };
  const metrics = {
    cls: med((r) => r.cls, 4),
    resize_slow_frame_pct: med((r) => r.frames?.slowPct),
    resize_frame_p95_ms: med((r) => r.frames?.p95Ms),
    resize_frame_max_ms: med((r) => r.frames?.maxMs),
    resize_dropped_frames: med((r) => r.droppedFrames, 0),
    resize_long_frames: med((r) => r.longFrames, 0),
    resize_longtask_ms: med((r) => r.longtaskMs),
    resize_forced_layout_ms: med((r) => r.forcedLayoutMs),
    resize_style_ms: med((r) => r.styleMs),
    resize_layout_ms: med((r) => r.layoutMs),
  };

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

  const report = {
    tool: "raft-perf resize",
    measuredAt,
    origin,
    page: { server: server.slug, channel: targetChannel.name },
    cohort,
    commitSha: release.commitSha ?? null,
    requestedRuns: runs,
    widths: DEFAULT_RESIZE_WIDTHS,
    metrics,
    warnings,
    runs: results,
  };
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(`${text}\n`);
  if (args.out) {
    mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    writeFileSync(args.out, `${text}\n`);
  }
  if (args.jsonl) {
    const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    const runId = args["run-id"] ?? randomUUID();
    const env = args.env ?? release.deploymentEnvironment ?? (production ? "production" : "staging");
    const cohortFields = cohortExtra(cohort);
    const rows: PageRunRow[] = results.map((r, i) => ({
      project: args.project!,
      env,
      run_id: runId,
      tool_version: toolVersion,
      taken_at: measuredAt,
      origin,
      commit_sha: release.commitSha ?? null,
      page: "channel",
      state: "resize",
      net: "fast",
      ab: "none",
      arm: "on",
      run_idx: i,
      lcp_ms: null,
      inp_ms: null,
      cls: r.cls,
      ttfb_ms: null,
      fcp_ms: null,
      verdict: warnings.length ? "unknown" : "measured",
      extra: {
        resize_steps: r.steps,
        resize_slow_frame_pct: r.frames?.slowPct ?? null,
        resize_frame_p95_ms: r.frames?.p95Ms ?? null,
        resize_frame_max_ms: r.frames?.maxMs ?? null,
        resize_dropped_frames: r.droppedFrames,
        resize_long_frames: r.longFrames,
        resize_longtask_ms: r.longtaskMs,
        resize_forced_layout_ms: r.forcedLayoutMs,
        resize_style_ms: r.styleMs,
        resize_layout_ms: r.layoutMs,
        host_busy: hostSeen.busy[i] ? 1 : 0,
        host_left_out: hostSeen.leftOut.includes(i) ? 1 : 0,
        ...hostExtra(cpus, hostSeen.benchmarkMedianMs),
        ...cohortFields,
      },
    }));
    const outPath = path.resolve(args.jsonl);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  process.stderr.write(
    `raft-perf resize #${targetChannel.name}: CLS ${metrics.cls ?? "-"}, slow frames ${metrics.resize_slow_frame_pct ?? "-"}% (p95 ${metrics.resize_frame_p95_ms ?? "-"} ms, dropped ${metrics.resize_dropped_frames ?? 0})\n`,
  );
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf resize: ${error instanceof ResizeError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
