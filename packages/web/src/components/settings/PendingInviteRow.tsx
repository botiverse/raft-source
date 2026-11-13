import { Button, ListRow, ListRowBody, ListRowMeta, ListRowTitle } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import { X } from "lucide-react";
import { useIntl } from "react-intl";
import type { PendingInvite } from "../../features/settings/shared/inviteRecords";

export function PendingInviteRow({
  invite,
  onRequestRevoke,
}: {
  invite: PendingInvite;
  onRequestRevoke: (invite: PendingInvite) => void;
}) {
  const { formatDate, formatMessage } = useIntl();
  const handleRequestRevoke = useCallback(() => onRequestRevoke(invite), [invite, onRequestRevoke]);

  return (
    // A row of Administration › Invites' ListRowGroup: the address, when it was sent, Revoke.
    <ListRow variant="plain" interactive={false}>
      <ListRowBody>
        <ListRowTitle>{invite.invitedEmail}</ListRowTitle>
      </ListRowBody>
      <ListRowMeta className="shrink-0">
        {formatDate(invite.createdAt, {
          month: "short",
          day: "numeric",
        })}
      </ListRowMeta>
      <Tooltip content={formatMessage({ id: "settings.invites.revokeInviteTitle" })}>
      <Button
        variant="outline" size="icon-md" type="button"
        onClick={handleRequestRevoke}
        className="shrink-0"
        aria-label={formatMessage({ id: "settings.invites.revokeInviteTitle" })}
        data-slot="button"
      >
        <X size={14} />
      </Button>
      </Tooltip>
    </ListRow>
  );
}
