// Canonical attachment text for agent-facing output (moved verbatim from the
// CLI's commands/attachment/_format.ts; the CLI wraps these in its axSurface
// registrations and pins the bytes with its snapshot tests).

import { formatHint, RAFT_HINTS, type RaftHintStyle } from "../agentOps/hint";
import { foldAgentOneLineText, indentAgentBodyContinuationLines } from "../agentMessageText";
import { parseAgentTaskRef } from "./taskRef";

export interface AgentAttachmentUploadedLike {
  id: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Upload receipt with attachment id and send-usage hint. Uploaded to a task
 * ref (`#channel:#7`), the hint is the task reply — `raft message send`
 * refuses task refs; otherwise the message send, without a target (unchanged).
 */
export function formatAgentAttachmentUploaded(attachment: AgentAttachmentUploadedLike, style: RaftHintStyle = "cli", target?: string): string {
  const taskRef = target === undefined ? null : parseAgentTaskRef(target)?.ref ?? null;
  const head = `File uploaded: ${attachment.filename} (${(attachment.sizeBytes / 1024).toFixed(1)}KB)\nAttachment ID: ${attachment.id}\n\n`;
  if (taskRef) {
    const reply = formatHint(RAFT_HINTS.messageSend({ target: taskRef, attachmentId: attachment.id }), style);
    return `${head}Use this ID with ${reply} to include it in a reply in the task's conversation.\n`;
  }
  const send = formatHint(RAFT_HINTS.messageSend({ attachmentId: attachment.id }), style);
  return (`${head}Use this ID with ${send} to include it in a message.\n`);
}

/** Download destination line. */
export function formatAgentAttachmentDownloaded(output: string): string {
  return (`Downloaded to: ${output}\n`);
}

export interface AgentAttachmentCommentRow {
  id: string;
  senderType: "user" | "agent";
  senderName: string;
  content: string;
  createdAt: string;
  reactions: Array<{ emoji: string; reactorType: string; reactorId: string }>;
  anchor: { type: string; data: Record<string, unknown> } | null;
}

function anchorSummary(anchor: NonNullable<AgentAttachmentCommentRow["anchor"]>): string {
  if (anchor.type === "md-section") {
    const title = anchor.data.headingTitle ?? anchor.data.headingId;
    return typeof title === "string" && title ? `§ ${foldAgentOneLineText(title)}` : "§ section";
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
      const trimmed = foldAgentOneLineText(quote);
      return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
    }
    return "HTML region";
  }
  return anchor.type;
}

/** Attachment-scoped comment list incl. anchors/reactions, or its empty state. */
export function formatAgentAttachmentComments(
  attachmentId: string,
  comments: readonly AgentAttachmentCommentRow[],
  threadChannelId: string | null | undefined,
): string {
  if (comments.length === 0) {
    return (`No comments on attachment ${attachmentId.slice(0, 8)}.\n`);
  }
  const lines: string[] = [`## Comments on attachment ${attachmentId.slice(0, 8)} (${comments.length})`];
  for (const c of comments) {
    const check = c.reactions.some((r) => r.emoji === "✅") ? " ✅" : "";
    const anchor = c.anchor ? ` [anchor: ${anchorSummary(c.anchor)}]` : "";
    lines.push(`[msg=${c.id.slice(0, 8)} time=${c.createdAt} type=${c.senderType}]${check}${anchor} @${foldAgentOneLineText(c.senderName)}: ${indentAgentBodyContinuationLines(c.content)}`);
  }
  if (threadChannelId) {
    lines.push(`(full conversation lives in thread channel ${threadChannelId})`);
  }
  return (lines.join("\n") + "\n");
}
