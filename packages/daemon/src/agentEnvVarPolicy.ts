import type { AgentConfig } from "@botiverse/raft-shared";

import { AgentEnvVarsNotAllowedError } from "./spawnFailureErrors";

export {
  disallowedAgentEnvVarNames,
  invalidAgentEnvVarNameCount,
  isDisallowedAgentEnvVarName,
} from "@botiverse/raft-shared";
import { disallowedAgentEnvVarNames, invalidAgentEnvVarNameCount } from "@botiverse/raft-shared";

/**
 * The refusal for a start whose config sets a disallowed env var, or null.
 * Reads both places a server config carries env vars: the legacy `envVars`
 * column and the structured `runtimeConfig.envVars` (launches hydrate from
 * either).
 */
export function agentEnvVarsRefusal(config: Pick<AgentConfig, "runtime" | "envVars" | "runtimeConfig">): AgentEnvVarsNotAllowedError | null {
  const names = [...new Set([
    ...disallowedAgentEnvVarNames(config.envVars),
    ...disallowedAgentEnvVarNames(config.runtimeConfig?.envVars),
  ])].sort();
  const invalidNameCount = Math.max(
    invalidAgentEnvVarNameCount(config.envVars),
    invalidAgentEnvVarNameCount(config.runtimeConfig?.envVars),
  );
  if (names.length === 0 && invalidNameCount === 0) return null;
  return new AgentEnvVarsNotAllowedError({ runtimeId: config.runtime, names, invalidNameCount });
}
