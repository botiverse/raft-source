import api from "../api/client";
import type { Task } from "../store/taskStore";
import type { OpenThreadRequest } from "../store/threadStore";
import { opensAsTaskConversation } from "./taskConversation";

/**
 * Open the task dialog for task `taskNumber` of channel `channelId` (a local
 * channel id; a joint channel's local surface resolves to the shared task on
 * the server). Shared by message refs (`task #7`, `#channel/7`) and the
 * Activity log, so every ref opens a task the same way.
 */
export interface OpenTaskRefDeps {
  closeProfile: () => void;
  closeThread: () => void;
  /** Legacy (pre-message) tasks open in their channel's Tasks tab. */
  toChannelTasks: (channelId: string) => void;
  openLegacyTask: (task: Task) => void;
  openThread: (request: OpenThreadRequest) => void | Promise<void>;
  /** Task v2: the task dialog keyed by the task, on its own conversation. */
  openTaskConversation: (task: Task) => void;
  /** `task_v2_conversations_v0`. On, every non-legacy task opens its dialog;
   *  off, only a task made the v2 way does (decided per task), and a pre-v2
   *  task opens its host message's thread. */
  taskV2Enabled: boolean;
}

export async function openTaskByChannelNumber(
  deps: OpenTaskRefDeps,
  channelId: string,
  taskNumber: number,
): Promise<void> {
  try {
    const { data } = await api.get(`/tasks/channel/${channelId}/number/${taskNumber}`);
    const task = (data as { task: Task }).task;
    deps.closeProfile();
    if (task.isLegacy) {
      deps.closeThread();
      deps.toChannelTasks(task.channelId);
      deps.openLegacyTask(task);
      return;
    }
    if (opensAsTaskConversation(task, deps.taskV2Enabled)) {
      deps.openTaskConversation(task);
      return;
    }
    // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
    void deps.openThread({ parentChannelId: task.channelId, parentMessageId: task.messageId, intent: "task" });
  } catch (err) {
    console.error(`Failed to resolve task #${taskNumber}:`, err);
  }
}
