import type { IntlShape } from "react-intl";

import type { Message } from "../../store/messageStore";

type MessageSlice = Pick<Message, "id" | "messageType" | "content">;

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
