import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { parseDurationSeconds } from "./_duration.js";
import { formatReminderUpdated } from "./_format.js";
import { resolveReminderId } from "./_resolve.js";

interface UpdateOpts {
  id: string;
  fireAt?: string;
  in?: string;
  cadence?: string;
  title?: string;
}

export const reminderUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Update one field on a scheduled reminder",
    options: [
      { flags: "--id <id>", description: "Reminder id (full uuid or short prefix)" },
      { flags: "--fire-at <iso>", description: "New absolute next fire time" },
      { flags: "--in <duration>", description: "New relative next fire time, e.g. 30m, 2h" },
      { flags: "--cadence <rule>", description: "New recurrence rule: every:15m | daily@09:00 | weekly:mon,fri@09:00" },
      { flags: "--title <text>", description: "New reminder title" },
    ],
  },
  async (ctx, opts: UpdateOpts) => {
      if (!opts.id?.trim()) {
        throw cliError("INVALID_ARG", "--id is required");
      }
      const mutationCount = [opts.fireAt, opts.in, opts.cadence, opts.title]
        .filter((x) => x !== undefined && x !== null).length;
      if (mutationCount !== 1) {
        throw cliError("INVALID_ARG", "Pass exactly one of --fire-at, --in, --cadence, or --title");
      }

      const body: Record<string, unknown> = {};
      if (opts.fireAt !== undefined) body.fireAt = opts.fireAt;
      if (opts.in !== undefined) {
        const delaySeconds = parseDurationSeconds(opts.in);
        if (delaySeconds == null) {
          throw cliError("INVALID_ARG", "--in must be a positive duration like 30m, 2h, or 1d");
        }
        body.delaySeconds = delaySeconds;
      }
      if (opts.cadence !== undefined) {
        body.repeat = opts.cadence;
        body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
      if (opts.title !== undefined) body.title = opts.title;

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const fullId = await resolveReminderId(client, opts.id, {
        all: true,
        failureCode: "UPDATE_FAILED",
      });

      const res = await createAgentApiSurfaceClient(client).reminders.update(
        { reminderId: fullId },
        body,
      );
      if (!res.ok || !res.data?.reminder) {
        const code = res.status >= 500 ? "SERVER_5XX" : "UPDATE_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      writeText(ctx.io, adoptCliReplyText(formatReminderUpdated(res.data.reminder, res.data.warning ?? null) + "\n"));
  },
);

export function registerReminderUpdateCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderUpdateCommand, runtimeOptions);
}
