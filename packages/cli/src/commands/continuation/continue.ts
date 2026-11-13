// `raft __continue <id> [choice]`, the answer's text on stdin: answer a
// continuation a command paused with (./_runtime.ts). Hidden: agents type
// `cont <id> …`, a wrapper the daemon writes beside `raft`
// (daemon/src/drivers/cliTransport.ts) that runs this; `raft cont <id> …`
// runs it too.
import type { Command } from "commander";

import type { CommandRuntimeOptions } from "../../core/context";
import { defineCommand, registerCliCommand } from "../../core/command";
import { CliError } from "../../core/errors";
import { CLI_CONTINUATION_COMMANDS } from "./_commands";
import { answerContinuation } from "./_runtime";

export function registerContinueCommand(program: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  const commands = runtimeOptions.continuations?.commands ?? CLI_CONTINUATION_COMMANDS;
  registerCliCommand(
    program,
    defineCommand(
      {
        name: "__continue",
        description: "Answer a continuation: cont <id> [choice], the answer's text on stdin",
        arguments: ["<id>", "[choice]", "[more...]"],
        // Not in `raft --help`: agents type `cont`, which the paused output itself teaches.
        hidden: true,
        // An agent used to the `raft` prefix types `raft cont <id> …`: run it, rather than refuse it as an unknown command.
        aliases: ["cont"],
      },
      async (ctx, id: string, choice: string | undefined, more: string[]) => {
        if (more.length > 0) {
          throw new CliError({
            code: "INVALID_ARG",
            message: "cont takes the continuation id and at most one option; an answer's text goes on stdin.",
            suggestedNextAction: `cont ${id} ${choice} <<'RAFTMSG', then the text, then RAFTMSG on its own line.`,
          });
        }
        await answerContinuation(ctx, runtimeOptions.continuations, commands, id, choice);
      },
    ),
    runtimeOptions,
  );
}
