// `raft artifact follow <artifact>` / `raft artifact unfollow <artifact>`
// → PUT / DELETE /internal/agent-api/artifacts/:artifact/subscription
//
// Following brings others' comments (each at once) and versions that change a file
// you last pushed. Pushing or commenting follows already, unless you
// unfollowed, which sticks; mentions arrive either way.

import type { Command } from "commander";
import { artifactsFollow, artifactsUnfollow } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { writeText } from "../../core/renderer";
import { formatArtifactSubscription } from "./_format";
import { artifactArgument, artifactCliError, refuseExtraArguments, splitArgs } from "./_shared";

interface FollowOpts {
  artifact?: string;
}

const artifactOption = { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" };

function followCommand(follow: boolean) {
  return defineCommand(
    {
      name: follow ? "follow" : "unfollow",
      description: follow
        ? "Follow an artifact: others' comments on it, and versions that change a file you last pushed, reach you"
        : "Stop following an artifact; mentions still reach you, and pushing or commenting won't follow it again",
      arguments: ["[artifact]"],
      options: [artifactOption],
    },
    async (ctx, ...args: unknown[]) => {
      const { positionals, opts } = splitArgs<FollowOpts>(args, 1);
      refuseExtraArguments(args[2], 1, "Name one artifact.");
      const artifact = artifactArgument(positionals[0], opts.artifact);
      const agentContext = ctx.loadAgentContext();
      const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
      const outcome = follow ? await artifactsFollow(api, { artifact }) : await artifactsUnfollow(api, { artifact });
      if (!outcome.ok) throw artifactCliError(outcome, commandLineOf(args));
      writeText(ctx.io, formatArtifactSubscription(outcome.data));
    },
  );
}

export const artifactFollowCommand = followCommand(true);
export const artifactUnfollowCommand = followCommand(false);

export function registerArtifactFollowCommands(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactFollowCommand, runtimeOptions);
  registerCliCommand(parent, artifactUnfollowCommand, runtimeOptions);
}
