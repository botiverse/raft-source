import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";

export interface ChannelMemberRemoveTarget {
  type: "agent" | "human";
  id: string;
  name: string;
}

/**
 * Shared remove-member flow (member-page task): the removeTarget staging
 * state plus the destructive ConfirmDialog, factored out of
 * features/channel/ChannelMembers so the members page (its presentation="page"
 * drawer-internal view) runs the byte-identical confirm →
 * removeAgent/removeHuman mutation path. The caller keeps ownership of the
 * mutations (they ride its own useChannelMembers instance) and renders
 * the same compact `confirmDialog` next to its list in every presentation.
 */
export function useChannelMemberRemoval({
  removeAgent,
  removeHuman,
  channelName,
}: {
  removeAgent: (agentId: string) => Promise<void>;
  removeHuman: (userId: string) => Promise<void>;
  channelName?: string;
}) {
  const { formatMessage } = useIntl();
  const [removeTarget, setRemoveTarget] = useState<ChannelMemberRemoveTarget | null>(null);

  const runRemove = useCallback(
    () =>
      removeTarget
        ? removeTarget.type === "agent"
          ? removeAgent(removeTarget.id)
          : removeHuman(removeTarget.id)
        : Promise.resolve(),
    [removeTarget, removeAgent, removeHuman],
  );
  const closeConfirm = useCallback(() => setRemoveTarget(null), []);

  const removeTitle = formatMessage({ id: "agent.channelMembers.removeMemberTitle" });
  const removeMessage = removeTarget
    ? formatMessage(
        { id: "agent.channelMembers.removeMemberMessage" },
        { name: removeTarget.name, channel: channelName || formatMessage({ id: "agent.channelMembers.thisChannel" }) },
      )
    : null;

  const confirmDialog = removeTarget && (
    <ConfirmDialog
      title={removeTitle}
      message={removeMessage}
      confirmLabel={formatMessage({ id: "agent.channelMembers.removeAction" })}
      loadingLabel={formatMessage({ id: "agent.channelMembers.removing" })}
      layer={1}
      chromeLocale="active"
      onConfirm={runRemove}
      onClose={closeConfirm}
    />
  );

  return {
    removeTarget,
    requestRemove: setRemoveTarget,
    confirmDialog,
  };
}
