import { create } from "zustand";
import api from "../api/client";
import {
  applyActivityMuteState,
  applyMessageDisplayPrefsState,
  hydrateChannels,
  hydrateDmChannels,
  patchChannel,
  refreshExistingDm,
  removeChannel,
  setLocalChannelMembership,
  toChannel,
  touchChannelActivity as reduceChannelActivity,
} from "./channelDomain";
import type { ChannelAdminBasis, ChannelRole, InboxScopeReadFrontier, ServerCapability } from "@botiverse/raft-shared";
import { useServerStore } from "./serverStore";
import { consumeReadStateSnapshotRows, getReadStateLedgerGeneration } from "./readStateSync";
import { registerServerReset } from "./serverResetRegistry";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { channelTraceStateChanged, transitionOutcomeDetail } from "../utils/stateTransitionChange";

export interface Channel {
  id: string;
  serverId?: string;
  name: string;
  description: string | null;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  createdAt: string;
  // NOTE: `lastMessageAt` deliberately does NOT live here. It is high-frequency
  // (bumped on EVERY inbound message) and storing it on the channel identity
  // object forced a new `channels`/`dmChannels` array reference per message,
  // re-rendering every list consumer. It lives in the separate `channelActivity`
  // slice instead (#proj-frontend render-perf, first-principles fix). Only
  // recency-sorting consumers subscribe that slice; identity consumers stay stable.
  archivedAt?: string | null;
  archivedByUserId?: string | null;
  bridge?: {
    provider: "slack";
    providerConversationId: string;
    state: "active" | "paused" | "quarantined";
  };
  guestVisible?: boolean;
  guestJoinable?: boolean;
  // Joint-channel metadata. Host projections show a pending/active peer
  // server; participant projections show the host peer.
  jointChannelId?: string | null;
  jointRole?: "host" | "participant" | null;
  jointPeerServerId?: string | null;
  jointPeerServerName?: string | null;
  jointPeerServerSlug?: string | null;
  jointPeerStatus?: "pending" | "active" | null;
  jointServers?: Array<{
    serverId: string;
    serverName: string;
    serverSlug: string;
    role: "host" | "participant" | null;
    status: "active" | "pending";
    isCurrentServer?: boolean;
  }>;
  jointPendingInvites?: Array<{
    id: string;
    fromServerId: string;
    toServerId: string;
    serverName: string;
    serverSlug: string;
    invitedUserId: string;
    status: "pending";
  }>;
  jointBillingLocked?: boolean | null;
  // Channel membership
  joined?: boolean;
  channelRole?: ChannelRole | null;
  channelAdminBasis?: ChannelAdminBasis;
  channelCapabilities?: Partial<Record<ServerCapability, boolean>>;
  channelAuthorityRevision?: number | null;
  activityMuted?: boolean;
  muteFromSeq?: string | number | null;
  activityMuteSupported?: boolean;
  prefsVersion?: number;
  // Per-user message display prefs (task #187 collapse-long-messages). Server
  // default ON; undefined = not yet hydrated, treated as collapsing.
  collapseLongMessages?: boolean;
  displayPrefsVersion?: number;
  // DM-specific fields — unified peer model (agent or user)
  peerType?: "agent" | "user";
  peerId?: string;
  peerName?: string;
  peerDisplayName?: string | null;
  peerDescription?: string | null;
  peerGravatarHash?: string | null;
  peerAvatarUrl?: string | null;
}

/** Shape returned by the API (type may be missing for legacy data). The API
 *  still carries `lastMessageAt` per channel; we split it into the activity
 *  slice on load rather than storing it on the `Channel` identity object. */
export type ApiChannel = Omit<Channel, "type"> & {
  type?: string;
  lastMessageAt?: string | null;
  /** #632 exit 1 — on the wire from every authority exit. Consumed by the
   * read-state adapter and then DROPPED; it must not reach the domain object. */
  readState?: InboxScopeReadFrontier;
};

export { activityFrom, toChannel } from "./channelDomain";

function joinRealtimeChannel(channelId: string) {
  void import("../api/socket")
    .then(({ getSocket }) => {
      getSocket().emit("join:channel", channelId);
    })
    .catch((err) => {
      console.error("Failed to join socket channel:", err);
    });
}

const ensureChannelInFlight = new Map<string, Promise<Channel | null>>();
const openAgentDmInFlight = new Map<string, Promise<Channel>>();
const openUserDmInFlight = new Map<string, Promise<Channel>>();

function reduceChannelWithTrace(
  state: ChannelState,
  event: string,
  entityId: string,
  reduce: (state: ChannelState) => Partial<ChannelState>,
  outcomeDetail = "applied",
): Partial<ChannelState> {
  const next = reduce(state);
  const touched = channelTraceStateChanged(state as unknown as Record<string, unknown>, next as Record<string, unknown>) ? 1 : 0;
  emitStateTransitionTrace({
    domain: "channel",
    event,
    entityId,
    touched,
    outcomeDetail: transitionOutcomeDetail(touched, outcomeDetail),
  });
  return next;
}

interface ChannelState {
  channels: Channel[];
  dmChannels: Channel[];
  /** Per-channel last-message timestamp, separated from the channel identity
   *  objects so an activity bump never churns the `channels`/`dmChannels`
   *  array references. Only recency-sorting consumers subscribe this. */
  channelActivity: Record<string, string | null>;
  channelLocalMembership: Record<string, boolean>;
  loading: boolean;
  loadChannels: () => Promise<void>;
  loadDMChannels: () => Promise<void>;
  ensureChannel: (channelId: string) => Promise<Channel | null>;
  addOrRefreshDM: (channelId: string) => Promise<void>;
  touchChannelActivity: (channelId: string, lastMessageAt?: string | null) => void;
  applyChannelPatch: (channel: ApiChannel, defaultType?: Channel["type"]) => void;
  createChannel: (name: string, description?: string, opts?: {
    visibility?: "public" | "private" | "joint";
    agentIds?: string[];
    userIds?: string[];
    targetServerSlug?: string;
    invitedPeople?: string[];
    jointInvites?: Array<{ targetServerSlug: string; invitedPeople: string[] }>;
  }) => Promise<Channel>;
  updateChannel: (channelId: string, updates: { name?: string; description?: string; visibility?: "public" | "private"; guestVisible?: boolean; guestJoinable?: boolean }) => Promise<Channel>;
  restoreAllChannel: () => Promise<Channel>;
  hideAllChannel: () => Promise<Channel>;
  convertChannelToJoint: (channelId: string, opts?: { confirmTaskIdentityDrop?: boolean }) => Promise<Channel>;
  deleteChannel: (channelId: string) => Promise<void>;
  disconnectJointChannel: (channelId: string) => Promise<void>;
  resendJointChannelInvite: (channelId: string) => Promise<{ resentCount: number }>;
  inviteJointChannelServer: (channelId: string, input: { targetServerSlug: string; invitedPeople: string[] }) => Promise<Channel>;
  setActivityMuteState: (channelId: string, state: { activityMuted: boolean; muteFromSeq: string | number | null; activityMuteSupported?: boolean; prefsVersion?: number }) => void;
  setMessageDisplayPrefsState: (channelId: string, prefs: { collapseLongMessages: boolean; prefsVersion?: number }) => void;
  archiveChannel: (channelId: string) => Promise<Channel>;
  unarchiveChannel: (channelId: string) => Promise<Channel>;
  openDM: (agentId: string) => Promise<Channel>;
  openUserDM: (userId: string) => Promise<Channel>;
  joinChannel: (channelId: string) => Promise<boolean>;
  leaveChannel: (channelId: string) => Promise<void>;
}

// Stryker disable all: this store is the IO/Zustand action wrapper around the
// channel-domain reducers. The mutation gate for channel behavior lives in
// channelDomain plus focused store/browser smoke tests; mutating each callback
// wrapper here only duplicates the reducer oracle and produces equivalent
// blind spots for RPC plumbing.
export const useChannelStore = create<ChannelState>((set, get) => ({
  channels: [],
  dmChannels: [],
  channelActivity: {},
  channelLocalMembership: {},
  loading: true,

  loadChannels: async () => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    const readLedgerGeneration = getReadStateLedgerGeneration();
    if (!serverId) return;
    // Never set loading here — it starts as true (store init / server reset)
    // and goes to false after the first successful fetch. This keeps existing
    // data (or a legitimate empty state) visible during refreshes.
    try {
      const { data } = await api.get("/channels", { params: { archived: "include" } });
      if (useServerStore.getState().serverEpoch !== epoch) return;
      // API returns channels without type field for existing data — default to "channel"
      const apiChannels = data as ApiChannel[];
      // #632 C1: fold this authority response through the single adapter —
      // raw response, after the epoch/identity check, before the domain reducer.
      consumeReadStateSnapshotRows(serverId, apiChannels.map((c) => ({ scopeId: c.id, readState: c.readState })), { ledgerGenerationAtRequest: readLedgerGeneration });
      set((state) => reduceChannelWithTrace(
        state,
        "hydrate",
        "channel-list",
        (current) => ({ ...hydrateChannels(current, apiChannels), loading: false }),
      ));
    } catch (err) {
      console.error("Failed to load channels:", err);
      if (useServerStore.getState().serverEpoch !== epoch) return;
      set({ loading: false });
    }
  },

  loadDMChannels: async () => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    const readLedgerGeneration = getReadStateLedgerGeneration();
    if (!serverId) return;
    try {
      const { data } = await api.get("/channels/dm");
      if (useServerStore.getState().serverEpoch !== epoch) return;
      const apiDms = data as ApiChannel[];
      // #632 C1: fold this authority response through the single adapter —
      // raw response, after the epoch/identity check, before the domain reducer.
      consumeReadStateSnapshotRows(serverId, apiDms.map((c) => ({ scopeId: c.id, readState: c.readState })), { ledgerGenerationAtRequest: readLedgerGeneration });
      set((state) => reduceChannelWithTrace(
        state,
        "hydrate:dm",
        "dm-list",
        (current) => hydrateDmChannels(current, apiDms),
      ));
    } catch (err) {
      console.error("Failed to load DM channels:", err);
    }
  },

  ensureChannel: async (channelId) => {
    const existing = get().channels.find((c) => c.id === channelId)
      ?? get().dmChannels.find((c) => c.id === channelId);
    if (existing) return existing;

    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    const readLedgerGeneration = getReadStateLedgerGeneration();
    if (!serverId) return null;

    const pending = ensureChannelInFlight.get(channelId);
    if (pending) return pending;

    const request = (async () => {
      try {
        const { data } = await api.get(`/channels/${channelId}`);
        if (useServerStore.getState().serverEpoch !== epoch) return null;
        const apiChannel = data as ApiChannel;
        const channel = toChannel(apiChannel);
        // #632 C1: same adapter for the single-channel authority hydrate.
        consumeReadStateSnapshotRows(serverId, [{ scopeId: apiChannel.id, readState: apiChannel.readState }], { ledgerGenerationAtRequest: readLedgerGeneration });

        set((state) => reduceChannelWithTrace(
          state,
          "ensure",
          channelId,
          (current) => patchChannel(current, apiChannel),
        ));
        return channel;
      } catch (err) {
        console.error("Failed to load channel:", err);
        return null;
      } finally {
        ensureChannelInFlight.delete(channelId);
      }
    })();
    ensureChannelInFlight.set(channelId, request);
    return request;
  },

  addOrRefreshDM: async (channelId) => {
    const { dmChannels } = useChannelStore.getState();
    const existing = dmChannels.find((c) => c.id === channelId);
    if (existing) {
      // Move to front (most recent message) — a real reorder, so the array ref
      // legitimately changes. The timestamp goes to the activity slice.
      set((state) => reduceChannelWithTrace(
        state,
        "dm:refresh",
        channelId,
        (current) => refreshExistingDm(current, channelId, new Date().toISOString()),
      ));
      return;
    }
    // New DM — re-fetch the full list (backend returns sorted)
    try {
      const readLedgerGeneration = getReadStateLedgerGeneration();
      const requestEpoch = useServerStore.getState().serverEpoch;
      const requestServerId = useServerStore.getState().current?.id ?? null;
      const { data } = await api.get("/channels/dm");
      const apiDms = data as ApiChannel[];
      // #632 C1: re-verify the request's epoch/server identity and bail out
      // entirely — a late response from a superseded server must produce ZERO
      // writes, and that includes the DOMAIN store, not just the read-state
      // ledger. Gating only the ledger fold still let A's DM list hydrate into
      // B after a server switch.
      if (
        useServerStore.getState().serverEpoch !== requestEpoch
        || useServerStore.getState().current?.id !== requestServerId
      ) {
        return;
      }
      consumeReadStateSnapshotRows(
        requestServerId,
        apiDms.map((c) => ({ scopeId: c.id, readState: c.readState })),
        { ledgerGenerationAtRequest: readLedgerGeneration },
      );
      set((state) => reduceChannelWithTrace(
        state,
        "hydrate:dm",
        "dm-list",
        (current) => hydrateDmChannels({ ...current, dmChannels: [] }, apiDms),
      ));
    } catch (err) {
      console.error("Failed to refresh DM channels:", err);
    }
  },

  touchChannelActivity: (channelId, lastMessageAt) => {
    const nextLastMessageAt = lastMessageAt ?? new Date().toISOString();
    // `lastMessageAt` lives in its own slice, so a bump NEVER touches the
    // `channels`/`dmChannels` identity arrays — no identity consumer re-renders
    // on inbound messages. Only recency-sorting consumers subscribe
    // `channelActivity` and re-sort (#proj-frontend render-perf, first-principles).
    set((state) => reduceChannelWithTrace(
      state,
      "activity:touch",
      channelId,
      (current) => reduceChannelActivity(current, channelId, nextLastMessageAt),
    ));
  },

  setActivityMuteState: (channelId, muteState) => {
    set((state) => reduceChannelWithTrace(
      state,
      "activity-mute:set",
      channelId,
      (current) => applyActivityMuteState(current, channelId, muteState),
      muteState.activityMuted ? "muted" : "unmuted",
    ));
  },

  setMessageDisplayPrefsState: (channelId, prefs) => {
    set((state) => reduceChannelWithTrace(
      state,
      "message-display-prefs:set",
      channelId,
      (current) => applyMessageDisplayPrefsState(current, channelId, prefs),
      prefs.collapseLongMessages ? "collapse_on" : "collapse_off",
    ));
  },

  applyChannelPatch: (channel, defaultType = "channel") => {
    set((state) => reduceChannelWithTrace(
      state,
      "patch",
      channel.id,
      (current) => patchChannel(current, channel, defaultType),
    ));
  },

  createChannel: async (name, description, opts) => {
    const { data } = await api.post("/channels", {
      name,
      description,
      visibility: opts?.visibility ?? "public",
      agentIds: opts?.agentIds ?? [],
      userIds: opts?.userIds ?? [],
      targetServerSlug: opts?.targetServerSlug,
      invitedPeople: opts?.invitedPeople ?? [],
      jointInvites: opts?.jointInvites,
    });
    const apiChannel = data as ApiChannel;
    const channel = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "create",
      channel.id,
      (current) => patchChannel(current, apiChannel),
    ));
    // Join the socket room so we receive real-time messages
    joinRealtimeChannel(channel.id);
    return channel;
  },

  updateChannel: async (channelId, updates) => {
    const { data } = await api.patch(`/channels/${channelId}`, updates);
    const apiChannel = data as ApiChannel;
    const updated = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "update",
      channelId,
      (current) => patchChannel(current, apiChannel),
    ));
    return updated;
  },

  // #all is hidden through its own endpoint, never through the generic channel
  // visibility field -- the server refuses that field for #all outright. Both
  // directions are id-free because a hidden #all is absent from channel lists,
  // so the caller cannot be expected to know its id.
  hideAllChannel: async () => {
    const { data } = await api.post("/channels/system/all/hide");
    const apiChannel = data as ApiChannel;
    const hidden = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "hide-all",
      hidden.id,
      (current) => patchChannel(current, apiChannel),
    ));
    return hidden;
  },

  restoreAllChannel: async () => {
    const { data } = await api.post("/channels/system/all/restore");
    const apiChannel = data as ApiChannel;
    const restored = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "restore-all",
      restored.id,
      (current) => patchChannel(current, apiChannel),
    ));
    return restored;
  },

  convertChannelToJoint: async (channelId, opts) => {
    const { data } = await api.post(`/channels/${channelId}/convert-to-joint`, opts?.confirmTaskIdentityDrop
      ? { confirmTaskIdentityDrop: true }
      : undefined);
    const apiChannel = ((data as { channel?: ApiChannel }).channel ?? data) as ApiChannel;
    const converted = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "convert-to-joint",
      channelId,
      (current) => patchChannel(current, apiChannel),
    ));
    return converted;
  },

  deleteChannel: async (channelId) => {
    await api.delete(`/channels/${channelId}`);
    set((state) => reduceChannelWithTrace(
      state,
      "delete",
      channelId,
      (current) => removeChannel(current, channelId),
    ));
  },

  disconnectJointChannel: async (channelId) => {
    await api.post(`/channels/${channelId}/disconnect`);
    set((state) => reduceChannelWithTrace(
      state,
      "disconnect-joint",
      channelId,
      (current) => removeChannel(current, channelId, { includeDm: false }),
    ));
  },

  resendJointChannelInvite: async (channelId) => {
    const { data } = await api.post(`/channels/${channelId}/joint-invite/resend`);
    return data as { resentCount: number };
  },

  inviteJointChannelServer: async (channelId, input) => {
    const { data } = await api.post(`/channels/${channelId}/joint-invites`, input);
    const apiChannel = data as ApiChannel;
    const updated = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "invite-joint-server",
      channelId,
      (current) => patchChannel(current, apiChannel),
    ));
    return updated;
  },

  archiveChannel: async (channelId) => {
    const { data } = await api.post(`/channels/${channelId}/archive`);
    const apiChannel = data as ApiChannel;
    const updated = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "archive",
      channelId,
      (current) => patchChannel(current, apiChannel),
    ));
    return updated;
  },

  unarchiveChannel: async (channelId) => {
    const { data } = await api.post(`/channels/${channelId}/unarchive`);
    const apiChannel = data as ApiChannel;
    const updated = toChannel(apiChannel);
    set((state) => reduceChannelWithTrace(
      state,
      "unarchive",
      channelId,
      (current) => patchChannel(current, apiChannel),
    ));
    return updated;
  },

  openDM: (agentId) => {
    const requestKey = `${useServerStore.getState().current?.id ?? "no-server"}:${agentId}`;
    const pending = openAgentDmInFlight.get(requestKey);
    if (pending) return pending;

    const request = (async () => {
      try {
        const { data } = await api.post("/channels/dm", { agentId });
        const apiChannel = data as ApiChannel;
        const dmChannel = toChannel(apiChannel, "dm");

        set((state) => reduceChannelWithTrace(
          state,
          "open-dm",
          dmChannel.id,
          (current) => patchChannel(current, apiChannel, "dm"),
        ));
        // Join the socket room so we receive real-time messages
        joinRealtimeChannel(dmChannel.id);
        return dmChannel;
      } finally {
        openAgentDmInFlight.delete(requestKey);
      }
    })();
    openAgentDmInFlight.set(requestKey, request);
    return request;
  },

  openUserDM: (userId) => {
    const requestKey = `${useServerStore.getState().current?.id ?? "no-server"}:${userId}`;
    const pending = openUserDmInFlight.get(requestKey);
    if (pending) return pending;

    const request = (async () => {
      try {
        const { data } = await api.post("/channels/dm", { userId });
        const apiChannel = data as ApiChannel;
        const dmChannel = toChannel(apiChannel, "dm");

        set((state) => reduceChannelWithTrace(
          state,
          "open-user-dm",
          dmChannel.id,
          (current) => patchChannel(current, apiChannel, "dm"),
        ));
        // Join the socket room so we receive real-time messages
        joinRealtimeChannel(dmChannel.id);
        return dmChannel;
      } finally {
        openUserDmInFlight.delete(requestKey);
      }
    })();
    openUserDmInFlight.set(requestKey, request);
    return request;
  },

  joinChannel: async (channelId) => {
    try {
      await api.post(`/channels/${channelId}/join`);
      set((state) => reduceChannelWithTrace(
        state,
        "join",
        channelId,
        (current) => setLocalChannelMembership(current, channelId, true),
        "joined",
      ));
      // Join the socket room so we receive real-time messages
      joinRealtimeChannel(channelId);
      return true;
    } catch (err) {
      console.error("Failed to join channel:", err);
      return false;
    }
  },

  leaveChannel: async (channelId) => {
    try {
      await api.post(`/channels/${channelId}/leave`);
      set((state) => reduceChannelWithTrace(
        state,
        "leave",
        channelId,
        (current) => setLocalChannelMembership(current, channelId, false),
        "left",
      ));
    } catch (err) {
      console.error("Failed to leave channel:", err);
    }
  },
}));

// Reset all server-scoped state when the user switches servers.
registerServerReset(() =>
  useChannelStore.setState({ channels: [], dmChannels: [], channelActivity: {}, channelLocalMembership: {}, loading: true })
);
// Stryker restore all
