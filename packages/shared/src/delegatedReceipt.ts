// RFC 077: the receipt Raft posts in an owner's DM with their assistant for
// every message the assistant sent as them. Web and server match on this kind.

/** `actionMetadata.kind` of a delegated-send receipt (the stored spelling; never rename it). */
export const DELEGATED_RECEIPT_KIND = "delegated-receipt";

export interface DelegatedReceiptMetadata {
  kind: typeof DELEGATED_RECEIPT_KIND;
  /**
   * The message sent (a forward receipt: its first line). Absent only on a
   * forward receipt with no line at all, which then names the channels in
   * `joinedNotForwarded`.
   */
  delegatedReceipt?: DelegatedReceiptEntry;
  /**
   * A forward receipt (forwardAsOwner, one per request): a line per
   * destination, each retractable on its own. `delegatedReceipt` repeats the
   * first line for clients that read only that. Absent on a single send.
   */
  delegatedReceipts?: DelegatedReceiptEntry[];
  /** Public channels the assistant joined for its owner to forward there; the owner can leave them. */
  joinedChannels?: Array<{ channelId: string; name: string }>;
  /**
   * Public channels the assistant joined for its owner where the forward then
   * did not go through: the owner is told, so they can leave them.
   */
  joinedNotForwarded?: Array<{ channelId: string; name: string }>;
}

/** One message an assistant sent as its owner, as its receipt names it. */
export interface DelegatedReceiptEntry {
  messageId: string;
  /** Where the message is: its own conversation (a thread's own channel id for a reply in a thread). */
  channelId: string;
  /** When the owner retracted it; not authoritative for older receipts (use `retractable`). */
  deletedAt: string | null;
  // Card fields; absent on receipts written before them.
  /** The conversation as the owner names it: `#channel` or `dm:@peer` (a thread: its parent's). */
  conversationRef?: string;
  /** `channel` / `private` / `joint` / `dm` of the conversation (a thread: its parent's). */
  conversationType?: string;
  /** In a thread: the parent conversation and the message the thread hangs off. */
  parentChannelId?: string | null;
  parentMessageId?: string | null;
  /** The message's first line, plain text, at most 80 characters. */
  preview?: string;
  /** When it was sent (ISO). */
  sentAt?: string;
  /**
   * Computed by the server when it serves the receipt, from the sent
   * message's actual state: false once retracted or deleted, or when the
   * viewer can no longer see where it went. The Retract button follows only this.
   */
  retractable?: boolean;
}
