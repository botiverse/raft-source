// `raft proc logs <name> [--tail <n>] [--follow]`
// -> GET /internal/agent-api/proc, then GET /internal/agent-api/proc/logs

import type { Command } from "commander";
import {
  PROC_LOGS_DEFAULT_TAIL,
  PROC_LOGS_FOLLOW_MAX_MS,
  PROC_LOGS_MAX_TAIL,
} from "@botiverse/raft-shared/src/agentCliSurface";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandContext, CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { NL, writeText } from "../../core/renderer";
import { openProcApi, procFailure, requireProcName } from "./_client";
import { formatProcLogsFooter, formatProcLogsHeader, formatProcLogText } from "./_format";

interface LogsOptions {
  tail?: string;
  follow?: boolean;
}

export interface ProcLogsFollowDeps {
  followMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function parseTail(value: string | undefined): number {
  if (value === undefined) return PROC_LOGS_DEFAULT_TAIL;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > PROC_LOGS_MAX_TAIL) {
    throw new CliError({ code: "INVALID_ARG", message: `--tail takes a number of lines from 1 to ${PROC_LOGS_MAX_TAIL}; got ${JSON.stringify(value)}` });
  }
  return Number(value);
}

export async function runProcLogs(ctx: CommandContext, name: string, opts: LogsOptions, deps: ProcLogsFollowDeps = {}): Promise<void> {
  const jobName = requireProcName(name, "List the jobs: raft proc list");
  const tail = parseTail(opts.tail);
  const { api } = await openProcApi(ctx);
  const first = await api.logs({ name: jobName, tail });
  if (!first.ok) throw procFailure(first);
  let { job, offset } = first.data!;
  const lines = first.data!.text === "" ? 0 : first.data!.text.split("\n").length - 1;
  writeText(ctx.io, formatProcLogsHeader(job, lines), NL, formatProcLogText(first.data!.text));
  if (!opts.follow) {
    writeText(ctx.io, formatProcLogsFooter(job, "tail"), NL);
    return;
  }
  const followMs = deps.followMs ?? PROC_LOGS_FOLLOW_MAX_MS;
  const pollMs = deps.pollMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + followMs;
  while (job.state === "running" && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    const next = await api.logs({ name: jobName, offset });
    if (!next.ok) throw procFailure(next);
    job = next.data!.job;
    offset = next.data!.offset;
    if (next.data!.text) writeText(ctx.io, formatProcLogText(next.data!.text));
  }
  writeText(ctx.io, formatProcLogsFooter(job, job.state === "running" ? "follow_timeout" : "follow_exited"), NL);
}

export const procLogsCommand = defineCommand(
  {
    name: "logs",
    description: "Print the end of one of this agent's job logs",
    arguments: ["<name>"],
    options: [
      { flags: "--tail <n>", description: `Lines to print (default ${PROC_LOGS_DEFAULT_TAIL}, at most ${PROC_LOGS_MAX_TAIL})` },
      { flags: "--follow", description: `Keep printing new lines; stops after ${PROC_LOGS_FOLLOW_MAX_MS / 1000} s (or when the job exits) and prints the --tail command to read more` },
    ],
  },
  async (ctx, name: string, opts: LogsOptions = {}) => {
    await runProcLogs(ctx, name, opts);
  },
);

export function registerProcLogsCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, procLogsCommand, runtimeOptions);
}
