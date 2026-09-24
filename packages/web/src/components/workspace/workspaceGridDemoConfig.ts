import type { IJsonModel, IJsonTabNode } from "flexlayout-react";
import { CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import type { MessageId } from "../../i18n/messages/en";
import { en } from "../../i18n/messages/en";
import type { Server } from "../../store/serverStore";

export const WORKSPACE_GRID_DEMO_ROUTE = "workspace";
export const WORKSPACE_GRID_DEMO_FLAG_KEY = CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY;
export type WorkspaceGridDemoFlag = "disabled" | "enabled";

export const WORKSPACE_GRID_DEMO_MOBILE_POLICY = "desktop-only-min-1024" as const;
export const WORKSPACE_GRID_MIN_WIDTH_PX = 1024;
export const WORKSPACE_GRID_VIEWPORT_QUERY = `(min-width: ${WORKSPACE_GRID_MIN_WIDTH_PX}px)`;

export type WorkspaceGridFormatMessage = (
  descriptor: { id: MessageId },
  values?: Record<string, string | number | boolean | null | undefined>,
) => string;

const defaultFormatMessage: WorkspaceGridFormatMessage = (descriptor) =>
  en[descriptor.id] ?? descriptor.id;

export function isWorkspaceGridViewport(width: number): boolean {
  return width >= WORKSPACE_GRID_MIN_WIDTH_PX;
}

export function workspaceGridTabsetActionHostId(tabsetId: string): string {
  return `workspace-tabset-actions-${tabsetId}`;
}

export function isWorkspaceGridDemoEnabledForServer(
  server: Pick<Server, "slug" | "name"> | null | undefined,
  flag: WorkspaceGridDemoFlag,
) {
  return Boolean(server) && flag === "enabled";
}

export type WorkspacePanelRef =
  | { kind: "channel"; id: string }
  | { kind: "dm"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "human"; id: string }
  | { kind: "machine"; id: string }
  | { kind: "settings"; tab: string }
  | {
      kind: "thread";
      channelId: string;
      threadRootId: string;
      threadChannelId?: string | null;
    }
  | { kind: "tasks"; scope: "server" };

export type WorkspacePanelKind = WorkspacePanelRef["kind"];

export function workspacePanelRefKey(ref: WorkspacePanelRef): string {
  if (ref.kind === "tasks") return "tasks:server";
  if (ref.kind === "settings") return `settings:${ref.tab}`;
  if (ref.kind === "thread") {
    return `thread:${ref.channelId}:${ref.threadRootId}`;
  }
  return `${ref.kind}:${ref.id}`;
}

export type WorkspacePanelDemoSource =
  | { kind: "first-channel" }
  | { kind: "first-followed-thread" }
  | { kind: "first-agent" };

export interface WorkspacePanelConfig {
  kind: WorkspacePanelKind;
  ref?: WorkspacePanelRef;
  demoSource?: WorkspacePanelDemoSource;
  title: string;
  subtitle: string;
  summary: string;
  accent: "yellow" | "cyan" | "lavender" | "pink" | "lime";
  pinned?: boolean;
  lockedBy?: string;
}

export function workspaceGridPanelTab(
  id: string,
  name: string,
  config: WorkspacePanelConfig,
): IJsonTabNode {
  return {
    type: "tab",
    id,
    name,
    component: "workspace-panel",
    config,
    enableClose: !config.pinned,
    enableDrag: !config.pinned,
  };
}

export function createWorkspaceGridDemoInitialModel(
  formatMessage: WorkspaceGridFormatMessage = defaultFormatMessage,
): IJsonModel {
  const chatTitle = String(formatMessage({ id: "workspace.grid.demo.chatTitle" }));
  return {
    global: {
      enableEdgeDock: true,
      tabEnableRename: false,
      tabSetEnableClose: true,
      tabSetEnableCloseButton: false,
      tabSetEnableMaximize: true,
      tabSetMinWidth: 260,
      tabSetMinHeight: 180,
    },
    borders: [],
    layout: {
      type: "row",
      id: "workspace-root",
      weight: 100,
      children: [
        {
          type: "tabset",
          id: "workspace-primary",
          selected: 0,
          children: [
            workspaceGridPanelTab("workspace-channel-home", chatTitle, {
              kind: "channel",
              demoSource: { kind: "first-channel" },
              title: chatTitle,
              subtitle: String(formatMessage({ id: "workspace.panel.channel" })),
              summary: String(formatMessage({ id: "workspace.grid.demo.chatSummary" })),
              accent: "yellow",
            }),
          ],
        },
      ],
    },
  };
}

/** English catalog snapshot for contract tests and non-React callers. */
export const WORKSPACE_GRID_DEMO_INITIAL_MODEL: IJsonModel =
  createWorkspaceGridDemoInitialModel();
