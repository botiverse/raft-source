import { memo } from "react";
import { Check } from "lucide-react";
import {
  MobileNavServerPopoverRowBody,
  MobileNavServerPopoverRowDescription,
  MobileNavServerPopoverRowLabel,
} from "@botiverse/raft-ui/wip";
import type { Server } from "../../store/serverStore";
import type { ServerUnreadSummary } from "../../utils/serverUnreadSummary";
import AvatarSlot from "../ui/AvatarSlot";
import ServerRowUnread from "../ui/ServerRowUnread";

/**
 * What a server row in the phone's server popover shows (MobileServerTab's sortable row): the avatar, the name and
 * slug, the current check and the unread. Memoized: the sortable row renders on every pointer move while it is dragged
 * and on every change of the row under the finger; this renders only when the server or its unread does.
 */
export const ServerTabRowContent = memo(function ServerTabRowContent({ server, isCurrent, unreadSummary }: {
  server: Server;
  isCurrent: boolean;
  unreadSummary?: ServerUnreadSummary;
}) {
  // Activity's server summary is the cross-surface authority. An absent field
  // is unknown, so do not substitute the broader legacy sidebar count.
  return (
    <>
      <AvatarSlot context="compact-list" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={(server.name ?? "").trim().charAt(0).toUpperCase() || "S"} />
      <MobileNavServerPopoverRowBody>
        <MobileNavServerPopoverRowLabel>{server.name}</MobileNavServerPopoverRowLabel>
        <MobileNavServerPopoverRowDescription>/{server.slug}</MobileNavServerPopoverRowDescription>
      </MobileNavServerPopoverRowBody>
      {isCurrent ? <Check aria-hidden="true" /> : null}
      <ServerRowUnread summary={unreadSummary} isCurrent={isCurrent} />
    </>
  );
});
