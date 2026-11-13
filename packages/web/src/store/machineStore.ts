import { create } from "zustand";
import api from "../api/client";
import { withSecondFactorStepUp } from "../components/settings/secondFactorStepUp";
import { coalesce, useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import { purgeStoredMachineKeys } from "./machineKeyStorage";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import {
  applyMachineEvent,
} from "./events/machineEvents";
import type {
  MachineDomainState,
  MachineEvent,
  MachineTransition,
} from "./events/machineEvents";
import type { CreatorSummary } from "./agentStore";
import type { AcceptedComputerUpgrade } from "../utils/computerUpgradeInFlight";
import { currentTimeMs, normalizeComputerReleaseNotes } from "@botiverse/raft-shared";
import type { ComputerReadiness, ReadinessAttention, ComputerInstallerRepairHint, ComputerReleaseNotes, ComputerUpgradeFailureHint, ComputerVersionGate, MachineDiskStatus, MachineMemoryStatus } from "@botiverse/raft-shared";

export interface MachineRuntimeDetection {
  status: "pending" | "complete" | "incomplete";
  unfinishedRuntimes?: string[];
  reason?: "deadline" | "child_failed" | "cancelled";
  updatedAtMs?: number;
}

export interface Machine {
  id: string;
  name: string;
  description: string | null;
  status: "online" | "offline";
  statusVersion: number;
  apiKeyPrefix: string | null;
  runtimes: string[];
  /** Live runtime binary/package versions reported by the connected daemon. */
  runtimeVersions?: Record<string, string>;
  /**
   * task #1268: the daemon's runtime detection state, sent explicitly by the
   * server. `pending` / `incomplete` mean `runtimes` is the last confirmed
   * list (unconfirmed, not unavailable). Absent/null = complete.
   */
  runtimeDetection?: MachineRuntimeDetection | null;
  hostname: string | null;
  os: string | null;
  // Cloud / VM platform id (display name from HOST_PROVIDER_LABELS) and OS
  // name + version ("Ubuntu 26.04"), as the Computer reports them; null =
  // unknown, absent on older servers. The id stays a plain string: a newer
  // Server may send one this bundle does not know, which then shows nothing.
  hostProvider?: string | null;
  osRelease?: string | null;
  // Coarse machine kind ("laptop", "server", ... DEVICE_CLASSES) for the
  // device icon; null = unknown, absent on older servers. A plain string for
  // the same reason as hostProvider: an unknown kind draws the fallback.
  deviceClass?: string | null;
  // Same-physical-machine label for this response ("machine-1"), shared by
  // the Computers that run on one host; null when alone, absent while
  // computer_host_identity_v0 is off. Compare only, never display.
  sameMachineGroup?: string | null;
  daemonVersion: string | null;
  // Run-kind: true when this machine is presented by an attached managed
  // Computer (server derives it from the computers↔machines link); false
  // for a raw daemon. Drives the Computer/Daemon label + computer-only
  // setup command on the detail page. Absent on older server responses →
  // treated as false (daemon).
  isComputer?: boolean;
  // True when this Computer row was attached by the current user. Raw daemons
  // and older server responses leave this false/absent.
  computerAttachedByCurrentUser?: boolean;
  // The machine row's owner (`machines.userId`, sent with every machine row:
  // machineReadModel.ts spreads it). It can differ from who attached the
  // Computer, for a legacy machine someone else adopted; the server's revoke
  // holds only this person to other people's agents (DeleteComputerDialog).
  userId?: string;
  /** #proj-raft-computer task #38: when an agent may have read this machine's current key (ISO). The server sends it to the owner only. */
  credentialExposureFoundAt?: string | null;
  // Latest disk report while online; null/absent when offline, never
  // reported, or from an older server. See machineDiskLowPresentation.
  diskStatus?: MachineDiskStatus | null;
  // Latest memory report while online; null/absent when offline, never
  // reported, from an older Computer or an older server.
  memoryStatus?: MachineMemoryStatus | null;
  // Public, server-scoped identity of the human who attached this managed
  // Computer. Null for departed creators and raw daemon rows.
  creator?: CreatorSummary | null;
  // Computer owner v1 (#wg-rbac:#32): who Raft records as its owner, null =
  // a Public Computer (absent on older servers: shown as Public). Not the
  // connector (`creator`, `userId`); display and transfer only, no rights.
  ownerUserId?: string | null;
  owner?: CreatorSummary | null;
  // For a managed Computer: its own `@botiverse/raft-computer` version (0.0.x),
  // reported by the Computer and shown instead of the underlying daemon
  // version. Null/absent until reported.
  computerVersion?: string | null;
  // Compatibility projection of the closed server policy decision.
  // true is the only broadcastable state; false means policy denied.
  computerUpgradeAvailable?: boolean | null;
  // Remote upgrade v2 (task #873): the latest request for this machine, as
  // the server projects it. `pending` until the machine reconnects or the
  // deadline passes; nothing else is modelled.
  upgradeRequest?: MachineUpgradeRequest | null;
  // Remote upgrade v2: only `true` may be driven from the web. false = this
  // Computer predates the web-driven path; null = version unknown. Both show
  // the greyed button + local upgrade hint (same fail-closed shape as the server).
  remoteUpgradeSupported?: boolean | null;
  // The server's version floor verdict (#10343): null = at or above the floor
  // (or no floor configured); absent = an older server that does not send it.
  versionGate?: ComputerVersionGate | null;
  // #proj-raft-computer:#68: the Computer's readiness and each runtime's
  // (Computer → runtime → its machine login), trimmed for this viewer;
  // absent from older servers.
  readiness?: ComputerReadiness;
  // #proj-raft-computer:#68: what a person must act on here (the server's
  // composeReadinessAttention, trimmed for this viewer): the Computers
  // "Needs attention" count, filter and dot. Absent from older servers: then
  // the web shows nothing new.
  attention?: ReadinessAttention;
  // Per-machine source-aware policy projection. This is the only authority for
  // target/copy; top-level latestComputerVersion is an artifact hint.
  computerBroadcastPolicy?: {
    eligibility: "eligible" | "no_broadcast";
    targetVersion: string | null;
    targetRole: "K" | "post_K" | "independent_bugfix" | null;
    migrationClass: "controlled_reinstall_repair" | "seamless" | null;
    policyRevision: string | null;
    reasonCode: string;
  } | null;
  // #proj-raft-computer task #34: advisory, the Computer's installer state
  // looks like it needs a repair run on the machine. Never changes whether
  // Upgrade is offered; absent = an older server or Computer.
  installerRepairHint?: ComputerInstallerRepairHint | null;
  lastHeartbeat: string | null;
  createdAt: string;
}

export interface MachineWorkspaceEntry {
  directoryName: string;
  totalSizeBytes: number;
  lastModified: string;
  fileCount: number;
  /** Reported by daemons from 1.0.46; older daemons only use `~/.slock/agents/`. */
  displayPath?: string;
  status: "active" | "stopped" | "deleted" | "orphan";
  agentName: string | null;
  agentStatus: string | null;
}

/** Per-machine Computer upgrade/restart progress driven by WS frames.
 *  Keyed by machineId. Reset when the machine goes offline or a new
 *  operation begins on the same machine. */
export interface MachineUpgradeRequest {
  id: string;
  targetVersion: string;
  requestedAt: string;
  /** `succeeded_late`: the target version connected only after the deadline
   *  (shown like `done`); absent on older servers. */
  state: "pending" | "done" | "failed" | "no_response" | "succeeded_late";
  observedVersion: string | null;
  reason: string | null;
  resolvedAt: string | null;
  /** A failure only the install command on the machine gets past; absent on older servers. */
  failureHint?: ComputerUpgradeFailureHint | null;
  /** When the server gives up on the request (ISO), drain wait included; absent on older servers. */
  deadlineAt?: string;
  /**
   * Reconciler step 13, only on a pending request whose Computer waits for
   * its agents first: `draining` while they finish their work, `installing`
   * once that wait is over. Absent (older servers, no drain): the plain copy.
   */
  phase?: "draining" | "installing";
  /** The agents of THIS server still finishing their work, while `draining`.
   *  Agents of the Computer's other servers wait too but are not listed. */
  drainingAgentIds?: string[];
  /** When the drain stops waiting (ISO). */
  drainDeadlineAt?: string;
}

export interface ComputerOperationProgress {
  /** Restart is the only in-flight Computer operation the web tracks; upgrades
   *  are request rows settled by the machine's reconnect (remote upgrade v2). */
  operation: "restart";
  /** requestId echoed from the command for terminal receipt correlation. */
  requestId?: string;
  /** Optional human-readable status message. */
  message?: string;
  /** Derived 0-100 progress value for determinate phases. */
  progressValue?: number;
  /** True once the terminal receipt arrives. */
  done?: boolean;
  /** Error message on failure. */
  error?: string;
}

/** Host facts a `machine:capabilities` push may carry; undefined = not in this push (keep). */
export interface MachineCapabilitiesHostFacts {
  hostProvider?: string | null;
  osRelease?: string | null;
  deviceClass?: string | null;
  /** The server's version floor verdict (null = not gated). */
  versionGate?: ComputerVersionGate | null;
}

export type MachineLoadStatus = "loading" | "loaded" | "error";
export type AddMachineIntent = "default" | "another-computer";

interface MachineState {
  machines: Machine[];
  /** Latest published artifact hint. Never a per-machine target or
   *  eligibility authority; each row's computerBroadcastPolicy owns those. */
  latestComputerVersion: string | null;
  /** Display-only release notes for the latest published Computer version. */
  latestComputerReleaseNotes: ComputerReleaseNotes | null;
  loading: boolean;
  loadStatus: MachineLoadStatus;
  loadError: boolean;
  selectedMachineId: string | null;
  showAddMachine: boolean;
  /**
   * What Add Computer was opened for: "default" asks which computer
   * (AddMachineDialog); "another-computer" opens straight on the command
   * flow for a different machine (This device's "Install on Another
   * Computer" when this computer can't run Raft Computer).
   */
  addMachineIntent: AddMachineIntent;
  /** Per-machine workspace scan results */
  machineWorkspaces: Record<string, MachineWorkspaceEntry[]>;
  machineWorkspacesLoading: Record<string, boolean>;
  /** Per-machine Computer operation progress (upgrade/restart) */
  computerOperationProgress: Record<string, ComputerOperationProgress | null>;
  /** Per-machine web Upgrade click in flight: the target version, from the
   *  click until the POST settles and the refreshed machine row carries the
   *  server's upgradeRequest. Client-only; never a server fact. */
  computerUpgradeSubmitting: Record<string, string>;
  /** Per-machine upgrade request the server accepted for this tab's Upgrade
   *  click; see computerUpgradeInFlight. Client-only copy of a server fact. */
  computerUpgradeAccepted: Record<string, AcceptedComputerUpgrade>;
  /** Per-machine time (client clock, ms) this tab saw a live online→offline
   *  status event; cleared when it comes back online. The machine row has no
   *  disconnect timestamp (`lastHeartbeat` in the store is only as fresh as
   *  the last loadMachines), so a transition seen live is the best anchor for
   *  "offline since". Client-only; never a server fact. */
  computerOfflineObservedAt: Record<string, number>;
  /** Computers this tab holds offline only because the server refused a Start
   *  with `machine_offline` (#triage:#206): no "offline since" is known for
   *  them. Cleared by the next status event or machine list. Client-only. */
  computerOfflineFromRefusal: Record<string, true>;

  loadMachines: () => Promise<void>;
  /** Ask a computer to re-detect its installed runtimes. Fresh list arrives via the capabilities push. */
  rescanRuntimes: (machineId: string) => Promise<void>;
  registerMachine: (
    name: string,
  ) => Promise<{ machine: Machine; apiKey: string }>;
  renameMachine: (machineId: string, name: string) => Promise<void>;
  updateMachineDetails: (
    machineId: string,
    updates: { name?: string; description?: string | null },
  ) => Promise<void>;
  deleteMachine: (machineId: string) => Promise<void>;
  /** Computer owner v1: set who Raft records as the owner (null = Public); the answer's machine replaces the row. */
  setMachineOwner: (machineId: string, ownerUserId: string | null) => Promise<void>;
  applyMachineStatusEvent: (
    machineId: string,
    status: "online" | "offline",
    statusVersion?: number,
  ) => MachineTransition;
  /** A Start refused with `machine_offline`: hold that Computer offline, with no time, until the machine list it reloads (or a status update) says. */
  markMachineOfflineFromRefusal: (machineId: string) => void;
  requestMachineReconcile: (
    reason: "machine-updated" | "scheduled",
  ) => MachineTransition;
  updateMachineStatus: (
    machineId: string,
    status: "online" | "offline",
    statusVersion?: number,
  ) => boolean;
  updateMachineCapabilities: (
    machineId: string,
    runtimes: string[] | undefined,
    hostname?: string,
    os?: string,
    daemonVersion?: string,
    computerVersion?: string | null,
    runtimeVersions?: Record<string, string>,
    runtimeDetection?: MachineRuntimeDetection | null,
    host?: MachineCapabilitiesHostFacts,
  ) => void;
  rotateApiKey: (machineId: string) => Promise<string>;
  setSelectedMachine: (machineId: string | null) => void;
  setShowAddMachine: (show: boolean, intent?: AddMachineIntent) => void;
  scanMachineWorkspaces: (machineId: string) => Promise<void>;
  deleteMachineWorkspace: (
    machineId: string,
    directoryName: string,
  ) => Promise<void>;
  setComputerOperation: (
    machineId: string,
    progress: ComputerOperationProgress | null,
  ) => void;
  setComputerUpgradeSubmitting: (machineId: string, targetVersion: string | null) => void;
  setComputerUpgradeAccepted: (machineId: string, request: MachineUpgradeRequest) => void;
  completeComputerRestart: (
    machineId: string,
    requestId: string,
    ok: boolean,
    error?: string,
  ) => void;

  /** Computed helpers */
  hasOnlineMachine: () => boolean;
  hasAnyMachine: () => boolean;
}

/** The agent's Computer is known and offline (#triage:#206). Unknown (not loaded, a Guest) is not offline. */
export function isMachineOffline(machines: readonly Machine[], machineId: string | null | undefined): boolean {
  if (!machineId) return false;
  return machines.find((machine) => machine.id === machineId)?.status === "offline";
}

export const useMachineStore = create<MachineState>((set, get) => {
  const dispatchMachineEvent = (event: MachineEvent): MachineTransition => {
    const current = get();
    const { state, transition } = applyMachineEvent(
      {
        machines: current.machines,
        latestComputerVersion: current.latestComputerVersion,
        computerOperationProgress: current.computerOperationProgress,
      },
      event,
    );
    if (transition.touched > 0) {
      set(domainStateToStorePatch(state));
    }
    emitStateTransitionTrace({
      domain: "machine",
      event: transition.event,
      entityId: transition.machineId ?? "machine-list",
      touched: transition.touched,
      outcome: transition.accepted ? (transition.touched > 0 || transition.recoveryAction ? "applied" : "noop") : "conflict",
      outcomeDetail: transition.accepted ? "accepted" : "rejected",
      recoveryAction: transition.recoveryAction,
    });
    return transition;
  };

  return {
    machines: [],
    latestComputerVersion: null,
    latestComputerReleaseNotes: null,
    loading: true,
    loadStatus: "loading",
    loadError: false,
    selectedMachineId: null,
    showAddMachine: false,
    addMachineIntent: "default",
    machineWorkspaces: {},
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
    setComputerOperation: (machineId, progress) => {
      dispatchMachineEvent({ kind: "operation-set", machineId, progress });
    },
    computerUpgradeSubmitting: {},
    computerUpgradeAccepted: {},
    computerOfflineObservedAt: {},
    computerOfflineFromRefusal: {},
    setComputerUpgradeAccepted: (machineId, request) => {
      set({
        computerUpgradeAccepted: {
          ...get().computerUpgradeAccepted,
          [machineId]: { request, acceptedAtMs: currentTimeMs() },
        },
      });
    },
    setComputerUpgradeSubmitting: (machineId, targetVersion) => {
      const current = get().computerUpgradeSubmitting;
      if ((current[machineId] ?? null) === targetVersion) return;
      const next = { ...current };
      if (targetVersion === null) delete next[machineId];
      else next[machineId] = targetVersion;
      set({ computerUpgradeSubmitting: next });
    },

    rescanRuntimes: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      // Fire-and-forget: the daemon answers by re-emitting its capabilities, which
      // land through the normal machine:capabilities push. Nothing to await here.
      await api.post(`/servers/${serverId}/machines/${machineId}/runtimes/rescan`);
    },

    completeComputerRestart: (machineId, requestId, ok, error) => {
      dispatchMachineEvent({
        kind: "restart-done",
        machineId,
        requestId,
        ok,
        error,
      });
    },

    loadMachines: async () => {
      const epoch = useServerStore.getState().serverEpoch;
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      // Coalesce concurrent triggers (connect snapshot + realtime fallbacks +
      // surface opens) onto one request; epoch in the key keeps an epoch
      // change from piggybacking on a stale-epoch fetch.
      return coalesce(`machines:${serverId}:${epoch}`, async () => {
        set({ loadError: false });
        if (get().machines.length === 0) {
          set({ loading: true, loadStatus: "loading" });
        }
        // Initial/retry loads with no usable rows re-enter loading. Refreshes keep
        // existing rows visible while the current server epoch is revalidated.
        try {
          const { data } = await api.get(`/servers/${serverId}/machines`);
          if (useServerStore.getState().serverEpoch !== epoch) return;
          const machines = Array.isArray(data) ? data : data.machines;
          const latestComputerVersion = Array.isArray(data)
            ? null
            : (data.latestComputerVersion ?? null);
          // Additive field; re-validated here so a bad payload drops the
          // notes instead of reaching the renderer.
          const releaseNotes = Array.isArray(data) ? null : data.latestComputerReleaseNotes;
          const latestComputerReleaseNotes = normalizeComputerReleaseNotes(releaseNotes?.version, releaseNotes);
          dispatchMachineEvent({
            kind: "hydrate",
            machines,
            latestComputerVersion,
          });
          set({ latestComputerReleaseNotes, loading: false, loadStatus: "loaded", loadError: false, computerOfflineFromRefusal: {} });
        } catch (err) {
          console.error("Failed to load machines:", err);
          if (useServerStore.getState().serverEpoch !== epoch) return;
          const hasCachedMachines = get().machines.length > 0;
          set({
            loading: false,
            loadStatus: hasCachedMachines ? "loaded" : "error",
            loadError: true,
          });
        }
      });
    },

    registerMachine: async (name: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      // Two-step verification on: a web sign-in verifies first (403
      // second_factor_step_up_required; server stepUpGate.ts).
      const { data } = await withSecondFactorStepUp(() => api.post(`/servers/${serverId}/machines`, {
        name,
      }), "other");
      const machine: Machine = {
        ...data.machine,
        runtimes: data.machine.runtimes || [],
      };
      // The key is returned to the caller and never kept: not in
      // localStorage, not in this store. Nothing renders it (setup commands
      // carry the server slug and machine id, never the key).
      set((state) => ({
        machines: [...state.machines, machine],
      }));
      return { machine, apiKey: data.apiKey };
    },

    renameMachine: async (machineId: string, name: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      await api.patch(`/servers/${serverId}/machines/${machineId}`, { name });
      set((state) => ({
        machines: state.machines.map((m) =>
          m.id === machineId ? { ...m, name } : m,
        ),
      }));
    },

    updateMachineDetails: async (machineId, updates) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      await api.patch(`/servers/${serverId}/machines/${machineId}`, updates);
      set((state) => ({
        machines: state.machines.map((m) =>
          m.id === machineId ? { ...m, ...updates } : m,
        ),
      }));
    },

    setMachineOwner: async (machineId, ownerUserId) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      const { data } = await api.put<{ machine: Machine | null }>(`/servers/${serverId}/machines/${machineId}/owner`, { ownerUserId });
      const machine = data?.machine ?? null;
      set((state) => ({
        machines: state.machines.map((m) =>
          m.id === machineId
            ? machine ? { ...m, ...machine } : { ...m, ownerUserId, owner: ownerUserId === null ? null : m.owner }
            : m,
        ),
      }));
    },

    deleteMachine: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      await api.delete(`/servers/${serverId}/machines/${machineId}`);
      set((state) => ({
        machines: state.machines.filter((m) => m.id !== machineId),
        selectedMachineId:
          state.selectedMachineId === machineId
            ? null
            : state.selectedMachineId,
      }));
    },

    applyMachineStatusEvent: (
      machineId: string,
      status: "online" | "offline",
      statusVersion?: number,
    ) => {
      const wasOnline = get().machines.find((m) => m.id === machineId)?.status === "online";
      const transition = dispatchMachineEvent({
        kind: "status",
        machineId,
        status,
        statusVersion,
      });
      if (transition.accepted) {
        if (machineId in get().computerOfflineFromRefusal) {
          const rest = { ...get().computerOfflineFromRefusal };
          delete rest[machineId];
          set({ computerOfflineFromRefusal: rest });
        }
        const observed = get().computerOfflineObservedAt;
        if (status === "offline" && wasOnline) {
          set({ computerOfflineObservedAt: { ...observed, [machineId]: currentTimeMs() } });
        } else if (status === "online" && machineId in observed) {
          const next = { ...observed };
          delete next[machineId];
          set({ computerOfflineObservedAt: next });
        }
      }
      return transition;
    },

    markMachineOfflineFromRefusal: (machineId: string) => {
      if (get().machines.find((machine) => machine.id === machineId)?.status !== "online") return;
      // A status event with no version: the next real one wins. Unlike a live
      // push, no "offline since" is recorded: the refusal says only that it is
      // offline now, not since when.
      dispatchMachineEvent({ kind: "status", machineId, status: "offline" });
      set({ computerOfflineFromRefusal: { ...get().computerOfflineFromRefusal, [machineId]: true } });
      // The server also answers machine_offline for transient misses (a replica handoff, a socket not ready yet), so
      // this is a guess until the server's own list says otherwise (its recovery: reload machines). The reload
      // replaces the row and clears the mark either way. If it fails twice, the guess is dropped: the row goes back
      // to what this tab knew, so a Computer the server never confirmed offline doesn't stay offline here.
      const stillGuessed = () => get().loadError && get().computerOfflineFromRefusal[machineId] === true;
      void get().loadMachines()
        .then(() => (stillGuessed() ? get().loadMachines() : undefined))
        .then(() => {
          if (!stillGuessed()) return;
          dispatchMachineEvent({ kind: "status", machineId, status: "online" });
          const rest = { ...get().computerOfflineFromRefusal };
          delete rest[machineId];
          set({ computerOfflineFromRefusal: rest });
        });
    },

    requestMachineReconcile: (reason) =>
      dispatchMachineEvent({ kind: "reconcile", reason }),

    updateMachineStatus: (
      machineId: string,
      status: "online" | "offline",
      statusVersion?: number,
    ) => {
      // Returns whether the event was accepted (the newest status for the
      // machine). Stale / duplicate status events must preserve the existing
      // machines array reference; the reducer owns that no-op contract.
      return get().applyMachineStatusEvent(machineId, status, statusVersion)
        .accepted;
    },

    updateMachineCapabilities: (
      machineId: string,
      runtimes: string[] | undefined,
      hostname?: string,
      os?: string,
      daemonVersion?: string,
      computerVersion?: string | null,
      runtimeVersions?: Record<string, string>,
      runtimeDetection?: MachineRuntimeDetection | null,
      host?: MachineCapabilitiesHostFacts,
    ) => {
      dispatchMachineEvent({
        kind: "capabilities",
        machineId,
        runtimes,
        runtimeVersions,
        hostname,
        os,
        daemonVersion,
        computerVersion,
        runtimeDetection,
        hostProvider: host?.hostProvider,
        osRelease: host?.osRelease,
        deviceClass: host?.deviceClass,
        versionGate: host?.versionGate,
      });
    },

    rotateApiKey: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      const { data } = await withSecondFactorStepUp(() => api.post(
        `/servers/${serverId}/machines/${machineId}/rotate-key`,
      ), "other");
      const newPrefix = data.apiKey.slice(0, 20);
      set((state) => ({
        machines: state.machines.map((m) =>
          m.id === machineId ? { ...m, apiKeyPrefix: newPrefix } : m,
        ),
      }));
      return data.apiKey;
    },

    setSelectedMachine: (machineId) => set({ selectedMachineId: machineId }),

    setShowAddMachine: (show, intent = "default") => set({ showAddMachine: show, addMachineIntent: show ? intent : "default" }),

    scanMachineWorkspaces: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      set((state) => ({
        machineWorkspacesLoading: {
          ...state.machineWorkspacesLoading,
          [machineId]: true,
        },
      }));
      try {
        const { data } = await api.get(
          `/servers/${serverId}/machines/${machineId}/workspaces`,
        );
        set((state) => ({
          machineWorkspaces: { ...state.machineWorkspaces, [machineId]: data },
          machineWorkspacesLoading: {
            ...state.machineWorkspacesLoading,
            [machineId]: false,
          },
        }));
      } catch (err) {
        console.error("Failed to scan workspaces:", err);
        set((state) => ({
          machineWorkspacesLoading: {
            ...state.machineWorkspacesLoading,
            [machineId]: false,
          },
        }));
      }
    },

    deleteMachineWorkspace: async (
      machineId: string,
      directoryName: string,
    ) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) return;
      await api.delete(
        `/servers/${serverId}/machines/${machineId}/workspaces/${directoryName}`,
      );
      // Remove from local state
      set((state) => ({
        machineWorkspaces: {
          ...state.machineWorkspaces,
          [machineId]: (state.machineWorkspaces[machineId] || []).filter(
            (w) => w.directoryName !== directoryName,
          ),
        },
      }));
    },

    hasOnlineMachine: () => get().machines.some((m) => m.status === "online"),
    hasAnyMachine: () => get().machines.length > 0,
  };
});

function domainStateToStorePatch(
  state: MachineDomainState,
): Pick<
  MachineState,
  | "machines"
  | "latestComputerVersion"
  | "computerOperationProgress"
> {
  return {
    machines: state.machines,
    latestComputerVersion: state.latestComputerVersion,
    computerOperationProgress: state.computerOperationProgress,
  };
}

// Drop machine keys an older build cached in localStorage. Runs once per
// load, when this store module is first evaluated.
purgeStoredMachineKeys();

// Reset all server-scoped state when the user switches servers.
registerServerReset(() =>
  useMachineStore.setState({
    machines: [],
    latestComputerVersion: null,
    latestComputerReleaseNotes: null,
    loading: true,
    loadStatus: "loading",
    loadError: false,
    selectedMachineId: null,
    showAddMachine: false,
    addMachineIntent: "default",
    machineWorkspaces: {},
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
    computerUpgradeSubmitting: {},
    computerUpgradeAccepted: {},
    computerOfflineObservedAt: {},
    computerOfflineFromRefusal: {},
  }),
);
