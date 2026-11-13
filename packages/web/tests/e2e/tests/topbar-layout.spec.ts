import { expect, test } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

/**
 * Task #753 (WAWQAQ 2026-10-13): at desktop width the web has the desktop
 * app's top bar. It owns the server switcher and the search entry, which left
 * the rail. This file used to pin the rail's square server slot (stdrc
 * 2026-05-02); that slot no longer exists in the signed-in shell, so the
 * layout facts worth pinning are the bar's.
 *
 * What a user sees, measured in a real browser (jsdom has no layout):
 *   - one 44px bar across the top (the desktop header: 32px frame items with
 *     6px above and below), the rail starting right under it;
 *   - the search field centred on the window, whatever the left side holds;
 *   - the rail without a second server switcher or Search tab;
 *   - the Bell at the bar's right end, its panel opening under it; Help on the
 *     rail, right above Settings;
 *   - the channel column without its title row;
 *   - the search overlay opening from the field: same top edge, covering it;
 *   - no bar at phone width, where the app switches to tabs.
 */
test.describe("top bar layout", () => {
  for (const viewport of [
    { width: 1280, height: 800, label: "desktop" },
    { width: 1024, height: 800, label: "narrow desktop" },
    { width: 800, height: 800, label: "just above the phone breakpoint" },
  ] as const) {
    test(`${viewport.label} ${viewport.width}px: bar on top, search centred, overlay opens from the field`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const seedState = await waitForSeedState();
      await loginViaApi(request, seedState);
      await page.goto(seedState.urls.web);

      const bar = page.getByTestId("app-top-bar");
      const field = page.getByTestId("app-top-bar-search");
      const rail = page.getByTestId("workspace-left-rail");
      await expect(bar).toBeVisible({ timeout: 15_000 });
      await expect(rail).toBeVisible();
      // Opening the root URL redirects to the default channel; wait for that
      // view (its composer) so panels are not opened mid-redirect and lost.
      await expect(page.locator("textarea")).toBeVisible({ timeout: 15_000 });

      const barBox = (await bar.boundingBox())!;
      const fieldBox = (await field.boundingBox())!;
      const railBox = (await rail.boundingBox())!;
      expect(barBox.y).toBe(0);
      expect(barBox.height).toBe(44);
      expect(barBox.width).toBe(viewport.width);
      expect(Math.abs(railBox.y - (barBox.y + barBox.height))).toBeLessThanOrEqual(0.5);
      // Centred on the window: the two side regions are equal by construction,
      // so a control added to one side must not push the field off centre.
      expect(Math.abs(fieldBox.x + fieldBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
      expect(fieldBox.x).toBeGreaterThanOrEqual(0);
      expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(viewport.width);

      // One entry each: the rail does not repeat what the bar owns.
      await expect(page.locator('[data-slot="app-rail-header"]')).toHaveCount(0);
      await expect(page.getByTestId("left-rail-tab-search")).toHaveCount(0);
      // The channel column starts with its list: no title row repeating the
      // rail's selected tab (same as the desktop app).
      await expect(page.locator('[data-testid="sidebar-root"] > .h-panel-header')).toHaveCount(0);

      const overflow = await page.evaluate(() => ({
        x: document.documentElement.scrollWidth > window.innerWidth,
        y: document.documentElement.scrollHeight > window.innerHeight,
      }));
      expect(overflow).toEqual({ x: false, y: false });

      // The Bell sits at the bar's right end, not on the rail, and opens its
      // panel under the bar, inside the window. Help stays on the rail, right
      // above Settings (cindyz 2026-10-14).
      await expect(page.getByTestId("notification-trigger-rail")).toHaveCount(0);
      const helpBox = (await page.getByTestId("left-rail-help").boundingBox())!;
      const settingsBox = (await page.getByTestId("left-rail-settings").boundingBox())!;
      expect(helpBox.x).toBeGreaterThanOrEqual(railBox.x);
      expect(helpBox.x + helpBox.width).toBeLessThanOrEqual(railBox.x + railBox.width + 0.5);
      expect(helpBox.y + helpBox.height, "Help directly above Settings").toBeLessThanOrEqual(settingsBox.y + 0.5);
      expect(settingsBox.y - (helpBox.y + helpBox.height), "no gap between Help and Settings").toBeLessThanOrEqual(12);
      for (const [trigger, panel] of [
        ["notification-trigger-top-bar", "notification-center"],
      ] as const) {
        const button = page.getByTestId(trigger);
        // While the server is still being resolved the bar holds a placeholder
        // Bell that opens nothing (PendingNotificationTrigger); the live one is
        // the popover trigger. Click that one.
        await expect(button).toHaveAttribute("aria-haspopup", "dialog", { timeout: 15_000 });
        const buttonBox = (await button.boundingBox())!;
        expect(buttonBox.x).toBeGreaterThan(fieldBox.x + fieldBox.width);
        expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(barBox.height);
        await button.click();
        await expect(page.getByTestId(panel), `${trigger} opens its panel`).toBeVisible();
        const panelBox = (await page.getByTestId(panel).boundingBox())!;
        expect(panelBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
        expect(panelBox.x).toBeGreaterThanOrEqual(0);
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId(panel)).toHaveCount(0);
      }

      await field.click();
      const overlay = page.getByTestId("desktop-search-overlay");
      await expect(overlay).toBeVisible();
      const overlayBox = (await overlay.boundingBox())!;
      expect(Math.abs(overlayBox.y - fieldBox.y)).toBeLessThanOrEqual(0.5);
      expect(overlayBox.x).toBeLessThanOrEqual(fieldBox.x);
      expect(overlayBox.x + overlayBox.width).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width);
      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);
    });
  }

  test("phone width 390px: no top bar", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);
    await page.goto(seedState.urls.web);
    await expect(page.locator("[data-testid='sidebar-root'], textarea").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("app-top-bar")).toHaveCount(0);
  });
});

// A host shell reserves window-chrome space at one edge of the bar (the
// desktop: 82px for the macOS traffic lights on the left, ~138px for the
// Windows caption buttons on the right). It pads the bar and publishes the
// same amount as --raft-titlebar-inset-start / -end. The search field must
// stay centred on the window (the search overlay is), and the regions must
// not run under it. The web shell cannot be a title bar, so the test applies
// the shell's padding and variables itself.
test.describe("top bar keeps the search field on the window centre when a shell reserves an edge", () => {
  for (const reserve of [
    { label: "macOS traffic lights (left 82px)", start: 82, end: 0 },
    { label: "Windows caption buttons (right 138px)", start: 0, end: 138 },
  ] as const) {
    for (const width of [1280, 960]) {
      test(`${reserve.label}, ${width}px`, async ({ page, request }) => {
        await page.setViewportSize({ width, height: 800 });
        const seedState = await waitForSeedState();
        await loginViaApi(request, seedState);
        await page.goto(seedState.urls.web);
        const bar = page.getByTestId("app-top-bar");
        await expect(bar).toBeVisible({ timeout: 15_000 });
        await expect(page.locator("textarea")).toBeVisible({ timeout: 15_000 });
        await page.addStyleTag({
          content: `[data-testid="app-top-bar"] {
            padding-left: ${reserve.start}px; padding-right: ${reserve.end}px;
            --raft-titlebar-inset-start: ${reserve.start}px; --raft-titlebar-inset-end: ${reserve.end}px;
          }`,
        });
        const m = await bar.evaluate((el) => {
          const field = el.querySelector('[data-testid="app-top-bar-search"]')!.getBoundingClientRect();
          const [leading, , trailing] = [...el.children].map((c) => c.getBoundingClientRect());
          return { fieldCentre: field.left + field.width / 2, fieldLeft: field.left, fieldRight: field.right, leadingRight: leading.right, trailingLeft: trailing.left };
        });
        expect(Math.abs(m.fieldCentre - width / 2), "field centred on the window").toBeLessThanOrEqual(1);
        expect(m.leadingRight, "left region ends before the field").toBeLessThanOrEqual(m.fieldLeft + 0.5);
        expect(m.trailingLeft, "right region starts after the field").toBeGreaterThanOrEqual(m.fieldRight - 0.5);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow).toBe(false);
      });
    }
  }
});
