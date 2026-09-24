// `raft mention notify <id...>` / `raft mention add <id...>`
// → POST /internal/agent-api/mention-actions/execute

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeJson, writeText } from "../../core/renderer.js";
import {
  formatMentionActionResults,
  normalizeMentionActionResults,
  type MentionActionKind,
} from "./_format.js";

interface ExecuteOpts {
  json?: boolean;
}

function resultSucceeded(action: MentionActionKind, status: string): boolean {
  return action === "notify" ? status === "queued" : status === "delivered";
}

function formatFailedMentionActions(
  action: MentionActionKind,
  requestedIds: string[],
  results: ReturnType<typeof normalizeMentionActionResults>,
): string | null {
  const returnedIds = new Set(results.map((result) => result.resolutionId));
  const failures = results
    .filter((result) => !resultSucceeded(action, result.status))
    .map((result) => `${result.resolutionId}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  for (const id of requestedIds) {
    if (!returnedIds.has(id)) failures.push(`${id}: missing_result`);
  }
  return failures.length > 0 ? failures.join(", ") : null;
}

function normalizeResolutionIds(rawIds: string[] | undefined): string[] {
  const ids = (rawIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw cliError("INVALID_ARG", "At least one resolution id is required.");
  }
  return ids;
}

export function buildMentionExecuteCommand(action: MentionActionKind) {
  return defineCommand(
    {
      name: action,
      description: `${action === "notify" ? "Notify" : "Add"} unresolved mention targets by resolution id`,
      arguments: ["<resolutionIds...>"],
      options: [{ flags: "--json", description: "Emit machine-readable JSON" }],
    },
    async (ctx, resolutionIds: string[], opts: ExecuteOpts = {}) => {
      const ids = normalizeResolutionIds(resolutionIds);
      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const res = await createAgentApiSurfaceClient(client).mentions.executeAction({
        action,
        resolutionIds: ids,
      });
      if (!res.ok || !res.data) {
        throw cliError(res.status >= 500 ? "SERVER_5XX" : "MENTION_ACTION_FAILED", res.error ?? `HTTP ${res.status}`);
      }

      const results = normalizeMentionActionResults(res.data);
      const failure = formatFailedMentionActions(action, ids, results);
      if (failure) {
        throw cliError(
          "MENTION_ACTION_FAILED",
          `Mention ${action} did not complete for every requested target: ${failure}`,
        );
      }
      if (opts.json) {
        writeJson(ctx.io, { ok: true, action, results });
        return;
      }

      writeText(ctx.io, formatMentionActionResults(action, results));
    },
  );
}

export function registerMentionExecuteCommands(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, buildMentionExecuteCommand("notify"), runtimeOptions);
  registerCliCommand(parent, buildMentionExecuteCommand("add"), runtimeOptions);
}
