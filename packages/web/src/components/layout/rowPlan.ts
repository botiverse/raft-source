import { SEAM_COLUMN_MIN_WIDTH, solveUnits } from "../ui/seamCascade";
import type { RowUnit } from "../ui/seamCascade";

/**
 * MainLayout's row planned by the #189 rules (#proj-raft-ui:#189; the design lead's prototype, pt_141adb2e, whose
 * `buildUnits`, `decideFold`, `groupUnits` and `layout` this is), as a pure function of the row's room and every
 * column's saved width, so it runs under any test runner and nothing in it reads the DOM:
 *
 * - Rule 3: the thread is a layer of the conversation. Where the conversation and the thread can't both keep their
 *   360 side by side, or where keeping them would make any column clip, the thread folds into the conversation's
 *   column, over the chat; the two then share that one column's width. It stands in a column of its own again as
 *   soon as the room allows.
 * - Rule 4: short of room every column gives up, in proportion, what it has above its content's minimum; then the
 *   thread folds; then the folded column gives way to 360; then all shrink in proportion and clip, to 160; past
 *   that the rightmost column becomes a tab in its left neighbour's head (`groups`). Saved widths never change.
 * - Rule 5: one region expanded fills the row; every other column is 160.
 *
 * The thread may stand in any column of the side layout, alone or stacked with sections (slock moves it, stdrc's
 * correction to the prototype): folded, it leaves that column, which stays for the sections stacked with it.
 */

/** Two columns of 360 each: the conversation and the thread side by side (rule 3). */
export const ROW_PAIR_WIDTH = 720;
/** The narrowest a column may be (rule 2). */
export const ROW_COLUMN_MIN_WIDTH = SEAM_COLUMN_MIN_WIDTH;
/** The conversation's region in `expanded` and in a unit's regions. */
export const CONVERSATION = "conversation";
export const THREAD = "thread";
/** The keyboard shortcuts panel's region (features/keyboard-shortcuts ShortcutHelpColumn): a column of the row while open. */
export const SHORTCUT_HELP = "shortcuts";
/**
 * The Tasks page's task beside its list (TasksRoute): a column of the row while open, as the thread is beside its
 * channel (stdrc: the Tasks page's main area is the chat's, the list its conversation, the task its thread).
 */
export const TASKS_PAGE_TASK = "tasks-page-task";

/** The unit key of the side layout's column `column` (ChannelSideArea `planColumns`). */
export const sideColumnKey = (column: number) => `col:${column}`;

/** The side layout's column a unit key stands for, or null for another unit (the conversation, the shortcuts panel). */
export function sideColumnOf(key: string): number | null {
  const match = /^col:(\d+)$/.exec(key);
  return match ? Number(match[1]) : null;
}

/** A column right of the conversation: the side layout's, the thread's included where it is open. */
export interface PlanColumn {
  /** Stable across plans: the unit's key. */
  key: string;
  /** Its regions top to bottom (the side layout's sections: thread, tasks, files, artifact, profile). */
  regions: readonly string[];
  /** Each region's content minimum, in `regions`' order. */
  mins: readonly number[];
  /** Its saved width; for the thread's column, the thread's own. */
  saved: number;
  /** The thread's column: its saved width once the thread has folded out of it (the sections stacked with it stay). */
  savedWithoutThread?: number;
}

export interface PlanInput {
  /** The row's width: the window less the rail and the sidebar. */
  available: number;
  /** The conversation's saved width and its content's minimum (360). */
  conversation: { saved: number; contentMin: number };
  /** The thread's saved width and content minimum, while one is open beside the conversation; null otherwise. */
  thread: { saved: number; contentMin: number } | null;
  /** Left to right. */
  columns: readonly PlanColumn[];
  /** The region expanded (rule 5), or null. */
  expanded: string | null;
  /** Whether the thread was folded when that region was expanded: it stays so while expanded. */
  expandFold: boolean;
  /** Whether the last plan folded the thread (rule 3's way back: see `rebalance`). */
  wasFolded: boolean;
  /** Fold whatever the room (a touch tablet in portrait under 1280px: responsive.md's thread-only rule). */
  forceFold?: boolean;
}

export interface PlanUnit extends RowUnit {
  key: string;
  /** Its regions; the conversation's unit holds CONVERSATION, and THREAD after it when the thread is folded. */
  regions: string[];
}

export interface RowPlan {
  /** The thread is folded into the conversation's column. */
  fold: boolean;
  /** The row's units, left to right: the conversation first. */
  units: PlanUnit[];
  /** Unit indices per column on screen: more than one where columns became tabs in the first one's head. */
  groups: number[][];
  /** Each group's width. */
  widths: number[];
  /** The region expanded, where it still is in the row (null otherwise: the caller forgets it). */
  expanded: string | null;
  /** The unit an expanded region holds the row with: its group shows it. */
  expandedUnit: string | null;
  /**
   * Coming back out of the fold with the conversation or the thread under its 360 by their saved widths, the two
   * saved widths that keep the pair's total and give each at least 360 (the prototype's decideFold): the caller saves
   * them. Null otherwise.
   */
  rebalance: { conversation: number; thread: number } | null;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function threadAt(columns: readonly PlanColumn[]): number {
  return columns.findIndex((column) => column.regions.includes(THREAD));
}

/** The row's units: the conversation (with the thread folded into it, `fold`) and each column with a region left. */
export function buildUnits(input: PlanInput, fold: boolean): PlanUnit[] {
  const { conversation, thread, columns } = input;
  const at = thread ? threadAt(columns) : -1;
  const folds = fold && at >= 0;
  const alone = folds && columns[at]!.regions.length === 1;
  const units: PlanUnit[] = [];
  if (folds) {
    // The pair's saved width (the prototype's R.conv.width + R.thread.width); a thread stacked with sections leaves
    // its column's width to them.
    const saved = conversation.saved + (alone ? thread!.saved : 0);
    units.push({ key: CONVERSATION, regions: [CONVERSATION, THREAD], saved, contentMin: conversation.contentMin, floor: Math.min(saved, ROW_PAIR_WIDTH), merged: true });
  } else {
    units.push({ key: CONVERSATION, regions: [CONVERSATION], saved: conversation.saved, contentMin: conversation.contentMin });
  }
  columns.forEach((column, index) => {
    const keep = column.regions.map((region, i) => ({ region, min: column.mins[i] ?? 0 })).filter(({ region }) => !(folds && index === at && region === THREAD));
    if (keep.length === 0) return;
    const saved = folds && index === at ? column.savedWithoutThread ?? column.saved : column.saved;
    units.push({ key: column.key, regions: keep.map(({ region }) => region), saved, contentMin: Math.max(0, ...keep.map(({ min }) => min)) });
  });
  return units;
}

/**
 * Rule 3: the thread folds where the conversation and the thread can't keep 360 + 360 side by side, or where the
 * row as it stands would make a column clip (`solveUnits`' clip): folding comes before any clipping.
 */
export function decideFold(input: PlanInput): { fold: boolean; rebalance: RowPlan["rebalance"] } {
  if (!input.thread) return { fold: false, rebalance: null };
  const at = threadAt(input.columns);
  if (at < 0) return { fold: false, rebalance: null };
  if (input.forceFold) return { fold: true, rebalance: null };
  const units = buildUnits(input, false);
  const unit = units.findIndex((u) => u.regions.includes(THREAD));
  const { widths, clip } = solveUnits(units, input.available);
  const conversation = widths[0]!;
  const thread = widths[unit]!;
  const fold = clip || conversation + thread < ROW_PAIR_WIDTH - 0.5;
  let rebalance: RowPlan["rebalance"] = null;
  // Out of the fold, the pair shares what it was given so neither starts under its 360 (the prototype's decideFold).
  // Only for a thread alone in its column: stacked, its column's width is its sections' too.
  if (!fold && input.wasFolded && input.columns[at]!.regions.length === 1) {
    const pair = conversation + thread;
    if (thread < input.thread.contentMin || conversation < input.conversation.contentMin) {
      const nextThread = clamp(thread, input.thread.contentMin, pair - input.conversation.contentMin);
      const saved = input.conversation.saved + input.thread.saved;
      const savedThread = (saved * nextThread) / pair;
      rebalance = { conversation: saved - savedThread, thread: savedThread };
    }
  }
  return { fold, rebalance };
}

/**
 * Rule 4's last step: while the row can't give every column its 160, the rightmost column becomes a tab in its left
 * neighbour's head (the prototype's groupUnits). Indices into `units`.
 */
export function groupUnits(count: number, available: number): number[][] {
  const groups = Array.from({ length: count }, (_, index) => [index]);
  while (groups.length > 1 && groups.length * ROW_COLUMN_MIN_WIDTH > available + 0.5) {
    const last = groups.pop()!;
    groups[groups.length - 1]!.push(...last);
  }
  return groups;
}

/** The unit holding `region` (a folded thread is the conversation's). */
export function unitOf(units: readonly PlanUnit[], region: string): number {
  return units.findIndex((unit) => unit.regions.includes(region));
}

/** The row: whether the thread folds, the units, the tabs and every column's width. */
export function planRow(input: PlanInput): RowPlan {
  const { available } = input;
  if (input.expanded) {
    const fold = input.expandFold && !!input.thread && threadAt(input.columns) >= 0;
    const units = buildUnits(input, fold);
    const groups = groupUnits(units.length, available);
    const unit = unitOf(units, input.expanded);
    const group = groups.findIndex((g) => g.includes(unit));
    if (unit >= 0 && group >= 0) {
      // Rule 5: the expanded column fills the row, every other one is 160 and clips.
      const others = groups.length - 1;
      const widths = groups.map((_, index) => (index === group ? Math.max(ROW_COLUMN_MIN_WIDTH, available - ROW_COLUMN_MIN_WIDTH * others) : ROW_COLUMN_MIN_WIDTH));
      return { fold, units, groups, widths, expanded: input.expanded, expandedUnit: units[unit]!.key, rebalance: null };
    }
    // The expanded region went (closed, or the row changed under it): the row as if nothing were expanded.
    return planRow({ ...input, expanded: null });
  }
  const { fold, rebalance } = decideFold(input);
  const units = buildUnits(input, fold);
  const groups = groupUnits(units.length, available);
  const widths = solveUnits(groups.map((group) => units[group[0]!]!), available).widths;
  return { fold, units, groups, widths, expanded: null, expandedUnit: null, rebalance };
}

/** Each unit's width: its group's where it is the one shown there, 0 for a tab not shown. */
export function unitWidths(plan: RowPlan, active: (group: number) => number): number[] {
  const widths = plan.units.map(() => 0);
  plan.groups.forEach((group, index) => {
    const shown = group.includes(active(index)) ? active(index) : group[0]!;
    widths[shown] = plan.widths[index]!;
  });
  return widths;
}

/**
 * A seam drag's width for the conversation's unit saved back (the prototype's writeSaved): with the thread folded
 * into it, the pair's width shared between the two by their saved widths, the thread kept at its 360 and the
 * conversation at its 360 where the pair has 720.
 */
export function splitPair(width: number, conversation: number, thread: number, threadMin: number, conversationMin: number): { conversation: number; thread: number } {
  const total = conversation + thread;
  let next = total > 0 ? (width * thread) / total : width / 2;
  if (width >= ROW_PAIR_WIDTH) next = clamp(next, threadMin, width - conversationMin);
  return { conversation: width - next, thread: next };
}

/**
 * The row's columns with the keyboard shortcuts panel open beside the conversation: it takes the thread's place, so
 * the thread's column leaves the plan (the thread stays laid out under the panel, unseen, at the width it had: index.css)
 * and the panel stands as the rightmost column at its saved width (the detail column's), with its content minimum.
 */
export function withShortcutHelpColumn(columns: readonly PlanColumn[], panel: { saved: number; contentMin: number }): PlanColumn[] {
  return [
    ...columns.filter((column) => !column.regions.includes(THREAD)),
    { key: SHORTCUT_HELP, regions: [SHORTCUT_HELP], mins: [panel.contentMin], saved: panel.saved },
  ];
}

/**
 * The row's columns with the Tasks page's task open beside its list (the conversation): the first right of it, at its
 * saved width (the detail column's), with its content minimum. Its element is the one marked `data-row-column` with
 * its key in the row (rowLayout).
 */
export function withTasksPageTaskColumn(columns: readonly PlanColumn[], task: { saved: number; contentMin: number }): PlanColumn[] {
  return [{ key: TASKS_PAGE_TASK, regions: [TASKS_PAGE_TASK], mins: [task.contentMin], saved: task.saved }, ...columns];
}

/** How many columns the row shows side by side: one leaves nothing to expand into (rule 5). */
export function shownColumns(plan: RowPlan | null): number {
  return plan ? plan.groups.length : 0;
}
