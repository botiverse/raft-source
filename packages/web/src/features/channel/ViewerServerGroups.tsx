/** One group of the grouped member list (jointMemberGroups): the panel's and the page's renderings. */
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

import { ChannelMemberSectionHeader } from "../../components/channel/ChannelMemberList";
import { MemberPageSection } from "./MemberPageSection";

interface GroupProps {
  inViewerServer: boolean;
  /** The viewed server's name, for "Members of {server}". */
  serverName: string;
  count: number;
  /** The group's rows: people, then agents. */
  children: ReactNode;
}

function useGroupLabel(inViewerServer: boolean, serverName: string): string {
  const { formatMessage } = useIntl();
  return inViewerServer
    ? formatMessage({ id: "channel.membersPage.group.viewerServer" }, { server: serverName })
    : formatMessage({ id: "channel.membersPage.group.otherServers" });
}

/** A group in the members panel. */
export function ViewerServerGroupPanel({ inViewerServer, serverName, children }: GroupProps) {
  const label = useGroupLabel(inViewerServer, serverName);
  return (
    <div data-testid={inViewerServer ? "channel-members-viewer-server" : "channel-members-other-servers"}>
      <ChannelMemberSectionHeader>{label}</ChannelMemberSectionHeader>
      {children}
    </div>
  );
}

/** A group on the members page. */
export function ViewerServerGroupPage({ inViewerServer, serverName, count, children }: GroupProps) {
  const label = useGroupLabel(inViewerServer, serverName);
  return (
    <MemberPageSection kind={inViewerServer ? "viewer-server" : "other-servers"} label={label} count={count}>
      {children}
    </MemberPageSection>
  );
}
