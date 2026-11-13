import { create } from "zustand";

// Focus Mode survives a reload of this tab: the open thread is restored from
// `?thread=`, so remember which thread was focused and re-apply it when that
// same thread reopens on a cold load (task #49).
const THREAD_FOCUS_STORAGE_KEY = "raft.threadFocusParentMessageId";

function readStoredThreadFocus(): string | null {
  try {
    return sessionStorage.getItem(THREAD_FOCUS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredThreadFocus(parentMessageId: string | null): void {
  try {
    if (parentMessageId) sessionStorage.setItem(THREAD_FOCUS_STORAGE_KEY, parentMessageId);
    else sessionStorage.removeItem(THREAD_FOCUS_STORAGE_KEY);
  } catch {
    // Storage unavailable: Focus Mode just won't survive a reload.
  }
}

// The Tasks page's task in Focus Mode (TasksRoute), the thread's way: the task
// filling the page, kept across a reload of this tab for that task, which its
// `?open=task:` brings back.
const TASK_FOCUS_STORAGE_KEY = "raft.taskFocusTaskId";

function readStoredTaskFocus(): string | null {
  try {
    return sessionStorage.getItem(TASK_FOCUS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredTaskFocus(taskId: string | null): void {
  try {
    if (taskId) sessionStorage.setItem(TASK_FOCUS_STORAGE_KEY, taskId);
    else sessionStorage.removeItem(TASK_FOCUS_STORAGE_KEY);
  } catch {
    // Storage unavailable: Focus Mode just won't survive a reload.
  }
}

// The desktop sidebar's collapsed state is a per-device layout preference,
// like its width (`slock:sidebarWidth`): it survives reloads and applies to
// every server. Separate from `sidebarOpen`, the old mobile-drawer flag that
// sidebar rows reset on every navigation.
export const SIDEBAR_HIDDEN_STORAGE_KEY = "slock:sidebarHidden";
// The Activity list beside an opened conversation collapses the same way, but
// on its own: hiding it never hides the chat sidebar, and the other way round.
export const ACTIVITY_LIST_HIDDEN_STORAGE_KEY = "slock:activityListHidden";

function readStoredHidden(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeStoredHidden(key: string, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(key, "true");
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the column just reopens on the next load.
  }
}

interface UIState {
  sidebarOpen: boolean;
  /** Desktop: the sidebar column is collapsed and the main area takes its width. */
  sidebarHidden: boolean;
  /** Desktop Activity with a conversation open: its list column is collapsed. */
  activityListHidden: boolean;
  threadMaximized: boolean;
  toggleThreadMaximized: (parentMessageId?: string | null) => void;
  /**
   * The side thread (its parent message) stepped behind its channel: where
   * the thread covers the channel (a narrow window, a phone), something
   * opened from the thread in the channel's side column (a workspace
   * Artifact, F41) shows the channel. The thread stays open where it was;
   * opening it again (its "N replies") or closing it brings it back.
   */
  threadBehindChannel: string | null;
  setThreadBehindChannel: (parentMessageId: string | null) => void;
  restoreThreadLayout: () => void;
  /** Cold thread open: re-apply Focus Mode only if this thread was the focused one. */
  resumeThreadLayout: (parentMessageId: string) => void;
  /** Another thread in the same channel took over the side panel; Focus Mode follows it. */
  retargetThreadLayout: (parentMessageId: string) => void;
  /**
   * The Tasks page's task in Focus Mode (TasksRoute): it fills the page, the
   * list hidden. Only while that task is the one open beside the list; it
   * follows a task opened from inside it, and closing it ends Focus Mode.
   */
  taskFocusId: string | null;
  setTaskFocus: (taskId: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  setActivityListHidden: (hidden: boolean) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  sidebarOpen: false,
  sidebarHidden: readStoredHidden(SIDEBAR_HIDDEN_STORAGE_KEY),
  activityListHidden: readStoredHidden(ACTIVITY_LIST_HIDDEN_STORAGE_KEY),
  threadMaximized: false,
  threadBehindChannel: null,
  setThreadBehindChannel: (threadBehindChannel) => set({ threadBehindChannel }),
  toggleThreadMaximized: (parentMessageId = null) => {
    const threadMaximized = !get().threadMaximized;
    writeStoredThreadFocus(threadMaximized ? parentMessageId : null);
    set({ threadMaximized });
  },
  restoreThreadLayout: () => {
    writeStoredThreadFocus(null);
    set({ threadMaximized: false, threadBehindChannel: null });
  },
  resumeThreadLayout: (parentMessageId) => {
    const threadMaximized = readStoredThreadFocus() === parentMessageId;
    if (!threadMaximized) writeStoredThreadFocus(null);
    set({ threadMaximized, threadBehindChannel: null });
  },
  retargetThreadLayout: (parentMessageId) => {
    if (get().threadMaximized) writeStoredThreadFocus(parentMessageId);
    if (get().threadBehindChannel !== null) set({ threadBehindChannel: null });
  },
  taskFocusId: readStoredTaskFocus(),
  setTaskFocus: (taskFocusId) => {
    writeStoredTaskFocus(taskFocusId);
    set({ taskFocusId });
  },
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarHidden: (sidebarHidden) => {
    writeStoredHidden(SIDEBAR_HIDDEN_STORAGE_KEY, sidebarHidden);
    set({ sidebarHidden });
  },
  setActivityListHidden: (activityListHidden) => {
    writeStoredHidden(ACTIVITY_LIST_HIDDEN_STORAGE_KEY, activityListHidden);
    set({ activityListHidden });
  },
}));

/**
 * MainLayout's `data-thread-behind` (workspace Artifacts F41): the open side
 * thread stepped behind its channel, which is the one on screen. index.css
 * hides the thread for it only where the thread would cover the channel.
 */
export function isThreadBehindChannel(
  behind: string | null,
  parentMessageId: string | null,
  parentChannelId: string | null,
  currentChannelId: string | null,
): boolean {
  return behind !== null && behind === parentMessageId && !!parentChannelId && parentChannelId === currentChannelId;
}

/** Shared layout/read contract; only a matching open conversation can be hidden. */
export function isThreadMaximized(
  maximized: boolean,
  parentMessageId: string | null,
  parentChannelId: string | null,
  currentChannelId: string | null,
  profileOpen = false,
): boolean {
  return maximized && !profileOpen && !!parentMessageId && !!parentChannelId && parentChannelId === currentChannelId;
}
