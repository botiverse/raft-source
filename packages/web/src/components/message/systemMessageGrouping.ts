import { DELEGATED_RECEIPT_KIND } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";

import { isWeChatConnectedNotice } from "../../assistant/wechatNotice";
import { readTaskHandoffNotice } from "../task/taskHandoffNotice";
import type { Message } from "../../store/messageStore";

type MessageSlice = Pick<Message, "id" | "messageType" | "content"> & Partial<Pick<Message, "actionMetadata" | "randomId">>;

export type SystemMessageRenderState =
  | { kind: "hide"; groupId: string }
  | { kind: "summary"; content: string; groupId: string; messageIndexes: number[] };

type FormatMessage = IntlShape["formatMessage"];

type TaskSystemEvent = {
  taskNumber: number;
  title: string;
  actor: string;
  kind: "converted" | "claimed" | "released" | "moved" | "deleted";
  status?: string;
};

function stripLeadingStatusGlyph(content: string): string {
  const trimmed = content.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace <= 0) return trimmed;
  const firstToken = trimmed.slice(0, firstSpace);
  if (/^[^\p{L}\p{N}@#]+$/u.test(firstToken)) {
    return trimmed.slice(firstSpace + 1).trim();
  }
  return trimmed;
}

function parseTaskSystemEvent(message: MessageSlice): TaskSystemEvent | null {
  if (message.messageType !== "system") return null;

  const content = stripLeadingStatusGlyph(message.content);

  const converted = content.match(/^(.+?) converted a message to task #(\d+)\s+"([^"]*)"/u);
  if (converted) {
    return {
      actor: converted[1],
      kind: "converted",
      taskNumber: Number(converted[2]),
      title: converted[3],
    };
  }

  const claimed = content.match(/^(.+?) claimed #(\d+)\s+"([^"]*)"/u);
  if (claimed) {
    return {
      actor: claimed[1],
      kind: "claimed",
      taskNumber: Number(claimed[2]),
      title: claimed[3],
    };
  }

  const released = content.match(/^(.+?) released #(\d+)\s+"([^"]*)"/u);
  if (released) {
    return {
      actor: released[1],
      kind: "released",
      taskNumber: Number(released[2]),
      title: released[3],
    };
  }

  const moved = content.match(/^(.+?) moved #(\d+)\s+"([^"]*)" to (.+)$/u);
  if (moved) {
    return {
      actor: moved[1],
      kind: "moved",
      status: moved[4],
      taskNumber: Number(moved[2]),
      title: moved[3],
    };
  }

  const deleted = content.match(/^(.+?) deleted #(\d+)\s+"([^"]*)"/u);
  if (deleted) {
    return {
      actor: deleted[1],
      kind: "deleted",
      taskNumber: Number(deleted[2]),
      title: deleted[3],
    };
  }

  return null;
}

type SystemMessageCategory = "taskUpdate" | "reminder" | "system";

function classifySystemMessage(message: MessageSlice): SystemMessageCategory | null {
  if (message.messageType !== "system") return null;
  // RFC 077: a receipt for a message the assistant sent as its owner is a card
  // with Retract, not an event line: it never folds into a group's summary.
  if (message.actionMetadata?.kind === DELEGATED_RECEIPT_KIND) return null;
  // Nor does the WeChat connected notice, a card with Disconnect WeChat.
  if (isWeChatConnectedNotice(message)) return null;
  // Nor does a task handed to someone with a reason: a card the assignee reads.
  if (readTaskHandoffNotice(message)) return null;
  const content = stripLeadingStatusGlyph(message.content);

  if (parseTaskSystemEvent(message)) return "taskUpdate";
  if (/\b(?:new tasks? created|converted a message to task #\d+|claimed #\d+|released #\d+|moved #\d+|deleted #\d+)\b/iu.test(content)) {
    return "taskUpdate";
  }

  if (/^(?:Reminder\s+#\w+|Reminder(?: \([^)]+\))?:|.+?\s+(?:scheduled|canceled|cancelled)\s+(?:a\s+)?reminder\b)/iu.test(content)) {
    return "reminder";
  }

  return "system";
}

function formatSystemMessageBlockSummary(
  categories: readonly SystemMessageCategory[],
  formatMessage: FormatMessage,
): string {
  const taskUpdates = categories.filter((category) => category === "taskUpdate").length;
  const reminders = categories.filter((category) => category === "reminder").length;
  const systemMessages = categories.filter((category) => category === "system").length;
  const parts = [
    taskUpdates > 0
      ? formatMessage({ id: "message.system.summary.taskUpdateCount" }, { count: taskUpdates })
      : null,
    reminders > 0
      ? formatMessage({ id: "message.system.summary.reminderUpdateCount" }, { count: reminders })
      : null,
    systemMessages > 0
      ? formatMessage({ id: "message.system.summary.systemMessageCount" }, { count: systemMessages })
      : null,
  ].filter((part): part is string => part !== null);

  const listSeparator = formatMessage({ id: "message.system.summary.listSeparator" });

  if (parts.length === 1) {
    return formatMessage(
      { id: "message.system.summary.singlePart" },
      { totalCount: categories.length, part: parts[0] },
    );
  }

  if (systemMessages === 0) {
    return formatMessage(
      { id: "message.system.summary.multiParts" },
      { parts: parts.join(listSeparator) },
    );
  }

  return formatMessage(
    { id: "message.system.summary.systemUpdates" },
    { count: categories.length, parts: parts.join(listSeparator) },
  );
}

/**
 * Produces render-only grouping for adjacent system-message runs.
 * The underlying message list stays untouched so history, scroll anchoring,
 * and agent/CLI-visible system events remain exact.
 */
export function buildSystemMessageRenderStates(
  messages: readonly MessageSlice[],
  formatMessage: FormatMessage,
): Array<SystemMessageRenderState | null> {
  const categories = messages.map(classifySystemMessage);
  const states: Array<SystemMessageRenderState | null> = Array.from({ length: messages.length }, () => null);

  for (let i = 0; i < messages.length; i += 1) {
    if (!categories[i]) continue;

    let end = i + 1;
    while (end < messages.length && categories[end]) {
      end += 1;
    }

    const runLength = end - i;
    if (runLength > 1) {
      const groupCategories = categories.slice(i, end).filter((category): category is SystemMessageCategory => category !== null);
      const groupId = `system-group:${messages[i].id}:${messages[end - 1].id}`;
      states[i] = {
        kind: "summary",
        content: formatSystemMessageBlockSummary(groupCategories, formatMessage),
        groupId,
        messageIndexes: Array.from({ length: runLength }, (_value, offset) => i + offset),
      };
      for (let j = i + 1; j < end; j += 1) {
        states[j] = { kind: "hide", groupId };
      }
    }

    i = end - 1;
  }

  return states;
}

/**
 * The messages a system-message group folds into its summary: each hidden
 * message's id, mapped to the id of the group's first message (the summary
 * row, which renders the whole group, collapsed or expanded). A timeline
 * gives a group ONE row: a hidden message is not a row of its own, so a long
 * run of task events cannot fill the rows a virtual list mounts with empty
 * ones (MessageTimelineProps.foldedMessageIds).
 */
export function foldedSystemMessageIds(
  messages: readonly Pick<Message, "id">[],
  states: readonly (SystemMessageRenderState | null)[],
): ReadonlyMap<string, string> {
  const folded = new Map<string, string>();
  let owner: string | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const state = states[i];
    if (state?.kind === "summary") owner = messages[i]!.id;
    else if (state?.kind === "hide" && owner) folded.set(messages[i]!.id, owner);
    else owner = null;
  }
  return folded;
}
