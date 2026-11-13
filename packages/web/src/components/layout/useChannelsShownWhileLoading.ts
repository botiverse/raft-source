import { useMemo } from "react";
import { useAuthStore } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import { useChannelStore } from "../../store/channelStore";
import { channelsTable, useLocalTableFreshness, useLocalTableRows } from "../../store/localTables";
import { useServerStore } from "../../store/serverStore";
import { accessTokenSubject } from "../../utils/hostAccessTokenSync";

/**
 * While the current server's channel list loads, the list kept on the device
 * from the last visit (store/localTables, docs/frontend/local-tables.md), so
 * the sidebar shows its rows instead of a skeleton. Shown only: nothing reads
 * it to decide anything, and it gives way as soon as GET /channels answers.
 * Null when there is nothing to show (no device list, already loaded).
 */
export function useChannelsShownWhileLoading(): readonly Channel[] | null {
  const loading = useChannelStore((s) => s.loading);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const userId = useAuthStore((s) => s.user?.id ?? accessTokenSubject(s.accessToken));
  const scope = useMemo(
    () => (loading && serverId && userId ? { userId, serverId } : null),
    [loading, serverId, userId],
  );
  const rows = useLocalTableRows(channelsTable, scope);
  const freshness = useLocalTableFreshness(channelsTable, scope);
  return scope && freshness === "local" && rows.length > 0 ? rows : null;
}
