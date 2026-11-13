import type { ExternalFreezeFields } from "../utils/jointChannelLimit";
import { channelConversionState, conversionResponseState } from "./channelConversionState";
import { isAxiosError } from "axios";
import { create } from "zustand";
import api from "../api/client";
import {
  applyActivityMuteState,
  applyMessageDisplayPrefsState,
  hydrateChannels,
  hydrateDmChannels,
  nextPatchSeq,
  patchChannel,
  refreshExistingDm,
  removeChannel,
  setLocalChannelMembership,
  toChannel,
  touchChannelActivity as reduceChannelActivity,
} from "./channelDomain";
import type { ChannelConversionCommandView, ChannelConversionJobView, ChannelConversionState, ChannelAdminBasis, ChannelRole, ChannelThreadSort, ChannelThreadSortFields, InboxScopeReadFrontier, ServerCapability } from "@botiverse/raft-shared";
import { bootListKey, coalesce, noteFreshLoad, useServerStore } from "./serverStore";
import { consumeReadStateSnapshotRows, getReadStateLedgerGeneration } from "./readStateSync";
import { registerServerReset } from "./serverResetRegistry";
import { channelDetailRequestConfig } from "./channelDetailReason";
import type { ChannelDetailReason } from "./channelDetailReason";
import { useReadReceiptStore } from "./readReceiptStore";
import { localTableSession, writeChannelList } from "./localTables/storeWriters";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { joinChannelOnce, joinRealtimeChannel, withJoining } from "./channelJoin";
import type { ChannelJoinSource } from "./channelJoin";
import { channelTraceStateChanged, transitionOutcomeDetail } from "../utils/stateTransitionChange";
import { findStoredChannel } from "./storedChannel";
import { noteChannelOpenResult } from "./channelAccessLoss";

export interface Channel extends ExternalFreezeFields, ChannelThreadSortFields {
  id: string;
  serverId?: string;
  name: string;
  description: string | null;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  /** The member's explicit notification level here (contract §2.2; absent = default or an older server). */
  notificationLevel?: "default" | "all" | "mentions" | "none" | null;
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
    /** Why sync stopped; present only while the binding is not active. */
    stateReason?: string;
    /** Present only while Raft messages for Slack are held (server channelService). */
    outbound?:
      | {
          status: "waiting";
          reason: "connection" | "credentials" | "configuration" | "invite_app" | "reauthorize" | "unarchive" | "check_channel";
          /** Why Raft cannot yet confirm whether the held message reached Slack; absent from an older server. */
          detail?: "history_limited" | "metadata_missing" | "marker_unconfirmed";
          since: string;
        }
      | { status: "stalled"; since: string };
    /** The Slack installation's state, present only while it is not active. */
    installState?: "pending" | "reauth_required" | "disconnected" | "revoked" | "quarantined";
  };
  /** Legacy mirror of `visitorVisible`, still sent for one release. */
  guestVisible?: boolean;
  /** Signed-out visitors of the server's public page can read this channel
   *  (#wg-rbac:#51). Set with PATCH `{ visitorVisible }`, server owners and
   *  admins only (`channelCapabilities.manageVisitorAccess`). */
  visitorVisible?: boolean;
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
    /** Free or paid as the joint's free-server cap counts it; absent from older servers. */
    plan?: "free" | "paid";
    /** Active servers: the channel's name on that server (names are per server). */
    channelName?: string;
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
  /**
   * The channel has a Guest or an open external invite (#wg-rbac:#16, server
   * #12190). Sent only to non-guest members of the channel's own Server and
   * left out of broadcast rows and joint projections: a patch without the key
   * keeps the value the row had (patchChannel merges).
   */
  hasExternalRelation?: boolean;
  /** Contract v0.3 §18.8: grace deadline while over the free-server cap; null otherwise. */
  jointOverLimitGraceEndsAt?: string | null;
  conversionState?: ChannelConversionState;
  // Rolling API compatibility; conversion readers use the shared state adapter.
  conversionCommand?: ChannelConversionCommandView | null;
  conversionJob?: ChannelConversionJobView | null;
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
  peerAvatarUrl?: string | null;
  /**
   * Agent Lounge v0: the agent this channel is the Lounge of. A Lounge is a
   * public channel on the wire, but it lives in its own slice
   * (`loungeChannels`), never in `channels`, so no channel list, ⌘K, forward
   * target or browse view shows it. Absent or null: not a Lounge.
   */
  loungeAgentId?: string | null;
  /** Agent Lounge v0: from POST /agents/:id/lounge; false = may read, not post. Absent = may post. */
  canPost?: boolean;
  /** Agent Lounge v0, on an agent DM row of GET /channels/dm: that agent's Lounge, present only once it exists. */
  lounge?: AgentLoungeSummary;
}

/** The Lounge an agent DM row carries (GET /channels/dm, Agent Lounge v0). */
export interface AgentLoungeSummary {
  channelId: string;
  joined: boolean;
  unreadCount: number;
  mentionCount?: number;
}

/** POST /agents/:agentId/lounge: the agent's Lounge, opened (made the first time). */
export interface AgentLoungeOpenResult {
  channel: Channel;
  joined: boolean;
  canPost: boolean;
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

const ensureChannelInFlight = new Map<string, Promise<Channel | null>>();
/**
 * Per channel, bumped by every refresh. A refresh is asked because something
 * changed: it never joins a request already in flight (that answer may be
 * from before the change), and an answer that comes back after a newer
 * refresh was sent is dropped, so an older row never overwrites a newer one.
 */
const ensureChannelGeneration = new Map<string, number>();
const openAgentDmInFlight = new Map<string, Promise<Channel>>();
const openUserDmInFlight = new Map<string, Promise<Channel>>();
const openLoungeInFlight = new Map<string, Promise<AgentLoungeOpenResult>>();

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
  /** Agent Lounges (Agent Lounge v0), kept apart from `channels`: see `Channel.loungeAgentId`. */
  loungeChannels: Channel[];
  /** Per-channel last-message timestamp, separated from the channel identity
   *  objects so an activity bump never churns the `channels`/`dmChannels`
   *  array references. Only recency-sorting consumers subscribe this. */
  channelActivity: Record<string, string | null>;
  channelLocalMembership: Record<string, boolean>;
  /** Per row, the patch-clock value its data was observed at: see `ChannelDomainState` (#239). */
  channelPatchStamps: Record<string, number>;
  joiningChannelIds: Record<string, true>; // join in flight: the Join button shows it
  loading: boolean;
  /** Like `loading`, for the DM list (GET /channels/dm answers on its own). */
  dmsLoading: boolean;
  loadChannels: () => Promise<void>;
  loadDMChannels: () => Promise<void>;
  /** `reason` labels the request for the server span (default `refresh` / `ensure`). */
  ensureChannel: (channelId: string, opts?: { refresh?: boolean; reason?: ChannelDetailReason }) => Promise<Channel | null>;
  addOrRefreshDM: (channelId: string) => Promise<void>;
  touchChannelActivity: (channelId: string, lastMessageAt?: string | null) => void;
  applyChannelPatch: (channel: ApiChannel, defaultType?: Channel["type"]) => void;
  createChannel: (name: string, description?: string, opts?: {
    visibility?: "public" | "private" | "joint";
    agentIds?: string[];
    userIds?: string[];
    targetServerSlug?: string;
    invitedPeople?: string[];
    jointInvites?: Array<{ targetServerSlug: string; invitedPeople: string[]; sameAdmin?: boolean }>;
    actionCardMessageId?: string;
    actionCardConfirmationVersion?: number;
  }) => Promise<Channel>;
  updateChannel: (channelId: string, updates: { name?: string; description?: string; visibility?: "public" | "private"; visitorVisible?: boolean; threadSort?: ChannelThreadSort; announcement?: string | null }) => Promise<Channel>;
  restoreAllChannel: () => Promise<Channel>;
  hideAllChannel: () => Promise<Channel>;
  convertChannelToJoint: (channelId: string, opts?: { observeProgress?: boolean; commandId?: string }) => Promise<Channel>;
  getChannelConversionJob: (jobId: string) => Promise<{ conversionState?: ChannelConversionState; channel?: ApiChannel; conversionJob: NonNullable<Channel["conversionJob"]> }>;
  retryChannelConversionJob: (jobId: string, commandId?: string) => Promise<{ conversionState?: ChannelConversionState; channel?: ApiChannel; conversionJob: NonNullable<Channel["conversionJob"]>; conversionCommand?: Channel["conversionCommand"] }>;
  cancelChannelConversionJob: (jobId: string, commandId?: string) => Promise<{ conversionState?: ChannelConversionState; channel?: ApiChannel; conversionJob: NonNullable<Channel["conversionJob"]>; conversionCommand?: Channel["conversionCommand"] }>;
  deleteChannel: (channelId: string) => Promise<void>;
  disconnectJointChannel: (channelId: string) => Promise<void>;
  resendJointChannelInvite: (channelId: string) => Promise<{ resentCount: number }>;
  inviteJointChannelServer: (channelId: string, input: { targetServerSlug: string; invitedPeople: string[]; sameAdmin?: boolean }) => Promise<Channel>;
  setActivityMuteState: (channelId: string, state: { activityMuted: boolean; muteFromSeq: string | number | null; activityMuteSupported?: boolean; prefsVersion?: number }) => void;
  setMessageDisplayPrefsState: (channelId: string, prefs: { collapseLongMessages: boolean; prefsVersion?: number }) => void;
  archiveChannel: (channelId: string) => Promise<Channel>;
  unarchiveChannel: (channelId: string) => Promise<Channel>;
  openDM: (agentId: string) => Promise<Channel>;
  openUserDM: (userId: string) => Promise<Channel>;
  /** Agent Lounge v0: open the agent's Lounge (the server makes it the first time). */
  openLounge: (agentId: string) => Promise<AgentLoungeOpenResult>;
  joinChannel: (channelId: string, source?: ChannelJoinSource) => Promise<boolean>;
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
  loungeChannels: [],
  channelActivity: {},
  channelLocalMembership: {},
  channelPatchStamps: {},
  joiningChannelIds: {},
  loading: true,
  dmsLoading: true,

  loadChannels: async () => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    const readLedgerGeneration = getReadStateLedgerGeneration();
    if (!serverId) return;
    // Coalesce concurrent triggers (bootstrap + realtime fallbacks + manual
    // refreshes) onto one request; the epoch in the key keeps an epoch change
    // from piggybacking on a stale-epoch fetch. Never set loading here — it
    // starts as true (store init / server reset) and goes to false after the
    // first successful fetch, keeping existing data visible during refreshes.
    return coalesce(`channels:${serverId}:${epoch}`, async () => {
      const session = localTableSession();
      const requestSeq = nextPatchSeq(); // rows observed after this are newer than the answer (#239)
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
          (current) => ({ ...hydrateChannels(current, apiChannels, requestSeq), loading: false }),
        ));
        writeChannelList(session, serverId, get().channels);
        noteFreshLoad(bootListKey.channels(serverId, epoch));
      } catch (err) {
        console.error("Failed to load channels:", err);
        if (useServerStore.getState().serverEpoch !== epoch) return;
        set({ loading: false });
      }
    });
  },

  loadDMChannels: async () => {
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    const readLedgerGeneration = getReadStateLedgerGeneration();
    if (!serverId) return;
    return coalesce(`dm-channels:${serverId}:${epoch}`, async () => {
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
          (current) => ({ ...hydrateDmChannels(current, apiDms), dmsLoading: false }),
        ));
      } catch (err) {
        console.error("Failed to load DM channels:", err);
        if (useServerStore.getState().serverEpoch !== epoch) return;
        set({ dmsLoading: false });
      }
    });
  },

  ensureChannel: async (channelId, opts) => {
    const existing = findStoredChannel(get(), channelId);
    if (existing && !opts?.refresh) return existing;

    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    const readLedgerGeneration = getReadStateLedgerGeneration();
    if (!serverId) return null;

    if (!opts?.refresh) {
      const pending = ensureChannelInFlight.get(channelId);
      if (pending) return pending;
    }
    const generation = (ensureChannelGeneration.get(channelId) ?? 0) + (opts?.refresh ? 1 : 0);
    ensureChannelGeneration.set(channelId, generation);
    const superseded = () => ensureChannelGeneration.get(channelId) !== generation;
    const currentRow = () => findStoredChannel(get(), channelId) ?? null;
    const observedSeq = nextPatchSeq(); // the answer is as of now, not when it lands (#239)

    let request!: Promise<Channel | null>;
    request = (async () => {
      try {
        const reason = opts?.reason ?? (opts?.refresh ? "refresh" : "ensure");
        const { data } = await api.get(`/channels/${channelId}`, channelDetailRequestConfig(reason));
        if (useServerStore.getState().serverEpoch !== epoch) return null;
        if (superseded()) return currentRow();
        noteChannelOpenResult(channelId, null);
        const apiChannel = data as ApiChannel;
        // Opening it next loads its read receipts from this same endpoint:
        // hand over this answer. A thread joins its room only when it opens,
        // so its receipts are loaded then.
        if (apiChannel.type !== "thread") useReadReceiptStore.getState().offerChannelDetail(channelId, data);
        const channel = toChannel(apiChannel);
        // #632 C1: same adapter for the single-channel authority hydrate.
        consumeReadStateSnapshotRows(serverId, [{ scopeId: apiChannel.id, readState: apiChannel.readState }], { ledgerGenerationAtRequest: readLedgerGeneration });

        set((state) => reduceChannelWithTrace(
          state,
          "ensure",
          channelId,
          (current) => patchChannel(current, apiChannel, "channel", observedSeq),
        ));
        return channel;
      } catch (err) {
        // A link to a conversation this person can't open says so (MainLayout's
        // ChannelById / DmById). Not from an answer a newer request superseded:
        // an older 404 must not undo the newer success that cleared the mark.
        if (useServerStore.getState().serverEpoch === epoch && !superseded()) noteChannelOpenResult(channelId, err);
        // A refresh answered 404: this person can no longer read it (removed
        // from a private channel, deleted, another server). Drop it as
        // deleteChannel does, so nothing keeps showing it (the sidebar,
        // Activity's kept rows). Only the row this request was about: one
        // patched in meanwhile (re-added, `channel:updated`) is newer than
        // the 404. Not listed (a non-member's room-wide event): nothing to do.
        if (opts?.refresh && isAxiosError(err) && err.response?.status === 404
          && useServerStore.getState().serverEpoch === epoch && !superseded()) {
          set((state) => {
            const current = findStoredChannel(state, channelId);
            if (!current || current !== existing) return state;
            return reduceChannelWithTrace(
              state,
              "access-lost",
              channelId,
              (domain) => removeChannel(domain, channelId, { observedSeq }),
            );
          });
          return null;
        }
        console.error("Failed to load channel:", err);
        return null;
      } finally {
        if (ensureChannelInFlight.get(channelId) === request) ensureChannelInFlight.delete(channelId);
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
        // The whole list is in, as from loadDMChannels: the DM section is loaded.
        (current) => ({ ...hydrateDmChannels({ ...current, dmChannels: [] }, apiDms), dmsLoading: false }),
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
      ...(opts?.actionCardMessageId ? { actionCardMessageId: opts.actionCardMessageId } : {}),
      ...(opts?.actionCardConfirmationVersion !== undefined ? { actionCardConfirmationVersion: opts.actionCardConfirmationVersion } : {}),
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

  // #all is hidden through its dedicated endpoint; the generic visibility
  // update intentionally cannot target this system channel.
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

  convertChannelToJoint: async (channelId, opts) => {
    const requestBody = opts ? { observeProgress: opts.observeProgress, ...(opts.commandId ? { commandId: opts.commandId } : {}) } : undefined;
    const { data } = await api.post(`/channels/${channelId}/convert-to-joint`, requestBody);
    const payload = data as { channel?: ApiChannel; conversionState?: ChannelConversionState; conversionJob?: Channel["conversionJob"]; conversionCommand?: Channel["conversionCommand"] };
    const conversionState = conversionResponseState(payload);
    const conversionJob = payload.conversionJob;
    if (payload.channel) {
      const apiChannel = { ...payload.channel, conversionState, ...(conversionJob ? { conversionJob } : {}) };
      const converted = toChannel(apiChannel);
      set((state) => reduceChannelWithTrace(
        state,
        "convert-to-joint",
        channelId,
        (current) => patchChannel(current, apiChannel),
      ));
      return converted;
    }

    // Observable starts intentionally return the durable job before the
    // converted channel exists. Preserve the current channel identity until
    // the terminal poll supplies the authority row.
    const current = [...get().channels, ...get().dmChannels].find((channel) => channel.id === channelId);
    if (!current) throw new Error("Channel conversion start response was incomplete");
    if (!conversionJob && payload.conversionCommand) {
      return { ...current, conversionState, conversionCommand: payload.conversionCommand };
    }
    if (!conversionJob) throw new Error("Channel conversion start response was incomplete");
    return { ...current, conversionState, conversionJob, conversionCommand: payload.conversionCommand ?? null };
  },

  getChannelConversionJob: async (jobId) => {
    const observedSeq = nextPatchSeq(); // a poll answer is as of now (#239)
    const { data } = await api.get(`/channels/conversion-jobs/${jobId}`);
    const payload = data as { conversionState?: ChannelConversionState; channel?: ApiChannel; conversionJob: NonNullable<Channel["conversionJob"]> };
    payload.conversionState = conversionResponseState(payload);
    if (payload.channel) {
      const apiChannel = { ...payload.channel, conversionState: payload.conversionState, conversionJob: payload.conversionJob };
      // A polling GET may have been in flight when Cancel committed. Do not
      // let that stale running/failed snapshot overwrite the canceled receipt
      // already written by cancelChannelConversionJob; doing so would make a
      // later Settings mount resurrect a job that the user explicitly stopped.
      const current = [...get().channels, ...get().dmChannels]
        .find((channel) => channel.id === apiChannel.id);
      const currentJob = channelConversionState(current).job;
      const nextJob = payload.conversionState.job;
      const sameCanceledJob = currentJob?.status === "canceled" && currentJob.id === nextJob?.id
        && nextJob.status !== "canceled";
      if (!sameCanceledJob) {
        set((state) => reduceChannelWithTrace(
          state,
          "conversion-progress",
          apiChannel.id,
          (currentState) => patchChannel(currentState, apiChannel, "channel", observedSeq),
        ));
      }
    }
    return payload;
  },

  retryChannelConversionJob: async (jobId, commandId) => {
    const { data } = await api.post(`/channels/conversion-jobs/${jobId}/retry`, commandId ? { commandId } : undefined);
    const payload = data as { conversionState?: ChannelConversionState; channel?: ApiChannel; conversionJob: NonNullable<Channel["conversionJob"]> };
    payload.conversionState = conversionResponseState(payload);
    if (payload.channel) {
      const apiChannel = { ...payload.channel, conversionState: payload.conversionState, conversionJob: payload.conversionJob };
      set((state) => reduceChannelWithTrace(
        state,
        "conversion-retry",
        apiChannel.id,
        (current) => patchChannel(current, apiChannel),
      ));
    }
    return payload;
  },

  cancelChannelConversionJob: async (jobId, commandId) => {
    const { data } = await api.post(`/channels/conversion-jobs/${jobId}/cancel`, commandId ? { commandId } : undefined);
    const payload = data as { conversionState?: ChannelConversionState; channel?: ApiChannel; conversionJob: NonNullable<Channel["conversionJob"]> };
    payload.conversionState = conversionResponseState(payload);
    if (payload.channel) {
      const apiChannel = { ...payload.channel, conversionState: payload.conversionState, conversionJob: payload.conversionJob };
      set((state) => reduceChannelWithTrace(
        state,
        "conversion-cancel",
        apiChannel.id,
        (current) => patchChannel(current, apiChannel),
      ));
    }
    return payload;
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

  openLounge: (agentId) => {
    const requestKey = `${useServerStore.getState().current?.id ?? "no-server"}:${agentId}`;
    const pending = openLoungeInFlight.get(requestKey);
    if (pending) return pending;

    const request = (async () => {
      try {
        const { data } = await api.post(`/agents/${agentId}/lounge`);
        const payload = data as { channel: ApiChannel; joined?: boolean; canPost?: boolean };
        // The answer's own `joined` / `canPost` win over the row's; the row
        // always lands in the Lounge slice, even from a server that left
        // `loungeAgentId` off it.
        const apiChannel: ApiChannel = {
          ...payload.channel,
          loungeAgentId: payload.channel.loungeAgentId ?? agentId,
          ...(typeof payload.joined === "boolean" ? { joined: payload.joined } : {}),
          ...(typeof payload.canPost === "boolean" ? { canPost: payload.canPost } : {}),
        };
        set((state) => reduceChannelWithTrace(
          state,
          "open-lounge",
          apiChannel.id,
          (current) => patchChannel(current, apiChannel),
        ));
        joinRealtimeChannel(apiChannel.id);
        const channel = findStoredChannel(get(), apiChannel.id) ?? toChannel(apiChannel);
        return {
          channel,
          joined: channel.joined === true,
          canPost: channel.canPost !== false,
        };
      } finally {
        openLoungeInFlight.delete(requestKey);
      }
    })();
    openLoungeInFlight.set(requestKey, request);
    return request;
  },

  joinChannel: (channelId, source) => channelJoiner.join(channelId, source),

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

const channelJoiner = joinChannelOnce({
  post: (channelId) => api.post(`/channels/${channelId}/join`),
  onJoined: (channelId) => {
    useChannelStore.setState((state) => reduceChannelWithTrace(state, "join", channelId, (current) => setLocalChannelMembership(current, channelId, true), "joined"));
    joinRealtimeChannel(channelId); // the socket room delivers real-time messages
  },
  setJoining: (channelId, joining) => useChannelStore.setState((state) => ({ joiningChannelIds: withJoining(state.joiningChannelIds, channelId, joining) })),
});

// Reset all server-scoped state when the user switches servers.
registerServerReset(() => channelJoiner.reset());
registerServerReset(() =>
  useChannelStore.setState({ channels: [], dmChannels: [], loungeChannels: [], channelActivity: {}, channelLocalMembership: {}, channelPatchStamps: {}, joiningChannelIds: {}, loading: true, dmsLoading: true })
);
// Stryker restore all
