#!/usr/bin/env node
/**
 * raft-perf soak: measure long-lived session JS heap and DOM node retention /
 * leak slope across repeated channel switches and scrolls (#proj-frontend:#78).
 *
 * Forces CDP `HeapProfiler.collectGarbage` + reads `Performance.getMetrics`
 * (`JSHeapUsedSize`, `JSHeapTotalSize`, `Nodes`, `JSEventListeners`, `Documents`)
 * after each round, computes post-warmup OLS slopes (`js_heap_slope_mb_per_round`,
 * `dom_nodes_slope_per_round`) and writes a `perf.page_runs` row (`state = "soak"`).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { type CDPSession, chromium } from "playwright";
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
import { hostBenchmarkMedian, hostExtra } from "./hostHealth";
import { isProductionHost } from "./page";
import type { PageRunRow } from "./pageRuns";
import { type SoakSample, analyzeSoakSamples } from "./soakStats";

const HELP = `raft-perf soak — measure long-lived session JS heap & DOM node growth across repeated channel switches

Required env: RAFT_PERF_EMAIL, RAFT_PERF_PASSWORD (a test account; never a real person's).
Options:
  --origin <url>      web origin (default https://raft-app-staging.botiverse.dev)
  --api <url>         API origin (default: --origin)
  --fixture <name>    frozen benchmark fixture (e.g. bench-v1): sets --server/--channel/--other and verifies digest
  --server <slug>     server slug (required unless --fixture sets it)
  --channel <name>    primary channel (required unless --fixture sets it)
  --other <name>      secondary channel to switch back and forth with (default all, or fixture's secondary channel)
  --rounds <n>        switch+scroll soak rounds (default 8; minimum 3)
  --out <file>        also write JSON report here
  --jsonl <file>      also write one perf.page_runs row (state="soak"); needs --project
  --project <name>    with --jsonl: product name (e.g. raft-web)
  --env <env>         with --jsonl: environment override
  --run-id <id>       with --jsonl: shared run_id across a collection (default: a new UUID)
  --chromium-arg <a>  extra Chromium switch (repeatable)
  --allow-production  measure *.raft.build
`;

class SoakError extends Error {}
const fail = (message: string): never => {
  throw new SoakError(message);
};

async function takeGcSample(cdp: CDPSession, round: number): Promise<SoakSample> {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const res = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
  const byName = new Map(res.metrics.map((m) => [m.name, m.value]));
  return {
    round,
    jsHeapUsedBytes: byName.get("JSHeapUsedSize") ?? 0,
    jsHeapTotalBytes: byName.get("JSHeapTotalSize") ?? 0,
    domNodes: byName.get("Nodes") ?? 0,
    jsEventListeners: byName.get("JSEventListeners") ?? 0,
    documents: byName.get("Documents") ?? 0,
  };
}

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
      rounds: { type: "string", default: "8" },
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
  const rounds = Number(args.rounds);
  if (!Number.isInteger(rounds) || rounds < 3 || rounds > 100) fail("--rounds must be an integer from 3 to 100");
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
  const primary = list.find((c) => c.name === resolved.channel) ?? fail(`no channel ${resolved.channel} in ${resolved.server}`);
  const secondary = list.find((c) => c.name === resolved.other) ?? fail(`no channel ${resolved.other} in ${resolved.server}`);
  if (primary.id === secondary.id) fail("--channel and --other must differ");

  let verifiedFixtureTag: string | null = null;
  if (fixtureSpec) {
    const check = await fetchAndVerifyFixture(api, accessToken, server.id, primary.id, fixtureSpec);
    if (!check.ok) fail(`fixture ${fixtureSpec.fixture} drifted (${check.mismatches.join("; ")})`);
    verifiedFixtureTag = check.tag;
  }

  const browser = await chromium.launch({ args: args["chromium-arg"] });
  const samples: SoakSample[] = [];
  const edgeColos: string[] = [];
  const connectRtts: number[] = [];
  const warnings: string[] = [];
  let release: { commitSha?: string; deploymentEnvironment?: string } = {};
  let deviceProbe: BrowserDeviceProbe | null = null;

  try {
    deviceProbe = await probeBrowserDevice(browser);
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
      await cdp.send("Performance.enable");
      await cdp.send("HeapProfiler.enable");
      cdp.on("Network.responseReceived", (e) => {
        if (e.type === "Document" || e.response.url.startsWith(`${api}/api/`)) {
          const colo = parseEdgeColo(e.response.headers);
          if (colo) edgeColos.push(colo);
          const rtt = parseConnectRttMs(e.response.timing, e.response.protocol);
          if (rtt != null) connectRtts.push(rtt);
        }
      });

      await page.goto(`${origin}/s/${server.slug}/channel/${primary.id}`, { waitUntil: "load", timeout: 120_000 });
      await cdp.send("Network.disable").catch(() => {});
      await page.locator("[data-testid=message-scroller]").first().waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForTimeout(3000);

      const rawRelease = await page.evaluate(() => document.getElementById("raft-frontend-release-identity")?.textContent ?? null);
      if (rawRelease) {
        try {
          release = JSON.parse(rawRelease) as { commitSha?: string; deploymentEnvironment?: string };
        } catch {
          /* ignore */
        }
      }

      // Baseline sample (round 0)
      samples.push(await takeGcSample(cdp, 0));

      const sidebar = page.locator("[data-testid=sidebar-root]");
      for (let round = 1; round <= rounds; round += 1) {
        // Switch away to secondary, wait, switch back to primary, scroll up & down
        await sidebar.getByText(secondary.name, { exact: true }).first().click({ timeout: 10_000 }).catch(() => {
          warnings.push(`round ${round}: failed to click #${secondary.name}`);
        });
        await page.waitForTimeout(700);
        await sidebar.getByText(primary.name, { exact: true }).first().click({ timeout: 10_000 }).catch(() => {
          warnings.push(`round ${round}: failed to click #${primary.name}`);
        });
        await page.waitForTimeout(700);

        const scroller = page.locator("[data-testid=message-scroller]").first();
        const box = await scroller.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let s = 0; s < 6; s += 1) {
            await page.mouse.wheel(0, -400);
            await page.waitForTimeout(30);
          }
          for (let s = 0; s < 6; s += 1) {
            await page.mouse.wheel(0, 400);
            await page.waitForTimeout(30);
          }
        }
        await page.waitForTimeout(300);
        samples.push(await takeGcSample(cdp, round));
      }
      await cdp.detach().catch(() => {});
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const trend = analyzeSoakSamples(samples);
  const measuredAt = new Date().toISOString();
  const cpus = availableParallelism();
  const hostBench = hostBenchmarkMedian();
  const cohort = buildCohort({
    browserWhere: "local",
    edgeColo: dominantString(edgeColos),
    hostCpuCount: cpus,
    hostBenchmarkMs: hostBench,
    device: deviceProbe,
    connectRttSamplesMs: connectRtts,
    net: "fast",
    fixture: verifiedFixtureTag,
  });

  const report = {
    tool: "raft-perf soak",
    measuredAt,
    origin,
    page: { server: server.slug, channel: primary.name, other: secondary.name },
    cohort,
    commitSha: release.commitSha ?? null,
    rounds,
    metrics: {
      js_heap_start_mb: trend.jsHeapStartMb,
      js_heap_end_mb: trend.jsHeapEndMb,
      js_heap_delta_mb: trend.jsHeapDeltaMb,
      js_heap_slope_mb_per_round: trend.jsHeapSlopeMbPerRound,
      dom_nodes_start: trend.domNodesStart,
      dom_nodes_end: trend.domNodesEnd,
      dom_nodes_delta: trend.domNodesDelta,
      dom_nodes_slope_per_round: trend.domNodesSlopePerRound,
      js_listeners_start: trend.jsListenersStart,
      js_listeners_end: trend.jsListenersEnd,
      js_listeners_delta: trend.jsListenersDelta,
      monotonic_heap_growth: trend.monotonicHeapGrowth ? 1 : 0,
    },
    warnings,
    samples,
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
    const row: PageRunRow = {
      project: args.project!,
      env,
      run_id: runId,
      tool_version: toolVersion,
      taken_at: measuredAt,
      origin,
      commit_sha: release.commitSha ?? null,
      page: "channel",
      state: "soak",
      net: "fast",
      ab: "none",
      arm: "on",
      run_idx: 0,
      lcp_ms: null,
      inp_ms: null,
      cls: null,
      ttfb_ms: null,
      fcp_ms: null,
      verdict: warnings.length ? "unknown" : "measured",
      extra: {
        soak_rounds: trend.rounds,
        js_heap_start_mb: trend.jsHeapStartMb,
        js_heap_end_mb: trend.jsHeapEndMb,
        js_heap_delta_mb: trend.jsHeapDeltaMb,
        js_heap_slope_mb_per_round: trend.jsHeapSlopeMbPerRound,
        dom_nodes_start: trend.domNodesStart,
        dom_nodes_end: trend.domNodesEnd,
        dom_nodes_delta: trend.domNodesDelta,
        dom_nodes_slope_per_round: trend.domNodesSlopePerRound,
        js_listeners_start: trend.jsListenersStart,
        js_listeners_end: trend.jsListenersEnd,
        js_listeners_delta: trend.jsListenersDelta,
        monotonic_heap_growth: trend.monotonicHeapGrowth ? 1 : 0,
        ...hostExtra(cpus, hostBench),
        ...cohortFields,
      },
    };
    const outPath = path.resolve(args.jsonl);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(row)}\n`);
  }

  process.stderr.write(
    `raft-perf soak #${primary.name} (${rounds} rounds): heap ${trend.jsHeapStartMb} -> ${trend.jsHeapEndMb} MB (slope ${trend.jsHeapSlopeMbPerRound} MB/round), DOM ${trend.domNodesStart} -> ${trend.domNodesEnd} (delta ${trend.domNodesDelta})${trend.monotonicHeapGrowth ? " [MONOTONIC GROWTH]" : ""}\n`,
  );
  return warnings.length ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`raft-perf soak: ${error instanceof SoakError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    process.exitCode = 2;
  },
);
