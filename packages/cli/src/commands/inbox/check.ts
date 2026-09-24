import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { createDaemonApiSurfaceClient } from "../../daemonApiPath.js";
import {
  formatAgentInboxFullSnapshot,
  formatInboxSnapshot,
  type InboxAppItem,
  type InboxTargetRow,
} from "./_format.js";

export const inboxCheckCommand = defineCommand(
  {
    name: "check",
    description: "Show pending inbox targets without draining or reading message content.",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    if (agentContext.clientMode !== "managed-runner") {
      throw new CliError({
        code: "INBOX_CHECK_FAILED",
        message: "`raft inbox check` is only available inside managed daemon runners.",
        suggestedNextAction: "Use `raft message check` to drain messages.",
      });
    }
    const client = ctx.createApiClient(agentContext);
    const response = await createDaemonApiSurfaceClient(client).inbox.check();
    if (!response.ok) {
      throw new CliError({
        code: response.status >= 500 ? "SERVER_5XX" : "INBOX_CHECK_FAILED",
        message: response.error ?? `HTTP ${response.status}`,
      });
    }
    const rows = (response.data?.rows ?? []) as InboxTargetRow[];
    type InboxItemWire = { source: string } & Partial<InboxAppItem>;
    const rawItems = (response.data as { items?: InboxItemWire[] } | null | undefined)?.items ?? [];
    const appItems = rawItems.filter((item): item is InboxAppItem => item.source === "app");
    writeText(
      ctx.io, adoptCliReplyText(
      `${formatAgentInboxFullSnapshot({
        messageRows: rows,
        appItems,
        formatMessageRows: formatInboxSnapshot,
      })}\n`,
    ));
  },
);

export function registerInboxCheckCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, inboxCheckCommand, runtimeOptions);
}
