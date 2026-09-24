import {
  Actions,
  DockLocation,
  Model,
  TabNode,
  TabSetNode,
} from "flexlayout-react";
import type {
  IJsonModel,
  IJsonTabNode,
} from "flexlayout-react";

import {
  workspacePanelRefKey,
} from "./workspaceGridDemoConfig";
import type {
  WorkspacePanelConfig,
  WorkspacePanelRef,
} from "./workspaceGridDemoConfig";

export const WORKSPACE_GRID_PRIMARY_TABSET_ID = "workspace-primary";

export function withWorkspaceGridModelDefaults(model: IJsonModel): IJsonModel {
  return {
    ...model,
    global: {
      ...model.global,
      tabSetEnableClose: true,
      tabSetEnableCloseButton: false,
      tabSetEnableMaximize: false,
    },
  };
}

export function createWorkspaceGridModel(model: IJsonModel): Model {
  return Model.fromJson(withWorkspaceGridModelDefaults(model));
}

export function getWorkspaceGridTargetTabsetId(model: Model): string | null {
  const active = model.getActiveTabset();
  if (active) return active.getId();

  const primary = model.getNodeById(WORKSPACE_GRID_PRIMARY_TABSET_ID);
  if (primary instanceof TabSetNode) return primary.getId();

  let firstTabsetId: string | null = null;
  model.visitNodes((node) => {
    if (!firstTabsetId && node instanceof TabSetNode) {
      firstTabsetId = node.getId();
    }
  });
  return firstTabsetId;
}

export function selectWorkspaceGridTab(model: Model, tabId: string): boolean {
  const tab = model.getNodeById(tabId);
  if (!(tab instanceof TabNode)) return false;

  model.doAction(Actions.selectTab(tabId));
  const parent = tab.getParent();
  if (parent instanceof TabSetNode) {
    model.doAction(Actions.setActiveTabset(parent.getId(), parent.getLayoutId()));
  }
  return true;
}

export function getWorkspaceGridActiveTab(model: Model): TabNode | null {
  const activeTabset = model.getActiveTabset() ?? model.getFirstTabSet();
  const selected = activeTabset?.getSelectedNode();
  return selected instanceof TabNode ? selected : null;
}

export function isWorkspaceGridActiveTabForRef(model: Model, ref: WorkspacePanelRef): boolean {
  const active = getWorkspaceGridActiveTab(model);
  if (!(active instanceof TabNode)) return false;
  const config = active.getConfig() as WorkspacePanelConfig | undefined;
  return config?.ref
    ? workspacePanelRefKey(config.ref) === workspacePanelRefKey(ref)
    : false;
}

export function findWorkspaceGridTabIdForRef(model: Model, ref: WorkspacePanelRef): string | null {
  const refKey = workspacePanelRefKey(ref);
  let tabId: string | null = null;
  model.visitNodes((node) => {
    if (tabId || !(node instanceof TabNode)) return;
    const config = node.getConfig() as WorkspacePanelConfig | undefined;
    if (config?.ref && workspacePanelRefKey(config.ref) === refKey) {
      tabId = node.getId();
    }
  });
  return tabId;
}

export function openWorkspaceGridPanelTab(model: Model, tab: IJsonTabNode): string | null {
  const config = tab.config as WorkspacePanelConfig | undefined;
  const existingTabId = config?.ref ? findWorkspaceGridTabIdForRef(model, config.ref) : null;
  if (existingTabId && selectWorkspaceGridTab(model, existingTabId)) return existingTabId;

  const targetTabsetId = getWorkspaceGridTargetTabsetId(model);
  const tabId = tab.id;
  if (!targetTabsetId || !tabId) return null;
  model.doAction(Actions.addTab(tab, targetTabsetId, DockLocation.CENTER, -1, true));
  return model.getNodeById(tabId) instanceof TabNode ? tabId : null;
}

export function isWorkspaceGridTabWritable(tab: TabNode): boolean {
  if (!tab.isSelected()) return false;

  const model = tab.getModel();
  const activeTabset = model.getActiveTabset(tab.getLayoutId());
  const writableTabset = activeTabset ?? model.getFirstTabSet();
  return tab.getParent() === writableTabset;
}

export function hydrateWorkspaceGridPanelDisplays(
  model: Model,
  sources: {
    channels: readonly { id: string; name: string; joined?: boolean; archivedAt?: string | null }[];
    dmChannels?: readonly { id: string; name: string; peerName?: string; peerDisplayName?: string | null }[];
    agents: readonly { id: string; name: string; displayName?: string | null; deletedAt?: string | null }[];
  },
): boolean {
  let changed = false;
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return;
    const config = node.getConfig() as WorkspacePanelConfig | undefined;
    if (!config) return;

    if (config.kind === "channel") {
      const channelRef = config.ref?.kind === "channel" ? config.ref : null;
      const channel = channelRef
        ? sources.channels.find((candidate) => candidate.id === channelRef.id)
        : config.demoSource?.kind === "first-channel"
          ? sources.channels.find((candidate) => candidate.joined && candidate.archivedAt == null)
            ?? sources.channels.find((candidate) => candidate.archivedAt == null)
          : undefined;
      if (!channel) return;
      const name = channel.name;
      const title = `#${channel.name}`;
      if (
        node.getName() === name
        && config.title === title
        && config.ref?.kind === "channel"
        && config.ref.id === channel.id
      ) return;
      model.doAction(Actions.updateNodeAttributes(node.getId(), {
        name,
        config: {
          ...config,
          ref: { kind: "channel", id: channel.id },
          demoSource: undefined,
          title,
        },
      }));
      changed = true;
      return;
    }

    if (config.kind === "dm") {
      const dmRef = config.ref?.kind === "dm" ? config.ref : null;
      const dm = dmRef
        ? sources.dmChannels?.find((candidate) => candidate.id === dmRef.id)
        : undefined;
      if (!dm) return;
      const name = dm.peerDisplayName || dm.peerName || dm.name;
      const title = `@${name}`;
      if (
        node.getName() === name
        && config.title === title
        && config.ref?.kind === "dm"
        && config.ref.id === dm.id
      ) return;
      model.doAction(Actions.updateNodeAttributes(node.getId(), {
        name,
        config: {
          ...config,
          ref: { kind: "dm", id: dm.id },
          demoSource: undefined,
          title,
        },
      }));
      changed = true;
      return;
    }

    if (config.kind === "agent") {
      const agentRef = config.ref?.kind === "agent" ? config.ref : null;
      const agent = agentRef
        ? sources.agents.find((candidate) => candidate.id === agentRef.id && candidate.deletedAt == null)
        : config.demoSource?.kind === "first-agent"
          ? sources.agents.find((candidate) => candidate.deletedAt == null)
          : undefined;
      if (!agent) return;
      const name = agent.displayName || agent.name;
      const title = `@${name}`;
      if (
        node.getName() === name
        && config.title === title
        && config.ref?.kind === "agent"
        && config.ref.id === agent.id
      ) return;
      model.doAction(Actions.updateNodeAttributes(node.getId(), {
        name,
        config: {
          ...config,
          ref: { kind: "agent", id: agent.id },
          demoSource: undefined,
          title,
        },
      }));
      changed = true;
    }
  });
  return changed;
}

export function workspaceGridModelHasTabs(model: Model): boolean {
  let hasTabs = false;
  model.visitNodes((node) => {
    if (node instanceof TabNode) hasTabs = true;
  });
  return hasTabs;
}
