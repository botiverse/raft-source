import type { AgentMessage } from "@botiverse/raft-shared";

export function bucketBytes(value: string | number | undefined | null): string {
  const bytes = typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : Math.max(0, Math.floor(value ?? 0));
  if (bytes === 0) return "0";
  if (bytes < 1024) return "<1KB";
  if (bytes < 10 * 1024) return "1KB-10KB";
  if (bytes < 100 * 1024) return "10KB-100KB";
  if (bytes < 1024 * 1024) return "100KB-1MB";
  return "1MB+";
}

function attachmentBytesBucket(bytes: number, knownCount: number): string {
  return knownCount > 0 ? bucketBytes(bytes) : "unknown";
}

export function summarizeMessageInputBytes(messages?: AgentMessage[]): Record<string, unknown> {
  if (!messages || messages.length === 0) {
    return {
      runtime_input_messages_count: 0,
      runtime_input_messages_content_bytes_bucket: "0",
      runtime_input_attachments_count: 0,
      runtime_input_image_attachments_count: 0,
      runtime_input_attachments_size_known_count: 0,
      runtime_input_attachments_bytes_bucket: "0",
      runtime_input_image_attachments_size_known_count: 0,
      runtime_input_image_attachments_bytes_bucket: "0",
      runtime_input_largest_attachment_bytes_bucket: "0",
      runtime_input_thread_context_messages_count: 0,
      runtime_input_thread_context_content_bytes_bucket: "0",
    };
  }

  let contentBytes = 0;
  let attachmentCount = 0;
  let imageAttachmentCount = 0;
  let attachmentSizeKnownCount = 0;
  let attachmentBytes = 0;
  let imageAttachmentSizeKnownCount = 0;
  let imageAttachmentBytes = 0;
  let largestAttachmentBytes = 0;
  let threadContextMessages = 0;
  let threadContextContentBytes = 0;

  for (const message of messages) {
    contentBytes += Buffer.byteLength(message.content || "", "utf8");
    for (const attachment of message.attachments || []) {
      attachmentCount++;
      if (typeof attachment.sizeBytes === "number" && Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes >= 0) {
        attachmentSizeKnownCount++;
        attachmentBytes += attachment.sizeBytes;
        largestAttachmentBytes = Math.max(largestAttachmentBytes, attachment.sizeBytes);
      }
      if (attachment.mimeType?.startsWith("image/")) {
        imageAttachmentCount++;
        if (typeof attachment.sizeBytes === "number" && Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes >= 0) {
          imageAttachmentSizeKnownCount++;
          imageAttachmentBytes += attachment.sizeBytes;
        }
      }
    }
    const joinContext = message.thread_join_context;
    if (joinContext) {
      const contextMessages = [joinContext.parent_message, ...joinContext.recent_messages];
      threadContextMessages += contextMessages.length;
      for (const contextMessage of contextMessages) {
        threadContextContentBytes += Buffer.byteLength(contextMessage.content || "", "utf8");
      }
    }
  }

  return {
    runtime_input_messages_count: messages.length,
    runtime_input_messages_content_bytes_bucket: bucketBytes(contentBytes),
    runtime_input_attachments_count: attachmentCount,
    runtime_input_image_attachments_count: imageAttachmentCount,
    runtime_input_attachments_size_known_count: attachmentSizeKnownCount,
    runtime_input_attachments_bytes_bucket: attachmentCount > 0
      ? attachmentBytesBucket(attachmentBytes, attachmentSizeKnownCount)
      : "0",
    runtime_input_image_attachments_size_known_count: imageAttachmentSizeKnownCount,
    runtime_input_image_attachments_bytes_bucket: imageAttachmentCount > 0
      ? attachmentBytesBucket(imageAttachmentBytes, imageAttachmentSizeKnownCount)
      : "0",
    runtime_input_largest_attachment_bytes_bucket: attachmentCount > 0
      ? attachmentBytesBucket(largestAttachmentBytes, attachmentSizeKnownCount)
      : "0",
    runtime_input_thread_context_messages_count: threadContextMessages,
    runtime_input_thread_context_content_bytes_bucket: bucketBytes(threadContextContentBytes),
  };
}
