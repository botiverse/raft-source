import type { Task } from "../../store/taskStore";

/** Whether the task's discussion is its own conversation (task v2). A DTO
 *  without the field (older server) falls back to "its source is not its
 *  host", the pre-conversation reading. */
export function hasOwnConversation(task: Task): boolean {
  if (task.conversationChannelId !== undefined) return task.conversationChannelId !== null;
  return task.sourceMessageId !== task.messageId;
}

/** The number of messages in the task's own discussion; 0 for a pre-v2 task still talking in its host message's thread. */
export function taskReplyCount(task: Task): number {
  return hasOwnConversation(task) ? task.conversationReplyCount ?? 0 : 0;
}
