// `raft reminder show --id <id>` → the Reminder app's show-reminder: one field
// per line. Only on a server whose reminders live in the app.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { reminderAppGate, reminderAppId, runReminderAppAction } from "./_app";

interface ShowOpts {
  id?: string;
}

export const reminderShowCommand = defineCommand(
  {
    name: "show",
    description: "Show everything about one reminder in the Reminder app",
    options: [
      { flags: "--id <id>", description: "Reminder id (full id, or its first 8 or more characters)" },
    ],
  },
  async (ctx, opts: ShowOpts) => {
    if (!opts.id?.trim()) throw cliError("INVALID_ARG", "--id is required");
    const id = reminderAppId(opts.id);
    const agentContext = ctx.loadAgentContext();
    const gate = await reminderAppGate(ctx, agentContext);
    if (gate === "unknown") {
      throw cliError(
        "REMINDER_APP_UNKNOWN",
        "Could not tell whether this server's reminders are in the Reminder app (its settings could not be read), so nothing is shown.",
        { retryable: true, suggestedNextAction: "Run raft reminder show again in a moment; raft reminder list shows your reminders." },
      );
    }
    if (gate === "off") {
      throw cliError(
        "UNSUPPORTED_BY_SERVER",
        "raft reminder show reads reminders in the Reminder app, and this server's reminders are not there.",
        { suggestedNextAction: "raft reminder list shows your reminders; raft reminder log --id <id> shows one's history." },
      );
    }
    await runReminderAppAction(ctx, "show-reminder", { id }, { write: false });
  },
);

export function registerReminderShowCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderShowCommand, runtimeOptions);
}
