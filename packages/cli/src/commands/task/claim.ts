// `raft task claim "#ch:#N"`, or
// `raft task claim --target <ch> [--number N ...] [--message-id <id> ...]`
// → POST /internal/agent-api/tasks/claim
//
// Either --number (task number) or --message-id (short or full) — at
// least one is required. Each instance of a flag can be repeated to
// claim several tasks in one call.

import type { Command } from "commander";
import type { AgentApiTaskClaimBody, AgentApiTaskClaimSuccessResponse } from "@botiverse/raft-shared";
import { TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU, TASK_V2_USE_CREATE_ERROR_CODE } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { cliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { apiFailureError, rateLimitedResponseError } from "../_apiFailure";
import { PEER_KIND_OPTION, requireTargetAlias, type TargetAliasOpts } from "../_target";
import {
  reviewerIsolationEnabled,
  reviewerIsolationOption,
  type ReviewerIsolationOpts,
} from "../reviewerIsolation";
import { formatClaimResults } from "./_format";
import { NO_TASK_NAMED_MESSAGE, resolveTaskAddress, TASK_REF_ARGUMENT } from "./_taskAddress";
import { writeHeldTaskWrite } from "../freshness/_taskHold";

interface ClaimOpts extends TargetAliasOpts, ReviewerIsolationOpts {
  number?: string[];
  messageId?: string[];
}

function isTaskClaimSuccessResponse(data: unknown): data is AgentApiTaskClaimSuccessResponse {
  return Boolean(data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results));
}

export const taskClaimCommand = defineCommand(
  {
    name: "claim",
    description: "Claim one or more tasks (by task ref, task number or message id)",
    arguments: [TASK_REF_ARGUMENT],
    usage: '"#channel:#7"  (or --target "#channel" --number 7 [--number 8 ...] / --message-id <id>)',
    options: [
      { flags: "--target <target>", description: "The task's board: '#channel' or 'dm:@peer' (with --number / --message-id), instead of a ref" },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      PEER_KIND_OPTION,
      {
        flags: "--number <n>",
        description: "Task number to claim (repeatable)",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      {
        flags: "--message-id <id>",
        description: "Message id (full or short) to claim (repeatable)",
        parse: (value, prev: string[] = []) => prev.concat(value),
      },
      reviewerIsolationOption,
    ],
    guidance: [
      "Servers with task conversations:",
      "  --message-id does not claim there: the whole call does nothing and fails with code task_v2_use_create,",
      "  printing what to run instead — for a message that has tasks, one claim per task:",
      "    raft task claim --target \"#channel\" --number <N>",
      "  for a message without a task, create one from it and take it:",
      "    raft task create --target \"#channel\" --message-id <id> --title \"…\" --assignee @you",
    ].join("\n"),
  },
  async (ctx, refArg: string | undefined, opts: ClaimOpts = {}) => {
      let channel: string;
      let numbers: number[];
      const messageIds = opts.messageId ?? [];
      if (refArg?.trim()) {
        // One task by its ref; --number may only repeat it, and a message id
        // names something else.
        if (messageIds.length > 0) {
          throw cliError("INVALID_ARG", "Give a task ref or --message-id, not both.");
        }
        const extra = opts.number ?? [];
        if (extra.length > 1) {
          throw cliError("INVALID_ARG", "A task ref names one task; to claim several, use --target with one --number each.");
        }
        const address = resolveTaskAddress(refArg, { ...opts, number: extra[0] });
        channel = address.channel;
        numbers = [address.taskNumber];
      } else {
        if (!opts.target?.trim() && !opts.channel?.trim() && (opts.number ?? []).length === 0 && messageIds.length === 0) {
          throw cliError("INVALID_ARG", NO_TASK_NAMED_MESSAGE);
        }
        channel = requireTargetAlias(opts);
        numbers = (opts.number ?? []).map((raw) => {
          const n = Number(raw);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            throw cliError("INVALID_ARG", `--number must be a positive integer; got ${raw}`);
          }
          return n;
        });
      }

      if (numbers.length === 0 && messageIds.length === 0) {
        throw cliError("INVALID_ARG", "Provide at least one --number or --message-id");
      }

      const body: AgentApiTaskClaimBody = { channel };
      const reviewerIsolation = reviewerIsolationEnabled(opts, ctx.env);
      if (numbers.length > 0) body.task_numbers = numbers;
      if (messageIds.length > 0) body.message_ids = messageIds;
      if (reviewerIsolation) body.freshnessContextMode = "withheld";

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const agentApi = createAgentApiSurfaceClient(client);
      let res;
      try {
        res = await agentApi.tasks.claim(body);
      } catch (err) {
        if (reviewerIsolation) {
          throw cliError(
            "CLAIM_FAILED",
            "Reviewer-isolation task claim failed; upstream response detail was withheld.",
            { cause: err },
          );
        }
        throw err;
      }
      if (!res.ok) {
        // The budget's sentence carries only counts, so reviewer isolation shows it too.
        const rateLimited = rateLimitedResponseError(res);
        if (rateLimited) throw rateLimited;
        if (reviewerIsolation) {
          const code = res.status >= 500 ? "SERVER_5XX" : "CLAIM_FAILED";
          throw cliError(
            code,
            `Reviewer-isolation task claim failed (HTTP ${res.status}); upstream error detail was withheld.`,
          );
        }
        if (res.errorCode === TASK_V2_USE_CREATE_ERROR_CODE) {
          // Nothing was claimed; the server's text lists the commands to use instead.
          throw cliError(TASK_V2_USE_CREATE_ERROR_CODE, res.error ?? `HTTP ${res.status}`);
        }
        if (res.status >= 500 && res.errorCode === "agent_proxy_failed") {
          // Next action comes from the shared per-failure_class default.
          throw apiFailureError(res, "CLAIM_FAILED");
        }
        const code = res.status >= 500 ? "SERVER_5XX" : "CLAIM_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }
      if (!res.data) {
        throw cliError("INVALID_JSON_RESPONSE", "Agent API taskClaim returned an empty response body");
      }
      if (writeHeldTaskWrite(ctx, agentContext.agentId, "task_claim", body, res.data, { reviewerIsolation })) return;
      if (!isTaskClaimSuccessResponse(res.data)) {
        throw cliError("INVALID_JSON_RESPONSE", "Agent API taskClaim returned an unexpected response body");
      }
      writeText(ctx.io, adoptCliReplyText(formatClaimResults(channel, res.data) + "\n"));

      // A claim that succeeded for nothing must not exit 0. `claim` carries a
      // batch payload, so per-item refusals come back inside a 200 body and
      // never reach the `cliError` paths above — meaning `raft task claim && …`
      // used to run its right-hand side after every item was refused, while
      // unclaim/update/assign/unassign/convert/delete all exit non-zero on
      // failure. Deliberately keyed on ZERO successes, not "any failure": a
      // partial claim did do work, and reporting that as failure would make the
      // caller re-drive tasks it already holds. The thrown error repeats only a
      // one-line-per-refusal summary; the per-row payload above stays the
      // authoritative account of what happened.
      // "already claimed by you" is carried as a refusal (taskService returns a
      // reason string, so `success` is false), but it answers the only question
      // this exit status exists to answer — may I work on this task? — with
      // yes. Re-confirming a claim you already hold is behaviour the product
      // deliberately supports, so it must not read as failure: the prompt tells
      // agents not to start work when a claim fails, which would stop an agent
      // working on its own task.
      const authorisesWork = (r: { success: boolean; reason?: string | null }) =>
        r.success || r.reason === TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU;
      // No `length > 0` guard. An empty result set is the shape that most literally means
      // "nothing was claimed", so guarding it would exit 0 on exactly the case this exit code
      // exists for (@Maggie, #6549 review). NOT a behaviour fix: the empty-results response is
      // unreachable from this command — the input check above rejects a request with no numbers
      // and no message ids, so `results` cannot come back empty. Verified by trying to write a
      // test for it: the attempt only ever reaches the input guard. Removed because the guard
      // asserted something the invariant contradicts, not because it was live.
      if (!res.data.results.some(authorisesWork)) {
        // Typed, self-sufficient stderr. The bare `CliExit(1)` this replaces
        // relied on the stdout account above surviving to the reader — but a
        // batched invocation (`raft task claim … && raft message send …`) or a
        // harness that surfaces only stderr on non-zero exit loses stdout
        // entirely, leaving "Code: INTERNAL_BUG" as the whole story (task #60,
        // three cross-seat specimens). The error therefore repeats the one
        // decision-relevant line per refusal: who holds the lock, or why the
        // claim was refused. The stdout account above stays the full record.
        const conflicts = res.data.results.filter((r) => !authorisesWork(r));
        const anyLock = conflicts.some((r) => r.conflict?.kind === "claim_conflict");
        const summary = conflicts
          .map((r) => {
            const label = r.taskNumber ? `#${r.taskNumber}` : `msg:${r.messageId}`;
            const holder = r.conflict?.kind === "claim_conflict" && r.conflict.currentAssignee?.name
              ? `held by @${r.conflict.currentAssignee.name}`
              : (r.reason || "refused");
            return `${label} ${holder}`;
          })
          .join("; ");
        throw cliError(
          anyLock ? "CLAIM_CONFLICT" : "CLAIM_FAILED",
          `Claim refused — ${summary}. This is a concurrency lock or refusal, not a tool error and not a ruling on lane ownership.`,
          {
            suggestedNextAction:
              "Do not retry the identical claim and do not start conflicting execution. If you are this lane's canonical owner, correct the routing in the original thread.",
          },
        );
      }
  },
);

export function registerTaskClaimCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, taskClaimCommand, runtimeOptions);
}
