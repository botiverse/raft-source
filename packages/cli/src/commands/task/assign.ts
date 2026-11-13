// `raft task assign "#ch:#N" @who --reason "<what you wait on them for>"`
// (or `--target <ch> --number <N> --assignee @who`)
// → POST /internal/agent-api/tasks/assign
//
// Clearing is `raft task unassign`, a verb of its own — see unassign.ts.

import type { Command } from "commander";
import type { AgentApiTaskAssignBody } from "@botiverse/raft-shared";
import { checkTaskAssignReason } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { rateLimitedResponseError } from "../../core/apiFailure";
import { CliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { PEER_KIND_OPTION, type TargetAliasOpts } from "../_target";
import { formatTaskAssigned } from "./_format";
import { resolveTaskWriteAddress } from "./_taskAddress";
import { writeHeldTaskWrite } from "../freshness/_taskHold";

interface AssignOpts extends TargetAliasOpts {
  number: string;
  assignee?: string;
  reason?: string;
  expectedRevision?: string;
}

/**
 * `@who` is required and never defaulted: "assign with no assignee" is
 * ambiguous between "to me" and "to nobody", and guessing either would be a
 * silent, wrong write. "To nobody" is `raft task unassign`. It is the second
 * positional (`raft task assign "#ch:#7" @who`) or `--assignee`; a lone
 * `@who` positional with --target/--number is the assignee too.
 */
function validateAssignOpts(
  refArg: string | undefined,
  assigneeArg: string | undefined,
  opts: Partial<AssignOpts>,
): {
  channel: string;
  taskNumber: number;
  assignee: string;
  reason: string;
  expectedRevision?: number;
} {
  let ref = refArg?.trim() || undefined;
  let positionalAssignee = assigneeArg?.trim() || undefined;
  if (ref?.startsWith("@") && positionalAssignee === undefined) {
    positionalAssignee = ref;
    ref = undefined;
  }
  const { channel, taskNumber } = resolveTaskWriteAddress(ref, opts);

  const flagAssignee = opts.assignee?.trim() || undefined;
  if (positionalAssignee && flagAssignee && normalizeHandle(positionalAssignee) !== normalizeHandle(flagAssignee)) {
    throw new CliError({
      code: "INVALID_ARG",
      message: `${positionalAssignee} and --assignee ${flagAssignee} name different assignees; give one of them.`,
    });
  }
  const raw = positionalAssignee ?? flagAssignee ?? "";
  if (!raw) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--assignee <@who> is required; to clear the assignee use `raft task unassign`",
    });
  }
  const assignee = normalizeHandle(raw);

  // The server knows whether @who is you; here only the text is checked.
  const { reason, refusal } = checkTaskAssignReason(opts.reason, true);
  if (refusal) {
    throw new CliError({ code: "INVALID_ARG", message: `--reason: ${refusal.message}` });
  }

  let expectedRevision: number | undefined;
  if (opts.expectedRevision !== undefined) {
    const n = Number(opts.expectedRevision);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `--expected-revision must be a non-negative integer; got ${opts.expectedRevision}`,
      });
    }
    expectedRevision = n;
  }

  return { channel, taskNumber, assignee, reason: reason ?? "", expectedRevision };
}

function normalizeHandle(raw: string): string {
  return raw.startsWith("@") ? raw : `@${raw}`;
}

export const taskAssignCommand = defineCommand(
  {
    name: "assign",
    description: "Assign a task to a human or agent",
    arguments: ["[ref]", "[assignee]"],
    usage: '"#channel:#7" @who --reason "<what you need from them>"  (or --target "#channel" --number 7 --assignee @who)',
    options: [
      { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number), instead of a ref" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      { flags: "--number <n>", description: "Task number on that board (with --target)" },
      { flags: "--assignee <@who>", description: "Human or agent to assign to, e.g. @alice (or give it after the ref)" },
      {
        flags: "--reason <text>",
        description: "Handing the task to someone else: one line on what it waits on them for. They see it in their notification and in the task, so no separate message is needed. Required from an agent handing a task to someone else; not for assigning yourself",
      },
      {
        flags: "--expected-revision <n>",
        description: "Only apply if the task is still at this revision (lose instead of clobbering)",
      },
    ],
    helpAfter:
      '\nA task is named by its ref: "#channel:#7", or "dm:@peer:#7" for a task in a DM. Quote it: an unquoted # starts a shell comment.\n'
      + 'Example: raft task assign "#proj:#51" @alice --reason "Your call: ship Friday or Monday?"\n',
  },
  async (ctx, refArg: string | undefined, assigneeArg: string | undefined, opts: Partial<AssignOpts> = {}) => {
    const { channel, taskNumber, assignee, reason, expectedRevision } = validateAssignOpts(refArg, assigneeArg, opts);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const body: AgentApiTaskAssignBody = {
      channel,
      task_number: taskNumber,
      assignee,
      // Always sent (empty when not given): it tells the server this client
      // can give a reason, so a hand-off without one is refused with how to
      // add it instead of going through without saying why.
      reason,
      ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}),
    };
    const agentApi = createAgentApiSurfaceClient(client);
    const res = await agentApi.tasks.assign(body);
    if (!res.ok) {
      const rateLimited = rateLimitedResponseError(res);
      if (rateLimited) throw rateLimited;
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "ASSIGN_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
        // The refusal's step (its `next`, in the CLI form): the error names no command.
        suggestedNextAction: res.suggestedNextAction ?? undefined,
      });
    }
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API taskAssign returned an empty response body",
      });
    }
    if (writeHeldTaskWrite(ctx, agentContext.agentId, "task_assign", body, res.data)) return;
    writeText(ctx.io, formatTaskAssigned(taskNumber, assignee, res.data.taskRef), NL);
  },
);

export function registerTaskAssignCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, taskAssignCommand, runtimeOptions);
}
