import { createContext } from "react";

import { useSearchContentStore } from "../../../store/searchContentStore";
import { useUIStore } from "../../../store/uiStore";

/**
 * The Tasks page's task in Focus Mode (TasksRoute, uiStore `taskFocusId`), for its head's Expand
 * (TaskConversationDialog): given only for the task open beside the list on a desktop.
 */
export interface TaskFocus {
  /** The task fills the row, the list a 160 strip beside it (#189 rule 5). */
  focused: boolean;
  toggle: () => void;
}

export const TaskFocusContext = createContext<TaskFocus | null>(null);

/**
 * Focus Mode belongs to the task open (uiStore `taskFocusId`): another task taking its place in the slot takes it along
 * (a task ref opened from inside it; the list is hidden meanwhile, and a row opened from it starts beside it,
 * tasksPageOpen), as the thread's follows another thread in its place (uiStore `retargetThreadLayout`); the task
 * closing, or a thread taking its place, ends it. A cold load sets the slot from no slot: Focus Mode kept from before
 * the reload stays for the task it was entered for.
 */
useSearchContentStore.subscribe((state, previous) => {
  const ui = useUIStore.getState();
  if (ui.taskFocusId === null || previous.slot?.kind !== "task" || previous.slot.id !== ui.taskFocusId || state.slot === previous.slot) return;
  const next = state.slot?.kind === "task" ? state.slot.id : null;
  if (next !== ui.taskFocusId) ui.setTaskFocus(next);
});
