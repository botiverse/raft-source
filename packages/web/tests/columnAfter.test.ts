// What stands right of a side layout column in the planned row (rowPlanStore columnAfter): where a stacked column
// has a crossing at its right seam (StackCorner), and whose seam it lights.
import assert from "node:assert/strict";

import { CONVERSATION, SHORTCUT_HELP, sideColumnKey } from "../src/components/layout/rowPlan";
import type { PlanUnit, RowPlan } from "../src/components/layout/rowPlan";
import { columnAfter } from "../src/components/layout/rowPlanStore";

const unit = (key: string, regions: string[]): PlanUnit => ({ key, regions, saved: 360, contentMin: 280 });

/** The conversation, then `keys`, grouped as `groups` (unit indices; the conversation is 0). */
function plan(keys: string[], groups: number[][], expandedUnit: string | null = null): RowPlan {
  const units = [unit(CONVERSATION, [CONVERSATION]), ...keys.map((key) => unit(key, [key === SHORTCUT_HELP ? SHORTCUT_HELP : "tasks"]))];
  return { fold: false, units, groups: [[0], ...groups], widths: groups.map(() => 360), expanded: null, expandedUnit, rebalance: null };
}

test("the next column's index; none for the row's last, or with no plan, or for a column not in it", () => {
  const row = plan([sideColumnKey(0), sideColumnKey(2)], [[1], [2]]);
  assert.equal(columnAfter(row, {}, 0), 2);
  assert.equal(columnAfter(row, {}, 2), null, "the last column: no seam on its right");
  assert.equal(columnAfter(row, {}, 5), null, "not in the plan");
  assert.equal(columnAfter(null, {}, 0), null, "no plan (a phone)");
});

test("tabs (rule 4): a tab not shown has no seam; the column after a group of tabs is the tab shown there", () => {
  const row = plan([sideColumnKey(0), sideColumnKey(1), sideColumnKey(2)], [[1], [2, 3]]);
  assert.equal(columnAfter(row, {}, 0), 1, "the group's first tab, shown by default");
  assert.equal(columnAfter(row, { [sideColumnKey(1)]: sideColumnKey(2) }, 0), 2, "the tab picked");
  assert.equal(columnAfter(plan([sideColumnKey(0), sideColumnKey(1), sideColumnKey(2)], [[1], [2, 3]], sideColumnKey(2)), {}, 0), 2, "the tab expanded");
  const tabs = plan([sideColumnKey(0), sideColumnKey(1), sideColumnKey(2)], [[1, 2], [3]]);
  assert.equal(columnAfter(tabs, {}, 0), 2, "the tab shown has the seam after its group");
  assert.equal(columnAfter(tabs, {}, 1), null, "a tab not shown stands nowhere");
});

test("the keyboard shortcuts panel after it: no side column, so no crossing there", () => {
  assert.equal(columnAfter(plan([sideColumnKey(0), SHORTCUT_HELP], [[1], [2]]), {}, 0), null);
});
