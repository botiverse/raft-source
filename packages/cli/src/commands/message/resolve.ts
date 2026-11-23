// `raft message resolve <id>` — exact message-id verifier.
// This command is deliberately stricter than `message read --around`: it never
// falls back to nearby context and exists to prove whether a cited id resolves.
// `--forwarded <n>` prints forwarded message n of a forward whole, where the
// forward's snapshot cut it.

import type { Command } from "commander";

import { asMessageId } from "@botiverse/raft-shared/src/agentCliSurface";
import type { ApiResponse } from "../../client";
import { buildAgentApiRoutePath, createAgentApiSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError, type CliErrorCode } from "../../core/errors";
import { writeText, NL } from "../../core/renderer";
import { formatMessages } from "./_format";
import { elideSeenSenders } from "./_senderElision";

interface ResolveOpts {
  forwarded?: string;
}

interface ResolveMessageData {
  /** With `--forwarded <n>`: that forwarded message, its content not cut. */
  forwarded?: { number?: number; total?: number; content?: string };
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
    /** Where an outside sender is from; printed in place of a description (shared formatSenderHandleText). */
    sender_origin?: unknown;
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
  if (res.errorCode === "HISTORY_LIMITED") {
    // The message exists and this agent may read its channel, but it is older
    // than the server plan's history window: the server's error says so.
    return { code: "HISTORY_LIMITED", message };
  }
  if (res.errorCode === "NOT_FOUND" || res.status === 404) {
    return {
      code: "NOT_FOUND",
      message,
      suggestedNextAction: "Use raft message search to find the message, or raft message read --around only when you want nearby context rather than proof that this id exists.",
    };
  }
  if (res.errorCode === "INVALID_ARG" || res.status === 400) {
    // The Server's step, e.g. the forwarded message numbers this forward has.
    return { code: "INVALID_ARG", message, ...(res.suggestedNextAction ? { suggestedNextAction: res.suggestedNextAction } : {}) };
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
    options: [
      {
        flags: "--forwarded <n>",
        description: "Print forwarded message n of this forward whole (n as in \"Forwarded message n\")",
      },
    ],
    helpAfter:
      "\nTo see the messages around it, use: raft message read --target <target> --around <id>\n",
  },
  async (ctx, rawId: string, opts: ResolveOpts = {}) => {
    const id = rawId?.trim();
    if (!id) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "<id> is required",
      });
    }
    const forwarded = opts.forwarded?.trim();
    if (forwarded !== undefined && !/^[1-9][0-9]*$/.test(forwarded)) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "--forwarded takes a forwarded message number, 1 or more",
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const res = await createAgentApiSurfaceClient(client).messages.resolve(
      { msgId: asMessageId(id) },
      forwarded === undefined ? undefined : { forwarded },
    );
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
    const forwardedItem = res.data?.forwarded;
    if (forwarded !== undefined && typeof forwardedItem?.content !== "string") {
      throw new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: "The Server returned no forwarded message: it may be older than --forwarded",
      });
    }
    // The forward's own header, with that one forwarded message as its body.
    const senders = elideSeenSenders([{
      ...message,
      ...(forwarded !== undefined && { content: forwardedItem!.content }),
      parent_channel_type: message.parent_channel_type ?? undefined,
      parent_channel_name: message.parent_channel_name ?? undefined,
    }], agentContext.agentId);
    writeText(ctx.io, formatMessages(senders.messages), NL);
    await senders.settle(ctx.io);
  },
);

export function registerResolveCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, messageResolveCommand, runtimeOptions);
}
