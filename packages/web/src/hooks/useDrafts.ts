import { useEffect, useMemo } from "react";
import { useChannelStore } from "../store/channelStore";
import { useMessageStore } from "../store/messageStore";
import { useServerStore } from "../store/serverStore";
import { useTaskStore } from "../store/taskStore";
import { draftPlaceFor, ensureDraftPlaces, isConversationDraftKey, useDraftPlaceStore } from "../utils/draftPlaces";
import type { DraftPlace } from "../utils/draftPlaces";

// The Drafts sidebar row and page (#triage:#127). Typing in a composer
// changes a draft's text on every keystroke but not which drafts exist, so the
// sidebar's count follows the set of keys only (one string, the same while
// you type); the page reads the texts.

let lastDrafts: Record<string, string> | null = null;
let lastKeys = "";

/** The conversation drafts' keys, newline-joined and sorted: a value that changes only when a draft appears or goes. */
function draftKeysSignature(drafts: Record<string, string>): string {
  if (drafts === lastDrafts) return lastKeys;
  lastDrafts = drafts;
  lastKeys = Object.keys(drafts).filter(isConversationDraftKey).sort().join("\n");
  return lastKeys;
}

function useDraftKeys(): string[] {
  const signature = useMessageStore((s) => draftKeysSignature(s.drafts));
  return useMemo(() => (signature ? signature.split("\n") : []), [signature]);
}

/**
 * Every resolvable place of this server's drafts, by key, and whether every
 * key has an answer yet (a place, or none) on this server. Asks the server for
 * the ones the tab can't place, once the sidebar's lists have loaded: before
 * that (opening the app, switching servers) every channel draft would look
 * unknown and cost a request.
 */
function useDraftPlacesState(keys: string[]): { places: Map<string, DraftPlace>; settled: boolean } {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const places = useDraftPlaceStore((s) => s.places);
  // A place read from the sidebar's lists follows them (a channel joined, a task loaded).
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const listsLoading = useChannelStore((s) => s.loading);
  const tasks = useTaskStore((s) => s.tasks);
  const tasksByChannelId = useTaskStore((s) => s.tasksByChannelId);
  useEffect(() => {
    if (serverId && !listsLoading) ensureDraftPlaces(serverId, keys);
  }, [serverId, keys, listsLoading]);
  return useMemo(() => {
    const resolved = new Map<string, DraftPlace>();
    if (!serverId) return { places: resolved, settled: false };
    let settled = true;
    for (const key of keys) {
      const place = draftPlaceFor(serverId, key, places);
      if (place) resolved.set(key, place);
      else if (place === undefined) settled = false;
    }
    return { places: resolved, settled };
    // oxlint-disable-next-line react/exhaustive-deps -- channels, dmChannels and tasks are read through the stores' getState; listed so a place follows them
  }, [serverId, keys, places, channels, dmChannels, tasks, tasksByChannelId]);
}

/** How many drafts this server has, for the sidebar row. */
export function useDraftCount(): number {
  const keys = useDraftKeys();
  return useDraftPlacesState(keys).places.size;
}

export interface DraftEntry {
  key: string;
  content: string;
  /** Epoch ms; null for a draft from before times were kept. */
  updatedAt: number | null;
  place: DraftPlace;
}

/** Order: the most recently edited first; drafts with no time last, in a stable order. */
export function sortDraftEntries(entries: DraftEntry[]): DraftEntry[] {
  return [...entries].sort((a, b) => {
    if (a.updatedAt === null && b.updatedAt === null) return a.key.localeCompare(b.key);
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * This server's drafts for the page, newest first, and whether the list is final: every draft placed or
 * known to have no place here. Not yet while the sidebar's lists load or a
 * lookup is out (a cold load on /drafts), and not while a failed lookup
 * waits to be asked again.
 */
export function useDraftEntriesState(): { entries: DraftEntry[]; settled: boolean } {
  const keys = useDraftKeys();
  const { places, settled } = useDraftPlacesState(keys);
  const drafts = useMessageStore((s) => s.drafts);
  const times = useMessageStore((s) => s.draftUpdatedAt);
  return useMemo(() => {
    const entries: DraftEntry[] = [];
    for (const [key, place] of places) {
      const content = drafts[key];
      if (!content?.trim()) continue;
      entries.push({ key, content, updatedAt: times[key] ?? null, place });
    }
    return { entries: sortDraftEntries(entries), settled };
  }, [drafts, places, settled, times]);
}
