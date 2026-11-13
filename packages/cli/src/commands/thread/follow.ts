// `raft thread follow --target <thread>` (parity with `raft task follow`)
// → POST /internal/agent-api/threads/follow

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText, adoptCliReplyText } from "../../core/renderer";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { applyDmPeerKind, PEER_KIND_OPTION } from "../_target";
import { apiFailureError } from "../_apiFailure";
import { parseThreadTarget } from "./unfollow";

interface FollowOpts {
  target?: string;
  peerKind?: string;
}

export function formatFollowThreadResult(target: string, changed: boolean): string {
  return [
    changed
      ? `Following ${target}. New replies in this thread wake you; earlier replies are not unread.`
      : `Already following ${target}. Nothing changed.`,
    `To stop: raft thread unfollow --target ${JSON.stringify(target)}`,
  ].join("\n");
}

export const threadFollowCommand = defineCommand(
  {
    name: "follow",
    description: "Follow a thread: its new replies wake you",
    options: [
      {
        flags: "--target <target>",
        description: "Thread target, e.g. '#engineering:abcd1234' or 'dm:@alice:abcd1234'",
      },
      PEER_KIND_OPTION,
    ],
  },
  async (ctx, opts: FollowOpts) => {
    const thread = parseThreadTarget(applyDmPeerKind(opts.target?.trim() ?? "", opts.peerKind));
    if (!thread) {
      throw new CliError({
        code: "INVALID_TARGET",
        message: "Thread must be a thread target like '#channel:abcd1234', 'dm:@peer:abcd1234', or a thread channel UUID. Follow a task with: raft task follow \"#channel:#7\"",
      });
    }

    const agentContext = ctx.loadAgentContext();
    const agentApi = createAgentApiSurfaceClient(ctx.createApiClient(agentContext));
    const res = await agentApi.threads.follow({ thread });
    if (!res.ok) throw apiFailureError(res, res.status === 404 ? "NOT_FOUND" : "FOLLOW_FAILED");
    if (!res.data) {
      throw new CliError({ code: "INVALID_JSON_RESPONSE", message: "Agent API threadFollow returned an empty response body" });
    }

    writeText(ctx.io, adoptCliReplyText(`${formatFollowThreadResult(thread, res.data.changed)}\n`));
  },
);

export function registerThreadFollowCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, threadFollowCommand, runtimeOptions);
}
