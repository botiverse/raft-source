import type { Command } from "commander";

import { defineCommand, registerCliCommand } from "../core/command.js";
import type { CommandRuntimeOptions } from "../core/context.js";
import { CliError } from "../core/errors.js";
import { writeJson, writeText, NL, adoptCliReplyText } from "../core/renderer.js";
import { createDaemonApiSurfaceClient } from "../daemonApiPath.js";
import { normalizeVersion, readCliVersion } from "../version.js";

interface VersionOptions {
  json?: boolean;
}

export interface RaftVersionInfo {
  cli: string;
  daemon: string;
  computer: string | null;
  observation: "live_daemon_process";
}

function unavailable(message: string): CliError {
  return new CliError({
    code: "VERSION_UNAVAILABLE",
    message,
    suggestedNextAction: "Run this command inside a healthy daemon-managed agent; do not substitute inherited version environment variables.",
  });
}

export function formatVersionInfo(info: RaftVersionInfo): string {
  return [
    `Raft CLI: ${info.cli}`,
    `Raft daemon (live): ${info.daemon}`,
    `Raft Computer (live): ${info.computer ?? "not present"}`,
  ].join("\n");
}

export function parseLiveVersionInfo(cliVersion: unknown, payload: unknown): RaftVersionInfo | null {
  const cli = normalizeVersion(cliVersion);
  if (!cli || typeof payload !== "object" || payload === null) return null;
  const data = payload as Record<string, unknown>;
  if (data.observation !== "live_daemon_process") return null;
  const daemon = normalizeVersion(data.daemonVersion);
  if (!daemon) return null;
  const computer = data.computerVersion === null
    ? null
    : normalizeVersion(data.computerVersion);
  if (data.computerVersion !== null && !computer) return null;
  return {
    cli,
    daemon,
    computer,
    observation: "live_daemon_process",
  };
}

export const versionCommand = defineCommand(
  {
    name: "version",
    description: "Report the running CLI, daemon, and Computer versions",
    options: [{ flags: "--json", description: "Emit machine-readable JSON" }],
  },
  async (ctx, opts: VersionOptions = {}) => {
    const cliVersion = readCliVersion();
    if (!normalizeVersion(cliVersion)) {
      throw unavailable("The invoked Raft CLI does not contain trustworthy version metadata.");
    }

    let agentContext;
    try {
      agentContext = ctx.loadAgentContext();
    } catch {
      throw unavailable("The current daemon version cannot be queried from this CLI context.");
    }
    if (agentContext.clientMode !== "managed-runner") {
      throw unavailable("`raft version` requires a daemon-managed agent so it can query the live daemon process.");
    }

    const response = await createDaemonApiSurfaceClient(ctx.createApiClient(agentContext)).runtime.version();
    if (!response.ok) {
      throw unavailable("The live daemon did not return trustworthy version metadata.");
    }
    const info = parseLiveVersionInfo(cliVersion, response.data);
    if (!info) throw unavailable("The live daemon did not return trustworthy version metadata.");
    if (opts.json) {
      writeJson(ctx.io, { ok: true, data: info });
      return;
    }
    writeText(ctx.io, adoptCliReplyText(formatVersionInfo(info)), NL);
  },
);

export function registerVersionCommand(parent: Command, runtimeOptions?: CommandRuntimeOptions): void {
  registerCliCommand(parent, versionCommand, runtimeOptions);
}
