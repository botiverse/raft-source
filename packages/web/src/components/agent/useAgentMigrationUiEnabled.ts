import { AGENT_MIGRATION_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";

export function useAgentMigrationUiEnabled(): boolean {
  return useServerFeatureFlag(AGENT_MIGRATION_FEATURE_FLAG_KEY).enabled;
}
