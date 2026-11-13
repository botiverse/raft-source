import { UserPlus } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { PendingMentionAction } from "../../store/messageStore";
import { Button, Card, Separator } from "@botiverse/raft-ui";
import { LOUNGE_AGENT_EXCLUDED_REASON, PendingMentionActionStripRow, pendingMentionCanAdd } from "./PendingMentionActionStripRow";

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
  const addableResolutionIds = useMemo(() => actions
    .filter((action) => (
      pendingMentionCanAdd(action)
      && action.reason !== LOUNGE_AGENT_EXCLUDED_REASON
      && !actionState[action.resolutionId]
      && !actionRemoving[action.resolutionId]
    ))
    .map((action) => action.resolutionId), [actions, actionState, actionRemoving]);
  const showAddAll = addableResolutionIds.length > 1;
  const isAddingAll = addableResolutionIds.some((resolutionId) => Boolean(actionExecuting[resolutionId]));
  const channelLabel = channelMentionLabel(channelName);
  const handleAddAllActions = useCallback(() => {
    onAddAllActions(addableResolutionIds);
  }, [onAddAllActions, addableResolutionIds]);

  return (
    <Card
      className="@container mb-2 w-full px-3 py-2.5"
      data-testid="pending-mention-action-strip"
    >
      <div className="flex flex-col gap-2" data-testid="pending-mention-action-rows">
        {actions.map((action) => (
          <PendingMentionActionStripRow
            key={action.resolutionId}
            action={action}
            localState={actionState[action.resolutionId]}
            isRemoving={Boolean(actionRemoving[action.resolutionId])}
            executingState={actionExecuting[action.resolutionId]}
            channelLabel={channelLabel}
            onMarkAction={onMarkAction}
            onDismissAction={onDismissAction}
          />
        ))}
      </div>
      {showAddAll && (
        <>
        <Separator className="mt-2" />
        <div
          className="flex justify-end pt-2"
          data-testid="pending-mention-action-footer"
        >
          <Button
            type="button"
            variant="outline"
            size="md"
            disabled={isAddingAll}
            onClick={handleAddAllActions}
          >
            <UserPlus size={12} />
            {formatMessage({ id: "message.pendingMention.addAll" })}
          </Button>
        </div>
        </>
      )}
    </Card>
  );
}
