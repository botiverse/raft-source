import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { apiFailureError } from "../../core/apiFailure";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { parseDurationSeconds } from "./_duration";
import { formatReminderUpdated } from "./_format";
import { resolveReminderId } from "./_resolve";
import { assertReminderNotSealed } from "../../apps/reminder/sealGuard";
import { legacyThenApp, reminderAppGate, reminderAppId, runReminderAppAction, wasMovedToApp } from "./_app";

interface UpdateOpts {
  id: string;
  fireAt?: string;
  in?: string;
  cadence?: string;
  title?: string;
  tz?: string;
  notes?: string;
}

function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * update-reminder's flat parameters. Any of the fields may change together;
 * the app merges a schedule field into the stored schedule. --cadence takes
 * this host's zone unless --tz names one, as the legacy update does.
 */
export function buildAppUpdatePayload(id: string, opts: UpdateOpts, hostTz: () => string = hostTimezone): Record<string, unknown> {
  if ([opts.fireAt, opts.in, opts.cadence, opts.title, opts.tz, opts.notes].every((x) => x === undefined || x === null)) {
    throw cliError("INVALID_ARG", "Pass at least one of --fire-at, --in, --cadence, --title, --tz, or --notes");
  }
  if (opts.fireAt !== undefined && opts.in !== undefined) {
    throw cliError("INVALID_ARG", "Pass either --fire-at or --in, not both");
  }
  const payload: Record<string, unknown> = { id };
  if (opts.fireAt !== undefined) payload.at = opts.fireAt;
  if (opts.in !== undefined) {
    if (parseDurationSeconds(opts.in) == null) {
      throw cliError("INVALID_ARG", "--in must be a positive duration like 30m, 2h, or 1d");
    }
    payload.in = opts.in.trim();
  }
  if (opts.cadence !== undefined) payload.repeat = opts.cadence;
  const timezone = opts.tz?.trim() || (opts.cadence !== undefined && opts.cadence.trim().toLowerCase() !== "none" ? hostTz() : undefined);
  if (timezone !== undefined) payload.timezone = timezone;
  if (opts.title !== undefined) payload.title = opts.title;
  if (opts.notes !== undefined) payload.notes = opts.notes;
  return payload;
}

export const reminderUpdateCommand = defineCommand(
  {
    name: "update",
    description: "Update a reminder's time, recurrence, or title",
    options: [
      { flags: "--id <id>", description: "Reminder id (full uuid, short prefix, or reminder:<id> as raft inbox check prints it)" },
      { flags: "--fire-at <iso>", description: "New absolute next fire time" },
      { flags: "--in <duration>", description: "New relative next fire time, e.g. 30m, 2h" },
      { flags: "--cadence <rule>", description: "New recurrence rule: every:15m | daily@09:00 | weekly:mon,fri@09:00 (none: one-time, in the Reminder app)" },
      { flags: "--tz <iana>", description: "IANA timezone for --cadence (default: this host's); in the Reminder app also on its own" },
      { flags: "--title <text>", description: "New reminder title" },
      { flags: "--notes <text>", description: "New notes (Reminder app only)" },
    ],
    helpAfter: "\nIn the Reminder app, fields can change together and a --fire-at or --in moves the next fire of a recurring one; otherwise pass one field per call.\n",
  },
  async (ctx, opts: UpdateOpts) => {
      if (!opts.id?.trim()) {
        throw cliError("INVALID_ARG", "--id is required");
      }
      const appPayload = buildAppUpdatePayload(reminderAppId(opts.id), opts);
      const agentContext = ctx.loadAgentContext();
      const viaApp = () => runReminderAppAction(ctx, "update-reminder", appPayload, { write: true });
      const gate = await reminderAppGate(ctx, agentContext);
      if (gate === "on") return viaApp();

      if (opts.notes !== undefined || (opts.tz !== undefined && opts.cadence === undefined)) {
        throw cliError("INVALID_ARG", "--notes, and --tz without --cadence, work only for reminders in the Reminder app; this server's reminders are not there");
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
        body.tz = opts.tz?.trim() || hostTimezone();
      }
      if (opts.title !== undefined) body.title = opts.title;

      const legacy = async () => {
        const client = ctx.createApiClient(agentContext);
        await assertReminderNotSealed(ctx, opts.id.trim(), "update");
        const fullId = await resolveReminderId(client, opts.id, {
          all: true,
          failureCode: "UPDATE_FAILED",
        });

        const res = await createAgentApiSurfaceClient(client).reminders.update(
          { reminderId: fullId },
          body,
        );
        if (wasMovedToApp(res)) return viaApp();
        if (!res.ok || !res.data?.reminder) {
          // Carries the server's code, e.g. reminders_unsupported_for_external_agents.
          throw apiFailureError(res, "UPDATE_FAILED");
        }
        writeText(ctx.io, adoptCliReplyText(formatReminderUpdated(res.data.reminder, res.data.warning ?? null) + "\n"));
      };
      await legacyThenApp(gate, String(appPayload.id), legacy, viaApp);
  },
);

export function registerReminderUpdateCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderUpdateCommand, runtimeOptions);
}
