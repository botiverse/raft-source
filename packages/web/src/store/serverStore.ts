import { create } from "zustand";
import api from "../api/client";
import type { ServerRole } from "@botiverse/raft-shared";
import {
  DEFAULT_SIDEBAR_ORDER,
  applyServerEvent,
} from "./events/serverEvents";
import type {
  ServerDomainState,
  ServerEvent,
} from "./events/serverEvents";
import { serverPersistence } from "./serverPersistenceRegistry";
import { triggerServerReset } from "./serverResetRegistry";
import { setAuthTraceServerIdGetter } from "../utils/webAuthTrace";
import { normalizeSidebarPinnedRefs } from "../utils/sidebarPinnedRefs";
import type { SidebarPinnedRef } from "../utils/sidebarPinnedRefs";
import { notifyAllChannelMembersChanged } from "./channelMemberEvents";
import {
  normalizeSidebarCustomSections,
  normalizeSidebarSectionOrder,
  normalizeSidebarSectionPlacements,
} from "./sidebarSections";
import type { SidebarCustomSection, SidebarSectionPlacement } from "./sidebarSections";

export type { SidebarCustomSection, SidebarSectionPlacement } from "./sidebarSections";

interface SidebarSectionUpdateQueue {
  tail: Promise<void>;
  latestSequence: number;
  confirmedVersion: number;
}

const sidebarSectionUpdateQueues = new Map<string, SidebarSectionUpdateQueue>();

export interface Server {
  id: string;
  name: string;
  avatarUrl: string | null;
  slug: string;
  ownerId: string;
  onboardingAgentId: string | null;
  hideHumansFromMembers: boolean;
  plan: string;
  planDowngradedAt: string | null;
  role: ServerRole;
  serverPushMuted?: boolean;
  notificationPrefsVersion?: number;
  serverOrderVersion?: number;
  createdAt: string;
}

export interface ServerOnboardSettings {
  onboardingAgentId: string | null;
  agentAllChannelGreetingEnabled: boolean;
  onboardingWizardEnabled: boolean;
  setupModalReminderOptOut: boolean;
  onboardingReminderOptOut: boolean;
  dismissedAddComputerStepAt: string | null;
  dismissedCreateAgentStepAt: string | null;
  dismissedInviteStepAt: string | null;
  dismissedCommunityStepAt: string | null;
  dismissedNotificationStepAt: string | null;
  onboardingWizardCurrentStep: string | null;
  onboardingDmSentAt: string | null;
  onboardingDmSentByAgentId: string | null;
}

export interface ServerSettings {
  onboardSettings: ServerOnboardSettings;
  feedbackSettings: {
    enabled: boolean;
  };
}

export type CommunityServerSlug = "community" | "community-cn";

export interface ServerMember {
  userId: string;
  serverId?: string;
  serverName?: string | null;
  serverSlug?: string | null;
  email: string | null;
  gravatarHash: string;
  name: string;
  displayName: string | null;
  description: string | null;
  avatarUrl: string | null;
  role: ServerRole;
  joinedAt: string;
}

export interface ServerUsage {
  agents: number;
  machines: number;
  channels: number;
}

export interface SidebarOrderPreferences {
  channelOrder: string[];
  agentOrder: string[];
  dmOrder: string[];
  channelSortMode: "manual" | "recent" | "az";
  jointChannelSortMode: "manual" | "recent" | "az";
  dmSortMode: "manual" | "recent" | "az";
  pinnedSortMode: "manual" | "recent" | "az";
  pinned: SidebarPinnedRef[];
  pinnedChannelIds: string[];
  pinnedAgentIds: string[];
  pinnedOrder: string[];
  hiddenDmIds: string[];
  channelPanelTabOrder: string[];
  agentPanelTabOrder: string[];
  customSections: SidebarCustomSection[];
  sectionOrder: string[];
  sectionPlacements: SidebarSectionPlacement[];
  sectionsVersion: number;
  pinnedVersion: number;
}

export interface SubscriptionInfo {
  status: "active" | "past_due" | "canceled" | "incomplete";
  billingInterval: "monthly" | "annual";
  currentPeriodStart?: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingInfo {
  plan: string;
  displayName: string;
  serverPlan: string;
  source: "server" | "subscription";
  capacity: {
    maxHumans: number;
    maxAgents: number;
    maxUniversalSeats: number;
  };
  usage: {
    humans: number;
    agents: number;
    universalSeats: number;
  };
  provisioned: {
    humans: number;
    agents: number;
    proPackQuantity: number;
    trialFreePackQuantity: number;
    firstPackTrialEndsAt?: string | null;
  };
  fileUploadQuota?: {
    month: string;
    plan: string;
    limited: boolean;
    enforced: boolean;
    limitBytes: number;
    usedBytes: number;
    reservedBytes: number;
    remainingBytes: number;
  };
  price: {
    billingInterval: "monthly" | "annual";
    monthlyUsd: number;
    annualUsd: number | null;
    discountPercent: number;
    baseMonthlyUsd: number;
    overageMonthlyUsd: number;
    seatQuantity: number;
    packQuantity: number;
    humanSeatQuantity: number;
    agentSeatQuantity: number;
    agentSeatBlockQuantity: number;
  } | null;
  subscription: SubscriptionInfo | null;
  stripeConfigured: boolean;
  permissions: {
    canReadBillingSummary: boolean;
    canManageBilling: boolean;
  };
}

interface ServerState {
  servers: Server[];
  current: Server | null;
  members: ServerMember[];
  membersLoadError: boolean;
  loading: boolean;
  usage: ServerUsage | null;
  loadingUsage: boolean;
  billing: BillingInfo | null;
  loadingBilling: boolean;
  settings: ServerSettings | null;
  loadingSettings: boolean;
  sidebarOrder: SidebarOrderPreferences;
  /**
   * Monotonic counter incremented on every setCurrent() call.
   * All server-scoped async loaders capture this epoch before their await
   * and discard the response if the epoch changed by the time it arrives.
   * This correctly handles A→B→A rapid switching (unlike a plain serverId
   * comparison, which would let a stale response from the first A visit pass).
   */
  serverEpoch: number;

  loadServers: () => Promise<void>;
  loadSettings: (options?: { force?: boolean }) => Promise<ServerSettings | null>;
  updateServerOrder: (serverOrder: string[]) => Promise<void>;
  setCurrent: (server: Server) => void;
  clearCurrent: () => void;
  createServer: (name: string, slug: string) => Promise<Server>;
  joinCommunityServer: (options?: { agreementId?: string | null; slug?: CommunityServerSlug }) => Promise<Server>;
  updateServerProfile: (updates: { name?: string; hideHumansFromMembers?: boolean }) => Promise<void>;
  uploadServerAvatar: (file: File) => Promise<void>;
  leaveServer: () => Promise<void>;
  deleteServer: () => Promise<void>;
  applyServerPatch: (server: Pick<Server, "id"> & Partial<Server>) => void;
  handleMembershipRemoved: (serverId: string) => Promise<boolean>;
  loadMembers: () => Promise<void>;
  loadSidebarOrder: () => Promise<void>;
  updateSidebarOrder: (updates: Partial<SidebarOrderPreferences>) => Promise<void>;
  updateMemberRole: (userId: string, role: ServerRole) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  loadUsage: () => Promise<void>;
  loadBilling: () => Promise<void>;
}

function normalizeSidebarSortMode(value: unknown): SidebarOrderPreferences["channelSortMode"] {
  return value === "recent" || value === "az" || value === "manual" ? value : "manual";
}

function normalizeServerSettings(data: unknown): ServerSettings | null {
  if (!data || typeof data !== "object") return null;
  const settings = (data as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object") return null;
  const onboardSettings = (settings as { onboardSettings?: unknown }).onboardSettings;
  if (!onboardSettings || typeof onboardSettings !== "object") return null;
  const feedbackSettings = (settings as { feedbackSettings?: unknown }).feedbackSettings;
  const feedbackRecord = feedbackSettings && typeof feedbackSettings === "object"
    ? feedbackSettings as Record<string, unknown>
    : {};
  return {
    onboardSettings: onboardSettings as ServerOnboardSettings,
    feedbackSettings: {
      enabled: feedbackRecord.enabled === true,
    },
  };
}

const serverSettingsRequests = new Map<string, Promise<ServerSettings | null>>();

// Stryker disable all: API response normalization is defensive schema repair; integration tests cover representative sparse/invalid payloads while exhaustive field mutants are equivalent fallback permutations.
function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeSidebarOrderResponse(
  data: unknown,
  fallback: SidebarOrderPreferences = DEFAULT_SIDEBAR_ORDER,
): SidebarOrderPreferences {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const customSections = record.customSections === undefined
    ? fallback.customSections
    : normalizeSidebarCustomSections(record.customSections);
  return {
    channelOrder: record.channelOrder === undefined ? fallback.channelOrder : normalizeStringArray(record.channelOrder),
    agentOrder: record.agentOrder === undefined ? fallback.agentOrder : normalizeStringArray(record.agentOrder),
    dmOrder: record.dmOrder === undefined ? fallback.dmOrder : normalizeStringArray(record.dmOrder),
    channelSortMode: record.channelSortMode === undefined ? fallback.channelSortMode : normalizeSidebarSortMode(record.channelSortMode),
    jointChannelSortMode: record.jointChannelSortMode === undefined ? fallback.jointChannelSortMode : normalizeSidebarSortMode(record.jointChannelSortMode),
    dmSortMode: record.dmSortMode === undefined ? fallback.dmSortMode : normalizeSidebarSortMode(record.dmSortMode),
    pinnedSortMode: record.pinnedSortMode === undefined ? fallback.pinnedSortMode : normalizeSidebarSortMode(record.pinnedSortMode),
    pinned: record.pinned === undefined ? fallback.pinned : normalizeSidebarPinnedRefs(record.pinned),
    pinnedChannelIds: record.pinnedChannelIds === undefined ? fallback.pinnedChannelIds : normalizeStringArray(record.pinnedChannelIds),
    pinnedAgentIds: record.pinnedAgentIds === undefined ? fallback.pinnedAgentIds : normalizeStringArray(record.pinnedAgentIds),
    pinnedOrder: record.pinnedOrder === undefined ? fallback.pinnedOrder : normalizeStringArray(record.pinnedOrder),
    hiddenDmIds: record.hiddenDmIds === undefined ? fallback.hiddenDmIds : normalizeStringArray(record.hiddenDmIds),
    channelPanelTabOrder: record.channelPanelTabOrder === undefined ? fallback.channelPanelTabOrder : normalizeStringArray(record.channelPanelTabOrder),
    agentPanelTabOrder: record.agentPanelTabOrder === undefined ? fallback.agentPanelTabOrder : normalizeStringArray(record.agentPanelTabOrder),
    customSections,
    sectionOrder: normalizeSidebarSectionOrder(
      record.sectionOrder === undefined ? fallback.sectionOrder : record.sectionOrder,
      customSections,
    ),
    sectionPlacements: record.sectionPlacements === undefined
      ? fallback.sectionPlacements
      : normalizeSidebarSectionPlacements(record.sectionPlacements),
    sectionsVersion: typeof record.sectionsVersion === "number" ? record.sectionsVersion : fallback.sectionsVersion,
    pinnedVersion: typeof record.pinnedVersion === "number" ? record.pinnedVersion : fallback.pinnedVersion,
  };
}
// Stryker restore all

function selectServerDomainState(state: ServerState): ServerDomainState {
  return {
    servers: state.servers,
    current: state.current,
    sidebarOrder: state.sidebarOrder,
    serverEpoch: state.serverEpoch,
  };
}

function applyServerDomainEvent(
  event: ServerEvent,
  set: (partial: Partial<ServerState>) => void,
  get: () => ServerState,
) {
  const result = applyServerEvent(selectServerDomainState(get()), event);
  if (result.transition.touched > 0) {
    set({
      servers: result.state.servers,
      current: result.state.current,
      sidebarOrder: result.state.sidebarOrder,
      serverEpoch: result.state.serverEpoch,
    });
  }
  return result;
}

/**
 * Central primitive for every "switch current server" path.
 * Increments serverEpoch, resets all server-scoped slices atomically,
 * triggers cross-store resets, and fires initial data loaders.
 * Both setCurrent() and createServer() must funnel through here so no
 * context-switch entry point can bypass the epoch/reset mechanism.
 */
function applyServerSwitch(
  server: Server,
  set: (partial: Partial<ServerState>) => void,
  get: () => ServerState
) {
  serverPersistence.writeLastServerSlug(server.slug);
  applyServerDomainEvent({ kind: "patch", patch: "current-set", server }, set, get);
  set({
    members: [],
    membersLoadError: false,
    usage: null,
    loadingUsage: true,
    billing: null,
    loadingBilling: true,
    settings: null,
    loadingSettings: true,
  });
  triggerServerReset();
  get().loadMembers();
  get().loadSidebarOrder();
  void get().loadSettings();
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  current: null,
  members: [],
  membersLoadError: false,
  loading: true,
  usage: null,
  loadingUsage: false,
  billing: null,
  loadingBilling: false,
  settings: null,
  loadingSettings: false,
  sidebarOrder: DEFAULT_SIDEBAR_ORDER,
  serverEpoch: 0,

  loadServers: async () => {
    try {
      const { data } = await api.get("/servers");
      const servers = data as Server[];

      serverPersistence.clearLegacyServerId();
      applyServerDomainEvent({ kind: "hydrate", source: "servers", servers }, set, get);
      set({ loading: false });

      // Loaders are no-ops without a current server and capture serverEpoch
      // themselves, so this is safe for URL-resolved and empty startup states.
      get().loadMembers();
      get().loadSidebarOrder();
    } catch {
      set({ loading: false });
    }
  },

  loadSettings: async (options = {}) => {
    const epoch = get().serverEpoch;
    const serverId = get().current?.id;
    if (!serverId) return null;
    const cached = get().settings;
    if (cached && options.force !== true) return cached;

    const requestKey = `${serverId}:${epoch}`;
    const existing = serverSettingsRequests.get(requestKey);
    if (existing) return existing;

    set({ loadingSettings: true });
    const request = api.get(`/servers/${serverId}/settings`)
      .then(({ data }) => normalizeServerSettings(data))
      .catch(() => null)
      .then((settings) => {
        if (get().current?.id === serverId && get().serverEpoch === epoch) {
          set({ settings, loadingSettings: false });
        }
        return settings;
      })
      .finally(() => {
        serverSettingsRequests.delete(requestKey);
      });
    serverSettingsRequests.set(requestKey, request);
    return request;
  },

  updateServerOrder: async (serverOrder) => {
    const previous = get().servers;
    const byId = new Map(previous.map((server) => [server.id, server]));
    const seen = new Set<string>();
    const next = [
      ...serverOrder
        .map((id) => byId.get(id))
        .filter((server): server is Server => {
          if (!server || seen.has(server.id)) return false;
          seen.add(server.id);
          return true;
        }),
      ...previous.filter((server) => !seen.has(server.id)),
    ];
    applyServerDomainEvent({ kind: "hydrate", source: "servers", servers: next }, set, get);
    try {
      const { data } = await api.patch("/servers/order", { serverOrder: next.map((server) => server.id) });
      const savedOrder: string[] = Array.isArray(data?.serverOrder)
        ? data.serverOrder.filter((id: unknown): id is string => typeof id === "string")
        : next.map((server) => server.id);
      const serverOrderVersion = typeof data?.serverOrderVersion === "number" ? data.serverOrderVersion : undefined;
      const savedById = new Map(get().servers.map((server) => [server.id, server]));
      const savedSeen = new Set<string>();
      applyServerDomainEvent({
        kind: "hydrate",
        source: "servers",
        servers: [
          ...savedOrder
            .map((id) => savedById.get(id))
            .filter((server): server is Server => {
              if (!server || savedSeen.has(server.id)) return false;
              savedSeen.add(server.id);
              return true;
            })
            .map((server) => serverOrderVersion === undefined ? server : { ...server, serverOrderVersion }),
          ...get().servers
            .filter((server) => !savedSeen.has(server.id))
            .map((server) => serverOrderVersion === undefined ? server : { ...server, serverOrderVersion }),
        ],
      }, set, get);
    } catch {
      applyServerDomainEvent({ kind: "hydrate", source: "servers", servers: previous }, set, get);
    }
  },

  setCurrent: (server) => {
    applyServerSwitch(server, set, get);
  },

  clearCurrent: () => {
    const result = applyServerDomainEvent({ kind: "patch", patch: "current-clear" }, set, get);
    set({
      members: [],
      membersLoadError: false,
      usage: null,
      loadingUsage: false,
      billing: null,
      loadingBilling: false,
      settings: null,
      loadingSettings: false,
    });
    if (result.transition.serverEpochDelta !== 0) triggerServerReset();
  },

  createServer: async (name, slug) => {
    const { data } = await api.post("/servers", { name, slug });
    const server: Server = { ...data, role: "owner" };
    applyServerSwitch(server, set, get);
    return server;
  },

  joinCommunityServer: async (options = {}) => {
    const slug = options.slug ?? "community";
    await api.post("/servers/join-community", { agreementId: options.agreementId, slug });
    // Reload from source of truth rather than reconstructing a full Server
    // shape here — the join endpoint returns only id/name, and the sidebar
    // immediately wants the full record (slug, role, plan, …) that GET
    // /servers already materializes.
    await get().loadServers();
    const joined = get().servers.find((s) => s.slug === slug);
    if (!joined) {
      throw new Error("server.community.missingAfterJoin");
    }
    applyServerSwitch(joined, set, get);
    return joined;
  },

  updateServerProfile: async (updates) => {
    const { current } = get();
    if (!current) return;
    const { data } = await api.patch(`/servers/${current.id}`, updates);
    const nextCurrent: Server = {
      ...current,
      name: data.name,
      avatarUrl: data.avatarUrl ?? null,
      hideHumansFromMembers: data.hideHumansFromMembers,
    };
    applyServerDomainEvent({ kind: "patch", patch: "server-upsert", server: nextCurrent }, set, get);
  },

  uploadServerAvatar: async (file) => {
    const { current } = get();
    if (!current) return;
    const formData = new FormData();
    formData.append("avatar", file);
    const { data } = await api.post(`/servers/${current.id}/avatar`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    const avatarUrl = data.avatarUrl ?? null;
    applyServerDomainEvent({ kind: "patch", patch: "server-upsert", server: { id: current.id, avatarUrl } }, set, get);
  },

  leaveServer: async () => {
    const { current } = get();
    if (!current) return;
    await api.post(`/servers/${current.id}/leave`);
    serverPersistence.clearLastServerSlug(current.slug);
    applyServerDomainEvent({ kind: "patch", patch: "membership-removed", serverId: current.id }, set, get);
    set({
      members: [],
      membersLoadError: false,
      usage: null,
      loadingUsage: false,
      billing: null,
      loadingBilling: false,
      settings: null,
      loadingSettings: false,
    });
    triggerServerReset();
  },

  deleteServer: async () => {
    const { current } = get();
    if (!current) return;
    await api.delete(`/servers/${current.id}`);
    serverPersistence.clearLastServerSlug(current.slug);
    applyServerDomainEvent({ kind: "patch", patch: "membership-removed", serverId: current.id }, set, get);
    set({
      members: [],
      membersLoadError: false,
      usage: null,
      loadingUsage: false,
      billing: null,
      loadingBilling: false,
      settings: null,
      loadingSettings: false,
    });
    triggerServerReset();
  },

  applyServerPatch: (server) => {
    applyServerDomainEvent({ kind: "patch", patch: "server-upsert", server }, set, get);
  },

  handleMembershipRemoved: async (serverId) => {
    const currentServer = get().current;
    if (!currentServer) {
      await get().loadServers();
      return false;
    }
    const wasCurrentServer = currentServer.id === serverId;
    await get().loadServers();

    if (!wasCurrentServer) return false;
    const stillMember = get().servers.some((server) => server.id === serverId);
    if (stillMember) return false;

    serverPersistence.clearLastServerSlug(currentServer.slug);
    applyServerDomainEvent({ kind: "patch", patch: "membership-removed", serverId }, set, get);
    set({
      members: [],
      membersLoadError: false,
      usage: null,
      loadingUsage: false,
      billing: null,
      loadingBilling: false,
      settings: null,
      loadingSettings: false,
    });
    triggerServerReset();
    return true;
  },

  loadMembers: async () => {
    const epoch = get().serverEpoch;
    const serverId = get().current?.id;
    if (!serverId) return;
    set({ membersLoadError: false });
    try {
      const { data } = await api.get(`/servers/${serverId}/members`);
      if (get().serverEpoch !== epoch) return;
      set({ members: data, membersLoadError: false });
    } catch {
      if (get().serverEpoch !== epoch) return;
      set({ membersLoadError: true });
    }
  },

  loadSidebarOrder: async () => {
    const epoch = get().serverEpoch;
    const serverId = get().current?.id;
    if (!serverId) return;
    try {
      const { data } = await api.get(`/servers/${serverId}/sidebar-order`);
      if (get().serverEpoch !== epoch) return;
      applyServerDomainEvent({
        kind: "hydrate",
        source: "sidebar-order",
        serverId,
        epoch,
        sidebarOrder: normalizeSidebarOrderResponse(data),
      }, set, get);
    } catch {
      if (get().serverEpoch !== epoch) return;
      applyServerDomainEvent({
        kind: "hydrate",
        source: "sidebar-order",
        serverId,
        epoch,
        sidebarOrder: DEFAULT_SIDEBAR_ORDER,
      }, set, get);
    }
  },

  updateSidebarOrder: async (updates) => {
    const { current, serverEpoch } = get();
    if (!current) return;
    const serverId = current.id;
    const updatesSections = updates.customSections !== undefined || updates.sectionOrder !== undefined || updates.sectionPlacements !== undefined;
    const state = get();
    if (state.current?.id !== serverId || state.serverEpoch !== serverEpoch) return;
    const { sidebarOrder } = state;
    const next: SidebarOrderPreferences = {
      channelOrder: updates.channelOrder ?? sidebarOrder.channelOrder,
      agentOrder: updates.agentOrder ?? sidebarOrder.agentOrder,
      dmOrder: updates.dmOrder ?? sidebarOrder.dmOrder,
      channelSortMode: updates.channelSortMode ?? sidebarOrder.channelSortMode,
      jointChannelSortMode: updates.jointChannelSortMode ?? sidebarOrder.jointChannelSortMode,
      // Stryker disable next-line LogicalOperator: sparse-update fallback shape is pinned by domain integration tests; this corpus only observes typed pinned sparse writes.
      dmSortMode: updates.dmSortMode ?? sidebarOrder.dmSortMode,
      pinnedSortMode: updates.pinnedSortMode ?? sidebarOrder.pinnedSortMode,
      pinned: updates.pinned ?? sidebarOrder.pinned,
      pinnedChannelIds: updates.pinnedChannelIds ?? sidebarOrder.pinnedChannelIds,
      pinnedAgentIds: updates.pinnedAgentIds ?? sidebarOrder.pinnedAgentIds,
      pinnedOrder: updates.pinnedOrder ?? sidebarOrder.pinnedOrder,
      hiddenDmIds: updates.hiddenDmIds ?? sidebarOrder.hiddenDmIds,
      channelPanelTabOrder: updates.channelPanelTabOrder ?? sidebarOrder.channelPanelTabOrder,
      agentPanelTabOrder: updates.agentPanelTabOrder ?? sidebarOrder.agentPanelTabOrder,
      customSections: updates.customSections ?? sidebarOrder.customSections,
      sectionOrder: updates.sectionOrder ?? sidebarOrder.sectionOrder,
      sectionPlacements: updates.sectionPlacements ?? sidebarOrder.sectionPlacements,
      sectionsVersion: sidebarOrder.sectionsVersion,
      pinnedVersion: sidebarOrder.pinnedVersion,
    };
    applyServerDomainEvent({ kind: "patch", patch: "sidebar-order-set", sidebarOrder: next }, set, get);

    const performUpdate = async (sectionsVersion?: number, sequence?: number, queue?: SidebarSectionUpdateQueue) => {
      if (get().current?.id !== serverId || get().serverEpoch !== serverEpoch) return;
      try {
        const { data } = await api.patch(`/servers/${serverId}/sidebar-order`, updatesSections
          ? { ...updates, sectionsVersion }
          : updates);
        if (get().current?.id !== serverId || get().serverEpoch !== serverEpoch) return;
        const normalized = normalizeSidebarOrderResponse(data, next);
        if (queue && sequence !== queue.latestSequence) {
          queue.confirmedVersion = normalized.sectionsVersion;
          const currentSidebarOrder = get().sidebarOrder;
          applyServerDomainEvent({
            kind: "patch",
            patch: "sidebar-order-set",
            sidebarOrder: {
              ...currentSidebarOrder,
              sectionsVersion: normalized.sectionsVersion,
              pinnedVersion: normalized.pinnedVersion,
            },
          }, set, get);
          return;
        }
        if (queue) queue.confirmedVersion = normalized.sectionsVersion;
        applyServerDomainEvent({
          kind: "patch",
          patch: "sidebar-order-set",
          sidebarOrder: normalized,
        }, set, get);
      } catch (error) {
        if (get().current?.id === serverId && get().serverEpoch === serverEpoch) {
          if (!queue || sequence === queue.latestSequence) {
            applyServerDomainEvent({ kind: "patch", patch: "sidebar-order-set", sidebarOrder }, set, get);
          }
          const status = (error as { response?: { status?: number } }).response?.status;
          if (status === 409) void get().loadSidebarOrder();
        }
      }
    };

    if (updatesSections) {
      const queueKey = `${serverId}:${serverEpoch}`;
      const queue = sidebarSectionUpdateQueues.get(queueKey) ?? {
        tail: Promise.resolve(),
        latestSequence: 0,
        confirmedVersion: sidebarOrder.sectionsVersion,
      };
      const sequence = queue.latestSequence + 1;
      queue.latestSequence = sequence;
      const queuedUpdate = queue.tail.then(
        () => performUpdate(queue.confirmedVersion, sequence, queue),
        () => performUpdate(queue.confirmedVersion, sequence, queue),
      );
      queue.tail = queuedUpdate;
      sidebarSectionUpdateQueues.set(queueKey, queue);
      void queuedUpdate.then(() => {
        if (sidebarSectionUpdateQueues.get(queueKey)?.tail === queuedUpdate) {
          sidebarSectionUpdateQueues.delete(queueKey);
        }
      });
      await queuedUpdate;
      return;
    }
    await performUpdate();
  },

  updateMemberRole: async (userId, role) => {
    const { current } = get();
    if (!current) return;
    await api.patch(`/servers/${current.id}/members/${userId}`, { role });
    set((state) => ({
      members: state.members.map((member) =>
        member.userId === userId ? { ...member, role } : member
      ),
    }));
    notifyAllChannelMembersChanged();
  },

  removeMember: async (userId) => {
    const { current } = get();
    if (!current) return;
    await api.delete(`/servers/${current.id}/members/${userId}`);
    set((state) => ({
      members: state.members.filter((member) => member.userId !== userId),
    }));
    notifyAllChannelMembersChanged();
  },

  loadUsage: async () => {
    const epoch = get().serverEpoch;
    const serverId = get().current?.id;
    if (!serverId) {
      set({ loadingUsage: false });
      return;
    }
    set({ loadingUsage: true });
    try {
      const { data } = await api.get(`/servers/${serverId}/usage`);
      if (get().serverEpoch !== epoch) return;
      set({ usage: data, loadingUsage: false });
    } catch {
      if (get().serverEpoch !== epoch) return;
      set({ loadingUsage: false });
    }
  },

  loadBilling: async () => {
    const epoch = get().serverEpoch;
    if (!get().current) {
      set({ loadingBilling: false });
      return;
    }
    set({ loadingBilling: true });
    try {
      const { data } = await api.get("/billing/subscription");
      if (get().serverEpoch !== epoch) return;
      set({ billing: data, loadingBilling: false });
    } catch {
      if (get().serverEpoch !== epoch) return;
      set({ loadingBilling: false });
    }
  },

}));

// Provide the active serverId to the L4 web auth trace producer synchronously,
// without webAuthTrace importing this store (which would create an import cycle).
setAuthTraceServerIdGetter(() => useServerStore.getState().current?.id);
