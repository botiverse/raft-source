import { Option, type Command } from "commander";

import type { CommandContext, CommandRuntimeOptions } from "./context.js";
import { createCommandContext } from "./context.js";
import { renderError } from "./renderer.js";
import { CliExit, toCliError } from "./errors.js";

export interface CommandOptionSpec {
  flags: string;
  description: string;
  parse?: (value: string, previous: any) => any;
  hidden?: boolean;
}

export interface CommandSpec {
  name: string;
  description: string;
  arguments?: string[];
  options?: CommandOptionSpec[];
  helpAfter?: string;
}

export type CommandHandler = (ctx: CommandContext, ...args: any[]) => Promise<void> | void;

export function defineCommand(spec: CommandSpec, handler: CommandHandler): {
  spec: CommandSpec;
  handler: CommandHandler;
} {
  return { spec, handler };
}

export function registerCliCommand(
  parent: Command,
  command: ReturnType<typeof defineCommand>,
  runtimeOptions: CommandRuntimeOptions = {},
): void {
  const child = parent.command(command.spec.name).description(command.spec.description);
  for (const arg of command.spec.arguments ?? []) {
    child.argument(arg);
  }
  for (const option of command.spec.options ?? []) {
    const commanderOption = option.hidden ? new Option(option.flags, option.description).hideHelp() : null;
    if (option.parse) {
      if (commanderOption) {
        commanderOption.argParser(option.parse);
        child.addOption(commanderOption);
      } else {
        child.option(option.flags, option.description, option.parse);
      }
    } else if (commanderOption) {
      child.addOption(commanderOption);
    } else {
      child.option(option.flags, option.description);
    }
  }
  if (command.spec.helpAfter) {
    child.addHelpText("after", command.spec.helpAfter);
  }
  child.action(async (...args: any[]) => {
    const ctx = createCommandContext(runtimeOptions);
    try {
      await command.handler(ctx, ...args);
    } catch (err) {
      // CliExit is the sanctioned "account already written, set the status"
      // exit. Wrapping it in toCliError turned every such exit into a spurious
      // "Unexpected error: CliExit(1) / Code: INTERNAL_BUG" on stderr — an
      // internal-tool-error claim about a perfectly normal refusal (task #60).
      if (err instanceof CliExit) throw err;
      const cliError = toCliError(err);
      renderError(ctx.io, cliError);
      throw new CliExit(cliError.exitCode);
    }
  });
}
