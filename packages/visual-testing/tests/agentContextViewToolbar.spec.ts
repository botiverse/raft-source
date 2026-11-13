import { expect, test } from "@playwright/test";

/**
 * View Context's Messages toolbar, measured as laid out (#13241: in the 440px
 * side column the search field read "Search me…" and the filter's third
 * segment slid under the jump buttons). Class assertions can't see either;
 * boxes can. Narrow, the toolbar is two rows: the search field the whole
 * width, then the filter and the jumps, nothing overlapping or clipped.
 */

const SIDE_COLUMN = "/visual-testing.html?case=components.agent-context-view.messages";
const PHONE = "/visual-testing.html?case=components.agent-context-view.messages.phone";

type Box = { left: number; right: number; top: number; bottom: number; width: number };

async function measure(page: import("@playwright/test").Page) {
  await page.waitForSelector("[data-testid='agent-context-view-toolbar']", { timeout: 10_000 });
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const box = (element: Element | null): Box | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    const toolbar = document.querySelector("[data-testid='agent-context-view-toolbar']")!;
    const input = toolbar.querySelector<HTMLInputElement>("[data-testid='agent-context-view-search']")!;
    return {
      toolbar: box(toolbar)!,
      search: box(toolbar.querySelector("[role='search']"))!,
      input: box(input)!,
      placeholderFits: (() => {
        // The placeholder drawn in the input's font: does it fit the input's content box?
        const style = getComputedStyle(input);
        const canvas = document.createElement("canvas").getContext("2d")!;
        canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const content = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return canvas.measureText(input.placeholder).width <= content;
      })(),
      segments: Array.from(toolbar.querySelectorAll("[data-testid^='agent-context-view-filter-']"), (element) => box(element)!),
      jumps: Array.from(toolbar.querySelectorAll("[data-testid^='agent-context-view-jump-']"), (element) => box(element)!),
    };
  });
}

function assertLaidOut(m: Awaited<ReturnType<typeof measure>>) {
  expect(m.placeholderFits, "the search field's placeholder is never cut").toBe(true);
  expect(m.search.width, "the search row takes the toolbar's width").toBeGreaterThan(m.toolbar.width * 0.8);
  const firstJump = Math.min(...m.jumps.map((jump) => jump.left));
  for (const segment of m.segments) {
    expect(segment.top, "the filter sits under the search field").toBeGreaterThanOrEqual(m.search.bottom - 1);
    expect(segment.right, "no segment runs under the jump buttons").toBeLessThanOrEqual(firstJump + 0.5);
    expect(segment.left).toBeGreaterThanOrEqual(m.toolbar.left - 0.5);
  }
  for (const jump of m.jumps) expect(jump.right, "the jumps stay inside the toolbar").toBeLessThanOrEqual(m.toolbar.right + 0.5);
}

test("in the 440px side column the toolbar is two rows, nothing cut, clipped or overlapped", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.goto(SIDE_COLUMN);
  assertLaidOut(await measure(page));
});

test("on the 390px phone page the same", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.goto(PHONE);
  assertLaidOut(await measure(page));
});
