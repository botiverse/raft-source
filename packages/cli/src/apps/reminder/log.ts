import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { formatReminderLog } from "../../commands/reminder/_format.js";
import { registerReminderAckCommand } from "./ack.js";

interface LogOpts {
  id: string;
}

export const reminderLogCommand = defineCommand(
  {
    name: "log",
    description: "Show lifecycle events for one reminder",
    options: [{ flags: "--id <id>", description: "Reminder id (full uuid or short prefix)" }],
  },
  async (ctx, opts: LogOpts) => {
      if (!opts.id?.trim()) {
        throw cliError("INVALID_ARG", "--id is required");
      }
      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const res = await createAgentApiSurfaceClient(client).reminders.log({ reminderId: opts.id.trim() });
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
