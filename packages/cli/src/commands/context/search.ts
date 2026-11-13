// `raft context search --message-id <id> --query <text> [--limit N] [--offset N]`
// → POST /internal/agent-api/context/search (#wg-ax:#15)

import type { Command } from "commander";

import type { AgentContextQueryAnswerBody } from "@botiverse/raft-shared";
import {
  AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT,
  AGENT_CONTEXT_SEARCH_MAX_LIMIT,
  AGENT_CONTEXT_SEARCH_MAX_QUERY_CHARS,
  AGENT_BODY_LINE_SEPARATOR,
  foldAgentOneLineText,
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

interface ContextSearchOpts {
  messageId?: string;
  query?: string;
  limit?: string;
  offset?: string;
  json?: boolean;
}

export function formatContextSearch(messageId: string, query: string, offset: number, limit: number, body: AgentContextQueryAnswerBody): string {
  if (body.answer.kind !== "search") throw new Error("not a search answer");
  const { total, matches } = body.answer;
  const quoted = JSON.stringify(query);
  const lines = [`${answerHeader(messageId, body)}:`];
  if (total === 0) {
    lines.push(`No entry matches ${quoted}. The search is literal and ignores case; try a shorter or different word.`);
    return `${lines.join("\n")}\n`;
  }
  if (matches.length === 0) {
    lines.push(`${total} ${total === 1 ? "entry matches" : "entries match"} ${quoted}, none at --offset ${offset}.`);
    lines.push(`From the first: ${contextCommand("search", messageId, [["--query", query]])}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`${total} ${total === 1 ? "entry matches" : "entries match"} ${quoted}; showing ${offset + 1}-${offset + matches.length}:`);
  for (const match of matches) {
    lines.push(`${match.id} ${match.role}/${foldAgentOneLineText(match.type)} (${match.hits} ${match.hits === 1 ? "hit" : "hits"}): ${foldAgentOneLineText(match.line)}`);
  }
  if (offset + matches.length < total) {
    lines.push(`More: ${contextCommand("search", messageId, [["--query", query], ...(limit !== AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT ? [["--limit", limit] as [string, number]] : []), ["--offset", offset + matches.length]])}`);
  }
  lines.push(`Read one with the entries around it: ${contextCommand("read", messageId, [["--around", matches[0]!.id]])}`);
  return `${lines.join("\n")}\n`;
}

export const contextSearchCommand = defineCommand(
  {
    name: "search",
    description: "Search the context behind one message: the entries the model was given when it wrote it",
    options: [
      MESSAGE_ID_OPTION,
      { flags: "--query <text>", description: `Literal text to find, case ignored (at most ${AGENT_CONTEXT_SEARCH_MAX_QUERY_CHARS} characters, one line)` },
      { flags: "--limit <n>", description: `Matches to show (1-${AGENT_CONTEXT_SEARCH_MAX_LIMIT}, default ${AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT})` },
      { flags: "--offset <n>", description: "Matches to skip, for the next page (default 0)" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
    helpAfter:
      "\nExamples:\n"
      + "  raft context search --message-id 1a2b3c4d --query \"deploy\"\n"
      + "  raft context read --message-id 1a2b3c4d --around m4.p0\n"
      + CONTEXT_HELP_AFTER,
  },
  async (ctx, opts: ContextSearchOpts) => {
    const messageId = requireMessageId(opts.messageId);
    const query = opts.query?.trim() ?? "";
    if (!query || query.length > AGENT_CONTEXT_SEARCH_MAX_QUERY_CHARS || AGENT_BODY_LINE_SEPARATOR.test(query)) {
      throw new CliError({
        code: "INVALID_ARG",
        message: `--query is required: one line of at most ${AGENT_CONTEXT_SEARCH_MAX_QUERY_CHARS} characters, e.g. --query "deploy"`,
      });
    }
    const limit = parseWholeFlag("limit", opts.limit, 1, AGENT_CONTEXT_SEARCH_MAX_LIMIT);
    const offset = parseWholeFlag("offset", opts.offset, 0);
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(ctx.loadAgentContext()));
    const res = await agentApi.context.search({
      message_id: messageId,
      query,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    if (!res.ok) {
      throw contextQueryFailure(res, contextCommand("search", messageId, [
        ["--query", query],
        ...(limit !== undefined ? [["--limit", limit] as [string, number]] : []),
        ...(offset !== undefined ? [["--offset", offset] as [string, number]] : []),
      ]));
    }
    const body = requireAnswer(res.data, "search");
    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: body });
      return;
    }
    writeText(ctx.io, adoptCliReplyText(formatContextSearch(messageId, query, offset ?? 0, limit ?? AGENT_CONTEXT_SEARCH_DEFAULT_LIMIT, body)));
  },
);

export function registerContextSearchCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, contextSearchCommand, runtimeOptions);
}
