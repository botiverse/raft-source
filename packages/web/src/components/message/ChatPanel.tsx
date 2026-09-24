import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import type { ComponentType, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { LogIn, ArrowLeft, Settings, MessageSquare, ListTodo, ArrowDown, Square, Paperclip, Bell, BellOff, X, Search } from "lucide-react";
import { SortableTabsList, SortableTabsTab, Tabs, TabsLabel, useOrderedTabs } from "raft-ui";
import { toast } from "raft-ui";
import SOSDialog from "./SOSDialog";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { canToggleActivityMute, matchesActivityMuteState, matchesMessageDisplayPrefsState, normalizeActivityMuteState, normalizeMessageDisplayPrefs } from "../../store/channelDomain";
import {
  selectChannelMessageBucket,
  selectChannelWindowMeta,
  useMessageStore,
} from "../../store/messageStore";
import type {
  Message,
} from "../../store/messageStore";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { PLAN_CONFIG, getEffectiveLimits, TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { CHAT_TAB_QUERY_PARAM, useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useTranslationBatch } from "../../hooks/useTranslationBatch";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import StatusDot from "../ui/StatusDot";
import { useThreadStore } from "../../store/threadStore";
import type { OpenThreadRequest } from "../../store/threadStore";
import Banner from "../ui/Banner";
import { useProfileStore } from "../../store/profileStore";
import MessageItem, { buildMentionMap } from "./MessageItem";
import HistoryTopState from "./HistoryTopState";
import MessageInput from "./MessageInput";
import MessageTimeline, {
  recallPersistedScrollMessageId,
} from "./MessageTimeline";
import type {
  MessageTimelineHandle,
  MessageTimelineSource,
} from "./MessageTimeline";
import SelectModeToolbar from "./SelectModeToolbar";
import SelectShareLightbox from "./SelectShareLightbox";
import {
  buildSelectedMessagePermalinks,
  canForwardFromSource,
  formatCopyLinksToast,
  formatForwardSelectionBlockedMessage,
  getForwardableMessages,
} from "./forwardSelectionUtils";
import { forwardToast } from "./forwardToast";
import { useSelectionStore } from "../../store/selectionStore";
import { gatherSelectedMessagesWithMeta, useSelectionShareHandlers } from "./useSelectionShareHandlers";
import ChannelMembers from "../agent/ChannelMembers";
import ChannelOverflowMenu from "../channel/ChannelOverflowMenu";
import Button from "../ui/Button";
import PanelHeader from "../ui/PanelHeader";
import EmptyState from "../ui/EmptyState";
import AvatarSlot from "../ui/AvatarSlot";
import EditChannelDialog from "../channel/EditChannelDialog";
import { ChannelKindIcon } from "../channel/channelKindIcon";
import { selectChannelTaskBucket, useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
import TasksPanel from "../task/TasksPanel";
import ChannelFilesPanel from "./ChannelFilesPanel";
import { getHistoryTopState } from "../../utils/historyTopState";
import SystemMessageGroupDisclosure from "./SystemMessageGroupDisclosure";
import { buildSystemMessageRenderStates } from "./systemMessageGrouping";
import { useStableMessageGrouping } from "./messageGrouping";
import { DateDivider } from "./DateDivider";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import api from "../../api/client";
import { useAttachmentPreviewGate } from "../../store/attachmentPreviewGate";
import { useReadReceiptHydrate } from "../../hooks/useReadReceiptHydrate";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import NotificationActivationBanner, {
  isNotificationActivationComposerEligible,
} from "./NotificationActivationBanner";
import type { ForwardDelivery } from "./ForwardComposerDialog";
import { formatActivityText } from "../../utils/activity";
import { resolveAgentDmProfileSource } from "../layout/agentDmProfileSource";

const ForwardComposerDialog = lazy(() => import("./ForwardComposerDialog"));

type ChatPanelTab = "chat" | "tasks" | "files";

// The activity-mute error banner persists until dismissed, so store the stable
// message key (not a formatted string) and resolve it at render time — otherwise
// a language switch would leave the already-shown banner in the old locale.
type ActivityMuteErrorKey =
  | "message.chatPanel.loadActivityMuteError"
  | "message.chatPanel.muteActivityError"
  | "message.chatPanel.unmuteActivityError";
type MessageDisplayPrefsErrorKey =
  | "message.chatPanel.loadMessageDisplayPrefsError"
  | "message.chatPanel.collapseLongMessagesError";
const SELECTION_TOAST_OPTIONS = { icon: false, dismissible: false } as const;
// Test hook for render-count gates around message rows. Production leaves it null.
export const ChatPanelMessageRenderScope = createContext<((id: string, children: ReactNode) => ReactNode) | null>(null);
type PanelTabItem<T extends string> = {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
};
export const normalizeActivityMuteSettings = normalizeActivityMuteState;
export const normalizeMessageDisplaySettings = normalizeMessageDisplayPrefs;

export function getThreadParentMessageIdFromParam(threadParam: string | null): string | null {
  if (!threadParam) return null;
  const idx = threadParam.indexOf(":");
  if (idx <= 0) return null;
  const parentMessageId = threadParam.slice(idx + 1);
  return parentMessageId || null;
}

export function resolveChatPanelQueryFocusMessageId(searchParams: URLSearchParams): string | null {
  const rawFocusMessageId = searchParams.get("msg");
  const threadParam = searchParams.get("thread");
  if (!threadParam) return rawFocusMessageId;

  const parentMessageId = getThreadParentMessageIdFromParam(threadParam);
  return rawFocusMessageId === parentMessageId ? rawFocusMessageId : null;
}

export function ActivityMutedBadge() {
  const { formatMessage } = useIntl();
  const topbarOverflow = useServerFeatureFlag(TOPBAR_OVERFLOW_FEATURE_FLAG_KEY);
  // final7 (flag on): icon-only indicator next to the title — no MUTED
  // text, no enclosing frame. The tooltip keeps the meaning discoverable.
  // Flag off keeps the legacy framed text badge byte-identical.
  if (topbarOverflow.enabled) {
    return (
      <span
        className="inline-flex shrink-0 items-center leading-none text-black/70"
        title={formatMessage({ id: "message.chatPanel.activityMuted" })}
        data-testid="activity-muted-badge"
      >
        <BellOff size={12} />
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 border-2 border-black bg-brutal-orange/25 px-1.5 py-1 text-[11px] font-bold uppercase leading-none"
      title={formatMessage({ id: "message.chatPanel.activityMuted" })}
      data-testid="activity-muted-badge"
    >
      <BellOff size={11} />
      {formatMessage({ id: "message.chatPanel.mutedBadge" })}
    </span>
  );
}

export function ActivityMuteToggleButton({
  activityMuted,
  disabled,
  onToggle,
  dm = false,
}: {
  activityMuted: boolean;
  disabled: boolean;
  onToggle: () => void;
  /** DM surfaces say "DM" instead of "channel". The toggle is currently only
   * rendered for channel/private/joint (see canToggleActivityMute), but the
   * server already supports DM mute, so the label variant is wired ahead. */
  dm?: boolean;
}) {
  const { formatMessage } = useIntl();
  const label = formatMessage({
    id: dm
      ? (activityMuted ? "message.chatPanel.unmuteActivityDm" : "message.chatPanel.muteActivityDm")
      : (activityMuted ? "message.chatPanel.unmuteActivityChannel" : "message.chatPanel.muteActivityChannel"),
  });
  const Icon = activityMuted ? BellOff : Bell;
  return (
    <Button
      onClick={onToggle}
      shape="icon"
      tone={activityMuted ? "orange" : "white"}
      title={label}
      aria-label={label}
      disabled={disabled}
      data-testid="activity-mute-toggle"
      className={disabled ? "cursor-wait opacity-60" : ""}
    >
      <Icon size={14} />
    </Button>
  );
}

// Isolated component — subscribes to a single agent's activity to avoid
// re-rendering the entire ChatPanel on any agent status change.
function AgentDMStatus({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId);
  const activityText = formatActivityText(
    formatMessage,
    displayState.activity,
    displayState.activityDetail,
    displayState.activityDetailKind,
  );
  return (
    <>
      <StatusDot activity={displayState.activity} external={displayState.isExternal} title={activityText} />
      <span className="min-w-0 truncate text-sm text-black/60 font-mono" title={activityText}>
        {activityText}
      </span>
    </>
  );
}

function HistoryLimitBanner() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const billing = useServerStore((s) => s.billing);
  const nav = useAppNavigate();
  const plan = (billing?.plan || server?.plan || "free") as ServerPlan;
  const days = getEffectiveLimits(plan).messageHistoryDays;

  return (
    <Banner intent="warning" density="sm" className="mx-auto mb-3 max-w-md text-center font-bold justify-center">
      {formatMessage({ id: "message.chatPanel.historyLimit" }, { days, plan: PLAN_CONFIG[plan].displayName })}{" "}
      <button
        onClick={() => nav.toSettings("billing")}
        className="underline"
      >
        {formatMessage({ id: "message.chatPanel.viewBilling" })}
      </button>
    </Banner>
  );
}

export default function ChatPanel({
  channel,
  hideHeader,
  readOnly,
  // Stryker disable all: workspace host defaults are exercised by the real-panel browser smoke.
  showComposer = true,
  overlayComposer = false,
  workspaceComposer = false,
  composerAutoFocus = true,
  // Stryker restore all
  onOpenThread,
  onOpenProfile,
  onSearchChannel,
  headerActionsHost,
}: {
  channel: Channel | null;
  hideHeader?: boolean;
  readOnly?: boolean;
  showComposer?: boolean;
  overlayComposer?: boolean;
  workspaceComposer?: boolean;
  composerAutoFocus?: boolean;
  onOpenThread?: (request: OpenThreadRequest) => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  onSearchChannel?: (channelId: string) => void;
  headerActionsHost?: Element | null;
}) {
  const { formatMessage } = useIntl();
  const chatPanelTabs = useMemo<PanelTabItem<ChatPanelTab>[]>(() => [
    { id: "chat", icon: MessageSquare, label: formatMessage({ id: "message.chatPanel.tabChat" }) },
    { id: "tasks", icon: ListTodo, label: formatMessage({ id: "message.chatPanel.tabTasks" }) },
    { id: "files", icon: Paperclip, label: formatMessage({ id: "message.chatPanel.tabFiles" }) },
  ], [formatMessage]);
  // Keep locale-bound formatMessage out of effect/handler deps: effects that
  // load activity-mute state or reset selection must NOT re-run on a language
  // switch (that would clobber in-flight state). Render + the tab-label memo use
  // formatMessage directly; effects/handlers read formatMessageRef.current.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const [serverMessageForwardingEnabled, setServerMessageForwardingEnabled] = useState(false);
  const messageForwardingEnabled = serverMessageForwardingEnabled;
  const channelId = channel?.id ?? null;
  const topbarOverflow = useServerFeatureFlag(TOPBAR_OVERFLOW_FEATURE_FLAG_KEY);
  useReadReceiptHydrate(channel);
  const messageRenderScope = useContext(ChatPanelMessageRenderScope);
  const messages = useMessageStore((s) => selectChannelMessageBucket(s, channelId));
  const channelWindowMeta = useMessageStore((s) => selectChannelWindowMeta(s, channelId));
  const {
    loading,
    loadingOlder,
    loadingNewer,
    hasMore,
    hasNewer,
    historyLimited,
    contextLoadError,
  } = channelWindowMeta;
  const messagesBelongToChannel = !!channelId;
  const shouldShowMessageTimeline = messages.length > 0;
  const [translationWindowIds, setTranslationWindowIds] = useState<string[]>([]);
  const translationMessages = useMemo(() => {
    if (translationWindowIds.length === 0) return [];
    const idSet = new Set(translationWindowIds);
    return messages.filter((message) => idSet.has(message.id));
  }, [messages, translationWindowIds]);
  useTranslationBatch(translationMessages);
  const loadMessages = useMessageStore((s) => s.loadMessages);
  const loadMessageContext = useMessageStore((s) => s.loadMessageContext);
  const loadMessageWindowSilent = useMessageStore((s) => s.loadMessageWindowSilent);
  const loadOlderMessages = useMessageStore((s) => s.loadOlderMessages);
  const loadNewerMessages = useMessageStore((s) => s.loadNewerMessages);
  const highlightedMessageId = useMessageStore((s) => s.highlightedMessageId);
  const transientFocusRequest = useMessageStore((s) => s.transientFocusRequest);
  const consumeTransientFocusRequest = useMessageStore((s) => s.consumeTransientFocusRequest);
  const setHighlightedMessageId = useMessageStore((s) => s.setHighlightedMessageId);
  const exitContextWindow = useMessageStore((s) => s.exitContextWindow);
  const setNearBottom = useMessageStore((s) => s.setNearBottom);
  // Narrow subscription: only the current channel's unread count, not the whole
  // unreadCounts Record. The reducer rebuilds that Record (new ref) on every
  // `message:new`, so subscribing to it re-rendered ChatPanel on every inbound
  // message anywhere. Selecting a single number re-renders only when THIS
  // channel's count changes. (broad-subscription sweep P0-A)
  const currentUnreadCount = useMessageStore((s) => (channel ? s.unreadCounts[channel.id] || 0 : 0));
  const topHistoryState = getHistoryTopState({ hasMore, historyLimited });
  const agents = useAgentStore((s) => s.agents);
  // `channels` is stable across inbound-message activity bumps now that
  // `lastMessageAt` lives in the `channelActivity` slice (not the channel
  // objects), so a plain subscription no longer re-renders the message list.
  const channels = useChannelStore((s) => s.channels);
  const members = useServerStore((s) => s.members);
  const {
    channelAgents: mentionChannelAgents,
    channelHumans: mentionChannelHumans,
    channelExternalMembers: mentionChannelExternalMembers,
    loading: mentionMembersLoading,
    addMembers: addMentionChannelMembers,
    addAgent: addMentionChannelAgent,
    removeAgent: removeMentionChannelAgent,
    addHuman: addMentionChannelHuman,
    removeHuman: removeMentionChannelHuman,
    changeMemberRole: changeMentionChannelMemberRole,
    roleChangeFailed: mentionRoleChangeFailed,
  } = useChannelMembers(channel?.id ?? "");
  const joinChannel = useChannelStore((s) => s.joinChannel);
  const leaveChannel = useChannelStore((s) => s.leaveChannel);
  const setChannelActivityMuteState = useChannelStore((s) => s.setActivityMuteState);
  const setChannelMessageDisplayPrefsState = useChannelStore((s) => s.setMessageDisplayPrefsState);
  const currentServer = useServerStore((s) => s.current);
  const billing = useServerStore((s) => s.billing);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const serverSlug = currentServer?.slug;
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const nav = useAppNavigate();
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const [forwardComposer, setForwardComposer] = useState<{
    messages: Message[];
    skippedCount: number;
    nestedForwardCount: number;
  } | null>(null);
  const channelPanelTabOrder = useServerStore((s) => s.sidebarOrder.channelPanelTabOrder);
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const orderedTabs = useOrderedTabs(chatPanelTabs, channelPanelTabOrder);
  const visibleTabs = useMemo(
    () => {
      // Threads only have the chat surface — no per-thread tasks or files
      // boards (stdrc msg=71334a2d 2026-05-27).
      // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      if (channel?.type === "thread") return orderedTabs.filter((tab) => tab.id === "chat");
      return orderedTabs;
    },
    [channel?.type, orderedTabs],
  );

  useEffect(() => {
    if (!currentServer) return;
    void loadBilling();
  }, [currentServer?.id, loadBilling, currentServer]);

  const activityMuteSupported =
    !!channelId &&
    canToggleActivityMute(channel ?? undefined);

  // External API synchronization for the selected conversation's mute setting.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let canceled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setActivityMuteError(null);

    if (!activityMuteSupported || !channelId) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setActivityMuteLoading(false);
      return;
    }

    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setActivityMuteLoading(true);
    api.get(`/channels/${channelId}/notification-settings`)
      .then((res) => {
        if (canceled) return;
        const normalized = normalizeActivityMuteSettings(res.data);
        setChannelActivityMuteState(channelId, normalized);
      })
      .catch(() => {
        if (canceled) return;
        setActivityMuteError("message.chatPanel.loadActivityMuteError");
      })
      .finally(() => {
        if (!canceled) setActivityMuteLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [activityMuteSupported, channelId, setChannelActivityMuteState]);

  // External API synchronization for the selected conversation's collapse
  // preference (task #187 collapse-long-messages). Same channel-type and
  // membership gating as the activity-mute effect above, plus the rollout
  // gate itself. A disabled/unresolved flag must issue no preference request.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let canceled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setMessageDisplayPrefsError(null);

    if (!topbarOverflow.enabled || !activityMuteSupported || !channelId) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setMessageDisplayPrefsLoading(false);
      return;
    }

    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setMessageDisplayPrefsLoading(true);
    api.get(`/channels/${channelId}/message-display-settings`)
      .then((res) => {
        if (canceled) return;
        const normalized = normalizeMessageDisplaySettings(res.data);
        setChannelMessageDisplayPrefsState(channelId, normalized);
      })
      .catch(() => {
        if (canceled) return;
        setMessageDisplayPrefsError("message.chatPanel.loadMessageDisplayPrefsError");
      })
      .finally(() => {
        if (!canceled) setMessageDisplayPrefsLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [activityMuteSupported, channelId, setChannelMessageDisplayPrefsState, topbarOverflow.enabled]);

  const reorderTabs = useCallback((nextOrder: ChatPanelTab[]) => {
    void updateSidebarOrder({ channelPanelTabOrder: nextOrder });
  }, [updateSidebarOrder]);
  // Stryker disable next-line ArrowFunction,ArrayDeclaration: sortable tab value mirrors visibleTabs; source contract and browser validation cover the raft-ui composition.
  const visibleTabIds = useMemo(() => visibleTabs.map((tab) => tab.id), [visibleTabs]);
  const defaultTab = visibleTabs[0]?.id ?? "chat";
  const queryTab = searchParams.get(CHAT_TAB_QUERY_PARAM);
  const legacyTab = searchParams.get("tab");
  const activeTab = (
    visibleTabs.some((tab) => tab.id === queryTab)
      ? queryTab
      : queryTab === null && visibleTabs.some((tab) => tab.id === legacyTab)
        ? legacyTab
        : defaultTab
  ) as ChatPanelTab;
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral,EqualityOperator: this only hides redundant one-tab chrome; tab behavior is covered by source contract and browser validation.
  const showPanelTabs = !hideHeader && visibleTabs.length > 1;
  // Stryker disable all: raft-ui tab child composition is visual wiring pinned by panelTabReorderContract and browser validation, not by the focused mutation corpus.
  const visibleTabButtons = visibleTabs.map((tab) => {
    const Icon = tab.icon;
    return (
      <SortableTabsTab
        key={tab.id}
        value={tab.id}
        data-testid={`panel-tab-${tab.id}`}
        className="!cursor-default"
      >
        <Icon size={12} />
        <TabsLabel>{tab.label}</TabsLabel>
      </SortableTabsTab>
    );
  });
  const threadParam = searchParams.get("thread");
  const rawQueryFocusMessageId = searchParams.get("msg");
  const queryFocusMessageId = resolveChatPanelQueryFocusMessageId(searchParams);
  const setActiveTab = useCallback((tab: ChatPanelTab) => {
    // Merge with the live document query, not this component's render snapshot.
    // A thread can open before this callback re-renders; a snapshot-based write
    // would drop `thread=` and the MainLayout URL→store effect would close it.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === defaultTab) next.delete(CHAT_TAB_QUERY_PARAM);
      else next.set(CHAT_TAB_QUERY_PARAM, tab);
      const legacyTab = next.get("tab");
      if (legacyTab === "chat" || legacyTab === "tasks") next.delete("tab");
      return next;
    }, { replace: true });
  }, [defaultTab, setSearchParams]);
  const [showEditDialog, setShowEditDialog] = useState(false);
  // task #187: with the overflow flag on, the archived banner's Unarchive
  // link must open the same overflow drawer instead of the legacy sheet.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [showSOSDialog, setShowSOSDialog] = useState(false);
  const [activityMuteLoading, setActivityMuteLoading] = useState(false);
  const [activityMuteSaving, setActivityMuteSaving] = useState(false);
  const [activityMuteError, setActivityMuteError] = useState<ActivityMuteErrorKey | null>(null);
  const [messageDisplayPrefsLoading, setMessageDisplayPrefsLoading] = useState(false);
  const [messageDisplayPrefsSaving, setMessageDisplayPrefsSaving] = useState(false);
  const [messageDisplayPrefsError, setMessageDisplayPrefsError] = useState<MessageDisplayPrefsErrorKey | null>(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [expandedSystemMessageGroups, setExpandedSystemMessageGroups] = useState<Set<string>>(() => new Set());
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const handledTransientFocusNonceRef = useRef<number | null>(null);
  const initialLoadRef = useRef(true);
  // Set when "Back to bottom" is clicked while in a context window
  // (`focusMessageId` or `hasNewer`). Drained after `loadMessages` settles —
  // a manual scroll is required because the primitive's `initialFocusMessageId`
  // is consumed at mount and the data swap happens mid-mount.
  const pendingBottomScrollRef = useRef(false);
  const transientFocusRequestRef = useRef(transientFocusRequest);
  transientFocusRequestRef.current = transientFocusRequest;
  const { capabilities } = useServerPermissions();
  const effectiveChannelCapabilities = channel?.channelCapabilities ?? capabilities;
  const canManageChannels = Boolean(
    effectiveChannelCapabilities.editChannelMetadata
    || effectiveChannelCapabilities.changeChannelVisibility
    || effectiveChannelCapabilities.archiveChannels
    || effectiveChannelCapabilities.deleteChannels
    || effectiveChannelCapabilities.addChannelMembers
    || effectiveChannelCapabilities.removeChannelMembers
    || effectiveChannelCapabilities.changeChannelMemberRoles
    || effectiveChannelCapabilities.federateChannels
  );
  const canManageAgents = capabilities.controlAgentRuntime;
  const focusMessageId = queryFocusMessageId;

  // Thread navigation owns only the active-parent focus border. Retire any
  // temporary channel permalink flash before paint without reloading or moving
  // the channel.
  useLayoutEffect(() => {
    if (!threadParam) return;
    setHighlightedMessageId(null);
  }, [setHighlightedMessageId, threadParam]);

  // Load messages on channel switch. Channel-switch reset of scroll-position
  // UI state (translation/nearBottom/atBottom/newMessageCount) + async load.
  // NOT a mirror-prop family — these are UI state that the new channel needs
  // reset, no user input is being clobbered. Distinct effect from L242's
  // permalink-scroll guard (different concern). Same FP family as Cluster 2
  // async-loader / channel-switch reset patterns.
  // `thread=` changes only the right panel. It must not restart the channel
  // loader: users can leave a stale `msg=` permalink in the URL, scroll to a
  // different part of the context window, then open another thread. Reloading
  // here would replace their current channel window with the tail. A channel
  // change or an actual `msg=` change remains a channel-load intent.
  // oxlint-disable react-hooks/exhaustive-deps -- thread-only URL changes do not own channel loading
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!channelId) return;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setTranslationWindowIds([]);
    initialLoadRef.current = true;
    prevMessageCountRef.current = 0;
    isNearBottomRef.current = true;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setNearBottom(true);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setNewMessageCount(0);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setAtBottom(true);
    const pendingTransientFocus = transientFocusRequestRef.current;
    if (
      !threadParam &&
      !queryFocusMessageId &&
      pendingTransientFocus?.channelId === channelId &&
      pendingTransientFocus.nonce !== handledTransientFocusNonceRef.current
    ) {
      // The dedicated transient-focus effect below owns this entry. Keeping it
      // out of this effect's dependency list prevents consuming the one-shot
      // request from immediately triggering a normal tail reload.
      return;
    }
    if (focusMessageId) {
      loadMessageContext(channelId, focusMessageId);
      return;
    }
    // Restore prior scroll position if we have one — load centered around the
    // remembered top-visible message id so the same window is rehydrated. The
    // primitive's persistKey path picks the saved id up as the
    // initialTopMostItemIndex on mount. The "silent" load skips the highlight
    // flash + scroll-to-center side-effects so the resume reads as a return
    // to the parked spot, not a permalink jump.
    const persistedId = recallPersistedScrollMessageId(`channel:${channelId}`);
    if (persistedId) {
      loadMessageWindowSilent(channelId, persistedId);
    } else {
      loadMessages(channelId);
    }
  }, [
    channelId,
    loadMessageContext,
    loadMessages,
    loadMessageWindowSilent,
    rawQueryFocusMessageId,
    setNearBottom,
  ]);
  // oxlint-enable react-hooks/exhaustive-deps

  useEffect(() => {
    if (!channelId || threadParam || queryFocusMessageId) return;
    if (!transientFocusRequest || transientFocusRequest.channelId !== channelId) return;
    if (transientFocusRequest.nonce === handledTransientFocusNonceRef.current) return;

    handledTransientFocusNonceRef.current = transientFocusRequest.nonce;
    consumeTransientFocusRequest(transientFocusRequest.nonce);
    loadMessageContext(channelId, transientFocusRequest.messageId);
  }, [
    channelId,
    consumeTransientFocusRequest,
    loadMessageContext,
    queryFocusMessageId,
    threadParam,
    transientFocusRequest,
  ]);

  useEffect(() => {
    if (!highlightedMessageId || messages.length === 0) return;
    if (!messages.some((msg) => msg.id === highlightedMessageId)) return;

    const focusFrame = requestAnimationFrame(() => {
      timelineRef.current?.scrollToMessage(highlightedMessageId, { align: "center" });
    });

    const timer = window.setTimeout(() => {
      setHighlightedMessageId(null);
    }, 2000);

    return () => {
      cancelAnimationFrame(focusFrame);
      window.clearTimeout(timer);
    };
  }, [messages, highlightedMessageId, setHighlightedMessageId]);

  // Handle new messages: scroll-to-bottom is owned by the primitive's
  // followOutput; here we only maintain the "new messages" badge counter.
  useEffect(() => {
    if (messages.length === 0) return;
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      prevMessageCountRef.current = messages.length;
      return;
    }
    if (messages.length > prevMessageCountRef.current && prevMessageCountRef.current > 0) {
      const newCount = messages.length - prevMessageCountRef.current;
      if (newCount <= 5 && !isNearBottomRef.current) {
        // oxlint-disable-next-line react-doctor/no-derived-state -- event counter for off-bottom appends, not render-derived state
        setNewMessageCount((prev) => prev + newCount);
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to bottom when switching back to chat tab
  const prevActiveTabRef = useRef(activeTab);
  useEffect(() => {
    const wasOtherTab = prevActiveTabRef.current !== "chat";
    prevActiveTabRef.current = activeTab;
    if (wasOtherTab && activeTab === "chat" && messages.length > 0 && !hasNewer) {
      requestAnimationFrame(() => {
        timelineRef.current?.scrollToBottom();
      });
    }
  }, [activeTab, hasNewer, messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isNearBottomRef.current = atBottom;
    setAtBottom(atBottom);
    setNearBottom(atBottom);
    if (atBottom) setNewMessageCount(0);
  }, [setNearBottom]);

  const scrollToBottom = useCallback(() => {
    timelineRef.current?.scrollToBottom();
    setNewMessageCount(0);
  }, []);

  const clearFocusedMessageParam = useCallback(() => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      // `msg` is the current permalink/search anchor. Clean the old `message`
      // alias too so older links or stale local state do not immediately reopen
      // the centered context window.
      next.delete("msg");
      next.delete("message");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // "Back to bottom" while in a context window or with unloaded newer
  // messages. Clears focus, exits the context window in the store (so
  // the list stops requesting newer pages), and arms a post-load scroll
  // that fires once `loadMessages` finishes — Virtuoso would otherwise
  // keep its previous scroll position after the data swap.
  const handleBackToBottom = useCallback(() => {
    if (!channelId) return;
    setHighlightedMessageId(null);
    setNewMessageCount(0);
    pendingBottomScrollRef.current = true;
    if (focusMessageId) {
      clearFocusedMessageParam();
    }
    if (hasNewer) {
      exitContextWindow(channelId);
      loadMessages(channelId);
    }
  }, [channelId, clearFocusedMessageParam, exitContextWindow, focusMessageId, hasNewer, loadMessages, setHighlightedMessageId]);

  // Drains `pendingBottomScrollRef` once the post-`handleBackToBottom`
  // load settles — primitive remounts on channel switch but a context-window
  // exit reuses the same mount, so we have to scroll imperatively.
  useEffect(() => {
    if (!pendingBottomScrollRef.current) return;
    if (loading || messages.length === 0) return;
    pendingBottomScrollRef.current = false;
    requestAnimationFrame(() => {
      timelineRef.current?.scrollToBottom();
    });
  }, [loading, messages]);

  const handleWillSend = useCallback(async () => {
    if (!channelId) return;
    if (hasNewer || focusMessageId) {
      clearFocusedMessageParam();
      exitContextWindow(channelId);
      setHighlightedMessageId(null);
    }
    timelineRef.current?.armFollowOnNextAppend();
    isNearBottomRef.current = true;
    setAtBottom(true);
    setNearBottom(true);
    setNewMessageCount(0);
    requestAnimationFrame(() => {
      timelineRef.current?.scrollToBottom();
    });
  }, [channelId, clearFocusedMessageParam, exitContextWindow, focusMessageId, hasNewer, setHighlightedMessageId, setNearBottom]);

  const loadOlderForChannel = useCallback(() => {
    if (!channelId) return Promise.resolve();
    return loadOlderMessages(channelId);
  }, [channelId, loadOlderMessages]);

  const loadNewerForChannel = useCallback(() => {
    if (!channelId) return Promise.resolve();
    return loadNewerMessages(channelId);
  }, [channelId, loadNewerMessages]);

  const storeChannel = useMemo(
    () => {
      if (!channelId) return undefined;
      return channels.find((candidate) => candidate.id === channelId)
        ?? useChannelStore.getState().dmChannels.find((candidate) => candidate.id === channelId);
    },
    [channelId, channels],
  );
  const channelActivityMuted = storeChannel?.activityMuted ?? (channel?.activityMuted === true);
  const channelMuteFromSeq = storeChannel?.muteFromSeq ?? channel?.muteFromSeq ?? null;
  const channelPrefsVersion = storeChannel?.prefsVersion ?? channel?.prefsVersion;
  const activityMuted = channelActivityMuted;
  const channelCollapseLongMessages = topbarOverflow.enabled
    ? storeChannel?.collapseLongMessages ?? channel?.collapseLongMessages ?? true
    : true;
  const channelDisplayPrefsVersion = topbarOverflow.enabled
    ? storeChannel?.displayPrefsVersion ?? channel?.displayPrefsVersion
    : undefined;

  const handleToggleActivityMute = useCallback(async () => {
    if (!activityMuteSupported || !channelId || activityMuteSaving) return;
    const previous = {
      activityMuted: channelActivityMuted,
      muteFromSeq: channelMuteFromSeq,
      activityMuteSupported: true,
      prefsVersion: channelPrefsVersion,
    };
    const nextActivityMuted = !activityMuted;
    const optimistic = {
      activityMuted: nextActivityMuted,
      muteFromSeq: previous.muteFromSeq,
      activityMuteSupported: true,
      prefsVersion: previous.prefsVersion,
    };
    setActivityMuteSaving(true);
    setActivityMuteError(null);
    setChannelActivityMuteState(channelId, optimistic);

    try {
      const { data } = await api.patch(`/channels/${channelId}/notification-settings`, {
        activityMuted: nextActivityMuted,
      });
      const normalized = normalizeActivityMuteSettings(data);
      setChannelActivityMuteState(channelId, normalized);
    } catch {
      const current = useChannelStore.getState().channels.find((candidate) => candidate.id === channelId)
        ?? useChannelStore.getState().dmChannels.find((candidate) => candidate.id === channelId);
      if (matchesActivityMuteState(current, optimistic)) {
        setChannelActivityMuteState(channelId, previous);
        setActivityMuteError(nextActivityMuted
          ? "message.chatPanel.muteActivityError"
          : "message.chatPanel.unmuteActivityError");
      }
    } finally {
      setActivityMuteSaving(false);
    }
  }, [
    activityMuteSaving,
    activityMuteSupported,
    activityMuted,
    channelActivityMuted,
    channelId,
    channelMuteFromSeq,
    channelPrefsVersion,
    setChannelActivityMuteState,
  ]);

  const handleToggleCollapseLongMessages = useCallback(async () => {
    if (!topbarOverflow.enabled || !activityMuteSupported || !channelId || messageDisplayPrefsSaving) return;
    const previous = {
      collapseLongMessages: channelCollapseLongMessages,
      prefsVersion: channelDisplayPrefsVersion,
    };
    const nextCollapseLongMessages = !channelCollapseLongMessages;
    const optimistic = {
      collapseLongMessages: nextCollapseLongMessages,
      prefsVersion: previous.prefsVersion,
    };
    setMessageDisplayPrefsSaving(true);
    setMessageDisplayPrefsError(null);
    setChannelMessageDisplayPrefsState(channelId, optimistic);

    try {
      const { data } = await api.patch(`/channels/${channelId}/message-display-settings`, {
        collapseLongMessages: nextCollapseLongMessages,
      });
      const normalized = normalizeMessageDisplaySettings(data);
      setChannelMessageDisplayPrefsState(channelId, normalized);
    } catch {
      const current = useChannelStore.getState().channels.find((candidate) => candidate.id === channelId)
        ?? useChannelStore.getState().dmChannels.find((candidate) => candidate.id === channelId);
      if (matchesMessageDisplayPrefsState(current, optimistic)) {
        setChannelMessageDisplayPrefsState(channelId, previous);
        setMessageDisplayPrefsError("message.chatPanel.collapseLongMessagesError");
      }
    } finally {
      setMessageDisplayPrefsSaving(false);
    }
  }, [
    activityMuteSupported,
    channelCollapseLongMessages,
    channelDisplayPrefsVersion,
    channelId,
    messageDisplayPrefsSaving,
    setChannelMessageDisplayPrefsState,
    topbarOverflow.enabled,
  ]);

  // Memoize mention map and agent lookup for MessageItem props
  const mentionMap = useMemo(
    () => buildMentionMap(agents, members, mentionChannelAgents, mentionChannelHumans),
    [agents, members, mentionChannelAgents, mentionChannelHumans],
  );
  const agentById = useMemo(() => {
    const map = new Map<string, typeof agents[0]>();
    for (const a of agents) map.set(a.id, a);
    for (const a of mentionChannelAgents) map.set(a.id, a);
    return map;
  }, [agents, mentionChannelAgents]);
  const memberById = useMemo(() => {
    const map = new Map<string, typeof members[0]>();
    for (const m of members) map.set(m.userId, m);
    for (const human of mentionChannelHumans) {
      map.set(human.id, {
        userId: human.id,
        email: null,
        gravatarHash: human.gravatarHash,
        name: human.name,
        displayName: human.displayName,
        description: human.description,
        avatarUrl: human.avatarUrl,
        role: human.role,
        joinedAt: "",
      });
    }
    return map;
  }, [members, mentionChannelHumans]);

  // Thread summaries
  const threadSummaries = useThreadStore((s) => s.summaries);

  const supportsChannelTasks = channel !== null && channel.type !== "thread";

  // Load tasks for the channel to show claim badges on messages.
  const channelTasks = useTaskStore((s) => selectChannelTaskBucket(s, channel?.id));
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const channelTasksLoading = useTaskStore((s) => channel ? s.loadingByChannelId[channel.id] ?? false : false);
  const channelTasksLoaded = useTaskStore((s) => {
    if (!channel) return false;
    const loaded = s.loadedByChannelId[channel.id];
    if (loaded !== undefined) return loaded;
    return s.currentChannelId === channel.id && !s.loading;
  });
  useEffect(() => {
    if (!channel || !supportsChannelTasks) return;
    if (readOnly || channelTasksLoading || channelTasksLoaded) return;
    void loadTasks(channel.id);
  }, [channel, channelTasksLoaded, channelTasksLoading, loadTasks, readOnly, supportsChannelTasks]);

  // Feeds the inline status badge and `standaloneMessageIds`, which stops a
  // task-bearing message being merged into a consecutive-message group.
  const taskByMessageId = useMemo(() => {
    const map = new Map<string, Task>();
    if (!supportsChannelTasks) return map;
    for (const t of channelTasks) map.set(t.messageId, t);
    return map;
  }, [channelTasks, supportsChannelTasks]);

  const messageSource = useMemo<MessageTimelineSource>(() => ({
    messages,
    hasOlder: hasMore,
    hasNewer,
    loading,
    loadOlder: loadOlderForChannel,
    loadNewer: loadNewerForChannel,
    initialFocusMessageId: highlightedMessageId ?? focusMessageId ?? null,
  }), [messages, hasMore, hasNewer, loading, loadOlderForChannel, loadNewerForChannel, highlightedMessageId, focusMessageId]);

  const systemMessageRenderStates = useMemo(
    () => buildSystemMessageRenderStates(messages, formatMessage),
    [messages, formatMessage],
  );

  // Consecutive-same-sender grouping + day-boundary state (task #44), computed
  // once from the ordered message list (not the DOM) so it stays correct when
  // the timeline windows rows. Timezone-aware so dividers agree with labels.
  const { options: timeFormatOptions } = useTimeFormatter();
  // Messages carrying a thread reply or task status render standalone and never
  // merge — they keep the full header + reply/task badges (stdrc review).
  const standaloneMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) {
      if (threadSummaries[m.id] || taskByMessageId.has(m.id)) ids.add(m.id);
    }
    return ids;
  }, [messages, threadSummaries, taskByMessageId]);
  const messageGrouping = useStableMessageGrouping(
    messages,
    timeFormatOptions.timeZone ?? undefined,
    standaloneMessageIds,
  );

  const toggleSystemMessageGroup = useCallback((groupId: string) => {
    setExpandedSystemMessageGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const preserveChannelAnchorForThreadOpen = useCallback(() => {
    timelineRef.current?.preserveAnchorOnNextLayoutChange();
  }, []);

  const canReactInChannel = !readOnly
    && !channel?.archivedAt
    && (channel?.type === "dm" || channel?.type === "thread" || channel?.joined === true);
  const renderChannelItem = useCallback((msg: Message, index: number) => {
    const systemMessageState = systemMessageRenderStates[index];
    const wrapMessageRender = (children: ReactNode) =>
      messageRenderScope && channelId
        ? messageRenderScope(`message:${channelId}:${msg.id}`, children)
        : children;
    if (systemMessageState?.kind === "hide") return null;

    if (systemMessageState?.kind === "summary") {
      const expanded = expandedSystemMessageGroups.has(systemMessageState.groupId);
      return wrapMessageRender(
        <div
          className="px-3"
          // `overflow: clip visible` keeps the horizontal clip (wide code /
          // attachments can't blow out the column) while letting the hover
          // toolbar overflow upward to ride on the message's top border.
          // `contain: layout style` keeps layout+style isolation for the long
          // list; only `paint` is dropped, since paint containment is what
          // forces the vertical clip. See MessageItem hover toolbar.
          style={{ contain: "layout style", overflow: "clip visible" }}
        >
          <SystemMessageGroupDisclosure
            summary={systemMessageState.content}
            expanded={expanded}
            onToggle={() => toggleSystemMessageGroup(systemMessageState.groupId)}
          >
            {systemMessageState.messageIndexes.map((messageIndex) => {
              const originalMessage = messages[messageIndex];
              if (!originalMessage) return null;
              return (
                <MessageItem
                  key={originalMessage.id}
                  message={originalMessage}
                  linkedTask={taskByMessageId.get(originalMessage.id)}
                  mentionMap={mentionMap}
                  channels={channels}
                  previewSenderAgent={originalMessage.senderType === "agent" ? agentById.get(originalMessage.senderId) : undefined}
                  previewSenderMember={originalMessage.senderType === "user" ? memberById.get(originalMessage.senderId) : undefined}
                  channelParticipantAgentsById={agentById}
                  channelParticipantMembersById={memberById}
                  threadSummary={threadSummaries[originalMessage.id]}
                  parentChannelId={channel?.id ?? ""}
                  mentionComposerChannelId={channel?.id ?? originalMessage.channelId}
                  hideThreadActions
                  onBeforeOpenThread={preserveChannelAnchorForThreadOpen}
                  onOpenThread={onOpenThread}
                  onOpenProfile={onOpenProfile}
                  canReact={canReactInChannel}
                />
              );
            })}
          </SystemMessageGroupDisclosure>
        </div>
      );
    }

    const groupState = messageGrouping.get(msg.id);
    return wrapMessageRender(
      <>
        {groupState?.showDayDivider && <DateDivider createdAt={msg.createdAt} />}
        <div
          className="px-3"
          // `overflow: clip visible` keeps the horizontal clip (wide code /
          // attachments can't blow out the column) while letting the hover
          // toolbar overflow upward to ride on the message's top border.
          // `contain: layout style` keeps layout+style isolation for the long
          // list; only `paint` is dropped, since paint containment is what
          // forces the vertical clip. See MessageItem hover toolbar.
          style={{ contain: "layout style", overflow: "clip visible" }}
        >
          <MessageItem
            message={msg}
            linkedTask={taskByMessageId.get(msg.id)}
            mentionMap={mentionMap}
            channels={channels}
            previewSenderAgent={msg.senderType === "agent" ? agentById.get(msg.senderId) : undefined}
            previewSenderMember={msg.senderType === "user" ? memberById.get(msg.senderId) : undefined}
            channelParticipantAgentsById={agentById}
            channelParticipantMembersById={memberById}
            threadSummary={threadSummaries[msg.id]}
            parentChannelId={channel?.id ?? ""}
            mentionComposerChannelId={channel?.id ?? msg.channelId}
            onBeforeOpenThread={preserveChannelAnchorForThreadOpen}
            onOpenThread={onOpenThread}
            onOpenProfile={onOpenProfile}
            canReact={canReactInChannel}
            groupState={groupState}
          />
        </div>
      </>
    );
  }, [agentById, canReactInChannel, channel?.id, channelId, channels, expandedSystemMessageGroups, memberById, mentionMap, messageRenderScope, messages, messageGrouping, onOpenProfile, onOpenThread, preserveChannelAnchorForThreadOpen, systemMessageRenderStates, taskByMessageId, threadSummaries, toggleSystemMessageGroup]);

  const channelHeader = useMemo(() => (
    <div className="px-3 pt-3">
      {contextLoadError && (
        <Banner intent="warning" density="sm" className="mx-auto mb-3 max-w-md text-center font-bold justify-center">
          {formatMessage({ id: "message.chatPanel.messageNotFound" })}
        </Banner>
      )}
      {topHistoryState === "history_limited" ? (
        <HistoryLimitBanner />
      ) : (
        <HistoryTopState
          hasMore={hasMore}
          historyLimited={historyLimited}
          loadingOlder={loadingOlder}
          noun="messages"
        />
      )}
    </div>
  ), [contextLoadError, formatMessage, hasMore, historyLimited, loadingOlder, topHistoryState]);

  const channelFooter = useMemo(() => (
    <div className="px-3 pb-3">
      {loadingNewer && (
        <div className="py-2 text-center text-black/40 font-mono text-xs">{formatMessage({ id: "message.chatPanel.loadingNewer" })}</div>
      )}
      <div className="h-3" />
    </div>
  ), [loadingNewer, formatMessage]);

  // Quota check — hooks must be above the early return to maintain consistent hook order.
  // Reuse the activity-stable `channels` above (this createdAt-sorted check doesn't
  // need live `lastMessageAt`) so it doesn't re-subscribe to the churny whole Record.
  const allChannels = channels;
  const plan = (billing?.plan || currentServer?.plan || "free") as ServerPlan;
  const maxChannels = getEffectiveLimits(plan).maxChannels;
  const isReadOnlyByQuota = useMemo(() => {
    if (!channel || channel.type === "dm" || maxChannels === -1) return false;
    if (allChannels.length <= maxChannels) return false;
    const sorted = [...allChannels].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const writableIds = new Set(sorted.slice(0, maxChannels).map((c) => c.id));
    return !writableIds.has(channel.id);
  }, [channel, maxChannels, allChannels]);

  // Selection store hooks must be declared before the early-return so the
  // hook order is stable across renders.
  const selectModeActive = useSelectionStore((s) => s.isActive);
  const selectModeChannelId = useSelectionStore((s) => s.channelId);
  const exitSelection = useSelectionStore((s) => s.exit);
  const channelIdForSelection = channel?.id ?? null;
  const isMobileComposer = useMediaQuery("(max-width: 767px)");
  const primaryComposerEligible = isNotificationActivationComposerEligible({
    hasChannel: !!channel,
    showComposer,
    readOnly: !!readOnly,
    channelType: channel?.type,
    joined: channel?.joined,
    archived: !!channel?.archivedAt,
    jointLocked: channel?.type === "joint" && channel.jointBillingLocked === true,
    quotaReadOnly: isReadOnlyByQuota,
    selectMode: !!channel && selectModeActive && selectModeChannelId === channel.id,
  });
  const closeForwardComposer = useCallback(() => setForwardComposer(null), []);
  const handleForwardSent = useCallback((deliveries: ForwardDelivery[]) => {
    for (const delivery of deliveries) useMessageStore.getState().addMessage(delivery.message);
    exitSelection();
  }, [exitSelection]);

  // Share-handler state lives in a shared hook so ThreadPanel can mount the
  // same toolbar in thread mode. `picPreviewRef` mirrors `picPreview` so
  // the long-lived ESC handler can defer to the lightbox without
  // re-subscribing.
  const showUnresolvedSelectionToast = useCallback((unresolvedCount: number) => {
    toast.info(
      formatMessageRef.current({ id: "message.chatPanel.unresolvedMessages" }, { count: unresolvedCount }),
      SELECTION_TOAST_OPTIONS,
    );
  }, []);

  const {
    picCapturing,
    picPreview,
    setPicPreview,
    picError,
    setPicError,
    copiedMd,
    onSavePic,
    onShareX,
    onSharePreviewToX,
    onCopyMd,
  } = useSelectionShareHandlers({
    channelMessages: messagesBelongToChannel ? messages : [],
    onUnresolvedSelection: showUnresolvedSelectionToast,
  });
  const picPreviewRef = useRef<string | null>(null);
  picPreviewRef.current = picPreview;

  useEffect(() => {
    void api.get<{ enabled?: unknown }>("/messages/forward/enabled")
      .then((res) => {
        setServerMessageForwardingEnabled(res.data.enabled === true);
      })
      .catch(() => {});
    void useAttachmentPreviewGate.getState().load();
  },
  // Stryker disable next-line ArrayDeclaration: alternate static dependency arrays still run this mount-only flag fetch once.
  []);

  // When the user navigates away from the channel (channel.id changes), exit
  // any active select mode for the previous channel — selection is meaningful
  // only on the surface where it was started.
  useEffect(() => {
    if (!channelIdForSelection) return;
    return () => {
      if (useSelectionStore.getState().channelId === channelIdForSelection) {
        useSelectionStore.getState().exit();
      }
    };
  }, [channelIdForSelection]);

  // Wire ESC to exit select mode (desktop convenience). Skip while the
  // share-preview lightbox is up — it owns ESC there.
  const escGuard = selectModeActive && selectModeChannelId === channelIdForSelection;
  useEffect(() => {
    if (!escGuard) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (picPreviewRef.current) return;
      e.preventDefault();
      exitSelection();
    };
    // keydown-global-exempt: message select-mode escape-exit, active only during selection
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [escGuard, exitSelection]);

  const showForwardAction = messageForwardingEnabled && canForwardFromSource(channel);

  const openForwardComposer = () => {
    const { messages: selected, unresolvedCount } = gatherSelectedMessagesWithMeta({
      channelMessages: messagesBelongToChannel ? messages : [],
    });
    if (unresolvedCount > 0) {
      showUnresolvedSelectionToast(unresolvedCount);
      return;
    }
    const {
      messages: forwardable,
      skippedCount,
      nestedForwardCount,
      actionCardCount,
      systemMessageCount,
    } = getForwardableMessages(selected);
    if (skippedCount > 0 || forwardable.length === 0) {
      forwardToast.info(formatForwardSelectionBlockedMessage(formatMessage, {
        forwardableCount: forwardable.length,
        nestedForwardCount,
        actionCardCount,
        systemMessageCount,
      }));
      return;
    }
    setForwardComposer({
      messages: forwardable,
      skippedCount,
      nestedForwardCount,
    });
  };

  const copySelectedLinks = () => {
    if (!channel || !serverSlug) return;
    const { messages: selected, unresolvedCount } = gatherSelectedMessagesWithMeta({
      channelMessages: messagesBelongToChannel ? messages : [],
    });
    if (unresolvedCount > 0) {
      showUnresolvedSelectionToast(unresolvedCount);
      return;
    }
    const links = buildSelectedMessagePermalinks({ serverSlug, channel, messages: selected });
    void navigator.clipboard.writeText(links.join("\n")).then(() => {
      toast.success(formatCopyLinksToast(links.length, formatMessageRef.current), SELECTION_TOAST_OPTIONS);
    }).catch(() => {
      toast.error(formatMessageRef.current({ id: "message.chatPanel.clipboardBlocked" }), SELECTION_TOAST_OPTIONS);
    });
  };

  if (!channel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-black/40 font-display text-lg font-bold uppercase">
        <button onClick={onMobileBack} className="btn-brutal-sm p-1.5 mb-4 md:hidden">
          <ArrowLeft size={14} />
        </button>
        {formatMessage({ id: "message.chatPanel.selectChannel" })}
      </div>
    );
  }

  const isDM = channel.type === "dm";
  // Thread surfaces (rendered in /search col-3 as a "normal channel surface"
  // per SearchContentRoute simplification) use follow/unfollow semantics, not
  // join/leave — so the join CTA never applies and channel-management chrome
  // (Stop all agents / Edit / Leave / Members) is meaningless. Collapse all
  // those correlated booleans into a single discriminator (stdrc msg=71334a2d
  // 2026-05-27: "thread 显然不可以 join，应该就输入框"). Send may still fail
  // server-side if the user has not joined the parent channel; per stdrc that
  // is a separate problem already present in the regular chat entry.
  const isThread = channel.type === "thread";
  const isAgentDM = isDM && channel.peerType === "agent";
  const isUserDM = isDM && channel.peerType === "user";
  const dmAgent = isAgentDM && channel.peerId
    ? agents.find((agent) => agent.id === channel.peerId)
    : undefined;
  const dmAgentProfile = dmAgent
    ? resolveAgentDmProfileSource(dmAgent, channel)
    : null;
  const displayName = dmAgentProfile?.displayName
    ?? channel.peerDisplayName
    ?? channel.peerName
    ?? channel.name;
  const dmAvatarUrl = dmAgentProfile?.avatarUrl ?? channel.peerAvatarUrl ?? null;
  const isRegularChannel = !isDM;
  // Joinable = a surface whose membership is gated by join/leave. DM and thread
  // share the "implicitly composable" axis; only true regular channels have a
  // join CTA path and the management chrome that depends on `joined`.
  const isJoinableChannel = isRegularChannel && !isThread;
  const isAllChannel = isJoinableChannel && channel.name === "all";
  const hideAllChannelMembersButton = isAllChannel
    && currentServer?.role === "member"
    && currentServer.hideHumansFromMembers;
  const showChannelSearchButton = isJoinableChannel;
  const isArchived = !!channel.archivedAt;
  const isJointChannelFeatureLocked = channel.type === "joint" && channel.jointBillingLocked === true;
  // `joined` is tri-state: `true` (member), `false` (not member), `undefined`
  // (membership not yet hydrated). The bottom CTA must distinguish these:
  // joined → composer, not joined → Join CTA, unknown → render nothing so we
  // don't flash a wrong CTA during first-paint hydration. Before PR #1549 the
  // hydration path always came from `/channels` list (joined populated); after
  // #1549, `ChannelRoute` may hit `/channels/:id` first, which historically
  // omitted `joined`. The server-side fix in this PR now backfills it, but the
  // tri-state guard below pins the contract so any future hydration path that
  // forgets `joined` degrades to a hidden CTA (not a wrong CTA).
  // #engineering:e4f52605 / @xxchan / @哭哭 / @Leiysky.
  // DMs and threads are forced to `true` because their composability doesn't
  // depend on a join relation.
  const joined: boolean | undefined = isDM || isThread ? true : channel.joined;
  const isGuestReadOnlyChannel = isJoinableChannel
    && currentServer?.role === "guest"
    && joined === false
    && channel.guestJoinable !== true;
  const canLeaveChannel = !isAllChannel;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: behavior tests pin owner/member/#all/unjoined visibility; equivalent guard mutants time out under instrumented ChatPanel rendering.
  const showChannelOptionsButton = joined === true && (canManageChannels || canLeaveChannel);
  const selectModeScopedHere = selectModeActive && selectModeChannelId === channel.id;
  const channelHeaderIcon = isRegularChannel ? <ChannelKindIcon type={channel.type} /> : undefined;
  const channelSubtitle =
    isRegularChannel
      ? channel.description || undefined
      : undefined;
  const regularTitleSuffix = isRegularChannel && (isArchived || activityMuted) ? (
    <div className="flex items-center gap-1.5">
      {isArchived && (
        <span className="inline-flex shrink-0 items-center border-2 border-black bg-brutal-orange/30 px-1.5 py-1 text-[11px] font-bold uppercase tracking-wide leading-none">
          {formatMessage({ id: "message.chatPanel.archived" })}
        </span>
      )}
      {activityMuted && <ActivityMutedBadge />}
    </div>
  ) : undefined;
  const activityMuteButton = activityMuteSupported ? (
    <ActivityMuteToggleButton
      activityMuted={activityMuted}
      disabled={activityMuteLoading || activityMuteSaving}
      onToggle={handleToggleActivityMute}
      dm={isDM}
    />
  ) : null;

  const bottomButtonCount = hasNewer ? currentUnreadCount : newMessageCount;
  const showBottomButton = hasNewer || !atBottom || newMessageCount > 0;
  const handleBottomButton = hasNewer ? handleBackToBottom : scrollToBottom;
  const handleSearchThisChannel = (searchChannelId: string) => {
    if (onSearchChannel) onSearchChannel(searchChannelId);
    else nav.toSearch(undefined, { channelId: searchChannelId, deferUntilQuery: true });
  };
  // task #187 `topbar_overflow_v0`: on regular channels settings/member
  // actions collapse into a 「Settings」 overflow drawer while Search remains
  // a sibling topbar action. DMs and thread-type
  // channels keep the legacy row — the redesign scope is channel/thread
  // top bars only. Flag off = byte-identical legacy actions.
  const channelHeaderActions = topbarOverflow.enabled && isJoinableChannel ? (
    <ChannelOverflowMenu
      channelId={channel.id}
      channelName={channel.name}
      open={overflowOpen}
      onOpenChange={setOverflowOpen}
      onSearch={() => handleSearchThisChannel(channel.id)}
      activityMute={activityMuteSupported ? {
        muted: activityMuted,
        busy: activityMuteLoading || activityMuteSaving,
        onToggle: () => void handleToggleActivityMute(),
      } : undefined}
      collapseLongMessages={topbarOverflow.enabled && activityMuteSupported ? {
        enabled: channelCollapseLongMessages,
        busy: messageDisplayPrefsLoading || messageDisplayPrefsSaving,
        onToggle: () => void handleToggleCollapseLongMessages(),
      } : undefined}
      showMembers={!hideAllChannelMembersButton}
      members={{
        agents: mentionChannelAgents,
        humans: mentionChannelHumans,
        externalMembers: mentionChannelExternalMembers,
        loading: mentionMembersLoading,
        addMembers: addMentionChannelMembers,
        addAgent: addMentionChannelAgent,
        removeAgent: removeMentionChannelAgent,
        addHuman: addMentionChannelHuman,
        removeHuman: removeMentionChannelHuman,
        changeMemberRole: changeMentionChannelMemberRole,
        roleChangeFailed: mentionRoleChangeFailed,
      }}
      settings={showChannelOptionsButton ? {
        initialName: channel.name,
        initialDescription: channel.description || "",
        onLeaveChannel: canLeaveChannel ? () => leaveChannel(channel.id) : undefined,
      } : undefined}
      onStopAllAgents={joined && canManageAgents ? () => setShowSOSDialog(true) : undefined}
    />
  ) : (activityMuteSupported || isJoinableChannel) ? (
    <>
      {showChannelSearchButton && (
        <Button
          onClick={() => handleSearchThisChannel(channel.id)}
          shape="icon"
          title={formatMessage({ id: "message.chatPanel.searchChannel" })}
          aria-label={formatMessage({ id: "message.chatPanel.searchChannel" })}
        >
          <Search size={14} />
        </Button>
      )}
      {activityMuteButton}
      {isJoinableChannel && (
        <>
          {joined && canManageAgents && (
            <Button
              onClick={() => setShowSOSDialog(true)}
              shape="icon"
              title={formatMessage({ id: "message.chatPanel.stopAllAgents" })}
            >
              <Square size={14} />
            </Button>
          )}
          {showChannelOptionsButton && (
            <Button
              onClick={() => setShowEditDialog(true)}
              shape="icon"
              title={canManageChannels ? formatMessage({ id: "message.chatPanel.editChannel" }) : formatMessage({ id: "message.chatPanel.channelOptions" })}
              aria-label={canManageChannels ? formatMessage({ id: "message.chatPanel.editChannel" }) : formatMessage({ id: "message.chatPanel.channelOptions" })}
            >
              <Settings size={14} />
            </Button>
          )}
          {!hideAllChannelMembersButton && <ChannelMembers channelId={channel.id} />}
        </>
      )}
    </>
  ) : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Header — hidden when embedded in detail panels.
          DMs use titleSlot because the avatar is an interactive profile
          trigger. Regular channels use PanelHeader's native title/subtitle
          stack so the title never competes with long descriptions. */}
      {!hideHeader && (
      <PanelHeader
        onMobileBack={onMobileBack}
        mobileBackProps={{ "data-testid": "chat-mobile-back" }}
        icon={channelHeaderIcon}
        iconAlwaysVisible={isRegularChannel}
        title={isRegularChannel ? channel.name : undefined}
        titleSuffix={regularTitleSuffix}
        subtitle={channelSubtitle}
        titleSlot={
          isAgentDM ? (
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => channel.peerId && useProfileStore.getState().openProfile("agent", channel.peerId, { openSource: "channel" })}
                className="shrink-0 hover:brightness-90 transition-colors"
              >
                <AvatarSlot context="panel-header" type="agent" agentAvatarUrl={dmAvatarUrl} />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate font-bold text-black text-base leading-tight" title={displayName}>{displayName}</span>
                {channel.peerId && <AgentDMStatus agentId={channel.peerId} />}
                {activityMuted && <ActivityMutedBadge />}
              </div>
            </div>
          ) : isUserDM ? (
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => channel.peerId && useProfileStore.getState().openProfile("human", channel.peerId, { openSource: "channel" })}
                className="shrink-0 hover:brightness-90 transition-colors"
              >
                <AvatarSlot
                  context="panel-header"
                  type="human"
                  humanAvatarUrl={dmAvatarUrl}
                  gravatarHash={channel.peerGravatarHash ?? null}
                  humanPlaceholder={!dmAvatarUrl && !channel.peerGravatarHash}
                />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate font-bold text-black text-base leading-tight" title={displayName}>{displayName}</span>
                {activityMuted && <ActivityMutedBadge />}
              </div>
            </div>
          ) : undefined
        }
        actions={channelHeaderActions}
      />
      )}
      {hideHeader && headerActionsHost && channelHeaderActions
        ? createPortal(
            <div className="workspace-grid-tabset-actions" data-testid="workspace-tabset-context-actions">
              {channelHeaderActions}
            </div>,
            headerActionsHost,
          )
        : null}

      {!hideHeader && activityMuteError && (
        <div
          className="flex items-center justify-between gap-3 border-b-2 border-black bg-brutal-orange/20 px-5 py-2 text-xs font-bold text-black"
          role="alert"
          data-testid="activity-mute-error"
        >
          <span>{formatMessage({ id: activityMuteError })}</span>
          <button
            type="button"
            className="btn-brutal-sm inline-flex size-6 shrink-0 items-center justify-center bg-white"
            aria-label={formatMessage({ id: "message.chatPanel.dismissActivityMuteError" })}
            onClick={() => setActivityMuteError(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {!hideHeader && messageDisplayPrefsError && (
        <div
          className="flex items-center justify-between gap-3 border-b-2 border-black bg-brutal-orange/20 px-5 py-2 text-xs font-bold text-black"
          role="alert"
          data-testid="message-display-prefs-error"
        >
          <span>{formatMessage({ id: messageDisplayPrefsError })}</span>
          <button
            type="button"
            className="btn-brutal-sm inline-flex size-6 shrink-0 items-center justify-center bg-white"
            aria-label={formatMessage({ id: "message.chatPanel.dismissMessageDisplayPrefsError" })}
            onClick={() => setMessageDisplayPrefsError(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Chat/Tasks tab bar — hidden when there's only one tab (e.g. thread
          surface only has Chat) to avoid an empty-looking single-tab strip. */}
      {showPanelTabs && (
        <Tabs<ChatPanelTab> value={activeTab} onValueChange={setActiveTab} className="overflow-hidden border-b-2 border-black bg-white">
          <SortableTabsList<ChatPanelTab>
            value={visibleTabIds}
            onReorder={reorderTabs}
            className="max-w-none border-y-0 border-l-0 border-r-2 border-black bg-white"
          >
            {visibleTabButtons}
          </SortableTabsList>
        </Tabs>
      )}

      {/* Channel tasks reuse the server-wide board/list surface. */}
      {activeTab === "tasks" ? (
        <TasksPanel channelId={channel.id} />
      ) : activeTab === "files" ? (
        <ChannelFilesPanel channel={channel} />
      ) : (
        <>
          {/* Messages — virtualized.
              stdrc 2026-05-02 #proj-uiux:95e25b5b e33f2924: main panel
              整个 white 底，messages scroller 也跟上。bg-white 让整个
              主聊天列从 header 到 composer 全白。 */}
          <div className="relative flex-1 overflow-hidden bg-white">
            {loading && !shouldShowMessageTimeline ? (
              <div className="flex-1 flex items-center justify-center py-4">
                <div className="text-center text-black/40 font-mono text-sm">{formatMessage({ id: "message.chatPanel.loading" })}</div>
              </div>
            ) : !shouldShowMessageTimeline ? (
              <EmptyState
                className="flex h-full flex-col items-center justify-center"
                icon={<MessageSquare size={36} />}
                title={formatMessage({ id: "message.chatPanel.noMessagesTitle" })}
                description={formatMessage({ id: "message.chatPanel.noMessagesDescription" })}
              />
            ) : (
              <MessageTimeline
                key={channel.id}
                ref={timelineRef}
                source={messageSource}
                renderItem={renderChannelItem}
                header={channelHeader}
                footer={channelFooter}
                onAtBottomChange={handleAtBottomStateChange}
                onVisibleMessageWindowChange={setTranslationWindowIds}
                persistKey={`channel:${channel.id}`}
                className="h-full"
                sparseAnchor="bottom"
              />
            )}
            {showBottomButton && (
              <button
                onClick={handleBottomButton}
                className="btn-brutal-sm absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-white px-3 py-1.5 text-xs font-bold z-10"
              >
                <ArrowDown size={12} />
                {bottomButtonCount > 0
                  ? formatMessage({ id: "message.chatPanel.newMessagesCount" }, { count: bottomButtonCount })
                  : formatMessage({ id: "message.chatPanel.backToBottom" })}
              </button>
            )}
          </div>

          {/* Input or Join bar */}
          {showComposer ? (
            <div
              className={overlayComposer ? "absolute inset-x-0 bottom-0 z-20 bg-white shadow-brutal" : "contents"}
              data-testid={workspaceComposer ? "workspace-panel-composer" : undefined}
            >
          {readOnly ? (
            <div className="border-t-2 border-black bg-white px-4 py-3">
              <div className="input-brutal flex items-center px-3 py-2 opacity-50 cursor-not-allowed">
                <span className="text-sm text-black/40">{formatMessage({ id: "message.chatPanel.unavailable" })}</span>
              </div>
            </div>
          ) : isArchived ? (
            <div className="flex items-center border-t-2 border-black bg-brutal-orange/20 p-3">
              <div className="flex w-full items-center justify-center gap-2 text-sm font-bold text-black">
                {formatMessage({ id: "message.chatPanel.archivedNotice" })}
                {effectiveChannelCapabilities.archiveChannels && (
                  <button
                    onClick={() => topbarOverflow.enabled ? setOverflowOpen(true) : setShowEditDialog(true)}
                    className="font-bold text-black underline"
                  >
                    {formatMessage({ id: "message.chatPanel.unarchive" })}
                  </button>
                )}
              </div>
            </div>
          ) : isJointChannelFeatureLocked ? (
            <div className="border-t-2 border-black bg-white p-3">
              <Banner intent="warning" className="justify-center text-center font-bold">
                {formatMessage({ id: "message.chatPanel.jointLocked" })}
                <button
                  onClick={() => nav.toSettings("billing")}
                  className="font-bold text-black underline"
                >
                  {formatMessage({ id: "message.chatPanel.viewBilling" })}
                </button>
              </Banner>
            </div>
          ) : isReadOnlyByQuota ? (
            <div className="border-t-2 border-black bg-white p-3">
              <Banner intent="warning" className="justify-center text-center font-bold">
                {formatMessage({ id: "message.chatPanel.readOnlyQuota" }, { plan: PLAN_CONFIG[plan].displayName })}{" "}
                <button
                  onClick={() => nav.toSettings("billing")}
                  className="font-bold text-black underline"
                >
                  {formatMessage({ id: "message.chatPanel.upgradeForMoreChannels" })}
                </button>
              </Banner>
            </div>
          ) : isGuestReadOnlyChannel ? (
            <div className="border-t-2 border-black bg-white p-3" data-testid="guest-readonly-channel-banner">
              <Banner intent="warning" className="justify-center text-center font-bold">
                {formatMessage({ id: "message.chatPanel.guestReadOnlyChannel" })}
              </Banner>
            </div>
          ) : joined === true ? (
            selectModeScopedHere ? (
              <SelectModeToolbar
                channelId={channel.id}
                capturing={picCapturing}
                copied={copiedMd}
                onForward={showForwardAction ? openForwardComposer : undefined}
                onCopyLinks={copySelectedLinks}
                onSavePic={onSavePic}
                onShareX={onShareX}
                onCopyMd={onCopyMd}
              />
            ) : (
              <>
                <MessageInput
                  channelId={channel.id}
                  channelName={isDM ? `@${displayName}` : `#${channel.name}`}
                  showTaskButton={supportsChannelTasks}
                  autoFocus={composerAutoFocus}
                  onWillSend={handleWillSend}
                  activationBanner={primaryComposerEligible && isMobileComposer
                    ? <NotificationActivationBanner placement="mobile" />
                    : undefined}
                />
                {primaryComposerEligible && !isMobileComposer ? (
                  <NotificationActivationBanner placement="desktop" />
                ) : null}
              </>
            )
          ) : joined === false
            && (currentServer?.role !== "guest" || channel.guestJoinable === true) ? (
            <div className="flex items-center border-t-2 border-black bg-white p-3">
              <button
                onClick={() => joinChannel(channel.id)}
                className="btn-brutal flex w-full items-center justify-center gap-1.5 bg-brutal-pink px-3 py-1.5 text-sm font-bold"
              >
                <LogIn size={14} />
                {formatMessage({ id: "message.chatPanel.joinChannel" }, { channel: channel.name })}
              </button>
            </div>
          ) : null}
            </div>
          ) : null}
        </>
      )}

      {messageForwardingEnabled && forwardComposer && (
        <Suspense fallback={null}>
          <ForwardComposerDialog
            sourceMessages={forwardComposer.messages}
            sourceChannel={channel}
            channelActivity={useChannelStore.getState().channelActivity}
            skippedCount={forwardComposer.skippedCount}
            nestedForwardCount={forwardComposer.nestedForwardCount}
            onClose={closeForwardComposer}
            onSent={handleForwardSent}
          />
        </Suspense>
      )}

      {showEditDialog && isRegularChannel && (
        <EditChannelDialog
          channelId={channel.id}
          initialName={channel.name}
          initialDescription={channel.description || ""}
          onLeaveChannel={canLeaveChannel ? () => leaveChannel(channel.id) : undefined}
          onClose={() => setShowEditDialog(false)}
          collapseLongMessages={topbarOverflow.enabled && activityMuteSupported ? {
            enabled: channelCollapseLongMessages,
            busy: messageDisplayPrefsLoading || messageDisplayPrefsSaving,
            onToggle: () => void handleToggleCollapseLongMessages(),
          } : undefined}
        />
      )}

      {showSOSDialog && (
        <SOSDialog
          channelId={channel.id}
          channelName={channel.name}
          onClose={() => setShowSOSDialog(false)}
        />
      )}

      {picPreview && (
        <SelectShareLightbox
          dataUrl={picPreview}
          filename={`slock-${channel.name || "export"}-${new Date().toISOString().slice(0, 10)}.png`}
          onClose={() => setPicPreview(null)}
          onShareToX={onSharePreviewToX}
          onSaved={() => {
            setPicPreview(null);
            useSelectionStore.getState().exit();
          }}
        />
      )}

      {picError && (
        <div
          role="alert"
          className="fixed bottom-20 left-1/2 z-[110] -translate-x-1/2 border-2 border-black bg-brutal-orange px-3 py-2 text-xs font-bold shadow-brutal-sm"
          onClick={() => setPicError(null)}
          data-testid="select-share-error"
        >
          {formatMessage({ id: "message.chatPanel.imageActionFailed" }, { error: picError })}
        </div>
      )}

    </div>
  );
}
