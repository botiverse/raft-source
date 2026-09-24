import { useServerStore } from "../../store/serverStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import {
  isWorkspaceGridDemoEnabledForServer,
  WORKSPACE_GRID_DEMO_FLAG_KEY,
} from "./workspaceGridDemoConfig";
import type {
  WorkspaceGridDemoFlag,
} from "./workspaceGridDemoConfig";

export function useWorkspaceGridAvailability(): { resolved: boolean; enabled: boolean } {
  const currentServer = useServerStore((s) => s.current);
  const evaluation = useServerFeatureFlag(WORKSPACE_GRID_DEMO_FLAG_KEY, {
    prefetch: !import.meta.env.DEV,
  });

  if (import.meta.env.DEV) return { resolved: true, enabled: true };
  const resolved = Boolean(currentServer?.id) && evaluation.resolved;
  const flag: WorkspaceGridDemoFlag = evaluation.enabled ? "enabled" : "disabled";
  return {
    resolved,
    enabled: resolved && isWorkspaceGridDemoEnabledForServer(currentServer, flag),
  };
}
