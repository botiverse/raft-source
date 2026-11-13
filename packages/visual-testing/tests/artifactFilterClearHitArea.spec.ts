import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The × of a set Artifacts filter (ArtifactFilterCombobox, the DS's
 * FilterChipRemove beside a PickerTriggerButton) on a touch screen, measured
 * as laid out (#proj-raft-ui:#210).
 *
 * Raft DS › FilterChip › Behavior: on a touch screen the ×'s hit area reaches
 * 10px past the chip's end, so the next control stays at least 16px from the
 * chip (its own 32px button reaches 6px toward it). With the row's 8px gap
 * alone, the two hit areas overlapped: a tap at the ×'s end could open the next
 * filter, or one at the next control's start clear this one.
 *
 * Each hit area is read with the browser's own hit testing
 * (`elementFromPoint`, which counts a `::after` hit extension), the other
 * control set to `pointer-events: none` meanwhile, so neither hides the other.
 *
 * Visual browser CI runs these assertions on selected staging pushes and
 * daily runs; they are not part of ordinary PR checks.
 */

const MIN_GAP = 16;
/** The hit testing's step along the row, in CSS px. */
const SAMPLE = 0.5;

test.use({ hasTouch: true });

interface Pair {
  name: string;
  /** The visible gap between the filter's button and the next control. */
  gap: number;
  /** The ×'s hit area's right edge, and the next control's hit area's left edge. */
  removeHitRight: number;
  nextHitLeft: number;
  /** How far the ×'s hit area reaches past the filter's button (it must still reach). */
  removeReach: number;
  /** How many sampled columns hit each control: an empty one would make the overlap check vacuous. */
  removeHits: number;
  nextHits: number;
}

async function open(page: Page, caseId: string) {
  await page.goto(`/visual-testing.html?case=${caseId}`);
  await page.waitForSelector('[data-testid="artifacts-filter-conversation-clear"]');
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the page sees a touch screen").toBe(true);
}

async function measure(page: Page, removeTestId: string, triggerTestId: string, nextSelector: string): Promise<Pair> {
  return page.evaluate(({ removeTestId, triggerTestId, nextSelector, step }) => {
    const remove = document.querySelector(`[data-testid="${removeTestId}"]`) as HTMLElement;
    const trigger = document.querySelector(`[data-testid="${triggerTestId}"]`) as HTMLElement;
    const next = document.querySelector(nextSelector) as HTMLElement;
    const box = remove.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const left = box.left - 40;
    const right = next.getBoundingClientRect().right;
    /** The x positions on the ×'s row where a tap lands on `target`, with `other` out of the way. */
    const hits = (target: HTMLElement, other: HTMLElement) => {
      const before = other.style.pointerEvents;
      other.style.pointerEvents = "none";
      const xs: number[] = [];
      for (let x = left; x <= right; x += step) {
        const at = document.elementFromPoint(x, y);
        if (at && target.contains(at)) xs.push(x);
      }
      other.style.pointerEvents = before;
      return xs;
    };
    const removeXs = hits(remove, next);
    const nextXs = hits(next, remove);
    const triggerRight = trigger.getBoundingClientRect().right;
    return {
      name: `${removeTestId} → ${nextSelector}`,
      gap: next.getBoundingClientRect().left - triggerRight,
      removeHitRight: Math.max(...removeXs),
      nextHitLeft: Math.min(...nextXs),
      removeReach: Math.max(...removeXs) - triggerRight,
      removeHits: removeXs.length,
      nextHits: nextXs.length,
    };
  }, { removeTestId, triggerTestId, nextSelector, step: SAMPLE });
}

function expectClear(pair: Pair) {
  expect(pair.removeHits, `${pair.name}: a tap finds the ×`).toBeGreaterThan(0);
  expect(pair.nextHits, `${pair.name}: a tap finds the next control`).toBeGreaterThan(0);
  expect(pair.gap, `${pair.name}: visible gap`).toBeGreaterThanOrEqual(MIN_GAP - 0.5);
  // At exactly 16px the two hit areas meet edge to edge (10px + 6px), so they
  // may share the one sampled column where they touch; any more is an overlap.
  expect(pair.removeHitRight, `${pair.name}: the ×'s hit area ends where the next control's begins`).toBeLessThanOrEqual(pair.nextHitLeft + SAMPLE);
  // The fix keeps the ×'s 44px hit area; it moves the next control instead.
  expect(pair.removeReach, `${pair.name}: the ×'s hit area still reaches past the button`).toBeGreaterThan(8);
}

test("a set filter's × is clear of the unset filter after it", async ({ page }) => {
  await open(page, "components.artifacts.filter-row.conversation-set");
  expectClear(await measure(page, "artifacts-filter-conversation-clear", "artifacts-filter-conversation", '[data-testid="artifacts-filter-author"]'));
});

test("each set filter's × is clear of the next control, the row's Clear too", async ({ page }) => {
  await open(page, "components.artifacts.filter-row.both-set");
  expectClear(await measure(page, "artifacts-filter-conversation-clear", "artifacts-filter-conversation", '[data-testid="artifacts-filter-author"]'));
  expectClear(await measure(page, "artifacts-filter-author-clear", "artifacts-filter-author", '[data-testid="artifacts-all-toolbar-clear"]'));
});
