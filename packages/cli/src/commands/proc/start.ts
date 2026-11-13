// `raft proc start [--name <name>] [--cwd <dir>] -- <command> [args...]`
// -> GET /internal/agent-api/proc, then POST /internal/agent-api/proc/start

import path from "node:path";
import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../../core/command";
import type { CommandRuntimeOptions } from "../../core/context";
import { CliError } from "../../core/errors";
import { NL, writeText } from "../../core/renderer";
import { openProcApi, procFailure, requireProcName } from "./_client";
import { formatProcLimitMessage, formatProcStarted } from "./_format";

interface StartOptions {
  name?: string;
  cwd?: string;
}

const USAGE = "Usage: raft proc start [--name <name>] [--cwd <dir>] -- <command> [args...]";

export const procStartCommand = defineCommand(
  {
    name: "start",
    description: "Start a background job the Computer runs for this agent; returns at once",
    arguments: ["[command...]"],
    usage: "[--name <name>] [--cwd <dir>] -- <command> [args...]",
    options: [
      { flags: "--name <name>", description: "Job name (letters, digits, - and _; at most 40). Default: the command's name, made unique" },
      { flags: "--cwd <dir>", description: "Working directory, resolved against the current one. Default: the current directory" },
    ],
    helpAfter: [
      "",
      "Put the command after --. The job keeps running after this command returns,",
      "across turns and while the agent sleeps; it stops when a person stops the agent,",
      "or the agent is deleted or moved to another Computer.",
      "Its stdout and stderr go to a log the Computer keeps (raft proc logs).",
      "At most 8 jobs run at once per agent.",
      "",
      "  raft proc start --name web -- npm run dev",
      "  raft proc logs web",
      "  raft proc stop web",
    ].join("\n"),
  },
  async (ctx, command: string[] = [], opts: StartOptions = {}) => {
    if (command.length === 0) {
      throw new CliError({ code: "INVALID_ARG", message: `Give the command to run after --. ${USAGE}` });
    }
    const name = opts.name === undefined ? undefined : requireProcName(opts.name, "Pick another --name.");
    const { api, listing } = await openProcApi(ctx);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(ctx.env)) if (typeof value === "string") env[key] = value;
    const res = await api.start({
      ...(name !== undefined ? { name } : {}),
      argv: command,
      cwd: path.resolve(process.cwd(), opts.cwd ?? "."),
      env,
      callerPid: process.pid,
    });
    if (!res.ok) {
      if (res.errorCode === "proc_limit") {
        throw new CliError({ code: "PROC_LIMIT", message: formatProcLimitMessage(listing.jobs, listing.maxJobs, Date.now()) });
      }
      throw procFailure(res);
    }
    writeText(ctx.io, formatProcStarted(res.data!.job, res.data!.autoNamed, res.data!.stopsWithService === true), NL);
  },
);

export function registerProcStartCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, procStartCommand, runtimeOptions);
}
