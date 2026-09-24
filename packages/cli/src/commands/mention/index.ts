import type { Command } from "commander";

import type { CommandRuntimeOptions } from "../../core/context.js";
import { registerMentionExecuteCommands } from "./execute.js";
import { registerMentionPendingCommand } from "./pending.js";

export function registerMentionCommands(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerMentionPendingCommand(parent, runtimeOptions);
  registerMentionExecuteCommands(parent, runtimeOptions);
}
