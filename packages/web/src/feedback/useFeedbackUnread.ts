import { useEffect, useSyncExternalStore } from "react";
import { hasChatSurfaces } from "../embed";
import { useAuthStore } from "../store/authStore";
import { feedbackUnreadSnapshot, retainFeedbackUnread, subscribeFeedbackUnread } from "./feedbackUnreadState";

const isCurrentUser = (id: string) => useAuthStore.getState().user?.id === id;

export function useFeedbackUnread(requested = true) {
  // The rail and settings-list dots are not drawn in a host-shell embed, so the
  // unread read (and the pushed count) behind them is not started there.
  const enabled = requested && hasChatSurfaces();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  useEffect(() => enabled && userId ? retainFeedbackUnread(userId, isCurrentUser) : undefined, [enabled, userId]);
  return useSyncExternalStore(subscribeFeedbackUnread, () => enabled ? feedbackUnreadSnapshot(userId) : 0, () => 0);
}
