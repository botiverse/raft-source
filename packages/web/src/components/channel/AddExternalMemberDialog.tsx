import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import DialogCard from "../ui/DialogCard";
import { ExternalInviteSteps } from "./ExternalInviteSteps";
import { useOwnConnectableServers } from "./externalInvites";
import { useChannelStore } from "../../store/channelStore";
import { useExternalInviteTracker } from "../../analytics/externalInvites";
import type { ExternalInviteEntry } from "../../analytics/externalInvites";

/**
 * Invite People Outside <server> (#wg-rbac:#16, design v5.0 A2): a host Server owner or
 * admin pastes up to 20 emails, checks what the server makes of them (merged
 * duplicates, malformed addresses, people already invited or already in the
 * Server), then sends. A public channel becomes private with the first invite,
 * and the dialog says so before anything is sent.
 *
 * "Your servers": beside the emails, the viewer's other servers they own or
 * administer, as checkboxes; the checked ones connect on confirm, with no
 * email and no approval. A joint channel (this Server hosts it) leaves out
 * the servers already in it. The review says the same for every channel:
 * those invited join as a guest or connect their server (the server decides
 * which ways in each invite offers).
 *
 * Connecting a server turns a channel that isn't joint yet into one, and the
 * server connected sees its earlier messages: "Your servers" says so when the
 * channel has any (its last message time, from the channel list). The
 * emails say it too, conditionally: those invited may connect a server or
 * join as a guest (Warden, myoland).
 */
export default function AddExternalMemberDialog({
  channelId,
  channelType,
  serverName,
  onClose,
  layer,
  inviteEntry,
}: {
  channelId: string;
  channelType: "channel" | "private" | "joint";
  serverName: string;
  onClose: () => void;
  layer?: number;
  /** What opened it (product events: `external_invite_opened.entry`). */
  inviteEntry: ExternalInviteEntry;
}) {
  const { formatMessage } = useIntl();
  // Every way out (the ×, Esc, Cancel, the upgrade, a send that went through) is one close.
  const tracker = useExternalInviteTracker("existing_channel", inviteEntry);
  const close = useCallback(() => {
    tracker.closed();
    onClose();
  }, [onClose, tracker]);
  const ownServers = useOwnConnectableServers(true);
  const channel = useChannelStore((s) => s.channels.find((row) => row.id === channelId));
  const channelName = channel?.name ?? "";
  const jointServers = channel?.jointServers;
  const hasMessages = useChannelStore((s) => Boolean(s.channelActivity[channelId]));
  const serversHistoryHint = channelType !== "joint" && channel?.type !== "joint" && hasMessages;
  const servers = useMemo(() => {
    const connected = new Set((jointServers ?? []).filter((server) => server.status === "active").map((server) => server.serverId));
    return connected.size === 0 ? ownServers : ownServers.filter((server) => !connected.has(server.id));
  }, [ownServers, jointServers]);
  return (
    <DialogCard
      title={formatMessage({ id: "channel.externalInvite.title" }, { server: serverName })}
      onClose={close}
      narrow="sheet"
      layer={layer}
      testId="add-external-member-dialog"
    >
      <ExternalInviteSteps
        channelId={channelId}
        serverName={serverName}
        willBecomePrivate={channelType === "channel"}
        dismissLabel={formatMessage({ id: "settings.common.cancel" })}
        onDismiss={close}
        onSent={close}
        servers={servers}
        channelName={channelName}
        serversHistoryHint={serversHistoryHint}
        tracker={tracker}
      />
    </DialogCard>
  );
}
