import type { Command } from "commander";

import type { AgentInboxAppItem, AgentInboxSourceRef } from "@botiverse/raft-shared";

import { createDaemonApiSurfaceClient } from "../../daemonApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";

interface AckOpts {
  id: string;
  revision: string;
}

type AcknowledgedAppSource = {
  appId: string;
  notificationClass: string;
  sourceRef: AgentInboxSourceRef;
  itemId: string;
  acknowledgedAtMs: number;
  ownerAgentId?: string;
};

const REMINDER_INBOX_APP_ID = "system.reminder";
const REMINDER_DUE_NOTIFICATION_CLASS = "due";

function isReminderDueItem(item: AgentInboxAppItem): boolean {
  return item.appId === REMINDER_INBOX_APP_ID
    && item.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
    && item.sourceRef.kind === "reminder"
    && item.sourceRef.revision !== undefined;
}

function matchesReminderId(sourceId: string, query: string): boolean {
  return sourceId === query || sourceId.startsWith(query) || `reminder:${sourceId}` === query;
}

function matchesReminderItem(itemId: string, query: string): boolean {
  return itemId === query || itemId.startsWith(query);
}

function isExactAcknowledgement(
  ack: AcknowledgedAppSource,
  item: AgentInboxAppItem,
): boolean {
  return ack.appId === item.appId
    && ack.notificationClass === item.notificationClass
    && ack.itemId === item.itemId
    && ack.sourceRef.kind === "reminder"
    && item.sourceRef.kind === "reminder"
    && ack.sourceRef.id === item.sourceRef.id
    && ack.sourceRef.revision === item.sourceRef.revision;
}

function parseAckOptions(opts: AckOpts): { id: string; revision: string } {
  const id = opts.id?.trim();
  if (!id) {
    throw cliError("INVALID_ARG", "--id is required");
  }
  const revision = opts.revision?.trim();
  if (!/^[1-9][0-9]*$/.test(revision ?? "")) {
    throw cliError("INVALID_ARG", "--revision must be a positive integer");
  }
  return { id, revision };
}

async function runReminderAck(ctx: CommandContext, opts: AckOpts): Promise<void> {
    const { id, revision } = parseAckOptions(opts);
    const agentContext = ctx.loadAgentContext();
    if (agentContext.clientMode !== "managed-runner") {
      throw cliError("ACK_FAILED", "Reminder Inbox acknowledgements are only available in managed runners");
    }

    const client = ctx.createApiClient(agentContext);
    const daemonApi = createDaemonApiSurfaceClient(client);
    const snapshot = await daemonApi.inbox.check();
    if (!snapshot.ok) {
      throw cliError(
        snapshot.status >= 500 ? "SERVER_5XX" : "ACK_FAILED",
        snapshot.error ?? `HTTP ${snapshot.status}`,
      );
    }

    const items = (snapshot.data?.items ?? []) as Array<
      AgentInboxAppItem | { source: "message_target"; row: unknown }
    >;
    const acknowledgedSources = (snapshot.data?.acknowledged_app_sources ?? []) as AcknowledgedAppSource[];
    const reminderItems = items.filter((item): item is AgentInboxAppItem =>
      item.source === "app"
      && isReminderDueItem(item)
      && (matchesReminderId(item.sourceRef.id, id) || matchesReminderItem(item.itemId, id)),
    );
    const reminderAcknowledgements = acknowledgedSources.filter((ack) =>
      ack.appId === REMINDER_INBOX_APP_ID
      && ack.notificationClass === REMINDER_DUE_NOTIFICATION_CLASS
      && ack.sourceRef.kind === "reminder"
      && ack.sourceRef.revision !== undefined
      && (matchesReminderId(ack.sourceRef.id, id) || matchesReminderItem(ack.itemId, id)),
    );
    const distinctReminderIds = new Set([
      ...reminderItems.map((item) => item.sourceRef.id),
      ...reminderAcknowledgements.map((ack) => ack.sourceRef.id),
    ]);
    if (distinctReminderIds.size > 1) {
      throw cliError("ACK_FAILED", `Reminder prefix ${id} is ambiguous across active or acknowledged Reminder Inbox items`);
    }

    const exact = reminderItems.find((item) => item.sourceRef.revision === revision);
    if (!exact) {
      if (reminderItems.length > 0) {
        throw cliError("ACK_FAILED", `No active reminder Inbox item matches ${id} revision ${revision}`);
      }
      const acknowledged = reminderAcknowledgements.find((ack) => ack.sourceRef.revision === revision);
      if (acknowledged) {
        writeText(ctx.io, adoptCliReplyText(`Reminder ${acknowledged.sourceRef.id} revision ${revision} was already acknowledged for this fired item.\n`));
        return;
      }
      throw cliError("ACK_FAILED", `No active or acknowledged reminder Inbox item matches ${id} revision ${revision}`);
    }

    const ack = await daemonApi.inbox.ack({ itemId: exact.itemId });
    if (!ack.ok && ack.status === 404 && ack.errorCode === "item_not_found") {
      const refreshed = await daemonApi.inbox.check();
      if (!refreshed.ok) {
        throw cliError(
          refreshed.status >= 500 ? "SERVER_5XX" : "ACK_FAILED",
          refreshed.error ?? `HTTP ${refreshed.status}`,
        );
      }
      const refreshedAcknowledgements = (refreshed.data?.acknowledged_app_sources ?? []) as AcknowledgedAppSource[];
      if (!refreshedAcknowledgements.some((acknowledged) => isExactAcknowledgement(acknowledged, exact))) {
        throw cliError("ACK_FAILED", `No durable acknowledgement was recorded for reminder ${exact.sourceRef.id} revision ${revision}`);
      }
    } else if (!ack.ok) {
      throw cliError(
        ack.status >= 500 ? "SERVER_5XX" : "ACK_FAILED",
        ack.error ?? `HTTP ${ack.status}`,
      );
    }

    writeText(ctx.io, adoptCliReplyText(`Reminder ${exact.sourceRef.id} revision ${revision} fired item acknowledged.\n`));
}

const reminderAckOptions = [
  { flags: "--id <id>", description: "Reminder id (full uuid or short prefix)" },
  { flags: "--revision <revision>", description: "Exact reminder source revision to acknowledge" },
];

export const reminderAckCommand = defineCommand(
  {
    name: "ack",
    description: "Acknowledge one exact fired reminder Inbox item",
    options: reminderAckOptions,
  },
  runReminderAck,
);

export const reminderDismissCommand = defineCommand(
  {
    name: "dismiss",
    description: "Dismiss one exact fired reminder Inbox item",
    options: reminderAckOptions,
  },
  runReminderAck,
);

export function registerReminderAckCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderAckCommand, runtimeOptions);
  registerCliCommand(parent, reminderDismissCommand, runtimeOptions);
}
