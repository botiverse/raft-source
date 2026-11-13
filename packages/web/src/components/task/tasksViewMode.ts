/** Board or list: the Tasks views' layout (the Tasks page and the channel's Tasks tab). */
export type ViewMode = "board" | "list";

const TASK_VIEW_MODE_STORAGE_KEY = "slock.tasks.viewMode";

export function parseTaskViewMode(value: string | null): ViewMode | null {
  return value === "board" || value === "list" ? value : null;
}

/** The person's last explicit choice, across Tasks views. */
export function readStoredTaskViewMode(): ViewMode | null {
  try {
    return parseTaskViewMode(window.localStorage.getItem(TASK_VIEW_MODE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeStoredTaskViewMode(nextView: ViewMode): void {
  try {
    window.localStorage.setItem(TASK_VIEW_MODE_STORAGE_KEY, nextView);
  } catch {
    // Ignore storage failures; the URL param and platform default still work.
  }
}
