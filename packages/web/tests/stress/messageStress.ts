// Standalone stress runner for the message list. Targets a running slockdev
// env (NOT the playwright test runner's pglite + auto-vite combo, which is
// too clean to surface real bugs). Reads creds from .dev-env-<name>.json.
//
// Usage:
//   pnpm --filter @botiverse/raft-web exec tsx tests/stress/messageStress.ts \
//     --env message-list-e2e [--load 1500] [--scenarios swipe,switch,permalink,append]
//
// Each scenario is a small probe designed to provoke one class of bug. The
// runner prints a one-line VERDICT per scenario and saves screenshots /
// console logs under tests/stress/artifacts/.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, CDPSession, ConsoleMessage, Page } from "@playwright/test";

type DevEnv = {
  user: { id: string; email: string; password: string; name: string };
  server: { id: string; slug: string; name: string };
  channel: { id: string; name: string };
  dmChannel: { id: string; name: string };
  agent: { id: string; name: string };
  machine: { id: string; name: string; apiKey: string };
  threads: Record<string, { parentMessageId: string; threadChannelId: string }>;
};

type Args = {
  envName: string;
  load: number;
  scenarios: string[];
  webPort: number;
  apiPort: number;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1]! : def;
  };
  return {
    envName: get("--env", "message-list-e2e"),
    load: Number(get("--load", "1500")),
    scenarios: get(
      "--scenarios",
      "swipe,append,switch,permalink,viewport,concurrent,sendAndSee,backToBottom,resumePosition,crossChannelPermalink,unreadLanding",
    ).split(",").filter(Boolean),
    webPort: Number(get("--web-port", "15260")),
    apiPort: Number(get("--api-port", "13088")),
  };
}

async function readEnv(envName: string): Promise<DevEnv> {
  const repoRoot = path.resolve(process.cwd(), "..", "..");
  const credsPath = path.join(repoRoot, `.dev-env-${envName}.json`);
  const raw = await readFile(credsPath, "utf8");
  return JSON.parse(raw) as DevEnv;
}

class Api {
  private accessToken = "";
  constructor(private base: string, private serverId: string) {}

  async login(email: string, password: string) {
    const r = await fetch(`${this.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error(`login ${r.status}`);
    const data = (await r.json()) as { accessToken: string };
    this.accessToken = data.accessToken;
  }

  private headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.accessToken}`,
      "x-server-id": this.serverId,
    };
  }

  async post(channelId: string, content: string) {
    const r = await fetch(`${this.base}/api/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ channelId, content }),
    });
    if (!r.ok) throw new Error(`post ${r.status} ${await r.text()}`);
    return (await r.json()) as { id: string; seq: number };
  }

  async listChannel(channelId: string, opts: { limit?: number; before?: number } = {}) {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.before) qs.set("before", String(opts.before));
    const r = await fetch(`${this.base}/api/messages/channel/${channelId}?${qs}`, {
      headers: this.headers(),
    });
    if (!r.ok) throw new Error(`list ${r.status}`);
    return (await r.json()) as { messages: Array<{ id: string; seq: number; content: string }> };
  }
}

// Posts as the seed agent via the /internal route. This bypasses the
// 60-msg/min/user rate limit on /api/messages because /internal is gated
// only by machine API key auth (Eric's tip, msg 631ce63c). Use this for
// bulk-loading background data; use Api.post for tests that need to
// exercise the user-facing rate limiter.
class InternalApi {
  constructor(private base: string, private serverId: string, private machineApiKey: string, private agentId: string) {}

  async send(target: string, content: string) {
    const r = await fetch(`${this.base}/internal/agent/${this.agentId}/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.machineApiKey}`,
        "x-server-id": this.serverId,
      },
      body: JSON.stringify({ target, content }),
    });
    if (!r.ok) throw new Error(`internal send ${r.status} ${await r.text()}`);
    return (await r.json()) as { ok: boolean; messageId: string };
  }
}

async function bulkLoadInternal(internal: InternalApi, target: string, count: number, prefix: string) {
  const start = Date.now();
  const concurrency = 8;
  let posted = 0;
  let lastReport = Date.now();
  const queue = Array.from({ length: count }, (_, i) => i);
  await Promise.all(
    Array.from({ length: concurrency }).map(async () => {
      while (queue.length) {
        const idx = queue.shift()!;
        // Vary length so virtualization hits varied heights — single-line,
        // multi-line, and code-block-ish payloads. Keep content identifiable
        // via the prefix so we can grep it out later.
        const len = (idx % 17) + 1;
        const body =
          idx % 7 === 0
            ? `${prefix} #${idx} ` + "x ".repeat(len * 4)
            : idx % 13 === 0
              ? `${prefix} #${idx}\n\nline2\nline3\nline4`
              : `${prefix} #${idx}`;
        try {
          await internal.send(target, body);
        } catch (e) {
          console.error(`internal send ${idx} failed`, e);
        }
        posted += 1;
        if (Date.now() - lastReport > 2000) {
          lastReport = Date.now();
          console.log(`  bulk: ${posted}/${count} (${(posted / ((Date.now() - start) / 1000)).toFixed(1)} msg/s)`);
        }
      }
    }),
  );
  console.log(`  bulk: done ${posted} in ${(Date.now() - start) / 1000}s`);
}

type Anchor = { dataIndex: string; offsetWithinScroller: number; visibleText: string };

async function captureAnchor(page: Page): Promise<Anchor | null> {
  return page.getByTestId("message-scroller").evaluate((el) => {
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-index]"));
    if (items.length === 0) return null;
    const r = el.getBoundingClientRect();
    const center = r.top + r.height / 2;
    let best: { item: HTMLElement; dist: number } | null = null;
    for (const it of items) {
      const rr = it.getBoundingClientRect();
      const c = rr.top + rr.height / 2;
      const d = Math.abs(c - center);
      if (!best || d < best.dist) best = { item: it, dist: d };
    }
    if (!best) return null;
    const top = best.item.getBoundingClientRect().top - r.top + el.scrollTop;
    return {
      dataIndex: best.item.dataset.index ?? "",
      offsetWithinScroller: top,
      visibleText: (best.item.textContent ?? "").slice(0, 80),
    };
  });
}

async function measureDrift(page: Page, before: Anchor): Promise<number> {
  const after = await page.getByTestId("message-scroller").evaluate(
    (el, { dataIndex, prev }) => {
      const it = el.querySelector<HTMLElement>(`[data-index="${dataIndex}"]`);
      if (!it) return null;
      const r = el.getBoundingClientRect();
      const top = it.getBoundingClientRect().top - r.top + el.scrollTop;
      return Math.abs(top - prev);
    },
    { dataIndex: before.dataIndex, prev: before.offsetWithinScroller },
  );
  return after ?? Number.POSITIVE_INFINITY;
}

async function readMetrics(page: Page) {
  return page.getByTestId("message-scroller").evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    bottomGap: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
    items: el.querySelectorAll("[data-index]").length,
  }));
}

// CDP-driven continuous touch swipe. Playwright's `page.touchscreen.tap()` is
// a single tap and `page.mouse.wheel()` is mouse, not touch. To reproduce the
// momentum-scroll flicker we need an actual stream of touchmove events.
async function cdpSwipe(
  cdp: CDPSession,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  steps = 30,
  durationMs = 300,
) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: fromX, y: fromY }],
  });
  const dwell = durationMs / steps;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = fromX + (toX - fromX) * t;
    const y = fromY + (toY - fromY) * t;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y }],
    });
    await new Promise((r) => setTimeout(r, dwell));
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

type ScenarioCtx = {
  api: Api;
  env: DevEnv;
  page: Page;
  cdp: CDPSession;
  artifactDir: string;
  consoleErrors: string[];
};

type Verdict = { name: string; status: "pass" | "fail" | "warn"; detail: string };

async function scenarioSwipe(ctx: ScenarioCtx): Promise<Verdict> {
  const { page, cdp, artifactDir } = ctx;
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${ctx.env.server.slug}/channel/${ctx.env.channel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);

  // Swipe up repeatedly to fast-scroll through history. Each swipe is short
  // and quick, mimicking a flick. Watch for flicker (rapid scrollTop
  // oscillation) and lazy-load drops (scrollHeight should keep growing as
  // older pages stream in).
  const samples: Array<{ t: number; scrollTop: number; scrollHeight: number; items: number }> = [];
  const sampleStop = setInterval(async () => {
    try {
      const m = await readMetrics(page);
      samples.push({ t: Date.now(), ...m });
    } catch {
      /* page may transition */
    }
  }, 50);

  const before = await readMetrics(page);
  const startItems = before.items;
  const startScrollHeight = before.scrollHeight;
  // Probe the scroller geometry so the CDP swipe lands inside it (not on
  // the fixed header / input bar).
  const geom = await page.getByTestId("message-scroller").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  const cx = (geom.left + geom.right) / 2;
  const yTop = geom.top + 30;
  const yBot = geom.bottom - 30;
  for (let i = 0; i < 12; i += 1) {
    // To reveal OLDER messages the user scrolls UP — which means the finger
    // gesture goes DOWN (content moves down with the finger). Start of the
    // chat view is anchored to the bottom (latest), so the unidirectional
    // burst is finger-down-the-screen.
    await cdpSwipe(cdp, cx, yTop, cx, yBot, 12, 120);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);
  clearInterval(sampleStop);
  // Also do an imperative scrollTop=0 jump to verify the lazy-load trigger
  // fires through the data path (not just the CDP touch path). If items
  // still don't grow after this, the lazy-load itself is broken.
  const beforeJump = await readMetrics(page);
  await page.getByTestId("message-scroller").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(1500);
  const afterJump = await readMetrics(page);
  console.log(
    `  swipe: scroller=${JSON.stringify(geom)} jumpItems ${beforeJump.items}->${afterJump.items} jumpScrollH ${beforeJump.scrollHeight}->${afterJump.scrollHeight}`,
  );

  const after = await readMetrics(page);
  // Detect oscillation: count direction reversals in scrollTop within a
  // short window. A clean scroll has very few reversals; flicker has many.
  let reversals = 0;
  for (let i = 2; i < samples.length; i += 1) {
    const d1 = samples[i - 1]!.scrollTop - samples[i - 2]!.scrollTop;
    const d2 = samples[i]!.scrollTop - samples[i - 1]!.scrollTop;
    if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) reversals += 1;
  }
  const grew = after.scrollHeight > startScrollHeight * 1.05 || after.items > startItems;
  await page.screenshot({ path: path.join(artifactDir, "swipe-final.png") });
  await writeFile(path.join(artifactDir, "swipe-samples.json"), JSON.stringify(samples, null, 2));

  const detail =
    `samples=${samples.length} reversals=${reversals} ` +
    `items ${startItems}->${after.items} scrollHeight ${startScrollHeight.toFixed(0)}->${after.scrollHeight.toFixed(0)} ` +
    `bottomGap=${after.bottomGap.toFixed(0)}`;
  // Heuristics: more than 8 reversals on a unidirectional swipe burst smells
  // like jitter; lazy-load not firing means items count stuck. Either is a
  // warn, both is a fail.
  const flicker = reversals > 8;
  const lazyDrop = !grew && after.bottomGap > 200;
  const status: "pass" | "warn" | "fail" =
    flicker && lazyDrop ? "fail" : flicker || lazyDrop ? "warn" : "pass";
  return { name: "swipe", status, detail };
}

async function scenarioAppend(ctx: ScenarioCtx): Promise<Verdict> {
  const { api, env, page, artifactDir } = ctx;
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);

  // Park user mid-list.
  await page.getByTestId("message-scroller").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight / 2);
  });
  await page.waitForTimeout(400);
  const before = await captureAnchor(page);
  if (!before) return { name: "append", status: "fail", detail: "no anchor" };
  const beforeMetrics = await readMetrics(page);

  // Post messages from API while user is reading. Server has a 60-msg/min/
  // user limiter, so pace at 1.1s between posts to avoid hitting it.
  for (let i = 0; i < 12; i += 1) {
    await api.post(env.channel.id, `[stress-append] burst ${Date.now()}-${i}`);
    await new Promise((r) => setTimeout(r, 1100));
  }
  await page.waitForTimeout(1500);

  const drift = await measureDrift(page, before);
  const afterMetrics = await readMetrics(page);
  await page.screenshot({ path: path.join(artifactDir, "append-final.png") });

  const detail =
    `anchor=#${before.dataIndex} drift=${drift.toFixed(1)}px ` +
    `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)} ` +
    `items ${beforeMetrics.items}->${afterMetrics.items}`;
  const status: "pass" | "warn" | "fail" =
    drift > 200 || afterMetrics.bottomGap < 50
      ? "fail"
      : drift > 40
        ? "warn"
        : "pass";
  return { name: "append", status, detail };
}

async function scenarioSwitch(ctx: ScenarioCtx): Promise<Verdict> {
  const { env, page, artifactDir } = ctx;
  // Toggle channel <-> DM repeatedly. Looking for: stuck loading, residual
  // scroll position, anchor drift after re-entry, "previous channel
  // messages briefly visible" flash.
  const targets = [
    `/s/${env.server.slug}/channel/${env.channel.id}`,
    `/s/${env.server.slug}/dm/${env.dmChannel.id}`,
  ];
  const consoleBefore = ctx.consoleErrors.length;
  let flashes = 0;
  await page.goto(`http://localhost:${parseArgs().webPort}${targets[0]}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(500);

  for (let i = 0; i < 10; i += 1) {
    const url = `http://localhost:${parseArgs().webPort}${targets[(i + 1) % 2]}`;
    await page.goto(url);
    // Snapshot immediately after navigation: if the OTHER channel's content
    // is briefly visible, it means messageStore stale-data guard didn't
    // take. We check for a known-unique substring in the bulk-loaded prefix.
    await page.waitForTimeout(50);
    const bodyText = await page.evaluate(() => document.body.textContent ?? "");
    if (i % 2 === 0 && bodyText.includes("[stress-bulk-dm]")) flashes += 1;
    if (i % 2 === 1 && bodyText.includes("[stress-bulk-channel]")) flashes += 1;
    await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(200);
  }

  const consoleErrs = ctx.consoleErrors.length - consoleBefore;
  await page.screenshot({ path: path.join(artifactDir, "switch-final.png") });
  const status: "pass" | "warn" | "fail" =
    flashes > 0 || consoleErrs > 0 ? "warn" : "pass";
  return {
    name: "switch",
    status,
    detail: `flashes=${flashes} consoleErrs=${consoleErrs}`,
  };
}

async function scenarioPermalink(ctx: ScenarioCtx): Promise<Verdict> {
  const { api, env, page, artifactDir } = ctx;
  // Pick a message ~200 from the tail and try to permalink-jump to it.
  // The contract: scroll lands with the target message in viewport, no
  // bounce, no extra scroll-to-bottom.
  const list = await api.listChannel(env.channel.id, { limit: 50 });
  if (list.messages.length === 0) {
    return { name: "permalink", status: "fail", detail: "no messages" };
  }
  // Walk back to find a message far from the tail.
  let target = list.messages[list.messages.length - 1]!;
  let cursor = target.seq;
  for (let i = 0; i < 4; i += 1) {
    const page2 = await api.listChannel(env.channel.id, { limit: 50, before: cursor });
    if (page2.messages.length === 0) break;
    target = page2.messages[0]!;
    cursor = target.seq;
  }

  // The channel page reads the focus message id from `?msg=`, not `?focus=`.
  // Confirmed in ChatPanel.tsx (queryFocusMessageId = searchParams.get("msg")).
  const url = `http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}?msg=${target.id}`;
  await page.goto(url);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(2500);

  // Sample scrollTop over 1.5s — a healthy permalink jump settles fast and
  // doesn't bounce. If scrollTop changes by >100px after the first 800ms,
  // something is moving the viewport on its own.
  const samples: number[] = [];
  for (let i = 0; i < 30; i += 1) {
    const m = await readMetrics(page);
    samples.push(m.scrollTop);
    await page.waitForTimeout(50);
  }
  const settled = samples.slice(20);
  const range = Math.max(...settled) - Math.min(...settled);
  // No `data-message-id` on MessageItem (verified in source). Use visible
  // text content as a proxy: the content string is unique across the seed +
  // bulk-load and embedded in the DOM by react-markdown.
  const visible = await page.evaluate(
    (text) => (document.body.textContent ?? "").includes(text),
    target.content.slice(0, 30),
  );
  await page.screenshot({ path: path.join(artifactDir, "permalink-final.png") });

  const status: "pass" | "warn" | "fail" =
    !visible ? "fail" : range > 100 ? "warn" : "pass";
  return {
    name: "permalink",
    status,
    detail: `target=${target.id.slice(0, 8)} settledRange=${range.toFixed(1)}px visible=${visible}`,
  };
}

// User-pattern: send-and-see. The most universal flow — type into the
// composer, hit send, expect the new message to appear at the bottom and
// for the scroll to land at it. Failure modes worth catching: the message
// is posted but doesn't show (broadcast race), the scroll detaches mid-send
// (followOutput contract broken), the input doesn't clear (state desync).
async function scenarioSendAndSee(ctx: ScenarioCtx): Promise<Verdict> {
  const { env, page, artifactDir } = ctx;
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);

  // Make sure we start at the tail so the autosend should keep us pinned.
  await page.getByTestId("message-scroller").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  const beforeMetrics = await readMetrics(page);

  const stamp = `[stress-sendAndSee] ${Date.now()}`;
  // The composer textarea is identified by its placeholder ("Message …").
  // Fill via locator so React picks up the change; a raw value set bypasses
  // React state.
  const textarea = page.locator('textarea[placeholder^="Message "]').first();
  await textarea.waitFor({ state: "visible", timeout: 5_000 });
  await textarea.fill(stamp);
  // Submit by pressing Enter (no shift). Same path as a real user — exercises
  // the IME composing guard plus form onSubmit.
  await textarea.press("Enter");

  // Allow the round-trip: optimistic local state -> POST -> socket echo.
  await page.waitForTimeout(1500);

  const visible = await page.evaluate(
    (s) => (document.body.textContent ?? "").includes(s),
    stamp,
  );
  const afterMetrics = await readMetrics(page);
  const inputCleared = await textarea.inputValue();
  await page.screenshot({ path: path.join(artifactDir, "sendAndSee-final.png") });

  const detail =
    `visible=${visible} inputCleared=${inputCleared.length === 0} ` +
    `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)} ` +
    `items ${beforeMetrics.items}->${afterMetrics.items}`;
  // Pinned-to-bottom contract: after sending while at tail, bottomGap should
  // remain near 0. >120px means followOutput failed to follow the user's own
  // post — a regression in the auto-follow path.
  const status: "pass" | "warn" | "fail" =
    !visible || inputCleared.length > 0
      ? "fail"
      : afterMetrics.bottomGap > 120
        ? "warn"
        : "pass";
  return { name: "sendAndSee", status, detail };
}

// User-pattern: back-to-bottom button. User scrolled up to read history; the
// floating "Back to bottom" / "N new message(s)" button appears. Clicking it
// should snap the list to the tail. Failure modes: button doesn't appear,
// click is a no-op, snap overshoots (scrollTop > scrollHeight), or pendingBottomScrollRef
// doesn't drain so the list ends up mid-list.
async function scenarioBackToBottom(ctx: ScenarioCtx): Promise<Verdict> {
  const { env, page, artifactDir } = ctx;
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);

  // Park user well above the tail so the button must show.
  await page.getByTestId("message-scroller").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight / 4);
  });
  await page.waitForTimeout(500);
  const beforeMetrics = await readMetrics(page);

  // Button's accessible name is either "Back to bottom" or "N new message(s)".
  // Match either by partial text.
  const button = page
    .locator('button:has-text("Back to bottom"), button:has-text("new message")')
    .first();
  let buttonVisible = false;
  try {
    await button.waitFor({ state: "visible", timeout: 3_000 });
    buttonVisible = true;
  } catch {
    /* button absent — record below */
  }

  if (!buttonVisible) {
    await page.screenshot({ path: path.join(artifactDir, "backToBottom-nobutton.png") });
    return {
      name: "backToBottom",
      status: "fail",
      detail: `button never appeared at scrollTop=${beforeMetrics.scrollTop.toFixed(0)} bottomGap=${beforeMetrics.bottomGap.toFixed(0)}`,
    };
  }

  await button.click();
  await page.waitForTimeout(1200);
  const afterMetrics = await readMetrics(page);
  await page.screenshot({ path: path.join(artifactDir, "backToBottom-final.png") });

  const detail =
    `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)} ` +
    `scrollTop ${beforeMetrics.scrollTop.toFixed(0)}->${afterMetrics.scrollTop.toFixed(0)}`;
  // After clicking back-to-bottom, bottomGap should be at or near 0 (the
  // atBottomThreshold in the component is 100px). >150px means the snap
  // didn't actually land at the tail.
  const status: "pass" | "warn" | "fail" =
    afterMetrics.bottomGap > 150 ? "fail" : afterMetrics.bottomGap > 50 ? "warn" : "pass";
  return { name: "backToBottom", status, detail };
}

// User-pattern: resume scroll position after navigating away and back.
// User parks mid-list in channel A, switches to channel B, then back to A —
// expectation is that the scroll returns near where they left off (or at
// least lands somewhere coherent, not at the absolute top or bottom).
// Failure mode: state is dropped on unmount and re-entry always lands at
// the tail / forces a full reload.
async function scenarioResumePosition(ctx: ScenarioCtx): Promise<Verdict> {
  const { env, page, artifactDir } = ctx;
  const channelUrl = `http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}`;
  const dmUrl = `http://localhost:${parseArgs().webPort}/s/${env.server.slug}/dm/${env.dmChannel.id}`;
  await page.goto(channelUrl);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);

  // Force the user past "near tail" by paging up several times so older
  // history is loaded. Without this, scrollHeight/3 lands on a message
  // already near the recent tail and the verdict can't distinguish a
  // legitimate near-tail restore from a tail-snap drop.
  for (let i = 0; i < 6; i += 1) {
    await page.getByTestId("message-scroller").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(350);
  }

  // Park mid-list and capture the anchor.
  await page.getByTestId("message-scroller").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight / 3);
  });
  await page.waitForTimeout(500);
  const before = await captureAnchor(page);
  if (!before) return { name: "resumePosition", status: "fail", detail: "no anchor before nav" };
  const beforeMetrics = await readMetrics(page);

  // Bounce out and back.
  await page.goto(dmUrl);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(700);
  await page.goto(channelUrl);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(900);

  const afterMetrics = await readMetrics(page);
  // Anchor message may or may not have rendered into the same dataIndex — try
  // visible-text fallback.
  const anchorVisible = await page.evaluate(
    (text) => (document.body.textContent ?? "").includes(text),
    before.visibleText.slice(0, 30),
  );
  await page.screenshot({ path: path.join(artifactDir, "resumePosition-final.png") });

  // bottomGap == 0 after re-entry while we left mid-list = scroll position
  // was dropped. anchorVisible == false suggests the relevant rendered window
  // moved entirely.
  const droppedToTail = afterMetrics.bottomGap < 50 && beforeMetrics.bottomGap > 200;
  const detail =
    `anchorVisible=${anchorVisible} ` +
    `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)} ` +
    `scrollTop after=${afterMetrics.scrollTop.toFixed(0)}`;
  const status: "pass" | "warn" | "fail" =
    droppedToTail ? "warn" : !anchorVisible ? "warn" : "pass";
  return { name: "resumePosition", status, detail };
}

// User-pattern: permalink that crosses channels. User is currently in
// channel B and clicks a permalink into a message in channel A. The router
// should navigate to A and the scroller should land with the target visible.
// Failure mode: navigates but stays at the tail of A, or the focus param is
// lost during the channel transition.
async function scenarioCrossChannelPermalink(ctx: ScenarioCtx): Promise<Verdict> {
  const { api, env, page, artifactDir } = ctx;
  // Pick a channel-message far from tail, then load a DM first to set the
  // currently-active channel state, then navigate to the channel permalink
  // URL.
  const list = await api.listChannel(env.channel.id, { limit: 50 });
  if (list.messages.length === 0) {
    return { name: "crossChannelPermalink", status: "fail", detail: "no messages" };
  }
  let target = list.messages[list.messages.length - 1]!;
  let cursor = target.seq;
  for (let i = 0; i < 4; i += 1) {
    const p = await api.listChannel(env.channel.id, { limit: 50, before: cursor });
    if (p.messages.length === 0) break;
    target = p.messages[0]!;
    cursor = target.seq;
  }

  // Park in DM first.
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${env.server.slug}/dm/${env.dmChannel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(700);

  // Now navigate to channel-permalink. Real users would click a link rendered
  // in the DM; for this probe the URL transition is enough since both go
  // through the same router path.
  await page.goto(
    `http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}?msg=${target.id}`,
  );
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(2500);

  const visible = await page.evaluate(
    (text) => (document.body.textContent ?? "").includes(text),
    target.content.slice(0, 30),
  );
  const afterMetrics = await readMetrics(page);
  await page.screenshot({ path: path.join(artifactDir, "crossChannelPermalink-final.png") });

  // If we're at the tail (bottomGap ~0) but the target is far from tail, the
  // permalink jump didn't honor the focus param and we just fell through to
  // the default tail-anchor behavior.
  const detail =
    `target=${target.id.slice(0, 8)} visible=${visible} ` +
    `bottomGap=${afterMetrics.bottomGap.toFixed(0)} scrollTop=${afterMetrics.scrollTop.toFixed(0)}`;
  const status: "pass" | "warn" | "fail" =
    !visible
      ? "fail"
      : afterMetrics.bottomGap < 50
        ? "warn" // landed at tail despite asking for older msg — suspicious
        : "pass";
  return { name: "crossChannelPermalink", status, detail };
}

// User-pattern: unread-landing. After bulk-loading messages while the user
// has not visited the channel, opening it should land at a sensible position
// — either at the unread divider or near the latest message — not stuck at
// the absolute top of all loaded history. Failure mode: scrollTop=0 on
// initial open even though there are hundreds of messages.
async function scenarioUnreadLanding(ctx: ScenarioCtx): Promise<Verdict> {
  const { env, page, artifactDir } = ctx;
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(1500);

  const m = await readMetrics(page);
  await page.screenshot({ path: path.join(artifactDir, "unreadLanding-final.png") });

  // Coherent landing: either at the tail (bottomGap near 0) or somewhere
  // mid-list. The pathological case is "stuck at the very top of loaded
  // history" — scrollTop=0 with substantial bottomGap means the initial
  // anchor did not run.
  const detail =
    `scrollTop=${m.scrollTop.toFixed(0)} scrollHeight=${m.scrollHeight.toFixed(0)} ` +
    `bottomGap=${m.bottomGap.toFixed(0)} clientHeight=${m.clientHeight.toFixed(0)} items=${m.items}`;
  const stuckAtTop = m.scrollTop < 10 && m.bottomGap > m.clientHeight * 2;
  const status: "pass" | "warn" | "fail" = stuckAtTop ? "fail" : "pass";
  return { name: "unreadLanding", status, detail };
}

// Concurrent torture: swipe up while messages append at bottom, and
// halfway through, shrink the viewport (mobile keyboard pop). This is the
// real iOS user flow that has been reported flickering. Looking for:
// - anchor drift > 80px (drift = bug)
// - scroll snap to bottom (bottomGap goes to 0 unexpectedly)
// - Virtuoso console errors / out-of-order item indices
async function scenarioConcurrent(ctx: ScenarioCtx): Promise<Verdict> {
  const { api, env, page, cdp, artifactDir } = ctx;
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);

  // Seed user mid-list.
  await page.getByTestId("message-scroller").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight / 2);
  });
  await page.waitForTimeout(400);
  const before = await captureAnchor(page);
  if (!before) return { name: "concurrent", status: "fail", detail: "no anchor" };
  const beforeMetrics = await readMetrics(page);

  const geom = await page.getByTestId("message-scroller").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  const cx = (geom.left + geom.right) / 2;
  const yTop = geom.top + 30;
  const yBot = geom.bottom - 30;

  let appendErrors = 0;
  let driftMax = 0;
  const samples: Array<{ t: number; drift: number; bottomGap: number; items: number }> = [];

  // Three concurrent tasks: swipe burst, append burst (paced for rate
  // limit), and a viewport shrink halfway through.
  const swipeTask = (async () => {
    for (let i = 0; i < 8; i += 1) {
      await cdpSwipe(cdp, cx, yTop, cx, yBot, 10, 100);
      const a = await captureAnchor(page);
      if (a && a.dataIndex === before.dataIndex) {
        const d = await measureDrift(page, before);
        const m = await readMetrics(page);
        samples.push({ t: Date.now(), drift: d, bottomGap: m.bottomGap, items: m.items });
        if (d > driftMax) driftMax = d;
      }
      await page.waitForTimeout(80);
    }
  })();
  const appendTask = (async () => {
    for (let i = 0; i < 6; i += 1) {
      try {
        await api.post(env.channel.id, `[stress-concurrent] burst ${Date.now()}-${i}`);
      } catch {
        appendErrors += 1;
      }
      await new Promise((r) => setTimeout(r, 1100));
    }
  })();
  const viewportTask = (async () => {
    await new Promise((r) => setTimeout(r, 1500));
    await page.setViewportSize({ width: 390, height: 500 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.setViewportSize({ width: 390, height: 844 });
  })();

  await Promise.all([swipeTask, appendTask, viewportTask]);
  await page.waitForTimeout(1500);

  const driftFinal = await measureDrift(page, before);
  const afterMetrics = await readMetrics(page);
  await page.screenshot({ path: path.join(artifactDir, "concurrent-final.png") });
  await writeFile(path.join(artifactDir, "concurrent-samples.json"), JSON.stringify(samples, null, 2));

  const detail =
    `anchor=#${before.dataIndex} driftMax=${driftMax.toFixed(1)}px driftFinal=${driftFinal.toFixed(1)}px ` +
    `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)} ` +
    `appendErrors=${appendErrors}`;
  // Anchor drift up to ~120px is plausible from the deliberate viewport
  // shrink (anchor message itself can move with layout). >300px means a
  // real jump. bottomGap collapsing to <100 mid-test is the snap-to-bottom
  // bug.
  const snapped = afterMetrics.bottomGap < 100 && beforeMetrics.bottomGap > 200;
  const status: "pass" | "warn" | "fail" =
    snapped || driftMax > 300 ? "fail" : driftMax > 120 ? "warn" : "pass";
  return { name: "concurrent", status, detail };
}

async function scenarioViewport(ctx: ScenarioCtx): Promise<Verdict> {
  const { env, page, cdp, artifactDir } = ctx;
  await page.goto(`http://localhost:${parseArgs().webPort}/s/${env.server.slug}/channel/${env.channel.id}`);
  await page.getByTestId("message-scroller").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(800);

  await page.getByTestId("message-scroller").evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight / 3);
  });
  await page.waitForTimeout(400);

  const before = await captureAnchor(page);
  if (!before) return { name: "viewport", status: "fail", detail: "no anchor" };
  const beforeMetrics = await readMetrics(page);

  // Two-step viewport shrink: first the layout viewport (mimics rotation /
  // window-resize), then visualViewport-only (mimics iOS keyboard pop where
  // the layout viewport stays the same but the visible region shrinks).
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(400);
  const driftAfterLayout = await measureDrift(page, before);

  // visualViewport-only: use CDP Emulation.setVisualViewport to pretend a
  // soft keyboard appeared. layout viewport unchanged.
  // Note: not all chromium builds support this, so guard.
  let driftAfterVisual: number | null = null;
  try {
    await cdp.send("Emulation.setVisibleSize" as never, { width: 390, height: 380 } as never);
    await page.waitForTimeout(400);
    driftAfterVisual = await measureDrift(page, before);
  } catch {
    /* unsupported on this chromium */
  }

  const afterMetrics = await readMetrics(page);
  await page.screenshot({ path: path.join(artifactDir, "viewport-final.png") });
  const visualPart = driftAfterVisual === null ? "n/a" : driftAfterVisual.toFixed(1);
  const detail =
    `anchor=#${before.dataIndex} layoutDrift=${driftAfterLayout.toFixed(1)}px visualDrift=${visualPart} ` +
    `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)}`;
  const worst = Math.max(driftAfterLayout, driftAfterVisual ?? 0);
  const status: "pass" | "warn" | "fail" =
    worst > 200 || afterMetrics.bottomGap < 50 ? "fail" : worst > 80 ? "warn" : "pass";
  return { name: "viewport", status, detail };
}

async function main() {
  const args = parseArgs();
  console.log(`stress runner: env=${args.envName} load=${args.load} scenarios=${args.scenarios.join(",")}`);
  const env = await readEnv(args.envName);
  const api = new Api(`http://localhost:${args.apiPort}`, env.server.id);
  await api.login(env.user.email, env.user.password);

  const tail = await api.listChannel(env.channel.id, { limit: 1 });
  const existing = tail.messages[0]?.seq ?? 0;
  console.log(`channel ${env.channel.name}: latest seq=${existing}`);

  const internal = new InternalApi(`http://localhost:${args.apiPort}`, env.server.id, env.machine.apiKey, env.agent.id);
  if (args.load > 0) {
    console.log(`bulk-loading ${args.load} channel msgs (via /internal, no rate limit)`);
    await bulkLoadInternal(internal, `#${env.channel.name}`, args.load, "[stress-bulk-channel]");
  }

  const artifactDir = path.resolve(process.cwd(), "tests", "stress", "artifacts", String(Date.now()));
  await mkdir(artifactDir, { recursive: true });
  console.log(`artifacts: ${artifactDir}`);

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await context.addInitScript(
    ([t, r, s]) => {
      localStorage.setItem("slock_access_token", t);
      localStorage.setItem("slock_refresh_token", r);
      localStorage.setItem("slock_last_server_slug", s);
    },
    [(api as unknown as { accessToken: string }).accessToken, "x", env.server.slug],
  );

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Avatar fetches return 404 when no avatar is uploaded — these are noise,
    // not real errors. Filter them out so the signal:noise of the report is
    // useful.
    if (text.startsWith("Failed to load resource:") && text.includes("404")) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.setIgnoreInputEvents" as never, { ignore: false } as never).catch(() => {
    /* not all builds */
  });

  const scenarios: Record<string, (c: ScenarioCtx) => Promise<Verdict>> = {
    swipe: scenarioSwipe,
    append: scenarioAppend,
    switch: scenarioSwitch,
    permalink: scenarioPermalink,
    viewport: scenarioViewport,
    concurrent: scenarioConcurrent,
    sendAndSee: scenarioSendAndSee,
    backToBottom: scenarioBackToBottom,
    resumePosition: scenarioResumePosition,
    crossChannelPermalink: scenarioCrossChannelPermalink,
    unreadLanding: scenarioUnreadLanding,
  };

  const verdicts: Verdict[] = [];
  for (const name of args.scenarios) {
    const fn = scenarios[name];
    if (!fn) {
      console.log(`  skip unknown scenario: ${name}`);
      continue;
    }
    console.log(`\n--- scenario: ${name} ---`);
    const t0 = Date.now();
    try {
      const v = await fn({ api, env, page, cdp, artifactDir, consoleErrors });
      console.log(`  ${v.status.toUpperCase()} ${v.name} (${Date.now() - t0}ms): ${v.detail}`);
      verdicts.push(v);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  CRASH ${name}: ${msg}`);
      verdicts.push({ name, status: "fail", detail: `crash: ${msg}` });
      await page.screenshot({ path: path.join(artifactDir, `${name}-crash.png`) }).catch(() => {});
    }
  }

  await writeFile(
    path.join(artifactDir, "verdicts.json"),
    JSON.stringify({ verdicts, consoleErrors }, null, 2),
  );

  console.log("\n=== SUMMARY ===");
  for (const v of verdicts) console.log(`  ${v.status.toUpperCase().padEnd(4)} ${v.name.padEnd(10)} ${v.detail}`);
  console.log(`  consoleErrors: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    for (const e of consoleErrors.slice(0, 10)) console.log(`    - ${e}`);
  }

  await browser.close();
  const failed = verdicts.filter((v) => v.status === "fail").length;
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
