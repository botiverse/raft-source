import { createContext } from "react";
import { create } from "zustand";
import type { ChannelSideDrop, ChannelSideLayout, ChannelSideSection } from "@botiverse/raft-shared";

import { CONVERSATION, sideColumnKey, sideColumnOf, TASKS_PAGE_TASK, THREAD, unitOf } from "./rowPlan";
import type { RowPlan } from "./rowPlan";

/**
 * The row's plan as rowLayout last laid it out (#proj-raft-ui:#189), for the heads in it: whether a region's Expand
 * shows and is pressed (rule 5), the tabs of a column that became one (rule 4), and which region is expanded.
 *
 * The thread's Expand is its Focus Mode (uiStore `threadMaximized`, kept across a reload for that thread; rowLayout
 * registers `threadExpand` to set it, and MainLayout's row says whether it applies, `data-thread-maximized`); every
 * other region's is `expanded` here, but the Tasks page's task's, which is its Focus Mode too (uiStore `taskFocusId`;
 * TasksRoute publishes it as `taskColumn`). Only one is expanded at a time. The side area publishes its layout and how a
 * section moves (`layout`, `moveSection`) for the heads' Move Left / Move Right. This module imports no app store, so
 * any head may use it.
 */
interface RowPlanState {
  /** Null where the row isn't laid out by the plan (a phone, a row with no conversation). */
  plan: RowPlan | null;
  /** The region other than the thread that is expanded. */
  expanded: string | null;
  /** Whether the thread was folded when the region was expanded: it stays so until restored (the prototype's expandFold). */
  expandFold: boolean;
  /** A column that holds tabs (rule 4): the unit it shows, by the key of the first unit in it. */
  active: Record<string, string>;
  /** Puts the thread in Focus Mode or takes it out (rowLayout's). */
  threadExpand: ((expanded: boolean) => void) | null;
  /** The Tasks page's task standing in the row beside its list (TasksRoute's), with its Focus Mode; null otherwise. */
  taskColumn: TaskColumn | null;
  /** The side layout as the side area places it, and its move (ChannelSideArea's). */
  layout: ChannelSideLayout | null;
  moveSection: ((section: ChannelSideSection, drop: ChannelSideDrop) => void) | null;
}

/** The Tasks page's task as a column of the row (rowPlan TASKS_PAGE_TASK). */
export interface TaskColumn {
  /** In Focus Mode: its Expand (rule 5), kept across a reload for that task (uiStore `taskFocusId`). */
  focused: boolean;
  /** Puts it in Focus Mode or takes it out. */
  focus: (focused: boolean) => void;
}

export const useRowPlanStore = create<RowPlanState>(() => ({ plan: null, expanded: null, expandFold: false, active: {}, threadExpand: null, taskColumn: null, layout: null, moveSection: null }));

/** The thread's Focus Mode as the row applies it (MainLayout's `data-thread-maximized`). */
export function threadExpandedNow(): boolean {
  return typeof document !== "undefined" && document.querySelector('[data-testid="thread-layout-container"][data-thread-maximized="true"]') !== null;
}

/** The region expanded now, the thread's Focus Mode and the Tasks page task's included. */
export function expandedRegion(): string | null {
  if (threadExpandedNow()) return THREAD;
  const { taskColumn, expanded } = useRowPlanStore.getState();
  return taskColumn?.focused ? TASKS_PAGE_TASK : expanded;
}

function setTaskExpanded(expanded: boolean) {
  const { taskColumn } = useRowPlanStore.getState();
  if (taskColumn && taskColumn.focused !== expanded) taskColumn.focus(expanded);
}

function setThreadExpanded(expanded: boolean) {
  useRowPlanStore.getState().threadExpand?.(expanded);
}

/** Restores the row as it was before anything was expanded (rule 5: pressing Expand again, or Escape). */
export function restoreRowExpand() {
  threadKept = false;
  setThreadExpanded(false);
  setTaskExpanded(false);
  if (useRowPlanStore.getState().expanded !== null) useRowPlanStore.setState({ expanded: null });
}

/** The thread's content in its column (raft-ui ThreadPanelContent), from the column. */
const THREAD_CONTENT_SELECTOR = ':scope > [data-slot="thread-panel-root"] > [data-slot="thread-panel-content"]';
/** The thread's height is kept for the expansion now (`keepThreadContent`), until nothing is expanded any more. */
let threadKept = false;
// However the expansion ends (restored, its region closed, the row no longer planned): nothing kept for the next.
useRowPlanStore.subscribe((state, previous) => {
  if (previous.plan?.expanded && !state.plan?.expanded) threadKept = false;
});

/**
 * Before the first expansion, which can fold the thread to its head in its column (index.css
 * `data-thread-collapsed="expand"`): the height its content shows at now, which it keeps there while folded, so its
 * replies keep their scroll position and rows. Not where it is folded by its own chevron; a switch keeps the first's
 * (the thread's Focus Mode height is not the one it comes back to). Focus Mode kept from a reload is an expansion
 * nothing was kept for: the first Expand from it keeps the height it has then, rather than none.
 */
function keepThreadContent() {
  const column = typeof document === "undefined" ? null : document.querySelector<HTMLElement>('[data-testid="thread-side-column"]');
  const content = column?.querySelector<HTMLElement>(THREAD_CONTENT_SELECTOR);
  if (!column || !content || column.dataset.threadCollapsed !== undefined) return;
  column.style.setProperty("--thread-kept-height", `${content.getBoundingClientRect().height}px`);
  threadKept = true;
}

/**
 * Expands `region`'s column, or restores the row where `region` is the one expanded (`regionPressed`). One at a time:
 * expanding another moves the expansion to it, in the same column too (the column keeps the row, the region its
 * height), and whatever the switches, restoring brings back the row as it was before the first (`expandFold` is the
 * first's). The thread's is its Focus Mode, which the row applies a render later: the region expanded before stays
 * expanded until it does (rowLayout `useRowPlan`), so a switch never shows the row restored in between.
 */
export function toggleRowExpand(region: string) {
  const { plan } = useRowPlanStore.getState();
  if (regionPressed(plan, region)) {
    restoreRowExpand();
    return;
  }
  const already = expandedRegion() !== null;
  if (!already || !threadKept) keepThreadContent();
  const expandFold = already ? useRowPlanStore.getState().expandFold : !!plan?.fold;
  if (region === THREAD) {
    useRowPlanStore.setState({ expandFold });
    setTaskExpanded(false);
    setThreadExpanded(true);
  } else if (region === TASKS_PAGE_TASK) {
    // Its Focus Mode applies at once (the row reads `taskColumn`): nothing else stays expanded meanwhile.
    useRowPlanStore.setState({ expanded: null, expandFold });
    setThreadExpanded(false);
    setTaskExpanded(true);
  } else {
    setThreadExpanded(false);
    setTaskExpanded(false);
    useRowPlanStore.setState({ expanded: region, expandFold });
  }
}

/** `region`'s column is the one expanded. */
export function regionExpanded(plan: RowPlan | null, region: string): boolean {
  if (!plan?.expandedUnit) return false;
  const unit = unitOf(plan.units, region);
  return unit >= 0 && plan.units[unit]!.key === plan.expandedUnit;
}

/**
 * `region` is the one expanded, so its Expand is pressed and restores the row: the region itself, not its column (a
 * region stacked with it shows Expand unpressed, which moves the expansion to it). In the conversation's column it is
 * the column, the thread folded over it included, whose head stands for the conversation's.
 */
export function regionPressed(plan: RowPlan | null, region: string): boolean {
  return !!plan?.expanded && regionExpanded(plan, region) && (plan.expandedUnit === CONVERSATION || plan.expanded === region);
}

/** Whether `region`'s head shows Expand (rule 5: only with more than one column in the row, or in the column expanded) and whether it is pressed. */
export function useRowExpand(region: string): { shown: boolean; pressed: boolean } {
  const shown = useRowPlanStore((s) => !!s.plan && unitOf(s.plan.units, region) >= 0 && (s.plan.groups.length > 1 || regionExpanded(s.plan, region)));
  const pressed = useRowPlanStore((s) => regionPressed(s.plan, region));
  return { shown, pressed };
}

/**
 * Rule 5 in a column that stacks regions (stdrc, 2026-11-04): the region expanded, where `region` stands in the same
 * column as it and that column holds more than one; null otherwise (nothing expanded, the expanded region alone in
 * its column, or the conversation's column, the thread folded over it included). The expanded region fills the
 * column's height and the others show their heads alone, in their order (ChannelSideArea `useStack`,
 * ChannelSideCard); their saved heights and folds stay as they were, so restoring brings them back to the pixel.
 */
export function stackExpanded(plan: RowPlan | null, region: string): string | null {
  if (!plan?.expanded || !plan.expandedUnit || plan.expandedUnit === CONVERSATION) return null;
  const unit = plan.units.find((u) => u.key === plan.expandedUnit);
  return unit && unit.regions.length > 1 && unit.regions.includes(region) && unit.regions.includes(plan.expanded) ? plan.expanded : null;
}

/** `stackExpanded` for one region: shown as its head alone (true), filling its column (false), or as saved (null). */
export function stackFolds(plan: RowPlan | null, region: string): boolean | null {
  const expanded = stackExpanded(plan, region);
  return expanded === null ? null : expanded !== region;
}

/** `region` shows as its head alone, a region expanded in its column (`stackFolds`): its panel hides the rest (rule 5). */
export function useRowHeadOnly(region: string): boolean {
  return useRowPlanStore((s) => stackFolds(s.plan, region) === true);
}

/** `region` is a column of the planned row (its head takes the row's Expand, rule 5). */
export function useRowInRow(region: string): boolean {
  return useRowPlanStore((s) => !!s.plan && unitOf(s.plan.units, region) >= 0);
}

/** The plan lays the row out (a desktop): heads take its rules (Expand, ⋯ > Move Left / Move Right). */
export function useRowPlanned(): boolean {
  return useRowPlanStore((s) => s.plan !== null);
}

// Not an Escape that cancels an input method's composition (Safari sends it with keyCode 229).
const isEscape = (event: KeyboardEvent) =>
  event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented;

/** A menu, a dialog or a popover is open: Escape is theirs first. */
function somethingOver(): boolean {
  return document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-slot="popover-popup"]') !== null;
}

/**
 * An Escape in the keyboard shortcuts panel is the panel's: it closes first, the row under it stays as it is
 * (features/keyboard-shortcuts ShortcutHelpColumn; its element's id, SHORTCUT_HELP_PANEL_ID, as this module imports
 * no app store).
 */
function inShortcutHelp(event: KeyboardEvent): boolean {
  const panel = document.getElementById("keyboard-shortcuts-panel");
  return !!panel && event.target instanceof Node && panel.contains(event.target);
}

/** An Escape that restores what is expanded (rule 5): no input method's, and nothing over the row that takes it first. */
export function isRestoreEscape(event: KeyboardEvent): boolean {
  return isEscape(event) && !somethingOver() && !inShortcutHelp(event);
}

/**
 * Escape restores an expanded row (rule 5), before the panel under the focus hears it (a thread's Escape closes the
 * thread): listened for from the app's start, in the capture phase, so it runs before any panel's own listener.
 */
function onEscape(event: KeyboardEvent) {
  if (useRowPlanStore.getState().plan === null || expandedRegion() === null || !isRestoreEscape(event)) return;
  event.preventDefault();
  event.stopPropagation();
  restoreRowExpand();
}

// keydown-global-exempt: rule 5's Escape restores the expanded row; it acts only while a region is expanded
if (typeof window !== "undefined") window.addEventListener("keydown", onEscape, true);

/** The tabs of the column a unit shows in (rule 4), with the one shown; null where the unit is alone in its column. */
export function useRowTabs(region: string): { group: string; units: Array<{ key: string; regions: string[] }>; active: string } | null {
  const plan = useRowPlanStore((s) => s.plan);
  const active = useRowPlanStore((s) => s.active);
  return rowTabsOf(plan, active, region);
}

/** `useRowTabs` on a plan and the tabs picked. */
export function rowTabsOf(plan: RowPlan | null, active: Record<string, string>, region: string): { group: string; units: Array<{ key: string; regions: string[] }>; active: string } | null {
  if (!plan) return null;
  const unit = unitOf(plan.units, region);
  const group = plan.groups.find((g) => g.includes(unit));
  if (!group || group.length < 2) return null;
  const base = plan.units[group[0]!]!.key;
  const units = group.map((index) => plan.units[index]!);
  const shown = activeUnit(plan, group, active);
  // Only the head of the unit shown, and only its top region (the prototype's place(…, j === 0 ? tabs : {})).
  if (topRegion(units[shown]!.regions) !== region) return null;
  return { group: base, units: units.map((u) => ({ key: u.key, regions: u.regions })), active: units[shown]!.key };
}

/** The region whose head is a unit's top: the thread's where it is folded over the conversation. */
export function topRegion(regions: readonly string[]): string | undefined {
  return regions[0] === CONVERSATION && regions.includes(THREAD) ? THREAD : regions[0];
}

/** Index in `group` of the unit its column shows: the one picked, the expanded one, else the first. */
export function activeUnit(plan: RowPlan, group: readonly number[], active: Record<string, string>): number {
  const keys = group.map((index) => plan.units[index]!.key);
  if (plan.expandedUnit && keys.includes(plan.expandedUnit)) return keys.indexOf(plan.expandedUnit);
  const picked = active[keys[0]!];
  return picked && keys.includes(picked) ? keys.indexOf(picked) : 0;
}

/**
 * The row's region a panel is (the profile beside the conversation: MainLayout's ProfilePanelWrapper), for its head
 * (AppPanelHeader): its tabs where its column holds others (rule 4).
 */
export const RowRegionContext = createContext<string | null>(null);

export function pickRowTab(group: string, unit: string) {
  useRowPlanStore.setState({ active: { ...useRowPlanStore.getState().active, [group]: unit } });
}

/**
 * The side layout's column standing right of its column `column` in the planned row, across the seam on its right
 * (its index, the tab shown there where that column holds tabs); null where none does: `column` is the row's last, a
 * tab not shown, not in the plan, or the column after it is another one (the keyboard shortcuts panel, whose seam
 * a crossing doesn't light).
 */
export function columnAfter(plan: RowPlan | null, active: Record<string, string>, column: number): number | null {
  if (!plan) return null;
  const unit = plan.units.findIndex((u) => u.key === sideColumnKey(column));
  const at = plan.groups.findIndex((g) => g.includes(unit));
  const next = plan.groups[at + 1];
  if (unit < 0 || at < 0 || !next || plan.groups[at]![activeUnit(plan, plan.groups[at]!, active)] !== unit) return null;
  return sideColumnOf(plan.units[next[activeUnit(plan, next, active)]!]!.key);
}

/** `columnAfter` in the row as laid out now; null for no column. */
export function useColumnAfter(column: number | undefined): number | null {
  return useRowPlanStore((s) => (column === undefined ? null : columnAfter(s.plan, s.active, column)));
}
