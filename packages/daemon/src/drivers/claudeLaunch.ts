import { writeFileSync } from "node:fs";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig } from "@botiverse/raft-shared";
import { isClaudeCustomProviderConfig } from "./claudeProviderIsolation.js";
import type { RuntimeProbeResult } from "./types.js";
import { firstExistingPath, readCommandVersion, resolveCommandOnPath, resolveHomePath, type ProbeDeps } from "./probe.js";

export const CLAUDE_DESKTOP_CLI_RELATIVE_PATH = path.join("Applications", "Claude Code URL Handler.app", "Contents", "MacOS", "claude");
export const CLAUDE_DESKTOP_CLI_SYSTEM_PATH = "/Applications/Claude Code URL Handler.app/Contents/MacOS/claude";
const CLAUDE_SYSTEM_PROMPT_FILE = "claude-system-prompt.md";
export const CLAUDE_DISALLOWED_TOOLS = [
  "EnterPlanMode",
  "ExitPlanMode",
  "ScheduleWakeup",
  "CronCreate",
  "CronList",
  "CronDelete",
].join(",");

export function resolveClaudeCommand(deps: ProbeDeps = {}): string | null {
  const pathCommand = resolveCommandOnPath("claude", deps);
  if (pathCommand) return pathCommand;

  if ((deps.platform ?? process.platform) !== "darwin") return null;
  return firstExistingPath([
    resolveHomePath(CLAUDE_DESKTOP_CLI_RELATIVE_PATH, deps),
    CLAUDE_DESKTOP_CLI_SYSTEM_PATH,
  ], deps);
}

export function resolveClaudeLaunchCommand(config: AgentConfig, deps: ProbeDeps = {}): string | null {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config));
  return launchRuntimeFields.command?.trim() || resolveClaudeCommand(deps);
}

export function probeClaude(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveClaudeCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

export function probeClaudeLaunch(config: AgentConfig, deps: ProbeDeps = {}): RuntimeProbeResult {
  const launchDeps = {
    ...deps,
    env: { ...(deps.env ?? process.env) },
  };
  delete launchDeps.env.CLAUDECODE;
  const command = resolveClaudeLaunchCommand(config, launchDeps);
  if (!command) return { available: false };
  return {
    available: true,
    version: readCommandVersion(command, [], launchDeps) ?? undefined,
  };
}

export function buildClaudeArgs(
  config: AgentConfig,
  opts: { standingPromptFilePath: string; managedMcpConfigPath?: string | null },
): string[] {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config));
  const args = [
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--include-partial-messages",
    "--model", launchRuntimeFields.model || "sonnet",
    "--disallowed-tools", CLAUDE_DISALLOWED_TOOLS,
    "--append-system-prompt-file", opts.standingPromptFilePath,
  ];

  if (launchRuntimeFields.reasoningEffort) {
    args.push("--effort", launchRuntimeFields.reasoningEffort);
  }

  if (isClaudeCustomProviderConfig(config)) {
    args.push("--setting-sources", "project,local");
  }

  if (launchRuntimeFields.mode.kind === "fast") {
    args.push("--settings", JSON.stringify({ fastMode: true }));
  }

  if (config.sessionId) {
    args.push("--resume", config.sessionId);
  }

  if (opts.managedMcpConfigPath) {
    args.push("--mcp-config", opts.managedMcpConfigPath);
  }

  return args;
}

export function buildClaudeManagedMcpConfig(server: {
  name: string;
  url: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [server.name]: {
        type: "http",
        url: server.url,
      },
    },
  };
}

export function writeClaudeSystemPromptFile(standingPrompt: string, slockDir: string): string {
  const systemPromptPath = path.join(slockDir, CLAUDE_SYSTEM_PROMPT_FILE);
  writeFileSync(systemPromptPath, standingPrompt, { mode: 0o600 });
  return systemPromptPath;
}

export function buildClaudeSpawnSpec(
  claudeCommand: string | null,
  platform: NodeJS.Platform = process.platform,
): { command: string; shell: boolean } {
  const lowerClaudeCommand = claudeCommand?.toLowerCase();
  const isBatchFile = Boolean(
    platform === "win32" &&
      lowerClaudeCommand &&
      (lowerClaudeCommand.endsWith(".cmd") || lowerClaudeCommand.endsWith(".bat")),
  );

  return {
    command: claudeCommand ?? "claude",
    shell: platform === "win32" && (!claudeCommand || isBatchFile),
  };
}
