// `raft artifact resolve <artifact> <comment> [--note <text>]` / `raft artifact reopen <artifact> <comment>`
// → POST /internal/agent-api/artifacts/:artifact/comments/:comment/resolve | reopen
//   (the SDK's artifacts.resolve / artifacts.reopen)
//
// A thread is resolved by its first comment. Separate commands rather than
// flags on `raft artifact comment`: that one posts a comment read from stdin,
// and a resolve posts nothing unless it has a note (one thing per command,
// packages/cli/AGENTS.md). The note is short, so it is a flag, as a push's
// note is. Resolving one already resolved changes nothing and posts no note,
// so running it again is safe.

import type { Command } from "commander";
import { artifactsReopen, artifactsResolve, formatHint, RAFT_HINTS } from "@botiverse/raft-shared/src/agentCliSurface";

import { createAgentApiContractSurfaceClient } from "../../agentApiPath";
import { commandLineOf } from "../../core/commandLine";
import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { writeText } from "../../core/renderer";
import { formatArtifactThreadResolution } from "./_format";
import { artifactArgument, artifactCliError, refuseExtraArguments, splitArgs } from "./_shared";

interface ResolveOpts {
  artifact?: string;
  note?: string;
}

const artifactOption = { flags: "--artifact <artifact>", description: "The artifact, if not given as the first argument: its id, link or exact title" };

function commentArgument(value: unknown, artifact: string, reopen: boolean): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new CliError({
    code: "INVALID_ARG",
    message: `Name the thread to ${reopen ? "reopen" : "resolve"}: its first comment's id (comment=… in its comments).`,
    suggestedNextAction: `List its comments to find it: ${formatHint(RAFT_HINTS.artifactComments({ artifact, all: true }))}`,
  });
}

function resolutionCommand(reopen: boolean) {
  return defineCommand(
    {
      name: reopen ? "reopen" : "resolve",
      description: reopen
        ? "Reopen a resolved comment thread on an artifact, by its first comment; tells no one"
        : "Resolve a comment thread you answered, by its first comment, with an optional note posted as your reply; its author is told",
      // `[id]`, not `[comment]`: a longer term would push `raft artifact --help` past commander's wrapping width.
      arguments: ["[artifact]", "[id]"],
      usage: reopen ? "<artifact> <id>" : "<artifact> <id> [--note <text>]",
      helpAfter: [
        "",
        "<id> is the thread's first comment (its comment=… id in raft artifact comments).",
        reopen
          ? "A reply in a resolved thread reopens it too. Who may: the thread's author, the artifact's author (or whoever manages it, when it's an agent), and the server's owners and admins."
          : "Only the thread's author, the artifact's author (or whoever manages it, when it's an agent), and the server's owners and admins may. Resolve only a thread you answered:",
        ...(reopen ? [] : [
          "  raft artifact resolve ScAiFjjtiUvoyEYA6Ry12u c_812 --note \"Done in v13: the states are side by side.\"",
          "A reply is refused: a thread is resolved by its first comment (comments marks resolved ones status=resolved).",
        ]),
      ].join("\n"),
      options: [
        artifactOption,
        ...(reopen ? [] : [{ flags: "--note <text>", description: "A short note, posted first as your reply in the thread: what answered it, such as the version" }]),
      ],
    },
    async (ctx, ...args: unknown[]) => {
      const { positionals, opts } = splitArgs<ResolveOpts>(args, 2);
      refuseExtraArguments(args[3], 2, "Name one artifact and one comment; a note goes in --note.");
      // With --artifact, the one positional is the comment.
      const [first, second] = opts.artifact === undefined ? [positionals[0], positionals[1]] : [undefined, positionals[0]];
      const artifact = artifactArgument(first, opts.artifact);
      const comment = commentArgument(second, artifact, reopen);
      const api = createAgentApiContractSurfaceClient(ctx.createApiClient(ctx.loadAgentContext()));
      const outcome = reopen
        ? await artifactsReopen(api, { artifact, comment })
        : await artifactsResolve(api, { artifact, comment, ...(opts.note === undefined ? {} : { note: opts.note }) });
      if (!outcome.ok) throw artifactCliError(outcome, commandLineOf(args));
      writeText(ctx.io, formatArtifactThreadResolution(outcome.data));
    },
  );
}

export const artifactResolveCommand = resolutionCommand(false);
export const artifactReopenCommand = resolutionCommand(true);

export function registerArtifactResolveCommands(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, artifactResolveCommand, runtimeOptions);
  registerCliCommand(parent, artifactReopenCommand, runtimeOptions);
}
