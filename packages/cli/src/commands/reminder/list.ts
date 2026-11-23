// `raft reminder list [--status <s>]`
// → GET /internal/agent-api/reminders, or the Reminder app's list-reminders on
//   a server whose reminders live in the app, followed by the reminders made
//   before the move that still fire here.

import type { Command } from "commander";
import type { ReminderStatus } from "@botiverse/raft-shared";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { NL, writeText, adoptCliReplyText } from "../../core/renderer";
import { currentDate } from "@botiverse/raft-shared/src/agentCliSurface";
import { formatReminderAppUnchecked, formatReminderLeftovers, formatReminderList } from "./_format";
import { askReminderApp, reminderAppGate, writeReminderAppAnswer } from "./_app";

interface ListOpts {
  status?: string;
  all?: boolean;
}

type AppListStatus = "active" | "paused" | "finished" | "cancelled" | "all";

/** --status words, legacy or the app's, as the app's one status. */
const APP_STATUS: Record<string, AppListStatus> = {
  scheduled: "active",
  active: "active",
  fired: "finished",
  finished: "finished",
  canceled: "cancelled",
  cancelled: "cancelled",
  paused: "paused",
  // Reminders the import moved are in the app, whatever their state there.
  migrated: "all",
  all: "all",
};

/** The app's words, as the legacy statuses (null: --all). */
const LEGACY_STATUS: Record<string, ReminderStatus | null> = {
  active: "scheduled",
  finished: "fired",
  cancelled: "canceled",
  all: null,
};

/**
 * The app's list-reminders status for --status/--all: one status, or `all`
 * when several different ones are asked for. Undefined: the app's default
 * (active, plus changed or fired in the last 7 days).
 */
export function appListStatus(statuses: string[], all: boolean | undefined): AppListStatus | undefined {
  if (statuses.length === 0) return all ? "all" : undefined;
  const mapped = new Set(statuses.map((s) => APP_STATUS[s]!));
  return mapped.size === 1 ? [...mapped][0] : "all";
}

/**
 * The line after the app's list when --status named several different statuses
 * and none of them is `all` (or `migrated`): the app took them as `all`, so the
 * answer says it listed more than was asked. Null otherwise.
 */
export function appListWidenedNote(statuses: string[]): string | null {
  const mapped = new Set(statuses.map((s) => APP_STATUS[s]!));
  if (mapped.size < 2 || mapped.has("all")) return null;
  return "Listed every status: the Reminder app takes one at a time.";
}

function parseStatuses(raw: string | undefined): string[] {
  const statuses = (raw ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const s of statuses) {
    if (!(s in APP_STATUS)) {
      throw cliError("INVALID_ARG", `--status entries must be one of ${Object.keys(APP_STATUS).join("|")}; got ${s}`);
    }
  }
  return statuses;
}

export const reminderListCommand = defineCommand(
  {
    name: "list",
    description: "List your own reminders (defaults to scheduled ones)",
    options: [
      { flags: "--all", description: "Also list fired and canceled reminders" },
      { flags: "--status <s>", description: "Comma-separated statuses (scheduled,fired,canceled,migrated; the Reminder app's active,finished,cancelled,paused,all are the same). Default: scheduled, plus reminders moved to the Reminder app; fired ones are counted, not listed. In the Reminder app: one status (several read as all); default active plus changed or fired in the last 7 days" },
    ],
  },
  async (ctx, opts: ListOpts) => {
      const requested = parseStatuses(opts.status);
      const agentContext = ctx.loadAgentContext();
      const gate = await reminderAppGate(ctx, agentContext);
      if (gate === "on") {
        const status = appListStatus(requested, opts.all);
        const answer = await askReminderApp(ctx, "list-reminders", status ? { status } : {}, { write: false });
        const widened = appListWidenedNote(requested);
        // Reminders made before the move that the import did not take still
        // fire here: listed after the app's, whenever active ones are asked for.
        if (status !== undefined && status !== "active" && status !== "all") {
          writeReminderAppAnswer(ctx, answer);
          return;
        }
        const legacy = await createAgentApiSurfaceClient(ctx.createApiClient(agentContext)).reminders.list({ status: "scheduled" });
        const leftovers = formatReminderLeftovers(
          legacy.ok ? (legacy.data?.reminders ?? []).filter((r) => r.status === "scheduled") : [],
          currentDate(),
          legacy.ok ? null : legacy.error ?? `HTTP ${legacy.status}`,
        );
        writeReminderAppAnswer(ctx, answer, leftovers || undefined);
        if (widened) writeText(ctx.io, adoptCliReplyText(widened), NL);
        return;
      }

      if (requested.includes("paused")) {
        throw cliError("INVALID_ARG", "--status paused is a Reminder app status, and this server's reminders are not known to be in the app");
      }
      // The app's words name the same legacy statuses; `all` is --all.
      const legacyStatuses = requested.map((s) => (s in LEGACY_STATUS ? LEGACY_STATUS[s] as ReminderStatus | null : s as ReminderStatus));
      const all = opts.all === true || legacyStatuses.includes(null);
      const exact = requested.length > 0 && !legacyStatuses.includes(null);
      const statusRaw = exact ? [...new Set(legacyStatuses)].join(",") : "scheduled,fired";

      const params = new URLSearchParams();
      if (all && !exact) {
        params.set("all", "true");
      } else {
        params.set("status", statusRaw);
      }
      // The default and --all views also show reminders moved to the Reminder
      // app, so the agent knows where they went. An explicit --status is exact.
      if (!exact) params.set("includeMigrated", "true");

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
      const defaultView = !exact && !all;
      const shown = defaultView ? reminders.filter((r) => r.status !== "fired") : reminders;
      const hiddenFired = reminders.length - shown.length;
      writeText(ctx.io, adoptCliReplyText(formatReminderList(shown, currentDate(), { hiddenFired }) + "\n"));
      // Whether the reminders moved to the app is not known: say the app's were not checked.
      if (gate === "unknown") writeText(ctx.io, formatReminderAppUnchecked(), NL);
  },
);

export function registerReminderListCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, reminderListCommand, runtimeOptions);
}
