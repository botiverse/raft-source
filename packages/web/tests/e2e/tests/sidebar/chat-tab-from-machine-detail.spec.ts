import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding, injectSessionBeforeBoot } from "../../fixtures/session";

// Pins down the bug stdrc reported in #proj-uiux:65a6413c on 2026-04-28:
// after navigating to a machine-detail page, the first click on the
// sidebar's "Chat" tab flickers and reverts; only a SECOND click
// actually switches the surface.
//
// Root cause: `selectSidebarTab("chat")` deletes the `sidebarTab` query
// param, then a `searchParams`-keyed effect runs and — because the URL
// is still `/machine/<id>` — re-derives `activeTab="members"` from the
// route default, overwriting the click-driven `setActiveTab("chat")`.
//
// Expected behaviour: ONE click on the chat tab leaves the machine
// detail surface and shows the chat. The URL leaves `/machine/<id>`.
test("first click on sidebar Chat tab from machine detail switches to chat", async ({ page, request }) => {
  const seedState = await waitForSeedState();
  const login = await loginViaApi(request, seedState);
  await dismissOwnerOnboarding(request, seedState, login.accessToken);

  await page.setViewportSize({ width: 1280, height: 800 });

  // Land on the machine detail surface directly (mirrors the user's
  // path: they navigated via the Members tab → machine row → detail).
  await page.goto(
    `/s/${seedState.server.slug}/machine/${seedState.machine.id}?sidebarTab=members`,
  );
  await page.waitForLoadState("networkidle");

  // Confirm the computer is really open. A desktop /machine/<id> redirects
  // to the computer's side panel beside the card wall,
  // /computers?profile=computer:<id>, with the computer's head (a cold load
  // once landed on a bare /computers, the panel lost).
  await expect(page.getByTestId("machine-panel-header")).toBeVisible();
  await expect(page).toHaveURL(/\/computers\?(?:.*&)?profile=computer%3A/);

  // Confirm the Members tab is the currently-active sidebar tab.
  // (The sidebar tab toggles live in the desktop LeftRail since #79.)
  const membersTab = page.getByTestId("left-rail-tab-members");
  const chatTab = page.getByTestId("left-rail-tab-chat");
  await expect(membersTab).toBeVisible();
  await expect(chatTab).toBeVisible();

  // SINGLE click on the Chat tab.
  await chatTab.click();

  // After ONE click, the surface should leave `/machine/<id>` and
  // show the chat (or at least leave the machine detail page so the
  // sidebar Chat tab actually has effect). Give the route 2s to
  // settle so we measure the steady state, not the in-flight flicker.
  await page.waitForTimeout(800);
  // Left the computer, as its page or as its side panel.
  await expect(page).not.toHaveURL(/\/(?:machine|computer)\/|[?&]profile=computer%3A/);
  await expect(page.getByTestId("machine-panel-header")).toHaveCount(0);
  // ChatPanel renders message-scroller; it's the canonical chat
  // surface marker.
  await expect(page.getByTestId("message-scroller")).toBeVisible();
});

// A CSS-only `hidden` on RUI's sidebar slot lost to its default md:flex.
// Exercise the rendered desktop artifact, not just route/store state.
for (const width of [800, 1280]) {
  test(`rail switches never retain Chat sidebar content at ${width}px`, async ({ page, request }) => {
    const seed = await waitForSeedState();
    const login = await loginViaApi(request, seed);
    await dismissOwnerOnboarding(request, seed, login.accessToken);
    await injectSessionBeforeBoot(page, { ...login, serverSlug: seed.server.slug });
    await page.route(/\/api\/announcements\/active(?:\?|$)/, (route) => route.fulfill({
      json: { announcements: [] },
    }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/s/${seed.server.slug}/channel/${seed.channel.id}`);
    const channels = page.getByTestId("sidebar-section-block-channels");
    await expect(channels).toBeVisible();

    await page.getByTestId("left-rail-tab-tasks").click();
    await expect(page).toHaveURL(/\/tasks(?:[?#]|$)/);
    await expect(page.locator('[data-slot="app-shell-sidebar-slot"]')).toHaveCount(0);
    await expect(channels).toHaveCount(0);

    for (const rail of ["members", "computers", "settings", "search", "activity"]) {
      // Search lives in the top bar at desktop width (task #753); the others are rail tabs.
      const id = rail === "settings" ? "left-rail-settings" : rail === "search" ? "app-top-bar-search" : `left-rail-tab-${rail}`;
      await page.getByTestId(id).click();
      if (rail === "search") {
        // Task #143: at desktop width Search floats as the overlay over the
        // current view, and its backdrop covers the rail. Close it first, as a
        // user would, so the next rail click reaches the rail.
        const overlay = page.getByTestId("desktop-search-overlay");
        await expect(overlay).toBeVisible();
        // Wait until the overlay is ready for keys. Escape sent in the few
        // milliseconds between the card painting and its key listener attaching
        // is dropped (measured with the top bar entry: Escape 36ms after the
        // click, focus still on the card, overlay stayed open).
        await expect(page.getByTestId("message-search-input")).toBeFocused();
        // The page behind the overlay keeps its own sidebar: opened from
        // Settings, the Settings list stays and the Chat channel list never
        // appears. Asserted positively (the Settings list is there with the
        // overlay rendered) so a fallback to Chat cannot pass by being checked
        // before it renders.
        await expect(page.getByTestId("settings-sidebar-list")).toBeVisible();
        await expect(channels).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(overlay).toHaveCount(0);
      }
      await expect(channels).not.toBeVisible();
      if (rail === "members") {
        // Members is a full page with no sidebar beside it (#13127): the slot
        // is gone and the page itself is what renders, not a stale Chat list.
        await expect(page).toHaveURL(/\/members(?:[?#]|$)/);
        await expect(page.getByTestId("members-page")).toBeVisible();
        await expect(page.locator('[data-slot="app-shell-sidebar-slot"]')).toHaveCount(0);
      }
      if (rail === "computers") {
        // Computers is a full page beside the rail too: no sidebar slot, the
        // rack overview itself renders, not a stale Chat list.
        await expect(page).toHaveURL(/\/computers(?:[?#]|$)/);
        await expect(page.getByTestId("computers-rack-overview")).toBeVisible();
        await expect(page.locator('[data-slot="app-shell-sidebar-slot"]')).toHaveCount(0);
      }
      if (rail === "settings") {
        await expect(page.locator('[data-slot="app-shell-sidebar-slot"]')).toBeVisible();
      }
    }
    await page.getByTestId("left-rail-tab-chat").click();
    await expect(page).toHaveURL(/\/channel\//);
    await expect(channels).toBeVisible({ timeout: 15000 });
  });
}
