import { PANEL_TITLE_TRIGGER_EXTRA_WIDTH } from "@botiverse/raft-ui/wip";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import { onDraftsForgotten } from "../../store/appLocalDrafts";
import { useServerStore } from "../../store/serverStore";
import { useSignedInPersonId } from "../../store/signedInPerson";
import {
  forgetRecentArtifacts,
  isRecentTitleTrigger,
  NO_RECENT_ARTIFACTS,
  readRecentArtifactsRaw,
  recentArtifactsOf,
  recentArtifactsStorageKey,
  rememberRecentArtifact,
  subscribeRecentArtifacts,
} from "./artifactRecentStore";
import type { RecentArtifact } from "./artifactRecentStore";

/**
 * The conversation whose side card the viewer is (#proj-workspace:#291): its page provides it around the card
 * (ChatPanel), so the viewer's title lists the Artifacts recently opened there (ArtifactRecentTitle). Absent
 * everywhere else (the shell's card, over a dialog, the Artifacts home): the title is plain there.
 */
export interface ArtifactConversationPlace {
  conversationId: string;
  /** The conversation as people know it ("#general", "@Niko"), for the menu's words. */
  name: string;
  /** Opens the conversation's Files card (the header's paperclip), where all its Artifacts are; absent: no such item. */
  onShowAll?: () => void;
}

export const ArtifactConversationContext = createContext<ArtifactConversationPlace | null>(null);

/** The side card's conversation and the Artifacts recently opened in it; the title is a trigger from two on. */
export function useRecentArtifactsHere() {
  const place = useContext(ArtifactConversationContext);
  const recent = useRecentArtifacts(place?.conversationId ?? null);
  return { place, ...recent, trigger: place !== null && isRecentTitleTrigger(recent.items) };
}

/** What the head's fit adds for the title being the recent Artifacts' trigger (headFit's `content`). */
export function useRecentTitleExtraWidth(): number {
  const { trigger } = useRecentArtifactsHere();
  return trigger ? PANEL_TITLE_TRIGGER_EXTRA_WIDTH : 0;
}

/** The signed-in person's recent Artifacts beside `conversationId` on the server open, and how to add one. */
function useRecentArtifacts(conversationId: string | null): {
  items: readonly RecentArtifact[];
  remember: (entry: RecentArtifact) => void;
} {
  const userId = useSignedInPersonId();
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const key = recentArtifactsStorageKey(userId, serverId, conversationId);
  // The stored text is the snapshot: equal text, the same list.
  const raw = useSyncExternalStore(subscribeRecentArtifacts, () => readRecentArtifactsRaw(key), () => null);
  const items = useMemo(() => (conversationId ? recentArtifactsOf(raw, conversationId) : NO_RECENT_ARTIFACTS), [conversationId, raw]);
  const remember = useCallback((entry: RecentArtifact) => {
    if (conversationId) rememberRecentArtifact(userId, serverId, conversationId, entry);
  }, [conversationId, serverId, userId]);
  return { items, remember };
}

// authStore forgets a person's device data through forgetDrafts (sign-out, the session's end, another person
// signing in on another tab); registered wherever the viewer loads, as besideMemory's is where it loads. The key is
// per person too, so someone else signing in never reads them even if a clear was missed.
onDraftsForgotten(forgetRecentArtifacts);
