import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useIntl } from "react-intl";
import { AtSign, Bot, CheckSquare, ChevronDown, Columns3, Hash, MessageSquareText, Monitor, Search, Settings, User, X } from "lucide-react";
import {
  Layout,
  Actions,
  DockLocation,
  RowNode,
  TabSetNode,
  TabNode,
} from "flexlayout-react";
import type {
  BorderNode,
  Action,
  IJsonTabNode,
  ITabSetRenderValues,
  ITabRenderValues,
  Model,
  Node as FlexLayoutNode,
} from "flexlayout-react";
import "flexlayout-react/style/dark.css";
import "./WorkspaceGridDemo.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "raft-ui";

import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useThreadStore } from "../../store/threadStore";
import {
  createWorkspaceGridDemoInitialModel,
  workspacePanelRefKey,
  workspaceGridPanelTab,
  workspaceGridTabsetActionHostId,
} from "./workspaceGridDemoConfig";
import type {
  WorkspacePanelConfig,
  WorkspacePanelRef,
} from "./workspaceGridDemoConfig";
import { createWorkspaceGridPanelFactory } from "./WorkspaceGridRealPanel";
import {
  useWorkspaceGridUrlState,
} from "./workspaceGridUrlState";
import {
  WORKSPACE_GRID_OPEN_CHANNEL_EVENT,
  WORKSPACE_GRID_OPEN_DM_EVENT,
  WORKSPACE_GRID_OPEN_PANEL_EVENT,
  clearWorkspaceGridDragPanel,
  readWorkspaceGridDragPanel,
  requestWorkspaceGridThreadScrollToTopFromTarget,
} from "./workspaceGridOpenEvents";
import type {
  WorkspaceGridOpenChannelEventDetail,
  WorkspaceGridOpenDmEventDetail,
  WorkspaceGridOpenPanelEventDetail,
} from "./workspaceGridOpenEvents";
import {
  createWorkspaceGridModel,
  findWorkspaceGridTabIdForRef,
  getWorkspaceGridActiveTab,
  getWorkspaceGridTargetTabsetId,
  hydrateWorkspaceGridPanelDisplays,
  isWorkspaceGridActiveTabForRef,
  openWorkspaceGridPanelTab,
  selectWorkspaceGridTab,
  workspaceGridModelHasTabs,
} from "./workspaceGridModel";
import { useWorkspaceGridNavigationStore } from "./workspaceGridNavigationStore";
import { SEARCH_FOCUS_REQUEST_EVENT } from "../../utils/searchFocusRequest";
import { ChannelKindIcon } from "../channel/channelKindIcon";
import { nextWorkspaceMruTabId, nextWorkspaceTabIndex } from "./workspaceGridKeyboard";
import type { WorkspaceTabNavigationKey } from "./workspaceGridKeyboard";
import type { MessageId } from "../../i18n/messages/en";

const TASKS_TAB_ID = "workspace-tasks";

type FormatMessage = (
  descriptor: { id: MessageId },
  values?: Record<string, string | number | boolean | null | undefined>,
) => string;

interface WorkspaceOverflowMenuState {
  anchor: HTMLElement;
  selectedTabId: string | null;
}

interface WorkspaceOverviewItem {
  node: TabNode;
  paneId: string;
  paneLabel: string;
}

interface WorkspaceRecentlyClosedTab {
  key: number;
  tab: IJsonTabNode;
  paneId: string | null;
  paneLabel: string;
}

const WORKSPACE_RECENTLY_CLOSED_LIMIT = 10;
const WORKSPACE_OVERVIEW_ICON_TONE: Record<WorkspacePanelConfig["accent"], string> = {
  yellow: "bg-soft-signal",
  cyan: "bg-brutal-cyan",
  lavender: "bg-brutal-lavender",
  pink: "bg-brutal-pink",
  lime: "bg-brutal-lime",
};

function workspaceTabsetsInVisualOrder(model: Model): TabSetNode[] {
  const tabsets: TabSetNode[] = [];
  model.visitNodes((node) => {
    if (node instanceof TabSetNode) tabsets.push(node);
  });
  return tabsets.sort((left, right) => {
    const leftRect = left.getRect();
    const rightRect = right.getRect();
    return leftRect.x - rightRect.x || leftRect.y - rightRect.y;
  });
}

function workspacePaneLabel(tabsets: TabSetNode[], tabset: TabSetNode): string {
  const index = tabsets.findIndex((candidate) => candidate.getId() === tabset.getId());
  if (index <= 0) return "L";
  if (index === 1) return "R";
  return String(index + 1);
}

function workspaceOtherTabset(model: Model, tab: TabNode): TabSetNode | null {
  const parent = tab.getParent();
  if (!(parent instanceof TabSetNode)) return null;
  const tabsets = workspaceTabsetsInVisualOrder(model);
  const index = tabsets.findIndex((candidate) => candidate.getId() === parent.getId());
  if (index < 0 || tabsets.length < 2) return null;
  return tabsets[index === 0 ? 1 : index - 1] ?? null;
}

function workspaceNodeForPath(model: Model, path: string | undefined): FlexLayoutNode | null {
  if (!path) return null;
  let match: FlexLayoutNode | null = null;
  model.visitNodes((node) => {
    if (node.getPath() === path) match = node;
  });
  return match;
}

function workspaceTabsetForElement(model: Model, element: Element | null): TabSetNode | null {
  const path = element?.closest<HTMLElement>(".flexlayout__tabset")?.dataset.layoutPath;
  const tabsetNode = workspaceNodeForPath(model, path);
  return tabsetNode instanceof TabSetNode ? tabsetNode : null;
}

function workspaceTabForElement(model: Model, element: Element | null): TabNode | null {
  const tabElement = element?.closest<HTMLElement>(".flexlayout__tab_button");
  const tabsetElement = tabElement?.closest<HTMLElement>(".flexlayout__tabset");
  const tabsetNode = workspaceNodeForPath(model, tabsetElement?.dataset.layoutPath);
  if (!(tabsetNode instanceof TabSetNode) || !tabElement || !tabsetElement) return null;
  const index = [...tabsetElement.querySelectorAll<HTMLElement>(".flexlayout__tab_button")].indexOf(tabElement);
  const tabNode = tabsetNode.getChildren()[index];
  return tabNode instanceof TabNode ? tabNode : null;
}

function makeTasksTab(formatMessage: FormatMessage): IJsonTabNode {
  const tasksTitle = String(formatMessage({ id: "workspace.panel.tasks" }));
  return workspaceGridPanelTab(TASKS_TAB_ID, tasksTitle, {
    kind: "tasks",
    ref: { kind: "tasks", scope: "server" },
    title: tasksTitle,
    subtitle: String(formatMessage({ id: "workspace.panel.taskQueue" })),
    summary: String(formatMessage({ id: "workspace.grid.mock.tasksPanelSummary" })),
    accent: "lime",
  });
}

function workspaceTabIdForRef(ref: WorkspacePanelRef): string {
  if (ref.kind === "tasks") return TASKS_TAB_ID;
  if (ref.kind === "settings") return `workspace-settings-${ref.tab}`;
  if (ref.kind === "thread") {
    return `workspace-thread-${ref.channelId}-${ref.threadRootId}`;
  }
  return `workspace-${ref.kind}-${ref.id}`;
}

function makeRefTab(
  ref: WorkspacePanelRef,
  source: { title?: string; subtitle?: string } = {},
  formatMessage: FormatMessage,
): IJsonTabNode {
  if (ref.kind === "tasks") return makeTasksTab(formatMessage);

  const title = source.title
    ?? (ref.kind === "channel" ? `#${ref.id}`
      : ref.kind === "dm" || ref.kind === "agent" || ref.kind === "human" ? `@${ref.id}`
        : ref.kind === "machine" ? ref.id
          : ref.kind === "settings" ? String(formatMessage({ id: "workspace.panel.settingsTitle" }))
            : String(formatMessage({ id: "search.panelThreadTitle" }, { id: ref.threadRootId.slice(0, 8) })));
  const subtitle = source.subtitle
    ?? (ref.kind === "thread" ? String(formatMessage({ id: "workspace.panel.thread" }))
      : ref.kind === "channel" ? String(formatMessage({ id: "workspace.panel.channel" }))
        : ref.kind === "dm" ? String(formatMessage({ id: "workspace.panel.directMessage" }))
          : String(formatMessage({ id: "workspace.panel.channel" })));

  const accent: WorkspacePanelConfig["accent"] =
    ref.kind === "thread" ? "cyan"
      : ref.kind === "agent" ? "lavender"
        : ref.kind === "human" ? "pink"
          : ref.kind === "machine" ? "lime"
            : ref.kind === "settings" ? "yellow"
          : "yellow";

  const tabName = title.replace(/^[@#]/, "");
  return workspaceGridPanelTab(workspaceTabIdForRef(ref), tabName, {
    kind: ref.kind,
    ref,
    title,
    subtitle,
    summary: String(formatMessage({ id: "workspace.panel.openedFromInteraction" })),
    accent,
  });
}

function createInitialWorkspaceGridModel(
  layoutIntent: Parameters<typeof createWorkspaceGridModel>[0] | null,
  initialPanel: WorkspaceGridDemoProps["initialPanel"] | undefined,
  formatMessage: FormatMessage,
) {
  const model = createWorkspaceGridModel(layoutIntent ?? createWorkspaceGridDemoInitialModel(formatMessage));
  if (layoutIntent || !initialPanel) return model;

  const initialTab = getWorkspaceGridActiveTab(model);
  const nextTab = makeRefTab(initialPanel.ref, initialPanel, formatMessage);
  if (initialTab) {
    model.doAction(Actions.updateNodeAttributes(initialTab.getId(), {
      name: nextTab.name,
      component: nextTab.component,
      config: nextTab.config,
      enableClose: nextTab.enableClose,
    }));
  }
  return model;
}

export interface WorkspaceGridDemoProps {
  initialPanel?: {
    ref: WorkspacePanelRef;
    title?: string;
    subtitle?: string;
  };
}

export default function WorkspaceGridDemo({ initialPanel }: WorkspaceGridDemoProps) {
  const { formatMessage } = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const agents = useAgentStore((s) => s.agents);
  const { rawLayoutIntent, layoutIntent, writeLayoutIntent } = useWorkspaceGridUrlState();
  const lastUrlWriteRef = useRef<string | null>(rawLayoutIntent);
  const layoutRootRef = useRef<HTMLDivElement | null>(null);
  const externalDragSequenceRef = useRef(0);
  const externalDropEdgeRef = useRef<"left" | "right" | "top" | "bottom" | null>(null);
  const [model, setModel] = useState(() =>
    createInitialWorkspaceGridModel(layoutIntent, initialPanel, formatMessage),
  );
  const [tabMenu, setTabMenu] = useState<{ node: TabNode; x: number; y: number } | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<WorkspaceOverflowMenuState | null>(null);
  const [overflowQuery, setOverflowQuery] = useState("");
  const [recentlyClosedTabs, setRecentlyClosedTabs] = useState<WorkspaceRecentlyClosedTab[]>([]);
  const [tabFeedback, setTabFeedback] = useState("");
  const [renderSequence, setSequence] = useState(0);
  const activeTabsetIdRef = useRef<string | null>(null);
  const mruTabIdsRef = useRef<string[]>([]);
  const recentlyClosedSequenceRef = useRef(0);
  const tabMenuRef = useRef<HTMLDivElement | null>(null);
  const setActiveRefKey = useWorkspaceGridNavigationStore((s) => s.setActiveRefKey);
  const setActiveAncestorRefKey = useWorkspaceGridNavigationStore((s) => s.setActiveAncestorRefKey);
  const setWorkspaceRailMode = useWorkspaceGridNavigationStore((s) => s.setRailMode);
  const setWorkspaceSidebarCollapsed = useWorkspaceGridNavigationStore((s) => s.setSidebarCollapsed);

  const syncModelToUrl = useCallback((nextModel = model) => {
    const encoded = writeLayoutIntent(nextModel.toJson());
    lastUrlWriteRef.current = encoded;
  }, [model, writeLayoutIntent]);

  const recordMruTab = useCallback((tabId: string) => {
    mruTabIdsRef.current = [tabId, ...mruTabIdsRef.current.filter((candidate) => candidate !== tabId)].slice(0, 24);
  }, []);

  const focusWorkspaceTab = useCallback((tab: TabNode | undefined) => {
    if (!tab) return;
    requestAnimationFrame(() => {
      const parent = tab.getParent();
      if (!(parent instanceof TabSetNode)) return;
      const tabset = [...(layoutRootRef.current?.querySelectorAll<HTMLElement>(".flexlayout__tabset") ?? [])].find((candidate) => candidate.dataset.layoutPath === parent.getPath());
      const index = parent.getChildren().indexOf(tab);
      tabset?.querySelectorAll<HTMLElement>(".flexlayout__tab_button")[index]?.focus();
    });
  }, []);

  const activateWorkspaceTabset = useCallback((tabset: TabSetNode | null) => {
    if (!tabset) return;
    if (activeTabsetIdRef.current !== tabset.getId()) {
      activeTabsetIdRef.current = tabset.getId();
      model.doAction(Actions.setActiveTabset(tabset.getId()));
    }
    const selected = tabset.getSelectedNode();
    if (selected instanceof TabNode) recordMruTab(selected.getId());
  }, [model, recordMruTab]);

  const commitWorkspaceCommand = useCallback((focusTab?: TabNode) => {
    syncModelToUrl();
    setSequence((value) => value + 1);
    focusWorkspaceTab(focusTab);
  }, [focusWorkspaceTab, syncModelToUrl]);

  const rememberClosedTabs = useCallback((tabs: TabNode[]) => {
    const tabsets = workspaceTabsetsInVisualOrder(model);
    const entries = tabs.map((tab) => {
      const parent = tab.getParent();
      const json = tab.toJson() as IJsonTabNode;
      return {
        key: ++recentlyClosedSequenceRef.current,
        tab: json,
        paneId: parent instanceof TabSetNode ? parent.getId() : null,
        paneLabel: parent instanceof TabSetNode ? workspacePaneLabel(tabsets, parent) : "L",
      } satisfies WorkspaceRecentlyClosedTab;
    }).reverse();
    if (entries.length === 0) return;
    setRecentlyClosedTabs((current) => [...entries, ...current].slice(0, WORKSPACE_RECENTLY_CLOSED_LIMIT));
  }, [model]);

  const closeWorkspaceTab = useCallback((tab: TabNode): boolean => {
    const config = tab.getConfig() as WorkspacePanelConfig | undefined;
    if (config?.pinned || !tab.isEnableClose()) {
      setTabFeedback(formatMessage({ id: "workspace.pinnedCannotClose" }, { title: tab.getName() }));
      focusWorkspaceTab(tab);
      return false;
    }
    const parent = tab.getParent();
    rememberClosedTabs([tab]);
    model.doAction(Actions.deleteTab(tab.getId()));
    const nextSelected = parent instanceof TabSetNode ? parent.getSelectedNode() : undefined;
    commitWorkspaceCommand(nextSelected instanceof TabNode ? nextSelected : undefined);
    return true;
  }, [commitWorkspaceCommand, focusWorkspaceTab, formatMessage, model, rememberClosedTabs]);

  const ancestorRefKey = useCallback((ref: WorkspacePanelRef | undefined) => {
    if (!ref || ref.kind !== "thread") return null;
    const kind = dmChannels.some((candidate) => candidate.id === ref.channelId) ? "dm" : "channel";
    return `${kind}:${ref.channelId}`;
  }, [dmChannels]);

  useEffect(() => {
    hydrateWorkspaceGridPanelDisplays(model, { channels, dmChannels, agents });
  }, [agents, channels, dmChannels, model]);

  const openPanelRef = useCallback((ref: WorkspacePanelRef, source?: { title?: string; subtitle?: string }) => {
    if (!openWorkspaceGridPanelTab(model, makeRefTab(ref, source, formatMessage))) return;
    setActiveRefKey(workspacePanelRefKey(ref));
    setActiveAncestorRefKey(ancestorRefKey(ref));
    syncModelToUrl();
    setSequence((value) => value + 1);
  }, [ancestorRefKey, formatMessage, model, setActiveAncestorRefKey, setActiveRefKey, syncModelToUrl]);

  const openSidebarPanelRef = useCallback((ref: WorkspacePanelRef, source?: { title?: string; subtitle?: string }, toggle = false) => {
    // Sidebar rows are toggle controls: selecting the already-active panel
    // closes it, while selecting an existing non-active panel brings it to the
    // front. Keep this behavior at the workspace host seam so every sidebar
    // row kind (channel, DM, agent, human, and machine) follows the same rule.
    const activeTab = getWorkspaceGridActiveTab(model);
    if (toggle && activeTab && isWorkspaceGridActiveTabForRef(model, ref)) {
      closeWorkspaceTab(activeTab);
      return;
    }
    const refKey = workspacePanelRefKey(ref);
    if (!openWorkspaceGridPanelTab(model, makeRefTab(ref, source, formatMessage))) return;
    setActiveRefKey(refKey);
    setActiveAncestorRefKey(ancestorRefKey(ref));
    syncModelToUrl();
    setSequence((value) => value + 1);
  }, [ancestorRefKey, closeWorkspaceTab, formatMessage, model, setActiveAncestorRefKey, setActiveRefKey, syncModelToUrl]);

  const openSearchChannel = useCallback((channelId: string) => {
    const params = new URLSearchParams(location.search);
    params.set("channelId", channelId);
    params.set("defer", "1");
    navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
    setWorkspaceRailMode("search");
    setWorkspaceSidebarCollapsed(false, null);
    requestAnimationFrame(() => document.dispatchEvent(new Event(SEARCH_FOCUS_REQUEST_EVENT)));
  }, [location.pathname, location.search, navigate, setWorkspaceRailMode, setWorkspaceSidebarCollapsed]);

  const factory = useMemo(
    () => createWorkspaceGridPanelFactory({ onOpenPanelRef: openPanelRef, onSearchChannel: openSearchChannel }),
    [openPanelRef, openSearchChannel],
  );

  useEffect(() => {
    if (rawLayoutIntent === lastUrlWriteRef.current) return;
    if (!layoutIntent) return;
    lastUrlWriteRef.current = rawLayoutIntent;
    // oxlint-disable-next-line react-doctor/no-chain-state-updates, react-doctor/no-derived-state -- URL navigation replaces the external FlexLayout model.
    setModel(createWorkspaceGridModel(layoutIntent));
  }, [layoutIntent, rawLayoutIntent]);

  useEffect(() => {
    if (rawLayoutIntent) return;
    syncModelToUrl();
  }, [rawLayoutIntent, syncModelToUrl]);

  useEffect(() => () => {
    useThreadStore.getState().closeThread();
    useWorkspaceGridNavigationStore.getState().setActiveRefKey(null);
    useWorkspaceGridNavigationStore.getState().setActiveAncestorRefKey(null);
  }, []);

  useEffect(() => {
    document.body.classList.add("workspace-grid-drag-theme");
    const clearDragPanel = () => clearWorkspaceGridDragPanel();
    window.addEventListener("dragend", clearDragPanel);
    window.addEventListener("drop", clearDragPanel);
    return () => {
      document.body.classList.remove("workspace-grid-drag-theme");
      window.removeEventListener("dragend", clearDragPanel);
      window.removeEventListener("drop", clearDragPanel);
      clearWorkspaceGridDragPanel();
    };
  }, []);

  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
    };
  }, [tabMenu]);

  useEffect(() => {
    if (!tabMenu) return;
    requestAnimationFrame(() => tabMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
  }, [tabMenu]);

  useEffect(() => {
    const root = layoutRootRef.current;
    if (!root) return;
    const syncTabAccessibility = () => {
      model.visitNodes((node) => {
        if (!(node instanceof TabSetNode)) return;
        const tabset = [...root.querySelectorAll<HTMLElement>(".flexlayout__tabset")].find((element) => element.dataset.layoutPath === node.getPath());
        const tablist = tabset?.querySelector<HTMLElement>(".flexlayout__tabset_tabbar_inner_tab_container");
        tablist?.setAttribute("role", "tablist");
        tablist?.setAttribute("aria-label", formatMessage({ id: "workspace.tabsAria" }));
        const tabElements = tabset?.querySelectorAll<HTMLElement>(".flexlayout__tab_button") ?? [];
        node.getChildren().forEach((child, index) => {
          if (!(child instanceof TabNode)) return;
          const tab = tabElements[index];
          if (!tab) return;
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(child.isSelected()));
          tab.tabIndex = child.isSelected() ? 0 : -1;
        });
      });
    };
    syncTabAccessibility();
    const observer = new MutationObserver(syncTabAccessibility);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [formatMessage, model, renderSequence]);

  useEffect(() => {
    const activeConfig = getWorkspaceGridActiveTab(model)?.getConfig() as WorkspacePanelConfig | undefined;
    if (!activeConfig?.ref) return;
    const refKey = workspacePanelRefKey(activeConfig.ref);
    setActiveRefKey(refKey);
    setActiveAncestorRefKey(ancestorRefKey(activeConfig.ref));
  }, [ancestorRefKey, model, setActiveAncestorRefKey, setActiveRefKey]);

  useEffect(() => {
    const handleOpenChannel = (event: Event) => {
      const { channelId, toggle } = (event as CustomEvent<WorkspaceGridOpenChannelEventDetail>).detail ?? {};
      if (!channelId) return;
      const channel = channels.find((candidate) => candidate.id === channelId);
      if (channel) {
        openSidebarPanelRef(
          { kind: "channel", id: channel.id },
          { title: `#${channel.name}`, subtitle: formatMessage({ id: "workspace.panel.channel" }) },
          toggle,
        );
      }
    };

    const handleOpenDm = (event: Event) => {
      const { dmChannelId, toggle } = (event as CustomEvent<WorkspaceGridOpenDmEventDetail>).detail ?? {};
      if (!dmChannelId) return;
      const dm = dmChannels.find((candidate) => candidate.id === dmChannelId);
      if (dm) {
        openSidebarPanelRef(
          { kind: "dm", id: dm.id },
          {
            title: `@${dm.peerDisplayName || dm.peerName || dm.name}`,
            subtitle: formatMessage({ id: "workspace.panel.directMessage" }),
          },
          toggle,
        );
      }
    };

    const handleOpenPanel = (event: Event) => {
      const { ref, title, subtitle, toggle } = (event as CustomEvent<WorkspaceGridOpenPanelEventDetail>).detail ?? {};
      if (!ref) return;
      openSidebarPanelRef(ref, { title, subtitle }, toggle);
    };

    window.addEventListener(WORKSPACE_GRID_OPEN_CHANNEL_EVENT, handleOpenChannel);
    window.addEventListener(WORKSPACE_GRID_OPEN_DM_EVENT, handleOpenDm);
    window.addEventListener(WORKSPACE_GRID_OPEN_PANEL_EVENT, handleOpenPanel);
    return () => {
      window.removeEventListener(WORKSPACE_GRID_OPEN_CHANNEL_EVENT, handleOpenChannel);
      window.removeEventListener(WORKSPACE_GRID_OPEN_DM_EVENT, handleOpenDm);
      window.removeEventListener(WORKSPACE_GRID_OPEN_PANEL_EVENT, handleOpenPanel);
    };
  }, [channels, dmChannels, formatMessage, openSidebarPanelRef]);

  const handleExternalDrag = useCallback((event: React.DragEvent<HTMLElement>) => {
    const payload = readWorkspaceGridDragPanel(event.dataTransfer);
    if (!payload) return undefined;
    const { ref, title, subtitle } = payload;
    const baseTab = makeRefTab(ref, { title, subtitle }, formatMessage);
    const baseTabId = baseTab.id ?? workspaceTabIdForRef(ref);
    const json = model.getNodeById(baseTabId)
      ? { ...baseTab, id: `${baseTabId}-drag-${++externalDragSequenceRef.current}` }
      : baseTab;
    return {
      json,
      onDrop: (node?: FlexLayoutNode) => {
        clearWorkspaceGridDragPanel();
        if (!node) return;
        const edge = externalDropEdgeRef.current;
        externalDropEdgeRef.current = null;
        const droppedTabset = node.getParent();
        const row = droppedTabset?.getParent();
        if (edge && droppedTabset instanceof TabSetNode && row) {
          const siblings = row.getChildren();
          const otherSiblings = siblings.filter(
            (candidate): candidate is RowNode | TabSetNode =>
              candidate !== droppedTabset && (candidate instanceof RowNode || candidate instanceof TabSetNode),
          );
          const otherWeight = otherSiblings.reduce((sum, candidate) => sum + candidate.getWeight(), 0);
          droppedTabset.setWeight(24);
          for (const sibling of otherSiblings) {
            sibling.setWeight(otherWeight > 0 ? (sibling.getWeight() / otherWeight) * 76 : 76 / otherSiblings.length);
          }
        }
        setActiveRefKey(workspacePanelRefKey(ref));
        setActiveAncestorRefKey(ancestorRefKey(ref));
        syncModelToUrl();
        setSequence((value) => value + 1);
      },
    };
  }, [ancestorRefKey, formatMessage, model, setActiveAncestorRefKey, setActiveRefKey, syncModelToUrl]);

  const handleWorkspaceDragOverCapture = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const root = layoutRootRef.current;
    if (!root) return;
    const clientX = event.clientX;
    const clientY = event.clientY;
    requestAnimationFrame(() => {
      const outline = root.querySelector<HTMLElement>(".flexlayout__outline_rect, .flexlayout__outline_rect_edge");
      if (!outline || outline.style.visibility === "hidden") {
        externalDropEdgeRef.current = null;
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const outlineRect = outline.getBoundingClientRect();
      if (outline.classList.contains("flexlayout__outline_rect_edge")) {
        const horizontal = outlineRect.width > outlineRect.height;
        const edge = horizontal
          ? (clientY < rootRect.top + rootRect.height / 2 ? "top" : "bottom")
          : (clientX < rootRect.left + rootRect.width / 2 ? "left" : "right");
        externalDropEdgeRef.current = edge;
        outline.dataset.workspaceDropKind = "edge";
        if (edge === "left" || edge === "right") {
          const width = rootRect.width * 0.24;
          outline.style.width = `${width}px`;
          outline.style.left = `${edge === "left" ? 0 : rootRect.width - width}px`;
        } else {
          const height = rootRect.height * 0.24;
          outline.style.height = `${height}px`;
          outline.style.top = `${edge === "top" ? 0 : rootRect.height - height}px`;
        }
        return;
      }
      externalDropEdgeRef.current = null;
      outline.dataset.workspaceDropKind = outlineRect.width <= 12 || outlineRect.height <= 12
        ? "insertion"
        : "center";
    });
  }, []);

  const handleModelChange = () => {
    const activeTabset = model.getActiveTabset();
    if (activeTabset) {
      activeTabsetIdRef.current = activeTabset.getId();
      const selected = activeTabset.getSelectedNode();
      if (selected instanceof TabNode) recordMruTab(selected.getId());
    }
    const activeConfig = getWorkspaceGridActiveTab(model)?.getConfig() as WorkspacePanelConfig | undefined;
    const activeRef = activeConfig?.ref;
    setActiveRefKey(activeRef ? workspacePanelRefKey(activeRef) : null);
    setActiveAncestorRefKey(ancestorRefKey(activeRef));
    setSequence((value) => value + 1);
    syncModelToUrl();
  };
  const handleContextMenu = (node: TabNode | Parameters<NonNullable<React.ComponentProps<typeof Layout>["onContextMenu"]>>[0], event: React.MouseEvent<HTMLElement>) => {
    if (!(node instanceof TabNode)) return;
    event.preventDefault();
    event.stopPropagation();
    const parent = node.getParent();
    activateWorkspaceTabset(parent instanceof TabSetNode ? parent : null);
    setTabMenu({ node, x: event.clientX, y: event.clientY });
  };
  const closeTabMenu = (restoreFocus: boolean) => {
    const node = tabMenu?.node;
    setTabMenu(null);
    if (restoreFocus) focusWorkspaceTab(node);
  };
  const togglePinnedTab = () => {
    if (!tabMenu) return;
    const { node } = tabMenu;
    const config = node.getConfig() as WorkspacePanelConfig;
    const nextPinned = !config.pinned;
    const parent = node.getParent();
    model.doAction(Actions.updateNodeAttributes(node.getId(), {
      config: { ...config, pinned: nextPinned },
      enableClose: !nextPinned,
      enableDrag: !nextPinned,
    }));
    if (parent instanceof TabSetNode) {
      const pinnedCount = parent.getChildren().filter((candidate) =>
        candidate instanceof TabNode
        && candidate.getId() !== node.getId()
        && (candidate.getConfig() as WorkspacePanelConfig | undefined)?.pinned === true
      ).length;
      model.doAction(Actions.moveNode(
        node.getId(),
        parent.getId(),
        DockLocation.CENTER,
        pinnedCount,
        true,
      ));
    }
    closeTabMenu(true);
    syncModelToUrl();
    setSequence((value) => value + 1);
  };
  const closeContextTab = () => {
    if (tabMenu && closeWorkspaceTab(tabMenu.node)) setTabMenu(null);
  };
  const closeOtherContextTabs = () => {
    if (!tabMenu) return;
    const { node } = tabMenu;
    const parent = node.getParent();
    if (!(parent instanceof TabSetNode)) return;
    const candidates = parent.getChildren().filter(
      (candidate): candidate is TabNode => candidate instanceof TabNode
        && candidate.getId() !== node.getId()
        && !(candidate.getConfig() as WorkspacePanelConfig | undefined)?.pinned
        && candidate.isEnableClose(),
    );
    rememberClosedTabs(candidates);
    for (const candidate of candidates) model.doAction(Actions.deleteTab(candidate.getId()));
    closeTabMenu(true);
    commitWorkspaceCommand(node);
  };
  const closeAllContextTabs = () => {
    if (!tabMenu) return;
    const parent = tabMenu.node.getParent();
    if (!(parent instanceof TabSetNode)) return;
    const candidates = parent.getChildren().filter(
      (candidate): candidate is TabNode => candidate instanceof TabNode
        && !(candidate.getConfig() as WorkspacePanelConfig | undefined)?.pinned
        && candidate.isEnableClose(),
    );
    rememberClosedTabs(candidates);
    for (const candidate of candidates) model.doAction(Actions.deleteTab(candidate.getId()));
    setTabMenu(null);
    const nextSelected = parent.getSelectedNode();
    commitWorkspaceCommand(nextSelected instanceof TabNode ? nextSelected : undefined);
  };
  const moveContextTabToOtherPane = () => {
    if (!tabMenu) return;
    const { node } = tabMenu;
    const target = workspaceOtherTabset(model, node);
    if (!target) return;
    const pinned = (node.getConfig() as WorkspacePanelConfig | undefined)?.pinned === true;
    const targetIndex = pinned
      ? target.getChildren().filter((candidate) =>
          candidate instanceof TabNode
          && (candidate.getConfig() as WorkspacePanelConfig | undefined)?.pinned === true
        ).length
      : -1;
    model.doAction(Actions.moveNode(node.getId(), target.getId(), DockLocation.CENTER, targetIndex, true));
    activeTabsetIdRef.current = target.getId();
    model.doAction(Actions.setActiveTabset(target.getId()));
    closeTabMenu(false);
    commitWorkspaceCommand(node);
  };

  const handleWorkspacePointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (layoutRootRef.current) layoutRootRef.current.dataset.workspaceKeyboardFocus = "false";
    activateWorkspaceTabset(workspaceTabsetForElement(model, event.target as Element));
  };
  const handleWorkspaceFocusCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    activateWorkspaceTabset(workspaceTabsetForElement(model, event.target as Element));
  };
  const handleWorkspaceKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (layoutRootRef.current) layoutRootRef.current.dataset.workspaceKeyboardFocus = "true";
    const target = event.target as Element;
    const tabElement = target.closest<HTMLElement>(".flexlayout__tab_button");
    const tabNode = workspaceTabForElement(model, tabElement);
    const activeTabset = model.getActiveTabset() ?? workspaceTabsetForElement(model, target);

    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
      const current = activeTabset?.getSelectedNode();
      const nextId = nextWorkspaceMruTabId(mruTabIdsRef.current, current instanceof TabNode ? current.getId() : null, (id) => model.getNodeById(id) instanceof TabNode);
      const next = nextId ? model.getNodeById(nextId) : null;
      if (next instanceof TabNode) {
        event.preventDefault();
        model.doAction(Actions.selectTab(next.getId()));
        const parent = next.getParent();
        activateWorkspaceTabset(parent instanceof TabSetNode ? parent : null);
        commitWorkspaceCommand(next);
      }
      return;
    }

    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "w") {
      const selected = activeTabset?.getSelectedNode();
      if (selected instanceof TabNode) {
        event.preventDefault();
        closeWorkspaceTab(selected);
      }
      return;
    }

    if (!(tabNode instanceof TabNode)) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = tabElement?.getBoundingClientRect();
      setTabMenu({ node: tabNode, x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const parent = tabNode.getParent();
    if (!(parent instanceof TabSetNode)) return;
    const tabs = parent.getChildren().filter((candidate): candidate is TabNode => candidate instanceof TabNode);
    const next = tabs[nextWorkspaceTabIndex(tabs.length, tabs.indexOf(tabNode), event.key as WorkspaceTabNavigationKey)];
    if (!next) return;
    event.preventDefault();
    model.doAction(Actions.selectTab(next.getId()));
    activateWorkspaceTabset(parent);
    commitWorkspaceCommand(next);
  };
  const handleLayoutAction = (action: Action) => {
    if (action.type !== Actions.MOVE_NODE || action.data.location !== DockLocation.CENTER.getName()) return action;
    const fromNode = model.getNodeById(action.data.fromNode);
    const toNode = model.getNodeById(action.data.toNode);
    if (!(fromNode instanceof TabNode) || toNode?.getType() !== "tabset") return action;
    if ((fromNode.getConfig() as WorkspacePanelConfig | undefined)?.pinned) return undefined;
    const pinnedCount = toNode.getChildren().filter((candidate) =>
      candidate instanceof TabNode
      && (candidate.getConfig() as WorkspacePanelConfig | undefined)?.pinned === true
    ).length;
    if (action.data.index < 0 || action.data.index >= pinnedCount) return action;
    return Actions.moveNode(
      fromNode.getId(),
      toNode.getId(),
      DockLocation.CENTER,
      pinnedCount,
      action.data.select,
    );
  };
  const workspacePanelIcon = (config: WorkspacePanelConfig, size = 16) => {
    const ref = config.ref;
    let typeIcon = null;
    if (ref?.kind === "channel") {
      const channel = channels.find((candidate) => candidate.id === ref.id);
      typeIcon = channel ? <ChannelKindIcon type={channel.type} size={size} /> : <Hash size={size} />;
    } else if (ref?.kind === "dm") typeIcon = <AtSign size={size} />;
    else if (ref?.kind === "thread") typeIcon = <MessageSquareText size={size} />;
    else if (ref?.kind === "tasks") typeIcon = <CheckSquare size={size} />;
    else if (ref?.kind === "agent") typeIcon = <Bot size={size} />;
    else if (ref?.kind === "human") typeIcon = <User size={size} />;
    else if (ref?.kind === "machine") typeIcon = <Monitor size={size} />;
    else if (ref?.kind === "settings") typeIcon = <Settings size={size} />;
    else if (config.kind === "channel") typeIcon = <Hash size={size} />;
    return typeIcon;
  };
  const workspacePanelParent = (config: WorkspacePanelConfig): string | null => {
    const ref = config.ref;
    if (ref?.kind !== "thread") return null;
    const channel = channels.find((candidate) => candidate.id === ref.channelId);
    if (channel) return `#${channel.name}`;
    const dm = dmChannels.find((candidate) => candidate.id === ref.channelId);
    if (!dm) return null;
    return `@${dm.peerDisplayName || dm.peerName || dm.name}`;
  };
  const handleRenderTab = (node: TabNode, renderValues: ITabRenderValues) => {
    const config = node.getConfig() as WorkspacePanelConfig | undefined;
    const ref = config?.ref;
    if (!config) return;
    renderValues.content = (
      <span
        className={config.pinned ? "workspace-grid-pinned-tab-label sr-only" : undefined}
        title={node.getName()}
        {...(ref?.kind === "thread"
          ? {
              "data-workspace-thread-tab": true,
              "data-workspace-thread-channel-id": ref.channelId,
              "data-workspace-thread-root-id": ref.threadRootId,
              ...(ref.threadChannelId
                ? { "data-workspace-thread-channel-id-resolved": ref.threadChannelId }
                : {}),
            }
          : {})}
      >
        {node.getName()}
      </span>
    );
    renderValues.leading = (
      <span className="inline-flex shrink-0 items-center" aria-hidden="true">
        {workspacePanelIcon(config)}
      </span>
    );
  };
  const handleRenderTabSet = (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    if (!(node instanceof TabSetNode)) return;
    renderValues.leading = (
      <button
        type="button"
        className="workspace-grid-tab-search-trigger"
        aria-label={formatMessage({ id: "workspace.grid.demo.openTabOverview" })}
        title={formatMessage({ id: "workspace.grid.demo.openTabOverview" })}
        data-testid="workspace-tab-search-trigger"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOverflowQuery("");
          setOverflowMenu({
            anchor: event.currentTarget,
            selectedTabId: node.getSelectedNode()?.getId() ?? null,
          });
        }}
      >
        <ChevronDown size={18} aria-hidden="true" />
      </button>
    );
    const selectedNode = node.getSelectedNode();
    if (!(selectedNode instanceof TabNode)) return;
    const selectedKind = (selectedNode.getConfig() as WorkspacePanelConfig | undefined)?.kind;
    if (selectedKind !== "channel" && selectedKind !== "dm" && selectedKind !== "thread" && selectedKind !== "agent") return;
    renderValues.buttons.push(
      <div
        key="workspace-context-actions"
        id={workspaceGridTabsetActionHostId(node.getId())}
        className="workspace-grid-tabset-action-host"
      />,
    );
  };
  const hasOpenPanels = workspaceGridModelHasTabs(model);
  const overviewTabsets = workspaceTabsetsInVisualOrder(model);
  const overviewItems = overviewTabsets.flatMap((tabset) => tabset.getChildren().flatMap(
    (child): WorkspaceOverviewItem[] => child instanceof TabNode
      ? [{ node: child, paneId: tabset.getId(), paneLabel: workspacePaneLabel(overviewTabsets, tabset) }]
      : [],
  ));
  const overviewQuery = overflowQuery.trim().toLocaleLowerCase();
  const overviewItemMatches = (name: string, config: WorkspacePanelConfig | undefined) => {
    if (!overviewQuery) return true;
    return [name, config?.title, config ? workspacePanelParent(config) : null]
      .some((value) => value?.toLocaleLowerCase().includes(overviewQuery));
  };
  const filteredOverviewItems = overviewItems.filter(({ node }) =>
    overviewItemMatches(node.getName(), node.getConfig() as WorkspacePanelConfig | undefined),
  );
  const filteredRecentlyClosedTabs = recentlyClosedTabs.filter(({ tab }) =>
    overviewItemMatches(tab.name ?? "", tab.config as WorkspacePanelConfig | undefined),
  );

  const reopenRecentlyClosedTab = useCallback((entry: WorkspaceRecentlyClosedTab) => {
    const config = entry.tab.config as WorkspacePanelConfig | undefined;
    const existingTabId = config?.ref ? findWorkspaceGridTabIdForRef(model, config.ref) : null;
    if (existingTabId && selectWorkspaceGridTab(model, existingTabId)) {
      setRecentlyClosedTabs((current) => current.filter((candidate) => candidate.key !== entry.key));
      setOverflowMenu(null);
      const existing = model.getNodeById(existingTabId);
      commitWorkspaceCommand(existing instanceof TabNode ? existing : undefined);
      return;
    }
    const target = entry.paneId && model.getNodeById(entry.paneId) instanceof TabSetNode
      ? entry.paneId
      : getWorkspaceGridTargetTabsetId(model);
    if (!target) return;
    const id = entry.tab.id && model.getNodeById(entry.tab.id)
      ? `${entry.tab.id}-reopen-${entry.key}`
      : entry.tab.id;
    model.doAction(Actions.addTab({ ...entry.tab, id }, target, DockLocation.CENTER, -1, true));
    setRecentlyClosedTabs((current) => current.filter((candidate) => candidate.key !== entry.key));
    setOverflowMenu(null);
    const reopened = id ? model.getNodeById(id) : null;
    commitWorkspaceCommand(reopened instanceof TabNode ? reopened : undefined);
  }, [commitWorkspaceCommand, model]);

  useEffect(() => {
    const reopenLatest = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLocaleLowerCase() !== "t") return;
      const latest = recentlyClosedTabs[0];
      if (!latest) return;
      event.preventDefault();
      reopenRecentlyClosedTab(latest);
    };
    // keydown-global-exempt: exact modifier chord reopens the latest workspace tab
    window.addEventListener("keydown", reopenLatest);
    return () => window.removeEventListener("keydown", reopenLatest);
  }, [recentlyClosedTabs, reopenRecentlyClosedTab]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="min-h-0 flex-1 bg-[#1f2328]">
        <div
          ref={layoutRootRef}
          className="workspace-grid-demo-shell relative h-full min-h-0"
          data-workspace-keyboard-focus="false"
          onDragOverCapture={handleWorkspaceDragOverCapture}
          onPointerDownCapture={handleWorkspacePointerDownCapture}
          onFocusCapture={handleWorkspaceFocusCapture}
          onKeyDownCapture={handleWorkspaceKeyDownCapture}
          onDoubleClick={(event) => requestWorkspaceGridThreadScrollToTopFromTarget(event.target)}
        >
          <Layout
            model={model}
            factory={factory}
            realtimeResize
            onModelChange={handleModelChange}
            onContextMenu={handleContextMenu}
            onAction={handleLayoutAction}
            onRenderTab={handleRenderTab}
            onRenderTabSet={handleRenderTabSet}
            onExternalDrag={handleExternalDrag}
          />
          {!hasOpenPanels && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 top-12 z-10 flex items-center justify-center bg-white p-8 text-center"
              data-testid="workspace-grid-empty-state"
            >
              <div className="max-w-[360px]">
                <Columns3 className="mx-auto" size={30} strokeWidth={2.5} />
                <h2 className="mt-4 text-lg font-extrabold">{formatMessage({ id: "workspace.grid.demo.noPanelsOpen" })}</h2>
                <p className="mt-1 text-sm leading-6 text-black/60">
                  {formatMessage({ id: "workspace.grid.demo.emptyHint" })}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      {tabMenu ? createPortal(
        <div
          ref={tabMenuRef}
          className="fixed z-[100] min-w-36 border-2 border-black bg-white p-1 shadow-brutal-sm"
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          aria-label={formatMessage({ id: "workspace.grid.demo.actionsFor" }, { name: tabMenu.node.getName() })}
          onKeyDown={(event) => {
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") {
              event.preventDefault();
              closeTabMenu(true);
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (current + 1 + buttons.length) % buttons.length : (current - 1 + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          <button
            type="button"
            className="flex w-full items-center justify-between gap-8 px-3 py-2 text-left text-sm font-bold hover:bg-soft-signal focus-visible:outline focus-visible:outline-1 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-40"
            onClick={closeContextTab}
            disabled={!tabMenu.node.isEnableClose()}
            role="menuitem"
          >
            <span>{formatMessage({ id: "common.close" })}</span>
            <kbd className="font-mono text-xs font-medium text-black/45">⌘W</kbd>
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-bold hover:bg-soft-signal focus-visible:outline focus-visible:outline-1 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-40"
            onClick={closeOtherContextTabs}
            disabled={!tabMenu.node.getParent()?.getChildren().some((candidate) => candidate instanceof TabNode && candidate.getId() !== tabMenu.node.getId() && !(candidate.getConfig() as WorkspacePanelConfig | undefined)?.pinned && candidate.isEnableClose())}
            role="menuitem"
          >
            {formatMessage({ id: "workspace.grid.demo.closeOthers" })}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-bold hover:bg-soft-signal focus-visible:outline focus-visible:outline-1 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-40"
            onClick={closeAllContextTabs}
            disabled={!tabMenu.node.getParent()?.getChildren().some((candidate) => candidate instanceof TabNode && !(candidate.getConfig() as WorkspacePanelConfig | undefined)?.pinned && candidate.isEnableClose())}
            role="menuitem"
          >
            {formatMessage({ id: "workspace.grid.demo.closeAll" })}
          </button>
          <div className="my-1 h-px bg-black/20" role="separator" />
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-bold hover:bg-soft-signal focus-visible:outline focus-visible:outline-1 focus-visible:outline-black"
            onClick={togglePinnedTab}
            role="menuitem"
          >
            {(tabMenu.node.getConfig() as WorkspacePanelConfig | undefined)?.pinned
              ? formatMessage({ id: "workspace.grid.demo.unpin" })
              : formatMessage({ id: "workspace.grid.demo.pin" })}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-bold hover:bg-soft-signal focus-visible:outline focus-visible:outline-1 focus-visible:outline-black disabled:cursor-not-allowed disabled:opacity-40"
            onClick={moveContextTabToOtherPane}
            disabled={!workspaceOtherTabset(model, tabMenu.node)}
            role="menuitem"
          >
            {formatMessage({ id: "workspace.grid.demo.moveToOtherPane" })}
          </button>
        </div>,
        document.body,
      ) : null}
      {overflowMenu ? (
        <DropdownMenu
          open
          onOpenChange={(open) => {
            if (!open) setOverflowMenu(null);
          }}
        >
          <DropdownMenuTrigger nativeButton={false} render={<span className="sr-only" aria-hidden="true" />} />
          <DropdownMenuContent
            anchor={overflowMenu.anchor}
            side="bottom"
            align="end"
            sideOffset={4}
            className="w-[400px] max-w-[calc(100vw-16px)] p-0"
            aria-label={formatMessage({ id: "workspace.grid.demo.tabOverview" })}
            data-testid="workspace-tab-overflow-menu"
          >
            <div className="flex items-center gap-2 border-b border-black/15 px-3 py-2">
              <Search size={18} className="shrink-0 text-black/65" aria-hidden="true" />
              <input
                autoFocus
                value={overflowQuery}
                onChange={(event) => setOverflowQuery(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-black/45"
                placeholder={formatMessage({ id: "workspace.grid.demo.searchPlaceholder" })}
                aria-label={formatMessage({ id: "workspace.grid.demo.searchTabs" })}
                data-testid="workspace-tab-search-input"
              />
            </div>
            <div className="max-h-[min(560px,calc(100vh-96px))] overflow-y-auto py-1">
              <div className="px-3 pb-1 pt-2 font-mono text-[11px] font-bold uppercase text-black/50">{formatMessage({ id: "workspace.grid.demo.openSection" })}</div>
              {filteredOverviewItems.map((item) => {
                const config = item.node.getConfig() as WorkspacePanelConfig | undefined;
                if (!config) return null;
                const parent = workspacePanelParent(config);
                return (
                  <DropdownMenuItem
                    key={item.node.getId()}
                    className="group min-w-0 gap-3 px-3 py-2"
                    data-selected={item.node.getId() === overflowMenu.selectedTabId ? "true" : "false"}
                    onClick={() => {
                      model.doAction(Actions.selectTab(item.node.getId()));
                      const tabset = model.getNodeById(item.paneId);
                      if (tabset instanceof TabSetNode) activateWorkspaceTabset(tabset);
                      setOverflowMenu(null);
                    }}
                  >
                    <span className={`flex size-9 shrink-0 items-center justify-center border-2 border-black ${WORKSPACE_OVERVIEW_ICON_TONE[config.accent]}`} aria-hidden="true">
                      {workspacePanelIcon(config, 17)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold" title={config.title || item.node.getName()}>{config.title || item.node.getName()}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-black/55">
                        {parent ? <span className="min-w-0 truncate">{parent}</span> : null}
                        <span className="inline-flex size-5 shrink-0 items-center justify-center border border-black bg-white font-mono text-[10px] font-bold text-black">{item.paneLabel}</span>
                      </span>
                    </span>
                    {!config.pinned ? (
                      <button
                        type="button"
                        className="flex size-7 shrink-0 items-center justify-center text-black/35 hover:bg-black/5 hover:text-black focus-visible:outline focus-visible:outline-1 focus-visible:outline-black"
                        aria-label={formatMessage({ id: "workspace.grid.demo.closeNamed" }, { name: item.node.getName() })}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          closeWorkspaceTab(item.node);
                        }}
                      >
                        <X size={17} aria-hidden="true" />
                      </button>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
              <div className="px-3 pb-1 pt-3 font-mono text-[11px] font-bold uppercase text-black/50">{formatMessage({ id: "workspace.grid.demo.recentlyClosed" })}</div>
              {recentlyClosedTabs.length === 0 && !overviewQuery ? (
                <div className="px-3 py-2 text-sm text-black/45">{formatMessage({ id: "workspace.grid.demo.noRecentlyClosed" })}</div>
              ) : null}
              {filteredRecentlyClosedTabs.map((entry) => {
                const config = entry.tab.config as WorkspacePanelConfig | undefined;
                if (!config) return null;
                const parent = workspacePanelParent(config);
                return (
                  <DropdownMenuItem
                    key={entry.key}
                    className="group min-w-0 gap-3 px-3 py-2"
                    onClick={() => reopenRecentlyClosedTab(entry)}
                  >
                    <span className={`flex size-9 shrink-0 items-center justify-center border-2 border-black ${WORKSPACE_OVERVIEW_ICON_TONE[config.accent]}`} aria-hidden="true">
                      {workspacePanelIcon(config, 17)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold" title={config.title || entry.tab.name}>{config.title || entry.tab.name}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-black/55">
                        {parent ? <span className="min-w-0 truncate">{parent}</span> : null}
                        <span className="inline-flex size-5 shrink-0 items-center justify-center border border-black bg-white font-mono text-[10px] font-bold text-black">{entry.paneLabel}</span>
                      </span>
                    </span>
                    <button
                      type="button"
                      className="flex size-7 shrink-0 items-center justify-center text-black/35 hover:bg-black/5 hover:text-black focus-visible:outline focus-visible:outline-1 focus-visible:outline-black"
                      aria-label={formatMessage({ id: "workspace.grid.demo.forgetNamed" }, { name: entry.tab.name })}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setRecentlyClosedTabs((current) => current.filter((candidate) => candidate.key !== entry.key));
                      }}
                    >
                      <X size={17} aria-hidden="true" />
                    </button>
                  </DropdownMenuItem>
                );
              })}
            </div>
            {filteredOverviewItems.length === 0 && filteredRecentlyClosedTabs.length === 0 ? (
              <div className="px-3 py-4 text-sm text-black/55">{formatMessage({ id: "workspace.grid.demo.noMatchingTabs" })}</div>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <div className="sr-only" aria-live="polite">{tabFeedback}</div>
    </div>
  );
}
