// Canonical attachment reply formatting for agent-facing output. The text lives
// in `@botiverse/raft-shared` (`agentText/attachments.ts`) so the SDK renders the
// same bytes; this file keeps the axSurface registrations and their examples.
// This is an AX contract, not an implementation detail.

import { axSurface } from "../../core/renderer";
import type {
  AgentAttachmentCommentRow,
  AgentAttachmentUploadedLike,
} from "@botiverse/raft-shared";
import {
  formatAgentAttachmentComments,
  formatAgentAttachmentDownloaded,
  formatAgentAttachmentUploaded,
} from "@botiverse/raft-shared/src/agentCliSurface";

export type AttachmentUploadedLike = AgentAttachmentUploadedLike;
export type CommentRow = AgentAttachmentCommentRow;

export const formatAttachmentUploaded = axSurface(
  "Upload receipt with attachment id and send-usage hint (the task reply for a task ref).",
  (attachment: AttachmentUploadedLike, target?: string): string => formatAgentAttachmentUploaded(attachment, "cli", target),
  {
    examples: [
      { args: [{ id: "aaaa1111-0000-0000-0000-000000000000", filename: "spec.md", sizeBytes: 12595 }] },
      { title: "uploaded to a task ref", args: [{ id: "aaaa1111-0000-0000-0000-000000000000", filename: "spec.md", sizeBytes: 12595 }, "#proj-launch:#2"] },
    ],
  },
);

export const formatAttachmentDownloaded = axSurface(
  "Download destination line.",
  (output: string): string => formatAgentAttachmentDownloaded(output),
  {
    examples: [{ args: ["/tmp/out/spec.md"] }],
  },
);

export const formatAttachmentComments = axSurface(
  "Attachment-scoped comment list incl. anchors/reactions, or its empty state.",
  (attachmentId: string, comments: readonly CommentRow[], threadChannelId: string | null | undefined): string =>
    formatAgentAttachmentComments(attachmentId, comments, threadChannelId),
  {
    examples: [{ title: "list with anchors", args: ["aaaa1111-0000-0000-0000-000000000000", [{ id: "bbbb2222-0000-0000-0000-000000000000", senderType: "user", senderName: "richard", content: "looks good", createdAt: "2026-08-31T08:00:00.000Z", reactions: [{ emoji: "✅", reactorType: "user", reactorId: "u1" }], anchor: { type: "lines", data: { start: 12, end: 18 } } }], "thread-chan-1"] }, { title: "empty state", args: ["aaaa1111-0000-0000-0000-000000000000", [], null] }],
  },
);
