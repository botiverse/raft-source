import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { expectCssColor } from "../../fixtures/colorAssertions";
import { waitForSeedState } from "../../fixtures/seedState";
import type { PlaywrightSeedState } from "../../fixtures/seedState";

test.use({ viewport: { width: 390, height: 844 } });

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

// Raft DS › TabBar: the selected tab's icon sits in a yellow sticker (56×30)
// that wraps only the icon; the cell itself stays on the bar's surface (the
// whole-cell yellow was the product's look before the DS). The sticker is the
// item's ::before.
async function expectSelectedTabSticker(page: Page, tab: Locator) {
  await expect(tab).toHaveAttribute("data-selected", "true");
  const paint = await tab.evaluate((el) => {
    const sticker = getComputedStyle(el, "::before");
    return {
      cell: getComputedStyle(el).backgroundColor,
      sticker: sticker.backgroundColor,
      stickerWidth: sticker.width,
      stickerHeight: sticker.height,
    };
  });
  await expectCssColor(page, paint.sticker, "#FFD440", 1);
  expect({ width: paint.stickerWidth, height: paint.stickerHeight }).toEqual({ width: "56px", height: "30px" });
  await expectCssColor(page, paint.cell, "rgba(0, 0, 0, 0)");
}

// Regression for #255: on the server homepage, switching tabs used to leave
// the sidebar stuck on the Members surface. Root cause was Sidebar's URL→state
// effect ignoring the default-tab case. Fix lives in Sidebar.tsx.
//
// Since 2026-10-22 (stdrc) the bar is Home / Activity / Tasks / Search and the
// current server. The server tab took More's slot: it opens a popover whose
// bottom row pushes Members, Computers and Settings, each a page with Back.
// The old /more link lands on Home.
test.describe("mobile tab bar — home ↔ server tab ↔ members switching", () => {
  test("home → server tab → members → back → home restores chat sidebar", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}`);

    // Home tab is the default surface — Channels header is visible.
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();

    // Tap the server tab: a popover, not a page, and the tab is never selected.
    const serverTab = page.getByTestId("mobile-tab-server");
    await serverTab.click();
    const popover = page.getByRole("dialog", { name: "Servers" });
    await expect(popover).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    await expectSelectedTabSticker(page, page.getByRole("button", { name: "Home" }));

    // Members is a page pushed from the popover: it covers the bar and has Back.
    await popover.getByTestId("mobile-server-tab-members").click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/members$`));
    await expect(page.getByTestId("members-page")).toBeVisible();
    await expect(page.getByRole("button", { name: "Home" })).not.toBeVisible();
    await page.getByTestId("members-mobile-back").click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    // Back gives focus to the tab that opened the page.
    await expect(serverTab).toBeFocused();

    // The sidebar is the chat surface again, not stuck on members.
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();
    await expect(page.getByTestId("members-page")).not.toBeVisible();
  });

  test("cold-start on the old Members tab root → Back lands on Home", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}/members`);
    await expect(page.getByTestId("members-page")).toBeVisible();
    await page.getByTestId("members-mobile-back").click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    await expectSelectedTabSticker(page, page.getByRole("button", { name: "Home" }));
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();
    await expect(page.getByTestId("members-page")).not.toBeVisible();
  });

  test("the old /more link lands on Home", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}/more`);
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    await expectSelectedTabSticker(page, page.getByRole("button", { name: "Home" }));
  });

  test("Search is a tab: no Back, Search selected; leaving and coming back keeps the query", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}/tasks`);
    await page.getByTestId("mobile-tab-search").click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search$`));
    // Design lead 2026-10-21: Search is a tab root — the bar, no Back.
    await expectSelectedTabSticker(page, page.getByTestId("mobile-tab-search"));
    await expect(page.getByTestId("search-mobile-back")).toHaveCount(0);

    await page.getByTestId("message-search-input").fill("hello");
    await expect(page).toHaveURL(/[?&]q=hello/);
    await page.getByRole("button", { name: "Tasks" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/tasks$`));
    await page.getByTestId("mobile-tab-search").click();
    await expect(page.getByTestId("message-search-input")).toHaveValue("hello");
    await expectSelectedTabSticker(page, page.getByTestId("mobile-tab-search"));
  });

  test("server switcher keeps long server lists scrollable on mobile", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    const runId = Date.now().toString(36);
    const createdServers: Array<{ name: string; slug: string }> = [];
    for (let i = 0; i < 18; i += 1) {
      const suffix = String(i + 1).padStart(2, "0");
      const serverName = `Mobile Overflow ${suffix}`;
      const serverSlug = `mobile-overflow-${runId}-${suffix}`;
      const response = await request.post(`${seedState.urls.api}/api/servers`, {
        headers: {
          Authorization: `Bearer ${login.accessToken}`,
          "Content-Type": "application/json",
        },
        data: { name: serverName, slug: serverSlug },
      });
      expect(response.ok()).toBeTruthy();
      createdServers.push({ name: serverName, slug: serverSlug });
    }

    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();

    // The sidebar header's server switcher: the tab bar's server tab is named for the server too.
    await page.getByTestId("mobile-workspace-trigger").click();
    const menu = page.getByTestId("mobile-server-switcher-menu");
    await expect(menu).toBeVisible();

    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(844);

    const lastServer = createdServers.at(-1)!;
    const lastServerLink = menu.locator("a").filter({ hasText: `/${lastServer.slug}` });
    await lastServerLink.scrollIntoViewIfNeeded();
    await expect(lastServerLink).toBeVisible();
    await lastServerLink.click();

    await expect(page).toHaveURL(new RegExp(`/s/${lastServer.slug}/?$`));
  });
});

// Regression for #11 (#proj-mobile:b1c622e5, stdrc 2026-05-09):
// "移动端在所有页面上点击 tab bar 的 tab，都应该进入这个 tab 页面的 root
// （撤回所有返回栈）". Sub-pages hide the tab bar, so once a user has
// drilled into a tab's sub-page and switched away, tapping back into
// that tab MUST land on the tab's root, not on the previously-visited
// sub-page (which would re-hide the tab bar and trap the user).
test.describe("mobile tab bar — tab tap always returns to tab root", () => {
  test("drill into channel sub-page → switch tab → tap original tab returns to root", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();

    // Drill into a channel from Home tab — sub-page hides the tab bar.
    await page.goto(`/s/${seedState.server.slug}/channel/${seedState.channel.id}`);
    await expect(page).toHaveURL(new RegExp(`/channel/${seedState.channel.id}$`));
    await expect(page.getByRole("button", { name: "Home" })).not.toBeVisible();

    // Pop back to Home root so the tab bar is reachable.
    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByRole("button", { name: "Home" })).toBeVisible();

    // Switch to Tasks via the tab bar.
    await page.getByRole("button", { name: "Tasks" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/tasks$`));

    // Tap Home tab — must land on chat root. With the previous
    // restore-stack-top behavior, this would have routed to the
    // last-visited /channel/<id> sub-page (which hides the tab bar
    // and traps the user). Now: tab tap = home, always.
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();
  });

  test("active-tab tap stays on tab root (pop-to-root semantics preserved)", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}`);
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();
  });
});
