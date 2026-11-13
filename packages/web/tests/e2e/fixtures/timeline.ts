import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The message timeline in a browser test. The virtual timeline mounts only
// the rows near the view, so a message far from it is not in the DOM even
// though it is loaded. Count and wait on what is loaded, not on what is
// mounted.

// How many messages the timeline holds: the virtual timeline says so on its
// scroller (`data-loaded-message-count`).
export async function loadedMessageCount(scroller: Locator): Promise<number> {
  return scroller.evaluate((el) => Number((el as HTMLElement).dataset.loadedMessageCount));
}

// The channel's timeline has rendered its messages (its socket room is
// joined). Unlike waiting for one known message, this holds wherever that
// message ended up once other tests have posted to the same channel.
export async function expectTimelineRendered(page: Page, testId = "message-scroller"): Promise<void> {
  const scroller = page.getByTestId(testId);
  await expect(scroller).toBeVisible();
  await expect(scroller.locator("[data-message-id]").first()).toBeVisible();
}
