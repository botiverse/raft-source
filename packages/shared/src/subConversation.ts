/**
 * Sub-conversations: a conversation that hangs off something inside a parent
 * channel instead of being a channel of its own.
 *  - `thread`: the replies under a message (`parent_message_id`);
 *  - `task`: a task's own conversation (task v2, `task_id`).
 * Both share follow / notification / unread / inbox / delivery semantics and
 * inherit visibility from the parent channel. Use this predicate wherever a
 * rule applies to both; keep `type === "thread"` only where the parent MESSAGE
 * matters (thread summaries under a message, reply counts, the thread panel).
 */
export type SubConversationType = "thread" | "task";

export function isSubConversationType(type: string | null | undefined): type is SubConversationType {
  return type === "thread" || type === "task";
}
