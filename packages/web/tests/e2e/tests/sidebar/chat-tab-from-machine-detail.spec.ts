import { expect, test } from "@playwright/test";
import { loginViaApi } from "../../fixtures/auth";
import { waitForSeedState } from "../../fixtures/seedState";
import { dismissOwnerOnboarding } from "../../fixtures/session";

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

  // Confirm we're really on the machine detail surface — the
  // mobile-back button is unique to MachineDetailPanel and lives in the
  // header area, so it's the most stable marker.
  await expect(page.getByTestId("machine-mobile-back")).toBeAttached();

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
  await expect(page).not.toHaveURL(/\/machine\//);
  // ChatPanel renders message-scroller; it's the canonical chat
  // surface marker.
  await expect(page.getByTestId("message-scroller")).toBeVisible();
});
