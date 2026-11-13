import { useCallback } from "react";
import { useIntl } from "react-intl";
import { ArrowRight } from "lucide-react";

import type { Task } from "../../store/taskStore";
import { selectChannelMessageBucket, useMessageStore } from "../../store/messageStore";
import { useThreadStore } from "../../store/threadStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { taskSourceDisplay } from "../../utils/taskConversation";

/**
 * Task v2: the message a task hangs under, quoted in the task dialog. It leads
 * back to that message in the channel, where its own replies are — the
 * discussion of the request, separate from the task's (spec §3.4). A task with
 * no recorded source says so (#wg-task-v2:#23).
 */
export default function TaskSourceRow({ task, onNavigate }: { task: Task; onNavigate?: () => void }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const display = taskSourceDisplay(task);
  const sourceId = display?.kind === "message" ? display.id : null;
  const source = useMessageStore((s) => (sourceId ? selectChannelMessageBucket(s, task.channelId).find((m) => m.id === sourceId) ?? null : null));
  const replyCount = useThreadStore((s) => (sourceId ? s.summaries[sourceId]?.replyCount ?? 0 : 0));
  const closeTaskModal = useThreadStore((s) => s.closeTaskModal);
  const goToSource = useCallback(() => {
    if (!sourceId) return;
    // Leave the task dialog: the source lives in the channel behind it.
    (onNavigate ?? closeTaskModal)();
    nav.toMessage(task.channelId, sourceId);
  }, [closeTaskModal, nav, onNavigate, sourceId, task.channelId]);

  if (!display) return null;
  if (display.kind === "notRecorded") {
    return (
      <div className="mt-3 flex items-start gap-4 text-callout" data-testid="task-modal-source">
        <span className="w-28 shrink-0 text-footnote font-medium text-foreground-hint">
          {formatMessage({ id: "task.source.label" })}
        </span>
        <span className="min-w-0 flex-1 text-foreground-muted" data-testid="task-modal-source-not-recorded">
          {formatMessage({ id: "task.source.notRecorded" })}
        </span>
      </div>
    );
  }
  const sender = source?.senderName ?? "";
  const text = source?.content ?? formatMessage({ id: "task.source.unloaded" });
  return (
    <div className="mt-3 flex items-start gap-4 text-callout" data-testid="task-modal-source">
      <span className="w-28 shrink-0 pt-1.5 text-footnote font-medium text-foreground-hint">
        {formatMessage({ id: "task.source.label" })}
      </span>
      <button
        type="button"
        onClick={goToSource}
        className="group flex min-w-0 flex-1 items-start gap-2 rounded-control border border-line-hairline bg-layer-card px-3 py-1.5 text-left outline-none hover:overlay-subtle active:overlay-medium focus-visible:shadow-focus"
        aria-label={formatMessage({ id: "task.source.open" })}
      >
        <span className="min-w-0 flex-1">
          {sender ? <span className="mr-1.5 font-semibold text-foreground">{sender}</span> : null}
          <span className="line-clamp-2 text-foreground-muted">{text}</span>
          {replyCount > 0 ? (
            <span className="mt-0.5 block font-mono text-mono-meta text-foreground-hint">
              {formatMessage({ id: "task.source.replies" }, { count: replyCount })}
            </span>
          ) : null}
        </span>
        <ArrowRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground-hint" />
      </button>
    </div>
  );
}
