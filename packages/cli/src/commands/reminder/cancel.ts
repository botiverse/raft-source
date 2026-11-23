// `raft reminder cancel --id <full-or-short>`
// → DELETE /internal/agent-api/reminders/:reminderId
//
// If `--id` is shorter than a full UUID (32 hex chars after stripping dashes),
// we first GET scheduled reminders and resolve by prefix. Matches the MCP
// cancel_reminder tool behavior so AX is identical.
//
// On a server whose reminders live in the Reminder app: its cancel-reminder.
// An id the app does not know may be a reminder made before the move that the
// import did not take (it still fires here): that one is canceled here.

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { formatReminderCanceled } from "./_format";
import { resolveReminderId } from "./_resolve";
import { assertReminderNotSealed } from "../../apps/reminder/sealGuard";
import type { CommandContext } from "../../core/context";
import type { AgentContext } from "../../auth/env";
import { callReminderApp } from "./_triggerApp";
import {
  askReminderApp,
  isReminderAppNotFound,
  legacyThenApp,
  reminderAppFailure,
  reminderAppGate,
  reminderAppId,
  writeReminderAppAnswer,
} from "./_app";

/** The legacy cancel's answers for an id it does not have (CANCEL_FAILED: the Server refused it, e.g. 404 or moved). */
const LEGACY_NOT_FOUND: readonly string[] = ["NOT_FOUND", "CANCEL_FAILED"];

interface CancelOpts {
  id: string;
}

export const reminderCancelCommand = defineCommand(
  {
    name: "cancel",
    description: "Cancel a reminder by id",
    options: [{ flags: "--id <id>", description: "Reminder id (full uuid, short prefix, or reminder:<id> as raft inbox check prints it)" }],
  },
  async (ctx, opts: CancelOpts) => {
      if (!opts.id || opts.id.trim().length === 0) {
        throw cliError("INVALID_ARG", "--id is required");
      }

      const agentContext = ctx.loadAgentContext();
      const appId = reminderAppId(opts.id);
      const gate = await reminderAppGate(ctx, agentContext);
      const legacy = () => cancelLegacyReminder(ctx, agentContext, opts.id);
      if (gate !== "on") {
        await legacyThenApp(gate, appId, legacy, async () => {
          writeReminderAppAnswer(ctx, await askReminderApp(ctx, "cancel-reminder", { id: appId }, { write: true }));
        }, LEGACY_NOT_FOUND);
        return;
      }
      let answer: unknown;
      try {
        answer = await callReminderApp(ctx, "cancel-reminder", { id: appId }, "nothing was changed");
      } catch (error) {
        // An id the app does not know may be a reminder from before the move.
        // Only a whole short id (8+ characters, as the app requires) is looked
        // up there: a shorter or mistyped one must not cancel another by prefix.
        if (!isReminderAppNotFound(error) || appId.length < 8) throw reminderAppFailure(error, { write: true });
        try {
          await legacy();
          return;
        } catch (legacyError) {
          // Not a reminder from before the move either (none matched, or the
          // Server refused it, e.g. one the import moved): the app's answer
          // says what to do. A seal or an unreachable Server is its own answer.
          if (legacyError instanceof CliError && LEGACY_NOT_FOUND.includes(legacyError.code)) throw reminderAppFailure(error, { write: true });
          throw legacyError;
        }
      }
      writeReminderAppAnswer(ctx, answer);
  },
);

async function cancelLegacyReminder(ctx: CommandContext, agentContext: AgentContext, id: string): Promise<void> {
  const client = ctx.createApiClient(agentContext);
  await assertReminderNotSealed(ctx, id.trim(), "cancel");
  const fullId = await resolveReminderId(client, id, {
    statuses: ["scheduled", "fired"],
    failureCode: "CANCEL_FAILED",
  });

  const res = await createAgentApiSurfaceClient(client).reminders.cancel({ reminderId: fullId });
  if (!res.ok || !res.data?.reminder) {
    const code = res.status >= 500 ? "SERVER_5XX" : "CANCEL_FAILED";
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }
  writeText(ctx.io, adoptCliReplyText(formatReminderCanceled(res.data.reminder) + "\n"));
}

export function registerReminderCancelCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderCancelCommand, runtimeOptions);
}
