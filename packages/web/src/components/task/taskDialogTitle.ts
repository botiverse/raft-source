import { createContext, useContext } from "react";

/**
 * The id the open task dialog (TaskDialogShell) is labelled by: the task's title in its card (TaskModalHead, the
 * legacy task panel) carries it. Undefined outside the dialog (the pop-out window, a side panel), where nothing is
 * named by it.
 */
export const TaskDialogTitleContext = createContext<string | undefined>(undefined);

export function useTaskDialogTitleId(): string | undefined {
  return useContext(TaskDialogTitleContext);
}
