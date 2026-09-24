import { create } from "zustand";
import api from "../api/client";
import { isExternalAgentRuntime, normalizeActivity, normalizeActivityDetailKind } from "@botiverse/raft-shared";
import type { AgentActivity, AgentActivityDetailKind, AgentRuntimeErrorState, AgentStatus, ReasoningEffort, RuntimeConfig, RuntimeFormDefinitionRef, ServerRole, TrajectoryEntry } from "@botiverse/raft-shared";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import { en } from "../i18n/messages/en";
import { getActivityText } from "../utils/activity";
import { traceAgentActivityStoreDecision } from "../utils/webAgentActivityTrace";
import type { AgentActivityTraceJoin } from "../utils/webAgentActivityTrace";
import { emitStateViolationTrace } from "../utils/stateViolationTrace";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import {
  applyAgentActivityEvent,
  makeActivityState,
} from "./events/agentActivityEvents";
import type {
  ActivityLogEntry,
  AgentActivityDomainState,
  AgentActivityJoinKeys,
  AgentActivityState,
  AgentActivityTransition,
  TrajectoryLogEntry,
} from "./events/agentActivityEvents";
import { notifyAllChannelMembersChanged } from "./channelMemberEvents";

// Re-export for consumers that previously imported from this file
export type { AgentActivity } from "@botiverse/raft-shared";
export type { TrajectoryEntry } from "@botiverse/raft-shared";

export interface Agent {
  id: string;
  serverId?: string;
  serverName?: string | null;
  serverSlug?: string | null;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  description: string | null;
  status: AgentStatus;
  model: string;
  runtime: string;
  external?: boolean;
  serverRole: ServerRole | null;
  runtimeConfig?: RuntimeConfig | null;
  lastRuntimeError?: AgentRuntimeErrorState | null;
  reasoningEffort: ReasoningEffort | null;
  executionMode: "byoc" | "cloud";
  envVars: Record<string, string> | null;
  machineId: string | null;
  sessionId?: string | null;
  runtimeProfile?: AgentRuntimeProfileSummary | null;
  creatorType: "user" | "agent" | null;
  creatorId: string | null;
  creator: CreatorSummary | null;
  createdAgents: AgentCreatedSummary[];
  deletedAt: string | null;
  createdAt: string;
  /** Bounded public profile carried by a readable channel relation. */
  profileProjection?: "channel_summary";
}

export type OnboardingIdentityField = "name" | "displayName" | "role" | "serverRole" | "avatarUrl";

export interface OnboardingIdentityChange {
  field: OnboardingIdentityField;
  label: string;
  before: string | null;
  after: string | null;
}

export interface OnboardingIdentityAdoptionPreview {
  canAdopt: boolean;
  changes: OnboardingIdentityChange[];
  currentIdentity: Record<OnboardingIdentityField, string | null>;
  officialIdentity: Record<OnboardingIdentityField, string | null>;
}

export interface OnboardingIdentityAdoptionResult extends OnboardingIdentityAdoptionPreview {
  appliedChanges: OnboardingIdentityChange[];
  agent: Agent;
}

export type AgentRuntimeProfileMigrationStatus = "stable" | "pending" | "migrating";
export type AgentRuntimeProfilePendingKind = "migration" | "daemon_release_notice";

export interface AgentRuntimeProfileRef {
  label?: string | null;
  path?: string | null;
  machineId?: string | null;
  runtime?: string | null;
  reachable?: boolean | null;
  reason?: string | null;
}

export interface AgentRuntimeProfileSnapshot {
  runtimeProfileFingerprint?: string;
  daemonVersion?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  runtime?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  executionMode?: "byoc" | "cloud" | string | null;
  workspaceRef?: AgentRuntimeProfileRef | string | null;
  workspacePathRef?: AgentRuntimeProfileRef | string | null;
  sessionRef?: AgentRuntimeProfileRef | string | null;
  observedAt?: string | null;
}

export interface AgentRuntimeProfileChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface AgentRuntimeProfilePending {
  kind: AgentRuntimeProfilePendingKind;
  key: string;
  migratingSince?: string | null;
  lastNudgeAt?: string | null;
  nudgeCount?: number;
  before?: AgentRuntimeProfileSnapshot | null;
  after?: AgentRuntimeProfileSnapshot | null;
  changes?: AgentRuntimeProfileChange[];
  previousSessionRef?: AgentRuntimeProfileRef | string | null;
}

export interface AgentRuntimeProfileSummary {
  current?: AgentRuntimeProfileSnapshot | null;
  migrationStatus: AgentRuntimeProfileMigrationStatus;
  pending?: AgentRuntimeProfilePending | null;
}

export interface CreatorSummary {
  type: "human" | "agent";
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  gravatarHash?: string;
  deletedAt?: string | null;
}

export interface AgentCreatedSummary {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  runtime: string;
  external?: boolean;
  status: AgentStatus;
}

export type ExternalAgentSetupState = "waiting_for_login" | "credential_minted" | "connected";

export interface ExternalAgentStatus {
  setupState: ExternalAgentSetupState;
  credentialLastUsedAt: string | null;
  lastActivityAt: string | null;
}

/** Shape returned by the API — may include activity fields used to seed agentActivities. */
type ApiAgent = Agent & {
  activity?: AgentActivity;
  activityKind?: AgentActivity;
  activityDetail?: string;
  activityDetailKind?: AgentActivityDetailKind;
};


export type { ActivityLogEntry, AgentActivityState, TrajectoryLogEntry } from "./events/agentActivityEvents";

export interface AgentDisplayState {
  activity: AgentActivity;
  activityDetail: string;
  activityDetailKind: AgentActivityDetailKind;
  activityText: string;
  isOnline: boolean;
  /** True for external agents — use neutral tone instead of managed liveness dot. */
  isExternal?: boolean;
}

type AgentDisplayFallback = Pick<Agent, "status"> & Partial<Pick<Agent, "runtime" | "external">>;

export function resolveAgentDisplayState(
  agent: Pick<Agent, "status"> | null | undefined,
  activityState: AgentActivityState | null | undefined,
  isExternal?: boolean,
): AgentDisplayState {
  // External agents use SHA-V0-014 observed-activity readout, not managed runtime liveness
  if (isExternal) {
    return {
      activity: "online",
      activityDetail: "",
      activityDetailKind: "none",
      activityText: "External",
      isOnline: false,
      isExternal: true,
    };
  }
  const activity = activityState?.activity
    ?? (agent?.status === "active" ? "online" : "offline");
  const activityDetail = activityState?.activityDetail
    ?? (agent?.status === "stopped" ? en["activity.log.status.stopped"] : "");
  const detailKind = activityState?.detailKind
    ?? (agent?.status === "stopped" ? "stopped" : "none");
  return {
    activity,
    activityDetail,
    activityDetailKind: detailKind,
    activityText: getActivityText(activity, activityDetail, detailKind),
    isOnline: activity !== "offline",
  };
}

interface AgentState {
  agents: Agent[];
  /**
   * Internal materialized current-activity cache.
   * Components should consume selector/hook projections below instead of
   * reading this record directly.
   */
  agentActivities: Record<string, AgentActivityState>;
  /**
   * Transient trace-only equijoin data for the latest socket-rooted activity
   * render. This is deliberately kept out of activity/trajectory logs so the
   * opaque clientEventId cannot become persisted producer metadata.
   */
  agentActivityTraceJoins: Record<string, AgentActivityTraceJoin>;
  /**
   * Last observation timestamp used to update the status surface.
   * Activity Log entries can arrive via a separate trajectory stream;
   * this lets that stream fix stale idle badges without letting older
   * log replay clobber a newer non-idle socket push.
   */
  agentActivityObservedAt: Record<string, number>;
  /**
   * Local monotonic activity mutation counter. REST snapshots can race
   * socket pushes during reconnect: if an `agent:activity` push lands
   * while `/agents` is still in flight, the stale REST response must not
   * overwrite the fresher socket state.
   */
  agentActivityVersions: Record<string, number>;
  /**
   * Per-agent monotonic seq of the last applied `agent:activity`
   * push, used to drop out-of-order updates that arrive during
   * reconnect storms. Cleared on `socket.connect` (which also fires
   * `loadAgents()`) so server restarts don't false-reject. New
   * server emits include `serverSeq`; old servers omit it, in which
   * case we always apply (== pre-PR behaviour).
   * Introduced 2026-05-02 #engineering:72283cf7 task #340 PR B.
   */
  agentActivitySeq: Record<string, number>;
  /**
   * Per-agent launchId under which `agentActivitySeq` was last applied.
   * TRACKING ONLY — this does NOT gate the serverSeq dedup (the guard below is
   * unchanged). It exists so the store-decision trace can emit the closed-set
   * `launch_changed` / `same_launch` relation, letting a reader tell whether a
   * `stale_server_seq` drop coincided with a launch change. That distinguishes
   * a launch-scoped counter reset from ordinary within-launch reorder without
   * exposing raw ids/seqs (Q8). Provability instrumentation for #161; the
   * behavioural fix (if any) is decided separately once this proves the path.
   */
  agentActivityLaunchId: Record<string, string>;
  loading: boolean;
  showCreateAgent: boolean;
  createAgentOnboarding: boolean;
  activityLogs: Record<string, ActivityLogEntry[]>;
  trajectoryLogs: Record<string, TrajectoryLogEntry[]>;
  /**
   * Request generation for durable trajectory hydrates. Re-baseline events
   * reset seq space; any older in-flight hydrate must be dropped before it can
   * compare old-epoch serverSeq values against the new baseline.
   */
  trajectoryHydrateGeneration: number;
  setShowCreateAgent: (show: boolean, onboarding?: boolean) => void;
  loadAgents: () => Promise<void>;
  ensureAgentProfile: (agentId: string) => Promise<void>;
  /**
   * Reset the per-agent serverSeq tracking. Call this on
   * `socket.on("connect")` so the post-reconnect snapshot path
   * (`loadAgents()` + subsequent socket pushes) is not blocked by
   * stale seq numbers held over from before the disconnect.
   */
  resetActivitySeq: () => void;
  createAgent: (
    name: string,
    opts?: { description?: string; model?: string; runtime?: string; runtimeConfig?: RuntimeConfig; formDefinitionRef?: RuntimeFormDefinitionRef; reasoningEffort?: ReasoningEffort; machineId?: string; envVars?: Record<string, string>; avatarUrl?: string; onboarding?: boolean; external?: boolean }
  ) => Promise<Agent>;
  fetchExternalAgentStatus: (agentId: string) => Promise<ExternalAgentStatus>;
  fetchOnboardingIdentityAdoption: (agentId: string) => Promise<OnboardingIdentityAdoptionPreview>;
  adoptOnboardingIdentity: (agentId: string) => Promise<OnboardingIdentityAdoptionResult>;
  updateAgent: (
    agentId: string,
    fields: { displayName?: string | null; description?: string | null; avatarUrl?: string | null; serverRole?: Extract<ServerRole, "admin" | "member">; model?: string; runtime?: string; runtimeConfig?: RuntimeConfig | null; formDefinitionRef?: RuntimeFormDefinitionRef; reasoningEffort?: ReasoningEffort | null; envVars?: Record<string, string> | null },
    opts?: { restartMode?: "restart" | "session" },
  ) => Promise<Agent>;
  startAgent: (agentId: string) => Promise<void>;
  stopAgent: (agentId: string) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  resetAgent: (agentId: string, mode: "restart" | "session" | "full") => Promise<void>;
  updateAgentSession: (agentId: string, sessionId: string | null) => void;
  updateActivity: (
    agentId: string,
    activity: string,
    activityDetail?: string,
    serverSeq?: number,
    timestamp?: number,
    joinKeys?: { launchId?: string; clientSeq?: number; probeId?: string },
    activityKind?: string,
    detailKind?: string,
    traceJoin?: AgentActivityTraceJoin,
    isHeartbeat?: boolean,
    isRefreshOnly?: boolean,
  ) => void;
  appendTrajectory: (
    agentId: string,
    entries: TrajectoryEntry[],
    timestamp?: number,
    joinKeys?: { launchId?: string; clientSeq?: number; probeId?: string },
    serverSeq?: number,
    traceJoin?: AgentActivityTraceJoin,
  ) => void;
  loadTrajectoryLog: (agentId: string, limit?: number) => Promise<void>;
  getActivityLog: (agentId: string) => ActivityLogEntry[];
  getTrajectoryLog: (agentId: string) => TrajectoryLogEntry[];
}

export function selectAgentCurrentActivityState(state: AgentState, agentId: string): AgentActivityState | undefined {
  return state.agentActivities[agentId];
}

export function selectAgentActivityTraceJoin(state: AgentState, agentId: string): AgentActivityTraceJoin | undefined {
  return state.agentActivityTraceJoins[agentId];
}

/**
 * Pure per-agent display-state compute over narrow slices. Components that
 * need MANY agents' display states must subscribe to the raw slices
 * (`s.agents`, `s.agentActivities` — stable references) and call this in
 * render. NEVER build a map of these inside a store selector: the result is
 * a fresh object per call, so even useShallow sees a changed snapshot every
 * time -> infinite re-render (React #185, prod incident 2026-07-07).
 */
/** Named stable slice export — components subscribe via this instead of
 *  naming the raw field (agentActivityStoreBoundary ratchet). Returns the
 *  store-held reference, so it is snapshot-stable by construction. */
export const selectAgentActivitiesSlice = (state: AgentState): Record<string, AgentActivityState> => state.agentActivities;

export function computeAgentDisplayState(
  agents: Agent[],
  agentActivities: Record<string, AgentActivityState>,
  agentId: string,
  fallbackAgent?: AgentDisplayFallback | null,
): AgentDisplayState {
  const agent = agents.find((candidate) => candidate.id === agentId) ?? fallbackAgent;
  const isExternal = agent?.external === true || isExternalAgentRuntime(agent?.runtime);
  return resolveAgentDisplayState(agent, agentActivities[agentId], isExternal);
}

export function selectAgentDisplayState(
  state: AgentState,
  agentId: string,
  fallbackAgent?: AgentDisplayFallback | null,
): AgentDisplayState {
  return computeAgentDisplayState(state.agents, state.agentActivities, agentId, fallbackAgent);
}

/**
 * Module-level in-flight guard for `loadAgents()`. Multiple
 * concurrent calls (e.g. socket-reconnect storm firing several
 * `connect` events in quick succession) coalesce onto the same
 * Promise, preventing the REST response from racing with newer
 * socket pushes. Cleared after each settled fetch.
 * (#engineering:72283cf7 task #340 PR B)
 */
let loadAgentsInFlight: Promise<void> | null = null;
const agentProfileInFlight = new Map<string, Promise<void>>();
let agentActivityReconcileScheduled = false;

function nextActivityVersion(state: Pick<AgentState, "agentActivityVersions">, agentId: string): number {
  return (state.agentActivityVersions[agentId] ?? 0) + 1;
}

function stripActivityFields(agent: ApiAgent): Agent {
  const { activity: _a, activityKind: _ak, activityDetail: _d, activityDetailKind: _dk, ...rest } = agent;
  return rest;
}

function clearAgentActivityTraceJoin(
  traceJoins: Record<string, AgentActivityTraceJoin>,
  agentId: string,
): Record<string, AgentActivityTraceJoin> {
  if (traceJoins[agentId] === undefined) return traceJoins;
  const { [agentId]: _cleared, ...rest } = traceJoins;
  return rest;
}

function agentStateTransitionOutcome(transition: AgentActivityTransition): "applied" | "noop" | "conflict" {
  if (transition.outcome === "producer_seq_conflict") return "conflict";
  if (transition.outcome === "applied" || transition.outcome === "logged") return "applied";
  return "noop";
}

/**
 * Structural sharing for the agents list. `loadAgents()` runs not only on
 * initial load but also on the 60s periodic status reconcile (#2616 / CC-006
 * client side) and on focus refetch — each fetch builds a brand-new array of
 * brand-new objects. Swapping the `agents` reference on every reconcile, even
 * when nothing changed, churns every `agents`-derived selector (e.g. ChatPanel's
 * mentionMap / agentById) by reference → breaks `MessageItem`'s `memo()` → the
 * whole message list re-renders and re-parses markdown. Reuse the previous array
 * (and per-element references) whenever the freshly-fetched data is deep-equal,
 * so a no-op reconcile yields zero re-renders while a real status/identity change
 * still propagates. (#proj-o11y / #wg-frontend-perf message-list re-render storm.)
 */
function agentRecordEqual(a: Agent, b: Agent): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof Agent)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    if (va && vb && typeof va === "object" && typeof vb === "object") {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
    } else {
      return false;
    }
  }
  return true;
}

export function reconcileAgentsList(prev: Agent[], next: Agent[]): Agent[] {
  const prevById = new Map(prev.map((a) => [a.id, a]));
  const reconciled = next.map((n) => {
    const p = prevById.get(n.id);
    return p && agentRecordEqual(p, n) ? p : n;
  });
  // If every element resolved to the previous reference in the same order, the
  // list is unchanged — return the prior array so subscribers don't re-render.
  if (reconciled.length === prev.length && reconciled.every((a, i) => a === prev[i])) {
    return prev;
  }
  return reconciled;
}

function pickAgentActivityDomainState(state: AgentState): AgentActivityDomainState {
  return {
    agentActivities: state.agentActivities,
    agentActivityTraceJoins: state.agentActivityTraceJoins,
    agentActivityObservedAt: state.agentActivityObservedAt,
    agentActivityVersions: state.agentActivityVersions,
    agentActivitySeq: state.agentActivitySeq,
    agentActivityLaunchId: state.agentActivityLaunchId,
    activityLogs: state.activityLogs,
    trajectoryLogs: state.trajectoryLogs,
  };
}

function applyAgentActivityDomainPatch(state: AgentState, next: AgentActivityDomainState): Partial<AgentState> {
  return {
    agentActivities: next.agentActivities,
    agentActivityTraceJoins: next.agentActivityTraceJoins,
    agentActivityObservedAt: next.agentActivityObservedAt,
    agentActivityVersions: next.agentActivityVersions,
    agentActivitySeq: next.agentActivitySeq,
    agentActivityLaunchId: next.agentActivityLaunchId,
    activityLogs: next.activityLogs,
    trajectoryLogs: next.trajectoryLogs,
  };
}

function traceAgentActivityTransition(
  state: AgentState,
  transition: AgentActivityTransition,
  input: {
    activity?: string;
    activityKind?: string;
    detail?: string;
    detailKind?: string;
    joinKeys?: AgentActivityJoinKeys;
    traceJoin?: AgentActivityTraceJoin;
    isHeartbeat?: boolean;
    isRefreshOnly?: boolean;
  } = {},
): void {
  emitStateTransitionTrace({
    domain: "agents",
    event: transition.event,
    entityId: transition.agentId,
    touched: transition.touched,
    outcome: agentStateTransitionOutcome(transition),
    outcomeDetail: transition.outcome,
    reconcileSuggested: transition.reconcileSuggested,
    seq: transition.serverSeq,
    timestamp: transition.timestamp,
    join: input.traceJoin,
  });
  if (transition.outcome === "producer_seq_conflict") {
    const basis = transition.violationBasis!;
    emitStateViolationTrace({
      domain: "agents",
      entityId: transition.agentId,
      violationKind: "producer_seq_conflict",
      epoch: state.trajectoryHydrateGeneration,
      same_activity: basis.same_activity,
      same_detail_kind: basis.same_detail_kind,
      same_detail_presence: basis.same_detail_presence,
      same_detail_bucket: basis.same_detail_bucket,
      event: transition.event,
      outcomeDetail: transition.outcome,
      serverSeq: transition.serverSeq,
      timestamp: transition.timestamp,
      currentActivity: basis.currentActivity,
      projectedActivity: basis.projectedActivity,
      currentDetailKind: basis.currentDetailKind,
      projectedDetailKind: basis.projectedDetailKind,
      join: input.traceJoin,
    });
    return;
  }
  if (transition.outcome !== "applied" && transition.outcome !== "stale_server_seq" && transition.outcome !== "invalid_activity") return;
  traceAgentActivityStoreDecision({
    agentId: transition.agentId,
    activity: transition.nextActivity ?? input.activity,
    activityKind: transition.nextActivity ?? input.activityKind ?? input.activity,
    detail: input.detail,
    detailKind: input.detailKind,
    serverSeq: transition.serverSeq,
    timestamp: transition.timestamp,
    isHeartbeat: input.isHeartbeat,
    isRefreshOnly: input.isRefreshOnly,
    ...input.joinKeys,
    join: input.traceJoin,
    lastServerSeq: transition.agentId ? state.agentActivitySeq[transition.agentId] : undefined,
    lastLaunchId: transition.agentId ? state.agentActivityLaunchId[transition.agentId] : undefined,
    previousActivity: transition.previousActivity ?? null,
    nextActivity: transition.nextActivity ?? null,
    outcome: transition.outcome,
  });
}

function scheduleAgentActivityReconcile(): void {
  if (agentActivityReconcileScheduled) return;
  agentActivityReconcileScheduled = true;
  void Promise.resolve().then(() => {
    agentActivityReconcileScheduled = false;
    return useAgentStore.getState().loadAgents();
  });
}

export const useAgentStore = create<AgentState>((set, get) => ({
  showCreateAgent: false,
  createAgentOnboarding: false,
  setShowCreateAgent: (show, onboarding = false) =>
    set({
      showCreateAgent: show,
      createAgentOnboarding: show ? onboarding : false,
    }),
  agents: [],
  agentActivities: {},
  agentActivityTraceJoins: {},
  agentActivityObservedAt: {},
  agentActivityVersions: {},
  agentActivitySeq: {},
  agentActivityLaunchId: {},
  loading: true,
  activityLogs: {},
  trajectoryLogs: {},
  trajectoryHydrateGeneration: 0,

  loadAgents: async () => {
    // In-flight guard: when the socket reconnects in a flap, `connect`
    // can fire multiple times rapidly. Each call into `loadAgents`
    // would otherwise produce a parallel REST request whose response
    // races the live socket pushes — a slow response can clobber a
    // newer pushed activity. Coalesce concurrent calls onto a single
    // promise. (#engineering:72283cf7 task #340 PR B.)
    if (loadAgentsInFlight) return loadAgentsInFlight;
    const epoch = useServerStore.getState().serverEpoch;
    const serverId = useServerStore.getState().current?.id;
    if (!serverId) return;
    const agentIdsAtRequest = new Set(get().agents.map((agent) => agent.id));
    const activityVersionsAtRequest = { ...get().agentActivityVersions };
    // Never set loading here — it starts as true (store init / server reset)
    // and goes to false after the first successful fetch. This keeps existing
    // data (or a legitimate empty state) visible during refreshes.
    loadAgentsInFlight = (async () => {
      try {
        const { data } = await api.get("/agents");
        if (useServerStore.getState().serverEpoch !== epoch) return;
        const apiAgents = data as ApiAgent[];
        const agents = apiAgents.map(stripActivityFields);
        const snapshotActivities: Record<string, AgentActivityState> = {};
        const snapshotObservedAt = Date.now();
        for (const a of apiAgents) {
          snapshotActivities[a.id] = {
            activity: normalizeActivity(a.activityKind ?? a.activity, a.status),
            activityDetail: a.activityDetail || "",
            detailKind: normalizeActivityDetailKind(a.activityDetailKind),
          };
        }
        // The REST snapshot is authoritative for the moment of fetch;
        // reset per-agent seq tracking so future socket pushes are
        // accepted as long as they're monotonically newer.
        set((state) => {
          const agentActivities: Record<string, AgentActivityState> = {};
          const agentActivityTraceJoins: Record<string, AgentActivityTraceJoin> = {};
          const agentActivityObservedAt: Record<string, number> = {};
          const agentActivityVersions: Record<string, number> = {};
          const snapshotAgentIds = new Set(agents.map((agent) => agent.id));
          const locallyAddedAgents = state.agents.filter((agent) =>
            !agentIdsAtRequest.has(agent.id) && !snapshotAgentIds.has(agent.id)
          );
          for (const a of apiAgents) {
            const requestVersion = activityVersionsAtRequest[a.id] ?? 0;
            const currentVersion = state.agentActivityVersions[a.id] ?? 0;
            if (currentVersion > requestVersion && state.agentActivities[a.id]) {
              agentActivities[a.id] = state.agentActivities[a.id];
              if (state.agentActivityTraceJoins[a.id]) {
                agentActivityTraceJoins[a.id] = state.agentActivityTraceJoins[a.id];
              }
              agentActivityObservedAt[a.id] = state.agentActivityObservedAt[a.id] ?? snapshotObservedAt;
              agentActivityVersions[a.id] = currentVersion;
            } else {
              agentActivities[a.id] = snapshotActivities[a.id];
              agentActivityObservedAt[a.id] = snapshotObservedAt;
              agentActivityVersions[a.id] = currentVersion;
            }
          }
          for (const a of locallyAddedAgents) {
            if (state.agentActivities[a.id]) {
              agentActivities[a.id] = state.agentActivities[a.id];
              if (state.agentActivityTraceJoins[a.id]) {
                agentActivityTraceJoins[a.id] = state.agentActivityTraceJoins[a.id];
              }
              agentActivityObservedAt[a.id] = state.agentActivityObservedAt[a.id] ?? snapshotObservedAt;
              agentActivityVersions[a.id] = state.agentActivityVersions[a.id] ?? 0;
            }
          }
          return {
            agents: reconcileAgentsList(state.agents, [...agents, ...locallyAddedAgents]),
            agentActivities,
            agentActivityTraceJoins,
            agentActivityObservedAt,
            agentActivityVersions,
            agentActivitySeq: {},
            agentActivityLaunchId: {},
            trajectoryHydrateGeneration: state.trajectoryHydrateGeneration + 1,
            loading: false,
          };
        });
      } catch (err) {
        console.error("Failed to load agents:", err);
        if (useServerStore.getState().serverEpoch !== epoch) return;
        set({ loading: false });
      }
    })();
    try {
      await loadAgentsInFlight;
    } finally {
      loadAgentsInFlight = null;
    }
  },

  ensureAgentProfile: async (agentId) => {
    if (!agentId || get().agents.some((agent) => agent.id === agentId)) return;
    const existing = agentProfileInFlight.get(agentId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const { data } = await api.get(`/agents/${agentId}`);
        const apiAgent = data as ApiAgent;
        const agent = stripActivityFields(apiAgent);
        const observedAt = Date.now();
        const snapshotActivity = makeActivityState(
          normalizeActivity(apiAgent.activityKind ?? apiAgent.activity, apiAgent.status),
          apiAgent.activityDetail || "",
          normalizeActivityDetailKind(apiAgent.activityDetailKind),
        );
        set((state) => {
          const currentAgents = state.agents.filter((candidate) => candidate.id !== agent.id);
          const next: Partial<AgentState> = {
            agents: reconcileAgentsList(state.agents, [...currentAgents, agent]),
            loading: false,
          };
          if (!state.agentActivities[agent.id]) {
            next.agentActivities = { ...state.agentActivities, [agent.id]: snapshotActivity };
            next.agentActivityTraceJoins = clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agent.id);
            next.agentActivityObservedAt = { ...state.agentActivityObservedAt, [agent.id]: observedAt };
            next.agentActivityVersions = { ...state.agentActivityVersions, [agent.id]: state.agentActivityVersions[agent.id] ?? 0 };
          }
          return next;
        });
      } catch (err) {
        console.error(`Failed to load agent profile ${agentId}:`, err);
      }
    })();
    agentProfileInFlight.set(agentId, promise);
    try {
      await promise;
    } finally {
      agentProfileInFlight.delete(agentId);
    }
  },

  resetActivitySeq: () => set((state) => ({
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    agentActivityTraceJoins: {},
    trajectoryHydrateGeneration: state.trajectoryHydrateGeneration + 1,
  })),

  createAgent: async (name, opts = {}) => {
    const { data } = await api.post("/agents", {
      name,
      description: opts.description,
      model: opts.model,
      runtime: opts.runtime,
      runtimeConfig: opts.runtimeConfig,
      formDefinitionRef: opts.formDefinitionRef,
      reasoningEffort: opts.reasoningEffort,
      machineId: opts.machineId,
      envVars: opts.envVars,
      avatarUrl: opts.avatarUrl,
      onboarding: opts.onboarding,
      external: opts.external,
    });
    const { activity: rawActivity, activityKind: rawActivityKind, activityDetail: rawDetail, activityDetailKind: rawDetailKind, ...rest } = data as ApiAgent;
    const agent: Agent = rest;
    set((state) => ({
      agents: [...state.agents, agent],
      agentActivities: {
        ...state.agentActivities,
        [agent.id]: {
          activity: normalizeActivity(rawActivityKind ?? rawActivity, agent.status),
          activityDetail: rawDetail || "",
          detailKind: normalizeActivityDetailKind(rawDetailKind),
        },
      },
      agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agent.id),
      agentActivityObservedAt: {
        ...state.agentActivityObservedAt,
        [agent.id]: Date.now(),
      },
      agentActivityVersions: {
        ...state.agentActivityVersions,
        [agent.id]: nextActivityVersion(state, agent.id),
      },
    }));
    notifyAllChannelMembersChanged();
    return agent;
  },

  fetchExternalAgentStatus: async (agentId) => {
    const { data } = await api.get(`/agents/${agentId}/external-status`);
    return data as ExternalAgentStatus;
  },

  fetchOnboardingIdentityAdoption: async (agentId) => {
    const { data } = await api.get(`/agents/${agentId}/onboarding-identity-adoption`);
    return data as OnboardingIdentityAdoptionPreview;
  },

  adoptOnboardingIdentity: async (agentId) => {
    const { data } = await api.post(`/agents/${agentId}/onboarding-identity-adoption`);
    const result = data as OnboardingIdentityAdoptionResult;
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, ...result.agent } : a
      ),
    }));
    return result;
  },

  updateAgent: async (agentId, fields, opts) => {
    const { data } = await api.patch(`/agents/${agentId}`, {
      ...fields,
      ...(opts?.restartMode ? { restartMode: opts.restartMode } : {}),
    });
    set((state) => ({
      ...(() => {
        if (opts?.restartMode !== "session") {
          return {};
        }
        const { [agentId]: _activityLog, ...nextActivityLogs } = state.activityLogs;
        const { [agentId]: _trajectoryLog, ...nextTrajectoryLogs } = state.trajectoryLogs;
        return {
          activityLogs: nextActivityLogs,
          trajectoryLogs: nextTrajectoryLogs,
        };
      })(),
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, ...data } : a
      ),
    }));
    return data;
  },

  startAgent: async (agentId) => {
    await api.post(`/agents/${agentId}/start`);
    // Only optimistically update if agent was offline — avoid overriding real state
    set((state) => {
      const current = state.agentActivities[agentId];
      const agents = state.agents.map((a) =>
        a.id === agentId ? { ...a, status: "active" as const } : a
      );
      if (current?.activity !== "offline") {
        return { agents };
      }
      return {
        agents,
        agentActivities: {
          ...state.agentActivities,
          [agentId]: makeActivityState("working", "", "starting"),
        },
        agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agentId),
        agentActivityObservedAt: {
          ...state.agentActivityObservedAt,
          [agentId]: Date.now(),
        },
        agentActivityVersions: {
          ...state.agentActivityVersions,
          [agentId]: nextActivityVersion(state, agentId),
        },
      };
    });
    notifyAllChannelMembersChanged();
  },

  stopAgent: async (agentId) => {
    await api.post(`/agents/${agentId}/stop`);
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, status: "stopped" as const } : a
      ),
      agentActivities: {
        ...state.agentActivities,
        [agentId]: makeActivityState("offline", en["activity.log.status.stopped"], "stopped"),
      },
      agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agentId),
      agentActivityObservedAt: {
        ...state.agentActivityObservedAt,
        [agentId]: Date.now(),
      },
      agentActivityVersions: {
        ...state.agentActivityVersions,
        [agentId]: nextActivityVersion(state, agentId),
      },
    }));
  },

  deleteAgent: async (agentId) => {
    await api.delete(`/agents/${agentId}`);
    set((state) => {
      const { [agentId]: _, ...restActivities } = state.agentActivities;
      const { [agentId]: _traceJoin, ...restTraceJoins } = state.agentActivityTraceJoins;
      const { [agentId]: _observedAt, ...restObservedAt } = state.agentActivityObservedAt;
      const { [agentId]: _version, ...restVersions } = state.agentActivityVersions;
      return {
        agents: state.agents.map((a) =>
          a.id === agentId ? { ...a, deletedAt: new Date().toISOString(), status: "inactive" as const } : a
        ),
        agentActivities: restActivities,
        agentActivityTraceJoins: restTraceJoins,
        agentActivityObservedAt: restObservedAt,
        agentActivityVersions: restVersions,
      };
    });
  },

  resetAgent: async (agentId, mode: "restart" | "session" | "full") => {
    await api.post(`/agents/${agentId}/reset`, { mode });
    set((state) => ({
      ...(() => {
        if (mode === "restart") {
          return {};
        }
        const { [agentId]: _activityLog, ...nextActivityLogs } = state.activityLogs;
        const { [agentId]: _trajectoryLog, ...nextTrajectoryLogs } = state.trajectoryLogs;
        return {
          activityLogs: nextActivityLogs,
          trajectoryLogs: nextTrajectoryLogs,
        };
      })(),
      agents: state.agents.map((a) =>
        a.id === agentId
          ? { ...a, status: "active" as const, ...(mode === "restart" ? {} : { sessionId: null }) }
          : a
      ),
      agentActivities: {
        ...state.agentActivities,
        [agentId]: makeActivityState("working", "", "starting"),
      },
      agentActivityTraceJoins: clearAgentActivityTraceJoin(state.agentActivityTraceJoins, agentId),
      agentActivityObservedAt: {
        ...state.agentActivityObservedAt,
        [agentId]: Date.now(),
      },
    }));
  },

  updateAgentSession: (agentId, sessionId) => set((state) => ({
    agents: state.agents.map((a) =>
      a.id === agentId ? { ...a, sessionId } : a
    ),
  })),

  updateActivity: (agentId, activity, activityDetail = "", serverSeq, timestamp = Date.now(), joinKeys, activityKind, detailKind, traceJoin, isHeartbeat, isRefreshOnly) =>
    set((state) => {
      const { state: next, transition } = applyAgentActivityEvent(pickAgentActivityDomainState(state), {
        kind: "patch:socket-activity",
        agentId,
        activity,
        activityDetail,
        serverSeq,
        timestamp,
        joinKeys,
        traceJoin,
        activityKind,
        detailKind,
        isHeartbeat,
        isRefreshOnly,
      });
      traceAgentActivityTransition(state, transition, { activity, activityKind, detail: activityDetail, detailKind, joinKeys, traceJoin, isHeartbeat, isRefreshOnly });
      if (transition.reconcileSuggested) scheduleAgentActivityReconcile();
      return transition.touched === 0 ? {} : applyAgentActivityDomainPatch(state, next);
    }),

  appendTrajectory: (agentId, entries, timestamp = Date.now(), joinKeys, serverSeq, traceJoin) =>
    set((state) => {
      const { state: next, transition } = applyAgentActivityEvent(pickAgentActivityDomainState(state), {
        kind: "patch:trajectory-append",
        agentId,
        entries,
        timestamp,
        serverSeq,
        joinKeys,
        traceJoin,
      });
      traceAgentActivityTransition(state, transition, { joinKeys, traceJoin });
      if (transition.reconcileSuggested) scheduleAgentActivityReconcile();
      return transition.touched === 0 ? {} : applyAgentActivityDomainPatch(state, next);
    }),

  loadTrajectoryLog: async (agentId, limit = 50) => {
    const hydrateGeneration = get().trajectoryHydrateGeneration;
    let incoming: TrajectoryLogEntry[];
    try {
      const { data } = await api.get(`/agents/${agentId}/activity-log`, { params: { limit } });
      incoming = data as TrajectoryLogEntry[];
    } catch (err) {
      console.error(`Failed to load trajectory log for agent ${agentId}:`, err);
      if (get().trajectoryHydrateGeneration !== hydrateGeneration) return;
      set((state) => ({
        trajectoryLogs: {
          ...state.trajectoryLogs,
          [agentId]: state.trajectoryLogs[agentId] || [],
        },
      }));
      return;
    }
    set((state) => {
      if (state.trajectoryHydrateGeneration !== hydrateGeneration) return {};
      const { state: next, transition } = applyAgentActivityEvent(pickAgentActivityDomainState(state), {
        kind: "hydrate:trajectory-log",
        agentId,
        entries: incoming,
      });
      traceAgentActivityTransition(state, transition);
      if (transition.reconcileSuggested) scheduleAgentActivityReconcile();
      return transition.touched === 0 ? {} : applyAgentActivityDomainPatch(state, next);
    });
  },

  getActivityLog: (agentId) => get().activityLogs[agentId] || [],

  getTrajectoryLog: (agentId) => get().trajectoryLogs[agentId] || [],
}));

export function useAgentDisplayState(
  agentId: string,
  fallbackAgent?: AgentDisplayFallback | null,
): AgentDisplayState {
  const agentFromStore = useAgentStore((state) => state.agents.find((agent) => agent.id === agentId));
  const activityState = useAgentCurrentActivityState(agentId);
  const agent = agentFromStore ?? fallbackAgent;
  const isExternal = agent?.external === true || isExternalAgentRuntime(agent?.runtime);
  return resolveAgentDisplayState(agent, activityState, isExternal);
}

export function useAgentCurrentActivityState(agentId: string): AgentActivityState | undefined {
  return useAgentStore((state) => selectAgentCurrentActivityState(state, agentId));
}

export function useAgentActivityTraceJoin(agentId: string): AgentActivityTraceJoin | undefined {
  return useAgentStore((state) => selectAgentActivityTraceJoin(state, agentId));
}

// Reset all server-scoped state when the user switches servers.
registerServerReset(() =>
  useAgentStore.setState({
    agents: [],
    agentActivities: {},
    agentActivityTraceJoins: {},
    agentActivityObservedAt: {},
    agentActivityVersions: {},
    agentActivitySeq: {},
    agentActivityLaunchId: {},
    loading: true,
    showCreateAgent: false,
    createAgentOnboarding: false,
    activityLogs: {},
    trajectoryLogs: {},
    trajectoryHydrateGeneration: 0,
  })
);
