import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The Activity tab's raw log following its newest step (raft-design
 * Conversation, "Following the newest"; #triage:44ed2937), laid out in a real
 * browser: a full log (500 steps, the live limit) drops its oldest step on
 * every new one. Rows keep their elements, a reader at the end follows, and a
 * reader who scrolled up keeps the row they read where it was while the pill
 * counts the new steps. jsdom has no layout, so the drift is checked here.
 */

const FOLLOW = "/visual-testing.html?case=components.agent-activity-log.follow";

async function open(page: Page) {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(FOLLOW);
  await page.waitForSelector("[data-visual-case] [role='region'] li", { timeout: 10_000 });
  await page.waitForTimeout(300);
}

function log(page: Page) {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>("[data-visual-case] [role='region']")!;
    return { top: region.scrollTop, end: region.scrollHeight - region.clientHeight, rows: region.querySelectorAll("li").length };
  });
}

async function append(page: Page, count: number) {
  for (let i = 0; i < count; i++) {
    await page.evaluate(() => window.__appendActivitySteps!(1));
    await page.waitForTimeout(100);
  }
}

declare global {
  interface Window { __appendActivitySteps?: (count: number) => void }
}

test("a full log opens at its newest step and follows it without remounting its rows", async ({ page }) => {
  await open(page);
  let state = await log(page);
  expect(state.rows).toBe(500);
  expect(state.top, "it opens at the newest step").toBeGreaterThanOrEqual(state.end - 1);

  await page.evaluate(() => { document.querySelectorAll<HTMLElement>("[data-visual-case] [role='region'] li")[250]!.dataset.kept = "yes"; });
  await append(page, 2);
  state = await log(page);
  expect(state.rows).toBe(500);
  expect(state.top, "it follows the newest at the limit").toBeGreaterThanOrEqual(state.end - 1);
  expect(await page.locator("li[data-kept='yes']").count(), "the rows are the same elements").toBe(1);
  await expect(page.getByTestId("activity-log-new-steps")).toHaveCount(0);
});

test("a reader who scrolled up keeps their place, and the pill counts the new steps and goes to the end", async ({ page }) => {
  await open(page);
  await page.mouse.move(800, 300);
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(300);

  const readingTop = () => page.evaluate(() => {
    const region = document.querySelector<HTMLElement>("[data-visual-case] [role='region']")!;
    const viewTop = region.getBoundingClientRect().top;
    const row = [...region.querySelectorAll("li")].find((item) => item.getBoundingClientRect().top >= viewTop)!;
    row.dataset.reading = "yes";
    return Math.round(row.getBoundingClientRect().top);
  });
  const before = await readingTop();
  await append(page, 3);
  const after = await page.locator("li[data-reading='yes']").evaluate((row) => Math.round(row.getBoundingClientRect().top));
  expect(after, "the row being read stays where it was").toBe(before);

  const pill = page.getByTestId("activity-log-new-steps");
  await expect(pill).toHaveText("3 new steps");
  await pill.click();
  const state = await log(page);
  expect(state.top, "the pill goes to the newest step").toBeGreaterThanOrEqual(state.end - 1);
  await expect(pill).toHaveCount(0);
});
