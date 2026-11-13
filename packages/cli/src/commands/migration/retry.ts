// `raft migration retry`
// → POST /internal/agent-api/migrations/retry (agentApiContract `migrationRetry`)
//
// The calling agent retries, once, its latest move to another Computer after
// it failed because its workspace was too big (within 24 hours, after it
// trimmed the workspace). No arguments: the Server copies everything from the
// failed migration and starts it for the person who started that one. A
// refusal changes nothing and does not use up the retry; the Server's reason
// and next step are shown as sent.
//
// Not retried by the CLI or the daemon proxy (the route has no idempotency
// key); running it again by hand is safe: the Server allows one retry per
// failed migration (ALREADY_RETRIED / MIGRATION_ACTIVE).

import type { Command } from "commander";
import { AGENT_MIGRATION_RETRY_REFUSAL_CODES } from "@botiverse/raft-shared/src/agentCliSurface";
import type { AgentMigrationRetryRefusalCode } from "@botiverse/raft-shared";

import type { ApiResponse } from "../../client";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { apiFailureError, rateLimitedResponseError } from "../_apiFailure";
import { formatMigrationRetryStarted } from "./_format";

const RETRY = "raft migration retry";
const ASK_OWNER = "Ask your owner to start the move again from the web app (Move to Another Computer on your profile).";

/**
 * The Server sends each refusal's reason (`error`) and its one next step
 * (`suggestedNextAction`, #wg-ax:#13), so agents on the SDK see the same text;
 * the CLI shows both as sent. It only decides, per code, whether running the
 * command again can help.
 */
export const MIGRATION_RETRY_RETRYABLE_CODES: ReadonlySet<AgentMigrationRetryRefusalCode> = new Set(["TARGET_UNAVAILABLE"]);

function isRefusalCode(code: string | null | undefined): code is AgentMigrationRetryRefusalCode {
  return typeof code === "string" && Object.hasOwn(AGENT_MIGRATION_RETRY_REFUSAL_CODES, code);
}

function serverNext(res: ApiResponse<unknown>): string | null {
  const next = res.suggestedNextAction?.trim();
  return next ? next : null;
}

export function mapMigrationRetryFailure(res: ApiResponse<unknown>): CliError {
  const rateLimited = rateLimitedResponseError(res, RETRY);
  if (rateLimited) return rateLimited;
  // An older Server has no such route (its catch-all 404); this route never answers 404 itself.
  if (res.status === 404) {
    return new CliError({
      code: "UNSUPPORTED_BY_SERVER",
      message: "This server doesn't support retrying a move yet.",
      suggestedNextAction: "Ask your owner to retry the move from the web app (Move to Another Computer on your profile).",
    });
  }
  if (isRefusalCode(res.errorCode)) {
    return cliError(res.errorCode, res.error?.trim() || "The move can't be retried.", {
      suggestedNextAction: serverNext(res) ?? ASK_OWNER,
      retryable: MIGRATION_RETRY_RETRYABLE_CODES.has(res.errorCode),
    });
  }
  // A 503 sends its own next step (used up: ask the owner; not: run it again),
  // and a local proxy failure gets the proxy's (apiFailureError). Anything else
  // without one (a stale runtime catalog, a 500) still ends in a step to take.
  const proxyFailure = res.errorCode === "agent_proxy_failed";
  return apiFailureError(res, "MIGRATION_RETRY_FAILED", serverNext(res) || proxyFailure ? {} : {
    suggestedNextAction: `Run ${RETRY} again in a few minutes; a refusal or a failure before the move starts does not use up the retry. If it keeps failing, ask your owner.`,
  });
}

export const migrationRetryCommand = defineCommand(
  {
    name: "retry",
    description: "Retry, once, your move to another Computer that failed because your workspace was too big",
    helpAfter:
      "\nNo arguments: it retries your own latest move, to the same Computer, for the person who started it.\n" +
      "Use it only when that move failed because your workspace was too big (its failure message names this command),\n" +
      "within 24 hours, after you deleted what you no longer need or listed it in .raftbackupignore.\n" +
      "You get one retry. A refused retry changes nothing and does not use it up; the error says what to do instead.\n" +
      "Once it starts, the source Computer stops you when you are idle and moves you; there is nothing else to run.\n" +
      "If the retry fails too, a person starts the next move from the web app.\n" +
      "Example:\n" +
      "  raft migration retry\n",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).migrations.retry();
    if (!res.ok) throw mapMigrationRetryFailure(res);
    if (!res.data) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Agent API migrationRetry returned an empty response body",
      });
    }
    writeText(ctx.io, formatMigrationRetryStarted(res.data), NL);
  },
);

export function registerMigrationRetryCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, migrationRetryCommand, runtimeOptions);
}
