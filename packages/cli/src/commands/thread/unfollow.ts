// `raft thread unfollow --target <thread>`
// → POST /internal/agent-api/threads/unfollow

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { applyDmPeerKind, PEER_KIND_OPTION } from "../_target";

interface UnfollowOpts {
  target?: string;
  reason?: string;
  peerKind?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;

export function parseThreadTarget(target: string): string | null {
  const trimmed = target.trim();
  if (UUID_RE.test(trimmed)) return trimmed;

  if (trimmed.startsWith("#")) {
    const rest = trimmed.slice(1);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0 && SHORT_ID_RE.test(rest.slice(lastColon + 1))) {
      return trimmed;
    }
  }

  if (trimmed.startsWith("dm:@") || trimmed.startsWith("DM:@")) {
    const rest = trimmed.slice(4);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0 && SHORT_ID_RE.test(rest.slice(lastColon + 1))) {
      return trimmed;
    }
  }

  return null;
}

export function formatUnfollowThreadResult(target: string): string {
  return [
    `Unfollowed ${target}. Ordinary delivery for this thread has stopped.`,
    `A later personal @mention arrives and re-follows you; that delivery reminds you to run: raft thread unfollow --target ${JSON.stringify(target)}`,
    "Posting in this thread re-follows you automatically.",
  ].join("\n");
}

export const threadUnfollowCommand = defineCommand(
  {
    name: "unfollow",
    description: "Stop following a thread you no longer need ordinary delivery for",
    options: [
      {
        flags: "--target <target>",
        description: "Thread target, e.g. '#engineering:abcd1234' or 'dm:@alice:abcd1234'",
      },
      PEER_KIND_OPTION,
      {
        flags: "--reason <reason>",
        description: "Short reason shown in the thread-local unfollow notice",
      },
    ],
  },
  async (ctx, opts: UnfollowOpts) => {
    const thread = parseThreadTarget(applyDmPeerKind(opts.target?.trim() ?? "", opts.peerKind));
    if (!thread) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Thread must be a thread target like '#channel:abcd1234', 'dm:@peer:abcd1234', or a thread channel UUID.",
      });
    }

    const agentContext = ctx.loadAgentContext();
    const client = ctx.createApiClient(agentContext);
    const agentApi = createAgentApiSurfaceClient(client);
    const reason = opts.reason?.trim();
    const res = await agentApi.threads.unfollow(reason ? { thread, reason } : { thread });
    if (!res.ok) {
      throw new CliError({
        code: res.status >= 500 ? "SERVER_5XX" : "UNFOLLOW_FAILED",
        message: res.error ?? `HTTP ${res.status}`,
      });
    }

    writeText(ctx.io, adoptCliReplyText(formatUnfollowThreadResult(thread) + "\n"));
  },
);

export function registerThreadUnfollowCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, threadUnfollowCommand, runtimeOptions);
}
