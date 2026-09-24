import api from "../../api/client";
import type { MessageAttachment } from "../../store/messageStore";

/**
 * Shared attachment download. Extracted from MessageItem so preview surfaces
 * that are no longer owned by a message (the app-level preview host, the
 * forward composer) can fall back to a download without each re-implementing
 * the same anchor dance.
 */
export async function downloadAttachmentById(attachment: MessageAttachment): Promise<void> {
  try {
    const { data } = await api.get<{ url: string }>(`/attachments/${attachment.id}/url?disposition=attachment`);
    const link = document.createElement("a");
    link.href = data.url;
    link.download = attachment.filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch {
    // noop: keep the attachment card interactive for retry
  }
}
