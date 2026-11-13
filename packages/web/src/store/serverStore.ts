import { create } from "zustand";
import api from "../api/client";
import { getRwRead } from "../api/overloadRetry";
import { saveLastCounts } from "./lastCounts";
import { getCurrentPrincipalId } from "./principalRuntime";
import { parseChannelSideLayout } from "@botiverse/raft-shared";
import type { ChannelSideLayout, GuestChannelField, RaftThemeId, ServerRole } from "@botiverse/raft-shared";
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
import { currentActorScope, humanActorRow, registerLocalActorLookup, upsertActorsIfCurrent } from "./localTables/actorResolve";
import { setAuthTraceServerIdGetter } from "../utils/webAuthTrace";
import { setProductEventServerIdGetter } from "../analytics/track";
import { normalizeSidebarPinnedRefs } from "../utils/sidebarPinnedRefs";
import type { SidebarPinnedRef } from "../utils/sidebarPinnedRefs";
import { notifyAllChannelMembersChanged } from "./channelMemberEvents";
import { installServerThemeSync } from "../theme/serverTheme";
import { hasChatSurfaces } from "../embed";
import { markBootMilestone } from "../boot/bootTiming";
import { isAccessTokenExpired } from "../utils/hostAccessTokenSync";
import {
  parseServerUnreadSummaryRows,
  retainServerUnreadSummary,
} from "../utils/serverUnreadSummary";
import type { ServerUnreadSummary } from "../utils/serverUnreadSummary";
import {
  normalizeSidebarCustomSections,
  normalizeSidebarSectionOrder,
  normalizeSidebarSectionPlacements,
} from "./sidebarSections";
import type { SidebarCustomSection, SidebarSectionPlacement } from "./sidebarSections";
import { localTableSession, writeServerList } from "./localTables/storeWriters";

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
  /** The member's own theme here (null = Raft Yellow); from GET /servers. */
  theme?: RaftThemeId | null;
  /** The member shows the theme's pixel art on the frame; from GET /servers. */
  themeDecor?: boolean;
  notificationPrefsVersion?: number;
  serverOrderVersion?: number;
  /** The server's public page is live (public and rolled out); from GET /servers. */
  publicPageLive?: boolean;
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

export interface ServerMember extends GuestChannelField {
  userId: string;
  serverId?: string;
  serverName?: string | null;
  serverSlug?: string | null;
  /** A channel roster's person only (rosterHumanAsMember): every server they
   *  take part through, and the roster's "is one of the viewed server's". */
  roster?: {
    serverId?: string | null;
    serverName?: string | null;
    serverSlug?: string | null;
    servers?: Array<{ id: string; name: string; slug: string }> | null;
    inViewerServer?: boolean;
  };
  email: string | null;
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
  /** Where Thread, Tasks and Files stand right of a channel (task #165); null when this member never saved one. */
  channelSideLayout: ChannelSideLayout | null;
  customSections: SidebarCustomSection[];
  sectionOrder: string[];
  sectionPlacements: SidebarSectionPlacement[];
  sectionsVersion: number;
  pinnedVersion: number;
}

export type { BillingInfo, SubscriptionInfo } from "./billingInfo";
import type { BillingInfo } from "./billingInfo";

/**
 * Boot: the server list asked for alongside the signed-in check rather than
 * after it (they don't depend on each other on the wire). Held, not applied:
 * loadServers takes it when the app's own gate lets it run (a signed-in,
 * verified, set-up account), and only for the token it was asked with. A
 * failure (401, 403 for an unverified account) applies nothing; loadServers
 * then asks itself, as before.
 */
// `_retry` is read by the API client's response interceptor (client.ts).
const EARLY_REQUEST_CONFIG = { _retry: true } as Parameters<typeof api.get>[1];

let earlyServerList: { token: string; servers: Promise<Server[]> } | null = null;

export function requestServerListEarly(): void {
  if (earlyServerList) return;
  let token: string | null = null;
  try {
    token = localStorage.getItem("slock_access_token");
  } catch {
    return;
  }
  if (!token || isAccessTokenExpired(token, Date.now())) return;
  // `_retry`: a 401 here neither refreshes nor signs out; the app's own requests decide that.
  const servers = api.get("/servers", EARLY_REQUEST_CONFIG).then(({ data }) => data as Server[]);
  servers.catch(() => {});
  earlyServerList = { token, servers };
}

function takeEarlyServerList(): Promise<Server[]> | null {
  const early = earlyServerList;
  earlyServerList = null;
  if (!early) return null;
  try {
    return early.token === localStorage.getItem("slock_access_token") ? early.servers : null;
  } catch {
    return null;
  }
}

/**
 * Coalesces concurrent async loaders by key: a second call while a first is
 * still in flight awaits the same promise instead of issuing a duplicate
 * request. Keyed per logical resource (and cleared on completion), so a later
 * genuine refresh still fetches.
 */
const inFlightLoaders = new Map<string, Promise<void>>();
export function coalesce(key: string, run: () => Promise<void>): Promise<void> {
  const existing = inFlightLoaders.get(key);
  if (existing) return existing;
  const promise = run().finally(() => {
    if (inFlightLoaders.get(key) === promise) inFlightLoaders.delete(key);
  });
  inFlightLoaders.set(key, promise);
  return promise;
}

/**
 * When each boot list last loaded successfully, by its coalesce key. The
 * connect / first-join reloads skip a list loaded moments ago by the boot
 * path (same request, same answer); reconnects and events always read again.
 */
const freshLoads = new Map<string, number>();
/** The keys both sides use (the loaders mark, socketBridge checks). */
export const bootListKey = {
  servers: "servers:list",
  sidebarOrder: (serverId: string, epoch: number) => `sidebar-order:${serverId}:${epoch}`,
  channels: (serverId: string, epoch: number) => `channels:${serverId}:${epoch}`,
};
export function noteFreshLoad(key: string): void {
  freshLoads.set(key, Date.now());
}
export function loadedWithin(key: string, ms: number): boolean {
  const at = freshLoads.get(key);
  return at !== undefined && Date.now() - at <= ms;
}

/**
 * Let the coalesced load under `key` land, if one is in flight. A reload that
 * must reflect something learnt now (sync/changes) waits for it and then
 * issues its own request, instead of joining one sent earlier.
 */
export async function settleInFlightLoader(key: string): Promise<void> {
  await inFlightLoaders.get(key)?.catch(() => undefined);
}

/**
 * Drop every in-flight coalescing window.
 *
 * `inFlightLoaders` lives in this module rather than in store state, so it is
 * invisible to `useServerStore.setState(reset)` and survives between tests. A
 * test that stubs `api` with a promise that never settles therefore strands the
 * window for every later test in the same file, which then silently reads the
 * earlier request instead of issuing its own. Tests that stub `api` must call
 * this in their setup so each case starts with no inherited window.
 *
 * Test-only seam: production has no caller, and clearing the map cannot change
 * behaviour for a real page, where a settled window is already deleted by the
 * `finally` above.
 */
export function resetInFlightLoadersForTest(): void {
  inFlightLoaders.clear();
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
   * Cross-server unread summary, owned here (single source of truth) so exactly
   * one loader fetches `/servers/unread-summary` and every consumer reads the
   * same snapshot — previously LeftRail and Sidebar each fetched and kept their
   * own copy, which produced duplicate requests per mount.
   */
  serverUnreadCounts: Record<string, ServerUnreadSummary>;
  /**
   * Monotonic counter incremented on every setCurrent() call.
   * All server-scoped async loaders capture this epoch before their await
   * and discard the response if the epoch changed by the time it arrives.
   * This correctly handles A→B→A rapid switching (unlike a plain serverId
   * comparison, which would let a stale response from the first A visit pass).
   */
  serverEpoch: number;

  /** `fresh` skips joining a read already in flight, whose response may
   * predate the change the caller is reacting to. */
  /**
   * `listOnly`: refresh the server list without the members / sidebar-order
   * reads it otherwise triggers (sync/changes delivers those on their own).
   */
  loadServers: (options?: { fresh?: boolean; listOnly?: boolean }) => Promise<void>;
  loadSettings: (options?: { force?: boolean }) => Promise<ServerSettings | null>;
  updateServerOrder: (serverOrder: string[]) => Promise<void>;
  setCurrent: (server: Server) => void;
  /** At boot, the link's server from the list kept on the device, before GET /servers (boot/openServerFromDevice). */
  setCurrentFromDevice: (server: Server) => boolean;
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
  loadServerUnreadSummary: (options?: { force?: boolean }) => Promise<void>;
  loadSidebarOrder: () => Promise<void>;
  updateSidebarOrder: (updates: Partial<SidebarOrderPreferences>) => Promise<void>;
  /**
   * The current user replied in a DM they had closed: the server already took
   * it off their hidden list (task #59), so only the local copy changes.
   */
  reopenDmAfterOwnReply: (dmId: string) => void;
  /**
   * Stores `role` for `userId` on `options.serverId` (default: the current
   * server). With `options.onlyIfRole`, the role is changed only while it is
   * still that one: Undo must not overwrite a change made since. Resolves to
   * `"changed"` when it was not that role any more, `"skipped"` without a server.
   */
  updateMemberRole: (
    userId: string,
    role: ServerRole,
    options?: { serverId?: string; onlyIfRole?: ServerRole },
  ) => Promise<"updated" | "changed" | "skipped">;
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
    channelSideLayout: record.channelSideLayout === undefined ? fallback.channelSideLayout : parseChannelSideLayout(record.channelSideLayout),
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
  if (hasChatSurfaces()) get().loadSidebarOrder();
  void get().loadSettings();
}

/** The current server is not one of this person's any more: no current server, nothing of it kept. */
function dropCurrentServer(
  server: Server,
  set: (partial: Partial<ServerState>) => void,
  get: () => ServerState,
) {
  serverPersistence.clearLastServerSlug(server.slug);
  applyServerDomainEvent({ kind: "patch", patch: "membership-removed", serverId: server.id }, set, get);
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
}

// The server a link opens, taken from the server list kept on the device
// (store/localTables) before GET /servers answers, so its conversation loads
// in the same round trip as the list (docs/frontend/boot-requests.md). Until
// the list confirms it, it is only shown: nothing is written to the server on
// its behalf (Tenny, #triage:458d78f1), so reads wait (messageStore).
let unconfirmedCurrentId: string | null = null;
const confirmedListeners = new Set<() => void>();

/** Whether the current server came from the network's list (always, except in the first moments of a boot from the device). */
export function isCurrentServerConfirmed(): boolean {
  // Sign-out or another switch replaced it: whatever is current now came from the network.
  return unconfirmedCurrentId === null || useServerStore.getState().current?.id !== unconfirmedCurrentId;
}

/** Called once the device's current server is confirmed by GET /servers. */
export function onCurrentServerConfirmed(listener: () => void): () => void {
  confirmedListeners.add(listener);
  return () => confirmedListeners.delete(listener);
}

/**
 * GET /servers answered while the current server came from the device: it is
 * confirmed, or it was not in the list (removed meanwhile) and is dropped as
 * a removal is. Returns whether it was confirmed.
 */
function settleDeviceServer(
  set: (partial: Partial<ServerState>) => void,
  get: () => ServerState,
): boolean {
  const id = unconfirmedCurrentId;
  unconfirmedCurrentId = null;
  const current = get().current;
  if (!id || current?.id !== id) return false;
  if (!get().servers.some((server) => server.id === id)) {
    dropCurrentServer(current, set, get);
    return false;
  }
  for (const listener of [...confirmedListeners]) listener();
  return true;
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
  serverUnreadCounts: {},
  serverEpoch: 0,

  loadServers: async (options = {}) => {
    // Boot-time fan-in: layout bootstrap, server-list refreshers and other
    // stores can all trigger this within the same window; coalesce concurrent
    // calls onto one request (later genuine refreshes still fetch).
    if (options.fresh) await inFlightLoaders.get("servers:list")?.catch(() => undefined);
    const early = options.fresh ? null : takeEarlyServerList();
    return coalesce("servers:list", async () => {
      const session = localTableSession();
      try {
        const servers = await (early ?? Promise.reject(new Error("no early list")))
          .catch(async () => (await api.get("/servers")).data as Server[]);

        serverPersistence.clearLegacyServerId();
        applyServerDomainEvent({ kind: "hydrate", source: "servers", servers }, set, get);
        const fromDevice = unconfirmedCurrentId !== null;
        const confirmed = fromDevice && settleDeviceServer(set, get);
        set({ loading: false });
        writeServerList(session, get().servers);
        noteFreshLoad(bootListKey.servers);
        markBootMilestone("servers");

        // Loaders are no-ops without a current server and capture serverEpoch
        // themselves, so this is safe for URL-resolved and empty startup states.
        // A server taken from the device loaded them when it became current.
        if (!confirmed && !options.listOnly) {
          get().loadMembers();
          if (hasChatSurfaces()) get().loadSidebarOrder();
        }
      } catch {
        // A server opened from the device stays only with the network's word:
        // without it the boot ends as it did before, with no current server.
        if (unconfirmedCurrentId !== null && get().current?.id === unconfirmedCurrentId) get().clearCurrent();
        unconfirmedCurrentId = null;
        set({ loading: false });
      }
    });
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
    unconfirmedCurrentId = null;
    applyServerSwitch(server, set, get);
  },

  setCurrentFromDevice: (server) => {
    // Only before the network's list and any other choice of server.
    if (!get().loading || get().current) return false;
    applyServerSwitch(server, set, get);
    unconfirmedCurrentId = server.id;
    return true;
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
    // A read that started before the removal committed can still be in flight
    // and would report the server as present, leaving the user on it.
    await get().loadServers({ fresh: true });

    if (!wasCurrentServer) return false;
    // The user may have switched away while the list was loading; resetting
    // now would tear down the server they moved to.
    if (get().current?.id !== serverId) return false;
    const stillMember = get().servers.some((server) => server.id === serverId);
    if (stillMember) return false;

    dropCurrentServer(currentServer, set, get);
    return true;
  },

  loadMembers: async () => {
    const serverId = get().current?.id;
    if (!serverId) return;
    await coalesce(`members:${serverId}`, async () => {
      const epoch = get().serverEpoch;
      const actorScope = currentActorScope();
      set({ membersLoadError: false });
      try {
        const { data } = await api.get(`/servers/${serverId}/members`);
        if (get().serverEpoch !== epoch) return;
        set({ members: data, membersLoadError: false });
        // Upsert, not a full replace: a hidden directory answers with part of
        // the server, and the table also holds joint channels' other people.
        if (actorScope && Array.isArray(data)) {
          upsertActorsIfCurrent(actorScope, (data as ServerMember[]).map((member) => humanActorRow(member.userId, member, serverId)));
        }
      } catch {
        if (get().serverEpoch !== epoch) return;
        set({ membersLoadError: true });
      }
    });
  },

  loadSidebarOrder: async () => {
    const serverId = get().current?.id;
    if (!serverId) return;
    // The epoch is in the key (as dm-channels): after A → B → A a call for the
    // new A must not join A's first request, which returns without hydrating.
    const epoch = get().serverEpoch;
    await coalesce(bootListKey.sidebarOrder(serverId, epoch), async () => {
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
        noteFreshLoad(bootListKey.sidebarOrder(serverId, epoch));
      } catch {
        if (get().serverEpoch !== epoch) return;
        applyServerDomainEvent({
          kind: "hydrate",
          source: "sidebar-order",
          serverId,
          epoch,
          // A copy: read (and failed), unlike the reset value (isSidebarOrderLoaded).
          sidebarOrder: { ...DEFAULT_SIDEBAR_ORDER },
        }, set, get);
      }
    });
  },

  loadServerUnreadSummary: async (_options = {}) => {
    // The cross-server unread badge lives on the rail, which an embed never shows.
    if (!hasChatSurfaces()) return;
    const { servers } = get();
    if (servers.length === 0) {
      set({ serverUnreadCounts: {} });
      return;
    }
    await coalesce("server-unread-summary", async () => {
      const epoch = get().serverEpoch;
      try {
        const { data, stale } = await getRwRead("summary", "/servers/unread-summary");
        if (get().serverEpoch !== epoch) return;
        const next = parseServerUnreadSummaryRows(data);
        set((prev) => ({
          serverUnreadCounts: retainServerUnreadSummary(prev.serverUnreadCounts, next),
        }));
        // Task #164: the last clean summary is what a later boot shows while RW is unavailable.
        if (!stale) saveLastCounts(getCurrentPrincipalId(), get().current?.id, { summary: get().serverUnreadCounts });
      } catch {
        // best-effort cross-server badges; keep the previous snapshot on failure
      }
    });
  },

  reopenDmAfterOwnReply: (dmId) => {
    const { sidebarOrder } = get();
    if (!sidebarOrder.hiddenDmIds.includes(dmId)) return;
    applyServerDomainEvent({
      kind: "patch",
      patch: "sidebar-order-set",
      sidebarOrder: { ...sidebarOrder, hiddenDmIds: sidebarOrder.hiddenDmIds.filter((id) => id !== dmId) },
    }, set, get);
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
      channelSideLayout: updates.channelSideLayout !== undefined ? updates.channelSideLayout : sidebarOrder.channelSideLayout,
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

  updateMemberRole: async (userId, role, options) => {
    const serverId = options?.serverId ?? get().current?.id;
    if (!serverId) return "skipped";
    const onCurrentServer = () => get().current?.id === serverId;
    if (options?.onlyIfRole) {
      // The current server's member list is live; another server's is asked for.
      const storedRole = onCurrentServer()
        ? get().members.find((member) => member.userId === userId)?.role
        : ((await api.get(`/servers/${serverId}/members`)).data as ServerMember[])
          .find((member) => member.userId === userId)?.role;
      if (storedRole !== options.onlyIfRole) return "changed";
    }
    await api.patch(`/servers/${serverId}/members/${userId}`, { role });
    if (!onCurrentServer()) return "updated";
    set((state) => ({
      members: state.members.map((member) =>
        member.userId === userId ? { ...member, role } : member
      ),
    }));
    notifyAllChannelMembersChanged();
    return "updated";
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
    const serverId = get().current?.id;
    if (!serverId) {
      set({ loadingBilling: false });
      return;
    }
    // ChatPanel, the socket bridge and settings surfaces all ask for billing
    // on the same boot/server switch (x2-3 concurrent on staging); share one.
    await coalesce(`billing:${serverId}:${epoch}`, async () => {
      set({ loadingBilling: true });
      try {
        const { data } = await api.get("/billing/subscription");
        if (get().serverEpoch !== epoch) return;
        set({ billing: data, loadingBilling: false });
      } catch {
        if (get().serverEpoch !== epoch) return;
        set({ loadingBilling: false });
      }
    });
  },

}));

// Provide the active serverId to the L4 web auth trace producer synchronously,
// without webAuthTrace importing this store (which would create an import cycle).
setAuthTraceServerIdGetter(() => useServerStore.getState().current?.id);
registerLocalActorLookup((ref) => ref.kind === "human" && useServerStore.getState().members.some((member) => member.userId === ref.id));
setProductEventServerIdGetter(() => useServerStore.getState().current?.id);
// <html> wears the current server's theme (data-theme), applied in the same
// update that makes a server current so no frame shows the previous one's.
installServerThemeSync(useServerStore);
