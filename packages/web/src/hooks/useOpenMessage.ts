import { useCallback, useEffect, useRef } from "react";
import { useServerStore } from "../store/serverStore";
import { openMessagePlace, resolveMessagePlace } from "../utils/messagePlace";
import { useAppNavigate } from "./useAppNavigate";

/**
 * Open a message from only the conversation it was posted in and its id:
 * a channel or DM message in place, a thread reply in its parent channel with
 * the thread open at it, a task message in the task's own conversation. For
 * surfaces that hold no parent of their own (an agent's activity).
 */
export function useOpenMessage(): (channelId: string, messageId: string) => Promise<void> {
  const nav = useAppNavigate();
  // Only the latest click navigates, and none after the surface is gone: a
  // lookup that answers late must not pull the user away from where they went.
  const latestRef = useRef(0);
  useEffect(() => () => {
    latestRef.current += 1;
  }, []);
  return useCallback(async (channelId: string, messageId: string) => {
    const request = ++latestRef.current;
    const { serverEpoch } = useServerStore.getState();
    const place = await resolveMessagePlace(channelId, messageId);
    if (request !== latestRef.current) return;
    // The server changed while the conversation was being looked up.
    if (useServerStore.getState().serverEpoch !== serverEpoch) return;
    openMessagePlace(place, nav);
  }, [nav]);
}
