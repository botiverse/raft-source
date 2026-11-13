import { useCallback, useEffect, useMemo, useState } from "react";
import { SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION } from "@botiverse/raft-shared";
import type {
  ServerSystemAttentionResponse,
  UsageLimitAttentionNotification,
} from "@botiverse/raft-shared";

import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";
import { startVisiblePoll } from "../../utils/visiblePoll";

const POLL_MS = 60_000;

export interface UsageLimitAttentionState {
  notifications: UsageLimitAttentionNotification[];
  unseenCount: number;
  markSeen: (incidentId: string) => Promise<void>;
  dismiss: (incidentId: string) => Promise<void>;
}

export function useUsageLimitAttention(): UsageLimitAttentionState {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const [snapshot, setSnapshot] = useState<ServerSystemAttentionResponse | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId) {
      setSnapshot(null);
      return;
    }
    try {
      const response = await api.get<ServerSystemAttentionResponse>(
        `/servers/${serverId}/system-notifications-v2`,
      );
      if (response.data.contractVersion === SERVER_SYSTEM_ATTENTION_CONTRACT_VERSION) {
        setSnapshot(response.data);
      }
    } catch {
      // Fail closed: a stale card must never outlive an authoritative replace
      // snapshot failure by being re-derived from local Agent errors.
      setSnapshot(null);
    }
  }, [serverId]);

  useEffect(() => {
    void refresh();
    if (!serverId || typeof window === "undefined") return;
    // Paused while the page is hidden; one read when it shows again.
    return startVisiblePoll(() => void refresh(), { intervalMs: POLL_MS, refreshOnFocus: true });
  }, [refresh, serverId]);

  const markSeen = useCallback(async (incidentId: string) => {
    if (!serverId) return;
    try {
      await api.post(`/servers/${serverId}/system-notifications-v2/${incidentId}/seen`);
    } catch {
      return;
    }
    setSnapshot((current) => current ? {
      ...current,
      unseenCount: Math.max(0, current.unseenCount - (current.notifications.some(
        (notification) => notification.id === incidentId && notification.seenAt === null,
      ) ? 1 : 0)),
      notifications: current.notifications.map((notification) => notification.id === incidentId
        ? { ...notification, seenAt: notification.seenAt ?? new Date().toISOString() }
        : notification),
    } : current);
  }, [serverId]);

  const dismiss = useCallback(async (incidentId: string) => {
    if (!serverId) return;
    try {
      await api.post(`/servers/${serverId}/system-notifications-v2/${incidentId}/dismiss`);
    } catch {
      return;
    }
    setSnapshot((current) => current ? {
      ...current,
      unseenCount: Math.max(0, current.unseenCount - (current.notifications.some(
        (notification) => notification.id === incidentId && notification.seenAt === null,
      ) ? 1 : 0)),
      notifications: current.notifications.filter((notification) => notification.id !== incidentId),
    } : current);
  }, [serverId]);

  return useMemo(() => ({
    notifications: snapshot?.notifications ?? [],
    unseenCount: snapshot?.unseenCount ?? 0,
    markSeen,
    dismiss,
  }), [dismiss, markSeen, snapshot]);
}
