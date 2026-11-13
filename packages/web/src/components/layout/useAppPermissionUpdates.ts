import { useEffect, useSyncExternalStore } from "react";
import api from "../../api/client";
import { createVisiblePoll, PINGED_LIST_SAFETY_POLL_MS } from "../../utils/visiblePoll";

const CHANGE_EVENT = "raft:app-permission-updates-changed";

export function notifyAppPermissionUpdatesChanged(serverId: string | undefined): void {
  if (serverId && typeof window !== "undefined") {
    window.dispatchEvent(new window.CustomEvent(CHANGE_EVENT, { detail: { serverId } }));
  }
}

export interface AppPermissionUpdatesSummary {
  /** Installed Apps with added permissions waiting for approval (the Bell's notice). */
  count: number;
  /**
   * Something on the Apps page waits for an owner or admin: a permission
   * update, or agent prompt text to confirm (#proj-apps task #24). Server
   * computed, so it clears when that is handled, not when the page is opened.
   */
  needsAdminReview: boolean;
}

const NOTHING_WAITING: AppPermissionUpdatesSummary = { count: 0, needsAdminReview: false };

// One poller per tab and Server/user, shared by every consumer (the Bell's
// notice, the Apps page dot): retained while any of them is mounted, one
// request in flight, one result (as feedback/feedbackUnreadState.ts does).
type PollEntry = {
  serverId: string;
  consumers: number;
  summary: AppPermissionUpdatesSummary | null;
  inFlight: boolean;
  /** A change arrived while a read was in flight: read again after it. */
  again: boolean;
  stop: () => void;
};

const entries = new Map<string, PollEntry>();
const listeners = new Set<() => void>();

function entryKey(serverId: string, userId: string): string {
  return `${serverId}\u0000${userId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function refresh(key: string, entry: PollEntry): Promise<void> {
  if (entry.inFlight) {
    entry.again = true;
    return;
  }
  entry.inFlight = true;
  let summary: AppPermissionUpdatesSummary | null = null;
  try {
    const { data } = await api.get<{ count: number; needsAdminReview?: boolean }>("/integrations/permission-updates", {
      headers: { "X-Server-Id": entry.serverId },
    });
    summary = Number.isSafeInteger(data?.count) && data.count >= 0
      ? { count: data.count, needsAdminReview: data.needsAdminReview === true }
      : null;
  } catch {
    summary = null;
  } finally {
    entry.inFlight = false;
  }
  // Released meanwhile (Server or user switched, permission lost): drop it.
  if (entries.get(key) !== entry) return;
  if (entry.again) {
    entry.again = false;
    void refresh(key, entry);
    return;
  }
  entry.summary = summary;
  emit();
}

function retain(serverId: string, userId: string): () => void {
  const key = entryKey(serverId, userId);
  let entry = entries.get(key);
  if (!entry) {
    const created: PollEntry = { serverId, consumers: 0, summary: null, inFlight: false, again: false, stop: () => undefined };
    entries.set(key, created);
    // Reads on the permission-updates:changed ping (CHANGE_EVENT); the poll
    // is only the safety poll, paused while hidden, one read when shown
    // again. The first read and the ping's (a reconnect's too) wait for show.
    const poll = createVisiblePoll(() => void refresh(key, created), { intervalMs: PINGED_LIST_SAFETY_POLL_MS });
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ serverId: string }>).detail?.serverId === serverId) poll.request();
    };
    window.addEventListener(CHANGE_EVENT, onChanged);
    created.stop = () => {
      poll.stop();
      window.removeEventListener(CHANGE_EVENT, onChanged);
    };
    entry = created;
    poll.request();
  }
  entry.consumers += 1;
  const retained = entry;
  return () => {
    retained.consumers -= 1;
    if (retained.consumers > 0 || entries.get(key) !== retained) return;
    retained.stop();
    entries.delete(key);
    emit();
  };
}

/**
 * GET /integrations/permission-updates, scoped to an App manager (anyone else
 * reads nothing waiting): on mount, on the server's permission-updates:changed
 * ping, once after a reconnect, and the 5-minute safety poll while visible;
 * none while the page is hidden (one read when it shows again).
 */
export function useAppPermissionUpdatesSummary(serverId: string | null, userId: string | null, canManage: boolean): AppPermissionUpdatesSummary {
  const key = serverId && userId && canManage ? entryKey(serverId, userId) : null;
  useEffect(() => {
    if (!serverId || !userId || !canManage || typeof window === "undefined") return;
    return retain(serverId, userId);
  }, [canManage, serverId, userId]);
  const summary = useSyncExternalStore(
    subscribe,
    () => (key ? entries.get(key)?.summary ?? null : null),
    () => null,
  );
  return summary ?? NOTHING_WAITING;
}

/** The permission-update count alone (the Bell's notice). */
export function useAppPermissionUpdates(serverId: string | null, userId: string | null, canManage: boolean): number {
  return useAppPermissionUpdatesSummary(serverId, userId, canManage).count;
}
