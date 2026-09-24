import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
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

// Regression for #255: on the server homepage, switching MobileTabBar
// Home → Members → Home used to leave the sidebar stuck on the Members
// surface. Root cause was Sidebar's URL→state effect ignoring the
// default-tab case. Fix lives in Sidebar.tsx.
//
// Post-rail refactor (#1176): the tab bar is 4 tabs (Home / Tasks / Members
// / Settings), sidebar surfaces moved from `?sidebarTab=...` query params to
// path-based routes (`/members`, etc.). The Chat button was renamed to Home.
test.describe("mobile tab bar — home ↔ members switching", () => {
  test("home → members → home restores chat sidebar", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}`);

    // Home tab is the default surface — Channels header is visible.
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();

    // Tap Members in the bottom tab bar.
    await page.getByRole("button", { name: "Members" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/members$`));
    await expect(page.getByRole("button", { name: "Members" })).toHaveClass(/bg-soft-signal/);

    // Tap Home — sidebar must flip back to the chat surface, not stay on members.
    await page.getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();
    await expect(page.getByTestId("sidebar-section-toggle-humans")).not.toBeVisible();
  });

  test("cold-start members → tap home restores chat sidebar", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}/members`);
    await expect(page.getByRole("button", { name: "Members" })).toHaveClass(/bg-soft-signal/);

    await page.getByRole("button", { name: "Home" }).click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/?$`));
    await expect(page.getByTestId("sidebar-section-toggle-channels")).toBeVisible();
    await expect(page.getByTestId("sidebar-section-toggle-humans")).not.toBeVisible();
  });

  test("Search is a Home drill-in, not a bottom tab", async ({ page, request }) => {
    const seedState = await waitForSeedState();
    const login = await loginViaApi(request, seedState);
    await dismissOwnerOnboarding(request, seedState, login.accessToken);

    await page.goto(`/s/${seedState.server.slug}`);
    await expect(page.getByTestId("mobile-home-search-entry")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search" })).toHaveCount(1);

    await page.getByTestId("mobile-home-search-entry").click();
    await expect(page).toHaveURL(new RegExp(`/s/${seedState.server.slug}/search$`));
    await expect(page.getByTestId("search-mobile-back")).toBeVisible();
    await expect(page.getByRole("button", { name: "Home" })).not.toBeVisible();
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

    await page.getByRole("button", { name: seedState.server.name }).click();
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
