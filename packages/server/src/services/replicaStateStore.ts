import {
  registerMachineReplica,
  restoreMachineReplicaGeneration,
  unregisterMachineReplica,
  refreshMachineReplica,
  hasMachineReplica,
  getMachineReplicaOwner,
  getMachineReplicaOwners,
  getMachineReplicaLease,
  getMachineDuplicateHold,
  setMachineDuplicateHold,
  touchMachineDuplicateHold,
  setMachineReplicaInstance,
  getMachineReplicaTraceContext,
  bumpMachineStatusVersion,
  getMachineStatusVersion,
  acquireWakeLock,
  releaseWakeLock,
  setAgentActivity,
  getAgentActivity,
  getAgentActivities,
  getWakeCrashLoopState,
  compareAndSetWakeCrashLoopState,
  setAgentRuntimeError,
  getAgentRuntimeError,
  getAgentRuntimeErrors,
  setAgentContextViewAvailability,
  getAgentContextViewAvailability,
  clearAgentContextViewAvailability,
  setReadyOwedWakeAt,
  getReadyOwedWakeAt,
  claimDiskCredentialLift,
  createAgentContextViewRequest,
  getAgentContextViewRequest,
  claimAgentContextViewRequest,
  setMachineMeta,
  getMachineMeta,
  clearMachineMeta,
  type MachineMeta,
  type AgentContextViewRequestRecord,
  type AgentContextViewRequestClaim,
  type AgentRuntimeErrorMirror,
  type AgentContextViewAvailabilityRecord,
  type MachineReplicaRefreshResult,
  type MachineReplicaLease,
  type MachineDuplicateHold,
  type MachineReplicaInstance,
} from "../replicaRouter";
import { isRedisAvailable } from "../redis";
import type {
  AgentActivityDetailKind,
  AgentActivityKind,
  DeliveryConsumptionActivityDiagnostic,
  WakeCrashLoopActivityDiagnostic,
  SpawnFailureActivityDiagnostic,
  ToolStuckActivityDiagnostic,
  CredentialHoldActivityDiagnostic,
} from "@botiverse/raft-shared";

/**
 * task #1116: typed observation carriers that ride the shared activity
 * snapshot so a non-owner replica's refresh read-back exposes the same
 * diagnostic the owner's socket frame showed. Ids, classes, counts and times
 * only; a later write without a carrier clears it.
 */
export interface PersistedActivityTypedCarriers {
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #1119: the wake crash-loop breaker state, when the snapshot is wake_crash_loop_blocked. */
  wakeCrashLoop?: WakeCrashLoopActivityDiagnostic;
  /** task #1123: rides a runtime_unavailable write from a failed start. */
  spawnFailure?: SpawnFailureActivityDiagnostic;
  /** task #25: the daemon's stuck-tool state, whatever the detail kind. */
  toolStuck?: ToolStuckActivityDiagnostic;
  /** Reconciler step 4b: the held notice's typed reason, when the snapshot is an idle write showing it. */
  credentialHold?: CredentialHoldActivityDiagnostic;
}

export interface PersistedAgentActivity {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  updatedAt: number;
  carriers?: PersistedActivityTypedCarriers;
}
import type { AgentContextViewRequestId, AgentRuntimeErrorState, MachineId } from "@botiverse/raft-shared";
import type { WakeCrashLoopEpisodeState, WakeCrashLoopStateRecord } from "./wakeCrashLoopBreaker";
import type { MachineConnectTraceContext } from "../tracing/migrationTraceContext";

export type { MachineMeta, AgentRuntimeErrorMirror, AgentContextViewAvailabilityRecord, AgentContextViewRequestRecord, AgentContextViewRequestClaim };

export interface ReplicaStateStore {
  isAvailable(): boolean;
  registerMachineReplica(machineId: string, traceContext?: MachineConnectTraceContext): Promise<string>;
  restoreMachineReplicaGeneration(
    machineId: string,
    generation: string,
    traceContext?: MachineConnectTraceContext,
  ): Promise<void>;
  unregisterMachineReplica(machineId: string, expectedGeneration?: string): Promise<void>;
  refreshMachineReplica(
    machineId: string,
    traceContext?: MachineConnectTraceContext,
    expectedGeneration?: string,
  ): Promise<MachineReplicaRefreshResult | void>;
  hasMachineReplica(machineId: string): Promise<boolean>;
  getMachineReplicaOwner(machineId: string): Promise<string | null>;
  getMachineReplicaTraceContext?(machineId: string): Promise<Partial<MachineConnectTraceContext> | null>;
  /** Owner lease holder and last renewal time (task #374). Optional: absent means no duplicate detection. */
  getMachineReplicaLease?(machineId: string): Promise<MachineReplicaLease | null>;
  /** Duplicate-connection winner record (task #374). Optional: absent means no enforcement hold. */
  getMachineDuplicateHold?(machineId: string): Promise<MachineDuplicateHold | null>;
  setMachineDuplicateHold?(machineId: string, hold: MachineDuplicateHold, ttlSeconds: number): Promise<void>;
  touchMachineDuplicateHold?(machineId: string, ttlSeconds: number): Promise<void>;
  /** The lease holder's daemon identity, written after a successful refresh (task #374 observation). */
  setMachineReplicaInstance?(machineId: string, instance: MachineReplicaInstance, ttlSeconds?: number): Promise<void>;
  bumpMachineStatusVersion(machineId: string): Promise<number>;
  getMachineStatusVersion(machineId: string): Promise<number>;
  acquireWakeLock(agentId: string): Promise<boolean>;
  releaseWakeLock(agentId: string): Promise<void>;
  setAgentActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    observedAtMs?: number,
    carriers?: PersistedActivityTypedCarriers,
  ): Promise<void>;
  getAgentActivity(agentId: string): Promise<PersistedAgentActivity | null>;
  setAgentRuntimeError(agentId: string, error: AgentRuntimeErrorState | null): Promise<void>;
  getAgentRuntimeError(agentId: string): Promise<AgentRuntimeErrorMirror | null>;
  /** View Context: the latest availability report per agent (7-day TTL, refreshed on write). */
  setAgentContextViewAvailability(agentId: string, record: AgentContextViewAvailabilityRecord): Promise<void>;
  getAgentContextViewAvailability(agentId: string): Promise<AgentContextViewAvailabilityRecord | null>;
  clearAgentContextViewAvailability(agentId: string): Promise<void>;
  /**
   * task #1119: wake crash-loop breaker episode state, shared across replicas.
   * `compareAndSet` writes only when the stored version equals `expectedVersion`
   * (0 when absent) so read→apply→write is atomic against concurrent writers.
   */
  getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null>;
  /**
   * Reconciler step 13 F9: when a daemon `ready` last dispatched an owed wake
   * for the agent (epoch ms; 24 h TTL), shared by every replica. Optional for
   * hand-built stores: without it the owed wake is not dispatched (fail closed).
   */
  setReadyOwedWakeAt?(agentId: string, atMs: number): Promise<void>;
  getReadyOwedWakeAt?(agentId: string): Promise<number | null>;
  /**
   * Reconciler step 15: claim the one disk-sign-in lift a Computer and runtime
   * get per window (15 min), shared by every replica. Optional for hand-built
   * stores: without it a disk lift is dropped (fail closed; a web login still lifts).
   */
  claimDiskCredentialLift?(machineId: string, runtime: string): Promise<boolean>;
  compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean>;
  setMachineMeta(machineId: string, meta: MachineMeta): Promise<void>;
  getMachineMeta(machineId: string): Promise<MachineMeta | null>;
  clearMachineMeta(machineId: string): Promise<void>;
  /**
   * Batch reads for list endpoints (one round trip each). Optional: a store
   * without them is read one key at a time (getActivities falls back).
   */
  getAgentActivities?(agentIds: readonly string[]): Promise<Map<string, PersistedAgentActivity | null>>;
  getAgentRuntimeErrors?(agentIds: readonly string[]): Promise<Map<string, AgentRuntimeErrorMirror | null>>;
  getMachineReplicaOwners?(machineIds: readonly string[]): Promise<Map<string, string | null>>;
}

export const redisReplicaStateStore: ReplicaStateStore = {
  isAvailable: () => isRedisAvailable(),
  registerMachineReplica,
  restoreMachineReplicaGeneration,
  unregisterMachineReplica,
  refreshMachineReplica,
  hasMachineReplica,
  getMachineReplicaOwner,
  getMachineReplicaOwners,
  getMachineReplicaLease,
  getMachineDuplicateHold,
  setMachineDuplicateHold,
  touchMachineDuplicateHold,
  setMachineReplicaInstance,
  getMachineReplicaTraceContext,
  bumpMachineStatusVersion,
  getMachineStatusVersion,
  acquireWakeLock,
  releaseWakeLock,
  setAgentActivity,
  getAgentActivity,
  getAgentActivities,
  getWakeCrashLoopState,
  compareAndSetWakeCrashLoopState,
  setAgentRuntimeError,
  getAgentRuntimeError,
  getAgentRuntimeErrors,
  setAgentContextViewAvailability,
  getAgentContextViewAvailability,
  clearAgentContextViewAvailability,
  setReadyOwedWakeAt,
  getReadyOwedWakeAt,
  claimDiskCredentialLift,
  setMachineMeta,
  getMachineMeta,
  clearMachineMeta,
};

/**
 * View Context: open view requests, shared across replicas (Redis, or
 * in-process with no Redis). Kept apart from ReplicaStateStore: only the
 * context view relay reads it, never the orchestrator.
 */
export interface AgentContextViewRequestStore {
  create(record: AgentContextViewRequestRecord, ttlMs: number): Promise<void>;
  get(requestId: AgentContextViewRequestId): Promise<{ record: AgentContextViewRequestRecord; claimed: boolean } | null>;
  claim(requestId: AgentContextViewRequestId, callerMachineId: MachineId, ttlMs: number): Promise<AgentContextViewRequestClaim>;
}

export const redisAgentContextViewRequestStore: AgentContextViewRequestStore = {
  create: createAgentContextViewRequest,
  get: getAgentContextViewRequest,
  claim: claimAgentContextViewRequest,
};
