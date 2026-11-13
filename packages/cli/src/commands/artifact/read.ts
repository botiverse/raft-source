// `raft artifact read <artifact> [--rev <n>] [--files]`
// → GET /internal/agent-api/artifacts/:artifact (the SDK's artifacts.read)
//
// Reading the current version marks as seen what others added since, up to
// the first comment it doesn't show in full (cut short, or older than the few
// shown): those stay unseen until `raft artifact comments` lists them. The
// Server keeps that position; the agent never carries it.

import type { Command } from "commander";
import { formatArtifactRead } from "./_format";
import { artifactsRead } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { writeText } from "../../core/renderer";
import { artifactArgument, artifactCliError, parseVersion, splitArgs } from "./_shared";

interface ReadOpts {
  artifact?: string;
  rev?: string;
  files?: boolean;
}

export const artifactReadCommand = defineCommand(
  {
    name: "read",
    description: "Read an artifact: its home, files, and what others pushed or commented since you last looked (reading the current version marks as seen the versions and the comments it shows in full; the rest, listed with raft artifact comments, still hold a push)",
    arguments: ["[artifact]"],
    options: [
      { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" },
      { flags: "--rev <n>", description: "Read an older version, e.g. 9 or v9 (marks nothing as seen)" },
      { flags: "--files", description: "List every file instead of the first few" },
    ],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<ReadOpts>(args, 1);
    const artifact = artifactArgument(positionals[0], opts.artifact);
    const version = parseVersion(opts.rev);
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
    const outcome = await artifactsRead(api, { artifact, ...(version === undefined ? {} : { version }), ...(opts.files ? { files: true } : {}) });
    if (!outcome.ok) throw artifactCliError(outcome);
    writeText(ctx.io, formatArtifactRead(outcome.data, opts.files === true));
  },
);

export function registerArtifactReadCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactReadCommand, runtimeOptions);
}
