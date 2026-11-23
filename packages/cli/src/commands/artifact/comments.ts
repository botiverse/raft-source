// `raft artifact comments <artifact> [--review <review id>] [--held <from..to>] [--path <file>] [--all] [--cursor <c>]`
// → GET /internal/agent-api/artifacts/:artifact/comments (the SDK's artifacts.comments)
//
// `--held` (#proj-workspace:#340): a held comment, resolve or push marks
// comments seen, so they leave the default (new only) list; its
// last line names this flag with its range, to list exactly those again
// when its output was cut.

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
  held?: string;
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
      { flags: "--held <from..to>", description: "List again the comments a held comment, resolve or push marked seen: the range its last line names" },
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
      ...(opts.held === undefined ? {} : { held: opts.held }),
    });
    if (!outcome.ok) throw artifactCliError(outcome);
    writeText(ctx.io, formatArtifactComments(outcome.data, {
      ...(opts.review === undefined ? {} : { review: opts.review }),
      ...(opts.held === undefined ? {} : { held: opts.held }),
    }));
  },
);

export function registerArtifactCommentsCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactCommentsCommand, runtimeOptions);
}
