// `raft action withdraw --message <id> [--json]`
// → POST /internal/agent-api/actions/:messageId/withdraw (question-card spec §4.4)
//
// The agent that posted a question card (`question:ask`, `raft action
// prepare`) takes it back while nobody has answered it. No reply is posted,
// so this command's output is the agent's receipt. `--message` is passed as
// given (trimmed): the Server decides which ids and prefixes name one of the
// agent's question cards, and its NOT_FOUND / AMBIGUOUS_MESSAGE_ID say what
// to pass instead.
//
// Exit 0: withdrawn, or already withdrawn (nothing changed). Exit 1 for every
// refusal: answered first (ALREADY_ANSWERED: the answers on stdout, then the
// error), expired (QUESTION_EXPIRED), another agent's card (NOT_REQUESTER),
// no such card (NOT_FOUND), a prefix of two cards (AMBIGUOUS_MESSAGE_ID).
// The SDK's `actions.withdraw` is the same operation with the same words.

import type { Command } from "commander";

import type { RaftFailure } from "@botiverse/raft-shared";
import { withdrawQuestionCard } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient, createCliOperationFailures } from "../../agentApiPath";
import type { ApiResponse } from "../../client";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { writeJson, writeText } from "../../core/renderer";
import { formatQuestionCardAnsweredFirst, formatQuestionCardWithdrawn } from "./_format";

interface WithdrawOpts {
  message?: string;
  json?: boolean;
}

const ALREADY_ANSWERED = "ALREADY_ANSWERED";

/** The card's metadata a 409 ALREADY_ANSWERED carries (its answers), or undefined. */

/** The Server's own step for an id it can't match (NOT_FOUND), for the same mistake caught before sending. */
const QUESTION_WITHDRAW_ID_NEXT_STEP = "Pass the card's message id, or its first 8 characters, as raft action prepare printed them.";

function answeredMetadata(response: ApiResponse<unknown> | null): unknown {
  const body = response?.errorBody;
  return body && typeof body === "object" ? (body as { metadata?: unknown }).metadata : undefined;
}

/**
 * A refused withdraw: the Server's code as it sent it (WITHDRAW_FAILED when it
 * sent none), the operation's sentence and next step, retryable as mapped. A
 * 5xx is SERVER_5XX with the Server's error. ALREADY_ANSWERED keeps the
 * card's metadata (the answers) in `details`, as the Server sent it.
 */
function withdrawCliError(failure: RaftFailure, response: ApiResponse<unknown> | null): CliError {
  const { error } = failure;
  if (error.code === "INVALID_REQUEST") return cliError("INVALID_ARG", error.message, { suggestedNextAction: error.nextAction ?? QUESTION_WITHDRAW_ID_NEXT_STEP });
  if (response && response.status >= 500) {
    return new CliError({ code: "SERVER_5XX", message: response.error ?? `HTTP ${response.status}` });
  }
  const code = error.serverCode ?? "WITHDRAW_FAILED";
  // Without a step from the Server or the operation, the SDK's generic one adds nothing to the Code line.
  const nextAction = error.code === "HTTP_ERROR" && !response?.suggestedNextAction && !error.serverCode ? undefined : error.nextAction;
  const metadata = code === ALREADY_ANSWERED ? answeredMetadata(response) : undefined;
  return cliError(code, error.message, {
    suggestedNextAction: nextAction,
    retryable: error.retryable,
    ...(metadata !== undefined ? { details: { metadata } } : {}),
  });
}

async function withdraw(ctx: CommandContext, opts: WithdrawOpts): Promise<void> {
  const messageId = (opts.message ?? "").trim();
  if (!messageId) {
    throw cliError("INVALID_ARG", "--message <id> is required: the question card's message id as raft action prepare printed it (its short id will do).");
  }
  // The contract takes 8-64 characters; anything else would be refused before it is sent, without a next step.
  if (messageId.length < 8 || messageId.length > 64) {
    throw cliError("INVALID_ARG", `--message ${messageId} is not a message id: it needs the full id or at least its first 8 characters.`, {
      suggestedNextAction: QUESTION_WITHDRAW_ID_NEXT_STEP,
    });
  }
  const agentContext = ctx.loadAgentContext();
  // The SDK's actions.withdraw: same request, same words. A transport failure
  // or a daemon-proxy 5xx throws as other commands' requests do.
  const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
  const failures = createCliOperationFailures();
  const outcome = await withdrawQuestionCard({
    actions: { ...api.actions, withdraw: (params) => failures.observe(api.actions.withdraw(params)) },
  }, { messageId });
  if (!outcome.ok) {
    const err = withdrawCliError(outcome, failures.last());
    // Answered first: the answers are what the agent reads instead of a receipt (stdout), then the refusal (stderr).
    if (outcome.error.serverCode === ALREADY_ANSWERED && !opts.json) {
      writeText(ctx.io, formatQuestionCardAnsweredFirst(messageId, answeredMetadata(failures.last())));
    }
    throw err;
  }
  if (opts.json) {
    writeJson(ctx.io, { ok: true, state: outcome.state, ...outcome.data });
    return;
  }
  // The operation's text (`outcome.text`), through the registered surface.
  writeText(ctx.io, formatQuestionCardWithdrawn(outcome.data));
}

export const actionWithdrawCommand = defineCommand(
  {
    name: "withdraw",
    description: "Withdraw a question card you posted, while nobody has answered it",
    options: [
      {
        flags: "--message <id>",
        description: "The question card's message id, as raft action prepare printed it (the short id will do)",
      },
      { flags: "--json", description: "Emit machine-readable JSON (errors too)" },
    ],
    helpAfter:
      "\nTakes back a question card (question:ask) you posted with raft action prepare: the person can no longer answer it.\n" +
      "No reply is posted; the output is your receipt. Withdrawing it again changes nothing and says so.\n" +
      "Only the agent that asked can withdraw a card, only a question card, and only while nobody has answered it.\n" +
      "If it was answered first, nothing is withdrawn: the answers are printed and the command exits 1 (ALREADY_ANSWERED);\n" +
      "they also came to you as a reply in the card's thread. An expired card exits 1 too (QUESTION_EXPIRED).\n" +
      "Example:\n" +
      "  raft action withdraw --message 1a2b3c4d\n",
  },
  async (ctx, opts: WithdrawOpts) => {
    try {
      await withdraw(ctx, opts);
    } catch (err) {
      // With --json the error is JSON too.
      if (opts.json && err instanceof CliError && err.outputMode === undefined) err.outputMode = "json";
      throw err;
    }
  },
);

export function registerActionWithdrawCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, actionWithdrawCommand, runtimeOptions);
}
