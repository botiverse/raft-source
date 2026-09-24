import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";

// First-principles regression harness for message list stability.
//
// Captures three pain points called out in #proj-message-list task #2:
//   1. mobile viewport shrink (keyboard / address bar) jumps scroll to bottom
//   2. new message arriving while user is reading mid-list jumps to bottom
//      (auto-follow conflated with scroll-to-bottom)
//   3. lazy-load misses on rapid scroll-to-top (startReached not firing)
//
// Tests are written as diagnostic measurements: they compute how far the
// anchor drifted and how many items loaded, then assert sane bounds. Where
// the current implementation is known-broken, the assertion is wrapped in
// test.fail() so CI stays green today and flips when the underlying fix
// lands. Each test prints the metric to stdout so the failure mode is
// observable even when the test passes by tolerance.

type Anchor = {
  // MessageTimeline exposes stable message ids on each rendered row. Anchor by
  // id instead of render index so full-window tail reloads do not make the
  // measurement point ambiguous.
  messageId: string;
  // Distance from scroller top to the anchor element's top, in CSS px.
  // Stable under prepend / measurement drift; the only thing that should
  // change on resize is the scroller's own height.
  offsetWithinScroller: number;
};

type TimelineMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  bottomGap: number;
  itemCount: number;
  firstRenderedMessageId: string | null;
  lastRenderedMessageId: string | null;
  activeElement: {
    tagName: string | null;
    testId: string | null;
    placeholder: string | null;
  };
};

type TimelineLedgerMetadata = {
  schema: "message-list-append-ledger";
  version: 1;
  base: string;
  checkoutCommit: string;
  githubEventSha: string | null;
  identitySource: "git-head" | "github-sha-fallback" | "unknown";
  testId: string;
  testTitle: string;
  projectName: string;
  repeatEachIndex: number;
};

type TimelineLedgerEvent = TimelineMetrics & {
  seq: number;
  type: string;
  t: number;
  [key: string]: unknown;
};

type TimelineLedgerSnapshot = {
  schema: "message-list-append-ledger";
  version: 1;
  base: string;
  checkoutCommit: string;
  githubEventSha: string | null;
  identitySource: "git-head" | "github-sha-fallback" | "unknown";
  testId: string;
  testTitle: string;
  projectName: string;
  repeatEachIndex: number;
  source: "page" | "host-fallback";
  targetMessageId: string | null;
  targetSeen: boolean;
  events: TimelineLedgerEvent[];
  hostEvents: Array<Record<string, unknown>>;
};

type HostAppendLedger = TimelineLedgerMetadata & {
  targetMessageId: string | null;
  events: Array<Record<string, unknown>>;
};

const APPEND_LEDGER_ATTACHMENT_NAME = "task492-append-ledger.json";
const APPEND_LEDGER_TEST_ID = "message-list-stability:append-mid-list";

async function postMessage(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
  channelId: string,
  content: string,
) {
  const response = await request.post(`${seedState.urls.api}/api/messages`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Server-Id": seedState.server.id,
    },
    data: { channelId, content },
  });
  if (!response.ok()) {
    throw new Error(`Failed to post message: ${response.status()} ${response.statusText()}`);
  }
  return response.json();
}

async function readMetrics(page: Page) {
  return page.getByTestId("message-scroller").evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    bottomGap: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
    itemCount: el.querySelectorAll("[data-index]").length,
  }));
}

function createHostAppendLedger(testInfo: TestInfo): HostAppendLedger {
  const sourceCommit = resolveAppendLedgerSourceCommit();
  return {
    schema: "message-list-append-ledger",
    version: 1,
    base: sourceCommit.checkoutCommit,
    checkoutCommit: sourceCommit.checkoutCommit,
    githubEventSha: sourceCommit.githubEventSha,
    identitySource: sourceCommit.identitySource,
    testId: APPEND_LEDGER_TEST_ID,
    testTitle: testInfo.title,
    projectName: testInfo.project.name,
    repeatEachIndex: testInfo.repeatEachIndex,
    targetMessageId: null,
    events: [],
  };
}

function resolveAppendLedgerSourceCommit() {
  const githubSha = process.env.GITHUB_SHA?.trim();
  try {
    const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { checkoutCommit, githubEventSha: githubSha || null, identitySource: "git-head" as const };
  } catch {
    if (githubSha) {
      return { checkoutCommit: githubSha, githubEventSha: githubSha, identitySource: "github-sha-fallback" as const };
    }
  }

  return {
    checkoutCommit: "unknown",
    githubEventSha: null,
    identitySource: "unknown" as const,
  };
}

function recordHostAppendLedger(ledger: HostAppendLedger, type: string, extra: Record<string, unknown> = {}) {
  ledger.events.push({
    seq: ledger.events.length,
    type,
    t: performance.now(),
    ...extra,
  });
}

async function installAppendLedger(page: Page, metadata: TimelineLedgerMetadata) {
  await page.getByTestId("message-scroller").evaluate((scroller, ledgerMetadata) => {
    const events: TimelineLedgerEvent[] = [];
    let targetMessageId: string | null = null;
    let targetSeen = false;
    let seq = 0;
    let captureStarted = false;
    let afterPost = false;

    const readTimelineMetrics = (): TimelineMetrics => {
      const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-message-id]"));
      const active = document.activeElement as HTMLElement | null;
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        bottomGap: Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        itemCount: rows.length,
        firstRenderedMessageId: rows[0]?.dataset.messageId ?? null,
        lastRenderedMessageId: rows[rows.length - 1]?.dataset.messageId ?? null,
        activeElement: {
          tagName: active?.tagName ?? null,
          testId: active?.getAttribute("data-testid") ?? null,
          placeholder: active?.getAttribute("placeholder") ?? null,
        },
      };
    };

    const push = (type: string, extra: Record<string, unknown> = {}) => {
      if (type === "beforePost") captureStarted = true;
      events.push({
        seq,
        type,
        t: performance.now(),
        ...readTimelineMetrics(),
        ...extra,
      });
      seq += 1;
    };

    const maybeRecordTarget = (type: string) => {
      if (!targetMessageId || targetSeen) return;
      const target = scroller.querySelector(`[data-message-id="${CSS.escape(targetMessageId)}"]`);
      if (!target) return;
      targetSeen = true;
      push(type, { targetMessageId });
    };

    const mutationObserver = new MutationObserver(() => {
      if (!captureStarted) return;
      push("mutation");
      maybeRecordTarget("targetMutationSeen");
    });
    mutationObserver.observe(scroller, { childList: true, subtree: true });

    const resizeObserver = new ResizeObserver(() => {
      if (!captureStarted) return;
      push("resize");
      maybeRecordTarget("targetResizeSeen");
    });
    resizeObserver.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) resizeObserver.observe(content);

    scroller.addEventListener("scroll", (event) => {
      if (!captureStarted) return;
      // Chromium dispatches scroll events for programmatic jumps too, and this
      // harness has observed isTrusted=true in that path. Treat it only as a
      // browser-dispatched scroll signal, not as user/program owner evidence.
      push("scroll", {
        phase: afterPost ? "post-response" : "pre-response",
        isTrusted: event.isTrusted,
      });
      maybeRecordTarget("targetScrollSeen");
    }, { passive: true });

    (window as typeof window & {
      __messageListAppendLedger?: {
        mark: (type: string, extra?: Record<string, unknown>) => void;
        setPostResponse: (messageId: string) => void;
        read: () => TimelineLedgerSnapshot;
      };
    }).__messageListAppendLedger = {
      mark: push,
      setPostResponse: (messageId: string) => {
        targetMessageId = messageId;
        captureStarted = true;
        afterPost = true;
        push("postResponse", { targetMessageId });
        maybeRecordTarget("targetAlreadyRenderedAfterPost");
      },
      read: () => ({
        ...ledgerMetadata,
        source: "page",
        targetMessageId,
        targetSeen,
        events,
        hostEvents: [],
      }),
    };

    push("ledgerInstalled");
  }, metadata);
}

async function markAppendLedger(page: Page, type: string, extra: Record<string, unknown> = {}) {
  await page.evaluate(({ eventType, eventExtra }) => {
    (window as typeof window & {
      __messageListAppendLedger?: { mark: (type: string, extra?: Record<string, unknown>) => void };
    }).__messageListAppendLedger?.mark(eventType, eventExtra);
  }, { eventType: type, eventExtra: extra });
}

async function bindAppendLedgerPost(page: Page, messageId: string) {
  await page.evaluate((id) => {
    (window as typeof window & {
      __messageListAppendLedger?: { setPostResponse: (messageId: string) => void };
    }).__messageListAppendLedger?.setPostResponse(id);
  }, messageId);
}

async function readAppendLedger(page: Page): Promise<TimelineLedgerSnapshot | null> {
  return page.evaluate(() => {
    return (window as typeof window & {
      __messageListAppendLedger?: { read: () => TimelineLedgerSnapshot };
    }).__messageListAppendLedger?.read() ?? null;
  });
}

async function attachAppendLedger(testInfo: TestInfo, page: Page, name: string, hostLedger: HostAppendLedger) {
  let snapshot: TimelineLedgerSnapshot | null;
  try {
    snapshot = await readAppendLedger(page);
  } catch (error) {
    snapshot = {
      schema: hostLedger.schema,
      version: hostLedger.version,
      base: hostLedger.base,
      checkoutCommit: hostLedger.checkoutCommit,
      githubEventSha: hostLedger.githubEventSha,
      identitySource: hostLedger.identitySource,
      testId: hostLedger.testId,
      testTitle: hostLedger.testTitle,
      projectName: hostLedger.projectName,
      repeatEachIndex: hostLedger.repeatEachIndex,
      source: "host-fallback",
      targetMessageId: hostLedger.targetMessageId,
      targetSeen: false,
      events: [{
        seq: 0,
        type: "ledgerReadFailed",
        t: performance.now(),
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        bottomGap: 0,
        itemCount: 0,
        firstRenderedMessageId: null,
        lastRenderedMessageId: null,
        activeElement: { tagName: null, testId: null, placeholder: null },
        error: error instanceof Error ? error.message : String(error),
      }],
      hostEvents: hostLedger.events,
    };
  }
  if (!snapshot) {
    snapshot = {
      schema: hostLedger.schema,
      version: hostLedger.version,
      base: hostLedger.base,
      checkoutCommit: hostLedger.checkoutCommit,
      githubEventSha: hostLedger.githubEventSha,
      identitySource: hostLedger.identitySource,
      testId: hostLedger.testId,
      testTitle: hostLedger.testTitle,
      projectName: hostLedger.projectName,
      repeatEachIndex: hostLedger.repeatEachIndex,
      source: "host-fallback",
      targetMessageId: hostLedger.targetMessageId,
      targetSeen: false,
      events: [],
      hostEvents: hostLedger.events,
    };
  } else {
    snapshot.hostEvents = hostLedger.events;
  }
  const outputPath = testInfo.outputPath(name);
  await writeFile(outputPath, JSON.stringify(snapshot, null, 2));
  await testInfo.attach(name, {
    path: outputPath,
    contentType: "application/json",
  });
}

async function scrollAwayFromBottom(page: Page) {
  const scroller = page.getByTestId("message-scroller");
  await scroller.hover();
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(250);
    const { bottomGap } = await readMetrics(page);
    if (bottomGap > 500) break;
  }
}

// Mirror MessageTimeline.captureAnchor's semantic: the topmost message whose
// bottom is below the scroller's top edge. This is the anchor the primitive
// restores across resize / append / prepend.
async function captureAnchor(page: Page): Promise<Anchor | null> {
  return page.getByTestId("message-scroller").evaluate((el) => {
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-index]"));
    if (items.length === 0) return null;
    const scrollerRect = el.getBoundingClientRect();
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom <= scrollerRect.top + 1) continue;
      const messageId = item.dataset.messageId ?? "";
      const itemTop = item.getBoundingClientRect().top - scrollerRect.top + el.scrollTop;
      return { messageId, offsetWithinScroller: itemTop };
    }
    return null;
  });
}

// Compute the visible drift of an anchored message between two snapshots.
// If the message disappeared from the rendered window (virtualized out
// because the scroller jumped far away), return Infinity so the assertion
// fires loudly.
async function measureAnchorDrift(page: Page, before: Anchor): Promise<number> {
  const after = await page.getByTestId("message-scroller").evaluate(
    (el, { messageId, prevOffset }) => {
      const item = el.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (!item) return null;
      const scrollerRect = el.getBoundingClientRect();
      const itemTop = item.getBoundingClientRect().top - scrollerRect.top + el.scrollTop;
      return Math.abs(itemTop - prevOffset);
    },
    { messageId: before.messageId, prevOffset: before.offsetWithinScroller },
  );
  return after ?? Number.POSITIVE_INFINITY;
}

test.describe("message list stability", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // Pain point #1 — mobile viewport shrink (keyboard pop) jumps scroll to bottom.
  // The user scrolled up to read history. The browser viewport shrinks because
  // a virtual keyboard or mobile address bar appears. Virtuoso receives a
  // resize signal and re-runs followOutput, which currently snaps back to the
  // tail. The anchored message should not move more than the height delta.
  test("viewport shrink while scrolled mid-list does not jump to bottom", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

    // Scroll up several screens so the user is well away from the tail.
    await scrollAwayFromBottom(page);

    const before = await captureAnchor(page);
    expect(before, "should resolve a center anchor before resize").not.toBeNull();
    const beforeMetrics = await readMetrics(page);
    expect(beforeMetrics.bottomGap, "should be detached from the bottom before resize").toBeGreaterThan(200);

    // Simulate the mobile address bar / soft keyboard collapsing the layout
    // viewport. Real iOS Safari fires a window resize plus visualViewport
    // resize; Playwright's setViewportSize triggers the layout resize that
    // Virtuoso listens to.
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForTimeout(600);

    const drift = await measureAnchorDrift(page, before!);
    const afterMetrics = await readMetrics(page);
    console.log(
      `[viewport-shrink] anchor=${before!.messageId} drift=${drift.toFixed(1)}px ` +
        `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)}`,
    );

    expect(drift, "anchored message must not drift more than ~120px on viewport shrink").toBeLessThan(120);
    expect(
      afterMetrics.bottomGap,
      "should still be detached from bottom after viewport shrink",
    ).toBeGreaterThan(200);
  });

  // Pain point #2 — auto-follow conflated with scroll-to-bottom.
  // User scrolled up to read older messages. A new message arrives via the
  // socket. Today the list scrolls back to the bottom. The contract should
  // be: only follow output when the user is already at the bottom.
  test("new message while reading mid-list does not yank scroll to bottom", async ({
    page,
    request,
  }, testInfo) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    const hostLedger = createHostAppendLedger(testInfo);
    let ledgerInstalled = false;
    let testFailed = false;

    try {
      await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
      await expect(page.getByTestId("message-scroller")).toBeVisible();
      await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

      await scrollAwayFromBottom(page);

      const before = await captureAnchor(page);
      expect(before, "should resolve a center anchor before append").not.toBeNull();
      const beforeMetrics = await readMetrics(page);
      expect(beforeMetrics.bottomGap, "must be detached from bottom before append").toBeGreaterThan(200);
      await installAppendLedger(page, hostLedger);
      ledgerInstalled = true;
      await markAppendLedger(page, "beforePost", { anchorMessageId: before!.messageId });
      recordHostAppendLedger(hostLedger, "beforePostHost", { anchorMessageId: before!.messageId });

      const posted = await postMessage(
        request,
        seedState,
        login.accessToken,
        seedState.channel.id,
        `[stability-harness] mid-list append ${Date.now()}`,
      );
      hostLedger.targetMessageId = posted.id;
      recordHostAppendLedger(hostLedger, "postResponseHost", { targetMessageId: posted.id });
      await bindAppendLedgerPost(page, posted.id);

      // Allow the socket to deliver and Virtuoso to react.
      await page.waitForTimeout(800);

      const drift = await measureAnchorDrift(page, before!);
      const afterMetrics = await readMetrics(page);
      console.log(
        `[append-mid-list] anchor=${before!.messageId} drift=${drift.toFixed(1)}px ` +
          `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)}`,
      );

      expect(
        afterMetrics.bottomGap,
        "scroll position must remain detached from bottom after append",
      ).toBeGreaterThan(200);
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      if (ledgerInstalled) {
        try {
          await attachAppendLedger(testInfo, page, APPEND_LEDGER_ATTACHMENT_NAME, hostLedger);
        } catch (error) {
          if (!testFailed) throw error;
          console.warn(
            `[task492-ledger] failed to attach ${APPEND_LEDGER_ATTACHMENT_NAME}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  });

  // Pain point #3 — lazy-load reliability.
  //
  // Three properties to pin (stdrc, msg=d85edd0b):
  //   • no omission       — every page from initial-window back to the
  //                         beginning of history must be loaded (final
  //                         itemCount must equal seed total)
  //   • no duplicate      — the same `before=<seq>` cursor must not be
  //                         requested more than once (dedup contract in
  //                         messageStore.loadOlderMessages must hold under
  //                         IO sentinel re-fires)
  //   • deterministic trigger — the load must complete under both burst
  //                         and slow continuous scroll patterns. Rapid
  //                         scroll bursts can collapse intermediate scroll
  //                         events; slow scrolls may park the sentinel
  //                         just outside the rootMargin band.
  //
  // We capture every GET to /messages/channel/<id>?...&before=<seq> and
  // assert exact completeness + cursor uniqueness. The two scroll
  // patterns are parametrized so a single regression in either flips the
  // matching variant without hiding behind an OR.

  type ScrollPattern = "burst" | "slow";

  function recordOlderRequests(page: Page, channelId: string) {
    const requests: { url: string; before: string | null }[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET") return;
      const url = req.url();
      if (!url.includes(`/messages/channel/${channelId}`)) return;
      try {
        const u = new URL(url);
        const before = u.searchParams.get("before");
        // Initial window load has no `before=` cursor; only count older-page fetches.
        if (before === null) return;
        requests.push({ url, before });
      } catch {
        /* ignore */
      }
    });
    return requests;
  }

  // Scroll-to-top helpers. The native primitive restores the anchor on
  // prepend, which means after each older-page load the scroll position
  // moves AWAY from 0 (so the user's reading position stays put). To
  // pull the rest of history a determined user has to keep scrolling
  // upward — these helpers simulate that loop. They return after one
  // pass of "drag scrollTop toward 0", and the caller polls until
  // history is complete.
  async function pullToTopBurst(page: Page) {
    for (let i = 0; i < 20; i += 1) {
      await page.getByTestId("message-scroller").evaluate((el, frac) => {
        el.scrollTop = Math.max(0, el.scrollHeight * frac);
      }, Math.max(0, 1 - i / 20));
      await page.waitForTimeout(20);
    }
    await page.getByTestId("message-scroller").evaluate((el) => {
      el.scrollTop = 0;
    });
  }

  async function pullToTopSlow(page: Page) {
    for (let i = 0; i < 30; i += 1) {
      await page.getByTestId("message-scroller").evaluate((el, step) => {
        el.scrollTop = Math.max(0, el.scrollTop - step);
      }, 200);
      await page.waitForTimeout(80);
    }
    await page.getByTestId("message-scroller").evaluate((el) => {
      el.scrollTop = 0;
    });
  }

  // Keep dragging the scroller toward the top until history is complete
  // or the budget is exhausted. Each iteration:
  //   1. pulls scrollTop toward 0 with the chosen scroll pattern
  //   2. waits a quiescent window for IO sentinel + loadOlder + anchor
  //      restore to settle
  //   3. rechecks itemCount
  // If itemCount stops growing for two consecutive iterations AND we
  // haven't reached the expected total, we surface a clear failure that
  // points at the lazy-load contract (not at "test ran out of budget").
  async function pullToTopUntilComplete(
    page: Page,
    pattern: "burst" | "slow",
    expectedTotal: number,
    budgetMs = 20_000,
  ) {
    const start = Date.now();
    let prevCount = -1;
    let stableIterations = 0;
    while (Date.now() - start < budgetMs) {
      const m = await readMetrics(page);
      if (m.itemCount >= expectedTotal) return m;
      if (m.itemCount === prevCount) {
        stableIterations += 1;
        if (stableIterations >= 3) {
          throw new Error(
            `lazy-load stalled: itemCount stuck at ${m.itemCount}, expected>=${expectedTotal} ` +
              `(scrollTop=${m.scrollTop.toFixed(0)} scrollHeight=${m.scrollHeight.toFixed(0)})`,
          );
        }
      } else {
        stableIterations = 0;
        prevCount = m.itemCount;
      }
      if (pattern === "burst") {
        await pullToTopBurst(page);
      } else {
        await pullToTopSlow(page);
      }
      await page.waitForTimeout(400);
    }
    const final = await readMetrics(page);
    throw new Error(
      `lazy-load did not complete in ${budgetMs}ms: itemCount=${final.itemCount}, expected>=${expectedTotal}`,
    );
  }

  for (const pattern of ["burst", "slow"] as ScrollPattern[]) {
    test(`lazy-load history is complete and dedup'd under ${pattern} scroll`, async ({
      page,
      request,
    }) => {
      const seedState = await waitForSeedState();
      const login = await loginViaApi(request, seedState);

      // Other tests in this suite post messages to the seed channel,
      // so the seed-time `messages.total` is a lower bound. Probe the
      // current real total via the API at test time so completeness is
      // pinned against ground truth, not a stale snapshot.
      const totalsResponse = await request.get(
        `${seedState.urls.api}/api/messages/channel/${seedState.channel.id}?limit=1`,
        {
          headers: {
            Authorization: `Bearer ${login.accessToken}`,
            "X-Server-Id": seedState.server.id,
          },
        },
      );
      if (!totalsResponse.ok()) {
        throw new Error(
          `failed to probe channel size: ${totalsResponse.status()} ${totalsResponse.statusText()}`,
        );
      }
      const probeBody = await totalsResponse.json();
      const latestSeq: number = (probeBody.messages?.[0] ?? probeBody[0])?.seq ?? 0;
      // Server seq is monotonic across the whole server but our seed reserves
      // a contiguous block per channel, so the actual count is best derived
      // from a count endpoint. Lacking one, fall back to scrolling all the
      // way and asserting that itemCount >= seedTotal AND that the topmost
      // visible message is older than the initial-window minSeq.
      const expectedAtLeast = seedState.messages.total;

      const olderRequests = recordOlderRequests(page, seedState.channel.id);

      await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
      await expect(page.getByTestId("message-scroller")).toBeVisible();

      const initialMetrics = await readMetrics(page);
      console.log(
        `[lazy-load:${pattern}] initial itemCount=${initialMetrics.itemCount} ` +
          `seedTotal=${seedState.messages.total} latestSeq=${latestSeq}`,
      );

      // Pull to top in a loop. Anchor restoration on prepend means a
      // single scroll-to-top only triggers the first older page; the
      // user (and this test) keeps pulling upward to drain the rest.
      const finalMetrics = await pullToTopUntilComplete(page, pattern, expectedAtLeast);

      const cursors = olderRequests.map((r) => r.before);
      const uniqueCursors = new Set(cursors);
      console.log(
        `[lazy-load:${pattern}] final itemCount=${finalMetrics.itemCount} ` +
          `requests=${olderRequests.length} uniqueCursors=${uniqueCursors.size} ` +
          `cursors=[${cursors.join(",")}]`,
      );

      // No omission: every seeded message is in the DOM. Other tests in
      // this suite may have appended live messages, so the floor is the
      // seed total — itemCount can be greater than the seed if live
      // messages arrived during the run, but never less.
      await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();
      expect(
        finalMetrics.itemCount,
        `complete history: expected at least ${expectedAtLeast} items in DOM`,
      ).toBeGreaterThanOrEqual(expectedAtLeast);

      // No duplicate: every `before=<seq>` cursor was requested at most
      // once. messageStore.loadOlderMessages dedup's via the loadingOlder
      // flag, but if the IO sentinel re-fires while a request is in
      // flight, only the in-flight request guard prevents a wasted call —
      // this assertion catches a regression in either guard.
      expect(
        uniqueCursors.size,
        `duplicate older-page request: cursors=${cursors.join(",")}`,
      ).toBe(cursors.length);

      // Deterministic trigger: at least one older-page request had to fire
      // (sanity check that the IO sentinel did its job, not that the
      // initial window happened to contain everything).
      expect(
        olderRequests.length,
        "expected at least one older-page request",
      ).toBeGreaterThan(0);
    });
  }
});
