// `raft proc stop <name> [--force]`
// -> GET /internal/agent-api/proc, then POST /internal/agent-api/proc/stop

import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { NL, writeText } from "../../core/renderer";
import { openProcApi, procFailure, requireProcName } from "./_client";
import { formatProcStopped } from "./_format";

interface StopOptions {
  force?: boolean;
}

export const procStopCommand = defineCommand(
  {
    name: "stop",
    description: "Stop one of this agent's jobs: SIGTERM to its process group, then SIGKILL after 10 s if it is still running",
    arguments: ["<name>"],
    options: [{ flags: "--force", description: "SIGKILL the job's process group at once, without the 10 s wait" }],
  },
  async (ctx, name: string, opts: StopOptions = {}) => {
    const jobName = requireProcName(name, "List the jobs: raft proc list");
    const { api } = await openProcApi(ctx);
    const res = await api.stop({ name: jobName, ...(opts.force ? { force: true } : {}) });
    if (!res.ok) throw procFailure(res);
    writeText(ctx.io, formatProcStopped(res.data!.job, res.data!.outcome, res.data!.graceMs), NL);
  },
);

export function registerProcStopCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, procStopCommand, runtimeOptions);
}
