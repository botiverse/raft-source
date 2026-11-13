import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import { useServerFeatureFlag } from "../../store/serverFeatureFlags";

/** workspace_artifacts_v0 for the current server; off while it loads or can't be read. */
export function useWorkspaceArtifactsEnabled(): boolean {
  return useServerFeatureFlag(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY).enabled;
}

