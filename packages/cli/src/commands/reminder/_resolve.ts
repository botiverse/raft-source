import type { ReminderStatus, ReminderSummary } from "@botiverse/raft-shared";
import type { ApiClient } from "../../client.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { cliError } from "../../core/errors.js";

export async function resolveReminderId(
  client: ApiClient,
  id: string,
  opts: {
    statuses?: ReminderStatus[];
    all?: boolean;
    failureCode: string;
  },
): Promise<string> {
  const trimmed = id.trim();
  if (!trimmed) throw cliError("INVALID_ARG", "--id is required");
  if (trimmed.length >= 32) return trimmed;

  const params = new URLSearchParams();
  if (opts.all) {
    params.set("all", "true");
  } else if (opts.statuses && opts.statuses.length > 0) {
    params.set("status", opts.statuses.join(","));
  }
  const res = await createAgentApiSurfaceClient(client).reminders.list(Object.fromEntries(params));
  if (!res.ok) {
    const code = res.status >= 500 ? "SERVER_5XX" : opts.failureCode;
    throw cliError(code, res.error ?? `HTTP ${res.status}`);
  }

  const matches = (res.data?.reminders ?? []).filter((r) => r.reminderId.startsWith(trimmed));
  if (matches.length === 0) {
    const scope = opts.all ? "reminder" : `${opts.statuses?.join("/") ?? "active"} reminder`;
    throw cliError("NOT_FOUND", `No ${scope} matches id prefix '${trimmed}'.`);
  }
  if (matches.length > 1) {
    throw cliError("AMBIGUOUS", `Ambiguous id prefix '${trimmed}' matches ${matches.length} reminders; pass a longer id.`);
  }
  return matches[0].reminderId;
}
