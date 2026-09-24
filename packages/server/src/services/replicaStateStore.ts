import {
  registerMachineReplica,
  restoreMachineReplicaGeneration,
  unregisterMachineReplica,
  refreshMachineReplica,
  hasMachineReplica,
  getMachineReplicaOwner,
  getMachineReplicaTraceContext,
  bumpMachineStatusVersion,
  getMachineStatusVersion,
  acquireWakeLock,
  releaseWakeLock,
  setAgentActivity,
  getAgentActivity,
  setAgentRuntimeError,
  getAgentRuntimeError,
  setMachineMeta,
  getMachineMeta,
  clearMachineMeta,
  type MachineMeta,
  type AgentRuntimeErrorMirror,
} from "../replicaRouter.js";
import { isRedisAvailable } from "../redis.js";
import type { AgentActivityDetailKind, AgentActivityKind } from "@botiverse/raft-shared";
import type { AgentRuntimeErrorState } from "@botiverse/raft-shared";
import type { MachineConnectTraceContext } from "../tracing/migrationTraceContext.js";

export type { MachineMeta, AgentRuntimeErrorMirror };

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
  ): Promise<void>;
  hasMachineReplica(machineId: string): Promise<boolean>;
  getMachineReplicaOwner(machineId: string): Promise<string | null>;
  getMachineReplicaTraceContext?(machineId: string): Promise<Partial<MachineConnectTraceContext> | null>;
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
  ): Promise<void>;
  getAgentActivity(agentId: string): Promise<{
    activity: AgentActivityKind;
    detail: string;
    detailKind: AgentActivityDetailKind;
    observedAtMs?: number;
    updatedAt: number;
  } | null>;
  setAgentRuntimeError(agentId: string, error: AgentRuntimeErrorState | null): Promise<void>;
  getAgentRuntimeError(agentId: string): Promise<AgentRuntimeErrorMirror | null>;
  setMachineMeta(machineId: string, meta: MachineMeta): Promise<void>;
  getMachineMeta(machineId: string): Promise<MachineMeta | null>;
  clearMachineMeta(machineId: string): Promise<void>;
}

export const redisReplicaStateStore: ReplicaStateStore = {
  isAvailable: () => isRedisAvailable(),
  registerMachineReplica,
  restoreMachineReplicaGeneration,
  unregisterMachineReplica,
  refreshMachineReplica,
  hasMachineReplica,
  getMachineReplicaOwner,
  getMachineReplicaTraceContext,
  bumpMachineStatusVersion,
  getMachineStatusVersion,
  acquireWakeLock,
  releaseWakeLock,
  setAgentActivity,
  getAgentActivity,
  setAgentRuntimeError,
  getAgentRuntimeError,
  setMachineMeta,
  getMachineMeta,
  clearMachineMeta,
};
