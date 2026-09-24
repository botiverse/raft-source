export type AttachmentDownloadHintStyle = "slock_cli" | "mcp_tool";

type FormattableAttachment = {
  id: string;
  filename: string;
};

export function attachmentDownloadHint(style: AttachmentDownloadHintStyle = "slock_cli"): string {
  switch (style) {
    case "slock_cli":
      return "use `raft attachment view --id <attachmentId> --output <path>` to download";
    case "mcp_tool":
      return "use view_file to download";
  }
}

export function formatAttachmentSuffix(
  attachments: FormattableAttachment[] | undefined,
  style: AttachmentDownloadHintStyle = "slock_cli",
): string {
  if (!attachments?.length) return "";
  const attachmentList = attachments
    .map((attachment) => `${attachment.filename} (id:${attachment.id})`)
    .join(", ");
  return ` [${attachments.length} attachment${attachments.length > 1 ? "s" : ""}: ${attachmentList} — ${attachmentDownloadHint(style)}]`;
}
