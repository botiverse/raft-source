import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { channelsTable, serversTable, useLocalTableRows } from "../../store/localTables";
import type { OfflineUser } from "../../store/offlineSession";
import { serverPersistence } from "../../store/serverPersistenceRegistry";
import { serverSlugOfPath } from "../../utils/serverSlugOfPath";
import type { OfflineFrame } from "./OfflineServerParts";
import { PendingServerLayout } from "./PendingServerLayout";
import { filterSidebarChannelsByMembership, readSidebarJoinedChannelsOnly } from "./sidebarChannelVisibility";

/**
 * Opened offline with the last session on the device (store/offlineSession.ts,
 * #proj-frontend:#9): the server the URL names, else the last one opened,
 * else the first kept, with its channel rows, in the frame the app draws
 * while a server loads. Read from the local tables only; the server store,
 * the URL and the server are left alone, so when /auth/me answers the app
 * boots from here as it always does.
 */
export function OfflineServerLayout({ user }: { user: OfflineUser }) {
  const { pathname } = useLocation();
  const servers = useLocalTableRows(serversTable, useMemo(() => ({ userId: user.id }), [user.id]));
  const slug = serverSlugOfPath(pathname);
  const server = useMemo(() => {
    if (slug) return servers.find((row) => row.slug === slug) ?? null;
    const lastSlug = serverPersistence.readLastServerSlug();
    return servers.find((row) => row.slug === lastSlug) ?? servers[0] ?? null;
  }, [servers, slug]);
  const channelScope = useMemo(() => (server ? { userId: user.id, serverId: server.id } : null), [server, user.id]);
  const channels = useLocalTableRows(channelsTable, channelScope);
  const offline = useMemo<OfflineFrame>(() => ({
    server,
    channels: filterSidebarChannelsByMembership(
      channels.filter((channel) => !channel.archivedAt),
      readSidebarJoinedChannelsOnly(server?.id),
    ),
  }), [channels, server]);
  return <PendingServerLayout offline={offline} />;
}
