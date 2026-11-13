import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The Tasks and Artifacts toolbar rows with a fine pointer, at a desktop width
 * and as wide as the page's column in an 820px window, measured as laid out
 * (#proj-workspace:dc3c9fc9).
 *
 * Both rows are the header's height, 44px with the 1px seam. The view switch's
 * segments (raft-ui SegmentedControl: a control's height in a 3px track) are
 * centered on the other controls of the first line, and the switch ends the row
 * at its right padding. Before the fix Artifacts' row was 57px with the switch
 * 3px low, and Tasks' switch stopped short of the row's end.
 *
 * In the 820px window the fixture rows still fit on one line: the search gives
 * way down to 160px and Artifacts' sort is its icon, beside the switch. Before,
 * Artifacts' sort wrapped alone onto a second line (an 86px row).
 *
 * Visual browser CI runs these assertions on selected staging pushes and
 * daily runs; they are not part of ordinary PR checks.
 */

const ROW_HEIGHT = 44;

test.use({ hasTouch: false });

interface Row {
  height: number;
  /** The first line's controls (not the switch): their vertical centers. */
  controlCenters: number[];
  segmentCenters: number[];
  /** The row's content edge less the switch's right edge. */
  switchRightGap: number;
  /** Artifacts' sort: its box, against the switch's left edge. */
  sort: { width: number; height: number; right: number; top: number } | null;
  switchLeft: number;
  switchTop: number;
}

async function measure(page: Page, caseId: string, toolbar: string, viewSwitch: string): Promise<Row> {
  await page.goto(`/visual-testing.html?case=${caseId}`);
  await page.waitForSelector(`${toolbar} ${viewSwitch}`);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches), "the page sees a fine pointer").toBe(true);
  return page.evaluate(({ toolbar, viewSwitch }) => {
    const bar = document.querySelector(toolbar) as HTMLElement;
    const sw = bar.querySelector(viewSwitch) as HTMLElement;
    const b = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    const cy = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 - b.top; };
    const controls = [...bar.querySelectorAll("button, input, [role=combobox]")]
      .filter((el) => !sw.contains(el) && el.getBoundingClientRect().height > 2)
      .map((el) => el.closest("[data-slot=input-group]") ?? el);
    const firstTop = Math.min(...controls.map((el) => el.getBoundingClientRect().top));
    return {
      height: b.height,
      controlCenters: controls.filter((el) => el.getBoundingClientRect().top - firstTop < 20).map(cy),
      segmentCenters: [...sw.querySelectorAll("[data-slot=segmented-control-item]")].map(cy),
      switchRightGap: b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) - sw.getBoundingClientRect().right,
      sort: (() => {
        const el = bar.querySelector("[data-testid=artifacts-all-sort]");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, right: r.right, top: r.top - b.top };
      })(),
      switchLeft: sw.getBoundingClientRect().left,
      switchTop: sw.getBoundingClientRect().top - b.top,
    };
  }, { toolbar, viewSwitch });
}

function expectAligned(name: string, row: Row) {
  expect(row.height, `${name}: row height`).toBeCloseTo(ROW_HEIGHT, 0);
  expect(row.controlCenters.length, `${name}: controls on the first line`).toBeGreaterThan(0);
  expect(row.segmentCenters.length, `${name}: the switch's segments`).toBe(2);
  for (const segment of row.segmentCenters) {
    for (const control of row.controlCenters) {
      expect(Math.abs(segment - control), `${name}: a segment's center against a control's (${segment} vs ${control})`).toBeLessThanOrEqual(1);
    }
  }
  expect(Math.abs(row.switchRightGap), `${name}: the switch ends at the row's right padding`).toBeLessThanOrEqual(1);
}

test.describe("desktop, 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Tasks' toolbar row is 44px, its switch centered on the controls and at the row's end", async ({ page }) => {
    expectAligned("Tasks", await measure(page, "components.tasks.toolbar-row.desktop", "[data-visual-case] [data-slot=tasks-panel-toolbar]", "[data-slot=segmented-control]"));
  });

  test("Artifacts' toolbar row is 44px, its switch centered on the controls and at the row's end", async ({ page }) => {
    expectAligned("Artifacts", await measure(page, "components.artifacts.toolbar-row.desktop", "[data-testid=artifacts-all-toolbar]", "[data-testid=artifacts-dashboard-view]"));
  });
});

test.describe("a narrow window, 820px", () => {
  test.use({ viewport: { width: 820, height: 900 } });

  test("Tasks' toolbar is one 44px row, its switch at the row's end", async ({ page }) => {
    expectAligned("Tasks", await measure(page, "components.tasks.toolbar-row.mid", "[data-visual-case] [data-slot=tasks-panel-toolbar]", "[data-slot=segmented-control]"));
  });

  test("Artifacts' toolbar is one 44px row, the sort its icon beside the switch", async ({ page }) => {
    const row = await measure(page, "components.artifacts.toolbar-row.mid", "[data-testid=artifacts-all-toolbar]", "[data-testid=artifacts-dashboard-view]");
    expectAligned("Artifacts", row);
    expect(row.sort, "Artifacts: the sort is drawn").not.toBeNull();
    const sort = row.sort!;
    expect(sort.width, `Artifacts: the sort is its icon and chevron (${sort.width}px wide)`).toBeLessThan(sort.height * 2);
    expect(Math.abs(sort.top - row.switchTop), "Artifacts: the sort is on the switch's line").toBeLessThanOrEqual(4);
    expect(row.switchLeft - sort.right, "Artifacts: the sort is right before the switch").toBeCloseTo(8, 0);
    // Its value stays in its name when the words go.
    await expect(page.getByTestId("artifacts-all-sort")).toHaveAccessibleName(/.+/);
  });
});
