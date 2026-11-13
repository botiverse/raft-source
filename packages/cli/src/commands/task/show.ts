// `raft task show --target <ch> --number <N>`
// → one task's CURRENT title and description.
//
// Why this exists (task #323 item 6): the description was already reachable — `raft task list`
// renders it as `details:` — but only channel- or --mine-scoped. There was no way to read ONE
// task, so anyone verifying a single card had to eyeball a whole board. No server change is
// needed: agentApiTaskEnvelopeSchema already carries `description`.
//
// Labels are copied VERBATIM from the agent delivery surface (`Current title:` /
// `Current description:`) rather than invented here — @Tenny, task #323. Two renderings of the
// same field that disagree is the defect this card is about.

import type { Command } from "commander";
import { formatAgentTaskShow } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { adoptCliReplyText, writeText } from "../../core/renderer";
import { PEER_KIND_OPTION, requireTargetAlias, type TargetAliasOpts } from "../_target";

interface ShowOpts extends TargetAliasOpts {
  number: string;
}

function parseTaskNumber(raw: string | undefined): number {
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new CliError({ code: "INVALID_ARG", message: `--number must be a positive integer; got ${raw}` });
  }
  return number;
}

export const taskShowCommand = defineCommand(
  {
    name: "show",
    description: "Read one task's current title and description",
    options: [
      { flags: "--target <target>", description: "Channel target: '#channel'" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--number <n>", description: "Task number to read" },
    ],
  },
  async (ctx, opts: Partial<ShowOpts>) => {
    const channel = requireTargetAlias(opts);
    const taskNumber = parseTaskNumber(opts.number);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);

    // `status: "all"` is REQUIRED, not a default-widening convenience: the unfiltered board omits
    // finished work, so `show --number N` on a done/closed task would report "not found" — an
    // absence manufactured by the query, indistinguishable from a wrong task number.
    const res = await agentApi.tasks.list({ channel, status: "all" });
    if (!res.ok) {
      throw new CliError({
        // LIST_FAILED, not a new SHOW_FAILED: the call that failed IS taskList. A per-command
        // code would hide this failure from anyone grepping LIST_FAILED for taskList problems.
        code: res.status >= 500 ? "SERVER_5XX" : "LIST_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }
    if (!res.data) {
      throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API taskList returned an empty response body" });
    }

    const tasks = res.data.tasks ?? [];
    const task = tasks.find((t) => t.taskNumber === taskNumber);
    if (!task) {
      // Completeness first: `pagination: {mode:"complete", truncated:false}` is the contract's only
      // assertion that the list is whole, and it is `.optional()` (agentApiTaskListResponseSchema).
      // Older `scope:"channel"` servers do not send it. Absence means the server
      // asserted NOTHING, not "complete".
      const asserted = res.data.scope === "channel" && res.data.coverage?.status !== "incomplete"
        && res.data.pagination?.mode === "complete" && res.data.pagination.truncated === false;
      if (asserted) {
        throw new CliError({
          code: "NOT_FOUND",
          message: `task #${taskNumber} not found in ${channel} (searched ${tasks.length} task(s), status=all; server asserts this list is complete)`,
        });
      }
      // Without that assertion an EMPTY list is ambiguous, not a failure (@Huaihuai, PR #8048 review):
      // a channel with no tasks is a successful read, and older servers can return [] when they swallow
      // a read error (task #327: listTasks catches → logs → returns []). The CLI cannot tell which, so
      // it names both and claims neither. A genuinely invalid response is rejected earlier.
      if (tasks.length === 0) {
        throw new CliError({
          code: "NOT_FOUND",
          message: `task #${taskNumber} not found in ${channel}: the server returned 0 tasks and did not assert the list is complete. That can mean the channel has no tasks, or that the server failed to read them (it currently reports some read errors as an empty list), and this command cannot tell which — so this is not evidence that task #${taskNumber} does not exist`,
        });
      }
      throw new CliError({
        code: "NOT_FOUND",
        message: `task #${taskNumber} not found in ${channel} (searched ${tasks.length} task(s), status=all; this surface does NOT assert completeness — so this is "absent from what was returned", not "does not exist")`,
      });
    }

    // The text (including the three description states) is the shared
    // formatter's, so the SDK's `tasks.show` renders the same bytes.
    writeText(ctx.io, adoptCliReplyText(formatAgentTaskShow(channel, task)));
  },
);

export function registerTaskShowCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskShowCommand, runtimeOptions);
}
