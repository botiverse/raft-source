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
import { failpoints } from "@botiverse/raft-shared";
import {
  getLiveSessionRecoveryPlan,
  planStatusReconcile,
} from "../utils/browserRecoveryPolicy";
import { traceAgentActivitySocketReceived } from "../utils/webAgentActivityTrace";
import { useAgentStore } from "./agentStore";
import type { TrajectoryEntry } from "./agentStore";
import { useAnnouncementStore } from "./announcementStore";
import { normalizeActivityMuteState, normalizeMessageDisplayPrefs } from "./channelDomain";
import type { MessageDisplayPrefsState } from "./channelDomain";
import {
  applyMessageChannelActivity,
  createChannelRealtimeBindings,
  isMessageActivitySuppressedByMute,
} from "./channelRealtimeSync";
import { useChannelStore } from "./channelStore";
import { dispatchServerNotificationPrefsUpdated } from "./events/notificationPrefsEvents";
import { useInboxStore } from "./inboxStore";
import { useLiveAgentActivityStore } from "./liveAgentActivityStore";
import { useMachineStore } from "./machineStore";
import { isSyncCoreMessagesFlagEnabled } from "./messageSyncFeatureFlag";
import { isNormalizedMessageV2FlagEnabled } from "./normalizedMessageV2FeatureFlag";
import {
  applyMessageReactionsForV2Ingress,
  applyMessagesReactionsForV2Ingress,
  isMessageV2IngressAdmissible,
  isMessageV2IngressSoleApplyEligible,
} from "./normalizedMessageReactions";
import {
  applyReactionViewerSnapshotForCurrentPrincipal,
  hydrateReactionViewerSnapshot,
} from "./reactionViewerReadModel";
import type { VersionedReactionViewerSnapshot } from "./reactionReadModels";
import {
  consumeSocketMessageNewWithSyncCore,
} from "./messageSyncDomain";
import { isSyncCoreNotificationPrefsFlagEnabled } from "./notificationPrefsSyncFeatureFlag";
import {
  consumeNotificationPrefsUpdateWithSyncCore,
} from "./notificationPrefsSyncDomain";
import type {
  NotificationPrefsUpdate,
} from "./notificationPrefsSyncDomain";
import {
  consumeReadStateUpdate,
  normalizeReadStateUpdated,
  normalizeReadStateUpdatedBulk,
} from "./readStateSync";
import type {
  ReadStateUpdate,
} from "./readStateSync";
import { releaseActivityReadHoldForMessage } from "./activityReadState";
import {
  captureReceiverPrivateIngressContext,
  isReceiverPrivateIngressContextCurrent,
  useMessageStore,
} from "./messageStore";
import type {
  Message,
} from "./messageStore";
import { useReadReceiptStore } from "./readReceiptStore";
import { useSavedStore } from "./savedStore";
import { useServerStore } from "./serverStore";
import { registerTaskRealtimeHandlers } from "./taskRealtimeSync";
import { handleThreadUpdatedForReplies } from "./threadRepliesSocket";
import {
  consumeThreadUpdatedWithSyncCore,
  hydrateThreadRepliesRebaselineSnapshotWithSyncCore,
  releaseThreadRepliesRebaselineRequest,
  requestThreadRepliesRebaselineSnapshot,
} from "./threadRepliesSyncDomain";
import { requestThreadAgentFollowers } from "./threadAgentFollowerStore";
import { useThreadStore } from "./threadStore";
import { notifyAllChannelMembersChanged } from "./channelMemberEvents";

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
const STATUS_RECONCILE_INTERVAL_MS = 60_000;

export const MAIN_LAYOUT_SOCKET_EVENT_NAMES = [
  "message:new",
  "message:updated",
  "reaction_viewer:updated",
  "scope_read:updated",
  "read_state:updated",
  "read_state:updated_bulk",
  "agent:activity",
  "agent:session",
  "dm:new",
  "machine:status",
  "machine:capabilities",
  "machine:updated",
  "computer:restart:done",
  "computer:upgrade:progress",
  "computer:upgrade:done",
  "daemon:status",
  "agent:created",
  "agent:deleted",
  "channel:updated",
  "channel:members-updated",
  "notification_prefs:updated",
  "message_display_prefs:updated",
  "server:plan-updated",
  "server:member-added",
  "server:member:left",
  "server:member-removed",
  "server:member-updated",
  "server:membership-removed",
  "thread:updated",
  "thread:followers-updated",
  "connect",
  "rooms:joined",
  "sync:resume:response",
  "heartbeat",
  "task:created",
  "task:updated",
  "task:deleted",
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

function getChannelMaxSeq(messages: { seq?: number }[] | undefined): number {
  return Math.max(...(messages ?? []).map((message) => message.seq || 0), 0);
}

function mintAgentActivityClientEventId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  // Stryker disable next-line MethodExpression,StringLiteral: fallback UUIDv4 formatting is pinned by socketBridgeAgentActivityJoin; generated template mutants hang the focused command runner.
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
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
  if (typeof prefRecord.serverPushMuted === "boolean") {
    return {
      type: "server" as const,
      serverId,
      serverPushMuted: prefRecord.serverPushMuted,
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

function loadInboxReset(opts: { background?: boolean } = {}) {
  void useInboxStore.getState().loadInbox({ reset: true, background: opts.background });
}

function loadFollowedThreads() {
  void useThreadStore.getState().loadFollowedThreads();
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
  useMessageStore.getState().loadUnreadCounts();
  useChannelStore.getState().loadChannels();
  useChannelStore.getState().loadDMChannels();
  useAgentStore.getState().loadAgents();
  useMachineStore.getState().loadMachines();
  loadFollowedThreads();
  loadInboxReset({ background: true });
  void useSavedStore.getState().loadSaved();
  void useAnnouncementStore.getState().load();
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

export function buildMainLayoutSocketBindings(
  socket: MainLayoutSocketBridgeSocket,
  scheduleInboxRefresh: () => void,
  syncVisibleScopes: () => Promise<void>,
  recordHeartbeat: SocketHandler,
  recordConnect: SocketHandler,
): MainLayoutSocketBinding[] {
  const bindingReceiverPrivateIngressContext = captureReceiverPrivateIngressContext(
    useMessageStore.getState().currentUserId,
  );

  const normalizeChannelRoomMessage = (message: Message): Message => {
    if (!isNormalizedMessageV2FlagEnabled()) return message;
    const serverId = useServerStore.getState().current?.id;
    const principalId = useMessageStore.getState().currentUserId;
    if (!serverId || !principalId) return message;
    return applyMessageReactionsForV2Ingress(message, {
      serverId,
      principalId,
      source: "channel-room",
      viewerUserId: principalId,
    });
  };

  const messageNew = (msg: Message) => {
    if (isNormalizedMessageV2FlagEnabled()) {
      const projectedMessage = normalizeChannelRoomMessage(msg);
      const result = consumeSocketMessageNewWithSyncCore(projectedMessage);
      if (result.kind !== "duplicate_dropped") {
        useMessageStore.getState().addMessage(result.message, "channel-room");
        applyLiveMessageActivity(result.message, scheduleInboxRefresh);
      }
      return;
    }
    if (isSyncCoreMessagesFlagEnabled()) {
      const result = consumeSocketMessageNewWithSyncCore(msg);
      if (result.kind !== "duplicate_dropped") {
        useMessageStore.getState().addMessage(result.message, "channel-room");
        applyLiveMessageActivity(result.message, scheduleInboxRefresh);
      }
      return;
    }

    const messageStore = useMessageStore.getState();
    const accepted = !messageStore.channelMessages[msg.channelId]?.some((existing) => existing.id === msg.id);
    messageStore.addMessage(msg, "channel-room");
    if (accepted) applyLiveMessageActivity(msg, scheduleInboxRefresh);
    else applyMessageChannelActivity(msg, scheduleInboxRefresh);
  };

  // Merge-only updates for existing messages (task field changes).
  // Does NOT create new messages or increment unread counts.
  const messageUpdated = (msg: Message) => {
    useMessageStore.getState().updateMessage(normalizeChannelRoomMessage(msg));
  };

  const applyReadStateUpdate = (update: ReadStateUpdate) => {
    const currentServerId = useServerStore.getState().current?.id;
    if (update.serverId !== currentServerId) return;
    if (consumeReadStateUpdate(update) !== "accepted") return;
    const projection = useMessageStore.getState().applyReadStateProjection(update.scopeId);
    if (!projection.complete) return;
    useInboxStore.getState().applyReadStateProjection(update.scopeId, projection);
    useThreadStore.getState().applyReadStateProjection(update.scopeId, projection);
  };

  const readStateUpdated = (payload: unknown) => {
    const update = normalizeReadStateUpdated(payload);
    if (!update) return;
    applyReadStateUpdate(update);
  };

  const readStateUpdatedBulk = (payload: unknown) => {
    for (const update of normalizeReadStateUpdatedBulk(payload)) {
      applyReadStateUpdate(update);
    }
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
  }) => {
    const joinKeys = { launchId: data.launchId, clientSeq: data.clientSeq, probeId: data.probeId };
    const traceJoin = { clientEventId: mintAgentActivityClientEventId() };
    traceAgentActivitySocketReceived({
      agentId: data.agentId,
      activity: data.activity,
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
    useAgentStore
      .getState()
      .updateActivity(
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
      );
    useLiveAgentActivityStore.getState().recordStatusActivity(data, useAgentStore.getState().agents);
    if (data.entries && data.entries.length > 0) {
      useAgentStore
        .getState()
        .appendTrajectory(data.agentId, data.entries, data.timestamp, joinKeys, data.serverSeq, traceJoin);
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
    runtimes: string[];
    runtimeVersions?: Record<string, string>;
    hostname?: string;
    os?: string;
    daemonVersion?: string;
    computerVersion?: string | null;
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
      );
  };

  const computerUpgradeProgress = (data: {
    machineId: string;
    requestId: string;
    phase: "downloading" | "verifying" | "applying" | "restarting";
    message?: string;
    percent?: number;
  }) => {
    useMachineStore
      .getState()
      .updateComputerUpgradeProgress(
        data.machineId,
        data.requestId,
        data.phase,
        data.message,
        data.percent,
      );
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

  const computerUpgradeDone = (data: {
    machineId: string;
    requestId: string;
    ok: boolean;
    newVersion?: string;
    rolledBack?: boolean;
    error?: string;
  }) => {
    useMachineStore
      .getState()
      .completeComputerUpgrade(
        data.machineId,
        data.requestId,
        data.ok,
        data.newVersion,
        data.rolledBack,
        data.error,
      );
    if (data.ok && !data.rolledBack) {
      void useMachineStore.getState().loadMachines();
    }
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
    const update = readNotificationPrefsUpdate(payload);
    if (!update) return;
    if (isSyncCoreNotificationPrefsFlagEnabled()) {
      const result = consumeNotificationPrefsUpdateWithSyncCore(update);
      if (result.kind === "duplicate_dropped" || result.kind === "no_op") return;
      applyNotificationPrefsUpdate(result.update);
      return;
    }
    applyNotificationPrefsUpdate(update);
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
            const isOpen = state.openThreadChannelId === presentation.threadChannelId;
            const existingSummary = state.summaries[presentation.parentMessageId];
            const followed = state.followedThreads.find(
              (thread) => thread.threadChannelId === presentation.threadChannelId,
            );
            const unreadCount = presentation.unreadCount
              ?? (isOpen
                ? 0
                : followed
                  ? followed.unreadCount + snapshot.pendingEventCount
                  : (existingSummary?.unreadCount ?? 0) + snapshot.pendingEventCount);
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
                ...(isOpen ? {} : { unreadCount }),
              });
            } else {
              state.loadFollowedThreads();
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
              scheduleInboxRefresh();
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
    const isOpen = threadState.openThreadChannelId === data.threadChannelId;
    const existingSummary = threadState.summaries[data.parentMessageId];
    const followed = threadState.followedThreads.find(
      (t) => t.threadChannelId === data.threadChannelId,
    );
    const unreadCount =
      data.unreadCount ??
      (isOpen
        ? 0
        : followed
          ? followed.unreadCount + 1
          : (existingSummary?.unreadCount ?? 0));
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
    // Update followed threads list (increment unread if thread panel not open for this thread)
    if (followed) {
      threadState.updateFollowedThread(data.threadChannelId, {
        replyCount: effectiveReplyCount,
        lastReplyAt: data.lastReplyAt,
        ...(isOpen ? {} : { unreadCount: followed.unreadCount + 1 }),
      });
    } else {
      // The backend can auto-follow a thread for the current user when
      // another actor creates or replies in it; refresh sidebar state.
      threadState.loadFollowedThreads();
    }
    if (data.latestReply) releaseActivityReadHoldForLiveMessage(data.latestReply);
    const suppressActivity = data.latestReply
      ? isMessageActivitySuppressedByMute(data.latestReply)
      : false;
    if (!suppressActivity) {
      if (data.latestReply) useInboxStore.getState().receiveThreadReply(data.latestReply);
      useInboxStore.getState().updateThreadActivityMeta(
        data.threadChannelId,
        effectiveReplyCount,
        data.lastReplyAt,
      );
      scheduleInboxRefresh();
    }
  };

  const threadFollowersUpdated = (data: { threadChannelId?: unknown } | null | undefined) => {
    if (typeof data?.threadChannelId !== "string") return;
    requestThreadAgentFollowers(data.threadChannelId, true);
  };

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
    useServerStore.getState().loadSidebarOrder();
    useMachineStore.getState().loadMachines();
    useAgentStore.getState().loadAgents();
    useServerStore.getState().loadServers();
    loadFollowedThreads();
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
    //   - the connect-time copy cannot even cover the no-server case it might
    //     look like a fallback for: `rooms:joined` is emitted inside
    //     `if (serverId)`, but `loadUnreadCounts` returns early without a
    //     serverId and the inbox is server-scoped too, so with no server
    //     selected both calls were already no-ops.
    //
    // `reconnectNoDuplicateLoads.behavior.test.ts` drives both handlers and
    // counts the loads, so the request count is asserted directly.
  };

  const roomsJoined = () => {
    if (typeof window !== "undefined") {
      (window as Window & { __slockRoomsJoined?: boolean }).__slockRoomsJoined =
        true;
      window.dispatchEvent(new Event("slock:rooms-joined"));
    }
    const { lastSeq } = useMessageStore.getState();
    if (lastSeq > 0) {
      socket.emit("sync:resume", { lastSeq });
    }
    void syncVisibleScopes();
    // The server closes a connection when this user's channel eligibility
    // changed (visibility, guest policy, role) and no longer tells non-members
    // which channel they lost. The room set is authoritative once joined, so
    // re-read the channel list here rather than on connect.
    void useChannelStore.getState().loadChannels();
    useMessageStore.getState().loadUnreadCounts();
    loadInboxReset({ background: true });
  };

  const syncResumeResponse = ({
    messages,
    currentSeq,
    hasMore,
  }: {
    messages: Message[];
    currentSeq: number;
    hasMore: boolean;
  }) => {
    let eligibleMessages = messages;
    if (isNormalizedMessageV2FlagEnabled()) {
      const serverId = useServerStore.getState().current?.id;
      const principalId = useMessageStore.getState().currentUserId;
      if (!serverId || !principalId) return;
      eligibleMessages = applyMessagesReactionsForV2Ingress(messages, {
        serverId,
        principalId,
        source: "receiver-private",
        viewerUserId: principalId,
      });
      const reactionMessageIds = messages.every(isMessageV2IngressAdmissible)
        ? messages
          .filter((message) => (
            message.messageType !== "system"
            && isMessageV2IngressSoleApplyEligible(message)
          ))
          .map((message) => message.id)
        : [];
      for (const messageId of new Set(reactionMessageIds)) {
        void hydrateReactionViewerSnapshot({ principalId, serverId, messageId }).catch((error) => {
          console.error("[MessageV2] failed to recover reaction viewer snapshot after resume", {
            messageId,
            error,
          });
        });
      }
    }
    useMessageStore.getState().batchAddMessages(eligibleMessages);
    useMessageStore.setState((s) => ({
      lastSeq: Math.max(s.lastSeq, currentSeq),
    }));
    // If too many messages were missed, fallback to full refresh
    if (hasMore) {
      useMessageStore.getState().loadUnreadCounts();
      void syncVisibleScopes();
    }
  };

  return [
    { event: "message:new", handler: messageNew },
    { event: "message:updated", handler: messageUpdated },
    {
      event: "scope_read:updated",
      handler: (payload) => useReadReceiptStore.getState().consumeScopeUpdated(payload),
    },
    { event: "read_state:updated", handler: readStateUpdated },
    { event: "read_state:updated_bulk", handler: readStateUpdatedBulk },
    { event: "agent:activity", handler: agentActivity },
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
    { event: "computer:restart:done", handler: computerRestartDone },
    { event: "computer:upgrade:progress", handler: computerUpgradeProgress },
    { event: "computer:upgrade:done", handler: computerUpgradeDone },
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
    { event: "server:plan-updated", handler: (data: { serverId?: string; plan?: string }) => {
      if (data?.serverId && typeof data.plan === "string") {
        useServerStore.getState().applyServerPatch({ id: data.serverId, plan: data.plan });
      } else {
        useServerStore.getState().loadServers();
      }
      useServerStore.getState().loadBilling();
      useServerStore.getState().loadUsage();
    } },
    { event: "server:member-added", handler: refreshMembersForServer },
    { event: "server:member:left", handler: refreshMembersForServer },
    { event: "server:member-removed", handler: refreshMembersForServer },
    { event: "server:member-updated", handler: refreshMembersForServer },
    { event: "server:membership-removed", handler: serverMembershipRemoved },
    { event: "thread:updated", handler: threadUpdated },
    { event: "thread:followers-updated", handler: threadFollowersUpdated },
    { event: "connect", handler: reconnectSnapshot },
    { event: "rooms:joined", handler: roomsJoined },
    {
      event: "reaction_viewer:updated",
      handler: (snapshot: VersionedReactionViewerSnapshot) => {
        if (!isNormalizedMessageV2FlagEnabled()) return;
        applyReactionViewerSnapshotForCurrentPrincipal(snapshot);
      },
    },
    { event: "sync:resume:response", handler: syncResumeResponse },
    { event: "heartbeat", handler: recordHeartbeat },
  ];
}

function applyLiveMessageActivity(
  msg: Message,
  scheduleInboxRefresh: () => void,
) {
  releaseActivityReadHoldForLiveMessage(msg);
  if (isMessageActivitySuppressedByMute(msg)) return;
  useInboxStore.getState().receiveThreadReply(msg);
  applyMessageChannelActivity(msg, scheduleInboxRefresh);
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
): () => void {
  let inboxRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleInboxRefresh = () => {
    if (inboxRefreshTimer) clearTimeout(inboxRefreshTimer);
    inboxRefreshTimer = setTimeout(() => {
      inboxRefreshTimer = null;
      loadInboxReset({ background: true });
    }, 150);
  };

  let visibleScopeSyncInFlight = false;
  const syncVisibleScopes = async () => {
    if (visibleScopeSyncInFlight) return;

    const { channelMessages } = useMessageStore.getState();
    const targets: Array<{ channelId: string; sinceSeq: number }> = [];
    const seen = new Set<string>();

    const { openThreadChannelId } = useThreadStore.getState();
    if (openThreadChannelId) {
      const sinceSeq = getChannelMaxSeq(channelMessages[openThreadChannelId]);
      if (sinceSeq > 0) {
        targets.push({ channelId: openThreadChannelId, sinceSeq });
        seen.add(openThreadChannelId);
      }
    }

    const currentChannelId = getCurrentChannelId();
    if (currentChannelId && !seen.has(currentChannelId)) {
      const sinceSeq = getChannelMaxSeq(channelMessages[currentChannelId]);
      if (sinceSeq > 0) {
        targets.push({ channelId: currentChannelId, sinceSeq });
      }
    }

    if (targets.length === 0) return;

    visibleScopeSyncInFlight = true;
    try {
      for (const { channelId, sinceSeq } of targets) {
        await useMessageStore.getState().syncGap(channelId, { sinceSeq });
      }
    } finally {
      visibleScopeSyncInFlight = false;
    }
  };

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
    const { lastSeq } = useMessageStore.getState();
    if (serverSeq > lastSeq) {
      void syncVisibleScopes();
    }
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

  // Task board real-time updates.
  const cleanupTaskRealtimeHandlers = registerTaskRealtimeHandlers(socket);

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
    cleanupMainLayoutBridge();
    socket.offAny(markServerActivity);
    cleanupTaskRealtimeHandlers();
    if (inboxRefreshTimer) clearTimeout(inboxRefreshTimer);
    clearInterval(heartbeatCheckInterval);
  };
}

function attachMainLayoutRecoveryBridge(
  transport: MainLayoutRealtimeTransport,
): () => void {
  const handlePageHide = () => {
    const { lastSeq } = useMessageStore.getState();
    sessionStorage.setItem("slock_lastSeq", String(lastSeq));
  };

  const recoverLiveSession = () => {
    const plan = getLiveSessionRecoveryPlan({
      visible: document.visibilityState === "visible",
      online: navigator.onLine,
      hasStoredSession: hasStoredAuthSession(),
      socketConnected: transport.isSocketConnected(),
    });
    if (plan.reconnectSocket) {
      transport.ensureSocketConnected();
    }
    if (plan.reloadLiveData) {
      useMessageStore.getState().loadUnreadCounts();
      useMessageStore.getState().markCurrentChannelRead();
      useServerStore.getState().loadSidebarOrder();
      useMachineStore.getState().loadMachines();
      useAgentStore.getState().resetActivitySeq();
      useAgentStore.getState().loadAgents();
      void useAnnouncementStore.getState().load();
    }
  };

  const recoverFromBfcache = (e: PageTransitionEvent) => {
    if (e.persisted) recoverLiveSession();
  };

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
    clearInterval(statusReconcileInterval);
  };
}

export function installMainLayoutSocketBridge(
  transport: MainLayoutRealtimeTransport,
): () => void {
  const socket = transport.getSocket();
  const cleanupSocket = attachMainLayoutSocketBridge(socket);
  const cleanupRecovery = attachMainLayoutRecoveryBridge(transport);

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
