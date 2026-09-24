import { test } from "@playwright/test";
import { expectCssColor } from "../fixtures/colorAssertions";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";

/**
 * Pins the desktop layout color contract from stdrc 2026-05-02
 * #proj-uiux:95e25b5b. After research-driven iteration through
 * paper / yellow / cool-gray / warm-yellow candidates, the chosen
 * three-band hierarchy is:
 *
 *   LeftRail (yellow #FFD440)
 *     │
 *     │  Sidebar column (cream #FFFAEF — desktop only)
 *     │    └─ Sidebar header h-[62px] also cream
 *     │
 *     │  Main panel column (white #FFFFFF)
 *     │    └─ Chat header h-[62px] also white
 *     │    └─ Messages scroller white
 *
 * Mobile (<md) flips the rule: every full-screen tab interior is
 * white including the sidebar (since there's no side-by-side to
 * differentiate against).
 *
 * Vertical column dividers are border-r-2 / border-l-2 to match
 * the horizontal border-b-2 used by panel headers.
 *
 * This spec asserts the rendered backgroundColor for each region
 * via getComputedStyle, so any regression on the @theme tokens or
 * on the Tailwind class names lights up here. */
test.describe("layout color contract (desktop)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("LeftRail = yellow / Sidebar = cream / Main = white", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);
    await page.goto(seedState.urls.web);
    // Wait for the desktop shell to be present.
    await page.waitForSelector(".bg-soft-signal", { timeout: 10_000 });

    const colors = await page.evaluate(() => {
      // The LeftRail is the only top-level yellow column in the desktop
      // shell. Match it loosely on the brand-yellow class so this selector
      // survives width / arbitrary-value adjustments to the rail's outer
      // div (PR #1281 moved it from `w-14` to `w-[64px]`).
      const leftRail = Array.from(
        document.querySelectorAll<HTMLElement>("div.bg-soft-signal"),
      ).find(
        (el) =>
          el.className.toString().includes("border-r-2") &&
          el.className.toString().includes("flex-col"),
      ) as HTMLElement | null;
      const sidebar = document.querySelector(
        "div.bg-brutal-cream",
      ) as HTMLElement | null;
      // Find the main content wrapper that has md:bg-white. On md+ it
      // resolves to white; on smaller viewports the class doesn't apply.
      const mainCandidate = Array.from(
        document.querySelectorAll<HTMLElement>("div"),
      ).find(
        (el) =>
          el.className &&
          el.className.toString().includes("md:bg-white") &&
          el.className.toString().includes("flex-1"),
      ) as HTMLElement | null;
      return {
        leftRail: leftRail ? getComputedStyle(leftRail).backgroundColor : null,
        sidebar: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
        main: mainCandidate
          ? getComputedStyle(mainCandidate).backgroundColor
          : null,
      };
    });

    // brutal-yellow = #FFD440 = rgb(255, 212, 64)
    await expectCssColor(page, colors.leftRail, "#FFD440");
    // brutal-cream = #FFFAEF = rgb(255, 250, 239)
    await expectCssColor(page, colors.sidebar, "#FFFAEF");
    // bg-white = #FFFFFF
    await expectCssColor(page, colors.main, "#FFFFFF");
  });
});
