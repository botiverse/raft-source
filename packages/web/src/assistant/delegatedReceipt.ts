import { DELEGATED_RECEIPT_KIND } from "@botiverse/raft-shared";
import type { Message } from "../store/messageStore";

// RFC 077: a delegated receipt's lines, read from the receipt message's
// `actionMetadata` (the shared `DelegatedReceiptMetadata`). Rendered by
// DelegatedReceiptCard (one line) and DelegatedReceiptLines (every line).

export type DelegatedReceipt = {
  messageId: string;
  channelId: string;
  deletedAt: string | null;
  retractable: boolean;
  /** `#channel` or `dm:@peer` (a thread: its parent's). */
  conversationRef: string | null;
  conversationType: string | null;
  parentChannelId: string | null;
  parentMessageId: string | null;
  preview: string | null;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function receiptEntryOf(raw: Record<string, unknown> | null | undefined): DelegatedReceipt | null {
  if (!raw || typeof raw.messageId !== "string" || typeof raw.channelId !== "string") return null;
  return {
    messageId: raw.messageId,
    channelId: raw.channelId,
    deletedAt: optionalString(raw.deletedAt),
    retractable: raw.retractable === true,
    conversationRef: optionalString(raw.conversationRef),
    conversationType: optionalString(raw.conversationType),
    parentChannelId: optionalString(raw.parentChannelId),
    parentMessageId: optionalString(raw.parentMessageId),
    preview: optionalString(raw.preview),
  };
}

/** The receipt on a system message, or null when it isn't one. */
export function delegatedReceiptOf(metadata: Message["actionMetadata"]): DelegatedReceipt | null {
  if (!metadata || metadata.kind !== DELEGATED_RECEIPT_KIND) return null;
  return receiptEntryOf((metadata as { delegatedReceipt?: Record<string, unknown> | null }).delegatedReceipt);
}

/**
 * Every line of a receipt: a forward receipt (one per forward request) has a
 * line per destination in `delegatedReceipts`, each retractable on its own; a
 * single send has just `delegatedReceipt`.
 */
export function delegatedReceiptsOf(metadata: Message["actionMetadata"]): DelegatedReceipt[] {
  if (!metadata || metadata.kind !== DELEGATED_RECEIPT_KIND) return [];
  const lines = (metadata as { delegatedReceipts?: unknown }).delegatedReceipts;
  if (Array.isArray(lines)) {
    return lines.flatMap((line) => {
      const entry = receiptEntryOf(line as Record<string, unknown>);
      return entry ? [entry] : [];
    });
  }
  const single = delegatedReceiptOf(metadata);
  return single ? [single] : [];
}

function channelListOf(metadata: Message["actionMetadata"], key: "joinedChannels" | "joinedNotForwarded"): Array<{ channelId: string; name: string }> {
  if (!metadata || metadata.kind !== DELEGATED_RECEIPT_KIND) return [];
  const list = (metadata as Record<string, unknown>)[key];
  return Array.isArray(list)
    ? list.filter((channel): channel is { channelId: string; name: string } =>
      !!channel && typeof channel.channelId === "string" && typeof channel.name === "string")
    : [];
}

/** The public channels the assistant joined for its owner to forward there. */
export function joinedChannelsOf(metadata: Message["actionMetadata"]): Array<{ channelId: string; name: string }> {
  return channelListOf(metadata, "joinedChannels");
}

/** The public channels the assistant joined for its owner where the forward then did not go through. */
export function joinedNotForwardedOf(metadata: Message["actionMetadata"]): Array<{ channelId: string; name: string }> {
  return channelListOf(metadata, "joinedNotForwarded");
}
