// `raft manual get <topic>` — GET /internal/agent-api/knowledge?topic=...
// `slock knowledge get <topic>` remains a compatibility alias.
//
// Interim thin command (per @cindyz unblock #engineering:14d34608 msg=0a4c283c
// "slock cli 重构不 block 功能开发" + task #445). Migrates into the new
// command framework when the CLI architecture RFC v0.4 stack (task #242,
// HaoHao) lands.
//
// Server endpoint:
//   - `/internal/agent-api/knowledge?topic=<path>&intent=<text>&reason=<text>&turn_id=<id>&trace_id=<id>`
//     for managed-runner / self-hosted-runner.
//   - Requires `knowledge:read` scope on the credential; `DEFAULT_ACTIVE_CAPABILITIES`
//     in cliTransport.ts already includes `knowledge`.
//   - Success response: `{ ok: true, docId, topicOrPath, docVersion, docState, contentType, content }`.
//   - 404: `{ ok: false, code: "knowledge_not_found", error }`.
//
// Byte-preserving output: per the agent payload sanitation contract agreed
// in #engineering:30f5f012 (msg=22d1eea3 + msg=f8aaf7a6), the server is the
// only place that may strip source-only editorial comment blocks. This command
// writes the server-served content to stdout unchanged. The CLI must not
// parse, render, or strip component-shaped tokens or source comments.

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError, type CliErrorCode } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { formatManualIndexCommand, requireKnowledgeContexts } from "./context.js";

export interface KnowledgeGetOptions {
  intent?: string;
  reason?: string;
  turnId?: string;
  traceId?: string;
}

export function formatKnowledgeStdout(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function toKnowledgeErrorCode(errorCode: string | null | undefined, status: number): CliErrorCode {
  switch (errorCode) {
    case "INVALID_JSON_RESPONSE":
    case "SCOPE_DENIED":
    case "knowledge_agent_missing":
    case "knowledge_internal_error":
    case "knowledge_intent_invalid":
    case "knowledge_not_found":
    case "knowledge_reason_invalid":
    case "knowledge_source_invalid":
    case "knowledge_topic_invalid":
    case "knowledge_trace_id_invalid":
    case "knowledge_turn_id_invalid":
    case "unsupported_capability":
      return errorCode;
    default:
      return status >= 500 ? "SERVER_5XX" : "KNOWLEDGE_GET_FAILED";
  }
}

export const knowledgeGetCommand = defineCommand(
  {
    name: "get",
    description: "Fetch a Raft Manual for Agents topic from the current server",
    arguments: ["<topic>"],
    options: [
      {
        flags: "--intent <text>",
        description: "Required: what the user ultimately wants to accomplish with Raft (12-500 chars)",
      },
      {
        flags: "--reason <text>",
        description: "Required: why Manual is needed at this point (12-500 chars)",
      },
      {
        flags: "--turn-id <id>",
        description: "Diagnostic: override the turn id recorded on the knowledge event",
        hidden: true,
      },
      {
        flags: "--trace-id <id>",
        description: "Diagnostic: override the trace id recorded on the knowledge event",
        hidden: true,
      },
    ],
    helpAfter:
      "\nTopics:\n"
      + "  Use this to list available manual topics:\n"
      + "  raft manual get index --intent \"Learn available Raft workflows\" --reason \"Need the topic catalog before answering\"\n",
  },
  async (ctx, topic: string, opts: KnowledgeGetOptions) => {
    const { intent, reason } = requireKnowledgeContexts(opts.intent, opts.reason);
    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).knowledge.get({
      topic,
      intent,
      reason,
      turn_id: opts.turnId,
      trace_id: opts.traceId,
    });
    if (!res.ok) {
      throw new CliError({
        code: toKnowledgeErrorCode(res.errorCode, res.status),
        message: res.error ?? `HTTP ${res.status}`,
        suggestedNextAction: res.suggestedNextAction ??
          (res.errorCode === "knowledge_not_found"
            ? `No topic matched. Retry with a close topic id, keeping your --intent/--reason. To browse all topics, run:\n${formatManualIndexCommand()}`
            : undefined),
      });
    }
    const data = res.data;
    if (!data || data.ok !== true) {
      throw new CliError({
        code: "KNOWLEDGE_GET_FAILED",
        message: "Server returned an unexpected response shape",
      });
    }
    writeText(ctx.io, adoptCliReplyText(formatKnowledgeStdout(data.content)));
  },
);

export function registerKnowledgeGetCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, knowledgeGetCommand, runtimeOptions);
}
