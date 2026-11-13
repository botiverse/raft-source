import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { useChannelStore } from "../../store/channelStore";

/**
 * The server deletes a private channel, with its messages, once its last
 * member leaves (channelService deletePrivateChannelIfEmpty: no humans and no
 * agents left). A roster still loading, or failed to load, is empty, so it
 * reads as that case: warning once too often beats deleting without a word.
 */
function leavingDeletesChannel(channelType: string | undefined, memberCount: number): boolean {
  return channelType === "private" && memberCount <= 1;
}

/** Leave's confirmation, shared by the channel settings and the sidebar menu. */
export default function LeaveChannelConfirmDialog({
  channelId,
  channelName,
  confirmTestId,
  layer,
  onConfirm,
  onClose,
}: {
  channelId: string;
  channelName: string;
  confirmTestId?: string;
  layer?: number;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const channelType = useChannelStore((s) => s.channels.find((c) => c.id === channelId)?.type);
  const { channelHumans, channelAgents } = useChannelMembers(channelId, { enabled: channelType === "private" });
  // How you come back differs: a public channel you rejoin yourself; a private
  // one needs a member's invite, a joint one an admin's (POST
  // /channels/:id/join refuses both).
  const messageId = channelType === "private" ? "channel.edit.confirmLeavePrivate"
    : channelType === "joint" ? "channel.edit.confirmLeaveJoint"
    : "channel.edit.confirmLeave";
  const deletes = leavingDeletesChannel(channelType, channelHumans.length + channelAgents.length);
  return (
    <ConfirmDialog
      chromeLocale="active"
      title={formatMessage({ id: deletes ? "channel.edit.leaveDeleteTitle" : "channel.edit.leaveChannel" })}
      message={deletes
        ? formatMessage({ id: "channel.edit.leaveDeleteMessage" })
        : formatMessage({ id: messageId }, { name: channelName })}
      confirmLabel={formatMessage({ id: deletes ? "channel.edit.leaveDeleteAction" : "channel.edit.leaveAction" })}
      loadingLabel={formatMessage({ id: "channel.edit.leaving" })}
      confirmVariant={deletes ? "danger" : "warning"}
      confirmTestId={confirmTestId}
      layer={layer}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
