// `raft reminder list [--status <s>]`
// → GET /internal/agent-api/reminders

import type { Command } from "commander";
import type { ReminderStatus } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { currentDate } from "@botiverse/raft-shared";
import { formatReminderList } from "./_format.js";

interface ListOpts {
  status?: string;
  all?: boolean;
}

const VALID_STATUSES = new Set<ReminderStatus>(["scheduled", "fired", "canceled"]);

export const reminderListCommand = defineCommand(
  {
    name: "list",
    description: "List your own reminders (defaults to scheduled and fired)",
    options: [
      { flags: "--all", description: "Include canceled reminders" },
      { flags: "--status <s>", description: "Comma-separated statuses (scheduled,fired,canceled). Default: scheduled,fired" },
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

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const res = await createAgentApiSurfaceClient(client).reminders.list(Object.fromEntries(params));
      if (!res.ok) {
        const code = res.status >= 500 ? "SERVER_5XX" : "LIST_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      writeText(ctx.io, adoptCliReplyText(formatReminderList(res.data?.reminders ?? [], currentDate()) + "\n"));
  },
);

export function registerReminderListCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderListCommand, runtimeOptions);
}
