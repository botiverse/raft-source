import { applyReadStateUpdate } from "./applyReadStateUpdate";
/**
 * Socket bridge -- the L1 subscription home of RFC 037 (S3 target shape).
 *
 * Socket listeners belong to the module/store layer, not to component
 * effects: installing them here removes the re-subscribe-on-render-dep
 * failure class entirely (the MainLayout mega-effect P1: navigate identity
 * churn tore down 30 listeners and dropped pushes in the gap).
 *
 * A bridge is a set of named bindings installed once per socket instance,
 * returning a single uninstall. Bindings receive raw payloads and are
 * expected to adapt them into domain events and `dispatch` -- they must not
 * contain business logic beyond adaptation (that lives in reducers).
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { NavigateFunction } from "react-router-dom";
import { ACTIVITY_CHANGED_EVENT, LIST_CHANGED_EVENTS, PRODUCT_FEEDBACK_UNREAD_EVENT, SERVER_FEATURES_CHANGED_SOCKET_EVENT, failpoints, isNotificationLevel, isRaftThemeId, SOCKET_NOT_SERVER_MEMBER_ERROR, SOCKET_SSO_REQUIRED_ERROR } from "@botiverse/raft-shared";
import api from "../api/client";
import type { ActivityChangedEvent, AgentActivityStatePayload, AgentSeenEvent, ComputerVersionGate, CredentialHoldActivityDiagnostic, DeliveryConsumptionActivityDiagnostic, RuntimeErrorCode, SpawnFailureActivityDiagnostic, ToolStuckActivityDiagnostic, WakeCrashLoopActivityDiagnostic } from "@botiverse/raft-shared";
import {
  getLiveSessionRecoveryPlan,
  planStatusReconcile,
} from "../utils/browserRecoveryPolicy";
import { traceAgentActivitySocketReceived } from "../utils/webAgentActivityTrace";
import { reloadAgentsAfterServerChange, settleAgentsLoadInFlight, useAgentStore } from "./agentStore";
import { observeAgentActivityForErrorRecord } from "./agentErrorRecordRefresh";
import type { TrajectoryEntry } from "./agentStore";
import { afterFirstScreen } from "../boot/deferredUi";
import { useAnnouncementStore } from "./announcementStore";
import { applyActorUpdatedEvent } from "./localTables/actorResolve";
import { applyUserProfileUpdatedEvent } from "./userProfileUpdated";
import { normalizeActivityMuteState, normalizeMessageDisplayPrefs } from "./channelDomain";
import type { MessageDisplayPrefsState } from "./channelDomain";
import {
  applyMessageChannelActivity,
  createChannelRealtimeBindings,
  isMessageActivitySuppressedByMute,
  isMessageInMutedActivityRange,
} from "./channelRealtimeSync";
import type { ScheduleInboxRefresh } from "./channelRealtimeSync";
import { useChannelStore } from "./channelStore";
import { dispatchServerNotificationPrefsUpdated } from "./events/notificationPrefsEvents";
import { cancelInboxBackgroundRefresh, compareActivitySeq, requestInboxBackgroundRefresh, useInboxStore } from "./inboxStore";
import { liveActivityUnread } from "./inboxInPlaceUnread";
import { isThreadReplyGap, requestResumeGapReread, storedMessageLive } from "./inboxLiveCatchUp";
import type { InboxLiveUnread } from "./inboxInPlaceUnread";
import { useLiveAgentActivityStore } from "./liveAgentActivityStore";
import { isAgentActivitySubscribed, resubscribeAgentActivity, setAgentActivitySubscriptionSocket } from "./agentActivitySubscriptions";
import { AGENT_READ_PROGRESS_SOCKET_EVENTS, agentReadProgressSocketBindings, refreshWatchedFollowState, rewatchAgentReadProgress, setAgentReadProgressWatchSocket } from "./agentReadProgressWatch";
import { mintAgentActivityClientEventId } from "./agentActivityClientEventId";
import { clearAgentTypingForMessage, readAgentTypingEvent, useAgentTypingStore } from "./agentTypingStore";
import { useMachineStore } from "./machineStore";
import { useNotificationSettingsStore } from "./notificationSettingsStore";
import {
  consumeNotificationPrefsUpdateWithSyncCore,
} from "./notificationPrefsSyncDomain";
import type {
  NotificationPrefsUpdate,
} from "./notificationPrefsSyncDomain";
import {
  getAcceptedReadState,
  normalizeReadStateUpdated,
  normalizeReadStateUpdatedBulk,
} from "./readStateSync";
import { releaseActivityReadHoldForMessage } from "./activityReadState";
import { createConversationScopeSync, createRecoveryScopeSync, heartbeatNeedsScopeSync, installSystemResumeRecovery, noteRoomsJoinDegraded, visibleScopeIds } from "./heartbeatGate";
import {
  captureReceiverPrivateIngressContext,
  isReceiverPrivateIngressContextCurrent,
  useMessageStore,
} from "./messageStore";
import type {
  Message,
} from "./messageStore";
import { useReadReceiptStore } from "./readReceiptStore";
import { hasChatSurfaces } from "../embed";
import { useSavedStore } from "./savedStore";
import { bootListKey, loadedWithin, settleInFlightLoader, useServerStore } from "./serverStore";
import { startingSyncHorizonSafe } from "./startingSyncHorizon";
import { invalidateObjectSummaries } from "../objects/objectSummaryLoader";
import { registerFeatureFlagRealtimeHandlers } from "./featureFlagRealtimeSync";
import { registerTaskRealtimeHandlers } from "./taskRealtimeSync";
import { useTaskStore } from "./taskStore";
import { handleThreadUpdatedForReplies } from "./threadRepliesSocket";
import {
  consumeThreadUpdatedWithSyncCore,
  hydrateThreadRepliesRebaselineSnapshotWithSyncCore,
  releaseThreadRepliesRebaselineRequest,
  requestThreadRepliesRebaselineSnapshot,
} from "./threadRepliesSyncDomain";
import { requestThreadAgentFollowers } from "./threadAgentFollowerStore";
import { useThreadStore } from "./threadStore";
import { noteForumThreadUpdated } from "./forumThreadReplySocket";
import { applyMessageUpdated, applyThreadReplyUpdate } from "./messageUpdatedApply";
import { liveReplyUnread } from "./visibleConversations";
import { refreshServerUnreadSummaryAfterRead } from "./serverUnreadSummaryRefresh";
import { notifyAllChannelMembersChanged, notifyChannelMembersChanged } from "./channelMemberEvents";
import { SyncChangesSession } from "./syncChangesClient";
import type { ListFetchReason } from "./listFetchReason";
import type { SyncConversationState, SyncSnapshotLoaders } from "./syncChangesClient";
import { createCoalescedRefresh } from "../utils/coalescedRefresh";
import { dropOwedReads, heldWhileHidden, noteLiveSessionRecovery, setOwedGapReadsPaidListener, traceLiveSession } from "./hiddenOwedReads";
import { channelOwesGapFill } from "./liveGapFill";
import { listChangedSocketBindings, requestListsAfterReconnect } from "./listChangedSocket";
import { acceptFeedbackUnreadPush, refreshFeedbackUnreadAfterReconnect } from "../feedback/feedbackUnreadState";
import { isTaskConversationMessage, taskIdOfConversationMessage } from "../utils/taskConversation";

export interface SocketLike {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

type SocketBindingHandler = {
  bivarianceHack(payload: unknown): void;
}["bivarianceHack"];

export interface SocketBinding {
  event: string;
  handler: SocketBindingHandler;
}

const installedBridges = new WeakMap<SocketLike, Map<string, () => void>>();

/**
 * Install a named bridge on a socket. Idempotent per (socket, name): a
 * second install for the same name uninstalls the previous bindings first,
 * so reconnect/re-wiring can never double-subscribe.
 */
export function installSocketBridge(
  socket: SocketLike,
  name: string,
  bindings: SocketBinding[],
): () => void {
  const bySocket =
    installedBridges.get(socket) ?? new Map<string, () => void>();
  installedBridges.set(socket, bySocket);
  bySocket.get(name)?.();

  const handlers = bindings.map((binding) => {
    // Contract: bindings receive the FIRST socket argument only. Every event
    // this app consumes carries a single payload object; a future multi-arg
    // event needs a widened SocketBinding, not a silent args[1] drop.
    const handler = (...args: unknown[]) => binding.handler(args[0]);
    socket.on(binding.event, handler);
    return { event: binding.event, handler };
  });

  const uninstall = () => {
    for (const { event, handler } of handlers) socket.off(event, handler);
    if (bySocket.get(name) === uninstall) bySocket.delete(name);
  };
  bySocket.set(name, uninstall);
  return uninstall;
}

// Status defense-in-depth cadence. Announcement discovery deliberately does not
// use this timer: it runs only on entry and foreground recovery, so publishing
// cannot make every open tab present the same account-level row at once.
//
// 10 minutes, not 1: agent activity is server-PUSHED (daemon heartbeat every
// 60s in agentProcessManager + agent:activity events with per-agent serverSeq),
// machine status is versioned event-driven (machine:status / daemon:status /
// machine:updated reconcile), and a dead socket is owned by the 90s-silence
// heartbeat breaker + recoverLiveSession. This blind pull is only the net for
// a silently-dropped edge event (CC-006), so its job is bounded staleness, not
// freshness — a full machines+agents reload every 60s per visible tab was the
// idle request wave, not a feature.
const STATUS_RECONCILE_INTERVAL_MS = 600_000;

export const MAIN_LAYOUT_SOCKET_EVENT_NAMES = [
  "message:new",
  "message:updated",
  "scope_read:updated",
  ...AGENT_READ_PROGRESS_SOCKET_EVENTS, // agentReadProgressWatch.ts
  "read_state:updated",
  "read_state:updated_bulk",
  "agent:activity",
  "agent:activity_state",
  "agent:typing",
  "agent:seen",
  "agent:session",
  "dm:new",
  "machine:status",
  "machine:capabilities",
  "machine:updated",
  "machine:upgrade-request",
  "computer:restart:done",
  "daemon:status",
  "agent:created",
  "agent:deleted",
  "agent:updated",
  "actor:updated",
  "user:profile-updated",
  "channel:updated",
  "channel:members-updated",
  "notification_prefs:updated",
  "message_display_prefs:updated",
  "server:plan-updated",
  "appearance:updated",
  "server:member-added",
  "server:member:left",
  "server:member-removed",
  "server:member-updated",
  "server:membership-removed",
  "connect_error",
  "thread:updated",
  "thread:reply_updated",
  "thread:followers-updated",
  "connect",
  "rooms:joined",
  "rooms:join_failed",
  "sync:resume:response",
  "heartbeat",
  "task:created",
  "task:updated",
  "task:deleted",
  "artifact:attachment-saved",
  "activity:changed",
  "sync:changed",
  ...LIST_CHANGED_EVENTS, // listChangedSocket.ts
  SERVER_FEATURES_CHANGED_SOCKET_EVENT, // listChangedSocket.ts: a list's gating flag (flags themselves: featureFlagRealtimeSync.ts)
  PRODUCT_FEEDBACK_UNREAD_EVENT, // feedback/feedbackUnreadState.ts: the "new reply" dot's count
] as const;

type SocketHandler = {
  bivarianceHack(...args: unknown[]): void;
}["bivarianceHack"];

export interface MainLayoutSocketBridgeSocket extends SocketLike {
  connected: boolean;
  emit: (event: string, ...args: unknown[]) => unknown;
  onAny: (handler: (...args: unknown[]) => void) => unknown;
  offAny: (handler: (...args: unknown[]) => void) => unknown;
  disconnect: () => unknown;
  connect: () => unknown;
}

export type MainLayoutRealtimeTransport = {
  getSocket: () => MainLayoutSocketBridgeSocket;
  reconnectSocket: () => void;
  ensureSocketConnected: () => void;
  isSocketConnected: () => boolean;
};

type MainLayoutSocketBinding = SocketBinding & {
  event: (typeof MAIN_LAYOUT_SOCKET_EVENT_NAMES)[number];
};

let bridgeNavigate: NavigateFunction | null = null;

export function setMainLayoutBridgeNavigate(navigate: NavigateFunction | null) {
  bridgeNavigate = navigate;
}

/** Parse current URL to extract channelId (for socket reconnect gap sync). */
function getCurrentChannelId(): string | null {
  const match = window.location.pathname.match(/\/(?:channel|dm)\/([^/?]+)/);
  return match ? match[1] : null;
}

type NotificationPrefsUpdatedPayload = {
  serverId?: unknown;
  scopeId?: unknown;
  prefs?: unknown;
  prefsVersion?: unknown;
};

function readNotificationPrefsUpdate(payload: unknown): NotificationPrefsUpdate | null {
  if (!payload || typeof payload !== "object") return null;
  const { serverId, scopeId, prefs, prefsVersion } = payload as NotificationPrefsUpdatedPayload;
  if (typeof serverId !== "string" || typeof scopeId !== "string") return null;
  if (!prefs || typeof prefs !== "object") return null;
  const normalizedPrefsVersion = typeof prefsVersion === "number"
    && Number.isSafeInteger(prefsVersion)
    && prefsVersion >= 0
    ? prefsVersion
    : undefined;
  const prefRecord = prefs as Record<string, unknown>;
  const serverPushMuted = typeof prefRecord.serverPushMuted === "boolean"
    ? prefRecord.serverPushMuted
    : isNotificationLevel(prefRecord.serverPushMode) ? prefRecord.serverPushMode === "none" : null;
  if (serverPushMuted !== null) {
    return {
      type: "server" as const,
      serverId,
      serverPushMuted,
      prefsVersion: normalizedPrefsVersion,
    };
  }
  if (typeof prefRecord.activityMuted === "boolean") {
    const state = normalizeActivityMuteState({ ...prefRecord, prefsVersion: normalizedPrefsVersion });
    if (!("activityMuteSupported" in prefRecord)) {
      state.activityMuteSupported = undefined;
    }
    return {
      type: "channel" as const,
      serverId,
      channelId: scopeId,
      state,
    };
  }
  return null;
}

type MessageDisplayPrefsUpdatedPayload = {
  serverId?: unknown;
  scopeId?: unknown;
  prefs?: unknown;
  prefsVersion?: unknown;
};

function readMessageDisplayPrefsUpdate(
  payload: unknown,
): { serverId: string; channelId: string; prefs: MessageDisplayPrefsState } | null {
  if (!payload || typeof payload !== "object") return null;
  const { serverId, scopeId, prefs, prefsVersion } = payload as MessageDisplayPrefsUpdatedPayload;
  if (typeof serverId !== "string" || typeof scopeId !== "string") return null;
  if (!prefs || typeof prefs !== "object") return null;
  const prefRecord = prefs as Record<string, unknown>;
  if (typeof prefRecord.collapseLongMessages !== "boolean") return null;
  return {
    serverId,
    channelId: scopeId,
    prefs: normalizeMessageDisplayPrefs({ ...prefRecord, prefsVersion }),
  };
}

function loadInboxReset(opts: { background?: boolean; reason?: ListFetchReason } = {}) {
  void useInboxStore.getState().loadInbox({ reset: true, background: opts.background, reason: opts.reason });
}

/** A live thread reply that mentions the user lights the parent channel's thread @ mark. */
function replyMentionsCurrentUser(reply: Message | undefined): boolean {
  const currentUserId = useMessageStore.getState().currentUserId;
  if (!reply || !currentUserId) return false;
  return (reply.mentions ?? []).some((mention) => mention.type === "user" && mention.id === currentUserId);
}

function loadFollowedThreads(reason: ListFetchReason) {
  void useThreadStore.getState().loadFollowedThreads(reason);
}

/**
 * Task v2: a message in a task's own conversation. The server sends no
 * `thread:updated` for it (that frame is keyed by a parent message, which a
 * task conversation does not have), so its `message:new` frame is what moves
 * the followed-conversation unread — the sidebar mark of its channel and the
 * reply-count pixel and activity time of the task's row. Only followers get
 * the frame; a conversation not in the local list reloads the list.
 */
export function applyTaskConversationReply(msg: Message): void {
  if (!isTaskConversationMessage(msg)) return;
  // Every surface counts the same thing: replies by people and agents, not
  // the lifecycle lines (the task DTO's conversationReplyCount).
  const countsAsReply = msg.messageType !== "system";
  const taskId = taskIdOfConversationMessage(msg);
  if (taskId && countsAsReply) useTaskStore.getState().bumpTaskConversationReplyCount(taskId, typeof msg.createdAt === "string" ? msg.createdAt : undefined);
  const threadState = useThreadStore.getState();
  const followed = threadState.followedThreads.find((t) => t.threadChannelId === msg.channelId);
  if (!followed) {
    followedThreadsRefresh.request();
    return;
  }
  const counts = liveReplyUnread(msg.channelId, msg) === "unread";
  const lastReplyAt = typeof msg.createdAt === "string" ? msg.createdAt : followed.lastReplyAt;
  threadState.updateFollowedThread(msg.channelId, {
    replyCount: followed.replyCount + (countsAsReply ? 1 : 0),
    lastReplyAt,
    // Unread is on the reply basis too: a lifecycle line is not "new" (a
    // mention on one, the assignment notice, still lights the @ mark).
    ...(counts && countsAsReply ? { unreadCount: followed.unreadCount + 1 } : {}),
    ...(counts && replyMentionsCurrentUser(msg) ? { hasMention: true } : {}),
    ...(counts && countsAsReply && followed.unreadCount === 0 ? { firstUnreadMessageId: msg.id } : {}),
  });
}

// A reply into a followed thread that is not in the local list (e.g. the
// server auto-followed it) reloads the list. In a busy channel that is one
// reload per reply, so replies within this window share one reload, and a
// hidden page defers it until it is visible again.
const FOLLOWED_THREADS_REFRESH_DELAY_MS = 1500;
const followedThreadsRefresh = createCoalescedRefresh({
  run: () => loadFollowedThreads("realtime_fallback"),
  delayMs: FOLLOWED_THREADS_REFRESH_DELAY_MS,
  isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
});

/** Test seam: drop any scheduled or deferred followed-thread reload. */
export function __cancelFollowedThreadsRefreshForTests(): void {
  followedThreadsRefresh.cancel();
}

// Boot unread/inbox fallback. rooms:joined is the authoritative owner of the
// unread-counts + inbox loads (a fetch at connect races the room setup); the
// fallback exists only so a boot whose socket never joins (offline degraded
// mode) still loads them exactly once. rooms:joined cancels the timer.
const BOOT_UNREAD_FALLBACK_MS_DEFAULT = 2_000;
let bootUnreadFallbackMs = BOOT_UNREAD_FALLBACK_MS_DEFAULT;
let bootUnreadFallbackTimer: ReturnType<typeof setTimeout> | null = null;

function armBootUnreadFallback() {
  cancelBootUnreadFallback();
  bootUnreadFallbackTimer = setTimeout(() => {
    bootUnreadFallbackTimer = null;
    useMessageStore.getState().loadUnreadCounts();
    loadInboxReset({ background: true, reason: "initial" });
  }, bootUnreadFallbackMs);
}

function cancelBootUnreadFallback() {
  if (bootUnreadFallbackTimer) {
    clearTimeout(bootUnreadFallbackTimer);
    bootUnreadFallbackTimer = null;
  }
}

// Boot connect-snapshot fallback. The connect snapshot (reconnectSnapshot) is
// the single owner of the sidebar order / machines / agents / servers / followed
// threads loads; this bounded fallback only covers a boot whose socket never
// connects (e.g. a proxy blocking WebSockets), which would otherwise leave the
// agent roster empty. A connect cancels it, so a normal boot still loads each
// set exactly once.
let bootConnectFallbackTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A list the boot path loaded this long ago is not read again by the first
 * connect / first rooms:joined (heavy accounts read /channels twice, ~0.5 MB
 * each; web perf, #proj-workspace:f07141a9). Reconnects always read again.
 */
const BOOT_FRESH_MS = 15_000;

function bootFresh(reason: ListFetchReason, key: string): boolean {
  return reason === "initial" && loadedWithin(key, BOOT_FRESH_MS);
}

function loadConnectSnapshotSet(reason: ListFetchReason) {
  const chat = hasChatSurfaces();
  const { current, serverEpoch } = useServerStore.getState();
  const serverId = current?.id;
  if (chat && !(serverId && bootFresh(reason, bootListKey.sidebarOrder(serverId, serverEpoch)))) useServerStore.getState().loadSidebarOrder();
  // Machines and agents carry online status, which only the joined socket
  // pushes: always read again here.
  useMachineStore.getState().loadMachines();
  useAgentStore.getState().loadAgents();
  if (!bootFresh(reason, bootListKey.servers)) useServerStore.getState().loadServers();
  if (chat) loadFollowedThreads(reason);
}

function armBootConnectFallback() {
  cancelBootConnectFallback();
  bootConnectFallbackTimer = setTimeout(() => {
    bootConnectFallbackTimer = null;
    loadConnectSnapshotSet("initial");
  }, bootUnreadFallbackMs);
}

function cancelBootConnectFallback() {
  if (bootConnectFallbackTimer) {
    clearTimeout(bootConnectFallbackTimer);
    bootConnectFallbackTimer = null;
  }
}

// Reconnect reload jitter (#triage:1214a719). After a deploy every client
// reconnects within seconds, and the full-list reloads below were most of the
// 12.5x handling time of the v1.21.35 cut-over. On a reconnect (not the first
// connect of this bridge) they wait one uniform 0–20 s delay per client, so the
// burst spreads out. Message catch-up (sync:resume, visible scopes), unread
// counts and the inbox are not delayed. Goes away with incremental sync.
// Object summaries ride the same delay: `activity:changed` sent while the
// socket was down is not replayed, so the summaries kept for this page are
// dropped and the cards on screen ask again (one batched request each kind);
// Activity's object rows come with the inbox, which rooms:joined reloads.
// The feedback unread count rides it too: `product_feedback:unread` is not
// replayed either, so the list is read once (feedbackUnreadState.ts, which
// keeps its own failure backoff).
const RECONNECT_RELOAD_JITTER_MS_DEFAULT = 20_000;
let reconnectReloadJitterMs = RECONNECT_RELOAD_JITTER_MS_DEFAULT;
type ReconnectReloadPart = "snapshot" | "channels" | "agents" | "machines" | "servers" | "resnapshot" | "object_summaries" | "feedback_unread";
let reconnectReload: {
  timer: ReturnType<typeof setTimeout>;
  parts: Set<ReconnectReloadPart>;
  /** A sync reset's resnapshot, run with the parts so lists it covers aren't read twice. */
  deferred: Array<{ run: () => void; snapshots: ReadonlySet<string>; session: SyncChangesSession | null }>;
} | null = null;

function runReconnectReload() {
  const pending = reconnectReload;
  if (!pending) return;
  if (heldWhileHidden("reload_batch", runReconnectReload)) return;
  reconnectReload = null;
  const { parts, deferred } = pending;
  if (parts.has("object_summaries")) invalidateObjectSummaries();
  if (parts.has("feedback_unread")) refreshFeedbackUnreadAfterReconnect();
  const covered = new Set<string>();
  // A full resnapshot in the same batch reads every list anyway.
  if (!parts.has("resnapshot")) {
    for (const reset of deferred) {
      if (reset.session !== mainLayoutSync) continue;
      reset.run();
      for (const name of reset.snapshots) covered.add(name);
    }
  }
  if (parts.has("resnapshot")) {
    // A new sync cursor: every list again, each after it (syncChangesClient).
    mainLayoutSync?.resnapshotAll("reconnect");
    return;
  }
  if (parts.has("snapshot")) loadConnectSnapshotSet("reconnect");
  // Another server's agents (joint channels) are in no `/agents` list: their
  // current activity comes from the open channel rosters. A push they sent
  // while this tab was disconnected is gone, so read the mounted rosters again
  // with the agents (#triage:#95; `resnapshot` above reads channel_members).
  if (parts.has("snapshot") || parts.has("agents")) notifyAllChannelMembersChanged();
  if (parts.has("channels") && hasChatSurfaces()) void useChannelStore.getState().loadChannels();
  if (!parts.has("snapshot")) {
    if (parts.has("agents") && !covered.has("agents")) void useAgentStore.getState().loadAgents();
    if (parts.has("machines") && !covered.has("machines")) void useMachineStore.getState().loadMachines();
    // Sync mode: members and sidebar order come through sync/changes.
    if (parts.has("servers") && !covered.has("server_order")) void useServerStore.getState().loadServers({ listOnly: true });
  }
}

function ensureReconnectReload() {
  if (!reconnectReload) {
    const delayMs = Math.floor(Math.random() * reconnectReloadJitterMs);
    reconnectReload = {
      timer: setTimeout(runReconnectReload, delayMs),
      parts: new Set(),
      deferred: [],
    };
  }
  return reconnectReload;
}

/** One delay per reconnect: every part asked for loads together when it ends. */
function scheduleReconnectReload(part: ReconnectReloadPart) {
  ensureReconnectReload().parts.add(part);
}

function cancelReconnectReload() {
  if (reconnectReload) {
    clearTimeout(reconnectReload.timer);
    reconnectReload = null;
  }
  dropOwedReads();
}

/** Test seam: override the reconnect jitter window and drop any pending reload. */
export function __setReconnectReloadJitterMsForTests(ms?: number): () => void {
  const previous = reconnectReloadJitterMs;
  reconnectReloadJitterMs = ms ?? RECONNECT_RELOAD_JITTER_MS_DEFAULT;
  return () => {
    reconnectReloadJitterMs = previous;
    cancelReconnectReload();
  };
}

// Incremental sync (#triage:458d78f1). With a cursor, a
// reconnect pulls GET /api/sync/changes after a 0–2 s delay (Ray/Tenny) and
// reloads only what changed; agents (presence is not in the change log) and
// the server list (not in it yet) still reload after the 0–20 s jitter. No
// cursor yet, or a dropped one: take a cursor, then the full jittered reloads.
const SYNC_PULL_JITTER_MS_DEFAULT = 2_000;
let syncPullJitterMs = SYNC_PULL_JITTER_MS_DEFAULT;
let mainLayoutSync: SyncChangesSession | null = null;
let syncPullTimer: ReturnType<typeof setTimeout> | null = null;

function syncChangesEnabled(serverId: string | undefined): serverId is string {
  return !!serverId && hasChatSurfaces();
}

function buildSyncSnapshotLoaders(serverId: string): SyncSnapshotLoaders {
  const epoch = () => useServerStore.getState().serverEpoch;
  return {
    channels: {
      settleInFlight: async () => {
        await Promise.all([
          settleInFlightLoader(`channels:${serverId}:${epoch()}`),
          settleInFlightLoader(`dm-channels:${serverId}:${epoch()}`),
        ]);
      },
      load: async () => {
        await Promise.all([
          useChannelStore.getState().loadChannels(),
          useChannelStore.getState().loadDMChannels(),
        ]);
      },
    },
    channel_members: { load: () => notifyAllChannelMembersChanged() },
    server_members: {
      settleInFlight: () => settleInFlightLoader(`members:${serverId}`),
      load: () => useServerStore.getState().loadMembers(),
    },
    agents: { settleInFlight: settleAgentsLoadInFlight, load: () => useAgentStore.getState().loadAgents() },
    inbox: { load: (reason) => useInboxStore.getState().loadInbox({ reset: true, background: true, reason }) },
    unread: { load: () => useMessageStore.getState().loadUnreadCounts() },
    followed_threads: { load: (reason) => useThreadStore.getState().loadFollowedThreads(reason) },
    machines: {
      settleInFlight: () => settleInFlightLoader(`machines:${serverId}:${epoch()}`),
      load: () => useMachineStore.getState().loadMachines(),
    },
    sidebar_order: {
      settleInFlight: () => settleInFlightLoader(`sidebar-order:${serverId}:${epoch()}`),
      load: () => useServerStore.getState().loadSidebarOrder(),
    },
    server_order: { load: () => useServerStore.getState().loadServers({ fresh: true, listOnly: true }) },
  };
}

/**
 * A read this tab can't count from loaded messages: when it reaches the
 * newest activity the conversation's Activity row shows, nothing there is
 * unread any more, so clear it here (sidebar, Activity, followed thread)
 * without reading anything. Otherwise (or with no row to judge by) false.
 */
function clearIfReadCoversRows(channelId: string, readSeq: number): boolean {
  const latest = useInboxStore.getState().conversationLatestReadableSeq(channelId);
  if (latest === null || compareActivitySeq(String(readSeq), latest) < 0) return false;
  // Same guard as applyReadStateUpdate: a followed thread with a newer reply.
  const thread = useThreadStore.getState().followedThreads.find((t) => t.threadChannelId === channelId);
  if (thread?.latestActivitySeq != null && compareActivitySeq(thread.latestActivitySeq, String(readSeq)) > 0) return false;
  useMessageStore.getState().clearUnread(channelId);
  useThreadStore.getState().clearThreadUnreadLocally(channelId);
  return true;
}

/**
 * Patch one conversation from the state a sync change carries (Activity
 * multi-device spec v3 §4.2). False: read the lists again.
 * - read: the same ledger as a realtime `read_state:updated` (one version
 *   counter, so a read seen both ways applies once), then the rows: counted
 *   from loaded messages, or cleared when the read covers them.
 * - done: dropped from Activity when the Done covers the row.
 * - undone, follow: need the row as the server has it (single-row read: next step).
 */
/**
 * Removing a row on another device's Done compares the change's
 * `doneFrontierSeq` with the row's `latestActivitySeq` (inboxStore
 * applyRemoteDone). On since Ray's parity test passed against the real view
 * (#11685; Tenny's condition). Set false to read the lists instead.
 */
const APPLY_REMOTE_DONE_LOCALLY = true;

function applySyncConversation(serverId: string, channelId: string, state: SyncConversationState): boolean {
  if (state.done?.done === false || state.follow) return false;
  if (state.done && !APPLY_REMOTE_DONE_LOCALLY) return false;
  if (state.read) {
    applyReadStateUpdate({
      serverId,
      scopeId: channelId,
      maxReadSeq: state.read.readSeq,
      readStateVersion: state.read.readStateVersion,
      ...(state.read.markedUnread ? { markedUnread: true as const } : {}),
    });
    // Newer or not (a realtime `read_state:updated` may have brought it
    // first), bring the rows to the read the ledger holds.
    const accepted = getAcceptedReadState(serverId, channelId);
    if (!accepted) return false;
    const projection = useMessageStore.getState().applyReadStateProjection(channelId);
    if (projection.complete) {
      useInboxStore.getState().applyReadStateProjection(channelId, projection);
      useThreadStore.getState().applyReadStateProjection(channelId, projection);
    } else if (!clearIfReadCoversRows(channelId, accepted.maxReadSeq)) {
      return false;
    }
  }
  if (state.done && !useInboxStore.getState().applyRemoteDone(channelId, state.done.doneFrontierSeq)) return false;
  return true;
}

function ensureMainLayoutSync(serverId: string): SyncChangesSession {
  // Never pull one server's changes with another's cursor, even if a server
  // switch someday stops tearing the bridge down.
  if (mainLayoutSync && mainLayoutSync.serverId !== serverId) disposeMainLayoutSync();
  if (!mainLayoutSync) {
    mainLayoutSync = new SyncChangesSession({
      serverId,
      loaders: buildSyncSnapshotLoaders(serverId),
      refreshChannel: (channelId) => useChannelStore.getState().ensureChannel(channelId, { refresh: true }),
      notifyChannelMembers: notifyChannelMembersChanged,
      applyConversation: (channelId, state) => applySyncConversation(serverId, channelId, state),
      // RFC 082 §4.4: a message changed in place while this tab was away (a card update): replace it by id.
      applyMessage: (row) => applyMessageUpdated(row, captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId)),
      // Cursor dropped (by any pull, the session's delayed one too): read everything (jittered).
      onCursorDropped: () => {
        scheduleReconnectReload("snapshot");
        scheduleReconnectReload("channels");
      },
      // Same jittered batch as this reconnect's agents/servers reload.
      deferReset: (run, snapshots) => {
        ensureReconnectReload().deferred.push({ run, snapshots, session: mainLayoutSync });
      },
    });
  }
  return mainLayoutSync;
}

/** `maxDelayMs`: the random spread (reconnects reach many clients at once). */
function scheduleSyncPull(session: SyncChangesSession, maxDelayMs = syncPullJitterMs) {
  if (syncPullTimer) return;
  syncPullTimer = setTimeout(() => {
    syncPullTimer = null;
    if (mainLayoutSync !== session) return;
    void session.pull();
  }, Math.floor(Math.random() * maxDelayMs));
}

/**
 * `sync:changed` (spec §4.1a): the person's own read / Done / follow changed,
 * on another device or tab. Only a reminder to pull: the change log has the
 * data. Sent to one person's devices, so no spread.
 */
function handleSyncChanged() {
  const serverId = useServerStore.getState().current?.id;
  const session = mainLayoutSync;
  if (!session?.hasCursor || session.serverId !== serverId || !syncChangesEnabled(serverId)) return;
  scheduleSyncPull(session, 0);
}

function disposeMainLayoutSync() {
  if (syncPullTimer) {
    clearTimeout(syncPullTimer);
    syncPullTimer = null;
  }
  mainLayoutSync?.dispose();
  mainLayoutSync = null;
}

/** Test seam: override the pull delay; restoring disposes the session. */
export function __setSyncPullJitterMsForTests(ms?: number): () => void {
  const previous = syncPullJitterMs;
  syncPullJitterMs = ms ?? SYNC_PULL_JITTER_MS_DEFAULT;
  return () => {
    syncPullJitterMs = previous;
    disposeMainLayoutSync();
  };
}

/** Test seam: override the fallback delay and restore any stray timer. */
export function __setBootUnreadFallbackMsForTests(ms?: number): () => void {
  const previous = bootUnreadFallbackMs;
  bootUnreadFallbackMs = ms ?? BOOT_UNREAD_FALLBACK_MS_DEFAULT;
  return () => {
    bootUnreadFallbackMs = previous;
    cancelBootUnreadFallback();
    cancelBootConnectFallback();
  };
}

function navigateRootRoute() {
  if (!bridgeNavigate) {
    console.warn(
      "[SocketBridge] Cannot navigate after server membership removal before router is ready",
    );
    return;
  }
  bridgeNavigate("/", { replace: true });
}

function hasStoredAuthSession() {
  if (
    typeof localStorage === "undefined" ||
    typeof localStorage.getItem !== "function"
  )
    return false;
  return !!(
    localStorage.getItem("slock_access_token") &&
    localStorage.getItem("slock_refresh_token")
  );
}

function bootstrapMainLayoutRealtimeBridge(
  transport: MainLayoutRealtimeTransport,
) {
  transport.reconnectSocket();
  // A host-shell embed has no chat surface: it keeps the socket (computer
  // status and upgrade progress are pushed) and the connect snapshot's
  // machines / agents / servers, and skips the chat-only loads.
  if (!hasChatSurfaces()) {
    armBootConnectFallback();
    return;
  }
  useChannelStore.getState().loadChannels();
  useChannelStore.getState().loadDMChannels();
  // machines / agents / followedThreads are deliberately NOT loaded here:
  // the connect snapshot (reconnectSnapshot) is the pinned owner of that set
  // (reconnectNoDuplicateLoads: "what only it owns"), and it fires on the
  // first connect too — this copy was the duplicate boot fetch. A bounded
  // fallback (armBootConnectFallback) covers a socket that never connects.
  //
  // unreadCounts / inbox are also NOT fetched inline: they race the room
  // joins (connect-time copy is strictly worse — rooms:joined is the
  // authority). Instead we arm a bounded fallback: if no rooms:joined lands
  // within the window (socket never joins, e.g. offline degraded mode), the
  // fallback issues exactly one load so the badges/inbox are not empty.
  armBootUnreadFallback();
  armBootConnectFallback();
  // Not needed for the first screen (boot/deferredUi).
  afterFirstScreen(() => {
    void useSavedStore.getState().loadSaved();
    void useAnnouncementStore.getState().load();
  }, "bootstrap:saved+announcements");
}

function executeScheduledMachineReconcile() {
  const transition = useMachineStore
    .getState()
    .requestMachineReconcile("scheduled");
  if (transition.recoveryAction !== "reload-machines-and-agents") return;
  useMachineStore.getState().loadMachines();
  useAgentStore.getState().resetActivitySeq();
  useAgentStore.getState().loadAgents();
}

/** The Artifacts handler's load failed and was logged (once per page). */
let artifactHandlerLoadFailureLogged = false;

export function buildMainLayoutSocketBindings(
  socket: MainLayoutSocketBridgeSocket,
  scheduleInboxRefresh: ScheduleInboxRefresh,
  syncVisibleScopes: () => Promise<void>,
  recordHeartbeat: SocketHandler,
  recordConnect: SocketHandler,
): MainLayoutSocketBinding[] {
  const bindingReceiverPrivateIngressContext = captureReceiverPrivateIngressContext(
    useMessageStore.getState().currentUserId,
  );

  const messageNew = (msg: Message) => {
    const messageStore = useMessageStore.getState();
    const accepted = !messageStore.channelMessages[msg.channelId]?.some((existing) => existing.id === msg.id);
    messageStore.addMessage(msg, "channel-room");
    clearAgentTypingForMessage(msg);
    // My own reply reopens a DM I had closed, on every device (task #59): the
    // server already took it off my hidden list (same rule: a chat message I
    // sent myself, not one an assistant sent for me). A reply in a DM thread
    // reaches the other devices with the next sidebar-order load.
    if (
      msg.senderType === "user"
      && msg.senderId === messageStore.currentUserId
      && msg.messageType !== "system"
      && (msg as { delegatedBy?: unknown }).delegatedBy == null
    ) {
      useServerStore.getState().reopenDmAfterOwnReply(msg.channelId);
    }
    if (accepted) applyTaskConversationReply(msg);
    if (accepted) applyLiveMessageActivity(msg, scheduleInboxRefresh);
    else {
      // My own send can land from its HTTP answer first, another from a catch-up: the row still
      // needs it, and (#244) its first live patch counts unless its row already counted it.
      const live = storedMessageLive(msg);
      if (live) useInboxStore.getState().receiveThreadReply(msg, live);
      patchActivityChannelRow(msg, live);
      applyMessageChannelActivity(msg, scheduleInboxRefresh, "message_echo");
    }
  };

  // Merge-only updates for existing messages (task field changes).
  // Does NOT create new messages or increment unread counts.
  const threadReplyUpdated = (msg: Message) => applyThreadReplyUpdate(msg, bindingReceiverPrivateIngressContext);
  // In place, by id (a card message's update, RFC 082; a retraction, RFC 077). The sync log's `message` entity takes the same path.
  const messageUpdated = (msg: Message) => applyMessageUpdated(msg, bindingReceiverPrivateIngressContext);


  const readStateUpdated = (payload: unknown) => {
    const update = normalizeReadStateUpdated(payload);
    if (!update) return;
    applyReadStateUpdate(update);
    refreshServerUnreadSummaryAfterRead();
  };

  const readStateUpdatedBulk = (payload: unknown) => {
    for (const update of normalizeReadStateUpdatedBulk(payload)) {
      applyReadStateUpdate(update);
    }
    refreshServerUnreadSummaryAfterRead();
  };

  // Agent typing line: who is about to post into a channel this socket has
  // joined. Another workspace's event is not ours to show.
  const agentTyping = (payload: unknown) => {
    const event = readAgentTypingEvent(payload);
    if (!event) return;
    const currentServerId = useServerStore.getState().current?.id;
    if (currentServerId && event.serverId !== currentServerId) return;
    useAgentTypingStore.getState().apply(event);
  };

  // `serverSeq` (optional) is the monotonic per-agent counter used
  // for out-of-order push dedup. Old servers omit it; agentStore
  // treats undefined as "always apply" (== pre-PR behaviour).
  // #engineering:72283cf7 task #340 PR B
  const agentActivity = (data: {
    agentId: string;
    activity: string;
    activityKind?: string;
    detail?: string;
    detailKind?: string;
    timestamp?: number;
    entries?: TrajectoryEntry[];
    serverSeq?: number;
    launchId?: string; clientSeq?: number; probeId?: string;
    isHeartbeat?: boolean;
    isRefreshOnly?: boolean;
    deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
    wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
    spawnFailure?: SpawnFailureActivityDiagnostic;
    toolStuck?: ToolStuckActivityDiagnostic;
    credentialHold?: CredentialHoldActivityDiagnostic;
    errorCode?: RuntimeErrorCode; // #wg-rbac:#57: on an error activity, for every viewer
  }) => {
    const joinKeys = { launchId: data.launchId, clientSeq: data.clientSeq, probeId: data.probeId };
    const traceJoin = { clientEventId: mintAgentActivityClientEventId(), arrivedAtMs: Date.now() };
    traceAgentActivitySocketReceived({
      agentId: data.agentId,
      activity: data.activity,
      // Read before updateActivity below: an unchanged activity is a routine push.
      previousActivity: useAgentStore.getState().agentActivities[data.agentId]?.activity ?? null,
      activityKind: data.activityKind,
      detail: data.detail,
      detailKind: data.detailKind,
      hasEntries: Boolean(data.entries?.length),
      serverSeq: data.serverSeq,
      timestamp: data.timestamp,
      isHeartbeat: data.isHeartbeat,
      isRefreshOnly: data.isRefreshOnly,
      ...joinKeys,
      join: traceJoin,
    });
    useAgentStore.getState().updateActivity(
      data.agentId,
      data.activity,
      data.detail || "",
      data.serverSeq,
      data.timestamp,
      joinKeys,
      data.activityKind,
      data.detailKind,
      traceJoin,
      data.isHeartbeat,
      data.isRefreshOnly,
      data.deliveryConsumption,
      data.wakeCrashLoop,
      data.spawnFailure,
      data.toolStuck,
      data.credentialHold,
      data.errorCode,
    );
    // #proj-raft-computer:#48: the stored error is not pushed; re-read it (bounded).
    observeAgentActivityForErrorRecord(data);
    const agents = useAgentStore.getState().agents;
    const currentServerId = useServerStore.getState().current?.id;
    const agent = agents.find((candidate) => candidate.id === data.agentId);
    // The directory's legacy rows omit serverId; hydrated peer profiles do
    // carry it. Joint presence still updates profiles, not this server's summary.
    if (currentServerId && agent && (!agent.serverId || agent.serverId === currentServerId)) {
      useLiveAgentActivityStore.getState().recordStatusActivity(data, agents);
    }
    if (data.entries && data.entries.length > 0) {
      useAgentStore
        .getState()
        .appendTrajectory(data.agentId, data.entries, data.timestamp, joinKeys, data.serverSeq, traceJoin);
    }
  };

  // The coarse state of an agent this tab does not subscribe to
  // (store/agentActivitySubscriptions.ts): status dots, the sidebar and the
  // Working-now faces run on it. A subscribed agent's detailed push carries
  // the same state, so its coarse one is left alone.
  const agentActivityState = (data: AgentActivityStatePayload) => {
    if (typeof data?.agentId !== "string" || typeof data.activity !== "string") return;
    if (isAgentActivitySubscribed(data.agentId)) return;
    useAgentStore.getState().updateActivity(data.agentId, data.activity, "", data.serverSeq, data.timestamp);
    const agents = useAgentStore.getState().agents;
    const currentServerId = useServerStore.getState().current?.id;
    const agent = agents.find((candidate) => candidate.id === data.agentId);
    if (currentServerId && agent && (!agent.serverId || agent.serverId === currentServerId)) {
      useLiveAgentActivityStore.getState().recordStatusActivity({ agentId: data.agentId, activity: data.activity, timestamp: data.timestamp, fromCoarseState: true }, agents);
    }
  };

  const agentSession = (data: {
    agentId: string;
    sessionId: string | null;
  }) => {
    useAgentStore.getState().updateAgentSession(data.agentId, data.sessionId);
  };

  const executeMachineReloadRecovery = async (
    machineId: string,
    statusVersion?: number,
  ) => {
    const reload = () => {
      void useMachineStore.getState().loadMachines();
      void useAgentStore.getState().loadAgents();
    };
    if (!failpoints.enabled) {
      reload();
      return;
    }

    await failpoints.hit(
      "web.machineStatusRecovery.onlineAuthoritativeReload",
      { machineId, statusVersion: statusVersion ?? null },
      async () => reload(),
    );
  };

  const machineStatus = (data: {
    machineId: string;
    status: "online" | "offline";
    statusVersion?: number;
  }) => {
    const transition = useMachineStore
      .getState()
      .applyMachineStatusEvent(data.machineId, data.status, data.statusVersion);
    if (transition.recoveryAction === "reload-machines-and-agents") {
      void executeMachineReloadRecovery(data.machineId, data.statusVersion);
    }
  };

  const machineReconcile = (reason: "machine-updated") => {
    const transition = useMachineStore
      .getState()
      .requestMachineReconcile(reason);
    if (transition.recoveryAction === "reload-machines") {
      void useMachineStore.getState().loadMachines();
      return;
    }
    if (transition.recoveryAction === "reload-machines-and-agents") {
      void executeMachineReloadRecovery("all", undefined);
    }
  };

  const machineCapabilities = (data: {
    machineId: string;
    runtimes?: string[];
    runtimeVersions?: Record<string, string>;
    hostname?: string;
    os?: string;
    hostProvider?: string | null;
    osRelease?: string | null;
    deviceClass?: string | null;
    daemonVersion?: string;
    computerVersion?: string | null;
    runtimeDetection?: { status: "pending" | "complete" | "incomplete"; unfinishedRuntimes?: string[]; reason?: "deadline" | "child_failed" | "cancelled"; updatedAtMs?: number } | null;
    versionGate?: ComputerVersionGate | null;
  }) => {
    useMachineStore
      .getState()
      .updateMachineCapabilities(
        data.machineId,
        data.runtimes,
        data.hostname,
        data.os,
        data.daemonVersion,
        data.computerVersion,
        data.runtimeVersions,
        data.runtimeDetection,
        { hostProvider: data.hostProvider, osRelease: data.osRelease, deviceClass: data.deviceClass, versionGate: data.versionGate },
      );
  };

  // Remote upgrade v2: the server settled or expired a request; the machine
  // list projection carries the result, so reload it.
  const machineUpgradeRequest = (_data: { machineId: string }) => {
    void useMachineStore.getState().loadMachines();
  };

  const computerRestartDone = (data: {
    machineId: string;
    requestId: string;
    ok: boolean;
    error?: string;
  }) => {
    useMachineStore
      .getState()
      .completeComputerRestart(data.machineId, data.requestId, data.ok, data.error);
    if (data.ok) void useMachineStore.getState().loadMachines();
  };

  const refreshMembersForServer = (data: { serverId?: string; userId?: string }) => {
    const currentServerId = useServerStore.getState().current?.id;
    if (data?.serverId && data.serverId !== currentServerId) return;
    void useServerStore.getState().loadMembers();
    if (data?.userId && data.userId === useMessageStore.getState().currentUserId) {
      // A self role transition changes route capabilities and the channel
      // projection. Re-read both immediately instead of waiting for reconnect.
      void useServerStore.getState().loadServers();
      void useChannelStore.getState().loadChannels();
      void useChannelStore.getState().loadDMChannels();
    }
    notifyAllChannelMembersChanged();
  };

  const notificationPrefsUpdated = (payload: unknown) => {
    // Unified notification settings (contract §2.3): account / channel /
    // thread levels live only in the notification settings store, which drops
    // stale versions itself. A `server` frame also carries the legacy prefs
    // (serverPushMuted / serverPushMode) the server row still mirrors.
    const type = payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;
    if (type === "account" || type === "channel" || type === "thread" || type === "server") {
      const applied = useNotificationSettingsStore.getState().applyPrefsUpdate(payload);
      // A thread's level is its follow state: the followed-threads list follows it.
      if (applied && type === "thread") void useThreadStore.getState().loadFollowedThreads();
      if (type !== "server") return;
    }
    const update = readNotificationPrefsUpdate(payload);
    if (!update) return;
    const result = consumeNotificationPrefsUpdateWithSyncCore(update);
    if (result.kind === "duplicate_dropped" || result.kind === "no_op") return;
    applyNotificationPrefsUpdate(result.update);
  };

  const messageDisplayPrefsUpdated = (payload: unknown) => {
    const update = readMessageDisplayPrefsUpdate(payload);
    if (!update) return;
    useChannelStore.getState().setMessageDisplayPrefsState(update.channelId, update.prefs);
  };

  const applyNotificationPrefsUpdate = (update: NotificationPrefsUpdate) => {
    if (update.type === "channel") {
      useChannelStore.getState().setActivityMuteState(update.channelId, update.state);
      return;
    }
    const existingServer = useServerStore.getState().servers.find((server) => server.id === update.serverId)
      ?? (useServerStore.getState().current?.id === update.serverId ? useServerStore.getState().current : undefined);
    if (
      existingServer?.notificationPrefsVersion !== undefined
      && update.prefsVersion !== undefined
      && update.prefsVersion < existingServer.notificationPrefsVersion
    ) return;
    useNotificationSettingsStore.getState().noteLegacyServerMuted(update.serverId, update.serverPushMuted);
    useServerStore.getState().applyServerPatch({
      id: update.serverId,
      serverPushMuted: update.serverPushMuted,
      ...(update.prefsVersion === undefined ? {} : { notificationPrefsVersion: update.prefsVersion }),
    });
    useMessageStore.getState().loadUnreadCounts();
    dispatchServerNotificationPrefsUpdated({
      serverId: update.serverId,
      serverPushMuted: update.serverPushMuted,
      prefsVersion: update.prefsVersion,
    });
  };

  const serverMembershipRemoved = async (data: { serverId?: string }) => {
    if (!data?.serverId) return;
    const removedCurrent = await useServerStore.getState().handleMembershipRemoved(data.serverId);
    if (removedCurrent) navigateRootRoute();
  };

  // Removing a member revokes socket access before the route emits
  // server:membership-removed, so that event cannot reach the removed user.
  // The automatic reconnect is then rejected at the handshake, and that
  // rejection is the removal signal. handleMembershipRemoved re-reads the
  // server list, so a stale rejection cannot evict a current membership.
  const connectRejected = (error: { message?: unknown } | null | undefined) => {
    // A Server requiring single sign-on manages this person and this session no longer counts
    // (or never did). Any API answer then names that Server, and the client sends them there.
    if (error?.message === SOCKET_SSO_REQUIRED_ERROR) {
      void api.get("/auth/me").catch(() => {});
      return;
    }
    if (error?.message !== SOCKET_NOT_SERVER_MEMBER_ERROR) return;
    const serverId = useServerStore.getState().current?.id;
    if (serverId) void serverMembershipRemoved({ serverId });
  };

  const threadUpdated = (data: {
    parentMessageId: string;
    threadChannelId: string;
    replyCount: number;
    lastReplyAt: string | null;
    participantIds: string[];
    unreadCount?: number;
    firstUnreadMessageId?: string | null;
    latestReply?: Message;
    syncCoreReplyWindow?: unknown;
  }) => {
    if (!isReceiverPrivateIngressContextCurrent(bindingReceiverPrivateIngressContext)) return;
    noteForumThreadUpdated(data); // forum-style channels (forumThreadReplySocket)
    // The channel view may not hold the thread's room: its reply lands here.
    if (data.latestReply?.senderType === "agent" && typeof data.parentMessageId === "string") {
      useAgentTypingStore.getState().clearForThreadReply(data.latestReply.senderId, data.parentMessageId);
    }

    // Inline reply previews have one authority regardless of the broader
    // messages rollout flag: producer-eligible frames sole-apply through the
    // replies Sync Core, while ineligible legacy wire shapes fail open.
    let effectiveReplyCount = data.replyCount;
    {
      const replyResult = consumeThreadUpdatedWithSyncCore(data, {
        serverId: bindingReceiverPrivateIngressContext.serverId,
        principalId: bindingReceiverPrivateIngressContext.principalId,
        ingressContext: bindingReceiverPrivateIngressContext,
      });
      if (
        replyResult.kind === "shadow_fail_open"
        && replyResult.frame
      ) {
        handleThreadUpdatedForReplies(data);
      } else if (replyResult.kind === "applied") {
        useThreadStore.getState().applyReplyScope(replyResult.parentMessageId, replyResult.scope);
        effectiveReplyCount = replyResult.scope.replyCount;
      } else if (replyResult.kind === "rebaseline_requested") {
        if (replyResult.ingressContext.serverId && replyResult.ingressContext.principalId) {
          void requestThreadRepliesRebaselineSnapshot({
            parentMessageId: replyResult.parentMessageId,
            parentChannelId: replyResult.parentChannelId,
            threadChannelId: replyResult.threadChannelId,
            epoch: replyResult.epoch,
          }).then((rawSnapshot) => {
            if (!rawSnapshot) {
              releaseThreadRepliesRebaselineRequest(replyResult.request);
              return;
            }
            if (!isReceiverPrivateIngressContextCurrent(replyResult.ingressContext)) {
              releaseThreadRepliesRebaselineRequest(replyResult.request);
              return;
            }
            const snapshot = hydrateThreadRepliesRebaselineSnapshotWithSyncCore({
              serverId: replyResult.ingressContext.serverId!,
              principalId: replyResult.ingressContext.principalId!,
              parentMessageId: replyResult.parentMessageId,
              threadChannelId: replyResult.threadChannelId,
              replies: rawSnapshot.replies,
              replyCount: rawSnapshot.replyCount,
              historyLimited: rawSnapshot.historyLimited,
              watermark: rawSnapshot.watermark,
              epoch: rawSnapshot.epoch,
              request: replyResult.request,
            });
            if (!snapshot.scope) return;
            if (snapshot.outcome.kind !== "applied") return;
            if (!snapshot.presentation) return;
            const presentation = snapshot.presentation;
            const state = useThreadStore.getState();
            const replyUnread = liveReplyUnread(presentation.threadChannelId, presentation.latestReply);
            const counts = replyUnread === "unread";
            const existingSummary = state.summaries[presentation.parentMessageId];
            const followed = state.followedThreads.find(
              (thread) => thread.threadChannelId === presentation.threadChannelId,
            );
            const unreadCount = presentation.unreadCount
              ?? (replyUnread === "read"
                ? 0
                : (followed?.unreadCount ?? existingSummary?.unreadCount ?? 0) + (counts ? snapshot.pendingEventCount : 0));
            state.hydrateSummariesWithReplyScopes(
              {
                [replyResult.parentMessageId]: {
                  threadChannelId: replyResult.threadChannelId,
                  replyCount: snapshot.scope.replyCount,
                  lastReplyAt: presentation.lastReplyAt,
                  participantIds: presentation.participantIds,
                  unreadCount,
                  firstUnreadMessageId: presentation.firstUnreadMessageId
                    ?? (unreadCount > 0
                      ? (existingSummary?.firstUnreadMessageId ?? null)
                      : null),
                },
              },
              { [replyResult.parentMessageId]: snapshot.scope },
            );
            if (followed) {
              state.updateFollowedThread(replyResult.threadChannelId, {
                replyCount: snapshot.scope.replyCount,
                lastReplyAt: presentation.lastReplyAt,
                ...(replyUnread === "read" ? {} : { unreadCount }),
                ...(counts && replyMentionsCurrentUser(presentation.latestReply) ? { hasMention: true } : {}),
                ...(counts && followed.unreadCount === 0 && presentation.latestReply
                  ? { firstUnreadMessageId: presentation.latestReply.id }
                  : {}),
              });
            } else {
              followedThreadsRefresh.request();
            }
            if (presentation.latestReply) {
              releaseActivityReadHoldForLiveMessage(presentation.latestReply);
            }
            const suppressActivity = presentation.latestReply
              ? isMessageActivitySuppressedByMute(presentation.latestReply)
              : false;
            if (!suppressActivity) {
              if (presentation.latestReply) {
                useInboxStore.getState().receiveThreadReply(presentation.latestReply);
              }
              useInboxStore.getState().updateThreadActivityMeta(
                replyResult.threadChannelId,
                snapshot.scope.replyCount,
                presentation.lastReplyAt,
              );
              scheduleInboxRefresh("thread_reply_rebaseline");
            }
          }).catch(() => {
            releaseThreadRepliesRebaselineRequest(replyResult.request);
          });
        }
        return;
      } else if (
        replyResult.kind === "duplicate_dropped" ||
        replyResult.kind === "rebaseline_pending" ||
        replyResult.kind === "dropped"
      ) {
        return;
      }
    }

    const threadState = useThreadStore.getState();
    const replyUnread = liveReplyUnread(data.threadChannelId, data.latestReply);
    const counts = replyUnread === "unread";
    const existingSummary = threadState.summaries[data.parentMessageId];
    const followed = threadState.followedThreads.find(
      (t) => t.threadChannelId === data.threadChannelId,
    );
    const unreadCount =
      data.unreadCount ??
      (replyUnread === "read"
        ? 0
        : (followed?.unreadCount ?? existingSummary?.unreadCount ?? 0) + (followed && counts ? 1 : 0));
    threadState.updateSummary(data.parentMessageId, {
      threadChannelId: data.threadChannelId,
      replyCount: effectiveReplyCount,
      lastReplyAt: data.lastReplyAt,
      participantIds: data.participantIds,
      unreadCount,
      firstUnreadMessageId:
        data.firstUnreadMessageId ??
        (unreadCount > 0
          ? (existingSummary?.firstUnreadMessageId ?? null)
          : null),
    });
    // Update followed threads list (one more unread unless it is read on screen or the person's own)
    if (followed) {
      threadState.updateFollowedThread(data.threadChannelId, {
        replyCount: effectiveReplyCount,
        lastReplyAt: data.lastReplyAt,
        ...(counts ? { unreadCount: followed.unreadCount + 1 } : {}),
        ...(counts && replyMentionsCurrentUser(data.latestReply) ? { hasMention: true } : {}),
        // A reply into a fully read thread is its first unread one.
        ...(counts && followed.unreadCount === 0 && data.latestReply
          ? { firstUnreadMessageId: data.latestReply.id }
          : {}),
      });
    } else {
      // The backend can auto-follow a thread for the current user when
      // another actor creates or replies in it; refresh sidebar state.
      followedThreadsRefresh.request();
    }
    if (data.latestReply) releaseActivityReadHoldForLiveMessage(data.latestReply);
    const suppressActivity = data.latestReply
      ? isMessageActivitySuppressedByMute(data.latestReply)
      : false;
    if (!suppressActivity) {
      const replyGap = isThreadReplyGap(data.threadChannelId, effectiveReplyCount);
      if (data.latestReply) useInboxStore.getState().receiveThreadReply(data.latestReply, liveActivityUnread(data.latestReply, "thread_reply"));
      useInboxStore.getState().updateThreadActivityMeta(
        data.threadChannelId,
        effectiveReplyCount,
        data.lastReplyAt,
      );
      scheduleInboxRefresh(replyGap ? "reply_gap" : "thread_reply");
    }
  };

  const threadFollowersUpdated = (data: { threadChannelId?: unknown } | null | undefined) => {
    if (typeof data?.threadChannelId !== "string") return;
    requestThreadAgentFollowers(data.threadChannelId, true);
    refreshWatchedFollowState(data.threadChannelId);
  };

  // The first catch-up of a page has no horizon yet: ask for one as soon as
  // the socket is up, before history loads, so a message that commits during
  // that load is still delivered by the next sync:resume. A server without
  // sync:horizon never answers and the client keeps today's behaviour.
  // Used only if the reply arrives before any history request goes out: socket
  // and HTTP are separate connections, so a reply that came first is the only
  // proof the server took the horizon before the history query ran (Ray). If
  // history went first, the first resume runs as today and returns a horizon.
  const requestStartingSyncHorizon = () => {
    if (useMessageStore.getState().syncHorizon !== null) return;
    socket.emit("sync:horizon", (response: { horizon?: unknown } | undefined) => {
      const horizon = response?.horizon;
      if (typeof horizon !== "string" || useMessageStore.getState().syncHorizon !== null) return;
      if (!startingSyncHorizonSafe()) return;
      useMessageStore.setState({ syncHorizon: horizon });
    });
  };

  // First connect / rooms:joined of this bridge (boot, server switch) load at
  // once; later ones on the same socket are reconnects and get the jitter.
  let connectedBefore = false;
  let roomsJoinedBefore = false;
  let listsJoinedBefore = false;
  // This reconnect is served by a sync pull: rooms:joined skips the channel reload.
  let reconnectBySync = false;

  const reconnectSnapshot = () => {
    recordConnect();
    if (typeof window !== "undefined") {
      (window as Window & { __slockRoomsJoined?: boolean }).__slockRoomsJoined =
        false;
    }
    // Clear per-agent serverSeq dedup before refetching state. The
    // server's monotonic counter resets on its own restart, so
    // holding stale lastSeen values across a reconnect could block
    // legitimate fresh pushes. `loadAgents()` then snaps the
    // baseline back to the server's authoritative state.
    // (#engineering:72283cf7 task #340 PR B)
    useAgentStore.getState().resetActivitySeq();
    // Read receipts: scope events may have been missed while disconnected.
    useReadReceiptStore.getState().forgetFreshness();
    // Typing lines from before the drop may have ended unseen; the server
    // re-sends the live ones on their next refresh.
    useAgentTypingStore.getState().clear();
    cancelBootConnectFallback();
    requestStartingSyncHorizon();
    const serverId = useServerStore.getState().current?.id;
    const syncOn = syncChangesEnabled(serverId);
    if (!syncOn) disposeMainLayoutSync();
    reconnectBySync = false;
    if (connectedBefore) {
      traceLiveSession("reconnect", "socket", "reconnected");
      scheduleReconnectReload("object_summaries");
      scheduleReconnectReload("feedback_unread");
      const session = syncOn ? ensureMainLayoutSync(serverId) : null;
      if (session?.hasCursor) {
        reconnectBySync = true;
        scheduleSyncPull(session);
        // Online status (agents, machines) is not in the change log.
        scheduleReconnectReload("agents");
        scheduleReconnectReload("machines");
        scheduleReconnectReload("servers");
      } else if (session) {
        // No cursor yet: how sync starts (the first connect takes none), or
        // an earlier start failed (e.g. the server's sync_changes_api is off).
        // Cursor first; then every list, jittered, each read after it.
        reconnectBySync = true;
        void session.start().then((ok) => {
          if (mainLayoutSync !== session) return;
          if (ok) {
            scheduleReconnectReload("resnapshot");
          } else {
            scheduleReconnectReload("snapshot");
            scheduleReconnectReload("channels");
          }
        });
      } else {
        scheduleReconnectReload("snapshot");
      }
    } else {
      connectedBefore = true;
      // Not jittered: a first connect is a page load or a server switch, not
      // a deploy's reconnect wave. The retain read may have answered before
      // this socket joined the user's room (feedbackUnreadState.ts).
      refreshFeedbackUnreadAfterReconnect();
      // The first connect takes no cursor: it reuses the lists the boot path
      // loaded moments ago (a cursor would have to re-read all of them, a
      // second GET /channels per page load). Sync starts at the first
      // reconnect, below. This is what production ran while
      // web_sync_changes_v0 existed: its flags were still loading here.
      loadConnectSnapshotSet("initial");
    }
    // Unread counts and the inbox are deliberately NOT loaded here. They are
    // loaded by `roomsJoined` below, and doing it twice per reconnect is not
    // defense in depth — the connect-time copy is strictly worse:
    //
    //   - the server emits `rooms:joined` only after it has finished
    //     `socket.join(...)` for every channel, commented there as "room setup
    //     is complete — safe to gap-sync". A fetch issued at connect races that
    //     window, so anything arriving before the joins land is missed by the
    //     pushes AND already stale in the response.
    //   - `activityRuntimeWiring.behavior.test.ts` pins
    //     `rooms:joined -> loadInboxReset -> loadInbox({reset:true})` as the
    //     single production chain for the inbox.
    //   - it cannot cover the no-server case either: `rooms:joined` is emitted
    //     inside `if (serverId)`, and both loads are no-ops without a server.
    // reconnectNoDuplicateLoads / syncChangesFirstLoad tests count the loads.
  };

  const roomsJoined = () => {
    noteRoomsJoinDegraded(false);
    cancelBootUnreadFallback();
    if (typeof window !== "undefined") {
      (window as Window & { __slockRoomsJoined?: boolean }).__slockRoomsJoined =
        true;
      window.dispatchEvent(new Event("slock:rooms-joined"));
    }
    // The server forgot this socket's agent activity rooms with the old connection.
    resubscribeAgentActivity();
    // And its read-progress watches (agent_read_progress_v0).
    rewatchAgentReadProgress();
    const { lastSeq, syncHorizon } = useMessageStore.getState();
    if (lastSeq > 0) {
      socket.emit("sync:resume", syncHorizon === null ? { lastSeq } : { lastSeq, sinceHorizon: syncHorizon });
    }
    void syncVisibleScopes();
    // Pings sent while away are lost (listChangedSocket.ts); not on the first join.
    if (listsJoinedBefore) requestListsAfterReconnect(useServerStore.getState().current?.id);
    listsJoinedBefore = true;
    // The server closes a connection when this user's channel eligibility
    // changed (visibility, guest policy, role) and no longer tells non-members
    // which channel they lost. The room set is authoritative once joined, so
    // re-read the channel list here rather than on connect. On a reconnect
    // that re-read takes the jitter: an eviction close looks the same as a
    // deploy drain to the client, so a lost channel can linger up to 20 s
    // (stale UI only; the server already refuses it).
    if (!hasChatSurfaces()) return;
    const listReason: ListFetchReason = roomsJoinedBefore ? "reconnect" : "initial";
    if (roomsJoinedBefore) {
      if (!reconnectBySync) scheduleReconnectReload("channels");
    } else {
      roomsJoinedBefore = true;
      const { current, serverEpoch } = useServerStore.getState();
      // The boot read is a moment old: the first join adds nothing to it.
      // A channel lost in that moment stays listed until the next
      // reconnect (display only: the server already refuses it).
      if (!(current && bootFresh(listReason, bootListKey.channels(current.id, serverEpoch)))) {
        void useChannelStore.getState().loadChannels();
      }
    }
    const loadUnreadAndInbox = () => {
      useMessageStore.getState().loadUnreadCounts();
      if (listReason !== "reconnect" || !heldWhileHidden("inbox_reset", () => loadInboxReset({ background: true, reason: listReason }))) loadInboxReset({ background: true, reason: listReason });
    };
    loadUnreadAndInbox();
  };

  const syncResumeResponse = ({
    messages,
    currentSeq,
    hasMore,
    horizon,
    horizonReset,
  }: {
    messages: Message[];
    currentSeq: number;
    hasMore: boolean;
    horizon?: string;
    horizonReset?: boolean;
  }) => {
    useMessageStore.getState().batchAddMessages(messages);
    requestResumeGapReread(messages, scheduleInboxRefresh);
    useMessageStore.setState((s) => ({
      lastSeq: Math.max(s.lastSeq, currentSeq),
      // The next catch-up starts from this one's horizon. Later pages (the
      // per-channel gap syncs below) never move it: they are scoped.
      syncHorizon: typeof horizon === "string" ? horizon : s.syncHorizon,
    }));
    // Too many missed messages, or too many that committed late to send
    // (horizonReset): re-read the visible scopes instead.
    if (hasMore || horizonReset) {
      useMessageStore.getState().loadUnreadCounts();
      void syncVisibleScopes();
    }
  };

  return [
    { event: "message:new", handler: messageNew },
    { event: "message:updated", handler: messageUpdated },
    // Workspace Artifacts S5: refetch the message so `savedAsArtifact` is this viewer's (flag-gated inside).
    // Loaded when the event comes, not with the bridge: the handler reaches the Artifacts app through its
    // index (its UI included), which the bridge needn't load. A failed load (a stale client after a deploy;
    // main.tsx offers the refresh) is logged once instead of surfacing as an unhandled rejection per event.
    // The handler itself never rejects (it catches its read), so only the load is caught here.
    {
      event: "artifact:attachment-saved",
      handler: (payload: unknown) => {
        void import("../components/message/artifactAttachmentSaved").then(
          ({ handleArtifactAttachmentSaved }) => handleArtifactAttachmentSaved(payload),
          (error: unknown) => {
            if (artifactHandlerLoadFailureLogged) return;
            artifactHandlerLoadFailureLogged = true;
            console.warn("[Socket] Couldn't load the artifact:attachment-saved handler", error);
          },
        );
      },
    },
    // First-party objects changed for this person (an event naming them, or
    // their own Done or read elsewhere): the summaries kept for that server
    // may be out of date, so mounted cards ask again, in one request; that
    // server's Activity (its object rows) is read again if it is this one,
    // and the cross-server unread summary in any case.
    {
      event: ACTIVITY_CHANGED_EVENT,
      handler: (payload: Partial<ActivityChangedEvent> | undefined) => {
        if (typeof payload?.serverId !== "string") return;
        invalidateObjectSummaries({ serverId: payload.serverId });
        if (payload.serverId === useServerStore.getState().current?.id) scheduleInboxRefresh("activity_changed");
        void useServerStore.getState().loadServerUnreadSummary();
      },
    },
    {
      event: "scope_read:updated",
      handler: (payload) => useReadReceiptStore.getState().consumeScopeUpdated(payload),
    },
    ...agentReadProgressSocketBindings(),
    { event: "read_state:updated", handler: readStateUpdated },
    { event: PRODUCT_FEEDBACK_UNREAD_EVENT, handler: acceptFeedbackUnreadPush },
    { event: "sync:changed", handler: handleSyncChanged },
    ...listChangedSocketBindings(),
    { event: "read_state:updated_bulk", handler: readStateUpdatedBulk },
    { event: "agent:activity", handler: agentActivity },
    { event: "agent:activity_state", handler: agentActivityState },
    { event: "agent:typing", handler: agentTyping },
    {
      // External-agent presence push (credential seen). Best-effort: `/agents`
      // serves the same `lastSeenAt` on every reconcile.
      event: "agent:seen",
      handler: (data: AgentSeenEvent) => {
        if (typeof data?.agentId !== "string" || typeof data.lastSeenAt !== "string") return;
        useAgentStore.getState().applyAgentSeen(data.agentId, data.lastSeenAt);
      },
    },
    { event: "agent:session", handler: agentSession },
    ...createChannelRealtimeBindings(socket, scheduleInboxRefresh),
    { event: "notification_prefs:updated", handler: notificationPrefsUpdated },
    { event: "message_display_prefs:updated", handler: messageDisplayPrefsUpdated },
    { event: "machine:status", handler: machineStatus },
    { event: "machine:capabilities", handler: machineCapabilities },
    {
      event: "machine:updated",
      handler: () => machineReconcile("machine-updated"),
    },
    { event: "machine:upgrade-request", handler: machineUpgradeRequest },
    { event: "computer:restart:done", handler: computerRestartDone },
    {
      event: "daemon:status",
      handler: (data: {
        daemonId: string;
        status: "online" | "offline";
        statusVersion?: number;
      }) => {
        useMachineStore.getState().applyMachineStatusEvent(
          data.daemonId,
          data.status,
          data.statusVersion,
        );
      },
    },
    {
      event: "agent:created",
      handler: () => {
        void useAgentStore.getState().loadAgents();
        notifyAllChannelMembersChanged();
      },
    },
    {
      event: "agent:deleted",
      handler: () => {
        void useAgentStore.getState().loadAgents();
        notifyAllChannelMembersChanged();
      },
    },
    {
      // A profile edit (name, avatar, description) made in another window or
      // on another device. Re-read the list so this window stops showing the old one.
      event: "agent:updated",
      handler: () => void reloadAgentsAfterServerChange(),
    },
    {
      // An agent from another server, seen through a joint channel, changed
      // its name or avatar. Only its actors-table row changes; the agent list
      // is this server's own, so it is not re-read.
      event: "actor:updated",
      handler: applyActorUpdatedEvent,
    },
    // A person changed their name or avatar: patch that member in place (no member-list reload).
    { event: "user:profile-updated", handler: applyUserProfileUpdatedEvent },
    { event: "server:plan-updated", handler: (data: { serverId?: string; plan?: string }) => {
      if (data?.serverId && typeof data.plan === "string") {
        useServerStore.getState().applyServerPatch({ id: data.serverId, plan: data.plan });
      } else {
        useServerStore.getState().loadServers();
      }
      useServerStore.getState().loadBilling();
      useServerStore.getState().loadUsage();
      // Saved messages behind the Free plan's 30-day window come back on Pro
      // (and leave on a downgrade): the list and its sidebar badge reload.
      void useSavedStore.getState().loadSaved();
    } },
    { event: "appearance:updated", handler: (data: { serverId?: unknown; theme?: unknown; themeDecor?: unknown }) => {
      // The member changed their theme here on another tab or device.
      if (typeof data?.serverId !== "string") return;
      const theme = data.theme === null ? null : isRaftThemeId(data.theme) ? data.theme : undefined;
      if (theme === undefined) return;
      useServerStore.getState().applyServerPatch({
        id: data.serverId,
        theme,
        ...(typeof data.themeDecor === "boolean" ? { themeDecor: data.themeDecor } : {}),
      });
    } },
    { event: "server:member-added", handler: refreshMembersForServer },
    { event: "server:member:left", handler: refreshMembersForServer },
    { event: "server:member-removed", handler: refreshMembersForServer },
    { event: "server:member-updated", handler: refreshMembersForServer },
    { event: "server:membership-removed", handler: serverMembershipRemoved },
    { event: "connect_error", handler: connectRejected },
    { event: "thread:updated", handler: threadUpdated },
    { event: "thread:reply_updated", handler: threadReplyUpdated },
    { event: "thread:followers-updated", handler: threadFollowersUpdated },
    { event: "connect", handler: reconnectSnapshot },
    { event: "rooms:joined", handler: roomsJoined },
    // Rooms not joined yet (the server retries): heartbeats re-read meanwhile.
    { event: "rooms:join_failed", handler: () => noteRoomsJoinDegraded(true) },
    { event: "sync:resume:response", handler: syncResumeResponse },
    { event: "heartbeat", handler: recordHeartbeat },
  ];
}

function applyLiveMessageActivity(
  msg: Message,
  scheduleInboxRefresh: ScheduleInboxRefresh,
) {
  releaseActivityReadHoldForLiveMessage(msg);
  if (isMessageActivitySuppressedByMute(msg)) return;
  // #244: its existing row's unread too, in place (the re-read stays for now).
  const live = liveActivityUnread(msg, "message_new");
  useInboxStore.getState().receiveThreadReply(msg, live);
  patchActivityChannelRow(msg, live);
  applyMessageChannelActivity(msg, scheduleInboxRefresh, "message_new");
}

/** Seq-guarded, so a repeat delivery is a no-op. Not past a mute: the served row stops there. */
function patchActivityChannelRow(msg: Message, live?: InboxLiveUnread): void {
  if (isMessageInMutedActivityRange(msg)) return;
  useInboxStore.getState().receiveChannelMessage(msg, live);
}

function releaseActivityReadHoldForLiveMessage(msg: Message): void {
  releaseActivityReadHoldForMessage(
    {
      serverId: useServerStore.getState().current?.id ?? null,
      principalId: useMessageStore.getState().currentUserId,
    },
    msg.channelId,
    msg.seq,
  );
}

function attachMainLayoutSocketBridge(
  socket: MainLayoutSocketBridgeSocket,
  syncVisibleScopes: () => Promise<void>,
): () => void {
  // Realtime activity is throttled leading+trailing in the inbox store (task
  // #33); every socket-driven Activity reload goes through that one gate.
  const scheduleInboxRefresh = requestInboxBackgroundRefresh;

  // P2: Application-layer heartbeat with seq -- passive gap detection.
  let lastHeartbeatTime = Date.now();
  let lastServerEventTime = Date.now();
  const markServerActivity = () => {
    lastServerEventTime = Date.now();
  };
  const resetHeartbeatTimes = () => {
    const now = Date.now();
    lastHeartbeatTime = now;
    lastServerEventTime = now;
  };
  const recordHeartbeat = ({ seq: serverSeq }: { seq: number; ts: number }) => {
    lastHeartbeatTime = Date.now();
    if (heartbeatNeedsScopeSync(serverSeq, useMessageStore.getState().lastSeq, visibleScopeIds(getCurrentChannelId()), channelOwesGapFill)) void syncVisibleScopes();
  };

  const bindings = buildMainLayoutSocketBindings(
    socket,
    scheduleInboxRefresh,
    syncVisibleScopes,
    recordHeartbeat,
    resetHeartbeatTimes,
  );
  const cleanupMainLayoutBridge = installSocketBridge(socket, "main-layout", bindings);
  socket.onAny(markServerActivity);
  setAgentActivitySubscriptionSocket(() => socket);
  setAgentReadProgressWatchSocket(() => socket);

  // Task board real-time updates.
  const cleanupTaskRealtimeHandlers = registerTaskRealtimeHandlers(socket);
  // Server feature-flag changes and reconnects re-read the flags.
  const cleanupFeatureFlagRealtimeHandlers = registerFeatureFlagRealtimeHandlers(socket);

  // Keep a conservative client-side circuit breaker for sockets that appear
  // wedged, but only trip it after both heartbeat silence and total inbound
  // inactivity for an extended period.
  const heartbeatCheckInterval = setInterval(() => {
    const now = Date.now();
    const heartbeatSilentFor = now - lastHeartbeatTime;
    const serverSilentFor = now - lastServerEventTime;
    if (
      heartbeatSilentFor > 90_000 &&
      serverSilentFor > 120_000 &&
      socket.connected
    ) {
      console.warn("[Socket] Prolonged heartbeat silence, forcing reconnect");
      socket.disconnect();
      socket.connect();
    }
  }, 10_000);

  return () => {
    setAgentActivitySubscriptionSocket(null);
    setAgentReadProgressWatchSocket(null);
    cleanupMainLayoutBridge();
    cancelReconnectReload();
    disposeMainLayoutSync();
    socket.offAny(markServerActivity);
    cleanupTaskRealtimeHandlers();
    cleanupFeatureFlagRealtimeHandlers();
    cancelInboxBackgroundRefresh();
    noteRoomsJoinDegraded(false);
    clearInterval(heartbeatCheckInterval);
  };
}

function attachMainLayoutRecoveryBridge(
  transport: MainLayoutRealtimeTransport,
  syncVisibleScopes: () => Promise<void>,
): () => void {
  // A page coming back re-reads the conversations on screen (a live row the
  // socket never delivered, a hole a failed fill left), once per burst of
  // focus / visibility / online events. The reads a hidden page owed count
  // as that re-read.
  const recoveryScopeSync = createRecoveryScopeSync(syncVisibleScopes);
  setOwedGapReadsPaidListener(() => recoveryScopeSync.noteRead());

  const handlePageHide = () => {
    const { lastSeq } = useMessageStore.getState();
    sessionStorage.setItem("slock_lastSeq", String(lastSeq));
  };

  const recoverLiveSession = (event?: Event) => {
    // A followed-thread reload asked for while the page was hidden runs now.
    if (document.visibilityState === "visible") followedThreadsRefresh.flushIfPending();
    const plan = getLiveSessionRecoveryPlan({
      visible: document.visibilityState === "visible",
      online: navigator.onLine,
      hasStoredSession: hasStoredAuthSession(),
      socketConnected: transport.isSocketConnected(),
    });
    noteLiveSessionRecovery(event?.type ?? "unknown", plan);
    if (plan.reconnectSocket) {
      transport.ensureSocketConnected();
    }
    if (plan.reloadLiveData) {
      const chat = hasChatSurfaces();
      // Sync on with a cursor: pull what changed while the tab was away (the
      // socket may never have dropped) instead of reading the sidebar order
      // again. Agents and machines still reload: their online status is not
      // in the change log.
      const serverId = useServerStore.getState().current?.id;
      const session = mainLayoutSync;
      const bySync = !!session && session.hasCursor && session.serverId === serverId && syncChangesEnabled(serverId);
      if (chat) {
        useMessageStore.getState().loadUnreadCounts();
        useMessageStore.getState().markCurrentChannelRead();
        if (!bySync) useServerStore.getState().loadSidebarOrder();
        recoveryScopeSync.request();
      }
      if (bySync) scheduleSyncPull(session);
      useMachineStore.getState().loadMachines();
      useAgentStore.getState().resetActivitySeq();
      useAgentStore.getState().loadAgents();
      if (chat) void useAnnouncementStore.getState().load();
    }
  };

  const recoverFromBfcache = (e: PageTransitionEvent) => {
    if (e.persisted) recoverLiveSession(e);
  };

  // Raft Desktop wake / unlock: reconnect a dropped socket, then re-read the
  // conversations on screen (a hidden page owes them instead).
  const uninstallSystemResume = installSystemResumeRecovery(() => {
    if (!hasStoredAuthSession()) return;
    if (!transport.isSocketConnected()) transport.ensureSocketConnected();
    if (hasChatSurfaces()) recoveryScopeSync.request();
  });

  const statusReconcileInterval = setInterval(() => {
    const visible = document.visibilityState === "visible";
    const online = navigator.onLine;
    const { reconcile } = planStatusReconcile({
      visible,
      online,
      hasStoredSession: hasStoredAuthSession(),
      socketConnected: transport.isSocketConnected(),
    });
    if (reconcile) executeScheduledMachineReconcile();
  }, STATUS_RECONCILE_INTERVAL_MS);

  window.addEventListener("pagehide", handlePageHide);
  document.addEventListener("visibilitychange", recoverLiveSession);
  window.addEventListener("focus", recoverLiveSession);
  window.addEventListener("online", recoverLiveSession);
  window.addEventListener("pageshow", recoverFromBfcache);

  return () => {
    window.removeEventListener("pagehide", handlePageHide);
    document.removeEventListener("visibilitychange", recoverLiveSession);
    window.removeEventListener("focus", recoverLiveSession);
    window.removeEventListener("online", recoverLiveSession);
    window.removeEventListener("pageshow", recoverFromBfcache);
    uninstallSystemResume();
    setOwedGapReadsPaidListener(null);
    clearInterval(statusReconcileInterval);
  };
}

export function installMainLayoutSocketBridge(
  transport: MainLayoutRealtimeTransport,
): () => void {
  const socket = transport.getSocket();
  const syncVisibleScopes = createConversationScopeSync(getCurrentChannelId);
  const cleanupSocket = attachMainLayoutSocketBridge(socket, syncVisibleScopes);
  const cleanupRecovery = attachMainLayoutRecoveryBridge(transport, syncVisibleScopes);

  return () => {
    cleanupSocket();
    cleanupRecovery();
  };
}

export type MainLayoutRealtimeBridgeDriver = {
  bootstrap: () => void;
  install: () => () => void;
};

export function createMainLayoutRealtimeBridgeDriver(
  transport: MainLayoutRealtimeTransport,
): MainLayoutRealtimeBridgeDriver {
  return {
    bootstrap: () => bootstrapMainLayoutRealtimeBridge(transport),
    install: () => installMainLayoutSocketBridge(transport),
  };
}

export function useMainLayoutRealtimeBridge(
  driver: MainLayoutRealtimeBridgeDriver,
) {
  const navigate = useNavigate();

  useEffect(() => {
    setMainLayoutBridgeNavigate(navigate);
    return () => {
      if (bridgeNavigate === navigate) {
        setMainLayoutBridgeNavigate(null);
      }
    };
  }, [navigate]);

  useEffect(() => {
    driver.bootstrap();
    return driver.install();
  }, [driver]);
}
