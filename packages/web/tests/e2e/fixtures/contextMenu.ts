import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export function shareMessagesMenu(page: Page) {
  return page.getByRole("menuitem", { name: /Select message|Share messages/i });
}

/** Where to right-click on [target]; the centre of its box when not given. */
export type ContextClickAt = (box: { width: number; height: number }) => { x: number; y: number };

/**
 * Right-clicks a message body's text where it starts: a body paragraph is as wide
 * as the row, and the next message's hover toolbar hangs half its height (21px
 * with a mouse) over this row's right end (raft-ui message-item.md, Toolbar).
 */
export const atTextStart: ContextClickAt = (box) => ({ x: Math.min(8, box.width / 2), y: box.height / 2 });

export async function openShareMessagesMenu(page: Page, target: Locator, at?: ContextClickAt) {
  const menu = shareMessagesMenu(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await target.scrollIntoViewIfNeeded();
    const box = at ? await target.boundingBox() : null;
    await target.click(box && at ? { button: "right", position: at(box) } : { button: "right" });
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

export async function clickShareMessagesMenu(page: Page, target: Locator, at?: ContextClickAt) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const menu = await openShareMessagesMenu(page, target, at);
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
