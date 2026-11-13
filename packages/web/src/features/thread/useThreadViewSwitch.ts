import { useThreadStore } from "../../store/threadStore";
import { threadView, useViewSwitchPaint } from "../../observability/viewSwitchSpan";
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

/** What the replies show, for `web.view.switch`: "Loading replies…" and the lookup shell are pending; no thread channel (no replies yet) is data. */
export function threadRepliesState(shown: ThreadRepliesShown): ViewListState {
  if (shown.failed || shown.resolveFailed) return "error";
  if (shown.resolving) return "pending";
  if (!shown.threadChannelId) return "data";
  return shown.loading || shown.repliesFor !== shown.threadChannelId ? "pending" : "data";
}

/** End hook of `web.view.switch` for a side thread's replies (observability/viewSwitchSpan.ts); a task's conversation is not timed. */
export function useThreadViewSwitch(
  parentMessageId: string | null,
  enabled: boolean,
  shown: Omit<ThreadRepliesShown, "resolving" | "resolveFailed">,
): void {
  const resolving = useThreadStore((s) => s.openThreadLoading);
  const resolveFailed = useThreadStore((s) => s.openThreadError !== null);
  useViewSwitchPaint(
    enabled && parentMessageId ? threadView(parentMessageId) : null,
    threadRepliesState({ ...shown, resolving, resolveFailed }),
    // The replies are fetched by the thread channel's id, often not known at the click.
    shown.threadChannelId,
  );
}
