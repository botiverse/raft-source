/**
 * Row shapes of the sidebar unread reader (rw_conversation_unread_v4, see
 * infra/risingwave/sql/078-task-conversations.sql) and its test seam.
 *
 * This module is deliberately tiny and dependency-free so the server test setup
 * can install the Postgres reference (src/test/conversationUnreadReference.ts)
 * without importing channelService. Production never sets the override: the
 * reader in channelService queries RisingWave, and with no RisingWave (or a
 * failed read) the request fails -- there is no second source.
 */

/** One (user, conversation) row of the sidebar unread read. */
export type ConversationUnreadRow = {
  serverId: string;
  /** The LOCAL channel id (joint storage mapping is done upstream in the chain). */
  targetId: string;
  /** "task": a task conversation (task v2), a sub-conversation like a thread. */
  kind: "channel" | "dm" | "thread" | "task";
  /** False for a mention-only row and for a public-channel `hasNew` row. */
  subscribed: boolean;
  unreadCount: number;
  mentionUnread: number;
  totalMentions: number;
  /**
   * Public-channel arm only: a non-joined public channel of the server whose
   * latest seq is past the user's cursor. Carries no count.
   */
  hasNew: boolean;
  latestSeq: string | null;
  latestMessageId: string | null;
  cursorPresent: boolean;
  lastReadSeq: string | null;
  readStateVersion: number | null;
};

export type ConversationUnreadSummaryQuery = {
  serverId: string;
  userId: string;
  /** Include the non-joined public channel `hasNew` arm (the summary does; bare counts do not). */
  includePublicNew: boolean;
};

export type SidebarUnreadTotalsQuery = {
  serverIds: string[];
  userId: string;
};

export type ConversationUnreadSource = {
  /**
   * Rows for one (user, server): every view row with unread_count > 0 or
   * total_mentions > 0, plus (when asked) the public `hasNew` rows.
   */
  summaryRows(query: ConversationUnreadSummaryQuery): Promise<ConversationUnreadRow[]>;
  /**
   * Per-server SUM(unread_count) over subscribed, non-thread rows. Servers with
   * nothing unread may be absent.
   */
  sidebarTotals(query: SidebarUnreadTotalsQuery): Promise<Array<{ serverId: string; unreadCount: number }>>;
};

let testSource: ConversationUnreadSource | null = null;

/** TEST-ONLY: replace the RisingWave read with another source (null restores RisingWave). */
export function __setConversationUnreadSourceForTests(source: ConversationUnreadSource | null): void {
  testSource = source;
}

export function getConversationUnreadSourceOverride(): ConversationUnreadSource | null {
  return testSource;
}
