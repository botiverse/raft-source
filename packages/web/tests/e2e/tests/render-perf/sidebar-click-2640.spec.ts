/**
 * Render-perf gate baseline (task #39 spike, Bugen-led, 铁根 methodology, Aiden
 * react-scan/lite collector). Origin thread: `#proj-frontend:9abf1db8`.
 *
 * Pins the #2640 sidebar-click cure: a single click on a sibling sidebar row
 * must NOT cause UNRELATED sibling rows to re-render. The 102 → 2 RED→GREEN
 * result on #2640 was specifically `ChannelRow` per-instance — every sibling
 * ChannelRow rendering on each click was the bug; only the clicked row should
 * change. (Aiden #proj-frontend:9abf1db8 msg=2b457341 corrected an earlier
 * conflation with #2642's MessageItem 51→1 — that's a separate surface/event.)
 *
 * v0 gate (per-surface, sibling-scoped) per Aiden + 铁根 6/17 consensus:
 *   1. Probe self-check `attached-and-committing` (NOT `probe-not-attached`
 *      / NOT `hook-attached-but-no-fibers`).
 *   2. Each non-clicked sidebar row's per-fiber-instance renderCount === 0.
 *      Sibling rows are the v0 red-line; the clicked row's count is allowed
 *      to be small (selection state change is a legitimate update).
 *   3. Global parent-cascade output is DIAGNOSTIC ONLY at v0 — channel
 *      switch legitimately re-renders chat content; only sibling-row cascade
 *      maps to the #2640 bug-class. Per-surface allowlist comes later.
 *
 * 铁根 generalization (msg=09da7a33): each list surface is its own bug-class
 * instance with its own selector + trigger + expected (target=incremental,
 * sibling=0). #2640 ChannelRow is sample 1; MessageTimeline #2642, Tasks
 * rows, Inbox+Saved rows are future siblings of this same gate template.
 */

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

async function createSiblingChannel(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await request.post(`${seedState.urls.api}/api/channels`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { name },
  });
  if (!response.ok()) {
    throw new Error(`Failed to create sibling channel: ${response.status()} ${response.statusText()}`);
  }
  return response.json();
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROBE_PATH = resolve(repoRoot, ".render-perf/probe.iife.js");
const PROBE_BUILD_SCRIPT = resolve(repoRoot, "tests/render-perf/buildProbe.mjs");

// The probe IIFE is a build artifact (gitignored) — esbuild-bundle the bippy
// probe source on demand so CI doesn't need a separate pre-step. Cheap (~100ms)
// and idempotent; only runs if the artifact is missing.
test.beforeAll(() => {
  if (!existsSync(PROBE_PATH)) {
    execFileSync("node", [PROBE_BUILD_SCRIPT], { cwd: repoRoot, stdio: "inherit" });
  }
});

interface ProbeState {
  renderer: "injected" | "not-injected";
  commits: number;
  fibers: number;
  profilingHooks: "available" | "unavailable" | "unknown";
  components: Record<
    string,
    {
      componentName: string;
      source: { fileName?: string; lineNumber?: number; columnNumber?: number } | null;
      renderCount: number;
      parentCascade: boolean;
    }
  >;
}

interface DomNodeRowMetric {
  selector: string;
  matched: boolean;
  componentName: string | null;
  renderCount: number;
  parentCascade: boolean;
}

interface SidebarRowMetricWithId extends DomNodeRowMetric {
  channelId: string | null;
}

declare global {
  interface Window {
    __RAFT_RENDER_PERF__?: {
      state: () => ProbeState;
      healthCheck: () => "probe-not-attached" | "hook-attached-but-no-fibers" | "attached-and-committing";
      queryDomRows: (selector: string) => DomNodeRowMetric[];
      reset: () => void;
      stop: () => void;
    };
  }
}

test.describe("render-perf v0 — sidebar click sibling-cascade gate (PR #2640 baseline)", () => {
  test("single sidebar-row click does NOT cascade to parent or siblings", async ({ page, request }) => {
    // Inject probe BEFORE navigation so it installs before react-dom mount.
    await page.addInitScript({ path: PROBE_PATH });

    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    // Seed only ships one channel. We need ≥3 rows so we can split the row
    // population into three classes after the click (Aiden msg=82b8707b):
    //   - clicked target row (allowed bounded > 0)
    //   - previous-active row (allowed bounded > 0 — selection styling change)
    //   - unrelated sibling rows (must be 0; this is the #2640 red-line)
    // With only 2 rows the "previous active" IS the only sibling, masking
    // the gate. We create 3 extras (4 total: 1 seed + 3 created) so unrelated
    // siblings exist regardless of which row Playwright picks as click target.
    const stamp = Date.now().toString(36);
    const siblings: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < 3; i++) {
      siblings.push(
        await createSiblingChannel(request, seedState, login.accessToken, `rp-sibling-${stamp}-${i}`),
      );
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await page.waitForLoadState("networkidle");

    // Wait for ALL created sibling rows to appear in the sidebar before
    // measuring — socket-driven channel-list updates can land after
    // `networkidle`, and we don't want a partial render at click time.
    for (const s of siblings) {
      await page
        .locator(`[data-sidebar-channel-id="${s.id}"]`)
        .waitFor({ state: "visible", timeout: 10_000 });
    }

    // Probe self-check — Aiden's three-mode discriminator. probe-not-attached
    // and hook-attached-but-no-fibers are inconclusive (NOT pass). v0 only
    // promotes to PR-gate runs that come back attached-and-committing.
    const health = await page.evaluate(() => window.__RAFT_RENDER_PERF__?.healthCheck());
    if (health !== "attached-and-committing") {
      const dump = await page.evaluate(() => window.__RAFT_RENDER_PERF__?.state());
      console.error("[render-perf] probe self-check failed:", health, JSON.stringify(dump, null, 2).slice(0, 4000));
      throw new Error(`probe self-check failed: ${health} — see console for state dump`);
    }

    // Reset accumulators so we measure ONLY the click interaction below,
    // not the full app boot which will rack up dozens of expected commits.
    await page.evaluate(() => window.__RAFT_RENDER_PERF__?.reset());

    // Find one of the rows this test owns to click. Full-shard CI leaves
    // channels from neighboring specs in the same server (quote/thread-search
    // rows, etc.); those rows can receive their own async store patches after
    // reset() and must not become this spec's target or oracle population.
    const activeChannelId = seedState.channel.id;
    const clickedRowId = siblings[0].id;
    const controlledSiblingIds = siblings.slice(1).map((s) => s.id);
    const target = page.locator(`[data-sidebar-channel-id="${clickedRowId}"]`);
    await expect(target, "owned sidebar target row must be visible before click").toBeVisible();

    // The interaction under measurement.
    await target.click();
    await page.waitForLoadState("networkidle");

    // Brief settle so any tail-end commits land in the count before we read.
    await page.waitForTimeout(200);

    const state = await page.evaluate(() => window.__RAFT_RENDER_PERF__?.state());
    if (!state) throw new Error("probe state missing after interaction");

    // Per-row instance metrics — Aiden's row-scoped gate.
    // queryDomRows walks each [data-sidebar-channel-id] DOM node back to its
    // owning ChannelRow / DmRow fiber and returns that specific instance's
    // renderCount, NOT the component-level sum. This is what reproduces
    // 102 → 2 — sibling rows should be 0 on a single-row click.
    const rowMetrics = await page.evaluate(
      (sel) => window.__RAFT_RENDER_PERF__?.queryDomRows(sel) ?? [],
      "[data-sidebar-channel-id]",
    );

    console.log(
      "[render-perf] sidebar row metrics after click:",
      rowMetrics
        .map((m, i) => `[${i}] matched=${m.matched} ${m.componentName ?? "—"} count=${m.renderCount} cascade=${m.parentCascade}`)
        .join(" | "),
    );

    // Match each metric back to its DOM channelId so we can split clicked-row
    // vs sibling-rows (queryDomRows returns in document order, so we re-query
    // ids in the same order to align).
    const rowIds = await page.locator("[data-sidebar-channel-id]").evaluateAll(
      (els) => els.map((el) => el.getAttribute("data-sidebar-channel-id")),
    );
    expect(
      rowMetrics.length,
      "queryDomRows + locator must return the same set of sidebar rows",
    ).toBe(rowIds.length);

    const metricsWithIds: SidebarRowMetricWithId[] = rowMetrics.map((metric, i) => ({
      ...metric,
      channelId: rowIds[i] ?? null,
    }));

    const byRowId = new Map<string, SidebarRowMetricWithId>();
    for (const metric of metricsWithIds) {
      if (metric.channelId) byRowId.set(metric.channelId, metric);
    }

    // Three-class row classification per Aiden msg=82b8707b, scoped to rows
    // created by this test plus the previous active seed row:
    //   - clickedRow:        target of the click — selection styling change is legit
    //   - previousActiveRow: was active before the click — selection styling change is legit
    //   - unrelatedRows:     test-owned siblings not clicked/active — MUST be 0
    // The #2640 RED→GREEN signal lives on `unrelatedRows`. With only 2 rows
    // in the sidebar, every "sibling" is the previousActive row, so the gate
    // can't distinguish bug-class from legitimate state change. We seed ≥4
    // rows above to guarantee unrelatedRows.length ≥ 2.
    const clickedMetric = byRowId.get(clickedRowId);
    const previousActiveMetric = byRowId.get(activeChannelId);
    const unrelatedMetrics = controlledSiblingIds
      .map((id) => byRowId.get(id))
      .filter((metric): metric is SidebarRowMetricWithId => !!metric);
    const missingControlledIds = [clickedRowId, ...controlledSiblingIds]
      .filter((id) => !byRowId.has(id));
    const noisyExternal = metricsWithIds.filter(
      (m) =>
        m.channelId &&
        ![activeChannelId, clickedRowId, ...controlledSiblingIds].includes(m.channelId) &&
        m.matched &&
        m.renderCount > 0,
    );

    console.log(
      `[render-perf] row classification: clicked=${clickedMetric?.renderCount ?? "?"} `
      + `previousActive=${previousActiveMetric?.renderCount ?? "?"} `
      + `controlledUnrelated[${unrelatedMetrics.length}]=${unrelatedMetrics.map((m) => m.renderCount).join(",")} `
      + `externalNoisy[${noisyExternal.length}]=${noisyExternal.map((m) => `${m.channelId}:${m.renderCount}`).join(",")}`,
    );

    expect(
      missingControlledIds,
      "all test-owned sidebar rows must remain present after the click",
    ).toEqual([]);

    expect(
      previousActiveMetric?.matched ?? false,
      "previous active seed row must have a resolvable React fiber via [data-sidebar-channel-id]",
    ).toBe(true);

    expect(
      unrelatedMetrics.length,
      "spec needs both unclicked test-owned sibling rows to gate the #2640 bug-class. "
      + "If this fails, a test-owned row disappeared or queryDomRows stopped resolving it.",
    ).toBe(controlledSiblingIds.length);

    // Hard red-line v0: every test-owned UNRELATED sidebar row must have rendered 0
    // times since reset(). #2640 RED: every ChannelRow re-renders on every
    // click (Sidebar parent re-renders → memo busted → all rows render).
    // #2640 GREEN: only clicked + previousActive render (their selection
    // state changed). Unrelated rows stay still.
    const noisyUnrelated = unrelatedMetrics.filter((m) => m.matched && m.renderCount > 0);
    if (noisyUnrelated.length > 0) {
      console.error(
        "[render-perf] TEST-OWNED unrelated sibling rows re-rendered:",
        noisyUnrelated.map((m) => `${m.channelId}:${m.componentName}(count=${m.renderCount},cascade=${m.parentCascade})`).join(", "),
      );
    }
    if (noisyExternal.length > 0) {
      console.warn(
        "[render-perf] external sidebar rows rendered during click window (diagnostic, not gated):",
        noisyExternal.map((m) => `${m.channelId}:${m.componentName}(count=${m.renderCount},cascade=${m.parentCascade})`).join(", "),
      );
    }
    expect(
      noisyUnrelated,
      `Test-owned unrelated sidebar rows re-rendered on a single-row click — #2640 regression class. `
      + `Per Aiden msg=82b8707b row-scoped gate: only clicked + previously-active rows are allowed `
      + `to re-render (selection styling). Any other test-owned row > 0 means Sidebar parent re-rendered and `
      + `memo() on ChannelRow is busted (typically by an unstable handler/store-root subscription).`,
    ).toEqual([]);

    // Preserve a broad diagnostic signal for neighboring full-shard rows
    // without letting their own async setup/patches create false positives.
    const allNoisyUnrelated = metricsWithIds.filter(
      (m) => m.channelId !== clickedRowId && m.channelId !== activeChannelId && m.matched && m.renderCount > 0,
    );
    console.log(
      `[render-perf] diagnostic all-unrelated noisy rows: ${allNoisyUnrelated.length}`,
    );

    // Clicked-row sanity: did at least one fiber actually render? If 0, the
    // harness probably failed to associate the row's DOM with its fiber
    // (broken fiberFromDomNode walk, or the click never selected). The clicked
    // row's absolute count is diagnostic-only for this contract; the hard gate
    // is unrelated test-owned rows staying at 0 above.
    expect(
      clickedMetric?.matched ?? false,
      "clicked row must have a resolvable React fiber via [data-sidebar-channel-id]",
    ).toBe(true);
    expect(
      clickedMetric?.renderCount ?? 0,
      "clicked row should have rendered at least once (selection state change)",
    ).toBeGreaterThan(0);

    // Diagnostic-only at v0 (per Aiden msg=2b457341): global parent-cascade
    // is logged but NOT gated, because legitimate channel-switch content
    // load reads as a cascade. Per-surface allowlist comes later when we
    // have multiple surface baselines.
    const cascaded = Object.values(state.components).filter((c) => c.parentCascade);
    console.log(
      `[render-perf] DIAGNOSTIC global cascade count: ${cascaded.length} components (NOT gated at v0)`,
    );

    // Top-N for PR-review visibility.
    const top = Object.values(state.components)
      .sort((a, b) => b.renderCount - a.renderCount)
      .slice(0, 10);
    console.log(
      "[render-perf] top renderers after sidebar-click:",
      top.map((c) => `${c.componentName}=${c.renderCount}`).join(", "),
    );
    console.log(
      `[render-perf] commits=${state.commits} fibers=${state.fibers}`,
    );
  });
});
