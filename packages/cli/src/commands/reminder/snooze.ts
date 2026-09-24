import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { parseDurationSeconds } from "./_duration.js";
import { formatReminderSnoozed } from "./_format.js";
import { resolveReminderId } from "./_resolve.js";

interface SnoozeOpts {
  id: string;
  by: string;
}

export const reminderSnoozeCommand = defineCommand(
  {
    name: "snooze",
    description: "Snooze a scheduled or fired reminder",
    options: [
      { flags: "--id <id>", description: "Reminder id (full uuid or short prefix)" },
      { flags: "--by <duration>", description: "Snooze duration, e.g. 30m, 2h, 1d" },
    ],
  },
  async (ctx, opts: SnoozeOpts) => {
      if (!opts.id?.trim()) {
        throw cliError("INVALID_ARG", "--id is required");
      }
      if (!opts.by?.trim()) {
        throw cliError("INVALID_ARG", "--by is required");
      }
      const delaySeconds = parseDurationSeconds(opts.by);
      if (delaySeconds == null) {
        throw cliError("INVALID_ARG", "--by must be a positive duration like 30m, 2h, or 1d");
      }

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const fullId = await resolveReminderId(client, opts.id, {
        statuses: ["scheduled", "fired"],
        failureCode: "SNOOZE_FAILED",
      });

      const res = await createAgentApiSurfaceClient(client).reminders.snooze(
        { reminderId: fullId },
        { delaySeconds },
      );
      if (!res.ok || !res.data?.reminder) {
        const code = res.status >= 500 ? "SERVER_5XX" : "SNOOZE_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      writeText(ctx.io, adoptCliReplyText(formatReminderSnoozed(res.data.reminder) + "\n"));
  },
);

export function registerReminderSnoozeCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderSnoozeCommand, runtimeOptions);
}
