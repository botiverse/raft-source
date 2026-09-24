/**
 * Regression for task #393 — rail Search re-click triggers infinite render
 * loop on `MessageSearchPage`.
 *
 * Root cause + repro (msg=443560aa #proj-uiux:f1f5dd99): with `?q=googl` in
 * the URL and `query="googl"` in input state, clicking the rail Search button
 * navigates to `/search` (no q). The URL→input adopt effect (`Effect B`,
 * `setQuery(initialQuery)`) and the input→URL writer (`Effect A`) then
 * disagree about source-of-truth and form a SYMMETRIC ping-pong: A re-asserts
 * `?q=googl` from stale state, B clears query from new URL, next render they
 * flip. Pre-fix repro: 1771 history mutations / 4s, 12,220 DOM mutations,
 * input value attribute mutated 10,622 times, tab clicks blocked.
 *
 * Fix: Effect A tracks the last value it wrote in a ref and bails when the
 * URL's q is not its own write (= external nav like rail Search click).
 *
 * Gate: after rail Search re-click, history mutations must settle within
 * 1s (≤5 navigations is generous — a clean fix is exactly 1: the rail
 * click's own push).
 */

import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

test.describe("search rail re-click — no flicker loop (#393)", () => {
  test("clicking rail Search again with content does not ping-pong URL", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await page.waitForLoadState("networkidle");

    // Patch history.{push,replace}State to count navigations from inside the
    // page so we can measure the symmetric loop directly. The pre-fix bug
    // produces ~440 history calls/sec; even a generous 5-call window over 1s
    // catches it cleanly.
    await page.evaluate(() => {
      (window as unknown as { __navCount: number }).__navCount = 0;
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      history.pushState = (...args: Parameters<typeof history.pushState>) => {
        (window as unknown as { __navCount: number }).__navCount++;
        return origPush(...args);
      };
      history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
        (window as unknown as { __navCount: number }).__navCount++;
        return origReplace(...args);
      };
    });

    // Step 1: open search via the rail.
    await page.locator('[data-testid="left-rail-tab-search"]').click();
    await page.waitForURL(/\/search$/, { timeout: 5_000 });

    // Step 2: type a query and let it commit to the URL.
    const input = page.locator('input[placeholder*="Search" i]').first();
    await input.fill("googl");
    await page.waitForURL(/\/search\?q=googl$/, { timeout: 5_000 });

    // Step 3: snapshot nav count, then click rail Search a SECOND time.
    // Pre-fix: this kicks off the symmetric Effect-A ↔ Effect-B oscillation.
    const before = await page.evaluate(() => (window as unknown as { __navCount: number }).__navCount);
    await page.locator('[data-testid="left-rail-tab-search"]').click();

    // Wait 1 full second of wall-clock — the pre-fix bug fires hundreds of
    // history mutations in this window. Post-fix, exactly 1 is expected
    // (the rail click's own push to /search) plus possibly 1 settle from
    // Effect A bail-and-sync. Cap at 5 with a comment in case some other
    // legit URL writer (filters, sort) happens to land here.
    await page.waitForTimeout(1_000);

    const after = await page.evaluate(() => (window as unknown as { __navCount: number }).__navCount);
    const navsTriggeredByReclick = after - before;

    expect(
      navsTriggeredByReclick,
      `Rail Search re-click triggered ${navsTriggeredByReclick} URL mutations in 1s — `
        + `the symmetric Effect-A/Effect-B ping-pong loop has regressed (#393). `
        + `Pre-fix this number was ~440/s; post-fix the rail click should be a `
        + `single navigation that immediately settles.`,
    ).toBeLessThan(5);

    // Sanity: tabs must remain clickable. Pre-fix the rail buttons were
    // mutating ~440/s and Playwright clicks would be blocked or timeout.
    await page.locator('[data-testid="left-rail-tab-chat"]').click({ timeout: 2_000 });
    await page.waitForURL((url) => !url.toString().includes("/search"), { timeout: 5_000 });
  });
});
