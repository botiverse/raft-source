// `raft reminder cancel --id <full-or-short>`
// → DELETE /internal/agent-api/reminders/:reminderId
//
// If `--id` is shorter than a full UUID (32 hex chars after stripping dashes),
// we first GET scheduled reminders and resolve by prefix. Matches the MCP
// cancel_reminder tool behavior so AX is identical.

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { formatReminderCanceled } from "./_format";
import { resolveReminderId } from "./_resolve";
import { assertReminderNotSealed } from "../../apps/reminder/sealGuard";

interface CancelOpts {
  id: string;
}

export const reminderCancelCommand = defineCommand(
  {
    name: "cancel",
    description: "Cancel a scheduled reminder by id",
    options: [{ flags: "--id <id>", description: "Reminder id (full uuid, short prefix, or reminder:<id> as raft inbox check prints it)" }],
  },
  async (ctx, opts: CancelOpts) => {
      if (!opts.id || opts.id.trim().length === 0) {
        throw cliError("INVALID_ARG", "--id is required");
      }

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      await assertReminderNotSealed(ctx, opts.id.trim(), "cancel");
      const fullId = await resolveReminderId(client, opts.id, {
        statuses: ["scheduled", "fired"],
        failureCode: "CANCEL_FAILED",
      });

      const res = await createAgentApiSurfaceClient(client).reminders.cancel({ reminderId: fullId });
      if (!res.ok || !res.data?.reminder) {
        const code = res.status >= 500 ? "SERVER_5XX" : "CANCEL_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      writeText(ctx.io, adoptCliReplyText(formatReminderCanceled(res.data.reminder) + "\n"));
  },
);

export function registerReminderCancelCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderCancelCommand, runtimeOptions);
}
