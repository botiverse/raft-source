#!/usr/bin/env node
/**
 * raft-perf input: real interactive INP (Interaction to Next Paint) measurement
 * on a signed-in Raft web channel (#proj-frontend:#78).
 *
 * Exercises read-safe keyboard typing (focuses composer if present, types a
 * probe burst without pressing Enter, then clears the draft) and UI clicks
 * (channel switching and panel tab / header toggles), capturing W3C Event Timing
 * entries grouped by `interactionId` plus Long Tasks.
 *
 * Writes standard `perf.page_runs` JSONL rows (`state = "input"`) with the
 * top-level `inp_ms` column populated and detailed key/click percentiles in `extra`.
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
import { type InputLatencySummary, type RawEventTimingEntry, summarizeInputInteractions } from "./inputStats";
import { isProductionHost } from "./page";
import type { PageRunRow } from "./pageRuns";

const HELP = `raft-perf input — measure real interactive INP (typing + UI clicks) and populate perf.page_runs.inp_ms

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --origin <url>      web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default: --origin)
  --fixture <name>    frozen benchmark fixture (e.g. bench-v1): sets --server/--channel/--other and verifies digest
  --server <slug>     server slug (required unless --fixture sets it)
  --channel <name>    target channel (required unless --fixture sets it)
  --other <name>      secondary channel for click interactions (default all, or fixture's secondary channel)
  --runs <n>          repetitions (default 3)
  --keep-busy         keep runs taken while the host was busy in the medians
  --out <file>        also write JSON report here
  --jsonl <file>      also write one perf.page_runs row per run (populates inp_ms); needs --project
  --project <name>    with --jsonl: product name (e.g. raft-web)
  --env <env>         with --jsonl: environment override
  --run-id <id>       with --jsonl: shared run_id across a collection (default: a new UUID)
  --chromium-arg <a>  extra Chromium switch (repeatable)
  --allow-production  measure *.raft.build
`;

const PROBE_TEXT = "raft perf inp probe 1234567890";

class InputError extends Error {}
const fail = (message: string): never => {
  throw new InputError(message);
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
      other: { type: "string" },
      runs: { type: "string", default: "3" },
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
    { server: args.server, channel: args.channel, other: args.other },
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
  const otherChannel = list.find((c) => c.name === resolved.other) ?? null;

  let verifiedFixtureTag: string | null = null;
  if (fixtureSpec) {
    const check = await fetchAndVerifyFixture(api, accessToken, server.id, targetChannel.id, fixtureSpec);
    if (!check.ok) fail(`fixture ${fixtureSpec.fixture} drifted (${check.mismatches.join("; ")})`);
    verifiedFixtureTag = check.tag;
  }

  const browser = await chromium.launch({ args: args["chromium-arg"] });
  const results: InputLatencySummary[] = [];
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
            __perfInputEvents: Array<{
              name: string;
              interactionId: number;
              startTime: number;
              duration: number;
              processingStart?: number;
              processingEnd?: number;
            }>;
            __perfInputLongTasks: Array<{ start: number; duration: number }>;
            __perfInputArmed: boolean;
          };
          w.__perfInputEvents = [];
          w.__perfInputLongTasks = [];
          w.__perfInputArmed = false;
          try {
            new PerformanceObserver((list) => {
              if (!w.__perfInputArmed) return;
              for (const entry of list.getEntries()) {
                const e = entry as PerformanceEntry & {
                  interactionId?: number;
                  processingStart?: number;
                  processingEnd?: number;
                };
                if (typeof e.interactionId === "number" && e.interactionId > 0) {
                  w.__perfInputEvents.push({
                    name: e.name,
                    interactionId: e.interactionId,
                    startTime: e.startTime,
                    duration: e.duration,
                    processingStart: e.processingStart,
                    processingEnd: e.processingEnd,
                  });
                }
              }
            }).observe({ type: "event", buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
          } catch {
            /* unsupported */
          }
          try {
            new PerformanceObserver((list) => {
              if (!w.__perfInputArmed) return;
              for (const entry of list.getEntries()) {
                w.__perfInputLongTasks.push({ start: entry.startTime, duration: entry.duration });
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

        // Arm observers after initial page settle so boot events do not pollute INP
        await page.evaluate(() => {
          const w = window as unknown as {
            __perfInputEvents: unknown[];
            __perfInputLongTasks: unknown[];
            __perfInputArmed: boolean;
          };
          w.__perfInputEvents = [];
          w.__perfInputLongTasks = [];
          w.__perfInputArmed = true;
        });

        // 1. Composer keyboard interaction burst (read-safe: never presses Enter; clears draft afterwards)
        const composer = page.locator("textarea:visible, [contenteditable='true']:visible, [role='textbox']:visible").last();
        if (await composer.isVisible().catch(() => false)) {
          await composer.click({ timeout: 5000 }).catch(() => {});
          await page.keyboard.type(PROBE_TEXT, { delay: 25 });
          await page.waitForTimeout(200);
          await page.keyboard.press("ControlOrMeta+A").catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
          await page.waitForTimeout(200);
        }

        // 2. Interactive UI click burst (panel tab / header toggle / channel switch & return)
        const headerBtn = page.locator("[data-testid=channel-header-title-button]").first();
        if (await headerBtn.isVisible().catch(() => false)) {
          await headerBtn.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(250);
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(200);
        }
        if (otherChannel && otherChannel.id !== targetChannel.id) {
          const sidebar = page.locator("[data-testid=sidebar-root]");
          await sidebar.getByText(otherChannel.name, { exact: true }).first().click({ timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1000);
          await sidebar.getByText(targetChannel.name, { exact: true }).first().click({ timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }

        // Give the browser 2 frames to flush final Event Timing entries
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.waitForTimeout(200);

        const captured = await page.evaluate(() => {
          const w = window as unknown as {
            __perfInputEvents: RawEventTimingEntry[];
            __perfInputLongTasks: Array<{ start: number; duration: number }>;
          };
          const longtaskMs = (w.__perfInputLongTasks ?? []).reduce((s, t) => s + t.duration, 0);
          const interactionCount = (performance as { interactionCount?: number }).interactionCount;
          return {
            events: w.__perfInputEvents ?? [],
            longtaskMs,
            interactionCount,
          };
        });

        const summary = summarizeInputInteractions(captured.events, captured.longtaskMs, captured.interactionCount);
        if (summary.inpMs === null) {
          warnings.push(`run ${runIdx + 1}: no Event Timing interactions recorded`);
        }
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
  const med = (pick: (r: InputLatencySummary) => number | null | undefined): number | null => {
    const vals = kept.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const m = median(vals);
    return m == null ? null : Math.round(m * 10) / 10;
  };
  const metrics = {
    inp_ms: med((r) => r.inpMs),
    key_p50_ms: med((r) => r.keyP50Ms),
    key_p95_ms: med((r) => r.keyP95Ms),
    key_max_ms: med((r) => r.keyMaxMs),
    click_p50_ms: med((r) => r.clickP50Ms),
    click_p95_ms: med((r) => r.clickP95Ms),
    click_max_ms: med((r) => r.clickMaxMs),
    interaction_count: med((r) => r.interactionCount),
    long_interaction_count: med((r) => r.longInteractionCount),
    input_longtask_ms: med((r) => r.longtaskMs),
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
    tool: "raft-perf input",
    measuredAt,
    origin,
    page: { server: server.slug, channel: targetChannel.name, ...(otherChannel ? { other: otherChannel.name } : {}) },
    cohort,
    commitSha: release.commitSha ?? null,
    requestedRuns: runs,
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
      state: "input",
      net: "fast",
      ab: "none",
      arm: "on",
      run_idx: i,
      lcp_ms: null,
      inp_ms: r.inpMs,
      cls: null,
      ttfb_ms: null,
      fcp_ms: null,
      verdict: warnings.length ? "unknown" : "measured",
      extra: {
        inp_interaction: r.inpInteraction,
        key_p50_ms: r.keyP50Ms,
        key_p95_ms: r.keyP95Ms,
        key_max_ms: r.keyMaxMs,
        click_p50_ms: r.clickP50Ms,
        click_p95_ms: r.clickP95Ms,
        click_max_ms: r.clickMaxMs,
        interaction_count: r.interactionCount,
        long_interaction_count: r.longInteractionCount,
        input_longtask_ms: r.longtaskMs,
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
    `raft-perf input #${targetChannel.name}: INP ${metrics.inp_ms ?? "-"} ms (key p95 ${metrics.key_p95_ms ?? "-"} ms, click p95 ${metrics.click_p95_ms ?? "-"} ms, interactions ${metrics.interaction_count ?? 0})\n`,
  );
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf input: ${error instanceof InputError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
