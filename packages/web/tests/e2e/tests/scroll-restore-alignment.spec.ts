import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

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

// Mirror MessageTimeline.captureAnchor's semantic: the topmost message whose
// bottom is below the scroller's top edge. This is what the primitive
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

test.describe("message list scroll restore alignment", () => {
  test("persisted scroll resumes at the saved message's top, not centered", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

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

    // Reload — sessionStorage survives, ChatPanel sees the persisted id and
    // calls loadMessageWindowSilent(persistedId), MessageTimeline remounts
    // and runs the initial-position pick against persistKey.
    await page.reload();
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    // Wait for the timeline to settle on its initial position pick.
    await page.waitForTimeout(600);

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
