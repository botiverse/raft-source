import { IconTile, ListRow, ListRowBody, ListRowChevron, ListRowDescription, ListRowGroup, ListRowTitle } from "@botiverse/raft-ui";
import { Plus, Server as ServerIcon, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

type Way = { show: boolean; onOpen: () => void; icon: ReactNode; title: string; description: string; testId: string };

/**
 * The invite page's ways in (B1 / B5), as many rows as the server offers, of
 * equal weight (DS ListRow › inset list, as Choose server): join as a guest,
 * connect servers (several may be chosen there), create a new server. Each
 * row opens its step; the guest and new-server rows stay single choices.
 */
export function InviteWaysIn({ channel, guest, onGuest, connect, onConnect, newServer, onNewServer }: {
  /** The invite's channel as the page names it ("#launch"). */
  channel: string;
  guest: boolean;
  onGuest: () => void;
  connect: boolean;
  onConnect: () => void;
  newServer: boolean;
  onNewServer: () => void;
}) {
  const { formatMessage } = useIntl();
  const ways: Way[] = [
    { show: guest, onOpen: onGuest, icon: <UserPlus />, title: formatMessage({ id: "externalInvite.option.guest" }), description: formatMessage({ id: "externalInvite.option.guestDescription" }), testId: "external-invite-option-guest" },
    { show: connect, onOpen: onConnect, icon: <ServerIcon />, title: formatMessage({ id: "externalInvite.option.connect" }), description: formatMessage({ id: "externalInvite.option.connectDescription" }), testId: "external-invite-option-connect" },
    { show: newServer, onOpen: onNewServer, icon: <Plus />, title: formatMessage({ id: "externalInvite.option.newServer" }), description: formatMessage({ id: "externalInvite.option.newServerDescription" }, { channel }), testId: "external-invite-option-new-server" },
  ];
  return (
    <ListRowGroup className="mb-6" data-testid="external-invite-options">
      {ways.filter((way) => way.show).map((way) => (
        <ListRow key={way.testId} onClick={way.onOpen} data-testid={way.testId}>
          <IconTile size="md" aria-hidden="true">
            {way.icon}
          </IconTile>
          <ListRowBody>
            <ListRowTitle>{way.title}</ListRowTitle>
            <ListRowDescription wrap>{way.description}</ListRowDescription>
          </ListRowBody>
          <ListRowChevron />
        </ListRow>
      ))}
    </ListRowGroup>
  );
}
