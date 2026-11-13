// `raft proc list`
// -> GET /internal/agent-api/proc

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { NL, writeText } from "../../core/renderer";
import { openProcApi } from "./_client";
import { formatProcList } from "./_format";

export const procListCommand = defineCommand(
  {
    name: "list",
    description: "List this agent's background jobs: running, or how they exited",
  },
  async (ctx) => {
    const { listing } = await openProcApi(ctx);
    writeText(ctx.io, formatProcList(listing.jobs, Date.now()), NL);
  },
);

export function registerProcListCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, procListCommand, runtimeOptions);
}
