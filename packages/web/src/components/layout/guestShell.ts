import { useLocation } from "react-router-dom";

import { useArtifactViewerStore, useWorkspaceArtifactsEnabled } from "../../apps/artifacts";
import { CHAT_TAB_QUERY_PARAM } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useChannelSideCardStore } from "../../store/channelSideCardStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useServerStore } from "../../store/serverStore";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { isGuestHomePath } from "./shellRouteLayout";

/** Whether the caller is a Guest of the current Server. */
export function useIsGuest(): boolean {
  return useServerPermissions().role === "guest";
}

function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null; // a malformed `%` escape names no channel
  }
}

/**
 * Whether the caller is a Guest and, on a phone, whether something ChatPanel lays over a Guest's Home channel
 * with the header's Back to close it is open: Task v2's Tasks / Files cards
 * (remembered across visits, or an old `?chatTab=` link) or an Artifact
 * opened in that channel. Such a layer is pushed (Back XOR tab bar), so it
 * covers the tab bar.
 */
export function useGuestHome(pathBase: string | null): { guest: boolean; overlayOpen: boolean } {
  const location = useLocation();
  const guest = useIsGuest();
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const sideCardOpen = useChannelSideCardStore((s) => s.open.tasks || s.open.files);
  const artifactsEnabled = useWorkspaceArtifactsEnabled();
  const artifactConversationId = useArtifactViewerStore((s) => s.open?.conversationId ?? null);
  if (!guest || !pathBase || !isGuestHomePath(location.pathname, pathBase)) return { guest, overlayOpen: false };
  const trimmedPath = location.pathname.replace(/\/+$/, "");
  const channelId = decodedSegment(trimmedPath.slice(`${pathBase}/channel/`.length));
  const chatTab = new URLSearchParams(location.search).get(CHAT_TAB_QUERY_PARAM);
  const cardOpen = taskV2 && (sideCardOpen || chatTab === "tasks" || chatTab === "files");
  const artifactOpen = artifactsEnabled && channelId !== null && artifactConversationId === channelId;
  return { guest, overlayOpen: cardOpen || artifactOpen };
}

/**
 * Where a Guest on a conversation it can't read goes, or null: a Guest reads
 * only the conversations in its lists (the server filters them), so once they
 * have loaded, any other id sends it to the server's root.
 */
export function useGuestUnreadableRedirect(kind: "channel" | "dm", id: string | undefined): string | null {
  const guest = useIsGuest();
  const slug = useServerStore((s) => s.current?.slug);
  const listsLoading = useChannelStore((s) => (kind === "channel" ? s.loading : s.dmsLoading));
  const readable = useChannelStore((s) => !id || findStoredChannel(s, id) !== undefined);
  return guest && slug && !listsLoading && !readable ? `/s/${slug}` : null;
}
