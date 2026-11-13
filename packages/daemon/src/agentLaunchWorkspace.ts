// An agent's workspace before a launch, shared by every agent host
// (AgentProcessManager and the OAR host). Moved verbatim from
// AgentProcessManager.

import type { AgentConfig } from "@botiverse/raft-shared";
import { buildCindyMemoryMd, buildCindySeedFiles } from "./cindy";
import { initializeAgentWorkspace } from "./workspaces";

const ONBOARDING_MEMORY_SEED_ENV = "SLOCK_ONBOARDING_MEMORY_SEED";
const FIRST_CINDY_SEED_MODE = "first-cindy";

function getOnboardingSeedMode(config: AgentConfig): string {
  return (config.envVars?.[ONBOARDING_MEMORY_SEED_ENV] || "").trim().toLowerCase();
}

export function withLocalRuntimeContext(config: AgentConfig, agentId: string, workspacePath: string): AgentConfig {
  return {
    ...config,
    runtimeContext: {
      ...(config.runtimeContext ?? {}),
      agentId: config.runtimeContext?.agentId ?? agentId,
      workspacePath,
    },
  };
}

function buildInitialMemoryMd(config: AgentConfig): string {
  const agentName = config.displayName || config.name;
  const seedMode = getOnboardingSeedMode(config);
  if (seedMode !== FIRST_CINDY_SEED_MODE) {
    return `# ${agentName}\n\n## Role\n${config.description || "No role defined yet."}\n\n## Key Knowledge\n- No notes yet.\n\n## Active Context\n- First startup.\n`;
  }

  return buildCindyMemoryMd(agentName);
}

/** Create (or top up) an agent's workspace at `agentDataDir` before a launch. */
export async function initializeLaunchWorkspace(agentDataDir: string, agentId: string, config: AgentConfig): Promise<void> {
  const initialRuntimeConfig = withLocalRuntimeContext(config, agentId, agentDataDir);
  await initializeAgentWorkspace(
    agentDataDir,
    buildInitialMemoryMd(initialRuntimeConfig),
    getOnboardingSeedMode(config) === FIRST_CINDY_SEED_MODE ? buildCindySeedFiles() : [], config.envVars,
  );
}
