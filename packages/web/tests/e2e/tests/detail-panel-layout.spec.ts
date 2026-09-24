import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { loginViaApi } from "../fixtures/auth";
import { waitForSeedState } from "../fixtures/seedState";
import type { PlaywrightSeedState } from "../fixtures/seedState";

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

// Pins detail-panel layout contracts for legacy tasks opened from /tasks.
//
// 2026-05-21 stdrc #proj-task:287f18ce msg=59d4256c locked the rail-visible
// (md / 768px) threshold for the centered-modal vs full-screen-overlay split.
// We assert both forms — full-screen on a phone-sized viewport (<md), bounded
// centered card on a rail-visible viewport (md+) — so the contract can't
// silently slip back to one mode-fits-all.
test.describe("detail panel layout contract", () => {
  test.describe("mobile viewport (<md): full-screen overlay", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("legacy task panel opens as a full-screen overlay from Tasks", async ({
      page,
      request,
    }) => {
      const seedState = await waitForSeedState();
      const login = await loginViaApi(request, seedState);
      await dismissOwnerOnboarding(request, seedState, login.accessToken);

      await page.goto(`/s/${seedState.server.slug}/tasks?view=list`);

      // The seeded legacy task lives in DONE; board/list hides it by default.
      await page.getByRole("button", { name: /Show Done/i }).click();
      await page.getByText(seedState.legacyTask.title).click();

      const panel = page.getByTestId("legacy-task-panel");
      await expect(panel).toBeVisible();

      // mobile-modal presentation: `absolute inset-0` full-screen overlay,
      // no Modal backdrop, no bounded card.
      const position = await panel.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe("absolute");

      const panelBox = await panel.boundingBox();
      expect(panelBox).not.toBeNull();
      expect(panelBox!.width).toBe(page.viewportSize()!.width);
      expect(panelBox!.x).toBe(0);

      // Header height is part of the cross-panel contract.
      const headerBox = await page.getByTestId("legacy-task-panel-header").boundingBox();
      expect(headerBox?.height).toBe(62);
    });
  });

  test.describe("rail-visible viewport (md+): centered modal", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("legacy task panel opens as a centered modal from Tasks and uses the 62px header", async ({
      page,
      request,
    }) => {
      const seedState = await waitForSeedState();
      const login = await loginViaApi(request, seedState);
      await dismissOwnerOnboarding(request, seedState, login.accessToken);

      await page.goto(`/s/${seedState.server.slug}/tasks?view=list`);

      // The seeded legacy task lives in DONE; board/list hides it by default.
      await page.getByRole("button", { name: /Show Done/i }).click();
      await page.getByText(seedState.legacyTask.title).click();

      const panel = page.getByTestId("legacy-task-panel");
      await expect(panel).toBeVisible();

      // Legacy tasks opened from /tasks at md+ share the task-thread modal
      // pattern — bounded centered card inside <Modal>, position defaults
      // to static.
      const position = await panel.evaluate((el) => getComputedStyle(el).position);
      expect(position).toBe("static");

      const panelBox = await panel.boundingBox();
      expect(panelBox).not.toBeNull();
      expect(panelBox!.width).toBeLessThan(page.viewportSize()!.width);
      expect(panelBox!.x).toBeGreaterThan(0);

      // Header height is part of the cross-panel contract.
      const headerBox = await page.getByTestId("legacy-task-panel-header").boundingBox();
      expect(headerBox?.height).toBe(62);
    });
  });
});
