/**
 * Where Activity shows its list and the opened conversation side by side:
 * every desktop width, the same 768px the rest of the shell switches at
 * (stdrc). Where that is tight the list column gives way to its minimum and
 * collapses like the chat sidebar (MainLayout). Below it, on a phone, an opened
 * conversation is a page pushed inside Activity, with a Back to the list.
 *
 * A leaf module: MainLayout reads the threshold without loading the lazy
 * ThreadsInbox chunk.
 */
export const ACTIVITY_MASTER_DETAIL_QUERY = "(min-width: 768px)";

export function isActivityMasterDetailViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(ACTIVITY_MASTER_DETAIL_QUERY).matches;
}
