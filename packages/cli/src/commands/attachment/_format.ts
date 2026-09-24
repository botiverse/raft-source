// Canonical attachment reply formatting for agent-facing output.
// Strings moved verbatim from upload.ts/view.ts/comments.ts (print-seam S2);
// byte-pin tests in _format.test.ts copy the pre-move inline literals.
// This is an AX contract, not an implementation detail.

import { axSurface } from "../../core/renderer.js";

export interface AttachmentUploadedLike {
  id: string;
  filename: string;
  sizeBytes: number;
}

export const formatAttachmentUploaded = axSurface(
  "Upload receipt with attachment id and send-usage hint.",
  (attachment: AttachmentUploadedLike): string => {
  return (`File uploaded: ${attachment.filename} (${(attachment.sizeBytes / 1024).toFixed(1)}KB)\nAttachment ID: ${attachment.id}\n\nUse this ID with raft message send --attachment-id ${attachment.id} to include it in a message.\n`);
},
  {
    examples: [{ args: [{ id: "aaaa1111-0000-0000-0000-000000000000", filename: "spec.md", sizeBytes: 12595 }] }],
  },
);

export const formatAttachmentDownloaded = axSurface(
  "Download destination line.",
  (output: string): string => {
  return (`Downloaded to: ${output}\n`);
},
  {
    examples: [{ args: ["/tmp/out/spec.md"] }],
  },
);

export interface CommentRow {
  id: string;
  senderType: "user" | "agent";
  senderName: string;
  content: string;
  createdAt: string;
  reactions: Array<{ emoji: string; reactorType: string; reactorId: string }>;
  anchor: { type: string; data: Record<string, unknown> } | null;
}

// Human/agent-readable location summary mirroring the web anchor chip:
// "§ Activation", "L12–18", "rows 3–5". Anchors are the structural answer to
// "which part of the file does this comment mean" (spec §3, task #15).
function anchorSummary(anchor: NonNullable<CommentRow["anchor"]>): string {
  if (anchor.type === "md-section") {
    const title = anchor.data.headingTitle ?? anchor.data.headingId;
    return typeof title === "string" && title ? `§ ${title}` : "§ section";
  }
  if (anchor.type === "lines" || anchor.type === "csv-rows") {
    const start = Number(anchor.data.start);
    const end = Number(anchor.data.end ?? start);
    if (!Number.isFinite(start)) return anchor.type;
    const prefix = anchor.type === "lines" ? "L" : "rows ";
    return start === (Number.isFinite(end) ? end : start) ? `${prefix}${start}` : `${prefix}${start}–${end}`;
  }
  if (anchor.type === "html-region") {
    const quote = anchor.data.quote;
    if (typeof quote === "string" && quote.trim().length > 0) {
      const trimmed = quote.trim();
      return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
    }
    return "HTML region";
  }
  return anchor.type;
}

export const formatAttachmentComments = axSurface(
  "Attachment-scoped comment list incl. anchors/reactions, or its empty state.",
  (
  attachmentId: string,
  comments: readonly CommentRow[],
  threadChannelId: string | null | undefined,
): string => {
  if (comments.length === 0) {
    return (`No comments on attachment ${attachmentId.slice(0, 8)}.\n`);
  }
  const lines: string[] = [`## Comments on attachment ${attachmentId.slice(0, 8)} (${comments.length})`];
  for (const c of comments) {
    const check = c.reactions.some((r) => r.emoji === "✅") ? " ✅" : "";
    const anchor = c.anchor ? ` [anchor: ${anchorSummary(c.anchor)}]` : "";
    lines.push(`[msg=${c.id.slice(0, 8)} time=${c.createdAt} type=${c.senderType}]${check}${anchor} @${c.senderName}: ${c.content}`);
  }
  if (threadChannelId) {
    lines.push(`(full conversation lives in thread channel ${threadChannelId})`);
  }
  return (lines.join("\n") + "\n");
},
  {
    examples: [{ title: "list with anchors", args: ["aaaa1111-0000-0000-0000-000000000000", [{ id: "bbbb2222-0000-0000-0000-000000000000", senderType: "user", senderName: "richard", content: "looks good", createdAt: "2026-08-31T08:00:00.000Z", reactions: [{ emoji: "✅", reactorType: "user", reactorId: "u1" }], anchor: { type: "lines", data: { start: 12, end: 18 } } }], "thread-chan-1"] }, { title: "empty state", args: ["aaaa1111-0000-0000-0000-000000000000", [], null] }],
  },
);
