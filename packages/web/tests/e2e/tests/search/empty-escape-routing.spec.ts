import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

async function expectDesktopServerRootRedirect(page: Page, channelPath: string) {
  await expect(page).toHaveURL(new RegExp(`${channelPath}$`));
  await expect.poll(() =>
    page.evaluate(() => window.history.state?.usr?.sidebarDisclosureRestore),
  ).toBe(true);
}

test.describe("Search Escape routing", () => {
  test.beforeEach(async ({ request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);
  });

  test("global empty Search exits through the server root, while a query exits to its source channel", async ({
    page,
  }) => {
    const seedState = await waitForSeedState();
    const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(channelPath);
    await expect(page.locator("textarea")).toBeVisible();

    await page.getByTestId("left-rail-tab-search").click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search$`));

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expectDesktopServerRootRedirect(page, channelPath);

    await page.goto(`${channelPath}?msg=${seedState.messages.focusMessageId}`);
    await expect(page.locator("textarea")).toBeVisible();
    const querySourceUrl = page.url();
    await page.getByTestId("left-rail-tab-search").click();
    const querySearchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(querySearchInput).toBeFocused();
    await querySearchInput.fill(seedState.messages.latestContent);
    await querySearchInput.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search\\?q=`));
    await querySearchInput.press("Escape");
    await expect(page).toHaveURL(querySourceUrl);
  });

  test("empty channel-header Search exits to the exact source channel", async ({
    page,
  }) => {
    const seedState = await waitForSeedState();
    const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(channelPath);
    await expect(page.locator("textarea")).toBeVisible();

    await page.getByRole("button", { name: "Search this channel" }).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/s/${seedState.server.slug}/search\\?channelId=${seedState.channel.id}&defer=1$`,
      ),
    );

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expect(page).toHaveURL(new RegExp(`${channelPath}$`));
  });

  test("empty Search opened with Command/Ctrl+K exits to the exact source channel", async ({
    page,
  }) => {
    const seedState = await waitForSeedState();
    const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(channelPath);
    await expect(page.locator("textarea")).toBeVisible();

    const searchShortcut = await page.evaluate(() =>
      /mac|iphone|ipad|ipod/i.test(navigator.platform) ? "Meta+k" : "Control+k",
    );
    await page.keyboard.press(searchShortcut);
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search$`));

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expect(page).toHaveURL(new RegExp(`${channelPath}$`));
  });

  test("empty non-deferred channel-filter Search exits through the server root", async ({
    page,
  }) => {
    const seedState = await waitForSeedState();
    const channelPath = `/s/${seedState.server.slug}/channel/${seedState.channel.id}`;
    const filteredSearchPath =
      `/s/${seedState.server.slug}/search?channelId=${seedState.channel.id}`;

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(filteredSearchPath);

    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    await expect(searchInput).toBeFocused();
    await searchInput.press("Escape");
    await expectDesktopServerRootRedirect(page, channelPath);
  });
});
