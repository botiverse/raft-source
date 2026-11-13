// `raft context read --message-id <id> --around <entry> [--limit N] [--page N]`
// → POST /internal/agent-api/context/read (#wg-ax:#15)

import type { Command } from "commander";

import type { AgentContextQueryAnswerBody } from "@botiverse/raft-shared";
import {
  AGENT_BODY_CONTINUATION_PREFIX,
  AGENT_CONTEXT_READ_DEFAULT_LIMIT,
  AGENT_CONTEXT_READ_MAX_LIMIT,
  foldAgentOneLineText,
  indentAgentBodyContinuationLines,
} from "@botiverse/raft-shared/src/agentCliSurface";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { adoptCliReplyText, writeJson, writeText } from "../../core/renderer";
import {
  answerHeader,
  CONTEXT_HELP_AFTER,
  contextCommand,
  contextQueryFailure,
  MESSAGE_ID_OPTION,
  parseWholeFlag,
  requireAnswer,
  requireMessageId,
} from "./_shared";

/** An entry id as `raft context search` prints it: `s<i>` system, `t<i>` tool definition, `m<i>.p<j>` a message's part. */
const ENTRY_ID = /^(?:s\d+|t\d+|m\d+\.p\d+)$/;

interface ContextReadOpts {
  messageId?: string;
  around?: string;
  limit?: string;
  page?: string;
  json?: boolean;
}

export function formatContextRead(messageId: string, around: string, body: AgentContextQueryAnswerBody): string {
  if (body.answer.kind !== "read") throw new Error("not a read answer");
  const header = answerHeader(messageId, body);
  if (!body.answer.found) {
    return `${header}: no entry ${around} in this context.\n`
      + `Find entry ids with: ${contextCommand("search", messageId, [["--query", "<text>"]])}\n`;
  }
  const { entries, omitted } = body.answer;
  const lines = [`${header}, around ${around}:`];
  for (const entry of entries) {
    lines.push(`${entry.id} ${entry.role}/${foldAgentOneLineText(entry.type)}${entry.pages > 1 ? ` (page ${entry.page}/${entry.pages})` : ""}${entry.id === around ? " <- around" : ""}`);
    lines.push(`${AGENT_BODY_CONTINUATION_PREFIX}${indentAgentBodyContinuationLines(entry.text)}`);
  }
  if (omitted > 0) {
    lines.push(`${omitted} ${omitted === 1 ? "entry" : "entries"} of this window left out to keep the answer small: read nearer ones with a smaller --limit, or move --around to them.`);
  }
  for (const entry of entries) {
    if (entry.page < entry.pages) {
      lines.push(`Rest of ${entry.id}: ${contextCommand("read", messageId, [["--around", entry.id], ["--limit", 1], ["--page", entry.page + 1]])}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export const contextReadCommand = defineCommand(
  {
    name: "read",
    description: "Read entries of the context behind one message, around one entry id from `raft context search`",
    options: [
      MESSAGE_ID_OPTION,
      { flags: "--around <entry>", description: "Entry id to centre on, as search prints it (s0, t2, m4.p0)" },
      { flags: "--limit <n>", description: `Entries to show around it (1-${AGENT_CONTEXT_READ_MAX_LIMIT}, default ${AGENT_CONTEXT_READ_DEFAULT_LIMIT})` },
      { flags: "--page <n>", description: "Page of the --around entry's text, for a long one (default 1)" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
    helpAfter:
      "\nExamples:\n"
      + "  raft context read --message-id 1a2b3c4d --around m4.p0\n"
      + "  raft context read --message-id 1a2b3c4d --around m4.p0 --limit 1 --page 2\n"
      + CONTEXT_HELP_AFTER,
  },
  async (ctx, opts: ContextReadOpts) => {
    const messageId = requireMessageId(opts.messageId);
    const around = opts.around?.trim() ?? "";
    if (!ENTRY_ID.test(around)) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `--around must be an entry id as \`raft context search\` prints it (s0, t2, m4.p0)${around ? `; got ${foldAgentOneLineText(around)}` : ""}`,
      });
    }
    const limit = parseWholeFlag("limit", opts.limit, 1, AGENT_CONTEXT_READ_MAX_LIMIT);
    const page = parseWholeFlag("page", opts.page, 1);
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(ctx.loadAgentContext()));
    const res = await agentApi.context.read({
      message_id: messageId,
      around,
      ...(limit !== undefined ? { limit } : {}),
      ...(page !== undefined ? { page } : {}),
    });
    if (!res.ok) {
      throw contextQueryFailure(res, contextCommand("read", messageId, [
        ["--around", around],
        ...(limit !== undefined ? [["--limit", limit] as [string, number]] : []),
        ...(page !== undefined ? [["--page", page] as [string, number]] : []),
      ]));
    }
    const body = requireAnswer(res.data, "read");
    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: body });
      return;
    }
    writeText(ctx.io, adoptCliReplyText(formatContextRead(messageId, around, body)));
  },
);

export function registerContextReadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, contextReadCommand, runtimeOptions);
}
