import { readdirSync } from "node:fs";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "./types.js";

export type ClaudeProviderIsolationEnv = Record<string, string | undefined>;

export const LEGACY_CLAUDE_PROVIDER_CONFIG_DIR = path.join(".slock", "claude-provider", "home", ".claude");

const warnedLegacyClaudeProviderConfigDirs = new Set<string>();

export const CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLOUD_ML_REGION",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_CCR_V2",
] as const;

export function isClaudeCustomProviderConfig(config: AgentConfig): boolean {
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(config));
  return launchRuntimeFields.runtime === "claude"
    && Boolean(launchRuntimeFields.envVars?.ANTHROPIC_BASE_URL)
    && Boolean(launchRuntimeFields.envVars?.ANTHROPIC_API_KEY);
}

function clearInheritedClaudeProviderEnv(
  explicitEnv: Record<string, string> | null | undefined,
): ClaudeProviderIsolationEnv {
  const env: ClaudeProviderIsolationEnv = {};
  for (const key of CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(explicitEnv ?? {}, key)) {
      env[key] = undefined;
    }
  }
  return env;
}

const LEGACY_CLAUDE_PROVIDER_CONFIG_ENTRIES = new Set([
  "agents",
  "commands",
  "projects",
  "settings.json",
  "skills",
  "todos",
]);

function hasLegacyClaudeProviderConfigEntry(directory: string): boolean {
  try {
    return readdirSync(directory).some((entry) => LEGACY_CLAUDE_PROVIDER_CONFIG_ENTRIES.has(entry));
  } catch {
    return false;
  }
}

export function shouldWarnLegacyClaudeProviderConfigDir(workingDirectory: string): boolean {
  const legacyConfigDir = path.resolve(workingDirectory, LEGACY_CLAUDE_PROVIDER_CONFIG_DIR);
  if (!hasLegacyClaudeProviderConfigEntry(legacyConfigDir)) {
    return false;
  }
  if (warnedLegacyClaudeProviderConfigDirs.has(legacyConfigDir)) {
    return false;
  }
  warnedLegacyClaudeProviderConfigDirs.add(legacyConfigDir);
  return true;
}

export function buildClaudeProviderIsolationEnv(ctx: SpawnContext): ClaudeProviderIsolationEnv {
  if (!isClaudeCustomProviderConfig(ctx.config)) {
    return {};
  }

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  return {
    ...clearInheritedClaudeProviderEnv(launchRuntimeFields.envVars),
  };
}
