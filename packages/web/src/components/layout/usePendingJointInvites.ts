import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { useServerStore } from "../../store/serverStore";
import { createVisiblePoll, PINGED_LIST_SAFETY_POLL_MS } from "../../utils/visiblePoll";

const CHANGE_EVENT = "raft:joint-invites-changed";

/** The invites to this user on `serverId` changed (the joint-invites:changed ping): read them again now. */
export function notifyPendingJointInvitesChanged(serverId: string | undefined): void {
  if (serverId && typeof window !== "undefined") {
    window.dispatchEvent(new window.CustomEvent(CHANGE_EVENT, { detail: { serverId } }));
  }
}

/** One row of `GET /channels/joint-invites`: invites to the current server
 *  addressed to the current user. */
export interface PendingJointInvite {
  id: string;
  fromServerName: string;
  fromServerSlug: string;
  channelName: string;
  expiresAt: string;
}

/**
 * RFC 075 §4.5: pending joint invites for the current user on the current
 * server, so they can be accepted in-app instead of only from the email link.
 * Only owners/admins can be invited (and accept), so nobody else reads. Read
 * on mount, on the joint-invites:changed ping, once after a reconnect, and the
 * 5-minute safety poll while visible. None of them reads while the page is
 * hidden: one read when it shows again.
 */
export function usePendingJointInvites(): {
  invites: PendingJointInvite[];
  refresh: () => Promise<void>;
} {
  const serverId = useServerStore((state) => state.current?.id ?? null);
  const role = useServerStore((state) => state.current?.role ?? null);
  const canBeInvited = role === "owner" || role === "admin";
  // Tagged with its server: after a switch (also one while hidden, whose
  // read waits for show) the old server's list is never shown for the new one.
  const [snapshot, setSnapshot] = useState<{ serverId: string; invites: PendingJointInvite[] } | null>(null);

  const refresh = useCallback(async () => {
    if (!serverId || !canBeInvited) {
      setSnapshot(null);
      return;
    }
    try {
      const { data } = await api.get<{ invites: PendingJointInvite[] }>("/channels/joint-invites", {
        headers: { "X-Server-Id": serverId },
      });
      // Drop a response that lands after the user switched servers.
      if (useServerStore.getState().current?.id !== serverId) return;
      setSnapshot({ serverId, invites: Array.isArray(data?.invites) ? data.invites : [] });
    } catch {
      // Keep the last known list; the email link remains a fallback.
    }
  }, [canBeInvited, serverId]);

  useEffect(() => {
    if (!serverId || !canBeInvited || typeof window === "undefined") {
      void refresh();
      return;
    }
    // Reads on the joint-invites:changed ping (CHANGE_EVENT); the poll is only
    // the safety poll (an invite expiring), paused while hidden. The mount
    // read and the ping's (a reconnect's too) wait for show.
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
  }, [canBeInvited, refresh, serverId]);

  return { invites: canBeInvited && snapshot?.serverId === serverId ? snapshot.invites : NO_INVITES, refresh };
}

const NO_INVITES: PendingJointInvite[] = [];
