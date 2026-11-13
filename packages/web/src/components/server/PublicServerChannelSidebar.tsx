import PublicServerChannelRow from "./PublicServerChannelRow";
import PublicServerSidebarFrame from "./PublicServerSidebarFrame";
import SectionEyebrow from "../ui/SectionEyebrow";

interface PublicServerChannelSidebarChannel {
  id: string;
  name: string;
}

/** Channel column of the public server page, built from the same rui Sidebar
 *  parts as the signed-in Sidebar (SidebarRoot + accent SidebarItem rows) so
 *  the two read as one surface in every theme. It takes plain props only: the
 *  public page must not reach the member stores the signed-in Sidebar reads.
 *
 *  The frame (root, header, scroll surface) is PublicServerSidebarFrame. The
 *  section label and row classes mirror the signed-in column; they are
 *  measured against it in a real browser rather than imported, because
 *  importing from Sidebar.tsx would pull those stores into the anonymous page. */
export default function PublicServerChannelSidebar({
  serverName,
  channelsLabel,
  channels,
  selectedChannelId,
  onSelectChannel,
}: {
  serverName: string;
  channelsLabel: string;
  channels: PublicServerChannelSidebarChannel[];
  selectedChannelId: string | null;
  onSelectChannel: (channelId: string) => void;
}) {
  return (
    <PublicServerSidebarFrame
      title={serverName}
      testIdPrefix="public-server-channel-sidebar"
      scrollTestId="public-server-channel-list"
    >
      {/* Below sm the column is 144px wide, too narrow for the label on one
          line at the signed-in metrics, so it wraps there as it did before. */}
      <div className="flex h-6 items-center justify-between mt-2 px-5 max-sm:h-auto max-sm:min-h-6">
        <SectionEyebrow as="div" className="min-w-0 flex-1 truncate max-sm:whitespace-normal" data-public-channel-label>
          {channelsLabel}
        </SectionEyebrow>
      </div>
      <div className="flex flex-col gap-0.5 py-2">
        {channels.map((channel) => (
          <PublicServerChannelRow
            key={channel.id}
            channelId={channel.id}
            name={channel.name}
            selected={selectedChannelId === channel.id}
            onSelectChannel={onSelectChannel}
          />
        ))}
      </div>
    </PublicServerSidebarFrame>
  );
}
