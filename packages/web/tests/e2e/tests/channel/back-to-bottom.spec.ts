import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";

// The seeded owner has no machines/agents, so the onboarding setup gate would
// otherwise intercept clicks. Opt the user out of it before navigating.
async function dismissOwnerOnboarding(
  request: APIRequestContext,
  seedState: PlaywrightSeedState,
  accessToken: string,
) {
  const response = await request.patch(
    `${seedState.urls.api}/api/servers/${seedState.server.id}/onboarding-settings`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: { setupModalReminderOptOut: true },
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Failed to opt out of onboarding modal: ${response.status()} ${response.statusText()}`,
    );
  }
}

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
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByTestId("message-scroller")).toBeVisible();
    await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();

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
    const preClickResponse = await request.post(`${seedState.urls.api}/api/messages`, {
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        "X-Server-Id": seedState.server.id,
      },
      data: {
        channelId: seedState.channel.id,
        content: preClickContent,
      },
    });
    expect(preClickResponse.ok()).toBe(true);
    await expect(page.getByText(preClickContent)).toBeAttached();
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
        await request.post(`${seedState.urls.api}/api/messages`, {
          headers: {
            Authorization: `Bearer ${login.accessToken}`,
            "X-Server-Id": seedState.server.id,
          },
          data: {
            channelId: seedState.channel.id,
            content,
          },
        });
      })(),
    );
    await Promise.all(burst);
    await page.evaluate(async (channelId) => {
      await window.__SLOCK_E2E__!.loadMessages(channelId);
    }, seedState.channel.id);
    await expect(page.getByText(burstContents[burstContents.length - 1])).toBeAttached();

    const finalGap = await waitForStableGap(page, { timeoutMs: 8000 });
    // Allow up to one item height for layout settling (matches the smoke spec).
    expect(finalGap).toBeLessThan(40);
  });

  test("clicking back to bottom from a context window lands on the latest message", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    // Permalink load: opens a context window centered on focusMessageId with
    // hasNewer=true, so the user is sitting in a window detached from the tail.
    await page.goto(
      `/s/${seedState.server.slug}/channel/${seedState.channel.id}?msg=${seedState.messages.focusMessageId}`,
    );
    await expect(page.getByTestId("message-scroller")).toBeVisible();

    // The focused message should be visible (we're in its context window).
    // The latest message should NOT be in the viewport — that's what makes
    // Back to bottom exit the context window rather than just scroll. (The
    // native primitive keeps off-screen items in DOM, so check viewport
    // intersection rather than DOM presence.)
    await expect(page.getByText(seedState.messages.latestContent)).not.toBeInViewport();

    const bottomButton = page
      .locator('button:has-text("Back to bottom"), button:has-text("new message")')
      .first();
    await expect(bottomButton).toBeVisible();
    await bottomButton.click();

    // After loadMessages completes the latest message must be visible and the
    // scroller should be parked at the real bottom.
    await expect(page.getByText(seedState.messages.latestContent)).toBeVisible();
    const finalGap = await waitForStableGap(page, { timeoutMs: 8000 });
    expect(finalGap).toBeLessThan(40);
  });
});
