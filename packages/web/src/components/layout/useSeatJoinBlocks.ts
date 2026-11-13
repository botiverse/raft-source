import { useCallback, useEffect, useState } from "react";
import type { SeatJoinBlocksResponse } from "@botiverse/raft-shared";
import api from "../../api/client";
import { PRO_SEAT_ADD_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { createVisiblePoll, PINGED_LIST_SAFETY_POLL_MS } from "../../utils/visiblePoll";

const CHANGE_EVENT = "raft:seat-join-blocks-changed";

/** Seats were added, or an owner was asked: read the list again now rather than at the next poll. */
export function notifySeatJoinBlocksChanged(serverId: string | undefined): void {
  if (serverId && typeof window !== "undefined") {
    window.dispatchEvent(new window.CustomEvent(CHANGE_EVENT, { detail: { serverId } }));
  }
}

/**
 * People a full invite or join link turned away from the current server
 * (task #10, behind pro_seat_add), for the notification center: the server
 * lists them for owners, admins and the link's creator, and only while the
 * seats are still full, with the seats (for a viewer who can't read billing).
 * Read on mount, on the seat-join-blocks:changed ping (a notice recorded or
 * ended, a seat taken or freed by a member), when pro_seat_add changes, once
 * after a reconnect, and the 5-minute safety poll while visible. None of them
 * reads while the page is hidden: one read when it shows again.
 */
export function useSeatJoinBlocks(): SeatJoinBlocksResponse {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const role = useServerStore((state) => state.current?.role ?? null);
  const gate = useServerFeatureFlag(PRO_SEAT_ADD_FEATURE_FLAG_KEY);
  const asks = Boolean(serverId) && gate.enabled && role !== null && role !== "guest";
  const [snapshot, setSnapshot] = useState<{ serverId: string; response: SeatJoinBlocksResponse } | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId || !asks) {
      setSnapshot(null);
      return;
    }
    try {
      const { data } = await api.get<SeatJoinBlocksResponse>(`/servers/${serverId}/seat-join-blocks`);
      // Drop a response that lands after the user switched servers.
      if (useServerStore.getState().current?.id !== serverId) return;
      setSnapshot({
        serverId,
        response: Array.isArray(data?.blocks) && data.blocks.length > 0 ? { blocks: data.blocks, ...(data.usage ? { usage: data.usage } : {}) } : NO_BLOCKS,
      });
    } catch {
      // Keep the last known list; the next ping or poll tries again.
    }
  }, [asks, serverId]);

  useEffect(() => {
    if (!serverId || !asks || typeof window === "undefined") {
      void refresh();
      return;
    }
    // The safety poll (an agent taking or freeing a seat), paused while
    // hidden; the mount read and the ping's (a reconnect's too) wait for show.
    const poll = createVisiblePoll(() => void refresh(), { intervalMs: PINGED_LIST_SAFETY_POLL_MS });
    poll.request();
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ serverId: string }>).detail?.serverId === serverId) poll.request();
    };
    window.addEventListener(CHANGE_EVENT, onChanged);
    return () => {
      poll.stop();
      window.removeEventListener(CHANGE_EVENT, onChanged);
    };
  }, [asks, refresh, serverId]);

  return asks && snapshot?.serverId === serverId ? snapshot.response : NO_BLOCKS;
}

const NO_BLOCKS: SeatJoinBlocksResponse = { blocks: [] };
