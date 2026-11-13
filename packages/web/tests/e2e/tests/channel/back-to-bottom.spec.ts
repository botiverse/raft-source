import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedChannelHistory, test } from "../../fixtures/scenario";
import { loadedMessageCount } from "../../fixtures/timeline";

// Each test runs in a tenant of its own (fixtures/scenario: its own owner,
// server and channel, with a seeded history): specs in other workers post to
// the shared seeded channel, so its seeded latest message is not always the
// newest, and the virtual timeline does not mount it at the tail. The
// scenario owner has the onboarding setup gate dismissed already.

// Distance from the real bottom of the message scroller, in CSS pixels.
async function measureBottomGap(page: Page) {
  const scroller = page.getByTestId("message-scroller");
  return scroller.evaluate((el) =>
    Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
  );
}

// Smooth-scroll + late image/measurement reflow can make a single snapshot
// misleading. Poll until the gap is stable for two consecutive ticks.
async function waitForStableGap(page: Page, { timeoutMs = 6000, tickMs = 200 } = {}) {
  let last: { gap: number; scrollHeight: number } | null = null;
  let stable = 0;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await page.getByTestId("message-scroller").evaluate((el) => ({
      gap: Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight),
      scrollHeight: el.scrollHeight,
    }));
    if (last && snapshot.gap === last.gap && snapshot.scrollHeight === last.scrollHeight) {
      stable += 1;
      if (stable >= 2) return snapshot.gap;
    } else {
      stable = 0;
    }
    last = snapshot;
    await page.waitForTimeout(tickMs);
  }
  return last?.gap ?? (await measureBottomGap(page));
}

test.describe("Back to bottom", () => {
  test("smooth scroll lands at the actual bottom even when new messages arrive mid-flight", async ({
    page,
    request,
    scenario,
  }) => {
    const { seed, login } = scenario;
    const history = await seedChannelHistory(seed);

    await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByText(history.latestContent)).toBeVisible();

    // Leave the live tail with real user input. Directly assigning scrollTop
    // would move the viewport without changing the user's follow-bottom intent.
    // The first bounded gesture makes the off-bottom affordance the readiness
    // signal; the second records a fresh user gesture after initial positioning.
    const scroller = page.getByTestId("message-scroller");
    await scroller.hover();
    await page.mouse.wheel(0, -700);

    const bottomButton = page
      .locator('button:has-text("Back to bottom"), button:has-text("new message")')
      .first();
    await expect(bottomButton).toBeVisible();
    await page.mouse.wheel(0, -700);
    await expect.poll(() => measureBottomGap(page)).toBeGreaterThan(500);

    // A user who has deliberately left the tail must stay there when another
    // message arrives before they choose to return. Besides protecting that
    // behavior, this keeps the setup honest: a script-only scroll preserves
    // follow-bottom intent and would jump back to the tail here.
    const preClickContent = `[back-to-bottom] before click ${Date.now()}`;
    const loadedBeforePost = await loadedMessageCount(page.getByTestId("message-scroller"));
    const preClickResponse = await request.post(`${seed.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seed.server.id,
      },
      data: {
        channelId: seed.channel.id,
        content: preClickContent,
      },
    });
    expect(preClickResponse.ok()).toBe(true);
    // Arrived below the view (not mounted by the virtual timeline).
    await expect.poll(() => loadedMessageCount(page.getByTestId("message-scroller"))).toBeGreaterThan(loadedBeforePost);
    await expect.poll(() => measureBottomGap(page)).toBeGreaterThan(250);
    await expect(bottomButton).toBeVisible();

    // Click and immediately fire a burst of REST appends. Each append grows
    // scrollHeight while the smooth scroll is in flight; without the fix the
    // smooth target latches onto a stale height and undershoots.
    await bottomButton.click();
    const burstContents = Array.from(
      { length: 5 },
      (_, i) => `[back-to-bottom] mid-flight ${i + 1} ${Date.now()}-${i}`,
    );
    const burst = burstContents.map((content, i) =>
      (async () => {
        await page.waitForTimeout(i * 60);
        await request.post(`${seed.urls.api}/api/messages`, {
          headers: {
            Authorization: `Bearer ${login.accessToken}`,
            "X-Server-Id": seed.server.id,
          },
          data: {
            channelId: seed.channel.id,
            content,
          },
        });
      })(),
    );
    await Promise.all(burst);
    await page.evaluate(async (channelId) => {
      await window.__SLOCK_E2E__!.loadMessages(channelId);
    }, seed.channel.id);
    await expect(page.getByText(burstContents[burstContents.length - 1])).toBeAttached();

    const finalGap = await waitForStableGap(page, { timeoutMs: 8000 });
    // Allow up to one item height for layout settling (matches the smoke spec).
    expect(finalGap).toBeLessThan(40);
  });

  test("clicking back to bottom from a context window lands on the latest message", async ({
    page,
    scenario,
  }) => {
    const { seed } = scenario;
    const history = await seedChannelHistory(seed);

    // Permalink load: opens a context window centered on focusMessageId with
    // hasNewer=true, so the user is sitting in a window detached from the tail.
    await page.goto(
      `/s/${seed.server.slug}/channel/${seed.channel.id}?msg=${history.focusMessageId}`,
    );
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    // The focused message should be visible (we're in its context window).
    // The latest message should NOT be in the viewport — that's what makes
    // Back to bottom exit the context window rather than just scroll. (The
    // native primitive keeps off-screen items in DOM, so check viewport
    // intersection rather than DOM presence.)
    await expect(page.getByText(history.latestContent)).not.toBeInViewport();

    const bottomButton = page
      .locator('button:has-text("Back to bottom"), button:has-text("new message")')
      .first();
    await expect(bottomButton).toBeVisible();
    await bottomButton.click();

    // After loadMessages completes the latest message must be visible and the
    // scroller should be parked at the real bottom.
    await expect(page.getByText(history.latestContent)).toBeVisible();
    const finalGap = await waitForStableGap(page, { timeoutMs: 8000 });
    expect(finalGap).toBeLessThan(40);
  });
});

// Task #758 (Artea): a press once slid the pill half its width (a pressed
// translate replaced the `-translate-x-1/2` that centres it), so a person's
// release landed on the message text and no click happened. Raft's press only
// adds a wash: no colour swap, no shift, no scale (DS foundations, Motion), so
// a held press leaves the button exactly where it was. Playwright's click()
// releases in the same instant, before any transition, so this test holds the
// button down the way a hand does.
test.describe("Back to bottom (held press)", () => {
  test("a held press keeps the button under the pointer, and releasing it returns to the bottom", async ({ page, scenario }) => {
    const { seed } = scenario;
    const history = await seedChannelHistory(seed);

    await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByText(history.latestContent)).toBeVisible();
    const scroller = page.getByTestId("message-scroller");
    await scroller.hover();
    await page.mouse.wheel(0, -700);
    // Locate by testid, not by label: the label flips between "Back to bottom"
    // and "N new messages" as the badge counter updates, so an append can flip
    // it between toBeVisible and boundingBox and the locator dies waiting for
    // a text that is no longer there (staging e2e (1), 2026-10-20, when this
    // test still ran on the shared seeded channel).
    const bottomButton = page.getByTestId("back-to-bottom").first();
    await expect(bottomButton).toBeVisible();
    await page.mouse.wheel(0, -700);
    await expect.poll(() => measureBottomGap(page)).toBeGreaterThan(500);
    await page.waitForTimeout(300);

    const rest = (await bottomButton.boundingBox())!;
    const x = rest.x + rest.width / 2;
    const y = rest.y + rest.height / 2;
    await page.mouse.move(x, y);
    await page.waitForTimeout(250);
    await page.mouse.down();
    await page.waitForTimeout(250);
    const pressed = (await bottomButton.boundingBox())!;
    const underPointer = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("button")?.getAttribute("data-testid") ?? null, [x, y]);
    expect(Math.abs(pressed.x - rest.x), "a press adds a wash and does not move the button").toBeLessThanOrEqual(0.5);
    // Same reason as the locator above: assert the element under the pointer is
    // the back-to-bottom button itself, not its (transient) label text.
    expect(underPointer, "the pointer is still on the button while it is held").toBe("back-to-bottom");
    await page.mouse.up();

    expect(await waitForStableGap(page, { timeoutMs: 8000 })).toBeLessThan(40);
  });
});
