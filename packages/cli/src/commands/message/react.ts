// `raft message react --message-id <id> --emoji <emoji> [--remove]`
// → POST/DELETE /internal/agent-api/messages/:messageId/reactions

import type { Command } from "commander";

import { asMessageId } from "@botiverse/raft-shared";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";

interface ReactOpts {
  messageId: string;
  emoji: string;
  remove?: boolean;
}

export function normalizeReactionEmoji(value: string): string {
  const emoji = value.trim();
  if (!emoji || emoji.length > 16 || /\s/.test(emoji)) {
    throw new Error("A single reaction emoji is required");
  }
  return emoji;
}

export const messageReactCommand = defineCommand(
  {
    name: "react",
    description: "Add or remove your reaction on a message",
    options: [
      { flags: "--message-id <id>", description: "Message id (full or short) to react to" },
      { flags: "--emoji <emoji>", description: "Reaction emoji" },
      { flags: "--remove", description: "Remove your reaction instead of adding it" },
    ],
    helpAfter:
      "\nAgent guidance:\n" +
      "  Use this only when a human explicitly asks for a reaction or when a reaction is a clear acknowledgement.\n" +
      "  Do not auto-react to every merge, deploy, task completion, or routine status update.\n",
  },
  async (ctx, opts: ReactOpts) => {
      if (!opts.messageId?.trim()) {
        throw cliError("INVALID_ARG", "--message-id is required");
      }
      if (typeof opts.emoji !== "string") {
        throw cliError("INVALID_ARG", "--emoji is required");
      }

      let emoji: string;
      try {
        emoji = normalizeReactionEmoji(opts.emoji);
      } catch (err) {
        throw cliError("INVALID_REACTION", err instanceof Error ? err.message : "Invalid reaction emoji", { cause: err });
      }

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const agentApi = createAgentApiSurfaceClient(client);
      const messageId = asMessageId(opts.messageId.trim());
      const res = opts.remove
        ? await agentApi.messages.removeReaction({ msgId: messageId }, { emoji })
        : await agentApi.messages.addReaction({ msgId: messageId }, { emoji });
      if (!res.ok) {
        const code = res.status >= 500 ? "SERVER_5XX" : "REACT_FAILED";
        throw cliError(code, res.error ?? `HTTP ${res.status}`);
      }

      const verb = opts.remove ? "removed from" : "added to";
      writeText(ctx.io, adoptCliReplyText(`Reaction ${emoji} ${verb} message ${opts.messageId.slice(0, 8)}.\n`));
  },
);

export function registerReactCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, messageReactCommand, runtimeOptions);
}
