import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

import { useSearchContentStore } from "../../../store/searchContentStore";
import type { Task } from "../../../store/taskStore";
import { useThreadStore } from "../../../store/threadStore";
import { useProfileStore } from "../../../store/profileStore";
import { useUIStore } from "../../../store/uiStore";
import { useLegacyTaskPanelStore } from "../../../store/legacyTaskPanelStore";
import { directTaskConversationChannelId, opensAsTaskConversation } from "../../../utils/taskConversation";
import { useOpenTask } from "../useOpenTask";

/**
 * Opening a task from the Tasks page (stdrc): in the page's own detail slot,
 * the task slot Activity and Search use (TaskContentSlot,
 * `?open=task:<taskId>` beside `?task=`): beside the list on desktop, a page
 * pushed in place of it on a phone, its Back returning to the list. A task
 * with no conversation of its own to open (pre-v2: its host message's thread,
 * or a legacy task) opens as it does everywhere else (useOpenTask).
 */
export function useOpenTaskOnTasksPage(): (task: Task) => void {
  const openElsewhere = useOpenTask();
  return useCallback((task: Task) => {
    if (task.isLegacy || !opensAsTaskConversation(task, true)) {
      openElsewhere(task);
      return;
    }
    useProfileStore.getState().closeProfile();
    useLegacyTaskPanelStore.getState().closeLegacyTask();
    // Opened from the list, a task starts beside it (TasksRoute's Focus Mode is the task's it was entered for).
    useUIStore.getState().setTaskFocus(null);
    // Swapping what is open drops a thread of the previous one.
    useThreadStore.getState().closeThread();
    useThreadStore.getState().openTaskConversation({
      taskId: task.id,
      parentChannelId: task.channelId,
      conversationChannelId: directTaskConversationChannelId(task),
    });
    useSearchContentStore.getState().open({ kind: "task", id: task.id });
  }, [openElsewhere]);
}

/** The id of the task open in the page's detail slot, if any. */
export function useTasksPageOpenTaskId(): string | null {
  return useSearchContentStore((s) => (s.slot?.kind === "task" ? s.slot.id : null));
}

/** A task's row (the list) or card (the board) on the Tasks page, inside `root`. */
export function tasksPageRowOf(root: ParentNode, taskId: string): HTMLElement | null {
  const id = CSS.escape(taskId);
  return root.querySelector<HTMLElement>(`[data-task-id="${id}"], [data-task-virtual-key="${id}"]`);
}

/** How long after a task opens the list keeps its row in place while the row re-lays out around it. */
export const OPENED_ROW_HOLD_MS = 1500;

/**
 * Opening a task beside the list re-lays the list out: the task's column takes its width from the row, so the rows
 * re-wrap (taller) and the toolbar may take another line, over several frames as the row is planned. The scroll
 * offset alone then stood for other rows: the first slid under the toolbar and the row just opened left the view.
 * The row opened stays where it was clicked instead (or as near as the shorter view allows, in it whole), until the
 * re-layout settles or the reader scrolls. Call the returned function with the task's id just before opening it.
 */
export function useKeepOpenedRowInPlace(
  rootRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  openTaskId: string | null,
  enabled: boolean,
): (taskId: string) => void {
  const heldRef = useRef<{ taskId: string; offset: number } | null>(null);
  const hold = useCallback((taskId: string) => {
    const root = rootRef.current;
    const scroller = scrollRef.current;
    const row = root && scroller ? tasksPageRowOf(root, taskId) : null;
    heldRef.current = row && scroller ? { taskId, offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top } : null;
  }, [rootRef, scrollRef]);

  useLayoutEffect(() => {
    const held = heldRef.current;
    const root = rootRef.current;
    const scroller = scrollRef.current;
    if (!held || held.taskId !== openTaskId) return undefined;
    heldRef.current = null;
    if (!enabled || !root || !scroller) return undefined;
    let active = true;
    const place = () => {
      if (!active) return;
      const row = tasksPageRowOf(root, held.taskId);
      if (!row) return;
      const view = scroller.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const target = Math.min(Math.max(held.offset, 0), Math.max(0, view.height - box.height));
      const delta = box.top - view.top - target;
      if (Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
    };
    place();
    // The scroller's own window's ResizeObserver (as useIconsOnlyWhenWrapped): the one it is laid out in.
    const win = scroller.ownerDocument.defaultView;
    const resize = win && "ResizeObserver" in win ? new win.ResizeObserver(place) : null;
    resize?.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) resize?.observe(content);
    const stop = () => {
      active = false;
      resize?.disconnect();
    };
    const timer = window.setTimeout(stop, OPENED_ROW_HOLD_MS);
    // The reader's own scroll (or a key that may scroll) ends it.
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of inputs) scroller.addEventListener(type, stop, { passive: true });
    return () => {
      stop();
      window.clearTimeout(timer);
      for (const type of inputs) scroller.removeEventListener(type, stop);
    };
  }, [enabled, openTaskId, rootRef, scrollRef]);
  return hold;
}

/**
 * Closed beside the list (Esc, its ×): focus goes back to the task's row or
 * card on the Tasks page, as Activity's does to its row. The page may remount
 * as the task closes, so it is looked up on the next frame, and only if focus
 * went nowhere.
 */
export function focusTasksPageRowAfterClose(taskId: string): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const page = document.querySelector("[data-tasks-page]");
    const target = page ? tasksPageRowOf(page, taskId) : null;
    if (!target) return;
    const button = target instanceof HTMLButtonElement ? target : target.querySelector<HTMLElement>("button");
    button?.focus();
  });
}
