import { WORKSPACE_GRID_DEMO_ROUTE } from "./workspaceGridDemoConfig";
import type { WorkspacePanelRef } from "./workspaceGridDemoConfig";

export const WORKSPACE_GRID_OPEN_CHANNEL_EVENT = "raft:workspace-grid-demo:open-channel";
export const WORKSPACE_GRID_OPEN_DM_EVENT = "raft:workspace-grid-demo:open-dm";
export const WORKSPACE_GRID_TOGGLE_TASKS_EVENT = "raft:workspace-grid-demo:toggle-tasks";
export const WORKSPACE_GRID_OPEN_PANEL_EVENT = "raft:workspace-grid-demo:open-panel";
export const WORKSPACE_GRID_SCROLL_THREAD_TO_TOP_EVENT = "raft:workspace-grid-demo:scroll-thread-to-top";
const WORKSPACE_GRID_DRAG_PANEL_MIME = "application/x-raft-workspace-panel";
const WORKSPACE_GRID_EXTERNAL_DRAG_CLASS = "workspace-grid-external-drag-active";
let activeWorkspaceGridDragPanel: WorkspaceGridDragPanelData | null = null;

export interface WorkspaceGridOpenChannelEventDetail {
  channelId: string;
  toggle?: boolean;
}

export interface WorkspaceGridOpenDmEventDetail {
  dmChannelId: string;
  toggle?: boolean;
}

export interface WorkspaceGridOpenPanelEventDetail {
  ref: WorkspacePanelRef;
  title?: string;
  subtitle?: string;
  toggle?: boolean;
}

export interface WorkspaceGridScrollThreadToTopEventDetail {
  ref: Extract<WorkspacePanelRef, { kind: "thread" }>;
}

export type WorkspaceGridDragPanelData = WorkspaceGridOpenPanelEventDetail;

function isWorkspacePanelRef(value: unknown): value is WorkspacePanelRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  if (ref.kind === "tasks") return ref.scope === "server";
  if (ref.kind === "settings") return typeof ref.tab === "string" && ref.tab.length > 0;
  if (ref.kind === "thread") {
    return typeof ref.channelId === "string"
      && ref.channelId.length > 0
      && typeof ref.threadRootId === "string"
      && ref.threadRootId.length > 0
      && (ref.threadChannelId === undefined || ref.threadChannelId === null || typeof ref.threadChannelId === "string");
  }
  return ["channel", "dm", "agent", "human", "machine"].includes(String(ref.kind))
    && typeof ref.id === "string"
    && ref.id.length > 0;
}

export function isWorkspaceGridDemoPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized.endsWith(`/${WORKSPACE_GRID_DEMO_ROUTE}`);
}

export function emitWorkspaceGridOpenChannel(channelId: string, options: { toggle?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent<WorkspaceGridOpenChannelEventDetail>(
    WORKSPACE_GRID_OPEN_CHANNEL_EVENT,
    { detail: { channelId, ...options } },
  ));
}

export function emitWorkspaceGridOpenDm(dmChannelId: string, options: { toggle?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent<WorkspaceGridOpenDmEventDetail>(
    WORKSPACE_GRID_OPEN_DM_EVENT,
    { detail: { dmChannelId, ...options } },
  ));
}

export function emitWorkspaceGridToggleTasks(): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_GRID_TOGGLE_TASKS_EVENT));
}

export function emitWorkspaceGridOpenPanel(
  ref: WorkspacePanelRef,
  source: { title?: string; subtitle?: string; toggle?: boolean } = {},
): void {
  window.dispatchEvent(new CustomEvent<WorkspaceGridOpenPanelEventDetail>(
    WORKSPACE_GRID_OPEN_PANEL_EVENT,
    { detail: { ref, ...source } },
  ));
}

export function requestWorkspaceGridThreadScrollToTopFromTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tabButton = target.closest(".flexlayout__tab_button");
  const marker = tabButton?.querySelector<HTMLElement>("[data-workspace-thread-tab]");
  const channelId = marker?.dataset.workspaceThreadChannelId;
  const threadRootId = marker?.dataset.workspaceThreadRootId;
  const threadChannelId = marker?.dataset.workspaceThreadChannelIdResolved;
  if (!channelId || !threadRootId) return false;

  window.dispatchEvent(new window.CustomEvent<WorkspaceGridScrollThreadToTopEventDetail>(
    WORKSPACE_GRID_SCROLL_THREAD_TO_TOP_EVENT,
    {
      detail: {
        ref: {
          kind: "thread",
          channelId,
          threadRootId,
          ...(threadChannelId ? { threadChannelId } : {}),
        },
      },
    },
  ));
  return true;
}

export function subscribeWorkspaceGridThreadScrollToTop(
  ref: Extract<WorkspacePanelRef, { kind: "thread" }>,
  listener: () => void,
): () => void {
  const handleScrollRequest = (event: Event) => {
    const requested = (event as CustomEvent<WorkspaceGridScrollThreadToTopEventDetail>).detail?.ref;
    if (
      requested?.channelId !== ref.channelId
      || requested.threadRootId !== ref.threadRootId
    ) return;
    listener();
  };
  window.addEventListener(WORKSPACE_GRID_SCROLL_THREAD_TO_TOP_EVENT, handleScrollRequest);
  return () => window.removeEventListener(WORKSPACE_GRID_SCROLL_THREAD_TO_TOP_EVENT, handleScrollRequest);
}

export function emitWorkspaceGridDragPanel(
  dragEvent: DragEvent,
  ref: WorkspacePanelRef,
  source: { title?: string; subtitle?: string } = {},
): void {
  activeWorkspaceGridDragPanel = { ref, ...source };
  if (typeof document !== "undefined") document.body.classList.add(WORKSPACE_GRID_EXTERNAL_DRAG_CLASS);
  dragEvent.dataTransfer?.setData(
    WORKSPACE_GRID_DRAG_PANEL_MIME,
    JSON.stringify({ ref, ...source }),
  );
  if (dragEvent.dataTransfer) dragEvent.dataTransfer.effectAllowed = "copyMove";
}

export function clearWorkspaceGridDragPanel(): void {
  activeWorkspaceGridDragPanel = null;
  if (typeof document !== "undefined") document.body.classList.remove(WORKSPACE_GRID_EXTERNAL_DRAG_CLASS);
}

export function readWorkspaceGridDragPanel(
  dataTransfer: DataTransfer,
): WorkspaceGridDragPanelData | null {
  const raw = dataTransfer.getData(WORKSPACE_GRID_DRAG_PANEL_MIME);
  if (!raw) {
    const types = Array.from(dataTransfer.types ?? []);
    return types.includes(WORKSPACE_GRID_DRAG_PANEL_MIME)
      ? activeWorkspaceGridDragPanel
      : null;
  }

  try {
    const value = JSON.parse(raw) as Partial<WorkspaceGridDragPanelData>;
    if (!isWorkspacePanelRef(value.ref)) return null;
    if (value.title !== undefined && typeof value.title !== "string") return null;
    if (value.subtitle !== undefined && typeof value.subtitle !== "string") return null;
    return value as WorkspaceGridDragPanelData;
  } catch {
    return null;
  }
}
