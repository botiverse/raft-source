import { Button } from "@botiverse/raft-ui";
import { Unplug } from "lucide-react";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../ConfirmDialog";
import { showToast } from "../toastBridge";
import Tooltip from "../ui/Tooltip";
import api from "../../api/client";
import { useChannelStore } from "../../store/channelStore";

/** POST /channels/:id/joint-servers/:serverId/disconnect, then the channel read again for its Connected servers. */
async function disconnectJointServer(channelId: string, serverId: string): Promise<void> {
  await api.post(`/channels/${channelId}/joint-servers/${serverId}/disconnect`);
  // Done once the server agreed; a failed re-read leaves the list to the
  // channel:updated the server sends both sides.
  await useChannelStore.getState().ensureChannel(channelId, { refresh: true }).catch(() => null);
}

/**
 * Disconnect, on another server's row of a joint channel's Connected servers
 * (#wg-rbac:#52): the host's owner/admin takes that server out of the channel
 * (POST /channels/:id/joint-servers/:serverId/disconnect). The caller renders
 * it only where the action can be taken. Its members and agents leave the
 * channel and that server's copy is removed, so it is confirmed first (DS
 * Feedback › Confirming), with a red button: the copy doesn't come back.
 */
export function JointServerDisconnectAction({
  channelId,
  channelName,
  serverId,
  serverName,
}: {
  channelId: string;
  /** Without its #. */
  channelName: string;
  serverId: string;
  serverName: string;
}) {
  const { formatMessage } = useIntl();
  const [confirming, setConfirming] = useState(false);
  const openConfirm = useCallback(() => setConfirming(true), []);
  const closeConfirm = useCallback(() => setConfirming(false), []);
  const values = { server: serverName, channel: channelName };

  // Every refusal (no permission, no channel, flag off) answers as the same
  // neutral error: the dialog shows one generic line and stays open.
  const confirm = useCallback(async () => {
    try {
      await disconnectJointServer(channelId, serverId);
    } catch {
      throw new Error(formatMessage({ id: "channel.edit.disconnectServerFailed" }, { server: serverName }));
    }
    showToast({ title: formatMessage({ id: "channel.edit.disconnectedServerToast" }, { server: serverName, channel: channelName }), type: "success" });
  }, [channelId, channelName, formatMessage, serverId, serverName]);

  return (
    <>
      <Tooltip content={formatMessage({ id: "channel.edit.disconnectServerTooltip" })}>
        <Button
          type="button"
          size="icon-md"
          variant="ghost"
          // cindyz (#wg-rbac:#36): shown when the pointer is on its row (or focus is in it);
          // touch screens have no hover, so it stays visible there.
          className="text-foreground-muted hover:text-foreground md:pointer-fine:invisible md:pointer-fine:group-hover:visible md:pointer-fine:group-focus-within:visible"
          onClick={openConfirm}
          aria-label={formatMessage({ id: "channel.edit.disconnectServerAria" }, values)}
          data-testid="channel-settings-joint-server-disconnect"
        >
          <Unplug aria-hidden="true" />
        </Button>
      </Tooltip>
      {confirming && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.disconnectServerTitle" }, values)}
          message={formatMessage({ id: "channel.edit.confirmDisconnectServer" }, values)}
          confirmLabel={formatMessage({ id: "channel.edit.disconnectServerAction" }, values)}
          loadingLabel={formatMessage({ id: "channel.edit.disconnecting" })}
          confirmTestId="channel-settings-joint-server-disconnect-confirm"
          initialFocus="cancel"
          layer={1}
          onConfirm={confirm}
          onClose={closeConfirm}
        />
      )}
    </>
  );
}
