import { workspacePanelRefKey } from "./workspaceGridDemoConfig";
import type { WorkspaceGridNavigationState } from "./workspaceGridNavigationStore";

type WorkspaceGridSidebarKind = "channel" | "dm" | "agent" | "human" | "machine";

interface WorkspaceGridSidebarSelectionOptions {
  kind: WorkspaceGridSidebarKind;
  workspaceActive: boolean;
  activeRefKey: string | null;
  pathname: string;
  pathBase: string;
}

export function selectWorkspaceGridActive(state: WorkspaceGridNavigationState) {
  return state.active;
}

export function selectWorkspaceGridActiveRefKey(state: WorkspaceGridNavigationState) {
  return state.activeRefKey;
}

export function selectWorkspaceGridActiveAncestorRefKey(state: WorkspaceGridNavigationState) {
  return state.activeAncestorRefKey;
}

export function createWorkspaceGridSidebarSelection({
  kind,
  workspaceActive,
  activeRefKey,
  pathname,
  pathBase,
}: WorkspaceGridSidebarSelectionOptions) {
  return (id: string) => {
    if (workspaceActive) {
      return activeRefKey === workspacePanelRefKey({ kind, id });
    }
    return pathname === `${pathBase}/${kind}/${id}`;
  };
}
