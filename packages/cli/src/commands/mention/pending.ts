// `raft mention pending [--json]`
// → GET /internal/agent-api/mention-actions/pending

import type { Command } from "commander";

import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeJson, writeText } from "../../core/renderer.js";
import { formatPendingMentionActions, normalizePendingMentionActions } from "./_format.js";

interface PendingOpts {
  json?: boolean;
}

export const mentionPendingCommand = defineCommand(
  {
    name: "pending",
    description: "List sender-side pending mention actions",
    options: [{ flags: "--json", description: "Emit machine-readable JSON" }],
  },
  async (ctx, opts: PendingOpts = {}) => {
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).mentions.pendingActions();
    if (!res.ok || !res.data) {
      throw cliError(res.status >= 500 ? "SERVER_5XX" : "MENTION_PENDING_FAILED", res.error ?? `HTTP ${res.status}`);
    }

    const actions = normalizePendingMentionActions(res.data);
    if (opts.json) {
      writeJson(ctx.io, { ok: true, pendingMentionActions: actions });
      return;
    }

    writeText(ctx.io, formatPendingMentionActions(actions, { source: "pending" }));
  },
);

export function registerMentionPendingCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, mentionPendingCommand, runtimeOptions);
}
