// `raft reminder list [--status <s>]`
// → GET /internal/agent-api/reminders

import type { Command } from "commander";
import type { ReminderStatus } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { currentDate } from "@botiverse/raft-shared/src/agentCliSurface";
import { formatReminderList } from "./_format";

interface ListOpts {
  status?: string;
  all?: boolean;
}

const VALID_STATUSES = new Set<ReminderStatus>(["scheduled", "fired", "canceled", "migrated"]);

export const reminderListCommand = defineCommand(
  {
    name: "list",
    description: "List your own reminders (defaults to scheduled ones)",
    options: [
      { flags: "--all", description: "Also list fired and canceled reminders" },
      { flags: "--status <s>", description: "Comma-separated statuses (scheduled,fired,canceled,migrated). Default: scheduled, plus reminders moved to the Reminder app; fired ones are counted, not listed" },
    ],
  },
  async (ctx, opts: ListOpts) => {
      const statusRaw = opts.status && opts.status.trim().length > 0 ? opts.status.trim() : "scheduled,fired";
      for (const s of statusRaw.split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!VALID_STATUSES.has(s as ReminderStatus)) {
          throw cliError("INVALID_ARG", `--status entries must be one of ${Array.from(VALID_STATUSES).join("|")}; got ${s}`);
        }
      }

      const params = new URLSearchParams();
      if (opts.all && !opts.status) {
        params.set("all", "true");
      } else {
        params.set("status", statusRaw);
      }
      // The default and --all views also show reminders moved to the Reminder
      // app, so the agent knows where they went. An explicit --status is exact.
      if (!opts.status) params.set("includeMigrated", "true");

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const res = await createAgentApiSurfaceClient(client).reminders.list(Object.fromEntries(params));
      if (!res.ok) {
        const code = res.status >= 500 ? "SERVER_5XX" : "LIST_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      const reminders = res.data?.reminders ?? [];
      // A one-time reminder stays `fired` for good once it has fired, so the
      // default view would grow without bound and read as a backlog. Ask for
      // the same statuses as before (any server answers), list only the live
      // ones, and count the fired ones. `--status` and `--all` stay exact.
      const defaultView = !opts.status && !opts.all;
      const shown = defaultView ? reminders.filter((r) => r.status !== "fired") : reminders;
      const hiddenFired = reminders.length - shown.length;
      writeText(ctx.io, adoptCliReplyText(formatReminderList(shown, currentDate(), { hiddenFired }) + "\n"));
  },
);

export function registerReminderListCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderListCommand, runtimeOptions);
}
