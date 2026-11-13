// Settings › Notifications › Servers (design §4.3 item 4): every server's
// level, the current server first, and per server the channels with their own
// level ("N channels customized"), each one resettable to the default.
// Settings rows in a ListRowGroup like every other setting (DS Forms › A
// setting's row; Jasper + cindyz, #triage:c95a5e53): the level's Select ends
// its row, as wide as its longest level (`fit`, 11-20rem), and goes under the
// text, up to 24rem, where the row is under 32rem wide; the "N channels
// customized" link follows the select (see ServerLevelRow), and the customized
// channels open as rows of their own under it, attached to it (no hairline
// between them: they belong to its level).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Building2 } from "lucide-react";
import { Button, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, TextLink } from "@botiverse/raft-ui";
import api from "../../../api/client";
import { useChannelStore } from "../../../store/channelStore";
import type { Channel } from "../../../store/channelStore";
import { useNotificationSettingsStore } from "../../../store/notificationSettingsStore";
import { useServerStore } from "../../../store/serverStore";
import type { Server } from "../../../store/serverStore";
import { NOTIFICATION_LEVEL_LABEL_ID, NotificationLevelSelect } from "../../notifications/NotificationLevelMenu";
import type { NotificationLevelTarget } from "../../notifications/NotificationLevelMenu";
import SectionHeader from "../../ui/SectionHeader";

function channelLabel(channel: Pick<Channel, "name" | "type" | "peerDisplayName" | "peerName">): string {
  if (channel.type === "dm") return channel.peerDisplayName || channel.peerName || channel.name;
  return `#${channel.name}`;
}

/** Names for a server's channels: the store's for the current server, else fetched once when shown. */
function useChannelNames(serverId: string, isCurrent: boolean, enabled: boolean): Record<string, string> {
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const [fetched, setFetched] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (isCurrent || !enabled || fetched) return;
    let live = true;
    const headers = { "X-Server-Id": serverId };
    void Promise.all([
      api.get("/channels", { headers }).then((res) => (Array.isArray(res.data) ? res.data as Channel[] : [])).catch(() => []),
      api.get("/channels/dm", { headers }).then((res) => (Array.isArray(res.data) ? res.data as Channel[] : [])).catch(() => []),
    ]).then(([list, dms]) => {
      if (!live) return;
      const names: Record<string, string> = {};
      for (const channel of [...list, ...dms]) if (channel?.id) names[channel.id] = channelLabel(channel);
      setFetched(names);
    });
    return () => { live = false; };
  }, [enabled, fetched, isCurrent, serverId]);
  return useMemo(() => {
    if (!isCurrent) return fetched ?? {};
    const names: Record<string, string> = {};
    for (const channel of [...channels, ...dmChannels]) names[channel.id] = channelLabel(channel);
    return names;
  }, [channels, dmChannels, fetched, isCurrent]);
}

/**
 * A channel with its own level, under its server's level (ListRow › attached):
 * no hairline above it, and a group named by the server's title (`ownerLabelId`).
 */
function CustomizedChannel({ serverId, channelId, name, levelLabel, ownerLabelId }: { serverId: string; channelId: string; name: string; levelLabel: string; ownerLabelId: string }) {
  const { formatMessage } = useIntl();
  const [busy, setBusy] = useState(false);
  const reset = useCallback(() => {
    setBusy(true);
    void useNotificationSettingsStore.getState()
      .setLevel({ scope: "channel", id: channelId, serverId, level: "default" })
      .finally(() => setBusy(false));
  }, [channelId, serverId]);
  return (
    <ListRow
      variant="plain"
      interactive={false}
      attached
      role="group"
      aria-labelledby={ownerLabelId}
      data-testid={`customized-channel-${channelId}`}
    >
      <ListRowBody>
        <ListRowTitle>{name}</ListRowTitle>
        <ListRowDescription>{levelLabel}</ListRowDescription>
      </ListRowBody>
      <Button variant="ghost" size="md" type="button" className="shrink-0" onClick={reset} disabled={busy} data-testid={`customized-channel-reset-${channelId}`}>
        {formatMessage({ id: "settings.notifications.servers.resetToDefault" })}
      </Button>
    </ListRow>
  );
}

/** A server row with its "N channels customized" link: see ServerLevelRow. */
const SERVER_ROW_WITH_LINK = "@max-lg:flex-wrap @lg:grid @lg:grid-cols-[minmax(0,1fr)_auto] @lg:gap-x-3 @lg:gap-y-0.5";

function ServerLevelRow({ server, isCurrent }: { server: Server; isCurrent: boolean }) {
  const { formatMessage } = useIntl();
  const customized = useNotificationSettingsStore((s) => s.explicit[server.id]?.channels);
  const customizedIds = useMemo(() => Object.keys(customized ?? {}), [customized]);
  const [open, setOpen] = useState(false);
  const names = useChannelNames(server.id, isCurrent, open);
  const target = useMemo<NotificationLevelTarget>(() => ({ scope: "server", serverId: server.id }), [server.id]);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const labelId = `notification-server-level-${server.id}`;
  const hasCustomized = customizedIds.length > 0;
  return (
    <>
      {/* The exceptions to the level ("N channels customized") sit right above the rows they
          open (cindyz, 2026-11-10, #14055), so they come after the select in the DOM: under 32rem
          the row wraps to title, select, link; wider, the row is a grid that puts the link under
          the title and the select at the row's end across both lines. Tab order: select, link. */}
      <ListRow
        variant="plain"
        interactive={false}
        className={hasCustomized ? SERVER_ROW_WITH_LINK : "@max-lg:flex-wrap"}
        data-testid={`notification-server-row-${server.id}`}
      >
        <ListRowBody>
          <ListRowTitle id={labelId}>
            {isCurrent
              ? formatMessage({ id: "settings.notifications.servers.current" }, { serverName: server.name })
              : server.name}
          </ListRowTitle>
        </ListRowBody>
        <div className={hasCustomized ? "shrink-0 @max-lg:basis-full @lg:col-start-2 @lg:row-span-2 @lg:row-start-1" : "shrink-0 @max-lg:basis-full"}>
          <NotificationLevelSelect target={target} fit className="@max-lg:w-full @max-lg:max-w-sm" showNotes={false} aria-labelledby={labelId} testId={`notification-server-level-${server.id}`} />
        </div>
        {hasCustomized && (
          <ListRowDescription className="@max-lg:basis-full @lg:col-start-1 @lg:row-start-2" data-testid={`notification-server-customized-line-${server.id}`}>
            <TextLink onClick={toggle} aria-expanded={open} data-testid={`notification-server-customized-${server.id}`}>
              {formatMessage({ id: "settings.notifications.servers.customized" }, { count: customizedIds.length })}
            </TextLink>
          </ListRowDescription>
        )}
      </ListRow>
      {open && customizedIds.map((channelId) => (
        <CustomizedChannel
          key={channelId}
          serverId={server.id}
          channelId={channelId}
          name={names[channelId] ?? formatMessage({ id: "settings.notifications.servers.unknownChannel" })}
          levelLabel={formatMessage({ id: NOTIFICATION_LEVEL_LABEL_ID[customized![channelId]] })}
          ownerLabelId={labelId}
        />
      ))}
    </>
  );
}

export function ServersCard() {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const currentId = useServerStore((s) => s.current?.id ?? null);
  const ordered = useMemo(() => {
    const current = servers.find((s) => s.id === currentId);
    return current ? [current, ...servers.filter((s) => s.id !== currentId)] : servers;
  }, [currentId, servers]);
  const idsKey = ordered.map((s) => s.id).join(",");
  useEffect(() => {
    const store = useNotificationSettingsStore.getState();
    for (const id of idsKey ? idsKey.split(",") : []) {
      if (!store.explicit[id]?.loaded) void store.loadServerLevels(id);
    }
  }, [idsKey]);
  if (ordered.length === 0) return null;
  return (
    <div>
      <SectionHeader className="mb-3" icon={<Building2 size={16} />} label={formatMessage({ id: "settings.notifications.servers.sectionLabel" })} />
      <ListRowGroup className="@container" data-testid="notification-servers-card">
        {ordered.map((server) => (
          <ServerLevelRow key={server.id} server={server} isCurrent={server.id === currentId} />
        ))}
      </ListRowGroup>
    </div>
  );
}

/** Settings › On {server} › Notifications: this server's level and its customized channels. */
export function CurrentServerNotificationsCard() {
  const server = useServerStore((s) => s.current);
  useEffect(() => {
    if (server?.id) void useNotificationSettingsStore.getState().loadServerLevels(server.id);
  }, [server?.id]);
  if (!server) return null;
  return (
    <ListRowGroup id="mute-server" className="@container" data-testid="server-notification-level-card">
      <ServerLevelRow server={server} isCurrent />
    </ListRowGroup>
  );
}
