// `raft message resolve <id>` — exact message-id verifier.
// This command is deliberately stricter than `message read --around`: it never
// falls back to nearby context and exists to prove whether a cited id resolves.

import type { Command } from "commander";

import { asMessageId } from "@botiverse/raft-shared";
import type { ApiResponse } from "../../client.js";
import { buildAgentApiRoutePath, createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { CliError, type CliErrorCode } from "../../core/errors.js";
import { writeText, NL } from "../../core/renderer.js";
import { formatMessages } from "./_format.js";

interface ResolveMessageData {
  message?: {
    message_id?: string;
    channel_type?: string;
    channel_name?: string;
    parent_channel_type?: string | null;
    parent_channel_name?: string | null;
    timestamp?: string;
    sender_type?: string;
    sender_name?: string;
    sender_description?: string | null;
    content?: string;
    [key: string]: unknown;
  };
}

export function buildResolvePath(id: string): string {
  return buildAgentApiRoutePath("messageResolve", { msgId: asMessageId(id) });
}

function mapResolveError(res: ApiResponse<unknown>): {
  code: CliErrorCode;
  message: string;
  suggestedNextAction?: string;
} {
  const message = res.error ?? `HTTP ${res.status}`;
  if (res.errorCode === "AMBIGUOUS_ID") {
    return {
      code: "AMBIGUOUS_ID",
      message,
      suggestedNextAction: "Use the full message UUID instead of the 8-character short id.",
    };
  }
  if (res.errorCode === "NOT_FOUND" || res.status === 404) {
    return {
      code: "NOT_FOUND",
      message,
      suggestedNextAction: "Use raft message search to find the message, or raft message read --around only when you want nearby context rather than proof that this id exists.",
    };
  }
  if (res.errorCode === "INVALID_ARG" || res.status === 400) {
    return { code: "INVALID_ARG", message };
  }
  return {
    code: res.status >= 500 ? "SERVER_5XX" : "READ_FAILED",
    message,
  };
}

export const messageResolveCommand = defineCommand(
  {
    name: "resolve",
    description: "Resolve a message id exactly and print the canonical message",
    arguments: ["<id>"],
  },
  async (ctx, rawId: string) => {
    const id = rawId?.trim();
    if (!id) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "<id> is required",
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).messages.resolve({ msgId: asMessageId(id) });
    if (!res.ok) {
      const mapped = mapResolveError(res);
      throw new CliError(mapped);
    }
    const message: ResolveMessageData["message"] = res.data?.message;
    if (!message) {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "Missing message in resolve response",
      });
    }
    writeText(ctx.io, formatMessages([{
      ...message,
      parent_channel_type: message.parent_channel_type ?? undefined,
      parent_channel_name: message.parent_channel_name ?? undefined,
    }]), NL);
  },
);

export function registerResolveCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageResolveCommand, runtimeOptions);
}
