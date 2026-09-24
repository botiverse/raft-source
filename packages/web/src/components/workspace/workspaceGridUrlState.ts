import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type {
  IJsonModel,
  IJsonRowNode,
  IJsonTabNode,
  IJsonTabSetNode,
} from "flexlayout-react";

import type { MessageId } from "../../i18n/messages/en";
import { en } from "../../i18n/messages/en";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import type { WorkspacePanelConfig, WorkspacePanelKind } from "./workspaceGridDemoConfig";
import type { WorkspaceGridFormatMessage } from "./workspaceGridDemoConfig";

export const WORKSPACE_GRID_URL_PARAM = "wg";
export const WORKSPACE_GRID_URL_STATE_VERSION = 1;

export type { WorkspaceGridFormatMessage };

export interface WorkspaceGridUrlState {
  version: typeof WORKSPACE_GRID_URL_STATE_VERSION;
  model: IJsonModel;
}

export interface WorkspaceGridUrlStateController {
  rawLayoutIntent: string | null;
  layoutIntent: IJsonModel | null;
  writeLayoutIntent: (model: IJsonModel) => string;
}

const CANONICAL_PANEL_DISPLAY_IDS: Record<
  WorkspacePanelKind,
  { title: MessageId; subtitle: MessageId; summary: MessageId }
> = {
  channel: {
    title: "workspace.panel.channelTitle",
    subtitle: "workspace.panel.channel",
    summary: "workspace.panel.resolvedSummary",
  },
  dm: {
    title: "workspace.panel.directMessageTitle",
    subtitle: "workspace.panel.directMessage",
    summary: "workspace.panel.resolvedSummary",
  },
  agent: {
    title: "workspace.panel.agentTitle",
    subtitle: "workspace.panel.agent",
    summary: "workspace.panel.resolvedSummary",
  },
  human: {
    title: "workspace.panel.personTitle",
    subtitle: "workspace.panel.person",
    summary: "workspace.panel.resolvedSummary",
  },
  machine: {
    title: "workspace.panel.computerTitle",
    subtitle: "workspace.panel.computer",
    summary: "workspace.panel.resolvedSummary",
  },
  settings: {
    title: "workspace.panel.settingsTitle",
    subtitle: "workspace.panel.settings",
    summary: "workspace.panel.resolvedSummary",
  },
  thread: {
    title: "workspace.panel.threadTitle",
    subtitle: "workspace.panel.thread",
    summary: "workspace.panel.resolvedSummary",
  },
  tasks: {
    title: "workspace.panel.tasks",
    subtitle: "workspace.panel.taskQueue",
    summary: "workspace.panel.resolvedSummary",
  },
};

const defaultFormatMessage: WorkspaceGridFormatMessage = (descriptor) =>
  en[descriptor.id] ?? descriptor.id;

export function resolveCanonicalPanelDisplay(
  kind: WorkspacePanelKind,
  formatMessage: WorkspaceGridFormatMessage = defaultFormatMessage,
): Pick<WorkspacePanelConfig, "title" | "subtitle" | "summary"> {
  const ids = CANONICAL_PANEL_DISPLAY_IDS[kind];
  return {
    title: String(formatMessage({ id: ids.title })),
    subtitle: String(formatMessage({ id: ids.subtitle })),
    summary: String(formatMessage({ id: ids.summary })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonModel(value: unknown): value is IJsonModel {
  if (!isRecord(value)) return false;
  const layout = value.layout;
  return isRecord(layout) && layout.type === "row";
}

function isWorkspaceGridUrlState(value: unknown): value is WorkspaceGridUrlState {
  if (!isRecord(value)) return false;
  return value.version === WORKSPACE_GRID_URL_STATE_VERSION && isJsonModel(value.model);
}

function serializeWorkspaceGridTab(
  tab: IJsonTabNode,
  formatMessage: WorkspaceGridFormatMessage,
): IJsonTabNode {
  const config = tab.config as WorkspacePanelConfig | undefined;
  if (!config?.ref || !Object.hasOwn(CANONICAL_PANEL_DISPLAY_IDS, config.kind)) return tab;

  const display = resolveCanonicalPanelDisplay(config.kind, formatMessage);
  return {
    ...tab,
    name: display.title,
    config: {
      kind: config.kind,
      ref: config.ref,
      demoSource: config.demoSource,
      accent: config.accent,
      pinned: config.pinned,
      ...display,
    } satisfies WorkspacePanelConfig,
  };
}

function serializeWorkspaceGridLayoutNode(
  node: IJsonRowNode | IJsonTabSetNode,
  formatMessage: WorkspaceGridFormatMessage,
): IJsonRowNode | IJsonTabSetNode {
  if (node.type === "tabset") {
    return {
      ...node,
      children: node.children?.map((child) => serializeWorkspaceGridTab(child, formatMessage)),
    };
  }

  return {
    ...node,
    children: node.children?.map((child) => serializeWorkspaceGridLayoutNode(child, formatMessage)),
  };
}

export function serializeWorkspaceGridLayoutIntent(
  model: IJsonModel,
  formatMessage: WorkspaceGridFormatMessage = defaultFormatMessage,
): IJsonModel {
  const subLayouts = model.subLayouts
    ? Object.fromEntries(Object.entries(model.subLayouts).map(([id, subLayout]) => [
        id,
        {
          ...subLayout,
          layout: serializeWorkspaceGridLayoutNode(subLayout.layout, formatMessage) as IJsonRowNode,
        },
      ]))
    : undefined;
  const popouts = model.popouts
    ? Object.fromEntries(Object.entries(model.popouts).map(([id, popout]) => [
        id,
        {
          ...popout,
          layout: serializeWorkspaceGridLayoutNode(popout.layout, formatMessage) as IJsonRowNode,
        },
      ]))
    : undefined;
  return {
    ...model,
    borders: model.borders?.map((border) => ({
      ...border,
      children: border.children?.map((child) => serializeWorkspaceGridTab(child, formatMessage)),
    })),
    layout: serializeWorkspaceGridLayoutNode(model.layout, formatMessage) as IJsonRowNode,
    subLayouts,
    popouts,
  };
}

export function encodeWorkspaceGridUrlState(
  model: IJsonModel,
  formatMessage: WorkspaceGridFormatMessage = defaultFormatMessage,
): string {
  return `v${WORKSPACE_GRID_URL_STATE_VERSION}.${encodeURIComponent(JSON.stringify({
    version: WORKSPACE_GRID_URL_STATE_VERSION,
    model: serializeWorkspaceGridLayoutIntent(model, formatMessage),
  } satisfies WorkspaceGridUrlState))}`;
}

export function decodeWorkspaceGridUrlState(raw: string | null | undefined): IJsonModel | null {
  if (!raw?.startsWith(`v${WORKSPACE_GRID_URL_STATE_VERSION}.`)) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw.slice(3)));
    if (!isWorkspaceGridUrlState(parsed)) return null;
    return parsed.model;
  } catch {
    return null;
  }
}

export function getWorkspaceGridUrlSearch(
  currentSearch: string,
  model: IJsonModel,
  formatMessage: WorkspaceGridFormatMessage = defaultFormatMessage,
): string {
  const params = new URLSearchParams(currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch);
  params.set(WORKSPACE_GRID_URL_PARAM, encodeWorkspaceGridUrlState(model, formatMessage));
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function useWorkspaceGridUrlState(): WorkspaceGridUrlStateController {
  const { formatMessage } = useIntl();
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const rawLayoutIntent = searchParams.get(WORKSPACE_GRID_URL_PARAM);
  const layoutIntent = useMemo(
    () => decodeWorkspaceGridUrlState(rawLayoutIntent),
    [rawLayoutIntent],
  );
  const writeLayoutIntent = useCallback((model: IJsonModel) => {
    const encoded = encodeWorkspaceGridUrlState(model, (descriptor, values) =>
      String(formatMessage(descriptor, values)),
    );
    setSearchParams((previous) => {
      if (previous.get(WORKSPACE_GRID_URL_PARAM) === encoded) return previous;
      const next = new URLSearchParams(previous);
      next.set(WORKSPACE_GRID_URL_PARAM, encoded);
      return next;
    }, { replace: true });
    return encoded;
  }, [formatMessage, setSearchParams]);

  return { rawLayoutIntent, layoutIntent, writeLayoutIntent };
}
