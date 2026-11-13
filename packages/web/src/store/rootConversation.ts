/**
 * The conversation a server's root URL (`/s/<slug>`) last landed on, per
 * person and server, kept on this device (docs/frontend/boot-requests.md,
 * "The root URL"). MainLayout's DefaultRoute writes it when it redirects to
 * the first channel; the next boot on the root asks for that conversation
 * early, as a conversation link would (the boot script's prefetch,
 * preloadServerRoute). It is a guess only: the redirect still waits for the
 * server's channel list, and a guess the list doesn't land on is never shown.
 */

/** The boot script reads it too (bootInlineScript BOOT_ROOT_CONVERSATION_PREFIX; a test compares). */
export const ROOT_CONVERSATION_STORAGE_PREFIX = "raft:root-conversation:v1:";

/** Only the root's redirect, so only where it runs: DefaultRoute redirects at this width (a phone shows its Home). */
export const ROOT_REDIRECT_MEDIA_QUERY = "(min-width: 768px)";

const CONVERSATION_ID = /^[0-9A-Za-z_-]+$/;

function storageKey(userId: string, serverId: string): string {
  return `${ROOT_CONVERSATION_STORAGE_PREFIX}${userId}:${serverId}`;
}

/** Where a server's root just landed, for the signed-in person (nothing without both). */
export function rememberRootConversation(userId: string | undefined, serverId: string | undefined, conversationId: string): void {
  if (!userId || !serverId || !CONVERSATION_ID.test(conversationId)) return;
  try {
    localStorage.setItem(storageKey(userId, serverId), conversationId);
  } catch {
    // Storage full or blocked: the next root boot asks after the list, as before.
  }
}

/** The remembered conversation, when the root here would redirect to one; null otherwise. */
export function recallRootConversation(userId: string, serverId: string): string | null {
  try {
    if (typeof window.matchMedia !== "function" || !window.matchMedia(ROOT_REDIRECT_MEDIA_QUERY).matches) return null;
    const value = localStorage.getItem(storageKey(userId, serverId));
    return value && CONVERSATION_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}
