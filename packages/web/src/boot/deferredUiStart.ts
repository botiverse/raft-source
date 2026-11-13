import { selectChannelFirstPageSettled } from "../hooks/useChannelFirstPageSettled";
import { useMessageStore } from "../store/messageStore";
import { fetchDeferredUi } from "./deferredUi";

const DEFERRED_UI_FALLBACK_MS = 10_000;

/**
 * Every app entry (main.tsx, and Raft Desktop's, which mounts the same App):
 * once the first conversation's first page is in, fetch the UI kept out of
 * the first download in idle time (boot/deferredUi: the dialogs, and the
 * detail panels the workspace opens first, so their first open does not wait
 * on a download). A load that shows no conversation fetches it after a while
 * anyway. `onContent` runs at the content milestone.
 */
export function fetchDeferredUiAfterFirstScreen(onContent?: () => void): void {
  const stop = useMessageStore.subscribe((state) => {
    if (!selectChannelFirstPageSettled(state, state.currentChannelId)) return;
    stop();
    onContent?.();
    fetchDeferredUi();
  });
  setTimeout(fetchDeferredUi, DEFERRED_UI_FALLBACK_MS);
}
