import { useCallback } from "react";

import type { Task } from "../../store/taskStore";
import { useThreadStore } from "../../store/threadStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { useProfileStore } from "../../store/profileStore";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { directTaskConversationChannelId, opensAsTaskConversation } from "../../utils/taskConversation";

/**
 * Task v2: open the task dialog on the task's own conversation, keyed by the
 * task (the conversation has no parent message). A task with no conversation
 * yet (pre-v2) opens empty, and its first send creates one.
 */
export function openTaskConversationDialog(task: Task): void {
  useThreadStore.getState().openTaskConversation({
    taskId: task.id,
    parentChannelId: task.channelId,
    conversationChannelId: directTaskConversationChannelId(task),
  });
}

/**
 * Open a task's details: the centered task dialog for a task with a
 * conversation, the read-only legacy panel for a pre-thread orphan. Decided
 * per task: a task made the v2 way opens its dialog even with the flag off;
 * with the flag off a pre-v2 task opens its host message's thread.
 *
 * Shared by the Tasks page and the channel Tasks panel so a task opens in the
 * same container wherever it is clicked.
 */
export function useOpenTask() {
  const openThread = useThreadStore((s) => s.openThread);
  const closeThread = useThreadStore((s) => s.closeThread);
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const openLegacyTask = useLegacyTaskPanelStore((s) => s.openLegacyTask);
  const closeLegacyTask = useLegacyTaskPanelStore((s) => s.closeLegacyTask);
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  return useCallback((task: Task) => {
    closeProfile();
    if (task.isLegacy) {
      closeThread();
      openLegacyTask(task);
      return;
    }
    closeLegacyTask();
    if (opensAsTaskConversation(task, taskV2)) {
      openTaskConversationDialog(task);
      return;
    }
    void openThread({ parentChannelId: task.channelId, parentMessageId: task.messageId, intent: "task" });
  }, [closeProfile, closeThread, closeLegacyTask, openLegacyTask, openThread, taskV2]);
}
