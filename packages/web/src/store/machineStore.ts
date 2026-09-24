import { create } from "zustand";
import api from "../api/client";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
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
  hostname: string | null;
  os: string | null;
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
  // Public, server-scoped identity of the human who attached this managed
  // Computer. Null for departed creators and raw daemon rows.
  creator?: CreatorSummary | null;
  // For a managed Computer: its own `@botiverse/raft-computer` version (0.0.x),
  // reported by the Computer and shown instead of the underlying daemon
  // version. Null/absent until reported.
  computerVersion?: string | null;
  // Compatibility projection of the closed server policy decision.
  // true is the only broadcastable state; false means policy denied.
  computerUpgradeAvailable?: boolean | null;
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
  lastHeartbeat: string | null;
  createdAt: string;
}

export interface MachineWorkspaceEntry {
  directoryName: string;
  totalSizeBytes: number;
  lastModified: string;
  fileCount: number;
  status: "active" | "stopped" | "deleted" | "orphan";
  agentName: string | null;
  agentStatus: string | null;
}

/** Per-machine Computer upgrade/restart progress driven by WS frames.
 *  Keyed by machineId. Reset when the machine goes offline or a new
 *  operation begins on the same machine. */
export interface ComputerOperationProgress {
  operation: "upgrade" | "restart";
  /** requestId echoed from the command for terminal receipt correlation. */
  requestId?: string;
  /** Upgrade phase from `computer:upgrade:progress`. */
  phase?: "downloading" | "verifying" | "applying" | "restarting";
  /** Optional human-readable status message. */
  message?: string;
  /** Derived 0-100 progress value for determinate phases. */
  progressValue?: number;
  /** True once `computer:upgrade:done` arrives (ok=true). */
  done?: boolean;
  /** True if the upgrade was rolled back. */
  rolledBack?: boolean;
  /** New version after successful upgrade. */
  newVersion?: string;
  /** Error message on failure. */
  error?: string;
}

export type MachineLoadStatus = "loading" | "loaded" | "error";

interface MachineState {
  machines: Machine[];
  latestDaemonVersion: string | null;
  /** Latest published artifact hint. Never a per-machine target or
   *  eligibility authority; each row's computerBroadcastPolicy owns those. */
  latestComputerVersion: string | null;
  loading: boolean;
  loadStatus: MachineLoadStatus;
  loadError: boolean;
  selectedMachineId: string | null;
  showAddMachine: boolean;
  /** Transient: API key shown once after registration */
  pendingApiKey: string | null;
  pendingMachineId: string | null;
  /** Per-machine workspace scan results */
  machineWorkspaces: Record<string, MachineWorkspaceEntry[]>;
  machineWorkspacesLoading: Record<string, boolean>;
  /** Per-machine Computer operation progress (upgrade/restart) */
  computerOperationProgress: Record<string, ComputerOperationProgress | null>;

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
  applyMachineStatusEvent: (
    machineId: string,
    status: "online" | "offline",
    statusVersion?: number,
  ) => MachineTransition;
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
    runtimes: string[],
    hostname?: string,
    os?: string,
    daemonVersion?: string,
    computerVersion?: string | null,
    runtimeVersions?: Record<string, string>,
  ) => void;
  rotateApiKey: (machineId: string) => Promise<string>;
  clearPendingApiKey: () => void;
  setSelectedMachine: (machineId: string | null) => void;
  setShowAddMachine: (show: boolean) => void;
  scanMachineWorkspaces: (machineId: string) => Promise<void>;
  deleteMachineWorkspace: (
    machineId: string,
    directoryName: string,
  ) => Promise<void>;
  setComputerOperation: (
    machineId: string,
    progress: ComputerOperationProgress | null,
  ) => void;
  updateComputerUpgradeProgress: (
    machineId: string,
    requestId: string,
    phase: "downloading" | "verifying" | "applying" | "restarting",
    message?: string,
    /** Byte-% (0-100) for the `downloading` phase — animates the bar. */
    percent?: number,
  ) => void;
  completeComputerUpgrade: (
    machineId: string,
    requestId: string,
    ok: boolean,
    newVersion?: string,
    rolledBack?: boolean,
    error?: string,
  ) => void;
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

export const useMachineStore = create<MachineState>((set, get) => {
  const dispatchMachineEvent = (event: MachineEvent): MachineTransition => {
    const current = get();
    const { state, transition } = applyMachineEvent(
      {
        machines: current.machines,
        latestDaemonVersion: current.latestDaemonVersion,
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
    latestDaemonVersion: null,
    latestComputerVersion: null,
    loading: true,
    loadStatus: "loading",
    loadError: false,
    selectedMachineId: null,
    showAddMachine: false,
    pendingApiKey: null,
    pendingMachineId: null,
    machineWorkspaces: {},
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
    setComputerOperation: (machineId, progress) => {
      dispatchMachineEvent({ kind: "operation-set", machineId, progress });
    },

    updateComputerUpgradeProgress: (
      machineId,
      requestId,
      phase,
      message,
      percent,
    ) => {
      dispatchMachineEvent({
        kind: "upgrade-progress",
        machineId,
        requestId,
        phase,
        message,
        percent,
      });
    },

    completeComputerUpgrade: (
      machineId,
      requestId,
      ok,
      newVersion,
      rolledBack,
      error,
    ) => {
      dispatchMachineEvent({
        kind: "upgrade-done",
        machineId,
        requestId,
        ok,
        newVersion,
        rolledBack,
        error,
      });
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
        const latestDaemonVersion = Array.isArray(data)
          ? null
          : (data.latestDaemonVersion ?? null);
        const latestComputerVersion = Array.isArray(data)
          ? null
          : (data.latestComputerVersion ?? null);
        dispatchMachineEvent({
          kind: "hydrate",
          machines,
          latestDaemonVersion,
          latestComputerVersion,
        });
        set({ loading: false, loadStatus: "loaded", loadError: false });
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
    },

    registerMachine: async (name: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      const { data } = await api.post(`/servers/${serverId}/machines`, {
        name,
      });
      const machine: Machine = {
        ...data.machine,
        runtimes: data.machine.runtimes || [],
      };
      // Persist API key locally so the run command is always available
      localStorage.setItem(`slock_machine_apikey_${machine.id}`, data.apiKey);
      set((state) => ({
        machines: [...state.machines, machine],
        pendingApiKey: data.apiKey,
        pendingMachineId: machine.id,
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

    deleteMachine: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      await api.delete(`/servers/${serverId}/machines/${machineId}`);
      localStorage.removeItem(`slock_machine_apikey_${machineId}`);
      set((state) => ({
        machines: state.machines.filter((m) => m.id !== machineId),
        selectedMachineId:
          state.selectedMachineId === machineId
            ? null
            : state.selectedMachineId,
        pendingApiKey:
          state.pendingMachineId === machineId ? null : state.pendingApiKey,
        pendingMachineId:
          state.pendingMachineId === machineId ? null : state.pendingMachineId,
      }));
    },

    applyMachineStatusEvent: (
      machineId: string,
      status: "online" | "offline",
      statusVersion?: number,
    ) =>
      dispatchMachineEvent({
        kind: "status",
        machineId,
        status,
        statusVersion,
      }),

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
      runtimes: string[],
      hostname?: string,
      os?: string,
      daemonVersion?: string,
      computerVersion?: string | null,
      runtimeVersions?: Record<string, string>,
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
      });
    },

    rotateApiKey: async (machineId: string) => {
      const serverId = useServerStore.getState().current?.id;
      if (!serverId) throw new Error("No server selected");
      const { data } = await api.post(
        `/servers/${serverId}/machines/${machineId}/rotate-key`,
      );
      localStorage.setItem(`slock_machine_apikey_${machineId}`, data.apiKey);
      const newPrefix = data.apiKey.slice(0, 20);
      set((state) => ({
        pendingApiKey: data.apiKey,
        pendingMachineId: machineId,
        machines: state.machines.map((m) =>
          m.id === machineId ? { ...m, apiKeyPrefix: newPrefix } : m,
        ),
      }));
      return data.apiKey;
    },

    clearPendingApiKey: () =>
      set({ pendingApiKey: null, pendingMachineId: null }),

    setSelectedMachine: (machineId) => set({ selectedMachineId: machineId }),

    setShowAddMachine: (show) => set({ showAddMachine: show }),

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
  | "latestDaemonVersion"
  | "latestComputerVersion"
  | "computerOperationProgress"
> {
  return {
    machines: state.machines,
    latestDaemonVersion: state.latestDaemonVersion,
    latestComputerVersion: state.latestComputerVersion,
    computerOperationProgress: state.computerOperationProgress,
  };
}

// Reset all server-scoped state when the user switches servers.
registerServerReset(() =>
  useMachineStore.setState({
    machines: [],
    latestDaemonVersion: null,
    latestComputerVersion: null,
    loading: true,
    loadStatus: "loading",
    loadError: false,
    selectedMachineId: null,
    showAddMachine: false,
    pendingApiKey: null,
    pendingMachineId: null,
    machineWorkspaces: {},
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
  }),
);
