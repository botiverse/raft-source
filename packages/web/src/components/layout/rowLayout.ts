import { useLayoutEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { COLUMN_BOUNDS, MAIN_COLUMN_MIN_WIDTH } from "../../lib/panelBounds";
import { commitColumnWidth, getColumnWidth, previewColumnWidth, useColumnWidth } from "../../store/columnWidthStore";
import { useUIStore } from "../../store/uiStore";
import { useThreadStore } from "../../store/threadStore";
import { markClipped, registerSeamColumn } from "../ui/rowSeams";
import { SEAM_COLUMN_MIN_WIDTH } from "../ui/seamCascade";
import { CONVERSATION, planRow, SHORTCUT_HELP, sideColumnOf, splitPair, TASKS_PAGE_TASK, THREAD, unitWidths } from "./rowPlan";
import type { PlanColumn, RowPlan } from "./rowPlan";
import { activeUnit, restoreRowExpand, useRowPlanStore } from "./rowPlanStore";

/**
 * MainLayout's row laid out by the #189 rules (#proj-raft-ui:#189, the design lead's prototype pt_141adb2e): every
 * column in it, the conversation included, has a saved width; the plan (rowPlan) says from those and the row's room
 * whether the thread folds into the conversation's column (rule 3), which columns become tabs (rule 4), what is
 * expanded (rule 5), and each column's width; this lays that out on the row's elements, as the prototype's render
 * does. A seam drag saves every column's shown width (rule 1, rowSeams), so what a release shows is what is saved.
 *
 * Where the row isn't planned (a phone, a legacy task panel in the row) the columns show their saved widths and
 * index.css's thread-only and overlay rules hold.
 */

const CONVERSATION_WIDTH_KEY = "slock:conversationWidth";
/** Before a seam beside it was ever dragged, the conversation is what the other columns leave, at least this (the prototype's). */
const CONVERSATION_DEFAULT_WIDTH = 400;

function readConversationWidth(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(CONVERSATION_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= SEAM_COLUMN_MIN_WIDTH ? Math.round(stored) : null;
  } catch {
    return null;
  }
}

/** The conversation's saved width; null until a seam beside it is first dragged. */
export const useConversationWidth = create<{ width: number | null }>(() => ({
  width: typeof window === "undefined" ? null : readConversationWidth(),
}));

function previewConversationWidth(width: number) {
  useConversationWidth.setState({ width: Math.max(SEAM_COLUMN_MIN_WIDTH, Math.round(width)) });
}

function commitConversationWidth(width: number) {
  previewConversationWidth(width);
  try {
    window.localStorage.setItem(CONVERSATION_WIDTH_KEY, String(useConversationWidth.getState().width));
  } catch {
    // Storage can be unavailable (private mode); the width still holds for the session.
  }
}

/** Shows `element` at `width` (index.css `[data-row-width]`), or at its own width again (null). */
function showAt(element: HTMLElement, width: number | null) {
  if (width === null) {
    if (!element.hasAttribute("data-row-width")) return;
    element.removeAttribute("data-row-width");
    element.style.removeProperty("--row-width");
    return;
  }
  const value = `${Math.round(width * 100) / 100}px`;
  if (element.style.getPropertyValue("--row-width") !== value) element.style.setProperty("--row-width", value);
  if (!element.hasAttribute("data-row-width")) element.setAttribute("data-row-width", "");
}

/** A column that is a tab not shown (rule 4): out of the row's flow and out of reach, its content as it was. */
function hideAsTab(element: HTMLElement, hidden: boolean) {
  if (hidden === element.hasAttribute("data-row-tab-hidden")) return;
  if (hidden) {
    element.setAttribute("data-row-tab-hidden", "");
    element.setAttribute("inert", "");
  } else {
    element.removeAttribute("data-row-tab-hidden");
    element.removeAttribute("inert");
  }
}

/** The thread's Expand is its Focus Mode (rule 5): kept across a reload for that thread (uiStore). */
function setThreadExpanded(expanded: boolean) {
  const ui = useUIStore.getState();
  if (ui.threadMaximized !== expanded) ui.toggleThreadMaximized(useThreadStore.getState().openParentMessageId);
}
useRowPlanStore.setState({ threadExpand: setThreadExpanded });

/** What ChannelSideArea knows of the row for the plan. */
export interface RowPlanSource {
  /** The plan lays the row out (a desktop, the conversation in the row). */
  active: boolean;
  /** The row's width. */
  available: number;
  /** The side layout's columns with an open region, left to right (the thread's where it is open). */
  columns: readonly PlanColumn[];
  /** A thread is open beside the conversation. */
  thread: boolean;
  /** Fold whatever the room: a touch tablet in portrait under 1280px (responsive.md, the iPad's thread-only row). */
  forceFold: boolean;
  /** The thread is in Focus Mode as MainLayout's row applies it (`data-thread-maximized`): its Expand (rule 5). */
  threadExpanded: boolean;
  /** The Tasks page's task beside its list is in Focus Mode (rowPlanStore `taskColumn`): its Expand. */
  taskExpanded?: boolean;
}

/**
 * The row's plan (rowPlan `planRow`) from every column's saved width, published for the heads (rowPlanStore); null
 * where the row isn't planned. Coming out of the fold it saves the conversation's and the thread's widths the plan
 * gives them, as the prototype does, so neither comes back under its 360.
 */
export function useRowPlan(source: RowPlanSource): RowPlan | null {
  const thread = useColumnWidth("thread");
  const conversation = useConversationWidth((s) => s.width);
  const stored = useRowPlanStore((s) => s.expanded);
  const expandFold = useRowPlanStore((s) => s.expandFold);
  const expanded = source.threadExpanded ? THREAD : source.taskExpanded ? TASKS_PAGE_TASK : stored;
  // Whether the plan last laid out folded the thread (rule 3's way back out of the fold): read when the next plan is
  // made; coming out of the fold, the widths it saves make the one after.
  const wasFolded = useRef(false);
  const { active, available, columns, forceFold } = source;
  const threadOpen = source.thread;
  const plan = useMemo(() => {
    if (!active || available <= 0) return null;
    const others = columns.reduce((total, column) => total + column.saved, 0);
    return planRow({
      available,
      conversation: { saved: conversation ?? Math.max(CONVERSATION_DEFAULT_WIDTH, available - others), contentMin: MAIN_COLUMN_MIN_WIDTH },
      thread: threadOpen ? { saved: thread, contentMin: COLUMN_BOUNDS.thread.contentMin } : null,
      columns,
      expanded,
      expandFold,
      wasFolded: wasFolded.current,
      forceFold,
    });
  }, [active, available, columns, conversation, expandFold, expanded, forceFold, thread, threadOpen]);
  // The regions in the row the last plan had: one opening while a column is expanded restores the row (rule 5, the
  // prototype's openRegion), so the new column shows as the row's rules place it.
  const regionsBefore = useRef<ReadonlySet<string> | null>(null);
  useLayoutEffect(() => {
    wasFolded.current = !!plan?.fold;
    useRowPlanStore.setState({ plan });
    if (!plan) {
      regionsBefore.current = null;
      return;
    }
    const regions = new Set(plan.units.flatMap((unit) => unit.regions));
    const before = regionsBefore.current;
    regionsBefore.current = regions;
    // (The first plan, a reload, keeps a thread's Focus Mode as it was saved.)
    // (Nor the Tasks page's task joining the row in its Focus Mode, kept from a reload or from before the page was
    // left: it is the expansion, no column opening into it.)
    const opening = (region: string) => !before?.has(region) && !(region === TASKS_PAGE_TASK && plan.expanded === TASKS_PAGE_TASK);
    if (before && plan.expanded !== null && [...regions].some(opening)) restoreRowExpand();
    // The expanded region left the row (closed): nothing is expanded any more. The thread's Focus Mode applied where
    // another region was expanded (a switch, rowPlanStore `toggleRowExpand`): the thread's is the one now.
    if (plan.expanded === null && stored !== null) useRowPlanStore.setState({ expanded: null });
    if (plan.expanded === THREAD && stored !== null && useUIStore.getState().threadMaximized) useRowPlanStore.setState({ expanded: null });
    if (plan.rebalance) {
      commitConversationWidth(plan.rebalance.conversation);
      commitColumnWidth("thread", plan.rebalance.thread);
    }
  }, [plan, stored]);
  useLayoutEffect(() => () => useRowPlanStore.setState({ plan: null }), []);
  return plan;
}

/** The element a unit of the plan stands on: the conversation itself is the row's flexible column (none). */
function unitElement(row: HTMLElement, key: string, regions: readonly string[], fold: boolean): HTMLElement | null {
  const thread = () => row.querySelector<HTMLElement>(":scope > .thread-side-column");
  if (key === CONVERSATION) return fold ? thread() : null;
  if (regions.includes(SHORTCUT_HELP)) return row.querySelector<HTMLElement>(":scope > .shortcut-help-column");
  if (regions.includes(THREAD)) return thread();
  // A column of its own beside the conversation (the Tasks page's task): marked with its key.
  if (sideColumnOf(key) === null) return row.querySelector<HTMLElement>(`[data-row-column="${key}"]`);
  return row.querySelector<HTMLElement>(`[data-testid="channel-side-column"][data-in-row="true"][data-column="${sideColumnOf(key)}"]`);
}

/**
 * Lays `plan` out on `row` (MainLayout's), which ChannelSideArea measures (`measured` changes whenever the row or a
 * column in it does): each column other than the conversation at its width (`--row-width`; React keeps rendering
 * its saved width under it), a column that is a tab not shown out of the flow; the conversation, the row's flexible
 * column, takes the rest, which is its own width. Folded, the thread's column is the layer over the conversation, at
 * the conversation's width (index.css `[data-covers]`). Registers the conversation as a column of the row's seams:
 * folded, a seam drag on it shares its width between the conversation and the thread (rowPlan `splitPair`).
 */
export function useRowLayout(row: HTMLElement | null, measured: unknown, plan: RowPlan | null): void {
  const active = useRowPlanStore((s) => s.active);
  const shown = useRef(new Set<HTMLElement>());
  useLayoutEffect(() => {
    const laidOut = new Set<HTMLElement>();
    const release = () => {
      for (const element of shown.current) {
        if (laidOut.has(element)) continue;
        showAt(element, null);
        hideAsTab(element, false);
      }
      shown.current = laidOut;
    };
    const channel = row?.querySelector<HTMLElement>(":scope > .thread-main-column") ?? null;
    if (!row || !channel || !plan) {
      release();
      if (row) delete row.dataset.rowPlan;
      if (channel) markClipped(channel, null, undefined);
      return;
    }
    row.dataset.rowPlan = "";
    const widths = unitWidths(plan, (group) => plan.groups[group]![activeUnit(plan, plan.groups[group]!, active)]!);
    plan.units.forEach((unit, index) => {
      const element = unitElement(row, unit.key, unit.regions, plan.fold);
      if (!element) return;
      laidOut.add(element);
      hideAsTab(element, widths[index] === 0);
      showAt(element, widths[index] === 0 ? null : widths[index]!);
    });
    release();
    // Its content clipped like the others' below its 360 (rule 2): measured as it stands, again once the row settles.
    markClipped(channel, null, MAIN_COLUMN_MIN_WIDTH);
    const fold = plan.fold;
    return registerSeamColumn(channel, () => ({
      key: "conversation",
      min: SEAM_COLUMN_MIN_WIDTH,
      get: () => {
        const own = useConversationWidth.getState().width ?? channel.getBoundingClientRect().width;
        return fold ? own + getColumnWidth("thread") : own;
      },
      preview: (width) => {
        if (!fold) return previewConversationWidth(width);
        const pair = splitPair(width, useConversationWidth.getState().width ?? width - getColumnWidth("thread"), getColumnWidth("thread"), COLUMN_BOUNDS.thread.contentMin, MAIN_COLUMN_MIN_WIDTH);
        previewConversationWidth(pair.conversation);
        previewColumnWidth("thread", pair.thread);
      },
      commit: (width) => {
        if (!fold) return commitConversationWidth(width);
        const pair = splitPair(width, useConversationWidth.getState().width ?? width - getColumnWidth("thread"), getColumnWidth("thread"), COLUMN_BOUNDS.thread.contentMin, MAIN_COLUMN_MIN_WIDTH);
        commitConversationWidth(pair.conversation);
        commitColumnWidth("thread", pair.thread);
      },
    }));
  }, [active, measured, plan, row]);
  useLayoutEffect(() => () => {
    for (const element of shown.current) {
      showAt(element, null);
      hideAsTab(element, false);
    }
    shown.current = new Set();
  }, []);
}
