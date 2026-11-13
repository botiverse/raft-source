import { useCallback, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { Archive } from "lucide-react";
import { ChannelIcon } from "../channel/channelKindIcon";
import { Card, IconTile, TextLink } from "@botiverse/raft-ui";

import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { isSidebarExternalSectionChannel } from "../layout/sidebarChannelVisibility";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";
import Tooltip from "../ui/Tooltip";
import { UnarchiveChannelButton } from "./UnarchiveChannelButton";

export type ArchivedChannel = Channel & {
  type: "channel" | "private" | "joint";
  archivedAt: string;
};

function isArchivedChannel(channel: Channel): channel is ArchivedChannel {
  return (
    !!channel.archivedAt
    && (channel.type === "channel" || channel.type === "private" || channel.type === "joint")
  );
}

/** External first (Q12 A: a guest, a guest server or an open invite), as the channel's header tags it. */
function channelTypeMessageId(channel: ArchivedChannel) {
  if (isSidebarExternalSectionChannel(channel)) return "settings.archivedChannels.joint" as const;
  if (channel.type === "private") return "settings.archivedChannels.private" as const;
  if (channel.type === "joint") return "settings.archivedChannels.joint" as const;
  return "settings.archivedChannels.public" as const;
}

function ArchivedChannelsSectionContent() {
  const { formatMessage } = useIntl();
  const { formatMediumDateTime } = useTimeFormatter();
  const nav = useAppNavigate();
  const openChannel = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const channelId = event.currentTarget.dataset.channelId;
      if (channelId) nav.toChannel(channelId);
    },
    [nav],
  );
  const { capabilities } = useServerPermissions();
  const channels = useChannelStore((state) => state.channels);
  const loading = useChannelStore((state) => state.loading);
  const unarchiveChannel = useChannelStore((state) => state.unarchiveChannel);
  const [busyChannelId, setBusyChannelId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const archivedChannels = useMemo(
    () => channels
      .filter(isArchivedChannel)
      .sort((left, right) => (
        right.archivedAt.localeCompare(left.archivedAt)
        || left.name.localeCompare(right.name)
      )),
    [channels],
  );

  const handleUnarchive = useCallback(
    async (channel: ArchivedChannel) => {
      setError("");
      setBusyChannelId(channel.id);
      try {
        await unarchiveChannel(channel.id);
      } catch (err: unknown) {
        const axiosError = err as { response?: { data?: { error?: string } } };
        setError(axiosError.response?.data?.error || formatMessage({ id: "channel.edit.failedUnarchive" }));
      } finally {
        setBusyChannelId(null);
      }
    },
    [formatMessage, unarchiveChannel],
  );

  if (!capabilities.archiveChannels || loading || archivedChannels.length === 0) {
    return null;
  }

  return (
    <section className="mb-6" data-testid="archived-channels-section">
      <SectionHeader
        className="mb-3"
        icon={<Archive size={16} />}
        label={formatMessage({ id: "settings.archivedChannels.sectionLabel" })}
        count={archivedChannels.length}
      />

      {error ? (
        <Banner
          intent="warning"
          density="sm"
          className="mb-3"
          data-testid="archived-channels-error"
        >
          {error}
        </Banner>
      ) : null}

      <Card className="rule-y rule-line-hairline">
        {archivedChannels.map((channel) => {
          const busy = busyChannelId === channel.id;
          const typeLabel = formatMessage({ id: channelTypeMessageId(channel) });
          const channelName = formatMessage(
            { id: "settings.archivedChannels.channelName" },
            { name: channel.name },
          );
          return (
            <div
              key={channel.id}
              className="flex flex-col gap-3 px-4 py-3 sm:min-h-11 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`archived-channel-row-${channel.id}`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Tooltip content={typeLabel}>
                <IconTile size="sm" role="img" aria-label={typeLabel}>
                  <ChannelIcon channel={channel} size={16} />
                </IconTile>
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <TextLink
                    className="block max-w-full truncate text-left text-subhead"
                    aria-label={formatMessage(
                      { id: "settings.archivedChannels.openAriaLabel" },
                      { name: channel.name },
                    )}
                    data-channel-id={channel.id}
                    onClick={openChannel}
                  >
                    {channelName}
                  </TextLink>
                  <div className="mt-0.5 truncate text-footnote text-foreground-muted">
                    {formatMessage(
                      { id: "settings.archivedChannels.metadata" },
                      {
                        type: typeLabel,
                        date: formatMediumDateTime(channel.archivedAt),
                      },
                    )}
                  </div>
                </div>
              </div>
              <UnarchiveChannelButton
                channel={channel}
                busy={busy}
                disabled={busyChannelId !== null}
                onUnarchive={handleUnarchive}
              />
            </div>
          );
        })}
      </Card>
    </section>
  );
}

export default function ArchivedChannelsSection() {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  return <ArchivedChannelsSectionContent key={serverId} />;
}
