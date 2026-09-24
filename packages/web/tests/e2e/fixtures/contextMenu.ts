import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export function shareMessagesMenu(page: Page) {
  return page.getByRole("menuitem", { name: /Select message|Share messages/i });
}

export async function openShareMessagesMenu(page: Page, target: Locator) {
  const menu = shareMessagesMenu(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await target.scrollIntoViewIfNeeded();
    await target.click({ button: "right" });
    try {
      await expect(menu).toBeVisible({ timeout: 3000 });
      return menu;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  return menu;
}

export async function clickShareMessagesMenu(page: Page, target: Locator) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const menu = await openShareMessagesMenu(page, target);
    try {
      await menu.click({ timeout: 3000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

export async function openSelectModeMoreMenu(page: Page) {
  const moreButton = page.getByTestId("select-mode-more");
  await expect(moreButton).toBeVisible();
  await expect(moreButton).toBeEnabled();
  await moreButton.click();

  const menu = page.getByTestId("select-mode-more-menu");
  await expect(menu).toBeVisible();
  return menu;
}

export async function clickSelectModeMoreAction(page: Page, testId: string) {
  await openSelectModeMoreMenu(page);
  const action = page.getByTestId(testId);
  await expect(action).toBeVisible();
  await expect(action).toBeEnabled();
  await action.click();
}
