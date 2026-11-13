// `raft artifact move <artifact> --to server` → POST /internal/agent-api/artifacts/:artifact/home
// `raft artifact delete <artifact>`           → DELETE /internal/agent-api/artifacts/:artifact
//
// An agent moves an artifact only to the whole server: letting anyone with
// the link open it (link sharing, the `public` home on the wire) is a
// person's step, so `--to anyone-with-link` is refused before any request (by
// the shared operation, as for a tool call), with the move an agent can make;
// `--to public` is no value of --to. Only a person can move an artifact back
// (to the conversation it came from); a delete can't be undone. Who may: the artifact's author, and a move only
// for what the person who manages the agent could move (the Server decides).

import type { Command } from "commander";
import { artifactsDelete, artifactsMove } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatArtifactDeleted, formatArtifactMoved } from "./_format";
import { artifactArgument, artifactCliError, refuseExtraArguments, splitArgs } from "./_shared";

interface MoveOpts {
  artifact?: string;
  to?: string;
}

const artifactOption = { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" };

/**
 * `--to server`, the one home an agent moves an artifact to; `anyone-with-link`
 * goes on to the operation, which refuses it before any request with who can.
 */
function parseTo(raw: string | undefined, artifact: string): "server" | "anyone-with-link" {
  const to = raw?.trim();
  if (to === "server" || to === "anyone-with-link") return to;
  const homes = "server (the whole server), anyone-with-link (only a person can turn on link sharing)";
  throw new CliError({
    code: "INVALID_ARG",
    message: to ? `--to must be one of: ${homes}; got "${raw}"` : `--to is required; it must be one of: ${homes}`,
    suggestedNextAction: `raft artifact move ${artifact} --to server`,
  });
}

export const artifactMoveCommand = defineCommand(
  {
    name: "move",
    description: "Move an artifact you made to the whole server (--to server), if the person who manages you can see it and could move it too: every member and agent of this server can then see it (guests can't), with its comments and all its versions; only a person can move it back, and only a person can let anyone with the link open it",
    arguments: ["[artifact]"],
    usage: "<artifact> --to server",
    options: [
      artifactOption,
      { flags: "--to <home>", description: "Where it moves: server (the whole server: its members and agents)" },
    ],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<MoveOpts>(args, 1);
    refuseExtraArguments(args[2], 1, "Name one artifact.");
    const artifact = artifactArgument(positionals[0], opts.artifact);
    const to = parseTo(opts.to, artifact);
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
    const outcome = await artifactsMove(api, { artifact, to });
    if (!outcome.ok) throw artifactCliError(outcome, commandLineOf(args));
    writeText(ctx.io, formatArtifactMoved(outcome.data));
  },
);

export const artifactDeleteCommand = defineCommand(
  {
    name: "delete",
    description: "Delete an artifact you made: no one can open it or any of its versions any more, and links to it say it can't be opened; this can't be undone",
    arguments: ["[artifact]"],
    options: [artifactOption],
  },
  async (ctx, ...args: unknown[]) => {
    const { positionals, opts } = splitArgs<{ artifact?: string }>(args, 1);
    refuseExtraArguments(args[2], 1, "Name one artifact.");
    const artifact = artifactArgument(positionals[0], opts.artifact);
    const agentContext = ctx.loadAgentContext();
    const api = createAgentApiContractSurfaceClient(ctx.createApiClient(agentContext));
    const outcome = await artifactsDelete(api, { artifact });
    if (!outcome.ok) throw artifactCliError(outcome, commandLineOf(args));
    writeText(ctx.io, formatArtifactDeleted(outcome.data));
  },
);

export function registerArtifactManageCommands(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactMoveCommand, runtimeOptions);
  registerCliCommand(parent, artifactDeleteCommand, runtimeOptions);
}
