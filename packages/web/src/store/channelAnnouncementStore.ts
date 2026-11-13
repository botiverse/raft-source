/**
 * Channel announcements (#proj-chat:#29, flag channel_announcement_v0): each
 * open channel's announcement as this person sees it
 * (ChannelAnnouncementForPerson: the Artifact, its version, who made it,
 * whether they have seen it and the first line of its text), for the strip under the channel header and the
 * Announcement row in channel details.
 *
 * Its own slice, not the channel row: GET /channels (the list) doesn't carry
 * it and a list reload or a `channel:updated` row replaces the row, and a new
 * version changes the announcement without changing any channel row. Read
 * from GET /channels/:id/announcement; written back from the answer of
 * PATCH /channels/:id (set, replace, remove). useChannelAnnouncement says when
 * to read it again.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY, channelTypeSupportsAnnouncement } from "@botiverse/raft-shared";
import type { ChannelAnnouncementForPerson } from "@botiverse/raft-shared";

import api from "../api/client";
import { subscribeObjectSummaryInvalidation } from "../objects/objectSummaryLoader";
import { useChannelStore } from "./channelStore";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import { useServerFeatureFlag } from "./serverFeatureFlags";
import { findStoredChannel } from "./storedChannel";

interface ChannelAnnouncementState {
  /** By channel id: the announcement, null for none; absent until read. */
  byChannel: Readonly<Record<string, ChannelAnnouncementForPerson | null>>;
}

export const useChannelAnnouncementStore = create<ChannelAnnouncementState>(() => ({ byChannel: {} }));

/** Every answer older than the latest write or read of its channel is dropped (a read slower than a set). */
const generations = new Map<string, number>();
const nextGeneration = (channelId: string) => {
  const next = (generations.get(channelId) ?? 0) + 1;
  generations.set(channelId, next);
  return next;
};

function put(channelId: string, announcement: ChannelAnnouncementForPerson | null): void {
  useChannelAnnouncementStore.setState((state) => ({ byChannel: { ...state.byChannel, [channelId]: announcement } }));
}

/** Applies an answer when it is still the newest for its channel and the server hasn't changed since it was asked. */
function applier(channelId: string) {
  const generation = nextGeneration(channelId);
  const epoch = useServerStore.getState().serverEpoch;
  return (announcement: ChannelAnnouncementForPerson | null | undefined) => {
    if (generations.get(channelId) !== generation || useServerStore.getState().serverEpoch !== epoch) return;
    put(channelId, announcement ?? null);
  };
}

const inFlight = new Map<string, Promise<void>>();

/** Reads the channel's announcement (one request at a time per channel). A failure keeps what is shown. */
export function loadChannelAnnouncement(channelId: string): Promise<void> {
  const pending = inFlight.get(channelId);
  if (pending) return pending;
  const apply = applier(channelId);
  const request = api.get(`/channels/${channelId}/announcement`)
    .then(({ data }) => apply((data as { announcement?: ChannelAnnouncementForPerson | null }).announcement), () => {})
    .finally(() => inFlight.delete(channelId));
  inFlight.set(channelId, request);
  return request;
}

/**
 * Sets (`artifactId`), replaces or removes (null) the channel's announcement
 * through the channel's own update (PATCH /channels/:id, editChannelMetadata),
 * which also patches the channel row. Throws the server's refusal.
 */
export async function setChannelAnnouncement(channelId: string, artifactId: string | null): Promise<void> {
  const apply = applier(channelId);
  const updated = await useChannelStore.getState().updateChannel(channelId, { announcement: artifactId });
  apply((updated as { announcement?: ChannelAnnouncementForPerson | null }).announcement);
}

/** How often an open channel reads its announcement again while the page is visible (a new version changes no channel row). */
export const CHANNEL_ANNOUNCEMENT_POLL_MS = 60_000;

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * The announcement of a channel while it is shown (`channelId` null: none
 * shown), as the store has it: null for none, undefined until first read and
 * always where the flag is off or the channel can't have one (a DM, a
 * thread), so nothing about announcements shows there. Read when the channel
 * opens, and again:
 * - when its channel row changes (`channel:updated`, a sync-changes refresh,
 *   our own update: setting, replacing or removing it changes the row);
 * - when its Artifact's summaries are invalidated: opening it in the viewer
 *   (now seen), `activity:changed` for its server (a new version, for those
 *   who follow it);
 * - every CHANNEL_ANNOUNCEMENT_POLL_MS while the page is visible, and when it
 *   becomes visible again (a new version reaches those who don't follow it).
 */
export function useChannelAnnouncement(channelId: string | null, channelType: string | null | undefined): ChannelAnnouncementForPerson | null | undefined {
  const flag = useServerFeatureFlag(CHANNEL_ANNOUNCEMENT_FEATURE_FLAG_KEY);
  const enabled = flag.enabled && channelId !== null && channelTypeSupportsAnnouncement(channelType);
  const announcement = useChannelAnnouncementStore((state) => (channelId ? state.byChannel[channelId] : undefined));
  const row = useChannelStore((state) => (enabled && channelId ? findStoredChannel(state, channelId) ?? null : null));
  const artifactId = announcement?.artifactId ?? null;

  useEffect(() => {
    if (!enabled || !channelId) return;
    void loadChannelAnnouncement(channelId);
  }, [enabled, channelId, row]);

  useEffect(() => {
    if (!enabled || !channelId) return;
    const read = () => {
      if (!pageHidden()) void loadChannelAnnouncement(channelId);
    };
    const unsubscribe = subscribeObjectSummaryInvalidation((change) => {
      if (change.kind !== undefined && change.kind !== "artifact") return;
      if (change.id !== undefined && change.id !== artifactId) return;
      const current = useServerStore.getState().current?.id ?? null;
      if (change.serverId != null && change.serverId !== current) return;
      read();
    });
    const timer = setInterval(read, CHANNEL_ANNOUNCEMENT_POLL_MS);
    const onVisibility = () => read();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, channelId, artifactId]);

  if (!enabled) return undefined;
  return announcement;
}

/** A new server: nothing of the last one's channels is kept. */
export function resetChannelAnnouncements(): void {
  generations.clear();
  inFlight.clear();
  useChannelAnnouncementStore.setState({ byChannel: {} });
}

registerServerReset(resetChannelAnnouncements);
