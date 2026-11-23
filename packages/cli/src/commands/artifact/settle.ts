// `raft artifact settle <artifact>` / `raft artifact unsettle <artifact>`
// → POST /internal/agent-api/artifacts/:artifact/settle | unsettle
//   (the SDK's artifacts.settle / artifacts.unsettle; #334)
//
// Settled says an Artifact is done, no longer a draft under discussion.
// Anyone who may comment on it may settle it and take that back, agents too;
// nothing is locked. A new version takes it back to Working on its own, and
// the first push of one is held (Code: SETTLED), so this pair is only for
// saying "done" and undoing that. Running either again changes nothing.

import type { Command } from "commander";
import { artifactsSettle, artifactsUnsettle } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { writeText } from "../../core/renderer";
import { formatArtifactSettlement } from "./_format";
import { artifactArgument, artifactCliError, refuseExtraArguments, splitArgs } from "./_shared";

interface SettleOpts {
  artifact?: string;
}

const artifactOption = { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" };

function settleCommand(settle: boolean) {
  return defineCommand(
    {
      name: settle ? "settle" : "unsettle",
      description: settle
        ? "Mark an artifact Settled: done, no longer a draft under discussion"
        : "Take a Settled artifact back to Working",
      arguments: ["[artifact]"],
      helpAfter: settle
        ? [
          "",
          "Settle it when the people it was made for said it is done, not when you finish a version.",
          "Anyone who may comment on it may settle it, at its current version; nothing is locked.",
          "A new version takes it back to Working: the first push to a settled artifact is held, and the same push again goes through.",
          "Its following agents are told without being woken. Settling follows it, as commenting does.",
        ].join("\n")
        : [
          "",
          "Who may: anyone who may comment on it. A new version takes it back to Working on its own.",
        ].join("\n"),
      options: [artifactOption],
    },
    async (ctx, ...args: unknown[]) => {
      const { positionals, opts } = splitArgs<SettleOpts>(args, 1);
      refuseExtraArguments(args[2], 1, "Name one artifact.");
      const artifact = artifactArgument(positionals[0], opts.artifact);
      const api = createAgentApiContractSurfaceClient(ctx.createApiClient(ctx.loadAgentContext()));
      const outcome = settle ? await artifactsSettle(api, { artifact }) : await artifactsUnsettle(api, { artifact });
      if (!outcome.ok) throw artifactCliError(outcome, commandLineOf(args));
      writeText(ctx.io, formatArtifactSettlement(outcome.data, settle));
    },
  );
}

export const artifactSettleCommand = settleCommand(true);
export const artifactUnsettleCommand = settleCommand(false);

export function registerArtifactSettleCommands(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactSettleCommand, runtimeOptions);
  registerCliCommand(parent, artifactUnsettleCommand, runtimeOptions);
}
