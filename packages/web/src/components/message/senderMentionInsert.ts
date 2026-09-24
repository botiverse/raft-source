import type { MessageMention } from "../../store/messageStore";

export const SENDER_MENTION_INSERT_EVENT = "slock:sender-mention-insert";

export interface SenderMentionInsertDetail {
  channelId: string;
  mention: MessageMention;
}

export function dispatchSenderMentionInsert(detail: SenderMentionInsertDetail): void {
  window.dispatchEvent(new window.CustomEvent<SenderMentionInsertDetail>(SENDER_MENTION_INSERT_EVENT, { detail }));
}

export function getSenderMentionInsertDetail(event: Event): SenderMentionInsertDetail | null {
  if (!("detail" in event)) return null;
  const detail = event.detail as Partial<SenderMentionInsertDetail> | undefined;
  const mention = detail?.mention as Partial<MessageMention> | undefined;
  if (
    typeof detail?.channelId !== "string" ||
    (mention?.type !== "agent" && mention?.type !== "user") ||
    typeof mention.id !== "string" ||
    typeof mention.name !== "string" ||
    !mention.name.trim()
  ) {
    return null;
  }
  return {
    channelId: detail.channelId,
    mention: {
      type: mention.type,
      id: mention.id,
      name: mention.name,
    },
  };
}

export function insertMentionAtCursor(content: string, cursorPos: number, handle: string): { newContent: string; newCursor: number } {
  const safeCursor = Math.max(0, Math.min(cursorPos, content.length));
  const before = content.slice(0, safeCursor);
  const after = content.slice(safeCursor);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
  const insertion = `${needsLeadingSpace ? " " : ""}@${handle}${needsTrailingSpace ? " " : ""}`;
  return {
    newContent: `${before}${insertion}${after}`,
    newCursor: before.length + insertion.length,
  };
}
