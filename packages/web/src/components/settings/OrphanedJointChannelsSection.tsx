import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { GitBranch, Unplug } from "lucide-react";
import { Button, Card, IconTile } from "@botiverse/raft-ui";

import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../../api/client";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useChannelStore } from "../../store/channelStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { jointDisconnectGuestRefusalMessage } from "../../utils/jointChannelLimit";
import ConfirmDialog from "../ConfirmDialog";
import { showToast } from "../toastBridge";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";

type JointConnectionRole = "host" | "participant";

export type JointConnection = {
  channelId: string;
  name: string;
  role: JointConnectionRole;
  memberCount: number;
  isMember: boolean;
  archived: boolean;
  servers: Array<{ serverId: string; name: string; role: JointConnectionRole }>;
};

function OrphanedJointChannelsSectionContent({ serverId }: { serverId: string | null }) {
  const { formatMessage, formatList } = useIntl();
  const { capabilities } = useServerPermissions();
  const canFederate = capabilities.federateChannels;
  const disconnectJointChannel = useChannelStore((state) => state.disconnectJointChannel);
  const currentServerName = useServerStore((state) => state.current?.name ?? "");
  // With external channels on, the host can't disconnect its own copy (host_cannot_disconnect).
  const hostCannotDisconnect = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;
  const [connections, setConnections] = useState<JointConnection[] | null>(null);
  const [confirming, setConfirming] = useState<JointConnection | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!serverId || !canFederate) return;
    let cancelled = false;
    api.get<{ connections: JointConnection[] }>("/channels/joint-connections")
      .then(({ data }) => {
        if (!cancelled) setConnections(data.connections);
      })
      .catch(() => {
        // Best-effort discovery surface: without the list there is nothing to act on.
        if (!cancelled) setConnections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, canFederate]);

  const orphaned = useMemo(
    () => (connections ?? [])
      .filter((connection) => connection.memberCount === 0 && !(hostCannotDisconnect && connection.role === "host"))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [connections, hostCannotDisconnect],
  );

  const openConfirm = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const channelId = event.currentTarget.dataset.channelId;
      setConfirming(orphaned.find((connection) => connection.channelId === channelId) ?? null);
    },
    [orphaned],
  );
  const closeConfirm = useCallback(() => setConfirming(null), []);

  const handleDisconnect = useCallback(async () => {
    if (!confirming) return;
    const channelId = confirming.channelId;
    setError("");
    try {
      await disconnectJointChannel(channelId);
      setConnections((current) => current?.filter((connection) => connection.channelId !== channelId) ?? null);
      showToast({ title: formatMessage({ id: "channel.edit.disconnectedToast" }, { server: currentServerName, channel: confirming.name }), type: "success" });
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(
        jointDisconnectGuestRefusalMessage(err, confirming.name, formatMessage)
          || axiosError.response?.data?.error
          || formatMessage({ id: "settings.orphanedJointChannels.failedDisconnect" }),
      );
    }
  }, [confirming, disconnectJointChannel, currentServerName, formatMessage]);

  if (!canFederate || orphaned.length === 0) {
    return null;
  }

  return (
    <section className="mb-6" data-testid="orphaned-joint-channels-section">
      <SectionHeader
        className="mb-1"
        icon={<GitBranch size={16} />}
        label={formatMessage({ id: "settings.orphanedJointChannels.sectionLabel" })}
        count={orphaned.length}
      />
      <p className="mb-3 text-footnote text-foreground-muted">
        {formatMessage({ id: "settings.orphanedJointChannels.description" }, { server: currentServerName })}
      </p>

      {error ? (
        <Banner
          intent="warning"
          density="sm"
          className="mb-3"
          data-testid="orphaned-joint-channels-error"
        >
          {error}
        </Banner>
      ) : null}

      <Card className="rule-y rule-line-hairline">
        {orphaned.map((connection) => {
          const otherServers = connection.servers
            .filter((server) => server.serverId !== serverId)
            .map((server) => server.name);
          return (
            <div
              key={connection.channelId}
              className="flex flex-col gap-3 px-4 py-3 sm:min-h-11 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`orphaned-joint-channel-row-${connection.channelId}`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <IconTile size="sm" aria-hidden="true">
                  <GitBranch size={16} />
                </IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-subhead">
                    {formatMessage(
                      { id: "settings.orphanedJointChannels.channelName" },
                      { name: connection.name },
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-footnote text-foreground-muted">
                    {otherServers.length > 0
                      ? formatMessage(
                        { id: "settings.orphanedJointChannels.metadata" },
                        { servers: formatList(otherServers, { type: "conjunction" }) },
                      )
                      : formatMessage({ id: "settings.orphanedJointChannels.metadataNoServers" })}
                  </div>
                </div>
              </div>
              <Button
                size="md"
                variant="outline"
                className="w-full sm:w-auto"
                disabled={confirming !== null}
                aria-label={formatMessage(
                  { id: "settings.orphanedJointChannels.disconnectAriaLabel" },
                  { name: connection.name },
                )}
                data-channel-id={connection.channelId}
                onClick={openConfirm}
              >
                <Unplug size={14} />
                {formatMessage({ id: "channel.edit.disconnectAction" })}
              </Button>
            </div>
          );
        })}
      </Card>

      {confirming ? (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "channel.edit.disconnectJointChannel" })}
          message={formatMessage({ id: "channel.edit.confirmDisconnect" }, { name: confirming.name })}
          confirmLabel={formatMessage({ id: "channel.edit.disconnectAction" })}
          loadingLabel={formatMessage({ id: "channel.edit.disconnecting" })}
          onConfirm={handleDisconnect}
          onClose={closeConfirm}
        />
      ) : null}
    </section>
  );
}

export default function OrphanedJointChannelsSection() {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  return <OrphanedJointChannelsSectionContent key={serverId} serverId={serverId} />;
}
