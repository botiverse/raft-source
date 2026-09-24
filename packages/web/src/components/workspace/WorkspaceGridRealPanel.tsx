import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Activity, Bot, CheckSquare, MessageSquare, Monitor, Pin, Settings, User } from "lucide-react";
import { Actions } from "flexlayout-react";
import type { TabNode } from "flexlayout-react";
import { useIntl } from "react-intl";

import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import type { OpenThreadRequest } from "../../store/threadStore";
import type { Task } from "../../store/taskStore";
import { resolveHumanProfile } from "../member/resolveHumanProfile";
import { workspaceGridTabsetActionHostId } from "./workspaceGridDemoConfig";
import type { WorkspacePanelConfig, WorkspacePanelKind, WorkspacePanelRef } from "./workspaceGridDemoConfig";
import { isWorkspaceGridTabWritable } from "./workspaceGridModel";
import { subscribeWorkspaceGridThreadScrollToTop } from "./workspaceGridOpenEvents";

const AgentDetailPanel = lazy(() => import("../agent/AgentDetailPanel"));
const LazyChatPanel = lazy(() => import("../message/ChatPanel"));
const ThreadPanel = lazy(() => import("../message/ThreadPanel"));
const TasksPanel = lazy(() => import("../task/TasksPanel"));
const MachineDetailPanel = lazy(() => import("../machine/MachineDetailPanel"));
const HumanDetailPanel = lazy(() => import("../member/HumanDetailPanel"));
const SettingsPanel = lazy(() => import("../settings/SettingsPanel"));
const ChatPanel = memo(
  LazyChatPanel,
  (previous, next) =>
    previous.channel?.id === next.channel?.id &&
    previous.readOnly === next.readOnly &&
    previous.showComposer === next.showComposer &&
    previous.workspaceComposer === next.workspaceComposer &&
    previous.composerAutoFocus === next.composerAutoFocus &&
    previous.headerActionsHost === next.headerActionsHost &&
    previous.hideHeader === next.hideHeader &&
    previous.onOpenThread === next.onOpenThread &&
    previous.onOpenProfile === next.onOpenProfile &&
    previous.onSearchChannel === next.onSearchChannel,
);

const PANEL_TONE: Record<WorkspacePanelConfig["accent"], string> = {
  yellow: "bg-soft-signal",
  cyan: "bg-brutal-cyan",
  lavender: "bg-brutal-lavender",
  pink: "bg-brutal-pink",
  lime: "bg-brutal-lime",
};

const PANEL_ICON: Record<WorkspacePanelKind, typeof MessageSquare> = {
  channel: MessageSquare,
  dm: MessageSquare,
  thread: Activity,
  tasks: CheckSquare,
  agent: Bot,
  human: User,
  machine: Monitor,
  settings: Settings,
};

function PanelFallback() {
  const { formatMessage } = useIntl();
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-white text-black/40 font-display text-lg font-bold">
      {formatMessage({ id: "layout.main.loading" })}
    </div>
  );
}

function firstConversationChannel(channels: Channel[]) {
  return channels.find((channel) => channel.joined && channel.archivedAt == null) ?? channels.find((channel) => channel.archivedAt == null) ?? null;
}

function useWorkspaceProfileOpener(onOpenPanelRef?: WorkspaceGridPanelFactoryOptions["onOpenPanelRef"]) {
  const { formatMessage } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  return useCallback((kind: "agent" | "human", id: string) => {
    if (!onOpenPanelRef) return;
    const profile = kind === "agent"
      ? agents.find((candidate) => candidate.id === id)
      : members.find((candidate) => candidate.userId === id);
    const displayName = profile?.displayName || profile?.name || id;
    onOpenPanelRef(
      { kind, id },
      { title: `@${displayName}`, subtitle: kind === "agent" ? formatMessage({ id: "workspace.panel.agentProfile" }) : formatMessage({ id: "workspace.panel.humanProfile" }) },
    );
  }, [agents, formatMessage, members, onOpenPanelRef]);
}

export function MockPanel({ config }: { config: WorkspacePanelConfig }) {
  const { formatMessage } = useIntl();
  const Icon = PANEL_ICON[config.kind];
  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-black" data-testid={`workspace-grid-panel-${config.kind}`}>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b-2 border-black px-4">
        <div className={`flex size-8 shrink-0 items-center justify-center border-2 border-black ${PANEL_TONE[config.accent]}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{config.title}</div>
          <div className="truncate font-mono text-[11px] text-black/50">{config.subtitle}</div>
        </div>
        {config.pinned ? (
          <div className="flex shrink-0 items-center gap-1 border-2 border-black bg-brutal-cream px-2 py-1 text-[11px] font-bold uppercase">
            <Pin size={12} />
            {formatMessage({ id: "workspace.grid.mock.pinnedBadge" })}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="max-w-[56ch] text-sm leading-6 text-black/75">{config.summary}</p>
        <div className="mt-4 grid gap-2 text-xs md:grid-cols-2">
          <div className="border-2 border-black bg-brutal-cream p-3">
            <div className="font-bold uppercase">{formatMessage({ id: "workspace.grid.mock.panelKindLabel" })}</div>
            <div className="mt-1 font-mono text-black/60">{config.kind}</div>
          </div>
          <div className="border-2 border-black bg-brutal-cream p-3">
            <div className="font-bold uppercase">{formatMessage({ id: "workspace.grid.mock.replacementRuleLabel" })}</div>
            <div className="mt-1 font-mono text-black/60">
              {config.pinned
                ? formatMessage(
                    { id: "workspace.grid.mock.lockedBy" },
                    { lockedBy: config.lockedBy ?? "pin" },
                  )
                : formatMessage({ id: "workspace.grid.mock.replacementRuleReplaceable" })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UnresolvedPanel({ config, reason }: { config: WorkspacePanelConfig; reason: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-black" data-testid={`workspace-grid-panel-${config.kind}`}>
      <div className="border-b-2 border-black bg-brutal-cream px-4 py-3 text-sm font-bold">
        {config.title}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <div className="max-w-[420px] border-2 border-black bg-white p-4 shadow-brutal-sm">
          <div className="text-sm font-bold uppercase">{formatMessage({ id: "workspace.panel.realUnavailable" })}</div>
          <p className="mt-2 text-sm leading-6 text-black/70">{reason}</p>
          <p className="mt-3 text-xs leading-5 text-black/50">{config.summary}</p>
        </div>
      </div>
    </div>
  );
}

function ChannelPanel({ active, config, onOpenPanelRef, onSearchChannel, headerActionsHost }: {
  active: boolean;
  config: WorkspacePanelConfig;
  onOpenPanelRef?: WorkspaceGridPanelFactoryOptions["onOpenPanelRef"];
  onSearchChannel?: WorkspaceGridPanelFactoryOptions["onSearchChannel"];
  headerActionsHost: Element | null;
}) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const handleOpenProfile = useWorkspaceProfileOpener(onOpenPanelRef);
  const channelRef = config.ref?.kind === "channel" ? config.ref : null;
  const dmRef = config.ref?.kind === "dm" ? config.ref : null;
  const channel = dmRef
    ? dmChannels.find((candidate) => candidate.id === dmRef.id) ?? null
    : channelRef
      ? channels.find((candidate) => candidate.id === channelRef.id) ?? null
      : config.demoSource?.kind === "first-channel"
        ? firstConversationChannel(channels)
        : null;
  const parentSubtitle = channel
    ? channel.type === "dm"
      ? `@${channel.peerDisplayName || channel.peerName || channel.name}`
      : `#${channel.name}`
    : "";

  const handleOpenThread = useCallback(
    (request: OpenThreadRequest) => {
      if (!onOpenPanelRef) return;
      onOpenPanelRef(
        {
          kind: "thread",
          channelId: request.parentChannelId,
          threadRootId: request.parentMessageId,
          threadChannelId: request.initialThreadChannelId ?? null,
        },
        {
          title: formatMessage({ id: "search.panelThreadTitle" }, { id: request.parentMessageId.slice(0, 8) }),
          subtitle: parentSubtitle,
        },
      );
    },
    [formatMessage, onOpenPanelRef, parentSubtitle],
  );

  if (!channel) {
    return <UnresolvedPanel config={config} reason={formatMessage({ id: "workspace.unresolved.noChannel" })} />;
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="workspace-grid-chat-host"
    >
      <Suspense fallback={<PanelFallback />}>
        <ChatPanel
          channel={channel}
          showComposer
          workspaceComposer
          composerAutoFocus={active}
          hideHeader
          headerActionsHost={headerActionsHost}
          onOpenThread={onOpenPanelRef ? handleOpenThread : undefined}
          onOpenProfile={onOpenPanelRef ? handleOpenProfile : undefined}
          onSearchChannel={onSearchChannel}
        />
      </Suspense>
    </div>
  );
}

function AgentPanel({ config, headerActionsHost }: { config: WorkspacePanelConfig; headerActionsHost: Element | null }) {
  const { formatMessage } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const agentRef = config.ref?.kind === "agent" ? config.ref : null;
  const agent = agentRef
    ? agents.find((candidate) => candidate.id === agentRef.id && candidate.deletedAt == null) ?? null
    : config.demoSource?.kind === "first-agent"
      ? agents.find((candidate) => candidate.deletedAt == null) ?? null
      : null;
  if (!agent) {
    return <UnresolvedPanel config={config} reason={formatMessage({ id: "workspace.unresolved.noAgent" })} />;
  }
  return (
    <Suspense fallback={<PanelFallback />}>
      <AgentDetailPanel agent={agent} workspaceEmbedded headerActionsHost={headerActionsHost} />
    </Suspense>
  );
}

function MachinePanel({ config }: { config: WorkspacePanelConfig }) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const machineRef = config.ref?.kind === "machine" ? config.ref : null;
  const machine = machineRef ? machines.find((candidate) => candidate.id === machineRef.id) : null;
  if (!machine) {
    return <UnresolvedPanel config={config} reason={formatMessage({ id: "workspace.unresolved.computerGone" })} />;
  }
  return (
    <Suspense fallback={<PanelFallback />}>
      <MachineDetailPanel machine={machine} workspaceEmbedded />
    </Suspense>
  );
}

function HumanPanel({ config }: { config: WorkspacePanelConfig }) {
  const { formatMessage } = useIntl();
  const members = useServerStore((s) => s.members);
  const humanRef = config.ref?.kind === "human" ? config.ref : null;
  const human = humanRef
    ? resolveHumanProfile(members.find((candidate) => candidate.userId === humanRef.id), null)
    : null;
  if (!human) {
    return <UnresolvedPanel config={config} reason={formatMessage({ id: "workspace.unresolved.humanGone" })} />;
  }
  return (
    <Suspense fallback={<PanelFallback />}>
      <HumanDetailPanel human={human} />
    </Suspense>
  );
}

function WorkspaceSettingsPanel({ config }: { config: WorkspacePanelConfig }) {
  const settingsRef = config.ref?.kind === "settings" ? config.ref : null;
  return (
    <Suspense fallback={<PanelFallback />}>
      <SettingsPanel tab={settingsRef?.tab ?? "account"} />
    </Suspense>
  );
}

function ResolvedWorkspaceThreadPanel({ active, config, node, onOpenPanelRef, threadRef, headerActionsHost }: {
  active: boolean;
  config: WorkspacePanelConfig;
  node: TabNode;
  onOpenPanelRef?: WorkspaceGridPanelFactoryOptions["onOpenPanelRef"];
  threadRef: Extract<WorkspacePanelRef, { kind: "thread" }>;
  headerActionsHost: Element | null;
}) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const openThread = useThreadStore((s) => s.openThread);
  const openParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const openParentChannelId = useThreadStore((s) => s.openParentChannelId);
  const openThreadChannelId = useThreadStore((s) => s.openThreadChannelId);
  const handleOpenProfile = useWorkspaceProfileOpener(onOpenPanelRef);
  const [scrollToTopRequest, setScrollToTopRequest] = useState(0);

  useEffect(() => subscribeWorkspaceGridThreadScrollToTop(
    threadRef,
    () => setScrollToTopRequest((request) => request + 1),
  ), [threadRef]);

  useEffect(() => {
    if (!active) return;
    void openThread({
      parentChannelId: threadRef.channelId,
      parentMessageId: threadRef.threadRootId,
      initialThreadChannelId: threadRef.threadChannelId ?? null,
    });
  }, [active, openThread, threadRef]);

  useEffect(() => {
    if (
      threadRef.threadChannelId
      || !openThreadChannelId
      || openParentMessageId !== threadRef.threadRootId
      || openParentChannelId !== threadRef.channelId
    ) return;
    node.getModel().doAction(Actions.updateNodeAttributes(node.getId(), {
      config: {
        ...config,
        ref: { ...threadRef, threadChannelId: openThreadChannelId },
      },
    }));
  }, [config, node, openParentChannelId, openParentMessageId, openThreadChannelId, threadRef]);

  const resolvedThreadChannelId = threadRef.threadChannelId
    ?? (openParentMessageId === threadRef.threadRootId && openParentChannelId === threadRef.channelId
      ? openThreadChannelId
      : null);

  const handleClose = useCallback(() => {
    const state = useThreadStore.getState();
    if (
      state.openParentChannelId === threadRef.channelId
      && state.openParentMessageId === threadRef.threadRootId
    ) {
      state.closeThread();
    }
    node.getModel().doAction(Actions.deleteTab(node.getId()));
  }, [node, threadRef.channelId, threadRef.threadRootId]);
  const threadIdentity = useMemo(() => ({
    parentChannelId: threadRef.channelId,
    parentMessageId: threadRef.threadRootId,
    threadChannelId: resolvedThreadChannelId,
  }), [resolvedThreadChannelId, threadRef.channelId, threadRef.threadRootId]);
  const handleOpenParentChannel = useCallback((channelId: string) => {
    if (!onOpenPanelRef) return;
    const dm = dmChannels.find((candidate) => candidate.id === channelId);
    const channel = channels.find((candidate) => candidate.id === channelId);
    onOpenPanelRef(
      { kind: dm ? "dm" : "channel", id: channelId },
      {
        title: dm
          ? `@${dm.peerDisplayName || dm.peerName || dm.name}`
          : `#${channel?.name || channelId}`,
        subtitle: dm
          ? formatMessage({ id: "workspace.panel.directMessage" })
          : formatMessage({ id: "workspace.panel.channel" }),
      },
    );
  }, [channels, dmChannels, formatMessage, onOpenPanelRef]);

  return (
    <div
      className="relative h-full min-h-0"
    >
      <Suspense fallback={<PanelFallback />}>
        <ThreadPanel
          presentation="side"
          onClose={handleClose}
          threadIdentity={threadIdentity}
          onOpenParentChannel={onOpenPanelRef ? handleOpenParentChannel : undefined}
          onOpenProfile={onOpenPanelRef ? handleOpenProfile : undefined}
          showComposer
          workspaceComposer
          composerAutoFocus={active}
          hideHeader
          headerActionsHost={headerActionsHost}
          scrollToTopRequest={scrollToTopRequest}
        />
      </Suspense>
    </div>
  );
}

function WorkspaceThreadPanel(props: {
  active: boolean;
  config: WorkspacePanelConfig;
  node: TabNode;
  onOpenPanelRef?: WorkspaceGridPanelFactoryOptions["onOpenPanelRef"];
  headerActionsHost: Element | null;
}) {
  const { formatMessage } = useIntl();
  const threadRef = props.config.ref?.kind === "thread" ? props.config.ref : null;
  if (!threadRef) {
    return (
      <UnresolvedPanel
        config={props.config}
        reason={formatMessage({ id: "workspace.unresolved.threadIdentityMissing" })}
      />
    );
  }
  return <ResolvedWorkspaceThreadPanel {...props} threadRef={threadRef} />;
}

export interface WorkspaceGridPanelFactoryOptions {
  onOpenPanelRef?: (ref: WorkspacePanelRef, source?: { title?: string; subtitle?: string }) => void;
  onSearchChannel?: (channelId: string) => void;
}

function workspacePanelConfigSignature(config: WorkspacePanelConfig): string {
  return JSON.stringify(config);
}

export function createWorkspaceGridPanelFactory(options: WorkspaceGridPanelFactoryOptions = {}) {
  const cache = new Map<string, { signature: string; element: ReactNode }>();

  return function workspacePanelFactory(node: TabNode) {
    const config = node.getConfig() as WorkspacePanelConfig | undefined;
    if (!config) return null;

    const id = node.getId();
    const signature = `${workspacePanelConfigSignature(config)}:${options.onOpenPanelRef ? "open-ref" : "no-open-ref"}:${options.onSearchChannel ? "search" : "no-search"}`;
    const cached = cache.get(id);
    if (cached?.signature === signature) return cached.element;

    const element = (
      <WorkspaceGridRealPanel
        key={id}
        node={node}
        config={config}
        onOpenPanelRef={options.onOpenPanelRef}
        onSearchChannel={options.onSearchChannel}
      />
    );
    cache.set(id, { signature, element });
    return element;
  };
}

function useWorkspaceGridWritableState(node: TabNode) {
  const [writable, setWritable] = useState(() => isWorkspaceGridTabWritable(node));

  useEffect(() => {
    const model = node.getModel();
    const updateWritable = () => {
      const next = isWorkspaceGridTabWritable(node);
      setWritable((current) => current === next ? current : next);
    };
    model.addChangeListener(updateWritable);
    updateWritable();
    return () => model.removeChangeListener(updateWritable);
  }, [node]);

  return writable;
}

// FlexLayout owns the tabbar DOM outside React's panel subtree. Moving a selected tab
// preserves the TabNode and active state, so track its parent tabset explicitly and
// resolve the new portal host only after the corresponding layout commit.
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state
function useWorkspaceGridHeaderActionsHost(node: TabNode, active: boolean) {
  const [tabsetId, setTabsetId] = useState(() => node.getParent()?.getId() ?? null);
  const [host, setHost] = useState<Element | null>(null);

  useEffect(() => {
    const model = node.getModel();
    const updateTabsetId = () => {
      const nextTabsetId = node.getParent()?.getId() ?? null;
      setTabsetId((current) => current === nextTabsetId ? current : nextTabsetId);
    };
    model.addChangeListener(updateTabsetId);
    updateTabsetId();
    return () => model.removeChangeListener(updateTabsetId);
  }, [node]);

  useEffect(() => {
    const nextHost = active && tabsetId
      ? document.getElementById(workspaceGridTabsetActionHostId(tabsetId))
      : null;
    setHost((current) => current === nextHost ? current : nextHost);
  }, [active, tabsetId]);

  return host;
}

function WorkspaceGridRealPanelComponent({
  config,
  node,
  onOpenPanelRef,
  onSearchChannel,
}: {
  config: WorkspacePanelConfig;
  node: TabNode;
  onOpenPanelRef?: WorkspaceGridPanelFactoryOptions["onOpenPanelRef"];
  onSearchChannel?: WorkspaceGridPanelFactoryOptions["onSearchChannel"];
}) {
  const active = useWorkspaceGridWritableState(node);
  const headerActionsHost = useWorkspaceGridHeaderActionsHost(node, active);
  if (config.kind === "channel" || config.kind === "dm") {
    return <ChannelPanel active={active} config={config} onOpenPanelRef={onOpenPanelRef} onSearchChannel={onSearchChannel} headerActionsHost={headerActionsHost} />;
  }
  if (config.ref?.kind === "tasks") {
    const handleOpenTask = onOpenPanelRef
      ? (task: Task) => {
          onOpenPanelRef(
            {
              kind: "thread",
              channelId: task.channelId,
              threadRootId: task.messageId,
            },
            {
              title: `task #${task.taskNumber}`,
              subtitle: task.title,
            },
          );
        }
      : undefined;

    return (
      <div className="workspace-grid-chrome-density h-full min-h-0">
        <Suspense fallback={<PanelFallback />}>
          <TasksPanel onOpenTask={handleOpenTask} />
        </Suspense>
      </div>
    );
  }
  if (config.kind === "agent") return <AgentPanel config={config} headerActionsHost={headerActionsHost} />;
  if (config.kind === "machine") return <MachinePanel config={config} />;
  if (config.kind === "human") return <HumanPanel config={config} />;
  if (config.kind === "settings") return <WorkspaceSettingsPanel config={config} />;
  if (config.kind === "thread") {
    return <WorkspaceThreadPanel active={active} config={config} node={node} onOpenPanelRef={onOpenPanelRef} headerActionsHost={headerActionsHost} />;
  }

  return <MockPanel config={config} />;
}

const WorkspaceGridRealPanel = memo(
  WorkspaceGridRealPanelComponent,
  (previous, next) =>
    workspacePanelConfigSignature(previous.config) === workspacePanelConfigSignature(next.config)
    && previous.node === next.node
    && previous.onOpenPanelRef === next.onOpenPanelRef
    && previous.onSearchChannel === next.onSearchChannel,
);

export default WorkspaceGridRealPanel;
