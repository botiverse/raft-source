import assert from "node:assert/strict";

import { buildUnits, decideFold, groupUnits, planRow, ROW_PAIR_WIDTH, SHORTCUT_HELP, splitPair, TASKS_PAGE_TASK, unitWidths, withShortcutHelpColumn, withTasksPageTaskColumn } from "../src/components/layout/rowPlan";
import type { PlanColumn, PlanInput } from "../src/components/layout/rowPlan";

// #proj-raft-ui:#189, the design lead's prototype (pt_141adb2e): its decideFold, buildUnits, groupUnits and layout.
// The prototype's numbers: rail 64 and sidebar 240 around the row; the conversation 400 (or what the others leave),
// the thread 420, Tasks 340, Files 320, the Artifact 560, the profile 380; content minimums 360, 360, 280, 280, 480,
// 320. The prototype's own script was run against this port on every scenario at every 37px from 640 to 2560, with
// the sidebar open and closed and each region expanded: the two agree (4472 rows).

const col = (key: string, regions: string[], mins: number[], saved: number, savedWithoutThread?: number): PlanColumn => ({ key, regions, mins, saved, savedWithoutThread });
const THREAD = col("col:0", ["thread"], [360], 420, 400);
const TASKS = col("col:1", ["tasks"], [280], 340);
const FILES = col("col:2", ["files"], [280], 320);
const ARTIFACT = col("col:3", ["artifact"], [480], 560);
const PROFILE = col("col:4", ["profile"], [320], 380);

const row = (window: number, columns: PlanColumn[], over: Partial<PlanInput> = {}): PlanInput => {
  const available = window - 64 - 240;
  const others = columns.reduce((sum, c) => sum + c.saved, 0);
  return {
    available,
    conversation: { saved: Math.max(400, available - others), contentMin: 360 },
    thread: columns.some((c) => c.regions.includes("thread")) ? { saved: 420, contentMin: 360 } : null,
    columns,
    expanded: null,
    expandFold: false,
    wasFolded: false,
    ...over,
  };
};
const rounded = (widths: number[]) => widths.map((w) => Math.round(w));

test("rule 3: the thread stands beside the conversation while both keep 360; narrower, it folds into the conversation's column", () => {
  // Scenario b at 1440: 1136 of room, the pair at its saved widths in proportion.
  const wide = planRow(row(1440, [THREAD]));
  assert.equal(wide.fold, false);
  assert.deepEqual(wide.units.map((u) => u.key), ["conversation", "col:0"]);
  // At 1024 the room is 720: the two at 360 each, side by side.
  const pair = planRow(row(1024, [THREAD]));
  assert.equal(pair.fold, false);
  assert.deepEqual(rounded(pair.widths), [360, 360]);
  // A pixel narrower the thread folds: one column, the conversation's, which the two share.
  const folded = planRow(row(1023, [THREAD]));
  assert.equal(folded.fold, true);
  assert.deepEqual(folded.units.map((u) => u.regions), [["conversation", "thread"]]);
  assert.deepEqual(rounded(folded.widths), [719]);
});

test("rule 3: the thread folds before any other column has to clip", () => {
  // Scenario c at 1280: the thread, Tasks; 976 of room is short of 360 + 360 + 280.
  const c = planRow(row(1280, [THREAD, TASKS]));
  assert.equal(c.fold, true);
  assert.deepEqual(c.units.map((u) => u.key), ["conversation", "col:1"]);
  assert.ok(c.widths[1]! >= 280, "Tasks keeps its content's 280: nothing clips");
  // Scenario f at 1920: five columns' content minimums need 1760 of 1616; the thread folds and nothing clips.
  const f = planRow(row(1920, [THREAD, TASKS, FILES, ARTIFACT]));
  assert.equal(f.fold, true);
  assert.deepEqual(rounded(f.widths).map((w, i) => w >= [360, 280, 280, 480][i]!), [true, true, true, true]);
  // With room again (scenario c at 1440, or the sidebar collapsed: 240 more), it stands in a column of its own.
  assert.equal(planRow(row(1440, [THREAD, TASKS])).fold, false);
  assert.equal(planRow({ ...row(1280, [THREAD, TASKS]), available: 1280 - 64 }).fold, false, "the sidebar collapsed is the window 240px wider");
});

test("rule 3: the Artifact open beside them changes nothing: the thread folds as it would for any column (no exception)", () => {
  const plan = planRow(row(1440, [THREAD, ARTIFACT]));
  assert.equal(plan.fold, true, "1136 is short of 360 + 360 + 480");
  assert.deepEqual(plan.units.map((u) => u.key), ["conversation", "col:3"]);
});

test("rule 3: folded, the thread leaves its column; the sections stacked with it stay there, at the column's layout width", () => {
  const stacked = col("col:0", ["thread", "tasks"], [360, 280], 420, 360);
  const units = buildUnits(row(1100, [stacked]), true);
  assert.deepEqual(units.map((u) => [u.key, u.regions.join("+"), u.saved, u.contentMin]), [
    ["conversation", "conversation+thread", 400, 360],
    ["col:0", "tasks", 360, 280],
  ]);
  // Alone in its column, the column goes with it, and the pair's saved width is both of theirs (the prototype's).
  assert.deepEqual(buildUnits(row(1100, [THREAD]), true).map((u) => [u.key, u.saved, u.floor]), [["conversation", 820, ROW_PAIR_WIDTH]]);
});

test("rule 3: a touch tablet in portrait under 1280px keeps the thread folded (responsive.md), whatever the room", () => {
  assert.equal(decideFold({ ...row(1440, [THREAD]), forceFold: true }).fold, true);
  assert.equal(decideFold({ ...row(1440, [TASKS]), forceFold: true }).fold, false, "no thread, nothing to fold");
});

test("rule 3: coming back out of the fold, the pair's saved widths are shared so neither starts under its 360", () => {
  // The thread saved at 200 next to a conversation of 900: out of the fold it would show clipped at 200.
  const input = { ...row(1400, [col("col:0", ["thread"], [360], 200)]), conversation: { saved: 900, contentMin: 360 }, thread: { saved: 200, contentMin: 360 } };
  assert.equal(decideFold({ ...input, wasFolded: false }).rebalance, null, "only on the way back out");
  const { fold, rebalance } = decideFold({ ...input, wasFolded: true });
  assert.equal(fold, false);
  assert.ok(rebalance);
  assert.equal(Math.round(rebalance.conversation + rebalance.thread), 1100, "the pair keeps its total");
  assert.ok(rebalance.thread >= 360 * (1100 / 1096) - 1, "the thread gets its 360 of what the row gives the pair");
});

test("a seam drag on the folded column shares its width between the conversation and the thread by their saved widths", () => {
  assert.deepEqual(splitPair(800, 400, 400, 360, 360), { conversation: 400, thread: 400 });
  // At 720 or more each keeps its 360.
  assert.deepEqual(splitPair(720, 600, 200, 360, 360), { conversation: 360, thread: 360 });
  // Under 720 the share alone.
  assert.deepEqual(splitPair(400, 300, 100, 360, 360), { conversation: 300, thread: 100 });
});

test("no thread open: nothing folds and the plan is the columns in proportion (rule 4's first step)", () => {
  const plan = planRow(row(1440, [TASKS, FILES]));
  assert.equal(plan.fold, false);
  assert.equal(Math.round(plan.widths.reduce((a, b) => a + b, 0)), 1136);
});

const sum = (widths: number[]) => Math.round(widths.reduce((a, b) => a + b, 0));
const ALL = [THREAD, TASKS, FILES];

test("rule 4, step 1: short of room every column gives up, in proportion, what it has above its content's minimum; nothing clips", () => {
  // Scenario e: the four columns' saved widths fill 1920's 1616 exactly.
  assert.deepEqual(rounded(planRow(row(1920, ALL)).widths), [536, 420, 340, 320]);
  // At 1600 (1296 of room) they give 320 of the 336 they have above 360 / 360 / 280 / 280.
  const plan = planRow(row(1600, ALL));
  assert.equal(plan.fold, false);
  assert.equal(sum(plan.widths), 1296);
  plan.widths.forEach((width, i) => assert.ok(width >= [360, 360, 280, 280][i]! - 0.01, `column ${i} keeps its content's minimum`));
});

test("rule 4, steps 2 to 4: then the thread folds; the folded column gives way to 360; then all shrink in proportion and clip, to 160", () => {
  // 1280 + 2 px short of the four minimums: the thread folds first, nothing else clips.
  const folded = planRow({ ...row(1920, ALL), available: 1279 });
  assert.equal(folded.fold, true);
  assert.ok(folded.widths[1]! >= 280 && folded.widths[2]! >= 280, "Tasks and Files keep 280");
  // Under 720 + 280 + 280 the folded column gives way first, down to its 360, before Tasks or Files clips.
  const giving = planRow({ ...row(1920, ALL), available: 1000 });
  assert.deepEqual(rounded(giving.widths), [440, 280, 280]);
  // Past 360 + 280 + 280 every column shrinks in proportion, clipping.
  const clipping = planRow({ ...row(1920, ALL), available: 820 });
  assert.equal(sum(clipping.widths), 820);
  assert.ok(clipping.widths[0]! < 360 && clipping.widths[1]! < 280 && clipping.widths[2]! < 280);
  assert.ok(clipping.widths[0]! / clipping.widths[1]! > 1.2, "in proportion to what each had");
  // Never under 160.
  const floor = planRow({ ...row(1920, ALL), available: 480 });
  assert.deepEqual(rounded(floor.widths), [160, 160, 160]);
});

test("rule 4, step 5: with every column at 160 and still no room, the rightmost column becomes a tab in its left neighbour's head", () => {
  assert.deepEqual(groupUnits(5, 800), [[0], [1], [2], [3], [4]]);
  assert.deepEqual(groupUnits(5, 799), [[0], [1], [2], [3, 4]]);
  assert.deepEqual(groupUnits(5, 479), [[0], [1, 2, 3, 4]]);
  assert.deepEqual(groupUnits(3, 100), [[0, 1, 2]], "the conversation's column holds them all, at worst");
  // The prototype's row: the folded conversation, Tasks, Files, the Artifact and the profile in 640 - 64 - 240 = 336.
  const plan = planRow({ ...row(1920, [THREAD, TASKS, FILES, ARTIFACT, PROFILE]), available: 336 });
  assert.equal(plan.fold, true);
  assert.deepEqual(plan.groups, [[0], [1, 2, 3, 4]]);
  assert.deepEqual(rounded(plan.widths), [176, 160], "solved by each column's first unit, as the prototype does");
  // Each column shows its group's width where its tab is the one picked, none where it isn't.
  assert.deepEqual(rounded(unitWidths(plan, (group) => (group === 1 ? 3 : 0))), [176, 0, 0, 160, 0]);
  assert.deepEqual(rounded(unitWidths(plan, (group) => plan.groups[group]![0]!)), [176, 160, 0, 0, 0]);
});

test("rule 4: widening undoes it in the reverse order, and nothing saved changes on the way (the plan is the room's alone)", () => {
  const input = row(1920, [THREAD, TASKS, FILES, ARTIFACT]);
  const before = JSON.stringify(input);
  const wide = planRow(input);
  for (const available of [1500, 1100, 700, 400, 200]) planRow({ ...input, available });
  assert.deepEqual(planRow(input), wide);
  assert.equal(JSON.stringify(input), before);
});

test("rule 4: the sidebar collapsing or expanding is the window 240px wider or narrower, and an expanded column stays expanded", () => {
  const open = row(1280, [THREAD, TASKS]);
  const collapsed = { ...open, available: open.available + 240 };
  assert.deepEqual(planRow(collapsed), planRow({ ...row(1520, [THREAD, TASKS]), conversation: open.conversation }));
  const expanded = planRow({ ...open, expanded: "tasks" });
  assert.equal(planRow({ ...collapsed, expanded: "tasks" }).expandedUnit, expanded.expandedUnit);
});

test("rule 5: the expanded region's column fills the row, every other column is 160; its regions' unit is the one expanded", () => {
  const plan = planRow({ ...row(1920, ALL), expanded: "tasks" });
  assert.equal(plan.expandedUnit, "col:1");
  assert.deepEqual(rounded(plan.widths), [160, 160, 1616 - 480, 160]);
  // The thread folded when it was expanded stays folded, and expanding it expands the conversation's column.
  const folded = planRow({ ...row(1280, [THREAD, TASKS]), expanded: "thread", expandFold: true });
  assert.equal(folded.fold, true);
  assert.equal(folded.expandedUnit, "conversation");
  assert.deepEqual(rounded(folded.widths), [976 - 160, 160]);
  // Restored (nothing expanded), the row is the saved widths' again, to the pixel.
  assert.deepEqual(planRow(row(1920, ALL)).widths, planRow({ ...row(1920, ALL), expanded: null }).widths);
});

test("rule 5: an expanded region that left the row expands nothing; with every column a tab, the expanded one is the one shown", () => {
  assert.equal(planRow({ ...row(1920, [TASKS]), expanded: "files" }).expanded, null);
  const tabbed = planRow({ ...row(1920, [THREAD, TASKS, FILES, ARTIFACT, PROFILE]), available: 336, expanded: "artifact", expandFold: true });
  assert.deepEqual(tabbed.groups, [[0], [1, 2, 3, 4]]);
  assert.equal(tabbed.expandedUnit, "col:3");
  assert.deepEqual(rounded(tabbed.widths), [160, 176]);
});

test("the keyboard shortcuts panel is a column of the row in the thread's place: every column gives way for it, nothing overflows", () => {
  const PANEL = { saved: 400, contentMin: 320 };
  for (const window of [1280, 1100, 1024]) {
    // Tasks and Files beside the conversation, no thread: the panel joins them at the row's end.
    const sides = withShortcutHelpColumn([TASKS, FILES], PANEL);
    assert.deepEqual(sides.map((c) => c.key), ["col:1", "col:2", SHORTCUT_HELP]);
    const input = row(window, sides);
    const plan = planRow(input);
    assert.deepEqual(plan.units.map((u) => u.key), ["conversation", "col:1", "col:2", SHORTCUT_HELP]);
    const total = plan.widths.reduce((sum, w) => sum + w, 0);
    assert.ok(Math.abs(total - input.available) < 1, `${window}: the columns fill the row and no more (${total} of ${input.available})`);
    assert.ok(plan.widths.every((w) => w >= 159.5), `${window}: no column under 160: ${rounded(plan.widths)}`);

    // A thread open: it leaves the plan (the panel covers it), the panel takes its place; no fold.
    const withThread = withShortcutHelpColumn([THREAD, TASKS], PANEL);
    assert.deepEqual(withThread.map((c) => c.key), ["col:1", SHORTCUT_HELP]);
    const covered = planRow({ ...row(window, withThread), thread: null });
    assert.equal(covered.fold, false);
    assert.ok(covered.units.every((u) => !u.regions.includes("thread")));
  }
  // At 1280 the row's 976 is less than the four content minimums (360 + 280 + 280 + 320): every column gives way in
  // proportion, side by side, none a tab.
  const tight = planRow(row(1280, withShortcutHelpColumn([TASKS, FILES], PANEL)));
  assert.equal(tight.groups.length, 4, "four columns side by side, none a tab");
});

test("the Tasks page's task beside its list is a column of the row, the list its conversation (TasksRoute)", () => {
  // The Tasks page has no sidebar: the row is the window less the rail. The task at the detail column's 400 and 320.
  const task = { saved: 400, contentMin: 320 };
  const tasksRow = (window: number, over: Partial<PlanInput> = {}) => row(window + 240, withTasksPageTaskColumn([], task), over);
  const wide = planRow(tasksRow(1440));
  assert.deepEqual(wide.units.map((u) => u.key), ["conversation", TASKS_PAGE_TASK]);
  assert.deepEqual(rounded(wide.widths), [976, 400]);
  // First right of the conversation, before the side layout's columns.
  assert.deepEqual(withTasksPageTaskColumn([PROFILE], task).map((c) => c.key), [TASKS_PAGE_TASK, PROFILE.key]);
  // A narrower window (rule 4): both give up what they have above their content's minimum, in proportion, nothing clips.
  const narrow = planRow(tasksRow(764, { conversation: { saved: 976, contentMin: 360 } }));
  assert.equal(Math.round(narrow.widths[0]! + narrow.widths[1]!), 700);
  assert.ok(narrow.widths[0]! >= 360 && narrow.widths[1]! >= 320);
  // Narrower still: both under their content, the list too (clipped at its 360), each at 160 at the least.
  const clipped = planRow(tasksRow(564, { conversation: { saved: 976, contentMin: 360 } }));
  assert.equal(Math.round(clipped.widths[0]! + clipped.widths[1]!), 500);
  assert.ok(clipped.widths[0]! < 360 && clipped.widths[0]! >= 160 && clipped.widths[1]! < 320 && clipped.widths[1]! >= 160);
  // Rule 5: the task expanded fills the row, the list a 160 strip.
  assert.deepEqual(rounded(planRow(tasksRow(1440, { expanded: TASKS_PAGE_TASK })).widths), [160, 1216]);
});
