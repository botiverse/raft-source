import { deferredDialog, deferredPanel } from "../../boot/deferredUi";
import { PanelLoading } from "../../components/layout/PanelLoading";
import { COMPOSER_EDGE_CLASS, composerHostClassName, END_FADE_ABOVE_COMPOSER, TIMELINE_END_ABOVE_COMPOSER, TIMELINE_START_ABOVE_ROW, TIMELINE_ROW_INSET } from "../../components/message/composerHost";
import CloseButton from "../../components/ui/CloseButton";
import { Suspense, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useMemo, useCallback } from "react";
import type { ComponentType, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Paperclip, ListTodo, ArrowDown, X } from "lucide-react";
import { useChannelHeadToggles } from "./useChannelHeadToggles";
import { ChatPanelNoChannel } from "./ChatPanelNoChannel";
import {
  Badge,
  ConversationPanelBody,
  ConversationPanelContent,
  ConversationPanelFooter,
  ConversationPanelRoot,
  ConversationPanelTabs,
  PanelTitle,
  SortableTabsList,
  SortableTabsTab,
  Tabs,
  TabsLabel,
  toast,
  useOrderedTabs,
  Button,
  MessageListEndFade,
  PanelNotice,
  PanelNoticeActions,
  PanelNoticeContent,
  TextLink,
  useLocated,
  ScrollArea,
} from "@botiverse/raft-ui";
import { MessageIcon, JoinChannelIcon } from "@botiverse/ricons";
import { MessageListJumpPill } from "@botiverse/raft-ui/wip";
import SOSDialog from "../../components/message/SOSDialog";
import { LoungeUnarchiveAction } from "./LoungeUnarchiveAction";
import ChannelTasksPanel from "../../components/task/ChannelTasksPanel";
import { useChannelSideCardStore } from "../../store/channelSideCardStore";
import { trackChannelTabSelected } from "../../analytics/entries";
import type { ChannelSideCard } from "../../store/channelSideCardStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { LoungeAvatar } from "../../components/agent/LoungeAvatar";
import type { Channel } from "../../store/channelStore";
import { slackSyncHeaderState } from "../../components/channel/slackSyncHeaderState";
import { canToggleActivityMute, matchesActivityMuteState, matchesMessageDisplayPrefsState } from "../../store/channelDomain";
import {
  CONTEXT_BEYOND_HISTORY_ERROR,
  CONTEXT_NOT_FOUND_ERROR,
  selectChannelMessageBucket,
  selectChannelWindowMeta,
  useMessageStore,
} from "../../store/messageStore";
import type {
  Message,
} from "../../store/messageStore";
import { isRemovedAppBot, useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { PLAN_CONFIG, getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { CHAT_TAB_QUERY_PARAM, useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import { useContentSlotBack } from "../../components/layout/contentSlotBack";
import { useConversationSearchParams } from "./useConversationSearchParams";
import { useRetireJump } from "../../hooks/useRetireJump";
import { findLocatedMessageRow, useKeyboardJumpFocus } from "../../hooks/useKeyboardJumpFocus";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useChannelFirstPageSettled } from "../../hooks/useChannelFirstPageSettled";
import { useJoinDeferred } from "../../store/joinDeferred";
import { rosterHumanAsMember } from "../../utils/rosterHumanAsMember";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import Tooltip from "../../components/ui/Tooltip";
import AppBadge from "../../components/agent/AppBadge";
import { useThreadStore } from "../../store/threadStore";
import { useForumTimeline } from "./useForumTimeline";
import { ChannelForumOrderBadge } from "../../components/channel/ChannelForumOrderBadge";
import { useUIStore } from "../../store/uiStore";
import { ThreadUnreadJumpPill } from "../../components/message/ThreadUnreadJumpPill";
import { useVisibleMessageWindowStore, VisibleMessageTranslations } from "../../components/message/VisibleMessageTranslations";
import type { OpenThreadRequest } from "../../store/threadStore";
import Banner from "../../components/ui/Banner";
import HistoryLimitBanner from "../../components/message/HistoryLimitBanner";
import HistoryPaywall from "../../components/message/HistoryPaywall";
import { historyPaywallPlace } from "../../components/message/historyPaywallLabels";
import { useHiddenTarget } from "../../store/hiddenHistoryStore";
import { showToast } from "../../components/toastBridge";
import { useProfileStore } from "../../store/profileStore";
import MessageItem, { buildMentionMap } from "../../components/message/MessageItem";
import HistoryTopState from "../../components/message/HistoryTopState";
import { MessageInput } from "../composer/MessageInput";
import type { ComposerReference } from "../composer/composerTypes";
import MessageTimeline from "../../components/message/MessageTimeline";
import type {
  MessageTimelineHandle,
  MessageTimelineLeadingRow,
  MessageTimelineSource,
} from "../../components/message/MessageTimeline";
import { useToastViewportFloor } from "../../components/toastViewportBottom";
import SelectModeToolbar, { SELECT_MODE_LIST_RESERVE_CLASS, SelectModeListEnd, useExitSelectionReturningFocus } from "../../components/message/SelectModeToolbar";
import { SelectShareLightbox } from "../../components/message/DeferredSelectShareLightbox";
import type { ValidatedScreenshot } from "../../utils/screenshotBudget";
import { buildSelectedMessagePermalinks, formatCopyLinksToast, formatForwardSelectionBlockedMessage, forwardAvailability, getForwardableMessages } from "../../components/message/forwardSelectionUtils";
import { forwardToast } from "../../components/message/forwardToast";
import { MessageForwardContext } from "../../components/message/messageForwardContext";
import { useSelectionStore } from "../../store/selectionStore";
import { MessageSelectIntentProvider } from "../../components/message/MessageSelectIntentProvider";
import { useSelectToHere } from "../../components/message/useSelectToHere";
import { BottomJumpControls } from "../../components/message/BottomJumpControls";
import { gatherSelectedMessagesWithMeta, useSelectionShareHandlers } from "../../components/message/useSelectionShareHandlers";
import { useSelectShareErrorToast } from "../../components/message/useSelectShareErrorToast";
import ChannelOverflowMenu from "../../components/channel/ChannelOverflowMenu";
import { prepareChannelDetailsOpen } from "../../components/channel/channelDetails";
import { RowExpandAction } from "../../components/layout/RowExpandAction";
import PanelHeader from "../../components/ui/PanelHeader";
import EmptyState from "../../components/ui/EmptyState";
import { useLocation } from "react-router-dom";
import MessageLinkUnavailable from "../../components/deeplinks/MessageLinkUnavailable";
import { OpenInAppRowSlot } from "../../components/deeplinks/OpenInAppRowSlot";
import { ChannelAnnouncementStrip } from "../../components/channel/ChannelAnnouncementStrip";
import { CHANNEL_ANNOUNCEMENT_ROW_ID } from "../../components/channel/channelAnnouncementParts";
import { useChannelAnnouncement } from "../../store/channelAnnouncementStore";
import { conversationPathOf, useLandedMessageLink } from "../../components/deeplinks/deepLinksFlag";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import { selectChannelTaskBucket, useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
import { isTaskV2Task } from "../../utils/taskConversation";
import ChannelFilesCard from "../../components/message/ChannelFilesCard";
import { ChannelFilesPanel } from "../../components/message/DeferredChannelFilesPanel";
import { TASK_V2_CONVERSATIONS_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { activeAreaSection, ChannelSideFloatSlot, SideArtifactPortal, SideSectionPortal, useSideSections } from "../../components/task/ChannelSideArea";
import type { SideAreaArtifact } from "../../components/task/ChannelSideArea";
import { getHistoryTopState, historyBoundaryVariant } from "../../utils/historyTopState";
import { touchDragRegion } from "../../utils/touchDragRegion";
import { useShortcut } from "../shortcuts/useShortcut";
import ThreadPanelSystemMessageGroupDisclosure from "../../components/message/ThreadPanelSystemMessageGroupDisclosure";
import { buildSystemMessageRenderStates, foldedSystemMessageIds } from "../../components/message/systemMessageGrouping";
import { followedByFor, useStableMessageGrouping } from "../../components/message/messageGrouping";
import { DateDivider } from "../../components/message/DateDivider";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import api from "../../api/client";
import { useAttachmentPreviewGate } from "../../store/attachmentPreviewGate";
import { useReadReceiptHydrate } from "../../hooks/useReadReceiptHydrate";
import { useAgentReadProgress } from "../../hooks/useAgentReadProgress";
import { AgentReadProgressContext } from "../../components/message/agentReadProgressContext";
import { AgentReadSystemRow } from "../../components/message/AgentReadFaces";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useArtifactClosed, useArtifactHeaderBack, useArtifactHost, useArtifactSideCard } from "../../apps/artifacts";
import { useArtifactPlaceCard } from "../webPreview/useArtifactPlaceCard";
import { WEB_PREVIEW_HOST_ATTRIBUTE } from "../webPreview/webPreviewStore";
import { installArtifactShareHost } from "../../components/message/artifactShareHost";
import { installArtifactAttachmentSavedStandIn } from "../../components/message/artifactAttachmentSaved";
import { installArtifactSessionScope } from "../../components/message/artifactSessionScope";
import NotificationActivationBanner, {
  isNotificationActivationComposerEligible,
} from "../../components/message/NotificationActivationBanner";
import type { ForwardDelivery } from "../../components/message/ForwardComposerDialog";
import type { TasksPanelProps } from "../../components/task/TasksPanel";
import { resolveAgentDmProfileSource } from "../../components/layout/agentDmProfileSource";
import { resolveDmPeerAvatarFromDirectory } from "../../components/layout/dmPeerAvatar";
import HostedCindyFailedBanner from "../../components/agent/HostedCindyFailedBanner";
import { AgentTypingLine, AgentTypingListEnd, END_FADE_UNDER_AGENT_TYPING_LINE_CLASS } from "../../components/message/AgentTypingLine";
import { AgentContextViewSectionSlot } from "../../components/agentContextView/AgentContextViewSlots";
import { useAgentSideSectionOpen } from "../../components/agent/agentSideSectionOpen";
import { isJointChannelReadOnly, jointChannelGraceEndsAt, useRerenderAtJointDeadline } from "../../utils/jointChannelLimit";
import { ChannelLimitLockedBanner, ExternalFreezeNotice } from "./ChannelLimitBanners";
import { openChannelWindow, openLatestChannelWindow } from "../../store/channelWindowOpen";
import { MessagesLoading } from "../../boot/bootSkeletons";
import { useChatPanelViewSwitch } from "./useChatPanelViewSwitch";
import { AssistantPausedNotice } from "../../assistant/AssistantPaused";
import { AssistantOtterAnchor } from "../../assistant/AssistantOtter";
import RemovedAppBotDmNotice from "../../components/message/RemovedAppBotDmNotice";
import { agentOffersLounge, useAgentLoungeEnabled, useLoungeAgentName, useOpenAgentLounge } from "../../components/agent/agentLounge";
import ReadOnlyComposer from "../../components/message/ReadOnlyComposer";
import AgentActivitySubscription from "../../components/agent/AgentActivitySubscription";
import { ChatPanelMessageRenderScope } from "./ChatPanelMessageRenderScope";
import { normalizeActivityMuteSettings, normalizeMessageDisplaySettings, resolveChatPanelQueryFocusMessageId, WORKING_ID_SEPARATOR } from "./chatPanelHelpers";
import { ActivityMutedBadge } from "./ActivityMutedBadge";
import { ChannelSlackSyncBadge } from "./ChannelSlackSyncBadge";
import { AgentDMStatus } from "./AgentDMStatus";
import ChannelDescription from "../../components/channel/ChannelDescription";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";

const ForwardComposerDialog = deferredDialog(() => import("../../components/message/ForwardComposerDialog"));
const TasksPanel = deferredPanel<TasksPanelProps>(() => import("../../components/task/TasksPanel"));
// Workspace Artifacts' "Send to conversation" lists this server's conversations through core (S5).
installArtifactShareHost();
installArtifactAttachmentSavedStandIn();
installArtifactSessionScope();

// Stable empty-prop bag for the mobile back button (task #709).
const CHAT_MOBILE_BACK_PROPS = { "data-testid": "chat-mobile-back" } as const;

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
type PanelTabItem<T extends string> = {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
};

export function ChatPanel({
  channel,
  hideHeader,
  readOnly,
  // Stryker disable all: host defaults are exercised by browser smoke.
  showComposer = true,
  allowTasks = true,
  overlayComposer = false,
  composerAutoFocus = true,
  // Stryker restore all
  composerReference,
  ownsUrl = true,
  onOpenThread,
  onOpenProfile,
  onSearchChannel,
}: {
  channel: Channel | null;
  hideHeader?: boolean;
  readOnly?: boolean;
  showComposer?: boolean;
  /** False where tasks don't apply (the personal assistant's DM): no As Task in the composer. */
  allowTasks?: boolean;
  overlayComposer?: boolean;
  composerAutoFocus?: boolean;
  /** Rides on the next message sent from the composer (the personal assistant's context chip). */
  composerReference?: ComposerReference | null;
  /**
   * False where this conversation is not the page's (the assistant's DM in
   * the otter's popover over a channel): the page URL's `msg`, `thread` and
   * tab are that page's, so this panel neither reads nor writes them.
   */
  ownsUrl?: boolean;
  onOpenThread?: (request: OpenThreadRequest) => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  onSearchChannel?: (channelId: string) => void;
}) {
  // A toast sits above this panel's footer: the composer or the bar in its place (toastViewportBottom.ts).
  const toastFloorRef = useToastViewportFloor();
  const { formatMessage, formatDate } = useIntl();
  // Task v2 moves Tasks and Files out of the tab row into cards opened from
  // the header; without the flag the three tabs stay exactly as they were.
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const chatPanelTabs = useMemo<PanelTabItem<ChatPanelTab>[]>(() => taskV2
    ? [
      { id: "chat", icon: MessageIcon, label: formatMessage({ id: "message.chatPanel.tabChat" }) },
    ]
    : [
      { id: "chat", icon: MessageIcon, label: formatMessage({ id: "message.chatPanel.tabChat" }) },
      { id: "tasks", icon: ListTodo, label: formatMessage({ id: "message.chatPanel.tabTasks" }) },
      { id: "files", icon: Paperclip, label: formatMessage({ id: "message.chatPanel.tabFiles" }) },
    ], [formatMessage, taskV2]);
  // Keep locale-bound formatMessage out of effect/handler deps: effects that
  // load activity-mute state or reset selection must NOT re-run on a language
  // switch (that would clobber in-flight state). Render + the tab-label memo use
  // formatMessage directly; effects/handlers read formatMessageRef.current.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const channelId = channel?.id ?? null;
  // Members, notification settings, read receipts: after the first page (task #17), and after a join's idle (joinDeferred).
  const channelFirstPageSettled = useChannelFirstPageSettled(channelId);
  const joinDeferred = useJoinDeferred(channelId);
  useReadReceiptHydrate(channelFirstPageSettled ? channel : null);
  const messageRenderScope = useContext(ChatPanelMessageRenderScope);
  const seqMessages = useMessageStore((s) => selectChannelMessageBucket(s, channelId));
  const channelWindowMeta = useMessageStore((s) => selectChannelWindowMeta(s, channelId));
  const { loadingNewer, hasNewer, contextLoadError } = channelWindowMeta;
  // Forum-style channels (#proj-chat:#24): useForumTimeline.ts.
  const { forumChannel, forumMode, messages, hasMore, historyLimited, loading, loadingOlder, loadOlderActivity } = useForumTimeline(channel, seqMessages, channelWindowMeta);
  const messagesBelongToChannel = !!channelId;
  const shouldShowMessageTimeline = messages.length > 0;
  // The timeline's visible window feeds translation through a store read by
  // <VisibleMessageTranslations>, so scrolling never re-renders this panel.
  const translationWindow = useVisibleMessageWindowStore();
  const loadMessageContext = useMessageStore((s) => s.loadMessageContext);
  const loadOlderMessages = useMessageStore((s) => s.loadOlderMessages);
  const loadNewerMessages = useMessageStore((s) => s.loadNewerMessages);
  const highlightedMessageId = useMessageStore((s) => s.highlightedMessageId);
  const highlightNonce = useMessageStore((s) => s.highlightNonce);
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
  // Where the history paywall is: its scope and channel name (historyPaywallLabels.ts).
  const { scope: historyPaywallScope, channelName: historyPaywallChannel } = historyPaywallPlace(channel);
  // A jump's target behind the window (the context route's history_limited
  // answer): the paywall centers on it, at the top of the list (task #8).
  const hiddenTarget = useHiddenTarget(channelId);
  const showsHiddenTarget = contextLoadError === CONTEXT_BEYOND_HISTORY_ERROR && hiddenTarget !== null;
  const openHiddenTargetReplies = useCallback(() => {
    if (!channelId || !hiddenTarget) return;
    void useThreadStore.getState().openThread({ parentChannelId: channelId, parentMessageId: hiddenTarget.target.id });
  }, [channelId, hiddenTarget]);
  // A jump to a message that is not there (or not for this reader): say so
  // where it is seen, not in a notice at the top of a list scrolled to the
  // bottom. Once per jump: the store's flag is taken here.
  const pendingNotFoundToast = useMessageStore((s) => s.pendingNotFoundToast);
  // Deep links v1 (item d): a message link this page landed on whose message
  // can't be shown gets the shared "Message not found" state in place of the
  // list, the same words for deleted and not-yours, instead of the toast over
  // the newest messages. Moving around inside the app keeps the toast.
  const location = useLocation();
  const landedLink = useLandedMessageLink(location.pathname, location.search);
  const landedLinkTarget = landedLink.enabled && landedLink.target?.channelId === channelId ? landedLink.target : null;
  // Only the server's final answer (400/403/404); a failed read (5xx,
  // offline) keeps the toast and the newest messages, as before.
  const showLinkUnavailable = landedLinkTarget !== null && contextLoadError === CONTEXT_NOT_FOUND_ERROR;
  // Until the landed link's message is found or ruled out, hold the list
  // back, so a not-found link doesn't flash the newest messages first. A
  // thread link focuses in its thread, not here. Never longer than 5s.
  const landedFocusId = landedLinkTarget && !landedLinkTarget.thread ? landedLinkTarget.messageId : null;
  const threadFocusedMessageId = useThreadStore((s) => s.focusedMessageId);
  const landedSettledRef = useRef(false);
  if (
    landedFocusId === null
    || contextLoadError !== null
    // Any jump target located (a short-id link resolves to the full id).
    || highlightedMessageId !== null
    || (threadFocusedMessageId !== null && threadFocusedMessageId === landedFocusId)
  ) {
    landedSettledRef.current = true;
  }
  const [landedHoldExpired, setLandedHoldExpired] = useState(false);
  useEffect(() => {
    if (landedFocusId === null) return;
    const timer = setTimeout(() => setLandedHoldExpired(true), 5000);
    return () => clearTimeout(timer);
  }, [landedFocusId]);
  const holdForLandedLink = !landedSettledRef.current && !landedHoldExpired;
  useChatPanelViewSwitch(channelId, { unavailable: showLinkUnavailable, held: holdForLandedLink, loading, hasMessages: shouldShowMessageTimeline, forumMode });
  useEffect(() => {
    if (!pendingNotFoundToast || !useMessageStore.getState().pendingNotFoundToast) return;
    useMessageStore.setState({ pendingNotFoundToast: false });
    if (showLinkUnavailable) return;
    showToast({
      title: formatMessage({ id: "message.chatPanel.messageNotFound" }),
      description: formatMessage({ id: "message.chatPanel.messageNotFoundHint" }),
      type: "warning",
    });
  }, [pendingNotFoundToast, formatMessage, showLinkUnavailable]);
  // Upgraded while this channel was cut (server:plan-updated): the paywall
  // goes and the older messages load above, no reload (task #8, frame 12).
  const historyPlan = useServerStore((s) => s.billing?.plan || s.current?.plan);
  const reopenHistoryWindow = useMessageStore((s) => s.reopenHistoryWindow);
  useEffect(() => {
    if (!channelId || !historyPlan || historyPlan === "free") return;
    reopenHistoryWindow(channelId);
  }, [channelId, historyPlan, reopenHistoryWindow]);
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
  } = useChannelMembers(channel?.id ?? "", { enabled: channelFirstPageSettled && !joinDeferred });
  // A channel's agents (not a DM's, a thread's or a lounge's: those say only who is typing), for the line above the
  // composer that says who works here. A string key, so it re-filters only when the roster changes.
  const workingAgentIdKey = useMemo(
    () => channel && channel.type !== "dm" && channel.type !== "thread" && !channel.loungeAgentId ? mentionChannelAgents.map((agent) => agent.id).join(WORKING_ID_SEPARATOR) : undefined,
    [channel, mentionChannelAgents],
  );
  const joinChannel = useChannelStore((s) => s.joinChannel);
  const leaveChannel = useChannelStore((s) => s.leaveChannel);
  const setChannelActivityMuteState = useChannelStore((s) => s.setActivityMuteState);
  const setChannelMessageDisplayPrefsState = useChannelStore((s) => s.setMessageDisplayPrefsState);
  const currentServer = useServerStore((s) => s.current);
  const billing = useServerStore((s) => s.billing);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const serverSlug = currentServer?.slug;
  const routeMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  // Opened from Activity on a phone (pushed over its list): Back returns to that list. A Guest's channel is its
  // Home on a phone (isGuestHomePath): no Back, which would only lead back into it through the server's root.
  const contentSlotBack = useContentSlotBack();
  const channelMobileBack = contentSlotBack ?? (currentServer?.role === "guest" ? undefined : routeMobileBack);
  const nav = useAppNavigate();
  // oxlint-disable-next-line react-doctor/no-event-handler -- not an event: ownsUrl is fixed per host (the page's conversation, or the popover's DM) and only picks which params the panel reads.
  const [searchParams, setSearchParams] = useConversationSearchParams(ownsUrl);
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

  // Keyed on the server id: the server object is replaced on unrelated
  // updates, which used to re-fetch billing each time.
  const currentServerId = currentServer?.id ?? null;
  useEffect(() => {
    if (!currentServerId) return;
    void loadBilling();
  }, [currentServerId, loadBilling]);

  const activityMuteSupported =
    !!channelId &&
    canToggleActivityMute(channel ?? undefined);

  // Message display prefs are a per-user "my conversation" setting with a
  // WIDER type contract than Activity mute: the server accepts every
  // non-thread channel (DM included — only threads are rejected, they are
  // managed by the parent). Membership is still required for non-DM channels,
  // same as before; DMs are only ever visible to their participants.
  const messageDisplayPrefsSupported =
    !!channelId &&
    channel?.type !== "thread" &&
    (channel?.type === "dm" || channel?.joined === true);

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
    if (!channelFirstPageSettled || joinDeferred) return;
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
  }, [activityMuteSupported, channelFirstPageSettled, joinDeferred, channelId, setChannelActivityMuteState]);

  // External API synchronization for the selected conversation's collapse
  // preference (task #187 collapse-long-messages). Gated on the display-prefs
  // contract (messageDisplayPrefsSupported — DM included), which is wider
  // than the activity-mute effect above: only a DM with an App bot can be
  // muted, while every DM has display prefs (task #703).
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let canceled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setMessageDisplayPrefsError(null);

    if (!messageDisplayPrefsSupported || !channelId || joinDeferred) {
      // Held after a join: the toggle keeps what it showed until the load runs.
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      if (!joinDeferred) setMessageDisplayPrefsLoading(false);
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
  }, [messageDisplayPrefsSupported, joinDeferred, channelId, setChannelMessageDisplayPrefsState]);

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
  // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral,EqualityOperator: this only hides redundant one-tab chrome; tab behavior is covered by browser validation.
  const showPanelTabs = !hideHeader && visibleTabs.length > 1;
  // Stryker disable all: raft-ui tab child composition is visual wiring covered by browser validation, not by the focused mutation corpus.
  const visibleTabButtons = visibleTabs.map((tab) => {
    const Icon = tab.icon;
    return (
      <SortableTabsTab
        key={tab.id}
        value={tab.id}
        data-testid={`panel-tab-${tab.id}`}
      >
        <Icon />
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
  // A click on the header's Chat / Tasks / Files (without task v2).
  const selectHeaderTab = useCallback((tab: ChatPanelTab) => {
    trackChannelTabSelected(tab, "header_tabs", false);
    setActiveTab(tab);
  }, [setActiveTab]);
  // The archived banner opens the same settings drawer as the header.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const openOverflow = useCallback(() => {
    if (channel) prepareChannelDetailsOpen(channel.id);
    setOverflowOpen(true);
  }, [channel]);
  const openBillingSettings = useCallback(() => nav.toSettings("billing"), [nav]);
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
  // The latest-page load the last "Back to bottom" from a context window
  // started; the scroll to the bottom waits for it (handleBackToBottom).
  const bottomIntentRef = useRef<Promise<void> | null>(null);
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
  // Channel announcements (#proj-chat:#29, channel_announcement_v0): the strip
  // right above the timeline (not where the header is hidden: an embedded
  // conversation). Who may change it gets Announcement settings in its menu.
  const channelAnnouncement = useChannelAnnouncement(hideHeader || !channel ? null : channel.id, channel?.type);
  const canEditAnnouncement = Boolean(effectiveChannelCapabilities.editChannelMetadata) && !channel?.archivedAt;
  const openAnnouncementSettings = useCallback(() => {
    if (channel) prepareChannelDetailsOpen(channel.id);
    setOverflowOpen(true);
    // At its row: the details mount it on open.
    setTimeout(() => document.getElementById(CHANNEL_ANNOUNCEMENT_ROW_ID)?.scrollIntoView({ block: "nearest" }), 0);
  }, [channel]);
  const focusMessageId = queryFocusMessageId;
  // The channel-load effect below reads the URL-derived thread/focus values
  // through refs so a `thread=`-only URL change never appears in its
  // dependency list — thread navigation owns only the right panel and must not
  // retrigger channel loading. An actual `msg=` change still retriggers via
  // `rawQueryFocusMessageId`, which remains a dependency.
  const threadParamRef = useRef(threadParam);
  threadParamRef.current = threadParam;
  const focusMessageIdRef = useRef(focusMessageId);
  focusMessageIdRef.current = focusMessageId;

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
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!channelId) return;
    translationWindow.set([]);
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
    // Retrigger key for actual `msg=` changes; the value itself is read
    // through `focusMessageIdRef` so thread-only URL changes stay out of the
    // dependency list (see the comment above this effect).
    void rawQueryFocusMessageId;
    if (
      !threadParamRef.current &&
      !focusMessageIdRef.current &&
      pendingTransientFocus?.channelId === channelId &&
      pendingTransientFocus.nonce !== handledTransientFocusNonceRef.current
    ) {
      // The dedicated transient-focus effect below owns this entry. Keeping it
      // out of this effect's dependency list prevents consuming the one-shot
      // request from immediately triggering a normal tail reload.
      return;
    }
    // The linked message's window, the remembered scroll position's (the
    // primitive's persistKey path picks the saved id up as the
    // initialTopMostItemIndex on mount; the "silent" load skips the highlight
    // flash so the resume reads as a return to the parked spot), or the
    // latest page; joins the same load if the route preload already started it.
    void openChannelWindow(channelId, focusMessageIdRef.current);
  }, [
    channelId,
    rawQueryFocusMessageId,
    setNearBottom,
    translationWindow,
  ]);

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

  // The highlighted message is scrolled to once: a later page loading while
  // it is still highlighted (the reader scrolled on) must not pull the view
  // back to it.
  const scrolledToHighlightRef = useRef<string | null>(null);
  const highlightedMessageLoaded = !!highlightedMessageId && messages.some((msg) => msg.id === highlightedMessageId);
  useEffect(() => {
    if (!highlightedMessageId) {
      scrolledToHighlightRef.current = null;
      return;
    }
    if (!highlightedMessageLoaded) return;
    const jump = `${highlightedMessageId}:${highlightNonce}`;
    if (scrolledToHighlightRef.current === jump) return;
    const focusFrame = requestAnimationFrame(() => {
      scrolledToHighlightRef.current = jump;
      timelineRef.current?.scrollToMessage(highlightedMessageId, { align: "center" });
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [highlightedMessageId, highlightedMessageLoaded, highlightNonce]);

  // The message a jump went to is located (states.md#located) once it is
  // loaded, then the jump is retired, both keyed on the jump alone: new
  // messages and later pages must not restart the count, or a busy channel
  // keeps the highlight on for as long as people keep posting. The list holds
  // the highlight, not the row (MessageItem's `located`): the list mounts only
  // rows near the viewport, and a row that scrolls out and back in after the
  // highlight has run must stay unlit, not start another LOCATED_MS.
  const channelJump = highlightedMessageLoaded && highlightedMessageId ? `${highlightedMessageId}:${highlightNonce}` : null;
  const channelLocated = useLocated(channelJump);
  const locatedMessageId = channelLocated ? highlightedMessageId : null;
  const retireHighlight = useCallback(() => setHighlightedMessageId(null), [setHighlightedMessageId]);
  useRetireJump(channelJump, retireHighlight);
  useKeyboardJumpFocus(
    highlightedMessageId ? `${highlightedMessageId}:${highlightNonce}` : null,
    highlightedMessageLoaded,
    // Opening a reply jumps to its parent here and to the reply in the
    // thread (Saved, a thread hit): the reply is where the person went, so
    // the channel leaves focus to the thread while that jump is on.
    () => (useThreadStore.getState().focusedMessageId ? null : findLocatedMessageRow(highlightedMessageId)),
  );

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
  }, [messages]);

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
  }, [activeTab, hasNewer, messages.length]);

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

  // "Back to bottom" while in a context window (newer messages not loaded).
  // Clears focus, exits the context window in the store (so the list stops
  // requesting newer pages) and opens the latest page; ChatPanel's load effect,
  // rerun when `msg=` is dropped, joins that same load. The scroll waits for
  // the load to land: until then the rows on screen are the old window, whose
  // bottom is not the channel's (#triage:#296), whatever commits meanwhile.
  const handleBackToBottom = useCallback(() => {
    if (!channelId) return;
    setHighlightedMessageId(null);
    setNewMessageCount(0);
    if (focusMessageId) {
      clearFocusedMessageParam();
    }
    exitContextWindow(channelId);
    const load = openLatestChannelWindow(channelId);
    bottomIntentRef.current = load;
    void load.then(() => {
      if (bottomIntentRef.current !== load) return;
      bottomIntentRef.current = null;
      const state = useMessageStore.getState();
      const meta = selectChannelWindowMeta(state, channelId);
      // Another window opened meanwhile (a jump, another channel): not ours to scroll.
      if (state.currentChannelId !== channelId || meta.loading || meta.hasNewer) return;
      // After the store's commit: the latest page is what the list shows now.
      requestAnimationFrame(() => {
        timelineRef.current?.scrollToBottom();
      });
    });
  }, [channelId, clearFocusedMessageParam, exitContextWindow, focusMessageId, setHighlightedMessageId]);

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
    if (forumMode) return loadOlderActivity(channelId);
    return loadOlderMessages(channelId);
  }, [channelId, forumMode, loadOlderActivity, loadOlderMessages]);

  const loadNewerForChannel = useCallback(() => {
    if (!channelId) return Promise.resolve();
    return loadNewerMessages(channelId);
  }, [channelId, loadNewerMessages]);

  const storeChannel = useMemo(
    () => {
      if (!channelId) return undefined;
      const state = useChannelStore.getState();
      return findStoredChannel({ ...state, channels }, channelId);
    },
    [channelId, channels],
  );
  const channelActivityMuted = storeChannel?.activityMuted ?? (channel?.activityMuted === true);
  const channelMuteFromSeq = storeChannel?.muteFromSeq ?? channel?.muteFromSeq ?? null;
  const channelPrefsVersion = storeChannel?.prefsVersion ?? channel?.prefsVersion;
  const activityMuted = channelActivityMuted;
  const channelCollapseLongMessages = storeChannel?.collapseLongMessages ?? channel?.collapseLongMessages ?? false;
  const channelDisplayPrefsVersion = storeChannel?.displayPrefsVersion ?? channel?.displayPrefsVersion;

  const handleToggleActivityMute = useCallback(async () => {
    if (!activityMuteSupported || !channelId || activityMuteSaving) return;
    // `activityMuteSupported` is left as the server last said: a DM whose bot
    // was removed can still be unmuted, but must not come back as mutable.
    const previous = {
      activityMuted: channelActivityMuted,
      muteFromSeq: channelMuteFromSeq,
      prefsVersion: channelPrefsVersion,
    };
    const nextActivityMuted = !activityMuted;
    const optimistic = {
      activityMuted: nextActivityMuted,
      muteFromSeq: previous.muteFromSeq,
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
      const current = findStoredChannel(useChannelStore.getState(), channelId);
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
    if (!messageDisplayPrefsSupported || !channelId || messageDisplayPrefsSaving) return;
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
      const current = findStoredChannel(useChannelStore.getState(), channelId);
      if (matchesMessageDisplayPrefsState(current, optimistic)) {
        setChannelMessageDisplayPrefsState(channelId, previous);
        setMessageDisplayPrefsError("message.chatPanel.collapseLongMessagesError");
      }
    } finally {
      setMessageDisplayPrefsSaving(false);
    }
  }, [
    messageDisplayPrefsSupported,
    channelCollapseLongMessages,
    channelDisplayPrefsVersion,
    channelId,
    messageDisplayPrefsSaving,
    setChannelMessageDisplayPrefsState,
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
    for (const human of mentionChannelHumans) map.set(human.id, rosterHumanAsMember(human, { homeServer: false }));
    return map;
  }, [members, mentionChannelHumans]);
  // Provider-side projections (Slack members bound to this channel), keyed by
  // projection id — same id the `type:"external"` structured mention carries.
  const externalById = useMemo(() => {
    const map = new Map<string, typeof mentionChannelExternalMembers[0]>();
    for (const external of mentionChannelExternalMembers) map.set(external.id, external);
    return map;
  }, [mentionChannelExternalMembers]);

  // Thread summaries
  const threadSummaries = useThreadStore((s) => s.summaries);

  const supportsChannelTasks = channel !== null && channel.type !== "thread";
  // Workspace Artifacts (F41): the viewer is a card in this channel's side
  // column, above Tasks and Files (ChannelSideColumn). Only the channel
  // column hosts it (not a thread, not an embedded panel).
  const hostsArtifacts = supportsChannelTasks && !hideHeader;
  const artifactHostChannelId = hostsArtifacts && channel ? channel.id : null;
  // The Artifact's place shows the Artifact or a web preview, whichever was opened last (web_preview_v0).
  const artifactViewerCard = useArtifactSideCard(artifactHostChannelId);
  const { card: artifactSideCard, closeWebPreview } = useArtifactPlaceCard(artifactHostChannelId, artifactViewerCard);
  // Opened from this channel's thread where the channel isn't on screen (the
  // thread covers it, or Focus Mode folds it away), the thread steps behind
  // the channel (F41) while that Artifact is open: it stays open where it
  // was, and comes back when the Artifact closes (or its "N replies" opens it
  // again). Only state decides this; where the split row shows both columns
  // index.css ignores it, so widening or narrowing the window never leaves a
  // stale value behind.
  const revealBehindThread = useCallback((from: Element) => {
    if (!artifactHostChannelId || !from.closest("[data-testid='thread-side-column']")) return false;
    const thread = useThreadStore.getState();
    if (thread.openParentChannelId !== artifactHostChannelId || !thread.openParentMessageId) return false;
    const ui = useUIStore.getState();
    // Focus Mode folds the channel away: unfold it, the thread beside it.
    if (ui.threadMaximized) ui.restoreThreadLayout();
    ui.setThreadBehindChannel(thread.openParentMessageId);
    return true;
  }, [artifactHostChannelId]);
  const artifactHostRef = useArtifactHost(artifactHostChannelId, revealBehindThread);
  // In the same update as the close, so the thread is on screen again when
  // focus goes back to the card in it that opened the Artifact. Also when an
  // Artifact in another conversation replaces it, whichever channel this
  // panel shows by then: the thread's own channel decides, not this panel's.
  useArtifactClosed(useCallback((conversationId: string) => {
    const ui = useUIStore.getState();
    const thread = useThreadStore.getState();
    if (ui.threadBehindChannel !== null && thread.openParentChannelId === conversationId && ui.threadBehindChannel === thread.openParentMessageId) {
      ui.setThreadBehindChannel(null);
    }
  }, []));
  // The channel Tasks card beside the message list (task v2).
  // Tasks and Files open as cards beside the message list, from the channel
  // header; both can be open. Old `?chatTab=tasks|files` links (the removed
  // tabs) open that card.
  const storedSideCards = useChannelSideCardStore((s) => s.open);
  // The cards no longer step aside for a thread: they are the cards column of
  // the right-side grid and keep a place at every width (ChannelSideArea).
  const setSideCardOpen = useChannelSideCardStore((s) => s.setCardOpen);
  const tasksCardOpen = taskV2 && supportsChannelTasks && (storedSideCards.tasks || queryTab === "tasks");
  const filesCardOpen = taskV2 && supportsChannelTasks && (storedSideCards.files || queryTab === "files");
  const closeCard = useCallback((card: ChannelSideCard) => {
    setSideCardOpen(card, false);
    if (queryTab === card) setActiveTab("chat");
  }, [queryTab, setActiveTab, setSideCardOpen]);
  // The card's own close (channel_tab_selected side_card_close); the phone's
  // Back closes cards through closeCard and is not an entry.
  const closeTasksCard = useCallback(() => {
    trackChannelTabSelected("tasks", "side_card_close", true);
    closeCard("tasks");
  }, [closeCard]);
  // Task v2 on a phone: the open cards cover the conversation under the
  // header, so the header's Back closes them — the one Back on screen (DS:
  // close a card with Back on a phone); the cards draw none of their own.
  const closeOpenCards = useCallback(() => {
    if (tasksCardOpen) closeCard("tasks");
    if (filesCardOpen) closeCard("files");
  }, [closeCard, filesCardOpen, tasksCardOpen]);
  const phoneLayout = useMediaQuery("(max-width: 767px)");
  // On a phone the header's Back closes what covers the conversation, the
  // card on top first (an Artifact, or Task v2's cards), then the other; then
  // the channel's own Back. Closing an Artifact opened from the thread brings
  // the thread back.
  const cardFocusAt = useChannelSideCardStore((s) => s.cardFocusAt);
  const artifactOnTop = artifactSideCard !== null
    && activeAreaSection([
      "artifact" as const,
      ...(tasksCardOpen ? ["tasks" as const] : []),
      ...(filesCardOpen ? ["files" as const] : []),
    ], cardFocusAt, artifactSideCard.openedAt) === "artifact";
  const artifactHeaderBack = useArtifactHeaderBack(artifactHostChannelId, channelMobileBack);
  // On a phone the page covers the conversation: the header's Back closes it first.
  const onMobileBack = phoneLayout && closeWebPreview ? closeWebPreview : artifactHeaderBack;
  const headerMobileBack = phoneLayout && (tasksCardOpen || filesCardOpen) && !artifactOnTop ? closeOpenCards : onMobileBack;
  // The side area (MainLayout's ChannelSideArea) floats or covers sections in
  // this panel's body (ChannelSideFloatSlot); covering the messages (a phone, a
  // narrow panel) makes them and the composer inert, never what covers them.
  // An expanded Artifact takes the whole row instead, as Focus Mode does: the
  // row hides the channel (index.css `data-artifact-expanded`).
  const agentSectionOpen = useAgentSideSectionOpen(channelId, phoneLayout);
  const sideColumnOpen = tasksCardOpen || filesCardOpen || artifactSideCard !== null || agentSectionOpen;
  const panelBodyRef = artifactHostRef;
  const sideCovering = useSideSections((s) => s.placement.floating.length > 0 && s.placement.floatMode === "overlay");
  const sideColumnCovering = sideColumnOpen && sideCovering;
  // What the side area needs to place the Artifact (its viewer is rendered here, through its portal).
  const artifactSection = useMemo<SideAreaArtifact | null>(() => (artifactSideCard ? {
    icon: artifactSideCard.icon,
    openedAt: artifactSideCard.openedAt,
    minWidth: artifactSideCard.minWidth,
    expanded: artifactSideCard.expanded,
  } : null), [artifactSideCard]);
  const closeFilesCard = useCallback(() => {
    trackChannelTabSelected("files", "side_card_close", true);
    closeCard("files");
  }, [closeCard]);
  const toggleTasksCard = useCallback(() => {
    trackChannelTabSelected("tasks", "side_card_toggle", tasksCardOpen);
    if (tasksCardOpen) closeCard("tasks");
    else setSideCardOpen("tasks", true);
  }, [closeCard, setSideCardOpen, tasksCardOpen]);
  const toggleFilesCard = useCallback(() => {
    trackChannelTabSelected("files", "side_card_toggle", filesCardOpen);
    if (filesCardOpen) closeCard("files");
    else setSideCardOpen("files", true);
  }, [closeCard, filesCardOpen, setSideCardOpen]);

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
    if (readOnly || (joinDeferred && !tasksCardOpen) || channelTasksLoading || channelTasksLoaded) return;
    void loadTasks(channel.id);
  }, [channel, channelTasksLoaded, channelTasksLoading, joinDeferred, loadTasks, readOnly, supportsChannelTasks, tasksCardOpen]);

  // Feeds the inline status badge and `standaloneMessageIds`, which stops a
  // task-bearing message being merged into a consecutive-message group.
  const tasksByMessageId = useMemo(() => {
    const map = new Map<string, Task[]>();
    if (!supportsChannelTasks) return map;
    for (const t of channelTasks) {
      // The message a task hangs under; tasks from before task v2 hang under
      // their host message. A channel-only task hangs under none. A task made
      // the v2 way hangs under its source whatever the flag says (its
      // `messageId` is only the task id, never a message).
      const anchor = (taskV2 || isTaskV2Task(t)) && t.sourceMessageId !== undefined ? t.sourceMessageId : t.messageId;
      if (!anchor) continue;
      const list = map.get(anchor);
      if (list) list.push(t);
      else map.set(anchor, [t]);
    }
    for (const list of map.values()) list.sort((a, b) => a.taskNumber - b.taskNumber);
    return map;
  }, [channelTasks, supportsChannelTasks, taskV2]);
  // A message may carry several tasks (task v2). The single-task chip keeps
  // reading the first; the list reads them all.
  const taskByMessageId = useMemo(() => {
    const map = new Map<string, Task>();
    for (const [messageId, list] of tasksByMessageId) map.set(messageId, list[0]);
    return map;
  }, [tasksByMessageId]);
  // The task list under a message: every message's tasks under task v2; with
  // the flag off only where a task made the v2 way hangs (it keeps working the
  // v2 way), so a pre-v2 task keeps its single footer chip as before.
  const taskListsByMessageId = useMemo(() => {
    if (taskV2) return tasksByMessageId;
    const map = new Map<string, Task[]>();
    for (const [messageId, list] of tasksByMessageId) {
      if (list.some(isTaskV2Task)) map.set(messageId, list);
    }
    return map;
  }, [tasksByMessageId, taskV2]);

  const messageSource = useMemo<MessageTimelineSource>(() => ({
    messages,
    hasOlder: hasMore,
    hasNewer,
    loading,
    loadOlder: loadOlderForChannel,
    loadNewer: loadNewerForChannel,
    initialFocusMessageId: showsHiddenTarget ? null : highlightedMessageId ?? focusMessageId ?? null,
    initialAtStart: showsHiddenTarget,
    // Each jump bumps the nonce; a jump clears the paywall until it lands.
    atStartKey: showsHiddenTarget ? highlightNonce : null,
  }), [messages, hasMore, hasNewer, loading, loadOlderForChannel, loadNewerForChannel, highlightedMessageId, focusMessageId, showsHiddenTarget, highlightNonce]);

  const systemMessageRenderStates = useMemo(
    () => buildSystemMessageRenderStates(messages, formatMessage),
    [messages, formatMessage],
  );
  // A system-message group is one row of the timeline (its summary renders
  // the whole group): its hidden messages are not rows.
  const channelFoldedMessageIds = useMemo(
    () => foldedSystemMessageIds(messages, systemMessageRenderStates),
    [messages, systemMessageRenderStates],
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
      if (forumMode || threadSummaries[m.id] || taskByMessageId.has(m.id)) ids.add(m.id);
    }
    return ids;
  }, [forumMode, messages, threadSummaries, taskByMessageId]);
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
  // Thread jump pill: scroll the chat to a parent message and flash it. A loaded
  // message only needs the highlight (its effect scrolls); otherwise load the
  // context window around it, which sets the same highlight.
  const threadJumpLoadedRange = useMemo(() => ({
    oldestAt: messages[0]?.createdAt ?? null,
    newestAt: messages[messages.length - 1]?.createdAt ?? null,
    hasNewer,
  }), [hasNewer, messages]);
  const threadJumpLoadedMessageIds = useMemo(() => messages.map((message) => message.id), [messages]);
  const threadJumpRenderKey = `${messages.length}:${messages[0]?.id ?? ""}:${messages[messages.length - 1]?.id ?? ""}`;
  // A parent outside the loaded messages loads its context window first: the
  // returned promise is that wait (the pill is busy until it settles). It
  // says whether the jump landed on the history paywall: the context route
  // answered history_limited (each context load resets the error first).
  const handleJumpToParentMessage = useCallback((messageId: string) => {
    if (!channelId) return;
    if (messages.some((message) => message.id === messageId)) {
      setHighlightedMessageId(messageId);
      return;
    }
    return loadMessageContext(channelId, messageId).then(() => ({
      historyLimited: selectChannelWindowMeta(useMessageStore.getState(), channelId).contextLoadError === CONTEXT_BEYOND_HISTORY_ERROR,
    }));
  }, [channelId, loadMessageContext, messages, setHighlightedMessageId]);
  const preserveChannelAnchorForThreadOpen = useCallback(() => {
    timelineRef.current?.preserveAnchorOnNextLayoutChange();
  }, []);

  const isGuest = currentServer?.role === "guest";
  // A Guest reacts in its own channel like a member (matrix §1); it can read
  // no other channel, so `joined` decides it as for everyone.
  const canReactInChannel = !readOnly
    && !channel?.archivedAt
    && (channel?.type === "dm" || channel?.type === "thread" || channel?.joined === true);
  // #693 DM read status (artin, option C): only the DM's last message, and only
  // at the live edge — in a context window (`hasNewer`) the last loaded message
  // is not the conversation's last. MessageItem still gates on own sender and
  // the peer watermark.
  const dmReadStatusMessageId = channel?.type === "dm" && !hasNewer
    ? messages[messages.length - 1]?.id ?? null
    : null;
  // Agent read progress (agent_read_progress_v0): each agent's face on the last
  // message it read, in a column every row reserves while it is on here, and
  // the agents' read line under your latest message. Null model: rows as before.
  const { model: agentReadProgress, statusMessageId: agentReadStatusMessageId } = useAgentReadProgress({
    scope: channel,
    messages,
    hasNewer,
    foldedMessageIds: channelFoldedMessageIds,
    typingChannelId: channel?.id ?? null,
    typingParentMessageId: null,
    agentById,
  });
  const agentReadActive = agentReadProgress !== null;
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
          className={TIMELINE_ROW_INSET}
          // `overflow: clip visible` keeps the horizontal clip (wide code /
          // attachments can't blow out the column) while letting the hover
          // toolbar overflow upward to ride on the message's top border.
          // `contain: layout style` keeps layout+style isolation for the long
          // list; only `paint` is dropped, since paint containment is what
          // forces the vertical clip. See MessageItem hover toolbar.
          style={{ contain: "layout style", overflow: "clip visible" }}
        >
          <AgentReadSystemRow messageId={msg.id}>
            <ThreadPanelSystemMessageGroupDisclosure
              summary={systemMessageState.content}
              expanded={expanded}
              groupId={systemMessageState.groupId}
              onToggleGroup={toggleSystemMessageGroup}
            >
              {systemMessageState.messageIndexes.map((messageIndex) => {
                const originalMessage = messages[messageIndex];
                if (!originalMessage) return null;
                return (
                  <MessageItem
                    key={originalMessage.id}
                    message={originalMessage}
                    linkedTask={taskByMessageId.get(originalMessage.id)}
                    linkedTasks={taskListsByMessageId.get(originalMessage.id)}
                    mentionMap={mentionMap}
                    channels={channels}
                    previewSenderAgent={originalMessage.senderType === "agent" ? agentById.get(originalMessage.senderId) : undefined}
                    previewSenderMember={originalMessage.senderType === "user" ? memberById.get(originalMessage.senderId) : undefined}
                    channelParticipantAgentsById={agentById}
                    channelParticipantMembersById={memberById}
                    channelParticipantExternalsById={externalById}
                    threadSummary={threadSummaries[originalMessage.id]}
                    parentChannelId={channel?.id || ""}
                    mentionComposerChannelId={channel?.id ?? originalMessage.channelId}
                    hideThreadActions
                    onBeforeOpenThread={preserveChannelAnchorForThreadOpen}
                    onOpenThread={onOpenThread}
                    onOpenProfile={onOpenProfile}
                    canReact={canReactInChannel}
                    located={originalMessage.id === locatedMessageId}
                  />
                );
              })}
            </ThreadPanelSystemMessageGroupDisclosure>
          </AgentReadSystemRow>
        </div>
      );
    }

    const groupState = messageGrouping.get(msg.id);
    const followedBy = followedByFor(messages, index, messageGrouping);
    return wrapMessageRender(
      <>
        {/* Under the history paywall, the first day of the window also says
            that the last 30 days start here. */}
        {!forumMode && groupState?.showDayDivider && <DateDivider createdAt={msg.createdAt} recentHistory={index === 0 && topHistoryState === "history_limited"} />}
        <div
          className={TIMELINE_ROW_INSET}
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
            linkedTasks={taskListsByMessageId.get(msg.id)}
            mentionMap={mentionMap}
            channels={channels}
            previewSenderAgent={msg.senderType === "agent" ? agentById.get(msg.senderId) : undefined}
            previewSenderMember={msg.senderType === "user" ? memberById.get(msg.senderId) : undefined}
            channelParticipantAgentsById={agentById}
            channelParticipantMembersById={memberById}
            channelParticipantExternalsById={externalById}
            threadSummary={threadSummaries[msg.id]}
            parentChannelId={channel?.id || ""}
            mentionComposerChannelId={channel?.id ?? msg.channelId}
            onBeforeOpenThread={preserveChannelAnchorForThreadOpen}
            onOpenThread={onOpenThread}
            onOpenProfile={onOpenProfile}
            canReact={canReactInChannel}
            groupState={groupState}
            followedBy={followedBy}
            showDmReadStatus={msg.id === dmReadStatusMessageId}
            showAgentReadStatus={msg.id === agentReadStatusMessageId}
            agentReadFaces={agentReadActive}
            located={msg.id === locatedMessageId}
          />
        </div>
      </>
    );
  }, [forumMode, agentById, agentReadActive, agentReadStatusMessageId, canReactInChannel, channel?.id, channelId, channels, dmReadStatusMessageId, topHistoryState, expandedSystemMessageGroups, externalById, locatedMessageId, memberById, mentionMap, messageRenderScope, messages, messageGrouping, onOpenProfile, onOpenThread, preserveChannelAnchorForThreadOpen, systemMessageRenderStates, taskByMessageId, taskListsByMessageId, threadSummaries, toggleSystemMessageGroup]);

  // The list's one leading row: the history boundary (with the context-jump
  // banners). Keyed by its variant, so it is a row of the timeline like the
  // messages.
  const channelLeadingRows = useMemo<MessageTimelineLeadingRow[]>(
    () => [{ kind: "boundary", variant: historyBoundaryVariant(topHistoryState, "start") }],
    [topHistoryState],
  );
  const renderChannelLeadingRow = useCallback(() => (
    // The list starts a section step above its first line (raft-ui timeline
    // rhythm): the history notice brings a row's lead like a message does, so
    // the step holds when it renders nothing. That also leaves the hover
    // toolbar its room above the first message, so the scroller never clips it.
    <div className={`${TIMELINE_ROW_INSET} ${TIMELINE_START_ABOVE_ROW}`}>
      {/* The target behind the window: the paywall centers on it. */}
      {showsHiddenTarget && channelId ? (
        <HistoryPaywall channelId={channelId} scope={historyPaywallScope} channelName={historyPaywallChannel} mode="target" onOpenReplies={openHiddenTargetReplies} />
      ) : topHistoryState === "history_limited" && channelId ? (
        <HistoryPaywall channelId={channelId} scope={historyPaywallScope} channelName={historyPaywallChannel} />
      ) : (
        <HistoryTopState
          hasMore={hasMore}
          historyLimited={historyLimited}
          loadingOlder={loadingOlder}
          noun="messages"
        />
      )}
    </div>
  ), [channelId, hasMore, historyLimited, historyPaywallChannel, historyPaywallScope, loadingOlder, openHiddenTargetReplies, showsHiddenTarget, topHistoryState]);

  // The list ends a section step above the composer's frame (raft-ui
  // timeline rhythm): TIMELINE_END_ABOVE_COMPOSER here, plus the composer's
  // own 8px above its card. While an agent is typing, the typing line floats
  // over the list's bottom (AgentTypingLine, beside the timeline) and
  // AgentTypingListEnd adds its height here, so a reader at the bottom still
  // sees the last message whole above the line (task #120). In select mode
  // the toolbar floats over the list's bottom where the composer was, so the
  // list ends a section step above the toolbar instead (SelectModeListEnd).
  const selectModeListHere = useSelectionStore((s) => s.isActive && s.channelId !== null && s.channelId === channelId);
  const selectModeListEnd = showComposer && selectModeListHere;
  const selectToHere = useSelectToHere({ timelineRef, active: selectModeListEnd }); // its pill: BottomJumpControls
  // × or Esc unmounts the toolbar: focus goes back into this conversation
  // (useExitSelectionReturningFocus), not to <body>.
  const conversationColumnRef = useRef<HTMLDivElement>(null);
  const exitSelectionReturningFocus = useExitSelectionReturningFocus(conversationColumnRef);
  // The assistant's otter on this composer's frame (AssistantOtter). It
  // floats over the list's corner and keeps no room in it.
  const otterHostId = useId();
  const channelFooter = useMemo(() => (
    <div className={showComposer && !selectModeListEnd ? `${TIMELINE_ROW_INSET} ${TIMELINE_END_ABOVE_COMPOSER}` : `${TIMELINE_ROW_INSET} pb-timeline-end`}>
      {loadingNewer && (
        <div
          data-testid="list-loading-newer"
          className="py-2 text-center font-mono text-mono-meta text-foreground-hint"
        >
          {formatMessage({ id: "message.chatPanel.loadingNewer" })}
        </div>
      )}
      {showComposer ? <AgentTypingListEnd channelId={channel?.id} parentMessageId={null} workingAgentIdKey={workingAgentIdKey} /> : null}
      {selectModeListEnd ? <SelectModeListEnd /> : null}
    </div>
  ), [loadingNewer, formatMessage, showComposer, channel?.id, workingAgentIdKey, selectModeListEnd]);

  // Quota check — hooks must be above the early return to maintain consistent hook order.
  // Reuse the activity-stable `channels` above (this createdAt-sorted check doesn't
  // need live `lastMessageAt`) so it doesn't re-subscribe to the churny whole Record.
  const allChannels = channels;
  const plan = (billing?.plan || currentServer?.plan || "free") as ServerPlan;
  const maxChannels = getEffectiveLimits(plan).maxChannels;
  const isReadOnlyByQuota = useMemo(() => {
    // A Lounge is not one of the server's channels and never counts (Agent Lounge v0).
    if (!channel || channel.type === "dm" || channel.loungeAgentId || maxChannels === -1) return false;
    if (allChannels.length <= maxChannels) return false;
    const sorted = [...allChannels].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const writableIds = new Set(sorted.slice(0, maxChannels).map((c) => c.id));
    return !writableIds.has(channel.id);
  }, [channel, maxChannels, allChannels]);

  // Agent Lounge v0: the Lounge button on an agent DM's header, and a
  // Lounge's name (its agent's). Hooks, so above the early return.
  const loungeEnabled = useAgentLoungeEnabled();
  const openAgentLounge = useOpenAgentLounge();
  const loungeAgentName = useLoungeAgentName(channel?.loungeAgentId ? channel : null);
  const loungeDmAgentId = channel?.type === "dm" && channel.peerType === "agent" ? channel.peerId ?? null : null;
  const handleOpenLounge = useCallback(() => {
    if (loungeDmAgentId) void openAgentLounge(loungeDmAgentId);
  }, [loungeDmAgentId, openAgentLounge]);

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
    jointLocked: isJointChannelReadOnly(channel),
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
    picCaptureProgress,
    cancelPicCapture,
    picPreview,
    setPicPreview,
    picError,
    setPicError,
    copiedMd,
    onSavePic,
    onCopyMd,
  } = useSelectionShareHandlers({
    channelMessages: messagesBelongToChannel ? messages : [],
    onUnresolvedSelection: showUnresolvedSelectionToast,
  });
  const picPreviewRef = useRef<ValidatedScreenshot[] | null>(null);
  picPreviewRef.current = picPreview;

  useEffect(() => {
    void useAttachmentPreviewGate.getState().load();
  },
  // Stryker disable next-line ArrayDeclaration: alternate static dependency arrays still run this mount-only attachment gate load once.
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
  useShortcutLayer("selection", escGuard, {
    ignoreDefaultPrevented: true,
    onEscape: () => (picPreviewRef.current ? false : void exitSelectionReturningFocus()),
  });

  const forwardState = forwardAvailability(channel, { isGuest });
  const showForwardAction = forwardState === "ready";

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

  // One message, straight from its row (task #35): same composer, no select mode.
  const forwardSingleMessage = useCallback((message: Message) => {
    const { messages: forwardable, nestedForwardCount } = getForwardableMessages([message]);
    if (forwardable.length === 0) return;
    setForwardComposer({ messages: forwardable, skippedCount: 0, nestedForwardCount });
  }, []);

  const copySelectedLinks = useCallback(() => {
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
  }, [channel, serverSlug, messagesBelongToChannel, messages, showUnresolvedSelectionToast]);

  useRerenderAtJointDeadline(channel?.type === "joint" ? channel.jointOverLimitGraceEndsAt : null);
  useRerenderAtJointDeadline(channel?.externalFreezeAt);

  // On a phone the header's Search opens this conversation's own search, a
  // pushed page (Back, no tab bar) scoped to it: the Search tab is where
  // everything is searched (Raft DS › Navigation › Search on a phone).
  // Wider screens keep the ⌘K overlay filtered to the channel.
  const isPhone = isMobileComposer;
  const channelType = channel?.type;
  const handleSearchThisChannel = useCallback((searchChannelId: string) => {
    if (onSearchChannel) onSearchChannel(searchChannelId);
    else if (isPhone && searchChannelId) nav.toConversationSearch(channelType === "dm" ? "dm" : "channel", searchChannelId);
    else nav.toSearch(undefined, { channelId: searchChannelId, deferUntilQuery: true });
  }, [channelType, isPhone, onSearchChannel, nav]);
  const handleSearchCurrentChannel = useCallback(() => handleSearchThisChannel(channel?.id ?? ""), [handleSearchThisChannel, channel?.id]);
  // ⌘F / Ctrl+F searches this conversation, like the header's Search entry
  // (task #51): the ⌘K overlay filtered to it, or its own search on a phone.
  // Only where that entry exists, and only for keys aimed at this panel: the
  // thread panel has its own ⌘F, and dialogs, the document preview (which
  // relies on the browser's find) and the ⌘K overlay sit outside this root.
  // A key with no focused element counts when the last click or focus landed
  // here (ThreadPanel's rule).
  const conversationPanelRef = useRef<HTMLDivElement | null>(null);
  const conversationSearchEnabled = !hideHeader && !!channel && channel.type !== "thread";
  // ⌘F / Ctrl+F (or the person's keys) searches this conversation while the key is pressed in the panel, or on the
  // body after the last click or focus landed in it: the panel is the "conversation" scope (data-shortcut-scope).
  useShortcut("search-channel", () => { handleSearchCurrentChannel(); }, { enabled: conversationSearchEnabled, scopeRef: conversationPanelRef });
  const handleLeaveChannel = useCallback(() => leaveChannel(channel?.id ?? ""), [leaveChannel, channel?.id]);
  const handleStopAllAgents = useCallback(() => setShowSOSDialog(true), []);
  const handleDismissActivityMuteError = useCallback(() => setActivityMuteError(null), []);
  const handleDismissMessageDisplayPrefsError = useCallback(() => setMessageDisplayPrefsError(null), []);
  const handleJoinChannel = useCallback(() => joinChannel(channel?.id ?? ""), [joinChannel, channel?.id]);
  const joiningChannel = useChannelStore((s) => channel?.id !== undefined && s.joiningChannelIds[channel.id] === true);
  const handleCloseSOSDialog = useCallback(() => setShowSOSDialog(false), []);
  const handleClosePicPreview = useCallback(() => {
    cancelPicCapture();
    setPicPreview(null);
  }, [cancelPicCapture, setPicPreview]);
  const handleRetryPicCapture = useCallback(() => {
    setPicError(null);
    void onSavePic();
  }, [onSavePic, setPicError]);
  useSelectShareErrorToast({ picError, setPicError, onRetry: handleRetryPicCapture });
  const handlePicPreviewSaved = useCallback(() => {
    setPicPreview(null);
    useSelectionStore.getState().exit();
  }, [setPicPreview]);
  const overflowActivityMute = useMemo(() => activityMuteSupported ? {
    muted: activityMuted,
    busy: activityMuteLoading || activityMuteSaving,
    onToggle: () => void handleToggleActivityMute(),
  } : undefined, [activityMuteSupported, activityMuted, activityMuteLoading, activityMuteSaving, handleToggleActivityMute]);
  const overflowCollapseLongMessages = useMemo(() => messageDisplayPrefsSupported ? {
    enabled: channelCollapseLongMessages,
    busy: messageDisplayPrefsLoading || messageDisplayPrefsSaving,
    onToggle: () => void handleToggleCollapseLongMessages(),
  } : undefined, [messageDisplayPrefsSupported, channelCollapseLongMessages, messageDisplayPrefsLoading, messageDisplayPrefsSaving, handleToggleCollapseLongMessages]);
  const overflowMembers = useMemo(() => ({
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
  }), [mentionChannelAgents, mentionChannelHumans, mentionChannelExternalMembers, mentionMembersLoading, addMentionChannelMembers, addMentionChannelAgent, removeMentionChannelAgent, addMentionChannelHuman, removeMentionChannelHuman, changeMentionChannelMemberRole, mentionRoleChangeFailed]);
  const overflowSettings = useMemo(() => {
    const joinedNow = channel?.type === "dm" || channel?.type === "thread" ? true : channel?.joined;
    const isAll = channel?.type !== "dm" && channel?.type !== "thread" && channel?.name === "all";
    const canLeave = !isAll;
    return joinedNow === true && (canManageChannels || canLeave) ? {
      initialName: channel?.name ?? "",
      initialDescription: channel?.description || "",
      onLeaveChannel: canLeave ? handleLeaveChannel : undefined,
    } : undefined;
  }, [canManageChannels, channel?.type, channel?.joined, channel?.name, channel?.description, handleLeaveChannel]);

  // A DM peer's face: the live agent / member directory once it knows them (a reset included), else the DM's snapshot.
  const dmPeerAvatar = useMemo(() => resolveDmPeerAvatarFromDirectory(channel ?? {}, agents, members), [channel, agents, members]);
  // The head always fits (#189 rule 6): its own buttons (Search, an agent DM's Lounge, Tasks, Files, Settings) fold into ⋯.
  const { cardToggles, containerProps: headContainerProps, fit: fitHead } = useChannelHeadToggles({ cards: taskV2 && supportsChannelTasks, tasksOpen: tasksCardOpen, filesOpen: filesCardOpen, onToggleTasks: toggleTasksCard, onToggleFiles: toggleFilesCard, onOpenLounge: handleOpenLounge });
  if (!channel) return <ChatPanelNoChannel onBack={onMobileBack ?? routeMobileBack} backAlwaysVisible={Boolean(contentSlotBack)} />;

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
  const dmAgent = isAgentDM && channel.peerId ? agents.find((agent) => agent.id === channel.peerId) : undefined;
  const dmAgentProfile = dmAgent ? resolveAgentDmProfileSource(dmAgent) : null;
  const displayName = dmAgentProfile?.displayName
    ?? channel.peerDisplayName
    ?? channel.peerName
    ?? channel.name;
  const { avatarUrl: dmAvatarUrl } = dmPeerAvatar;
  // An App Bot removed from its App (#11295) keeps its DM and its history, but
  // it can't answer: the DM gets the read-only composer, under a notice that
  // says why (ThreadPanel does the same for this DM's threads). agent:updated
  // re-reads the directory, so a removal or a re-add shows here without a reload.
  const dmAppBotRemoved = isRemovedAppBot(dmAgent);
  const isRegularChannel = !isDM;
  // Agent Lounge v0: a public channel on the wire that belongs to one agent.
  // Like a DM there is nothing to join first (the first post joins you, the
  // server does it) and no channel management; it is named after its agent.
  const isLounge = isRegularChannel && !isThread && !!channel.loungeAgentId;
  const loungeTitle = isLounge ? formatMessage({ id: "agent.lounge.title" }, { name: loungeAgentName }) : "";
  const loungeReadOnly = isLounge && channel.canPost === false;
  // Joinable = a surface whose membership is gated by join/leave. DM and thread
  // share the "implicitly composable" axis; only true regular channels have a
  // join CTA path and the management chrome that depends on `joined`.
  const isJoinableChannel = isRegularChannel && !isThread && !isLounge;
  const isAllChannel = isJoinableChannel && channel.name === "all";
  const hideAllChannelMembersButton = isAllChannel
    && currentServer?.role === "member"
    && currentServer.hideHumansFromMembers;
  const isArchived = !!channel.archivedAt;
  const isJointChannelFeatureLocked = isJointChannelReadOnly(channel);
  // Contract v0.3 §18.8: shown to every member during the over-limit grace so
  // members can relay it to admins who are not in this channel.
  const jointOverLimitGraceEndsAt = jointChannelGraceEndsAt(channel);
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
  const joined: boolean | undefined = isDM || isThread || isLounge ? true : channel.joined;
  const selectModeScopedHere = selectModeActive && selectModeChannelId === channel.id;
  const channelHeaderIcon = isRegularChannel && !isLounge ? <ChannelIcon channel={channel} serverPublicPageLive={currentServer?.publicPageLive === true} /> : undefined;
  const channelSubtitle = isRegularChannel && !isLounge
    ? channel.description ? <ChannelDescription description={channel.description} /> : undefined
    : undefined;
  const regularTitleSuffix = isRegularChannel && !isLounge
    && (isArchived || activityMuted || slackSyncHeaderState(channel) || forumChannel) ? (
    <div className="flex items-center gap-1.5">
      {isArchived && (
        <Badge appearance="soft" variant="muted" className="shrink-0">
          {formatMessage({ id: "message.chatPanel.archived" })}
        </Badge>
      )}
      {forumChannel && <ChannelForumOrderBadge />}
      <ChannelSlackSyncBadge channel={channel} />
      {activityMuted && <ActivityMutedBadge />}
    </div>
  ) : undefined;
  const bottomButtonCount = hasNewer ? currentUnreadCount : newMessageCount;
  const showBottomButton = hasNewer || !atBottom || newMessageCount > 0;
  const handleBottomButton = hasNewer ? handleBackToBottom : scrollToBottom;
  const bottomButton = showBottomButton ? (
    <MessageListJumpPill onClick={handleBottomButton} data-testid="back-to-bottom">
      <ArrowDown aria-hidden />
      {bottomButtonCount > 0
        ? formatMessage({ id: "message.chatPanel.newMessagesCount" }, { count: bottomButtonCount })
        : formatMessage({ id: "message.chatPanel.backToBottom" })}
    </MessageListJumpPill>
  ) : null;
  // Regular channels use the settings drawer; DMs share the same overflow
  // component in its DM mode (task #703).
  const { toggles: headToggles, fold: headFold } = fitHead(!!(isAgentDM && loungeEnabled && dmAgent && agentOffersLounge(dmAgent)), !!channelHeaderIcon);
  const channelHeaderActions = isJoinableChannel ? (
    <ChannelOverflowMenu
      channelId={channel.id}
      channelName={channel.name}
      open={overflowOpen}
      onOpenChange={setOverflowOpen}
      onSearch={handleSearchCurrentChannel}
      middleActions={cardToggles.nodes}
      middleItems={cardToggles.items}
      fold={headFold}
      activityMute={overflowActivityMute}
      collapseLongMessages={overflowCollapseLongMessages}
      showMembers={!hideAllChannelMembersButton}
      members={overflowMembers}
      settings={overflowSettings}
      onStopAllAgents={joined && capabilities.stopAgents ? handleStopAllAgents : undefined}
    />
  ) : isDM || isLounge ? (
    /* task #703 / #1281: the DM gets the SAME overflow component as a channel
       (artin: 用统一组件), but a 1:1 DM settings sheet no longer shows a
       members section. Its root view is just the shared preferences; no edit
       form, no add-member affordance, and Mute activity only for a DM the
       server says can be muted (a DM with an App bot) or one with a mute
       stored. */
    <ChannelOverflowMenu
      channelId={channel.id}
      channelName={isLounge ? loungeTitle : displayName}
      open={overflowOpen}
      onOpenChange={setOverflowOpen}
      onSearch={handleSearchCurrentChannel}
      middleActions={headToggles.nodes}
      middleItems={headToggles.items}
      fold={headFold}
      activityMute={overflowActivityMute}
      collapseLongMessages={overflowCollapseLongMessages}
    />
  ) : null;

  return (
    <ConversationPanelRoot ref={conversationPanelRef} edge="inset" className="relative" data-shortcut-scope="conversation">
      <VisibleMessageTranslations store={translationWindow} messages={messages} />
      {/* Header — hidden when embedded in detail panels.
          DMs use titleSlot because the avatar is an interactive profile
          trigger. Regular channels use PanelHeader's native title/subtitle
          stack so the title never competes with long descriptions. */}
      {!hideHeader && (
      <PanelHeader
        onMobileBack={headerMobileBack}
        mobileBackProps={CHAT_MOBILE_BACK_PROPS}
        backButtonVisibility={contentSlotBack ? "always" : "responsive"}
        icon={channelHeaderIcon}
        containerProps={headContainerProps}
        iconTone="location"
        iconAlwaysVisible={isRegularChannel && !isLounge}
        title={isRegularChannel && !isLounge ? (
          isJoinableChannel ? (
            /* The channel's name opens its details too, as in other chat apps (raft-design channel.md). */
            <button
              type="button"
              onClick={openOverflow}
              className="max-w-full truncate rounded-[2px] text-left outline-none hover:underline hover:decoration-foreground-hint hover:underline-offset-4 focus-visible:shadow-focus"
              aria-expanded={overflowOpen}
              data-testid="channel-header-title-button"
            >
              {channel.name}
            </button>
          ) : channel.name
        ) : undefined}
        titleSuffix={regularTitleSuffix}
        subtitle={channelSubtitle}
        subtitleMultiline={isRegularChannel && !isLounge}
        subtitleClassName="empty:hidden"
        titleSlot={
          isAgentDM ? (
            <div className="flex min-w-0 items-center gap-3">
              {/* The agent's live activity in detail while its DM is open. */}
              {channel.peerId ? <AgentActivitySubscription agentIdKey={channel.peerId} /> : null}
              <button
                onClick={() => channel.peerId && useProfileStore.getState().openProfile("agent", channel.peerId, { openSource: "channel" })}
                className="shrink-0 rounded-sticker outline-none transition-[filter] duration-75 hover:brightness-90 focus-visible:shadow-focus"
              >
                <AvatarSlot context="panel-header" type="agent" agentAvatarUrl={dmAvatarUrl} />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Tooltip content={displayName}><PanelTitle render={<span className="min-w-0 truncate" />}>{displayName}</PanelTitle></Tooltip>
                {/* An App bot has no presence (it would read "offline" forever): its
                    header carries the App badge instead, as its messages do. */}
                {dmAgent?.managedByAppInstallId
                  ? <AppBadge className="shrink-0" appName={dmAgent.managedByApp?.name} botName={displayName} />
                  : channel.peerId && <AgentDMStatus agentId={channel.peerId} />}
                {activityMuted && <ActivityMutedBadge />}
              </div>
            </div>
          ) : isLounge ? (
            <div className="flex min-w-0 items-center gap-3" data-testid="lounge-header">
              {/* A Lounge is drawn with its agent's face and the Lounge mark in the corner (LoungeAvatar). */}
              <button
                onClick={() => channel.loungeAgentId && useProfileStore.getState().openProfile("agent", channel.loungeAgentId, { openSource: "channel" })}
                className="shrink-0 rounded-sticker outline-none transition-[filter] duration-75 hover:brightness-90 focus-visible:shadow-focus"
                aria-label={loungeAgentName}
              >
                <LoungeAvatar agentId={channel.loungeAgentId} context="panel-header" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Tooltip content={loungeTitle}><PanelTitle render={<span className="min-w-0 truncate" />}>{loungeTitle}</PanelTitle></Tooltip>
                {activityMuted && <ActivityMutedBadge />}
              </div>
            </div>
          ) : isUserDM ? (
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => channel.peerId && useProfileStore.getState().openProfile("human", channel.peerId, { openSource: "channel" })}
                className="shrink-0 rounded-sticker outline-none transition-[filter] duration-75 hover:brightness-90 focus-visible:shadow-focus"
              >
                <AvatarSlot
                  context="panel-header"
                  type="human"
                  humanAvatarUrl={dmAvatarUrl}
                />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Tooltip content={displayName}><PanelTitle render={<span className="min-w-0 truncate" />}>{displayName}</PanelTitle></Tooltip>
                {activityMuted && <ActivityMutedBadge />}
              </div>
            </div>
          ) : undefined
        }
        // The conversation's Expand (#189 rule 5) last: it has no Close.
        actions={<>{channelHeaderActions}<RowExpandAction region="conversation" /></>}
      />
      )}

      <ConversationPanelContent>

      {/* Agent Lounge v0: who is here, always on top of the conversation. */}
      {isLounge && (
        <PanelNotice status="info" data-testid="lounge-audience-notice">
          <PanelNoticeContent>{formatMessage({ id: "agent.lounge.audienceNotice" })}</PanelNoticeContent>
        </PanelNotice>
      )}

      {!hideHeader && activityMuteError && (
        <PanelNotice role="alert" data-testid="activity-mute-error">
          <PanelNoticeContent>{formatMessage({ id: activityMuteError })}</PanelNoticeContent>
          <PanelNoticeActions>
            <CloseButton
              type="button"
              aria-label={formatMessage({ id: "message.chatPanel.dismissActivityMuteError" })}
              onClick={handleDismissActivityMuteError}
            >
              <X size={12} />
            </CloseButton>
          </PanelNoticeActions>
        </PanelNotice>
      )}

      {!hideHeader && messageDisplayPrefsError && (
        <PanelNotice role="alert" data-testid="message-display-prefs-error">
          <PanelNoticeContent>{formatMessage({ id: messageDisplayPrefsError })}</PanelNoticeContent>
          <PanelNoticeActions>
            <CloseButton
              type="button"
              aria-label={formatMessage({ id: "message.chatPanel.dismissMessageDisplayPrefsError" })}
              onClick={handleDismissMessageDisplayPrefsError}
            >
              <X size={12} />
            </CloseButton>
          </PanelNoticeActions>
        </PanelNotice>
      )}

      {/* Chat/Tasks tab bar — hidden when there's only one tab (e.g. thread
          surface only has Chat) to avoid an empty-looking single-tab strip. */}
      {showPanelTabs && (
        <ConversationPanelTabs render={<Tabs<ChatPanelTab> value={activeTab} onValueChange={selectHeaderTab} />} ref={touchDragRegion}>
          <SortableTabsList<ChatPanelTab>
            value={visibleTabIds}
            onReorder={reorderTabs}
          >
            {visibleTabButtons}
          </SortableTabsList>
        </ConversationPanelTabs>
      )}

      {!taskV2 && activeTab === "tasks" ? (
        <ConversationPanelBody className="flex flex-col">
          <Suspense fallback={<PanelLoading label={formatMessage({ id: "layout.main.loading" })} />}><TasksPanel channelId={channel.id} /></Suspense>
        </ConversationPanelBody>
      ) : !taskV2 && activeTab === "files" ? (
        <ConversationPanelBody className="flex flex-col"><ChannelFilesPanel channel={channel} /></ConversationPanelBody>
      ) : (
        <div ref={panelBodyRef} className="relative flex min-h-0 flex-1" {...(artifactHostChannelId ? { [WEB_PREVIEW_HOST_ATTRIBUTE]: artifactHostChannelId } : null)}>
        {/* The conversation the side cards take their width from (ColumnResizeHandle MAIN_COLUMN_ATTRIBUTE). */}
        <div ref={conversationColumnRef} className="flex min-h-0 min-w-0 flex-1 flex-col" data-main-column="" inert={sideColumnCovering || undefined}>
          {/* The channel's announcement: last of the top regions, right above the timeline (raft-design channel.md). */}
          {channelAnnouncement && !showLinkUnavailable ? (
            <ChannelAnnouncementStrip
              channelId={channel.id}
              announcement={channelAnnouncement}
              onOpenSettings={canEditAnnouncement ? openAnnouncementSettings : undefined}
            />
          ) : null}
          {/* Messages — virtualized.
              stdrc 2026-05-02 #proj-uiux:95e25b5b e33f2924: main panel
              整个 white 底，messages scroller 也跟上 — the whole chat column
              is DS paper (bg-layer-canvas) from header to composer. */}
          <div
            className={`relative flex-1 overflow-hidden bg-layer-canvas ${selectModeListEnd ? SELECT_MODE_LIST_RESERVE_CLASS : ""}`}
            data-testid="message-content-surface"
          >
            {showLinkUnavailable && landedLinkTarget ? (
              <MessageLinkUnavailable backTo={conversationPathOf(landedLinkTarget)} />
            ) : holdForLandedLink ? (
              <MessagesLoading testId="landed-link-pending" label={formatMessage({ id: "message.chatPanel.loading" })} />
            ) : loading && !shouldShowMessageTimeline ? (
              <MessagesLoading label={formatMessage({ id: "message.chatPanel.loading" })} />
            ) : !shouldShowMessageTimeline && (historyLimited || contextLoadError === CONTEXT_BEYOND_HISTORY_ERROR) ? (
              // Every message sits behind the plan history cutoff: the channel
              // is not empty, it is hidden. Say so instead of "No messages yet"
              // (the timeline header that carries this banner is not mounted
              // while there are no visible messages). Same as ThreadPanel.
              !channelId ? (
                <div className="flex h-full flex-col items-center justify-center p-4" data-testid="channel-history-limited-empty">
                  <HistoryLimitBanner />
                </div>
              ) : showsHiddenTarget ? (
                // A raft-ui ScrollArea; the paywall sits on the composer by its content's
                // auto top margin (not justify-end, which would move the gutters layer
                // down too and leave the top of a tall paywall out of reach).
                <ScrollArea className="flex h-full flex-col px-3 pb-2" contentClassName="mt-auto" data-testid="channel-history-limited-empty">
                  <HistoryPaywall channelId={channelId} scope={historyPaywallScope} channelName={historyPaywallChannel} mode="target" allHidden onOpenReplies={openHiddenTargetReplies} />
                </ScrollArea>
              ) : (
                // Where the newest messages would be: on the composer, the
                // width of the timeline (a timeline with nothing in the window).
                <ScrollArea className="flex h-full flex-col px-3 pb-2" contentClassName="mt-auto" data-testid="channel-history-limited-empty">
                  <HistoryPaywall channelId={channelId} scope={historyPaywallScope} channelName={historyPaywallChannel} allHidden />
                </ScrollArea>
              )
            ) : !shouldShowMessageTimeline ? (
              <EmptyState
                className="flex h-full flex-col items-center justify-center"
                icon={<MessageIcon width={36} height={36} />}
                title={formatMessage({ id: "message.chatPanel.noMessagesTitle" })}
              />
            ) : (
              <MessageForwardContext.Provider value={showForwardAction ? forwardSingleMessage : null}>
              {/* Select mode: a row's toggle or range (Shift+click), in this timeline's order. */}
              <AgentReadProgressContext.Provider value={agentReadProgress}><MessageSelectIntentProvider timelineRef={timelineRef}>
              <MessageTimeline
                key={channel.id}
                ref={timelineRef}
                source={messageSource}
                renderItem={renderChannelItem}
                foldedMessageIds={channelFoldedMessageIds}
                leadingRows={channelLeadingRows}
                renderLeadingRow={renderChannelLeadingRow}
                footer={channelFooter}
                onAtBottomChange={handleAtBottomStateChange}
                onVisibleMessageWindowChange={translationWindow.set}
                onViewportChange={selectToHere.onViewportChange}
                persistKey={forumMode ? `channel-forum:${channel.id}` : `channel:${channel.id}`}
                className="h-full"
                sparseAnchor="bottom"
              />
              </MessageSelectIntentProvider></AgentReadProgressContext.Provider>
              </MessageForwardContext.Provider>
            )}
            {/* The list's bottom edge fades over the composer (raft-ui
                MessageListEndFade): a message scrolled under it softens instead of
                being cut. At the end of the list it lies over the list's empty end. */}
            {showComposer ? <AgentTypingLine channelId={channel.id} parentMessageId={null} workingAgentIdKey={workingAgentIdKey} /> : null}
            {showComposer ? <MessageListEndFade className={`${END_FADE_ABOVE_COMPOSER} ${END_FADE_UNDER_AGENT_TYPING_LINE_CLASS}`} /> : null}
            {!isDM && !isThread ? (
              <ThreadUnreadJumpPill
                channelId={channel.id}
                onJumpToMessage={handleJumpToParentMessage}
                bottomButton={bottomButton} selectToHere={selectToHere}
                loadedRange={threadJumpLoadedRange}
                loadedMessageIds={threadJumpLoadedMessageIds}
                renderKey={threadJumpRenderKey}
              />
            ) : (
              // Always mounted, shown with `hidden` (see ThreadUnreadJumpPill):
              // the timeline's sibling list must not change while scrolling.
              <BottomJumpControls data-testid="chat-bottom-controls" selectToHere={selectToHere} hidden={!bottomButton}>
                {bottomButton}
              </BottomJumpControls>
            )}
          </div>

          {/* Input or Join bar */}
          {showComposer ? (
            <ConversationPanelFooter ref={toastFloorRef} className={composerHostClassName(overlayComposer)}>
          <OpenInAppRowSlot />
          {!readOnly && !isArchived && <ExternalFreezeNotice channel={channel} />}
          {jointOverLimitGraceEndsAt && !readOnly && !isArchived && (
            <div className={`bg-layer-canvas ${COMPOSER_EDGE_CLASS} pt-2`}>
              <Banner intent="warning" className="justify-center text-center font-bold" data-testid="joint-over-limit-grace-banner">
                {formatMessage(
                  { id: "message.chatPanel.jointOverLimitGrace" },
                  { deadline: formatDate(new Date(jointOverLimitGraceEndsAt), { dateStyle: "medium", timeStyle: "short" }) },
                )}
              </Banner>
            </div>
          )}
          {/* A paused personal assistant (#10654): the owner can still write;
              the notice says it won't reply until they start it. */}
          {dmAgent?.assistantPausedAt && !readOnly && !isArchived && (
            <div className={`bg-layer-canvas ${COMPOSER_EDGE_CLASS} pt-2`} data-testid="assistant-dm-paused">
              <AssistantPausedNotice agentId={dmAgent.id} />
            </div>
          )}
          {dmAgent?.raftbenchService ? (
            <div className="bg-layer-canvas px-3 pt-2 pb-3" data-testid="raftbench-service-dm-notice">
              <Banner intent="info" className="justify-center text-center">
                {formatMessage({ id: "message.chatPanel.raftbenchServiceDm" })}
              </Banner>
            </div>
          ) : readOnly || dmAppBotRemoved || loungeReadOnly ? (
            <ReadOnlyComposer notice={dmAppBotRemoved && dmAgent ? <RemovedAppBotDmNotice handle={dmAgent.name} /> : null} />
          ) : isArchived ? (
            <div className="bg-layer-canvas p-3">
              <Banner intent="warning" className="justify-center text-center font-bold">
                {formatMessage({ id: "message.chatPanel.archivedNotice" })}{" "}
                {isLounge ? (capabilities.archiveChannels && channel && <LoungeUnarchiveAction channelId={channel.id} />
                ) : effectiveChannelCapabilities.archiveChannels && (
                  <TextLink
                    onClick={openOverflow}
                    variant="strong"
                  >
                    {formatMessage({ id: "message.chatPanel.unarchive" })}
                  </TextLink>
                )}
              </Banner>
            </div>
          ) : isJointChannelFeatureLocked ? (
            <ChannelLimitLockedBanner channel={channel} plan={plan} />
          ) : isReadOnlyByQuota ? (
            <div className="bg-layer-canvas p-3">
              <Banner intent="warning" className="justify-center text-center font-bold">
                {formatMessage({ id: "message.chatPanel.readOnlyQuota" }, { plan: PLAN_CONFIG[plan].displayName })}{" "}
                <TextLink
                  onClick={openBillingSettings}
                  variant="strong"
                >
                  {formatMessage({ id: "message.chatPanel.upgradeForMoreChannels" })}
                </TextLink>
              </Banner>
            </div>
          ) : joined === true ? (
            selectModeScopedHere ? (
              // First in the footer (above any notice it stacks): the toolbar
              // floats up from the list's bottom edge, never over a notice.
              <div className="order-first">
              <SelectModeToolbar
                channelId={channel.id}
                focusScopeRef={conversationColumnRef}
                capturing={picCapturing}
                onCancelCapture={cancelPicCapture}
                captureProgressLabel={picCaptureProgress && picCaptureProgress.pageCount > 1
                  ? formatMessage({ id: "message.selectModeToolbar.renderingPage" }, { page: picCaptureProgress.pageNumber, count: picCaptureProgress.pageCount })
                  : null}
                copied={copiedMd}
                onForward={forwardState !== "hidden" ? openForwardComposer : undefined}
                forwardPending={forwardState === "pending"}
                onCopyLinks={copySelectedLinks}
                onSavePic={onSavePic}
                onCopyMd={onCopyMd}
              />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {/* Notices above the composer keep its frame's edge, so each
                    is as wide as the frame (on a phone the activation banner
                    sits inside MessageInput, on the same edge). Hidden while
                    empty, so it adds no gap of its own. */}
                <div className={`flex flex-col gap-2 empty:hidden ${COMPOSER_EDGE_CLASS}`} data-testid="composer-notices" data-composer-notices="">
                  {dmAgent ? <HostedCindyFailedBanner agent={dmAgent} /> : null}
                  {primaryComposerEligible && !isMobileComposer ? (
                    <NotificationActivationBanner placement="desktop" composerChannelId={channel.id} />
                  ) : null}
                </div>
                <MessageInput
                  channelId={channel.id}
                  deferUntilFirstPage
                  channelName={isDM ? `@${displayName}` : isLounge ? loungeTitle : `#${channel.name}`}
                  // Task v2 too: a task is a message sent As task, in a channel or a DM (never a thread's composer).
                  showTaskButton={supportsChannelTasks && allowTasks}
                  asTaskShortcutDisabled={taskV2 && !(supportsChannelTasks && allowTasks)}
                  autoFocus={composerAutoFocus}
                  onWillSend={handleWillSend}
                  activationBanner={primaryComposerEligible && isMobileComposer
                    ? <NotificationActivationBanner placement="mobile" composerChannelId={channel.id} />
                    : undefined}
                  frameEdge={<AssistantOtterAnchor hostId={otterHostId} channelId={channel.id} />}
                  composerReference={composerReference}
                />
              </div>
            )
          // A Guest posts in its bound channel (joined) like a member; it never
          // joins a channel itself, so it gets no Join.
          ) : joined === false && !isGuest ? (
            <div className="flex flex-col items-center gap-2 bg-layer-canvas p-3">
              <Button onClick={handleJoinChannel} size="lg" variant="accent" className="w-full" loading={joiningChannel} disabled={joiningChannel}>
                <JoinChannelIcon width={14} height={14} />
                {formatMessage({ id: "message.chatPanel.joinChannel" }, { channel: channel.name })}
              </Button>
            </div>
          ) : null}
            </ConversationPanelFooter>
          ) : null}
        </div>
        {/* Tasks and Files: rendered here, placed by MainLayout's ChannelSideArea
            (in the row, or floating or covering this panel through the slot). */}
        {tasksCardOpen ? (
          <SideSectionPortal section="tasks" title={formatMessage({ id: "task.panel.heading" })}>
            <ChannelTasksPanel key={channel.id} channelId={channel.id} onClose={closeTasksCard} />
          </SideSectionPortal>
        ) : null}
        {filesCardOpen ? (
          <SideSectionPortal section="files" title={formatMessage({ id: "message.chatPanel.tabFiles" })}>
            <ChannelFilesCard key={channel.id} channel={channel} onClose={closeFilesCard} />
          </SideSectionPortal>
        ) : null}
        <AgentContextViewSectionSlot channelId={channel.id} />
        {/* The open Artifact (F41): a section of the side area for now, never of the stored layout. */}
        {artifactSideCard && artifactSection ? (
          <SideArtifactPortal title={artifactSideCard.label} artifact={artifactSection} render={artifactSideCard.render} />
        ) : null}
        {sideColumnOpen ? <ChannelSideFloatSlot /> : null}
        </div>
      )}

      </ConversationPanelContent>

      {!isGuest && forwardComposer && (
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

      {showSOSDialog && (
        <SOSDialog
          channelId={channel.id}
          channelName={channel.name}
          onClose={handleCloseSOSDialog}
        />
      )}

      {picPreview && (
        <SelectShareLightbox
          images={picPreview}
          filename={`slock-${channel.name || "export"}-${new Date().toISOString().slice(0, 10)}.png`}
          onClose={handleClosePicPreview}
          onSaved={handlePicPreviewSaved}
        />
      )}


    </ConversationPanelRoot>
  );
}
