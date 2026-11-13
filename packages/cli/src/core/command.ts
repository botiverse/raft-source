import { Option, type Command } from "commander";

import type { CommandContext, CommandRuntimeOptions } from "./context";
import { createCommandContext } from "./context";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { passiveAgentId } from "../ax/passiveEngine";
import { resolveStateDbPath } from "../state/agentLedger";
import { renderError } from "./renderer";
import { CliExit, cliError, toCliError } from "./errors";
import { assertGuidanceWithinLimits, attachGuidanceToHelp, commandPath, gateCommandGuidance } from "../ax/commandGuidance";

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
  /** Replaces the generated usage line, e.g. when a declared argument only exists to reject misuse. */
  usage?: string;
  /** Left out of `--help` listings; it still runs. */
  hidden?: boolean;
  /** Other names that run it (commander aliases), e.g. `raft cont` for `raft __continue`. */
  aliases?: string[];
  options?: CommandOptionSpec[];
  helpAfter?: string;
  /**
   * Usage guidance of a consequential command (RFC 072 §7): always printed in
   * full by `--help`; the first run in an agent's model context delivers it
   * instead of executing (ax/commandGuidance.ts). At most MAX_GUIDANCE_LINES
   * lines and MAX_GUIDANCE_CHARS characters.
   */
  guidance?: string;
}

export type CommandHandler = (ctx: CommandContext, ...args: any[]) => Promise<void> | void;

export function defineCommand(spec: CommandSpec, handler: CommandHandler): {
  spec: CommandSpec;
  handler: CommandHandler;
} {
  return { spec, handler };
}

/**
 * A short hash of a run's arguments (positionals and options, keys sorted; not
 * stdin), for the guidance trace: the same hash means the agent ran the same
 * command again. Keyed with a random value kept in the agent's own state
 * directory, so a short title or id can't be confirmed by guessing it.
 * Undefined when that key can't be read or made.
 */
function argsHashOf(args: readonly unknown[], env: NodeJS.ProcessEnv): string | undefined {
  try {
    const key = guidanceTraceKey(env);
    if (!key) return undefined;
    // Commander passes the positionals, the options object, then the Command itself.
    const values = args.slice(0, -1).map((value) => (
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : value
    ));
    return createHmac("sha256", key).update(JSON.stringify(values)).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

function guidanceTraceKey(env: NodeJS.ProcessEnv): string | undefined {
  const agentId = passiveAgentId(env);
  if (!agentId) return undefined;
  const file = path.join(path.dirname(resolveStateDbPath(agentId, env)), "guidance-trace-key");
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const key = randomBytes(16).toString("hex");
    // `wx`: a concurrent first run that already wrote one wins; read it back.
    try { writeFileSync(file, key, { mode: 0o600, flag: "wx" }); } catch { return readFileSync(file, "utf8").trim() || undefined; }
    return key;
  }
}

export function registerCliCommand(
  parent: Command,
  command: ReturnType<typeof defineCommand>,
  runtimeOptions: CommandRuntimeOptions = {},
): void {
  const child = parent.command(command.spec.name, command.spec.hidden ? { hidden: true } : {}).description(command.spec.description);
  for (const alias of command.spec.aliases ?? []) child.alias(alias);
  for (const arg of command.spec.arguments ?? []) {
    child.argument(arg);
  }
  if (command.spec.usage) child.usage(command.spec.usage);
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
  if (command.spec.guidance) {
    assertGuidanceWithinLimits(command.spec.name, command.spec.guidance);
    attachGuidanceToHelp(child, command.spec.guidance, { env: runtimeOptions.env });
  }
  if (command.spec.helpAfter) {
    child.addHelpText("after", command.spec.helpAfter);
  }
  child.action(async (...args: any[]) => {
    const ctx = createCommandContext(runtimeOptions);
    try {
      if (command.spec.guidance && gateCommandGuidance(commandPath(child), command.spec.guidance, ctx.io.stdout, ctx.env, argsHashOf(args, ctx.env)) === "held") {
        throw cliError("GUIDANCE_DELIVERED", "Not executed; the command's guidance was delivered instead.", {
          effect: "not_executed",
          retryable: true,
          // The text above already says what happened and what to do.
          textDetailMode: "omit_restated_lines",
          suggestedNextAction: "Run the same command again unchanged.",
        });
      }
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
