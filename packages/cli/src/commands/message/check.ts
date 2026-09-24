// `raft message check` — non-blocking drain of /internal/agent-api/events.
//
// Non-blocking is a hard requirement (kuku redline): the CLI must return
// promptly with whatever is in the inbox, never hold the request open.
//
// Agent API /events consumes/acks returned messages server-side; the CLI does
// not perform a separate acknowledgement request.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { drainInbox } from "./_inbox.js";
import { formatMessages } from "./_format.js";

export const messageCheckCommand = defineCommand(
  {
    name: "check",
    description: "Drain the agent inbox (non-blocking). Acks delivered seqs before returning.",
  },
  async (ctx) => {
    const agentContext = ctx.loadAgentContext();
    const result = await drainInbox(
      agentContext,
      { block: false },
      ctx.createApiClient(agentContext),
    );
    const drainStatus = result.hasMore
      ? "\nMore messages are pending. Run `raft message check` again.\n"
      : result.drainComplete
        ? "\nNo more new inbox messages.\n"
        : "\n";
    writeText(ctx.io, adoptCliReplyText(`${formatMessages(result.messages)}${drainStatus}`));
    // `/events` batches are sparse attention drains, not contiguous history
    // slices. Printing a high-seq @mention here must not seed `seenUpToSeq`,
    // or older unseen messages in the same target can be buried as model-seen.
  },
);

export function registerCheckCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageCheckCommand, runtimeOptions);
}
