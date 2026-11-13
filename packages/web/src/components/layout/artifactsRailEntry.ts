import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import { useServerFeatureFlag } from "../../store/serverFeatureFlags";

/**
 * Whether the rail shows its Artifacts entry (#proj-workspace:#133, xxchan: "根据
 * artifact gate 决定是否显示"): only where the current server's
 * workspace_artifacts_v0 is on. The rail never asks for flags itself (it is
 * drawn in a server's pending frame too, which asks nothing): it reads the
 * flags already loaded for the current server (one snapshot per server, which
 * the pages load), and a flag not yet known, or a server still `pending`, is
 * hidden.
 */
export function useArtifactsRailShown(pending: boolean): boolean {
  return useServerFeatureFlag(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, { prefetch: false }).enabled && !pending;
}
