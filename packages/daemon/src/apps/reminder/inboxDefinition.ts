import {
  AGENT_INBOX_PREVIEW_MAX_CHARS,
  shortIdFromSourceRef,
  type AgentInboxAppItem,
  type AgentInboxSourceRef,
} from "@botiverse/raft-shared";
import type {
  AgentAppInboxRegistry,
  AgentAppSourceRefNormalizeResult,
} from "../../agentAppInbox.js";

const SOURCE_REF_KEYS = new Set(["kind", "id", "revision"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REMINDER_INBOX_APP_ID = "system.reminder" as const;
export const REMINDER_DUE_NOTIFICATION_CLASS = "due" as const;

export function normalizeReminderDueSourceRef(raw: unknown): AgentAppSourceRefNormalizeResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "reminder sourceRef must be {kind,id,revision}" };
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !SOURCE_REF_KEYS.has(key))) {
    return { ok: false, message: "reminder sourceRef contains unknown fields" };
  }
  if (value.kind !== "reminder") {
    return { ok: false, message: "reminder sourceRef.kind must be reminder" };
  }
  if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) {
    return { ok: false, message: "reminder sourceRef.id must be a UUID" };
  }
  if (typeof value.revision !== "string" || !/^[1-9][0-9]*$/.test(value.revision)) {
    return { ok: false, message: "reminder sourceRef.revision must be a positive integer" };
  }
  return {
    ok: true,
    ref: { kind: "reminder", id: value.id, revision: value.revision },
  };
}

export function reminderItemId(sourceRef: AgentInboxSourceRef): string | null {
  if (sourceRef.kind !== "reminder" || sourceRef.revision === undefined) return null;
  return `reminder:${sourceRef.id}:${sourceRef.revision}`;
}

export function projectReminderInboxTitle(title: string): string | undefined {
  const singleLine = title
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AGENT_INBOX_PREVIEW_MAX_CHARS);
  return singleLine || undefined;
}

export function isReminderDueInboxItem(item: AgentInboxAppItem): boolean {
  return item.appId === REMINDER_INBOX_APP_ID
    && item.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
    && item.sourceRef.kind === "reminder"
    && item.sourceRef.revision !== undefined;
}

export const REMINDER_AGENT_INBOX_REGISTRY: AgentAppInboxRegistry = {
  [REMINDER_INBOX_APP_ID]: {
    [REMINDER_DUE_NOTIFICATION_CLASS]: {
      retention: "until_explicit_ack",
      primaryAction: { kind: "run_command", commandId: "reminder.ack" },
      normalizeSourceRef: normalizeReminderDueSourceRef,
      materializeActionCli: ({ sourceRef }) =>
        sourceRef.kind === "reminder"
          ? `raft reminder ack --id ${shortIdFromSourceRef(sourceRef)} --revision ${sourceRef.revision}`
          : null,
      materializeItemId: reminderItemId,
    },
  },
};
