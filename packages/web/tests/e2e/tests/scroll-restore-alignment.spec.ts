import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedChannelHistory, test } from "../fixtures/scenario";

// Regression test for #proj-message task #13 ("点开消息之后会闪到往上一些
// 的位置而不是消息列表底部").
//
// MessageTimeline's persistKey path saves the topmost-visible message id and
// recalls it on remount. The save semantic (captureAnchor → topmost partially-
// visible item) and the restore semantic (scrollIntoView block alignment)
// must agree. Before the fix the restore used block: "center" which placed
// the saved message in the middle of the viewport — drifting the user up by
// ~clientHeight/2 from where they actually left off. The fix uses
// block: "start" so the saved message lands back at the TOP of the viewport,
// matching where it was when captured. Drift is bounded by message height.

async function readMetrics(page: Page) {
  return page.getByTestId("message-scroller").evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    bottomGap: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
  }));
}

async function scrollAwayFromBottom(page: Page) {
  const scroller = page.getByTestId("message-scroller");
  await scroller.hover();
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(250);
    const { bottomGap } = await readMetrics(page);
    if (bottomGap > 250) break;
  }
}

// Mirror the timeline's top visible row (topVisibleMessage in
// VirtualMessageTimeline): the topmost message whose bottom is below the
// scroller's top edge. This is what the primitive
// persists, so we compare against the same notion of "where was I reading".
async function captureTopmostVisible(page: Page) {
  return page.getByTestId("message-scroller").evaluate((el) => {
    const items = Array.from(
      el.querySelectorAll<HTMLElement>("[data-message-id]"),
    );
    if (items.length === 0) return null;
    const scrollerRect = el.getBoundingClientRect();
    const topGuard = scrollerRect.top + 1;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom > topGuard) {
        const id = item.dataset.messageId;
        if (!id) continue;
        return {
          messageId: id,
          // Distance from the message's top to the viewport's top edge
          // (positive = msg.top is below viewport top; negative = msg.top is
          // scrolled off above viewport top).
          topRelativeToViewport: rect.top - scrollerRect.top,
        };
      }
    }
    return null;
  });
}

// ── Read-only readiness probe (task #497) ───────────────────────────────────
//
// Purpose: separate three candidate causes when `after.messageId` differs from
// `before.messageId` after reload:
//   (i)   the wrong id was persisted,
//   (ii)  the correct id was persisted but had not been restored yet,
//   (iii) the measurement ran before the window settled.
//
// This probe only READS state. It does not change the action sequence, the
// 600ms wait, either assertion, or any product code. It reports only the
// state this scenario needs — never the whole storage, and never credentials.
//
// The storage contract is taken from the product, not assumed:
//   messageTimelineShared.ts — SCROLL_MEMORY_PREFIX = "slock.scroll-memory.v1."
//   ChatPanel.tsx       — persistKey={`channel:${channel.id}`}
//   messageTimelineShared.ts — falls back to an in-memory Map when sessionStorage
//                         is unavailable (a Map does not survive reload).

const SCROLL_MEMORY_PREFIX = "slock.scroll-memory.v1.";

interface ProbeSnapshot {
  /** sessionStorage availability, read the same way the product reads it. */
  storageAvailable: boolean;
  /**
   * Value currently stored for this channel's persistKey, or null.
   *
   * NOTE: null here does NOT mean "never saved". The product calls
   * forgetScroll() when the user returns to the live tail
   * (MessageTimeline: `if (atBottom) forgetScroll(persistKey)`), which
   * removes the entry. So this records "no value present *now*" only.
   */
  persistedId: string | null;
  /** Whether the LRU index mentions this channel's key. */
  indexHasKey: boolean;
  /** Topmost visible message id at the moment of the probe. */
  topmostVisibleId: string | null;
  /** How many message rows are currently mounted. */
  mountedRowCount: number;
  /** Scroller presence + geometry at the moment of the probe. */
  scrollerPresent: boolean;
  bottomGap: number | null;
}

async function probeScrollState(
  page: Page,
  channelId: string,
): Promise<ProbeSnapshot | { probeError: string }> {
  // The probe must never fail the test. `page.evaluate` can reject if it lands
  // during a navigation (execution context destroyed), so it is wrapped here:
  // a probe failure is recorded, not thrown.
  try {
    return await probeScrollStateInner(page, channelId);
  } catch (err) {
    return { probeError: err instanceof Error ? err.message : String(err) };
  }
}

async function probeScrollStateInner(page: Page, channelId: string): Promise<ProbeSnapshot> {
  return page.evaluate(
    ({ prefix, id }) => {
      const key = `${prefix}channel:${id}`;
      // Read availability the way the product does (getStorage()).
      let storage: Storage | null = null;
      try {
        storage = window.sessionStorage;
      } catch {
        storage = null;
      }
      let persistedId: string | null = null;
      let indexHasKey = false;
      if (storage) {
        try {
          persistedId = storage.getItem(prefix + key.slice(prefix.length));
          const raw = storage.getItem(`${prefix}__index__`);
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
            indexHasKey =
              Array.isArray(parsed) &&
              parsed.some((v) => v === key.slice(prefix.length));
          }
        } catch {
          /* quota / disabled */
        }
      }

      const scroller = document.querySelector('[data-testid="message-scroller"]');
      let topmostVisibleId: string | null = null;
      let mountedRowCount = 0;
      let bottomGap: number | null = null;
      if (scroller instanceof HTMLElement) {
        const rows = Array.from(
          scroller.querySelectorAll<HTMLElement>("[data-message-id]"),
        );
        mountedRowCount = rows.length;
        const scrollerRect = scroller.getBoundingClientRect();
        const topGuard = scrollerRect.top + 1;
        for (const row of rows) {
          if (row.getBoundingClientRect().bottom > topGuard) {
            topmostVisibleId = row.dataset.messageId ?? null;
            break;
          }
        }
        bottomGap = Math.max(
          0,
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        );
      }
      return {
        storageAvailable: storage !== null,
        persistedId,
        indexHasKey,
        topmostVisibleId,
        mountedRowCount,
        scrollerPresent: scroller instanceof HTMLElement,
        bottomGap,
      };
    },
    { prefix: SCROLL_MEMORY_PREFIX, id: channelId },
  );
}

test.describe("message list scroll restore alignment", () => {
  test("persisted scroll resumes at the saved message's top, not centered", async ({
    page,
    scenario,
  }) => {
    // A tenant of its own (fixtures/scenario): other specs post to the shared
    // seeded channel, so its seeded latest message is not always at the tail
    // (nor mounted there by the virtual timeline).
    const { seed } = scenario;
    const history = await seedChannelHistory(seed);
    const channelId = seed.channel.id;

    await page.goto(`/s/${seed.server.slug}/channel/${channelId}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByText(history.latestContent)).toBeVisible();

    // Scroll up enough to clear AT_BOTTOM_THRESHOLD (100px) so the save path
    // fires on the next user-driven scroll event. Stay near the bottom so
    // the saved message is roughly a screenful above the tail — this is the
    // exact regime where block:center vs block:start diverges most visibly.
    await scrollAwayFromBottom(page);

    const before = await captureTopmostVisible(page);
    const beforeMetrics = await readMetrics(page);
    expect(before, "should resolve a topmost-visible anchor before reload").not.toBeNull();
    expect(
      beforeMetrics.bottomGap,
      "should be detached from bottom before reload (else save path doesn't fire)",
    ).toBeGreaterThan(150);

    // Probe #1 — the saved value, read before reload. This is candidate (i)'s
    // evidence: if the persisted id is already wrong here, nothing downstream
    // can restore correctly.
    const probeBefore = await probeScrollState(page, channelId);
    console.log(`[scroll-restore-probe] phase=before-reload ${JSON.stringify(probeBefore)}`);

    // Reload — sessionStorage survives, ChatPanel sees the persisted id and
    // calls loadMessageWindowSilent(persistedId), MessageTimeline remounts
    // and runs the initial-position pick against persistKey.
    await page.reload();
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    // Probe #2 — immediately after reload, before the wait. Distinguishes
    // candidate (ii)/(iii): what does the persisted value look like now, and
    // has the window been populated yet?
    const probeAfterReload = await probeScrollState(page, channelId);
    console.log(`[scroll-restore-probe] phase=after-reload ${JSON.stringify(probeAfterReload)}`);

    // Wait for the timeline to settle on its initial position pick.
    await page.waitForTimeout(600);

    // Probe #3 — at the measurement moment, i.e. the state the assertions see.
    const probeAtMeasure = await probeScrollState(page, channelId);
    console.log(`[scroll-restore-probe] phase=at-measure ${JSON.stringify(probeAtMeasure)}`);

    const after = await captureTopmostVisible(page);
    const afterMetrics = await readMetrics(page);
    expect(after, "should resolve a topmost-visible anchor after reload").not.toBeNull();

    // The saved message should still be the topmost-visible (scroll restored
    // to it, not above or below).
    expect(after!.messageId).toBe(before!.messageId);

    // block:start means msg.top aligns with viewport top — its top relative
    // to viewport should be at most ~one message height below 0 (typical
    // message ~50–100px). block:center would drop msg.top to roughly
    // -clientHeight/2 (offscreen above viewport top by ~half a viewport),
    // which fails this bound.
    const drift = Math.abs(after!.topRelativeToViewport);
    console.log(
      `[scroll-restore] msg=${after!.messageId} topRelToViewport=${after!.topRelativeToViewport.toFixed(1)}px ` +
        `bottomGap before=${beforeMetrics.bottomGap.toFixed(0)} after=${afterMetrics.bottomGap.toFixed(0)}`,
    );
    expect(
      drift,
      "saved msg's top should land at/near viewport top (block:start), " +
        "not centered (block:center would push it ~clientHeight/2 off)",
    ).toBeLessThan(150);
  });
});
