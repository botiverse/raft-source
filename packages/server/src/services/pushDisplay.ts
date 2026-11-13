import {
  boundNotificationPreview,
  formatPushBody,
  formatPushServerLabel,
  formatPushSurfaceTitle,
  notificationPlainText,
} from "@botiverse/raft-shared";

/**
 * Produce notification-safe display text from message Markdown.
 *
 * This is intentionally a derived preview only: the persisted message body is
 * never rewritten. Web Push, mobile socket notifications and APNs use the
 * shared parser the desktop's local notifications use (notificationDisplay,
 * the same micromark + GFM + CJK rules the message renderer runs), so every
 * surface strips the same Markdown (task #54: `**` next to CJK punctuation).
 */
export function toNotificationPlainText(content: string): string {
  return notificationPlainText(content);
}

export function summarizePushBody(content: string, attachmentCount: number): string {
  return boundNotificationPreview(toNotificationPlainText(content), attachmentCount);
}

// The title/body format is shared with the desktop's local notification path
// (packages/shared/src/notificationDisplay.ts) so every surface reads alike.
export { formatPushBody, formatPushServerLabel, formatPushSurfaceTitle };

/** Relative app URL of a message in a channel or DM (notification click target). */
export function buildChannelUrl(serverSlug: string, channelType: "channel" | "dm", channelId: string, messageId: string) {
  const base = channelType === "dm"
    ? `/s/${serverSlug}/dm/${channelId}`
    : `/s/${serverSlug}/channel/${channelId}`;
  return `${base}?msg=${messageId}`;
}

/** Relative app URL of a message in a thread: the parent conversation with the thread panel open. */
export function buildThreadUrl(
  serverSlug: string,
  parentChannelId: string,
  parentChannelType: "channel" | "joint" | "dm",
  parentMessageId: string,
  focusedMessageId?: string,
) {
  const base = parentChannelType === "dm"
    ? `/s/${serverSlug}/dm/${parentChannelId}`
    : `/s/${serverSlug}/channel/${parentChannelId}`;
  const params = new URLSearchParams({
    thread: `${parentChannelId}:${parentMessageId}`,
  });
  if (focusedMessageId) {
    params.set("msg", focusedMessageId);
  }
  return `${base}?${params.toString()}`;
}
