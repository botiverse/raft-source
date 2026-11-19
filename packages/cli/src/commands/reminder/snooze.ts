import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { apiFailureError } from "../../core/apiFailure";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { parseDurationSeconds } from "./_duration";
import { formatReminderSnoozed } from "./_format";
import { resolveReminderId } from "./_resolve";
import { assertReminderNotSealed } from "../../apps/reminder/sealGuard";

interface SnoozeOpts {
  id: string;
  by: string;
}

export const reminderSnoozeCommand = defineCommand(
  {
    name: "snooze",
    description: "Snooze a scheduled or fired reminder",
    options: [
      { flags: "--id <id>", description: "Reminder id (full uuid, short prefix, or reminder:<id> as raft inbox check prints it)" },
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
      await assertReminderNotSealed(ctx, opts.id.trim(), "snooze");
      const fullId = await resolveReminderId(client, opts.id, {
        statuses: ["scheduled", "fired"],
        failureCode: "SNOOZE_FAILED",
      });

      const res = await createAgentApiSurfaceClient(client).reminders.snooze(
        { reminderId: fullId },
        { delaySeconds },
      );
      if (!res.ok || !res.data?.reminder) {
        // Carries the server's code, e.g. reminders_unsupported_for_external_agents.
        throw apiFailureError(res, "SNOOZE_FAILED");
      }
      writeText(ctx.io, adoptCliReplyText(formatReminderSnoozed(res.data.reminder) + "\n"));
  },
);

export function registerReminderSnoozeCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderSnoozeCommand, runtimeOptions);
}
