import { useEffect } from "react";
import { useAuthStore } from "../../store/authStore";
import { getRecentConversationScopeKey, useRecentConversationStore } from "../../store/recentConversationStore";
import { useServerStore } from "../../store/serverStore";

/**
 * Marks `channelId` as the most recently visited conversation for the current
 * server+user. Called by the channel / DM routes once the conversation has
 * resolved (pass null while unresolved so bogus ids never enter the history).
 */
export function useRecordRecentConversation(channelId: string | null | undefined): void {
  const serverId = useServerStore((s) => s.current?.id);
  const userId = useAuthStore((s) => s.user?.id);
  const recordVisit = useRecentConversationStore((s) => s.recordVisit);
  useEffect(() => {
    const scopeKey = getRecentConversationScopeKey(serverId, userId);
    if (!scopeKey || !channelId) return;
    recordVisit(scopeKey, channelId);
  }, [channelId, recordVisit, serverId, userId]);
}
