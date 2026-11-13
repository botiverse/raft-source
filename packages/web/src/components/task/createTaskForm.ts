import { TASK_CREATE_STATUSES } from "@botiverse/raft-shared";
import type { TaskCreateStatus } from "@botiverse/raft-shared";
import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import type { TaskCreateDraft } from "../../store/taskStore";
import { documentTitleChannelLabel } from "../../utils/browserDocumentTitle";
import { TASK_STATUS_UI } from "./taskStatusUi";

/**
 * The create's refusals a person can act on, in their language; any other shows the server's sentence.
 * `asMessage`: the task was written as one message (task v2), not as titles.
 */
function createRefusalMessage(code: string | undefined, formatMessage: ReturnType<typeof useIntl>["formatMessage"], asMessage: boolean): string | undefined {
  switch (code) {
    case "membership_required": return formatMessage({ id: "task.create.error.joinFirst" });
    case "quota_read_only": return formatMessage({ id: "task.create.error.readOnly" });
    case "channel_archived": return formatMessage({ id: "task.create.error.archived" });
    case "channel_access_changed": return formatMessage({ id: "task.create.error.accessChanged" });
    case "task_source_message_too_long": return formatMessage({ id: asMessage ? "task.create.error.messageTooLong" : "task.create.error.tooLong" });
    default: return undefined;
  }
}

type CreateRefusal = { code?: string; error?: string };

/** The refusal of a failed create, in the person's language where Raft has it. */
export function createFailureMessage(err: unknown, formatMessage: ReturnType<typeof useIntl>["formatMessage"], asMessage = false): string {
  const refusal = (err as { response?: { data?: CreateRefusal } }).response?.data;
  return createRefusalMessage(refusal?.code, formatMessage, asMessage) ?? (refusal?.error || formatMessage({ id: "task.create.failed" }));
}

export interface CreateTaskChannelOption {
  value: string;
  label: string;
}

/** `#` is markup, not translatable copy. */
function channelOptionLabel(name: string): string {
  return `#${name}`;
}

/**
 * The channel a create goes in: `fixedChannelId`, or (the Tasks page) the one
 * picked among the person's own channels that are not archived, starting at
 * `defaultChannelId` when it is one of them.
 */
export function useCreateTaskChannel(fixedChannelId: string | undefined, defaultChannelId: string | null) {
  const allChannels = useChannelStore((s) => s.channels);
  const channelOptions = useMemo<CreateTaskChannelOption[]>(() => (fixedChannelId ? [] : allChannels
    .filter((channel) => (channel.type === "channel" || channel.type === "private" || channel.type === "joint")
      && channel.joined !== false && !channel.archivedAt && channel.canPost !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((channel) => ({ value: channel.id, label: channelOptionLabel(channel.name) }))), [allChannels, fixedChannelId]);
  const [pickedChannelId, setPickedChannelId] = useState<string | null>(
    () => (defaultChannelId && channelOptions.some((option) => option.value === defaultChannelId) ? defaultChannelId : null),
  );
  const handleChannelChange = useCallback((next: string | null) => {
    if (next) setPickedChannelId(next);
  }, []);
  return { channelId: fixedChannelId ?? pickedChannelId, channelOptions, pickedChannelId, handleChannelChange };
}

/** How the app names `channelId`: `#name`, or `@peer` for a DM; null when it is not loaded (or no id). */
export function useChannelLabel(channelId: string | undefined): string | null {
  return useChannelStore((s) => {
    if (!channelId) return null;
    return documentTitleChannelLabel(findStoredChannel(s, channelId));
  });
}

/** Task v2: a task can start in Backlog, Todo or In progress, Todo by default. */
export function useCreateTaskStatus() {
  const { formatMessage } = useIntl();
  const [status, setStatus] = useState<TaskCreateStatus>("todo");
  const statusItems = useMemo(
    () => TASK_CREATE_STATUSES.map((value) => ({ value, label: formatMessage({ id: TASK_STATUS_UI[value].labelId }) })),
    [formatMessage],
  );
  const handleStatusChange = useCallback((next: TaskCreateStatus | null) => {
    if (next) setStatus(next);
  }, []);
  return { status, statusItems, handleStatusChange };
}

/**
 * Task v2's New task is a message (design "新建任务 = 发一条消息"): its first
 * line is the task's title, the rest its description. Null with no title yet.
 */
export function taskFromMessage(text: string): TaskCreateDraft | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const newline = trimmed.indexOf("\n");
  if (newline < 0) return { title: trimmed };
  const title = trimmed.slice(0, newline).trim();
  const description = trimmed.slice(newline + 1).trim();
  return description ? { title, description } : { title };
}
