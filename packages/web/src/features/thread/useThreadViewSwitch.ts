import { useThreadStore } from "../../store/threadStore";
import { taskView, threadView, useViewSwitchPaint } from "../../observability/viewSwitchSpan";
import type { ViewListState } from "../../observability/viewSwitchSpan";

export interface ThreadRepliesShown {
  threadChannelId: string | null;
  /** The thread channel the replies on screen were loaded for (set with the load's first state). */
  repliesFor: string | null;
  loading: boolean;
  failed: boolean;
  /** The thread's channel is still being looked up, or that failed. */
  resolving: boolean;
  resolveFailed: boolean;
}

export interface ThreadViewSwitchTarget {
  parentMessageId: string | null;
  parentTaskId: string | null;
  isTaskModalSurface: boolean;
}

/** What the replies show, for `web.view.switch`: "Loading replies…" and the lookup shell are pending; no thread channel (no replies yet) is data. */
export function threadRepliesState(shown: ThreadRepliesShown): ViewListState {
  if (shown.failed || shown.resolveFailed) return "error";
  if (shown.resolving) return "pending";
  if (!shown.threadChannelId) return "data";
  return shown.loading || shown.repliesFor !== shown.threadChannelId ? "pending" : "data";
}

/** View key for a side thread or task conversation panel (null when unkeyed). */
export function threadSurfaceViewKey(target: ThreadViewSwitchTarget): string | null {
  if (target.parentTaskId) return taskView(target.parentTaskId);
  if (target.isTaskModalSurface) return target.parentMessageId ? taskView(target.parentMessageId) : null;
  return target.parentMessageId ? threadView(target.parentMessageId) : null;
}

/** End hook of `web.view.switch` for a side thread's or task conversation's replies (observability/viewSwitchSpan.ts). */
export function useThreadViewSwitch(
  target: ThreadViewSwitchTarget,
  shown: Omit<ThreadRepliesShown, "resolving" | "resolveFailed">,
): void {
  const isTaskSurface = target.parentTaskId !== null || target.isTaskModalSurface;
  const resolving = useThreadStore((s) => (isTaskSurface ? (s.taskModal?.loading ?? false) : s.openThreadLoading));
  const resolveFailed = useThreadStore((s) => (
    isTaskSurface
      ? s.taskModal?.error !== null && s.taskModal?.error !== undefined
      : s.openThreadError !== null
  ));
  useViewSwitchPaint(
    threadSurfaceViewKey(target),
    threadRepliesState({ ...shown, resolving, resolveFailed }),
    // The replies are fetched by the thread/task conversation's channel id, often not known at the click.
    shown.threadChannelId,
  );
}
