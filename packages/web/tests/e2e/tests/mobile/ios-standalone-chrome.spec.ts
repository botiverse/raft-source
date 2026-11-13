import { expect, test } from "@playwright/test";
import { expectCssColor } from "../../fixtures/colorAssertions";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("mobile iOS standalone chrome", () => {
  test("lets the app wrapper own the safe-area color per route", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);

    await page.goto(`/s/${seedState.server.slug}`);
    // The sidebar header's server name: the tab bar's server tab carries it too.
    await expect(page.getByTestId("mobile-workspace-trigger").getByText(seedState.server.name)).toBeVisible();

    const rootColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        statusBarStyle: document
          .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
          ?.content,
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });

    expect(rootColors.themeColor).toBe("#FFD440");
    expect(rootColors.statusBarStyle).toBe("black-translucent");
    // The page canvas is paper; the wrapper paints the frame on tab roots and
    // paper on pushed pages (Raft DS: yellow frame, every phone screen on paper).
    await expectCssColor(page, rootColors.html, "#FFFFFF");
    await expectCssColor(page, rootColors.body, "#FFFFFF");
    await expectCssColor(page, rootColors.appRoot, "#FFD440", 1);

    await page.goto(`/s/${seedState.server.slug}/tasks`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    const tasksRootColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });
    expect(tasksRootColors.themeColor).toBe("#FFD440");
    await expectCssColor(page, tasksRootColors.appRoot, "#FFD440", 1);

    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page.getByPlaceholder(`Message #${seedState.channel.name}`)).toBeVisible();

    const detailColors = await page.evaluate(() => {
      const appRoot = document.querySelector<HTMLElement>("#root > div");
      return {
        themeColor: document
          .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
          ?.content,
        appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
      };
    });

    expect(detailColors.themeColor).toBe("#FFFFFF");
    await expectCssColor(page, detailColors.appRoot, "#FFFFFF");
  });

  // Raft DS › MobileNav (edge bar, stdrc 2026-10-21): the tab bar is the last
  // thing in the column, in flow, full width and flush with the bottom edge,
  // with a seam on top; nothing else floats over the content. A tab root
  // wears the frame (yellow in light, the neutral #0d0d0b in dark) and the
  // browser chrome follows it.
  test("the tab bar is an in-flow edge bar flush with the bottom under the frame-coloured shell, in light and dark", async ({
    page,
    request,
  }) => {
    const seedState = await waitForSeedState();
    await loginViaApi(request, seedState);

    const setDeviceThemeMode = async (mode: "light" | "dark") => {
      await page.evaluate((nextMode) => {
        window.localStorage.setItem("slock-theme-preferences-v2", JSON.stringify({ mode: nextMode }));
      }, mode);
      await page.reload();
    };

    const readShell = async () =>
      page.evaluate(() => {
        const appRoot = document.querySelector<HTMLElement>("#root > div");
        const nav = document.querySelector<HTMLElement>('[data-slot="mobile-nav-root"]');
        const navStyle = nav ? getComputedStyle(nav) : null;
        return {
          themeColor: document
            .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
            ?.content,
          appRoot: appRoot ? getComputedStyle(appRoot).backgroundColor : null,
          navPosition: navStyle?.position ?? null,
          navBorderTopWidth: navStyle?.borderTopWidth ?? null,
          navBorderBottomWidth: navStyle?.borderBottomWidth ?? null,
          navRadius: navStyle?.borderTopLeftRadius ?? null,
          floatingOverlays: document.querySelectorAll(
            '[data-testid="mobile-bottom-bar-overlay"], [data-testid="mobile-live-activity-slot"]',
          ).length,
        };
      });

    await page.goto(`/s/${seedState.server.slug}`);
    // The sidebar header's server name: the tab bar's server tab carries it too.
    await expect(page.getByTestId("mobile-workspace-trigger").getByText(seedState.server.name)).toBeVisible();

    for (const [mode, frame] of [["light", "#FFD440"], ["dark", "#0D0D0B"]] as const) {
      await setDeviceThemeMode(mode);
      // The sidebar header's server name: the tab bar's server tab carries it too.
      await expect(page.getByTestId("mobile-workspace-trigger").getByText(seedState.server.name)).toBeVisible();

      const shell = await readShell();
      expect(shell.themeColor).toBe(frame);
      await expectCssColor(page, shell.appRoot, frame, 1);
      expect(shell.navPosition).not.toBe("fixed");
      expect(shell.navPosition).not.toBe("absolute");
      expect(shell.navBorderTopWidth).toBe("1px");
      expect(shell.floatingOverlays).toBe(0);

      expect(shell.navBorderBottomWidth).toBe("0px");
      expect(shell.navRadius).toBe("0px");

      // The bar spans the width and its bottom edge is the viewport's
      // (MobileNav Anatomy; no safe-area inset in this viewport).
      const navBox = await page.locator('[data-slot="mobile-nav-root"]').boundingBox();
      expect(navBox).not.toBeNull();
      const viewport = page.viewportSize()!;
      expect(Math.abs(viewport.height - ((navBox?.y ?? 0) + (navBox?.height ?? 0)))).toBeLessThanOrEqual(1);
      expect(Math.abs(navBox?.x ?? 0)).toBeLessThanOrEqual(1);
      expect(Math.abs(viewport.width - (navBox?.width ?? 0))).toBeLessThanOrEqual(1);
    }

    // Five slots: four tabs, then the current server (the server tab, whose
    // avatar stands where the others have an icon). Every icon sits on one
    // line at one size whether or not its tab carries a dot (the Activity
    // icon used to ride up when its dot joined the item's column).
    const items = page.locator('[data-slot="mobile-nav-root"] [data-slot="mobile-nav-item"]');
    await expect(items).toHaveCount(4);
    expect(await items.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual([
      "Home",
      "Activity",
      "Tasks",
      "Search",
    ]);
    await expect(page.locator('[data-slot="mobile-nav-root"] [data-slot="mobile-nav-server-item"]')).toHaveCount(1);
    const iconBoxes = await page
      .locator('[data-slot="mobile-nav-root"] button')
      .evaluateAll((els) => els
        .map((el) => el.querySelector('[data-slot="avatar"], svg')!.getBoundingClientRect())
        .map((r) => ({ top: r.top, height: r.height })));
    expect(iconBoxes).toHaveLength(5);
    for (const box of iconBoxes) {
      expect(Math.abs(box.top - iconBoxes[0].top)).toBeLessThanOrEqual(0.5);
      expect(box.height).toBe(22);
    }

    // The list ends above the bar: its last row scrolls fully clear of it
    // without any reserved clearance under the bar.
    const lastRow = page.locator("[data-sidebar-channel-id]").last();
    await lastRow.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="sidebar-scroll-surface"]',
      );
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    const rowBox = await lastRow.boundingBox();
    const navBox = await page.locator('[data-slot="mobile-nav-root"]').boundingBox();
    expect(rowBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual((navBox?.y ?? 0) + 1);
  });
});
