import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Readiness before an action, not a replacement for its result assertion. */
export async function openSidebarRowMenu(page: Page, channelId: string, expectedAction: string | RegExp) {
  return test.step(`sidebar menu: ${channelId} → ${String(expectedAction)}`, async () => {
    const row = page.locator(`button[data-sidebar-channel-id="${channelId}"]`).first();
    await test.step("row exists", () => expect(row).toBeVisible());
    // Locator.click handles scroll/actionability and reacquires detached nodes.
    // An extra scrollIntoView call introduced a separate detach failure window.
    await test.step("open menu", () => row.click({ button: "right" }));
    const wanted = page.getByRole("menuitem", {
      name: expectedAction, exact: typeof expectedAction === "string",
    });
    try {
      await expect(wanted).toBeVisible({ timeout: 5000 });
    } catch (cause) {
      await test.info().attach("sidebar-menu-state", {
        contentType: "application/json",
        body: JSON.stringify({ channelId, expectedAction: String(expectedAction),
          phase: "expected-action", rowCount: await row.count(),
          // Labels only; no tokens, message contents or storage state.
          actions: await page.getByRole("menuitem").allTextContents(),
        }),
      });
      throw new Error(`Sidebar menu missing expected action: ${String(expectedAction)}`, { cause });
    }
    return row;
  });
}

/** A visible focus row proves a nonempty initial window before measuring it. */
export async function expectThreadFocusedWindow(page: Page, messageId: string) {
  await test.step("thread focused window ready", async () => {
    const scroller = page.getByTestId("thread-message-scroller");
    await expect(scroller).toBeVisible();
    await expect(scroller.locator(`[data-timeline-message-id="${messageId}"]`)).toBeVisible();
  });
}
