import { useCallback } from "react";
import { SidebarItem, SidebarItemChannelIcon, SidebarItemContent, SidebarItemTitle } from "@botiverse/raft-ui";
import { ChannelKindIcon } from "../channel/channelKindIcon";

/** One channel row of the public server page's channel column. It owns its
 *  click closure so the list passes only stable references. The classes mirror
 *  the signed-in Sidebar row; see PublicServerChannelSidebar. */
export default function PublicServerChannelRow({
  channelId,
  name,
  selected,
  onSelectChannel,
}: {
  channelId: string;
  name: string;
  selected: boolean;
  onSelectChannel: (channelId: string) => void;
}) {
  const handleClick = useCallback(() => onSelectChannel(channelId), [channelId, onSelectChannel]);
  return (
    <SidebarItem
      active={selected}
      onClick={handleClick}
      className="w-full items-center"
      data-public-channel-id={channelId}
    >
      {/* The workspace sidebar's channel row parts: the bare # in the 19px
          icon box, the name on one line with an ellipsis. */}
      <SidebarItemChannelIcon>
        <ChannelKindIcon type="channel" size={16} />
      </SidebarItemChannelIcon>
      <SidebarItemContent className="items-center">
        <SidebarItemTitle>{name}</SidebarItemTitle>
      </SidebarItemContent>
    </SidebarItem>
  );
}
