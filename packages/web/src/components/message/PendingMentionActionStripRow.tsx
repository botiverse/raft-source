import { BellRing, Check, UserPlus, UserX } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { PendingMentionAction } from "../../store/messageStore";
import { Button } from "@botiverse/raft-ui";
import type { PendingMentionActionLocalState } from "./PendingMentionActionStrip";
import { PendingMentionTargetAvatar } from "./PendingMentionTargetAvatar";

function pendingMentionCanNotify(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "notify" || available === "notify_only");
}

export function pendingMentionCanAdd(action: PendingMentionAction): boolean {
  return action.availableActions.some((available) => available === "add" || available === "invite");
}

/**
 * Agent Lounge v0: another agent mentioned in a Lounge. It can only read
 * there, so the server offers no Notify and no Add (`availableActions: []`);
 * the row says why instead of "not in this channel".
 */
export const LOUNGE_AGENT_EXCLUDED_REASON = "lounge_agent_excluded";

export function pendingMentionTargetLabel(action: PendingMentionAction): string {
  const handle = action.targetHandle || action.targetType;
  if ((action.targetType === "user" || action.targetType === "agent") && handle && !handle.startsWith("@")) {
    return `@${handle}`;
  }
  return handle;
}

// A finished step reads as a neutral status chip: sunken fill, no edge, hint ink.
const PENDING_MENTION_DONE_CHIP_CLASS = "inline-flex h-[22px] cursor-default items-center gap-1 rounded-chip md:pointer-fine:h-5 md:pointer-fine:rounded-sticker bg-fill-muted px-2 text-caption font-semibold text-foreground-muted";

interface PendingMentionActionStripRowProps {
  action: PendingMentionAction;
  localState: PendingMentionActionLocalState | undefined;
  isRemoving: boolean;
  executingState: PendingMentionActionLocalState | undefined;
  channelLabel: string;
  onMarkAction: (resolutionId: string, state: PendingMentionActionLocalState) => void;
  onDismissAction: (resolutionId: string) => void;
}

export function PendingMentionActionStripRow({
  action,
  localState,
  isRemoving,
  executingState,
  channelLabel,
  onMarkAction,
  onDismissAction,
}: PendingMentionActionStripRowProps) {
  const { formatMessage } = useIntl();
  const targetLabel = pendingMentionTargetLabel(action);
  const loungeExcluded = action.reason === LOUNGE_AGENT_EXCLUDED_REASON;
  const canNotify = !loungeExcluded && pendingMentionCanNotify(action) && !localState;
  const canAdd = !loungeExcluded && pendingMentionCanAdd(action) && !localState;
  const statusCopy = loungeExcluded
    ? formatMessage({ id: "message.pendingMention.loungeAgentExcluded" }, { target: targetLabel })
    : localState === "added"
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

  const handleMarkAdded = useCallback(() => {
    onMarkAction(action.resolutionId, "added");
  }, [onMarkAction, action.resolutionId]);
  const handleMarkNotified = useCallback(() => {
    onMarkAction(action.resolutionId, "notified");
  }, [onMarkAction, action.resolutionId]);
  const handleDismiss = useCallback(() => {
    onDismissAction(action.resolutionId);
  }, [onDismissAction, action.resolutionId]);

  // Stack or go single-row by the strip's own width (`@container` on the card):
  // a thread panel can be 360px on a wide window.
  return (
    <div
      className={`flex min-w-0 flex-col items-stretch gap-2 transition-opacity duration-300 @xl:flex-row @xl:flex-wrap @xl:items-center ${isRemoving ? "opacity-0" : "opacity-100"}`}
    >
      <div className="flex w-full min-w-0 items-center gap-2 @xl:w-auto @xl:flex-1">
        <UserX size={14} className="shrink-0 text-foreground-hint" />
        <div className="relative h-5 w-5 shrink-0" aria-hidden="true">
          <PendingMentionTargetAvatar action={action} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-footnote font-bold text-foreground">{targetLabel}</div>
          <div
            className="line-clamp-2 text-caption text-foreground-muted @xl:line-clamp-none @xl:truncate"
            data-testid="pending-mention-action-status"
          >
            {statusCopy}
          </div>
        </div>
      </div>
      <div
        className="flex w-full shrink-0 items-center justify-end gap-1.5 @xl:ml-auto @xl:w-auto"
        data-testid="pending-mention-action-buttons"
      >
        {localState === "added" ? (
          <span className={PENDING_MENTION_DONE_CHIP_CLASS}>
            <Check size={12} />
            {formatMessage({ id: "message.pendingMention.added" })}
          </span>
        ) : canAdd ? (
          <Button
            type="button"
            variant="outline"
            size="md"
            disabled={Boolean(executingState)}
            onClick={handleMarkAdded}
          >
            <UserPlus size={12} />
            {formatMessage({ id: "message.pendingMention.add" })}
          </Button>
        ) : null}
        {localState === "notified" ? (
          <span className={PENDING_MENTION_DONE_CHIP_CLASS}>
            <Check size={12} />
            {formatMessage({ id: "message.pendingMention.queued" })}
          </span>
        ) : canNotify ? (
          <Button
            type="button"
            variant="outline"
            size="md"
            disabled={Boolean(executingState)}
            onClick={handleMarkNotified}
          >
            <BellRing size={12} />
            {formatMessage({ id: "message.pendingMention.notify" })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="md"
          onClick={handleDismiss}
        >
          {formatMessage({ id: "message.pendingMention.dismiss" })}
        </Button>
      </div>
    </div>
  );
}
