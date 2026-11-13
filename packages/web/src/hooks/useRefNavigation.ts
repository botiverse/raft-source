import { useMemo } from "react";
import { useChannelStore } from "../store/channelStore";
import { useThreadStore } from "../store/threadStore";
import { loadThreadRefContext } from "../utils/threadRefContext";
import { useAppNavigate } from "./useAppNavigate";
import type { RefNavContext } from "../utils/refTarget";
import { useServerStore } from "../store/serverStore";
import type { MessageId } from "../i18n/messages";
import { useLegacyTaskPanelStore } from "../store/legacyTaskPanelStore";
import { useProfileStore } from "../store/profileStore";
import { openTaskByChannelNumber } from "../utils/openTaskRef";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../store/serverFeatureFlags";
import { openTaskConversationDialog } from "../components/task/useOpenTask";

/**
 * Builds the RefNavContext consumed by the shared resolve/navigate layer
 * (utils/refTarget.ts) and the Activity Diagnostics tokenizer.
 *
 * `summaries` / `followedThreads` are exposed as live getters so the
 * click-time thread resolution sees fresh thread state without forcing this
 * hook (and every linkified row) to re-render on thread-store churn.
 *
 * `loadThreadContext` mirrors MessageItem.handleOpenThreadRef exactly:
 * GET /messages/context/:shortId?channelId=… → { targetMessageId }.
 */
export function useRefNavigation(
  onThreadUnavailable?: (message: MessageId) => void,
): RefNavContext {
  const channels = useChannelStore((s) => s.channels);
  const serverSlug = useServerStore((s) => s.current?.slug ?? "");
  const openThread = useThreadStore((s) => s.openThread);
  const closeThread = useThreadStore((s) => s.closeThread);
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const openLegacyTask = useLegacyTaskPanelStore((s) => s.openLegacyTask);
  const nav = useAppNavigate();

  return useMemo<RefNavContext>(() => {
    return {
      serverSlug,
      getAuthority: () => {
        const currentAuthority = useServerStore.getState();
        return {
          serverSlug: currentAuthority.current?.slug,
          serverEpoch: currentAuthority.serverEpoch,
        };
      },
      channels,
      get summaries() {
        return useThreadStore.getState().summaries;
      },
      get followedThreads() {
        return useThreadStore.getState().followedThreads;
      },
      loadThreadContext: loadThreadRefContext,
      toChannel: (channelId) => nav.toChannel(channelId),
      toDm: (dmChannelId) => nav.toDm(dmChannelId),
      toMessage: (channelId, messageId) => nav.toMessage(channelId, messageId),
      toDmMessage: (dmChannelId, messageId) => nav.toDmMessage(dmChannelId, messageId),
      // Stryker disable next-line ArrowFunction: forwarding is covered by openThread payload/source contracts.
      openThread: (request) => openThread(request),
      openTask: (channelId, taskNumber) => openTaskByChannelNumber({
        closeProfile,
        closeThread,
        toChannelTasks: (taskChannelId) => nav.toChannel(taskChannelId, { chatTab: "tasks" }),
        openLegacyTask,
        openThread,
        openTaskConversation: openTaskConversationDialog,
        taskV2Enabled: taskV2,
      }, channelId, taskNumber),
      onThreadUnavailable,
    };
  }, [channels, closeProfile, closeThread, nav, openLegacyTask, openThread, onThreadUnavailable, serverSlug, taskV2]);
}
