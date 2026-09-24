export const SLACK_BRIDGE_ATTACHMENT_NOT_SYNCED_MARKER = "[Attachment not synced]" as const;

export function appendSlackBridgeAttachmentMarker(content: string | null): string {
  return content && content.trim().length > 0
    ? `${content}\n\n${SLACK_BRIDGE_ATTACHMENT_NOT_SYNCED_MARKER}`
    : SLACK_BRIDGE_ATTACHMENT_NOT_SYNCED_MARKER;
}
