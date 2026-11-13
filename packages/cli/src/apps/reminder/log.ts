import type { Command } from "commander";
import { currentDate } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText, NL } from "../../core/renderer";
import { formatReminderLog, formatTriggerLog } from "../../commands/reminder/_format";
import { invokeReminderApp, parseTriggerLog, requireTriggerKey } from "../../commands/reminder/_triggerApp";
import { registerReminderAckCommand } from "./ack";

interface LogOpts {
  id?: string;
  key?: string;
  limit?: string;
}

const TRIGGER_LOG_LIMIT_MAX = 200;

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const limit = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > TRIGGER_LOG_LIMIT_MAX) {
    throw cliError("INVALID_ARG", `--limit must be a whole number from 1 to ${TRIGGER_LOG_LIMIT_MAX}; got ${JSON.stringify(raw)}`);
  }
  return limit;
}

/** `--key`: a trigger key's history from the Reminder App's `list-trigger-log`. */
async function triggerLog(ctx: CommandContext, opts: LogOpts): Promise<void> {
  const key = requireTriggerKey(opts.key, { allowReserved: true });
  const limit = parseLimit(opts.limit);
  const value = await invokeReminderApp(
    ctx,
    "list-trigger-log",
    { key, ...(limit !== undefined ? { limit } : {}) },
    "no trigger log was read",
  );
  writeText(ctx.io, formatTriggerLog(key, parseTriggerLog(value), currentDate()), NL);
}

export const reminderLogCommand = defineCommand(
  {
    name: "log",
    description: "Show lifecycle events for one reminder, or the history of one trigger key",
    options: [
      { flags: "--id <id>", description: "Reminder id (full uuid or short prefix): that reminder's lifecycle events" },
      { flags: "--key <key>", description: "Trigger key (raft reminder trigger): its history, newest first, last 7 days" },
      { flags: "--limit <n>", description: "With --key: at most this many entries (1-200, default 50)" },
    ],
  },
  async (ctx, opts: LogOpts) => {
      const hasId = Boolean(opts.id?.trim());
      const hasKey = opts.key !== undefined;
      if (hasId === hasKey) {
        throw cliError(
          "INVALID_ARG",
          hasId
            ? "Pass only one of --id (a reminder's events) or --key (a trigger key's history), not both"
            : "Pass one of --id (a reminder's events) or --key (a trigger key's history)",
        );
      }
      if (hasKey) return triggerLog(ctx, opts);
      if (opts.limit !== undefined) throw cliError("INVALID_ARG", "--limit applies only with --key");
      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const res = await createAgentApiSurfaceClient(client).reminders.log({ reminderId: opts.id!.trim() });
      if (!res.ok || !res.data?.events) {
        const code = res.status >= 500 ? "SERVER_5XX" : "LOG_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      if (!res.data.events[0]?.reminderId) {
        throw cliError("LOG_FAILED", "Reminder log returned no source events");
      }
      writeText(ctx.io, adoptCliReplyText(formatReminderLog(res.data.events) + "\n"));
  },
);

export function registerReminderLogCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderLogCommand, runtimeOptions);
  registerReminderAckCommand(parent, runtimeOptions);
}
