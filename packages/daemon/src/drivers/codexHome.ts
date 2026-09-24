import os from "node:os";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig } from "@botiverse/raft-shared";

function readConfiguredCodexHome(env: Record<string, string | undefined>): string | null {
  const raw = env.CODEX_HOME;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

export function resolveCodexHomeRootFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { defaultHomeDir?: string; cwd?: string } = {},
): string {
  const raw = readConfiguredCodexHome(env);
  if (raw) {
    return path.resolve(opts.cwd ?? process.cwd(), raw);
  }
  return path.join(opts.defaultHomeDir ?? os.homedir(), ".codex");
}

export function hasConfiguredCodexHome(
  config: AgentConfig | null | undefined,
  baseEnv: Record<string, string | undefined> = process.env,
): boolean {
  const launchRuntimeFields = config ? runtimeConfigToLaunchFields(hydrateRuntimeConfig(config)) : null;
  return Boolean(readConfiguredCodexHome({
    ...baseEnv,
    ...(launchRuntimeFields?.envVars || {}),
  }));
}

export function resolveCodexHomeRootFromConfig(
  config: AgentConfig,
  defaultHomeDir: string,
  cwd: string,
  baseEnv: Record<string, string | undefined> = process.env,
  _opts: { agentId?: string; slockHome?: string } = {},
): string {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config));
  const env = {
    ...baseEnv,
    ...(launchRuntimeFields.envVars || {}),
  };
  return resolveCodexHomeRootFromEnv(env, { defaultHomeDir, cwd });
}

export function codexStateRootCandidates(homeDirOrCodexRoot: string): string[] {
  return [
    homeDirOrCodexRoot,
    path.join(homeDirOrCodexRoot, ".codex"),
  ];
}

export function codexSessionRootCandidates(homeDirOrCodexRoot: string): string[] {
  return codexStateRootCandidates(homeDirOrCodexRoot).map((root) => path.join(root, "sessions"));
}
