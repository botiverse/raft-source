// `raft artifact comments <artifact> [--review <review id>] [--path <file>] [--all] [--cursor <c>]`
// → GET /internal/agent-api/artifacts/:artifact/comments (the SDK's artifacts.comments)

import type { Command } from "commander";
import { formatArtifactComments } from "./_format";
import { artifactsComments } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { writeText } from "../../core/renderer";
import { artifactArgument, artifactCliError, splitArgs } from "./_shared";

interface CommentsOpts {
  artifact?: string;
  path?: string;
  all?: boolean;
  cursor?: string;
  review?: string;
}

export const artifactCommentsCommand = defineCommand(
  {
    name: "comments",
    description: "List an artifact's comments in full, oldest first: by default only those since you last looked (marking them seen)",
    arguments: ["[artifact]"],
    options: [
      { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" },
      { flags: "--review <review>", description: "One review (its id, review=… on its comments): its summary, then all its comments in order" },
      { flags: "--path <file>", description: "Only comments on this file" },
      { flags: "--all", description: "Every comment, not only the new ones" },
      { flags: "--cursor <cursor>", description: "Continue from a More line" },
    ],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<CommentsOpts>(args, 1);
    const artifact = artifactArgument(positionals[0], opts.artifact);
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
    const outcome = await artifactsComments(api, {
      artifact,
      ...(opts.path === undefined ? {} : { path: opts.path }),
      ...(opts.all ? { all: true } : {}),
      ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      ...(opts.review === undefined ? {} : { review: opts.review }),
    });
    if (!outcome.ok) throw artifactCliError(outcome);
    writeText(ctx.io, formatArtifactComments(outcome.data, opts.review === undefined ? {} : { review: opts.review }));
  },
);

export function registerArtifactCommentsCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactCommentsCommand, runtimeOptions);
}
