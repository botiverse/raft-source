import { BellRing, Check, UserPlus, UserX } from "lucide-react";
import { useIntl } from "react-intl";
import type { PendingMentionAction } from "../../store/messageStore";
import { AgentAvatar } from "../agent/PixelAvatar";

export type PendingMentionActionLocalState = "notified" | "added";

interface PendingMentionActionStripProps {
  actions: PendingMentionAction[];
  actionState: Record<string, PendingMentionActionLocalState>;
  actionRemoving: Record<string, boolean>;
  actionExecuting: Record<string, PendingMentionActionLocalState>;
  channelName: string;
  onMarkAction: (resolutionId: string, state: PendingMentionActionLocalState) => void;
  onAddAllActions: (resolutionIds: string[]) => void;
  onDismissAction: (resolutionId: string) => void;
}

function pendingMentionCanNotify(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "notify" || available === "notify_only");
}

function pendingMentionCanAdd(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "add" || available === "invite");
}

function pendingMentionTargetLabel(action: PendingMentionAction): string {
  const handle = action.targetHandle || action.targetType;
  if ((action.targetType === "user" || action.targetType === "agent") && handle && !handle.startsWith("@")) {
    return `@${handle}`;
  }
  return handle;
}

function pendingMentionTargetInitial(action: PendingMentionAction): string {
  const label = pendingMentionTargetLabel(action).replace(/^@/, "").trim();
  return (label[0] || "?").toUpperCase();
}

function PendingMentionTargetAvatar({ action }: { action: PendingMentionAction }) {
  if ((action.targetType === "agent" || action.targetType === "user") && action.targetAvatarUrl) {
    const fallbackBg = action.targetType === "agent" ? "bg-brutal-cyan" : "bg-brutal-lavender";
    return (
      <span data-testid="pending-mention-target-avatar">
        <span className={`flex size-5 shrink-0 items-center justify-center overflow-hidden border border-black ${fallbackBg}`}>
          <AgentAvatar avatarUrl={action.targetAvatarUrl} size={18} className="!h-full !w-full" />
        </span>
      </span>
    );
  }

  return (
    <span
      className="absolute left-0 top-0 flex size-5 items-center justify-center border-2 border-black bg-white text-[10px] font-black leading-none text-black shadow-brutal-sm"
      data-testid="pending-mention-target-initial"
    >
      {pendingMentionTargetInitial(action)}
    </span>
  );
}

function channelMentionLabel(channelName: string): string {
  return channelName.startsWith("#") ? channelName : `#${channelName}`;
}

export function PendingMentionActionStrip({
  actions,
  actionState,
  actionRemoving,
  actionExecuting,
  channelName,
  onMarkAction,
  onAddAllActions,
  onDismissAction,
}: PendingMentionActionStripProps) {
  const { formatMessage } = useIntl();
  const addableResolutionIds = actions
    .filter((action) => (
      pendingMentionCanAdd(action)
      && !actionState[action.resolutionId]
      && !actionRemoving[action.resolutionId]
    ))
    .map((action) => action.resolutionId);
  const showAddAll = addableResolutionIds.length > 1;
  const isAddingAll = addableResolutionIds.some((resolutionId) => Boolean(actionExecuting[resolutionId]));

  return (
    <div
      className="mb-2 w-full border-2 border-black bg-brutal-cream px-3 py-2 shadow-brutal-sm"
      data-testid="pending-mention-action-strip"
    >
      <div className="flex flex-col gap-2" data-testid="pending-mention-action-rows">
        {actions.map((action) => {
          const localState = actionState[action.resolutionId];
          const targetLabel = pendingMentionTargetLabel(action);
          const channelLabel = channelMentionLabel(channelName);
          const executingState = actionExecuting[action.resolutionId];
          const isRemoving = Boolean(actionRemoving[action.resolutionId]);
          const canNotify = pendingMentionCanNotify(action) && !localState;
          const canAdd = pendingMentionCanAdd(action) && !localState;
          const statusCopy = localState === "added"
            ? formatMessage(
              { id: "message.pendingMention.addedStatus" },
              { target: targetLabel, channel: channelLabel },
            )
            : localState === "notified"
              ? formatMessage(
                { id: "message.pendingMention.queuedStatus" },
                { target: targetLabel, channel: channelLabel },
              )
              : formatMessage(
                { id: "message.pendingMention.notNotified" },
                { target: targetLabel, channel: channelLabel },
              );
          return (
            <div
              key={action.resolutionId}
              className={`flex min-w-0 flex-col items-stretch gap-2 transition-opacity duration-300 sm:flex-row sm:flex-wrap sm:items-center ${isRemoving ? "opacity-0" : "opacity-100"}`}
            >
              <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
                <UserX size={14} className="shrink-0 text-black/55" />
                <div className="relative h-5 w-5 shrink-0" aria-hidden="true">
                  <PendingMentionTargetAvatar action={action} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-black">{targetLabel}</div>
                  <div
                    className="line-clamp-2 text-[11px] leading-4 text-black/60 sm:line-clamp-none sm:truncate"
                    data-testid="pending-mention-action-status"
                  >
                    {statusCopy}
                  </div>
                </div>
              </div>
              <div
                className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:ml-auto sm:w-auto"
                data-testid="pending-mention-action-buttons"
              >
                {localState === "added" ? (
                  <span className="inline-flex items-center gap-1 border-2 border-black/20 bg-black/[0.04] px-2 py-0.5 text-[12px] font-bold text-black/40 cursor-default">
                    <Check size={12} strokeWidth={3} />
                    {formatMessage({ id: "message.pendingMention.added" })}
                  </span>
                ) : canAdd ? (
                  <button
                    type="button"
                    className="btn-brutal-sm inline-flex items-center gap-1 bg-brutal-pink px-2 py-0.5 text-[12px] font-bold text-black"
                    disabled={Boolean(executingState)}
                    onClick={() => onMarkAction(action.resolutionId, "added")}
                  >
                    <UserPlus size={12} />
                    {formatMessage({ id: "message.pendingMention.add" })}
                  </button>
                ) : null}
                {localState === "notified" ? (
                  <span className="inline-flex items-center gap-1 border-2 border-black/20 bg-black/[0.04] px-2 py-0.5 text-[12px] font-bold text-black/40 cursor-default">
                    <Check size={12} strokeWidth={3} />
                    {formatMessage({ id: "message.pendingMention.queued" })}
                  </span>
                ) : canNotify ? (
                  <button
                    type="button"
                    className="btn-brutal-sm inline-flex items-center gap-1 bg-white px-2 py-0.5 text-[12px] font-bold text-black"
                    disabled={Boolean(executingState)}
                    onClick={() => onMarkAction(action.resolutionId, "notified")}
                  >
                    <BellRing size={12} />
                    {formatMessage({ id: "message.pendingMention.notify" })}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="px-1.5 py-0.5 text-[12px] font-bold text-black/45 hover:text-black/75"
                  onClick={() => onDismissAction(action.resolutionId)}
                >
                  {formatMessage({ id: "message.pendingMention.dismiss" })}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {showAddAll && (
        <div
          className="mt-2 flex justify-end border-t-2 border-black/15 pt-2"
          data-testid="pending-mention-action-footer"
        >
          <button
            type="button"
            className="btn-brutal-sm inline-flex items-center gap-1 bg-brutal-pink px-2.5 py-1 text-[12px] font-black text-black"
            disabled={isAddingAll}
            onClick={() => onAddAllActions(addableResolutionIds)}
          >
            <UserPlus size={12} />
            {formatMessage({ id: "message.pendingMention.addAll" })}
          </button>
        </div>
      )}
    </div>
  );
}
