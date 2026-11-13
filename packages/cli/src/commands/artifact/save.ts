// `raft artifact save <attachment-id>`
// → POST /internal/agent-api/artifacts/save-attachment (the SDK's artifacts.saveAttachment)
//
// The web's "Save as Artifact" for an agent: the attachment (its id as
// `raft message read` shows it after the file name, `(id:<id>)`) becomes a
// new artifact the agent owns and follows, homed in the conversation it was
// sent in, and the attachment links to it on the web. Saving one already
// saved answers that artifact. The Server checks who may (whoever can see
// the message, within the plan's history window).

import type { Command } from "commander";
import { artifactsSaveAttachment } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatArtifactSaved } from "./_format";
import { artifactCliError, refuseExtraArguments, splitArgs } from "./_shared";

export const artifactSaveCommand = defineCommand(
  {
    name: "save",
    description: "Save an attachment (its id: raft message read shows it after the file name) as a new artifact homed in the conversation it was sent in, as \"Save as Artifact\" on the web: you own and follow it, and on the web the attachment links to it; saving one already saved answers that artifact",
    arguments: ["[attachmentId]"],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals } = splitArgs<object>(args, 1);
    refuseExtraArguments(args[2], 1, "Save one attachment at a time.");
    const attachmentId = positionals[0]?.trim();
    if (!attachmentId) {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Which attachment? Pass its id: raft message read shows it after the file name, as (id:<id>)",
        suggestedNextAction: "raft artifact save <attachment-id>",
      });
    }
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
    const outcome = await artifactsSaveAttachment(api, { attachmentId });
    if (!outcome.ok) throw artifactCliError(outcome, commandLineOf(args));
    writeText(ctx.io, formatArtifactSaved(outcome.data));
  },
);

export function registerArtifactSaveCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactSaveCommand, runtimeOptions);
}
